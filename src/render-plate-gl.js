// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  GLPlateRenderer — WebGL2 底板 + 节线渲染（方案 B）
//  用片元着色器实时计算克拉尼位移场 blendedHeight(u,v)，在全分辨率下
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

// 全屏四边形（两个三角形，覆盖裁剪空间）
const PLATE_QUAD_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 片元：实时克拉尼场 → 白色节线（直出 alpha，不做混合，保证透明背景干净）
const PLATE_FRAG = `#version 300 es
precision highp float;

uniform vec2  uResolution;   // 画布像素尺寸 (W, H)
uniform vec2  uPlateOrigin;  // 板左上角屏幕像素 (plateX, plateY)
uniform float uPlateSize;    // 板边长像素
uniform float uPm;           // 上一模式 m
uniform float uPn;           // 上一模式 n
uniform float uCm;           // 当前模式 m
uniform float uCn;           // 当前模式 n
uniform float uT;            // 模式混合系数 t ∈ [0,1]

out vec4 o;

const float PI = 3.14159265359;

// 自由板克拉尼方程（与 chladni.js chladniPsi 严格一致）
float chladniPsi(float u, float v, float m, float n) {
  if (abs(m - n) < 0.5) {
    // 同模 (m=n)：乘积形式
    return cos(m * PI * u) * cos(n * PI * v);
  }
  // 异模 (m≠n)：经典差形式
  return cos(n * PI * u) * cos(m * PI * v) -
         cos(m * PI * u) * cos(n * PI * v);
}

// 混合海拔场 H = (1-t)·|ψ(pm,pn)| + t·|ψ(cm,cn)|
float blendedHeight(float u, float v, float pm, float pn, float cm, float cn, float t) {
  float hc = abs(chladniPsi(u, v, cm, cn));
  if (t >= 1.0) return hc;
  float hp = abs(chladniPsi(u, v, pm, pn));
  return hp * (1.0 - t) + hc * t;
}

void main() {
  // 屏幕像素 → 板内归一化坐标 (u,v) ∈ [0,1]，u 向右、v 向下
  float u = (gl_FragCoord.x - uPlateOrigin.x) / uPlateSize;
  // WebGL 帧缓冲 y 向上：DOM 顶部对应 v=0 → 用 (H - fragY - originY)
  float v = (uResolution.y - gl_FragCoord.y - uPlateOrigin.y) / uPlateSize;

  // 边缘内缩遮罩：板外/边缘处淡出（与原实现 (edgeDist-0.035)/0.03 一致）
  float edgeDist = min(min(u, 1.0 - u), min(v, 1.0 - v));
  float interiorMask = clamp((edgeDist - 0.035) / 0.03, 0.0, 1.0);

  float h = blendedHeight(u, v, uPm, uPn, uCm, uCn, uT);
  float lineStrength = exp(-h * h * 220.0);

  // 直出白色节线 + alpha = 线强度；板外 interiorMask=0 → 透明，露出底层黑板
  float a = lineStrength * interiorMask;
  o = vec4(1.0, 1.0, 1.0, a);
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
    this._uPm = gl.getUniformLocation(
      this.prog,
      "uPm",
    );
    this._uPn = gl.getUniformLocation(
      this.prog,
      "uPn",
    );
    this._uCm = gl.getUniformLocation(
      this.prog,
      "uCm",
    );
    this._uCn = gl.getUniformLocation(
      this.prog,
      "uCn",
    );
    this._uT = gl.getUniformLocation(
      this.prog,
      "uT",
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
      this._uPm,
      state.prevM || 0,
    );
    gl.uniform1f(
      this._uPn,
      state.prevN || 0,
    );
    gl.uniform1f(
      this._uCm,
      state.currentM || 0,
    );
    gl.uniform1f(
      this._uCn,
      state.currentN || 0,
    );
    gl.uniform1f(
      this._uT,
      state.blendT != null
        ? state.blendT
        : 1,
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
