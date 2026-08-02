// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

// ============================================================
//  ParticleRecords — 沙粒渲染记录批处理
//  把「逐粒计算亮度/透明度/尺寸」从 render.js 抽成纯函数，并直接写入
//  预分配的 Float32Array，而不是每帧 new 出十万个 {nx,ny,g,c,a} 对象。
//
//  三项关键优化（v2.3.0）：
//   1. 零对象分配：打包缓冲复用 → 消除十万级对象的垃圾回收压力。
//   2. 波场网格采样：用 field-grid 的双线性插值替代逐粒 blendedHeight
//      （原本每粒 2 次 triangular function，十万粒即二十万次/帧）。
//   3. 高亮折叠：把原 Canvas2D 第二遍的 drawImage 高亮直接合进颜色/透明度
//      （与 WebGL 路径算法一致），彻底取消十万次 drawImage 调用。
//
//  打包布局（stride = 5，浮点）：
//    [0] nx  裁剪坐标 x（-1..1）
//    [1] ny  裁剪坐标 y（-1..1，板顶为 +1）
//    [2] gf  沙粒像素直径（浮点，未取整）
//    [3] c   颜色亮度（0..1，已含高亮）
//    [4] a   透明度（0..1，已含高亮与亚像素补偿）
//
//  纯计算、无 DOM 依赖 → 主线程与 Web Worker 共用。
// ============================================================

import { packedHeight } from "./chladni.js";
import { fieldGridReady, sampleHeight } from "./field-grid.js";

export const REC_STRIDE = 5;

// 复用的打包缓冲（按线程各自持有一份）
let _buf = null;
const _out = { data: null, count: 0 };

// 从打包记录还原板内像素坐标（Canvas2D 回退路径写 ImageData 用）
export function recPixelX(nx, plateSize) {
  return Math.round((nx + 1) * 0.5 * plateSize - 0.5);
}
export function recPixelY(ny, plateSize) {
  return Math.round((1 - ny) * 0.5 * plateSize - 0.5);
}

// 生成本帧渲染记录。
// particles: ParticleSystem.particles 数组
// params: { plateSize, grainPx, spec, blendT }
//   spec 为打包 ModeSpec（62 个 float），仅在波场网格未就绪时用于精确回退
// 返回 { data: Float32Array, count }，data 为复用缓冲，仅前 count*5 个元素有效。
export function buildParticleRecords(particles, params) {
  const plateSize = params.plateSize;
  const grainPx = params.grainPx || 1;
  const half = plateSize * 0.5;
  const inv = 2 / plateSize;

  const total = particles.length;
  const need = total * REC_STRIDE;
  if (!_buf || _buf.length < need) {
    // 留 20% 余量，避免拖动 SAND GRAINS 滑块时频繁重分配
    _buf = new Float32Array(Math.ceil(need * 1.2) || REC_STRIDE);
  }
  const d = _buf;

  // 网格未就绪（例如首帧或 GPU 路径下 CPU 物理未跑）时退回精确解析式；
  // spec 缺失（极早期首帧）则视作全平场，仅影响首帧亮度
  const spec = params.spec;
  const useGrid = fieldGridReady();
  const useSpec = !useGrid && !!spec;
  const blendT = params.blendT;

  let count = 0;
  let o = 0;
  for (let i = 0; i < total; i++) {
    const p = particles[i];
    const pxf = half * (1 + p.x);
    const pyf = half * (1 + p.y);
    const px = pxf | 0;
    const py = pyf | 0;
    if (px < 1 || px >= plateSize - 1 || py < 1 || py >= plateSize - 1) continue;

    // 边缘遮罩：贴边一圈不画（板框内缩）
    const ax = p.x < 0 ? -p.x : p.x;
    const ay = p.y < 0 ? -p.y : p.y;
    const edgeDistance = (1 - ax) < (1 - ay) ? 1 - ax : 1 - ay;
    let edgeMask = (edgeDistance - 0.065) / 0.06;
    if (edgeMask <= 0) continue;
    if (edgeMask > 1) edgeMask = 1;

    const settled = p.settled;
    // 腾空跳跃中的沙粒轻微提亮（跳-停模型：静止时 speed=0，小跳时 0.3~10）
    const sp2 = p.vx * p.vx + p.vy * p.vy;
    let movingBoost = Math.sqrt(sp2) / 6;
    if (movingBoost > 1) movingBoost = 1;
    movingBoost *= 0.3;

    const u = (p.x + 1) * 0.5;
    const v = (p.y + 1) * 0.5;
    const h = useGrid
      ? sampleHeight(u, v)
      : useSpec
        ? packedHeight(spec, u, v, blendT)
        : 0;
    const nodeAffinity = Math.exp(-(h * h) * 110);

    // 堆叠密度归一化：density 为碰撞阶段统计的近邻数（0=孤立），
    // 约 6 个近邻即视为「紧密堆积」，映射为 0~1 的密度增强因子。
    const dens = p.density;
    const densN = dens > 0 ? (dens > 6 ? 1 : dens / 6) : 0;

    const brightness =
      p.brightness *
      (0.52 + nodeAffinity * 0.96 + movingBoost * 0.12) *
      (0.2 + edgeMask * 0.8) *
      // 密集堆积的沙粒更亮（沙堆高光感）
      (1 + densN * 0.5);
    let val = brightness * 235 + 20;
    if (val > 255) val = 255;
    val = Math.floor(val);

    let alpha =
      0.18 +
      nodeAffinity * 0.62 +
      settled * 0.22 +
      movingBoost * 0.08 +
      // 密集堆积的沙粒更实（不透明）
      densN * 0.18;
    if (alpha > 1) alpha = 1;
    alpha *= edgeMask;

    // 统一沙粒大小：渲染直径 = grainPx * sizeF（sizeF 已固定 1.0），
    // 不再按密度放大，保证所有沙粒视觉尺寸一致。
    const gf = grainPx * (p.sizeF || 1);
    // 亚像素等比例补偿：gf<1 时硬件最小只能画 1px，
    // 按真实面积覆盖率 gf² 衰减透明度 → 视觉重量仍与物理尺寸成正比
    const subPx = gf < 1 ? gf * gf : 1;

    // 高亮（原 CPU 第二 pass 的 globalAlpha）折叠进颜色与透明度
    const highlight =
      0.12 +
      nodeAffinity * 0.34 +
      edgeMask * 0.12 +
      settled * 0.12 +
      movingBoost * 0.08;

    let c = val / 255 + highlight;
    if (c > 1) c = 1;
    let a = alpha + highlight;
    if (a > 1) a = 1;
    a *= subPx;

    // FBO 裁剪坐标：板顶(py=0) → clipY=+1
    d[o] = (px + 0.5) * inv - 1;
    d[o + 1] = 1 - (py + 0.5) * inv;
    d[o + 2] = gf; // 浮点尺寸 → gl_PointSize 连续变化，无取整跳变
    d[o + 3] = c;
    d[o + 4] = a;
    o += REC_STRIDE;
    count++;
  }

  _out.data = d;
  _out.count = count;
  return _out;
}
