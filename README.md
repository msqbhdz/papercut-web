# 剪纸窗花 · Papercut

在手机浏览器里，像拿笔在**折起来的红纸上画**一样画一笔，按下「完成」——纸像折扇一样甩开，变成一朵红底白刻线的对称窗花。纯前端、零依赖、可离线、可安装到桌面。

**在线使用：<https://blog.msqbhdz.top/papercut-web/>**

<p align="center"><img src="./icons/icon-512.png" width="140" alt="剪纸窗花"></p>

## 立即使用

1. 手机浏览器打开上面的链接（无需安装 App）。
2. 画布上是一块**朝上的红纸扇形**，纸面印着白色云纹。用手指在纸上画，笔迹是**金色**的。
3. 点「**完成**」，红纸会沿圆心扇形甩开、带着运动拖影，最后变成整朵窗花：**红是纸，白是你剪掉的线**。
4. 想放到桌面：iOS Safari → 分享 → 「添加到主屏幕」；Android Chrome → 会提示「安装应用」。
   安装后全屏运行，**断网也能用**。

## 交互

| 操作 | 说明 |
|---|---|
| 手指画线 | 只在朝上的红纸扇区内生效；越界笔迹被夹到扇区边界，不会丢 |
| 四角 / 六角 / 八角 | 折叠数（4 / 6 / 8）。折数越多越细密。切换时已有笔迹按扇区角**等比重映射**，可逆不漂移 |
| 笔宽 | 实时生效 |
| 撤销 / 重做 / 清空 | 撤销栈上限 100 步，清空也可撤销；桌面支持 `Ctrl/Cmd+Z`、`Shift+Ctrl/Cmd+Z` |
| 完成 | 播放约 900ms 的扇形展开动画，落到成品态 |
| 继续画 | 成品态返回折叠态，**笔迹保留**，可继续改 |
| 保存 PNG / SVG | 2048 白底位图 / 矢量（放大不糊），两者几何逐点一致 |

## 本地开发

**无需构建、无依赖、无 npm install。**

```bash
# 方式一（推荐）：在 VSCode 里右键 index.html → Open with Live Server（端口 5500）
# 方式二：任意静态服务器
python -m http.server 8787        # 然后访问 http://127.0.0.1:8787
```

> ⚠️ **不能直接双击 `index.html`**。项目用原生 ES Modules，`file://` 协议下浏览器会拦截模块加载。
> 遇到这种情况页面会显示一段友好提示引导你用本地服务器，而不是白屏。

单元测试（对称几何 + 折叠重映射 + 渲染态）：

```bash
node --test        # Node 内置 test runner，无需依赖
```

> 本地改完 `js/*` 若看不到效果，先清掉 Service Worker 缓存（DevTools → Application → Storage → Clear site data），
> 否则 cache-first 会把旧模块喂给你。

## 技术说明

- **三态渲染**：`folded`（红纸扇区 + 金笔）→ `unfold`（第 k 片旋转 `k·Δ·progress`，两层拖影 + 相机 `easeOutCubic` 收拢）→ `final`（红盘 + 白刻线）。
- **对称模型**：`D_n` 二面体群。主扇区以正上方（`θ₀ = -π/2`）为中心、张角 `Δ = 2π/n`；
  对 `k ∈ [0,n)`、`m ∈ {+1,-1}` 施加 `M = Rot(k·Δ) · (m = -1 ? Reflect(θ₀) : I)`，共 `2n` 份。
- **一个容易踩的坑**：楔形关于竖直轴自对称，所以「镜像片」与「旋转片」的**形状完全重合、绕向相反**。
  若把 `2n` 片拼进同一条路径再去 `fill()`，nonzero 规则会让它们**互相抵消、把整块纸填成空**。
  因此纸的路径与裁切只用 `n` 片，镜像片只参与笔迹与装饰纹的复制。仓库里有专门的回归测试盯着这条。
- **归一化坐标**：所有笔迹存在单位正方形里，与屏幕尺寸、设备像素比、导出分辨率完全解耦。
- **PNG 与 SVG 同源**：两者共用同一套路径命令（`toPathCommands` 的中点二次贝塞尔平滑）与同一个成品相机（`DISK_INSET` 内缩），
  不会出现「屏幕一个样、导出另一个样」。
- **触控**：Pointer Events + `setPointerCapture` + 单指针状态机（只认第一根手指）；
  window 捕获阶段还有一层 `pointerup/pointercancel` 兜底，避免系统手势打断后画板被永久锁死。
- **PWA**：`cache-first` 的 Service Worker，首屏资源全部预缓存，离线可用。

完整接口与坐标约定见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 项目结构

```
papercut-web/
├── index.html            # 页面外壳（含 file:// 启动兜底提示）
├── style.css             # 移动端优先样式
├── manifest.json         # PWA 清单
├── sw.js                 # Service Worker（cache-first）
├── js/
│   ├── symmetry.js       # 对称引擎：扇区数学 + 折叠相机 + 三种渲染态（纯函数，可单测）
│   ├── draw.js           # 指针输入、状态机（folded/unfolding/final）、撤销栈、DPR/RAF
│   ├── export.js         # PNG / SVG 导出（成品态）
│   └── main.js           # 只做接线
├── tests/                # node --test（对称几何 / 折叠重映射 / 渲染态）
├── icons/                # 图标（由 tools/make_icons.py 程序化生成）
├── tools/make_icons.py   # Pillow 绘制图标
└── docs/ARCHITECTURE.md  # 冻结的模块契约
```

## 部署到 GitHub Pages

1. 推到 GitHub 仓库。
2. 仓库 **Settings → Pages**：Source 选 `Deploy from a branch`，分支 `main`、目录 `/`，保存。
3. 等 1 分钟左右访问 `https://<你的用户名>.github.io/<仓库名>/`。

> 项目站点在子路径下运行，因此**所有资源引用都是相对路径**（`./js/main.js`）。若要部署到根域名，无需任何改动。

## 兼容性

iOS Safari 16+、Android Chrome 110+、桌面版现代浏览器。无需任何 polyfill。

## 许可

[MIT](./LICENSE)
