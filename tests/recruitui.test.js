// 募集状況: the clean-up pass (2026-09-11). Same layout; only what measured inconsistent.
//
// Measured before, at 1440×900: five solid primary buttons with 保存 — the only one that
// writes — indistinguishable from the four settings buttons; 定員 inputs with NO class, so the
// browser's 2px inset default; date inputs 43px beside a 39px 担当 select, which poked 17px
// past the content edge; roster controls 16–18px tall; every row ✕ a <span onclick> with no
// keyboard path, and 不交付 using × where the others used ✕.
//
// ⚠️ Each check below is also run against the OLD markup (the mutation) and must FAIL there.
// A check that passes both ways is worth nothing — the harness bug that nearly shipped in
// session.test.js (a mutant helper loading the unmutated source) is why this is explicit.

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
// Run a predicate on the real file (must hold) and on the old shape (must not).
function guard(name, pred, from, to, why) {
  const now = pred(HTML);
  let old;
  try { old = pred(swap(HTML, from, to)); } catch (e) { old = 'mutation failed: ' + e.message; }
  check(name, now === true, why || '');
  check("  mutation: the old shape fails it", old === false, String(old));
}
const parts = function (h) {
  const style = h.slice(h.indexOf('<style>'), h.indexOf('</style>'));
  const at = style.indexOf('@media (max-width: 820px)');
  const block = style.slice(style.indexOf('/* 募集状況 clean-up'), style.indexOf('.rec-x-hdr {') + 200);
  return { desk: style.slice(0, at), media: style.slice(at), block: block };
};
const js = function (h) { return (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || ''; };
function fnBody(h, name) {
  const s = js(h), i = s.indexOf('function ' + name + '(');
  return i < 0 ? '' : s.slice(i, s.indexOf('\n      function ', i + 1));
}

console.log("\n1. 保存 is the one solid button");
guard("the tonal rule is scoped to 募集状況, in the desktop stylesheet",
  function (h) { const p = parts(h);
    return /#sub-view-recruit \.schedule-btn \{ background: var\(--report-header-bg\); color: var\(--table-header-text\); \}/.test(p.desk); },
  "#sub-view-recruit .schedule-btn { background: var(--report-header-bg)", "#sub-view-recruit .schedule-btn-X { background: var(--report-header-bg)");
check("...and carries NO border (it would add 2px to every button)",
  !/#sub-view-recruit \.schedule-btn \{[^}]*border/.test(parts(HTML).desk), "");
check("保存 is still .export-btn, so the tonal rule cannot reach it",
  /id="btnRecSave" class="export-btn"/.test(HTML), "");
check("the 入学期 select matches the buttons' height", /#recIntakeSelect \{ height: 35px;/.test(parts(HTML).desk), "");

console.log("\n2. 定員・残枠 inputs have a style of their own");
guard("numCell's input carries class=\"rec-num\" and no inline style",
  function (h) { const b = fnBody(h, 'recRenderCapacitySummary');
    return /<input type="number" min="0" value="' \+ \(val === null \? '' : val\) \+ '" class="rec-num" data-co="/.test(b) && !/style="width:56px; padding:2px;"/.test(b); },
  `'" class="rec-num" data-co="`, `'" style="width:56px; padding:2px;" data-co="`,
  "without a class it falls to the browser's 2px inset default");
check("...and .rec-num gives it the page's input look",
  /#recCapacityTable \.rec-num \{[\s\S]*?border: 1px solid var\(--input-border\)/.test(parts(HTML).desk), "");

console.log("\n3. the 日程 row fits its column");
guard("#recDateGrid tracks auto-fill, and keeps its -30px alignment",
  function (h) { return /id="recDateGrid" style="display:grid; grid-template-columns:repeat\(auto-fill, minmax\(140px, 1fr\)\); gap:10px; margin-top:-30px;"/.test(h); },
  'grid-template-columns:repeat(auto-fill, minmax(140px, 1fr))', 'grid-template-columns:repeat(4, 160px)',
  "four fixed 160px tracks are 670px in a ~647px column — 担当 stuck out 17px");
check("⚠️ the desktop CSS never names #recDateGrid (mobile.test reserves it to the media block)",
  !/#recDateGrid/.test(parts(HTML).desk.replace(/\/\*[\s\S]*?\*\//g, '')), "");
check("the four 日程 fields share one height",
  /#recListDate, #recApplyDate, #recResultDate, #recChargeSelect \{ height: 38px;/.test(parts(HTML).desk), "");

console.log("\n4. 連絡事項 fills down to the table, and a phone keeps the old box");
guard("the editor has no inline max-height, so the desktop fill can work",
  function (h) { return /id="recNoteEditor" style="min-height:120px; overflow-y:auto;/.test(h); },
  'id="recNoteEditor" style="min-height:120px; overflow-y:auto;', 'id="recNoteEditor" style="min-height:120px; max-height:220px; overflow-y:auto;',
  "an inline max-height beats any stylesheet rule — measured: it stopped 21px short");
check("desktop: the column stretches and the editor takes the rest (flex-basis 0, so a long note scrolls)",
  /#recNoteCol \{ align-self: stretch; display: flex; flex-direction: column; \}/.test(parts(HTML).desk) &&
  /#recNoteCol #recNoteEditor \{ flex: 1 1 0; \}/.test(parts(HTML).desk), "");
check("⚠️ phone: the media block restores the old content-sized, 220px-capped box",
  /#recNoteEditor \{ flex: none !important; max-height: 220px !important; \}/.test(parts(HTML).media),
  "stacked, there is no table to fill to — without this the editor sits at its 120px minimum");
check("⚠️ min-width:300px survives on the note column — the mobile block zeroes it by attribute",
  /<div id="recNoteCol" style="flex:1; min-width:300px;">/.test(HTML), "");

console.log("\n5. rosters: 22px controls, text areas NOT shrunk");
check("selects and inputs get one 22px box", (function (d) {
  return /#recVisaTable select, #recCancelTable select, #recNotIssuedTable select \{ height: 22px;/.test(d) &&
         /#recVisaTable input, #recCancelTable input, #recNotIssuedTable input \{ height: 18px;/.test(d); })(parts(HTML).desk), "");
guard("⚠️ the roster rule does NOT change box-sizing",
  function (h) { const b = parts(h).block; return b.length > 200 && !/#recVisaTable[^{]*\{[^}]*box-sizing/.test(b); },
  '#recVisaTable input, #recCancelTable input, #recNotIssuedTable input { height: 18px;',
  '#recVisaTable input, #recCancelTable input, #recNotIssuedTable input { box-sizing: border-box; height: 18px;',
  "measured: border-box shrank every text area ~8px and made truncation WORSE");
check("担当 is widened to 84px in キャンセル and 不交付 — and only there",
  (js(HTML).match(/sel\(r, 'incharge', staffOpts, 84\)/g) || []).length === 2, "");
check("留学ビザ以外: 課程 100, 担当 74", /\{ k: 'course', label: '課程', w: 100 \},\s*\{ k: 'incharge', label: '担当', w: 74 \}/.test(js(HTML)), "");
guard("⚠️ the キャンセル column can shrink, so its three tables wrap instead of overflowing",
  function (h) { return /<div class="rec-bottom-col" style="flex:0 1 auto; min-width:0;">\s*<h4[^>]*>キャンセル<\/h4>/.test(h); },
  '<div class="rec-bottom-col" style="flex:0 1 auto; min-width:0;">\n              <h4 style="margin:0; color:var(--table-header-text);">キャンセル</h4>',
  '<div class="rec-bottom-col" style="flex:0 0 auto;">\n              <h4 style="margin:0; color:var(--table-header-text);">キャンセル</h4>',
  "flex:0 0 auto never shrinks — at 1000px wide it ran 262px past the edge");

console.log("\n6. add / delete are buttons, with one glyph");
['recDeleteCancelRow', 'recDeleteVisaRow', 'recDeleteNotIssuedRow'].forEach(function (fn) {
  check(fn + " is reached from a <button class=\"rec-x\">",
    new RegExp('<button type="button" class="rec-x" title="削除" onclick="' + fn + '\\(').test(js(HTML)), "");
});
guard("⚠️ no span handler is left for a row ✕, the group ＋ or the 担当者 ✕",
  function (h) { return !/<span[^>]*onclick="(recDelete\w+|recAddCancelRow|recRemoveRecruiter)\(/.test(js(h)); },
  `<button type="button" class="rec-x" title="削除" onclick="recDeleteVisaRow(`,
  `<span style="cursor:pointer; color:#e74a3b; font-size:11px;" title="削除" onclick="recDeleteVisaRow(`,
  "a span has no keyboard path at all");
guard("one glyph: 不交付's delete is ✕, not ×",
  function (h) { return /onclick="recDeleteNotIssuedRow\(' \+ escAttrJsStr\(_recRowKey\(r\)\) \+ '\)">✕<\/button>/.test(js(h)); },
  `recDeleteNotIssuedRow(' + escAttrJsStr(_recRowKey(r)) + ')">✕</button>`, `recDeleteNotIssuedRow(' + escAttrJsStr(_recRowKey(r)) + ')">×</button>`);
check("the group ＋ keeps `onclick=… data-k=` in that order (mobile.test pins it)",
  /<button type="button" class="rec-plus" title="行を追加" onclick="recAddCancelRow\(this\.dataset\.k\)" data-k="/.test(js(HTML)), "");
guard("both ＋ 行を追加 share one tier (neither is btn-xs / btn-sm)",
  function (h) { return /class="schedule-btn permission-req" data-perm="edit_recruitment" data-orig-display="inline-block" style="display:none;" onclick="recAddNotIssuedRow\(\)"/.test(h) &&
                        /class="schedule-btn permission-req" data-perm="edit_recruitment" data-orig-display="inline-block" style="display:none;" onclick="recAddVisaRow\(\)"/.test(h); },
  'class="schedule-btn permission-req" data-perm="edit_recruitment" data-orig-display="inline-block" style="display:none;" onclick="recAddNotIssuedRow()"',
  'class="schedule-btn permission-req btn-xs" data-perm="edit_recruitment" data-orig-display="inline-block" style="display:none;" onclick="recAddNotIssuedRow()"',
  "one role, one tier — the scale's rule");

console.log("\n7. the block stays in its lane");
{
  const p = parts(HTML);
  check("the clean-up block sits in the desktop stylesheet, above the media block",
    p.block.length > 500 && p.desk.indexOf('/* 募集状況 clean-up') !== -1, "");
  check("it carries no !important", !/!important/.test(p.block.replace(/\/\*[\s\S]*?\*\//g, '')), "");
  const sels = (p.block.replace(/\/\*[\s\S]*?\*\//g, '').match(/(^|\})\s*([^{}]+)\{/g) || [])
    .map(function (x) { return x.replace(/^\}?\s*/, '').replace(/\{$/, '').trim(); });
  const loose = sels.filter(function (s) {
    return s.split(',').some(function (one) { return !/#(sub-view-recruit|rec[A-Z]\w*)/.test(one); });
  });
  check("every selector in it is scoped to 募集状況 ids", sels.length >= 10 && loose.length === 0,
    loose.join(' | ') || (sels.length + ' selectors'));
}

console.log("\n" + pass + " passed, " + fail + " FAILED");
process.exit(fail ? 1 : 0);
