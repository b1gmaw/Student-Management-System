// ONE ACTIVE REQUEST PER BOOKING — all three types.
//
// A booking supports three requests, each stored somewhere different:
//   日時変更      BookerReq_Status = "Pending"   (cols 17-21, idx 19)
//   交代          Status = "Reassign_Pending"    (+ cols 13-16, idx 5)
//   キャンセル依頼  Status = "Cancel_Request"      (+ Cancel_Reason col 23, idx 5)
//
// Nothing reconciled them, so a row could carry two and getPendingNotifications
// pushed an item for each — the 担当 saw a cancellation and a reschedule for one
// interview with nothing saying which to act on.
//
// ⚠️ The resolution is NOT that a new request silently withdraws the old one. An
// earlier build did that and it was rejected: the teacher's request disappeared
// without them doing anything. The new request is REFUSED until the requester takes
// theirs back, which is why withdrawActiveRequest has to exist and has to cover all
// three — before it, only the 担当 could clear a pending request, and a rule with no
// withdrawal turns every request into a dead end.
//
// Each check began as a partial one and each missed a different pair. That is why
// section 1 walks the FULL matrix rather than the pair that happened to be reported.

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
// ⚠️ Comments stripped before any ordering or counting check: a comment that names
// the thing being looked for satisfies the search without the code doing anything.
// That cost two false passes already (appendRow in enrolhistory, and this file).
function stripComments(s) { return s.replace(/\/\/[^\n]*/g, ''); }

// ---- transcribed ------------------------------------------------------------
// Schedule_DB row: idx 5 = Status, 11 = In Charge, 19 = BookerReq_Status.
function activeRequest(row) {
  if (String(row[19] || '').trim() === 'Pending') return { kind: 'datechange', label: '日時変更' };
  const st = String(row[5] || '').trim();
  if (st === 'Reassign_Pending') return { kind: 'reassign', label: '交代' };
  if (st === 'Cancel_Request') return { kind: 'cancel', label: 'キャンセル' };
  return null;
}
function requireNoActiveRequest(row) {
  const a = activeRequest(row);
  if (a) throw new Error('この予約には' + a.label + 'のリクエストが出ています。');
}
function notificationsFor(row, me) {
  let out = [];
  if (String(row[11] || '').trim() !== me) return out;
  if (String(row[19] || '').trim() === 'Pending') out.push('datechange');
  if (String(row[5] || '').trim() === 'Cancel_Request') out.push('cancel');
  if (String(row[5] || '').trim() === 'Reassign_Pending') out.push('reassign');
  return out;
}
function mkRow(status, bookerReq) {
  let r = [];
  for (let i = 0; i < 25; i++) r.push('');
  r[1] = 'T01'; r[3] = '2026-09-01'; r[4] = '1限';
  r[5] = status; r[6] = '学生A'; r[11] = '甲野'; r[19] = bookerReq;
  return r;
}
// The three creators, reduced to what each does to the row.
const CREATORS = {
  reassign: function (row) {
    if (row[5] !== 'Booked') throw new Error('予約済みの面接のみ再依頼できます。');
    requireNoActiveRequest(row);
    row[5] = 'Reassign_Pending'; row[13] = 'T02'; row[21] = '理由';
  },
  datechange: function (row) {
    requireNoActiveRequest(row);
    row[19] = 'Pending'; row[16] = '2026-09-05'; row[17] = '2限';
  },
  cancel: function (row) {
    requireNoActiveRequest(row);
    row[5] = 'Cancel_Request'; row[22] = '理由';
  }
};
// withdrawActiveRequest, transcribed: it clears ALL THREE markers.
function withdrawActive(row) {
  const a = activeRequest(row);
  if (!a) throw new Error('取り下げるリクエストがありません。');
  row[16] = row[17] = row[18] = row[19] = row[20] = '';
  row[12] = row[13] = row[14] = row[15] = '';
  row[21] = row[22] = '';
  if (row[5] === 'Reassign_Pending' || row[5] === 'Cancel_Request') row[5] = 'Booked';
  return a;
}
// saveScheduleBatch's up-front pass: validate the WHOLE batch, then write.
function applyBatch(rowsByKey, updates) {
  const keyOf = u => u.teacherId + '_' + u.date + '_' + u.period;
  updates.forEach(function (u) {
    if (String(u.status || '') !== 'Cancel_Request') return;
    const row = rowsByKey[keyOf(u)];
    if (!row) return;
    const a = activeRequest(row);
    if (a && a.kind !== 'cancel') throw new Error('この予約には' + a.label + 'のリクエストが出ています。');
  });
  updates.forEach(function (u) {
    const row = rowsByKey[keyOf(u)];
    if (row) row[5] = u.status;
  });
}

console.log("\n1. the FULL matrix — every active request blocks the other two");
{
  const STATES = {
    none:       () => mkRow('Booked', ''),
    datechange: () => mkRow('Booked', 'Pending'),
    reassign:   () => mkRow('Reassign_Pending', ''),
    cancel:     () => mkRow('Cancel_Request', '')
  };
  Object.keys(STATES).forEach(function (active) {
    Object.keys(CREATORS).forEach(function (creating) {
      const row = STATES[active]();
      let threw = false;
      try { CREATORS[creating](row); } catch (e) { threw = true; }
      const shouldThrow = (active !== 'none');
      check("active=" + active + " -> " + creating + (shouldThrow ? " REFUSED" : " allowed"),
        threw === shouldThrow,
        shouldThrow ? "a second request was accepted on top of a " + active
                    : "a clean booking must still accept every request");
    });
  });
  // ⚠️ The pair that was actually reported is only one of six. The rest are the
  // ones the three separate partial checks each let through.
  const r = STATES.datechange();
  let threw = false;
  try { CREATORS.reassign(r); } catch (e) { threw = true; }
  check("⚠️ 交代 on a pending 日時変更 is refused even though Status is still Booked",
    threw && r[5] === 'Booked',
    "requestReassignment's `!== \"Booked\"` test passes this — the case that " +
    "made a single shared rule necessary");
}

console.log("\n2. a refused request changes nothing");
{
  const row = mkRow('Booked', 'Pending');
  const before = row.join(' ');
  try { CREATORS.cancel(row); } catch (e) {}
  check("the row is identical after a refusal", row.join(' ') === before, "");
  // ⚠️ The rejected design. The teacher's request must not vanish under them.
  check("the 日時変更 survives the refusal", row[19] === 'Pending',
    "a cancel must not withdraw the teacher's request for them");
}

console.log("\n3. every request is withdrawable, and withdrawal frees the booking");
{
  Object.keys(CREATORS).forEach(function (kind) {
    const row = mkRow('Booked', '');
    CREATORS[kind](row);
    const a = withdrawActive(row);
    check(kind + " can be withdrawn, and is reported as itself", a.kind === kind, "got " + a.kind);
    check("  ...leaving Status=Booked and no marker",
      row[5] === 'Booked' && activeRequest(row) === null, "row still blocked after withdrawal");
    let ok = true;
    Object.keys(CREATORS).forEach(function (next) {
      const r2 = row.slice();
      try { CREATORS[next](r2); } catch (e) { ok = false; }
    });
    check("  ...and all three requests are available again", ok, "");
  });
  check("withdrawing nothing is refused",
    (function () { try { withdrawActive(mkRow('Booked', '')); return false; } catch (e) { return true; } })(),
    "");
}

console.log("\n4. a LEGACY row carrying two is healed by one withdrawal");
{
  // Rows written before the rule can hold a 日時変更 AND a 交代 — that combination
  // was reachable. Clearing only the reported one leaves the booking blocked with
  // an empty banner: nothing on screen explains why the buttons stay disabled.
  const row = mkRow('Reassign_Pending', 'Pending');
  row[13] = 'T02'; row[16] = '2026-09-05'; row[21] = 'r'; row[22] = 'c';
  const a = withdrawActive(row);
  check("it reports the higher-precedence one", a.kind === 'datechange', "got " + a.kind);
  check("but BOTH are cleared", activeRequest(row) === null && row[19] === '' && row[5] === 'Booked',
    "a partial heal leaves the booking blocked with nothing explaining why");
  check("the reasons go too", row[21] === '' && row[22] === '',
    "stale reasons resurface on the next request");
  let ok = true;
  Object.keys(CREATORS).forEach(function (next) {
    const r2 = row.slice();
    try { CREATORS[next](r2); } catch (e) { ok = false; }
  });
  check("and the booking accepts requests again", ok, "");
}

console.log("\n5. the bell can never show two items for one interview");
{
  const both = mkRow('Cancel_Request', 'Pending');
  check("the broken state WOULD have produced two", notificationsFor(both, '甲野').length === 2,
    "if this fails the transcription no longer reproduces the bug and the rest " +
    "of this suite proves nothing");
  // Every state reachable now: start clean, apply one creator, that is all there is.
  const reachable = [mkRow('Booked', ''), mkRow('Available', '')];
  Object.keys(CREATORS).forEach(function (k) {
    const r = mkRow('Booked', ''); CREATORS[k](r); reachable.push(r);
  });
  reachable.forEach(function (r) {
    const n = notificationsFor(r, '甲野').length;
    check("Status=" + (r[5] || '(blank)') + " BookerReq=" + (r[19] || '(blank)') + " -> " + n,
      n <= 1, "got " + n);
  });
}

console.log("\n6. the batch refusal is a separate pass, and leaves no partial write");
{
  const rows = {
    'T01_2026-09-01_1限': mkRow('Booked', ''),
    'T01_2026-09-02_1限': mkRow('Booked', 'Pending'),
    'T01_2026-09-03_1限': mkRow('Booked', '')
  };
  // The offender sits in the MIDDLE. Throwing inside the write loop would leave the
  // first applied and the third not — a half-saved batch.
  let threw = false;
  try {
    applyBatch(rows, [
      { teacherId: 'T01', date: '2026-09-01', period: '1限', status: 'Available' },
      { teacherId: 'T01', date: '2026-09-02', period: '1限', status: 'Cancel_Request' },
      { teacherId: 'T01', date: '2026-09-03', period: '1限', status: 'Available' }
    ]);
  } catch (e) { threw = true; }
  check("the batch throws", threw, "");
  check("the update BEFORE the offender was not applied", rows['T01_2026-09-01_1限'][5] === 'Booked',
    "a mid-loop throw leaves earlier writes committed");
  check("nor the one after", rows['T01_2026-09-03_1限'][5] === 'Booked', "");

  const clean = { 'T01_2026-09-01_1限': mkRow('Booked', '') };
  applyBatch(clean, [{ teacherId: 'T01', date: '2026-09-01', period: '1限', status: 'Cancel_Request' }]);
  check("a cancel with no active request still applies",
    clean['T01_2026-09-01_1限'][5] === 'Cancel_Request', "");

  const avail = { 'T01_2026-09-01_1限': mkRow('Booked', 'Pending') };
  applyBatch(avail, [{ teacherId: 'T01', date: '2026-09-01', period: '1限', status: 'Available' }]);
  check("a NON-cancel save on a blocked row is allowed", avail['T01_2026-09-01_1限'][5] === 'Available',
    "only Cancel_Request is gated; the check must not block ordinary edits");

  // ⚠️ Re-saving Cancel_Request on a row that ALREADY has it is an ordinary edit —
  // the 担当 changing 備考 on a slot awaiting cancellation sends the status back
  // unchanged. Refusing that would make such a booking uneditable.
  const same = { 'T01_2026-09-01_1限': mkRow('Cancel_Request', '') };
  let reThrew = false;
  try { applyBatch(same, [{ teacherId: 'T01', date: '2026-09-01', period: '1限', status: 'Cancel_Request' }]); }
  catch (e) { reThrew = true; }
  check("re-saving Cancel_Request on an already-cancelled row is NOT refused", !reThrew,
    "only a DIFFERENT active request blocks a cancellation");
}

console.log("\n7. the rule is declared once in Code.js and every creator uses it");
{
  check("_activeRequest_ reads all three markers",
    /function _activeRequest_\(row\)/.test(CODE) &&
    /row\[19\] \|\| ""\)\.trim\(\) === "Pending"/.test(CODE) &&
    /st === "Reassign_Pending"/.test(CODE) && /st === "Cancel_Request"/.test(CODE),
    "a marker it cannot see is a request it cannot block");
  check("_requireNoActiveRequest_ names what is outstanding",
    /function _requireNoActiveRequest_\(row\)/.test(CODE) &&
    /a\.label \+\s*\n?\s*"のリクエストが出ています/.test(CODE),
    "a generic refusal does not tell the teacher what to withdraw");

  // ⚠️ Section 1 exercises the TRANSCRIBED creators, so it stays green even if the
  // real ones stop calling the shared rule. These read the source.
  ['requestReassignment', 'requestBookerDateChange'].forEach(function (fn) {
    const b = stripComments(bodyOf(CODE, 'function ' + fn));
    check(fn + " calls _requireNoActiveRequest_", /_requireNoActiveRequest_\(row\)/.test(b),
      "its own partial check is not enough — that is the whole finding");
  });
  const rBody = stripComments(bodyOf(CODE, 'function requestReassignment'));
  check("requestReassignment still keeps its Booked test as well",
    /row\[5\] !== "Booked"/.test(rBody) &&
    rBody.indexOf('row[5] !== "Booked"') < rBody.indexOf('_requireNoActiveRequest_'),
    "the shared rule is about the REQUEST; that test is about the SLOT");

  // saveScheduleBatch is now the lock-and-notify wrapper; the validation and the writes
  // live in _saveScheduleBatchLocked_ (see tests/pastslot.test.js §4).
  check("saveScheduleBatch delegates to _saveScheduleBatchLocked_",
    stripComments(bodyOf(CODE, 'function saveScheduleBatch(')).indexOf('_saveScheduleBatchLocked_(') !== -1,
    "the checks below would be reading a function the save no longer runs");
  const bCode = stripComments(bodyOf(CODE, 'function _saveScheduleBatchLocked_('));
  check("saveScheduleBatch checks the batch in a separate pass",
    (bCode.match(/updatesArray\.forEach/g) || []).length === 2,
    "one pass means the check runs inside the write loop, and a throw then leaves " +
    "every earlier update committed");
  check("it calls _activeRequest_ before the first write",
    bCode.indexOf('_activeRequest_(') !== -1 &&
    bCode.indexOf('_activeRequest_(') < bCode.indexOf('sSheet.getRange(r, 6, 1, 7)'),
    "validation has to complete before anything is written");
  check("and only a DIFFERENT request blocks the cancel",
    /active\.kind !== "cancel"/.test(bCode),
    "otherwise editing an already-cancel-requested booking throws");

  check("saveScheduleBatch does not auto-clear the 日時変更 block",
    !/getRange\(r, 17, 1, 5\)\.setValues/.test(bCode),
    "silently withdrawing the teacher's request is the behaviour that was rejected");
  check("the reassign clearing beside it is untouched",
    /if \(u\.status !== "Reassign_Pending"\) \{\s*\n\s*sSheet\.getRange\(r, 13, 1, 4\)/.test(bCode),
    "different mechanism, different meaning — it must not be swept up in this");
}

console.log("\n8. withdrawActiveRequest — one withdrawal, whatever the request");
{
  const wBody = bodyOf(CODE, 'function withdrawActiveRequest');
  check("its body was located", wBody.length > 800, "got " + wBody.length + " chars");
  check("it resolves the caller from the session",
    /_requireSession_\("withdrawActiveRequest"\)/.test(wBody), "");
  // ⚠️ Without the ownership test any caller could withdraw anybody's request.
  check("only the booking's teacher or an admin may withdraw",
    /String\(me\.id \|\| ""\)\.trim\(\) === String\(row\[1\] \|\| ""\)\.trim\(\)/.test(wBody) &&
    /_isAdminLevel_\(me \? me\.role : ""\)/.test(wBody),
    "the id must come from the session, not from an argument");
  check("it refuses when nothing is active",
    /取り下げるリクエストがありません/.test(wBody), "");
  // ⚠️ ALL THREE cleared, not just the reported one — see section 4.
  check("it clears the 日時変更 block, 17-21",
    /getRange\(found\.rowIndex, 17, 1, 5\)\.setValues\(\[\["", "", "", "", ""\]\]\)/.test(wBody), "");
  check("it clears the 交代 block, 13-16",
    /getRange\(found\.rowIndex, 13, 1, 4\)\.setValues\(\[\["", "", "", ""\]\]\)/.test(wBody), "");
  check("it clears both reasons, 22-23",
    /getRange\(found\.rowIndex, 22, 1, 2\)\.setValues\(\[\["", ""\]\]\)/.test(wBody), "");
  check("it rolls a request status back to Booked",
    /st === "Reassign_Pending" \|\| st === "Cancel_Request"/.test(wBody) &&
    /getRange\(found\.rowIndex, 6\)\.setValue\("Booked"\)/.test(wBody),
    "a withdrawn 交代 or cancel leaves the interview standing");
  // RE-PINNED 2026-09-11: a withdrawal is an edit (it rolls fields back), so it takes no
  // sheet copy — the 3×/day triggerScheduledBackup covers Schedule_DB. It must still log.
  check("it logs, and takes no per-save copy", !/_snapshotSheet_/.test(wBody) &&
    /active\.label \+ "リクエストを取り下げ"/.test(wBody), "");
  // ⚠️ rejectBookerDateChange mails the teacher because the 担当 decided. Here the
  // teacher IS the actor, so a mail would be telling them what they just did.
  check("it does NOT mail the teacher",
    wBody.indexOf('_notifyTeacherDateChangeResult_') === -1, "");
  check("it is registered in the API allow-list",
    /withdrawActiveRequest: withdrawActiveRequest,/.test(CODE), "");
  // ⚠️ Endpoint, registry entry and client caller go together (rule 2).
  check("the narrower withdrawBookerDateChange is gone everywhere",
    CODE.indexOf('withdrawBookerDateChange') === -1 &&
    HTML.indexOf('withdrawBookerDateChange') === -1,
    "a half-removed endpoint is worse than either state");
}

console.log("\n9. the client says which request, and gates both buttons");
{
  check("one banner, with a 取り下げ button",
    /id="activeReqBanner"/.test(HTML) && /onclick="withdrawActiveReq\(\)"/.test(HTML), "");
  // ⚠️ Both old banners removed with their code, not just hidden (rule 2).
  check("the two per-type banners are gone",
    HTML.indexOf('bookerReqPendingBanner') === -1 && HTML.indexOf('reassignPendingBanner') === -1,
    "domrefs catches the other half of a partial removal");

  const sBody = bodyOf(HTML, 'function _slotActiveRequest', '\n      function ');
  check("_slotActiveRequest mirrors the server's three markers",
    /slot\.bookerReqStatus/.test(sBody) && /cStatus === "Reassign_Pending"/.test(sBody) &&
    /cStatus === "Cancel_Request"/.test(sBody),
    "what the client cannot see, it cannot explain");
  check("...in the SAME precedence as _activeRequest_",
    sBody.indexOf('bookerReqStatus') < sBody.indexOf('Reassign_Pending') &&
    sBody.indexOf('Reassign_Pending') < sBody.indexOf('Cancel_Request'),
    "a legacy row with two markers would otherwise be described one way on screen " +
    "and another in the log");
  check("the banner names the requested date and time",
    /slot\.bookerNewDate/.test(sBody) && /slot\.bookerNewPeriod/.test(sBody), "");
  check("...and the target teacher for a 交代", /slot\.reassignToName/.test(sBody), "");

  // ⚠️ A refusal that only appears after clicking reads as a fault in the app.
  const gBody = bodyOf(HTML, 'function _gateRequestBtn', '\n      function ');
  check("_gateRequestBtn disables and says why",
    /btn\.disabled = true/.test(gBody) &&
    /btn\.title = "先に" \+ active\.label \+ "リクエストを取り下げてください。"/.test(gBody), "");
  // ⚠️ The modal is reused across slots: a stale title or label follows the button.
  check("it restores BOTH the label and the title when nothing is active",
    /btn\.innerText = defaultLabel/.test(gBody) && /btn\.removeAttribute\("title"\)/.test(gBody), "");
  const openBody = stripComments(
    bodyOf(HTML, 'const _active = _slotActiveRequest(slot, cStatus)', 'function closeTeacherViewModal'));
  check("BOTH request buttons go through it",
    /_gateRequestBtn\(reassignBtn, _active/.test(openBody) &&
    /_gateRequestBtn\(cancelBtn, _active/.test(openBody),
    "gating them apart is how each learned about only some of the requests");

  // ⚠️ calFlush's failure handler KEEPS the pending change on purpose. A cancel the
  // server will always reject would sit in calPendingUpdates and fail again on
  // every later flush, so the block has to happen at submission.
  const cBody = bodyOf(HTML, 'function submitCancellation', '\n      function ');
  check("submitCancellation refuses locally", /if \(window\._activeReqSlot\) \{/.test(cBody), "");
  const cCode = stripComments(cBody);
  check("and returns before touching the queue",
    cCode.indexOf('window._activeReqSlot') !== -1 &&
    cCode.indexOf('window._activeReqSlot') < cCode.indexOf('calPendingUpdates'),
    "otherwise a permanently-rejected update poisons the batch");
  check("the failure handler still keeps changes on a real error",
    /変更は保持されています/.test(HTML),
    "that behaviour is deliberate and is exactly why the local check exists");

  const wBody = bodyOf(HTML, 'function withdrawActiveReq', '\n      function ');
  check("the withdraw re-reads rather than patching locally", /calLoadData\(\)/.test(wBody),
    "the row, its status and the 担当's bell all change; a local guess is a second truth");
  check("a read-only viewer loses the 取り下げ button, not the banner",
    /activeReqWithdrawBtn"\);\s*\n\s*if \(wb\) wb\.style\.display = "none"/.test(HTML),
    "the banner is information; only its action is privileged");
}

console.log("\n10. the 取り下げ label cannot outlive one modal session");
{
  // The button's LABEL is state that lives in the DOM, and the DOM outlives the
  // modal — the same element is reused for every slot. withdrawActiveReq swaps it
  // to 取り下げ中... while the call is in flight, and it was restored in exactly ONE
  // place: partway down openTeacherViewModal, behind ~120 lines of slot rendering
  // that can throw. It reached a later open still reading 取り下げ中 on a booking
  // nothing was being withdrawn from.
  check("there is ONE reset helper", /function _resetWithdrawBtn\(\)/.test(HTML),
    "three copies of two lines is how it came to have one restoration point");
  check("...and it is the only thing that writes the idle label",
    (HTML.match(/innerText = "取り下げ";/g) || []).length === 1,
    "a second copy drifts from the first");

  const oCode = stripComments(bodyOf(HTML, 'function openTeacherViewModal', '\n      function closeTeacherViewModal'));
  check("openTeacherViewModal resets it", /_resetWithdrawBtn\(\)/.test(oCode), "");
  // ⚠️ POSITION, not presence. Everything below the rendering is skipped when a
  // malformed slot throws, and the catch at the bottom only alerts.
  check("...FIRST, before any slot rendering can throw",
    oCode.indexOf('_resetWithdrawBtn()') !== -1 &&
    oCode.indexOf('_resetWithdrawBtn()') < oCode.indexOf('viewStudentName') &&
    oCode.indexOf('_resetWithdrawBtn()') < oCode.indexOf('_slotActiveRequest'),
    "a reset placed after the rendering is a reset that a bad slot skips");

  const clCode = stripComments(bodyOf(HTML, 'function closeTeacherViewModal', '\n      function '));
  check("closeTeacherViewModal resets it too", /_resetWithdrawBtn\(\)/.test(clCode),
    "reset on open AND close is what stops the label outliving one modal session");
  check("...and clears window._activeReqSlot", /window\._activeReqSlot = null/.test(clCode),
    "submitCancellation reads it; a stale value refuses a cancellation on a " +
    "different, clean booking");

  const wCode = stripComments(bodyOf(HTML, 'function withdrawActiveReq', '\n      function '));
  check("both handlers restore the label",
    (wCode.match(/_resetWithdrawBtn\(\)/g) || []).length >= 2, "");
  // ⚠️ The success handler used to toast BEFORE closing: showToast throwing left the
  // modal open on 取り下げ中... with the request already gone.
  check("...the success handler restores BEFORE it closes or toasts",
    wCode.indexOf('_resetWithdrawBtn()') < wCode.indexOf('closeTeacherViewModal()') &&
    wCode.indexOf('_resetWithdrawBtn()') < wCode.indexOf('showToast'),
    "anything that can throw ahead of the restore can strand the label");
  // ⚠️ A throw on the dispatch line fires NEITHER handler.
  check("a synchronous throw on dispatch restores it as well",
    /catch \(e\) \{\s*\n\s*_resetWithdrawBtn\(\);\s*\n\s*showError\(e\);/.test(wCode),
    "the label would sit on 取り下げ中... with nothing on screen saying why");
}

console.log("\n11. a slot carrying a request is never toggled away");
{
  // ⚠️ calTeacherToggle routes booked slots to the modal and falls through to the
  // availability cycle for everything else — which queues {status:'Available',
  // student:""} and CLEARS THE BOOKING. Reassign_Pending was missing from the list,
  // and the one-active-request rule is what sends teachers to those slots: it tells
  // them to open the slot and withdraw the request first.
  const REQUEST_STATES = ['Booked', 'Cancel_Request', 'Reassign_Pending'];
  [['calTeacherToggle', 'Cycle: None'], ['calHandleClick', 'Route through the existing booking modal']]
    .forEach(function (pair) {
      const body = stripComments(bodyOf(HTML, 'function ' + pair[0], '\n      function '));
      check(pair[0] + "'s body was located", body.length > 200, "got " + body.length);
      REQUEST_STATES.forEach(function (st) {
        check("  " + pair[0] + " routes " + st + " to the modal",
          new RegExp("status === '" + st + "'").test(body),
          "an unlisted state falls through to code that is not expecting a booking");
      });
    });

  const tCode = stripComments(bodyOf(HTML, 'function calTeacherToggle', '\n      function '));
  const guardAt = tCode.indexOf("status === 'Reassign_Pending'");
  check("...and in calTeacherToggle the guard precedes the destructive write",
    guardAt !== -1 && guardAt < tCode.indexOf("newStatus = 'Available'"),
    "the availability cycle is what clears the student");

  // Transcribed: the routing decision, so the states and the fallthrough are
  // exercised and not merely read.
  function routeTeacherClick(status) {
    if (status === 'Unavailable' || status === 'None') return 'refused';
    if (status === 'Booked' || status === 'Cancel_Request' || status === 'Reassign_Pending') return 'modal';
    return 'toggle';
  }
  REQUEST_STATES.forEach(function (st) {
    check("  a " + st + " slot opens the modal, it does not toggle",
      routeTeacherClick(st) === 'modal', "got " + routeTeacherClick(st));
  });
  check("an Available slot still toggles", routeTeacherClick('Available') === 'toggle',
    "the guard must not swallow ordinary availability edits");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
