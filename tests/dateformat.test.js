// One date format across the app — 2026/09/11, and 2026/09/11 10:42 for timestamps (2026-09-28).
//
// Reported on staging v222: "Some shows MM/DD/YYYY and some shows YYYY/MM/DD", in 学生一覧. Dates
// reach the screen as a cell's DISPLAY text, and a Date cell with no number format of its own
// displays in the spreadsheet's LOCALE — month-first in production. The fix pins a number format on
// every date column (_dateColumnFormats_ / _applyDateFormats_), located by header name.
//
// ⚠️ These run the REAL functions from Code.js in a vm, against a fake spreadsheet. Every guard is
// also run against the old or a broken shape, and must fail there.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
// A top-level Code.js function ends at the first "\n}\n" — its body is indented.
function codeFn(src, name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('Code.js: no function ' + name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 3);
}
function mutate(src, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error('mutation anchor found ' + n + ' times: ' + from.slice(0, 70));
  return src.replace(from, to);
}

// ---- a fake spreadsheet: sheets by name, each a header row and a size; formats recorded per A1 ----
function colLetter(c) { let s = ''; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = (c - m - 1) / 26; } return s; }
function fakeSS(spec) {
  const formats = {};   // "Sheet!A2:A100" -> fmt
  const sheets = {};
  Object.keys(spec).forEach(function (name) {
    const headers = spec[name], maxRows = 100;
    sheets[name] = {
      getLastColumn: function () { return headers.length; },
      getMaxRows: function () { return maxRows; },
      getRange: function (r, c, nr, nc) {
        return {
          getDisplayValues: function () { return [headers.slice(c - 1, c - 1 + (nc || 1))]; },
          getA1Notation: function () { return colLetter(c) + r + ':' + colLetter(c) + (r + (nr || 1) - 1); }
        };
      },
      getRangeList: function (a1s) {
        return { setNumberFormat: function (fmt) { a1s.forEach(function (a) { formats[name + '!' + a] = fmt; }); } };
      }
    };
  });
  return { formats: formats, ss: { getSheetByName: function (n) { return sheets[n] || null; } } };
}
function load(src, spec) {
  const f = fakeSS(spec);
  const ctx = vm.createContext({ SpreadsheetApp: { getActiveSpreadsheet: function () { return f.ss; } } });
  vm.runInContext(
    'var AUDIT_SHEET = "Activity_Log", INTERVIEW_RESULTS_SHEET = "Interview_Results",' +
    ' SHEET_ANNOUNCEMENTS = "Announcements", SHEET_ENROL_HISTORY = "Enrollment_History",' +
    ' SHEET_RECRUIT_NOTE = "Recruitment_Notes", SCHED_TEMPLATE_SHEET = "Schedule_Templates";', ctx);
  vm.runInContext(codeFn(src, '_dateColumnFormats_') + codeFn(src, '_applyDateFormats_'), ctx);
  return { ctx: ctx, formats: f.formats };
}
const CENTRAL = ["学籍番号", "ニックネーム", "国名", "名前英語", "読み方", "クラス", "担任", "国担当", "電話番号",
  "メールアドレス", "寮", "アルバイト1", "アルバイト１連絡先", "アルバイト２", "アルバイト２連絡先",
  "生年月日", "年齢", "性別", "入国日", "始業日", "卒業予定", "在留期限", "学歴", "コース", "ビザの種類", "JLPT", "決定進路", "ビザ警告"];
const SCHED = ["Timestamp", "Teacher ID", "Name", "Date", "Period", "Status", "Student", "Nationality", "Meeting Link",
  "Document URL", "Course", "In Charge", "Reassign_To_Id", "Reassign_To_Name", "Reassign_New_Date",
  "Reassign_New_Period", "BookerReq_Date"];
const NOTE = ["入学期", "内容", "更新者", "更新日時", "リスト提出日", "申請日", "結果", "担当"];
const SPEC = { Central_DB: CENTRAL, Schedule_DB: SCHED, Recruitment_Notes: NOTE,
  Activity_Log: ["Timestamp", "User", "ID", "Role", "Action", "Target", "Details"] };

console.log("\n1. the date columns get the app's format, found by HEADER");
{
  const L = load(SRC, SPEC);
  const done = L.ctx._applyDateFormats_();
  const F = L.formats;
  check("在留期限 (col V) and 生年月日 (col P) are yyyy/mm/dd",
    F['Central_DB!V2:V100'] === 'yyyy/mm/dd' && F['Central_DB!P2:P100'] === 'yyyy/mm/dd', JSON.stringify(F));
  check("exactly the five student date columns of Central_DB, nothing else in it",
    Object.keys(F).filter(function (k) { return k.indexOf('Central_DB!') === 0; }).length === 5, JSON.stringify(F));
  check("操作履歴's Timestamp is yyyy/mm/dd hh:mm", F['Activity_Log!A2:A100'] === 'yyyy/mm/dd hh:mm', JSON.stringify(F));
  check("⚠️ Schedule_DB's slot dates stay yyyy-mm-dd (exact-string keys): Date, Reassign_New_Date, BookerReq_Date",
    F['Schedule_DB!D2:D100'] === 'yyyy-mm-dd' && F['Schedule_DB!O2:O100'] === 'yyyy-mm-dd' && F['Schedule_DB!Q2:Q100'] === 'yyyy-mm-dd' &&
    !F['Schedule_DB!A2:A100'], JSON.stringify(F));
  check("⚠️ 募集状況's three dates stay yyyy-mm-dd (they fill <input type=date>); its 更新日時 is a timestamp",
    F['Recruitment_Notes!E2:E100'] === 'yyyy-mm-dd' && F['Recruitment_Notes!G2:G100'] === 'yyyy-mm-dd' &&
    F['Recruitment_Notes!D2:D100'] === 'yyyy/mm/dd hh:mm', JSON.stringify(F));
  check("a sheet that does not exist yet (Past_DB, Announcements…) is skipped, not an error",
    !Object.keys(F).some(function (k) { return k.indexOf('Past_DB!') === 0; }) && done.indexOf('Central_DB:在留期限') !== -1, JSON.stringify(done));

  // Moved column: the SAME header one place to the right must be followed.
  const moved = CENTRAL.slice(); moved.splice(0, 0, "追加列");
  const M = load(SRC, { Central_DB: moved });
  M.ctx._applyDateFormats_(["Central_DB"]);
  // Every date column shifts one right: P,S,T,U,V → Q,T,U,V,W, and P (now アルバイト２連絡先) is left alone.
  check("columns that move are followed by name (P,S,T,U,V → Q,T,U,V,W; P left alone)",
    JSON.stringify(Object.keys(M.formats).sort()) ===
      JSON.stringify(['Central_DB!Q2:Q100', 'Central_DB!T2:T100', 'Central_DB!U2:U100', 'Central_DB!V2:V100', 'Central_DB!W2:W100']),
    JSON.stringify(M.formats));
  const only = load(SRC, SPEC); only.ctx._applyDateFormats_(["Central_DB", "Past_DB"]);
  check("the import's call touches only its own two sheets",
    Object.keys(only.formats).every(function (k) { return k.indexOf('Central_DB!') === 0; }), JSON.stringify(only.formats));

  const byIdx = mutate(SRC, "const c = headers.indexOf(e.header);", "const c = bySheet[name].indexOf(e) + 15;");
  const B = load(byIdx, { Central_DB: moved });
  B.ctx._applyDateFormats_(["Central_DB"]);
  check("  mutation: located by position — the moved column is missed, caught",
    B.formats['Central_DB!W2:W100'] !== 'yyyy/mm/dd', JSON.stringify(B.formats));
  const iso = mutate(SRC, '{ sheet: "Schedule_DB",           header: "Date",              fmt: ISO }',
                          '{ sheet: "Schedule_DB",           header: "Date",              fmt: D }');
  const I = load(iso, SPEC); I.ctx._applyDateFormats_();
  check("  mutation: Schedule_DB's Date given the display format — caught", I.formats['Schedule_DB!D2:D100'] !== 'yyyy-mm-dd', "");
}

console.log("\n2. every header in the table is one its sheet really has");
{
  // A typo formats nothing and says nothing. Each header must appear as a string literal
  // somewhere in Code.js OTHER than the table itself (creation code, the import's column list).
  const table = codeFn(SRC, '_dateColumnFormats_');
  const rest = SRC.replace(table, '');
  const L = load(SRC, {});
  const missing = L.ctx._dateColumnFormats_().filter(function (e) { return rest.indexOf('"' + e.header + '"') === -1; });
  check("all " + L.ctx._dateColumnFormats_().length + " headers are defined outside the table",
    missing.length === 0, JSON.stringify(missing));
  const typo = mutate(SRC, 'header: "記録日時",', 'header: "記録日時 ",');
  const T = load(typo, {});
  const t2 = typo.replace(codeFn(typo, '_dateColumnFormats_'), '');
  check("  mutation: a trailing space in a header — caught",
    T.ctx._dateColumnFormats_().some(function (e) { return t2.indexOf('"' + e.header + '"') === -1; }), "");
}

console.log("\n3. it runs where the dates are written");
{
  const imp = codeFn(SRC, 'fetchAndMergeStudentData');
  const setAt = imp.lastIndexOf('.setValues(finalData)'), fmtAt = imp.indexOf('_applyDateFormats_(["Central_DB", "Past_DB"])');
  check("the import re-pins its date columns AFTER writing the rows", setAt !== -1 && fmtAt > setAt, "");
  check("...and a failure there cannot fail the import (wrapped)", /try \{ _applyDateFormats_\(\["Central_DB", "Past_DB"\]\); \}\s*\n\s*catch/.test(imp), "");
  check("triggerScheduledBackup re-pins every sheet 3×/day", /_applyDateFormats_\(\)/.test(codeFn(SRC, 'triggerScheduledBackup')), "");
  const ed = codeFn(SRC, 'applyDateFormats');
  check("applyDateFormats (editor-run) is behind the maintenance unlock", /^function applyDateFormats\(\) \{\s*\n\s*_requireMaintenanceUnlock_\(/.test(ed), "");
  const noImp = mutate(SRC, '  try { _applyDateFormats_(["Central_DB", "Past_DB"]); }\n', '  try { }\n');
  check("  mutation: the import's call removed — caught",
    codeFn(noImp, 'fetchAndMergeStudentData').indexOf('_applyDateFormats_(') === -1, "");
}

console.log("\n4. an edit keeps the real Timestamp, not its display");
{
  const keepsValue = function (src) {
    // The row write moved into the shared writer on 2026-10-01 (入学予定者 edits through it too).
    const up = codeFn(src, '_writeInterviewResultRow_');
    return /const raw = sh\.getRange\(rowIndex, 1, 1, headers\.length\)\.getValues\(\)\[0\];/.test(up) &&
      /if \(h === "Timestamp"\) return raw\[ci\];/.test(up);
  };
  check("Timestamp is written back from getValues(), not the display row", keepsValue(SRC), "");
  check("  mutation: the display written back — caught",
    !keepsValue(mutate(SRC, 'if (h === "Timestamp") return raw[ci];', 'if (h === "Timestamp") return existing[ci];')), "");
}

console.log("\n5. an EXTERNAL results sheet: its Date cells rendered from their value");
{
  function fmtStub(d, tz, pat) {
    const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return pat.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
  }
  const ctx = vm.createContext({ Utilities: { formatDate: fmtStub } });
  vm.runInContext(codeFn(SRC, '_dateText_'), ctx);
  check("a form timestamp → 2026/09/11 10:42 (Asia/Tokyo)", ctx._dateText_(new Date('2026-09-11T01:42:07Z')) === '2026/09/11 10:42',
    ctx._dateText_(new Date('2026-09-11T01:42:07Z')));
  check("a date-only cell (midnight JST) → 2026/09/11", ctx._dateText_(new Date('2026-09-10T15:00:00Z')) === '2026/09/11',
    ctx._dateText_(new Date('2026-09-10T15:00:00Z')));
  const pr = codeFn(SRC, '_placementResultsUncached_');
  check("_placementResultsUncached_ swaps exactly the Date cells, by value",
    /if \(Object\.prototype\.toString\.call\(vals\[r\]\[c\]\) === "\[object Date\]"\) full\[r\]\[c\] = _dateText_\(vals\[r\]\[c\]\);/.test(pr), "");
}

console.log("\n6. the client: one display shape, and inputs never guess");
{
  const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
  const jsOf = function (h) { return (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || ''; };
  const htmlFn = function (h, name) {
    const js = jsOf(h), i = js.indexOf('      function ' + name + '(');
    if (i < 0) throw new Error('Index.html: no function ' + name);
    return js.slice(i, js.indexOf('\n      }\n', i) + 8);
  };
  const client = function (h) {
    const ctx = vm.createContext({ calWeekStart: new Date(2099, 0, 5) });
    ['formatDateDisplay', 'formatStampDisplay', '_toIsoDate', 'getMonday', 'formatDate', '_calNowKeyJst', 'calRequestDateOptions']
      .forEach(function (n) { vm.runInContext(htmlFn(h, n), ctx); });
    return ctx;
  };
  const C = client(HTML);
  check("formatStampDisplay: 2026-09-11 10:42:07 → 2026/09/11 10:42",
    C.formatStampDisplay('2026-09-11 10:42:07') === '2026/09/11 10:42', C.formatStampDisplay('2026-09-11 10:42:07'));
  check("...2026/9/1 8:05 → 2026/09/01 08:05, a bare date → 2026/09/11, text untouched",
    C.formatStampDisplay('2026/9/1 8:05') === '2026/09/01 08:05' && C.formatStampDisplay('2026-09-11') === '2026/09/11' &&
    C.formatStampDisplay('-') === '-' && C.formatStampDisplay('') === '', "");
  check("_toIsoDate: 2026/9/1 and 2026-09-01 → 2026-09-01",
    C._toIsoDate('2026/9/1') === '2026-09-01' && C._toIsoDate('2026-09-01') === '2026-09-01', "");
  check("⚠️ _toIsoDate never guesses: 9/11/2026, 11/9/2026, '' and null → ''",
    ['9/11/2026', '11/9/2026', '', null, undefined].every(function (v) { return C._toIsoDate(v) === ''; }), "");
  const opts = C.calRequestDateOptions();
  check("⚠️ 日時変更/交代 options: VALUE stays YYYY-MM-DD (a slot key), the TEXT shows YYYY/MM/DD",
    opts.length === 5 && opts.every(function (o) { return /^\d{4}-\d{2}-\d{2}$/.test(o.value) && o.text.indexOf(o.value.replace(/-/g, '/')) !== -1; }),
    JSON.stringify(opts));
  const js = jsOf(HTML);
  check("both date inputs read through _toIsoDate; the old per-site conversion and _acctStamp are gone",
    /el\.value = _toIsoDate\(res && res\[pair\[1\]\]\);/.test(htmlFn(HTML, 'recFillDates')) &&
    /if \(id === 'ir_date'\) val = _toIsoDate\(val\);/.test(js) && !/function _acctStamp\(/.test(js), "");
  check("the calendar's week label shows YYYY/MM/DD", /calWeekDisplay'\)\.innerText = formatDateDisplay\(formatDate\(calWeekStart\)\) \+ ' の週'/.test(js), "");

  const guess = HTML.replace('return m ? m[1] + "-" + (\'0\' + m[2]).slice(-2) + "-" + (\'0\' + m[3]).slice(-2) : "";',
    'if (!m) { const u = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/.exec(String(val)); if (u) return u[3] + "-" + ("0" + u[1]).slice(-2) + "-" + ("0" + u[2]).slice(-2); }\n        return m ? m[1] + "-" + (\'0\' + m[2]).slice(-2) + "-" + (\'0\' + m[3]).slice(-2) : "";');
  check("  mutation: _toIsoDate guessing month-first — caught", guess !== HTML && client(guess)._toIsoDate('11/9/2026') !== '', "");
  const keyed = mutate(HTML, "out.push({ value: ds, text:", "out.push({ value: formatDateDisplay(ds), text:");
  check("  mutation: the option VALUE reformatted — caught",
    !client(keyed).calRequestDateOptions().every(function (o) { return /^\d{4}-\d{2}-\d{2}$/.test(o.value); }), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
