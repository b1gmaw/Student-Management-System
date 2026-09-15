// Backups 3×/day instead of a copy on every save — and deletes you can fix by hand.
//
// ⚠️ WHY. Measured (profileRecruitMeta, staging, 2026-09-11): one _snapshotSheet_ took ~1.5s
// (1.25–4.0s), and ~40 save/delete paths paid it while the person pressing 保存 waited. Routine
// edits and single deletes no longer copy; triggerScheduledBackup copies every CHANGED sheet
// from three hand-made time triggers, and each single delete writes its whole row into 操作履歴
// so a mistake can be put back by hand. Bulk, unattended, restore and one-off work still copies.
//
// These run the REAL functions in a vm sandbox (the session.test.js pattern), and every guard is
// also run against its unsafe shape, which must FAIL.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
const JS = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || '';

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function codeFn(name) {
  const i = SRC.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('Code.js: no function ' + name);
  // A one-line function closes on its own line — without this the slice runs on into the
  // declarations below it (found on _backupExclude_, which is deliberately one line).
  const line = SRC.slice(i + 1, SRC.indexOf('\n', i + 1));
  if ((line.match(/\{/g) || []).length > 0 && (line.match(/\{/g) || []).length === (line.match(/\}/g) || []).length) return line;
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

// ---------------------------------------------------------------------------
console.log("\n1. the scheduled job copies what CHANGED, never tokens or the audit log");
{
  const JOB = codeFn('triggerScheduledBackup');
  const CONSTS = ['var SESSION_SHEET = "Sessions"; var AUDIT_SHEET = "Activity_Log";',
    codeConst('SCHEDULED_BACKUP_MIN_GAP_SEC'), codeConst('BACKUP_DIGEST_PROP'), codeConst('BACKUP_REPORT_PROP'),
    codeFn('_backupExclude_'), codeConst('BACKUP_CELL_WARN')];
  // One "project": its sheets, script properties, cache, and the copies made.
  function project(sheets, opts) {
    opts = opts || {};
    const st = { props: {}, cache: {}, copies: [], logs: [], sheets: sheets };
    st.run = function (jobSrc) {
      const ctx = sandbox(CONSTS.concat([codeFn('_sheetDigest_'), jobSrc || JOB, 'var _authUser = "was";']), {
        CacheService: { getScriptCache: function () { return {
          get: function (k) { return st.cache[k] || null; }, put: function (k, v) { st.cache[k] = v; } }; } },
        PropertiesService: { getScriptProperties: function () { return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(st.props, k) ? st.props[k] : null; },
          setProperty: function (k, v) { st.props[k] = String(v); } }; } },
        SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheets: function () {
          if (opts.explode) throw new Error('Service Spreadsheets failed');
          return Object.keys(st.sheets).map(function (n) {
            return { getName: function () { return n; },
                     getDataRange: function () { return { getDisplayValues: function () { return st.sheets[n]; } }; } };
          }); } }; } },
        Utilities: {
          DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
          computeDigest: function (a, s) { return Array.from(crypto.createHash('md5').update(s, 'utf8').digest()); },
          base64Encode: function (b) { return Buffer.from(b).toString('base64'); },
          formatDate: function () { return '2026/09/11 12:04'; },
        },
        _snapshotSheet_: function (n) { if ((opts.failing || []).indexOf(n) !== -1) return false; st.copies.push(n); return true; },
        _backupCellCount_: function () { return opts.cells || 12000; },
        _logActivity_: function (a, act, t, d) { st.logs.push([act, t, d]); },
      });
      st.cache = {};                                  // the next run is a later trigger
      const r = ctx.triggerScheduledBackup();
      st.authAfter = ctx._authUser;
      return r;
    };
    return st;
  }
  const p = project({ Sessions: [['tok']], Activity_Log: [['log']], Schedule_DB: [['a']], Recruitment_DB: [['b']] });
  const r1 = p.run();
  check("⚠️ the first run copies every sheet EXCEPT Sessions and Activity_Log",
    p.copies.join(',') === 'Schedule_DB,Recruitment_DB', p.copies.join(','));
  check("...and reports it", r1.copied.length === 2 && r1.unchanged === 0 && r1.error === "", JSON.stringify(r1));
  p.copies.length = 0;
  const r2 = p.run();
  check("⚠️ a run with nothing changed copies NOTHING (retention keeps distinct versions)",
    p.copies.length === 0 && r2.unchanged === 2, JSON.stringify(r2));
  p.sheets.Recruitment_DB = [['b'], ['c']];
  const r3 = p.run();
  check("a changed sheet — and only it — is copied", p.copies.join(',') === 'Recruitment_DB', p.copies.join(','));
  check("the report is stored where the バックアップ pane reads it",
    JSON.parse(p.props.BACKUP_REPORT || '{}').copied.join(',') === 'Recruitment_DB', p.props.BACKUP_REPORT);
  check("one 操作履歴 line per run", p.logs.length === 3 && p.logs[2][0] === '自動バックアップ', JSON.stringify(p.logs));
  check("the parked system session is restored afterwards", p.authAfter === 'was', String(p.authAfter));

  const leak = project({ Sessions: [['tok']], Schedule_DB: [['a']] });
  leak.run(mutate(JOB, 'if (_backupExclude_().indexOf(name) !== -1) return;', ''));
  check("mutation: without the exclusion the TOKENS get copied", leak.copies.indexOf('Sessions') !== -1, leak.copies.join(','));

  // ⚠️ A copy that failed must be retried, not recorded as done.
  const f = project({ Schedule_DB: [['a']] }, { failing: ['Schedule_DB'] });
  const rf = f.run();
  check("a failed copy is reported as failed", rf.failed.join(',') === 'Schedule_DB' && rf.copied.length === 0, JSON.stringify(rf));
  const g = project({ Schedule_DB: [['a']] }, { failing: ['Schedule_DB'] });
  g.run();
  const retry = project(g.sheets);                   // same data, copies now succeed…
  retry.props = g.props;                             // …with the fingerprints the failed run left
  retry.run();
  check("⚠️ ...and RETRIED next run (its fingerprint was not recorded)", retry.copies.join(',') === 'Schedule_DB',
    "a failed copy recorded as done would skip this version forever");
  const g2 = project({ Schedule_DB: [['a']] }, { failing: ['Schedule_DB'] });
  const bad = mutate(JOB, 'if (_snapshotSheet_(name)) { if (d !== "") next[name] = d; rep.copied.push(name); }',
                          'next[name] = d; if (_snapshotSheet_(name)) { rep.copied.push(name); }');
  g2.run(bad);
  const retry2 = project(g2.sheets); retry2.props = g2.props; retry2.run(bad);
  check("  mutation: recording the fingerprint regardless skips the retry", retry2.copies.length === 0, retry2.copies.join(','));

  // A cache that already holds the run marker: a second call inside the window.
  const throttledCopies = [];
  const sb = sandbox(CONSTS.concat([codeFn('_sheetDigest_'), JOB, 'var _authUser = null;']), {
    CacheService: { getScriptCache: function () { return { get: function () { return '1'; }, put: function () {} }; } },
    _snapshotSheet_: function () { throttledCopies.push('X'); return true; },
  });
  check("⚠️ a call inside the window is THROTTLED, not run (it is web-callable)",
    sb.triggerScheduledBackup() === 'throttled' && throttledCopies.length === 0, "");

  const boom = project({ Schedule_DB: [['a']] }, { explode: true });
  const rb = boom.run();
  check("a Sheets failure is REPORTED, and the session is still restored",
    /Service Spreadsheets failed/.test(rb.error) && boom.authAfter === 'was', JSON.stringify(rb));
  const big = project({ Schedule_DB: [['a']] }, { cells: 9000000 });
  check("near Sheets' 10M-cell cap the report says so", big.run().nearLimit === true, "");
}

console.log("\n2. a deleted row reaches 操作履歴 — never a credential");
{
  const ctx = sandbox([codeConst('ACCOUNT_HEADERS'), codeConst('ROW_LOG_MAX'), codeFn('_rowForLog_')]);
  const H = ['ID', 'Name', 'PIN', 'Email', 'Notifications', 'Permissions',
             'PasswordHash', 'Salt', 'PwIterations', 'PwUpdatedAt', 'PwMustChange', 'Role', '管理者権限'];
  const R = ['S01', '甲野', '1234', 't@example.jp', 'ON', 'view_students',
             'HASHVALUE', 'SALTVALUE', '10000', '2026/09/01', '', 'sales', 'Y'];
  const out = ctx._rowForLog_(H, R);
  check("the ordinary fields are there", /ID=S01/.test(out) && /Name=甲野/.test(out) && /Email=t@example\.jp/.test(out) && /Role=sales/.test(out), out);
  check("⚠️ no PIN, hash, salt or iteration count", !/1234|HASHVALUE|SALTVALUE|10000/.test(out), out);
  check("blanks are skipped", !/PwMustChange=/.test(out), out);
  const noNever = sandbox([codeConst('ACCOUNT_HEADERS'), codeConst('ROW_LOG_MAX'),
    mutate(codeFn('_rowForLog_'), 'if (never.indexOf(h) !== -1) return;', '')]);
  check("  mutation: without the header check the hash is logged", /HASHVALUE/.test(noNever._rowForLog_(H, R)), "");
  // ⚠️ The reason callers holding a user row ALSO omit by position.
  const blankHeaders = H.map(function (h, i) { return (i >= 6 && i <= 10) ? '' : h; });
  check("an older sheet with BLANK headers over the hash would leak it by name alone…",
    /HASHVALUE/.test(ctx._rowForLog_(blankHeaders, R)), "this is what `omit` exists for");
  check("⚠️ …so deleteSystemUser omits PIN and 7–11 by position, and then nothing leaks",
    !/1234|HASHVALUE|SALTVALUE/.test(ctx._rowForLog_(blankHeaders, R, [2, 6, 7, 8, 9, 10])) &&
    /_rowForLog_\(data\[0\], data\[i\], \[2, 6, 7, 8, 9, 10\]\)/.test(codeFn('deleteSystemUser')), "");
  const long = ctx._rowForLog_(['x'], ['y'.repeat(5000)]);
  check("capped, so one wide row cannot bloat the log", long.length <= 2001 && /…$/.test(long), String(long.length));
  check("a blank header still names its column", /列2=v/.test(ctx._rowForLog_(['a', ''], ['u', 'v'])), "");
}

console.log("\n3. who may still copy — derived from the source, both ways");
{
  // ⚠️ The allowlist of immediate copies. Anything else calling _snapshotSheet_ fails here, so a
  // routine save cannot quietly start paying ~1.5s again — and a kept one cannot lose its copy.
  const KEPT = ['restoreSnapshot', 'migrateAddPasswordColumns', 'reorderPlacementConfig', 'importResultsFromBookings',
    'removeRecruitmentMeta', '_recMaterialiseLegacyCountries_', 'migrateOtherVisaAddDesiredColumn', 'profileApp',
    'saveSimulationData', 'migrateBuildingAddBurnablePlastic', 'deleteBuilding', 'saveEnrollmentMonths',
    'syncDormsFromCentralDB', 'triggerScheduledBackup'];
  const re = /^function ([A-Za-z_]\w*)\s*\(/gm;
  const starts = []; let m;
  while ((m = re.exec(SRC))) starts.push({ name: m[1], at: m.index });
  const copying = starts.filter(function (s, i) {
    const body = SRC.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : SRC.length)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    return s.name !== '_snapshotSheet_' && /_snapshotSheet_\(/.test(body);
  }).map(function (s) { return s.name; });
  const extra = copying.filter(function (n) { return KEPT.indexOf(n) === -1; });
  const lost = KEPT.filter(function (n) { return copying.indexOf(n) === -1; });
  check("⚠️ ONLY the kept list takes an immediate copy", extra.length === 0,
    "these copy on the save path again (~1.5s each): " + extra.join(', '));
  check("⚠️ ...and every kept one still does", lost.length === 0,
    "bulk / unattended / restore work lost its copy: " + lost.join(', '));
  check("the throttled-copy helper is gone, not left unused", SRC.indexOf('_snapshotSheetThrottled') === -1, "");
  check("_snapshotSheet_ reports whether it copied (the job must not record a failed copy)",
    /return true;\s*\} catch \(e\) \{[\s\S]{0,300}return false;/.test(codeFn('_snapshotSheet_')), "");
  check("retention is a week of 3×/day", /^const SNAPSHOT_KEEP = 21;/m.test(SRC), "");
  check("the restore screen receives the scheduled report", (codeFn('getSnapshotList').match(/scheduled: _readBackupReport_\(\)/g) || []).length === 2, "");
}

console.log("\n4. the バックアップ pane makes a stopped trigger visible");
{
  const ctx = sandbox([htmlFn('escHtmlJs'), 'var DS_AUTO_STALE_MS = 12 * 60 * 60 * 1000;', htmlFn('_dsAutoLine')]);
  const now = Date.parse('2026-09-11T12:00:00Z');
  const fresh = { at: '2026/09/11 20:00', atMs: now - 2 * 3600e3, copied: ['A', 'B'], unchanged: 5, failed: [], nearLimit: false, error: '' };
  check("never run → a warning that asks for the setup", /u-warn/.test(ctx._dsAutoLine(null, now)) && /まだ実行されていません/.test(ctx._dsAutoLine(null, now)), "");
  check("fresh → green, with what it copied", /u-live/.test(ctx._dsAutoLine(fresh, now)) && /2シート保存・5シート変更なし/.test(ctx._dsAutoLine(fresh, now)), "");
  const stale = Object.assign({}, fresh, { atMs: now - 20 * 3600e3 });
  check("⚠️ older than 12h → a warning that it may have stopped", /u-warn/.test(ctx._dsAutoLine(stale, now)) && /止まっている可能性/.test(ctx._dsAutoLine(stale, now)), "");
  check("an error → red", /u-bad/.test(ctx._dsAutoLine(Object.assign({}, fresh, { error: 'x' }), now)), "");
  check("failed copies and the cell cap are both shown",
    /保存に失敗: C/.test(ctx._dsAutoLine(Object.assign({}, fresh, { failed: ['C'] }), now)) &&
    /上限に近づいています/.test(ctx._dsAutoLine(Object.assign({}, fresh, { nearLimit: true }), now)), "");
  check("the error text is escaped", /&lt;img/.test(ctx._dsAutoLine(Object.assign({}, fresh, { error: '<img src=x>' }), now)), "");
  check("the lede no longer claims a copy before every write",
    /各シートは1日3回、変更があれば自動でバックアップされます（シートごとに最新21件）/.test(HTML) && !/書き込み前に自動でバックアップ/.test(HTML), "");
}

console.log("\n" + pass + " passed, " + fail + " FAILED");
process.exit(fail ? 1 : 0);
