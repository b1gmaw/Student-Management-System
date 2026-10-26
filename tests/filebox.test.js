// File selectors: what is already stored, and what a save keeps.
//
// §1 — re-saving a booking must KEEP its ヒアリングシート. confirmBooking read the stored
//      file back from #existingFileAnchor's href, and 801f363 removed that href (the file is
//      private, opened through onclick). Every re-save then sent existingDocumentUrl "" and
//      the server wrote the empty string over the document cell. Reproduced in the driver
//      before the fix: modal showing the file, payload carrying "".
// §2 — ＋建物追加 after 編集 must not carry the previous building's 外観写真. form.reset()
//      leaves a script-set hidden input alone, because its value IS its default.
//
// These run the REAL functions, extracted from Index.html into a vm sandbox, so there is no
// transcription to drift (cellsafe §8's lesson).

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

const html = fs.readFileSync(path.join(__dirname, "..", "Index.html"), "utf8");
const app = html.match(/<script>([\s\S]*?)<\/script>/g)[1];

// Brace-matched extraction that skips strings, template literals and comments — an
// apostrophe inside a comment ran a naive matcher into the next function once already.
function extract(src, name) {
  let start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  if (src.slice(start - 6, start) === "async ") start -= 6;   // confirmBooking is async
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n2 = src[i + 1];
    if (c === "/" && n2 === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && n2 === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

// ---- §1 booking -----------------------------------------------------------------------
console.log("§1 re-saving a booking keeps its stored document");

function runConfirm(src, storedDoc, chosenFile) {
  const els = {
    btnConfirmBooking: { innerText: "確定", disabled: false },
    bookingDate: { value: "2026-10-05" }, bookingPeriod: { value: "1" },
    bookingName: { value: "テスト" }, bookingNationality: { value: "" },
    bookingCourse: { value: "" }, bookingLink: { value: "" }, bookingIntake: { value: "" },
    bookingRemarks: { value: "備考だけ直した" },
    bookingFile: { files: chosenFile ? [chosenFile] : [] },
    // The OLD code's source of truth: shown, and carrying no href (as since 801f363).
    existingFileDiv: { style: { display: "block" } },
    existingFileAnchor: { getAttribute: () => null, href: "" },
  };
  const ctx = {
    document: { getElementById: (id) => els[id] || null },
    currentUser: { name: "営業 花子" }, currentTeacherId: "T1", currentTeacherName: "先生",
    getBase64FromFile: async (f) => f ? { base64: "QUJD", mimeType: "application/pdf", name: f.name } : null,
    calRegisterBooking: (d, p, o) => { ctx.sent = o; },
    closeBookingModal: () => {}, alert: () => {}, console,
    _bookingStoredDoc: storedDoc,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.confirmBooking().then(() => ctx.sent);
}

const confirmSrc = extract(app, "confirmBooking");
const openSrc = extract(app, "openBookingModal");
// The shape before the fix, kept as the mutation this section must reject.
const OLD_CONFIRM_TAIL = `let anchorEl = document.getElementById("existingFileAnchor");
          let divEl = document.getElementById("existingFileDiv");
          let existingDocUrl = "";
          if (anchorEl && anchorEl.getAttribute("href") && anchorEl.getAttribute("href") !== "#") {
              existingDocUrl = anchorEl.href;
          }
          if (divEl && divEl.style.display === "none") { existingDocUrl = ""; }
          let docUrlToKeep = fileData ? "" : existingDocUrl;`;
const oldConfirmSrc = confirmSrc && confirmSrc.replace(
  /let docUrlToKeep = fileData \? "" : _bookingStoredDoc;/, OLD_CONFIRM_TAIL);

const tasks = [];
tasks.push((async () => {
  check("confirmBooking found", !!confirmSrc);
  const kept = await runConfirm(confirmSrc, "https://drive.example/U1", null);
  check("no new file → the stored URL is sent", kept.existingDocumentUrl === "https://drive.example/U1",
        JSON.stringify(kept.existingDocumentUrl));
  const replaced = await runConfirm(confirmSrc, "https://drive.example/U1", { name: "new.pdf" });
  check("new file → nothing kept (the upload replaces it)", replaced.existingDocumentUrl === "" &&
        replaced.documentBase64 === "QUJD");
  const none = await runConfirm(confirmSrc, "", null);
  check("no stored file, no new file → empty", none.existingDocumentUrl === "");

  check("mutation: the old href read is really a different program", oldConfirmSrc !== confirmSrc);
  const oldKept = await runConfirm(oldConfirmSrc, "https://drive.example/U1", null);
  check("mutation: the old href read DROPS the document (proves §1 can fail)",
        oldKept.existingDocumentUrl === "", JSON.stringify(oldKept.existingDocumentUrl));
})());

check("confirmBooking never reads an href to find the stored file",
      confirmSrc && !/getAttribute\(\s*["']href["']\s*\)/.test(confirmSrc));
check("openBookingModal records the stored file in _bookingStoredDoc (every open, empty included)",
      openSrc && /_bookingStoredDoc\s*=\s*cDoc\s*;/.test(openSrc));
{
  const decl = app.indexOf("let _bookingStoredDoc");
  check("_bookingStoredDoc is declared above its writer and reader (rule 3)",
        decl > -1 && decl < app.indexOf("function openBookingModal(") &&
        decl < app.indexOf("function confirmBooking("));
}

// ---- §2 building --------------------------------------------------------------------
console.log("§2 ＋建物追加 starts with no stored 外観写真");
{
  const addSrc = extract(app, "openAddBldgModal");
  check("openAddBldgModal found", !!addSrc);
  const clears = (src) => /getElementById\(\s*["']existingExteriorId["']\s*\)\.value\s*=\s*["']{2}/.test(src || "");
  check("openAddBldgModal clears existingExteriorId", clears(addSrc));
  check("mutation: without that line the check fails",
        !clears(addSrc.replace(/document\.getElementById\("existingExteriorId"\)\.value = "";/, "")));
}

// ---- §3 the indicator ---------------------------------------------------------------
// Every file selector says whether a file is already stored. A browser never pre-fills a
// file input, so without the box nothing on screen can say it.
console.log("§3 every file selector carries the stored / chosen indicator");
{
  // Derived from the MARKUP, so a 13th input added later fails here rather than shipping bare.
  const inputs = html.match(/<input type="file"[^>]*>/g) || [];
  const wrapped = html.match(/<div class="file-box" data-mode="(?:add|replace)"><div class="file-box-status" aria-live="polite"><\/div><input type="file"[^>]*><\/div>/g) || [];
  check("there are file inputs at all (" + inputs.length + ")", inputs.length >= 12);
  check("every <input type=\"file\"> sits in a .file-box", wrapped.length === inputs.length,
        wrapped.length + " of " + inputs.length);
  check("the old under-the-box link is gone", !/existingFileAnchor|existingFileDiv/.test(html));

  // A minimal DOM: enough for fileBoxPaint's querySelector / createElement / textContent.
  function el(tag) {
    const e = { tagName: tag, children: [], dataset: {}, _text: "", className: "", onclick: null,
      appendChild(c) { this.children.push(c); return c; },
      get textContent() { return this._text + this.children.map(c => c.textContent).join(""); },
      set textContent(v) { this._text = String(v); this.children = []; },
      set innerHTML(v) { throw new Error("innerHTML used — the file name must go in as text"); },
    };
    return e;
  }
  function makeBox(mode, stored, fileName) {
    const status = el("div"), input = el("input");
    input.files = fileName ? [{ name: fileName }] : [];
    Object.defineProperty(input, "value", { set(v) { if (v === "") input.files = []; } });
    const box = el("div");
    box.dataset = { mode, stored: stored ? "1" : "" };
    box.querySelector = (sel) => sel === 'input[type="file"]' ? input : sel === ".file-box-status" ? status : null;
    return { box, status, input };
  }
  const paintSrc = extract(app, "fileBoxPaint");
  check("fileBoxPaint found", !!paintSrc);
  const ctx = { document: { createElement: el } };
  vm.createContext(ctx);
  vm.runInContext(paintSrc, ctx);

  const s1 = makeBox("replace", false, null); ctx.fileBoxPaint(s1.box);
  check("nothing stored, nothing chosen → none / 未登録",
        s1.box.dataset.state === "none" && s1.status.textContent === "未登録");
  const s2 = makeBox("replace", true, null); s2.box._fileBoxView = () => {}; ctx.fileBoxPaint(s2.box);
  check("stored → stored / ✓ 登録済み with 見る",
        s2.box.dataset.state === "stored" && s2.status.textContent === "✓ 登録済み見る");
  const s2b = makeBox("replace", true, null); ctx.fileBoxPaint(s2b.box);
  check("stored with no viewer (building photos) → no 見る button",
        s2b.status.textContent === "✓ 登録済み");
  const evil = "<img src=x onerror=alert(1)>.jpg";
  const s3 = makeBox("replace", true, evil); ctx.fileBoxPaint(s3.box);
  check("stored + chosen → new / 置き換え, file name as TEXT",
        s3.box.dataset.state === "new" && s3.status.textContent === "↻ 置き換え: " + evil + "取消");
  const s4 = makeBox("replace", false, "a.pdf"); ctx.fileBoxPaint(s4.box);
  check("chosen with nothing stored → 追加, not 置き換え",
        s4.status.textContent === "＋ 追加: a.pdf取消");
  const cancel = s3.status.children.find(c => c.tagName === "button");
  cancel.onclick();
  check("取消 clears the choice and falls back to the stored state", s3.box.dataset.state === "stored");

  check("the file name is never written with innerHTML", !/innerHTML/.test(paintSrc));
  check("ONE delegated change listener repaints any box",
        /document\.addEventListener\('change', function \(e\) \{[^}]*fileBoxOf\(e\.target\)[^}]*fileBoxPaint\(box\)/.test(app));

  // Each loader records the stored state. Missing one leaves that box reading 未登録 over a
  // file that is really there — the exact thing this feature exists to show.
  const sites = [
    ["booking opener", "openBookingModal", /fileBoxSet\(document\.getElementById\("bookingFile"\), !!cDoc,/],
    ["add building", "openAddBldgModal", /fileBoxSet\(document\.getElementById\("addBldgForm"\)\.exteriorPhoto, false\)/],
    ["photo slot ✕", "hidePhotoSlot", /fileBoxSet\(slot\.querySelector\('input\[type="file"\]'\), false\)/],
  ];
  for (const [label, fn, re] of sites) check("wired: " + label, re.test(extract(app, fn) || ""));
  const edit = extract(app, "openEditBldgModal") || "";
  check("wired: 編集 exterior", /fileBoxSet\(form\.exteriorPhoto, !!d\[32\], null, d\[32\], 'photo'\)/.test(edit));
  check("wired: 編集 all four slot kinds (洗濯機 / ゴミ / 駐輪場 / その他)",
        (edit.match(/fileBoxSet\(slot\.querySelector\('input\[type="file"\]'\), !!id, null, id, 'photo'\)/g) || []).length === 4);
}

// ---- §4 the stored file's NAME --------------------------------------------------------
// The sheets hold ids only, so the name comes from Drive through getStoredFileNames. That
// reads as the deployer, which makes its allow-list as load-bearing as getUploadedFile's.
console.log("§4 the stored file's name");
{
  const CODE = fs.readFileSync(path.join(__dirname, "..", "Code.js"), "utf8");
  const sctx = {
    _permOrLegacyRole_: (r, p, need) => String(p).split(",").indexOf(need) !== -1,
    _hasPerm_: (r, p, need) => String(p).split(",").indexOf(need) !== -1,
    Utilities: { base64Decode: (b) => b, newBlob: (bytes, mime, name) => ({ name }) },
  };
  vm.createContext(sctx);
  const labelSrc = extract(CODE, "_storedFileLabel_");
  const namesSrc = extract(CODE, "getStoredFileNames");
  const upSrc = extract(CODE, "_uploadBuildingPhoto_");
  check("server functions found", !!(labelSrc && namesSrc && upSrc));
  vm.runInContext(labelSrc + "\n" + namesSrc + "\n" + upSrc + "\nvar STORED_NAME_MAX = " +
    (CODE.match(/const STORED_NAME_MAX = (\d+);/) || [, "NaN"])[1] + ";", sctx);
  const L = sctx._storedFileLabel_;

  check("hearing: teacherId_date_ prefix removed", L("T01_2026-10-05_ヒアリング_山田.pdf", "hearing") === "ヒアリング_山田.pdf");
  check("hearing: an underscore in the teacher id is fine", L("T_01_2026-10-05_a.pdf", "hearing") === "a.pdf");
  check("photo: bldg_slot_ prefix removed", L("B012_WM_1_IMG_0412.jpg", "photo") === "IMG_0412.jpg");
  check("photo: exterior", L("B012_Exterior_正面.jpg", "photo") === "正面.jpg");
  check("photo: その他 (Misc_N)", L("B012_Misc_2_掲示板.jpg", "photo") === "掲示板.jpg");
  check("photo before 2026-09-29 (no uploaded name) → nothing to show", L("B012_Garbage_2.jpg", "photo") === "");
  check("⚠️ the KIND picks the rule: a dated photo name keeps its date",
        L("B012_WM_1_2026-04-01_scan.jpg", "photo") === "2026-04-01_scan.jpg");

  // Upload naming round-trips through the label.
  const folder = { createFile: (blob) => ({ getId: () => blob.name }) };
  const up = (obj) => sctx._uploadBuildingPhoto_(folder, "B012", obj, "WM_1", "");
  check("upload keeps the uploaded name", up({ base64: "x", mimeType: "image/jpeg", filename: "IMG_0412.jpg" }) === "B012_WM_1_IMG_0412.jpg");
  check("upload with no name keeps the old shape", up({ base64: "x", mimeType: "image/jpeg" }) === "B012_WM_1.jpg");
  check("round trip: what is uploaded is what the box shows",
        L(up({ base64: "x", mimeType: "image/jpeg", filename: "外観.png" }), "photo") === "外観.png");
  check("no new photo → the existing id, untouched",
        sctx._uploadBuildingPhoto_(folder, "B012", "", "WM_1", "KEEP") === "KEEP");

  // The endpoint, with Drive and both allow-lists stubbed.
  const HID = "H".repeat(30), PID = "P".repeat(30), OTHER = "O".repeat(30);
  let driveReads = [], listReads = [];
  sctx._hearingSheetFileIds_ = () => { listReads.push("hearing"); return { [HID]: true }; };
  sctx._buildingPhotoFileIds_ = () => { listReads.push("photo"); return { [PID]: true }; };
  sctx.DriveApp = { getFileById: (id) => { driveReads.push(id); return { getName: () =>
    id === HID ? "T01_2026-10-05_sheet.pdf" : id === PID ? "B012_Exterior_front.jpg" : "SECRET_backup" }; } };
  const G = (perms, kind, refs) => { driveReads = []; listReads = []; return sctx.getStoredFileNames("x", perms, kind, refs); };

  let threw = false;
  try { G("", "hearing", [HID]); } catch (e) { threw = /権限がありません/.test(e.message); }
  check("no record permission → refused before any lookup", threw && driveReads.length === 0 && listReads.length === 0);
  const url = "https://drive.google.com/file/d/" + HID + "/view";
  check("hearing: a stored URL answers with the label, keyed by the ref sent",
        JSON.stringify(G("view_interview_results", "hearing", [url])) === JSON.stringify({ [url]: "sheet.pdf" }));
  check("photo: an id answers", G("view_dorms", "photo", [PID])[PID] === "front.jpg");
  const leak = G("view_dorms", "photo", [OTHER]);
  check("⚠️ an id attached to no record is NOT read from Drive", !(OTHER in leak) && driveReads.length === 0);
  G("view_dorms", "photo", [HID]);
  check("a hearing id asked as a photo finds nothing (the kind only picks the list)", driveReads.length === 0);
  G("view_dorms", "photo", [PID]);
  check("one allow-list read per call, the kind's own", listReads.join() === "photo");
  check("unknown kind → nothing read", JSON.stringify(G("view_dorms", "bytes", [PID])) === "{}" && listReads.length === 0);
  G("view_dorms", "photo", new Array(40).fill(PID));
  check("capped at STORED_NAME_MAX lookups", driveReads.length === 12, driveReads.length);

  // Mutation: drop the membership check — the leak test must see it.
  const leaky = namesSrc.replace("if (!m || !allowed[m[0]]) return;", "if (!m) return;");
  check("mutation: the leaky shape is a different program", leaky !== namesSrc);
  const mctx = Object.assign({}, sctx); vm.createContext(mctx); vm.runInContext(labelSrc + "\n" + leaky + "\nvar STORED_NAME_MAX = 12;", mctx);
  check("mutation: without the allow-list an unattached id IS read (proves the check can fail)",
        (OTHER in mctx.getStoredFileNames("x", "view_dorms", "photo", [OTHER])));

  // The guard is a copy of getUploadedFile's, so bind the two: widening one alone fails here.
  const guardOf = (src) => (src.match(/if \(!_permOrLegacyRole_\([^{]*\{/) || [""])[0];
  check("same guard as getUploadedFile", guardOf(namesSrc) !== "" &&
        guardOf(namesSrc) === guardOf(extract(CODE, "getUploadedFile") || ""));
  check("registered in _apiMethods_", /getStoredFileNames: getStoredFileNames,/.test(CODE));
  // Photo columns: the ten the 編集 loader reads (d[21..26], d[29..31], d[32]).
  check("photo allow-list reads exactly the thirteen photo columns (その他 = 49–51)",
        /const cols = \[21, 22, 23, 24, 25, 26, 29, 30, 31, 32, 49, 50, 51\];/.test(extract(CODE, "_buildingPhotoFileIds_") || ""));

  // Client: the box shows the name, and every stored-state call site says what kind it is.
  const ictx = { document: { createElement: (t) => ({ tagName: t, children: [], _text: "",
      appendChild(c) { this.children.push(c); }, get textContent() { return this._text + this.children.map(c => c.textContent).join(""); },
      set textContent(v) { this._text = v; this.children = []; } }) },
    _fileNameCache: { "photo|PID": "front.jpg" } };
  vm.createContext(ictx);
  vm.runInContext(extract(app, "fileBoxPaint"), ictx);
  const status = ictx.document.createElement("div");
  const box = { dataset: { stored: "1" }, _fileBoxRef: "PID", _fileBoxKind: "photo",
    querySelector: (s) => s === ".file-box-status" ? status : { files: [] } };
  ictx.fileBoxPaint(box);
  check("stored box shows 「✓ 登録済み: name」", status.textContent === "✓ 登録済み: front.jpg", status.textContent);
  box._fileBoxRef = "UNKNOWN"; ictx.fileBoxPaint(box);
  check("no name yet → plain 「✓ 登録済み」", status.textContent === "✓ 登録済み");
  const kinded = (app.match(/, '(?:hearing|photo)'\);/g) || []).length;
  check("booking + exterior + 4 slot loops pass a kind (6)", kinded === 6, kinded);
  check("the lookup is batched through one timer", /_fileNameTimer = setTimeout\(_fileBoxFlushNames, 0\)/.test(app));
}

Promise.all(tasks).then(() => {
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}, (e) => { console.log("  FAIL  crashed: " + e.stack); process.exit(1); });
