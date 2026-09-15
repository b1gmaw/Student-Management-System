// The all-teachers calendar: a saved 〇/✖ must stay on screen.
//
// The bug this pins down: a teacher taps a cell, the mark appears, and a moment
// later it silently reverts. The save had worked — a page reload showed it — so
// the sheet and the screen disagreed, which is worse than a visible failure.
// Staff stopped trusting that their availability had been recorded at all.
//
// Mechanism. calRenderGrid resolves each cell as "pending wins, else server
// data". calTeacherToggle writes calPendingUpdates and re-renders, so the mark
// paints at once. Then calFlush's success handler DELETED the pending entry
// without ever updating calScheduleByTeacher, and calQueueSave passes
// doReload=false so nothing reloaded either. The next render fell back to data
// loaded before the edit.
//
// ⚠️ Reloading instead is not the fix and must not be "simplified" back in:
// calLoadData starts with calPendingUpdates = {}, so reloading on the debounced
// path throws away edits made while the request is in flight. That is precisely
// why doReload is false there.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Index.html ----
let calScheduleByTeacher, calPendingUpdates;

const key = (tid, date, period) => tid + '_' + date + '_' + period;

// calTeacherToggle's cycle: None -> Available -> Unavailable -> None
function toggle(tid, date, period, name) {
  const k = key(tid, date, period);
  let status = 'None';
  if (calPendingUpdates[k]) status = calPendingUpdates[k].status;
  else {
    const slot = (calScheduleByTeacher[tid] || []).find(s => s.date === date && s.period === period);
    if (slot) status = slot.status;
  }
  if (status === 'Booked' || status === 'Cancel_Request') return null;   // not toggleable
  let newStatus = 'Available';
  if (status === 'Available') newStatus = 'Unavailable';
  else if (status === 'Unavailable') newStatus = 'None';
  calPendingUpdates[k] = { teacherId: tid, teacherName: name || 'T', date, period, status: newStatus, student: "" };
  return newStatus;
}

// calFlush's success handler, as fixed.
function flushSuccess(sending) {
  Object.keys(sending).forEach(function (k) {
    if (calPendingUpdates[k] !== sending[k]) return;
    const u = sending[k];
    const slots = calScheduleByTeacher[u.teacherId] || (calScheduleByTeacher[u.teacherId] = []);
    let slot = slots.find(function (s) { return s.date === u.date && s.period === u.period; });
    if (!slot) { slot = { date: u.date, period: u.period }; slots.push(slot); }
    slot.status = u.status;
    slot.student = u.student || '';
    if (u.status === 'None' || u.status === 'Available' || u.status === 'Unavailable') {
      slot.reassignToId = ''; slot.reassignNewDate = ''; slot.reassignNewPeriod = '';
    }
    delete calPendingUpdates[k];
  });
}

// calRenderGrid's per-cell resolution, and the label it picks.
function render(tid, date, period) {
  const k = key(tid, date, period);
  let status = 'None', student = '', reassignToId = '';
  if (calPendingUpdates[k]) {
    status = calPendingUpdates[k].status;
    student = calPendingUpdates[k].student || '';
  } else {
    const slot = (calScheduleByTeacher[tid] || []).find(s => s.date === date && s.period === period);
    if (slot) {
      status = slot.status; student = slot.student || '';
      reassignToId = slot.reassignToId || '';
    }
  }
  let label = '';
  if (status === 'Cancel_Request') label = '!';
  else if (status === 'Reassign_Pending') label = '交代';
  else if (status === 'Booked' || student) label = student.split('\n')[0].substring(0, 6);
  else if (status === 'Available') label = '〇';
  else if (status === 'Unavailable') label = '✖';
  return { status, label, reassignToId };
}

const snapshot = () => Object.assign({}, calPendingUpdates);
const reset = (sched) => { calScheduleByTeacher = sched || {}; calPendingUpdates = {}; };

const T = 'T1', D = '2026-08-10', P = '09:00 ~ 09:30';

console.log("\n1. the regression: a saved mark survives the save");
{
  reset({ T1: [] });
  toggle(T, D, P);
  check("the 〇 paints immediately on tap", render(T, D, P).label === '〇', JSON.stringify(render(T, D, P)));

  const sending = snapshot();
  flushSuccess(sending);

  check("calPendingUpdates is emptied, as before", Object.keys(calPendingUpdates).length === 0, "");
  // Before the fix this fell back to server data loaded BEFORE the edit and
  // returned '' — the mark vanishing in front of the teacher.
  check("the 〇 is STILL there after the save",
    render(T, D, P).label === '〇',
    "this is the bug: the sheet had it, the screen did not");
  check("and the local model now holds it",
    calScheduleByTeacher[T][0].status === 'Available', JSON.stringify(calScheduleByTeacher[T]));
}

console.log("\n2. every state in the cycle survives");
{
  ['Available', 'Unavailable', 'None'].forEach(function (want) {
    reset({ T1: [] });
    let s = toggle(T, D, P);
    while (s !== want) s = toggle(T, D, P);
    const before = render(T, D, P).label;
    flushSuccess(snapshot());
    check("'" + want + "' renders the same before and after the save",
      render(T, D, P).label === before, before + " -> " + render(T, D, P).label);
  });
  check("Available shows 〇", (reset({T1:[]}), toggle(T,D,P), flushSuccess(snapshot()), render(T,D,P).label) === '〇', "");
}

console.log("\n3. a slot with no prior server entry is created, not dropped");
{
  // First availability of a fresh week: calScheduleByTeacher has no row at all,
  // and for a teacher who has never set any, no bucket either.
  reset({});
  toggle(T, D, P);
  flushSuccess(snapshot());
  check("a missing teacher bucket is created", Array.isArray(calScheduleByTeacher[T]), JSON.stringify(calScheduleByTeacher));
  check("the new slot is appended", calScheduleByTeacher[T].length === 1, JSON.stringify(calScheduleByTeacher[T]));
  check("and it renders", render(T, D, P).label === '〇', "");
}

console.log("\n4. an existing slot is updated in place, not duplicated");
{
  reset({ T1: [{ date: D, period: P, status: 'Unavailable', student: '' }] });
  toggle(T, D, P);   // Unavailable -> None
  flushSuccess(snapshot());
  check("no duplicate row for the same date+period", calScheduleByTeacher[T].length === 1,
    JSON.stringify(calScheduleByTeacher[T]));
  check("the existing row was updated", calScheduleByTeacher[T][0].status === 'None',
    JSON.stringify(calScheduleByTeacher[T]));
  check("a blank cell renders blank", render(T, D, P).label === '', "");
}

console.log("\n5. an edit made mid-flight is not clobbered");
{
  reset({ T1: [] });
  toggle(T, D, P);                    // -> Available
  const sending = snapshot();         // this is what the request carries
  toggle(T, D, P);                    // teacher taps again -> Unavailable, still pending
  flushSuccess(sending);              // the older response lands

  check("the newer edit is still pending", !!calPendingUpdates[key(T, D, P)],
    "the in-flight response deleted an entry it did not send");
  check("the screen shows the NEWER state", render(T, D, P).label === '✖',
    JSON.stringify(render(T, D, P)));
  // The stale value is deliberately not merged: the newer pending entry wins in
  // render anyway, and it will merge over the top when it saves.
  check("the stale value was not written to the local model",
    (calScheduleByTeacher[T] || []).length === 0, JSON.stringify(calScheduleByTeacher[T]));

  flushSuccess(snapshot());           // now the newer one lands
  check("once it saves, ✖ survives too", render(T, D, P).label === '✖', "");
}

console.log("\n6. a failed save keeps the mark on screen");
{
  reset({ T1: [] });
  toggle(T, D, P);
  // failure handler does NOT touch calPendingUpdates — the entries are retained
  check("the pending entry is retained", !!calPendingUpdates[key(T, D, P)], "");
  check("so the mark stays visible while the retry message shows",
    render(T, D, P).label === '〇',
    "clearing it on failure would hide work the user still has");
}

console.log("\n7. reassignment fields");
{
  reset({ T1: [{ date: D, period: P, status: 'Reassign_Pending', student: 'Aarav',
                 reassignToId: 'T2', reassignNewDate: '2026-08-11', reassignNewPeriod: P }] });
  // A cell returning to plain availability cannot still carry a reassignment.
  calPendingUpdates[key(T, D, P)] = { teacherId: T, date: D, period: P, status: 'Available', student: '' };
  flushSuccess(snapshot());
  const s = calScheduleByTeacher[T][0];
  check("reassign fields clear when the slot goes back to 〇",
    s.reassignToId === '' && s.reassignNewDate === '' && s.reassignNewPeriod === '',
    JSON.stringify(s));
  check("and the cell renders 〇, not 交代", render(T, D, P).label === '〇', JSON.stringify(render(T, D, P)));

  // A booking must NOT have them wiped — that path carries its own fields.
  reset({ T1: [{ date: D, period: P, status: 'Reassign_Pending', student: 'StudentA', reassignToId: 'T2' }] });
  calPendingUpdates[key(T, D, P)] = { teacherId: T, date: D, period: P, status: 'Booked', student: 'StudentA' };
  flushSuccess(snapshot());
  check("a booking keeps its reassignment marker",
    calScheduleByTeacher[T][0].reassignToId === 'T2', JSON.stringify(calScheduleByTeacher[T][0]));
}

console.log("\n8. the source still says what this test assumes");
{
  // Ordering is the whole point, so assert it by position rather than by trying
  // to size a regex window around a commented block.
  const guardAt  = HTML.indexOf("if (calPendingUpdates[k] !== sending[k]) return;");
  const mergeAt  = HTML.indexOf("slot.status  = u.status;");
  const deleteAt = HTML.indexOf("delete calPendingUpdates[k];");
  check("calFlush guards against a superseded entry", guardAt !== -1, "the guard is gone");
  check("calFlush writes the saved status into calScheduleByTeacher", mergeAt !== -1,
    "the merge was removed — the mark will start vanishing again");
  check("the merge happens BEFORE the pending entry is dropped",
    guardAt !== -1 && mergeAt !== -1 && deleteAt !== -1 &&
    guardAt < mergeAt && mergeAt < deleteAt,
    "deleting first leaves render falling back to pre-edit server data: " +
    JSON.stringify({ guardAt, mergeAt, deleteAt }));
  check("calFlush re-renders after a successful save",
    /calStatus\('saved'\);\s*\n\s*calRenderGrid\(\);/.test(HTML),
    "merging without re-rendering fixes nothing the user can see");
  check("calQueueSave still passes doReload = false",
    /calFlush\(false, false\)/.test(HTML),
    "reloading on the debounced path discards edits made in flight — calLoadData " +
    "starts with calPendingUpdates = {}");
  check("calLoadData still clears pending updates, which is why the above matters",
    /function calLoadData\(\)[\s\S]{0,200}calPendingUpdates = \{\};/.test(HTML), "");
  check("the render precedence is still pending-wins-else-server",
    /if \(calPendingUpdates\[key\]\) \{[\s\S]{0,200}\} else \{[\s\S]{0,200}calScheduleByTeacher\[tid\]/.test(HTML),
    "this test transcribes that resolution; if it changed, retranscribe it");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
