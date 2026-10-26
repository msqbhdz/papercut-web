# 架构与模块契约（v2 · 折叠-展开模型）

> v2 取代 v1 的「实时镜像」模型。本文件是并行开发的唯一接口真相，签名/坐标/DOM id 一律不得改动。

## 0. 视觉基调（源自参考视频，取样自帧）

| 项 | 值 | 用途 |
|---|---|---|
| 背景 | `#E9EBE8`（暖米白） | 画布底、成品导出底 |
| 红纸 | `#BE2428` | 折起来的纸 / 成品纸盘 |
| 金笔（折叠态笔迹） | `#D98B3F` | 用户在红纸上画的线 |
| 刻线（成品笔迹） | `#FFFFFF` | 展开后同一批笔迹变成「剪掉」的白线 |
| 装饰纹 | `#FFFFFF` @ 0.5 alpha，线宽 0.0015 | 只画在折叠态红纸上（3 组云纹带：半径 0.14 / 0.24 / 0.34，云头数 3 / 4 / 5） |
| 成品内缩 | `DISK_INSET = 0.94` | 成品红盘直径只占画布 94%，四周留 3% 白边，盘边不被画布圆角切平 |

## 1. 几何（沿用 v1）

- 折数 `n ∈ {4, 6, 8}`，标签「四角 / 六角 / 八角」，默认 6。
- 主扇区以正上方为中心：`θ0 = -π/2`，张角 `Δ = 2π/n`，半径 `≤ 0.5`。
- `D_n` 二面体对称：`p' = C + Rot(k·Δ)·(m=-1 ? Reflect(θ0) : I)·(p - C)`，`k ∈ [0,n)`、`m ∈ {+1,-1}`。
- 坐标全部归一化到单位正方形（圆心 `C=(0.5,0.5)`，半径 ≤0.5），线宽同为归一化单位。

## 2. 三种渲染态

| mode | 画面 | 笔迹颜色 |
|---|---|---|
| `folded` | 米白底 + **一整块红纸楔形**（含白色装饰纹），只画这一片，不复制 | 金色 |
| `unfold` | 楔形按 `progress ∈ [0,1]` 扇形甩开：第 k 片的旋转角 = `k·Δ·progress`，带 2 层拖影 | 金→白随 progress 过渡 |
| `final` | 米白底 + 红纸圆盘，笔迹变白色刻线，`2n` 份对称 | 白色 |

- `final` 态**不画**装饰纹（让用户的作品是主角）。
- `folded` 态的相机把楔形放大充满画布：楔形顶点（圆心）落在画布约 88% 高处，外弧距顶点约 0.86×画布高；水平方向按扇区半角夹取，保证整片可见不裁切。

## 3. js/symmetry.js —— 纯几何 + 渲染（可被 Node import，顶层零 DOM）

```js
export const FOLD_OPTIONS = [4, 6, 8];
export const FOLD_LABELS = { 4: '四角', 6: '六角', 8: '八角' };
export const PALETTE = { paperBg:'#E9EBE8', paper:'#BE2428', inkFolded:'#D98B3F', inkCut:'#FFFFFF' };

export function sectorAngle(folds);
export function inSector(p, folds);
export function clampToSector(p, folds);
export function expandMatrices(folds, mirror = true);
export function toPathCommands(points);
export function toSvgPathD(commands);

// 折叠态相机：返回把归一化设计坐标映射到设备像素的 { scale, tx, ty }
// 约定：screen = design * scale + t
export function foldedCamera(folds, size);

export function renderFolded(ctx, strokes, opts);
export function renderUnfold(ctx, strokes, opts, progress);
export function renderFinal(ctx, strokes, opts);
```

`opts = { folds, size, camera }`；`camera` 缺省时由 `foldedCamera` 计算（仅 folded/unfold 用得上）。
- 三个 render 函数都必须**自己清屏并铺背景**（与 v1 相反，v1 由调用方铺），进来 save、出去 restore。
- 笔迹一律用 `toPathCommands` 的同一套命令绘制（保证 PNG/SVG 与屏上一致）：`stroke` + `lineCap/lineJoin = round`，单点笔迹画半径 `width/2` 的实心圆。
- `renderUnfold`：先按 `progress` 画拖影（`progress-0.06`、`progress-0.12`，alpha 0.22 / 0.10），再画主体；相机随 progress 从 folded 相机插值到「整圆充满画布」，用 `easeOutCubic`。
- 红纸楔形 = 以圆心为顶点、±Δ/2、半径 0.5 的扇形填充；`final` 的红纸 = 半径 0.5 的整圆填充。

## 4. js/draw.js —— 状态机（对外 Board）

```js
export function createBoard(canvas, opts);   // opts = { folds=6, width=0.008, onChange }
```

```js
board.setFold(n)      // 仅 folded 态可用；切换时按 v1 的等比重映射规则处理已有笔迹与历史栈
board.setWidth(w)     // 0.004–0.020
board.undo(); board.redo(); board.clear(); board.canUndo(); board.canRedo();
board.getStrokes(); board.loadStrokes(list);
board.getMode()       // 'folded' | 'unfolding' | 'final'
board.finish()        // folded → 播放 ~900ms 展开动画 → final；无笔迹时忽略并返回 false
board.restart()       // 任意态 → 回到 folded，**保留笔迹**（让用户继续改）；清空请用 clear()
board.exportSpec()    // → { strokes, folds }（供导出使用）
board.render(); board.destroy(); board.onStateChange = fn;
```

- 输入：Pointer Events，单指针状态机（只认第一根手指）+ window 级兜底释放（v1 已实现，保留）。
- 落笔坐标从**屏幕坐标反解到归一化设计坐标**（folded 态要经过 `foldedCamera` 的逆变换），再过 `clampToSector`。
- 只在 `folded` 态接受绘制；`unfolding` / `final` 态忽略指针。
- 渲染用 RAF 合并；`unfolding` 期间每帧推进 progress，结束后切 `final` 并触发一次 `onStateChange`。
- DPR 自适应、ResizeObserver、撤销栈上限 100、`clear()` 可撤销 —— 沿用 v1。

## 5. js/export.js

```js
export function buildSVG({ strokes, folds, size });  // 成品态：米白底 + 红盘 + 白色刻线
export async function exportPNG({ strokes, folds, size = 2048 });  // 触发下载
export function exportSVG({ strokes, folds, size = 1024 });
```
- 只导出**成品态**（不导出折叠态、不含装饰纹、不含引导）。
- SVG 与 PNG 必须共用 `expandMatrices` + `toPathCommands`，逐点一致；文件名 `papercut-<folds>fold-<yyyymmdd-hhmm>.<ext>`。
- 展开后的红盘：设计半径 0.5，经成品相机 `DISK_INSET` 内缩后屏幕/导出半径 = `0.47 × size`，盘外留白 `0.03 × size`；
  超过圆外的笔迹不得出现在导出里（用 `<clipPath>` 或路径裁切）。
- 导出必须与 `renderFinal` 用**同一个相机**：坐标 `design × 0.94 × size + 0.03 × size`，线宽同样乘 0.94。

## 6. DOM 契约（id 不可改）

| id | 元素 | 作用 |
|---|---|---|
| `#stage` | div | canvas 容器 |
| `#board` | canvas | 画布 |
| `#foldGroup` | div[role=group] | 含 3 个 `<button data-fold="4\|6\|8">`，文案 四角/六角/八角 |
| `#undo` `#redo` `#clear` | button | 折叠态可用 |
| `#brushSize` | input[type=range] | 笔宽 |
| `#finish` | button | 完成 → 播放展开 |
| `#restart` | button | 文案「继续画」，final 态显示 → 回到 folded 且保留笔迹 |
| `#exportPng` `#exportSvg` | button | 保存（final 态显示） |
| `#hint` | div | 首次落笔淡出 |
| `#toast` | div[aria-live=polite] | 轻提示 |
| `#install` | button[hidden] | PWA 安装 |

布局：顶栏 = 标题 + 折数 tabs；底部 = 折叠态显示「笔宽 / 撤销 / 重做 / 清空 / 完成」，成品态显示「重画 / 保存 PNG / 保存 SVG」。

## 7. 验收（每个 agent 自查）

```bash
node --check js/<file>.js
node --test          # 现 17 项，v2 需继续全绿并按新语义补充
```
