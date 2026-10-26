// 学生一覧 → 入学予定者 retouch (2026-10-01): the app's theme, nothing new.
//
// Tonal secondaries with ONE solid primary (出力), the pencil 編集 that goes icon-only on a
// phone, and a compact row select. Every guard also runs against the PREVIOUS commit's markup and
// must fail there — a guard that passes on both is worth nothing.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execSync } = require("child_process");

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "Index.html"), "utf8");
// The shape before the retouch, for the mutation half of every guard.
let OLD = "";
try { OLD = execSync("git show 369d48e:Index.html", { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
catch (e) { OLD = ""; }

const STYLE = (h) => (h.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1];
const DESK = (h) => { const s = STYLE(h); const m = s.indexOf("@media (max-width: 820px)"); return m < 0 ? s : s.slice(0, m); };
const CLIENT = (h) => (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || "";
const VIEW = (h) => (h.match(/<div id="sub-view-incoming"[\s\S]*?\n        <\/div>\n        <div id="sub-view-dest"/) || [""])[0];

function guard(name, fn) {
  const now = fn(HTML), before = OLD ? fn(OLD) : null;
  check(name, now === true, "");
  if (OLD) check("  mutation: the pre-retouch markup fails it", before === false, "it passed on the old shape too");
}

console.log("1. one solid primary: everything else is tonal");
guard("入学予定者's buttons SHARE 進路's tonal rule (selector list, not a copy)", (h) =>
  /#sub-view-dest \.schedule-btn, #sub-view-incoming \.schedule-btn \{[^}]*background: var\(--report-header-bg\)/.test(DESK(h))
  && /#sub-view-incoming \.schedule-btn:hover:not\(:disabled\) \{ background: var\(--primary-color\)/.test(DESK(h)));
check("...and declares no tonal background of its own (that would be a second copy)",
  !/#sub-view-incoming \.schedule-btn \{/.test(DESK(HTML).replace(/#sub-view-dest \.schedule-btn, #sub-view-incoming \.schedule-btn \{/, "")));
check("出力 stays the one solid: the view has exactly one .export-btn", (VIEW(HTML).match(/class="export-btn"/g) || []).length === 1);
// ⚠️ A real defect, found by measuring: without a view-scoped rule the 出力 button kept .export-btn's
// white text on the browser's grey default — unreadable on desktop.
guard("⚠️ 出力 is actually painted primary on desktop (shares 進路's export rule)", (h) =>
  /#sub-view-dest \.export-btn, #sub-view-incoming \.export-btn \{ background: var\(--primary-color\)/.test(DESK(h)));


console.log("\n2. no tiles (decided 2026-10-01: the 入学期 select is the filter)");
// The tiles were built twice (statuses, then intakes) and then dropped. ⚠️ They had joined ホーム's
// shared tile rules by selector list; removing them must leave those lists exactly as before.
check("no tile markup, code or CSS remains", !/inc-stat|incStats|incSetIntake|incSetFilter|INC_TILES/.test(HTML));
check("ホーム / 学生数's shared tile rules are back to their own selector lists",
  /#view-home \.home-stats, #sub-view-report \.rep-stats \{ display: grid;/.test(DESK(HTML))
  && /#view-home \.home-stat, #sub-view-report \.rep-stat \{/.test(DESK(HTML)));
check("the count line keeps the total and the hidden note",
  /cnt\.textContent = shown\.length \+ '名' \+ \(hidden \? '　入学済みのため非表示：'/.test(CLIENT(HTML)));
check("the 入学期 select still uses the one ordering", /const list = incIntakeList\(\)\.filter\(/.test(CLIENT(HTML)));

console.log("\n3. 編集: the pencil, icon-only on a phone like 面接結果");
guard("編集 carries btn-ico + btn-label", (h) =>
  /onclick="incEdit\(' \+ i \+ '\)"><svg class="btn-ico"[^>]*>[\s\S]*?<\/svg><span class="btn-label">編集<\/span><\/button>/.test(CLIENT(h)));
check("...the same pencil path 面接結果 uses", (() => {
  const p = 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174';
  return CLIENT(HTML).split(p).length - 1 >= 2;
})());

console.log("\n4. the row select is compact and labelled");
guard("compact padding on the row's 状態 select", (h) =>
  /#sub-view-incoming \.inc-ops \.inc-sel \{[^}]*padding: 3px 6px/.test(DESK(h)));
check("...and it keeps its aria-label", /aria-label="状態" onchange="incSetState\(/.test(CLIENT(HTML)));

console.log("\n4b. the search box sits level with its toolbar");
// Measured: the global .search-box's 20px bottom margin made the row centre a 60px block, 15px above
// the 31px selects; on a phone the same gap moved to .search-wrap and left 28px under the box.
guard("desktop: margin zeroed and the box 31px, with vertical padding only (never the shorthand)", (h) =>
  /#sub-view-incoming \.inc-bar \.search-box \{ margin-bottom: 0; height: 31px; padding-top: 0; padding-bottom: 0; \}/.test(DESK(h)));
check("⚠️ that rule never sets padding-left or font-size (the phone's icon padding and 16px text must survive)",
  !/#sub-view-incoming \.inc-bar \.search-box \{[^}]*(padding:|padding-left|font-size)/.test(DESK(HTML)));
guard("phone: the wrapper's margin is zeroed and the box takes the full row", (h) => {
  const st = STYLE(h), m = st.indexOf("@media (max-width: 820px)");
  return m > -1 && /#sub-view-incoming \.inc-bar \.search-wrap \{ margin-bottom: 0; flex: 1 1 100%; \}/.test(st.slice(m));
});

console.log("\n5. nothing outside the theme");
{
  const own = DESK(HTML).split("\n").filter((l) => /#sub-view-incoming/.test(l)).join("\n");
  check("no !important in this view's desktop rules", own.indexOf("!important") === -1);
  check("radii come from the scale", !/border-radius:\s*\d/.test(own));
  check("font-family still appears exactly once", (STYLE(HTML).replace(/\/\*[\s\S]*?\*\//g, "").match(/font-family\s*:/g) || []).length === 1);
}

console.log("\n6. 国籍 / 課程 / 担当 filters and header sort (2026-10-05)");
{
  const C = CLIENT(HTML);
  const fnSrc = (src, n) => { const i = src.indexOf("function " + n + "("); if (i < 0) throw new Error("missing " + n);
    let j = src.indexOf("{", i), d = 0; for (; j < src.length; j++) { const c = src[j];
      if (c === "'" || c === '"' || c === "`") { for (j++; j < src.length && src[j] !== c; j++) if (src[j] === "\\") j++; continue; }
      if (c === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j); continue; }
      if (c === "{") d++; if (c === "}" && --d === 0) return src.slice(i, j + 1); } };
  const constOf = (src, n) => ((src.match(new RegExp("const " + n + " = (\\[|\\{)[\\s\\S]*?(\\]|\\});")) || [""])[0]).replace(/^const /, "var ");
  function sandbox(src) {
    // A fake <select> that behaves like a real one where it matters: its options come from its
    // innerHTML, and assigning a value it has no option for leaves it EMPTY.
    const els = {};
    const el = (id) => {
      if (els[id]) return els[id];
      let html = "", val = "", options = [];
      return (els[id] = {
        id,
        get innerHTML() { return html; },
        set innerHTML(h) { html = h; options = (h.match(/value="([^"]*)"/g) || []).map((v) => ({ value: v.slice(7, -1) }));
          if (!options.some((o) => o.value === val)) val = options.length ? options[0].value : ""; },
        get options() { return options; },
        get value() { return val; },
        set value(v) { val = (!html || options.some((o) => o.value === v)) ? v : ""; },
      });
    };
    const ctx = vm.createContext({
      document: { getElementById: (id) => el(id) },
      escHtmlJs: (v) => String(v), escAttrJs: (v) => String(v), incRender: () => {},
    });
    vm.runInContext(["ACCENT_MAP", "INC_FACETS", "INC_SORT_COLS", "INC_STATE_ORDER", "INC_STATE_LABELS"].map((n) => constOf(src, n)).join("\n") + "\n"
      + ["normName", "_foldAccents", "incCol", "incCell", "incState", "incStateLabel", "incFilterSpec", "incPasses", "incVisible",
         "incSortIdx", "incSort", "_intakeSortKey", "_visaDays", "_tableSortKey", "incIntakeKey", "incIntakeList", "incFillIntakes",
         "incRefreshFilters", "incShowIntake", "incClearFilters", "incExportRows"].map((n) => fnSrc(src, n)).join("\n")
      + "\nvar incData = null; var _incSort = { col: -1, asc: true }; function formatDateDisplay(s){ return s; }", ctx);
    const H = ["Timestamp", "入学期", "課程", "国籍", "名前", "性別", "担当", "備考"];
    ctx.incData = { headers: H, meta: [{}, { planned: true }, { decided: "不交付" }, { applied: true }, { visa: true }],
      rows: [["t0", "2026年10月生", "進学2年", "ネパール", "A ONE", "男", "営業 花子", ""],
             ["t1", "2026年4月生", "進学1年6か月", "ネパール　", "B TWO", "女", "営業 次郎", ""],
             ["t2", "2027年4月生", "進学2年", "ベトナム", "C THREE", "男", "営業 花子", ""],
             ["t3", "2026年10月生", "就職2年", "ﾐｬﾝﾏｰ", "D FOUR", "女", "", ""],
             ["t4", "2026年4月生", "進学2年", "ベトナム", "E FIVE", "男", "営業　花子", ""]] };
    const fill = () => ctx.incRefreshFilters();
    return { ctx, el, fill, names: () => ctx.incVisible().map((i) => ctx.incData.rows[i][4]) };
  }

  const t = sandbox(C);
  t.fill();
  const labels = (id) => (t.el(id).innerHTML.match(/>([^<]*)<\/option>/g) || []).map((x) => x.slice(1, -9));
  check("国籍 options are distinct by normName (ネパール = ネパール＋全角空白) and blank-free",
    JSON.stringify(labels("incNatSel")) === JSON.stringify(["すべての国籍", "ネパール", "ベトナム", "ﾐｬﾝﾏｰ"]), JSON.stringify(labels("incNatSel")));
  check("担当 has no option for a blank value, and 営業　花子 (inner 全角空白) is the same 担当",
    labels("incTantoSel").length === 3, JSON.stringify(labels("incTantoSel")));
  t.el("incNatSel").value = t.ctx.normName("ネパール");
  check("国籍 filter matches across the full-width space", JSON.stringify(t.names()) === JSON.stringify(["A ONE", "B TWO"]), JSON.stringify(t.names()));
  t.el("incCourseSel").value = t.ctx.normName("進学2年");
  check("filters AND together (国籍 + 課程)", JSON.stringify(t.names()) === JSON.stringify(["A ONE"]), JSON.stringify(t.names()));
  t.el("incNatSel").value = ""; t.el("incCourseSel").value = ""; t.el("incTantoSel").value = t.ctx.normName("営業 花子");
  t.el("incIntakeSel").value = "2026年10月生";
  check("...and with 入学期", JSON.stringify(t.names()) === JSON.stringify(["A ONE"]), JSON.stringify(t.names()));
  t.el("incIntakeSel").value = "__all";
  t.fill();
  check("a choice still on offer survives 再読み込み", t.el("incTantoSel").value === t.ctx.normName("営業 花子"));
  t.el("incTantoSel").value = t.ctx.normName("営業 次郎");
  t.ctx.incData.rows.splice(1, 1); t.ctx.incData.meta.splice(1, 1);   // 再読み込み: 営業 次郎's only row is gone
  t.fill();
  check("a choice gone from the reloaded list falls back to すべて", t.el("incTantoSel").value === "", t.el("incTantoSel").value);

  const s = sandbox(C); s.fill();
  s.ctx.incSort(0);
  check("入学期 sorts by DATE: 2026年4月 before 2026年10月 before 2027年4月",
    JSON.stringify(s.names()) === JSON.stringify(["B TWO", "E FIVE", "A ONE", "D FOUR", "C THREE"]), JSON.stringify(s.names()));
  s.ctx.incSort(0);
  check("a second click reverses (ties keep load order)", JSON.stringify(s.names()) === JSON.stringify(["C THREE", "A ONE", "D FOUR", "B TWO", "E FIVE"]), JSON.stringify(s.names()));
  s.ctx.incSort(6);
  check("状態 sorts in the order a student moves through",
    JSON.stringify(s.names()) === JSON.stringify(["A ONE", "D FOUR", "B TWO", "E FIVE", "C THREE"]), JSON.stringify(s.names()));
  check("⚠️ incData.rows is never reordered (meta stays aligned)", s.ctx.incData.rows[0][4] === "A ONE" && s.ctx.incData.rows[4][4] === "E FIVE");
  check("出力 follows the screen order", JSON.stringify(s.ctx.incExportRows().slice(1).map((r) => r[5])) === JSON.stringify(s.names()));

  const textSort = C.replace("return c === 0 ? _intakeSortKey(v) : _tableSortKey(v);", "return _tableSortKey(v);");
  const m = sandbox(textSort); m.fill(); m.ctx.incSort(0);
  check("  mutation: a plain text compare puts 2026年10月 before 2026年4月", textSort !== C && m.names()[0] === "A ONE");
  const notNorm = C.replace("if (!off(f.id) && f.want !== '' && normName(incCell(r, f.cols)) !== f.want) return false;",
                            "if (!off(f.id) && f.want !== '' && incCell(r, f.cols).trim() !== f.want) return false;");
  const n = sandbox(notNorm); n.fill(); n.el("incTantoSel").value = n.ctx.normName("営業 花子");
  const ok = sandbox(C); ok.fill(); ok.el("incTantoSel").value = ok.ctx.normName("営業 花子");
  check("担当 filter keeps 営業　花子 (inner full-width space)", ok.names().indexOf("E FIVE") !== -1, JSON.stringify(ok.names()));
  check("  mutation: comparing raw text loses the 営業　花子 row", notNorm !== C && n.names().indexOf("E FIVE") === -1);

  // Adaptive: each select offers only what the OTHER filters leave.
  const a = sandbox(C); a.fill();
  const offered = (id) => a.el(id).options.map((o) => o.value).filter((v) => v !== "" && v !== "__all");
  a.el("incNatSel").value = a.ctx.normName("ベトナム"); a.fill();
  check("国籍 ベトナム → 担当 offers only ベトナム students' 担当", JSON.stringify(offered("incTantoSel")) === JSON.stringify([a.ctx.normName("営業 花子")]), JSON.stringify(offered("incTantoSel")));
  check("...課程 only theirs, 入学期 only their intakes",
    JSON.stringify(offered("incCourseSel")) === JSON.stringify([a.ctx.normName("進学2年")]) &&
    JSON.stringify(offered("incIntakeSel")) === JSON.stringify(["2027年4月生", "2026年4月生"]), JSON.stringify([offered("incCourseSel"), offered("incIntakeSel")]));
  check("...状態 only the states they hold, in the fixed order", JSON.stringify(offered("incStateSel")) === JSON.stringify(["notissued", "visa"].sort((x, y) => ["active", "applied", "planned", "visa", "notissued", "cancel", "check"].indexOf(x) - ["active", "applied", "planned", "visa", "notissued", "cancel", "check"].indexOf(y))), JSON.stringify(offered("incStateSel")));
  check("⚠️ its OWN list is not narrowed: 国籍 still offers ネパール (switch in place)", offered("incNatSel").length === 3);
  const every = ["incIntakeSel", "incStateSel", "incNatSel", "incCourseSel", "incTantoSel"].every((id) => offered(id).every((v) => {
    const keep = a.el(id).value; a.el(id).value = v; const n = a.ctx.incVisible().length; a.el(id).value = keep; return n > 0; }));
  check("every offered value, picked, shows at least one row", every);
  a.el("incTantoSel").value = a.ctx.normName("営業 花子"); a.fill();
  a.el("incNatSel").value = a.ctx.normName("ﾐｬﾝﾏｰ"); a.fill();   // no row is both
  check("a current choice is KEPT even when another filter leaves it no rows (it never jumps)",
    a.el("incTantoSel").value === a.ctx.normName("営業 花子") && offered("incTantoSel").indexOf(a.ctx.normName("営業 花子")) !== -1);
  a.el("incNatSel").value = ""; a.el("incTantoSel").value = ""; a.fill();
  check("back to すべて → everything returns", offered("incTantoSel").length === 2 && offered("incIntakeSel").length === 3);
  a.el("incSearchInp").value = "A ONE"; a.fill();
  check("the name search narrows the table, never the options", a.ctx.incVisible().length === 1 && offered("incNatSel").length === 3);
  a.el("incSearchInp").value = "";

  const allRows = C.replace("for (let i = 0; i < incData.rows.length; i++) if (incPasses(i, spec, [skip, 'search'])) out.push(i);",
                            "for (let i = 0; i < incData.rows.length; i++) out.push(i);");
  const m1 = sandbox(allRows); m1.fill(); m1.el("incNatSel").value = m1.ctx.normName("ベトナム"); m1.fill();
  check("  mutation: options from ALL rows offer a 担当 with no ベトナム student",
    allRows !== C && m1.el("incTantoSel").options.some((o) => o.value === m1.ctx.normName("営業 次郎")));
  const ownToo = C.replace("if (incPasses(i, spec, [skip, 'search'])) out.push(i);", "if (incPasses(i, spec, ['search'])) out.push(i);");
  const m2 = sandbox(ownToo); m2.fill(); m2.el("incNatSel").value = m2.ctx.normName("ベトナム"); m2.fill();
  check("  mutation: narrowing a select by its own choice leaves 国籍 unable to switch",
    ownToo !== C && m2.el("incNatSel").options.filter((o) => o.value !== "").length === 1);
  const withSearch = C.replace("if (incPasses(i, spec, [skip, 'search'])) out.push(i);", "if (incPasses(i, spec, [skip])) out.push(i);");
  const m3 = sandbox(withSearch); m3.fill(); m3.el("incSearchInp").value = "A ONE"; m3.fill();
  check("  mutation: letting the search narrow the options shrinks them while typing",
    withSearch !== C && m3.el("incNatSel").options.filter((o) => o.value !== "").length === 1);

  // 表示 (the 結果日 banner) under adaptive lists: a plain assignment would be ignored when another
  // filter hides that intake, so it clears the others first.
  const b = sandbox(C); b.fill();
  b.el("incNatSel").value = b.ctx.normName("ﾐｬﾝﾏｰ"); b.fill();      // ﾐｬﾝﾏｰ has no 2026年4月生
  check("(the filter does hide that intake)", !b.el("incIntakeSel").options.some((o) => o.value === "2026年4月生"));
  b.ctx.incShowIntake("2026年4月生");
  check("表示 still lands on its intake and 入学予定 when a filter had hidden that intake",
    b.el("incIntakeSel").value === "2026年4月生" && b.el("incStateSel").value === "planned" && b.el("incNatSel").value === "", JSON.stringify([b.el("incIntakeSel").value, b.el("incStateSel").value]));
  const naive = C.replace(/function incShowIntake\(it\) \{[\s\S]*?\n      \}/, "function incShowIntake(it) { document.getElementById('incIntakeSel').value = it; document.getElementById('incStateSel').value = 'planned'; incRender(); }");
  const nb = sandbox(naive); nb.fill(); nb.el("incNatSel").value = nb.ctx.normName("ﾐｬﾝﾏｰ"); nb.fill(); nb.ctx.incShowIntake("2026年4月生");
  check("  mutation: plain assignments are silently ignored under a hiding filter", naive !== C && nb.el("incIntakeSel").value !== "2026年4月生");

  // フィルタ解除
  const z = sandbox(C); z.fill();
  z.el("incSearchInp").value = "A"; z.el("incIntakeSel").value = "2026年10月生"; z.fill();
  z.el("incNatSel").value = z.ctx.normName("ネパール"); z.el("incTantoSel").value = z.ctx.normName("営業 花子"); z.fill();
  z.ctx.incSort(3);
  z.ctx.incClearFilters(); z.fill();
  check("フィルタ解除 resets search, 入学期, 状態 and the three facets; every row is back",
    z.el("incSearchInp").value === "" && z.el("incIntakeSel").value === "__all" && z.el("incStateSel").value === "" &&
    ["incNatSel", "incCourseSel", "incTantoSel"].every((id) => z.el(id).value === "") && z.ctx.incVisible().length === 5);
  check("...and keeps the header sort (an order, not a filter)", z.ctx._incSort.col === 3);
  const forgot = C.replace("INC_FACETS.forEach(function (f) { set(f.id, ''); });", "");
  const zf = sandbox(forgot); zf.fill(); zf.el("incNatSel").value = zf.ctx.normName("ネパール"); zf.fill(); zf.ctx.incClearFilters();
  check("  mutation: forgetting the facets leaves 国籍 set", forgot !== C && zf.el("incNatSel").value !== "");
  const bar0 = (HTML.match(/<div class="inc-bar">[\s\S]*?\n          <\/div>/) || [""])[0];
  check("the button sits in the toolbar before 再読み込み, tonal, with icon + label",
    /<button id="incClearBtn" class="schedule-btn" onclick="incClearFilters\(\)"[^>]*><svg class="btn-ico"[\s\S]*?<span class="btn-label">フィルタ解除<\/span><\/button>\s*<button class="schedule-btn" onclick="incLoad\(true\)">/.test(bar0));

  const st = STYLE(HTML), mq = st.indexOf("@media (max-width: 820px)");
  check("入学期 is capped on desktop (its dated options made the bar wrap past 出力) and full width on a phone",
    /#sub-view-incoming #incIntakeSel \{ max-width: 240px; \}/.test(DESK(HTML)) && /#sub-view-incoming #incIntakeSel \{ max-width: 100% !important; \}/.test(st.slice(mq)));

  const bar = (HTML.match(/<div class="inc-bar">[\s\S]*?\n          <\/div>/) || [""])[0];
  check("the three selects sit in the bar, refiltering on change",
    ["incNatSel", "incCourseSel", "incTantoSel"].every((id) => new RegExp('<select id="' + id + '" class="form-control inc-sel" onchange="incRender\\(\\)"').test(bar)));
  check("headers carry incSort, with 状態 as 6", /onclick="incSort\(' \+ ci \+ '\)"/.test(C) && /onclick="incSort\(6\)">状態/.test(C));
  check("_incSort is declared beside incData (rule 3)", C.indexOf("var _incSort = { col: -1, asc: true };") > -1 && C.indexOf("var _incSort") < C.indexOf("function incVisible("));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
