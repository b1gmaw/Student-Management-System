// The mobile layout, and the guarantee that it cannot touch the desktop one.
//
// The app had no viewport meta tag and one @media rule in 35KB of CSS, so a phone
// rendered the desktop layout at ~980px and zoomed out. The brief was "mobile
// friendly, but it must not interfere with the main web version" — so the isolation
// is the thing worth testing, not the appearance.
//
// ⚠️ Two mechanical invariants, and they are what this suite exists for:
//   1. every mobile rule lives inside a @media block, which cannot apply at desktop
//      widths — checked by stripping the media blocks and looking for survivors;
//   2. the desktop rules the mobile block overrides are byte-identical to before.
//
// ⚠️ And the meta tags. A <meta> written into Index.html is IGNORED: HtmlService
// serves that file inside a sandboxed iframe on a Google origin, and only
// addMetaTag() reaches the top-level wrapper the browser takes its viewport from.
// Getting this wrong looks like "the CSS did nothing".

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(root, 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// The application stylesheet. ⚠️ NOT the whole file: a PDF template string further
// down contains its own `@media screen{...!important...}` block, and counting that
// as stylesheet CSS makes the leak checks below meaningless.
const STYLE = (function () {
  const m = HTML.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
})();

// ⚠️ CSS comments go first. The mobile block's own comment explains why it uses
// !important — and the comment sits ABOVE the @media line, so counting it as
// desktop CSS reported a leak that was purely prose. Same trap the JS suites hit.
function stripCssComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

// Everything outside a media query — i.e. what a desktop browser applies.
function stripMediaBlocks(css) {
  let out = '', depth = 0, i = 0;
  while (i < css.length) {
    if (css.startsWith('@media', i)) {
      const open = css.indexOf('{', i);
      if (open === -1) break;
      depth = 1; i = open + 1;
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth--;
        i++;
      }
      continue;
    }
    out += css[i]; i++;
  }
  return out;
}
const DESKTOP_CSS = stripMediaBlocks(stripCssComments(STYLE));

console.log("\n1. the meta tags, which have to come from doGet");
{
  const g = CODE.slice(CODE.indexOf('function doGet'), CODE.indexOf('function doGet') + 2200);
  check("viewport is added via addMetaTag",
    /addMetaTag\('viewport', 'width=device-width, initial-scale=1'\)/.test(g),
    "a <meta> in Index.html is ignored — it never reaches the top-level page");
  // These are what make 「ホーム画面に追加」 open without browser chrome. Not a PWA
  // install, which an Apps Script web app cannot do at all.
  check("the two web-app-capable tags are added",
    /addMetaTag\('apple-mobile-web-app-capable', 'yes'\)/.test(g) &&
    /addMetaTag\('mobile-web-app-capable', 'yes'\)/.test(g), "");
  // ⚠️ Same rule the favicon already follows: a throwing doGet takes the whole app
  // down for every user, and chrome is never worth that.
  check("they cannot take the app down",
    /try \{[\s\S]{0,400}addMetaTag\('viewport'[\s\S]{0,400}\} catch/.test(g),
    "an unguarded addMetaTag would be a total outage if the API ever rejected one");
  check("Index.html does NOT try to set them itself",
    !/<meta[^>]*viewport/.test(HTML),
    "it would be silently ignored and read as 'the mobile CSS is broken'");
}

console.log("\n2. ⚠️ the desktop layout is untouched");
{
  // Each of these is a rule the mobile block overrides. If the override had been
  // written into the rule itself instead of the media block, one of these fails.
  const INVARIANTS = [
    ['.container keeps its 1850px max-width', /\.container\s*\{[^}]*max-width:\s*1850px/],
    ['the sidebar rail is still 56px', /\.app-sidebar\s*\{[^}]*width:\s*56px/],
    ['the expanded rail is still 220px', /body\.sidebar-open \.app-sidebar\s*\{[^}]*width:\s*220px/],
    ['the body still clears the rail', /body\.has-sidebar\s*\{[^}]*padding-left:\s*76px/],
    ['.modal-box keeps its 500px max-width', /\.modal-box\s*\{[^}]*max-width:\s*500px/],
    ['.table-responsive keeps its 600px cap', /\.table-responsive\s*\{[^}]*max-height:\s*600px/],
    // ⚠️ 25px -> 32px on 2026-09-07, in the visual refresh. Deliberate, and it does
    // NOT weaken this check: the point is that the MOBILE work never edits a desktop
    // rule, and the media block overrides .container wholesale anyway
    // (padding: 12px; border-radius: 0; box-shadow: none), so the desktop value never
    // reaches a phone. Re-pin the number when a desktop change is intended; never
    // loosen the regex to stop caring what it is.
    ['.container keeps its 32px padding', /\.container\s*\{[^}]*padding:\s*32px/],
  ];
  INVARIANTS.forEach(function (inv) {
    check(inv[0], inv[1].test(DESKTOP_CSS), "a desktop rule was edited rather than overridden");
  });
}

console.log("\n3. ⚠️ nothing mobile escaped the media block");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  check("the mobile block exists", at !== -1, "");
  const mobile = STYLE.slice(at);

  // Selectors that only make sense on a phone. None may appear in desktop CSS.
  const MOBILE_ONLY = ['env(safe-area-inset-bottom)', 'flex-direction: row !important',
                       'div:has(> table)', '#recDateGrid'];
  MOBILE_ONLY.forEach(function (sel) {
    check("'" + sel + "' appears only inside a media block",
      DESKTOP_CSS.indexOf(sel) === -1, "it would apply at every width");
  });

  // ⚠️ The leak that matters most. Inline style="display:flex" beats a stylesheet
  // rule, so stacking those rows needs !important — and an !important that escaped
  // the media block would silently reshape the desktop layout.
  // ⚠️ EXACTLY 10 predate this work (the sidebar badge's show/hide, the report
  // border overrides, the visa colour classes). The rule is the one
  // endpoints.test.js uses for its unguarded count: this number may only go DOWN.
  //
  // ⚠️ The first version of this line said 11, counted from git HEAD without
  // stripping CSS comments — one of those mentions was inside a comment. A baseline
  // one too high silently absorbs the first real leak, which is the only leak the
  // check exists to catch. Measure the baseline the same way the check measures.
  const DESKTOP_BANGS_BASELINE = 10;
  const bangs = (DESKTOP_CSS.match(/!important/g) || []).length;
  check("no NEW !important in the desktop stylesheet", bangs <= DESKTOP_BANGS_BASELINE,
    "found " + bangs + ", baseline " + DESKTOP_BANGS_BASELINE +
    " — a mobile override has leaked up into every width");
  check("...and the mobile block does use it", /!important/.test(mobile),
    "the inline display:flex rows cannot be stacked without it");
}

console.log("\n4. the mobile block covers what it claims");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = STYLE.slice(at);
  const AREAS = [
    ['navigation is a floating bottom bar', /\.app-sidebar[\s\S]*?bottom:\s*calc\(8px/],
    ['the body stops reserving the rail', /body\.has-sidebar\s*\{\s*padding-left:\s*0/],
    ['tables scroll inside their own parent', /div:has\(> table\)[\s\S]*?overflow-x:\s*auto/],
    ['modals go full width and scroll', /\.modal-box\s*\{[\s\S]*?max-height:\s*92vh/],
    ['modal actions stack', /\.modal-actions\s*\{[\s\S]*?flex-direction:\s*column/],
    ['form fields are 16px, so iOS does not zoom', /\.form-control\s*\{[\s\S]*?font-size:\s*16px/],
    ['the 募集状況 date grid is un-pulled and re-tracked',
     /#recDateGrid\s*\{[\s\S]*?margin-top:\s*0[\s\S]*?grid-template-columns/],
  ];
  AREAS.forEach(function (a) {
    check(a[0], a[1].test(mobile), "not covered by the mobile block");
  });
}

console.log("\n5. every selector in the block matches something real");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  // ⚠️ COMMENTS STRIPPED FIRST. Text inside /* */ is not a selector, and the block's
  // comments legitimately discuss selectors in prose — "an #id selector outranks it"
  // was read as a requirement for id="id" to exist in the markup. Same trap §3
  // documents for the !important count, one section further down.
  const mobile = stripCssComments(STYLE.slice(at));
  // ⚠️ A selector that matches nothing is dead weight that reads as coverage. Three
  // of the first draft's selectors (.dorm-sub-nav, #recDateRow, .rec-date-row) were
  // invented names that existed nowhere in the markup.
  // ⚠️ Hex colours look exactly like id selectors to a regex — `color: #fff` was
  // read as "#fff must exist in the markup". Drop anything that is purely hex of a
  // colour's length before treating it as an id.
  const ids = new Set((mobile.match(/#[\w-]+/g) || [])
    .map(function (x) { return x.slice(1); })
    .filter(function (t) { return !/^[0-9a-fA-F]{3,8}$/.test(t); }));
  const classes = new Set((mobile.match(/\.[a-zA-Z][\w-]+/g) || []).map(function (x) { return x.slice(1); }));
  const missingIds = [...ids].filter(function (id) {
    return HTML.indexOf('id="' + id + '"') === -1
        && HTML.indexOf("id='" + id + "'") === -1;
  });
  check("every id targeted exists in the markup", missingIds.length === 0,
    "no such id: " + missingIds.join(", "));
  const missingClasses = [...classes].filter(function (c) {
    return HTML.indexOf('class="' + c) === -1 && HTML.indexOf(' ' + c + '"') === -1 &&
           HTML.indexOf(c + ' ') === -1;
  });
  check("every class targeted exists in the markup", missingClasses.length === 0,
    "no such class: " + missingClasses.join(", "));
}

console.log("\n6. ⚠️ the sub-navigation stays reachable");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));

  // ⚠️ THE REGRESSION THIS SECTION EXISTS FOR. The first mobile pass flattened the
  // whole sidebar into one bar and hid .sb-sub outright. The sub-navigation lives
  // INSIDE the sidebar, so that made 在籍学生 / 進路 / 部屋一覧 / 別紙一覧 / 面接結果 /
  // プレースメントテスト unreachable on every tab at once.
  check("the ACTIVE sub-nav is shown, not hidden",
    /\.sb-sub\.open[\s\S]{0,200}display:\s*flex\s*!important/.test(mobile),
    "hiding .sb-sub strands every sub-tab in the app");
  check("...and it is lifted out of the bar as a strip",
    /\.sb-sub\.open[\s\S]{0,300}position:\s*fixed/.test(mobile),
    "left inside a horizontal bar it has nowhere to render");
  // ⚠️ No blanket suppression, however it is spelled.
  check("no rule hides .sb-sub with !important",
    !/\.sb-sub[^{]*\{[^}]*display:\s*none\s*!important/.test(mobile),
    "that is exactly the rule that shipped and broke navigation");

  // Every tab that HAS a sub-nav must still reach it. Reading the ids from the
  // markup rather than listing them here, so a new tab is covered automatically.
  const subIds = [...new Set((HTML.match(/id="(sb-sub-[\w-]+)"/g) || [])
    .map(function (x) { return x.slice(4, -1); }))];
  check("the markup still declares sub-navs", subIds.length >= 5, "found " + subIds.length);
  const suppressed = subIds.filter(function (id) {
    return new RegExp('#' + id + '[^{]*\\{[^}]*display:\\s*none').test(mobile);
  });
  check("none is individually suppressed", suppressed.length === 0, suppressed.join(", "));

  // ⚠️ backdrop-filter on .app-sidebar creates a containing block for fixed
  // descendants — the strip would position against the sidebar, not the viewport.
  check("backdrop-filter is unset so the strip escapes the sidebar",
    /backdrop-filter:\s*none\s*!important/.test(mobile),
    "position:fixed inside a backdrop-filtered ancestor is not viewport-fixed");
}

console.log("\n7. nothing becomes unreachable");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));

  // ⚠️ PAIRED, like dark mode. #btn-logout may be hidden on mobile ONLY because
  // #acctLogout exists in アカウント設定. For three rounds it had to be repositioned
  // rather than hidden, because the sidebar was the only way to sign out.
  check("logout is hidden ONLY because アカウント設定 has its own",
    /#btn-logout[^{]*\{[^}]*display:\s*none/.test(mobile) &&
    HTML.indexOf('id="acctLogout"') !== -1,
    "either stop hiding the sidebar button, or restore the one in アカウント設定");
  // ⚠️ And that copy must be mobile-only, or desktop gains a second logout.
  check("...and that copy is display:none in the markup",
    /id="acctLogout"[^>]*style="display:none/.test(HTML),
    "revealed only inside the media block");
  check("...revealed only inside the media block",
    /#acctLogout\s*\{[^}]*display:\s*block\s*!important/.test(mobile), "");
  check("the footer is repositioned rather than hidden",
    /\.sb-footer\s*\{[\s\S]{0,200}position:\s*fixed/.test(mobile) &&
    !/\.sb-footer\s*\{[^}]*display:\s*none/.test(mobile),
    "the bell lives there too, and teachers need it");

  // ⚠️ PAIRED ON PURPOSE. #btn-dark-mode may be hidden only because the same control
  // exists in アカウント設定 → 表示. Delete that one and this test fails, rather
  // than the feature quietly disappearing on phones.
  // Re-pinned 2026-09-14: the #acctDarkMode checkbox became the three-way #acctTheme control,
  // and it must still offer ダーク.
  check("dark mode is hidden ONLY because アカウント設定 has its own control",
    /#btn-dark-mode[^{]*\{[^}]*display:\s*none/.test(mobile) &&
    /id="acctTheme"[\s\S]{0,600}setThemePref\('dark'\)/.test(HTML),
    "either stop hiding the sidebar toggle, or restore the one in アカウント設定");
}

console.log("\n8. the page itself does not slide sideways");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  // The four columns wider than a phone. Matched by value, so the 150–240px ones —
  // which fit — are left alone.
  ['300px', '320px', '420px'].forEach(function (w) {
    check("inline min-width " + w + " is neutralised",
      new RegExp('min-width:' + w).test(mobile), "");
  });
  check("...and only by making them shrinkable",
    /min-width:\s*0\s*!important/.test(mobile), "");
  // ⚠️ A blanket overflow clip on body would stop the sliding by hiding whatever
  // overflowed. A sideways page is a visible bug; clipped data is an invisible one.
  check("body is NOT given a blanket overflow clip",
    !/body[^{]*\{[^}]*overflow-x:\s*(clip|hidden)/.test(mobile),
    "that hides overflowing content instead of making it reachable");

  // ⚠️ Found by .claude/skills/run-local/driver.mjs `overflow`: the page slid
  // 4px sideways. `body { padding: 20px }` is the base rule and only padding-LEFT was
  // zeroed, so 20px stayed on the right — narrowing the body's content box while
  // .container still asked for 100% of it, plus 24px of its own padding on top,
  // because this stylesheet has no global border-box.
  check("the body zeroes padding on BOTH sides",
    /body\.has-sidebar\s*\{[^}]*padding-left:\s*0[^}]*padding-right:\s*0/.test(mobile),
    "leaving padding-right narrows the content box and .container overflows it");
  check("the container is border-box so its padding fits inside 100%",
    /\.container\s*\{[^}]*box-sizing:\s*border-box/.test(mobile),
    "there is no global border-box rule — width:100% plus padding overflows");

  check("the body reserves room for both fixed pieces",
    /body\.has-sidebar\s*\{[^}]*padding-bottom:/.test(mobile), "");
}

console.log("\n9. the floating bar, and nothing covering anything");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));

  // ⚠️ ALL THREE containing-block creators, named individually. .app-sidebar sets
  // backdrop-filter, -webkit-backdrop-filter and will-change; unsetting only the
  // unprefixed one left the top row resolving against the SIDEBAR on iOS, which put
  // the whole thing inside the bottom bar. Two of three passing is the bug.
  [['backdrop-filter', /[^-]backdrop-filter:\s*none\s*!important/],
   ['-webkit-backdrop-filter', /-webkit-backdrop-filter:\s*none\s*!important/],
   ['will-change', /will-change:\s*auto\s*!important/]
  ].forEach(function (c) {
    check(c[0] + " is unset so fixed children reach the viewport", c[1].test(mobile),
      "position:fixed inside it resolves against the sidebar instead");
  });

  // ⚠️ The badge rule must repeat body.sidebar-open. The desktop rule is (1,2,1) and
  // beat the plain selector, so tapping a tab — which calls _setSidebarOpen(true) —
  // popped the username into the bar.
  check("the username is suppressed under body.sidebar-open too",
    /body\.sidebar-open \.app-sidebar #userBadge[^{]*\{[^}]*display:\s*none\s*!important/.test(mobile),
    "the plain selector loses on specificity and the badge returns on every tab tap");

  // ⚠️ #btn-logout and #btn-dark-mode are NOT inside .sb-footer — a stray </div>
  // closes it right after the bell — so they must be targeted directly. A
  // .sb-footer-scoped selector cannot match them and they reappear in the bar.
  // ⚠️ Still targeted directly under .app-sidebar, not via .sb-footer — the stray
  // </div> means a footer-scoped selector cannot match it, hidden or not.
  check("logout is targeted directly under .app-sidebar",
    /\.app-sidebar #btn-logout/.test(mobile),
    "a .sb-footer-scoped selector cannot match it — see the stray </div>");
  check("the dark-mode button is targeted the same way",
    /\.app-sidebar #btn-dark-mode/.test(mobile), "");

  // The float itself.
  check("the bar is inset from all three edges",
    /\.app-sidebar[\s\S]{0,400}left:\s*8px;\s*right:\s*8px/.test(mobile) &&
    /bottom:\s*calc\(8px \+ env\(safe-area-inset-bottom\)\)/.test(mobile), "");
  check("...with rounded corners and a shadow",
    /border-radius:\s*18px/.test(mobile) && /box-shadow:\s*0 6px 24px/.test(mobile), "");
  check("...and a width that follows the insets",
    /width:\s*auto\s*!important/.test(mobile), "left/right insets do nothing at width:100%");

  // The top row must not sit over the content, and the sub-tabs must not run under
  // the bell/logout pill.
  check("the body reserves space at the TOP as well",
    /padding-top:\s*48px/.test(mobile),
    "reserving only the bottom is what made the strip cover the content");
  // ⚠️ Compared, not hardcoded. The bell moved from right:52px to right:6px this
  // round and the strip's clearance had to follow; a literal would have gone stale
  // silently and let the sub-tabs slide under the bell again.
  const stripRight = (mobile.match(/\.sb-sub\.open[\s\S]{0,300}?right:\s*(\d+)px/) || [])[1];
  const bellRight  = (mobile.match(/\.sb-footer\s*\{[\s\S]{0,200}?right:\s*(\d+)px/) || [])[1];
  check("both the strip and the bell declare a right offset",
    stripRight !== undefined && bellRight !== undefined,
    "strip=" + stripRight + " bell=" + bellRight);
  check("the strip stops short of the bell",
    Number(stripRight) > Number(bellRight),
    "strip right " + stripRight + "px must exceed the bell's " + bellRight + "px, " +
    "or the sub-tabs scroll underneath it");
}

console.log("\n10. ⚠️ the drawer class never reaches a phone");
{
  // Tapping a tab calls _setSidebarOpen(true). On desktop that expands the rail; on
  // a phone the rail IS the bottom bar, so the class means nothing — but seven
  // desktop rules key off it and every one leaked into the bar. Three separate bugs
  // came from that (username badge, left-aligned labels, padding), each fixed by
  // overriding one more rule. Guarding the toggle ends the class of bug.
  const js = (HTML.match(/<script>[\s\S]*?<\/script>/g) || [])[1] || '';
  const code = js.replace(/\/\/[^\n]*/g, '');

  check("the guard exists and keys on the same breakpoint",
    /function _sidebarDrawerAllowed\(\)/.test(code) &&
    /matchMedia\('\(max-width: 820px\)'\)/.test(code),
    "a different breakpoint here than in the CSS is its own bug");
  check("...and fails open, behaving as desktop without matchMedia",
    /catch \(e\) \{ return true; \}/.test(code),
    "an old browser must keep the drawer, not lose it");

  // ⚠️ BOTH toggles. _sidebarAfter flips the class itself, so guarding only
  // _setSidebarOpen leaves the hover path free to reapply it.
  [['_setSidebarOpen', /function _setSidebarOpen\(on\) \{[\s\S]{0,200}?_sidebarDrawerAllowed\(\)/],
   ['_sidebarAfter',   /function _sidebarAfter\(ms, on\) \{[\s\S]{0,200}?_sidebarDrawerAllowed\(\)/]
  ].forEach(function (c) {
    check(c[0] + " consults the guard", c[1].test(code),
      "guarding one and not the other reproduces the bug through the other path");
  });

  // ⚠️ The CSS overrides stay as belt-and-braces: if the guard is ever reverted,
  // these are what stop the bugs coming straight back.
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  check("the body.sidebar-open overrides are still present",
    (mobile.match(/body\.sidebar-open/g) || []).length >= 4,
    "they are the fallback for a reverted guard");
}

console.log("\n11. the active tab reads as a tab, not a web row");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  // ⚠️ The desktop look is a filled background PLUS `inset 3px 0 0` down the left
  // edge. Rotated flat, that edge is one tab's top-left corner. Both have to go —
  // overriding only the shadow leaves the block behind.
  check("the filled background is dropped",
    /\.nav-btn\.active[\s\S]{0,300}?background:\s*none\s*!important/.test(mobile),
    "the web look is a filled row, which is what read wrong lying on its side");
  check("...and the edge bar with it",
    /\.nav-btn\.active[\s\S]{0,300}?box-shadow:\s*none\s*!important/.test(mobile), "");
  check("the active tab tints instead",
    /\.nav-btn\.active[\s\S]{0,300}?color:\s*var\(--primary-color\)\s*!important/.test(mobile), "");
  check("...icon and label included",
    /\.nav-btn\.active \.sb-ico[\s\S]{0,120}?var\(--primary-color\)/.test(mobile),
    "tinting the button alone leaves the spans their own colour");
  // The centring belt.
  check("labels are centred, not left-aligned",
    /text-align:\s*center\s*!important/.test(mobile) &&
    /align-items:\s*center\s*!important/.test(mobile),
    "body.sidebar-open sets text-align:left — that is what misaligned them");
}

console.log("\n12. 学生一覧 component pass — mobile only");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));

  // ⚠️ Icons are ADDITIVE. Every label stays, because desttable / genderpivot /
  // enrolhistory / recruitvisa locate these buttons by their label text — and
  // because a bare glyph has no tooltip on a touch screen.
  [['集計表', 'desttable'], ['性別集計', 'genderpivot'], ['増減推移', 'enrolhistory'],
   ['＋ 行を追加', 'recruitvisa']].forEach(function (c) {
    check("'" + c[0] + "' is still a label in the markup (" + c[1] + " keys on it)",
      HTML.indexOf('>' + c[0]) !== -1 || HTML.indexOf(c[0]) !== -1, "");
  });

  // ⚠️ PAIRED. Icons carry inline display:none and are revealed ONLY in the media
  // block, which is what keeps desktop byte-identical. Break either half and the
  // icons either never show on mobile or start showing on desktop.
  const icoCount = (HTML.match(/class="btn-ico"/g) || []).length;
  const hidden = (HTML.match(/class="btn-ico" style="display:none"/g) || []).length;
  check("every btn-ico is hidden inline", icoCount > 0 && icoCount === hidden,
    icoCount + " icons, " + hidden + " hidden");
  check("...and revealed only inside the media block",
    /\.btn-ico\s*\{[^}]*display:\s*inline-block\s*!important/.test(mobile) &&
    !/\.btn-ico/.test(stripCssComments(DESKTOP_CSS)),
    "a desktop rule for .btn-ico would put icons on the web version");
  check("the search icon follows the same pattern",
    /class="search-ico" style="display:none"/.test(HTML) &&
    /\.search-wrap \.search-ico[^}]*display:\s*block\s*!important/.test(mobile), "");

  // ⚠️ INVERTED from the previous round, deliberately. While labels were visible a
  // plus icon beside a ＋ label rendered "＋＋ 入学期". Now the labels are CLIPPED, so
  // those buttons must carry an icon or they render as blank rectangles.
  ['recAddVisaRow', 'recAddNotIssuedRow', 'recAddIntake', 'simAddCountry',
   'simAddIntakeFromDropdown', 'recAddRecruiter'].forEach(function (fn) {
    check(fn + " has an icon (its label is clipped)",
      new RegExp('onclick="' + fn + '\\(\\)">\\s*<svg[^>]*class="btn-ico"').test(HTML),
      "with the label hidden and no icon this button is an empty rectangle");
  });

  // The states the audit found missing: 2 :focus rules in 35KB, no :active at all.
  check("buttons get a visible focus ring", /:focus-visible[^{]*\{[^}]*outline:/.test(mobile),
    "keyboard and switch-control users had almost no visible focus");
  check("buttons get press feedback", /:active[^{]*\{[^}]*transform:\s*translateY/.test(mobile),
    "brightness alone is invisible under a finger");
  check("fields get a focus state", /\.form-control:focus[^{]*\{[^}]*border-color/.test(mobile), "");

  // ⚠️ THE TRAP THAT BIT THREE TIMES. No global border-box in this stylesheet, so
  // every box that gains padding in the media block must declare it. .container,
  // .modal-box and .modal-overlay each overflowed before this was stated.
  // ⚠️ FOUR bugs came from this stylesheet having no global border-box: .container,
  // .modal-box, .modal-overlay, and the filter-bar selects (which spilled over
  // フィルタ解除 and read as "the fields overlap"). Assert each name individually so
  // dropping one from the list is a failure, not a silently shorter selector.
  ['.modal-overlay', '.modal-box', '.container', '.student-filter-bar select',
   '.filter-multi .fm-btn', '.form-control'].forEach(function (sel) {
    // ⚠️ ALL rules that declare border-box, not the first one — .modal-box declares
    // it inside its own block, so a first-match regex found that and reported every
    // other selector missing.
    const rules = mobile.match(/([^{}]+)\{[^}]*box-sizing:\s*border-box[^}]*\}/g) || [];
    const covered = rules.some(function (r) { return r.split('{')[0].indexOf(sel) !== -1; });
    check("'" + sel + "' declares border-box", covered,
      "width:100% plus padding overflows without it");
  });

  check("modal actions stay reachable on a short screen",
    /\.modal-actions\s*\{[^}]*position:\s*sticky/.test(mobile),
    "保存 / 閉じる sat below the fold in the long report modals");
}

console.log("\n13. icon-only buttons keep their names");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));

  // ⚠️ CLIPPED, NOT display:none. display:none drops the label out of the
  // accessibility tree, leaving every toolbar button anonymous to a screen reader —
  // and a glyph has no tooltip on touch. Clipping frees the space, keeps the name.
  check("labels are hidden by clipping",
    /\.btn-label\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(mobile), "");
  check("...and NOT by display:none",
    !/\.btn-label\s*\{[^}]*display:\s*none/.test(mobile),
    "that would make every icon-only button anonymous to a screen reader");
  check("the label rule is mobile-only",
    !/\.btn-label/.test(stripCssComments(DESKTOP_CSS)),
    "desktop keeps its labels visible");

  // Every wrapped label must sit next to an icon, or the button renders empty.
  const wrapped = (HTML.match(/<button[^>]*>[\s\S]{0,4000}?<\/button>/g) || [])
    .filter(function (b) { return b.indexOf('btn-label') !== -1; });
  const empty = wrapped.filter(function (b) { return b.indexOf('class="btn-ico"') === -1; });
  check("every clipped-label button has an icon", wrapped.length > 0 && empty.length === 0,
    empty.length + " would render blank");

  // ⚠️ Two identical glyphs is the failure icon-only invites — 国名設定 and 地域設定
  // were both cogs until the labels came off and they became indistinguishable.
  const icoOf = function (fn) {
    const m = HTML.match(new RegExp('onclick="' + fn + '\\(\\)">\\s*(<svg[\\s\\S]*?</svg>)'));
    return m ? m[1] : null;
  };
  check("国名設定 and 地域設定 do not share an icon",
    icoOf('recAddCountry') && icoOf('recManageRegions') &&
    icoOf('recAddCountry') !== icoOf('recManageRegions'),
    "with labels clipped, identical glyphs are two unlabelled buttons");
}

console.log("\n14. the filter bar and the search field");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  // ⚠️ A wrapping flex row let the last control on a row stretch into its
  // neighbour; ビザ警告 rendered under フィルタ解除. A two-column grid cannot collide.
  check("the filter bar is a grid, not a wrapping flex row",
    /\.student-filter-bar\s*\{[^}]*display:\s*grid\s*!important/.test(mobile), "");
  // ⚠️ Scoped to the .student-filter-bar RULE. #recDateGrid carries an identical
  // `repeat(2, minmax(0, 1fr))` from an earlier round, so an unscoped search passed
  // even with the filter bar's own tracks weakened to a bare 1fr.
  const barRule = (mobile.match(/\.student-filter-bar\s*\{[^}]*\}/) || [''])[0];
  check("...with minmax(0,1fr) tracks",
    /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(barRule),
    "a bare 1fr floors at min-content and a long select blows the track out");

  // ⚠️ The icon sat ~10px low because .search-box carries margin-bottom:20px, so the
  // wrapper was 64px tall around a 44px input and top:50% centred on the wrapper.
  check("the search wrapper matches the input's height",
    /\.search-wrap \.search-box\s*\{[^}]*margin-bottom:\s*0/.test(mobile) &&
    /\.search-wrap\s*\{[^}]*margin-bottom:\s*20px/.test(mobile),
    "otherwise the icon centres on the wrapper, not the text");
}

console.log("\n15. フィルタ解除 + 出力: one cluster, desktop untouched");
{
  const bodyRe = /function buildStudentFilters[\s\S]*?\n      function _intakeFromStudentId/;
  const fnBody = (HTML.match(bodyRe) || [''])[0];

  // ⚠️ display:contents is the whole mechanism: it generates no box, so on desktop
  // the two buttons stay direct flex items of .student-filter-bar and .exp-wrap's
  // margin-left:auto still pushes against that same parent — measured pixel-
  // identical before and after this change (843,129 / 1335,122, both unchanged).
  check("the wrapper is inline display:contents",
    /<span class="fb-actions" style="display:contents;">/.test(fnBody), "");
  check("...INSIDE the innerHTML template, not a stylesheet rule",
    !/\.fb-actions\s*\{[^}]*display:\s*contents/.test(stripCssComments(DESKTOP_CSS)),
    "a stylesheet rule here would be a second, redundant place to keep in step");

  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  check("only the media block turns it into a real flex box",
    /\.student-filter-bar \.fb-actions\s*\{[^}]*display:\s*flex\s*!important/.test(mobile), "");
  check("...and .fb-actions has no desktop rule",
    !/\.fb-actions/.test(stripCssComments(DESKTOP_CSS)), "");

  // ⚠️ Without resetting margin-left, .exp-wrap keeps the auto meant for its OLD
  // parent and shoves 出力 away from フィルタ解除 instead of sitting beside it.
  check("the export button's margin-left is reset inside the cluster",
    /\.fb-actions \.exp-wrap\s*\{[^}]*margin-left:\s*0\s*!important/.test(mobile), "");

  // Both buttons carry an icon AND a clipped label — same contract as round 2.
  check("フィルタ解除 has an icon and a clipped label",
    /class="clear-filters"[^>]*>\s*<svg class="btn-ico"[\s\S]{0,600}?<span class="btn-label">フィルタ解除/.test(fnBody), "");
  check("the template's 出力 has an icon and a clipped label",
    /onclick="expToggle\(event\)">\s*<svg class="btn-ico"[\s\S]{0,600}?<span class="btn-label">出力/.test(fnBody), "");

  // ⚠️ Icons are STATIC in this string — xss.test.js's rule is that nothing
  // variable-built reaches innerHTML, and bar.innerHTML = html assigns this whole
  // template. Confirms no ${...} sits inside an svg block.
  const svgBlocks = fnBody.match(/<svg class="btn-ico"[\s\S]*?<\/svg>/g) || [];
  check("the icons contain no template interpolation",
    svgBlocks.length >= 2 && svgBlocks.every(function (b) { return b.indexOf('${') === -1; }),
    "an interpolated value inside innerHTML is exactly what xss.test.js exists to catch");
}

console.log("\n16. the 詳細 modal's ✕: smaller, corner-pinned, scoped");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  check("the ✕ rule is scoped to #detailCard",
    /#detailCard \.modal-box > div:first-child > button\s*\{/.test(mobile), "");
  // ⚠️ The generic mobile pass gives every button a 44px min-height; without
  // overriding it here explicitly, "smaller" has no visible effect.
  check("min-height is explicitly undone for this button",
    /#detailCard \.modal-box > div:first-child > button\s*\{[^}]*min-height:\s*0/.test(mobile),
    "otherwise the 44px floor from the generic button rule wins and nothing shrinks");
  check("it is pinned absolute to the corner",
    /#detailCard \.modal-box > div:first-child > button\s*\{[^}]*position:\s*absolute/.test(mobile), "");
  check("the title gets room so it cannot run under the button",
    /#detailCard \.modal-box > div:first-child\s*\{[^}]*padding-right:/.test(mobile), "");

  // ⚠️ Scoped, not generic — every other modal's close control must be unaffected.
  check("no unscoped rule targets a modal's first-child button generically",
    !/(?<!#detailCard )\.modal-box > div:first-child > button/.test(mobile),
    "that would resize every other modal's ✕ too");
}

console.log("\n17. 寮管理 component pass — mobile only");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));

  // ⚠️ Same contract as §13, re-proved for this tab: clipping, never display:none.
  // These labels are also what dormsync.test.js and buildingcolumns.test.js grep
  // for, so the string has to survive in the markup as well as in the a11y tree.
  check("#view-dorms labels are clipped",
    /#view-dorms \.btn-label\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(mobile), "");
  check("...and NOT by display:none",
    !/#view-dorms \.btn-label\s*\{[^}]*display:\s*none/.test(mobile),
    "that would make every dorm toolbar button anonymous to a screen reader");

  // ⚠️ PAIRED, like #acctLogout. The address is hidden to buy the 建物名 a second
  // line; it may only ever be hidden on a phone.
  check("the card address is hidden on mobile",
    /#view-dorms \.bldg-addr\s*\{[^}]*display:\s*none/.test(mobile), "");
  check("...and .bldg-addr has NO desktop rule",
    !/\.bldg-addr/.test(stripCssComments(DESKTOP_CSS)),
    "a desktop rule would drop the address from the web version too");
  check("...and the address is still in the markup, not deleted",
    HTML.indexOf('class="bldg-addr"') !== -1 && /escHtmlJs\(displayAddr\)/.test(HTML),
    "hiding it in CSS is what keeps desktop byte-identical");

  // ⚠️ THE POINT OF THE PASS. One flex row left the 建物名 ~90px at 390px. Wrapping
  // the header gives it the full width; truncating it prettily is the same bug.
  check("the card header wraps to two rows",
    /#view-dorms \.bldg-accordion-header\s*\{[^}]*flex-wrap:\s*wrap/.test(mobile) &&
    /#view-dorms \.bldg-title\s*\{[^}]*flex:\s*1 1 100%/.test(mobile), "");
  check("the building name wraps rather than truncating",
    /#view-dorms \.bldg-title h3\s*\{[^}]*overflow-wrap:\s*anywhere/.test(mobile), "");
  check("...and is NOT given an ellipsis",
    !/#view-dorms \.bldg-title h3\s*\{[^}]*text-overflow:\s*ellipsis/.test(mobile),
    "a name that cannot be read in full is the bug this pass exists to fix");
  // The h3 carries an inline font-size:17px, which beats any plain rule.
  check("the h3 override is !important, or the inline 17px wins",
    /#view-dorms \.bldg-title h3\s*\{[^}]*font-size:\s*15px\s*!important/.test(mobile), "");

  // ⚠️ The three card buttons are built in a template literal carrying inline
  // `padding:5px 15px`, so a plain rule cannot shrink them however specific.
  check("the card buttons override their inline padding",
    /#view-dorms \.bldg-actions \.btn-save\s*\{[^}]*padding:\s*0\s*!important/.test(mobile),
    "they carry inline padding:5px 15px from initDormGrid's template");
  check("...and keep a 44px touch target",
    /#view-dorms \.bldg-actions \.btn-save\s*\{[^}]*min-height:\s*44px/.test(mobile),
    "two rows exist precisely so the buttons never have to shrink below it");

  // ⚠️ setupInterfaceBasedOnRole owns `display` on every permission-req button,
  // driving it from data-orig-display. A stylesheet rule fighting that hides the
  // button from the people who DO hold the permission.
  check("no #view-dorms rule sets display on a toolbar button",
    !/#view-dorms[^{]*\.(export-btn|btn-save)[^{]*\{[^}]*display:\s*/.test(mobile),
    "the permission loop owns that property");

  // ⚠️ dormsync.test.js asserts this attribute string byte-for-byte. The icon goes
  // BETWEEN > and </button>; no attribute may move.
  check("btnAutoFill's permission wiring is untouched",
    /id="btnAutoFill" class="export-btn permission-req" data-perm="edit_dorms" data-orig-display="inline-block"/.test(HTML),
    "rewriting any of it silently breaks the permission loop for every dorm editor");

  // ⚠️ Every 寮管理 button that lost its label needs a DISTINCT glyph — §13's rule,
  // and ＋部屋登録 / ＋部屋追加 plus 名前変更 / 編集 are the pairs that invite a
  // collision. Anchored on onclick so this reads the real markup, not a list.
  const DORM_BTNS = [
    'onclick="autoFillDorms()">',
    'onclick="openAddBldgModal()">',
    'onclick="openAddRoomModal()">',
    'onclick="dormExpandAll(true)">',
    'onclick="dormExpandAll(false)">',
    'onclick="openDocAddModal()">',
    'onclick="renameSelectedDoc()" disabled>',
    'onclick="deleteSelectedDoc()" disabled>',
    'onclick="event.stopPropagation(); openAddRoomModal(\'${bIdAttr}\')">',
    'onclick="event.stopPropagation(); bulkExportBuildingPdf(\'${bIdAttr}\', this)">',
    'onclick="event.stopPropagation(); openEditBldgModal(event, \'${bIdAttr}\')">',
  ];
  const glyphs = DORM_BTNS.map(function (a) {
    const i = HTML.indexOf(a);
    if (i === -1) return null;
    const tail = HTML.slice(i + a.length, i + a.length + 1400);
    const m = tail.match(/^<svg class="btn-ico" style="display:none"[^>]*>([\s\S]*?)<\/svg>/);
    return m ? m[1] : null;
  });
  check("every 寮管理 button carries an icon right after its onclick",
    glyphs.every(function (g) { return g !== null; }),
    DORM_BTNS.filter(function (_, i) { return glyphs[i] === null; }).join(", ") + " missing one");
  check("...and no two of them share a glyph",
    new Set(glyphs).size === glyphs.length,
    "with the labels clipped, identical glyphs are two unlabelled buttons");
  // ⚠️ §15's rule: these svgs sit inside a template literal assigned to innerHTML.
  check("the card icons contain no template interpolation",
    glyphs.slice(8).every(function (g) { return g && g.indexOf('${') === -1; }),
    "an interpolated value inside innerHTML is what xss.test.js exists to catch");
}

console.log("\n18. 入試関連 component pass — the calendar swaps, it does not shrink");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  const desktop = stripCssComments(DESKTOP_CSS);
  const js = ((HTML.match(/<script>[\s\S]*?<\/script>/g) || [])[1] || '')
    .replace(/\/\/[^\n]*/g, '');

  // ⚠️ THE PAIR, and the reason this section exists. The desktop grid's column axis
  // is day x teacher — 1 + 5*N columns, no min-width — so it cannot be overridden
  // into a phone; it is hidden and a different table takes its place. Hiding one
  // without revealing the other takes 面接スケジュール off the phone entirely, and
  // the sub-tab would still be there to tap. §7's rule, applied to a whole view.
  check("the desktop calendar is hidden on mobile",
    /#sub-view-schedule \.schedule-grid\s*\{[^}]*display:\s*none/.test(mobile), "");
  check("...and #calMobilePanel is revealed in the same breath",
    /#calMobilePanel\s*\{[^}]*display:\s*block\s*!important/.test(mobile),
    "hiding the grid without this leaves the tab blank on every phone");
  check("...and the mobile table really exists in the markup",
    HTML.indexOf('id="calMobileTable"') !== -1
      && HTML.indexOf('id="calTeacherSelect"') !== -1, "");

  // The #acctLogout pattern: inline display:none, revealed only in the media block,
  // no desktop rule at all. That is what makes "desktop is untouched" mechanical.
  check("#calMobilePanel ships hidden in the markup",
    /id="calMobilePanel" style="display:none/.test(HTML),
    "without the inline hide it renders under the desktop calendar on every PC");
  check("...and has NO desktop rule",
    !/#calMobilePanel/.test(desktop) && !/#calMobileTable/.test(desktop)
      && !/#calTeacherSelect/.test(desktop),
    "any desktop rule for these is a change to the web version");

  // ⚠️ Scoped to the sub-view, not #view-shared-schedule. That container also holds
  // 面接結果 and プレースメントテスト; scoping to it would drag two untouched tabs in.
  check("the pass is scoped to #sub-view-schedule, not the whole tab",
    !/#view-shared-schedule/.test(mobile),
    "面接結果 and プレースメントテスト are deliberately out of scope");

  // The mobile table cannot carry .schedule-grid — that class is what gets hidden —
  // so the borders and centring it would have inherited have to be restated. Without
  // this it falls through to the global `th, td { text-align: left }`.
  check("the mobile table restates its own borders and centring",
    /#calMobileTable\s*\{[^}]*table-layout:\s*fixed/.test(mobile)
      && /#calMobileTable th, #calMobileTable td\s*\{[^}]*text-align:\s*center/.test(mobile), "");

  // ⚠️ Undoes the generic `th, td { padding: 6px 8px !important }` earlier in the
  // block, which INFLATES a calendar cell — they ship at 6px 2px because a slot
  // column has no width to spare.
  check("the generic table padding is undone for the calendar",
    /#sub-view-schedule th, #sub-view-schedule td\s*\{[^}]*padding:\s*4px 2px\s*!important/.test(mobile), "");

  // §13's contract, re-proved for this tab.
  check("the toolbar labels are clipped",
    /#sub-view-schedule \.btn-label\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(mobile), "");
  check("...and NOT by display:none",
    !/#sub-view-schedule \.btn-label\s*\{[^}]*display:\s*none/.test(mobile),
    "that would make all four calendar buttons anonymous to a screen reader");

  // ⚠️ Anchored on onclick, so this reads the real markup rather than a list. Each
  // button must carry a DISTINCT glyph: with the labels clipped, two buttons sharing
  // one are two identical unlabelled squares. 前週/次週 are the obvious collision.
  const CAL_BTNS = [
    'onclick="toggleNotif()">',
    'onclick="calChangeWeek(-1)">',
    'onclick="calChangeWeek(1)">',
    'onclick="calJumpToCurrentWeek()">',
  ];
  const calGlyphs = CAL_BTNS.map(function (a) {
    const i = HTML.indexOf(a);
    if (i === -1) return null;
    const m = HTML.slice(i + a.length, i + a.length + 1400)
      .match(/^<svg class="btn-ico" style="display:none"[^>]*>([\s\S]*?)<\/svg>/);
    return m ? m[1] : null;
  });
  check("every calendar toolbar button carries an icon right after its onclick",
    calGlyphs.every(function (g) { return g !== null; }),
    CAL_BTNS.filter(function (_, i) { return calGlyphs[i] === null; }).join(", ") + " missing one");
  check("...and no two of them share a glyph",
    new Set(calGlyphs).size === calGlyphs.length,
    "identical glyphs are two unlabelled buttons once the text is clipped");

  // ⚠️ DESKTOP KEEPS ITS ARROWS. The chevrons are display:none there, so dropping
  // ◀/▶ from the labels stripped the direction cue off the web version — caught by
  // a pixel diff, not by a test, which is why it is one now.
  check("前週/次週 keep their arrows for desktop",
    HTML.indexOf('<span class="btn-label">◀ 前週</span>') !== -1
      && HTML.indexOf('<span class="btn-label">次週 ▶</span>') !== -1,
    "on desktop the icon is hidden, so the label is the only direction cue");

  // ⚠️ btn.innerText replaces every child, which deletes the icon and leaves a blank
  // square on a phone. Both writers have to go through the label span.
  check("the notification button writes its label span, not the button",
    /function _setBtnLabel\(btn, text\)/.test(js)
      && /_setBtnLabel\(btn, "メール通知: ON"\)/.test(js)
      && /_setBtnLabel\(btn, "メール通知: OFF"\)/.test(js)
      && /_setBtnLabel\(b, "切替中\.\.\."\)/.test(js), "");
  check("...and nothing assigns innerText to it any more",
    !/btn\.innerText\s*=\s*"メール通知/.test(js)
      && !/b\.innerText\s*=\s*"切替中/.test(js),
    "innerText here deletes the icon — the button renders blank on a phone");

  // ⚠️ ONE source of truth. The two calendars must never disagree about what a slot
  // is or what tapping it does; a copied cell mapper drifts on the first status
  // added, and that disagreement is a permissions bug wearing a layout bug's
  // clothes. The status chain must appear exactly once in the file.
  check("_calCellState is the only cell mapper",
    /function _calCellState\(tid, teacherName, dateStr, period\)/.test(js), "");
  check("...and both calendars go through it",
    /function calRenderGrid\(\)[\s\S]*?_calCellState\(/.test(js)
      && /function calRenderMobile\([\s\S]*?_calCellState\(/.test(js), "");
  check("...and the status chain was moved, not copied",
    (js.match(/cls = 'slot-cancel-req'; label = '交代'/g) || []).length === 1,
    "two copies is the drift this extraction exists to prevent");

  // ⚠️ An incoming 交代依頼 is stored on the REQUESTING teacher's row, targeting the
  // current user — so a one-teacher-at-a-time view hides every request addressed to
  // you behind a dropdown you had no reason to open. The dot is what keeps it
  // reachable, which is the §7 rule again.
  check("the dropdown marks teachers holding a request addressed to you",
    /reassignToId[\s\S]{0,120}String\(currentUser\.id\)[\s\S]{0,200}weekDates\.indexOf/.test(js)
      && /needsMe \? '● ' : ''/.test(js),
    "without it an incoming 交代依頼 is unreachable on a phone");

  // A removed teacher must not strand the view on an id the roster no longer holds.
  check("a stale selection is re-resolved, preferring the signed-in teacher",
    /calTeachers\.some\(t => String\(t\.id\) === String\(calMobileTeacherId\)\)/.test(js)
      && /mine \? mine\.id : calTeachers\[0\]\.id/.test(js), "");

  // ⚠️ NO VIEWPORT BRANCH IN THE RENDER PATH. CSS alone decides which table shows;
  // that is what makes "desktop is untouched" provable rather than promised. The one
  // VIEWPORT query in the file belongs to _sidebarDrawerAllowed (§10).
  // ⚠️ Counted by what is queried, not by name. The theme's prefers-color-scheme query
  // (アカウント設定, 2026-09-14) decides colour, not layout, so it is allowed — exactly one of it.
  check("nothing in the calendar branches on viewport",
    (js.match(/matchMedia\(\s*'\((max|min)-(width|height)/g) || []).length === 1 &&
      (js.match(/matchMedia\(/g) || []).length === 2 &&
      (js.match(/matchMedia\('\(prefers-color-scheme: dark\)'\)/g) || []).length === 1,
    "a second matchMedia in a render path breaks the CSS-only guarantee");
  const gridBody = js.slice(js.indexOf('function calRenderGrid()'),
                            js.indexOf('function calRenderMobile('));
  check("...so calRenderGrid builds the mobile table on BOTH its exit paths",
    (gridBody.match(/calRenderMobile\(days, periods, weekDates\);/g) || []).length === 2,
    "the early return leaves a stale mobile table on screen; the tail is the normal path");
}

console.log("\n19. 入試関連 pass 2 — 面接結果 narrows, プレースメント scrolls");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  const desktop = stripCssComments(DESKTOP_CSS);
  const js = ((HTML.match(/<script>[\s\S]*?<\/script>/g) || [])[1] || '')
    .replace(/\/\/[^\n]*/g, '');

  // ---- icons ---------------------------------------------------------------
  // ⚠️ Anchored on onclick so this reads the real markup. `onclick="expToggle(event)"`
  // on its own also matches the 学生一覧 copy, which sits EARLIER in the file, so a bare
  // indexOf silently checks the wrong button and passes while this one has no icon at
  // all. The 出力 anchor is therefore searched from inside 面接結果's own markup (below).
  // It used to be told apart by its inline green, which the 入試関連 retouch (2026-09-14)
  // removed — anchor on structure, not on paint.
  const P2_BTNS = [
    'onclick="expToggle(event)">',
    'onclick="openInterviewResultEntry()">',
    'onclick="importResultsFromBookings()">',
    'onclick="openInterviewResultEdit(${sheetRow})">',
    'onclick="deleteInterviewResult(${sheetRow})">',
    'onclick="openPlacementManage()">',
    'onclick="loadPlacementDashboard(true)">',
    'onclick="copyPlacementLink()">',
  ];
  const irScopeAt = HTML.indexOf('id="sub-view-past-interviews"');
  const irScopeEnd = HTML.indexOf('id="sub-view-placement"');
  const p2Glyphs = P2_BTNS.map(function (a, n) {
    const i = HTML.indexOf(a, n === 0 ? irScopeAt : 0);
    if (i === -1 || (n === 0 && i > irScopeEnd)) return null;
    const m = HTML.slice(i + a.length, i + a.length + 1400)
      .match(/^<svg class="btn-ico" style="display:none"[^>]*>([\s\S]*?)<\/svg>/);
    return m ? m[1] : null;
  });
  check("every 面接結果 / プレースメント button carries an icon right after its onclick",
    p2Glyphs.every(function (g) { return g !== null; }),
    P2_BTNS.filter(function (_, i) { return p2Glyphs[i] === null; }).join(", ") + " missing one");
  check("...and no two of them share a glyph",
    new Set(p2Glyphs).size === p2Glyphs.length,
    "identical glyphs are two unlabelled buttons once the text is clipped");
  // §15's rule: the last three sit inside template literals assigned to innerHTML.
  check("...and the template-literal icons contain no interpolation",
    [3, 4, 7].every(function (i) { return p2Glyphs[i] && p2Glyphs[i].indexOf('${') === -1; }),
    "an interpolated value inside innerHTML is what xss.test.js exists to catch");

  check("both sub-views clip their labels",
    /#sub-view-past-interviews \.btn-label,\s*\n\s*#sub-view-placement \.btn-label\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(mobile), "");
  check("...and NOT by display:none",
    !/#sub-view-(past-interviews|placement) \.btn-label\s*\{[^}]*display:\s*none/.test(mobile), "");
  // ⚠️ .btn-save, not just .schedule-btn: the 編集/削除 buttons on every 面接結果 row
  // are .btn-save, and left as wide pills the action cell eats half the table.
  check("the row action buttons are squared too (.btn-save, not only .schedule-btn)",
    /#sub-view-past-interviews \.btn-save:has\(> \.btn-label\)\s*\{/.test(mobile),
    "編集/削除 stay full-width pills without this");

  // ⚠️ setupInterfaceBasedOnRole drives display from data-perm/data-orig-display;
  // a stylesheet rule fighting it hides the button for everyone who should see it.
  check("no rule sets display on the permission-driven buttons",
    !/#(btnAddInterviewResult|btnImportFromBookings|btnManagePlacement|btn-export-ir)[^{]*\{[^}]*display:/.test(mobile),
    "the permission loop owns that property");

  // ---- 面接結果: column hiding ---------------------------------------------
  check("the secondary columns are hidden on mobile",
    /#pastInterviewsTable \.ir-sec\s*\{[^}]*display:\s*none/.test(mobile), "");
  check("...and .ir-sec has NO desktop rule",
    !/\.ir-sec/.test(desktop),
    "a desktop rule would drop 17 columns from the web version too");

  // ⚠️ THE PAIRING that makes hiding safe: every row opens a detail card listing all
  // 20 fields. If that ever goes, .ir-sec has to go with it — a hidden column with
  // no detail view is data destroyed, not deferred (which is why プレースメント below
  // hides nothing).
  check("every 面接結果 row still opens the full detail card",
    /onclick="showDetail\(event, \$\{i\}, 'interview'\)"/.test(HTML), "");
  check("...and showDetail renders every header, not a subset",
    /headers\.forEach\(\(header, index\) => \{[\s\S]{0,200}detail-label/.test(js),
    "hiding columns is only safe while this iterates the whole header row");

  // ⚠️ BY NAME, NOT POSITION. These headers are row 0 of the sheet; an nth-child rule
  // points at the wrong column the first time someone reorders Interview_Results.
  check("the primary columns are matched by name, through normName",
    /const IR_PRIMARY = \['日付', '名前', '合否'\]/.test(js)
      && /IR_PRIMARY\.some\(h => normName\(h\) === normName\(header\)\)/.test(js), "");
  check("...and nothing hides a column positionally",
    !/#pastInterviewsTable[^{]*nth-child/.test(mobile),
    "a positional rule silently follows the wrong column after a sheet reorder");
  // ⚠️ FAIL OPEN: a rename that matches nothing must render as today, not blank.
  check("...and a header rename fails open rather than blanking the table",
    /if \(irPrimaryHits === 0\) irSecondary = \{\};/.test(js),
    "hiding every column is a far worse failure than showing all of them");

  // ---- プレースメント: the results table is left alone, on purpose ----------
  // ⚠️ THREE mobile treatments were built for this table and all three reverted:
  // compressed-and-wrapping (the generic rules), a min-width floor that made it
  // scroll sideways with the first column frozen, and a per-row card layout. It now
  // has NO mobile rules at all and renders from its desktop rule at every width.
  // This assertion is the decision, written down: reintroducing a treatment has to be
  // a deliberate act that also deletes this line, not something that drifts back in.
  const plMobileRules = (mobile.match(/([^{}]+)\{([^{}]*)\}/g) || [])
    .map(function (r) { return r.slice(0, r.indexOf('{')).trim(); })
    .filter(function (sel) { return /#placementResultsTableEl/.test(sel); });
  check("the placement results table has NO mobile rules at all",
    plMobileRules.length === 0,
    "reverted deliberately; found: " + plMobileRules.join(" / "));
  // ⚠️ ...and the delete stopped where it should have. These sit directly below the
  // block that was removed, belong to the sub-tab's chrome rather than its table, and
  // an over-eager cut would take them with it.
  check("...while the sub-tab's link field and icon buttons keep theirs",
    /#placementLinkField\s*\{[^}]*min-width:\s*0/.test(mobile)
      && /#sub-view-placement \.btn-label[\s,{]/.test(mobile)
      && /#sub-view-placement \.schedule-btn:has\(> \.btn-label\)/.test(mobile),
    "the revert was table-only; these three must survive it");
  // The desktop rule it now relies on at every width. Pre-dates all of this work.
  check("...and the desktop rule it falls back to still exists",
    /#placementResultsTableEl td, #placementResultsTableEl th \{[\s\S]{0,200}word-break: break-word/.test(desktop),
    "with no mobile rules, this is the only thing shaping the table on a phone")

  // ---- the 出力 menu must open ON SCREEN ------------------------------------
  // ⚠️ .exp-menu is `right: 0` with a 220px min-width — fine while the button sits at
  // the right of its row. On a phone #searchInterviewsInp takes a full row, so 出力
  // becomes the LEFTMOST item of the second row at x=12, and the menu opened at
  // x = -178 … 56: 178px off the left edge, unreachable. Nothing clipped it and
  // content off the LEFT does not extend scrollWidth, so `overflow` reported nothing.
  check("the export menu is re-anchored to the left on mobile",
    /#sub-view-past-interviews \.exp-menu\s*\{[^}]*left:\s*0/.test(mobile)
      && /#sub-view-past-interviews \.exp-menu\s*\{[^}]*right:\s*auto/.test(mobile),
    "right:0 puts a 220px menu off the left edge of a 390px screen");
  // ⚠️ SCOPED. Four other .exp-wrap copies exist; the 在籍学生 one is pinned hard
  // right by justify-self:end, so a bare rule would throw THAT one off the far side.
  // Every rule that repositions .exp-menu must name the sub-view in its selector.
  // (A `!/\.exp-menu\{left:0/` regex cannot express this: the scoped selector
  // contains the unscoped one as a substring, so it matches itself.)
  const expMenuRules = (mobile.match(/([^{}]+)\{([^{}]*)\}/g) || [])
    .map(function (r) { const i = r.indexOf('{');
      return { sel: r.slice(0, i), body: r.slice(i + 1, -1) }; })
    .filter(function (r) { return /\.exp-menu/.test(r.sel) && /left\s*:/.test(r.body); });
  // ⚠️ A LIST, not a single name. There are two legitimate scopes now — 面接結果 and
  // the 増減推移 modal — and both buttons sit at the left of their row. What must stay
  // impossible is an UNSCOPED rule: the 進路 and 在籍学生 copies are pinned right, and
  // left:0 would throw those off the opposite edge. Add to this list deliberately,
  // after checking which side that particular button sits on.
  const EXP_MENU_SCOPES = /#sub-view-past-interviews/;
  check("...and every rule that moves it names one of the known scopes",
    expMenuRules.length > 0
      && expMenuRules.every(function (r) { return EXP_MENU_SCOPES.test(r.sel); }),
    "an unscoped .exp-menu{left:0} trades this bug for the same bug on another tab: "
      + expMenuRules.map(function (r) { return r.sel.trim(); }).join(" / "));

  // ---- 編集/削除 last, and the export that depended on them being first -------
  // ⚠️ Order asserted by position in the source, not by eye: both must be emitted
  // AFTER their loop, or they are back on the left.
  const irFn = js.slice(js.indexOf('function renderPastInterviewsTable()'),
                        js.indexOf('function renderIntakeTabs('));
  check("the action column is emitted after the header loop",
    irFn.indexOf('<th class="exp-skip">') > irFn.indexOf('onclick="sortInterviewsTable('), "");
  check("...and after the cell loop",
    irFn.indexOf('<td class="exp-skip"') > irFn.indexOf('html += `<td${irCls(ci)}>'), "");

  // ⚠️ THE LATENT BUG THIS FIXED. _expReadTable used cells.slice(1), driven by an
  // unconditional per-table flag — but the action column only renders `if (canEdit)`,
  // so a user WITHOUT entry_interview_results exported every file with Timestamp
  // missing. Slicing the far end once the column moved would only have relocated it
  // onto EnteredBy. Reading the cell's own class is true at either end, and whether
  // or not the column is there at all.
  check("the export drops action cells by marker class, never by index",
    /td\.classList\.contains\('exp-skip'\)/.test(js), "");
  check("...and no index slice survives in the reader",
    !/cells\s*=\s*cells\.slice\(/.test(js),
    "slice(1) drops a real column for anyone who cannot edit; slice(0,-1) just moves it");
  check("...and both the header and the body cell carry the marker",
    /html \+= '<th class="exp-skip"><\/th>'/.test(js)
      && /<td class="exp-skip" style="white-space:nowrap; text-align:center;"/.test(js),
    "marking only one leaves a stray empty column in the file");

  // ---- the innerText trap, now three buttons --------------------------------
  check("the label helper is shared, with a getter for the save/restore buttons",
    /function _setBtnLabel\(btn, text\)/.test(js) && /function _getBtnLabel\(btn\)/.test(js), "");
  check("...and importResultsFromBookings / copyPlacementLink go through it",
    /let orig = _getBtnLabel\(btn\); btn\.disabled = true; _setBtnLabel\(btn, "取込中\.\.\."\)/.test(js)
      && /let t = _getBtnLabel\(btn\); _setBtnLabel\(btn, "コピーしました"\)/.test(js), "");
  // ⚠️ DERIVED FROM THE MARKUP, not a hand-kept list — the whole point is to catch
  // the NEXT button that gains an icon while its handler still writes innerText.
  // Alias-aware: the code is always `let btn = document.getElementById('x')`, so a
  // plain window scan reports any innerText nearby (helpEl's, in calRenderGrid) and
  // is useless. This resolves the variable first, then looks for writes to IT.
  //
  // It found a real one: #btnSimSave in 募集シミュレーション carried an icon and
  // simSave() still did `btn.innerText = "保存中..."`, blanking it on every phone.
  const ICON_IDS = [...new Set((HTML.match(/id="([a-zA-Z0-9_-]+)"[^>]*>\s*<svg class="btn-ico"/g) || [])
    .map(function (m) { return m.match(/id="([a-zA-Z0-9_-]+)"/)[1]; }))];
  const wipers = [];
  ICON_IDS.forEach(function (id) {
    const re = new RegExp("(?:let|const|var)\\s+(\\w+)\\s*=\\s*document\\.getElementById\\(['\"]" + id + "['\"]\\)", "g");
    let m;
    while ((m = re.exec(js)) !== null) {
      const alias = m[1];
      const win = js.slice(m.index, m.index + 2000);
      if (new RegExp("\\b" + alias + "\\.innerText\\s*=").test(win)) wipers.push(id);
    }
  });
  check("no icon-bearing button is written with innerText any more",
    wipers.length === 0,
    wipers.join(", ") + " — innerText replaces every child, so the icon goes with it "
      + "and the button renders blank on a phone; use _setBtnLabel/_getBtnLabel");
  check("...and the check actually found the icon buttons to police",
    ICON_IDS.length >= 12, "resolved " + ICON_IDS.length + " — the id scan is broken");
}

console.log("\n20. 増減推移 modal — a modal needs its own scope");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  const desktop = stripCssComments(DESKTOP_CSS);
  const js = ((HTML.match(/<script>[\s\S]*?<\/script>/g) || [])[1] || '')
    .replace(/\/\/[^\n]*/g, '');

  // ⚠️ #stuTrendModal is a body-level SIBLING of #view-students, so none of the
  // view-scoped clip rules reach it — but the global .btn-ico reveal does. An icon
  // without a clip rule renders icon PLUS text: wider than before, not narrower.
  check("the modal has its own label-clipping scope",
    /#stuTrendModal \.btn-label\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(mobile),
    "the #view-students scope cannot cross into a sibling subtree");
  check("...and NOT by display:none",
    !/#stuTrendModal \.btn-label\s*\{[^}]*display:\s*none/.test(mobile), "");
  // ⚠️ .btn-cancel appears in no other scope. − 前年度 is one.
  check("...and the sizing covers .btn-cancel, which no other scope does",
    /#stuTrendModal \.btn-cancel:has\(> \.btn-label\)/.test(mobile),
    "− 前年度 would stay a wide pill beside its shrunken ＋ sibling");
  // ⚠️ #stuTrendSave's visibility is driven from JS by canEdit.
  check("...and nothing sets display on #stuTrendSave",
    !/#stuTrendSave[^{]*\{[^}]*display:/.test(mobile),
    "stuRenderTrend owns that property");

  // ⚠️ The 出力 button is found by SCOPE, not by its inline style. This used to anchor
  // on the literal `style="background-color:#1cc88a; padding:5px 12px; font-size:12px;"`
  // and broke on 2026-09-07 when the button size scale removed those two declarations —
  // a true statement about the markup, failing for a reason unrelated to what it guards.
  // expToggle(event) appears on four buttons across the file, which is why it needed a
  // disambiguator at all; the modal's own markup is a better one than its paint.
  const trendScope = HTML.slice(HTML.indexOf('id="stuTrendModal"'),
                                HTML.indexOf('id="stuTrendModal"') + 6000);
  const TREND_BTNS = [
    'onclick="expToggle(event)">',
    'onclick="stuTrendSave()">',
    'onclick="stuTrendAddYear(1)">',
    'onclick="stuTrendAddYear(-1)">',
  ];
  const trendGlyphs = TREND_BTNS.map(function (a, n) {
    // The first is looked for inside the modal; the other three are unique file-wide.
    const hay = n === 0 ? trendScope : HTML;
    const i = hay.indexOf(a);
    if (i === -1) return null;
    return glyphAfter(hay, i + a.length);
  });
  function glyphAfter(hay, from) {
    const m = hay.slice(from, from + 1400)
      .match(/^<svg class="btn-ico" style="display:none"[^>]*>([\s\S]*?)<\/svg>/);
    return m ? m[1] : null;
  }
  check("all four modal buttons carry an icon right after their onclick",
    trendGlyphs.every(function (g) { return g !== null; }),
    TREND_BTNS.filter(function (_, i) { return trendGlyphs[i] === null; }).join(", ") + " missing one");
  check("...and no two of them share a glyph",
    new Set(trendGlyphs).size === trendGlyphs.length,
    "＋ and − are one path apart and are the obvious collision");
  // The two 前年度 buttons live in concatenated strings assigned to innerHTML.
  check("...and the JS-built pair contain no interpolation",
    trendGlyphs.slice(2).every(function (g) { return g && g.indexOf('${') === -1; }), "");

  // ⚠️ LOAD-BEARING ABSENCE. The sizing rule keys on :has(> .btn-label), so 閉じる
  // keeps its word only because it has no label span. Give it one and it silently
  // becomes an anonymous icon-less square.
  const closeBtn = HTML.slice(HTML.indexOf('id="stuTrendModal"'),
                              HTML.indexOf('id="gradDetailModal"'));
  check("閉じる is left as text, and stays that way",
    /<button class="btn-cancel" onclick="document\.getElementById\('stuTrendModal'\)\.style\.display='none'">閉じる<\/button>/.test(closeBtn),
    "no btn-label on it is what keeps :has() from shrinking it");

  // ⚠️ TWO AXES. Measured before the fix: the menu opened at x=-42 AND at y 701-821
  // while the modal box ended at 761, so two of three items hit-tested to the overlay.
  // .modal-box is overflow:auto + max-height:92vh on mobile, so it CLIPS an
  // absolutely-positioned child; top:100% opened the menu straight out of the box.
  // ---- the 出力 menu: anchored to the ROW, at every width ---------------------
  // ⚠️ NOT to the button. .exp-menu is right:0 + 220px min-width, which assumes the
  // button is the last item in its row; 出力 is second from the right here. Measured
  // with the button as the basis: 17px hung off a phone screen, and on desktop the
  // menu fell outside .modal-box entirely. Anchoring to the row pins it to the
  // modal's own right edge whatever the buttons do — including when 保存 is hidden
  // for non-editors, which shifts 出力 sideways. Verified: identical rect either way.
  check("the menu is anchored to the action row, not the button",
    /#stuTrendActions\s*\{[^}]*position:\s*relative/.test(desktop)
      && /#stuTrendModal \.exp-wrap\s*\{[^}]*position:\s*static/.test(desktop),
    "button-anchored, the menu moves when 保存 is hidden and hangs off a phone");
  // ⚠️ .modal-box is overflow:auto (max-height:92vh on mobile) and therefore CLIPS an
  // absolutely-positioned child. The row is at the bottom, so opening downward put
  // two of three items outside the box, hit-testing to the overlay.
  check("...and opens upward, so it stays inside the scrollable .modal-box",
    /#stuTrendModal \.exp-menu\s*\{[^}]*bottom:\s*100%/.test(desktop)
      && /#stuTrendModal \.exp-menu\s*\{[^}]*top:\s*auto/.test(desktop), "");
  // ⚠️ It applies at ALL widths now. A mobile-only override is what the previous
  // version had, and it was wrong the moment the buttons moved.
  check("...at every width, not as a mobile-only override",
    !/#stuTrendModal \.exp-menu/.test(mobile),
    "a media-block copy would drift out of step with the desktop rule");

  // ---- the action row ---------------------------------------------------------
  // ⚠️ NOT class="modal-actions", tempting as it is: 18 other modals use it and its
  // desktop rule is the alignment we want, but its MOBILE rule is
  // `flex-direction: column !important` + `> button { width: 100% }`, which stacks
  // these into full-width bars and undoes the icon-only treatment.
  const trendRow = HTML.slice(HTML.indexOf('id="stuTrendActions"'),
                              HTML.indexOf('id="gradDetailModal"'));
  check("the action row is right-aligned and NOT .modal-actions",
    /id="stuTrendActions"[^>]*justify-content:\s*flex-end/.test(HTML)
      && !/id="stuTrendActions"[^>]*class="modal-actions"/.test(HTML)
      && !/class="modal-actions"[^>]*id="stuTrendActions"/.test(HTML),
    "modal-actions would stack the row full-width on a phone");
  // ⚠️ This is the whole layout mechanism. Lose it and the row silently splits back
  // into 出力 hard-left / 閉じる hard-right — which is what caused the overflow.
  check("...and the status text is what holds the left edge",
    /id="stuTrendSaveMsg"[^>]*margin-right:\s*auto/.test(HTML), "");
  // ⚠️ The form-row stacker catches this row now that it is flat. `.modal-box >
  // div[style*="display:flex"]` sets flex-direction:column !important for side-by-side
  // FIELDS, and its own comment warns a blanket rule "would also flatten toolbars and
  // chip rows, which are meant to stay horizontal". Flattening made this a direct
  // child of .modal-box, so 保存/出力/閉じる stacked into three centred lines on a
  // phone. Measured, not guessed — the desktop row looked perfect throughout.
  check("...and the row is exempt from the form-row stacker on mobile",
    /#stuTrendActions\s*\{[^}]*flex-direction:\s*row\s*!important/.test(mobile),
    "without this the three buttons stack vertically inside the modal");
  check("...with the buttons ordered 保存 / 出力 / 閉じる",
    trendRow.indexOf('id="stuTrendSave"') < trendRow.indexOf('onclick="expToggle(event)"')
      && trendRow.indexOf('onclick="expToggle(event)"') < trendRow.indexOf('>閉じる</button>'),
    "出力 must sit next to 閉じる");

  // ⚠️ 進路 is pinned RIGHT (last item in a justify-content:flex-end row), so the
  // same fix would break it. "Fix the other popovers too" is the obvious next
  // thought and it is wrong here.
  check("...and 進路 is deliberately NOT given the same rule",
    !/#sub-view-dest[^{]*\.exp-menu/.test(mobile),
    "that copy is right-pinned; left:0 would throw it off the opposite edge");
  // 進路's icons come only from the #view-students scope — a re-scope there would
  // strip them silently, so pin the markup.
  check("...and 進路's own buttons still carry their icons",
    /onclick="destOpenPivot\(\)"><svg class="btn-ico"/.test(HTML)
      && /#view-students \.btn-label\s*\{[^}]*clip-path/.test(mobile), "");

  // The modal was written the right way: transient text goes to a separate span.
  check("the modal writes its status to a span, not into a button",
    /getElementById\('stuTrendSaveMsg'\)\.innerText/.test(js)
      && !/getElementById\('stuTrendSave'\)[^;]*\.innerText/.test(js),
    "innerText on the button would delete the icon it now has");
}

console.log("\n21. 募集状況 キャンセル — three tables, and the flex item that hid the overflow");
{
  const at = STYLE.indexOf('@media (max-width: 820px)');
  const mobile = stripCssComments(STYLE.slice(at));
  const desktop = stripCssComments(DESKTOP_CSS);
  const js = ((HTML.match(/<script>[\s\S]*?<\/script>/g) || [])[1] || '')
    .replace(/\/\/[^\n]*/g, '');
  const fn = js.slice(js.indexOf('function recRenderCancelTable('),
                      js.indexOf('function recAddCancelRow('));

  // ⚠️ THE USER'S REQUIREMENT: the three 種別 keep their order when stacked. There is
  // no other ordering concept in this tracker — no priority field, no drag-to-reorder
  // (that exists, but for 募集担当者 columns, not for these).
  check("the 種別 order is unchanged",
    /const REC_CANCEL_KINDS = \["申請キャンセル", "申請取り下げ", "COE後キャンセル"\]/.test(js), "");
  check("...and the renderer iterates it rather than sorting",
    /REC_CANCEL_KINDS\.forEach\(function\(k\)\{[\s\S]{0,400}rec-cancel-group/.test(fn),
    "sorting by row count would silently reorder the groups");

  // One table per 種別, all inside #recCancelTable.
  check("it renders one table per 種別 inside a flex set",
    /class="rec-cancel-set"/.test(fn) && /class="rec-cancel-group"/.test(fn), "");
  // ⚠️ _recConfirmPendingRow resolves optimistic rows with
  // box.querySelectorAll('[data-row="..."]') scoped to #recCancelTable. It does not
  // care how many tables sit in between — but it does require that ancestry.
  check("...and #recCancelTable is still the element written to",
    /const el = document\.getElementById\('recCancelTable'\)/.test(fn)
      && /el\.innerHTML = h;/.test(fn),
    "optimistic add confirms by querying inside that id");
  check("...with the editing contract intact on every control",
    (fn.match(/data-row="' \+ _recRowKey\(r\) \+ '" data-field="' \+ field \+ '" onchange="recSaveCancelCell\(this\)"/g) || []).length === 2
      && /onclick="recAddCancelRow\(this\.dataset\.k\)" data-k=/.test(fn)
      && /onclick="recDeleteCancelRow\(/.test(fn), "");

  // ⚠️ The merged banded table is gone and must stay gone. It padded every group to a
  // common row count and drew bands with a border constant; the file's own comment
  // warned its column count "appears in five coupled places".
  check("the merged-table artifacts are gone",
    !/maxRows/.test(js) && !/const BLC/.test(js),
    "the banded layout is what made this ~1030px wide");

  // ⚠️ THE ACTUAL PAGE-LEVEL OVERFLOW WAS THE FLEX ITEM, NOT THE TABLE. キャンセル and
  // 不交付 are inline `flex: 0 0 auto` — flex-shrink:0, sized to max-content — so
  // .table-responsive never got clamped and never got to scroll. Measured before:
  // scrollWidth 1310 against a 390px viewport; after: 390.
  check("the bottom columns can shrink on mobile",
    /\.rec-bottom-col\s*\{[^}]*min-width:\s*0\s*!important/.test(mobile), "");
  check("...and the markup carries the hooks",
    /id="recBottomRow"/.test(HTML)
      && (HTML.match(/class="rec-bottom-col"/g) || []).length === 3, "");

  // ⚠️ nowrap is load-bearing on BOTH stacks, and it is the subtlest part of this.
  // Both rows carry flex-wrap:wrap for their desktop layout. In flex-direction:column
  // that makes the container form cross-axis LINES, so align-items:stretch sizes each
  // item against its line's widest member — 766px of max-content table — instead of
  // against the container. Measured: 1310 -> 778 -> 433 -> 390 as each was fixed.
  check("the outer row stacks without wrapping",
    /#recBottomRow\s*\{[^}]*flex-direction:\s*column/.test(mobile)
      && /#recBottomRow\s*\{[^}]*flex-wrap:\s*nowrap\s*!important/.test(mobile)
      && /#recBottomRow\s*\{[^}]*align-items:\s*stretch\s*!important/.test(mobile),
    "wrap in column direction sizes items against their line, not the container");
  check("...and so does the 種別 set",
    /\.rec-cancel-set\s*\{[^}]*flex-direction:\s*column/.test(mobile)
      && /\.rec-cancel-set\s*\{[^}]*flex-wrap:\s*nowrap/.test(mobile)
      && /\.rec-cancel-set\s*\{[^}]*align-items:\s*stretch/.test(mobile),
    "the identical trap one level down");

  check("the set is a row on desktop",
    /\.rec-cancel-set\s*\{[^}]*display:\s*flex/.test(desktop)
      && /\.rec-cancel-group\s*\{[^}]*flex:\s*0 0 auto/.test(desktop), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
