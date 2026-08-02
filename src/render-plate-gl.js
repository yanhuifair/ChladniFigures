// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

// ============================================================
//  GLPlateRenderer — WebGL2 底板 + 节线渲染（方案 B）
//  用片元着色器实时计算克拉尼位移场 specHeight(u,v)，在全分辨率下
//  逐像素画出白色节线（带抗锯齿），彻底取代原 Canvas2D 的逐像素纹理图。
//
//  原实现把节线烘焙成一张 ≤1024px 的纹理再拉伸到板 —— 大板/全屏时
//  拉伸倍数过高、白色节线明显发糊。改为着色器后：
//    · 每帧全分辨率实时计算，节线永远锐利、零模糊；
//    · 分辨率不再受成本限制（GPU 逐像素几乎免费）；
//    · 顺带获得抗锯齿（exp 衰减自然柔边）。
//  仅输出白色节线 + 透明背景（alpha = 线强度），由底层 2D 黑板透出黑色。
//  若浏览器不支持 WebGL2，ok=false，上层退回 Canvas2D 节线纹理。
// ============================================================

import {
  shapeIndex,
  flattenSpecs,
  packSpec,
  makeSquareSpec,
} from "./chladni.js";

// 全屏四边形（两个三角形，覆盖裁剪空间）
const PLATE_QUAD_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 片元：实时克拉尼场 → 白色节线（直出 alpha，不做混合，保证透明背景干净）
// 位移场完全由 uSpec（chladni.js flattenSpecs 打包）驱动，与 JS/WGSL 三端同源：
//   · 正方形：最多 8 项退化模态线性叠加，支持 ± 两种符号
//   · 圆形：精确自由板本征函数 J_n(z_{n,m}·r)·cos(nθ)（Miller 递推现算贝塞尔）
//   · 三角/六边：D_n 对称余弦光栅
const PLATE_FRAG = `#version 300 es
precision highp float;

uniform vec2  uResolution;   // 画布像素尺寸 (W, H)
uniform vec2  uPlateOrigin;  // 板左上角屏幕像素 (plateX, plateY)
uniform float uPlateSize;    // 板边长像素
uniform float uT;            // 模式混合系数 t ∈ [0,1]
uniform float uShape;        // 底板形状：0 正方形 / 1 圆形 / 2 等边三角形 / 3 正六边形
uniform float uAmp;          // 板面振动幅度 0~1：节线随音量"呼吸"（越响越锐越亮）
uniform float uSpec[62];     // 打包的 prev/cur 模式描述（每段 31 float）

out vec4 o;

const float PI = 3.14159265359;
const int  STRIDE = 31;

// --- 第一类贝塞尔函数 J_n(x)：Miller 向下递推（与 bessel.js besselJ 等价）---
// float32 动态范围有限，递推过程中幅值可能爆掉 → 超阈值时整体缩放（比值不变）。
float besselJ(float nf, float x) {
  int n = int(nf + 0.5);
  float ax = abs(x);
  if (ax < 1e-6) return n == 0 ? 1.0 : 0.0;
  float jPrev = 0.0;   // j_{k+1}
  float jCur  = 1.0;   // j_k，种子 j_M = 1
  float jn    = 0.0;   // 目标 J_n（未归一化）
  float sum   = 0.0;   // 归一化和 j_0 + 2(j_2 + j_4 + …)
  float invX  = 2.0 / ax;
  for (int k = 52; k >= 1; k--) {
    float jNew = invX * float(k) * jCur - jPrev;   // j_{k-1}
    int idx = k - 1;
    if (idx == n) jn = jNew;
    if (idx == 0) sum += jNew;
    else if (idx - (idx / 2) * 2 == 0) sum += 2.0 * jNew;
    jPrev = jCur;
    jCur  = jNew;
    if (abs(jCur) > 1e18) {   // 防溢出：等比缩小，不影响最终比值
      jCur *= 1e-18; jPrev *= 1e-18; jn *= 1e-18; sum *= 1e-18;
    }
  }
  if (n == 0) jn = jCur;
  return jn / sum;
}

// 方板单项位移场（与 chladni.js squarePsi 一致；sign≥0 取和形式，否则差形式）
float squarePsi(float u, float v, float m, float n, float sgn) {
  if (abs(m - n) < 0.5) return cos(m * PI * u) * cos(n * PI * v);
  float a = cos(n * PI * u) * cos(m * PI * v);
  float b = cos(m * PI * u) * cos(n * PI * v);
  return sgn >= 0.0 ? (a + b) : (a - b);
}

// D_n 对称余弦光栅（三角 3 向 / 六边 6 向，与 chladni.js polyPsi 一致）
// 退化模态自动叠加：cos(mp)−cos(np) 与 sin(mp)−sin(np) 等权叠加（旋转 45°）
float polyPsi(float cx, float cy, float m, float n, float shape) {
  float s = 0.0;
  int dirs = shape < 2.5 ? 3 : 6;
  float dth = shape < 2.5 ? 2.0943951 : 1.0471976;  // 2π/3（三角）或 π/3（六边）
  float inv = 0.70710678;
  for (int i = 0; i < 6; i++) {
    if (i >= dirs) break;
    float a = float(i) * dth;
    float p = cx * cos(a) + cy * sin(a);
    s += ((cos(m * p) - cos(n * p)) + (sin(m * p) - sin(n * p))) * inv;
  }
  return s;
}

// 按打包描述求位移场 ψ（base = 0 取 prev，31 取 cur），已含归一化尺度
float specPsi(int base, float u, float v) {
  float shape = uSpec[base];
  float scale = uSpec[base + 2];
  if (shape < 0.5) {
    int len = int(uSpec[base + 1] + 0.5);
    float s = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= len) break;
      float sgn = uSpec[base + 19 + i];
      s += sgn * squarePsi(u, v, uSpec[base + 3 + i], uSpec[base + 11 + i], sgn);
    }
    return s * scale;
  }
  float cx = 2.0 * u - 1.0;
  float cy = 2.0 * v - 1.0;
  if (shape < 1.5) {
    // 圆板精确本征函数：J_n(z·r)·[cos(nθ)+sin(nθ)]/√2（nAng≥1 自动叠加简并伙伴）
    float nAng = uSpec[base + 27];
    float z    = uSpec[base + 28];
    float r    = length(vec2(cx, cy));
    float ang  = nAng < 0.5 ? 1.0 : (cos(nAng * atan(cy, cx)) + sin(nAng * atan(cy, cx))) * 0.70710678;
    return besselJ(nAng, z * r) * ang * scale;
  }
  return polyPsi(cx, cy, uSpec[base + 29], uSpec[base + 30], shape) * scale;
}

// 混合高度场 H = (1-t)·|ψ(prev)| + t·|ψ(cur)|
float specHeight(float u, float v, float t) {
  float hc = abs(specPsi(STRIDE, u, v));
  if (t >= 1.0) return hc;
  float hp = abs(specPsi(0, u, v));
  return hp * (1.0 - t) + hc * t;
}

// 形状遮罩：统一在"到边界的有符号距离（uv 单位）"上做内缩 + smoothstep 柔边，
// 圆 / 三角 / 六边不再是 step 硬裁剪，边缘与正方形一样干净不锯齿。
float shapeMask(float u, float v, float shape, float px) {
  float d;
  if (shape < 0.5) {
    d = min(min(u, 1.0 - u), min(v, 1.0 - v));
  } else {
    float cx = 2.0 * u - 1.0;
    float cy = 2.0 * v - 1.0;
    float dc;                         // 居中单位下的有符号距离（内部为正）
    const float C = 0.8660254;        // √3/2
    if (shape < 1.5) {
      dc = 1.0 - length(vec2(cx, cy));
    } else if (shape < 2.5) {
      // 等边三角形：顶点 (0,1) / (±√3/2, -1/2)，三条边的点线距取最小
      dc = min(cy + 0.5,
           min((C - 1.5 * cx - C * cy) * 0.5773503,
               (C + 1.5 * cx - C * cy) * 0.5773503));
    } else {
      // 正六边形：三对平行边，法向已是单位向量 → 直接就是距离
      dc = min(C - abs(cy),
           min(C - abs(C * cx + 0.5 * cy),
               C - abs(C * cx - 0.5 * cy)));
    }
    d = dc * 0.5;                     // 居中单位 → uv 单位
  }
  // 边缘内缩 0.035（避开自由边处的场畸变），柔边至少覆盖 1.5 像素
  float aa = max(0.03, px * 1.5);
  return clamp((d - 0.035) / aa, 0.0, 1.0);
}

void main() {
  // 屏幕像素 → 板内归一化坐标 (u,v) ∈ [0,1]，u 向右、v 向下
  float u = (gl_FragCoord.x - uPlateOrigin.x) / uPlateSize;
  // WebGL 帧缓冲 y 向上：DOM 顶部对应 v=0 → 用 (H - fragY - originY)
  float v = (uResolution.y - gl_FragCoord.y - uPlateOrigin.y) / uPlateSize;

  float px   = 1.0 / max(1.0, uPlateSize);
  float mask = shapeMask(u, v, uShape, px);
  if (mask <= 0.0) { o = vec4(0.0); return; }

  float h = specHeight(u, v, uT);

  // 节线"呼吸"：板面振幅越大 → 沙粒被驱赶得越彻底 → 节线更细更亮；
  // 安静时节线变宽变暗，视觉上跟着音乐起伏。
  float amp   = clamp(uAmp, 0.0, 1.0);
  float sharp = mix(140.0, 340.0, amp);
  float gain  = 0.72 + 0.38 * amp;
  float lineStrength = exp(-h * h * sharp) * gain;

  // 直出白色节线 + alpha = 线强度；板外 mask=0 → 透明，露出底层黑板
  o = vec4(1.0, 1.0, 1.0, clamp(lineStrength, 0.0, 1.0) * mask);
}`;

export class GLPlateRenderer {
  constructor(
    canvas,
  ) {
    this.canvas = canvas;
    this.ok = false;
    this.W = 0;
    this.H = 0;

    const gl = canvas.getContext(
      "webgl2",
      {
        alpha: true,
        // 直出 alpha（非预乘）：片段写入 vec4(1,1,1,a)，浏览器按直透合成到黑板
        premultipliedAlpha: false,
        antialias: false,
        depth: false,
      },
    );
    if (
      !gl
    )
      return;
    this.gl = gl;
    this.ok = true;
    this._initGL();
  }

  _initGL() {
    const gl = this.gl;

    // 全屏四边形 VAO
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(
      this.quadVao,
    );
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      this.quadBuf,
    );
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(
        [
          -1, -1, 1, -1, -1, 1, 1, 1,
        ],
      ),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(
      0,
    );
    gl.vertexAttribPointer(
      0,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.bindVertexArray(
      null,
    );

    this.prog = this._program(
      PLATE_QUAD_VERT,
      PLATE_FRAG,
    );
    if (
      !this.prog
    ) {
      console.error(
        "GLPlateRenderer: 着色器初始化失败，退回 Canvas2D 节线",
      );
      this.ok = false;
      return;
    }
    this._uRes = gl.getUniformLocation(
      this.prog,
      "uResolution",
    );
    this._uOrigin = gl.getUniformLocation(
      this.prog,
      "uPlateOrigin",
    );
    this._uSize = gl.getUniformLocation(
      this.prog,
      "uPlateSize",
    );
    this._uT = gl.getUniformLocation(
      this.prog,
      "uT",
    );
    this._uShape = gl.getUniformLocation(
      this.prog,
      "uShape",
    );
    this._uAmp = gl.getUniformLocation(
      this.prog,
      "uAmp",
    );
    this._uSpec = gl.getUniformLocation(
      this.prog,
      "uSpec[0]",
    );
    // 无 spec 时的兜底：方板 3×4 差形式（与 chladni.js 打包布局一致）
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
  }

  _program(
    vsSrc,
    fsSrc,
  ) {
    const gl = this.gl;
    const vs = this._shader(
      gl.VERTEX_SHADER,
      vsSrc,
    );
    const fs = this._shader(
      gl.FRAGMENT_SHADER,
      fsSrc,
    );
    if (
      !vs ||
      !fs
    )
      return null;
    const p = gl.createProgram();
    gl.attachShader(
      p,
      vs,
    );
    gl.attachShader(
      p,
      fs,
    );
    gl.linkProgram(
      p,
    );
    if (
      !gl.getProgramParameter(
        p,
        gl.LINK_STATUS,
      )
    ) {
      console.error(
        "GLPlateRenderer program link error:",
        gl.getProgramInfoLog(
          p,
        ),
      );
      return null;
    }
    return p;
  }

  _shader(
    type,
    src,
  ) {
    const gl = this.gl;
    const s = gl.createShader(
      type,
    );
    gl.shaderSource(
      s,
      src,
    );
    gl.compileShader(
      s,
    );
    if (
      !gl.getShaderParameter(
        s,
        gl.COMPILE_STATUS,
      )
    ) {
      console.error(
        "GLPlateRenderer shader error:",
        gl.getShaderInfoLog(
          s,
        ),
      );
      return null;
    }
    return s;
  }

  // 设置画布像素尺寸（整窗）
  resize(
    W,
    H,
  ) {
    if (
      !this.ok
    )
      return;
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
  }

  // 绘制底板节线。opts: { plateX, plateY, plateSize }
  // state: { showPattern, prevM, prevN, currentM, currentN, blendT }
  render(
    state,
    plateX,
    plateY,
    plateSize,
  ) {
    if (
      !this.ok
    )
      return;
    const gl = this.gl;
    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      null,
    );
    gl.viewport(
      0,
      0,
      this.W,
      this.H,
    );
    // 透明清屏：直出 alpha，禁用混合（全屏四边形逐像素覆盖，无需混合）
    gl.disable(
      gl.BLEND,
    );
    gl.clearColor(
      0,
      0,
      0,
      0,
    );
    gl.clear(
      gl.COLOR_BUFFER_BIT,
    );

    // 不显示节线：保持透明（露出底层 2D 黑板）
    if (
      !state.showPattern
    )
      return;

    gl.useProgram(
      this.prog,
    );
    gl.uniform2f(
      this._uRes,
      this.W,
      this.H,
    );
    gl.uniform2f(
      this._uOrigin,
      plateX,
      plateY,
    );
    gl.uniform1f(
      this._uSize,
      plateSize,
    );
    gl.uniform1f(
      this._uT,
      state.blendT != null
        ? state.blendT
        : 1,
    );
    gl.uniform1f(
      this._uShape,
      shapeIndex(
        state.plateShape,
      ),
    );
    gl.uniform1f(
      this._uAmp,
      state.vibrationAmplitude ||
        0,
    );
    // 打包的 prev/cur 模式描述：圆板贝塞尔本征值、方板退化叠加项全在里面
    gl.uniform1fv(
      this._uSpec,
      state.specPacked ||
        this._fallbackSpec,
    );
    gl.bindVertexArray(
      this.quadVao,
    );
    gl.drawArrays(
      gl.TRIANGLE_STRIP,
      0,
      4,
    );
    gl.bindVertexArray(
      null,
    );
  }
}
