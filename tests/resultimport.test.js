// 面接結果 → スケジュールから読み込む (importResultsFromBookings), 2026-10-05.
//
// The import dedups on the student's NAME alone, so a result renamed after import (a typo fixed, a
// passport name) made its booking look new, and every press appended a duplicate. The fix (the
// maintainer's design): renaming a result renames its bookings, so the names agree again. Each
// imported booking also records WHEN it became a result row (Schedule_DB col 26), kept for later.
//
// Runs the REAL functions from Code.js in a vm, against fake sheets that behave like Sheets where
// it matters: a "'" prefix stores text, and a bare "yyyy-MM-dd HH:mm" string turns into a Date.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

const ROOT = path.join(__dirname, "..");
const CODE = fs.readFileSync(path.join(ROOT, "Code.js"), "utf8");

function extract(src, name) {
  const start = src.indexOf("\nfunction " + name + "(");
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n2 = src[i + 1];
    if (c === "/" && n2 === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && n2 === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "/" && /[=(,:!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 3), i))) {   // regex literal
      for (i++; i < src.length && src[i] !== "/"; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") { while (src[++i] !== "]") if (src[i] === "\\") i++; } }
      continue;
    }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return src.slice(start + 1, i + 1);
  }
  return null;
}
const constLine = (code, name) => (code.match(new RegExp("^const " + name + " = [^\\n]*;", "m")) || [""])[0].replace(/^const /, "var ");

const FNS = ["importResultsFromBookings", "_importResultsFromBookingsLocked_", "_stampImportedBookings_",
  "_writeInterviewResultRow_", "_renameBookingsForResult_", "updateIncomingStudent", "_incomingRowAt_",
  "_resultColIndex_", "_normResult_", "_parseSheetDate_", "_formatDateKey_", "_cellSafe_", "_cellSafeRow_",
  "_irEntryValue_", "_irCanonicalHeader_"];

// ---- a fake sheet that stores what Sheets would ----------------------------------------------
const ISO_DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
function store(v) {
  if (typeof v !== "string") return v;
  if (v.charAt(0) === "'") return v.slice(1);                       // Sheets' text marker
  if (ISO_DT.test(v)) return new Date(v.replace(" ", "T") + ":00");  // a bare stamp becomes a Date
  return v;
}
function show(v) {
  if (v instanceof Date) return "DATE";
  return String(v == null ? "" : v);
}
function fakeSheet(data, log, name) {
  const at = (r, c) => (data[r - 1] && data[r - 1][c - 1] != null ? data[r - 1][c - 1] : "");
  const put = (r, c, v) => { while (data.length < r) data.push([]); const tr = data[r - 1]; while (tr.length < c) tr.push(""); tr[c - 1] = store(v); };
  return {
    data,
    getLastRow: () => data.length,
    getDataRange: () => ({ getDisplayValues: () => {
      if (name === "sched" && global.__schedThrows) throw new Error("boom");
      return data.map(r => r.map(show)); } }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => { let o = []; for (let i = 0; i < (nr || 1); i++) { let row = []; for (let j = 0; j < (nc || 1); j++) row.push(at(r + i, c + j)); o.push(row); } return o; },
      setValues: (vals) => {
        log.push(name + ".setValues:" + r + "," + c + "," + vals.length + "x" + vals[0].length);
        vals.forEach((row, i) => row.forEach((v, j) => put(r + i, c + j, v)));
      },
      setValue: (v) => { log.push(name + ".setValue:" + r + "," + c); put(r, c, v); },
    }),
  };
}

const SCHED_HEAD = ["Timestamp", "Teacher ID", "Name", "Date", "Period", "Status", "Student", "Nationality", "Meeting Link",
  "Document URL", "Course", "In Charge", "Reassign_To_Id", "Reassign_To_Name", "Reassign_New_Date", "Reassign_New_Period",
  "BookerReq_Date", "BookerReq_Period", "BookerReq_Reason", "BookerReq_Status", "BookerReq_ByName", "Reassign_Reason",
  "Cancel_Reason", "学期", "備考"];
function booking(date, status, student, extra) {
  const r = new Array(25).fill("");
  r[0] = "ts"; r[1] = "T1"; r[2] = "面接 太郎"; r[3] = date; r[4] = "1"; r[5] = status; r[6] = student;
  r[7] = "ネパール"; r[10] = "進学2年"; r[11] = "営業 花子"; r[23] = "2026年10月生"; r[24] = "";
  return Object.assign(r, extra || {});
}
const IR_HEAD = ["Timestamp", "日付", "入学期", "課程", "国籍", "名前", "面接者", "担当", "合否", "備考", "EnteredBy"];

function load(code, sched, results) {
  const log = [];
  const sSh = fakeSheet(sched, log, "sched"), rSh = fakeSheet(results, log, "results");
  const ctx = vm.createContext({
    console: { log: console.log, error: (m) => log.push("error:" + m) }, Date,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === "Schedule_DB" ? sSh : null) }) },
    LockService: { getDocumentLock: () => ({ tryLock: () => { log.push("lock"); return true; }, releaseLock: () => log.push("unlock") }) },
    Utilities: { formatDate: () => "2026-10-05 10:42" },
    INTERVIEW_RESULTS_SHEET: "Interview_Results",
    _hasResultPerm_: () => true,
    _hasPerm_: () => true,
    _getInterviewResultsSheet_: () => rSh,
    _snapshotSheet_: () => {},
    _bustInterviewCache_: () => {},
    _forgetTab_: () => {},
    _logActivity_: (a, action, target, d) => log.push("log:" + action + ":" + d),
  });
  const src = [constLine(code, "SCHED_IMPORT_AT_COL"), constLine(code, "SCHED_REINTERVIEW_MARK")].concat(FNS.map(n => {
    const f = extract(code, n); if (!f) throw new Error("missing " + n); return f;
  })).join("\n");
  vm.runInContext(src, ctx);
  const t = { ctx, log, sched, results, press: () => ctx.importResultsFromBookings("", "", "職員 一郎", "U1") };
  // Rename the result in sheet row r, the way 面接結果's 編集 does (one row writer).
  t.rename = (r, name) => { const row = t.results[r - 1].map(show); const entry = {};
    IR_HEAD.forEach((h, i) => { entry[h] = row[i]; }); entry["名前"] = name; entry.__enteredBy = "職員 一郎";
    ctx._writeInterviewResultRow_(rSh, r, IR_HEAD, row, entry); };
  return t;
}

const PAST = "2026-09-01", FUTURE = "2099-01-01";
const SCHED = () => [SCHED_HEAD.slice(),
  booking(PAST, "Booked", "SAMPLE TARO"),
  booking(PAST, "Booked", "SAMPLE HANAKO", { 4: "2" }),
  booking(FUTURE, "Booked", "SAMPLE FUTURE"),
  booking(PAST, "Available", ""),
];
const names = (t) => t.results.slice(1).map(r => r[5]);
const rowOf = (t, n) => t.results.findIndex(r => r[5] === n) + 1;

console.log("1. a press imports past bookings and records when");
{
  const t = load(CODE, SCHED(), [IR_HEAD.slice()]);
  const r = t.press();
  check("past Booked rows are imported; future and unbooked are not",
    r.added === 2 && JSON.stringify(names(t)) === JSON.stringify(["SAMPLE TARO", "SAMPLE HANAKO"]), JSON.stringify(names(t)));
  check("each imported booking gets Result_Imported_At, as TEXT", t.sched[1][25] === "2026-10-05 10:42" && t.sched[2][25] === "2026-10-05 10:42", String(t.sched[1][25]));
  check("future and unbooked rows get nothing", !t.sched[3][25] && !t.sched[4][25]);
  check("the header is filled", t.sched[0][25] === "Result_Imported_At");
  const w = t.log.filter(l => l.indexOf("sched.set") === 0);
  check("ONE write over col 26 (plus the header); cols 1–25 untouched",
    w.filter(l => /^sched\.setValues:2,26,4x1$/.test(l)).length === 1 && w.every(l => /,26,/.test(l)), JSON.stringify(w));
  check("it runs under the lock", t.log[0] === "lock" && t.log[t.log.length - 1] === "unlock");
  check("a second press imports nothing and writes nothing", t.press().added === 0 &&
    t.log.filter(l => /^sched\.setValues:2,26/.test(l)).length === 1);
  t.sched.push(booking(PAST, "Booked", "SAMPLE NEW", { 4: "3" }));
  t.press();
  check("a later import rewrites the column with the OLD times kept as text, not Dates",
    t.sched[1][25] === "2026-10-05 10:42" && t.sched[5][25] === "2026-10-05 10:42", String(t.sched[1][25]));
  const skipped = load(CODE, SCHED(), [IR_HEAD.slice(), ["x", "", "", "", "", "SAMPLE TARO", "", "", "", "", ""]]);
  skipped.press();
  check("a booking skipped as existing gets no time (it did not become a row now)", !skipped.sched[1][25] && skipped.sched[2][25] === "2026-10-05 10:42");
  const bare = CODE.replace("return [(typeof v === \"string\" && v !== \"\") ? \"'\" + v : v];", "return [v];");
  const b = load(bare, SCHED(), [IR_HEAD.slice()]);
  b.press();
  check("  mutation: without the apostrophe the time turns into a Date", bare !== CODE && b.sched[1][25] instanceof Date);
}

console.log("\n2. the bug: rename a result → its bookings follow → press again adds nothing");
{
  const s = SCHED(); s.push(booking("2026-09-15", "Cancel_Request", "SAMPLE TARO", { 4: "4" }));   // a re-interview
  const t = load(CODE, s, [IR_HEAD.slice()]);
  t.press();
  t.rename(rowOf(t, "SAMPLE TARO"), "SAMPLE TARO RIVERA");
  check("the result is renamed", names(t).indexOf("SAMPLE TARO RIVERA") !== -1);
  check("EVERY booking with the old name follows (another date, another status)",
    t.sched[1][6] === "SAMPLE TARO RIVERA" && t.sched[5][6] === "SAMPLE TARO RIVERA", JSON.stringify([t.sched[1][6], t.sched[5][6]]));
  check("other students are untouched", t.sched[2][6] === "SAMPLE HANAKO");
  check("only col 7 is written", t.log.filter(l => l.indexOf("sched.setValue:") === 0).every(l => /,7$/.test(l)));
  check("one 操作履歴 entry with old → new and the count", t.log.some(l => l === "log:面接予約の名前を変更:SAMPLE TARO → SAMPLE TARO RIVERA（2件）"), JSON.stringify(t.log.filter(l => /^log:/.test(l))));
  check("press again → 0 added (the duplicate is gone)", t.press().added === 0 && t.results.length === 3, JSON.stringify(names(t)));
  const noHook = CODE.replace("try { _renameBookingsForResult_(sh, oldName, newName, rowIndex, entry.__enteredBy || \"\"); }", "try { }");
  const m = load(noHook, SCHED(), [IR_HEAD.slice()]);
  m.press(); m.rename(rowOf(m, "SAMPLE TARO"), "SAMPLE TARO RIVERA");
  check("  mutation: without the hook the import re-adds the student (the bug)", noHook !== CODE && m.press().added === 1);
}

console.log("\n3. when NOT to rename");
{
  const t = load(CODE, SCHED(), [IR_HEAD.slice()]);
  t.press();
  const before = t.log.length;
  t.rename(rowOf(t, "SAMPLE TARO"), "sample　taro");
  check("a case/space-only change writes no booking", !t.log.slice(before).some(l => l.indexOf("sched.") === 0) && t.sched[1][6] === "SAMPLE TARO");
  t.rename(rowOf(t, "sample　taro"), "");
  check("a blank new name renames nothing", t.sched[1][6] === "SAMPLE TARO");

  // A namesake: two results named SAMPLE TARO, one renamed. The other still covers the bookings.
  const two = load(CODE, SCHED(), [IR_HEAD.slice(), ["x", "", "", "", "", "SAMPLE TARO", "", "", "", "", ""], ["y", "", "", "", "", "SAMPLE TARO", "", "", "", "", ""]]);
  two.rename(2, "SAMPLE TARO KHAN");
  check("⚠️ another result still holding the old name → nothing renamed", two.sched[1][6] === "SAMPLE TARO");
  check("...and the import still skips it (covered by that row)", two.press().added === 1);
  const noGuard = CODE.replace("if (i + 1 !== rowIndex && _normResult_(rData[i][iName]) === oldKey) return 0;", "");
  const g = load(noGuard, SCHED(), [IR_HEAD.slice(), ["x", "", "", "", "", "SAMPLE TARO", "", "", "", "", ""], ["y", "", "", "", "", "SAMPLE TARO", "", "", "", "", ""]]);
  g.rename(2, "SAMPLE TARO KHAN");
  check("  mutation: without the shared-name guard the namesake's booking is renamed", noGuard !== CODE && g.sched[1][6] === "SAMPLE TARO KHAN");

  const f = load(CODE, SCHED(), [IR_HEAD.slice()]);
  f.press();
  f.rename(rowOf(f, "SAMPLE TARO"), "=HYPERLINK(\"x\")");
  check("a formula-shaped name reaches the booking as text (_cellSafe_)", f.sched[1][6] === "=HYPERLINK(\"x\")");

  const e = load(CODE, SCHED(), [IR_HEAD.slice()]);
  e.press();
  global.__schedThrows = true;
  let threw = false;
  try { e.rename(rowOf(e, "SAMPLE TARO"), "SAMPLE TARO RIVERA"); } catch (x) { threw = true; }
  global.__schedThrows = false;
  check("a failing booking update never fails the result save", !threw && names(e).indexOf("SAMPLE TARO RIVERA") !== -1 && e.log.some(l => /^error:/.test(l)));
}

console.log("\n4. 入学予定者's 編集 goes through the same writer");
{
  const t = load(CODE, SCHED(), [IR_HEAD.slice()]);
  t.press();
  const r = rowOf(t, "SAMPLE HANAKO");
  const entry = {}; IR_HEAD.forEach((h, i) => { entry[h] = show(t.results[r - 1][i]); }); entry["名前"] = "SAMPLE HANAKO LEE";
  t.ctx.updateIncomingStudent(r, show(t.results[r - 1][0]), entry);
  check("renaming from 入学予定者 renames the booking too", t.sched[2][6] === "SAMPLE HANAKO LEE" && t.press().added === 0);
}

console.log("\n5. 「再面接」 bookings are not imported (備考 or the name)");
{
  const s = SCHED();
  s.push(booking(PAST, "Booked", "SAMPLE JIRO", { 4: "3", 24: "再面接" }));
  s.push(booking(PAST, "Booked", "SAMPLE SABURO（再面接）", { 4: "4" }));
  const t = load(CODE, s, [IR_HEAD.slice()]);
  const r = t.press();
  check("a 備考 mark and a name mark are both left out", names(t).indexOf("SAMPLE JIRO") === -1 &&
    !names(t).some(n => n.indexOf("再面接") !== -1) && r.added === 2, JSON.stringify(names(t)));
  check("they are counted, not counted as existing", r.reinterview === 2 && r.skipped === 0, JSON.stringify(r));
  check("the message says so", r.message.indexOf("（再面接 2 件は対象外）") !== -1, r.message);
  check("marked bookings get no Result_Imported_At", !t.sched[5][25] && !t.sched[6][25]);

  const u = SCHED();
  u.splice(1, 0, booking("2026-08-20", "Booked", "SAMPLE TARO", { 4: "5", 24: "再面接" }));   // marked row FIRST
  const v = load(CODE, u, [IR_HEAD.slice()]);
  v.press();
  check("the mark does not claim the name: the unmarked booking still imports",
    names(v).indexOf("SAMPLE TARO") !== -1 && !v.sched[1][25] && v.sched[2][25] === "2026-10-05 10:42", JSON.stringify(names(v)));

  check("nothing marked → message unchanged", load(CODE, SCHED(), [IR_HEAD.slice()]).press().message === "2件を取り込みました。");

  const noMark = CODE.replace(/if \(student\.indexOf\(SCHED_REINTERVIEW_MARK\)[\s\S]*?\{ reinterview\+\+; continue; \}/, "");
  const m = load(noMark, s.map(x => x.slice()), [IR_HEAD.slice()]);
  check("  mutation: without the check the marked bookings are imported", noMark !== CODE && m.press().added === 4);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
