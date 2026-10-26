// 募集シミュレーション: the retouch into the app's palette (2026-09-16) — the last 学生一覧 sub-tab.
// Same grid, same columns, same totals; the data path is untouched.
//
// Measured before (driver eval, 1440px): FOUR button colours in one row — rgb(113,128,150) (the
// DISABLED ＋入学期を追加, a real state), rgb(90,103,216) (the base solid ＋国を追加), rgb(56,161,105)
// (出力, inline --success-color) and rgb(90,103,216) again (保存, inline --primary-color). And
// simRenderGrid wrote the table as a string with ~20 inline style attributes, which is why no finish
// pass had ever reached this screen: an inline style outranks every stylesheet rule.
//
// ⚠️ Each guard is also run against the OLD shape and must fail there.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function swap(src, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error('mutation anchor found ' + n + ' times: ' + from.slice(0, 70));
  return src.replace(from, to);
}
function guard(name, pred, from, to, why) {
  let old;
  try { old = pred(swap(HTML, from, to)); } catch (e) { old = 'mutation failed: ' + e.message; }
  check(name, pred(HTML) === true, why || '');
  check("  mutation: the old shape fails it", old === false, String(old));
}
const style = function (h) { return h.slice(h.indexOf('<style>'), h.indexOf('</style>')); };
const desk = function (h) { const st = style(h); return st.slice(0, st.indexOf('@media (max-width: 820px)')); };
const block = function (h) { const d = desk(h); const i = d.indexOf('/* シミュレーション retouch'); return i < 0 ? '' : d.slice(i, d.indexOf('/* end シミュレーション retouch */', i)); };
const view = function (h) { const a = h.indexOf('<div id="sub-view-simulation"'); return a < 0 ? '' : h.slice(a, h.indexOf('<div id="sub-view-recruit"', a)); };
const js = function (h) { return (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || ''; };
const fn = function (h, name) { const s = js(h); const i = s.indexOf('      function ' + name + '('); return i < 0 ? '' : s.slice(i, s.indexOf('\n      }\n', i) + 8); };
const ACCENT = /(background(-color)?|color):\s*(#(f6c23e|36b9cc|4e73df|1cc88a|e74a3b)|var\(--success-color\)|white)/i;

console.log("\n1. one palette: nothing coloured inline is left");
{
  // ⚠️ The mutation restores the ACTUAL old shape — 出力's inline green. Re-adding an inline
  // PRIMARY instead would not fail this guard (it is the app's own colour), so the mutation would
  // pass against both shapes and prove nothing.
  guard("no button in the シミュレーション markup carries an inline colour",
    function (h) { const b = view(h).match(/<button[^>]*>/g) || []; return b.length >= 4 && !b.some(function (t) { return ACCENT.test(t); }); },
    '<button class="export-btn" onclick="expToggle(event)"><svg class="btn-ico" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6',
    '<button class="export-btn" style="background-color:var(--success-color); color:white;" onclick="expToggle(event)"><svg class="btn-ico" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6');
  check("...and the 出力 button lost its green too",
    !/background-color:var\(--success-color\)/.test(view(HTML)), "");
  check("the grid renderer builds no inline style at all",
    fn(HTML, 'simRenderGrid').length > 2000 && fn(HTML, 'simRenderGrid').indexOf('style=') === -1,
    "~20 inline styles are why the finish layer never reached this screen");
}

console.log("\n2. tonal secondaries, ONE solid primary");
{
  guard("the retouch block exists in the DESKTOP stylesheet",
    function (h) { return block(h).length > 400; },
    '/* シミュレーション retouch', '/* シミュレーション re-touch');
  const b = block(HTML);
  // ⚠️ 保存 and 出力 are both .export-btn: the tonal rule must name the .exp-wrap one only.
  check("＋追加 and 出力 are tonal, and 出力 is reached through .exp-wrap",
    /#sub-view-simulation \.schedule-btn,\s*\n\s*#sub-view-simulation \.exp-wrap \.export-btn \{[^}]*background: var\(--report-header-bg\)/.test(b), b.slice(0, 400));
  check("保存 is the one solid primary — it is the only control that writes",
    /#sub-view-simulation #btnSimSave \{[^}]*background: var\(--primary-color\)/.test(b), "");
  guard("⚠️ a disabled ＋入学期を追加 reads as OFF, not as a different kind of button",
    function (h) { return /#sub-view-simulation \.schedule-btn:disabled \{[^}]*opacity: 0\.45/.test(block(h)); },
    '#sub-view-simulation .schedule-btn:disabled {\n        background: var(--report-header-bg); color: var(--table-header-text);\n        opacity: 0.45;',
    '#sub-view-simulation .schedule-btn:disabled {\n        background: var(--report-header-bg); color: var(--table-header-text);\n        opacity: 1;');
  guard("no !important in the block (the mobile rules must keep winning on a phone)",
    function (h) { const x = block(h).replace(/\/\*[\s\S]*?\*\//g, ''); return x.length > 0 && x.indexOf('!important') === -1; },
    '#sub-view-simulation #btnSimSave:hover { filter: brightness(0.9); }',
    '#sub-view-simulation #btnSimSave:hover { filter: brightness(0.9) !important; }');
  check("...and no bare transition duration (it means `all`)", !/transition:\s*[0-9.]+m?s/.test(b), "");
}

console.log("\n3. the grid: tokens, tabular figures, and a focus ring");
{
  const b = block(HTML);
  check("figures are tabular, as in 募集状況 and 学生数", /\.sim-grid \{ font-variant-numeric: tabular-nums; \}/.test(b), "");
  check("the projection input uses the radius token, not a hardcoded 4px",
    /\.sim-num \{[^}]*border-radius: var\(--r-sm\)/.test(b) && !/border-radius: 4px/.test(b), "");
  // ⚠️ The .fy-block idiom: the raw rgba must stay IN FRONT of --ring for a browser with no
  // color-mix. Losing it is a silent regression there, not a visible one here.
  guard("⚠️ the focus ring keeps its pre-color-mix fallback",
    function (h) { return /\.sim-num:focus \{[^}]*box-shadow: 0 0 0 2px rgba\(78,115,223,0\.25\); box-shadow: var\(--ring\)/.test(block(h)); },
    // ⚠️ Anchored on .sim-num's own rule: .fy-block input:focus carries the identical declaration,
    // so the bare text matches twice and the mutation is refused.
    '.sim-num:focus { border-color: var(--primary-color); box-shadow: 0 0 0 2px rgba(78,115,223,0.25);',
    '.sim-num:focus { border-color: var(--primary-color);');
  check("the 総数 column and 合計 row keep the app's own total token",
    /\.sim-grid \.sim-total \{ background-color: var\(--total-row-bg\); \}/.test(b)
      && /\.sim-grid tr\.sim-total-row \{[^}]*background-color: var\(--total-row-bg\)/.test(b), "");
}

console.log("\n4. ✕ is a button, and it reuses the existing component");
{
  guard("⚠️ the per-intake ✕ is a <button> with a keyboard path, not a <span onclick>",
    function (h) { const f = fn(h, 'simRenderGrid'); return /<button type="button" class="sx-btn sx-del" onclick="simRemoveIntake\(/.test(f) && !/<span[^>]*onclick="simRemoveIntake/.test(f); },
    '<button type="button" class="sx-btn sx-del" onclick="simRemoveIntake(',
    '<span style="cursor:pointer; color:#e74a3b;" onclick="simRemoveIntake(');
  check("...and it still says what it does", /title="この入学期を非表示"/.test(fn(HTML, 'simRenderGrid')), "");
  // ⚠️ ONE component in three scopes. A copied rule is what drifts.
  guard("シミュレーション joins the existing .sx-btn scope list rather than copying it",
    function (h) { return /#view-dorms \.sx-btn, #schedPhraseModal \.sx-btn, #sub-view-simulation \.sx-btn \{/.test(desk(h)); },
    '#view-dorms .sx-btn, #schedPhraseModal .sx-btn, #sub-view-simulation .sx-btn {',
    '#view-dorms .sx-btn, #schedPhraseModal .sx-btn {');
  check("the danger colour comes from the token, never a hex",
    !/#e74a3b/.test(fn(HTML, 'simRenderGrid')), "");
}

console.log("\n5. states");
{
  guard("⚠️ no student data says so, instead of headers over an empty body",
    function (h) { const f = fn(h, 'simRenderGrid'); return /if \(!simState\.countries\.length\)/.test(f) && /class="home-empty">学生データがありません。/.test(f); },
    'if (!simState.countries.length) {', 'if (false) {');
  check("the loading line and the note are classes now",
    /<p id="simLoading" class="sim-loading"/.test(view(HTML)) && /<p class="sim-note">/.test(view(HTML)), "");
}

console.log("\n6. ⚠️ the data path is untouched — what the other suites pin");
{
  // These belong to xss.test and exportmenu.test. Asserted here too, because THIS is the change
  // that rewrote the renderer: a later tidy-up must not quietly take them out.
  const f = fn(HTML, 'simRenderGrid');
  check("the country cell keeps sticky-col + escHtmlJs(country) (xss §3)",
    /sticky-col[^`]*\$\{escHtmlJs\(country\)\}/.test(f), "");
  check("every projection cell still calls simUpdateCell with escaped args",
    /onchange="simUpdateCell\('\$\{escAttrJsStr\(country\)\}','\$\{escAttrJsStr\(intake\)\}','\$\{escAttrJsStr\(co\)\}', this\.value\)"/.test(f), "");
  check("⚠️ the export still reads simState, not the DOM (exportmenu §2)",
    /sub: 'simulation'[\s\S]{0,400}?rows: function/.test(js(HTML)) && /function simExportRows\(/.test(js(HTML)),
    "an <input> value is not in innerText — a table-only entry exports blank projections");
  check("...and the header merges survive", /sub: 'simulation'[\s\S]{0,400}?merges: function/.test(js(HTML)), "");
}

console.log("\n7. the totals are summed in ONE place (C6, 2026-09-28)");
{
  // simRenderGrid and simRecalcTotals each summed the same numbers — per-country 総数, the real group
  // columns, each added intake's courses and 小計, the grand total. Now simComputeTotals does, and both
  // read it. Run the REAL function in a vm on a fixture where every total is known by hand.
  const vm = require('vm');
  function totals(h) {
    const ctx = vm.createContext({});
    vm.runInContext('var simState = ' + JSON.stringify({
      countries: ['ネパール', 'ベトナム'],
      countryTotals: { 'ネパール': 10, 'ベトナム': 4 },
      baseGroups: ['G1', 'G2'],
      realGrouped: { 'ネパール': { G1: 6, G2: 4 }, 'ベトナム': { G2: 4 } },
      addedIntakes: ['2027年4月生', '2027年10月生', '消えた入学期'],
      structure: [{ intake: '2027年4月生', courses: ['A', 'B'] }, { intake: '2027年10月生', courses: ['A'] }],
      proj: { 'ネパール||2027年4月生||A': 3, 'ネパール||2027年4月生||B': '2', 'ベトナム||2027年10月生||A': 5 }
    }) + ';', ctx);
    ['simProjGet', 'simRealGroup', 'simStructFor', 'simProjTotalForCountry', 'simComputeTotals'].forEach(function (n) {
      const src = fn(h, n);
      if (!src) throw new Error('not found: ' + n);
      vm.runInContext(src, ctx);
    });
    return JSON.parse(JSON.stringify(ctx.simComputeTotals()));
  }
  const T = totals(HTML);
  check("総数 per country is 実 + every projection (10+3+2, 4+5)",
    T.perCountry['ネパール'].grand === 15 && T.perCountry['ベトナム'].grand === 9, JSON.stringify(T.perCountry));
  check("each intake's 小計 per country, null for an intake with no structure",
    JSON.stringify(T.perCountry['ネパール'].intakeSubs) === '[5,0,null]' &&
    JSON.stringify(T.perCountry['ベトナム'].intakeSubs) === '[0,5,null]', JSON.stringify(T.perCountry));
  check("column totals: groups [6,8], courses [[3,2],[5]], 小計 [5,5], grand 24",
    JSON.stringify(T.groupColTotals) === '[6,8]' &&
    JSON.stringify(T.intakeColTotals.map(function (c) { return c.courses; })) === '[[3,2],[5],[]]' &&
    JSON.stringify(T.intakeColTotals.map(function (c) { return c.sub; })) === '[5,5,0]' && T.totalGrand === 24,
    JSON.stringify(T));

  const one = function (h) {
    const r = fn(h, 'simRenderGrid'), c = fn(h, 'simRecalcTotals');
    // Any `x +=` other than the render's `html +=` (markup) and the recalc's `cursor +=` (a cell
    // index) is a sum done outside simComputeTotals.
    const sums = function (f) { return (f.match(/[\w\]]\s*\+=/g) || []).length - (f.match(/\b(html|cursor)\s*\+=/g) || []).length; };
    return /simComputeTotals\(\)/.test(r) && /simComputeTotals\(\)/.test(c) && sums(r) === 0 && sums(c) === 0;
  };
  guard("⚠️ render and recalc both read simComputeTotals, and neither sums on its own", one,
    "          if (cells[1]) cells[1].innerText = pc.grand;",
    "          let grand = (simState.countryTotals[country] || 0); grand += simProjTotalForCountry(country);\n          if (cells[1]) cells[1].innerText = grand;",
    "a second copy of the sum is how the in-place totals drift from a fresh render");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
