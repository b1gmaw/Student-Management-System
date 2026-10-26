// 学生一覧 → 学生数: the retouch into the app's palette (2026-09-15) — tonal secondaries, ONE solid
// primary, counts as ホーム's tiles, and the states a report screen needs. Same layout; the report
// data, sorting and export are untouched. The pattern is tests/admissionsui.test.js.
//
// Measured before (driver, 1440px light + dark, 390px): three solid accents in a three-button toolbar
// (two blue, 出力 inline GREEN, which also beat the mobile block's primary on phones); a 総国籍数 pill
// with hardcoded white text on --table-header-text, unreadable in dark mode; numbers left-aligned under
// centred headers; the コース・ビザ table styled inline cell by cell; a failed load that left
// 「データを計算中...」 on screen for good; and an empty result that rendered a blank page.
//
// ⚠️ Each guard is also run against the OLD shape and must fail there.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
const mobile = function (h) { const st = style(h); return st.slice(st.indexOf('@media (max-width: 820px)')); };
const block = function (h) { const d = desk(h); const i = d.indexOf('/* 学生数 retouch'); return i < 0 ? '' : d.slice(i, d.indexOf('/* end 学生数 retouch */', i)); };
const view = function (h) { const a = h.indexOf('<div id="sub-view-report"'); return a < 0 ? '' : h.slice(a, h.indexOf('<div id="sub-view-simulation"', a)); };
const modal = function (h) { const a = h.indexOf('\n    <div id="stuTrendModal"'); return a < 0 ? '' : h.slice(a, h.indexOf('\n    <div id="gradDetailModal"', a)); };
const js = function (h) { return (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || ''; };
const fn = function (h, name) { const s = js(h); const i = s.indexOf('      function ' + name + '('); return i < 0 ? '' : s.slice(i, s.indexOf('\n      }\n', i) + 8); };
const ACCENT = /(background(-color)?|color):\s*#(f6c23e|36b9cc|4e73df|1cc88a|e74a3b)/i;

// The exact new shapes the mutations put back to their old form.
const REPORT_EXPORT = '<span id="btn-export" style="display:none;"><span class="exp-wrap">\n              <button class="export-btn" onclick="expToggle(event)">';
const TREND_EXPORT = '<button class="export-btn" onclick="expToggle(event)"><svg class="btn-ico" style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12"';

console.log("\n1. one palette: no accent colour left inline");
{
  guard("no button in 学生数's markup carries an inline accent",
    function (h) { const b = view(h).match(/<button[^>]*>/g) || []; return b.length >= 3 && !b.some(function (t) { return ACCENT.test(t); }); },
    REPORT_EXPORT, REPORT_EXPORT.replace('class="export-btn"', 'class="export-btn" style="background-color:#1cc88a;"'));
  guard("...nor any button in the 増減推移 modal",
    function (h) { const b = modal(h).match(/<button[^>]*>/g) || []; return b.length >= 3 && !b.some(function (t) { return ACCENT.test(t); }); },
    TREND_EXPORT, TREND_EXPORT.replace('class="export-btn"', 'class="export-btn" style="background-color:#1cc88a;"'));
  guard("a negative 前月差 uses the danger token, not a hex",
    function (h) { const f = fn(h, 'stuRenderTrend'); return f.length > 1000 && !/#e74a3b/i.test(f) && f.indexOf('color:var(--alert-danger-text);') !== -1; },
    `'<span style="color:var(--alert-danger-text);">' + net`, `'<span style="color:#e74a3b;">' + net`);
  check("the 学生数 renderers carry no accent either",
    !ACCENT.test(fn(HTML, 'renderReportTables')) && !ACCENT.test(fn(HTML, 'initReportTable')), "");
}

console.log("\n2. tonal secondaries, ONE solid primary — and desktop agrees with the phone");
{
  guard("the retouch block exists in the DESKTOP stylesheet",
    function (h) { return block(h).length > 400; },
    '/* 学生数 retouch', '/* 学生数 re-touch');
  const b = block(HTML);
  check("性別集計 / 増減推移 are tonal",
    /#sub-view-report \.schedule-btn[^{]*\{[^}]*background: var\(--report-header-bg\); color: var\(--table-header-text\)/.test(b), "");
  check("出力 is the one solid primary on 学生数",
    /#sub-view-report \.export-btn[^{]*\{[^}]*background: var\(--primary-color\); color: #fff/.test(b), "");
  check("in 増減推移, 出力 and ＋/− 前年度 are tonal and 保存 is the solid",
    /#stuTrendModal \.schedule-btn, #stuTrendModal \.export-btn \{[^}]*background: var\(--report-header-bg\)/.test(b)
      && /#stuTrendModal #stuTrendSave \{[^}]*background: var\(--primary-color\)/.test(b), "");
  // ⚠️ THE reason 出力 is solid rather than tonal: the mobile block had already decided it.
  check("⚠️ the mobile block still makes #view-students .export-btn the primary, so the two agree",
    /#view-students #btnSimSave, #view-students \.export-btn \{[^}]*background: var\(--primary-color\)/.test(mobile(HTML)),
    "if the phone rule changed, re-decide the desktop one with it");
  guard("tonal buttons FILL on hover (brightness on a light tint is invisible)",
    function (h) { return /#sub-view-report \.schedule-btn:hover:not\(:disabled\)[^{]*\{[^}]*background: var\(--primary-color\)/.test(block(h)); },
    '#sub-view-report .schedule-btn:hover:not(:disabled),', '#sub-view-report .schedule-btn:focus:not(:disabled),');
  guard("no !important in the block (the mobile rules must keep winning on a phone)",
    // Comments stripped: the block's own warning says "No !important", and a raw scan reads that
    // explanation as the violation.
    function (h) { const x = block(h).replace(/\/\*[\s\S]*?\*\//g, ''); return x.length > 0 && x.indexOf('!important') === -1; },
    '#sub-view-report .export-btn:hover, #stuTrendModal #stuTrendSave:hover { filter: brightness(0.9); }',
    '#sub-view-report .export-btn:hover, #stuTrendModal #stuTrendSave:hover { filter: brightness(0.9) !important; }');
  check("...and no bare transition duration (it means `all`)",
    !/transition:\s*[0-9.]+m?s/.test(b), "");
}

console.log("\n3. counts are ホーム's tiles, and the pill is gone");
{
  guard("学生数's tiles SHARE ホーム's rule rather than copying it",
    // 入学予定者's tiles joined the same list (2026-10-01): more sharers, still not a copy.
    function (h) { return /#view-home \.home-stat, #sub-view-report \.rep-stat(?:, [^{]+)? \{/.test(desk(h)); },
    '#view-home .home-stat, #sub-view-report .rep-stat {', '#view-home .home-stat {');
  const v = view(HTML);
  check("the ids initReportTable writes survive", /id="totalCountriesBadge"/.test(v) && /id="totalCountriesCount"/.test(v) && /id="repStatTotal"/.test(v), "");
  guard("no hardcoded white text or black shadow on the counts (unreadable in dark mode)",
    function (h) { const x = view(h); return x.length > 500 && !/color:\s*white/.test(x) && !/rgba\(0,\s*0,\s*0/.test(x); },
    '<div id="totalCountriesBadge" class="rep-stats" style="display:none;">',
    '<div id="totalCountriesBadge" class="rep-stats" style="display:none; color: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">');
  // ⚠️ The overrides must OUTRANK the shared rule, not merely exist: it sits later in the file at
  // the same specificity, and a plain `#sub-view-report .rep-stats` lost on source order.
  guard("the tile row keeps natural widths, with a selector that outranks the later shared rule",
    function (h) {
      const b = block(h), d = desk(h);
      const shared = d.indexOf('#view-home .home-stats, #sub-view-report .rep-stats');
      const own = d.indexOf('#sub-view-report div.rep-stats {');
      return shared !== -1 && own !== -1 && /#sub-view-report div\.rep-stats \{ grid-template-columns: repeat\(auto-fill, minmax\(150px, 180px\)\); \}/.test(b);
    },
    '#sub-view-report div.rep-stats {', '#sub-view-report .rep-stats {');
  check("the tiles are not buttons, so they do not claim a pointer",
    /#sub-view-report div\.rep-stat \{ cursor: default; \}/.test(block(HTML)), "");
  check("a title and a description, like 修了・卒業生進路", /class="rep-title">学生数</.test(v) && /class="rep-desc">/.test(v), "");
}

console.log("\n4. the tables: numbers centred by ROLE, no inline cell styles");
{
  guard("renderReportTables builds no inline style on any cell or row",
    function (h) { const f = fn(h, 'renderReportTables'); return f.length > 1500 && f.indexOf('style=') === -1; },
    'sumHtml += `<th onclick="sortSummary(${idx})">', 'sumHtml += `<th onclick="sortSummary(${idx})" style="text-align:center;">');
  guard("every numeric cell of the main table is marked .num — body AND total row",
    function (h) { const f = fn(h, 'renderReportTables'); return (f.match(/if \(idx >= 1\) classes\.push\('num'\);/g) || []).length === 2; },
    "tRow.forEach((cell, idx) => { let classes = []; if (idx===0) classes.push('sticky-col'); if (idx >= 1) classes.push('num');",
    "tRow.forEach((cell, idx) => { let classes = []; if (idx===0) classes.push('sticky-col');");
  check("...and so is the summary table's", /class="num"/.test(fn(HTML, 'renderReportTables')), "");
  const b = block(HTML);
  check(".num is centred and every figure is tabular",
    /#reportTable td\.num, #summaryReportTable td\.num \{ text-align: center; \}/.test(b)
      && /#reportTable, #summaryReportTable \{ font-variant-numeric: tabular-nums; \}/.test(b), "");
  check("rows that do nothing do not show a pointer", /#reportTable tbody tr, #summaryReportTable tbody tr \{ cursor: default; \}/.test(b), "");
  check("the summary's total row is styled by CSS", /#summaryReportTable tbody tr:last-child \{[^}]*background-color: var\(--total-row-bg\)/.test(b), "");
  check("the header heights the sticky offsets depend on were not touched",
    /#reportTable thead tr:nth-child\(1\) th \{ height: 48px;/.test(HTML) && /#reportTable thead tr:nth-child\(2\) th \{ top: 47px;/.test(HTML), "");
}

console.log("\n5. states: a failed load clears the loading line, and an empty result says so");
{
  guard("the failure handler hides 「データを計算中...」 before reporting",
    function (h) { return /withFailureHandler\(function \(err\) \{ document\.getElementById\('reportLoading'\)\.style\.display = 'none'; showError\(err\); \}\)\.getLiveReportData/.test(js(h)); },
    "withFailureHandler(function (err) { document.getElementById('reportLoading').style.display = 'none'; showError(err); }).getLiveReportData",
    "withFailureHandler(showError).getLiveReportData");

  // The real initReportTable, against a stub DOM.
  const run = function (src, response) {
    const els = {};
    const el = function (id) { return els[id] || (els[id] = { style: {}, innerText: '' }); };
    const ctx = vm.createContext({ document: { getElementById: el }, renderReportTables: function () { els.__rendered = true; } });
    vm.runInContext('var reportLoaded = false, currentReportData = null;\n' + src, ctx);
    ctx.initReportTable(response);
    return els;
  };
  const INIT = fn(HTML, 'initReportTable');
  check("initReportTable was located", INIT.length > 200, "");
  const empty = run(INIT, { mainTable: [['国名', '在籍数', '%'], ['合計', 0, '100.00%']], summaryTable: [], totalCountries: 0 });
  check("⚠️ an empty report shows the empty state instead of a blank page",
    empty.reportEmpty && empty.reportEmpty.style.display === 'block' && !empty.__rendered, JSON.stringify(empty.reportEmpty));
  check("...and hides the loading line", empty.reportLoading.style.display === 'none', "");
  const EMPTY_LINE = "document.getElementById('reportEmpty').style.display = 'block';";
  let mut;
  try { mut = run(swap(INIT, EMPTY_LINE, ''), { mainTable: [['国名', '在籍数', '%'], ['合計', 0, '100.00%']], summaryTable: [] }); } catch (e) { mut = null; }
  check("  mutation: without the empty branch the page is blank again", !!mut && (!mut.reportEmpty || mut.reportEmpty.style.display !== 'block'), "");
  check("a missing response is an empty state too, not a throw", run(INIT, null).reportEmpty.style.display === 'block', "");

  const full = run(INIT, { mainTable: [['国名', '在籍数', '%'], ['ネパール', 5, '100.00%'], ['合計', 5, '100.00%']], summaryTable: [], totalCountries: 1 });
  check("a real report fills 在籍者数 from the TOTAL row and 国籍数 from totalCountries",
    String(full.repStatTotal.innerText) === '5' && String(full.totalCountriesCount.innerText) === '1', JSON.stringify([full.repStatTotal, full.totalCountriesCount]));
  check("⚠️ the tile row is shown as a GRID (display: block would stack the tiles)",
    full.totalCountriesBadge.style.display === 'grid', full.totalCountriesBadge.style.display);
  check("...the tables render and the empty state is cleared",
    full.__rendered === true && full.reportEmpty.style.display === 'none', "");
  check("the empty state is in the markup, using the shared .home-empty",
    /<p id="reportEmpty" class="home-empty" style="display:none;">/.test(view(HTML)), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
