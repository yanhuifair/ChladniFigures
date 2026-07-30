// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  GLParticleRenderer — WebGL2 粒子渲染（方案 A）
//  用点精灵 (GL_POINTS) 在 GPU 上绘制沙粒，硬边方块；
//  用乒乓帧缓冲 (FBO) 做残影衰减，彻底消除原 Canvas2D 的两处 CPU 瓶颈：
//    1) 每帧 O(plateSize²) 的 ImageData 残影循环 → GPU 全屏衰减 pass
//    2) 每颗粒子 g×g 的像素核写入 → 着色器一个点精灵搞定
//  物理更新（位置/跳跃/沉降）仍在 CPU（particles.js），本类只负责渲染。
//  若浏览器不支持 WebGL2，ok=false，上层退回 Canvas2D 路径。
// ============================================================

// --- 着色器源码（#version 必须为首行，前面不能有空行）---

// 全屏四边形（衰减/合成共用几何）
const QUAD_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 残影衰减：把上一帧乘以 uDecay（rgb+alpha 一起淡出）
const DECAY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uDecay;
out vec4 o;
void main() {
  o = texture(uTex, vUv) * uDecay;
}`;

// 粒子：顶点直接给出 FBO 裁剪坐标，gl_PointSize = 沙粒像素尺寸
const PARTICLE_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;   // FBO 裁剪空间坐标
layout(location = 1) in float aSize; // 点直径（FBO 像素）
layout(location = 2) in float aCol;  // 亮度 0..1
layout(location = 3) in float aA;    // 透明度 0..1
out float vCol;
out float vA;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = aSize;
  vCol = aCol;
  vA = aA;
}`;

// 粒子片元：硬边方块（gl_PointCoord 天然覆盖方形，不丢弃即硬边）
const PARTICLE_FRAG = `#version 300 es
precision highp float;
in float vCol;
in float vA;
out vec4 o;
void main() {
  o = vec4(vec3(vCol), vA);
}`;

// 合成：把 trail 纹理贴到屏幕上的板区域（含震动偏移）。
// 顶点带独立 uv（非全屏，不能由 aPos 推导），避免和衰减用的全屏 quad 混淆。
const COMPOSITE_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUv);
  // 预乘 alpha：透明叠加层必须输出 premultiplied，否则合成到页面会变暗
  o = vec4(c.rgb * c.a, c.a);
}`;

export class GLParticleRenderer {
  constructor(
    canvas,
  ) {
    this.canvas = canvas;
    this.ok = false;
    this.plateSize = 0;
    this.W = 0;
    this.H = 0;
    // 乒乓帧缓冲
    this.trailA = null;
    this.trailB = null;
    this.texA = null;
    this.texB = null;
    // 着色器程序与缓冲
    this.decayProg = null;
    this.particleProg = null;
    this.compositeProg = null;
    this.quadVao = null;
    this.quadBuf = null;
    this.compositeVao = null;
    this._compPosBuf = null;
    this._compUvBuf = null;
    this.partVao = null;
    this.partBuf = null;
    this._data = null; // 可增长的属性缓冲（Float32Array）
    this._stride = 5; // nx, ny, size, col, alpha

    const gl = canvas.getContext(
      "webgl2",
      {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        // 保留绘制缓冲：允许通过 drawImage 把沙粒层读回 2D 画布做 PNG 导出
        preserveDrawingBuffer: true,
      },
    );
    if (
      !gl
    )
      return;
    this.gl = gl;
    this.ok = true;
    // 硬件点精灵尺寸上限（严格等比例：不做软件封顶，仅受硬件限制；
    // 桌面 GPU 通常 ≥1024px，足以覆盖任何合法的沙粒/底板比例）
    const range =
      gl.getParameter(
        gl.ALIASED_POINT_SIZE_RANGE,
      );
    this.maxPointSize =
      (range &&
        range[1]) ||
      64;
    this._initGL();
  }

  _initGL() {
    const gl = this.gl;
    // 全屏四边形（两个三角形，覆盖裁剪空间）
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(
      this.quadVao,
    );
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      this.quadBuf,
    );
    // 4 顶点，每顶点仅位置（uv 由顶点着色器推算）
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

    // 粒子属性缓冲（动态，位置 0/1/2/3 由着色器 location 固定）
    this.partVao = gl.createVertexArray();
    gl.bindVertexArray(
      this.partVao,
    );
    this.partBuf = gl.createBuffer();
    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      this.partBuf,
    );
    const stride = this._stride * 4;
    gl.enableVertexAttribArray(
      0,
    );
    gl.vertexAttribPointer(
      0,
      2,
      gl.FLOAT,
      false,
      stride,
      0,
    );
    gl.enableVertexAttribArray(
      1,
    );
    gl.vertexAttribPointer(
      1,
      1,
      gl.FLOAT,
      false,
      stride,
      2 * 4,
    );
    gl.enableVertexAttribArray(
      2,
    );
    gl.vertexAttribPointer(
      2,
      1,
      gl.FLOAT,
      false,
      stride,
      3 * 4,
    );
    gl.enableVertexAttribArray(
      3,
    );
    gl.vertexAttribPointer(
      3,
      1,
      gl.FLOAT,
      false,
      stride,
      4 * 4,
    );
    gl.bindVertexArray(
      null,
    );

    this.decayProg = this._program(
      QUAD_VERT,
      DECAY_FRAG,
    );
    this.particleProg = this._program(
      PARTICLE_VERT,
      PARTICLE_FRAG,
    );
    this.compositeProg = this._program(
      COMPOSITE_VERT,
      COMPOSITE_FRAG,
    );
    // 任一着色器编译/链接失败 → 整体降级到 CPU 路径（避免静默黑屏）
    if (
      !this.decayProg ||
      !this.particleProg ||
      !this.compositeProg
    ) {
      console.error(
        "GLParticleRenderer: 着色器初始化失败，退回 Canvas2D 渲染",
      );
      this.ok = false;
      return;
    }

    // 合成用独立 VAO（位置 + uv 各用动态缓冲，每帧更新）
    this.compositeVao = gl.createVertexArray();
    gl.bindVertexArray(
      this.compositeVao,
    );
    this._compPosBuf = gl.createBuffer();
    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      this._compPosBuf,
    );
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(
        8,
      ),
      gl.DYNAMIC_DRAW,
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
    this._compUvBuf = gl.createBuffer();
    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      this._compUvBuf,
    );
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(
        8,
      ),
      gl.DYNAMIC_DRAW,
    );
    gl.enableVertexAttribArray(
      1,
    );
    gl.vertexAttribPointer(
      1,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.bindVertexArray(
      null,
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
        "GL program link error:",
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
        "GL shader error:",
        gl.getShaderInfoLog(
          s,
      ),
      src,
      );
      return null;
    }
    return s;
  }

  // 重建指定尺寸的帧缓冲（仅在尺寸变化时）
  _ensureFBO(
    size,
  ) {
    const gl = this.gl;
    if (
      this.plateSize ===
      size &&
      this.texA
    )
      return;
    this.plateSize = size;
    this._destroyFBO();
    const make = () => {
      const tex = gl.createTexture();
      gl.bindTexture(
        gl.TEXTURE_2D,
        tex,
      );
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        size,
        size,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      // NEAREST 保留硬边方块；CLAMP 避免边缘采样越界
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.NEAREST,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        gl.NEAREST,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE,
      );
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        fbo,
      );
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        tex,
        0,
      );
      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        null,
      );
      return {
        tex,
        fbo,
      };
    };
    const a = make();
    this.texA = a.tex;
    this.trailA = a.fbo;
    const b = make();
    this.texB = b.tex;
    this.trailB = b.fbo;
  }

  _destroyFBO() {
    const gl = this.gl;
    if (
      this.texA
    )
      gl.deleteTexture(
        this.texA,
      );
    if (
      this.trailA
    )
      gl.deleteFramebuffer(
        this.trailA,
      );
    if (
      this.texB
    )
      gl.deleteTexture(
        this.texB,
      );
    if (
      this.trailB
    )
      gl.deleteFramebuffer(
        this.trailB,
      );
    this.texA =
      this.trailA =
      this.texB =
      this.trailB =
        null;
  }

  // 设置画布与板尺寸。W/H 为窗口像素（合成目标），plateSize 为板内 FBO 分辨率。
  resize(
    W,
    H,
    plateSize,
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
    this._ensureFBO(
      Math.max(
        2,
        plateSize,
      ),
    );
  }

  // 主渲染：把 records（[{nx,ny,g,c,a}]，FBO 裁剪坐标）绘制并合成到屏幕。
  // opts: { plateX, plateY, plateSize, shakeX, shakeY, decay }
  render(
    records,
    opts,
  ) {
    if (
      !this.ok
    )
      return;
    const gl = this.gl;
    const size = this.plateSize;
    const decay =
      opts.decay != null
        ? opts.decay
        : 0.88;

    // --- Pass 1: 衰减上一帧到 trailB ---
    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      this.trailB,
    );
    gl.viewport(
      0,
      0,
      size,
      size,
    );
    gl.disable(
      gl.BLEND,
    );
    gl.useProgram(
      this.decayProg,
    );
    gl.activeTexture(
      gl.TEXTURE0,
    );
    gl.bindTexture(
      gl.TEXTURE_2D,
      this.texA,
    );
    gl.uniform1i(
      gl.getUniformLocation(
        this.decayProg,
        "uTex",
      ),
      0,
    );
    gl.uniform1f(
      gl.getUniformLocation(
        this.decayProg,
        "uDecay",
      ),
      decay,
    );
    gl.bindVertexArray(
      this.quadVao,
    );
    gl.drawArrays(
      gl.TRIANGLE_STRIP,
      0,
      4,
    );

    // --- Pass 2: 叠加新粒子（加色混合）---
    if (
      records.length >
      0
    ) {
      const n = records.length;
      const need =
        n *
        this._stride;
      if (
        !this._data ||
        this._data.length < need
      ) {
        // 留 20% 余量，避免频繁重分配
        this._data = new Float32Array(
          Math.ceil(
            need * 1.2,
          ),
        );
      }
      const d = this._data;
      for (
        let i = 0;
        i < n;
        i++
      ) {
        const r =
          records[
            i
          ];
        const o = i * this._stride;
        d[
          o
        ] = r.nx;
        d[
          o + 1
        ] = r.ny;
        d[
          o + 2
        ] =
          r.g >
          this.maxPointSize
            ? this.maxPointSize
            : r.g;
        d[
          o + 3
        ] = r.c;
        d[
          o + 4
        ] = r.a;
      }
      gl.bindBuffer(
        gl.ARRAY_BUFFER,
        this.partBuf,
      );
      gl.bufferData(
        gl.ARRAY_BUFFER,
        d.subarray(
          0,
          need,
        ),
        gl.DYNAMIC_DRAW,
      );
      gl.enable(
        gl.BLEND,
      );
      gl.blendFunc(
        gl.ONE,
        gl.ONE,
      );
      gl.useProgram(
        this.particleProg,
      );
      gl.bindVertexArray(
        this.partVao,
      );
      gl.drawArrays(
        gl.POINTS,
        0,
        n,
      );
    }

    // 交换：trailB（最新）成为下一帧的 trailA
    const tTex = this.texA;
    this.texA = this.texB;
    this.texB = tTex;
    const tFbo = this.trailA;
    this.trailA = this.trailB;
    this.trailB = tFbo;

    // --- Pass 3: 合成到屏幕（板区域 + 震动偏移）---
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
    gl.clearColor(
      0,
      0,
      0,
      0,
    );
    gl.clear(
      gl.COLOR_BUFFER_BIT,
    );
    gl.enable(
      gl.BLEND,
    );
    gl.blendFunc(
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.useProgram(
      this.compositeProg,
    );
    gl.activeTexture(
      gl.TEXTURE0,
    );
    gl.bindTexture(
      gl.TEXTURE_2D,
      this.texA,
    );
    gl.uniform1i(
      gl.getUniformLocation(
        this.compositeProg,
        "uTex",
      ),
      0,
    );

    // 计算屏幕板矩形（含震动）并映射 uv：屏幕顶 → uv.t=1（对应 FBO t=1=板顶）
    const px =
      opts.plateX +
      (opts.shakeX ||
        0);
    const py =
      opts.plateY +
      (opts.shakeY ||
        0);
    const P = opts.plateSize;
    const cx0 =
      (px / this.W) *
        2 -
      1;
    const cx1 =
      ((px + P) /
        this.W) *
        2 -
      1;
    const cyTop =
      1 -
      (py / this.H) *
        2;
    const cyBot =
      1 -
      ((py + P) /
        this.H) *
        2;
    // 顶点：TL, TR, BL, BR（TRIANGLE_STRIP）
    const quad = new Float32Array(
      [
        cx0,
        cyTop, // TL
        cx1,
        cyTop, // TR
        cx0,
        cyBot, // BL
        cx1,
        cyBot, // BR
      ],
    );
    // uv：TL(0,1) TR(1,1) BL(0,0) BR(1,0)
    const uvs = new Float32Array(
      [
        0, 1, 1, 1, 0, 0, 1, 0,
      ],
    );
    gl.bindVertexArray(
      this.compositeVao,
    );
    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      this._compPosBuf,
    );
    gl.bufferData(
      gl.ARRAY_BUFFER,
      quad,
      gl.DYNAMIC_DRAW,
    );
    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      this._compUvBuf,
    );
    gl.bufferData(
      gl.ARRAY_BUFFER,
      uvs,
      gl.DYNAMIC_DRAW,
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
