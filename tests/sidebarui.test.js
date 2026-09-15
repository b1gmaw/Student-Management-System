// The sidebar retouch (2026-09-14): one layout defect, a calmer footer, and the icons untouched.
//
// ⚠️ WHY. Expanded, 5 of the 7 tabs stacked their label UNDER the icon (学生一覧, 寮管理, 入試関連,
// 申請関連, ユーザー管理) while ホーム and アカウント設定 sat correctly. The permission loop showed a granted
// .nav-btn with el.style.display = 'block', and that inline value beat `.app-sidebar .nav-btn
// { display: flex }`. Only the two tabs without permission-req escaped it.
// The footer had a SOLID red ログアウト, a 👤 pill, a bell count positioned against the whole 220px
// button (so it floated far from the bell), and bare icons with no label when expanded.
//
// ⚠️ Each guard is also run against its OLD shape, which must fail.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
// Ends at the bell's modal (#notifPanel), which follows the sidebar in the markup and has its own layout.
const bar = function (h) { const a = h.indexOf('<div id="appSidebar"'); return h.slice(a, h.indexOf('<div id="notifPanel"', a)); };
const style = function (h) { return h.slice(h.indexOf('<style>'), h.indexOf('</style>')); };
const mobile = function (h) { const st = style(h); return st.slice(st.indexOf('@media (max-width: 820px)')); };

console.log("\n1. every tab lays out as a row when expanded");
{
  guard("the permission loop shows a nav button as 'flex'",
    function (h) { return /el\.classList\.contains\('nav-btn'\)\)\s*\{[\s\S]{0,500}?el\.style\.display = 'flex';/.test(js(h)); },
    "el.style.display = 'flex';   // a row: icon + label", "el.style.display = 'block';",
    "'block' inline beats the sidebar's flex rule and stacks the label under the icon");
  check("logout and the bell wrapper are not inline-block either",
    /logoutBtn\.style\.display = "flex"/.test(js(HTML)) && /notifWrap\.style\.display = "block"/.test(js(HTML)) &&
    !/logoutBtn\.style\.display = "inline-block"/.test(js(HTML)), "");
}

console.log("\n2. the footer: one palette, labels, the count on the bell");
{
  guard("no inline style in the sidebar beyond the display toggles the JS owns",
    function (h) { const st = bar(h).match(/style="[^"]*"/g) || []; return st.length > 3 && st.every(function (x) { return /^style="display:\s*none;?"$/.test(x); }); },
    '<button id="btn-logout" class="nav-btn" style="display:none;"',
    '<button id="btn-logout" class="nav-btn" style="display:none; background-color:#e74a3b; color:white;"',
    "a solid red logout was the loudest element in the app");
  guard("ログアウト is red TEXT on a transparent row, from tokens",
    function (h) { return /\.app-sidebar #btn-logout \{ background: transparent; color: var\(--alert-danger-text\); \}/.test(style(h)); },
    '.app-sidebar #btn-logout { background: transparent; color: var(--alert-danger-text); }',
    '.app-sidebar #btn-logout { background: #e74a3b; color: #fff; }');
  guard("⚠️ the count sits INSIDE the bell's icon, which anchors it",
    function (h) { return /id="btnNotif"[^>]*><span class="sb-ico"><svg[\s\S]*?<\/svg><span id="notifCount"/.test(bar(h)) && /\.app-sidebar \.sb-ico \{ position: relative; \}/.test(style(h)); },
    '.app-sidebar .sb-ico { position: relative; }', '.app-sidebar .sb-ico { }');
  ['btnNotif', 'btn-logout', 'btn-dark-mode'].forEach(function (id) {
    check("#" + id + " carries a label for the expanded panel",
      new RegExp('id="' + id + '"[^>]*>[\\s\\S]*?</svg>(?:<span id="notifCount"[^>]*>0</span>)?</span><span class="sb-label">').test(bar(HTML)), "");
  });
  guard("⚠️ ...and the phone hides footer labels, or 通知 prints under the top-right bell",
    function (h) { return /\.app-sidebar \.sb-footer \.sb-label \{ display: none !important; \}/.test(mobile(h)); },
    '        .app-sidebar .sb-footer .sb-label { display: none !important; }\n', '',
    "the mobile block shows EVERY .app-sidebar .sb-label with !important");
}

console.log("\n3. the profile row");
{
  guard("no 👤, and the name goes through escHtmlJs",
    function (h) { const s = js(h); return s.indexOf('👤') === -1 && /badge\.innerHTML = [\s\S]{0,300}?escHtmlJs\(currentUser\.name\)/.test(s); },
    "<span class=\"sb-me-name\">' + escHtmlJs(currentUser.name) + '</span>'",
    "<span class=\"sb-me-name\">👤 ' + currentUser.name + '</span>'", "the name is sheet data");
  check("it is keyboard-reachable and opens アカウント設定",
    /id="userBadge" class="sb-me" role="button" tabindex="0"[^>]*onclick="switchMainTab\('account'\)"[^>]*onkeydown="[^"]*switchMainTab\('account'\)/.test(bar(HTML)), "");
  check("expanded it lays out as a row (the one desktop !important changed VALUE, not count)",
    /body\.sidebar-open \.app-sidebar #userBadge \{ display: flex !important; \}/.test(style(HTML)), "");
}

console.log("\n4. ⚠️ the icons are unchanged");
{
  // Computed from the ten sidebar SVGs, in order, BEFORE the retouch. Asked: "don't change the icons".
  const ICONS = '57f9ca704838470284ffbf9f3d8cb5f48ae6bfbc02f371a70adc20a49072219c';
  const svgs = bar(HTML).match(/<svg[\s\S]*?<\/svg>/g) || [];
  const hash = crypto.createHash('sha256').update(svgs.join('\n')).digest('hex');
  check("ten SVGs, byte-identical to before", svgs.length === 10 && hash === ICONS, svgs.length + ' ' + hash);
  // Mutated INSIDE the sidebar: the first stroke-width in the file belongs to an SVG elsewhere.
  const at = HTML.indexOf('<div id="appSidebar"');
  const m = HTML.slice(0, at) + HTML.slice(at).replace('stroke-width="2"', 'stroke-width="2.5"');
  const ms = bar(m).match(/<svg[\s\S]*?<\/svg>/g) || [];
  check("  mutation: one changed stroke width is caught", crypto.createHash('sha256').update(ms.join('\n')).digest('hex') !== ICONS, "");
}

console.log("\n5. the expanded panel's extras never reach a phone or move the page");
{
  const rules = (style(HTML).slice(0, style(HTML).indexOf('@media (max-width: 820px)')).match(/body\.sidebar-open[^{]*\{[^}]*\}/g) || []);
  check("no open-state rule shifts the page", !rules.some(function (r) { return /padding-left|margin-left/.test(r); }), "");
  check("the sub-nav guide line and active tick are expanded-only",
    /body\.sidebar-open \.app-sidebar \.sb-sub::before/.test(style(HTML)) && /body\.sidebar-open \.app-sidebar \.sub-nav-btn\.active::before/.test(style(HTML)), "");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
