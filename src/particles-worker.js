// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

// ============================================================
//  ParticlesWorker — CPU 沙粒路径的后台线程
//  把「JS 粒子物理 + 渲染记录打包 + WebGL2 沙粒层绘制」整体搬离主线程：
//  主线程只保留音频分析、界面刷新、底板节线层，沙粒再重也不会卡住交互。
//
//  能力要求（任一不满足则主线程自动回退到原有同线程路径）：
//   · Module Worker（new Worker(url, { type: "module" })）
//   · OffscreenCanvas（HTMLCanvasElement.transferControlToOffscreen）
//   · Worker 内可创建 WebGL2 上下文
//
//  握手流程（主线程 main.js 驱动）：
//   1. probe  → 本线程用 1×1 OffscreenCanvas 试探 WebGL2，回报能力
//   2. init   → 主线程确认可用后才把 #glcanvas 的控制权转移过来
//   3. frame  → 每帧参数（音频/模式/布局），本线程算物理并直接上屏
//              完成后回 frame-done，主线程据此做背压控制（不堆积消息）
//
//  依赖模块 particles.js / render-gl.js / particle-records.js / chladni.js
//  均无 DOM 依赖，可直接在 Worker 中运行。
// ============================================================

import { ParticleSystem } from "./particles.js";
import { GLParticleRenderer } from "./render-gl.js";
import { buildParticleRecords } from "./particle-records.js";
import {
  packedHeight,
  packedGrad,
  defaultPackedSpec,
  centerExcitation,
  inShapeXY,
} from "./chladni.js";

let sys = null;
let glp = null;
let viewW = 0;
let viewH = 0;
let viewPlate = 1;

// 复用的模式参数与 field 对象：每帧只改字段，不重新分配闭包。
// spec 为主线程传来的打包 ModeSpec（62 个 float），位移场完全由它决定，
// 与 WebGPU / WebGL 着色器使用的是同一份数据与同一套公式。
const M = {
  blendT: 1,
  spec: defaultPackedSpec(),
};

// 当前底板形状（由主线程每帧同步），仅用于粒子的形状约束（越形回收）
let curShape = "square";

const field = {
  psiAt: (u, v) => packedHeight(M.spec, u, v, M.blendT),
  gradAt: (u, v) => packedGrad(M.spec, u, v, M.blendT),
  vibration: 0,
  treble: 0,
  kick: 0,
  plateLimit: 0.97,
  collideR: 0.006,
  // 震源在中间：板心激励最强、向四周传播衰减
  excAt: centerExcitation,
  vibRate: 1,
  motionGain: 1,
  // 居中坐标是否落在形状内（粒子约束）
  inShapeAt: (x, y) => inShapeXY(x, y, curShape),
};

// 复用的渲染参数对象
const recParams = {
  plateSize: 1,
  grainPx: 1,
  blendT: 1,
  spec: null,
};
const renderOpts = {
  plateX: 0,
  plateY: 0,
  plateSize: 1,
  shakeX: 0,
  shakeY: 0,
};
const EMPTY = [];

// 试探本线程能否创建 WebGL2 上下文（在转移真实画布之前先问一遍，
// 避免转移后才发现不支持——画布一旦转移就再也拿不回主线程了）
function probeWebGL2() {
  try {
    if (typeof OffscreenCanvas === "undefined") return false;
    const probe = new OffscreenCanvas(1, 1);
    const gl = probe.getContext("webgl2");
    return !!gl;
  } catch (e) {
    return false;
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case "probe": {
      self.postMessage({
        type: "probe",
        webgl2: probeWebGL2(),
      });
      break;
    }

    case "init": {
      let ok = false;
      try {
        sys = new ParticleSystem(msg.count);
        // 构造函数只记录数量，需 reset 才真正生成粒子
        sys.reset();
        glp = new GLParticleRenderer(msg.canvas);
        ok = !!(glp && glp.ok);
        if (ok) {
          viewW = msg.W;
          viewH = msg.H;
          viewPlate = msg.plateSize;
          glp.resize(viewW, viewH, viewPlate);
        }
      } catch (err) {
        ok = false;
      }
      self.postMessage({
        type: "ready",
        ok,
      });
      break;
    }

    case "resize": {
      viewW = msg.W;
      viewH = msg.H;
      viewPlate = msg.plateSize;
      if (glp && glp.ok) glp.resize(viewW, viewH, viewPlate);
      break;
    }

    case "count": {
      if (sys) sys.setCount(msg.count);
      break;
    }

    case "reset": {
      if (sys) sys.reset();
      break;
    }

    case "shape": {
      if (sys) sys.setShape(msg.shape);
      curShape = msg.shape || "square";
      break;
    }

    case "frame": {
      if (!sys) {
        self.postMessage({ type: "frame-done" });
        break;
      }
      M.blendT = msg.blendT;
      if (msg.spec && msg.spec.length >= 62) M.spec = msg.spec;
      curShape = msg.shape || "square";
      field.vibration = msg.vibration;
      field.treble = msg.treble;
      field.kick = msg.kick;
      field.vibRate = msg.vibRate;
      field.motionGain = msg.motionGain;
      field.plateLimit = msg.plateLimit;
      field.collideR = msg.collideR > 0 ? msg.collideR : 0.006;

      sys.update(msg.dt, field, msg.collision);

      if (glp && glp.ok) {
        renderOpts.plateX = msg.plateX;
        renderOpts.plateY = msg.plateY;
        renderOpts.plateSize = msg.plateSize;
        if (msg.showParticles) {
          recParams.plateSize = msg.plateSize;
          recParams.grainPx = msg.grainPx;
          recParams.blendT = msg.blendT;
          recParams.spec = M.spec;
          glp.render(
            buildParticleRecords(sys.particles, recParams),
            renderOpts,
          );
        } else {
          // 隐藏沙粒：仍需渲染空帧让残影衰减，避免旧画面残留
          glp.render(EMPTY, renderOpts);
        }
      }

      self.postMessage({ type: "frame-done" });
      break;
    }

    default:
      break;
  }
};
