# 剪纸窗花 · Papercut

在手机浏览器里画一笔，展开成一枚对称的剪纸窗花。纯前端、零依赖、可离线、可安装到桌面。

**在线使用：<https://blog.msqbhdz.top/papercut-web/>**

<p align="center"><img src="./icons/icon-512.png" width="140" alt="剪纸窗花"></p>

## 立即使用

1. 手机浏览器打开上面的链接（无需安装 App）。
2. 在画面正上方那个**朝上的虚线扇形**里用手指画，笔画会自动镜像、旋转，展开成完整窗花。
3. 想放到桌面：iOS Safari → 分享 → 「添加到主屏幕」；Android Chrome → 会提示「安装应用」。
   安装后全屏运行，**断网也能用**。

## 交互

| 操作 | 说明 |
|---|---|
| 手指画线 | 只在朝上的扇区内生效；越界笔迹会被夹到扇区边界，而不是丢弃 |
| 2 / 4 / 8 / 12 折 | 折叠数。折数越多越细密 |
| 镜像 | 开 → `D_n` 二面体对称，雪花窗花感；关 → 仅 `n` 份旋转，风车感 |
| 6 色 + 笔宽 | 红/金/墨/青/蓝/紫；笔宽实时生效 |
| 撤销 / 重做 / 清空 | 撤销栈上限 100 步，清空也可撤销；桌面支持 `Ctrl/Cmd+Z`、`Shift+Ctrl/Cmd+Z` |
| 保存 PNG | 2048×2048 白底位图，直接进相册 |
| 保存 SVG | 矢量，放大不糊，可用于印刷或二次设计 |

## 本地开发

**无需构建、无依赖、无 npm install。**

```bash
# 方式一（推荐）：在 VSCode 里右键 index.html → Open with Live Server
# 方式二：任意静态服务器
python -m http.server 8787        # 然后访问 http://127.0.0.1:8787
```

> ⚠️ **不能直接双击 `index.html`**。项目用原生 ES Modules，`file://` 协议下浏览器会拦截模块加载。
> 遇到这种情况页面会显示一段友好提示引导你用本地服务器，而不是白屏。

单元测试（对称几何）：

```bash
node --test        # 对称几何 + 折叠重映射的单元测试（Node 内置 test runner，无需依赖）
```

## 技术说明

- **对称模型**：`D_n` 二面体群。主扇区以正上方（`θ₀ = -π/2`）为中心、张角 `Δ = 2π/n`；
  对 `k ∈ [0,n)`、`m ∈ {+1,-1}` 施加 `M = Rot(k·Δ) · (m = -1 ? Reflect(θ₀) : I)`，
  共 `2n` 份（关闭镜像时 `n` 份）。`k=0, m=+1` 恒为恒等变换，保证「所见即所画」。
- **归一化坐标**：所有笔迹存在单位正方形里，与屏幕尺寸、设备像素比、导出分辨率完全解耦。
- **PNG 与 SVG 同源**：两者都由同一套路径命令（`toPathCommands` 的中点二次贝塞尔平滑）驱动，
  导出结果逐点一致，不会出现「屏幕一个样、导出另一个样」。
- **折叠切换可逆**：改变折数时，已有笔迹按 `Δnew / Δold` 比例重映射偏差角，
  来回切换不会累积误差，也不会把图案挤成一团。
- **触控**：Pointer Events + `setPointerCapture` + 单指针状态机（只认第一根手指，防多指误触）；
  canvas 上 `touch-action: none` 让画线不带动页面滚动；`devicePixelRatio` 自适应，Retina 不糊。
- **PWA**：`cache-first` 的 Service Worker，首屏全部资源预缓存，离线可用。

完整接口与坐标约定见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 项目结构

```
papercut-web/
├── index.html            # 页面外壳（含 file:// 启动兜底提示）
├── style.css             # 移动端优先样式
├── manifest.json         # PWA 清单
├── sw.js                 # Service Worker（cache-first）
├── js/
│   ├── symmetry.js       # 对称引擎：扇区数学 + 路径命令 + Canvas 渲染器（纯函数，可单测）
│   ├── draw.js           # 指针输入、笔迹状态、撤销栈、DPR/RAF 调度
│   ├── export.js         # PNG / SVG 导出
│   └── main.js           # 只做接线
├── tests/symmetry.test.mjs
├── icons/                # 图标（由 tools/make_icons.py 程序化生成）
├── tools/make_icons.py   # Pillow 绘制图标
└── docs/ARCHITECTURE.md  # 冻结的模块契约
```

## 部署到 GitHub Pages

1. 推到 GitHub 仓库。
2. 仓库 **Settings → Pages**：Source 选 `Deploy from a branch`，分支 `main`、目录 `/`，保存。
3. 等 1 分钟左右访问 `https://<你的用户名>.github.io/<仓库名>/`。

或用命令行：

```bash
gh api -X POST repos/{owner}/{repo}/pages -f 'source[branch]=main' -f 'source[path]=/'
```

> 项目站点在子路径下运行，因此**所有资源引用都是相对路径**（`./js/main.js`）。
> 若要部署到根域名，无需任何改动。

## 兼容性

iOS Safari 16+、Android Chrome 110+、桌面版现代浏览器。无需任何 polyfill。

## 许可

[MIT](./LICENSE)
