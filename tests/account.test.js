// アカウント設定 (2026-09-14): whose notifications, which devices, which theme, which start tab.
//
// ⚠️ WHY. The tab was rebuilt, and four things were added or found:
//  1. toggleNotification(userId, userRole, on) took WHOSE row from the browser, with only "some
//     session exists" as the guard, so any signed-in user could switch a colleague's email
//     notifications. It now resolves the account from the session.
//  2. ログイン中の端末: the caller's own sessions, "this device" marked, and signing out the others.
//     ⚠️ No token may ever reach the browser: sessions are named by a SHA-256 handle, and "this
//     device" is known from the token apiCall already proved (_authToken), not from anything sent.
//  3. The theme gained 端末に合わせる, decided by one pure function.
//  4. 起動時に開く画面, which made the login's tab-permission map a single _tabAllowed.
//
// ⚠️ These run the REAL functions, extracted into a vm sandbox with the sheet stubbed (the
// session.test.js pattern), and every guard is also run against its OLD shape, which must fail.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const JS = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || '';
const strip = function (s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); };

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function codeFn(name) {
  const i = SRC.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('Code.js: no function ' + name);
  return SRC.slice(i + 1, SRC.indexOf('\n}\n', i) + 2);
}
function codeConst(name) {
  const m = SRC.match(new RegExp('^const ' + name + ' = [^\\n]*$', 'm'));
  if (!m) throw new Error('Code.js: no const ' + name);
  return m[0].replace(/^const /, 'var ');
}
function htmlFn(name) {
  const i = JS.indexOf('      function ' + name + '(');
  if (i < 0) throw new Error('Index.html: no function ' + name);
  return JS.slice(i, JS.indexOf('\n      }\n', i) + 8).trim();
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
function fmt(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const ago = function (ms) { return fmt(new Date(Date.now() - ms)); };
const UTILITIES = {
  DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
  computeDigest: function (alg, s) { return Array.from(crypto.createHash(alg).update(String(s), 'utf8').digest()).map(function (b) { return b > 127 ? b - 256 : b; }); },
};
const handle = function (tok) { return crypto.createHash('sha256').update(tok, 'utf8').digest('hex').slice(0, 16); };

// ---------------------------------------------------------------------------
console.log("\n1. メール通知 changes the CALLER's own row, whatever id the browser sends");
{
  const T = codeFn('toggleNotification');
  function run(src, auth, args) {
    const writes = [];
    const rows = {
      Staff_Master: [['ID', 'Name', 'PIN', 'Email', 'Notif'], ['5', '五郎', '', 'a@x', 'ON'], ['6', '六子', '', 'b@x', 'ON']],
      Teacher_Master: [['ID', 'Name', 'PIN', 'Email', 'Notif'], ['5', '先生', '', 't@x', 'ON']],
    };
    const ctx = sandbox([src], {
      _requireSession_: function () { return auth; },
      _isMasterRole_: function (r) { return String(r) === 'master'; },
      SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return {
        getDataRange: function () { return { getValues: function () { return rows[n]; } }; },
        getRange: function (r, c) { return { setValue: function (v) { writes.push([n, r, c, v]); } }; },
      }; } }; } },
    });
    let err = null;
    try { ctx.toggleNotification.apply(null, args); } catch (e) { err = e.message; }
    return { writes: writes, err: err };
  }
  const me = { role: 'sales', id: '5', name: '五郎' };
  const other = run(T, me, ['6', 'sales', false]);
  check("given a colleague's id, it writes the caller's own row",
    other.writes.length === 1 && other.writes[0][0] === 'Staff_Master' && other.writes[0][1] === 2 && other.writes[0][3] === 'OFF',
    JSON.stringify(other));
  const sheet = run(T, me, ['5', 'teacher', false]);
  check("...and a claimed teacher role cannot move the write to the teacher sheet",
    sheet.writes.length === 1 && sheet.writes[0][0] === 'Staff_Master', JSON.stringify(sheet));
  const master = run(T, { role: 'master', id: 'MASTER' }, ['6', 'sales', false]);
  check("master has no row: refused with an actionable message, nothing written",
    master.writes.length === 0 && /マスター/.test(master.err || ''), JSON.stringify(master));
  const observe = run(T, null, ['6', 'sales', true]);
  check("observe mode with no session still reads the arguments, as every guard does there",
    observe.writes.length === 1 && observe.writes[0][1] === 3, JSON.stringify(observe));
  let mutant;
  try { mutant = run(mutate(T, 'if (me) { userId = me.id; userRole = me.role; }', ''), me, ['6', 'sales', false]); }
  catch (e) { mutant = { writes: [], err: e.message }; }
  check("mutation: trusting the arguments writes the colleague's row",
    mutant.writes.length === 1 && mutant.writes[0][1] === 3, JSON.stringify(mutant));
}

// ---------------------------------------------------------------------------
// Sessions: the caller is staff ID 5. A TEACHER also has ID 5 — a different account.
const SESS_ROWS = function () {
  return [
    ['Token', 'Role', 'ID', 'Name', 'Created', 'LastSeen'],
    ['tokA', 'sales', '5', '五郎', ago(2 * DAY), ago(HOUR)],        // this device
    ['tokB', 'jimu', '5', '五郎', ago(9 * DAY), ago(2 * DAY)],       // same account, stale role
    ['tokC', 'teacher', '5', '先生', ago(DAY), ago(HOUR)],           // other account, same ID
    ['tokD', 'sales', '5', '五郎', ago(200 * DAY), ago(120 * DAY)],  // expired
    ['tokE', 'sales', '6', '六子', ago(DAY), ago(HOUR)],             // someone else
  ];
};
const SESSION_SRC = [codeConst('SESSION_MAX_AGE_DAYS'), codeConst('SESSION_MAX_AGE_MS'),
  codeFn('_sessionAgeMs_'), codeFn('_sessionExpired_'), codeFn('_sessionSeenOf_'),
  codeFn('_sessionAccountKey_'), codeFn('_sessionHandle_')];
const ME = { role: 'sales', id: '5', name: '五郎' };

console.log("\n2. getMyAccount lists only the caller's live sessions, and never a token");
{
  const G = codeFn('getMyAccount');
  function run(src, token) {
    const ctx = sandbox(SESSION_SRC.concat([src]), {
      Utilities: UTILITIES, SESSION_SHEET: 'Sessions', _authToken: token,
      _requireSession_: function () { return ME; },
      _isMasterRole_: function (r) { return r === 'master'; },
      _sessionDeadError_: function (m) { return new Error(m); },
      _readTabs_: function () { return { Sessions: SESS_ROWS() }; },
      _findAccountById_: function () { return { row: ['5', '五郎', '', 'a@x', 'ON', '', 'HASHVALUE', 'SALTVALUE', '10000', '2026-09-02 09:14:31', ''] }; },
    });
    return ctx.getMyAccount();
  }
  const out = run(G, 'tokA');
  const json = JSON.stringify(out);
  check("two sessions: this device and the stale-role one on the SAME account",
    out.sessions.length === 2, json);
  check("⚠️ the teacher who shares ID 5 is not listed, nor someone else, nor the expired row",
    out.sessions.every(function (s) { return [handle('tokC'), handle('tokE'), handle('tokD')].indexOf(s.sid) === -1; }), json);
  check("this device is marked, and listed first", out.sessions[0].current === true && out.sessions[1].current === false, json);
  check("each session is named by the SHA-256 handle, not the token", out.sessions[1].sid === handle('tokB'), json);
  check("⚠️ no token appears anywhere in the reply", !/tok[A-E]/.test(json), json);
  check("the password date comes back, and nothing else from the credential columns",
    out.pwUpdatedAt === '2026-09-02 09:14:31' && !/HASHVALUE|SALTVALUE|10000/.test(json), json);
  check("...and the only account-row cell read is PwUpdatedAt (column 10)",
    (strip(G).match(/acct\.row\[/g) || []).length === 1 && /acct\.row\[9\]/.test(G), "");

  let leak;
  try { leak = JSON.stringify(run(mutate(G, 'sid: _sessionHandle_(tok),', 'sid: tok,'), 'tokA')); } catch (e) { leak = 'threw: ' + e.message; }
  check("mutation: returning the token as the handle is caught", /tokA/.test(leak), leak);
  let wide;
  try { wide = run(mutate(G, 'if (tok === "" || _sessionAccountKey_(data[i][1], data[i][2]) !== want) continue;', 'if (tok === "") continue;'), 'tokA'); }
  catch (e) { wide = { sessions: [] }; }
  check("mutation: without the account filter, other accounts are listed", wide.sessions.length === 4, JSON.stringify(wide));
}

console.log("\n3. signing out: only the caller's own sessions, never this device");
{
  function fakeSheet() {
    const rows = SESS_ROWS();
    const deleted = [];
    return {
      rows: rows, deleted: deleted,
      getDataRange: function () { return { getDisplayValues: function () { return rows.map(function (r) { return r.slice(); }); } }; },
      deleteRow: function (n) { deleted.push({ n: n, tok: rows[n - 1][0] }); rows.splice(n - 1, 1); },
    };
  }
  function run(fnName, src, token, arg) {
    const sh = fakeSheet();
    const ctx = sandbox(SESSION_SRC.concat([src]), {
      Utilities: UTILITIES, SESSION_SHEET: 'Sessions', _authToken: token,
      _requireSession_: function () { return ME; },
      _sessionDeadError_: function (m) { return new Error(m); },
      _withSessionLock_: function (ms, fn) { return fn(); },
      _getSessionSheet_: function () { return sh; },
      _forgetTab_: function () {}, _logActivity_: function () {},
    });
    let res = null, err = null;
    try { res = ctx[fnName](arg); } catch (e) { err = e.message; }
    return { res: res, err: err, deleted: sh.deleted };
  }
  const OTHERS = codeFn('signOutMyOtherSessions');
  const all = run('signOutMyOtherSessions', OTHERS, 'tokA');
  const gone = all.deleted.map(function (d) { return d.tok; }).sort().join(',');
  check("「他の端末をすべてログアウト」 ends the account's other rows only (the expired one included)",
    gone === 'tokB,tokD' && all.res && all.res.signedOut === 2, JSON.stringify(all));
  check("...bottom-up, so no row shifts under the loop",
    all.deleted.length === 2 && all.deleted[0].n > all.deleted[1].n, JSON.stringify(all.deleted));
  const noToken = run('signOutMyOtherSessions', OTHERS, '');
  check("⚠️ without the proven token it refuses, rather than counting this device as 'other'",
    noToken.deleted.length === 0 && /この端末/.test(noToken.err || ''), JSON.stringify(noToken));
  let mutant;
  try { mutant = run('signOutMyOtherSessions', mutate(OTHERS, 'tok === "" || tok === _authToken ||', 'tok === "" ||'), 'tokA'); }
  catch (e) { mutant = { deleted: [] }; }
  check("mutation: dropping the this-device check signs this device out too",
    mutant.deleted.some(function (d) { return d.tok === 'tokA'; }), JSON.stringify(mutant.deleted));

  const ONE = codeFn('signOutMySession');
  const mine = run('signOutMySession', ONE, 'tokA', handle('tokB'));
  check("one other device of mine: ended, and only that one",
    mine.deleted.length === 1 && mine.deleted[0].tok === 'tokB', JSON.stringify(mine));
  const teacher = run('signOutMySession', ONE, 'tokA', handle('tokC'));
  check("⚠️ the teacher who shares ID 5: refused as not found, nothing deleted",
    teacher.deleted.length === 0 && /すでにログアウト/.test(teacher.err || ''), JSON.stringify(teacher));
  const current = run('signOutMySession', ONE, 'tokA', handle('tokA'));
  check("this device: refused, pointing at ログアウト instead",
    current.deleted.length === 0 && /ログアウト/.test(current.err || ''), JSON.stringify(current));
  let wide;
  try { wide = run('signOutMySession', mutate(ONE, 'if (tok === "" || _sessionAccountKey_(data[i][1], data[i][2]) !== want) continue;', 'if (tok === "") continue;'), 'tokA', handle('tokC')); }
  catch (e) { wide = { deleted: [] }; }
  check("mutation: without the account check, another account's session can be ended",
    wide.deleted.some(function (d) { return d.tok === 'tokC'; }), JSON.stringify(wide.deleted));
}

console.log("\n4. apiCall parks the proven token for one call, and always clears it");
{
  const A = codeFn('apiCall');
  function run(src) {
    const ctx = sandbox([
      'var _authUser = null; var _authToken = ""; var _currentMethod = ""; var _authMismatchSeen = {}; var seen = null;',
      'function _apiMethods_() { return { probe: function () { seen = _authToken; return 1; }, boom: function () { seen = _authToken; throw new Error("x"); } }; }',
      'function resumeSession(t) { if (t === "bad") throw new Error("dead"); return { role: "sales", id: "5" }; }',
      'function _authEnforcing_() { return true; }',
      src], {});
    const r = {};
    ctx.apiCall('tokA', 'probe', []); r.seenOk = ctx.seen; r.afterOk = ctx._authToken;
    try { ctx.apiCall('tokA', 'boom', []); } catch (e) {} r.afterThrow = ctx._authToken;
    try { ctx.apiCall('bad', 'probe', []); } catch (e) {} r.afterBad = vm.runInContext('_authToken', ctx);
    return r;
  }
  const r = run(A);
  check("the endpoint sees the token it was called with", r.seenOk === 'tokA', JSON.stringify(r));
  check("...and it is cleared afterwards, even when the endpoint throws or the token is bad",
    r.afterOk === '' && r.afterThrow === '' && r.afterBad === '', JSON.stringify(r));
  let m;
  try { m = run(mutate(A, 'finally { _authUser = null; _authToken = ""; _currentMethod = ""; }', 'finally { _authUser = null; _currentMethod = ""; }')); }
  catch (e) { m = { afterOk: 'threw' }; }
  check("mutation: without the clear, the token outlives the call", m.afterOk === 'tokA', JSON.stringify(m));
  check("⚠️ _authToken is declared beside _authUser, above every reader (rule 3)",
    SRC.indexOf('let _authToken = "";') > 0 && SRC.indexOf('let _authToken = "";') < SRC.indexOf('\nfunction apiCall('), "");
  const reg = codeFn('_apiMethods_');
  check("the three new endpoints are in the apiCall registry",
    ['getMyAccount', 'signOutMySession', 'signOutMyOtherSessions'].every(function (n) { return reg.indexOf(n + ': ' + n) !== -1; }), "");
}

console.log("\n5. theme: ライト / ダーク / 端末に合わせる");
{
  const F = htmlFn('_themeIsDark');
  const ctx = sandbox([F]);
  const cases = [['light', false, false], ['light', true, false], ['dark', false, true], ['dark', true, true],
                 ['system', false, false], ['system', true, true], ['junk', true, false]];
  check("all preferences × device setting",
    cases.every(function (c) { return ctx._themeIsDark(c[0], c[1]) === c[2]; }),
    cases.map(function (c) { return c.join('/') + '→' + ctx._themeIsDark(c[0], c[1]); }).join(' '));
  let m;
  try { m = sandbox([mutate(F, "if (pref === 'system') return !!prefersDark;", "if (pref === 'system') return false;")])._themeIsDark('system', true); }
  catch (e) { m = 'threw'; }
  check("mutation: ignoring the device setting fails it", m === false, String(m));
  check("the sidebar button still sets an EXPLICIT choice", /setThemePref\(document\.body\.classList\.contains\("dark-mode"\) \? "light" : "dark"\)/.test(htmlFn('toggleDarkMode')), "");
  check("the preference key is unchanged, so existing choices survive", /localStorage\.setItem\("sms_theme", pref\)/.test(htmlFn('setThemePref')), "");
  check("⚠️ the media query is a hoisted var, so the load-time apply cannot hit a dead zone",
    /\n      var _themeMql = null;/.test(JS) && !/\n      (let|const) _themeMql\b/.test(JS), "");
}

console.log("\n6. 起動時に開く画面 and the ONE tab-permission decision");
{
  const code = strip(JS);
  check("exactly one _tabAllowed", (code.match(/function _tabAllowed\(/g) || []).length === 1, "");
  const setup = strip(htmlFn('setupInterfaceBasedOnRole'));
  check("the login no longer carries its own copy of the permission map", setup.indexOf("'users': 'manage_users'") === -1, "");
  check("the remembered tab and the start tab both ask _tabAllowed, the start tab LAST so it wins",
    setup.indexOf('_tabAllowed(lastTab)') > 0 && setup.indexOf('_tabAllowed(startTab)') > setup.indexOf('_tabAllowed(lastTab)'), "");
  check("the settings list asks the same function", strip(htmlFn('_acctFillStartTabs')).indexOf('_tabAllowed(') !== -1, "");
  const perms = { view_students: true };
  const vis = { 'btn-home': '', 'btn-students': '', 'btn-users': 'none', 'btn-dorms': '' };
  const ctx = sandbox([htmlFn('_tabAllowed')], {
    hasPermission: function (p) { return !!perms[p]; },
    document: { getElementById: function (id) { return (id in vis) ? { style: { display: vis[id] } } : null; } },
  });
  check("allowed: ホーム, and a tab whose permission is held",
    ctx._tabAllowed('home') && ctx._tabAllowed('students'), "");
  check("refused: a permission not held, a hidden button, an unknown tab",
    !ctx._tabAllowed('dorms') && !ctx._tabAllowed('users') && !ctx._tabAllowed('nope'), "");
}

console.log("\n7. the markup");
{
  check("the view tag is byte-identical (usersadmin.test slices at it)", HTML.indexOf('<div id="view-account" class="view-section">') !== -1, "");
  check("#acctLogout is untouched: display:none inline, revealed only on phones",
    /id="acctLogout"[^>]*style="display:none/.test(HTML), "");
  ['acctAvatar', 'acctName', 'acctMeta', 'acctPwForm', 'acctPwUpdated', 'acctPwOthers', 'acctSessions',
   'acctNotif', 'acctTheme', 'acctStartTab'].forEach(function (id) {
    check("#" + id + " exists", HTML.indexOf('id="' + id + '"') !== -1, "");
  });
  check("the old controls are gone, lookups included",
    HTML.indexOf('acctDarkMode') === -1 && HTML.indexOf('acctInfo') === -1, "");
  check("the SYSTEM_PIN tooltip is gone from the screen", strip(htmlFn('renderAccountTab')).indexOf('SYSTEM_PIN') === -1, "");
  const view = HTML.slice(HTML.indexOf('<div id="view-account"'), HTML.indexOf('<div id="view-shinsei"'));
  check("no inline border-radius left in the rebuilt page (the logout copy aside)",
    (view.replace(/<div id="acctLogout"[\s\S]*$/, '').match(/border-radius:/g) || []).length === 0, "");
  const style = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  const block = style.slice(style.indexOf('/* アカウント設定 (2026-09-14)'), style.indexOf('#view-account #acctStartTab'));
  // Comments stripped first: the block's own comment says "no !important".
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '');
  check("the CSS is scoped to #view-account and uses no !important",
    block.length > 1000 && bare.indexOf('!important') === -1 &&
    (bare.match(/^\s*[^\s{}][^{]*\{/gm) || []).every(function (r) { return /#view-account/.test(r) || /^\s*(to|from|\d)/.test(r); }), "");
  check("theme buttons cover all three choices",
    ['light', 'dark', 'system'].every(function (p) { return HTML.indexOf("setThemePref('" + p + "')") !== -1; }), "");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
