// Dorm auto-assign: which rooms get written, which get VACATED — and when the
// vacates are refused outright.
//
// The sync used to ask 空室のみ / 全部屋を上書き in a modal, with 割当テスト beside it
// to preview the answer. Both are gone: the scope was a global wrapper over a
// decision the loop already makes room by room, and the sync now runs nightly from
// triggerAutoSyncStudents with nobody pressing anything.
//
// ⚠️ That is exactly why the sanity gate exists. "No match" is ambiguous — the
// student moved out, OR their 寮 string does not resolve to this building (an alias
// gap). Rename Central_DB's 寮 header and EVERY occupied room becomes "no match", so
// the old code emptied the dorms and returned 「成功！」 (the diagnostic path that
// would have caught it only runs when updateCount === 0, and the vacates make
// updateCount large). Survivable when a human had to choose 全部屋を上書き and click
// through a confirm. Unattended and nightly, it is a silent wipe.
//
// So the blast radius has to be exactly right: never for a room that matched, never
// for a room that was already empty, and never at all when the INPUT SHAPE says the
// match failed rather than the tenants left.

const fs = require('fs');
const path = require('path');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}
function bodyOf(src, sig, endAt) {
  const at = src.indexOf(sig);
  if (at === -1) return '';
  const end = endAt ? src.indexOf(endAt, at + sig.length) : src.indexOf('\nfunction ', at + sig.length);
  return src.slice(at, end === -1 ? src.length : end);
}
// ⚠️ Comments stripped before any ordering check: a comment naming the thing being
// looked for satisfies the search without the code doing anything.
function stripComments(s) { return s.replace(/\/\/[^\n]*/g, ''); }

// ---- transcribed ------------------------------------------------------------
// Room_Info columns touched by the sync.
const R = { status: 7, studentId: 9, studentName: 10, nat: 11, cls: 12 };
// Mirrors the constants in Code.js.
const DORM_VACATE_MAX_RATIO = 0.3;
const DORM_VACATE_MIN = 5;

function room(status, studentId, studentName) {
  const r = new Array(21).fill("");
  r[R.status] = status;
  r[R.studentId] = studentId || "";
  r[R.studentName] = studentName || "";
  r[R.nat] = studentName ? "Nepal" : "";
  r[R.cls] = studentName ? "A1" : "";
  return r;
}
function isVacantRow(r) {
  return String(r[R.status] || "") === "空室" || String(r[R.studentId] || "") === "";
}

// Mirrors the per-room decision. No mode: every room is in scope.
function decide(r, hasMatch) {
  const isVacant = isVacantRow(r);
  if (hasMatch) return isVacant ? "assigned" : "overwritten";
  if (!isVacant) return "pendingVacate";
  return "untouched";
}

function applyVacate(r) {
  const out = r.slice();
  out[R.status] = "空室";
  out[R.studentId] = "";
  out[R.studentName] = "";
  out[R.nat] = "";
  out[R.cls] = "";
  return out;
}
function applyAssign(r) {
  const out = r.slice();
  out[R.status] = "入居中";
  out[R.studentId] = "999";
  out[R.studentName] = "Matched";
  out[R.nat] = "Nepal";
  out[R.cls] = "B2";
  return out;
}

// The whole run: match, collect, gate, then apply.
// opts: { dormIdx, idIdx, studentCount } — the input-shape signals.
function simulate(rows, opts) {
  opts = opts || {};
  const dormIdx = opts.dormIdx === undefined ? 3 : opts.dormIdx;
  const idIdx = opts.idIdx === undefined ? 1 : opts.idIdx;
  const studentCount = opts.studentCount === undefined ? 10 : opts.studentCount;

  let gateReason = "";
  if (dormIdx === -1) gateReason = "Central_DB に「寮」列が見つかりません";
  else if (idIdx === -1) gateReason = "Central_DB に「学籍番号」列が見つかりません";
  else if (studentCount === 0) gateReason = "寮の記入がある学生が 0 名です";

  const occupiedTotal = rows.filter(function (x) { return !isVacantRow(x.r); }).length;
  const vacateCap = Math.max(DORM_VACATE_MIN, Math.floor(occupiedTotal * DORM_VACATE_MAX_RATIO));

  let assigned = 0, overwritten = 0, pending = [];
  const out = rows.map(function (x) { return x.r.slice(); });
  rows.forEach(function (x, i) {
    const d = decide(x.r, x.match);
    if (d === "assigned") { assigned++; out[i] = applyAssign(x.r); }
    else if (d === "overwritten") { overwritten++; out[i] = applyAssign(x.r); }
    else if (d === "pendingVacate") { pending.push(i); }
  });

  // ⚠️ The count arm is LAST, so a missing header explains the count rather than
  // being reported as one — otherwise someone goes hunting for move-outs that
  // never happened.
  if (!gateReason && pending.length > vacateCap) {
    gateReason = "空室化の対象が多すぎます（" + pending.length + "室 / 上限 " + vacateCap + "室）";
  }

  let vacated = 0;
  if (!gateReason) {
    pending.forEach(function (i) { out[i] = applyVacate(out[i]); vacated++; });
  }
  return {
    gate: gateReason, assigned: assigned, overwritten: overwritten, vacated: vacated,
    held: gateReason ? pending.length : 0, updateCount: assigned + overwritten + vacated,
    cap: vacateCap, out: out
  };
}

const EMPTY    = room("空室", "", "");
const OCCUPIED = room("入居中", "202507001", "Aarav");
// Status says occupied but nobody is recorded — treated as vacant, because the
// tenant id is what actually matters.
const GHOST    = room("入居中", "", "");

console.log("\n1. one scope, decided per room");
{
  check("empty + match -> assigned", decide(EMPTY, true) === "assigned", decide(EMPTY, true));
  check("empty + no match -> untouched", decide(EMPTY, false) === "untouched", decide(EMPTY, false));
  check("occupied + match -> overwritten (refreshed)",
    decide(OCCUPIED, true) === "overwritten", decide(OCCUPIED, true));
  check("occupied + NO match -> a vacate CANDIDATE",
    decide(OCCUPIED, false) === "pendingVacate", decide(OCCUPIED, false));

  // ⚠️ An already-empty room with no match must not be counted as a vacate, or the
  // reported figure is inflated by every unused room in the school.
  check("empty + no match is never a vacate", decide(EMPTY, false) !== "pendingVacate", "");
  check("a matched occupied room is never a vacate", decide(OCCUPIED, true) !== "pendingVacate", "");
  check("occupied-but-nobody-recorded counts as vacant",
    decide(GHOST, false) === "untouched", decide(GHOST, false));
  // No room is skipped for being occupied any more — that was the mode.
  check("no room is out of scope", ["assigned", "overwritten", "pendingVacate", "untouched"]
    .indexOf(decide(OCCUPIED, false)) !== -1, "");
}

console.log("\n2. ⚠️ the sanity gate holds the vacates and KEEPS the assignments");
{
  // A dorm where everything looks like a move-out, which is what a broken header
  // produces: 20 occupied rooms, none matching, plus 2 real assignments.
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ r: room("入居中", "S" + i, "Name" + i), match: false });
  rows.push({ r: EMPTY, match: true });
  rows.push({ r: EMPTY, match: true });

  [['寮 header missing', { dormIdx: -1 }],
   ['学籍番号 header missing', { idIdx: -1 }],
   ['zero students with a dorm', { studentCount: 0 }],
   ['too many vacates at once', {}]
  ].forEach(function (c) {
    const res = simulate(rows, c[1]);
    check(c[0] + " -> the gate fires", !!res.gate, "nothing stopped a whole-dorm wipe");
    check("  ...no room is vacated", res.vacated === 0, "vacated " + res.vacated);
    // ⚠️ THE POINT. A gate that also skipped the assignments would turn a header
    // typo into "the sync silently does nothing", which is its own outage.
    check("  ...but both assignments still happen", res.assigned === 2, "assigned " + res.assigned);
    check("  ...and it reports how many it held", res.held === 20, "held " + res.held);
  });

  // ⚠️ Precedence: a missing header must be reported as a missing header, not as
  // "too many rooms" — the count is a symptom of it.
  const hdr = simulate(rows, { dormIdx: -1 });
  check("a missing header outranks the count in the reason",
    hdr.gate.indexOf("寮") !== -1 && hdr.gate.indexOf("多すぎ") === -1, hdr.gate);
}

console.log("\n3. the gate does not block ordinary move-outs");
{
  // Four occupied rooms, two genuinely empty out. Without the floor the cap would
  // be floor(4 * 0.3) = 1 and this everyday case would be refused forever.
  const rows = [
    { r: room("入居中", "S1", "A"), match: false },
    { r: room("入居中", "S2", "B"), match: false },
    { r: room("入居中", "S3", "C"), match: true  },
    { r: room("入居中", "S4", "D"), match: true  }
  ];
  const res = simulate(rows, {});
  check("the floor keeps a small building workable", res.cap === DORM_VACATE_MIN,
    "cap was " + res.cap + "; floor(4*0.3)=1 would refuse two real move-outs");
  check("both move-outs are applied", res.vacated === 2, "vacated " + res.vacated);
  check("no gate", !res.gate, res.gate);
  check("the matched rooms were refreshed, not emptied", res.overwritten === 2, "");
  check("...and are still occupied", res.out[2][R.status] === "入居中", res.out[2][R.status]);

  // A big dorm losing a normal number of tenants is fine too.
  const big = [];
  for (let i = 0; i < 50; i++) big.push({ r: room("入居中", "S" + i, "N" + i), match: i >= 6 });
  const rb = simulate(big, {});
  check("50 occupied, 6 move-outs -> applied", rb.vacated === 6 && !rb.gate,
    "cap " + rb.cap + " gate " + rb.gate);
}

console.log("\n4. what a vacate actually writes");
{
  const before = room("入居中", "202507001", "Aarav");
  const after = applyVacate(before);
  check("status becomes 空室", after[R.status] === "空室", after[R.status]);
  check("student id cleared", after[R.studentId] === "", JSON.stringify(after[R.studentId]));
  check("student name cleared", after[R.studentName] === "", JSON.stringify(after[R.studentName]));
  check("nationality cleared", after[R.nat] === "", JSON.stringify(after[R.nat]));
  check("class cleared", after[R.cls] === "", JSON.stringify(after[R.cls]));

  // Everything else on the row belongs to the ROOM, not the tenant — rent, wifi,
  // mailbox code, bill overrides. Wiping those would be a different and much
  // worse bug than clearing an occupant.
  let clobbered = [];
  for (let i = 0; i < before.length; i++) {
    if ([R.status, R.studentId, R.studentName, R.nat, R.cls].indexOf(i) !== -1) continue;
    if (before[i] !== after[i]) clobbered.push(i);
  }
  check("no other column is touched", clobbered.length === 0,
    "vacate also changed column(s) " + clobbered.join(",") + " — those are room properties, not tenant data");
  check("vacating is idempotent", applyVacate(after)[R.status] === "空室", "second pass changed it");
}

console.log("\n5. counting, and the snapshot that depends on it");
{
  const rows = [
    { r: EMPTY,    match: true  },   // assigned
    { r: EMPTY,    match: false },   // untouched
    { r: OCCUPIED, match: true  },   // overwritten
    { r: OCCUPIED, match: false },   // vacated
    { r: OCCUPIED, match: false }    // vacated
  ];
  const res = simulate(rows, {});
  check("2 vacated", res.vacated === 2, JSON.stringify(res.vacated));
  check("1 overwritten", res.overwritten === 1, String(res.overwritten));
  check("1 assigned", res.assigned === 1, String(res.assigned));
  // ⚠️ updateCount gates the snapshot + write. A run that ONLY vacates must still
  // trigger both, or the change is written with no backup behind it.
  check("vacates count toward updateCount, so the snapshot still happens",
    res.updateCount === 4, String(res.updateCount));

  const onlyVacates = simulate([{ r: OCCUPIED, match: false }], {});
  check("a vacate-only run still reaches the write path",
    onlyVacates.updateCount === 1, String(onlyVacates.updateCount));
}

console.log("\n6. the source agrees — no mode, and the gate is really there");
{
  const body = bodyOf(CODE, 'function syncDormsFromCentralDB');
  const code = stripComments(body);
  check("its body was located", body.length > 3000, "got " + body.length);
  check("the mode parameter is gone",
    /function syncDormsFromCentralDB\(userRole, userPerms, actorName, actorId\)/.test(CODE) &&
    CODE.indexOf('modeAll') === -1,
    "a leftover mode means the scope question is still being asked somewhere");

  check("the gate constants exist",
    /const DORM_VACATE_MAX_RATIO = 0\.3;/.test(CODE) && /const DORM_VACATE_MIN = 5;/.test(CODE), "");
  // ⚠️ Scoped to the GATE BLOCK, not the whole function. `dormIdx === -1` also
  // appears in the diagnostic 'missing headers' list at the bottom, so a
  // function-wide search passed with the gate arm deleted.
  // ⚠️ End anchor is getBuildingIndex, not the room loop: occupiedTotal is itself
  // computed with a `for (let r = 1; r < roomData.length` loop that sits ABOVE
  // gateReason, so anchoring on that produced an empty slice that passed nothing.
  const gateBlock = code.slice(code.indexOf('let gateReason = ""'),
                               code.indexOf('function getBuildingIndex'));
  check("the gate block was located", gateBlock.length > 100 && gateBlock.length < 1200,
    "got " + gateBlock.length + " chars");
  check("the input-shape arms all SET gateReason",
    /if \(dormIdx === -1\) gateReason =/.test(gateBlock) &&
    /if \(idIdx === -1\) gateReason =/.test(gateBlock) &&
    /if \(studentsInDorms\.length === 0\) gateReason =/.test(gateBlock),
    "a signal it cannot see is a wipe it cannot stop");
  check("the cap uses the floor, not the bare ratio",
    /Math\.max\(DORM_VACATE_MIN, Math\.floor\(occupiedTotal \* DORM_VACATE_MAX_RATIO\)\)/.test(code),
    "without the floor a small building can never register a move-out");

  // ⚠️ COLLECTED IN THE LOOP, APPLIED AFTER. Writing in the loop would mean the
  // assignments and the vacates could not be kept and dropped independently, which
  // is the whole mechanism of section 2.
  // ⚠️ Scoped to the BRANCH, and asserting the absence of a write. Checking only
  // that pendingVacate.push exists passed with a roomData write bolted on in front
  // of it — which is the exact bug the gate cannot recover from.
  // Exactly the region between entering the branch and recording the candidate —
  // where a write would have to go to beat the gate.
  const branchStart = code.indexOf('} else if (!isVacant) {');
  const branch = code.slice(branchStart, code.indexOf('pendingVacate.push({', branchStart));
  check("the unmatched branch was located", branchStart !== -1 && branch.length > 10,
    "got " + branch.length + " chars");
  check("the loop collects vacates and writes NOTHING",
    !/roomData\[r\]\[\d+\]\s*=/.test(branch),
    "a vacate written inside the loop is a vacate the gate cannot recall");
  check("...and the write happens after the loop, behind the gate",
    code.indexOf('pendingVacate.push({') < code.indexOf('if (!gateReason) {') &&
    /if \(!gateReason\) \{\s*\n\s*pendingVacate\.forEach/.test(code),
    "a vacate written inside the loop is a vacate the gate cannot recall");
  check("the count arm is evaluated after the input-shape arms",
    code.indexOf('studentsInDorms.length === 0') < code.indexOf('pendingVacate.length > vacateCap'),
    "otherwise a missing header is reported as 'too many rooms'");

  check("every terminal path persists a report",
    (code.match(/_saveDormSyncReport_\(\{/g) || []).length === 3,
    "the empty-data and no-match paths are the runs that most need reporting");  // section 12 checks each
  check("getDormData hands the report to the client",
    /lastSync: .*_readDormSyncReport_\(\)/.test(CODE),
    "the panel has nothing to render without it");  // gating is section 10's job
}

console.log("\n7. it runs itself");
{
  const t = stripComments(bodyOf(CODE, 'function triggerAutoSyncStudents'));
  check("the trigger calls the sync", /syncDormsFromCentralDB\("master", "ALL"/.test(t),
    "this is the whole 'automatic' half of the feature");
  check("...after the student sync",
    t.indexOf('fetchAndMergeStudentData') < t.indexOf('syncDormsFromCentralDB'),
    "it reads Central_DB, so it has to see today's data");
  // ⚠️ Same rule as _recordEnrollmentSnapshot_: the student sync is the important
  // half and must not fail because dorm housekeeping did.
  check("...inside its own try/catch",
    /try \{\s*\n\s*syncDormsFromCentralDB\([^)]*\);\s*\n\s*\} catch/.test(t),
    "an uncaught dorm error would take the nightly student sync down with it");
  check("the enrollment snapshot still runs after both",
    t.indexOf('syncDormsFromCentralDB') < t.indexOf('_recordEnrollmentSnapshot_'), "");
}

console.log("\n8. the two removed controls are gone everywhere");
{
  // ⚠️ Endpoint, registry entry and client caller together (rule 2).
  check("dryRunDormSync is gone from Code.js and the registry",
    CODE.indexOf('dryRunDormSync') === -1, "");
  check("...and from the client", HTML.indexOf('dryRunDormSync') === -1, "");
  ['dormSyncModeModal', 'dormSyncModeChosen', '_dormSyncAction', 'btnDryRunFill',
   'dryRunDorms', 'executeDryRun', 'showDryRunResult'].forEach(function (n) {
    check("  " + n + " is gone from Index.html", HTML.indexOf(n) === -1, "");
  });
  check("自動割当 still exists and still confirms",
    /function autoFillDorms\(\)/.test(HTML) && /if \(!confirm\(/.test(bodyOf(HTML, 'function autoFillDorms', '\n      function ')),
    "a person pressing a destructive button should confirm; the trigger is what runs without asking");
  check("...and calls the sync with no mode argument",
    /syncDormsFromCentralDB\(currentUser\.role, currentUser\.permissions, currentUser\.name, currentUser\.id\);/.test(HTML), "");
  // ⚠️ setupInterfaceBasedOnRole drives the permission loop off exactly these.
  check("btnAutoFill keeps its permission wiring",
    /id="btnAutoFill" class="export-btn permission-req" data-perm="edit_dorms" data-orig-display="inline-block"/.test(HTML),
    "rewriting any of it silently breaks the permission loop for every dorm editor");
}

console.log("\n9. the report reaches the screen");
{
  const r = stripComments(bodyOf(HTML, 'function renderDormSyncReport', '\n      function '));
  check("the renderer exists", r.length > 400, "got " + r.length);
  check("it hides itself when there is nothing to say",
    /el\.style\.display = 'none'/.test(r), "");
  // ⚠️ Held and applied must not read alike: one is information, the other a warning
  // that nothing happened and something needs fixing.
  check("a held run reads as a warning, an applied one does not",
    /const held = !!rep\.gate/.test(r) && /alert-warning-bg/.test(r), "");
  check("room labels are escaped",
    /escHtmlJs\(String\(r\)\)/.test(r),
    "the labels are built from staff-entered Building_Info and Room_Info text");
  check("initDormGrid renders it on every load",
    /renderDormSyncReport\(data\.lastSync\)/.test(HTML), "");
  check("the panel element exists in the markup", /id="dormSyncReport"/.test(HTML), "");
}

console.log("\n10. the report is edit_dorms data, and one ✕ clears it for everyone");
{
  // ⚠️ getDormData is guarded by view_dorms, but the report is about a destructive
  // nightly job and everything that answers it — 自動割当, Dorm_Aliases, the
  // snapshot panel — is edit_dorms. A view-only user was seeing a warning with
  // nothing they could do about it.
  const g = stripComments(bodyOf(CODE, 'function getDormData'));
  check("the report is gated on edit_dorms",
    /lastSync: _hasPerm_\(userRole, perms, "edit_dorms"\) \? _readDormSyncReport_\(\) : null/.test(g),
    "a view-only caller must not receive it at all");
  // ⚠️ The decision goes through _hasPerm_; it never reads the permission string
  // itself (CLAUDE.md, Roles) — same idiom as getEnrollmentHistory's canEdit.
  check("...and does not test the permission string by hand",
    !/perms[^)]*\.split\(","\)/.test(g), "that is the OR'd-guard shape");

  // ⚠️ Gated on the DATA, not by hiding the div. setupInterfaceBasedOnRole sets
  // display from data-orig-display for every .permission-req at login, which would
  // force the panel visible even with nothing to report — fighting the renderer,
  // which owns that same property based on content.
  const panel = HTML.slice(HTML.indexOf('<div id="dormSyncReport"'),
                           HTML.indexOf('<div id="dormContainer"'));
  check("the panel div was located", panel.length > 100 && panel.length < 900,
    "got " + panel.length + " chars");
  check("the panel carries NO permission-req",
    panel.indexOf('permission-req') === -1 && panel.indexOf('data-perm') === -1,
    "the login loop would fight renderDormSyncReport for its display");

  const a = bodyOf(CODE, 'function acknowledgeDormSyncReport');
  const ac = stripComments(a);
  check("the endpoint exists and is guarded by edit_dorms",
    /_hasPerm_\(userRole, userPerms, "edit_dorms"\)/.test(ac) &&
    /throw new Error\("権限がありません"\)/.test(ac),
    "it is a write, and it writes for everyone");
  check("it is registered", /acknowledgeDormSyncReport: acknowledgeDormSyncReport,/.test(CODE), "");
  // ⚠️ The nightly run can replace the report between the page load and the click.
  check("it refuses a stale report",
    /String\(rep\.at \|\| ""\) !== String\(at \|\| ""\)/.test(ac) &&
    /新しい同期レポートが届いています/.test(ac),
    "clearing blind would acknowledge a warning nobody read");
  check("it marks rather than deletes", /rep\.acked = true/.test(ac) &&
    ac.indexOf('deleteProperty') === -1,
    "the record of what the sync did should survive being dismissed");
  check("it logs", /_logActivity_\(/.test(ac) && /寮同期レポートを確認済みに/.test(ac),
    "this is the entry that says a human dealt with it");

  // ⚠️ A new run must un-dismiss, and it does so by construction: the saved object
  // is built fresh and simply has no acked field. Nothing to reset, nothing to
  // forget — but it has to STAY that way.
  const sync = stripComments(bodyOf(CODE, 'function syncDormsFromCentralDB'));
  const saves = sync.match(/_saveDormSyncReport_\(\{[\s\S]*?\}\);/g) || [];
  check("all saved reports were located", saves.length === 3, "found " + saves.length);
  check("neither carries acked, so the next run reappears",
    saves.every(function (blk) { return blk.indexOf('acked') === -1; }),
    "an acked field written by the sync would dismiss a brand-new warning");
}

console.log("\n11. the ✕ on screen");
{
  const r = stripComments(bodyOf(HTML, 'function renderDormSyncReport', '\n      function '));
  check("an acknowledged report is not shown",
    /rep\.acked \|\|/.test(r) || /\|\| rep\.acked/.test(r), "");
  check("...but a gate or rooms still shows",
    /rep\.gate && !\(rep\.rooms && rep\.rooms\.length\)/.test(r), "");
  check("it remembers which report is on screen",
    /window\._dormSyncAt = /.test(r), "the ✕ has to send this back");
  // ⚠️ The ✕ lives inside the panel: writing el.innerHTML would delete it.
  check("the render targets the body div, not the panel",
    /body\.innerHTML =/.test(r) && !/el\.innerHTML =\s*\n?\s*'<div style="font-weight/.test(r),
    "innerHTML on the panel deletes the button that clears it");

  const k = stripComments(bodyOf(HTML, 'function ackDormSyncReport', '\n      function '));
  check("the handler exists", k.length > 300, "got " + k.length);
  check("it confirms, and says the effect is shared",
    /confirm\(/.test(k) && /全員の画面から消えます/.test(k),
    "one person clearing it for the whole team should say so");
  check("it sends the report's at", /window\._dormSyncAt \|\| ""/.test(k), "");
  // ⚠️ Three restoration points, one helper — the 取り下げ lesson from @126.
  check("there is one reset helper", /function _resetDormSyncAckBtn\(\)/.test(HTML), "");
  check("the busy state is restored on success, failure AND a sync throw",
    (k.match(/_resetDormSyncAckBtn\(\)/g) || []).length === 3,
    "a busy state with one restoration point is a busy state that strands");
  check("...and the failure handler restores BEFORE showing the error",
    k.indexOf('_resetDormSyncAckBtn();\n              showError') !== -1 ||
    /_resetDormSyncAckBtn\(\);\s*\n\s*showError\(err\)/.test(k),
    "a stale-report refusal is the expected failure and must leave the ✕ usable");
}

console.log("\n12. every run is recorded, not just the interesting ones");
{
  // ⚠️ THE BUG THIS SECTION EXISTS FOR. The report used to record only exceptional
  // outcomes, so a throttled run, a swallowed throw, an empty Central_DB and a
  // perfectly clean run were the same blank screen. For a job that runs at 3am the
  // record of the run IS the thing you need.
  const sync = stripComments(bodyOf(CODE, 'function syncDormsFromCentralDB'));

  // Every way this function ENDS must pass through the report. Counting the saves
  // alone would pass with a new early return added beside them.
  // ⚠️ Pinned to the CODE, not the prose. User-facing wording is deliberately
  // rewordable (tests/wording.test.js); codes are append-only, so they are the
  // stable thing to assert on.
  check("the empty-data early return records first",
    /_saveDormSyncReport_\(\{[^}]*DORM-01/.test(sync) &&
    sync.indexOf('_saveDormSyncReport_') < sync.indexOf('return "同期するデータがありません。";'),
    "this path left no trace at all");
  const saves = (sync.match(/_saveDormSyncReport_\(\{/g) || []).length;
  check("all three terminal paths save", saves === 3, "found " + saves + ", expected 3");

  const t = stripComments(bodyOf(CODE, 'function triggerAutoSyncStudents'));
  check("the trigger's catch RECORDS the failure",
    /catch \(e\) \{[\s\S]*?_saveDormSyncReport_\(\{[\s\S]*?DORM-05/.test(t),
    "nobody reads the execution log of a 3am job; a console.warn is the same blank screen");
  // ⚠️ The raw Apps Script message is kept in detail rather than shown: the panel
  // says something a person can read, the maintainer gets the original.
  check("...keeping the raw message in detail",
    /detail: String\(\(e && e\.message\) \|\| e\)/.test(t), "");
  check("...and still warns", /console\.warn\("dorm sync failed in trigger/.test(t), "");

  // One derived status rather than each reader re-inferring it from the shape.
  const sv = stripComments(bodyOf(CODE, 'function _saveDormSyncReport_'));
  check("the saver derives a status", /rep\.status = rep\.error \? "failed"/.test(sv), "");
  check("...covering all four outcomes",
    /"failed"/.test(sv) && /"held"/.test(sv) && /"vacated"/.test(sv) && /"clean"/.test(sv), "");
  // ⚠️ Order matters: a failed run can carry neither gate nor rooms, and a held run
  // carries pendingVacate labels in rooms — read in the wrong order a held run
  // reports as "vacated", which is the opposite of what happened.
  check("...with failed and held taking precedence over rooms",
    sv.indexOf('rep.error ?') < sv.indexOf('rep.gate ?') &&
    sv.indexOf('rep.gate ?') < sv.indexOf('rep.rooms && rep.rooms.length'),
    "a held run would otherwise report as 'vacated' — the opposite of what happened");
}

console.log("\n13. the 最終更新 chip");
{
  const c = stripComments(bodyOf(HTML, 'function _dormSyncChipHtml', '\n      function '));
  check("the chip renderer exists", c.length > 200, "got " + c.length);
  check("it shows nothing without a report", /if \(!rep \|\| !rep\.at\) return ''/.test(c), "");
  check("it shows when the sync last ran", /rep\.at/.test(c) && /最終更新/.test(c),
    "if the timestamp has not moved, the run did not happen — that is the throttle's tell");
  check("a failed or held run makes the chip a warning",
    /rep\.status === 'failed' \|\| rep\.status === 'held'/.test(c), "");

  // ⚠️ ONE writer of #dormTotals. Appending the chip from a second function is
  // exactly how the ✕ inside the panel got deleted by its own renderer.
  const totals = stripComments(bodyOf(HTML, 'function renderDormTotals', '\n      function '));
  check("renderDormTotals takes the report", /function renderDormTotals\(rooms, lastSync\)/.test(HTML), "");
  check("...and emits the chip itself", /_dormSyncChipHtml\(lastSync\)/.test(totals), "");
  const writers = (stripComments(HTML).match(/getElementById\('dormTotals'\)/g) || []).length;
  check("nothing else touches #dormTotals", writers === 1, "found " + writers + " lookups");
  check("initDormGrid passes it through",
    /renderDormTotals\(currentDormData, data\.lastSync\)/.test(HTML), "");
}

console.log("\n14. the panel tells the three outcomes apart");
{
  const r = stripComments(bodyOf(HTML, 'function renderDormSyncReport', '\n      function '));
  check("a clean run is still silent",
    /!rep\.error && !rep\.gate && !\(rep\.rooms && rep\.rooms\.length\)/.test(r),
    "the chip says it ran; this panel is for what needs a person");
  check("a failed run is shown", /const failed = !!rep\.error/.test(r), "");
  check("...as a warning", /const warn = failed \|\| held/.test(r), "");
  check("...naming the error, escaped", /escHtmlJs\(String\(rep\.error\)\)/.test(r),
    "it can carry a sheet name or an Apps Script message");
  check("...and saying the rooms were not touched", /部屋データは変更されていません/.test(r),
    "a failure and a vacate must not read alike");
  // ⚠️ failed must be tested BEFORE held, or a failure with no gate falls through to
  // the 空室化 wording and claims rooms were emptied.
  check("failed is branched before held",
    r.indexOf('const head = failed') !== -1 &&
    r.indexOf('const head = failed') < r.indexOf("? '⚠️ 空室化を保留しました"),
    "otherwise a failure claims rooms were emptied");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
