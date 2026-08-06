// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

// ============================================================
//  setupUI — UI 控件绑定与状态刷新
//  通过 handlers 回调把用户操作交回 main；
//  返回的控制器对象用于每帧刷新界面。
// ============================================================

import {
  modeToFreq,
} from "./chladni.js";
import {
  t,
} from "./i18n.js";

// 音源内部值 → 文案 key（界面显示名随浏览器语言切换）
const SOURCE_KEYS = {
  mic: "src.input",
  output: "src.output",
  sim: "src.simulation",
  midi: "src.midi",
  share: "src.share",
};

export function setupUI(
  handlers,
) {
  const $ = (
    id,
  ) =>
    document.getElementById(
      id,
    );

  const permOverlay =
    $("permOverlay");
  const micBtn =
    $("micBtn");
  const outputBtn =
    $("outputBtn");
  const shareBtn =
    $("shareBtn");
  const simBtn =
    $("simBtn");
  const midiBtn =
    $("midiBtn");
  const modeDisplay =
    $("modeDisplay");
  const freqDisplay =
    $("freqDisplay");
  const volFill =
    $("volFill");
  const volDb =
    $("volDb");
  const sourceDisplay =
    $("sourceDisplay");
  const simControl =
    $("simControl");
  const simSlider =
    $("simSlider");
  const simValue =
    $("simValue");
  const patternToggleBtn =
    $("patternToggleBtn");
  const particleToggleBtn =
    $("particleToggleBtn");
  const collisionToggleBtn =
    $("collisionToggleBtn");
  const simSoundToggleBtn =
    $("simSoundToggleBtn");
  const particleCountSlider =
    $("particleCountSlider");
  const particleCountValue =
    $("particleCountValue");
  const plateSizeSlider =
    $("plateSizeSlider");
  const plateSizeValue =
    $("plateSizeValue");
  const stiffnessSlider =
    $("stiffnessSlider");
  const stiffnessValue =
    $("stiffnessValue");
  const grainSlider =
    $("grainSlider");
  const grainValue =
    $("grainValue");
  const volGainSlider =
    $("volGainSlider");
  const volGainValue =
    $("volGainValue");
  const resonanceDisplay =
    $("resonanceDisplay");
  const midiControl =
    $("midiControl");
  const midiStatus =
    $("midiStatus");
  const startMicBtn =
    $("startMicBtn");
  const demoBtn =
    $("demoBtn");
  const listenSysBtn =
    $("listenSysBtn");
  const toast =
    $("toast");
  const inputDeviceControl =
    $("inputDeviceControl");
  const inputDeviceSelect =
    $("inputDeviceSelect");
  const outputDeviceControl =
    $("outputDeviceControl");
  const outputDeviceSelect =
    $("outputDeviceSelect");

  // --- 底板形状 / 符号 / 画廊 控件 ---
  const shapeSquareBtn =
    $(
      "shapeSquareBtn",
    );
  const shapeCircleBtn =
    $(
      "shapeCircleBtn",
    );
  const shapeTriangleBtn =
    $(
      "shapeTriangleBtn",
    );
  const shapeHexagonBtn =
    $(
      "shapeHexagonBtn",
    );
  const squareOnlyControls =
    $(
      "squareOnlyControls",
    );
  const squareSignBtn =
    $(
      "squareSignBtn",
    );

  // --- 顶部提示条（自动消失）---
  let toastTimer = null;
  function showToast(
    msg,
    duration = 4200,
  ) {
    if (
      !toast
    )
      return;
    toast.textContent =
      msg;
    toast.classList.add(
      "show",
    );
    if (
      toastTimer
    )
      clearTimeout(
        toastTimer,
      );
    toastTimer = setTimeout(
      () => {
        toast.classList.remove(
          "show",
        );
      },
      duration,
    );
  }

  // --- 音源切换 ---
  micBtn.addEventListener(
    "click",
    () =>
      handlers.onSelectSource(
        "mic",
      ),
  );
  outputBtn.addEventListener(
    "click",
    () =>
      handlers.onSelectSource(
        "output",
      ),
  );
  shareBtn.addEventListener(
    "click",
    () =>
      handlers.onShareSystem(),
  );
  simBtn.addEventListener(
    "click",
    () =>
      handlers.onSelectSource(
        "sim",
      ),
  );
  midiBtn.addEventListener(
    "click",
    () =>
      handlers.onSelectSource(
        "midi",
      ),
  );

  // --- 模拟频率滑块 ---
  simSlider.addEventListener(
    "input",
    () => {
      handlers.onSimFreq(
        Number(
          simSlider.value,
        ),
      );
    },
  );

  // --- 系统输入设备切换（INPUT 模式）---
  inputDeviceSelect.addEventListener(
    "change",
    () => {
      handlers.onSelectInputDevice(
        inputDeviceSelect.value,
      );
    },
  );

  // --- 系统输出设备切换（OUTPUT 模式，虚拟回环声卡）---
  outputDeviceSelect.addEventListener(
    "change",
    () => {
      handlers.onSelectOutputDevice(
        outputDeviceSelect.value,
      );
    },
  );

  // 填充输入设备列表；loopbackIds 集合内的设备加 [系统音频] 标记
  function setInputDevices(
    devices,
    selectedId,
    loopbackIds,
  ) {
    inputDeviceSelect.innerHTML =
      "";
    for (
      const d of devices
    ) {
      const opt =
        document.createElement(
          "option",
        );
      opt.value =
        d.deviceId;
      const label =
        d.label ||
        t(
          "device.unnamed",
        );
      opt.textContent =
        loopbackIds.has(
          d.deviceId,
        )
          ? t(
            "device.systemAudio",
            {
              label,
            },
          )
          : label;
      inputDeviceSelect.appendChild(
        opt,
      );
    }
    inputDeviceSelect.value =
      selectedId ||
      (devices[0]
        ? devices[0]
            .deviceId
        : "");
  }

  // 填充系统输出（回环）设备列表
  function setOutputDevices(
    devices,
    selectedId,
  ) {
    outputDeviceSelect.innerHTML =
      "";
    for (
      const d of devices
    ) {
      const opt =
        document.createElement(
          "option",
        );
      opt.value =
        d.deviceId;
      opt.textContent =
        d.label ||
        t(
          "device.unnamed",
        );
      outputDeviceSelect.appendChild(
        opt,
      );
    }
    outputDeviceSelect.value =
      selectedId ||
      (devices[0]
        ? devices[0]
            .deviceId
        : "");
    // 无回环设备可选时隐藏（display 捕获方式下无需选择）
    outputDeviceControl.dataset.hasDevices =
      devices.length >
      0
        ? "1"
        : "";
  }

  // --- 显示开关 ---
  patternToggleBtn.addEventListener(
    "click",
    () =>
      handlers.onTogglePattern(),
  );
  particleToggleBtn.addEventListener(
    "click",
    () =>
      handlers.onToggleParticles(),
  );
  if (
    collisionToggleBtn
  ) {
    collisionToggleBtn.addEventListener(
      "click",
      () =>
        handlers.onToggleCollision(),
    );
  }
  simSoundToggleBtn.addEventListener(
    "click",
    () =>
      handlers.onToggleSimSound(),
  );

  // --- 沙粒数量滑块 ---
  if (
    particleCountSlider
  ) {
    particleCountSlider.addEventListener(
      "input",
      () => {
        const v =
          Number(
            particleCountSlider.value,
          );
        particleCountValue.textContent =
          v.toLocaleString();
        if (
          handlers.onParticleCount
        ) {
          handlers.onParticleCount(
            v,
          );
        }
      },
    );
  }

  // --- 底板边长（cm）滑块 ---
  if (
    plateSizeSlider
  ) {
    plateSizeSlider.addEventListener(
      "input",
      () => {
        const v =
          Number(
            plateSizeSlider.value,
          );
        plateSizeValue.textContent =
          `${v} cm`;
        if (
          handlers.onPlateSize
        ) {
          handlers.onPlateSize(
            v,
          );
        }
      },
    );
  }

  // --- 底板硬度滑块 ---
  if (
    stiffnessSlider
  ) {
    stiffnessSlider.addEventListener(
      "input",
      () => {
        const v =
          Number(
            stiffnessSlider.value,
          );
        stiffnessValue.textContent =
          `${v.toFixed(1)}×`;
        if (
          handlers.onStiffness
        ) {
          handlers.onStiffness(
            v,
          );
        }
      },
    );
  }

  // --- 沙粒真实直径（mm）滑块 ---
  if (
    grainSlider
  ) {
    grainSlider.addEventListener(
      "input",
      () => {
        const v =
          Number(
            grainSlider.value,
          );
        grainValue.textContent =
          `${v.toFixed(2)} mm`;
        if (
          handlers.onGrain
        ) {
          handlers.onGrain(
            v,
          );
        }
      },
    );
  }

  // --- 音量后期增强滑块（0.1~10）---
  if (
    volGainSlider
  ) {
    volGainSlider.addEventListener(
      "input",
      () => {
        const v =
          Number(
            volGainSlider.value,
          );
        volGainValue.textContent =
          `${v.toFixed(1)}×`;
        if (
          handlers.onVolGain
        ) {
          handlers.onVolGain(
            v,
          );
        }
      },
    );
  }

  // --- 底板形状选择 ---
  const shapeBtns = {
    square: shapeSquareBtn,
    circle: shapeCircleBtn,
    triangle: shapeTriangleBtn,
    hexagon: shapeHexagonBtn,
  };
  for (
    const key in shapeBtns
  ) {
    const btn = shapeBtns[
      key
    ];
    if (
      btn
    ) {
      btn.addEventListener(
        "click",
        () =>
          handlers.onSelectShape(
            key,
          ),
      );
    }
  }

  // --- 方板叠加符号切换（− 差形式 / + 和形式）---
  if (
    squareSignBtn
  ) {
    squareSignBtn.addEventListener(
      "click",
      () =>
        handlers.onToggleSquareSign(),
    );
  }

  // 拖拽文件到窗口：不再加载歌曲（MUSIC 源已移除），此处仅阻止默认行为
  window.addEventListener(
    "dragover",
    (
      e,
    ) => {
      e.preventDefault();
    },
  );

  // --- 引导层 ---
  // 首选：实时监听电脑其他软件播放的音乐（系统输出音源）
  if (
    listenSysBtn
  ) {
    listenSysBtn.addEventListener(
      "click",
      async () => {
        const ok =
          await handlers.onSelectSource(
            "output",
          );
        if (
          ok
        ) {
          hideOverlay();
        }
      },
    );
  }
  startMicBtn.addEventListener(
    "click",
    async () => {
      const ok =
        await handlers.onSelectSource(
          "mic",
        );
      if (
        ok
      ) {
        hideOverlay();
      }
    },
  );
  // 跳过引导：使用 SIM 手动模拟模式（合成音源已移除）
  demoBtn.addEventListener(
    "click",
    () => {
      handlers.onSelectSource(
        "sim",
      );
      hideOverlay();
    },
  );
  function hideOverlay() {
    permOverlay.classList.add(
      "hidden",
    );
  }

  permOverlay.addEventListener(
    "transitionend",
    (
      e,
    ) => {
      if (
        e.target ===
          permOverlay &&
        permOverlay.classList.contains(
          "hidden",
        )
      ) {
        permOverlay.style.display =
          "none";
      }
    },
  );

  // 自动隐藏引导层（兜底；留足时间让用户点"监听电脑播放的音乐"）
  setTimeout(
    () => {
      permOverlay.classList.add(
        "hidden",
      );
    },
    12000,
  );

  // --- 每帧刷新界面 ---
  // 变化检测缓存：仅当值真正变化时才写 DOM，避免每帧 60×N 次无谓写入
  // （这是 GPU 模式下主线程唯一持续存在的逐帧 CPU 开销）。
  // `_ui` 保存上次写入的值；`_set`/`_toggle`/`_hidden` 仅在键变化时真正操作 DOM。
  const _ui = {};
  const _set = (
    el,
    key,
    val,
    kind = "text",
  ) => {
    if (
      !el ||
      _ui[
        key
      ] ===
      val
    )
      return;
    _ui[
      key
    ] =
      val;
    if (
      kind ===
      "html"
    )
      el.innerHTML =
        val;
    else if (
      kind ===
      "style"
    )
      el.style.width =
        val;
    else if (
      kind ===
      "prop"
    )
      el.value =
        val;
    else
      el.textContent =
        val;
  };
  const _toggle = (
    el,
    key,
    on,
    cls = "active",
  ) => {
    if (
      !el ||
      _ui[
        key
      ] ===
      on
    )
      return;
    _ui[
      key
    ] =
      on;
    el.classList.toggle(
      cls,
      on,
    );
  };
  const _hidden = (
    el,
    key,
    hide,
  ) => {
    if (
      !el ||
      _ui[
        key
      ] ===
      hide
    )
      return;
    _ui[
      key
    ] =
      hide;
    el.classList.toggle(
      "hidden",
      hide,
    );
  };

  function update(
    state,
  ) {
    // 网格恒为自动：GRID 读数显示当前图案模式 (m×n)
    _set(
      modeDisplay,
      "mode",
      `${state.currentM}×${state.currentN}`,
    );

    // 底板形状高亮
    if (
      shapeSquareBtn
    )
      _toggle(
        shapeSquareBtn,
        "shpSq",
        state.plateShape ===
          "square",
      );
    if (
      shapeCircleBtn
    )
      _toggle(
        shapeCircleBtn,
        "shpCi",
        state.plateShape ===
          "circle",
      );
    if (
      shapeTriangleBtn
    )
      _toggle(
        shapeTriangleBtn,
        "shpTr",
        state.plateShape ===
          "triangle",
      );
    if (
      shapeHexagonBtn
    )
      _toggle(
        shapeHexagonBtn,
        "shpHx",
        state.plateShape ===
          "hexagon",
      );
    // 方板专属控件（符号 / 画廊）：非方形隐藏
    if (
      squareOnlyControls
    )
      _hidden(
        squareOnlyControls,
        "sqOnly",
        state.plateShape !==
          "square",
      );
    // 符号按钮显示当前符号（走 i18n，随语言切换）
    if (
      squareSignBtn
    )
      _set(
        squareSignBtn,
        "signTxt",
        t(
          state.squareSign >= 0
            ? "label.signPlus"
            : "label.signMinus",
        ),
      );
    // 音源显示名：随浏览器语言切换
    _set(
      sourceDisplay,
      "source",
      t(
        SOURCE_KEYS[
          state.audioSource
        ] ||
        "src.simulation",
      ),
    );
    _set(
      freqDisplay,
      "freq",
      `${state.displayFreq} <span>Hz</span>`,
      "html",
    );

    // 音量条：用"相对响度" loudness(0~1，自适应峰值归一化) 映射到 0~120 dB，
    // 与图形/运动门控共用同一套刻度（不再用原始 RMS 单独算 dB，避免两者不一致）。
    // 条形锚定在右侧，随音量增大向左填充（右 = 高声压级）。
    if (
      volFill
    ) {
      const loud =
        state.spectrum &&
        state.spectrum.loudness ||
        0;
      const db = Math.round(
        Math.max(
          0,
          Math.min(
            120,
            loud * 120,
          ),
        ),
      );
      _set(
        volFill,
        "volW",
        `${(db / 120 * 100).toFixed(1)}%`,
        "style",
      );
      if (
        volDb
      ) {
        _set(
          volDb,
          "volDb",
          `${db} dB`,
        );
      }
    }

    // 当前模式的物理共振频率（由底板尺寸/硬度推导）
    if (
      resonanceDisplay
    ) {
      const fRes =
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
      _set(
        resonanceDisplay,
        "res",
        `${Math.round(fRes)} <span>Hz</span>`,
        "html",
      );
    }

    _toggle(
      micBtn,
      "mic",
      state.audioSource ===
        "mic",
    );
    _toggle(
      outputBtn,
      "out",
      state.audioSource ===
        "output",
    );
    _toggle(
      simBtn,
      "sim",
      state.audioSource ===
        "sim",
    );
    _toggle(
      midiBtn,
      "midi",
      state.audioSource ===
        "midi",
    );
    _toggle(
      shareBtn,
      "share",
      state.audioSource ===
        "share",
    );

    // 频率滑块：仅 SIMULATION 模式显示。MIDI 为纯 MIDI 驱动，
    // 频率完全由弹奏的音符决定，不显示手动滑块（只留 MIDI INPUT 状态）。
    _hidden(
      simControl,
      "simCtl",
      state.audioSource !==
        "sim",
    );
    _hidden(
      inputDeviceControl,
      "inDev",
      state.audioSource !==
        "mic",
    );
    // OUTPUT 模式且有回环设备可选时显示输出设备下拉框
    _hidden(
      outputDeviceControl,
      "outDev",
      state.audioSource !==
        "output" ||
        !outputDeviceControl
          .dataset
          .hasDevices,
    );
    _hidden(
      midiControl,
      "midiCtl",
      state.audioSource !==
        "midi",
    );
    if (
      state.audioSource ===
      "sim"
    ) {
      _set(
        simSlider,
        "simSlider",
        String(
          Math.round(
            state.simFreq,
          ),
        ),
        "prop",
      );
      _set(
        simValue,
        "simVal",
        `${Math.round(state.simFreq)} Hz`,
      );
    }
    if (
      midiControl &&
      !midiControl.classList.contains(
        "hidden",
      ) &&
      midiStatus
    ) {
      _set(
        midiStatus,
        "midiStatus",
        state.midiStatusMsg ||
          t(
            "midi.disconnected",
          ),
      );
    }

    _toggle(
      patternToggleBtn,
      "pat",
      state.showPattern,
    );
    _set(
      patternToggleBtn,
      "patTxt",
      state.showPattern
        ? t(
          "toggle.on",
          {
            label: t(
              "label.pattern",
            ),
          },
        )
        : t(
          "toggle.off",
          {
            label: t(
              "label.pattern",
            ),
          },
        ),
    );
    _toggle(
      particleToggleBtn,
      "part",
      state.showParticles,
    );
    _set(
      particleToggleBtn,
      "partTxt",
      state.showParticles
        ? t(
          "toggle.on",
          {
            label: t(
              "label.particles",
            ),
          },
        )
        : t(
          "toggle.off",
          {
            label: t(
              "label.particles",
            ),
          },
        ),
    );
    if (
      collisionToggleBtn
    ) {
      _toggle(
        collisionToggleBtn,
        "col",
        state.collision,
      );
      _set(
        collisionToggleBtn,
        "colTxt",
        state.collision
          ? t(
            "toggle.on",
            {
              label: t(
                "label.collision",
              ),
            },
          )
          : t(
            "toggle.off",
            {
              label: t(
                "label.collision",
              ),
            },
          ),
      );
    }
    _toggle(
      simSoundToggleBtn,
      "ssnd",
      state.simSound,
    );
    _set(
      simSoundToggleBtn,
      "ssndTxt",
      state.simSound
        ? t(
          "toggle.on",
          {
            label: t(
              "label.simSound",
            ),
          },
        )
        : t(
          "toggle.off",
          {
            label: t(
              "label.simSound",
            ),
          },
        ),
    );
  }

  // 初始化/外部同步沙粒数量滑块显示
  function setParticleCount(
    v,
  ) {
    if (
      !particleCountSlider
    )
      return;
    particleCountSlider.value =
      String(
        v,
      );
    particleCountValue.textContent =
      Number(
        v,
      ).toLocaleString();
  }

  // 初始化/外部同步物理参数滑块显示
  function setPlateSize(
    v,
  ) {
    if (
      !plateSizeSlider
    )
      return;
    plateSizeSlider.value =
      String(
        v,
      );
    plateSizeValue.textContent =
      `${v} cm`;
  }
  function setStiffness(
    v,
  ) {
    if (
      !stiffnessSlider
    )
      return;
    stiffnessSlider.value =
      String(
        v,
      );
    stiffnessValue.textContent =
      `${v.toFixed(1)}×`;
  }
  function setGrain(
    v,
  ) {
    if (
      !grainSlider
    )
      return;
    grainSlider.value =
      String(
        v,
      );
    grainValue.textContent =
      `${v.toFixed(2)} mm`;
  }
  function setVolGain(
    v,
  ) {
    if (
      !volGainSlider
    )
      return;
    volGainSlider.value =
      String(
        v,
      );
    volGainValue.textContent =
      `${v.toFixed(1)}×`;
  }

  return {
    update,
    hideOverlay,
    showToast,
    setInputDevices,
    setOutputDevices,
    setParticleCount,
    setPlateSize,
    setStiffness,
    setGrain,
    setVolGain,
  };
}
