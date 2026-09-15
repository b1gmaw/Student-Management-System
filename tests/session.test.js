// Sessions: who is signed in, how one is ended, and what a dead one does to the screen.
//
// ⚠️ WHY. Three defects, found together on 2026-09-11:
//  1. 最終操作 showed a date in MAY for someone active on Sept 10. The server sorted sessions
//     newest-first and the client kept `m[key] = r` — the LAST row, i.e. the OLDEST session —
//     and expired sessions were listed as ログイン中 at all.
//  2. ログアウトさせる matched sessions by ID alone, so revoking 営業 5 signed out 教務 5 too.
//     The obvious fix — the literal (role, id) — is ALSO wrong: a session keeps the role it was
//     issued with, so a 営業 → 事務 move would leave that session untouched.
//  3. A revoked user was never signed out. Every call failed into alert(), and the page — data
//     included — stayed on screen until a reload.
//
// ⚠️ These run the REAL functions, extracted from Code.js / Index.html into a vm sandbox with
// the sheet stubbed, rather than a hand transcription: a transcription tests the copy, which is
// how cellsafe's `[\s -]` survived for months. Each guard is also run against its OLD shape
// (the mutations below) and must fail there — a check that passes both ways is worth nothing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const SHINSEI = fs.readFileSync(path.join(ROOT, 'Shinsei_Code.js'), 'utf8');
const JS = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || '';
const strip = function (s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); };
const JSNC = strip(JS);

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

// A top-level Code.js function ends at the first "\n}\n" — its body is indented.
function codeFn(name) {
  const i = SRC.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('Code.js: no function ' + name);
  return SRC.slice(i + 1, SRC.indexOf('\n}\n', i) + 2);
}
// A client function sits at 6 spaces and closes at the first "\n      }\n" (or on its own line).
function htmlFn(name) {
  const i = JS.indexOf('      function ' + name + '(');
  if (i < 0) throw new Error('Index.html: no function ' + name);
  const line = JS.slice(i, JS.indexOf('\n', i));
  if ((line.match(/\{/g) || []).length === (line.match(/\}/g) || []).length) return line.trim();
  return JS.slice(i, JS.indexOf('\n      }\n', i) + 8).trim();
}
function codeConst(name) {
  const m = SRC.match(new RegExp('^const ' + name + ' = [^\\n]*$', 'm'));
  if (!m) throw new Error('Code.js: no const ' + name);
  return m[0].replace(/^const /, 'var ');
}
// Replace exactly once, or the mutation silently tests the unmutated code.
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
function fmt(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
const DAY = 24 * 60 * 60 * 1000;
const ago = function (ms) { return fmt(new Date(Date.now() - ms)); };
const EXPIRY = [codeConst('SESSION_MAX_AGE_DAYS'), codeConst('SESSION_MAX_AGE_MS'),
                codeFn('_sessionAgeMs_'), codeFn('_sessionExpired_')];

// ---------------------------------------------------------------------------
console.log("\n1. 最終操作 — the server lists only live sessions, newest first");
{
  const GAS = codeFn('getActiveSessions');
  const rows = [
    ['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen'],
    ['tokA', 'sales', 'S01', '一郎', '', ago(1 * DAY)],
    ['tokB', 'jimu', 'S02', '二子', '', ago(2 * DAY)],
    ['tokC', 'sales', 'S01', '一郎', '', ago(120 * DAY)],   // the May session
    ['tokD', 'sales', 'S03', '三郎', '', ''],               // never touched: not expired
    ['',     'sales', 'S04', '空行', '', ago(DAY)],         // blank token: skipped
  ];
  function listed(src) {
    const ctx = sandbox(EXPIRY.concat([codeFn('_sessionSeenOf_'), src]), {
      SESSION_SHEET: 'Sessions',
      _isMasterRole_: function () { return true; }, _hasPerm_: function () { return true; },
      _readTabs_: function () { return { Sessions: rows }; },
    });
    return ctx.getActiveSessions('master', 'ALL');
  }
  const out = listed(GAS);
  check("⚠️ an EXPIRED session is not listed as ログイン中",
    !out.some(function (r) { return r.lastSeen === rows[3][5]; }),
    "resumeSession refuses it, so the badge would claim a session that cannot act");
  check("...but a never-touched one still is (blank LastSeen is not expired)",
    out.some(function (r) { return r.id === 'S03'; }), "");
  check("each row carries a numeric seenAt, 0 when blank",
    out.every(function (r) { return typeof r.seenAt === 'number'; }) &&
    out.filter(function (r) { return r.id === 'S03'; })[0].seenAt === 0, "");
  check("sorted by seenAt, newest first",
    out.map(function (r) { return r.id; }).join(',') === 'S01,S02,S03', out.map(function (r) { return r.id; }).join(','));
  check("the token is still never returned", out.every(function (r) { return !('token' in r); }), "");
  // Mutation: the filter removed — the May session comes back.
  let mutantListsExpired = false;
  try {
    mutantListsExpired = listed(mutate(GAS, 'if (_sessionExpired_(seen, now)) continue;', ''))
      .some(function (r) { return r.lastSeen === rows[3][5]; });
  } catch (e) { mutantListsExpired = 'threw: ' + e.message; }
  check("mutation: without the _sessionExpired_ filter the expired session IS listed", mutantListsExpired === true,
    String(mutantListsExpired));
  check("⚠️ a read path: getActiveSessions never deletes a row", !/deleteRow/.test(strip(GAS)),
    "expiry and the prune-on-login are the writers; a write from here runs for every admin who opens the list");
}

console.log("\n2. 最終操作 — the client keeps the NEWEST session per account");
{
  const LAS = htmlFn('loadActiveSessions');
  const KEY = htmlFn('_usersSessionKey');
  // The exact shape that produced "May": server order newest-first, the old session last.
  const serverOrder = [
    { role: 'sales', id: 'S01', lastSeen: '2026/09/10 16:03:11', seenAt: 3000 },
    { role: 'jimu',  id: 'S02', lastSeen: '2026/09/09 11:00:00', seenAt: 2000 },
    { role: 'sales', id: 'S01', lastSeen: '2026/05/14 09:12:40', seenAt: 1000 },
  ];
  function shown(src, rows) {
    const ctx = sandbox([KEY, src, 'var _usersSessions = {};'], {
      currentUser: { role: 'master', permissions: 'ALL' },
      renderUsersTable: function () {},
      apiRun: function () {
        const p = {
          withSuccessHandler: function (f) { p.ok = f; return p; },
          withFailureHandler: function (f) { return p; },
          getActiveSessions: function () { p.ok(rows); },
        };
        return p;
      },
    });
    ctx.loadActiveSessions();
    return ctx._usersSessions[ctx._usersSessionKey('sales', 'S01')];
  }
  const s = shown(LAS, serverOrder);
  check("⚠️ S01 shows 2026/09/10, not the May session", s && s.lastSeen === '2026/09/10 16:03:11', JSON.stringify(s));
  check("...and counts both sessions", s && s.count === 2, JSON.stringify(s));
  const r = shown(LAS, serverOrder.slice().reverse());
  check("the answer does not depend on the server's order", r && r.lastSeen === '2026/09/10 16:03:11' && r.count === 2,
    JSON.stringify(r));
  let old;
  try {
    old = shown(mutate(LAS, "const k = _usersSessionKey(r.role, r.id), cur = m[k];",
                       "m[_usersSessionKey(r.role, r.id)] = r; return; const k = 0, cur = 0;"), serverOrder);
  } catch (e) { old = { lastSeen: 'threw: ' + e.message }; }
  check("mutation: the old `m[key] = r` shows the MAY date — the reported bug",
    old && old.lastSeen === '2026/05/14 09:12:40', JSON.stringify(old));
  check("the badge says ×N when there is more than one session",
    /● ログイン中" \+ \(ses\.count > 1 \? " ×" \+ escHtmlJs\(String\(ses\.count\)\) : ""\)/.test(htmlFn('renderUsersTable')), "");
}

console.log("\n3. ログアウトさせる — by ACCOUNT, not by ID and not by literal role");
{
  const REV = codeFn('revokeUserSessions');
  const AK = codeFn('_sessionAccountKey_');
  // [token, role, id]. S05 exists in BOTH sheets; S01's first session carries a STALE role.
  const START = [
    ['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen'],
    ['t1', 'sales',   'S05', '営業五', '', ''],
    ['t2', 'teacher', 'S05', '教務五', '', ''],
    ['t3', 'sales',   'S01', '一郎', '', ''],   // issued as 営業, the account is now 事務
    ['t4', 'jimu',    'S01', '一郎', '', ''],
    ['t5', 'teacher', 'T01', '三郎', '', ''],
  ];
  function revoke(src, id, role) {
    const data = START.map(function (r) { return r.slice(); });
    const sheet = {
      getDataRange: function () { return { getDisplayValues: function () { return data.map(function (r) { return r.slice(); }); } }; },
      deleteRow: function (n) { data.splice(n - 1, 1); },   // shifts, like the real thing
    };
    const ctx = sandbox([AK, codeFn('_withSessionLock_'), src], {
      SESSION_SHEET: 'Sessions',
      LockService: { getScriptLock: function () { return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {} }; } },
      _isMasterRole_: function () { return true; }, _hasPerm_: function () { return true; },
      _getSessionSheet_: function () { return sheet; }, _forgetTab_: function () {}, _logActivity_: function () {},
    });
    const res = ctx.revokeUserSessions('master', 'ALL', id, 'actor', 'MASTER', role);
    return { left: data.slice(1).map(function (r) { return r[0]; }).join(','), revoked: res.revoked };
  }
  const a = revoke(REV, 'S05', 'sales');
  check("⚠️ revoking 営業 S05 leaves 教務 S05 signed in", a.left === 't2,t3,t4,t5', a.left);
  const b = revoke(REV, 'S05', 'teacher');
  check("...and revoking 教務 S05 leaves 営業 S05", b.left === 't1,t3,t4,t5', b.left);
  const c = revoke(REV, 'S01', 'jimu');
  check("⚠️ a session with a STALE role is still revoked (営業 → 事務 move)", c.left === 't1,t2,t5' && c.revoked === 2,
    c.left + " / " + c.revoked);
  let threw = '';
  try { revoke(REV, 'S05', ''); } catch (e) { threw = e.message; }
  check("⚠️ a page that sends no role (loaded before this) is REFUSED, not matched by ID",
    /画面が古くなっています/.test(threw), threw);
  threw = '';
  try { revoke(REV, 'MASTER', 'master'); } catch (e) { threw = e.message; }
  check("MASTER still cannot be revoked", /マスターアカウントは無効化できません/.test(threw), threw);

  const idOnly = revoke(mutate(REV, "if (_sessionAccountKey_(data[i][1], data[i][2]) !== want) continue;",
                                     "if (String(data[i][2] || \"\").trim() !== uid) continue;"), 'S05', 'sales');
  check("mutation: ID-only matching signs out 教務 S05 too — the reported bug", idOnly.left !== a.left, idOnly.left);
  const literal = revoke(mutate(REV, "if (_sessionAccountKey_(data[i][1], data[i][2]) !== want) continue;",
                                      "if (String(data[i][1]) + '|' + String(data[i][2]).trim() !== userRole + '|' + uid) continue;"), 'S01', 'jimu');
  check("mutation: literal (role, id) matching MISSES the stale-role session", literal.left !== c.left, literal.left);

  // The client key must agree with the server's for every role shape.
  const ctx = sandbox([AK, htmlFn('_usersSessionKey')]);
  const roles = ['teacher', 'sales', 'jimu', 'admin', 'master', '', 'kyomubu'];
  const ids = ['S01', ' S01 ', 'T01'];
  const agree = roles.every(function (r) { return ids.every(function (i) {
    return ctx._sessionAccountKey_(r, i) === ctx._usersSessionKey(r, i); }); });
  check("⚠️ the client key and the server key are the SAME function of (role, id)", agree,
    "two copies of one decision: the badge would show one account while revoke ends another");
  check("...teacher is its own account, every other role is one staff account",
    ctx._usersSessionKey('sales', 'S01') === ctx._usersSessionKey('jimu', 'S01') &&
    ctx._usersSessionKey('teacher', 'S01') !== ctx._usersSessionKey('sales', 'S01'), "");
  check("the client sends the target's role", /currentUser\.name, currentUser\.id, u\.role\);/.test(htmlFn('revokeUser')), "");
}

console.log("\n4. a dead session has ONE name, and nothing else wears it");
{
  const dead = [];
  strip(SRC).replace(/_sessionDeadError_\("([^"]*)"\)/g, function (_, m) { dead.push(m); return _; });
  check("the session-death throws all go through _sessionDeadError_", dead.length >= 6, dead.length + " found");
  const ctx = sandbox([htmlFn('_isSessionDead')]);
  check("_isSessionDead recognises every one — as an Error, a prefixed message, or a string",
    dead.every(function (m) {
      return ctx._isSessionDead(new Error(m)) && ctx._isSessionDead({ message: 'Exception: ' + m }) && ctx._isSessionDead(m);
    }), dead.join(' | '));
  // ⚠️ The other direction: an ordinary error must never sign anyone out.
  const others = [];
  [strip(SRC), strip(SHINSEI)].forEach(function (s) {
    s.replace(/new Error\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, function (_, q, m) { others.push(m); return _; });
  });
  const falsePos = others.filter(function (m) { return ctx._isSessionDead(new Error(m)); });
  check("⚠️ NO other thrown message is mistaken for a dead session", others.length > 100 && falsePos.length === 0,
    others.length + " scanned; would sign out on: " + falsePos.join(' | '));
  check("...and an ordinary error, a null and undefined are not dead",
    !ctx._isSessionDead(new Error('権限がありません')) && !ctx._isSessionDead(null) && !ctx._isSessionDead(undefined), "");
  const L = strip(codeFn('_sessionLookup_'));
  check("no bare `new Error` is left inside _sessionLookup_", !/new Error\(/.test(L), "");
  check("resumeSession is the touching wrapper", /function resumeSession\(token\) \{\s*return _sessionLookup_\(token, true\);\s*\}/.test(SRC), "");
  check("the dead error carries the flag checkSession reads",
    /e\.sessionDead = true;/.test(codeFn('_sessionDeadError_')), "");
}

console.log("\n5. apiRun — a dead session signs out, and the caller's handler is NOT called");
{
  const API = htmlFn('apiRun');
  function run(src, outcome, withFail) {
    const log = { forced: 0, ok: 0, fail: 0, consoleErr: 0 };
    let handlers = {};
    const gsr = new Proxy({}, { get: function (t, p) {
      if (p === 'withSuccessHandler') return function (f) { handlers.ok = f; return gsr; };
      if (p === 'withFailureHandler') return function (f) { handlers.fail = f; return gsr; };
      return function () {};
    } });
    const ctx = sandbox([src, 'var _sessionProvedAt = 0;'], {
      Proxy: Proxy,
      localStorage: { getItem: function () { return 'TOKEN'; } },
      google: { script: { run: gsr } },
      _isSessionDead: function (e) { return /再度ログインしてください/.test(String(e && e.message)); },
      _forceLogout: function () { log.forced++; },
      console: { error: function () { log.consoleErr++; } },
    });
    let b = ctx.apiRun().withSuccessHandler(function () { log.ok++; });
    if (withFail) b = b.withFailureHandler(function () { log.fail++; });
    b.getSomething(1);
    if (outcome === 'ok') handlers.ok && handlers.ok('v');
    else handlers.fail && handlers.fail(new Error(outcome));
    log.proved = ctx._sessionProvedAt;
    return log;
  }
  const d = run(API, 'セッションが無効です。再度ログインしてください。', true);
  check("⚠️ a dead session calls _forceLogout, and NOT the caller's failure handler", d.forced === 1 && d.fail === 0,
    JSON.stringify(d));
  const o = run(API, '権限がありません', true);
  check("an ordinary error reaches the caller's handler as before", o.forced === 0 && o.fail === 1, JSON.stringify(o));
  const n = run(API, '権限がありません', false);
  check("with no failure handler an ordinary error is logged, not thrown", n.consoleErr === 1 && n.forced === 0, JSON.stringify(n));
  const s = run(API, 'ok', true);
  check("a success reaches the caller and records the proof the idle check reads", s.ok === 1 && s.proved > 0, JSON.stringify(s));
  const old = run(mutate(API, "if (_isSessionDead(err)) { _forceLogout(); return; }", ""), 'セッションが無効です。再度ログインしてください。', true);
  check("mutation: without the check a dead session reaches the caller's alert() — the reported behaviour",
    old.forced === 0 && old.fail === 1, JSON.stringify(old));
  ['_umIssueTempPassword'].forEach(function (f) {
    check(f + " (a direct call, not apiRun) asks the same question",
      /if \(_isSessionDead\(e\)\) \{ _forceLogout\(\); return; \}/.test(htmlFn(f)), "");
  });
  check("changeOwnPassword's handler (a direct call) asks the same question",
    /if \(_isSessionDead\(e\)\) \{ _forceLogout\(\); return; \}[\s\S]{0,400}\.changeOwnPassword\(token, cur, nw\)/.test(JS), "");
}

console.log("\n6. ONE teardown, two ways in");
{
  const FL = htmlFn('_forceLogout');
  let torn = 0;
  const pinErr = { innerText: '', style: { display: 'none' } };
  const ctx = sandbox([FL, 'var currentUser = { id: "S01" };'], {
    _teardownSession: function () { torn++; ctx.currentUser = null; },
    document: { getElementById: function (id) { return id === 'pinError' ? pinErr : null; } },
  });
  ctx._forceLogout(); ctx._forceLogout(); ctx._forceLogout();
  check("⚠️ _forceLogout is idempotent — three failing loads tear down once", torn === 1, "torn " + torn);
  check("...and the login screen says why", pinErr.style.display === 'block' && /ログアウトされました/.test(pinErr.innerText), pinErr.innerText);
  const LO = strip(htmlFn('logoutUser')), TD = strip(htmlFn('_teardownSession')), FLN = strip(FL);
  check("logoutUser asks, tears down, and revokes the token", /confirm\(/.test(LO) && /_teardownSession\(\);/.test(LO) && /\.logoutSession\(token\)/.test(LO), "");
  check("_forceLogout does not ask and does not call logoutSession (the token is already dead)",
    /_teardownSession\(\);/.test(FLN) && !/confirm\(/.test(FLN) && !/logoutSession/.test(FLN), "");
  check("⚠️ the teardown exists ONCE — one function hides the sidebar on sign-out",
    (JSNC.match(/if \(sb\) sb\.style\.display = 'none';/g) || []).length === 1 && /if \(sb\) sb\.style\.display = 'none';/.test(TD),
    "a second copy drifts on the next piece of per-user state");
  check("the teardown clears the user, the token and the idle timer",
    /currentUser = null;/.test(TD) && /removeItem\('sms_session'\)/.test(TD) && /_sessionCheckStop\(\);/.test(TD), "");
}

// ---------------------------------------------------------------------------
// A fake Sessions sheet that behaves like the real one where it matters: a leading apostrophe
// is a text marker (not part of the value), getLastRow ignores blank tail rows, a Date cell
// DISPLAYS month-first (production's locale), and createTextFinder finds a token's CURRENT row.
function usDisplay(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear() + ' ' + d.getHours() + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function fakeSessions(rows) {
  const data = rows.map(function (r) { return r.slice(); });
  const bare = function (v) { return typeof v === 'string' ? v.replace(/^'/, '') : v; };
  const lastRow = function () { let n = data.length; while (n > 1 && String(data[n - 1][0] == null ? '' : data[n - 1][0]) === '') n--; return n; };
  const sh = {
    data: data, writes: 0,
    getLastRow: lastRow,
    getDataRange: function () { return {
      getDisplayValues: function () { return data.slice(0, lastRow()).map(function (r) { return r.map(function (v) { return v instanceof Date ? usDisplay(v) : String(v == null ? '' : bare(v)); }); }); },
      getValues: function () { return data.slice(0, lastRow()).map(function (r) { return r.map(bare); }); } }; },
    getRange: function (r, c, nr, nc) { nr = nr || 1; nc = nc || 1; return {
      getValues: function () { return data.slice(r - 1, r - 1 + nr).map(function (row) { return row.slice(c - 1, c - 1 + nc).map(bare); }); },
      setValues: function (vals) { vals.forEach(function (v, k) { for (let j = 0; j < v.length; j++) data[r - 1 + k][c - 1 + j] = v[j]; }); sh.writes++; },
      setValue: function (v) { data[r - 1][c - 1] = v; sh.writes++; },
      clearContent: function () { for (let k = 0; k < nr; k++) for (let j = 0; j < nc; j++) if (data[r - 1 + k]) data[r - 1 + k][c - 1 + j] = ''; },
      createTextFinder: function (t) { return { matchEntireCell: function () { return { findNext: function () {
        for (let k = 0; k < nr; k++) { const row = data[r - 1 + k]; if (row && String(bare(row[c - 1])) === t) return { getRow: function () { return r + k; } }; }
        return null; } }; } }; } }; },
    deleteRow: function (n) { data.splice(n - 1, 1); },
    appendRow: function (row) { const n = lastRow(); if (n < data.length) data[n] = row.slice(); else data.push(row.slice()); },
  };
  return sh;
}
const SESS_FNS = ['_sessionStamp_', '_sessionSeenOf_', '_compactSessions_', '_withSessionLock_', '_sessionRowOf_',
                  '_deleteSessionByToken_', '_touchSessionByToken_', '_sessionAccountKey_', '_cellSafe_', '_cellSafeRow_'];
function sessEnv(sh, extra) {
  const lf = function (d) { const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
  return Object.assign({
    SESSION_SHEET: 'Sessions',
    LockService: { getScriptLock: function () { return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {} }; } },
    Utilities: { formatDate: function (d) { return lf(d); } },
    _getSessionSheet_: function () { return sh; }, _forgetTab_: function () {},
  }, extra || {});
}
function sessCode(overrides) {
  return EXPIRY.concat([codeConst('SESSION_MAX_PER_ACCOUNT'), codeConst('SESSION_COLS')]).concat(SESS_FNS.map(function (n) { return (overrides && overrides[n]) || codeFn(n); }));
}

console.log("\n7. the idle check — never touches LastSeen, fails open, asks only from a visible idle tab");
{
  // --- server: _sessionLookup_(touch) and checkSession, run for real ---
  const LK = codeFn('_sessionLookup_'), CS = codeFn('checkSession'), DE = codeFn('_sessionDeadError_');
  function lookup(src, token, touch, lastSeen, userGone) {
    const w = { touchAsked: 0, writes: 0 };
    const sh = fakeSessions([['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen'], ['TOK', 'sales', 'S01', 'n', '', lastSeen]]);
    const ctx = sandbox(sessCode().concat([DE, src, 'var _authUser = null;']), sessEnv(sh, {
      _readTabs_: function () { return { Sessions: sh.getDataRange().getDisplayValues() }; },
      _resolveUserById_: function () { return userGone ? null : { id: 'S01' }; },
      _shouldTouchSession_: function () { w.touchAsked++; return true; },
    }));
    try { ctx._sessionLookup_(token, touch); w.ok = true; } catch (e) { w.dead = e.sessionDead === true; w.msg = e.message; }
    w.writes = sh.writes;
    return w;
  }
  const nt = lookup(LK, 'TOK', false, ago(DAY));
  check("⚠️ touch=false writes NOTHING and never asks the throttle", nt.ok && nt.writes === 0 && nt.touchAsked === 0, JSON.stringify(nt));
  const t = lookup(LK, 'TOK', true, ago(DAY));
  check("touch=true (resumeSession) still writes LastSeen", t.ok && t.writes === 1 && t.touchAsked === 1, JSON.stringify(t));
  const mt = lookup(mutate(LK, 'if (touch && _shouldTouchSession_(token)) {', 'if (_shouldTouchSession_(token)) {'), 'TOK', false, ago(DAY));
  check("mutation: without the touch flag the idle check writes LastSeen — the 30-day expiry would never fire",
    mt.writes === 1, JSON.stringify(mt));
  [['an expired session', lookup(LK, 'TOK', false, ago(40 * DAY))],
   ['an unknown token', lookup(LK, 'NOPE', false, ago(DAY))],
   ['a deleted user', lookup(LK, 'TOK', false, ago(DAY), true)],
   ['an empty token', lookup(LK, '', false, ago(DAY))]].forEach(function (p) {
    check(p[0] + " is DEAD, and flagged", p[1].dead === true && /再度ログインしてください/.test(p[1].msg), JSON.stringify(p[1]));
  });

  function checked(behaviour) {
    const ctx = sandbox([CS, 'var _authUser = "parked";'], {
      _sessionLookup_: function () {
        if (behaviour === 'dead') { const e = new Error('x'); e.sessionDead = true; throw e; }
        if (behaviour === 'sheets') throw new Error('Service Spreadsheets timed out');
        ctx._authUser = { id: 'S01' };
        return { id: 'S01' };
      },
    });
    const r = ctx.checkSession('TOK');
    return { alive: r && r.alive, keys: Object.keys(r || {}).join(','), parked: ctx._authUser };
  }
  const live = checked('live'), dd = checked('dead'), sh = checked('sheets');
  check("checkSession: a live session is alive", live.alive === true, JSON.stringify(live));
  check("checkSession: a dead one is not", dd.alive === false, JSON.stringify(dd));
  check("⚠️ checkSession FAILS OPEN — a Sheets error answers alive", sh.alive === true,
    "one hiccup would otherwise sign out every open tab at once");
  check("...answers nothing but the boolean, and never leaves a session parked",
    [live, dd, sh].every(function (x) { return x.keys === 'alive' && x.parked === null; }), JSON.stringify([live, dd, sh]));
  check("⚠️ checkSession is OFF the apiCall registry (apiCall resumes, and resuming touches)",
    !/checkSession: checkSession/.test(SRC.slice(SRC.indexOf('function _apiMethods_('))), "");

  // --- client: _sessionCheck, run for real ---
  const SC = htmlFn('_sessionCheck');
  function tick(opts, src) {
    const log = { calls: 0, forced: 0 };
    const gsr = { withSuccessHandler: function (f) { gsr.ok = f; return gsr; }, withFailureHandler: function (f) { gsr.fail = f; return gsr; },
                  checkSession: function () { log.calls++; if (opts.answer === 'net') gsr.fail(new Error('net')); else gsr.ok({ alive: opts.answer !== 'dead' }); } };
    const ctx = sandbox([src || SC, 'var SESSION_PROOF_MS = 60000; var _sessionProvedAt = ' + (Date.now() - (opts.provedAgo || 0)) + ';'], {
      currentUser: opts.user === false ? null : { id: 'S01' },
      document: { visibilityState: opts.hidden ? 'hidden' : 'visible' },
      localStorage: { getItem: function () { return 'TOK'; } },
      google: { script: { run: gsr } },
      _forceLogout: function () { log.forced++; },
    });
    ctx._sessionCheck();
    return log;
  }
  check("a HIDDEN tab asks nothing", tick({ hidden: true, provedAgo: 5 * 60000 }).calls === 0, "");
  check("a tab proved alive within the minute asks nothing (anyone working sends none)", tick({ provedAgo: 10000 }).calls === 0, "");
  check("nobody signed in asks nothing", tick({ user: false, provedAgo: 5 * 60000 }).calls === 0, "");
  const ask = tick({ provedAgo: 5 * 60000, answer: 'dead' });
  check("⚠️ an idle visible tab asks, and a dead answer signs out", ask.calls === 1 && ask.forced === 1, JSON.stringify(ask));
  check("an alive answer does nothing", tick({ provedAgo: 5 * 60000, answer: 'alive' }).forced === 0, "");
  check("a network failure is not a verdict", tick({ provedAgo: 5 * 60000, answer: 'net' }).forced === 0, "");
  const noVis = tick({ hidden: true, provedAgo: 5 * 60000 },
    mutate(SC, "if (document.visibilityState && document.visibilityState !== 'visible') return;", ''));
  check("mutation: without the visibility guard a hidden tab polls", noVis.calls === 1, JSON.stringify(noVis));

  // One timer, however many times the app comes up.
  const timers = new Set(); let seq = 0;
  const tctx = sandbox([htmlFn('_sessionCheckStart'), htmlFn('_sessionCheckStop'), 'var SESSION_CHECK_MS = 120000; var _sessionTimer = null, _sessionProvedAt = 0;'], {
    setInterval: function () { const id = ++seq; timers.add(id); return id; },
    clearInterval: function (id) { timers.delete(id); },
    _sessionCheck: function () {},
  });
  tctx._sessionCheckStart(); tctx._sessionCheckStart(); tctx._sessionCheckStart();
  check("starting three times leaves ONE interval", timers.size === 1, "active " + timers.size);
  tctx._sessionCheckStop();
  check("...and stopping leaves none", timers.size === 0, "active " + timers.size);
  check("setupInterfaceBasedOnRole starts it", /boot = boot \|\| \{\};\s*_sessionCheckStart\(\);/.test(htmlFn('setupInterfaceBasedOnRole')), "");
  check("returning to the tab asks at once — visibilitychange and focus",
    /addEventListener\('visibilitychange'[\s\S]{0,120}_sessionCheck\(\)/.test(JSNC) && /window\.addEventListener\('focus', _sessionCheck\)/.test(JSNC), "");
  // ⚠️ Rule 3: setupInterfaceBasedOnRole can run during script execution (the top-level
  // tryResumeSession → settled(window._boot)), so the timer state must be declared above it.
  const top = JS.indexOf('\n        tryResumeSession();');
  check("⚠️ the timer state is declared ABOVE the top-level tryResumeSession() (TDZ)",
    top > 0 && JS.indexOf('const SESSION_CHECK_MS') > 0 && JS.indexOf('const SESSION_CHECK_MS') < top &&
    JS.indexOf('let _sessionTimer') < top, "declared below it, the setup throws and the app stays blank");
  check("the revoke confirm says what will happen now",
    /約2分以内（または次の操作で）ログイン画面に戻ります/.test(htmlFn('revokeUser')), "");
}

console.log("\n8. ROOT CAUSE: production's month-first dates — and the one-pass fix");
{
  const now = Date.now();
  const ctx = sandbox(EXPIRY);
  check("⚠️ the parser cannot read production's format — so nothing ever expired",
    ctx._sessionAgeMs_('9/11/2026 10:42:07', now) === -1, "if this ever parses, the diagnosis changed");
  check("...and reads the stamp format this fix writes", ctx._sessionAgeMs_('2026-09-11 10:42:07', now) !== -1, "");

  // One account with 11 sessions (the ×11), one with 2, and an old session with NO LastSeen.
  const d = function (days) { return new Date(now - days * DAY); };
  const rows = [['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen']];
  for (let k = 0; k < 11; k++) rows.push(['s' + k, 'sales', 'S01', '甲野', d(20 - k), d(10 - k * 0.5)]);
  rows.push(['t0', 'teacher', 'T01', '三郎', d(3), d(1)]);
  rows.push(['t1', 'teacher', 'T01', '三郎', d(4), d(2)]);
  rows.push(['old', 'sales', 'S02', '=HYPERLINK("x")', d(90), '']);     // blank LastSeen, 90 days old
  rows.push(['exp', 'sales', 'S03', '乙山', d(60), d(45)]);              // idle 45 days
  function compacted(overrides) {
    const sh = fakeSessions(rows);
    const c = sandbox(sessCode(overrides), sessEnv(sh));
    const res = c._compactSessions_(sh, now);
    return { sh: sh, res: res, tokens: sh.getDataRange().getValues().slice(1).map(function (r) { return r[0]; }) };
  }
  const out = compacted();
  const s01 = out.tokens.filter(function (t) { return /^s/.test(t); });
  check("⚠️ the ×11 account keeps its NEWEST 3 — s8, s9, s10", s01.join(',') === 's8,s9,s10', s01.join(','));
  check("another account's sessions are untouched by that cap", out.tokens.indexOf('t0') !== -1 && out.tokens.indexOf('t1') !== -1, out.tokens.join(','));
  check("⚠️ a blank-LastSeen session ages by Created, and 90 days is expired", out.tokens.indexOf('old') === -1, out.tokens.join(','));
  check("an idle-45-days session is expired", out.tokens.indexOf('exp') === -1, "");
  const e = out.sh.data[1][4], f = out.sh.data[1][5];
  check("⚠️ every Date is rewritten as TEXT in the fixed format",
    /^'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(e) && /^'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(f), e + ' | ' + f);
  check("...and the tail is cleared, not left as live rows", out.sh.getLastRow() === 1 + 5, String(out.sh.getLastRow()));
  check("creation order is kept", out.tokens.join(',') === 's8,s9,s10,t0,t1', out.tokens.join(','));
  // Now the listing reads what compaction wrote — and picks the newest.
  const listed = sandbox(EXPIRY.concat([codeFn('_sessionSeenOf_'), codeFn('getActiveSessions')]), {
    SESSION_SHEET: 'Sessions', _isMasterRole_: function () { return true; }, _hasPerm_: function () { return true; },
    _readTabs_: function () { return { Sessions: out.sh.getDataRange().getDisplayValues() }; },
  }).getActiveSessions('master', 'ALL');
  const first = listed.filter(function (r) { return r.id === 'S01'; })[0];
  check("⚠️ after compaction the listing is newest-first, with real seenAt numbers",
    listed[0].seenAt > 0 && first && first.seenAt === Math.max.apply(null, listed.filter(function (r) { return r.id === 'S01'; }).map(function (r) { return r.seenAt; })), JSON.stringify(listed.slice(0, 2)));

  // Mutations.
  const noCap = compacted({ _compactSessions_: mutate(codeFn('_compactSessions_'), 'if (n < SESSION_MAX_PER_ACCOUNT) keep[x.i] = true; else dropped++;', 'keep[x.i] = true;') });
  check("  mutation: without the cap the ×11 survives", noCap.tokens.filter(function (t) { return /^s/.test(t); }).length === 11, "");
  const noNorm = compacted({ _compactSessions_: mutate(codeFn('_compactSessions_'), "if (Object.prototype.toString.call(r[c]) === '[object Date]') { normalised++; return _sessionStamp_(r[c]).slice(1); }", '') });
  check("  mutation: without normalising, the Date never parses and nothing expires",
    noNorm.tokens.indexOf('exp') !== -1, noNorm.tokens.join(','));
  check("a name starting with = is written back as text (_cellSafeRow_)",
    (function () {
      const sh = fakeSessions([['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen'], ['x', 'sales', 'S9', '=1+1', new Date(now), new Date(now)]]);
      sandbox(sessCode(), sessEnv(sh))._compactSessions_(sh, now);
      return sh.data[1][3] === "'=1+1";
    })(), "");
  check("⚠️ compaction writes nothing when nothing changed", (function () {
    const sh = fakeSessions([['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen'], ['x', 'sales', 'S9', 'a', "'2026-09-11 10:00:00", "'" + (function () { const t = new Date(now - DAY); const p = function (n) { return String(n).padStart(2, '0'); }; return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' 10:00:00'; })()]]);
    sandbox(sessCode(), sessEnv(sh))._compactSessions_(sh, now);
    return sh.writes === 0;
  })(), "a login that changes nothing must not rewrite the sheet");
}

console.log("\n9. the LastSeen write and the deletes hit the row the TOKEN is on now");
{
  const now = Date.now();
  const base = [['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen'],
    ['A', 'sales', 'S01', 'a', "'2026-09-01 09:00:00", "'2026-09-01 09:00:00"],
    ['B', 'sales', 'S02', 'b', "'2026-09-01 09:00:00", "'2026-09-01 09:00:00"],
    ['C', 'sales', 'S03', 'c', "'2026-09-01 09:00:00", "'2026-09-01 09:00:00"]];
  const sh = fakeSessions(base);
  const c = sandbox(sessCode(), sessEnv(sh));
  // B was read at row 3; another request deletes A (row 2) before the touch lands.
  sh.deleteRow(2);
  c._touchSessionByToken_('B');
  const byTok = {}; sh.data.slice(1).forEach(function (r) { byTok[r[0]] = r[5]; });
  check("⚠️ after a delete above it, the touch still updates B — and not C",
    byTok.B !== "'2026-09-01 09:00:00" && byTok.C === "'2026-09-01 09:00:00", JSON.stringify(byTok));
  // The old shape: write to the row number remembered from the read (3) — now C's row.
  const sh2 = fakeSessions(base); sh2.deleteRow(2); sh2.getRange(3, 6).setValue('NOW');
  check("  the old index write lands on C — the reported 最終操作 bug", sh2.data[2][0] === 'C' && sh2.data[2][5] === 'NOW', "");
  const sh3 = fakeSessions(base);
  const c3 = sandbox(sessCode(), sessEnv(sh3));
  sh3.deleteRow(2);                                   // A goes; B moves up
  c3._deleteSessionByToken_('C');
  check("⚠️ a delete by token removes C, whatever row it moved to",
    sh3.data.slice(1).map(function (r) { return r[0]; }).join(',') === 'B', sh3.data.map(function (r) { return r[0]; }).join(','));
  check("no remembered-row write is left in the lookup",
    !/getRange\(i \+ 1, 6\)|deleteRow\(i \+ 1\)/.test(codeFn('_sessionLookup_')), "");
  // Every mutation of the Sessions sheet runs under the lock.
  ['_issueSessionToken_', 'logoutSession', 'revokeUserSessions', '_deleteSessionByToken_', '_touchSessionByToken_', '_compactSessionsLocked_'].forEach(function (fn) {
    check(fn + " mutates under _withSessionLock_", /_withSessionLock_\(/.test(codeFn(fn)), "");
  });
  check("the touch never QUEUES behind the lock (tryLock, skipped when busy)",
    /_withSessionLock_\(2000, function \(\) \{[\s\S]*\}, true\);/.test(codeFn('_touchSessionByToken_')), "");
  const calls = (SRC.match(/_compactSessions_\(/g) || []).length - 1;   // minus the definition
  check("_compactSessions_ is only called from inside the lock (login + the scheduled pass)", calls === 2 &&
    /_withSessionLock_\(10000, function \(\) \{\s*sh\.appendRow\([\s\S]{0,200}\);\s*_compactSessions_\(sh, Date\.now\(\)\);/.test(codeFn('_issueSessionToken_')) &&
    /_withSessionLock_\(30000, function \(\) \{ return _compactSessions_\(_getSessionSheet_\(\), Date\.now\(\)\); \}\)/.test(codeFn('_compactSessionsLocked_')), String(calls));
  check("the scheduled backup runs the session pass", /rep\.sessions = _compactSessionsLocked_\(\)/.test(codeFn('triggerScheduledBackup')), "");
  check("the cap is 3", /^const SESSION_MAX_PER_ACCOUNT = 3;/m.test(SRC), "");
}

console.log("\n10. each session's device (G/H) stays on ITS row");
{
  // ⚠️ WHY. Columns G Device / H DeviceId arrived 2026-09-15. _compactSessions_ moves rows up when it
  // drops one, and it used to rewrite only 6 columns: G/H stayed where they were and a device label
  // ended up on a DIFFERENT session. Reads are as wide as the header row, so an older sheet's
  // missing headers would hide G/H from getMyAccount entirely.
  const now = Date.now();
  const d = function (days) { return new Date(now - days * DAY); };
  const H8 = ['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen', 'Device', 'DeviceId'];
  const ROWS = function () {
    return [H8,
      ['a', 'sales', 'S01', '甲野', d(3), d(1), 'Windows · Edge', 'aaaa1111-0000'],
      ['x', 'sales', 'S02', '乙山', d(60), d(45), 'iPhone · Safari', 'xxxx2222-0000'],   // expired, in the middle
      ['b', 'teacher', 'T01', '三郎', d(2), d(1), 'Android · Chrome', 'bbbb3333-0000']];
  };
  const DEV_FNS = [codeFn('_sessionDevice_'), codeFn('_ensureSessionDeviceHeaders_')];
  const run = function (compactSrc) {
    const sh = fakeSessions(ROWS());
    sandbox(sessCode(compactSrc ? { _compactSessions_: compactSrc } : null), sessEnv(sh))._compactSessions_(sh, now);
    return sh.data;
  };
  const rowsAfter = run();
  check("the expired middle row is dropped", rowsAfter[1][0] === 'a' && rowsAfter[2][0] === 'b', JSON.stringify(rowsAfter.map(function (r) { return r[0]; })));
  check("⚠️ the moved-up session keeps ITS device and id",
    rowsAfter[2][6] === 'Android · Chrome' && rowsAfter[2][7] === 'bbbb3333-0000', JSON.stringify(rowsAfter[2]));
  check("...and the freed tail row is cleared across all 8 columns",
    !rowsAfter[3] || (rowsAfter[3][0] === '' && rowsAfter[3][6] === '' && rowsAfter[3][7] === ''), JSON.stringify(rowsAfter[3]));

  // Mutation: the old 6-column rewrite.
  const six = codeFn('_compactSessions_').split('SESSION_COLS').join('6')
    .replace(/\n\s*\.concat\(_cellSafeRow_\(\[String\(x\.r\[6\][\s\S]*?\]\)\);/, ';');
  check("  (the mutation really is the old shape)", six !== codeFn('_compactSessions_') && six.indexOf('x.r[6]') === -1, "");
  const old = run(six);
  check("  mutation: rewriting 6 columns puts the dropped row's device on the moved-up session",
    old[2][0] === 'b' && old[2][6] === 'iPhone · Safari', JSON.stringify(old[2]));

  // Headers on an older six-column sheet.
  const legacy = fakeSessions([['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen']]);
  const hc = sandbox(DEV_FNS, {});
  hc._ensureSessionDeviceHeaders_(legacy);
  const w1 = legacy.writes;
  hc._ensureSessionDeviceHeaders_(legacy);
  check("an older sheet gains the Device / DeviceId headers", legacy.data[0][6] === 'Device' && legacy.data[0][7] === 'DeviceId', JSON.stringify(legacy.data[0]));
  check("...and a second call writes nothing", w1 === 1 && legacy.writes === 1, w1 + " then " + legacy.writes);

  // What the browser sends is cleaned. The bell character is built, never typed, so no raw control
  // byte lands in this file (cellsafe.test §7).
  const BEL = String.fromCharCode(7);
  const dv = sandbox(DEV_FNS, {});
  const good = dv._sessionDevice_({ label: '  Windows ' + BEL + '·\n Edge  ', id: '3f9a2c1b-7d4e-4a1b-9c2d-0e8f6a5b4c3d' });
  check("a label loses control characters and extra spaces", good.label === 'Windows · Edge', JSON.stringify(good.label));
  check("a UUID id is kept", good.id === '3f9a2c1b-7d4e-4a1b-9c2d-0e8f6a5b4c3d', good.id);
  check("a long label is cut to 60", dv._sessionDevice_({ label: 'x'.repeat(500) }).label.length === 60, "");
  check("an id that is not 8–64 letters, digits or dashes is dropped",
    ['abc', 'x'.repeat(65), '<script>alert(1)</script>', '=1+1', '../../etc'].every(function (bad) { return dv._sessionDevice_({ id: bad }).id === ''; }), "");
  check("nothing sent (an older page) gives blanks", JSON.stringify(dv._sessionDevice_(undefined)) === '{"label":"","id":""}', "");
  const loose = sandbox([mutate(codeFn('_sessionDevice_'), '/^[A-Za-z0-9-]{8,64}$/.test(id) ? id : ""', 'id'), codeFn('_ensureSessionDeviceHeaders_')], {});
  check("  mutation: without the id pattern a script tag is stored", loose._sessionDevice_({ id: '<script>alert(1)</script>' }).id !== '', "");

  // The login writes it: G/H in place, formula-safe, headers ensured.
  const sh = fakeSessions([['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen']]);
  let uuid = 0;
  const env = sessEnv(sh);
  env.Utilities = Object.assign({}, env.Utilities, { getUuid: function () { uuid++; return 'uuid-' + uuid + '-0000-0000'; } });
  const lc = sandbox(sessCode().concat(DEV_FNS).concat([codeFn('_issueSessionToken_')]), env);
  const tok = lc._issueSessionToken_({ role: 'sales', id: 'S01', name: '甲野' }, { label: '=HYPERLINK("x")', id: 'dev-0001-abcd' });
  const row = sh.data.filter(function (r) { return r[0] === tok; })[0] || [];
  check("the login's row carries the device in G and the id in H", String(row[7]) === 'dev-0001-abcd', JSON.stringify(row));
  check("⚠️ a label starting with = is written as text (_cellSafeRow_)", row[6] === "'=HYPERLINK(\"x\")", JSON.stringify(row[6]));
  check("...and the headers were ensured under the same lock", sh.data[0][6] === 'Device' && sh.data[0][7] === 'DeviceId', JSON.stringify(sh.data[0]));
}

console.log("\n" + pass + " passed, " + fail + " FAILED");
process.exit(fail ? 1 : 0);
