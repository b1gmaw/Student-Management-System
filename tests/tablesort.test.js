// One sort key for every data table, and one reading of a ビザ警告 day count (2026-09-28).
//
// sortInterviewsTable (面接結果) and sortSpecificTable (学生一覧) each carried a local parseVal and had
// already drifted: only 学生一覧's knew 期限切れ / N日, and it knew them LOOSELY — any value containing
// 日 became its digits, so 2026年4月10日 → 2026410 sorted AFTER 2026年12月1日 → 2026121. The cell-colour
// rule used the same loose test. Both sorters now call _tableSortKey, and the colour rule _visaDays.
//
// ⚠️ These run the REAL functions from Index.html in a vm, never a transcription: a copy tests the
// copy (see authlayer.test / cellsafe §8). Every guard is also run against the old loose rule.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
const JS = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || '';

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function fnSrc(js, name) {
  const i = js.indexOf('      function ' + name + '(');
  return i < 0 ? '' : js.slice(i, js.indexOf('\n      }\n', i) + 8);
}

// The sorters, with every global they touch stubbed. Rendering is captured, not performed.
function load(js) {
  const ctx = vm.createContext({});
  vm.runInContext(
    'var currentStudentsData = [], sortCols = {}, sortAscs = {}, rendered = null;' +
    'var pastInterviewsData = [], sortInterviewCol = -1, sortInterviewAsc = true;' +
    'function renderSpecificStudentTable(d) { rendered = d; }' +
    'function renderPastInterviewsTable() { rendered = pastInterviewsData; }', ctx);
  ['_visaDays', '_tableSortKey', 'sortSpecificTable', 'sortInterviewsTable'].forEach(function (n) {
    const s = fnSrc(js, n);
    if (!s) throw new Error('not found in Index.html: ' + n);
    vm.runInContext(s, ctx);
  });
  return ctx;
}
// Sort one column ascending through the REAL sorter and return that column top to bottom.
function sortStudents(ctx, values) {
  ctx.currentStudentsData = [['col']].concat(values.map(function (v) { return [v]; }));
  ctx.sortCols = { current: -1 }; ctx.sortAscs = { current: true };
  ctx.sortSpecificTable(0, 'current');
  return ctx.currentStudentsData.slice(1).map(function (r) { return r[0]; });
}
function sortInterviews(ctx, values) {
  ctx.pastInterviewsData = [['col']].concat(values.map(function (v) { return [v]; }));
  ctx.sortInterviewCol = -1; ctx.sortInterviewAsc = true;
  ctx.sortInterviewsTable(0);
  return ctx.pastInterviewsData.slice(1).map(function (r) { return r[0]; });
}

const C = load(JS);

console.log("\n1. a day count is only a value that IS one");
check("'30 日' (the app's own ビザ警告 shape) is 30", C._visaDays('30 日') === 30, "");
check("'5日' without the space is 5", C._visaDays('5日') === 5, "");
check("⚠️ a Japanese date is NOT a day count", C._visaDays('2026年4月1日') === null, "");
check("'週3日' is not a day count either", C._visaDays('週3日') === null, "");
check("期限切れ / OK / データなし / '' are not day counts",
  ['期限切れ', 'OK', 'データなし', ''].every(function (v) { return C._visaDays(v) === null; }), "");

console.log("\n2. 学生一覧: dates sort chronologically, day counts numerically");
const dates = sortStudents(C, ['2026年12月1日', '2026年4月10日', '2026年4月1日']);
check("⚠️ 2026年4月1日 < 2026年4月10日 < 2026年12月1日",
  JSON.stringify(dates) === JSON.stringify(['2026年4月1日', '2026年4月10日', '2026年12月1日']), JSON.stringify(dates));
const slash = sortStudents(C, ['2026/12/01', '2026/04/10', '2026/04/01']);
check("slash dates still sort chronologically",
  JSON.stringify(slash) === JSON.stringify(['2026/04/01', '2026/04/10', '2026/12/01']), JSON.stringify(slash));
const warn = sortStudents(C, ['60 日', '5 日', '期限切れ', '30 日']);
check("ビザ警告: 期限切れ first, then the fewest days left",
  JSON.stringify(warn) === JSON.stringify(['期限切れ', '5 日', '30 日', '60 日']), JSON.stringify(warn));

console.log("\n3. 面接結果 uses the same key");
const ivDates = sortInterviews(C, ['2026年12月1日', '2026年4月10日']);
check("面接結果 sorts a Japanese date the same way",
  JSON.stringify(ivDates) === JSON.stringify(['2026年4月10日', '2026年12月1日']), JSON.stringify(ivDates));
const nums = sortInterviews(C, ['10', '9', '100']);
check("...and numbers numerically, as before", JSON.stringify(nums) === JSON.stringify(['9', '10', '100']), JSON.stringify(nums));

console.log("\n4. one key, one reading — structurally");
const sSrc = fnSrc(JS, 'sortSpecificTable'), iSrc = fnSrc(JS, 'sortInterviewsTable');
check("neither sorter carries a local parseVal any more",
  !/function parseVal/.test(sSrc) && !/function parseVal/.test(iSrc) && !/function parseVal/.test(JS), "");
check("both sorters call _tableSortKey", /_tableSortKey\(valA\)/.test(sSrc) && /_tableSortKey\(valA\)/.test(iSrc), "");
const render = fnSrc(JS, 'renderSpecificStudentTable');
check("the cell-colour rule reads the day count through _visaDays, not by its own test",
  /_visaDays\(cellText\)/.test(render) && !/cellText\.includes\("日"\)/.test(render), "");

console.log("\n4b. the ビザ警告 colours, rendered by the real renderSpecificStudentTable");
// The 在籍学生 fixture carries no ビザ警告 values, so a pixel-identical render proves nothing about
// colour; this renders the cells for real and reads back each one's class.
function colours(js, cells) {
  const ctx = vm.createContext({ document: { getElementById: function () { return tbl; } } });
  const tbl = { innerHTML: '' };
  vm.runInContext('var sortCols = {}, sortAscs = {}; function applyStudentFilters() {}', ctx);
  ['escHtmlJs', '_visaDays', 'renderSpecificStudentTable'].forEach(function (n) { vm.runInContext(fnSrc(js, n), ctx); });
  ctx.renderSpecificStudentTable([['ビザ警告']].concat(cells.map(function (c) { return [c]; })), 'currentStudentTable', 'current');
  return (tbl.innerHTML.match(/<td class="([^"]*)">/g) || []).map(function (t) { return t.replace(/<td class="|">/g, ''); });
}
const VALUES = ['30 日', '31 日', '60 日', '61 日', '期限切れ', 'OK', '週3日', '2026年4月1日'];
const WANT   = ['visa-danger', 'visa-warning', 'visa-warning', '', 'visa-danger', '', '', ''];
const got4b = colours(JS, VALUES);
check("30 日 red, 31–60 日 amber, 61 日 none, 期限切れ red, OK none",
  JSON.stringify(got4b.slice(0, 6)) === JSON.stringify(WANT.slice(0, 6)), JSON.stringify(got4b));
check("⚠️ '週3日' and a Japanese date are not coloured as day counts",
  got4b[6] === '' && got4b[7] === '', JSON.stringify(got4b.slice(6)));

console.log("\n5. mutation — the old loose rule must fail");
{
  const loose = JS.replace(
    "const m = /^(\\d+)\\s*日$/.exec(String(val == null ? \"\" : val).trim());\n        return m ? parseInt(m[1], 10) : null;",
    "const s = String(val == null ? \"\" : val); if (!s.includes(\"日\")) return null;\n        const n = parseInt(s.replace(/\\D/g, ''), 10); return isNaN(n) ? null : n;");
  check("  mutation anchor found", loose !== JS, "the _visaDays body changed shape");
  const M = load(loose);
  const got = sortStudents(M, ['2026年12月1日', '2026年4月10日', '2026年4月1日']);
  check("  mutation: the loose rule sorts December before April again — caught",
    JSON.stringify(got) !== JSON.stringify(['2026年4月1日', '2026年4月10日', '2026年12月1日']), JSON.stringify(got));
  check("  mutation: the loose rule reads 週3日 as a day count — caught", M._visaDays('週3日') !== null, "");
  check("  mutation: ...and paints 週3日 red — caught", colours(loose, ['週3日'])[0] === 'visa-danger', "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
