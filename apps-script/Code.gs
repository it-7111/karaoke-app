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
// 配列は「新しい見出し, 作り替え前の見出し」の順で探す
const SCORE_COLS = {
  date: 'Date', title: 'name', point: ['総合得点', 'point'], machine: '機種とキー',
  on: ['音程', '音'], vlt: 'ビブラート&ロングトーン', rhythm: 'リズム', hyo: ['表現力', '表'],
  stab: '安定性', choukan: '聴感', yoku: ['抑揚', '抑'], ai: 'Ai/聴', bonus: ['ボーナス点', '加点'],
  comment: 'コメント', key: 'キー', id: '_id',
};
// チャート合計・素点は数式で計算する列（アプリからは書き込まない）
const CHART_ITEMS = ['音程', 'ビブラート&ロングトーン', 'リズム', '表現力', '安定性', '聴感'];
// 見つからなければ右端に追加する列
const APP_COLS = ['_id', 'メモ(app)'];
const SCORE_NUMERIC = ['point', 'on', 'vlt', 'rhythm', 'hyo', 'stab', 'choukan', 'yoku', 'ai', 'bonus'];
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
  const headers = top[hi].slice();

  const idx = {};
  Object.keys(def.cols).forEach(field => {
    const names = [].concat(def.cols[field]);
    const h = names[0];
    let i = -1;
    names.some(n => (i = findHeader_(headers, n)) >= 0);
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

// ---------- 「カラオケ歌ったリスト」の作り替え（一度だけ手動で実行） ----------

/**
 * 評価項目を「音程・ビブラート&ロングトーン・リズム・表現力・安定性・聴感・チャート合計・抑揚」の並びにし、
 * 素点（総合得点 − ボーナス点）の列を足す。旧データの値は書き換えない。
 * 実行するとまずスプレッドシート全体のコピーをドライブに作る。
 */
function migrateScoreSheet() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CONFIG.SCORE_SHEET);
  if (!sh) throw new Error('シート「' + CONFIG.SCORE_SHEET + '」が見つかりません');
  const top = sh.getRange(1, 1, Math.min(5, sh.getMaxRows()), sh.getLastColumn()).getValues();
  const hr = top.findIndex(r => r.some(c => norm_(c) === 'name')) + 1;
  if (hr < 1) throw new Error('見出し「name」が見つかりません');
  const col = name => findHeader_(sh.getRange(hr, 1, 1, sh.getLastColumn()).getValues()[0], name) + 1;
  if (col('チャート合計')) throw new Error('すでに作り替え済みです');
  ['音', '表', '抑', 'point', '加点'].forEach(h => { if (!col(h)) throw new Error('見出し「' + h + '」が見つかりません'); });

  // 他のシートの QUERY などは列の位置を文字で持っているので、列を足すとずれることがある
  const risky = formulasToCheck_(ss);

  const tz = ss.getSpreadsheetTimeZone();
  const backup = DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' バックアップ ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HHmm'));
  Logger.log('バックアップを作りました: ' + backup.getUrl());

  [['point', '総合得点'], ['音', '音程'], ['表', '表現力'], ['抑', '抑揚'], ['加点', 'ボーナス点']]
    .forEach(([from, to]) => sh.getRange(hr, col(from)).setValue(to));

  sh.insertColumnsAfter(col('音程'), 2);
  sh.getRange(hr, col('音程') + 1, 1, 2).setValues([['ビブラート&ロングトーン', 'リズム']]);
  sh.insertColumnsAfter(col('表現力'), 3);
  sh.getRange(hr, col('表現力') + 1, 1, 3).setValues([['安定性', '聴感', 'チャート合計']]);
  if (col('抑揚') !== col('チャート合計') + 1) {
    sh.moveColumns(sh.getRange(1, col('抑揚'), sh.getMaxRows(), 1), col('チャート合計') + 1);
  }
  sh.insertColumnBefore(col('ボーナス点'));
  sh.getRange(hr, col('ボーナス点') - 1).setValue('素点');

  // 1つの数式で全行を計算する（行を足しても自動で計算される）
  const r = hr + 1;
  const L = name => colLetter_(col(name)) + r + ':' + colLetter_(col(name));
  const items = CHART_ITEMS.map(L);
  sh.getRange(r, col('チャート合計')).setFormula(
    '=ARRAYFORMULA(IF((' + L('name') + '="")+(' + items.map(x => '(' + x + '="")').join('*') + '),"",' + items.join('+') + '))');
  sh.getRange(r, col('素点')).setFormula(
    '=ARRAYFORMULA(IF((' + L('name') + '="")+(' + L('総合得点') + '="")+(' + L('ボーナス点') + '=""),"",ROUND(' + L('総合得点') + '-' + L('ボーナス点') + ',3)))');

  Logger.log('作り替えが終わりました。新しい並び: ' + sh.getRange(hr, 1, 1, sh.getLastColumn()).getValues()[0].filter(String).join(' | '));
  if (risky.length) {
    Logger.log('次の数式は列の位置を文字で参照している可能性があります。結果がずれていないか確認してください:');
    risky.forEach(x => Logger.log(x));
  } else {
    Logger.log('列の位置を文字で参照する数式は見つかりませんでした。');
  }
  Logger.log('最後に「デプロイ → デプロイを管理 → 編集 → バージョン: 新バージョン」で同期サーバーを更新してください。');
}

function formulasToCheck_(ss) {
  const out = [];
  ss.getSheets().forEach(sh => {
    if (sh.getLastRow() === 0 || sh.getLastColumn() === 0) return;
    const f = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getFormulas();
    f.forEach((row, i) => row.forEach((x, j) => {
      if (!x) return;
      const refersHere = x.indexOf(CONFIG.SCORE_SHEET) >= 0 || sh.getName() === CONFIG.SCORE_SHEET;
      if (refersHere && /QUERY|INDIRECT|INDEX|OFFSET|VLOOKUP|HLOOKUP/i.test(x)) {
        out.push(sh.getName() + '!' + colLetter_(j + 1) + (i + 1) + '  ' + x.slice(0, 160));
      }
    }));
  });
  return out;
}

function colLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// ---------- 「カラオケ点数リスト」に機種ごとの評価項目を足す（一度だけ手動で実行） ----------

const SUMMARY_SHEET = 'カラオケ点数リスト';

/**
 * 全体・WAO・Ai・Dx の各ブロック（平均点〜加点の8列）に、
 * ビブラート&ロングトーン・リズム・安定性・聴感（全体とWAOのみ）・チャート合計・素点の平均の列を足す。
 * 既存の列は名前だけ「音程・表現力・抑揚・Ai/聴(旧)・ボーナス点」に揃え、数式はそのまま使う。
 * 列の挿入なので、「点数分布」や ALL_RANK など他のシートからの参照はスプレッドシートが自動で付け替える。
 */
function upgradeScoreSummary() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SUMMARY_SHEET);
  const log = ss.getSheetByName(CONFIG.SCORE_SHEET);
  if (!sh || !log) throw new Error('「' + SUMMARY_SHEET + '」または「' + CONFIG.SCORE_SHEET + '」が見つかりません');
  const head = () => sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (findHeader_(head(), 'チャート合計') >= 0) throw new Error('すでに追加済みです');

  // 「カラオケ歌ったリスト」側の列（見出しで探す）
  const logHead = log.getRange(1, 1, 1, log.getLastColumn()).getValues()[0];
  const src = {};
  ['ビブラート&ロングトーン', 'リズム', '安定性', '聴感', 'チャート合計', '素点'].forEach(n => {
    const i = findHeader_(logHead, n);
    if (i < 0) throw new Error('「' + CONFIG.SCORE_SHEET + '」に見出し「' + n + '」がありません。先に migrateScoreSheet を実行してください');
    src[n] = colLetter_(i + 1);
  });

  // 平均点の列ごとにブロックを見つけ、2行目の数式から機種を読み取る
  const h = head();
  const f2 = sh.getRange(2, 1, 1, sh.getLastColumn()).getFormulas()[0];
  const blocks = [];
  h.forEach((v, i) => {
    if (norm_(v) !== '平均点') return;
    const m = String(f2[i]).match(/"="&"([^"]+)"/);
    const end = (String(f2[i]).match(/B\$?2:\$?B\$?(\d+)/) || [])[1] || '1552';
    blocks.push({ col: i + 1, machine: m ? m[1] : '', end: end });
  });
  if (!blocks.length) throw new Error('「平均点」の列が見つかりません');

  const backup = DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' バックアップ ' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HHmm'));
  Logger.log('バックアップを作りました: ' + backup.getUrl());

  const L = "'" + CONFIG.SCORE_SHEET + "'!";
  const avgFormula = (letter, b) => '=IF($B$2:$B' + b.end + '="","",BYROW($B$2:$B' + b.end + ',LAMBDA(a,IFERROR(AVERAGEIFS(' +
    L + letter + '$2:' + letter + b.end + ',' + L + '$B$2:$B' + b.end + ',"="&a' +
    (b.machine ? ',' + L + '$D$2:$D' + b.end + ',"="&"' + b.machine + '"' : '') + '),""))))';
  const put = (c, name, b) => {
    sh.getRange(1, c).setValue(name);
    sh.getRange(2, c).setFormula(avgFormula(src[name], b));
  };

  // 右のブロックから処理すると、左のブロックの位置がずれない
  blocks.sort((a, b) => b.col - a.col).forEach(b => {
    const s = b.col; // s:平均点 s+1:最高点 s+2:最低点 s+3:音 s+4:表 s+5:抑 s+6:Ai/聴 s+7:加点
    sh.getRange(1, s + 3, 1, 5).setValues([['音程', '表現力', '抑揚', 'Ai/聴(旧)', 'ボーナス点']]);
    sh.insertColumnsAfter(s + 7, 1);            // ボーナス点の右に素点
    put(s + 8, '素点', b);
    const after = ['安定性'].concat(!b.machine || b.machine === 'WAO' ? ['聴感'] : [], ['チャート合計']);
    sh.insertColumnsAfter(s + 4, after.length); // 表現力の右
    after.forEach((n, k) => put(s + 5 + k, n, b));
    sh.insertColumnsAfter(s + 3, 2);            // 音程の右
    put(s + 4, 'ビブラート&ロングトーン', b);
    put(s + 5, 'リズム', b);
    Logger.log((b.machine || '全体') + ' のブロックに列を追加しました');
  });
  Logger.log('新しい見出し: ' + head().filter(String).slice(0, 80).join(' | '));
}

// ---------- 小物 ----------

// 見出しの照合。「状況 146/462」のような後ろの補足は無視し、「ビブラート&⏎ロングトーン」のような途中の改行は詰めて比べる
function findHeader_(cells, name) {
  for (let i = 0; i < cells.length; i++) {
    if (norm_(cells[i]) === name || String(cells[i] === null || cells[i] === undefined ? '' : cells[i]).replace(/\s+/g, '') === name) return i;
  }
  return -1;
}

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
