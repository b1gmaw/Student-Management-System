// The 前年 column in 定員・残枠: which intake a student counts toward.
//
// It used to come from 学籍番号 — first 4 digits year, next 2 month. But when a
// student changes course, Central_DB's course cell is rewritten with BOTH a new
// prefix and a new course name, while 学籍番号 is never reissued. So for exactly
// those students 学籍番号 names the intake they LEFT, and they were counted
// against it — inflating one year and starving another. Real case: rows whose
// 学籍番号 says 202604 (82期) but who moved to 80期.
//
// The course cell is therefore authoritative, with 学籍番号 as the fallback so
// that rows without a usable prefix behave exactly as before.
//
// §5 guards a separate bug found in the same path: the bucket key and the
// front-end's lookup normalised differently, so any course value containing a
// space was stored under a key the front-end could never ask for.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Code.js ----
function normalizeCourseKana(s) {
  return String(s == null ? "" : s).replace(/[カヵヶ]/g, "か");
}

function coursePrefix(raw) {
  const s = String(raw == null ? "" : raw);
  const u = s.indexOf("_");
  if (u === -1) return null;
  const p = s.substring(0, u).trim();
  const ki = p.match(/^(\d{1,3})\s*期$/);
  if (ki) return { ki: parseInt(ki[1], 10) };
  if (/^\d{6}$/.test(p)) {
    const y = parseInt(p.substring(0, 4), 10);
    const mo = parseInt(p.substring(4, 6), 10);
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12) return { y: y, mo: mo };
  }
  return null;
}

// Mode of the 学籍番号 intake per 期. Movers are the minority, so the mode is the
// 期's true intake and the movers are the rows that disagree with it.
function kiIntakeMap(rows) {
  let votes = {};
  rows.forEach(function (r) {
    const p = coursePrefix(String(r.course || ""));
    if (!p || p.ki === undefined) return;
    const sid = String(r.sid || "").trim();
    if (sid.length < 6) return;
    const y = parseInt(sid.substring(0, 4), 10), mo = parseInt(sid.substring(4, 6), 10);
    if (isNaN(y) || isNaN(mo)) return;
    const k = y + "-" + mo;
    if (!votes[p.ki]) votes[p.ki] = {};
    votes[p.ki][k] = (votes[p.ki][k] || 0) + 1;
  });
  let map = {};
  Object.keys(votes).forEach(function (ki) {
    let best = null, bestN = -1;
    Object.keys(votes[ki]).forEach(function (k) {
      if (votes[ki][k] > bestN) { bestN = votes[ki][k]; best = k; }
    });
    if (best) {
      const parts = best.split("-");
      map[ki] = { y: parseInt(parts[0], 10), mo: parseInt(parts[1], 10) };
    }
  });
  return map;
}

function intakeFromCourseCell(raw, kiMap) {
  const p = coursePrefix(raw);
  if (!p) return null;
  if (p.ki !== undefined) {
    const hit = kiMap && kiMap[p.ki];
    return hit ? { y: hit.y, mo: hit.mo } : null;
  }
  return { y: p.y, mo: p.mo };
}

function recCourseKey(raw) {
  const s = String(raw == null ? "" : raw);
  let co = s.substring(s.indexOf("_") + 1)
    .replace(/[（(]一般[）)]/g, "")
    .replace(/\d+期/g, "");
  co = normalizeCourseKana(co);
  return co.replace(/[\s　]/g, "");
}

// Mirrors the front-end's _simNormCourseJs, which is what the summary table uses
// to look these buckets up.
function simNormCourseJs(s) {
  return String(s == null ? "" : s).replace(/[\s　]/g, "").replace(/[カヵヶ]/g, "か");
}

// Mirrors the loop in _enrolmentByIntakeMonthUncached_.
function bucket(rows) {
  const kiMap = kiIntakeMap(rows);
  let buckets = {}, matched = {}, scanned = 0;
  let fromCourseCol = 0, fromStudentId = 0, disagreed = 0, skipped = 0;
  rows.forEach(function (r) {
    const sid = String(r.sid || "").trim();
    if (sid.length < 6) { skipped++; return; }
    scanned++;
    const raw = String(r.course || "");
    const fromCell = intakeFromCourseCell(raw, kiMap);
    const sy = parseInt(sid.substring(0, 4), 10);
    const smo = parseInt(sid.substring(4, 6), 10);
    const sidOk = !isNaN(sy) && !isNaN(smo);
    let y, mo;
    if (fromCell)   { y = fromCell.y; mo = fromCell.mo; }
    else if (sidOk) { y = sy; mo = smo; }
    else            { skipped++; return; }
    const co = recCourseKey(raw);
    if (!co) { skipped++; return; }
    // Counted after the course check — see the note in Code.js.
    if (fromCell) {
      fromCourseCol++;
      if (sidOk && (sy !== y || smo !== mo)) disagreed++;
    } else { fromStudentId++; }
    const k = y + "-" + mo;
    if (!buckets[k]) buckets[k] = {};
    buckets[k][co] = (buckets[k][co] || 0) + 1;
    matched[k] = (matched[k] || 0) + 1;
  });
  return { buckets, matched, scanned, fromCourseCol, fromStudentId, disagreed, skipped };
}

console.log("\n1. the ordinary case is unchanged");
{
  const b = bucket([
    { sid: "202604001", course: "202604_進学2年課程" },
    { sid: "202604002", course: "202604_進学2年課程" },
    { sid: "202604003", course: "202604_日本語・文化2年課程" }
  ]);
  check("agreeing rows land in one bucket", b.buckets["2026-4"]["進学2年課程"] === 2,
    JSON.stringify(b.buckets));
  check("a second course in the same intake is separate",
    b.buckets["2026-4"]["日本語・文化2年課程"] === 1, JSON.stringify(b.buckets["2026-4"]));
  check("no disagreements reported", b.disagreed === 0, String(b.disagreed));
  check("all three attributed via the course column", b.fromCourseCol === 3, String(b.fromCourseCol));
  check("each student counted exactly once", b.matched["2026-4"] === 3, String(b.matched["2026-4"]));
}

console.log("\n2. the moved student — the whole point");
{
  // 学籍番号 says 2026-4 (82期); the course cell says they are now in 2025-10.
  const b = bucket([
    { sid: "202604001", course: "202604_進学2年課程" },
    { sid: "202604002", course: "202510_進学1年6か月課程" }   // changed course
  ]);
  check("the mover counts toward the course cell's intake",
    b.buckets["2025-10"] && b.buckets["2025-10"]["進学1年6か月課程"] === 1,
    JSON.stringify(b.buckets));
  // The bug, stated as an assertion: they must NOT also appear where 学籍番号 says.
  check("and is ABSENT from the 学籍番号 intake",
    b.matched["2026-4"] === 1,
    "the mover was still counted against the intake they left: " + JSON.stringify(b.matched));
  check("nobody is double-counted", b.matched["2026-4"] + b.matched["2025-10"] === 2,
    JSON.stringify(b.matched));
  check("the disagreement is reported", b.disagreed === 1, String(b.disagreed));
}

console.log("\n3. fallback to 学籍番号");
{
  const cases = [
    ["no underscore at all", "進学2年課程"],
    ["a 期 number, not a date", "82_進学2年課程"],
    ["a short prefix", "2026_進学2年課程"],
    ["a long prefix", "20260401_進学2年課程"],
    ["non-numeric prefix", "A_進学2年課程"],
    ["empty prefix", "_進学2年課程"]
  ];
  cases.forEach(function (c) {
    const b = bucket([{ sid: "202604001", course: c[1] }]);
    check(c[0] + " → falls back to 学籍番号",
      b.matched["2026-4"] === 1 && b.fromStudentId === 1,
      c[1] + " → " + JSON.stringify(b.matched));
  });
  // A 期 number reaching parseInt would have produced year 82 — a junk bucket
  // silently stealing students from a real intake.
  check("a 期 prefix creates no junk bucket",
    bucket([{ sid: "202604001", course: "82_進学2年課程" }]).buckets["82-undefined"] === undefined, "");
}

console.log("\n4. implausible prefixes are rejected, not trusted");
{
  [["month 99", "202699_進学2年課程"], ["month 00", "202600_進学2年課程"],
   ["year 9999", "999912_進学2年課程"], ["year 1899", "189904_進学2年課程"]].forEach(function (c) {
    check(c[0] + " is rejected", intakeFromCourseCell(c[1]) === null, c[1]);
    const b = bucket([{ sid: "202604001", course: c[1] }]);
    check(c[0] + " still counts via 学籍番号", b.matched["2026-4"] === 1, JSON.stringify(b.matched));
  });
  check("a valid boundary month passes", intakeFromCourseCell("202612_x").mo === 12, "");
  check("January passes", intakeFromCourseCell("202601_x").mo === 1, "");
}

console.log("\n5. the bucket key must match the front-end's lookup");
{
  // The summary table reads recLastYear.counts[_simNormCourseJs(co)]. A key built
  // any other way is one it can never ask for, and the column shows 0. This is
  // the assertion that keeps the two normalisers from drifting apart.
  const COURSES = ["進学2年課程", "進学1年課程", "就職2年課程", "日本語・文化2年課程",
                   "進学1年9か月課程", "進学1年6か月課程", "進学1年3か月課程"];
  COURSES.forEach(function (c) {
    check("key matches lookup for " + c, recCourseKey(c) === simNormCourseJs(c),
      JSON.stringify(recCourseKey(c)) + " vs " + JSON.stringify(simNormCourseJs(c)));
  });
  // The variants that made them disagree.
  check("an ASCII space is stripped from the key",
    recCourseKey("202604_進学2年 課程") === simNormCourseJs("進学2年課程"),
    JSON.stringify(recCourseKey("202604_進学2年 課程")));
  check("a full-width space (U+3000) is stripped",
    recCourseKey("202604_進学2年　課程") === simNormCourseJs("進学2年課程"),
    JSON.stringify(recCourseKey("202604_進学2年　課程")));
  check("katakana カ normalises to か on both sides",
    recCourseKey("202604_進学1年6カ月課程") === simNormCourseJs("進学1年6か月課程"),
    JSON.stringify(recCourseKey("202604_進学1年6カ月課程")));
  check("（一般）is stripped", recCourseKey("202604_進学2年課程（一般）") === "進学2年課程",
    JSON.stringify(recCourseKey("202604_進学2年課程（一般）")));
  check("a 期 suffix is stripped", recCourseKey("202604_進学2年課程82期") === "進学2年課程",
    JSON.stringify(recCourseKey("202604_進学2年課程82期")));
  // A spaced value used to be unreachable. Prove it now lands where the table looks.
  const b = bucket([{ sid: "202604001", course: "202604_進学2年　課程" }]);
  check("a spaced course value is now reachable by the front-end",
    b.buckets["2026-4"][simNormCourseJs("進学2年課程")] === 1,
    "stored under " + JSON.stringify(Object.keys(b.buckets["2026-4"])));
}

console.log("\n6. nobody vanishes silently");
{
  const rows = [
    { sid: "202604001", course: "202604_進学2年課程" },
    { sid: "202604002", course: "202510_進学1年6か月課程" },
    { sid: "202604003", course: "進学2年課程" },
    { sid: "202604004", course: "" },              // no course → not counted
    { sid: "12345",     course: "202604_進学2年課程" },  // 学籍番号 too short
    { sid: "abcdef001", course: "202604_進学2年課程" }   // unparseable id, good prefix
  ];
  const b = bucket(rows);
  const counted = Object.keys(b.matched).reduce(function (n, k) { return n + b.matched[k]; }, 0);
  check("counted + skipped == every row", counted + b.skipped === rows.length,
    counted + " + " + b.skipped + " != " + rows.length);
  // A row with a good prefix but a junk 学籍番号 still counts — the prefix is enough.
  check("a good prefix rescues an unparseable 学籍番号", counted === 4,
    "counted " + counted + ": " + JSON.stringify(b.matched));
  check("the source counters add up to the counted rows",
    b.fromCourseCol + b.fromStudentId === counted,
    b.fromCourseCol + " + " + b.fromStudentId + " != " + counted);
}

console.log("\n7. the real Central_DB shape: an NN期 prefix");
{
  // Measured from production: prefixes are 83期 ×114, 82期 ×77, 80期 ×50, 81期 ×21,
  // and 346 of 608 rows carry no prefix at all. The first version of this fix
  // parsed only YYYYMM and therefore did NOTHING — every total was unchanged.
  check("an NN期 prefix is recognised", coursePrefix("80期_進学1年6カ月課程").ki === 80,
    JSON.stringify(coursePrefix("80期_進学1年6カ月課程")));
  check("a space before 期 is tolerated", coursePrefix("80 期_x").ki === 80, "");
  check("a bare YYYYMM prefix still works", coursePrefix("202604_x").y === 2026, "");
  check("no prefix is still null", coursePrefix("進学") === null, "");
  check("a bare number without 期 is not a 期", coursePrefix("80_x") === null,
    "an unlabelled number must not be guessed at");

  // 期 → intake is derived by majority vote, so the mapping needs no anchor.
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ sid: "202510" + i, course: "80期_進学1年6か月課程" });
  for (let i = 0; i < 10; i++) rows.push({ sid: "202604" + i, course: "82期_進学2年課程" });
  // The mover: 学籍番号 says 82期's intake (2026-4), course cell says 80期.
  rows.push({ sid: "202604999", course: "80期_進学1年6か月課程" });

  const map = kiIntakeMap(rows);
  check("80期 derives to 2025-10", map[80].y === 2025 && map[80].mo === 10, JSON.stringify(map[80]));
  check("82期 derives to 2026-4", map[82].y === 2026 && map[82].mo === 4, JSON.stringify(map[82]));
  check("one mover does not swing the mode",
    map[80].y === 2025 && map[80].mo === 10,
    "the mover's 学籍番号 (2026-4) must not become 80期's intake");

  const b = bucket(rows);
  check("the mover counts toward 80期's intake", b.matched["2025-10"] === 11, JSON.stringify(b.matched));
  check("and is absent from their 学籍番号 intake", b.matched["2026-4"] === 10, JSON.stringify(b.matched));
  check("the mover is reported as a disagreement", b.disagreed === 1, String(b.disagreed));
  check("everyone is attributed via the course column", b.fromCourseCol === 21, String(b.fromCourseCol));
  check("nobody double-counted", b.matched["2025-10"] + b.matched["2026-4"] === rows.length,
    JSON.stringify(b.matched));

  // An unknown 期 has no mapping, so it must fall back rather than vanish.
  const b2 = bucket(rows.concat([{ sid: "202607001", course: "99期_進学2年課程" }]));
  check("an unmapped 期 falls back to 学籍番号", b2.matched["2026-7"] === 1, JSON.stringify(b2.matched));
}

console.log("\n8. the measured case: 2025年10月 進学1年6か月課程 == 18");
{
  // Ground truth from production. 15 students enrolled into the intake normally;
  // 3 moved in later and still carry a 202604 学籍番号, because 学籍番号 is never
  // reissued. The school's rule: a mover belongs to the intake of the course they
  // moved TO, so all 18 count against 2025年10月.
  //
  // 学生数 reports these 18 split across two intakes — correct for what it does,
  // since it buckets purely by 学籍番号. 前年 must not.
  const rows = [];
  for (let i = 0; i < 15; i++) rows.push({ sid: "20251000" + i, course: "80期_進学1年6カ月課程" });
  for (let i = 0; i < 3; i++)  rows.push({ sid: "20260410" + i, course: "80期_進学1年6カ月課程" });
  // Enough 82期 rows that 80期's mode cannot be dragged by the three movers.
  for (let i = 0; i < 40; i++) rows.push({ sid: "20260400" + i, course: "82期_進学2年課程" });

  const key = simNormCourseJs("進学1年6か月課程");
  const b = bucket(rows);
  check("18 in 2025-10, not 15", b.buckets["2025-10"][key] === 18,
    "got " + JSON.stringify(b.buckets["2025-10"]));
  check("the movers are NOT left in 2026-4",
    (b.buckets["2026-4"] || {})[key] === undefined,
    "movers stayed in the intake they left: " + JSON.stringify(b.buckets["2026-4"]));
  check("exactly 3 movers reported", b.disagreed === 3, String(b.disagreed));
  check("2026-4's own course is untouched",
    b.buckets["2026-4"][simNormCourseJs("進学2年課程")] === 40,
    JSON.stringify(b.buckets["2026-4"]));
  check("everyone counted once", b.matched["2025-10"] + b.matched["2026-4"] === rows.length,
    JSON.stringify(b.matched));
  // The katakana カ in the sheet must reach the front-end's か lookup.
  check("the カ/か variant lands where the table looks",
    b.buckets["2025-10"][simNormCourseJs("進学1年6か月課程")] === 18,
    JSON.stringify(Object.keys(b.buckets["2025-10"])));
  // 80期's mode must survive the movers.
  const map = kiIntakeMap(rows);
  check("80期 still derives to 2025-10 with 3 movers present",
    map[80].y === 2025 && map[80].mo === 10, JSON.stringify(map[80]));
}

console.log("\n9. Past_DB must not feed 前年");
{
  // Past_DB holds students who withdrew or graduated, and a withdrawal FREES THE
  // SLOT — so those rows must not count toward an intake's actuals.
  //
  // Measured: including Past_DB made 2025年10月 進学1年6か月課程 read 19 against a
  // true 18. The extra row was Past_DB's single 進学1年6か月課程 entry, 2025101001,
  // a withdrawn student. It carried no 期 prefix (Past_DB has none anywhere), so
  // the 学籍番号 fallback quietly put them back into the intake they had left.
  const central = [];
  for (let i = 0; i < 15; i++) central.push({ sid: "20251000" + i, course: "80期_進学1年6カ月課程" });
  for (let i = 0; i < 3; i++)  central.push({ sid: "20260410" + i, course: "80期_進学1年6カ月課程" });
  const withdrawn = [{ sid: "2025101001", course: "進学1年6カ月課程" }];   // Past_DB only

  const key = simNormCourseJs("進学1年6か月課程");
  check("Central_DB alone gives the true 18",
    bucket(central).buckets["2025-10"][key] === 18,
    JSON.stringify(bucket(central).buckets["2025-10"]));
  check("adding the withdrawn row would give 19 — the bug",
    bucket(central.concat(withdrawn)).buckets["2025-10"][key] === 19,
    "if this is not 19 the fixture no longer reproduces the reported failure");

  // The withdrawn row is indistinguishable from a live one by shape alone: real
  // course name, valid 学籍番号, no prefix. Which tab it came from is the ONLY
  // signal, so the fix has to be at the read, not in the row logic.
  check("the withdrawn row looks perfectly valid on its own",
    recCourseKey(withdrawn[0].course) === key && withdrawn[0].sid.length >= 6,
    "no field on the row marks it as withdrawn");

  // And the fallback itself must survive — it is what attributes the ~93
  // Central_DB rows that have a real course name but no 期 prefix.
  check("the 学籍番号 fallback still applies inside Central_DB",
    bucket([{ sid: "202510001", course: "進学1年6カ月課程" }]).buckets["2025-10"][key] === 1,
    "dropping the fallback would lose every unprefixed Central_DB row");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
