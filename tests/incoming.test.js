// 学生一覧 → 入学予定者 (2026-10-01).
//
// The 面接結果 rows whose 申請 is ○, and their cancellation. No store of its own:
//   - editing changes the Interview_Results row (one copy of each student);
//   - a cancellation IS a Recruitment_Cancel row — 募集状況's own record, so its キャンセル
//     tables, grid and 定員・残枠 move with it.
// The two sheets share no id, so a person is joined by 入学期 + _normName_(名前) — this file's
// oldest bug class. Ambiguity is refused, never guessed. Rows are addressed by number, which
// shifts on delete, so every write first proves the row by its Timestamp.
//
// Runs the REAL functions from Code.js in a vm, against fake sheets.

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
const HTML = fs.readFileSync(path.join(ROOT, "Index.html"), "utf8");

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
// A multi-line const (ACCENT_MAP), as a var.
const constBlock = (src, name) => ((src.match(new RegExp("const " + name + " = \\{[\\s\\S]*?\\};")) || [""])[0]).replace(/^const /, "var ");
const constLine = (name) => (CODE.match(new RegExp("^const " + name + " = [^\\n]*;", "m")) || [""])[0].replace(/^const /, "var ");

const FNS = ["_normName_", "_cellSafe_", "_cellSafeRow_", "_resultColIndex_", "_irCanonicalHeader_", "_irEntryValue_",
  "_normResult_", "_renameBookingsForResult_", "_isApplied_", "_incomingWritings_", "_incomingSameName_", "_incomingHits_", "_foldAccents_", "_isoDay_", "_nameTokens_", "_nameVariants_", "_nameTokensKey_", "_isInitial_", "_namesMatch_", "_anyNamesMatch_", "_countryKey_", "_intakeKeyFromStudentId_", "_intakeKeyFromIntakeName_", "_enrolledIndex_", "_isEnrolled_", "_incomingIntakeDates_", "_incomingToday_", "_incomingRosterIndex_", "getIncomingStudents",
  "_incomingRowAt_", "_writeInterviewResultRow_", "updateIncomingStudent", "setIncomingState"];

// ---- fake sheets -----------------------------------------------------------------------------
function fakeSheet(data, log) {
  return {
    data,
    getDataRange: () => ({ getDisplayValues: () => data.map(r => r.map(v => v instanceof Date ? "D" : String(v == null ? "" : v))) }),
    getRange: (r, c, nr, nc) => ({
      getValues: () => data.slice(r - 1, r - 1 + (nr || 1)).map(row => row.slice(c - 1, c - 1 + (nc || 1))),
      setValues: (vals) => { vals.forEach((row, k) => row.forEach((v, j) => { data[r - 1 + k][c - 1 + j] = v; })); log.push("setValues:" + r); },
      setValue: (v) => { data[r - 1][c - 1] = v; log.push("setValue:" + r + "," + c + "=" + v); },
    }),
    appendRow: (row) => { data.push(row); log.push("append:" + JSON.stringify(row)); },
    deleteRow: (r) => { data.splice(r - 1, 1); log.push("delete:" + r); },
  };
}
const IR_HEAD = ["Timestamp", "日付", "入学期", "課程", "国籍", "名前", "性別", "年齢", "学歴", "現在のレベル", "点数",
  "プレースメントテスト点数", "合否", "面接者", "担当", "申請", "2回目面接", "3回目面接", "備考", "EnteredBy"];
function irRow(stamp, intake, name, app, extra) {
  const r = new Array(IR_HEAD.length).fill("");
  r[0] = stamp; r[2] = intake; r[3] = "進学2年"; r[4] = "ネパール"; r[5] = name; r[14] = "営業 花子"; r[15] = app;
  return Object.assign(r, extra || {});
}

const VISA_HEAD = ["入学期", "番号", "国籍", "名前", "現在のビザ", "ビザ変更", "課程", "担当", "松野", "学費"];
function load(code, perms, ir, cancel, opts) {
  opts = opts || {};
  const log = [];
  const irSh = fakeSheet(ir, log), cSh = fakeSheet(cancel, log);
  const notissued = opts.notissued || [["入学期", "国籍", "名前", "課程", "担当"]];
  const nSh = fakeSheet(notissued, log);
  const visa = opts.visa || [VISA_HEAD.slice()];
  const vSh = fakeSheet(visa, log);
  const central = opts.central || [["学籍番号", "ニックネーム", "国名", "名前英語"]];
  const past = opts.past || [["学籍番号", "ニックネーム", "国籍", "名前英語", "始業日"]];
  const notes = fakeSheet(opts.notes || [["入学期", "内容", "更新者", "更新日時", "リスト提出日", "申請日", "結果", "担当"]], log);
  const ctx = vm.createContext({
    console,
    _readTabs_: (names) => ({ Central_DB: central, Past_DB: past }),
    _getNoteSheet_: () => notes,
    Utilities: { formatDate: () => opts.today || "2026-09-01" },
    _hasPerm_: (r, p, need) => perms.indexOf(need) !== -1,
    _interviewResultsData_: () => irSh.getDataRange().getDisplayValues(),
    _getInterviewResultsSheet_: () => irSh,
    _getCancelSheet_: () => cSh,
    _getNotIssuedSheet_: () => nSh,
    _getOtherVisaSheet_: () => vSh,
    _bustInterviewCache_: () => {},
    _sheetRowForLog_: () => "row",
    _logActivity_: (a, action, target, d) => log.push("log:" + action + ":" + target + ":" + d),
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  });
  const src = [constLine("INCOMING_CANCEL_KINDS"), constLine("INCOMING_VISA_STATE"), constLine("NAME_MATCH_MIN_WORDS"), constLine("COUNTRY_SUFFIXES"), constLine("COUNTRY_ALIASES"), constBlock(code, "ACCENT_MAP")].concat(FNS.map(n => {
    const f = extract(code, n); if (!f) throw new Error("missing " + n); return f;
  })).join("\n");
  vm.runInContext(src, ctx);
  return { ctx, log, ir, cancel, notissued, visa };
}

const IR = () => [IR_HEAD.slice(),
  irRow("2026/04/01 10:00", "2026年10月生", "SAMPLE TARO", "○"),
  irRow("2026/04/02 10:00", "2026年10月生", "SAMPLE　HANAKO", "〇"),      // full-width space, 〇 (U+3007)
  irRow("2026/04/03 10:00", "2026年10月生", "NOT APPLIED", "✕"),
  irRow("2026/04/04 10:00", "2027年4月生", "SAMPLE TARO", "◯"),          // same name, other intake
  irRow("2026/04/05 10:00", "2026年10月生", "BLANK", ""),
  irRow("2026/04/06 10:00", "2027年4月生", "TWIN", "○"),
  irRow("2026/04/07 10:00", "2027年4月生", "twin", "○"),               // same person-key as TWIN
];
const CANCEL = () => [["入学期", "種別", "国籍", "名前", "課程", "担当"],
  ["2026年10月生", "申請取り下げ", "ネパール", "SAMPLE HANAKO", "進学2年", "営業 花子"],   // half-width space
  ["2027年4月生", "申請キャンセル", "", "TWIN", "", ""],
];
const ALL = ["view_incoming", "edit_incoming"];

console.log("1. the list: 申請 = ○ / 〇 / ◯, joined to 募集状況's キャンセル by 入学期 + name");
{
  const { ctx } = load(CODE, ALL, IR(), CANCEL());
  const res = ctx.getIncomingStudents();
  const names = res.rows.map(r => r[5]);
  check("○, 〇 and ◯ are in; ✕ and blank are out",
    JSON.stringify(names) === JSON.stringify(["SAMPLE TARO", "SAMPLE　HANAKO", "SAMPLE TARO", "TWIN", "twin"]), JSON.stringify(names));
  check("each row carries its sheet row and Timestamp", res.meta[1].sheetRow === 3 && res.meta[1].stamp === "2026/04/02 10:00");
  check("the cancellation joins through _normName_ (full-width vs half-width space)",
    res.meta[1].decided === "申請取り下げ", JSON.stringify(res.meta[1]));
  check("...scoped by 入学期: the same name in another intake is not cancelled", res.meta[0].decided === null && res.meta[2].decided === null);
  check("⚠️ two applicants on one key → conflict, never guessed", res.meta[3].conflict === true && res.meta[4].conflict === true);
  let threw = false;
  try { load(CODE, [], IR(), CANCEL()).ctx.getIncomingStudents(); } catch (e) { threw = /権限がありません/.test(e.message); }
  check("no view_incoming → refused", threw);
}

console.log("\n2. setIncomingState writes 募集状況's own キャンセル record");
{
  const t = load(CODE, ALL, IR(), CANCEL());
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "申請キャンセル");
  const added = t.cancel[t.cancel.length - 1];
  check("none → appended as 入学期|種別|国籍|名前|課程|担当, copied from the 面接結果 row",
    JSON.stringify(added) === JSON.stringify(["2026年10月生", "申請キャンセル", "ネパール", "SAMPLE TARO", "進学2年", "営業 花子"]), JSON.stringify(added));
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "COE後キャンセル");
  check("one → only 種別 changes (国籍/課程/担当 may have been corrected in 募集状況)",
    t.cancel.length === 4 && t.cancel[3][1] === "COE後キャンセル" && t.log.some(l => l === "setValue:4,2=COE後キャンセル"), JSON.stringify(t.cancel[3]));
  t.cancel[3][4] = "修正済み課程";   // a correction made in 募集状況
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "申請取り下げ");
  check("...and a later change keeps that correction", t.cancel[3][4] === "修正済み課程");
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "");
  check("'' → the row is deleted", t.cancel.length === 3 && t.log.some(l => l === "delete:4"));
  check("each change is in 操作履歴", t.log.filter(l => l.indexOf("log:入学予定者の状態") === 0).length === 4, JSON.stringify(t.log.filter(l => l.indexOf("log:") === 0)));

  const refuse = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  check("⚠️ a stale Timestamp is refused (rows shift on delete)",
    refuse(() => t.ctx.setIncomingState(2, "2026/04/09 99:99", "申請キャンセル"), /一覧が古くなっています/));
  check("⚠️ an ambiguous person is refused, pointing to 募集状況",
    refuse(() => t.ctx.setIncomingState(7, "2026/04/06 10:00", "申請キャンセル"), /募集状況/));
  const noIntake = IR(); noIntake[1][2] = "";
  check("no 入学期 → refused with an instruction",
    refuse(() => load(CODE, ALL, noIntake, CANCEL()).ctx.setIncomingState(2, "2026/04/01 10:00", "申請キャンセル"), /入学期を設定してください/));
  check("an unknown 種別 is refused", refuse(() => t.ctx.setIncomingState(2, "2026/04/01 10:00", "X"), /種別が不正/));
  const g = load(CODE, ["view_incoming"], IR(), CANCEL());
  check("no edit_incoming → refused before anything is written",
    refuse(() => g.ctx.setIncomingState(2, "2026/04/01 10:00", "申請キャンセル"), /権限がありません/) && g.log.length === 0);

  const evil = IR(); evil[1][5] = "=IMPORTXML(\"https://x\",\"//a\")";
  const e = load(CODE, ALL, evil, CANCEL());
  e.ctx.setIncomingState(2, "2026/04/01 10:00", "申請キャンセル");
  check("the appended row goes through _cellSafeRow_", String(e.cancel[e.cancel.length - 1][3]).charAt(0) === "'",
    JSON.stringify(e.cancel[e.cancel.length - 1]));

  // Mutation: drop the stamp check — the stale write must then go through.
  const m = load(CODE.replace(/if \(String\(all\[ri - 1\]\[0\] \|\| ""\) !== String\(stamp == null \? "" : stamp\)\) \{[\s\S]*?\n  \}\n/, ""), ALL, IR(), CANCEL());
  let wrote = true; try { m.ctx.setIncomingState(2, "stale", "申請キャンセル"); } catch (er) { wrote = false; }
  check("  mutation: without the Timestamp check a stale row is written (proves the check can fail)", wrote);
}

console.log("\n3. editing writes the 面接結果 row, through ONE writer");
{
  const t = load(CODE, ALL, IR(), CANCEL());
  t.ctx.updateIncomingStudent(2, "2026/04/01 10:00", { "名前": "SAMPLE TARO 2", "申請": "○", "備考": "=1+1" });
  check("the 面接結果 row is updated in place", t.ir[1][5] === "SAMPLE TARO 2" && t.ir[1][0] === "2026/04/01 10:00");
  check("⚠️ free text goes through _cellSafeRow_ (=1+1 stored as text)", t.ir[1][18] === "'=1+1", JSON.stringify(t.ir[1][18]));
  let stale = false; try { t.ctx.updateIncomingStudent(2, "old", {}); } catch (e) { stale = /一覧が古くなっています/.test(e.message); }
  check("a stale Timestamp is refused", stale);
  const up = extract(CODE, "updateInterviewResult") || "";
  check("面接結果's own edit uses the same writer", /_writeInterviewResultRow_\(sh, rowIndex, headers, allData\[rowIndex - 1\], entry\)/.test(up)
    && !/headers\.map\(function\(h, ci\)/.test(up));
  const unsafe = load(CODE.replace("setValues([_cellSafeRow_(row)])", "setValues([row])"), ALL, IR(), CANCEL());
  unsafe.ctx.updateIncomingStudent(2, "2026/04/01 10:00", { "名前": "X", "備考": "=1+1" });
  check("  mutation: without _cellSafeRow_ the formula is stored live", unsafe.ir[1][18] === "=1+1");
}

console.log("\n4. wiring");
{
  const reg = CODE.slice(CODE.indexOf("_apiRegistry = {"));
  check("all three endpoints are registered",
    ["getIncomingStudents", "setIncomingState", "updateIncomingStudent"].every(n => reg.indexOf("    " + n + ": " + n + ",") !== -1));
  check("⚠️ setIncomingCancellation is gone from the source AND the registry (no unused endpoint)",
    !/function setIncomingCancellation\(/.test(CODE) && reg.indexOf("setIncomingCancellation") === -1);
  check("none takes role / perms (D1)", ["getIncomingStudents()", "updateIncomingStudent(rowIndex, stamp, entry)", "setIncomingState(rowIndex, stamp, state)"]
    .every(sig => CODE.indexOf("function " + sig + " {") !== -1));
  const group = (HTML.match(/<fieldset class="perm-group" data-group="学生一覧">[\s\S]*?<\/fieldset>/) || [""])[0];
  check("both permissions sit in the 学生一覧 group", /value="view_incoming"/.test(group) && /value="edit_incoming"/.test(group));
  check("⚠️ neither collides with edit_enrollment as a substring (_hasResultPerm_ matches by indexOf)",
    ["view_incoming", "edit_incoming"].every(p => "edit_enrollment".indexOf(p) === -1 && p.indexOf("edit_enrollment") === -1));
  check("the sub-tab is hidden until view_incoming shows it",
    /id="btn-sub-incoming"[^>]*style="display:none;"/.test(HTML) && /incBtn\.style\.display = hasPermission\('view_incoming'\)/.test(HTML));
  check("the modal's dropdowns admit edit_incoming", /entry_interview_results"\) && !_hasPerm_\("", "", "edit_incoming"\)\)/.test(extract(CODE, "getInterviewResultOptions") || ""));
  check("編集 reuses the 面接結果 modal with a context, saving through updateIncomingStudent",
    /openInterviewResultEdit\(m\.sheetRow, \{ ctx: 'incoming'/.test(HTML) && /\.updateIncomingStudent\(_irEditRow, stamp, entry\)/.test(HTML));
  check("the closer clears the context with the row", /_irEditRow = null;\s*_irCtx = null;/.test(HTML));
  check("a cancellation tells 募集状況 to reload", /recLoaded = false;\s*\/\/ 募集状況 shows the same record/.test(HTML));
}

console.log("\n5. enrolled students leave the list; 申請中 from the intake's 申請日");
{
  const ctx0 = load(CODE, ALL, IR(), CANCEL()).ctx;
  const K = ctx0._nameTokensKey_;
  check("name key: any word order, case, full-width and spacing", K("SAMPLE TARO") === K("taro　ｓａｍｐｌｅ") && K("SAMPLE  TARO ") === K("Taro Sample"));
  check("...a blank name has no key", K("") === "" && K("　 ") === "");

  const central = [["学籍番号", "ニックネーム", "国名", "名前英語"],
    ["202610001", "", "ネパール", "TARO SAMPLE"],          // SAMPLE TARO 2026年10月生 — reordered
    ["202610002", "", "ベトナム", "SAMPLE AUNG"],           // nobody: wrong nationality for any applicant
    ["202610003", "", "ネパール", "HANAKO SAMPLE"],         // SAMPLE　HANAKO — but she is cancelled
    ["202610004", "", "", ""]];                             // blanks must never match
  const notes = [["入学期", "内容", "更新者", "更新日時", "リスト提出日", "申請日", "結果", "担当"],
    ["2026年10月生", "", "", "", "", "2026-09-01", "", ""],
    ["2027年4月生", "", "", "", "", "not a date", "", ""]];
  const run = (code, today) => load(code, ALL, IR(), CANCEL(), { central, notes, today }).ctx.getIncomingStudents();
  const res = run(CODE, "2026-09-01");
  const names = res.rows.map(r => r[5]);
  // ⚠️ The match is by ENROLMENT: 学籍番号 202610… is the 2026年10月 intake, so only that SAMPLE TARO
  // is hidden; the 2027年4月 application by the same name stays (decided 2026-10-02).
  check("an enrolled, uncancelled student leaves the list (word order ignored)",
    !res.rows.some(r => r[5] === "SAMPLE TARO" && r[2] === "2026年10月生"), JSON.stringify(names));
  check("...but only for the intake their 学籍番号 names", res.rows.some(r => r[5] === "SAMPLE TARO" && r[2] === "2027年4月生"));
  check("...and is counted per intake, so the screen can say where they went",
    JSON.stringify(res.hiddenEnrolled) === JSON.stringify({ "2026年10月生": 1 }), JSON.stringify(res.hiddenEnrolled));
  const hanako = res.meta[names.indexOf("SAMPLE　HANAKO")];
  check("⚠️ cancelled AND enrolled stays, flagged enrolledToo (要確認)", hanako && hanako.enrolledToo === true && hanako.decided === "申請取り下げ");
  check("rows that match nobody in 学生一覧 stay (TWIN / twin)",
    names.indexOf("TWIN") !== -1 && names.indexOf("twin") !== -1);
  check("申請中 on the 申請日 itself", res.meta.filter((m, i) => res.rows[i][2] === "2026年10月生").every(m => m.applied === true));
  check("an unparseable 申請日 is not applied, and does not leak across intakes",
    res.meta.filter((m, i) => res.rows[i][2] === "2027年4月生").every(m => m.applied === false));
  check("the response carries the parsed 申請日 per intake", JSON.stringify(res.applyDates) === JSON.stringify({ "2026年10月生": "2026-09-01" }));
  check("before the 申請日 → not applied", run(CODE, "2026-08-31").meta.every(m => m.applied === false));
  const slashed = notes.map(r => r.slice()); slashed[1][5] = "2026/9/1";
  check("yyyy/m/d is accepted too", load(CODE, ALL, IR(), CANCEL(), { central, notes: slashed, today: "2026-09-02" }).ctx.getIncomingStudents()
    .meta.some(m => m.applied === true));

  // Mutations.
  // ⚠️ Two blanks must never mean "same person": an applicant with no 国籍 and a 学生一覧 row with
  // no 国名 share a name, and must NOT be matched.
  const noNatIR = IR(); noNatIR.push(irRow("2026/04/08 10:00", "2026年10月生", "NO NATIONALITY", "○", { 4: "" }));
  const blankCentral = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610009", "", "", "NO NATIONALITY"]];
  const blankRun = (code) => load(code, ALL, noNatIR, CANCEL(), { central: blankCentral, notes, today: "2026-09-01" })
    .ctx.getIncomingStudents().rows.some(r => r[5] === "NO NATIONALITY");
  check("⚠️ a blank 国籍 never matches a blank 国名", blankRun(CODE) === true);
  const loose = CODE.replace('if (n.length && c !== "") {', 'if (n.length) {')
                    .replace('if (c === "" || !n.length || it === "") return null;', 'if (!n.length || it === "") return null;');
  check("  mutation: allowing blank-nationality keys hides them (proves the guard matters)", loose !== CODE && blankRun(loose) === false);
  const strict = CODE.replace("today >= dates.apply[intake]", "today > dates.apply[intake]");
  check("  mutation: '>' instead of '>=' misses the 申請日 itself (proves the check can fail)",
    strict !== CODE && run(strict, "2026-09-01").meta.every(m => m.applied === false));
  const nameOnly = CODE.replace('(idx[c] || []).forEach(function (e) {',
    'Object.keys(idx).reduce(function (a, k) { return a.concat(idx[k]); }, []).forEach(function (e) {');
  const vietnamAung = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610002", "", "ベトナム", "SAMPLE TARO"]];
  const byName = load(nameOnly, ALL, IR(), CANCEL(), { central: vietnamAung, notes, today: "2026-09-01" }).ctx.getIncomingStudents();
  const byBoth = load(CODE, ALL, IR(), CANCEL(), { central: vietnamAung, notes, today: "2026-09-01" }).ctx.getIncomingStudents();
  check("⚠️ a namesake from another country is NOT hidden", byBoth.rows.filter(r => r[5] === "SAMPLE TARO").length === 2);
  check("  mutation: matching on the name alone hides that namesake (proves the nationality half matters)",
    byName.rows.filter(r => r[5] === "SAMPLE TARO").length === 1);
}

console.log("\n6. middle names: one name's words are a subset of the other's");
{
  const { ctx } = load(CODE, ALL, IR(), CANCEL());
  const M = (a, b) => ctx._namesMatch_(ctx._nameTokens_(a), ctx._nameTokens_(b));
  check("a dropped middle name matches", M("SAMPLE MORGAN", "SAMPLE RIVERA ALEX MORGAN"));
  check("...either way round, in any order", M("SAMPLE RIVERA ALEX MORGAN", "morgan　ｓａｍｐｌｅ"));
  check("⚠️ one shared word is not a person", !M("SAMPLE", "SAMPLE TARO") && !M("SAMPLE TARO", "SAMPLE"));
  check("different given names do not match", !M("SAMPLE TARO", "SAMPLE JIRO"));
  check("a repeated word must appear twice", !M("ALI ALI", "ALI KHAN") && M("ALI ALI", "ALI KHAN ALI"));
  check("blank never matches", !M("", "") && !M("", "SAMPLE TARO"));
  const idx = { "ネパール": [{ variants: ctx._nameVariants_("SAMPLE RIVERA ALEX MORGAN"), src: "central", intake: "2026-10" }] };
  check("_isEnrolled_ needs the nationality too", ctx._isEnrolled_("SAMPLE MORGAN", "ネパール", "2026年10月生", idx) === "central" && ctx._isEnrolled_("SAMPLE MORGAN", "ベトナム", "2026年10月生", idx) === null);
  const looseSrc = CODE.replace("if (i === s.length) return same >= NAME_MATCH_MIN_WORDS;", "if (i === s.length) return true;");
  const loose = load(looseSrc, ALL, IR(), CANCEL()).ctx;
  check("  mutation: without the 2-word minimum a family name alone matches (proves the minimum matters)",
    looseSrc !== CODE && loose._namesMatch_(loose._nameTokens_("SAMPLE"), loose._nameTokens_("SAMPLE TARO")) === true);

  // End to end: the interview record drops the middle names, 学生一覧 has the passport name.
  const ir = IR(); ir[1][5] = "SAMPLE MORGAN";
  const central = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610001", "", "ネパール", "SAMPLE RIVERA ALEX MORGAN"]];
  const res = load(CODE, ALL, ir, CANCEL(), { central, today: "2026-09-01" }).ctx.getIncomingStudents();
  check("getIncomingStudents hides the enrolled student whose middle names were left out",
    !res.rows.some(r => r[5] === "SAMPLE MORGAN") && res.hiddenEnrolled["2026年10月生"] === 1, JSON.stringify(res.hiddenEnrolled));
}

console.log("\n7. 出力: exactly what is on screen, through the shared pipeline");
{
  const CLIENT = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || "";
  const fnSrc = (n) => { const f = extract("\n" + CLIENT.replace(/^\s+function /gm, "function "), n); if (!f) throw new Error("missing client " + n); return f; };
  const vals = { incIntakeSel: "__all", incStateSel: "", incSearchInp: "" };
  const cctx = vm.createContext({
    document: { getElementById: (id) => (id in vals ? { value: vals[id] } : null) },
    formatDateDisplay: (s) => String(s).replace(/-/g, "/"),
  });
  const constArr = (n) => ((CLIENT.match(new RegExp("const " + n + " = \\[[\\s\\S]*?\\];")) || [""])[0]).replace(/^const /, "var ");
  vm.runInContext(constBlock(CLIENT, "ACCENT_MAP") + "\n" + ["INC_FACETS", "INC_SORT_COLS", "INC_STATE_ORDER"].map(constArr).join("\n") + "\n"
    + ["normName", "_foldAccents", "incCol", "incCell", "incState", "incStateLabel", "incFilterSpec", "incPasses", "incVisible", "incSortIdx", "_intakeSortKey", "_visaDays", "_tableSortKey", "incExportRows"].map(fnSrc).join("\n")
    + "\nvar incData = null; var _incSort = { col: -1, asc: true };", cctx);
  const H = ["Timestamp", "入学期", "課程", "国籍", "名前", "性別", "担当", "備考"];
  cctx.incData = {
    headers: H,
    rows: [["t1", "2026年10月生", "進学2年", "ネパール", "SAMPLE TARO", "男", "営業 花子", "=1+1"],
           ["t2", "2026年10月生", "進学2年", "ベトナム", "SAMPLE HANAKO", "女", "営業 次郎", ""],
           ["t3", "2027年4月生", "就職2年", "スリランカ", "SAMPLE PERERA", "女", "営業 次郎", "書類不足"]],
    meta: [{ applied: true, decided: null }, { decided: "申請取り下げ" }, { decided: "COE後キャンセル", enrolledToo: true }],
    applyDates: { "2026年10月生": "2026-08-01" },
  };
  const rows = () => JSON.parse(JSON.stringify(cctx.incExportRows()));
  const all = rows();
  check("header row", all[0].join(",") === "入学期,申請日,結果日,課程,国籍,名前,性別,担当,状態,備考");
  check("状態 as the screen words it, 申請日 per intake",
    all[1][8] === "申請中" && all[1][1] === "2026/08/01" && all[2][8] === "申請取り下げ" && all[3][8] === "要確認（COE後キャンセル）" && all[3][1] === "",
    JSON.stringify(all));
  vals.incIntakeSel = "2026年10月生"; check("the 入学期 filter is honoured", rows().length === 3);
  vals.incStateSel = "cancel"; check("the 状態 filter is honoured", rows().length === 2 && rows()[1][5] === "SAMPLE HANAKO");
  vals.incIntakeSel = "__all"; vals.incStateSel = ""; vals.incSearchInp = "ｐｅｒｅｒａ";
  check("the search is honoured (through normName)", rows().length === 2 && rows()[1][5] === "SAMPLE PERERA");

  const exp = (CLIENT.match(/function _expActive\(\)[\s\S]*?\n      }/) || [""])[0];
  check("registered with a rows provider, not a table read",
    /sub: 'incoming',[^}]*rows: function \(\) \{ return incExportRows\(\); \}/.test(exp));
  const bar = (HTML.match(/<div class="inc-bar">[\s\S]*?\n          <\/div>/) || [""])[0];
  check("the 出力 wrapper is gated on export_students and is LAST in the toolbar",
    /exp-wrap permission-req" data-perm="export_students"/.test(bar) && bar.lastIndexOf("exp-wrap") > bar.lastIndexOf("schedule-btn"));
  check("incRender and the export share ONE filter", /const shown = incVisible\(\)/.test(CLIENT) && /incVisible\(\)\.forEach/.test(fnSrc("incExportRows")));
}

console.log("\n8. accent marks, and Past_DB (graduates, early graduates, drop-outs)");
{
  const { ctx } = load(CODE, ALL, IR(), CANCEL());
  const K = ctx._nameTokensKey_;
  check("Nguyễn Văn An = NGUYEN VAN AN", K("Nguyễn Văn An") === K("NGUYEN VAN AN"));
  check("Đặng = Dang (Đ does not decompose under NFD; the map covers it)", K("Đặng Thị Lan") === K("DANG THI LAN"));
  check("Müller / Øystein / Łukasz / Strauß fold", K("Müller") === K("muller") && K("Øystein") === K("oystein") && K("Łukasz") === K("lukasz") && K("Strauß") === K("strauss"));
  check("an unaccented name is unchanged", K("SAMPLE TARO") === "sample taro");
  check("⚠️ _normName_ itself is NOT changed (it backs ~90 other lookups)", ctx._normName_("Nguyễn") !== ctx._normName_("Nguyen"));
  const noD = load(CODE.replace('"\\u0110": "D", ', '').replace("\\u0111\\u0110", "\\u0111"), ALL, IR(), CANCEL()).ctx;
  check("  mutation: without the Đ entry, Đặng no longer equals Dang", noD._nameTokensKey_("Đặng") !== noD._nameTokensKey_("Dang"));
  const noNfd = load(CODE.replace('.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")', ""), ALL, IR(), CANCEL()).ctx;
  check("  mutation: without the NFD strip, Nguyễn no longer equals Nguyen", noNfd._nameTokensKey_("Nguyễn") !== noNfd._nameTokensKey_("Nguyen"));
  const CLIENT = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || "";
  const norm = (t) => t.replace(/^var /, "").replace(/\s+/g, " ");
  check("the client's ACCENT_MAP is identical to the server's", norm(constBlock(CLIENT, "ACCENT_MAP")) === norm(constBlock(CODE, "ACCENT_MAP")) && constBlock(CODE, "ACCENT_MAP") !== "");
  check("⚠️ no raw combining mark in either file (escapes only)", !/[\u0300-\u036f]/.test(CODE) && !/[\u0300-\u036f]/.test(HTML));

  // Past_DB, whose nationality header is 国籍. Its 学籍番号 intake must equal the application's.
  const ir = IR(); ir[1][1] = "2026/04/01"; ir[1][5] = "Nguyễn Văn An"; ir[1][4] = "ベトナム";
  // The two 2027年4月生 rows become a two-word name (a single word never matches).
  ir[6][1] = "2026/04/06"; ir[6][5] = "SAMPLE TWIN"; ir[7][1] = "2026/04/07"; ir[7][5] = "sample twin";
  const past = [["学籍番号", "ニックネーム", "国籍", "名前英語", "始業日"],
    ["202610101", "", "ベトナム", "NGUYEN VAN AN", "2026/10/01"],    // 2026年10月: this application
    ["202004001", "", "ネパール", "SAMPLE TWIN", "2020/04/01"]];     // 2020年4月: a re-applicant
  const run = (code, opts) => load(code, ALL, ir, CANCEL(), Object.assign({ past, today: "2026-09-01" }, opts || {})).ctx.getIncomingStudents();
  const res = run(CODE);
  check("a graduate's old application is hidden (accents folded), counted under hiddenPast",
    !res.rows.some(r => r[5] === "Nguyễn Văn An") && res.hiddenPast["2026年10月生"] === 1, JSON.stringify(res.hiddenPast));
  check("Past_DB's 国籍 column is the one read (a 国名 lookup would find nothing)", res.hiddenPast["2026年10月生"] === 1);
  check("⚠️ a former student who applies again stays listed (their 学籍番号 names an older intake)",
    res.rows.filter(r => /twin/i.test(r[5])).length === 2);
  const thisIntake = past.map(r => r.slice()); thisIntake[2][0] = "202704001";
  check("a Past_DB record OF this intake is hidden (始業日 no longer consulted)", run(CODE, { past: thisIntake }).hiddenPast["2027年4月生"] >= 1);
  const central = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610001", "", "ベトナム", "Nguyen Van An"]];
  const both = run(CODE, { central });
  check("Central wins over Past when both match", both.hiddenEnrolled["2026年10月生"] === 1 && !both.hiddenPast["2026年10月生"]);
  const noGuard = CODE.replace('if (found === "central" || e.intake !== it || ', 'if (found === "central" || ');
  check("  mutation: without the intake check the re-applicant is hidden (proves the check matters)",
    noGuard !== CODE && run(noGuard).rows.filter(r => /twin/i.test(r[5])).length === 0);
  const cIr = IR(); cIr[2][1] = "2026/04/02"; cIr[2][4] = "ベトナム";                   // SAMPLE　HANAKO, cancelled
  const cPast = [past[0], ["202610103", "", "ベトナム", "SAMPLE HANAKO", "2026/10/01"]];
  const cRes = load(CODE, ALL, cIr, CANCEL(), { past: cPast, today: "2026-09-01" }).ctx.getIncomingStudents();
  const h = cRes.meta[cRes.rows.findIndex(r => r[5] === "SAMPLE　HANAKO")];
  check("a cancelled Past_DB match stays, as 要確認 (enrolledToo, src past)", h && h.enrolledToo === true && h.enrolledSrc === "past", JSON.stringify(h));
}

console.log("\n9. results: automatic 入学予定, 不交付 in 募集状況's roster, and the 7-day banner");
{
  const NI_HEAD = [["入学期", "国籍", "名前", "課程", "担当"]];
  const refuse = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  // Transitions, one person (row 2 = SAMPLE TARO, 2026年10月生).
  const t = load(CODE, ALL, IR(), CANCEL(), { notissued: NI_HEAD.slice() });
  const holds = () => ({
    cancel: t.cancel.filter(r => r[3] === "SAMPLE TARO").map(r => r[1]),
    ni: t.notissued.filter(r => r[2] === "SAMPLE TARO").length,
  });
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "不交付");
  const ni = t.notissued[t.notissued.length - 1];
  check("不交付 → appended to 募集状況's 不交付 roster as 入学期|国籍|名前|課程|担当",
    JSON.stringify(ni) === JSON.stringify(["2026年10月生", "ネパール", "SAMPLE TARO", "進学2年", "営業 花子"]) && holds().cancel.length === 0, JSON.stringify(ni));
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "COE後キャンセル");
  check("不交付 → COE後キャンセル: the 不交付 row goes, a キャンセル row appears (exclusive)",
    holds().ni === 0 && JSON.stringify(holds().cancel) === JSON.stringify(["COE後キャンセル"]));
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "不交付");
  check("COE後キャンセル → 不交付: the キャンセル row goes", holds().ni === 1 && holds().cancel.length === 0);
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "");
  check("'' → back to automatic: neither roster holds them", holds().ni === 0 && holds().cancel.length === 0);
  check("入学予定 cannot be SET (it is automatic)", refuse(() => t.ctx.setIncomingState(2, "2026/04/01 10:00", "入学予定"), /種別が不正/));
  const both = load(CODE, ALL, IR(), CANCEL().concat([["2026年10月生", "申請キャンセル", "", "SAMPLE TARO", "", ""]]),
    { notissued: NI_HEAD.concat([["2026年10月生", "", "SAMPLE TARO", "", ""]]) });
  check("⚠️ decisions in BOTH rosters are refused, never guessed",
    refuse(() => both.ctx.setIncomingState(2, "2026/04/01 10:00", "不交付"), /複数あるため変更できません/));
  const evil = IR(); evil[1][5] = "=IMPORTXML(\"https://x\",\"//a\")";
  const e = load(CODE, ALL, evil, CANCEL(), { notissued: NI_HEAD.slice() });
  e.ctx.setIncomingState(2, "2026/04/01 10:00", "不交付");
  check("the 不交付 row goes through _cellSafeRow_", String(e.notissued[e.notissued.length - 1][2]).charAt(0) === "'");

  // getIncomingStudents: automatic 入学予定 from 結果日, overridden by any decision.
  const notes = [["入学期", "内容", "更新者", "更新日時", "リスト提出日", "申請日", "結果", "担当"],
    ["2026年10月生", "", "", "", "", "2026-08-01", "2026-09-20", ""]];
  const get = (today, extra) => load(CODE, ALL, IR(), CANCEL(), Object.assign({ notes, today, notissued: NI_HEAD.slice() }, extra || {})).ctx.getIncomingStudents();
  const before = get("2026-09-19"), on = get("2026-09-20");
  const taro = (res) => res.meta[res.rows.findIndex(r => r[5] === "SAMPLE TARO" && r[2] === "2026年10月生")];
  check("not 入学予定 the day before 結果日", taro(before).planned === false && taro(before).applied === true);
  check("入学予定 ON 結果日 (automatic)", taro(on).planned === true);
  check("a decision overrides it (申請取り下げ stays 申請取り下げ)", on.meta[on.rows.findIndex(r => r[5] === "SAMPLE　HANAKO")].decided === "申請取り下げ");
  check("resultDates and today are returned", on.resultDates["2026年10月生"] === "2026-09-20" && on.today === "2026-09-20");
  const handNi = get("2026-09-20", { notissued: NI_HEAD.concat([["2026年10月生", "ネパール", "sample taro", "", ""]]) });
  check("a 不交付 entered in 募集状況 by hand shows here", taro(handNi).decided === "不交付");
  const strict = load(CODE.replace("today >= dates.result[intake]", "today > dates.result[intake]"), ALL, IR(), CANCEL(), { notes, today: "2026-09-20", notissued: NI_HEAD.slice() }).ctx.getIncomingStudents();
  check("  mutation: '>' instead of '>=' misses 結果日 itself", taro(strict).planned === false);
  const central = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610001", "", "ネパール", "TARO SAMPLE"]];
  const enrolledNi = get("2026-09-20", { central, notissued: NI_HEAD.concat([["2026年10月生", "", "SAMPLE TARO", "", ""]]) });
  const tn = enrolledNi.meta[enrolledNi.rows.findIndex(r => r[5] === "SAMPLE TARO" && r[2] === "2026年10月生")];
  check("不交付 + enrolled → stays, as 要確認 (enrolledToo)", tn && tn.decided === "不交付" && tn.enrolledToo === true);
  const enrolledPlan = get("2026-09-20", { central });
  check("入学予定 + enrolled → hidden (the expected path)", !enrolledPlan.rows.some(r => r[5] === "SAMPLE TARO" && r[2] === "2026年10月生"));

  // Client: classifier and banner window.
  const CLIENT = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || "";
  const fnSrc = (n) => { const f = extract("\n" + CLIENT.replace(/^\s+function /gm, "function "), n); if (!f) throw new Error("missing client " + n); return f; };
  let store = null, throwing = false;
  const cctx = vm.createContext({
    localStorage: { getItem: (k) => { if (throwing) throw new Error("x"); return store; }, setItem: (k, v) => { if (throwing) throw new Error("x"); store = v; } },
    document: { getElementById: () => null },
  });
  vm.runInContext("var INC_BANNER_KEY = 'k', INC_BANNER_DAYS = 7, incData = null;\n"
    + ["normName", "incCol", "incCell", "incIntakeKey", "incState", "_incDismissed", "_incDays", "incBannerItems"].map(fnSrc).join("\n"), cctx);
  const S = cctx.incState;
  check("incState: conflict / 不交付 / cancel / planned / applied / active",
    S({ conflict: true }) === "check" && S({ decided: "不交付" }) === "notissued" && S({ decided: "COE後キャンセル" }) === "cancel"
    && S({ decided: "不交付", enrolledToo: true }) === "check" && S({ planned: true, applied: true }) === "planned"
    && S({ applied: true }) === "applied" && S({}) === "active");
  const H = ["Timestamp", "入学期", "名前"];
  const banner = (today) => {
    cctx.incData = { headers: H, rows: [["t", "2026年10月生", "A"], ["t", "2026年10月生", "B"]],
      meta: [{ planned: true }, { decided: "不交付" }], resultDates: { "2026年10月生": "2026-09-20" }, today };
    return JSON.parse(JSON.stringify(cctx.incBannerItems()));
  };
  check("banner: shows ON 結果日 with the 入学予定 count", banner("2026-09-20").length === 1 && banner("2026-09-20")[0].count === 1);
  check("banner: still shows on day 6", banner("2026-09-26").length === 1);
  check("banner: gone on day 7, and before 結果日", banner("2026-09-27").length === 0 && banner("2026-09-19").length === 0);
  store = JSON.stringify(["2026年10月生|2026-09-20"]);
  check("banner: a dismissed 入学期|結果日 stays hidden", banner("2026-09-21").length === 0);
  store = JSON.stringify(["2026年10月生|2026-09-13"]);
  check("banner: a MOVED 結果日 is a new key, so it shows again", banner("2026-09-21").length === 1);
  throwing = true;
  check("banner: a throwing localStorage just shows it", banner("2026-09-21").length === 1);
}

console.log("\n10. bracketed names: the text in brackets is another writing of the name");
{
  const { ctx } = load(CODE, ALL, IR(), CANCEL());
  const V = (v) => JSON.stringify(ctx._nameVariants_(v));
  const M = (a, b) => ctx._anyNamesMatch_(ctx._nameVariants_(a), ctx._nameVariants_(b));
  check("王小明 (WANG XIAOMING) → two writings", V("王小明 (WANG XIAOMING)") === JSON.stringify([["王小明"], ["wang", "xiaoming"]]), V("王小明 (WANG XIAOMING)"));
  check("no brackets → exactly [_nameTokens_]", V("SAMPLE　TARO") === JSON.stringify([ctx._nameTokens_("SAMPLE　TARO")]) && V("") === "[]");
  check("a bracketed name matches its romanisation, either way round",
    M("王小明 (WANG XIAOMING)", "WANG XIAOMING") && M("WANG XIAOMING", "王小明 (WANG XIAOMING)"));
  check("full-width （ ） too", M("王小明（WANG XIAOMING）", "wang xiaoming"));
  check("word order does not matter: (XIAOMING WANG) = WANG XIAOMING", M("王小明 (XIAOMING WANG)", "WANG XIAOMING"));
  check("...nor with a middle name in between", M("王小明 (WANG XIAOMING)", "XIAOMING RIVERA WANG"));
  check("⚠️ the Chinese writing does not count as extra words: 李明 (LI MING) = LI MING HUA", M("李明 (LI MING)", "LI MING HUA"));
  check("a one-word writing alone matches nothing", !M("王小明", "王小明 (WANG XIAOMING)") && !M("王小明 (WANG)", "WANG XIAOMING"));
  check("different romanisations do not match", !M("王小明 (WANG XIAOMING)", "WANG XIAOHONG"));
  check("a stray bracket is a space", M("王小明 (WANG XIAOMING", "WANG XIAOMING"));
  check("accents fold inside the brackets", M("阮文安 (Nguyễn Văn An)", "NGUYEN VAN AN"));
  const flat = load(CODE.replace(/function _nameVariants_\(v\) \{[\s\S]*?\n\}/, "function _nameVariants_(v) { const t = _nameTokens_(v); return t.length ? [t] : []; }"), ALL, IR(), CANCEL()).ctx;
  check("  mutation: without the variants the bracketed name never matches",
    !flat._anyNamesMatch_(flat._nameVariants_("王小明 (WANG XIAOMING)"), flat._nameVariants_("WANG XIAOMING")));
  const merged = load(CODE.replace(/function _nameVariants_\(v\) \{[\s\S]*?\n\}/, "function _nameVariants_(v) { const t = _nameTokens_(String(v).replace(/[()（）]/g, \" \")); return t.length ? [t] : []; }"), ALL, IR(), CANCEL()).ctx;
  check("  mutation: brackets as mere spaces lose 李明 (LI MING) = LI MING HUA",
    !merged._anyNamesMatch_(merged._nameVariants_("李明 (LI MING)"), merged._nameVariants_("LI MING HUA")));
  const orderedSrc = CODE.replace("for (let j = 0; j < l.length; j++) {", "for (let j = i; j <= i && j < l.length; j++) {");
  const ordered = load(orderedSrc, ALL, IR(), CANCEL()).ctx;
  check("  mutation: a position-by-position compare fails the word-order checks",
    orderedSrc !== CODE && !ordered._anyNamesMatch_(ordered._nameVariants_("王小明 (XIAOMING WANG)"), ordered._nameVariants_("WANG XIAOMING")));

  // End to end: 面接結果 holds the Chinese name with its romanisation, 学生一覧 the passport name.
  const ir = IR(); ir[1][5] = "王小明 (XIAOMING WANG)";
  const central = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610001", "", "ネパール", "WANG XIAOMING"]];
  const res = load(CODE, ALL, ir, CANCEL(), { central, today: "2026-09-01" }).ctx.getIncomingStudents();
  check("getIncomingStudents hides the enrolled student written 王小明 (XIAOMING WANG)",
    !res.rows.some(r => r[5] === "王小明 (XIAOMING WANG)") && res.hiddenEnrolled["2026年10月生"] === 1, JSON.stringify(res.hiddenEnrolled));
}

console.log("\n11. 募集状況's キャンセル / 不交付 find the person by any writing of the name");
{
  const ir = () => { const t = IR(); t[1][5] = "王小明 (WANG XIAOMING)"; t[2][5] = "李明（LI MING）"; return t; };
  const cancel = () => [CANCEL()[0], ["2026年10月生", "申請キャンセル", "", "XIAOMING WANG", "", ""]];   // romanised, reversed
  const ni = () => [["入学期", "国籍", "名前", "課程", "担当"], ["2026年10月生", "", "李明", "", ""]];  // Chinese only
  const at = (res, n) => res.meta[res.rows.findIndex(r => r[5] === n)];
  const res = load(CODE, ALL, ir(), cancel(), { notissued: ni() }).ctx.getIncomingStudents();
  check("a キャンセル written 「XIAOMING WANG」 is 王小明 (WANG XIAOMING)'s", at(res, "王小明 (WANG XIAOMING)").decided === "申請キャンセル", JSON.stringify(at(res, "王小明 (WANG XIAOMING)")));
  check("a 不交付 written 「李明」 is 李明（LI MING）'s", at(res, "李明（LI MING）").decided === "不交付", JSON.stringify(at(res, "李明（LI MING）")));
  check("...still scoped by 入学期", at(res, "SAMPLE TARO").decided === null);
  const two = ir(); two[4][2] = "2026年10月生"; two[4][5] = "王小明 (WANG XIAOHONG)";               // a second 王小明 in the intake
  const amb = load(CODE, ALL, two, [CANCEL()[0], ["2026年10月生", "申請キャンセル", "", "王小明", "", ""]]).ctx.getIncomingStudents();
  check("⚠️ 「王小明」 against two applicants sharing that writing → 要確認, never guessed",
    amb.meta.filter((m, k) => /王小明/.test(amb.rows[k][5])).every(m => m.conflict === true));
  check("...while 「WANG XIAOHONG」 finds only its own applicant",
    load(CODE, ALL, two, [CANCEL()[0], ["2026年10月生", "申請キャンセル", "", "WANG XIAOHONG", "", ""]]).ctx.getIncomingStudents()
      .meta.filter(m => m.decided === "申請キャンセル").length === 1);
  check("⚠️ a SUBSET is not a hit here (this join writes): 「WANG」 finds nobody",
    load(CODE, ALL, ir(), [CANCEL()[0], ["2026年10月生", "申請キャンセル", "", "WANG", "", ""]]).ctx.getIncomingStudents().meta.every(m => m.decided === null));

  // setIncomingState finds the 募集状況 row by writing: it changes it, never appends a second.
  const t = load(CODE, ALL, ir(), cancel(), { notissued: ni() });
  t.ctx.setIncomingState(2, "2026/04/01 10:00", "COE後キャンセル");
  check("setIncomingState updates the existing 「XIAOMING WANG」 row in place",
    t.cancel.length === 2 && t.cancel[1][1] === "COE後キャンセル" && t.cancel[1][3] === "XIAOMING WANG", JSON.stringify(t.cancel));
  t.ctx.setIncomingState(3, "2026/04/02 10:00", "");
  check("...and '' clears the 「李明」 不交付 row", t.notissued.length === 1);
  const refuse = (fn) => { try { fn(); return false; } catch (e) { return /複数あるため/.test(e.message); } };
  const two2 = () => { const x = ir(); x[4][2] = "2026年10月生"; x[4][5] = "王小明 (WANG XIAOHONG)"; return x; };
  const u = load(CODE, ALL, two2(), [CANCEL()[0], ["2026年10月生", "申請キャンセル", "", "WANG XIAOHONG", "", ""]]);
  u.ctx.setIncomingState(5, "2026/04/04 10:00", "申請取り下げ");
  check("setIncomingState: 「WANG XIAOHONG」 is changed for its applicant despite a second 王小明",
    u.cancel.length === 2 && u.cancel[1][1] === "申請取り下げ", JSON.stringify(u.cancel));
  check("⚠️ with no record yet, a new row 「王小明 (WANG XIAOHONG)」 would name both 王小明 → refused",
    refuse(() => load(CODE, ALL, two2(), [CANCEL()[0]]).ctx.setIncomingState(5, "2026/04/04 10:00", "申請キャンセル")));
  const byRow = CODE.replace("const same = hit ? _incomingHits_(applicants[r._intake], hit.writings).length : 0;",
    "const same = hit ? _incomingHits_(applicants[r._intake], r._writings).length : 0;");
  check("  mutation: counting from the applicant's writings makes 「WANG XIAOHONG」 要確認",
    byRow !== CODE && load(byRow, ALL, two2(), [CANCEL()[0], ["2026年10月生", "申請キャンセル", "", "WANG XIAOHONG", "", ""]]).ctx.getIncomingStudents()
      .meta.some(m => m.conflict === true));
  const flat = load(CODE.replace(/function _incomingWritings_\(name\) \{[\s\S]*?\n\}/,
    "function _incomingWritings_(name) { const n = _normName_(name); return n ? [[n]] : []; }"), ALL, ir(), cancel(), { notissued: ni() }).ctx.getIncomingStudents();
  check("  mutation: a whole-string key misses both rosters (proves the writings matter)",
    flat.meta.every(m => m.decided === null));
}

console.log("\n12. initials and surname-first: John S. Doe = Doe, S. John = John Someone Doe");
{
  const { ctx } = load(CODE, ALL, IR(), CANCEL());
  const T = (v) => JSON.stringify(ctx._nameTokens_(v));
  const M = (a, b) => ctx._anyNamesMatch_(ctx._nameVariants_(a), ctx._nameVariants_(b));
  const E = (a, b) => ctx._incomingSameName_(ctx._incomingWritings_(a), ctx._incomingWritings_(b));
  check("full stops and commas separate words", T("J.S. Doe") === '["j","s","doe"]' && T("Doe, S. John") === '["doe","s","john"]' && T("DOE，JOHN．S") === '["doe","john","s"]', T("DOE，JOHN．S"));
  check("John S. Doe = John Someone Doe, either way round", M("John S. Doe", "John Someone Doe") && M("JOHN SOMEONE DOE", "john s doe"));
  check("Doe, S. John = John Someone Doe", M("Doe, S. John", "John Someone Doe") && M("John Someone Doe", "Doe, S. John"));
  check("DOE，JOHN = John Doe", M("DOE，JOHN", "John Doe"));
  check("an initial also fills in beside a dropped middle name", M("John S. Doe", "John Someone Rivera Doe"));
  check("the wrong initial does not match", !M("John S. Doe", "John Tom Doe"));
  check("⚠️ an initial never makes the two-word minimum: J. Doe ≠ John Doe", !M("J. Doe", "John Doe") && !M("John Doe", "J Doe"));
  check("⚠️ a lone CJK character is not an initial: 李 明 华 ≠ 李伟 明 华", !M("李 明 华", "李伟 明 华"));
  check("unchanged: a dropped middle name, a repeated word, a single shared word",
    M("SAMPLE MORGAN", "SAMPLE RIVERA ALEX MORGAN") && !M("ALI ALI", "ALI KHAN") && !M("SAMPLE", "SAMPLE TARO"));
  check("roster join: JOHN S DOE = Doe, Someone John, same length only",
    E("JOHN S DOE", "Doe, Someone John") && !E("JOHN DOE", "John Someone Doe") && E("Doe, John", "JOHN DOE"));
  check("roster join: a one-word writing still needs the whole name", E("王小明", "王小明 (WANG XIAOMING)") && !E("J DOE", "JOHN DOE"));
  const noInit = load(CODE.replace("const ok = pass === 0 ? x === w", "const ok = pass === 0 ? x === w : false; const _u = pass === 0 ? x === w"), ALL, IR(), CANCEL()).ctx;
  check("  mutation: without initial pairing John S. Doe misses",
    !noInit._anyNamesMatch_(noInit._nameVariants_("John S. Doe"), noInit._nameVariants_("John Someone Doe")));
  const anyPair = load(CODE.replace("if (pair(i + 1, same + (pass === 0 ? 1 : 0))) return true;", "if (pair(i + 1, same + 1)) return true;"), ALL, IR(), CANCEL()).ctx;
  check("  mutation: counting initials toward the minimum lets J. Doe catch John Doe",
    anyPair._anyNamesMatch_(anyPair._nameVariants_("J. Doe"), anyPair._nameVariants_("John Doe")));
  const anyChar = load(CODE.replace("return /^[a-z]$/.test(w);", "return w.length === 1;"), ALL, IR(), CANCEL()).ctx;
  check("  mutation: any single character as an initial makes 李 明 华 = 李伟 明 华",
    anyChar._anyNamesMatch_(anyChar._nameVariants_("李 明 华"), anyChar._nameVariants_("李伟 明 华")));

  // End to end, both matchers.
  const ir = IR(); ir[1][5] = "John S. Doe"; ir[2][5] = "Doe, Hanako";
  const central = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610001", "", "ネパール", "DOE, SOMEONE JOHN"]];
  const res = load(CODE, ALL, ir, [CANCEL()[0], ["2026年10月生", "申請キャンセル", "", "HANAKO DOE", "", ""]], { central, today: "2026-09-01" }).ctx.getIncomingStudents();
  check("getIncomingStudents hides John S. Doe, enrolled as DOE, SOMEONE JOHN",
    !res.rows.some(r => r[5] === "John S. Doe") && res.hiddenEnrolled["2026年10月生"] === 1, JSON.stringify(res.hiddenEnrolled));
  const h = res.meta[res.rows.findIndex(r => r[5] === "Doe, Hanako")];
  check("a 募集状況 キャンセル 「HANAKO DOE」 finds 「Doe, Hanako」", h && h.decided === "申請キャンセル", JSON.stringify(h));

  // The 状態 label.
  check("the state reads 書類準備中 in the filter, the badge and the export label; 手続き中 is gone",
    /active: '書類準備中'/.test(HTML) && /u-admin">書類準備中</.test(HTML) && /\|\| '書類準備中'/.test(HTML) && !/手続き中/.test(HTML));
}

console.log("\n13. a country is the same whether written short or official");
{
  const { ctx } = load(CODE, ALL, IR(), CANCEL());
  const C = (a, b) => ctx._countryKey_(a) === ctx._countryKey_(b);
  check("イラン = イラン・イスラム共和国", C("イラン", "イラン・イスラム共和国") && ctx._countryKey_("イラン・イスラム共和国") === "イラン");
  check("ベトナム / ネパール / スリランカ / バングラデシュ / ミャンマー / パキスタン official names",
    C("ベトナム", "ベトナム社会主義共和国") && C("ネパール", "ネパール連邦民主共和国") && C("スリランカ", "スリランカ民主社会主義共和国") &&
    C("バングラデシュ", "バングラデシュ人民共和国") && C("ミャンマー", "ミャンマー連邦共和国") && C("パキスタン", "パキスタン・イスラム共和国"));
  check("モンゴル国 / タイ王国 / アメリカ合衆国 / ウズベキスタン共和国",
    C("モンゴル", "モンゴル国") && C("タイ", "タイ王国") && C("アメリカ", "アメリカ合衆国") && C("ウズベキスタン", "ウズベキスタン共和国"));
  check("aliases: 中華人民共和国 = 中国, 大韓民国 = 韓国", C("中国", "中華人民共和国") && C("韓国", "大韓民国"));
  check("⚠️ 中国 / 韓国 / 英国 keep their 国", ctx._countryKey_("中国") === "中国" && ctx._countryKey_("韓国") === "韓国" && ctx._countryKey_("英国") === "英国");
  check("⚠️ never a prefix rule: インド ≠ インドネシア", !C("インド", "インドネシア") && !C("インド", "インドネシア共和国"));
  check("different countries stay different", !C("イラン", "イラク") && !C("ネパール", "ベトナム"));
  check("half-width ･ and spaces too", C("イラン", "イラン･イスラム 共和国"));
  const noStrip = load(CODE.replace("if (s.length - x.length >= 2 && s.slice(-x.length) === x)", "if (false)"), ALL, IR(), CANCEL()).ctx;
  check("  mutation: without the suffix strip イラン ≠ イラン・イスラム共和国", noStrip._countryKey_("イラン") !== noStrip._countryKey_("イラン・イスラム共和国"));
  const noFloor = load(CODE.replace("if (s.length - x.length >= 2 && s.slice(-x.length) === x)", "if (s.length - x.length >= 1 && s.slice(-x.length) === x)"), ALL, IR(), CANCEL()).ctx;
  check("  mutation: without the 2-character floor 中国 loses its 国 and stops matching 中華人民共和国",
    noFloor._countryKey_("中国") !== noFloor._countryKey_("中華人民共和国"));

  // End to end: 面接結果 says イラン, 学生一覧 says the official name.
  const ir = IR(); ir[1][4] = "イラン"; ir[1][5] = "SAMPLE REZA";
  const central = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610001", "", "イラン・イスラム共和国", "REZA SAMPLE"]];
  const res = load(CODE, ALL, ir, CANCEL(), { central, today: "2026-09-01" }).ctx.getIncomingStudents();
  check("getIncomingStudents hides an イラン applicant enrolled as イラン・イスラム共和国",
    !res.rows.some(r => r[5] === "SAMPLE REZA") && res.hiddenEnrolled["2026年10月生"] === 1, JSON.stringify(res.hiddenEnrolled));
  const past = [["学籍番号", "ニックネーム", "国籍", "名前英語", "始業日"], ["202610101", "", "イラン・イスラム共和国", "REZA SAMPLE", ""]];
  const resP = load(CODE, ALL, ir, CANCEL(), { past, today: "2026-09-01" }).ctx.getIncomingStudents();
  check("...and through Past_DB's 国籍", resP.hiddenPast["2026年10月生"] === 1, JSON.stringify(resP.hiddenPast));
}

console.log("\n14. ビザ変更: a row in 募集状況's 留学ビザ以外, beneath the decisions");
{
  const V = (rows) => [VISA_HEAD.slice()].concat(rows);
  const vrow = (it, no, name) => [it, String(no), "", name, "家族滞在", "留学", "", "", "", ""];
  const at = (res, n) => res.meta[res.rows.findIndex(r => r[5] === n)];
  // Row 2 SAMPLE TARO (2026年10月生).
  const res = load(CODE, ALL, IR(), CANCEL(), { visa: V([vrow("2026年10月生", 1, "taro sample")]) }).ctx.getIncomingStudents();
  check("a 留学ビザ以外 row makes the applicant ビザ変更 (writings, any order)", at(res, "SAMPLE TARO").visa === true && at(res, "SAMPLE TARO").decided === null);
  check("...scoped by 入学期 (2027年4月生's SAMPLE TARO is not)", res.meta[2].visa === false);
  const both = load(CODE, ALL, IR(), CANCEL(), { visa: V([vrow("2026年10月生", 1, "SAMPLE HANAKO")]) }).ctx.getIncomingStudents();
  check("a キャンセル still decides, with the ビザ変更 row kept", at(both, "SAMPLE　HANAKO").decided === "申請取り下げ" && at(both, "SAMPLE　HANAKO").visa === true);
  const two = load(CODE, ALL, IR(), CANCEL(), { visa: V([vrow("2026年10月生", 1, "SAMPLE TARO"), vrow("2026年10月生", 2, "TARO SAMPLE")]) }).ctx.getIncomingStudents();
  check("⚠️ two 留学ビザ以外 rows on one person → 要確認", at(two, "SAMPLE TARO").conflict === true && at(two, "SAMPLE TARO").visa === false);
  const twins = load(CODE, ALL, IR(), CANCEL(), { visa: V([vrow("2027年4月生", 1, "TWIN")]) }).ctx.getIncomingStudents();
  check("⚠️ one row naming two applicants → 要確認", twins.meta[3].conflict === true && twins.meta[4].conflict === true);
  const noAmb = CODE.replace(" ||\n                     vh.length > 1 || vSame > 1;", ";");
  check("  mutation: without the ビザ変更 ambiguity rule, two rows are not 要確認",
    noAmb !== CODE && load(noAmb, ALL, IR(), CANCEL(), { visa: V([vrow("2026年10月生", 1, "SAMPLE TARO"), vrow("2026年10月生", 2, "TARO SAMPLE")]) }).ctx.getIncomingStudents().meta[0].conflict === false);
  const central = [["学籍番号", "ニックネーム", "国名", "名前英語"], ["202610001", "", "ネパール", "TARO SAMPLE"]];
  const enr = load(CODE, ALL, IR(), CANCEL(), { central, visa: V([vrow("2026年10月生", 1, "SAMPLE TARO")]) }).ctx.getIncomingStudents();
  check("an enrolled ビザ変更 student leaves the list (no decision contradicts enrolling)", !enr.rows.some(r => r[5] === "SAMPLE TARO" && r[2] === "2026年10月生"));

  // Transitions, one person (row 2 = SAMPLE TARO, 2026年10月生). Another intake's 番号 9 must not count.
  const t = load(CODE, ALL, IR(), CANCEL(), { visa: V([vrow("2026年10月生", 2, "OTHER PERSON"), vrow("2027年4月生", 9, "SOMEONE ELSE")]) });
  const mine = () => t.visa.filter(r => r[3] === "SAMPLE TARO");
  const stamp = "2026/04/01 10:00";
  let r1 = t.ctx.setIncomingState(2, stamp, "ビザ変更");
  check("ビザ変更 → a 留学ビザ以外 row: 入学期|next 番号 in the intake|国籍|名前|…|課程|担当",
    mine().length === 1 && JSON.stringify(mine()[0]) === JSON.stringify(["2026年10月生", 3, "ネパール", "SAMPLE TARO", "", "", "進学2年", "営業 花子", "", ""]), JSON.stringify(mine()));
  check("...answering { state: '', visa: true }", r1.state === "" && r1.visa === true);
  t.ctx.setIncomingState(2, stamp, "ビザ変更");
  check("setting it again appends nothing", mine().length === 1);
  r1 = t.ctx.setIncomingState(2, stamp, "COE後キャンセル");
  check("a キャンセル over ビザ変更 keeps the 留学ビザ以外 row", mine().length === 1 && r1.state === "COE後キャンセル" && r1.visa === true);
  r1 = t.ctx.setIncomingState(2, stamp, "");
  check("「なし（自動）」 first removes the decision, back to ビザ変更",
    mine().length === 1 && !t.cancel.some(r => r[3] === "SAMPLE TARO") && r1.state === "" && r1.visa === true);
  r1 = t.ctx.setIncomingState(2, stamp, "");
  check("...then the 留学ビザ以外 row, back to automatic", mine().length === 0 && r1.visa === false);
  check("other people's 留学ビザ以外 rows are untouched", t.visa.length === 3);
  t.ctx.setIncomingState(2, stamp, "不交付");
  r1 = t.ctx.setIncomingState(2, stamp, "ビザ変更");
  check("ビザ変更 over 不交付 clears the 不交付 (it replaces the decision)", !t.notissued.some(r => r[2] === "SAMPLE TARO") && mine().length === 1 && r1.state === "");
  const refuse = (fn) => { try { fn(); return false; } catch (e) { return /複数あるため変更できません/.test(e.message); } };
  check("⚠️ a new row that would name two applicants is refused (the TWIN pair)",
    refuse(() => load(CODE, ALL, IR(), CANCEL()).ctx.setIncomingState(7, "2026/04/06 10:00", "ビザ変更")));
  const evil = IR(); evil[1][5] = "=IMPORTXML(\"https://x\",\"//a\")";
  const e = load(CODE, ALL, evil, CANCEL());
  e.ctx.setIncomingState(2, stamp, "ビザ変更");
  check("the 留学ビザ以外 row goes through _cellSafeRow_", String(e.visa[e.visa.length - 1][3]).charAt(0) === "'");

  // The client: one classifier; a decision beats ビザ変更, which beats the automatic states.
  const CLIENT = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || "";
  const fnSrc = (n) => { const f = extract("\n" + CLIENT.replace(/^\s+function /gm, "function "), n); if (!f) throw new Error("missing client " + n); return f; };
  const c = vm.createContext({});
  vm.runInContext("var INC_VISA = 'ビザ変更';\n" + ["incState", "incSelValue", "incStateLabel"].map(fnSrc).join("\n"), c);
  check("incState: visa beats planned/applied, a decision beats visa",
    c.incState({ visa: true, planned: true }) === "visa" && c.incState({ visa: true, decided: "不交付" }) === "notissued" && c.incState({ visa: true, conflict: true }) === "check");
  check("incSelValue / incStateLabel", c.incSelValue({ visa: true }) === "ビザ変更" && c.incSelValue({ visa: true, decided: "申請キャンセル" }) === "申請キャンセル" && c.incStateLabel({ visa: true }) === "ビザ変更");
  check("ビザ変更 is a select option, a filter option and a badge",
    /const INC_STATE_OPTIONS = \[INC_VISA, '不交付'\]/.test(CLIENT) && /visa: 'ビザ変更'/.test(HTML) && /inc-visa">ビザ変更</.test(HTML));
  check("the success handler takes visa from the server", /m\.visa = !!\(res && res\.visa\);/.test(CLIENT));
}

console.log("\n15. the same ENROLMENT: 学籍番号's YYYYMM must equal the application's 入学期");
{
  const { ctx } = load(CODE, ALL, IR(), CANCEL());
  check("学籍番号 → intake key", ctx._intakeKeyFromStudentId_("202610001") === "2026-10" && ctx._intakeKeyFromStudentId_("202704015") === "2027-04");
  check("入学期 → intake key, zero-padded", ctx._intakeKeyFromIntakeName_("2026年10月生") === "2026-10" && ctx._intakeKeyFromIntakeName_("2027年4月生") === "2027-04" && ctx._intakeKeyFromIntakeName_("2027 年 4 月") === "2027-04");
  check("unreadable → \"\" on both sides",
    ["S1", "2026", "202613001", "abc202610", ""].every(v => ctx._intakeKeyFromStudentId_(v) === "") &&
    ["", "未定", "2026年13月生", "10月生"].every(v => ctx._intakeKeyFromIntakeName_(v) === ""));
  const C = (sid) => [["学籍番号", "ニックネーム", "国名", "名前英語"], [sid, "", "ネパール", "TARO SAMPLE"]];
  const hidden = (opts, ir) => { const r = load(CODE, ALL, ir || IR(), CANCEL(), Object.assign({ today: "2026-09-01" }, opts)).ctx.getIncomingStudents();
    return !r.rows.some(x => x[5] === "SAMPLE TARO" && x[2] === "2026年10月生"); };
  check("202610… matches the 2026年10月生 application", hidden({ central: C("202610001") }));
  check("⚠️ 202604… does NOT: same person-looking name, another enrolment", !hidden({ central: C("202604001") }));
  check("2027年4月生 ↔ 202704… (the padded month)", (function () {
    const r = load(CODE, ALL, IR(), CANCEL(), { central: C("202704001"), today: "2026-09-01" }).ctx.getIncomingStudents();
    return !r.rows.some(x => x[5] === "SAMPLE TARO" && x[2] === "2027年4月生") && r.rows.some(x => x[5] === "SAMPLE TARO" && x[2] === "2026年10月生"); })());
  check("⚠️ a malformed 学籍番号 is never a match", ["S1", "2026", "202613001", ""].every(sid => !hidden({ central: C(sid) })));
  const blankIntake = IR(); blankIntake[1][2] = "";
  check("⚠️ an application with no readable 入学期 is never hidden",
    load(CODE, ALL, blankIntake, CANCEL(), { central: C("202610001"), today: "2026-09-01" }).ctx.getIncomingStudents().rows.some(x => x[5] === "SAMPLE TARO" && x[2] === ""));
  check("no 学籍番号 column → nobody matches", !hidden({ central: [["ニックネーム", "国名", "名前英語"], ["", "ネパール", "TARO SAMPLE"]] }));
  const P = (sid) => [["学籍番号", "ニックネーム", "国籍", "名前英語", "始業日"], [sid, "", "ネパール", "TARO SAMPLE", "2020/04/01"]];
  check("Past_DB of this intake → hidden, whatever its 始業日", hidden({ past: P("202610001") }));
  check("Past_DB of an older intake → listed (a re-applicant)", !hidden({ past: P("202304001") }));
  const noCheck = CODE.replace('if (found === "central" || e.intake !== it || ', 'if (found === "central" || ');
  check("  mutation: without the intake equality the 202604 student hides the application",
    noCheck !== CODE && load(noCheck, ALL, IR(), CANCEL(), { central: C("202604001"), today: "2026-09-01" }).ctx.getIncomingStudents()
      .rows.every(x => !(x[5] === "SAMPLE TARO" && x[2] === "2026年10月生")));
  const wildcard = CODE.replace('if (found === "central" || e.intake !== it || ', 'if (found === "central" || (e.intake !== "" && e.intake !== it) || ');
  check("  mutation: an unreadable 学籍番号 as a wildcard hides the application",
    wildcard !== CODE && load(wildcard, ALL, IR(), CANCEL(), { central: C("S1"), today: "2026-09-01" }).ctx.getIncomingStudents()
      .rows.every(x => !(x[5] === "SAMPLE TARO" && x[2] === "2026年10月生")));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
