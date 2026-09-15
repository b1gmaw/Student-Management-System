// Every document.getElementById('literal') in Index.html must have a matching
// id= in the markup.
//
// This is CLAUDE.md rule 2 turned from a discipline into something enforced.
// Rule 2 exists because a thrown error in a render path takes the whole view
// down with NO VISIBLE MESSAGE, and an unguarded `.style` on a missing element
// is the classic way to cause it.
//
// The case that prompted this suite: `btnNotifToggle` lived inside the dead
// 面接スケジュール view, and setupInterfaceBasedOnRole dereferenced it unguarded
// in BOTH branches of a role check. Deleting that view — a view already
// unreachable, whose id appeared exactly once in the repo — would have thrown for
// every user of every role, mid-function, before switchMainTab(defaultTab) ever
// ran. The app would have rendered no tab at all and said nothing about why.
//
// Index.html is ~11,000 lines and one file. You cannot hold its DOM references in
// your head, and grep only helps if you already suspect the id.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// Ids that legitimately do not exist in the markup because the code CREATES them
// at runtime. Each is null-guarded at its use site; that guard is the reason it
// is allowed here, so check the guard before adding to this list.
//
// ⚠️ This list may only shrink. A stale entry fails below, so an id that stops
// being referenced has to be removed rather than left to rot — the same rule
// UNGUARDED_KNOWN follows in endpoints.test.js.
const RUNTIME_CREATED = {
  studentListDatalist: "populateStudentDatalist builds it with createElement; guarded by `if (!dl)`"
};

// References that genuinely point at nothing. This is a DEFECT list, not an
// exemption list — every entry is a bug waiting for someone to remove its null
// guard. It is EMPTY, and must stay that way.
//
// It briefly held six ids while the dead 面接スケジュール view was removed in two
// commits: the markup went first, orphaning them, and the script that referenced
// them went next. That is what this list is for — a deliberate, visible, and
// self-clearing intermediate state, never a place to park a defect.
const KNOWN_DANGLING = {};

const markupIds = [];
let m;
const idRe = /\bid="([^"]+)"|\bid='([^']+)'/g;
while ((m = idRe.exec(HTML)) !== null) markupIds.push(m[1] || m[2]);
const idSet = new Set(markupIds);

const refs = new Map();          // id -> how many times referenced
const refRe = /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
while ((m = refRe.exec(HTML)) !== null) {
  refs.set(m[1], (refs.get(m[1]) || 0) + 1);
}

console.log("\n1. every getElementById target exists in the markup");
{
  const missing = [...refs.keys()]
    .filter(id => !idSet.has(id))
    .filter(id => !Object.prototype.hasOwnProperty.call(RUNTIME_CREATED, id))
    .filter(id => !Object.prototype.hasOwnProperty.call(KNOWN_DANGLING, id));

  check("no getElementById points at an id that is not in the markup",
    missing.length === 0,
    "these resolve to null at runtime — an unguarded .style or .innerHTML on one " +
    "takes the whole view down silently: " + missing.join(", "));

  console.log("        (" + idSet.size + " ids in markup, " + refs.size +
              " distinct getElementById targets, " + Object.keys(RUNTIME_CREATED).length +
              " created at runtime)");
}

console.log("\n2. the runtime-created allowlist is honest");
{
  Object.keys(RUNTIME_CREATED).forEach(id => {
    check("'" + id + "' is still referenced somewhere",
      refs.has(id),
      "nothing calls getElementById('" + id + "') any more — delete this entry, " +
      "or the list stops meaning anything");
    check("'" + id + "' is genuinely absent from the markup",
      !idSet.has(id),
      "it exists in the markup now, so it does not belong on a runtime-created list");
    check("'" + id + "' is built with createElement",
      new RegExp("createElement").test(HTML) &&
      new RegExp(id + "[\\s\\S]{0,400}createElement").test(HTML),
      "the allowlist claims this is created at runtime — prove it, or guard it");
  });
}

console.log("\n2b. the known-dangling list only shrinks");
{
  const names = Object.keys(KNOWN_DANGLING);
  names.forEach(id => {
    check("'" + id + "' is still referenced", refs.has(id),
      "nothing calls getElementById('" + id + "') any more — remove this entry");
    check("'" + id + "' is still genuinely missing", !idSet.has(id),
      "it exists in the markup now, so it is no longer dangling — remove this entry");
  });
  console.log("        (" + names.length + " dangling reference(s); this must only go down)");
}

console.log("\n3. no duplicate ids");
{
  // Two elements sharing an id means getElementById silently returns the FIRST,
  // so one of them is unreachable and deleting "the dead one" can break the live
  // one. The dead 面接スケジュール view was safe to remove precisely because it
  // used a parallel cal* namespace and shared no id with the live calendar.
  const seen = new Map();
  markupIds.forEach(id => seen.set(id, (seen.get(id) || 0) + 1));
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  check("no id is declared twice in the markup",
    dupes.length === 0,
    "getElementById returns only the first, so the second is unreachable: " +
    dupes.map(([id, n]) => id + " x" + n).join(", "));
}

console.log("\n4. the views and nav entries still line up");
{
  // A nav button calls switchMainTab('x'), which activates 'btn-x' and 'view-x'
  // unless it is one of the documented overrides. A button whose view does not
  // exist renders an empty screen.
  const OVERRIDES = { 'admissions': 'view-shared-schedule' };
  const tabs = new Set();
  const tabRe = /onclick="switchMainTab\('([^']+)'\)"/g;
  while ((m = tabRe.exec(HTML)) !== null) tabs.add(m[1]);

  tabs.forEach(t => {
    const wantView = OVERRIDES[t] || ('view-' + t);
    check("switchMainTab('" + t + "') has a view (" + wantView + ")",
      idSet.has(wantView),
      "the button exists but its view section does not — the tab would render blank");
    check("switchMainTab('" + t + "') has its button id (btn-" + t + ")",
      idSet.has('btn-' + t),
      "switchMainTab highlights btn-" + t + "; _navAdd is null-safe so this is " +
      "cosmetic, but a mismatch means the nav and the handler have drifted");
  });
  console.log("        (" + tabs.size + " tabs reachable from the sidebar)");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
