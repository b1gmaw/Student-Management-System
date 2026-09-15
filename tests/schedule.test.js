// 入寮時渡すスケジュール — the printable arrival schedule handed to an accepted student.
//
// ⚠️ WHY THIS EXISTS. The sheet is bilingual: 日本語 is the constant half of every
// line and the second language is chosen per student. The library ships SEEDED with
// 【要翻訳】 placeholders so the feature works before the translations arrive — which
// means the one thing that must never break is the fallback. A placeholder and an
// empty cell have to behave IDENTICALLY, and both must print Japanese alone. Weaken
// that and 【要翻訳】 goes out on a student's schedule.
//
// The other half is positional drift: language columns are located by HEADER NAME,
// because adding a language IS adding a column and the set grows over time.

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const CODE = fs.readFileSync(path.join(root, 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

const TODO = "【要翻訳】";

// ---- transcribed from Index.html --------------------------------------------
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function ordinal(d) {
  if (d % 100 >= 11 && d % 100 <= 13) return "th";
  if (d % 10 === 1) return "st";
  if (d % 10 === 2) return "nd";
  if (d % 10 === 3) return "rd";
  return "th";
}
function dateLine(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  const dow = DOW[new Date(y, mo - 1, d).getDay()];
  return MONTHS[mo - 1] + " " + d + ordinal(d) + " (" + dow + ")";
}
function native(phrase, lang) {
  if (!phrase || !phrase.text) return "";
  const v = String(phrase.text[lang] || "").trim();
  if (v === "" || v.indexOf(TODO) === 0) return "";
  return v;
}

// ---- transcribed from Code.js: language columns are whatever is not fixed -----
const FIXED = ["キー", "分類"];
function langsOf(headers) {
  return headers.map(h => String(h).trim())
                .filter(h => h !== "" && FIXED.indexOf(h) === -1);
}
function phraseRowFor(headers, phrase) {
  const text = phrase.text || {};
  return headers.map(function (h) {
    if (h === "キー") return phrase.key;
    if (h === "分類") return phrase.category || "";
    return text[h] === undefined ? "" : String(text[h]);
  });
}

console.log("\n1. the date line matches the reference sheets");
{
  // Straight from Schedule_1 / Schedule_2 (2026 weekdays).
  check("April 2nd",  dateLine("2026-04-02").indexOf("April 2nd")  === 0, dateLine("2026-04-02"));
  check("April 3rd",  dateLine("2026-04-03").indexOf("April 3rd")  === 0, dateLine("2026-04-03"));
  check("April 8th",  dateLine("2026-04-08").indexOf("April 8th")  === 0, dateLine("2026-04-08"));
  check("January 7th", dateLine("2026-01-07").indexOf("January 7th") === 0, dateLine("2026-01-07"));
  check("the weekday is derived, not typed", /\((Sun|Mon|Tue|Wed|Thu|Fri|Sat)\)$/.test(dateLine("2026-04-02")),
    dateLine("2026-04-02"));

  // ⚠️ The teens are the whole reason ordinal() is not `d % 10` alone.
  check("11th / 12th / 13th are th, not st/nd/rd",
    ordinal(11) === "th" && ordinal(12) === "th" && ordinal(13) === "th", "");
  check("21st / 22nd / 23rd still take their suffix",
    ordinal(21) === "st" && ordinal(22) === "nd" && ordinal(23) === "rd", "");
  check("1st / 2nd / 3rd", ordinal(1) === "st" && ordinal(2) === "nd" && ordinal(3) === "rd", "");
  check("month ends", dateLine("2026-01-31").indexOf("January 31st") === 0
    && dateLine("2026-02-28").indexOf("February 28th") === 0, "");

  // ⚠️ Parsed BY PARTS. new Date("2026-04-02") is UTC-midnight and shifts a day
  // backwards in Asia/Tokyo — the trap Code.js _sessionAgeMs_ documents.
  check("a malformed date yields nothing, never a wrong date",
    dateLine("") === "" && dateLine("2026/04/02") === "" && dateLine(null) === "", "");
  // ⚠️ SCOPED TO THE FUNCTION. An unscoped regex matched schedDateLineJa's identical
  // parse and kept passing while schedDateLine itself was mutated to new Date().
  const dlFn = HTML.slice(HTML.indexOf('function schedDateLine(iso)'),
                          HTML.indexOf('function schedDateLineJa(iso)'));
  check("...and the source parses by parts rather than new Date(string)",
    /String\(iso \|\| ""\)\.match\(/.test(dlFn) && !/new Date\(iso\)/.test(dlFn),
    "new Date(str) here would move dates across the date line");
  const ordFn = HTML.slice(HTML.indexOf('function _schedOrdinal(d)'),
                           HTML.indexOf('function schedDateLine(iso)'));
  check("...and the source still special-cases the teens",
    /d % 100 >= 11 && d % 100 <= 13/.test(ordFn),
    "without it 11th/12th/13th come out as 11st/12nd/13rd");
}

console.log("\n2. ⚠️ the fallback — a placeholder must never reach a student");
{
  const p = { key: 'k', text: {
    '日本語': 'パスポートをお持ちください。',
    'ネパール語': 'कृपया आफ्नो राहदानी ल्याउनुहोस्।',
    'ミャンマー語': '',                        // never filled in
    'ベトナム語': TODO + 'Please bring your passport.'   // seeded, not yet translated
  } };
  check("a real translation is used", native(p, 'ネパール語').indexOf('कृपया') === 0, "");
  check("an EMPTY cell yields nothing", native(p, 'ミャンマー語') === "", "");
  check("a 【要翻訳】 placeholder yields nothing", native(p, 'ベトナム語') === "", "");
  // This is the assertion that matters: the two must be indistinguishable, so a
  // half-finished library degrades exactly like an untouched one.
  check("...and empty and placeholder are INDISTINGUISHABLE",
    native(p, 'ミャンマー語') === native(p, 'ベトナム語'),
    "if these ever differ, one of them is printing something");
  check("an unknown language yields nothing", native(p, 'タガログ語') === "", "");
  check("whitespace-only is treated as empty", native({ text: { x: "   " } }, 'x') === "", "");

  // The renderer skips the native line entirely when the fallback returns "" —
  // it must not emit an empty element that would leave a gap on the page.
  check("the renderer only emits a native line when there is one",
    /if \(nat\) body \+= '<div class="sched-native">'/.test(HTML),
    "an always-emitted div leaves a blank line under every untranslated item");
  check("...and the Japanese half is always emitted",
    /body \+= '<div class="sched-ja">'/.test(HTML), "");

  // ⚠️ THE SOURCE BINDING for the fallback. The transcription above proves the rule;
  // this proves the app still implements it. Both halves of the condition matter —
  // dropping either lets one of empty / placeholder through.
  const natFn = HTML.slice(HTML.indexOf('function schedNative(phrase, lang)'),
                           HTML.indexOf('function schedPhraseByKey(k)'));
  check("the source treats empty AND placeholder as untranslated",
    /if \(v === "" \|\| v\.indexOf\(SCHED_TODO\) === 0\) return "";/.test(natFn),
    "either half missing means one of them prints");

  check("the prefix is defined once on each side",
    /const SCHED_TODO_PREFIX = "【要翻訳】";/.test(CODE)
      && /const SCHED_TODO = "【要翻訳】";/.test(HTML),
    "two spellings of the marker means one of them stops being recognised");
}

console.log("\n3. language columns are found by NAME, never by position");
{
  const headers = ["キー", "分類", "日本語", "English", "ネパール語"];
  check("languages are whatever is not a fixed column",
    JSON.stringify(langsOf(headers)) === JSON.stringify(["日本語", "English", "ネパール語"]), "");

  // ⚠️ Someone reorders the sheet by hand. Values must follow their header.
  const reordered = ["分類", "キー", "ネパール語", "日本語", "English"];
  const ph = { key: 'k1', category: 'c', text: { '日本語': 'あ', 'English': 'a', 'ネパール語': 'न' } };
  const row = phraseRowFor(reordered, ph);
  check("a reordered header row still writes each value under its own column",
    row[0] === 'c' && row[1] === 'k1' && row[2] === 'न' && row[3] === 'あ' && row[4] === 'a',
    JSON.stringify(row));

  // ⚠️ Adding a language IS adding a column; existing rows simply have no value.
  const widened = headers.concat(["タガログ語"]);
  const row2 = phraseRowFor(widened, ph);
  check("a newly added language column comes out empty, not shifted",
    row2.length === 6 && row2[5] === "" && row2[2] === 'あ', JSON.stringify(row2));
  check("...and an empty one reads back as untranslated",
    native({ text: { 'タガログ語': row2[5] } }, 'タガログ語') === "", "");

  check("the source builds its row against the CURRENT headers",
    /let row = headers\.map\(function \(h\) \{[\s\S]{0,200}return text\[h\] === undefined \? "" : String\(text\[h\]\);/.test(CODE),
    "a fixed column order here is the positional-drift bug this file keeps hitting");
  check("...and never indexes a language column by number",
    !/data\[i\]\[2\]|data\[i\]\[3\]/.test(CODE.slice(CODE.indexOf('function getScheduleBundle'),
                                                     CODE.indexOf('function _schedTemplateRows_'))), "");
}

console.log("\n4. the template blob survives a round trip, including a deleted block");
{
  const blocks = [
    { date: '2026-04-02', time: '9:00am', place: '@Main Campus',
      items: [{ type: 'phrase', key: 'bring_passport', note: false }] },
    { date: '2026-04-03', time: '13:00pm', place: '@Second Campus',
      items: [{ type: 'phrase', key: 'bank_account', note: false }] },
    { date: '2026-04-08', time: '9:15am', place: '@Main Campus',
      items: [{ type: 'phrase', key: 'entrance_ceremony', note: true }] }
  ];
  const saved = JSON.stringify({ v: 1, blocks: blocks });
  const back = JSON.parse(saved);
  check("blocks and items survive", back.blocks.length === 3
    && back.blocks[2].items[0].note === true, "");
  check("the blob is versioned", back.v === 1, "");

  // The late-arrival case: the paperwork days are removed and the rest is unchanged.
  const late = back.blocks.slice(2);
  const lateSaved = JSON.parse(JSON.stringify({ v: 1, blocks: late }));
  check("deleting the paperwork blocks leaves the ceremony day intact",
    lateSaved.blocks.length === 1 && lateSaved.blocks[0].date === '2026-04-08', "");

  check("a corrupt blob degrades to an empty schedule, not a thrown render",
    /try \{ parsed = JSON\.parse\(t\.body \|\| "\{\}"\); \} catch \(e\) \{ parsed = null; \}/.test(HTML),
    "an unparseable cell must not take the sub-view down (CLAUDE.md rule 2)");
}

console.log("\n5. the printable is built for the browser, not the server");
{
  // ⚠️ Utilities.getAs(MimeType.PDF) has no webfonts — Devanagari, Burmese and
  // Sinhala come out as empty boxes there. This is the reason for the print window.
  const fn = HTML.slice(HTML.indexOf('function schedBuildHtml()'),
                        HTML.indexOf('function schedRender()'));
  check("charset is declared", /<meta charset="utf-8">/.test(fn), "CJK is unreadable without it");
  check("A4 with print margins", /@page\{size:A4;margin:20mm;\}/.test(fn), "");
  // ⚠️ The LONGHAND. Browsers treat the two identically here, but the server-side PDF
  // converter drops the `background` shorthand — measured: the printed copy had the
  // yellow date bar and the downloaded PDF did not, which is exactly the mismatch the
  // download exists to avoid (the two go out together).
  // The student's name is the heading of their own sheet; at 13pt against a 12pt body
  // it read as ordinary text. ⚠️ Longhands for the same reason as the highlight below.
  check("the name is larger than the body and bold",
    /\.sched-name\{font-size:16pt;font-weight:700;/.test(fn)
      && /body\{[^}]*font-size:12pt/.test(fn),
    "asserted against the body size, so shrinking one without the other fails");
  check("...set with longhands, never the font shorthand",
    !/\.sched-name\{[^}]*font:/.test(fn),
    "the converter drops shorthands — bold on paper, plain in the PDF");
  check("the date highlight uses background-color, not the shorthand",
    /\.sched-date\{[^}]*background-color:#ffef7a/.test(fn)
      && !/\.sched-date\{[^}]*[^-]background:#ffef7a/.test(fn),
    "the shorthand is dropped by the converter and the bar vanishes from the PDF");
  check("the font stack names the scripts it must cover",
    /Noto Sans JP/.test(fn) && /Noto Sans Devanagari/.test(fn)
      && /Noto Sans Myanmar/.test(fn) && /Noto Sans Sinhala/.test(fn), "");
  // ⚠️ Injected by script, NOT a <link> in <head>: a render-blocking stylesheet left
  // the whole page blank when fonts.googleapis.com was slow or filtered. Measured —
  // the preview iframe painted nothing while readyState sat at "interactive".
  check("the font stylesheet is injected, not render-blocking",
    /document\.createElement\("link"\)/.test(fn)
      && !/<link rel="stylesheet"/.test(fn),
    "a blocking stylesheet renders a blank page on a filtered network");
  check("...and printing waits for the fonts rather than a fixed timer",
    /w\.document\.fonts\.ready\.then/.test(HTML),
    "printing before Noto lands is exactly the tofu this design avoids");
  check("...with a cap so a blocked CDN still prints",
    /setTimeout\(once, 4000\)/.test(HTML), "");
  check("the popup blocker is handled like the other print windows",
    /ポップアップがブロックされました/.test(HTML.slice(HTML.indexOf('function schedPrint()'),
                                                   HTML.indexOf('function schedSaveTemplate()'))), "");
}

console.log("\n6. wiring — the traps this app has hit before");
{
  // ⚠️ It lives under 寮管理, whose sub-views are toggled by inline style.display and
  // a marker class — NOT the .sub-view-section/.active scheme the other tabs use.
  // Mixing the two silently produces a sub-view that never shows or never hides.
  check("the sub-view and its button exist and match",
    /id="dorm-sub-entry-schedule"/.test(HTML) && /id="btn-dorm-entry-schedule"/.test(HTML), "");
  check("...and it uses 寮管理's marker class, not .sub-view-section",
    /id="dorm-sub-entry-schedule" class="dorm-sub-section" style="display:none;"/.test(HTML),
    "the two schemes are not interchangeable");
  check("...and it sits inside #view-dorms",
    HTML.indexOf('id="dorm-sub-entry-schedule"') > HTML.indexOf('id="view-dorms"')
      && HTML.indexOf('id="dorm-sub-entry-schedule"') < HTML.indexOf('id="view-shared-schedule"'), "");
  check("the button is permission-gated the standard way",
    /id="btn-dorm-entry-schedule"[^>]*class="sub-nav-btn permission-req"[^>]*data-orig-display="block"[^>]*data-perm="view_student_schedule"/.test(HTML), "");

  // ⚠️ switchDormSubTab used to name its two sub-views and buttons a line each, so a
  // third would have been left on screen underneath. It sweeps by class now, which
  // is why nothing in it mentions entry-schedule by name except the lazy load.
  const dormFn = HTML.slice(HTML.indexOf('function switchDormSubTab(which)'),
                            HTML.indexOf('function loadDocDashboard()'));
  check("switchDormSubTab sweeps by class rather than naming ids",
    /querySelectorAll\('#view-dorms \.dorm-sub-section'\)/.test(dormFn)
      && !/getElementById\('dorm-sub-rooms'\)/.test(dormFn),
    "a hard-coded pair cannot hide a third sub-view");
  check("...and the schedule is lazily loaded from there",
    /if \(which === 'entry-schedule' && !schedLoaded\) \{ schedLoad\(\); \}/.test(dormFn), "");
  check("...and 入試関連 no longer knows about it",
    !/'entry-schedule'/.test(HTML.slice(HTML.indexOf('function switchAdmissionsSubTab'),
                                        HTML.indexOf('function switchAdmissionsSubTab') + 900)),
    "a stale key there would fight the dorm switcher");
  check("both permissions are declared as checkboxes",
    /value="view_student_schedule"/.test(HTML) && /value="manage_student_schedule"/.test(HTML),
    "the 役割管理 modal clones this list, so declaring it here is the whole job");

  // Every endpoint guarded, and by the permission not a role string.
  ['getScheduleBundle','saveScheduleTemplate','deleteScheduleTemplate',
   'saveSchedulePhrase','deleteSchedulePhrase','addScheduleLanguage',
   'getScheduleApplicants'].forEach(function (f) {
    const body = CODE.slice(CODE.indexOf('function ' + f + '('), CODE.indexOf('function ' + f + '(') + 400);
    check(f + " guards on its first line",
      /_hasPerm_\(role, perms, "(view|manage)_student_schedule"\)/.test(body), "");
    check("..." + f + " is registered in _apiMethods_",
      new RegExp("\\s" + f + ": " + f + ",").test(CODE), "an unregistered endpoint is unreachable");
  });

  // ⚠️ Free text reaching a sheet: a value starting = is a formula, not a label.
  check("template and phrase writes go through _cellSafeRow_",
    /const row = _cellSafeRow_\(\[name,/.test(CODE) && /row = _cellSafeRow_\(row\);/.test(CODE),
    "a phrase starting with = becomes a live formula in the workbook");
}

console.log("\n7. 日程の種別 — pick the day, the lines come with it");
{
  // ---- transcribed from schedSetDayType / the renderer ----------------------
  const phrases = [
    { key: 'bring_passport',    category: '持ち物', text: { '日本語': 'パスポートと在留カードをお持ちください。' } },
    { key: 'jp_interview',      category: '手続き', text: { '日本語': '日本語のインタビューと住所登録' } },
    { key: 'entrance_ceremony', category: '行事',   text: { '日本語': '入学式' } },
    { key: 'bring_slippers',    category: '持ち物', text: { '日本語': '上履きと、筆記用具・ノートをお持ちください。' } }
  ];
  const byKey = k => phrases.filter(p => p.key === k)[0] || null;
  function materialise(keys) {
    return keys.filter(k => !!byKey(k)).map(function (k) {
      const ph = byKey(k);
      return { type: 'phrase', key: k, text: "", time: "", note: (ph && ph.category === '持ち物') };
    });
  }

  const items = materialise(['bring_passport', 'jp_interview']);
  check("a day type materialises its phrases in order",
    items.length === 2 && items[0].key === 'bring_passport' && items[1].key === 'jp_interview',
    JSON.stringify(items.map(i => i.key)));
  // ⚠️ The order IS the meaning — it is the order the lines print in.
  const rev = materialise(['jp_interview', 'bring_passport']);
  check("...and reversing the day type reverses the lines",
    rev[0].key === 'jp_interview' && rev[1].key === 'bring_passport', "");

  // ⚠️ A phrase deleted from the library leaves its key behind in the day type.
  // Skipping is what keeps an empty bullet off a student's sheet.
  const gappy = materialise(['entrance_ceremony', 'lunch_provided', 'bring_slippers']);
  check("a key with no phrase is SKIPPED, not materialised blank",
    gappy.length === 2 && gappy.map(i => i.key).indexOf('lunch_provided') === -1,
    JSON.stringify(gappy.map(i => i.key)));
  check("...and the surviving lines keep their order",
    gappy[0].key === 'entrance_ceremony' && gappy[1].key === 'bring_slippers', "");
  check("持ち物 lines come through as parenthetical notes",
    materialise(['bring_slippers'])[0].note === true
      && materialise(['jp_interview'])[0].note === false,
    "both reference sheets print the 持ち物 lines in brackets");

  // Source bindings — the transcription above proves the rule, these prove the app
  // still implements it.
  const setFn = HTML.slice(HTML.indexOf('function schedSetDayType(i, name)'),
                           HTML.indexOf('function schedDeleteBlock(i)'));
  check("the source skips keys with no phrase",
    /\.filter\(function \(k\) \{ return !!schedPhraseByKey\(k\); \}\)/.test(setFn),
    "without the filter a deleted phrase becomes a blank bullet");
  check("...and materialises rather than referencing the day type",
    /b\.items = dt\.keys\s*\n\s*\.filter\(/.test(setFn) && !/b\.dayTypeRef/.test(setFn),
    "a live reference would rewrite templates already printed");
  check("...straight from dt.keys, with nothing reordering them",
    !/dt\.keys\s*\.(slice|reverse|sort)/.test(setFn),
    "the day type's order IS the printing order");
  // ⚠️ 持ち物 lines print in brackets on both reference sheets; the mapping from
  // 分類 to the note style had no source binding until a mutation removed it unseen.
  check("...and 持ち物 becomes a parenthetical note",
    /note: \(ph && ph\.category === '持ち物'\)/.test(setFn), "");
  check("...and the block records which type was chosen",
    /b\.dayType = name;/.test(setFn), "");

  // ---- the per-line time ---------------------------------------------------
  function lead(t) { const tm = String(t || "").trim(); return tm ? tm + " " : ""; }
  check("a time prints BEFORE the phrase", lead("9:45~11:30") === "9:45~11:30 ", "");
  // ⚠️ No stray leading space when there is no time — every line saved before this
  // change has none, and they must render byte-identically to before.
  check("no time means no leading space", lead("") === "" && lead(undefined) === "", "");
  check("whitespace-only is treated as no time", lead("   ") === "", "");

  const renderFn = HTML.slice(HTML.indexOf('function schedBuildHtml()'),
                              HTML.indexOf('function schedRender()'));
  check("the source builds the lead the same way",
    /const lead = tm \? escHtmlJs\(tm\) \+ " " : "";/.test(renderFn), "");
  check("...and puts it before the Japanese text",
    /\(it\.note \? '（' : '・'\) \+ lead \+ escHtmlJs\(jaTxt\)/.test(renderFn),
    "time-first is the convention chosen; after would need the whole line reordered");
  check("...and the time is escaped like everything else from the sheet",
    /escHtmlJs\(tm\)/.test(renderFn), "");

  // ---- ⚠️ back-compat: templates saved before this pass ----------------------
  const legacy = { v: 1, blocks: [ { date: '2026-04-02', time: '9:00am', place: '@Main Campus',
    items: [ { type: 'phrase', key: 'jp_interview', note: false } ] } ] };
  const round = JSON.parse(JSON.stringify(legacy));
  check("a block saved before this change still loads",
    round.blocks[0].items[0].key === 'jp_interview', "");
  check("...with no dayType and no item time, which render as they did before",
    round.blocks[0].dayType === undefined
      && round.blocks[0].items[0].time === undefined
      && lead(round.blocks[0].items[0].time) === "",
    "both fields are additive; absence is the whole migration");

  // ---- the day-type sheet ---------------------------------------------------
  check("the day types are a flat ordered key list, not JSON",
    /\["手続き",   1, "bring_passport,jp_interview"\]/.test(CODE),
    "the order is the meaning; flat keeps it hand-editable in the sheet");
  check("empty segments are dropped when reading it",
    /\.filter\(function \(k\) \{ return k !== ""; \}\)/.test(CODE),
    "a trailing comma would otherwise become a blank line");
  check("rows come back in 並び順",
    /out\.sort\(function \(a, b\) \{ return a\.order - b\.order; \}\)/.test(CODE), "");
  ['saveScheduleDayType', 'deleteScheduleDayType'].forEach(function (f) {
    check(f + " is guarded and registered",
      /_hasPerm_\(role, perms, "manage_student_schedule"\)/.test(
        CODE.slice(CODE.indexOf('function ' + f + '('), CODE.indexOf('function ' + f + '(') + 300))
        && new RegExp("\\s" + f + ": " + f + ",").test(CODE), "");
  });
  check("the day-type write goes through _cellSafeRow_",
    /const row = _cellSafeRow_\(\[name, String\(\(dt && dt\.order\)/.test(CODE), "");

  // ⚠️ Deleting a phrase can silently shorten a day type. Warn first.
  check("deleting a phrase names the day types that use it",
    /schedDayTypes\.filter\(function \(d\) \{ return d\.keys\.indexOf\(key\) !== -1; \}\)/.test(HTML),
    "a silent shortening of a printed day is the failure mode here");

  // ⚠️ Per-line phrase picking is gone as the WAY IN — 種別 is. But appending one
  // phrase to an already-built block had to stay: Schedule_2 is 入学式 PLUS the
  // passport line and lunch, and without this those lines could only be 自由入力,
  // losing their translation. Building a block from single phrases is what went.
  check("a block is no longer built one phrase at a time",
    !/schedAddItem\(' \+ i \+ ',\\'phrase\\'\)/.test(HTML),
    "picking text per line is what the 種別 select replaced");
  check("...but one phrase can still be appended to a day type",
    /function schedAppendPhrase\(i, key\)/.test(HTML)
      && /schedAppendPhrase\(' \+ i \+ ',this\.value\)/.test(HTML),
    "without it the second reference sheet can only be built untranslated");
  check("...and appending does not clear the chosen 種別",
    !/schedAppendPhrase[\s\S]{0,300}dayType = ""/.test(HTML), "");
  check("...but 自由入力 stayed",
    /schedAddItem\(' \+ i \+ ',\\'free\\'\)/.test(HTML), "");
}

console.log("\n8. キャンパス is a venue, not a line — and lines reorder");
{
  // ---- transcribed from schedLinePhrases / schedCampusPhrases ---------------
  const CAMPUS = "キャンパス";
  const lib = [
    { key: 'bring_passport',    category: '持ち物',   text: { '日本語': 'パスポート…' } },
    { key: 'entrance_ceremony', category: '行事',     text: { '日本語': '入学式', 'English': 'Entrance Ceremony' } },
    { key: 'campus_main',      category: CAMPUS,     text: { '日本語': '本校キャンパス', 'English': 'Main Campus' } },
    { key: 'campus_second', category: CAMPUS,     text: { '日本語': '第二キャンパス', 'English': '' } }
  ];
  const lineOf   = () => lib.filter(p => p.category !== CAMPUS).map(p => p.key);
  const campusOf = () => lib.filter(p => p.category === CAMPUS).map(p => p.key);

  // ⚠️ Asserted in BOTH directions: one filter without the other IS the bug.
  check("the campus list holds only キャンパス",
    campusOf().join() === 'campus_main,campus_second', campusOf().join());
  check("...and the line pickers hold none of them",
    lineOf().join() === 'bring_passport,entrance_ceremony', lineOf().join());

  // ---- transcribed from schedPlaceSelect -----------------------------------
  // ⚠️ A <select> whose value is absent from its options falls back to the FIRST
  // option WITHOUT firing change. Carrying the stored value is what keeps a
  // pre-dropdown template from being silently rewritten to another campus.
  function placeOptions(place) {
    const cur = String(place || "");
    const campuses = lib.filter(p => p.category === CAMPUS);
    const known = campuses.filter(p => p.key === cur).length > 0;
    let out = [{ value: "", selected: cur === "" }];
    if (cur !== "" && !known) out.push({ value: cur, selected: true, unknown: true });
    campuses.forEach(p => out.push({ value: p.key, selected: p.key === cur }));
    return out;
  }
  const legacyOpts = placeOptions('@Main Campus');
  const sel = legacyOpts.filter(o => o.selected);
  check("a legacy free-text place is preserved as its own option",
    sel.length === 1 && sel[0].value === '@Main Campus' && sel[0].unknown === true,
    JSON.stringify(legacyOpts));
  check("...and is NOT silently swapped for the first campus",
    legacyOpts[0].selected === false && legacyOpts.filter(o => o.value === 'campus_main')[0].selected === false, "");
  const knownOpts = placeOptions('campus_second');
  check("a stored key selects its own campus and adds no stray option",
    knownOpts.length === 3 && knownOpts.filter(o => o.selected)[0].value === 'campus_second',
    JSON.stringify(knownOpts));
  check("an empty place selects the prompt",
    placeOptions("").filter(o => o.selected)[0].value === "", "");

  // ---- transcribed from schedPlaceLine -------------------------------------
  const byKey = k => lib.filter(p => p.key === k)[0] || null;
  function placeLine(place, lang, at) {
    const ph = byKey(place);
    if (!ph) return String(place || "").trim();
    const t = native(ph, lang) || String(ph.text['日本語'] || "").trim();
    if (t === "") return "";
    return (at ? "@" : "") + t;
  }
  check("@ goes on the English header",
    placeLine('campus_main', 'English', true) === '@Main Campus', placeLine('campus_main','English',true));
  check("...and NOT on the Japanese line",
    placeLine('campus_main', '日本語', false) === '本校キャンパス', placeLine('campus_main','日本語',false));
  // ⚠️ Same fallback as every other line: no English means Japanese, not a blank.
  check("a campus with no English falls back to Japanese, still with the @",
    placeLine('campus_second', 'English', true) === '@第二キャンパス', "");
  // ⚠️ Unchanged from before the dropdown: it already carries its own @.
  check("a legacy free-text place prints exactly as typed, both lines",
    placeLine('@Main Campus', 'English', true) === '@Main Campus'
      && placeLine('@Main Campus', '日本語', false) === '@Main Campus', "");
  check("no place prints nothing at all",
    placeLine("", 'English', true) === "" && placeLine(undefined, '日本語', false) === "", "");

  // ---- transcribed from schedMoveItem --------------------------------------
  function moveItem(items, j, d) {
    const n = j + d;
    if (n < 0 || n >= items.length) return items;
    const t = items[j]; items[j] = items[n]; items[n] = t;
    return items;
  }
  const mk = () => [{ key: 'entrance_ceremony', time: '9:45~11:30' },
                    { key: 'orientation', time: '13:00~' },
                    { key: 'bring_slippers', time: '' }];
  const swapped = moveItem(mk(), 1, -1);
  check("a line moves up, and carries its time with it",
    swapped.map(i => i.key).join() === 'orientation,entrance_ceremony,bring_slippers'
      && swapped[0].time === '13:00~' && swapped[1].time === '9:45~11:30',
    JSON.stringify(swapped.map(i => i.key)));
  check("...and the untouched line keeps its position",
    swapped[2].key === 'bring_slippers', "");
  check("moving down works the same way",
    moveItem(mk(), 0, 1).map(i => i.key).join() === 'orientation,entrance_ceremony,bring_slippers', "");
  check("bounds-checked at the top", moveItem(mk(), 0, -1).map(i => i.key).join() === 'entrance_ceremony,orientation,bring_slippers', "");
  check("...and at the bottom", moveItem(mk(), 2, 1).map(i => i.key).join() === 'entrance_ceremony,orientation,bring_slippers', "");

  // ---- source bindings ------------------------------------------------------
  const editorFn = HTML.slice(HTML.indexOf('function schedRenderEditor()'),
                              HTML.indexOf('const SCHED_MONTHS'));
  const dayTypeFn = HTML.slice(HTML.indexOf('function schedRenderDayTypes()'),
                               HTML.indexOf('function _schedSaveDayType(i)'));
  const buildFn = HTML.slice(HTML.indexOf('function schedBuildHtml()'),
                             HTML.indexOf('function schedRender()'));
  const placeSelFn = HTML.slice(HTML.indexOf('function schedPlaceSelect(i, place)'),
                                HTML.indexOf('function schedRenderEditor()'));
  const moveFn = HTML.slice(HTML.indexOf('function schedMoveItem(i, j, d)'),
                            HTML.indexOf('function schedSetItem(i, j, f, v)'));

  check("the split is one named constant, not a literal sprinkled about",
    /const SCHED_CAMPUS_CAT = "キャンパス";/.test(HTML), "");
  check("the campus select offers ONLY キャンパス",
    /function schedCampusPhrases\(\) \{\s*\n\s*return schedPhrases\.filter\(function \(p\) \{ return p\.category === SCHED_CAMPUS_CAT; \}\);/.test(HTML)
      && /schedCampusPhrases\(\)/.test(placeSelFn), "");
  check("...and the block's phrase picker EXCLUDES them",
    /function schedLinePhrases\(\) \{\s*\n\s*return schedPhrases\.filter\(function \(p\) \{ return p\.category !== SCHED_CAMPUS_CAT; \}\);/.test(HTML)
      && /schedPhraseOptions\(schedLinePhrases\(\)\)/.test(editorFn),
    "an unfiltered picker puts a campus on a student's sheet as a bullet");
  check("...and so does the 種別 editor's append picker",
    /schedPhraseOptions\(schedLinePhrases\(\)\)/.test(dayTypeFn),
    "the second filter — either one alone leaves the hole open");
  check("...neither picker reaches schedPhrases directly any more",
    !/schedPhrases\.map\(/.test(editorFn) && !/schedPhrases\.map\(/.test(dayTypeFn), "");

  check("the place field is a select, not free text",
    /h \+= schedPlaceSelect\(i, b\.place\);/.test(editorFn)
      && !/placeholder="@Main Campus"/.test(HTML), "");
  check("the select carries an unrecognised stored value as its own option",
    /if \(cur !== "" && !known\) \{[\s\S]{0,200}escAttrJs\(cur\) \+ '" selected>'/.test(placeSelFn),
    "without it a pre-dropdown template silently changes campus");
  check("...and flags it rather than presenting it as a normal choice",
    /一覧にありません/.test(placeSelFn), "");
  // ⚠️ The block's 種別 select is no longer restorable by position — the place
  // select now precedes it — so it must write selected= itself.
  check("the 種別 select is restored by value, not by being the first <select>",
    /dt\.name === b\.dayType \? ' selected' : ''/.test(editorFn)
      && !/querySelector\('select'\)/.test(editorFn),
    "the old positional fix-up would now target the place select");

  check("the renderer resolves the place through the phrase library",
    /const plEn = schedPlaceLine\(b\.place, "English", true\);/.test(buildFn)
      && /const plJa = schedPlaceLine\(b\.place, "日本語", false\);/.test(buildFn), "");
  check("...and the @ lives in the renderer, on the English side only",
    /return \(at \? "@" : ""\) \+ t;/.test(HTML)
      && !/b\.place \? " " \+ b\.place/.test(buildFn), "");
  check("...and a place with no phrase is printed verbatim",
    /if \(!ph\) return String\(place \|\| ""\)\.trim\(\);/.test(HTML),
    "a template saved before the dropdown must print unchanged");

  check("lines reorder with a bounds check at both ends",
    /const its = schedBlocks\[i\]\.items, n = j \+ d;/.test(moveFn)
      && /if \(n < 0 \|\| n >= its\.length\) return;/.test(moveFn), "");
  check("...and the editor offers both directions per line",
    /schedMoveItem\(' \+ i \+ ',' \+ j \+ ',-1\)/.test(editorFn)
      && /schedMoveItem\(' \+ i \+ ',' \+ j \+ ',1\)/.test(editorFn), "");
  // ⚠️ The whole point: re-picking the 種別 re-materialises and discards the order.
  check("...and reordering does NOT clear the chosen dayType",
    !/dayType/.test(moveFn), "clearing it invites a re-pick that throws the order away");

  // ---- ⚠️ 分類 has to be settable, or the seed is the only way to get a campus --
  // The seed runs ONLY when the sheet is created, so every project already using the
  // feature would have an empty campus dropdown and no way to fill it.
  function catOptions(cur, known) {
    const c = String(cur || "");
    let opts = known.slice();
    if (c !== "" && opts.indexOf(c) === -1) opts.push(c);
    return [{ value: "", selected: c === "" }].concat(
      opts.map(x => ({ value: x, selected: x === c })));
  }
  const KNOWN = ["持ち物", "手続き", "行事", "授業", CAMPUS];
  check("キャンパス is offered as a 分類",
    catOptions("", KNOWN).filter(o => o.value === CAMPUS).length === 1, "");
  check("...an existing 分類 stays selected",
    catOptions(CAMPUS, KNOWN).filter(o => o.selected)[0].value === CAMPUS, "");
  check("...and a hand-typed one is carried, not snapped to the first",
    catOptions("寮", KNOWN).filter(o => o.selected)[0].value === "寮"
      && catOptions("寮", KNOWN).length === KNOWN.length + 2, "");
  const catFn = HTML.slice(HTML.indexOf('function schedCategoryOptions(cur)'),
                           HTML.indexOf('function schedSavePhraseCat(el)'));
  check("...and the source carries it the same way",
    /if \(c !== "" && opts\.indexOf\(c\) === -1\) opts\.push\(c\);/.test(catFn),
    "without this an unrecognised 分類 is silently rewritten on the next edit");

  const phraseFn = HTML.slice(HTML.indexOf('function schedRenderPhrases()'),
                              HTML.indexOf('function schedRenderDayTypes()'));
  check("文言管理 shows and edits 分類",
    />分類<\/th>/.test(phraseFn) && /onchange="schedSavePhraseCat\(this\)"/.test(phraseFn), "");
  check("...as a select, not a text box",
    /schedCategoryOptions\(p\.category\)/.test(phraseFn)
      && /const SCHED_CATEGORIES = \["持ち物", "手続き", "行事", "授業", SCHED_CAMPUS_CAT\];/.test(HTML),
    "a 分類 of 「キャンパス 」 would drop out of the campus list while looking correct");
  check("...and adding a phrase asks for one instead of writing \"\"",
    !/const p = \{ key: key, category: "", text:/.test(HTML)
      && /category: String\(cat\)\.trim\(\)/.test(HTML),
    "a campus added with no 分類 never reaches the venue dropdown");
  const savCatFn = HTML.slice(HTML.indexOf('function schedSavePhraseCat(el)'),
                              HTML.indexOf('function schedSavePhraseCell(el)'));
  check("...and a 分類 change is recorded on the phrase",
    /p\.category = el\.value;/.test(savCatFn), "");
  // ⚠️ MOVED, not dropped. 文言管理 queues its edits now, so the cell handler must NOT
  // render — that async rebuild is exactly what made the table impossible to type in.
  // The property this guards is unchanged: the block and 種別 pickers are built from
  // 分類, so a stale one still lists a campus as a line. It is now 保存's job.
  const savAllFn = HTML.slice(HTML.indexOf('function schedSaveAllPhrases()'),
                              HTML.indexOf('function closeSchedPhrases()'));
  check("...and 保存 re-renders the pickers that filter on it",
    /schedRenderEditor\(\); schedRender\(\);/.test(savAllFn),
    "the block and 種別 pickers are built from 分類; a stale one still lists the campus");
  check("⚠️ ...while the cell handler itself renders nothing",
    !/schedRender/.test(savCatFn) && !/apiRun/.test(savCatFn),
    "an async re-render on every committed cell is what this replaced");

  check("both campuses are seeded in the phrase library",
    /\["campus_main", "キャンパス", "本校キャンパス", "Main Campus"\]/.test(CODE)
      && /\["campus_second", "キャンパス", "第二キャンパス", "Second Campus"\]/.test(CODE), "");
}


console.log("\n9. 入学期 is gone, and the PDF downloads");
{
  // ---- the removed control -------------------------------------------------
  // ⚠️ Asserted as a PAIR. Deleting the markup while a reader still calls
  // getElementById('schedIntake').value is a thrown render, which takes the whole
  // sub-view down with no visible message (CLAUDE.md rule 2).
  check("the 入学期 control is gone from the markup",
    !/id="schedIntake"/.test(HTML), "");
  check("...and nothing reads it any more",
    !/schedIntake/.test(HTML), "a surviving reader throws and blanks the sub-view");
  check("...and its filler went with it",
    !/function schedFillIntakes/.test(HTML), "");
  // ⚠️ Pinned to schedLoad's OWN BODY, not to the line above it. This asserted
  // "schedFillTemplates(); then schedLoadApplicants();" as adjacent lines and broke the
  // day a third filler was added between them — a true statement about the code, failing
  // for a reason that had nothing to do with what it was guarding.
  // ⚠️ Comments stripped first, or a commented-out call reads as a live one — the same
  // trap mobile.test.js §5 hit, and this check was mutation-tested against exactly that.
  const schedLoadFn = HTML.slice(HTML.indexOf('function schedLoad()'),
                                 HTML.indexOf('function schedFillLanguages'))
                          .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("...but the applicant list is still loaded on boot",
    schedLoadFn.indexOf('schedLoadApplicants();') !== -1,
    "schedFillIntakes used to be what called it");

  // ⚠️ The endpoint is UNCHANGED and must stay that way — "" already means unfiltered.
  const applFn = CODE.slice(CODE.indexOf('function getScheduleApplicants('),
                            CODE.indexOf('const SCHED_PDF_FONTS'));
  check("the server still treats an empty 入学期 as no filter",
    /if \(want !== "" && iCol >= 0 &&/.test(applFn),
    "the client now always sends \"\"; drop this and every suggestion disappears");
  check("...and 不合格 is still excluded",
    /=== "不合格"\) continue;/.test(applFn), "");
  // Transcribed: the filter with want === "" must pass everything through.
  function keep(want, rowIntake) { return !(want !== "" && rowIntake !== want); }
  check("\"\" keeps every intake", keep("", "2026年4月生") && keep("", ""), "");
  check("...while a named one still narrows",
    keep("2026年4月生", "2026年4月生") && !keep("2026年4月生", "2026年10月生"), "");

  check("the template still records an intake field, now constant",
    /\{ name: name, intake: "", body: body \}/.test(HTML),
    "the column stays so Schedule_Templates keeps its shape");

  // ---- the font map --------------------------------------------------------
  // ⚠️ Only the scripts the server CANNOT render. 日本語 survives on a CJK fallback and
  // Noto Sans JP is ~5MB — embedding it would cost the most and buy the least.
  const fontBlock = CODE.slice(CODE.indexOf('const SCHED_PDF_FONTS'),
                               CODE.indexOf('function downloadSchedulePdf('));
  const MAP = { "ネパール語": "Noto Sans Devanagari", "ミャンマー語": "Noto Sans Myanmar",
                "シンハラ語": "Noto Sans Sinhala" };
  Object.keys(MAP).forEach(function (L) {
    check("the map covers " + L,
      new RegExp('"' + L + '":\\s*"' + MAP[L] + '"').test(fontBlock), "");
  });
  check("...and embeds NOTHING for 日本語 or English",
    !/日本語"\s*:/.test(fontBlock) && !/"English"\s*:/.test(fontBlock)
      && !/Noto Sans JP/.test(fontBlock),
    "Noto Sans JP is ~5MB and the CJK fallback already renders it");
  check("...so a language with no entry does no fetch at all",
    /if \(!family\) return "";/.test(fontBlock),
    "an unconditional fetch would put seconds on every English export");

  // Transcribed: which languages trigger a fetch.
  const needsFont = L => Object.prototype.hasOwnProperty.call(MAP, L);
  check("only the three non-Latin scripts pull a font",
    needsFont("ネパール語") && needsFont("ミャンマー語") && needsFont("シンハラ語")
      && !needsFont("日本語") && !needsFont("English") && !needsFont("ベトナム語")
      && !needsFont("インドネシア語") && !needsFont("中国語"), "");

  // ⚠️ TTF, not woff2 — the converter is old, and silently embedding a format it
  // drops produces exactly the box-filled page this route exists to avoid.
  check("the font is requested as TTF via the v1 endpoint",
    /fonts\.googleapis\.com\/css\?family=/.test(fontBlock)
      && !/css2\?family=/.test(fontBlock), "");
  check("...and a non-TTF url is rejected rather than embedded",
    /\\.ttf\)\\\)\/\)/.test(fontBlock) || /\.ttf\)\\\)/.test(fontBlock)
      || /m = css\.match/.test(fontBlock) && /\.ttf/.test(fontBlock), "");
  // ⚠️ THROW, don't degrade. Boxes on a student's schedule is the failure this
  // whole feature was designed around.
  check("a missing font throws instead of returning a PDF of boxes",
    (fontBlock.match(/throw new Error\("この言語のフォントを取得できませんでした/g) || []).length === 2,
    "both the css lookup and the file fetch must fail loudly");
  check("...with an instruction and no AREA code, since the user can retry",
    /時間をおいて再度お試しください/.test(fontBlock) && !/AREA-/.test(fontBlock), "");
  check("the face is injected as a data: URI, needing no fetch from the converter",
    /src:url\(data:font\/ttf;base64,/.test(fontBlock),
    "a network url is exactly what the server ignores");

  // ---- the endpoint --------------------------------------------------------
  const pdfFn = CODE.slice(CODE.indexOf('function downloadSchedulePdf('),
                           CODE.indexOf('function downloadSchedulePdf(') + 1600);
  check("downloadSchedulePdf guards on its first line",
    /^function downloadSchedulePdf\(role, perms, payload\) \{\s*\n\s*if \(!_hasPerm_\(role, perms, "view_student_schedule"\)\)/.test(pdfFn),
    "");
  check("...and is registered in _apiMethods_",
    /\sdownloadSchedulePdf: downloadSchedulePdf,/.test(CODE), "an unregistered endpoint is unreachable");
  check("...and does NOT rebuild the html server-side",
    /payload && payload\.html/.test(pdfFn) && !/sched-date/.test(pdfFn),
    "a second copy of schedBuildHtml drifts on the first layout change");
  // ⚠️ A passport name is free text and reaches a filename.
  check("the filename strips path and reserved characters",
    /replace\(\/\[\\\\\\\\\\\\\/:\*\?"<>\|\]\/g, ""\)/.test(pdfFn) || /replace\(\/\[/.test(pdfFn) && /\]\/g, ""\)/.test(pdfFn),
    "a name containing / breaks the download outright");
  check("...and falls back to a name rather than an empty one",
    /if \(base === ""\) base = "入寮時渡すスケジュール";/.test(pdfFn), "");
  // Transcribed, because a passport name is free text and a "/" in it breaks the
  // download rather than merely looking odd.
  function fileBase(n) {
    let b = String(n || "").replace(/[\\\/:*?"<>|]/g, "").trim();
    return (b === "" ? "入寮時渡すスケジュール" : b) + ".pdf";
  }
  check("a name with a path separator is stripped, not passed through",
    fileBase("SAMPLE/RIVERA") === "SAMPLERIVERA.pdf", fileBase("SAMPLE/RIVERA"));
  check("...and the other reserved characters with it",
    fileBase('A:B*C?"<>|') === "ABC.pdf", fileBase('A:B*C?"<>|'));
  check("...while an ordinary name is untouched, spaces included",
    fileBase("丁村 太郎") === "丁村 太郎.pdf", "");
  check("...and an empty or whitespace name still yields a usable file",
    fileBase("") === "入寮時渡すスケジュール.pdf" && fileBase("   ") === "入寮時渡すスケジュール.pdf", "");
  check("...and the reply is the shape downloadBase64Pdf already takes",
    /return \{ base64: Utilities\.base64Encode\(pdfBlob\.getBytes\(\)\), fileName: fileName \};/.test(pdfFn), "");

  // ---- the client ----------------------------------------------------------
  const dlFn = HTML.slice(HTML.indexOf('function schedDownloadPdf()'),
                          HTML.indexOf('function schedSaveTemplate()'));
  check("the button exists and calls it",
    /id="btnSchedPdf"/.test(HTML) && /onclick="schedDownloadPdf\(\)"/.test(HTML), "");
  // ⚠️ #view-dorms .schedule-btn:has(> .btn-label) clips to icon-only on mobile. A
  // label span with no SVG is an anonymous square; an SVG with no rule is a WIDER
  // button. Every button in this sub-view carries neither.
  check("...and carries neither a .btn-label nor an icon, like its neighbours",
    !/id="btnSchedPdf"[^>]*>[^<]*<svg/.test(HTML)
      && !/id="btnSchedPdf"[\s\S]{0,200}?btn-label/.test(HTML),
    "a label span without an icon renders an anonymous square here");
  check("the print button is still there and separate",
    /onclick="schedPrint\(\)">印刷</.test(HTML), "");
  check("the download reuses the shared helper rather than a second downloader",
    /downloadBase64Pdf\(res\.base64, res\.fileName\)/.test(dlFn)
      && !/createObjectURL/.test(dlFn), "");
  // ⚠️ Seconds, not milliseconds — and _setBtnLabel, never innerText.
  check("the button says it is working, and restores either way",
    /_setBtnLabel\(btn, "作成中\.\.\."\)/.test(dlFn)
      && (dlFn.match(/restore\(\);/g) || []).length === 2,
    "success and failure must both put the label back");
  // ⚠️ Comments stripped first — the rule is named in the comment above the code it
  // governs, and a raw scan reports that as a violation (mobile.test.js §5 hit this).
  const dlCode = dlFn.replace(/\/\/[^\n]*/g, "");
  check("...via the label helpers, never innerText",
    /_getBtnLabel\(btn\)/.test(dlCode) && !/innerText/.test(dlCode),
    "innerText deletes an icon if this button ever gains one");
  check("...and sends the same html the preview and the print window use",
    /html: schedBuildHtml\(\)/.test(dlFn),
    "rebuilding it anywhere else is how the two outputs drift");
  check("...along with the language, which is what selects the font",
    /lang: document\.getElementById\('schedLang'\)\.value/.test(dlFn), "");
}


console.log("\n10. 部屋 — which room the student is moving into");
{
  // ⚠️ WHY. The sheet told a student which day, which campus and what to bring, and
  // never which room — the one thing somebody arriving at a dorm most needs.
  //
  // The two controls are TYPE-AND-SEARCH inputs over 寮管理's own lists. A <datalist> is
  // a suggestion list and never a constraint — the browser accepts anything typed — so
  // the "no room that does not exist reaches a student" guarantee is held by RESOLUTION:
  // nothing prints unless both halves resolve to a real building and a real room. That
  // is the property most of this section exists to pin.

  // ---- transcribed from Index.html ----------------------------------------
  function normName(v) {
    let x = String(v == null ? "" : v);
    x = x.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    x = x.replace(/[\s　 ]/g, "");
    return x.toLowerCase().trim();
  }
  function buildingOptions(buildings) {
    const seen = {};
    buildings.forEach(b => {
      const n = String(b.nameJp || b.nameEn || b.id || "").trim();
      if (n !== "") seen[n] = (seen[n] || 0) + 1;
    });
    const out = [];
    buildings.forEach(b => {
      const id = String(b.id == null ? "" : b.id).trim();
      const n = String(b.nameJp || b.nameEn || id).trim();
      if (id === "" || n === "") return;
      out.push({ label: seen[n] > 1 ? (n + " (" + id + ")") : n, b: b });
    });
    return out;
  }
  function resolveBuilding(buildings, text) {
    const v = String(text || "").trim();
    if (v === "") return null;
    const hit = buildingOptions(buildings).filter(o => o.label === v)[0];
    return hit ? hit.b : null;
  }
  function roomsOf(rooms, b) {
    if (!b) return [];
    const bid = String(b.id == null ? "" : b.id).trim();
    const out = rooms.filter(r =>
      bid !== "" && String(r.building == null ? "" : r.building).trim() === bid);
    out.sort((x, y) => String(x.roomNumber)
      .localeCompare(String(y.roomNumber), undefined, { numeric: true }));
    return out;
  }
  function resolveRoom(buildings, rooms, bText, rText) {
    const v = String(rText || "").trim();
    if (v === "") return null;
    return roomsOf(rooms, resolveBuilding(buildings, bText))
      .filter(r => String(r.roomNumber == null ? "" : r.roomNumber).trim() === v)[0] || null;
  }
  function roomOption(r) {
    const no = String(r.roomNumber == null ? "" : r.roomNumber).trim();
    const taken = !(r.status === "空室" || String(r.studentName || "").trim() === "");
    return { value: no, label: no + "（" + (taken ? "入居中" : "空室") + "）" };
  }
  function roomLines(buildings, rooms, bText, rText) {
    const b = resolveBuilding(buildings, bText);
    const r = resolveRoom(buildings, rooms, bText, rText);
    const empty = { ja: "", en: "" };
    if (!b || !r) return empty;
    const no = String(r.roomNumber == null ? "" : r.roomNumber).trim();
    const jaName = String(b.nameJp || b.nameEn || b.id).trim();
    const enName = String(b.nameEn || "").trim();
    return {
      ja: jaName + " " + no + "号室",
      en: (enName && enName !== jaName) ? (enName + " Room " + no) : ""
    };
  }
  // The emitted header, exactly as schedBuildHtml assembles it.
  function header(title, name, room) {
    let body = "";
    if (room.ja) body += '<div class="sched-hdr">';
    if (name || title) body += '<p class="sched-name">' + ((title ? title + " " : "") + name) + '</p>';
    if (room.ja) body += '<p class="sched-room">' + (room.en ? (room.ja + " / " + room.en) : room.ja) + '</p></div>';
    return body;
  }
  // schedFlagBox, reduced to its decision.
  function flagged(text, ok, commit) {
    return !!(commit && String(text || "").trim() !== "" && !ok);
  }
  // schedAutoFillRoom, reduced to what it decides. null means "change nothing".
  function autoFill(buildings, rooms, nm, currentRoom) {
    if (currentRoom) return null;
    const want = normName(nm);
    if (!want) return null;
    const hits = rooms.filter(r => normName(r.studentName) === want);
    if (hits.length !== 1) return null;
    const bid = String(hits[0].building == null ? "" : hits[0].building).trim();
    const no = String(hits[0].roomNumber == null ? "" : hits[0].roomNumber).trim();
    if (bid === "" || no === "") return null;
    const opt = buildingOptions(buildings)
      .filter(o => String(o.b.id == null ? "" : o.b.id).trim() === bid)[0];
    if (!opt) return null;
    return { building: opt.label, room: no };
  }

  const BLDGS = [
    { id: "B012", nameJp: "中央寮", nameEn: "Central Dorm" },
    { id: "B003", nameJp: "北寮", nameEn: "" },              // no English name of its own
    { id: "B900", nameJp: "", nameEn: "Annex Only" },
    // ⚠️ Two buildings, one display name. Picking the first of these is the
    // two-recruiters-sharing-a-name bug class and would show the wrong rooms.
    { id: "B101", nameJp: "第一寮", nameEn: "First Dorm" },
    { id: "B102", nameJp: "第一寮", nameEn: "Dai-ichi Dorm" }
  ];
  const ROOMS = [
    { building: "B012", roomNumber: "9",   status: "空室",   studentName: "" },
    { building: "B012", roomNumber: "10",  status: "入居中", studentName: "サンプル 一郎" },
    { building: "B012", roomNumber: "201", status: "空室",   studentName: "" },
    { building: " B012 ", roomNumber: "202", status: "入居中", studentName: "SAMPLE RIVERA" },
    { building: "B003", roomNumber: "A2",  status: "空室",   studentName: "" },
    { building: "B003", roomNumber: "A1",  status: "入居中", studentName: "ＳＡＭＰＬＥ　ＲＩＶＥＲＡ" },
    // ⚠️ The case that separates 部屋一覧's rule from a naive `status !== "空室"`:
    // marked 入居中 with nobody in it. The nightly sync vacates a room by clearing the
    // tenant, so this state is real, and it must read as 空室.
    { building: "B900", roomNumber: "5",   status: "入居中", studentName: "" },
    { building: "B101", roomNumber: "1",   status: "空室",   studentName: "" },
    { building: "B102", roomNumber: "2",   status: "空室",   studentName: "" }
  ];

  // ---- the suggestion list -------------------------------------------------
  const OPTS = buildingOptions(BLDGS);
  check("a building is offered under its own name",
    OPTS.filter(o => o.label === "中央寮").length === 1
      && OPTS.filter(o => o.label === "Annex Only").length === 1,
    "a building with only an English name still has to be findable");
  // ⚠️ THE one that makes an exact-match lookup safe at all.
  check("⚠️ two buildings sharing a name BOTH gain their id, so no label repeats",
    OPTS.filter(o => o.label === "第一寮 (B101)").length === 1
      && OPTS.filter(o => o.label === "第一寮 (B102)").length === 1
      && new Set(OPTS.map(o => o.label)).size === OPTS.length,
    "an ambiguous label would resolve to whichever building came first");
  check("...and the id is added ONLY to the pair that collide",
    OPTS.filter(o => /\(B012\)/.test(o.label)).length === 0,
    "every building carrying an id would put noise in front of staff");

  // ---- resolution: the whole typo guarantee --------------------------------
  check("a complete name resolves",
    resolveBuilding(BLDGS, "中央寮").id === "B012", "");
  // ⚠️ A half-typed name is not a choice.
  check("⚠️ a PREFIX resolves to nothing, never to the building it starts",
    resolveBuilding(BLDGS, "中") === null && resolveBuilding(BLDGS, "中央") === null,
    "prefix matching would print a building nobody picked");
  check("...and an ambiguous name alone resolves to nothing",
    resolveBuilding(BLDGS, "第一寮") === null,
    "it is not a label any more — both carry their id");
  check("...while the disambiguated form resolves to the right one",
    resolveBuilding(BLDGS, "第一寮 (B102)").id === "B102", "");
  check("surrounding whitespace does not defeat a match",
    resolveBuilding(BLDGS, "  中央寮  ").id === "B012", "");
  check("an unknown name resolves to nothing",
    resolveBuilding(BLDGS, "ありません寮") === null && resolveBuilding(BLDGS, "") === null, "");
  check("a room resolves only within its own building",
    resolveRoom(BLDGS, ROOMS, "中央寮", "201").roomNumber === "201"
      && resolveRoom(BLDGS, ROOMS, "北寮", "201") === null,
    "a room number from the previous address must not survive a building change");
  check("...and the two same-named buildings keep their rooms apart",
    resolveRoom(BLDGS, ROOMS, "第一寮 (B101)", "1").building === "B101"
      && resolveRoom(BLDGS, ROOMS, "第一寮 (B101)", "2") === null, "");

  // ---- the printed line ----------------------------------------------------
  check("both halves print when the building has an English name",
    roomLines(BLDGS, ROOMS, "中央寮", "201").ja === "中央寮 201号室"
      && roomLines(BLDGS, ROOMS, "中央寮", "201").en === "Central Dorm Room 201", "");
  // ⚠️ Not「北寮 A1号室 / 北寮 Room A1」— an English line that is the Japanese name with
  // an English word bolted on reads worse than the Japanese line alone.
  check("...and the English half is DROPPED when it would only repeat the Japanese",
    roomLines(BLDGS, ROOMS, "北寮", "A1").ja === "北寮 A1号室"
      && roomLines(BLDGS, ROOMS, "北寮", "A1").en === "", "");
  check("a building with only an English name still prints, once",
    roomLines(BLDGS, ROOMS, "Annex Only", "5").ja === "Annex Only 5号室"
      && roomLines(BLDGS, ROOMS, "Annex Only", "5").en === "", "");
  // ⚠️ The id is an affordance for the search box; it has no business on a student's sheet.
  check("⚠️ the disambiguating id is NOT printed",
    roomLines(BLDGS, ROOMS, "第一寮 (B101)", "1").ja === "第一寮 1号室",
    "「第一寮 (B101) 1号室」 would hand a student an internal identifier");
  // ⚠️ THE property the whole design rests on: the widget cannot constrain the value,
  // so resolution has to.
  check("⚠️ a half-typed or mistyped box prints NOTHING, not something plausible",
    roomLines(BLDGS, ROOMS, "中", "201").ja === ""
      && roomLines(BLDGS, ROOMS, "中央寮", "999").ja === ""
      && roomLines(BLDGS, ROOMS, "ありません寮", "201").ja === ""
      && roomLines(BLDGS, ROOMS, "", "201").ja === ""
      && roomLines(BLDGS, ROOMS, "中央寮", "").ja === "",
    "a datalist is a suggestion list, never a constraint — resolution is the guarantee");

  // ---- ⚠️ the no-room sheet is byte-identical to before this existed --------
  const before = '<p class="sched-name">Mr. SAMPLE RIVERA</p>';
  check("⚠️ with no room the header is byte-identical to before rooms existed",
    header("Mr.", "SAMPLE RIVERA", { ja: "", en: "" }) === before,
    "the wrapper must be emitted ONLY when there is a room");
  check("...and an unresolved box falls back to exactly that same header",
    header("Mr.", "SAMPLE RIVERA", roomLines(BLDGS, ROOMS, "中", "201")) === before, "");
  check("...and with a room, the name and the room share a wrapper",
    header("Mr.", "SAMPLE RIVERA", roomLines(BLDGS, ROOMS, "中央寮", "201")) ===
      '<div class="sched-hdr">' + before +
      '<p class="sched-room">中央寮 201号室 / Central Dorm Room 201</p></div>', "");
  check("...and a nameless sheet with a room still closes its wrapper",
    header("", "", roomLines(BLDGS, ROOMS, "中央寮", "201")).indexOf('<div class="sched-hdr">') === 0
      && header("", "", roomLines(BLDGS, ROOMS, "中央寮", "201")).slice(-6) === "</div>", "");

  // ---- the room suggestions ------------------------------------------------
  check("rooms are joined to their building by TRIMMED id",
    roomsOf(ROOMS, BLDGS[0]).length === 4,
    "「 B012 」 must not orphan a room out of its own building");
  check("...sorted numerically, so 10 follows 9",
    roomsOf(ROOMS, BLDGS[0]).map(r => r.roomNumber).join(",") === "9,10,201,202",
    "a plain string sort puts 10 before 9");
  check("an unresolved building offers no rooms rather than every room",
    roomsOf(ROOMS, null).length === 0, "");
  check("the occupancy hint matches 部屋一覧's own rule",
    roomOption(ROOMS[0]).label === "9（空室）" && roomOption(ROOMS[1]).label === "10（入居中）", "");
  check("...⚠️ including 入居中 with no tenant, which reads as 空室",
    roomOption(ROOMS[6]).label === "5（空室）",
    "a naive `status !== 空室` disagrees with 部屋一覧 here");
  // ⚠️ THE one that matters: in a datalist the VALUE is what gets typed into the box.
  check("⚠️ the option VALUE is the bare room number; the status is only a label",
    ROOMS.every(r => roomOption(r).value.indexOf("（") === -1),
    "「201（空室）」 as a value types itself into the field and onto the sheet");
  check("...and that value is what the printed line is built from",
    roomLines(BLDGS, ROOMS, "中央寮", roomOption(ROOMS[2]).value).ja === "中央寮 201号室", "");

  // ---- the red flag --------------------------------------------------------
  check("an unresolved value is flagged once committed",
    flagged("中", false, true) === true, "");
  // ⚠️ Flagging from oninput paints the box red on every keystroke of a name that is
  // merely unfinished.
  check("⚠️ ...but never while it is still being typed",
    flagged("中", false, false) === false, "");
  check("an empty box is never flagged",
    flagged("", false, true) === false && flagged("   ", false, true) === false,
    "an empty room is a valid sheet, not an error");
  check("a resolved value is never flagged",
    flagged("中央寮", true, true) === false, "");

  // ---- auto-fill -----------------------------------------------------------
  check("one match fills the room",
    JSON.stringify(autoFill(BLDGS, ROOMS, "サンプル 一郎", "")) ===
      JSON.stringify({ building: "中央寮", room: "10" }), "");
  check("...matching through normName, so width and spacing do not matter",
    JSON.stringify(autoFill(BLDGS, [ROOMS[5]], "sample  rivera", "")) ===
      JSON.stringify({ building: "北寮", room: "A1" }),
    "full-width and stray spaces are this file's oldest bug class");
  // ⚠️ It writes the LABEL, so what it fills in is a value the box can resolve again.
  check("⚠️ ...and it writes the disambiguated label where one is needed",
    JSON.stringify(autoFill(BLDGS, [{ building: "B102", roomNumber: "2", studentName: "X" }], "X", "")) ===
      JSON.stringify({ building: "第一寮 (B102)", room: "2" }),
    "filling 「第一寮」 alone would leave the box red and print nothing");
  // ⚠️ ROOMS has SAMPLE RIVERA twice — once half-width, once full-width, in two buildings.
  check("⚠️ TWO matches fill nothing at all",
    autoFill(BLDGS, ROOMS, "SAMPLE RIVERA", "") === null,
    "an ambiguous name must never resolve to one of its candidates");
  check("no match fills nothing, and says nothing",
    autoFill(BLDGS, ROOMS, "SAMPLE STUDENT", "") === null,
    "these students are not in 学生一覧 yet — finding nothing is the NORMAL case");
  // ⚠️ This runs from oninput, i.e. on every keystroke.
  check("⚠️ a room already chosen is never overwritten",
    autoFill(BLDGS, ROOMS, "サンプル 一郎", "999") === null,
    "oninput would otherwise stomp a manual choice mid-typing");
  check("an empty name fills nothing",
    autoFill(BLDGS, ROOMS, "", "") === null && autoFill(BLDGS, ROOMS, "   ", "") === null, "");

  // ---- bound to the source -------------------------------------------------
  check("the two controls are typeable inputs backed by suggestion lists",
    /<input type="text" id="schedBuilding"[^>]*list="schedBuildingList"/.test(HTML)
      && /<input type="text" id="schedRoom"[^>]*list="schedRoomList"/.test(HTML)
      && /<datalist id="schedBuildingList">/.test(HTML)
      && /<datalist id="schedRoomList">/.test(HTML), "");
  check("...and neither is a <select> any more",
    !/<select id="schedBuilding"/.test(HTML) && !/<select id="schedRoom"/.test(HTML), "");
  // ⚠️ One flex item holding both halves. The outer row wraps; the PAIR must not.
  // ⚠️ HTML comments stripped first. The comment above this markup NAMES the rule it is
  // explaining ("flex-wrap:nowrap"), so a raw scan passes even with the markup mutated to
  // wrap — mutation-tested against exactly that. Third time this file has hit the trap;
  // see the note on schedLoadFn in §9 and mobile.test.js §5.
  const pair = HTML.slice(HTML.indexOf('id="schedLang"'),
                          HTML.indexOf('<datalist id="schedBuildingList">'))
                   .replace(/<!--[\s\S]*?-->/g, "");
  check("⚠️ the two boxes sit in one nowrap flex item, so they never separate",
    /flex-wrap:nowrap/.test(pair) && (pair.match(/id="schedBuilding"/g) || []).length === 1
      && (pair.match(/id="schedRoom"/g) || []).length === 1,
    "the outer row's flex-wrap would otherwise split an address across two lines");
  check("...and both halves carry min-width:0 so a long name truncates",
    (pair.match(/flex:1 1 0; min-width:0/g) || []).length === 2,
    "a flex item defaults to min-width:auto — its CONTENT width — and pushes the pair wide");
  const fillFn = HTML.slice(HTML.indexOf('function schedFillRooms()'),
                            HTML.indexOf('function schedFillRoomList()'));
  // ⚠️ Building names are staff-entered sheet data reaching innerHTML. xss.test.js does
  // NOT cover this site — its §3 regex cannot see a string literal containing the other
  // quote character, which is how every attribute in this file is built — so the escaping
  // has to be asserted here.
  check("the building suggestion is escaped",
    /escAttrJs\(o\.label\)/.test(fillFn),
    "an unescaped 建物名 reaches innerHTML, and xss.test.js §3 cannot see this shape");
  const optFn = HTML.slice(HTML.indexOf('function schedBuildingOptions()'),
                           HTML.indexOf('function schedResolveBuilding()'));
  check("the source disambiguates a repeated display name with the id",
    /seen\[n\] > 1 \? \(n \+ " \(" \+ id \+ "\)"\) : n/.test(optFn), "");
  const resFn = HTML.slice(HTML.indexOf('function schedResolveBuilding()'),
                           HTML.indexOf('function schedRoomsOf('));
  check("...and resolves by EXACT label, never a prefix",
    /o\.label === v/.test(resFn) && !/indexOf\(v\)/.test(resFn), "");
  const roomsFn = HTML.slice(HTML.indexOf('function schedRoomsOf('),
                             HTML.indexOf('function schedResolveRoom()'));
  check("the source joins on a TRIMMED building id",
    /String\(r\.building == null \? "" : r\.building\)\.trim\(\) === bid/.test(roomsFn), "");
  check("...and sorts numerically",
    /localeCompare\(String\(y\.roomNumber\), undefined, \{ numeric: true \}\)/.test(roomsFn), "");
  const listFn = HTML.slice(HTML.indexOf('function schedFillRoomList()'),
                            HTML.indexOf('function schedFlagBox('));
  check("the source's occupancy rule is 部屋一覧's",
    /r\.status === "空室" \|\| String\(r\.studentName \|\| ""\)\.trim\(\) === ""/.test(listFn), "");
  // ⚠️ value = bare number, status in the label ATTRIBUTE.
  check("⚠️ the source puts the status in label=, never in the option's value",
    /value="' \+ escAttrJs\(no\) \+ '" label="'/.test(listFn), "");
  const flagFn = HTML.slice(HTML.indexOf('function schedFlagBox('),
                            HTML.indexOf('function schedBuildingPicked('));
  check("the source flags only on commit, and never an empty box",
    /commit && String\(el\.value \|\| ""\)\.trim\(\) !== "" && !ok/.test(flagFn), "");
  const autoFn = HTML.slice(HTML.indexOf('function schedAutoFillRoom('),
                            HTML.indexOf('// Name suggestions come from'));
  check("the source refuses to guess between two matches",
    /hits\.length !== 1\) return;/.test(autoFn), "");
  check("...and refuses to overwrite a chosen room",
    /if \(rEl\.value\) return;/.test(autoFn), "");
  check("...and matches through normName on both sides",
    /normName\(r\.studentName\) === want/.test(autoFn) && /normName\(nm\)/.test(autoFn), "");
  check("...and writes the resolvable label, not the raw id",
    /bEl\.value = opt\.label;/.test(autoFn),
    "writing the id would leave the box red and print nothing");
  const bldFn = HTML.slice(HTML.indexOf('function schedBuildHtml()'),
                           HTML.indexOf('function schedRender()'));
  check("the wrapper is emitted only when there is a room",
    (bldFn.match(/if \(room\.ja\)/g) || []).length === 2,
    "an unconditional wrapper changes every sheet that has no room");
  // ⚠️ The converter drops shorthands on the download path — that is how the yellow
  // date bar lost its background. Every rule added here is a longhand.
  check("the new rules use margin longhands, never the shorthand",
    /\.sched-hdr\{margin-top:0;margin-bottom:24px;\}/.test(bldFn)
      && /\.sched-room\{font-size:11pt;margin-top:0;margin-bottom:0;\}/.test(bldFn), "");
  check("...and .sched-name's own rule is left exactly as it was",
    /\.sched-name\{font-size:16pt;font-weight:700;margin:0 0 24px;\}/.test(bldFn),
    "changing it would move the spacing on every sheet already going out");
  // ⚠️ getDormData and schedLoad are independent async calls; whichever lands second
  // has to fill the suggestion lists, or opening the sub-tab fast leaves them empty.
  check("both racing loaders fill the suggestion lists",
    /schedFillTemplates\(\);[\s\S]{0,80}schedFillRooms\(\);/.test(HTML)
      && /window\._dormBuildings = data\.buildings \|\| \[\];[\s\S]{0,300}schedFillRooms\(\);/.test(HTML),
    "one alone leaves them empty depending on which request wins");
  check("the room is NOT saved into the template",
    !/schedRoom/.test(HTML.slice(HTML.indexOf('function schedSaveTemplate()'),
                                 HTML.indexOf('function schedLoadTemplate('))),
    "a room is per-student, like the name — templates carry blocks only");
}


console.log("\n11. 文言管理 queues its edits — typing must not be interrupted");
{
  // ⚠️ WHY. Every cell saved on `onchange`, and the success handler called
  // schedRenderPhrases(), which does host.innerHTML = h — rebuilding every <input>.
  // The rebuild landed ASYNCHRONOUSLY, a round trip later, by which time the user had
  // tabbed on and was typing into a field that then vanished.
  //
  // ⚠️ It is not a per-keystroke handler. Reading the source, "saves on change" looks
  // fine; the damage is the async FULL RE-RENDER. That is why the first checks here are
  // about what the handlers must NOT contain.

  const cellFn = HTML.slice(HTML.indexOf('function schedSavePhraseCell(el)'),
                            HTML.indexOf('function schedAddPhrase()'));
  const catFn = HTML.slice(HTML.indexOf('function schedSavePhraseCat(el)'),
                           HTML.indexOf('function schedSavePhraseCell(el)'));
  [['schedSavePhraseCell', cellFn], ['schedSavePhraseCat', catFn]].forEach(function (p) {
    check("⚠️ " + p[0] + " sends nothing", !/apiRun/.test(p[1]),
      "a round trip per committed cell is half the bug");
    check("⚠️ ...and renders nothing", !/schedRender/.test(p[1]),
      "the async rebuild is the other half — it destroys the field being typed into");
    check("..." + p[0] + " queues instead", /schedQueuePhrase\(p, el\)/.test(p[1]), "");
  });
  const dtFn = HTML.slice(HTML.indexOf('function schedSetDayTypeField('),
                          HTML.indexOf('function schedAppendDayTypeKey('));
  check("⚠️ the 種別 name/order fields queue too", !/apiRun/.test(dtFn) && !/schedRender/.test(dtFn),
    "the same handler shape, and the same problem while renaming a 種別");
  check("_schedSaveDayType is gone", !/function _schedSaveDayType/.test(HTML),
    "it existed only to save-and-rerender on every field change");

  // ---- the queue, transcribed ----------------------------------------------
  // Phrases key on キー — which is rendered as plain text, not an input, so it is a
  // stable id. 種別 are marked on the OBJECT: indices shift on delete, and the name is
  // editable, so neither can be the key.
  function makeQueue() { return { phrases: {}, delPhrases: {}, delDayTypes: {} }; }
  function count(q, dayTypes) {
    return Object.keys(q.phrases).length
         + dayTypes.filter(function (d) { return d && d._dirty; }).length
         + Object.keys(q.delPhrases).length
         + Object.keys(q.delDayTypes).length;
  }
  const q = makeQueue(), dts = [{ name: '手続き', _orig: '手続き' }, { name: '入学式', _orig: '入学式' }];
  const pA = { key: 'a', text: {} };
  q.phrases[pA.key] = pA; q.phrases[pA.key] = pA;   // two cells, same row
  check("⚠️ several cells in ONE row count as one pending change",
    count(q, dts) === 1,
    "the row is what goes to the server, so a per-field tally would overstate it");
  q.phrases['b'] = { key: 'b', text: {} };
  dts[0]._dirty = true;
  q.delPhrases['c'] = true;
  q.delDayTypes['旧種別'] = true;
  check("...and the four stores all count", count(q, dts) === 5, String(count(q, dts)));
  // ⚠️ Deleting a 種別 shifts every later index — an index-keyed queue then points at
  // the wrong row.
  dts.splice(0, 1);
  check("⚠️ a 種別 removal cannot corrupt the queue", count(q, dts) === 4,
    "the dirty flag lives on the object, so indices are free to move");

  // ---- the rename that used to append a duplicate --------------------------
  // Transcribed from saveSchedulePhrasesBatch's day-type row matching.
  function locate(rows, op) {
    const find = String(op.origName || op.name).trim();
    for (let i = 1; i < rows.length; i++) if (String(rows[i][0]).trim() === find) return i;
    return -1;
  }
  const sheet = [['種別名', '並び順', 'キー'], ['手続き', '1', 'a,b'], ['入学式', '3', 'c']];
  check("⚠️ a RENAME updates the existing row",
    locate(sheet, { origName: '手続き', name: '手続き2' }) === 1,
    "matching on the NEW name found nothing and appended a second 手続き row, leaving " +
    "the original behind — invisible until the next load");
  check("...matching on the new name alone would have appended",
    locate(sheet, { name: '手続き2' }) === -1,
    "if this finds a row, the bug being guarded was never real");
  check("an unrenamed type still updates in place",
    locate(sheet, { origName: '入学式', name: '入学式' }) === 2, "");
  check("a brand-new type appends", locate(sheet, { origName: '新種別', name: '新種別' }) === -1, "");
  check("the source locates by origName",
    /const find = String\(d\.origName \|\| name\)\.trim\(\);/.test(CODE), "");
  check("⚠️ ...and _orig is captured at LOAD, before anyone can edit the name",
    /schedDayTypes = \(res\.dayTypes \|\| \[\]\)\.map\(function \(d\) \{ d\._orig = d\.name; return d; \}\);/.test(HTML),
    "capturing it later would capture the edited name and reintroduce the append");

  // ---- markers, deletes, and the ways the queue can be lost ----------------
  // Exactly two call sites: the end of schedRenderPhrases and of schedRenderDayTypes.
  check("⚠️ both renders re-apply the markers",
    (HTML.match(/schedPaintDirty\(\);/g) || []).length === 2,
    "adding a phrase re-renders; without this it clears the amber from every other " +
    "queued cell and the user believes those saved");
  check("the delete cell carries the hook the painter strikes through",
    /data-delkey="' \+ escAttrJs\(p\.key\)/.test(HTML), "");
  const delFn = HTML.slice(HTML.indexOf('function schedDeletePhrase(key)'),
                           HTML.indexOf('function schedSaveAllPhrases()'));
  check("⚠️ deleting queues rather than sending", !/apiRun/.test(delFn)
      && /_schedDirty\.delPhrases\[key\] = true;/.test(delFn),
    "it must reach the sheet only via 保存, so closing without saving undoes it");
  check("...and the row stays on screen until then",
    !/schedPhrases = schedPhrases\.filter/.test(delFn),
    "removing it here would leave the queue describing a row nobody can see");
  // ⚠️ Adding a language adds a COLUMN and reloads the library.
  const langFn = HTML.slice(HTML.indexOf('function schedAddLanguage()'),
                            HTML.indexOf('function schedAddLanguage()') + 900);
  check("⚠️ 言語追加 refuses while the queue is dirty",
    /if \(schedDirtyCount\(\) > 0\)/.test(langFn),
    "it reloads everything, which would discard the queue without saying so");

  // ---- one trip, and the guarded close ------------------------------------
  const saveFn = HTML.slice(HTML.indexOf('function schedSaveAllPhrases()'),
                            HTML.indexOf('function closeSchedPhrases()'));
  check("保存 sends ONE batch", /\.saveSchedulePhrasesBatch\(/.test(saveFn)
      && (saveFn.match(/apiRun\(\)/g) || []).length === 1, "");
  check("...carrying all four stores",
    /phrases:/.test(saveFn) && /delPhrases:/.test(saveFn)
      && /dayTypes:/.test(saveFn) && /delDayTypes:/.test(saveFn), "");
  const closeFn = HTML.slice(HTML.indexOf('function closeSchedPhrases()'),
                             HTML.indexOf('function schedAddLanguage()'));
  // ⚠️ The CONDITION, not just the presence of the words. `if (false && !confirm(...))`
  // keeps both strings and warns nobody.
  check("⚠️ closing warns before discarding",
    /const n = schedDirtyCount\(\);/.test(closeFn)
      && /if \(n > 0 && !confirm\(/.test(closeFn), "");
  // ⚠️ Esc closes modals since v173; without this entry a keypress discards the queue.
  check("⚠️ ...and Esc goes through the same closer",
    /'schedPhraseModal': function\(\) \{ closeSchedPhrases\(\); \}/.test(HTML),
    "otherwise one Escape throws the whole queue away with no warning");

  // ---- the endpoint --------------------------------------------------------
  const batch = CODE.slice(CODE.indexOf('function saveSchedulePhrasesBatch('),
                           CODE.indexOf('function deleteScheduleDayType('));
  check("the batch is permission-guarded like its siblings",
    /_hasPerm_\(role, perms, "manage_student_schedule"\)/.test(batch), "");
  check("⚠️ every write goes through _cellSafeRow_",
    (batch.match(/_cellSafeRow_\(/g) || []).length === 2
      && !/setValues\(\[\[/.test(batch),
    "free text reaching a sheet unwrapped is the formula-injection hole");
  check("⚠️ deletes are applied before upserts",
    batch.indexOf('sh.deleteRow(i + 1); out.deleted++;') < batch.indexOf('out.phrases++;'),
    "a row deleted and re-added in one session must end as an add");
  // ⚠️ …and the delete branches are actually reachable. Textual order alone still holds
  // when the branch is disabled, which is how `if (false)` slipped past this once.
  check("...and each delete branch is guarded by its own list",
    /if \(delP\.length\) \{/.test(batch) && /if \(delD\.length\) \{/.test(batch),
    "a constant condition leaves the ordering intact and the deletes unreachable");
  // 4 = the initial `let data =` read plus the post-delete re-read, for each sheet.
  check("...and the row data is re-read after deleting",
    (batch.match(/data = sh\.getDataRange\(\)\.getDisplayValues\(\);/g) || []).length === 4,
    "deleteRow shifts every row number below it");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
