// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  FieldGrid — 波场粗网格缓存（CPU 路径共享）
//  逐粒调用 field.psiAt（含大量三角函数）在 10 万粒子下每帧约 20 万次
//  triangular function，极重 → 卡顿。改为每帧只在 N×N 粗网格上采样一次
//  field.psiAt，梯度用中心差分得到；逐粒（物理）与逐粒（渲染）都只做廉价
//  双线性插值：trigonometric 调用量降约 6×。
//
//  CPU 物理（particles.js）与 CPU 渲染（particle-records.js）共用同一份网格：
//  每帧由 particles.update 先构建一次，渲染阶段直接复用，无需二次采样。
//  纯计算、无 DOM 依赖 → 可直接在 Web Worker 中使用。
// ============================================================

export const FIELD_GRID_N = 128;

let _hGrid = null;
let _gxGrid = null;
let _gyGrid = null;
// 本帧网格是否已构建：渲染端据此决定「用网格采样」还是「回退到精确解析式」
let _ready = false;

// 复用的梯度输出对象（避免每次采样分配）
export const gradOut = { x: 0, y: 0 };

// 构建本帧网格。field 需提供 psiAt(u, v)。
export function buildFieldGrid(field) {
  const N = FIELD_GRID_N;
  if (!_hGrid) {
    _hGrid = new Float32Array(N * N);
    _gxGrid = new Float32Array(N * N);
    _gyGrid = new Float32Array(N * N);
  }
  const du = 1 / (N - 1);
  for (let j = 0; j < N; j++) {
    const v = j * du;
    const row = j * N;
    for (let i = 0; i < N; i++) {
      _hGrid[row + i] = field.psiAt(i * du, v);
    }
  }
  for (let j = 0; j < N; j++) {
    const row = j * N;
    const jm = j > 0 ? j - 1 : 0;
    const jp = j < N - 1 ? j + 1 : N - 1;
    const rowM = jm * N;
    const rowP = jp * N;
    const dv = (jp - jm) * du;
    for (let i = 0; i < N; i++) {
      const im = i > 0 ? i - 1 : 0;
      const ip = i < N - 1 ? i + 1 : N - 1;
      const du2 = (ip - im) * du;
      _gxGrid[row + i] = (_hGrid[row + ip] - _hGrid[row + im]) / du2;
      _gyGrid[row + i] = (_hGrid[rowP + i] - _hGrid[rowM + i]) / dv;
    }
  }
  _ready = true;
}

// 本帧网格是否可用（渲染端在 GPU 路径下可能根本没构建过）
export function fieldGridReady() {
  return _ready;
}

// 标记网格失效（例如切到 GPU 路径后 CPU 物理不再每帧构建）
export function invalidateFieldGrid() {
  _ready = false;
}

export function sampleHeight(u, v) {
  const N = FIELD_GRID_N;
  let fu = u * (N - 1);
  let fv = v * (N - 1);
  if (fu < 0) fu = 0; else if (fu > N - 1) fu = N - 1;
  if (fv < 0) fv = 0; else if (fv > N - 1) fv = N - 1;
  const i0 = fu | 0;
  const j0 = fv | 0;
  const i1 = i0 < N - 1 ? i0 + 1 : i0;
  const j1 = j0 < N - 1 ? j0 + 1 : j0;
  const tx = fu - i0;
  const ty = fv - j0;
  const r0 = j0 * N;
  const r1 = j1 * N;
  const h00 = _hGrid[r0 + i0];
  const h10 = _hGrid[r0 + i1];
  const h01 = _hGrid[r1 + i0];
  const h11 = _hGrid[r1 + i1];
  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * ty;
}

export function sampleGrad(u, v) {
  const N = FIELD_GRID_N;
  let fu = u * (N - 1);
  let fv = v * (N - 1);
  if (fu < 0) fu = 0; else if (fu > N - 1) fu = N - 1;
  if (fv < 0) fv = 0; else if (fv > N - 1) fv = N - 1;
  const i0 = fu | 0;
  const j0 = fv | 0;
  const i1 = i0 < N - 1 ? i0 + 1 : i0;
  const j1 = j0 < N - 1 ? j0 + 1 : j0;
  const tx = fu - i0;
  const ty = fv - j0;
  const r0 = j0 * N;
  const r1 = j1 * N;
  const gx00 = _gxGrid[r0 + i0];
  const gx10 = _gxGrid[r0 + i1];
  const gx01 = _gxGrid[r1 + i0];
  const gx11 = _gxGrid[r1 + i1];
  const ax = gx00 + (gx10 - gx00) * tx;
  const bx = gx01 + (gx11 - gx01) * tx;
  gradOut.x = ax + (bx - ax) * ty;
  const gy00 = _gyGrid[r0 + i0];
  const gy10 = _gyGrid[r0 + i1];
  const gy01 = _gyGrid[r1 + i0];
  const gy11 = _gyGrid[r1 + i1];
  const ay = gy00 + (gy10 - gy00) * tx;
  const by = gy01 + (gy11 - gy01) * tx;
  gradOut.y = ay + (by - ay) * ty;
}
