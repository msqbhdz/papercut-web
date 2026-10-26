# 架构与模块契约（frozen v1）

> 本文件是并行开发的唯一接口真相。任何模块实现都必须**严格**遵守下述签名、坐标约定与 DOM id；
> 需要变更契约时必须由协调者改本文件，实现方不得单方面偏离。

## 0. 全局约定

- **零第三方依赖、零构建步骤**。原生 ES Modules，`<script type="module">`。禁止 CDN、禁止 npm 运行时依赖。
- **所有资源引用必须是相对路径**（`./js/main.js`、`./style.css`）。绝不能以 `/` 开头 —— 部署在
  GitHub Pages 项目站点 `https://<user>.github.io/papercut-web/` 下，绝对路径会 404。
- 所有几何量以**归一化坐标**存储：单位正方形 `(0,0)` 左上、`(1,1)` 右下；圆心 `C=(0.5,0.5)`；可用半径 `r ≤ 0.5`。
- 线宽同为归一化单位（`0.008` ≈ 画布边长的 0.8%）。
- 目标浏览器：iOS Safari 16+ / Android Chrome 110+。只用其稳定支持的 API。
- 中文 UI 文案，英文代码标识符。

## 1. 对称模型：D_n 二面体对称

折叠数 `n ∈ {2,4,8,12}`。扇区角 `Δ = 2π/n`。

- 主轴方向 **正上方**：`θ0 = -π/2`（canvas 坐标系 y 轴向下）。
- 主扇区（用户唯一可落笔的区域）覆盖角度 `[θ0 - Δ/2, θ0 + Δ/2]`，即竖直朝上的一个楔形，
  半径上限 `0.5`（内切圆内，保证成品始终是圆形窗花）。
- 展开：对每个 `k ∈ [0,n)`、`m ∈ {+1,-1}`（仅 mirror 开启时）：

```
v  = p - C
M  = Rot(k·Δ) · (m === -1 ? Reflect(θ0) : I)
p' = C + M·v
```

  `Reflect(θ0)` = 过圆心的轴反射 `[[cos2θ0, sin2θ0],[sin2θ0, -cos2θ0]]`；θ0=-π/2 时退化为 `[[-1,0],[0,1]]`
  （沿竖直轴镜像）。
- `k=0, m=+1` **必须**是恒等变换，保证「所见即所画」。
- mirror 关闭 → 只有 `n` 份旋转副本（风车感）；开启 → `2n` 份（雪花/窗花感）。**默认开启**。

## 2. 模块 API（钉死）

### js/symmetry.js —— 纯几何，无 DOM 依赖，必须能被 Node 直接 import
```js
export const FOLD_OPTIONS = [2, 4, 8, 12];
export function sectorAngle(folds)                        // → Δ = 2π/n
export function inSector(p, folds)                        // → boolean，含边界，容差 1e-9
export function clampToSector(p, folds)                   // → {x,y}，极角夹到主扇区边界、半径夹到 ≤0.5
export function expandMatrices(folds, mirror)             // → Matrix[]
export function toPathCommands(points)                    // → Command[]
export function toSvgPathD(commands)                      // → string
export function renderDesign(ctx, strokes, opts)           // → void
```

- `Matrix = { a,b,c,d,e,f, k, m }`：归一化坐标系下的 2D 仿射（已含 C 的平移与还原），
  语义与 `ctx.transform(a,b,c,d,e,f)` 一致，可直接喂给 canvas。
- `Command = { op:'M'|'L'|'Q', x, y, cx?, cy? }`（`cx/cy` 仅 `Q` 用）。
- `opts = { folds, size, mirror = true, drawGuides = false }`；`size` 是正方形画布**设备像素**边长。
- `renderDesign` 必须自包含：进来 save、出去 restore，不污染调用方 ctx 状态；不得 clearRect
  （背景由调用方负责）。
- 笔迹**必须**用 `toPathCommands` 产出的同一套命令绘制 —— PNG 与 SVG 输出才会逐点一致。
- `drawGuides: true` 额外画主扇区引导（两条虚线径向边 + 外侧圆弧 + 圆心点），仅交互预览用，导出时不得出现。

**`toPathCommands` 平滑规则（PNG 与 SVG 共用，必须一致）**
- 1 个点 → 仅 `[{op:'M'}]`（渲染器自行画实心圆点）。
- 2 个点 → `M p0`、`L p1`。
- ≥3 个点 → 中点二次贝塞尔：`M p0`；对每个内部点 `p[i]`，以 `p[i]` 为控制点、
  `mid(p[i],p[i+1])` 为终点发 `Q`；最后 `L p[last]`。

### js/draw.js —— 输入 / 状态 / 撤销栈（可依赖 symmetry.js）
```js
export function createBoard(canvas, opts)   // → Board
```
`opts = { folds = 8, color = '#c8102e', width = 0.008, mirror = true, paperColor = '#ffffff', onChange }`

```js
board.setFold(n); board.setColor(hex); board.setWidth(w); board.setMirror(bool);
board.undo(); board.redo(); board.clear();
board.getStrokes();        // → Stroke[]（深拷贝快照）
board.loadStrokes(arr);    // redo / 外部恢复
board.canUndo(); board.canRedo();   // → boolean
board.render();            // 立即重绘一帧
board.destroy();
board.onStateChange = fn;  // 状态变更后回调（刷新按钮可用态）
```
`Stroke = { color: string, width: number, points: Array<{x,y}> }`（全部归一化）。

**`setFold(n)` 的语义**：切换折数时，已有笔迹的偏差角按 `Δnew / Δold` **等比重映射**后再夹到新扇区，
半径不变。该映射可逆（`2→12→2` 回到原角度，误差 ~1e-13），因此来回切换不漂移、也不把图案挤成一团。
正在绘制中的笔画直接丢弃，不参与重映射；重映射本身不产生新的撤销条目。

**输入硬性规则**
- 只用 Pointer Events；`pointerdown` 时若已有其它 pointer 处于按下状态 → 忽略新 pointer
  （只认第一个触点，防多指误触），在 `pointerup`/`pointercancel` 时释放。
- `setPointerCapture`；处理 `pointerdown` `pointermove` `pointerup` `pointercancel` `lostpointercapture`。
- 每个点先过 `clampToSector` 再入栈；与上一点距离 `< 0.0015` 的点丢弃（去抖）。
- 无 move 的轻点 → 1 个点的 Stroke，渲染成半径 `width/2` 的实心圆点。
- 渲染用 `requestAnimationFrame` 合并（脏标记），不得在 `pointermove` 里同步重绘。
- canvas 按 `devicePixelRatio` 缩放；`ResizeObserver` 监听容器尺寸变化后重建 backing store 并重绘。
- 撤销栈上限 100；`clear()` 必须可撤销。
- **不实现橡皮擦**（用撤销/清空覆盖需求）。

### js/export.js —— 导出（可依赖 symmetry.js）
```js
export function renderToCanvas({ strokes, folds, mirror, size })   // → HTMLCanvasElement（离屏，白底）
export async function exportPNG(opts)                              // → Promise<void>，触发下载
export function buildSVG({ strokes, folds, mirror, size })         // → string
export function exportSVG(opts)                                    // → void，触发下载
```
- PNG：`size` 为输出正方形边长，默认 2048，上限 4096。`canvas.toBlob('image/png')` + `<a download>`。
- SVG：`viewBox="0 0 size size"` + `xmlns` + 白底 `<rect>`；每条展开副本一个
  `<path fill="none" stroke-linecap="round" stroke-linejoin="round">`，`d` 来自 `toSvgPathD`，
  线宽 `width * size`。单点笔迹输出 `<circle>`。
- 文件名默认 `papercut-<folds>fold-<yyyymmdd-hhmm>.png` / `.svg`。

### js/main.js —— 只做接线，不写业务算法
### sw.js —— 经典脚本（不用 import），缓存名 `papercut-v1`

## 3. DOM 契约（id 不可改，main.js 与 style.css 共同依赖）

| id | 元素 | 作用 |
|---|---|---|
| `#stage` | `<div>` | canvas 容器，正方形自适应 |
| `#board` | `<canvas>` | 绘图板 |
| `#foldGroup` | `<div role="group">` | 内含 4 个 `<button data-fold="2|4|8|12">` |
| `#undo` `#redo` `#clear` | `<button>` | 历史操作 |
| `#mirror` | `<button aria-pressed>` | 镜像开关 |
| `#colors` | `<div>` | 内含 `<button class="swatch" data-color="#c8102e">` |
| `#brushSize` | `<input type="range">` | 笔宽，映射 0.004–0.020 |
| `#exportPng` `#exportSvg` | `<button>` | 导出 |
| `#hint` | `<div>` | 首次提示，首次落笔后淡出 |
| `#toast` | `<div aria-live="polite">` | 轻提示 |
| `#install` | `<button hidden>` | `beforeinstallprompt` 时显示 |

## 4. PWA 契约

`manifest.json`：`name` "剪纸窗花 · Papercut"、`short_name` "剪纸"、`start_url` `"./"`、`scope` `"./"`、
`display` `"standalone"`、`orientation` `"portrait"`、`background_color` `"#ffffff"`、
`theme_color` `"#c8102e"`、icons：`icon-192.png`(192x192)、`icon-512.png`(512x512)、
`icon-maskable-512.png`(512x512, purpose maskable)。

`sw.js`：`CACHE = 'papercut-v1'`；install 预缓存 `./`、`./index.html`、`./style.css`、`./manifest.json`、
`./js/symmetry.js`、`./js/draw.js`、`./js/export.js`、`./js/main.js`、`./icons/icon-192.png`、
`./icons/icon-512.png`；同源 GET 走 cache-first + 网络回填；导航请求离线回落到缓存 index.html。

## 5. 文件布局

```
papercut-web/
├── index.html
├── style.css
├── manifest.json
├── sw.js
├── package.json          # {"type":"module"} 仅为让 node --test 能直接 import ESM
├── js/symmetry.js
├── js/draw.js
├── js/export.js
├── js/main.js
├── icons/icon-192.png  icon-512.png  icon-maskable-512.png  icon.svg
├── tests/symmetry.test.mjs
├── docs/ARCHITECTURE.md
└── README.md             # 由协调者最后撰写
```

## 6. 代码风格

- 2 空格缩进、单引号、统一带分号、ESM `import/export`。
- 不写与代码重复的注释；只在算法处与浏览器怪癖处写「为什么」。
- 不留下调试输出。

## 7. 验收与自查命令

```bash
node --check js/<file>.js      # 语法（package.json type:module 下对 ESM 有效）
node --test tests/             # 引擎单测
```
