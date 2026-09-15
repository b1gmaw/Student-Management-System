// Every value that reaches innerHTML must be escaped, or be on the list below.
//
// The app builds ~116 HTML fragments by interpolating into template literals and
// assigning them to innerHTML. escHtmlJs/escAttrJs have existed for a long time
// and were used at most sites — but around 30 interpolations carried sheet data
// straight through, including the student table (${cell}), the 詳細 modal, the
// live report, the ユーザー管理 table, the building header and the interview
// calendar.
//
// What that is worth to an attacker: Apps Script serves this page as-is inside
// its iframe, so an injected `<img src=x onerror=…>` runs in the victim's own
// document, where currentUser, apiRun() and the session token in localStorage all
// live. No network egress is needed — calling apiRun() as the victim IS the
// attack. A holder of an ordinary permission like edit_dorms could name a
// building `<img src=x onerror="…">` and have it execute in the master's browser
// the next time they opened 部屋一覧.
//
// ⚠️ HOW TO ADD TO THIS FILE. When it fails, the fix is almost always to wrap the
// expression in escHtmlJs (text), escAttrJs (attribute) or escAttrJsStr (a JS
// string literal inside an attribute) — NOT to add it to SAFE. Add to SAFE only
// when the value provably cannot carry data: a loop index, a class name your own
// code chose, a ternary between two literals. Every entry is a promise that
// someone checked.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// The application code is the SECOND script block (CLAUDE.md, Files).
const BLOCKS = HTML.match(/<script>[\s\S]*?<\/script>/g) || [];
const CODE = (BLOCKS[1] || "")
  .replace(/\/\/[^\n]*/g, '')          // comments legitimately contain markup
  .replace(/\/\*[\s\S]*?\*\//g, '');

const ESCAPERS = ['escHtmlJs', 'escAttrJs', 'escAttrJsStr', '_safeHref'];

// Expressions that are NOT data. Each one was read and judged; see the warning
// above before extending it.
const SAFE = [
  // loop counters and positions, arithmetic on them
  'i', 'idx', 'index', 'n', 'i+1', 'ci', 'gi', 'ai', 'd', 'p', 't',
  'actualColIdx', 'sheetRow', 'nc + 1', 'g.span', 'rowIndex',
  // counts and totals — numbers computed here, never strings from a sheet
  'occupied', 'vacant', 'docCount', 'rooms.length', 'orphanRooms.length',
  'calTeachers.length', 'groups.length', 'totalGrand', 'grand', 'intakeSub',
  'proj', 'groupColTotals[gi]', 'intakeColTotals[ai].courses[ci]',
  'intakeColTotals[ai].sub', 'fmt(bldgRent)',
  // class names and inline styles this file chose
  'cls', 'cellClass', 'bl', 'align', 'accent', 'icon', 'ownColBg', 'cursorStyle',
  'linkArea', 'clickable', 'colLabel', 'key', 'type', 'h',
  // fragments already built and escaped above their use site
  'docChipHtml', 'addRoomBtnHtml', 'bulkPdfBtnHtml', 'editBtnHtml', 'bIdAttr',
  // renderDormSyncReport: each room label went through escHtmlJs on the line above
  'roomListHtml',
  // _dormSyncChipHtml: a ternary between two literals, and a coerced number
  'syncChipLabel', 'Number(rep.updated) || 0',
  // renderPastInterviewsTable: irCls() is a ternary between the literal
  // ' class="ir-sec"' and ''. Its argument is a loop index, and no sheet value
  // reaches the return — the header text is only ever compared, never emitted.
  'irCls(index)', 'irCls(ci)',
  'tenant', 'meta', 'title', 'whoLine', 'detail', 'days[d]',
  'formatDateDisplay(weekDates[d])',
  // A lookup into a fixed map of CSS colour literals; an unknown status falls
  // through to 'inherit' rather than to the status string itself.
  "pwColour[st] || 'inherit'",

  // ---- section 3 (concatenated markup) -------------------------------------
  // Each of these was read at its call site. They fall into three groups.
  //
  // Counts and percentages — numbers this file computed, never sheet strings:
  'pro', 'total', 'gRecruited', 'rowTotal', 'row.known', 'row.unentered',
  'row.rows', 'r.known', 'r.unentered', 'lyNum', 'n', 'p',
  // 性別集計: a reduce() over the per-gender counts, so an integer by construction.
  'sum',
  // 定員・残枠's total row: accumulators summed from numbers this file computed,
  // and tls is a literal style ternary.
  'tPro', 'tVis', 'tTotal', 'tls',
  // 性別集計's three header rows, assembled from escHtmlJs'd labels just above.
  'h1', 'h2', 'h3',
  // 年度別月間在籍者数: the accumulated year-block markup, built above from escaped parts.
  'html',
  // The PDF export's own builder: `tag` is 'th' or 'td', `body` is the rows it
  // has already escaped with its local esc().
  'tag', 'body',
  // 増減推移: getEnrollmentHistory parses these with parseInt and skips the row on
  // NaN, so they are integers by the time they reach here. `net` and `dash` are
  // markup this file built from them.
  'r.total', 'r.joined', 'net', 'dash',
  // Markup fragments assembled just above their use, escaped where they were
  // built. `who` is escHtmlJs(student) + escHtmlJs(teacherName); `subCells` and
  // `gStaff` are <td> runs; `foot` is a <tfoot> body; `ls` and `style` are
  // literal inline styles:
  'who', 'foot', 'ls', 'style', 'gq', 'gStaff', 'subCells', 'delNat', 'rowCls',
  // Helpers that escape internally — checked: numCell() wraps escHtmlJs(co),
  // cellOpen() wraps escAttrJs(cohort)/escAttrJs(cat), td() emits a bare <td>,
  // and the .map() calls iterate over literal header arrays:
  'numCell()', 'cellOpen()', 'td()', 'withPct()', 'rows.map()', 'list.map()',
  // The 3-argument row() helper in アカウント: every caller passes esc(...).
  'row()', 'k', 'v',
  // _expPdf's local esc(), and the .map()s around it, which call it per cell.
  //
  // ⚠️ There are THREE `const esc` in this file and they are NOT the same
  // function. 3631 and 8950 escape HTML; 8890 does CSV quoting — it doubles the
  // double-quote and leaves < alone. Each is declared inside the function that
  // uses it, so scope keeps them apart, but moving a block of markup-building
  // code near the CSV one would silently swap an HTML escaper for a quoting
  // routine and this list would still say "safe". Check the nearest declaration,
  // not the name.
  'esc()', 'rows[0].map()', 'rows.slice()', 'r.map()',
  'extra[0].map()', 'extra.slice()'
];

// A ternary whose branches are both string literals is a literal, however long.
function isLiteralTernary(e) {
  return /^[^?]{1,80}\?\s*(['"])(?:(?!\1)[\s\S])*\1\s*:\s*(['"])(?:(?!\2)[\s\S])*\2$/.test(e.trim());
}
function isSafe(e) {
  const t = e.trim();
  if (t === '') return true;
  if (ESCAPERS.some(function (f) { return t.indexOf(f + '(') !== -1; })) return true;
  if (SAFE.indexOf(t) !== -1) return true;
  if (isLiteralTernary(t)) return true;
  if (/^[\d\s+\-*/().]+$/.test(t)) return true;              // pure arithmetic
  if (/^\w+\(\)\s*\?\s*(['"]).*\1\s*:\s*(['"]).*\2$/.test(t)) return true;  // simCanEdit() ? '' : 'disabled'
  return false;
}

// Template literals that build markup. Backtick-delimited, escapes honoured.
const LITERALS = (CODE.match(/`(?:[^`\\]|\\[\s\S])*`/g) || [])
  .filter(function (l) { return /<[a-zA-Z/!]/.test(l); });

console.log("\n1. the scanner is actually looking at something");
{
  check("the second script block was found", CODE.length > 100000,
    "got " + CODE.length + " chars — the block split changed and every check below is vacuous");
  check("markup-building template literals were found", LITERALS.length > 80,
    "found " + LITERALS.length + " — the extraction regex stopped matching, so nothing is being checked");
  const interps = LITERALS.reduce(function (a, l) { return a + (l.match(/\$\{/g) || []).length; }, 0);
  check("they contain interpolations", interps > 150, "found " + interps);
  check("the escapers still exist",
    /function escHtmlJs\(/.test(CODE) && /function escAttrJs\(/.test(CODE) &&
    /function escAttrJsStr\(/.test(CODE) && /function _safeHref\(/.test(CODE),
    "a helper was renamed — every isSafe() call silently starts returning false");
}

console.log("\n2. no unescaped interpolation reaches innerHTML");
{
  let bad = [];
  LITERALS.forEach(function (lit) {
    let m;
    const re = /\$\{([^{}]*)\}/g;
    while ((m = re.exec(lit)) !== null) {
      if (!isSafe(m[1])) {
        const at = HTML.indexOf(lit);
        const line = at === -1 ? '?' : HTML.slice(0, at).split('\n').length;
        bad.push('~' + line + ': ${' + m[1].trim().slice(0, 70) + '}');
      }
    }
  });
  check("every interpolation is escaped or listed as safe", bad.length === 0,
    bad.length + " unescaped:\n        " + bad.slice(0, 25).join("\n        ") +
    "\n        Wrap in escHtmlJs / escAttrJs / escAttrJsStr — do not add to SAFE unless " +
    "the value provably cannot carry sheet data.");
}

console.log("\n3. the string-concatenation form is covered too");
{
  // `"<td>" + x + "</td>"` bypasses section 2 entirely — a different syntax for
  // the same sink, and the older half of the file is written this way.
  let bad = [];
  // ⚠️ Capture the trailing "(" as well. Without it the match for
  // `"<td>" + escHtmlJs(x)` is the bare name `escHtmlJs`, which isSafe does not
  // recognise — so every correctly-escaped site was reported as a finding and
  // the real ones were buried among them.
  const re = /(["'])[^"']*<[^"']*\1\s*\+\s*([A-Za-z_$][\w.$\[\]]*\(?)/g;
  let m;
  while ((m = re.exec(CODE)) !== null) {
    const expr = m[2].slice(-1) === '(' ? m[2] + ')' : m[2];
    if (!isSafe(expr)) {
      const line = CODE.slice(0, m.index).split('\n').length;
      bad.push('block-line ' + line + ': + ' + expr);
    }
  }
  check("concatenated markup is escaped too", bad.length === 0,
    bad.length + " unescaped:\n        " + bad.slice(0, 20).join("\n        "));
}

console.log("\n4. the escapers do what their names claim");
{
  // Transcribed from Index.html. If these drift, every call site above is
  // decorated rather than escaped — and nothing else would notice.
  function escHtmlJs(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttrJs(s) { return escHtmlJs(s).replace(/"/g, "&quot;"); }
  function escAttrJsStr(s) {
    return escAttrJs(String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
  }

  check("escHtmlJs neutralises a tag",
    escHtmlJs('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', "");
  check("escHtmlJs escapes & first",
    escHtmlJs('&lt;') === '&amp;lt;',
    "escaping & after < would turn &lt; back into a real < when the browser decodes it");
  check("escHtmlJs handles null and undefined",
    escHtmlJs(null) === "" && escHtmlJs(undefined) === "", "");
  check("escAttrJs closes the double-quoted attribute break",
    escAttrJs('" onmouseover="alert(1)').indexOf('"') === -1, "");

  // ⚠️ The reason escAttrJsStr exists. Three call sites used to carry an inline
  // .replace(/'/g,"\\'") — which a trailing backslash defeats, because the
  // backslash escapes the quote the replace just added and the string reopens.
  check("escAttrJsStr survives a trailing backslash",
    escAttrJsStr("a\\") === "a\\\\",
    "a lone backslash must double, or it escapes the quote that follows it");
  check("escAttrJsStr closes the JS string break",
    escAttrJsStr("');alert(1);//") === "\\&#39;);alert(1);//".replace('&#39;', "'"),
    "got: " + escAttrJsStr("');alert(1);//"));
  check("escAttrJsStr still escapes markup",
    escAttrJsStr('<b>').indexOf('<') === -1, "");

  // _safeHref — an href is the one attribute where escaping alone is not enough.
  function _safeHref(u) {
    const s = String(u == null ? "" : u).trim();
    const probe = s.replace(/[\x00-\x20]/g, "").replace(/&#[^;]{0,8};/g, "").toLowerCase();
    if (/^(https?:|mailto:)/.test(probe)) return s;
    if (probe !== "" && !/^[a-z][a-z0-9+.\-]*:/.test(probe)) return s;
    return "#";
  }
  check("_safeHref keeps a normal meeting link",
    _safeHref("https://meet.google.com/abc-defg-hij") === "https://meet.google.com/abc-defg-hij", "");
  check("_safeHref keeps a relative path", _safeHref("/foo/bar") === "/foo/bar", "");
  check("_safeHref rejects javascript:", _safeHref("javascript:alert(1)") === "#", "");
  check("_safeHref rejects it with padding",
    _safeHref("  JaVaScRiPt:alert(1)") === "#", "case and leading space are not a defence");
  check("_safeHref rejects it split by a control character",
    _safeHref("java\tscript:alert(1)") === "#" && _safeHref("java\nscript:alert(1)") === "#",
    "browsers strip these before reading the scheme, so the check must too");
  check("_safeHref rejects an entity-encoded control character",
    _safeHref("java&#09;script:alert(1)") === "#", "");
  check("_safeHref rejects data: URLs", _safeHref("data:text/html,<script>alert(1)</script>") === "#", "");
}

console.log("\n5. the sinks that actually carry sheet data are escaped, by name");
{
  // Section 2 is a shape check and would pass if a renderer were deleted. These
  // name the specific places the audit found, so a regression is reported as
  // itself rather than as a count.
  const SITES = [
    ['the 在籍学生 table body', /<td class="\$\{cellClass\}">\$\{escHtmlJs\(cell\)\}<\/td>/],
    ['the 在籍学生 table headers', /sortSpecificTable\(\$\{index\}[^`]*\$\{escHtmlJs\(header\)\}/],
    // Fed by the 在籍学生 rows above, and separately by 面接結果.
    ['the 詳細 modal', /detail-value">\$\{escHtmlJs\(rowData\[index\] \|\| '-'\)\}/],
    ['the interview results headers', /sortInterviewsTable\(\$\{index\}\)">\$\{escHtmlJs\(header\)\}/],
    ['the live report body', /classes\.join\(' '\)}"` : ''}>\$\{escHtmlJs\(cell\)\}<\/td>/],
    // view-users, its own top-level tab — not アカウント設定, which is a
    // different view and renders the signed-in user's own profile.
    // Re-audited when the list was rebuilt (name first, ID and email beneath it, badges).
    ['the ユーザー管理 table', /<div class='u-nm'>\$\{escHtmlJs\(u\.name\)\}<\/div>/],
    ['the ユーザー管理 email column', /u\.email \? ' · ' \+ escHtmlJs\(u\.email\) : ''/],
    ['the ユーザー管理 id', /<div class='u-sub'>\$\{escHtmlJs\(u\.id\)\}/],
    ['the ユーザー管理 role', /<td>\$\{escHtmlJs\(displayRole\)\}/],
    ['the ユーザー管理 last-seen date', /最終操作 " \+ escHtmlJs\(String\(ses\.lastSeen/],
    ['the building header', /<h3[^`]*\$\{escHtmlJs\(displayName\)\}/],
    ['the building id button arguments', /openEditBldgModal\(event, '\$\{bIdAttr\}'\)/],
    ['the room list', /<div class="rr-num">\$\{escHtmlJs\(room\.roomNumber\)\}<\/div>/],
    ['the calendar teacher column', /title="\$\{escAttrJs\(calTeachers\[t\]\.name\)\}"/],
    ['the calendar slot tooltip', /title="\$\{escAttrJs\(calTeachers\[t\]\.name\)\} \/ \$\{escAttrJs\(periods\[p\]\)\}/],
    ['the student filter values', /value="\$\{escAttrJs\(v\)\}"/],
    ['the simulation country column', /sticky-col[^`]*\$\{escHtmlJs\(country\)\}/],
    ['the meeting link', /href="\$\{escAttrJs\(_safeHref\(cLink\)\)\}"/]
  ];
  SITES.forEach(function (s) {
    check(s[0] + " is escaped", s[1].test(HTML),
      "the escaping was removed, or the renderer was rewritten — re-audit it");
  });

  // ⚠️ The ad-hoc quote escaping this replaced must not come back. It handled the
  // apostrophe and nothing else, and reads like a fix.
  // escAttrJsStr's own body legitimately contains the replace — that IS the
  // escaper. Everywhere else it is a hand-rolled stand-in for it, and once the
  // real one wraps the same value it also double-escapes, so the user sees \' .
  const escBody = CODE.slice(CODE.indexOf('function escAttrJsStr'),
                             CODE.indexOf('function _safeHref'));
  const elsewhere = CODE.replace(escBody, '');
  check("no inline .replace(/'/g,...) is left standing in for an escaper",
    !/\.replace\(\/'\/g\s*,\s*["']\\\\'["']\)/.test(elsewhere),
    "use escAttrJsStr — the inline version misses backslashes and markup, " +
    "and layering both produces a visible backslash");
  check("the exclusion above found escAttrJsStr's real body",
    escBody.indexOf("replace(/'/g") !== -1,
    "the anchor moved, so the check is now scanning the whole file and will " +
    "report the escaper itself — or worse, was excluding something else");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
