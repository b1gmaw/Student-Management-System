// ==========================================
// SHINSEI (申請関連) BACKEND — 各種確認書: the form's data, PDF export and preview.
// doGet lives in Code.js. Endpoints here are named shinsei_*, and private helpers
// _shinsei…_ (a trailing _ is what keeps a helper off google.script.run).
// ==========================================

// ⚠️ THE POSITIONAL CONTRACT for Shinsei_Data. Every column is anonymous — the form's
// field `id` IS its column number — so a width that lands in some places and not others
// shifts every value one to the left and corrupts silently. It was the literal 46,
// repeated in six places, when 入学期 was added as column 47; one constant is what stops
// the next column half-landing. tests/shinseicols.test.js asserts the literal is gone.
//
// ⚠️ Two shapes, and they differ by one:
//   new Array(SHINSEI_COLS)      0-based sheet row      index 0 = column A
//   new Array(SHINSEI_COLS + 1)  1-based aligned array  index 1 = column A, index 0 unused
// ⚠️ 48 is column 48, the JSON blob of EXTRA exam / 教育機関 blocks — and it is the last
// column this sheet should ever gain. Every further block goes inside that blob, so the
// width stops moving. See CLAUDE.md; Schedule_Templates.内容 is the same decision.
const SHINSEI_COLS = 48;

// ⚠️ 入学期's column, named rather than derived. INTAKE_IDX below read
// `SHINSEI_COLS - 1` — "the last column" — which was true only while 入学期 HAPPENED to be
// last. Widening the sheet then silently moved the intake reader onto the new column: the
// dropdown fills with the next column's values, shinseiBatchTargets groups by them, and
// every record reads as 未設定. No error, no failing test. The width and this column are
// two different facts and must not share a literal.
const SHINSEI_INTAKE_COL = 47;

// How many blocks Shinsei_Template.html hard-codes on the main 別紙. Everything past these
// is an EXTRA and prints on 【別紙（続き）】, so they set the ordinal an added block is
// labelled with (3回目, 4か所目). ⚠️ tests/shinseicols.test.js §10 counts the blocks in the
// template and fails if these two numbers stop matching what is actually rendered.
const SHINSEI_FIXED_EXAMS = 2;
const SHINSEI_FIXED_EDUS = 3;

// 電話番号 1/2/3回目, as 1-based column numbers. Written as TEXT, always: left to Sheets, a
// digits-only 0751234567 is stored as the number 751234567, and a +81 number is read as a
// formula by appendRow — +81 75 123 4567 shows #ERROR!, and +977-1-4412345 silently becomes
// -4411369. Measured with probeSheetsTextInput on staging, 2026-09-15.
// ⚠️ tests/shinseicols.test.js §13 derives this list from the form's 電話番号 fields, so a
// fourth phone column cannot be added to the form without landing here too.
const SHINSEI_TEXT_COLS = [17, 25, 41];

function shinsei_getStudentNames() {
  _requireSession_("shinsei_getStudentNames");
  _requireShinseiPerm_("view_shinsei");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName("Shinsei_Data") || ss.getSheetByName("Data");
  if (!dataSheet) throw new Error("シートが見つかりません。'Shinsei_Data' という名前のシートを作成してください。");
  
  const data = dataSheet.getDataRange().getValues();
  if (data.length <= 1) return { students: [], intakes: [] };

  // ⚠️ Column A is the name. Derived from SHINSEI_INTAKE_COL, never from the sheet width —
  // see the constant's comment: they were the same number by coincidence, not by meaning.
  const INTAKE_IDX = SHINSEI_INTAKE_COL - 1;
  let students = [];
  const seen = {};
  for (let r = 1; r < data.length; r++) {
    let n = String(data[r][0]).trim(); // Name is exactly in Column A (index 0)
    if (!n) continue;
    const it = String(data[r][INTAKE_IDX] || "").trim();
    students.push({ name: n, intake: it });
    if (it) seen[it] = true;
  }

  // ⚠️ ONE reader, and it lives in Code.js. _allKnownIntakes_() is
  // PlacementTest_Config ∪ Recruitment_Meta — the union the interview booking modal and
  // 面接結果 already use, and it sorts newest-first by parsing 年/月 so 10月 lands after
  // 4月. A hand-rolled copy here read Recruitment_Meta ALONE and shipped an EMPTY
  // dropdown, because this school registers its intakes in the placement config, which
  // is the half that copy could not see. Being built on the server was never the
  // property that mattered — reading the whole union is. Do not re-copy this.
  let intakes = [];
  try { intakes = _allKnownIntakes_() || []; }
  catch (e) { /* the 申請 data's own intakes still have to be offered */ }

  // ⚠️ An intake present in the 申請 data but registered nowhere else must still appear,
  // or a record is unreachable from its own group in 一括出力. Appended after the
  // registered ones rather than merged into the sort: these are the odd ones out.
  const known = {};
  intakes.forEach(function (v) { known[String(v).trim()] = true; });
  Object.keys(seen).sort().forEach(function (v) { if (!known[v]) intakes.push(v); });

  return { students: students, intakes: intakes };
}

// ==========================================
// 2. DATA ENTRY & EDITING FUNCTIONS
// ==========================================

// Prefixes ' onto the phone columns so Sheets stores exactly what was typed (SHINSEI_TEXT_COLS).
// map(), so the positional contract cannot move a value.
// ⚠️ Applied INSIDE _cellSafeRow_: the guard leaves a value that starts with ' alone, so a +81
// number gets one apostrophe, never two. The apostrophe is Sheets' text marker, not part of the
// value — getValues() reads back what was typed.
function _shinseiForceText_(row) {
  return row.map(function (v, i) {
    if (SHINSEI_TEXT_COLS.indexOf(i + 1) === -1) return v;
    if (v === null || v === undefined || v === "") return v;
    const s = String(v);
    return s.charAt(0) === "'" ? s : "'" + s;
  });
}

// A formula cell's text, back as it was typed. MEASURED (probeSheetsTextInput, 2026-09-15):
// appendRow stores a typed "+81 75 123 4567" as a formula whose text is exactly that, with no =
// added, so it comes back unchanged. A formula that does begin "=+" / "=-" drops the = and becomes
// the phone it spells. Every other formula keeps its = — an injected =IMPORTXML(…) comes back as
// that text, and _cellSafe_ then stores it inert.
function _shinseiRecoverFormulaText_(f) {
  const s = String(f == null ? "" : f);
  return /^=[+\-＋－]/.test(s) ? s.slice(1) : s;
}

function shinsei_saveNewStudent(formDataArray) {
  _requireSession_("shinsei_saveNewStudent");
  _requireShinseiPerm_("edit_shinsei");
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error("Database is busy. Please try again.");
  
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("Shinsei_Data") || ss.getSheetByName("Data");
    if (!sheet) throw new Error("'Shinsei_Data' sheet not found.");

    let newRow = new Array(SHINSEI_COLS).fill("");
    for (let i = 1; i <= SHINSEI_COLS; i++) {
      newRow[i - 1] = formDataArray[i] || ""; // Shifted 1 left. id 1 -> index 0 (Col A)
    }
    
    // ⚠️ _cellSafeRow_ wraps the ARRAY at the write site, never the fields inside it —
    // the positional contract is the worse bug class. A 備考 of =IMPORTXML(...) runs the
    // next time anyone opens the workbook; this module had no guard at all until now.
    // The phone columns are forced to text inside it — see SHINSEI_TEXT_COLS.
    sheet.appendRow(_cellSafeRow_(_shinseiForceText_(newRow)));
    return (formDataArray[1] || "Student") + " のデータを保存しました！";
  } catch (error) {
    throw new Error(error.toString());
  } finally {
    lock.releaseLock();
  }
}

function shinsei_deleteStudent(studentName) {
  _requireSession_("shinsei_deleteStudent");
  _requireShinseiPerm_("edit_shinsei");
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error("Database is busy. Please try again.");
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Shinsei_Data") || SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Data");
    if (!sheet) throw new Error("'Shinsei_Data' sheet not found.");
    const data = sheet.getDataRange().getValues();

    for (let r = 1; r < data.length; r++) {
      if (String(data[r][0]).trim() === String(studentName).trim()) { // Check Col A
        sheet.deleteRow(r + 1);
        return studentName + " のデータを削除しました。";
      }
    }
    throw new Error("Student not found: " + studentName);
  } catch(error) {
    throw new Error(error.toString());
  } finally {
    lock.releaseLock();
  }
}

function shinsei_getStudentDataForEdit(studentName) {
  _requireSession_("shinsei_getStudentDataForEdit");
  _requireShinseiPerm_("view_shinsei");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Shinsei_Data") || ss.getSheetByName("Data");
  if (!sheet) throw new Error("Shinsei_Data シートが見つかりません。");
  const data = sheet.getDataRange().getValues();

  for (let r = 1; r < data.length; r++) { 
    if (String(data[r][0]).trim() === String(studentName).trim()) { // Check Col A
      let rowData = data[r];
      // ⚠️ getValues() hands a broken formula cell back as the TEXT "#ERROR!" — or, for a typed
      // +977-1-4412345, as the number it evaluated to. Loaded into the form like that, the next
      // データ更新 wrote it over the cell, and the formula was the only copy of what was typed:
      // that is how saves made AFTER the formula guard still showed #ERROR!. A formula cell is
      // returned as its recovered text instead, so saving the record repairs it. One row only.
      const formulas = sheet.getRange(r + 1, 1, 1, rowData.length).getFormulas()[0];
      for (let i = 0; i < rowData.length; i++) {
        if (formulas[i]) { rowData[i] = _shinseiRecoverFormulaText_(formulas[i]); continue; }
        if (rowData[i] instanceof Date) {
          const d = rowData[i];
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          rowData[i] = `${year}-${month}-${day}`;
        }
      }
      // Re-align array so index 1 = name, index 2 = course, etc.
      let alignedData = new Array(SHINSEI_COLS + 1).fill("");
      for (let i = 1; i <= SHINSEI_COLS; i++) {
          alignedData[i] = rowData[i - 1] || ""; // Read directly from 0-indexed column array
      }
      return alignedData;
    }
  }
  throw new Error("Student not found in database.");
}

function shinsei_updateExistingStudent(originalName, formDataArray) {
  _requireSession_("shinsei_updateExistingStudent");
  _requireShinseiPerm_("edit_shinsei");
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error("Database busy. Please try again.");
  
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Shinsei_Data") || SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Data");
    if (!sheet) throw new Error("Shinsei_Data シートが見つかりません。");
    const data = sheet.getDataRange().getValues();

    let targetRow = -1;
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][0]).trim() === String(originalName).trim()) { // Check Col A
        targetRow = r + 1;
        break;
      }
    }
    if (targetRow === -1) throw new Error("Could not find the original record to update.");
    
    const valuesToSet = [];
    for(let i = 1; i <= SHINSEI_COLS; i++) {
      valuesToSet.push(formDataArray[i] || "");
    }
    
    // ⚠️ Same guard as the insert path above — free text, same sheet, same hole.
    sheet.getRange(targetRow, 1, 1, SHINSEI_COLS).setValues([_cellSafeRow_(_shinseiForceText_(valuesToSet))]); // Write starting at Column A (1)
    return "✅ " + (formDataArray[1] || "Student") + " のデータを更新しました！";
  } catch(e) {
    throw new Error(e.toString());
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// 4. INSTANT HTML-TO-PDF EXPORT 
// ==========================================
// ⚠️ THE ONLY PLACE a Shinsei_Data row becomes template fields — ~110 lines of it.
// It existed TWICE (the export and the preview) before the merged batch would have made
// three. They were byte-identical after whitespace normalisation, i.e. they had not drifted
// YET; the drift arrives with the next column, and then the preview shows one document and
// the export produces another. Same shape as _calCellState and _resolveUserById_, and this
// module has already been bitten by it twice: the client's two `<= 46` loops that left
// 入学期 write-dead, and the intake reader that could not see PlacementTest_Config.
function _shinseiBuildDocHtml_(targetRow, includeCefr) {
    const template = HtmlService.createTemplateFromFile('Shinsei_Template');
    
    template.studentName = targetRow[1] || ""; 
    const courseName = (targetRow[2] || "").toString().trim();
    template.course = courseName;

    // [EXAM 1]
    template.col3 = targetRow[3] || ""; template.col4 = targetRow[4] || ""; 
    let d5 = targetRow[5];
    template.col5 = (d5 instanceof Date) ? `${d5.getFullYear()}年${d5.getMonth() + 1}月` : (d5 || "");
    template.col6 = targetRow[6] || "";
    template.col7 = targetRow[7] || ""; 
    
    // [EXAM 2] 
    template.col8 = targetRow[8] || "";
    template.col9 = targetRow[9] || "";
    let d10 = targetRow[10]; template.col10 = (d10 instanceof Date) ? `${d10.getFullYear()}年${d10.getMonth() + 1}月` : (d10 || "");
    template.col11 = targetRow[11] || ""; template.col12 = targetRow[12] || "";

    // Scores and CEFR Ratings
    const interviewScore = targetRow[13] || "";
    const interviewCEFR = targetRow[14] || "";
    const placementScore = targetRow[32] || "";
    const placementCEFR = targetRow[33] || "";

    template.interviewScore = interviewScore;
    template.placementScore = placementScore;

    const commonInterviewCriteria = "A(質問に対して適切な表現で答えられている)\n" +
                                    "B(質問に対して不十分であったり、間違いはあるものの、予測可能な範囲である)\n" +
                                    "C(質問に対しておおよその理解はしており、何らかの答えは返すものの、その答えは予測に難しい)\n" +
                                    "D(質問の意味がわからず、全く答えられない)";

    switch(courseName) {
      case "進学1年6か月課程":
        template.interviewText = "当校の定めるA2レベルの到達目標に到達しているかを測る評価項目からインタビューし、全14問について、A（3点）B（2点）C（1点）D（0点）の4段評価で点数を出す。\n" +
          commonInterviewCriteria + "\n" +
          "26点以上をA2相当の基準としている。当該学生は42点満点中 " + interviewScore + " 点を取得した。\n" +
          "なお、17点以上をA1相当の基準とする。以上のことから、 A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + interviewCEFR + " 相当";
        template.placementText = "本校使用テキスト、N4の問題集等を参考にA2レベルが測れる問題を100点満点で出題し、言語知識のレベルを測る。\n" +
          "30点以上をA1相当、60点以上をA2相当の基準としている。\n" +
          placementScore + " 点を取得しているため、A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + placementCEFR + " 相当";
        break;
      case "日本語・文化2年課程":
        template.interviewText = "当校の定めるA1レベルの到達目標に到達しているかを測る評価項目からインタビューし、全18問について、A（3点）B（2点）C（1点）D（0点）の4段評価で点数を出す。\n" +
          commonInterviewCriteria + "\n" +
          "30点以上をA1相当の基準としている。当該学生は54点満点中 " + interviewScore + " 点を取得した。\n" +
          "以上のことから、 A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + interviewCEFR + " 相当";
        // ⚠️ This course had NO placement test, so the box was deliberately empty, and the CEFR
        // toggle had nothing to include. It has one now. The threshold is A1 only (no 60点 A2 line),
        // because A1 is what this course requires. A record with no placement score keeps the old
        // empty box: " 点を取得している" with no score would be false on an official form.
        template.placementText = placementScore === "" ? "" :
          "本校使用テキスト、N4の問題集等を参考にA2レベルが測れる問題を100点満点で出題し、言語知識のレベルを測る。\n" +
          "30点以上をA1相当の基準としている。\n" +
          placementScore + " 点を取得しているため、A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + placementCEFR + " 相当";
        break;
      case "就職2年課程":
        template.interviewText = "当校の定めるB1レベルから勉強を始められるレベルであるかを測る評価項目からインタビューし、全13問について、A（3点）B（2点）C（1点）D（0点）の4段評価で点数を出す。\n" +
          commonInterviewCriteria + "\n" +
          "25点以上をA2相当の基準としている。当該学生は39点満点中 " + interviewScore + " 点を取得した。\n" +
          "なお、15点以上をA1相当の基準とする。以上のことから、 A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + interviewCEFR + " 相当";
        template.placementText = "本校使用テキスト、N4の問題集等を参考にA2レベルが測れる問題を100点満点で出題し、言語知識のレベルを測る。\n" +
          "30点以上をA1相当とし、70点以上をA2後半相当の基準としている。\n" +
          placementScore + " 点を取得しているため、A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + placementCEFR + " 相当";
        break;
        // Newly added course, 2024-06-05. The same thresholds as 就職2年課程, but the interview is A2-level questions rather than B1-level.
        // Remember to add more Academic courses here.
        case "進学1年3か月課程":
        template.interviewText = "当校の定めるB1レベルの到達目標に到達しているかを測る評価項目からインタビューし、全13問について、A（3点）B（2点）C（1点）D（0点）の4段評価で点数を出す。\n" +
          commonInterviewCriteria + "\n" +
          "25点以上をA2後半相当の基準としている。当該学生は39点満点中 " + interviewScore + " 点を取得した。\n" +
          "なお、15点以上をA1相当の基準とする。以上のことから、 A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + interviewCEFR + " 相当";
        template.placementText = "本校使用テキスト、N4の問題集等を参考にA2レベルが測れる問題を100点満点で出題し、言語知識のレベルを測る。\n" +
          "30点以上をA1相当とし、70点以上をA2後半相当の基準としている。\n" +
          placementScore + " 点を取得しているため、A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + placementCEFR + " 相当";
        break;
      default:
        template.interviewText = "当校の定めるA2レベルの到達目標に到達しているかを測る評価項目からインタビューし、全14問について、A（3点）B（2点）C（1点）D（0点）の4段評価で点数を出す。\n" +
          commonInterviewCriteria + "\n" +
          "当該学生は42点満点中 " + interviewScore + " 点を取得した。\n\n" +
          "判定: CEFR " + interviewCEFR + " 相当";
        template.placementText = "本校使用テキスト、N4の問題集等を参考にA2レベルが測れる問題を100点満点で出題し、言語知識のレベルを測る。\n" +
          "30点以上をA1相当、60点以上をA2相当の基準としている。\n" +
          placementScore + " 点を取得しているため、A1以上であることが証明できる。\n\n" +
          "判定: CEFR " + placementCEFR + " 相当";
        break;
    }
    
    if (includeCefr === false || includeCefr === 'false') {
      if (template.placementText) {
        template.placementText = template.placementText.replace(/\n*判定:\s*CEFR.*相当/g, '');
      }
    }
    
    // [EDUCATION 1]
    template.col15 = targetRow[15] || ""; template.col16 = targetRow[16] || ""; template.col17 = targetRow[17] || ""; template.col18 = targetRow[18] || ""; template.col19 = targetRow[19] || "N/A"; template.col20 = targetRow[20] || ""; template.col21 = targetRow[21] || ""; template.col22 = targetRow[22] || "";
    // [EDUCATION 2]
    template.col23 = targetRow[23] || ""; template.col24 = targetRow[24] || ""; template.col25 = targetRow[25] || ""; template.col26 = targetRow[26] || ""; template.col27 = targetRow[27] || "N/A"; template.col28 = targetRow[28] || ""; template.col29 = targetRow[29] || ""; template.col30 = targetRow[30] || ""; 
    
    // [FIRST OTHERS]
    template.col31 = targetRow[31] || "";
    // [PAGE 1 CHECKBOXES]
    template.aiValue = targetRow[34] || ""; template.ajValue = targetRow[35] || "";
    template.akValue = targetRow[36] || ""; template.alValue = targetRow[37] || ""; template.amValue = targetRow[38] || "";
    // [NEW: EDUCATION 3]
    template.col39 = targetRow[39] || ""; template.col40 = targetRow[40] || "";
    template.col41 = targetRow[41] || ""; template.col42 = targetRow[42] || ""; template.col43 = targetRow[43] || "N/A"; template.col44 = targetRow[44] || "";
    template.col45 = targetRow[45] || ""; template.col46 = targetRow[46] || "";

  // [EXTRAS] Column 48 — the 3回目以降 / 4か所目以降 blocks, as JSON.
  // ⚠️ try/catch and default to empty. A malformed blob costs THIS student's extra blocks;
  // thrown, it would take a whole merged 一括出力 down with it, which is the regression the
  // per-student try/catch in shinsei_exportBatchMergedFromWebApp exists to prevent.
  let _extras = { exams: [], edus: [] };
  try {
    const rawExtras = targetRow[48];
    if (rawExtras) {
      const parsed = JSON.parse(rawExtras);
      if (parsed) {
        _extras.exams = parsed.exams || [];
        _extras.edus = parsed.edus || [];
      }
    }
  } catch (e) { /* no extras rather than no document */ }
  template.extraExams = _extras.exams;
  template.extraEdus = _extras.edus;
  template.fixedExams = SHINSEI_FIXED_EXAMS;
  template.fixedEdus = SHINSEI_FIXED_EDUS;

  return template.evaluate().getContent();
}

// ⚠️ Through _normName_, not String().trim(). Identity by name string is this file's oldest
// bug class; a full-width space or a trailing one makes a student who plainly exists
// unfindable. Returns the 1-based aligned row (index 1 = column A) or null.
function _shinseiRowFor_(dataValues, studentName) {
  const want = _normName_(studentName);
  for (let r = 1; r < dataValues.length; r++) {
    if (_normName_(dataValues[r][0]) === want) {
      const targetRow = new Array(SHINSEI_COLS + 1).fill("");
      for (let i = 1; i <= SHINSEI_COLS; i++) { targetRow[i] = dataValues[r][i - 1] || ""; }
      return targetRow;
    }
  }
  return null;
}

function _shinseiDataSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Shinsei_Data") || ss.getSheetByName("Data");
  if (!sheet) throw new Error("Shinsei_Data シートが見つかりません。");
  return sheet;
}

// Editor-run, READ-ONLY. Lists every Shinsei_Data cell that is not what was typed:
//   (a) a FORMULA. The typed text is still inside it; migrateShinseiFormulaCells restores it.
//   (b) literal error TEXT (#ERROR!) with no formula: a broken record re-saved before 既存編集
//       recovered formulas. The typed text is gone from this sheet, so the newest backup copy
//       still holding a real value for that student is printed, to be restored by hand.
//   (c) a NUMBER in a phone column: its leading zero is gone and is not guessed back.
// ⚠️ It reads the backup file's id from the property and never calls _getBackupSpreadsheet_,
// which CREATES a backup file when none is recorded. This runs on production before anything else.
function diagnoseShinseiFormulaCells() {
  _requireMaintenanceUnlock_("diagnoseShinseiFormulaCells");
  const sheet = _shinseiDataSheet_();
  const range = sheet.getDataRange();
  const V = range.getValues(), F = range.getFormulas();
  if (V.length <= 1) return "Shinsei_Data has no rows.";
  const ERR = /^#(ERROR!|NAME\?|VALUE!|REF!|DIV\/0!|N\/A|NUM!|NULL!)$/;
  const head = V[0];
  const label = function (c) { return "列" + (c + 1) + (head[c] ? "（" + head[c] + "）" : ""); };
  const who = function (r) { return "行" + (r + 1) + " " + V[r][0]; };
  const codes = function (s) {
    return String(s).slice(0, 4).split("").map(function (ch) {
      return "U+" + ("000" + ch.charCodeAt(0).toString(16).toUpperCase()).slice(-4);
    }).join(" ");
  };

  const formulas = [], errors = [], numbers = [];
  for (let r = 1; r < V.length; r++) {
    for (let c = 0; c < V[r].length; c++) {
      if (F[r][c]) {
        formulas.push(who(r) + " / " + label(c) + ": " + JSON.stringify(F[r][c]) + " [" + codes(F[r][c]) + "]"
          + " → " + JSON.stringify(_shinseiRecoverFormulaText_(F[r][c])));
      } else if (typeof V[r][c] === "string" && ERR.test(V[r][c].trim())) {
        errors.push({ r: r, c: c });
      } else if (typeof V[r][c] === "number" && SHINSEI_TEXT_COLS.indexOf(c + 1) !== -1) {
        numbers.push(who(r) + " / " + label(c) + ": " + V[r][c]);
      }
    }
  }

  // Backup copies are named "<sheet>__yyyyMMdd_HHmmss", so newest-first is a name sort. Each tab
  // is read at most once however many cells need it.
  let tabs = null;
  const cache = {};
  const fromBackup = function (name, c) {
    if (tabs === null) {
      tabs = [];
      const id = PropertiesService.getScriptProperties().getProperty(BACKUP_PROP_KEY);
      if (id) {
        try {
          const prefix = sheet.getName() + "__";
          tabs = SpreadsheetApp.openById(id).getSheets()
            .filter(function (t) { return t.getName().indexOf(prefix) === 0; })
            .sort(function (x, y) { return x.getName() < y.getName() ? 1 : -1; });
        } catch (e) { tabs = []; }
      }
    }
    if (!tabs.length) return "no backup copies found";
    const want = _normName_(name);
    for (let t = 0; t < tabs.length; t++) {
      const tn = tabs[t].getName();
      if (!cache[tn]) { const rg = tabs[t].getDataRange(); cache[tn] = { V: rg.getValues(), F: rg.getFormulas() }; }
      const b = cache[tn];
      for (let r = 1; r < b.V.length; r++) {
        if (_normName_(b.V[r][0]) !== want) continue;
        if (b.F[r] && b.F[r][c]) return tn + ": formula → " + JSON.stringify(_shinseiRecoverFormulaText_(b.F[r][c]));
        const v = b.V[r][c];
        if (v !== "" && v != null && !(typeof v === "string" && ERR.test(v.trim()))) return tn + ": " + JSON.stringify(v);
        break;
      }
    }
    return "no backup copy holds a value for this cell";
  };
  const errLines = errors.map(function (e) {
    return who(e.r) + " / " + label(e.c) + ": " + V[e.r][e.c] + "  ← " + fromBackup(V[e.r][0], e.c);
  });

  const indent = function (s) { return "  " + s; };
  const report = []
    .concat(["(a) formula cells: " + formulas.length + " — migrateShinseiFormulaCells restores these"], formulas.map(indent), [""])
    .concat(["(b) error text saved as text: " + errLines.length + " — restore by hand from the backup value shown"], errLines.map(indent), [""])
    .concat(["(c) phone columns holding a number: " + numbers.length + " — the leading zero cannot be recovered"], numbers.map(indent))
    .join("\n");
  console.log(report);
  return report;
}

// Editor-run one-off. Rewrites every formula cell in Shinsei_Data as the text that was typed —
// kind (a) above — through the same two guards a save uses. Kinds (b) and (c) are left alone:
// nothing in this sheet can restore them.
// ⚠️ Under the document lock, so a データ更新 cannot land between the read and the rewrite. And it
// refuses to write when the sheet copy was not taken: _snapshotSheet_ swallows its own errors
// and reports them only through its return value.
function migrateShinseiFormulaCells() {
  _requireMaintenanceUnlock_("migrateShinseiFormulaCells");
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error("Database is busy. Please try again.");
  try {
    const sheet = _shinseiDataSheet_();
    const F = sheet.getDataRange().getFormulas();
    const hits = [];
    for (let r = 1; r < F.length; r++) {
      for (let c = 0; c < F[r].length; c++) {
        if (F[r][c]) hits.push({ r: r, c: c, f: F[r][c] });
      }
    }
    if (!hits.length) return "nothing to do — " + sheet.getName() + " holds no formula cells.";
    if (!_snapshotSheet_(sheet.getName())) {
      throw new Error("The backup copy of " + sheet.getName() + " failed, so nothing was changed.");
    }
    // A whole positional row per cell, so _shinseiForceText_ sees the column the cell is in.
    const width = Math.max(SHINSEI_COLS, F[0].length);
    const done = [];
    hits.forEach(function (h) {
      const one = new Array(width).fill("");
      one[h.c] = _shinseiRecoverFormulaText_(h.f);
      const safe = _cellSafeRow_(_shinseiForceText_(one))[h.c];
      sheet.getRange(h.r + 1, h.c + 1).setValue(safe);
      done.push("行" + (h.r + 1) + " 列" + (h.c + 1) + ": " + h.f);
    });
    SpreadsheetApp.flush();
    _logActivity_({ role: "master", name: "システム", id: "SYSTEM" }, "申請データの数式を修復", sheet.getName(),
      done.join(" / ").slice(0, 45000));
    return "repaired " + hits.length + " cell(s) in " + sheet.getName() + ":\n" + done.join("\n");
  } finally {
    lock.releaseLock();
  }
}

// ── 試験名 の改称（2026-09-18） ──────────────────────────────────────────────────────────────
// 試験名's option list became the 13 tests 出入国在留管理庁 publishes, written 正式名称（略称）.
// Seven older spellings therefore no longer appear in the dropdown.
//
// Nothing was lost: a stored value absent from a <select>'s options is CARRIED as its own option
// and flagged red (shinseiSelectSetValue), which is why this is a tidy-up and not a rescue. But
// every affected record shows a red 試験名 until somebody re-picks it, and the old spelling would
// go back onto the COE form on the next データ更新 — so the stored values are moved instead.
//
// ⚠️ This map must stay in step with SHINSEI_EXAMS in Index.html. Its VALUES are the new names;
// tests/shinseicols.test.js §15 reads both files and asserts every value here exists there, and
// that no key here is still offered — so a rename on one side alone fails the suite.
const SHINSEI_EXAM_RENAMES = {
  "NAT-TEST": "日本語NAT-TEST",
  "J-TEST": "実用日本語検定（J.TEST）",
  "J-CERT": "生活・職能日本語検定（J-cert）",
  "JPT": "JPT日本語能力試験",
  "TOP-J": "実用日本語運用能力試験（TOPJ）",
  "BJT": "ビジネス日本語能力テスト（BJT）",
  "JFT": "国際交流基金日本語基礎テスト（JFT-Basic）"
};
// The 1-based columns holding a 試験名 (1回目 / 2回目).
// ⚠️ Column 48's JSON blob holds MORE of them — exams[].name on every 3回目以降 block — and a
// migration that fixed only these two would leave the added blocks on the old spelling, which is
// precisely the half nobody scrolls down to look at.
const SHINSEI_EXAM_NAME_COLS = [3, 8];

// Reads every stored 試験名 and reports the DISTINCT values with their counts, marking the ones
// migrateShinseiExamNames would move. Read-only; run this first.
// ⚠️ It deliberately does NOT carry a copy of the 13 accepted names. Listing the distinct values
// is what lets a human spot anything unexpected — a hand-typed or imported spelling that is in
// neither the old list nor the new one — without this file growing a second copy of a vocabulary
// that already lives in Index.html and drifts the moment the school accepts another test.
function diagnoseShinseiExamNames() {
  _requireMaintenanceUnlock_("diagnoseShinseiExamNames");
  const sheet = _shinseiDataSheet_();
  const V = sheet.getDataRange().getValues();
  if (V.length <= 1) return "Shinsei_Data has no rows.";

  const seen = {};           // name → { fixed, extra, rows: [] }
  const bump = function (name, where, r) {
    const k = String(name == null ? "" : name).trim();
    if (k === "") return;
    if (!seen[k]) seen[k] = { fixed: 0, extra: 0, rows: [] };
    seen[k][where]++;
    if (seen[k].rows.length < 6) seen[k].rows.push("行" + (r + 1) + " " + V[r][0]);
  };

  let bad = 0;
  for (let r = 1; r < V.length; r++) {
    SHINSEI_EXAM_NAME_COLS.forEach(function (col) { bump(V[r][col - 1], "fixed", r); });
    const raw = V[r][SHINSEI_COLS - 1];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      (parsed && parsed.exams ? parsed.exams : []).forEach(function (x) { bump(x && x.name, "extra", r); });
    } catch (e) { bad++; }   // a malformed blob costs that row's extras, never the report
  }

  const names = Object.keys(seen).sort();
  if (!names.length) return "no 試験名 is stored in " + sheet.getName() + ".";
  let willMove = 0;
  const lines = names.map(function (n) {
    const s = seen[n], to = SHINSEI_EXAM_RENAMES[n];
    if (to) willMove += s.fixed + s.extra;
    return (to ? "CHANGE " : "keep   ") + JSON.stringify(n) +
      (to ? " → " + JSON.stringify(to) : "") +
      "  [固定 " + s.fixed + " / 追加ブロック " + s.extra + "]" +
      "  " + s.rows.join(", ") + (s.fixed + s.extra > s.rows.length ? " …" : "");
  });
  return "distinct 試験名 in " + sheet.getName() + " — " + willMove + " value(s) would be rewritten" +
    (bad ? " (⚠️ " + bad + " row(s) have an unreadable extras blob and were skipped)" : "") +
    ":\n" + lines.join("\n") +
    "\n\nAnything on a `keep` line that is not one of the 13 current options was typed or imported " +
    "by hand — it stays flagged red in 各種確認書 until someone re-picks it.";
}

// Rewrites the stored 試験名 values named in SHINSEI_EXAM_RENAMES, in both the fixed columns and
// the extras blob. Run diagnoseShinseiExamNames first.
// ⚠️ Under the document lock, so a データ更新 cannot land between the read and the rewrite; and it
// refuses to write when the sheet copy was not taken — _snapshotSheet_ swallows its own errors and
// reports them only through its return value.
function migrateShinseiExamNames() {
  _requireMaintenanceUnlock_("migrateShinseiExamNames");
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error("Database is busy. Please try again.");
  try {
    const sheet = _shinseiDataSheet_();
    const V = sheet.getDataRange().getValues();
    const cells = [];        // { r, c, to }   1-based row / column
    const blobs = [];        // { r, json }
    for (let r = 1; r < V.length; r++) {
      SHINSEI_EXAM_NAME_COLS.forEach(function (col) {
        const to = SHINSEI_EXAM_RENAMES[String(V[r][col - 1] == null ? "" : V[r][col - 1]).trim()];
        if (to) cells.push({ r: r + 1, c: col, to: to, from: V[r][col - 1] });
      });
      const raw = V[r][SHINSEI_COLS - 1];
      if (!raw) continue;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { continue; }
      let touched = 0;
      (parsed && parsed.exams ? parsed.exams : []).forEach(function (x) {
        const to = x && SHINSEI_EXAM_RENAMES[String(x.name == null ? "" : x.name).trim()];
        if (to) { x.name = to; touched++; }
      });
      if (touched) blobs.push({ r: r + 1, json: JSON.stringify(parsed), n: touched });
    }
    if (!cells.length && !blobs.length) return "nothing to do — no old 試験名 spelling is stored in " + sheet.getName() + ".";
    if (!_snapshotSheet_(sheet.getName())) {
      throw new Error("The backup copy of " + sheet.getName() + " failed, so nothing was changed.");
    }

    const done = [];
    // ⚠️ Written through the same guard a save uses. No 試験名 starts with = + or -, so this
    // changes nothing today — but writing user-visible text to a sheet unwrapped is the hole this
    // module already had once, and a write site that skips it is how the next one starts.
    const width = Math.max(SHINSEI_COLS, V[0].length);
    const safeAt = function (value, col) {
      const one = new Array(width).fill("");
      one[col - 1] = value;
      return _cellSafeRow_(_shinseiForceText_(one))[col - 1];
    };
    cells.forEach(function (h) {
      sheet.getRange(h.r, h.c).setValue(safeAt(h.to, h.c));
      done.push("行" + h.r + " 列" + h.c + ": " + h.from + " → " + h.to);
    });
    blobs.forEach(function (b) {
      sheet.getRange(b.r, SHINSEI_COLS).setValue(safeAt(b.json, SHINSEI_COLS));
      done.push("行" + b.r + " 追加ブロック " + b.n + "件");
    });
    SpreadsheetApp.flush();
    _logActivity_({ role: "master", name: "システム", id: "SYSTEM" }, "申請データの試験名を改称", sheet.getName(),
      done.join(" / ").slice(0, 45000));
    return "renamed " + cells.length + " cell(s) and " + blobs.length + " extras blob(s) in " +
      sheet.getName() + ":\n" + done.join("\n");
  } finally {
    lock.releaseLock();
  }
}

// ⚠️ export_shinsei, decided on the SERVER. Until 2026-09-15 it lived only on the three client
// buttons (プレビュー / この学生を出力 / 一括出力), so any signed-in account could call these from the
// console and export every student's documents.
// _hasPerm_ is given no role and no permissions ON PURPOSE: both come from the
// session, so master and admin-level pass exactly as the buttons show them (hasPermission grants
// admin-level on the client too). A check that read the permission string literally would refuse
// an admin-level caller the button offers (the deleted _requirePerm_ did exactly that).
function _requireShinseiExport_() {
  if (!_hasPerm_("", "", "export_shinsei")) throw new Error("権限がありません");
}

// ⚠️ view_shinsei / edit_shinsei, decided on the SERVER for the same reason as export above.
// Until 2026-10-26 the five data endpoints asked only _requireSession_, which proves somebody is
// signed in, not that they may see these records: a 教務 (no view_shinsei) could read every
// applicant's passport and phone fields from the console, and delete records by name.
// Called AFTER _requireSession_, so a dead session still signs the browser out.
function _requireShinseiPerm_(perm) {
  if (!_hasPerm_("", "", perm)) throw new Error("権限がありません");
}

function shinsei_exportSingleFromWebApp(studentName, includeCefr = true) {
  _requireSession_("shinsei_exportSingleFromWebApp");
  _requireShinseiExport_();
  try {
    const dataValues = _shinseiDataSheet_().getDataRange().getValues();
    const targetRow = _shinseiRowFor_(dataValues, studentName);
    if (!targetRow) throw new Error("この学生の申請データが見つかりません。名前をご確認ください。");

    const htmlContent = _shinseiBuildDocHtml_(targetRow, includeCefr);
    const fileName = studentName + ".pdf";
    const pdfBlob = Utilities.newBlob(htmlContent, MimeType.HTML).getAs(MimeType.PDF).setName(fileName);

    return {
      base64: Utilities.base64Encode(pdfBlob.getBytes()),
      fileName: fileName
    };
  } catch (error) {
    throw new Error(error.toString());
  }
}

// ⚠️ ONE call, ONE conversion, ONE download. The batch used to be a CLIENT-SIDE LOOP: a
// google.script.run per student, each re-reading the WHOLE Shinsei_Data sheet to fetch one
// row, each invoking the converter, and 800ms of deliberate sleep between them so the
// browser would accept sequential downloads. For 12 students that is 9.6 seconds of doing
// nothing and 12 reads of the sheet to get 12 rows — none of it the PDF engine.
function shinsei_exportBatchMergedFromWebApp(names, includeCefr = true, title) {
  _requireSession_("shinsei_exportBatchMergedFromWebApp");
  _requireShinseiExport_();
  const list = (names || []).map(function (n) { return String(n || "").trim(); }).filter(String);
  if (!list.length) throw new Error("出力する学生が選ばれていません。");

  // ⚠️ Read ONCE for the whole batch — this is the N-times-the-whole-sheet cost.
  const dataValues = _shinseiDataSheet_().getDataRange().getValues();

  const bodies = [];
  const failed = [];
  let shell = null;
  for (let i = 0; i < list.length; i++) {
    // ⚠️ Per student, so one bad record costs one student rather than the whole batch —
    // which is the regression merging would otherwise introduce over the old loop.
    try {
      const targetRow = _shinseiRowFor_(dataValues, list[i]);
      if (!targetRow) { failed.push(list[i]); continue; }
      const doc = _shinseiBuildDocHtml_(targetRow, includeCefr);
      const m = doc.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      if (!m) { failed.push(list[i]); continue; }
      // ⚠️ The FIRST successful document supplies <head> — @page { size: A4 }, the styles —
      // so they appear once. Concatenating whole documents would nest html/head/body.
      if (shell === null) shell = doc;
      bodies.push(m[1]);
    } catch (e) {
      failed.push(list[i]);
    }
  }
  if (!bodies.length) throw new Error("出力できる申請データがありませんでした。");

  // ⚠️ An explicit break BETWEEN students, never after the last. Checked against the
  // template: its conditional `page-break` sits on the OPENING div of the page-1 block, so
  // the final rendered element never carries page-break-after — hence no blank pages.
  const joined = bodies.join('\n<div style="page-break-after: always;"></div>\n');
  const merged = shell.replace(/(<body[^>]*>)[\s\S]*(<\/body>)/i, function (_m, open, close) {
    return open + joined + close;
  });

  const fileName = (String(title || "各種確認書").replace(/[\\\/:*?"<>|]/g, "_"))
    + "_" + bodies.length + "名.pdf";
  const pdfBlob = Utilities.newBlob(merged, MimeType.HTML).getAs(MimeType.PDF).setName(fileName);

  return {
    base64: Utilities.base64Encode(pdfBlob.getBytes()),
    fileName: fileName,
    count: bodies.length,
    failed: failed
  };
}

// ==========================================
// 6. PREVIEW PDF (RETURNS HTML TO BROWSER)
// ==========================================
function shinsei_previewSingleFromWebApp(studentName, includeCefr = true) {
  _requireSession_("shinsei_previewSingleFromWebApp");
  _requireShinseiExport_();
  try {
    const dataValues = _shinseiDataSheet_().getDataRange().getValues();
    const targetRow = _shinseiRowFor_(dataValues, studentName);
    if (!targetRow) throw new Error("この学生の申請データが見つかりません。名前をご確認ください。");
    return _shinseiBuildDocHtml_(targetRow, includeCefr);
  } catch (error) {
    throw new Error(error.toString());
  }
}

// Editor-run diagnostic, in the profileApp idiom. ⚠️ It exists because "one file will be
// faster" was an ESTIMATE, and estimates about where time goes in this app have been wrong
// repeatedly (rule 8). It splits the sheet read, the template evaluation and the converter,
// and times the converter for ONE document against N — which is the only thing that decides
// whether the converter's cost is fixed per invocation or per page.
function profileShinseiPdf(n) {
  _requireMaintenanceUnlock_("profileShinseiPdf");
  const want = n || 5;
  const t0 = Date.now();
  const dataValues = _shinseiDataSheet_().getDataRange().getValues();
  const readMs = Date.now() - t0;

  const docs = [];
  const t1 = Date.now();
  for (let r = 1; r < dataValues.length && docs.length < want; r++) {
    const targetRow = _shinseiRowFor_(dataValues, dataValues[r][0]);
    if (targetRow) docs.push(_shinseiBuildDocHtml_(targetRow, true));
  }
  const buildMs = Date.now() - t1;
  if (!docs.length) return "Shinsei_Data に行がありません。";

  const bodyOf = function (d) { const m = d.match(/<body[^>]*>([\s\S]*)<\/body>/i); return m ? m[1] : ""; };

  const t2 = Date.now();
  const one = Utilities.newBlob(docs[0], MimeType.HTML).getAs(MimeType.PDF).getBytes().length;
  const oneMs = Date.now() - t2;

  const joined = docs.map(bodyOf).join('\n<div style="page-break-after: always;"></div>\n');
  const merged = docs[0].replace(/(<body[^>]*>)[\s\S]*(<\/body>)/i, function (_m, o, cl) { return o + joined + cl; });
  const t3 = Date.now();
  const allBytes = Utilities.newBlob(merged, MimeType.HTML).getAs(MimeType.PDF).getBytes().length;
  const allMs = Date.now() - t3;

  const lines = [
    "students            : " + docs.length,
    "sheet read          : " + readMs + " ms  (this ran ONCE per student in the old loop)",
    "build " + docs.length + " documents  : " + buildMs + " ms",
    "getAs  1 document   : " + oneMs + " ms  (" + one + " bytes)",
    "getAs  " + docs.length + " merged     : " + allMs + " ms  (" + allBytes + " bytes)",
    "",
    "old batch estimate  : " + (docs.length * (readMs + oneMs)) + " ms server + "
      + (docs.length * 800) + " ms client sleep + " + docs.length + " round trips",
    "new batch measured  : " + (readMs + buildMs + allMs) + " ms server + 1 round trip",
    "",
    "⚠️ ms is noisy in this project — read the median of three runs, never one."
  ];
  const out = lines.join("\n");
  Logger.log(out);
  return out;
}
