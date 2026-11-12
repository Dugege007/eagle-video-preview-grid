# Changelog

本文件记录所有值得注意的变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号遵循语义化版本。

## [1.1.1] - 2026-11-12

### 修复

- **首次点击视频时预览框高度未自动刷新**（第二个视频起正常）。成因：插件 iframe 刚创建时布局尚未稳定，首次 `render()` 量到的 `cellH` / `baseViewport` 不是最终值。
  - `refreshLayout()` 在基准明显不可信（< 200px）时重取一次 `window.innerHeight`，之后仍固定不变。
  - 重建网格时给**最后一张 `<img>`** 绑定一次性 `load` 事件，图片解码完成后再同步校准一次高度；`refreshLayout()` 幂等短路保证值相同就不写 DOM。
  - 仍是纯事件驱动、一个事件一次，**没有** `setTimeout` / rAF / `resize` 防抖 / 二次校准。

### 变更

- README 改为面向用户的精简版（仅功能、安装、使用、算法、注意事项、许可）；原开发向 README 备份到工作空间根 `README-开发文档备份.md`（仓库外，不进发布包）。

### 验证

`npm test` 24/24；全部 JS 语法检查、JSON 校验通过。首次高度修复需用户在真实 Eagle 中回归确认。

## [1.1.0] - 2026-11-12

基于发布前评审（设计文档 §19）的四项性能优化。**不改采样规则、不改交互、不改高度逻辑**。

### B · 缩图尺寸

- `-vf scale=320:-2` → `scale=192:-2`。检查器 3 列每列约 100px，320 是 3 倍冗余；JPEG 体积 / 编码 / base64 传输约降 4 倍。
- `Store.RULE_VERSION` 由 `v1` 升到 `v2`（输出规格变化），**升级后首次打开会重新抽帧一次**，之后缓存照常命中。

### C · 减少重复读盘与 DOM 重建

- `store.js` 增加内存 base64 缓存（按 `itemId + index`），`writeMeta()` / `clearItem()` 时按 item 作废。
- `main.js` 的 `render()` 引入渲染签名（`itemId / generatedAt / visible / results`）：只有内容变化才重建卡片；状态文本更新、高度刷新都复用已有 DOM。

### D · 缓存 FFmpeg 依赖查询结果

- `ensureFFmpeg()` 缓存 `getPaths()` / `isInstalled()` 结果，插件进程内只查一次，每次生成省 2 次 IPC。

### E · 显式 accurate_seek

- 抽帧参数显式加 `-accurate_seek`（默认开启），防 FFmpeg 版本差异；`-ss` 仍前置保持快速 seek。

### 可测试性

- 抽出纯函数 `Capture.buildCaptureArgs()`，新增 `test/capture.test.js` 5 组断言（参数顺序、`scale=192:-2`、`-accurate_seek`、中文 / 空格路径保持数组参数）。
- `npm test` 扩为三组：**24/24** 通过（采样 11 + 布局 8 + 抽帧 5）。

### 明确未做

批量 `fps` / `select` 抽帧（稀疏点场景负收益，见 §19.3）、一次 ffmpeg 多输入、后台 Service 导入预生成、`image2pipe` 不落盘。

## [1.0.0] - 2026-11-12

**首个稳定版。** 功能与 0.3.2 完全相同（0.x 为开发迭代阶段），仅做发布收口：

- 版本号统一为 `1.0.0`（`manifest.json` / `package.json`）。
- **`devTools` 由 `true` 改为 `false`** —— 发布版不打开调试窗口；[第三方 manifest 逐字段讲解](https://www.wanxiangyundang.top/read/eagle-plugin-dev/c04-01-manifest)（中可信）把「发布版忘关 devTools」列为常见坑。
- README 状态标记为稳定版；验证表待回归项按用户实测结果收口。
- 已在真实 Eagle 中连续多轮实测通过：采样规则、抽帧与派生缓存、清空、自动生成、全局 / 单项状态作用域、事件驱动高度刷新、单行工具栏、拖拽宽度即时刷新。
- 本地 `git tag v1.0.0`。**尚未创建远程仓库 / 未推送**（用户此前选择「先只建本地仓库」）。

> 0.x 历史条目保留在下方，便于追溯每次迭代与 Bug 修复（尤其 [0.3.1] 的高度递减反馈循环）。

## [0.3.2] - 2026-11-12

### 优化 · 拖拽检查器宽度即时刷新

用户实测：v0.3.1 高度已稳定，但「拖拽检查器宽度松开鼠标时不会即时刷新，再点击一次预览图任意位置才触发」。
成因：拖分隔条时 `mouseup` 发生在 **Eagle 主窗口**，插件 iframe 收不到该事件；只有点在 iframe
内部才补上一次，而此时宽度早已变化。

- 改用 `ResizeObserver` 观察 `document.documentElement`，捕获「布局宽度变化」这个可靠事件；
  **只在宽度真的变化时同步刷新一次** `refreshLayout()`。
- 高度变化（我们自己写 `grid.style.height` 造成的）由宽度守卫直接忽略，
  不会重演 v0.3.0 的「写入 → 事件 → 再写入」反馈循环。
- `mouseup` 兜底保留，但与 `ResizeObserver` 共用 `state.lastWidth` 同一基准，因此不会重复刷新。
- **仍然没有任何定时器 / 防抖 / rAF 二次校准**，符合「事件驱动、一个事件一次」的约定。

### 变更 · 工具栏与栏目名

- 去掉「预览图」label，把「数量 / 生成 / 清空 / 自动生成开关」合并到**同一行**
  （`flex-wrap: nowrap`、控件加 `white-space: nowrap`、按钮 padding 微调），省掉一行高度。
- `manifest.name` 由 `Video Preview Grid` 改为 **`视频预览图`**（Eagle 检查器区块标题显示名）；
  `index.html` 的 `<title>` 同步。插件 `id` 不变，缓存路径不受影响。
- **明确未改动** `syncControls()` 里「自动生成开启时隐藏生成 / 清空」的显示隐藏逻辑。

### 验证

`npm test` 19/19 通过；全部 JS `node --check`、JSON 校验通过（布局与 DOM 改动不影响纯函数单测）。

## [0.3.1] - 2026-11-12

### 修复 · 预览框高度不停逐次递减

用户实测反馈：「预览框会不停地自动一点一点减少高度」。根因是 v0.3.0 引入的**递减反馈循环**：

1. `tryResizeHost()` 每次把宿主 iframe 的 `style.height` / `minHeight` 设为「当前内容高度」；
2. `refreshLayout()` 又用会随 iframe 变化而变化的 `window.innerHeight` 计算
   `avail = innerHeight - chrome - 4`，`fitHeight()` 把网格设为 `avail`；
3. 新的内容高度 = `innerHeight - 4`，于是宿主又被写小 4px；
4. `resize` 防抖、rAF + 120ms / 400ms 二次校准、1s 轮询里的 `innerHeight` 检测
   反复触发下一轮 → 每轮缩 4px，无限递减。

### 变更（按用户要求：纯事件驱动，一个事件只刷新一次）

- **移除全部定时 / 间隔刷新**：删 `scheduleRefresh()`（rAF + 120/400ms）、`resize` 防抖监听、
  1s 轮询里的 `innerHeight` 检测与重算、`mouseup` 里的两个 `setTimeout`。
- **删除 `tryResizeHost()` 与 `probeHost()`**：宿主高度实测改不动，且它正是反馈循环的另一半；
  不再尝试改外框。
- **固定基准**：`state.baseViewport` 只在插件加载时取一次 `window.innerHeight`
  （兜底用 manifest 的 `height = 320`），此后永不更新；`avail` 不再随自身写入而漂移。
- **幂等短路**：`refreshLayout()` 计算出的 `height` / `overflowY` / `marginTop`
  与当前值相同时一个字都不写，杜绝「写入 → 事件 → 再写入」循环。
- **刷新时机（每个事件一次同步刷新，无定时器）**：初始化、重新选择资源、生成完成、
  清空、展开 / 收起、数量确认、自动生成开关切换 → 统一走 `render()` 末尾一次
  `refreshLayout()`；拖拽检查器宽度 → 仅 `mouseup` 且 `innerWidth` 确实变化时刷新一次。
- 抽帧进度改为只更新状态行文本，不触发 `render()` / 高度刷新。
- `setInterval(tick, 1000)` **保留**，但只用于检测选中项变化（官方无对应 event），
  完全不触碰尺寸与高度。

### 单测

- `test/layout.test.js` 增加回归用例「固定基准下反复刷新 50 次结果恒定」，
  `npm test` 共 **19/19** 通过（采样 11 + 布局 8）。

## [0.3.0] - 2026-11-12

### 新增 · 按需刷新高度（逼近「自适应」）

官方仍无运行时修改检查器 iframe 高度的 API，因此把「刷新高度」做成幂等的
`refreshLayout()`，挂到所有关键时机，用反复重算来逼近自适应：

- **展开时行数不再封顶 3 行**：按实际张数计算目标高度（12 张 → 4 行，30 张 → 10 行），
  收起时回到 3 行。解决「展开后还要在预览图框里滚轮才能看到 9 张之后」。
- **刷新时机**：初始化、重新选择资源、生成完成、清空、展开 / 收起、数量确认、
  `resize`（拖拽检查器宽度）、`mouseup`（松开后）、1s 轮询检测到 `innerHeight` 变化，
  以及 rAF + 120ms / 400ms 两段延时二次校准（对抗宿主重排）。
- **防裁切保护**：`Layout.fitHeight()` 在目标高度超过 iframe 可用视口高度时，
  自动退回「占满可用高度 + 内部滚动」，保证内容不会被宿主裁掉而凭空消失。
- **宿主同步增强**：`tryResizeHost()` 同时尝试 `frameElement` 的 `style.height` /
  `minHeight` / `height` 属性，以及宿主 document 里承载本窗口的 `iframe` / `webview` 元素。
- 新增只读 `probeHost()`，在 DevTools 输出 `eagle.window.getSize()` 等诊断信息，
  **不调用 `setSize`**（避免误改 Eagle 主窗口尺寸）。

### 变更

- 「清空」按钮改为红色（`.btn.danger`）。
- 启用「自动生成」时，「清空」按钮与「生成」按钮一起隐藏。

### 单测

- `layout.js` 的 `rowsFor` / `heightFor` 增加 `expanded` 参数；新增 `fitHeight`。
- `test/layout.test.js` 扩到 7 组，`npm test` 共 18/18 通过（采样 11 + 布局 7）。

### 已知边界

外框能否真正变高仍取决于 Eagle 宿主：若 `frameElement` / `parent.document` 都不可访问，
manifest 的 `height` 仍是固定值；此时展开超过外框容纳能力的部分会按防裁切保护退回内部滚动，
而不是被裁掉。后续可依据 DevTools 里的 `probeHost` 输出评估是否启用 `eagle.window.setSize` 通道。

## [0.2.0] - 2026-11-12

### 新增

- **网格高度随张数变化**：0 张时预览图区域高度为 0；1–3 / 4–6 / ≥7 张对应 1 / 2 / 3 行；最大 3 行。行高按运行时实测的单元格高度计算，不硬编码。
- **「展开」按钮只在超过 9 张时出现**；展开后网格仍保持 3 行高度，其余卡片内部滚动。
- **「清空」按钮**：删除该视频已生成的全部缩图与 `meta.json`，保留该视频自己的数量设置。
- **「自动生成」开关**：默认关闭；开启后隐藏手动「生成」按钮，选择视频时自动生成；数量输入确认（`change`）后自动刷新；已有符合数量 / 规则 / 源文件的缓存时直接复用、不重复抽帧。
- **清空后的抑制逻辑**：清空后不再自动生成，直到再次重新选择该视频（选中项 id 变化）才解除。
- **状态作用域分离**：自动生成开关、展开 / 折叠状态为全局（`settings.json`）；生成数量按单个视频资源独立保存（`thumbs/<itemId>/config.json`）。
- 缓存增加 `rule` 版本字段，采样规则变更后旧缓存自动失效。
- 新增 `js/layout.js` 布局纯函数与 `test/layout.test.js`（5 组单测）。

### 变更

- 工具栏改为两行（标题 + 开关 / 数量 + 生成 + 清空）；计数信息合并进状态行，移除常驻 footer。
- `body` 背景改为透明、`.wrap` 高度改为内容自然高度；新增 `frameElement` 尽力而为的宿主 iframe 高度同步。

### 已知边界

官方**没有**运行时修改检查器区块高度的 API（`eagle.window.setSize` 只作用于插件窗口，检查器插件无 `main`）。网格区域高度可精确控制；整个外框能否随之变矮取决于 `window.frameElement` 是否可访问，需在真实 Eagle 中实测；若不可用则保持 manifest 固定 `height`，内容顶部对齐、留白透明。

## [0.1.0] - 2026-11-12

### 新增

- 检查器扩展插件骨架（`preview.<ext>.inspector`），仅新增区块，不替换 Eagle 原生播放器。
- 一键自动生成静态预览图：FFmpeg 取时长并抽帧，检查器内 3 列网格 + 小字时间码。
- 确定性采样算法：分 N+1 段取中间 N 个连接处，最低间隔 5 秒，短视频从尾部对齐。
- 唯一设置项「自动生成数量」，默认 9，范围 1–30。
- 默认显示前 9 张，超出可展开 / 折叠（网格内部滚动，不撑高 iframe）。
- 派生缓存与自动失效：数量、源文件大小 / 修改时间变化即重新生成；缓存缺失自动重建。
- 6 套 Eagle 主题适配、`eagle.app.theme` / `onThemeChanged`。
- 采样算法单测（含需求方给的 28s → 3/8/13/18/23s 例子），`npm test` 可运行。

### 明确不做（本期范围）

点击跳转播放、快捷键、自定义取帧、可编辑文字描述、hover 播放、右键菜单、单张删除 / 重抽、章节导出。
