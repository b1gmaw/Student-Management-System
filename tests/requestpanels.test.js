// The four request panels inside teacherViewModal are mutually exclusive.
//
// A teacher opens a booked slot and asks for exactly one thing: a different
// teacher (交代), a different time (日時変更), or a cancellation. Each toggle used
// to set only its OWN style.display, so clicking 日時/担当変更リクエスト and then
// キャンセルを依頼 left BOTH forms on screen, either of which could be submitted.
//
// toggleChangeRequestChooser was half-right — it hid reassignSection and
// bookerChangeSection but not cancelRequestSection — and toggleCancelSection hid
// nothing at all. Half-exclusive reads as correct right up until someone clicks
// the two buttons in the wrong order.
//
// Found on staging @108 while testing the 交代 flow.
//
// ⚠️ WHICH HALF OF THIS FILE IS LOAD-BEARING. Sections 1-3 transcribe the helper
// and prove the RULE is right; they cannot notice a toggle that stops calling it,
// because they exercise the transcription rather than the source. Mutation-checked:
// restoring toggleCancelSection's original body leaves all of 1-3 green.
// **Section 4 is the regression guard** — it reads Index.html and fails on exactly
// that mutation. Keep both, and do not "simplify" section 4 away.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}
// Comments name the old behaviour to explain why it is gone.
const CODE = HTML.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const PANELS = ['changeRequestChooser', 'reassignSection', 'bookerChangeSection', 'cancelRequestSection'];

// ---- transcribed from Index.html -------------------------------------------
let dom = {};
const resetDom = function () {
  dom = {};
  PANELS.forEach(function (p) { dom[p] = { style: { display: 'none' } }; });
};
const getElementById = function (id) { return dom[id] || null; };

function _showTeacherRequestPanel(id) {
  PANELS.forEach(function (p) {
    const el = getElementById(p);
    if (el) el.style.display = (p === id) ? 'block' : 'none';
  });
}
const visible = function () {
  return PANELS.filter(function (p) { return dom[p].style.display === 'block'; });
};

// The four entry points, as the source now defines them.
const toggleChangeRequestChooser = (s) => _showTeacherRequestPanel(s ? 'changeRequestChooser' : null);
const toggleReassignSection      = (s) => _showTeacherRequestPanel(s ? 'reassignSection' : null);
const toggleBookerChangeSection  = (s) => _showTeacherRequestPanel(s ? 'bookerChangeSection' : null);
const toggleCancelSection        = (s) => _showTeacherRequestPanel(s ? 'cancelRequestSection' : null);

console.log("\n1. exactly one panel, whichever is opened");
{
  PANELS.forEach(function (p) {
    resetDom();
    _showTeacherRequestPanel(p);
    check("opening " + p + " leaves only itself",
      visible().length === 1 && visible()[0] === p,
      "visible: " + visible().join(", "));
  });
  resetDom();
  _showTeacherRequestPanel(null);
  check("null closes everything", visible().length === 0, visible().join(", "));
}

console.log("\n2. the reported sequences — both click orders");
{
  // ⚠️ THE BUG. Either order left two forms open; the second was the one that
  // used to escape, because toggleChangeRequestChooser never touched the cancel
  // panel and toggleCancelSection never touched anything.
  resetDom();
  toggleChangeRequestChooser(true);
  toggleCancelSection(true);
  check("変更リクエスト then キャンセル依頼 leaves one panel",
    visible().length === 1 && visible()[0] === 'cancelRequestSection',
    "visible: " + visible().join(", "));

  resetDom();
  toggleCancelSection(true);
  toggleChangeRequestChooser(true);
  check("キャンセル依頼 then 変更リクエスト leaves one panel",
    visible().length === 1 && visible()[0] === 'changeRequestChooser',
    "visible: " + visible().join(", "));

  // Through the chooser into a sub-section, then the cancel button.
  resetDom();
  toggleChangeRequestChooser(true);
  toggleReassignSection(true);      // via openReassignFromChooser
  check("the chooser closes when 交代 opens",
    visible().length === 1 && visible()[0] === 'reassignSection', visible().join(", "));
  toggleCancelSection(true);
  check("交代 then キャンセル依頼 leaves one panel",
    visible().length === 1 && visible()[0] === 'cancelRequestSection', visible().join(", "));

  resetDom();
  toggleChangeRequestChooser(true);
  toggleBookerChangeSection(true);  // via openBookerDateChange
  toggleCancelSection(true);
  check("日時変更 then キャンセル依頼 leaves one panel",
    visible().length === 1 && visible()[0] === 'cancelRequestSection', visible().join(", "));
}

console.log("\n3. 戻る closes cleanly from every panel");
{
  [[toggleChangeRequestChooser, 'chooser'], [toggleReassignSection, '交代'],
   [toggleBookerChangeSection, '日時変更'], [toggleCancelSection, 'キャンセル']].forEach(function (t) {
    resetDom();
    t[0](true);
    t[0](false);
    check("戻る from " + t[1] + " closes everything", visible().length === 0, visible().join(", "));
  });

  // openReassignFromChooser calls chooser(false) then section(true). Under the
  // helper the first call closes all — the net result must still be the section.
  resetDom();
  toggleChangeRequestChooser(false);
  toggleReassignSection(true);
  check("chooser(false) then section(true) still opens the section",
    visible().length === 1 && visible()[0] === 'reassignSection', visible().join(", "));
}

console.log("\n4. the source still matches the transcription");
{
  check("_showTeacherRequestPanel exists",
    /function _showTeacherRequestPanel\(id\) \{/.test(HTML), "");
  check("TEACHER_REQUEST_PANELS lists all four ids",
    PANELS.every(function (p) {
      return new RegExp("TEACHER_REQUEST_PANELS[\\s\\S]{0,200}?'" + p + "'").test(HTML);
    }), "a panel dropped off the list is a panel that stops being exclusive");
  check("it is declared before openTeacherViewModal",
    HTML.indexOf('const TEACHER_REQUEST_PANELS') !== -1 &&
    HTML.indexOf('const TEACHER_REQUEST_PANELS') < HTML.indexOf('function openTeacherViewModal'),
    "a const read before its declaration throws — CLAUDE.md rule 3");

  // ⚠️ THE REGRESSION GUARD. Direct assignment to a panel's display IS the bug.
  // Every toggle must go through the helper instead.
  PANELS.forEach(function (p) {
    check("nothing assigns " + p + ".style.display directly",
      !new RegExp("getElementById\\([\"']" + p + "[\"']\\)").test(CODE),
      "route it through _showTeacherRequestPanel, or it will hide only itself again");
  });

  [['toggleChangeRequestChooser', 'changeRequestChooser'],
   ['toggleReassignSection', 'reassignSection'],
   ['toggleBookerChangeSection', 'bookerChangeSection'],
   ['toggleCancelSection', 'cancelRequestSection']].forEach(function (t) {
    check(t[0] + " routes through the helper",
      new RegExp("function " + t[0] + "\\(show\\) \\{[\\s\\S]{0,300}?_showTeacherRequestPanel\\(show \\? \"" + t[1] + "\" : null\\)").test(HTML),
      "");
  });

  check("both modal open and close reset through the helper",
    (HTML.match(/_showTeacherRequestPanel\(null\)/g) || []).length >= 2,
    "openTeacherViewModal and closeTeacherViewModal each had their own copy of " +
    "the panel list; a third copy is how they drift apart");

  // Each panel must still exist in the markup. domrefs.test.js checks
  // getElementById targets, and these ids are now reached through an array
  // instead — so that suite no longer covers them.
  PANELS.forEach(function (p) {
    check(p + " exists in the markup",
      new RegExp('id="' + p + '"').test(HTML),
      "the array names a panel that is not there — it silently does nothing");
  });
}

console.log("\n5. each toggle still resets its own fields");
{
  // The exclusivity change rewrote the first line of all four; the rest of each
  // body is the reset that stops a stale reason showing on the next open.
  check("交代 clears its reason and time fields",
    /function toggleReassignSection[\s\S]{0,400}?reassignChangeTime[\s\S]{0,200}?reassignReason/.test(HTML), "");
  check("日時変更 repopulates its dropdowns and clears its reason",
    /function toggleBookerChangeSection[\s\S]{0,300}?populateBookerChangeDropdowns\(\)[\s\S]{0,120}?bookerChangeReason/.test(HTML), "");
  check("キャンセル clears its reason",
    /function toggleCancelSection[\s\S]{0,400}?cancelReason/.test(HTML), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
