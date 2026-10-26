// 修了・卒業生進路: the retouch into the app's palette (2026-09-16), the graduate search, and the
// 修正-picker gate that was stricter than the server.
//
// Measured before: this sub-view had NO css at all — every colour, padding and alignment inline,
// which is why the finish layer never reached it — and it still carried the inline green 出力 that
// the 学生数 retouch flagged as the last one. Two real defects went with it:
//   - `canEdit = isMasterRole() || currentUser.role === 'admin'` re-derived admin-ness from the
//     role NAME, so a 管理者権限 holder on a custom role saw no 修正 picker while
//     saveDestinationOverride / saveDestinationAlias (guarded by _isAdminLevel_) would have
//     accepted the change. The client must never be stricter than the backend.
//   - a student could only be reached by clicking the summary cell they happen to fall into,
//     which needs their 修了期 and their outcome known first.
//
// ⚠️ Each guard is also run against the OLD shape and must fail there.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function swap(src, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error('mutation anchor found ' + n + ' times: ' + from.slice(0, 70));
  return src.replace(from, to);
}
function guard(name, pred, from, to, why) {
  let old;
  try { old = pred(swap(HTML, from, to)); } catch (e) { old = 'mutation failed: ' + e.message; }
  check(name, pred(HTML) === true, why || '');
  check("  mutation: the old shape fails it", old === false, String(old));
}
const style = function (h) { return h.slice(h.indexOf('<style>'), h.indexOf('</style>')); };
const desk = function (h) { const st = style(h); return st.slice(0, st.indexOf('@media (max-width: 820px)')); };
const block = function (h) { const d = desk(h); const i = d.indexOf('/* 進路 retouch'); return i < 0 ? '' : d.slice(i, d.indexOf('/* end 進路 retouch */', i)); };
const view = function (h) { const a = h.indexOf('<div id="sub-view-dest"'); return a < 0 ? '' : h.slice(a, h.indexOf('<div id="sub-view-report"', a)); };
const js = function (h) { return (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || ''; };
const fn = function (h, name) { const s = js(h); const i = s.indexOf('      function ' + name + '('); return i < 0 ? '' : s.slice(i, s.indexOf('\n      }\n', i) + 8); };
const ACCENT = /(background(-color)?|color):\s*#(f6c23e|36b9cc|4e73df|1cc88a|e74a3b)/i;

console.log("\n1. one palette: nothing accent-coloured is left inline");
{
  // ⚠️ The anchor starts at 進路's own 集計表 button: 学生数's 出力 button is byte-identical since
  // its own retouch, and 入学予定者's (2026-10-01) is too, so the wrapper alone matched twice and the
  // mutation was refused. Anchor on what only this view has.
  const DEST_EXPORT = '<span class="btn-label">集計表</span></button>\n            <span class="exp-wrap permission-req" data-perm="export_students" data-orig-display="inline-block" style="display:none;">\n              <button class="export-btn" onclick="expToggle(event)">';
  guard("no button in the 進路 markup carries an inline accent",
    function (h) { const b = view(h).match(/<button[^>]*>/g) || []; return b.length >= 2 && !b.some(function (t) { return ACCENT.test(t); }); },
    DEST_EXPORT, DEST_EXPORT.replace('class="export-btn"', 'class="export-btn" style="background-color:#1cc88a;"'));
  guard("the error line uses the danger token, not a hex",
    function (h) { const v = view(h); return v.length > 500 && !ACCENT.test(v); },
    '<div id="destError" class="dest-error" style="display:none;"></div>',
    '<div id="destError" style="display:none; color:#e74a3b; font-size:13px;"></div>');
  check("the detail renderer builds no inline style at all",
    fn(HTML, 'destRenderDetail').length > 2000 && fn(HTML, 'destRenderDetail').indexOf('style=') === -1,
    "every cell, heading and picker carried one before");
}

console.log("\n2. tonal secondaries, ONE solid primary");
{
  guard("the retouch block exists in the DESKTOP stylesheet",
    function (h) { return block(h).length > 400; },
    '/* 進路 retouch', '/* 進路 re-touch');
  const b = block(HTML);
  // The selector list may carry other views that SHARE this rule (入学予定者, 2026-10-01).
  check("集計表 is tonal", /#sub-view-dest \.schedule-btn(?:, [^{]+)? \{[^}]*background: var\(--report-header-bg\)/.test(b), "");
  check("出力 is the solid primary", /#sub-view-dest \.export-btn(?:, [^{]+)? \{[^}]*background: var\(--primary-color\)/.test(b), "");
  check("修正モード: ON is a class, not an inline paint", /#sub-view-dest \.dest-edit\.on \{/.test(b), "");
  guard("no !important in the block (the mobile rules must keep winning on a phone)",
    function (h) { const x = block(h).replace(/\/\*[\s\S]*?\*\//g, ''); return x.length > 0 && x.indexOf('!important') === -1; },
    '#sub-view-dest .export-btn:hover, #sub-view-incoming .export-btn:hover { filter: brightness(0.9); }',
    '#sub-view-dest .export-btn:hover, #sub-view-incoming .export-btn:hover { filter: brightness(0.9) !important; }');
  check("...and no bare transition duration (it means `all`)", !/transition:\s*[0-9.]+m?s/.test(b), "");
  // ⚠️ A flex item defaults to its content width; without this the search box pushes the
  // buttons off the toolbar instead of shrinking (the .rec-bottom-col lesson).
  check("the search box may shrink inside the toolbar",
    /#sub-view-dest \.dest-bar \.search-wrap \{[^}]*min-width: 0/.test(b), "");
}

console.log("\n3. ⚠️ the 修正 picker follows the SERVER's admin rule");
{
  // ⚠️ Comments stripped: the code's own comment quotes the old shape to explain why it went,
  // and a raw scan reads that explanation as the violation.
  const noComments = function (s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1'); };
  guard("canEdit mirrors user.isAdmin via isAdminRole()",
    function (h) { const f = noComments(fn(h, 'destRenderDetail')); return /const canEdit = isAdminRole\(\);/.test(f) && f.indexOf("currentUser.role === 'admin'") === -1; },
    'const canEdit = isAdminRole();',
    "const canEdit = isMasterRole() || currentUser.role === 'admin';");
  // The server side of the same decision, so the two cannot drift apart unnoticed.
  ['saveDestinationOverride', 'saveDestinationAlias'].forEach(function (name) {
    const at = CODE.indexOf('\nfunction ' + name + '(');
    const body = at === -1 ? '' : CODE.slice(at, CODE.indexOf('\n}\n', at));
    check(name + " is still guarded by _isAdminLevel_ on the server",
      body.indexOf('_isAdminLevel_(') !== -1,
      "if this ever narrows, the client gate has to narrow with it");
  });
}

console.log("\n4. the search runs on rows the browser already has");
{
  // ⚠️ WHY IT IS LOCAL. Measured (TECHNICAL_REFERENCE §8.1.1): a Past_DB-reading producer is
  // ~419ms and every guarded call also pays a ~420ms session resume, so the server search cost
  // 0.7–1.2s per query and refining a name paid it again. 集計表 already fetched every graduate
  // once per session, so the answer was in the page: filtering it is sub-millisecond.
  const v = view(HTML);
  check("the box exists, with the shared .search-box look",
    /<input type="text" id="destSearchInp" class="search-box"/.test(v), "");
  check("typing is debounced and Enter searches at once",
    /oninput="destSearchInput\(\)"/.test(v) && /onkeydown="if\(event\.key==='Enter'\)/.test(v), "");
  const input = fn(HTML, 'destSearchInput'), now = fn(HTML, 'destSearchNow');
  guard("the debounce only coalesces rendering now, so it is short",
    function (h) { return /setTimeout\(destSearchNow, 80\)/.test(fn(h, 'destSearchInput')); },
    'setTimeout(destSearchNow, 80)', 'setTimeout(destSearchNow, 300)');
  check("the timer is cleared before it is re-armed", /clearTimeout\(_destSearchTimer\)/.test(input), input);
  check("⚠️ a query under 2 characters filters nothing", /q\.length < 2/.test(now),
    "one character matches most of the school");
  check("an emptied box returns to the 未分類 queue rather than erroring",
    /if \(asked === ''\) \{ destShowUnclassified\(\); return; \}/.test(now), "");
  check("results go through destRenderDetail — no second renderer",
    /destRenderDetail\('', '', hit, '検索: ' \+ asked\)/.test(now), "a copy drifts on the first column added");
  check("Esc clears the box back to the queue",
    /else if \(el\.id === 'destSearchInp'\) \{ try \{ destShowUnclassified\(\); \} catch\(_\)\{\} \}/.test(js(HTML)), "");
  guard("⚠️ a re-render after a correction keeps the SEARCH, not 全期間 判明分",
    function (h) { const f = fn(h, 'destRender'); return /if \(_destShown\.title\) \{\s*\n\s*destSearchNow\(\);/.test(f); },
    'if (_destShown.title) {\n          destSearchNow();\n        } else if (_destShown.rows.length || _destShown.cat) {',
    'if (_destShown.rows.length || _destShown.cat) {');

  // ---- no round trip, and one list ----
  guard("⚠️ an already-loaded list is filtered with NO call",
    function (h) { const f = fn(h, 'destSearchNow'); return /if \(_destPivotRows\) \{ run\(_destPivotRows\); return; \}/.test(f); },
    'if (_destPivotRows) { run(_destPivotRows); return; }', 'if (false) { run(_destPivotRows); return; }');
  check("the search asks no endpoint of its own", fn(HTML, 'destSearchNow').indexOf('apiRun()') === -1,
    "the whole point is that the rows are already here");
  check("⚠️ 集計表 and the search share ONE loader",
    /_destAllRows\(/.test(fn(HTML, 'destOpenPivot')) && /_destAllRows\(run,/.test(fn(HTML, 'destSearchNow')),
    "two loaders means two fetches and two caches to invalidate");
  guard("⚠️ a second caller while a fetch is in flight QUEUES, it does not re-fetch",
    function (h) { const f = fn(h, '_destAllRows'); return /if \(_destRowsWaiting\) \{ _destRowsWaiting\.push/.test(f) && /settle\('ok', _destPivotRows\)/.test(f); },
    'if (_destRowsWaiting) { _destRowsWaiting.push({ ok: cb, err: onErr }); return; }', '');
  check("...and a failed load reaches every waiting caller",
    /settle\('err', err\)/.test(fn(HTML, '_destAllRows')), "");
  check("the shared list is still dropped after a 区分 correction",
    /_destPivotRows = null/.test(js(HTML)),
    "a corrected row must not linger in a later search result");

  // ---- matching ----
  const body = fn(HTML, 'destSearchNow');
  check("matching goes through normName on BOTH sides", /normName\(asked\)/.test(body) && /normName\(f\)/.test(body),
    "a full-width space would hide a student who plainly exists");
  check("...over name, ニックネーム and 学籍番号", /\[r\.name, r\.nick, r\.sid\]/.test(body), "");
  check("...each field on its own, so no match spans two of them",
    /some\(function \(f\)/.test(body) && body.indexOf('const hay') === -1, "");
  // ⚠️ nick shows in no column; it is carried purely so the search can match it.
  check("getDestinationDetail carries nick for exactly that reason",
    /nick: at\(r, nickIdx\),/.test(CODE), "");

  // ---- the endpoint is gone, both halves ----
  check("⚠️ searchGraduates no longer exists on the server", CODE.indexOf('function searchGraduates(') === -1,
    "two matchers for one question is the second-copy shape this codebase keeps being bitten by");
  check("...and its registry line went with it", CODE.indexOf('searchGraduates:') === -1,
    "a stale registry entry throws a ReferenceError that takes down EVERY endpoint");
  check("...and no client call site survives", js(HTML).indexOf('searchGraduates') === -1, "");
}

console.log("\n5. the summary table's markup is UNCHANGED");
{
  // ⚠️ tests/desttable.test.js transcribes these byte for byte, because invalid table markup
  // still renders — an earlier version emitted `<td>0</td>0 0%</td>` and the parser
  // foster-parented the orphan text out of the table. The retouch stays out of destRender.
  const f = fn(HTML, 'destRender');
  check("cellOpen still emits an OPENING td the caller closes",
    f.indexOf("return '<td' + (extra || '') + '>';") !== -1, "");
  check("the dotted-underline drill-down cell is untouched",
    f.indexOf("' style=\"cursor:pointer; text-decoration:underline dotted;\"'") !== -1, "");
  // withPct is module-level since C7 (2026-09-28): _destWithPct, shared with destRenderPivot.
  check("_destWithPct still appends the percentage span, and both renderers call it",
    /font-size:11px;">' \+ p \+ '%<\/span>/.test(fn(HTML, '_destWithPct')) &&
    /_destWithPct\(row\.counts\[c\] \|\| 0, row\.pct\[c\]\)/.test(f) &&
    /_destWithPct\(r\.counts\[c\] \|\| 0, r\.pct\[c\]\)/.test(fn(HTML, 'destRenderPivot')) &&
    !/const withPct = /.test(HTML), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
