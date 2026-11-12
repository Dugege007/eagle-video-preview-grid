# Eagle Video Preview Grid

> 给 Eagle 检查器加一块「视频预览图」区块：按等距时间点自动抽出静态帧，一眼扫完这个视频的大致内容。

- **类型**：Eagle 4.0 检查器扩展插件（`preview.<ext>.inspector`），只新增区块，不替换 / 干扰原生视频播放器
- **Eagle 中显示名**：「视频预览图」（`manifest.name`）
- **版本**：0.3.2（2026-11-12）
- **许可**：MIT
- **状态**：✅ v0.1.0 / v0.2.0 / v0.3.1 均已实测通过；v0.3.2（单行工具栏 + 拖拽即时刷新 + 中文名）待回归验证

---

## 一、为什么做这个

试用 [VideoTileKun Inspector](https://community-jp.eagle.cool/plugin/054118d7-01e3-403f-a69e-4d7da614508b) 后，发现它功能有重叠，但设置项过多、部分能力用不上，于是决定自研一个更精简的版本，**只参考它的 FFmpeg 抽帧实现思路**。

| | VideoTileKun Inspector | 本插件 |
| --- | --- | --- |
| 设置项 | 网格大小范围、抽帧间隔秒、画质、hover 缩放、亮度/对比度/饱和度… | **只有「生成数量」+「自动生成」开关** |
| 取点方式 | 固定间隔（需自己调） | 按视频时长自动分段，内置最低 5 秒保护 |
| 预览形态 | 缩图 + hover 从该帧播放 | **纯静态图**，完全不加载 `<video>` |
| 文字说明 | 单张 tag（overlay 显示） | 本期不做 |
| 触发 | 一键生成 | 手动「生成」或选中视频时自动生成 |
| 依赖 | 官方 FFmpeg 插件 | 官方 FFmpeg 插件 |

---

## 二、范围

**做**

- 静态预览图网格 + 图下小字时间码（`MM:SS` / `HH:MM:SS`）
- 单个视频各自的「生成数量」，默认 **9**，范围 1–30
- 「自动生成」开关（默认关闭）：开启后隐藏手动「生成」按钮，选择视频时自动生成；数量确认后自动刷新
- 「清空」按钮：清空已生成预览图；清空后须重新选择该视频才会再次自动生成
- 网格高度随张数变化（0 张为 0；**收起封顶 3 行，展开按实际张数变高**）；超过 9 张才显示「展开 / 收起」
- **事件驱动刷新高度**：重新选择资源、重设数量、展开 / 收起、拖拽检查器宽度松开后，各按当前张数刷新一次；**没有任何定时器或间隔刷新**
- 全局状态（自动生成开关、展开 / 折叠）与单项配置（数量）分离
- 工具栏单行：数量 / 生成 / 清空 / 自动生成开关（已去掉「预览图」label）
- 缓存命中直接复用不重复抽帧；6 套 Eagle 主题适配

**明确不做**

| 不做 | 原因 |
| --- | --- |
| 点击跳转播放 | `item.open()` 无 `time` 参数，两套官方 API 均无播放控制 —— 官方硬边界 |
| 快捷键 / 自定义取帧 | 先只做自动生成；「抓主播放器当前帧」拿不到 `currentTime`，iframe 无焦点 |
| 可编辑文字描述 | 本期不需要；后续口径已定，见「路线图」 |
| hover 播放、右键菜单、单张删除 / 重抽、章节导出 | 用不上，避免设置与交互膨胀 |

### 关于高度（官方边界，重要）

需求里的「预览图区域高度」和「整个检查器外框高度」是两件事：

| 层 | 能否控制 | 依据 |
| --- | --- | --- |
| **预览图网格区域** | ✅ 完全可控 | 插件自己的 DOM：0 张 → `0px`；收起态 1–3 / 4–6 / ≥7 张 → 1 / 2 / 3 行封顶；**展开态行数不封顶**（12 张 → 4 行、30 张 → 10 行）。行高按运行时实测单元格高度计算 |
| **整个检查器区块（iframe）** | ❌ 官方无运行时改高通道，**用户实测确认无法自适应** | `eagle.window.setSize` / `setBounds` 只作用于**插件窗口**（BrowserWindow），检查器插件没有 `main`；官方与第三方教程都只把 `inspector.height` 描述为「默认高度、建议调到 120/150 这种整数」 |

用户实测 `frameElement` 尝试无效后，改为**「事件驱动刷新」**。v0.3.0 曾用定时器反复刷新，结果造成「高度一点一点递减」的 Bug（详见 CHANGELOG [0.3.1]）；**v0.3.1 已彻底移除所有定时器**，现在：

- **一个操作事件只同步刷新一次**：初始化、重新选择资源、生成完成、清空、展开 / 收起、数量确认、自动生成开关切换 → 统一走 `render()` 末尾的一次 `refreshLayout()`；拖拽检查器宽度 → `ResizeObserver` 只在**宽度真的变化**时同步刷新一次（拖分隔条的 `mouseup` 发生在 Eagle 主窗口，iframe 收不到，故不能只靠 `mouseup`）。没有 `resize` 防抖、没有 `setTimeout`、没有 rAF 二次校准；`mouseup` 兜底与观察器共用同一宽度基准，不会重复刷新。
- **固定基准**：`baseViewport` 只在加载时取一次 `window.innerHeight`（兜底 320），之后永不更新；可用高度不再随自身写入而漂移，从根上消除递减反馈。
- **幂等短路**：计算值与当前样式相同就一个字都不写。
- **不再尝试改宿主 iframe 高度**（实测无效，且是反馈循环的另一半）。
- `body` 背景透明，内容变矮后留白透出 Eagle 检查器底色；`Layout.fitHeight()` 防裁切保护仍保留，目标高度超过可用高度时退回「占满可用高度 + 内部滚动」，内容不会被裁掉。
- `setInterval(tick, 1000)` 仍存在，但**只用于检测选中项变化**（官方 7 个 event 里没有该事件），完全不触碰尺寸与高度。

---

## 三、安装

1. 在 Eagle 插件中心安装官方 **「FFmpeg 依赖插件」**（`manifest.json` 声明了 `dependencies: ["ffmpeg"]`）。本机已装：`%APPDATA%\Eagle\Plugins\ffmpeg-win-x64\` 内含 `ffmpeg.exe` + `ffprobe.exe`。
2. 把本仓库整个目录放进 Eagle 插件目录 `C:\Users\[用户名]\AppData\Roaming\Eagle\Plugins\`（入口：插件 → 开发者选项 → 打开插件文件夹）。
   - 开发阶段可用目录联接避免反复复制（本机已这样装）：
     ```powershell
     New-Item -ItemType Junction -Path "$env:APPDATA\Eagle\Plugins\eagle-video-preview-grid" -Target "D:\WorkBuddy\Eagle插件开发\eagle-video-preview-grid"
     ```
   - ⚠️ **绝不在 Eagle 界面里点本插件的「卸载 / 删除」**，也不要对链接用 `Remove-Item -Recurse` / `rm -rf`（会穿透 junction 删到源码）。安全卸载：`[System.IO.Directory]::Delete("$env:APPDATA\Eagle\Plugins\eagle-video-preview-grid")`。
3. 重启 Eagle，选中一个视频 → 右侧检查器出现「预览图」区块。
4. 首次可把区块拖到想要的位置（Eagle 4.0 检查器支持拖拽排序；manifest 无 `order` / `position` 字段）。

**环境要求**：Eagle 4.0 build22+；官方 FFmpeg 依赖插件。优先 Windows。

---

## 四、使用

| 操作 | 行为 |
| --- | --- |
| 点「生成」 | 按当前视频自己的数量设置抽帧 |
| 开启「自动生成」 | 隐藏手动「生成」按钮；之后**每次点击选择一个视频**自动生成其预览图（开启当下不立即生成） |
| 修改「数量」并确认（失焦 / 回车） | 自动生成开启 → 立即按新数量刷新；关闭 → 提示点「生成」 |
| 已有预览图且符合数量 / 规则 / 源文件 | 直接复用缓存，**不重复抽帧** |
| 点「清空」（红色） | 删除该视频全部缩图与生成记录，网格高度归 0；保留该视频的数量设置。**自动生成开启时此按钮隐藏** |
| 清空之后 | 不会再次自动生成，**直到重新选择该视频**（切到别的再切回来、或经过无选中再选回） |
| 超过 9 张 | 出现「展开 ▾ / 收起 ▴」；**展开后按全部张数刷新高度、直接看到 9 张之后的图**，收起时刷新回 3 行 |
| 拖拽检查器宽度 | 宽度变化即按新行高**同步刷新一次**，松开时已是最终值，无需再点一下（无定时器） |

### 状态作用域

| 状态 | 作用域 | 存储位置 |
| --- | --- | --- |
| 自动生成开关（默认关闭） | **全局**，切换视频保持 | `settings.json` |
| 展开 / 折叠 | **全局**，切换视频保持 | `settings.json` |
| 生成数量（默认 9） | **单个视频资源**，互不干扰；清空不影响 | `thumbs/<itemId>/config.json` |
| 清空后的抑制标记 | 内存态，重新选择该视频时解除 | 不落盘 |

---

## 五、采样算法

输入：`T` = 视频时长（秒，`ffprobe -show_format` 取 `format.duration`）、`N` = 生成数量（默认 9）；常量 `MIN_GAP = 5`。

```
gap0 = T / (N + 1)              // 分成 N+1 段，取中间 N 个连接处
gap  = max(gap0, MIN_GAP)       // 最低间隔 5 秒
M    = min(N, floor(T / gap))   // 实际张数
t_i  = T - M*gap + (i-1)*gap    // i = 1..M，从尾部往前对齐
```

**从尾部对齐**即「尾保留完整段、首部不足 5 秒的余数段截断」：最后一个点 `t_M = T - gap`，首点 `t_1 = T - M*gap`。

| T | N | gap0 | gap | M | 时间点 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 9 | 10 | 10 | 9 | 10, 20, …, 90 | 标准情形：分 10 段、去首尾、取中间 9 个连接处 |
| 50 | 9 | 5 | 5 | 9 | 5, 10, …, 45 | 恰好 5 秒间隔 |
| **28** | **9** | 2.8 | **5** | **5** | **3, 8, 13, 18, 23** | **需求方给的例子**（28 − 5×5 = 3） |
| 40 | 9 | 4 | 5 | 8 → 7 | 5, …, 35 | 见下方边界 1 |
| 12 | 9 | 1.2 | 5 | 2 | 2, 7 | 首部余 2 秒截断 |
| 4 | 9 | 0.4 | 5 | 0 | — | 视频短于 5 秒，不生成 |

**保护性默认（可调）**

1. `T` 恰为 `gap` 整数倍时首点会落在 **0 秒**（片头常为黑帧）。若 `t_1 < 1s`，丢掉最靠首部的那一段并重算，例如 40s 生成 7 张（5…35）而非 8 张。
2. `M = 0` 时显示「视频不足 5 秒，无法生成预览图」，不报错。
3. 抽帧用精确浮点秒传给 FFmpeg，显示时间码取整秒；数量输入钳制到 1–30。
4. `-ss` 放在 `-i` 之前是快速 seek，FFmpeg 的 `accurate_seek` 默认开启会解码到精确目标点，时间码与出图一致。

抽帧队列并发上限 2，单张失败显示占位图、不阻塞其他卡片；输出统一 `scale=320:-2` 的 JPEG。

---

## 六、数据与迁移

时间点是 `(时长, 数量)` 的确定性函数，缩图是可丢弃的派生缓存；换机 / 重装 / Eaglepack 迁移后自动重算重建，不存在「预览图丢失」问题。

```
{eagle.app.userDataPath}/eagle-video-preview-grid/
├── settings.json                  { "autoGenerate": false, "expanded": false }   ← 全局
└── thumbs/<itemId>/
    ├── config.json                { "tileCount": 9 }                            ← 单项，清空保留
    ├── meta.json                  rule / count / duration / gap / times / results
    │                              / sourceSize / sourceMtime / generatedAt
    └── 0.jpg … M-1.jpg
```

- `rule`（采样规则版本）、`count`、`sourceSize`、`sourceMtime` 任一变化，或任一缩图缺失 → 缓存失效并重新生成。
- 「清空」只删 `*.jpg` 与 `meta.json`，**保留 `config.json`**。
- **不写 Eagle 资源库、不碰 `metadata.json`**（官方最佳实践明文禁止直接修改资源库文件）。
- 缩图用 base64 data URL 渲染，规避 Windows 中文路径 / 空格 / `#` 的 `file:///` 转义问题。

---

## 七、已验证 / 未验证（含负向结论）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 采样算法正确性 | ✅ 已验证 | `test/sampler.test.js`：11 组断言 + 1…600s × 1…30 张穷举不变量 |
| 布局规则（可见张数 / 行数 / 展开不封顶 / 高度 / fitHeight / 展开按钮 / 固定基准幂等） | ✅ 已验证 | `test/layout.test.js`：8 组断言 + 0…30 张高度上界穷举 + 重复刷新 50 次结果恒定 |
| 在真实 Eagle 中安装并跑通 v0.1.0 | ✅ **用户实测通过** | 2026-11-12：预览栏目正常显示、已有功能良好 |
| junction 安装被 Eagle 识别 | ✅ **用户实测通过** | 同上（此前担心的 `isDirectory()` 过滤未发生） |
| `require('child_process')` / FFmpeg 抽帧链路 | ✅ 间接验证 | 预览图已能生成显示，说明 Node 集成与 `getPaths()` 均可用 |
| v0.2.0 新增交互（清空、自动生成、作用域） | ✅ **用户实测通过** | 2026-11-12 13:42 反馈「目前功能良好」 |
| 宿主 iframe 高度能否随之变矮 | ❌ **实测不能** | 用户确认「栏目高度无法自适应」，`frameElement` 尝试无效；已改为「按需刷新 + 防裁切保护」策略 |
| v0.3.0 定时刷新导致高度不停递减 | 🐛 **已定位并修复** | 递减根因：`tryResizeHost()` 写宿主高度 + 用动态 `innerHeight` 算 avail，每轮少 4px；见 CHANGELOG [0.3.1] |
| v0.3.1 纯事件驱动刷新 / 高度不再递减 | ✅ **用户实测通过** | 2026-11-12 14:06 反馈「目前功能良好」 |
| 拖拽分隔条时 iframe 能否收到 `mouseup` | ❌ **收不到** | 用户实测：松开不刷新，需再点一次 iframe 内部；事件发生在 Eagle 主窗口 → v0.3.2 改用 `ResizeObserver` 捕获宽度变化 |
| v0.3.2 单行工具栏 / 拖拽即时刷新 / 中文栏目名 | ⏳ **待回归验证** | 代码完成，需重启 Eagle 实测 |
| 点击让 Eagle **主播放器**跳到时间点 | ❌ 官方不支持 | `item.open()` 只有 `window` 参数；Plugin API 与本地 HTTP API 均无播放控制 |
| 全局快捷键抓播放器当前帧 | ❌ 官方不支持 | 拿不到 `currentTime`、iframe 无焦点、7 个 event 无键盘 / 播放器事件 |
| 改原生标注栏 / 给原生笔记塞图片 | ❌ 插件做不到 | 只能在检查器新增自己的 iframe 区块；`addComment` 无图片字段 |
| 用 `<video>` + canvas 抽帧 | ❌ 不用 | 检查器与主播放器同属 Chromium 107，不被管线支持的编码一样解不动；FFmpeg 是独立解码链路 |

---

## 八、开发

```bash
npm test                    # node test/sampler.test.js && node test/layout.test.js，无第三方依赖
python tools/make_logo.py   # 重新生成 logo.png（仅用 Python 标准库）
```

```
├── manifest.json          # 检查器插件声明（height 320、dependencies ffmpeg）
├── index.html             # 区块入口
├── css/style.css          # 主题适配 + 3 列网格 + 动态高度
├── js/sampler.js          # 确定性采样（纯函数，浏览器 / Node 双用）
├── js/layout.js           # 网格布局纯函数（可见张数 / 行数 / 高度）
├── js/store.js            # 全局设置 + 单项配置 + 派生缓存
├── js/capture.js          # ffprobe 取时长 + FFmpeg 抽帧
├── js/main.js             # UI、轮询、生成 / 清空 / 自动生成流程
├── test/sampler.test.js   # 采样单测
├── test/layout.test.js    # 布局单测
├── tools/make_logo.py     # logo 生成脚本
└── logo.png               # manifest 图标
```

---

## 九、路线图（P0 / P1 / P2）

- **P0**：v0.1.0 / v0.2.0 / v0.3.1 已实测通过；v0.3.2 回归验证，重点看「单行工具栏在窄检查器下是否不换行」「拖拽宽度时是否即时刷新」「栏目名是否显示为中文」三项。
- **P1**：可编辑自定义描述、单张重抽 / 删除、失败重试、单次 FFmpeg 批量 `select` 抽帧优化。
- **P2**：场景切点检测挑「精彩段」（`select='gt(scene,0.4)'`）、自定义取帧 + 快捷键（仅唤起 / 刷新）、hover 看大图、导出缩图与时间码清单。

**以后做「自定义描述」时必须沿用的口径**

1. 「默认和所属章节对齐」= 复制该时间点所属原生笔记的 `annotation` 作为描述**默认值**；此后独立编辑，**绝不回写 `item.comments`**。预览图与笔记标注在产生通道 / 存储 / 编辑上始终是两套，只在初始化时单向取值一次。
2. 持久化用 `item.annotation` + `item.save()`（官方可读写字段，随资源库 / Eaglepack 迁移、可被 Eagle 全文检索；代价是占用检查器「注释」栏）。禁止直接改 `metadata.json`。
3. 快捷键只接受「唤起 / 刷新」语义；除非官方开放 `item.open(id, { time })` 或 `eagle.player.seek()`，否则不要重新评估「抓当前播放帧」。

---

## 十、依据（按可信度）

| 可信度 | 来源 |
| --- | --- |
| 高 · 官方 API 文档 | [检查器插件](https://developer.eagle.cool/plugin-api/zh-cn/get-started/plugin-types/inspector)、[manifest 完整配置](https://developer.eagle.cool/plugin-api/zh-cn/tutorial/manifest)、[item](https://developer.eagle.cool/plugin-api/zh-cn/api/item)、[app（`userDataPath` / `theme`）](https://developer.eagle.cool/plugin-api/zh-cn/api/app)、[window（`setSize` 仅插件窗口）](https://developer.eagle.cool/plugin-api/zh-cn/api/window)、[FFmpeg extraModule](https://developer.eagle.cool/plugin-api/zh-cn/extra-module/ffmpeg)、[格式扩展（`viewer` 可用 `require`）](https://developer.eagle.cool/plugin-api/zh-cn/get-started/plugin-types/preview)、[event（仅 7 个）](https://developer.eagle.cool/plugin-api/zh-cn/api/event) |
| 高 · 官方帮助中心 | [插件安装位置](https://tw.eagle.cool/support/article/where-are-eagle-plugins-installed-on-my-computer)、[视频播放器快捷键](https://docs-cn.eagle.cool/article/1424-video-player) |
| 中 · 第三方教程 | [检查器插件开发详解](https://www.wanxiangyundang.top/read/eagle-plugin-dev/c02-03-inspector-plugin)（`height` 为默认高度、建议 100–150） |
| 中 · 社区开源实现 | [VideoTileKun Inspector](https://community-jp.eagle.cool/plugin/054118d7-01e3-403f-a69e-4d7da614508b)、[用户指南](https://github.com/animtools/eagle-plugin-support/blob/main/docs/VideoTileKun-plugins/USER_GUIDE.md) |
| 推断 · 待实测 | 宿主 iframe 的 `frameElement` 可否运行时改高 |

---

## 许可

[MIT](LICENSE) © 2026 Dugege007
