// キャンセル subtracting from the 募集状況 grid.
//
// ⚠️ THE GRID SHOWS NET, Recruitment_DB STORES GROSS.
//
// A cancellation is a standing −1 on one cell (コース||国名||担当). The box a
// recruiter types into shows gross − cancels, and recSaveCell adds the cancels
// back before writing, so the sheet keeps "ever recruited" while the screen shows
// "still live". Decided with the user on 2026-08-07 after walking the alternative.
//
// Do NOT "simplify" this by making the box show the stored value. That is the
// ratchet: el.value would be saved as the new gross, the cancel would subtract
// again, and the cell walks 5 → 4 → 3 on every edit with the original
// unrecoverable. §5 below is that scenario, and it must keep failing on a
// naive implementation.
//
// The other failure this guards: the grid sums the same cells in TEN places,
// several of them duplicated between the render path and recRefreshTotals. A
// subtraction wired into only some of them leaves 現在 disagreeing with the grid
// printed directly below it — which is exactly why 他ビザ was given its own column
// rather than folded in. §2 checks every total from one fixture.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Index.html ----
let recData, _recCancelMap;

function _recCancelCounts() {
  let out = {};
  ((recData && recData.cancels) || []).forEach(function (r) {
    const co = String(r.course || "").trim();
    const nat = String(r.nationality || "").trim();
    const rec = String(r.incharge || "").trim();
    if (co === "" || nat === "" || rec === "") return;
    const k = co + "||" + nat + "||" + rec;
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}
function _recUnattributedCancels(courses) {
  return ((recData && recData.cancels) || []).filter(function (r) {
    const co = String(r.course || "").trim();
    if (co === "" || String(r.nationality || "").trim() === "" ||
        String(r.incharge || "").trim() === "") return true;
    return courses.indexOf(co) === -1;
  });
}
function _recGross(co, nat, rec) {
  return (recData && recData.counts && recData.counts[co + "||" + nat + "||" + rec]) || 0;
}
function _recNet(co, nat, rec) {
  return _recGross(co, nat, rec) - (_recCancelMap[co + "||" + nat + "||" + rec] || 0);
}
function _recSyncCancelMap() { _recCancelMap = _recCancelCounts(); }

// recSaveCell's arithmetic: the box holds net, the sheet holds gross.
function saveCell(co, nat, rec, boxValue) {
  let net = parseInt(boxValue, 10); if (isNaN(net) || net < 0) net = 0;
  const key = co + "||" + nat + "||" + rec;
  const cancels = _recCancelMap[key] || 0;
  const val = net + cancels;
  if (val === 0) delete recData.counts[key]; else recData.counts[key] = val;
  return val;
}

// The totals, mirroring the render and refresh paths (both go through _recNet).
const COURSES = ["進学1年3か月課程", "日本語・文化2年課程"];
const NATS = ["ベトナム", "ネパール"];
const STAFF = ["甲野", "乙山"];

function countryTotal(nat) {
  let t = 0; STAFF.forEach(s => COURSES.forEach(co => { t += _recNet(co, nat, s); })); return t;
}
function staffCourseTotal(co, s) {
  let t = 0; NATS.forEach(n => { t += _recNet(co, n, s); }); return t;
}
function staffGrand(s) {
  let t = 0; NATS.forEach(n => COURSES.forEach(co => { t += _recNet(co, n, s); })); return t;
}
function allRecruited() {
  let t = 0; NATS.forEach(n => { t += countryTotal(n); }); return t;
}
// recRenderCapacitySummary's 現在, which must equal the grid below it.
function genzai(co) {
  let t = 0;
  Object.keys(recData.counts).forEach(function (k) {
    if (k.split("||")[0] !== co) return;
    t += Math.max(0, recData.counts[k] - (_recCancelMap[k] || 0));
  });
  return t;
}
const CAP = 40, ENROLLED = 0, VISA = 0;
const goukei = co => ENROLLED + genzai(co) + VISA;
const zanwaku = co => CAP - goukei(co);

const CO = COURSES[0], NAT = NATS[0], REC = STAFF[0];
function reset(counts, cancels) {
  recData = { counts: counts || {}, cancels: cancels || [], recruiters: STAFF.slice() };
  _recSyncCancelMap();
}
const cancel = (kind, nat, name, co, rec) =>
  ({ kind, nationality: nat, name, course: co, incharge: rec });

console.log("\n1. no cancels: net is gross, nothing changes");
{
  reset({ "進学1年3か月課程||ベトナム||甲野": 5 }, []);
  check("cell", _recNet(CO, NAT, REC) === 5, String(_recNet(CO, NAT, REC)));
  check("現在", genzai(CO) === 5, String(genzai(CO)));
}

console.log("\n2. ONE cancel moves EVERY total, from one fixture");
{
  reset({
    "進学1年3か月課程||ベトナム||甲野": 5,
    "進学1年3か月課程||ネパール||甲野": 4,
    "進学1年3か月課程||ベトナム||乙山": 3
  }, []);
  const before = {
    cell: _recNet(CO, NAT, REC), country: countryTotal(NAT),
    staffCourse: staffCourseTotal(CO, REC), staffGrand: staffGrand(REC),
    all: allRecruited(), genzai: genzai(CO), goukei: goukei(CO), zanwaku: zanwaku(CO)
  };
  reset({
    "進学1年3か月課程||ベトナム||甲野": 5,
    "進学1年3か月課程||ネパール||甲野": 4,
    "進学1年3か月課程||ベトナム||乙山": 3
  }, [cancel("申請キャンセル", "ベトナム", "Aarav", CO, "甲野")]);

  check("the cell drops by 1", _recNet(CO, NAT, REC) === before.cell - 1,
    before.cell + " -> " + _recNet(CO, NAT, REC));
  check("that country's 現在数 drops by 1", countryTotal(NAT) === before.country - 1,
    before.country + " -> " + countryTotal(NAT));
  check("甲野's 担当者計 for that course drops by 1", staffCourseTotal(CO, REC) === before.staffCourse - 1,
    before.staffCourse + " -> " + staffCourseTotal(CO, REC));
  check("甲野's 担当者合計 drops by 1", staffGrand(REC) === before.staffGrand - 1,
    before.staffGrand + " -> " + staffGrand(REC));
  check("the grand 現在数 drops by 1", allRecruited() === before.all - 1,
    before.all + " -> " + allRecruited());
  check("現在 in 定員・残枠 drops by 1", genzai(CO) === before.genzai - 1,
    before.genzai + " -> " + genzai(CO));
  check("合計 drops by 1", goukei(CO) === before.goukei - 1, before.goukei + " -> " + goukei(CO));
  check("残枠 RISES by 1", zanwaku(CO) === before.zanwaku + 1,
    before.zanwaku + " -> " + zanwaku(CO));

  // The invariant 他ビザ's separate column exists to protect.
  check("現在 still equals the grid summed by hand", genzai(CO) === staffCourseTotal(CO, "甲野") + staffCourseTotal(CO, "乙山"),
    genzai(CO) + " vs " + (staffCourseTotal(CO, "甲野") + staffCourseTotal(CO, "乙山")));
  check("someone else's cell is untouched", _recNet(CO, NAT, "乙山") === 3, "");
  check("the same staff's other country is untouched", _recNet(CO, "ネパール", "甲野") === 4, "");
}

console.log("\n3. every 種別 counts, including one nobody defined");
{
  const KINDS = ["申請キャンセル", "申請取り下げ", "COE後キャンセル"];
  KINDS.forEach(function (k) {
    reset({ "進学1年3か月課程||ベトナム||甲野": 5 }, [cancel(k, "ベトナム", "X", CO, "甲野")]);
    check("'" + k + "' subtracts", _recNet(CO, NAT, REC) === 4, k + " -> " + _recNet(CO, NAT, REC));
  });
  // recRenderCancelTable only renders the three known kinds, so a row with any
  // other 種別 is invisible in the table. It must still subtract — "all types" —
  // and it must be named, or the table and the totals differ by exactly that row.
  reset({ "進学1年3か月課程||ベトナム||甲野": 5 }, [cancel("その他", "ベトナム", "Y", CO, "甲野")]);
  check("an unknown 種別 still subtracts", _recNet(CO, NAT, REC) === 4, String(_recNet(CO, NAT, REC)));
  check("three cancels take three off",
    (reset({ "進学1年3か月課程||ベトナム||甲野": 5 }, KINDS.map(k => cancel(k, "ベトナム", "Z", CO, "甲野"))),
     _recNet(CO, NAT, REC)) === 2, String(_recNet(CO, NAT, REC)));
}

console.log("\n4. a cancel that names no cell subtracts from nothing, and is named");
{
  const partial = [
    ["blank 担当", cancel("申請キャンセル", "ベトナム", "A", CO, "")],
    ["blank 課程", cancel("申請キャンセル", "ベトナム", "B", "", "甲野")],
    ["blank 国籍", cancel("申請キャンセル", "", "C", CO, "甲野")],
    ["a 課程 outside this intake", cancel("申請キャンセル", "ベトナム", "D", "就職2年課程", "甲野")]
  ];
  partial.forEach(function (p) {
    reset({ "進学1年3か月課程||ベトナム||甲野": 5 }, [p[1]]);
    check(p[0] + ": nothing is subtracted", _recNet(CO, NAT, REC) === 5, String(_recNet(CO, NAT, REC)));
    check(p[0] + ": it appears in the callout", _recUnattributedCancels(COURSES).length === 1,
      "recording a cancel that changes no number must never be silent");
  });
  reset({ "進学1年3か月課程||ベトナム||甲野": 5 },
        [cancel("その他", "ベトナム", "E", CO, "甲野")]);
  check("a fully-named cancel is NOT in the callout", _recUnattributedCancels(COURSES).length === 0,
    "it subtracts, so there is nothing to explain");
}

console.log("\n5. THE RATCHET — the scenario the user raised");
{
  // 5 recruited, one cancels, then they sign a new student.
  reset({ "進学1年3か月課程||ベトナム||甲野": 5 },
        [cancel("申請キャンセル", "ベトナム", "Aarav", CO, "甲野")]);
  check("box reads 4 after the cancel", _recNet(CO, NAT, REC) === 4, String(_recNet(CO, NAT, REC)));
  check("the sheet still holds 5", _recGross(CO, NAT, REC) === 5, String(_recGross(CO, NAT, REC)));

  // They see 4, sign one more, type 5.
  saveCell(CO, NAT, REC, 5);
  check("the sheet now holds 6", _recGross(CO, NAT, REC) === 6, String(_recGross(CO, NAT, REC)));
  check("the box still reads 5", _recNet(CO, NAT, REC) === 5, String(_recNet(CO, NAT, REC)));

  // ⚠️ The whole point: editing again must not walk it down.
  saveCell(CO, NAT, REC, _recNet(CO, NAT, REC));
  check("a no-op edit leaves the sheet at 6", _recGross(CO, NAT, REC) === 6, String(_recGross(CO, NAT, REC)));
  check("and the box at 5", _recNet(CO, NAT, REC) === 5, String(_recNet(CO, NAT, REC)));
  saveCell(CO, NAT, REC, _recNet(CO, NAT, REC));
  saveCell(CO, NAT, REC, _recNet(CO, NAT, REC));
  check("still 5 after three more no-op edits — no ratchet", _recNet(CO, NAT, REC) === 5,
    "this is the defect the design exists to avoid");
}

console.log("\n6. deleting the cancel restores the original number");
{
  reset({ "進学1年3か月課程||ベトナム||甲野": 5 },
        [cancel("申請キャンセル", "ベトナム", "Aarav", CO, "甲野")]);
  check("box reads 4", _recNet(CO, NAT, REC) === 4, "");
  recData.cancels = [];
  _recSyncCancelMap();
  check("box reads 5 again once the cancel is removed", _recNet(CO, NAT, REC) === 5,
    String(_recNet(CO, NAT, REC)));
  check("現在 recovers too", genzai(CO) === 5, String(genzai(CO)));
}

console.log("\n7. edges");
{
  // More cancels than recruits: shown as a negative rather than clamped, because
  // it means the data is wrong and hiding it helps nobody.
  reset({ "進学1年3か月課程||ベトナム||甲野": 1 },
        [cancel("申請キャンセル", "ベトナム", "A", CO, "甲野"),
         cancel("申請取り下げ", "ベトナム", "B", CO, "甲野")]);
  check("the cell shows -1, not 0", _recNet(CO, NAT, REC) === -1, String(_recNet(CO, NAT, REC)));
  // 現在 clamps per cell so one bad cell cannot drag the course total below zero.
  check("現在 clamps at 0 per cell", genzai(CO) === 0, String(genzai(CO)));

  // Zeroing a cell that has cancels.
  reset({ "進学1年3か月課程||ベトナム||甲野": 5 },
        [cancel("申請キャンセル", "ベトナム", "A", CO, "甲野")]);
  saveCell(CO, NAT, REC, 0);
  check("zeroing stores the cancel count, not a phantom", _recGross(CO, NAT, REC) === 1,
    String(_recGross(CO, NAT, REC)));
  check("and the box reads 0", _recNet(CO, NAT, REC) === 0, String(_recNet(CO, NAT, REC)));

  // A cancel for a cell with no entered number at all.
  reset({}, [cancel("申請キャンセル", "ベトナム", "A", CO, "甲野")]);
  check("a cancel against an empty cell shows -1", _recNet(CO, NAT, REC) === -1, "");
  check("and 現在 stays 0", genzai(CO) === 0, String(genzai(CO)));

  // Whitespace: the dropdowns emit exact strings, but a hand-edited sheet may not.
  reset({ "進学1年3か月課程||ベトナム||甲野": 5 },
        [cancel("申請キャンセル", " ベトナム ", "A", " " + CO + " ", " 甲野 ")]);
  check("surrounding whitespace is trimmed, so it still matches",
    _recNet(CO, NAT, REC) === 4, String(_recNet(CO, NAT, REC)));
}

console.log("\n8. the source still says what this test assumes");
{
  check("recSaveCell adds the cancels back before storing",
    /const cancels = _recCancelMap\[key\] \|\| 0;\s*\n\s*const val = net \+ cancels;/.test(HTML),
    "without this the box's reduced number is saved as the entered one — the ratchet");
  check("the grid's two counters are both _recNet",
    /const cnt = _recNet;/.test(HTML) && /const _recCnt = _recNet;/.test(HTML),
    "the render path and the refresh path must agree, or typing changes what the totals mean");
  check("現在 sums net per cell",
    /recData\.counts\[k\] - \(_recCancelMap\[k\] \|\| 0\)/.test(HTML),
    "現在 must equal the grid printed below it");
  check("the grand 現在数 is refreshable",
    /class="rec-all-cur"/.test(HTML) && /\.rec-all-cur'\)\.forEach/.test(HTML),
    "it had no class and went stale on the first edit");
  check("every cancel mutator goes through one propagator",
    (HTML.match(/_recCancelsChanged\(\)/g) || []).length >= 5,
    "a cancel that updates only some totals leaves the page disagreeing with itself");
  check("the map is rebuilt before anything renders on load",
    /_recSyncCancelMap\(\);   \/\/ before any render/.test(HTML), "");
  check("cells with cancels explain themselves",
    /キャンセル ' \+ vCan \+ '名を差し引いた数です/.test(HTML),
    "a number that silently drops is how people stop trusting the screen");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
