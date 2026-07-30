// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

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
  function update(
    state,
  ) {
    // 网格恒为自动：GRID 读数显示当前图案模式 (m×n)
    modeDisplay.textContent = `${state.currentM}×${state.currentN}`;

    // 音源显示名：随浏览器语言切换
    sourceDisplay.textContent =
      t(
        SOURCE_KEYS[
          state.audioSource
        ] ||
        "src.simulation",
      );
    freqDisplay.innerHTML = `${state.displayFreq} <span>Hz</span>`;

    // 音量条：以时域 RMS 换算分贝（dB）。
    // 满幅(rms=1)对应 120 dB，静音对应 0 dB，中间为对数刻度；
    // 条形锚定在右侧，随音量增大向左填充（右 = 高声压级）。
    if (
      volFill
    ) {
      const rms =
        state.spectrum &&
        state.spectrum.rms ||
        0;
      const db =
        rms > 1e-7
          ? Math.max(
            0,
            Math.min(
              120,
              120 +
              20 *
              Math.log10(
                rms,
              ),
            ),
          )
          : 0;
      volFill.style.width = `${(
        db /
        120 *
        100
      ).toFixed(
        1,
      )}%`;
      if (
        volDb
      ) {
        volDb.textContent = `${db.toFixed(
          0,
        )} dB`;
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
      resonanceDisplay.innerHTML =
        `${state.currentM}×${state.currentN} · ${Math.round(
          fRes,
        )} <span>Hz</span>`;
    }

    micBtn.classList.toggle(
      "active",
      state.audioSource ===
        "mic",
    );
    outputBtn.classList.toggle(
      "active",
      state.audioSource ===
        "output",
    );
    simBtn.classList.toggle(
      "active",
      state.audioSource ===
        "sim",
    );
    midiBtn.classList.toggle(
      "active",
      state.audioSource ===
        "midi",
    );

    // 频率滑块：仅 SIMULATION 模式显示。MIDI 为纯 MIDI 驱动，
    // 频率完全由弹奏的音符决定，不显示手动滑块（只留 MIDI INPUT 状态）。
    simControl.classList.toggle(
      "hidden",
      state.audioSource !==
        "sim",
    );
    inputDeviceControl.classList.toggle(
      "hidden",
      state.audioSource !==
        "mic",
    );
    // OUTPUT 模式且有回环设备可选时显示输出设备下拉框
    outputDeviceControl.classList.toggle(
      "hidden",
      state.audioSource !==
        "output" ||
        !outputDeviceControl
          .dataset
          .hasDevices,
    );
    midiControl.classList.toggle(
      "hidden",
      state.audioSource !==
        "midi",
    );
    if (
      state.audioSource ===
      "sim"
    ) {
      simSlider.value = String(
        Math.round(
          state.simFreq,
        ),
      );
      simValue.textContent = `${Math.round(
        state.simFreq,
      )} Hz`;
    }
    if (
      midiControl &&
      !midiControl.classList.contains(
        "hidden",
      ) &&
      midiStatus
    ) {
      midiStatus.textContent =
        state.midiStatusMsg ||
        t(
          "midi.disconnected",
        );
    }

    patternToggleBtn.classList.toggle(
      "active",
      state.showPattern,
    );
    patternToggleBtn.textContent = state.showPattern
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
      );
    particleToggleBtn.classList.toggle(
      "active",
      state.showParticles,
    );
    particleToggleBtn.textContent = state.showParticles
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
      );
    simSoundToggleBtn.classList.toggle(
      "active",
      state.simSound,
    );
    simSoundToggleBtn.textContent = state.simSound
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
