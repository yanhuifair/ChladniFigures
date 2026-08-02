// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  main.js — 应用编排与渲染主循环
//  频谱 → 连续 (m,n) 实时映射，让克拉尼图形随音乐变形
// ============================================================

import {
  clamp,
  blendedHeight,
  blendedHeightGradient,
  centerExcitation,
  freqToMode,
  modeToFreq,
} from "./chladni.js";
import {
  AudioEngine,
} from "./audio.js";
import {
  ParticleSystem,
} from "./particles.js";
import {
  Renderer,
} from "./render.js";
import {
  GLParticleRenderer,
} from "./render-gl.js";
import {
  GLPlateRenderer,
} from "./render-plate-gl.js";
import {
  createWebGPUParticles,
} from "./webgpu-particles.js";
import {
  setupUI,
} from "./ui.js";
import {
  t,
  applyStaticI18n,
} from "./i18n.js";

// 应用版本号（与 package.json 保持一致），显示在 INFO 板块底部
const APP_VERSION = "2.7.2";

// --- 全局状态 ---
const state = {
  W: 0,
  H: 0,
  plateSize: 0,
  plateX: 0,
  plateY: 0,
  fullscreen: false, // 全屏模式：隐藏所有 UI，底板铺满窗口

  // 模式参数：currentM/N 恒为整数（保证图形中心对称），
  // 切换时用 prev→current 两个整数模式的高度场按 blendT 交叉淡入
  currentM: 3,
  currentN: 4,
  prevM: 3,
  prevN: 4,
  blendT: 1, // 0→1 过渡进度，1 = 完全切到 current
  desiredM: 3, // 频谱连续目标值（仅用于带滞回的整数量化）
  desiredN: 4,

  selectedMode: "auto",
  audioSource: "sim",
  showParticles: true,
  showPattern: false,
  collision: false, // 颗粒间短程斥力（解开重叠、堆成有宽度的沙带）；默认关，去掉碰撞

  particleCount: 10000,

  // 物理参数（真实量纲）
  plateCm: 40, // 底板边长（真实物理尺寸，单位 cm）
  plateStiffness: 1, // 底板硬度系数（相对基准 1.0；∝ 杨氏模量 √E）
  grainMm: 0.5, // 沙粒真实直径（单位 mm）
  grainPx: 1, // 渲染像素尺寸（由 plateCm/grainMm/屏幕比例推导）
  pxPerCm: 15, // 当前屏幕上 1cm 对应的像素数

  simFreq: 440,
  simSound: true, // 是否发出 SIM 振荡器纯音（可在 SIM 频率条下方开关）
  displayFreq: 440,
  detectedFreq: 0,
  vibrationAmplitude: 0,
  vibrationFreq: 0, // 底板实际振动频率（由当前模式 + 尺寸 + 硬度推导，Hz）
  vibRate: 1, // 振动频率→跳动节律因子（硬度↑→>1，沙粒被抛起更频繁）
  simTime: 0, // 模拟累计时间（驱动板面周期性震动，频率随硬度变化）
  modeKickEnergy: 0,
  volumeLevel: 0, // 真实响度（0~1）：驱动整体运动强度，音量越大图形移动越剧烈
  volGain: 1, // 音量后期增强（0.1~10）：只放大增幅（抛速/弹起高度），不影响振动频率/抛起频次

  patternDirty: true,

  // 来自音频引擎的实时频谱
  spectrum: {
    bass: 0,
    mid: 0,
    treble: 0,
    overall: 0,
    dominantFreq: 0,
  },

  // MIDI 状态文本（供 UI 显示）
  midiStatusMsg: "",
};

const STORAGE_KEY =
  "chladni-figures-preferences";
// mic = 系统输入（麦克风等输入设备）；output = 系统输出（电脑正在播放的声音）
// midi = 外接 MIDI 控制器；sim = 数值模拟（可听纯音）
const VALID_SOURCES = new Set(
  [
    "mic",
    "output",
    "sim",
    "midi",
  ],
);
const NUM_PARTICLES = 10000;

// --- 模块实例 ---
const canvas =
  document.getElementById(
    "canvas",
  );
// WebGL2 粒子层（透明叠在 #platecanvas 之上）；不支持时自动退回 CPU 渲染
const glCanvas =
  document.getElementById(
    "glcanvas",
  );
// WebGL2 底板+节线层（透明叠在 #canvas 之上）；不支持时退回 Canvas2D 节线纹理
const plateCanvas =
  document.getElementById(
    "platecanvas",
  );
// 优先尝试 WebGPU：把整条粒子物理+碰撞搬到 GPU（compute + 原子操作），
// 同时拿到海量粒子与沙堆带观感。若浏览器不支持/初始化失败，gpuParticles=null，
// 则退回原 WebGL2+CPU 路径（此时才在 #glcanvas 上创建 WebGL2 上下文）。
// 注意：同一画布只能持有一种上下文，故 WebGPU 占用 #glcanvas 时不再创建 WebGL2。
let gpuParticles = null;
let glParticles = null;
if (
  typeof navigator !==
    "undefined" &&
  navigator.gpu
) {
  try {
    gpuParticles = await createWebGPUParticles(
      glCanvas,
      NUM_PARTICLES,
    );
  } catch (
    e
  ) {
    console.warn(
      "WebGPU 初始化失败，退回 WebGL2+CPU：",
      e,
    );
    gpuParticles = null;
  }
}
// --- CPU 回退路径的后台线程加速（Web Worker + OffscreenCanvas）---
// WebGPU 不可用时，尽量把「JS 粒子物理 + 渲染记录打包 + WebGL2 沙粒绘制」
// 整体搬进 Worker，主线程只留音频分析、界面刷新与底板节线层：
// 十万粒子也不再阻塞交互（滑块/按钮/音频不掉帧）。
// 需要 Module Worker + OffscreenCanvas + Worker 内 WebGL2 三项能力，
// 任一不满足则安静回退到原有同线程路径。
let particleWorker = null;
let workerBusy = false;
let workerFrameAt = 0;

async function tryStartParticleWorker() {
  if (
    typeof Worker ===
      "undefined" ||
    typeof glCanvas.transferControlToOffscreen !==
      "function"
  )
    return null;
  let w;
  try {
    w = new Worker(
      new URL(
        "./particles-worker.js",
        import.meta.url,
      ),
      {
        type: "module",
      },
    );
  } catch (e) {
    return null;
  }

  // 一次性握手：等待指定类型的回包，超时或报错一律视为失败
  const ask = (
    message,
    transfer,
    expect,
    timeout,
  ) =>
    new Promise(
      (
        resolve,
      ) => {
        let done = false;
        const finish = (
          v,
        ) => {
          if (
            done
          )
            return;
          done = true;
          w.removeEventListener(
            "message",
            onMsg,
          );
          w.removeEventListener(
            "error",
            onErr,
          );
          clearTimeout(
            timer,
          );
          resolve(
            v,
          );
        };
        const onMsg = (
          ev,
        ) => {
          if (
            ev.data &&
            ev.data
              .type ===
              expect
          )
            finish(
              ev.data,
            );
        };
        const onErr =
          () =>
            finish(
              null,
            );
        const timer =
          setTimeout(
            () =>
              finish(
                null,
              ),
            timeout,
          );
        w.addEventListener(
          "message",
          onMsg,
        );
        w.addEventListener(
          "error",
          onErr,
        );
        if (
          transfer
        )
          w.postMessage(
            message,
            transfer,
          );
        else
          w.postMessage(
            message,
          );
      },
    );

  // 先问 Worker 能不能创建 WebGL2（用 1×1 临时 OffscreenCanvas 试探）。
  // 必须先问再转移：画布控制权一旦转移就无法收回主线程。
  const probe =
    await ask(
      {
        type: "probe",
      },
      null,
      "probe",
      2000,
    );
  if (
    !probe ||
    !probe.webgl2
  ) {
    w.terminate();
    return null;
  }

  const off =
    glCanvas.transferControlToOffscreen();
  const ready =
    await ask(
      {
        type: "init",
        canvas: off,
        count:
          NUM_PARTICLES,
        W: window.innerWidth,
        H: window.innerHeight,
        plateSize: 1,
      },
      [
        off,
      ],
      "ready",
      4000,
    );
  if (
    !ready ||
    !ready.ok
  ) {
    w.terminate();
    return null;
  }

  // 背压：只有上一帧算完才发下一帧，避免消息队列堆积导致延迟越拖越长
  w.onmessage = (
    ev,
  ) => {
    if (
      ev.data &&
      ev.data
        .type ===
        "frame-done"
    )
      workerBusy = false;
  };
  w.onerror = (
    err,
  ) => {
    console.warn(
      "粒子 Worker 运行出错：",
      err,
    );
    workerBusy = false;
  };
  return w;
}

if (
  !gpuParticles
) {
  particleWorker =
    await tryStartParticleWorker();
  if (
    !particleWorker
  )
    glParticles = new GLParticleRenderer(
      glCanvas,
    );
}
const glPlate = new GLPlateRenderer(
  plateCanvas,
);
const engine = new AudioEngine();
const particles = new ParticleSystem(
  NUM_PARTICLES,
);
const renderer = new Renderer(
  canvas,
  glParticles,
  glPlate,
);
let ui = null;

// --- 尺寸与板布局 ---
function resize() {
  state.W =
    canvas.width =
      window.innerWidth;
  state.H =
    canvas.height =
      window.innerHeight;
  // 底板：保持正方形，尺寸/位置随网页与底栏自适应。
  // 设计目标：边距尽量为 160；尽量四边等宽。
  //   矩形窗口下无法让四条边距绝对相等，只能用「左右相等、上下相等」的
  //   居中布局（这是「尽量四边等宽」能达到的最好状态）。
  // 做法：在「窗口高度 − 底栏高度」的可用区内取最大正方形，使四边各留
  //   TARGET。较小维度那一对边距恰为 TARGET(=160)，较大维度居中 →
  //   该对边距 > 160 但左右/上下各自相等。
  // 窗口过小放不下 TARGET 时退化为填满可用区（边距 < 160）。
  // 底板尺寸必须整数：离屏缓冲 createImageData 向下取整，而粒子写入
  // 以 plateSize 作行跨距；小数会导致跨距与实际行宽不符（对角亮线 stride bug）。
  // 移动端竖屏：取消 160 大边距，让底板占满网页宽度（仅留极小留白）。
  const isMobilePortrait =
    !state.fullscreen &&
    state.W <= 768 &&
    state.H > state.W;
  const TARGET = state.fullscreen
    ? 0 // 全屏：无边距，底板铺满窗口
    : isMobilePortrait
      ? 4 // 移动端竖屏：极小边距，底板占满网页宽度
      : 160; // 桌面 / 横屏目标边距（尽量 160）
  const MIN_PLATE = 64; // 底板最小边长保护
  const bar =
    document.getElementById(
      "bottomBar",
    );
  const barH =
    state.fullscreen
      ? 0
      : bar
        ? Math.ceil(
            bar.getBoundingClientRect()
              .height,
          )
        : 0;
  const availW =
    state.W;
  const availH =
    state.H - barH; // 底板只能落在三段式底栏之上
  let size =
    Math.min(
      availW - 2 * TARGET,
      // 移动端竖屏：底板顶对齐（仅留极小上边距），高度约束用整段 availH，
      // 让底板按宽度取正方形、紧贴底栏，消除上下大留白。
      isMobilePortrait
        ? availH
        : availH - 2 * TARGET,
    );
  if (
    size <
    MIN_PLATE
  ) {
    // 放不下 TARGET 边距：直接填满可用区（边距会 < 160）
    size =
      Math.max(
        0,
        Math.min(
          availW,
          availH,
        ),
      );
  }
  size =
    Math.max(
      1,
      Math.floor(size),
    );
  state.plateSize = size;
  state.plateX =
    Math.floor(
      (availW - size) /
        2,
    );
  state.plateY =
    isMobilePortrait
      ? TARGET // 移动端竖屏：顶对齐，消除上方留白
      : Math.floor(
          (availH - size) /
            2,
        );
  renderer.resize(
    state.W,
    state.H,
    state.plateSize,
    state.plateX,
    state.plateY,
  );
  // Worker 模式下 #glcanvas 已转移，主线程不能再改它的尺寸，交由 Worker 处理
  if (
    particleWorker
  )
    particleWorker.postMessage(
      {
        type: "resize",
        W: state.W,
        H: state.H,
        plateSize:
          state.plateSize,
      },
    );
  if (
    gpuParticles
  )
    gpuParticles.resize(
      state.W,
      state.H,
    );
  // 不调用 particles.reset()：粒子坐标为归一化 [-1,1]，渲染器按 plateSize
  // 自动缩放；尺寸变化只缩放、不重排，因此全屏/窗口缩放只是纯粹放大底板图像，
  // 不改动任何粒子状态或其他参数。粒子数量变更仍走 setCount()（内部 reset 重建）。
  state.patternDirty = true;
}

// --- 全屏模式：隐藏所有 UI，底板铺满整个窗口 ---
function setFullscreen(
  on,
) {
  state.fullscreen = !!on;
  document.body.classList.toggle(
    "fullscreen",
    state.fullscreen,
  );
  // 隐藏/恢复 UI 后底栏高度变化，resize() 会自动按新可用区重算底板；
  // 这里显式调一次，保证进入全屏瞬间底板立即铺满，无需等下一帧。
  resize();
}
function toggleFullscreen() {
  setFullscreen(
    !state.fullscreen,
  );
}

// --- 偏好持久化 ---
function loadPreferences() {
  try {
    const raw =
      localStorage.getItem(
        STORAGE_KEY,
      );
    if (
      !raw
    )
      return null;
    const p =
      JSON.parse(
        raw,
      );
    return {
      audioSource:
        VALID_SOURCES.has(
          p.audioSource,
        )
          ? p.audioSource
          : p.audioSource ===
              "sys"
            ? "output" // 旧偏好迁移：sys → output
            : "sim",
      simFreq:
        Number.isFinite(
          p.simFreq,
        )
          ? clamp(
              p.simFreq,
              20,
              50000,
            )
          : 440,
      showParticles:
        typeof p.showParticles ===
        "boolean"
          ? p.showParticles
          : true,
      simSound:
        typeof p.simSound ===
        "boolean"
          ? p.simSound
          : true,
      showPattern:
        typeof p.showPattern ===
        "boolean"
          ? p.showPattern
          : false,
      particleCount:
        typeof p.particleCount ===
        "number" &&
        p.particleCount >= 100 &&
        p.particleCount <= 100000
          ? Math.round(
              p.particleCount,
            )
          : 10000,
      plateCm:
        typeof p.plateCm ===
          "number" &&
        p.plateCm >= 5 &&
        p.plateCm <= 100
          ? clamp(
              p.plateCm,
              5,
              100,
            )
          : 40,
      plateStiffness:
        typeof p.plateStiffness ===
          "number" &&
        p.plateStiffness >= 0.2 &&
        p.plateStiffness <= 6
          ? clamp(
              p.plateStiffness,
              0.2,
              6,
            )
          : 1,
      grainMm:
        typeof p.grainMm ===
          "number" &&
        p.grainMm >= 0.05 &&
        p.grainMm <= 5
          ? clamp(
              p.grainMm,
              0.05,
              5,
            )
          : 0.5,
      volGain:
        typeof p.volGain ===
          "number" &&
        p.volGain >= 0.1 &&
        p.volGain <= 10
          ? clamp(
              p.volGain,
              0.1,
              10,
            )
          : 1,
      micDeviceId:
        typeof p.micDeviceId ===
        "string"
          ? p.micDeviceId
          : "",
      outputDeviceId:
        typeof p.outputDeviceId ===
        "string"
          ? p.outputDeviceId
          : "",
    };
  } catch {
    return null;
  }
}

function savePreferences() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        {
          audioSource:
            state.audioSource,
          simFreq:
            state.simFreq,
          showParticles:
            state.showParticles,
          showPattern:
            state.showPattern,
          simSound:
            state.simSound,
          particleCount:
            state.particleCount,
            plateCm:
              state.plateCm,
            plateStiffness:
              state.plateStiffness,
            grainMm:
              state.grainMm,
            volGain:
              state.volGain,
            micDeviceId:
            engine.micDeviceId,
          outputDeviceId:
            engine.outputDeviceId,
        },
      ),
    );
  } catch {
    // 忽略本地存储异常
  }
}

// --- 音源切换 handler ---
async function onSelectSource(
  mode,
) {
  let ok = true;
  if (
    mode !==
    state.audioSource
  ) {
    const prev =
      state.audioSource;
    ok =
      await engine.setSource(
        mode,
      );
    if (
      !ok
    ) {
      // 失败：回到之前的音源并给出明确原因提示（不再静默跳合成音）
      await engine.setSource(
        prev,
      );
      if (
        ui
      ) {
        if (
          mode ===
          "output"
        ) {
          ui.showToast(
            engine.lastError ===
              "no-audio"
              ? t(
                "toast.outputNoAudio",
              )
              : engine.lastError ===
                  "unsupported"
                ? t(
                  "toast.outputUnsupported",
                )
                : t(
                  "toast.outputCancelled",
                ),
          );
        } else if (
          mode ===
          "mic"
        ) {
          ui.showToast(
            t(
              "toast.micUnavailable",
            ),
          );
        } else if (
          mode ===
          "midi"
        ) {
          ui.showToast(
            engine.lastError ===
              "unsupported"
              ? t(
                "toast.midiUnsupported",
              )
              : engine.lastError ===
                  "no-device"
                ? t(
                  "toast.midiNoDevice",
                )
                : t(
                  "toast.midiDenied",
                ),
          );
        }
      }
      return false;
    }
    state.audioSource =
      mode;
    // 切源时踢散，带来新鲜感
    state.modeKickEnergy = 1.0;
    savePreferences();
    if (
      ui &&
      mode ===
        "output"
    ) {
      ui.showToast(
        engine.outputMethod ===
          "loopback"
          ? t(
            "toast.outputLoopback",
          )
          : t(
            "toast.outputDisplay",
          ),
      );
    }
    // 授权成功后设备 label 才可见 → 此时刷新设备列表
    if (
      mode ===
      "mic"
    ) {
      refreshInputDevices();
    } else if (
      mode ===
      "output"
    ) {
      refreshOutputDevices();
    }
  }
  return ok;
}

// --- 输入设备列表刷新（MIC 模式）---
// 识别虚拟回环设备（BlackHole / LarkAudioDevice / Squirrels Audio 等），
// 选中它即可直接从"系统音频输出"取声，无需屏幕共享。
let pendingParticleCount = null;
let loopbackHintShown = false;
async function refreshInputDevices() {
  const devices =
    await engine.listInputDevices();
  if (
    devices.length ===
    0
  )
    return;
  const loopbackIds =
    new Set(
      devices
        .filter(
          (
            d,
          ) =>
            AudioEngine.isLoopbackName(
              d.label,
            ),
        )
        .map(
          (
            d,
          ) =>
            d.deviceId,
        ),
    );
  // 当前实际使用的设备 ID（未指定则取流上的 track 设置）
  let currentId =
    engine.micDeviceId;
  if (
    !currentId &&
    engine.micStream
  ) {
    const track =
      engine.micStream.getAudioTracks()[0];
    if (
      track &&
      track.getSettings
    ) {
      currentId =
        track.getSettings()
          .deviceId ||
        "";
    }
  }
  ui.setInputDevices(
    devices,
    currentId,
    loopbackIds,
  );
  // 检测到回环设备但当前用的是普通麦克风 → 提示一次
  if (
    !loopbackHintShown &&
    loopbackIds.size >
      0 &&
    !loopbackIds.has(
      currentId,
    )
  ) {
    loopbackHintShown = true;
    ui.showToast(
      t(
        "toast.loopbackHint",
      ),
      6500,
    );
  }
}

// --- 系统输出（回环）设备列表刷新（OUTPUT 模式）---
async function refreshOutputDevices() {
  const loopbacks =
    await engine.listLoopbackDevices();
  ui.setOutputDevices(
    loopbacks,
    engine.outputDeviceId,
  );
}

// --- 切换系统输出设备 handler ---
async function onSelectOutputDevice(
  deviceId,
) {
  engine.outputDeviceId =
    deviceId;
  if (
    state.audioSource ===
    "output"
  ) {
    const ok =
      await engine.setSource(
        "output",
      );
    if (
      !ok
    ) {
      ui.showToast(
        t(
          "toast.outputDeviceFail",
        ),
      );
    } else if (
      engine.outputMethod ===
      "loopback"
    ) {
      const loopbacks =
        await engine.listLoopbackDevices();
      const dev =
        loopbacks.find(
          (
            d,
          ) =>
            d.deviceId ===
            deviceId,
        );
      if (
        dev
      ) {
        ui.showToast(
          t(
            "toast.outputDevice",
            {
              name:
                dev.label,
            },
          ),
          7000,
        );
      }
    }
    refreshOutputDevices();
  }
  savePreferences();
}

// --- 切换输入设备 handler ---
async function onSelectInputDevice(
  deviceId,
) {
  engine.micDeviceId =
    deviceId;
  if (
    state.audioSource ===
    "mic"
  ) {
    const ok =
      await engine.setSource(
        "mic",
      );
    if (
      !ok
    ) {
      ui.showToast(
        t(
          "toast.inputDeviceFail",
        ),
      );
      engine.micDeviceId =
        "";
      await engine.setSource(
        "mic",
      );
    } else {
      const devices =
        await engine.listInputDevices();
      const dev =
        devices.find(
          (
            d,
          ) =>
            d.deviceId ===
            deviceId,
        );
      if (
        dev &&
        AudioEngine.isLoopbackName(
          dev.label,
        )
      ) {
        ui.showToast(
          t(
            "toast.inputDevice",
            {
              name:
                dev.label,
            },
          ),
          7000,
        );
      }
    }
    refreshInputDevices();
  }
  savePreferences();
}

// 根据当前音源，计算 desired (m,n) 与振动目标
// 网格恒为自动：频谱/频率 → 连续 (m,n) 实时映射
function computeDesired() {
  const s =
    state.spectrum;

  if (
    state.audioSource ===
      "sim" ||
    state.audioSource ===
      "midi"
  ) {
    const mode =
      freqToMode(
        state.simFreq,
        {
          plateCm:
            state.plateCm,
          stiffness:
            state.plateStiffness,
        },
      );
    state.desiredM = mode.m;
    state.desiredN = mode.n;
  } else {
    // 频谱 → 等效驱动频率 fRep（频谱质心式估计），
    // 再经频率→模式映射（含板尺寸/硬度修正）得到 (m,n)
    const bass =
      clamp(
        s.bass,
        0,
        1,
      );
    const mid =
      clamp(
        s.mid,
        0,
        1,
      );
    const treble =
      clamp(
        s.treble,
        0,
        1,
      );
    const fRep =
      60 +
      bass * 3500 +
      mid * 1500 +
      treble * 500;
    const mode =
      freqToMode(
        fRep,
        {
          plateCm:
            state.plateCm,
          stiffness:
            state.plateStiffness,
        },
      );
    state.desiredM =
      mode.m;
    state.desiredN =
      mode.n;
  }

  // 振动目标：频率包络(relative overall/beat) 决定"形状上的起伏"（随音乐内容变化），
  // volumeLevel（真实响度）决定"绝对强度"——音量越大板面晃得越凶，更贴近真实克拉尼板。
  let vibTarget = 0.12;
  if (
    state.audioSource ===
      "sim" ||
    state.audioSource ===
      "midi"
  ) {
    vibTarget = 0.34;
  } else {
    // 可听音源：整体能量为底 + 鼓点脉冲叠加，让板面"跟着鼓点跳"
    vibTarget =
      0.1 +
      clamp(
        s.overall,
        0,
        1,
      ) *
        0.7 +
      clamp(
        s.beat || 0,
        0,
        1,
      ) *
        0.5;
  }
  // 真实响度门控：静音时振动趋近 0，响亮时拉满。
  // 注意：不乘 volGain——后期增强只放大"增幅"（抛速/弹起高度，见 motionGain），
  // 不改变"频率"（振动节律/抛起频次由真实响度与板面参数决定）。
  const effectiveLevel =
    state.audioSource ===
    "sim"
      ? 1
      : clamp(
          state.volumeLevel,
          0,
          1,
        );
  vibTarget *=
    0.12 +
    0.88 *
      effectiveLevel;
  state.vibrationAmplitude +=
    (vibTarget -
      state.vibrationAmplitude) *
    Math.min(
      1,
      state._dt * 4,
    );
}

// --- 每帧更新显示频率 ---
function updateDisplayFreq() {
  let freq = 0;
  if (
    state.audioSource ===
      "sim" ||
    state.audioSource ===
      "midi"
  ) {
    freq = state.simFreq;
  } else {
    freq =
      state.spectrum
        .dominantFreq;
  }
  state.detectedFreq = clamp(
    freq,
    0,
    50000,
  );
  // 平滑显示
  state._smoothFreq =
    state._smoothFreq ||
    state.detectedFreq;
  state._smoothFreq +=
    (state.detectedFreq -
      state._smoothFreq) *
    0.3;
  state.displayFreq =
    Math.round(
      state._smoothFreq,
    );
}

// --- 主循环 ---
let lastTime = 0;

function animate(
  timestamp,
) {
  const dt =
    lastTime
      ? (timestamp -
          lastTime) /
        1000
      : 0.016;
  lastTime = timestamp;
  state._dt = dt;
  state.simTime += dt;

  // 物理尺度：屏幕像素 ↔ 真实 cm，推导沙粒渲染像素尺寸。
  // 注意：grainPx 保持浮点数、不在此处取整——全局取整会让全体沙粒在
  // plateCm 跨过某个舍入阈值（如 23↔24cm 附近的 1.5px 分界）时同时跳档，
  // 造成整板粒子尺寸/亮度突变。取整下放到 render 层按每颗粒子进行
  //（乘各自 sizeF 后再舍入 → 阈值被粒径分布抖散；GPU 路径直接用浮点尺寸）。
  state.pxPerCm =
    state.plateSize /
    state.plateCm;
  // 严格等比例：grainPx = 真实沙粒直径(cm) × 屏幕像素比例，
  // 不设人为上下限（旧 [0.5,8] clamp 会在大粒/小板时封顶、小粒/大板时垫底，
  // 破坏"沙粒-底板"物理比例）。仅防 NaN/0。
  state.grainPx =
    Math.max(
      0.001,
      (state.grainMm /
        10) *
        state.pxPerCm ||
        0.001,
    );

  // 引擎内部更新（频谱分析）
  engine.update();
  state.spectrum =
    engine.spectrum;

  // 真实响度（0~1）：以时域 RMS 计算，映射到约 60 dB 动态范围。
  // 作为"运动强度"的总门控——音量越大，板面/沙粒运动越剧烈；
  // SIM 模式无真实音频，固定满强度以沿用以前稳定的振动手感。
  if (
    state.audioSource ===
      "sim" ||
    state.audioSource ===
      "midi"
  ) {
    state.volumeLevel = 1;
  } else {
    // 用相对响度（与图形同套刻度），避免 OUTPUT 等弱信号下"图形动、门控不动"
    const loud =
      state.spectrum.loudness ||
      0;
    state.volumeLevel = clamp(
      loud,
      0,
      1,
    );
  }

  // 计算目标模式与振动
  computeDesired();

  // 带滞回的整数量化：desired 偏离当前整数模式超过 0.65 才切换，
  // 避免在边界附近来回抖动；(m,n) 恒为整数 → 图形恒中心对称
  const quantM =
    Math.abs(
      state.desiredM -
        state.currentM,
    ) >
    0.65
      ? Math.round(
          clamp(
            state.desiredM,
            1,
            15,
          ),
        )
      : state.currentM;
  const quantN =
    Math.abs(
      state.desiredN -
        state.currentN,
    ) >
    0.65
      ? Math.round(
          clamp(
            state.desiredN,
            1,
            15,
          ),
        )
      : state.currentN;
  if (
    quantM !==
      state.currentM ||
    quantN !==
      state.currentN
  ) {
    // 模式切换：记录旧模式，启动高度场交叉淡入
    state.prevM =
      state.currentM;
    state.prevN =
      state.currentN;
    state.currentM =
      quantM;
    state.currentN =
      quantN;
    state.blendT = 0;
    state.modeKickEnergy =
      Math.max(
        state.modeKickEnergy,
        0.45,
      );
  }
  // 底板实际振动频率：当前模式在给定尺寸/硬度下的共振频率。
  // 物理：f(m,n) ∝ (m²+n²)·(L₀/L)²·√s —— 硬度 s 越高，振动频率越高。
  state.vibrationFreq =
    modeToFreq(
      state.currentM,
      state.currentN,
      {
        plateCm:
          state.plateCm,
        stiffness:
          state.plateStiffness,
      },
    );
  // 振动频率 → 跳动节律因子：以默认 (3,4)/L=40/s=1 的共振 1375Hz 为基准。
  // 硬度越大 → 振动频率越高 → 沙粒被抛起的节律越快（直观体现"底板震动频率"）。
  state.vibRate =
    clamp(
      Math.sqrt(
        state.vibrationFreq /
          1375,
      ),
      0.3,
      3,
    );
  // 过渡推进；过渡期间纹理持续重算（含结束后最后一帧定格）
  if (
    state.blendT <
    1
  ) {
    state.blendT =
      Math.min(
        1,
        state.blendT +
          dt *
            2.2,
      );
    state.patternDirty = true;
  }

  // 踢散能量衰减
  state.modeKickEnergy =
    Math.max(
      0,
      state.modeKickEnergy -
        dt * 2.5,
    );

  // 粒子物理：使用混合高度场（psi≥0，sign 恒正 → 力 = -∇H 纯下坡）
  const field = {
    psiAt: (
      u,
      v,
    ) =>
      blendedHeight(
        u,
        v,
        state.prevM,
        state.prevN,
        state.currentM,
        state.currentN,
        state.blendT,
      ),
    gradAt: (
      u,
      v,
    ) =>
      blendedHeightGradient(
        u,
        v,
        state.prevM,
        state.prevN,
        state.currentM,
        state.currentN,
        state.blendT,
      ),
    vibration:
      state.vibrationAmplitude,
    treble:
      state.spectrum
        .treble,
    // 踢散能量：模式切换（与音量无关，恒有）+ 鼓点脉冲（随真实响度缩放，
    // 音量越大鼓点溅得越凶）。不乘 volGain：后期增强只放大增幅（motionGain），
    // 不改变踢散触发的强度节律。
    kick: Math.min(
      1,
      state.modeKickEnergy +
        (state.spectrum
          .beat ||
          0) *
          0.35 *
          clamp(
            state.volumeLevel,
            0,
            1,
          ),
    ),
    plateLimit: 0.97,
    // 震源在中间：板心激励最强、向四周传播衰减
    excAt: centerExcitation,
    // 振动频率节律因子（硬度↑→跳动更快）：让"底板震动频率"可感知
    vibRate: state.vibRate,
    // 后期增强增益：直接放大沙粒抛起速度与弹起高度（修复"弹不起来"）
    motionGain: state.volGain,
  };
  // 沙粒数量变更：每帧最多重建一次（拖动时按帧节流，避免卡顿）
  if (
    pendingParticleCount !==
      null &&
    pendingParticleCount !==
      particles.num
  ) {
    particles.setCount(
      pendingParticleCount,
    );
    // GPU 路径同步重建缓冲（保持与 CPU 系统一致，便于随时回退）
    if (
      gpuParticles
    )
      gpuParticles.setCount(
        pendingParticleCount,
      );
    // Worker 路径：真正在跑的粒子系统在后台线程，需同步数量
    if (
      particleWorker
    )
      particleWorker.postMessage(
        {
          type: "count",
          count:
            pendingParticleCount,
        },
      );
    pendingParticleCount = null;
  }

  // 渲染
  renderer.drawBackground();
  renderer.maybeUpdatePattern(
    state,
    timestamp,
  );
  // 底板：GPU 着色器实时绘制（WebGL2）或 CPU 回退
  if (
    renderer.glPlate &&
    renderer.glPlate.ok
  ) {
    renderer.glPlate.render(
      state,
      state.plateX,
      state.plateY,
      state.plateSize,
    );
  } else if (
    state.showPattern
  ) {
    renderer._drawPlate(
      state,
    );
  }

  // 粒子层：优先 WebGPU（GPU 物理 + 碰撞，海量粒子 + 沙堆带），
  // 否则原 CPU 物理 + WebGL2/CPU 渲染回退路径
  if (
    gpuParticles &&
    gpuParticles.ready
  ) {
    gpuParticles.step(
      dt,
      {
        vibration: field.vibration,
        kick: field.kick,
        treble: field.treble,
        vibRate: field.vibRate,
        motionGain: field.motionGain,
        prevM: state.prevM,
        prevN: state.prevN,
        curM: state.currentM,
        curN: state.currentN,
        blendT: state.blendT,
        plateLimit: 0.97,
        collision: state.collision
          ? 1
          : 0,
        grainPx: state.grainPx,
        plateSize: state.plateSize,
      },
    );
    gpuParticles.render(
      state,
      state.plateX,
      state.plateY,
      state.plateSize,
      state.grainPx,
    );
  } else if (
    particleWorker
  ) {
    // 后台线程路径：只投递本帧参数，物理与 WebGL2 绘制都在 Worker 里完成。
    // workerBusy 做背压——上一帧没算完就跳过本次投递（宁可丢帧也不堆积延迟）。
    // 看门狗：回包异常丢失时（超过 2 秒）强制解锁，避免沙粒永久冻结。
    if (
      workerBusy &&
      timestamp -
        workerFrameAt >
        2000
    )
      workerBusy = false;
    if (
      !workerBusy
    ) {
      workerBusy = true;
      workerFrameAt =
        timestamp;
      particleWorker.postMessage(
        {
          type: "frame",
          dt,
          vibration:
            field.vibration,
          treble:
            field.treble,
          kick: field.kick,
          vibRate:
            field.vibRate,
          motionGain:
            field.motionGain,
          plateLimit: 0.97,
          prevM:
            state.prevM,
          prevN:
            state.prevN,
          curM: state.currentM,
          curN: state.currentN,
          blendT:
            state.blendT,
          collision:
            state.collision,
          showParticles:
            state.showParticles,
          grainPx:
            state.grainPx,
          plateSize:
            state.plateSize,
          plateX:
            state.plateX,
          plateY:
            state.plateY,
        },
      );
    }
  } else {
    particles.update(
      dt,
      field,
      state.collision,
    );
    renderer._drawParticles(
      state,
      particles.particles,
      0,
      0,
      state.showParticles,
    );
  }

  updateDisplayFreq();
  ui.update(
    state,
  );

  requestAnimationFrame(
    animate,
  );
}

// --- 保存当前画面为 PNG ---
// 只导出底板（正方形克拉尼板 + 沙粒），不导出整窗空白边距，也不含 HTML 界面。
// 合成顺序：先画 2D 主画布（黑板 + 节线纹理 + CPU 路径沙粒），
// 再叠加 WebGL 沙粒层（透明背景）。preserveDrawingBuffer 已开启，
// 故 glCanvas 当前帧可随时被 drawImage 读回。
// 两路画布都是整窗尺寸，按 (plateX,plateY,plateSize) 裁剪出板区域即可。
function saveSnapshot() {
  const W =
    state.W;
  const H =
    state.H;
  const size =
    state.plateSize > 0
      ? state.plateSize
      : Math.min(
          W,
          H,
        );
  const ox =
    state.plateSize > 0
      ? state.plateX
      : 0;
  const oy =
    state.plateSize > 0
      ? state.plateY
      : 0;
  const out =
    document.createElement(
      "canvas",
    );
  out.width = size;
  out.height = size;
  const octx =
    out.getContext(
      "2d",
    );
  // 主画布（黑板 + 节线纹理），裁剪到板区域
  octx.drawImage(
    canvas,
    ox,
    oy,
    size,
    size,
    0,
    0,
    size,
    size,
  );
  // WebGL 底板+节线层（透明叠加）：仅当 GPU 底板激活时主画布才不含节线
  if (
    glPlate &&
    glPlate.ok
  ) {
    octx.drawImage(
      plateCanvas,
      ox,
      oy,
      size,
      size,
      0,
      0,
      size,
      size,
    );
  }
  // WebGL/WebGPU 沙粒层（透明叠加）；CPU 降级路径沙粒已在主画布内，无需重复。
  // Worker 模式下 #glcanvas 是「占位画布」（真实绘制在 OffscreenCanvas 里），
  // 规范允许把它当作图像源读回；个别浏览器若不支持则跳过沙粒层而非整体失败。
  if (
    (glParticles &&
      glParticles.ok) ||
    gpuParticles ||
    particleWorker
  ) {
    try {
      octx.drawImage(
        glCanvas,
        ox,
        oy,
        size,
        size,
        0,
        0,
        size,
        size,
      );
    } catch (e) {
      console.warn(
        "沙粒层读回失败，本次快照只含底板：",
        e,
      );
    }
  }
  // 文件名：模式 + 时间戳
  const d = new Date();
  const p = (
    n,
  ) =>
    String(
      n,
    ).padStart(
      2,
      "0",
    );
  const ts =
    `${d.getFullYear()}${p(
      d.getMonth() +
        1,
    )}${p(
      d.getDate(),
    )}_${p(
      d.getHours(),
    )}${p(
      d.getMinutes(),
    )}${p(
      d.getSeconds(),
    )}`;
  const name =
    `chladni_${state.currentM}x${state.currentN}_${ts}.png`;
  out.toBlob(
    (
      blob,
    ) => {
      if (
        !blob
      ) {
        if (
          ui
        )
          ui.showToast(
            t(
              "toast.saveFail",
            ),
          );
        return;
      }
      const url =
        URL.createObjectURL(
          blob,
        );
      const a =
        document.createElement(
          "a",
        );
      a.href = url;
      a.download = name;
      document.body.appendChild(
        a,
      );
      a.click();
      a.remove();
      setTimeout(
        () =>
          URL.revokeObjectURL(
            url,
          ),
        1000,
      );
      if (
        ui
      )
        ui.showToast(
          t(
            "toast.saved",
            {
              name,
            },
          ),
        );
    },
    "image/png",
  );
}

// --- 初始化 ---
function init() {
  // 依据浏览器语言应用静态文案（HTML 中标注了 data-i18n 的元素）
  applyStaticI18n();

  // INFO 板块底部显示版本号
  const versionLabel =
    document.getElementById(
      "versionLabel",
    );
  if (
    versionLabel
  )
    versionLabel.textContent =
      t(
        "app.versionLabel",
      ) +
      " " +
      APP_VERSION;

  const saved =
    loadPreferences();
  if (
    saved
  ) {
    state.audioSource =
      saved.audioSource;
    state.simFreq =
      saved.simFreq;
    state.showParticles =
      saved.showParticles;
    state.showPattern =
      saved.showPattern;
    state.simSound =
      saved.simSound;
    state.particleCount =
      saved.particleCount;
    state.plateCm =
      saved.plateCm;
    state.plateStiffness =
      saved.plateStiffness;
    state.grainMm =
      saved.grainMm;
    state.volGain =
      saved.volGain;
    // 恢复上次选择的系统输入/输出设备
    engine.micDeviceId =
      saved.micDeviceId;
    engine.outputDeviceId =
      saved.outputDeviceId;
  }
  // 网格恒为自动
  state.selectedMode =
    "auto";

  resize();
  particles.setCount(
    state.particleCount,
  );
  // 三条路径的粒子数量在启动时就对齐到用户上次的偏好
  if (
    gpuParticles
  )
    gpuParticles.setCount(
      state.particleCount,
    );
  if (
    particleWorker
  )
    particleWorker.postMessage(
      {
        type: "count",
        count:
          state.particleCount,
      },
    );

  // 初始模式（自动）：默认 3×4
  state.desiredM = 3;
  state.desiredN = 4;
  state.currentM =
    Math.round(
      state.desiredM,
    );
  state.currentN =
    Math.round(
      state.desiredN,
    );
  // 初始无过渡：prev 与 current 一致，blendT 置 1
  state.prevM =
    state.currentM;
  state.prevN =
    state.currentN;
  state.blendT = 1;
  state.patternDirty = true;

  // UI 绑定
  ui = setupUI(
    {
      onSelectSource,
      onSelectInputDevice,
      onSelectOutputDevice,
      onTogglePattern: () => {
        state.showPattern =
          !state.showPattern;
        state.patternDirty = true;
        savePreferences();
      },
      onToggleParticles: () => {
        state.showParticles =
          !state.showParticles;
        savePreferences();
      },
      onToggleCollision: () => {
        state.collision =
          !state.collision;
        savePreferences();
      },
      onParticleCount: (
        v,
      ) => {
        pendingParticleCount =
          clamp(
            Math.round(
              v,
            ),
            100,
            100000,
          );
        state.particleCount =
          pendingParticleCount;
        savePreferences();
      },
      onPlateSize: (
        v,
      ) => {
        state.plateCm =
          clamp(
            v,
            5,
            100,
          );
        savePreferences();
      },
      onStiffness: (
        v,
      ) => {
        state.plateStiffness =
          clamp(
            v,
            0.2,
            6,
          );
        savePreferences();
      },
      onGrain: (
        v,
      ) => {
        state.grainMm =
          clamp(
            v,
            0.05,
            5,
          );
        savePreferences();
      },
      onVolGain: (
        v,
      ) => {
        state.volGain =
          clamp(
            v,
            0.1,
            10,
          );
        savePreferences();
      },
      onSimFreq: (
        v,
      ) => {
        state.simFreq =
          clamp(
            v,
            20,
            50000,
          );
        // 实时更新 SIM 发声频率（sim / midi 模式下振荡器存在）
        engine.setSimFreq(
          state.simFreq,
        );
        savePreferences();
      },
      onToggleSimSound: () => {
        state.simSound =
          !state.simSound;
        engine.setSimSound(
          state.simSound,
        );
        savePreferences();
      },
    },
  );

  ui.setParticleCount(
    state.particleCount,
  );
  ui.setPlateSize(
    state.plateCm,
  );
  ui.setStiffness(
    state.plateStiffness,
  );
  ui.setGrain(
    state.grainMm,
  );
  ui.setVolGain(
    state.volGain,
  );

  // 右上角「保存图像」按钮：导出当前画面为 PNG
  const saveBtn =
    document.getElementById(
      "saveBtn",
    );
  if (
    saveBtn
  ) {
    saveBtn.addEventListener(
      "click",
      saveSnapshot,
    );
  }

  // 顶部中间「全屏」按钮：隐藏所有 UI，底板铺满窗口；ESC 退出
  const fullscreenBtn =
    document.getElementById(
      "fullscreenBtn",
    );
  if (
    fullscreenBtn
  ) {
    fullscreenBtn.addEventListener(
      "click",
      toggleFullscreen,
    );
  }

  // 点击底板（#canvas 画布区域，位于各 UI 面板之下）切换全屏：
  // 上层 #platecanvas / #glcanvas 均为 pointer-events:none，点击会透传到 #canvas
  const plateHit =
    document.getElementById(
      "canvas",
    );
  if (
    plateHit
  ) {
    plateHit.addEventListener(
      "click",
      toggleFullscreen,
    );
  }
  window.addEventListener(
    "keydown",
    (
      e,
    ) => {
      // 修饰键（Ctrl/Cmd/Alt）不拦截，避免与浏览器快捷键冲突
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      if (
        e.key ===
          "Escape" &&
        state.fullscreen
      ) {
        // 退出全屏：恢复所有 UI，底板回到带边距的常规布局
        setFullscreen(
          false,
        );
      } else if (
        e.key ===
          "f" ||
        e.key ===
          "F"
      ) {
        // F 键切换全屏：未全屏时进入，已全屏时退出
        setFullscreen(
          !state.fullscreen,
        );
      }
    },
  );

  // 用户在浏览器上点了"停止共享" → 回到 SIM 并提示
  engine.onSysEnded = () => {
    if (
      state.audioSource ===
        "output" &&
      engine.outputMethod ===
        "display"
    ) {
      state.audioSource =
        "sim";
      engine.setSource(
        "sim",
      );
      savePreferences();
      if (
        ui
      )
        ui.showToast(
          t(
            "toast.outputStopped",
          ),
        );
    }
  };

  // 让 SIM 发声频率与已保存值一致（刷新后若默认 sim 也可立即用正确频率）
  engine.setSimFreq(
    state.simFreq,
  );
  // 同步 SIM 声音开关（决定是否真正出声）
  engine.setSimSound(
    state.simSound,
  );

  // MIDI 音符 → 驱动 SIM 频率（与滑块同一条路径）；
  // 同时把设备状态文本交给 UI 显示。freq 为 null 表示仅状态更新。
  engine.onMidiNote = (
    freq,
    note,
    statusText,
  ) => {
    if (
      freq
    ) {
      state.simFreq = clamp(
        freq,
        20,
        50000,
      );
      engine.setSimFreq(
        state.simFreq,
      );
    }
    if (
      statusText
    )
      state.midiStatusMsg = statusText;
  };

  // 浏览器自动播放策略：AudioContext 必须在用户手势内 resume。
  // 若页面加载时默认就是 SIM（无手势），先建好振荡器但保持静音，
  // 待首次任意交互再恢复上下文 → 声音自动响起。
  const resumeCtx = () => {
    if (
      engine.ctx &&
      engine.ctx.state ===
        "suspended"
    ) {
      engine.ctx.resume().catch(
        () => {},
      );
    }
    window.removeEventListener(
      "pointerdown",
      resumeCtx,
    );
    window.removeEventListener(
      "keydown",
      resumeCtx,
    );
  };
  window.addEventListener(
    "pointerdown",
    resumeCtx,
  );
  window.addEventListener(
    "keydown",
    resumeCtx,
  );

  // 默认音源恢复。
  // OUTPUT 走虚拟声卡直采（getUserMedia）时刷新后可自动恢复；
  // 若无虚拟声卡会兜底到 getDisplayMedia，页面加载时无用户手势必然失败 → 回退 SIM。
  engine
    .setSource(
      state.audioSource,
    )
    .then(
      (
        ok,
      ) => {
        if (
          ok
        ) {
          // 自动恢复成功后刷新设备列表（授权后 label 才可见）
          if (
            state.audioSource ===
            "mic"
          ) {
            refreshInputDevices();
          } else if (
            state.audioSource ===
            "output"
          ) {
            refreshOutputDevices();
            if (
              ui &&
              engine.outputMethod ===
                "loopback"
            ) {
              ui.showToast(
                t(
                  "toast.outputAutoResume",
                ),
              );
            }
          } else if (
            state.audioSource ===
            "midi"
          ) {
            if (
              ui &&
              engine.midiEnabled
            ) {
              ui.showToast(
                t(
                  "toast.midiAutoResume",
                ),
              );
            }
          }
        } else if (
          state.audioSource ===
          "output"
        ) {
          // 无虚拟声卡 → 屏幕共享需用户手势，回退 SIM 并提示
          state.audioSource =
            "sim";
          engine.setSource(
            "sim",
          );
          savePreferences();
          if (
            ui
          )
          ui.showToast(
            t(
              "toast.outputManualResume",
            ),
          );
        } else if (
          state.audioSource ===
          "midi"
        ) {
          // MIDI 自动恢复失败（无权限/无设备）→ 回退 SIM
          state.audioSource =
            "sim";
          engine.setSource(
            "sim",
          );
          savePreferences();
          if (
            ui
          )
          ui.showToast(
            t(
              "toast.midiResumeFail",
            ),
          );
        }
      },
    );

  savePreferences();
  requestAnimationFrame(
    animate,
  );
}

window.addEventListener(
  "resize",
  () => {
    resize();
  },
);

// 底部三段 UI 栏高度会随设备下拉框显隐 / 窗口换行而变化，
// 用 ResizeObserver 监听其高度，变化时重算底板布局，避免与栏重叠。
const bottomBarEl =
  document.getElementById(
    "bottomBar",
  );
if (
  bottomBarEl &&
  typeof ResizeObserver !==
    "undefined"
) {
  const barObs =
    new ResizeObserver(
      () => {
        resize();
      },
    );
  barObs.observe(
    bottomBarEl,
  );
}

init();
