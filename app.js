'use strict';

// ============================================================
// 小物
// ============================================================
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const fmt3 = v => (v == null || v === '' || isNaN(v) ? '–' : Number(v).toFixed(3));
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = iso => { if (!iso) return '日付なし'; const [y, m, d] = iso.split('-'); return `${y}/${+m}/${+d}`; };
const numOrNull = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
// 検索用：全角半角・カタカナひらがな・大文字小文字の違いを吸収
const normalize = s => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s+/g, '');

const SONG_FIELDS = ['title', 'kana', 'artist', 'artistKana', 'status', 'progress', 'caution', 'low', 'high', 'recKey', 'ref', 'request', 'memo'];
const SCORE_FIELDS = ['date', 'title', 'point', 'machine', 'on', 'vlt', 'rhythm', 'hyo', 'stab', 'choukan', 'yoku', 'ai', 'bonus', 'comment', 'key'];
// チャートの評価項目（聴感は Ai-Heart＝WAO のみ）。チャート合計はこれらの合計
const CHART = [['on', '音程', '音'], ['vlt', 'ビブラート&ロングトーン', 'ビ'], ['rhythm', 'リズム', 'リ'], ['hyo', '表現力', '表'], ['stab', '安定性', '安'], ['choukan', '聴感', '聴']];
const chartTotal = s => { const v = CHART.map(([k]) => s[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const rawScore = s => (s.point != null && s.bonus != null ? Math.round((s.point - s.bonus) * 1000) / 1000 : null);
const isHeart = m => machineGroup(m) === 'WAO';
const MACHINES = ['Dx', 'Ai', 'WAO', 'JoyAI'];
const machineGroup = m => {
  const s = normalize(m);
  if (!s) return 'その他';
  if (s.startsWith('joy')) return 'JoyAI';
  if (s.startsWith('dx')) return 'Dx';
  if (s.startsWith('ai')) return 'Ai';
  if (s.startsWith('wao')) return 'WAO';
  return m;
};

// 音名（シートと同じ「mid2C(C4)」形式）
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteLabel(midi) {
  const sci = NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
  const prefix = midi < 45 ? 'low' : ['mid1', 'mid2', 'hi', 'hihi', 'hihihi'][Math.floor((midi - 45) / 12)] || 'hihihi';
  return `${prefix}${NOTE_NAMES[midi % 12]}(${sci})`;
}
function parseNote(s) {
  const m = String(s || '').match(/([A-G]#?)(-?\d)\)?\s*$/);
  if (!m) return null;
  return NOTE_NAMES.indexOf(m[1]) + (Number(m[2]) + 1) * 12;
}
const NOTE_OPTIONS = Array.from({ length: 59 }, (_, i) => noteLabel(36 + i)); // C2〜A#6
const keyName = k => (k > 0 ? `♯${k}` : k < 0 ? `♭${-k}` : '原キー');

// 自分の音域に収めるにはキーをいくつ動かせばよいか（カラオケのキー変更は ±7 まで。届かなければオクターブ違いも試す）
function keyFit(song) {
  const l = parseNote(song.low), h = parseNote(song.high);
  const L = parseNote(S.settings.low), H = parseNote(S.settings.high);
  if (l == null || h == null || L == null || H == null) return null;
  const min = L - l, max = H - h;
  if (min > max) return { ok: false, label: '音域が広すぎる' };
  const clamp = k => Math.max(min, Math.min(max, k));
  const k = clamp(0);
  const span = `${keyName(Math.max(min, -7))}〜${keyName(Math.min(max, 7))}`; // カラオケで変えられる ±7 の範囲で表示
  if (Math.abs(k) <= 7) return { ok: true, k, orig: k === 0, span, label: k === 0 ? '原キーで歌える' : `${keyName(k)}で歌える` };
  for (const oct of [-12, 12]) {
    const kk = clamp(oct);
    if (Math.abs(kk - oct) <= 7) return { ok: true, k: kk, orig: false, span: '', label: `${oct < 0 ? 'オク下' : 'オク上'}${kk === oct ? '' : keyName(kk - oct)}で歌える` };
  }
  return { ok: false, label: 'キー変更では届かない' };
}

// しりとり用：かなの最初と最後の文字（ひらがな、小書き文字は大きくする）
const SMALL_KANA = { 'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'っ': 'つ', 'ゎ': 'わ', 'ゕ': 'か', 'ゖ': 'け' };
const hiraChars = song => [...normalize(song.kana || song.title)].filter(c => /[\u3041-\u3096]/.test(c));
const firstKana = song => { const c = hiraChars(song)[0]; return c ? (SMALL_KANA[c] || c) : null; };
const lastKana = song => { const c = hiraChars(song).pop(); return c ? (SMALL_KANA[c] || c) : null; };

const isAudio = f => String(f.mime || '').startsWith('audio/');
const isText = f => String(f.mime || '').startsWith('text/');
const textTitle = f => String(f.name || '').replace(/\.(txt|md)$/i, '');
const fmtSize = n => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);
function guessMime(file) {
  if (file.type) return file.type;
  const ext = (file.name.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  return { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', caf: 'audio/x-caf' }[ext] || '';
}

// ============================================================
// IndexedDB
// ============================================================
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('karaoke-app', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      const mk = (name, opts) => { if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, opts); };
      mk('songs', { keyPath: 'id' });
      mk('scores', { keyPath: 'id' });
      mk('pdfs', { keyPath: 'id' }); // PDF と練習録音（添付ファイル）のメタ情報
      mk('pdfBlobs');
      mk('outbox', { keyPath: 'seq', autoIncrement: true });
      mk('meta');
      mk('setlists', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const os = (s, mode = 'readonly') => db.transaction(s, mode).objectStore(s);
const idb = {
  get: (s, k) => reqP(os(s).get(k)),
  all: s => reqP(os(s).getAll()),
  put: (s, v, k) => reqP(os(s, 'readwrite').put(v, k)),
  del: (s, k) => reqP(os(s, 'readwrite').delete(k)),
  async replace(s, items) {
    const t = db.transaction(s, 'readwrite');
    const st = t.objectStore(s);
    st.clear();
    items.forEach(i => st.put(i));
    await txDone(t);
  },
};

// ============================================================
// 状態
// ============================================================
const S = {
  songs: [], scores: [], pdfs: [], setlists: [],
  settings: { url: '', token: '', low: 'lowF(F2)', high: 'hihiA#(A#5)' },
  meta: { lastSync: 0, lastError: '' },
  tab: 'songs', songId: null, setlistId: null,
  pick: { mode: 'random', okOnly: true, fit: false, unsung: false, result: null, q: '' },
  pendingSetlistItem: null,
  filter: { q: '', status: 'all', range: false, fit: false, pdf: false, sung: 'all', sort: 'kana' },
  stats: { machine: 'all', rankBy: 'avg', rankMin3: true },
  logLimit: 150,
  outbox: 0, syncing: false, inflight: new Set(),
  version: 0,
};

let statsCache = { v: -1, map: new Map() };
function songStats() {
  if (statsCache.v === S.version) return statsCache.map;
  const map = new Map();
  S.scores.forEach(sc => {
    if (sc.point == null) return;
    let st = map.get(sc.title);
    if (!st) { st = { n: 0, sum: 0, max: -Infinity, min: Infinity, last: '' }; map.set(sc.title, st); }
    st.n++; st.sum += sc.point;
    st.max = Math.max(st.max, sc.point); st.min = Math.min(st.min, sc.point);
    if ((sc.date || '') > st.last) st.last = sc.date;
  });
  map.forEach(st => { st.avg = st.sum / st.n; });
  statsCache = { v: S.version, map };
  return map;
}
const changed = () => { S.version++; };

async function loadAll() {
  const [songs, scores, pdfs, settings, meta, outbox, setlists] = await Promise.all([
    idb.all('songs'), idb.all('scores'), idb.all('pdfs'), idb.get('meta', 'settings'), idb.get('meta', 'syncMeta'), idb.all('outbox'), idb.all('setlists'),
  ]);
  S.setlists = setlists;
  const order = (await idb.get('meta', 'order')) || {};
  const byOrder = key => (a, b) => (order[key]?.[a.id] ?? 1e9) - (order[key]?.[b.id] ?? 1e9);
  S.songs = songs.sort(byOrder('songs'));
  S.scores = scores.sort(byOrder('scores'));
  S.pdfs = pdfs;
  Object.assign(S.settings, settings || {});
  Object.assign(S.meta, meta || {});
  S.outbox = outbox.length;
  changed();
}

// シートの並び順を保つため、並び順を別に保存しておく
async function saveOrder() {
  const order = { songs: {}, scores: {} };
  S.songs.forEach((s, i) => { order.songs[s.id] = i; });
  S.scores.forEach((s, i) => { order.scores[s.id] = i; });
  await idb.put('meta', order, 'order');
}

// ============================================================
// 変更の記録（オフラインでも即保存し、送信待ちに積む）
// ============================================================
async function queue(op) {
  const all = await idb.all('outbox');
  if (op.op === 'upsert') {
    const prev = all.find(o => o.kind === op.kind && o.op === 'upsert' && o.id === op.id && !S.inflight.has(o.seq));
    if (prev) {
      prev.data = { ...prev.data, ...op.data };
      await idb.put('outbox', prev);
      scheduleSync();
      return;
    }
  }
  if (op.op === 'delete') {
    for (const o of all) if (o.kind === op.kind && o.id === op.id && !S.inflight.has(o.seq)) await idb.del('outbox', o.seq);
  }
  await idb.put('outbox', op);
  S.outbox = (await idb.all('outbox')).length;
  updateSyncChip();
  scheduleSync();
}

async function saveSong(song, fields, isNew) {
  const old = S.songs.find(s => s.id === song.id);
  const oldTitle = old?.title;
  if (old) Object.assign(old, song); else S.songs.push(song);
  await idb.put('songs', song);
  if (isNew) await saveOrder();
  const data = {};
  (isNew ? SONG_FIELDS : fields).forEach(f => { data[f] = song[f] ?? ''; });
  await queue({ kind: 'song', op: 'upsert', id: song.id, data });
  // 曲名を変えたら、その曲の点数記録とPDFも新しい曲名に付け替える
  if (oldTitle && oldTitle !== song.title) {
    for (const sc of S.scores.filter(x => x.title === oldTitle)) {
      sc.title = song.title;
      await idb.put('scores', sc);
      await queue({ kind: 'score', op: 'upsert', id: sc.id, data: { title: sc.title } });
    }
  }
  changed();
}

async function deleteSong(song) {
  S.songs = S.songs.filter(s => s.id !== song.id);
  await idb.del('songs', song.id);
  await queue({ kind: 'song', op: 'delete', id: song.id });
  for (const p of S.pdfs.filter(p => p.songId === song.id)) await deletePdf(p);
  changed();
}

async function saveScore(score, fields, isNew) {
  const old = S.scores.find(s => s.id === score.id);
  if (old) Object.assign(old, score); else S.scores.push(score);
  await idb.put('scores', score);
  if (isNew) await saveOrder();
  const data = {};
  (isNew ? SCORE_FIELDS : fields).forEach(f => { data[f] = score[f] ?? ''; });
  await queue({ kind: 'score', op: 'upsert', id: score.id, data });
  changed();
}

async function deleteScore(score) {
  S.scores = S.scores.filter(s => s.id !== score.id);
  await idb.del('scores', score.id);
  await queue({ kind: 'score', op: 'delete', id: score.id });
  changed();
}

async function addFiles(song, files) {
  for (const f of files) {
    const mime = guessMime(f);
    if (mime !== 'application/pdf' && !mime.startsWith('audio/') && !mime.startsWith('text/')) { toast(`${f.name} はPDF・テキスト・音声のどれでもありません`); continue; }
    const meta = { id: uid(), songId: song.id, songTitle: song.title, name: f.name, size: f.size, mime, updatedAt: Date.now(), driveId: '', hasBlob: true };
    await idb.put('pdfBlobs', f.slice(0, f.size, mime), meta.id);
    await idb.put('pdfs', meta);
    S.pdfs.push(meta);
    await queue({ kind: 'pdf', op: 'upload', id: meta.id });
  }
  changed();
}

// テキストのディレクションも添付ファイルと同じ仕組みで保存・同期する（ドライブには .txt として置かれる）
async function saveTextNote(song, meta, title, body) {
  const name = `${title.trim() || 'ディレクション'}.txt`;
  const blob = new Blob([body], { type: 'text/plain' });
  if (!meta) {
    await addFiles(song, [new File([blob], name, { type: 'text/plain' })]);
    return;
  }
  Object.assign(meta, { name, size: blob.size, mime: 'text/plain', updatedAt: Date.now(), hasBlob: true });
  await idb.put('pdfBlobs', blob, meta.id);
  await idb.put('pdfs', meta);
  const pending = (await idb.all('outbox')).some(o => o.kind === 'pdf' && o.op === 'upload' && o.id === meta.id && !S.inflight.has(o.seq));
  if (pending) scheduleSync(); else await queue({ kind: 'pdf', op: 'upload', id: meta.id });
  changed();
}

async function textForm(song, meta) {
  const body = meta ? await (await idb.get('pdfBlobs', meta.id))?.text() ?? null : '';
  if (meta && body == null) { toast('まだダウンロードされていません。オンラインで一度開いてください'); return; }
  openModal(`
    <div class="sheet-head"><button data-action="close-modal">キャンセル</button><h2>${meta ? 'テキストを編集' : 'テキストを追加'}</h2><button data-action="save-text">保存</button></div>
    <form class="form" id="textForm" data-song="${song.id}" data-id="${meta?.id || ''}">
      <label class="full">タイトル<input name="title" value="${esc(meta ? textTitle(meta) : 'ディレクション')}" autocomplete="off"></label>
      <label class="full">本文<textarea name="body" class="big" placeholder="歌詞の解釈、歌い方の指示、ブレス位置など">${esc(body)}</textarea></label>
    </form>`);
}

async function submitTextForm() {
  const form = $('#textForm');
  const song = S.songs.find(x => x.id === form.dataset.song);
  const meta = S.pdfs.find(x => x.id === form.dataset.id);
  const title = form.title.value, body = form.body.value;
  if (!song) { closeModal(); return; }
  await saveTextNote(song, meta, title, body);
  closeModal();
  if (meta && viewerState?.p?.id === meta.id) openPdf(meta); else render({ keepScroll: true });
  toast('保存しました');
}

async function saveSetlist(sl) {
  sl.updatedAt = Date.now();
  const i = S.setlists.findIndex(x => x.id === sl.id);
  if (i < 0) S.setlists.push(sl); else S.setlists[i] = sl;
  await idb.put('setlists', sl);
  await queue({ kind: 'setlist', op: 'upsert', id: sl.id, data: { date: sl.date, name: sl.name, items: sl.items, updatedAt: sl.updatedAt } });
  changed();
}

async function deleteSetlist(sl) {
  S.setlists = S.setlists.filter(x => x.id !== sl.id);
  await idb.del('setlists', sl.id);
  await queue({ kind: 'setlist', op: 'delete', id: sl.id });
  changed();
}

async function deletePdf(p) {
  S.pdfs = S.pdfs.filter(x => x.id !== p.id);
  await idb.del('pdfs', p.id);
  await idb.del('pdfBlobs', p.id);
  const all = await idb.all('outbox');
  const pendingUpload = all.find(o => o.kind === 'pdf' && o.op === 'upload' && o.id === p.id && !S.inflight.has(o.seq));
  if (pendingUpload) {
    await idb.del('outbox', pendingUpload.seq); // まだ送っていないなら送信を取りやめるだけでよい
    S.outbox = (await idb.all('outbox')).length;
    updateSyncChip();
  } else {
    await queue({ kind: 'pdf', op: 'delete', id: p.id });
  }
  changed();
}

// ============================================================
// 同期（Apps Script）
// ============================================================
let syncTimer = null;
function scheduleSync(delay = 2000) {
  if (!S.settings.url) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), delay);
}

async function callServer(payload, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(S.settings.url, {
      method: 'POST',
      // text/plain にすると CORS の事前確認が不要になり、Apps Script でも受け取れる
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, token: S.settings.token }),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`サーバーエラー (${res.status})`);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('サーバーの応答を読めません。URLとデプロイ設定（アクセス: 全員）を確認してください'); }
    if (json.error) throw new Error(json.error);
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('タイムアウトしました');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
function b64ToBlob(b64, type = 'application/pdf') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function sync({ manual = false } = {}) {
  if (!S.settings.url || !S.settings.token) { if (manual) { S.tab = 'settings'; S.songId = null; render(); toast('先に同期の設定をしてください'); } return; }
  if (S.syncing) return;
  if (!navigator.onLine) { if (manual) toast('オフラインです。オンラインに戻ったら自動で同期します'); updateSyncChip(); return; }
  S.syncing = true;
  updateSyncChip();
  try {
    // 1. PDF は大きいので 1 件ずつ送る
    let ops = await idb.all('outbox');
    for (const op of ops.filter(o => o.kind === 'pdf' && o.op === 'upload')) {
      S.inflight.add(op.seq);
      const meta = await idb.get('pdfs', op.id);
      const blob = await idb.get('pdfBlobs', op.id);
      if (meta && blob) {
        const r = await callServer({
          action: 'pdfUpload',
          pdf: { id: meta.id, songId: meta.songId, songTitle: S.songs.find(s => s.id === meta.songId)?.title || meta.songTitle, name: meta.name, mime: meta.mime || 'application/pdf', updatedAt: meta.updatedAt },
          b64: await blobToB64(blob),
        }, 180000);
        meta.driveId = r.driveId;
        await idb.put('pdfs', meta);
        const m = S.pdfs.find(p => p.id === meta.id);
        if (m) m.driveId = r.driveId;
      }
      await idb.del('outbox', op.seq);
      S.inflight.delete(op.seq);
    }

    // 2. 曲・点数・PDF削除をまとめて送り、シートの最新状態を受け取る
    ops = (await idb.all('outbox')).filter(o => !(o.kind === 'pdf' && o.op === 'upload'));
    ops.forEach(o => S.inflight.add(o.seq));
    const snap = await callServer({ action: 'sync', ops: ops.map(({ kind, op, id, data }) => ({ kind, op, id, data })) });
    const t = db.transaction('outbox', 'readwrite');
    ops.forEach(o => t.objectStore('outbox').delete(o.seq));
    await txDone(t);
    ops.forEach(o => S.inflight.delete(o.seq));

    await applySnapshot(snap);
    S.meta.lastSync = Date.now();
    S.meta.lastError = '';
  } catch (e) {
    S.meta.lastError = e.message || String(e);
    if (manual) toast('同期できませんでした：' + S.meta.lastError);
  } finally {
    S.inflight.clear();
    S.syncing = false;
    S.outbox = (await idb.all('outbox')).length;
    await idb.put('meta', S.meta, 'syncMeta');
    updateSyncChip();
    render({ keepScroll: true });
  }
  downloadMissingPdfs();
}

async function applySnapshot(snap) {
  // 同期中に端末で変更されたもの（まだ送っていないもの）は端末側を優先する
  const pending = await idb.all('outbox');
  const pend = kind => new Map(pending.filter(o => o.kind === kind).map(o => [o.id, o]));

  const merge = (remote, local, kind) => {
    const p = pend(kind);
    const localById = new Map(local.map(x => [x.id, x]));
    const out = [];
    remote.forEach(r => {
      const op = p.get(r.id);
      if (op?.op === 'delete') return;
      out.push(op ? { ...r, ...localById.get(r.id) } : r);
    });
    p.forEach((op, id) => {
      if (op.op === 'upsert' && !remote.some(r => r.id === id) && localById.has(id)) out.push(localById.get(id));
    });
    return out;
  };
  S.songs = merge(snap.songs || [], S.songs, 'song');
  S.scores = merge(snap.scores || [], S.scores, 'score');
  await idb.replace('songs', S.songs);
  await idb.replace('scores', S.scores);
  await saveOrder();
  if (snap.setlists) {
    S.setlists = merge(snap.setlists, S.setlists, 'setlist');
    await idb.replace('setlists', S.setlists);
  }

  // PDF：他の端末で追加されたものを登録、他の端末で削除されたものを消す
  const remote = new Map((snap.pdfs || []).map(p => [p.id, p]));
  const pendingUpload = new Set(pending.filter(o => o.kind === 'pdf' && o.op === 'upload').map(o => o.id));
  const pendingDelete = new Set(pending.filter(o => o.kind === 'pdf' && o.op === 'delete').map(o => o.id));
  for (const p of [...S.pdfs]) {
    if (!remote.has(p.id) && !pendingUpload.has(p.id)) {
      S.pdfs = S.pdfs.filter(x => x.id !== p.id);
      await idb.del('pdfs', p.id);
      await idb.del('pdfBlobs', p.id);
    }
  }
  for (const r of remote.values()) {
    if (pendingDelete.has(r.id)) continue;
    const local = S.pdfs.find(p => p.id === r.id);
    if (!local) {
      const meta = { ...r, hasBlob: false };
      S.pdfs.push(meta);
      await idb.put('pdfs', meta);
    } else if (local.driveId !== r.driveId || local.name !== r.name || local.songId !== r.songId || (r.mime && local.mime !== r.mime)) {
      const replaced = local.driveId && local.driveId !== r.driveId;
      Object.assign(local, r, replaced ? { hasBlob: false } : {});
      await idb.put('pdfs', local);
    }
  }
  changed();
}

let downloading = false;
async function downloadMissingPdfs() {
  if (downloading || !navigator.onLine || !S.settings.url) return;
  downloading = true;
  try {
    for (const p of S.pdfs.filter(p => !p.hasBlob && p.driveId)) {
      try { await fetchPdfBlob(p); } catch { /* 次回の同期で再試行 */ }
    }
  } finally {
    downloading = false;
  }
}
async function fetchPdfBlob(p) {
  const r = await callServer({ action: 'pdfGet', id: p.id }, 180000);
  const blob = b64ToBlob(r.b64, r.mime || p.mime || 'application/pdf');
  await idb.put('pdfBlobs', blob, p.id);
  p.hasBlob = true;
  await idb.put('pdfs', p);
  return blob;
}

function updateSyncChip() {
  const el = $('#syncChip');
  el.className = 'sync-chip';
  if (!S.settings.url) { el.textContent = '同期未設定'; return; }
  if (S.syncing) { el.textContent = '同期中…'; return; }
  if (!navigator.onLine) { el.textContent = S.outbox ? `オフライン・未送信${S.outbox}` : 'オフライン'; el.classList.add('pending'); return; }
  if (S.meta.lastError) { el.textContent = S.outbox ? `未送信${S.outbox}・同期エラー` : '同期エラー'; el.classList.add('err'); return; }
  if (S.outbox) { el.textContent = `未送信 ${S.outbox}`; el.classList.add('pending'); return; }
  if (S.meta.lastSync) {
    const d = new Date(S.meta.lastSync);
    el.textContent = `同期済 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    el.classList.add('ok');
    return;
  }
  el.textContent = '未同期';
}

// ============================================================
// 画面
// ============================================================
const main = $('#main');

function render({ keepScroll = false } = {}) {
  const y = window.scrollY;
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
  const wide = matchMedia('(min-width: 900px)').matches;
  const song = S.songId && S.songs.find(s => s.id === S.songId);
  if (S.songId && !song) S.songId = null;
  const setlist = S.setlistId && S.setlists.find(x => x.id === S.setlistId);
  if (S.setlistId && !setlist) S.setlistId = null;
  $('#backBtn').hidden = !((S.tab === 'songs' && song && !wide) || (S.tab === 'setlist' && setlist));
  $('#fab').hidden = S.tab === 'settings';
  updateSyncChip();

  if (S.tab === 'songs') {
    if (song && !wide) {
      $('#title').textContent = song.title;
      main.innerHTML = songDetailHtml(song);
    } else {
      $('#title').textContent = '曲';
      main.innerHTML = `<div class="${wide ? 'split' : ''}"><div>${songToolbarHtml()}<div id="songList"></div></div>${wide ? `<div class="pane-detail">${song ? songDetailHtml(song) : '<div class="card empty">曲を選ぶと詳細が表示されます</div>'}</div>` : ''}</div>`;
      renderSongList();
    }
  } else if (S.tab === 'setlist') {
    $('#title').textContent = setlist ? (setlist.name || 'セトリ') : 'セトリ';
    main.innerHTML = setlist ? setlistDetailHtml(setlist) : setlistListHtml();
  } else if (S.tab === 'log') {
    $('#title').textContent = '記録';
    main.innerHTML = logHtml();
  } else if (S.tab === 'stats') {
    $('#title').textContent = '統計';
    main.innerHTML = statsHtml();
  } else {
    $('#title').textContent = '設定';
    main.innerHTML = settingsHtml();
    refreshStorageInfo();
  }
  if (keepScroll) window.scrollTo(0, y);
}

// ---------- 曲一覧 ----------
function songToolbarHtml() {
  const f = S.filter;
  const chip = (key, val, label) => `<button class="chip ${f[key] === val ? 'on' : ''}" data-action="filter" data-k="${key}" data-v="${val}">${label}</button>`;
  const toggle = (key, label) => `<button class="chip ${f[key] ? 'on' : ''}" data-action="toggle" data-k="${key}">${label}</button>`;
  return `<div class="toolbar">
    <input class="search" id="q" type="search" placeholder="曲名・歌手・かなで検索" value="${esc(f.q)}" autocomplete="off">
    <div class="chips">
      ${chip('status', 'all', 'すべて')}${chip('status', 'OK', '状況OK')}${chip('status', '未履修', '未履修')}
      ${toggle('range', '原キーで音域内')}${toggle('fit', 'キー変更で歌える')}${toggle('pdf', '資料あり')}
      ${chip('sung', 'yes', '歌った')}${chip('sung', 'no', '未歌唱')}
      <select class="chip" id="sort" aria-label="並び替え">
        ${[['kana', 'かな順'], ['avg', '平均点順'], ['max', '最高点順'], ['n', '回数順'], ['recent', '最近歌った順'], ['no', '番号順']]
          .map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
  </div>`;
}

function filteredSongs() {
  const f = S.filter;
  const st = songStats();
  const q = normalize(f.q);
  const pdfSongs = new Set(S.pdfs.filter(p => !isAudio(p)).map(p => p.songId)); // PDF かテキストのディレクションがある曲
  let list = S.songs.filter(s => {
    if (q && ![s.title, s.kana, s.artist, s.artistKana].some(x => normalize(x).includes(q))) return false;
    if (f.status === 'OK' && s.status !== 'OK') return false;
    if (f.status === '未履修' && s.status === 'OK') return false;
    if (f.range && !keyFit(s)?.orig) return false;
    if (f.fit && !keyFit(s)?.ok) return false;
    if (f.pdf && !pdfSongs.has(s.id)) return false;
    if (f.sung === 'yes' && !st.has(s.title)) return false;
    if (f.sung === 'no' && st.has(s.title)) return false;
    return true;
  });
  const g = (s, k) => st.get(s.title)?.[k] ?? -1;
  const kana = s => s.kana || s.title;
  const sorters = {
    kana: (a, b) => kana(a).localeCompare(kana(b), 'ja'),
    avg: (a, b) => g(b, 'avg') - g(a, 'avg'),
    max: (a, b) => g(b, 'max') - g(a, 'max'),
    n: (a, b) => g(b, 'n') - g(a, 'n'),
    recent: (a, b) => String(st.get(b.title)?.last || '').localeCompare(String(st.get(a.title)?.last || '')),
    no: (a, b) => (Number(a.no) || 1e9) - (Number(b.no) || 1e9),
  };
  return list.sort(sorters[f.sort] || sorters.kana);
}

function renderSongList() {
  const box = $('#songList');
  if (!box) return;
  const list = filteredSongs();
  const st = songStats();
  const pdfCount = new Map(), recCount = new Map();
  S.pdfs.forEach(p => { const m = isAudio(p) ? recCount : pdfCount; m.set(p.songId, (m.get(p.songId) || 0) + 1); });
  if (!S.songs.length) {
    box.innerHTML = `<div class="card empty">曲がまだありません。<br>設定タブでスプレッドシートと同期するか、<br><button class="btn primary" data-action="new-song" style="margin-top:12px">曲を追加</button></div>`;
    return;
  }
  const shown = list.slice(0, 600);
  box.innerHTML = `<div class="count-line">${list.length}曲 / 全${S.songs.length}曲　<a href="#" data-action="new-song">＋曲を追加</a></div>
  <div class="list">${shown.map(s => {
    const x = st.get(s.title);
    const pc = pdfCount.get(s.id), rc = recCount.get(s.id);
    const fit = keyFit(s);
    return `<button class="row" data-action="open-song" data-id="${s.id}">
      <div class="main">
        <div class="t">${esc(s.title)}</div>
        <div class="s">${s.status === 'OK' ? '<span class="badge ok">OK</span>' : s.status ? `<span class="badge todo">${esc(s.status)}</span>` : ''}${pc ? `<span class="badge pdf">資料 ${pc}</span>` : ''}${rc ? `<span class="badge pdf">♪${rc}</span>` : ''}${fit?.ok && !fit.orig ? `<span class="badge m">${esc(fit.label.replace('で歌える', ''))}</span>` : ''}${esc(s.artist || '')}${s.high ? ` ・最高 ${esc(s.high.replace(/\(.*\)/, ''))}` : ''}</div>
      </div>
      <div class="num">${x ? `<b>${fmt3(x.avg)}</b><small>${x.n}回・最高${fmt3(x.max)}</small>` : '<small>未歌唱</small>'}</div>
    </button>`;
  }).join('') || '<div class="empty">該当する曲がありません</div>'}</div>`;
}

// ---------- 曲の詳細 ----------
function songDetailHtml(song) {
  const scores = S.scores.filter(s => s.title === song.title && s.point != null);
  const x = songStats().get(song.title);
  const pdfs = S.pdfs.filter(p => p.songId === song.id && !isAudio(p)).sort((a, b) => a.updatedAt - b.updatedAt);
  const recs = S.pdfs.filter(p => p.songId === song.id && isAudio(p));
  const fit = keyFit(song);
  const attachRow = p => `<div class="row">
        <button class="main" style="border:0;background:none;text-align:left;padding:0" data-action="open-pdf" data-id="${p.id}">
          <div class="t">${isAudio(p) ? '🎙' : isText(p) ? '📝' : '📄'} ${esc(isText(p) ? textTitle(p) : p.name)}</div>
          <div class="s">${isText(p) ? 'テキスト' : fmtSize(p.size)}・${p.hasBlob ? (isAudio(p) ? 'オフラインで再生可' : 'オフラインで閲覧可') : 'クラウドのみ（開くとダウンロード）'}${p.driveId ? '' : '・未アップロード'}</div>
        </button>
        <button class="btn danger" data-action="del-pdf" data-id="${p.id}">削除</button>
      </div>`;
  const rows = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
  const isUrl = u => /^https?:\/\//.test(u || '');
  return `<div class="detail">
    <div class="card">
      <div style="font-size:20px;font-weight:700">${esc(song.title)}</div>
      <div class="help">${esc(song.artist || '歌手未登録')}${song.kana ? `・${esc(song.kana)}` : ''}</div>
      <div style="margin:8px 0">${song.status ? `<span class="badge ${song.status === 'OK' ? 'ok' : 'todo'}">${esc(song.status)}</span>` : ''}${song.progress ? `<span class="badge m">進捗 ${esc(song.progress)}</span>` : ''}${song.request ? `<span class="badge m">${esc(song.request)}</span>` : ''}</div>
      <div class="btn-row">
        <button class="btn primary" data-action="new-score" data-title="${esc(song.title)}">点数を記録</button>
        <button class="btn" data-action="edit-song" data-id="${song.id}">編集</button>
      </div>
    </div>

    <div class="section-h">成績</div>
    ${x ? `<div class="stat-tiles">
      <div class="tile"><div class="l">回数</div><div class="v">${x.n}</div></div>
      <div class="tile"><div class="l">平均</div><div class="v">${fmt3(x.avg)}</div></div>
      <div class="tile"><div class="l">最高</div><div class="v">${fmt3(x.max)}</div></div>
      <div class="tile"><div class="l">最低</div><div class="v">${fmt3(x.min)}</div></div>
    </div>
    <div class="card" style="margin-top:8px">${trendChart(scores)}</div>
    <div class="section-h">機種別の集計</div>
    ${machineTableHtml(scores)}` : '<div class="card empty">まだ点数の記録がありません</div>'}

    <div class="section-h">ディレクション・歌詞解釈<span><button data-action="add-pdf" data-id="${song.id}">＋ファイル</button><button data-action="new-text" data-id="${song.id}">＋テキスト</button></span></div>
    <input type="file" id="pdfInput" accept="application/pdf,.pdf,text/plain,.txt,.md" multiple hidden data-id="${song.id}">
    <div class="list">${pdfs.map(attachRow).join('') || '<div class="empty" style="padding:18px">PDFやテキストはまだありません</div>'}</div>

    <div class="section-h">練習録音<span><button data-action="add-audio">ファイル</button><button id="recBtn" data-action="record" data-id="${song.id}">${rec && rec.songId === song.id ? '■ 停止' : '● 録音'}</button></span></div>
    <input type="file" id="audioInput" accept="audio/*" multiple hidden data-id="${song.id}">
    <div class="list">${recs.map(attachRow).join('') || '<div class="empty" style="padding:18px">録音はまだありません</div>'}</div>

    <div class="section-h">曲の情報</div>
    <div class="card"><dl class="kv">
      ${fit ? rows('自分の音域で', `<b style="color:${fit.ok ? 'var(--ok)' : 'var(--danger)'}">${esc(fit.label)}</b>${fit.ok && fit.span ? `<br><span class="help">${esc(fit.span)} の範囲なら収まる</span>` : ''}`) : ''}
      ${rows('原キー最低音', esc(song.low))}${rows('原キー最高音', esc(song.high))}${rows('おすすめキー', esc(song.recKey))}
      ${rows('注意', esc(song.caution))}
      ${rows('参考音源', isUrl(song.ref) ? `<a href="${esc(song.ref)}" target="_blank" rel="noopener">${esc(song.ref)}</a>` : esc(song.ref))}
      ${rows('番号', esc(song.no))}
    </dl>${song.memo ? `<div style="margin-top:10px;white-space:pre-wrap">${esc(song.memo)}</div>` : ''}
    ${!song.low && !song.high && !song.recKey && !song.caution && !song.ref && !song.memo ? '<div class="help">「編集」から音域・メモなどを登録できます</div>' : ''}</div>

    <div class="section-h">点数の履歴</div>
    <div class="list">${scores.length ? scores.map((s, i) => [s, i]).sort((a, b) => (b[0].date || '').localeCompare(a[0].date || '') || b[1] - a[1]).map(([s]) => scoreRowHtml(s)).join('') : '<div class="empty" style="padding:18px">記録なし</div>'}</div>
  </div>`;
}

// 「カラオケ点数リスト」と同じ集計（機種ごとの平均・最高・最低、素点・ボーナス点・チャート各項目・抑揚の平均）
const SUMMARY_COLS = [
  ['avg', '平均点', 3], ['max', '最高点', 3], ['min', '最低点', 3],
  ['on', '音程', 1], ['vlt', 'ビブラート&ロングトーン', 1], ['rhythm', 'リズム', 1], ['hyo', '表現力', 1], ['stab', '安定性', 1], ['choukan', '聴感', 1],
  ['total', 'チャート合計', 1], ['yoku', '抑揚', 1], ['bonus', 'ボーナス点', 3], ['raw', '素点', 3],
];
function summarize(scores) {
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const pick = f => scores.map(f).filter(x => x != null);
  const pts = pick(s => s.point);
  const r = { n: scores.length, avg: mean(pts), max: pts.length ? Math.max(...pts) : null, min: pts.length ? Math.min(...pts) : null, total: mean(pick(chartTotal)), raw: mean(pick(rawScore)) };
  ['on', 'vlt', 'rhythm', 'hyo', 'stab', 'choukan', 'yoku', 'bonus'].forEach(k => { r[k] = mean(pick(s => s[k])); });
  return r;
}
function machineTableHtml(scores) {
  if (!scores.length) return '';
  const groups = new Map([['全体', scores]]);
  const order = [...MACHINES, ...new Set(scores.map(s => machineGroup(s.machine)))];
  order.forEach(m => { const a = scores.filter(s => machineGroup(s.machine) === m); if (a.length && !groups.has(m)) groups.set(m, a); });
  const rows = [...groups].map(([m, a]) => [m, summarize(a)]);
  const cols = SUMMARY_COLS.filter(([k]) => rows.some(([, r]) => r[k] != null));
  const fmt = (v, d) => (v == null ? '–' : d === 3 ? fmt3(v) : (Math.round(v * 10) / 10).toFixed(1));
  return `<div class="sum-wrap"><table class="sum-table">
    <thead><tr><th>機種</th><th>回数</th>${cols.map(([, l]) => `<th>${esc(l).replace('&amp;', '&amp;<br>').replace('チャート合計', 'チャート<br>合計')}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([m, r]) => `<tr><th>${esc(m)}</th><td>${r.n}</td>${cols.map(([k, , d]) => `<td>${fmt(r[k], d)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function scoreRowHtml(s, { showTitle = false } = {}) {
  const total = chartTotal(s), raw = rawScore(s);
  const sub = [
    CHART.filter(([k]) => s[k] != null).map(([k, , a]) => `${a}${s[k]}`).join(' '),
    total != null ? `計${total}` : '',
    s.yoku != null ? `抑揚${s.yoku}` : '',
    s.ai != null ? `旧Ai/聴${s.ai}` : '',
    raw != null ? `素点${fmt3(raw)}` : '',
  ].filter(Boolean).join(' ');
  return `<button class="row" data-action="edit-score" data-id="${s.id}">
    <div class="main">
      <div class="t">${showTitle ? esc(s.title) : fmtDate(s.date)}</div>
      <div class="s"><span class="badge m">${esc(s.machine || '機種なし')}</span>${esc([s.key, sub, s.bonus != null ? `ボーナス${s.bonus}` : '', s.comment].filter(Boolean).join('・'))}</div>
    </div>
    <div class="num"><b>${fmt3(s.point)}</b></div>
  </button>`;
}

function trendChart(scores) {
  const pts = scores.filter(s => s.point != null);
  if (pts.length < 2) return '<div class="help">2回以上歌うと推移グラフが出ます</div>';
  const W = 600, H = 170, P = { l: 34, r: 10, t: 10, b: 18 };
  const ys = pts.map(p => p.point);
  let lo = Math.floor(Math.min(...ys) - 0.5), hi = Math.ceil(Math.max(...ys) + 0.5);
  if (hi - lo < 4) { lo = Math.floor((lo + hi) / 2 - 2); hi = lo + 4; }
  const x = i => P.l + (i / (pts.length - 1)) * (W - P.l - P.r);
  const y = v => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const ticks = [lo, (lo + hi) / 2, hi];
  const best = ys.indexOf(Math.max(...ys));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="点数の推移">
    ${ticks.map(t => `<line class="axis" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="lbl" x="${P.l - 4}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 10) / 10}</text>`).join('')}
    <polyline class="line" points="${pts.map((p, i) => `${x(i)},${y(p.point)}`).join(' ')}"/>
    ${pts.length <= 60 ? pts.map((p, i) => `<circle class="dot" cx="${x(i)}" cy="${y(p.point)}" r="${i === best ? 5 : 2.5}"><title>${fmtDate(p.date)} ${fmt3(p.point)}</title></circle>`).join('') : `<circle class="dot" cx="${x(best)}" cy="${y(ys[best])}" r="5"/>`}
    <text class="lbl" x="${P.l}" y="${H - 3}">${fmtDate(pts[0].date)}</text>
    <text class="lbl" x="${W - P.r}" y="${H - 3}" text-anchor="end">${fmtDate(pts[pts.length - 1].date)}</text>
  </svg>`;
}

// ---------- セトリタブ ----------
const curSetlist = () => S.setlists.find(x => x.id === S.setlistId);

function setlistListHtml() {
  const list = [...S.setlists].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.updatedAt - a.updatedAt);
  return `<div class="btn-row" style="margin-bottom:10px"><button class="btn primary" data-action="new-setlist">＋ 新しいセトリ</button></div>
  ${list.length ? `<div class="list">${list.map(sl => {
    const done = sl.items.filter(i => i.done).length;
    return `<button class="row" data-action="open-setlist" data-id="${sl.id}"><div class="main"><div class="t">${esc(sl.name || 'セトリ')}</div><div class="s">${fmtDate(sl.date)}・${sl.items.length}曲${sl.items.length ? `（歌った ${done}）` : ''}</div></div><div class="num">›</div></button>`;
  }).join('')}</div>` : '<div class="card empty">歌う予定の曲を並べておくセトリを作れます。<br>ランダム選曲やしりとりで曲を足すこともできます</div>'}`;
}

function songByTitle(t) { return S.songs.find(s => s.title === t); }

function setlistDetailHtml(sl) {
  const st = songStats();
  const done = sl.items.filter(i => i.done).length;
  const items = sl.items.map((it, i) => {
    const song = songByTitle(it.title);
    const x = st.get(it.title);
    const fit = song && keyFit(song);
    const sc = it.scoreId && S.scores.find(s => s.id === it.scoreId);
    return `<div class="row sl-item ${it.done ? 'done' : ''}">
      <button class="check" data-action="sl-toggle" data-i="${i}" aria-label="歌った">${it.done ? '✓' : i + 1}</button>
      <div class="main">
        <div class="t">${song ? `<a href="#" data-action="open-song-title" data-title="${esc(it.title)}">${esc(it.title)}</a>` : esc(it.title)}</div>
        <div class="s">${esc([song?.artist, fit?.ok ? fit.label : '', x ? `平均${fmt3(x.avg)}` : '未歌唱', sc ? `今回 ${fmt3(sc.point)}` : ''].filter(Boolean).join('・'))}</div>
      </div>
      <span class="sl-tools">
        <button data-action="sl-score" data-i="${i}" title="点数を記録">点数</button>
        <button data-action="sl-move" data-i="${i}" data-d="-1" aria-label="上へ">↑</button>
        <button data-action="sl-move" data-i="${i}" data-d="1" aria-label="下へ">↓</button>
        <button data-action="sl-remove" data-i="${i}" aria-label="外す">×</button>
      </span>
    </div>`;
  }).join('');
  return `<div class="card">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="date" id="slDate" value="${esc(sl.date)}" class="search" style="width:auto;padding:6px 10px">
        <span class="help">${sl.items.length}曲・歌った ${done}</span>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" data-action="rename-setlist">名前を変更</button>
        <button class="btn danger" data-action="delete-setlist">削除</button>
      </div>
    </div>
    <div class="section-h">曲順</div>
    <div class="list">${items || '<div class="empty" style="padding:18px">下の「曲を足す」から追加してください</div>'}</div>
    <div class="section-h">曲を足す</div>
    ${pickerHtml(sl)}`;
}

function pickPool(sl) {
  const inList = new Set(sl.items.map(i => i.title));
  const st = songStats();
  return S.songs.filter(s => !inList.has(s.title)
    && (!S.pick.okOnly || s.status === 'OK')
    && (!S.pick.fit || keyFit(s)?.ok)
    && (!S.pick.unsung || !st.has(s.title)));
}

function rollRandom(sl) {
  const pool = pickPool(sl);
  if (!pool.length) return { none: true };
  return { title: pool[Math.floor(Math.random() * pool.length)].title };
}

function pickRow(song) {
  const x = songStats().get(song.title);
  const fit = keyFit(song);
  return `<div class="row"><div class="main"><div class="t">${esc(song.title)}</div><div class="s">${esc([song.artist, fit?.ok ? fit.label : '', x ? `平均${fmt3(x.avg)}・${x.n}回` : '未歌唱'].filter(Boolean).join('・'))}</div></div>
    <button class="btn" data-action="sl-add" data-title="${esc(song.title)}">追加</button></div>`;
}

function pickerHtml(sl) {
  const p = S.pick;
  const mode = (v, l) => `<button class="chip ${p.mode === v ? 'on' : ''}" data-action="pick-mode" data-v="${v}">${l}</button>`;
  const opt = (k, l) => `<button class="chip ${p[k] ? 'on' : ''}" data-action="pick-opt" data-k="${k}">${l}</button>`;
  let body = '';
  if (p.mode === 'search') {
    body = `<input class="search" id="pickQ" type="search" placeholder="曲名・歌手で探す" value="${esc(p.q)}" autocomplete="off"><div id="pickResults" style="margin-top:8px"></div>`;
  } else {
    const opts = `<div class="chips" style="margin-bottom:8px">${opt('okOnly', '状況OKのみ')}${opt('fit', 'キー変更で歌える')}${opt('unsung', '未歌唱のみ')}</div>`;
    if (p.mode === 'random') {
      const r = p.result;
      const song = r?.title && songByTitle(r.title);
      body = opts + `<div class="btn-row"><button class="btn primary" data-action="pick-roll">🎲 ${r ? 'もう一回' : 'ランダムに選ぶ'}</button><span class="help" style="align-self:center">候補 ${pickPool(sl).length}曲</span></div>
        ${r?.none ? '<div class="help" style="margin-top:8px">条件に合う曲がありません</div>' : ''}
        ${song ? `<div class="list" style="margin-top:8px">${pickRow(song)}</div>` : ''}`;
    } else {
      const last = sl.items[sl.items.length - 1];
      const lastSong = last && songByTitle(last.title);
      const ch = lastSong ? lastKana(lastSong) : null;
      if (!last) body = opts + '<div class="help">セトリの最後の曲の「かな」の最後の文字から始まる曲を探します。まず1曲目を追加してください。</div>';
      else if (!ch) body = opts + `<div class="help">「${esc(last.title)}」のかなが未登録のため、しりとりを続けられません。曲の編集で「曲名かな」を入れてください。</div>`;
      else {
        const cands = pickPool(sl).filter(s => firstKana(s) === ch);
        const st = songStats();
        cands.sort((a, b) => (st.get(b.title)?.avg ?? 0) - (st.get(a.title)?.avg ?? 0));
        body = opts + `<div class="help" style="margin-bottom:8px">「${esc(last.title)}」→「<b>${esc(ch)}</b>」から始まる曲${ch === 'ん' ? '（「ん」で終わっています！）' : ''}：${cands.length}曲</div>
          ${cands.length ? `<div class="list">${cands.slice(0, 30).map(pickRow).join('')}</div>` : ''}`;
      }
    }
  }
  return `<div class="chips" style="margin-bottom:8px">${mode('random', 'ランダム')}${mode('shiritori', 'しりとり')}${mode('search', '検索')}</div>${body}`;
}

function renderPickSearch() {
  const box = $('#pickResults');
  const sl = curSetlist();
  if (!box || !sl) return;
  const q = normalize(S.pick.q);
  if (!q) { box.innerHTML = ''; return; }
  const inList = new Set(sl.items.map(i => i.title));
  const hits = S.songs.filter(s => !inList.has(s.title) && [s.title, s.kana, s.artist, s.artistKana].some(x => normalize(x).includes(q))).slice(0, 20);
  box.innerHTML = hits.length ? `<div class="list">${hits.map(pickRow).join('')}</div>` : '<div class="help">見つかりません</div>';
}

async function addToSetlist(title) {
  const sl = curSetlist();
  if (!sl || !title) return;
  sl.items.push({ title, done: false });
  await saveSetlist(sl);
  if (S.pick.mode === 'random') S.pick.result = null;
  render({ keepScroll: true });
  if (S.pick.mode === 'search') renderPickSearch();
  toast(`追加しました：${title}`);
}

// ---------- 練習録音 ----------
let rec = null;
async function toggleRecording(song) {
  if (rec) { rec.mr.stop(); return; }
  if (!song) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('この端末・ブラウザでは録音できません'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast('マイクの使用が許可されませんでした'); return; }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(rec.timer);
    rec = null;
    const mime = (mr.mimeType || type || 'audio/mp4').split(';')[0];
    const d = new Date();
    const name = `録音 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.getHours()}${String(d.getMinutes()).padStart(2, '0')}.${mime.includes('webm') ? 'webm' : 'm4a'}`;
    await addFiles(song, [new File(chunks, name, { type: mime })]);
    render({ keepScroll: true });
    toast('録音を保存しました');
  };
  mr.start(1000);
  const start = Date.now();
  rec = {
    mr, songId: song.id,
    timer: setInterval(() => {
      const b = $('#recBtn');
      const sec = Math.floor((Date.now() - start) / 1000);
      if (b) b.textContent = `■ 停止 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }, 500),
  };
  render({ keepScroll: true });
}

// ---------- 記録タブ ----------
function logHtml() {
  if (!S.scores.length) return '<div class="card empty">まだ記録がありません。右下の＋から点数を記録できます</div>';
  const sorted = S.scores.map((s, i) => [s, i]).sort((a, b) => (b[0].date || '').localeCompare(a[0].date || '') || b[1] - a[1]).map(x => x[0]);
  const shown = sorted.slice(0, S.logLimit);
  const groups = [];
  shown.forEach(s => {
    const g = groups[groups.length - 1];
    if (g && g.date === s.date) g.items.push(s); else groups.push({ date: s.date, items: [s] });
  });
  return groups.map(g => {
    const pts = g.items.filter(s => s.point != null).map(s => s.point);
    const avg = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null;
    return `<div class="section-h"><span>${fmtDate(g.date)}　${g.items.length}曲${avg != null ? `・平均 ${fmt3(avg)}` : ''}</span></div>
      <div class="list">${g.items.map(s => scoreRowHtml(s, { showTitle: true })).join('')}</div>`;
  }).join('') + (sorted.length > S.logLimit ? `<div style="text-align:center;margin:16px"><button class="btn" data-action="more-log">もっと見る（残り${sorted.length - S.logLimit}件）</button></div>` : '');
}

// ---------- 統計タブ ----------
function statsHtml() {
  const mf = S.stats.machine;
  const scores = S.scores.filter(s => s.point != null && (mf === 'all' || machineGroup(s.machine) === mf));
  const machines = [...new Set(S.scores.map(s => machineGroup(s.machine)))];
  const chips = `<div class="chips" style="margin-bottom:10px">${['all', ...machines].map(m => `<button class="chip ${mf === m ? 'on' : ''}" data-action="stats-machine" data-v="${esc(m)}">${m === 'all' ? '全機種' : esc(m)}</button>`).join('')}</div>`;
  if (!scores.length) return chips + '<div class="card empty">記録がありません</div>';
  const pts = scores.map(s => s.point);
  const avg = pts.reduce((a, b) => a + b, 0) / pts.length;
  const per = new Map();
  scores.forEach(s => { const a = per.get(s.title) || []; a.push(s.point); per.set(s.title, a); });
  const songsArr = [...per].map(([t, a]) => ({ t, n: a.length, avg: a.reduce((x, y) => x + y, 0) / a.length, max: Math.max(...a), min: Math.min(...a) }));
  const thisYear = String(new Date().getFullYear());
  const ytd = scores.filter(s => (s.date || '').startsWith(thisYear)).length;

  // 点数分布（80点未満はまとめる）
  const bins = [{ label: '<80', n: pts.filter(p => p < 80).length }];
  for (let b = 80; b <= 100; b++) bins.push({ label: String(b), n: pts.filter(p => Math.floor(p) === b).length });
  const maxBin = Math.max(...bins.map(b => b.n), 1);
  const W = 600, H = 160, bw = (W - 20) / bins.length;
  const hist = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="点数分布">
    ${bins.map((b, i) => { const h = (b.n / maxBin) * (H - 36); return `<rect class="bar ${b.n === maxBin ? '' : 'dim'}" x="${10 + i * bw + 2}" y="${H - 18 - h}" width="${bw - 4}" height="${h}" rx="2"><title>${b.label}点台: ${b.n}回</title></rect>${b.n ? `<text class="lbl" x="${10 + i * bw + bw / 2}" y="${H - 22 - h}" text-anchor="middle">${b.n}</text>` : ''}<text class="lbl" x="${10 + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${b.label}</text>`; }).join('')}
  </svg>`;

  // 月ごとの回数（直近12か月）
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
  const mc = months.map(m => scores.filter(s => (s.date || '').startsWith(m)).length);
  const mMax = Math.max(...mc, 1), mbw = (W - 20) / 12;
  const monthly = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="月別の歌唱回数">
    ${mc.map((n, i) => { const h = (n / mMax) * (H - 36); return `<rect class="bar dim" x="${10 + i * mbw + 3}" y="${H - 18 - h}" width="${mbw - 6}" height="${h}" rx="2"/>${n ? `<text class="lbl" x="${10 + i * mbw + mbw / 2}" y="${H - 22 - h}" text-anchor="middle">${n}</text>` : ''}<text class="lbl" x="${10 + i * mbw + mbw / 2}" y="${H - 4}" text-anchor="middle">${+months[i].slice(5)}月</text>`; }).join('')}
  </svg>`;

  const rank = (arr, key, fmt) => `<div class="list">${arr.map((s, i) => `<button class="row" data-action="open-song-title" data-title="${esc(s.t)}"><div class="main"><div class="t">${i + 1}. ${esc(s.t)}</div><div class="s">${[`${s.n}回`, ...[['avg', '平均'], ['max', '最高'], ['min', '最低']].filter(([k]) => k !== key).map(([k, l]) => `${l}${fmt3(s[k])}`)].join('・')}</div></div><div class="num"><b>${fmt(s[key])}</b></div></button>`).join('')}</div>`;

  return chips + `<div class="stat-tiles">
    <div class="tile"><div class="l">記録数</div><div class="v">${pts.length}</div></div>
    <div class="tile"><div class="l">歌った曲</div><div class="v">${per.size}<small>曲</small></div></div>
    <div class="tile"><div class="l">平均点</div><div class="v">${fmt3(avg)}</div></div>
    <div class="tile"><div class="l">最高点</div><div class="v">${fmt3(Math.max(...pts))}</div></div>
    <div class="tile"><div class="l">今年</div><div class="v">${ytd}<small>回</small></div></div>
  </div>
  <div class="section-h">機種別の集計（全曲）</div>${machineTableHtml(S.scores)}
  <div class="section-h">点数分布</div><div class="card">${hist}</div>
  <div class="section-h">月別の歌唱回数（直近12か月）</div><div class="card">${monthly}</div>
  <div class="section-h">ランキング</div>
  <div class="chips" style="margin-bottom:8px">
    ${[['avg', '平均点'], ['max', '最高点'], ['min', '最低点']].map(([k, l]) => `<button class="chip ${S.stats.rankBy === k ? 'on' : ''}" data-action="rank-by" data-v="${k}">${l}</button>`).join('')}
    <button class="chip ${S.stats.rankMin3 ? 'on' : ''}" data-action="rank-min3">3回以上の曲だけ</button>
  </div>
  ${rank(songsArr.filter(s => !S.stats.rankMin3 || s.n >= 3).sort((a, b) => b[S.stats.rankBy] - a[S.stats.rankBy] || b.avg - a.avg).slice(0, 20), S.stats.rankBy, fmt3)}
  <div class="section-h">よく歌う曲</div>
  ${rank(songsArr.sort((a, b) => b.n - a.n).slice(0, 15), 'n', v => `${v}回`)}`;
}

// ---------- 設定タブ ----------
function settingsHtml() {
  const s = S.settings;
  const noteSel = (id, val) => `<select id="${id}">${NOTE_OPTIONS.map(n => `<option ${n === val ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  return `
  <div class="section-h">スプレッドシートと同期</div>
  <div class="card">
    <form class="form" id="syncForm">
      <label class="full">Apps Script のウェブアプリURL<input id="sUrl" type="url" value="${esc(s.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label class="full">トークン<input id="sToken" value="${esc(s.token)}" autocomplete="off" autocapitalize="off"></label>
      <div class="btn-row full" style="grid-column:1/-1">
        <button class="btn primary" type="submit">保存して同期</button>
        <button class="btn" type="button" data-action="sync">今すぐ同期</button>
      </div>
    </form>
    <dl class="kv" style="margin-top:12px">
      <dt>最終同期</dt><dd>${S.meta.lastSync ? new Date(S.meta.lastSync).toLocaleString('ja-JP') : 'まだ'}</dd>
      <dt>未送信の変更</dt><dd>${S.outbox}件</dd>
      ${S.meta.lastError ? `<dt>エラー</dt><dd style="color:var(--danger)">${esc(S.meta.lastError)}</dd>` : ''}
      <dt>端末内の保存</dt><dd id="storageInfo">確認中…</dd>
    </dl>
  </div>

  <div class="section-h">自分の音域（キー判定・「音域内」絞り込みの基準）</div>
  <div class="card"><div class="form">
    <label>最低音${noteSel('sLow', s.low)}</label>
    <label>最高音${noteSel('sHigh', s.high)}</label>
  </div></div>

  <div class="section-h">バックアップ</div>
  <div class="card">
    <div class="help" style="margin-bottom:10px">曲と点数を1つのファイルに書き出します（PDFはGoogleドライブに保管されています）。</div>
    <div class="btn-row">
      <button class="btn" data-action="export">書き出す</button>
      <button class="btn" data-action="import">読み込む</button>
      <input type="file" id="importInput" accept="application/json,.json" hidden>
    </div>
  </div>

  <div class="section-h">はじめての設定手順</div>
  <div class="card help">
    <ol>
      <li>スプレッドシートを開き、念のため「ファイル → コピーを作成」でバックアップを取る</li>
      <li>「拡張機能 → Apps Script」を開き、<code>Code.gs</code> の中身をすべて貼り付けて保存</li>
      <li>関数「setup」を選んで実行し、権限を許可する。実行ログに表示されるトークンを控える</li>
      <li>「デプロイ → 新しいデプロイ → 種類: ウェブアプリ」、実行ユーザー「自分」、アクセス「全員」でデプロイし、URLをコピー</li>
      <li>上の欄にURLとトークンを入れて「保存して同期」</li>
      <li>iPhone/iPad の Safari でこのページを開き、共有ボタン →「ホーム画面に追加」。ホーム画面から開くと、オフラインでも使え、データが自動で消されにくくなります</li>
    </ol>
  </div>
  <div class="help" style="text-align:center;margin:20px 0">カラオケ帳 v1</div>`;
}

async function refreshStorageInfo() {
  const el = $('#storageInfo');
  if (!el) return;
  let txt = '';
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    txt += persisted ? '保護済み（自動削除されません）' : '未保護（ホーム画面に追加すると保護されやすくなります）';
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      txt += `・使用量 ${(e.usage / 1024 / 1024).toFixed(1)}MB`;
    }
  } catch { txt = '不明'; }
  el.textContent = txt;
}

// ============================================================
// フォーム
// ============================================================
const modal = $('#modal');
function openModal(html) {
  modal.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  S.pendingSetlistItem = null;
  modal.hidden = true;
  modal.innerHTML = '';
  document.body.style.overflow = '';
}

function scoreForm(score, presetTitle) {
  const isNew = !score;
  const s = score || { date: todayIso(), title: presetTitle || '', machine: S.settings.lastMachine || 'Ai' };
  const titles = [...new Set(S.songs.map(x => x.title))];
  const keys = ['原キー', ...[1, 2, 3, 4, 5, 6, 7].map(n => `♯${n}`), ...[1, 2, 3, 4, 5, 6, 7].map(n => `♭${n}`), 'サビカラ'];
  const machineOpts = [...new Set([...MACHINES, s.machine].filter(Boolean))];
  const v = x => (x == null ? '' : esc(x));
  openModal(`
    <div class="sheet-head"><button data-action="close-modal">キャンセル</button><h2>${isNew ? '点数を記録' : '記録を編集'}</h2><button data-action="save-score">保存</button></div>
    <form class="form" id="scoreForm" data-id="${score?.id || ''}">
      <label class="full">曲名<input name="title" list="titleList" value="${v(s.title)}" required autocomplete="off"><datalist id="titleList">${titles.map(t => `<option value="${esc(t)}">`).join('')}</datalist></label>
      <label>日付<input name="date" type="date" value="${v(s.date)}"></label>
      <label>機種<select name="machine">${machineOpts.map(m => `<option ${m === s.machine ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label>総合得点<input name="point" inputmode="decimal" value="${v(s.point)}" placeholder="92.345"></label>
      <label>ボーナス点<input name="bonus" inputmode="decimal" value="${v(s.bonus)}" placeholder="1.234"></label>
      <label>素点（自動）<output id="rawOut" class="calc">–</output></label>
      <label>キー<input name="key" list="keyList" value="${v(s.key)}" autocomplete="off"><datalist id="keyList">${keys.map(k => `<option value="${k}">`).join('')}</datalist></label>
      <div class="full chart-head">チャート</div>
      <div class="chart-grid">
        ${CHART.map(([k, l]) => `<label class="${k === 'choukan' ? 'heart-only' : ''}" ${k === 'choukan' && !isHeart(s.machine) ? 'hidden' : ''}>${l}${k === 'choukan' ? '<small>（Ai-Heart）</small>' : ''}<input name="${k}" inputmode="decimal" value="${v(s[k])}"></label>`).join('')}
        <label>チャート合計（自動）<output id="totalOut" class="calc">–</output></label>
        <label>抑揚<input name="yoku" inputmode="decimal" value="${v(s.yoku)}"></label>
      </div>
      ${s.ai != null ? `<div class="full help">旧項目「Ai/聴」: ${esc(s.ai)}（スプレッドシートにそのまま残っています）</div>` : ''}
      <label class="full">コメント<input name="comment" value="${v(s.comment)}" autocomplete="off"></label>
      ${isNew ? '' : '<div class="full" style="grid-column:1/-1"><button class="btn danger" type="button" data-action="delete-score">この記録を削除</button></div>'}
    </form>`);
  updateScoreCalc();
  if (isNew && !presetTitle) setTimeout(() => $('#scoreForm [name=title]').focus(), 50);
}

// 入力に合わせてチャート合計・素点を計算し、聴感の欄を機種で出し分ける
function updateScoreCalc() {
  const f = $('#scoreForm');
  if (!f) return;
  const heart = isHeart(f.machine.value);
  f.querySelector('.heart-only').hidden = !heart;
  const rec = { point: numOrNull(f.point.value), bonus: numOrNull(f.bonus.value) };
  CHART.forEach(([k]) => { rec[k] = k === 'choukan' && !heart ? null : numOrNull(f[k].value); });
  const total = chartTotal(rec), raw = rawScore(rec);
  $('#totalOut').textContent = total == null ? '–' : String(Math.round(total * 1000) / 1000);
  $('#rawOut').textContent = raw == null ? '–' : fmt3(raw);
}

async function submitScoreForm() {
  const form = $('#scoreForm');
  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  if (!title) { toast('曲名を入れてください'); return; }
  const point = numOrNull(fd.get('point'));
  if (fd.get('point') && point == null) { toast('点数は数字で入れてください'); return; }
  const id = form.dataset.id;
  const isNew = !id;
  const old = S.scores.find(s => s.id === id);
  const rec = {
    id: id || uid(),
    date: String(fd.get('date') || ''),
    title,
    point,
    machine: String(fd.get('machine') || ''),
    key: String(fd.get('key') || '').trim(),
    on: numOrNull(fd.get('on')), vlt: numOrNull(fd.get('vlt')), rhythm: numOrNull(fd.get('rhythm')), hyo: numOrNull(fd.get('hyo')), stab: numOrNull(fd.get('stab')),
    choukan: isHeart(fd.get('machine')) ? numOrNull(fd.get('choukan')) : null,
    yoku: numOrNull(fd.get('yoku')), ai: old?.ai ?? null, bonus: numOrNull(fd.get('bonus')),
    comment: String(fd.get('comment') || '').trim(),
  };
  if (!S.songs.some(s => s.title === title)) {
    if (confirm(`「${title}」は曲リストにありません。曲リストにも追加しますか？`)) {
      await saveSong(blankSong(title), null, true);
    }
  }
  const fields = isNew ? SCORE_FIELDS : SCORE_FIELDS.filter(f => (old?.[f] ?? null) !== (rec[f] ?? null));
  if (!isNew && !fields.length) { closeModal(); return; }
  await saveScore(rec, fields, isNew);
  const psi = S.pendingSetlistItem;
  if (isNew && psi) {
    const sl = S.setlists.find(x => x.id === psi.setlistId);
    const item = sl?.items[psi.index];
    if (item && item.title === title) { item.done = true; item.scoreId = rec.id; await saveSetlist(sl); }
  }
  S.settings.lastMachine = rec.machine;
  await idb.put('meta', S.settings, 'settings');
  closeModal();
  toast(isNew ? `記録しました：${title} ${fmt3(point)}` : '更新しました');
  render({ keepScroll: true });
}

const blankSong = title => ({ id: uid(), no: '', title, kana: '', artist: '', artistKana: '', status: '未履修', progress: '', caution: '', low: '', high: '', recKey: '', ref: '', request: '', memo: '' });

function songForm(song) {
  const isNew = !song;
  const s = song || blankSong('');
  const v = x => esc(x ?? '');
  const statuses = [...new Set(['OK', '未履修', s.status, ...S.songs.map(x => x.status)].filter(Boolean))];
  const noteSel = (name, val) => `<select name="${name}"><option value="">未設定</option>${[...new Set([val, ...NOTE_OPTIONS].filter(Boolean))].map(n => `<option ${n === val ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  openModal(`
    <div class="sheet-head"><button data-action="close-modal">キャンセル</button><h2>${isNew ? '曲を追加' : '曲を編集'}</h2><button data-action="save-song">保存</button></div>
    <form class="form" id="songForm" data-id="${song?.id || ''}">
      <label class="full">曲名<input name="title" value="${v(s.title)}" required autocomplete="off"></label>
      <label>曲名かな<input name="kana" value="${v(s.kana)}" autocomplete="off"></label>
      <label>状況<select name="status">${statuses.map(x => `<option ${x === s.status ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label>歌手<input name="artist" value="${v(s.artist)}" autocomplete="off"></label>
      <label>歌手かな<input name="artistKana" value="${v(s.artistKana)}" autocomplete="off"></label>
      <label>原キー最低音${noteSel('low', s.low)}</label>
      <label>原キー最高音${noteSel('high', s.high)}</label>
      <label>おすすめキー<input name="recKey" value="${v(s.recKey)}" autocomplete="off"></label>
      <label>進捗<select name="progress">${['', 'OK', 'NG'].concat(s.progress && !['', 'OK', 'NG'].includes(s.progress) ? [s.progress] : []).map(x => `<option value="${esc(x)}" ${x === (s.progress || '') ? 'selected' : ''}>${x || '未設定'}</option>`).join('')}</select></label>
      <label class="full">注意<input name="caution" value="${v(s.caution)}" placeholder="裏声曲、サビオク下 など" autocomplete="off"></label>
      <label class="full">参考音源（URL）<input name="ref" value="${v(s.ref)}" inputmode="url" autocomplete="off"></label>
      <label>リクエスト<input name="request" value="${v(s.request)}" autocomplete="off"></label>
      <label class="full">メモ（練習ポイントなど）<textarea name="memo">${v(s.memo)}</textarea></label>
      ${isNew ? '' : '<div class="full" style="grid-column:1/-1"><button class="btn danger" type="button" data-action="delete-song">この曲を削除</button></div>'}
    </form>`);
}

async function submitSongForm() {
  const form = $('#songForm');
  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  if (!title) { toast('曲名を入れてください'); return; }
  const id = form.dataset.id;
  const isNew = !id;
  const old = S.songs.find(s => s.id === id);
  if (S.songs.some(s => s.title === title && s.id !== id)) { toast('同じ曲名がすでにあります'); return; }
  const rec = { ...(old || blankSong(title)) };
  SONG_FIELDS.forEach(f => { if (fd.has(f)) rec[f] = String(fd.get(f) ?? '').trim(); });
  const fields = SONG_FIELDS.filter(f => (old?.[f] ?? '') !== rec[f]);
  if (!isNew && !fields.length) { closeModal(); return; }
  await saveSong(rec, fields, isNew);
  closeModal();
  S.tab = 'songs';
  S.songId = rec.id;
  render();
}

// ============================================================
// PDF ビューア
// ============================================================
let viewerState = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('読み込み失敗')); document.head.appendChild(s); });
}
async function openPdf(p) {
  const viewer = $('#viewer');
  const pages = $('#viewerPages');
  $('#viewerTitle').textContent = p.name;
  document.querySelectorAll('#viewer [data-action="zoom"]').forEach(b => { b.hidden = isAudio(p); });
  $('#viewerEdit').hidden = !isText(p);
  pages.innerHTML = '<div class="msg">読み込み中…</div>';
  viewer.hidden = false;
  try {
    let blob = await idb.get('pdfBlobs', p.id);
    if (!blob) {
      if (!navigator.onLine || !p.driveId) throw new Error(navigator.onLine ? 'まだアップロードされていないPDFです' : 'オフラインのため開けません。オンラインのときに一度開くか同期すると、以後はオフラインで見られます');
      pages.innerHTML = '<div class="msg">ダウンロード中…</div>';
      blob = await fetchPdfBlob(p);
    }
    if (isText(p)) {
      viewerState = { p, blob, text: true, zoom: viewerState?.text ? viewerState.zoom : 1 };
      pages.innerHTML = `<div class="text-view" style="font-size:${16 * viewerState.zoom}px">${esc(await blob.text()) || '<span style="color:#999">（空です）</span>'}</div>`;
      return;
    }
    if (isAudio(p)) {
      viewerState = { p, blob, audio: true, url: URL.createObjectURL(blob) };
      pages.innerHTML = `<div class="audio-wrap"><audio controls autoplay playsinline src="${viewerState.url}"></audio></div>`;
      return;
    }
    if (!window.pdfjsLib) {
      await loadScript('vendor/pdf.min.js');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    viewerState = { p, blob, doc, zoom: 1, token: 0 };
    await renderPdfPages();
  } catch (e) {
    pages.innerHTML = `<div class="msg">${esc(e.message || e)}</div>`;
  }
}
async function renderPdfPages() {
  const vs = viewerState;
  if (!vs) return;
  const token = ++vs.token;
  const pages = $('#viewerPages');
  pages.innerHTML = '';
  const width = Math.min(pages.clientWidth - 16, 1000) * vs.zoom;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (let i = 1; i <= vs.doc.numPages; i++) {
    if (token !== vs.token) return;
    const page = await vs.doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    c.style.width = `${vp.width / dpr}px`; c.style.height = `${vp.height / dpr}px`;
    pages.appendChild(c);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
}
function closeViewer() {
  $('#viewer').hidden = true;
  $('#viewerPages').innerHTML = '';
  viewerState?.doc?.destroy();
  if (viewerState?.url) URL.revokeObjectURL(viewerState.url);
  viewerState = null;
}

// ============================================================
// バックアップ
// ============================================================
async function exportBackup() {
  const data = { app: 'karaoke-app', version: 1, exportedAt: new Date().toISOString(), songs: S.songs, scores: S.scores, setlists: S.setlists, pdfs: S.pdfs.map(({ hasBlob, ...p }) => p) };
  const name = `karaoke-backup-${todayIso()}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('ファイルを読めませんでした'); return; }
  if (data.app !== 'karaoke-app' || !Array.isArray(data.songs) || !Array.isArray(data.scores)) { toast('カラオケ帳のバックアップではありません'); return; }
  if (!confirm(`曲${data.songs.length}件・記録${data.scores.length}件を読み込みます。\n端末内の曲・記録は置き換えられ、スプレッドシートにも反映されます。よろしいですか？`)) return;
  for (const s of S.songs) if (!data.songs.some(x => x.id === s.id)) await queue({ kind: 'song', op: 'delete', id: s.id });
  for (const s of S.scores) if (!data.scores.some(x => x.id === s.id)) await queue({ kind: 'score', op: 'delete', id: s.id });
  S.songs = data.songs; S.scores = data.scores;
  await idb.replace('songs', S.songs);
  await idb.replace('scores', S.scores);
  await saveOrder();
  for (const s of S.songs) { const d = {}; SONG_FIELDS.forEach(f => { d[f] = s[f] ?? ''; }); await queue({ kind: 'song', op: 'upsert', id: s.id, data: d }); }
  for (const s of S.scores) { const d = {}; SCORE_FIELDS.forEach(f => { d[f] = s[f] ?? ''; }); await queue({ kind: 'score', op: 'upsert', id: s.id, data: d }); }
  if (Array.isArray(data.setlists)) for (const sl of data.setlists) await saveSetlist(sl);
  changed();
  toast('読み込みました');
  render();
}

// ============================================================
// 操作
// ============================================================
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

document.addEventListener('click', async e => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    S.tab = tabBtn.dataset.tab;
    if (S.tab !== 'songs') S.songId = null;
    if (S.tab !== 'setlist') S.setlistId = null;
    else if (S.songId && !matchMedia('(min-width: 900px)').matches) S.songId = null;
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (e.target === modal) { closeModal(); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  if (el.tagName === 'A') e.preventDefault();
  switch (a) {
    case 'sync': sync({ manual: true }); break;
    case 'filter': S.filter[el.dataset.k] = S.filter[el.dataset.k] === el.dataset.v && el.dataset.k === 'sung' ? 'all' : el.dataset.v; render({ keepScroll: true }); break;
    case 'toggle': S.filter[el.dataset.k] = !S.filter[el.dataset.k]; render({ keepScroll: true }); break;
    case 'open-song':
      S.songId = id;
      if (matchMedia('(min-width: 900px)').matches) render({ keepScroll: true }); else { render(); window.scrollTo(0, 0); }
      break;
    case 'open-song-title': {
      const s = S.songs.find(x => x.title === el.dataset.title);
      if (s) { S.tab = 'songs'; S.songId = s.id; render(); window.scrollTo(0, 0); } else toast('曲リストにない曲です');
      break;
    }
    case 'new-song': songForm(null); break;
    case 'edit-song': songForm(S.songs.find(s => s.id === id)); break;
    case 'save-song': submitSongForm(); break;
    case 'delete-song': {
      const s = S.songs.find(x => x.id === $('#songForm').dataset.id);
      if (s && confirm(`「${s.title}」を曲リストから削除しますか？\n（点数の記録は残ります。添付PDFは削除されます）`)) {
        await deleteSong(s); closeModal(); S.songId = null; render();
      }
      break;
    }
    case 'new-score': scoreForm(null, el.dataset.title || (S.tab === 'songs' && S.songId ? S.songs.find(s => s.id === S.songId)?.title : '')); break;
    case 'edit-score': scoreForm(S.scores.find(s => s.id === id)); break;
    case 'save-score': submitScoreForm(); break;
    case 'delete-score': {
      const s = S.scores.find(x => x.id === $('#scoreForm').dataset.id);
      if (s && confirm(`${fmtDate(s.date)}「${s.title}」${fmt3(s.point)} の記録を削除しますか？`)) {
        await deleteScore(s); closeModal(); render({ keepScroll: true });
      }
      break;
    }
    case 'close-modal': closeModal(); break;
    case 'more-log': S.logLimit += 300; render({ keepScroll: true }); break;
    case 'stats-machine': S.stats.machine = el.dataset.v; render({ keepScroll: true }); break;
    case 'rank-by': S.stats.rankBy = el.dataset.v; render({ keepScroll: true }); break;
    case 'rank-min3': S.stats.rankMin3 = !S.stats.rankMin3; render({ keepScroll: true }); break;
    case 'add-pdf': $('#pdfInput').click(); break;
    case 'new-text': textForm(S.songs.find(s => s.id === id), null); break;
    case 'edit-text': {
      const meta = viewerState?.p;
      const song = meta && S.songs.find(s => s.id === meta.songId);
      if (song) textForm(song, meta); else toast('曲が見つかりません');
      break;
    }
    case 'save-text': submitTextForm(); break;
    case 'add-audio': $('#audioInput').click(); break;
    case 'record': toggleRecording(S.songs.find(s => s.id === id)); break;
    case 'new-setlist': {
      const sl = { id: uid(), date: todayIso(), name: `${fmtDate(todayIso())} のカラオケ`, items: [] };
      await saveSetlist(sl);
      S.setlistId = sl.id; S.pick.result = null; render(); window.scrollTo(0, 0);
      break;
    }
    case 'open-setlist': S.setlistId = id; S.pick.result = null; render(); window.scrollTo(0, 0); break;
    case 'rename-setlist': {
      const sl = curSetlist();
      const name = prompt('セトリの名前', sl.name);
      if (name != null) { sl.name = name.trim() || sl.name; await saveSetlist(sl); render({ keepScroll: true }); }
      break;
    }
    case 'delete-setlist': {
      const sl = curSetlist();
      if (confirm(`「${sl.name}」を削除しますか？（点数の記録は残ります）`)) { await deleteSetlist(sl); S.setlistId = null; render(); }
      break;
    }
    case 'sl-add': await addToSetlist(el.dataset.title); break;
    case 'sl-move': {
      const sl = curSetlist(); const i = +el.dataset.i, j = i + +el.dataset.d;
      if (j >= 0 && j < sl.items.length) { [sl.items[i], sl.items[j]] = [sl.items[j], sl.items[i]]; await saveSetlist(sl); render({ keepScroll: true }); }
      break;
    }
    case 'sl-remove': { const sl = curSetlist(); sl.items.splice(+el.dataset.i, 1); await saveSetlist(sl); render({ keepScroll: true }); break; }
    case 'sl-toggle': { const sl = curSetlist(); const it = sl.items[+el.dataset.i]; it.done = !it.done; await saveSetlist(sl); render({ keepScroll: true }); break; }
    case 'sl-score': {
      const sl = curSetlist(); const i = +el.dataset.i;
      scoreForm(null, sl.items[i].title);
      S.pendingSetlistItem = { setlistId: sl.id, index: i };
      break;
    }
    case 'pick-mode': S.pick.mode = el.dataset.v; S.pick.result = null; render({ keepScroll: true }); break;
    case 'pick-opt': S.pick[el.dataset.k] = !S.pick[el.dataset.k]; S.pick.result = null; render({ keepScroll: true }); break;
    case 'pick-roll': S.pick.result = rollRandom(curSetlist()); render({ keepScroll: true }); break;
    case 'open-pdf': openPdf(S.pdfs.find(p => p.id === id)); break;
    case 'del-pdf': {
      const p = S.pdfs.find(x => x.id === id);
      if (p && confirm(`「${p.name}」を削除しますか？\n（Googleドライブではゴミ箱に移るので30日以内なら復元できます）`)) { await deletePdf(p); render({ keepScroll: true }); }
      break;
    }
    case 'close-viewer': closeViewer(); break;
    case 'zoom': if (viewerState?.text) {
      viewerState.zoom = Math.min(2.5, Math.max(0.75, viewerState.zoom + Number(el.dataset.z) * 0.125));
      $('#viewerPages .text-view').style.fontSize = `${16 * viewerState.zoom}px`;
    } else if (viewerState) { viewerState.zoom = Math.min(3, Math.max(0.5, viewerState.zoom + Number(el.dataset.z) * 0.25)); renderPdfPages(); } break;
    case 'share-pdf': {
      if (!viewerState) break;
      const f = new File([viewerState.blob], viewerState.p.name, { type: viewerState.p.mime || 'application/pdf' });
      if (navigator.canShare?.({ files: [f] })) navigator.share({ files: [f] }).catch(() => {});
      else window.open(URL.createObjectURL(f), '_blank');
      break;
    }
    case 'export': exportBackup(); break;
    case 'import': $('#importInput').click(); break;
  }
});

$('#backBtn').addEventListener('click', () => { if (S.tab === 'setlist') S.setlistId = null; else S.songId = null; render(); });

document.addEventListener('input', e => {
  if (e.target.id === 'q') { S.filter.q = e.target.value; renderSongList(); }
  if (e.target.closest?.('#scoreForm')) updateScoreCalc();
  if (e.target.id === 'pickQ') { S.pick.q = e.target.value; renderPickSearch(); }
  if (e.target.id === 'slDate') { const sl = curSetlist(); if (sl && e.target.value) { sl.date = e.target.value; saveSetlist(sl); } }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.closest?.('#scoreForm')) updateScoreCalc();
  if (t.id === 'sort') { S.filter.sort = t.value; renderSongList(); }
  if (t.id === 'sLow' || t.id === 'sHigh') {
    S.settings[t.id === 'sLow' ? 'low' : 'high'] = t.value;
    await idb.put('meta', S.settings, 'settings');
    toast('音域を保存しました');
  }
  if ((t.id === 'pdfInput' || t.id === 'audioInput') && t.files.length) {
    const song = S.songs.find(s => s.id === t.dataset.id);
    if (song) { await addFiles(song, [...t.files]); render({ keepScroll: true }); toast('追加しました'); }
  }
  if (t.id === 'importInput' && t.files[0]) importBackup(t.files[0]);
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'syncForm') {
    S.settings.url = $('#sUrl').value.trim();
    S.settings.token = $('#sToken').value.trim();
    await idb.put('meta', S.settings, 'settings');
    S.meta.lastError = '';
    await sync({ manual: true });
    if (!S.meta.lastError) toast(`同期しました（曲${S.songs.length}・記録${S.scores.length}）`);
  }
  if (e.target.id === 'scoreForm') submitScoreForm();
  if (e.target.id === 'songForm') submitSongForm();
  if (e.target.id === 'textForm') submitTextForm();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!$('#viewer').hidden) closeViewer(); else if (!modal.hidden) closeModal(); }
});

window.addEventListener('online', () => { updateSyncChip(); scheduleSync(500); });
window.addEventListener('offline', updateSyncChip);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(500); });
let lastWide = matchMedia('(min-width: 900px)').matches;
window.addEventListener('resize', () => {
  const w = matchMedia('(min-width: 900px)').matches;
  if (w !== lastWide) { lastWide = w; if (S.tab === 'songs') render(); }
});
setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 5 * 60 * 1000);

// ============================================================
// 起動
// ============================================================
(async function start() {
  try {
    db = await openDB();
    await loadAll();
  } catch (e) {
    main.innerHTML = `<div class="card empty">端末内のデータを開けませんでした：${esc(e.message || e)}<br>プライベートブラウズでは保存できません。</div>`;
    return;
  }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // ブラウザにデータを自動削除しないよう依頼する
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  scheduleSync(300);
})();
