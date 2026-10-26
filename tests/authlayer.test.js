// The guard layer: role and permissions come from the resolved session, never from what the browser
// sent. Measured in production before this layer existed:
//   google.script.run.getDashboardData("teacher", false)  →  608 student records
//
// ⚠️ REWRITTEN 2026-09-21 to run the REAL helpers from Code.js in a vm. The previous version was a pure
// transcription with no binding to the source, and it proved the point CLAUDE.md makes about
// cellsafe §8: when observe mode was deleted from Code.js, it still passed all 29 of its checks —
// including "observe mode changes nothing" — against code that no longer had an observe mode, and its
// hasPerm had never gained the admin-level rule the real _hasPerm_ has carried since 2026-09-07.
// A transcription tests the copy.
//
//   §1  the argument is ignored — the session decides, in both directions
//   §2  no session denies everything, and _requireSession_ throws the session-dead error
//   §3  _roleIsAnyOf_ keeps the comparison inside the session-aware helper
//   §4  identity checks (a role describing SOMEBODY ELSE) stay literal
//   §5  there is NO mode switch — the observe mode that failed open is gone for good
//   §6  every ambiguous state denies

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const SHINSEI = fs.readFileSync(path.join(ROOT, 'Shinsei_Code.js'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
// A crash must read as a verdict, not a stack trace: running this suite against the pre-2026-09-21
// Code.js dies inside the first behavioural call (its helpers call the deleted _authEnforcing_).
process.on('uncaughtException', function (e) {
  fail++; console.log("  FAIL  the suite crashed — the helpers depend on something that should not exist\n        " + e.message);
  console.log("\n" + pass + " passed, " + fail + " FAILED"); process.exit(1);
});

// A top-level function's source: a one-liner, or everything up to its column-0 closing brace.
function fnSrc(src, name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) return '';
  const start = i + 1, eol = src.indexOf('\n', start), first = src.slice(start, eol);
  const opens = (first.match(/\{/g) || []).length, closes = (first.match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return first;
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}

const HELPERS = ['_sessionDeadError_', '_requireSession_', '_effectiveRole_', '_effectivePerms_',
  '_isAdminRole_', '_isAdminLevel_', '_isMasterRole_', '_isMasterRoleLiteral_', '_roleIsAnyOf_', '_hasPerm_'];
// _isAdminLevel_ reads a role's own 管理者権限 flag through _roleByKey_ (which reads the Roles sheet).
const ROLE_DEFS = { teacher: { admin: false }, sales: { admin: false }, admin: { admin: true }, kyomu_mgr: { admin: true } };

// ⚠️ PropertiesService THROWS here. If any helper consulted a script property — a mode switch — the
// call would throw instead of answering, so every behavioural check below doubles as proof that
// none does. That is the failure that used to fail OPEN.
function load(src) {
  const ctx = vm.createContext({
    _authUser: null,
    _roleByKey_: function (k) { return ROLE_DEFS[String(k || '')] || null; },
    PropertiesService: { getScriptProperties: function () { throw new Error('script properties unavailable'); } },
  });
  HELPERS.forEach(function (n) {
    const s = fnSrc(src, n);
    if (!s) throw new Error('helper not found in Code.js: ' + n);
    vm.runInContext(s, ctx);
  });
  return ctx;
}
const C = load(SRC);
function as(ctx, user, fn) { ctx._authUser = user; try { return fn(ctx); } finally { ctx._authUser = null; } }
function threwDead(ctx, fn) { try { fn(); return 'no throw'; } catch (e) { return e.sessionDead === true && /再度ログインしてください/.test(e.message) ? 'dead' : 'other: ' + e.message; } }

const TEACHER = { role: "teacher", id: "T1", name: "甲野", permissions: "view_teacher_schedule" };
const SALES   = { role: "sales",   id: "S1", name: "乙山", permissions: "view_admissions,edit_admissions" };
const MASTER  = { role: "master",  id: "MASTER", name: "システム", permissions: "ALL" };

console.log("\n0. no mode switch exists (structural — first, so it reports even if behaviour below crashes)");
{
  // Removed 2026-09-21. It failed OPEN: an unreadable AUTH_ENFORCE property meant "observe", and observe
  // trusted the role the browser sent. Checked on CODE lines only — the history in comments is wanted.
  const codeLines = function (s) { return s.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n'); };
  const both = codeLines(SRC) + '\n' + codeLines(SHINSEI);
  ['AUTH_ENFORCE', '_authEnforcing_', '_authMismatch_', '_currentMethod'].forEach(function (t) {
    check("no code reads or sets " + t, both.indexOf(t) === -1, "a mode switch is back: " + t);
  });
}

console.log("\n0b. the real helpers were loaded");
check("all " + HELPERS.length + " helpers extracted from Code.js and evaluated", HELPERS.every(function (n) { return typeof C[n] === 'function'; }), "");

console.log("\n1. the argument is ignored — the session decides");
as(C, TEACHER, function (c) {
  // THE attack, verbatim: a teacher session claiming to be master.
  check("a teacher claiming master is not master", !c._isMasterRole_("master"), "privilege escalation by argument");
  check("a teacher claiming admin is not admin", !c._isAdminRole_("admin"), "privilege escalation by argument");
  check("claimed permissions are ignored", !c._hasPerm_("master", "ALL", "view_students"), "the browser sent perms:'ALL' and was believed");
  check("the session's own permission still works", c._hasPerm_("teacher", "", "view_teacher_schedule"), "");
});
as(C, MASTER, function (c) {
  check("a real master IS master even claiming teacher", c._isMasterRole_("teacher"), "the session decides, in both directions");
  check("master passes any permission", c._hasPerm_("teacher", "", "anything_at_all"), "");
});
// The rule the old transcription never had: 管理者権限 overrides the ticks, from the person or the role.
as(C, { role: "teacher", id: "T2", name: "管理教務", permissions: "", adminUser: true }, function (c) {
  check("a person flagged 管理者権限 holds every permission", c._hasPerm_("", "", "view_students"), "_hasPerm_ must consult _isAdminLevel_");
});
as(C, { role: "kyomu_mgr", id: "S9", name: "教務部長", permissions: "" }, function (c) {
  check("so does a custom role flagged admin-level", c._hasPerm_("", "", "view_students"), "");
});
as(C, SALES, function (c) {
  check("an unflagged sales session holds only what is ticked", !c._hasPerm_("", "", "view_students") && c._hasPerm_("", "", "view_admissions"), "");
});

console.log("\n2. no session denies everything");
as(C, null, function (c) {
  check("no session is not master", !c._isMasterRole_("master"), "anonymous caller reached master");
  check("no session is not admin", !c._isAdminRole_("admin") && !c._isAdminLevel_("admin"), "anonymous caller reached admin");
  check("no session holds no permission", !c._hasPerm_("admin", "ALL", "view_students"), "this is the getDashboardData('teacher') hole");
  check("no session is not sales", !c._roleIsAnyOf_("sales", ["sales"]), "");
  check("_requireSession_ throws the session-dead error", threwDead(c, function () { c._requireSession_("getSchedule"); }) === 'dead',
    "endpoints with no role argument must refuse, and the error must sign the browser out");
});

console.log("\n3. _roleIsAnyOf_ keeps the comparison inside the session-aware helper");
{
  // The old inline shape was:  _isAdminRole_(userRole) || userRole === "sales" — the half beside the
  // helper read the client's string, so passing "sales" walked straight through.
  as(C, TEACHER, function (c) {
    const oldShape = function (claimed) { return c._isAdminRole_(claimed) || claimed === "sales"; };
    check("the OLD inline shape let a teacher through as sales", oldShape("sales") === true, "why the comparison moved into the helper");
    check("_roleIsAnyOf_ does not", !c._roleIsAnyOf_("sales", ["sales"]), "the claimed string still reached the decision");
  });
  as(C, SALES, function (c) {
    check("a real sales session passes", c._roleIsAnyOf_("anything", ["sales"]), "");
    check("sales is refused a teacher-only endpoint", !c._roleIsAnyOf_("x", ["teacher"]), "");
  });
  as(C, MASTER, function (c) {
    check("master passes regardless of the allowed list", c._roleIsAnyOf_("x", ["teacher"]), "");
  });
}

console.log("\n4. identity checks must stay literal");
{
  // _resolveUserById_ runs INSIDE resumeSession, before any session is parked: the session-aware
  // helper would say "not master" for the master row and revoke every master session on resume.
  as(C, null, function (c) {
    check("the master row resolves with no session parked", c._isMasterRoleLiteral_("master"), "master login would break entirely");
    check("the session-aware helper would NOT have", !c._isMasterRole_("master"), "this is why the literal version exists");
  });
  // saveSystemUser asks "is the role being ASSIGNED master" — about somebody else.
  as(C, { role: "admin", id: "A1", name: "管理", permissions: "manage_users" }, function (c) {
    check("assigning role=master is caught", c._isMasterRoleLiteral_("master"), "an admin could grant somebody the master role");
    check("the session-aware helper would have missed it", !c._isMasterRole_("master"), "it compares the caller, not the assigned role");
  });
}

console.log("\n5. there is NO mode switch");
{
  // Removed 2026-09-21. It failed OPEN: an unreadable AUTH_ENFORCE property meant "observe", and observe
  // trusted the role the browser sent. Checked on CODE lines only — the history in comments is wanted.
  // (The structural half runs first, in section 0 — see there.)
  const rs = fnSrc(SRC, '_requireSession_');
  check("_requireSession_ has exactly two outcomes: the session, or the session-dead error",
    /if \(_authUser\) return _authUser;\s*\n\s*throw _sessionDeadError_\(/.test(rs) && !/return null/.test(rs), rs);
  as(C, TEACHER, function (c) {
    check("with script properties unreadable the guards still answer, and still deny the claim",
      !c._isMasterRole_("master") && !c._hasPerm_("master", "ALL", "view_students"),
      "a helper that consults a property would throw here — or, worse, fall back to the argument");
  });
}

console.log("\n6. every ambiguous state denies");
[undefined, { role: "", id: "", permissions: "" }].forEach(function (u) {
  as(C, u, function (c) {
    check("session " + JSON.stringify(u && u.role) + " grants nothing",
      !c._hasPerm_("master", "ALL", "view_students") && !c._isAdminRole_("admin"), "an empty or missing session must deny");
  });
});
as(C, { role: "teacher", id: "T", name: "x", permissions: null }, function (c) {
  check("null permissions deny rather than throw", c._hasPerm_("teacher", "ALL", "view_students") === false, "");
});

console.log("\n7. mutations — each guard is run against the shape it exists to prevent");
function mutant(label, from, to, predicate) {
  if (SRC.indexOf(from) === -1) { check("  mutation: " + label, false, "anchor not found: " + from); return; }
  let caught;
  try { caught = predicate(load(SRC.replace(from, to))); } catch (e) { caught = true; }
  check("  mutation: " + label, caught === true, "the old shape passed");
}
mutant("a claimed-role fallback in _effectiveRole_ (observe mode's hole) is caught",
  'return _authUser ? String(_authUser.role || "") : "";',
  'return _authUser ? String(_authUser.role || "") : String(claimedRole || "");',
  function (m) { return as(m, null, function (c) { return c._isMasterRole_("master"); }); });
mutant("a claimed-permissions fallback in _effectivePerms_ is caught",
  'return _authUser ? _authUser.permissions : "";',
  'return _authUser ? _authUser.permissions : claimedPerms;',
  function (m) { return as(m, null, function (c) { return c._hasPerm_("x", "view_students", "view_students"); }); });
mutant("an observe-style early return in _requireSession_ is caught",
  '  if (_authUser) return _authUser;\n  throw _sessionDeadError_(',
  '  if (_authUser) return _authUser;\n  if (true) return null;\n  throw _sessionDeadError_(',
  function (m) { return as(m, null, function (c) { return threwDead(c, function () { c._requireSession_("x"); }) !== 'dead'; }); });
mutant("a mode switch that reads a script property is caught",
  'function _effectiveRole_(claimedRole) {\n',
  'function _effectiveRole_(claimedRole) {\n  if (PropertiesService.getScriptProperties().getProperty("AUTH_ENFORCE") !== "1") return String(claimedRole || "");\n',
  function (m) { return as(m, TEACHER, function (c) { return c._isMasterRole_("master"); }); });
mutant("dropping the admin-level rule from _hasPerm_ is caught",
  '  if (_isAdminLevel_(role)) return true;\n  const p = _effectivePerms_(perms);',
  '  const p = _effectivePerms_(perms);',
  function (m) { return as(m, { role: "teacher", id: "T2", permissions: "", adminUser: true }, function (c) { return !c._hasPerm_("", "", "view_students"); }); });

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
