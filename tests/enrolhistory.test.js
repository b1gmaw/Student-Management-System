// 増減推移: the monthly headcount series and the arithmetic behind 減.
//
// ⚠️ WHY THIS FEATURE NEEDS A SHEET AT ALL. Central_DB is a snapshot of who is
// enrolled right now. A student who leaves is a row that VANISHES — there is no
// departure date anywhere: 卒業予定 is blank on 1381/1400 rows and Past_DB's tabs
// are coarse cohorts (修了2024.4~2025.3), not months. So the decrease half of
// month-on-month change cannot be reconstructed after the fact; it can only be
// measured as it happens. Enrollment_History is that measurement.
//
// 減 is then arithmetic, not an observation:
//     減(M) = 在籍(M-1) + 増(M) − 在籍(M)
// exact given two headcounts and the joins, and needing no departure dates.
// Its blind spot: someone who joins AND leaves inside one month cancels out.

const fs = require('fs');
const path = require('path');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- transcribed from getEnrollmentHistory ---------------------------------
function isPrevMonth(a, b) {
  if (!a || !b) return false;
  const pa = a.split('-'), pb = b.split('-');
  return (parseInt(pb[0],10)*12 + parseInt(pb[1],10)) - (parseInt(pa[0],10)*12 + parseInt(pa[1],10)) === 1;
}
function series(sheetRows) {
  let totals = {}, joins = {}, intakeJoins = {}, entered = {};
  for (let i = 1; i < sheetRows.length; i++) {
    const ym = String(sheetRows[i][0] || '').trim();
    const kind = String(sheetRows[i][1] || '').trim();
    const val = String(sheetRows[i][2] || '').trim();
    const n = parseInt(sheetRows[i][3], 10);
    if (!ym || isNaN(n)) continue;
    // ⚠️ Blank 入力種別 is 自動 — rows written before that column existed were measured.
    const manual = String(sheetRows[i][5] || '').trim() === '手動';
    if (kind === '合計') { totals[ym] = n; if (manual) entered[ym] = true; }
    else if (kind === '入') joins[ym] = n;                       // hand-entered wins
    else if (kind === '入学期' && val === ym) intakeJoins[ym] = n; // measured fallback
  }
  const months = Object.keys(totals).sort();
  let out = [];
  months.forEach(function (m, i) {
    const prev = i > 0 ? totals[months[i - 1]] : null;
    const j = (joins[m] !== undefined) ? joins[m] : (intakeJoins[m] || 0);
    // ⚠️ "Previous" means the previous month IN THE SERIES. Across a gap the
    // difference is not one month's churn, so it is reported as unknown.
    const contiguous = (prev !== null) && isPrevMonth(months[i - 1], m);
    out.push({ month: m, total: totals[m], joined: j,
               left: contiguous ? (prev + j - totals[m]) : null,
               net: contiguous ? (totals[m] - prev) : null,
               entered: !!entered[m] });
  });
  return out;
}
const H = ['年月', '区分', '値', '人数', '記録日時', '入力種別'];

console.log("\n1. 減 is derived correctly across a real-shaped series");
{
  // 2026-05: 100 enrolled.
  // 2026-06: 40 joined, 110 enrolled  -> 100 + 40 - 110 = 30 left.
  // 2026-07: 0 joined, 110 enrolled   -> 110 + 0 - 110  = 0 left.
  // 2026-08: 5 joined, 100 enrolled   -> 110 + 5 - 100  = 15 left.
  const rows = [H,
    ['2026-05', '合計', '', 100, ''], ['2026-05', '性別', '男', 50, ''],
    ['2026-06', '合計', '', 110, ''], ['2026-06', '入学期', '2026-06', 40, ''], ['2026-06', '性別', '男', 55, ''],
    ['2026-07', '合計', '', 110, ''], ['2026-07', '性別', '男', 55, ''],
    ['2026-08', '合計', '', 100, ''], ['2026-08', '入学期', '2026-08', 5, ''], ['2026-08', '性別', '男', 50, '']
  ];
  const s = series(rows);
  const by = {}; s.forEach(function (r) { by[r.month] = r; });

  check("months come back oldest first", s[0].month === '2026-05', s[0].month);
  check("a month with joins and departures", by['2026-06'].left === 30 && by['2026-06'].net === 10,
    JSON.stringify(by['2026-06']));
  check("a flat month reports zero departures", by['2026-07'].left === 0 && by['2026-07'].net === 0,
    JSON.stringify(by['2026-07']));
  check("a shrinking month", by['2026-08'].left === 15 && by['2026-08'].net === -10,
    JSON.stringify(by['2026-08']));

  // ⚠️ The first recorded month has no predecessor, so 減 is UNKNOWN. Reporting 0
  // would assert that nobody left — a claim the data cannot support.
  check("the first month's 減 is null, not 0", by['2026-05'].left === null,
    "got " + by['2026-05'].left);
  check("the first month's 純増減 is null too", by['2026-05'].net === null, "");
  check("the first month still reports its headcount", by['2026-05'].total === 100, "");
}

console.log("\n2. joins come only from the 入学期 bucket matching the month");
{
  // The 入学期 breakdown lists every cohort still enrolled; only the row whose
  // value IS the month counts as that month's intake.
  const rows = [H,
    ['2026-06', '合計', '', 110, ''],
    ['2026-06', '入学期', '2026-04', 60, ''],   // older cohort, still enrolled
    ['2026-06', '入学期', '2026-06', 40, ''],   // this month's intake
    ['2026-06', '入学期', '(不明)', 10, '']
  ];
  const s = series(rows);
  check("only the matching 入学期 row is counted as joins", s[0].joined === 40, "got " + s[0].joined);
}

console.log("\n3. hand-entered months are distinguishable from measured ones");
{
  const rows = [H,
    ['2023-04', '合計', '', 502, '', '手動'], ['2023-04', '入', '', 90, '', '手動'],
    ['2026-08', '合計', '', 110, '', '自動'], ['2026-08', '入学期', '2026-08', 40, '', '自動'],
    ['2026-09', '合計', '', 115, '', '']       // written before the column existed
  ];
  const s2 = series(rows);
  const by = {}; s2.forEach(function (r) { by[r.month] = r; });
  check("a 手動 month is flagged entered", by['2023-04'].entered === true, "");
  check("an 自動 month is not", by['2026-08'].entered === false, "");
  // ⚠️ The compatibility rule: blank means measured, not hand-entered.
  check("a blank 入力種別 reads as 自動", by['2026-09'].entered === false,
    "calling old rows 手動 would freeze them against the nightly refresh");
  check("a hand-entered 入 beats the measured 入学期 fallback",
    by['2023-04'].joined === 90, "got " + by['2023-04'].joined);
  check("without a 入 row the 入学期 value is used",
    by['2026-08'].joined === 40, "got " + by['2026-08'].joined);
}

console.log("\n4. malformed rows never corrupt the series");
{
  const rows = [H,
    ['2026-06', '合計', '', 110, ''],
    ['', '合計', '', 999, ''],              // no month
    ['2026-07', '合計', '', 'abc', ''],      // non-numeric
    ['2026-07', '合計', '', 105, '']
  ];
  const s = series(rows);
  check("a row with no month is skipped", s.filter(function (r) { return r.month === ''; }).length === 0, "");
  check("a non-numeric count does not become NaN",
    s.every(function (r) { return !isNaN(r.total); }), JSON.stringify(s));
  check("the valid 2026-07 row still lands",
    s.filter(function (r) { return r.month === '2026-07'; })[0].total === 105, "");
}

console.log("\n5. the snapshot writes safely");
{
  const at = CODE.indexOf('function _recordEnrollmentSnapshot_');
  const body = CODE.slice(at, CODE.indexOf('\n}', CODE.indexOf('return { recorded: false, error', at)));
  check("_recordEnrollmentSnapshot_'s body was located", at !== -1 && body.length > 300,
    "the anchor moved — the assertions below are vacuous until this passes");

  // The daily-refresh behaviour and the 手動 protection are asserted in section 9;
  // this section covers batching and error containment only.

  // ⚠️ 60-80 rows at one Sheets call each, on an unattended path — the same shape
  // of mistake that made the session prune a potential failed login.
  //
  // Comments are stripped first: the code carries a comment saying "never
  // appendRow in a loop", which the naive check matched as if it were a call.
  const codeOnly = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check("the month is written in ONE setValues, not appendRow in a loop",
    /\.setValues\(rows\.map\(_cellSafeRow_\)\)/.test(codeOnly) && codeOnly.indexOf('appendRow') === -1,
    "one Sheets call per row on a background path");
  check("the rows go through the formula guard",
    /_cellSafeRow_/.test(body),
    "国籍 and コース come from the sheet and land back in one");
  check("it swallows its own errors",
    /catch \(e\) \{[\s\S]{0,220}?Enrollment snapshot failed/.test(body),
    "housekeeping must not break the student sync it rides on");

  const tAt = CODE.indexOf('function triggerAutoSyncStudents');
  const trig = CODE.slice(tAt, CODE.indexOf('\n}', CODE.indexOf('_authUser = was;', tAt)));
  check("triggerAutoSyncStudents' body was located", tAt !== -1 && trig.length > 400,
    "the two assertions below are vacuous until this passes");
  check("the daily trigger calls it", /_recordEnrollmentSnapshot_\(\);/.test(trig),
    "no trigger hook means the history is never written");
  check("it runs after the sync, not before",
    trig.indexOf('fetchAndMergeStudentData') < trig.indexOf('_recordEnrollmentSnapshot_'),
    "recording before the sync would snapshot yesterday's roster");
}

console.log("\n6. the one-off backfill is retired (2026-09-21)");
{
  // backfillEnrollmentHistory reconstructed the pre-recording months once, in staging and production.
  // Its rows stay in the sheet marked ENROL_AUTO, and section 3 keeps them distinguishable from a
  // measured month. ⚠️ If a backfill is ever needed again, restore it from git history TOGETHER with
  // this section's old checks: it wrote 合計 and 入学期 only, never overwrote an existing month, batched
  // its write through _cellSafeRow_, and said its numbers were joins-only.
  check("the one-off backfill is gone from the source",
    CODE.indexOf('function backfillEnrollmentHistory') === -1, "");
}

console.log("\n7. 年度 runs April to March");
{
  // The sync source's own tabs already use this boundary (修了2025.4~2026.3), and
  // the whole report is grouped by it.
  function fy(ym) {
    const y = parseInt(ym.split('-')[0], 10), m = parseInt(ym.split('-')[1], 10);
    return (m >= 4) ? y : y - 1;
  }
  function ymOf(f, month) {
    const y = (month >= 4) ? f : f + 1;
    return y + '-' + (month < 10 ? '0' + month : month);
  }
  check("2026-04 is 2026年度", fy('2026-04') === 2026, "got " + fy('2026-04'));
  // ⚠️ The off-by-one that would silently shift a whole column.
  check("2026-03 is 2025年度, not 2026", fy('2026-03') === 2025, "got " + fy('2026-03'));
  check("2026-12 is 2026年度", fy('2026-12') === 2026, "");
  check("2027-01 is still 2026年度", fy('2027-01') === 2026, "");
  check("a year's first row is 4月 of that year", ymOf(2026, 4) === '2026-04', ymOf(2026, 4));
  check("a year's last row is 3月 of the NEXT year", ymOf(2026, 3) === '2027-03', ymOf(2026, 3));
  check("the months run 4..12 then 1..3",
    [4,5,6,7,8,9,10,11,12,1,2,3].map(function (m) { return fy(ymOf(2026, m)); })
      .every(function (x) { return x === 2026; }), "every month must land in its own year");
}

console.log("\n8. the reference arithmetic reproduces exactly");
{
  // From 月間在籍者数20260810.pdf, 2026年度:
  //   3月(2025年度) 647 → 4月 531, 出 289, 入 173, 前月差 -116
  //   5月 532 (前月差 1, 出 4, 入 5) / 6月 503 (-29, 29, 0) / 7月 606 (103, 11, 114)
  const total = { '2026-03': 647, '2026-04': 531, '2026-05': 532, '2026-06': 503, '2026-07': 606 };
  const join  = { '2026-04': 173, '2026-05': 5, '2026-06': 0, '2026-07': 114 };
  const prevYm = function (ym) {
    let y = parseInt(ym.split('-')[0], 10), m = parseInt(ym.split('-')[1], 10);
    m--; if (m === 0) { m = 12; y--; }
    return y + '-' + (m < 10 ? '0' + m : m);
  };
  const out = function (ym) {
    const cur = total[ym], pv = total[prevYm(ym)], jn = join[ym];
    if (cur === undefined || pv === undefined || jn === undefined) return null;
    return pv + jn - cur;
  };
  const net = function (ym) {
    const cur = total[ym], pv = total[prevYm(ym)];
    return (cur === undefined || pv === undefined) ? null : cur - pv;
  };
  // ⚠️ 4月 reaches across the 年度 boundary to the previous year's 3月. The blocks
  // are presentation; the series is continuous by month.
  check("4月 出 is 289", out('2026-04') === 289, "got " + out('2026-04'));
  check("4月 前月差 is -116", net('2026-04') === -116, "got " + net('2026-04'));
  check("5月 出 is 4", out('2026-05') === 4, "got " + out('2026-05'));
  check("6月 出 is 29 with zero intake", out('2026-06') === 29, "got " + out('2026-06'));
  check("7月 前月差 is 103", net('2026-07') === 103, "got " + net('2026-07'));

  // 月平均 averages the months that HAVE a figure — 4 filled months here.
  const filled = ['2026-04','2026-05','2026-06','2026-07'];
  const avg = filled.reduce(function (s, m) { return s + total[m]; }, 0) / filled.length;
  check("月平均 of the filled months is 543", avg === 543, "got " + avg);
  check("dividing by 12 instead would misreport the year",
    Math.round((2172 / 12)) !== 543, "a part-finished year must not read as a collapse");

  // ⚠️ A month with no predecessor in the series has UNKNOWN 出, not 0.
  check("the first month ever recorded has no 出", out('2026-03') === null, "");
}

console.log("\n9. hand-entered months are protected and distinguishable");
{
  // ⚠️ THE regression that would silently eat typed history: the snapshot now runs
  // EVERY day and rewrites the current month, so it has to refuse a 手動 month.
  const at = CODE.indexOf('function _recordEnrollmentSnapshot_');
  const body = CODE.slice(at, CODE.indexOf('\n}', CODE.indexOf('return { recorded: false, error', at)));
  check("_recordEnrollmentSnapshot_'s body was located", at !== -1 && body.length > 300, "");
  check("it refuses to touch a month containing a 手動 row",
    /ENROL_MANUAL/.test(body) && /if \(manual\) return/.test(body),
    "a nightly job that overwrote typed figures would destroy the history this exists to hold");
  check("it replaces the current month rather than appending",
    /deleteRow\(mine\[k\]\)/.test(body),
    "appending would stack a new block for the same month every single day");
  check("the delete walks bottom-up",
    /for \(let k = mine\.length - 1; k >= 0; k--\)/.test(body),
    "deleteRow shifts later rows up (§8.3)");
  check("it still writes in ONE setValues",
    /\.setValues\(rows\.map\(_cellSafeRow_\)\)/.test(body) &&
    body.replace(/\/\/[^\n]*/g, '').indexOf('appendRow') === -1, "");
  check("it no longer stops after the first run of a month",
    body.indexOf('already recorded') === -1,
    "that produced a START-of-month figure while the report is 月末締");

  // ⚠️ Blank 入力種別 must read as 自動 — every row written before that column
  // existed was measured, and calling them 手動 would freeze them against refresh.
  check("blank 入力種別 is treated as 自動",
    /String\(data\[i\]\[5\] \|\| ""\)\.trim\(\) === ENROL_MANUAL/.test(CODE),
    "the test is for MANUAL; anything else, including blank, is automatic");
  check("the column was added by widening, not by rebuilding the sheet",
    /function _ensureEnrolHistoryColumns_/.test(CODE) &&
    /const ENROL_HISTORY_HEADERS = \["年月", "区分", "値", "人数", "記録日時", "入力種別"\]/.test(CODE), "");
}

console.log("\n10. saving is admin-level and validated");
{
  const at = CODE.indexOf('function saveEnrollmentMonths');
  const body = CODE.slice(at, CODE.indexOf('\n}', CODE.indexOf('return { saved:', at)));
  check("saveEnrollmentMonths' body was located", at !== -1 && body.length > 400, "");
  // ⚠️ A PERMISSION, not admin level. It began as _isAdminLevel_ — rewriting a
  // reported figure is an admin operation — but that made it ungrantable, and the
  // master needed to delegate it. _hasPerm_ short-circuits true for master, so the
  // master never needs the tick.
  check("it is guarded by the edit_enrollment permission",
    /if \(!_hasPerm_\(role, perms, "edit_enrollment"\)\) throw new Error\("権限がありません"\)/.test(body),
    "moving it off admin level is what makes it tickable per user");
  check("it no longer uses _isAdminLevel_", body.indexOf('_isAdminLevel_') === -1,
    "two predicates for one action is how the UI and the server come to disagree");
  check("it is registered in the API allow-list",
    /saveEnrollmentMonths: saveEnrollmentMonths,/.test(CODE),
    "unregistered, apiRun fails with 不正な呼び出しです");
  check("it snapshots before writing", /_snapshotSheet_\(SHEET_ENROL_HISTORY\)/.test(body), "");
  check("it validates the 年月 format before touching the sheet",
    /\^\\d\{4\}-\\d\{2\}\$/.test(body) && body.indexOf('年月の形式が不正です') !== -1,
    "a bad key would create a second series for the same month");
  check("it validates the numbers", /在籍者数が不正です/.test(body) && /入学者数が不正です/.test(body), "");
  // ⚠️ Validation happens before any delete, so a bad payload cannot half-apply.
  check("validation runs before the delete",
    body.indexOf('年月の形式が不正です') < body.indexOf('deleteRow'),
    "throwing midway would leave the months it already removed with no figure");
  check("it marks what it writes as 手動",
    /ENROL_MANUAL\]/.test(body), "unmarked, the nightly snapshot would overwrite it");
  check("a cleared cell removes the figure rather than storing 0",
    /if \(w\.total !== null\)/.test(body),
    "0 would be a claim that the school had no students that month");
  check("it logs who changed a reported number", /_logActivity_/.test(body), "");
}

console.log("\n11. the client presents unknowns as unknown");
{
  check("the modal exists", /id="stuTrendModal"/.test(HTML), "");
  check("it is titled 年度別月間在籍者数", /年度別月間在籍者数/.test(HTML), "");
  check("getEnrollmentHistory is registered in the API allow-list",
    /getEnrollmentHistory: getEnrollmentHistory,/.test(CODE), "");
  check("reading is permission-guarded",
    /function getEnrollmentHistory\(role, perms\) \{\s*\n\s*if \(!_permOrLegacyRole_\(role, perms, "view_students"/.test(CODE), "");

  const at = HTML.indexOf('function stuRenderTrend');
  const body = HTML.slice(at, HTML.indexOf('\n      function _ymToday', at));
  check("stuRenderTrend's body was located", at !== -1 && body.length > 800, "");

  // ⚠️ Section 7 exercises a LOCAL copy of the 年度 rule, so it stays green even if
  // the real _stuFiscalYear stops subtracting for Jan-Mar — caught by mutation.
  // Third time this pattern has bitten; the source read is the actual guard.
  const fyAt = HTML.indexOf('function _stuFiscalYear');
  const fyBody = HTML.slice(fyAt, HTML.indexOf('\n      }', fyAt));
  check("_stuFiscalYear's body was located", fyAt !== -1 && fyBody.length > 60, "");
  check("the real _stuFiscalYear puts Jan-Mar in the PREVIOUS 年度",
    /\(m >= 4\) \? y : y - 1/.test(fyBody),
    "without the -1, 2026-03 lands in 2026年度 and a whole column shifts by a year");
  const ymAt = HTML.indexOf('function _stuYm');
  const ymBody = HTML.slice(ymAt, HTML.indexOf('\n      }', ymAt));
  check("_stuYm inverts it — 3月 of 2026年度 is 2027-03",
    /\(month >= 4\) \? fy : fy \+ 1/.test(ymBody),
    "the row-to-month mapping must be the exact inverse or the blocks read the wrong cells");
  check("the months run 4..12 then 1..3 in the source",
    /STU_FY_MONTHS = \[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3\]/.test(HTML), "");
  // ⚠️ null means UNKNOWN. Rendering 0 would assert that nobody moved in a month
  // where nothing was counted.
  check("an uncomputable 前月差 renders as a dash, not 0",
    /net === null \? dash/.test(body), "");
  check("an uncomputable 出 renders as a dash, not 0",
    /out === null \? dash : out/.test(body), "");
  // Since 2026-10-06 出 is decided in ONE helper (_stuTrendOut), shared with both exports.
  const outSrc = (function () { const i = HTML.indexOf('      function _stuTrendOut('); return i < 0 ? '' : HTML.slice(i, HTML.indexOf('\n      }\n', i) + 8); })();
  // 出 is counted from 卒業年月日 since 2026-10-06 (§24); 前月差 is what still needs the previous
  // month, across the 年度 boundary.
  check("前月差 uses the previous month, crossing the 年度 boundary; 出 comes from the one helper",
    /pv = _stuTrendNum\(by, _stuPrevYm\(ym\), 'total'\)/.test(body) && /const net = \(cur === null \|\| pv === null\) \? null : \(cur - pv\);/.test(body) &&
    /const out = _stuTrendOut\(by, ym\);/.test(body) && outSrc !== "", "");
  // The helper is module-level since C7 (2026-09-28), shared with the export's _stuTrendGrid —
  // so run the REAL one rather than trusting its name appears.
  const pySrc = (function () { const i = HTML.indexOf('      function _stuPrevYm('); return i < 0 ? '' : HTML.slice(i, HTML.indexOf('\n      }\n', i) + 8); })();
  const realPrev = pySrc ? new Function(pySrc + '; return _stuPrevYm;')() : function () { return null; };
  check("_stuPrevYm: 2026-04 → 2026-03, and 2026-01 → 2025-12 across the calendar year",
    realPrev('2026-04') === '2026-03' && realPrev('2026-01') === '2025-12' && realPrev('2026-11') === '2026-10',
    [realPrev('2026-04'), realPrev('2026-01'), realPrev('2026-11')].join(' '));
  const numSrc = (function () { const i = HTML.indexOf('      function _stuTrendNum('); return i < 0 ? '' : HTML.slice(i, HTML.indexOf('\n      }\n', i) + 8); })();
  const realNum = numSrc ? new Function(numSrc + '; return _stuTrendNum;')() : function () { return 'missing'; };
  const BY = { a: { total: '12', joined: '' }, b: { total: 'x' }, c: { total: 0, joined: '3' } };
  check("_stuTrendNum: a figure, and null (never 0) for blank, unparseable or missing",
    realNum(BY, 'a', 'total') === 12 && realNum(BY, 'a', 'joined') === null && realNum(BY, 'b', 'total') === null &&
    realNum(BY, 'zz', 'total') === null && realNum(BY, 'c', 'total') === 0 && realNum(BY, 'c', 'joined') === 3, "");
  {
    const mut = pySrc.replace("m--; if (m === 0) { m = 12; y--; }", "m--;");
    const mp = new Function(mut + '; return _stuPrevYm;')();
    check("  mutation: without the year roll 2026-01 is not 2025-12 — caught", mut !== pySrc && mp('2026-01') !== '2025-12', mp('2026-01'));
    const mutN = numSrc.replace("return isNaN(n) ? null : n;", "return isNaN(n) ? 0 : n;");
    const mn = new Function(mutN + '; return _stuTrendNum;')();
    check("  mutation: an unparseable month read as 0 — caught", mutN !== numSrc && mn(BY, 'b', 'total') === 0, String(mn(BY, 'b', 'total')));
  }
  check("月平均 divides by the FILLED months",
    /filled \? \(Math\.round\(\(sum \/ filled\)/.test(body),
    "dividing by 12 would report a part-finished year as a collapse");
  // Since 2026-10-06 出 is counted from 卒業年月日, so the caveat is the missing date, not the
  // arithmetic's same-month blind spot.
  // Since the rebuild (2026-10-06, §24) every figure comes from 始業日 / 卒業年月日, and the caveat
  // is how many students were estimated or left out.
  check("how the figures are built is stated to the user, with the estimated / excluded counts",
    /入は始業日の月（年は学籍番号の入学期から。始業日が空欄なら入学期）、出は卒業年月日から集計しています（月末時点）/.test(HTML) && /名は修了期の終わりで計上/.test(HTML) && /名は集計外/.test(HTML),
    "an unstated caveat on a table of numbers is worse than an admitted one");
  check("月末締 is stated", /毎月月末締/.test(HTML), "");
  check("hand-entered months are visually marked",
    /fy-manual/.test(HTML) && /手動入力/.test(HTML),
    "a reconstruction must not read as a measurement");
  check("the save button is hidden unless the server said canEdit",
    /canEdit \? 'inline-block' : 'none'/.test(body),
    "the UI must not offer an action the server will refuse");

  // ⚠️ Anchor on the parens. 'function stuTrendExport' now also prefix-matches
  // stuTrendExportXlsx and stuTrendExportPdf, which are defined above it — the
  // slice would cover the wrong function and the assertions would go vacuous.
  const exAt = HTML.indexOf('function stuTrendExport()');
  const ex = HTML.slice(exAt, exAt + 1600);
  check("the CSV export's body was located", exAt !== -1 && /_expCsv/.test(ex),
    "the anchor matched a different export");
  check("the export writes blank for unknown, not 0 (前月差 with no previous month, 出 of a blank month)",
    /pv === null \? '' : \(cur - pv\)/.test(ex) && /const o = _stuTrendOut\(by, ym\); return o === null \? '' : o;/.test(ex),
    "a 0 in a spreadsheet is a fact; a blank is an absence");
  check("the export marks hand-entered rows", /手動入力' : '自動記録/.test(ex), "");
  check("the export carries the 年度", /年度'/.test(ex), "");
}

console.log("\n12. the report is reachable before any history exists");
{
  // ⚠️ THE regression this section exists for. canEdit described the CALLER but was
  // hardcoded false on the missing-sheet path — and Enrollment_History is created
  // by the first write. So on a project where the trigger had never run there was
  // no history because there was nowhere to type it, and nowhere to type it
  // because there was no history. The suite passed throughout: it never asked what
  // happens when the sheet is absent.
  const at = CODE.indexOf('function getEnrollmentHistory');
  const body = CODE.slice(at, CODE.indexOf('\n}', CODE.indexOf('return { rows: out', at)));
  check("getEnrollmentHistory's body was located", at !== -1 && body.length > 400, "");

  check("no canEdit:false literal survives anywhere in it",
    body.indexOf('canEdit: false') === -1,
    "the missing-sheet path returned a hardcoded false, disabling editing for everyone");
  check("canEdit is computed once from the caller",
    /const canEdit = _hasPerm_\(role, perms, "edit_enrollment"\);/.test(body),
    "it describes who is asking, not whether the sheet happens to exist");
  // ⚠️ The read and the write must decide with the SAME expression. A UI stricter
  // than the server hides a legal action; a UI looser offers one it will refuse.
  check("the read and the write use the same predicate",
    (body.match(/_hasPerm_\(role, perms, "edit_enrollment"\)/g) || []).length >= 1 &&
    /_hasPerm_\(role, perms, "edit_enrollment"\)/.test(
      CODE.slice(CODE.indexOf('function saveEnrollmentMonths'),
                 CODE.indexOf('function saveEnrollmentMonths') + 400)),
    "the two decide whether the button appears and whether pressing it works");
  const returns = body.match(/return \{ rows:[^;]*;/g) || [];
  check("both return paths were found", returns.length === 2,
    "found " + returns.length + " — the early return or the normal one moved");
  check("every return carries the same computed canEdit",
    returns.every(function (r) { return /canEdit: canEdit/.test(r); }),
    returns.join(" || "));
  // ⚠️ The client was reading _stuTrend.today, which the server never sent, and
  // silently fell back to the browser's clock.
  check("every return carries today",
    returns.every(function (r) { return /today: today/.test(r); }), returns.join(" || "));
  check("today comes from _ymKey_, so it is Asia/Tokyo",
    /const today = _ymKey_\(new Date\(\)\);/.test(body),
    "which 年度 is current must be the school's clock, not the viewer's");

  // Saving is what creates the sheet, so the deadlock only breaks if the write
  // path does not also require it to pre-exist.
  const sAt = CODE.indexOf('function saveEnrollmentMonths');
  const sBody = CODE.slice(sAt, CODE.indexOf('\n}', CODE.indexOf('return { saved:', sAt)));
  check("saving creates the sheet if it is missing",
    /_getEnrolHistorySheet_\(\)/.test(sBody),
    "the first save has to be able to bring the sheet into existence");
}

console.log("\n13. there is always somewhere to type");
{
  // ⚠️ The other half of "no option to add": blocks were built only for years that
  // HAD data, plus the current one. A year with no figures got no grid, so past
  // years — the entire reason the feature is editable — were unreachable.
  const at = HTML.indexOf('function stuRenderTrend');
  const body = HTML.slice(at, HTML.indexOf('\n      function _ymToday', at));
  check("stuRenderTrend's body was located", at !== -1 && body.length > 800, "");

  check("the default window is the current 年度 plus three",
    /for \(let b = 0; b <= 3 \+ _stuTrendExtraYears; b\+\+\) years\[nowFy - b\] = true;/.test(body),
    "four blocks, as the reference report has, and somewhere to type on first open");
  check("years carrying data are still unioned in",
    /known\.forEach\(function \(m\) \{ years\[_stuFiscalYear\(m\)\] = true; \}\);/.test(body),
    "a year older than the window must not vanish once it has figures");
  check("the current 年度 comes from the server's date",
    /_stuTrend && _stuTrend\.today/.test(body), "");

  // Transcribed: the window must be contiguous, or a year silently has no grid.
  const windowFor = function (nowFy, extra, dataYears) {
    let years = {};
    (dataYears || []).forEach(function (y) { years[y] = true; });
    for (let b = 0; b <= 3 + extra; b++) years[nowFy - b] = true;
    return Object.keys(years).map(Number).sort(function (a, b) { return a - b; });
  };
  const w = windowFor(2026, 0, []);
  check("four years by default", w.length === 4, w.join(","));
  check("they are the current year and the three before",
    w.join(",") === "2023,2024,2025,2026", w.join(","));
  check("＋前年度 extends by exactly one",
    windowFor(2026, 1, []).join(",") === "2022,2023,2024,2025,2026",
    windowFor(2026, 1, []).join(","));
  check("the window never skips a year",
    windowFor(2026, 2, []).every(function (y, i, a) { return i === 0 || y === a[i - 1] + 1; }),
    windowFor(2026, 2, []).join(","));
  check("a data year older than the window is included",
    windowFor(2026, 0, [2019]).indexOf(2019) === 0,
    windowFor(2026, 0, []).join(","));

  check("the ＋前年度 button exists and is admin-gated",
    /onclick="stuTrendAddYear\(1\)"/.test(HTML) && /if \(canEdit\) \{\s*\n\s*html = /.test(body), "");
  check("the extra-year counter resets on reload",
    /_stuTrendExtraYears = 0;/.test(HTML),
    "otherwise a reopened modal keeps growing");
  // ⚠️ An empty history for an admin must be a blank FORM, not a dead end.
  check("the empty-history early return only applies when editing is off",
    /if \(!known\.length && !canEdit\)/.test(body), "");
  check("read-only says why, naming the permission",
    /編集には「在籍者数 編集」権限が必要です/.test(HTML),
    "silent read-only is what made this look broken; naming admin level would now " +
    "point at the wrong thing to change");
  check("the permission is declared exactly once",
    (HTML.match(/value="edit_enrollment"/g) || []).length === 1,
    "buildRolePermList CLONES the user modal's list into the role modal — a second " +
    "declaration would put two checkboxes in front of the master");
  // ⚠️ The inputs were transparent-until-hover, which on a grid of numbers is
  // indistinguishable from printed text — the report read as uneditable.
  check("the editable cells look editable",
    /\.fy-block input \{[^}]*border: 1px solid var\(--input-border\)/.test(HTML) &&
    /\.fy-block input \{[^}]*background: var\(--input-bg\)/.test(HTML),
    "a transparent border and background make a field look like a label");
}

console.log("\n14. the grid is typeable with the keyboard");
{
  const at = HTML.indexOf('function stuTrendKey');
  const body = HTML.slice(at, HTML.indexOf('\n      function stuTrendEdit', at));
  check("stuTrendKey's body was located", at !== -1 && body.length > 300, "");

  // ⚠️ THE markup constraint. type="number" looks like the obvious choice and
  // breaks this feature two ways: ↑/↓ natively STEP the value, and selectionStart
  // throws InvalidStateError on a number input in Chrome, so the caret test that
  // lets ←/→ coexist with ordinary editing cannot be done at all.
  const cellAt = HTML.indexOf('function _stuTrendCell');
  const cell = HTML.slice(cellAt, HTML.indexOf('\n      }', cellAt));
  check("_stuTrendCell's body was located", cellAt !== -1 && cell.length > 200, "");
  check("the inputs are type=text with inputmode=numeric",
    /type="text" inputmode="numeric"/.test(cell),
    "type=number steps the value on ↑/↓ and makes selectionStart throw");
  check("no type=number input is left in the trend grid",
    cell.indexOf('type="number"') === -1, "");
  check("each cell carries its grid position",
    /data-r="' \+ r \+ '"/.test(cell) && /data-c="' \+ c \+ '"/.test(cell),
    "arrow navigation moves by row/column, so both have to be on the element");

  check("↑ moves up a month and swallows the key",
    /k === 'ArrowUp'[\s\S]{0,90}_stuTrendMove\(r - 1, c\)[\s\S]{0,40}preventDefault/.test(body),
    "without preventDefault the page scrolls under you");
  check("↓ and Enter both move down",
    /k === 'ArrowDown' \|\| k === 'Enter'[\s\S]{0,90}_stuTrendMove\(r \+ 1, c\)/.test(body), "");
  // ⚠️ ←/→ are SHARED with caret movement — they must only leave the cell from its
  // edge, or editing a value in the middle becomes impossible.
  check("← only leaves the cell from the start of the value",
    /k === 'ArrowLeft' && caret === 0/.test(body), "");
  check("→ only leaves the cell from the end of the value",
    /k === 'ArrowRight' && caret === el\.value\.length/.test(body), "");
  check("reading the caret is guarded",
    /try \{ caret = el\.selectionStart; \} catch/.test(body),
    "selectionStart throws on some input types; a throw here kills the keypress");
  check("Tab is left to the browser",
    body.indexOf("'Tab'") === -1,
    "DOM order already reads correctly; intercepting Tab only breaks it");

  // ⚠️ Moving focus blurs the current cell, which fires change, which re-renders
  // and replaces every input — including the one just focused.
  const rAt = HTML.indexOf('function stuRenderTrend');
  const rBody = HTML.slice(rAt, HTML.indexOf('\n      function _ymToday', rAt));
  check("focus is restored after the rebuild",
    /if \(_stuTrendFocus\)[\s\S]{0,200}?back\.focus\(\)/.test(rBody),
    "otherwise arrow navigation works only while not editing, which is no use");
  check("it restores only when the element still exists",
    /const back = _stuTrendInput\([\s\S]{0,60}?if \(back\)/.test(rBody),
    "after − 前年度 the remembered cell may be gone; .focus() on null throws inside " +
    "the render path and takes the modal down (rule 2)");
  check("the key handler records where it is going",
    /_stuTrendFocus = \{ ym: el\.dataset\.ym, f: el\.dataset\.f \};/.test(HTML), "");
}

console.log("\n15. ＋/− 前年度");
{
  const rAt = HTML.indexOf('function stuRenderTrend');
  const rBody = HTML.slice(rAt, HTML.indexOf('\n      function _ymToday', rAt));
  check("＋ adds a year", /onclick="stuTrendAddYear\(1\)"/.test(HTML), "");
  check("− removes one", /onclick="stuTrendAddYear\(-1\)"/.test(HTML), "");
  // ⚠️ A control that cannot do anything should not be offered.
  check("− is hidden at the default window",
    /_stuTrendExtraYears > 0[\s\S]*?− 前年度[\s\S]*?:\s*''/.test(rBody),
    "a control that cannot do anything should not be offered");
  check("the counter floors at 0",
    /_stuTrendExtraYears = Math\.max\(0, _stuTrendExtraYears \+ delta\);/.test(HTML),
    "− must never shrink below the four blocks the reference report has");

  // Transcribed counter maths.
  const step = function (n, d) { return Math.max(0, n + d); };
  check("＋ then − returns to the default", step(step(0, 1), -1) === 0, "");
  check("− alone stays at the default", step(0, -1) === 0, "");
  check("＋ twice then − once leaves one extra", step(step(step(0, 1), 1), -1) === 1, "");

  // ⚠️ A year with data is unioned in separately — − narrows the empty runway and
  // must never hide a figure somebody typed.
  const windowFor = function (nowFy, extra, dataYears) {
    let years = {};
    (dataYears || []).forEach(function (y) { years[y] = true; });
    for (let b = 0; b <= 3 + extra; b++) years[nowFy - b] = true;
    return Object.keys(years).map(Number).sort(function (a, b) { return a - b; });
  };
  check("a year with data survives −",
    windowFor(2026, 0, [2019]).indexOf(2019) !== -1,
    "− narrows the runway; it must not hide entered figures");
}

console.log("\n16. what a Japanese keyboard actually produces");
{
  // ⚠️ NOT an edge case: with an IME on, typing 531 very often yields ５３１, which
  // parseInt reads as NaN. That reached the server and came back as
  // 「在籍者数が不正です」, which looks like a bug rather than an input mode.
  const norm = function (v) {
    const raw = String(v)
      .replace(/[０-９]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 0xFEE0); })
      .replace(/[^\d]/g, '');
    return (raw === '') ? null : parseInt(raw, 10);
  };
  check("full-width digits parse", norm('５３１') === 531, "got " + norm('５３１'));
  check("half-width still parse", norm('531') === 531, "");
  check("a mixed string keeps its digits", norm('12abc') === 12, "got " + norm('12abc'));
  check("letters alone clear the cell", norm('abc') === null, "got " + norm('abc'));
  // ⚠️ Empty is null, NOT 0 — the server reads null as "remove this figure", and 0
  // would be a claim that the school had no students that month.
  check("empty clears rather than zeroing", norm('') === null, "got " + norm(''));
  check("zero is still a real zero", norm('0') === 0, "got " + norm('0'));

  const eAt = HTML.indexOf('function stuTrendEdit');
  const eBody = HTML.slice(eAt, HTML.indexOf('\n      function stuTrendSave', eAt));
  check("the real stuTrendEdit normalises full-width digits",
    /\[０-９\]/.test(eBody) && /0xFEE0/.test(eBody), "");
  check("it strips anything that is not a digit", /\[\^\\d\]/.test(eBody), "");
  check("it shows back what it understood", /el\.value = raw;/.test(eBody),
    "silently keeping a value the app rejected is how a save fails for no visible reason");
}

console.log("\n17. the 帳票 exports keep the block layout");
{
  // Transcribed geometry: [block][gap][block][gap]… EVERY block 5 wide (月, 在籍者数, 前月差,
  // 出, 入) since 2026-10-07 — it was 5 for the newest only and 2 for the rest, hiding past
  // years' churn.
  const layout = function (fys, w) {
    let starts = {}, width = 0;
    fys.forEach(function (fy, i) {
      if (i > 0) width += 1;
      starts[fy] = width;
      width += w(fy);
    });
    return { starts: starts, width: width };
  };
  const FIVE = function () { return 5; };
  const L = layout([2023, 2024, 2025, 2026], FIVE);
  check("four years occupy 5+1+5+1+5+1+5 columns", L.width === 23, "got " + L.width);
  check("the first block starts at 0", L.starts[2023] === 0, "");
  // ⚠️ THE gap column. Without it the blocks abut and the year headers merge into
  // each other's columns — the report stops being readable as separate years.
  check("there is a gap column between blocks",
    L.starts[2024] === 6 && L.starts[2025] === 12 && L.starts[2026] === 18, JSON.stringify(L.starts));
  check("  mutation: the old newest-only geometry is 14 columns, not 23",
    layout([2023, 2024, 2025, 2026], function (fy) { return fy === 2026 ? 5 : 2; }).width === 14);

  const merges = function (fys, st) {
    return fys.map(function (fy) { return { c: st[fy], e: st[fy] + 5 - 1 }; });
  };
  const M = merges([2023, 2024, 2025, 2026], L.starts);
  // ⚠️ A merge one column too wide puts a 年度 header over the next year's month
  // column, and the numbers underneath then read as the wrong year.
  check("each 年度 merge covers exactly its own block",
    M.every(function (x, i) { return i === 0 || x.c > M[i - 1].e; }),
    JSON.stringify(M));
  check("no merge reaches into the gap",
    M[0].e === 4 && M[1].c === 6, JSON.stringify(M));

  const src = HTML.slice(HTML.indexOf('function _stuTrendGrid'), HTML.indexOf('function _stuTrendFileName'));
  check("_stuTrendGrid's body was located", src.length > 1500, "");
  check("it lays out with a gap column",
    /if \(i > 0\) width \+= 1;/.test(src), "");
  check("every block is STU_TREND_BLOCK_COLS (5) wide",
    /width \+= STU_TREND_BLOCK_COLS;/.test(src) && /const STU_TREND_BLOCK_COLS = 5;/.test(HTML), "");
  check("no newest-only branch remains in the table, the Excel grid or the PDF",
    !/fy === latest/.test(HTML) && !/fy === m\.latest/.test(HTML) && !/const wide = /.test(HTML), "");
  check("the Excel grid writes 前月差 / 出 / 入 for every block",
    /aoa\[sub\]\[c \+ 2\] = '前月差'; aoa\[sub\]\[c \+ 3\] = '出'; aoa\[sub\]\[c \+ 4\] = '入';/.test(src) &&
    /\n            row\[c \+ 2\] = \(cur === null \|\| pv === null\) \? '' : \(cur - pv\);/.test(src), "");
  check("the 12 months run 4月 to 3月", /STU_FY_MONTHS\.forEach/.test(src), "");
  check("月平均 is the last data row", /avgRow\[c\] = '月平均';/.test(src), "");
  // ⚠️ Same rule as the screen: an absent figure exports blank, never 0.
  check("a missing figure exports blank, not 0",
    /row\[c \+ 1\] = \(cur === null\) \? '' : cur;/.test(src), "");
  check("月平均 divides by the filled months",
    /fills\[fy\] \? \(Math\.round\(\(sums\[fy\] \/ fills\[fy\]\)/.test(src), "");
  check("the captions travel with the file",
    /毎月月末締。年度は4月〜翌3月。/.test(src) && /_stuTrendBasis\(\)/.test(src),
    "a printed report outlives the screen that explained it");
  check("the 手動入力 count is a footnote, not a column",
    /'手動入力 ' \+ manualN \+ 'か月'/.test(src),
    "a column would break the grid the reference report uses");
}

console.log("\n18. the exports name themselves, not the active sub-tab");
{
  // ⚠️ _expXlsx / _expPdf / _expFileName all resolve through _expActive(), which
  // reports whichever 学生一覧 sub-tab is showing. Reused from this modal they
  // would save the file as 学生数レポート — silently, and only noticed later.
  const xAt = HTML.indexOf('function stuTrendExportXlsx');
  const xBody = HTML.slice(xAt, HTML.indexOf('function stuTrendExportPdf', xAt));
  const pAt = HTML.indexOf('function stuTrendExportPdf');
  const pBody = HTML.slice(pAt, HTML.indexOf('function _stuTrendCell', pAt) > pAt
    ? HTML.indexOf('function _stuTrendCell', pAt) : pAt + 4000);
  check("both export bodies were located", xBody.length > 300 && pBody.length > 800, "");

  [['xlsx', xBody], ['pdf', pBody]].forEach(function (t) {
    check(t[0] + " does not call _expActive", t[1].indexOf('_expActive') === -1,
      "it would title the file after the active 学生一覧 sub-tab");
    check(t[0] + " does not call _expFileName", t[1].indexOf('_expFileName') === -1,
      "same trap, one level down");
  });
  check("they use their own file name",
    /_stuTrendFileName\('xlsx'\)/.test(xBody) &&
    /function _stuTrendFileName/.test(HTML), "");
  check("the file name carries the report title",
    /STU_TREND_TITLE \+ '_'/.test(HTML), "");

  // The shared plumbing IS reused — just not the wrappers.
  check("xlsx still lazy-loads SheetJS through _withXlsx",
    /_withXlsx\(stuTrendExportXlsx\)/.test(xBody),
    "the library is fetched on first use, not in the page");
  check("xlsx writes the merges and widths",
    /ws\['!merges'\] = g\.merges;/.test(xBody) && /ws\['!cols'\] = g\.cols;/.test(xBody),
    "these are the parts the community build can actually write");
  check("pdf prints through a window, as the other PDF export does",
    /window\.open\('', '_blank'\)/.test(pBody) && /w\.print\(\)/.test(pBody), "");
  check("pdf is landscape", /@page\{size:landscape/.test(pBody), "");

  // Both formats and the unchanged CSV are reachable.
  check("the menu offers PDF, Excel and CSV",
    /onclick="stuTrendExportPdf\(\)"/.test(HTML) &&
    /onclick="stuTrendExportXlsx\(\)"/.test(HTML) &&
    /onclick="stuTrendExport\(\)"/.test(HTML), "");
  check("the menu says which is 帳票 and which is 明細",
    /帳票/.test(HTML) && /明細/.test(HTML),
    "CSV stays long-format on purpose; the label is what stops that surprising anyone");
}

// ---- transcribed from the roster / gate block ------------------------------
// ⚠️ WHY ANY OF THIS EXISTS. Enrollment_History stores two scalars a month, so a
// row deleted from the source 在籍 tab by accident and re-entered days later is
// indistinguishable from a departure followed by an arrival. With a month end in
// between, the low figure freezes forever and the restore reads as next month's
// increase — reported as "an increase with no new student". The roster turns both
// questions into set differences.
function ymAdd(ym, delta) {
  const p = String(ym || '').split('-');
  const y = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(y) || isNaN(m)) return '';
  const t = y * 12 + (m - 1) + delta;
  const yy = Math.floor(t / 12), mm = (t % 12) + 1;
  return yy + '-' + (mm < 10 ? '0' + mm : String(mm));
}
const DROP_RATIO = 0.05, MONTH_DROP_RATIO = 0.35, DROP_MIN = 10;
// Returns null when the snapshot records, or the UNACCOUNTED count when it holds.
// `past` is the Past_DB id list, or null when that sheet could not be read.
function gate(baseSame, basePrev, todayIds, past) {
  const base = baseSame.length ? baseSame : basePrev;
  if (!base.length) return null;                       // ⚠️ fails OPEN
  let have = {}; todayIds.forEach(function (id) { have[id] = true; });
  const vanished = base.filter(function (id) { return !have[id]; });
  // ⚠️ Only the students nobody can account for count against the cap. A
  // graduation is a MOVE to a 修了 tab, so the student is still in Past_DB; an
  // accidental deletion leaves them in neither sheet.
  // ⚠️ past === null (unreadable / renamed header) counts everyone — losing the
  // accounting must never widen the gate.
  let acc = null;
  if (past) { acc = {}; past.forEach(function (id) { acc[id] = true; }); }
  const unaccounted = acc ? vanished.filter(function (id) { return !acc[id]; }) : vanished;
  const ratio = baseSame.length ? DROP_RATIO : MONTH_DROP_RATIO;
  const cap = Math.max(DROP_MIN, Math.floor(base.length * ratio));
  return unaccounted.length > cap ? unaccounted.length : null;
}
function ids(n, from) { let a = []; for (let i = 0; i < n; i++) a.push(String((from || 260000) + i)); return a; }

console.log("\n19. the snapshot refuses to freeze a month that lost people it should not have");
{
  const base = ids(600);

  // Ordinary intra-month churn. cap = max(10, 30) = 30.
  check("a mid-month loss of 12 records normally",
    gate(base, [], base.slice(12)) === null, "cap is 30 within a month");
  check("a mid-month loss of 31 is held",
    gate(base, [], base.slice(31)) === 31,
    "nothing legitimately removes 31 students overnight; this is the reported bug");
  check("exactly at the cap it still records",
    gate(base, [], base.slice(30)) === null, "the test is > cap, not >= cap");

  // ⚠️ THE FALSE POSITIVE THAT WOULD MAKE THIS UNSHIPPABLE. April 2026 really did
  // go 647 -> 531: 116 students, 18%. It arrives as a cross-month comparison
  // because the new month has no roster of its own yet.
  {
    const march = ids(647);
    const april = march.slice(116);          // the real figure, not a made-up one
    check("a real April cohort departure is NOT held",
      gate([], march, april) === null,
      "0.35 exists to clear this; a tighter arm would refuse to record every April");
    check("but half the school vanishing IS held",
      gate([], march, march.slice(330)) === 330,
      "a partially-read sync looks like this");
  }

  // ⚠️ The floor, for the same reason DORM_VACATE_MIN has one.
  {
    const small = ids(40);
    check("a 40-student month may still lose 4",
      gate(small, [], small.slice(4)) === null,
      "without the floor, 5% of 40 is 2 and genuine withdrawals would be refused");
    check("a 40-student month losing 11 is held", gate(small, [], small.slice(11)) === 11, "");
  }

  // ⚠️ Fails open, twice over: no baseline at all, and the very first run.
  check("no roster anywhere records normally", gate([], [], ids(600)) === null,
    "the first run after deploy has no baseline and must still write");
  check("this month's roster wins over last month's when both exist",
    gate(base, ids(600, 900000), base.slice(12)) === null,
    "the tight arm applies only when the baseline is intra-month");

  // ⚠️ A renamed 学籍番号 header empties the roster, which must read as a fault and
  // not as an empty school — the DORM-03 shape.
  check("every student vanishing at once is held", gate(base, [], []) === 600,
    "a lost 学籍番号 column must hold, not record a school of zero");

  // Arrivals never trip it: the gate judges departures only.
  check("300 arrivals with no departures record normally",
    gate(base, [], base.concat(ids(300, 900000))) === null, "");
}

console.log("\n19b. a graduation is not a deletion, and the 修了 record is what says so");
{
  // ⚠️ THE FALSE POSITIVE THIS EXISTS TO REMOVE. 50 students moved out of 在籍 and
  // into a 修了 tab MID-month is 50 > the cap of 30, so before the Past_DB
  // cross-reference the month was refused outright and froze 50 too high.
  const base = ids(600);
  const leavers = base.slice(0, 50);          // the 50 who left
  const staying = base.slice(50);
  check("50 graduations mid-month record normally when 修了 has them",
    gate(base, [], staying, leavers) === null,
    "this is the case that made the gate unshippable without the cross-reference");
  check("the same 50 vanishing with NO 修了 record is held",
    gate(base, [], staying, []) === 50,
    "gone from both sheets is the fingerprint of an accidental deletion");

  // ⚠️ And the reason the filter makes the gate STRICTER, not just kinder: before
  // it, 50 legitimate departures ate the whole budget and hid anything alongside.
  {
    const grads = base.slice(0, 50), oops = base.slice(50, 95);   // 45 deleted rows
    const left = base.slice(95);
    check("45 deletions hiding behind 50 graduations are still caught",
      gate(base, [], left, grads) === 45,
      "unfiltered this was 95 vanished against a cap of 30 either way — but the " +
      "held count would have named the graduates too");
  }

  // A handful of untracked leavers stays under the cap, deliberately.
  // ⚠️ At 600 students the RATIO (30) is what clears this, not the floor — the
  // floor only ever binds on a small population, which §19's 40-student case is
  // for. Naming the wrong mechanism here made this check survive removing the
  // floor entirely.
  check("5 unaccounted departures stay under the cap",
    gate(base, [], base.slice(5), []) === null,
    "paperwork lag is normal and must not become noise");

  // ⚠️ Losing the accounting must FAIL SAFE — stricter, never wider.
  check("an unreadable 修了 sheet counts every departure",
    gate(base, [], staying, null) === 50,
    "null must not be read as 'everyone is accounted for'");
  check("...which is exactly what a populated 修了 sheet would have allowed",
    gate(base, [], staying, leavers) === null, "the two differ only by the accounting");
  // ⚠️ In the ARITHMETIC, null and {} are the same thing — an empty object filters
  // nothing out, so both leave every departure unaccounted. The distinction is
  // load-bearing in ONE place: whether the held log says the 修了 data could not be
  // read at all. "38 of 40 graduated" and "we could not check" need different
  // responses, and a mutation swapping null for {} is invisible without this.
  check("an empty accounting behaves as no accounting",
    gate(base, [], staying, []) === 50 && gate(base, [], staying, null) === 50,
    "which is why the null-ness has to be asserted on the LOG, not the count");

  // The April cohort, now for the right reason rather than by the loose arm alone.
  {
    const march = ids(647), gone = march.slice(0, 116);
    check("April's real 116 leavers record whether or not 修了 has them yet",
      gate([], march, march.slice(116), gone) === null &&
      gate([], march, march.slice(116), []) === null,
      "the loose cross-month arm stays as the safety valve for sync lag");
  }
}

console.log("\n20. the roster survives the round trip and stays bounded");
{
  const CHUNK = 200, KEEP = 26;
  function write(list) {
    let rows = [];
    for (let i = 0; i < list.length; i += CHUNK) {
      const c = list.slice(i, i + CHUNK);
      rows.push([c.join(','), c.length]);
    }
    return rows;
  }
  function read(rows) {
    let out = [], seen = {};
    rows.forEach(function (r) {
      String(r[0] || '').split(',').forEach(function (raw) {
        const id = raw.trim();
        if (id && !seen[id]) { seen[id] = true; out.push(id); }
      });
    });
    return out.sort();
  }
  const list = ids(607).sort();
  const rows = write(list);
  check("607 students chunk into 4 rows", rows.length === 4, "got " + rows.length);
  check("the last chunk is the remainder", rows[3][1] === 7, "got " + rows[3][1]);
  check("the set survives the round trip", read(rows).join() === list.join(), "");
  check("an empty roster writes no rows", write([]).length === 0,
    "a month with nobody in it must not leave a row claiming an empty id");
  // ⚠️ A duplicate spanning two chunks would count twice against the gate's cap.
  check("a duplicate across chunks is read once",
    read([['a,b', 2], ['b,c', 2]]).join() === 'a,b,c', "");

  // Retention: "YYYY-MM" sorts lexicographically, which is why the key has that shape.
  const now = '2026-09', oldest = ymAdd(now, -(KEEP - 1));
  // 2024-08 .. 2026-09 inclusive is exactly 26 months, which is what KEEP means.
  check("the window opens 25 months back", oldest === '2024-08', "got " + oldest);
  check("the oldest month in the window is kept", !('2024-08' < oldest), "");
  check("the month before it is dropped", '2024-07' < oldest, "");
  check("the window really is 26 months wide",
    (2026 * 12 + 9) - (2024 * 12 + 8) + 1 === KEEP, "off-by-one in the retention edge");
  check("ymAdd crosses the year boundary", ymAdd('2026-01', -1) === '2025-12', ymAdd('2026-01', -1));
  check("ymAdd crosses it forwards too", ymAdd('2026-12', 1) === '2027-01', ymAdd('2026-12', 1));
  check("ymAdd(-2) from March lands in January", ymAdd('2026-03', -2) === '2026-01', "");
}

console.log("\n20b. a hand-typed 年月 must not become an invisible row");
{
  // ⚠️ THE BUG THIS SECTION EXISTS FOR. Sheets parses a TYPED "2026-08" into a
  // date, so getDisplayValues returns "2026/08/01". setValues does not do this, so
  // the app's own rows read back fine and only hand-edited ones vanished — the
  // worst possible split, because the sheet you edit while investigating an
  // incident is the one that lies to you. Cost a full staging cycle.
  function ymNorm(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (/^\d{4}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{4})[-\/.](\d{1,2})(?:[-\/.]\d{1,2})?$/);
    if (!m) return t;
    const mo = parseInt(m[2], 10);
    if (isNaN(mo) || mo < 1 || mo > 12) return t;
    return m[1] + '-' + (mo < 10 ? '0' + mo : String(mo));
  }
  check("the canonical form passes through untouched", ymNorm('2026-08') === '2026-08', ymNorm('2026-08'));
  check("the slash-date Sheets actually produced is rescued",
    ymNorm('2026/08/01') === '2026-08', ymNorm('2026/08/01'));
  check("an ISO date is rescued", ymNorm('2026-08-01') === '2026-08', ymNorm('2026-08-01'));
  check("a dotted date is rescued", ymNorm('2026.08.01') === '2026-08', ymNorm('2026.08.01'));
  check("a single-digit month is zero-padded",
    ymNorm('2026/8/1') === '2026-08', ymNorm('2026/8/1'));
  check("year-month with no day is rescued", ymNorm('2026/8') === '2026-08', ymNorm('2026/8'));
  check("surrounding whitespace is trimmed", ymNorm('  2026-08  ') === '2026-08', "§9.2");
  // ⚠️ It must NOT invent a month out of something it does not understand — an
  // unrecognised value has to stay unrecognised, not silently become a real month.
  check("a 13th month is not accepted", ymNorm('2026/13/01') === '2026/13/01', ymNorm('2026/13/01'));
  check("a zero month is not accepted", ymNorm('2026/0/01') === '2026/0/01', ymNorm('2026/0/01'));
  check("junk is handed back unchanged", ymNorm('not a date') === 'not a date', "");
  check("blank stays blank", ymNorm('') === '' && ymNorm(null) === '', "");
  // Normalising both sides keeps the retention comparison honest.
  check("a rescued month still sorts against the window",
    ymNorm('2024/07/01') < '2024-08' && !(ymNorm('2024/08/01') < '2024-08'),
    "an un-normalised cell is neither replaced nor retired — it accumulates forever");
}

console.log("\n21. a student who leaves and comes straight back is not a departure");
{
  const RETURN_MIN = 2;
  // 復帰(M) = roster(M) ∩ roster(M-2) \ roster(M-1)
  function returns(r0, r1, r2) {
    if (!r0.length || !r1.length || !r2.length) return null;   // roster gap
    let in1 = {}, in2 = {};
    r1.forEach(function (i) { in1[i] = true; });
    r2.forEach(function (i) { in2[i] = true; });
    return r0.filter(function (i) { return !in1[i] && in2[i]; });
  }
  const flags = function (r0, r1, r2) {
    const r = returns(r0, r1, r2);
    return r !== null && r.length >= RETURN_MIN;
  };

  const core = ['a', 'b', 'c', 'd', 'e'];
  check("students absent one month and back the next are flagged",
    flags(core, ['a', 'b', 'c'], core) === true,
    "d and e vanished for one month — the fingerprint of an entry accident");
  check("the count is who came back, not who is enrolled",
    returns(core, ['a', 'b', 'c'], core).join() === 'd,e', "");

  // ⚠️ The negatives are the whole value. Each of these must NOT be flagged, or
  // the marker becomes noise and gets ignored the one time it matters.
  check("a genuine departure is not flagged",
    flags(['a', 'b', 'c'], ['a', 'b', 'c'], core) === false,
    "d and e left and stayed gone — that is the series working, not a fault");
  check("genuinely new students are not flagged",
    flags(core.concat(['x', 'y']), core, core) === false,
    "x and y were never here before; they are arrivals");
  check("one returner alone is not flagged",
    flags(core, ['a', 'b', 'c', 'd'], core) === false,
    "a leave of absence or a visa renewal does exactly this");
  check("an absence of two months is not flagged",
    flags(core, ['a', 'b', 'c'], ['a', 'b', 'c']) === false,
    "gone for two months and back is re-enrolment, not a slipped keystroke");
  check("a roster gap accuses nobody",
    returns(core, [], core) === null,
    "a month that was never measured cannot be judged short");
  check("a gap in the OLDEST month also stands down", returns(core, core, []) === null, "");
}

console.log("\n22. the new write paths obey the same rules as the old ones");
{
  const at = CODE.indexOf('function _recordEnrollmentSnapshot_');
  const body = CODE.slice(at, CODE.indexOf('\n}', CODE.indexOf('return { recorded: false, error', at)));

  // ⚠️ THE ORDERING THAT MAKES THE GATE A GATE. A vacate already written is one the
  // gate cannot recall (§6.5); the same is true of a deleted month.
  check("the gate decides before the first deleteRow",
    body.indexOf('reason: "drop gate"') !== -1 &&
    body.indexOf('reason: "drop gate"') < body.indexOf('deleteRow'),
    "holding after the delete would destroy the figure it exists to protect");
  check("a held run writes no roster either",
    body.indexOf('_writeEnrolRoster_') > body.indexOf('reason: "drop gate"'),
    "adopting the bad roster would make tomorrow's baseline the bad one");
  check("the gate weighs the UNACCOUNTED departures, not every departure",
    /if \(unaccounted\.length > cap\)/.test(body) && /_enrolPastIds_\(\)/.test(body),
    "counting graduations against the cap refuses every mid-month cohort move");
  check("an unreadable 修了 sheet falls back to counting everyone",
    /accountable \? vanished\.filter\(function \(id\) \{ return !accountable\[id\]; \}\)\s*\n?\s*: vanished/.test(body),
    "losing the accounting must make the gate stricter, never wider");
  check("Past_DB is read only when somebody actually went missing",
    /if \(vanished\.length\) \{\s*\n\s*accountable = _enrolPastIds_\(\);/.test(body),
    "~1400 rows on every quiet night for nothing");
  check("the held log separates the two halves",
    /うち修了記録なし/.test(body),
    "'40 missing' and '40 missing, 38 graduated' need different responses");
  check("_enrolPastIds_ signals 'could not account' on BOTH failure paths",
    /function _enrolPastIds_[\s\S]{0,900}?if \(iId === -1\) return null;[\s\S]{0,600}?catch \(e\) \{[\s\S]{0,300}?return null;/.test(CODE),
    "a lost 学籍番号 header and a thrown read must look the same to the caller, or " +
    "the log marker fires for one and not the other");
  check("the held log flags an unreadable 修了 sheet distinctly",
    /\(accountable \? "" : "・修了データ読取不可"\)/.test(body),
    "the only place null and {} differ in behaviour — without it, 'nobody was " +
    "accounted for' and 'we could not check' read identically");
  check("the gate compares ID SETS, not counts",
    /_enrolStudentIds_\(data\)/.test(body) && /_readEnrolRoster_\(/.test(body),
    "a count cannot tell 20 departures from 20 deletions");
  check("it holds only above BOTH the ratio and the floor",
    /Math\.max\(ENROL_DROP_MIN, Math\.floor\(base\.length \* ratio\)\)/.test(body), "");
  check("the cross-month arm is the looser one",
    /baseSame\.length \? ENROL_DROP_MAX_RATIO : ENROL_MONTH_DROP_MAX_RATIO/.test(body),
    "swapping these would refuse to record every April");
  check("a hold reaches 操作履歴, not just the execution log",
    /_logActivity_\([\s\S]{0,200}?在籍者数の更新を保留/.test(body),
    "nobody reads the execution log of a job that runs at 3am");
  check("the roster is written after the counts, on the recorded path only",
    /_writeEnrolRoster_\(ym, todayIds\);/.test(body), "");

  const rAt = CODE.indexOf('function _recordEnrollmentReturns_');
  const rBody = CODE.slice(rAt, CODE.indexOf('\n}', CODE.indexOf('return { flagged: false, error', rAt)));
  check("_recordEnrollmentReturns_' body was located", rAt !== -1 && rBody.length > 400,
    "the assertions below are vacuous until this passes");
  check("it stands down on a roster gap",
    /if \(!r0\.length \|\| !r1\.length \|\| !r2\.length\) \{[\s\S]{0,800}?return \{ flagged: false, reason: "roster gap" \};/.test(rBody),
    "a month that was never measured cannot be judged short");
  check("it never re-flags a month somebody already corrected",
    /if \(manual\) \{[\s\S]{0,200}?return \{ flagged: false, month: m1, reason: "manual entry present" \};/.test(rBody),
    "re-accusing a corrected figure is how a warning becomes wallpaper");
  check("it replaces its own earlier verdict rather than stacking one a night",
    /for \(let k = mine\.length - 1; k >= 0; k--\) sh\.deleteRow\(mine\[k\]\)/.test(rBody),
    "and bottom-up, because deleteRow shifts later rows up (§8.3)");
  check("it does NOT rewrite 合計 for the month it accuses",
    rBody.indexOf('"合計"') === -1,
    "a nightly job that edits a reported figure is worse than the bug it fixes");
  check("the row goes through the formula guard", /_cellSafeRow_\(\[m1, ENROL_RETURN_KIND/.test(rBody), "");
  check("it swallows its own errors like the snapshot does",
    /Enrollment return check failed/.test(rBody), "");

  // ⚠️ EVERY return path must say which one it was. All four used to return in
  // silence, so "roster gap", "already corrected", "nothing to report" and
  // "flagged it" were the same blank Execution log — indistinguishable from the
  // function not running at all. A staging test lost an afternoon to exactly that.
  // Same lesson as the dorm report's: record the RUN, not only the exceptions.
  {
    const paths = rBody.split('return {').length - 1;   // incl. the catch
    const logs = (rBody.match(/_enrolReturnLog_\(/g) || []).length;
    check("every success path logs which branch it took", logs === paths - 1,
      logs + " log calls for " + (paths - 1) + " success returns");
  }
  check("the gap line names all three roster lengths",
    /roster gap \(" \+ m2 \+ ":" \+ r2\.length[\s\S]{0,120}?r0\.length/.test(rBody),
    "which month is missing IS the diagnosis; 'gap' alone sends you back to the sheet");
  check("the below-threshold line reports the count it rejected",
    /under the threshold of " \+\s*\n?\s*ENROL_RETURN_MIN/.test(rBody),
    "'0 returned' and '1 returned' mean very different things about the data");
  check("_enrolReturnLog_ cannot itself break the nightly run",
    /function _enrolReturnLog_\(msg\) \{\s*\n\s*try \{ console\.info/.test(CODE), "");

  // ⚠️ 年月 is hand-typed during an investigation and Sheets parses it as a date.
  check("both 年月 and the id column are text-formatted",
    /sh\.getRange\(1, 1, sh\.getMaxRows\(\), 1\)\.setNumberFormat\("@"\);/.test(CODE) &&
    /sh\.getRange\(1, 3, sh\.getMaxRows\(\), 1\)\.setNumberFormat\("@"\);/.test(CODE),
    "a typed 2026-08 becomes 2026/08/01, matches no month, and looks right in the sheet");
  // ⚠️ Format prevents; it does not repair. A cell already holding a date serial
  // stays wrong until rewritten, which is why _ymNorm_ has to exist as well.
  check("the format is documented as prevention, not repair",
    /does NOT repair a cell that was already coerced/.test(CODE), "");

  const tAt = CODE.indexOf('function triggerAutoSyncStudents');
  const trig = CODE.slice(tAt, CODE.indexOf('\n}', CODE.indexOf('_authUser = was;', tAt)));
  check("the daily trigger runs the return check",
    /_recordEnrollmentReturns_\(\);/.test(trig), "");
  check("it runs AFTER the snapshot that writes today's roster",
    trig.indexOf('_recordEnrollmentSnapshot_') < trig.indexOf('_recordEnrollmentReturns_'),
    "the check needs this month's roster in place to compare the two before it");
  // ⚠️ The comment there claimed the snapshot only writes on the first run of a
  // month. It has replaced the month every run since the 月末締 fix.
  check("the call-site comment no longer claims once-a-month writes",
    trig.indexOf('only the first run in a new month') === -1,
    "a stale comment about an unattended job is how the next reader gets it wrong");

  const wAt = CODE.indexOf('function _writeEnrolRoster_');
  const wBody = CODE.slice(wAt, CODE.indexOf('\n}\n', wAt));
  check("the roster write is one setValues, never appendRow in a loop",
    /\.setValues\(rows\.map\(_cellSafeRow_\)\)/.test(wBody) &&
    wBody.replace(/\/\/[^\n]*/g, '').indexOf('appendRow') === -1, "");
  check("its delete pass walks bottom-up too",
    /for \(let k = drop\.length - 1; k >= 0; k--\)/.test(wBody), "");
  check("retention is applied in the SAME pass as the month's own rows",
    /m === ym \|\| \(oldest && m < oldest\)/.test(wBody),
    "a second delete pass over shifting row numbers is the §8.3 bug waiting to happen");

  check("the roster read compares through _ymNorm_, not the raw cell",
    /function _readEnrolRoster_[\s\S]{0,700}?if \(_ymNorm_\(data\[i\]\[0\]\) !== ym\) continue;/.test(CODE),
    "a coerced 年月 is invisible to a raw comparison while looking right on screen");
  check("the prune pass normalises too",
    /const m = _ymNorm_\(data\[i\]\[0\]\);/.test(wBody),
    "an un-normalised row is neither replaced nor retired, so it accumulates forever");
  {
    // ⚠️ Placement, not presence. Written inside `if (!sh) { … }` this runs only on
    // the very first call ever, so every project whose sheet already exists never
    // gets it — a fix that cannot reach the sheet it fixes, which reads as done.
    // That is exactly how it shipped in staging v153 and did nothing.
    const gAt = CODE.indexOf('function _getEnrolRosterSheet_');
    const gBody = CODE.slice(gAt, CODE.indexOf('\n}', gAt));
    const closeIf = gBody.indexOf('\n  }');            // end of the if (!sh) block
    const fmt = gBody.indexOf('setNumberFormat');
    check("_getEnrolRosterSheet_'s body was located", gAt !== -1 && closeIf !== -1 && fmt !== -1, "");
    check("the text format is applied OUTSIDE the sheet-creation block", fmt > closeIf,
      "inside it, it runs once ever and never reaches an existing sheet");
  }
  check("_readEnrolRoster_ never creates the sheet",
    /function _readEnrolRoster_[\s\S]{0,400}?getSheetByName\(SHEET_ENROL_ROSTER\)/.test(CODE) &&
    !/function _readEnrolRoster_[\s\S]{0,400}?insertSheet/.test(CODE),
    "it runs before anything has decided to write");

  // Correcting a month must clear the row that accused it.
  const sAt = CODE.indexOf('function saveEnrollmentMonths');
  const sBody = CODE.slice(sAt, CODE.indexOf('\n}', CODE.indexOf('return { saved:', sAt)));
  check("a hand correction drops the 復帰 row for that month",
    /kind === "合計" \|\| kind === "入" \|\| kind === ENROL_RETURN_KIND/.test(sBody),
    "the accusation must not outlive the correction");

  // The reader has to surface it, or the detection exists nowhere a screen reaches.
  const gAt = CODE.indexOf('function getEnrollmentHistory');
  const gBody = CODE.slice(gAt, CODE.indexOf('\n}', CODE.indexOf('return { rows: out', gAt)));
  check("getEnrollmentHistory reads the 復帰 rows",
    /kind === ENROL_RETURN_KIND/.test(gBody) && /returned: returned\[m\] \|\| 0/.test(gBody), "");
  check("it still does not touch the roster sheet",
    gBody.indexOf('SHEET_ENROL_ROSTER') === -1 && gBody.indexOf('_readEnrolRoster_') === -1,
    "~5KB of ids a month must not ride along on an interactive read");
}

console.log("\n23. the roster and the 合計 count the same people");
{
  // ⚠️ Two loops, two files' worth of drift potential. If they disagree the gate
  // compares one population against another and its cap means nothing.
  const H = ['学籍番号', '国名', 'コース', '性別'];
  function bucketsTotal(data) {          // transcribed from _enrolBucketsFor_
    const iId = data[0].indexOf('学籍番号');
    let total = 0;
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (!r) continue;
      if (iId !== -1 && String(r[iId] || '').trim() === '') continue;
      total++;
    }
    return total;
  }
  function studentIds(data) {            // transcribed from _enrolStudentIds_
    const iId = data[0].indexOf('学籍番号');
    if (iId === -1) return [];
    let out = [], seen = {};
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (!r) continue;
      const id = String(r[iId] || '').trim();
      if (!id || seen[id]) continue;
      seen[id] = true; out.push(id);
    }
    return out.sort();
  }
  const rows = [H,
    ['260401', 'ネパール', '進学', '男'],
    ['260402', 'ベトナム', '進学', '女'],
    ['', '', '', ''],                    // a spacer row, not a student
    ['  260403  ', '中国', '一般', '男'], // padded, per §9.2
    null,                                 // a hole in the array
    ['260404', 'ミャンマー', '進学', '女']
  ];
  check("both agree on realistic data", bucketsTotal(rows) === studentIds(rows).length,
    bucketsTotal(rows) + ' vs ' + studentIds(rows).length);
  check("a padded id is one student, trimmed",
    studentIds(rows).indexOf('260403') !== -1, studentIds(rows).join());
  check("spacer rows and holes are counted by neither",
    studentIds(rows).length === 4, studentIds(rows).join());

  // ⚠️ The two known divergences, asserted rather than assumed — both are safe,
  // and knowing WHICH WAY they lean is the point.
  const dup = [H, ['260401', '', '', ''], ['260401', '', '', '']];
  check("a duplicated id counts twice in 合計 but once in the roster",
    bucketsTotal(dup) === 2 && studentIds(dup).length === 1,
    "impossible via fetchAndMergeStudentData, which keys records by id — but the " +
    "roster erring LOW only ever makes the gate stricter");
  const noId = [['国名', 'コース'], ['ネパール', '進学'], ['ベトナム', '進学']];
  check("a renamed 学籍番号 column empties the roster while 合計 counts on",
    bucketsTotal(noId) === 2 && studentIds(noId).length === 0,
    "which is what makes the next run HOLD rather than record a school of zero");
}

console.log("\n24. 在籍数 / 入 / 出 rebuilt from 始業日 and 卒業年月日 (2026-10-06)");
{
  const vm = require('vm');
  const extract = (src, name) => {
    const st = src.indexOf("\nfunction " + name + "(");
    if (st < 0) throw new Error("missing " + name);
    let i = src.indexOf("{", st), d = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
      if (c === '"' || c === "'" || c === "`") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++; continue; }
      if (c === "/" && /[=(,:!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 3), i))) {
        for (i++; i < src.length && src[i] !== "/"; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") { while (src[++i] !== "]") if (src[i] === "\\") i++; } }
        continue;
      }
      if (c === "{") d++;
      if (c === "}" && --d === 0) return src.slice(st + 1, i + 1);
    }
  };
  const SERVER = ['getEnrollmentHistory', 'getEnrollmentMonthDetail', '_enrolPeople_', '_readEnrolRosters_', '_enrolDatedSeries_', '_enrolYm_', '_enrolStartYm_', '_enrolDateCells_', '_intakeKeyFromStudentId_', '_enrolCohortEndYm_', '_enrolOutYm_', '_ymNorm_', '_ymAdd_'];
  // Central_DB: 学籍番号 / 始業日. Past_DB: 学籍番号 / 始業日 / 修了期 / 卒業年月日.
  const CH = ['学籍番号', '国名', '始業日'], PH = ['学籍番号', '国籍', '始業日', '修了期', '卒業年月日', '備考'];
  function run(code, central, past, hist, today) {
    const ctx = vm.createContext({
      _permOrLegacyRole_: () => true, _hasPerm_: () => true,
      _ymKey_: () => today || '2026-10', Utilities: {},
      SHEET_ENROL_HISTORY: 'Enrollment_History', ENROL_MANUAL: '手動', ENROL_RETURN_KIND: '復帰',
      SHEET_ENROL_ROSTER: 'Enrollment_Roster',
      SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => {
        const rows = n === 'Enrollment_History' ? hist : (n === 'Enrollment_Roster' ? (global.__roster || null) : null);
        return rows ? { getDataRange: () => ({ getDisplayValues: () => rows.map(r => r.map(String)) }) } : null; } }) },
      _readTabs_: () => { if (central === 'throw') throw new Error('x'); return { Central_DB: central, Past_DB: past }; },
    });
    vm.runInContext(SERVER.map(n => extract(code, n)).join("\n"), ctx);
    const res = ctx.getEnrollmentHistory('', '');
    const by = {}; res.rows.forEach(r => { by[r.month] = r; });
    return { res, by };
  }
  // The reported case. 602 enrolled at the end of August 2026; 26 of them graduate in September
  // (whenever their rows were moved); nobody starts in September; 36 start in October.
  const central = [CH], past = [PH];
  for (let i = 0; i < 576; i++) central.push(['C' + i, 'ネパール', '2025/04/08']);
  for (let i = 0; i < 26; i++) past.push(['P' + i, 'ネパール', '2025/04/08', '2025.4~2026.3', '2026/09/' + String(1 + i % 28).padStart(2, '0'), '']);
  for (let i = 0; i < 36; i++) central.push(['N' + i, 'ネパール', '2026/10/06']);
  const { res, by } = run(CODE, central, past, null);
  check("⚠️ THE REPORTED CASE: September = 602 − 26 = 576, 出 26, 入 0, 前月差 −26",
    by['2026-08'].total === 602 && by['2026-09'].total === 576 && by['2026-09'].left === 26 && by['2026-09'].joined === 0 && by['2026-09'].net === -26,
    JSON.stringify([by['2026-08'], by['2026-09']]));
  check("October: 576 + 36 = 612, 入 36", by['2026-10'].total === 612 && by['2026-10'].joined === 36, JSON.stringify(by['2026-10']));
  const ms = Object.keys(res.series).sort();
  check("the identity holds EVERY month: 在籍(M) = 在籍(M−1) + 入 − 出",
    ms.every((m, i) => i === 0 || res.series[m].total === res.series[ms[i - 1]].total + res.series[m].joined - res.series[m].left));
  check("rows are the current 年度 and the three before it, through this month",
    res.rows[0].month === '2023-04' && res.rows[res.rows.length - 1].month === '2026-10', res.rows[0].month + '…' + res.rows[res.rows.length - 1].month);
  check("series reaches the earliest 始業日", ms[0] === '2025-04', ms[0]);
  check("a month before anyone started has no figure (null), not 0", by['2023-04'].total === null && by['2023-04'].net === null);

  // Estimated ends, edge cases.
  const p2 = [PH,
    ['E1', 'x', '2024/04/08', '2024.4~2025.3', '', ''],          // no date → end of 修了期: 2025-03
    ['E2', 'x', '2026/04/08', '2026.4~', '', ''],                // open tab → last month (2026-09)
    ['E3', 'x', '2023/04/08', '2024.3まで', '2024年3月31日', ''],  // a typed date
    ['E4', 'x', '', '2024.4~2025.3', '2025/03/31', ''],           // no 始業日 → nowhere
    ['E5', 'x', '2025/04/08', '2024.4~2025.3', '2024/03/31', ''],  // ends before it starts → dropped
    ['DUP', 'x', '2024/04/08', '2024.4~2025.3', '2025/03/31', '']]; // also in Central → Central wins
  const c2 = [CH, ['DUP', 'x', '2024/04/08']];
  const r2 = run(CODE, c2, p2, null).res;
  // A March end is counted out in APRIL (immigration counts March leavers as enrolled, §27).
  check("no 卒業年月日 → counted until its 修了期 ends (2025-03), its 出 in April", r2.series['2025-03'].left === 0 && r2.series['2025-04'].left >= 1 && r2.estimatedEnd === 2, JSON.stringify([r2.series['2025-03'], r2.series['2025-04'], r2.estimatedEnd]));
  // Since 2026-10-06 an open tab, undated and on no monthly list, ends at its START (§26).
  check("the open tab (2026.4~) with no date and no list ends at its START, 2026-04", r2.series['2026-04'].left === 1 && r2.series['2026-09'].left === 0, JSON.stringify([r2.series['2026-04'], r2.series['2026-09']]));
  check("a typed 「2024年3月31日」 is read (a March end: 出 in April)", r2.series['2024-04'].left === 1 && r2.series['2024-03'].left === 0);
  check("no 始業日 → counted nowhere (noStart); an end before its start → dropped", r2.noStart === 1 && r2.dropped === 1, JSON.stringify([r2.noStart, r2.dropped]));
  check("a 学籍番号 in both sheets is ONE person, still enrolled (Central wins)", r2.series['2026-10'].total === 1 + 0, JSON.stringify(r2.series['2026-10']));
  check("unreadable sheets → no rows and an error, never the snapshot", (() => { const r = run(CODE, 'throw', null, null).res; return r.rows.length === 0 && !!r.error; })());

  // Start = the 学籍番号's intake, 始業日 cross-checking it (decided 2026-10-06).
  const c4 = central.filter(r => !/^N/.test(r[0]));
  for (let i = 0; i < 36; i++) c4.push(['2026100' + String(i).padStart(2, '0'), 'ネパール', '']);
  const r4 = run(CODE, c4, past, null);
  check("36 October joiners with a blank 始業日 count in October by 学籍番号 (入 36, 在籍 612)",
    r4.by['2026-10'].joined === 36 && r4.by['2026-10'].total === 612 && r4.res.startMismatch === 0, JSON.stringify([r4.by['2026-10'], r4.res.startMismatch]));
  // Since 2026-10-07 (the maintainer's checker): the YEAR from the 学籍番号, the MONTH from 始業日.
  // 始業日's own year holds typos — a 202507 student entered as 2026/07.
  const sx = vm.createContext({}); vm.runInContext(['_enrolStartYm_', '_enrolYm_', '_intakeKeyFromStudentId_', '_ymNorm_'].map(n => extract(CODE, n)).join("\n"), sx);
  const S = (raw, sid) => sx._enrolStartYm_(raw, sid);
  check("⚠️ THE USER'S CASE: 202507 typed 2026/07/08 → 2025-07, corrected and flagged",
    S('2026/07/08', '2025070001').ym === '2025-07' && S('2026/07/08', '2025070001').fixed === true &&
    S('2026/07/08', '2025070001').src === '始業日（年を学籍番号で補正: 2026→2025）', JSON.stringify(S('2026/07/08', '2025070001')));
  check("202504 with a 始業日 of 2025/05/07 joins in May — the month is 始業日's, unflagged",
    S('2025/05/07', '2025040001').ym === '2025-05' && !S('2025/05/07', '2025040001').fixed && S('2025/05/07', '2025040001').mismatch === true &&
    S('2025/05/07', '2025040001').src === '始業日');
  check("a month before the intake month is the year after: 202510 + 2026/02/10 → 2026-02, unflagged",
    S('2026/02/10', '2025100001').ym === '2026-02' && !S('2026/02/10', '2025100001').fixed);
  check("…and the same month typed with the intake's year is corrected: 202510 + 2025/02/10 → 2026-02, flagged",
    S('2025/02/10', '2025100001').ym === '2026-02' && S('2025/02/10', '2025100001').fixed === true);
  check("an agreeing 始業日 → src 始業日, nothing flagged",
    S('2025/10/06', '2025100001').ym === '2025-10' && S('2025/10/06', '2025100001').src === '始業日' && !S('2025/10/06', '2025100001').fixed && !S('2025/10/06', '2025100001').mismatch);
  check("a 始業日 with no year: 05/06 on 202504 → 2025-05; 02/10 on 202510 → 2026-02; src says so, unflagged",
    S('05/06', '2025040001').ym === '2025-05' && S('5月6日', '2025040001').ym === '2025-05' && S('02/10', '2025100001').ym === '2026-02' &&
    S('05/06', '2025040001').src === '始業日（年は学籍番号から）' && !S('05/06', '2025040001').fixed);
  check("blank 始業日 → the intake, src 学籍番号", S('', '2026100001').ym === '2026-10' && !S('', '2026100001').mismatch && S('', '2026100001').src === '学籍番号');
  check("an id without a YYYYMM head: a full 始業日 as written; with neither → nowhere",
    S('2026/04/08', 'E9').ym === '2026-04' && S('2026/04/08', 'E9').src === '始業日' && S('', 'E4').ym === '' && S('10/06', 'X1').ym === '');
  const c7 = [CH, ['2025070001', 'ネパール', '2026/07/08'], ['2025040001', 'ネパール', '2025/05/07'], ['2025040002', 'ネパール', '2025/04/08']];
  const r7 = run(CODE, c7, [PH], null).res;
  check("in the series: the typo'd 202507 student is 入 in 2025-07 (not 2026-07); the May starter in May",
    r7.series['2025-07'].joined === 1 && r7.series['2026-07'].joined === 0 && r7.series['2025-05'].joined === 1 && r7.series['2025-04'].joined === 1 &&
    r7.startFixed === 1 && r7.startMismatch === 1, JSON.stringify([r7.series['2025-07'], r7.series['2026-07'], r7.startFixed, r7.startMismatch]));
  const dateWins = CODE.replace("  if (!intake) return full ? { ym: full,", "  if (full) return { ym: full, mismatch: false, fixed: false, src: \"始業日\" };\n  if (!intake) return full ? { ym: full,");
  check("  mutation: letting a full 始業日 win (v260) puts the 202507 student in July 2026",
    dateWins !== CODE && run(dateWins, c7, [PH], null).res.series['2026-07'].joined === 1);
  const noFlag = CODE.replace("const fixed = !!full && typedY !== y;", "const fixed = false;");
  check("  mutation: without the flag the correction is silent (startFixed 0)",
    noFlag !== CODE && run(noFlag, c7, [PH], null).res.startFixed === 0);

  // ⚠️ Dates are read as VALUES. _readTabs_ is FORMATTED_VALUE, and a column displayed MM/DD has no
  // year in its display. 始業日's year now comes from the id, but 卒業年月日's has no other source:
  // modelled as a display of 「09/15」 over a value of 2026-09-15.
  {
    const FN = ['_enrolPeople_', '_readEnrolRosters_', '_enrolYm_', '_enrolStartYm_', '_enrolDateCells_', '_intakeKeyFromStudentId_', '_enrolCohortEndYm_', '_enrolOutYm_', '_ymNorm_', '_ymAdd_'];
    const PHX = ['学籍番号', '国籍', '始業日', '修了期', '卒業年月日'];
    const shown = [PHX, ['2025040001', 'x', '04/08', '2025.4~2026.3', '09/15']];
    const values = { 'Past_DB': { 3: [['04/08']], 5: [[new Date(2026, 8, 15)]] } };
    const mk = (code, readThrows) => {
      const ctx = vm.createContext({ _ymKey_: () => '2026-10', SHEET_ENROL_ROSTER: 'Enrollment_Roster',
        Utilities: { formatDate: (d, tz, f) => d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') },
        SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'Asia/Tokyo', getSheetByName: (n) => {
          if (!values[n]) return null;
          return { getLastRow: () => 2,
                   getRange: (r, c, nr, nc) => { if (readThrows) throw new Error('x');
                     return { getValues: () => (r === 2 && nr === 1 && values[n][c]) || [['']] }; } }; } }) },
        _readTabs_: () => ({ Central_DB: [['学籍番号', '国名', '始業日']], Past_DB: shown }) });
      vm.runInContext(FN.map(n => extract(code, n)).join("\n"), ctx);
      return ctx._enrolPeople_('2026-10').byId['2025040001'];
    };
    const p = mk(CODE);
    check("⚠️ 卒業年月日 is read as a VALUE: a 「09/15」 display over 2026-09-15 ends in 2026-09",
      p.end === '2026-09' && p.endSrc === '卒業年月日' && p.start === '2025-04', JSON.stringify(p));
    const fromDisplay = CODE.replace('_enrolYm_(cell("卒業年月日", iEnd, i))', '_enrolYm_(data[i][iEnd])');
    check("  mutation: reading the display loses the year, and the end falls back to an estimate",
      fromDisplay !== CODE && mk(fromDisplay).endSrc !== '卒業年月日', JSON.stringify(mk(fromDisplay)));
    check("a failed value read falls back to the display text, never an error",
      mk(CODE, true).start === '2025-04');
    check("始業日 is read the same way", /const st = _enrolStartYm_\(cell\("始業日", iStart, i\), id\);/.test(CODE));
  }
  check("the identity still holds every month", (() => {
    const ser = r4.res.series, k = Object.keys(ser).sort();
    return k.every((m, i) => i === 0 || ser[m].total === ser[k[i - 1]].total + ser[m].joined - ser[m].left); })());
  check("the note states the rule and counts the corrected years",
    /入は始業日の月（年は学籍番号の入学期から。始業日が空欄なら入学期）/.test(HTML) && /始業日の年が学籍番号と合わない学生' \+ t\.startFixed \+ '名は学籍番号の年で計上/.test(HTML) &&
    /startFixed: ser\.startFixed/.test(CODE));
  check("a corrected year gets the warning badge; other 始業日 sources do not",
    /src\.indexOf\('始業日（'\) === 0 && src\.indexOf\('始業日（年を学籍番号で補正'\) !== 0/.test(HTML));

  // Hand-entered months keep their typed figures; 出 stays dated.
  const hist = [H, ['2024-05', '合計', '', 700, '', '手動'], ['2024-05', '入', '', 9, '', '手動'], ['2026-08', '合計', '', 999, '', '']];
  const r3 = run(CODE, central, past, hist).by;
  check("a 手動 month the dates do NOT cover keeps its typed 在籍 / 入", r3['2024-05'].total === 700 && r3['2024-05'].joined === 9 && r3['2024-05'].entered === true, JSON.stringify(r3['2024-05']));
  // ⚠️ THE +1 REPORT: September typed by hand (入 1) while the dates say 入 0 — the dates win.
  const histSep = [H, ['2026-09', '合計', '', 999, '', '手動'], ['2026-09', '入', '', 1, '', '手動']];
  const r6 = run(CODE, central, past, histSep).by['2026-09'];
  check("⚠️ a 手動 month the dates DO cover shows the dated figures (576, 入 0), the typed ones reported as ignored",
    r6.total === 576 && r6.joined === 0 && r6.entered === false && r6.typedIgnored && r6.typedIgnored.total === 999 && r6.typedIgnored.joined === 1, JSON.stringify(r6));
  const typedWins = CODE.replace("const entered = typed && !d;", "const entered = typed;").replace("    if (d) return d.total;\n    return typedTotals[m] !== undefined ? typedTotals[m] : null;", "    if (typedTotals[m] !== undefined) return typedTotals[m];\n    return d ? d.total : null;");
  check("  mutation: letting a typed month win brings the phantom 入 1 back", typedWins !== CODE && run(typedWins, central, past, histSep).by['2026-09'].joined === 1);
  check("...while a 自動 snapshot row is NOT shown (2026-08 stays 602, not 999)", r3['2026-08'].total === 602 && r3['2026-08'].entered === false);
  check("...and 前月差 next to a typed month uses the typed figure", r3['2024-06'].net === null || typeof r3['2024-06'].net === 'number');

  // Mutations.
  const inclusive = CODE.replace("run += j - l;", "run += j; if (m !== first) run -= (left[_ymAdd_(m, -1)] || 0);");
  check("  mutation: counting a September graduate as enrolled through September gives 602", inclusive !== CODE && run(inclusive, central, past, null).by['2026-09'].total === 602);
  const noPast = CODE.replace('take(tabs.Past_DB, true);', '');
  // (September alone would not catch it: without Past_DB the 26 vanish from August TOO, and 576
  // reappears by coincidence. August is where it shows.)
  check("  mutation: ignoring Past_DB drops the graduates from the months they were enrolled (August 576, not 602)",
    noPast !== CODE && run(noPast, central, past, null).by['2026-08'].total === 576);
  const noManual = CODE.replace('return typedTotals[m] !== undefined ? typedTotals[m] : null;', 'return null;');
  check("  mutation: ignoring 手動 loses the typed 700", noManual !== CODE && run(noManual, central, past, hist).by['2024-05'].total !== 700);

  // The import's column finder (unchanged from V 1.48.0).
  const m = vm.createContext({}); vm.runInContext(extract(CODE, '_pastColumnIndex_'), m);
  const P = m._pastColumnIndex_;
  check("卒業年月日: the exact header wins over 卒業予定 to its left", P('卒業年月日', ['学籍番号', '卒業予定', '卒業年月日']) === 2);
  check("...a variant is found, 卒業予定 / 卒業予定日 never",
    P('卒業年月日', ['卒業予定', '修了年月日']) === 1 && P('卒業年月日', ['卒業予定', '卒業日']) === 1 && P('卒業年月日', ['卒業予定日']) === -1);
  check("備考: exact over 寮備考; 備考（その他） accepted; absent → -1",
    P('備考', ['寮備考', '備考']) === 1 && P('備考', ['寮備考', '備考（その他）']) === 1 && P('備考', ['寮備考']) === -1);
  const loose = CODE.replace("&& h.indexOf(\"予定\") === -1) return c;", ") return c;");
  const lm = vm.createContext({}); vm.runInContext(extract(loose, '_pastColumnIndex_'), lm);
  check("  mutation: without the 予定 exclusion a variant search takes 卒業予定日", loose !== CODE && lm._pastColumnIndex_('卒業年月日', ['卒業予定日', '修了年月日']) === 0);
  check("Past_DB's columns are APPENDED after 修了期", /"修了期",\s*\n(\s*\/\/[^\n]*\n)*\s*"卒業年月日", "備考"\s*\n\s*\],/.test(CODE));
  const fm = vm.createContext({ AUDIT_SHEET: 'a', INTERVIEW_RESULTS_SHEET: 'b', SHEET_ANNOUNCEMENTS: 'c', SHEET_ENROL_HISTORY: 'd', SHEET_RECRUIT_NOTE: 'e', SCHED_TEMPLATE_SHEET: 'f' });
  vm.runInContext(extract(CODE, '_dateColumnFormats_'), fm);
  const pins = fm._dateColumnFormats_().filter(e => e.header === '卒業年月日');
  check("卒業年月日 is pinned to yyyy/mm/dd on Past_DB only", pins.length === 1 && pins[0].sheet === 'Past_DB');

  // The screen.
  const fnOf = (n) => { const i = HTML.indexOf('      function ' + n + '('); return HTML.slice(i, HTML.indexOf('\n      }\n', i) + 8); };
  const cx = vm.createContext({ _stuTrendEdits: {}, _stuTrendExtraYears: 0, _ymToday: () => '2026-10' });
  vm.runInContext('var _stuTrend = null;\n' + ['_stuTrendSeries', '_stuTrendKnown', '_stuTrendOut', '_stuTrendNum', '_stuFiscalYear'].map(fnOf).join('\n'), cx);
  cx._stuTrend = { today: '2026-10', series: res.series, rows: res.rows };
  const mby = cx._stuTrendSeries();
  const known = cx._stuTrendKnown(mby);
  check("the screen shows 576 / 出 26 for September", mby['2026-09'].total === 576 && cx._stuTrendOut(mby, '2026-09') === 26);
  check("series-only years do NOT all get drawn: known stays inside the four 年度", known.every(k => k >= '2023-04'));
  cx._stuTrend = { today: '2026-10', series: { '2019-05': { total: 50, joined: 1, left: 0 } }, rows: [] };
  cx._stuTrendExtraYears = 0;
  check("...an old series month appears only once 「＋ 前年度」 reaches its 年度", cx._stuTrendKnown(cx._stuTrendSeries()).length === 0 &&
    (() => { cx._stuTrendExtraYears = 4; return cx._stuTrendKnown(cx._stuTrendSeries()).indexOf('2019-05') !== -1; })());
  check("⚠️ no copy of 前月+入−在籍 is left anywhere in the client", !/pv \+ jn - cur/.test(HTML));
  check("the table, the Excel grid and the CSV all choose months through _stuTrendKnown", (HTML.match(/const known = _stuTrendKnown\(by\);/g) || []).length === 3);
}

console.log("\n25. a month's 入 / 出 by student, with where each date came from (2026-10-06)");
{
  const vm = require('vm');
  const extract = (src, name) => {
    const st = src.indexOf("\nfunction " + name + "(");
    if (st < 0) throw new Error("missing " + name);
    let i = src.indexOf("{", st), d = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
      if (c === '"' || c === "'" || c === "`") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++; continue; }
      if (c === "/" && /[=(,:!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 3), i))) {
        for (i++; i < src.length && src[i] !== "/"; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") { while (src[++i] !== "]") if (src[i] === "\\") i++; } }
        continue;
      }
      if (c === "{") d++;
      if (c === "}" && --d === 0) return src.slice(st + 1, i + 1);
    }
  };
  const FN = ['getEnrollmentMonthDetail', '_enrolPeople_', '_readEnrolRosters_', '_enrolDatedSeries_', '_enrolYm_', '_enrolStartYm_', '_enrolDateCells_', '_intakeKeyFromStudentId_', '_enrolCohortEndYm_', '_enrolOutYm_', '_ymNorm_', '_ymAdd_'];
  const CH = ['学籍番号', '国名', '名前英語', '始業日'], PH = ['学籍番号', '国籍', '名前英語', '始業日', '修了期', '卒業年月日', '備考'];
  // The reported shape: 26 dated September graduates, plus ONE student on the open 2026.4~ tab with
  // a blank 卒業年月日 (estimated end = last month = September) whose start is ALSO September.
  const central = [CH], past = [PH];
  for (let i = 0; i < 576; i++) central.push(['C' + i, 'ネパール', 'C ' + i, '2025/04/08']);
  for (let i = 0; i < 26; i++) past.push(['P' + i, 'ネパール', 'P ' + i, '2025/04/08', '2025.4~2026.3', '2026/09/15', '']);
  past.push(['202609001', 'ベトナム', 'ODD ONE', '', '2026.4~', '', '']);
  const ctx = vm.createContext({ _permOrLegacyRole_: () => true, _ymKey_: () => '2026-10',
    _readTabs_: () => ({ Central_DB: central, Past_DB: past }) });
  vm.runInContext(FN.map(n => extract(CODE, n)).join("\n"), ctx);
  const d = ctx.getEnrollmentMonthDetail('2026-09');
  // The reported shape (出 27 / 入 1) came from the open tab ending "last month". Since §26 it ends at
  // its START (2026-04) — before this student's 学籍番号 start — so they are dropped, not invented.
  check("the reported shape is gone: September lists 出 26 and 入 0", d.left.length === 26 && d.joined.length === 0, JSON.stringify([d.left.length, d.joined.length]));
  check("...the odd student appears in no list", !d.left.concat(d.joined).some(r => r.id === '202609001'));
  check("the 26 dated graduates show 卒業年月日 as their source", d.left.filter(r => r.src === '卒業年月日').length === 26);
  const ser = ctx._enrolDatedSeries_('2026-10');
  check("the lists equal the table's 入 / 出 for EVERY month (one per-student pass)", Object.keys(ser.months).every(m => {
    const x = ctx.getEnrollmentMonthDetail(m); return x.joined.length === ser.months[m].joined && x.left.length === ser.months[m].left; }));
  let threw = false; try { ctx.getEnrollmentMonthDetail('2026/09'); } catch (e) { threw = /年月が正しくありません/.test(e.message); }
  check("a malformed 年月 is refused", threw);
  const denied = vm.createContext({ _permOrLegacyRole_: () => false, _ymKey_: () => '2026-10', _readTabs_: () => ({}) });
  vm.runInContext(extract(CODE, 'getEnrollmentMonthDetail'), denied);
  let refused = false; try { denied.getEnrollmentMonthDetail('2026-09'); } catch (e) { refused = /権限がありません/.test(e.message); }
  check("it is gated like getEnrollmentHistory (view_students)", refused &&
    /function getEnrollmentMonthDetail\(ym\) \{\s*\n\s*if \(!_permOrLegacyRole_\("", "", "view_students", \["sales"\]\)\)/.test(CODE));
  check("registered in the API allow-list", /getEnrollmentMonthDetail: getEnrollmentMonthDetail,/.test(CODE));

  // The screen.
  const fnOf = (n) => { const i = HTML.indexOf('      function ' + n + '('); return HTML.slice(i, HTML.indexOf('\n      }\n', i) + 8); };
  const cx = vm.createContext({ escHtmlJs: (v) => String(v == null ? '' : v).replace(/</g, '&lt;') });
  vm.runInContext("var STU_TREND_SURE_SRC = ['始業日', '学籍番号', '学籍番号・始業日', '卒業年月日', '在籍リストから外れた月'];\n" + fnOf('_stuTrendDetailHtml'), cx);
  const html = cx._stuTrendDetailHtml({
    joined: [{ id: '2025100001', name: 'NEW', nat: '', start: '2025-10', src: '学籍番号（始業日 2026/10/06 と不一致）' }],
    left: [{ id: 'P1', name: 'A', nat: '', end: '2026-10', src: '卒業年月日' },
           { id: 'P2', name: 'B', nat: '', end: '2026-10', src: '在籍リストから外れた月' },
           { id: 'P3', name: 'C', nat: '', end: '2026-04', src: '修了期で推定（2026.4~）' }] });
  check("the modal lists both sections with their counts", /入　1名/.test(html) && /出　3名/.test(html));
  check("an ESTIMATED source is flagged (warning badge), a recorded one is not",
    /u-badge u-warn">学籍番号（始業日 2026\/10\/06 と不一致）/.test(html) && /u-badge u-warn">修了期で推定/.test(html) && !/u-warn">卒業年月日/.test(html) &&
    !/u-warn">在籍リストから外れた月/.test(html));
  check("names are escaped", /&lt;b>/.test(cx._stuTrendDetailHtml({ joined: [{ id: '1', name: '<b>x', nat: '', start: '', src: '始業日' }], left: [] })));
  check("a month with figures gets the clickable label; an empty month stays plain text",
    /cur !== null\s*\n?\s*\? '<button type="button" class="fy-mo-btn"/.test(HTML) && /onclick="stuTrendDetail\(\\'' \+ escAttrJsStr\(ym\) \+ '\\'\)"/.test(HTML));
  check("the detail modal comes AFTER the trend modal (stacks on top)", HTML.indexOf('id="stuTrendDetailModal"') > HTML.indexOf('id="stuTrendModal"'));
  check("a month the dates cover is read-only in the table", /const editable = canEdit && !\(\(_stuTrend && _stuTrend\.series\) \|\| \{\}\)\[ym\];/.test(HTML) &&
    /\(editable \? _stuTrendCell\(ym, 'total'/.test(HTML) && /\(editable \? _stuTrendCell\(ym, 'joined'/.test(HTML));
  check("the pop-up scrolls (a long 出 list must not run off the screen)",
    /id="stuTrendDetailModal"[^\n]*\n\s*<div class="modal-box" style="[^"]*max-height:85vh; overflow-y:auto;/.test(HTML));
  const sx = vm.createContext({ escHtmlJs: (v) => String(v) });
  vm.runInContext('var _stuTrend = null, _stuTrendEdits = {};\n' + ['_stuTrendDetailSummary', '_stuTrendSeries', '_stuTrendNum', '_stuPrevYm'].map(fnOf).join('\n'), sx);
  sx._stuTrend = { series: { '2026-08': { total: 602, joined: 0, left: 1 }, '2026-09': { total: 576, joined: 0, left: 26 } }, rows: [] };
  check("the pop-up states 在籍者数 and 前月差 from the table's own figures (576, 前月 602, −26)",
    /在籍者数 576名（前月 602名）　前月差 -26/.test(sx._stuTrendDetailSummary('2026-09')), sx._stuTrendDetailSummary('2026-09'));
  sx._stuTrend.rows = [{ month: '2026-09', total: 576, joined: 0, left: 26, typedIgnored: { total: 999, joined: 1 } }];
  check("the pop-up says when a typed value was ignored", /手動入力（在籍 999名・入 1名）は、始業日・卒業年月日からの集計を優先して表示していません/.test(sx._stuTrendDetailSummary('2026-09')));
}

console.log("\n26. a 修了生 with no 卒業年月日: the app's monthly lists, else the 修了期 (2026-10-06)");
{
  const vm = require('vm');
  const extract = (src, name) => {
    const st = src.indexOf("\nfunction " + name + "(");
    if (st < 0) throw new Error("missing " + name);
    let i = src.indexOf("{", st), d = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
      if (c === '"' || c === "'" || c === "`") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++; continue; }
      if (c === "/" && /[=(,:!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 3), i))) {
        for (i++; i < src.length && src[i] !== "/"; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") { while (src[++i] !== "]") if (src[i] === "\\") i++; } }
        continue;
      }
      if (c === "{") d++;
      if (c === "}" && --d === 0) return src.slice(st + 1, i + 1);
    }
  };
  const FN = ['getEnrollmentMonthDetail', '_enrolPeople_', '_readEnrolRosters_', '_enrolDatedSeries_', '_enrolYm_', '_enrolStartYm_', '_enrolDateCells_', '_intakeKeyFromStudentId_', '_enrolCohortEndYm_', '_enrolOutYm_', '_ymNorm_', '_ymAdd_'];
  const PH = ['学籍番号', '国籍', '名前英語', '始業日', '修了期', '卒業年月日', '備考'];
  const RH = ['年月', '連番', '学籍番号（カンマ区切り）', '人数', '記録日時'];
  function make(code, past, roster) {
    const ctx = vm.createContext({ _permOrLegacyRole_: () => true, _ymKey_: () => '2026-10', SHEET_ENROL_ROSTER: 'Enrollment_Roster',
      SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => {
        if (n !== 'Enrollment_Roster' || !roster) return null;
        if (roster === 'throw') return { getDataRange: () => { throw new Error('x'); } };
        return { getDataRange: () => ({ getDisplayValues: () => roster.map(r => r.map(String)) }) }; } }) },
      _readTabs_: () => ({ Central_DB: [['学籍番号', '国名', '名前英語', '始業日']], Past_DB: past }) });
    vm.runInContext(FN.map(n => extract(code, n)).join("\n"), ctx);
    return ctx;
  }
  const past = [PH,
    ['2025071135', 'ネパール', 'APRIL LEAVER', '2025/07/08', '2026.4~', '', ''],   // gone before the lists began
    ['2025041001', 'ネパール', 'OCT LEAVER', '2025/04/08', '2026.4~', '', ''],     // on Sept's list, not Oct's
    ['2025041002', 'ネパール', 'TODAY MOVE', '2025/04/08', '2026.4~', '', ''],     // on Oct's list: moved since last night
    ['2024041003', 'ネパール', 'CLOSED', '2024/04/08', '2024.4~2025.3', '', ''],   // closed tab, on no list
    ['2025041004', 'ネパール', 'DATED', '2025/04/08', '2026.4~', '2026/07/31', '']]; // a date beats the list
  const roster = [RH, ['2026-09', '1', '2025041001,2025041002,2025041004', '3', ''], ['2026-10', '1', '2025041002', '1', '']];
  const ctx = make(CODE, past, roster);
  const people = ctx._enrolPeople_('2026-10').byId;
  check("⚠️ 2025071135 (on no list, open tab) leaves in 2026-04 — not September", people['2025071135'].end === '2026-04' && /^修了期で推定（2026\.4~）/.test(people['2025071135'].endSrc), JSON.stringify(people['2025071135']));
  check("on September's list, gone from October's → leaves 2026-10, by the app's record",
    people['2025041001'].end === '2026-10' && people['2025041001'].endSrc === '在籍リストから外れた月' && people['2025041001'].est === false, JSON.stringify(people['2025041001']));
  check("on THIS month's list (moved since last night) → leaves this month", people['2025041002'].end === '2026-10', JSON.stringify(people['2025041002']));
  check("a closed tab on no list → the end of its range (unchanged)", people['2024041003'].end === '2025-03');
  check("a 卒業年月日 always wins over the lists", people['2025041004'].end === '2026-07' && people['2025041004'].endSrc === '卒業年月日');
  check("September's 出 no longer holds 2025071135", !ctx.getEnrollmentMonthDetail('2026-09').left.some(r => r.id === '2025071135') &&
    ctx.getEnrollmentMonthDetail('2026-04').left.some(r => r.id === '2025071135'));
  check("an unreadable list falls back to the 修了期 estimate, nothing thrown", (() => {
    const c = make(CODE, past, 'throw'); const p = c._enrolPeople_('2026-10').byId; return p['2025041001'].end === '2026-04'; })());
  const ser = ctx._enrolDatedSeries_('2026-10');
  check("the lists still equal the series every month", Object.keys(ser.months).every(m => {
    const x = ctx.getEnrollmentMonthDetail(m); return x.joined.length === ser.months[m].joined && x.left.length === ser.months[m].left; }));
  const lastMonth = CODE.replace("end = pick(parts[1]) || pick(parts[0]);        // an open range ends at its own start", "end = pick(parts[1]);");
  check("  mutation: the old open-tab \"last month\" puts 2025071135 back in September", lastMonth !== CODE && make(lastMonth, past, roster)._enrolPeople_('2026-10').byId['2025071135'].end === '2026-09');
  const noLists = CODE.replace("if (!end && lastOnList[id]) {", "if (false) {");
  check("  mutation: ignoring the lists puts the October leaver at April", noLists !== CODE && make(noLists, past, roster)._enrolPeople_('2026-10').byId['2025041001'].end === '2026-04');
  check("在籍リストから外れた月, 始業日 and 学籍番号 are records, not estimates (no warning badge)",
    /const STU_TREND_SURE_SRC = \['始業日', '学籍番号', '卒業年月日', '在籍リストから外れた月'\];/.test(HTML));
  check("the note says how undated 修了生 are placed", /卒業年月日のない修了生は、2026年9月以降は在籍リストから外れた月で計上/.test(HTML));
}

const vm = require("vm");
console.log("\n27. March leavers are enrolled in March (immigration's count, 2026-10-07)");
{
  const extract = function (src, name) {
    const st = src.indexOf("function " + name + "(");
    let i = src.indexOf("{", st), d = 0;
    for (; i < src.length; i++) { const c = src[i];
      if (c === '"' || c === "'" || c === "`") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++; continue; }
      if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
      if (c === "{") d++; if (c === "}" && --d === 0) return src.slice(st, i + 1); }
  };
  const FN = ['getEnrollmentHistory', 'getEnrollmentMonthDetail', '_enrolPeople_', '_readEnrolRosters_', '_enrolDatedSeries_', '_enrolYm_', '_enrolStartYm_', '_enrolDateCells_', '_intakeKeyFromStudentId_', '_enrolCohortEndYm_', '_enrolOutYm_', '_ymNorm_', '_ymAdd_'];
  const CH = ['学籍番号', '国名', '名前英語', '始業日'], PH = ['学籍番号', '国籍', '名前英語', '始業日', '修了期', '卒業年月日'];
  const central = [CH], past = [PH];
  for (let i = 0; i < 10; i++) central.push(['20250400' + String(i).padStart(2, '0'), 'x', 'C' + i, '2025/04/08']);
  for (let i = 0; i < 3; i++) past.push(['20240400' + String(i).padStart(2, '0'), 'x', 'M' + i, '2024/04/08', '2024.4~2026.3', '2026/03/' + (20 + i)]);
  past.push(['2024040099', 'x', 'SEPT', '2024/04/08', '2024.4~2026.3', '2025/09/30']);
  const mk = (code) => { const ctx = vm.createContext({ _permOrLegacyRole_: () => true, _hasPerm_: () => true, _ymKey_: () => '2026-10', Utilities: {},
      SHEET_ENROL_HISTORY: 'Enrollment_History', ENROL_MANUAL: '手動', ENROL_RETURN_KIND: '復帰', SHEET_ENROL_ROSTER: 'Enrollment_Roster',
      SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => null }) },
      _readTabs_: () => ({ Central_DB: central, Past_DB: past }) });
    vm.runInContext(FN.map(n => extract(code, n)).join("\n"), ctx); return ctx; };
  const ctx = mk(CODE), ser = ctx.getEnrollmentHistory('', '').series;
  check("⚠️ THE USER'S CASE: 3 students leaving in March 2026 are IN March's 在籍 (13), out in April (10)",
    ser['2026-03'].total === 13 && ser['2026-03'].left === 0 && ser['2026-04'].total === 10 && ser['2026-04'].left === 3,
    JSON.stringify([ser['2026-03'], ser['2026-04']]));
  check("other months stay end-of-month: a September leaver is out of September itself",
    ser['2025-09'].left === 1 && ser['2025-09'].total === ser['2025-08'].total - 1, JSON.stringify([ser['2025-08'], ser['2025-09']]));
  const ks = Object.keys(ser).sort();
  check("the identity still holds every month", ks.every((m, i) => i === 0 || ser[m].total === ser[ks[i - 1]].total + ser[m].joined - ser[m].left));
  const apr = ctx.getEnrollmentMonthDetail('2026-04'), mar = ctx.getEnrollmentMonthDetail('2026-03');
  check("the month list agrees: April lists the 3 (年月 still 2026-03), March lists none",
    apr.left.length === 3 && apr.left.every(r => r.end === '2026-03') && mar.left.length === 0, JSON.stringify([apr.left, mar.left]));
  const noRule = CODE.replace('return (end && end.slice(5, 7) === "03") ? _ymAdd_(end, 1) : end;', 'return end;');
  check("  mutation: without the March rule the 3 drop out of March (10)",
    noRule !== CODE && mk(noRule).getEnrollmentHistory('', '').series['2026-03'].total === 10);
  check("the note states it", /3月に修了・退学した学生は入管の基準に合わせて3月の在籍に含め、出は4月に計上。/.test(HTML));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
