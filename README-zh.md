# 克拉尼板

实时、音频驱动的克拉尼板粒子可视化。沙粒粒子沿克拉尼驻波场的梯度滑动，
最终沉降在节线（ψ=0）上；图形会**随你播放的内容实时连续变形**。

> English documentation: [README.md](./README.md)

## 核心特性

- **系统输出监听（推荐）** — 点 `OUTPUT`，实时监听任何软件（音乐 App、视频、
  浏览器）正在播放的声音，图形随歌实时变形。检测到虚拟回环声卡时**自动直采**
  （无弹窗、刷新自动恢复）；否则兜底屏幕共享捕获（选 **整个屏幕** 并勾选
  **同时分享系统音频**）。自适应增益把外部播放的实际动态范围自动拉满，
  节拍检测让板面和沙粒跟着鼓点跳动。
- **系统输入监听** — 点 `INPUT` 使用麦克风等任意输入设备，
  可在 **INPUT DEVICE** 下拉框中切换具体设备。
- **MIDI 输入** — 点 `MIDI`，用任意 MIDI 键盘/控制器实时驱动图形，
  弹奏的音符会实时设定模式与频率。
- **模拟（Simulation）** — 点 `SIMULATION`，用滑条扫频；App 还会**发出对应
  频率的正弦音**，让你能听到正在拨入的频率。
- **连续变形** — 不再在离散模式间硬跳变，`(m, n)` 每帧平滑缓动逼近由频谱
  推导的目标值。
- **GPU 粒子加速** — 支持 WebGPU 的浏览器把整套粒子模拟（物理 + 碰撞 +
  实例化渲染）搬到 GPU；否则回退 Web Worker + WebGL2 路径，最终回退到
  同线程 WebGL2 + CPU 路径——即使十万粒子依然流畅。
- **保存为 PNG** — 右上角 **SAVE IMAGE** 按钮把底板纹理与 WebGL 粒子层
  合成为一张 PNG 并下载。
- **多语言** — 界面根据浏览器语言自动切换（目前支持 English / 中文）。
- **黑白极客风** — 纯黑板、白色节线、白色粒子、固定位置 HUD。

## 工程结构

```
index.html            UI 结构 + 模块入口
styles.css            黑白 HUD 样式（16/8/4 三档间距）
src/
  main.js             状态、主循环、频谱→(m,n) 映射、偏好持久化
  audio.js            AudioEngine：音源（麦克风/输出/MIDI/模拟）+ FFT 频段
                      分析 + 节拍检测
  chladni.js          纯数学：ψ(u,v,m,n)、梯度、频率→模式
  field-grid.js       波场粗网格缓存（CPU 物理与渲染共用）
  particle-records.js 沙粒渲染记录批处理（零对象分配）
  particles.js        高度图粒子物理（CPU 路径）
  particles-worker.js 后台线程物理 + WebGL2 绘制（回退加速）
  webgpu-particles.js WebGPU compute：物理 + 碰撞 + 实例化渲染（首选）
  render.js           离屏画布、底板纹理、CPU 粒子兜底
  render-gl.js        WebGL2 粒子层（回退渲染器）
  render-plate-gl.js  WebGL2 节线渲染（#platecanvas 层）
  ui.js               控件绑定 + 每帧 HUD 刷新
  i18n.js             语言检测 + 中/英词典
```

## 渲染管线

粒子层在启动时按以下顺序自动挑选可用度最高的后端：

1. **WebGPU（首选）** —— `webgpu-particles.js` 把整套模拟搬到 GPU：compute
   通道跑逐粒子物理、compute 通道跑空间网格碰撞（原子计数 + 邻居解重叠，
   使沙粒不可重叠、沿节线堆成有宽度的沙带）、实例化渲染通道画沙粒。
   需要 `navigator.gpu`。
2. **Web Worker + WebGL2（回退加速）** —— 若不支持 WebGPU，则把 JS 物理与
   WebGL2 沙粒绘制搬进 `particles-worker.js`（OffscreenCanvas），主线程只留
   音频分析与界面刷新。
3. **同线程 WebGL2 + CPU（最终回退）** —— 若不支持 Worker / OffscreenCanvas，
   则由 `render-gl.js` 在主线程用 `particles.js` 的 CPU 物理绘制沙粒。

底板与节线由 `render-plate-gl.js`（#platecanvas 上的 WebGL2）绘制；若缺少
WebGL2 则回退 Canvas2D 节线纹理。

## 运行

ES 模块需通过 HTTP 服务访问（不能用 `file://` 直接打开）：

```bash
cd /Users/Fair/Desktop/ChladniPlate
python3 -m http.server 8765
# 浏览器打开 http://localhost:8765/index.html
```

或使用自带脚本：

```bash
npm start
```

> 麦克风 / 屏幕共享 / MIDI 权限需要**真实浏览器标签页**（Chrome 或 Edge）。
> 应用内预览面板与 `file://` 打开方式无法申请这些权限。

## 操作

- **AUDIO SOURCE**：INPUT / OUTPUT / SIMULATION / MIDI。
- **SHARE**（OUTPUT 右侧）：直接弹出「共享系统音频」请求（屏幕共享），
  跳过虚拟回环声卡直采——未装回环声卡，或想显式授权屏幕共享音频时很有用。
- **SIMULATION SOUND**：开关 SIMULATION 与 MIDI 是否发出对应正弦音（让你能
  听到正在拨入的频率）。默认开启。
- **SIMULATION**：滑条扫频；开启 SIMULATION SOUND 时同时发出对应正弦音，
  图形实时跟随。
- **MIDI**：弹奏的音符实时驱动模式与频率；开启发声开关时同时发出该音。
- **VOL BOOST**：分析电平的后期增益（0.1×–10×），用于拉平过轻或过响的音源。
- **PATTERN / PARTICLES / COLLISION**：分别开关引导纹理、沙粒与颗粒间碰撞。
  COLLISION 启用短程斥力，使沙粒不可重叠、沿节线堆成有宽度的沙带。
- **SAND GRAINS**：沙粒数量（100–100 000）。
- **SAND GRAIN**：沙粒直径（mm，视觉尺寸）。
- **STIFFNESS**：底板硬度系数（相对基准 1.0；∝ √E）。
- **PLATE SIDE**：底板边长（cm，视觉比例）。
- **FULLSCREEN**：隐藏全部 UI 让底板铺满窗口（按 `F` 进入，按 `ESC` 退出）。
- **SAVE IMAGE**：把当前画面下载为 PNG。
- **MODE**（右上读数）：显示当前图案 `m×n`。
- 图形始终实时跟随频谱/频率（AUTO）；已移除手动模式选择。

## 说明

- 偏好（音源、频率、开关、语言）保存在 `localStorage`。
- `INPUT`/`OUTPUT` 只分析不外放（避免回授）；`SIMULATION` 与 `MIDI` 会发出
  正弦音（受 SIMULATION SOUND 开关控制）；无论该开关如何，图形仍随分析的
  频谱连续变形。
- `OUTPUT` 走虚拟声卡直采时刷新后**自动恢复**；走屏幕共享兜底时需用户手势，
  刷新后回退 `SIMULATION`（点一下 `OUTPUT` 即可重新开始监听）。
- 物理采用自由方板克拉尼方程，不强制中心节线，因此板心可呈现波腹。

## macOS 系统音频捕获提示

- **虚拟声卡直采（OUTPUT 首选路径，无弹窗）**：`OUTPUT` 模式自动识别并使用虚拟回环设备
  （BlackHole / LarkAudioDevice / Squirrels Audio 等），可在 **OUTPUT DEVICE** 下拉框切换。
  前提是在「音频 MIDI 设置」中建 **多输出设备**（勾选扬声器 + 该虚拟声卡），
  并把系统输出切到多输出设备（这样自己也能听到声音）。选择的设备会记住，刷新后自动恢复。
- **屏幕共享兜底**：无虚拟声卡时，`OUTPUT` 自动改用屏幕共享——
  Chrome / Edge（macOS 13+）共享 **整个屏幕** 时勾选「同时分享系统音频」→ 监听全部软件；
  若不支持整屏音频，改为共享某个 **标签页** 并勾选「分享标签页音频」（只能听到该标签页）。
- 无虚拟声卡时可安装 [BlackHole](https://existential.audio/blackhole/)。
- 共享成功但没勾音频时，页面会提示重试；点浏览器"停止共享"会自动切回 `SIMULATION`。

## 许可证

[AGPL-3.0](./LICENSE) © 2026 Fair
