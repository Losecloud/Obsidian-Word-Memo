const { Plugin, ItemView, Notice, addIcon, PluginSettingTab, Setting, setIcon } = require('obsidian');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');

const VIEW_TYPE = 'word-memo-view';
// 右侧栏「查单词」视图（复用同一入口页的 dict-lookup 引擎，?wmView=dict 切换为侧栏模式）
const DICT_VIEW_TYPE = 'word-memo-dict-view';
// 封面视窗（?wmView=cover）：只渲染可视化封面，供其它可视化插件内嵌为独立窗口
const COVER_VIEW_TYPE = 'word-memo-cover-view';
// vault 内的入口文件（相对 vault 根目录）。发行版从内嵌包加载，此项仅开发态回退时使用
const ENTRY_FILE = 'index - 词忆.html';
// 内嵌应用包的解压目录（相对 vault 根目录）。以点开头，Obsidian 不索引，保持 vault 根目录整洁
const APP_DIR = '.word-memo';
// 固定端口：localStorage 按 origin（含端口）隔离，端口必须跨会话稳定，否则数据会丢
const DEFAULT_PORT = 39217;
const PORT_TRIES = 10;
// 悬浮取词：鼠标在笔记单词上停留多久后取词（毫秒）
const HOVER_DELAY = 500;
// 悬浮取词的取词节流间隔（毫秒），降低 caretRangeFromPoint 的调用开销
const HOVER_TICK = 80;
// 已获识别结果后，鼠标需移动超过该像素距离才再次尝试取词（期间保持右侧当前词汇不变）。
// 小于此值的抖动不触发新取词，避免原位反复取景与反复 OCR
const HOVER_MOVE_THRESHOLD = 12;
// 图片悬浮取词（OCR）：命中图片时用 Windows 系统 OCR 识别光标下的单词。
// 取景框从鼠标位置起，按行/列墨迹投影自动延伸到词边界，再精准裁剪放大后送 OCR
const OCR_MAX_CROP_W = 120;   // 取景框单侧搜索下限（原图像素）；上限随字高自适应，未定界时再放大 50% 重试
const OCR_TARGET_H = 40;      // 裁剪后目标字高（像素）：放大到这个高度附近 OCR 最稳
const OCR_UPSCALE_MAX = 4;    // 裁剪放大倍数上限
const OCR_CROP_PAD = 2;       // 裁剪四周留白（原图像素），避免切掉升部/降部
const OCR_INK_CACHE = 3;      // 二值墨迹图缓存张数（单张可达数 MB，按 LRU 控制内存）
const OCR_WORD_CACHE = 64;    // 取景框哈希 → 词 的缓存条数，避免同一单词重复 OCR
// Windows 系统 OCR（Windows.Media.Ocr）调用脚本：由宿主 spawn powershell.exe 执行，
// 输入图片路径经环境变量 WM_OCR_IMG 传入，输出 JSON 词表（含 bounding box）。
// 用 -EncodedCommand 传递可避免在磁盘落地 .ps1；只能用 powershell.exe（5.1），
// pwsh(7) 不支持 WinRT 投影。
const OCR_PS_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    'function Await($op, $t) {',
    '  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))',
    '  $task.Wait(-1) | Out-Null',
    '  $task.Result',
    '}',
    '[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null',
    '$path = $env:WM_OCR_IMG',
    '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])',
    '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
    '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
    'if ($engine -eq $null) { throw "no OCR engine available" }',
    '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
    '$out = @()',
    'foreach ($line in $result.Lines) { foreach ($w in $line.Words) { $r = $w.BoundingRect; $out += [pscustomobject]@{ text = $w.Text; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } } }',
    'ConvertTo-Json -Compress -InputObject @($out)'
].join('\n');
// base64(UTF-16LE) 编码后的脚本，惰性生成一次
let OCR_PS_ENCODED = '';
function ocrEncodedCommand() {
    if (!OCR_PS_ENCODED) OCR_PS_ENCODED = Buffer.from(OCR_PS_SCRIPT, 'utf16le').toString('base64');
    return OCR_PS_ENCODED;
}
// 内部桥接接口前缀（供页面读写 user/ 目录）
const BRIDGE_PREFIX = '/__wm__/';
// 用户配置目录（相对 vault 根目录）
const USER_DIR = 'user';
// 「查单词（词忆）」统一图标：static/image/search.svg 的内联副本。
// addIcon 要求传入「不含 <svg> 外层标签」的内容，且内容须落在 0 0 100 100 视图框内，
// 故用 <g transform> 把原图 80.14 的坐标系等比缩放到 100。fill 取 currentColor 以适配深浅主题，
// 并显式写 fill/stroke 覆盖 Obsidian .svg-icon 默认的描边样式
const SEARCH_ICON_ID = 'word-memo-search';
const SEARCH_ICON_CONTENT = '<g transform="scale(1.24782)" fill="currentColor">'
    + '<path fill="currentColor" stroke="none" d="M35.2,2.25c17.23-.63,32.04,11.58,35.83,27.85,1.6,6.96,1.04,14.22-1.61,20.86-1.11,2.71-2.3,4.76-3.86,7.19,4.11,4.12,8.27,8.19,12.34,12.35,1.03,1.06,1.7,1.98,1.64,3.52-.04,1.09-.52,2.12-1.34,2.86-.74.67-1.77,1.06-2.79,1.03-2.03-.07-3.13-1.52-4.44-2.84-.97-.96-1.94-1.93-2.91-2.9l-5.14-5.2c-.86-.86-1.91-1.83-2.71-2.69-.81.84-1.52,1.35-2.43,2.06-5.8,4.42-12.85,6.96-20.19,7.28-9.41.3-18.55-3.07-25.43-9.38C5.41,58.09,1.01,48.84.65,39.78c-.06-1.42-.06-3.4.04-4.78.54-6.97,3.16-13.64,7.53-19.17.81-1.03,1.67-1.94,2.57-2.89,6.37-6.6,15.15-10.45,24.41-10.69ZM37.53,65.54c.92-.02,1.95-.15,2.85-.28,5.98-.86,11.47-3.8,15.62-8.08,5.43-5.61,8.16-13.21,7.88-20.9-.04-1.15-.3-2.74-.55-3.87-1.19-5.59-4.08-10.7-8.28-14.66-5.16-4.88-12.08-7.55-19.24-7.42-.14,0-.39,0-.53.02-7.74.32-14.32,3.34-19.48,9.02-5.14,5.66-7.56,12.75-7.12,20.29.45,7.61,3.8,14.02,9.46,19.12,4.5,4,10.25,6.38,16.31,6.74.96.06,2.1.05,3.07.03Z"/>'
    + '<path fill="currentColor" stroke="none" d="M35.53,33.56c2.39-.4,4.65,1.22,5.04,3.61.39,2.39-1.24,4.65-3.64,5.03-2.38.38-4.62-1.24-5-3.62-.39-2.38,1.22-4.62,3.6-5.02Z"/>'
    + '<path fill="currentColor" stroke="none" d="M20.95,33.59c2.38-.47,4.69,1.08,5.15,3.46.46,2.38-1.1,4.68-3.49,5.13-2.37.45-4.65-1.1-5.11-3.47-.46-2.36,1.08-4.65,3.44-5.12Z"/>'
    + '<path fill="currentColor" stroke="none" d="M49.91,33.58c2.39-.45,4.68,1.14,5.11,3.53.43,2.39-1.17,4.67-3.57,5.08-2.37.4-4.62-1.18-5.04-3.54-.42-2.36,1.14-4.63,3.5-5.07Z"/>'
    + '</g>';
// 完整内联 <svg>（供自绘 DOM，如浮出按钮 / 右键菜单项图标使用）
const SEARCH_ICON_INLINE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + SEARCH_ICON_CONTENT + '</svg>';
// 词忆标志（static/image/word-memo-logo-medium.svg 的内联副本）：填充式单路径。
// 原视图框即 0 0 99.97 99.97，已落在 addIcon 要求的 0 0 100 100 内，无需缩放；
// fill 取 currentColor 与「查单词」图标统一着色，并显式写 fill/stroke 覆盖 Obsidian
// .svg-icon 默认的描边样式，避免填充路径被额外描边
const WORD_MEMO_ICON_ID = 'word-memo-logo';
const WORD_MEMO_ICON_CONTENT = '<path fill="currentColor" stroke="none" d="M50,18.68c-1.69-.01-3.4.26-5,.82-3.41,1.49-5.27,4.2-6.5,7.5l-16,40.5c-.26-5.19-1.4-25.71-1.86-36.33-.51-11.68-3.87-14.46-15.14-14.17-1.48.28-2.9.62-4,2-.5.57-.78,1.54-.5,2.5-.06,1,.35,1.83,1,2.5,3.22,2.58,8.41-.65,9,5l1.5,40c.34,4.13.48,9.33,4,12,3.62,3.04,9.05,1.96,11.5-1.5,1.94-2.53,2.84-5.3,4-8l15.5-39.5c.54-1.06,1.52-1.69,2.5-1.66.98-.03,1.96.61,2.5,1.66l15.5,39.5c1.16,2.7,2.06,5.47,4,8,2.45,3.46,7.88,4.54,11.5,1.5,3.52-2.67,3.66-7.87,4-12l1.5-40c.59-5.65,5.78-2.42,9-5,.65-.67,1.06-1.5,1-2.5.28-.96,0-1.93-.5-2.5-1.1-1.38-2.52-1.72-4-2-11.29-.29-14.45,2.34-15.14,14.17-.62,10.63-1.6,31.12-1.86,36.33l-16-40.5c-1.23-3.3-3.09-6.01-6.5-7.5-1.6-.55-3.31-.83-5-.82Z"/>';
// 插件仓库地址（与 manifest.authorUrl 一致），设置页「关于」分区的链接目标
const REPO_URL = 'https://github.com/Losecloud/Obsidian-Word-Memo';
// 与 js/storage.js 中 _userFile 保持一致的非法字符替换规则
const sanitizeUser = (name) => String(name || 'default').replace(/[\\/:*?"<>|]/g, '_');
// Obsidian 当前主题：body / html 上的 theme-dark / theme-light 类
const hostTheme = () => {
    const cls = (document.body ? document.body.classList : null) || document.documentElement.classList;
    if (cls.contains('theme-dark')) return 'dark';
    if (cls.contains('theme-light')) return 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

// 词典导入落盘：与 tools/serve.js 的 POST /save-dict 对齐，使插件内置服务可直接替代本地服务
const sanitizeDictVarName = (varName) => String(varName || '')
    .replace(/[^\p{L}\p{N}_-]/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'DICT';
const dictFileName = (varName, ext) => sanitizeDictVarName(varName).replace(/_DICT$/i, '').toLowerCase()
    + '-dict.' + (ext === 'json' ? 'json' : 'js');
// JSON 词典没有 var 声明，按文件名约定推导变量名：word-roots-dict.json → WORD_ROOTS_DICT
const dictVarNameFromFile = (fname) => String(fname).replace(/-dict\.json$/i, '').replace(/-/g, '_').toUpperCase() + '_DICT';
// 词典清单里的显示名覆盖（文件名保持英文，供路径与变量名推导）
const DICT_DISPLAY_NAMES = { 'englishwords-dict.json': '基础词典' };
// 更新 data/dict-manifest.js：只 upsert 本次导入的词典条目，保留其余条目原样。
// 不用整表重扫，避免抹掉已有条目的 mdd 资源目录（如 oaldpe 的样式/发音）等字段
// varNameHint：JSON 内容无法解析出变量名，由调用方（/save-dict 请求）显式提供
// 返回 { count, mdd }：mdd 为同名资源目录名（样式/图片/真人发音），供 /save-dict 响应回传给前端
function upsertDictManifest(dataDir, fname, content, varNameHint) {
    let varName = varNameHint || '';
    if (!varName) {
        const mv = /var\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*=\s*\{/u.exec(String(content || '').slice(0, 4096));
        if (mv) varName = mv[1];
    }
    if (!varName && /-dict\.json$/i.test(fname)) varName = dictVarNameFromFile(fname);
    if (!varName) return { count: 0, mdd: '' };
    const mf = path.join(dataDir, 'dict-manifest.js');
    let list = [];
    try {
        const arr = /\[[\s\S]*\]/.exec(fs.readFileSync(mf, 'utf8'));
        if (arr) list = JSON.parse(arr[0]);
    } catch (e) { /* 无清单或格式异常：从空表开始 */ }
    if (!Array.isArray(list)) list = [];
    // 资源目录按文件名主干探测，与显示名无关——若按 name（可能被 DICT_DISPLAY_NAMES 改写成中文）探测，
    // 一旦词典配了显示名就找不到 data/<主干>/ 资源目录，样式会静默失效
    const stem = fname.replace(/-dict\.(js|json)$/i, '');
    const name = DICT_DISPLAY_NAMES[fname] || stem;
    const entry = { file: fname, name: name, varName: varName };
    if (/-dict\.json$/i.test(fname)) entry.format = 'json';
    // 同名资源目录存在则记录 mdd（词条 HTML 中的图片/音频/CSS 均相对该目录解析）
    const dir = path.join(dataDir, stem);
    const mdd = (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) ? stem : '';
    if (mdd) entry.mdd = mdd;
    const i = list.findIndex((x) => x && x.file === fname);
    if (i >= 0) list[i] = Object.assign({}, list[i], entry);
    else list.push(entry);
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    fs.writeFileSync(mf, '// 自动生成：浏览器导入或 tools/convert-mdx.js 更新，请勿手改\nvar DICT_MANIFEST = ' + JSON.stringify(list, null, 1) + ';\n', 'utf8');
    return { count: list.length, mdd: mdd };
}

// 从 data/dict-manifest.js 移除指定文件的条目（卸载词典时用），保留其余条目原样
function removeDictManifestEntry(dataDir, fname) {
    const mf = path.join(dataDir, 'dict-manifest.js');
    let list = [];
    try {
        const arr = /\[[\s\S]*\]/.exec(fs.readFileSync(mf, 'utf8'));
        if (arr) list = JSON.parse(arr[0]);
    } catch (e) { /* 无清单：无需处理 */ }
    if (!Array.isArray(list)) return 0;
    const next = list.filter((x) => !x || x.file !== fname);
    if (next.length === list.length) return list.length;
    fs.writeFileSync(mf, '// 自动生成：浏览器导入或 tools/convert-mdx.js 更新，请勿手改\nvar DICT_MANIFEST = ' + JSON.stringify(next, null, 1) + ';\n', 'utf8');
    return next.length;
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8'
};

// 悬浮取词：取鼠标位置所在的英文单词（Chromium/Electron 提供 caretRangeFromPoint）
const WORD_CHAR = /[A-Za-z'’-]/;

// 两个节点是否处于同一视觉行：PDF 文本层一个词常被拆进同一行的相邻 span，
// 跨行必须断开，否则会把上一行行尾与下一行行首误拼成一个词
function sameVisualLine(a, b) {
    if (!a || !b || typeof a.getBoundingClientRect !== 'function') return true;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if (!ra.height || !rb.height) return true;
    return Math.abs(ra.top - rb.top) < Math.max(ra.height, rb.height, 4);
}

// 取元素内某一端的连续词字符（dir=-1 取尾部、dir=1 取头部）
function textRun(el, dir) {
    const t = el.textContent || '';
    if (!t) return '';
    if (dir < 0) {
        let i = t.length - 1, s = '';
        while (i >= 0 && WORD_CHAR.test(t.charAt(i))) { s = t.charAt(i) + s; i -= 1; }
        return s;
    }
    let i = 0, s = '';
    while (i < t.length && WORD_CHAR.test(t.charAt(i))) { s += t.charAt(i); i += 1; }
    return s;
}

// 单词触到文本节点边界时，沿同行的相邻兄弟元素继续扩展。
// PDF 文本层常把一个单词拆进多个 span（甚至逐字符一个 span），
// 仅在同一个文本节点内取词会把单词截断，故需按元素兄弟关系向外拼接
function extendAcrossSiblings(node, start, end) {
    const text = node.nodeValue || '';
    let word = text.slice(start, end + 1);
    if (start > 0 && end < text.length - 1) return word; // 未触边界，无需扩展
    const origin = node.nodeType === 1 ? node : node.parentElement;
    if (!origin) return word;
    let guard = 24; // 最多跨 24 个兄弟元素，逐字符 span 的长单词也能拼齐
    let cur = origin;
    while (start === 0 && guard-- > 0) {
        const prev = cur.previousSibling;
        if (!prev) break;
        if (prev.nodeType !== 1 || !(prev.textContent || '')) { cur = prev; continue; }
        if (!sameVisualLine(prev, origin)) break; // 跨行断开，避免行尾行首误拼
        const add = textRun(prev, -1);
        word = add + word;
        if (add.length < (prev.textContent || '').length) break; // 该节点还有非词字符，词首已到
        cur = prev;
    }
    guard = 24;
    cur = origin;
    while (end === text.length - 1 && guard-- > 0) {
        const next = cur.nextSibling;
        if (!next) break;
        if (next.nodeType !== 1 || !(next.textContent || '')) { cur = next; continue; }
        if (!sameVisualLine(next, origin)) break;
        const full = next.textContent || '';
        const add = textRun(next, 1);
        word += add;
        if (add.length < full.length) break; // 该节点还有非词字符，词尾已到
        cur = next;
    }
    return word;
}

function wordAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode) {
            range = document.createRange();
            range.setStart(pos.offsetNode, pos.offset);
            range.collapse(true);
        }
    }
    if (!range) return '';
    const node = range.startContainer;
    if (!node || node.nodeType !== 3) return ''; // 非文本节点（图片/组件等）不取词
    const text = node.nodeValue || '';
    let i = range.startOffset;
    // 光标常停在词尾：当前字符非字母时向左回退一位再判定
    if (!WORD_CHAR.test(text.charAt(i)) && i > 0 && WORD_CHAR.test(text.charAt(i - 1))) i -= 1;
    if (!WORD_CHAR.test(text.charAt(i))) return '';
    let start = i;
    let end = i;
    while (start > 0 && WORD_CHAR.test(text.charAt(start - 1))) start -= 1;
    while (end < text.length - 1 && WORD_CHAR.test(text.charAt(end + 1))) end += 1;
    // 去掉首尾的连字符/撇号，只保留单词本体；单词被拆分到相邻节点时继续扩展
    const word = extendAcrossSiblings(node, start, end).replace(/^['’-]+|['’-]+$/g, '');
    return /^[A-Za-z][A-Za-z'’-]*$/.test(word) ? word : '';
}

// 悬浮取词的上下文：按叶子视图类型分流，不依赖各版本易变的容器类名。
// 除笔记正文与 PDF 文本层外，Obsidian 内任意内容面板（第三方视图、Canvas、属性区等）
// 的 DOM 文本同样可取词；仅排除本插件自身视图与视图抬头（标签标题/前进后退/⋮）
function hoverContext(el) {
    if (!el || typeof el.closest !== 'function') return null;
    const leaf = el.closest('.workspace-leaf-content');
    if (!leaf) return null;
    const dtype = leaf.getAttribute('data-type');
    if (dtype === VIEW_TYPE || dtype === DICT_VIEW_TYPE || dtype === COVER_VIEW_TYPE) return null;
    if (el.closest('.view-header')) return null; // 抬头里的文件名/按钮不作为取词对象
    // PDF：内置 PDF 视图，或笔记内嵌的 PDF（此时叶子类型仍是 markdown）
    if (dtype === 'pdf' || el.closest('.pdf-embed, .pdf-viewer, .pdf-container')) return { kind: 'pdf' };
    if (el.closest('.markdown-source-view, .markdown-reading-view')) return { kind: 'note' };
    return { kind: 'pane' };
}

// —— 图片取词：取景框（墨迹投影 + 归一化哈希）与 OCR 相关工具 ——

// Map 版 LRU：写入并把最旧的挤出（用于墨迹图 / 取景框词缓存）
function cacheSet(map, key, val, max) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    while (map.size > max) map.delete(map.keys().next().value);
}

// Otsu 自动阈值：按直方图取类间方差最大的分割点，适配不同曝光的截图/书页；
// 同时用于「列空隙长度」直方图，因此按传入直方图的实际长度遍历（不必是 256）
function otsuThreshold(hist, total) {
    const n = hist.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, max = 0, thr = Math.min(128, n - 1);
    for (let t = 0; t < n; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > max) { max = between; thr = t; }
    }
    return thr;
}

// 从光标所在行向上/下按「行墨迹数」扩展，得到该文本行的纵向范围。
// 关键：以光标附近的行墨迹「峰值」设噪声门限——文本行墨迹数远高于细线/抗锯齿噪点行
// （如思维导图的连接线、扫描噪点），低于门限的行视为空行，避免沿细线扩张成整幅高度。
// 并用「密集核心」（≈ x-height 带）估计行高，限制纵向扩张，不并入相邻行或图形元素
function lineBand(rows, rowMax, w, h, iy) {
    if (!rows || iy < 0 || iy >= h) return null;
    // 表格横线/分隔线：单行内存在一段几乎贯穿整幅的连续墨迹。这类行不是文字行，
    // 参与行投影会在光标落在表格线上时把整条线当成"文字"，故一律按空行处理
    const ruleMax = w * 0.45;
    const inkAt = (y) => (rowMax && rowMax[y] >= ruleMax ? 0 : rows[y]);
    const win = Math.max(3, Math.round(h * 0.012));
    let peak = 0;
    for (let y = Math.max(0, iy - win); y <= Math.min(h - 1, iy + win); y++) { const v = inkAt(y); if (v > peak) peak = v; }
    if (peak <= 0) for (let y = 0; y < h; y++) { const v = inkAt(y); if (v > peak) peak = v; } // 光标附近无文字行：退到全局峰值
    if (peak <= 0) return null;
    const floor = Math.max(2, Math.round(peak * 0.15)); // 行墨迹噪声门限
    const gapTol = Math.max(2, Math.round(h * 0.004));
    let seed = -1;
    // 就近搜索距离：光标可能落在表格线/行间空白，允许向上/下找最近的一条文字行
    const reach = Math.max(8, Math.min(120, Math.round(h * 0.25)));
    for (let d = 0; d <= reach && seed < 0; d++) {
        if (iy + d < h && inkAt(iy + d) >= floor) seed = iy + d;
        else if (iy - d >= 0 && inkAt(iy - d) >= floor) seed = iy - d;
    }
    if (seed < 0) return null;
    // 密集核心：围绕种子行、密度 ≥ 峰值一半的连续行，作为字号/行高的可靠估计
    let coreTop = seed, coreBot = seed;
    for (let y = seed - 1; y >= 0 && inkAt(y) >= peak * 0.5; y--) coreTop = y;
    for (let y = seed + 1; y < h && inkAt(y) >= peak * 0.5; y++) coreBot = y;
    const maxSpan = Math.max(6, Math.round((coreBot - coreTop + 1) * 2.5)); // 单行高度上限
    let top = seed, bot = seed, gap = 0;
    for (let y = seed - 1; y >= 0 && seed - y <= maxSpan; y--) {
        if (inkAt(y) >= floor) { top = y; gap = 0; } else if (++gap > gapTol) break;
    }
    gap = 0;
    for (let y = seed + 1; y < h && y - seed <= maxSpan; y++) {
        if (inkAt(y) >= floor) { bot = y; gap = 0; } else if (++gap > gapTol) break;
    }
    return { y0: top, y1: bot + 1 };
}

// 统计某纵向区间内每一列含墨迹的像素数（列向墨迹投影）
function columnInk(ink, w, y0, y1) {
    const cols = new Int32Array(w);
    for (let y = y0; y < y1; y++) {
        const base = y * w;
        for (let x = 0; x < w; x++) if (ink[base + x]) cols[x]++;
    }
    return cols;
}

// 求该行的「词间空格」阈值：词间空格应显著大于字内笔画间隙（离群）。
// 用中位数代表字内间隙、最大值候选词间空格：仅当最大间隙明显离群时才对半分割，
// 否则返回一个「不会截断」的大阈值——避免长单词被字内间隙切碎（旧实现此处恰好写反）
function spaceThreshold(gapVals, charH) {
    const minGap = Math.max(2, Math.round(charH * 0.10)); // 小于此值一律视为字内间隙
    const noSplit = Math.max(1, Math.round(charH * 50));  // 「本行不断词」：阈值大于任何字内间隙
    const big = [];
    for (let i = 0; i < gapVals.length; i++) if (gapVals[i] >= minGap) big.push(gapVals[i]);
    if (big.length < 2) return noSplit;
    big.sort((a, b) => a - b);
    const med = big[big.length >> 1];
    const max = big[big.length - 1];
    // 无显著离群（最大间隙不够大）：视为同一单词内部，不截断
    if (max < med * 2.5 || max < charH * 0.35) return noSplit;
    // 有离群：阈值取「字内中位的 2 倍」，恰好落在字内间隙与词间空格之间
    return Math.max(med * 2, minGap + 1);
}

// 剔除列投影中的「竖直表格线/边框」：某列在本行带上下各约两倍带高的范围内几乎全程有
// 墨迹，说明它是贯穿的竖线（表格边框、分隔线）而非字母笔画，置零以免被并入单词边界
function clearVerticalRules(cols, ink, w, h, y0, y1) {
    const bh = Math.max(1, y1 - y0);
    const lo = Math.max(0, y0 - bh * 2);
    const hi = Math.min(h, y1 + bh * 2);
    const span = hi - lo;
    if (span <= bh) return cols; // 纵向可检区间不足：无从判断
    const need = Math.round(span * 0.85);
    for (let x = 0; x < w; x++) {
        if (cols[x] <= 0) continue;
        let c = 0;
        for (let y = lo; y < hi; y++) if (ink[y * w + x]) c++;
        if (c >= need) cols[x] = 0;
    }
    return cols;
}

// 从光标所在列向左右扩展到单词边界：以「词间空格」为界，而非固定宽度或光标居中。
// capW 为单侧搜索上限（防止阈值失灵时把整行并入）；clipped 表示因触及上限/图像边缘而未能定界
function wordBand(cols, w, ix, charH, capW) {
    if (ix < 0 || ix >= w) return null;
    // 光标可能落在词间空白：就近找一根有墨迹的列作为种子
    let seed = -1;
    const reach = Math.max(4, Math.round(charH));
    for (let d = 0; d <= reach && seed < 0; d++) {
        if (ix + d < w && cols[ix + d] > 0) seed = ix + d;
        else if (ix - d >= 0 && cols[ix - d] > 0) seed = ix - d;
    }
    if (seed < 0) return null;
    // 该行的墨迹列范围与其间的空隙长度分布（用于自适应判定词间空格）
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (cols[x] > 0) { if (first < 0) first = x; last = x; }
    const gapVals = [];
    let run = 0;
    for (let x = first; x <= last; x++) {
        if (cols[x] > 0) { if (run > 0) gapVals.push(run); run = 0; }
        else run++;
    }
    const spaceThr = spaceThreshold(gapVals, charH);
    let left = seed, right = seed, gap = 0, clipped = false;
    for (let x = seed - 1; x >= 0; x--) {
        if (cols[x] > 0) { left = x; gap = 0; }
        else if (++gap >= spaceThr) break; // 遇到词间空格：词左边界到此为止
        if (seed - x >= capW) { clipped = true; break; } // 触及搜索上限：边界未确定
    }
    gap = 0;
    for (let x = seed + 1; x < w; x++) {
        if (cols[x] > 0) { right = x; gap = 0; }
        else if (++gap >= spaceThr) break;
        if (x - seed >= capW) { clipped = true; break; }
    }
    if (left === 0 && cols[0] > 0) clipped = true;      // 边界贴到图像边缘：该侧可能被裁掉
    if (right === w - 1 && cols[w - 1] > 0) clipped = true;
    return { x0: left, x1: right + 1, clipped: clipped };
}

// 在「词的水平区间」内重算纵向范围：行投影只统计该词列区间内的墨迹，
// 从而把升部（W/h/t 顶）与降部（y/g 底）完整纳入——避免整行噪声门限把字母顶/底切掉，
// 使取景框贴合整个单词高度（额外 buffer 由裁剪时再加）
function wordVerticalBand(ink, w, h, x0, x1, y0, y1) {
    const ch = Math.max(4, y1 - y0);
    const lo = Math.max(0, y0 - Math.round(ch * 2)); // 允许上下各扩展约两倍字高
    const hi = Math.min(h, y1 + Math.round(ch * 2));
    const n = hi - lo;
    if (n <= 0 || x1 <= x0) return { y0: y0, y1: y1 };
    const counts = new Int32Array(n);
    let peak = 0, seed = 0;
    for (let y = 0; y < n; y++) {
        const base = (lo + y) * w;
        let c = 0;
        for (let x = x0; x < x1; x++) if (ink[base + x]) c++;
        counts[y] = c;
        if (c > peak) { peak = c; seed = y; }
    }
    if (peak <= 0) return { y0: y0, y1: y1 };
    const floor = Math.max(1, Math.round(peak * 0.05)); // 小额门限：纳入升部/降部，排除零星噪点
    const gapTol = Math.max(1, Math.round(ch * 0.12));
    let top = seed, bot = seed, gap = 0;
    for (let y = seed - 1; y >= 0; y--) {
        if (counts[y] >= floor) { top = y; gap = 0; } else if (++gap > gapTol) break;
    }
    gap = 0;
    for (let y = seed + 1; y < n; y++) {
        if (counts[y] >= floor) { bot = y; gap = 0; } else if (++gap > gapTol) break;
    }
    return { y0: lo + top, y1: lo + bot + 1 };
}

// 取景框的归一化哈希：把墨迹区缩放成 16×8 栅格，按各格墨迹占比二值化成 128 位串。
// 同一单词无论鼠标在词内何处，取景框哈希一致——既用于「确认词边界」，也作为 OCR 结果缓存键
function regionHash(ink, w, x0, y0, x1, y1) {
    const GW = 16, GH = 8;
    const cw = x1 - x0, ch = y1 - y0;
    if (cw <= 0 || ch <= 0) return '0';
    let bits = '';
    for (let gy = 0; gy < GH; gy++) {
        const sy = y0 + Math.floor(ch * gy / GH);
        const ey = Math.max(sy + 1, y0 + Math.floor(ch * (gy + 1) / GH));
        for (let gx = 0; gx < GW; gx++) {
            const sx = x0 + Math.floor(cw * gx / GW);
            const ex = Math.max(sx + 1, x0 + Math.floor(cw * (gx + 1) / GW));
            let on = 0, tot = 0;
            for (let y = sy; y < ey; y++) {
                const base = y * w;
                for (let x = sx; x < ex; x++) { tot++; if (ink[base + x]) on++; }
            }
            bits += (tot && on / tot >= 0.18) ? '1' : '0';
        }
    }
    return bits;
}

// 读取 dataURL / 图片地址为可绘制的 Image：供应用内图片取词复用同一套取景与 OCR
function loadImageEl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image load failed'));
        img.src = src;
    });
}

// 归一化 OCR 结果：只保留英文单词本体（去首尾标点，允许词内连字符/撇号）
function normalizeOcrWord(s) {
    const t = String(s || '').replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z'’-]+$/, '')
        .replace(/^['’-]+|['’-]+$/g, '');
    return /^[A-Za-z][A-Za-z'’-]*$/.test(t) ? t : '';
}

// 从 OCR 词表里挑出光标所在的词（裁剪区已收到单个词，通常只有一条；多条时取包含光标者，
// 否则退回距光标中点最近者）
function pickOcrWord(words, px, py) {
    let best = '', bestD = Infinity;
    (words || []).forEach((it) => {
        const t = normalizeOcrWord(it.text);
        if (!t) return;
        const cx = Number(it.x) || 0, cy = Number(it.y) || 0;
        const cw = Number(it.w) || 0, ch = Number(it.h) || 0;
        if (px >= cx - 4 && px <= cx + cw + 4 && py >= cy - 4 && py <= cy + ch + 4) { best = t; bestD = -1; return; }
        if (bestD === -1) return;
        const dx = px - (cx + cw / 2), dy = py - (cy + ch / 2);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = t; }
    });
    return best;
}


// 解压内嵌应用包（发行版由 tools/web2ob.py 注入 WM_APP_BUNDLE）到 vault 内的 APP_DIR，
// 返回该目录绝对路径；开发态（未注入）返回 null，调用方回退到 vault 根目录。
// 包格式：WMB1 + 条目数(4) + [路径长(2) 路径 内容长(4) 内容] * N，整体 gzip 后 base64
function extractAppBundle(vaultBase) {
    if (typeof WM_APP_BUNDLE !== 'string' || !WM_APP_BUNDLE) return null;
    const target = path.join(vaultBase, APP_DIR);
    const marker = path.join(target, '.wm-version');
    // 记录上一版包解压出的文件清单（相对路径，一行一个）。包结构改动后据此删掉
    // 「旧版有、新版无」的残留：否则旧文件会永久留在 vault 里，旧词典还会被下面的
    // 「保留用户词典」逻辑重新注册回 dict-manifest，等于没瘦身。只记包管文件，不碰用户数据。
    const filesMarker = path.join(target, '.wm-files');
    // 指纹 = 版本号 + 包内容哈希：只要应用包变了就必须重新解压，
    // 否则开发期改了应用文件、版本号没动，vault 里会一直跑旧副本
    const stamp = WM_APP_VERSION + '-' + crypto.createHash('sha1').update(WM_APP_BUNDLE).digest('hex').slice(0, 12);
    try {
        if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === stamp) return target;
    } catch (e) { /* 读取失败则重新解压 */ }

    const raw = zlib.brotliDecompressSync(Buffer.from(WM_APP_BUNDLE, 'base64'));
    if (raw.slice(0, 4).toString('ascii') !== 'WMB1') throw new Error('内嵌应用包格式不正确');

    let off = 4;
    const count = raw.readUInt32BE(off); off += 4;
    const written = new Set();
    for (let i = 0; i < count; i++) {
        const nameLen = raw.readUInt16BE(off); off += 2;
        const name = raw.slice(off, off + nameLen).toString('utf8'); off += nameLen;
        const size = raw.readUInt32BE(off); off += 4;
        const content = raw.slice(off, off + size); off += size;

        // 防目录穿越：解压目标必须仍落在 target 内
        const filePath = path.resolve(target, name);
        if (filePath !== target && !filePath.startsWith(target + path.sep)) continue;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        written.add(name);
    }
    fs.writeFileSync(marker, stamp, 'utf8');

    // 清理上一版包的残留文件：必须在下面「保留用户词典」之前执行，
    // 否则已被新版移除的旧词典会被当成用户词典重新注册进清单
    try {
        const prev = fs.readFileSync(filesMarker, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
        prev.forEach((name) => {
            if (written.has(name)) return;
            const stale = path.resolve(target, name);
            if (!stale.startsWith(target + path.sep)) return; // 防目录穿越
            try { fs.rmSync(stale, { force: true }); } catch (e) { /* 忽略单个文件删除失败 */ }
        });
    } catch (e) { /* 首次解压：无上一版清单 */ }
    fs.writeFileSync(filesMarker, Array.from(written).sort().join('\n') + '\n', 'utf8');

    // 保留用户此前导入的词典：把非内嵌的 data/*-dict.js / *-dict.json 重新并入清单（内嵌文件已被本次写入覆盖）
    try {
        const dataDir = path.join(target, 'data');
        fs.readdirSync(dataDir).forEach((f) => {
            if (!/-dict\.(js|json)$/i.test(f) || f === 'dict-manifest.js' || written.has('data/' + f)) return;
            // .json 词典的变量名由文件名推导，无需读入整份内容（oaldpe 达 320MB，全量读入会明显拖慢启动）
            const content = /-dict\.(js)$/i.test(f) ? fs.readFileSync(path.join(dataDir, f), 'utf8') : '';
            upsertDictManifest(dataDir, f, content);
        });
    } catch (e) { /* 忽略：无 data 目录或读取失败 */ }

    return target;
}

// 内置静态服务：把 vault 根目录以 http://127.0.0.1:<随机端口> 暴露，
// 供 iframe 使用真实 origin 加载（app:// 下外部样式表/脚本会被 Obsidian CSP 拦截）。
class StaticServer {
    constructor(root) {
        this.root = path.resolve(root);
        this.server = null;
        this.port = 0;
    }

    start(preferredPort) {
        const base = preferredPort || DEFAULT_PORT;
        const candidates = [];
        for (let i = 0; i < PORT_TRIES; i++) candidates.push(base + i);
        return candidates.reduce(
            (chain, port) => chain.catch(() => this.listen(port)),
            Promise.reject()
        ).then(() => this.port);
    }

    // 仅监听回环地址，不对外暴露
    listen(port) {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handle(req, res));
            const onError = (err) => { try { server.close(); } catch (e) { /* 忽略 */ } reject(err); };
            server.once('error', onError);
            server.listen(port, '127.0.0.1', () => {
                server.removeListener('error', onError);
                this.server = server;
                this.port = port;
                resolve(port);
            });
        });
    }

    stop() {
        if (this.server) {
            try { this.server.close(); } catch (e) { /* 忽略关闭异常 */ }
            this.server = null;
        }
    }

    // 内部桥接：列用户 / 读配置 / 写配置 / 删配置，仅操作 user/ 目录下的 user_*.json
    handleBridge(req, res, pathname) {
        const send = (code, body) => {
            res.writeHead(code, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(body);
        };
        const action = pathname.slice(BRIDGE_PREFIX.length);
        const userDir = path.join(this.root, USER_DIR);

        if (action === 'ping') { send(200, JSON.stringify({ ok: true })); return; }

        if (action === 'users') {
            fs.readdir(userDir, (err, files) => {
                if (err) { send(200, JSON.stringify([])); return; }
                const names = files
                    .filter((f) => /^user_.+\.json$/i.test(f))
                    .map((f) => f.slice('user_'.length, -'.json'.length))
                    .filter((n) => n && n !== 'template');
                send(200, JSON.stringify(names));
            });
            return;
        }

        if (action === 'user') {
            // 用户名经清洗后拼接，并校验最终路径仍在 user/ 目录内，防止目录穿越
            const query = (req.url || '').split('?')[1] || '';
            const name = sanitizeUser(new URLSearchParams(query).get('name'));
            const filePath = path.join(userDir, 'user_' + name + '.json');
            if (path.dirname(filePath) !== userDir) { send(400, JSON.stringify({ error: 'invalid name' })); return; }

            if (req.method === 'GET') {
                fs.readFile(filePath, 'utf8', (err, text) => {
                    if (err) { send(404, JSON.stringify({ error: 'not found' })); return; }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                    res.end(text);
                });
                return;
            }

            if (req.method === 'POST') {
                let body = '';
                req.on('data', (c) => { body += c; if (body.length > 64 * 1024 * 1024) req.destroy(); });
                req.on('end', () => {
                    try { JSON.parse(body); } catch (e) { send(400, JSON.stringify({ error: 'invalid json' })); return; }
                    fs.mkdir(userDir, { recursive: true }, () => {
                        fs.writeFile(filePath, body, 'utf8', (err) => {
                            if (err) { send(500, JSON.stringify({ error: 'write failed' })); return; }
                            send(200, JSON.stringify({ ok: true }));
                        });
                    });
                });
                return;
            }

            if (req.method === 'DELETE') {
                fs.unlink(filePath, () => send(200, JSON.stringify({ ok: true })));
                return;
            }
        }

        send(404, JSON.stringify({ error: 'unknown action' }));
    }

    // 词典导入落盘：写入 data/<name>-dict.json 并重建 data/dict-manifest.js
    // （与 tools/serve.js 的 POST /save-dict 行为一致）
    handleSaveDict(req, res) {
        const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(obj));
        };
        if (req.method !== 'POST') { send(405, { ok: false, error: 'method not allowed' }); return; }
        // raw=1&file=<fname>：已解析词典（.json / .js）原始字节直传（与 tools/serve.js 对齐）。
        // 不做 JSON.parse、不构造文本，直接落盘并登记清单——超大词典（oaldpe 约 320MB）
        // 若走 {content} 通道，浏览器要 stringify、宿主还要再 parse，内存会被撑爆。
        const params = new URLSearchParams(String(req.url || '').split('?')[1] || '');
        if (params.get('raw') === '1') {
            // URLSearchParams 已完成一次解码，此处直接取用（再 decode 会把文件名里的 % 误解析）
            const fname = params.get('file') || '';
            const safeRaw = /^[^\\/:*?"<>|]+-dict\.(js|json)$/i.test(fname) && fname.charAt(0) !== '.' ? fname : '';
            if (!safeRaw) { send(400, { ok: false, error: '文件名不合法' }); req.destroy(); return; }
            const dataDir = path.join(this.root, 'data');
            const chunks = [];
            let size = 0;
            req.on('data', (c) => {
                size += c.length;
                if (size > 512 * 1024 * 1024) { req.destroy(); return; }
                chunks.push(c);
            });
            req.on('end', () => {
                try {
                    fs.mkdirSync(dataDir, { recursive: true });
                    const fp = path.join(dataDir, safeRaw);
                    fs.writeFileSync(fp, Buffer.concat(chunks));
                    let varName = /-dict\.json$/i.test(safeRaw) ? dictVarNameFromFile(safeRaw) : '';
                    if (!varName) {
                        const mv = /var\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*=\s*\{/u.exec(fs.readFileSync(fp, 'utf8').slice(0, 4096));
                        varName = mv ? mv[1] : '';
                    }
                    const r = varName ? upsertDictManifest(dataDir, safeRaw, '', varName) : { count: 0, mdd: '' };
                    send(200, { ok: true, file: safeRaw, count: r.count, varName: varName, mdd: r.mdd });
                } catch (e) {
                    send(500, { ok: false, error: e.message });
                }
            });
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 512 * 1024 * 1024) req.destroy(); });
        req.on('end', () => {
            try {
                const { varName, content, file } = JSON.parse(body);
                if (!varName || typeof content !== 'string') throw new Error('参数缺失');
                const dataDir = path.join(this.root, 'data');
                // 目标文件名：调用方指定优先（须为不含路径分隔符的 -dict.js / -dict.json），否则按变量名推导
                const safe = typeof file === 'string'
                    && /^[^\\/:*?"<>|]+-dict\.(js|json)$/i.test(file) && file.charAt(0) !== '.' ? file : '';
                const fname = safe || dictFileName(varName, /-dict\.json$/i.test(String(file || '')) ? 'json' : 'js');
                fs.mkdirSync(dataDir, { recursive: true });
                fs.writeFileSync(path.join(dataDir, fname), content, 'utf8');
                const r = upsertDictManifest(dataDir, fname, content, varName);
                send(200, { ok: true, file: fname, count: r.count, mdd: r.mdd });
            } catch (e) {
                send(400, { ok: false, error: e.message });
            }
        });
    }

    // 卸载词典：删除 vault 内 data/<name>-dict.json 并更新 data/dict-manifest.js
    // （与 tools/serve.js 的 POST /delete-dict 行为一致）
    handleDeleteDict(req, res) {
        const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(obj));
        };
        if (req.method !== 'POST') { send(405, { ok: false, error: 'method not allowed' }); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
        req.on('end', () => {
            try {
                const { file } = JSON.parse(body);
                // 只接受 data/ 直属的词典文件名，杜绝路径穿越
                const safe = typeof file === 'string'
                    && /^[^\\/:*?"<>|]+-dict\.(js|json)$/i.test(file) && file.charAt(0) !== '.' ? file : '';
                if (!safe) throw new Error('文件名不合法');
                const dataDir = path.join(this.root, 'data');
                const fp = path.join(dataDir, safe);
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
                const count = removeDictManifestEntry(dataDir, safe);
                send(200, { ok: true, file: safe, count: count });
            } catch (e) {
                send(400, { ok: false, error: e.message });
            }
        });
    }

    // 微信读书划线转发：POST /weread
    // 官方网关 https://i.weread.qq.com/api/agent/gateway 的 CORS 仅放行 weread.qq.com，页面受同源策略
    // 限制无法直连，故由内置服务在 Node 侧代填 Authorization 后转发（与 tools/serve.js 的 POST /weread 同行为）。
    // 有了这条通道，Obsidian 端无需用户另行运行 node tools/serve.js；Key 只在内存中过手，不落盘。
    handleWeread(req, res) {
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Weread-Key'
        };
        const send = (code, obj) => {
            res.writeHead(code, Object.assign({
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            }, cors));
            res.end(JSON.stringify(obj));
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
        if (req.method !== 'POST') { send(405, { errcode: -1, errmsg: 'method not allowed' }); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
        req.on('end', () => {
            const key = String(req.headers['x-weread-key'] || '').trim();
            if (key.indexOf('wrk-') !== 0) { send(400, { errcode: -1, errmsg: '缺少微信读书 API Key（X-Weread-Key，格式 wrk-xxxxxxxx）' }); return; }
            const up = https.request('https://i.weread.qq.com/api/agent/gateway', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + key,
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (upstream) => {
                res.writeHead(upstream.statusCode || 502, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
                upstream.pipe(res);
            });
            up.on('error', (e) => {
                // 超时销毁时响应头可能已发出（已在 pipe），此时不能再写头，直接收尾
                if (res.headersSent) { res.end(); return; }
                send(502, { errcode: -1, errmsg: '转发微信读书失败: ' + e.message });
            });
            up.setTimeout(20000, () => { up.destroy(new Error('上游响应超时')); });
            up.end(body);
        });
    }

    handle(req, res) {
        let pathname;
        try {
            pathname = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
        } catch (e) {
            res.writeHead(400);
            res.end('Bad Request');
            return;
        }

        // 内部桥接接口：Obsidian 不开放 File System Access API，页面改用这些接口读写 user/ 目录
        if (pathname.indexOf(BRIDGE_PREFIX) === 0) {
            this.handleBridge(req, res, pathname);
            return;
        }

        // 词典导入落盘：与 tools/serve.js 的 POST /save-dict 同路径同行为，
        // 使页面（Obsidian 右侧栏拖入区）导入 MDX 后可直接写入 vault 的 data/ 目录
        if (pathname === '/save-dict') {
            this.handleSaveDict(req, res);
            return;
        }

        // 词典卸载：删除 vault 内词典文件并更新清单
        if (pathname === '/delete-dict') {
            this.handleDeleteDict(req, res);
            return;
        }

        // 微信读书划线转发：页面无法直连官方网关（CORS 仅放行 weread.qq.com），由内置服务代转发
        if (pathname === '/weread') {
            this.handleWeread(req, res);
            return;
        }

        if (pathname === '/') pathname = '/' + ENTRY_FILE;

        const filePath = path.resolve(this.root, '.' + pathname);
        // 防目录穿越：解析后必须仍在 vault 根目录内
        if (filePath !== this.root && !filePath.startsWith(this.root + path.sep)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }
            const headers = {
                'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
                'Accept-Ranges': 'bytes'
            };

            // 支持 Range 请求（音频/视频拖动播放）
            const range = req.headers.range;
            const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
            if (m) {
                let start = m[1] ? parseInt(m[1], 10) : 0;
                let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
                if (isNaN(start)) start = 0;
                if (isNaN(end) || end >= stat.size) end = stat.size - 1;
                if (start > end) {
                    res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
                    res.end();
                    return;
                }
                headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
                headers['Content-Length'] = end - start + 1;
                res.writeHead(206, headers);
                if (req.method === 'HEAD') { res.end(); return; }
                fs.createReadStream(filePath, { start, end }).pipe(res);
                return;
            }

            headers['Content-Length'] = stat.size;
            res.writeHead(200, headers);
            if (req.method === 'HEAD') { res.end(); return; }
            fs.createReadStream(filePath).pipe(res);
        });
    }
}

// 视图基类：把 vault 根目录的入口页以 iframe 形式加载，并同步宿主主题。
// 子类必须覆写 getViewType / getDisplayText / getIcon —— 因为 ItemView 构造函数会在
// super(leaf) 期间就调用 getViewType()，那时本类的 this.opts 尚未赋值，读它会抛错。
class FrameView extends ItemView {
    constructor(leaf, plugin, opts) {
        super(leaf);
        this.plugin = plugin;
        this.opts = opts || {};
        this.frame = null;
        this.loaded = false; // iframe 文档是否已加载完成（未完成时 postMessage 会丢，需排队）
        this.pending = []; // iframe 未就绪时排队的消息，load 后补发
    }

    getIcon() {
        return 'book';
    }

    async onOpen() {
        // 服务尚未监听时先占位，待 onload 完成后由 reloadFrame 补载
        this.frame = this.contentEl.createEl('iframe', { cls: this.opts.frameClasses });
        this.frame.setAttribute('allow', 'clipboard-read; clipboard-write; microphone');
        this.mountFrame();

        // 主题实时同步：iframe 加载完成后推送一次，并在 Obsidian 主题变化时持续推送
        this.frame.addEventListener('load', () => {
            this.loaded = true;
            this.pushTheme();
            // 宿主功能开关随主题一并注入（页面据此决定查词跳转等行为）
            if (typeof this.plugin.pushSettingsToFrame === 'function') this.plugin.pushSettingsToFrame(this);
            this.flushPending();
        });
        this.observer = new MutationObserver(() => this.pushTheme());
        const obsOpts = { attributes: true, attributeFilter: ['class'] };
        this.observer.observe(document.body, obsOpts);
        this.observer.observe(document.documentElement, obsOpts);
    }

    // 解析入口页地址（内置 http 服务优先，不可用时回退 app:// 资源路径）；都不可用返回 null
    resolveSrc() {
        const plugin = this.plugin;
        let src;
        if (plugin && plugin.baseUrl) {
            // 内置服务已就绪：从服务根加载（发行版为内嵌包解压目录 .word-memo/）
            src = plugin.baseUrl + '/' + encodeURIComponent(ENTRY_FILE);
        } else {
            // 开发态回退：直接读 vault 内的入口页
            const file = this.app.vault.getAbstractFileByPath(ENTRY_FILE);
            if (!file) return null;
            src = this.app.vault.adapter.getResourcePath(file.path);
        }

        // 附加查询参数：视图模式 + 宿主主题（主题随参数带入，避免首屏闪烁）+ 宿主标识
        // （页面据此判断运行在 Obsidian 内，进而选用插件仓库的说明文档等宿主相关内容）
        const params = [];
        if (this.opts.query) params.push(this.opts.query);
        params.push('wmTheme=' + hostTheme());
        params.push('wmHost=obsidian');
        return src + (src.indexOf('?') === -1 ? '?' : '&') + params.join('&');
    }

    // 挂载/重载 iframe 内容（服务就绪后调用可修正首次打开时的空白）
    mountFrame() {
        const src = this.resolveSrc();
        if (!src) {
            this.contentEl.empty();
            this.contentEl.createEl('div', {
                text: `未找到入口文件：${ENTRY_FILE}（请确认它位于 vault 根目录）`
            });
            new Notice('词忆：未找到入口文件 ' + ENTRY_FILE);
            return;
        }
        if (this.frame.src === src) return;
        this.loaded = false; // 重新加载：等待新的 load 事件
        this.frame.src = src;
    }

    // onload 中服务启动完成后回调，刷新已打开视图
    reloadFrame() {
        if (this.frame) this.mountFrame();
    }

    // 向 iframe 推送宿主主题（页面按自身「跟随系统主题」开关决定是否采纳）
    pushTheme() {
        if (!this.loaded) return; // 未加载完成时排队无意义，load 回调会补推一次
        this.postToFrame({ type: 'wm-theme', theme: hostTheme() });
    }

    // 向 iframe 推送消息；iframe 尚未加载完成时先排队，load 后补发（否则消息会丢失）
    postToFrame(msg) {
        if (!this.frame || !this.loaded) {
            this.pending.push(msg);
            return;
        }
        try {
            this.frame.contentWindow.postMessage(msg, new URL(this.frame.src, location.href).origin);
        } catch (e) {
            this.pending.push(msg);
        }
    }

    flushPending() {
        if (!this.pending.length) return;
        const msgs = this.pending;
        this.pending = [];
        msgs.forEach((m) => this.postToFrame(m));
    }

    async onClose() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.frame) {
            this.frame.remove();
            this.frame = null;
        }
    }
}

// 整页应用视图（标签页）
class WordMemoView extends FrameView {
    constructor(leaf, plugin) {
        // wmHost=1：告知页面当前运行在 Obsidian 宿主且右侧栏查词可用，
        // 页面内的「查看词典详情」跳转统一转交右侧栏承接（主页不弹结果窗口）
        super(leaf, plugin, { query: 'wmHost=1', frameClasses: ['word-memo-frame'] });
    }

    // 以下三者由 ItemView 构造函数在 super(leaf) 期间调用，必须返回常量
    getViewType() { return VIEW_TYPE; }

    getDisplayText() { return '词忆 Word Memo'; }

    getIcon() { return WORD_MEMO_ICON_ID; } // 词忆标志，与主页左上角 logo 同一图案，随 Obsidian 图标灰色着色
}

// 右侧栏查词引擎视图（复用 dict-lookup 查单词框架）
class DictLookupView extends FrameView {
    constructor(leaf, plugin) {
        super(leaf, plugin, {
            query: 'wmView=dict',
            frameClasses: ['word-memo-frame', 'word-memo-frame-dict']
        });
    }

    getViewType() { return DICT_VIEW_TYPE; }

    getDisplayText() { return '查单词'; }

    getIcon() { return SEARCH_ICON_ID; }
}

// 封面视窗（可视化封面独立窗口）：默认蒲公英聚类，右下角顺序切换封面
class CoverView extends FrameView {
    constructor(leaf, plugin) {
        super(leaf, plugin, {
            query: 'wmView=cover',
            frameClasses: ['word-memo-frame', 'word-memo-frame-cover']
        });
    }

    getViewType() { return COVER_VIEW_TYPE; }

    getDisplayText() { return '词忆封面'; }

    getIcon() { return 'image'; }
}

// 插件设置页：单页分区布局（排版参考 Hearth 的 section 结构——标题/描述在盒子外，
// 原生 .setting-item 行装在圆角描边盒子内）。当前仅「关于」分区作为打样
class WordMemoSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('word-memo-settings');
        this.renderBack(containerEl);
        // 不设顶层标题（尤其不使用插件名）；分区头在各分区内呈现
        this.section(containerEl, '取词', '文本层直接取词；图片则用系统 OCR 识别光标下的单词。', (body) => this.lookupSection(body));
        this.section(containerEl, '背单词模式', '练习时右侧栏单词详情的显示时机，辅助巩固错词或复核记忆。', (body) => this.practiceSection(body));
        this.section(containerEl, null, null, (body) => this.aboutSection(body));
    }

    // 返回按钮：单页设置没有上一级，故退出到 Obsidian「第三方插件」列表
    renderBack(el) {
        const back = el.createDiv({ cls: 'word-memo-settings-back' });
        setIcon(back.createSpan({ cls: 'word-memo-settings-back-icon' }), 'chevron-left');
        back.createSpan({ text: '返回插件列表' });
        back.addEventListener('click', () => {
            try {
                this.app.setting.openTabById('community-plugins');
            } catch (e) { /* 兼容旧版 Obsidian：无该入口时忽略 */ }
        });
    }

    // 分区：标题与描述在盒子外，行内容装在圆角描边盒子内；title 为空则不渲染分区头
    section(el, title, desc, render) {
        const section = el.createDiv({ cls: 'word-memo-section' });
        if (title) {
            const head = section.createDiv({ cls: 'word-memo-section-head' });
            head.createDiv({ cls: 'word-memo-section-title', text: title });
            if (desc) head.createDiv({ cls: 'word-memo-section-desc', text: desc });
        }
        const body = section.createDiv({ cls: 'word-memo-section-body' });
        render(body);
    }

    // 取词分区：宿主功能开关（悬浮取词 / 划词查询 / 右侧窗口查词）+ 取景框调试
    lookupSection(body) {
        new Setting(body)
            .setName('悬浮取词')
            .setDesc('鼠标在笔记文字上停留 0.5 秒即推送到右侧栏查词；停在图片/扫描页上时用 Windows 系统 OCR 识别光标下的单词（仅 Windows 桌面端，首次识别稍慢，之后走缓存）。关闭后不再取词。')
            .addToggle((tg) => tg.setValue(this.plugin.obSettings.hoverLookup !== false).onChange(async (v) => {
                this.plugin.obSettings.hoverLookup = v;
                if (!v) this.plugin.cancelHover();
                await this.plugin.persistLocalSettings();
            }));
        new Setting(body)
            .setName('取景框')
            .setDesc('开启后，图片取词命中时在原图上高亮 OCR 取景框，并在右下角浮出送识别的裁剪图（3 秒后自动消失，不遮挡操作）。用于诊断识别不准的问题，默认关闭。')
            .addToggle((tg) => tg.setValue(this.plugin.ocrDebug).onChange(async (v) => {
                this.plugin.ocrDebug = v;
                if (!v) this.plugin.hideOcrDebug();
                await this.plugin.persistLocalSettings();
            }));
        new Setting(body)
            .setName('划词查询')
            .setDesc('选中文本右键「查询」：单词显示词典释义，句子或中文由 AI 翻译并解读。')
            .addToggle((tg) => tg.setValue(this.plugin.obSettings.selectionTranslate !== false).onChange(async (v) => {
                this.plugin.obSettings.selectionTranslate = v;
                if (!v) this.plugin.hidePdfBtn();
                await this.plugin.persistLocalSettings();
            }));
        new Setting(body)
            .setName('右侧窗口查词')
            .setDesc('开启后「查看词典详情」改由 Obsidian 右侧栏展示，主页不弹浮层。')
            .addToggle((tg) => tg.setValue(this.plugin.obSettings.dictLookupInSidebar !== false).onChange(async (v) => {
                this.plugin.obSettings.dictLookupInSidebar = v;
                await this.plugin.persistLocalSettings();
                this.plugin.pushSettingsToAllFrames();
            }));
    }

    // 背单词模式分区：练习作答时右侧栏查词的显示时机
    practiceSection(body) {
        // 逐项换行说明（setDesc 传 \n 不会换行，这里用 DocumentFragment 结构化呈现）
        const desc = document.createDocumentFragment();
        [
            ['均不显示', '无论答对答错都不显示单词查词详情，适合速刷。'],
            ['答错显示', '点击「不知道 / 不记得」时才显示右侧单词详情，便于巩固错词。'],
            ['答对答错均显示', '点击任何选项均显示右侧单词详情，便于复核记忆。']
        ].forEach(([term, text]) => {
            const line = desc.createEl('div', { cls: 'wm-answer-lookup-line' });
            line.createEl('strong', { text: term + '：' });
            line.appendText(text);
        });
        new Setting(body)
            .setName('右侧查词')
            .setDesc(desc)
            .addDropdown((dd) => dd
                .addOption('none', '均不显示')
                .addOption('wrong', '答错显示')
                .addOption('all', '答对答错均显示')
                .setValue(this.plugin.obSettings.answerLookup || 'wrong')
                .onChange(async (v) => {
                    this.plugin.obSettings.answerLookup = v;
                    await this.plugin.persistLocalSettings();
                    this.plugin.pushSettingsToAllFrames();
                }));
    }

    aboutSection(body) {
        const manifest = this.plugin.manifest;
        new Setting(body)
            .setName(manifest.name)
            .setDesc('专攻难词、趣味高效的单词记忆工具。');
        new Setting(body)
            .setName('项目仓库')
            .setDesc('源码、更新日志与使用说明。')
            .addButton((btn) => this.linkButton(btn, 'github', '打开 GitHub', REPO_URL));
        new Setting(body)
            .setName('反馈问题')
            .setDesc('遇到问题或有功能建议，欢迎提交 Issue。')
            .addButton((btn) => this.linkButton(btn, 'bug', '提交 Issue', REPO_URL + '/issues'));
        new Setting(body)
            .setName('版本 ' + manifest.version)
            .setDesc('作者：' + (manifest.author || '词忆团队'));
    }

    // 带图标的链接按钮（图标 + 文案），样式对齐 Hearth 的 about 按钮
    linkButton(btn, icon, label, url) {
        btn.setTooltip(url).onClick(() => window.open(url, '_blank'));
        const el = btn.buttonEl;
        el.empty();
        el.addClass('word-memo-about-btn');
        setIcon(el.createSpan({ cls: 'word-memo-about-btn-icon' }), icon);
        el.createSpan({ text: label });
    }
}

module.exports = class WordMemoPlugin extends Plugin {
    onload() {
        this.server = null;
        this.baseUrl = null;

        // 宿主侧功能开关：悬浮取词（文本 + 图片 OCR）/ 划词查询 / 右侧窗口查词。
        // 均在插件设置页维护，持久化到插件数据；右侧窗口查词另注入 iframe 供页面使用
        this.obSettings = { hoverLookup: true, selectionTranslate: true, dictLookupInSidebar: true, answerLookup: 'wrong' };
        this.hoverWord = ''; // 当前悬浮所在单词（同一单词不重复查询、不重置计时）
        this.hoverTimer = null;
        this.hoverTick = 0; // 取词节流时间戳
        this.hoverX = -1e9; // 上次取词时的鼠标位置：图片取词需移动超过阈值才再次取景
        this.hoverY = -1e9;
        // 图片取词（OCR）：状态机 + 惰性缓存。Windows 系统 OCR，首次成功后置 'on'，
        // 连续失败两次置 'off'（非 Windows 或系统无 OCR 语言包时静默降级为仅文本取词）。
        // 是否启用跟随「悬浮取词」总开关
        this.ocrDebug = false;     // 调试：显示 OCR 实际取景框与被识别裁剪图（默认关闭）
        this.ocrState = 'unknown'; // unknown | on | off
        this.ocrBusy = false;      // 同一时刻只跑一次 OCR，避免并发 spawn powershell
        this.ocrFail = 0;
        this.hoverId = 0;          // 悬浮代次：异步取词/OCR 回来时用它判断是否已被更新的移动取代
        this.ocrElId = 0;          // 图源元素自增 id：用于取景框词缓存键
        this.imgInk = new Map();   // 图源元素 → { w, h, ink, rows }（LRU，二值墨迹图）
        this.imgWords = new Map(); // 取景框哈希 → 词（LRU，避免同一单词重复 OCR）
        this.ocrDebugBox = null;   // 调试取景框：跟随光标显示的取景预览面板
        this.ocrDebugRect = null;  // 调试取景框：叠加在图源上的高亮矩形
        this.ocrDebugTimer = null;
        this.pdfBtn = null; // PDF 划词浮出的「译」按钮
        this.pdfBtnText = '';
        this.loadData().then((saved) => {
            if (saved && saved.obSettings) Object.assign(this.obSettings, saved.obSettings);
            if (saved && saved.ocrDebug === true) this.ocrDebug = true;
        }).catch(() => { /* 忽略 */ });

        // 视图 / 命令必须同步注册：Obsidian 恢复上次布局时会按 workspace.json 重建标签页，
        // 若视图类型尚未注册，标签页会停留在「插件不再活动」。
        this.registerView(VIEW_TYPE, (leaf) => new WordMemoView(leaf, this));
        this.registerView(DICT_VIEW_TYPE, (leaf) => new DictLookupView(leaf, this));
        this.registerView(COVER_VIEW_TYPE, (leaf) => new CoverView(leaf, this));

        // 注册「查单词（词忆）」统一图标（static/image/search.svg），供 ribbon 与视图标签复用
        addIcon(SEARCH_ICON_ID, SEARCH_ICON_CONTENT);
        // 注册词忆标志图标（static/image/word-memo-logo-medium.svg），替换原 'layers' 层叠图标
        addIcon(WORD_MEMO_ICON_ID, WORD_MEMO_ICON_CONTENT);

        // 左侧 ribbon：查单词（右侧栏）+ 整页应用（封面视窗不占用 ribbon，仅保留命令/API 入口）
        this.addRibbonIcon(SEARCH_ICON_ID, '查单词（词忆）', () => this.activateDictView());
        // 词忆标志字形在 100×100 视图框内纵向仅占约 66%，观感偏小，加类名由 styles.css 放大
        this.addRibbonIcon(WORD_MEMO_ICON_ID, '打开词忆 Word Memo', () => this.activateView())
            .addClass('word-memo-ribbon-logo');

        this.addCommand({
            id: 'open-dict-lookup',
            name: '打开右侧栏查单词',
            callback: () => this.activateDictView()
        });

        this.addCommand({
            // 命令 id 不含插件 id：Obsidian 会自动前缀成 word-memo:open-app
            id: 'open-app',
            name: '打开词忆 Word Memo',
            callback: () => this.activateView()
        });

        this.addCommand({
            id: 'open-app-cover',
            name: '打开词忆封面视窗',
            callback: () => this.activateCoverView()
        });

        // 设置页（单页分区布局）
        this.addSettingTab(new WordMemoSettingTab(this.app, this));

        // 划词右键菜单：选中文本后右键出现「查询」（带词忆 logo），
        // 点击即激活右侧栏并显示结果（单词走首选词典释义，句子走 AI 翻译）
        this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
            if (!this.obSettings.selectionTranslate) return; // 「页面设置 → 划词翻译」关闭时不出现该项
            const sel = (editor.getSelection() || '').trim();
            // 未选中内容不出现该项；过长（如误选整段文档）也跳过，避免无意义的长文本翻译
            if (!sel || sel.length > 2000) return;
            menu.addItem((item) => {
                item.setTitle('查询')
                    .setIcon(SEARCH_ICON_ID) // 与「查单词（词忆）」统一图标
                    .onClick(() => this.translateSelection(sel));
            });
        }));

        // 悬浮取词：鼠标在笔记文本上停留 0.5s 后，把该单词推给右侧栏查词面板。
        // 节流降低取词开销；拖拽/滚动/点击时立即取消，避免误触发
        this.registerDomEvent(document, 'mousemove', (e) => this.onHoverMove(e));
        // 点击/滚动后重置取词锚点：下一次悬浮即视为新位置，可立即取词
        this.registerDomEvent(document, 'mousedown', () => { this.hoverX = -1e9; this.hoverY = -1e9; this.cancelHover(); });
        this.registerDomEvent(window, 'scroll', () => { this.hoverX = -1e9; this.hoverY = -1e9; this.cancelHover(); }, true);

        // PDF 划词翻译：内置 PDF 查看器不触发 editor-menu，故自绘「浮出按钮 + 原生右键菜单项」两个入口
        this.initPdfSelection();

        // 内置服务改为后台启动，且**不 await**：onload 必须尽快返回，否则 Obsidian 会认为插件
        // 尚未激活（端口探测若卡住，await 会让插件一直处于未激活态，标签页报「插件不再活动」）。
        this.startServer();

        // 主页 iframe 发来的消息：查词跳转请求
        this.registerDomEvent(window, 'message', (e) => {
            const d = e.data;
            if (!d || typeof d.type !== 'string') return;
            // 仅接受来自本插件主页 iframe 的消息，避免与其他窗口消息串扰
            const fromHost = this.app.workspace.getLeavesOfType(VIEW_TYPE).some((leaf) => {
                const v = leaf.view;
                return v && v.frame && v.frame.contentWindow === e.source;
            });
            if (!fromHost) return;
            if (d.type === 'wm-dict-lookup' && d.word) {
                // 「查看词典详情」：转交右侧栏查词视图承接，主页不弹结果窗口。
                // keepFocus=true（记得么「如何记忆」辅助展示）时不抢焦点，避免把焦点从主页
                // iframe 抢到侧栏后，网页内快捷键（如再次触发的热键）收不到按键
                this.lookupInDictView(String(d.word), !!d.keepFocus);
            } else if (d.type === 'wm-ocr-hover' && d.dataUrl) {
                // 应用内（iframe）图片取词：宿主文档的 mousemove 到不了 iframe 内部，
                // 故由页面自行取景并把整图与光标坐标发来，这里复用同一套取景 + 系统 OCR
                this.ocrFromApp(String(d.dataUrl), Number(d.ix) || 0, Number(d.iy) || 0);
            } else if (d.type === 'wm-dict-note' && d.word) {
                // 「我的笔记」外部写入：仅推给「已经打开」的右侧栏查词视图，令其刷新当前词条
                // 笔记区与日期。刻意不做 activateDictView——仅仅更新一条笔记不该把侧栏唤起/抢焦点
                this.app.workspace.getLeavesOfType(DICT_VIEW_TYPE).forEach((leaf) => {
                    const view = leaf.view;
                    if (view && typeof view.postToFrame === 'function') {
                        view.postToFrame({ type: 'wm-dict-note', word: d.word, note: d.note, ts: d.ts });
                    }
                });
            }
        });
    }

    // 向单个 iframe 注入宿主功能开关（页面据此决定「查看词典详情」是否交右侧栏承接）
    pushSettingsToFrame(view) {
        view.postToFrame({
            type: 'wm-ob-settings',
            hoverLookup: this.obSettings.hoverLookup !== false,
            selectionTranslate: this.obSettings.selectionTranslate !== false,
            dictLookupInSidebar: this.obSettings.dictLookupInSidebar !== false,
            answerLookup: this.obSettings.answerLookup || 'wrong'
        });
    }

    // 向所有已打开的 iframe 视图广播宿主功能开关（设置变更即时生效，无需重载页面）
    pushSettingsToAllFrames() {
        [VIEW_TYPE, DICT_VIEW_TYPE].forEach((t) => {
            this.app.workspace.getLeavesOfType(t).forEach((leaf) => {
                const view = leaf.view;
                if (view && typeof view.postToFrame === 'function') this.pushSettingsToFrame(view);
            });
        });
    }

    // 悬浮取词：文本层直接取词；无文本层时尝试图片取词（OCR）。
    // 已获结果后不主动清空右侧显示；图片取词需鼠标移动超过 HOVER_MOVE_THRESHOLD 才再次取景
    onHoverMove(e) {
        if (!this.obSettings.hoverLookup) return;
        if (e.buttons) return; // 正在拖拽/选择文本
        const now = Date.now();
        if (now - this.hoverTick < HOVER_TICK) return; // 节流：降低取词开销
        this.hoverTick = now;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && String(sel).trim()) { this.cancelHover(); return; } // 已有选区时不打扰
        if (!hoverContext(e.target)) { this.cancelHover(); return; } // 本插件视图/菜单等不取词
        const word = wordAtPoint(e.clientX, e.clientY);
        if (word) { // 文本层命中：直接进入 0.5s 计时（同一单词不重复触发、不重置）
            this.hoverX = e.clientX;
            this.hoverY = e.clientY;
            this.onHoverWord(word);
            return;
        }
        // 文本层没取到词：可能是图片（含无文本层的扫描页/截图）。
        // 仅当鼠标移动超过阈值时才再次取景，避免停在原地抖动时反复取景 / 反复 OCR；
        // 停顿在空白处不触发，右侧继续保持当前词汇
        const dx = e.clientX - this.hoverX, dy = e.clientY - this.hoverY;
        if (dx * dx + dy * dy < HOVER_MOVE_THRESHOLD * HOVER_MOVE_THRESHOLD) return;
        this.hoverX = e.clientX;
        this.hoverY = e.clientY;
        this.onHoverImage(e.clientX, e.clientY);
    }

    // 文本取词：同一单词不重置计时，也不重复查询
    onHoverWord(word) {
        this.hoverId += 1; // 作废尚未返回的图片取词异步任务
        if (word === this.hoverWord) return;
        this.hoverWord = word;
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => {
            this.hoverTimer = null;
            if (this.obSettings.hoverLookup && this.hoverWord) this.pushToDictView(this.hoverWord);
        }, HOVER_DELAY);
    }

    // 取消当前悬浮取词计时
    cancelHover() {
        this.hoverId += 1;
        this.hoverWord = '';
        if (this.hoverTimer) {
            clearTimeout(this.hoverTimer);
            this.hoverTimer = null;
        }
    }

    // —— 图片取词（OCR，Windows 系统能力；失败则静默降级为仅文本取词）——

    // OCR 是否可用：悬浮取词关闭 / 非 Windows / 此前连续失败时直接跳过
    ocrAvailable() {
        if (!this.obSettings.hoverLookup || this.ocrState === 'off') return false;
        if (process.platform !== 'win32') { this.ocrState = 'off'; return false; }
        return true;
    }

    // 光标下的可 OCR 图源：<img>（笔记图片，实时预览/阅读视图通用）或 <canvas>（PDF 页面等）。
    // 直接对已显示的 DOM 元素取像素，无需解析 vault 路径，从而兼容实时预览与任意来源图片
    ocrSourceAtPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const findTag = (tag) => (el.tagName === tag ? el : (typeof el.closest === 'function' ? el.closest(tag.toLowerCase()) : null));
        const img = findTag('IMG');
        if (img) {
            const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            return w && h ? { el: img, w: w, h: h } : null;
        }
        let cv = findTag('CANVAS');
        // PDF 页面里文字层与 canvas 是兄弟/表亲节点，命中文字层时向上找最近的含 canvas 的祖先
        if (!cv) {
            let a = el;
            while (a && a !== document.body) {
                const c = typeof a.querySelector === 'function' ? a.querySelector('canvas') : null;
                if (c) { cv = c; break; }
                a = a.parentElement;
            }
        }
        return cv && cv.width && cv.height ? { el: cv, w: cv.width, h: cv.height } : null;
    }

    // 图源稳定 id：作为取景框词缓存键的前缀（元素在 DOM 生命周期内不变）
    ocrSourceId(el) {
        if (!el.__wmOcrId) el.__wmOcrId = 's' + (++this.ocrElId);
        return el.__wmOcrId;
    }

    // 图源的二值墨迹图（LRU 缓存）：行/列投影与取景框哈希都基于它。
    // 墨迹取灰度直方图 Otsu 分割后像素较少的一类，深底浅字/浅底深字都能正确识别
    getInkMeta(src) {
        const el = src.el;
        const hit = this.imgInk.get(el);
        if (hit) { cacheSet(this.imgInk, el, hit, OCR_INK_CACHE); return hit; }
        const w = src.w, h = src.h;
        if (!w || !h || w * h > 64 * 1000 * 1000) return null; // 超大图放弃，避免内存爆
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(el, 0, 0, w, h);
        let px;
        try { px = cx.getImageData(0, 0, w, h).data; }
        catch (e) { return null; } // 跨域图片画布被污染，无法取像素
        const hist = new Uint32Array(256);
        for (let i = 0; i < px.length; i += 4) hist[(px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0]++;
        const thr = otsuThreshold(hist, w * h);
        let below = 0;
        for (let g = 0; g <= thr; g++) below += hist[g];
        const inkIsDark = below <= w * h - below;
        const ink = new Uint8Array(w * h);
        const rows = new Int32Array(h);
        const rowMax = new Int32Array(h); // 每行最长连续墨迹长度：用于识别贯穿整行的表格横线
        for (let y = 0, p0 = 0, g0 = 0; y < h; y++) {
            let rc = 0, run = 0, mx = 0;
            for (let x = 0; x < w; x++, p0++, g0 += 4) {
                const g = (px[g0] * 299 + px[g0 + 1] * 587 + px[g0 + 2] * 114) / 1000 | 0;
                if (inkIsDark ? g <= thr : g > thr) {
                    ink[p0] = 1; rc++; run++;
                    if (run > mx) mx = run;
                } else run = 0;
            }
            rows[y] = rc;
            rowMax[y] = mx;
        }
        const meta = { w: w, h: h, ink: ink, rows: rows, rowMax: rowMax };
        cacheSet(this.imgInk, el, meta, OCR_INK_CACHE);
        return meta;
    }

    // 图片取词入口：光标映射到图源像素坐标 → 取景框 → 进入 0.5s 计时
    onHoverImage(x, y) {
        if (!this.ocrAvailable()) { this.cancelHover(); return; }
        const src = this.ocrSourceAtPoint(x, y);
        if (!src) { this.cancelHover(); return; }
        const rect = src.el.getBoundingClientRect();
        if (!rect.width || !rect.height) { this.cancelHover(); return; }
        const ix = Math.round((x - rect.left) / rect.width * src.w);  // 光标 → 图源像素
        const iy = Math.round((y - rect.top) / rect.height * src.h);
        if (ix < 0 || iy < 0 || ix >= src.w || iy >= src.h) { this.cancelHover(); return; }
        this.hoverId += 1;
        const id = this.hoverId;
        let ctx = null;
        try { ctx = this.segmentImageWord(src, ix, iy); } catch (e) { /* 取像素失败：静默降级 */ }
        if (id !== this.hoverId) return; // 鼠标已移走，结果作废
        if (!ctx) { this.cancelHover(); return; }
        this.onHoverImageWord(ctx);
    }

    // 取景框：Otsu 二值化定行 → 整行列投影 + 自适应词间空格定左右边界；
    // 若边界未确定（触及搜索上限或图像边缘），把搜索范围放大 50% 重试，最多 4 次
    segmentImageWord(src, ix, iy) {
        const meta = this.getInkMeta(src);
        if (!meta) return null;
        const { w, h, ink, rows, rowMax } = meta;
        const band = lineBand(rows, rowMax, w, h, iy);
        if (!band) return null;
        const charH = band.y1 - band.y0;
        const cols = columnInk(ink, w, band.y0, band.y1);
        clearVerticalRules(cols, ink, w, h, band.y0, band.y1); // 剔除表格竖边框，避免并入单词边界
        // 单侧搜索上限：随字高放大，但不超过图宽——避免行高估计异常时上限失去约束
        let capW = Math.min(w, Math.max(OCR_MAX_CROP_W, Math.round(charH * 8)));
        let seg = null;
        for (let i = 0; i < 4; i++) {
            seg = wordBand(cols, w, ix, charH, capW);
            if (!seg || !seg.clipped) break; // 边界已确定（被词间空格截断）
            capW = Math.min(w, Math.round(capW * 1.5)); // 未能定界：搜索范围放大 50% 再试
        }
        if (!seg) return null;
        // 用词的列区间重算上下边界，纳入升部/降部，避免只框住 x-height 下半部分
        const vb = wordVerticalBand(ink, w, h, seg.x0, seg.x1, band.y0, band.y1);
        const key = this.ocrSourceId(src.el) + '#' + regionHash(ink, w, seg.x0, vb.y0, seg.x1, vb.y1);
        return { el: src.el, w: w, h: h, x0: seg.x0, y0: vb.y0, x1: seg.x1, y1: vb.y1, ix: ix, iy: iy, key: key };
    }

    // 同一取景框（哈希一致）不重复计时与查询
    onHoverImageWord(ctx) {
        if (ctx.key === this.hoverWord) return;
        this.hoverWord = ctx.key;
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => {
            this.hoverTimer = null;
            if (this.obSettings.hoverLookup && this.hoverWord === ctx.key) this.recognizeImageWord(ctx);
        }, HOVER_DELAY);
    }

    // 识别取景框内的单词：命中缓存直接推送，否则裁剪放大后走系统 OCR
    async recognizeImageWord(ctx) {
        // 调试模式跳过结果缓存：保证每次悬浮都真实走一遍裁剪+OCR，便于观察取景框
        const cached = this.ocrDebug ? null : this.imgWords.get(ctx.key);
        if (cached) {
            cacheSet(this.imgWords, ctx.key, cached, OCR_WORD_CACHE);
            this.pushToDictView(cached);
            return;
        }
        if (this.ocrBusy) { this.ocrPending = ctx; return; } // 忙：暂存，当前 OCR 结束后接着处理
        this.ocrBusy = true;
        this.ocrPending = null;
        this.pushStatusToDictView('识别中'); // 悬浮命中图片：提示识别进行中
        try {
            const word = await this.ocrCrop(ctx);
            if (word) {
                this.ocrState = 'on';
                this.ocrFail = 0;
                cacheSet(this.imgWords, ctx.key, word, OCR_WORD_CACHE);
                this.pushToDictView(word);
                this.pushStatusToDictView('识别成功', 2000); // 原位提示并在 2s 后淡出
            } else {
                this.pushStatusToDictView('识别失败', 2000); // 未识别到词：同样反馈后淡出
            }
        } catch (e) {
            console.error('词忆：图片取词 OCR 失败', e);
            if (++this.ocrFail >= 2) this.ocrState = 'off'; // 连续失败：本次会话不再尝试
            this.pushStatusToDictView('识别失败', 2000);
        } finally {
            this.ocrBusy = false;
            const next = this.ocrPending;
            this.ocrPending = null;
            if (next && next.key === this.hoverWord) this.recognizeImageWord(next);
        }
    }

    // 应用内（iframe）图片取词：页面把整图 dataURL 与光标像素坐标发来，
    // 这里解码为 Image 后复用同一套取景（segmentImageWord）与系统 OCR（ocrCrop），
    // 命中则把单词交右侧栏查词视图承接（keepFocus，不抢走应用内焦点）
    async ocrFromApp(dataUrl, ix, iy) {
        if (!this.ocrAvailable()) return;
        if (this.ocrBusy) { this.ocrPendingApp = { dataUrl, ix, iy }; return; } // 忙：暂存最后一次
        this.ocrBusy = true;
        this.ocrPendingApp = null;
        this.pushStatusToDictView('识别中');
        try {
            const img = await loadImageEl(dataUrl);
            const src = { el: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
            const ctx = src.w && src.h ? this.segmentImageWord(src, ix, iy) : null;
            const word = ctx ? await this.ocrCrop(ctx) : '';
            if (word) {
                this.ocrState = 'on';
                this.ocrFail = 0;
                this.pushStatusToDictView('识别成功', 2000);
                this.lookupInDictView(word, true);
            } else {
                this.pushStatusToDictView('识别失败', 2000);
            }
        } catch (e) {
            if (++this.ocrFail >= 2) this.ocrState = 'off'; // 连续失败：本次会话不再尝试
            this.pushStatusToDictView('识别失败', 2000);
        } finally {
            this.ocrBusy = false;
            const next = this.ocrPendingApp;
            this.ocrPendingApp = null;
            if (next) this.ocrFromApp(next.dataUrl, next.ix, next.iy);
        }
    }

    // 裁剪取景框 → 放大到目标字高 → 落临时 PNG → 系统 OCR → 取光标所在词
    async ocrCrop(ctx) {
        const el = ctx.el;
        const pad = Math.max(OCR_CROP_PAD, Math.round((ctx.y1 - ctx.y0) * 0.25)); // 四周留白随字高，避免切掉升部/降部
        const sx = Math.max(0, ctx.x0 - pad);
        const sy = Math.max(0, ctx.y0 - pad);
        const ex = Math.min(ctx.w, ctx.x1 + pad);
        const ey = Math.min(ctx.h, ctx.y1 + pad);
        const cw = ex - sx, ch = ey - sy;
        if (cw <= 0 || ch <= 0) return '';
        const scale = Math.max(1, Math.min(OCR_UPSCALE_MAX, Math.round(OCR_TARGET_H / ch)));
        const cv = document.createElement('canvas');
        cv.width = cw * scale; cv.height = ch * scale;
        const cx = cv.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(el, sx, sy, cw, ch, 0, 0, cv.width, cv.height);
        if (this.ocrDebug) this.showOcrDebug(ctx, cv, sx, sy, scale); // 调试：展示实际取景框与送 OCR 的裁剪图
        const blob = await new Promise((res) => { try { cv.toBlob(res, 'image/png'); } catch (e) { res(null); } });
        if (!blob) return '';
        const tmp = path.join(os.tmpdir(), 'wm-ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.png');
        fs.writeFileSync(tmp, Buffer.from(await blob.arrayBuffer()));
        let words;
        try {
            words = await this.runOcr(tmp);
        } finally {
            try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
        }
        // 光标在裁剪图中的位置（裁剪含留白并经过放大）
        const word = pickOcrWord(words, (ctx.ix - sx) * scale, (ctx.iy - sy) * scale);
        if (this.ocrDebug && this.ocrDebugInfo) { // 调试：把识别结果回填到取景框卡片
            this.ocrDebugInfo.textContent = this.ocrDebugInfo.textContent.replace(/\s*→\s*识别：.*$/, '')
                + '  → 识别：' + (word || '（无）');
        }
        return word;
    }

    // 调试用：在不遮挡阅读的前提下展示本次 OCR 的「取景框」。两处呈现：
    // 1) 图源上叠加一个红色高亮矩形，标明取景框在图中的真实位置；
    // 2) 右下角浮出小卡片，显示送 OCR 的放大裁剪图与坐标/字高/倍率。
    // 均为 pointer-events:none，绝不拦截鼠标；3 秒后自动消失。
    showOcrDebug(ctx, cv, sx, sy, scale) {
        this.hideOcrDebug();
        const rect = ctx.el.getBoundingClientRect();
        if (rect.width && rect.height) {
            // 红框与「实际送 OCR 的裁切图」完全一致（含四周 buffer）：sx/sy 为裁切起点，
            // 裁切宽高 = cv 尺寸 / 放大倍率。鼠标落点也在框内，便于核对取景是否精准
            const cw = cv.width / scale, ch = cv.height / scale;
            const box = document.createElement('div');
            box.className = 'word-memo-ocr-debug-rect';
            box.style.left = (rect.left + sx / ctx.w * rect.width) + 'px';
            box.style.top = (rect.top + sy / ctx.h * rect.height) + 'px';
            box.style.width = (cw / ctx.w * rect.width) + 'px';
            box.style.height = (ch / ctx.h * rect.height) + 'px';
            document.body.appendChild(box);
            this.ocrDebugRect = box;
        }
        const panel = document.createElement('div');
        panel.className = 'word-memo-ocr-debug';
        const title = document.createElement('div');
        title.className = 'word-memo-ocr-debug-title';
        title.textContent = 'OCR 裁切';
        panel.appendChild(title);
        // 裁切图按最大 300px 宽等比缩略展示（实际送 OCR 的是 cv 全尺寸）。
        // 高亮矩形已由 DOM 叠加层标出「取景框」，此处专门显示「实际送 OCR 的裁切图」，
        // 并标出鼠标落点，便于核对裁切位置是否正确
        const maxW = 300, maxH = 90;
        const k = Math.min(maxW / cv.width, maxH / cv.height, 1);
        const thumb = document.createElement('canvas');
        thumb.width = Math.max(1, Math.round(cv.width * k));
        thumb.height = Math.max(1, Math.round(cv.height * k));
        const tctx = thumb.getContext('2d');
        tctx.fillStyle = '#fff';
        tctx.fillRect(0, 0, thumb.width, thumb.height);
        tctx.drawImage(cv, 0, 0, thumb.width, thumb.height);
        // 鼠标落点：裁切图内光标像素 × 缩略比例
        const hx = (ctx.ix - sx) * scale * k, hy = (ctx.iy - sy) * scale * k;
        tctx.strokeStyle = '#000'; tctx.lineWidth = 3;
        tctx.beginPath(); tctx.moveTo(hx, 0); tctx.lineTo(hx, thumb.height); tctx.moveTo(0, hy); tctx.lineTo(thumb.width, hy); tctx.stroke();
        tctx.strokeStyle = '#ff2d55'; tctx.lineWidth = 1;
        tctx.beginPath(); tctx.moveTo(hx, 0); tctx.lineTo(hx, thumb.height); tctx.moveTo(0, hy); tctx.lineTo(thumb.width, hy); tctx.stroke();
        panel.appendChild(thumb);
        const info = document.createElement('div');
        info.className = 'word-memo-ocr-debug-info';
        info.textContent = '原图 ' + ctx.w + '×' + ctx.h + '  取景 [' + ctx.x0 + ',' + ctx.y0 + ' → ' + ctx.x1 + ',' + ctx.y1 + ']  '
            + '裁切 ' + cv.width + '×' + cv.height + '（' + scale + '×）  字高 ' + (ctx.y1 - ctx.y0);
        panel.appendChild(info);
        document.body.appendChild(panel);
        this.ocrDebugInfo = info;
        // 兜底：面板若因主题/层级未显示，可在控制台看到同一份取景/裁切数据
        console.log('[词忆OCR 取景与裁切]', info.textContent, ' 鼠标落点(裁切图内)=' + Math.round((ctx.ix - sx) * scale) + ',' + Math.round((ctx.iy - sy) * scale));
        this.ocrDebugBox = panel;
        this.ocrDebugTimer = setTimeout(() => this.hideOcrDebug(), 3000);
    }

    hideOcrDebug() {
        if (this.ocrDebugTimer) { clearTimeout(this.ocrDebugTimer); this.ocrDebugTimer = null; }
        if (this.ocrDebugRect) { this.ocrDebugRect.remove(); this.ocrDebugRect = null; }
        if (this.ocrDebugBox) { this.ocrDebugBox.remove(); this.ocrDebugBox = null; }
        this.ocrDebugInfo = null;
    }

    // 调用 Windows 系统 OCR：spawn powershell.exe 执行内联脚本，图片路径经环境变量传入
    runOcr(imgPath) {
        return new Promise((resolve, reject) => {
            execFile('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ocrEncodedCommand()],
                {
                    windowsHide: true,
                    timeout: 15000,
                    maxBuffer: 16 * 1024 * 1024,
                    env: Object.assign({}, process.env, { WM_OCR_IMG: imgPath })
                },
                (err, stdout) => {
                    if (err) { reject(err); return; }
                    const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
                    if (!text) { resolve([]); return; }
                    try {
                        const j = JSON.parse(text);
                        resolve(Array.isArray(j) ? j : [j]);
                    } catch (e) { reject(e); }
                });
        });
    }

    // 持久化插件设置（宿主功能开关 / 取景框调试）
    async persistLocalSettings() {
        const saved = (await this.loadData()) || {};
        await this.saveData(Object.assign({}, saved, { obSettings: this.obSettings, ocrDebug: this.ocrDebug }));
    }


    // PDF 划词查询：内置 PDF 查看器不触发 editor-menu 事件，故自绘两个入口
    // 入口一：选中文本后在选区旁浮出「查」按钮；入口二：把「查询」追加进 PDF 右键菜单
    initPdfSelection() {
        const btn = document.body.createDiv({ cls: 'word-memo-pdf-translate-btn' });
        btn.innerHTML = SEARCH_ICON_INLINE_SVG;
        btn.setAttribute('aria-label', '查询（词忆）');
        btn.style.display = 'none';
        this.pdfBtn = btn;
        btn.addEventListener('mousedown', (e) => e.preventDefault()); // 避免按下时清除选区
        btn.addEventListener('click', () => {
            const text = this.pdfBtnText;
            this.hidePdfBtn();
            if (text) this.translateSelection(text);
        });
        this.registerDomEvent(document, 'selectionchange', () => this.syncPdfBtn());
        // 按钮内含 <svg> 图标，点击时 e.target 是 svg/path 而非按钮本身，
        // 故用 contains 判定，避免误当作「点击别处」把按钮隐藏并清空待翻译文本
        this.registerDomEvent(document, 'mousedown', (e) => { if (!btn.contains(e.target)) this.hidePdfBtn(); });
        this.registerDomEvent(window, 'scroll', () => this.hidePdfBtn(), true);
        // PDF 的原生右键菜单由 Obsidian 内部实现（插件无法挂载菜单项），
        // 故在 contextmenu 之后把「翻译」追加进已弹出的菜单，原有菜单项保持不变
        this.registerDomEvent(document, 'contextmenu', (e) => this.onPdfContextMenu(e), true);
    }

    // 选区文本（仅当选区落在 PDF 文本层内且长度合理时返回，否则空串）
    pdfSelectionText() {
        if (!this.obSettings.selectionTranslate) return '';
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return '';
        const text = String(sel).trim();
        if (!text || text.length > 2000) return '';
        const node = sel.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (!el || typeof el.closest !== 'function') return '';
        // 与悬浮取词同一套判定：PDF 视图叶子，或笔记内嵌的 PDF
        const leaf = el.closest('.workspace-leaf-content');
        const isPdf = (leaf && leaf.getAttribute('data-type') === 'pdf') || !!el.closest('.pdf-embed, .pdf-viewer, .pdf-container');
        if (!isPdf) return '';
        return text;
    }

    // 选区末尾的矩形（用于定位浮出按钮）。不用 DOM 顺序推断「末尾字符」——PDF 文本层里
    // 空格等 span 的 DOM 顺序可能与视觉顺序不一致，会导致取到段落末尾的字符。改用纯几何判定：
    // 取选区所有行矩形中最靠下、同一行最靠右者（即视觉上的选区末尾）
    selectionEndRect(range) {
        const rects = range.getClientRects();
        const list = [];
        let minH = Infinity;
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (r.width > 0 && r.height > 0) {
                list.push(r);
                if (r.height < minH) minH = r.height;
            }
        }
        if (!list.length) return null;
        // 选区含空格时，浏览器会把 PDF 文本层根容器（覆盖整页的块级元素）也当作一个矩形返回，
        // 其高度远大于单行，按最小行高过滤掉，避免按钮被顶到容器右上角
        const lines = list.filter((r) => r.height <= minH * 1.8);
        const pool = lines.length ? lines : list;
        const tol = Math.max(1, minH * 0.5); // 同一视觉行的高度容差
        let best = null;
        for (let i = 0; i < pool.length; i++) {
            const r = pool[i];
            if (!best || r.bottom > best.bottom + tol) best = r;
            else if (Math.abs(r.bottom - best.bottom) <= tol && r.right > best.right) best = r;
        }
        return best;
    }

    // 让浮出的「译」按钮跟随 PDF 选区末尾
    syncPdfBtn() {
        const text = this.pdfSelectionText();
        if (!text || !this.pdfBtn) { this.hidePdfBtn(); return; }
        const sel = window.getSelection();
        const rect = this.selectionEndRect(sel.getRangeAt(0));
        if (!rect || (!rect.width && !rect.height)) { this.hidePdfBtn(); return; }
        this.pdfBtnText = text;
        const btn = this.pdfBtn;
        btn.style.display = 'flex';
        btn.style.left = Math.max(4, Math.min(window.innerWidth - 40, rect.right + 6)) + 'px';
        btn.style.top = Math.max(4, rect.top - 2) + 'px';
    }

    hidePdfBtn() {
        if (this.pdfBtn) this.pdfBtn.style.display = 'none';
        this.pdfBtnText = '';
    }

    onPdfContextMenu(e) {
        const text = this.pdfSelectionText();
        if (!text) return;
        this.hidePdfBtn();
        this.injectPdfMenuItem(text);
    }

    // 等 Obsidian 的 PDF 右键菜单出现后，往其中追加「查询（词忆）」
    injectPdfMenuItem(text) {
        let tries = 0;
        const tick = () => {
            const menu = this.findOpenMenu();
            if (!menu) {
                if (++tries < 10) window.requestAnimationFrame(tick);
                return;
            }
            if (menu.querySelector('.word-memo-pdf-menu-item')) return; // 已注入过
            const item = menu.createDiv({ cls: 'menu-item tappable word-memo-pdf-menu-item' });
            // 图标 + 标题：图标结构与 Obsidian 原生菜单项一致（.menu-item-icon > .svg-icon）
            item.createDiv({ cls: 'menu-item-icon svg-icon' }).innerHTML = SEARCH_ICON_INLINE_SVG;
            item.createDiv({ cls: 'menu-item-title', text: '查询' });
            item.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.translateSelection(text);
                this.closeOpenMenus();
            });
        };
        window.requestAnimationFrame(tick);
    }

    // 当前可见的 Obsidian 菜单（取最后一个，即最新打开的那个）
    findOpenMenu() {
        const menus = document.querySelectorAll('.menu');
        for (let i = menus.length - 1; i >= 0; i--) {
            if (menus[i].getBoundingClientRect().width > 0) return menus[i];
        }
        return null;
    }

    // 收起菜单：Obsidian 的菜单自身监听 mousedown 来关闭
    closeOpenMenus() {
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }

    // 悬浮取词推送：仅更新已打开的右侧栏面板，不自动展开（避免鼠标划过单词时打断编辑）
    pushToDictView(word) {
        const leaves = this.app.workspace.getLeavesOfType(DICT_VIEW_TYPE);
        if (!leaves.length) return;
        leaves.forEach((leaf) => {
            const view = leaf.view;
            if (view && typeof view.postToFrame === 'function') view.postToFrame({ type: 'wm-dict-word', word: word });
        });
    }

    // 推送侧栏状态提示（如「识别中」）。text 为空表示收起提示；
    // autoHideMs > 0 表示短暂提示（如「识别成功/失败」）在该毫秒数后自动淡出
    pushStatusToDictView(text, autoHideMs) {
        const leaves = this.app.workspace.getLeavesOfType(DICT_VIEW_TYPE);
        if (!leaves.length) return;
        leaves.forEach((leaf) => {
            const view = leaf.view;
            if (view && typeof view.postToFrame === 'function') view.postToFrame({ type: 'wm-dict-status', text: text || '', autoHide: autoHideMs || 0 });
        });
    }

    // 后台启动内置静态服务（自动，无需用户手动执行任何命令）
    async startServer() {
        try {
            const saved = (await this.loadData()) || {};
            const vaultBase = this.app.vault.adapter.getBasePath();
            // 发行版：解压内嵌应用包，以其目录为服务根；开发态（无内嵌包）：回退到 vault 根目录
            let root = vaultBase;
            try {
                const extracted = extractAppBundle(vaultBase);
                if (extracted) root = extracted;
            } catch (e) {
                console.error('词忆：解压内嵌应用包失败，回退到 vault 根目录', e);
            }
            const srv = new StaticServer(root);
            const port = await srv.start(saved.port || DEFAULT_PORT);
            this.server = srv;
            this.baseUrl = 'http://127.0.0.1:' + port;
            // 记住实际端口，保证 origin 稳定（localStorage 数据不丢）
            if (saved.port !== port) await this.saveData(Object.assign({}, saved, { port }));
        } catch (e) {
            console.error('词忆：内置静态服务启动失败，将回退到 app:// 资源路径', e);
            new Notice('词忆：内置服务启动失败，页面样式与交互可能不可用');
        }

        // 服务就绪后刷新已打开的视图（首次打开时服务可能尚未监听）
        try {
            this.app.workspace.getLeavesOfType(VIEW_TYPE)
                .concat(this.app.workspace.getLeavesOfType(DICT_VIEW_TYPE))
                .concat(this.app.workspace.getLeavesOfType(COVER_VIEW_TYPE))
                .forEach((leaf) => {
                    if (leaf.view && typeof leaf.view.reloadFrame === 'function') leaf.view.reloadFrame();
                });
        } catch (e) {
            console.error('词忆：刷新视图失败', e);
        }
    }

    onunload() {
        this.cancelHover(); // 清理悬浮取词计时
        this.hideOcrDebug(); // 移除调试取景框叠加层
        if (this.imgInk) this.imgInk.clear(); // 释放墨迹图 / 取景框词缓存
        if (this.imgWords) this.imgWords.clear();
        if (this.pdfBtn) { this.pdfBtn.remove(); this.pdfBtn = null; } // 移除 PDF 划词浮出按钮
        if (this.server) {
            this.server.stop();
            this.server = null;
            this.baseUrl = null;
        }
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    // 在右侧栏打开查单词视图（已存在则复用并展开）。
    // keepFocus=true 时不把侧栏激活/聚焦，仅展开并展示内容，保持主页 iframe 焦点不被抢走
    async activateDictView(keepFocus) {
        const { workspace } = this.app;
        // 首选官方 ensureSideLeaf：保证视图落在右侧栏、并同时展开侧栏。
        // active 决定是否聚焦该标签：keepFocus 时传 false，避免抢走主页 iframe 的焦点
        if (typeof workspace.ensureSideLeaf === 'function') {
            const leaf = await workspace.ensureSideLeaf(DICT_VIEW_TYPE, 'right', { active: !keepFocus, reveal: true });
            if (leaf) return;
        }
        // 回退（旧版 Obsidian 无 ensureSideLeaf）：沿用原逻辑，并显式展开折叠的右侧栏
        let leaf = workspace.getLeavesOfType(DICT_VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getRightLeaf(false) || workspace.getLeaf('tab');
            await leaf.setViewState({ type: DICT_VIEW_TYPE, active: !keepFocus });
        }
        if (workspace.rightSplit && workspace.rightSplit.collapsed) workspace.rightSplit.expand();
        if (!keepFocus) workspace.revealLeaf(leaf);
    }

    // 打开封面视窗（已存在则复用并展开）：供其它可视化插件内嵌
    async activateCoverView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(COVER_VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: COVER_VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    // 把主页发来的单词交给右侧栏查词视图：先确保侧栏已展开，再把单词推入其 iframe。
    // 侧栏刚创建时 iframe 尚未加载完成，消息由视图排队、load 后补发
    async lookupInDictView(word, keepFocus) {
        if (!word) return;
        await this.sendToDictView({ type: 'wm-dict-word', word: word }, keepFocus);
    }

    // 把消息交给右侧栏查词视图：先确保侧栏已展开，再推入其 iframe。
    // 侧栏刚创建时 iframe 尚未加载完成，消息由视图排队、load 后补发
    async sendToDictView(msg, keepFocus) {
        await this.activateDictView(keepFocus);
        this.app.workspace.getLeavesOfType(DICT_VIEW_TYPE).forEach((leaf) => {
            const view = leaf.view;
            if (view && typeof view.postToFrame === 'function') view.postToFrame(msg);
        });
    }

    // 划词查询：编辑器选中的文本交给右侧栏承接（单词 → 首选词典释义，句子/中文 → AI 查询：翻译并解读）
    translateSelection(text) {
        const t = String(text || '').trim();
        if (!t) return;
        this.sendToDictView({ type: 'wm-dict-translate', text: t });
    }
};
