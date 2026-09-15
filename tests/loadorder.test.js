// The whole server project must LOAD — its top level executed in order, as Apps Script does.
//
// ⚠️ WHY. Apps Script runs every top-level line of every server file on EVERY execution, in file
// order, before the function that was called. Staging v190 shipped
//     const BACKUP_EXCLUDE = [SESSION_SHEET, AUDIT_SHEET];      // line ~537
// with `const SESSION_SHEET` declared ~800 lines further down. Reading a const before its
// declaration is a temporal-dead-zone ReferenceError, thrown while the script LOADS — so every
// endpoint and the page itself failed, not just the new backup job. Reported as
// "ReferenceError: Cannot access 'SESSION_SHEET' before initialization".
//
// `node --check` passed (it is syntax only), and every behavioural suite passed, because each
// sandbox defined what it needed first. The only way to see it is to run the top level exactly
// as the platform does. This is rule 3 (declaration order) on the SERVER side.
//
// Every Apps Script service is a universal stub: any property is callable and returns another
// stub, so top-level code that touches a service still runs. Only ordering errors surface.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FILES = ['Code.js', 'Shinsei_Code.js'];

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

function stub() {
  const f = function () { return stub(); };
  return new Proxy(f, {
    get: function (t, p) {
      if (p === Symbol.toPrimitive) return function () { return ''; };
      if (p === 'toString' || p === 'valueOf') return function () { return ''; };
      if (p === 'then') return undefined;               // never look like a promise
      return stub();
    },
    apply: function () { return stub(); },
    construct: function () { return stub(); },
  });
}
const SERVICES = ['SpreadsheetApp', 'PropertiesService', 'CacheService', 'Utilities', 'DriveApp',
  'HtmlService', 'Session', 'ScriptApp', 'MailApp', 'GmailApp', 'LockService', 'Logger', 'UrlFetchApp',
  'Sheets', 'ContentService', 'CalendarApp', 'MimeType', 'XmlService', 'Charts', 'DocumentApp'];

// Load the given sources into ONE realm, in order, exactly as the project shares one global scope.
function load(sources) {
  const g = { console: { log() {}, warn() {}, info() {}, error() {} } };
  SERVICES.forEach(function (n) { g[n] = stub(); });
  const ctx = vm.createContext(g);
  try {
    sources.forEach(function (s) { vm.runInContext(s.code, ctx, { filename: s.name }); });
    return { ok: true, ctx: ctx };
  } catch (e) {
    return { ok: false, err: String(e && e.message || e) + (e && e.stack ? '\n        ' + String(e.stack).split('\n').slice(0, 2).join(' | ') : '') };
  }
}
const src = FILES.map(function (f) { return { name: f, code: fs.readFileSync(path.join(ROOT, f), 'utf8') }; });

console.log("\n1. the project's top level runs without a load-time error");
{
  // No filePushOrder is pinned, so both orders must load.
  const a = load(src), b = load(src.slice().reverse());
  check(FILES.join(' → ') + " loads", a.ok, a.err);
  check(FILES.slice().reverse().join(' → ') + " loads", b.ok, b.err);
  if (a.ok) {
    check("...and the endpoints it serves exist afterwards",
      typeof a.ctx.doGet === 'function' && typeof a.ctx.apiCall === 'function' &&
      typeof a.ctx.triggerScheduledBackup === 'function', "");
  }
}

console.log("\n2. mutation: the v190 line fails this suite");
{
  // ⚠️ Put the shipped bug back and prove the check sees it — a load test that passes both ways
  // is decoration.
  const code = src[0].code;
  const anchor = 'function _backupExclude_() { return [SESSION_SHEET, AUDIT_SHEET]; }';
  check("the anchor for the mutation is present", code.split(anchor).length === 2, "");
  const broken = code.replace(anchor, 'const BACKUP_EXCLUDE = [SESSION_SHEET, AUDIT_SHEET];');
  const r = load([{ name: 'Code.js', code: broken }, src[1]]);
  check("⚠️ the shipped v190 declaration order FAILS to load here",
    !r.ok && /SESSION_SHEET/.test(r.err) && /before initialization/.test(r.err), r.ok ? "loaded — the suite cannot see TDZ" : r.err);
}

console.log("\n" + pass + " passed, " + fail + " FAILED");
process.exit(fail ? 1 : 0);
