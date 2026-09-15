// 寮管理: the retouch into the app's palette (2026-09-11) — tonal secondaries, ONE solid primary
// per area, destructive as a red outline. Same layout, every handler and permission untouched.
//
// Measured before: five accents from inline background-color (yellow 自動割当 / 編集 / 名前変更,
// teal 建物登録 / 全部屋PDF / 追加 / 文言管理, green PDF, solid red 削除); .export-btn had NO
// :disabled style, so the disabled 名前変更 / 削除 looked clickable; the スケジュール form's
// labels fell beside or above their fields at random because .filter-group was only styled
// inside .student-filter-bar; and 11 ↑↓✕ controls were <span onclick>, unreachable by keyboard.
//
// ⚠️ Each guard is also run against the OLD markup and must fail there.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
function swap(src, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error('mutation anchor found ' + n + ' times: ' + from.slice(0, 70));
  return src.replace(from, to);
}
function guard(name, pred, from, to, why) {
  let old;
  try { old = pred(swap(HTML, from, to)); } catch (e) { old = 'mutation failed: ' + e.message; }
  check(name, pred(HTML) === true, why || '');
  check("  mutation: the old shape fails it", old === false, String(old));
}
const desk = function (h) { const st = h.slice(h.indexOf('<style>'), h.indexOf('</style>')); return st.slice(0, st.indexOf('@media (max-width: 820px)')); };
// Bounded at the view's LAST element: body-level modals follow it in the markup (募集状況's
// unsaved-changes modal among them), and they are not 寮管理.
const dormView = function (h) { const a = h.indexOf('<div id="view-dorms"'); return h.slice(a, h.indexOf('id="schedPreview"', a) + 200); };
const js = function (h) { return (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || ''; };
const block = function (h) { const d = desk(h); const i = d.indexOf('/* 寮管理 retouch'); return i < 0 ? '' : d.slice(i, d.indexOf('#schedPhraseModal .sx-btn.sx-del:hover', i) + 120); };

console.log("\n1. one palette: no accent colour left inline on a 寮管理 button");
{
  const ACCENTS = /background(-color)?:\s*#(f6c23e|36b9cc|4e73df|1cc88a|e74a3b)/i;
  guard("no toolbar button in the 寮管理 markup carries an inline accent colour",
    function (h) { return !(dormView(h).match(/<button[^>]*>/g) || []).some(function (b) { return ACCENTS.test(b); }); },
    'id="btnDocDelete" class="export-btn permission-req" data-perm="edit_dorms" data-orig-display="inline-block" style="display:none;"',
    'id="btnDocDelete" class="export-btn permission-req" data-perm="edit_dorms" data-orig-display="inline-block" style="display:none; background-color:#e74a3b;"',
    "five accents came from inline colours, which beat any stylesheet rule");
  guard("...nor do the building-row buttons built in the template literal",
    function (h) { const b = js(h); const i = b.indexOf('let editBtnHtml'); const row = b.slice(i, b.indexOf('header.innerHTML', i));
      return row.length > 200 && !ACCENTS.test(row); },
    `data-perm="edit_dorms" onclick="event.stopPropagation(); openEditBldgModal(`,
    `data-perm="edit_dorms" style="background-color:#f6c23e; color:#333;" onclick="event.stopPropagation(); openEditBldgModal(`);
  check("the tonal rule is scoped to #view-dorms",
    /#view-dorms \.schedule-btn, #view-dorms \.export-btn, #view-dorms \.btn-save \{\s*background: var\(--report-header-bg\); color: var\(--table-header-text\);/.test(block(HTML)), "");
  check("ONE primary per area, by id",
    /#view-dorms #btnAddRoomBtn, #view-dorms #btnDocAdd,\s*#view-dorms #btnSchedSaveTpl, #view-dorms #btnSchedPrint \{\s*background: var\(--primary-color\)/.test(block(HTML)), "");
  check("both 削除 are red OUTLINES, not solid red",
    /#view-dorms #btnDocDelete, #view-dorms #btnSchedDelTpl \{\s*background: transparent; color: var\(--alert-danger-text\);\s*box-shadow: inset 0 0 0 1px/.test(block(HTML)), "");
  guard("⚠️ a disabled button LOOKS disabled (.export-btn had no :disabled style at all)",
    function (h) { return /#view-dorms \.export-btn:disabled, #view-dorms \.schedule-btn:disabled \{\s*opacity: 0\.45;/.test(block(h)); },
    'opacity: 0.45; cursor: not-allowed; filter: none;', 'cursor: not-allowed; filter: none;',
    "名前変更 / 削除 start disabled until a file is chosen and looked fully clickable");
  // ⚠️ Reported: the building-row buttons had no visible hover — the shared brightness(0.9) on a
  // light tint over a light header. Measured with the driver's real-mouse --hover: rgb(90,103,216).
  guard("tonal buttons FILL with the primary on hover",
    function (h) { return /#view-dorms \.schedule-btn:hover:not\(:disabled\),\s*#view-dorms \.export-btn:hover:not\(:disabled\),\s*#view-dorms \.btn-save:hover:not\(:disabled\) \{\s*background: var\(--primary-color\); color: #fff;/.test(block(h)); },
    'background: var(--primary-color); color: #fff; filter: none;\n      }\n      #view-dorms #btnAddRoomBtn:hover',
    'filter: brightness(0.9);\n      }\n      #view-dorms #btnAddRoomBtn:hover',
    "a light tint on a light header: the old hover could not be seen");
  check("...while the primaries keep their darken and 削除 its red (id selectors outrank the class rule)",
    /#view-dorms #btnAddRoomBtn:hover, #view-dorms #btnDocAdd:hover,\s*#view-dorms #btnSchedSaveTpl:hover, #view-dorms #btnSchedPrint:hover \{ filter: brightness\(0\.9\); \}/.test(block(HTML)) &&
    /#view-dorms #btnDocDelete:hover:not\(:disabled\), #view-dorms #btnSchedDelTpl:hover \{\s*background: var\(--alert-danger-bg\)/.test(block(HTML)), "");
  check("the block adds no !important and sits in the desktop stylesheet",
    block(HTML).length > 500 && !/!important/.test(block(HTML).replace(/\/\*[\s\S]*?\*\//g, '')), "");
}

console.log("\n2. the pinned attributes survive byte for byte");
{
  // ⚠️ dormsync / mobile / buildingcolumns pin these exactly, and setupInterfaceBasedOnRole
  // drives visibility from them — which is WHY the palette is applied by id, not by a class.
  ['btnAutoFill', 'btnAddBldgBtn', 'btnAddRoomBtn', 'btnDocAdd', 'btnDocRename', 'btnDocDelete'].forEach(function (id) {
    check(id + " keeps class + data-perm + data-orig-display + inline display:none",
      new RegExp('<button id="' + id + '" class="export-btn permission-req" data-perm="edit_dorms" data-orig-display="inline-block" style="display:none;"').test(HTML), "");
  });
  check("the doc rename / delete still start disabled",
    /id="btnDocRename"[^>]* disabled/.test(HTML) && /id="btnDocDelete"[^>]* disabled/.test(HTML), "");
  check("#btnSchedPdf still has no icon and no .btn-label (schedule.test pins it)",
    /<button id="btnSchedPdf" class="schedule-btn" onclick="schedDownloadPdf\(\)">PDFをダウンロード<\/button>/.test(HTML), "");
}

console.log("\n3. the スケジュール form's labels sit above their fields");
{
  guard("⚠️ .filter-group stacks label over field — only where the label is a DIRECT child",
    function (h) { return /#schedForm \.filter-group:has\(> \.filter-label\) \{ display: flex; flex-direction: column; \}/.test(block(h)); },
    '#schedForm .filter-group:has(> .filter-label) { display: flex; flex-direction: column; }', '',
    "unstyled outside .student-filter-bar, the labels fell beside 敬称/言語 and above 名前");
  check("...which is what keeps the 建物・部屋 pair on ONE row (its labels are nested deeper)",
    /<div class="filter-group" style="display:flex; flex-wrap:nowrap;[^"]*">\s*<div style="display:flex; flex-direction:column;/.test(HTML), "");
}

console.log("\n4. ↑ ↓ ✕ are buttons: a keyboard can reach them");
{
  guard("⚠️ no <span onclick=\"sched…\"> is left in the editor or 文言管理",
    function (h) { return !/<span[^>]*onclick="sched\w+\(/.test(js(h)); },
    `<button type="button" class="sx-btn sx-del" title="この日程を削除" onclick="schedDeleteBlock(' + i + ')">✕</button>`,
    `<span style="cursor:pointer; color:#e74a3b;" title="この日程を削除" onclick="schedDeleteBlock(' + i + ')">✕</span>`);
  check("11 sx-btn controls, every one with a title",
    (js(HTML).match(/<button type="button" class="sx-btn[^"]*"[^>]*title="[^"]+"/g) || []).length === 11 &&
    (js(HTML).match(/class="sx-btn/g) || []).length === 11, "");
  check("the handlers are unchanged (schedule.test pins them)",
    /onclick="schedMoveItem\(' \+ i \+ ',' \+ j \+ ',-1\)"/.test(js(HTML)) && /onclick="schedDeleteItem\(' \+ i \+ ',' \+ j \+ '\)"/.test(js(HTML)), "");
}

console.log("\n5. the chevron");
{
  guard("▼ is an outline chevron SVG that keeps .bldg-chevron (the rotation is CSS)",
    function (h) { return /<span class="bldg-chevron"[^>]*><svg viewBox="0 0 24 24"[^>]*><path d="m6 9 6 6 6-6"\/><\/svg><\/span>/.test(js(h)); },
    '<span class="bldg-chevron" style="display:inline-flex; color:var(--text-muted);" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>',
    '<span class="bldg-chevron" style="font-size:18px; color:var(--text-muted);">▼</span>');
  check("the toggle still flips only the class", /\.bldg-chevron'\)\.classList\.toggle\('open'\)/.test(js(HTML)), "");
}

console.log("\n" + pass + " passed, " + fail + " FAILED");
process.exit(fail ? 1 : 0);
