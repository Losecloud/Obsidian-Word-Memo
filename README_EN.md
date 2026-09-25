<div align="center">

# Word Memo · 词忆

**Hard words only. Efficiently, enjoyably.**

The complete vocabulary workflow inside Obsidian: hover lookup · selection translate · hard-word visualization · spaced repetition · AI workshop

`Obsidian 1.4.0+` · `Desktop only` · `MIT`

[中文](README.md) | **English**

</div>

---

Word Memo is a vocabulary tool built for hard words, deeply integrated into Obsidian as a plugin. It is not a pile of lookup popups — it closes the loop of **look up → save → review → play**: look words up and save them straight from your notes, see your vocabulary landscape through interactive visual covers, let SM-2 schedule every review, and turn repetition into something you actually want to do.

## Lookup inside Obsidian

| Capability | Description |
| --- | --- |
| **Hover lookup** | Hover a word in a note or a text-based PDF and its definition appears in the right sidebar. |
| **Selection translate** | Select a word for its dictionary entry, or a sentence for an AI translation. Works with a floating button and the right-click menu. |
| **Sidebar lookup** | A dedicated Word Memo panel docked in the right sidebar, powered by the built-in dictionary engine. |
| **Full app view** | Open the complete Word Memo app (word books, visual covers, review, AI workshop) in a tab. |

Hover lookup and selection translate can be turned off in **Settings → Word Memo**.

## Highlights

### 1️⃣ Hard-word visualization: Dandelion Clustering and Chaos Nebula

> Two self-built covers — a 2D force-directed biomimetic dandelion, and a WebGL flow-field particle nebula

**Dandelion Clustering** groups words into an outer ring by top-level meaning category, sizes each seed by CEFR frequency and flags focus words with an error rate ≥ 50% in red; switch the "forgotten word" criterion and words due for review drift out of the flower head into the air — what stays is what you know, what drifts is what to review, and you can drag them to tidy the list. **Chaos Nebula** drives tens of thousands of particles through a divergence-free flow field; click any word to link its strongest relations with Bézier curves (word-root and similar-form links may cross clusters), each labelled with the reason. Hard words stop being scattered points and become a network with priorities and associative paths.

![Dandelion clustering](https://raw.githubusercontent.com/Losecloud/reciting/main/static/gifs/dandelion.gif)

![Chaos nebula](https://raw.githubusercontent.com/Losecloud/reciting/main/static/gifs/chaos.gif)

### 2️⃣ Smart word-list import × five study modes × SM-2 review

> Drop in any word list, pick the mode that fits, and let the algorithm handle the rest

Import TXT / CSV / Excel / DOCX with automatic table-structure detection; when phonetics or definitions are missing, the words are extracted by regex and imported right away, then filled in by AI in the background. Five modes — word → meaning, meaning → spelling, do you remember, synonym substitution, unusual senses — escalate from "recognize it" to "tell it apart". Review is scheduled automatically by SM-2 following the Ebbinghaus curve, with weakness self-check to find the words that need work most, and any OpenAI-compatible API can step in to assist your memory.

![Study modes and review](https://raw.githubusercontent.com/Losecloud/reciting/main/static/gifs/study-modes.gif)

### 3️⃣ 130K+ CEFR-graded words × community dictionary workshop × your own dictionary import

> 130,000+ entries with CEFR level tags · dictionaries downloaded free on demand · your own MDX dictionaries work too

Built in are **130,000+ vocabulary entries tagged with CEFR levels**: writing assessment, cover coloring and word grading all sit on top of this scale. The **community workshop freely collects Oxford, Collins**, word-root and synonym dictionaries — install one into your vault with a single click. Nothing is pre-bundled.

You can also import your own **MDX dictionaries** (with companion MDD styles and real-voice audio) — see "Dictionary data" below.

![Dictionary workshop](https://raw.githubusercontent.com/Losecloud/reciting/main/static/gifs/dictionary-workshop.gif)

### 4️⃣ A co-created ecosystem of English-learning plugins

> Released, and growing

The AI workshop is open to everyone: anyone can contribute a plugin for English learning. Official releases so far include, but are not limited to —

- **Reading association (word-threading)** — turns your saved words into readable passages and questions, so you remember them in context
- **CEFR writing assessment** — highlights your English by CEFR level in real time, so you can see the level of the words you use
- **Graded English classics** — pulls the Project Gutenberg ranking and suggests what to read next by difficulty
- **WeRead highlight export** — exports your highlights and notes from WeRead to Markdown, or extracts them into a word book
- **Vocabulary size test** — estimates your vocabulary size and tracks its long-term growth

![Plugin ecosystem](https://raw.githubusercontent.com/Losecloud/reciting/main/static/gifs/workshop.gif)

### 5️⃣ Fun apps: practice as play

> Text game · English corner topics · English murder mystery · English word chain

Studying words does not have to be solemn. The **text game** drops you into an immersive horror / sci-fi / romance story; **English corner topics** pull the day's trending news and generate debatable questions with high-scoring expressions; **English murder mystery** and **English word chain** turn speaking and vocabulary into a multiplayer contest. Here, learning and playing are no longer opposites.

![Fun apps](https://raw.githubusercontent.com/Losecloud/reciting/main/static/gifs/fun-apps.gif)

### 6️⃣ Save words to Eudic in one click

> Direct Eudic OpenAPI · incremental, silent sync

Link a Word Memo word book to your **Eudic vocabulary book**, and every save afterwards is pushed incrementally and silently to Eudic. Words you meet in a note are then ready for review in the Eudic mobile app — the two tools finally share one pipeline.

![Eudic integration](https://raw.githubusercontent.com/Losecloud/reciting/main/static/gifs/eudic.gif)

## Installation

**Community directory (recommended)**

**Settings → Community plugins → Browse** → search for `Word Memo` → **Install** → **Enable**.

**Manual installation**

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your-vault>/.obsidian/plugins/word-memo/`.
3. Enable **Word Memo** in **Settings → Community plugins**.

## Usage

| Action | How |
| --- | --- |
| Open the Word Memo sidebar | Click the search icon in the ribbon, or run the **查单词（词忆）** command |
| Open the full app | Click the layers icon in the ribbon, or run the **打开词忆 Word Memo** command |
| Look up a word | Hover it in a note or PDF, or select it and use the floating button / right-click **查询** |
| Translate a sentence | Select the sentence and use the floating button / right-click **查询** |

## Requirements

- Obsidian **1.4.0** or newer, on desktop (Windows / macOS / Linux).
- No extra files needed: the Word Memo app is bundled inside `main.js`. On first run the plugin extracts it to `.word-memo/` in your vault and serves it through a local `127.0.0.1` server, so the app runs in a proper origin and can store its configuration.

## Dictionary data

**① Community workshop (optional, free on-demand download)**

This plugin ships **without** dictionary data. The built-in engine covers the core lookup flow; larger dictionary packs (Collins, word roots, synonym lists, …) are optional. Open **AI 工坊 → 词典** inside the plugin and click **下载** on the pack you want: it is fetched from this project's public GitHub repository, written to `.word-memo/data/` inside your vault, and enabled automatically.

Each pack is a single **JSON data file** (`<name>-dict.json`) containing dictionary text only. It is read with `fetch` + `JSON.parse` — never executed as code — and it is stored locally and never uploaded anywhere. The filename maps to a dictionary variable name (e.g. `collins-dict.json` → `COLLINS_DICT`), which is recorded in `data/dict-manifest.js` inside the vault.

**② Import your own MDX dictionaries**

A **MDictionary (MDX) parser** is built into the plugin, so you can bring the dictionaries you already have:

- **Import directly**: click **导入** in the lookup panel and pick a `.mdx`; you can also **drop a `.mdx` file onto the import area in Obsidian's right sidebar**. Parsing happens inside the plugin — it detects v1 / v2 headers, UTF-8 / UTF-16 encoding, LZO and zlib compressed blocks, and even key-block encryption with derived keys; the result is converted to plain JSON text, written to `.word-memo/data/` and enabled immediately.
- **Original styling and real-voice audio preserved**: a companion **MDD resource pack** (the dictionary's original CSS, mp3 pronunciations, images) is recognized once extracted into a same-named resource folder, and images / audio / CSS referenced by the entry HTML resolve against it — a styled dictionary keeps its original layout, and the speak button uses the dictionary's own human audio, falling back to TTS only when it is missing.

Throughout, only `fetch` + `JSON.parse` is used to read text; dictionary content is **never executed as code**.

## Network use

Word Memo works fully offline for local lookup, review and the visual covers. The following remote services are used **only** when you explicitly trigger the corresponding feature, and are listed here for transparency:

| Service | When | Notes |
| --- | --- | --- |
| GitHub (`raw.githubusercontent.com`, `github.com/.../releases/download/...`) | When you click **下载** on a dictionary pack in AI 工坊 | Public read-only download of the dictionary data file you asked for. No data is sent. |
| Your AI provider (OpenAI, SiliconFlow, or any OpenAI-compatible endpoint) | When you request a translation or an AI explanation, or when entries are filled in after an import | Endpoint and API key are configured by you and stored locally. Nothing is sent without your action. |
| Eudic OpenAPI (`api.frdic.com`) | When you use the Eudic integration | Requires your own token. |
| WeRead (`i.weread.qq.com`) | When you load the English classics ranking, or export highlights | Requires your own key. |
| Project Gutenberg metadata (`gutendex.com`) | When you browse the English classics list | Public metadata only. |
| Hot-topic ranking (`zj.v.api.aa1.cn`) | Only when you click **搜索热点** in the English corner feature | Public ranking data for Weibo / Baidu. No data is sent. |
| tianapi (`apis.tianapi.com`) | Only when you click **搜索热点** in the English corner feature, **and** you have entered your own tianapi key in its ☰ settings | Requires your own key. Skipped entirely when no key is set. |
| Google Translate TTS (`translate.google.com`) | Only as a pronunciation fallback | Used when no local audio is available. |

**No telemetry, no analytics, no ads, no auto-update mechanism.** The plugin never contacts any server unless one of the features above is invoked.

## Data & privacy

- All settings, word books and review progress live in your vault (`.word-memo/user/`) and on your machine. They are never uploaded.
- API keys are stored locally in your vault configuration, not in this plugin's `data.json`.
- The plugin accesses files **inside your vault only** (`.word-memo/`), plus nothing else on disk.

## Development

This plugin is generated from the Word Memo web app. Source lives in `src/` (`plugin.js` is the host, `styles.css` the plugin styles). The web app core is packed into a single `WM_APP_BUNDLE` string in `main.js` by `tools/web2ob.py` in the main repository — the container is plain `WMB1` framing followed by brotli and base64, with **no encryption or obfuscation**:

```
python tools/web2ob.py                     # bundle the app core (no dictionary is embedded)
```

Do not edit `main.js` by hand — edit `src/plugin.js` and rebuild.

## Support

- Issues and feature requests: <https://github.com/Losecloud/Obsidian-Word-Memo/issues>
- Main project: <https://github.com/Losecloud/reciting>

## License

[MIT](LICENSE)
