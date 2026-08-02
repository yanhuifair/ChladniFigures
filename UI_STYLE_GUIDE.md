# Chladni UI Style Guide

这个文档用于复用当前项目的 UI 风格到其他工程。

## 1. 设计目标

- 基调：极简、工程感、终端风。
- 主体：黑色背景 + 灰白信息层。
- 重点：状态变化要清晰，非激活信息尽量弱化。

## 2. 视觉变量（Design Tokens）

建议直接复用以下变量命名：

```css
:root {
  --font-mono: "Cascadia Code", "SF Mono", "Fira Code", "Consolas", "Menlo", monospace;
  --ui-edge: 28px;
  --c-bg: #000000;
  --c-surface: #0a0a0a;
  --c-border: #2a2a2a;
  --c-text: #cccccc;
  --c-dim: #555555;
  --c-accent: #ffffff;
  --c-active: #ffffff;
}
```

颜色语义：

- `--c-bg`: 全局背景。
- `--c-surface`: 浮层/卡片底色。
- `--c-border`: 线框、控件边框。
- `--c-text`: 主文本。
- `--c-dim`: 次级说明、标签。
- `--c-accent`: 高亮文本。
- `--c-active`: 激活态背景（白底黑字）。

## 3. 排版规范

- 字体统一使用 `Cascadia Code` 系列等宽栈。
- 文本分层：
- 标题/标签：`10px`，大写，`letter-spacing: 1px`。
- 主数值（如频率）：`32px` 左右。
- 面板内容：`10px ~ 12px`。
- 所有标签建议 `text-transform: uppercase`。

## 4. 布局规范

- 统一留白边距：`--ui-edge`（当前为 `28px`）。
- 左上：系统标题。
- 左下：主控制面板（音源、模式、开关）。
- 右下：状态信息（源、模式、频率）。
- 中下：附加控制（例如模拟频率滑条）。
- 画布始终全屏，UI 使用 `position: fixed` 覆盖。

## 5. 控件样式规范

### 5.1 按钮（通用）

- 默认：透明底，灰字，细边框。
- Hover：深灰背景（如 `#1a1a1a`），文字变亮。
- Active：白底黑字，字重提升（`font-weight: 700`）。

### 5.2 网格按钮（模式选择）

- 使用规则网格布局（3 列）。
- 单元格边框线清晰，激活态同上。
- 顶部 `AUTO` 可作为跨列按钮。

### 5.3 线性滑条

- 轨道：1px 细线。
- 滑块：方形，黑底白边。
- 外层面板建议半透明黑底 + 细边框。

### 5.4 开关按钮（如粒子显示）

- 文案使用 `KEY: ON/OFF` 形式。
- 激活态高对比显示。
- 状态需可持久化（localStorage）。

## 6. 交互与状态

- 所有核心开关状态必须可视化，且激活态可一眼识别。
- 鼠标悬停只做轻量反馈，不做大动画。
- 键盘快捷键可选，但需要与按钮状态同步。
- 状态建议本地持久化：
- 例如 `selectedMode`、`audioSource`、`simFreq`、`showParticles`。

## 7. 弹层规范（权限/引导）

- 全屏暗罩：`rgba(0,0,0,0.88)`。
- 居中卡片：深色背景 + 浅色边框。
- 主按钮：白边透明底，hover 反色。
- 次按钮：弱化边框和颜色。

## 8. 复用建议

- 优先复用 token 和状态语义，不要只复制颜色值。
- 新工程保留“灰弱-白强”的层级关系即可替换布局细节。
- 如需主题扩展，先新增 token，再映射到组件，不要直接写死颜色。

## 9. 最小可复制模板

下面这份模板可直接复制到新项目作为起点。

### 9.1 最小 CSS

```css
:root {
  --font-mono: "Cascadia Code", "SF Mono", "Fira Code", "Consolas", "Menlo", monospace;
  --ui-edge: 28px;
  --c-bg: #000;
  --c-surface: #0a0a0a;
  --c-border: #2a2a2a;
  --c-text: #ccc;
  --c-dim: #555;
  --c-accent: #fff;
  --c-active: #fff;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: var(--c-bg);
  color: var(--c-text);
  font-family: var(--font-mono);
  overflow: hidden;
  width: 100vw;
  height: 100vh;
}

canvas {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.title-bar {
  position: fixed;
  top: var(--ui-edge);
  left: var(--ui-edge);
  z-index: 10;
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--c-dim);
}

.panel {
  position: fixed;
  left: var(--ui-edge);
  bottom: var(--ui-edge);
  z-index: 10;
  min-width: 260px;
  font-size: 11px;
}

.panel-title,
.mode-label {
  color: var(--c-dim);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.panel-title {
  margin-bottom: 8px;
}

.audio-source,
.mode-grid,
.toggle-row {
  border: 1px solid var(--c-border);
}

.audio-source {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin-bottom: 12px;
}

.mode-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}

.btn {
  border: none;
  border-right: 1px solid var(--c-border);
  border-bottom: 1px solid var(--c-border);
  background: transparent;
  color: var(--c-dim);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.5px;
  padding: 6px 8px;
  cursor: pointer;
}

.btn:hover {
  background: #1a1a1a;
  color: #aaa;
}

.btn.active {
  background: var(--c-active);
  color: #000;
  font-weight: 700;
}

.btn.full {
  grid-column: 1 / -1;
}

.toggle-row .btn {
  width: 100%;
  text-align: left;
  border-right: none;
  border-bottom: none;
}

.info {
  position: fixed;
  right: var(--ui-edge);
  bottom: var(--ui-edge);
  z-index: 10;
  text-align: right;
}

.info-meta {
  font-size: 10px;
  letter-spacing: 0.8px;
  color: var(--c-dim);
  text-transform: uppercase;
}

.freq {
  color: var(--c-accent);
  font-size: 32px;
  font-weight: 700;
}

.freq span {
  color: var(--c-dim);
  font-size: 13px;
  font-weight: 400;
}
```

### 9.2 最小 HTML 结构

```html
<canvas id="canvas"></canvas>

<div class="title-bar">CHLADNI PLATE</div>

<div class="panel">
  <div class="panel-title">AUDIO SOURCE</div>
  <div class="audio-source">
    <button class="btn">MIC</button>
    <button class="btn">SYS</button>
    <button class="btn active">SIM</button>
    <button class="btn">SYNTH</button>
  </div>

  <div class="mode-label">GRID MODE (m, n)</div>
  <div class="mode-grid">
    <button class="btn full">AUTO</button>
    <button class="btn">(1,1)</button>
    <button class="btn">(1,2)</button>
    <button class="btn">(2,2)</button>
  </div>

  <div class="toggle-row" style="margin-top: 10px;">
    <button class="btn">PARTICLES: ON</button>
  </div>
</div>

<div class="info">
  <div class="info-meta">SRC SIM GRID (2,2)</div>
  <div class="freq">440 <span>Hz</span></div>
</div>
```

### 9.3 状态命名建议

- 布尔开关：`showParticles`, `showOverlay`。
- 选择态：`selectedMode`, `audioSource`。
- 数值态：`simFreq`, `detectedFreq`。
- 本地存储键：`<project-name>-preferences`。
