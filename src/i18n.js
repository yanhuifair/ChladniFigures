// MIT License — Copyright (c) 2026 Fair
// SPDX-License-Identifier: MIT

// ============================================================
//  i18n.js — 多语言支持（按浏览器语言自动选择）
//  仅内置 en / zh 两套；浏览器语言以 zh 开头则中文，否则英文。
//  HTML 静态文案用 data-i18n / data-i18n-html 标注；
//  JS 动态文案（提示条、状态、音源名等）统一走 t()。
// ============================================================

// 读取浏览器语言偏好（navigator.languages 由用户显式排序，最可信）
function detectLocale() {
  const langs =
    (navigator.languages &&
      navigator.languages.length)
      ? navigator.languages
      : [
        navigator.language ||
        "en",
      ];
  for (
    const l of langs
  ) {
    const code =
      String(
        l ||
        "",
      ).toLowerCase();
    if (
      code.startsWith(
        "zh",
      )
    )
      return "zh";
    if (
      code.startsWith(
        "en",
      )
    )
      return "en";
  }
  return "en";
}

const DICT = {
  // ===================== 英文 =====================
  en: {
    // 浏览器标签 / 顶栏保存按钮
    "app.title": "Chladni Figures",
    "app.bigTitle": "CHLADNI FIGURES",
    "app.brand": "CHLADNI FIGURES BY FAIR",
    "app.githubTitle": "View source code on GitHub",
    "app.githubAria": "GitHub repository",
    "app.versionLabel": "VERSION",
    "save.image": "SAVE IMAGE",
    "btn.fullscreen": "FULLSCREEN",
    "btn.fullscreenHint": "Press F to toggle fullscreen, ESC to exit",
    // 引导层
    "perm.desc":
      "Real-time audio-driven Chladni figure particle simulation.<br>Listen to music from other apps; the figure morphs live with the song.",
    "perm.listenSys": "Listen to System Audio",
    "perm.mic": "Enable Microphone",
    "perm.skip": "Skip — Manual Simulation",
    // 段落标题
    "seg.audioSource": "AUDIO SOURCE",
    "seg.patternParams": "PATTERN PARAMETERS",
    "seg.info": "INFORMATION",
    // 音源按钮
    "src.input": "INPUT",
    "src.output": "OUTPUT",
    "src.simulation": "SIMULATION",
    "src.midi": "MIDI",
    // 子标题
    "sub.inputDevice": "INPUT DEVICE",
    "sub.outputDevice": "OUTPUT DEVICE",
    "sub.simInput": "SIMULATED INPUT",
    "sub.midiInput": "MIDI INPUT",
    // 参数标签
    "param.sandGrains": "SAND GRAINS",
    "param.plateSide": "PLATE SIDE",
    "param.stiffness": "STIFFNESS",
    "param.sandGrain": "SAND GRAIN",
    "param.volBoost": "VOLUME BOOST",
    // 信息段
    "info.source": "SOURCE",
    "info.mode": "MODE",
    "info.frequency": "FREQUENCY",
    "info.resonance": "RESONANCE",
    "info.volume": "VOLUME",
    // 开关
    "label.pattern": "PATTERN",
    "label.particles": "PARTICLES",
    "label.simSound": "SIMULATION SOUND",
    "label.collision": "COLLISION",
    "toggle.on": "{label}: ON",
    "toggle.off": "{label}: OFF",
    // MIDI 状态
    "midi.unavailable": "MIDI unavailable",
    "midi.noDevice": "No MIDI device detected",
    "midi.connected": "Connected",
    "midi.disconnected": "Not connected",
    // 设备
    "device.unnamed": "Unnamed device",
    "device.systemAudio": "{label} [system audio]",
    // 提示条
    "toast.outputNoAudio":
      "Shared successfully but no audio — please retry and check “Share system/tab audio”.",
    "toast.outputUnsupported":
      "System audio capture is not supported in this environment — open in a standalone Chrome / Edge tab (the preview panel cannot show permission prompts).",
    "toast.outputCancelled": "System output listening cancelled",
    "toast.micUnavailable": "System input device unavailable or permission denied",
    "toast.midiUnsupported":
      "Web MIDI is not supported in this browser — use Chrome / Edge.",
    "toast.midiNoDevice":
      "No MIDI device detected — connect a keyboard / controller and retry.",
    "toast.midiDenied": "MIDI permission denied",
    "toast.outputLoopback":
      "Listening to system output via virtual soundcard — play any song in any app.",
    "toast.outputDisplay":
      "Listening to system audio via screen share — play any song in any app.",
    "toast.loopbackHint":
      "Virtual soundcard detected — tap the OUTPUT source to listen to system audio.",
    "toast.outputDeviceFail": "Failed to open that output device",
    "toast.outputDevice":
      "Listening via “{name}” — set system output to a multi-output device including this virtual soundcard.",
    "toast.inputDeviceFail":
      "Failed to open that input device — reverted to default microphone.",
    "toast.inputDevice":
      "Listening via “{name}” — set system output to a multi-output device including this virtual soundcard.",
    "toast.outputStopped": "System output listening stopped",
    "toast.outputAutoResume":
      "Auto-restored system output listening (virtual soundcard).",
    "toast.midiAutoResume": "Auto-restored MIDI input",
    "toast.outputManualResume":
      "System output listening needs manual restore — tap OUTPUT at bottom-left to continue.",
    "toast.midiResumeFail": "MIDI restore failed — switched back to SIMULATION.",
    "toast.saveFail": "Save failed",
    "toast.saved": "Saved {name}",
  },

  // ===================== 中文 =====================
  zh: {
    "app.title": "克拉尼图形",
    "app.bigTitle": "克拉尼图形",
    "app.brand": "克拉尼图形 · 作者 FAIR",
    "app.githubTitle": "在 GitHub 上查看源码",
    "app.githubAria": "GitHub 仓库",
    "app.versionLabel": "版本",
    "save.image": "保存图像",
    "btn.fullscreen": "全屏",
    "btn.fullscreenHint": "按 F 切换全屏，ESC 退出",
    "perm.desc":
      "实时音频驱动的克拉尼图形粒子模拟<br>监听电脑上其他软件播放的音乐，图形随歌实时变形",
    "perm.listenSys": "监听电脑播放的音乐",
    "perm.mic": "启用麦克风",
    "perm.skip": "跳过 — 手动模拟模式",
    "seg.audioSource": "音频源",
    "seg.patternParams": "图形参数",
    "seg.info": "信息",
    "src.input": "输入",
    "src.output": "输出",
    "src.simulation": "模拟",
    "src.midi": "MIDI",
    "sub.inputDevice": "输入设备",
    "sub.outputDevice": "输出设备",
    "sub.simInput": "模拟输入",
    "sub.midiInput": "MIDI 输入",
    "param.sandGrains": "沙粒数量",
    "param.plateSide": "底板边长",
    "param.stiffness": "底板硬度",
    "param.sandGrain": "沙粒直径",
    "param.volBoost": "音量增强",
    "info.source": "音源",
    "info.mode": "模式",
    "info.frequency": "频率",
    "info.resonance": "共振",
    "info.volume": "音量",
    "label.pattern": "图案",
    "label.particles": "粒子",
    "label.simSound": "模拟声音",
    "label.collision": "碰撞",
    "toggle.on": "{label}：开",
    "toggle.off": "{label}：关",
    "midi.unavailable": "MIDI 不可用",
    "midi.noDevice": "未检测到 MIDI 设备",
    "midi.connected": "已连接",
    "midi.disconnected": "未连接",
    "device.unnamed": "未命名设备",
    "device.systemAudio": "{label}（系统音频）",
    "toast.outputNoAudio":
      "共享成功但没有音频 — 请重试并勾选「同时分享系统音频/标签页音频」",
    "toast.outputUnsupported":
      "当前环境不支持系统音频捕获 — 请用 Chrome / Edge 在独立浏览器标签页打开（预览面板内无法弹出权限）",
    "toast.outputCancelled": "已取消系统输出监听",
    "toast.micUnavailable": "系统输入设备不可用或权限被拒绝",
    "toast.midiUnsupported": "当前浏览器不支持 Web MIDI — 请用 Chrome / Edge 打开",
    "toast.midiNoDevice": "未检测到 MIDI 设备 — 请连接键盘/控制器后重试",
    "toast.midiDenied": "MIDI 权限被拒绝",
    "toast.outputLoopback":
      "正在从虚拟声卡监听系统输出 — 播放任意软件里的歌曲即可",
    "toast.outputDisplay":
      "正在通过屏幕共享监听系统音频 — 播放任意软件里的歌曲即可",
    "toast.loopbackHint":
      "检测到虚拟声卡 — 想监听电脑播放的音乐请点 OUTPUT 音源",
    "toast.outputDeviceFail": "该输出设备打开失败",
    "toast.outputDevice":
      "正在从「{name}」监听系统输出 — 请把系统输出设为多输出设备（含该虚拟声卡）",
    "toast.inputDeviceFail": "该输入设备打开失败，已回退默认麦克风",
    "toast.inputDevice":
      "正在从「{name}」监听系统音频 — 请把系统输出设为多输出设备（含该虚拟声卡）",
    "toast.outputStopped": "系统输出监听已停止",
    "toast.outputAutoResume": "已自动恢复系统输出监听（虚拟声卡直采）",
    "toast.midiAutoResume": "已自动恢复 MIDI 输入",
    "toast.outputManualResume":
      "系统输出监听需手动恢复 — 点左下角 OUTPUT 继续",
    "toast.midiResumeFail": "MIDI 恢复失败 — 已切回模拟模式",
    "toast.saveFail": "保存失败",
    "toast.saved": "已保存 {name}",
  },
};

export const locale = detectLocale();
const STRINGS = DICT[
  locale
] ||
  DICT.en;

// 取文案；支持 {name} 这类占位符替换；缺失则回退英文，再无则回退 key 本身
export function t(
  key,
  params,
) {
  let s =
    STRINGS[
      key
    ];
  if (
    s ===
    undefined
  )
    s =
      DICT.en[
        key
      ] !==
        undefined
        ? DICT.en[
          key
        ]
        : key;
  if (
    params &&
    typeof s ===
      "string"
  ) {
    for (
      const k in params
    ) {
      s = s.split(
        "{" +
        k +
        "}",
      ).join(
        String(
          params[
            k
          ],
        ),
      );
    }
  }
  return s;
}

// 把标注了 data-i18n（纯文本）/ data-i18n-html（含 <br> 等片段）的元素翻译成当前语言
export function applyStaticI18n(
  root,
) {
  const scope =
    root ||
    document;
  scope.querySelectorAll(
    "[data-i18n]",
  ).forEach(
    (
      el,
    ) => {
      el.textContent = t(
        el.getAttribute(
          "data-i18n",
        ),
      );
    },
  );
  scope.querySelectorAll(
    "[data-i18n-html]",
  ).forEach(
    (
      el,
    ) => {
      el.innerHTML = t(
        el.getAttribute(
          "data-i18n-html",
        ),
      );
    },
  );
  // 局部属性：data-i18n-attr="title:btn.key;placeholder:btn.key2"
  // 把指定属性值翻译为当前语言（用于按钮提示等）
  scope.querySelectorAll(
    "[data-i18n-attr]",
  ).forEach(
    (
      el,
    ) => {
      const spec =
        el.getAttribute(
          "data-i18n-attr",
        );
      spec
        .split(
          ";",
        )
        .forEach(
          (
            pair,
          ) => {
            const idx =
              pair.indexOf(
                ":",
              );
            if (
              idx <= 0
            )
              return;
            const attr =
              pair
                .slice(
                  0,
                  idx,
                )
                .trim();
            const key =
              pair
                .slice(
                  idx + 1,
                )
                .trim();
            if (
              attr &&
              key
            )
              el.setAttribute(
                attr,
                t(
                  key,
                ),
              );
          },
        );
    },
  );
}

// 同步 <html lang>，便于浏览器/搜索引擎识别页面语言
if (
  typeof document !==
  "undefined"
) {
  document.documentElement.lang =
    locale ===
    "zh"
      ? "zh-CN"
      : "en";
}
