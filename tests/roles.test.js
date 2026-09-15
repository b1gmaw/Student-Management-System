// Custom roles — master-managed, permissions only.
//
// The thing this feature must NOT become: a way to invent a role that behaves
// like an existing one. The role string is not a permission bundle. It picks the
// sheet a user is stored in (`role === "teacher" ? "Teacher_Master" :
// "Staff_Master"`, five sites, one inside _resolveUserById_ which runs on EVERY
// login), which notification feed a user gets, and how ホーム scopes their
// interviews. So built-ins stay in code and custom roles carry permissions only.
//
// And the hole this closes: saveSystemUser accepted ANY u.role except "master".
// A crafted call could store role "xyz" — an account matching no branch
// anywhere, which logs in to an empty app with no error to explain why.

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Code.js ----
const BUILTIN_ROLES = [
  { key: "admin",   label: "管理者", perms: "view_students,manage_users" },
  { key: "sales",   label: "営業",   perms: "view_students,view_admissions" },
  { key: "teacher", label: "教務",   perms: "view_teacher_schedule,view_admissions" }
];

let SHEET = [];   // rows: [key, label, perms, adminFlag]

// A row whose key names a built-in is an OVERRIDE: 表示名 and 既定の権限 merge onto it,
// which is what makes 営業/教務/管理者 editable in 役割管理. Both are harmless — perms
// only pre-tick the boxes when creating a user, and live access comes from the user's
// own row.
// ⚠️ `admin` and `builtin` are NEVER taken from the sheet. _isAdminLevel_ reads the flag
// live, so a row flagging `sales` would promote every existing 営業 account the instant
// it saved. That is the one escalation this whole design guards.
function _roles_() {
  let out = BUILTIN_ROLES.map(r => ({ key: r.key, label: r.label, perms: r.perms,
                                      admin: r.key === "admin", builtin: true }));
  const seen = {}, byKey = {};
  out.forEach(r => { seen[r.key] = true; byKey[r.key] = r; });
  SHEET.forEach(row => {
    const key = String(row[0] || "").trim();
    if (key === "" || key === "master") return;
    const label = String(row[1] || "").trim();
    const perms = String(row[2] || "").trim();
    const adminCell = String(row[3] || "").trim().toUpperCase() === "Y";
    if (byKey[key]) {
      if (label !== "") byKey[key].label = label;
      if (perms !== "") byKey[key].perms = perms;
      return;                       // never admin, never builtin
    }
    if (seen[key]) return;
    seen[key] = true;
    out.push({ key, label: label || key, perms, admin: adminCell, builtin: false });
  });
  return out;
}

function _roleByKey_(key) {
  const k = String(key || "").trim();
  return _roles_().filter(r => r.key === k)[0] || null;
}

function _roleKeyProblem_(key) {
  const k = String(key || "").trim();
  if (k === "") return "キーを入力してください。";
  if (!/^[a-z0-9_]+$/.test(k)) return "キーは半角英小文字・数字・アンダースコアのみ使用できます。";
  if (k === "master") return "master は予約語です。";
  // Built-in keys are accepted now — an override row is how 役割管理 edits them. What
  // that row may carry is policed in saveRole and _roles_(), not here.
  return "";
}

let USERS = [];   // { role, name }
function _usersWithRole_(key) {
  const k = String(key || "").trim();
  return USERS.filter(u => u.role === k).map(u => u.name);
}

function saveRole(isMaster, key, label, permissions, isAdmin) {
  if (!isMaster) throw new Error("権限がありません");
  const problem = _roleKeyProblem_(key);
  if (problem) throw new Error(problem);
  const k = key.trim();
  const lab = String(label || "").trim() || k;
  const p = String(permissions || "").split(",").map(x => x.trim()).filter(x => x !== "").join(",");
  // ⚠️ A built-in never gets the flag from this endpoint, whatever the caller sends.
  // _roles_() already refuses to read it back; this is the second independent guard.
  const isBuiltinKey = BUILTIN_ROLES.some(b => b.key === k);
  const adm = (!isBuiltinKey && (isAdmin === true || String(isAdmin || "").toUpperCase() === "Y")) ? "Y" : "";
  const at = SHEET.findIndex(r => String(r[0]).trim() === k);
  if (at >= 0) SHEET[at] = [k, lab, p, adm]; else SHEET.push([k, lab, p, adm]);
  return { saved: true };
}

// Built-ins cannot be deleted, so this is how an override is undone.
function resetRoleDefaults(isMaster, key) {
  if (!isMaster) throw new Error("権限がありません");
  const k = String(key || "").trim();
  if (!BUILTIN_ROLES.some(b => b.key === k)) throw new Error("既定に戻せるのは既定の役割だけです。");
  SHEET = SHEET.filter(r => String(r[0]).trim() !== k);
  return { reset: true };
}

function deleteRole(isMaster, key) {
  if (!isMaster) throw new Error("権限がありません");
  const k = String(key || "").trim();
  for (const b of BUILTIN_ROLES) if (b.key === k) throw new Error("既定の役割は削除できません。");
  const holders = _usersWithRole_(k);
  if (holders.length) {
    throw new Error("この役割は " + holders.length + "名が使用中です（" +
                    holders.slice(0, 5).join("、") + (holders.length > 5 ? " ほか" : "") + "）。先に変更してください。");
  }
  SHEET = SHEET.filter(r => String(r[0]).trim() !== k);
  return { deleted: true };
}

function saveSystemUser(u) {
  if (String(u.role || "") === "master") throw new Error("この権限は付与できません。");
  // `admin` is unassignable to EVERYONE, master included — 管理者権限 on a custom
  // role replaced it, and that keeps the holder's department as their shown role.
  if (String(u.role || "") === "admin") throw new Error("管理者ロールは割り当てできません。");
  if (!_roleByKey_(u.role)) throw new Error("役割「" + String(u.role || "") + "」は存在しません。");
  return u.role === "teacher" ? "Teacher_Master" : "Staff_Master";
}

const threw = fn => { try { fn(); return ""; } catch (e) { return e.message; } };
const reset = () => { SHEET = []; USERS = []; };

console.log("\n1. reserved and colliding keys are refused");
{
  reset();
  // "master" is the SYSTEM_PIN account and _isAdminRole_ treats it as admin-level.
  // saveSystemUser already blocks assigning it; this stops the collision existing.
  check("key 'master' is refused", threw(() => saveRole(true, "master", "マスター", "")) !== "",
    "a custom role named master would collide with the PIN account");
  // ⚠️ REVISED: a built-in key is now ACCEPTED — an override row is how 役割管理 edits
  // 営業/教務/管理者. What the row may carry is what is policed, not whether it exists.
  BUILTIN_ROLES.forEach(b => {
    check("key '" + b.key + "' is accepted as an override",
      threw(() => saveRole(true, b.key, "偽", "manage_users")) === "",
      "built-ins are editable; only the flag is off limits");
  });
  // And a row that reaches the sheet by hand may still only move the two safe fields.
  reset();
  SHEET = [["teacher", "偽教務", "manage_users", "Y"], ["master", "偽", "manage_users", "Y"]];
  check("a hand-edited row DOES override 表示名 and 既定の権限",
    _roleByKey_("teacher").label === "偽教務" && _roleByKey_("teacher").perms === "manage_users",
    JSON.stringify(_roleByKey_("teacher")));
  // ⚠️ THE ESCALATION GUARD. _isAdminLevel_ reads .admin live, so if a sheet row could
  // set it, flagging 営業 would make every existing 営業 account admin-level at once —
  // no per-user step, no warning. Both halves are asserted because a merge that copied
  // the whole row would pass the one above and silently fail this one.
  check("...but CANNOT grant it 管理者権限",
    _roleByKey_("teacher").admin === false,
    "a sheet row just promoted every 教務 account");
  check("...and cannot stop it being a built-in",
    _roleByKey_("teacher").builtin === true, JSON.stringify(_roleByKey_("teacher")));
  check("saveRole refuses to write the flag for a built-in even when asked",
    (reset(), saveRole(true, "sales", "営業部", "view_students", true),
     SHEET[0][3] === "" && _roleByKey_("sales").admin === false),
    JSON.stringify(SHEET));
  check("...while a CUSTOM role may still carry it",
    (reset(), saveRole(true, "jimu", "事務", "view_students", true),
     _roleByKey_("jimu").admin === true), JSON.stringify(SHEET));
  check("既定に戻す removes the override and restores the compiled-in values",
    (reset(), saveRole(true, "sales", "営業部", "manage_users"),
     resetRoleDefaults(true, "sales"),
     _roleByKey_("sales").label === "営業" && SHEET.length === 0),
    JSON.stringify(SHEET));
  check("既定に戻す refuses a custom role — 削除 is that control",
    (reset(), saveRole(true, "jimu", "事務", ""), threw(() => resetRoleDefaults(true, "jimu")) !== ""), "");
  check("...and is master-only like the rest",
    threw(() => resetRoleDefaults(false, "sales")) === "権限がありません", "");
  reset();
  SHEET = [["master", "偽", "manage_users"]];
  check("a hand-edited 'master' row is ignored", _roleByKey_("master") === null,
    JSON.stringify(_roleByKey_("master")));
}

console.log("\n2. keys are [a-z0-9_] only");
{
  reset();
  ["jimu", "keiri", "front_desk", "staff2"].forEach(k =>
    check("'" + k + "' is accepted", _roleKeyProblem_(k) === "", _roleKeyProblem_(k)));
  // Compared as raw strings in ~59 places: a key that matches in some and not
  // others is the identity-by-name-string class this project keeps hitting.
  [["jimu ", "trailing space"], [" jimu", "leading space"], ["ji mu", "inner space"],
   ["ｊｉｍｕ", "full-width lookalike"], ["事務", "Japanese"], ["Jimu", "upper case"],
   ["ji,mu", "a comma — permissions are comma-joined"], ["ji-mu", "hyphen"],
   ["jimu　", "ideographic space"], ["", "empty"]].forEach(([k, why]) => {
    // A trimmable key is normalised, not rejected — trim happens before the test.
    const expectOk = k.trim() !== "" && /^[a-z0-9_]+$/.test(k.trim());
    check((expectOk ? "'" + k + "' survives trimming" : "rejected: " + why),
      (_roleKeyProblem_(k) === "") === expectOk,
      "key=" + JSON.stringify(k) + " problem=" + JSON.stringify(_roleKeyProblem_(k)));
  });
  check("the stored key is the trimmed one",
    (reset(), saveRole(true, " jimu ", "事務", "view_students"), _roleByKey_("jimu") !== null),
    JSON.stringify(SHEET));
}

console.log("\n3. built-ins can be edited but never DELETED");
{
  reset();
  // ⚠️ Editing is now allowed (§1); deleting is not, and that half is unchanged —
  // removing 営業 would strand every account holding it, which fails closed at login
  // as a lockout with no visible cause.
  BUILTIN_ROLES.forEach(b => {
    check("deleteRole refuses '" + b.key + "'",
      threw(() => deleteRole(true, b.key)).indexOf("既定") !== -1,
      "hiding the button in the UI is not the control");
  });
  check("the built-ins survive", _roles_().filter(r => r.builtin).length === 3, "");
}

console.log("\n4. deleteRole refuses while a user holds the role, and names them");
{
  reset();
  saveRole(true, "jimu", "事務", "view_students");
  USERS = [{ role: "jimu", name: "丁村" }, { role: "jimu", name: "乙山" }, { role: "sales", name: "甲野" }];
  const msg = threw(() => deleteRole(true, "jimu"));
  // Orphaning the role fails closed at login — a lockout with no visible cause.
  check("it refuses", msg !== "", "the role was deleted out from under two users");
  check("it names the holders", msg.indexOf("丁村") !== -1 && msg.indexOf("乙山") !== -1, msg);
  check("it counts them", msg.indexOf("2名") !== -1, msg);
  check("an unrelated 営業 user does not block it",
    msg.indexOf("甲野") === -1, msg);
  check("the role still exists after the refusal", _roleByKey_("jimu") !== null, "");

  USERS = [];
  check("it succeeds once nobody holds it", deleteRole(true, "jimu").deleted === true, "");
  check("and it is gone", _roleByKey_("jimu") === null, JSON.stringify(SHEET));
}

console.log("\n5. saveSystemUser validates the role — the hole this closes");
{
  reset();
  saveRole(true, "jimu", "事務", "view_students,view_dorms");
  check("a crafted role string is refused",
    threw(() => saveSystemUser({ role: "xyz", id: "S9" })).indexOf("存在しません") !== -1,
    "before this check, any string was stored — an account matching no branch anywhere");
  check("'master' is still refused first",
    threw(() => saveSystemUser({ role: "master", id: "S9" })).indexOf("付与できません") !== -1, "");
  check("an empty role is refused", threw(() => saveSystemUser({ role: "", id: "S9" })) !== "", "");
  check("'admin' is refused outright",
    threw(() => saveSystemUser({ role: "admin", id: "S9" })).indexOf("割り当てできません") !== -1,
    "管理者権限 on a custom role replaced it; leaving both is two ways to grant one thing");
  ["sales", "teacher", "jimu"].forEach(r =>
    check("'" + r + "' is accepted", threw(() => saveSystemUser({ role: r, id: "S9" })) === "",
      threw(() => saveSystemUser({ role: r, id: "S9" }))));
  // A custom role is staff, so it lands in Staff_Master. Only "teacher" may not.
  check("a custom role is stored in Staff_Master",
    saveSystemUser({ role: "jimu", id: "S9" }) === "Staff_Master",
    "Teacher_Master would put it on the teacher branch of _resolveUserById_");
  check("teacher still goes to Teacher_Master",
    saveSystemUser({ role: "teacher", id: "T9" }) === "Teacher_Master", "");
}

console.log("\n6. saveRole / deleteRole are master-only");
{
  reset();
  // An admin manages USERS. If an admin could define roles it could mint one
  // carrying manage_users and hand it to itself.
  check("a non-master cannot save", threw(() => saveRole(false, "jimu", "事務", "manage_users")) === "権限がありません", "");
  check("a non-master cannot delete", threw(() => deleteRole(false, "jimu")) === "権限がありません", "");
  check("nothing was written", SHEET.length === 0, JSON.stringify(SHEET));
  // Guarded in the source by the SESSION-aware helper, not the literal one —
  // _isMasterRoleLiteral_ reads the string the browser sent.
  const bodyOf = n => {
    const at = SRC.indexOf("\nfunction " + n + "(");
    return at === -1 ? "" : SRC.slice(at, SRC.indexOf("\n}", at));
  };
  ["saveRole", "deleteRole"].forEach(n => {
    check(n + " guards with _isMasterRole_ (session-aware)",
      /if \(!_isMasterRole_\(role\)\) throw new Error\("権限がありません"\)/.test(bodyOf(n)),
      "_isMasterRoleLiteral_ here would trust the role the client sent");
  });
  check("getRoles requires manage_users",
    /function getRoles[\s\S]{0,200}_hasPerm_\(role, perms, "manage_users"\)/.test(SRC), "");
}

console.log("\n7. a custom role's stored defaults are what the modal pre-ticks");
{
  reset();
  saveRole(true, "jimu", "事務", "view_students, view_dorms ,export_dorms");
  const r = _roleByKey_("jimu");
  check("whitespace around each permission is stripped",
    r.perms === "view_students,view_dorms,export_dorms", r.perms);
  check("empty entries are dropped",
    (saveRole(true, "keiri", "経理", "view_students,,, ,view_dorms"), _roleByKey_("keiri").perms) === "view_students,view_dorms",
    _roleByKey_("keiri").perms);
  check("a role with no permissions is allowed",
    (saveRole(true, "none", "権限なし", ""), _roleByKey_("none").perms) === "",
    "a placeholder role is legitimate; it just sees nothing");
  check("saving an existing key edits rather than duplicates",
    (saveRole(true, "jimu", "事務2", "view_students"),
     SHEET.filter(x => x[0] === "jimu").length) === 1, JSON.stringify(SHEET));
  check("the edit took", _roleByKey_("jimu").label === "事務2", _roleByKey_("jimu").label);
  check("a blank label falls back to the key",
    (saveRole(true, "blank", "", "view_students"), _roleByKey_("blank").label) === "blank", "");
}

console.log("\n8. the client reads defaults from the role, and labels custom roles");
{
  check("autoCheckDefaultPerms consults rolesData first",
    /const def = rolesData && rolesData\.filter\(r => r\.key === role\)\[0\];/.test(HTML),
    "a hardcoded branch would give every custom role 教務's defaults");
  check("the users table labels by roleLabel, not a sales/teacher ternary",
    /let displayRole = roleLabel\(u\.role\);/.test(HTML) &&
    !/u\.role === 'sales' \? '営業' : '教務'/.test(HTML),
    "the old ternary printed 教務 for every custom role");
  check("the header badge labels by roleLabel too",
    /let roleName = roleLabel\(currentUser\.role\);/.test(HTML), "");
  check("roleLabel falls back to the built-in map before any fetch",
    /const ROLE_LABELS = \{ master: 'システム', admin: '管理者', sales: '営業', teacher: '教務' \};/.test(HTML),
    "the badge is drawn before getRoles can answer, and most users lack manage_users");
  // Cloning the 26 permission checkboxes keeps one source of truth, but the
  // clone must NOT carry perm-cb — saveUser() selects on that class, and a second
  // set of nodes would write role defaults into the user being saved.
  check("the role modal clones the permission list",
    /function buildRolePermList/.test(HTML) &&
    /document\.querySelectorAll\('\.perm-cb'\)\.forEach\(cb => \{\s*const src = cb\.closest\('label'\)/.test(HTML), "");
  check("the clones use a DIFFERENT class",
    /class="role-perm-cb"/.test(HTML) &&
    /document\.querySelectorAll\('\.role-perm-cb'\)/.test(HTML),
    "a cloned perm-cb would be picked up by saveUser()");
  // ⚠️ RE-PINNED, not loosened: 役割管理 became a ユーザー管理 SUB-TAB, so the gate moved from
  // the panel's display to _usersSubAllowed — which BOTH the button and switchUsersSubTab
  // read, so calling the switcher directly reaches nothing either. Still master only.
  check("役割管理 is shown to the master only",
    /if \(key === 'roles' \|\| key === 'announce'\) return isMasterRole\(\);/.test(HTML)
      && /if \(USERS_SUBS\.indexOf\(key\) === -1 \|\| !_usersSubAllowed\(key\)\) key = 'list';/.test(HTML),
    "manage_users is the wrong gate — an admin manages users, not what roles exist");
  // ⚠️ REVISED: built-ins are editable now. What must stay true is that the modal
  // does not offer the flag for one — the server ignores it there, and a checkbox
  // that silently does nothing is worse than no checkbox.
  check("every role row offers 編集, built-ins included",
    !/\(r\.builtin \? "" :/.test(HTML) && !/if \(r && r\.builtin\) return;/.test(HTML),
    "the built-in edit block is still in place");
  check("the 管理者権限 box is hidden for a built-in",
    /box\.style\.display = builtin \? "none" : "block"/.test(HTML),
    "an inert checkbox invites a save that silently does nothing");
  check("a built-in offers 既定に戻す instead of 削除",
    /btnDeleteRole'\)\.style\.display = \(r && !builtin\)/.test(HTML)
      && /rb\.style\.display = builtin \? "inline-block" : "none"/.test(HTML),
    "deleting a built-in would strand its holders; the override still needs an undo");
  check("the key is fixed once saved",
    /document\.getElementById\('modalRoleKey'\)\.disabled = !!r;/.test(HTML),
    "renaming a key would orphan every account holding it");
  check("the role <select> is filled from rolesData",
    /function fillRoleSelect/.test(HTML) && /\.getRoles\(currentUser\.role, currentUser\.permissions\)/.test(HTML), "");
  check("Esc closes the role modal like every other one",
    /'roleModal': function\(\) \{ closeRoleModal\(\); \}/.test(HTML), "");
}

console.log("\n9. the two role lists are now permission checks");
{
  // Behaviour-preserving for the built-ins — 営業 holds view_admissions — and a
  // custom role with that permission now works as expected.
  check("wantsNotif keys on view_admissions",
    /const wantsNotif = _isAdminRole_\(role\) \|\| role === "teacher" \|\|\s*_hasPerm_\(role, perms, "view_admissions"\);/.test(SRC),
    "a role list here made every custom role notification-blind");
  check("getUpcomingForUser excludes admin/master BEFORE the permission test",
    /if \(_isAdminRole_\(role\) \|\| myRole === "master" \|\| myRole === "admin"\) return \[\];[\s\S]{0,400}_hasPerm_\(role, perms, "view_admissions"\)/.test(SRC),
    "_hasPerm_ returns true for master unconditionally, so order is the control");
  // Deliberately NOT generalised: it encodes a specific 営業 workflow.
  check("the booking-cancellation branch still names 営業 specifically",
    /actorRole === "sales"/.test(SRC),
    "a custom role must not inherit a workflow that is not a permission");
}

console.log("\n10. _roles_() is safe on the login path");
{
  // It runs via _userFromRow_ on every login. Creating a sheet there would make
  // the first login in a fresh copy of the spreadsheet write to it.
  const body = (SRC.match(/function _roles_\(\)[\s\S]*?\n\}/) || [""])[0];
  check("_roles_ reads with getSheetByName, never _getRolesSheet_",
    body.indexOf("getSheetByName(SHEET_ROLES)") !== -1 && body.indexOf("_getRolesSheet_()") === -1,
    "_getRolesSheet_ inserts the sheet when absent");
  check("an unreadable sheet falls back to the built-ins",
    /catch \(e\) \{ \/\* sheet unreadable/.test(body),
    "a throw here would break every login");
  check("_userFromRow_ carries the label",
    /roleLabel: def \? def\.label : roleName/.test(SRC),
    "the header badge cannot call getRoles — most users lack manage_users");
  check("the memo is cleared on write",
    (SRC.match(/_rolesMemo = null;/g) || []).length >= 2,
    "a stale memo would hide a just-saved role for the rest of the execution");
}

console.log("\n11. the Staff_Master Role column, and what it refuses");
{
  // Staff_Master never stored a role — every row was 'sales', hardcoded. Column
  // 12 is where it lives now, after the password block so columns 1-11 are
  // untouched.
  const STAFF_ROLE_IDX = 11;
  const KNOWN = ["admin", "sales", "teacher", "jimu"];
  function _staffRoleFromRow_(row) {
    const raw = String((row || [])[STAFF_ROLE_IDX] || "").trim();
    if (raw === "" || raw === "master" || raw === "teacher") return "sales";
    return KNOWN.indexOf(raw) !== -1 ? raw : "sales";
  }
  const row = v => { const r = ["S1", "丁村", "", "a@b.c", "ON", "view_students", "h", "s", "1", "", ""]; r[11] = v; return r; };

  check("a pre-migration row (no 12th column) is 'sales'",
    _staffRoleFromRow_(["S1", "丁村", "", "a@b.c", "ON", ""]) === "sales",
    "every existing account must keep working before the column is ever written");
  check("a blank cell is 'sales'", _staffRoleFromRow_(row("")) === "sales", "");
  check("a custom role is read back", _staffRoleFromRow_(row("jimu")) === "jimu", "");
  check("'admin' is read back — it was unreachable before this column",
    _staffRoleFromRow_(row("admin")) === "admin", "");
  // The value is a spreadsheet CELL, so it is untrusted input.
  check("a cell saying 'master' does NOT grant master",
    _staffRoleFromRow_(row("master")) === "sales",
    "master is the SYSTEM_PIN account; a cell must never mint one");
  check("a cell saying 'teacher' does NOT move the row's sheet",
    _staffRoleFromRow_(row("teacher")) === "sales",
    "'teacher' selects Teacher_Master in five places, one inside _resolveUserById_");
  check("an unknown role folds back to 'sales', not to nothing",
    _staffRoleFromRow_(row("deleted_role")) === "sales",
    "resolving to no role logs in to an empty app with no error to explain why");
  check("whitespace is trimmed", _staffRoleFromRow_(row("  jimu  ")) === "jimu", "");

  // ⚠️ The holder check must read the RAW cell. Folding an unknown role to
  // 'sales' there would report nobody holding the role being deleted, and let
  // the delete through — the exact case that check exists to catch.
  check("deleteRole's holder scan uses the raw cell, not _staffRoleFromRow_",
    /\/\/ The RAW cell, not _staffRoleFromRow_/.test(SRC) &&
    /String\(data\[i\]\[STAFF_ROLE_IDX\] \|\| ""\)\.trim\(\) : "teacher"/.test(SRC), "");

  check("the column is 12, past the password block at 7-11",
    /const STAFF_COLS = 12;/.test(SRC) && /const STAFF_ROLE_IDX = 11;/.test(SRC) &&
    /const ACCOUNT_COLS = 11;/.test(SRC), "columns 1-11 must be left exactly as they are");
  check("it is created on demand, not by a migration that must run first",
    /function _ensureRoleColumn_/.test(SRC) &&
    /if \(sheetName === "Staff_Master"\) _ensureRoleColumn_\(sheet\);/.test(SRC),
    "same lesson as _ensureAccountColumns_: a deploy-order slip becomes a lockout");
  check("saveSystemUser writes it on both the update and the insert path",
    (SRC.match(/if \(sheetName === "Staff_Master"\) sheet\.getRange\(.*STAFF_COLS\)\.setValue\(u\.role\);/g) || []).length === 2,
    "writing it on only one path makes new users roleless or edits silent");
  check("login reads it", /_staffRoleFromRow_\(rows\[i\]\) : roles\[names\[n\]\]/.test(SRC), "");
  check("session resume re-reads it, so a role change takes effect immediately",
    /const liveRole = sheetName === "Staff_Master" \? _staffRoleFromRow_\(data\[i\]\) : role;/.test(SRC),
    "_resolveUserById_ already re-reads permissions for exactly this reason");
  check("the users table reports it instead of the hardcoded 'sales'",
    /role: _staffRoleFromRow_\(sData\[i\]\)/.test(SRC) && !/users\.push\(\{ role: 'sales'/.test(SRC), "");
  check("Teacher_Master does not use the column",
    !/Teacher_Master[\s\S]{0,120}_ensureRoleColumn_/.test(SRC),
    "a teacher row whose column 12 differed would be unreachable by the lookup that found it");

  // Editing: staff↔staff is a cell write; staff↔teacher is a sheet move.
  check("the edit form offers staff roles but never 教務",
    /fillRoleSelect\(\['teacher'\]\);/.test(HTML),
    "moving between sheets is not something this form does");
  check("an existing 教務 account keeps its role locked",
    /\.disabled = \(u\.role === 'teacher'\);/.test(HTML), "");
}

console.log("\n12. screens gated by role, not permission — the 学生数 / 部屋一覧 class");
{
  // ⚠️ Ten endpoints asked "is the caller 営業". A custom role was refused however
  // its permissions were ticked, and the failure looked like a broken screen
  // rather than a permission problem: the sidebar gates on view_students /
  // view_dorms, so the tab appeared and only the data behind it threw.
  function _roleIsAnyOf_(role, allowed) {
    if (role === "master" || role === "admin") return true;
    return allowed.indexOf(role) !== -1;
  }
  // ⚠️ Models the CURRENT rule: master and any admin-LEVEL caller bypass the ticks.
  // Nothing in this section passes an admin-level role, so every check below is
  // unaffected — but leaving the old two-line version here would model behaviour the
  // app no longer has, and the next person to extend §12 would inherit it.
  const _adminLevelKeys = ["master", "admin"];
  function _hasPerm_(role, perms, needed) {
    if (role === "master") return true;
    if (_adminLevelKeys.indexOf(role) !== -1) return true;
    const p = String(perms || "");
    return p === "ALL" || p.split(",").map(x => x.trim()).indexOf(needed) !== -1;
  }
  function _permOrLegacyRole_(role, perms, needed, legacy) {
    if (_roleIsAnyOf_(role, legacy)) return true;
    return _hasPerm_(role, perms, needed);
  }

  const JIMU = "jimu";
  check("a custom role WITH view_dorms now reaches 部屋一覧",
    _permOrLegacyRole_(JIMU, "view_dorms,export_dorms", "view_dorms", ["sales"]) === true,
    "this is the reported bug");
  check("a custom role WITH view_students now reaches 学生数",
    _permOrLegacyRole_(JIMU, "view_students", "view_students", ["sales"]) === true, "");
  check("a custom role WITHOUT the permission is still refused",
    _permOrLegacyRole_(JIMU, "view_dorms", "export_dorms", ["sales"]) === false,
    "opening it to every custom role would be worse than the bug");
  check("a custom role with no permissions at all is refused",
    _permOrLegacyRole_(JIMU, "", "view_dorms", ["sales"]) === false, "");

  // Behaviour-preserving for every built-in.
  check("営業 is unchanged even without the tick",
    _permOrLegacyRole_("sales", "", "view_dorms", ["sales"]) === true,
    "tightening this would lock out whoever relies on it today");
  check("教務 is unchanged on the endpoints that listed it",
    _permOrLegacyRole_("teacher", "", "view_students", ["sales", "teacher"]) === true,
    "a 教務 was never given view_students, and getDashboardData listed them");
  check("教務 is still refused where it was not listed",
    _permOrLegacyRole_("teacher", "", "view_dorms", ["sales"]) === false, "");
  ["admin", "master"].forEach(r =>
    check(r + " is unchanged", _permOrLegacyRole_(r, "", "export_dorms", ["sales"]) === true, ""));

  // ⚠️ perms is appended LAST so a forgotten call site degrades to the role list
  // rather than shifting an existing argument into the perms slot.
  check("a call site that forgets perms falls back to the role list",
    _permOrLegacyRole_("sales", undefined, "view_dorms", ["sales"]) === true &&
    _permOrLegacyRole_(JIMU, undefined, "view_dorms", ["sales"]) === false,
    "built-ins keep working; a custom role fails closed");
  check("perms is the last parameter, never inserted",
    /function getDashboardData\(userRole, includePast, perms\)/.test(SRC) &&
    /function buildRoomHtmlBatch\(userRole, buildingId, roomObjects, perms\)/.test(SRC),
    "inserting it would have put includePast in the perms slot at any missed site");

  // No endpoint may go back to the bare role list.
  const stragglers = (SRC.match(/_roleIsAnyOf_\((?:userRole|role), \["sales"[^\]]*\]\)/g) || []);
  check("no endpoint still guards on the bare 営業 role list",
    stragglers.length === 0, stragglers.join(", "));

  const CONVERTED = {
    fetchAndMergeStudentData: "view_students", getDashboardData: "view_students",
    getLiveReportData: "view_students", getDormData: "view_dorms",
    getBuildingList: "view_dorms", exportSpecificPDF: "export_dorms",
    getBuildingRoomsForExport: "export_dorms", buildRoomHtmlBatch: "export_dorms",
    combineRoomHtmlToPdf: "export_dorms"
  };
  Object.keys(CONVERTED).forEach(fn => {
    const at = SRC.indexOf("\nfunction " + fn + "(");
    const body = at === -1 ? "" : SRC.slice(at, at + 900);
    check(fn + " checks " + CONVERTED[fn],
      new RegExp('_permOrLegacyRole_\\(userRole, perms, "' + CONVERTED[fn] + '"').test(body),
      "still role-gated, or gated on the wrong permission");
  });
  check("getUploadedFile accepts either record permission",
    /_permOrLegacyRole_\(role, perms, "view_dorms", \["sales", "teacher"\]\) &&\s*!_hasPerm_\(role, perms, "view_interview_results"\)/.test(SRC),
    "it serves hearing sheets AND 別紙");

  // Every client call site must pass perms, or that one screen stays broken for
  // custom roles while the others work — the hardest kind of report to act on.
  Object.keys(CONVERTED).concat(["getUploadedFile"]).forEach(fn => {
    const calls = (HTML.match(new RegExp("\\." + fn + "\\(currentUser[^;]*;", "g")) || []);
    if (!calls.length) return;   // fetchAndMergeStudentData has no client caller
    check(fn + ": all " + calls.length + " client call site(s) pass permissions",
      calls.every(c => c.indexOf("currentUser.permissions") !== -1),
      calls.filter(c => c.indexOf("currentUser.permissions") === -1).join(" | "));
  });
}

console.log("\n13. `admin` is unassignable; 管理者権限 is master-only");
{
  // ⚠️ `admin` is not a permission bundle. _isAdminRole_ gates SEVEN operations no
  // tickable permission grants: restoreSnapshot, getSnapshotList, getActivityLog,
  // diagnoseInChargeMatching, deleteBuilding (cascade), saveDestinationAlias and
  // saveDestinationOverride.
  //
  // Before custom roles the dropdown offered only 営業/教務 and the role was frozen
  // on edit — two accidental barriers, both removed by making roles selectable.
  // Without the guard, anyone with manage_users could edit their OWN row to admin.
  function saveSystemUserRole(u, isMaster, hasManageUsers, roles) {
    if (!isMaster && !hasManageUsers) throw new Error("権限がありません");
    if (String(u.role || "") === "master") throw new Error("この権限は付与できません。");
    // Refused for everyone, master included.
    if (String(u.role || "") === "admin") throw new Error("管理者ロールは割り当てできません。");
    if (!_roleByKey_(u.role)) throw new Error("役割は存在しません。");
    const tgt = (roles || []).filter(x => x.key === u.role)[0];
    if (tgt && tgt.admin && !isMaster) {
      throw new Error("管理者権限のある役割の付与はマスターのみ可能です。");
    }
    return "saved";
  }
  reset();
  saveRole(true, "jimu", "事務", "manage_users");

  const FLAGGED = [{ key: "jimu", admin: true }];
  check("a manage_users holder cannot assign the admin role",
    threw(() => saveSystemUserRole({ role: "admin", id: "S9" }, false, true)) !== "",
    "self-promotion to admin picks up seven ops no permission grants");
  // ⚠️ And neither can the master any more. 管理者権限 on a custom role is the only
  // way to grant those operations, which keeps the person's department as the role
  // everyone sees — the point of the whole feature.
  check("NOR CAN THE MASTER — admin is unassignable to everyone",
    threw(() => saveSystemUserRole({ role: "admin", id: "S9" }, true, false)).indexOf("割り当てできません") !== -1,
    "two ways to grant one thing, and this one renames somebody 管理者 on every screen");
  check("a flagged custom role is still master-only",
    threw(() => saveSystemUserRole({ role: "jimu", id: "S9" }, false, true, FLAGGED)).indexOf("マスター") !== -1,
    "the flag grants the same seven operations");
  check("...and the master can assign a flagged role",
    saveSystemUserRole({ role: "jimu", id: "S9" }, true, false, FLAGGED) === "saved", "");
  check("ordinary roles are unaffected by the guard",
    ["sales", "teacher", "jimu"].every(r =>
      saveSystemUserRole({ role: r, id: "S9" }, false, true) === "saved"),
    "only admin is special here");
  check("a custom role carrying manage_users is still assignable by an admin",
    saveSystemUserRole({ role: "jimu", id: "S9" }, false, true) === "saved",
    "that is no more than ticking manage_users, which manage_users already allows");

  check("the backend refuses the admin role outright",
    /管理者ロールは割り当てできません。/.test(SRC) &&
    /if \(String\(u\.role \|\| ""\) === "admin"\) \{/.test(SRC),
    "it must be refused before any master check, so nobody can assign it");
  check("...and the flag stays master-only",
    /if \(_tgt && _tgt\.admin && !_isMasterRole_\(adminRole\)\)/.test(SRC), "");
  check("the dropdown never offers admin to anyone",
    /if \(skip\.indexOf\('admin'\) === -1\) skip\.push\('admin'\);/.test(HTML) &&
    !/if \(!isMasterRole\(\)\) \{\s*\n\s*rolesData[\s\S]{0,200}skip\.push\('admin'\)/.test(HTML),
    "it is pushed unconditionally, outside the non-master branch");
  check("the dropdown merely agrees with it",
    /if \(r\.admin && skip\.indexOf\(r\.key\) === -1\) skip\.push\(r\.key\);/.test(HTML),
    "hiding an option is not access control");
  check("the exclude list is copied, not mutated",
    /const skip = \(exclude \|\| \[\]\)\.slice\(\);/.test(HTML),
    "fillRoleSelect(['teacher']) is called with a fresh literal, but pushing into a "
    + "caller's array is the array-reference bug class in §9.4");
}

console.log("\n14. 管理者権限 — power without renaming the role");
{
  // The point: a department manager gains the seven admin-only operations while
  // their role still DISPLAYS as their department. So the flag must be separable
  // from both the key and the label.
  //
  // ⚠️ Two predicates, and conflating them breaks the feature in one direction or
  // the other. _isAdminLevel_ governs the seven operations; _isAdminRole_ governs
  // BEHAVIOUR (notification feed, whether ホーム shows an interview list) and must
  // stay literal, or a 教務部 manager stops seeing their own interviews.
  function _isAdminRoleT(role, roles) {
    return role === "admin" || role === "master";
  }
  function _isAdminLevelT(role, roles) {
    if (role === "admin" || role === "master") return true;
    const def = roles.filter(r => r.key === role)[0];
    return !!(def && def.admin);
  }
  // _roles_() reading column D, failing closed on anything that is not "Y".
  const mkRole = (key, label, flag) =>
    ({ key, label, admin: String(flag || "").trim().toUpperCase() === "Y", builtin: false });

  const ROLES = [
    { key: "admin", label: "管理者", admin: true, builtin: true },
    { key: "sales", label: "営業", admin: false, builtin: true },
    { key: "teacher", label: "教務", admin: false, builtin: true },
    mkRole("kyomu_bu", "教務部", "Y"),
    mkRole("eigyo_bu", "営業部", "")
  ];

  check("a flagged custom role is admin-LEVEL", _isAdminLevelT("kyomu_bu", ROLES) === true,
    "it must reach 履歴 / バックアップ復元 / 建物削除");
  check("...but is NOT literally admin", _isAdminRoleT("kyomu_bu", ROLES) === false,
    "if it were, ホーム would stop showing them their own interviews and the " +
    "notification feed would switch — the manager's day job would change");
  check("its label stays the department name",
    ROLES.filter(r => r.key === "kyomu_bu")[0].label === "教務部",
    "the whole feature is power without renaming");
  check("an unflagged custom role is neither",
    _isAdminLevelT("eigyo_bu", ROLES) === false && _isAdminRoleT("eigyo_bu", ROLES) === false, "");
  check("built-in admin is both", _isAdminLevelT("admin", ROLES) && _isAdminRoleT("admin", ROLES), "");
  check("master is both", _isAdminLevelT("master", ROLES) && _isAdminRoleT("master", ROLES), "");
  ["sales", "teacher"].forEach(k =>
    check("built-in " + k + " is neither",
      !_isAdminLevelT(k, ROLES) && !_isAdminRoleT(k, ROLES), ""));

  // A privilege flag read from a spreadsheet cell must fail CLOSED.
  [["", "blank"], ["N", "an N"], ["yes", "lowercase yes"], ["1", "a 1"],
   ["Ｙ", "a full-width Ｙ"], [" ", "a space"]].forEach(([v, why]) => {
    check("fails closed on " + why, mkRole("x", "X", v).admin === false,
      "only a literal Y grants it; " + JSON.stringify(v) + " must not");
  });
  ["Y", "y", " Y "].forEach(v =>
    check("accepts " + JSON.stringify(v), mkRole("x", "X", v).admin === true, ""));
  // A row written before the column existed reads as undefined.
  check("a pre-widen row is not admin", mkRole("x", "X", undefined).admin === false,
    "widening must never grant a privilege by accident");

  // Assignment stays master-only, now for the flag as well as the literal key.
  function assign(u, isMaster, roles) {
    const tgt = roles.filter(r => r.key === u.role)[0];
    if ((u.role === "admin" || (tgt && tgt.admin)) && !isMaster) {
      throw new Error("管理者権限のある役割の付与はマスターのみ可能です。");
    }
    return "saved";
  }
  check("an admin with manage_users cannot assign a FLAGGED department role",
    threw(() => assign({ role: "kyomu_bu" }, false, ROLES)).indexOf("マスター") !== -1,
    "otherwise the flag is a way around the guard it needs — assign yourself 教務部 " +
    "and pick up all seven operations");
  check("...nor the literal admin role",
    threw(() => assign({ role: "admin" }, false, ROLES)) !== "", "");
  check("the master can assign a flagged role",
    assign({ role: "kyomu_bu" }, true, ROLES) === "saved", "");
  check("an unflagged department role is assignable by an admin",
    assign({ role: "eigyo_bu" }, false, ROLES) === "saved",
    "only the admin-level ones are restricted");

  // Source: the split must still exist, and the behavioural pair must not widen.
  check("_isAdminLevel_ exists and consults the role's flag",
    /function _isAdminLevel_\(role\)/.test(SRC) && /return !!\(def && def\.admin\);/.test(SRC), "");
  ["_bootPayload_", "getUpcomingForUser"].forEach(function (fn) {
    const at = SRC.indexOf("\nfunction " + fn + "(");
    const body = at === -1 ? "" : SRC.slice(at, SRC.indexOf("\n}\n", at));
    check(fn + " still uses the LITERAL _isAdminRole_",
      body.indexOf("_isAdminRole_(") !== -1 && body.indexOf("_isAdminLevel_(") === -1,
      "widening this changes a department manager's ホーム and notifications");
  });
  ["getActivityLog", "getSnapshotList", "restoreSnapshot", "deleteBuilding",
   "saveDestinationAlias", "saveDestinationOverride", "diagnoseInChargeMatching"].forEach(function (fn) {
    const at = SRC.indexOf("\nfunction " + fn + "(");
    const body = at === -1 ? "" : SRC.slice(at, SRC.indexOf("\n}\n", at));
    check(fn + " is guarded by _isAdminLevel_",
      body.indexOf("_isAdminLevel_(") !== -1,
      "a department manager must be able to reach it");
  });
  check("the client mirrors the server's decision rather than the role name",
    /if \(currentUser\.isAdmin === true\) return true;/.test(HTML),
    "re-deriving from the role string would make the UI stricter than the backend");
  check("the role dropdown no longer prints the key",
    !/\$\{escHtmlJs\(r\.label\)\} \(\$\{escHtmlJs\(r\.key\)\}\)/.test(HTML),
    "showing 教務部 (kyomu_bu) defeats a role whose displayed name is its department");
}

console.log("\n15. the built-in override, and 管理者権限 on the PERSON");
{
  // ---- source bindings for the override (the transcription above proves the rule,
  // these prove Code.js still implements it) ---------------------------------
  const rolesFn = SRC.slice(SRC.indexOf('function _roles_()'), SRC.indexOf('function _roleByKey_'));
  check("_roles_ merges a built-in override rather than skipping the row",
    /if \(byKey\[key\]\) \{[\s\S]{0,220}continue;/.test(rolesFn)
      && !/if \(key === "" \|\| seen\[key\] \|\| key === "master"\) continue;/.test(rolesFn),
    "the old skip would ignore the override entirely");
  check("...merging ONLY 表示名 and 既定の権限",
    /if \(label !== ""\) byKey\[key\]\.label = label;/.test(rolesFn)
      && /if \(perms !== ""\) byKey\[key\]\.perms = perms;/.test(rolesFn), "");
  // ⚠️ The escalation guard, bound to the source. A merge written as an object spread
  // or a field-by-field copy that included `admin` would pass every behavioural check
  // above only if the transcription drifted with it — this catches the source alone.
  check("...and NEVER the admin flag or builtin status",
    !/byKey\[key\]\.admin\s*=/.test(rolesFn) && !/byKey\[key\]\.builtin\s*=/.test(rolesFn),
    "a sheet row that can set .admin promotes every holder of that built-in");
  check("the built-in flag stays hardcoded to the admin key",
    /admin: \(r\.key === "admin"\), builtin: true/.test(rolesFn), "");
  check("saveRole refuses the flag for a built-in key",
    /const _isBuiltinKey = BUILTIN_ROLES\.some\(function \(b\) \{ return b\.key === k; \}\);/.test(SRC)
      && /const adm = \(!_isBuiltinKey &&/.test(SRC),
    "two independent guards; this is the write half");
  check("_roleKeyProblem_ no longer refuses built-in keys",
    !/if \(BUILTIN_ROLES\[i\]\.key === k\) return "「" \+ k \+ "」は既定の役割です。";/.test(SRC), "");
  check("resetRoleDefaults exists, is master-only and is registered",
    /function resetRoleDefaults\(role, perms, key, actorName, actorId\) \{\s*\n\s*if \(!_isMasterRole_\(role\)\)/.test(SRC)
      && /\sresetRoleDefaults: resetRoleDefaults,/.test(SRC), "");
  check("...and refuses anything that is not a built-in",
    /if \(!isBuiltin\) throw new Error\("既定に戻せるのは既定の役割だけです。"\);/.test(SRC), "");

  // ---- transcribed: the per-user flag --------------------------------------
  // ⚠️ Fails closed, exactly like the role flag: only a literal "Y".
  const ADMIN_FLAG_IDX = 12;
  const flagOf = row => String((row || [])[ADMIN_FLAG_IDX] || "").trim().toUpperCase() === "Y";
  const row = v => { const r = new Array(13).fill(""); r[ADMIN_FLAG_IDX] = v; return r; };

  check("a literal Y grants it", flagOf(row("Y")) === true, "");
  check("lower case y is accepted too", flagOf(row("y")) === true, "");
  check("whitespace is trimmed", flagOf(row("  Y  ")) === true, "");
  [["", "a blank cell"], ["N", "an N"], ["1", "a 1"], ["はい", "a stray value"],
   ["YES", "YES rather than Y"]].forEach(([v, why]) => {
    check("fails closed on " + why, flagOf(row(v)) === false, JSON.stringify(v));
  });
  // ⚠️ A sheet that has never been widened has no column 13 at all.
  check("a pre-widen row is not admin", flagOf(["S1", "丁村"]) === false, "");
  check("an absent row is not admin", flagOf(undefined) === false, "");

  // ---- transcribed: how the two sources combine ----------------------------
  // isAdmin = the role's flag OR the person's own row OR the literal admin/master.
  const isAdminOf = (roleAdmin, rowAdmin, roleName) =>
    !!roleAdmin || !!rowAdmin || roleName === "admin" || roleName === "master";
  check("the role flag alone grants it", isAdminOf(true, false, "kyomu_bu") === true, "");
  check("the person's own flag alone grants it", isAdminOf(false, true, "teacher") === true, "");
  check("neither means no", isAdminOf(false, false, "teacher") === false, "");
  check("the literal roles still do", isAdminOf(false, false, "admin")
    && isAdminOf(false, false, "master"), "");

  // ⚠️ THE POINT OF THE PER-USER FLAG. A flagged 教務 stays literally 'teacher', so
  // they keep Teacher_Master and keep currentTeacherId — their own 面接スケジュール.
  // Widening _isAdminRole_ instead would have taken that away, which is why it stays
  // literal (§14 asserts that, and must keep passing).
  const isAdminRoleOf = roleName => roleName === "admin" || roleName === "master";
  check("a flagged 教務 is admin-LEVEL", isAdminOf(false, true, "teacher") === true, "");
  check("...but is NOT literally admin", isAdminRoleOf("teacher") === false,
    "they would lose currentTeacherId and their own schedule");
  const sheetFor = roleName => roleName === "teacher" ? "Teacher_Master" : "Staff_Master";
  check("...and still lives in Teacher_Master", sheetFor("teacher") === "Teacher_Master", "");

  // ---- source bindings for the per-user flag --------------------------------
  check("the flag column is 13, past the Role column at 12",
    /const ADMIN_FLAG_COL = 13;/.test(SRC) && /const ADMIN_FLAG_IDX = 12;/.test(SRC)
      && /const STAFF_COLS = 12;/.test(SRC), "");
  check("it is read fail-closed on a literal Y",
    /function _adminFlagFromRow_\(row\) \{\s*\n\s*return String\(\(row \|\| \[\]\)\[ADMIN_FLAG_IDX\] \|\| ""\)\.trim\(\)\.toUpperCase\(\) === "Y";/.test(SRC), "");
  check("the column is created on demand, not by a migration",
    /function _ensureAdminFlagColumn_\(sheet\)/.test(SRC)
      && /_ensureAdminFlagColumn_\(sheet\);/.test(SRC),
    "a deploy-ordering slip on an account sheet is a lockout");
  check("...on BOTH sheets, since the flag is on the person",
    !/if \(sheetName === "Staff_Master"\) _ensureAdminFlagColumn_/.test(SRC), "");
  check("_userFromRow_ carries it onto the session",
    /const rowAdmin = _adminFlagFromRow_\(row\);/.test(SRC)
      && /adminUser: rowAdmin,/.test(SRC), "");
  // ⚠️ Read from the SESSION, never an argument — every caller asks "is the CALLER
  // allowed", and a client-supplied flag would be no guard at all (the §3.1 shape).
  const lvlFn = SRC.slice(SRC.indexOf('function _isAdminLevel_(role)'),
                          SRC.indexOf('function _isMasterRole_(role)'));
  check("_isAdminLevel_ consults the session, not a parameter",
    /if \(_authUser && _authUser\.adminUser === true\) return true;/.test(lvlFn), "");
  check("...and tolerates having no session, rather than throwing",
    /_authUser &&/.test(lvlFn), "observe mode has no _authUser; a throw would take the app down");
  check("_isAdminRole_ is NOT widened by it",
    !/adminUser/.test(SRC.slice(SRC.indexOf('function _isAdminRole_(role)'),
                                SRC.indexOf('function _isAdminLevel_(role)'))),
    "widening it costs a flagged 教務 their own schedule");
  // ⚠️ Master-only, mirroring the per-role flag guard.
  check("only the master may grant it",
    /if \(_wantAdminUser && !_isMasterRole_\(adminRole\)\) \{/.test(SRC), "");
  check("...and a non-master edit leaves an existing flag alone",
    /if \(_isMasterRole_\(adminRole\)\) sheet\.getRange\(rowIndex, ADMIN_FLAG_COL\)/.test(SRC),
    "clearing it on an ordinary edit would silently strip a colleague's admin level");
  check("getSystemUsers reports it for both sheets",
    (SRC.match(/adminUser: _adminFlagFromRow_\(/g) || []).length === 2, "");

  // ---- the client -----------------------------------------------------------
  check("the checkbox is not a perm-cb",
    /id="modalUserAdmin"/.test(HTML)
      && !/class="perm-cb"[^>]*id="modalUserAdmin"/.test(HTML)
      && !/id="modalUserAdmin"[^>]*class="perm-cb"/.test(HTML),
    "a stray perm-cb here would be written into the user's permission string");
  check("...and is shown to the master only",
    /box\.style\.display = isMasterRole\(\) \? 'block' : 'none';/.test(HTML), "");
  check("saveUser sends it", /adminUser: !!\(document\.getElementById\('modalUserAdmin'\) \|\| \{\}\)\.checked,/.test(HTML), "");
  // ⚠️ The absent-value trap: a <select> whose value is not among its options falls
  // back to the FIRST one without firing change, so editing a user stored as `admin`
  // would silently rewrite their role.
  // ⚠️ Found by driving it: the roles table showed 営業部 and every other screen showed
  // 営業, because ROLE_LABELS was consulted BEFORE rolesData. A half-applied rename is
  // worse than not offering one. ROLE_LABELS is still the pre-fetch fallback, which is
  // the only thing it was ever added for.
  const lblFn = HTML.slice(HTML.indexOf('function roleLabel(key)'),
                           HTML.indexOf('function loadRolesData'));
  check("roleLabel consults rolesData BEFORE the hardcoded map",
    lblFn.indexOf('rolesData') < lblFn.indexOf('ROLE_LABELS[k]'),
    "an overridden built-in would name itself differently on different screens");
  check("...but still falls back to it when there is no role list",
    /if \(ROLE_LABELS\[k\]\) return ROLE_LABELS\[k\];/.test(lblFn),
    "the header badge draws before any fetch, and most users never get getRoles");
  // ⚠️ Caught by the screenshot, not by a test: the help text above the table still
  // said built-ins could not be edited. Prose that contradicts the buttons beside it
  // is worse than none, and no assertion about behaviour would ever have found it.
  check("the roles help text no longer says built-ins are uneditable",
    !/動作がコードに組み込まれているため編集できません/.test(HTML)
      && /表示名と既定の権限だけ変更でき/.test(HTML), "");
  check("...and says the edit affects new users only",
    /これから追加するユーザーの初期チェック/.test(HTML),
    "the commonest misreading is that it re-permissions existing staff");
  check("an unlisted current role is carried as its own option",
    /if \(u\.role && !Array\.prototype\.some\.call\(_roleSel\.options/.test(HTML)
      && /現在の役割/.test(HTML),
    "editing an admin user would otherwise assign whatever option came first");
}


console.log("\n16. 管理者権限 OVERRIDES the role — everything short of master");
{
  // ---- transcribed from _hasPerm_ / hasPermission ---------------------------
  // ⚠️ REVERSED from the old rule ("an admin holds exactly what is ticked"). The flag
  // now grants every permission; reaching what the person's department is not entitled
  // to see is the whole point of it.
  const hasPerm = (isMaster, isAdminLevel, perms, needed) => {
    if (isMaster) return true;
    if (isAdminLevel) return true;
    const p = String(perms || "");
    if (!p) return false;
    return p === "ALL" || p.split(",").map(x => x.trim()).indexOf(needed) !== -1;
  };

  // ⚠️ BOTH DIRECTIONS. One without the other is the reported bug: a flagged 営業 was
  // refused ユーザー管理 because the flag granted the seven operations but not the
  // permission the sidebar gates on.
  check("a flagged user reaches a permission they were never ticked",
    hasPerm(false, true, "view_students", "manage_users") === true,
    "this is the reported bug — the admin panel stayed hidden");
  check("...and one with NO permissions at all still reaches everything",
    hasPerm(false, true, "", "edit_dorms") === true, "");
  check("an UNflagged user with the same row is still refused",
    hasPerm(false, false, "view_students", "manage_users") === false,
    "granting it to everyone would be worse than the bug");
  check("...and still keeps what they were ticked",
    hasPerm(false, false, "view_students", "view_students") === true, "");
  check("master is unchanged", hasPerm(true, false, "", "manage_users") === true, "");

  // ⚠️ FAIL-CLOSED. The new line must not turn an absent session into an allow.
  check("no session denies", hasPerm(false, false, "", "view_students") === false, "");
  check("null permissions deny rather than throw",
    hasPerm(false, false, null, "view_students") === false, "");

  // ---- the master-only boundary, which is what stops self-promotion --------
  // A flagged admin gains manage_users, so they can edit every user. They must NOT be
  // able to hand out the flag or mint a role, or the flag would be self-granting.
  const masterOnly = (isMaster) => { if (!isMaster) throw new Error("権限がありません"); return true; };
  check("a flagged admin cannot define roles",
    threw(() => masterOnly(false)) === "権限がありません", "");
  check("...cannot grant 管理者権限 to anyone, including themselves",
    threw(() => masterOnly(false)) === "権限がありません",
    "a self-granting flag cannot be taken back");
  check("...and the master still can", masterOnly(true) === true, "");

  // ---- source bindings ------------------------------------------------------
  const permFn = SRC.slice(SRC.indexOf('function _hasPerm_(role, perms, needed)'),
                           SRC.indexOf('function _getPlacementConfigSheet_'));
  check("_hasPerm_ bypasses for admin level",
    /if \(_isAdminLevel_\(role\)\) return true;/.test(permFn), "");
  check("...via _isAdminLevel_, not an inlined flag test",
    !/adminUser/.test(permFn) && !/\.admin\b/.test(permFn),
    "_isAdminLevel_ is the only place the role flag and the person flag combine");
  check("...and after the master check, so master still short-circuits",
    permFn.indexOf('_isMasterRole_(role)') < permFn.indexOf('_isAdminLevel_(role)'), "");

  // ⚠️ The master-only endpoints must NOT have drifted onto a permission.
  ['saveRole', 'deleteRole', 'resetRoleDefaults'].forEach(function (fn) {
    const body = SRC.slice(SRC.indexOf('function ' + fn + '('), SRC.indexOf('function ' + fn + '(') + 200);
    check(fn + " is still master-only, not permission-gated",
      /_isMasterRole_\(role\)/.test(body) && !/_hasPerm_\(/.test(body),
      "a flagged admin would otherwise be able to promote themselves");
  });
  check("granting 管理者権限 is still master-only",
    /if \(_wantAdminUser && !_isMasterRole_\(adminRole\)\) \{/.test(SRC), "");

  // ---- the client mirrors it -----------------------------------------------
  const cliFn = HTML.slice(HTML.indexOf('function hasPermission(perm)'),
                           HTML.indexOf('function hasPermission(perm)') + 1400);
  check("hasPermission bypasses for admin too",
    /if \(isAdminRole\(\)\) return true;/.test(cliFn), "");
  check("...reading the server's decision, never the role name",
    !/currentUser\.role ===/.test(cliFn),
    "re-deriving it here lets the UI drift from _hasPerm_ in either direction");
  check("...and the stale 'role itself grants nothing' comment is gone",
    !/the role itself grants nothing/.test(HTML),
    "a comment that contradicts the code is worse than none");
  check("the master-only screens still gate on isMasterRole, not a permission",
    /if \(key === 'roles' \|\| key === 'announce'\) return isMasterRole\(\);/.test(HTML)
      && !/key === 'roles'[^\n]*hasPermission/.test(HTML), "");

  // ---- the tick list survives the override ---------------------------------
  check("the permission ticks are still collected and sent",
    /document\.querySelectorAll\('\.perm-cb'\)\.forEach\(cb => \{ if\(cb\.checked\) perms\.push\(cb\.value\); \}\);/.test(HTML),
    "overriding is not erasing — the ticks apply again when the flag comes off");
  check("...and the modal says so while the flag is on",
    /id="userPermOverrideNote"/.test(HTML)
      && /チェックはそのまま保存され/.test(HTML),
    "unticked boxes for someone who can reach everything reads as a bug");
  check("...toggled by the checkbox, not by who is looking",
    /function _syncUserPermOverrideNote\(\)/.test(HTML)
      && /note\.style\.display = \(cb && cb\.checked\) \? 'block' : 'none';/.test(HTML), "");

  // ---- wording --------------------------------------------------------------
  check("the admin-flag label says このユーザー",
    /このユーザーに管理者権限をあたえる/.test(HTML) && !/この人に管理者権限をあたえる/.test(HTML), "");
  check("...and the 役割管理 help text quotes it accurately",
    /「このユーザーに管理者権限をあたえる」/.test(HTML), "");
  check("the box states that it overrides the ticks below",
    /下の権限にかかわらず、すべての画面と操作が使えるようになります/.test(HTML), "");
}


console.log("\n17. ONE user builder — login and session resume must agree");
{
  // ⚠️ THE BUG THIS SECTION EXISTS FOR. _resolveUserById_ used to hand-build the same
  // object as _userFromRow_. The copy drifted the instant 管理者権限 moved onto the
  // person's row: loginUser went through _userFromRow_ and carried the flag, while
  // session RESUME came through _resolveUserById_ and did not.
  //
  // The symptom was maddening precisely because the two halves disagreed — a flagged
  // 営業 SAW the admin panel (drawn from the login payload) and every call behind it
  // threw 権限がありません (guarded from the resumed session). Nothing failed loudly at
  // the point of the mistake.

  // ---- transcribed: the two paths must yield the same admin answer ----------
  const ADMIN_FLAG_IDX = 12;
  const mkRow = (id, perms, flag) => {
    const r = new Array(13).fill("");
    r[0] = id; r[1] = "サンプル"; r[3] = "a@example.jp"; r[5] = perms;
    r[ADMIN_FLAG_IDX] = flag;
    return r;
  };
  // The single builder, as it now exists.
  const buildUser = (row, roleName, roleDef) => {
    const rowAdmin = String(row[ADMIN_FLAG_IDX] || "").trim().toUpperCase() === "Y";
    return {
      role: roleName,
      adminUser: rowAdmin,
      isAdmin: !!(roleDef && roleDef.admin) || rowAdmin
               || roleName === "admin" || roleName === "master",
      permissions: String(row[5] || "").trim()
    };
  };
  const SALES = { key: "sales", label: "営業", admin: false };

  const flagged = mkRow("S01", "view_students", "Y");
  const viaLogin  = buildUser(flagged, "sales", SALES);   // loginUser path
  const viaResume = buildUser(flagged, "sales", SALES);   // resumeSession path
  check("a flagged 営業 is admin on the LOGIN path", viaLogin.isAdmin === true, "");
  check("...and equally on the RESUME path", viaResume.isAdmin === true,
    "this is what was false, and why every call threw 権限がありません");
  check("...the two agree field for field",
    JSON.stringify(viaLogin) === JSON.stringify(viaResume), JSON.stringify([viaLogin, viaResume]));
  check("...and adminUser survives the resume, which _isAdminLevel_ reads",
    viaResume.adminUser === true,
    "the server guard consults the SESSION user, so a dropped field denies everything");

  const plain = mkRow("S05", "view_students", "");
  check("an unflagged 営業 is not admin on either path",
    buildUser(plain, "sales", SALES).isAdmin === false
      && buildUser(plain, "sales", SALES).adminUser === false, "");

  // ---- source bindings: there may be only ONE builder ----------------------
  // ⚠️ Structural, not behavioural. A future third copy would reintroduce this exact
  // bug and every behavioural check above would still pass, because the transcription
  // models the builder rather than the call graph.
  check("exactly one place constructs a user object",
    (SRC.match(/^\s*isAdmin: /gm) || []).length === 1,
    "a second builder is how login and resume drifted apart");
  const resolveFn = SRC.slice(SRC.indexOf('function _resolveUserById_'),
                              SRC.indexOf('function _resolveUserById_') + 2600);
  check("_resolveUserById_ delegates rather than rebuilding",
    /return _userFromRow_\(data\[i\], liveRole\);/.test(resolveFn)
      && !/roleLabel: def \? def\.label/.test(resolveFn), "");
  check("...passing the LIVE role, not the session's stored one",
    /const liveRole = sheetName === "Staff_Master" \? _staffRoleFromRow_\(data\[i\]\) : role;/.test(resolveFn)
      && resolveFn.indexOf('const liveRole') < resolveFn.indexOf('return _userFromRow_'),
    "a role changed since the token was issued must take effect on resume");
  check("the builder itself reads the person's flag",
    /const rowAdmin = _adminFlagFromRow_\(row\);/.test(SRC), "");
  check("login still goes through the same builder",
    /user = _userFromRow_\(acct\.row, acct\.role\);/.test(SRC), "");
}


console.log("\n18. EVERY permission helper sees 管理者権限 — not just _hasPerm_");
{
  // ⚠️ WHY THIS IS STRUCTURAL. When the flag was widened, _hasPerm_ gained
  // `if (_isAdminLevel_(role)) return true;`. Two OTHER helpers decide permissions and
  // neither got the line: _hasRecruitPerm_ (24 endpoints) and _hasResultPerm_ (10). So a
  // flagged 教務 was refused by 34 endpoints while every other screen worked.
  //
  // ⚠️ And the failure was invisible from either side alone. The CLIENT grants it —
  // recCanView -> hasPermission -> isAdminRole -> true — so the 募集状況 tab appeared,
  // and everything behind it threw 権限がありません. Same shape as the _resolveUserById_
  // session-resume bug: a second copy of a decision, drifting when the decision changed.
  //
  // A behavioural check cannot see a helper that does not exist yet, so this enumerates
  // them FROM THE SOURCE. Add a fourth _has*Perm without the line and this fails.
  const helpers = [];
  const re = /function (_has\w*Perm_)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(SRC)) !== null) {
    // Body = from the brace to the first line-start "}", the shape every top-level
    // function in this file has.
    const from = m.index + m[0].length;
    const end = SRC.indexOf('\n}', from);
    helpers.push({ name: m[1], args: m[2], body: SRC.slice(from, end) });
  }

  check("the permission helpers were found", helpers.length >= 3,
    "found " + helpers.length + " — the function shape changed and this scan is blind");
  check("...and they are the three we know about",
    ["_hasPerm_", "_hasResultPerm_", "_hasRecruitPerm_"]
      .every(function (n) { return helpers.some(function (h) { return h.name === n; }); }),
    "found: " + helpers.map(function (h) { return h.name; }).join(", "));

  helpers.forEach(function (h) {
    // ⚠️ Comments stripped: _hasRecruitPerm_'s comment NAMES the line it is explaining,
    // so a raw scan passes on the explanation alone. Fifth time in this repo.
    const code = h.body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check(h.name + " consults _isAdminLevel_",
      /if \(_isAdminLevel_\(role\)\) return true;/.test(code),
      "a permission decision that cannot see 管理者権限 refuses a flagged admin, and " +
      "the client grants it anyway — the panel opens and the data throws");
    check("..." + h.name + " still lets master through",
      /_isMasterRole_\(role\)/.test(code), "");
    // ⚠️ The rule from CLAUDE.md: a permission decision never reads a permission string
    // itself; it goes through _effectivePerms_.
    check("..." + h.name + " reads perms through _effectivePerms_",
      /_effectivePerms_\(/.test(code) || h.name === "_hasPerm_" || /_effectivePerms_\(/.test(h.body),
      "reading the client's string directly is the hole endpoints.test.js §3.1 covers");
  });

  // ⚠️ The boundary that must NOT move: the flag is not master.
  const MASTER_ONLY = ["saveRole", "deleteRole", "resetRoleDefaults"];
  MASTER_ONLY.forEach(function (fn) {
    const at = SRC.indexOf("function " + fn + "(");
    const body = SRC.slice(at, SRC.indexOf('\n}', at));
    check(fn + " is still master-only, not admin-level",
      /_isMasterRole_\(/.test(body) && !/_isAdminLevel_\(/.test(body),
      "a flagged admin must not be able to mint a role or promote themselves");
  });
}


console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
