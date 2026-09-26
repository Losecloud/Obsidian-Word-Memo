<div align="center">

# 词忆 · Word Memo

**专攻难词 · 趣味高效**

一款永久免费、共创生态的单词记忆工具，与笔记深度集成：悬浮取词 · 划词翻译 · 难词可视化 · 间隔复习 · AI 工坊

`Obsidian 1.4.0+` · `仅桌面端` · `MIT`

[中文](README.md) | [English](README_EN.md)

![词忆](https://raw.githubusercontent.com/Losecloud/reciting/main/static/cover/%E9%98%85%E8%AF%BB%E8%81%94%E6%83%B3%E8%AE%B0%E5%BF%86.png)

</div>

词忆不是「查词弹窗」的堆砌，而是把 **查 → 记 → 复习 → 玩** 串成闭环：在笔记里即查即存，用可交互的可视化封面看清自己的词汇版图，用 SM-2 安排每一次复习，再让 AI 把枯燥的重复变成想玩的事。

## 📦 安装

**社区市场（推荐）**

**设置 → 第三方插件 → 浏览** → 搜索 `Word Memo` → **安装** → **启用**。

**手动安装**

1. 从最新 Release 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放入 `<你的库>/.obsidian/plugins/word-memo/`。
3. 在 **设置 → 第三方插件** 中启用 **Word Memo**。

## 🔍 在 Obsidian 中取词

| 能力 | 说明 |
| --- | --- |
| **悬浮取词** | 鼠标悬停在笔记或文本型 PDF 的单词上，右侧栏即刻给出释义 |
| **划词翻译** | 选一个词查词典，选一句话交给 AI 翻译；支持浮动按钮与右键菜单 |
| **侧栏查词** | 独立的词忆面板常驻右侧栏，由内置查词引擎驱动 |
| **完整应用** | 在标签页打开词忆全功能界面（词书、可视化封面、复习、AI 工坊） |

悬浮取词与划词翻译可在 **设置 → Word Memo** 中开关。

## ⚙️ 环境要求

- Obsidian **1.4.0** 或更高版本，桌面端（Windows / macOS / Linux）。
- 无需额外文件：词忆应用已内嵌于 `main.js`。首次运行时插件会把它解压到库内的 `.word-memo/`，并通过本地 `127.0.0.1` 服务加载，使应用运行在独立 origin 上以正常保存配置。

<!-- SHARED:BEGIN -->

## ✨ 核心能力

### 1️⃣ 难词可视化：蒲公英聚类 与 混沌星云

> 两套自研封面——2D 力导向的仿生蒲公英，与 WebGL 流场粒子的 3D 星云

**蒲公英聚类**把词按词义一级分类聚成花冠外圈，种子大小取 CEFR 词频，正确率 ≤ 50% 的重点难词自动标红；切换「忘记词」口径，待复习的词即从花头飘向空中——花头留下的是已掌握，飘着的就是要复习的，还可直接拖拽整理清单。
**混沌星云**以无散度流场驱动上万粒子，点选任一词即以贝塞尔曲线连出最强关联（词根、形近可跨星团）并标注关系依据。难词由此不再是散点，而是一张有优先级、有联想路径的网。

![蒲公英聚类](https://raw.githubusercontent.com/Losecloud/reciting/main/static/md-image/%E8%92%B2%E5%85%AC%E8%8B%B1%E8%81%9A%E7%B1%BB.png)

![混沌星云](https://raw.githubusercontent.com/Losecloud/reciting/main/static/md-image/%E6%B7%B7%E6%B2%8C%E6%98%9F%E4%BA%91.png)

### 2️⃣ 智能导入生词清单 × 五种学习模式 × SM-2 智能复习

> 把任何形态的生词清单丢进来，选一个适合的模式开始记，剩下的交给算法

支持 TXT / CSV / Excel / DOCX 导入并自动识别表结构，缺音标释义时先正则提取单词立即入库、再由 AI 后台补齐。五种模式可选——看单词选释义、看释义拼单词、记得么、同义替换、熟词僻义，由「认得出」递进到「分得清」。复习交给跟随艾宾浩斯曲线的 SM-2 自动排程，配合弱点自查定位最该补的词；也可接入任意 OpenAI 兼容 API 辅助记忆。

![学习模式与复习](https://raw.githubusercontent.com/Losecloud/reciting/main/static/md-image/%E5%AD%A6%E4%B9%A0%E6%A8%A1%E5%BC%8F%E4%B8%8E%E5%A4%8D%E4%B9%A0.png)

### 3️⃣ 130K+ CEFR 分级词汇 × 社区词典工坊 × 自带词典导入

> 13 万+ 词条自带 CEFR 等级标签 · 词典免费按需下载 · 你自己的 MDX / JSON 词典也能直接用

内置 **130,000+ 条带 CEFR 分级标签**的词汇数据：写作评估、可视化着色、生词分档全部建立在这套分级之上。**社区工坊免费收录牛津、柯林斯**、词根词缀、同义词典等词库，点一下就装进你的库，不预置、不捆绑。

同时支持导入你自己的 **MDX / JSON / JS 词典**（含配套 MDD 样式与真人发音），详见下方「词典数据」。

![词典工坊](https://raw.githubusercontent.com/Losecloud/reciting/main/static/md-image/%E8%AF%8D%E5%85%B8%E5%B7%A5%E5%9D%8A.png)

### 4️⃣ 英文学习插件共创生态

> 已发布，且持续上新

词忆把「AI 工坊」开放给了所有人：任何人都能为英文学习贡献一个插件。目前官方已发布的应用包括但不限于——

- **阅读联想记忆（生词串文）** — 用你收藏的生词生成可读的短文与考题，在语境中记住它
- **CEFR 写作评估** — 实时按 CEFR 等级高亮你写的英文，看得见自己的用词层次
- **英文原著分级推荐** — 接古登堡计划榜单，按难度挑下一本该读的原著
- **微信读书划线导出** — 把阅读中的划线与想法导出为 Markdown，或直接提取成词书
- **文字游戏** — 沉浸式剧情（恐怖 / 科幻 / 恋爱）中记单词

![插件共创生态](https://raw.githubusercontent.com/Losecloud/reciting/main/static/md-image/%E6%8F%92%E4%BB%B6%E5%85%B1%E5%88%9B%E7%94%9F%E6%80%81.png)

### 5️⃣ 一键收藏进欧路词典

> 直连欧路词典 OpenAPI · 增量静默同步

把词单与你的**欧路生词本**链接起来，之后每次收藏都自动、静默地增量推送到欧路——在笔记里看到的词，手机上打开欧路就能复习，两套工具的数据从此是一条线。

![欧路词典联动](https://raw.githubusercontent.com/Losecloud/reciting/main/static/md-image/%E6%AC%A7%E8%B7%AF%E8%AF%8D%E5%85%B8%E8%81%94%E5%8A%A8.png)

## 📖 词典数据

**① 社区工坊（可选，免费按需下载）**

应用**不预置**词典数据，内置引擎已覆盖核心查词流程；更大的词典包（柯林斯、词根词缀、同义词表等）为可选项。打开 **AI 工坊 → 词典**，点击对应词库的 **下载**：它会从本项目的公开 GitHub 仓库拉到本地并自动启用（Web 端存于浏览器本地，Obsidian 端存于库内的 `.word-memo/data/`）。

每个词库都是**单个 JSON 数据文件**（`<name>-dict.json`），只含词典文本；读取方式为 `fetch` + `JSON.parse`，**不会作为代码执行**，且仅存于本地、从不上传。文件名对应一个词典变量名（如 `collins-dict.json` → `COLLINS_DICT`），记录在 `data/dict-manifest.js` 中。

**② 导入你自己的词典（MDX / JSON / JS）**

内置 **MDictionary（MDX）格式的解析器**，同时支持直接导入 **JSON / JS 词典**，把你手头的词典装进来：

- **直接导入**：在查词面板点击 **导入** 选择 `.mdx` / `.json` / `.js`；插件端还支持把文件**拖进 Obsidian 右侧栏的导入区**。MDX 解析在本地完成——自动识别 v1 / v2 头部、UTF-8 / UTF-16 编码、LZO 与 zlib 压缩块，乃至带密钥的 key-block 加密；JSON 直接读取，JS 仅剥离外层 `var 变量名 = {...}` 赋值语句（**不执行任何脚本**，不接受含函数的脚本词典）。三者解析结果都转为纯 JSON 文本写入 `data/` 并立即启用，文件名与变量名沿用 `oaldpe-dict.json` → `OALDPE_DICT` 的约定。
- **保留原版样式与真人发音**：配套的 **MDD 资源包**（原版 CSS 排版、mp3 发音、插图）解出为同名资源目录后会被自动识别，词条 HTML 中的图片 / 音频 / CSS 均按该目录解析——带样式的词典能保留原貌，点发音键走词典自带的真人音频，仅在缺失时才回退 TTS。

解析全程只使用 `fetch` + `JSON.parse` 读取文本，词典内容**不会作为代码执行**。

## 🌐 网络使用

词忆在本地查词、复习与可视化封面上完全离线。以下远程服务**仅在**你主动触发对应功能时才会访问，列于此以保持透明：

| 服务 | 触发时机 | 说明 |
| --- | --- | --- |
| GitHub（`raw.githubusercontent.com`、`github.com/.../releases/download/...`） | 打开「关于」页，或点击词典包的**下载** | 公开只读下载说明文档与你指定的词典数据文件，不发送任何数据。 |
| 你的 AI 服务商（OpenAI、SiliconFlow 或任意 OpenAI 兼容端点） | 请求翻译、AI 讲解或导入后补齐词条时 | 端点与密钥由你配置、存于本地；未经你操作不会发送任何内容。 |
| 欧路词典 OpenAPI（`api.frdic.com`） | 使用欧路词典联动时 | 需要你自己的授权码。 |
| 微信读书（`i.weread.qq.com`） | 加载英文原著榜 / 导出划线时 | 需要你自己的 Key。 |
| 古登堡计划元数据（`gutendex.com`） | 浏览英文原著榜时 | 仅公开元数据。 |
| 热点榜单（`zj.v.api.aa1.cn`） | 在**口语角话题**中点击 **搜索热点** 时 | 公开的微博 / 百度榜单数据，不发送任何数据。 |
| tianapi（`apis.tianapi.com`） | 在**口语角话题**中点击 **搜索热点**，**且**你已在其中 ☰ 设置里填入自己的 tianapi Key | 需要你自己的 Key；未填 Key 时完全跳过。 |
| Google Translate TTS（`translate.google.com`） | 仅作为发音兜底 | 无本地音频时使用。 |

**无遥测、无统计、无广告、无自动更新。** 除非调用上述功能，应用不会联系任何服务器。

## 🔒 数据与隐私

- 全部设置、词书与复习进度都保存在你的本地：Web 端为浏览器本地存储，Obsidian 端为库内的 `.word-memo/user/`。从不上传。
- API 密钥存于本地配置，不写入插件的 `data.json`。
- 插件**只访问库内文件**（`.word-memo/`），不触碰磁盘上的其他内容。

## 🤝 参与贡献

欢迎贡献代码、报告问题或提出建议。想为英文学习添一个插件？词忆的 **AI 工坊**面向所有人开放——Fork 本项目，把你的插件放进工坊目录并提交 PR 即可（详见「核心能力 · 英文学习插件共创生态」）。

1. Fork 本项目
2. 创建特性分支（`git checkout -b feature/AmazingFeature`）
3. 提交更改（`git commit -m 'Add some AmazingFeature'`）
4. 推送到分支（`git push origin feature/AmazingFeature`）
5. 开启 Pull Request

<!-- SHARED:END -->

## 🛠️ 开发

本插件由词忆应用生成。宿主源码位于 `src/`（`plugin.js` 为宿主，`styles.css` 为插件样式）；应用内核由主仓库的 `tools/web2ob.py` 打包为 `main.js` 中的单个 `WM_APP_BUNDLE` 字符串——容器为朴素的 `WMB1` 分帧，随后经 brotli 压缩与 base64 编码，**不含加密或混淆**。

```bash
python tools/web2ob.py                     # 打包应用内核（不内嵌任何词典）
```

请勿手改 `main.js`——修改 `src/plugin.js` 后重新构建。

## 💬 联系与支持

- 问题反馈：[GitHub Issues](https://github.com/Losecloud/Obsidian-Word-Memo/issues)
- 功能建议：[GitHub Discussions](https://github.com/Losecloud/VocRec/discussions)
- 主项目：[https://github.com/Losecloud/reciting](https://github.com/Losecloud/reciting)

## 📄 许可

[MIT](LICENSE)

## English

Word Memo is a permanently free vocabulary tool for Obsidian, deeply integrated with your notes: hover lookup · selection translate · hard-word visualization · spaced repetition review · AI workshop. The plugin UI is currently in Chinese; the full English documentation is in [README_EN.md](README_EN.md).

### Installation

**From Obsidian:** **Settings → Community plugins → Browse** → search `Word Memo` → **Install** → **Enable**.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the latest release into `<your vault>/.obsidian/plugins/word-memo/`, then enable **Word Memo** under **Settings → Community plugins**.

### Usage

- **Hover lookup** — hover a word in a note or a text-based PDF and its definition appears in the right sidebar.
- **Selection translate** — select a word for its dictionary entry, or a sentence for an AI translation (floating button or right-click menu).
- **Sidebar panel** — a dedicated Word Memo panel docked in the right sidebar, powered by the built-in dictionary engine.
- **Full app view** — open the complete app (word books, visual covers, review, AI workshop) in a tab.

Hover lookup and selection translate can be turned off in **Settings → Word Memo**.

---

<div align="center">

**如果这个项目对你有帮助，请给个 ⭐️ Star 支持一下！**

Made with ❤️ by [Losecloud]

</div>

![词忆 · Obsidian 单词记忆插件](https://raw.githubusercontent.com/Losecloud/reciting/main/static/md-image/%E6%96%87%E6%A1%A3%E5%B0%81%E5%BA%95.png)
