// ── util.js ─────────────────────────────────────────────────────────────────
// Shared helpers inlined into every outreach Code node (no require/import:
// n8n Code nodes cannot load local files, so build.mjs concatenates libs).
// All calendar logic is IST (UTC+05:30, no DST) so it never depends on the
// n8n instance timezone.

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }

// Wall-clock IST parts for an instant.
function istParts(d) {
  const t = new Date((d instanceof Date ? d.getTime() : Number(d)) + IST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
           hh: t.getUTCHours(), mi: t.getUTCMinutes(), ss: t.getUTCSeconds(), dow: t.getUTCDay() };
}
function istDateStr(d) { const p = istParts(d); return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`; }
function istTsStr(d) { const p = istParts(d); return `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}`; }
function istMinutesOfDay(d) { const p = istParts(d); return p.hh * 60 + p.mi; }

// IST wall-clock → instant.
function istToDate(y, m, d, hh = 0, mi = 0, ss = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mi, ss) - IST_OFFSET_MS);
}

// Accepts what Sheets/Gmail hand back: Date, serial number (days since
// 1899-12-30, IST wall clock), 'YYYY-MM-DD[ HH:mm[:ss]]', ISO with zone,
// 'DD/MM/YYYY[ HH:mm[:ss]]', epoch-ms strings (Gmail internalDate).
function parseTs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') {
    if (v > 1e11) return new Date(v);                     // epoch ms
    const ms = Math.round(v * DAY_MS);                     // sheet serial (IST wall clock)
    const base = Date.UTC(1899, 11, 30) + ms;
    return new Date(base - IST_OFFSET_MS);
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{12,14}$/.test(s)) return new Date(Number(s));
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    if (m[7]) { const p = Date.parse(s.replace(' ', 'T')); return isNaN(p) ? null : new Date(p); }
    return istToDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return istToDate(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const p = Date.parse(s);
  return isNaN(p) ? null : new Date(p);
}

// 'YYYY-MM-DD' (IST) or '' for anything unparseable.
function toIstDate(v) { const d = parseTs(v); return d ? istDateStr(d) : ''; }

function dateStrToUtcNoon(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d, 12); }
function addCalendarDays(dateStr, n) {
  const t = new Date(dateStrToUtcNoon(dateStr) + n * DAY_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
function daysBetween(a, b) { return Math.round((dateStrToUtcNoon(b) - dateStrToUtcNoon(a)) / DAY_MS); }
function dowOf(dateStr) { return new Date(dateStrToUtcNoon(dateStr)).getUTCDay(); } // 0 = Sun

// sendDays: Set of 0..6, holidays: Set of 'YYYY-MM-DD'
function isBusinessDay(dateStr, sendDays, holidays) {
  return sendDays.has(dowOf(dateStr)) && !holidays.has(dateStr);
}
function addBusinessDays(dateStr, n, sendDays, holidays) {
  let d = dateStr, left = Math.max(0, Math.round(n));
  if (left === 0) return d;
  let guard = 0;
  while (left > 0 && guard++ < 400) {
    d = addCalendarDays(d, 1);
    if (isBusinessDay(d, sendDays, holidays)) left--;
  }
  return d;
}

// Deterministic, alphanumeric-only id (safe for Telegram commands too).
function hashId(prefix, input) {
  const s = String(input || '');
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return prefix + h1.toString(36).padStart(7, '0') + (h2 % 1296).toString(36).padStart(2, '0');
}

function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function normEmail(v) { return str(v).toLowerCase(); }
function normUrl(v) {
  return str(v).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}
function isYes(v) { return /^(y|yes|true|1)$/i.test(str(v)); }
function numOrNull(v) {
  if (v === null || v === undefined || str(v) === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function cmpJobIdDesc(a, b) {
  const x = str(a), y = str(b);
  if (x.length !== y.length) return y.length - x.length;
  return y < x ? -1 : y > x ? 1 : 0;
}

// ── Sheets value grids ──────────────────────────────────────────────────────
// values (2-D array, row 1 = headers) → { headers, rows } where each row has
// `_row` = 1-based sheet row number. Fully empty rows are dropped.
function parseTable(values) {
  const grid = Array.isArray(values) ? values : [];
  const headers = (grid[0] || []).map(h => str(h));
  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] || [];
    if (!r.some(c => str(c) !== '')) continue;
    const o = { _row: i + 1 };
    headers.forEach((h, j) => { if (h) o[h] = r[j] === undefined ? '' : r[j]; });
    rows.push(o);
  }
  return { headers, rows, lastRow: grid.length };
}

function colLetter(idx) { // 0-based → A, B, … AA
  let s = '', n = idx + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function quoteTab(tab) { return `'${String(tab).replace(/'/g, "''")}'`; }

// One ValueRange per field, for values:batchUpdate. Unknown columns are
// skipped (and reported) rather than written somewhere wrong.
function cellWrites(tab, headers, rowNumber, fields, missing) {
  const out = [];
  for (const [k, v] of Object.entries(fields)) {
    const j = headers.indexOf(k);
    if (j < 0) { if (missing) missing.add(`${tab}.${k}`); continue; }
    out.push({ range: `${quoteTab(tab)}!${colLetter(j)}${rowNumber}`, values: [[v === null || v === undefined ? '' : v]] });
  }
  return out;
}
// A whole new row in header order.
function rowWrite(tab, headers, rowNumber, fields) {
  const row = headers.map(h => (fields[h] === undefined || fields[h] === null ? '' : fields[h]));
  return { range: `${quoteTab(tab)}!A${rowNumber}:${colLetter(Math.max(headers.length - 1, 0))}${rowNumber}`, values: [row] };
}

// valueRanges from values:batchGet → { tabName: values }
function rangesByTab(resp) {
  const out = {};
  for (const vr of (resp && resp.valueRanges) || []) {
    const tab = String(vr.range || '').split('!')[0].replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'");
    out[tab] = vr.values || [];
  }
  return out;
}

// Config tab: Setting | Value | Notes (first two non-empty cells per row).
function parseConfig(values) {
  const cfg = {};
  (values || []).forEach((r, i) => {
    if (i === 0 && str(r[0]).toLowerCase() === 'setting') return;
    const k = str(r[0]);
    if (k) cfg[k] = r[1] === undefined ? '' : r[1];
  });
  return cfg;
}
function cfgNum(cfg, key, def) { const n = numOrNull(cfg[key]); return n === null ? def : n; }
function cfgStr(cfg, key, def) { const s = str(cfg[key]); return s === '' ? def : s; }
function cfgList(cfg, key, def) {
  const s = str(cfg[key]);
  return (s === '' ? def : s).split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
}
function cfgSendDays(cfg) { return new Set(cfgList(cfg, 'sendDays', '1,2,3,4,5').map(Number)); }
function cfgHolidays(cfg) { return new Set(cfgList(cfg, 'holidays', '').map(toIstDate).filter(Boolean)); }
function hhmmToMinutes(s, def) {
  const m = str(s).match(/^(\d{1,2}):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : def;
}

function sheetsUrl(spreadsheetId) { return `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`; }
// SERIAL_NUMBER keeps typed dates unambiguous (no locale formats); strings we
// write ourselves are RAW so they come back unchanged.
function sheetsBatchGetUrl(spreadsheetId, ranges) {
  return `${sheetsUrl(spreadsheetId)}/values:batchGet?${ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&')}` +
    '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
}
// Column-wise batchGet (one range per column, all from row 1) → row objects.
function columnsToRows(names, valueRanges) {
  const cols = names.map((n, i) => ((valueRanges || [])[i] && valueRanges[i].values) || []);
  const len = Math.max(0, ...cols.map(c => c.length));
  const rows = [];
  for (let i = 1; i < len; i++) {
    const o = { _row: i + 1 };
    names.forEach((n, j) => { const cell = cols[j][i]; o[n] = cell && cell.length ? cell[0] : ''; });
    if (names.some(n => str(o[n]) !== '')) rows.push(o);
  }
  return rows;
}
