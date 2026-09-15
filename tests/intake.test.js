// Blank-intake resolution and the client mismatch guard, transcribed from
// Code.js getRecruitmentData / _recruitIntakeList_ and Index.html recLoad /
// recFillIntakeSelect.
//
// Two things must hold: the newest intake is picked, and the client guard can
// never fire more than once (a loop here would hammer the backend).

function _recruitIntakeList_(data, cData) {
  let seen = {}, out = [];
  const push = v => { const s = String(v || "").trim(); if (s && !seen[s]) { seen[s] = 1; out.push(s); } };
  for (let i = 1; i < data.length; i++) push(data[i][1]);
  for (let i = 1; i < cData.length; i++) push(cData[i][0]);
  const k = s => { const m = String(s || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/); return m ? (parseInt(m[1], 10) * 100 + parseInt(m[2], 10)) : -1; };
  out.sort((a, b) => { const ka = k(a), kb = k(b); return ka !== kb ? kb - ka : String(a).localeCompare(String(b), "ja"); });
  return out;
}

function getRecruitmentData(data, cData, metaIntakes, intake, resolveBlank) {
  let intakes = _recruitIntakeList_(data, cData);
  metaIntakes.forEach(i => { if (intakes.indexOf(i) === -1) intakes.push(i); });
  const ikey = s => { const m = String(s || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/); return m ? (parseInt(m[1], 10) * 100 + parseInt(m[2], 10)) : -1; };
  intakes.sort((a, b) => { const ka = ikey(a), kb = ikey(b); return ka !== kb ? kb - ka : String(a).localeCompare(String(b), "ja"); });

  let want = String(intake == null ? "" : intake).trim();
  if (want === "" && resolveBlank && intakes.length) want = intakes[0];

  let counts = {};
  for (let i = 1; i < data.length; i++) {
    const it = String(data[i][1] || "").trim();
    if (it === "") continue;
    if (want !== "" && it !== want) continue;
    counts[data[i][2] + "||" + data[i][3] + "||" + data[i][4]] = parseInt(data[i][5], 10);
  }
  return { counts, intakes, resolvedIntake: want };
}

const _recSortIntakes = list => list.slice().sort((a, b) => {
  const k = s => { const m = String(s || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/); return m ? (parseInt(m[1], 10) * 100 + parseInt(m[2], 10)) : -1; };
  const ka = k(a), kb = k(b);
  return ka !== kb ? kb - ka : String(a).localeCompare(String(b), 'ja');
});

// One full recLoad cycle; returns how many server trips it made.
function simulate(sheet, ctxIntakes, forceIntake) {
  const sel = { value: "", options: [] };
  let trips = 0, chosen = null, loadedIntake = null;

  function recLoad(force) {
    if (trips > 10) throw new Error("INFINITE LOOP — recLoad recursed past 10 trips");
    const intake = force || sel.value || "";
    trips++;
    const recData = getRecruitmentData(sheet.data, sheet.cData, sheet.metaIntakes, intake, true);
    loadedIntake = recData.resolvedIntake;

    let cur = sel.value;
    let intakes = recData.intakes.slice();
    ctxIntakes.forEach(i => { if (intakes.indexOf(i) === -1) intakes.push(i); });
    intakes = _recSortIntakes(intakes);
    sel.options = intakes;
    sel.value = "";                                    // innerHTML rebuild clears it
    if (cur && intakes.indexOf(cur) !== -1) sel.value = cur;
    else if (intakes.length) sel.value = intakes[0];

    if (force && (recData.intakes || []).indexOf(force) !== -1) sel.value = force;

    if (intake === "" && sel.value && sel.value !== (recData.resolvedIntake || "")) { recLoad(); return; }
    chosen = sel.value;
  }

  recLoad(forceIntake);
  return { trips, chosen, loadedIntake };
}

const HDR = ["Timestamp", "入学期", "コース", "国名", "募集担当者", "人数"];
const CHDR = ["入学期", "コース", "定員", "前年実績", "国名"];
// Vary country/recruiter per row, otherwise every row collapses onto the same
// "コース||国名||募集担当者" key and the no-filter case looks like one entry.
const rows = spec => [HDR].concat(spec.map((s, i) =>
  [s[0], s[1], "日本語", "国" + i, "担当" + i, s[2] || "1"]));

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

console.log("\n1. Newest intake picked, one trip, data scoped to it");
{
  const sheet = {
    data: rows([["t", "2027年4月", "5"], ["t", "2026年10月", "3"]]),
    cData: [CHDR, ["2027年4月", "日本語", "20", "15", ""]],
    metaIntakes: []
  };
  const r = simulate(sheet, [], undefined);
  check("one round trip", r.trips === 1, "trips=" + r.trips);
  check("resolved to 2027年4月", r.loadedIntake === "2027年4月", r.loadedIntake);
  check("select agrees with data", r.chosen === r.loadedIntake, r.chosen + " vs " + r.loadedIntake);
  check("counts scoped to one intake",
    Object.keys(getRecruitmentData(sheet.data, sheet.cData, [], "", true).counts).length === 1, "not scoped");
}

console.log("\n2. 10月 sorts after 7月, not beside 1月");
{
  const sheet = { data: rows([["t", "2027年1月"], ["t", "2027年10月"], ["t", "2027年7月"]]), cData: [CHDR], metaIntakes: [] };
  const order = getRecruitmentData(sheet.data, sheet.cData, [], "", true).intakes;
  check("order 10月 > 7月 > 1月",
    JSON.stringify(order) === JSON.stringify(["2027年10月", "2027年7月", "2027年1月"]), JSON.stringify(order));
}

console.log("\n3. Empty sheets: stays blank, no throw, same shape");
{
  const sheet = { data: [HDR], cData: [CHDR], metaIntakes: [] };
  let r = null, threw = null;
  try { r = simulate(sheet, [], undefined); } catch (e) { threw = e.message; }
  check("does not throw", threw === null, String(threw));
  check("one trip", r && r.trips === 1, r && "trips=" + r.trips);
  check("resolvedIntake blank", r && r.loadedIntake === "", "'" + (r && r.loadedIntake) + "'");
}

console.log("\n4. Unparseable intake names sink to the bottom");
{
  const sheet = { data: rows([["t", "未定"], ["t", "2027年4月"]]), cData: [CHDR], metaIntakes: [] };
  const order = getRecruitmentData(sheet.data, sheet.cData, [], "", true).intakes;
  check("未定 sinks", order[order.length - 1] === "未定", JSON.stringify(order));
  check("resolves to the dated intake", simulate(sheet, [], undefined).loadedIntake === "2027年4月", "wrong");
}

console.log("\n5. ctx-only newer intake: guard fires exactly once");
{
  const sheet = { data: rows([["t", "2027年4月"]]), cData: [CHDR], metaIntakes: [] };
  const r = simulate(sheet, ["2027年7月"], undefined);
  check("exactly two trips", r.trips === 2, "trips=" + r.trips);
  check("second trip loaded what the select shows", r.loadedIntake === "2027年7月", r.loadedIntake);
}

console.log("\n6. forceIntake (add-intake path) loads it in one trip");
{
  const sheet = { data: rows([["t", "2027年4月"]]), cData: [CHDR], metaIntakes: ["2028年1月"] };
  const r = simulate(sheet, [], "2028年1月");
  check("one round trip", r.trips === 1, "trips=" + r.trips);
  check("lands on the new intake", r.chosen === "2028年1月", r.chosen);
}

console.log("\n7. resolveBlank omitted keeps the old no-filter behaviour");
{
  const sheet = { data: rows([["t", "2027年4月", "7"], ["t", "2026年10月", "4"]]), cData: [CHDR], metaIntakes: [] };
  const d = getRecruitmentData(sheet.data, sheet.cData, [], "", false);
  check("blank still means no filter", Object.keys(d.counts).length === 2, JSON.stringify(d.counts));
  check("resolvedIntake blank", d.resolvedIntake === "", d.resolvedIntake);
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
