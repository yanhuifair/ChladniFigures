// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

// ============================================================
//  WebGPUParticleSystem — 粒子物理 + 碰撞 + 渲染全在 GPU（方案 C）
//  用 WebGPU compute shader 把整条粒子模拟搬到 GPU：
//    · sim 计算通道：逐粒子抛起/沉降/走位（移植 particles.js 状态机，
//      用哈希 PRNG 取代 Math.random）
//    · 碰撞计算通道：空间网格（atomic 计数 + 邻居解重叠），沙粒不可重叠、
//      沿节线堆成有宽度的沙带（沙堆观感），同时统计堆叠密度供渲染增强
//    · 渲染通道：实例化四边形画沙粒，裁剪成圆形、纯白、alpha=1
//  相比 WebGL2，WebGPU 有 compute + 原子操作，逐粒子碰撞才真正可行，
//  故可同时拿到「海量粒子」与「沙堆带观感」。
//  若浏览器不支持 WebGPU 或任何初始化失败 → 返回 null，上层退回 WebGL2+CPU。
// ============================================================

import {
  inShapeXY,
  shapeIndex,
  flattenSpecs,
  packSpec,
  makeSquareSpec,
} from "./chladni.js";

// 与 particles.js 保持一致的碰撞参数
const COLLIDE_R = 0.006;
const COLLIDE_STIFF = 0.5;
const COLLIDE_CELL = COLLIDE_R * 1.45 * 2; // 网格 cell 取最大半径的 2 倍
const COLLIDE_K = 64; // 每格最多容纳的粒子数（溢出丢弃）；碰撞半径缩小后同格更密，调大以防漏碰
const GRID_DIM = Math.ceil(
  2 / COLLIDE_CELL,
);
const GRID_CELLS =
  GRID_DIM *
  GRID_DIM;

// 沙粒尺寸 / z 渲染常量（3D 堆叠功能已移除：沙粒始终贴在板上，z=0）：
// 以下仅保留渲染抬升与碰撞同层判定所需的少量项，其余堆高/重力常量已删除。
const Z_GRAIN = 0.005;          // 沙粒 z 方向厚度（仅渲染用）
const Z_MAX_LAYERS = 40;        // 渲染时 z 归一化上限
const Z_HOP = 0.015;            // 抛起竖直速度（保留；z 已不累积）
const Z_PROJECT = 0.5;          // 渲染时 z→屏幕像素抬升比例
const Z_REPOSE = 0.04;          // 安息角（保留备用，堆积逻辑已移除）

// 每颗粒子 16 个 float（64 字节），与 WGSL 结构体 P 的自动步长(64)对齐：
// [0,1]=pos [2,3]=vel [4]=air [5]=airTotal [6]=settled [7]=sizeF
// [8]=mass [9]=brightness [10]=grip [11]=density [12]=z [13]=vz [14,15]=pad
const FLOATS_PER_PARTICLE = 16;

// --- 共享 WGSL 场函数（被 sim / 碰撞 / 渲染复用）---
const FIELD_WGSL = `
const PI: f32 = 3.14159265359;

// 位移场已统一由 SPEC_WGSL 的 specPsi / specHeight / specGrad 提供
// （见 ModeSpec 打包模型），此处只保留形状判定与随机数等通用工具。

fn inShapeXY(cx: f32, cy: f32, shape: f32) -> bool {
  if (shape < 0.5) { return abs(cx) <= 1.0 && abs(cy) <= 1.0; }
  if (shape < 1.5) { return cx * cx + cy * cy <= 1.0; }
  let c = 0.8660254;
  if (shape < 2.5) {
    let d1 = (cx - (-c)) * (1.0 - (-0.5)) - (0.0 - (-c)) * (cy - (-0.5));
    let d2 = (cx - c) * ((-0.5) - (-0.5)) - ((-c) - c) * (cy - (-0.5));
    let d3 = (cx - 0.0) * ((-0.5) - 1.0) - (c - 0.0) * (cy - 1.0);
    let hasNeg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let hasPos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    return !(hasNeg && hasPos);
  }
  return abs(cy) <= c && abs(c * cx + 0.5 * cy) <= c && abs(c * cx - 0.5 * cy) <= c;
}

// 线段 (ax,ay)-(bx,by) 上离 (px,py) 最近的点
fn projSeg(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> vec2<f32> {
  let abx = bx - ax;
  let aby = by - ay;
  let denom = abx * abx + aby * aby;
  var t = 0.0;
  if (denom > 1e-9) { t = ((px - ax) * abx + (py - ay) * aby) / denom; }
  t = clamp(t, 0.0, 1.0);
  return vec2<f32>(ax + abx * t, ay + aby * t);
}

// 形状边界上离 (px,py) 最近的点（贴边堆积用）。几何须与 inShapeXY / JS 多边形一致。
fn boundaryProject(px: f32, py: f32, shape: f32) -> vec2<f32> {
  if (shape < 0.5) {
    // 正方形：盒 [-1,1]^2 最近边界点
    return vec2<f32>(clamp(px, -1.0, 1.0), clamp(py, -1.0, 1.0));
  }
  if (shape < 1.5) {
    // 圆形：归一化到半径 1
    let r = sqrt(px * px + py * py);
    if (r < 1e-6) { return vec2<f32>(1.0, 0.0); }
    return vec2<f32>(px / r, py / r);
  }
  var best = vec2<f32>(px, py);
  var bestD2 = 1e30;
  if (shape < 2.5) {
    // 等边三角形顶点 A(0,1) B(-√3/2,-0.5) C(√3/2,-0.5)
    let A = vec2<f32>(0.0, 1.0);
    let B = vec2<f32>(-0.8660254, -0.5);
    let C = vec2<f32>(0.8660254, -0.5);
    let e0 = projSeg(px, py, A.x, A.y, B.x, B.y);
    let e1 = projSeg(px, py, B.x, B.y, C.x, C.y);
    let e2 = projSeg(px, py, C.x, C.y, A.x, A.y);
    let d0 = (e0.x - px) * (e0.x - px) + (e0.y - py) * (e0.y - py);
    let d1 = (e1.x - px) * (e1.x - px) + (e1.y - py) * (e1.y - py);
    let d2 = (e2.x - px) * (e2.x - px) + (e2.y - py) * (e2.y - py);
    best = e0; bestD2 = d0;
    if (d1 < bestD2) { best = e1; bestD2 = d1; }
    if (d2 < bestD2) { best = e2; bestD2 = d2; }
    return best;
  }
  // 正六边形：外接半径 1，顶点 0/60/.../300°
  for (var j = 0; j < 6; j = j + 1) {
    let a = f32(j) * 1.0471976;
    let va = vec2<f32>(cos(a), sin(a));
    let b = f32(j + 1) * 1.0471976;
    let vb = vec2<f32>(cos(b), sin(b));
    let pr = projSeg(px, py, va.x, va.y, vb.x, vb.y);
    let dd = (pr.x - px) * (pr.x - px) + (pr.y - py) * (pr.y - py);
    if (dd < bestD2) { best = pr; bestD2 = dd; }
  }
  return best;
}

fn hash(seed: u32) -> u32 {
  var x = seed;
  x = x ^ (x >> 16u);
  x = x * 0x7feb352du;
  x = x ^ (x >> 15u);
  x = x * 0x846ca68bu;
  x = x ^ (x >> 16u);
  return x;
}

fn rnd(s: ptr<function, u32>) -> f32 {
  *s = hash(*s);
  return f32(*s) * 2.3283064365386963e-10;
}

// 在形状内部随机重生（拒绝采样），用于越界/越形粒子的回收
fn spawnInShape(s: ptr<function, u32>, shape: f32) -> vec2<f32> {
  for (var i = 0; i < 24; i = i + 1) {
    let x = (rnd(s) * 2.0 - 1.0) * 0.98;
    let y = (rnd(s) * 2.0 - 1.0) * 0.98;
    if (inShapeXY(x, y, shape)) {
      return vec2<f32>(x, y);
    }
  }
  return vec2<f32>(0.0, 0.0);
}
`;

// 粒子结构体（WGSL）— 与 JS 的 16-float 布局一致
const P_STRUCT_WGSL = `
struct P {
  pos: vec2<f32>,
  vel: vec2<f32>,
  air: f32,
  airTotal: f32,
  settled: f32,
  sizeF: f32,
  mass: f32,
  brightness: f32,
  grip: f32,
  density: f32,
  z: f32,    // 保留字段（维持 64 字节步长用）：3D 堆叠已移除，始终为 0
  vz: f32,   // 竖直速度
  pad2: f32, // 未使用（旧打滑摩擦逻辑已移除），保留以维持 64 字节步长
  pad3: f32,
};
`;

// --- 打包模式描述驱动的位移场（与 chladni.js specPsi / render-plate-gl.js 同源）---
// spec 布局（每段 31 个 f32，prev 在 0、cur 在 31，共 62）：
//   [0] shapeIdx  [1] sqLen  [2] scale
//   [3..10] sqM   [11..18] sqN   [19..26] sqS
//   [27] cirN  [28] cirZ  [29] polyM  [30] polyN
const SPEC_WGSL = `
@group(0) @binding(3) var<storage, read> spec: array<f32, 62>;

// 第一类贝塞尔函数 J_n(x)：Miller 向下递推（与 bessel.js besselJ 等价）。
// f32 动态范围有限 → 递推幅值超阈值时整体等比缩小，不影响最终比值。
fn besselJ(nf: f32, x: f32) -> f32 {
  let n = i32(nf + 0.5);
  let ax = abs(x);
  if (ax < 1e-6) { return select(0.0, 1.0, n == 0); }
  var jPrev = 0.0;
  var jCur = 1.0;
  var jn = 0.0;
  var sum = 0.0;
  let invX = 2.0 / ax;
  for (var k: i32 = 52; k >= 1; k = k - 1) {
    let jNew = invX * f32(k) * jCur - jPrev;
    let idx = k - 1;
    if (idx == n) { jn = jNew; }
    if (idx == 0) {
      sum = sum + jNew;
    } else if ((idx & 1) == 0) {
      sum = sum + 2.0 * jNew;
    }
    jPrev = jCur;
    jCur = jNew;
    if (abs(jCur) > 1e18) {
      jCur = jCur * 1e-18;
      jPrev = jPrev * 1e-18;
      jn = jn * 1e-18;
      sum = sum * 1e-18;
    }
  }
  if (n == 0) { jn = jCur; }
  return jn / sum;
}

// 方板单项位移场（sign≥0 取和形式，否则经典差形式）
fn squarePsiT(uu: f32, vv: f32, m: f32, n: f32, sgn: f32) -> f32 {
  if (abs(m - n) < 0.5) { return cos(m * PI * uu) * cos(n * PI * vv); }
  let a = cos(n * PI * uu) * cos(m * PI * vv);
  let b = cos(m * PI * uu) * cos(n * PI * vv);
  return select(a - b, a + b, sgn >= 0.0);
}

// D_n 对称余弦光栅（三角 3 向 / 六边 6 向）
// 退化模态自动叠加：cos(mp)−cos(np) 与 sin(mp)−sin(np) 为简并伙伴，
// 自动等权叠加（= 旋转 45° 的同族光栅）。与 chladni.js polyPsi 一致。
fn polyPsiT(cx: f32, cy: f32, m: f32, n: f32, shape: f32) -> f32 {
  var s = 0.0;
  let dirs = select(6, 3, shape < 2.5);
  // 2π/3（三角 3 向）或 π/3（六边 6 向），与 chladni.js TRI_DIRS / HEX_DIRS 一致
  let dth = select(1.0471976, 2.0943951, shape < 2.5);
  let inv = 0.70710678;
  for (var i: i32 = 0; i < 6; i = i + 1) {
    if (i >= dirs) { break; }
    let a = f32(i) * dth;
    let p = cx * cos(a) + cy * sin(a);
    s = s + ((cos(m * p) - cos(n * p)) + (sin(m * p) - sin(n * p))) * inv;
  }
  return s;
}

// 按打包描述求位移场 ψ（base = 0 取 prev，31 取 cur），已含归一化尺度
fn specPsi(base: i32, uu: f32, vv: f32) -> f32 {
  let shape = spec[base];
  let scale = spec[base + 2];
  if (shape < 0.5) {
    let len = i32(spec[base + 1] + 0.5);
    var s = 0.0;
    for (var i: i32 = 0; i < 8; i = i + 1) {
      if (i >= len) { break; }
      let sgn = spec[base + 19 + i];
      s = s + sgn * squarePsiT(uu, vv, spec[base + 3 + i], spec[base + 11 + i], sgn);
    }
    return s * scale;
  }
  let cx = 2.0 * uu - 1.0;
  let cy = 2.0 * vv - 1.0;
  if (shape < 1.5) {
    // 圆板精确本征函数：J_n(z·r)·[cos(nθ)+sin(nθ)]/√2（nAng≥1 自动叠加简并伙伴）
    let nAng = spec[base + 27];
    let z = spec[base + 28];
    let r = length(vec2<f32>(cx, cy));
    let a0 = cos(nAng * atan2(cy, cx));
    let a1 = sin(nAng * atan2(cy, cx));
    let ang = select((a0 + a1) * 0.70710678, 1.0, nAng < 0.5);
    return besselJ(nAng, z * r) * ang * scale;
  }
  return polyPsiT(cx, cy, spec[base + 29], spec[base + 30], shape) * scale;
}

fn specHeight(uu: f32, vv: f32, t: f32) -> f32 {
  let hc = abs(specPsi(31, uu, vv));
  if (t >= 1.0) { return hc; }
  let hp = abs(specPsi(0, uu, vv));
  return hp * (1.0 - t) + hc * t;
}

fn specGrad(uu: f32, vv: f32, t: f32) -> vec2<f32> {
  let e = 1e-3;
  let hxp = specHeight(uu + e, vv, t);
  let hxm = specHeight(uu - e, vv, t);
  let hyp = specHeight(uu, vv + e, t);
  let hym = specHeight(uu, vv - e, t);
  return vec2<f32>((hxp - hxm) / (2.0 * e), (hyp - hym) / (2.0 * e));
}
`;

// --- sim 计算着色器：逐粒子状态机 ---
const SIM_WGSL = FIELD_WGSL + P_STRUCT_WGSL + SPEC_WGSL + `
struct U {
  dt: f32,
  plateLimit: f32,
  vibration: f32,
  kick: f32,
  treble: f32,
  vibRate: f32,
  motionGain: f32,
  prevM: f32,
  prevN: f32,
  curM: f32,
  curN: f32,
  blendT: f32,
  frame: u32,
  num: u32,
  zGrain: f32,
  repose: f32,
  shape: f32, // 底板形状索引：0 正方形 / 1 圆形 / 2 等边三角形 / 3 正六边形
  edgeAccumulate: f32, // 贴边堆积开关：>0.5 时沙粒吸向边界并沿轮廓堆积
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> inState: array<P>;
@group(0) @binding(2) var<storage, read_write> outState: array<P>;

const Z_GRAIN_F: f32 = ${Z_GRAIN};
const Z_HOP_F: f32 = ${Z_HOP};

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.num) { return; }
  var p = inState[i];
  var seed = i * 747796405u + u.frame * 2891336453u + 1u;
  let dt = min(u.dt, 0.05);
  let vib = u.vibration;
  let kick = u.kick;
  let treble = u.treble;
  let vibRate = u.vibRate;
  if (p.air > 0.0) {
    let airTotal = max(p.airTotal, p.air);
    let phase = select(0.0, p.air / airTotal, airTotal > 0.0);
    let ease = 0.35 + 0.65 * phase;
    p.pos.x = p.pos.x + p.vel.x * dt * ease;
    p.pos.y = p.pos.y + p.vel.y * dt * ease;
    // 3D 堆叠已移除：沙粒始终贴在板上（z=0），无竖直动力学
    p.z = 0.0;
    p.vz = 0.0;
    p.air = p.air - dt;
    if (p.air <= 0.0) {
    p.air = 0.0;
    p.vz = 0.0;
    p.z = 0.0;
    }
    // 越界：有形状约束则投影回边界定居（贴边堆积），否则退回方形盒内重生
    if (!inShapeXY(p.pos.x, p.pos.y, u.shape)) {
      let bp = boundaryProject(p.pos.x, p.pos.y, u.shape);
      let ox = p.pos.x - bp.x;
      let oy = p.pos.y - bp.y;
      let ol = max(sqrt(ox * ox + oy * oy), 1e-4);
      p.pos = vec2<f32>(bp.x + ox / ol * 0.004, bp.y + oy / ol * 0.004);
      p.air = 0.0;
      p.vel = vec2<f32>(0.0, 0.0);
      p.vz = 0.0;
      p.z = 0.0;
      p.settled = 1.0;
      outState[i] = p;
      return;
    } else if (p.pos.x < -u.plateLimit || p.pos.x > u.plateLimit || p.pos.y < -u.plateLimit || p.pos.y > u.plateLimit) {
      p.pos = spawnInShape(&seed, u.shape);
      p.air = 0.0;
      p.vel = vec2<f32>(0.0, 0.0);
      p.vz = 0.0;
      p.z = 0.0;
      p.settled = 0.0;
    }
    outState[i] = p;
    return;
  }

  let uu = (p.pos.x + 1.0) * 0.5;
  let vv = (p.pos.y + 1.0) * 0.5;
  let h = specHeight(uu, vv, u.blendT);
  let height = abs(h);
  let xc = 2.0 * uu - 1.0;
  let yc = 2.0 * vv - 1.0;
  let r = sqrt(xc * xc + yc * yc);
  let exc = 0.3 + 0.7 * max(0.0, 1.0 - r * 0.8);
  let shake = height * (0.4 + vib * 1.5 + treble * 0.6) * exc + kick * 0.9;
  let inertia = sqrt(p.mass);
  let speedScale = pow(p.mass, -0.4);
  let airScale = pow(p.mass, -0.2);
  let threshold = (0.12 + p.settled * 0.18) * p.grip * inertia;

  if (shake > threshold) {
    let tossProb = (shake - threshold) * 18.0 * vibRate * dt / inertia;
    if (rnd(&seed) < tossProb) {
      let g = specGrad(uu, vv, u.blendT);
      var gx = -g.x;
      var gy = -g.y;
      let glen = sqrt(gx * gx + gy * gy);
      let ra = rnd(&seed) * 6.2831853;
      var rx = cos(ra);
      var ry = sin(ra);
      var dx = 0.0;
      var dy = 0.0;
      if (glen > 1e-4) { dx = gx / glen; dy = gy / glen; }
      let wDown = min(1.0, glen * 0.25);
      var mx = dx * wDown + rx * (1.0 - wDown);
      var my = dy * wDown + ry * (1.0 - wDown);
      let mlen = max(length(vec2<f32>(mx, my)), 1.0);
      mx = mx / mlen;
      my = my / mlen;
      let motionGain = u.motionGain;
      let speed = min(
        3.0,
        min(
          0.6 * motionGain,
          (0.06 + min(shake, 2.0) * 0.2 + kick * 0.25) * speedScale * motionGain,
        ),
      ) * (0.7 + rnd(&seed) * 0.6);
      let airTime = (0.03 + rnd(&seed) * 0.04) * airScale * sqrt(motionGain);
      p.vel = vec2<f32>(mx * speed, my * speed);
      p.air = airTime;
      p.airTotal = airTime;
      p.settled = max(p.settled - 0.5, 0.0);
      p.vz = Z_HOP_F;
      outState[i] = p;
      return;
    }
  }

  if (height < 0.18) {
    p.settled = min(p.settled + dt * 0.9, 1.0);
  } else {
    p.settled = max(p.settled - dt * 1.5, 0.0);
  }

  // 贴边堆积：板内靠近边界的沙粒被吸向边缘并加速沉降，沿轮廓堆成沙带
  if (u.edgeAccumulate > 0.5) {
    let bp = boundaryProject(p.pos.x, p.pos.y, u.shape);
    let dxb = bp.x - p.pos.x;
    let dyb = bp.y - p.pos.y;
    let db = sqrt(dxb * dxb + dyb * dyb);
    if (inShapeXY(p.pos.x, p.pos.y, u.shape) && db < 0.05) {
      p.pos = p.pos + vec2<f32>(dxb, dyb) * 0.18;
      p.air = p.air * 0.4;
      p.settled = min(p.settled + dt * 2.0, 1.0);
    }
  }

  // 形状约束：被推出形状外的沙粒投影回最近边界并贴边定居（保持沙粒始终在板上）
  if (!inShapeXY(p.pos.x, p.pos.y, u.shape)) {
    let bp = boundaryProject(p.pos.x, p.pos.y, u.shape);
    let ox = p.pos.x - bp.x;
    let oy = p.pos.y - bp.y;
    let ol = max(sqrt(ox * ox + oy * oy), 1e-4);
    p.pos = vec2<f32>(bp.x + ox / ol * 0.004, bp.y + oy / ol * 0.004);
    p.air = 0.0;
    p.vel = vec2<f32>(0.0, 0.0);
    p.vz = 0.0;
    p.z = 0.0;
    p.settled = 1.0;
  }

  outState[i] = p;
}
`;

// --- 网格清空 / 构建 / 碰撞 ---
const CLEAR_WGSL = `
@group(0) @binding(0) var<storage, read_write> gridCount: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  atomicStore(&gridCount[gid.x], 0u);
}
`;

const BUILD_WGSL = P_STRUCT_WGSL + `
struct CU {
  gridDim: u32,
  K: u32,
  collideR: f32,
  stiff: f32,
  num: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> c: CU;
@group(0) @binding(1) var<storage, read> state: array<P>;
@group(0) @binding(2) var<storage, read_write> gridCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> gridItems: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= c.num) { return; }
  let p = state[i].pos;
  var cx = i32(floor((p.x + 1.0) / (2.0 * ${COLLIDE_CELL})));
  var cy = i32(floor((p.y + 1.0) / (2.0 * ${COLLIDE_CELL})));
  if (cx < 0) { cx = 0; } else if (cx >= i32(c.gridDim)) { cx = i32(c.gridDim) - 1; }
  if (cy < 0) { cy = 0; } else if (cy >= i32(c.gridDim)) { cy = i32(c.gridDim) - 1; }
  let cell = u32(cy) * c.gridDim + u32(cx);
  let slot = atomicAdd(&gridCount[cell], 1u);
  if (slot < c.K) {
    gridItems[cell * c.K + slot] = i;
  }
}
`;

const COLLIDE_WGSL = P_STRUCT_WGSL + `
const Z_GRAIN_F: f32 = ${Z_GRAIN};
struct CU {
  gridDim: u32,
  K: u32,
  collideR: f32,
  stiff: f32,
  num: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> c: CU;
@group(0) @binding(1) var<storage, read> inState: array<P>;
@group(0) @binding(2) var<storage, read_write> outState: array<P>;
@group(0) @binding(3) var<storage, read_write> gridCount: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> gridItems: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= c.num) { return; }
  let pi = inState[i].pos;
  var cx = i32(floor((pi.x + 1.0) / (2.0 * ${COLLIDE_CELL})));
  var cy = i32(floor((pi.y + 1.0) / (2.0 * ${COLLIDE_CELL})));
  if (cx < 0) { cx = 0; } else if (cx >= i32(c.gridDim)) { cx = i32(c.gridDim) - 1; }
  if (cy < 0) { cy = 0; } else if (cy >= i32(c.gridDim)) { cy = i32(c.gridDim) - 1; }
  var corrx = 0.0;
  var corry = 0.0;
  var dens = 0.0;
  let ri = c.collideR * inState[i].sizeF;
  let pz = inState[i].z;
  let doZ = false;
  for (var oy = -1; oy <= 1; oy = oy + 1) {
    for (var ox = -1; ox <= 1; ox = ox + 1) {
      let nx = cx + ox;
      let ny = cy + oy;
      if (nx < 0 || nx >= i32(c.gridDim) || ny < 0 || ny >= i32(c.gridDim)) { continue; }
      let ncell = u32(ny) * c.gridDim + u32(nx);
      let cnt = min(atomicLoad(&gridCount[ncell]), c.K);
      for (var s = 0u; s < cnt; s = s + 1u) {
        let j = gridItems[ncell * c.K + s];
        if (j == i) { continue; }
        let pj = inState[j].pos;
        let qz = inState[j].z;
        let zOverlap = !doZ || abs(pz - qz) < (Z_GRAIN_F * 0.5);
        let ddx = pi.x - pj.x;
        let ddy = pi.y - pj.y;
        let rj = c.collideR * inState[j].sizeF;
        let minD = ri + rj;
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 < minD * minD && d2 >= 1e-12 && zOverlap) {
          let d = sqrt(d2);
          let overlap = minD - d;
          let invI = 1.0 / inState[i].mass;
          let invJ = 1.0 / inState[j].mass;
          let invSum = invI + invJ;
          let corr = overlap * c.stiff;
          let wx = invI / invSum;
          corrx = corrx + (ddx / d) * corr * wx;
          corry = corry + (ddy / d) * corr * wx;
          dens = dens + 1.0;
        }
      }
    }
  }
  var np = pi + vec2<f32>(corrx, corry);
  np = clamp(np, vec2<f32>(-1.0), vec2<f32>(1.0));
  var o = inState[i];
  o.pos = np;
  o.density = dens;
  outState[i] = o;
}
`;

// --- 渲染（实例化四边形）---
const RENDER_WGSL = FIELD_WGSL + P_STRUCT_WGSL + `
const Z_GRAIN_F: f32 = ${Z_GRAIN};
const Z_MAX_LAYERS_F: f32 = ${Z_MAX_LAYERS}.0;
struct RU {
  W: f32,
  H: f32,
  plateX: f32,
  plateY: f32,
  plateSize: f32,
  grainPx: f32,
  prevM: f32,
  prevN: f32,
  curM: f32,
  curN: f32,
  blendT: f32,
  zFactor: f32,
  zGrain: f32,
  pad2: f32,
  pad3: f32,
};

@group(0) @binding(0) var<uniform> ru: RU;
@group(0) @binding(1) var<storage, read> parts: array<P>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>, // 实例化四角的局部坐标（-1..1），供片元裁成圆形
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = parts[ii];
  let zPix = p.z * ru.plateSize * ru.zFactor;
  let sx = ru.plateX + (p.pos.x * 0.5 + 0.5) * ru.plateSize;
  let sy = ru.plateY + (p.pos.y * 0.5 + 0.5) * ru.plateSize - zPix;
  let zN = clamp(p.z / (Z_GRAIN_F * Z_MAX_LAYERS_F), 0.0, 1.0);
  // 统一沙粒大小：渲染直径只取 grainPx*sizeF（sizeF 已固定 1.0），
  // 不再乘 (1+zN*0.25) 的堆叠放大，保证所有沙粒视觉尺寸一致。
  let hlen = max(ru.grainPx * p.sizeF, 0.5) * 0.5;
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  let c = corners[vi];
  let px = sx + c.x * hlen;
  let py = sy + c.y * hlen;
  let ndcx = px / ru.W * 2.0 - 1.0;
  let ndcy = 1.0 - py / ru.H * 2.0;
  var out: VOut;
  out.pos = vec4<f32>(ndcx, ndcy, 0.0, 1.0);
  out.uv = c; // 把局部坐标传给片元着色器，用于裁剪成圆形
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  // 圆形沙粒：四角四边形被裁剪成单位圆，圆外丢弃（硬边，alpha 恒为 1）。
  let r = length(in.uv);
  if (r > 1.0) { discard; }
  // 纯白、不透明（alpha = 1）。残影拖尾仍由 fade 通道按 0.85/0.92 衰减，
  // 因此移动中的沙粒会留下渐隐的圆形尾迹，保持「沙粒流动感」。
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`;

// --- 残影衰减 / 贴回画布（对应 CPU 路径每帧 data*=0.85/0.92 的拖尾）---
// 全屏三角形（3 顶点覆盖整个 NDC）
const FADE_WGSL = `
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(p[vi], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

const BLIT_WGSL = `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  let xy = p[vi];
  var o: VOut;
  o.pos = vec4<f32>(xy, 0.0, 1.0);
  // uv 与渲染朝向一致（NDC.y 向上 → 纹理 v 向下）
  o.uv = vec2<f32>((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return o;
}
@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  // 残影纹理按「直 alpha」存储，贴回 premultiplied 画布时需改回预乘：
  // 输出的 rgb 必须已是乘以 alpha 的预乘值，否则半透明沙粒会被错误提亮。
  let c = textureSample(tex, samp, in.uv);
  return vec4<f32>(c.rgb * c.a, c.a);
}
`;

// 创建 GPUBuffer 的便捷函数
function makeBuf(
  device,
  size,
  usage,
) {
  return device.createBuffer(
    {
      size,
      usage,
    },
  );
}

// 把粒子数组打包成 16-float 布局
function packParticles(
  arr,
  num,
) {
  const data = new Float32Array(
    num * FLOATS_PER_PARTICLE,
  );
  for (
    let i = 0;
    i < num;
    i++
  ) {
    const o = i * FLOATS_PER_PARTICLE;
    const p = arr[i];
    data[o] = p.x;
    data[o + 1] = p.y;
    data[o + 2] = p.vx || 0;
    data[o + 3] = p.vy || 0;
    data[o + 4] = p.air || 0;
    data[o + 5] = p.airTotal || p.air || 0;
    data[o + 6] = p.settled || 0;
    data[o + 7] = p.sizeF || 1;
    data[o + 8] = p.mass || 1;
    data[o + 9] = p.brightness != null
      ? p.brightness
      : 1;
    data[o + 10] = p.grip || 1;
    data[o + 11] = 0; // density
    data[o + 12] = 0; // z（堆叠高度）
    data[o + 13] = 0; // vz（竖直速度）
  }
  return data;
}

export class WebGPUParticleSystem {
  constructor(
    device,
    context,
    format,
    canvas,
    numParticles,
  ) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.canvas = canvas;
    this.num = numParticles;
    this.ok = true;
    // ready 在管线全部异步创建成功后（_init 末尾）才置 true，
    // 主循环只有在 ready 时才调用 step/render（此时管线已就绪）
    this.ready = false;
    this.cur = 0; // 当前状态所在缓冲下标（0/1/2 轮转）
    this.frame = 0;
    // 底板形状（索引，与 chladni.js shapeIndex 一致）：0 正方形 / 1 圆形 / 2 等边三角形 / 3 正六边形
    this._shapeName = "square";
    this._shapeIdx = 0;
    this.W = canvas.width || 1;
    this.H = canvas.height || 1;
    // 残影纹理（持久拖尾，对应 CPU 路径的 0.85/0.92 衰减）
    this.trailTex = null;
    this.trailView = null;
    this.trailSampler = null;
    this.fadePipe = null;
    this.blitPipe = null;

    const dev = device;

    // 着色器模块
    this.simMod = dev.createShaderModule(
      {
        code: SIM_WGSL,
      },
    );
    this.clearMod = dev.createShaderModule(
      {
        code: CLEAR_WGSL,
      },
    );
    this.buildMod = dev.createShaderModule(
      {
        code: BUILD_WGSL,
      },
    );
    this.collideMod = dev.createShaderModule(
      {
        code: COLLIDE_WGSL,
      },
    );
    this.renderMod = dev.createShaderModule(
      {
        code: RENDER_WGSL,
      },
    );

    const STORAGE = GPUBufferUsage.STORAGE;
    const UNIFORM = GPUBufferUsage.UNIFORM;
    const COPY_DST = GPUBufferUsage.COPY_DST;

    // 计算/渲染管线在 _init() 中异步创建（带校验，失败则整体回退）
    this._allocBuffers(
      STORAGE,
      UNIFORM,
      COPY_DST,
    );

    this.uUniform = makeBuf(
      dev,
      80,
      UNIFORM | COPY_DST,
    );
    this.uCollide = makeBuf(
      dev,
      32,
      UNIFORM | COPY_DST,
    );
    this.uRender = makeBuf(
      dev,
      64,
      UNIFORM | COPY_DST,
    );
    // 打包模式描述（62 个 f32 = 248 字节，对齐到 256）：
    // 走 storage buffer 而非 uniform，避免 uniform 数组 16 字节步长限制。
    this.uSpec = makeBuf(
      dev,
      256,
      STORAGE | COPY_DST,
    );
    // 兜底 spec：方板 3×4 差形式，避免首帧 params.spec 缺失时读到全 0
    this._fallbackSpec =
      flattenSpecs(
        packSpec(
          makeSquareSpec(
            3,
            4,
            -1,
          ),
        ),
        packSpec(
          makeSquareSpec(
            3,
            4,
            -1,
          ),
        ),
      );

    this._initData();
  }

  // 异步创建所有计算/渲染管线。任一管线创建失败（含着色器编译错误）
  // 都会令对应的 create*PipelineAsync 的 Promise 拒绝，这里用 try/catch
  // 捕获并向上抛错，由工厂函数的调用方（main.js）try/catch 回退到 WebGL2+CPU。
  // 注意：本方法不触碰画布上下文——上下文在工厂函数确认管线全部
  // 成功后才配置，避免「管线失败时画布已被 webgpu 上下文占用、
  // 导致 WebGL2 回退无法在同一画布创建 webgl2」的问题。
  async _init() {
    const dev = this.device;
    const mkCompute = (
      mod,
    ) =>
      dev.createComputePipelineAsync(
        {
          layout: "auto",
          compute: {
            module: mod,
            entryPoint: "main",
          },
        },
      );
    try {
      this.simPipe = await mkCompute(
        this.simMod,
      );
      this.clearPipe = await mkCompute(
        this.clearMod,
      );
      this.buildPipe = await mkCompute(
        this.buildMod,
      );
      this.collidePipe = await mkCompute(
        this.collideMod,
      );
      this.renderPipe = await dev.createRenderPipelineAsync(
        {
          layout: "auto",
          vertex: {
            module: this.renderMod,
            entryPoint: "vs",
          },
          fragment: {
            module: this.renderMod,
            entryPoint: "fs",
            targets: [
              {
                format: this.format,
                blend: {
                  color: {
                    srcFactor: "src-alpha",
                    dstFactor: "one-minus-src-alpha",
                    operation: "add",
                  },
                  alpha: {
                    srcFactor: "src-alpha",
                    dstFactor: "one-minus-src-alpha",
                    operation: "add",
                  },
                },
              },
            ],
          },
          primitive: {
            topology: "triangle-list",
          },
        },
      );
      // 残影衰减管线：用「常数混合因子」把已有内容乘 0.85(RGB)/0.92(Alpha)
      this.trailSampler = dev.createSampler(
        {
          magFilter: "linear",
          minFilter: "linear",
        },
      );
      this.fadePipe = await dev.createRenderPipelineAsync(
        {
          layout: "auto",
          vertex: {
            module: dev.createShaderModule(
              {
                code: FADE_WGSL,
              },
            ),
            entryPoint: "vs",
          },
          fragment: {
            module: dev.createShaderModule(
              {
                code: FADE_WGSL,
              },
            ),
            entryPoint: "fs",
            targets: [
              {
                format: this.format,
                blend: {
                  color: {
                    srcFactor: "zero",
                    dstFactor: "constant",
                    operation: "add",
                  },
                  alpha: {
                    srcFactor: "zero",
                    dstFactor: "constant",
                    operation: "add",
                  },
                },
              },
            ],
          },
          primitive: {
            topology: "triangle-list",
          },
        },
      );
      // 贴回画布管线（直接拷贝残影纹理，保持透明）
      this.blitPipe = await dev.createRenderPipelineAsync(
        {
          layout: "auto",
          vertex: {
            module: dev.createShaderModule(
              {
                code: BLIT_WGSL,
              },
            ),
            entryPoint: "vs",
          },
          fragment: {
            module: dev.createShaderModule(
              {
                code: BLIT_WGSL,
              },
            ),
            entryPoint: "fs",
            targets: [
              {
                format: this.format,
              },
            ],
          },
          primitive: {
            topology: "triangle-list",
          },
        },
      );
    } catch (e) {
      throw new Error(
        "WebGPU 管线创建失败: " +
          (e && e.message
            ? e.message
            : String(e)),
      );
    }
    this.ready = true;
  }

  _allocBuffers(
    STORAGE,
    UNIFORM,
    COPY_DST,
  ) {
    const dev = this.device;
    const psize =
      this.num *
      FLOATS_PER_PARTICLE *
      4;
    this.buffers = [
      makeBuf(
        dev,
        psize,
        STORAGE | COPY_DST,
      ),
      makeBuf(
        dev,
        psize,
        STORAGE | COPY_DST,
      ),
      makeBuf(
        dev,
        psize,
        STORAGE | COPY_DST,
      ),
    ];
    this.gridCount = makeBuf(
      dev,
      GRID_CELLS * 4,
      STORAGE,
    );
    this.gridItems = makeBuf(
      dev,
      GRID_CELLS *
        COLLIDE_K *
        4,
      STORAGE,
    );
  }

  // 生成初始粒子数据（与 particles.js _spawn 一致，并按当前形状在形状内重生）
  _initData() {
    const arr = [];
    const shape = this._shapeName;
    for (
      let i = 0;
      i < this.num;
      i++
    ) {
      // 统一沙粒大小：取消随机粒径，全部 sizeF=1.0（mass=1，碰撞/运动一致）。
      const sizeF = 1.0;
      // 在形状内部拒绝采样，保证沙粒不会一出生就落在板外
      let x = 0;
      let y = 0;
      for (
        let t = 0;
        t < 40;
        t++
      ) {
        x =
          (Math.random() *
            2 -
            1) *
          0.98;
        y =
          (Math.random() *
            2 -
            1) *
          0.98;
        if (
          inShapeXY(
            x,
            y,
            shape,
          )
        )
          break;
      }
      arr.push(
        {
          x,
          y,
          vx: 0,
          vy: 0,
          air: Math.random() * 0.12,
          airTotal: 0,
          settled: 0,
          sizeF,
          mass:
            sizeF *
            sizeF *
            sizeF,
          brightness:
            0.68 +
            Math.random() *
              0.32,
          grip:
            0.7 +
            Math.random() *
              0.6,
        },
      );
    }
    const data = packParticles(
      arr,
      this.num,
    );
    for (
      let b = 0;
      b < 3;
      b++
    ) {
      this.device.queue.writeBuffer(
        this.buffers[b],
        0,
        data,
      );
    }
    this.cur = 0;
  }

  setCount(
    n,
  ) {
    this.num = Math.max(
      1,
      Math.floor(
        n,
      ),
    );
    // 释放旧缓冲
    for (
      const b of this.buffers
    )
      b.destroy();
    this.gridCount.destroy();
    this.gridItems.destroy();
    const STORAGE = GPUBufferUsage.STORAGE;
    const COPY_DST = GPUBufferUsage.COPY_DST;
    this._allocBuffers(
      STORAGE,
      GPUBufferUsage.UNIFORM,
      COPY_DST,
    );
    this._initData();
  }

  // 切换底板形状：记录形状索引并依新形状重新生成初始粒子
  setShape(
    shape,
  ) {
    this._shapeName = shape;
    this._shapeIdx = shapeIndex(
      shape,
    );
    this.setCount(
      this.num,
    );
  }

  resize(
    W,
    H,
  ) {
    const dev = this.device;
    this.W = W;
    this.H = H;
    if (
      this.canvas.width !==
      W
    )
      this.canvas.width = W;
    if (
      this.canvas.height !==
      H
    )
      this.canvas.height = H;
    // WebGPU 画布随尺寸变化自动跟随；重新配置确保一致
    try {
      this.context.configure(
        {
          device: this.device,
          format: this.format,
          alphaMode: "premultiplied",
        },
      );
    } catch (
      e
    ) {
      /* 尺寸未变时重配置可能抛错，忽略 */
    }
    // 持久残影纹理（对应 CPU 路径每帧 data*=0.85/0.92 的拖尾"流动感"）
    // 交换链纹理无法跨帧 load，故累积到离屏纹理再贴回。
    if (
      !this.trailTex ||
      this.trailTex.width !==
        W ||
      this.trailTex.height !==
        H
    ) {
      if (
        this.trailTex
      )
        this.trailTex.destroy();
      this.trailTex = dev.createTexture(
        {
          size: [
            W,
            H,
          ],
          format: this.format,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING,
        },
      );
      this.trailView = this.trailTex.createView();
      // 初始化为透明
      const c = dev.createCommandEncoder();
      const p = c.beginRenderPass(
        {
          colorAttachments: [
            {
              view: this.trailView,
              loadOp: "clear",
              clearValue: {
                r: 0,
                g: 0,
                b: 0,
                a: 0,
              },
              storeOp: "store",
            },
          ],
        },
      );
      p.end();
      dev.queue.submit(
        [
          c.finish(),
        ],
      );
    }
  }

  // 每帧推进模拟（GPU compute）。params 为标量场参数
  step(
    dt,
    params,
  ) {
    if (
      !this.ok
    )
      return;
    const dev = this.device;
    const num = this.num;
    const cur = this.cur;
    const n0 =
      (cur + 1) %
      3;
    const n1 =
      (cur + 2) %
      3;

    // 更新 uniform
    const uBuf = new ArrayBuffer(
      80,
    );
    const uF = new Float32Array(
      uBuf,
    );
    const uI = new Uint32Array(
      uBuf,
    );
    uF[0] = dt;
    uF[1] = params.plateLimit || 0.97;
    uF[2] = params.vibration || 0;
    uF[3] = params.kick || 0;
    uF[4] = params.treble || 0;
    uF[5] = params.vibRate || 1;
    uF[6] = params.motionGain || 1;
    uF[7] = params.prevM || 0;
    uF[8] = params.prevN || 0;
    uF[9] = params.curM || 0;
    uF[10] = params.curN || 0;
    uF[11] = params.blendT != null
      ? params.blendT
      : 1;
    uI[12] = this.frame >>> 0;
    uI[13] = num >>> 0;
    uF[14] = Z_GRAIN;
    uF[15] = params.repose != null
      ? params.repose
      : Z_REPOSE;
    uF[16] = this._shapeIdx; // 底板形状索引
    uF[17] = params.edgeAccumulate != null
      ? params.edgeAccumulate
      : 1; // 贴边堆积（默认开）
    dev.queue.writeBuffer(
      this.uUniform,
      0,
      uBuf,
    );

    // 打包的 prev/cur 模式描述（圆板贝塞尔本征值、方板退化叠加项都在里面）
    const specArr =
      params.spec &&
      params.spec.length >=
        62
        ? params.spec
        : this._fallbackSpec;
    dev.queue.writeBuffer(
      this.uSpec,
      0,
      specArr,
    );

    const cBuf = new ArrayBuffer(
      32,
    );
    const cF = new Float32Array(
      cBuf,
    );
    const cI = new Uint32Array(
      cBuf,
    );
    cI[0] = GRID_DIM;
    cI[1] = COLLIDE_K;
    // 碰撞半径跟随「实际显示沙粒尺寸」，使斥开范围≈可见大小：
    // 视觉半径(归一化) = grainPx·sizeF / plateSize，着色器再乘 sizeF，
    // 故 collideR = grainPx / plateSize（此处不乘 sizeF）。
    // 封顶 COLLIDE_R 以保证网格 cell 仍覆盖该半径（网格按 COLLIDE_R 定尺度）。
    const _ps = params.plateSize || 800;
    const _gp = params.grainPx || 1.5;
    let collideR = _gp / _ps;
    collideR = Math.min(
      collideR,
      COLLIDE_R,
    );
    collideR = Math.max(
      collideR,
      0.0004,
    );
    cF[2] = collideR;
    cF[3] = COLLIDE_STIFF;
    cI[4] = num >>> 0;
    dev.queue.writeBuffer(
      this.uCollide,
      0,
      cBuf,
    );

    const enc = dev.createCommandEncoder();
    const groups = Math.ceil(
      num / 64,
    );
    const gridGroups = Math.ceil(
      GRID_CELLS / 64,
    );

    // 绑定组（按当前轮转重建）
    const simBG = dev.createBindGroup(
      {
        layout: this.simPipe.getBindGroupLayout(
          0,
        ),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: this.uUniform,
            },
          },
          {
            binding: 1,
            resource: {
              buffer: this.buffers[cur],
            },
          },
          {
            binding: 2,
            resource: {
              buffer: this.buffers[n0],
            },
          },
          {
            binding: 3,
            resource: {
              buffer: this.uSpec,
            },
          },
        ],
      },
    );
    const clearBG = dev.createBindGroup(
      {
        layout: this.clearPipe.getBindGroupLayout(
          0,
        ),
        entries: [
          {
            binding: 0,
            resource: {
              buffer: this.gridCount,
            },
          },
        ],
      },
    );
    const buildBG = (
      srcBuf,
    ) =>
      dev.createBindGroup(
        {
          layout: this.buildPipe.getBindGroupLayout(
            0,
          ),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: this.uCollide,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: srcBuf,
              },
            },
            {
              binding: 2,
              resource: {
                buffer: this.gridCount,
              },
            },
            {
              binding: 3,
              resource: {
                buffer: this.gridItems,
              },
            },
          ],
        },
      );
    const collideBG = (
      inBuf,
      outBuf,
    ) =>
      dev.createBindGroup(
        {
          layout: this.collidePipe.getBindGroupLayout(
            0,
          ),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: this.uCollide,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: inBuf,
              },
            },
            {
              binding: 2,
              resource: {
                buffer: outBuf,
              },
            },
            {
              binding: 3,
              resource: {
                buffer: this.gridCount,
              },
            },
            {
              binding: 4,
              resource: {
                buffer: this.gridItems,
              },
            },
          ],
        },
      );

    // sim: cur -> n0
    let pass = enc.beginComputePass();
    pass.setPipeline(
      this.simPipe,
    );
    pass.setBindGroup(
      0,
      simBG,
    );
    pass.dispatchWorkgroups(
      groups,
    );
    pass.end();

    // 两轮 清空→构建→解重叠（迭代收敛更稳）。
    // collision=false 时整段跳过：去掉颗粒间斥力（density 不受碰撞驱动，
    // SIM 的 z 堆叠与安息角完全独立，不受影响）。
    const doCollide = !!params.collision;
    if (
      doCollide
    ) {
    for (
      let it = 0;
      it < 2;
      it++
    ) {
      const inBuf = it === 0
        ? this.buffers[n0]
        : this.buffers[n1];
      const outBuf = it === 0
        ? this.buffers[n1]
        : this.buffers[n0];
      pass = enc.beginComputePass();
      pass.setPipeline(
        this.clearPipe,
      );
      pass.setBindGroup(
        0,
        clearBG,
      );
      pass.dispatchWorkgroups(
        gridGroups,
      );
      pass.end();

      pass = enc.beginComputePass();
      pass.setPipeline(
        this.buildPipe,
      );
      pass.setBindGroup(
        0,
        buildBG(
          inBuf,
        ),
      );
      pass.dispatchWorkgroups(
        groups,
      );
      pass.end();

      pass = enc.beginComputePass();
      pass.setPipeline(
        this.collidePipe,
      );
      pass.setBindGroup(
        0,
        collideBG(
          inBuf,
          outBuf,
        ),
      );
      pass.dispatchWorkgroups(
        groups,
      );
      pass.end();
    }
    }

    dev.queue.submit(
      [
        enc.finish(),
      ],
    );

    // 最终状态在 n0
    this.cur = n0;
    this.frame++;
  }

  // 渲染粒子层到 WebGPU 画布
  render(
    state,
    plateX,
    plateY,
    plateSize,
    grainPx,
  ) {
    if (
      !this.ok ||
      !this.trailView
    )
      return;
    const dev = this.device;
    const num = this.num;

    const rBuf = new ArrayBuffer(
      64,
    );
    const rF = new Float32Array(
      rBuf,
    );
    rF[0] = this.W;
    rF[1] = this.H;
    rF[2] = plateX;
    rF[3] = plateY;
    rF[4] = plateSize;
    rF[5] = grainPx || 1;
    rF[6] = state.prevM || 0;
    rF[7] = state.prevN || 0;
    rF[8] = state.currentM || 0;
    rF[9] = state.currentN || 0;
    rF[10] = state.blendT != null
      ? state.blendT
      : 1;
    rF[11] = Z_PROJECT;
    rF[12] = Z_GRAIN;
    dev.queue.writeBuffer(
      this.uRender,
      0,
      rBuf,
    );

    const enc = dev.createCommandEncoder();

    // 第一遍：累积到持久残影纹理（loadOp load = 保留上一帧内容）
    const trailPass = enc.beginRenderPass(
      {
        colorAttachments: [
          {
            view: this.trailView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      },
    );
    // 残影衰减：把已有内容乘 0.85(RGB)/0.92(Alpha)，沙粒拖尾渐隐
    // —— 这正是 CPU 路径"流动感"的来源，GPU 路径此前缺了它，故粒子像瞬闪。
    trailPass.setPipeline(
      this.fadePipe,
    );
    trailPass.setBlendConstant(
      [
        0.85,
        0.85,
        0.85,
        0.92,
      ],
    );
    trailPass.draw(
      3,
    );
    // 绘制本帧沙粒（预乘 alpha over 混合到残影上）
    if (
      state.showParticles
    ) {
      const bg = dev.createBindGroup(
        {
          layout: this.renderPipe.getBindGroupLayout(
            0,
          ),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: this.uRender,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: this.buffers[
                  this.cur
                ],
              },
            },
          ],
        },
      );
      trailPass.setPipeline(
        this.renderPipe,
      );
      trailPass.setBindGroup(
        0,
        bg,
      );
      trailPass.draw(
        6,
        num,
      );
    }
    trailPass.end();

    // 第二遍：把残影纹理贴回画布（保持透明，露出下层底板）
    const view = this.context.getCurrentTexture().createView();
    const blitPass = enc.beginRenderPass(
      {
        colorAttachments: [
          {
            view,
            clearValue: {
              r: 0,
              g: 0,
              b: 0,
              a: 0,
            },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      },
    );
    blitPass.setPipeline(
      this.blitPipe,
    );
    blitPass.setBindGroup(
      0,
      dev.createBindGroup(
        {
          layout: this.blitPipe.getBindGroupLayout(
            0,
          ),
          entries: [
            {
              binding: 0,
              resource: this.trailSampler,
            },
            {
              binding: 1,
              resource: this.trailView,
            },
          ],
        },
      ),
    );
    blitPass.draw(
      3,
    );
    blitPass.end();

    dev.queue.submit(
      [
        enc.finish(),
      ],
    );
  }
}

// 异步工厂：尝试初始化 WebGPU；失败返回 null（上层退回 WebGL2+CPU）
export async function createWebGPUParticles(
  canvas,
  numParticles,
) {
  if (
    typeof navigator ===
      "undefined" ||
    !navigator.gpu
  ) {
    return null;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (
    !adapter
  ) {
    return null;
  }
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  // 先创建系统并异步构建所有计算/渲染管线（不触碰画布上下文）
  const sys = new WebGPUParticleSystem(
    device,
    null,
    format,
    canvas,
    numParticles,
  );
  await sys._init();
  // 管线全部成功后再获取并配置画布上下文；若此时失败则抛错，由调用方回退。
  // 因为此刻之前从未 getContext，画布未被 webgpu 占用，WebGL2 回退可正常创建。
  const context = canvas.getContext(
    "webgpu",
  );
  if (
    !context
  ) {
    throw new Error(
      "无法获取 WebGPU 画布上下文",
    );
  }
  context.configure(
    {
      device,
      format,
      alphaMode: "premultiplied",
    },
  );
  sys.context = context;
  return sys;
}
