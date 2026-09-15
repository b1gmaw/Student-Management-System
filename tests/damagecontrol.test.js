// Damage control: recovery, audit, revocation and guard rails.
//
// Written when the staff count grew past the point where "ask the one person who
// knows" is a recovery plan. Three questions this suite keeps answered:
//
//   1. If someone destroys data, can it be got back?
//   2. Is there a record of who did it?
//   3. Can access be cut off quickly, without destroying the account?
//
// The gap that prompted it: deleteCancelRow had NEITHER a snapshot NOR an audit
// entry — the only destructive action in the app with neither — and キャンセル rows
// had just started subtracting from the recruitment grid. Deleting one moved real
// numbers with nothing to recover from and no record of who did it.

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}
function body(fn) {
  const at = SRC.indexOf("\nfunction " + fn + "(");
  return at === -1 ? "" : SRC.slice(at, SRC.indexOf("\n}\n", at));
}

console.log("\n1. every destructive action is recoverable AND recorded");
{
  // The complete list of functions that remove data. Adding one without a
  // snapshot fails here rather than being discovered when someone needs it back.
  const DESTRUCTIVE = [
    'deleteCancelRow', 'deleteOtherVisaRow', 'deleteAnnouncement', 'deleteRole',
    'removeRecruitmentMeta', 'deleteSystemUser', 'deleteRoom', 'deleteBuilding',
    'deleteInterviewResult', 'deletePlacementConfig', 'removeBuildingDoc'
  ];
  // ⚠️ RE-PINNED 2026-09-11: "recoverable" no longer means "copies the whole sheet first".
  // That copy was ~1.5s of every delete (measured), and the 3×/day triggerScheduledBackup is
  // the safety net now. A single delete is recoverable BY HAND from its own 操作履歴 line, so
  // it must capture the whole row BEFORE deleteRow. Bulk deletes keep the immediate copy.
  const KEEPS_COPY = ['deleteBuilding'];                    // a building AND its rooms
  const LOGS_FILE_ID = ['removeBuildingDoc'];               // the file itself goes to Drive's trash
  DESTRUCTIVE.forEach(function (fn) {
    const b = body(fn);
    check(fn + " exists", b !== "", "renamed or removed — update this list");
    if (KEEPS_COPY.indexOf(fn) !== -1) {
      check(fn + " still takes an immediate copy (bulk)", b.indexOf('_snapshotSheet_(') !== -1,
        "it removes many rows at once — 'just before the mistake' matters most here");
    } else if (LOGS_FILE_ID.indexOf(fn) !== -1) {
      check(fn + " logs the removed file id", /"fileId=" \+ fileId/.test(b),
        "the id is the only way to find the file in Drive's trash again");
    } else {
      const cap = Math.max(b.indexOf('_rowForLog_('), b.indexOf('_sheetRowForLog_('));
      const del = b.search(/\.deleteRow\(/);
      check(fn + " captures the whole row BEFORE deleting it", cap !== -1 && del !== -1 && cap < del,
        "without it a mistaken delete could only be restored from the last scheduled backup");
    }
    check(fn + " writes an audit entry", b.indexOf('_logActivity_') !== -1,
      "no record of who removed it");
  });

  // ⚠️ A snapshot of the WRONG sheet is no snapshot. uploadBuildingDoc and
  // removeBuildingDoc write through info.sheet — which is General_Docs for 共通別紙
  // — while hardcoding _snapshotSheet_(SHEET_BUILDING). So a 共通 delete erased an
  // id from a sheet it had not backed up, and backed up one it had not changed.
  // ⚠️ RE-PINNED: neither copies any more. info.sheet (General_Docs for 共通別紙) is covered by
  // the scheduled backup, which enumerates EVERY sheet — so the wrong-sheet trap cannot return.
  ['uploadBuildingDoc', 'removeBuildingDoc'].forEach(function (fn) {
    const b = body(fn);
    check(fn + " takes no immediate copy (the scheduled backup covers info.sheet)",
      b.indexOf('_snapshotSheet_(') === -1, "");
    check(fn + " no longer hardcodes SHEET_BUILDING",
      b.indexOf('_snapshotSheet_(SHEET_BUILDING)') === -1, "");
    check(fn + " writes through the same info.sheet it snapshots",
      /info\.sheet\.getRange\(info\.rowIndex, info\.col\)/.test(b),
      "if the write moved, the snapshot target has to move with it");
  });
  // ⚠️ renameBuildingDoc deliberately takes NO snapshot: it touches Drive only and
  // changes no sheet. It must stay off the destructive list, or someone will add a
  // pointless full-sheet copy to a rename.
  check("renameBuildingDoc is not on the destructive list",
    DESTRUCTIVE.indexOf('renameBuildingDoc') === -1, "");
  check("and still takes no snapshot",
    body('renameBuildingDoc').indexOf('_snapshotSheet_') === -1,
    "no sheet changes, so there is nothing to back up");

  // ⚠️ The one that had neither, and the reason this suite exists.
  check("deleteCancelRow records WHAT was deleted, not just that it happened",
    /_logActivity_\([\s\S]{0,300}"キャンセルを削除"/.test(SRC) &&
    /const gone = sh\.getRange\(ri, 1, 1, CANCEL_COLS\)/.test(SRC),
    "a cancellation names a person and a number; the log should say which");
  check("editing a cancel's 課程/国籍/担当 is logged too",
    /"キャンセルを編集"/.test(SRC),
    "those three decide whose number it comes off, so an edit moves the grid " +
    "exactly as a delete does");
}

console.log("\n2. the grid everyone types into is backed up");
{
  // Recruitment_DB had never been snapshotted, and zeroing a cell DELETES its row.
  // ⚠️ RE-PINNED 2026-09-11: the per-flush (throttled) copy went with the rest of the per-save
  // copies. Its recovery is the scheduled backup, which must therefore INCLUDE this sheet.
  const b = body('saveRecruitmentCount');
  check("saveRecruitmentCount takes no copy in the save path",
    b.indexOf('_snapshotSheet_') === -1, "a copy on every cell flush was seconds per save");
  check("...and the scheduled backup does not exclude Recruitment_DB",
    /function _backupExclude_\(\) \{ return \[SESSION_SHEET, AUDIT_SHEET\]; \}/.test(SRC),
    "a bad afternoon of data entry would be unrecoverable");
  check("the throttled-copy helper is gone, not left unused",
    SRC.indexOf('_snapshotSheetThrottled') === -1 && SRC.indexOf('SNAPSHOT_THROTTLE_SEC') === -1, "");
  // Deliberately NOT logged — it would flood Activity_Log. Attribution is the
  // row's own EnteredBy column.
  check("it is deliberately not logged per edit", b.indexOf('_logActivity_') === -1,
    "logging every cell edit would bury the entries that matter");
  check("attribution still lands in the row", /EnteredBy|actorName \|\| ""/.test(b), "");
}

console.log("\n3. access can be cut off without destroying the account");
{
  const rev = body('revokeUserSessions');
  const act = body('getActiveSessions');
  check("revokeUserSessions exists", rev !== "", "");
  check("getActiveSessions exists", act !== "", "");
  check("both are guarded", /manage_users/.test(rev) && /manage_users/.test(act), "");
  check("both are registered as endpoints",
    /revokeUserSessions: revokeUserSessions/.test(SRC) && /getActiveSessions: getActiveSessions/.test(SRC),
    "apiCall dispatches through an explicit allow-list");

  // ⚠️ MASTER must not be revocable: it is how you recover from a mistake made on
  // this very screen, and an admin with manage_users must not be able to lock the
  // owner out of their own app.
  check("MASTER cannot be revoked", /uid === "MASTER"/.test(rev) &&
    /マスターアカウントは無効化できません/.test(rev),
    "an admin could otherwise lock the owner out of their own app");

  // ⚠️ The session token is a bearer credential. The user list once printed every
  // colleague's PIN in plaintext; this must not repeat it.
  check("the session token is never returned to the client",
    /token/i.test(act) === false || /NEVER returned/.test(act),
    "returning it would put a working credential on an admin screen");
  check("...and the returned shape carries no token field",
    !/token: String\(data\[i\]\[0\]/.test(act), "");

  // Deleting bottom-up, because deleting row N shifts every later row up.
  check("rows are deleted bottom-up", /for \(let i = data\.length - 1; i >= 1; i--\)/.test(rev),
    "a top-down loop skips the row that moves into the gap");
  check("the read memo is dropped after a delete", /_forgetTab_\(SESSION_SHEET\)/.test(rev),
    "a later read in the same execution would see the pre-delete snapshot");
  check("revocation is audited", /"アクセスを無効化"/.test(rev), "");

  // Non-destructive by design, and the UI must say so — an admin hesitating over
  // whether this deletes the account is an admin who does not use it.
  check("the confirm explains the account survives",
    /アカウントと権限はそのまま残ります/.test(HTML),
    "if it reads like a deletion nobody will use it on a suspicion");
  // ⚠️ RE-PINNED: "who is signed in" moved ONTO the user rows — its own table sat below the
  // list and had to tell you 「上の一覧の『アクセス無効化』で…」. The property is unchanged: an
  // admin sees who has a live session before cutting one off, and the button is only offered
  // for someone who actually has one.
  check("there is a signed-in list to act from",
    /_usersSessions\[_usersSessionKey\(u\.role, u\.id\)\]/.test(HTML)
      && /● ログイン中/.test(HTML)
      && /\$\{ses \? `<button[^`]*onclick="revokeUser\(\$\{i\}\)"/.test(HTML), "");
}

console.log("\n4. the irreversible actions ask for the name");
{
  // A second OK button is too easy to click through.
  check("restoring a snapshot requires typing the sheet name",
    /本当に復元する場合は、シート名/.test(HTML) &&
    /String\(typed\)\.trim\(\) !== sheetName/.test(HTML),
    "a restore replaces an ENTIRE sheet and was one click away");
  check("a cascade building delete requires typing the building name",
    /実行する場合は建物名/.test(HTML) &&
    /String\(typed\)\.trim\(\) !== String\(bldgLabel\)\.trim\(\)/.test(HTML),
    "the building is one row; the rooms that go with it are many");
  check("cancelling the prompt aborts rather than proceeding",
    (HTML.match(/if \(typed === null\) return;/g) || []).length >= 2,
    "prompt() returns null on cancel, and == '' would let a cancel through");
  check("the room count is still shown before asking", /件の部屋も一緒に削除されます/.test(HTML),
    "asking for a name without saying what will be destroyed is theatre");
}

console.log("\n5. a department manager can actually do the recovering");
{
  // The point of 管理者権限: the person on the spot can fix it without waiting for
  // the master. All four recovery-relevant endpoints must accept admin-LEVEL.
  ['getActivityLog', 'getSnapshotList', 'restoreSnapshot'].forEach(function (fn) {
    check(fn + " accepts an admin-level department role",
      body(fn).indexOf('_isAdminLevel_(') !== -1,
      "otherwise damage control still funnels through the master account");
  });
  check("...and the log they read is the one these actions write to",
    /const AUDIT_SHEET = 'Activity_Log'/.test(SRC), "");
}

console.log("\n6. cancelling a booking from the bell is recoverable, recorded and unambiguous");
{
  // 予約を取り消す destroys a real interview from a two-click path in a notification
  // panel. It is the newest destructive action in the app and the easiest to reach.
  const b = body('cancelBookingFromDateChange');
  check("cancelBookingFromDateChange exists", b !== "", "renamed or removed");
  // ⚠️ RE-PINNED: the booking as it was goes into 操作履歴, captured BEFORE the slot is freed.
  check("it captures the booking row before freeing the slot",
    b.indexOf('const gone = _sheetRowForLog_(sSheet, rowIndex);') !== -1 &&
    b.indexOf('_sheetRowForLog_(sSheet, rowIndex)') < b.indexOf('"Available"') &&
    /取消前: " \+ gone/.test(b),
    "the student, course and 担当 on that row are gone the moment it writes"),
  check("it writes an audit entry naming the slot and student",
    /_logActivity_\([\s\S]{0,200}"予約を取り消し"/.test(SRC),
    "no record of which interview was destroyed or by whom");
  check("it is guarded", b.indexOf('_requirePendingDateChangeRow_') !== -1, "");

  // ⚠️ Col 20 (idx 19) is the Pending flag getPendingNotifications keys on. Free the
  // slot without clearing cols 17-21 and the notification outlives the booking,
  // pointing at an empty slot that can no longer be actioned.
  check("it clears the request block, not just the booking",
    /getRange\(rowIndex, 17, 1, 5\)\.setValues/.test(b),
    "a stale Pending flag leaves a notification that can never be dismissed");
  check("it frees the whole booking field set in one write",
    /getRange\(rowIndex, 6, 1, 7\)\.setValues\(\[\["Available"/.test(b),
    "cols 6-12 are Status..In Charge; a partial clear leaves student data on a 空き slot");

  // The row index came from a bell populated at some earlier moment.
  const g = body('_requirePendingDateChangeRow_');
  check("the guard re-verifies the row is still the one displayed",
    /この予約は変更されています/.test(g),
    "rowIndex is positional; a shifted row would be written instead");
  check("...and reads display values so the date comparison can match",
    g.indexOf('getDisplayValues()') !== -1,
    "getValues() returns a Date for the date column and would never equal the string the bell sent");
  check("the 担当 check binds to the session, not the client argument",
    g.indexOf('_requireSession_(') !== -1 && /_normName_\(actor\)/.test(g),
    "staffName is client-supplied — trusting it lets a caller action someone else's booking");

  // Being told 「却下」 when the interview no longer exists is the wrong message.
  check("the teacher is told it was cancelled, not rejected",
    /_notifyTeacherBookingCancelled_/.test(SRC) && /【面接取消】/.test(SRC),
    "却下 wording reads as 'the interview stands', the opposite of what happened");

  // The decision is made in a dedicated modal, not by navigating to the slot. The
  // click has to reach it BEFORE goToNotificationSlot starts switching tabs —
  // otherwise the 担当 lands in the booking modal, which is what prompted this.
  check("a 日時変更 notification opens the response modal",
    /if \(r\.type === "datechange" && r\.rowIndex\) \{\s*\n\s*openDateChangeRespond\(r\);\s*\n\s*return;/.test(HTML),
    "without the early return the click falls through to the calendar navigation");
  check("...and it short-circuits before the tab switch",
    HTML.indexOf('openDateChangeRespond(r);') < HTML.indexOf("switchMainTab('admissions');\n        if (typeof switchAdmissionsSubTab"),
    "routing placed after the navigation would still open the booking modal first");
  check("the modal exists in the markup", /id="dateChangeRespondModal"/.test(HTML), "");

  // The button label is the last thing between a 担当 and a destroyed booking.
  // Scoped to this modal: 「キャンセル」 is a legitimate dismiss label elsewhere in
  // the app (8 buttons use it that way), so a file-wide ban would be wrong. What
  // must not happen is キャンセル appearing as the DESTRUCTIVE button right here.
  // 予約を取り消す is also what the booking modal already calls this action, so the
  // wording matches existing terminology rather than introducing a third one.
  const dcModal = (function () {
    const at = HTML.indexOf('id="dateChangeRespondModal"');
    return at === -1 ? "" : HTML.slice(at, HTML.indexOf('<!-- DORM MODALS -->', at));
  })();
  check("the modal's destructive button says 予約を取り消す",
    />予約を取り消す<\/button>/.test(dcModal), "");
  check("...and nothing in it is labelled a bare キャンセル",
    dcModal !== "" && !/>キャンセル<\/button>/.test(dcModal),
    "キャンセル already means 'request a cancellation' AND 'dismiss' in this app");
  check("the confirm spells out that the interview goes away",
    /面接自体がなくなり、枠は空きに戻ります/.test(HTML),
    "a generic confirm on a destructive action is how it gets clicked through");

  // ⚠️ A modal offering an irreversible action that cannot be dismissed is its own
  // trap — the 後で button, the overlay click and Esc all have to work.
  check("the modal can be dismissed without acting",
    /'dateChangeRespondModal': function\(\) \{ closeDateChangeRespond\(\); \}/.test(HTML) &&
    /if\(event\.target==this\) closeDateChangeRespond\(\)/.test(HTML) &&
    /onclick="closeDateChangeRespond\(\)">後で</.test(HTML),
    "Esc, the overlay and 後で must each close it");
  // The real guarantee moved into the handlers themselves (section 6b) — they close
  // before the call goes out. This keeps the reconcile step honest: it still closes
  // as a safety net, so the modal cannot survive a path that reaches only here.
  check("the reconcile step still closes the modal as a safety net",
    /function _notifActionDone\(msg\) \{\s*\n\s*closeDateChangeRespond\(\);/.test(HTML),
    "leaves the modal reachable on any path that closes only in the handler");
}

console.log("\n6b. the action does not wait on a 3-5s server call to react");
{
  // approveBookerDateChange copies the whole Schedule_DB sheet, writes four ranges,
  // reads Teacher_Master and sends a Gmail message before returning. Holding the
  // modal open across that read as a hang. Same optimistic shape dismissAnnouncement
  // has always used.
  const fn = function (name, next) {
    const a = HTML.indexOf("function " + name + "(");
    return a === -1 ? "" : HTML.slice(a, HTML.indexOf("function " + next, a + 1));
  };
  const app = fn('approveNotif', 'cancelNotifBooking');
  const can = fn('cancelNotifBooking', 'goToNotificationSlot');

  [['approveNotif', app], ['cancelNotifBooking', can]].forEach(function (pair) {
    const n = pair[0], b = pair[1];
    check(n + " exists", b !== "", "renamed or removed");
    check(n + " closes the modal BEFORE calling the server",
      b.indexOf('closeDateChangeRespond();') !== -1 &&
      b.indexOf('closeDateChangeRespond();') < b.indexOf('apiRun()'),
      "closing in the success handler is what made it sit there for seconds");
    check(n + " drops the notification optimistically",
      b.indexOf('_notifDrop(r);') !== -1 &&
      b.indexOf('_notifDrop(r);') < b.indexOf('apiRun()'),
      "the bell would otherwise still show a request that has been actioned");
    check(n + " still confirms before doing any of it",
      b.indexOf('confirm(') < b.indexOf('closeDateChangeRespond();'),
      "an optimistic close must not happen before the user has agreed");
  });

  // ⚠️ The item is already gone from the UI when the call fails. Without a reload it
  // stays gone while the request is still pending server-side, and the 担当 believes
  // they actioned something they did not.
  check("a failed action puts the notification back",
    /function _notifActionFailed\(err\) \{[\s\S]{0,220}loadNotifications\(\);/.test(HTML),
    "an optimistic drop with no rollback silently loses a pending request");
  check("every optimistic action uses that failure path",
    (HTML.match(/withFailureHandler\(_notifActionFailed\)/g) || []).length === 3,
    "approveNotif, cancelNotifBooking and respondReassign all drop an item first");

  // ⚠️ Only datechange items carry a rowIndex. An unguarded filter comparing
  // undefined to undefined would drop every item of a type at once, so the key
  // returns "" for anything it cannot identify and _notifDrop no-ops on that.
  const key = fn('_notifKey', '_notifDrop');
  const drop = fn('_notifDrop', 'dismissAnnouncement');
  check("_notifKey returns nothing for an unidentifiable item",
    /if \(!x \|\| !x\.type\) return "";/.test(key) &&
    /return x\.rowIndex \? "dc:" \+ x\.rowIndex : "";/.test(key) &&
    /if \(!x\.date \|\| !x\.period\) return "";/.test(key),
    "an item with no handle must not match anything");
  check("_notifDrop no-ops on an empty key",
    /const k = _notifKey\(r\);\s*\n\s*if \(!k\) return;/.test(drop),
    "this is the guard that stops a whole notification type being wiped");
  check("_notifDrop compares by key, not by field",
    /_notifKey\(x\) !== k/.test(drop), "");
  check("reassign items are keyed by slot, since they have no row handle",
    /return x\.type \+ ":" \+ x\.date \+ ":" \+ x\.period;/.test(key),
    "a teacher can only have one request per slot, so this is unique");
}

console.log("\n6c. the request-side modals do not block either");
{
  // Same complaint, other half of the flow: these submitted a request, waited out a
  // full Schedule_DB copy plus a Gmail send, then fired a blocking alert the user
  // had to dismiss before the modal would close. submitCancellation in the same file
  // had always closed immediately and committed in the background.
  const fn = function (name, next) {
    const a = HTML.indexOf("function " + name + "(");
    return a === -1 ? "" : HTML.slice(a, HTML.indexOf("function " + next, a + 1));
  };
  const cases = [
    ['submitBookerDateChange', 'closeTeacherViewModal();',  '_recIntakeKey'],
    ['submitReassignRequest',  'closeTeacherViewModal();',  'openReassignRespond'],
    ['respondReassign',        'closeReassignRespond();',   'openDateChangeRespond']
  ];
  cases.forEach(function (c) {
    const name = c[0], closer = c[1], b = fn(name, c[2]);
    check(name + " exists", b !== "", "renamed or removed — update this list");
    check(name + " closes its modal BEFORE calling the server",
      b.indexOf(closer) !== -1 && b.indexOf(closer) < b.indexOf('apiRun()'),
      "closing in the success handler is what made it sit there for seconds");
    check(name + " confirms success with a toast, not a blocking alert",
      b.indexOf('showToast(') !== -1 &&
      b.indexOf('showToast(') < b.indexOf('withFailureHandler'),
      "an alert on the fast path is one more thing to dismiss");
  });

  // ⚠️ Validation has to stay AHEAD of the close, or a rejected entry is thrown
  // away along with what the teacher typed.
  const sb = fn('submitBookerDateChange', '_recIntakeKey');
  check("submitBookerDateChange validates before it closes",
    sb.indexOf('現在と同じ日時です') < sb.indexOf('closeTeacherViewModal();') &&
    sb.indexOf('confirm(') < sb.indexOf('closeTeacherViewModal();'),
    "closing first would discard a rejected entry");

  // The receiving teacher's bell holds this request; it should go with the modal.
  const rr = fn('respondReassign', 'openDateChangeRespond');
  check("respondReassign clears the notification it acted on",
    /_notifDrop\(\{ type: "reassign", date: dateStr, period: periodStr \}\)/.test(rr),
    "the bell would keep offering a request already answered");

  // Five writes to five adjacent cells, on a call already dominated by a sheet copy.
  check("requestBookerDateChange writes the request block in one call",
    /getRange\(found\.rowIndex, 17, 1, 5\)\.setValues/.test(SRC) &&
    !/getRange\(found\.rowIndex, 18\)\.setValue/.test(SRC),
    "cols 17-21 are contiguous; five setValue calls are four wasted round trips");

  // The modal shuts before the server answers, so the toast is the only evidence
  // the action actually landed.
  check("success is confirmed with a toast",
    /_notifActionDone\("承認しました"\)/.test(HTML) &&
    /_notifActionDone\("予約を取り消しました"\)/.test(HTML),
    "an optimistic close with no confirmation leaves the user guessing");
  check("the toast element exists and outranks the modal overlay",
    /id="appToast"/.test(HTML) && /z-index:10001/.test(HTML),
    "modals are z-index 10000; a toast beneath them is invisible");
}

console.log("\n7. a notification opens its slot when the data lands, not on a timer");
{
  // 面接交代 and キャンセル notifications navigate to the calendar and open a slot.
  // That used to be setTimeout(…, 900) — against this app's ~1s per-call floor the
  // schedule had reliably NOT arrived, so calHandleClick found no slot, read the
  // status as 'None', and told the user 「この時間は面接枠として開放されていません。」
  // about a slot that was open. Reported from staging, not hypothetical.
  const body = (function (fn, next) {
    const a = HTML.indexOf("function " + fn);
    return a === -1 ? "" : HTML.slice(a, HTML.indexOf("function " + next, a));
  })('_openNotifTargetIfAny', 'calRegisterBooking');

  check("_openNotifTargetIfAny exists", body !== "", "renamed or removed");
  check("it runs off calLoadData's success handler",
    /calRenderGrid\(\);\s*\n\s*\/\/[\s\S]{0,160}\n\s*_openNotifTargetIfAny\(\);/.test(HTML),
    "the only reliable signal that calScheduleByTeacher is populated");
  check("no fixed-delay timer is left driving it",
    HTML.indexOf('}, 900);') === -1,
    "a timer cannot know when a ~1s round trip has finished");

  // ⚠️ Cleared BEFORE acting. If it threw while still parked, the next calendar
  // load would re-open a stale slot the user never asked for.
  check("the target is cleared before it is acted on",
    body.indexOf('window._notifTarget = null;') !== -1 &&
    body.indexOf('window._notifTarget = null;') < body.indexOf('try {'),
    "a throw would leave it primed to fire against a later load");
  check("a failed calendar load drops the target",
    /window\._notifTarget = null;\s*\n\s*showError\(err\);/.test(HTML),
    "otherwise it fires against whatever the next successful load contains");
  check("the target is parked before the tab switch, not after",
    HTML.indexOf('window._notifTarget = {') < HTML.indexOf("switchMainTab('admissions');\n        if (typeof switchAdmissionsSubTab"),
    "calLoadData's handler must find it already in place");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
