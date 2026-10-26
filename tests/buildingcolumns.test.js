// Building_Info column alignment.
//
// This sheet is addressed POSITIONALLY on both sides: _getBuildingDataForPdf_
// reads by 0-based array index, updateBuilding assigns into an array by the same
// index and writes the whole row back with
//   sheet.getRange(row, 1, 1, existingRow.length).setValues([existingRow])
//
// Two distinct ways that bites, both of which this suite pins:
//
//  1. If the read width and the padding width disagree, the row is written back
//     SHORT and the tail columns are truncated — including docIds at 44, which
//     holds the Drive ids of every 別紙 attached to the building. Nothing errors;
//     the attachments simply vanish. TECHNICAL_REFERENCE §4.3 warns about this.
//  2. If the code builds a row wider than the sheet's grid, that getRange
//     exceeds the grid and EVERY building save throws.
//
// Adding 燃えるゴミ(プラスチックを含む) at 47/48 walks straight past both.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// Mirrors BUILDING_COLS in Code.js — and §8 binds the mirror to the source, so a column added
// to Code.js alone fails here instead of passing against a stale copy.
const BUILDING_COLS = 55;

// Mirrors the existingRow[N] assignments in updateBuilding. Value is the index.
// docIds(44) is deliberately absent — see below.
const WRITE = {
  bldgId: 0, nameEn: 1, nameJp: 2, addressEn: 3, addressJp: 4,
  garbageHousehold: 5, garbageCans: 6, garbagePlastic: 7,
  routeUrl1: 9, routeUrl2: 10,
  garbagePlaceInfo: 11, remarks: 12,
  waterBill: 13, elecBill: 14, gasBill: 15, internetBill: 16, autoLock: 17,
  garbageHouseholdBag: 18, garbageCansBag: 19, garbagePlasticBag: 20,
  wm1Id: 21, wm2Id: 22, wm3Id: 23,
  garbage1Id: 24, garbage2Id: 25, garbage3Id: 26,
  garbagePaper: 27, garbagePaperBag: 28,
  bicycle1Id: 29, bicycle2Id: 30, bicycle3Id: 31,
  exteriorId: 32, exteriorCaption: 33,
  wm1Caption: 34, wm2Caption: 35, wm3Caption: 36,
  garbage1Caption: 37, garbage2Caption: 38, garbage3Caption: 39,
  bicycle1Caption: 40, bicycle2Caption: 41, bicycle3Caption: 42,
  otherBill: 43, hotWaterBill: 45, rentDefault: 46,
  garbageBurnablePlastic: 47, garbageBurnablePlasticBag: 48,
  misc1Id: 49, misc2Id: 50, misc3Id: 51,
  misc1Caption: 52, misc2Caption: 53, misc3Caption: 54,
};

// Mirrors the bldgData[i][N] reads in _getBuildingDataForPdf_. Index 0 is the id
// the loop matches on rather than a carried field, but it is listed so the two
// maps stay symmetric and check 1 covers it.
const READ = {
  bldgId: 0,
  nameEn: 1, nameJp: 2, addressEn: 3, addressJp: 4,
  garbageHousehold: 5, garbageCans: 6, garbagePlastic: 7,
  routeUrl1: 9, routeUrl2: 10,
  garbagePlaceInfo: 11, remarks: 12,
  waterBill: 13, elecBill: 14, gasBill: 15, internetBill: 16, autoLock: 17,
  garbageHouseholdBag: 18, garbageCansBag: 19, garbagePlasticBag: 20,
  wm1Id: 21, wm2Id: 22, wm3Id: 23,
  garbage1Id: 24, garbage2Id: 25, garbage3Id: 26,
  garbagePaper: 27, garbagePaperBag: 28,
  bicycle1Id: 29, bicycle2Id: 30, bicycle3Id: 31,
  exteriorId: 32, exteriorCaption: 33,
  wm1Caption: 34, wm2Caption: 35, wm3Caption: 36,
  garbage1Caption: 37, garbage2Caption: 38, garbage3Caption: 39,
  bicycle1Caption: 40, bicycle2Caption: 41, bicycle3Caption: 42,
  otherBill: 43, docIds: 44, hotWaterBill: 45, rentDefault: 46,
  garbageBurnablePlastic: 47, garbageBurnablePlasticBag: 48,
  misc1Id: 49, misc2Id: 50, misc3Id: 51,
  misc1Caption: 52, misc2Caption: 53, misc3Caption: 54,
};

// The five garbage categories, as the PDF template renders them.
const CATEGORIES = [
  { day: 'garbageHousehold',       bag: 'garbageHouseholdBag',       label: '家庭ごみ' },
  { day: 'garbageBurnablePlastic', bag: 'garbageBurnablePlasticBag', label: '燃えるゴミ(プラスチックを含む)' },
  { day: 'garbageCans',            bag: 'garbageCansBag',            label: 'カン・ビン・ペットボトル' },
  { day: 'garbagePlastic',         bag: 'garbagePlasticBag',         label: 'プラスチック' },
  { day: 'garbagePaper',           bag: 'garbagePaperBag',           label: '雑紙' },
];

console.log("\n1. Read and write indexes agree for every shared field");
Object.keys(READ).forEach(function (f) {
  if (WRITE[f] === undefined) return;   // docIds is read-only from the form's view
  check(f + ": " + WRITE[f], WRITE[f] === READ[f],
    "write=" + WRITE[f] + " read=" + READ[f]);
});

console.log("\n2. No two fields share an index");
{
  let seen = {}, dupes = [];
  Object.keys(WRITE).forEach(function (f) {
    const i = WRITE[f];
    if (seen[i] !== undefined) dupes.push(i + ": " + seen[i] + " & " + f);
    seen[i] = f;
  });
  check("write indexes are unique", dupes.length === 0, dupes.join(", "));
}

console.log("\n3. docIds (44) is never written by the form path");
{
  // The 別紙 upload/remove handlers own column 44. If updateBuilding ever
  // assigns it from formObject, every attachment on the building is lost the
  // next time somebody edits its address.
  const writesDocIds = Object.keys(WRITE).some(function (f) { return WRITE[f] === 44; });
  check("no form field maps to index 44", !writesDocIds,
    "a form field now writes docIds");
  check("but the PDF path still reads it", READ.docIds === 44, String(READ.docIds));
}

console.log("\n4. BUILDING_COLS covers every index, on both bounds");
{
  const maxWrite = Math.max.apply(null, Object.keys(WRITE).map(k => WRITE[k]));
  const maxRead  = Math.max.apply(null, Object.keys(READ).map(k => READ[k]));
  check("highest written index fits", maxWrite < BUILDING_COLS,
    "max write index " + maxWrite + " vs BUILDING_COLS " + BUILDING_COLS);
  check("highest read index fits", maxRead < BUILDING_COLS,
    "max read index " + maxRead + " vs BUILDING_COLS " + BUILDING_COLS);
  // The exact §4.3 trap: the read width and the padding width are both
  // BUILDING_COLS in Code.js precisely so they cannot drift apart.
  check("BUILDING_COLS is exactly one past the highest index",
    BUILDING_COLS === maxWrite + 1,
    "BUILDING_COLS=" + BUILDING_COLS + " highest=" + maxWrite +
    " — if a column was added, raise BUILDING_COLS with it");
}

console.log("\n5. The new category is wired end to end");
{
  check("day column is 47", WRITE.garbageBurnablePlastic === 47, String(WRITE.garbageBurnablePlastic));
  check("bag column is 48", WRITE.garbageBurnablePlasticBag === 48, String(WRITE.garbageBurnablePlasticBag));
  check("day and bag are adjacent",
    WRITE.garbageBurnablePlasticBag === WRITE.garbageBurnablePlastic + 1, "not adjacent");
  check("both sit past 家賃(46), leaving legacy columns untouched",
    WRITE.garbageBurnablePlastic > WRITE.rentDefault, "overlaps a legacy column");
}

console.log("\n6. Every garbage category has a distinct day and bag column");
{
  let cols = [];
  CATEGORIES.forEach(function (c) {
    check(c.label + " has both columns",
      WRITE[c.day] !== undefined && WRITE[c.bag] !== undefined,
      "day=" + WRITE[c.day] + " bag=" + WRITE[c.bag]);
    cols.push(WRITE[c.day], WRITE[c.bag]);
  });
  const uniq = cols.filter(function (v, i) { return cols.indexOf(v) === i; });
  check("all 10 garbage columns are distinct", uniq.length === cols.length,
    cols.join(","));
  check("five categories are represented", CATEGORIES.length === 5,
    String(CATEGORIES.length));
}

// The sections below check the 別紙 code itself, not just the mirrored constants,
// so they need both sources.
const SRC  = require('fs').readFileSync(require('path').join(__dirname, '..', 'Code.js'), 'utf8');
const HTML = require('fs').readFileSync(require('path').join(__dirname, '..', 'Index.html'), 'utf8');

console.log("\n別紙: the four functions that share Building_Info col 45");
{
  // 別紙 are Drive file ids in a comma-separated cell. Four functions read or write
  // that one cell, and they have to agree about which column it is.
  const bodyOf = function (fn) {
    const a = SRC.indexOf("\nfunction " + fn + "(");
    return a === -1 ? "" : SRC.slice(a, SRC.indexOf("\n}\n", a));
  };
  ['getAllBuildingDocs', 'uploadBuildingDoc', 'removeBuildingDoc', 'renameBuildingDoc',
   '_getBuildingDocRow_'].forEach(function (fn) {
    check(fn + " exists", bodyOf(fn) !== "", "renamed or removed — update this list");
  });
  // 0-based read (44), 1-based write (45). The classic silent-corruption pair.
  check("the id list is read at index 44",
    /data\[i\]\[44\]/.test(bodyOf('_getBuildingDocRow_')) && /data\[i\]\[44\]/.test(bodyOf('getAllBuildingDocs')),
    "reads are 0-based; a drift here loses every attachment silently");
  // The literal 45 moved into _getBuildingDocRow_ when the general store was added,
  // so the contract is now "the building branch resolves to column 45" and the
  // writers use info.col. Same guarantee, one level up.
  check("...and the building branch resolves to column 45",
    /col: 45/.test(bodyOf('_getBuildingDocRow_')),
    "writes are 1-based; 44 here would overwrite the neighbouring column");
  check("...and the writers go through info.col",
    /getRange\(info\.rowIndex, info\.col\)/.test(bodyOf('uploadBuildingDoc')) &&
    /getRange\(info\.rowIndex, info\.col\)/.test(bodyOf('removeBuildingDoc')), "");

  const ren = bodyOf('renameBuildingDoc');
  check("renameBuildingDoc is guarded by edit_dorms",
    /_hasPerm_\(userRole, userPerms, "edit_dorms"\)/.test(ren), "");
  check("renameBuildingDoc is registered as an endpoint",
    /renameBuildingDoc: renameBuildingDoc/.test(SRC), "");
  check("renameBuildingDoc writes an audit entry",
    /_logActivity_[\s\S]{0,200}建物書類の名前を変更/.test(ren), "");

  // ⚠️ THE check. fileId comes from the client. Without this the endpoint renames
  // any Drive file the deploying account owns, given nothing but its id.
  check("renameBuildingDoc refuses a fileId not on that building",
    /info\.ids\.indexOf\(String\(fileId\)\.trim\(\)\) === -1/.test(ren) &&
    /この建物の別紙ではありません/.test(ren),
    "an arbitrary Drive id would be renameable through this endpoint");

  // ⚠️ The prefix is the only thing tying a file in the shared Drive folder back to
  // a building. Rename replaces what follows it, never the prefix itself.
  check("renameBuildingDoc preserves the {building}_doc_{ts}_ prefix",
    /\^\(\.\*\?_doc_\\d\+_\)/.test(ren),
    "losing the prefix orphans the file in the shared Drive folder");

  // It touches Drive only, so it is deliberately NOT in the destructive list that
  // damagecontrol.test.js requires a snapshot for.
  check("renameBuildingDoc takes no sheet snapshot", ren.indexOf('_snapshotSheet_') === -1,
    "it writes no sheet; a snapshot here would be cargo-culted");
}

console.log("\n別紙一覧: files, not buildings");
{
  // The four dorm buttons act on buildings and rooms, so they belong to 部屋一覧.
  const roomsStart = HTML.indexOf('id="dorm-sub-rooms"');
  const docsStart  = HTML.indexOf('id="dorm-sub-docs"');
  const roomsBlock = HTML.slice(roomsStart, docsStart);
  const docsBlock  = HTML.slice(docsStart, HTML.indexOf('</div>', HTML.indexOf('docDashContainer')));
  ['btnAutoFill', 'btnAddBldgBtn', 'btnAddRoomBtn'].forEach(function (id) {
    check(id + " lives inside 部屋一覧", roomsBlock.indexOf('id="' + id + '"') !== -1,
      "it was in a header shared by both sub-tabs");
    check(id + " is NOT in 別紙一覧", docsBlock.indexOf('id="' + id + '"') === -1, "");
  });

  // ⚠️ Moved verbatim. setupInterfaceBasedOnRole drives these off data-perm and
  // data-orig-display; rewriting either breaks the permission loop silently.
  ['btnAutoFill', 'btnAddBldgBtn', 'btnAddRoomBtn'].forEach(function (id) {
    const m = HTML.match(new RegExp('<button id="' + id + '"[^>]*>'));
    check(id + " kept its permission attributes",
      !!m && /permission-req/.test(m[0]) && /data-perm="edit_dorms"/.test(m[0]) &&
      /data-orig-display="inline-block"/.test(m[0]),
      "the permission loop would stop showing it to dorm editors");
  });

  ['btnDocAdd', 'btnDocRename', 'btnDocDelete'].forEach(function (id) {
    check(id + " exists in 別紙一覧", docsBlock.indexOf('id="' + id + '"') !== -1, "");
  });
  // ⚠️ Disabled until something is selected, or they fire against nothing.
  ['btnDocRename', 'btnDocDelete'].forEach(function (id) {
    const m = HTML.match(new RegExp('<button id="' + id + '"[^>]*>'));
    check(id + " starts disabled", !!m && / disabled/.test(m[0]),
      "with no selection there is no file for it to act on");
  });
  check("selecting a row re-enables them",
    /function _docSyncButtons\(\)[\s\S]{0,320}el\.disabled = !on/.test(HTML), "");
  check("a vanished selection is cleared before the buttons are synced",
    /_docSelected = null;\s*\n\s*\}\s*\n\s*_docSyncButtons\(\);/.test(HTML),
    "deleting a file must not leave 名前変更 armed against it");

  // The list is files now. No building card, and no empty building.
  check("rows are built from a flattened file list",
    /function _docFlatRows\(\)/.test(HTML) && /\(b\.docs \|\| \[\]\)\.forEach/.test(HTML),
    "a building with no docs contributes no rows at all");
  check("the generated filename prefix is hidden",
    /function _docDisplayName[\s\S]{0,160}replace\(\/\^\.\*\?_doc_/.test(HTML),
    "uploads are stored as {building}_doc_{ts}_{name}");
  check("adding still asks which building",
    /id="docsBldgSelect"/.test(HTML) && /建物を選択してください/.test(HTML),
    "a 別紙 cannot exist without a building — col 45 is on the building's row");
  // ⚠️ Filtered ONLY to drop the general sentinel (which is offered separately as
  // the first option) — never by docs.length. Filtering by that would make a
  // building's FIRST attachment impossible to add, since the flat list hides
  // buildings with none.
  check("the building picker excludes only the general sentinel",
    /filter\(function \(b\) \{ return b\.id !== GENERAL_DOC_ID; \}\)/.test(HTML), "");
  check("the building picker is not filtered by document count",
    !/filter\(function\s*\(b\)\s*\{\s*return b\.docs\.length/.test(HTML),
    "otherwise a building's FIRST attachment can never be added");
}

console.log("\n共通別紙: documents that belong to no building");
{
  const bodyOf2 = function (fn) {
    const a = SRC.indexOf("\nfunction " + fn + "(");
    return a === -1 ? "" : SRC.slice(a, SRC.indexOf("\n}\n", a));
  };
  const row = bodyOf2('_getBuildingDocRow_');

  check("_getGeneralDocsSheet_ exists", bodyOf2('_getGeneralDocsSheet_') !== "", "");
  check("the general store is its own sheet, not a Building_Info row",
    /const SHEET_GENERAL_DOCS = 'General_Docs'/.test(SRC),
    "a reserved Building_Info row would surface as a phantom building in getDormData, "
    + "every building dropdown and the PDF builder");
  check("the sheet is created on demand with a frozen header",
    /insertSheet\(SHEET_GENERAL_DOCS\)[\s\S]{0,160}setFrozenRows\(1\)/.test(SRC), "");

  // ⚠️ The column is the whole point of widening the return. Building rows keep the
  // id list in col 45, the general sheet in col 1; a literal 45 in either writer
  // would put general ids into Building_Info, or building ids into column 1.
  check("_getBuildingDocRow_ returns a column for buildings", /col: 45/.test(row), "");
  check("...and a different one for the general store", /col: 1/.test(row), "");
  check("both writers use info.col, never a literal 45",
    (SRC.match(/getRange\(info\.rowIndex, info\.col\)/g) || []).length === 2 &&
    SRC.indexOf('getRange(info.rowIndex, 45)') === -1,
    "a literal here writes the id list into the wrong sheet's wrong column");

  // ⚠️ Sentinel before the scan, so no building can shadow it.
  check("the sentinel is resolved before Building_Info is scanned",
    row.indexOf('GENERAL_DOC_ID') !== -1 &&
    row.indexOf('GENERAL_DOC_ID') < row.indexOf('SHEET_BUILDING'),
    "a building with that id would otherwise take precedence over the general store");
  check("getAllBuildingDocs emits the general store",
    /out\.push\(\{ id: GENERAL_DOC_ID/.test(SRC),
    "the client flattens it like a building; without this it never appears");
  check("a failure reading it cannot blank the whole list",
    /out\.push\(\{ id: GENERAL_DOC_ID[\s\S]{0,220}catch \(e\)/.test(SRC), "");
}

console.log("\n別紙一覧: the selection highlights the WHOLE row");
{
  // ⚠️ The reported bug. The list was built on .student-table, whose
  // `td:first-child` carries an opaque background for its frozen column — and a
  // cell background always beats a row background, so only the second cell lit up.
  check("the list does not borrow .student-table",
    /<table class='doc-table'>/.test(HTML) && !/table class='student-table' style='width:100%;'/.test(HTML),
    "that class freezes its first column with an opaque background");
  check("the selected rule targets the CELLS",
    /\.doc-table tbody tr\.sel td \{ background/.test(HTML),
    "on `tr` alone the first cell paints over it and half the row stays unhighlighted");
  check("selection is a class, not an inline row style",
    /html \+= "<tr class='" \+ \(sel \? "sel" : ""\)/.test(HTML), "");
  check("the highlight comes from a theme token",
    /tr\.sel td \{ background: var\(--report-header-bg\); \}/.test(HTML),
    "a literal colour would break in one of the two themes");
  check("there is a non-colour cue as well",
    /tr\.sel td:first-child \{ box-shadow: inset/.test(HTML), "");

  // General rows read only as 「—」, so they must not scatter through the list.
  check("general rows render a dash for 建物",
    /isGen \? "—"/.test(HTML), "");
  check("general rows sort to the top",
    /if \(a\.isGeneral !== b\.isGeneral\) return a\.isGeneral \? -1 : 1;/.test(HTML),
    "with a dash as their only marker they are easy to miss mid-list");
  check("the 追加 picker offers 共通 first",
    /共通（建物なし）/.test(HTML) && /value='" \+ escAttrJs\(GENERAL_DOC_ID\)/.test(HTML), "");
  check("the client sentinel matches the server's",
    /const GENERAL_DOC_ID = '__GENERAL__';/.test(HTML) &&
    /const GENERAL_DOC_ID = '__GENERAL__';/.test(SRC),
    "these two strings must stay identical or uploads land nowhere");
}

console.log("\n7. save and update share ONE photo uploader and ONE combineLang");
{
  // Until 2026-09-28 saveBuilding and updateBuilding each carried a nested combineLang (identical to
  // the global _combineLang_) and a nested uploadPhoto (update's keeping the existing id). One copy
  // of each now. The helper runs for real here, against a fake Drive folder.
  const vm = require('vm');
  const body = function (name) {
    const a = SRC.indexOf('\nfunction ' + name + '(');
    return a < 0 ? '' : SRC.slice(a, SRC.indexOf('\n}\n', a + 1));
  };
  const save = body('saveBuilding'), upd = body('updateBuilding');
  check("neither function carries a nested combineLang or uploadPhoto any more",
    save.length > 500 && upd.length > 500
      && !/const combineLang =|function uploadPhoto\(/.test(save) && !/const combineLang =|function uploadPhoto\(/.test(upd), "");
  const calls = function (b) { return (b.match(/_uploadBuildingPhoto_\(photoFolder, formObject\.bldgId, /g) || []).length; };
  check("each uploads its thirteen photos through the shared helper", calls(save) === 13 && calls(upd) === 13,
    calls(save) + " / " + calls(upd));
  check("update passes each photo's existing id; save passes none",
    (upd.match(/formObject\.existing[A-Z]\w*Id\)/g) || []).length === 13 && !/formObject\.existing/.test(save), "");

  const load = function (src) {
    const i = src.indexOf('\nfunction _uploadBuildingPhoto_(');
    const code = src.slice(i + 1, src.indexOf('\n}\n', i + 1) + 2);
    const created = [];
    const ctx = vm.createContext({
      Utilities: { base64Decode: function (b) { return b; }, newBlob: function (bytes, mime, name) { return { name: name }; } },
    });
    vm.runInContext(code, ctx);
    const folder = { createFile: function (blob) { created.push(blob.name); return { getId: function () { return 'NEW:' + blob.name; } }; } };
    return { fn: ctx._uploadBuildingPhoto_, folder: folder, created: created };
  };
  const H = load(SRC);
  check("a new photo is uploaded, named <bldgId>_<suffix>.jpg, and its id returned",
    H.fn(H.folder, 'B01', { base64: 'x', mimeType: 'image/jpeg' }, 'WM_1', 'OLD') === 'NEW:B01_WM_1.jpg', "");
  check("⚠️ with no new photo, an edit keeps the existing id", H.fn(H.folder, 'B01', null, 'WM_1', 'OLD') === 'OLD', "");
  check("...and a new building gets ''", H.fn(H.folder, 'B01', null, 'WM_1') === '' && H.fn(H.folder, 'B01', {}, 'X', undefined) === '', "");
  check("...and nothing is uploaded when there is no photo", H.created.length === 1, JSON.stringify(H.created));
  // Mutation: save's old copy (no existing-id fallback) used for both — an edit would wipe photos.
  const M = load(SRC.replace('  return existingId || "";\n}', '  return "";\n}'));
  check("  mutation: dropping the existing-id fallback (edit wipes a photo) is caught",
    M.fn(M.folder, 'B01', null, 'WM_1', 'OLD') !== 'OLD', "");
}

console.log("\n8. the maps above are the SOURCE's maps, and the その他 photo group (2026-10-01)");
{
  // Until 2026-10-01 WRITE / READ / BUILDING_COLS were transcriptions with nothing binding them to
  // Code.js, so a column added on one side only would have passed here. Derived now, both ways.
  const vm = require('vm');
  const body = function (name) {
    const a = SRC.indexOf('\nfunction ' + name + '(');
    return a < 0 ? '' : SRC.slice(a, SRC.indexOf('\n}\n', a + 1));
  };
  const srcCols = Number((SRC.match(/^const BUILDING_COLS = (\d+);/m) || [])[1]);
  check("the BUILDING_COLS mirror equals Code.js's", srcCols === BUILDING_COLS, srcCols + " vs " + BUILDING_COLS);
  const set = (arr) => Array.from(new Set(arr)).sort((a, b) => a - b).join(',');
  const writes = set((body('updateBuilding').match(/existingRow\[(\d+)\]\s*=/g) || []).map(m => Number(m.match(/\d+/)[0])));
  const reads = set((body('_getBuildingDataForPdf_').match(/bldgData\[i\]\[(\d+)\]/g) || []).map(m => Number(m.match(/\[(\d+)\]$/)[1])));
  check("WRITE's indices are exactly updateBuilding's assignments", writes === set(Object.values(WRITE)),
    "source " + writes + "\n        map    " + set(Object.values(WRITE)));
  check("READ's indices are exactly _getBuildingDataForPdf_'s reads", reads === set(Object.values(READ)),
    "source " + reads + "\n        map    " + set(Object.values(READ)));

  // saveBuilding appends a positional row: its length must reach the last index too.
  const save = body('saveBuilding');
  check("save and update upload the three その他 photos as Misc_1..3",
    ['Misc_1', 'Misc_2', 'Misc_3'].every(n => save.indexOf('"' + n + '"') !== -1 && body('updateBuilding').indexOf('"' + n + '"') !== -1));
  check("update keeps each その他 photo's existing id",
    [1, 2, 3].every(n => body('updateBuilding').indexOf('formObject.existingMisc' + n + 'Id)') !== -1));

  // ⚠️ The header writer is load-bearing: the batched read is as wide as the header row, so a blank
  // header at 49–54 hides the その他 ids from the 編集 modal, and the next save writes "" over them.
  const hdrSrc = (SRC.match(/const BUILDING_ADDED_HEADERS = \{[\s\S]*?\};/) || [''])[0];
  const run = function (fnSrc, header) {
    const writesTo = {};
    const sheet = {
      getMaxColumns: () => header.length, insertColumnsAfter: (a, n) => { for (let i = 0; i < n; i++) header.push(''); },
      getRange: (r, c, nr, nc) => ({
        getValues: () => [header.slice(c - 1, c - 1 + nc)],
        setValue: (v) => { writesTo[c - 1] = v; header[c - 1] = v; },
      }),
    };
    const ctx = vm.createContext({});
    vm.runInContext('var BUILDING_COLS = ' + BUILDING_COLS + ';\n' + hdrSrc.replace(/^const /, 'var ') + '\n' + fnSrc, ctx);
    ctx._ensureBuildingColumns_(sheet);
    return writesTo;
  };
  const ensure = (SRC.match(/\nfunction _ensureBuildingColumns_\([\s\S]*?\n}\n/) || [''])[0];
  const old = new Array(49).fill('h'); old[52 - 3] = undefined;      // a 49-wide sheet, as before
  const w = run(ensure, old.slice());
  check("a 49-wide sheet gets all six その他 headers", [49, 50, 51, 52, 53, 54].every(i => typeof w[i] === 'string' && w[i] !== ''),
    JSON.stringify(w));
  check("...and nothing else in the header row is written", Object.keys(w).every(k => Number(k) >= 49));
  const typed = new Array(55).fill('h'); typed[50] = '手入力の見出し';
  const w2 = run(ensure, typed);
  check("⚠️ a header someone typed is never overwritten", !(50 in w2) && typed[50] === '手入力の見出し', JSON.stringify(w2));
  const clobber = ensure.replace(/if \(String\(header\[idx\][^\n]*\n\s*(sheet\.getRange\(1, idx \+ 1\)\.setValue\(BUILDING_ADDED_HEADERS\[k\]\);)\n\s*\}/, '$1');
  check("  mutation: writing unconditionally would overwrite it (proves the check can fail)",
    clobber !== ensure && (50 in run(clobber, (() => { const t = new Array(55).fill('h'); t[50] = 'x'; return t; })())));

  // The gallery: 12 photos must stay within the 3 rows the single page has room for.
  const roomHtml = body('_buildRoomHtmlInner_');
  check("the gallery lists the three その他 photos", (roomHtml.match(/title: "その他 \/ Other", id: bldgData\.misc\dId/g) || []).length === 3);
  check("4 per row only past 9 photos", /const PER_ROW = totalCount > 9 \? 4 : 3;/.test(roomHtml) && /widthByRowCount = \{[^}]*4: 23/.test(roomHtml));
  const rows = (n) => Math.ceil(n / (n > 9 ? 4 : 3));
  check("rows: 9 photos → 3 (unchanged), 10–12 → 3, never 4", rows(9) === 3 && rows(10) === 3 && rows(12) === 3 && [1,2,3,4,5,6,7,8,9].every(n => rows(n) === Math.ceil(n / 3)));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
