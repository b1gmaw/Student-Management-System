// 入試関連: the retouch into the app's palette (2026-09-14) — tonal secondaries, ONE solid primary
// per area, destructive as a red outline, filters as chips. Same layout; handlers and permissions
// untouched. The pattern is tests/dormui.test.js.
//
// Measured before: five accents from inline colour (teal 今週へ / 読み込む / 列設定, green 出力,
// yellow 編集, solid red 削除) beside .schedule-btn's own dark solid; a calendar legend in hex
// literals matching neither the grid nor dark mode, with no entry for past slots; errors painted
// #e74a3b inline; and an intake tab whose onclick broke on a name containing '.
//
// ⚠️ Each guard is also run against the OLD shape and must fail there.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
const block = function (h) { const d = desk(h); const i = d.indexOf('/* 入試関連 retouch'); return i < 0 ? '' : d.slice(i, d.indexOf('/* end 入試関連 retouch */', i)); };
const view = function (h) { const a = h.indexOf('<div id="view-shared-schedule"'); return h.slice(a, h.indexOf('<!-- INTERVIEW RESULT ENTRY MODAL -->', a)); };
// Top-level modals sit at six spaces; everything inside them is indented further.
const modal = function (h, id) { const a = h.indexOf('\n      <div id="' + id + '"'); return h.slice(a, h.indexOf('\n      <div id="', a + 10)); };
const js = function (h) { return (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || ''; };
const fn = function (h, name) { const s = js(h); const i = s.indexOf('      function ' + name + '('); return i < 0 ? '' : s.slice(i, s.indexOf('\n      }\n', i) + 8); };
const ACCENT = /(background(-color)?|color):\s*#(f6c23e|36b9cc|4e73df|1cc88a|e74a3b)/i;

console.log("\n1. one palette: no accent colour left inline");
{
  const markup = function (h) { return view(h) + modal(h, 'interviewResultModal') + modal(h, 'placementManageModal') + modal(h, 'placementRowColModal'); };
  guard("no 入試関連 button in the markup (view + its three modals) carries an inline accent",
    function (h) { const b = markup(h).match(/<button[^>]*>/g) || []; return b.length > 10 && !b.some(function (t) { return ACCENT.test(t); }); },
    '<button class="schedule-btn" onclick="calJumpToCurrentWeek()">',
    '<button class="schedule-btn" style="background-color:#36b9cc;" onclick="calJumpToCurrentWeek()">');
  guard("...nor the 面接結果 row buttons built in renderPastInterviewsTable",
    function (h) { const f = fn(h, 'renderPastInterviewsTable'); return f.length > 500 && !ACCENT.test(f); },
    '<button class="btn-save btn-sm ir-del" onclick=',
    '<button class="btn-save btn-sm ir-del" style="background:#e74a3b; color:#fff;" onclick=');
  guard("...and the row buttons KEEP .btn-save (the mobile block squares them by it)",
    function (h) { const f = fn(h, 'renderPastInterviewsTable'); return f.indexOf('class="btn-save btn-sm ir-edit"') > 0 && f.indexOf('class="btn-save btn-sm ir-del"') > 0; },
    'class="btn-save btn-sm ir-edit"', 'class="schedule-btn btn-sm ir-edit"');
  const placement = function (h) { const s = js(h); return s.slice(s.indexOf('      function loadPlacementDashboard('), s.indexOf('      function escHtmlJs(s) {')); };
  guard("no accent colour anywhere in the placement code (buttons AND error text)",
    function (h) { const p = placement(h); return p.length > 5000 && !ACCENT.test(p); },
    `contentEl.innerHTML = "<p style='color:var(--alert-danger-text);'>エラー: "`,
    `contentEl.innerHTML = "<p style='color:#e74a3b;'>エラー: "`,
    "#e74a3b has no dark twin; --alert-danger-text does");
  guard("calStatus colours come from tokens",
    function (h) { const f = fn(h, 'calStatus'); return f.length > 100 && !/#(f6c23e|e74a3b)/.test(f); },
    "el.style.color = 'var(--alert-warning-text)'; el.innerText = '● 未保存",
    "el.style.color = '#f6c23e'; el.innerText = '● 未保存",
    "amber text on a light background was hard to read");
  check("the permission buttons keep class + data-perm + data-orig-display byte for byte",
    HTML.indexOf('id="btnAddInterviewResult" class="schedule-btn permission-req" data-perm="entry_interview_results" data-orig-display="inline-block" style="display:none;"') > 0 &&
    HTML.indexOf('id="btnImportFromBookings" class="schedule-btn permission-req" data-perm="entry_interview_results" data-orig-display="inline-block" style="display:none;"') > 0,
    "setupInterfaceBasedOnRole drives visibility from exactly these");
}

console.log("\n2. the CSS: tonal, one primary, red outline — scoped, and never fighting the permission loop");
{
  check("the block exists above the mobile media query", block(HTML).length > 1000, "");
  check("tonal secondaries, scoped to the view and its modals",
    /#view-shared-schedule \.schedule-btn, #view-shared-schedule \.btn-save,\s*#placementManageModal \.schedule-btn, #placementRowColModal \.schedule-btn \{\s*background: var\(--report-header-bg\); color: var\(--table-header-text\);/.test(block(HTML)), "");
  check("ONE primary in 面接結果, plus each modal's save, by id",
    /#view-shared-schedule #btnAddInterviewResult, #ir_saveBtn,\s*#btnSavePlacementCfg, #btnSavePlacementCols, #btnSaveRowCols \{\s*background: var\(--primary-color\)/.test(block(HTML)), "");
  guard("削除 is a red OUTLINE",
    function (h) { return /#view-shared-schedule \.btn-save\.ir-del,[^{]*\{\s*background: transparent; color: var\(--alert-danger-text\);/.test(block(h)); },
    '#view-shared-schedule .btn-save.ir-del,\n', '#view-shared-schedule .btn-save.ir-gone,\n');
  guard("⚠️ ...and its hover OUTRANKS the tonal fill (otherwise 削除 turns blue under the mouse)",
    function (h) { return /#view-shared-schedule \.btn-save\.ir-del:hover:not\(:disabled\),/.test(block(h)); },
    '#view-shared-schedule .btn-save.ir-del:hover:not(:disabled),', '#view-shared-schedule .ir-del:hover,',
    "1,2,0 loses to the tonal hover's 1,3,0");
  guard("no display and no !important in the block",
    function (h) { const b = block(h).replace(/\/\*[\s\S]*?\*\//g, ''); return b.length > 500 && !/!important|(^|[\s;{])display:\s*none/.test(b); },
    '.adm-chip.on { background: var(--primary-color); color: #fff; }',
    '.adm-chip.on { background: var(--primary-color); color: #fff; } #btnAddInterviewResult { display: none !important; }',
    "the permission loop owns display; the mobile block must keep winning on a phone");
}

console.log("\n3. the legend is drawn from the grid's own classes, as mini cells");
{
  const legend = function (h) { const a = h.indexOf('<div id="calLegend"'); return h.slice(a, h.indexOf('</div>', a)); };
  const swatches = function (h) {
    const out = []; const re = /<span class="cal-swatch ([^"]+)" aria-hidden="true">([^<]*)<\/span>/g; let m;
    while ((m = re.exec(legend(h)))) out.push({ cls: m[1], glyph: m[2] });
    return out;
  };
  guard("six swatches, every one a .slot-* class, and no hex",
    function (h) { const s = swatches(h); return s.length === 6 && s.every(function (x) { return /^slot-/.test(x.cls); }) && !/#[0-9a-f]{6}/i.test(legend(h)); },
    '<span class="cal-swatch slot-available" aria-hidden="true">〇</span>対応可能',
    '<span style="width:14px;height:14px;background:#c6f6d5;display:inline-block;"></span>対応可能',
    "hex literals matched neither the grid nor dark mode");
  guard("⚠️ 過去 is a FADED 〇 — what a past slot actually looks like — not an empty faded cell",
    function (h) { return /<span class="cal-swatch slot-available slot-past" aria-hidden="true">〇<\/span>過去/.test(legend(h)); },
    '<span class="cal-swatch slot-available slot-past" aria-hidden="true">〇</span>',
    '<span class="cal-swatch slot-none slot-past"></span>',
    "slot-none slot-past measured 1.00:1 against its background: invisible");
  // The glyphs are READ from _calCellState, so renaming a grid label without the legend fails.
  // ⚠️ Anchored on the STATUS, not the class alone: slot-cancel-req is also the incoming-交代
  // branch ('⇄ ' + name), which comes first in _calCellState and would be read instead of '!'.
  const gridLabel = function (h, status, cls) { const m = fn(h, '_calCellState').match(new RegExp("status === '" + status + "'\\) \\{ cls = '" + cls + "'; label = '([^']*)'")); return m ? m[1] : null; };
  guard("every swatch shows the grid's own label for its status",
    function (h) {
      const s = swatches(h); const by = function (c) { return s.filter(function (x) { return x.cls === c; }); };
      const cancel = by('slot-cancel-req');
      return gridLabel(h, 'Available', 'slot-available') === '〇' &&
        by('slot-available')[0].glyph === gridLabel(h, 'Available', 'slot-available') &&
        by('slot-unavailable')[0].glyph === gridLabel(h, 'Unavailable', 'slot-unavailable') &&
        cancel.length === 2 && cancel[0].glyph === gridLabel(h, 'Cancel_Request', 'slot-cancel-req') &&
        /label = '交代'/.test(fn(h, '_calCellState')) && cancel[1].glyph === '交代' &&
        by('slot-booked')[0].glyph === '氏名';
    },
    "cls = 'slot-unavailable'; label = '✖';", "cls = 'slot-unavailable'; label = '×';",
    "a legend symbol that is not the grid's symbol explains nothing");
  guard("the legend sits on a tinted bar, from a token",
    function (h) { return /#calLegend \{\s*background: var\(--table-header-bg\); border: 1px solid var\(--border-color\);/.test(block(h)); },
    'background: var(--table-header-bg); border: 1px solid var(--border-color);\n        border-radius: var(--r-md); padding: 8px 12px;',
    'padding: 8px 12px;');
  guard("⚠️ the swatch outline is currentColor and skips .slot-cancel-req, whose dashed border it would outrank",
    function (h) { return /#calLegend \.cal-swatch:not\(\.slot-cancel-req\) \{ border: 1px solid currentColor; \}/.test(block(h)); },
    '#calLegend .cal-swatch:not(.slot-cancel-req) { border:', '#calLegend .cal-swatch { border:');
}

console.log("\n4. an intake name containing ' no longer breaks its tab");
{
  function onclickArgs(h) {
    const s = js(h);
    const helpers = ['escHtmlJs', 'escAttrJs', 'escAttrJsStr'].map(function (n) { return fn(h, n); }).join('\n');
    const bar = { innerHTML: '' };
    const ctx = vm.createContext({ bar: bar });
    vm.runInContext(helpers + '\n' + fn(h, 'renderIntakeTabs') +
      '\nvar pastInterviewsData = [["入学期"], ["4月\'生"], [""]]; var selectedIntake = "__all__";' +
      '\nvar document = { getElementById: function () { return bar; } };\nrenderIntakeTabs(0);', ctx);
    const got = [];
    (bar.innerHTML.match(/onclick="([^"]*)"/g) || []).forEach(function (m) {
      const code = m.slice(9, -1).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      try { new Function('selectIntakeTab', code)(function (k) { got.push(k); }); } catch (e) { got.push('THREW'); }
    });
    return { got: got, html: bar.innerHTML };
  }
  guard("every tab's handler parses and passes the exact key back",
    function (h) { const r = onclickArgs(h); return r.got.length === 3 && r.got.indexOf("4月'生") !== -1 && r.got.indexOf('THREW') === -1; },
    "selectIntakeTab('${escAttrJsStr(key)}')", "selectIntakeTab('${escHtmlJs(key)}')",
    "escHtmlJs leaves quotes alone: selectIntakeTab('4月'生') is a SyntaxError");
  check("the tabs are chips, the selected one on and announced",
    /class="adm-chip on" aria-pressed="true"/.test(onclickArgs(HTML).html), "");
}

console.log("\n5. chips on both sub-tabs, one level below プレースメント's underlined intake tabs");
{
  guard("showPlacementCourse toggles the chips' on class",
    function (h) { return fn(h, 'showPlacementCourse').indexOf("chips[i].classList.toggle('on', i === courseIdx)") > 0; },
    "chips[i].classList.toggle('on', i === courseIdx)", "chips[i].classList.toggle('active', i === courseIdx)",
    "a chip built with .on and toggled with .active never shows which course is selected");
  check("the course chips are built as .adm-chip", fn(HTML, 'showPlacementIntake').indexOf('chip.className = "adm-chip"') > 0, "");
  check("...while the intake row stays underlined tabs", fn(HTML, 'loadPlacementDashboard').indexOf('btn.className = "sub-nav-btn"') > 0, "");
}

console.log("\n6. the two リンク管理 list copies stay identical");
{
  const s = js(HTML);
  const rows = s.match(/<button type="button" class='schedule-btn btn-xs pcfg-[^\n]*<\/button>/g) || [];
  const kinds = {};
  rows.forEach(function (r) { kinds[r] = (kinds[r] || 0) + 1; });
  check("five buttons, each emitted exactly twice with byte-identical markup",
    rows.length === 10 && Object.keys(kinds).length === 5 && Object.keys(kinds).every(function (k) { return kinds[k] === 2; }),
    JSON.stringify(kinds));
  const drifted = s.replace("class='schedule-btn btn-xs pcfg-del' data-idx='${idx}'", "class='schedule-btn btn-xs pcfg-del' data-idx='${idx}' style='background:#e74a3b;'");
  const r2 = drifted.match(/<button type="button" class='schedule-btn btn-xs pcfg-[^\n]*<\/button>/g) || [];
  const k2 = {}; r2.forEach(function (r) { k2[r] = (k2[r] || 0) + 1; });
  check("  mutation: recolouring ONE copy fails it", Object.keys(k2).length !== 5, JSON.stringify(k2));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
