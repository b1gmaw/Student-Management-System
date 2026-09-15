// 不交付 — applicants whose 在留資格認定証明書 was not granted.
//
// ⚠️ THE WHOLE POINT, and the thing every check here defends: it is NOT a variant
// of キャンセル, despite sitting next to it and sharing its dropdowns.
//
//   キャンセル  names ONE GRID CELL (課程＋国籍＋担当) and flows through _recNet
//              into the recruiter grid, every derived total, and 定員・残枠.
//   不交付      names a 定員・残枠 ROW (課程 alone) and moves NOTHING ELSE.
//              国籍 and 担当 are recorded for reference.
//
// Routing 不交付 through _recNet would silently move the recruiter grid — numbers
// people typed would change under them, which is precisely what was not asked for.

const fs = require('fs');
const path = require('path');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- transcribed from Index.html -------------------------------------------
function notIssuedByCourse(rows) {
  let out = {};
  (rows || []).forEach(function (r) {
    const co = String(r.course || "").trim();
    if (co === "") return;
    out[co] = (out[co] || 0) + 1;
  });
  return out;
}
function unattributed(rows, courses) {
  return (rows || []).filter(function (r) {
    const co = String(r.course || "").trim();
    if (co === "") return true;
    return courses.indexOf(co) === -1;
  });
}
// One 定員・残枠 row, as recRenderCapacitySummary computes it.
function summaryRow(cap, enr, pro, vis, ni) {
  const total = Math.max(0, enr + pro + vis - ni);
  return { total: total, left: (cap === null) ? null : cap - total };
}

const COURSES = ['進学2年', '進学1年6か月'];
const ROWS = [
  { course: '進学2年',      nationality: 'ネパール', name: 'A', incharge: '甲野' },
  { course: '進学2年',      nationality: '',          name: 'B', incharge: '' },      // counts anyway
  { course: '進学1年6か月', nationality: 'ベトナム',  name: 'C', incharge: '丙川' },
  { course: '',             nationality: '中国',      name: 'D', incharge: '甲野' },  // unattributed
  { course: '別課程',       nationality: 'タイ',      name: 'E', incharge: '丙川' }   // out of scope
];

console.log("\n1. a row counts on 課程 alone");
{
  const by = notIssuedByCourse(ROWS);
  check("two rows land on 進学2年", by['進学2年'] === 2, JSON.stringify(by));
  check("one lands on 進学1年6か月", by['進学1年6か月'] === 1, JSON.stringify(by));

  // ⚠️ THE difference from キャンセル, which needs 課程＋国籍＋担当 and drops a row
  // short of all three. Here a blank 国籍/担当 is fine — the row still names a
  // 定員・残枠 row, so it still subtracts.
  check("a blank 国籍 and 担当 does not stop it counting",
    by['進学2年'] === 2,
    "不交付 subtracts on 課程 alone; requiring all three would be the cancel rule");

  check("a blank 課程 counts against nothing", by[''] === undefined, JSON.stringify(by));
  check("an out-of-scope 課程 is not folded into a real one",
    by['別課程'] === 1 && by['進学2年'] === 2, JSON.stringify(by));
}

console.log("\n2. it comes off 合計 and gives the place back to 残枠");
{
  // 定員 40, 在籍 10, 現在 25, 他ビザ 2, 不交付 2  ->  合計 35, 残枠 5
  const r = summaryRow(40, 10, 25, 2, 2);
  check("合計 subtracts the 不交付 count", r.total === 35, "got " + r.total);
  check("残枠 rises by the same amount", r.left === 5, "got " + r.left);

  const none = summaryRow(40, 10, 25, 2, 0);
  check("with no 不交付 the totals are unchanged", none.total === 37 && none.left === 3,
    JSON.stringify(none));
  check("each 不交付 row is worth exactly one place",
    none.total - r.total === 2, "got " + (none.total - r.total));

  // ⚠️ More 不交付 than applicants is a data-entry state, not a negative student
  // count. A negative 合計 would also push 残枠 above 定員, which reads as capacity
  // the school does not have.
  const over = summaryRow(40, 0, 1, 0, 5);
  check("合計 clamps at 0 rather than going negative", over.total === 0, "got " + over.total);
  check("and 残枠 never exceeds 定員", over.left === 40, "got " + over.left);

  check("a course with no 定員 still reports 合計", summaryRow(null, 10, 25, 2, 2).total === 35, "");
  check("and leaves 残枠 unknown", summaryRow(null, 10, 25, 2, 2).left === null, "");
}

console.log("\n3. rows that name nothing are surfaced, never dropped");
{
  const orphans = unattributed(ROWS, COURSES);
  check("a blank 課程 is unattributed",
    orphans.some(function (r) { return r.name === 'D'; }), "");
  check("a 課程 outside the intake is unattributed",
    orphans.some(function (r) { return r.name === 'E'; }), "");
  check("rows that do count are not listed", orphans.length === 2,
    orphans.map(function (r) { return r.name; }).join(","));
  // "I recorded a 不交付 and 残枠 did not move" must always have an explanation —
  // the same rule the 留学ビザ以外 and キャンセル callouts follow.
  check("the summary renders a 不交付 warning",
    /課程未設定または対象外の不交付/.test(HTML), "");
  check("it says what to do about it",
    /下の表で課程を選ぶと上の合計から差し引かれます/.test(HTML), "");
}

console.log("\n4. ⚠️ the recruiter grid does NOT move");
{
  // The headline test. _recNet is what the grid inputs, 現在 and every derived
  // total read; 不交付 must be absent from it.
  const netAt = HTML.indexOf('function _recNet(');
  const netBody = HTML.slice(netAt, HTML.indexOf('\n      }', netAt));
  check("_recNet's body was located", netAt !== -1 && netBody.length > 40, "");
  check("_recNet subtracts cancels only",
    /_recCancelMap/.test(netBody) && !/NotIssued/i.test(netBody),
    "routing 不交付 here would move numbers people typed into the grid");

  const cntAt = HTML.indexOf('function _recCancelCounts');
  const cntBody = HTML.slice(cntAt, HTML.indexOf('\n      }', cntAt));
  check("_recCancelCounts reads only recData.cancels",
    /recData && recData\.cancels/.test(cntBody) && !/notIssued/.test(cntBody), "");

  // And the change hook does only the one thing.
  const chAt = HTML.indexOf('function _recNotIssuedChanged');
  const chBody = HTML.slice(chAt, HTML.indexOf('\n      }', chAt));
  check("_recNotIssuedChanged's body was located", chAt !== -1, "");
  check("it refreshes ONLY 定員・残枠",
    /recRenderCapacitySummary\(\);/.test(chBody) &&
    !/_recRefreshEntryCells/.test(chBody) && !/recRefreshTotals/.test(chBody) &&
    !/_recSyncCancelMap/.test(chBody),
    "the cancel equivalent also repaints the grid inputs and every total; doing " +
    "that here would move the grid, which is the bug this whole sheet avoids");

  // 現在 is the net prospective figure and must keep subtracting cancels only.
  const capAt = HTML.indexOf('function recRenderCapacitySummary');
  // Slice to the function's real end, not a guessed byte count — a fixed window
  // that falls short makes every assertion below quietly vacuous.
  const capBody = HTML.slice(capAt, HTML.indexOf("sh += '</tbody>'", capAt));
  check("recRenderCapacitySummary's body was located", capAt !== -1 && capBody.length > 2000,
    "the anchor moved; the checks below mean nothing until this passes");
  check("現在 still subtracts only the cancel map",
    /proByCourse\[p\[0\]\] = \(proByCourse\[p\[0\]\] \|\| 0\) \+ Math\.max\(0, recData\.counts\[k\] - \(_recCancelMap\[k\] \|\| 0\)\);/.test(capBody),
    "不交付 belongs in its own column, not folded into 現在");
  check("不交付 has its own column in 定員・残枠",
    /不交付<\/th>/.test(HTML) || /不交付/.test(capBody),
    "a total that shrinks with nothing on screen explaining it is the complaint " +
    "this app has had before");
  check("合計 is clamped in the source",
    /Math\.max\(0, enr \+ pro \+ vis - ni\)/.test(capBody), "");
}

console.log("\n5. the endpoints are guarded and safe");
{
  ['addNotIssuedRow', 'saveNotIssuedCell', 'deleteNotIssuedRow'].forEach(function (fn) {
    const at = CODE.indexOf('function ' + fn);
    const body = CODE.slice(at, at + 1400);
    check(fn + " requires edit_recruitment",
      /_hasRecruitPerm_\(role, perms, "edit_recruitment"\)/.test(body), "");
  });

  const addAt = CODE.indexOf('function addNotIssuedRow');
  const addBody = CODE.slice(addAt, CODE.indexOf('\n}', CODE.indexOf('lock.releaseLock', addAt)));
  // ⚠️ Concurrent appends would both report the same getLastRow and point two
  // client rows at one sheet row — the reason addCancelRow takes the lock.
  check("adding takes the script lock", /LockService\.getScriptLock\(\)/.test(addBody), "");
  check("it flushes before reading the row index",
    /SpreadsheetApp\.flush\(\);/.test(addBody),
    "the optimistic client needs the real index back");
  check("it releases the lock in a finally", /finally \{\s*\n\s*lock\.releaseLock\(\);/.test(addBody), "");
  check("the appended row goes through the formula guard",
    /_cellSafeRow_\(\[it, "", "", "", ""\]\)/.test(addBody), "");

  const delAt = CODE.indexOf('function deleteNotIssuedRow');
  const delBody = CODE.slice(delAt, CODE.indexOf('\n}', CODE.indexOf('return { deleted: true }', delAt)));
  // ⚠️ A 不交付 row subtracts from 定員・残枠, so deleting one moves 合計 and 残枠
  // back up. deleteCancelRow was once the app's only destructive action with
  // neither a snapshot nor an audit entry; this one starts with both.
  // RE-PINNED 2026-09-11: the whole row goes into 操作履歴 instead of a sheet copy.
  check("deleting captures the whole row first", delBody.indexOf('_sheetRowForLog_(sh, ri)') !== -1 &&
    delBody.indexOf('_sheetRowForLog_(sh, ri)') < delBody.indexOf('sh.deleteRow(ri)'), "");
  check("deleting logs what it removed", /_logActivity_/.test(delBody) && /不交付を削除/.test(delBody), "");
  check("editing a cell is logged too", /不交付を編集/.test(CODE),
    "課程 decides which row this comes off, so a change moves a real number");
  check("the row index is bounds-checked",
    /ri < 2 \|\| ri > sh\.getLastRow\(\)/.test(delBody), "");

  ['addNotIssuedRow', 'saveNotIssuedCell', 'deleteNotIssuedRow'].forEach(function (fn) {
    check(fn + " is registered in the API allow-list",
      new RegExp(fn + ': ' + fn + ',').test(CODE),
      "unregistered, apiRun fails with 不正な呼び出しです");
  });
  check("the bundle carries notIssued",
    /notIssued: _getNotIssuedRows_\(want, batch \? batch\.notissued : null\)/.test(CODE), "");
  check("the sheet is created on demand alongside the others",
    /_getNotIssuedSheet_\(\);/.test(CODE), "");
}

console.log("\n6. the table mirrors the cancel roster's hard-won details");
{
  const at = HTML.indexOf('function recRenderNotIssuedTable');
  const body = HTML.slice(at, HTML.indexOf('function recAddNotIssuedRow', at));
  check("recRenderNotIssuedTable's body was located", at !== -1 && body.length > 800, "");

  // ⚠️ A <select> whose value is absent from its options silently falls back to
  // the first WITHOUT firing change — the sheet would keep one value while the
  // screen showed another. Carried as its own option and flagged instead.
  check("an unrecognised stored value is carried, not corrected",
    /（対象外）/.test(body) && /const known = cur === "" \|\| opts\.indexOf\(cur\) !== -1;/.test(body),
    "silently snapping to the first option desynchronises the sheet from the screen");
  check("the three dropdowns are over managed vocabularies",
    /recCoursesForIntake/.test(body) && /addedCountries/.test(body) && /recruiters/.test(body),
    "free text made 進学2年課程 / 進学２年課程 different courses to anything grouping them");
  check("recruiters with data but no roster entry are still listed",
    /if \(r && staffOpts\.indexOf\(r\) === -1\) staffOpts\.push\(r\);/.test(body),
    "removing someone must not hide their rows");
  check("名前 stays free text", /inp\(r, 'name'/.test(body), "");
  // ⚠️ 不交付 is one category — a 種別 grouping would be a group that never groups.
  check("there is no 種別 grouping", body.indexOf('KINDS') === -1, "");

  check("it is rendered from both call sites",
    (HTML.match(/recRenderNotIssuedTable\(canEdit\);/g) || []).length === 2,
    "the early-return path renders the rosters too; missing it leaves the " +
    "previous intake's table on screen");

  const addAt = HTML.indexOf('function recAddNotIssuedRow');
  const addBody = HTML.slice(addAt, HTML.indexOf('function _recSaveNotIssuedField', addAt));
  // ⚠️ Adding is LOCAL now. It used to append a blank row on the server immediately,
  // which meant 「行を追加」 wrote whatever you did next and 保存せずに移動 could not
  // take it back. The row and its fields go up together as one op on 保存.
  check("adding sends nothing — the row is local until 保存",
    /_pendingId: pid/.test(addBody) && !/apiRun\(/.test(addBody),
    "a server call here puts the row in the sheet before the user has saved");
  const delAt = HTML.indexOf('function recDeleteNotIssuedRow');
  const delBody = HTML.slice(delAt, delAt + 1200);
  // ⚠️ A row that only ever existed locally has nothing in the sheet to delete, and
  // must NOT go through _recDropRow — that renumbering is about real sheet rows.
  check("deleting a local row drops it without a server call",
    /_recIsPending\(rowIndex\)\)[\s\S]{0,120}?_recDropPendingRow\(/.test(delBody) &&
      delBody.indexOf('_recDropPendingRow') < delBody.indexOf('_recDropRow('),
    "renumbering against a delete the sheet never saw shifts every later row");
  check("deleting shifts the later _sheetRow values", /_recDropRow/.test(delBody), "");
  check("a failed delete puts the row back", /_recRestoreRow/.test(delBody), "");

  const saveAt = HTML.indexOf('function recSaveNotIssuedCell');
  const saveBody = HTML.slice(saveAt, HTML.indexOf('function recDeleteNotIssuedRow', saveAt));
  check("only 課程 triggers a recount",
    /if \(el\.dataset\.field === 'course'\) _recNotIssuedChanged\(\);/.test(saveBody),
    "国籍 and 担当 are reference fields here — recounting on them would be harmless " +
    "but implies they matter to the arithmetic");
}

console.log("\n7. the 定員・残枠 total row");
{
  // Transcribed from recRenderCapacitySummary's accumulators.
  //
  // ⚠️ THE RULE: a total must equal the column printed above it. Every cell sums
  // the values the rows actually DISPLAY, skipping the ones that render "-".
  function totals(rows) {
    let tCap = 0, tCapN = 0, tLy = 0, tLyN = 0, tPro = 0, tVis = 0, tNi = 0,
        tTotal = 0, tLeft = 0, tLeftN = 0;
    rows.forEach(function (r) {
      const total = Math.max(0, r.enr + r.pro + r.vis - r.ni);
      const left = (r.cap === null) ? null : r.cap - total;
      if (r.cap !== null) { tCap += r.cap; tCapN++; }
      // The auto 前年 that matched nothing renders "-", so it is skipped.
      if (r.ly !== null && !(r.lyAuto && r.lyMatched === 0)) { tLy += r.ly; tLyN++; }
      tPro += r.pro; tVis += r.vis; tNi += r.ni; tTotal += total;
      if (left !== null) { tLeft += left; tLeftN++; }
    });
    return { cap: tCapN ? tCap : null, ly: tLyN ? tLy : null,
             pro: tPro, vis: tVis, ni: tNi, total: tTotal,
             left: tLeftN ? tLeft : null };
  }
  const row = function (cap, ly, pro, vis, ni, enr, extra) {
    const r = { cap: cap, ly: ly, pro: pro, vis: vis, ni: ni, enr: enr,
                lyAuto: false, lyMatched: 1 };
    if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
    return r;
  };

  const PLAIN = [row(40, 38, 25, 2, 2, 10), row(60, 55, 40, 1, 0, 8)];
  {
    const t = totals(PLAIN);
    check("定員 totals", t.cap === 100, "got " + t.cap);
    check("前年 totals", t.ly === 93, "got " + t.ly);
    check("現在 totals", t.pro === 65, "got " + t.pro);
    check("他ビザ totals", t.vis === 3, "got " + t.vis);
    check("不交付 totals", t.ni === 2, "got " + t.ni);
    // 10+25+2-2 = 35, 8+40+1-0 = 49
    check("合計 totals the per-course 合計", t.total === 84, "got " + t.total);
    check("残枠 totals", t.left === 16, "got " + t.left);
    check("with every 定員 set, summing and recomputing agree",
      t.left === t.cap - t.total, t.left + " vs " + (t.cap - t.total));
  }

  {
    // ⚠️ THE case the rule exists for. 進学X has no 定員: its 10 students count
    // toward 合計 but it contributes nothing to 定員, so 定員合計 − 合計合計 comes
    // out 10 lower than the 残枠 column actually adds up to.
    const MIXED = [row(40, 38, 25, 2, 2, 10), row(null, null, 10, 0, 0, 0)];
    const t = totals(MIXED);
    check("残枠 sums the cells that exist", t.left === 5, "got " + t.left);
    check("合計 still includes the course with no 定員", t.total === 45, "got " + t.total);
    check("recomputing from the totals would give a DIFFERENT number",
      t.cap - t.total === -5 && t.left !== t.cap - t.total,
      "summed " + t.left + " vs recomputed " + (t.cap - t.total));
    check("the row a reader adds up is the one shown", t.left === 5,
      "a total that disagrees with its own column is worse than no total");
  }

  {
    // ⚠️ "-" everywhere means unknown, not zero.
    const NOCAP = [row(null, null, 5, 0, 0, 0), row(null, null, 3, 0, 0, 0)];
    const t = totals(NOCAP);
    check("an all-blank 定員 column totals nothing, not 0", t.cap === null, "got " + t.cap);
    check("and 残枠 with it", t.left === null, "got " + t.left);
    check("but 現在 still totals", t.pro === 8, "got " + t.pro);
  }

  {
    // The auto 前年 that matched nothing renders "-" per course.
    const LY = [row(40, 38, 25, 2, 0, 10),
                row(60, 0, 40, 0, 0, 8, { lyAuto: true, lyMatched: 0 })];
    check("前年 skips a course that matched nothing", totals(LY).ly === 38,
      "got " + totals(LY).ly);
  }

  // Source: the row is inside tbody, above the tfoot warnings, and not editable.
  const capAt = HTML.indexOf('function recRenderCapacitySummary');
  const capBody = HTML.slice(capAt, HTML.indexOf("if (foot) sh += '<tfoot>'", capAt));
  check("the capacity body was located", capAt !== -1 && capBody.length > 2000, "");
  check("the total row is emitted before </tbody>",
    capBody.indexOf(">合計</td>") !== -1 &&
    capBody.indexOf(">合計</td>") < capBody.indexOf("sh += '</tbody>'"),
    "below the tbody it would sit among the warning rows");
  check("残枠 is summed, not recomputed",
    /tLeftN \? tLeft : dash/.test(capBody) && !/tCap - tTotal/.test(capBody),
    "recomputing disagrees with the column whenever a 定員 is unset");
  check("the total row carries no input",
    !/合計<\/td>[\s\S]{0,400}?<input/.test(capBody),
    "a typeable total invites an edit that saves nowhere");
  check("it is visually a total row",
    /<tr style="border-top:2px solid var\(--border-thick\); font-weight:bold;">/.test(capBody), "");
  check("不交付 keeps its -N display in the total",
    /tNi \? '-' \+ tNi : 0/.test(capBody), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
