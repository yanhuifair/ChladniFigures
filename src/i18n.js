// GNU Affero General Public License v3.0 — Copyright (c) 2026 Fair
// SPDX-License-Identifier: AGPL-3.0

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
    "app.title": "Chladni Plate",
    "app.bigTitle": "CHLADNI PLATE",
    "app.brand": "CHLADNI PLATE BY FAIR",
    "app.githubTitle": "View source code on GitHub",
    "app.githubAria": "GitHub repository",
    "app.versionLabel": "VERSION",
    "save.image": "SAVE IMAGE",
    "btn.fullscreen": "FULLSCREEN",
    "btn.fullscreenHint": "Press F or click the plate to toggle fullscreen, ESC to exit",
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
    "src.share": "SHARE",
    "src.shareTitle": "Pop the system-audio share request",
    // 子标题
    "sub.inputDevice": "INPUT DEVICE",
    "sub.outputDevice": "OUTPUT DEVICE",
    "sub.simInput": "SIMULATED INPUT",
    "sub.midiInput": "MIDI INPUT",
    "sub.plateShape": "PLATE SHAPE",
    "shape.square": "SQUARE",
    "shape.circle": "CIRCLE",
    "shape.triangle": "TRIANGLE",
    "shape.hexagon": "HEXAGON",
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
    "level.relative": "Relative loudness (auto-scaled to recent peak)",
    // 悬停提示（data-i18n-attr title）
    "hint.audioSource": "Choose where the driving audio comes from",
    "hint.input": "Analyze sound captured from your microphone",
    "hint.output": "Listen to system audio (virtual soundcard or screen share)",
    "hint.simulation": "Sweep a synthetic frequency; the figure follows it live",
    "hint.midi": "Drive the figure from a connected MIDI device",
    "hint.inputDevice": "Select the microphone / input device",
    "hint.outputDevice": "Select the system output device to tap",
    "hint.simInput": "Drag to set the simulated frequency",
    "hint.simSound": "Toggle whether SIMULATION and MIDI emit a tone",
    "hint.midiInput": "Status of the connected MIDI device",
    "hint.volBoost": "Multiply the analyzed volume before visualization",
    "hint.patternParams": "Tune the plate and the sand",
    "hint.plateShape": "Choose the plate geometry",
    "hint.shapeSquare": "Square plate — classic cos(mπu)cos(nπv) modes",
    "hint.shapeCircle": "Circular plate — Bessel Jₙ(z·r)cos(nθ) modes",
    "hint.shapeTriangle": "Equilateral triangle plate — grating approximation",
    "hint.shapeHexagon": "Regular hexagon plate — grating approximation",
    "hint.squareSign": "Switch the square sign: − difference form / + sum form",
    "hint.pattern": "Show or hide the guide nodal lines",
    "hint.particles": "Show or hide the sand grains",
    "hint.collision": "Let grains repel each other so they pile into bands",
    "hint.rim": "Pull stray grains to the plate edge so they accumulate along the rim",
    "hint.sandGrains": "Number of sand grains",
    "hint.sandGrain": "Diameter of each grain",
    "hint.stiffness": "Plate stiffness — raises the mode frequencies",
    "hint.plateSide": "Physical side length of the square plate",
    "hint.info": "Live readouts of the current figure",
    "hint.source": "Current audio source",
    "hint.mode": "Current Chladni mode (m×n)",
    "hint.frequency": "Driving frequency",
    "hint.resonance": "Resonance / dominant-frequency strength",
    "hint.save": "Save the current view as a PNG",
    "hint.listenSys": "Grant access to listen to system audio",
    "hint.mic": "Grant microphone access",
    "hint.skip": "Skip and start in manual simulation mode",
    // 开关
    "label.pattern": "PATTERN",
    "label.particles": "PARTICLES",
    "label.simSound": "SIMULATION SOUND",
    "label.collision": "COLLISION",
    "label.rim": "RIM",
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
    "app.title": "克拉尼板",
    "app.bigTitle": "克拉尼板",
    "app.brand": "克拉尼板 · 作者 FAIR",
    "app.githubTitle": "在 GitHub 上查看源码",
    "app.githubAria": "GitHub 仓库",
    "app.versionLabel": "版本",
    "save.image": "保存图像",
    "btn.fullscreen": "全屏",
    "btn.fullscreenHint": "按 F 或点击底板切换全屏，ESC 退出",
    "perm.desc":
      "实时音频驱动的克拉尼板粒子模拟<br>监听电脑上其他软件播放的音乐，图形随歌实时变形",
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
    "src.share": "共享",
    "src.shareTitle": "弹出系统音频共享请求",
    "sub.inputDevice": "输入设备",
    "sub.outputDevice": "输出设备",
    "sub.simInput": "模拟输入",
    "sub.midiInput": "MIDI 输入",
    "sub.plateShape": "底板形状",
    "shape.square": "正方形",
    "shape.circle": "圆形",
    "shape.triangle": "三角形",
    "shape.hexagon": "六边形",
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
    "level.relative": "相对响度（自动对齐近期峰值）",
    // 悬停提示（data-i18n-attr title）
    "hint.audioSource": "选择驱动图形的音源",
    "hint.input": "分析来自麦克风的声音",
    "hint.output": "监听系统音频（虚拟声卡或屏幕共享）",
    "hint.simulation": "扫描合成频率，图形实时跟随",
    "hint.midi": "用连接的 MIDI 设备驱动图形",
    "hint.inputDevice": "选择麦克风 / 输入设备",
    "hint.outputDevice": "选择要采集的系统输出设备",
    "hint.simInput": "拖动以设置模拟频率",
    "hint.simSound": "开关 SIMULATION 与 MIDI 是否发声",
    "hint.midiInput": "已连接 MIDI 设备的状态",
    "hint.volBoost": "在可视化前放大分析到的音量",
    "hint.patternParams": "调整底板与沙粒",
    "hint.plateShape": "选择底板形状",
    "hint.shapeSquare": "方形板——经典 cos(mπu)cos(nπv) 模态",
    "hint.shapeCircle": "圆形板——贝塞尔 Jₙ(z·r)cos(nθ) 模态",
    "hint.shapeTriangle": "等边三角形板——光栅近似",
    "hint.shapeHexagon": "正六边形板——光栅近似",
    "hint.squareSign": "切换方板符号：− 差形式 / + 和形式",
    "hint.pattern": "显示或隐藏引导节线",
    "hint.particles": "显示或隐藏沙粒",
    "hint.collision": "让沙粒互相排斥，沿节线堆成沙带",
    "hint.rim": "把散落的沙粒吸到板边，沿轮廓堆积成沙带",
    "hint.sandGrains": "沙粒数量",
    "hint.sandGrain": "沙粒直径",
    "hint.stiffness": "底板硬度——抬高各模式频率",
    "hint.plateSide": "方形底板的物理边长",
    "hint.info": "当前图形的实时读数",
    "hint.source": "当前音源",
    "hint.mode": "当前克拉尼模式 (m×n)",
    "hint.frequency": "驱动频率",
    "hint.resonance": "共振 / 主频强度",
    "hint.save": "把当前画面保存为 PNG",
    "hint.listenSys": "授权监听系统音频",
    "hint.mic": "授权使用麦克风",
    "hint.skip": "跳过并进入手动模拟模式",
    "label.pattern": "图案",
    "label.particles": "粒子",
    "label.simSound": "模拟声音",
    "label.collision": "碰撞",
    "label.rim": "贴边",
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
