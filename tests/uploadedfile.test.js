// getUploadedFile — serving hearing sheets through the app instead of
// link-sharing them in Drive.
//
// The membership check is the entire point of this suite. getUploadedFile reads
// as the DEPLOYING user, so it can open any file the deployer owns. Without a
// check that the requested id actually appears in Schedule_DB, any logged-in
// user could pass the id of the bound spreadsheet, a SMS_Backups_… snapshot, or
// anything in the photo folder — a far worse hole than the ANYONE_WITH_LINK
// sharing this replaces.
//
// A format check is NOT enough: a real, well-formed id belonging to a real file
// is exactly the attack.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Code.js ----
const UPLOADED_FILE_MAX_BYTES = 25 * 1024 * 1024;

function extractId(fileUrl) {
  const m = String(fileUrl || "").match(/[-\w]{25,}/);
  return m ? m[0] : null;
}

// Mirrors _hearingSheetFileIds_: ids drawn from Schedule_DB column idx 9.
function hearingSheetIds(scheduleRows) {
  let ids = {};
  for (let i = 1; i < scheduleRows.length; i++) {
    const url = String(scheduleRows[i][9] || "").trim();
    if (!url) continue;
    const m = url.match(/[-\w]{25,}/);
    if (m) ids[m[0]] = true;
  }
  return ids;
}

// Mirrors _buildingDocFileIds_: Building_Info column idx 44, comma-separated.
function buildingDocIds(buildingRows) {
  let ids = {};
  for (let i = 1; i < buildingRows.length; i++) {
    String(buildingRows[i][44] || "").split(",").forEach(function (s) {
      const v = s.trim();
      if (v !== "") ids[v] = true;
    });
  }
  return ids;
}

function mayView(role) {
  return role === "admin" || role === "master" || role === "sales" || role === "teacher";
}

// The whole decision, in the order Code.js applies it. buildingRows defaults to
// empty so the hearing-sheet cases below read exactly as they did.
// General_Docs row 2 col 1 — one comma-separated cell, not a column of rows.
function generalDocIds(cell) {
  let ids = {};
  String(cell || "").split(",").forEach(function (s) {
    const v = s.trim();
    if (v !== "") ids[v] = true;
  });
  return ids;
}

// `generalCell` is optional so every call site written before 共通別紙 existed keeps
// working unchanged — and so the "no general store yet" case is the default.
function decide(role, fileUrl, scheduleRows, sizeBytes, buildingRows, generalCell) {
  if (!mayView(role)) return "denied-permission";
  const id = extractId(fileUrl);
  if (!id) return "no-id";
  // Any of the three allow-lists admits the file; membership in none is the
  // rejection. Mirrors the ordering in getUploadedFile.
  if (!hearingSheetIds(scheduleRows)[id] &&
      !buildingDocIds(buildingRows || [])[id] &&
      !generalDocIds(generalCell || "")[id]) {
    return "denied-not-attached";
  }
  if (sizeBytes > UPLOADED_FILE_MAX_BYTES) return "too-large";
  return "ok";
}

const KNOWN   = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456";   // in Schedule_DB
const OTHER   = "1ZzZzZzZzZzZzZzZzZzZzZzZzZzZ9876543";  // a real file, NOT in it
const SHEETID = "1FakeBoundSpreadsheetIdForThisTestOnly000000";  // the bound spreadsheet

const SCHEDULE = [
  ["Timestamp", "TeacherId", "Name", "Date", "Period", "Status", "Student", "Nat", "Link", "DocumentURL"],
  ["", "T1", "甲野", "2026-07-27", "09:00 ~ 09:30", "Booked", "A", "", "",
   "https://drive.google.com/file/d/" + KNOWN + "/view?usp=drivesdk"],
  ["", "T2", "乙山", "2026-07-28", "10:00 ~ 10:30", "Booked", "B", "", "", ""],
];

console.log("\n1. Id extraction from what Drive actually returns");
{
  check("extracts from the /file/d/{id}/view?usp=drivesdk shape",
    extractId("https://drive.google.com/file/d/" + KNOWN + "/view?usp=drivesdk") === KNOWN,
    String(extractId("https://drive.google.com/file/d/" + KNOWN + "/view?usp=drivesdk")));
  check("accepts a bare id", extractId(KNOWN) === KNOWN, String(extractId(KNOWN)));
  check("null on empty", extractId("") === null, String(extractId("")));
  check("null on undefined", extractId(undefined) === null, String(extractId(undefined)));
  check("null on a short/junk value", extractId("not-an-id") === null, String(extractId("not-an-id")));
}

console.log("\n2. Membership — the guard");
{
  check("a document recorded in Schedule_DB is served",
    decide("teacher", "https://drive.google.com/file/d/" + KNOWN + "/view", SCHEDULE, 1000) === "ok",
    decide("teacher", KNOWN, SCHEDULE, 1000));

  // THE attack: a perfectly well-formed id for a file the deployer owns, that
  // simply is not a hearing sheet. A format check would wave this through.
  check("a well-formed id NOT in Schedule_DB is refused",
    decide("teacher", OTHER, SCHEDULE, 1000) === "denied-not-attached",
    decide("teacher", OTHER, SCHEDULE, 1000));

  check("the bound spreadsheet's own id is refused",
    decide("master", SHEETID, SCHEDULE, 1000) === "denied-not-attached",
    decide("master", SHEETID, SCHEDULE, 1000));

  check("master gets no bypass of the membership check",
    decide("master", OTHER, SCHEDULE, 1000) === "denied-not-attached",
    "master must not be able to read arbitrary Drive files through this endpoint");

  check("an empty document column contributes no id",
    Object.keys(hearingSheetIds(SCHEDULE)).length === 1,
    JSON.stringify(Object.keys(hearingSheetIds(SCHEDULE))));

  check("a schedule with no documents allows nothing",
    decide("admin", KNOWN, [SCHEDULE[0]], 1000) === "denied-not-attached",
    decide("admin", KNOWN, [SCHEDULE[0]], 1000));
}

console.log("\n3. Permission");
{
  ["admin", "master", "sales", "teacher"].forEach(function (r) {
    check(r + " may view", decide(r, KNOWN, SCHEDULE, 1000) === "ok", decide(r, KNOWN, SCHEDULE, 1000));
  });
  ["", "shinsei", "guest", undefined].forEach(function (r) {
    check(JSON.stringify(r) + " may not", decide(r, KNOWN, SCHEDULE, 1000) === "denied-permission",
      decide(r, KNOWN, SCHEDULE, 1000));
  });
  // Permission is tested BEFORE membership, so an unauthorised caller learns
  // nothing about which ids exist.
  check("permission is checked before membership",
    decide("guest", OTHER, SCHEDULE, 1000) === "denied-permission",
    "an unauthorised caller should not be able to probe for valid ids");
}

console.log("\n4. Size guard");
{
  check("under the cap is served", decide("admin", KNOWN, SCHEDULE, 1024 * 1024) === "ok",
    decide("admin", KNOWN, SCHEDULE, 1024 * 1024));
  check("exactly at the cap is served",
    decide("admin", KNOWN, SCHEDULE, UPLOADED_FILE_MAX_BYTES) === "ok",
    decide("admin", KNOWN, SCHEDULE, UPLOADED_FILE_MAX_BYTES));
  check("over the cap is refused",
    decide("admin", KNOWN, SCHEDULE, UPLOADED_FILE_MAX_BYTES + 1) === "too-large",
    decide("admin", KNOWN, SCHEDULE, UPLOADED_FILE_MAX_BYTES + 1));
  // base64 inflates by ~4/3 and the result still has to cross google.script.run.
  check("the cap leaves headroom under a 50MB response",
    (UPLOADED_FILE_MAX_BYTES * 4 / 3) < 50 * 1024 * 1024,
    Math.round(UPLOADED_FILE_MAX_BYTES * 4 / 3 / 1048576) + "MB encoded");
}

console.log("\n5. 別紙 — building documents use the same door");
{
  // Building_Info idx 44 holds a comma-separated id list per building. Before
  // this, the front-end handed out the raw Drive URL, so those files had to stay
  // shared — readable by anyone with the link and no login at all.
  const DOC_A = "1BbBbBbBbBbBbBbBbBbBbBbBbBbB1111111";
  const DOC_B = "1CcCcCcCcCcCcCcCcCcCcCcCcCcC2222222";
  const bRow = function (ids) { const r = new Array(46).fill(""); r[0] = "B1"; r[44] = ids; return r; };
  const BUILDINGS = [new Array(46).fill("header"), bRow(DOC_A + "," + DOC_B), bRow("")];

  check("both ids in one comma-separated cell are found",
    Object.keys(buildingDocIds(BUILDINGS)).length === 2,
    JSON.stringify(Object.keys(buildingDocIds(BUILDINGS))));
  check("a 別紙 id is served", decide("teacher", DOC_A, SCHEDULE, 1000, BUILDINGS) === "ok",
    decide("teacher", DOC_A, SCHEDULE, 1000, BUILDINGS));
  check("the second id in the list is served too",
    decide("teacher", DOC_B, SCHEDULE, 1000, BUILDINGS) === "ok",
    decide("teacher", DOC_B, SCHEDULE, 1000, BUILDINGS));
  check("hearing sheets still work with buildings present",
    decide("teacher", KNOWN, SCHEDULE, 1000, BUILDINGS) === "ok",
    decide("teacher", KNOWN, SCHEDULE, 1000, BUILDINGS));

  // Widening the allow-list must not weaken it. These are the same attacks as
  // §2, re-run now that a second list exists.
  check("an id in NEITHER list is still refused",
    decide("teacher", OTHER, SCHEDULE, 1000, BUILDINGS) === "denied-not-attached",
    decide("teacher", OTHER, SCHEDULE, 1000, BUILDINGS));
  check("the bound spreadsheet is still refused",
    decide("master", SHEETID, SCHEDULE, 1000, BUILDINGS) === "denied-not-attached",
    decide("master", SHEETID, SCHEDULE, 1000, BUILDINGS));
  check("a building with no documents contributes nothing",
    Object.keys(buildingDocIds([BUILDINGS[0], bRow("")])).length === 0, "");
  // A trailing comma is what an id list looks like after a delete.
  check("empty entries from a trailing comma are ignored",
    Object.keys(buildingDocIds([BUILDINGS[0], bRow(DOC_A + ",")])).length === 1,
    JSON.stringify(Object.keys(buildingDocIds([BUILDINGS[0], bRow(DOC_A + ",")]))));
  check("ids are trimmed, so ' id, id' still matches",
    decide("teacher", DOC_B, SCHEDULE, 1000, [BUILDINGS[0], bRow(DOC_A + ", " + DOC_B)]) === "ok",
    "a space after the comma must not make a document unreachable");
  // The permission gate is unchanged — 別紙 is not more open than hearing sheets.
  check("a role with no view rights is refused a 別紙 too",
    decide("guest", DOC_A, SCHEDULE, 1000, BUILDINGS) === "denied-permission",
    decide("guest", DOC_A, SCHEDULE, 1000, BUILDINGS));
}

console.log("\n6. 共通別紙 — documents attached to no building");
{
  // 共通別紙 live in General_Docs, not Building_Info. They shipped unopenable
  // because the allow-list knew only about the other two stores: the file uploaded,
  // listed and renamed fine, and every open was refused. TECHNICAL_REFERENCE §5
  // warns that widening the list is the moment to re-run these rejections.
  const GEN_A = "1DdDdDdDdDdDdDdDdDdDdDdDdDdD3333333";
  const GEN_B = "1EeEeEeEeEeEeEeEeEeEeEeEeEeE4444444";
  const DOC_A = "1BbBbBbBbBbBbBbBbBbBbBbBbBbB1111111";
  const bRow = function (ids) { const r = new Array(46).fill(""); r[0] = "B1"; r[44] = ids; return r; };
  const BUILDINGS = [new Array(46).fill("header"), bRow(DOC_A)];
  const GEN = GEN_A + "," + GEN_B;

  check("a 共通 id is served", decide("teacher", GEN_A, SCHEDULE, 1000, BUILDINGS, GEN) === "ok",
    decide("teacher", GEN_A, SCHEDULE, 1000, BUILDINGS, GEN));
  check("the second id in the cell is served too",
    decide("teacher", GEN_B, SCHEDULE, 1000, BUILDINGS, GEN) === "ok",
    decide("teacher", GEN_B, SCHEDULE, 1000, BUILDINGS, GEN));
  check("building 別紙 still work alongside it",
    decide("teacher", DOC_A, SCHEDULE, 1000, BUILDINGS, GEN) === "ok",
    decide("teacher", DOC_A, SCHEDULE, 1000, BUILDINGS, GEN));
  check("hearing sheets still work alongside it",
    decide("teacher", KNOWN, SCHEDULE, 1000, BUILDINGS, GEN) === "ok",
    decide("teacher", KNOWN, SCHEDULE, 1000, BUILDINGS, GEN));

  // ⚠️ THE POINT OF THIS SECTION. Same attacks as §2 and §5, re-run now that a
  // third list exists. Widening an allow-list is exactly when to re-prove it
  // still rejects.
  check("an id in NONE of the three lists is refused",
    decide("teacher", OTHER, SCHEDULE, 1000, BUILDINGS, GEN) === "denied-not-attached",
    decide("teacher", OTHER, SCHEDULE, 1000, BUILDINGS, GEN));
  check("the bound spreadsheet is still refused, even for master",
    decide("master", SHEETID, SCHEDULE, 1000, BUILDINGS, GEN) === "denied-not-attached",
    decide("master", SHEETID, SCHEDULE, 1000, BUILDINGS, GEN));
  check("a role with no view rights is refused a 共通 document too",
    decide("guest", GEN_A, SCHEDULE, 1000, BUILDINGS, GEN) === "denied-permission",
    decide("guest", GEN_A, SCHEDULE, 1000, BUILDINGS, GEN));

  // The sheet is created on first upload, so "not there yet" is a real state.
  check("an absent general store contributes nothing",
    Object.keys(generalDocIds("")).length === 0 &&
    Object.keys(generalDocIds(undefined)).length === 0, "");
  check("a 共通 id is refused when the store is empty",
    decide("teacher", GEN_A, SCHEDULE, 1000, BUILDINGS, "") === "denied-not-attached",
    decide("teacher", GEN_A, SCHEDULE, 1000, BUILDINGS, ""));

  // A delete leaves "id," behind; a hand-edit leaves "id, id".
  check("a trailing comma is ignored",
    Object.keys(generalDocIds(GEN_A + ",")).length === 1,
    JSON.stringify(Object.keys(generalDocIds(GEN_A + ","))));
  check("ids are trimmed, so ' id, id' still matches",
    decide("teacher", GEN_B, SCHEDULE, 1000, BUILDINGS, GEN_A + ", " + GEN_B) === "ok",
    "a space after the comma must not make a document unreachable");

  // The real function must not create the sheet on a read path.
  const SRC = require('fs').readFileSync(require('path').join(__dirname, '..', 'Code.js'), 'utf8');
  const gd = SRC.slice(SRC.indexOf('function _generalDocFileIds_'), SRC.indexOf('const UPLOADED_FILE_MAX_BYTES'));
  check("_generalDocFileIds_ does not create the sheet",
    gd.indexOf('_getGeneralDocsSheet_') === -1 && gd.indexOf('getSheetByName') !== -1,
    "a refused open must not have the side effect of inserting a sheet");
  // ⚠️ Everything above this point exercises the SIMULATOR, which mirrors the real
  // logic rather than running it. A mutation run proved that: deleting the actual
  // permission gate from Code.js left every "denied-permission" assertion green.
  // These two read the source, so the design checks above cannot drift away from
  // what getUploadedFile really does.
  const gu = SRC.slice(SRC.indexOf('function getUploadedFile'), SRC.indexOf('\n  let file;'));
  check("getUploadedFile still gates on permission before touching the id",
    /_permOrLegacyRole_\(role, perms, "view_dorms"/.test(gu) &&
    /_hasPerm_\(role, perms, "view_interview_results"\)/.test(gu) &&
    gu.indexOf('権限がありません') < gu.indexOf('_hearingSheetFileIds_'),
    "widening the allow-list must not widen who may use it");
  check("getUploadedFile checks all three lists",
    /!_hearingSheetFileIds_\(\)\[id\] && !_buildingDocFileIds_\(\)\[id\] && !_generalDocFileIds_\(\)\[id\]/.test(SRC),
    "a store the check does not know about is unreachable — that is this whole bug");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
