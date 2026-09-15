// Shinsei_Data's positional contract.
//
// ⚠️ WHY. Every column in Shinsei_Data is anonymous — the form field's `id` IS its column
// number — so the sheet width appears in the backend as a bare literal. It was `46`,
// repeated in SIX places (an array size, five loop bounds, and a getRange width), and
// 入学期 made it 47. A width that lands in five of six shifts every value one column left
// and corrupts silently: no error, no visible failure, just wrong data on the next save.
// That is this app's worst bug class (CLAUDE.md §8.3).
//
// So the width is ONE constant, and this file exists to keep it that way.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'Shinsei_Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
// ⚠️ Comments stripped: the comment that explains the contract QUOTES the literal it
// replaced, so a raw scan reports the explanation as the violation.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

console.log("\n1. the width is one constant");
{
  const m = CODE.match(/const SHINSEI_COLS = (\d+);/);
  check("SHINSEI_COLS is declared", !!m, "the literal is back, in an unknown number of places");
  const COLS = m ? parseInt(m[1], 10) : -1;
  check("...exactly once", (CODE.match(/const SHINSEI_COLS =/g) || []).length === 1, "");
  check("...and it is 48 (the extras blob is the newest column)", COLS === 48, String(COLS));

  // ⚠️ THE check. Any surviving bare width is a place the next column will not reach.
  const bare = (CODE.match(/new Array\(4[0-9]\)|<=\s*4[0-9];|getRange\([^)]*,\s*4[0-9]\)/g) || []);
  check("⚠️ no bare column-count literal survives", bare.length === 0,
    "found: " + bare.join(", ") + " — this is exactly how a widening half-lands");

  // ⚠️ Two shapes that differ by one, and mixing them is its own silent bug.
  check("the 0-based sheet row uses SHINSEI_COLS",
    /new Array\(SHINSEI_COLS\)\.fill/.test(CODE), "index 0 = column A");
  // ⚠️ RE-PINNED, never loosened: 3 → 2 and 5 → 4 when the export's and the preview's
  // copies of the row lookup collapsed into _shinseiRowFor_. Re-pin when a reduction is
  // intended; a >= would stop caring what the number is.
  check("...and the 1-based aligned array uses SHINSEI_COLS + 1",
    (CODE.match(/new Array\(SHINSEI_COLS \+ 1\)\.fill/g) || []).length === 2,
    "index 1 = column A; one short and the last column is dropped");
  check("every loop bound reads the constant",
    (CODE.match(/i <= SHINSEI_COLS;/g) || []).length === 4, "");
  check("the write width reads it too",
    /getRange\(targetRow, 1, 1, SHINSEI_COLS\)/.test(CODE), "");
}

console.log("\n2. the form and the sheet agree");
{
  const seg = HTML.slice(HTML.indexOf('const shinseiFormGroups = ['),
                         HTML.indexOf('function shinseiCreateFieldEl'));
  const ids = (seg.match(/\{ id: (\d+), label:/g) || []).map(function (t) {
    return parseInt(t.match(/\d+/)[0], 10); });
  check("the form fields were found", ids.length >= 45, "found " + ids.length);
  check("...no id is used twice", new Set(ids).size === ids.length,
    "two fields sharing a column silently overwrite each other");
  const COLS = parseInt((CODE.match(/const SHINSEI_COLS = (\d+);/) || [0, '0'])[1], 10);
  check("⚠️ the highest field id equals SHINSEI_COLS", Math.max.apply(null, ids) === COLS,
    "max id " + Math.max.apply(null, ids) + " vs SHINSEI_COLS " + COLS +
    " — a field beyond the width is written nowhere, one short leaves a dead column");
  check("...and every id is in range", ids.every(function (i) { return i >= 1 && i <= COLS; }), "");
  // ⚠️ 入学期 is NO LONGER the last column, and this assertion used to say it was.
  // The pair below is the whole point: the column is NAMED, and the reader derives from
  // that name — not from the width.
  const INTAKE_COL = parseInt((CODE.match(/const SHINSEI_INTAKE_COL = (\d+);/) || [0, '0'])[1], 10);
  check("⚠️ 入学期's column is a NAMED constant", INTAKE_COL === 47, String(INTAKE_COL));
  check("...and the form agrees",
    new RegExp('\\{ id: ' + INTAKE_COL + ', label: "入学期"').test(seg), "");

  // ⚠️ THIS CHECK USED TO ASSERT THE BUG. It required `INTAKE_IDX = SHINSEI_COLS - 1`,
  // i.e. "入学期 is the last column" — true only by coincidence. Widening the sheet to 48
  // moved the intake reader silently onto the new column: the dropdown would fill with
  // JSON blobs, shinseiBatchTargets would group by them, and every record would read as
  // 未設定. No error, and the suite would have PASSED. The two facts are now independent.
  check("⚠️ INTAKE_IDX derives from the COLUMN, never from the width",
    /const INTAKE_IDX = SHINSEI_INTAKE_COL - 1;/.test(CODE)
      && !/INTAKE_IDX = SHINSEI_COLS/.test(CODE),
    "tying it to the width means the next column steals 入学期 out from under the filter");
  check("...and the two constants are separate declarations",
    /const SHINSEI_COLS = \d+;/.test(CODE) && /const SHINSEI_INTAKE_COL = \d+;/.test(CODE)
      && COLS !== INTAKE_COL,
    "equal values would let a single literal serve both again");

  // Column 48 itself: the blob, and the ONLY field that is not on screen.
  check("⚠️ column 48 is a hidden field, not a visible one",
    /\{ id: 48, label: "", type: "hidden" \}/.test(seg),
    "the extras blob is JSON — rendered as a text box it is an invitation to hand-edit it");
}

console.log("\n3. ⚠️ free text no longer reaches the sheet unguarded");
{
  // This module had NO guard at all: 教育機関名, 所在地 and その他 went straight in, so a
  // value starting with = ran as a formula the next time anyone opened the workbook.
  check("⚠️ the insert path is wrapped", /appendRow\(_cellSafeRow_\(newRow\)\)/.test(CODE),
    "the formula-injection hole the rest of the app guards");
  check("⚠️ the update path is wrapped",
    /setValues\(\[_cellSafeRow_\(valuesToSet\)\]\)/.test(CODE), "");
  check("...and nothing writes around them",
    !/appendRow\((?!_cellSafeRow_)/.test(CODE) && !/setValues\(\[(?!_cellSafeRow_)/.test(CODE),
    "a third write site would be unguarded again");
}

console.log("\n4. 一括出力 is scoped, and the picker cannot be empty for the old reason");
{
  const batch = HTML.slice(HTML.indexOf('function shinseiExportBatch()'),
                           HTML.indexOf('function shinseiShowStatus'));
  check("⚠️ the batch reads the FILTERED model, not the datalist",
    /shinseiBatchTargets\(\)/.test(batch) && !/studentDatalist/.test(batch),
    "the datalist is every student — the thing 一括出力 must stop meaning");
  check("...and the confirm names the intake and the count",
    /confirm\(label \+ ' の ' \+ students\.length \+ '名分/.test(batch),
    "a batch that does not say what it covers is how the wrong one gets run");
  // ⚠️ 未設定 must stay exportable: every record predates the field.
  check("⚠️ 未設定 is a selectable group",
    /__NONE__/.test(HTML) && /未設定 \(/.test(HTML),
    "otherwise the whole existing library is unexportable until it is backfilled");
  // ⚠️ The trap that emptied the last 入学期 select.
  // ⚠️ Comments stripped: the comment WARNING about _recExtraIntakes names it, so a raw
  // scan reports the warning as the violation. Seventh time in this repo.
  const popFn = HTML.slice(HTML.indexOf('function shinseiPopulateDropdowns'),
                           HTML.indexOf('function shinseiBatchTargets'))
                    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check("⚠️ the intake options are NOT taken from _recExtraIntakes",
    !/_recExtraIntakes/.test(popFn),
    "that is populated only by 募集状況, and left the last such select empty with no " +
    "explanation for anyone who had not opened that tab");
  // ⚠️ ONE reader. A hand-rolled copy here read Recruitment_Meta alone and shipped an
  // EMPTY dropdown, because PlacementTest_Config is the other half of the union and is
  // where this school actually registers its intakes. _calCellState, one file later.
  check("⚠️ the intake list comes from _allKnownIntakes_(), not a second copy",
    /intakes = _allKnownIntakes_\(\) \|\| \[\];/.test(CODE),
    "PlacementTest_Config ∪ Recruitment_Meta — reading either alone is a half-empty list");
  check("...and nothing re-reads Recruitment_Meta here",
    !/SHEET_RECRUIT_META/.test(CODE),
    "the union lives in Code.js and must not be restated");
  check("...while an intake only the 申請 data knows is still offered",
    /Object\.keys\(seen\)\.sort\(\)\.forEach\(function \(v\) \{ if \(!known\[v\]\) intakes\.push\(v\); \}\);/.test(CODE),
    "otherwise that record is unreachable from its own group in 一括出力");
}

console.log("\n5. one page");
{
  check("the PDF出力 sub-view is gone", !/id="shinsei-view-export"/.test(HTML), "");
  check("...its sub-nav button too", !/btn-shinsei-export/.test(HTML), "");
  check("⚠️ ...and switchShinseiTab no longer names it",
    /\['entry'\]\.forEach/.test(HTML),
    "it names its tabs literally, so a removed sub-view must leave the list too");
  check("⚠️ the duplicate student picker is gone",
    !/shinsei-exportStudentSearch/.test(HTML),
    "picking the same student twice is the redundancy this removed");
  check("...single export acts on the loaded record",
    /if \(!shinseiCurrentEditName\) \{/.test(HTML), "");
  check("⚠️ ...and the buttons are disabled until one is loaded",
    /function shinseiSyncExportButtons\(\)/.test(HTML)
      && (HTML.match(/shinseiSyncExportButtons\(\);/g) || []).length >= 3,
    "in 新規作成 they would mean 'export what?'");
}

console.log("\n6. the CLIENT half of the width, and 入学期 as a dropdown");
{
  // ⚠️ WHY THIS SECTION EXISTS. §1 scans Shinsei_Code.js only. Index.html carried its OWN
  // two copies of the width — `for (let i = 1; i <= 46; i++)` in shinseiPopulateFormForEdit
  // and in shinseiSubmitForm — and neither moved when 入学期 became column 47. The field
  // was therefore WRITE-DEAD: it loaded nothing back and sent nothing, so every save wrote
  // an empty 入学期 over the sheet while the backend was entirely correct. The width does
  // not live in one file, and assuming it did is what let this through.
  const from = HTML.indexOf('const shinseiFormGroups');
  const to = HTML.indexOf('function shinseiShowStatus');
  // ⚠️ Comments stripped, and the `:` guard keeps https:// out of it. The comments here
  // quote the very literals being banned. Eighth time in this repo.
  const SH = HTML.slice(from, to)
                 .replace(/\/\*[\s\S]*?\*\//g, '')
                 .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check("the 申請関連 block was located", from > 0 && to > from, from + ".." + to);

  // ⚠️ 4[6-8], not 4[67]: the ban has to cover the width the sheet has NOW, or the next
  // hardcoded bound sails straight through the check that exists to catch it.
  check("⚠️ NO bare width literal survives in the client block",
    !/<=\s*4[6-8]\b/.test(SH),
    "the two loops bound at 46 are exactly how column 47 shipped write-dead");
  check("...both loops read SHINSEI_MAX_COL",
    (SH.match(/i\s*<=\s*SHINSEI_MAX_COL/g) || []).length === 2,
    "found " + (SH.match(/i\s*<=\s*SHINSEI_MAX_COL/g) || []).length);
  check("⚠️ SHINSEI_MAX_COL is DERIVED from the form, not a second literal",
    /const SHINSEI_MAX_COL = Math\.max\.apply\(null, shinseiAllFields\(\)\.map\(f => f\.id\)\)/.test(SH),
    "a number here is a third copy of the width, free to drift from both the sheet and the form");

  check("⚠️ 入学期 is a select, not free text",
    /\{ id: 47, label: "入学期", type: "select", options: \[""\], dynamic: "intakes" \}/.test(SH),
    "it is compared as a name string, so a trailing space makes a record its own invisible group");
  check("...its options are not hardcoded",
    !/dynamic: "intakes"[^\n]*20\d\d/.test(SH) && !/options: \["", *"20\d\d/.test(SH),
    "the vocabulary is the server's — 申請 data ∪ Recruitment_Meta");
  check("⚠️ the form field is found by its marker, never by the literal 47",
    /f\.dynamic === 'intakes'/.test(SH) && !/elements\['scol47'\]/.test(SH),
    "the column number is the thing this module keeps getting wrong");

  // ⚠️ Count the CALL SITES, not the name: `function shinseiIntakeOptionHtml()` matches
  // the same pattern, so a >= 2 count passed with the definition plus ONE call — the
  // declaration counted as a use. Both sites are named instead.
  check("⚠️ ONE list feeds both selects — the 一括出力 filter",
    /すべて<\/option>' \+ shinseiIntakeOptionHtml\(\)/.test(SH),
    "the form field and the filter disagreeing about the vocabulary is the _calCellState mistake");
  check("...and the form field",
    /<option value=""><\/option>' \+ shinseiIntakeOptionHtml\(\)/.test(SH),
    "⚠️ the leading blank option is required — 未設定 is a real state for every existing record");
  // ⚠️ An empty dropdown that says nothing is how the last 入学期 select stayed broken.
  check("⚠️ an empty list says WHY it is empty",
    /_shinseiIntakes\.length\s*\n?\s*\?/.test(SH) && /入学期が登録されていません/.test(SH),
    "a silently blank select is indistinguishable from a loading failure");
  check("...and it is the server's list",
    /_shinseiIntakes = \(res && res\.intakes\) \|\| \[\];/.test(SH), "");

  // ⚠️ A <select> given a value absent from its options falls back to option 0 SILENTLY.
  check("⚠️ an unrecognised stored intake is carried as its own option",
    /function shinseiSelectSetValue\(el, v\)/.test(SH)
      && /el\.appendChild\(opt\);/.test(SH)
      && /el\.style\.color = '#e74a3b';/.test(SH),
    "without this the screen shows one intake, the sheet holds another, and the next " +
    "データ更新 writes the wrong one back — silently");
  check("...and the read-back routes every SELECT through it",
    /if \(el\.tagName === 'SELECT'\) shinseiSelectSetValue\(el, dataArray\[i\] \|\| ''\);/.test(SH),
    "a bare .value = on a select is the silent-fallback path");
  check("⚠️ 新規作成 rebuilds the list after reset",
    /\.reset\(\);\s*shinseiFillIntakeField\(\);/.test(SH),
    "reset() leaves a carried 「（一覧にありません）」 option selectable for a new record");
}

console.log("\n7. three modes, two panes");
{
  // ⚠️ WHY. shinseiSetMode named its two buttons a line each and branched
  // `if (create) … else …`, where the else MEANT edit. A third mode added that way falls
  // into the else, focuses a hidden search box and announces 「Editモードに切替えました」 —
  // the trap switchDormSubTab was rewritten to avoid and switchAdmissionsSubTab still has.
  const fn = HTML.slice(HTML.indexOf('function shinseiSetMode'),
                        HTML.indexOf('let shinseiSearchTimer'));

  ['create', 'edit', 'pdf'].forEach(function (m) {
    check("the " + m + " chip exists", new RegExp('id="shinsei-mode-' + m + '"').test(HTML), "");
  });
  check("...and there are exactly three",
    (HTML.match(/id="shinsei-mode-[a-z]+"/g) || []).length === 3,
    "found " + (HTML.match(/id="shinsei-mode-[a-z]+"/g) || []).length);
  check("⚠️ the buttons are SWEPT, not named a line each",
    /SHINSEI_MODES\.forEach\(function \(m\) \{\s*_navToggle\('shinsei-mode-' \+ m, 'active', m === mode\);/.test(fn)
      && !/shinsei-modeCreateBtn|shinsei-modeEditBtn/.test(HTML),
    "naming two worked until there was a third");

  // ⚠️ Sweeping `shinsei-pane-<mode>` LOOKS right and is wrong: create and edit share one
  // pane, so there is no -create pane to hide and the form stayed under the PDF panel.
  // Measured, not read — it looked like a deliberate layout.
  check("⚠️ the panes are swept by PANE key, derived from the mode map",
    /const SHINSEI_PANES = SHINSEI_MODES\.map\(function \(m\) \{ return SHINSEI_MODE_PANE\[m\]; \}\)/.test(HTML)
      && /SHINSEI_PANES\.forEach\(function \(k\) \{/.test(fn),
    "create and edit share #shinsei-pane-form — a per-mode sweep never hides it");
  check("...and exactly one pane is shown",
    /el\.style\.display = \(k === SHINSEI_MODE_PANE\[mode\]\) \? '' : 'none';/.test(fn), "");
  check("⚠️ every mode has an explicit branch — no else standing in for edit",
    /\} else if \(mode === 'edit'\) \{/.test(fn), "");

  // ⚠️ Nulling the loaded record belongs to 新規作成 alone.
  const nulls = (fn.match(/shinseiCurrentEditName = null;/g) || []).length;
  check("⚠️ only 新規作成 clears the loaded record",
    nulls === 1 && fn.indexOf('shinseiCurrentEditName = null;') < fn.indexOf("else if (mode === 'edit')"),
    "found " + nulls + " — if pdf cleared it, プレビュー/単体出力 would disable at the moment " +
    "you selected the mode that uses them");

  // ⚠️ A status element inside a hidden pane reports to nothing: no error, no feedback.
  const pdfOpen  = HTML.indexOf('id="shinsei-pane-pdf"');
  const pdfClose = HTML.indexOf('<!-- /#shinsei-pane-pdf -->');
  const eStat    = HTML.indexOf('id="shinsei-entryStatus"');
  const xStat    = HTML.indexOf('id="shinsei-exportStatus"');
  check("⚠️ the ENTRY status sits OUTSIDE both panes",
    eStat > pdfClose && pdfClose > 0,
    "the picker shows in PDF mode, so a search there must still report somewhere visible");
  check("...and the EXPORT status inside the PDF pane",
    xStat > pdfOpen && xStat < pdfClose, "");
  check("...with the preview iframe",
    HTML.indexOf('id="shinsei-pdfViewer"') > pdfOpen && HTML.indexOf('id="shinsei-pdfViewer"') < pdfClose, "");
  check("⚠️ the load message does not say 編集してください in PDF mode",
    /shinseiMode === 'pdf'\s*\n?\s*\? 'データを読み込みました。出力できます。'/.test(HTML),
    "an instruction to edit on a screen with no form");

  check("the sub-tab reads 各種確認書",
    /id="btn-shinsei-entry"[^>]*>各種確認書</.test(HTML), "");
  check("⚠️ ...while its id and switchShinseiTab key stay 'entry'",
    /switchShinseiTab\('entry'\)/.test(HTML) && /\['entry'\]\.forEach/.test(HTML),
    "renaming the key would be a rename for its own sake with a broken-screen failure mode");
}

console.log("\n8. 一括出力 is ONE call and ONE conversion");
{
  // ⚠️ WHY. The batch was a CLIENT-SIDE LOOP: a round trip per student, each re-reading the
  // whole sheet for one row and invoking the converter, plus 800ms of sleep between
  // downloads. The engine was never the cost — N sheet reads, N round trips and N×800ms
  // were. Merging is only a win while it stays ONE of each.

  // ⚠️ The ~110-line row→template mapping existed TWICE (export and preview) and a third
  // copy was one merged batch away. They were byte-identical after normalisation, i.e. not
  // drifted YET — the drift arrives with the next column, and then the preview shows one
  // document and the export produces another. Structural, because a behavioural test cannot
  // see a copy that does not exist yet (the _resolveUserById_ lesson).
  check("⚠️ exactly ONE function maps a row to template fields",
    (CODE.match(/const commonInterviewCriteria =/g) || []).length === 1,
    "found " + (CODE.match(/const commonInterviewCriteria =/g) || []).length);
  check("...and it is _shinseiBuildDocHtml_",
    /function _shinseiBuildDocHtml_\(targetRow, includeCefr\) \{/.test(CODE), "");
  check("...which both single paths call",
    /const htmlContent = _shinseiBuildDocHtml_\(targetRow, includeCefr\);/.test(CODE)
      && /return _shinseiBuildDocHtml_\(targetRow, includeCefr\);/.test(CODE),
    "a second mapping drifts on the first column added");

  const merged = CODE.slice(CODE.indexOf('function shinsei_exportBatchMergedFromWebApp'),
                            CODE.indexOf('function shinsei_previewSingleFromWebApp'));
  check("the merged endpoint exists and is guarded",
    merged.length > 0 && /_requireSession_\("shinsei_exportBatchMergedFromWebApp"\)/.test(merged), "");
  check("⚠️ it reads the sheet ONCE, outside the loop",
    (merged.match(/getDataRange\(\)\.getValues\(\)/g) || []).length === 1
      && merged.indexOf('getDataRange().getValues()') < merged.indexOf('for (let i = 0'),
    "reading it per student is the cost the old loop paid N times");
  check("⚠️ ONE conversion for the whole batch",
    (merged.match(/getAs\(MimeType\.PDF\)/g) || []).length === 1,
    "N conversions inside one call would keep the engine cost the loop had");
  check("...outside the per-student loop",
    merged.indexOf('getAs(MimeType.PDF)') > merged.lastIndexOf('bodies.push('), "");
  check("⚠️ names resolve through _normName_",
    /_normName_/.test(CODE.slice(CODE.indexOf('function _shinseiRowFor_'), CODE.indexOf('function _shinseiDataSheet_'))),
    "identity by name string is this file's oldest bug class");
  check("⚠️ students are separated by an explicit page break",
    /bodies\.join\('\\n<div style="page-break-after: always;"><\/div>\\n'\)/.test(merged),
    "the template's own break sits on the OPENING div, so the last element carries none");
  check("⚠️ a student that fails is recorded, not thrown",
    /failed\.push\(list\[i\]\); continue;/.test(merged) && /\} catch \(e\) \{\s*failed\.push\(list\[i\]\);/.test(merged),
    "losing 40 students to one bad record is the regression merging would introduce");
  check("...and the caller is told which",
    /failed: failed/.test(merged) && /res\.failed\.join/.test(HTML), "");

  const batch2 = HTML.slice(HTML.indexOf('function shinseiExportBatch()'),
                            HTML.indexOf('function shinseiShowStatus'));
  check("⚠️ the client sends ONE call",
    (batch2.match(/apiRun\(\)/g) || []).length === 1
      && /\.shinsei_exportBatchMergedFromWebApp\(students, includeCefr/.test(batch2), "");
  check("⚠️ ...with no loop and no 800ms sleep",
    !/for \(let i = 0; i < students\.length/.test(batch2) && !/setTimeout\(r, 800\)/.test(batch2),
    "9.6 seconds of doing nothing for a 12-student batch");
  check("...and the confirm says it is one file now",
    /1つのPDFにまとめてダウンロードします/.test(batch2), "");

  check("⚠️ the measurement exists, because 'faster' was an estimate",
    /function profileShinseiPdf\(n\) \{/.test(CODE) && /_requireMaintenanceUnlock_\("profileShinseiPdf"\)/.test(CODE),
    "rule 8: estimates about where time goes in this app have been wrong repeatedly");
}

console.log("\n9. a repeated block starts on its own row");
{
  // ⚠️ WHY. .shinsei-form-grid is ONE 2-column grid per section and shinseiRebuildForm
  // poured fields, secondFields and thirdFields into it in a row. 試験情報's first block
  // has FIVE fields, so row 3 had a free cell in column 2 — and grid auto-placement put
  // 試験名 2回目 in it. Measured: 受験番号 at top 678 left 149, 試験名 2回目 at top 678
  // left 760, i.e. the second exam began on the first one's row with nothing marking the
  // boundary. 教育機関's two blocks are 8 fields each, so they cleared by ARITHMETIC, not
  // by design; a ninth column there brings the same bug back.
  //
  // The ＋ toggle now lives inside the grid, spanning both columns, immediately before the
  // block it reveals. A full-width item cannot fit a leftover half-row, so what follows
  // always starts fresh — for any field count, odd or even.
  const RB = HTML.slice(HTML.indexOf('function shinseiRebuildForm'),
                        HTML.indexOf('let _shAutofillTimer'))
                 .replace(/\/\*[\s\S]*?\*\//g, '')
                 .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check("shinseiRebuildForm was located", RB.length > 100 && RB.indexOf('shinsei-form-grid') > 0, "");

  // ⚠️ THE check. Back in `sec` the button is a block element after the grid, which leaves
  // the grid free to fill its own last cell with the next block's first field.
  check("⚠️ both toggles are appended to the GRID, not the section",
    /grid\.appendChild\(shinseiCreateToggleBtn\(grp\.toggleBtn\)\)/.test(RB)
      && /grid\.appendChild\(shinseiCreateToggleBtn\(grp\.toggleBtn3\)\)/.test(RB)
      && !/sec\.appendChild\(shinseiCreateToggleBtn/.test(RB)
      && !/sec\.appendChild\(btn/.test(RB),
    "outside the grid it stops being a row, and 2回目 goes back to sharing 1回目's row");

  const iFields = RB.indexOf('grp.fields.forEach');
  const iT2     = RB.indexOf('shinseiCreateToggleBtn(grp.toggleBtn)');
  const iSecond = RB.indexOf('grp.secondFields.forEach');
  const iT3     = RB.indexOf('shinseiCreateToggleBtn(grp.toggleBtn3)');
  const iThird  = RB.indexOf('grp.thirdFields.forEach');
  check("⚠️ each toggle sits BEFORE the block it reveals",
    iFields > 0 && iFields < iT2 && iT2 < iSecond && iSecond < iT3 && iT3 < iThird,
    "order was " + [iFields, iT2, iSecond, iT3, iThird].join(",") +
    " — appended after its block the button divides nothing, and ＋3回目 lands beside ＋2回目");

  // ⚠️ The two builders differed only in their spec. A second copy is how the two drift.
  check("⚠️ ONE toggle-button builder",
    (HTML.match(/className = 'shinsei-toggle-btn'/g) || []).length === 1
      && /function shinseiCreateToggleBtn\(spec\)/.test(HTML),
    "found " + (HTML.match(/className = 'shinsei-toggle-btn'/g) || []).length + " button builders");

  // The CSS half. Scoped, so specificity decides rather than source order in a 15k-line file.
  check("⚠️ the toggle spans the whole grid row",
    /\.shinsei-form-grid > \.shinsei-toggle-btn \{[^}]*grid-column: 1 \/ -1/.test(HTML),
    "without this it is an ordinary grid item and occupies ONE cell — the break is gone");
  check("...and the rule is scoped to the grid",
    !/^\s*\.shinsei-toggle-btn \{[^}]*grid-column/m.test(HTML),
    "unscoped it would also hit the buttons if they ever move back out");

  // ⚠️ The fix must not have been "one column, everything on its own line".
  check("⚠️ the grid is still two columns",
    /\.shinsei-form-grid \{ display: grid; grid-template-columns: 1fr 1fr;/.test(HTML),
    "a 49-field form in one column is not what was asked for");
}


console.log("\n10. the extras blob, and 【別紙（続き）】");
{
  // ⚠️ WHY. 2 exams and 3 教育機関 were all the sheet could hold, because each block is a run
  // of anonymous columns. Adding more AS COLUMNS would widen SHINSEI_COLS every time — the
  // failure mode the whole of §1 exists to prevent — and still cap the count. Instead one
  // column (48) holds a JSON blob of the extra blocks, so the width stops moving here, and
  // the extras print on their own 【別紙（続き）】 sheet.
  const TPL = fs.readFileSync(path.join(ROOT, 'Shinsei_Template.html'), 'utf8');
  const from = HTML.indexOf('const shinseiFormGroups');
  const SH = HTML.slice(from, HTML.indexOf('function shinseiShowStatus'))
                 .replace(/\/\*[\s\S]*?\*\//g, '')
                 .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  // ---- the blob rides the EXISTING positional machinery --------------------------------
  // ⚠️ That is the property worth pinning: no special case in populate or submit, so the
  // blob cannot be forgotten by one of the two loops the way 入学期 was.
  check("⚠️ the blob is filled BEFORE the positional loop reads it",
    SH.indexOf("els['scol48'].value = shinseiCollectExtras();") > 0
      && SH.indexOf("els['scol48'].value = shinseiCollectExtras();")
         < SH.indexOf('for (let i = 1; i <= SHINSEI_MAX_COL; i++) { formDataArray[i]'),
    "set afterwards, every save posts the PREVIOUS value");
  check("...and the read-back rebuilds the blocks",
    /shinseiApplyExtras\(dataArray\[48\] \|\| ''\);/.test(SH), "");
  check("⚠️ a hidden field is returned BARE, with no label or grid cell",
    /if \(field\.type === 'hidden'\) \{/.test(SH),
    "wrapped in .shinsei-form-group it draws an empty labelled cell in the 2-column grid");

  // ---- one vocabulary ------------------------------------------------------------------
  // ⚠️ The labels/types/options of an added block are DERIVED from the group's secondFields.
  // A second hand-written copy drifts the first time an exam name is added to the list, and
  // then the fixed and added blocks offer different options on the same form.
  check("⚠️ added blocks derive their fields from secondFields",
    /return \(\(g && g\.secondFields\) \|\| \[\]\)\.map\(/.test(SH),
    "a literal field list here is a second copy of the vocabulary");
  check("...and the ordinal is COUNTED, not typed",
    /\[g\.fields, g\.secondFields, g\.thirdFields\]\.filter\(Boolean\)\.length/.test(SH),
    "a hardcoded 2 or 3 drifts from the blocks actually rendered");
  check("⚠️ extra inputs carry NO scol name",
    /inp\.removeAttribute\('name'\);/.test(SH),
    "a positional name here collides with a real column in shinseiSubmitForm's loop");

  // ---- the states that lose data -------------------------------------------------------
  check("⚠️ empty extras serialise to '' — not '{}'",
    /return \(out\.exams\.length \|\| out\.edus\.length\) \? JSON\.stringify\(out\) : '';/.test(SH),
    "every existing record holds '' and the template branches on truthiness; '{}' would " +
    "emit an empty 【別紙（続き）】 for the entire back catalogue");
  check("⚠️ a wholly blank block is dropped, never stored",
    /if \(any\) out\[kind\]\.push\(o\);/.test(SH),
    "it would print an empty 試験 box on a student's 別紙");
  check("⚠️ clearing the blocks lives in shinseiResetToggles — ONE home",
    /function shinseiResetToggles\(\) \{[\s\S]{0,400}?shinseiClearExtras\(\);/.test(SH),
    "form.reset() clears values and leaves the DOM, so a new record inherits the last " +
    "student's blocks; both reset paths call this and nothing else");
  check("⚠️ a malformed blob costs the blocks, not the screen",
    /try \{ d = JSON\.parse\(json\); \} catch \(e\) \{ return; \}/.test(SH), "");

  // ---- the server half -----------------------------------------------------------------
  check("⚠️ the server parse is guarded too",
    /const parsed = JSON\.parse\(rawExtras\);/.test(CODE)
      && /\} catch \(e\) \{ \/\* no extras rather than no document \*\/ \}/.test(SRC),
    "thrown inside a merged 一括出力 it takes the whole batch down");
  check("...and the fixed block counts are named constants",
    /const SHINSEI_FIXED_EXAMS = 2;/.test(CODE) && /const SHINSEI_FIXED_EDUS = 3;/.test(CODE), "");
  // ⚠️ Structural: the constants set the ordinal on every added block, so they must equal
  // what the template actually hard-codes. A behavioural test cannot see the mismatch —
  // it just renders 「4回目」 above a block that is really the third.
  check("⚠️ SHINSEI_FIXED_EXAMS matches the template's hard-coded exam blocks",
    (TPL.match(/試験 Test/g) || []).length === 3,
    "found " + (TPL.match(/試験 Test/g) || []).length + " (2 fixed + 1 in the loop)");
  check("⚠️ SHINSEI_FIXED_EDUS matches the template's hard-coded 書類確認 blocks",
    (TPL.match(/書類確認 Check of documents/g) || []).length === 4,
    "found " + (TPL.match(/書類確認 Check of documents/g) || []).length + " (3 fixed + 1 in the loop)");

  // ---- the sheet -----------------------------------------------------------------------
  check("⚠️ the continuation sheet breaks BEFORE, never after",
    /<div style="page-break-before: always;">/.test(TPL)
      && !/page-break-after: always;">\s*<\/div>\s*<\? \} \?>/.test(TPL),
    "shinsei_exportBatchMergedFromWebApp relies on the LAST element carrying no page " +
    "break — a trailing one adds a blank sheet to every student in a batch");
  check("...and it is emitted only when there ARE extras",
    /if \(_hasExtras\) \{/.test(TPL), "");
  check("⚠️ extras render ESCAPED",
    /<\?= x\.name \?>/.test(TPL) && /<\?= e\.name \?>/.test(TPL)
      && !/<\?!= x\./.test(TPL) && !/<\?!= e\./.test(TPL),
    "these are free text from the sheet; <?!= ?> is the unescaped form");
  check("⚠️ a block cannot be split across sheets",
    /\.xblk \{ page-break-inside: avoid; \}/.test(TPL),
    "a title on one sheet and its rows on the next is unreadable on an official form");

  // ⚠️ Same length or the last field of every added block is silently dropped.
  const km = SH.match(/exams: \[([^\]]*)\][\s\S]*?edus:\s*\[([^\]]*)\]/);
  const nExam = km ? km[1].split(',').length : 0, nEdu = km ? km[2].split(',').length : 0;
  const g = SH.slice(SH.indexOf('toggleBtn: { id: "shinsei-btnToggleExam"'));
  check("⚠️ the JSON keys match the field count — exams",
    nExam === 5, nExam + " keys vs 5 secondFields");
  check("...and 教育機関", nEdu === 8, nEdu + " keys vs 8 secondFields");
}


console.log("\n11. 日本語・文化2年課程's 「その他」 carries its placement test (and so the CEFR line)");
{
  // ⚠️ Reported as "the CEFR toggle doesn't work". The toggle was fine: this course had no
  // placement test, so _shinseiBuildDocHtml_ wrote an EMPTY 「その他」 and there was no CEFR line to
  // include. It has a test now. Wording per the school: 進学1年6か月's paragraph WITHOUT the 60点
  // A2 line, because A1 is this course's required level.
  // Runs the REAL builder in a vm with HtmlService stubbed to capture the template fields.
  const vm = require('vm');
  const at = SRC.indexOf('\nfunction _shinseiBuildDocHtml_(');
  const BUILDER = SRC.slice(at + 1, SRC.indexOf('\n}\n', at) + 2);
  function build(src, course, include, score) {
    let T = null;
    const ctx = vm.createContext({
      HtmlService: { createTemplateFromFile: function () { T = { evaluate: function () { return { getContent: function () { return ''; } }; } }; return T; } },
      SHINSEI_FIXED_EXAMS: 2, SHINSEI_FIXED_EDUS: 3,
    });
    vm.runInContext(src, ctx);
    const row = new Array(50).fill('');
    row[1] = 'テスト'; row[2] = course; row[13] = '30'; row[14] = 'A1';
    row[32] = score === undefined ? '65' : score; row[33] = 'A1';
    ctx._shinseiBuildDocHtml_(row, include);
    return T;
  }
  const BUNKA = '日本語・文化2年課程';
  const on = build(BUILDER, BUNKA, true);
  check("文化, toggle ON: the placement paragraph with the student's score",
    /本校使用テキスト/.test(on.placementText) && /65 点を取得しているため、A1以上であることが証明できる。/.test(on.placementText),
    JSON.stringify(on.placementText));
  check("...A1 threshold only — no 60点 A2 line",
    /30点以上をA1相当の基準としている。/.test(on.placementText) && !/60点以上/.test(on.placementText) && !/A2相当の基準/.test(on.placementText),
    JSON.stringify(on.placementText));
  check("...and the CEFR line the toggle includes", /判定: CEFR A1 相当$/.test(on.placementText), JSON.stringify(on.placementText));
  [false, 'false'].forEach(function (v) {
    const off = build(BUILDER, BUNKA, v);
    check("文化, toggle OFF (" + JSON.stringify(v) + "): the paragraph stays, only the 判定 line goes",
      /本校使用テキスト/.test(off.placementText) && !/CEFR/.test(off.placementText), JSON.stringify(off.placementText));
  });
  const none = build(BUILDER, BUNKA, true, '');
  check("⚠️ 文化 with NO placement score keeps the empty box (no false \" 点を取得している\")",
    none.placementText === '', JSON.stringify(none.placementText));
  check("文化's 面接 text is untouched", /全18問/.test(on.interviewText) && /判定: CEFR A1 相当/.test(on.interviewText), "");

  // The other branches must be exactly as before (a cut/paste slip in the switch is the risk).
  const six = build(BUILDER, '進学1年6か月課程', true);
  check("進学1年6か月 still has its 60点 A2 line", /30点以上をA1相当、60点以上をA2相当の基準としている。/.test(six.placementText), "");
  const job = build(BUILDER, '就職2年課程', true);
  check("就職2年 still has its 70点 A2後半 line", /70点以上をA2後半相当の基準としている。/.test(job.placementText), "");
  const def = build(BUILDER, '進学2年課程', false);
  check("the default branch still strips its 判定 line when OFF", /本校使用テキスト/.test(def.placementText) && !/CEFR/.test(def.placementText), "");

  function mutant(from, to) {
    try {
      const n = BUILDER.split(from).length - 1;
      if (n !== 1) return 'anchor x' + n;
      return build(BUILDER.replace(from, to), BUNKA, true).placementText;
    } catch (e) { return 'threw: ' + e.message; }
  }
  const m1 = mutant('template.placementText = placementScore === "" ? "" :', 'template.placementText = "" && ');
  check("mutation: the old empty box loses the CEFR line again", m1 === '' || (typeof m1 === 'string' && !/判定: CEFR/.test(m1)), String(m1));
  const m2 = build(BUILDER.replace('template.placementText = placementScore === "" ? "" :', 'template.placementText ='), BUNKA, true, '').placementText;
  check("mutation: without the empty-score guard, a paragraph with no score prints", /^本校使用テキスト/.test(m2) && / 点を取得している/.test(m2), JSON.stringify(m2));
}

console.log("\n12. 申請 exports and the preview check export_shinsei on the SERVER");
{
  // ⚠️ It lived only on the three client buttons, so any signed-in account could call these
  // from the console. Each guard below is also run against its old shape, which must fail.
  const vm12 = require('vm'), fs12 = require('fs'), path12 = require('path');
  const SRC12 = fs12.readFileSync(path12.join(__dirname, '..', 'Shinsei_Code.js'), 'utf8');
  const HTML12 = fs12.readFileSync(path12.join(__dirname, '..', 'Index.html'), 'utf8');
  const fn12 = function (src, name) {
    const i = src.indexOf('\nfunction ' + name + '(');
    return i < 0 ? '' : src.slice(i + 1, src.indexOf('\n}\n', i) + 2);
  };
  const guardedRight = function (body, name) {
    const s = body.indexOf('_requireSession_("' + name + '");');
    const p = body.indexOf('_requireShinseiExport_();');
    return s !== -1 && p > s;
  };
  ['shinsei_exportSingleFromWebApp', 'shinsei_exportBatchMergedFromWebApp', 'shinsei_previewSingleFromWebApp'].forEach(function (n) {
    check(n + " checks export_shinsei right after the session", guardedRight(fn12(SRC12, n), n), "");
  });
  const oldSingle = fn12(SRC12, 'shinsei_exportSingleFromWebApp').replace('  _requireShinseiExport_();\n', '');
  check("  mutation: an endpoint without the call is caught", !guardedRight(oldSingle, 'shinsei_exportSingleFromWebApp'), "");

  const helper = fn12(SRC12, '_requireShinseiExport_');
  check("the decision is _hasPerm_ with the session's own role and permissions",
    /_hasPerm_\("", "", "export_shinsei"\)/.test(helper), helper);
  check("the three buttons are gated on the same permission",
    ['shinsei-btnPreview', 'shinsei-btnSingleExport', 'shinsei-btnBatchExport'].every(function (id) {
      return new RegExp('id="' + id + '"[^>]*data-perm="export_shinsei"').test(HTML12);
    }), "");

  const run = function (src, enforcing, allowed) {
    const ctx = vm12.createContext({
      _authEnforcing_: function () { return enforcing; },
      _hasPerm_: function (r, p, needed) { return needed === 'export_shinsei' && allowed; }
    });
    vm12.runInContext(src, ctx);
    try { ctx._requireShinseiExport_(); return 'ok'; } catch (e) { return e.message; }
  };
  check("without the permission it refuses", run(helper, true, false) === '権限がありません', run(helper, true, false));
  check("with it (admin-level included, which _hasPerm_ grants) it passes", run(helper, true, true) === 'ok', "");
  check("observe mode lets it through, as every session guard does", run(helper, false, false) === 'ok', "");
  check("  mutation: a helper that never throws is caught",
    run(helper.replace('throw new Error("権限がありません")', 'return'), true, false) === 'ok', "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
