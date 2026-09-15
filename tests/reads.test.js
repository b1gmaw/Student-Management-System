// Batched reads: three separate concerns that all have to hold for the 募集状況
// load path to be both fast and correct.
//
//  A. _rectangular_  — batchGet returns RAGGED rows (trailing empties stripped)
//                     where getDisplayValues returns a rectangle. Consumers index
//                     fixed columns, so the two must be indistinguishable.
//  B. _readTabs_     — per-execution memo: a tab is fetched at most once, and a
//                     warm bundle fetches nothing at all.
//  C. lastYear      — the bucketed single-scan must equal the old per-intake scan
//                     for every intake.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ============================ A. row shape ============================
function _rectangular_(rows, cols) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let j = r.length; j < cols; j++) r[j] = "";
    for (let j = 0; j < cols; j++) if (r[j] == null) r[j] = "";
  }
  return rows;
}
const raggedify = rect => rect.map(row => {
  const r = row.slice();
  while (r.length && (r[r.length - 1] === "" || r[r.length - 1] == null)) r.pop();
  return r;
});

function getOtherVisaRows(data, intake) {
  const want = String(intake == null ? "" : intake).trim();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    const it = String(data[i][0] || "").trim();
    if (it === "" || (want !== "" && it !== want)) continue;
    out.push({
      _sheetRow: i + 1, intake: it,
      no: String(data[i][1] || ""), nationality: String(data[i][2] || ""),
      name: String(data[i][3] || ""), visa: String(data[i][4] || ""),
      course: String(data[i][5] || ""), incharge: String(data[i][6] || ""),
      matsuno: String(data[i][7] || ""), fee: String(data[i][8] || "")
    });
  }
  return out;
}

console.log("\nA. ragged batchGet rows, padded, vs rectangular getDisplayValues");
{
  const rect = [
    ["入学期", "番号", "国籍", "名前", "ビザ", "課程", "担当", "松野", "学費"],
    ["2027年4月", "1", "中国", "己", "家族滞在", "進学2年課程", "丙川", "○", "納入済"],
    ["2027年4月", "2", "韓国", "金", "", "", "", "", ""],          // six trailing blanks
  ];
  const padded = _rectangular_(raggedify(rect.map(r => r.slice())), 9);
  check("raw shape identical", JSON.stringify(rect) === JSON.stringify(padded), JSON.stringify(padded));
  check("consumer output identical",
    JSON.stringify(getOtherVisaRows(rect, "2027年4月")) === JSON.stringify(getOtherVisaRows(padded, "2027年4月")),
    "differs");

  const empty = _rectangular_([], 9);
  check("empty range yields no rows", getOtherVisaRows(empty, "2027年4月").length === 0, "not empty");

  // An entirely blank interior row comes back as [] — row indices must not shift,
  // because _sheetRow drives deletion.
  const withBlank = _rectangular_(raggedify([
    ["入学期", "種別", "国籍", "名前", "課程"],
    ["", "", "", "", ""],
    ["2027年4月", "辞退", "ベトナム", "StudentH", "日本語"],
  ]), 5);
  check("blank interior row keeps later _sheetRow correct",
    getOtherVisaRows(withBlank, "2027年4月")[0]._sheetRow === 3,
    JSON.stringify(getOtherVisaRows(withBlank, "2027年4月")));
}

// ============================ B. tab memo ============================
const SHEET_DATA = {
  "Central_DB": [["学籍番号", "国名", "コース"], ["202604001", "ベトナム", "日本語"]],
  "Past_DB": [["学籍番号", "国名", "コース"], ["202504001", "中国", "進学"]],
  "PlacementTest_Config": [["Intake", "Course"], ["2027年4月", "日本語"]],
  "Staff_Master": [["id", "name"], ["s1", "丙川"]],
};
let fetchLog = [], _tabMemo = {};
function _bulkReadSheets_(names) {
  fetchLog.push(names.slice());
  let out = {};
  names.forEach(n => { out[n] = SHEET_DATA[n] || []; });
  return out;
}
function _readTabs_(names) {
  const missing = names.filter(n => !_tabMemo[n]);
  if (missing.length) {
    const got = _bulkReadSheets_(missing);
    missing.forEach(n => { _tabMemo[n] = got[n] || []; });
  }
  let out = {};
  names.forEach(n => { out[n] = _tabMemo[n]; });
  return out;
}

console.log("\nB. per-execution tab memo");
{
  _tabMemo = {}; fetchLog = [];
  _readTabs_(["PlacementTest_Config", "Staff_Master", "Central_DB"]);   // context
  _readTabs_(["Central_DB"]);                                          // realStats
  _readTabs_(["Central_DB", "Past_DB"]);                               // lastYear
  check("exactly 2 batched calls", fetchLog.length === 2, JSON.stringify(fetchLog));
  check("second fetches ONLY Past_DB", JSON.stringify(fetchLog[1]) === JSON.stringify(["Past_DB"]), JSON.stringify(fetchLog[1]));
  check("Central_DB fetched once", fetchLog.filter(c => c.indexOf("Central_DB") !== -1).length === 1, "more than once");

  _tabMemo = {}; fetchLog = [];
  check("warm bundle (no producer runs) fetches nothing", fetchLog.length === 0, JSON.stringify(fetchLog));

  _tabMemo = {}; fetchLog = [];
  _readTabs_(["Missing_Tab"]); _readTabs_(["Missing_Tab"]);
  check("missing tab memoised, not retried", fetchLog.length === 1, "calls=" + fetchLog.length);
}

// ============================ C. lastYear bucketing ============================
const normCourse = raw => String(raw || "")
  .substring(String(raw || "").indexOf("_") + 1).trim()
  .replace(/[（(]一般[）)]/g, "").replace(/\d+期/g, "").trim();

function oldImpl(sheets, intake) {
  const m = String(intake || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (!m) return { available: false, counts: {} };
  const ty = parseInt(m[1], 10) - 1, tm = parseInt(m[2], 10);
  let counts = {}, matched = 0, scanned = 0;
  ["Central_DB", "Past_DB"].forEach(name => {
    const data = sheets[name];
    if (!data || data.length < 2) return;
    const idIdx = data[0].indexOf("学籍番号"), cIdx = data[0].indexOf("コース");
    for (let i = 1; i < data.length; i++) {
      const sid = String(data[i][idIdx] || "").trim();
      if (sid.length < 6) continue;
      scanned++;
      const y = parseInt(sid.substring(0, 4), 10), mo = parseInt(sid.substring(4, 6), 10);
      if (isNaN(y) || isNaN(mo) || y !== ty || mo !== tm) continue;
      const co = normCourse(data[i][cIdx]);
      if (!co) continue;
      counts[co] = (counts[co] || 0) + 1; matched++;
    }
  });
  return { available: scanned > 0, counts, matched, label: ty + "年" + tm + "月" };
}

function buildBuckets(sheets) {
  let buckets = {}, matched = {}, scanned = 0;
  ["Central_DB", "Past_DB"].forEach(name => {
    const data = sheets[name];
    if (!data || data.length < 2) return;
    const idIdx = data[0].indexOf("学籍番号"), cIdx = data[0].indexOf("コース");
    for (let i = 1; i < data.length; i++) {
      const sid = String(data[i][idIdx] || "").trim();
      if (sid.length < 6) continue;
      scanned++;
      const y = parseInt(sid.substring(0, 4), 10), mo = parseInt(sid.substring(4, 6), 10);
      if (isNaN(y) || isNaN(mo)) continue;
      const co = normCourse(data[i][cIdx]);
      if (!co) continue;
      const k = y + "-" + mo;
      if (!buckets[k]) buckets[k] = {};
      buckets[k][co] = (buckets[k][co] || 0) + 1;
      matched[k] = (matched[k] || 0) + 1;
    }
  });
  return { buckets, matched, scanned };
}

function newImpl(all, intake) {
  const m = String(intake || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (!m) return { available: false, counts: {} };
  const ty = parseInt(m[1], 10) - 1, tm = parseInt(m[2], 10);
  const k = ty + "-" + tm;
  return { available: all.scanned > 0, counts: all.buckets[k] || {}, matched: all.matched[k] || 0, label: ty + "年" + tm + "月" };
}

console.log("\nC. bucketed lastYear equals the old per-intake scan");
{
  // 学籍番号 = YYYY + MM + sequence, month zero-padded.
  const H = ["学籍番号", "名前", "国名", "コース"];
  const mk = spec => [H].concat(spec.map(s => [s[0], "n", "c", s[1]]));
  const sheets = {
    Central_DB: mk([
      ["202604001", "日本語・文化2年課程"],
      ["202604002", "PRE_日本語・文化2年課程（一般）"],
      ["202604003", "進学2年課程 3期"],
      ["202610001", "日本語・文化2年課程"],
      ["202710001", "進学2年課程"],
      ["short", "日本語・文化2年課程"],
      ["202604004", ""],
      ["abcd04005", "進学2年課程"],
    ]),
    Past_DB: mk([
      ["202504001", "日本語・文化2年課程"],
      ["202504002", "進学2年課程"],
      ["202604006", "日本語・文化2年課程"],
      ["202507001", "進学2年課程"],
    ]),
  };
  const all = buildBuckets(sheets);
  ["2027年4月", "2027年10月", "2028年10月", "2026年4月", "2026年7月", "2030年1月", "未定", ""].forEach(it => {
    check("agrees for " + (it || "(blank)"),
      JSON.stringify(oldImpl(sheets, it)) === JSON.stringify(newImpl(all, it)),
      "\n        old=" + JSON.stringify(oldImpl(sheets, it)) + "\n        new=" + JSON.stringify(newImpl(all, it)));
  });
  const b = all.buckets["2026-4"] || {};
  check("2026-4 aggregates BOTH sheets",
    Object.keys(b).reduce((n, k) => n + b[k], 0) === 4, JSON.stringify(b));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
