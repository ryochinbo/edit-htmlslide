// HTMLスライドエディター用のローカルサーバー（依存パッケージなし）
// 起動: node server.js  →  http://localhost:5180/editor/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5180;
const BACKUP_DIR = path.join(ROOT, '.backups');
const IS_WIN = process.platform === 'win32';
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

// エディター本体（editor/ 等）はプロジェクト配下だけを配信する
function safePath(rel) {
  const p = path.resolve(ROOT, '.' + path.sep + decodeURIComponent(rel || '').replace(/^[/\\]+/, ''));
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error('不正なパスです');
  return p;
}

// 編集対象のファイルは任意の場所を許可する（相対パスはプロジェクト基準）
function userPath(p) {
  if (!p || typeof p !== 'string') throw new Error('パスが指定されていません');
  return path.resolve(ROOT, p);
}

// /fs/C%3A/Users/... → C:\Users\...（POSIX では /fs/home/... → /home/...）
function fsUrlToPath(pathname) {
  const rest = pathname.slice(4).split('/').map(decodeURIComponent).join('/');
  return path.resolve(/^[A-Za-z]:/.test(rest) ? rest : '/' + rest);
}

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('サイズが大きすぎます')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendFile(res, p) {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); return res.end('Not Found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}

// ---- ファイル選択 ----
function listDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(d)) drives.push(d); } catch { /* 準備できていないドライブは無視 */ }
  }
  return drives;
}

function listDir(dir) {
  if (!dir) {
    // ルート：Windows はドライブ一覧
    if (IS_WIN) return { dir: '', parent: null, entries: listDrives().map(d => ({ name: d, path: d, type: 'dir' })) };
    dir = '/';
  }
  const abs = path.resolve(dir);
  const entries = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'node_modules') continue;
    const full = path.join(abs, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { continue; } }
    if (isDir) entries.push({ name: e.name, path: full, type: 'dir' });
    else if (/\.html?$/i.test(e.name)) {
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* 読めないファイルは日時なし */ }
      entries.push({ name: e.name, path: full, type: 'html', mtime });
    }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'ja') : a.type === 'dir' ? -1 : 1));
  const parent = path.dirname(abs);
  return { dir: abs, parent: parent === abs ? (IS_WIN ? '' : null) : parent, entries };
}

function places() {
  const home = os.homedir();
  const first = (...cands) => cands.find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  return [
    { name: 'slides フォルダ', path: first(path.join(ROOT, 'slides'), ROOT) },
    { name: 'デスクトップ', path: first(path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'OneDrive', 'デスクトップ')) },
    { name: 'ドキュメント', path: first(path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'OneDrive', 'ドキュメント')) },
    { name: 'ダウンロード', path: first(path.join(home, 'Downloads')) },
    { name: 'ホーム', path: home },
  ].filter(p => p.path);
}

// Windows 標準の「開く」/「名前を付けて保存」ダイアログを表示して選ばれたパスを返す
function nativePick(initialDir, mode = 'open', fileName = '') {
  return new Promise((resolve, reject) => {
    if (!IS_WIN) return reject(new Error('この機能は Windows のみ対応しています'));
    const init = initialDir && fs.existsSync(initialDir) ? initialDir : path.join(ROOT, 'slides');
    const dialogType = mode === 'save' ? 'SaveFileDialog' : 'OpenFileDialog';
    const title = mode === 'save' ? '名前を付けて保存' : '編集するHTMLスライドを選択';
    const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
# ブラウザの裏に隠れないよう、見えない最前面ウィンドウを親にする
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = 'None'; StartPosition = 'Manual'; Location = New-Object System.Drawing.Point(-32000, -32000); Size = New-Object System.Drawing.Size(1, 1); Opacity = 0 }
$owner.Show(); $owner.Activate()
$dlg = New-Object System.Windows.Forms.${dialogType}
$dlg.Title = '${title}'
$dlg.Filter = 'HTMLファイル (*.html;*.htm)|*.html;*.htm|すべてのファイル (*.*)|*.*'
$dlg.InitialDirectory = $env:PICK_INIT
if ($env:PICK_NAME) { $dlg.FileName = $env:PICK_NAME; $dlg.DefaultExt = 'html' }
if ($dlg.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dlg.FileName) }
$owner.Dispose()`;
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, PICK_INIT: init, PICK_NAME: fileName || '' }, windowsHide: true, timeout: 10 * 60 * 1000, encoding: 'utf8' },
      (err, stdout) => (err ? reject(new Error('ダイアログを表示できませんでした')) : resolve(stdout.trim() || null)));
  });
}

// ---- 名前を付けて保存 ----
// 別フォルダへ保存するとき、HTMLが相対パスで参照する画像などを新しい場所でも使えるようにする。
//  ・元フォルダ内のファイル → 同じ相対位置にコピー（既にあれば上書きしない）
//  ・元フォルダの外（../ など）のファイル → 新しい場所からの相対パスに書き換え
function relocateRefs(html, fromDir, toDir) {
  const result = { copied: 0, rewritten: 0, missing: [] };
  const seen = new Map();
  const fix = ref => {
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/|#|\{|\$)/i.test(ref.trim())) return ref;   // URL・data:・ルート相対・アンカー等はそのまま
    if (seen.has(ref)) return seen.get(ref);
    const m = ref.match(/^([^?#]*)(.*)$/);
    let rel = m[1];
    try { rel = decodeURIComponent(rel); } catch { /* そのまま使う */ }
    const src = path.resolve(fromDir, rel);
    let out = ref;
    if (!rel || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      if (rel) result.missing.push(ref);
    } else if (src.startsWith(fromDir + path.sep)) {
      const dst = path.join(toDir, path.relative(fromDir, src));
      if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); result.copied++; }
    } else {
      const nrel = path.relative(toDir, src);
      if (path.isAbsolute(nrel)) result.missing.push(ref);   // 別ドライブ等で相対パスにできない
      else { out = encodeURI(nrel.split(path.sep).join('/')) + m[2]; result.rewritten++; }
    }
    seen.set(ref, out);
    return out;
  };
  html = html
    .replace(/(\s(?:src|href|poster|data)\s*=\s*)(["'])(.*?)\2/gi, (_, a, q, v) => a + q + fix(v) + q)
    .replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (_, a, q, v) => a + q + v.split(',').map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [fix(u), ...rest].join(' ');
    }).join(', ') + q)
    .replace(/url\(\s*(["']?)([^"')]*?)\1\s*\)/gi, (_, q, v) => `url(${q}${fix(v)}${q})`);
  return { html, ...result };
}

function backup(target) {
  if (!fs.existsSync(target)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(target, path.join(BACKUP_DIR, `${path.basename(target, path.extname(target))}.${stamp}.html`));
}

function saveAs({ from, to, html, overwrite }) {
  if (!/\.html?$/i.test(to || '')) throw new Error('保存先は .html ファイルにしてください');
  const target = userPath(to);
  const source = from ? userPath(from) : null;
  if (!fs.existsSync(path.dirname(target))) throw new Error('保存先のフォルダがありません: ' + path.dirname(target));
  if (fs.existsSync(target) && !overwrite) return { exists: true, path: target };
  let info = { copied: 0, rewritten: 0, missing: [] };
  if (source && path.dirname(source).toLowerCase() !== path.dirname(target).toLowerCase()) {
    info = relocateRefs(html, path.dirname(source), path.dirname(target));
    html = info.html;
  }
  backup(target);
  fs.writeFileSync(target, html, 'utf8');
  return { ok: true, path: target, copied: info.copied, rewritten: info.rewritten, missing: info.missing };
}

// ---- PDF / PNG 書き出し（ローカルの Chrome / Edge をヘッドレスで使う） ----
function findChrome() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.CHROME_PATH,
    path.join(pf, 'Google/Chrome/Application/chrome.exe'),
    path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
    path.join(local, 'Google/Chrome/Application/chrome.exe'),
    path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return candidates.find(p => p && fs.existsSync(p));
}

function runChrome(chrome, args) {
  // 並列実行できるよう、毎回使い捨てのプロファイルを使う
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-export-'));
  const base = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${profile}`, '--virtual-time-budget=3000'];
  return new Promise((resolve, reject) => {
    execFile(chrome, [...base, ...args], { timeout: 120000 }, (err, _out, stderr) => {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome終了直後のロックは無視 */ }
      if (err) reject(new Error('Chromeの実行に失敗しました: ' + String(stderr || err.message).slice(-300)));
      else resolve();
    });
  });
}

async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// [1,3,4,5] → "1_3-5"
function rangeLabel(pages) {
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(j > i ? `${pages[i]}-${pages[j]}` : `${pages[i]}`);
    i = j;
  }
  return out.join('_');
}

// 書き出し時だけ、ページ送りボタン等を消し、背景色を確実に印刷する
const EXPORT_CSS = '<style id="ed-export">.nav,.hint{display:none!important}*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}</style>';
const withExportCss = html => html.replace(/<\/head>/i, EXPORT_CSS + '</head>');

async function exportDeck({ file, type, all, pages, contactSheet, html, htmlPages }) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome または Edge が見つかりません（環境変数 CHROME_PATH で指定できます）');
  const deck = userPath(file);
  const dir = path.dirname(deck);
  const name = path.basename(deck, path.extname(deck));
  const temps = [];
  // 一時HTMLはスライドと同じフォルダに置き、assets の相対パスを生かす
  const writeTemp = (folder, content) => {
    const p = path.join(folder, `.~export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.html`);
    fs.writeFileSync(p, content, 'utf8'); temps.push(p); return p;
  };
  try {
    if (type === 'pdf') {
      const out = path.join(dir, all ? `${name}.pdf` : `${name}_p${rangeLabel(pages)}.pdf`);
      const tmp = writeTemp(dir, withExportCss(html));
      await runChrome(chrome, ['--no-pdf-header-footer', `--print-to-pdf=${out}`, pathToFileURL(tmp).href]);
      if (!fs.existsSync(out)) throw new Error('PDFが作成されませんでした');
      return [out];
    }
    if (type === 'png') {
      const reviewDir = path.join(dir, 'review');
      fs.mkdirSync(reviewDir, { recursive: true });
      // 全ページ書き出しでは、ページ数が減った場合の古い画像を残さない
      if (all) for (const f of fs.readdirSync(reviewDir)) if (/^slide-\d+\.png$/.test(f)) fs.unlinkSync(path.join(reviewDir, f));
      const outputs = [];
      await pool(htmlPages, 4, async ({ n, html: pageHtml }) => {
        const out = path.join(reviewDir, `slide-${String(n).padStart(2, '0')}.png`);
        const tmp = writeTemp(dir, withExportCss(pageHtml));
        await runChrome(chrome, ['--window-size=1280,720', `--screenshot=${out}`, pathToFileURL(tmp).href]);
        outputs.push(out);
      });
      outputs.sort();
      if (contactSheet) {
        const cols = 4, rows = Math.ceil(htmlPages.length / cols);
        const tiles = htmlPages.map(({ n }) => {
          const f = `slide-${String(n).padStart(2, '0')}.png`;
          return `<div class="t"><img src="${f}?v=${Date.now()}"><span class="n">${n}</span></div>`;
        }).join('');
        const sheet = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}.g{display:grid;grid-template-columns:repeat(${cols},320px)}.t{position:relative;width:320px;height:180px;padding:4px;box-sizing:border-box}.t img{display:block;width:100%;height:100%;border:1px solid #d7d7d7;box-sizing:border-box}.n{position:absolute;left:4px;top:4px;min-width:26px;padding:4px 7px;background:#111;color:#fff;font:700 15px/1 Arial,sans-serif;text-align:center}</style><div class="g">${tiles}</div>`;
        const tmp = writeTemp(reviewDir, sheet);
        const out = path.join(reviewDir, 'contact-sheet.png');
        await runChrome(chrome, [`--window-size=1280,${rows * 180}`, `--screenshot=${out}`, pathToFileURL(tmp).href]);
        outputs.push(out);
      }
      return outputs;
    }
    throw new Error('不明な形式です: ' + type);
  } finally {
    for (const t of temps) try { fs.unlinkSync(t); } catch { /* 既に削除済み */ }
  }
}

// ---- サーバー ----
const server = http.createServer(async (req, res) => {
  try {
    // 他のWebサイトからこのサーバーを操作されないよう、Host と Origin を確認する
    if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('Forbidden host'); }
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) {
      res.writeHead(403); return res.end('Forbidden origin');
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/info' && req.method === 'GET') {
      return json(res, 200, { root: ROOT, sep: path.sep, isWin: IS_WIN, defaultDir: path.join(ROOT, 'slides') });
    }

    if (url.pathname === '/api/places' && req.method === 'GET') {
      return json(res, 200, { places: places(), drives: IS_WIN ? listDrives() : [] });
    }

    if (url.pathname === '/api/ls' && req.method === 'GET') {
      return json(res, 200, listDir(url.searchParams.get('dir') || ''));
    }

    if (url.pathname === '/api/exists' && req.method === 'GET') {
      const p = userPath(url.searchParams.get('path'));
      return json(res, 200, { path: p, exists: fs.existsSync(p) && fs.statSync(p).isFile() });
    }

    if (url.pathname === '/api/pick' && req.method === 'POST') {
      const { initialDir, mode, fileName } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(res, 200, { path: await nativePick(initialDir, mode, fileName) });
    }

    if (url.pathname === '/api/saveas' && req.method === 'POST') {
      return json(res, 200, saveAs(JSON.parse((await readBody(req)).toString('utf8'))));
    }

    if (url.pathname === '/api/save' && req.method === 'POST') {
      const { file, html } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!/\.html?$/i.test(file || '')) throw new Error('HTMLファイルのみ保存できます');
      const target = userPath(file);
      backup(target);   // 上書き前に必ずバックアップを取る
      fs.writeFileSync(target, html, 'utf8');
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/export' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const outputs = await exportDeck(body);
      return json(res, 200, { ok: true, outputs });
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      // 画像をスライドと同じフォルダの assets/uploads/ に保存し、相対パスを返す
      const file = url.searchParams.get('file');
      const name = (url.searchParams.get('name') || 'image.png').replace(/[^\w.\-]/g, '_');
      if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) throw new Error('画像ファイルのみアップロードできます');
      const deckDir = path.dirname(userPath(file));
      const upDir = path.join(deckDir, 'assets', 'uploads');
      fs.mkdirSync(upDir, { recursive: true });
      const finalName = `${Date.now()}_${name}`;
      fs.writeFileSync(path.join(upDir, finalName), await readBody(req));
      return json(res, 200, { src: `assets/uploads/${finalName}` });
    }

    // 編集対象のファイルと、その画像などの配信
    if (url.pathname.startsWith('/fs/') && req.method === 'GET') return sendFile(res, fsUrlToPath(url.pathname));

    // エディター本体の配信
    let p = safePath(url.pathname);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    return sendFile(res, p);
  } catch (err) {
    json(res, 400, { ok: false, error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`HTMLスライドエディター: http://localhost:${PORT}/editor/`);
});
