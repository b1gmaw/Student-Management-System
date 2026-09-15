// Every identifier of the school's real Google resources lives in script properties.
//
// ⚠️ WHY. The repo is to be published. The enrollment spreadsheet ID, three Drive folder IDs and
// the notification address were literals in Code.js / Shinsei_Code.js, and an ID is an address
// to real student data. They moved to script properties on 2026-09-15. This suite keeps them
// from coming back and pins how a missing one behaves.
//
// ⚠️ Runs the REAL helpers in a vm sandbox (the session.test.js pattern), and each guard is run
// against its old shape, which must fail.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };
const SRC = read('Code.js');
const SHINSEI = read('Shinsei_Code.js');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function codeFn(src, name) {
  const i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('no function ' + name);
  return src.slice(i + 1, src.indexOf('\n}\n', i) + 2);
}
function mutate(src, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error('mutation anchor found ' + n + ' times: ' + from.slice(0, 60));
  return src.replace(from, to);
}

// A Drive / Sheets ID: a "1" followed by 24+ URL-safe characters mixing upper, lower and digits.
// Server files and docs are scanned raw; the HTML files only inside quotes, because Index.html
// embeds a base64 logo whose runs look exactly like this.
function idsRaw(text) {
  return (text.match(/(?<![A-Za-z0-9_-])1[A-Za-z0-9_-]{24,60}(?![A-Za-z0-9_-])/g) || [])
    .filter(function (t) { return /[A-Z]/.test(t) && /[a-z]/.test(t); });
}
function idsQuoted(text) {
  const out = [];
  text.replace(/(['"`])(1[A-Za-z0-9_-]{24,60})\1/g, function (_, q, id) {
    if (/[A-Z]/.test(id) && /[a-z]/.test(id)) out.push(id); return _;
  });
  return out;
}
const PLACEHOLDER_EMAILS = ['example@email.com', 'name@example.jp'];
function realEmails(text) {
  return (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) || []).filter(function (e) {
    return PLACEHOLDER_EMAILS.indexOf(e) === -1 && !/@example\.(com|jp|invalid)$/i.test(e);
  });
}
function literalLookups(text) {
  return text.match(/(getFolderById|openById|getFileById)\(\s*['"`]/g) || [];
}

console.log("\n1. no real identifier in anything that gets published");
{
  const RAW = ['Code.js', 'Shinsei_Code.js', 'CLAUDE.md', 'TECHNICAL_REFERENCE.md', 'README.md',
               '.claude/skills/run-local/driver.mjs'];
  const HTMLS = ['Index.html', 'Template.html', 'Shinsei_Template.html'];
  const present = function (f) { return fs.existsSync(path.join(ROOT, f)); };
  RAW.filter(present).forEach(function (f) {
    const ids = idsRaw(read(f));
    check(f + ": no Google-ID-shaped token", ids.length === 0, ids.join(", "));
  });
  HTMLS.forEach(function (f) {
    const ids = idsQuoted(read(f));
    check(f + ": no Google-ID-shaped literal", ids.length === 0, ids.join(", "));
  });
  RAW.concat(HTMLS).filter(present).forEach(function (f) {
    const em = realEmails(read(f));
    check(f + ": no email address beyond the placeholders", em.length === 0, em.join(", "));
  });
  // Mutation: the old shape of the one Shinsei lookup.
  check("  mutation: a literal folder ID is caught",
    idsRaw('DriveApp.getFolderById("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456")').length === 1, "");
  check("  mutation: an address in a from: is caught",
    realEmails("{ from: 'sender@school.test', name: 'x' }").length === 1, "");
}

console.log("\n2. lookups and mail take their values from configuration");
{
  [['Code.js', SRC], ['Shinsei_Code.js', SHINSEI]].forEach(function (p) {
    const lit = literalLookups(p[1]);
    check(p[0] + ": no literal passed to getFolderById / openById / getFileById", lit.length === 0, lit.join(" | "));
    check(p[0] + ": no from: literal on an email", !/from:\s*['"`]/.test(p[1]), "");
  });
  check("  mutation: the old folder lookup is caught",
    literalLookups("DriveApp.getFolderById('1FakeFolderIdForThisTest0000')").length === 1, "");
  check("every notification goes through _mailOptions_",
    (SRC.match(/_mailOptions_\(\)/g) || []).length >= 8, "found " + (SRC.match(/_mailOptions_\(\)/g) || []).length);
}

console.log("\n3. a missing setting fails closed, with a code and no internal name");
try {
  const consts = (SRC.match(/^const CONFIG_\w+ = '[A-Z_]+';$/gm) || []);
  check("the keys are plain string constants", consts.length === 5, consts.join(" | "));
  function env(map, broken) {
    return {
      console: { log() {}, warn() {}, info() {}, error() {} },
      PropertiesService: { getScriptProperties: function () {
        if (broken) throw new Error("service down");
        return { getProperty: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } };
      } }
    };
  }
  const HELPERS = [consts.join('\n'), codeFn(SRC, '_configValue_'), codeFn(SRC, '_requireConfig_'), codeFn(SRC, '_mailOptions_')];
  function sandbox(map, broken, sources) {
    const ctx = vm.createContext(env(map, broken));
    vm.runInContext((sources || HELPERS).join('\n\n'), ctx);
    return ctx;
  }
  function thrown(ctx, key) { try { ctx._requireConfig_(key); return null; } catch (e) { return e.message; } }

  const unset = thrown(sandbox({}), 'UPLOADS_FOLDER_ID');
  check("unset throws", unset !== null, "returned instead of throwing");
  check("...with SYS-06", /（SYS-06）/.test(unset || ""), unset);
  check("...naming no key and no internal word", !/_ID|FOLDER|プロパティ|property/i.test(unset || ""), unset);
  check("blank and full-width blank count as unset", thrown(sandbox({ UPLOADS_FOLDER_ID: ' 　' }), 'UPLOADS_FOLDER_ID') !== null, "");
  check("an unreadable property service fails closed the same way",
    /（SYS-06）/.test(thrown(sandbox({}, true), 'UPLOADS_FOLDER_ID') || ""), "");
  check("a set value comes back trimmed",
    sandbox({ UPLOADS_FOLDER_ID: '  abc  ' })._requireConfig_('UPLOADS_FOLDER_ID') === 'abc', "");

  const noThrow = [HELPERS[0], HELPERS[1], mutate(HELPERS[2], 'if (v === "") {', 'if (false) {'), HELPERS[3]];
  check("  mutation: a helper that returns \"\" is caught",
    thrown(sandbox({}, false, noThrow), 'UPLOADS_FOLDER_ID') === null, "the mutation did not take");

  const none = sandbox({})._mailOptions_();
  check("mail without the alias has no from, and keeps the sender name",
    !Object.prototype.hasOwnProperty.call(none, 'from') && none.name === 'マイスケジュール', JSON.stringify(none));
  const withFrom = sandbox({ NOTIFY_FROM_EMAIL: ' alias@example.jp ' })._mailOptions_();
  check("mail with the alias uses it, trimmed", withFrom.from === 'alias@example.jp' && withFrom.name === 'マイスケジュール',
    JSON.stringify(withFrom));
} catch (e) { check("section 3 ran", false, e.message); }

console.log("\n4. the import resolves its source before anything else, and every key is reported");
try {
  const body = codeFn(SRC, 'fetchAndMergeStudentData');
  const at = body.indexOf('_requireConfig_(CONFIG_STUDENT_SOURCE)');
  const firstWork = Math.min.apply(null, ['insertSheet(', 'openById(', 'setValues(', '.clear'].map(function (w) {
    const i = body.indexOf(w); return i === -1 ? Infinity : i; }));
  check("the source is resolved", at !== -1, "");
  check("...before the first sheet or spreadsheet is touched", at !== -1 && at < firstWork, "at " + at + ", first work " + firstWork);
  check("every sync config reads the resolved id", !/sourceId:\s*['"`]/.test(body) && /sourceId: sourceId/.test(body), "");

  const auth = codeFn(SRC, 'authoriseServices');
  const keys = (SRC.match(/^const (CONFIG_\w+) = /gm) || []).map(function (l) { return l.replace(/^const | = $/g, ''); });
  const missing = keys.filter(function (k) { return auth.indexOf(k) === -1; });
  check("authoriseServices reports every key", keys.length > 0 && missing.length === 0, missing.join(", "));
  check("  mutation: a key it does not report is caught",
    keys.filter(function (k) { return mutate(auth, 'CONFIG_NOTIFY_FROM, "email"', 'X, "email"').indexOf(k) === -1; }).length === 1, "");
} catch (e) { check("section 4 ran", false, e.message); }

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
