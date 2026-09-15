// ホーム (2026-09-14): greeting bar, three count tiles, two cards, one palette.
//
// ⚠️ WHY. The items are drawn by _renderNotifInto, which ALSO fills the bell panel, and it painted
// five accents inline: yellow お知らせ (yellow text on white, unreadable) with a 📢, teal 交代, red
// キャンセル, primary 日時変更, and green upcoming interviews. A request was a clickable <div> with no
// tab stop, and 既読にする was a <span>, so a keyboard reached neither. The tiles count data the
// browser already holds, through one pure _homeStats.
//
// ⚠️ Each guard is also run against its OLD shape, which must fail.

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
const js = function (h) { return (h.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || ''; };
const fn = function (h, name) { const s = js(h); const i = s.indexOf('      function ' + name + '('); return i < 0 ? '' : s.slice(i, s.indexOf('\n      }\n', i) + 8); };
const view = function (h) { const a = h.indexOf('<div id="view-home"'); return h.slice(a, h.indexOf('\n      <div id="view-', a + 10)); };
const ACCENT = /#(f6c23e|36b9cc|e74a3b|1cc88a)\b/i;

console.log("\n1. one palette: no inline accent, no emoji");
{
  guard("the shared renderer paints no inline accent colour",
    function (h) { const f = fn(h, '_renderNotifInto'); return f.length > 1000 && !ACCENT.test(f); },
    'accent = "u-bad";', 'accent = "#e74a3b";');
  guard("...and no 📢", function (h) { return fn(h, '_renderNotifInto').indexOf('📢') === -1; },
    '<span class="u-badge u-warn">お知らせ</span>', '<span class="u-badge u-warn">📢 お知らせ</span>');
  guard("the upcoming-interview rows carry no inline accent either",
    function (h) { const f = fn(h, 'renderHomeUpcoming'); return f.length > 500 && !ACCENT.test(f) && f.indexOf('style=') === -1; },
    "h += '<div class=\"nt-row\">' +", "h += '<div class=\"nt-row\" style=\"border-left:4px solid #1cc88a;\">' +");
  check("state is a .u-badge per type: お知らせ warn, キャンセル bad, 交代/日時変更 the primary outline",
    /u-badge u-warn">お知らせ/.test(fn(HTML, '_renderNotifInto')) && /accent = "u-bad";/.test(fn(HTML, '_renderNotifInto')) &&
    (fn(HTML, '_renderNotifInto').match(/accent = "u-admin";/g) || []).length === 2, "");
  check("the ホーム markup has no inline style except the hidden-by-role tile",
    (view(HTML).match(/style="/g) || []).length === 1 && /id="homeStatUpcoming"[^>]*style="display:none;"/.test(view(HTML)), "");
}

console.log("\n2. every id the JS reads is still there");
{
  ['homeGreeting', 'homeDate', 'homeTodoCount', 'homeTodo', 'homeUpcoming', 'homeNewsCount', 'homeNews',
   'homeStatTodo', 'homeStatUpcoming', 'homeStatNews', 'homeTodoCard', 'homeNewsCard'].forEach(function (id) {
    check("#" + id, HTML.indexOf('id="' + id + '"') !== -1, "");
  });
  check("the renderer is still ONE copy, used by the bell and both home panels",
    (js(HTML).match(/function _renderNotifInto\(/g) || []).length === 1 &&
    /_renderNotifInto\('notifList'/.test(js(HTML)) && /_renderNotifInto\('homeNews'/.test(js(HTML)) && /_renderNotifInto\('homeTodo'/.test(js(HTML)),
    "a second copy for ホーム is how the bell and the page would drift apart");
}

console.log("\n3. the tile counts");
{
  const ctx = vm.createContext({});
  vm.runInContext(fn(HTML, '_homeStats'), ctx);
  const S = function () { return JSON.stringify(ctx._homeStats.apply(null, arguments)); };
  check("sales: requests, interviews and news counted", S([1, 2], [1, 2, 3], [1], 'sales') === '{"todo":2,"upcoming":3,"news":1}', S([1, 2], [1, 2, 3], [1], 'sales'));
  check("teacher gets an interview count too", S([], [1], [], 'teacher') === '{"todo":0,"upcoming":1,"news":0}', "");
  check("⚠️ master and admin get NO interview tile (null), matching renderHomeUpcoming",
    JSON.parse(S([1], [1, 2], [], 'master')).upcoming === null && JSON.parse(S([], [], [], 'admin')).upcoming === null, "");
  check("null inputs (not fetched yet) count as zero, never throw", S(null, null, null, 'sales') === '{"todo":0,"upcoming":0,"news":0}', "");
  let m;
  try {
    const c2 = vm.createContext({});
    vm.runInContext(swap(fn(HTML, '_homeStats'), "(role === 'teacher' || role === 'sales')", 'true'), c2);
    m = c2._homeStats([], [1], [], 'master').upcoming;
  } catch (e) { m = 'threw'; }
  check("mutation: without the role rule, master gets an interview tile", m === 1, String(m));
  check("the counts refresh when the interview list lands (_homeCountTodo calls _homeRenderStats)",
    /_homeRenderStats\(\);/.test(fn(HTML, '_homeCountTodo')), "");
}

console.log("\n4. a keyboard can reach every action");
{
  guard("a request item is focusable, with a key handler that opens it",
    function (h) { const f = fn(h, '_renderNotifInto'); return /setAttribute\('tabindex', '0'\)/.test(f) && /e\.key === 'Enter'/.test(f) && /setAttribute\('role', 'button'\)/.test(f); },
    "item.setAttribute('tabindex', '0');", "");
  guard("既読にする is a real <button>, keeping the class its listener finds",
    function (h) { return /<button type="button" class="notif-dismiss nt-act">既読にする<\/button>/.test(fn(h, '_renderNotifInto')) && /querySelector\('\.notif-dismiss'\)/.test(fn(h, '_renderNotifInto')); },
    '<button type="button" class="notif-dismiss nt-act">既読にする</button>', '<span class="notif-dismiss">既読にする</span>');
  check("the tiles are buttons", (view(HTML).match(/<button type="button" class="home-stat"/g) || []).length === 3, "");
}

console.log("\n5. the CSS");
{
  const style = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  const desk = style.slice(0, style.indexOf('@media (max-width: 820px)'));
  const at = desk.indexOf('/* ホーム retouch (2026-09-14)');
  const block = at < 0 ? '' : desk.slice(at, desk.indexOf('.nt-row-course', at) + 80);
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '');
  check("one desktop block, above the mobile media query", block.length > 1500, "");
  check("no !important, no raw radius, no hex accent", bare.indexOf('!important') === -1 && !/border-radius:\s*\d/.test(bare) && !ACCENT.test(bare), "");
  check("⚠️ the item rules are GLOBAL, because the bell panel is outside #view-home",
    /^\s*\.nt-item \{/m.test(bare) && /^\s*\.home-empty \{/m.test(bare), "");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
