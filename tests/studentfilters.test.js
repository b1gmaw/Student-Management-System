// 学生一覧 → 在籍学生: the クラス and 性別 filters (2026-10-16).
//
// クラス is an ordinary column filter. 性別 is DERIVED, like 入学期: cells mix 男 / 男性 / M / Male,
// so it goes through _stuGenderLabel, 性別集計's own normaliser, and the two cannot disagree.
// Building it caught that _stuGenderLabel never matched M / Male: normName LOWER-cases, and the
// label compared against upper case. genderpivot.test's transcription of normName left the
// lower-casing out, so it passed over the bug. This suite runs the REAL functions from Index.html.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

const HTML = fs.readFileSync(path.join(__dirname, "..", "Index.html"), "utf8");

// Brace-matches a function body, skipping strings, template literals, comments and regexes.
function extract(src, name) {
  const m = new RegExp("\\n\\s*function " + name + "\\(").exec(src);
  if (!m) return null;
  const start = m.index + 1;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n2 = src[i + 1];
    if (c === "/" && n2 === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && n2 === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === "`") {                                   // template literal, with ${ … } nesting
      let tdepth = 0;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (tdepth === 0 && src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") { tdepth++; i++; continue; }
        if (tdepth > 0 && src[i] === "}") tdepth--;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "/" && /[=(,:!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 3), i))) {
      for (i++; i < src.length && src[i] !== "/"; i++) { if (src[i] === "\\") i++; else if (src[i] === "[") { while (src[++i] !== "]") if (src[i] === "\\") i++; } }
      continue;
    }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const FNS = ["normName", "_stuGenderLabel", "_studentFilterColumns", "buildStudentFilters", "applyStudentFilters",
  "_stuFilterSpecs", "_stuPasses", "_stuAdaptFilterOptions", "fmAll", "fmSyncLabel",
  "_intakeFromStudentId", "_intakeSortKey", "escHtmlJs", "escAttrJs"];

// ---- a DOM just big enough for the bar and the table ------------------------------------------
// The bar's markup is the string buildStudentFilters writes; boxes are parsed back out of it, the
// way the browser would, so the test sees exactly the data-key / data-col it emitted.
function parseBoxes(html) {
  const boxes = [];
  const re = /<div class="filter-multi" data-key="([^"]*)"(?: data-col="([^"]*)")?>([\s\S]*?)<\/div><\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const label = (m[3].match(/<span class="filter-label">([^<]*)<\/span>/) || [])[1];
    const cbs = [];
    const cre = /<input type="checkbox" value="([^"]*)"/g;
    let c;
    while ((c = cre.exec(m[3]))) {
      const lab = { style: { display: "" } };
      cbs.push({ value: c[1], checked: false, _label: lab, closest: (sel) => (sel === "label" ? lab : null) });
    }
    const dataset = { key: m[1] };
    if (m[2] != null) dataset.col = m[2];
    const box = { dataset, label, cbs,
      querySelectorAll: (sel) => sel.indexOf(":checked") !== -1 ? cbs.filter(x => x.checked) : cbs,
      querySelector: (sel) => (sel === ".fm-btn" ? { classList: { add() {}, remove() {} } } : sel === ".fm-text" ? { innerText: "" } : null) };
    cbs.forEach(cb => { const own = cb.closest; cb.closest = (sel) => (sel === ".filter-multi" ? box : own(sel)); });
    boxes.push(box);
  }
  return boxes;
}

function load(src, data) {
  const els = {};
  const bar = { _html: "", boxes: [],
    set innerHTML(h) { this._html = h; this.boxes = parseBoxes(h); },
    get innerHTML() { return this._html; },
    querySelectorAll: (sel) => (sel === ".filter-multi" ? bar.boxes : []) };
  const rows = data.slice(1).map(r => ({ style: { display: "" }, textContent: r.join(" "), innerText: r.join(" ") }));
  const tbody = { getElementsByTagName: () => rows };
  els["filterBar-current"] = bar;
  els["searchCurrentInp"] = { value: "" };
  els["currentStudentTable"] = { getElementsByTagName: () => [tbody] };
  els["count-current"] = { innerText: "" };
  const ctx = vm.createContext({ document: { getElementById: (id) => els[id] || null }, _expScope: "view" });
  const order = (src.match(/^\s*var STU_GENDER_ORDER = [^\n]*;/m) || [""])[0];
  const code = [order].concat(FNS.map(n => { const f = extract(src, n); if (!f) throw new Error("missing " + n); return f; }))
    .join("\n") + "\nvar currentStudentsData;";
  vm.runInContext(code, ctx);
  ctx.currentStudentsData = data;
  return {
    ctx, bar, rows, els,
    build: () => ctx.buildStudentFilters("current"),
    box: (label) => bar.boxes.find(b => b.label === label),
    pick: (label, vals) => { const b = bar.boxes.find(x => x.label === label); b.cbs.forEach(c => { c.checked = vals.indexOf(c.value) !== -1; }); },
    apply: () => ctx.applyStudentFilters("current"),
    shown: () => data.slice(1).filter((r, i) => rows[i].style.display !== "none").map(r => r[0]),
    offered: (label) => bar.boxes.find(b => b.label === label).cbs.filter(c => c._label.style.display !== "none").map(c => c.value),
    all: (label, on) => ctx.fmAll({ closest: () => bar.boxes.find(b => b.label === label) }, on, "current"),
  };
}

const HEAD = ["学籍番号", "ニックネーム", "国名", "名前英語", "読み方", "クラス", "担任", "国担当", "電話番号",
  "メールアドレス", "寮", "生年月日", "年齢", "性別", "入国日", "始業日", "卒業予定", "在留期限", "学歴", "コース",
  "ビザの種類", "JLPT", "決定進路"];
const ROW = (id, cls, gender, course) => {
  const r = HEAD.map(() => "");
  r[0] = id; r[2] = "ネパール"; r[5] = cls; r[13] = gender; r[19] = course || "進学2年"; r[20] = "留学";
  return r;
};
const DATA = () => [HEAD.slice(),
  ROW("202604001", "A1", "男"),
  ROW("202604002", "A1", "男性"),
  ROW("202604003", "A2", "M"),
  ROW("202604004", "A2", "女"),
  ROW("202604005", "B10", "Female"),
  ROW("202604006", "B2", ""),
  ROW("202604007", "", "不明"),
];

console.log("1. the gender label (性別集計's normaliser)");
{
  const t = load(HTML, DATA());
  const L = t.ctx._stuGenderLabel;
  check("男 / 男性 / M / Male / male / Ｍ → 男", ["男", "男性", "M", "Male", "male", "Ｍ"].every(v => L(v) === "男"),
    JSON.stringify(["男", "男性", "M", "Male", "male", "Ｍ"].map(L)));
  check("女 / 女性 / F / Female → 女", ["女", "女性", "F", "Female"].every(v => L(v) === "女"));
  check("blank → 未記入; anything else → その他", L("") === "未記入" && L(null) === "未記入" && L("不明") === "その他");
  const old = HTML.replace("const s = normName(String(raw == null ? '' : raw)).toUpperCase();", "const s = normName(String(raw == null ? '' : raw));");
  check("  mutation: without toUpperCase, M and Male fall to その他 (the bug)",
    old !== HTML && load(old, DATA()).ctx._stuGenderLabel("M") === "その他" && load(old, DATA()).ctx._stuGenderLabel("Male") === "その他");
}

console.log("\n2. the filter bar");
{
  const t = load(HTML, DATA());
  t.build();
  const labels = t.bar.boxes.map(b => b.label);
  check("クラス and 性別 sit after コース, in bar order",
    JSON.stringify(labels) === JSON.stringify(["入学期", "国名", "コース", "クラス", "性別", "ビザの種類"]), JSON.stringify(labels));
  const cls = t.box("クラス");
  check("クラス offers each distinct class, numeric order, blanks left out",
    JSON.stringify(cls.cbs.map(c => c.value)) === JSON.stringify(["A1", "A2", "B2", "B10"]), JSON.stringify(cls.cbs.map(c => c.value)));
  check("クラス is a plain column filter (its key is the column index)", cls.dataset.key === "5" && cls.dataset.col == null);
  const g = t.box("性別");
  check("性別 offers the NORMALISED values in fixed order, 未記入 included",
    JSON.stringify(g.cbs.map(c => c.value)) === JSON.stringify(["男", "女", "その他", "未記入"]), JSON.stringify(g.cbs.map(c => c.value)));
  check("性別 is keyed 'gender' and carries its column", g.dataset.key === "gender" && g.dataset.col === "13");
  const few = load(HTML, [HEAD.slice(), ROW("202604001", "A1", "男"), ROW("202604002", "A1", "F")]);
  few.build();
  check("only values present are offered", JSON.stringify(few.box("性別").cbs.map(c => c.value)) === JSON.stringify(["男", "女"]));
  const noCol = load(HTML, [HEAD.filter(h => h !== "性別" && h !== "クラス"), ["202604001", "", "ネパール"]]);
  noCol.build();
  check("no クラス / 性別 header → no such filter, nothing breaks",
    !noCol.bar.boxes.some(b => b.label === "クラス" || b.label === "性別"));
}

console.log("\n3. filtering");
{
  const t = load(HTML, DATA());
  t.build();
  t.pick("性別", ["男"]); t.apply();
  check("性別 男 shows 男, 男性 AND M", JSON.stringify(t.shown()) === JSON.stringify(["202604001", "202604002", "202604003"]), JSON.stringify(t.shown()));
  check("the count follows", t.els["count-current"].innerText === "3 / 7 名", t.els["count-current"].innerText);
  t.pick("クラス", ["A1"]); t.apply();
  check("クラス A1 AND 性別 男", JSON.stringify(t.shown()) === JSON.stringify(["202604001", "202604002"]), JSON.stringify(t.shown()));
  t.pick("クラス", ["A2", "B10"]); t.pick("性別", ["女"]); t.apply();
  check("several values OR within a filter (A2 or B10, 女 / Female)",
    JSON.stringify(t.shown()) === JSON.stringify(["202604004", "202604005"]), JSON.stringify(t.shown()));
  t.pick("クラス", []); t.pick("性別", ["未記入"]); t.apply();
  check("未記入 finds the blank row", JSON.stringify(t.shown()) === JSON.stringify(["202604006"]), JSON.stringify(t.shown()));
  t.pick("性別", []); t.apply();
  check("nothing picked → everyone", t.shown().length === 7);

  const noDerive = HTML.replace("else if (key === 'gender') { const gc = parseInt(box.dataset.col, 10); val = function(r){ return _stuGenderLabel(r[gc]); }; }\n", "");
  const m = load(noDerive, DATA());
  m.build(); m.pick("性別", ["男"]); m.apply();
  check("  mutation: without the 'gender' branch, 性別 matches nothing (parseInt('gender') is NaN)",
    noDerive !== HTML && m.shown().length === 0, JSON.stringify(m.shown()));
  const raw = HTML.replace("val = function(r){ return _stuGenderLabel(r[gc]); };", "val = function(r){ return String(r[gc] || \"\").trim(); };");
  const r = load(raw, DATA());
  r.build(); r.pick("性別", ["男"]); r.apply();
  check("  mutation: comparing raw cells, 男 misses 男性 and M", raw !== HTML && JSON.stringify(r.shown()) === JSON.stringify(["202604001"]), JSON.stringify(r.shown()));
  const noWant = HTML.replace("{ key: 'cls', labels: ['クラス'] },", "");
  const w = load(noWant, DATA());
  w.build();
  check("  mutation: without the want entry there is no クラス filter", noWant !== HTML && !w.box("クラス"));
}

console.log("\n4. adaptive: each filter offers what the OTHER filters leave");
{
  // A1: 男 男性 | A2: M 女 | B10: Female | B2: blank | no class: 不明
  const t = load(HTML, DATA());
  t.build(); t.apply();
  check("nothing picked → every value is offered",
    JSON.stringify(t.offered("クラス")) === JSON.stringify(["A1", "A2", "B2", "B10"]) &&
    JSON.stringify(t.offered("性別")) === JSON.stringify(["男", "女", "その他", "未記入"]), JSON.stringify([t.offered("クラス"), t.offered("性別")]));
  t.pick("性別", ["女"]); t.apply();
  check("性別 女 → クラス offers only the classes that hold a 女 (A2, B10)",
    JSON.stringify(t.offered("クラス")) === JSON.stringify(["A2", "B10"]), JSON.stringify(t.offered("クラス")));
  check("...but 性別 still offers all its values (never narrowed by its own pick)",
    JSON.stringify(t.offered("性別")) === JSON.stringify(["男", "女", "その他", "未記入"]), JSON.stringify(t.offered("性別")));
  t.pick("クラス", ["A2"]); t.apply();
  check("クラス A2 → 性別 offers A2's 男 and 女 only", JSON.stringify(t.offered("性別")) === JSON.stringify(["男", "女"]), JSON.stringify(t.offered("性別")));
  t.pick("性別", ["男"]); t.apply();
  check("switching 女 → 男 works in place", JSON.stringify(t.shown()) === JSON.stringify(["202604003"]), JSON.stringify(t.shown()));
  t.pick("性別", ["その他"]); t.apply();
  check("a ticked value stays offered even when nothing else would offer it",
    t.offered("性別").indexOf("その他") !== -1 && t.shown().length === 0, JSON.stringify(t.offered("性別")));
  t.pick("性別", []); t.pick("クラス", []);
  t.els["searchCurrentInp"].value = "202604001"; t.apply();
  check("the search box never narrows the lists", t.offered("クラス").length === 4 && t.shown().length === 1);
  t.els["searchCurrentInp"].value = "";

  t.pick("性別", ["女"]); t.apply();
  t.all("クラス", true);
  check("全選択 ticks only the offered classes (A2, B10)",
    JSON.stringify(t.box("クラス").cbs.filter(c => c.checked).map(c => c.value)) === JSON.stringify(["A2", "B10"]),
    JSON.stringify(t.box("クラス").cbs.filter(c => c.checked).map(c => c.value)));
  t.all("クラス", false);
  check("全解除 clears them", t.box("クラス").cbs.every(c => !c.checked));

  const self = HTML.replace("if (f === skip || !f.set) continue;", "if (!f.set) continue;");
  const m = load(self, DATA());
  m.build(); m.pick("性別", ["女"]); m.apply();
  check("  mutation: without `skip`, a filter narrows its own list (女 hides 男)",
    self !== HTML && JSON.stringify(m.offered("性別")) === JSON.stringify(["女"]), JSON.stringify(m.offered("性別")));
  const noAdapt = HTML.replace("        _stuAdaptFilterOptions(specs, dataArray);\n", "");
  const n = load(noAdapt, DATA());
  n.build(); n.pick("性別", ["女"]); n.apply();
  check("  mutation: without the adapt call, every class is still offered", noAdapt !== HTML && n.offered("クラス").length === 4);
  const sel = HTML.replace("if (!checked || !lab || lab.style.display !== 'none') cb.checked = checked;", "cb.checked = checked;");
  const q = load(sel, DATA());
  q.build(); q.pick("性別", ["女"]); q.apply(); q.all("クラス", true);
  check("  mutation: an unguarded 全選択 ticks hidden classes too",
    sel !== HTML && q.box("クラス").cbs.filter(c => c.checked).length === 4);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
