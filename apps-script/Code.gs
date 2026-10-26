/**
 * カラオケ帳 同期サーバー（Googleスプレッドシートにバインドして使う Apps Script）
 *
 * - 「曲リスト」「カラオケ歌ったリスト」をアプリと双方向に同期する
 * - 数式が入っているセルには絶対に書き込まない（Ave/Max/RANK などの計算列は壊さない）
 * - 各行を識別するため、表の右端に「_id」列を追加する（初回のみ）
 * - PDF・練習録音は Google ドライブの「カラオケ帳_PDF」フォルダに保存し、一覧を「_app_pdfs」シートで管理する
 * - セトリは「_app_setlists」シート（非表示）に保存する
 */

const CONFIG = {
  SONG_SHEET: '曲リスト',
  SCORE_SHEET: 'カラオケ歌ったリスト',
  PDF_SHEET: '_app_pdfs',
  SETLIST_SHEET: '_app_setlists',
  PDF_FOLDER: 'カラオケ帳_PDF',
};

// アプリのフィールド名 → シートの見出し（見出しは最初の空白より前の部分で照合する）
const SONG_COLS = {
  no: '番号', title: '曲名', status: '状況', progress: '進捗', caution: '注意',
  low: '原キー最低音', high: '原キー最高音', recKey: 'おすすめキー',
  kana: '曲名かな', artist: '歌手', artistKana: '歌手かな',
  ref: '参考音源', request: 'リクエスト', memo: 'メモ(app)', id: '_id',
};
const SCORE_COLS = {
  date: 'Date', title: 'name', point: 'point', machine: '機種とキー',
  on: '音', hyo: '表', yoku: '抑', ai: 'Ai/聴', bonus: '加点',
  comment: 'コメント', key: 'キー', id: '_id',
};
// 見つからなければ右端に追加する列
const APP_COLS = ['_id', 'メモ(app)'];
const SCORE_NUMERIC = ['point', 'on', 'hyo', 'yoku', 'ai', 'bonus'];
const PDF_HEADERS = ['id', 'songId', 'songTitle', 'name', 'driveId', 'size', 'updatedAt', 'mime'];
const SETLIST_HEADERS = ['id', 'date', 'name', 'json', 'updatedAt'];

const TABLES = {
  song: {
    sheet: CONFIG.SONG_SHEET, cols: SONG_COLS, keyHeader: '曲名',
    isData: r => { const t = str_(r.title); return t !== '' && t !== 'me'; },
  },
  score: {
    sheet: CONFIG.SCORE_SHEET, cols: SCORE_COLS, keyHeader: 'name',
    isData: r => str_(r.title) !== '',
  },
};

/** 最初に一度だけ手動で実行する：トークン発行と列の準備 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty('TOKEN', token);
  }
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(k => assignIds_(openTable_(ss, TABLES[k])));
  pdfSheet_(ss);
  setlistSheet_(ss);
  Logger.log('アプリの設定画面に貼り付けるトークン: ' + token);
}

function doGet() {
  return ContentService.createTextOutput('カラオケ帳 同期サーバーは動いています');
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ error: 'リクエストを読めませんでした' });
  }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || req.token !== token) return json_({ error: 'トークンが違います' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ error: '他の端末が同期中です。少し待って再試行してください' });
  try {
    switch (req.action) {
      case 'ping': return json_({ ok: true });
      case 'sync': return json_(sync_(req.ops || []));
      case 'pdfUpload': return json_(pdfUpload_(req.pdf, req.b64));
      case 'pdfGet': return json_(pdfGet_(req.id));
      default: return json_({ error: '不明な操作: ' + req.action });
    }
  } catch (err) {
    return json_({ error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------- 同期本体 ----------

function sync_(ops) {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(kind => {
    const mine = ops.filter(o => o.kind === kind);
    if (mine.length) applyOps_(openTable_(ss, TABLES[kind]), mine);
  });
  ops.filter(o => o.kind === 'pdf' && o.op === 'delete').forEach(o => pdfDelete_(ss, o.id));
  applySetlistOps_(ss, ops.filter(o => o.kind === 'setlist'));

  const songs = openTable_(ss, TABLES.song);
  const scores = openTable_(ss, TABLES.score);
  assignIds_(songs);
  assignIds_(scores);
  return {
    songs: readRecords_(songs, ss),
    scores: readRecords_(scores, ss),
    pdfs: listPdfs_(ss),
    setlists: listSetlists_(ss),
    serverTime: Date.now(),
  };
}

function applyOps_(t, ops) {
  const idToRow = {};
  t.rows.forEach(r => { if (r.rec.id) idToRow[r.rec.id] = r.row; });
  let nextRow = t.lastDataRow + 1;
  let maxNo = t.rows.reduce((m, r) => Math.max(m, Number(r.rec.no) || 0), 0);
  const deletes = [];

  ops.forEach(op => {
    if (op.op === 'delete') {
      if (idToRow[op.id]) deletes.push(idToRow[op.id]);
      return;
    }
    if (op.op !== 'upsert') return;
    let row = idToRow[op.id];
    const data = Object.assign({}, op.data, { id: op.id });
    delete data.no; // 番号はアプリから変更しない
    if (!row) {
      row = nextRow++;
      if (row > t.sheet.getMaxRows()) t.sheet.insertRowsAfter(t.sheet.getMaxRows(), row - t.sheet.getMaxRows());
      idToRow[op.id] = row;
      if (t.idx.no !== undefined) data.no = ++maxNo; // 曲リストの「番号」を連番で振る
    }
    writeRow_(t, row, data);
  });

  deletes.sort((a, b) => b - a).forEach(r => t.sheet.deleteRow(r));
}

function writeRow_(t, row, data) {
  const formulas = t.sheet.getRange(row, 1, 1, t.width).getFormulas()[0];
  Object.keys(data).forEach(field => {
    const ci = t.idx[field];
    if (ci === undefined || formulas[ci]) return; // 数式セルには触れない
    const cell = t.sheet.getRange(row, ci + 1);
    let v = data[field];
    if (field === 'date' && v) {
      const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (m) {
        v = new Date(+m[1], +m[2] - 1, +m[3]);
        if (row > t.headerRow + 1) cell.setNumberFormat(t.sheet.getRange(row - 1, ci + 1).getNumberFormat());
      }
    } else if (t.cols === SCORE_COLS && SCORE_NUMERIC.indexOf(field) >= 0) {
      v = (v === null || v === undefined || v === '') ? '' : Number(v);
    } else {
      v = v === null || v === undefined ? '' : v;
    }
    cell.setValue(v);
  });
}

// ---------- 表の読み取り ----------

function openTable_(ss, def) {
  const sheet = ss.getSheetByName(def.sheet);
  if (!sheet) throw new Error('シート「' + def.sheet + '」が見つかりません');
  let width = Math.max(sheet.getLastColumn(), 1);
  const scan = Math.min(5, sheet.getMaxRows());
  const top = sheet.getRange(1, 1, scan, width).getValues();
  const hi = top.findIndex(r => r.some(c => norm_(c) === def.keyHeader));
  if (hi < 0) throw new Error('「' + def.sheet + '」で見出し「' + def.keyHeader + '」が見つかりません');
  const headerRow = hi + 1;
  const headers = top[hi].map(norm_);

  const idx = {};
  Object.keys(def.cols).forEach(field => {
    const h = def.cols[field];
    let i = headers.indexOf(h);
    if (i < 0 && APP_COLS.indexOf(h) >= 0) {
      if (width + 1 > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
      width++;
      sheet.getRange(headerRow, width).setValue(h);
      headers[width - 1] = h;
      i = width - 1;
    }
    if (i >= 0) idx[field] = i;
  });

  const lastRow = sheet.getLastRow();
  const n = Math.max(0, lastRow - headerRow);
  const values = n ? sheet.getRange(headerRow + 1, 1, n, width).getValues() : [];
  const rows = [];
  let lastDataRow = headerRow;
  values.forEach((v, i) => {
    const rec = {};
    Object.keys(idx).forEach(f => { rec[f] = v[idx[f]]; });
    if (def.isData(rec)) {
      rows.push({ row: headerRow + 1 + i, rec: rec });
      lastDataRow = headerRow + 1 + i;
    }
  });
  return { sheet, cols: def.cols, headerRow, width, idx, rows, lastDataRow };
}

function assignIds_(t) {
  const col = t.idx.id;
  const missing = t.rows.filter(r => !str_(r.rec.id));
  if (!missing.length) return;
  // 連続していない行にもまとめて書けるよう、_id 列全体を書き直す
  const first = t.headerRow + 1;
  const n = t.lastDataRow - t.headerRow;
  const range = t.sheet.getRange(first, col + 1, n, 1);
  const cur = range.getValues();
  missing.forEach(r => {
    r.rec.id = Utilities.getUuid();
    cur[r.row - first][0] = r.rec.id;
  });
  range.setValues(cur);
}

function readRecords_(t, ss) {
  const tz = ss.getSpreadsheetTimeZone();
  return t.rows.map(r => {
    const out = {};
    Object.keys(r.rec).forEach(f => {
      const v = r.rec[f];
      if (f === 'date') out.date = toIsoDate_(v, tz);
      else if (t.cols === SCORE_COLS && SCORE_NUMERIC.indexOf(f) >= 0) out[f] = toNum_(v);
      else out[f] = str_(v);
    });
    return out;
  });
}

// ---------- PDF ----------

function pdfSheet_(ss) {
  let sh = ss.getSheetByName(CONFIG.PDF_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.PDF_SHEET);
    sh.getRange(1, 1, 1, PDF_HEADERS.length).setValues([PDF_HEADERS]);
    sh.hideSheet();
  } else if (sh.getRange(1, PDF_HEADERS.length).getValue() !== 'mime') {
    sh.getRange(1, PDF_HEADERS.length).setValue('mime');
  }
  return sh;
}

function pdfFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PDF_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 削除されていたら作り直す */ }
  }
  const folder = DriveApp.createFolder(CONFIG.PDF_FOLDER);
  props.setProperty('PDF_FOLDER_ID', folder.getId());
  return folder;
}

function listPdfs_(ss) {
  const sh = pdfSheet_(ss);
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, PDF_HEADERS.length).getValues()
    .filter(r => r[0])
    .map(r => {
      const o = {};
      PDF_HEADERS.forEach((h, i) => { o[h] = h === 'size' || h === 'updatedAt' ? Number(r[i]) || 0 : str_(r[i]); });
      return o;
    });
}

function findPdfRow_(sh, id) {
  const n = sh.getLastRow() - 1;
  if (n <= 0) return -1;
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}

function pdfUpload_(pdf, b64) {
  const ss = SpreadsheetApp.getActive();
  const sh = pdfSheet_(ss);
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), pdf.mime || 'application/pdf', pdf.name);
  const file = pdfFolder_().createFile(blob);
  const rowVals = [pdf.id, pdf.songId, pdf.songTitle || '', pdf.name, file.getId(), blob.getBytes().length, pdf.updatedAt || Date.now(), pdf.mime || 'application/pdf'];
  const row = findPdfRow_(sh, pdf.id);
  if (row > 0) {
    const oldId = sh.getRange(row, 5).getValue();
    if (oldId) { try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) { /* 既に無い */ } }
    sh.getRange(row, 1, 1, rowVals.length).setValues([rowVals]);
  } else {
    sh.appendRow(rowVals);
  }
  return { driveId: file.getId() };
}

function pdfDelete_(ss, id) {
  const sh = pdfSheet_(ss);
  const row = findPdfRow_(sh, id);
  if (row < 0) return;
  const driveId = sh.getRange(row, 5).getValue();
  // ゴミ箱に移すだけなので、ドライブから30日間は復元できる
  if (driveId) { try { DriveApp.getFileById(driveId).setTrashed(true); } catch (e) { /* 既に無い */ } }
  sh.deleteRow(row);
}

function pdfGet_(id) {
  const sh = pdfSheet_(SpreadsheetApp.getActive());
  const row = findPdfRow_(sh, id);
  if (row < 0) return { error: 'PDFが見つかりません' };
  const driveId = sh.getRange(row, 5).getValue();
  const bytes = DriveApp.getFileById(driveId).getBlob().getBytes();
  return { b64: Utilities.base64Encode(bytes), mime: str_(sh.getRange(row, 8).getValue()) || 'application/pdf' };
}

// ---------- セトリ ----------

function setlistSheet_(ss) {
  let sh = ss.getSheetByName(CONFIG.SETLIST_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SETLIST_SHEET);
    sh.getRange(1, 1, 1, SETLIST_HEADERS.length).setValues([SETLIST_HEADERS]);
    sh.hideSheet();
  }
  return sh;
}

function applySetlistOps_(ss, ops) {
  if (!ops.length) return;
  const sh = setlistSheet_(ss);
  ops.forEach(op => {
    const row = findPdfRow_(sh, op.id); // 1列目が id の表なら同じ探し方でよい
    if (op.op === 'delete') {
      if (row > 0) sh.deleteRow(row);
      return;
    }
    const d = op.data || {};
    const vals = [op.id, d.date || '', d.name || '', JSON.stringify(d.items || []), d.updatedAt || Date.now()];
    if (row > 0) sh.getRange(row, 1, 1, vals.length).setValues([vals]);
    else sh.appendRow(vals);
  });
}

function listSetlists_(ss) {
  const sh = setlistSheet_(ss);
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, SETLIST_HEADERS.length).getValues()
    .filter(r => r[0])
    .map(r => {
      let items = [];
      try { items = JSON.parse(r[3] || '[]'); } catch (e) { /* 壊れていたら空にする */ }
      return { id: str_(r[0]), date: toIsoDate_(r[1], ss.getSpreadsheetTimeZone()), name: str_(r[2]), items: items, updatedAt: Number(r[4]) || 0 };
    });
}

// ---------- 小物 ----------

function norm_(v) {
  return String(v === null || v === undefined ? '' : v).trim().split(/\s+/)[0];
}

function str_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

function toNum_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function toIsoDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const m = String(v || '').trim().match(/^(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (!m) return '';
  const y = m[1].length <= 2 ? 2000 + Number(m[1]) : Number(m[1]);
  return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
