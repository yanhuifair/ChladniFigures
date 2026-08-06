// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

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
    // 音源切换代际号：每次 setSource / shareSystemAudio 递增。
    // 异步授权（getUserMedia/getDisplayMedia）迟到返回时据此判定「已被更新的选择覆盖」，
    // 丢弃该流（stop tracks）并返回 "stale"，防止旧回调覆盖最新音源状态。
    this._srcGen = 0;
    // 当前接入 analyser 的 MediaStreamSource 节点（切源时需 disconnect，防 AudioNode 泄漏）
    this._micSource = null;
    this._sysSource = null;

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
    this._peakRms = 0.1; // 响度自适应峰值（相对响度归一化用）

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
      loudness: 0,
      rms: 0,
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
    this.volGain = 1; // 后期增益（0.1~10×）：供 SIM/MIDI 虚拟响度计算使用
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

  // 切换音源：先停掉所有，再建立目标音源。
  // 返回 true=成功 / false=失败（lastError 说明原因）/ "stale"=已被更新的切换覆盖（调用方勿更新状态）。
  async setSource(
    mode,
  ) {
    const gen = ++this._srcGen;
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
      if (
        gen !==
        this._srcGen
      ) {
        // 授权期间用户已切到别的音源：停掉刚拿到的流，防止麦克风灯常亮
        this.stopMic();
        return "stale";
      }
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
      if (
        gen !==
        this._srcGen
      ) {
        this.stopSystem();
        return "stale";
      }
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
      if (
        gen !==
        this._srcGen
      ) {
        this.stopMidi();
        return "stale";
      }
      // MIDI 同样用 SIM 振荡器发出对应频率的纯音（驱动板面振动）
      this.startSimTone();
      return ok;
    } else if (
      mode ===
      "share"
    ) {
      // SHARE 属「输入音源」：只分析不外放（防回授），走屏幕共享捕获
      this.ensureContext();
      if (
        this.ctx.state ===
        "suspended"
      )
        await this.ctx.resume();
      this._setAudible(
        false,
      );
      // 复用当前代际号：shareSystemAudio 内部不再自行递增，避免双重计数
      const ok =
        await this.shareSystemAudio(
          gen,
        );
      if (
        gen !==
        this._srcGen
      ) {
        this.stopAll();
        return "stale";
      }
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
      this._micSource = source;
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
      this._micSource
    ) {
      try {
        this._micSource.disconnect();
      } catch (
        e
      ) {}
      this._micSource =
        null;
    }
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

  // 显式弹出"共享系统音频"请求（getDisplayMedia），
  // 跳过虚拟回环声卡直采。SHARE 按钮调用：无论是否检测到回环设备，
  // 都直接走屏幕共享兜底路径（含"分享系统音频"勾选提示）。
  // gen 可选：由 setSource("share") 传入以共享同一代际号；独立调用（SHARE 按钮）
  // 时内部自行递增。返回 true / false / "stale"（被更新的切换覆盖）。
  async shareSystemAudio(
    gen,
  ) {
    const g =
      gen ??
      ++this._srcGen;
    this.ensureContext();
    if (
      this.ctx.state ===
      "suspended"
    )
      await this.ctx.resume();
    this._setAudible(
      false,
    );
    this.stopAll();
    this.outputMethod = "";
    const ok =
      await this.startSystem();
    if (
      g !==
      this._srcGen
    ) {
      // 弹窗等待期间用户已切到别的音源：停掉刚共享的流（含视频轨）
      this.stopSystem();
      return "stale";
    }
    if (
      ok
    ) {
      this.mode =
        "share";
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
      this._sysSource = source;
      source.connect(
        this.analyser,
      );
      // 重置自适应增益，让新音源快速进入满动态
      this._resetAdaptiveGain();
      // 用户点浏览器"停止共享"时通知上层切换 UI。
      // 只响应「当前这条流」的 ended：切源/旧授权停止时旧 track 也会触发
      // ended，若不加守卫会把新建立的 sysStream 误清空（陈旧监听问题）。
      const thisTrack =
        audioTracks[0];
      thisTrack.addEventListener(
        "ended",
        () => {
          if (
            this.sysStream &&
            this.sysStream.getAudioTracks()[0] !==
              thisTrack
          )
            return;
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
      this._sysSource
    ) {
      try {
        this._sysSource.disconnect();
      } catch (
        e
      ) {}
      this._sysSource =
        null;
    }
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

  // 后期增益（volGain 0.1~10×）：供 SIM/MIDI 虚拟响度计算使用
  setVolGain(
    g,
  ) {
    this.volGain =
      clamp(
        g,
        0.1,
        10,
      );
  }

  // 自适应峰值跟踪（快攻慢衰），与 FFT / 纯音共用
  _track(
    peak,
    v,
  ) {
    const attack = 0.5;
    const release = 0.9985;
    return v > peak
      ? peak +
        (v -
          peak) *
          attack
      : Math.max(
        0.06,
        peak *
          release,
      );
  }

  // 将原始频段能量（含 FFT 或纯音合成）统一做：
  // 自适应归一化 → 归一化响度(loudness) → 节拍 → 主频/各带平滑 → overall → 写入 _spectrum
  _applyBands(
    rawBass,
    rawMid,
    rawTreble,
    dominant,
    rms,
    loudnessOverride,
  ) {
    this._peakBass =
      this._track(
        this._peakBass,
        rawBass,
      );
    this._peakMid =
      this._track(
        this._peakMid,
        rawMid,
      );
    this._peakTreble =
      this._track(
        this._peakTreble,
        rawTreble,
      );
    const bass = clamp(
      rawBass /
        this._peakBass,
      0,
      1,
    );
    const mid = clamp(
      rawMid /
        this._peakMid,
      0,
      1,
    );
    const treble = clamp(
      rawTreble /
        this._peakTreble,
      0,
      1,
    );

    // 归一化响度：loudnessOverride 由调用方提供时优先使用
    //（SIM/MIDI 用增益合成的虚拟响度；真实音源用绝对 dBFS 基准），
    // 否则退化为相对自适应峰值（rms / 峰值）
    this._peakRms =
      this._track(
        this._peakRms,
        rms,
      );
    const loudness =
      loudnessOverride !==
      undefined
        ? clamp(
            loudnessOverride,
            0,
            1,
          )
        : clamp(
            rms /
              this._peakRms,
            0,
            1,
          );

    // 节拍检测
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

    // 平滑
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
    this._sOverall = clamp(
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
    this._spectrum.loudness =
      loudness;
    this._spectrum.beat =
      this._beat;
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

    // 纯音音源（sim / midi）：振荡器不经 analyser，改由数值频率合成频谱，
    // 使频谱条随音高移动，与 FFT 路径同构
    if (
      this.mode ===
        "sim" ||
      this.mode ===
        "midi"
    ) {
      const f =
        this.simFreqHz;
      let b = 0;
      let m = 0;
      let t = 0;
      if (
        f < 250
      )
        b = 1;
      else if (
        f < 2000
      )
        m = 1;
      else
        t = 1;
      // 虚拟响度：依增益（volGain 0.1~10×）映射到 60~95 dB 显示档（loud 0.5~0.79）；
      // 振荡器静音（simSoundEnabled=false）时归零，避免 SIM/MIDI 显示恒为 120 dB 假值
      let virtualLoud = 0;
      if (
        this.simSoundEnabled
      ) {
        const g =
          clamp(
            this.volGain,
            0.1,
            10,
          );
        const norm =
          (Math.log10(
            g,
          ) +
            1) /
          2; // 0.1×→0, 1×→0.5, 10×→1
        virtualLoud =
          clamp(
            0.5 +
              norm *
                0.29,
            0,
            1,
          );
      }
      this._applyBands(
        b,
        m,
        t,
        f,
        0.5,
        virtualLoud,
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

    const rawBass =
      band(
        20,
        250,
      );
    const rawMid =
      band(
        250,
        2000,
      );
    const rawTreble =
      band(
        2000,
        8000,
      );

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

    // 绝对 dBFS 基准：rms∈(0,1] 对应 dBFS∈(-∞,0]，映射到 loud 0(静音)~1(满幅)，
    // 替代原来的相对自适应峰值，使同一真实音量读数稳定、不再随近期峰值漂移/虚高
    const absLoud =
      clamp(
        (20 *
          Math.log10(
            Math.max(
              rms,
              1e-6,
            ),
          ) +
          120) /
          120,
        0,
        1,
      );
    this._applyBands(
      rawBass,
      rawMid,
      rawTreble,
      dominant,
      rms,
      absLoud,
    );
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
    this._spectrum.loudness *=
      factor;
    this._spectrum.rms *=
      factor;
    this._beat *= factor;
    this._spectrum.beat =
      this._beat;
  }
}
