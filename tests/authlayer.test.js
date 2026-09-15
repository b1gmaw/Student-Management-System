// The guard layer: role and permissions come from the resolved session, not from
// what the browser sent. Measured against production before this change:
//   google.script.run.getDashboardData("teacher", false)  →  608 student records
//
// The design keeps every signature intact — role sits in argument 1, 3 or 4
// depending on the function — and instead makes the five guard helpers ignore
// what they were passed. That fixes ~93 call sites without touching one, but it
// creates two traps this suite exists to pin down:
//
//   §4  a role that describes SOMEBODY ELSE (the user being saved, the row being
//       resolved) must still be read literally, or master login breaks and an
//       admin can grant the master role;
//   §5  observe mode must not change behaviour, or turning it on is the outage
//       it exists to prevent.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Code.js ----
let authUser = null;
let enforcing = false;
let mismatches = [];

function effectiveRole(claimed) {
  if (enforcing) return authUser ? String(authUser.role || "") : "";
  if (authUser && String(authUser.role || "") !== String(claimed || "")) {
    mismatches.push(String(claimed));
  }
  return String(claimed || "");
}
function effectivePerms(claimed) {
  if (enforcing) return authUser ? authUser.permissions : "";
  return claimed;
}
function isMasterRole(role) { return effectiveRole(role) === "master"; }
function isMasterRoleLiteral(role) { return String(role || "") === "master"; }
function isAdminRole(role) {
  const r = effectiveRole(role);
  return r === "admin" || r === "master";
}
function hasPerm(role, perms, needed) {
  if (isMasterRole(role)) return true;
  const p = effectivePerms(perms);
  if (!p) return false;
  const list = Array.isArray(p) ? p : String(p).split(",").map(s => s.trim());
  return list.indexOf(needed) !== -1;
}
function roleIsAnyOf(role, allowed) {
  const r = effectiveRole(role);
  if (r === "master" || r === "admin") return true;
  return allowed.indexOf(r) !== -1;
}
function requireSession(what) {
  if (authUser) return authUser;
  if (!enforcing) { mismatches.push("(no role argument)"); return null; }
  throw new Error("セッションがありません。再度ログインしてください。");
}

function as(user, enforce, fn) {
  authUser = user; enforcing = enforce; mismatches = [];
  try { return fn(); } finally { authUser = null; enforcing = false; }
}
const TEACHER = { role: "teacher", id: "T1", name: "甲野", permissions: "view_teacher_schedule" };
const SALES   = { role: "sales",   id: "S1", name: "乙山", permissions: "view_admissions,edit_admissions" };
const MASTER  = { role: "master",  id: "MASTER", name: "システム", permissions: "ALL" };

console.log("\n1. enforcing: the argument is ignored");
{
  // THE attack, verbatim. A teacher session claiming to be master.
  as(TEACHER, true, function () {
    check("a teacher claiming master is not master", !isMasterRole("master"), "privilege escalation by argument");
    check("a teacher claiming admin is not admin", !isAdminRole("admin"), "privilege escalation by argument");
    check("claimed permissions are ignored", !hasPerm("master", "ALL", "view_students"),
      "the browser sent perms:'ALL' and was believed");
    check("the session's own permission still works", hasPerm("teacher", "", "view_teacher_schedule"),
      "a real permission must survive being ignored");
  });
  as(MASTER, true, function () {
    check("a real master IS master even claiming teacher", isMasterRole("teacher"),
      "the session decides, in both directions");
    check("master passes any permission", hasPerm("teacher", "", "anything_at_all"), "");
  });
}

console.log("\n2. no session, enforcing");
{
  // An anonymous caller: no token, so nothing is parked.
  as(null, true, function () {
    check("no session is not master", !isMasterRole("master"), "anonymous caller reached master");
    check("no session is not admin", !isAdminRole("admin"), "anonymous caller reached admin");
    check("no session holds no permission", !hasPerm("admin", "ALL", "view_students"),
      "this is the getDashboardData('teacher') hole");
    check("no session is not sales", !roleIsAnyOf("sales", ["sales"]), "");
    let threw = false;
    try { requireSession("getSchedule"); } catch (e) { threw = true; }
    check("_requireSession_ throws with no session", threw, "endpoints with no role argument must refuse");
  });
}

console.log("\n3. _roleIsAnyOf_ replaces the half-fixed inline check");
{
  // The old shape was:  !_isAdminRole_(userRole) && userRole !== "sales"
  // _isAdminRole_ consulted the session, but the comparison beside it read the
  // client's string — so passing "sales" walked straight through.
  const oldShape = function (claimed) { return isAdminRole(claimed) || claimed === "sales"; };
  as(TEACHER, true, function () {
    check("the OLD inline shape let a teacher through as sales", oldShape("sales") === true,
      "this is why the comparison had to move into the helper");
    check("_roleIsAnyOf_ does not", !roleIsAnyOf("sales", ["sales"]),
      "the claimed string still reached the decision");
  });
  as(SALES, true, function () {
    check("a real sales session passes", roleIsAnyOf("anything", ["sales"]), "");
    check("sales is refused a teacher-only endpoint",
      !roleIsAnyOf("x", ["teacher"]), "");
  });
  as(MASTER, true, function () {
    check("master passes regardless of the allowed list", roleIsAnyOf("x", ["teacher"]),
      "master bypasses every check, as everywhere else");
  });
}

console.log("\n4. identity checks must stay literal");
{
  // _resolveUserById_ runs INSIDE resumeSession, before any session is parked.
  // With the session-aware helper it returns false for the master row, the
  // lookup falls through to Staff_Master, finds nothing, and every master
  // session is revoked on resume.
  as(null, true, function () {
    check("the master row resolves with no session parked", isMasterRoleLiteral("master"),
      "master login would break entirely");
    check("the session-aware helper would NOT have", !isMasterRole("master"),
      "this is the difference the literal version exists for");
  });
  // saveSystemUser asks "is the role being ASSIGNED master". The session-aware
  // version reads the CALLER instead, so an admin assigning role=master to
  // somebody would sail past the check.
  as({ role: "admin", id: "A1", name: "管理", permissions: "manage_users" }, true, function () {
    check("assigning role=master is caught", isMasterRoleLiteral("master"),
      "an admin could grant somebody the master role");
    check("the session-aware helper would have missed it", !isMasterRole("master"),
      "it would have compared the caller's role, not the assigned one");
  });
}

console.log("\n5. observe mode changes nothing, and says so");
{
  // The whole point: behaviour identical to before, disagreements recorded.
  as(TEACHER, false, function () {
    check("observing, a claimed role is still believed", isMasterRole("master"),
      "observe mode must not change behaviour — that is what makes it safe to roll out");
    check("and the disagreement is recorded", mismatches.length > 0,
      "a silent observe window teaches nothing");
  });
  as(TEACHER, false, function () {
    isMasterRole("teacher");
    check("no entry when the claim matches the session", mismatches.length === 0,
      "normal use must not fill the log: " + JSON.stringify(mismatches));
  });
  as(null, false, function () {
    check("observing, an anonymous caller still gets through", isMasterRole("master"),
      "OBSERVE MODE CLOSES NOTHING — it measures. Only the flip to AUTH_ENFORCE=1 fixes this.");
  });
  // Permissions follow the same rule, or a screen would break in observe mode.
  as(TEACHER, false, function () {
    check("observing, claimed permissions still apply", hasPerm("teacher", "view_students", "view_students"), "");
  });
}

console.log("\n6. the enforcing default is fail-closed");
{
  // Every ambiguous state must land on deny.
  [null, undefined, { role: "", id: "", permissions: "" }].forEach(function (u) {
    as(u, true, function () {
      check("session " + JSON.stringify(u && u.role) + " grants nothing",
        !hasPerm("master", "ALL", "view_students") && !isAdminRole("admin"),
        "an empty or missing session must deny, never default to allow");
    });
  });
  as({ role: "teacher", id: "T", name: "x", permissions: null }, true, function () {
    check("null permissions deny rather than throw",
      hasPerm("teacher", "ALL", "view_students") === false, "");
  });
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
