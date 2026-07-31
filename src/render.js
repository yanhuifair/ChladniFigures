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
import {
  buildParticleRecords,
  recPixelX,
  recPixelY,
  REC_STRIDE,
} from "./particle-records.js";

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

    // --- 批量生成渲染记录（打包 Float32Array，零对象分配）---
    // 逐粒亮度/透明度/尺寸的计算已抽到 particle-records.js：
    //  · 波场高度改用 field-grid 双线性采样（原本每粒 2 次 triangular function）
    //  · 结果直接写入复用缓冲，不再每帧生成十万个临时对象
    //  · 高亮折叠进颜色与透明度，Canvas2D 回退不再需要第二遍 drawImage
    const recs =
      buildParticleRecords(
        particles,
        {
          plateSize,
          grainPx:
            state.grainPx,
          prevM:
            state.prevM,
          prevN:
            state.prevN,
          curM:
            state.currentM,
          curN:
            state.currentN,
          blendT:
            state.blendT,
        },
      );

    if (
      useGL
    ) {
      glp.render(
        recs,
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

    // --- Canvas2D 回退：按打包记录写离屏 ImageData ---
    const rd =
      recs.data;
    const rn =
      recs.count;
    for (
      let i = 0,
        o = 0;
      i < rn;
      i++,
        o += REC_STRIDE
    ) {
      const c =
        rd[o + 3];
      const a =
        rd[o + 4];
      const add =
        (c *
          255 *
          a) |
        0;
      if (
        add <= 0
      )
        continue;
      const aByte =
        (a * 255) |
        0;
      const px =
        recPixelX(
          rd[o],
          plateSize,
        );
      const py =
        recPixelY(
          rd[o + 1],
          plateSize,
        );
      const gf =
        rd[o + 2];
      const g =
        gf < 1
          ? 1
          : Math.round(
              gf,
            );

      if (
        g === 1
      ) {
        // 单像素快路径：grainPx≤1 时占绝大多数，直接写一个像素
        const idx =
          (py *
            plateSize +
            px) *
          4;
        let t =
          data[idx] +
          add;
        data[idx] =
          t > 255
            ? 255
            : t;
        t =
          data[
            idx + 1
          ] + add;
        data[
          idx + 1
        ] =
          t > 255
            ? 255
            : t;
        t =
          data[
            idx + 2
          ] + add;
        data[
          idx + 2
        ] =
          t > 255
            ? 255
            : t;
        t =
          data[
            idx + 3
          ] + aByte;
        data[
          idx + 3
        ] =
          t > 255
            ? 255
            : t;
        continue;
      }

      // g×g 硬边正方形块（权重恒为 1 → 纯硬边方块，无柔化）
      for (
        let gy = 0;
        gy < g;
        gy++
      ) {
        const rowY =
          py + gy;
        if (
          rowY < 0 ||
          rowY >=
            plateSize
        )
          continue;
        const rowBase =
          rowY *
          plateSize;
        for (
          let gx = 0;
          gx < g;
          gx++
        ) {
          const colX =
            px + gx;
          if (
            colX < 0 ||
            colX >=
              plateSize
          )
            continue;
          const idx =
            (rowBase +
              colX) *
            4;
          let t =
            data[idx] +
            add;
          data[idx] =
            t > 255
              ? 255
              : t;
          t =
            data[
              idx + 1
            ] + add;
          data[
            idx + 1
          ] =
            t > 255
              ? 255
              : t;
          t =
            data[
              idx + 2
            ] + add;
          data[
            idx + 2
          ] =
            t > 255
              ? 255
              : t;
          t =
            data[
              idx + 3
            ] + aByte;
          data[
            idx + 3
          ] =
            t > 255
              ? 255
              : t;
        }
      }
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
  }
}
