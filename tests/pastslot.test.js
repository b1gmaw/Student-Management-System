// 面接スケジュール: the 新規予約 email for a past date, and locking past slots.
//
// ⚠️ WHY. A teacher received 【面接予約】新規予約が入りました (2026-09-07) on 9/11. That email
// is sent from inside saveScheduleBatch at the moment of a save, so something saved the 9/7
// slot on 9/11. Two paths led there, and both were open:
//  A. Nothing refused a booking on a past slot — client or server. One ◀ too many and
//     確定 books last week.
//  B. rowMap was LAST-row-wins while the calendar (slots.find) and _findScheduleRow_ are
//     FIRST-row-wins. With two rows for one slot, editing a booking made the server compare
//     against an empty duplicate, decide the slot was newly booked, and email 新規予約 again.
//     Duplicates came from two unlocked saves both appending the same new slot.
//
// ⚠️ These run the REAL functions, extracted into a vm sandbox with the sheet stubbed (the
// session.test.js pattern), and every guard is run against its OLD shape, which must fail.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const JS = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || '';
const strip = function (s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); };

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function codeFn(name) {
  const i = SRC.indexOf('\nfunction ' + name + '(');
  if (i < 0) throw new Error('Code.js: no function ' + name);
  return SRC.slice(i + 1, SRC.indexOf('\n}\n', i) + 2);
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

const NOW = '2026-09-14 13:10';
const UTIL = { formatDate: function () { return NOW; } };

// ---------------------------------------------------------------------------
console.log("\n1. a slot is past once its START time has passed — server and client agree");
{
  const server = sandbox([codeFn('_slotIsPast_')], { Utilities: UTIL });
  const client = sandbox([htmlFn('calSlotIsPast')], { _calNowKeyJst: function () { return NOW; } });
  const cases = [
    ['2026-09-07', '10:00 ~ 10:30', true,  'last week'],
    ['2026-09-14', '13:00 ~ 13:30', true,  'today, started ten minutes ago'],
    ['2026-09-14', '13:30 ~ 14:00', false, 'today, not started'],
    ['2026-09-14', '13:10 ~ 13:40', false, 'starting this very minute is not past'],
    ['2026-09-15', '09:00 ~ 09:30', false, 'tomorrow'],
    ['2026-09-14', '9:00 ~ 9:30',   true,  'an unpadded hour still parses'],
    ['9/7/2026',   '10:00 ~ 10:30', false, 'unparseable date is NOT past'],
    ['2026-09-07', '',              false, 'unparseable period is NOT past'],
  ];
  cases.forEach(function (c) {
    check("server: " + c[3], server._slotIsPast_(c[0], c[1]) === c[2], c[0] + ' ' + c[1]);
    check("client: " + c[3], client.calSlotIsPast(c[0], c[1]) === c[2], c[0] + ' ' + c[1]);
  });
  check("the server clock is Asia/Tokyo, not the script's own zone",
    /_slotIsPast_[\s\S]*?Utilities\.formatDate\(new Date\(\), "Asia\/Tokyo", "yyyy-MM-dd HH:mm"\)/.test(codeFn('_slotIsPast_')), "");
  check("the client clock is Asia/Tokyo too",
    /timeZone: 'Asia\/Tokyo'/.test(htmlFn('_calNowKeyJst')), "");
  let flipped;
  try {
    flipped = sandbox([mutate(codeFn('_slotIsPast_'), 'return slotKey < now;', 'return slotKey > now;')], { Utilities: UTIL })
      ._slotIsPast_('2026-09-07', '10:00 ~ 10:30');
  } catch (e) { flipped = 'threw: ' + e.message; }
  check("mutation: the comparison reversed calls last week NOT past", flipped === false, String(flipped));
}

// ---------------------------------------------------------------------------
// A Schedule_DB stand-in. Rows are 25 columns; row 1 is the header.
function row(tid, date, period, status, student, inCharge) {
  const r = new Array(25).fill('');
  r[0] = '2026/09/01 10:00:00'; r[1] = tid; r[2] = '先生'; r[3] = date; r[4] = period;
  r[5] = status; r[6] = student || ''; r[11] = inCharge || '';
  return r;
}
const HEADER = new Array(25).fill('h');

function runBatch(rows, updates, opts) {
  opts = opts || {};
  const events = [], writes = [], appends = [], emails = [];
  const sheet = {
    getLastColumn: function () { return 25; },
    getLastRow: function () { return rows.length + appends.length; },
    appendRow: function (r) { appends.push(r); events.push('write'); },
    getRange: function (r, c) {
      return {
        getValues: function () { return [HEADER]; },
        setValue: function (v) { writes.push({ r: r, c: c, v: [v] }); events.push('write'); },
        setValues: function (v) { writes.push({ r: r, c: c, v: v[0] }); events.push('write'); },
      };
    },
  };
  // _normName_: the ownership check runs only when a slot was ALREADY booked, so without it
  // every existing-booking case throws a ReferenceError that looks like a refusal.
  const sources = [codeFn('_normName_'), codeFn('_schedKey_'), codeFn('_slotIsPast_'), codeFn('_activeRequest_'),
                   opts.wrapper || codeFn('saveScheduleBatch'), opts.locked || codeFn('_saveScheduleBatchLocked_')];
  const ctx = sandbox(sources, {
    Utilities: UTIL,
    _requireSession_: function () {},
    _readTabs_: function () { return { Schedule_DB: [HEADER].concat(rows) }; },
    _forgetTab_: function () {},
    _cellSafeRow_: function (a) { return a; },
    LockService: { getDocumentLock: function () {
      return { tryLock: function () { return !opts.busy; }, releaseLock: function () { events.push('unlock'); } };
    } },
    SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function () { return sheet; } }; } },
    _sendEmailNotif_: function (tid, date, period, student, inCharge, action) {
      emails.push({ action: action, date: date, student: student }); events.push('email');
    },
    _sendAdminCancelEmail_: function () { emails.push({ action: 'cancelreq' }); events.push('email'); },
  });
  let result, error = null;
  try { result = ctx.saveScheduleBatch(updates, '丁村', 'sales'); } catch (e) { error = e; }
  return { result: result, error: error, events: events, writes: writes, appends: appends, emails: emails };
}
function upd(tid, date, period, status, student, extra) {
  return Object.assign({ teacherId: tid, teacherName: '先生', date: date, period: period,
                         status: status, student: student || '', inCharge: student ? '丁村' : '' }, extra || {});
}
const FUT = '2026-09-20', P = '10:00 ~ 10:30';

console.log("\n2. path B — a duplicate row no longer turns an edit into a new booking");
{
  const rows = [row('T1', FUT, P, 'Booked', '学生A', '丁村'), row('T1', FUT, P, 'Available', '', '')];
  const edit = [upd('T1', FUT, P, 'Booked', '学生A', { remarks: '備考を修正' })];
  const out = runBatch(rows, edit);
  check("editing the booking sends NO 新規予約", out.emails.length === 0, JSON.stringify(out.emails));
  check("...and writes the FIRST row, the one the calendar shows", out.writes.some(function (w) { return w.r === 2 && w.c === 6; }) &&
    !out.writes.some(function (w) { return w.r === 3; }), JSON.stringify(out.writes.map(function (w) { return w.r; })));
  let mutant;
  try {
    mutant = runBatch(rows, edit, { locked: mutate(codeFn('_saveScheduleBatchLocked_'),
      'if (!rowMap[key]) rowMap[key] = i + 1;', 'rowMap[key] = i + 1;') });
  } catch (e) { mutant = { emails: ['threw: ' + e.message] }; }
  check("mutation: last-row-wins sends the phantom 新規予約 again",
    mutant.emails.length === 1 && mutant.emails[0].action === 'booked', JSON.stringify(mutant.emails));

  const spaced = runBatch([row('T1 ', FUT, P, 'Booked', '学生A', '丁村')], edit);
  check("a stray space in the Teacher ID cell still finds the row (no append, no email)",
    spaced.appends.length === 0 && spaced.emails.length === 0, JSON.stringify(spaced));
}

console.log("\n3. path A — nothing new starts on a past slot; an existing past booking stays editable");
{
  const pastP = '13:00 ~ 13:30', today = '2026-09-14';
  const open = runBatch([row('T1', today, pastP, 'Available')], [upd('T1', today, pastP, 'Booked', '学生B')]);
  check("booking a past 〇 slot is refused: no email", open.emails.length === 0, JSON.stringify(open.emails));
  check("...no write", open.writes.length === 0 && open.appends.length === 0, JSON.stringify(open.writes));
  check("...and the caller is told why, without a code", /過去の日時の枠は予約・変更できません（1件）/.test(open.result || '') &&
    !/[A-Z]+-\d\d/.test(open.result || ''), String(open.result));
  check("⚠️ refused by SKIPPING, never by throwing (calFlush would retry a throw forever)", open.error === null,
    String(open.error));

  const noRow = runBatch([], [upd('T1', '2026-09-07', P, 'Available')]);
  check("a past slot with no row at all: no 〇 appended", noRow.appends.length === 0, JSON.stringify(noRow.appends));

  let mutant;
  try {
    mutant = runBatch([row('T1', today, pastP, 'Available')], [upd('T1', today, pastP, 'Booked', '学生B')],
      { locked: mutate(codeFn('_saveScheduleBatchLocked_'), '_slotIsPast_(u.date, u.period, nowKey)', 'false') });
  } catch (e) { mutant = { emails: ['threw: ' + e.message] }; }
  check("mutation: without the guard the past booking emails 新規予約", mutant.emails.length === 1, JSON.stringify(mutant.emails));

  const edit = runBatch([row('T1', '2026-09-07', P, 'Booked', '学生C', '丁村')],
    [upd('T1', '2026-09-07', P, 'Booked', '学生C', { remarks: '名前の誤字を修正' })]);
  check("an existing PAST booking can still be edited", edit.writes.some(function (w) { return w.r === 2; }) && !edit.result.match(/過去/),
    String(edit.result));
  check("...and editing it sends nothing", edit.emails.length === 0, JSON.stringify(edit.emails));

  const clear = runBatch([row('T1', '2026-09-07', P, 'Booked', '学生C', '丁村')], [upd('T1', '2026-09-07', P, 'Available')]);
  check("an existing past booking can be cleared (no-show), with the usual キャンセル email",
    clear.writes.some(function (w) { return w.r === 2; }) && clear.emails.length === 1 && clear.emails[0].action === 'canceled',
    JSON.stringify(clear.emails));

  const cancelReq = runBatch([row('T1', '2026-09-07', P, 'Cancel_Request', '学生C', '丁村')],
    [upd('T1', '2026-09-07', P, 'Cancel_Request', '学生C')]);
  check("a past Cancel_Request row is still editable", cancelReq.writes.length > 0, JSON.stringify(cancelReq));
}

console.log("\n4. the 新規予約 email goes out once, AFTER the write and after the lock");
{
  const later = '13:30 ~ 14:00';
  const out = runBatch([row('T1', '2026-09-14', later, 'Available')], [upd('T1', '2026-09-14', later, 'Booked', '学生D')]);
  check("a slot later today books and emails exactly once",
    out.emails.length === 1 && out.emails[0].action === 'booked' && out.result === 'Success', JSON.stringify(out));
  const firstEmail = out.events.indexOf('email');
  check("the email follows every write", firstEmail > out.events.lastIndexOf('write'), out.events.join(','));
  check("...and the lock release", firstEmail > out.events.indexOf('unlock') && out.events.indexOf('unlock') >= 0, out.events.join(','));

  let mutant;
  try {
    mutant = runBatch([row('T1', '2026-09-14', later, 'Available')], [upd('T1', '2026-09-14', later, 'Booked', '学生D')],
      { locked: mutate(codeFn('_saveScheduleBatchLocked_'),
        'notify.push(function () { _sendEmailNotif_(u.teacherId, u.date, u.period, studentName, inCharge, "booked"); });',
        '_sendEmailNotif_(u.teacherId, u.date, u.period, studentName, inCharge, "booked");') });
  } catch (e) { mutant = { events: ['threw: ' + e.message] }; }
  check("mutation: sending inline puts the email before the write",
    mutant.events.indexOf('email') >= 0 && mutant.events.indexOf('email') < mutant.events.lastIndexOf('write'),
    mutant.events.join(','));

  const busy = runBatch([row('T1', FUT, P, 'Available')], [upd('T1', FUT, P, 'Booked', '学生E')], { busy: true });
  check("a busy lock refuses the whole save: an actionable error, no write, no email",
    busy.error && /もう一度お試しください/.test(busy.error.message) && busy.writes.length === 0 && busy.emails.length === 0,
    String(busy.error));
}

console.log("\n5. the calendar: a past slot with nothing booked is not clickable");
{
  function cell(user, slot, date, period, tid) {
    const ctx = sandbox([htmlFn('calSlotIsPast'), htmlFn('_calCellState')], {
      _calNowKeyJst: function () { return NOW; },
      escAttrJsStr: function (s) { return String(s); },
      calPendingUpdates: {},
      calScheduleByTeacher: { T1: slot ? [Object.assign({ date: date, period: period }, slot)] : [] },
      currentUser: user,
    });
    return ctx._calCellState(tid || 'T1', '先生', date, period);
  }
  const sales = { role: 'sales', id: 'S1', name: '丁村' }, teacher = { role: 'teacher', id: 'T1', name: '先生' };
  const past = cell(sales, { status: 'Available' }, '2026-09-07', P);
  check("sales: a past 〇 has no onclick", past.clickable === '', past.clickable);
  check("...and is dimmed with slot-past", / slot-past$/.test(past.cls), past.cls);
  const booked = cell(sales, { status: 'Booked', student: '学生C', inCharge: '丁村' }, '2026-09-07', P);
  check("sales: a past BOOKED slot still opens", /calHandleClick/.test(booked.clickable) && !/slot-past/.test(booked.cls), booked.clickable);
  const future = cell(sales, { status: 'Available' }, FUT, P);
  check("sales: a future 〇 still opens", /calHandleClick/.test(future.clickable), future.clickable);
  const own = cell(teacher, null, '2026-09-14', '13:00 ~ 13:30');
  check("teacher: their own past empty slot cannot be toggled", own.clickable === '', own.clickable);
  const ownLater = cell(teacher, null, '2026-09-14', '13:30 ~ 14:00');
  check("teacher: a later slot today still toggles", /calTeacherToggle/.test(ownLater.clickable), ownLater.clickable);

  let mutantClickable;
  try {
    const ctx = sandbox([htmlFn('calSlotIsPast'), mutate(htmlFn('_calCellState'), "if (past) clickable = '';", '')], {
      _calNowKeyJst: function () { return NOW; }, escAttrJsStr: String, calPendingUpdates: {},
      calScheduleByTeacher: { T1: [{ date: '2026-09-07', period: P, status: 'Available' }] }, currentUser: sales,
    });
    mutantClickable = ctx._calCellState('T1', '先生', '2026-09-07', P).clickable;
  } catch (e) { mutantClickable = 'threw: ' + e.message; }
  check("mutation: without the clear, the past 〇 is clickable again", /calHandleClick/.test(mutantClickable), mutantClickable);
}

console.log("\n6. every other way into a past slot carries the same guard");
{
  const toggle = strip(htmlFn('calTeacherToggle'));
  check("calTeacherToggle refuses a past slot BEFORE queueing the change",
    toggle.indexOf('calSlotIsPast(') > 0 && toggle.indexOf('calSlotIsPast(') < toggle.indexOf('calPendingUpdates[key] = {'), "");
  const click = strip(htmlFn('calHandleClick'));
  check("calHandleClick refuses a past 〇 before opening the booking modal",
    click.indexOf('calSlotIsPast(') > 0 && click.indexOf('calSlotIsPast(') < click.indexOf('openBookingModal('), "");
  ['submitBookerDateChange', 'populateBookerChangeDropdowns', 'populateReassignTimeDropdowns'].forEach(function (n) {
    const b = strip(htmlFn(n));
    check(n + " uses the past-aware helpers", /calSlotIsPast\(|calRequestDateOptions\(/.test(b), "");
  });
  check("the 交代 submit checks a proposed new time", /calSlotIsPast\(newDate, newPeriod\)/.test(
    strip(JS.slice(JS.indexOf('let toId = document.getElementById("reassignTeacherSelect").value;'),
                   JS.indexOf('.requestReassignment(fromId')))), "");
  ['requestBookerDateChange', 'requestReassignment', 'approveBookerDateChange', 'acceptReassignment'].forEach(function (n) {
    check("server " + n + " refuses a past target time", /_slotIsPast_\(newDate, newPeriod\)/.test(strip(codeFn(n))), "");
  });

  // Picker options: never a date before today, whatever week is on screen.
  const pick = function (weekStart) {
    const ctx = sandbox([htmlFn('getMonday'), htmlFn('formatDate'), htmlFn('_calNowKeyJst'), htmlFn('calRequestDateOptions')],
      { calWeekStart: weekStart });
    return ctx.calRequestDateOptions();
  };
  const realToday = sandbox([htmlFn('formatDate'), htmlFn('_calNowKeyJst')], {})._calNowKeyJst().slice(0, 10);
  const old = pick(new Date(2020, 0, 6));
  check("an old week on screen offers no past dates", old.length <= 5 && old.every(function (o) { return o.value >= realToday; }),
    JSON.stringify(old));
  check("a future week on screen offers all five days", pick(new Date(2099, 0, 5)).length === 5, "");
}

console.log("\n7. the diagnostic is editor-only");
{
  const d = codeFn('diagnoseScheduleDuplicates');
  check("it calls _requireMaintenanceUnlock_", /_requireMaintenanceUnlock_\("diagnoseScheduleDuplicates"\)/.test(d), "");
  check("it is read-only", !/setValue|appendRow|deleteRow|clear\(/.test(strip(d)), "");
  const registry = codeFn('_apiMethods_');
  check("it is NOT in the apiCall registry", registry.indexOf('diagnoseScheduleDuplicates') === -1, "");
  check("_saveScheduleBatchLocked_ is NOT in the registry (only the locked wrapper is)",
    registry.indexOf('_saveScheduleBatchLocked_') === -1, "");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
