// Authorization, not just authentication: the four fixes from the 2026-10-26 security review.
//
// ⚠️ WHY. endpoints.test counted _requireSession_ as a guard, so "somebody is signed in" passed
// for "may do this", and four holes sat behind a green suite:
//   1. 申請関連's five data endpoints: a 教務 (no view_shinsei) could read and delete every
//      applicant record from the console.
//   2. 面接スケジュール: any account could book, cancel or overwrite any teacher's slots; the one
//      ownership check read the role the BROWSER sent.
//   3. adminResetPassword returned a temporary password for ANY target, so a non-admin holding
//      manage_users could sign in as a 管理者権限 colleague.
//   6. The two trigger functions ran for anyone with master rights, and their throttle, set before
//      any check, let an anonymous call make the real trigger skip.
// The rest of the review, fixed the same day: §5 the readers keyed on a browser-sent id (7),
// §6 the forced password change (9), §7 per-account login limits and equal timing (4, 5),
// §8 the dorm PDF's escaping (8), §9 stored files' types (10).
//
// ⚠️ These run the REAL functions, extracted into a vm sandbox with Sheets stubbed (the
// session.test.js / pastslot.test.js pattern), and every guard is run against a mutation that
// removes it, which must fail.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const SHIN = fs.readFileSync(path.join(ROOT, 'Shinsei_Code.js'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function fnFrom(src, name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('no function ' + name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 2);
}
const codeFn = function (n) { return fnFrom(SRC, n); };
const shinFn = function (n) { return fnFrom(SHIN, n); };
function codeConst(name) {
  const m = SRC.match(new RegExp('\\nconst ' + name + '\\s+= [^\\n]*'));
  if (!m) throw new Error('no const ' + name);
  return m[0].replace('const ', 'var ');
}
function mutate(src, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error('mutation anchor found ' + n + ' times: ' + from.slice(0, 60));
  return src.replace(from, to);
}
function sandbox(sources, extra) {
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, info() {}, error() {} } }, extra || {}));
  vm.runInContext(sources.join('\n\n'), ctx);
  return ctx;
}
function outcome(f) {
  try { f(); return 'ok'; } catch (e) { return String((e && e.message) || e); }
}
// A caller's permission list, read the way _hasPerm_ reads the session (admin level passes).
function permStub(ctx) {
  return function (r, p, needed) {
    const u = ctx._authUser;
    if (!u) return false;
    if (u.admin) return true;
    return String(u.permissions || '').split(',').indexOf(needed) !== -1;
  };
}

// ---------------------------------------------------------------------------
console.log("\n1. 申請関連: view_shinsei to read, edit_shinsei to write");
{
  const READS = ['shinsei_getStudentNames', 'shinsei_getStudentDataForEdit'];
  const WRITES = ['shinsei_saveNewStudent', 'shinsei_updateExistingStudent', 'shinsei_deleteStudent'];
  // Reaching the spreadsheet or the lock means the guard let the call through.
  function run(name, user, src) {
    const ctx = sandbox([shinFn('_requireShinseiPerm_'), src || shinFn(name)], {
      _authUser: user,
      _requireSession_: function () { if (!ctx._authUser) throw new Error('DEAD'); },
      SpreadsheetApp: { getActiveSpreadsheet: function () { throw new Error('REACHED'); } },
      LockService: { getDocumentLock: function () { throw new Error('REACHED'); } },
    });
    ctx._hasPerm_ = permStub(ctx);
    return outcome(function () { ctx[name]('x', ['y']); });
  }
  const teacher = { role: 'teacher', permissions: 'view_teacher_schedule,view_admissions' };
  const viewer = { role: 'custom', permissions: 'view_shinsei' };
  const editor = { role: 'sales', permissions: 'view_shinsei,edit_shinsei' };
  const admin = { role: 'teacher', permissions: '', admin: true };
  READS.concat(WRITES).forEach(function (n) {
    check("⚠️ " + n + ": a 教務 without the permission is refused", run(n, teacher) === '権限がありません', run(n, teacher));
    check(n + ": a dead session still answers as dead (sign-out wins)", run(n, null) === 'DEAD', run(n, null));
    check(n + ": admin level passes", run(n, admin) === 'REACHED', run(n, admin));
  });
  READS.forEach(function (n) { check(n + ": view_shinsei is enough", run(n, viewer) === 'REACHED', run(n, viewer)); });
  WRITES.forEach(function (n) {
    check("⚠️ " + n + ": view_shinsei alone cannot write", run(n, viewer) === '権限がありません', run(n, viewer));
    check(n + ": edit_shinsei writes", run(n, editor) === 'REACHED', run(n, editor));
  });
  // Mutation: the pre-fix shape (session only) lets the 教務 through.
  const old = mutate(shinFn('shinsei_deleteStudent'), '  _requireShinseiPerm_("edit_shinsei");\n', '');
  check("  mutation: without the line, a 教務 deletes", run('shinsei_deleteStudent', teacher, old) === 'REACHED', "");
  const oldRead = mutate(shinFn('shinsei_getStudentDataForEdit'), '  _requireShinseiPerm_("view_shinsei");\n', '');
  check("  mutation: without the line, a 教務 reads a record",
    run('shinsei_getStudentDataForEdit', teacher, oldRead) === 'REACHED', "");
}

// ---------------------------------------------------------------------------
console.log("\n2. 面接スケジュール: the server mirrors the screen, from the session");
function row(tid, status, student, inCharge) {
  const r = new Array(25).fill('');
  r[1] = tid; r[2] = '先生'; r[3] = '2027-01-11'; r[4] = '10:00'; r[5] = status;
  r[6] = student || ''; r[11] = inCharge || '';
  return r;
}
const T1 = { role: 'teacher', id: 'T1', name: '先生', permissions: 'view_teacher_schedule,view_admissions' };
const SALES = { role: 'sales', id: 'S1', name: '丁村', permissions: 'view_admissions,edit_admissions' };
const OTHER = { role: 'sales', id: 'S2', name: '佐藤', permissions: 'view_admissions' };
const BARE = { role: 'custom', id: 'S3', name: '鈴木', permissions: 'view_students' };
const ADMIN = { role: 'sales', id: 'S9', name: '管理', permissions: '', admin: true };
const DENY_SRC = [codeConst('SCHED_LIVE_STATUSES'), codeFn('_normName_'),
                  codeFn('_scheduleOwnSlot_'), codeFn('_scheduleDenyReason_')];
function deny(user, r, tid, status, src) {
  const ctx = sandbox(src || DENY_SRC, { _authUser: user });
  ctx._hasPerm_ = permStub(ctx);
  ctx._isAdminLevel_ = function () { return !!(ctx._authUser && ctx._authUser.admin); };
  return ctx._scheduleDenyReason_(r, tid, status);
}
{
  const open = row('T1', 'Available'), none = row('T1', 'None'), off = row('T1', 'Unavailable');
  const mine = row('T1', 'Booked', '学生A', '丁村');
  const cancelReq = row('T1', 'Cancel_Request', '学生A', '丁村');
  const blankOwner = row('T1', 'Booked', '学生A', '');
  // The 教務's own column.
  check("a 教務 opens their own slot (〇)", deny(T1, none, 'T1', 'Available') === '', "");
  check("a 教務 closes their own slot (✖)", deny(T1, open, 'T1', 'Unavailable') === '', "");
  check("a 教務 asks to cancel their own booking", deny(T1, mine, 'T1', 'Cancel_Request') === '', "");
  check("⚠️ a 教務 cannot touch ANOTHER teacher's open slot (the grid makes it unclickable)",
    deny(T1, row('T2', 'Available'), 'T2', 'Booked') === 'perm', "");
  check("⚠️ ...nor another teacher's booking", deny(T1, row('T2', 'Booked', 'X', '丁村'), 'T2', 'Available') === 'perm', "");
  check("⚠️ staff id T1 is not teacher T1 (no shared id space)",
    deny({ role: 'sales', id: 'T1', name: 'x', permissions: '' }, none, 'T1', 'Available') === 'perm', "");
  // 営業 and every other non-admin role.
  check("a 営業 books an open slot", deny(SALES, open, 'T1', 'Booked') === '', "");
  check("⚠️ a 営業 cannot open or close a teacher's availability",
    deny(SALES, open, 'T1', 'Unavailable') === 'perm' && deny(SALES, none, 'T1', 'Available') === 'perm', "");
  check("⚠️ ...nor book a slot the teacher has not opened", deny(SALES, off, 'T1', 'Booked') === 'perm', "");
  check("the 担当 edits, clears and cancel-requests their booking",
    deny(SALES, mine, 'T1', 'Booked') === '' && deny(SALES, mine, 'T1', 'Available') === '' &&
    deny(SALES, mine, 'T1', 'Cancel_Request') === '' && deny(SALES, cancelReq, 'T1', 'Booked') === '', "");
  check("⚠️ another 営業 cannot change it", deny(OTHER, mine, 'T1', 'Available') === 'owner', "");
  check("⚠️ a booking with a blank 担当 belongs to nobody (the screen shows it read-only)",
    deny(SALES, blankOwner, 'T1', 'Booked') === 'owner', "");
  check("a full-width-spaced 担当 still matches (_normName_)",
    deny({ role: 'sales', id: 'S4', name: '営業 花子', permissions: 'view_admissions' },
         row('T1', 'Booked', 'X', '営業　花子 '), 'T1', 'Available') === '', "");
  check("⚠️ a role without view_admissions books nothing", deny(BARE, open, 'T1', 'Booked') === 'perm', "");
  check("admin level does anything", deny(ADMIN, row('T2', 'Booked', 'X', '他人'), 'T2', 'None') === '', "");
  check("⚠️ no session, no change", deny(null, open, 'T1', 'Booked') === 'perm', "");
  // The request endpoints pass null: only a booking can be asked about.
  check("a request on an open slot is refused for a non-teacher", deny(SALES, open, 'T1', null) === 'perm', "");
  check("a request by the 担当 is allowed", deny(SALES, mine, 'T1', null) === '', "");
  // Mutations.
  const noOwn = DENY_SRC.slice(0, 3).concat([mutate(codeFn('_scheduleDenyReason_'),
    'return _scheduleOwnSlot_(teacherId) ? "" : "perm";', 'return "";')]);
  check("  mutation: an unrestricted 教務 is caught", deny(T1, row('T2', 'Available'), 'T2', 'Booked', noOwn) === '', "");
  const noOwner = DENY_SRC.slice(0, 3).concat([mutate(codeFn('_scheduleDenyReason_'),
    'return (owner !== "" && owner === _normName_(_authUser.name)) ? "" : "owner";', 'return "";')]);
  check("  mutation: dropping the 担当 rule lets another 営業 in", deny(OTHER, mine, 'T1', 'Available', noOwner) === '', "");
}

// The real batch: a refused update is SKIPPED (calFlush would retry a throw forever) and
// writes nothing, not even its document, while the rest of the batch is written.
function runBatch(rows, updates, user, lockedSrc) {
  const writes = [], appends = [], uploads = [];
  const HEADER = new Array(25).fill('h');
  const sheet = {
    getLastColumn: function () { return 25; },
    getLastRow: function () { return rows.length + 1 + appends.length; },
    appendRow: function (r) { appends.push(r); },
    getRange: function (r, c) {
      return { getValues: function () { return [HEADER]; },
               setValue: function (v) { writes.push({ r: r, c: c }); },
               setValues: function (v) { writes.push({ r: r, c: c }); } };
    },
  };
  const ctx = sandbox(DENY_SRC.concat([codeFn('_schedKey_'), codeFn('_slotIsPast_'), codeFn('_activeRequest_'),
                                       codeFn('saveScheduleBatch'), lockedSrc || codeFn('_saveScheduleBatchLocked_')]), {
    _authUser: user,
    Utilities: { formatDate: function () { return '2026-10-26 09:00'; }, base64Decode: function () { return []; },
                 newBlob: function () { return {}; } },
    DriveApp: { getFolderById: function () { return { createFile: function () { uploads.push(1); return { getUrl: function () { return 'u'; } }; } }; } },
    _requireConfig_: function () { return 'folder'; },
    _requireSession_: function () {},
    _readTabs_: function () { return { Schedule_DB: [HEADER].concat(rows) }; },
    _forgetTab_: function () {},
    _cellSafeRow_: function (a) { return a; },
    LockService: { getDocumentLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } },
    SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function () { return sheet; } }; } },
    _sendEmailNotif_: function () {}, _sendAdminCancelEmail_: function () {},
  });
  ctx._hasPerm_ = permStub(ctx);
  ctx._isAdminLevel_ = function () { return !!(ctx._authUser && ctx._authUser.admin); };
  // ⚠️ The browser-sent name and role claim to be the 担当 and 営業; they must decide nothing.
  const result = ctx.saveScheduleBatch(updates, '丁村', 'sales');
  return { result: result, writes: writes, appends: appends, uploads: uploads };
}
{
  const rows = [row('T1', 'Available'), row('T2', 'Booked', '学生B', '丁村')];
  const upd = function (tid, status, extra) {
    return Object.assign({ teacherId: tid, teacherName: '先生', date: '2027-01-11', period: '10:00',
                           status: status, student: status === 'Booked' ? '学生' : '' }, extra || {});
  };
  // A view-less custom role claims, by its ARGUMENTS, to be the 営業 丁村.
  const r = runBatch(rows, [upd('T1', 'Booked', { documentBase64: 'AA==' }), upd('T2', 'Available')], BARE);
  check("⚠️ a role without view_admissions writes nothing, whatever name and role it sends",
    r.writes.length === 0 && r.appends.length === 0, r.writes.length + " writes");
  check("⚠️ ...and stores no uploaded document", r.uploads.length === 0, "");
  check("...and is told why, in screen words", /権限のない枠は保存されませんでした（2件）/.test(r.result), r.result);
  const s = runBatch(rows, [upd('T1', 'Booked'), upd('T2', 'Available')], OTHER);
  check("a 営業 books the open slot but not another 担当's booking",
    s.writes.some(function (w) { return w.r === 2; }) && !s.writes.some(function (w) { return w.r === 3; }),
    JSON.stringify(s.writes));
  check("...and the refusal names the 担当 rule", /担当者ではないため/.test(s.result), s.result);
  const o = runBatch(rows, [upd('T2', 'Available')], SALES);
  check("the 担当 clears their own booking", o.writes.some(function (w) { return w.r === 3; }) && o.result === 'Success', o.result);
  // Mutation: the pre-fix decision (the browser's role and name) lets the claim through.
  const oldLocked = mutate(codeFn('_saveScheduleBatchLocked_'),
    'const deny = _scheduleDenyReason_(rowMap[key] ? data[rowMap[key] - 1] : null, u.teacherId,\n                                      String(u.status || ""));',
    'const deny = "";');
  const m = runBatch(rows, [upd('T2', 'Available')], BARE, oldLocked);
  check("  mutation: without the session decision, the claim clears someone's booking",
    m.writes.some(function (w) { return w.r === 3; }), "");
}

// The two request endpoints refuse BEFORE any write.
{
  function runReq(name, user, r, src) {
    const writes = [];
    const sheet = { getRange: function (rr, c) { return { setValue: function () { writes.push(c); } }; } };
    const ctx = sandbox(DENY_SRC.concat([src || codeFn(name)]), {
      _authUser: user,
      _requireSession_: function () {},
      SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function () { return sheet; } }; } },
      _findScheduleRow_: function () { return { row: r, rowIndex: 2 }; },
      _requireNoActiveRequest_: function () { throw new Error('PASSED'); },
    });
    ctx._hasPerm_ = permStub(ctx);
    ctx._isAdminLevel_ = function () { return !!(ctx._authUser && ctx._authUser.admin); };
    const out = name === 'requestReassignment'
      ? outcome(function () { ctx.requestReassignment('T1', '2027-01-11', '10:00', 'T2', '', '', 'r'); })
      : outcome(function () { ctx.requestBookerDateChange('T1', '2027-01-11', '10:00', '2027-01-12', '11:00', 'r', 'x'); });
    return { out: out, writes: writes };
  }
  const booked = row('T1', 'Booked', '学生A', '丁村');
  ['requestReassignment', 'requestBookerDateChange'].forEach(function (n) {
    const a = runReq(n, OTHER, booked);
    check("⚠️ " + n + ": a non-担当 is refused, and nothing is written",
      a.out === 'この予約を変更する権限がありません。' && a.writes.length === 0, a.out);
    check(n + ": the slot's own 教務 passes", runReq(n, T1, booked).out === 'PASSED', runReq(n, T1, booked).out);
    check(n + ": the 担当 passes", runReq(n, SALES, booked).out === 'PASSED', "");
    check("⚠️ " + n + ": another 教務 is refused", runReq(n, Object.assign({}, T1, { id: 'T2' }), booked).out !== 'PASSED', "");
  });
  const oldReq = mutate(codeFn('requestBookerDateChange'),
    'if (_scheduleDenyReason_(found.row, teacherId, null) !== "") {', 'if (false) {');
  check("  mutation: without the check, a non-担当 reaches the request",
    runReq('requestBookerDateChange', OTHER, booked, oldReq).out === 'PASSED', "");
}

// ---------------------------------------------------------------------------
console.log("\n3. adminResetPassword: an admin-level target needs an admin-level caller");
{
  const ROLES = { sales: { key: 'sales', label: '営業' }, teacher: { key: 'teacher', label: '教務' },
                  admin: { key: 'admin', label: '管理者', admin: true },
                  dept: { key: 'dept', label: '教務部', admin: true }, plain: { key: 'plain', label: '事務' } };
  function staffRow(id, role, flag) {
    const r = new Array(13).fill(''); r[0] = id; r[1] = '名前' + id; r[3] = id + '@x';
    r[11] = role || ''; r[12] = flag ? 'Y' : ''; return r;
  }
  function run(caller, acct, targetRole, src) {
    const written = [];
    const ctx = sandbox([codeConst('STAFF_ROLE_IDX'), codeConst('ADMIN_FLAG_IDX'), codeFn('_adminFlagFromRow_'),
                         codeFn('_staffRoleFromRow_'), codeFn('_userFromRow_'), src || codeFn('adminResetPassword')], {
      resumeSession: function () { ctx._authUser = caller; return caller; },
      _roleByKey_: function (k) { return ROLES[String(k || '').trim()] || null; },
      _findAccountById_: function () { return acct; },
      _tempPassword_: function () { return 'TMP'; },
      _writeAccountPassword_: function (a) { written.push(a.row[0]); },
      _logActivity_: function () {},
    });
    ctx._hasPerm_ = function (r, p, needed) { return needed === 'manage_users'; };   // the caller holds it
    ctx._isAdminLevel_ = function () { return !!(ctx._authUser && ctx._authUser.admin); };
    let res; const out = outcome(function () { res = ctx.adminResetPassword('tok', targetRole, acct.row[0]); });
    return { out: out, written: written, res: res };
  }
  const helper = { role: 'plain', id: 'S5', name: '事務', permissions: 'manage_users' };
  const boss = { role: 'dept', id: 'S6', name: '部長', permissions: '', admin: true };
  const staff = function (row) { return { sheetName: 'Staff_Master', rowIndex: 2, row: row }; };
  const MSG = '管理者権限のあるユーザーのパスワードは、管理者またはマスターのみリセットできます。';
  const p = run(helper, staff(staffRow('S1', 'plain', true)), 'sales');
  check("⚠️ a non-admin with manage_users cannot reset a person-flagged admin", p.out === MSG && p.written.length === 0, p.out);
  const d = run(helper, staff(staffRow('S2', 'dept', false)), 'sales');
  check("⚠️ ...nor a member of a flagged role", d.out === MSG && d.written.length === 0, d.out);
  check("⚠️ ...nor a stored legacy 'admin'", run(helper, staff(staffRow('S3', 'admin', false)), 'sales').out === MSG, "");
  const t = run(helper, { sheetName: 'Teacher_Master', rowIndex: 2, row: staffRow('T7', '', true) }, 'teacher');
  check("⚠️ ...nor a flagged 教務", t.out === MSG && t.written.length === 0, t.out);
  check("⚠️ the role is read from the ROW: claiming 'sales' for a flagged-role row changes nothing", d.out === MSG, "");
  const ok = run(helper, staff(staffRow('S4', 'plain', false)), 'sales');
  check("an ordinary colleague is still reset, and the password returned",
    ok.out === 'ok' && ok.written[0] === 'S4' && ok.res.tempPassword === 'TMP', ok.out);
  check("admin level may reset another admin", run(boss, staff(staffRow('S1', 'plain', true)), 'sales').out === 'ok', "");
  const old = mutate(codeFn('adminResetPassword'),
    'if (_userFromRow_(acct.row, tRole).isAdmin && !_isAdminLevel_("")) {', 'if (false) {');
  check("  mutation: without the check, the helper takes the admin's account",
    run(helper, staff(staffRow('S1', 'plain', true)), 'sales', old).written.length === 1, "");
}

// ---------------------------------------------------------------------------
console.log("\n4. the triggers run for a real trigger or an unlocked editor run, and nobody else");
{
  function gateCtx(opts, extraSrc) {
    opts = opts || {};
    const st = { puts: 0, ran: 0 };
    const ctx = sandbox([codeConst('MAINT_UNLOCK_PROP'), codeFn('_requireMaintenanceUnlock_'),
                         opts.gate || codeFn('_requireTriggerOrUnlock_')].concat(extraSrc || []), {
      ScriptApp: { getProjectTriggers: function () {
        if (opts.scriptAppDown) throw new Error('Authorization is required');
        return [{ getUniqueId: function () { return '8812345'; } }];
      } },
      PropertiesService: { getScriptProperties: function () { return {
        getProperty: function (k) { return k === 'MAINTENANCE_UNLOCK' ? (opts.unlock || null) : null; } }; } },
      Utilities: { formatDate: function () { return '2026-10-26'; } },
      CacheService: { getScriptCache: function () { return {
        get: function () { return null; }, put: function () { st.puts++; } }; } },
    });
    ctx.st = st;
    return ctx;
  }
  const gate = function (e, opts) { return outcome(function () { gateCtx(opts)._requireTriggerOrUnlock_(e, 'x'); }); };
  check("a real trigger's event passes", gate({ triggerUid: '8812345' }) === 'ok', "");
  check("⚠️ a forged triggerUid is refused", /ロックされています/.test(gate({ triggerUid: '1' })), gate({ triggerUid: '1' }));
  check("⚠️ no event (a browser call) is refused", /ロックされています/.test(gate(undefined)), "");
  check("⚠️ a non-object is refused", /ロックされています/.test(gate('8812345')), "");
  check("an editor Run with today's unlock passes", gate(undefined, { unlock: '2026-10-26' }) === 'ok', "");
  check("a stale unlock is refused", /ロックされています/.test(gate(undefined, { unlock: '2026-10-25' })), "");
  check("⚠️ an unreadable ScriptApp fails CLOSED, even for a real uid",
    /ロックされています/.test(gate({ triggerUid: '8812345' }, { scriptAppDown: true })), "");
  const trusting = mutate(codeFn('_requireTriggerOrUnlock_'), 'if (ok) return;', 'return;');
  check("  mutation: believing any uid is caught", gate({ triggerUid: '1' }, { gate: trusting }) === 'ok', "");

  // The real trigger functions: a refused call never reaches the throttle or the job.
  ['triggerScheduledBackup', 'triggerAutoSyncStudents'].forEach(function (n) {
    const ctx = gateCtx({}, [codeFn(n)]);
    const out = outcome(function () { ctx[n]({ triggerUid: 'forged' }); });
    check("⚠️ " + n + " refuses a browser call", /ロックされています/.test(out), out);
    check("⚠️ " + n + ": ...WITHOUT setting the throttle (the real trigger must not skip)", ctx.st.puts === 0, ctx.st.puts + " puts");
  });
  const late = mutate(codeFn('triggerScheduledBackup'), '  _requireTriggerOrUnlock_(e, "triggerScheduledBackup");\n', '');
  const lateGated = late.replace("cache.put('schedBackupRan', '1', SCHEDULED_BACKUP_MIN_GAP_SEC);",
    "cache.put('schedBackupRan', '1', 1); _requireTriggerOrUnlock_(e, 'x');");
  const lc = gateCtx({}, [lateGated]);
  outcome(function () { lc.triggerScheduledBackup({ triggerUid: 'forged' }); });
  check("  mutation: gating AFTER the throttle sets it for the attacker", lc.st.puts === 1, "");
}

// ---------------------------------------------------------------------------
console.log("\n5. finding 7: the readers take identity from the session, and ask a permission");
{
  const sched = [new Array(25).fill('h'),
    (function () { const r = new Array(25).fill(''); r[1] = 'T1'; r[5] = 'Reassign_Pending'; r[12] = 'T2'; r[6] = '学生'; return r; })(),
    (function () { const r = new Array(25).fill(''); r[1] = 'T1'; r[5] = 'Cancel_Request'; r[11] = '佐藤'; r[6] = '学生'; return r; })()];
  function feed(name, user, arg, src) {
    const ctx = sandbox([codeFn('_normName_'), src || codeFn(name)], {
      _authUser: user, _requireSession_: function () {},
      _readTabs_: function () { return { Schedule_DB: sched }; },
    });
    return ctx[name](arg).length;
  }
  const t2 = { role: 'teacher', id: 'T2', name: '先生B' }, t3 = { role: 'teacher', id: 'T3', name: '先生C' };
  const sato = { role: 'sales', id: 'S2', name: '佐藤' }, other = { role: 'sales', id: 'S5', name: '他人' };
  check("a teacher sees the 交代 request addressed to them", feed('getTeacherNotifications', t2, 'T2') === 1, "");
  check("⚠️ another teacher passing T2's id sees nothing", feed('getTeacherNotifications', t3, 'T2') === 0, "");
  check("⚠️ staff id T2 is not teacher T2", feed('getTeacherNotifications', { role: 'sales', id: 'T2', name: 'x' }, 'T2') === 0, "");
  check("the 担当 sees the cancellation on their booking", feed('getPendingNotifications', sato, '佐藤') === 1, "");
  check("⚠️ a colleague passing 佐藤's name sees nothing", feed('getPendingNotifications', other, '佐藤') === 0, "");
  const oldT = mutate(codeFn('getTeacherNotifications'),
    '  if (!_authUser || String(_authUser.role || "") !== "teacher") return [];\n  const me = String(_authUser.id || "").trim();',
    '  const me = String(teacherId || "").trim();');
  check("  mutation: the argument deciding is caught", feed('getTeacherNotifications', t3, 'T2', oldT) === 1, "");
  const oldP = mutate(codeFn('getPendingNotifications'), 'const me = _normName_(_authUser ? _authUser.name : "");',
                      'const me = _normName_(staffName);');
  check("  mutation: the name argument deciding is caught", feed('getPendingNotifications', other, '佐藤', oldP) === 1, "");

  function gated(name, user, extra) {
    const ctx = sandbox([codeFn(name)], Object.assign({
      _authUser: user, _requireSession_: function () {}, SHEET_BUILDING: 'Building_Info',
      _readTabs_: function () { throw new Error('REACHED'); },
    }, extra || {}));
    ctx._hasPerm_ = permStub(ctx);
    ctx._permOrLegacyRole_ = function (r, p, needed, legacy) {
      return legacy.indexOf(ctx._authUser.role) !== -1 || ctx._hasPerm_(r, p, needed);
    };
    return outcome(function () { ctx[name]('x'); });
  }
  const bare = { role: 'custom', permissions: 'view_students' };
  check("⚠️ getAllTeachersSchedule refuses a role with neither schedule permission",
    gated('getAllTeachersSchedule', bare) === '権限がありません', "");
  check("...a 教務 (view_teacher_schedule) reads it", gated('getAllTeachersSchedule',
    { role: 'teacher', permissions: 'view_teacher_schedule' }) === 'REACHED', "");
  check("...and view_admissions reads it", gated('getAllTeachersSchedule', { role: 'custom', permissions: 'view_admissions' }) === 'REACHED', "");
  check("⚠️ getSpecificBuilding refuses a role without view_dorms (door and Wi-Fi codes)",
    gated('getSpecificBuilding', bare) === '権限がありません', "");
  check("...view_dorms reads it", gated('getSpecificBuilding', { role: 'custom', permissions: 'view_dorms' }) === 'REACHED', "");
  check("...and the legacy 営業 role, as getDormData allows", gated('getSpecificBuilding', { role: 'sales', permissions: '' }) === 'REACHED', "");
}

// ---------------------------------------------------------------------------
console.log("\n6. finding 9: a must-set-password session cannot use apiCall");
{
  function call(needs, src) {
    const ctx = sandbox(['var _authUser = null; var _authToken = ""; var ran = 0;',
      'function _apiMethods_() { return { probe: function () { ran++; return 1; } }; }',
      'function resumeSession() { _authUser = { role: "sales", id: "5" }; return _authUser; }',
      'function _sessionDeadError_(m) { const e = new Error(m); e.sessionDead = true; return e; }',
      'function _accountNeedsPassword_() { return ' + (needs ? 'true' : 'false') + '; }',
      src || codeFn('apiCall')], {});
    let err = null; try { ctx.apiCall('tok', 'probe', []); } catch (e) { err = e; }
    return { err: err, ran: ctx.ran, user: vm.runInContext('_authUser', ctx), tok: vm.runInContext('_authToken', ctx) };
  }
  const blocked = call(true);
  check("⚠️ an account that must set its password runs nothing", blocked.ran === 0 && !!blocked.err, "");
  check("...and the error signs the tab out (session-dead, 再度ログイン)",
    blocked.err && blocked.err.sessionDead === true && /再度ログインしてください/.test(blocked.err.message), "");
  check("...and nothing is left parked", blocked.user === null && blocked.tok === "", "");
  check("an ordinary account runs", call(false).ran === 1, "");
  const old = mutate(codeFn('apiCall'), 'if (_accountNeedsPassword_(_authUser)) {', 'if (false) {');
  check("  mutation: without the check, a temporary-password session uses the app", call(true, old).ran === 1, "");
}

// ---------------------------------------------------------------------------
console.log("\n7. findings 4 and 5: per-account limit, no sleeping flood, equal timing");
{
  const LOGIN_SRC = [codeConst('LOGIN_FAIL_DELAY_MS'), codeConst('LOGIN_FAIL_WINDOW'),
    codeConst('LOGIN_ACCOUNT_MAX'), codeConst('LOGIN_ACCOUNT_WINDOW'), 'var PW_ITERATIONS = 3;',
    codeFn('_noteLoginFailure_'), codeFn('_loginAttemptKey_'), codeFn('_reserveLoginAttempt_'),
    codeFn('_clearLoginAttempts_'), codeFn('_burnPasswordHash_'), codeFn('_rejectLogin_'),
    codeFn('_refuseLoginAttempt_'), codeConst('LOGIN_BUCKET_DEVICES'), codeFn('_loginBucket_'),
    codeFn('_reportLoginBlock_'), codeFn('_sessionDevice_')];
  const crypto = require('crypto');
  // Accounts: a@x (notifications ON), off@x (OFF). Sessions: device DEV-SATO-1 has been used by
  // 佐藤 (S2), twice (de-duplicated), DEV-NEW-1 by nobody.
  const ACCOUNTS = { 'a@x': ['S1', 'A', '', 'a@x', 'ON'], 'off@x': ['S3', 'C', '', 'off@x', 'OFF'] };
  const SESSIONS = [['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen', 'Device', 'DeviceId'],
    ['t1', 'sales', 'S2', '佐藤', '', '', 'Chrome・Windows', 'DEV-SATO-1'],
    ['t2', 'sales', 'S2', '佐藤', '', '', 'Chrome・Windows', 'DEV-SATO-1'],
    ['t3', 'sales', 'S1', 'A', '', '', 'Safari・iPhone', 'DEV-A-PHONE']];
  function world(opts) {
    opts = opts || {};
    const st = { cache: {}, sleeps: 0, hashes: 0, lockFree: !opts.busy, cacheDown: !!opts.cacheDown,
                 logs: [], mails: [], now: 1e12 };
    st.ctx = function (loginSrc) {
      const ctx = sandbox(LOGIN_SRC.concat([loginSrc || codeFn('loginUser')]), {
        console: { warn() {}, log() {} },
        // Constructible: the reporter calls new Date() for the email's timestamp.
        Date: (function () { function D() { return new Date(st.now); } D.now = function () { return st.now; }; return D; })(),
        LockService: { getScriptLock: function () { return { tryLock: function () { return st.lockFree; }, releaseLock: function () {} }; } },
        CacheService: { getScriptCache: function () {
          if (st.cacheDown) throw new Error('cache down');
          return { get: function (k) { return st.cache[k] || null; }, put: function (k, v, ttl) { st.cache[k] = v; st.lastTtl = ttl; },
                   remove: function (k) { delete st.cache[k]; } }; } },
        Utilities: { sleep: function () { st.sleeps++; }, DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
          formatDate: function () { return '2026/10/26 10:00'; },
          computeDigest: function (a, s) { return Array.from(crypto.createHash('sha256').update(s).digest()).map(function (b) { return b > 127 ? b - 256 : b; }); } },
        _hashPassword_: function () { st.hashes++; return 'h'; },
        _systemPin_: function () { return 'master-pin-123'; },
        _findAccountByEmail_: function (e) {
          const r = ACCOUNTS[String(e).trim().toLowerCase()];
          return r ? { row: r, role: 'sales' } : null;
        },
        _verifyAccountPassword_: function (row, pw) { st.hashes++; return { ok: pw === 'right-pass', mustSetPassword: false }; },
        _userFromRow_: function () { return { role: 'sales', id: 'S1', name: 'A' }; },
        _issueSessionToken_: function () { return 'tok'; },
        _bootPayload_: function () { return {}; },
        SESSION_SHEET: 'Sessions', _getSessionSheet_: function () {},
        _readTabs_: function () { if (opts.sessionsDown) throw new Error('read failed'); return { Sessions: SESSIONS }; },
        _logActivity_: function (actor, action, target, details) { st.logs.push({ actor: actor, action: action, target: target, details: details }); },
        _mailOptions_: function () { return {}; },
        GmailApp: { sendEmail: function (to, subj, body) { if (opts.mailDown) throw new Error('mail down'); st.mails.push({ to: to, subj: subj, body: body }); } },
      });
      return ctx;
    };
    st.login = function (email, pw, src, device) {
      return outcome(function () { st.ctx(src).loginUser(email, pw, device === undefined ? null : device); });
    };
    return st;
  }
  const WRONG = 'メールアドレスまたはパスワードが正しくありません。';
  const w = world();
  const tries = [1, 2, 3, 4, 5].map(function () { return w.login('a@x', 'nope'); });
  check("five wrong passwords are each answered as wrong", tries.every(function (t) { return t === WRONG; }), tries.join('|'));
  const sleepsBefore = w.sleeps;
  const sixth = w.login('a@x', 'right-pass');
  check("⚠️ the sixth attempt is refused, even with the right password", /試行回数が多すぎます/.test(sixth), sixth);
  check("⚠️ ...WITHOUT sleeping (a flood holds no executions)", w.sleeps === sleepsBefore, "");
  check("a different account is unaffected", w.login('b@x', 'nope') === WRONG, "");
  check("the name is matched case- and space-insensitively", /試行回数/.test(w.login('  A@X ', 'nope')), "");
  check("the flat delay never escalates", w.sleeps === 6, "sleeps=" + w.sleeps);
  // 'loginFails' is the global counter kept for the log line; every other key is per account.
  const acctKeys = function (c) { return Object.keys(c).filter(function (k) { return k !== 'loginFails'; }); };
  check("the cache holds no email, only a hash",
    acctKeys(w.cache).length === 2 && acctKeys(w.cache).every(function (k) { return /^loginTry_[0-9a-f]{24}$/.test(k); }),
    Object.keys(w.cache).join(','));
  const u = world();
  [1, 2, 3, 4, 5].forEach(function () { u.login('ghost@x', 'nope'); });
  check("⚠️ an unknown email is limited the same way (the limit reveals nothing)", /試行回数/.test(u.login('ghost@x', 'nope')), "");
  const ok = world();
  ok.login('a@x', 'nope'); ok.login('a@x', 'nope');
  const okRes = ok.login('a@x', 'right-pass');
  check("a correct password after two typos signs in", okRes === 'ok', okRes);
  check("...and clears that account's count", acctKeys(ok.cache).length === 0, Object.keys(ok.cache).join(','));
  const m = world();
  [1, 2, 3, 4, 5].forEach(function () { m.login('MASTER', 'nope'); });
  check("MASTER is limited too", /試行回数/.test(m.login('master', 'master-pin-123')), "");
  check("⚠️ a busy lock REFUSES rather than letting an attempt through uncounted",
    /混み合っています/.test(world({ busy: true }).login('a@x', 'right-pass')), "");
  check("a cache outage still lets staff sign in (the flat delay still applies)",
    world({ cacheDown: true }).login('a@x', 'right-pass') === 'ok', "");
  const t = world();
  t.login('ghost@x', 'nope'); const unknownHashes = t.hashes;
  t.login('a@x', 'nope'); const knownHashes = t.hashes - unknownHashes;
  check("⚠️ an unknown email spends a full hash, like a known one (finding 5)", unknownHashes === 1 && knownHashes === 1,
    unknownHashes + " vs " + knownHashes);
  const noLimit = mutate(codeFn('loginUser'), '  if (slot.state !== "ok") _refuseLoginAttempt_(slot.state);\n', '');
  const n = world();
  [1, 2, 3, 4, 5, 6, 7].forEach(function () { n.login('a@x', 'nope', noLimit); });
  check("  mutation: without the limit, a seventh guess is checked", n.login('a@x', 'right-pass', noLimit) === 'ok', "");
  const fast = mutate(codeFn('loginUser'), 'if (!acct) { _burnPasswordHash_(pw); _rejectLogin_("no such email"); }',
                      'if (!acct) { _rejectLogin_("no such email"); }');
  const f = world(); f.login('ghost@x', 'nope', fast);
  check("  mutation: skipping the hash on an unknown email is caught", f.hashes === 0, "");
  // _verifyAccountPassword_'s own legacy branch: a PIN-era account spends the hash too.
  const v = sandbox([codeConst('PW_ALGO_TAG'), 'var PW_ITERATIONS = 3; var burned = 0;',
    'function _burnPasswordHash_() { burned++; }', 'function _hashPassword_() { return "x"; }',
    'function _hashesEqual_(a, b) { return a === b; }', codeFn('_verifyAccountPassword_')], {});
  v._verifyAccountPassword_(['S1', 'A', '1234', 'a@x', '', '', '', '', ''], 'nope');
  check("⚠️ a legacy-PIN account spends the hash too", vm.runInContext('burned', v) === 1, "");

  // --- Who tripped it: one 操作履歴 row and one email per block (2026-10-26) -------------------
  const SATO = { label: 'Chrome・Windows', id: 'DEV-SATO-1' };
  const r = world();
  [1, 2, 3, 4, 5].forEach(function () { r.login('a@x', 'nope', null, SATO); });
  check("five failures alone record nothing (not blocked yet)", r.logs.length === 0 && r.mails.length === 0, "");
  r.login('a@x', 'nope', null, SATO);
  check("⚠️ the first refusal writes exactly one 操作履歴 row", r.logs.length === 1, r.logs.length + " rows");
  const row = r.logs[0] || {};
  check("...as ログイン一時停止, against the blocked account", row.action === 'ログイン一時停止' && row.target === 'A (S1)', JSON.stringify(row));
  check("...naming the device and who has signed in from it", /Chrome・Windows \[DEV-SATO\]/.test(row.details || '') &&
    /同じ端末でログインしたことのあるユーザー: 佐藤 \(S2\)$/.test(row.details || ''), row.details);
  check("...with no culprit word, and 佐藤 listed once", !/犯人/.test(row.details || '') && (row.details || '').split('佐藤').length === 2, row.details);
  check("...from the login screen, not from a session", row.actor && row.actor.name === '（ログイン画面）', "");
  check("the blocked person is emailed (notifications ON)", r.mails.length === 1 && r.mails[0].to === 'a@x', JSON.stringify(r.mails));
  const mail = r.mails[0] || { body: '' };
  check("...the email names the device, and NEVER the other users",
    /Chrome・Windows/.test(mail.body) && !/佐藤/.test(mail.body) && /管理者にお知らせください/.test(mail.body), mail.body);
  r.login('a@x', 'nope', null, SATO); r.login('a@x', 'right-pass', null, SATO);
  check("⚠️ later refusals in the window record and send nothing more", r.logs.length === 1 && r.mails.length === 1, "");

  // The flag must not extend the block: the rewrite keeps what is left of the window.
  const x = world();
  [1, 2, 3, 4, 5].forEach(function () { x.login('a@x', 'nope', null, SATO); });
  x.now += 600 * 1000;                     // 10 of the 15 minutes later
  x.login('a@x', 'nope', null, SATO);
  check("⚠️ reporting does not extend the block (TTL = what is left)", x.lastTtl === 300, "ttl=" + x.lastTtl);

  const g = world();
  [1, 2, 3, 4, 5, 6, 7].forEach(function () { g.login('ghost@x', 'nope', null, SATO); });
  check("⚠️ an unknown email at its limit writes no row and sends no email", g.logs.length === 0 && g.mails.length === 0, "");

  const two = world();
  [SATO, { label: 'Firefox・Mac', id: 'DEV-NEW-1' }, SATO, null, SATO, SATO].forEach(function (d) { two.login('a@x', 'nope', null, d); });
  const d2 = (two.logs[0] || {}).details || '';
  check("two devices are both listed, plus the attempt that sent none",
    /DEV-SATO/.test(d2) && /Firefox・Mac \[DEV-NEW-\]/.test(d2) && /端末情報なしの試行あり/.test(d2), d2);
  const none = world();
  [1, 2, 3, 4, 5, 6].forEach(function () { none.login('a@x', 'nope', null, null); });
  check("no device id at all says so", /端末: 端末情報なし$/.test((none.logs[0] || {}).details || ''), (none.logs[0] || {}).details);
  const fresh = world();
  [1, 2, 3, 4, 5, 6].forEach(function () { fresh.login('a@x', 'nope', null, { label: 'Edge', id: 'DEV-NEW-1' }); });
  check("a device nobody signed in from says なし（初めての端末）", /なし（初めての端末）$/.test((fresh.logs[0] || {}).details || ''), "");

  const off = world();
  [1, 2, 3, 4, 5, 6].forEach(function () { off.login('off@x', 'nope', null, SATO); });
  check("notifications OFF: the row is written, no email", off.logs.length === 1 && off.mails.length === 0, "");
  const ms = world();
  [1, 2, 3, 4, 5, 6].forEach(function () { ms.login('MASTER', 'nope', null, SATO); });
  check("MASTER: the row is written, no email", ms.logs.length === 1 && ms.mails.length === 0 && ms.logs[0].target === 'システム (MASTER)', "");

  const broke = world({ sessionsDown: true, mailDown: true });
  [1, 2, 3, 4, 5].forEach(function () { broke.login('a@x', 'nope', null, SATO); });
  const brokeRes = broke.login('a@x', 'right-pass', null, SATO);
  check("⚠️ a reporting failure still refuses the login", /試行回数/.test(brokeRes), brokeRes);
  check("...and the row says the device's users could not be checked, rather than 'none'",
    /確認できませんでした/.test((broke.logs[0] || {}).details || ''), (broke.logs[0] || {}).details);

  const legacy = world();
  legacy.cache[Object.keys((function () { const w2 = world(); w2.login('a@x', 'nope'); return w2.cache; })())
    .filter(function (k) { return k !== 'loginFails'; })[0]] = '5';
  check("a bucket in the old bare-number shape still limits", /試行回数/.test(legacy.login('a@x', 'right-pass')), "");

  // Mutation: run the reserve with the `logged` check removed against an already-reported bucket.
  const noFlag = mutate(codeFn('_reserveLoginAttempt_'), '      if (b.logged) return { state: "limit", bucket: b };\n', '');
  const rs = sandbox([codeConst('LOGIN_ACCOUNT_MAX'), codeConst('LOGIN_ACCOUNT_WINDOW'), codeConst('LOGIN_BUCKET_DEVICES'),
                      codeFn('_loginBucket_'), noFlag], {
    _loginAttemptKey_: function () { return 'k'; }, Date: { now: function () { return 1; } },
    LockService: { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } },
    CacheService: { getScriptCache: function () { return { get: function () { return rs.__v || null; }, put: function (k, v) { rs.__v = v; } }; } },
  });
  rs.__v = JSON.stringify({ n: 5, devs: {}, logged: true, exp: 2 });
  check("  mutation: without the logged flag every refusal reports",
    rs._reserveLoginAttempt_('a@x', {}).state === 'limit-first', "");
  const spray = mutate(mutate(codeFn('_reportLoginBlock_'),
    '      const acct = _findAccountByEmail_(id);\n',
    '      const acct = _findAccountByEmail_(id) || { row: ["?", "?", "", "", "OFF"] };\n'),
    '      if (!acct) { try { console.warn("Login limit reached for an unknown name: not recorded"); } catch (e) {} return; }\n', '');
  // Swap the reporter for the mutant and repeat the unknown-email case.
  const LOGIN_SRC_SPRAY = LOGIN_SRC.map(function (s) { return s.indexOf('function _reportLoginBlock_(') === 0 ? spray : s; });
  const spLogs = [];
  const spBox = sandbox(LOGIN_SRC_SPRAY.concat([codeFn('loginUser')]), {
    console: { warn() {}, log() {} }, Date: { now: function () { return 1e12; } },
    LockService: { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } },
    CacheService: { getScriptCache: function () { const c = spBox.__c || (spBox.__c = {});
      return { get: function (k) { return c[k] || null; }, put: function (k, v) { c[k] = v; }, remove: function (k) { delete c[k]; } }; } },
    Utilities: { sleep: function () {}, DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, formatDate: function () { return ''; },
      computeDigest: function (a, s) { return Array.from(crypto.createHash('sha256').update(s).digest()).map(function (b) { return b > 127 ? b - 256 : b; }); } },
    _hashPassword_: function () { return 'h'; }, _systemPin_: function () { return 'p'; },
    _findAccountByEmail_: function () { return null; },
    SESSION_SHEET: 'Sessions', _getSessionSheet_: function () {}, _readTabs_: function () { return { Sessions: SESSIONS }; },
    _logActivity_: function () { spLogs.push(1); }, _mailOptions_: function () { return {}; },
    GmailApp: { sendEmail: function () {} },
  });
  [1, 2, 3, 4, 5, 6].forEach(function () { outcome(function () { spBox.loginUser('ghost@x', 'nope', SATO); }); });
  check("  mutation: without the unknown-name check, a spray writes rows", spLogs.length === 1, spLogs.length + " rows");
}

// ---------------------------------------------------------------------------
console.log("\n8. finding 8: the dorm PDF escapes what staff typed");
{
  const body = codeFn('_buildRoomHtmlInner_');
  const a = body.indexOf('  const escTag = '), b = body.indexOf('  const formatRent');
  const helpers = a !== -1 && b > a ? body.slice(a, b) : '';
  check("replaceTag and its escaper were located", /const replaceTag = /.test(helpers), "");
  function fill(tpl, tag, value, src) {
    const ctx = sandbox(['var htmlString = ' + JSON.stringify(tpl) + ';', (src || helpers),
                         'replaceTag(' + JSON.stringify(tag) + ', ' + JSON.stringify(value) + ');'], {});
    return vm.runInContext('htmlString', ctx);
  }
  check("⚠️ markup in a 備考 is text, not markup",
    fill('<div>{{Remarks}}</div>', 'Remarks', '<img src=x onerror=alert(1)>') === '<div>&lt;img src=x onerror=alert(1)&gt;</div>', "");
  check("a quote cannot leave an attribute", fill('<i title="{{T}}">', 'T', 'a" onx="1') === '<i title="a&quot; onx=&quot;1">', "");
  check("newlines still become <br>, with the outer ones trimmed", fill('{{R}}', 'R', '\nline1\nline2\n') === 'line1<br>line2', "");
  check("⚠️ $& in a value is literal, not a replacement pattern", fill('[{{R}}]', 'R', 'pay $& now') === '[pay $&amp; now]', "");
  check("a data URI and display CSS pass byte-identical",
    fill('<img src="{{I}}">', 'I', 'data:image/png;base64,iVBOR+/=') === '<img src="data:image/png;base64,iVBOR+/=">' &&
    fill('style="{{D}}"', 'D', 'display: none;') === 'style="display: none;"', "");
  const raw = helpers.replace('safeValue = escTag(safeValue.replace(/^\\n+/, \'\').replace(/\\n+$/, \'\')).replace(/\\n/g, \'<br>\');',
                              'safeValue = safeValue.replace(/^\\n+/, \'\').replace(/\\n+$/, \'\').replace(/\\n/g, \'<br>\');');
  check("  mutation: without escTag, markup passes through", raw !== helpers &&
    fill('{{R}}', 'R', '<b>x</b>', raw) === '<b>x</b>', "");
}

// ---------------------------------------------------------------------------
console.log("\n9. item 10: a stored file's type is passed on only when it is a document or image");
{
  function served(type) {
    const ctx = sandbox([codeFn('getUploadedFile')], {
      UPLOADED_FILE_MAX_BYTES: 1e7,
      _permOrLegacyRole_: function () { return true; }, _hasPerm_: function () { return true; },
      _hearingSheetFileIds_: function () { return { 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012': true }; },
      _buildingDocFileIds_: function () { return {}; }, _generalDocFileIds_: function () { return {}; },
      DriveApp: { getFileById: function () { return { getName: function () { return 'f'; },
        getBlob: function () { return { getBytes: function () { return [1]; }, getContentType: function () { return type; } }; } }; } },
      Utilities: { base64Encode: function () { return 'AQ=='; } },
    });
    return ctx.getUploadedFile('', '', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012').mimeType;
  }
  check("PDF and images keep their type", served('application/pdf') === 'application/pdf' && served('image/jpeg') === 'image/jpeg', "");
  check("Office documents keep their type",
    served('application/vnd.openxmlformats-officedocument.wordprocessingml.document') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', "");
  check("⚠️ HTML is served as octet-stream", served('text/html') === 'application/octet-stream', "");
  check("⚠️ SVG (scriptable) is served as octet-stream", served('image/svg+xml') === 'application/octet-stream', "");
  check("a missing type is octet-stream", served('') === 'application/octet-stream', "");
}

// ---------------------------------------------------------------------------
console.log("\n10. common passwords are refused when a password is SET");
{
  // PW_COMMON_WORDS and PW_RUNS span several lines: take them whole, up to their closing "];".
  const multi = function (name) {
    const at = SRC.indexOf('\nconst ' + name + ' = [');
    return at === -1 ? '' : SRC.slice(at + 1, SRC.indexOf('];', at) + 2).replace('const ', 'var ');
  };
  function box(commonSrc) {
    return sandbox([codeConst('PW_MIN_LENGTH'), multi('PW_COMMON_WORDS'), multi('PW_RUNS'), codeConst('PW_DIGITS_MIN'),
                    codeFn('_passwordOwner_'), codeFn('_passwordProblem_'), commonSrc || codeFn('_commonPasswordProblem_')], {});
  }
  const b = box();
  const who = { id: 'S0123', name: '佐藤 花子', email: 'hanako.sato@example.com' };
  const refused = function (pw, c) { return (c || b)._passwordProblem_(pw, who) !== ''; };
  const COMMON = ['password', 'Password1', 'Password2026!', 'P@ssw0rd', 'p@ssw0rd123', 'passw0rd', 'qwerty123',
                  'Qwertyuiop', 'iloveyou!', 'Welcome2026', 'admin1234', '@dmin2026', 'letmein!!', 'honmachi1234',
                  'Sample2026', 'SampleSchool1', 'abcdefgh', 'hgfedcba', '1qaz2wsx', 'asdfghjkl', 'zxcvbnm123'];
  const bad = COMMON.filter(function (p) { return !refused(p); });
  check("⚠️ common words, however dressed, are refused", bad.length === 0, "accepted: " + bad.join(', '));
  check("⚠️ sequences, reversed runs and wrap-arounds are refused",
    ['12345678', '87654321', '78901234', 'abcdefghij'].every(function (p) { return refused(p); }), "");
  check("⚠️ repeats are refused", ['aaaaaaaa', '11111111', 'abababab', '12121212'].every(function (p) { return refused(p); }), "");
  check("⚠️ 8-digit numbers (a date) are refused, with the digits rule's own message",
    /10桁以上/.test(b._passwordProblem_('19900415', who)), b._passwordProblem_('19900415', who));
  check("...and 10 random digits pass", !refused('8204715693'), "");
  check("⚠️ the account's email name, ID or name is refused",
    refused('hanako.sato!9') && refused('xxS0123yy') && refused('佐藤花子2026x'), "");
  check("a short ID is NOT matched by coincidence (S01 in boss01)", !box()._passwordProblem_('boss01Kite', { id: 'S01' }), "");
  const GOOD = ['Tsukimi-Bridge-82', 'v9#Lq2!mRr', 'kitsune ramen 7', 'Hakone2Fuji!', 'correct horse battery'];
  const wrongly = GOOD.filter(function (p) { return refused(p); });
  check("ordinary strong passwords pass", wrongly.length === 0, "refused: " + wrongly.join(', '));
  check("the length and whitespace rules still come first",
    /8文字以上/.test(b._passwordProblem_('abc', who)) && /空白/.test(b._passwordProblem_(' Hakone2Fuji', who)), "");
  // Temporary passwords are random, but they are what an admin hands out: none may be refused.
  const crypto2 = require('crypto');
  const tmp = sandbox([codeConst('TEMP_PW_ALPHABET'), codeFn('_tempPassword_')],
                      { Utilities: { getUuid: function () { return crypto2.randomUUID(); } } });
  let tmpRefused = 0;
  for (let i = 0; i < 2000; i++) if (b._passwordProblem_(tmp._tempPassword_(), who) !== '') tmpRefused++;
  check("2,000 temporary passwords all pass the rule", tmpRefused === 0, tmpRefused + " refused");
  check("both setters pass the account's own details",
    (SRC.match(/_passwordProblem_\(newPassword, _passwordOwner_\(acct\)\)/g) || []).length === 2, "");
  // Mutations: each rule removed must let its case through.
  const noWords = mutate(codeFn('_commonPasswordProblem_'),
    'if (core !== "" && (PW_COMMON_WORDS.indexOf(core) !== -1 ||', 'if (false && (PW_COMMON_WORDS.indexOf(core) !== -1 ||');
  check("  mutation: without the word list, Password2026! passes", !refused('Password2026!', box(noWords)), "");
  const noDigits = mutate(codeFn('_commonPasswordProblem_'), 'if (/^\\d+$/.test(v) && v.length < PW_DIGITS_MIN) {', 'if (false) {');
  check("  mutation: without the digits rule, a date passes", !refused('19900415', box(noDigits)), "");
  const noLeet = mutate(codeFn('_commonPasswordProblem_'), '.replace(/0/g, "o")', '');
  check("  mutation: without undoing substitutions, passw0rd passes", !refused('passw0rd', box(noLeet)), "");
  const noCoreRun = mutate(codeFn('_commonPasswordProblem_'), '  if (core.length >= 5) {', '  if (false) {');
  check("  mutation: without the run check on the word, zxcvbnm123 passes", !refused('zxcvbnm123', box(noCoreRun)), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
