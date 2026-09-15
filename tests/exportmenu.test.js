// The 出力 menu: one control, one pipeline, five tabs.
//
// ⚠️ WHY THIS EXISTS. 募集シミュレーション had its own single-format button
// (`Excel出力` -> simExportExcel) instead of the 出力 ▾ menu every other tab uses.
// Wiring it in looks like one registry line in _expActive, and that line would have
// been WRONG in a way nothing would have reported:
//
//   _expReadTable reads td.innerText. The simulation's projection cells are
//   <input type="number" value="…">, and an input's VALUE IS NOT IN innerText.
//
// Measured against the driver fixture, same row, two paths:
//   simExportRows()          -> ["ネパール", 18, 9, 2, 1, 4, 2, 6, …]
//   _expReadTable(simTable)  -> ["ネパール","18","9","2","1","", "", "6", …]
// Four blank cells, exactly where the projected figures belong. So the entry carries
// a `rows` provider that reads simState, and this file's job is to keep it that way.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
const BLOCKS = HTML.match(/<script>[\s\S]*?<\/script>/g) || [];
const CODE = (BLOCKS[1] || "").replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
function fn(name) {
  const at = CODE.indexOf('function ' + name + '(');
  return at === -1 ? '' : CODE.slice(at, CODE.indexOf('\n      }', at));
}

console.log("\n1. every tab uses the same control");
{
  const wraps = (HTML.match(/class="exp-wrap[^"]*"/g) || []);
  check("there are at least five 出力 menus", wraps.length >= 5, "found " + wraps.length);
  // ⚠️ A window, not a non-greedy match to </div>: menus that open with an .exp-scope
  // block close that inner div first, so the lazy form captured the scope and counted
  // zero items — a check that failed for a reason unrelated to what it guards.
  const menuAt = [];
  let mi = -1;
  while ((mi = HTML.indexOf('<div class="exp-menu"', mi + 1)) !== -1) {
    menuAt.push(HTML.slice(mi, mi + 1400));
  }
  check("...and each offers more than one format",
    menuAt.length >= 5 && menuAt.every(function (m) {
      return (m.match(/class="exp-item"/g) || []).length >= 2; }),
    "a single-format menu is the control this replaced");
  const sim = HTML.slice(HTML.indexOf('id="sub-view-simulation"'),
                         HTML.indexOf('id="sub-view-simulation"') + 5000);
  check("募集シミュレーション offers CSV, Excel and PDF",
    /expRun\('csv'\)/.test(sim) && /expRun\('xlsx'\)/.test(sim) && /expRun\('pdf'\)/.test(sim), "");
  check("...through expRun, not its own exporter",
    !/simExportExcel/.test(HTML),
    "the bespoke single-format button is what this replaced");
  check("...and it is labelled like the others",
    /<span class="btn-label">出力 ▾<\/span>/.test(sim), "");
}

console.log("\n2. ⚠️ the simulation rows come from simState, NOT from the table");
{
  const active = fn('_expActive');
  check("the registry knows the simulation sub-tab", /sub: 'simulation'/.test(active), "");
  // ⚠️ THE assertion. A `table:`-only entry exports blank projection columns.
  check("⚠️ its entry carries a `rows` provider",
    /sub: 'simulation'[\s\S]{0,400}?rows: function/.test(active),
    "without it _expRows falls to the DOM branch and every <input> value is lost");
  check("...and a `merges` provider, so the header spans survive",
    /sub: 'simulation'[\s\S]{0,400}?merges: function/.test(active),
    "the bespoke Excel always merged 国名/総数 down and each intake across");

  const rows = fn('_expRows');
  check("_expRows honours a rows provider", /if \(a\.rows\) return/.test(rows), "");
  // ⚠️ Order matters: the simulation entry ALSO carries a table id, so the DOM branch
  // would win if it came first.
  check("⚠️ ...BEFORE the DOM branch",
    rows.indexOf('if (a.rows)') !== -1 && rows.indexOf('if (a.rows)') < rows.indexOf('if (!a.data)'),
    "the entry carries a table id too; the DOM branch would silently win");

  const src = fn('simExportRows');
  check("simExportRows exists", src.length > 200, "");
  check("⚠️ ...and reads simState, never the DOM",
    /simState\./.test(src) && !/getElementById|innerText|querySelector/.test(src),
    "reading the table is the bug this design exists to avoid, and it also breaks " +
    "when simCanEdit() is false and the inputs are disabled");
}

console.log("\n3. the shared writers, and one deliberate exemption");
{
  const xlsx = fn('_expXlsx');
  check("_expXlsx takes merges", /function _expXlsx\(rows, extra, extraName, merges\)/.test(CODE), "");
  check("...applies them", /if \(merges && merges\.length\) ws\['!merges'\] = merges;/.test(xlsx), "");
  check("...and passes them through its own XLSX retry",
    /_withXlsx\(function \(\) \{ _expXlsx\(rows, extra, extraName, merges\); \}\)/.test(xlsx),
    "dropping them on the retry loses the merges whenever the library loads late");

  const run = fn('expRun');
  // ⚠️ Deliberately ungated, and ONLY here — the old Excel出力 had no permission-req,
  // so gating it would remove an export people have today.
  check("⚠️ the permission exemption names simulation",
    /_a\.sub === 'simulation'\) \? null/.test(run), "");
  check("⚠️ ...and nothing else",
    (run.match(/\? null/g) || []).length === 1,
    "a second exemption is how a gate quietly becomes optional");
  check("...and the gate still applies to every other tab",
    /if \(needed && !hasPermission\(needed\)\)/.test(run), "");
  check("past-interviews still uses its own permission",
    /'export_admissions'/.test(run), "");
  check("expRun still dispatches all three formats",
    /_expCsv\(rows/.test(run) && /_expXlsx\(rows, extra, extraName, merges\)/.test(run)
      && /_expPdf\(rows/.test(run), "");
}

console.log("\n4. the driver can actually show it");
{
  const DRV = fs.readFileSync(
    path.join(__dirname, '..', '.claude', 'skills', 'run-local', 'driver.mjs'), 'utf8');
  // ⚠️ Without a fixture the grid is empty, simExportRows() returns a lone 合計 row,
  // and an export check against it passes while proving nothing.
  check("a getSimulationData fixture exists", /getSimulationData: \{/.test(DRV), "");
  check("...with projection figures, which is what makes the trap visible",
    /simData: \{[\s\S]{0,400}?\|\|[\s\S]{0,80}?: \d/.test(DRV),
    "no projections means no <input> cells, and the DOM read looks fine");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
