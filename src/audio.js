// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  AudioEngine — 统一音频引擎
//  音源：mic(系统输入) / output(系统输出) / midi / sim
//  实时 FFT 频谱分析 → bass / mid / treble / overall / dominantFreq
//  用于驱动克拉尼图形随音乐连续变形
// ============================================================

import {
  t,
} from "./i18n.js";

function clamp(
  v,
  min,
  max,
) {
  return Math.max(
    min,
    Math.min(
      max,
      v,
    ),
  );
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.mode = "sim";

    // 系统输入（麦克风等）/ 系统输出（屏幕共享捕获）音频流
    this.micStream = null;
    this.sysStream = null;
    // 系统输入设备 ID（空 = 系统默认麦克风）
    this.micDeviceId = "";
    // 系统输出设备 ID：指定的虚拟回环声卡
    //（如 BlackHole / LarkAudioDevice / Squirrels Audio），
    // 空 = 自动选择第一个检测到的回环设备
    this.outputDeviceId = "";
    // 当前 output 模式实际使用的方式："loopback"（虚拟声卡直采）| "display"（屏幕共享）
    this.outputMethod = "";

    // MIDI 输入（Web MIDI API）
    this.midiAccess = null; // MIDIAccess
    this.midiInputs = null; // 当前已绑定的 inputs Map
    this.midiEnabled = false; // 是否检测到任意 MIDI 输入设备
    this.midiNote = 0; // 最近一次触发的音符编号（用于 UI 显示）
    // MIDI 音符回调：(freqHz, noteNumber, statusText) => void
    //   freqHz 为 null 表示仅状态更新（设备插拔），否则为音符触发
    this.onMidiNote = null;

    // 频谱缓冲
    this.freqData = null;
    this.timeData = null;

    // 最近一次错误原因（供 UI 提示）："no-audio" | "cancelled" | ""
    this.lastError = "";
    // 系统音频捕获被外部停止时的回调（如用户点了浏览器的"停止共享"）
    this.onSysEnded = null;

    // 自适应增益：跟踪各频段运行峰值（慢衰减），把外部播放的实际动态范围拉满
    this._peakBass = 0.1;
    this._peakMid = 0.1;
    this._peakTreble = 0.1;

    // 节拍检测：低音包络均值 + 脉冲
    this._bassAvg = 0;
    this._beat = 0;

    // 平滑后的频谱（对外暴露）
    this._spectrum = {
      bass: 0,
      mid: 0,
      treble: 0,
      overall: 0,
      dominantFreq: 0,
    };
    this._sBass = 0;
    this._sMid = 0;
    this._sTreble = 0;
    this._sOverall = 0;
    this._sDominant = 0;

    // SIM 模式发声：纯正弦振荡器 + 增益，接到扬声器
    // 驱动频率跟随滑块 simFreq，模拟激振器发出的单一振动频率
    this.simOsc = null;
    this.simGain = null;
    this.simFreqHz = 440; // 与 state.simFreq 同步
    this.simVolume = 0.12; // 固定的温和音量（不随图形增幅变化）
    this.simSoundEnabled = true; // 是否发出 SIM/MIDI 振荡器纯音（可关闭以静音）
  }

  // 对外只读频谱
  get spectrum() {
    return this._spectrum;
  }

  ensureContext() {
    if (
      this.ctx
    )
      return;
    const AC =
      window.AudioContext ||
      window.webkitAudioContext;
    this.ctx = new AC();
    this.analyser =
      this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant =
      0.6;
    this.freqData = new Uint8Array(
      this.analyser.frequencyBinCount,
    );
    this.timeData = new Float32Array(
      this.analyser.fftSize,
    );
  }

  // 切换音源：先停掉所有，再建立目标音源
  async setSource(
    mode,
  ) {
    this.stopAll();
    this.mode = mode;

    if (
      mode ===
      "mic"
    ) {
      this.ensureContext();
      if (
        this.ctx.state ===
        "suspended"
      )
        await this.ctx.resume();
      this._setAudible(
        false,
      );
      const ok =
        await this.startMic();
      return ok;
    } else if (
      mode ===
      "output"
    ) {
      this.ensureContext();
      if (
        this.ctx.state ===
        "suspended"
      )
        await this.ctx.resume();
      this._setAudible(
        false,
      );
      const ok =
        await this.startOutput();
      return ok;
    } else if (
      mode ===
      "midi"
    ) {
      this.ensureContext();
      if (
        this.ctx.state ===
        "suspended"
      )
        await this.ctx.resume();
      this._setAudible(
        false,
      );
      // 请求 MIDI 访问（点 MIDI 按钮本身是用户手势，可弹权限）
      const ok =
        await this.startMidi();
      // MIDI 同样用 SIM 振荡器发出对应频率的纯音（驱动板面振动）
      this.startSimTone();
      return ok;
    }
    // sim（及未知模式）：数值模拟，发出对应频率纯音
    this.ensureContext();
    this.ctx.resume().catch(
      () => {},
    );
    this.startSimTone();
    return true;
  }

  // 控制 analyser 是否接到扬声器（仅可听音源接，避免麦克风回授）
  _setAudible(
    on,
  ) {
    if (
      !this.analyser
    )
      return;
    try {
      this.analyser.disconnect();
    } catch (
      e
    ) {}
    if (
      on
    ) {
      this.analyser.connect(
        this.ctx.destination,
      );
    }
  }

  stopAll() {
    this.stopMic();
    this.stopSystem();
    this.stopMidi();
    this.stopSimTone();
  }

  // --- 麦克风 / 指定输入设备 ---
  // micDeviceId 非空时从该设备取流；若指定设备打开失败则回退默认设备重试一次
  async startMic() {
    const baseAudio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    const tryOpen = async (
      deviceId,
    ) => {
      const audio = {
        ...baseAudio,
      };
      if (
        deviceId
      ) {
        audio.deviceId = {
          exact: deviceId,
        };
      }
      return navigator.mediaDevices.getUserMedia(
        {
          audio,
        },
      );
    };
    try {
      try {
        this.micStream =
          await tryOpen(
            this.micDeviceId,
          );
      } catch (
        e
      ) {
        // 指定设备不可用（拔掉/改名）→ 回退默认设备
        if (
          !this.micDeviceId
        )
          throw e;
        this.micDeviceId =
          "";
        this.micStream =
          await tryOpen(
            "",
          );
      }
      const source =
        this.ctx.createMediaStreamSource(
          this.micStream,
        );
      source.connect(
        this.analyser,
      );
      this._resetAdaptiveGain();
      return true;
    } catch (
      e
    ) {
      return false;
    }
  }

  // 枚举所有音频输入设备（须先授权过一次麦克风，label 才非空）
  async listInputDevices() {
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices
        .enumerateDevices
    )
      return [];
    try {
      const devices =
        await navigator.mediaDevices.enumerateDevices();
      return devices.filter(
        (
          d,
        ) =>
          d.kind ===
          "audioinput",
      );
    } catch (
      e
    ) {
      return [];
    }
  }

  // 判断设备名是否为虚拟回环设备（可承载系统音频输出的虚拟声卡）
  static isLoopbackName(
    label,
  ) {
    return /blackhole|soundflower|loopback|virtual|vb-?cable|aggregate|lark|squirrels|多输出|聚合/i.test(
      label ||
        "",
    );
  }

  stopMic() {
    if (
      this.micStream
    ) {
      this.micStream
        .getTracks()
        .forEach(
          (
            t,
          ) =>
            t.stop(),
        );
      this.micStream =
        null;
    }
  }

  // --- 系统输出（OUTPUT 音源）---
  // 捕获电脑上其他软件正在播放的声音，两条路径按优先级尝试：
  //   1. 虚拟回环声卡直采（BlackHole / Lark / Squirrels 等）：
  //      无弹窗、无需每次授权、刷新后可自动恢复；
  //   2. 屏幕共享捕获（getDisplayMedia）：无虚拟声卡时的兜底方案。
  async startOutput() {
    this.lastError = "";
    this.outputMethod = "";
    // 路径 1：找回环设备（优先用户指定的 outputDeviceId）
    const loopbacks =
      await this.listLoopbackDevices();
    let target = null;
    if (
      this.outputDeviceId
    ) {
      target =
        loopbacks.find(
          (
            d,
          ) =>
            d.deviceId ===
            this.outputDeviceId,
        ) ||
        null;
    }
    if (
      !target &&
      loopbacks.length >
        0
    ) {
      target =
        loopbacks[0];
    }
    if (
      target
    ) {
      try {
        this.micStream =
          await navigator.mediaDevices.getUserMedia(
            {
              audio: {
                deviceId: {
                  exact:
                    target.deviceId,
                },
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              },
            },
          );
        const source =
          this.ctx.createMediaStreamSource(
            this.micStream,
          );
        source.connect(
          this.analyser,
        );
        this.outputDeviceId =
          target.deviceId;
        this.outputMethod =
          "loopback";
        this._resetAdaptiveGain();
        return true;
      } catch (
        e
      ) {
        // 回环设备打开失败 → 继续走屏幕共享兜底
      }
    }
    // 路径 2：屏幕共享捕获
    const ok =
      await this.startSystem();
    if (
      ok
    ) {
      this.outputMethod =
        "display";
    }
    return ok;
  }

  // 枚举所有虚拟回环输入设备（可承载系统音频输出的虚拟声卡）
  async listLoopbackDevices() {
    const devices =
      await this.listInputDevices();
    return devices.filter(
      (
        d,
      ) =>
        AudioEngine.isLoopbackName(
          d.label,
        ),
    );
  }

  // --- 屏幕共享捕获（OUTPUT 兜底路径）---
  // Chrome/Edge 共享整个屏幕时勾选"分享系统音频"，
  // 或共享某个标签页时勾选"分享标签页音频"。
  async startSystem() {
    this.lastError = "";
    // 能力检测：预览 iframe / 旧浏览器可能根本没有 getDisplayMedia
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getDisplayMedia
    ) {
      this.lastError = "unsupported";
      return false;
    }
    try {
      this.sysStream =
        await navigator.mediaDevices.getDisplayMedia(
          {
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
            // 提示浏览器包含系统级音频（Chrome 105+ 支持该 hint）
            systemAudio:
              "include",
            // 优先把"整个屏幕"排在选择器前面（更接近"监听全部软件"）
            preferCurrentTab: false,
          },
        );
      // 用户选了共享但没勾"分享音频" → 无音频轨，必须给出明确提示
      const audioTracks =
        this.sysStream.getAudioTracks();
      if (
        audioTracks.length ===
        0
      ) {
        this.sysStream
          .getTracks()
          .forEach(
            (
              t,
            ) =>
              t.stop(),
          );
        this.sysStream =
          null;
        this.lastError =
          "no-audio";
        return false;
      }
      // 仅保留音频轨（视频轨立即停掉，省资源）
      this.sysStream
        .getVideoTracks()
        .forEach(
          (
            t,
          ) =>
            t.stop(),
        );
      const source =
        this.ctx.createMediaStreamSource(
          this.sysStream,
        );
      source.connect(
        this.analyser,
      );
      // 重置自适应增益，让新音源快速进入满动态
      this._resetAdaptiveGain();
      // 用户点浏览器"停止共享"时通知上层切换 UI
      audioTracks[0].addEventListener(
        "ended",
        () => {
          this.sysStream =
            null;
          if (
            this.onSysEnded
          )
            this.onSysEnded();
        },
      );
      return true;
    } catch (
      e
    ) {
      this.lastError =
        "cancelled";
      return false;
    }
  }

  // 重置自适应增益峰值（切换音源时调用）
  _resetAdaptiveGain() {
    this._peakBass = 0.1;
    this._peakMid = 0.1;
    this._peakTreble = 0.1;
    this._bassAvg = 0;
    this._beat = 0;
  }

  stopSystem() {
    if (
      this.sysStream
    ) {
      this.sysStream
        .getTracks()
        .forEach(
          (
            t,
          ) =>
            t.stop(),
        );
      this.sysStream =
        null;
    }
  }

  // --- MIDI 输入 ---
  // 通过 Web MIDI API 监听外接 MIDI 键盘/控制器，
  // 把音符编号转成频率，直接驱动 SIM 频率（与滑块、纯音同一条路径）。
  async startMidi() {
    this.midiEnabled = false;
    this.lastError = "";
    if (
      !navigator.requestMIDIAccess
    ) {
      this.lastError = "unsupported";
      return false;
    }
    try {
      this.midiAccess =
        await navigator.requestMIDIAccess(
          {
            sysex: false,
          },
        );
    } catch (
      e
    ) {
      this.lastError = "denied";
      return false;
    }
    this._bindMidiInputs();
    // 设备热插拔时重新绑定
    this.midiAccess.onstatechange =
      () =>
        this._bindMidiInputs();
    return true;
  }

  _bindMidiInputs() {
    if (
      !this.midiAccess
    )
      return;
    // 先断开旧监听，避免重复绑定
    if (
      this.midiInputs
    ) {
      for (
        const inp of this.midiInputs.values()
      ) {
        inp.onmidimessage = null;
      }
    }
    this.midiInputs =
      this.midiAccess.inputs;
    let any = false;
    for (
      const inp of this.midiInputs.values()
    ) {
      inp.onmidimessage = (
        e,
      ) =>
        this._handleMidi(
          e,
        );
      any = true;
    }
    this.midiEnabled = any;
    this.lastError = any
      ? ""
      : "no-device";
    // 仅状态更新（无频率）：通知 UI 刷新设备状态文本
    if (
      this.onMidiNote
    )
      this.onMidiNote(
        null,
        null,
        this._midiStatusText(),
      );
  }

  _midiStatusText() {
    if (
      !this.midiAccess
    )
      return t(
        "midi.unavailable",
      );
    if (
      !this.midiEnabled
    )
      return t(
        "midi.noDevice",
      );
    return t(
      "midi.connected",
    );
  }

  _handleMidi(
    e,
  ) {
    const d =
      e.data;
    if (
      !d ||
      d.length <
        2
    )
      return;
    const status =
      d[0];
    const note = d[1];
    const velocity = d[2];
    const cmd =
      status &
      0xf0;
    // note on（velocity > 0）→ 驱动频率；note off / 0 速度保持上一音（last-note 优先）
    if (
      cmd ===
        0x90 &&
      velocity > 0
    ) {
      const freq =
        this.midiToFreq(
          note,
        );
      this.midiNote = note;
      this.setSimFreq(
        freq,
      );
      if (
        this.onMidiNote
      )
        this.onMidiNote(
          freq,
          note,
          this._midiStatusText(),
        );
    }
  }

  // MIDI 音符编号 → 频率（A4 = 69 = 440Hz，十二平均律）
  midiToFreq(
    note,
  ) {
    return (
      440 *
      Math.pow(
        2,
        (note - 69) /
          12,
      )
    );
  }

  stopMidi() {
    if (
      this.midiAccess
    ) {
      this.midiAccess.onstatechange =
        null;
    }
    if (
      this.midiInputs
    ) {
      for (
        const inp of this.midiInputs.values()
      ) {
        inp.onmidimessage = null;
      }
    }
    this.midiInputs = null;
    this.midiEnabled = false;
  }

  // --- SIM 模式发声 ---
  // 用单个正弦振荡器模拟激振器发出的单一振动频率（实时跟随滑块）。
  // 振荡器直接接扬声器（不经过 analyser），图形仍由 simFreq 数值直接驱动，
  // 两者频率一致，物理自洽。
  startSimTone() {
    // 关闭模拟声音时不出声（仅静音，不影响频率驱动图形）
    if (
      !this.simSoundEnabled
    )
      return;
    this.ensureContext();
    // 若已在运行则先清理，避免重复节点
    if (
      this.simOsc
    )
      this.stopSimTone();
    const osc =
      this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = this.simFreqHz;
    const g =
      this.ctx.createGain();
    g.gain.value = 0;
    osc.connect(
      g,
    );
    g.connect(
      this.ctx.destination,
    );
    osc.start();
    // 平滑淡入，避免咔哒声
    g.gain.setTargetAtTime(
      this.simVolume,
      this.ctx.currentTime,
      0.05,
    );
    this.simOsc = osc;
    this.simGain = g;
  }

  stopSimTone() {
    if (
      this.simGain
    ) {
      // 平滑淡出
      try {
        this.simGain.gain.setTargetAtTime(
          0,
          this.ctx.currentTime,
          0.03,
        );
      } catch (
        e
      ) {}
    }
    if (
      this.simOsc
    ) {
      const o =
        this.simOsc;
      // 等淡出后再真正停止
      try {
        o.stop(
          this.ctx.currentTime + 0.1,
        );
      } catch (
        e
      ) {}
      try {
        o.disconnect();
      } catch (
        e
      ) {}
      this.simOsc = null;
    }
    if (
      this.simGain
    ) {
      const g =
        this.simGain;
      setTimeout(
        () => {
          try {
            g.disconnect();
          } catch (
            e
          ) {}
        },
        200,
      );
      this.simGain = null;
    }
  }

  // 实时更新发声频率（滑块拖动时调用）
  setSimFreq(
    hz,
  ) {
    this.simFreqHz = hz;
    if (
      this.simOsc
    ) {
      this.simOsc.frequency.setTargetAtTime(
        hz,
        this.ctx.currentTime,
        0.02,
      );
    }
  }

  // 更新发声音量（0~1）
  setSimVolume(
    v,
  ) {
    this.simVolume = v;
    if (
      this.simGain
    ) {
      this.simGain.gain.setTargetAtTime(
        v,
        this.ctx.currentTime,
        0.05,
      );
    }
  }

  // 开关 SIM/MIDI 振荡器纯音：关闭→静音（停振荡器），开启→若处于 sim/midi 则重新发声
  setSimSound(
    enabled,
  ) {
    this.simSoundEnabled = !!enabled;
    if (
      !this.simSoundEnabled
    ) {
      this.stopSimTone();
    } else if (
      this.mode ===
        "sim" ||
      this.mode ===
        "midi"
    ) {
      this.startSimTone();
    }
  }

  // --- 每帧频谱分析 ---
  update() {
    if (
      !this.analyser
    ) {
      this._decay(
        0.9,
      );
      return;
    }
    this.analyser.getByteFrequencyData(
      this.freqData,
    );
    this.analyser.getFloatTimeDomainData(
      this.timeData,
    );

    // RMS（时域能量）
    let rms = 0;
    for (
      let i = 0;
      i <
      this.timeData.length;
      i++
    ) {
      rms +=
        this.timeData[
          i
        ] *
        this.timeData[
          i
        ];
    }
    rms = Math.sqrt(
      rms /
        this.timeData.length,
    );

    const n =
      this.freqData.length;
    const binHz =
      this.ctx.sampleRate /
      this.analyser.fftSize;

    // 频段平均能量（0~1）
    const band = (
      lo,
      hi,
    ) => {
      const a =
        Math.max(
          0,
          Math.floor(
            lo /
              binHz,
          ),
        );
      const b =
        Math.min(
          n - 1,
          Math.ceil(
            hi /
              binHz,
          ),
        );
      let s = 0;
      let c = 0;
      for (
        let i = a;
        i <= b;
        i++
      ) {
        s +=
          this.freqData[
            i
          ];
        c++;
      }
      return c
        ? s / c / 255
        : 0;
    };

    let bass =
      band(
        20,
        250,
      );
    let mid =
      band(
        250,
        2000,
      );
    let treble =
      band(
        2000,
        8000,
      );

    // --- 自适应增益归一化 ---
    // 外部软件播放音量不定（系统捕获往往偏小），
    // 用运行峰值（快攻慢衰）把每个频段拉到 0~1 满动态，
    // 图形的变形幅度因此与"歌曲本身的相对起伏"吻合，而非绝对音量。
    const attack = 0.5; // 峰值上升速度
    const release = 0.9985; // 峰值缓慢回落（约 10 秒半衰）
    const track = (
      peak,
      v,
    ) =>
      v > peak
        ? peak +
          (v -
            peak) *
            attack
        : Math.max(
            0.06,
            peak *
              release,
          );
    this._peakBass =
      track(
        this._peakBass,
        bass,
      );
    this._peakMid =
      track(
        this._peakMid,
        mid,
      );
    this._peakTreble =
      track(
        this._peakTreble,
        treble,
      );
    bass = clamp(
      bass /
        this._peakBass,
      0,
      1,
    );
    mid = clamp(
      mid /
        this._peakMid,
      0,
      1,
    );
    treble = clamp(
      treble /
        this._peakTreble,
      0,
      1,
    );

    // --- 节拍检测 ---
    // 低音瞬时值明显超过其慢速均值 → 鼓点脉冲（0~1，指数衰减）
    this._bassAvg +=
      (bass -
        this._bassAvg) *
      0.04;
    const onset =
      bass -
      this._bassAvg;
    if (
      onset > 0.25 &&
      bass > 0.4
    ) {
      this._beat = Math.min(
        1,
        this._beat +
          onset *
            1.6,
      );
    }
    this._beat *= 0.92;

    // 主频：能量最大 bin
    let maxV = 0;
    let maxI = 0;
    for (
      let i = 1;
      i < n;
      i++
    ) {
      if (
        this.freqData[
          i
        ] >
        maxV
      ) {
        maxV =
          this.freqData[
            i
          ];
        maxI = i;
      }
    }
    // 静止（无音频）时主频归零：能量低于阈值不再显示 ~21Hz 的虚假读数
    const dominant =
      maxV > 12
        ? maxI *
          binHz
        : 0;

    // 平滑（指数滑动）：k=0.5 在稳定与跟手之间平衡，
    // 与 analyser 内置 0.6 叠加后不会过度滞后（去掉了原先 0.35 的二次延迟）
    const k = 0.5;
    this._sBass +=
      (bass -
        this._sBass) *
      k;
    this._sMid +=
      (mid -
        this._sMid) *
      k;
    this._sTreble +=
      (treble -
        this._sTreble) *
      k;
    this._sDominant +=
      (dominant -
        this._sDominant) *
      k;
    this._sOverall =
      clamp(
        (this._sBass *
          1.0 +
          this._sMid *
            0.7 +
          this._sTreble *
            0.4) /
          2.1,
        0,
        1,
      );

    this._spectrum.bass =
      this._sBass;
    this._spectrum.mid =
      this._sMid;
    this._spectrum.treble =
      this._sTreble;
    this._spectrum.overall =
      this._sOverall;
    this._spectrum.dominantFreq =
      this._sDominant;
    this._spectrum.rms = rms;
    this._spectrum.beat =
      this._beat;
  }

  _decay(
    factor,
  ) {
    this._sBass *=
      factor;
    this._sMid *=
      factor;
    this._sTreble *=
      factor;
    this._sOverall *=
      factor;
    this._sDominant *=
      factor;
    this._spectrum.bass =
      this._sBass;
    this._spectrum.mid =
      this._sMid;
    this._spectrum.treble =
      this._sTreble;
    this._spectrum.overall =
      this._sOverall;
    this._spectrum.dominantFreq =
      this._sDominant;
    this._beat *= factor;
    this._spectrum.beat =
      this._beat;
  }
}
