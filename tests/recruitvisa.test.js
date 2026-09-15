// 留学ビザ以外 rows counting toward 定員・残枠, and the 課程 dropdown that makes
// that counting trustworthy.
//
// The roster's 課程 was free text, so 進学2年課程 / 進学２年課程 / 進学2年 課程
// were three different courses to anything grouping by it. Counting free text
// would have produced quietly wrong totals — hence the dropdown.
//
// The trap the dropdown itself introduces: a <select> whose value is absent from
// its options silently selects the first option and fires NO change event, so the
// sheet keeps the old text while the UI shows something else. §3 pins that down.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// Mirrors _recVisaByCourse: one seat per row that has a 課程.
function visaByCourse(rows) {
  let out = {};
  (rows || []).forEach(function (r) {
    const co = String(r.course || "").trim();
    if (co === "") return;
    out[co] = (out[co] || 0) + 1;
  });
  return out;
}

// Mirrors _recUnattributedVisa: rows no column in the summary can show.
function unattributed(rows, courses) {
  return (rows || []).filter(function (r) {
    const co = String(r.course || "").trim();
    return co === "" || courses.indexOf(co) === -1;
  });
}

// Mirrors the per-course arithmetic in recRenderCapacitySummary.
function summaryRow(co, cap, enr, pro, vis) {
  const capNum = (cap === undefined || cap === "") ? null : Number(cap);
  const total = enr + pro + vis;
  return { course: co, total: total, left: capNum === null ? null : capNum - total };
}

// Mirrors the courseSelect "known" test.
function isKnown(cur, opts) {
  const v = String(cur || "").trim();
  return v === "" || opts.indexOf(v) !== -1;
}

const COURSES = ["進学2年課程", "進学1年課程", "就職2年課程", "日本語・文化2年課程"];
const row = (course, name) => ({ course: course, name: name || "", no: "1" });

console.log("\n1. which rows count as a seat");
{
  const rows = [
    row("進学2年課程", "Aarav"),
    row("進学2年課程", "StudentG"),
    row("就職2年課程", "StudentB"),
    row("", "StudentD"),          // course not picked yet — counts toward nothing
    row("   ", "StudentE")         // whitespace only, same thing
  ];
  const v = visaByCourse(rows);
  check("two rows on one course sum", v["進学2年課程"] === 2, JSON.stringify(v));
  check("single row counts once", v["就職2年課程"] === 1, JSON.stringify(v));
  check("blank 課程 creates no key", v[""] === undefined, JSON.stringify(v));
  check("whitespace 課程 creates no key", v["   "] === undefined, JSON.stringify(v));
  // A blank row is what 「＋ 行を追加」 produces. If it counted, every click would
  // silently eat a seat.
  check("a freshly-added blank row adds nothing",
    Object.keys(visaByCourse([row("", "")])).length === 0,
    JSON.stringify(visaByCourse([row("", "")])));
  check("empty roster yields no keys", Object.keys(visaByCourse([])).length === 0, "");
}

console.log("\n2. the counting is exact, not normalised");
{
  // Deliberate: the summary iterates the intake's course list and looks up the
  // EXACT string. A near-miss must land in the warning line, not silently merge
  // into a course — which is precisely what the dropdown prevents going forward.
  const v = visaByCourse([row("進学２年課程", "full-width digit")]);
  check("full-width variant is its own key, not merged",
    v["進学2年課程"] === undefined && v["進学２年課程"] === 1, JSON.stringify(v));
  check("and it is reported as unattributed",
    unattributed([row("進学２年課程", "x")], COURSES).length === 1, "");
}

console.log("\n3. dropdown: a legacy value must not be silently swapped");
{
  check("a known course is known", isKnown("進学2年課程", COURSES), "");
  check("blank is treated as known (renders the blank option)", isKnown("", COURSES), "");
  // If this said "known", the <select> would fall back to its first option with no
  // change event: UI shows 進学2年課程, sheet still says 進学２年課程, and the next
  // unrelated edit looks like it corrupted the row.
  check("a full-width typo is NOT known, so it gets its own 対象外 option",
    !isKnown("進学２年課程", COURSES), "would have been silently reassigned");
  check("a course from another intake is not known", !isKnown("進学1年9か月課程", COURSES), "");
  check("trailing space does not make a course unknown",
    isKnown("  進学2年課程  ", COURSES), "trim happens before the lookup");
}

console.log("\n4. unattributed rows are named, not dropped");
{
  const rows = [
    row("進学2年課程", "counted"),
    row("", "no course"),
    row("進学２年課程", "typo"),
    row("進学1年9か月課程", "wrong intake")
  ];
  const orphans = unattributed(rows, COURSES);
  check("three rows cannot be shown", orphans.length === 3, String(orphans.length));
  check("the valid row is not among them",
    orphans.every(function (r) { return r.name !== "counted"; }), JSON.stringify(orphans));

  // The invariant that makes the warning line trustworthy: every roster row is
  // either counted against a listed course or named in the warning. Neither
  // double-counted nor lost.
  const shown = COURSES.reduce(function (n, co) { return n + (visaByCourse(rows)[co] || 0); }, 0);
  check("counted + unattributed == every roster row",
    shown + orphans.length === rows.length, shown + " + " + orphans.length + " != " + rows.length);
}

console.log("\n5. totals and 残枠");
{
  // 合計 = enrolled + 現在 + 他ビザ. Before this change 他ビザ was absent, so 残枠
  // overstated the space left by exactly the roster size.
  const r = summaryRow("進学2年課程", 40, 20, 8, 3);
  check("合計 includes 他ビザ", r.total === 31, String(r.total));
  check("残枠 = 定員 - 合計", r.left === 9, String(r.left));

  const before = summaryRow("進学2年課程", 40, 20, 8, 0);
  check("残枠 shrinks by exactly the visa count", before.left - r.left === 3,
    before.left + " -> " + r.left);

  // No 定員 set: 残枠 stays "-" rather than becoming a number derived from nothing.
  const noCap = summaryRow("進学2年課程", "", 20, 8, 3);
  check("blank 定員 leaves 残枠 null, not NaN", noCap.left === null, String(noCap.left));
  check("合計 still computed without a 定員", noCap.total === 31, String(noCap.total));

  // Over capacity is what triggers the red styling.
  const over = summaryRow("進学2年課程", 30, 20, 8, 3);
  check("visa rows can push 残枠 negative", over.left === -1, String(over.left));

  const zero = summaryRow("日本語・文化2年課程", 30, 0, 0, 0);
  check("an untouched course is 0/0, not NaN",
    zero.total === 0 && zero.left === 30, JSON.stringify(zero));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
