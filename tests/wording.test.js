// Nothing a user sees names an internal thing.
//
// The ~10–20 daily users are teachers and admissions staff, not maintainers.
// 「Central_DB のヘッダー名と「寮」列を確認してください」 tells them nothing they can act
// on — it names a spreadsheet tab and a column they have never heard of.
//
// ⚠️ Messages produced in Code.js count as "on screen". They are thrown to the
// client and shown by showError/alert; the file they live in is irrelevant.
//
// ⚠️ HOW TO ADD TO THIS FILE. When it fails, the fix is almost always to reword the
// message in the vocabulary already on screen (学生一覧, 寮管理, 部屋一覧) — NOT to add
// it to ALLOWED. Add to ALLOWED only for a function that no ordinary user can reach:
// an editor-run diagnostic, a migration, a backfill. Every entry is a promise that
// someone checked who calls it.
//
// The second half keeps the error-code table honest. Codes replace the "go and edit
// X" instructions that were dropped, so a code with no table row is a dead end, and
// a table row with no code is rot — the same failure the domrefs allowlist had.

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(root, 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const REF  = fs.readFileSync(path.join(root, 'TECHNICAL_REFERENCE.md'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// Tab names come from CLAUDE.md's Sheets list; the rest are internal vocabulary
// that leaked into messages.
const BANNED = new RegExp(
  '(Central_DB|Past_DB|Room_Info|Building_Info|Schedule_DB|Dorm_Aliases|Teacher_Master' +
  '|Interview_Results|PlacementTest_Config|Enrollment_\\w+|Activity_Log|Simulation_DB' +
  '|Destination_\\w+|Recruitment_\\w+|スナップショット|データ安全性パネル|データベース)');
const JP = /[ぁ-んァ-ン一-龯]/;

// ⚠️ Reached only by the maintainer, from the Apps Script editor. Each is the NAME
// OF A FUNCTION, not a message — so rewording a user-facing string cannot
// accidentally satisfy an entry here.
const ALLOWED = {
  authEnforceStatus: "editor-run auth diagnostic; prints tab names on purpose",
  diagnoseDestinations: "editor-run diagnostic for the 決定進路 sync",
  diagnoseLastYearCounts: "editor-run diagnostic for the 前年 figures",
  profileRecruitMeta: "editor-run timing of the 国名 delete; names the sheets it times, on purpose",
  migrateBuildingAddBurnablePlastic: "one-off column migration, run from the editor",
  backfillEnrollmentHistory: "one-off backfill, run from the editor",
  // ⚠️ The restore prompt asks the user to TYPE the sheet name to confirm. The
  // string being technical is what makes a destructive overwrite hard to do by
  // accident — softening it would weaken the guard, not the wording.
  restoreSnapshotConfirm: "typed-confirmation gate; the sheet name IS the safety",
};

// Which function a source offset sits in — so an offender can be judged against
// ALLOWED rather than banned outright.
function enclosingFn(src, at) {
  const before = src.slice(0, at);
  const m = before.match(/(?:^|\n)\s{0,6}function\s+(\w+)\s*\(/g);
  if (!m) return "(top level)";
  const last = m[m.length - 1].match(/function\s+(\w+)/);
  return last ? last[1] : "(top level)";
}

function offenders(src, label) {
  const out = [];
  const lines = src.split('\n');
  let offset = 0;
  lines.forEach(function (line, i) {
    const at = offset;
    offset += line.length + 1;
    // ⚠️ TRAILING comments too, not just whole-line ones. A note like
    // `// 学期 (from PlacementTest_Config dropdown)` sitting after real code is
    // invisible to the user and read as an offender by a whole-line check.
    const st = line.replace(/\/\/.*$/, '').trim();
    if (!st || line.trim().startsWith('*') || line.trim().startsWith('<!--')) return;
    if (!BANNED.test(st) || !JP.test(st)) return;
    // ⚠️ The 操作履歴 target column names the REAL sheet on purpose: it is an audit
    // trail, only admin-level users can read it, and "部屋データ" would be worse for
    // working out what actually changed.
    if (/_logActivity_\(/.test(st)) return;
    // the banned token has to sit inside a quoted string or element text, not in
    // a getSheetByName call or an identifier
    if (!new RegExp('["`\'>][^"`\'<]*' + BANNED.source).test(st)) return;
    const fn = enclosingFn(src, at);
    if (ALLOWED[fn]) return;
    out.push(label + ":" + (i + 1) + "  [" + fn + "]  " + st.slice(0, 80));
  });
  return out;
}

console.log("\n1. no internal name reaches the screen");
{
  const bad = offenders(CODE, 'Code.js').concat(offenders(HTML, 'Index.html'));
  check("no user-facing message names a tab, column or internal concept",
    bad.length === 0,
    bad.length + " found:\n        " + bad.join("\n        ") +
    "\n        Reword in the vocabulary already on screen — do not add to ALLOWED " +
    "unless no ordinary user can reach the function.");

  // ⚠️ The scan is only worth anything if it can still see an offender. Without
  // this, a broken regex reads as a clean sweep.
  const canary = 'if (!x) throw new Error("Central_DB が見つかりません。");';
  check("the scan still detects a planted offender",
    offenders(canary, 'canary').length === 1, "the scan has stopped working");
  check("...and ignores the same text in a comment",
    offenders('// Central_DB が見つかりません', 'canary').length === 0, "");
}

console.log("\n2. the rename");
{
  const chip = HTML.slice(HTML.indexOf('function _dormSyncChipHtml'),
                          HTML.indexOf('function _dormSyncChipHtml') + 1200);
  check("the chip reads 最終更新",
    /'⚠️ 最終更新' : '最終更新'/.test(chip) && !/最終同期/.test(HTML),
    "最終同期 was the internal word for it");
}

console.log("\n3. every code has a row, and every row has a code");
{
  // ⚠️ Anchored to the known areas. A bare [A-Z]+-\d\d also matches SHA-256.
  const RE = /\b(DORM|SCHED|STU|REC|USER|SYS)-\d{2}\b/g;
  const emitted = new Set((CODE.match(RE) || []).concat(HTML.match(RE) || []));
  const rows = new Set((REF.match(/^\|\s*((?:DORM|SCHED|STU|REC|USER|SYS)-\d{2})\s*\|/gm) || [])
    .map(function (r) { return r.replace(/[|\s]/g, ''); }));

  check("codes are emitted at all", emitted.size >= 10, "found " + emitted.size);
  check("the reference table has rows", rows.size >= 10, "found " + rows.size);

  const orphanCodes = [...emitted].filter(function (c) { return !rows.has(c); });
  check("every emitted code has a table row", orphanCodes.length === 0,
    "no row for: " + orphanCodes.join(", ") + " — a code with no lookup is a dead end");

  const orphanRows = [...rows].filter(function (c) { return !emitted.has(c); });
  check("every table row is actually emitted", orphanRows.length === 0,
    "never emitted: " + orphanRows.join(", ") + " — the table rots exactly like the " +
    "domrefs allowlist did");

  // ⚠️ Append-only means a code may never appear twice meaning two things.
  const dupes = [...rows].filter(function (c) {
    return (REF.match(new RegExp('^\\|\\s*' + c + '\\s*\\|', 'gm') ) || []).length > 1;
  });
  check("no code is listed twice", dupes.length === 0, dupes.join(", "));
}

console.log("\n4. codes go where a user cannot act — and nowhere else");
{
  // ⚠️ The split is the whole value. If a code appeared on 「先に取り下げてください」
  // it would stop meaning "call the maintainer" and start meaning "the app is
  // broken", which is how staff learn to ignore them.
  const ACTIONABLE = [
    'のリクエストが出ています',      // one active request per booking
    '予約済みの面接のみ再依頼できます',
    '取り下げるリクエストがありません',
    '権限がありません',
  ];
  const CODE_RE = /（(?:DORM|SCHED|STU|REC|USER|SYS)-\d{2}）/;
  ACTIONABLE.forEach(function (msg) {
    const at = CODE.indexOf(msg);
    if (at === -1) { check("'" + msg.slice(0, 14) + "' still exists", false, "message gone"); return; }
    const line = CODE.slice(CODE.lastIndexOf('\n', at) + 1, CODE.indexOf('\n', at));
    check("no code on '" + msg.slice(0, 14) + "…' — the user can act on it",
      !CODE_RE.test(line), "a code here reads as 'the app is broken'");
  });
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
