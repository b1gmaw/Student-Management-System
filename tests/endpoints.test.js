// Every top-level function in Code.js / Shinsei_Code.js is callable over the web:
// `google.script.run.<name>(…)` from any browser on the deployment URL, which is
// ANYONE_ANONYMOUS. Confirmed in production — getDashboardData("teacher") returned
// 608 student records to a caller with no session.
//
// This suite reads the source and asserts each exposed name is accounted for. It
// is deliberately a WHITELIST of what is allowed to be unguarded: adding a new
// endpoint without a guard fails here rather than shipping quietly, which is the
// exact way this hole opened in the first place.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

function bodies(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const starts = [];
  const re = /^function ([a-zA-Z_][\w]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) starts.push({ pos: m.index, name: m[1] });
  const out = {};
  starts.forEach(function (s, i) {
    out[s.name] = src.slice(s.pos, i + 1 < starts.length ? starts[i + 1].pos : src.length);
  });
  return out;
}

const B = Object.assign({}, bodies('Code.js'), bodies('Shinsei_Code.js'));
// ⚠️ Apps Script hides a server function from google.script.run ONLY when its name ENDS in "_".
// A LEADING underscore hides nothing: this used to read `n.charAt(0) !== '_'`, so all 212
// underscore-prefixed helpers were skipped here while every one of them was callable by an
// anonymous browser — `_writeAccountPassword` included. Measured on staging 2026-09-15:
// 380 names on the proxy, 212 of them leading-underscore. The test shared the code's mistake.
const isPrivate = function (n) { return n.charAt(n.length - 1) === '_'; };
const EXPOSED = Object.keys(B).filter(function (n) { return !isPrivate(n); }).sort();

// ⚠️ EVERY entry here must be the name of a function that CONSULTS THE SESSION.
//
// '権限がありません' — the error message — used to be on this list, so a function
// counted as guarded merely for CONTAINING THE STRING, whatever its condition
// actually read. That turned this suite's central claim into a spelling check,
// and it hid two live holes: saveBuilding and updateBuilding both guarded as
// `!_isMasterRole_(formObject.systemRole) && !(formObject.permissions && …)`,
// where the second half read what the browser sent. They matched twice over —
// once on _isMasterRole_, once on the message — while
// google.script.run.saveBuilding({permissions:"edit_dorms", …}) wrote
// Building_Info with no session at all. The suite reported "0 still trusting the
// client" the whole time. Never add a message, a comment marker, or anything
// else that is not a guard call.
//
// _permOrLegacyRole_ was missing and is now listed: it calls _roleIsAnyOf_ and
// _hasPerm_ internally, but the CALLER's body only contains its name, so eight
// real endpoints were being counted as guarded by the error string alone.
const GUARDS = ['_hasPerm_', '_hasRecruitPerm_', '_hasResultPerm_', '_isAdminRole_',
                '_isAdminLevel_', '_permOrLegacyRole_',
                // Calls _requireSession_, binds the 担当 check to the SESSION rather
                // than the client-supplied staffName, and throws 権限がありません.
                // The two 日時変更 actions guard through it.
                '_requirePendingDateChangeRow_',
                '_isMasterRole_', '_roleIsAnyOf_', '_requireSession_', '_requirePerm_',
                'resumeSession', '_requireMaintenanceUnlock_',
                // The one session decision resumeSession now wraps. checkSession calls it
                // directly so that it does NOT touch LastSeen; it still resolves the token.
                '_sessionLookup_',
                '_renderingRoomHtml'];
// ⚠️ COMMENT-BLIND. A guard named in a comment used to count: logoutSession passed for months
// because the password comment after it said "resumeSession". Measured when this changed
// (2026-09-14): the only other endpoints passing on comment text alone were loginUser and
// triggerAutoSyncStudents, both already on explicit lists below.
const stripComments = function (t) { return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1'); };
const hasGuard = function (body) { const b = stripComments(body); return GUARDS.some(function (g) { return b.indexOf(g) !== -1; }); };
const guarded = function (n) { return hasGuard(B[n]); };

// Run by hand from the Apps Script editor. Staff never invoke these, so the
// maintenance unlock can be absolute — it is a script property holding today's
// date, and PropertiesService is writable only from Project Settings.
const MAINTENANCE = ['auditAccountReadiness', 'authEnforceStatus', 'authoriseServices', 'checkSystemPin',
  'diagnoseLastYearCounts', 'diagnoseDestinations', 'diagnoseDestinationSource', 'diagnoseUnclassified', 'diagnoseDestinationConflicts',
  'systemPinStatus', 'profileApp', 'profileSnapshot', 'profilePasswordHash', 'profileRecruitMeta',
  'migrateAddPasswordColumns', 'migrateBuildingAddBurnablePlastic',
  'migrateOtherVisaAddDesiredColumn', 'revokeHearingSheetSharing', 'diagnoseScheduleDuplicates'];

// Runs unattended from a time trigger, so it cannot be locked — a refused
// trigger means the sync silently stops. Throttled instead.
const THROTTLED = ['triggerAutoSyncStudents', 'triggerScheduledBackup'];

// Reachable only from _buildRoomHtml_, and dangerous if reachable otherwise:
// one returns any Drive file the deployer owns, the other makes an outbound
// fetch with caller-supplied data in the URL.
const RENDER_ONLY = ['_getDriveImageBase64_', '_getQrBase64_'];

// Legitimately callable with no session — this is the front door.
// apiCall resolves the token itself and dispatches; it is the door, not a bypass.
// logoutSession deletes only the session whose token it is handed, so holding the token IS the
// authorization, as for loginUser and apiCall. ⚠️ It used to pass as "guarded" only because the
// comment block after it named resumeSession inside its body slice; new functions inserted below
// it on 2026-09-14 (アカウント設定) moved that comment out of the slice, and it surfaced here.
const PUBLIC = ['doGet', 'loginUser', 'apiCall', 'logoutSession'];

// Endpoints with NO guard of any kind. This list is empty and must stay empty —
// it held 42 names before the audit, then 20, and each of those was reachable by
// anyone with no account at all.
const UNGUARDED_KNOWN = [];

console.log("\n1. maintenance functions are locked, not merely renamed");
{
  MAINTENANCE.forEach(function (n) {
    check(n + " exists", Object.prototype.hasOwnProperty.call(B, n), "not found in source");
    if (B[n]) {
      check(n + " calls _requireMaintenanceUnlock_",
        B[n].indexOf('_requireMaintenanceUnlock_(') !== -1,
        "web-callable maintenance function with no lock");
    }
  });
  // The unlock must be today's date, not a boolean — a flag left switched on
  // would restore the hole permanently, and there is no cleanup step to forget.
  check("the unlock is date-scoped, so it self-expires",
    /yyyy-MM-dd/.test(B._requireMaintenanceUnlock_ || "") &&
    /v !== today/.test(B._requireMaintenanceUnlock_ || ""),
    "a non-expiring unlock is a permanently open door once set");
  check("the unlock fails closed when the property is unreadable",
    /catch \(e\) \{ \/\* unreadable/.test(B._requireMaintenanceUnlock_ || "") ||
    (B._requireMaintenanceUnlock_ || "").indexOf('let v = ""') !== -1,
    "an exception reading the property must not become an open gate");

  // ⚠️ Two maintenance functions call GUARDED endpoints, and since AUTH_ENFORCE=1
  // the guards read the session — not the role argument those calls pass. Run
  // from the editor or a trigger there is no session, so every call is denied.
  //
  // profileApp did exactly that between the flip (2026-08-05) and the fix, and it
  // never looked broken: denied producers still print a ms figure, and
  // _bootPayload_ did not even throw — wantsNotif went false, so it skipped its
  // reads and returned {} as a healthy-looking "343 ms / 2 bytes" against a
  // documented 327 ms / 158 KB. Running it requires editor access to the project,
  // which IS the authorisation; parking a session states that instead of letting
  // every measurement be silently refused.
  [['profileApp', 'the numbers it reports are the ones CLAUDE.md rule 8 says to trust'],
   ['profileRecruitMeta', 'it times getRecruitmentBundle, which a denied call would report as a fast failure'],
   ['triggerScheduledBackup', 'a denied backup would stop the app\'s only safety net with nothing on screen'],
   ['triggerAutoSyncStudents', 'a denied sync stops the nightly student update with nothing on screen']
  ].forEach(function (pair) {
    const n = pair[0], why = pair[1];
    check(n + " parks a session for its guarded calls",
      /_authUser = \{ role: "master"/.test(B[n] || ""),
      "under AUTH_ENFORCE=1 every guarded call it makes is refused — " + why);
    check(n + " restores the previous session in a finally",
      /finally \{[\s\S]{0,200}_authUser = was/.test(B[n] || ""),
      "an early throw would leave a master session parked for the rest of the execution");
  });

  THROTTLED.forEach(function (n) {
    check(n + " is throttled rather than locked",
      /[A-Z_]+_MIN_GAP_SEC/.test(B[n] || ""),
      "it runs unattended, so a lock would silently stop the sync");
    check(n + " still runs when the cache is unavailable",
      /catch \(e\) \{ \/\* no cache/.test(B[n] || ""),
      "a cache outage must not disable the trigger");
  });
  // setSystemPin was a master-account takeover: set the PIN, then sign in as
  // master with permissions "ALL". It is DELETED, not renamed and not gated.
  //
  // Renaming with a LEADING underscore is not enough — measured in a browser:
  //   typeof google.script.run._getDriveImageBase64  ===  "function"
  // A trailing underscore would hide it, but a function that must never exist is deleted,
  // not hidden. And a gate would have been the only thing between
  // an anonymous visitor and the master account. The function has no callers and
  // cannot be run from the editor (Run passes no arguments), so it can simply go.
  ['setSystemPin', '_setSystemPin', 'setSystemPin_', '_setSystemPin_'].forEach(function (n) {
    check("no " + n + " function at all", !Object.prototype.hasOwnProperty.call(B, n),
      "the master-PIN setter is back — it is a takeover vector under any name");
  });
  // The validation it used still has a caller; losing that would silently stop
  // checkSystemPin from reporting a weak or colliding PIN.
  check("_systemPinProblem_ survives for checkSystemPin",
    (B.checkSystemPin || B._systemPinReport_ || "").indexOf('_systemPinProblem_') !== -1 ||
    (B._systemPinReport_ || "").indexOf('_systemPinProblem_') !== -1,
    "PIN validation was orphaned by the deletion");
}

console.log("\n1.1 a leading underscore is never taken for privacy");
{
  // Every underscore-prefixed server function must also END in "_". A new `_foo` written in
  // the belief that the prefix hides it would be callable by anyone with the URL.
  const leadingOnly = Object.keys(B).filter(function (n) { return n.charAt(0) === '_' && !isPrivate(n); });
  check("no server function is underscore-prefixed without the trailing underscore",
    leadingOnly.length === 0,
    "web-callable despite looking private: " + leadingOnly.join(", "));
  // Mutation-checked 2026-09-15 by running this suite against the pre-rename sources: this
  // check listed all 212 helpers, and section 3 reported each one as an unguarded endpoint.
  check("the sensitive helpers are private",
    ['_writeAccountPassword_', '_issueSessionToken_', '_readTabs_', '_apiMethods_'].every(function (n) {
      return Object.prototype.hasOwnProperty.call(B, n); }),
    "renamed back or removed");
  // The client must never call a private name: the proxy does not carry it, so the call
  // fails only when somebody presses the button.
  const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
  const clientPrivate = (HTML.match(/google\.script\.run[\s\S]{0,300}?\.([A-Za-z_$][\w$]*_)\s*\(/g) || [])
    .filter(function (m) { return !/withSuccessHandler|withFailureHandler|withUserObject/.test(m.split('.').pop()); });
  check("the client calls no private server name through google.script.run", clientPrivate.length === 0,
    clientPrivate.join(" | "));
}

console.log("\n2. render-only helpers are private AND flag-gated");
{
  RENDER_ONLY.forEach(function (n) {
    check(n + " exists under a private name", Object.prototype.hasOwnProperty.call(B, n),
      "renamed or removed — the public name would be web-callable again");
    if (B[n]) {
      check(n + " refuses outside _buildRoomHtml_",
        B[n].indexOf('if (!_renderingRoomHtml)') !== -1,
        "the underscore alone is convention; the flag is the actual control");
    }
  });
  // The window has to be opened somewhere or the PDF export is broken outright.
  check("_buildRoomHtml_ opens the render window",
    (B._buildRoomHtml_ || "").indexOf('_renderingRoomHtml = true') !== -1, "");
  check("_buildRoomHtml_ restores it in a finally",
    /finally\s*\{\s*_renderingRoomHtml = was/.test(B._buildRoomHtml_ || ""),
    "an early exit would leave the window open for the rest of the execution");
  // The public names must be gone, not merely shadowed.
  ['getDriveImageBase64', 'getQrBase64', 'generatePDF', 'sendEmailNotif',
   'sendAdminCancelEmail', 'shinsei_fetchPDFWithRetry'].forEach(function (n) {
    check("no public " + n, !Object.prototype.hasOwnProperty.call(B, n),
      "still a top-level public name, so still web-callable");
  });
}

console.log("\n3. the exposed surface is fully accounted for");
{
  const accounted = {};
  MAINTENANCE.concat(THROTTLED, PUBLIC, UNGUARDED_KNOWN).forEach(function (n) { accounted[n] = true; });

  const surprises = EXPOSED.filter(function (n) { return !guarded(n) && !accounted[n]; });
  check("no unguarded endpoint outside the known list",
    surprises.length === 0,
    "these are callable by anyone with no session and no guard: " + surprises.join(", "));

  // The list may only shrink. An entry that gained a guard should be deleted
  // from it, so the count keeps meaning something.
  const nowGuarded = UNGUARDED_KNOWN.filter(function (n) { return B[n] && guarded(n); });
  check("UNGUARDED_KNOWN contains nothing already fixed",
    nowGuarded.length === 0,
    "guarded now — remove from the list: " + nowGuarded.join(", "));

  const gone = UNGUARDED_KNOWN.filter(function (n) { return !B[n]; });
  check("UNGUARDED_KNOWN names all still exist", gone.length === 0,
    "renamed or deleted: " + gone.join(", "));

  console.log("        (" + EXPOSED.length + " exposed, " + UNGUARDED_KNOWN.length +
              " still trusting the client — this number must only go down)");
}

console.log("\n3.1 no guard condition reads a client-supplied value directly");
{
  // ⚠️ Presence of a guard CALL is not enough. saveBuilding and updateBuilding
  // both called _isMasterRole_ — and then OR'd it with an inline read of
  // formObject.permissions, which is whatever the browser sent. An OR means the
  // weaker half decides, so both were writable with no session while section 3
  // above counted them guarded.
  //
  // The rule this enforces: a permission decision reads the session, and the
  // ONLY way to reach the session is through the helpers, which route arguments
  // via _effectiveRole_ / _effectivePerms_. A condition that touches formObject.*
  // or splits a perms string itself has stepped around that.
  // Passing a client value INTO a helper is correct and expected —
  // _hasPerm_(formObject.systemRole, formObject.permissions, "edit_dorms") is the
  // fixed form, because the helper discards both under AUTH_ENFORCE=1. So strip
  // every helper call out of the condition first; what remains is the part that
  // decides on its own, and that part must not mention a role or a permission.
  const HELPER_CALL = new RegExp('(?:' + GUARDS.join('|') + ')\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)', 'g');
  // ⚠️ Match on the SHAPE, not on a variable name. The first version of this
  // check listed `userPerms` and `permissions` literally and passed — while
  // saveSystemUser and deleteSystemUser held the identical hole spelled
  // `adminPerms`. Naming is not a category. Anything ending in perms/permissions,
  // any case, counts.
  const PERMSISH = '[A-Za-z_$][\\w$]*(?:[Pp]erms|[Pp]ermissions)';
  const CLIENT_DECISION = [
    /\.split\(["'],["']\)/,                                  // an inline permission-list test
    new RegExp(PERMSISH + '\\s*\\.\\s*(?:includes|indexOf)\\('),  // ditto, via includes()
    new RegExp(PERMSISH + '\\b'),                            // any other bare read of a perms value
    /\b\w*[Rr]ole\s*(?:===|!==|==|!=)\s*["']/                // a raw role-name comparison
  ];
  let offenders = [];
  EXPOSED.forEach(function (n) {
    // Only the lines that actually decide — an `if (…) throw 権限がありません`.
    const re = /if \(([\s\S]{0,400}?)\)\s*(?:\{\s*)?throw new Error\("権限がありません"\)/g;
    let m;
    while ((m = re.exec(B[n])) !== null) {
      const rest = m[1].replace(HELPER_CALL, '');
      if (CLIENT_DECISION.some(function (b) { return b.test(rest); })) {
        offenders.push(n);
        break;
      }
    }
  });
  check("no endpoint decides on a value the browser sent", offenders.length === 0,
    "these read the client's own claim instead of the session, so the guard beside " +
    "it can be bypassed: " + offenders.join(", ") +
    " — use _hasPerm_/_permOrLegacyRole_, which go through _effectivePerms_");

  // The helpers are the reason the rule above is enforceable. If one stops
  // consulting the session, every guard in the file silently becomes decorative.
  const auth = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
  check("_hasPerm_ resolves permissions through _effectivePerms_",
    /function _hasPerm_\([^)]*\) \{[\s\S]{0,220}?_effectivePerms_\(/.test(auth),
    "the one helper every endpoint leans on no longer reads the session");
  check("_effectiveRole_ returns the session's role when enforcing",
    /function _effectiveRole_\([^)]*\) \{\s*\n\s*if \(_authEnforcing_\(\)\) return _authUser \? String\(_authUser\.role/.test(auth),
    "enforcing mode must ignore the argument entirely");
}

console.log("\n3.2 the page cannot be framed by an arbitrary site");
{
  // ⚠️ ALLOWALL let ANY site put this app in an iframe — clickjacking over
  // 建物の削除, ユーザー管理 and the snapshot restore, where an invisible frame
  // under a decoy button clicks them as whoever is signed in. DEFAULT still
  // permits Google's own wrapper iframe, which is how the deployment URL renders.
  const codeSrc = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
  check("doGet does not use ALLOWALL",
    codeSrc.indexOf('XFrameOptionsMode.ALLOWALL') === -1,
    "any site could frame the app and click through it as the signed-in user");
  check("doGet sets the frame mode explicitly",
    /setXFrameOptionsMode\(HtmlService\.XFrameOptionsMode\.DEFAULT\)/.test(codeSrc),
    "leaving it unset is not the same as choosing — say which one and why");
}

console.log("\n4. the public front door is exactly these four functions");
{
  // doGet serves the page; loginUser is where a session comes from. Anything
  // else reachable without a session is a finding.
  check("doGet is public by necessity", PUBLIC.indexOf('doGet') !== -1, "");
  check("loginUser is public by necessity", PUBLIC.indexOf('loginUser') !== -1, "");
  check("apiCall is public: it resolves the token itself, it is the door", PUBLIC.indexOf('apiCall') !== -1, "");
  // Re-pinned 2026-09-14, not loosened: holding the token IS logoutSession's authorization.
  check("logoutSession is public: it deletes only the session whose token it is handed",
    PUBLIC.indexOf('logoutSession') !== -1 && /_sessionRowOf_\(sh, token\)/.test(B.logoutSession || ""), "");
  check("nothing else was added to PUBLIC", PUBLIC.length === 4, PUBLIC.join(", "));
  // The mutation for the comment-blind guard: a body whose only guard word sits in a comment.
  check("a guard named only in a COMMENT does not count",
    !hasGuard("function x() {\n  // resolves through resumeSession\n  return 1;\n}\n") &&
      hasGuard("function x() {\n  _requireSession_('x');\n}\n"),
    "a comment is not a guard call — that is how logoutSession hid");
  // getBootBundle/resumeSession/changeOwnPassword take a token and resolve it
  // themselves, so they are guarded, not public.
  ['getBootBundle', 'resumeSession', 'changeOwnPassword', 'adminResetPassword'].forEach(function (n) {
    check(n + " identifies by token", B[n] && B[n].indexOf('resumeSession') !== -1 || n === 'resumeSession',
      "a credential path must resolve the caller itself");
  });
}

console.log("\n9. every endpoint the client calls is in the apiCall registry");
{
  // ⚠️ WHY. apiCall dispatches through _apiMethods_(), an explicit allow-list — a dynamic
  // `this[method]` would expose _writeAccountPassword_ and every other internal. The cost is
  // that adding a server function and calling it through apiRun() is TWO edits, and missing
  // the second fails at RUN time with 「不正な呼び出しです。」, never at build time.
  //
  // It has now cost three shipped-broken features: loginUser on the first pass of the proxy
  // change (recorded in Index.html), saveSchedulePhrasesBatch (文言管理's 保存 button), and
  // shinsei_exportBatchMergedFromWebApp (一括出力). The first two were only found because
  // someone tried the button. Nothing in the suite knew the registry existed until now.
  const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
  const SRC  = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8') + '\n'
             + fs.readFileSync(path.join(ROOT, 'Shinsei_Code.js'), 'utf8');

  const serverFns = new Set((SRC.match(/^function [A-Za-z_]\w*\s*\(/gm) || [])
    .map(function (s) { return s.replace(/^function\s+/, '').replace(/\s*\($/, ''); }));

  // ⚠️ BOUNDED to the object literal. Reading to the end of SRC ran past it into
  // Shinsei_Code.js and picked up `fileName: fileName,` from a return statement — the
  // `name: name,` shape is not unique to a registry.
  const CODE = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
  const regStart = CODE.indexOf('_apiRegistry = {');
  const regBlock = CODE.slice(regStart, CODE.indexOf('\n  };', regStart));
  const registry = new Set((regBlock.match(/^\s*([A-Za-z_]\w*): \1,$/gm) || [])
    .map(function (s) { return s.trim().split(':')[0]; }));
  check("the apiCall registry was found", registry.size > 50, "found " + registry.size);

  // ⚠️ These deliberately stay on google.script.run: they run BEFORE a session exists or
  // manage the session itself, and resolve their own token. Routing them through apiCall —
  // which resumes a session first — is what broke loginUser. `apiCall` is the door itself.
  // ⚠️ checkSession joined 2026-09-11: apiCall RESUMES first, and resuming writes LastSeen —
  // the idle check must not, or an open tab never ages out of the 30-day expiry.
  const OFF_REGISTRY = new Set(['apiCall', 'loginUser', 'getBootBundle', 'logoutSession',
    'completePasswordSetup', 'changeOwnPassword', 'adminResetPassword', 'checkSession']);

  const called = new Set((HTML.match(/\.([A-Za-z_]\w*)\s*\(/g) || [])
    .map(function (s) { return s.slice(1).replace(/\s*\($/, ''); }));

  const missing = [];
  called.forEach(function (n) {
    if (serverFns.has(n) && !registry.has(n) && !OFF_REGISTRY.has(n)) missing.push(n);
  });
  check("⚠️ every server function the client calls is registered", missing.length === 0,
    "unreachable through apiRun(), fails at run time with 不正な呼び出しです。: " + missing.join(', '));

  // The other direction: a registry entry naming a function that no longer exists throws a
  // ReferenceError when _apiMethods_() is first built — i.e. it takes out EVERY endpoint.
  const dead = [];
  registry.forEach(function (n) { if (!serverFns.has(n)) dead.push(n); });
  check("...and every registry entry names a function that exists", dead.length === 0,
    "_apiMethods_() would throw on first use and take every call down with it: " + dead.join(', '));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
