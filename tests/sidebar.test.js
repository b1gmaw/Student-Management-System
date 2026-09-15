// The sidebar is a rail that opens on hover and closes again. There is exactly ONE
// expanded state, `sidebar-open`, and nothing about it is persisted.
//
// It used to have two states: a saved `sidebar-pinned` preference with a checkbox in
// アカウント settings, plus a transient peek. The saved half kept reverting, because
// there were two sources of truth — _setSidebarPinned wrote localStorage while
// renderAccountTab read the checkbox back off the CSS class. Once those disagreed the
// next onchange persisted whatever the stale checkbox showed.
//
// Section 1 exists so that design cannot creep back in a half-removed form, which
// would be worse than either version.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}
const CSS = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
// Comments legitimately mention the old names to explain why they are gone.
const CODE = HTML.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log("\n1. the saved preference is gone, completely");
{
  [['sidebar-pinned', 'the CSS class'],
   ['_setSidebarPinned', 'the setter'],
   ['_applySidebarPinned', 'the boot-time apply'],
   ['sms_sidebarPinned', 'the storage key'],
   ['acctSidebarPinned', 'the settings checkbox'],
   ['sidebar-peek', 'the old second state']
  ].forEach(function (p) {
    check("no trace of " + p[1] + " (" + p[0] + ")",
      CODE.indexOf(p[0]) === -1,
      "half-removed is worse than either design — it is still referenced somewhere");
  });

  // ⚠️ The specific thing that made it revert: a preference read from one place and
  // written to another. Nothing sidebar-related may touch storage now.
  const sbStore = /localStorage\.[gs]etItem\(\s*['"][^'"]*[Ss]idebar/.test(CODE);
  check("nothing sidebar-related touches localStorage", !sbStore,
    "storing sidebar state is what produced the reverting tick");
}

console.log("\n2. opening never moves the page");
{
  // ⚠️ The old pinned state set padding-left: 236px, so opening reflowed every table.
  // The rail's 76px is now reserved permanently and the open state floats over it.
  check("the rail offset is fixed and unconditional",
    /body\.has-sidebar \{ padding-left: \d+px; \}/.test(CSS), "");
  const openRules = CSS.match(/body\.sidebar-open[^{]*\{[^}]*\}/g) || [];
  check("there are open-state rules at all", openRules.length >= 5,
    "found " + openRules.length + " — the sidebar CSS moved or changed shape");
  const shifts = openRules.filter(function (r) { return /padding-left|margin-left/.test(r); });
  check("no open-state rule shifts the page", shifts.length === 0,
    "opening would relayout every table on screen: " + shifts.join(" | "));
  check("the open state widens the sidebar",
    /body\.sidebar-open \.app-sidebar \{ width: \d+px/.test(CSS), "");
}

console.log("\n3. hover opens it, but only on intent");
{
  // ⚠️ Hover-open was built and removed once before — it fired while reaching for
  // content near the left edge. The delay is the entire reason it is acceptable now.
  check("a hover delay constant exists",
    /const SIDEBAR_HOVER_MS = \d+;/.test(HTML), "");
  check("mouseenter opens only through the delay",
    /mouseenter'?,? function \(\) \{ _sidebarAfter\(SIDEBAR_HOVER_MS, true\); \}/.test(HTML),
    "opening on the raw mouseenter re-creates the accidental expand that got this removed");
  check("mouseenter does NOT open immediately",
    !/mouseenter[\s\S]{0,120}_setSidebarOpen\(true\)/.test(CODE),
    "that is the removed behaviour, without the intent gate");
  check("mouseleave closes through the same delay",
    /mouseleave'?,? function \(\) \{ _sidebarAfter\(SIDEBAR_HOVER_MS, false\); \}/.test(HTML),
    "closing on the raw mouseleave fires on a few pixels of overshoot");

  // One shared timer is what makes in-out-in safe.
  const at = HTML.indexOf('function _sidebarAfter');
  const body = HTML.slice(at, HTML.indexOf('\n      }', at));
  check("_sidebarAfter clears the pending timer before setting a new one",
    body.indexOf('clearTimeout(_sbTimer);') !== -1 &&
    body.indexOf('clearTimeout(_sbTimer);') < body.indexOf('setTimeout'),
    "an earlier timer would fire later against a state the user has since changed");
  check("both directions share one timer",
    (HTML.match(/_sbTimer/g) || []).length >= 4 && CODE.indexOf('_peekTimer') === -1, "");
}

console.log("\n4. it still opens and closes without a mouse");
{
  // ⚠️ Neither hover event exists on touch. Without these a tablet user cannot open
  // the sidebar at all, or cannot close it once open.
  check("a nav icon click opens it immediately",
    /closest\('\.nav-btn'\)\) return;[\s\S]{0,220}_setSidebarOpen\(true\)/.test(HTML),
    "a click is already the intent; it must not wait on the hover delay");
  check("the brand row toggles it", /onclick="toggleSidebar\(\)"/.test(HTML), "");
  check("toggleSidebar flips the one state",
    /function toggleSidebar\(\) \{\s*\n\s*_setSidebarOpen\(!document\.body\.classList\.contains\('sidebar-open'\)\);/.test(HTML), "");
  check("a click outside closes it — the touch path",
    /addEventListener\('click', function \(e\) \{[\s\S]{0,300}closest\('\.app-sidebar'\)\) return;[\s\S]{0,60}_setSidebarOpen\(false\)/.test(HTML),
    "touch has no mouseleave, so this is the only way it closes there");
}

console.log("\n5. the listeners cannot stack up");
{
  // setupInterfaceBasedOnRole runs again on re-login without a page reload. This
  // guard exists because listeners accumulated one set per login once before.
  const at = HTML.indexOf('function _wireSidebarExpandOnClick');
  const body = HTML.slice(at, HTML.indexOf('\n      // Show only the active', at));
  check("_wireSidebarExpandOnClick guards on _sidebarWired",
    /if \(_sidebarWired\) return;\s*\n\s*_sidebarWired = true;/.test(body), "");
  check("the hover listeners sit inside that guard",
    body.indexOf('mouseenter') !== -1 && body.indexOf('mouseleave') !== -1,
    "wired outside it, they stack one set per login");
}

console.log("\n6. the settings tab has nothing left to break");
{
  // ⚠️ domrefs.test.js enforces that every literal getElementById has matching
  // markup. Removing the checkbox but leaving its lookup is exactly what that rule
  // catches, so this is a second, more specific guard on the same mistake.
  check("renderAccountTab no longer looks the checkbox up",
    HTML.indexOf("getElementById('acctSidebarPinned')") === -1, "");
  // Re-pinned 2026-09-14: the dark-mode checkbox became the three-way #acctTheme control.
  check("the theme control is still there, offering ライト and ダーク",
    /id="acctTheme"[\s\S]{0,600}setThemePref\('light'\)[\s\S]{0,300}setThemePref\('dark'\)/.test(HTML),
    "the sidebar row sat next to it; removing one must not take the other");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
