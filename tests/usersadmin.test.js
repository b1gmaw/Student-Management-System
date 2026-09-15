// ユーザー管理 (the admin panel), rebuilt for use.
//
// ⚠️ WHY. Reported as "very unintuitive". Measured before the change: five unrelated tools
// stacked into one 1423px page with an EMPTY sub-nav; "who is signed in" in a separate table
// whose help text had to point back at the first one; a RED PWリセット on every row (red reads as
// delete); the editor 980px tall in a 900px window with 保存 below the fold; 25 permission boxes
// in one flat grid; and the 管理者権限 switch — which overrides all 25 — placed AFTER them.
//
// And one genuine defect: 操作履歴・バックアップ was shown to anyone with manage_users while all
// three of its endpoints require _isAdminLevel_, so some admins saw buttons that could never work.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const JS = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || '';
// ⚠️ Comment-stripped copy for NEGATIVE scans. The comments here quote the very shapes being
// banned — _umIssueTempPassword's own note says "routing it through apiRun() is what broke
// loginUser" right beside adminResetPassword, and the first version of that check matched the
// explanation instead of any code. The `:` guard keeps https:// intact.
const JSNC = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const STYLE = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
const MEDIA = STYLE.slice(STYLE.indexOf('@media (max-width: 820px)'));
const DESK = STYLE.slice(0, STYLE.indexOf('@media (max-width: 820px)'));

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function bodyOf(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const j = src.indexOf('\n      function ', i + 1);
  return src.slice(i, j < 0 ? src.length : j);
}
const view = HTML.slice(HTML.indexOf('<div id="view-users"'), HTML.indexOf('<div id="view-account"'));
const modal = HTML.slice(HTML.indexOf('<div id="userModal"'), HTML.indexOf('<!-- ROLE MODAL (master only) -->'));

console.log("\n1. four sub-tabs, in the slot that was empty");
{
  const subs = ['list', 'roles', 'announce', 'safety'];
  subs.forEach(function (k) {
    check("sub-view users-view-" + k + " exists", new RegExp('id="users-view-' + k + '" class="users-sub').test(view), "");
    check("...and its button btn-users-" + k, new RegExp('id="btn-users-' + k + '"').test(HTML), "");
  });
  // ⚠️ btn-sub-* / sub-view-* is a namespace 学生一覧 and 入試関連 share; a clash is a duplicate id.
  check("⚠️ the ids do NOT reuse the shared btn-sub-* / sub-view-* namespace",
    !/id="(btn-sub|sub-view)-(list|roles|announce|safety)"/.test(HTML), "");
  // ⚠️ .sub-view-section is also read document-wide (a querySelector('.sub-view-section.active')
  // exists elsewhere) — reusing it would make these sub-views answer to another tab's code.
  check("⚠️ the sub-views use their OWN class, not .sub-view-section",
    !/id="users-view-[a-z]+" class="[^"]*sub-view-section/.test(view), "");
  const sw = bodyOf(JS, 'switchUsersSubTab');
  check("⚠️ the switcher SWEEPS by class, scoped to #view-users",
    /document\.getElementById\('view-users'\)/.test(sw) && /querySelectorAll\('\.users-sub'\)/.test(sw)
      && /USERS_SUBS\.forEach/.test(sw),
    "naming each sub-view a line at a time is the trap switchAdmissionsSubTab still has");
  check("the five old sections are gone from one page",
    !/id="rolesPanel"/.test(HTML) && !/id="announcePanel"/.test(HTML) && !/id="activeSessionsList"/.test(HTML), "");
}

console.log("\n2. the gates — and the one that was broken");
{
  const allow = bodyOf(JS, '_usersSubAllowed');
  check("⚠️ 役割 and お知らせ stay MASTER only",
    /if \(key === 'roles' \|\| key === 'announce'\) return isMasterRole\(\);/.test(allow),
    "an admin manages users; the master defines what roles exist, or an admin could promote itself");
  check("⚠️ 操作履歴・バックアップ follows its endpoints to admin LEVEL",
    /if \(key === 'safety'\) return isAdminRole\(\);/.test(allow),
    "shown on manage_users alone, its three buttons each answered 権限がありません");
  // The server half of that claim — the gate is only right if these really require admin level.
  ['getActivityLog', 'getSnapshotList', 'diagnoseInChargeMatching'].forEach(function (f) {
    check("...because " + f + " requires _isAdminLevel_",
      new RegExp('function ' + f + '\\([^)]*\\) \\{\\s*if \\(!_isAdminLevel_\\(').test(CODE), "");
  });
  check("⚠️ the switcher refuses a disallowed key, so the gate is not just a hidden button",
    /if \(USERS_SUBS\.indexOf\(key\) === -1 \|\| !_usersSubAllowed\(key\)\) key = 'list';/.test(bodyOf(JS, 'switchUsersSubTab')), "");
  check("...and the buttons read the same table",
    /b\.style\.display = _usersSubAllowed\(k\) \? 'block' : 'none';/.test(JS), "");
  check("...and the sub-tab buttons carry no data-perm the generic pass could override",
    !/id="btn-users-[a-z]+"[^>]*data-perm/.test(HTML), "");

  // ⚠️ Rule 3. setupInterfaceBasedOnRole reads USERS_SUBS / _usersSubNow and can run
  // SYNCHRONOUSLY during script execution (tryResumeSession is called at top level and settles
  // at once when the boot prefetch already landed). Declared below that call, they are in the
  // temporal dead zone, the setup throws, and the app is blank.
  const decl = JS.indexOf("const USERS_SUBS = ");
  const call = JS.indexOf("\n        tryResumeSession();");
  check("⚠️ USERS_SUBS is declared BEFORE the top-level tryResumeSession() call",
    decl > 0 && call > 0 && decl < call, "decl at " + decl + ", call at " + call);
  check("...and so is _usersSubNow",
    JS.indexOf("let _usersSubNow = ") > 0 && JS.indexOf("let _usersSubNow = ") < call, "");
}

console.log("\n3. the list: who they are, and the one action that needs a session");
{
  const r = bodyOf(JS, 'renderUsersTable');
  check("the name comes first", /<td class='u-name'><div class='u-nm'>\$\{escHtmlJs\(u\.name\)\}/.test(r), "");
  // ⚠️ RE-PINNED 2026-09-11: by ACCOUNT (the sheet), not the literal role — a session keeps a
  // stale role after a 営業 → 事務 move. Never id alone either. tests/session.test.js exercises it.
  check("⚠️ sessions join on the ACCOUNT, never id alone and never the literal role",
    /_usersSessions\[_usersSessionKey\(u\.role, u\.id\)\]/.test(r)
      && /function _usersSessionKey\(role, id\) \{ return \(String\(role \|\| ''\) === 'teacher' \? 'teacher' : 'staff'\) \+ '\|'/.test(JS), "");
  check("⚠️ ログアウトさせる appears ONLY on a signed-in row",
    /\$\{ses \? `<button[^`]*onclick="revokeUser\(\$\{i\}\)"[^`]*>ログアウトさせる<\/button>` : ''\}/.test(r),
    "offered for someone with no session it does nothing, and the row reads as a threat");
  check("PWリセット is off the row", !/PWリセット/.test(r), "");
  check("⚠️ 設定済み carries NO badge — only the states that need action do",
    /const pwBadge = \{ "要変更": "u-warn", "PIN移行待ち": "u-warn", "未設定": "u-bad" \};/.test(r)
      && !/"設定済み":/.test(r), "a badge on every row is a badge on no row");
  // ⚠️ getSystemUsers returns only the PERSON flag. Combining it with the role flag in the
  // browser would re-derive _isAdminLevel_ — the copy CLAUDE.md warns drifts.
  check("⚠️ the 管理者権限 badge is the PERSON flag, and is not combined with the role's",
    /u\.adminUser === true \? "<span class='u-badge u-admin'>管理者権限<\/span>"/.test(r)
      && !/u\.adminUser === true \|\| roleAdmin/.test(r), "");
  check("...while the role's flag is shown on the role cell",
    /roleAdmin\[u\.role\] \? "<div class='u-sub'>管理者権限つきの役割<\/div>"/.test(r), "");
  check("⚠️ no pre-built fragment hides the escaping from xss.test.js",
    !/\$\{badges/.test(r) && !/\$\{roleCell\}/.test(r), "");
  check("`let displayRole = roleLabel(u.role);` survives — roles.test.js pins it",
    /let displayRole = roleLabel\(u\.role\);/.test(r), "");
}

console.log("\n4. the editor, in the order decisions are made");
{
  check("⚠️ 管理者権限 sits ABOVE the permissions",
    modal.indexOf('id="userAdminBox"') > 0 && modal.indexOf('id="userAdminBox"') < modal.indexOf('id="umPerms"'),
    "it overrides all of them; below them you configure 25 boxes and then find the switch that voids them");
  check("...and the account actions below them",
    modal.indexOf('id="umPerms"') < modal.indexOf('id="umAccountSec"'), "");
  check("⚠️ modalUserAdmin is still NOT a perm-cb",
    !/class="perm-cb"[^>]*id="modalUserAdmin"/.test(modal) && !/id="modalUserAdmin"[^>]*class="perm-cb"/.test(modal), "");
  const vals = (modal.match(/class="perm-cb" value="([a-z_]+)"/g) || []).map(function (t) { return t.match(/value="([a-z_]+)"/)[1]; });
  check("25 permission boxes", vals.length === 25, "found " + vals.length);
  check("...no key twice", new Set(vals).size === vals.length, "");
  const groups = modal.match(/<fieldset class="perm-group" data-group="[^"]+">[\s\S]*?<\/fieldset>/g) || [];
  check("five screen groups", groups.length === 5, "found " + groups.length);
  check("⚠️ each group leads with exactly ONE gate — the screen's own 表示 permission",
    groups.every(function (g) { return (g.match(/data-gate="1"/g) || []).length === 1; }), "");
  const gates = groups.map(function (g) { return (g.match(/value="([a-z_]+)" data-gate/) || [])[1]; });
  check("...and the gates are the real tab gates",
    JSON.stringify(gates) === JSON.stringify(['view_students', 'view_dorms', 'view_admissions', 'view_shinsei', 'manage_users']),
    JSON.stringify(gates));
  // Those gates are what the sidebar actually hides the tabs on.
  ['students:view_students', 'dorms:view_dorms', 'admissions:view_admissions', 'shinsei:view_shinsei', 'users:manage_users']
    .forEach(function (pair) {
      const t = pair.split(':');
      check("...the " + t[0] + " tab is gated on " + t[1],
        new RegExp('data-perm="' + t[1] + '" onclick="switchMainTab\\(\'' + t[0] + '\'\\)').test(HTML), "");
    });
  check("⚠️ the editor scrolls INSIDE and is scoped — never the global .modal-box rule",
    /#userModal \.um-box, #roleModal \.um-box \{ display: flex; flex-direction: column; max-height: min\(92vh, 900px\); overflow: hidden; \}/.test(DESK)
      && /#userModal \.um-body, #roleModal \.um-body \{ overflow-y: auto;/.test(DESK)
      && !/^\s*\.modal-box \{[^}]*max-height/m.test(DESK.slice(DESK.indexOf('ユーザー管理'))),
    "changing .modal-box globally moved .exp-menu's anchor inside #stuTrendModal");
}

console.log("\n5. 管理者権限 collapses the ticks — it never erases them");
{
  const sync = bodyOf(JS, '_syncUserPermOverrideNote');
  check("⚠️ the note is keyed on the CHECKBOX, not on who is looking",
    /note\.style\.display = \(cb && cb\.checked\) \? 'block' : 'none';/.test(sync), "");
  check("⚠️ the permissions are COLLAPSED by a class",
    /perms\.classList\.toggle\('um-collapsed', on && !_umPermsExpanded\)/.test(sync), "");
  check("⚠️ ...and never disabled or cleared",
    !/\.disabled\s*=/.test(sync) && !/\.checked\s*=/.test(sync)
      && !/\.disabled\s*=/.test(bodyOf(JS, '_umTogglePerms')) && !/\.checked\s*=/.test(bodyOf(JS, '_umTogglePerms')),
    "overriding is not erasing: the ticks apply again the moment the flag comes off");
}

console.log("\n6. an unreachable permission is FLAGGED, never auto-fixed");
{
  // Transcribed predicate: a group is bad when its gate is off and something beneath is on.
  function bad(gate, others) { return !gate && others.some(Boolean); }
  check("gate off, a member on → flagged", bad(false, [true, false]) === true, "");
  check("gate on → never flagged", bad(true, [true, true]) === false, "");
  check("nothing ticked → not flagged", bad(false, [false, false]) === false, "");
  const g = bodyOf(JS, '_umCheckPermGates');
  check("⚠️ the source matches the transcription",
    /const bad = !!\(gate && !gate\.checked && orphan\);/.test(g), "");
  // ⚠️ THE rule. Ticking 学生一覧 表示 so 募集状況 is reachable also grants the student list.
  check("⚠️ it NEVER ticks anything",
    !/\.checked\s*=\s*true/.test(g) && !/\.click\(\)/.test(g),
    "auto-ticking the parent would silently grant every other screen under it — personal data");
  check("...and it runs after the ticks land on open", /_umCheckPermGates\(\);\s*\n\s*_syncUserPermOverrideNote\(\);/.test(bodyOf(JS, 'editUser')), "");
}

console.log("\n7. the role modal clones the grouping from the ONE list");
{
  const b = bodyOf(JS, 'buildRolePermList');
  check("the pinned clone loop survives",
    /document\.querySelectorAll\('\.perm-cb'\)\.forEach\(cb => \{\s*const src = cb\.closest\('label'\)/.test(b), "");
  // Re-pinned: the clone now builds the same .perm-group FIELDSETS the user editor draws,
  // where it used to insert a bare heading.
  check("⚠️ it builds a fieldset whenever the group changes",
    /const grp = cb\.closest\('\.perm-group'\);/.test(b) && /fs\.className = 'perm-group';/.test(b)
      && /if \(cb\.hasAttribute\('data-gate'\)\)/.test(b), "");
  check("...and the clones are still role-perm-cb", /class="role-perm-cb"/.test(b), "a cloned perm-cb would be saved onto the user");
}

console.log("\n8. a new user gets a password in one step — and cannot overwrite a colleague");
{
  const save = bodyOf(JS, 'saveUser');
  // ⚠️ The reset looks the row up, so it must run after the save wrote it.
  const succ = save.slice(save.indexOf('apiRun().withSuccessHandler'));
  check("⚠️ the reset is CHAINED inside the save's success handler",
    succ.indexOf('_umIssueTempPassword(userData.role, userData.id, userData.name, true)') > 0
      && save.indexOf('_umIssueTempPassword') > save.indexOf('apiRun().withSuccessHandler'),
    "fired alongside the save it races the row it needs");
  check("...and 保存 goes once it has, so a second press cannot create the user twice",
    /btn\.style\.display = 'none';/.test(succ), "");
  const show = bodyOf(JS, '_umShowPw');
  check("⚠️ save-ok / reset-failed says EXACTLY that",
    /は登録されましたが、一時パスワードを発行できませんでした。/.test(show),
    "reporting success leaves an account nobody can log into — 未設定 wearing a green tick");
  check("...and turns the editor into that user's editor for the retry",
    /document\.getElementById\('modalUserOldId'\)\.value = document\.getElementById\('modalUserId'\)\.value\.trim\(\);/.test(show), "");
  // Asserted on the function body, not a character window: the chain spans two handlers, and
  // the first version bounded it at 300 characters when it is 326 — failing on correct code.
  const issue = bodyOf(JSNC, '_umIssueTempPassword');
  check("⚠️ adminResetPassword stays a DIRECT google.script.run call",
    /google\.script\.run/.test(issue) && /\.adminResetPassword\(token, role, id\)/.test(issue)
      && !/apiRun/.test(issue)
      && (JSNC.match(/\.adminResetPassword\(/g) || []).length === 1,
    "it is off the apiCall registry and resolves the caller from the token; apiRun() is what broke loginUser");
  check("the window.prompt is gone", !/window\.prompt\([^)]*一時パスワード/.test(JS), "");
  check("⚠️ a copy failure falls back to SELECTING the text",
    /navigator\.clipboard\.writeText\(txt\)\.then\(done, select\)/.test(bodyOf(JS, '_umCopyPw')),
    "a failed copy must never hide the only copy of the password");
  check("the credential is cleared when the editor closes",
    /_umHidePw\(\);/.test(bodyOf(JS, 'closeUserModal')) && /v\.textContent = '';/.test(bodyOf(JS, '_umHidePw')), "");

  // ⚠️ The overwrite. With oldId blank the server searched for u.id and took the UPDATE branch.
  check("⚠️ the SERVER refuses a new user whose ID exists",
    /if \(!u\.oldId\) \{\s*const wantId = String\(u\.id \|\| ""\)\.trim\(\);[\s\S]{0,200}throw new Error\("ID「" \+ wantId \+ "」はすでに使われています。/.test(SRC),
    "the auto-issued password would otherwise reset the colleague's password too");
  check("...compared TRIMMED on both sides",
    /String\(data\[i\]\[0\] \|\| ""\)\.trim\(\) === wantId/.test(SRC), "「S01 」 must not slip past as a near-duplicate");
  check("...and the client refuses first",
    /some\(function \(x\) \{ return String\(x\.id\)\.trim\(\) === userData\.id; \}\)/.test(save), "");
  // ⚠️ "Only" needs a COUNT. The first version asserted the trim sat inside `if (isNew)`, which
  // stays true when a second trim is added outside it — mutation-checking caught that it proved
  // presence, not absence.
  const trims = (save.match(/userData\.id = String\(userData\.id \|\| ''\)\.trim\(\);/g) || []).length;
  check("⚠️ the id is trimmed for a NEW user only",
    trims === 1 && save.indexOf("userData.id = String(userData.id || '').trim();") > save.indexOf('if (isNew) {'),
    "found " + trims + " — on an edit the id must stay byte-exact, or the server's row search misses the record");
}

console.log("\n9. the styling reaches nothing else");
{
  const block = DESK.slice(DESK.indexOf('/* ============ ユーザー管理 ============'));
  const sels = (block.match(/^\s*([^{}\n]+)\{/gm) || []).map(function (s) { return s.replace(/\{\s*$/, '').trim(); })
    .filter(function (s) { return s && s.indexOf('@media') !== 0; });
  check("the block was located", sels.length > 20, "found " + sels.length);
  const stray = sels.filter(function (s) {
    return s.split(',').some(function (p) {
      p = p.trim();
      return !/^(#view-users|#userModal|#roleModal|\.users-table|\.u-[a-z]+|#rolePermList)/.test(p);
    });
  });
  check("⚠️ every new rule is scoped to this panel", stray.length === 0, "unscoped: " + stray.join(' | '));
  check("⚠️ font-family still appears exactly ONCE in the stylesheet",
    (STYLE.replace(/\/\*[\s\S]*?\*\//g, '').match(/font-family\s*:/g) || []).length === 1,
    "it is the one-line revert for the whole typeface");
  check("⚠️ no !important in the desktop block", !/!important/.test(block.slice(0, block.indexOf('@media') < 0 ? block.length : block.indexOf('@media'))), "");
  check("⚠️ the nested form rows still stack on a phone",
    /#userModal \.um-row, #roleModal \.um-row \{ flex-direction: column; \}/.test(MEDIA),
    "the .modal-box > div stacker only sees DIRECT children, and these are nested now");
  check("no raw hex on the row buttons", !/background-color:#(f6c23e|e74a3b|6c757d|4e73df)/.test(bodyOf(JS, 'renderUsersTable')), "");
}

console.log("\n10. 役割 — what a role opens, and who holds it");
{
  const t = bodyOf(JS, 'renderRolesTable');
  // ⚠️ One permission list: the screens are read from the user editor's markup.
  check("⚠️ 開ける画面 is read from the user editor's .perm-group markup — not a second map",
    /document\.querySelectorAll\('#umPerms \.perm-group'\)/.test(t) && /\.perm-cb\[data-gate\]/.test(t), "");
  check("⚠️ 使用中 counts by the same LITERAL role match deleteRole makes",
    /holders\[u\.role\] = \(holders\[u\.role\] \|\| 0\) \+ 1/.test(t)
      && /function _usersWithRole_\(/.test(CODE), "the number shown and the server's refusal must agree");
  check("管理者権限 is the u-admin badge, not a raw red あり",
    /r\.admin \? "<span class='u-badge u-admin'>管理者権限<\/span>"/.test(t) && !/#e74a3b/.test(t), "");
  check("the key sits beneath the label, not as a main column",
    /<div class='u-nm'>\$\{escHtmlJs\(r\.label\)\}<\/div><div class='u-sub'>\$\{escHtmlJs\(r\.key\)\}/.test(t), "");

  const o = bodyOf(JS, 'openRoleModal');
  check("`btnDeleteRole').style.display = (r && !builtin)` survives — roles.test.js pins it",
    /btnDeleteRole'\)\.style\.display = \(r && !builtin\)/.test(o), "");
  check("⚠️ 削除 says why it cannot, BEFORE you try — exactly as strict as deleteRole",
    /\.filter\(function \(u\) \{ return u\.role === r\.key; \}\)\.length/.test(o)
      && /btnDeleteRole'\)\.disabled = held > 0;/.test(o) && /名が使用中のため削除できません/.test(o), "");
  const rmodal = HTML.slice(HTML.indexOf('<div id="roleModal"'), HTML.indexOf('<!-- TEACHER VIEW MODAL -->'));
  check("⚠️ the role editor is the user editor's shape",
    /class="modal-box um-box"/.test(rmodal) && /class="um-body"/.test(rmodal) && /modal-actions um-actions/.test(rmodal), "");
  ['roleModalTitle', 'modalRoleOldKey', 'modalRoleKey', 'modalRoleLabel', 'roleAdminBox', 'modalRoleAdmin',
   'rolePermList', 'btnDeleteRole', 'btnResetRole', 'btnSaveRole'].forEach(function (id) {
    check("...keeps id " + id, (rmodal.match(new RegExp('id="' + id + '"', 'g')) || []).length === 1, "");
  });
  // ⚠️ ONE gate check for both editors, selecting by data-gate — the clones are role-perm-cb.
  const g = bodyOf(JS, '_umCheckPermGates');
  check("⚠️ the gate check takes a container and selects by data-gate, not by class",
    /function _umCheckPermGates\(container\)/.test(JS) && /input\[type="checkbox"\]\[data-gate\]/.test(g)
      && !/'\.perm-cb\[data-gate\]'/.test(g), "the role editor's clones are role-perm-cb — a class selector sees none of them");
  check("...and the role editor runs it", /onchange="_umCheckPermGates\(this\)"/.test(rmodal)
      && /_umCheckPermGates\(box\);/.test(bodyOf(JS, 'buildRolePermList')), "");
}

console.log("\n11. お知らせ — who it reaches, and which one is deleted");
{
  const post = CODE.slice(CODE.indexOf('function postAnnouncement('), CODE.indexOf('function getAnnouncements('));
  // ⚠️ The widen-to-everyone fallback.
  check("⚠️ an unknown target is REFUSED, never widened to all",
    !/\? target : "all"/.test(post) && /if \(tgt === ""\) throw new Error\(/.test(post),
    "an announcement for one department would silently have reached everyone");
  check("...and the valid targets are all, adminlevel, and any known role",
    /tRaw === "all" \|\| tRaw === "adminlevel" \|\| _roleByKey_\(tRaw\)/.test(post), "");
  const get = CODE.slice(CODE.indexOf('function getAnnouncements('), CODE.indexOf('\nfunction ', CODE.indexOf('function getAnnouncements(') + 1));
  check("⚠️ adminlevel asks _isAdminLevel_ about the READER (session-aware)",
    /const myAdmin = _isAdminLevel_\(role\);/.test(get) && /if \(tgt === "adminlevel"\) \{ if \(!myAdmin\) continue; \}/.test(get), "");
  check("⚠️ the role match uses the SESSION's role, not the string the browser sent",
    /const myRole = _effectiveRole_\(role\);/.test(get) && /tgt !== myRole/.test(get)
      && !/tgt !== String\(role/.test(get), "a client could claim a role to read another department's announcements");
  check("⚠️ a NEW key, not a new meaning for admin",
    !/tgt === "admin"/.test(get), "reinterpreting admin would widen the audience of announcements already sent");
  const del = CODE.slice(CODE.indexOf('function deleteAnnouncement('), CODE.indexOf('\nfunction ', CODE.indexOf('function deleteAnnouncement(') + 1));
  check("⚠️ delete is verified against the ID, never trusted by row position",
    /function deleteAnnouncement\(role, perms, rowIndex, actorName, actorId, expectedId\)/.test(del)
      && /String\(sh\.getRange\(ri, 1\)\.getDisplayValue\(\)\)\.trim\(\) !== want/.test(del)
      && del.indexOf('!== want') < del.indexOf('sh.deleteRow(ri)'),
    "deleteRow shifts every row below it; a stale list deleted the NEXT announcement (§8.3)");

  // The audience rule, transcribed and exercised. reader = { role, admin(level) }.
  function reaches(tgt, reader) {
    if (tgt === 'adminlevel') return !!reader.admin;
    return tgt === 'all' || tgt === reader.role;
  }
  const flaggedJimu = { role: 'jimu', admin: true }, jimu = { role: 'jimu', admin: false },
        sales = { role: 'sales', admin: false }, legacyAdmin = { role: 'admin', admin: true };
  check("adminlevel reaches a FLAGGED 事務", reaches('adminlevel', flaggedJimu) === true, "");
  check("...and not an unflagged one", reaches('adminlevel', jimu) === false, "");
  check("jimu reaches 事務 only", reaches('jimu', jimu) && !reaches('jimu', sales), "");
  check("an old 'admin' announcement keeps its audience — the literal admin role, nobody new",
    reaches('admin', legacyAdmin) && !reaches('admin', flaggedJimu), "");
  check("all reaches everyone", [flaggedJimu, jimu, sales, legacyAdmin].every(function (r) { return reaches('all', r); }), "");

  const list = bodyOf(JS, 'annLoadList');
  check("⚠️ delete sends the ID, escaped for a JS string in an attribute",
    /annDelete\(\$\{escAttrJs\(String\(parseInt\(a\._sheetRow, 10\) \|\| 0\)\)\}, '\$\{escAttrJsStr\(a\.id\)\}'\)/.test(list)
      && /function annDelete\(rowIndex, id\)/.test(JS)
      && /rowIndex, currentUser\.name, currentUser\.id, id\);/.test(bodyOf(JS, 'annDelete')), "");
  check("...from a real button, not a bare ✕ span", /<button class="schedule-btn btn-sm u-del"/.test(list) && !/✕/.test(list), "");
  check("⚠️ ONE annLoadList / annDelete — and it is the new one",
    (JS.match(/function annLoadList\(/g) || []).length === 1 && (JS.match(/function annDelete\(/g) || []).length === 1
      && /_annAudience\(a\.target\)/.test(list),
    "a replacement once deleted the NEW versions and kept the old: counting survivors is not enough");
  check("⚠️ 既読 has no denominator for adminlevel — no admin-level count in the browser",
    /if \(t === 'adminlevel'\) return null;/.test(bodyOf(JS, '_annAudience')), "");
  check("the list loads when the sub-tab opens",
    /if \(key === 'announce'\) \{ _annFillTargets\(\); _annCount\(\); annLoadList\(\); \}/.test(bodyOf(JS, 'switchUsersSubTab')), "");
  check("対象 is built from the roles, with the new admin-level option",
    /<option value="adminlevel">管理者権限のある人<\/option>/.test(bodyOf(JS, '_annFillTargets'))
      && /\(rolesData \|\| \[\]\)\.map/.test(bodyOf(JS, '_annFillTargets')), "");
  check("the 2000-character limit is shown, not silent",
    /id="annBody"[^>]*maxlength="2000"/.test(HTML) && /id="annCount"/.test(HTML), "");
}

console.log("\n12. 操作履歴・バックアップ — one panel per tool");
{
  check("⚠️ the shared output box is gone", !/dataSafetyContent/.test(HTML),
    "three tools writing one box meant each replaced the others' output");
  ['log', 'snap', 'incharge'].forEach(function (m) {
    check("chip ds-mode-" + m + " and pane ds-pane-" + m,
      new RegExp('id="ds-mode-' + m + '" class="mode-btn').test(HTML) && new RegExp('id="ds-pane-' + m + '"').test(HTML), "");
  });
  const mode = bodyOf(JS, 'dsSetMode');
  check("⚠️ the chips and panes are SWEPT, and each tool loads once on first show",
    /DS_MODES\.forEach/.test(mode) && /if \(!_dsLoaded\[mode\]\)/.test(mode), "");
  check("each tool writes its OWN container",
    /getElementById\('dsLog'\)/.test(bodyOf(JS, 'loadActivityLog')) && /getElementById\('dsSnap'\)/.test(bodyOf(JS, 'loadSnapshots'))
      && /getElementById\('dsInCharge'\)/.test(bodyOf(JS, 'runInChargeDiagnostic')), "");
  // ⚠️ Header names, never indexes: row 1 of the audit sheet, sent verbatim.
  check("⚠️ log headers are mapped BY NAME, and 役割 found by name",
    /const DS_LOG_HEADERS = \{ Timestamp: '日時'/.test(JS) && /\.indexOf\('Role'\)/.test(bodyOf(JS, 'dsFilterLog'))
      && /ci === roleIdx \? roleLabel\(cell\)/.test(bodyOf(JS, 'dsFilterLog')), "");
  const snaps = bodyOf(JS, 'loadSnapshots');
  check("⚠️ restore passes the name through escAttrJsStr — a JS string inside an attribute",
    /restoreSnapshotConfirm\('\$\{escAttrJsStr\(s\.name\)\}'\)/.test(snaps) && !/restoreSnapshotConfirm\('\$\{escHtmlJs/.test(JS), "");
  check("...and the type-the-sheet-name gate is untouched",
    /const typed = prompt\('本当に復元する場合は、シート名「' \+ sheetName/.test(bodyOf(JS, 'restoreSnapshotConfirm')), "");
  // Transcribed: groups ordered by their NEWEST stamp, not by name.
  function order(names) {
    const by = {}, newest = {};
    names.slice().sort().reverse().forEach(function (n) {
      const sh = n.slice(0, n.indexOf('__')), st = n.slice(n.indexOf('__') + 2);
      if (!by[sh]) { by[sh] = 1; newest[sh] = st; }
    });
    return Object.keys(by).sort(function (x, y) { return newest[x] < newest[y] ? 1 : newest[x] > newest[y] ? -1 : 0; });
  }
  check("⚠️ backup groups order by their newest backup, not alphabetically",
    JSON.stringify(order(['Zeta__20260910_080000', 'Alpha__20260911_120000'])) === JSON.stringify(['Alpha', 'Zeta']), "");
  check("...and the source matches the transcription",
    /const order = Object\.keys\(by\)\.sort\(function \(x, y\) \{ return newest\[x\] < newest\[y\] \? 1/.test(snaps), "");
  check("⚠️ the 担当 check names ユーザー管理, never the internal sheet",
    !/Staff_Master/.test(bodyOf(JSNC, 'runInChargeDiagnostic')) && /ユーザー管理の名前/.test(bodyOf(JS, 'runInChargeDiagnostic')), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
