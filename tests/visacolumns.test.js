// Recruitment_OtherVisa column alignment.
//
// This sheet is addressed POSITIONALLY on both sides: _getOtherVisaRows_ reads by
// 0-based array index, saveOtherVisaCell writes by 1-based column number. If the
// two ever disagree, edits land in the wrong column and nothing errors — the
// value just quietly appears under the wrong heading. Adding ビザ変更 shifted
// four columns, which is exactly when that happens.
//
// The invariant: writeColumn === readIndex + 1, for every field.

const HEADERS = ["入学期", "番号", "国籍", "名前", "現在のビザ", "ビザ変更",
                 "課程", "担当", "松野", "学費"];

// Mirrors saveOtherVisaCell in Code.js.
const WRITE_COLS = { no: 2, nationality: 3, name: 4, visa: 5, visaDesired: 6,
                     course: 7, incharge: 8, matsuno: 9, fee: 10 };

// Mirrors _getOtherVisaRows_ in Code.js.
const READ_IDX = { no: 1, nationality: 2, name: 3, visa: 4, visaDesired: 5,
                   course: 6, incharge: 7, matsuno: 8, fee: 9 };

// Mirrors the cols array in recRenderVisaTable (Index.html), in display order.
const UI_COLUMNS = [
  ['no', '番号'], ['nationality', '国籍'], ['name', '名前'],
  ['visa', '現在のビザ'], ['visaDesired', 'ビザ変更'],
  ['course', '課程'], ['incharge', '担当'], ['matsuno', '松野'], ['fee', '学費'],
];

// Mirrors _RECRUIT_RANGES.
const RANGE = { a1: 'A:J', cols: 10 };

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

console.log("\n1. Read index and write column agree for every field");
Object.keys(WRITE_COLS).forEach(function (f) {
  check(f + ": write col " + WRITE_COLS[f] + " == read idx " + READ_IDX[f] + " + 1",
    WRITE_COLS[f] === READ_IDX[f] + 1,
    "write=" + WRITE_COLS[f] + " read=" + READ_IDX[f]);
});

console.log("\n2. Each field's column carries the heading the UI shows");
UI_COLUMNS.forEach(function (pair) {
  const [field, label] = pair;
  const headerAtCol = HEADERS[WRITE_COLS[field] - 1];
  check(field + " -> " + headerAtCol, headerAtCol === label,
    "UI says '" + label + "' but column " + WRITE_COLS[field] + " is '" + headerAtCol + "'");
});

console.log("\n3. ビザ変更 sits immediately after 現在のビザ");
{
  check("adjacent in the sheet", WRITE_COLS.visaDesired === WRITE_COLS.visa + 1,
    "visa=" + WRITE_COLS.visa + " desired=" + WRITE_COLS.visaDesired);
  const ui = UI_COLUMNS.map(p => p[0]);
  check("adjacent in the UI", ui.indexOf('visaDesired') === ui.indexOf('visa') + 1, ui.join(","));
}

console.log("\n4. The batched range covers every column");
{
  check("cols count matches headers", RANGE.cols === HEADERS.length,
    RANGE.cols + " vs " + HEADERS.length);
  const lastLetter = RANGE.a1.split(':')[1];
  check("A1 range reaches the last column",
    lastLetter.charCodeAt(0) - 64 === HEADERS.length,
    RANGE.a1 + " for " + HEADERS.length + " columns");
  const maxWrite = Math.max.apply(null, Object.keys(WRITE_COLS).map(k => WRITE_COLS[k]));
  check("no field writes past the range", maxWrite <= RANGE.cols, "max write col " + maxWrite);
  const maxRead = Math.max.apply(null, Object.keys(READ_IDX).map(k => READ_IDX[k]));
  check("no field reads past the range", maxRead <= RANGE.cols - 1, "max read idx " + maxRead);
}

console.log("\n5. Every UI field exists on both sides");
UI_COLUMNS.forEach(function (pair) {
  const f = pair[0];
  check(f + " mapped both ways", WRITE_COLS[f] !== undefined && READ_IDX[f] !== undefined,
    "write=" + WRITE_COLS[f] + " read=" + READ_IDX[f]);
});

// ---------------------------------------------------------------------------
// Recruitment_Cancel and Recruitment_Notes are addressed the same positional way,
// and both gained a 担当 column on 2026-08-07. Neither was covered here before —
// the same drift that motivated this file applies to them verbatim, and on
// Recruitment_Cancel it is worse: 担当 is what a cancellation is subtracted BY, so
// a column that lands one place off subtracts from the wrong recruiter and every
// total on the page is wrong with nothing on screen to say so.
// ---------------------------------------------------------------------------

const CANCEL_HEADERS = ["入学期", "種別", "国籍", "名前", "課程", "担当"];
const CANCEL_WRITE = { nationality: 3, name: 4, course: 5, incharge: 6 };   // saveCancelCell
const CANCEL_READ  = { kind: 1, nationality: 2, name: 3, course: 4, incharge: 5 }; // _getCancelRows_
const CANCEL_RANGE = { a1: 'A:F', cols: 6 };
// recRenderCancelTable, in display order.
const CANCEL_UI = [['nationality', '国籍'], ['name', '名前'], ['course', '課程'], ['incharge', '担当']];

console.log("\n6. Recruitment_Cancel: read index and write column agree");
Object.keys(CANCEL_WRITE).forEach(function (f) {
  check("cancel " + f + ": write " + CANCEL_WRITE[f] + " == read " + CANCEL_READ[f] + " + 1",
    CANCEL_WRITE[f] === CANCEL_READ[f] + 1,
    "write=" + CANCEL_WRITE[f] + " read=" + CANCEL_READ[f]);
});

console.log("\n7. Recruitment_Cancel: headings, range and the UI line up");
{
  CANCEL_UI.forEach(function (pair) {
    const [field, label] = pair;
    const at = CANCEL_HEADERS[CANCEL_WRITE[field] - 1];
    check("cancel " + field + " -> " + at, at === label,
      "UI says '" + label + "' but column " + CANCEL_WRITE[field] + " is '" + at + "'");
  });
  check("cancel cols count matches headers", CANCEL_RANGE.cols === CANCEL_HEADERS.length,
    CANCEL_RANGE.cols + " vs " + CANCEL_HEADERS.length);
  check("cancel A1 range reaches the last column",
    CANCEL_RANGE.a1.split(':')[1].charCodeAt(0) - 64 === CANCEL_HEADERS.length,
    CANCEL_RANGE.a1 + " for " + CANCEL_HEADERS.length);
  const maxW = Math.max.apply(null, Object.keys(CANCEL_WRITE).map(k => CANCEL_WRITE[k]));
  check("no cancel field writes past the range", maxW <= CANCEL_RANGE.cols, "max " + maxW);
  const maxR = Math.max.apply(null, Object.keys(CANCEL_READ).map(k => CANCEL_READ[k]));
  check("no cancel field reads past the range", maxR <= CANCEL_RANGE.cols - 1, "max " + maxR);
  // 種別 is fixed at creation — it is the group a row renders under, and there is
  // no UI to change it, so it must NOT be writable through saveCancelCell.
  check("種別 is not writable per-cell", CANCEL_WRITE.kind === undefined,
    "a writable 種別 would move a row between groups with no re-render");
  check("入学期 is not writable per-cell", CANCEL_WRITE.intake === undefined, "");
  // The three fields that name the grid cell a cancellation comes off.
  ['course', 'nationality', 'incharge'].forEach(function (f) {
    check("cancel " + f + " is readable and writable", CANCEL_WRITE[f] !== undefined && CANCEL_READ[f] !== undefined,
      "the subtraction needs all three; a missing one silently attributes to nobody");
  });
}

// ---- Recruitment_NotIssued (不交付) ----------------------------------------
//
// Same positional trap as the two rosters above, and the same silence when it
// drifts: a mismatch writes under the wrong heading and never errors.
//
// ⚠️ The DIFFERENCE from キャンセル is the point of the sheet: 不交付 subtracts on
// 課程 ALONE, from 定員・残枠 only. 国籍 and 担当 are recorded for reference, so a
// row counts the moment a course is chosen. Nothing here should imply the three
// fields are jointly required.
const NI_HEADERS = ["入学期", "国籍", "名前", "課程", "担当"];
const NI_RANGE = { a1: 'A:E', cols: 5 };
const NI_WRITE = { nationality: 2, name: 3, course: 4, incharge: 5 };   // saveNotIssuedCell
const NI_READ  = { nationality: 1, name: 2, course: 3, incharge: 4 };   // _getNotIssuedRows_
// recRenderNotIssuedTable, in display order.
const NI_UI = [['nationality', '国籍'], ['name', '名前'], ['course', '課程'], ['incharge', '担当']];

console.log("\n7.1 Recruitment_NotIssued: read index and write column agree");
Object.keys(NI_WRITE).forEach(function (f) {
  check("notIssued " + f + ": write " + NI_WRITE[f] + " == read " + NI_READ[f] + " + 1",
    NI_WRITE[f] === NI_READ[f] + 1,
    "write=" + NI_WRITE[f] + " read=" + NI_READ[f]);
});

console.log("\n7.2 Recruitment_NotIssued: headings, range and the UI line up");
{
  NI_UI.forEach(function (pair) {
    const field = pair[0], label = pair[1];
    const at = NI_HEADERS[NI_WRITE[field] - 1];
    check("notIssued " + field + " -> " + at, at === label,
      "UI says '" + label + "' but column " + NI_WRITE[field] + " is '" + at + "'");
  });
  check("notIssued cols count matches headers", NI_RANGE.cols === NI_HEADERS.length,
    NI_RANGE.cols + " vs " + NI_HEADERS.length);
  check("notIssued A1 range reaches the last column",
    NI_RANGE.a1.split(':')[1].charCodeAt(0) - 64 === NI_HEADERS.length,
    NI_RANGE.a1 + " for " + NI_HEADERS.length);
  const maxW = Math.max.apply(null, Object.keys(NI_WRITE).map(function (k) { return NI_WRITE[k]; }));
  check("no notIssued field writes past the range", maxW <= NI_RANGE.cols, "max " + maxW);
  const maxR = Math.max.apply(null, Object.keys(NI_READ).map(function (k) { return NI_READ[k]; }));
  check("no notIssued field reads past the range", maxR <= NI_RANGE.cols - 1, "max " + maxR);
  check("入学期 is not writable per-cell", NI_WRITE.intake === undefined,
    "it is fixed at creation and selects which intake the row belongs to");
  // ⚠️ There is no 種別 here at all — 不交付 is one category, so a 種別 column would
  // be a group that never groups anything.
  check("there is no 種別 column", NI_HEADERS.indexOf("種別") === -1, NI_HEADERS.join(","));
  check("課程 is readable and writable", NI_WRITE.course !== undefined && NI_READ.course !== undefined,
    "課程 alone names the 定員・残枠 row this comes off");

  // The real source has to match the table above.
  const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'Code.js'), 'utf8');
  check("Code.js declares the same headers",
    /sh\.appendRow\(\["入学期", "国籍", "名前", "課程", "担当"\]\)/.test(CODE), "");
  check("Code.js declares the same write map",
    /const cols = \{ nationality: 2, name: 3, course: 4, incharge: 5 \};/.test(CODE), "");
  check("Code.js registers the same batch range",
    /sheet: SHEET_RECRUIT_NOTISSUED, a1: 'A:E', cols: 5/.test(CODE), "");
  check("NOTISSUED_COLS matches the header count",
    new RegExp("const NOTISSUED_COLS = " + NI_HEADERS.length + ";").test(CODE), "");
}

const NOTE_HEADERS = ["入学期", "内容", "更新者", "更新日時", "リスト提出日", "申請日", "結果", "担当"];
const NOTE_RANGE = { a1: 'A:H', cols: 8 };
// getRecruitmentNote reads these 0-based indices.
const NOTE_READ = { html: 1, by: 2, at: 3, listDate: 4, applyDate: 5, resultDate: 6, charge: 7 };

console.log("\n8. Recruitment_Notes: 担当 sits after 結果, inside the range");
{
  check("担当 is the last column", NOTE_HEADERS[NOTE_HEADERS.length - 1] === "担当", NOTE_HEADERS.join(","));
  check("担当 immediately follows 結果", NOTE_READ.charge === NOTE_READ.resultDate + 1,
    "result=" + NOTE_READ.resultDate + " charge=" + NOTE_READ.charge);
  check("cols count matches headers", NOTE_RANGE.cols === NOTE_HEADERS.length,
    NOTE_RANGE.cols + " vs " + NOTE_HEADERS.length);
  check("A1 range reaches the last column",
    NOTE_RANGE.a1.split(':')[1].charCodeAt(0) - 64 === NOTE_HEADERS.length,
    NOTE_RANGE.a1 + " for " + NOTE_HEADERS.length);
  // ⚠️ saveRecruitmentNote owns columns 2-4 and saveRecruitmentDates owns 5-8.
  // They share a row only because those blocks are disjoint; an overlap would make
  // whichever saved last silently wipe the other's field.
  const NOTE_WRITER = [2, 3, 4], DATES_WRITER = [5, 6, 7, 8];
  check("the two writers' column blocks do not overlap",
    NOTE_WRITER.every(c => DATES_WRITER.indexOf(c) === -1),
    "note writes " + NOTE_WRITER + ", dates writes " + DATES_WRITER);
  check("every read index is inside the range",
    Object.keys(NOTE_READ).every(k => NOTE_READ[k] <= NOTE_RANGE.cols - 1),
    JSON.stringify(NOTE_READ));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
