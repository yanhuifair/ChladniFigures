// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  WebGPUParticleSystem — 粒子物理 + 碰撞 + 渲染全在 GPU（方案 C）
//  用 WebGPU compute shader 把整条粒子模拟搬到 GPU：
//    · sim 计算通道：逐粒子抛起/沉降/走位（移植 particles.js 状态机，
//      用哈希 PRNG 取代 Math.random）
//    · 碰撞计算通道：空间网格（atomic 计数 + 邻居解重叠），沙粒不可重叠、
//      沿节线堆成有宽度的沙带（沙堆观感），同时统计堆叠密度供渲染增强
//    · 渲染通道：实例化四边形画沙粒（预乘 alpha 叠加）
//  相比 WebGL2，WebGPU 有 compute + 原子操作，逐粒子碰撞才真正可行，
//  故可同时拿到「海量粒子」与「沙堆带观感」。
//  若浏览器不支持 WebGPU 或任何初始化失败 → 返回 null，上层退回 WebGL2+CPU。
// ============================================================

// 与 particles.js 保持一致的碰撞参数
const COLLIDE_R = 0.006;
const COLLIDE_STIFF = 0.5;
const COLLIDE_CELL = COLLIDE_R * 1.45 * 2; // 网格 cell 取最大半径的 2 倍
const COLLIDE_K = 16; // 每格最多容纳的粒子数（溢出丢弃）
const GRID_DIM = Math.ceil(
  2 / COLLIDE_CELL,
);
const GRID_CELLS =
  GRID_DIM *
  GRID_DIM;

// 3D 堆叠（小山丘感）：颗粒在 2D 板上随频率跳动，但允许沿 z 方向堆叠，
// 不再在 2D 完全斥开。用逐 cell 的 atomic 高度累加来分配层（layer）。
const Z_GRAIN = 0.005;          // 每颗沙粒在 z 方向的厚度（plate 单位）
const Z_SCALE = 4096;           // 定点数缩放：atomic<u32> 不能直接加 f32
const Z_FIXED = Math.round(Z_GRAIN * Z_SCALE); // 每层累加的定点值
const Z_MAX_LAYERS = 40;        // 单 cell 最大堆叠层数（防止无限增高）
const Z_GRAV = 0.5;             // 竖直重力（plate 单位 / s^2）
const Z_HOP = 0.015;            // 抛起时的初始竖直速度（轻微弹跳）
const Z_PROJECT = 0.5;          // 渲染时 z→屏幕像素的抬升比例

// 每颗粒子 16 个 float（64 字节），与 WGSL 结构体 P 的自动步长(64)对齐：
// [0,1]=pos [2,3]=vel [4]=air [5]=airTotal [6]=settled [7]=sizeF
// [8]=mass [9]=brightness [10]=grip [11]=density [12]=z [13]=vz [14,15]=pad
const FLOATS_PER_PARTICLE = 16;

// --- 共享 WGSL 场函数（被 sim / 碰撞 / 渲染复用）---
const FIELD_WGSL = `
const PI: f32 = 3.14159265359;

fn chladniPsi(uu: f32, vv: f32, m: f32, n: f32) -> f32 {
  if (abs(m - n) < 0.5) {
    return cos(m * PI * uu) * cos(n * PI * vv);
  }
  return cos(n * PI * uu) * cos(m * PI * vv) - cos(m * PI * uu) * cos(n * PI * vv);
}

fn blendedHeight(uu: f32, vv: f32, pm: f32, pn: f32, cm: f32, cn: f32, t: f32) -> f32 {
  let hc = abs(chladniPsi(uu, vv, cm, cn));
  if (t >= 1.0) { return hc; }
  let hp = abs(chladniPsi(uu, vv, pm, pn));
  return hp * (1.0 - t) + hc * t;
}

fn rawGrad(uu: f32, vv: f32, m: f32, n: f32) -> vec2<f32> {
  if (abs(m - n) < 0.5) {
    let au = cos(m * PI * uu);
    let bv = cos(n * PI * vv);
    let auP = -m * PI * sin(m * PI * uu);
    let bvP = -n * PI * sin(n * PI * vv);
    return vec2<f32>(auP * bv, au * bvP);
  }
  let dx = PI * (-n * sin(n * PI * uu) * cos(m * PI * vv) + m * sin(m * PI * uu) * cos(n * PI * vv));
  let dy = PI * (-m * cos(n * PI * uu) * sin(m * PI * vv) + n * cos(m * PI * uu) * sin(n * PI * vv));
  return vec2<f32>(dx, dy);
}

fn gradAt(uu: f32, vv: f32, pm: f32, pn: f32, cm: f32, cn: f32, t: f32) -> vec2<f32> {
  let psic = chladniPsi(uu, vv, cm, cn);
  let gc = rawGrad(uu, vv, cm, cn);
  let sc = select(-1.0, 1.0, psic >= 0.0);
  if (t >= 1.0) { return vec2<f32>(sc * gc.x, sc * gc.y); }
  let psip = chladniPsi(uu, vv, pm, pn);
  let gp = rawGrad(uu, vv, pm, pn);
  let sp = select(-1.0, 1.0, psip >= 0.0);
  return vec2<f32>(sp * gp.x * (1.0 - t) + sc * gc.x * t, sp * gp.y * (1.0 - t) + sc * gc.y * t);
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
  z: f32,    // 堆叠高度（3D 沙丘感）：颗粒在 2D 板上跳动，但可在 z 方向堆叠成小山丘
  vz: f32,   // 竖直速度
  pad2: f32,
  pad3: f32,
};
`;

// --- sim 计算着色器：逐粒子状态机 ---
const SIM_WGSL = FIELD_WGSL + P_STRUCT_WGSL + `
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
  stack3d: f32,
  zGrain: f32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> inState: array<P>;
@group(0) @binding(2) var<storage, read_write> outState: array<P>;
@group(0) @binding(3) var<storage, read_write> pileTop: array<atomic<u32>>;

const Z_GRAIN_F: f32 = ${Z_GRAIN};
const Z_FIXED_U: u32 = ${Z_FIXED}u;
const Z_SCALE_F: f32 = ${Z_SCALE}.0;
const Z_RECIP: f32 = 1.0 / ${Z_SCALE}.0;
const Z_MAX_LAYERS_U: u32 = ${Z_MAX_LAYERS}u;
const Z_GRAV_F: f32 = ${Z_GRAV};
const Z_HOP_F: f32 = ${Z_HOP};

fn cellOf(px: f32, py: f32) -> u32 {
  var cx = i32(floor((px + 1.0) / (2.0 * ${COLLIDE_CELL})));
  var cy = i32(floor((py + 1.0) / (2.0 * ${COLLIDE_CELL})));
  if (cx < 0) { cx = 0; } else if (cx >= i32(${GRID_DIM})) { cx = i32(${GRID_DIM}) - 1; }
  if (cy < 0) { cy = 0; } else if (cy >= i32(${GRID_DIM})) { cy = i32(${GRID_DIM}) - 1; }
  return u32(cy) * ${GRID_DIM}u + u32(cx);
}

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
    // 竖直（堆叠）动力学：空中时受重力下落，保持 z 直到着陆认领新层
    p.vz = p.vz - Z_GRAV_F * dt;
    p.z = p.z + p.vz * dt;
    if (p.z < 0.0) { p.z = 0.0; p.vz = 0.0; }
    p.air = p.air - dt;
    if (p.air <= 0.0) {
      p.air = 0.0;
      p.vel = vec2<f32>(0.0, 0.0);
      p.vz = 0.0;
      // 着陆：在落点 cell 认领一层（沿 z 堆叠成小山丘）
      if (u.stack3d > 0.5) {
        let cell = cellOf(p.pos.x, p.pos.y);
        let layer = min(atomicAdd(&pileTop[cell], Z_FIXED_U), Z_MAX_LAYERS_U - 1u);
        p.z = f32(layer) * Z_RECIP + Z_GRAIN_F * 0.5;
      } else {
        p.z = 0.0;
      }
    }
    if (p.pos.x < -u.plateLimit || p.pos.x > u.plateLimit || p.pos.y < -u.plateLimit || p.pos.y > u.plateLimit) {
      p.pos = vec2<f32>((rnd(&seed) * 2.0 - 1.0) * 0.98, (rnd(&seed) * 2.0 - 1.0) * 0.98);
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
  let h = blendedHeight(uu, vv, u.prevM, u.prevN, u.curM, u.curN, u.blendT);
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
      let g = gradAt(uu, vv, u.prevM, u.prevN, u.curM, u.curN, u.blendT);
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
      // 抛起时释放旧层的堆叠高度（若启用 3D 且确实堆在某一层）
      if (u.stack3d > 0.5 && p.z > 0.0) {
        let cell = cellOf(p.pos.x, p.pos.y);
        atomicSub(&pileTop[cell], Z_FIXED_U);
      }
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
  stack3d: f32,
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
  let doZ = c.stack3d > 0.5;
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
  @location(0) col: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = parts[ii];
  let zPix = p.z * ru.plateSize * ru.zFactor;
  let sx = ru.plateX + (p.pos.x * 0.5 + 0.5) * ru.plateSize;
  let sy = ru.plateY + (p.pos.y * 0.5 + 0.5) * ru.plateSize - zPix;
  let zN = clamp(p.z / (Z_GRAIN_F * Z_MAX_LAYERS_F), 0.0, 1.0);
  let hlen = max(ru.grainPx * p.sizeF * (1.0 + zN * 0.25), 0.5) * 0.5;
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
  let uu = (p.pos.x + 1.0) * 0.5;
  let vv = (p.pos.y + 1.0) * 0.5;
  let h = blendedHeight(uu, vv, ru.prevM, ru.prevN, ru.curM, ru.curN, ru.blendT);
  let nodeAffinity = exp(-h * h * 110.0);
  let densN = min(1.0, p.density / 6.0);
  let alpha = clamp(0.18 + nodeAffinity * 0.62 + p.settled * 0.22, 0.0, 1.0) * (1.0 + densN * 0.18);
  let bright = p.brightness * (0.5 + nodeAffinity * 0.96) * (1.0 + densN * 0.5) * (1.0 + zN * 0.45);
  out.col = vec4<f32>(vec3<f32>(bright), alpha);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.col.rgb * in.col.a, in.col.a); // 预乘 alpha
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
  return textureSample(tex, samp, in.uv);
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
    this.W = canvas.width || 1;
    this.H = canvas.height || 1;
    // 残影纹理（持久拖尾，对应 CPU 路径的 0.85/0.92 衰减）
    this.trailTex = null;
    this.trailView = null;
    this.trailSampler = null;
    this.fadePipe = null;
    this.blitPipe = null;
    this.pileTop = null; // 逐 cell 的堆叠高度累加（atomic<u32> 定点）

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
      64,
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
                    srcFactor: "one",
                    dstFactor: "one-minus-src-alpha",
                    operation: "add",
                  },
                  alpha: {
                    srcFactor: "one",
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
    this.pileTop = makeBuf(
      dev,
      GRID_CELLS * 4,
      STORAGE | COPY_DST,
    );
  }

  // 生成初始粒子数据（与 particles.js _spawn 一致）
  _initData() {
    const arr = [];
    for (
      let i = 0;
      i < this.num;
      i++
    ) {
      const sizeF =
        0.55 +
        Math.random() *
          0.9;
      arr.push(
        {
          x:
            (Math.random() *
              2 -
              1) *
            0.98,
          y:
            (Math.random() *
              2 -
              1) *
            0.98,
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
    // 堆叠高度清零（每 cell 当前堆积层数）
    this.device.queue.writeBuffer(
      this.pileTop,
      0,
      new Uint32Array(
        GRID_CELLS,
      ),
    );
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
    if (this.pileTop) this.pileTop.destroy();
    const STORAGE = GPUBufferUsage.STORAGE;
    const COPY_DST = GPUBufferUsage.COPY_DST;
    this._allocBuffers(
      STORAGE,
      GPUBufferUsage.UNIFORM,
      COPY_DST,
    );
    this._initData();
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
      64,
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
    uF[14] = params.stack3d != null
      ? params.stack3d
      : 0;
    uF[15] = Z_GRAIN;
    dev.queue.writeBuffer(
      this.uUniform,
      0,
      uBuf,
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
    cF[2] = COLLIDE_R;
    cF[3] = COLLIDE_STIFF;
    cI[4] = num >>> 0;
    cF[5] = params.stack3d != null
      ? params.stack3d
      : 0;
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
              buffer: this.pileTop,
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

    // 两轮 清空→构建→解重叠（迭代收敛更稳）
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
