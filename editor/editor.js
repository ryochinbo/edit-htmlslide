// HTMLスライドエディター本体
// スライドHTMLをiframe(srcdoc)に読み込み、DOMを直接編集して書き戻す。
// 元のスクリプトは編集中だけ無効化し、保存時に元へ戻す。
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const SW = 1280, SH = 720;        // スライドの論理サイズ
const THUMB_W = 192;              // サムネイル幅
const stage = $('#stage'), hit = $('#hitLayer'), selBox = $('#selBox'), hoverBox = $('#hoverBox'), shield = $('#dragShield');

const S = {
  file: null, doc: null, win: null, slides: [], cur: 0,
  sel: null, editing: null, savedRange: null, scale: 1,
  undo: [], redo: [], coalesce: { key: null, t: 0 },
  dirty: false, clipboard: null, imageMode: 'insert',
};

// 編集中だけiframeに差し込むCSS（保存時に除去）
const EDITOR_CSS = `
html,body{background:#e4e4e7!important;overflow:hidden!important}
.slide{display:none!important}
.slide.ed-show{display:block!important;box-shadow:0 4px 24px rgba(0,0,0,.18)}
.nav,.hint{display:none!important}
[contenteditable="true"]{outline:none;cursor:text}
`;
const THUMB_CSS = `
html,body{overflow:hidden!important;background:#fff!important}
.slide{display:none!important}
.slide.ed-show{display:block!important}
:root{--scale:${THUMB_W / SW}}
.nav,.hint{display:none!important}
`;

// ---------------------------------------------------------------- ユーティリティ
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cs = el => S.win.getComputedStyle(el);
const curSlide = () => S.slides[S.cur];
const round1 = v => Math.round(v * 10) / 10;

function toHex(color) {
  const m = String(color).match(/rgba?\(([^)]+)\)/);
  if (!m) return /^#[0-9a-f]{6}$/i.test(color) ? color : '#000000';
  const [r, g, b] = m[1].split(/[ ,/]+/).map(Number);
  return '#' + [r, g, b].map(v => clamp(Math.round(v) || 0, 0, 255).toString(16).padStart(2, '0')).join('');
}
const isTransparent = c => /rgba\(.*,\s*0\)$/.test(c) || c === 'transparent';

function setStatus(msg, kind = '') {
  const el = $('#status');
  el.textContent = msg; el.className = kind; el.title = msg;
}

function markDirty() {
  if (!S.dirty) { S.dirty = true; document.title = '● ' + document.title.replace(/^● /, ''); }
  setStatus('未保存の変更があります', 'dirty');
}

// ---------------------------------------------------------------- 読み込み
// 絶対パス → このサーバーで配信するURL（/fs/C%3A/Users/...）
function fsUrl(p) {
  return '/fs/' + p.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}
const baseName = p => p.split(/[\\/]/).pop();
const dirName = p => p.replace(/[\\/][^\\/]*$/, '');

// 最近使ったファイル（このブラウザにだけ保存）
function getRecent() {
  try { return JSON.parse(localStorage.getItem('ed-recent') || '[]'); } catch { return []; }
}
function addRecent(p) {
  const list = [p, ...getRecent().filter(x => x.toLowerCase() !== p.toLowerCase())].slice(0, 12);
  try { localStorage.setItem('ed-recent', JSON.stringify(list)); } catch { /* 保存できなくても動作に支障なし */ }
}
function removeRecent(p) {
  try { localStorage.setItem('ed-recent', JSON.stringify(getRecent().filter(x => x !== p))); } catch { /* 同上 */ }
}

async function fileExists(p) {
  try { return (await (await fetch('/api/exists?path=' + encodeURIComponent(p))).json()); } catch { return { exists: false }; }
}

async function init() {
  bindUI();
  try {
    S.info = await (await fetch('/api/info')).json();
  } catch {
    setStatus('サーバーに接続できません。エディター起動.bat から起動してください', 'err');
    return;
  }
  // 開くファイル：URL指定 → 最近使ったファイル → ファイル選択画面
  const candidates = [new URLSearchParams(location.search).get('file'), ...getRecent()].filter(Boolean);
  for (const c of candidates) {
    const r = await fileExists(c);
    if (r.exists) { await loadFile(r.path); return; }
  }
  setStatus('「開く」から編集するHTMLを選んでください');
  openFileDialog();
}

async function loadFile(file) {
  setStatus('読み込み中…');
  let res;
  try { res = await fetch(fsUrl(file) + '?t=' + Date.now()); } catch { res = null; }
  if (!res || !res.ok) { setStatus('読み込みに失敗しました: ' + file, 'err'); removeRecent(file); return false; }
  const d = new DOMParser().parseFromString(await res.text(), 'text/html');
  if (!d.querySelector('.slide')) {
    if (!confirm(`「${baseName(file)}」には class="slide" のページが見つかりません。\nこのエディターで編集できない形式の可能性があります。開きますか？`)) {
      setStatus(S.file ? '読み込み完了' : '「開く」から編集するHTMLを選んでください');
      return false;
    }
  }

  // 元のスクリプトを無効化（ページ送り等が編集操作と衝突するため）
  d.querySelectorAll('script').forEach(s => {
    s.setAttribute('data-ed-type', s.hasAttribute('type') ? s.getAttribute('type') : '__none__');
    s.setAttribute('type', 'text/x-ed-disabled');
  });
  // 「書式をリセット」で戻せるよう、元のインラインスタイルを控えておく
  d.querySelectorAll('[style]').forEach(el => el.setAttribute('data-ed-orig-style', el.getAttribute('style')));
  const base = d.createElement('base'); base.id = 'ed-base'; base.href = new URL(fsUrl(file), location.origin).href;
  d.head.prepend(base);
  const st = d.createElement('style'); st.id = 'ed-style'; st.textContent = EDITOR_CSS; d.head.append(st);
  const sc = d.createElement('style'); sc.id = 'ed-scale'; d.head.append(sc);

  await new Promise(resolve => { stage.onload = resolve; stage.srcdoc = '<!doctype html>\n' + d.documentElement.outerHTML; });
  Object.assign(S, { file, doc: stage.contentDocument, win: stage.contentWindow, undo: [], redo: [], sel: null, editing: null, dirty: false });
  bindFrame();
  collectSlides();
  fitStage();
  showSlide(0);
  renderThumbs();
  document.title = 'HTMLスライドエディター - ' + baseName(file);
  history.replaceState(null, '', '?file=' + encodeURIComponent(file));
  $('#fileName').textContent = baseName(file);
  $('#fileName').title = file;
  addRecent(file);
  setStatus('読み込み完了');
  // 画像の読み込み後に枠を合わせ直す
  S.win.addEventListener('load', updateOverlay);
  return true;
}

// ---------------------------------------------------------------- ファイルを開く画面
const OD = { dir: null, parent: null, selected: null };

function sideItem(label, sub, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'side-item';
  b.textContent = label;
  if (sub) { const s = document.createElement('small'); s.textContent = sub; b.append(s); }
  b.title = sub || label;
  b.onclick = onClick;
  return b;
}

// mode: 'open'（ファイルを開く）/ 'save'（名前を付けて保存）
async function openFileDialog(mode = 'open') {
  if (mode === 'save' && !S.doc) return;
  if (mode === 'save') exitEdit();
  const dlg = $('#openDlg');
  const save = mode === 'save';
  OD.mode = mode;
  OD.selected = null;
  $('#openTitle').textContent = save ? '名前を付けて保存' : 'ファイルを開く';
  $('#openOk').textContent = save ? '保存' : '開く';
  $('#openNote').textContent = save
    ? '保存先のフォルダを選び、ファイル名を入力してください。別のフォルダに保存すると、使っている画像なども一緒にコピーします。'
    : 'HTMLファイルとフォルダのみ表示。ダブルクリックで開きます。';
  $('#saveRow').hidden = !save;
  if (save) $('#saveNameInput').value = baseName(S.file);
  updateOkButton();
  // 最近使ったファイル（保存時はそのフォルダへ移動）
  const recent = $('#openRecent');
  recent.innerHTML = '';
  const list = getRecent();
  if (!list.length) recent.innerHTML = '<div class="note" style="padding:4px 8px">まだありません</div>';
  list.forEach(p => recent.append(sideItem(baseName(p), dirName(p), () => (OD.mode === 'save' ? browse(dirName(p)) : tryOpen(p)))));
  // 場所とドライブ
  try {
    const { places, drives } = await (await fetch('/api/places')).json();
    $('#openPlaces').replaceChildren(...places.map(pl => sideItem(pl.name, null, () => browse(pl.path))));
    $('#openDrives').replaceChildren(...drives.map(d => sideItem(d, null, () => browse(d))));
    $('#drivesTitle').hidden = !drives.length;
  } catch { /* 場所が取れなくても一覧からたどれる */ }
  $('#openNative').hidden = S.info && !S.info.isWin;
  if (!dlg.open) dlg.showModal();
  await browse(S.file ? dirName(S.file) : (OD.dir ?? S.info?.defaultDir ?? ''));
  if (save) { const inp = $('#saveNameInput'); inp.focus(); inp.setSelectionRange(0, inp.value.replace(/\.html?$/i, '').length); }
}

function updateOkButton() {
  $('#openOk').disabled = OD.mode === 'save'
    ? !OD.dir || !$('#saveNameInput').value.trim()
    : !OD.selected;
}

// 保存ダイアログの「保存」：入力された名前で現在のフォルダに保存
function saveTargetPath() {
  let name = $('#saveNameInput').value.trim().replace(/^"|"$/g, '');
  if (!name) return null;
  if (!/\.html?$/i.test(name)) name += '.html';
  if (/^[A-Za-z]:[\\/]|^[\\/]/.test(name)) return name;          // フルパスが入力された場合
  const sep = S.info?.sep || '/';
  return OD.dir.replace(/[\\/]+$/, '') + sep + name;
}

async function doSaveAs(target, overwrite = false) {
  if (!target) return false;
  if (!/\.html?$/i.test(target)) target += '.html';
  exitEdit();
  setStatus('保存中…');
  let r;
  try {
    r = await (await fetch('/api/saveas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: S.file, to: target, html: exportHtml(), overwrite }),
    })).json();
    if (r.exists) {
      if (!confirm(`「${baseName(r.path)}」は既にあります。上書きしますか？`)) { setStatus('保存を中止しました'); return false; }
      return doSaveAs(target, true);
    }
    if (!r.ok) throw new Error(r.error);
  } catch (err) {
    setStatus('保存に失敗しました: ' + err.message, 'err');
    alert('保存に失敗しました: ' + err.message);
    return false;
  }
  $('#openDlg').close();
  if (r.rewritten > 0) {
    // 画像などの参照パスを書き換えたので、保存したファイルを開き直す
    S.dirty = false;
    await loadFile(r.path);
  } else {
    S.file = r.path;
    S.dirty = false;
    S.doc.getElementById('ed-base').href = new URL(fsUrl(r.path), location.origin).href;
    document.title = 'HTMLスライドエディター - ' + baseName(r.path);
    history.replaceState(null, '', '?file=' + encodeURIComponent(r.path));
    $('#fileName').textContent = baseName(r.path);
    $('#fileName').title = r.path;
    addRecent(r.path);
  }
  const notes = [];
  if (r.copied) notes.push(`画像など${r.copied}件をコピー`);
  if (r.rewritten) notes.push(`参照パス${r.rewritten}件を調整`);
  setStatus(`「${baseName(r.path)}」に保存しました` + (notes.length ? `（${notes.join('、')}）` : ''), 'ok');
  if (r.missing?.length) alert('次のファイルは見つからない、またはコピーできませんでした。保存先で表示されない可能性があります:\n' + r.missing.slice(0, 15).join('\n'));
  return true;
}

async function browse(dir) {
  const box = $('#openList');
  box.innerHTML = '<div class="fs-empty">読み込み中…</div>';
  let r;
  try {
    r = await (await fetch('/api/ls?dir=' + encodeURIComponent(dir || ''))).json();
    if (r.error) throw new Error(r.error);
  } catch (err) {
    box.innerHTML = '';
    const msg = document.createElement('div'); msg.className = 'fs-empty';
    msg.textContent = 'フォルダを開けません: ' + err.message;
    box.append(msg);
    return;
  }
  Object.assign(OD, { dir: r.dir, parent: r.parent, selected: null });
  updateOkButton();
  $('#openPathInput').value = r.dir || 'PC（ドライブ一覧）';
  $('#openUp').disabled = r.parent == null;
  box.innerHTML = '';
  if (!r.entries.length) box.innerHTML = '<div class="fs-empty">HTMLファイルもフォルダもありません</div>';
  for (const e of r.entries) {
    const row = document.createElement('div');
    row.className = 'fs-row ' + e.type;
    row.innerHTML = `<span class="ic">${e.type === 'dir' ? '📁' : '📄'}</span><span class="nm"></span><span class="dt"></span>`;
    row.querySelector('.nm').textContent = e.name;
    if (e.mtime) row.querySelector('.dt').textContent = new Date(e.mtime).toLocaleString();
    row.onclick = () => {
      box.querySelectorAll('.sel').forEach(n => n.classList.remove('sel'));
      row.classList.add('sel');
      OD.selected = e;
      if (OD.mode === 'save' && e.type === 'html') $('#saveNameInput').value = e.name;
      updateOkButton();
    };
    row.ondblclick = () => {
      if (e.type === 'dir') browse(e.path);
      else if (OD.mode === 'save') doSaveAs(e.path);
      else tryOpen(e.path);
    };
    box.append(row);
  }
}

async function tryOpen(p) {
  if (S.dirty && !confirm('未保存の変更があります。破棄して別のファイルを開きますか？')) return;
  const r = await fileExists(p);
  if (!r.exists) { alert('ファイルが見つかりません:\n' + p); removeRecent(p); openFileDialog(); return; }
  if (await loadFile(r.path)) $('#openDlg').close();
}

async function pickNative() {
  const btn = $('#openNative');
  btn.disabled = true;
  btn.textContent = 'ダイアログを表示中…（タスクバーも確認してください）';
  try {
    const save = OD.mode === 'save';
    const r = await (await fetch('/api/pick', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialDir: OD.dir || '', mode: OD.mode, fileName: save ? $('#saveNameInput').value : '' }),
    })).json();
    if (r.error) throw new Error(r.error);
    // Windowsの保存ダイアログは上書き確認済み
    if (r.path) await (save ? doSaveAs(r.path, true) : tryOpen(r.path));
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Windowsのダイアログで選ぶ…';
  }
}

function collectSlides() {
  S.slides = [...S.doc.querySelectorAll('.slide')].filter(s => !s.parentElement.closest('.slide'));
}

function fitStage() {
  if (!S.doc) return;
  const r = $('#stageWrap').getBoundingClientRect();
  S.scale = Math.max(0.1, Math.min((r.width - 48) / SW, (r.height - 60) / SH));
  S.doc.getElementById('ed-scale').textContent = `:root{--scale:${S.scale}}`;
  requestAnimationFrame(updateOverlay);
}

function showSlide(i) {
  if (!S.slides.length) return;
  exitEdit();
  S.cur = clamp(i, 0, S.slides.length - 1);
  S.slides.forEach((s, k) => s.classList.toggle('ed-show', k === S.cur));
  $$('.thumb').forEach((t, k) => t.classList.toggle('active', k === S.cur));
  $$('.thumb')[S.cur]?.scrollIntoView({ block: 'nearest' });
  select(null);
}

// ---------------------------------------------------------------- 書き出し用HTML
// opts.thumb: サムネイル用（指定スライドのみ表示、スクリプト除去）
// opts.only : 1始まりのページ番号配列。これ以外のスライドを削除する
function exportHtml(opts = {}) {
  const thumb = opts.thumb ?? null;
  const root = S.doc.documentElement.cloneNode(true);
  root.querySelector('#ed-style')?.remove();
  root.querySelector('#ed-scale')?.remove();
  if (thumb === null) root.querySelector('#ed-base')?.remove();
  root.querySelectorAll('[contenteditable]').forEach(n => { n.removeAttribute('contenteditable'); n.removeAttribute('spellcheck'); });
  root.querySelectorAll('[data-ed-orig-style]').forEach(n => n.removeAttribute('data-ed-orig-style'));
  root.querySelectorAll('script[data-ed-type]').forEach(s => {
    if (thumb !== null) { s.remove(); return; }
    const t = s.getAttribute('data-ed-type');
    s.removeAttribute('data-ed-type');
    if (t === '__none__') s.removeAttribute('type'); else s.setAttribute('type', t);
  });
  let slides = [...root.querySelectorAll('.slide')].filter(s => !s.parentElement.closest('.slide'));
  const usesCur = slides.some(s => s.classList.contains('cur'));
  slides.forEach(s => s.classList.remove('ed-show', 'cur'));
  if (opts.only) {
    slides = slides.filter((s, i) => opts.only.includes(i + 1) || (s.remove(), false));
  }
  // 最初のスライドだけを表示中(cur)にする（元のスクリプトの前提に合わせる）
  if (usesCur && slides[0]) slides[0].classList.add('cur');
  if (thumb !== null) {
    const st = root.ownerDocument.createElement('style');
    st.textContent = THUMB_CSS;
    root.querySelector('head').append(st);
    slides[thumb]?.classList.add('ed-show');
  }
  root.querySelectorAll('[class=""]').forEach(n => n.removeAttribute('class'));
  root.querySelectorAll('[style=""]').forEach(n => n.removeAttribute('style'));
  return '<!doctype html>\n' + root.outerHTML + '\n';
}

// ---------------------------------------------------------------- サムネイル
function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  S.slides.forEach((_, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (i === S.cur ? ' active' : '');
    t.innerHTML = `<div class="num">${i + 1}</div><div class="frame"><iframe tabindex="-1" loading="lazy"></iframe></div>`;
    t.onclick = () => showSlide(i);
    box.append(t);
    updateThumb(i);
  });
}
function updateThumb(i) {
  const f = $$('.thumb iframe')[i];
  if (f) f.srcdoc = exportHtml({ thumb: i });
}
let thumbTimer = null;
function scheduleThumb() {
  clearTimeout(thumbTimer);
  const i = S.cur;
  thumbTimer = setTimeout(() => updateThumb(i), 500);
}

// 変更があったときの共通処理
function changed() {
  markDirty();
  scheduleThumb();
  updateOverlay();
}

// ---------------------------------------------------------------- 履歴（元に戻す）
function snapshot() {
  return { html: S.doc.body.innerHTML, cur: S.cur, path: pathOf(S.sel) };
}
function pathOf(el) {
  if (!el) return null;
  const p = [];
  while (el && el !== S.doc.body) { p.unshift([...el.parentElement.children].indexOf(el)); el = el.parentElement; }
  return p;
}
function fromPath(p) {
  if (!p) return null;
  let el = S.doc.body;
  for (const i of p) { el = el?.children[i]; }
  return el || null;
}
// key が同じ操作が1秒以内に続く場合は1つの履歴にまとめる（色のドラッグ等）
function pushHistory(key = null) {
  const now = Date.now();
  if (key && S.coalesce.key === key && now - S.coalesce.t < 1000) { S.coalesce.t = now; return; }
  S.coalesce = { key, t: now };
  S.undo.push(snapshot());
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
}
function restore(snap) {
  S.editing = null; S.savedRange = null;
  hit.style.pointerEvents = '';
  S.doc.body.innerHTML = snap.html;
  S.doc.querySelectorAll('[contenteditable]').forEach(n => { n.removeAttribute('contenteditable'); n.removeAttribute('spellcheck'); });
  collectSlides();
  S.cur = clamp(snap.cur, 0, S.slides.length - 1);
  S.slides.forEach((s, k) => s.classList.toggle('ed-show', k === S.cur));
  renderThumbs();
  S.coalesce = { key: null, t: 0 };
  select(fromPath(snap.path));
  markDirty();
}
function undo() {
  exitEdit();
  if (!S.undo.length) return;
  S.redo.push(snapshot());
  restore(S.undo.pop());
}
function redo() {
  exitEdit();
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  restore(S.redo.pop());
}

// ---------------------------------------------------------------- 選択と枠表示
function select(el) {
  S.sel = el;
  hoverBox.hidden = true;
  updateOverlay();
  updatePanel();
}

function frameRect() { return stage.getBoundingClientRect(); }
function screenRect(el) {
  const r = el.getBoundingClientRect(), f = frameRect();
  return { x: r.left + f.left, y: r.top + f.top, w: r.width, h: r.height };
}
// スライド左上を原点とした論理座標（px）
function slideCoords(el) {
  const r = el.getBoundingClientRect(), s = curSlide().getBoundingClientRect();
  return { x: (r.left - s.left) / S.scale, y: (r.top - s.top) / S.scale, w: r.width / S.scale, h: r.height / S.scale };
}
function placeBox(box, r) {
  Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  box.hidden = false;
}

function describe(el) {
  if (el.classList.contains('ed-shape')) {
    const kind = [...el.classList].find(c => c.startsWith('ed-') && c !== 'ed-shape')?.slice(3);
    return { text: 'テキスト', rect: '四角形', round: '角丸四角形', ellipse: '楕円', triangle: '三角形', line: '直線', arrow: '矢印' }[kind] || '図形';
  }
  if (el.tagName === 'IMG') return '画像';
  const cls = [...el.classList].filter(c => !c.startsWith('ed-'))[0];
  return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
}

function updateOverlay() {
  if (S.sel && !S.sel.isConnected) S.sel = null;
  if (!S.sel || !S.doc) { selBox.hidden = true; return; }
  const r = screenRect(S.sel);
  placeBox(selBox, r);
  selBox.classList.toggle('editing', !!S.editing);
  const c = slideCoords(S.sel);
  $('#selLabel').textContent = `${describe(S.sel)}  ${Math.round(c.w)}×${Math.round(c.h)}`;
}

// 座標からスライド内の要素を取得（SVG内部や改行は外側の要素に寄せる）
function pick(clientX, clientY) {
  if (!S.doc) return null;
  const f = frameRect();
  let el = S.doc.elementFromPoint(clientX - f.left, clientY - f.top);
  const slide = curSlide();
  if (!el || !slide || el === slide || !slide.contains(el)) return null;
  const shape = el.closest('.ed-shape');
  if (shape && (shape.classList.contains('ed-line') || shape.classList.contains('ed-arrow'))) return shape;
  let svg = el.closest('svg');
  while (svg && svg.parentElement?.closest('svg')) svg = svg.parentElement.closest('svg');
  if (svg) el = svg;
  if (el.tagName === 'BR') el = el.parentElement;
  return el === slide ? null : el;
}
// anc の直下の子のうち、t を含むもの
function childToward(anc, t) {
  while (t && t.parentElement !== anc) t = t.parentElement;
  return t;
}
// クリックで選択される要素（PowerPoint同様、同じ階層を維持する）
function clickTarget(t) {
  const sel = S.sel, slide = curSlide();
  if (sel && (sel === t || sel.contains(t))) return sel;
  if (sel && sel.parentElement && sel.parentElement !== slide && sel.parentElement.contains(t)) return childToward(sel.parentElement, t);
  return childToward(slide, t);
}

// ---------------------------------------------------------------- 移動・リサイズ
// 要素を left/top で動かせる状態にし、現在の left/top を返す
function prepareMove(el) {
  const c = cs(el);
  if (c.position === 'absolute' || c.position === 'fixed') {
    const left = el.offsetLeft - (parseFloat(c.marginLeft) || 0);
    const top = el.offsetTop - (parseFloat(c.marginTop) || 0);
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!el.style.width) el.style.width = w + 'px';      // 位置を変えても折り返しが変わらないよう固定
    Object.assign(el.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
    // top と bottom の両方で高さが決まっていた要素（inset:0 など）だけ高さを固定する
    if (el.offsetHeight !== h && !el.style.height) el.style.height = h + 'px';
    return { left, top };
  }
  if (c.position === 'static') el.style.position = 'relative';
  return { left: parseFloat(c.left) || 0, top: parseFloat(c.top) || 0 };
}

function snapCandidates(el) {
  const xs = [0, SW / 2, SW], ys = [0, SH / 2, SH];
  const others = new Set([...curSlide().children, ...(el.parentElement ? el.parentElement.children : [])]);
  for (const o of others) {
    if (o === el || o.contains(el) || el.contains(o)) continue;
    const c = slideCoords(o);
    if (!c.w || !c.h) continue;
    xs.push(c.x, c.x + c.w / 2, c.x + c.w);
    ys.push(c.y, c.y + c.h / 2, c.y + c.h);
  }
  return { xs, ys };
}
function snapDelta(base, dx, dy, C) {
  const th = 6 / S.scale;
  const best = (vals, cands) => {
    let b = null;
    for (const v of vals) for (const c of cands) {
      const d = c - v;
      if (Math.abs(d) < th && (!b || Math.abs(d) < Math.abs(b.d))) b = { d, c };
    }
    return b;
  };
  const bx = best([base.x + dx, base.x + dx + base.w / 2, base.x + dx + base.w], C.xs);
  const by = best([base.y + dy, base.y + dy + base.h / 2, base.y + dy + base.h], C.ys);
  return { dx: dx + (bx ? bx.d : 0), dy: dy + (by ? by.d : 0), gx: bx?.c, gy: by?.c };
}
function showGuides(gx, gy) {
  const s = curSlide().getBoundingClientRect(), f = frameRect();
  const gv = $('#guideV'), gh = $('#guideH');
  if (gx != null) Object.assign(gv.style, { left: f.left + s.left + gx * S.scale + 'px', top: f.top + s.top + 'px', height: s.height + 'px' });
  if (gy != null) Object.assign(gh.style, { top: f.top + s.top + gy * S.scale + 'px', left: f.left + s.left + 'px', width: s.width + 'px' });
  gv.hidden = gx == null; gh.hidden = gy == null;
}
function hideGuides() { $('#guideV').hidden = true; $('#guideH').hidden = true; }

function dragSession(cursor, onMove, onUp) {
  shield.hidden = false; shield.style.cursor = cursor;
  const move = ev => onMove(ev);
  const up = ev => {
    shield.hidden = true;
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    hideGuides();
    onUp(ev);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function startMove(e, el, onClick) {
  const sx = e.clientX, sy = e.clientY;
  let moved = false, prep, base, cands;
  dragSession('move', ev => {
    if (!moved) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      pushHistory();
      prep = prepareMove(el); base = slideCoords(el); cands = snapCandidates(el);
    }
    let dx = (ev.clientX - sx) / S.scale, dy = (ev.clientY - sy) / S.scale;
    if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (!ev.altKey) {
      const s = snapDelta(base, dx, dy, cands);
      if (!ev.shiftKey || dx) dx = s.dx;
      if (!ev.shiftKey || dy) dy = s.dy;
      showGuides(s.gx, s.gy);
    } else hideGuides();
    el.style.left = Math.round(prep.left + dx) + 'px';
    el.style.top = Math.round(prep.top + dy) + 'px';
    updateOverlay();
  }, () => {
    if (!moved) onClick?.();
    else { changed(); updatePanel(); }
  });
}

function startResize(e, dir) {
  const el = S.sel;
  if (!el) return;
  e.stopPropagation(); e.preventDefault();
  pushHistory();
  const prep = prepareMove(el);
  const c0 = slideCoords(el);
  const w0 = el.offsetWidth || c0.w, h0 = el.offsetHeight || c0.h, ratio = w0 / h0;
  const keepRatio = el.tagName === 'IMG';
  const sx = e.clientX, sy = e.clientY;
  dragSession(getComputedStyle(e.target).cursor, ev => {
    const dx = (ev.clientX - sx) / S.scale, dy = (ev.clientY - sy) / S.scale;
    let w = w0, h = h0;
    if (dir.includes('e')) w = w0 + dx;
    if (dir.includes('w')) w = w0 - dx;
    if (dir.includes('s')) h = h0 + dy;
    if (dir.includes('n')) h = h0 - dy;
    w = Math.max(8, w); h = Math.max(8, h);
    if (keepRatio || ev.shiftKey) {
      if (dir.length === 2) { if (w / h > ratio) h = w / ratio; else w = h * ratio; }
      else if (dir === 'e' || dir === 'w') h = w / ratio;
      else w = h * ratio;
    }
    const setW = dir !== 'n' && dir !== 's' || keepRatio || ev.shiftKey;
    const setH = dir !== 'e' && dir !== 'w' || keepRatio || ev.shiftKey;
    if (setW) el.style.width = Math.round(w) + 'px';
    if (setH) el.style.height = Math.round(h) + 'px';
    el.style.left = Math.round(dir.includes('w') ? prep.left + (w0 - w) : prep.left) + 'px';
    el.style.top = Math.round(dir.includes('n') ? prep.top + (h0 - h) : prep.top) + 'px';
    updateOverlay();
  }, () => { changed(); updatePanel(); });
}

// ---------------------------------------------------------------- 文字の直接編集
function canEditText(el) {
  return el && !el.matches('img,svg,hr,iframe,video,canvas') && !el.classList.contains('ed-line') && !el.classList.contains('ed-arrow');
}
function enterEdit(el, x, y) {
  if (!canEditText(el)) return;
  exitEdit();
  pushHistory();
  S.editing = el;
  el.setAttribute('contenteditable', 'true');
  el.setAttribute('spellcheck', 'false');
  hit.style.pointerEvents = 'none';
  hoverBox.hidden = true;
  stage.focus();
  el.focus();
  const sel = S.win.getSelection();
  let r = null;
  if (x != null) { const f = frameRect(); r = S.doc.caretRangeFromPoint(x - f.left, y - f.top); }
  if (!r || !el.contains(r.startContainer)) { r = S.doc.createRange(); r.selectNodeContents(el); }
  sel.removeAllRanges(); sel.addRange(r);
  S.sel = el;
  updateOverlay(); updatePanel();
}
function exitEdit() {
  const el = S.editing;
  if (!el) return;
  el.removeAttribute('contenteditable');
  el.removeAttribute('spellcheck');
  S.editing = null; S.savedRange = null;
  hit.style.pointerEvents = '';
  S.win.getSelection().removeAllRanges();
  changed(); updatePanel();
}
// 編集中に選択している文字範囲（パネル操作でフォーカスが外れても保持）
function editRange() {
  if (!S.editing) return null;
  const ok = r => r && !r.collapsed && S.editing.contains(r.commonAncestorContainer);
  const sel = S.win.getSelection();
  const r = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (ok(r)) return r;
  return ok(S.savedRange) ? S.savedRange : null;
}
// 選択範囲を span で囲んでスタイルを付ける
function styleRange(r, styles) {
  const sc = r.startContainer;
  let span;
  // すでにこの範囲を囲む span があれば、それを書き換える（入れ子が増えないように）
  if (sc === r.endContainer && sc.nodeType === 1 && sc.tagName === 'SPAN' && r.startOffset === 0 && r.endOffset === sc.childNodes.length) {
    span = sc;
  } else {
    const frag = r.extractContents();
    frag.querySelectorAll('*').forEach(n => { for (const k in styles) n.style[k] = ''; if (!n.getAttribute('style')) n.removeAttribute('style'); });
    span = S.doc.createElement('span');
    span.append(frag);
    r.insertNode(span);
  }
  Object.assign(span.style, styles);
  const nr = S.doc.createRange();
  nr.selectNodeContents(span);
  S.savedRange = nr;
  const sel = S.win.getSelection();
  sel.removeAllRanges(); sel.addRange(nr);
  changed();
}
function rangeStyle(r) {
  const n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  return cs(n);
}

// ---------------------------------------------------------------- プロパティパネル
function setVal(sel, v) {
  const el = $(sel);
  if (document.activeElement === el) return;
  if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
}
function updatePanel() {
  const el = S.sel;
  $('#propsEmpty').hidden = !!el;
  $('#propsElem').hidden = !el;
  if (!S.doc) return;
  if (!el) {
    if (curSlide()) setVal('#slideBg', toHex(cs(curSlide()).backgroundColor));
    return;
  }
  const c = cs(el), r = slideCoords(el);
  $('#elemTitle').textContent = describe(el);
  setVal('#pX', Math.round(r.x)); setVal('#pY', Math.round(r.y));
  setVal('#pW', Math.round(r.w)); setVal('#pH', Math.round(r.h));
  setVal('#pRot', parseFloat(el.style.rotate) || 0);
  const fs = parseFloat(c.fontSize);
  setVal('#pFontSize', round1(fs));
  setVal('#pColor', toHex(c.color));
  setVal('#pLineHeight', c.lineHeight === 'normal' ? '' : round1(parseFloat(c.lineHeight) / fs * 10) / 10);
  const noBg = isTransparent(c.backgroundColor) && c.backgroundImage === 'none';
  setVal('#pBgNone', noBg);
  setVal('#pBg', noBg ? '#ffffff' : toHex(c.backgroundColor));
  const isLine = el.classList.contains('ed-line') || el.classList.contains('ed-arrow');
  setVal('#pBorderColor', toHex(isLine ? c.color : c.borderTopColor));
  setVal('#pBorderWidth', isLine ? parseFloat(el.querySelector('line')?.getAttribute('stroke-width')) || 0 : parseFloat(c.borderTopWidth) || 0);
  setVal('#pRadius', parseFloat(c.borderTopLeftRadius) || 0);
  setVal('#pOpacity', c.opacity);
  $('#pOpacityVal').textContent = Math.round(c.opacity * 100) + '%';
  $('#imgFs').hidden = el.tagName !== 'IMG';
  $('#textScope').textContent = S.editing ? '（選択した文字に適用）' : (el.children.length ? '（内側の要素にも適用）' : '');
  $('#bBold').classList.toggle('on', parseInt(c.fontWeight) >= 600);
  $('#bItalic').classList.toggle('on', c.fontStyle === 'italic');
  $('#bUnderline').classList.toggle('on', c.textDecorationLine.includes('underline'));
  $$('[data-align]').forEach(b => b.classList.toggle('on', c.textAlign === b.dataset.align || (b.dataset.align === 'left' && c.textAlign === 'start')));
  $('#bParent').disabled = !el.parentElement || el.parentElement === curSlide();
  $('#bEditText').disabled = !canEditText(el);
  $('#bResetStyle').disabled = el.classList.contains('ed-shape') || el.tagName === 'IMG' && el.classList.contains('ed-image');
}

// 文字系のスタイルは、選択要素の内側の要素にもまとめて適用する
const textTargets = el => [el, ...el.querySelectorAll('*')].filter(n => n === el || !n.closest('svg'));

function applyToSel(key, fn) {
  const el = S.sel;
  if (!el) return;
  pushHistory(key);
  fn(el);
  changed();
  updatePanel();
}

function setFontSize(size) {
  size = clamp(Number(size) || 0, 4, 400);
  const r = editRange();
  if (r) { pushHistory('fs-range'); styleRange(r, { fontSize: size + 'px' }); return; }
  applyToSel('fs', el => {
    const ratio = size / parseFloat(cs(el).fontSize);
    const nodes = textTargets(el);
    const sizes = nodes.map(n => parseFloat(cs(n).fontSize));
    nodes.forEach((n, i) => { n.style.fontSize = round1(sizes[i] * ratio) + 'px'; });
  });
}
function toggleTextStyle(prop, onVal, offVal, isOn) {
  const r = editRange();
  if (r) { pushHistory(); styleRange(r, { [prop]: isOn(rangeStyle(r)) ? offVal : onVal }); updatePanel(); return; }
  applyToSel(null, el => {
    const v = isOn(cs(el)) ? offVal : onVal;
    if (prop === 'textDecoration') el.style.textDecoration = v;
    else textTargets(el).forEach(n => { n.style[prop] = v; });
  });
}
function setTextColor(v) {
  const r = editRange();
  if (r) { pushHistory('color-range'); styleRange(r, { color: v }); return; }
  applyToSel('color', el => textTargets(el).forEach(n => { n.style.color = v; }));
}

// ---------------------------------------------------------------- 挿入
function newId() { return 'ed' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function lineSvg(arrow) {
  const id = newId();
  return `<svg width="100%" height="100%" style="display:block;overflow:visible">` +
    (arrow ? `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"></path></marker></defs>` : '') +
    `<line x1="0" y1="50%" x2="100%" y2="50%" stroke="currentColor" stroke-width="3"${arrow ? ` marker-end="url(#${id})"` : ''}></line></svg>`;
}
// 複製時に矢印マーカーのIDが重複しないよう振り直す
function fixIds(root) {
  root.querySelectorAll('marker[id]').forEach(m => {
    const old = m.id, id = newId();
    m.id = id;
    root.querySelectorAll(`[marker-end="url(#${old})"]`).forEach(l => l.setAttribute('marker-end', `url(#${id})`));
  });
}

function insertShape(kind) {
  if (!S.doc) return;
  exitEdit();
  if (kind === 'image') { S.imageMode = 'insert'; $('#imageInput').click(); return; }
  const el = S.doc.createElement('div');
  el.className = `ed-shape ed-${kind}`;
  const shapeText = { display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#ffffff', fontSize: '20px', lineHeight: '1.4', padding: '8px' };
  const presets = {
    text: { width: 400, style: { fontSize: '28px', lineHeight: '1.4', color: '#202020' }, html: 'テキストを入力' },
    rect: { width: 240, height: 140, style: { ...shapeText, background: '#2f5fd0' } },
    round: { width: 240, height: 140, style: { ...shapeText, background: '#2f5fd0', borderRadius: '18px' } },
    ellipse: { width: 200, height: 160, style: { ...shapeText, background: '#2f5fd0', borderRadius: '50%' } },
    triangle: { width: 200, height: 170, style: { ...shapeText, background: '#2f5fd0', clipPath: 'polygon(50% 0,100% 100%,0 100%)', paddingTop: '50px' } },
    line: { width: 300, height: 24, style: { color: '#202020' }, html: lineSvg(false) },
    arrow: { width: 300, height: 24, style: { color: '#202020' }, html: lineSvg(true) },
  };
  const p = presets[kind];
  Object.assign(el.style, { position: 'absolute', left: Math.round((SW - p.width) / 2) + 'px', top: Math.round((SH - (p.height || 40)) / 2) + 'px', width: p.width + 'px', boxSizing: 'border-box' });
  if (p.height) el.style.height = p.height + 'px';
  Object.assign(el.style, p.style);
  el.innerHTML = p.html || '';
  pushHistory();
  curSlide().append(el);
  select(el);
  changed();
  if (kind === 'text') enterEdit(el);
}

async function onImageFile(file) {
  if (!file) return;
  let src;
  try {
    const r = await fetch(`/api/upload?file=${encodeURIComponent(S.file)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
    const j = await r.json();
    if (!j.src) throw new Error(j.error);
    src = j.src;
  } catch (err) {
    // アップロードできない場合はHTMLに埋め込む
    src = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); });
  }
  if (S.imageMode === 'replace' && S.sel?.tagName === 'IMG') {
    applyToSel(null, el => { el.src = src; });
    return;
  }
  const img = S.doc.createElement('img');
  img.className = 'ed-image';
  img.alt = '';
  img.onload = () => {
    const k = Math.min(1, 640 / img.naturalWidth, 400 / img.naturalHeight);
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    Object.assign(img.style, { position: 'absolute', left: Math.round((SW - w) / 2) + 'px', top: Math.round((SH - h) / 2) + 'px', width: w + 'px', height: h + 'px', objectFit: 'contain' });
    img.onload = null;
    select(img); changed();
  };
  pushHistory();
  img.src = src;
  curSlide().append(img);
}

// ---------------------------------------------------------------- 要素操作
function duplicate() {
  const el = S.sel;
  if (!el) return;
  exitEdit();
  pushHistory();
  const c = el.cloneNode(true);
  fixIds(c);
  el.after(c);
  const p = prepareMove(c);
  c.style.left = p.left + 20 + 'px';
  c.style.top = p.top + 20 + 'px';
  select(c); changed();
}
function removeSel() {
  const el = S.sel;
  if (!el) return;
  exitEdit();
  pushHistory();
  el.remove();
  select(null); changed();
}
function copySel() { if (S.sel) S.clipboard = S.sel.outerHTML; }
function paste() {
  if (!S.clipboard || !S.doc) return;
  pushHistory();
  const t = S.doc.createElement('template');
  t.innerHTML = S.clipboard;
  const el = t.content.firstElementChild;
  if (!el) return;
  fixIds(el);
  curSlide().append(el);
  const p = prepareMove(el);
  el.style.left = p.left + 20 + 'px';
  el.style.top = p.top + 20 + 'px';
  S.clipboard = el.outerHTML;
  select(el); changed();
}
function zOrder(front) {
  applyToSel(null, el => {
    if (cs(el).position === 'static') el.style.position = 'relative';
    const zs = [...el.parentElement.children].filter(n => n !== el).map(n => parseInt(cs(n).zIndex) || 0);
    el.style.zIndex = front ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
  });
}
function nudge(dx, dy) {
  applyToSel('nudge', el => {
    const p = prepareMove(el);
    el.style.left = p.left + dx + 'px';
    el.style.top = p.top + dy + 'px';
  });
}
function selectParent() {
  if (S.editing) { exitEdit(); return; }
  if (!S.sel) return;
  const p = S.sel.parentElement;
  select(p && p !== curSlide() && curSlide().contains(p) ? p : null);
}

// ---------------------------------------------------------------- スライド操作
function slideOp(fn) {
  exitEdit();
  pushHistory();
  const idx = fn();
  collectSlides();
  renderThumbs();
  showSlide(idx);
  markDirty();
}
function addSlide(withTitle) {
  slideOp(() => {
    const s = S.doc.createElement('section');
    s.className = 'slide';
    s.innerHTML = withTitle
      ? '\n  <div class="section">セクション名</div><h1 class="title">タイトルを入力</h1><div class="rule"></div>\n'
      : '\n';
    curSlide().after(S.doc.createTextNode('\n\n'), s);
    return S.cur + 1;
  });
}
function dupSlide() {
  slideOp(() => {
    const c = curSlide().cloneNode(true);
    fixIds(c);
    c.classList.remove('cur');
    curSlide().after(S.doc.createTextNode('\n\n'), c);
    return S.cur + 1;
  });
}
function delSlide() {
  if (S.slides.length <= 1) return;
  if (!confirm(`スライド ${S.cur + 1} を削除しますか？（元に戻すで復元できます）`)) return;
  slideOp(() => { curSlide().remove(); return Math.min(S.cur, S.slides.length - 2); });
}
function moveSlide(dir) {
  const j = S.cur + dir;
  if (j < 0 || j >= S.slides.length) return;
  slideOp(() => {
    const a = curSlide(), b = S.slides[j];
    if (dir < 0) b.before(a); else b.after(a);
    return j;
  });
}

// ---------------------------------------------------------------- 保存・エクスポート
async function save() {
  if (!S.doc) return false;
  exitEdit();
  setStatus('保存中…');
  try {
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: S.file, html: exportHtml() }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    S.dirty = false;
    document.title = document.title.replace(/^● /, '');
    setStatus('保存しました（' + new Date().toLocaleTimeString() + '）', 'ok');
    return true;
  } catch (err) {
    setStatus('保存に失敗しました: ' + err.message, 'err');
    return false;
  }
}

// "1,3-5" → [1,3,4,5]
function parsePages(text, max) {
  const set = new Set();
  for (const part of String(text).split(/[,、\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:[-~〜](\d+))?$/);
    if (!m) throw new Error(`ページ指定を読み取れません: "${part}"`);
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (i < 1 || i > max) throw new Error(`ページ ${i} はありません（1〜${max}）`);
      set.add(i);
    }
  }
  if (!set.size) throw new Error('ページを指定してください');
  return [...set].sort((a, b) => a - b);
}

function exportDest() {
  const type = $('input[name=etype]:checked').value;
  const all = $('input[name=escope]:checked').value === 'all';
  const dir = dirName(S.file), sep = S.info?.sep || '/';
  const name = baseName(S.file).replace(/\.html?$/i, '');
  $('#pageFs').hidden = type === 'html' || type === 'saveas';
  $('#sheetRow').hidden = type !== 'png';
  if (type === 'saveas') { $('#eDest').textContent = '「書き出し」を押すと保存先とファイル名を選ぶ画面が開きます。'; return; }
  $('#eDest').textContent = '出力先: ' + (type === 'html' ? S.file
    : type === 'pdf' ? `${dir}${sep}${all ? name : name + '_p(ページ)'}.pdf`
      : `${dir}${sep}review${sep}slide-NN.png` + (all ? '（既存の slide-*.png は置き換え）' : ''));
}
function openExport() {
  if (!S.doc) return;
  exitEdit();
  $('#eResult').textContent = ''; $('#eResult').className = '';
  exportDest();
  $('#exportDlg').showModal();
}
async function runExport() {
  const type = $('input[name=etype]:checked').value;
  const all = $('input[name=escope]:checked').value === 'all';
  const out = $('#eResult');
  const btn = $('#eRun');
  out.className = '';
  if (type === 'saveas') {
    $('#exportDlg').close();
    openFileDialog('save');
    return;
  }
  if (type === 'html') {
    const ok = await save();
    out.className = ok ? 'ok' : 'err';
    out.textContent = ok ? '上書き保存しました: ' + S.file : $('#status').textContent;
    return;
  }
  let pages;
  try {
    pages = all ? S.slides.map((_, i) => i + 1) : parsePages($('#ePages').value, S.slides.length);
  } catch (err) { out.className = 'err'; out.textContent = err.message; return; }
  const body = { file: S.file, type, all, pages, contactSheet: $('#eSheet').checked };
  if (type === 'pdf') body.html = exportHtml({ only: all ? null : pages });
  else body.htmlPages = pages.map(n => ({ n, html: exportHtml({ only: [n] }) }));
  btn.disabled = true;
  out.textContent = '書き出し中…（Chromeで描画しています）';
  setStatus('書き出し中…');
  try {
    const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    out.className = 'ok';
    out.textContent = '書き出しました:\n' + j.outputs.join('\n');
    setStatus(`${type.toUpperCase()} を書き出しました（${j.outputs.length}件）`, 'ok');
  } catch (err) {
    out.className = 'err';
    out.textContent = '失敗しました: ' + err.message;
    setStatus('書き出しに失敗しました', 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- キーボード
function onKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); e.shiftKey ? openFileDialog('save') : save(); return; }
  if (mod && k === 'e') { e.preventDefault(); openExport(); return; }
  if (mod && k === 'o') { e.preventDefault(); openFileDialog('open'); return; }
  if ($('#exportDlg').open || $('#openDlg').open) return;
  if (S.editing) {
    if (e.key === 'Escape') { e.preventDefault(); exitEdit(); }
    return;
  }
  const t = e.target;
  if (t.ownerDocument === document && t.matches?.('input,select,textarea')) return;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
  if (mod && k === 'c') { copySel(); return; }
  if (mod && k === 'v') { e.preventDefault(); paste(); return; }
  if (e.key === 'Escape') { selectParent(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel) { e.preventDefault(); removeSel(); } return; }
  if ((e.key === 'Enter' || e.key === 'F2') && S.sel) { e.preventDefault(); enterEdit(S.sel); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    e.preventDefault();
    if (S.sel) { const [x, y] = arrows[e.key], n = e.shiftKey ? 10 : 1; nudge(x * n, y * n); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') showSlide(S.cur - 1);
    else showSlide(S.cur + 1);
    return;
  }
  if (!S.sel && (e.key === 'PageUp' || e.key === 'PageDown')) { e.preventDefault(); showSlide(S.cur + (e.key === 'PageUp' ? -1 : 1)); }
}

// ---------------------------------------------------------------- イベント登録
function bindFrame() {
  const d = S.doc;
  d.addEventListener('keydown', onKey);
  d.addEventListener('mousedown', e => { if (S.editing && !S.editing.contains(e.target)) exitEdit(); });
  d.addEventListener('input', () => { markDirty(); scheduleThumb(); updateOverlay(); });
  d.addEventListener('selectionchange', () => {
    const sel = S.win.getSelection();
    if (S.editing && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (!r.collapsed && S.editing.contains(r.commonAncestorContainer)) S.savedRange = r.cloneRange();
    }
  });
  // 貼り付けは書式なしテキストのみ
  d.addEventListener('paste', e => {
    if (!S.editing) return;
    e.preventDefault();
    d.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
}

function bindUI() {
  // 選択・移動
  hit.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !S.doc) return;
    document.activeElement?.blur?.();
    const t = pick(e.clientX, e.clientY);
    if (!t) { select(null); return; }
    const prev = S.sel;
    const target = clickTarget(t);
    const drill = prev && prev === target && target !== t;
    if (target !== prev) select(target);
    startMove(e, target, () => { if (drill) select(childToward(target, t)); });
  });
  hit.addEventListener('dblclick', e => {
    const t = pick(e.clientX, e.clientY);
    if (t && S.sel && S.sel.contains(t)) enterEdit(S.sel, e.clientX, e.clientY);
  });
  hit.addEventListener('pointermove', e => {
    const t = pick(e.clientX, e.clientY);
    const target = t && clickTarget(t);
    if (!target || target === S.sel) { hoverBox.hidden = true; return; }
    placeBox(hoverBox, screenRect(target));
  });
  hit.addEventListener('pointerleave', () => { hoverBox.hidden = true; });
  hit.addEventListener('wheel', e => {
    // ホイールでスライド送り（選択中は無効）
    if (S.sel || Math.abs(e.deltaY) < 30) return;
    showSlide(S.cur + Math.sign(e.deltaY));
  }, { passive: true });
  selBox.querySelectorAll('.h').forEach(h => h.addEventListener('pointerdown', e => startResize(e, h.dataset.h)));

  addEventListener('keydown', onKey);
  addEventListener('resize', fitStage);
  new ResizeObserver(fitStage).observe($('#stageWrap'));
  addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ツールバー
  $('#btnOpen').onclick = () => openFileDialog('open');
  $('#btnSaveAs').onclick = () => openFileDialog('save');
  $('#saveNameInput').addEventListener('input', updateOkButton);
  $('#saveNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#openOk').click(); } });
  $('#openUp').onclick = () => OD.parent != null && browse(OD.parent);
  const goPath = async () => {
    const v = $('#openPathInput').value.trim().replace(/^"|"$/g, '');
    if (/\.html?$/i.test(v)) tryOpen(v); else browse(v);
  };
  $('#openGo').onclick = goPath;
  $('#openPathInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); goPath(); } });
  $('#openOk').onclick = () => {
    if (OD.mode === 'save') {
      // フォルダを選んだ状態で「保存」を押したら、まずそのフォルダへ移動
      if (OD.selected?.type === 'dir') browse(OD.selected.path);
      else doSaveAs(saveTargetPath());
      return;
    }
    if (OD.selected) OD.selected.type === 'dir' ? browse(OD.selected.path) : tryOpen(OD.selected.path);
  };
  $('#openCancel').onclick = () => $('#openDlg').close();
  $('#openNative').onclick = pickNative;
  $('#openList').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#openOk').click();
    if (e.key === 'Backspace' && OD.parent != null) { e.preventDefault(); browse(OD.parent); }
  });
  $('#btnSave').onclick = save;
  $('#btnExport').onclick = openExport;
  $('#btnPreview').onclick = async () => {
    if (S.dirty && confirm('未保存の変更があります。保存してから再生しますか？')) await save();
    if (S.file) open(fsUrl(S.file) + '?t=' + Date.now(), '_blank');
  };
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $$('[data-insert]').forEach(b => { b.onclick = () => insertShape(b.dataset.insert); });
  $('#imageInput').addEventListener('change', e => { onImageFile(e.target.files[0]); e.target.value = ''; });
  $('#btnDup').onclick = duplicate;
  $('#btnDelete').onclick = removeSel;
  $('#btnFront').onclick = () => zOrder(true);
  $('#btnBack').onclick = () => zOrder(false);

  // スライド
  $('#btnAddSlide').onclick = () => addSlide(false);
  $('#btnAddTitleSlide').onclick = () => addSlide(true);
  $('#btnDupSlide').onclick = dupSlide;
  $('#btnDelSlide').onclick = delSlide;
  $('#btnSlideUp').onclick = () => moveSlide(-1);
  $('#btnSlideDown').onclick = () => moveSlide(1);
  $('#slideBg').addEventListener('input', e => {
    pushHistory('slidebg');
    curSlide().style.background = e.target.value;
    changed();
  });

  // 位置とサイズ
  const posField = (id, fn) => $(id).addEventListener('change', e => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    applyToSel(null, el => fn(el, v));
  });
  posField('#pX', (el, v) => { const r = slideCoords(el), p = prepareMove(el); el.style.left = Math.round(p.left + v - r.x) + 'px'; });
  posField('#pY', (el, v) => { const r = slideCoords(el), p = prepareMove(el); el.style.top = Math.round(p.top + v - r.y) + 'px'; });
  posField('#pW', (el, v) => { prepareMove(el); el.style.width = Math.max(1, v) + 'px'; });
  posField('#pH', (el, v) => { prepareMove(el); el.style.height = Math.max(1, v) + 'px'; });
  posField('#pRot', (el, v) => { el.style.rotate = v ? v + 'deg' : ''; });

  // 文字
  $('#pFontSize').addEventListener('change', e => setFontSize(e.target.value));
  $('#bSizeUp').onclick = () => setFontSize(Number($('#pFontSize').value) + 2);
  $('#bSizeDown').onclick = () => setFontSize(Number($('#pFontSize').value) - 2);
  $('#pColor').addEventListener('input', e => setTextColor(e.target.value));
  $('#bBold').onclick = () => toggleTextStyle('fontWeight', '700', '400', c => parseInt(c.fontWeight) >= 600);
  $('#bItalic').onclick = () => toggleTextStyle('fontStyle', 'italic', 'normal', c => c.fontStyle === 'italic');
  $('#bUnderline').onclick = () => toggleTextStyle('textDecoration', 'underline', 'none', c => c.textDecorationLine.includes('underline'));
  $$('[data-align]').forEach(b => b.onclick = () => applyToSel(null, el => {
    el.style.textAlign = b.dataset.align;
    if (cs(el).display.includes('flex')) el.style.justifyContent = { left: 'flex-start', right: 'flex-end', center: 'center', justify: 'center' }[b.dataset.align];
  }));
  $('#pLineHeight').addEventListener('change', e => {
    const v = Number(e.target.value);
    if (v > 0) applyToSel(null, el => textTargets(el).forEach(n => { n.style.lineHeight = String(v); }));
  });
  $('#pFont').addEventListener('change', e => {
    const v = e.target.value;
    if (v) applyToSel(null, el => textTargets(el).forEach(n => { n.style.fontFamily = v; }));
    e.target.value = '';
  });

  // 塗りと枠線
  $('#pBg').addEventListener('input', e => { $('#pBgNone').checked = false; applyToSel('bg', el => { el.style.background = e.target.value; }); });
  $('#pBgNone').addEventListener('change', e => applyToSel(null, el => { el.style.background = e.target.checked ? 'transparent' : $('#pBg').value; }));
  $('#pBorderColor').addEventListener('input', e => applyToSel('bc', el => {
    if (el.classList.contains('ed-line') || el.classList.contains('ed-arrow')) { el.style.color = e.target.value; return; }
    if (!parseFloat(cs(el).borderTopWidth)) el.style.border = `2px solid ${e.target.value}`;
    else el.style.borderColor = e.target.value;
  }));
  $('#pBorderWidth').addEventListener('change', e => applyToSel(null, el => {
    const w = Math.max(0, Number(e.target.value) || 0);
    if (el.classList.contains('ed-line') || el.classList.contains('ed-arrow')) { el.querySelector('line')?.setAttribute('stroke-width', w); return; }
    el.style.border = w ? `${w}px solid ${$('#pBorderColor').value}` : 'none';
  }));
  $('#pRadius').addEventListener('change', e => applyToSel(null, el => { el.style.borderRadius = (Number(e.target.value) || 0) + 'px'; }));
  $('#pOpacity').addEventListener('input', e => applyToSel('op', el => { el.style.opacity = e.target.value; }));

  // その他
  $('#bReplaceImg').onclick = () => { S.imageMode = 'replace'; $('#imageInput').click(); };
  $('#bParent').onclick = selectParent;
  $('#bEditText').onclick = () => S.sel && enterEdit(S.sel);
  $('#bResetStyle').onclick = () => applyToSel(null, el => {
    const orig = el.getAttribute('data-ed-orig-style');
    if (orig != null) el.setAttribute('style', orig); else el.removeAttribute('style');
  });

  // パネル操作で文字編集の選択範囲が消えないようにする
  $('#props').addEventListener('mousedown', e => { if (S.editing && e.target.tagName === 'BUTTON') e.preventDefault(); });

  // エクスポート
  $$('input[name=etype],input[name=escope]').forEach(r => r.addEventListener('change', exportDest));
  $('#ePages').addEventListener('focus', () => { $('input[name=escope][value=pick]').checked = true; exportDest(); });
  $('#eRun').onclick = runExport;
}

init();
