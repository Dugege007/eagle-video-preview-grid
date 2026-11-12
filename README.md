# Eagle Video Preview Grid

> 给 Eagle 检查器加一块「视频预览图」区块：点一次「生成」，按等距时间点自动抽出静态帧，一眼扫完这个视频的大致内容。

- **类型**：Eagle 4.0 检查器扩展插件（`preview.<ext>.inspector`），只新增区块，不替换 / 干扰原生视频播放器
- **版本**：0.1.0（2026-11-12）
- **许可**：MIT
- **状态**：⚠️ 代码骨架完成、采样算法已单测通过，**尚未在真实 Eagle 中安装实测**（见「已验证 / 未验证」）

---

## 一、为什么做这个

试用 [VideoTileKun Inspector](https://community-jp.eagle.cool/plugin/054118d7-01e3-403f-a69e-4d7da614508b) 后，发现它功能有重叠，但设置项过多、部分能力用不上，于是决定自研一个更精简的版本，**只参考它的 FFmpeg 抽帧实现思路**。

| | VideoTileKun Inspector | 本插件 |
| --- | --- | --- |
| 设置项 | 网格大小范围、抽帧间隔秒、画质、hover 缩放、亮度/对比度/饱和度… | **只有「自动生成数量」** |
| 取点方式 | 固定间隔（需自己调） | 按视频时长自动分段，内置最低 5 秒保护 |
| 预览形态 | 缩图 + hover 从该帧播放 | **纯静态图**，完全不加载 `<video>` |
| 文字说明 | 单张 tag（overlay 显示） | 本期不做 |
| 触发 | 一键生成 | 一键生成 |
| 依赖 | 官方 FFmpeg 插件 | 官方 FFmpeg 插件 |

---

## 二、本期范围

**做**

- 一键自动生成静态预览图，图下小字时间码（`MM:SS` / `HH:MM:SS`）
- 唯一设置项「自动生成数量」，默认 **9**，范围 1–30
- 默认最多显示前 **9** 张，超出可展开 / 折叠（网格内部滚动，不撑高 iframe）
- 6 套 Eagle 主题适配、缓存自动失效与重建

**明确不做**

| 不做 | 原因 |
| --- | --- |
| 点击跳转播放 | `item.open()` 无 `time` 参数，两套官方 API 均无播放控制 —— 官方硬边界 |
| 快捷键 / 自定义取帧 | 先只做自动生成；「抓主播放器当前帧」拿不到 `currentTime`，iframe 无焦点 |
| 可编辑文字描述 | 本期不需要；后续口径已定，见「路线图」 |
| hover 播放、右键菜单、单张删除 / 重抽、章节导出 | 用不上，避免设置与交互膨胀 |

---

## 三、安装

1. 在 Eagle 插件中心安装官方 **「FFmpeg 依赖插件」**（本插件 `manifest.json` 声明了 `dependencies: ["ffmpeg"]`）。
2. 把本仓库整个目录复制到 Eagle 插件目录（入口：插件 → 开发者选项 → 打开插件文件夹；**具体路径待实测**）。
3. 重启 Eagle，选中一个视频 → 右侧检查器出现「预览图」区块。
4. 首次可把区块拖到想要的位置（Eagle 4.0 检查器支持拖拽排序；manifest 无 `order` / `position` 字段，插件无法指定默认位置）。

**环境要求**：Eagle 4.0 build22+；官方 FFmpeg 依赖插件。优先 Windows（社区 FFmpeg 插件在 Windows 已验证）。

> 若区块里提示「当前检查器环境无法调用 Node 模块」，说明该环境不允许 `require('child_process')`，需要改为后台服务插件专职抽帧（见「已验证 / 未验证」）。

---

## 四、使用

1. 选中视频 → 区块显示「尚未生成预览图，点『生成』按钮自动生成」。
2. 需要时改「数量」（默认 9）→ 点「生成」。
3. 生成后显示缩图网格 + 时间码；数量改了或视频文件被替换，缓存自动失效并提示重新生成。
4. 超过 9 张时右下角出现「展开 ▾ / 收起 ▴」，状态在切换选中项时重置。

缓存命中时**直接显示**，不会重复抽帧。

---

## 五、采样算法

输入：`T` = 视频时长（秒，`ffprobe -show_format` 取 `format.duration`）、`N` = 自动生成数量（默认 9）；常量 `MIN_GAP = 5`。

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

**本期不做自定义描述，因此一条用户数据都不需要保存。** 时间点是 `(时长, 数量)` 的确定性函数，换机、重装或 Eaglepack 迁移后自动重算重建，不存在「数据丢失」问题。

```
{eagle.app.userDataPath}/eagle-video-preview-grid/
├── settings.json                  { "tileCount": 9 }
└── thumbs/<itemId>/
    ├── meta.json                  count / duration / gap / times / results
    │                              / sourceSize / sourceMtime / generatedAt
    └── 0.jpg … M-1.jpg
```

- `count`、`sourceSize`、`sourceMtime` 任一变化，或任一缩图缺失 → 缓存失效，提示重新生成。
- **不写 Eagle 资源库、不碰 `metadata.json`**（官方最佳实践明文禁止直接修改资源库文件）。
- 缩图用 base64 data URL 渲染，规避 Windows 中文路径 / 空格 / `#` 的 `file:///` 转义问题。

---

## 七、已验证 / 未验证（含负向结论）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 采样算法正确性 | ✅ 已验证 | `test/sampler.test.js`：11 组断言 + 1…600s × 1…30 张穷举不变量（间隔 ≥5s、首点 ≥1s、末点 < 时长） |
| 官方 API 字段与签名 | ✅ 文档核对 | 见「依据」 |
| 在真实 Eagle 中安装并跑通 | ❌ **未验证** | 本仓库刚建立，尚未实测 |
| `dependencies: ["ffmpeg"]` 对检查器插件生效 | ❌ **未验证** | 官方示例只给窗口插件与缩略图插件；若不生效需拆 `serviceMode` 后台插件 |
| 检查器 iframe 能否 `require('child_process')` | ⚠️ **推断可用，待实测** | 官方格式扩展 `viewer.html` 示例用了 `require()`；VideoTileKun Inspector 单插件即可抽帧（中可信）。代码已做能力检测与明确报错 |
| `getPaths()` 返回 `{ffmpeg, ffprobe}` | ✅ 官方文档明写 | FFmpeg extraModule 示例 |
| 点击让 Eagle **主播放器**跳到时间点 | ❌ 官方不支持 | `item.open()` 只有 `window` 参数；Plugin API 与本地 HTTP API 均无播放控制 → 本期不做 |
| 全局快捷键抓播放器当前帧 | ❌ 官方不支持 | 拿不到 `currentTime`、iframe 无焦点、7 个 event 无键盘 / 播放器事件 |
| 改原生标注栏 / 给原生笔记塞图片 | ❌ 插件做不到 | 只能在检查器新增自己的 iframe 区块；`addComment` 无图片字段 |
| 用 `<video>` + canvas 抽帧 | ❌ 不用 | 检查器与主播放器同属 Chromium 107，不被管线支持的编码一样解不动；FFmpeg 是独立解码链路 |

---

## 八、开发

```bash
npm test          # 等价于 node test/sampler.test.js，无第三方依赖
python tools/make_logo.py   # 重新生成 logo.png（仅用 Python 标准库）
```

```
├── manifest.json          # 检查器插件声明
├── index.html             # 区块入口
├── css/style.css          # 主题适配 + 3 列网格
├── js/sampler.js          # 确定性采样（纯函数，浏览器 / Node 双用）
├── js/store.js            # 派生缓存读写
├── js/capture.js          # ffprobe 取时长 + FFmpeg 抽帧
├── js/main.js             # UI、轮询、生成流程
├── test/sampler.test.js   # 算法单测
├── tools/make_logo.py     # logo 生成脚本
└── logo.png               # manifest 图标
```

---

## 九、路线图（P0 / P1 / P2）

- **P0（本期）**：骨架 + 采样 + 抽帧缓存 + 网格 / 折叠 + 数量设置 + 主题适配；**实测第七节中 4 项未验证点**。
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
| 高 · 官方 API 文档 | [检查器插件](https://developer.eagle.cool/plugin-api/zh-cn/get-started/plugin-types/inspector)、[manifest 完整配置](https://developer.eagle.cool/plugin-api/zh-cn/tutorial/manifest)、[item](https://developer.eagle.cool/plugin-api/zh-cn/api/item)、[app（`userDataPath` / `theme`）](https://developer.eagle.cool/plugin-api/zh-cn/api/app)、[FFmpeg extraModule](https://developer.eagle.cool/plugin-api/zh-cn/extra-module/ffmpeg)、[格式扩展（`viewer` 可用 `require`）](https://developer.eagle.cool/plugin-api/zh-cn/get-started/plugin-types/preview)、[event（仅 7 个）](https://developer.eagle.cool/plugin-api/zh-cn/api/event) |
| 高 · 官方帮助中心 | [视频播放器快捷键](https://docs-cn.eagle.cool/article/1424-video-player)、[如何设置插件快捷键](https://cn.eagle.cool/support/article/how-to-set-up-plugin-shortcuts) |
| 中 · 社区开源实现 | [VideoTileKun Inspector](https://community-jp.eagle.cool/plugin/054118d7-01e3-403f-a69e-4d7da614508b)、[用户指南](https://github.com/animtools/eagle-plugin-support/blob/main/docs/VideoTileKun-plugins/USER_GUIDE.md) |
| 推断 · 待实测 | 检查器插件可 `require('child_process')`、`dependencies` 对 inspector 生效、缓存目录权限 |

---

## 许可

[MIT](LICENSE) © 2026 Dugege007
