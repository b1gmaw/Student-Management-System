// The finish layer: type, radius, elevation, motion, focus.
//
// ⚠️ WHY THIS EXISTS. Measured before the refresh, this one stylesheet carried 38
// border-radius declarations across 11 distinct values, 9 ad-hoc box-shadows reaching
// rgba(0,0,0,0.5), zero focus affordances, and a single font-family naming Helvetica
// Neue and Arial. None of that is a bug — it is drift, and drift has no failing test,
// which is exactly why it accumulates. This file turns the scales into a contract.
//
// The two things here that are NOT taste, and would break the app if reverted:
//   - the webfont is INJECTED, never linked. A render-blocking font stylesheet left
//     this page BLANK on a filtered network once already.
//   - the finish tokens live in their OWN :root block, because tests/theme.test.js
//     requires every token in the palette block to have a dark-mode counterpart.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

const STYLE = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
const MAIN  = STYLE.split('@media (max-width: 820px)')[0];   // desktop rules only
// ⚠️ Comments stripped for the scanners below. The comment above `body` quotes the
// exact string it is warning about ("`transition: 0.3s` ... was shorthand for
// `transition: all 0.3s`"), so a raw scan reports the warning as the violation. Fourth
// time this pattern has bitten in this repo — see schedule.test.js §9 and mobile §5.
const CODE  = MAIN.replace(/\/\*[\s\S]*?\*\//g, '');
// Markup with every <script> block removed — what the browser parses as HTML.
const MARKUP = HTML.replace(/<script>[\s\S]*?<\/script>/g, '');

console.log("\n1. the finish tokens are defined, and NOT in the palette block");
{
  const TOKENS = ["--r-sm", "--r-md", "--r-lg", "--r-pill",
                  "--sh-sm", "--sh-md", "--sh-lg", "--sh-rail", "--ease", "--ring"];
  TOKENS.forEach(function (t) {
    check(t + " is defined", new RegExp("\\" + t + "\\s*:").test(MAIN), "");
  });

  // ⚠️ THE structural one. tests/theme.test.js parses the FIRST `:root` and asserts
  // every token in it has a body.dark-mode counterpart. A radius token in there fails
  // that immediately, and mirroring `10px` into the dark palette is meaningless.
  const firstRoot = MAIN.slice(MAIN.indexOf('\n      :root {'),
                               MAIN.indexOf('}', MAIN.indexOf('\n      :root {')));
  check("⚠️ the palette :root holds ONLY colour tokens",
    TOKENS.every(function (t) { return firstRoot.indexOf(t) === -1; }),
    "a finish token leaked into the palette block — theme.test.js will fail on it");
  check("...and every token it does hold is a colour",
    (firstRoot.match(/--[a-z-]+\s*:\s*([^;]+);/g) || [])
      .every(function (d) { return /#|rgba?\(/.test(d); }),
    "the palette block should be hexes and rgba only");
  check("there really are two :root blocks",
    (MAIN.match(/\n      :root \{/g) || []).length === 2,
    "the finish tokens must live in their own block");
}

console.log("\n2. ⚠️ the webfont is injected, never linked");
{
  // A <link rel=stylesheet> is render-blocking. With fonts.googleapis.com slow or
  // filtered — which a school network may well do — the page stays BLANK instead of
  // degrading. That is a measured incident, not a hypothetical.
  check("⚠️ no font stylesheet is written into the markup",
    MARKUP.indexOf('fonts.googleapis.com') === -1,
    "a <link> here blocks first paint and can blank the page entirely");
  check("...it is created from script instead",
    /l\.rel = 'stylesheet';[\s\S]{0,200}fonts\.googleapis\.com/.test(HTML), "");
  check("display=swap, so the fallback paints immediately",
    /fonts\.googleapis\.com[^'"]*display=swap/.test(HTML),
    "without swap the browser hides text for up to 3s waiting on the font");
  // ⚠️ Each CJK weight is a separate large download; the stylesheet only uses 400/700.
  check("⚠️ exactly two weights are requested",
    /Noto\+Sans\+JP:wght@400;700&/.test(HTML)
      && !/Noto\+Sans\+JP:wght@[0-9;]*[0-9]{3};[0-9]{3};/.test(HTML),
    "a third CJK weight is a few hundred KB for two declarations");
  check("a failed injection cannot break boot",
    /catch \(e\) \{ \/\* the system stack is a complete fallback/.test(HTML), "");
  check("preconnect goes out too", /rel = 'preconnect'/.test(HTML), "");
}

console.log("\n3. the type stack names Noto first AND a real fallback");
{
  const ff = MAIN.match(/font-family:\s*([^;]+);/g) || [];
  check("still exactly one font-family in the whole stylesheet", ff.length === 1,
    "found " + ff.length + " — one declaration is what makes this a one-line revert");
  check("Noto Sans JP is first", /font-family:\s*"Noto Sans JP",/.test(MAIN),
    "the point of loading it is that every machine matches");
  check("...with a system stack behind it",
    /-apple-system[\s\S]{0,120}system-ui,\s*sans-serif/.test(MAIN),
    "this is what paints while Noto loads, and forever if the CDN is blocked");
  check("neither banned face survives",
    !/Helvetica Neue/.test(MAIN) && !/Arial/.test(MAIN), "");
}

console.log("\n4. the scales are actually used — no raw values left behind");
{
  const radii = (MAIN.match(/border-radius:\s*([^;}]+)/g) || [])
    .map(function (d) { return d.split(':')[1].trim(); });
  // 0 and 2px stay: mark.dorm-hl and .rr-left-bar are 4px-wide decorations, and a 6px
  // radius on a 4px bar is a lozenge.
  const strayR = radii.filter(function (v) {
    return v !== '0' && v !== '2px' && v.indexOf('var(--r-') === -1;
  });
  check("every border-radius reads the scale", strayR.length === 0,
    "raw: " + strayR.join(", "));
  check("...and all four steps are in use",
    ["--r-sm", "--r-md", "--r-lg", "--r-pill"].every(function (t) {
      return MAIN.indexOf("var(" + t + ")") !== -1; }), "");

  const shadows = (MAIN.match(/box-shadow:\s*([^;}]+)/g) || [])
    .map(function (d) { return d.split(':').slice(1).join(':').trim(); });
  // ⚠️ `inset 3px 0 0 var(--primary-color)` is NOT a shadow — it is the active-row
  // indicator, drawn with the shadow property. The rgba is the color-mix fallback.
  const strayS = shadows.filter(function (v) {
    return v.indexOf('inset') !== 0 && v.indexOf('var(--sh-') === -1
        && v.indexOf('var(--ring)') === -1 && v.indexOf('rgba(78,115,223,0.25)') === -1;
  });
  check("every elevation reads the scale", strayS.length === 0, "raw: " + strayS.join(", "));
  check("⚠️ the active-row indicators were NOT swallowed by the scale",
    (MAIN.match(/box-shadow:\s*inset 3px 0 0 var\(--primary-color\)/g) || []).length === 2,
    "those two draw a selection bar, not a shadow");
  check("⚠️ the focus ring keeps its pre-color-mix fallback",
    /box-shadow: 0 0 0 2px rgba\(78,115,223,0\.25\); box-shadow: var\(--ring\);/.test(MAIN),
    "a browser without color-mix would otherwise LOSE the ring it has today");
}

console.log("\n5. motion — one curve, and no `transition: all` survives");
{
  // ⚠️ `transition: 0.2s` means `transition: all 0.2s`. CLAUDE.md records that shape
  // relayouting the whole page for 300ms on every sidebar toggle, because `all` caught
  // padding. .slot-cell carried one per cell across the 面接スケジュール grid.
  const bare = (CODE.match(/transition:\s*(all\s+)?[\d.]+m?s/g) || []);
  check("⚠️ no transition names `all`, or omits its property list", bare.length === 0,
    "found: " + bare.join(", ") + " — `all` catches padding and relayouts the page");
  const trans = (CODE.match(/transition:\s*([^;}]+)/g) || []);
  check("every transition carries the shared curve",
    trans.length > 0 && trans.every(function (t) { return t.indexOf('var(--ease)') !== -1; }),
    "without a curve these fall back to `ease`, which is symmetrical and reads mechanical");
}

console.log("\n6. focus, and the !important floor");
{
  check("a :focus-visible rule exists", /:focus-visible\s*\{/.test(MAIN),
    "there were none at all before this");
  // ⚠️ Scoped to the GLOBAL rule. Element-scoped `:focus` on text inputs is correct
  // and pre-existing (.fy-block input, .pin-input) — a field that shows focus on click
  // is wanted. What must not exist is an unqualified `:focus { }` painting a ring on
  // every mouse click anywhere.
  check("...the global rule is :focus-visible, not a bare :focus",
    !/(^|[\s,}])\:focus\s*\{/.test(CODE),
    "an unqualified :focus draws a ring on mouse clicks too");
  check("...and it uses outline, which takes no layout space",
    /:focus-visible\s*\{[^}]*outline:/.test(MAIN), "");
  // ⚠️ mobile.test.js owns this rule; the count may only go DOWN. Pinned here too
  // because a focus ring is exactly the kind of thing reached for with !important.
  // ⚠️ Counted from CODE, i.e. comments stripped. Counting MAIN counted the word
  // wherever a comment merely NAMES the rule ("!important is confined to the media
  // block"), which put the figure at 14 and made the check ~4 declarations too loose.
  // The real declaration count is 10 — the same baseline tests/mobile.test.js pins.
  check("⚠️ the desktop !important count did not increase",
    CODE.split('!important').length - 1 <= 10,
    "10 desktop declarations is the documented floor, and it may only go DOWN — " +
    "confining !important to the media block is what stops the overrides leaking up");
}

console.log("\n7. the button size scale");
{
  // ⚠️ WHY. Reported as "inconsistent button sizes, especially on 学生数". Measured:
  // five heights inside 学生一覧 alone — h20 ＋行を追加, h27 性別集計/増減推移/出力,
  // h29 フィルタ解除, h35 国名設定/Excel出力, h39 保存. The classes carried NO size, so
  // 42 call sites each invented one inline across 21 distinct paddings.
  //
  // ⚠️ It could not be fixed from CSS: an inline style beats any rule here, and
  // !important is confined to the media block. The declarations had to come out.
  const CLASSES = ['schedule-btn', 'export-btn', 'btn-save', 'btn-cancel'];

  check("the three sizes exist",
    /\.schedule-btn,\s*\.export-btn,\s*\.btn-save,\s*\.btn-cancel,\s*\.clear-filters\s*\{[^}]*padding:\s*8px 15px/.test(CODE)
      && /\.btn-sm[^{]*\{[^}]*padding:\s*5px 12px/.test(CODE)
      && /\.btn-xs\s*\{[^}]*padding:\s*2px 9px/.test(CODE), "");
  check("...and each sets a font-size, not just padding",
    (CODE.match(/\.btn-sm[^{]*\{[^}]*font-size/) || []).length === 1
      && (CODE.match(/\.btn-xs\s*\{[^}]*font-size/) || []).length === 1,
    "padding alone leaves the label size drifting per call site, which is half the bug");
  // ⚠️ Sizing must live in ONE place. .schedule-btn and friends are declared earlier in
  // the file, so a padding restored to one of them beats .btn-sm on source order.
  // ⚠️ indexOf, not a constructed RegExp — escaping a dot and a brace through a
  // string literal into a RegExp is how a check ends up matching nothing and passing.
  CLASSES.forEach(function (c) {
    const at = CODE.indexOf('.' + c + ' {');
    const body = at === -1 ? null : CODE.slice(at, CODE.indexOf('}', at));
    check("⚠️ ." + c + "'s own rule carries no size",
      body !== null && !/padding:|font-size:/.test(body),
      "it precedes the scale, so a size here silently outranks .btn-sm");
  });

  // ---- the markup half -----------------------------------------------------
  const tags = HTML.match(/<button\b[^>]*>/g) || [];
  // ⚠️ EITHER quote style. Template literals in the script build buttons with class='…', and
  // reading only class="…" hid 19 of them twice over: they escaped the inline-size check
  // below, AND were counted as "class-less icon buttons" in the exclusion further down, so
  // the floor of 33 was 19 real button-class buttons plus 14 icon controls. Found 2026-09-14
  // when the 入試関連 retouch moved the リンク管理 list onto .btn-xs and that count "dropped".
  const classOf = function (t) { const m = t.match(/class=(["'])([^"']*)\1/); return m ? m[2] : null; };
  const classed = tags.filter(function (t) {
    const c = classOf(t);
    return c !== null && CLASSES.some(function (k) { return c.indexOf(k) !== -1; });
  });
  check("the button classes are still widely used", classed.length > 100,
    "found " + classed.length);
  const inlineSized = classed.filter(function (t) { return /(padding|font-size)\s*:/.test(t); });
  check("⚠️ no button carrying a button class sets its own padding or font-size",
    inlineSized.length === 0,
    inlineSized.length + " still do, e.g. " + (inlineSized[0] || '').slice(0, 90));
  check("...and the two modifiers are actually used",
    /class=["'][^"']*\bbtn-sm\b/.test(HTML) && /class=["'][^"']*\bbtn-xs\b/.test(HTML), "");

  // ⚠️ THE exclusion. These are `background: none; border: none` icon controls —
  // photo-slot ✕ removers, accordion toggles. They have no button chrome, and their
  // sizing is intrinsic to what they are rather than drift. A later sweep that
  // "tidies" them would shrink or inflate every one of them.
  // The exclusion as it was actually drawn: no button class at all, and sized inline.
  const iconBtns = tags.filter(function (t) {
    return classOf(t) === null && /(padding|font-size)\s*:/.test(t);
  });
  // Re-pinned, not loosened: 14 is what was always really here (see classOf above).
  check("⚠️ the class-less icon buttons were NOT swept up", iconBtns.length >= 14,
    "found " + iconBtns.length + " (was 14) — if this dropped, the sweep went too wide");
}

console.log("\n8. ⚠️ buttons are tiered by ROLE, not by their old inline padding");
{
  // ⚠️ WHY. The first pass tiered 42 buttons mechanically, from whatever inline padding
  // each already carried. 出力 had `5px 12px` so it became .btn-sm; 閉じる had no inline
  // style so it kept the default — and the two sit in ONE action row, 27px against 35px.
  // Reported as "出力 is significantly smaller than the other buttons".
  //
  // A toolbar button and a modal action button are the same thing whatever somebody
  // typed inline years ago. .btn-sm is for buttons INSIDE A TABLE ROW.
  const tags = HTML.match(/<button\b[^>]*>/g) || [];

  // 出力 is a toolbar/action control everywhere it appears — never compact.
  const expBtns = tags.filter(function (t) { return /onclick="expToggle\(event\)"/.test(t); });
  check("every 出力 button exists and is full size", expBtns.length >= 4
      && expBtns.every(function (t) { return !/btn-sm|btn-xs/.test(t); }),
    expBtns.filter(function (t) { return /btn-sm|btn-xs/.test(t); }).join('\n') ||
    "found " + expBtns.length);

  // ⚠️ The row the bug was reported in: 保存 / 出力 / 閉じる must agree.
  const actions = HTML.slice(HTML.indexOf('id="stuTrendActions"'),
                             HTML.indexOf('id="stuTrendActions"') + 2200);
  const actionBtns = actions.match(/<button\b[^>]*>/g) || [];
  check("⚠️ the 増減推移 action row is one tier throughout",
    actionBtns.length >= 3 && actionBtns.every(function (t) {
      return /exp-item/.test(t) || !/btn-sm|btn-xs/.test(t); }),
    "保存 / 出力 / 閉じる sat at 27px, 27px and 35px in the same row");

  // フィルタ解除 sits directly beside 出力 in 在籍学生's filter bar.
  check(".clear-filters takes the default size, like its neighbour",
    /\.schedule-btn, \.export-btn, \.btn-save, \.btn-cancel, \.clear-filters \{/.test(CODE)
      && !/\.btn-sm, \.clear-filters/.test(CODE),
    "it was left out of BOTH rules once, which sized it at 21px");

  // ⚠️ .btn-sm survives only inside table rows. These four toolbars are the ones the
  // report named; a modifier reappearing on any of them is the regression.
  ['destOpenPivot()', 'stuOpenGender()', 'stuOpenTrend()'].forEach(function (fn) {
    const t = tags.filter(function (x) { return x.indexOf('onclick="' + fn + '"') !== -1; })[0];
    check(fn + " is a toolbar button, so full size", !!t && !/btn-sm|btn-xs/.test(t),
      t || "not found");
  });
}

console.log("\n9. 面接スケジュール fills the window; 申請関連's own furniture");
{
  // ⚠️ WHY. The calendar is class="schedule-grid table-responsive", so it inherited
  // .table-responsive's hard-coded max-height: 600px — a cap written for DATA TABLES.
  // Measured at a 900px viewport: 602px, scrolling, with 128px unused below it. Proven
  // to be the cause by changing the offset to 200 and watching the computed cap become
  // exactly 700px.
  check("the calendar cap is viewport-relative",
    /\.schedule-grid\.table-responsive \{ max-height: max\(360px, calc\(100vh - 300px\)\); \}/.test(CODE),
    "a fixed pixel cap ignores the window, which is the whole complaint");
  check("...with a floor, so a short window does not collapse it",
    /max\(360px,/.test(CODE), "");
  check("...and a dvh variant for browsers that have it",
    /@supports \(height: 100dvh\)/.test(CODE), "");
  // ⚠️ THE one that matters: the shared rule must not be widened instead.
  check("⚠️ .table-responsive's own 600px cap is UNCHANGED",
    /\.table-responsive \{[^}]*max-height: 600px/.test(CODE),
    "every data table in the app shares it, and tests/mobile.test.js §2 pins it");
  check("⚠️ ...and the calendar rule is scoped to the PAIR, not to either class alone",
    /\.schedule-grid\.table-responsive/.test(CODE)
      && !/^\s*\.schedule-grid \{ max-height/m.test(CODE),
    "specificity 0,2,0 is what makes this independent of source order");
  // ⚠️ The sticky header row and sticky first column resolve against the grid as its own
  // scroll container.
  check("⚠️ the grid is still its own scroll container",
    /\.table-responsive \{[^}]*overflow-y: auto/.test(CODE),
    "drop it and the sticky header and pinned first column go with it");
  // ⚠️ The new rule outranks the media block's .table-responsive { max-height: 70vh }.
  // Harmless ONLY because the calendar grid is hidden on phones — assert that pairing.
  const mobile = STYLE.split('@media (max-width: 820px)')[1] || '';
  check("⚠️ ...which is safe only because the calendar is hidden on phones",
    /#sub-view-schedule \.schedule-grid \{ display: none !important; \}/.test(mobile),
    "if the mobile panel ever stops replacing this view, the desktop cap leaks in");

  // ---- 申請関連 -------------------------------------------------------------
  // ⚠️ Not a separate HTML file. Shinsei_Template.html is the A4 PDF template; the tab
  // is #view-shinsei in this file, so the finish tokens already reached its .shinsei-*
  // rules. What they could NOT reach was inline styling — which beats the stylesheet.
  check("the mode toggle is a segmented control, not two slabs",
    /\.seg-track \{/.test(CODE) && /class="seg-track"/.test(HTML), "");
  check("⚠️ ...and .mode-btn no longer stretches",
    !/\.mode-btn \{[^}]*flex: 1/.test(CODE),
    "`flex: 1` is what made the pair span the full width");
  check("...the active segment is raised rather than filled",
    /\.mode-btn\.active \{[^}]*box-shadow: var\(--sh-sm\)/.test(CODE), "");
  const sel = HTML.slice(HTML.indexOf('class="edit-selector"'),
                         HTML.indexOf('class="edit-selector"') + 300);
  check("⚠️ .edit-selector's inline raw radius is gone",
    !/border-radius: 8px/.test(sel) && /border-radius: var\(--r-md\)/.test(sel),
    "inline beats the stylesheet, which is why the finish pass could not reach it");
  // ⚠️ Comments stripped: the comment that EXPLAINS this quotes the colour it is
  // warning about, so a raw scan reports the warning as the violation. Sixth time in
  // this repo — see schedule.test.js §9 and modalesc.test.js §1.
  check("⚠️ ...and its hardcoded green with it",
    !/rgba\(15,157,88/.test(HTML.replace(/<!--[\s\S]*?-->/g, '')),
    "a colour belonging to no palette, surviving because it was inline");
  check("the section heading reads as a marker, not another underline",
    /\.shinsei-form-section h3 \{[^}]*border-left: 3px solid var\(--primary-color\)/.test(CODE), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
