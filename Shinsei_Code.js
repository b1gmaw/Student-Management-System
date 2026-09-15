// ==========================================
// 1. SETUP & WEB APP UI
// ==========================================
// ==========================================
// SHINSEI (申請関連) BACKEND
// All functions prefixed shinsei_ to avoid collisions with main Code.gs
// doGet is handled by the main app's Code.gs
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

function shinsei_getStudentNames() {
  _requireSession_("shinsei_getStudentNames");
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
function shinsei_saveNewStudent(formDataArray) {
  _requireSession_("shinsei_saveNewStudent");
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
    sheet.appendRow(_cellSafeRow_(newRow));
    return (formDataArray[1] || "Student") + " のデータを保存しました！";
  } catch (error) {
    throw new Error(error.toString());
  } finally {
    lock.releaseLock();
  }
}

function shinsei_deleteStudent(studentName) {
  _requireSession_("shinsei_deleteStudent");
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Shinsei_Data") || ss.getSheetByName("Data");
  if (!sheet) throw new Error("Shinsei_Data シートが見つかりません。");
  const data = sheet.getDataRange().getValues();

  for (let r = 1; r < data.length; r++) { 
    if (String(data[r][0]).trim() === String(studentName).trim()) { // Check Col A
      let rowData = data[r];
      for (let i = 0; i < rowData.length; i++) {
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
    sheet.getRange(targetRow, 1, 1, SHINSEI_COLS).setValues([_cellSafeRow_(valuesToSet)]); // Write starting at Column A (1)
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

// ⚠️ export_shinsei, decided on the SERVER. Until 2026-09-15 it lived only on the three client
// buttons (プレビュー / この学生を出力 / 一括出力), so any signed-in account could call these from the
// console and export every student's documents.
// _hasPerm_ is given no role and no permissions ON PURPOSE: while enforcing, both come from the
// session, so master and admin-level pass exactly as the buttons show them (hasPermission grants
// admin-level on the client too). _requirePerm_ would refuse an admin-level caller the button
// offers, because it reads the permission string literally.
function _requireShinseiExport_() {
  if (!_authEnforcing_()) return;   // observe mode only logs, like every session guard
  if (!_hasPerm_("", "", "export_shinsei")) throw new Error("権限がありません");
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
