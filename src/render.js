// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  Renderer — 画布渲染
//  负责：离屏缓冲、克拉尼纹理图、粒子绘制、音频辉光
//  黑白极客风：纯黑板 + 白色节线 + 白色粒子
// ============================================================

import {
  blendedHeight,
} from "./chladni.js";

// 沙粒硬边正方形核：整块 g×g 权重恒为 1 → 无柔化、无圆角截断，纯硬边方块。
// 按粒度 g (1..12) 预计算并缓存，避免热循环里重复分配。
const _grainKernels = {};
function getGrainKernel(
  g,
) {
  const cached =
    _grainKernels[
      g
    ];
  if (
    cached
  )
    return cached;
  const arr = new Float32Array(
    g *
      g,
  );
  arr.fill(
    1,
  );
  _grainKernels[
    g
  ] =
    arr;
  return arr;
}

// 高亮沙粒用的硬边正方形精灵（纯白实心方块），按 g 缓存
const _grainSprites = {};
function getGrainSprite(
  g,
) {
  const cached =
    _grainSprites[
      g
    ];
  if (
    cached
  )
    return cached;
  const s =
    Math.max(
      1,
      g,
    );
  const cv =
    document.createElement(
      "canvas",
    );
  cv.width =
    s;
  cv.height =
    s;
  const c =
    cv.getContext(
      "2d",
    );
  c.fillStyle =
    "#fff";
  c.fillRect(
    0,
    0,
    s,
    s,
  );
  _grainSprites[
    g
  ] =
    cv;
  return cv;
}

export class Renderer {
  constructor(
    canvas,
    glParticles,
    glPlate,
  ) {
    this.canvas = canvas;
    this.ctx =
      canvas.getContext(
        "2d",
      );
    // 可选 GPU 粒子渲染器（WebGL2）；为 null 或不支持时退回 CPU 路径
    this.glParticles = glParticles || null;
    // 可选 GPU 底板+节线渲染器（WebGL2 片元着色器）；为 null 或不支持时
    // 退回 Canvas2D 节线纹理
    this.glPlate = glPlate || null;
    this.patternCanvas = null;
    this.patternCtx = null;
    this.offCanvas = null;
    this.offCtx = null;
    this.offImgData = null;
    this._lastPatternTime = 0;
    this._lastPatternM = -999;
    this._lastPatternN = -999;
  }

  // 窗口尺寸变化时重建离屏缓冲
  resize(
    W,
    H,
    plateSize,
    plateX,
    plateY,
  ) {
    this.W = W;
    this.H = H;
    // 必须为整数：离屏缓冲的 width / createImageData 会向下取整，
    // 而粒子写入索引以 plateSize 作行跨距；两者不一致会产生对角线漂移亮线。
    this.plateSize = Math.floor(plateSize);
    this.plateX = plateX;
    this.plateY = plateY;

    // 克拉尼纹理图：按板实际像素渲染，仅设上限保护超大屏性能。
    // 旧实现固定 256px 再拉伸到板——全屏板变大时拉伸倍数过高，
    // 白色节线明显发糊。改为尽量 1:1 贴合板尺寸，全屏节线即清晰。
    const size =
      Math.min(
        1024,
        Math.floor(
          plateSize,
        ),
      );
    this.patternCanvas =
      document.createElement(
        "canvas",
      );
    this.patternCanvas.width =
      size;
    this.patternCanvas.height =
      size;
    this.patternCtx =
      this.patternCanvas.getContext(
        "2d",
      );

    this.offCanvas =
      document.createElement(
        "canvas",
      );
    this.offCanvas.width =
      plateSize;
    this.offCanvas.height =
      plateSize;
    this.offCtx =
      this.offCanvas.getContext(
        "2d",
      );
    this.offImgData =
      this.offCtx.createImageData(
        plateSize,
        plateSize,
      );

    this._lastPatternM = -999;
    this._lastPatternN = -999;

    // 同步 GPU 粒子缓冲尺寸（不支持时 glParticles.ok=false，内部自行跳过）
    if (
      this.glParticles
    )
      this.glParticles.resize(
        W,
        H,
        this.plateSize,
      );
    // 同步 GPU 底板+节线画布尺寸（不支持时 glPlate.ok=false，内部自行跳过）
    if (
      this.glPlate
    )
      this.glPlate.resize(
        W,
        H,
      );
  }

  // 重算克拉尼纹理（仅在 dirty 且离上次超过 60ms 时）
  // GPU 底板激活时跳过：节线由片元着色器全分辨率实时绘制，无需 CPU 纹理
  maybeUpdatePattern(
    state,
    now,
  ) {
    if (
      this.glPlate &&
      this.glPlate.ok
    )
      return;
    if (
      !state.showPattern
    )
      return;
    const moved =
      Math.abs(
        state.currentM -
          this._lastPatternM,
      ) +
      Math.abs(
        state.currentN -
          this._lastPatternN,
      );
    if (
      !state.patternDirty &&
      moved <
        0.02
    )
      return;
    if (
      now -
        this._lastPatternTime <
      60
    )
      return; // 节流，避免逐帧重算
    this._updatePatternTexture(
      state,
    );
    this._lastPatternTime =
      now;
    this._lastPatternM =
      state.currentM;
    this._lastPatternN =
      state.currentN;
    state.patternDirty = false;
  }

  // 逐像素计算克拉尼 ψ → 黑白纹理
  _updatePatternTexture(
    state,
  ) {
    const size =
      this.patternCanvas.width;
    const imageData =
      this.patternCtx.createImageData(
        size,
        size,
      );
    const data =
      imageData.data;
    const halfS =
      size - 1;
    // 整数模式 + 高度场交叉淡入 → 任意时刻图形都中心对称
    const pm =
      state.prevM;
    const pn =
      state.prevN;
    const m =
      state.currentM;
    const n =
      state.currentN;
    const t =
      state.blendT;

    for (
      let py = 0;
      py <
      size;
      py++
    ) {
      const y =
        py /
        halfS;
      for (
        let px = 0;
        px <
        size;
        px++
      ) {
        const x =
          px /
          halfS;
        const edgeDistance =
          Math.min(
            x,
            1 - x,
            y,
            1 - y,
          );
        const h =
          blendedHeight(
            x,
            y,
            pm,
            pn,
            m,
            n,
            t,
          );
        const lineStrength =
          Math.exp(
            -(h *
              h) *
              220,
          );
        const interiorMask =
          Math.max(
            0,
            Math.min(
              1,
              (edgeDistance -
                0.035) /
                0.03,
            ),
          );
        const val =
          Math.round(
            lineStrength *
              interiorMask *
              255,
          );
        const idx =
          (py *
            size +
            px) *
          4;
        data[
          idx
        ] =
          val;
        data[
          idx +
            1
        ] =
          val;
        data[
          idx +
            2
        ] =
          val;
        data[
          idx +
            3
        ] =
          255;
      }
    }
    this.patternCtx.putImageData(
      imageData,
      0,
      0,
    );
  }

  // 纯黑背景（每帧最先绘制，保证底层始终为黑，露出上方透明 GPU 层）
  drawBackground() {
    this.ctx.fillStyle =
      "#000";
    this.ctx.fillRect(
      0,
      0,
      this.W,
      this.H,
    );
  }

  // 主绘制
  draw(
    state,
    particles,
  ) {
    const ctx =
      this.ctx;
    // 纯黑背景
    ctx.fillStyle =
      "#000";
    ctx.fillRect(
      0,
      0,
      this.W,
      this.H,
    );

    // 中心固定轴物理：板由中心螺栓夹持在立轴上，振动为横向（垂直板面），
    // 俯视图中板体没有任何平移分量 → 不做整板平移抖动。
    const shakeX = 0;
    const shakeY = 0;

    ctx.save();

    // GPU 底板激活时始终调用 render（内部在 !showPattern 时清成透明，
    // 避免节线开关关闭后残留旧画面）；否则退回 Canvas2D 节线纹理
    if (
      this.glPlate &&
      this.glPlate.ok
    ) {
      this.glPlate.render(
        state,
        this.plateX,
        this.plateY,
        this.plateSize,
      );
    } else if (
      state.showPattern
    ) {
      this._drawPlate(
        state,
      );
    }
    // 始终调用：GPU 路径在隐藏时需主动衰减清屏，不能依赖外层 guard
    this._drawParticles(
      state,
      particles,
      shakeX,
      shakeY,
      state.showParticles,
    );
    ctx.restore();
  }

  // 绘制克拉尼板（纯黑 + 白色节线纹理）
  _drawPlate(
    state,
  ) {
    const ctx =
      this.ctx;
    const x =
      this.plateX;
    const y =
      this.plateY;
    const s =
      this.plateSize;
    ctx.fillStyle =
      "#000";
    ctx.fillRect(
      x,
      y,
      s,
      s,
    );
    if (
      this.patternCanvas
    ) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        x,
        y,
        s,
        s,
      );
      ctx.clip();
      ctx.drawImage(
        this.patternCanvas,
        x,
        y,
        s,
        s,
      );
      ctx.restore();
    }
  }

  // 绘制粒子：ImageData 单像素写入 + 少量 2px 高亮
  _drawParticles(
    state,
    particles,
    shakeX,
    shakeY,
    showParticles,
  ) {
    const ctx =
      this.ctx;
    const plateX =
      this.plateX;
    const plateY =
      this.plateY;
    const plateSize =
      this.plateSize;
    const halfPlate =
      plateSize / 2;
    const cx =
      plateX +
      halfPlate;
    const cy =
      plateY +
      halfPlate;
    const scale =
      halfPlate;

    const glp = this.glParticles;
    const useGL =
      !!(
        glp &&
        glp.ok
      );

    // 隐藏沙粒：GPU 路径需主动衰减清屏，避免旧画面残留
    if (
      !showParticles
    ) {
      if (
        useGL
      )
        glp.render(
          [],
          {
            plateX,
            plateY,
            plateSize,
            shakeX,
            shakeY,
          },
        );
      return;
    }

    const data =
      this.offImgData.data;
    // 残影衰减（仅 CPU 降级路径需要；GPU 由着色器 pass 完成）
    if (
      !useGL
    ) {
      for (
        let idx = 0;
        idx <
        data.length;
        idx += 4
      ) {
        data[
          idx
        ] =
          (data[
            idx
          ] *
            0.85) |
          0;
        data[
          idx +
            1
        ] =
          (data[
            idx +
              1
          ] *
            0.85) |
          0;
        data[
          idx +
            2
        ] =
          (data[
            idx +
              2
          ] *
            0.85) |
          0;
        data[
          idx +
            3
        ] =
          (data[
            idx +
              3
          ] *
            0.92) |
          0;
      }
    }

    const m =
      state.currentM;
    const n =
      state.currentN;
    const liveParticles =
      [];
    // GPU 路径收集渲染记录：FBO 裁剪坐标 + 亮度/透明度
    const glRecs =
      useGL
        ? []
        : null;

    for (
      let i = 0;
      i <
      particles.length;
      i++
    ) {
      const p =
        particles[
          i
        ];
      const px =
        Math.floor(
          cx +
            p.x *
              scale -
            plateX,
        );
      const py =
        Math.floor(
          cy +
            p.y *
              scale -
            plateY,
        );

      if (
        px <
          1 ||
        px >=
          plateSize -
            1 ||
        py <
          1 ||
        py >=
          plateSize -
            1
      )
        continue;

      const settled =
        p.settled;
      const speed =
        Math.sqrt(
          p.vx *
            p.vx +
            p.vy *
              p.vy,
        );
      // 腾空跳跃中的沙粒轻微提亮（跳-停模型：静止时 speed=0，小跳时 0.3~10）
      const movingBoost =
        Math.min(
          speed / 6,
          1,
        ) *
        0.3;
      const edgeDistance =
        Math.min(
          1 -
            Math.abs(
              p.x,
            ),
          1 -
            Math.abs(
              p.y,
            ),
        );
      const edgeMask =
        Math.max(
          0,
          Math.min(
            1,
            (edgeDistance -
              0.065) /
              0.06,
          ),
        );
      if (
        edgeMask <=
        0
      )
        continue;

      const u =
        (p.x +
          1) *
        0.5;
      const v =
        (p.y +
          1) *
        0.5;
      const h =
        blendedHeight(
          u,
          v,
          state.prevM,
          state.prevN,
          m,
          n,
          state.blendT,
        );
      const nodeAffinity =
        Math.exp(
          -(h *
            h) *
            110,
        );

      // 堆叠密度归一化：density 为碰撞阶段统计的近邻数（0=孤立），
      // 约 6 个近邻即视为"紧密堆积"，映射为 0~1 的密度增强因子。
      const densN =
        p.density > 0
          ? Math.min(
              1,
              p.density /
                6,
            )
          : 0;

      const brightness =
        p.brightness *
        (0.52 +
          nodeAffinity *
            0.96 +
          movingBoost *
            0.12) *
        (0.2 +
          edgeMask *
            0.8) *
        // 密集堆积的沙粒更亮（沙堆高光感）
        (1 +
          densN *
            0.5);
      const val =
        Math.floor(
          Math.min(
            255,
            brightness *
              235 +
              20,
          ),
        );
      const alpha =
        Math.min(
          1,
          0.18 +
            nodeAffinity *
              0.62 +
            settled *
              0.22 +
            movingBoost *
              0.08 +
            // 密集堆积的沙粒更实（不透明）
            densN *
              0.18,
        ) *
        edgeMask;

      // 真实物理尺寸：grainPx（浮点）由 plateCm / grainMm / 屏幕比例推导；
      // 再按每颗沙粒的直径因子 sizeF 缩放 → 大小沙粒在板上显出尺寸差异。
      // gf 保持浮点：GPU 的 gl_PointSize 支持连续尺寸（板尺寸变化零跳变）；
      // CPU 路径才逐粒取整——因每颗 sizeF 不同，舍入阈值被抖散到整个粒群，
      // 不会出现全体同时跳档的突变。
      // 严格等比例：不设人为上限（旧 [1,12] clamp 会让大沙粒/小底板时
      // 渲染尺寸封顶，破坏沙粒与底板的物理比例）。
      // GPU 路径用浮点 gf；CPU 路径最小 1px（像素离散化的物理下限）。
      // 密集堆积的沙粒略大（沙堆体积感）。
      const gf =
        (state.grainPx ||
          1) *
        (p.sizeF ||
          1) *
        (1 +
          densN *
            0.4);
      const g =
        Math.max(
          1,
          Math.round(
            gf,
          ),
        );
      // 亚像素等比例补偿：gf<1 时硬件最小只能画 1px，
      // 按真实面积覆盖率 gf² 衰减透明度 → 视觉重量仍与物理尺寸成正比
      const subPx =
        gf < 1
          ? gf * gf
          : 1;

      // 高亮额外亮度（原 CPU 第二 pass 的 globalAlpha）
      const highlight =
        0.12 +
        nodeAffinity *
          0.34 +
        edgeMask *
          0.12 +
        settled *
          0.12 +
        movingBoost *
          0.08;

      if (
        useGL
      ) {
        // 折叠高亮到颜色/透明度，GPU 加色混合即可还原层次
        const c =
          Math.min(
            1,
            val /
              255 +
              highlight,
          );
        const a =
          Math.min(
            1,
            alpha +
              highlight,
          ) * subPx;
        // FBO 裁剪坐标：板顶(py=0) → clipY=+1
        const nx =
          (px + 0.5) /
            plateSize *
            2 -
          1;
        const ny =
          1 -
          (py + 0.5) /
            plateSize *
            2;
        glRecs.push(
          {
            nx,
            ny,
            g: gf, // 浮点尺寸 → gl_PointSize 连续变化，无取整跳变
            c,
            a,
          },
        );
        continue;
      }

      liveParticles.push(
        {
          px,
          py,
          g,
          nodeAffinity,
          edgeMask,
          settled,
          movingBoost,
          subPx,
        },
      );

      // 按 g×g 硬边正方形核写入离屏缓冲（整块权重恒为 1 → 纯硬边方块）
      const kernel =
        getGrainKernel(
          g,
        );
      for (
        let gy = 0;
        gy < g;
        gy++
      ) {
        const rowY =
          py + gy;
        if (
          rowY <
            0 ||
          rowY >=
            plateSize
        )
          continue;
        for (
          let gx = 0;
          gx < g;
          gx++
        ) {
          const weight =
            kernel[
              gy *
                g +
                gx
            ];
          // 硬边方块：权重恒为 1，不再做圆角截断或柔边衰减
          if (
            weight <=
            0
          )
            continue;
          const colX =
            px + gx;
          if (
            colX <
              0 ||
            colX >=
              plateSize
          )
            continue;
          const idx =
            (rowY *
              plateSize +
              colX) *
            4;
          const a =
            alpha *
            subPx *
            weight;
          const add =
            Math.floor(
              val * a,
            );
          data[
            idx
          ] =
            Math.min(
              255,
              data[
                idx
              ] +
                add,
            );
          data[
            idx +
              1
          ] =
            Math.min(
              255,
              data[
                idx +
                  1
              ] +
                add,
            );
          data[
            idx +
              2
          ] =
            Math.min(
              255,
              data[
                idx +
                  2
              ] +
                add,
            );
          data[
            idx +
              3
          ] =
            Math.min(
              255,
              data[
                idx +
                  3
              ] +
                Math.floor(
                  a * 255,
                ),
            );
        }
      }
    }

    if (
      useGL
    ) {
      glp.render(
        glRecs,
        {
          plateX,
          plateY,
          plateSize,
          shakeX,
          shakeY,
        },
      );
      return;
    }

    this.offCtx.putImageData(
      this.offImgData,
      0,
      0,
    );
    ctx.drawImage(
      this.offCanvas,
      plateX,
      plateY,
    );

    // 高亮 2px 粒子（靠近节线的最亮粒子）
    ctx.fillStyle =
      "#ffffff";
    for (
      let i = 0;
      i <
      liveParticles.length;
      i++
    ) {
      const particle =
        liveParticles[
          i
        ];
      ctx.globalAlpha =
        Math.min(
          0.7,
          particle.nodeAffinity *
            0.34 +
            particle.edgeMask *
            0.12 +
            particle.settled *
            0.12 +
            particle.movingBoost *
            0.08 +
            0.12,
        ) *
        (particle.subPx ||
          1);
      // 硬边方形精灵（纯白实心方块）
      ctx.drawImage(
        getGrainSprite(
          particle.g,
        ),
        plateX +
          particle.px,
        plateY +
          particle.py,
      );
    }
    ctx.globalAlpha = 1;
  }
}
