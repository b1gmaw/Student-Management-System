// 募集状況's 保存 button — deferred writes instead of real-time ones.
//
// ⚠️ THE WHOLE POINT: nothing in 募集状況 writes as you type any more. Every saver
// records an op in a queue and paints the cell amber; recSaveAll() sends the lot in
// ONE round trip to saveRecruitmentBatch, and applies the POSITIONAL results array
// back to the things that produced it.
//
// The dangerous outcomes, and every section defends one of them:
//   (a) a typed value never reaching the sheet — because a saver still fires its own
//       RPC, because a re-render wiped it, or because an in-flight batch cleared a
//       newer edit;
//   (b) a value reaching the sheet as the WRONG NUMBER — the gross/net ratchet, which
//       is what happens the moment anything re-derives the count from the input box;
//   (c) work being discarded without the user being asked.
//
// §7 mutation-checks the source assertions against the pre-change shapes.

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

let _recDirtyOps, _recPending, _recPendingEdits, _recNoteDirty, _recSaving;
function reset() {
  _recDirtyOps = {}; _recPending = {}; _recPendingEdits = {};
  _recNoteDirty = false; _recSaving = false; _recDirtyIntake = '';
}

let _recDirtyIntake = '';
function _recQueue(key, op, sel, el) {
  _recDirtyIntake = CURRENT_INTAKE;
  _recDirtyOps[key] = { op: op, sel: sel || null, el: el || null };
}
let CURRENT_INTAKE = '2026年10月';
function recPendingCount() { return Object.keys(_recPending).length; }
function recDirtyCount() {
  return Object.keys(_recDirtyOps).length + recPendingCount() +
         Object.keys(_recPendingEdits).length + (_recNoteDirty ? 1 : 0);
}

// The three roster field savers, all reduced to the same shape.
function _recRowOpSel(container, sheetRow, field) {
  return '#' + container + ' [data-row="' + sheetRow + '"][data-field="' + field + '"]';
}
function _recSaveCancelField(sheetRow, field, value) {
  _recQueue('cancel|' + sheetRow + '|' + field,
            { t: 'cancel', rowIndex: sheetRow, field: field, value: value },
            _recRowOpSel('recCancelTable', sheetRow, field));
}
function _recSaveVisaField(sheetRow, field, value) {
  _recQueue('visa|' + sheetRow + '|' + field,
            { t: 'visa', rowIndex: sheetRow, field: field, value: value },
            _recRowOpSel('recVisaTable', sheetRow, field));
}
function _recSaveNotIssuedField(sheetRow, field, value) {
  _recQueue('notissued|' + sheetRow + '|' + field,
            { t: 'notissued', rowIndex: sheetRow, field: field, value: value },
            _recRowOpSel('recNotIssuedTable', sheetRow, field));
}

// _recShiftDirtyOps — the queue's half of a delete's row renumbering.
const _REC_OP_TABLE = { visa: 'recVisaTable', cancel: 'recCancelTable',
                        notissued: 'recNotIssuedTable' };
function _recShiftDirtyOps(kind, ri, delta) {
  const at = parseInt(ri, 10);
  let next = {};
  Object.keys(_recDirtyOps).forEach(function (k) {
    const d = _recDirtyOps[k];
    const n = parseInt(d.op.rowIndex, 10);
    if (d.op.t !== kind || isNaN(n)) { next[k] = d; return; }
    if (delta < 0 && n === at) return;
    if (n < at) { next[k] = d; return; }
    const to = n + delta;
    d.op.rowIndex = to;
    d.sel = _recRowOpSel(_REC_OP_TABLE[kind], to, d.op.field);
    d.el = null;
    next[kind + '|' + to + '|' + d.op.field] = d;
  });
  _recDirtyOps = next;
}

// _recDropRow / _recRestoreRow, the model half they must stay in step with.
function _recDropRow(list, rowIndex) {
  const ri = parseInt(rowIndex, 10);
  let at = -1;
  for (let i = 0; i < list.length; i++) {
    if (parseInt(list[i]._sheetRow, 10) === ri) { at = i; break; }
  }
  if (at === -1) return null;
  const row = list[at];
  list.splice(at, 1);
  list.forEach(function (r) {
    const n = parseInt(r._sheetRow, 10);
    if (n > ri) r._sheetRow = n - 1;
  });
  return { row: row, at: at, ri: ri };
}
function _recRestoreRow(list, undo) {
  list.forEach(function (r) {
    const n = parseInt(r._sheetRow, 10);
    if (n >= undo.ri) r._sheetRow = n + 1;
  });
  list.splice(undo.at, 0, undo.row);
}

// recSaveCell's half, with the gross/net arithmetic that _recPending exists for.
function recSaveCell(counts, cancelMap, co, nat, rec, boxValue) {
  let net = parseInt(boxValue, 10); if (isNaN(net) || net < 0) net = 0;
  const key = co + "||" + nat + "||" + rec;
  const cancels = cancelMap[key] || 0;
  const val = net + cancels;
  const prev = _recPending[key] ? _recPending[key].prev : (counts[key] || 0);
  if (val === prev) { delete _recPending[key]; return key; }
  if (val === 0) delete counts[key]; else counts[key] = val;
  _recPending[key] = { el: null, co: co, nat: nat, rec: rec, val: val, prev: prev };
  return key;
}

// recSaveAll's op-building half.
function buildOps() {
  let ops = [], apply = [];
  Object.keys(_recPending).forEach(function (key) {
    const p = _recPending[key];
    ops.push({ t: 'count', course: p.co, nationality: p.nat, recruiter: p.rec, count: p.val });
    apply.push({ kind: 'count', key: key, p: p });
  });
  Object.keys(_recDirtyOps).forEach(function (key) {
    const d = _recDirtyOps[key];
    ops.push(d.op);
    apply.push({ kind: 'queued', key: key, op: d.op });
  });
  if (_recNoteDirty) { ops.push({ t: 'note', html: 'H' }); apply.push({ kind: 'note', html: 'H' }); }
  return { ops: ops, apply: apply };
}

// _recSaveAllDone's half: apply the positional results.
function applyResults(results, apply) {
  let failed = [];
  for (let i = 0; i < apply.length; i++) {
    const a = apply[i];
    const r = results[i] || { ok: false, error: "" };
    if (!r.ok) failed.push(r.error);
    if (a.kind === 'count') {
      if (_recPending[a.key] !== a.p) continue;
      if (r.ok) delete _recPending[a.key];
    } else if (a.kind === 'queued') {
      const d = _recDirtyOps[a.key];
      if (!d || d.op !== a.op) continue;
      if (r.ok) delete _recDirtyOps[a.key];
    } else if (a.kind === 'note') {
      if (r.ok) _recNoteDirty = false;
    }
  }
  return failed;
}

// ---- the server's dispatch, transcribed from Code.js ------------------------
const OP_KINDS = ['count', 'capacity', 'cancel', 'visa', 'notissued', 'note', 'dates'];

console.log("1. the queue is last-write-wins, and keyed per field");
{
  reset();
  _recSaveCancelField(5, 'name', 'あ');
  _recSaveCancelField(5, 'name', 'い');
  check("re-editing one field REPLACES rather than appends",
    Object.keys(_recDirtyOps).length === 1, Object.keys(_recDirtyOps).join(","));
  check("...and the LAST value is the one queued",
    _recDirtyOps['cancel|5|name'].op.value === 'い', _recDirtyOps['cancel|5|name'].op.value);

  _recSaveCancelField(5, 'course', '進学2年課程');
  check("a different field on the same row is its own entry",
    Object.keys(_recDirtyOps).length === 2, Object.keys(_recDirtyOps).join(","));

  _recSaveVisaField(5, 'name', 'う');
  _recSaveNotIssuedField(5, 'name', 'え');
  check("the three rosters cannot collide on one key",
    Object.keys(_recDirtyOps).length === 4, Object.keys(_recDirtyOps).join(","));

  // ⚠️ A numeric-looking key would be reordered to the front of the object by the
  // JS integer-key rule, and the positional results array would then line up
  // against the wrong op.
  const numeric = Object.keys(_recDirtyOps).filter(function (k) { return /^\d+$/.test(k); });
  check("no key is integer-like, so insertion order holds",
    numeric.length === 0, numeric.join(","));
}

console.log("\n2. recDirtyCount spans every store");
{
  reset();
  check("empty", recDirtyCount() === 0, String(recDirtyCount()));
  _recSaveCancelField(2, 'name', 'x');
  check("queued ops count", recDirtyCount() === 1, String(recDirtyCount()));
  _recPending['a||b||c'] = { val: 1, prev: 0 };
  check("grid cells count", recDirtyCount() === 2, String(recDirtyCount()));
  _recNoteDirty = true;
  check("連絡事項 counts", recDirtyCount() === 3, String(recDirtyCount()));
  // ⚠️ Fields typed into a row whose add has not come back yet. They reach the queue
  // on confirm, but until then they are unsaved work and must not leave with the page.
  _recPendingEdits['p1'] = { name: 'y' };
  check("edits held for a pending row count too", recDirtyCount() === 4, String(recDirtyCount()));
}

console.log("\n3. the gross/net ratchet — the number that reaches the sheet");
{
  // TECHNICAL_REFERENCE §7.3: the box shows NET, Recruitment_DB stores GROSS.
  // Typing 4 against 1 cancel must store 5 and keep storing 5, forever.
  const counts = {}, cancelMap = { 'C||N||R': 1 };
  reset();
  recSaveCell(counts, cancelMap, 'C', 'N', 'R', '4');
  let built = buildOps();
  check("typing 4 against 1 cancel queues 5", built.ops[0].count === 5, String(built.ops[0].count));
  applyResults([{ ok: true }], built.apply);

  // The box redisplays net (5 - 1 = 4). Type the same 4 again.
  reset();
  recSaveCell(counts, cancelMap, 'C', 'N', 'R', '4');
  check("re-entering the same 4 is a no-op, not a decrement",
    recPendingCount() === 0 && counts['C||N||R'] === 5, JSON.stringify(counts));

  // And a genuine change still lands as gross.
  reset();
  recSaveCell(counts, cancelMap, 'C', 'N', 'R', '6');
  built = buildOps();
  check("changing to 6 queues 7, not 6", built.ops[0].count === 7, String(built.ops[0].count));

  // ⚠️ The naive implementation this replaces: send the box's value.
  const naive = 6;
  check("the naive 'send el.value' answer is provably different",
    naive !== built.ops[0].count, "both produced " + naive);
}

console.log("\n4. partial failure — exactly the saved ops leave the queue");
{
  reset();
  _recSaveCancelField(2, 'name', 'a');     // ok
  _recSaveVisaField(3, 'name', 'b');       // FAILS
  _recSaveNotIssuedField(4, 'name', 'c');  // ok
  const built = buildOps();
  const failed = applyResults(
    [{ ok: true }, { ok: false, error: 'X' }, { ok: true }], built.apply);
  check("one failure reported", failed.length === 1 && failed[0] === 'X', JSON.stringify(failed));
  check("the two that saved are gone",
    !_recDirtyOps['cancel|2|name'] && !_recDirtyOps['notissued|4|name'],
    Object.keys(_recDirtyOps).join(","));
  check("the one that failed STAYS QUEUED for a retry",
    !!_recDirtyOps['visa|3|name'], Object.keys(_recDirtyOps).join(","));
  check("the badge still shows it", recDirtyCount() === 1, String(recDirtyCount()));

  // A short results array must not be read as success.
  reset();
  _recSaveCancelField(2, 'name', 'a');
  const b2 = buildOps();
  applyResults([], b2.apply);
  check("a missing result is a failure, not a silent clear",
    !!_recDirtyOps['cancel|2|name'], "the op was dropped unsaved");
}

console.log("\n5. an edit made WHILE the batch is in flight is never cleared by it");
{
  // The inputs stay live during a save. Clearing an op by key alone would throw the
  // newer value away, and it would look saved.
  reset();
  _recSaveCancelField(2, 'name', 'old');
  const built = buildOps();
  _recSaveCancelField(2, 'name', 'new');           // typed again mid-flight
  applyResults([{ ok: true }], built.apply);
  check("the newer edit survives its predecessor's success",
    !!_recDirtyOps['cancel|2|name'] && _recDirtyOps['cancel|2|name'].op.value === 'new',
    JSON.stringify(_recDirtyOps));

  // Same guarantee for a grid cell, via object identity on _recPending.
  reset();
  const counts = {}, cancelMap = {};
  recSaveCell(counts, cancelMap, 'C', 'N', 'R', '1');
  const b = buildOps();
  recSaveCell(counts, cancelMap, 'C', 'N', 'R', '2');
  applyResults([{ ok: true }], b.apply);
  check("a re-typed grid cell survives too",
    recPendingCount() === 1 && _recPending['C||N||R'].val === 2,
    JSON.stringify(_recPending));
}

console.log("\n5.1 a delete renumbers the QUEUE, not just the model");
{
  // ⚠️ THE BUG THIS SECTION EXISTS FOR, found on staging: queued ops address a row
  // by the same _sheetRow the model does, so a delete that shifts rows must shift
  // them too. Without it an outstanding edit points one row too high — past the end
  // it comes back 「対象の行が見つかりません」, and INSIDE the sheet it writes to the
  // wrong person, silently, which is the worse half.
  const mkList = () => [{ _sheetRow: 2, name: 'a' }, { _sheetRow: 3, name: 'b' },
                        { _sheetRow: 4, name: 'c' }];

  reset();
  let list = mkList();
  _recSaveVisaField(4, 'name', 'あとで保存');
  const undo = _recDropRow(list, 2);
  _recShiftDirtyOps('visa', 2, -1);
  check("a delete ABOVE moves the op down with its row",
    !!_recDirtyOps['visa|3|name'] && _recDirtyOps['visa|3|name'].op.rowIndex === 3,
    Object.keys(_recDirtyOps).join(","));
  check("...to the same index the model gave that row",
    String(list[list.length - 1]._sheetRow) === String(_recDirtyOps['visa|3|name'].op.rowIndex),
    list.map(function (r) { return r._sheetRow; }).join(","));
  check("...and the selector follows it",
    _recDirtyOps['visa|3|name'].sel === '#recVisaTable [data-row="3"][data-field="name"]',
    _recDirtyOps['visa|3|name'].sel);
  check("...dropping the stale element reference the re-render invalidated",
    _recDirtyOps['visa|3|name'].el === null, "a detached node would swallow the marker");

  // The inverse, for when the server refuses the delete.
  _recRestoreRow(list, undo);
  _recShiftDirtyOps('visa', 2, +1);
  check("a refused delete puts the op back",
    !!_recDirtyOps['visa|4|name'] && _recDirtyOps['visa|4|name'].op.rowIndex === 4,
    Object.keys(_recDirtyOps).join(","));

  reset();
  _recSaveVisaField(3, 'name', 'きえる');
  _recShiftDirtyOps('visa', 3, -1);
  check("deleting the edited row itself drops its op",
    recDirtyCount() === 0, Object.keys(_recDirtyOps).join(","));

  reset();
  _recSaveVisaField(2, 'name', 'うごかない');
  _recShiftDirtyOps('visa', 4, -1);
  check("a delete BELOW never moves an op",
    !!_recDirtyOps['visa|2|name'] && _recDirtyOps['visa|2|name'].op.rowIndex === 2,
    Object.keys(_recDirtyOps).join(","));

  // ⚠️ Each roster renumbers independently — they are three different sheets.
  reset();
  _recSaveVisaField(4, 'name', 'v');
  _recSaveCancelField(4, 'name', 'c');
  _recSaveNotIssuedField(4, 'name', 'n');
  _recShiftDirtyOps('visa', 2, -1);
  check("a 留学ビザ以外 delete leaves キャンセル and 不交付 alone",
    !!_recDirtyOps['visa|3|name'] && !!_recDirtyOps['cancel|4|name'] &&
    !!_recDirtyOps['notissued|4|name'], Object.keys(_recDirtyOps).join(","));

  // A grid count op has no rowIndex at all and must survive untouched.
  reset();
  _recPending['C||N||R'] = { co: 'C', nat: 'N', rec: 'R', val: 3, prev: 0 };
  _recSaveVisaField(4, 'name', 'v');
  _recShiftDirtyOps('visa', 2, -1);
  check("grid counts are not addressed by row and are never shifted",
    recPendingCount() === 1 && _recPending['C||N||R'].val === 3, JSON.stringify(_recPending));

  // Many ops on one row all move together.
  reset();
  ['name', 'course', 'incharge'].forEach(function (f) { _recSaveVisaField(4, f, 'x'); });
  _recShiftDirtyOps('visa', 3, -1);
  check("every field on a moved row moves with it",
    ['name', 'course', 'incharge'].every(function (f) {
      return _recDirtyOps['visa|3|' + f] && _recDirtyOps['visa|3|' + f].op.rowIndex === 3;
    }), Object.keys(_recDirtyOps).join(","));
}

console.log("\n6. the source still matches the transcription");
{
  const recBlock = HTML.slice(HTML.indexOf('function recLoad('),
                              HTML.indexOf('function renderPastInterviewsTable'));
  check("the 募集状況 block was located", recBlock.length > 20000, String(recBlock.length));

  // ⚠️ (a): no saver may still fire its own write. This is the assertion the whole
  // change exists for — one of these creeping back is invisible until someone
  // notices a field saving itself.
  const LIVE_WRITES = [
    'saveRecruitmentCount(', 'saveRecruitmentCapacity(', 'saveCancelCell(',
    'saveOtherVisaCell(', 'saveNotIssuedCell(', 'saveRecruitmentNote(',
    'saveRecruitmentDates(',
  ];
  LIVE_WRITES.forEach(function (m) {
    check("no client call to " + m + ") outside the batch",
      recBlock.indexOf('.' + m) === -1,
      "a saver still writes on its own — it must queue instead");
  });
  check("saveRecruitmentBatch is the one write the client makes",
    (recBlock.match(/\.saveRecruitmentBatch\(/g) || []).length === 1,
    "expected exactly one call site");

  // ⚠️ (a): the debounces are gone. A surviving timer would write behind the button.
  check("REC_SAVE_DELAY is gone", HTML.indexOf('REC_SAVE_DELAY') === -1, "the grid debounce survives");
  check("_recTimers is gone", HTML.indexOf('_recTimers') === -1, "the grid debounce survives");
  check("_recNoteTimer is gone", HTML.indexOf('_recNoteTimer') === -1, "the 連絡事項 debounce survives");
  check("recFlushAll is gone", HTML.indexOf('recFlushAll') === -1,
    "recLoad would silently commit unsaved work again");

  // ⚠️ (a): every renderer that can run mid-edit repaints the markers, or an
  // outstanding edit goes invisible while still queued.
  ['recRenderCapacitySummary', 'recRenderCancelTable', 'recRenderNotIssuedTable',
   'recRenderVisaTable'].forEach(function (fn) {
    const at = recBlock.indexOf('function ' + fn);
    const body = recBlock.slice(at, recBlock.indexOf('\n      }', at));
    check(fn + " repaints the 未保存 markers it just destroyed",
      at !== -1 && body.indexOf('_recRepaintDirty()') !== -1,
      "a rebuilt table drops the outlines off queued edits");
  });

  // ⚠️ (a): 定員 must be written back to the model, or the next re-render rebuilds
  // the input from recData and the live re-read saves the OLD number.
  const qc = recBlock.slice(recBlock.indexOf('function _recQueueCapacity'),
                            recBlock.indexOf('function recSaveCountryQuota'));
  check("_recQueueCapacity writes 定員 back to recData.capacity",
    /recData\.capacity\[/.test(qc), "a re-render would wipe the typed value");
  check("...and 前年実績 to recData.lastYear",
    /recData\.lastYear\[/.test(qc), "same trap on the other column");
  check("...and the per-country quota to recData.countryQuota",
    /recData\.countryQuota\[/.test(qc), "same trap in the grid");

  // ⚠️ (b): recSaveCell must keep adding the cancels back.
  const sc = recBlock.slice(recBlock.indexOf('function recSaveCell'),
                            recBlock.indexOf('function _recCellSaved'));
  check("recSaveCell still converts net to gross",
    /_recCancelMap\[key\]/.test(sc) && /net \+ cancels/.test(sc),
    "the 5 → 4 → 3 ratchet is back");
  const sa = recBlock.slice(recBlock.indexOf('function recSaveAll'),
                            recBlock.indexOf('function _recSaveAllDone'));
  check("recSaveAll sends p.val, never the input's value",
    /count: p\.val/.test(sa) && !/count:\s*\w*\.el\.value/.test(sa),
    "re-deriving the count from the box is the ratchet");

  // ⚠️ The queue renumbers with the model, on BOTH directions of all three rosters.
  ['recDeleteCancelRow', 'recDeleteNotIssuedRow', 'recDeleteVisaRow'].forEach(function (fn) {
    const at = recBlock.indexOf('function ' + fn);
    const body = recBlock.slice(at, recBlock.indexOf('\n      }', at));
    check(fn + " shifts the queue when it drops the row",
      /_recShiftDirtyOps\('\w+', rowIndex, -1\)/.test(body),
      "a queued edit would keep pointing at the pre-delete row index");
    check(fn + " shifts it back when the server refuses",
      /_recShiftDirtyOps\('\w+', rowIndex, \+1\)/.test(body),
      "the restored row and its queued edit would disagree");
  });
  // ⚠️ The transcription above is a COPY — mutating the real function cannot fail
  // it. These pin the three lines that make the shift correct, so a boundary slip or
  // a forgotten selector fails HERE. Both were live mutations that passed until this
  // block existed.
  {
    const sh = recBlock.slice(recBlock.indexOf('function _recShiftDirtyOps'),
                              recBlock.indexOf('function _recRestoreRow'));
    check("the shift drops the deleted row's own ops",
      /if \(delta < 0 && n === at\) return;/.test(sh),
      "an op on the vanished row would be sent against whatever moved into it");
    check("...leaves everything below the cut alone, exclusively",
      /if \(n < at\) \{ next\[k\] = d; return; \}/.test(sh) && !/n <= at/.test(sh),
      "n <= at would strand the row at the cut, the mirror of _recDropRow's n > ri");
    check("...rebuilds the selector for the new row",
      /d\.sel = _recRowOpSel\(_REC_OP_TABLE\[kind\], to, d\.op\.field\);/.test(sh),
      "the marker would stay on the row the edit no longer belongs to");
    check("...and drops the element the re-render is about to detach",
      /d\.el = null;/.test(sh), "a detached node swallows the outline and the retry");
    check("...and rekeys, so a later edit to that row replaces rather than duplicates",
      /next\[kind \+ '\|' \+ to \+ '\|' \+ d\.op\.field\] = d;/.test(sh),
      "two ops for one field would both be sent");
  }

  check("_recDropRow stays a pure list function",
    !/function _recDropRow[\s\S]{0,600}?_recShiftDirtyOps/.test(recBlock),
    "tests/sheetrow.test.js transcribes it as one");

  // ⚠️ (c): the guards.
  check("the intake select goes through recIntakeChanged",
    HTML.indexOf('onchange="recIntakeChanged(this)"') !== -1 &&
    HTML.indexOf('id="recIntakeSelect" class="form-control" style="width:auto; margin:0; padding:6px 10px;" onchange="recLoad()"') === -1,
    "switching intake would discard unsaved work silently");
  check("recIntakeChanged restores the select when the user cancels",
    /_recLoadedIntake/.test(recBlock.slice(recBlock.indexOf('function recIntakeChanged'),
                                           recBlock.indexOf('function recIntakeChanged') + 400)),
    "the select would show an intake that is not the one loaded");
  check("switchSubTab asks before leaving 募集状況",
    /function switchSubTab\([\s\S]{0,400}?_recLeaveGuard\(/.test(HTML),
    "leaving the sub-tab would discard unsaved work");
  check("switchMainTab asks too",
    /function switchMainTab\([\s\S]{0,400}?_recLeaveGuard\(/.test(HTML),
    "leaving 学生一覧 would discard unsaved work");
  check("beforeunload covers the whole queue, not just the grid",
    /beforeunload[\s\S]{0,220}recDirtyCount\(\) > 0/.test(HTML),
    "closing the tab would lose 定員 / 連絡事項 / roster edits without a word");

  // ⚠️ These must NOT ask. Their recLoad() carries the queue across, and requiring
  // a save before you may delete a 国名 is exactly the coupling the button removed.
  // The user reported the block as a bug; this is that decision written down.
  ['recSubmitCountry', 'recRecruiterAdd', 'recRecruiterRemove', 'recRegionAdd',
   'recRegionRename', 'recRegionDelete', 'recDeleteCountry',
   'recSaveRecruiterOrder'].forEach(function (fn) {
    const at = recBlock.indexOf('function ' + fn);
    const body = recBlock.slice(at, recBlock.indexOf('\n      }', at));
    check(fn + " does NOT make the user save first",
      at !== -1 && body.indexOf('_recGuardDirty(') === -1,
      "deleting a 国名 / 担当者 / 地域 has nothing to do with unsaved numbers");
  });
  check("the 'save first' refusal is gone entirely",
    HTML.indexOf('先に「保存」を押してください') === -1,
    "a path still refuses instead of carrying the work across");

  // ⚠️ The one exception: it CHANGES INTAKE, and ops carry no intake of their own.
  {
    const at = recBlock.indexOf('function recSubmitIntake');
    const body = recBlock.slice(at, recBlock.indexOf('\n      }', at));
    check("recSubmitIntake still asks — it switches intake",
      at !== -1 && /_recGuardDirty\(function\(\)\{ recSubmitIntake\(\); \}/.test(body),
      "the old intake's ops would be saved against the new one");
    check("...and re-runs itself, so the year/month survive the question",
      at !== -1 && body.indexOf('recSubmitIntake();') !== -1,
      "answering the prompt would drop what was typed into the dialog");
  }

  // ⚠️ A reload keeps unsaved work. Both halves must be wired, or the values come
  // back without their markers, or the markers without their values.
  check("recLoad no longer discards on the way in",
    !/function recLoad\([\s\S]{0,700}?_recDiscardDirty\(\)/.test(recBlock),
    "a reload would throw away work the user had not decided to drop");
  check("...it re-applies the queue to the fresh model before rendering",
    /_recDirtyIntake !== chosen\) _recDiscardDirty\(\);[\s\S]{0,80}_recReapplyDirtyToModel\(\);/.test(recBlock),
    "the renderers build from recData, so unwritten values vanish");
  check("...and re-binds the DOM after",
    /recRender\(\);\s*\n\s*_recReapplyDirtyToDom\(\);/.test(recBlock),
    "grid cells hold element references the render just replaced");
  check("...discarding only when the INTAKE actually changed",
    /if \(_recDirtyIntake && _recDirtyIntake !== chosen\)/.test(recBlock),
    "ops carry no intake, so they may not cross one");
  check("_recQueue stamps the intake every op belongs to",
    /function _recQueue\([\s\S]{0,200}?_recDirtyIntake =/.test(HTML),
    "without the stamp the switch check cannot fire");

  // ⚠️ The note is the one field the server would stamp back over.
  {
    const ln = recBlock.slice(recBlock.indexOf('function recLoadNote'),
                              recBlock.indexOf('function recRefreshTotals'));
    check("a reload never overwrites an unsaved 連絡事項",
      (ln.match(/if \(!_recNoteDirty\) ed\.innerHTML =/g) || []).length === 2 &&
      !/^\s*ed\.innerHTML = recSanitizeNote\(res\.html\);/m.test(ln),
      "both the prefetch and the fetch paths must be guarded");
    check("...nor clears the dirty flag behind the user's back",
      ln.indexOf('_recNoteDirty = false;') === -1,
      "the note would look saved while the queue still held it");
  }

  // ⚠️ The button carries an icon and a badge, so innerText would blank it.
  const btn = HTML.slice(HTML.indexOf('id="btnRecSave"') - 40,
                         HTML.indexOf('id="btnRecSave"') + 900);
  check("#btnRecSave carries an icon", /class="btn-ico"/.test(btn), btn.slice(0, 120));
  check("...a .btn-label", /<span class="btn-label">保存<\/span>/.test(btn), btn.slice(0, 120));
  check("...and the count in #recDirtyBadge, NOT in the label",
    /id="recDirtyBadge"/.test(btn) && !/btn-label[^<]*\(/.test(btn),
    "the mobile block clips .btn-label, so a count written there is invisible");
  const sb = recBlock.slice(recBlock.indexOf('function _recSetSaveBtn'),
                            recBlock.indexOf('function recSaveAll'));
  check("_recSetSaveBtn writes the label through _setBtnLabel",
    /_setBtnLabel\(btn,/.test(sb) && !/btn\.innerText/.test(sb),
    "innerText would delete the icon and the badge");
  check("...and never re-enables the button mid-flight",
    /_recSaving/.test(sb), "a second batch could go out over the first");
  check("recSaveAll refuses to start twice",
    /function recSaveAll\(after\)[\s\S]{0,600}?if \(_recSaving\) \{ done\(false\); return; \}/.test(recBlock),
    "two batches would write the same rows");
  check("visibility is imperative, not permission-req",
    /recCanEdit\(\) \? 'inline-block' : 'none'/.test(sb) &&
    !/id="btnRecSave"[^>]*data-perm=/.test(HTML),
    "hasPermission does not expand manage_recruitment, so the UI would be stricter " +
    "than the server for a manager");
}

console.log("\n5.2 a row added but not saved never reaches the sheet");
{
  // ⚠️ THE BUG THIS SECTION EXISTS FOR, reported from staging: ＋行を追加 used to
  // append a blank row on the server the instant it was clicked. So 「行を追加」 always
  // wrote, whatever you did next, and 保存せずに移動 could not take it back — it
  // discarded the queued FIELD edits and left the row behind.
  const recBlock = HTML.slice(HTML.indexOf('function recLoad('),
                              HTML.indexOf('function renderPastInterviewsTable'));

  // (a) no add may call the server any more.
  [['recAddVisaRow', 'addOtherVisaRow'],
   ['recAddCancelRow', 'addCancelRow'],
   ['recAddNotIssuedRow', 'addNotIssuedRow']].forEach(function (pair) {
    const at = recBlock.indexOf('function ' + pair[0]);
    const body = recBlock.slice(at, recBlock.indexOf('\n      }', at));
    check(pair[0] + " sends nothing — the row is local until 保存",
      at !== -1 && body.indexOf('apiRun(') === -1 && body.indexOf('.' + pair[1] + '(') === -1,
      "the row would be in the sheet before the user pressed 保存");
    check("..." + pair[0] + " marks it unsaved",
      body.indexOf('_recPendingId') !== -1 || body.indexOf('_pendingId: pid') !== -1,
      "without a _pendingId the row is indistinguishable from a saved one");
    check("..." + pair[0] + " updates the badge",
      body.indexOf('_recSetSaveBtn()') !== -1, "the count would not move");
  });

  // (b) a pending row counts as ONE, with no per-field entries.
  check("a pending ROW counts, its fields do not",
    /_recPendingRows\(\)\.length/.test(HTML) &&
    !/Object\.keys\(_recPendingEdits\)/.test(HTML),
    "counting per field would double-count and outlive the row");
  check("_recPendingRows is derived from the model, not a parallel list",
    /function _recPendingRows\(\)[\s\S]{0,600}?r\._pendingId/.test(HTML) &&
    /otherVisa[\s\S]{0,200}?cancels[\s\S]{0,200}?notIssued/.test(
      HTML.slice(HTML.indexOf('function _recPendingRows'),
                 HTML.indexOf('function _recPendingRows') + 700)),
    "a second list drifts — this file's oldest bug class");

  // (c) the whole in-flight machinery is gone, everywhere in the file.
  ['_recConfirmPendingRow', '_recHoldPendingEdit', '_recAddInFlight',
   '_recPendingEdits', '_recPendingAdds'].forEach(function (nm) {
    const hits = (HTML.match(new RegExp(nm, 'g')) || []).length;
    const inComment = nm === '_recConfirmPendingRow' ? 1 : 0;   // one historical note
    check(nm + " is gone", hits <= inComment,
      "found " + hits + " — the session-reset block at the top is the easy one to miss");
  });

  // (d) deleting a local row is local.
  ['recDeleteVisaRow', 'recDeleteCancelRow', 'recDeleteNotIssuedRow'].forEach(function (fn) {
    const at = recBlock.indexOf('function ' + fn);
    const body = recBlock.slice(at, recBlock.indexOf('\n      }', at));
    check(fn + " drops a local row without a server call",
      at !== -1 && /_recIsPending\(rowIndex\)[\s\S]{0,140}?_recDropPendingRow\(/.test(body),
      "it used to refuse outright, so an unsaved row could not be removed");
    check("..." + fn + " still uses _recDropRow for a REAL row",
      body.indexOf('_recDropRow(') !== -1,
      "deletes stay immediate, and their renumbering with them");
  });
  {
    const at = recBlock.indexOf('function _recDropPendingRow');
    const body = recBlock.slice(at, recBlock.indexOf('\n      }', at));
    check("_recDropPendingRow never renumbers",
      at !== -1 && body.indexOf('_sheetRow') === -1 && body.indexOf('splice') !== -1,
      "the sheet never saw this delete, so shifting later rows corrupts them");
  }

  // (d2) discarding must take the local rows with it.
  {
    const at = HTML.indexOf('function _recDiscardDirty');
    const body = HTML.slice(at, HTML.indexOf('\n      }', at));
    check("_recDiscardDirty drops rows that were only ever local",
      at !== -1 && /_recPendingRows\(\)\.forEach[\s\S]{0,200}?splice\(at, 1\)/.test(body),
      "保存せずに移動 would leave the new rows on screen");
    // ⚠️ switchSubTab only calls recLoad() when !recLoaded, so after 保存せずに移動 to
    // another tab the stale model would be re-rendered on the way back.
    check("...and forces a reload next time 募集状況 is opened",
      /recLoaded = false;/.test(body),
      "leaving and returning would show the discarded rows again");
  }

  // (e) one add op per row, carrying the whole row.
  const sa = recBlock.slice(recBlock.indexOf('function recSaveAll'),
                            recBlock.indexOf('function _recRowFields'));
  check("recSaveAll emits one op per pending row",
    /_recPendingRows\(\)\.forEach[\s\S]{0,300}?t: REC_ADD_OP\[p\.kind\]/.test(sa),
    "a row with no op is silently dropped on save");
  check("...carrying the whole row's fields",
    /fields: _recRowFields\(p\)/.test(sa), "an empty row would be appended");
  check("...and 種別 on キャンセル only",
    /if \(p\.kind === 'cancel'\) op\.kind = p\.row\.kind;/.test(sa),
    "addCancelRow rejects a blank 種別");
  const rf = recBlock.slice(recBlock.indexOf('function _recRowFields'),
                            recBlock.indexOf('function _recSaveAllDone'));
  check("_recRowFields reads the LIVE inputs first",
    /document\.querySelector\('\[data-row="/.test(rf) && /el \? el\.value :/.test(rf),
    "onchange has not fired for a field that still has focus");

  // (f) ⚠️ the duplicate-row rule.
  const done = recBlock.slice(recBlock.indexOf('function _recSaveAllDone'),
                              recBlock.indexOf('// ---- Unsaved-work guard'));
  check("a landed add forces a reload even on a partly-failed batch",
    /addLanded = true/.test(done) && /if \(addLanded && !waiting\) recLoad\(\);/.test(done),
    "the model would keep the row as pending while it exists in the sheet, and the " +
    "next 保存 would create it a second time");

  // ⚠️ Regression shipped at v149 and found by this suite: `done` is the wrapper and
  // is always truthy, so testing it stood in for "a caller is waiting" and silently
  // stopped the post-save reload from ever running.
  check("'a caller is waiting' is a flag, not the truthiness of the callback",
    /const waiting = !!after;/.test(recBlock) && /if \(waiting\) \{ done\(true\); return; \}/.test(done),
    "if (done) is always true, so a clean 保存 would never resync 残枠");
}

console.log("\n6.2 the unsaved-work modal offers to SAVE, not just to discard");
{
  const recBlock = HTML.slice(HTML.indexOf('function recLoad('),
                              HTML.indexOf('function renderPastInterviewsTable'));

  // ⚠️ A confirm() can only ask two things, and its OK silently threw the work
  // away. The user reported that; three buttons make 保存して移動 the obvious one.
  const m = HTML.slice(HTML.indexOf('id="recUnsavedModal"'),
                       HTML.indexOf('id="recUnsavedModal"') + 1400);
  check("the modal exists", HTML.indexOf('id="recUnsavedModal"') !== -1, "no modal");
  ['recUnsavedSaveAndGo()', 'recUnsavedDiscardAndGo()', 'recUnsavedCancel()']
    .forEach(function (fn) {
      check("...wired to " + fn, m.indexOf(fn) !== -1, "button missing");
    });
  check("...and names the count", /id="recUnsavedCount"/.test(m), m.slice(0, 200));
  check("...above 入学期追加, which can be open underneath it",
    /id="recUnsavedModal"[^>]*z-index:\s*10(0[5-9]|[1-9]\d)\d*/.test(m),
    "the prompt would sit behind the dialog that raised it");
  check("...using .modal-actions, which stacks the three on a phone",
    /class="modal-actions"/.test(m), "three side-by-side buttons do not fit 390px");

  check("no confirm() is left guarding unsaved work",
    !/confirm\("保存していない入力/.test(HTML),
    "the two-answer prompt is what was replaced");

  const g = recBlock.slice(recBlock.indexOf('function _recGuardDirty'),
                           recBlock.indexOf('function recIntakeChanged'));
  check("_recGuardDirty opens the modal and returns false",
    /recUnsavedModal'\)\.style\.display = 'flex';\s*\n\s*return false;/.test(g),
    "the caller must not proceed while the question is open");
  check("...but still answers true synchronously when nothing is dirty",
    /if \(recDirtyCount\(\) === 0\) return true;/.test(g),
    "every clean navigation would cost a callback round trip");
  check("...and takes the callbacks before running either",
    /_recUnsavedGo = _recUnsavedStay = null;/.test(g),
    "a stale pair would fire the previous navigation");

  // ⚠️ 保存して移動 must not move on a partly-failed batch: the red markers left
  // behind are the entire reason to stay and look.
  check("保存して移動 moves only when everything saved",
    /recSaveAll\(function\(okAll\)\{[\s\S]{0,140}?if \(okAll\)[\s\S]{0,60}?else if \(cb\.stay\)/.test(g),
    "a failed save would navigate away from the errors");

  check("recSaveAll reports completion to its caller",
    /function recSaveAll\(after\)/.test(recBlock) &&
    /const done = function\(okAll\)\{ if \(after\) after\(!!okAll\); \};/.test(recBlock),
    "保存して移動 has nothing to wait on");
  check("...and a waiting caller replaces the reload rather than adding one",
    /if \(waiting\) \{ done\(true\); return; \}\s*\n\s*recLoad\(\);/.test(recBlock),
    "the intake being left would be re-fetched for nothing");

  // The three navigations hand over what to do rather than reading a return value.
  check("switchSubTab hands the guard a way to finish the switch",
    /_recLeaveGuard\(subTabName, function\(\)\{ switchSubTab\(subTabName\); \}\)/.test(HTML),
    "答えたあと移動しない — the user would have to click the tab twice");
  check("switchMainTab does too",
    /_recLeaveGuard\(null, function\(\)\{ switchMainTab\(tabName\); \}\)/.test(HTML),
    "same, for the main tabs");
  const ic = recBlock.slice(recBlock.indexOf('function recIntakeChanged'),
                            recBlock.indexOf('function recSaveCell'));
  check("recIntakeChanged restores the select on キャンセル AND on a failed save",
    /const restore = function\(\)\{ sel\.value = _recLoadedIntake \|\| ""; \};/.test(ic) &&
    /_recGuardDirty\(function\(\)\{ recLoad\(\); \}, restore\)/.test(ic),
    "the dropdown would show an intake that was never loaded");
}

console.log("\n6.1 the server side");
{
  const b = CODE.slice(CODE.indexOf('function saveRecruitmentBatch'),
                       CODE.indexOf('\n// ---- 留学ビザ以外'));
  check("saveRecruitmentBatch exists", b.length > 200, String(b.length));
  check("it is guarded by _hasRecruitPerm_, which consults the session",
    /_hasRecruitPerm_\(role, perms, "edit_recruitment"\)/.test(b),
    "an unguarded batch endpoint bypasses every per-op check at once");
  check("it is on the apiCall allowlist",
    /saveRecruitmentBatch: saveRecruitmentBatch,/.test(CODE), "the client cannot reach it");
  check("one op's failure does not abandon the batch",
    /try \{[\s\S]{0,260}_saveRecruitmentOp_\(/.test(b) && /catch \(e\) \{[\s\S]{0,160}results\.push/.test(b),
    "a single bad cell would strand every op after it");
  // Positional means: exactly one push per op, on BOTH branches, and the array
  // returned untouched. The client applies results[i] to ops[i].
  check("the reply is positional",
    /results: results/.test(b) &&
    (b.match(/results\.push\(\{ ok: true/g) || []).length === 1 &&
    (b.match(/results\.push\(\{ ok: false/g) || []).length === 1 &&
    !/results\.(sort|filter|reverse)\(/.test(b),
    "the client applies results[i] to ops[i]");
  check("the batch length is capped",
    /REC_BATCH_MAX/.test(b) && /const REC_BATCH_MAX = \d+;/.test(CODE),
    "a malformed client could spin the 6-minute execution limit");

  // ⚠️ Dispatch, not reimplementation. A second copy of any of these loses that
  // function's permission check, its positional column map, its _cellSafe_ wrapping
  // or its snapshot.
  const disp = CODE.slice(CODE.indexOf('function _saveRecruitmentOp_'),
                          CODE.indexOf('\n// ---- 留学ビザ以外'));
  const TARGET = {
    count: 'saveRecruitmentCount(', capacity: 'saveRecruitmentCapacity(',
    cancel: 'saveCancelCell(', visa: 'saveOtherVisaCell(',
    notissued: 'saveNotIssuedCell(', note: 'saveRecruitmentNote(',
    dates: 'saveRecruitmentDates(',
  };
  OP_KINDS.forEach(function (k) {
    check("op '" + k + "' dispatches to the existing " + TARGET[k] + ")",
      new RegExp("case \"" + k + "\":\\s*\\n\\s*return " + TARGET[k].replace('(', '\\(')).test(disp),
      "it must call the real saver, which owns the permission check for that kind");
  });
  // ⚠️ Whole-row adds dispatch too: append (for the lock, the 番号 and the row index)
  // then the same per-cell saver an edit to an existing row uses.
  [['addvisa', 'addOtherVisaRow(', 'saveOtherVisaCell'],
   ['addcancel', 'addCancelRow(', 'saveCancelCell'],
   ['addnotissued', 'addNotIssuedRow(', 'saveNotIssuedCell']].forEach(function (t) {
    check("op '" + t[0] + "' appends via " + t[1] + ") and writes via " + t[2],
      new RegExp('case "' + t[0] + '":[\\s\\S]{0,240}?' + t[1].replace('(', '\\(')).test(disp) &&
      new RegExp('case "' + t[0] + '":[\\s\\S]{0,240}?' + t[2]).test(disp),
      "reimplementing the append loses its LockService guard and its 番号");
  });
  check("the add helper skips empty fields",
    /if \(v === undefined \|\| v === null \|\| String\(v\) === ""\) return;/.test(CODE),
    "writing every blank would undo addOtherVisaRow's server-assigned 番号");

  // ⚠️ REC_ADD_FIELDS is a second copy of each saver's column map — the drift class
  // tests/visacolumns.test.js exists for. A column added to a saver but not here is
  // simply never written on a new row, silently.
  {
    const fieldsOf = function (fn) {
      const b = CODE.slice(CODE.indexOf('function ' + fn), CODE.indexOf('function ' + fn) + 700);
      const m = b.match(/const cols = \{([^}]*)\}/);
      return m ? m[1].split(',').map(function (x) { return x.split(':')[0].trim(); })
                     .filter(Boolean).sort() : null;
    };
    const listOf = function (kind) {
      const b = CODE.slice(CODE.indexOf('const REC_ADD_FIELDS'),
                           CODE.indexOf('const REC_ADD_FIELDS') + 500);
      const m = b.match(new RegExp(kind + ': \\[([^\\]]*)\\]'));
      return m ? m[1].split(',').map(function (x) { return x.trim().replace(/"/g, ''); })
                     .filter(Boolean).sort() : null;
    };
    [['visa', 'saveOtherVisaCell'], ['cancel', 'saveCancelCell'],
     ['notissued', 'saveNotIssuedCell']].forEach(function (pair) {
      const a = listOf(pair[0]), b = fieldsOf(pair[1]);
      check("REC_ADD_FIELDS." + pair[0] + " matches " + pair[1] + "'s columns",
        a && b && a.join(',') === b.join(','),
        "add list " + JSON.stringify(a) + " vs saver " + JSON.stringify(b) +
        " — a column on one side only is never written on a new row");
    });
  }

  check("no sheet is written inside the batch itself",
    !/getRange\(|appendRow\(|deleteRow\(/.test(disp),
    "reimplementing a saver drops its guard, its column map and its snapshot");

  // RE-PINNED 2026-09-11: saveRecruitmentCount no longer copies (tests/damagecontrol.test.js
  // §2); the zero-value delete's recovery is the scheduled backup. What must still hold is that
  // the batch CALLS it rather than reimplementing it.
  const sc = CODE.slice(CODE.indexOf('function saveRecruitmentCount'),
                        CODE.indexOf('function saveRecruitmentCapacity'));
  check("saveRecruitmentCount takes no copy — the scheduled backup is its recovery",
    sc.length > 100 && sc.indexOf('_snapshotSheet_') === -1, "");

  // ⚠️ Both directions: a kind the client emits with no server case saves nothing.
  const clientKinds = new Set();
  const recBlock = HTML.slice(HTML.indexOf('function recLoad('),
                              HTML.indexOf('function renderPastInterviewsTable'));
  (recBlock.match(/\bt: '([a-z]+)'/g) || []).forEach(function (m) {
    clientKinds.add(m.replace(/.*'([a-z]+)'.*/, '$1'));
  });
  const addMap = HTML.slice(HTML.indexOf('const REC_ADD_OP'),
                            HTML.indexOf('const REC_ADD_OP') + 200);
  (addMap.match(/'(add[a-z]+)'/g) || []).forEach(function (m) {
    clientKinds.add(m.replace(/'/g, ''));
  });
  check("REC_ADD_OP names all three rosters",
    ['addvisa', 'addcancel', 'addnotissued'].every(function (k) { return clientKinds.has(k); }),
    "a roster with no add op can never save a new row");
  const serverKinds = new Set((disp.match(/case "([a-z]+)":/g) || [])
    .map(function (m) { return m.replace(/case "([a-z]+)":/, '$1'); }));
  const noCase = [...clientKinds].filter(function (k) { return !serverKinds.has(k); });
  const noEmit = [...serverKinds].filter(function (k) { return !clientKinds.has(k); });
  check("every op the client emits has a server case", noCase.length === 0,
    "emitted with no case: " + noCase.join(", ") + " — saves nothing, silently");
  check("every server case is actually emitted", noEmit.length === 0,
    "dead cases: " + noEmit.join(", "));
}

console.log("\n7. mutation check — these assertions fail against the OLD behaviour");
{
  // ⚠️ A test that passes against both shapes is worth nothing. Each of these
  // reconstructs the pre-change code and asserts the check above rejects it.
  const oldSaver = `
      function recSaveCancelCell(el) {
        el.style.outline = "2px solid var(--primary-color)";
        apiRun()
          .withSuccessHandler(function(){ el.style.outline = ""; })
          .saveCancelCell(currentUser.role, currentUser.permissions, el.dataset.row);
      }`;
  check("§6 would reject a saver that still writes on its own",
    oldSaver.indexOf('.saveCancelCell(') !== -1, "the LIVE_WRITES scan is vacuous");

  const oldDebounce = `_recTimers[key] = setTimeout(function(){ recFlushCell(key); }, REC_SAVE_DELAY);`;
  check("§6 would reject the surviving debounce",
    oldDebounce.indexOf('REC_SAVE_DELAY') !== -1 && oldDebounce.indexOf('_recTimers') !== -1,
    "the debounce scan is vacuous");

  const oldSelect = `onchange="recLoad()"`;
  check("§6 would reject the unguarded intake select",
    oldSelect.indexOf('recIntakeChanged') === -1, "the guard scan is vacuous");

  const oldBeforeUnload = `if (recPendingCount() > 0 || _recNoteDirty) { e.preventDefault(); }`;
  check("§6 would reject the grid-only beforeunload",
    !/recDirtyCount\(\) > 0/.test(oldBeforeUnload), "the beforeunload scan is vacuous");

  // §3's ratchet, run against the naive implementation that reads the box.
  {
    const counts = { 'C||N||R': 5 }, cancelMap = { 'C||N||R': 1 };
    let v = counts['C||N||R'];
    for (let i = 0; i < 3; i++) { v = v - cancelMap['C||N||R']; }   // box value saved as gross
    check("§3 would reject the naive 'save the box' implementation",
      v === 2, "expected the 5 → 4 → 3 → 2 walk, got " + v);
  }

  // §5's identity check, against a version that clears by key alone.
  {
    reset();
    _recSaveCancelField(2, 'name', 'old');
    const built = buildOps();
    _recSaveCancelField(2, 'name', 'new');
    built.apply.forEach(function (a) { delete _recDirtyOps[a.key]; });   // the naive clear
    check("§5 would reject clearing by key alone",
      !_recDirtyOps['cancel|2|name'], "the newer edit survived, so §5 proves nothing");
  }

  // §6's model write-back, against a _recQueueCapacity that only queues.
  {
    const naive = `function _recQueueCapacity(el, course, value, field, nat) {
        _recQueue('cap|' + course, { t: 'capacity' }, null, el);
      }`;
    check("§6 would reject a _recQueueCapacity that skips the model",
      !/recData\.capacity\[/.test(naive), "the write-back scan is vacuous");
  }
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
