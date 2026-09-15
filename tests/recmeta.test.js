// 募集状況's country list is per-入学期.
//
// ⚠️ WHY. Recruitment_Meta stored countries as 種別/値/地域/並び順 with NO intake column, so
// _recruitMetaLists_ collected them into ONE list and getRecruitmentBundle handed that same
// list to every intake. Pruning one intake's grid pruned every other intake's — reported as
// "the countries shouldn't share across the intakes … users need to delete some countries
// for some intakes to make space for other countries". recDeleteCountry's own comment even
// described the behaviour ("would remove it from every intake's grid") as a caution.
//
// The rule is now: blank 入学期 = every intake (which is what every pre-existing row is, so
// day one needed no migration), set 入学期 = that intake alone.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'Code.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
// ⚠️ Comments stripped before any source scan: the comments here quote the very shapes
// being banned. Ninth time in this repo.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- transcribed from Code.js ---------------------------------------------
function _recIntakeSortKey_(s) {
  const m = String(s || "").match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  return m ? (parseInt(m[1], 10) * 100 + parseInt(m[2], 10)) : -1;
}
function _recCountriesFor_(rows, intake) {
  const want = String(intake == null ? "" : intake).trim();
  let region = {}, out = [], seen = {};
  (rows || []).forEach(function (r) { if (r.region && !region[r.name]) region[r.name] = r.region; });
  (rows || []).forEach(function (r) {
    if (r.intake !== "" && r.intake !== want) return;
    if (seen[r.name]) return;
    seen[r.name] = 1;
    out.push({ name: r.name, region: region[r.name] || "" });
  });
  return out;
}
// The materialisation, as a pure function over rows so it can be exercised here.
function materialise(rows, intakes) {
  const legacy = rows.filter(r => r.intake === "");
  if (!legacy.length) return rows.slice();
  const have = {};
  rows.forEach(r => { if (r.intake !== "") have[r.name + " " + r.intake] = 1; });
  const out = rows.filter(r => r.intake !== "");
  legacy.forEach(l => intakes.forEach(it => {
    const k = l.name + " " + it;
    if (have[k]) return;
    have[k] = 1;
    out.push({ name: l.name, region: l.region, intake: it });
  }));
  return out;
}
const names = list => list.map(c => c.name);

const A = '2026年4月生', B = '2026年10月生', C = '2027年4月生';

console.log("\n1. a blank 入学期 belongs to EVERY intake — the day-one guarantee");
{
  // Exactly the shape of every row written before the column existed.
  const legacy = [
    { name: 'ネパール',   region: '南アジア', intake: '' },
    { name: 'ミャンマー', region: 'アジア',   intake: '' },
    { name: 'ベトナム',   region: 'アジア',   intake: '' },
  ];
  [A, B, C].forEach(function (it) {
    check(it + " sees the whole legacy list",
      eq(names(_recCountriesFor_(legacy, it)), ['ネパール', 'ミャンマー', 'ベトナム']),
      JSON.stringify(names(_recCountriesFor_(legacy, it))));
  });
  check("⚠️ so nothing had to be migrated on day one",
    eq(_recCountriesFor_(legacy, A), _recCountriesFor_(legacy, C)),
    "if these ever differ, an existing intake silently lost countries at deploy time");
}

console.log("\n2. an explicit 入学期 belongs to that intake ALONE — the reported bug");
{
  const rows = [
    { name: 'ネパール',   region: '南アジア', intake: A },
    { name: 'ミャンマー', region: 'アジア',   intake: A },
    { name: 'ネパール',   region: '南アジア', intake: B },
  ];
  check("A keeps both", eq(names(_recCountriesFor_(rows, A)), ['ネパール', 'ミャンマー']), "");
  check("⚠️ B does NOT see A's ミャンマー", eq(names(_recCountriesFor_(rows, B)), ['ネパール']),
    "this is the whole point: one intake's list is not another's");
  check("an intake with no rows of its own is empty",
    eq(names(_recCountriesFor_(rows, C)), []), "");

  // ⚠️ The reported operation, asserted directly.
  const afterDelete = rows.filter(r => !(r.name === 'ミャンマー' && r.intake === A));
  check("⚠️ deleting from A leaves B untouched",
    eq(names(_recCountriesFor_(afterDelete, A)), ['ネパール']) &&
    eq(names(_recCountriesFor_(afterDelete, B)), ['ネパール']), "");
}

console.log("\n3. mixed legacy + explicit, and materialisation");
{
  const rows = [
    { name: 'ネパール',   region: '南アジア', intake: '' },
    { name: 'ミャンマー', region: 'アジア',   intake: '' },
    { name: 'ラオス',     region: 'アジア',   intake: B },
  ];
  check("a legacy row and an explicit one both show for B",
    eq(names(_recCountriesFor_(rows, B)).sort(), ['ネパール', 'ミャンマー', 'ラオス'].sort()), "");
  check("...and A sees only the legacy pair",
    eq(names(_recCountriesFor_(rows, A)), ['ネパール', 'ミャンマー']), "");

  const m = materialise(rows, [A, B, C]);
  check("⚠️ materialisation leaves NO blank row",
    m.every(r => r.intake !== ""), "a surviving blank row is still shared");
  // ⚠️ THE property that makes the change safe: expanding changes nothing anyone can see.
  [A, B, C].forEach(function (it) {
    check("...and " + it + "'s effective list is unchanged by it",
      eq(names(_recCountriesFor_(rows, it)).sort(), names(_recCountriesFor_(m, it)).sort()),
      JSON.stringify([names(_recCountriesFor_(rows, it)), names(_recCountriesFor_(m, it))]));
  });
  check("...and it does not duplicate a pair that already existed",
    m.filter(r => r.name === 'ラオス' && r.intake === B).length === 1, "");
  check("...and it is idempotent",
    eq(materialise(m, [A, B, C]), m), "a second run must be a no-op");
  // After expanding, a per-intake delete finally works on a formerly-legacy country.
  const afterDelete = m.filter(r => !(r.name === 'ネパール' && r.intake === B));
  check("⚠️ a formerly-legacy country can now be deleted from ONE intake",
    names(_recCountriesFor_(afterDelete, B)).indexOf('ネパール') === -1 &&
    names(_recCountriesFor_(afterDelete, A)).indexOf('ネパール') !== -1, "");
}

console.log("\n4. 地域 resolves per NAME, never per row");
{
  // Per-intake rows each carry a 地域 cell, so they can disagree.
  const rows = [
    { name: 'ネパール', region: '南アジア', intake: A },
    { name: 'ネパール', region: '欧米・その他', intake: B },
  ];
  check("⚠️ the same country groups the same way in every intake",
    _recCountriesFor_(rows, A)[0].region === _recCountriesFor_(rows, B)[0].region,
    "the grid groups by 地域 — two answers means the row moves when you switch intake");
  const blankFirst = [
    { name: 'タイ', region: '', intake: A },
    { name: 'タイ', region: 'アジア', intake: B },
  ];
  check("...and an empty cell does not win over a filled one",
    _recCountriesFor_(blankFirst, A)[0].region === 'アジア', "first NON-EMPTY, not first");
}

console.log("\n5. a new intake copies the NEWEST existing one");
{
  // ⚠️ 「2026年10月生」 sorts BEFORE 「2026年4月生」 as text. Half the time, a lexicographic
  // pick seeds the new intake from the wrong list.
  check("10月 is newer than 4月 of the same year",
    _recIntakeSortKey_(B) > _recIntakeSortKey_(A), B + " vs " + A);
  check("...which a plain text compare gets WRONG",
    String(B).localeCompare(String(A), "ja") < 0,
    "if this ever stops being true the lexicographic trap is gone and the note can go");
  check("a year rolls over correctly", _recIntakeSortKey_(C) > _recIntakeSortKey_(B), "");
  check("an unparseable name sorts last", _recIntakeSortKey_('未定') === -1, "");

  const rows = [
    { name: 'ネパール', region: '南アジア', intake: A },
    { name: 'ラオス',   region: 'アジア',   intake: B },
  ];
  let src = "";
  rows.forEach(function (r) {
    if (r.intake === "" || r.intake === C) return;
    if (src === "" || _recIntakeSortKey_(r.intake) > _recIntakeSortKey_(src)) src = r.intake;
  });
  check("⚠️ seeds from " + B + ", not " + A, src === B, "picked " + src);
  check("...and copies that intake's list",
    eq(names(_recCountriesFor_(rows, src)), ['ラオス']), "");
}

console.log("\n6. the source still matches what is transcribed above");
{
  check("⚠️ ONE effective-list rule", (CODE.match(/function _recCountriesFor_\(/g) || []).length === 1,
    "a second copy is how one screen starts disagreeing with another about a country's intake");
  check("...and it is what the bundle sends",
    /addedCountries: _recCountriesFor_\(meta\.countries, want\)/.test(CODE),
    "⚠️ `want`, not the raw argument — a blank intake resolves to the newest one first");
  check("⚠️ countries are NOT deduped by name when read",
    /return x\.name === v && x\.intake === it;/.test(CODE),
    "deduping by name alone is exactly what made one list serve every intake");
  check("⚠️ ONE intake sort key", (CODE.match(/function _recIntakeSortKey_\(/g) || []).length === 1,
    "it was written out twice before; a third copy eventually disagrees about 'newest'");

  check("⚠️ the batched meta range reaches column E",
    /sheet: SHEET_RECRUIT_META,\s*a1: 'A:E', cols: 5/.test(CODE),
    "batchGet truncates to the range — a short one hands back undefined for every 入学期, " +
    "every row then looks legacy, and the whole feature silently does nothing");
  check("...and the sheet header has five columns",
    /appendRow\(\["種別", "値", "地域", "並び順", "入学期"\]\)/.test(CODE), "");

  // ⚠️ Slice a function by NAME to the next top-level `function`, never by a guessed pair of
  // anchors: the first version of this check bounded getRecruitmentBundle with a function
  // declared EARLIER in the file, so the slice was empty and the assertion passed vacuously.
  function bodyOf(name) {
    const i = CODE.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = CODE.indexOf('\nfunction ', i + 1);
    return CODE.slice(i, j < 0 ? CODE.length : j);
  }
  const readers = ['getRecruitmentData', 'getRecruitmentBundle', 'getRecruitmentContext',
                   '_recruitMetaLists_', '_recCountriesFor_'];
  check("the read functions were located",
    readers.every(function (n) { return bodyOf(n).length > 100; }),
    readers.map(function (n) { return n + ':' + bodyOf(n).length; }).join(' '));
  // ⚠️ Pinned on the PROPERTY, not on the call's exact text. The first version quoted the
  // literal `_recMaterialiseLegacyCountries_(sh);` and broke the moment the call started
  // threading rows through it — a test that fails on a refactor it does not care about gets
  // loosened in a hurry, and loosened is how it stops catching the thing it was written for.
  const mCalls = (CODE.match(/_recMaterialiseLegacyCountries_\(/g) || []).length;
  check("⚠️ materialisation is called from the WRITE paths only",
    mCalls === 3 && readers.every(function (n) { return !/_recMaterialiseLegacyCountries_/.test(bodyOf(n)); }),
    "found " + mCalls + " mentions (want 1 definition + 2 calls) — getRecruitmentBundle runs " +
    "for anyone with view_recruitment, and a write from a read is refused or lands under the " +
    "wrong caller");
  check("...and both callers are the permission-gated meta writers",
    /_recMaterialiseLegacyCountries_/.test(bodyOf('addRecruitmentMeta'))
      && /_recMaterialiseLegacyCountries_/.test(bodyOf('removeRecruitmentMeta')),
    "");
  check("⚠️ it enumerates the FULL intake list",
    /function _recAllIntakes_\(\)/.test(CODE) && /_recruitIntakeList_\(data, cData\)/.test(CODE)
      && /const intakes = _recAllIntakes_\(\);/.test(CODE),
    "meta's own intake rows miss an intake that exists only because numbers were entered");
  check("...and deletes the legacy rows bottom-up",
    /\.sort\(function \(a, b\) \{ return b - a; \}\)/.test(CODE),
    "deleteRow shifts every row below it");
  check("...after a snapshot", /_snapshotSheet_\(SHEET_RECRUIT_META\)/.test(CODE), "");

  check("⚠️ a country with no intake is REFUSED, not written blank",
    (CODE.match(/if \(k === "country" && it === ""\) throw new Error/g) || []).length === 2,
    "a blank row belongs to every intake and cannot be removed from any single one — " +
    "both the add and the delete path must refuse");
  check("...and the client refuses first",
    (HTML.match(/先に入学期を選んでください。/g) || []).length >= 2, "");

  check("⚠️ 国名 reaches the sheet through _cellSafeRow_",
    /sh\.appendRow\(_cellSafeRow_\(\[k, v, rg, "", \(k === "country"\) \? it : ""\]\)\)/.test(CODE),
    "a country named =IMPORTXML(...) ran as a FORMULA — pre-existing, fixed at this write site");
  check("⚠️ the delete matches on the intake as well as the name",
    /if \(k === "country" && String\(data\[i\]\[4\] \|\| ""\)\.trim\(\) !== it\) continue;\s*\n\s*hits\.push\(i\);/.test(CODE),
    "matching the name alone removes the country from every intake — the reported bug");
  check("⚠️ a duplicate is judged within one intake",
    /if \(k === "country" && String\(data\[i\]\[4\] \|\| ""\)\.trim\(\) !== it\) continue;\s*\n\s*if \(k === "country" && rg\)/.test(CODE),
    "judged across intakes, adding a country to a second intake is silently a no-op");
  check("⚠️ a new intake is seeded", /_recSeedIntakeCountries_\(sh, v\)/.test(CODE)
      && /_recIntakeSortKey_\(r\.intake\) > _recIntakeSortKey_\(src\)/.test(CODE),
    "without the sort key it seeds from whichever row came first");

  const cli = HTML.slice(HTML.indexOf('function recSubmitCountry'),
                         HTML.indexOf('function renderPastInterviewsTable'));
  check("⚠️ the client sends the intake on add",
    /"country", v, currentUser\.name, currentUser\.id, region, intake\)/.test(cli), "");
  check("...and on delete",
    /"country", name, currentUser\.name, currentUser\.id, intake\)/.test(HTML), "");
  check("⚠️ the 国名設定 modal names the intake it edits",
    /id="recCountryModalTitle"/.test(HTML) && /'国名設定' \+ \(_recIntakeNow\(\)/.test(HTML),
    "a modal that does not say its scope is how someone prunes the wrong intake");
  check("⚠️ the delete warning no longer claims it hits every intake",
    !/every intake's grid/.test(HTML) && /他の入学期には影響しません/.test(HTML),
    "a warning that overstates the damage is how people stop reading warnings");
}

console.log("\n7. one read per mutation; a 国名 delete takes no sheet copy and redraws in place");
{
  // ⚠️ WHY. Reported as "it takes about 5~10 seconds for the deletion to take effect".
  // A single 国名 delete made THREE full reads of the same small sheet — the materialiser's
  // own, its header probe, and the caller's — plus a COMPLETE copy of the sheet into the
  // backup file, on every delete.
  function bodyOf(name) {
    const i = CODE.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = CODE.indexOf('\nfunction ', i + 1);
    return CODE.slice(i, j < 0 ? CODE.length : j);
  }
  const reads = n => (bodyOf(n).match(/getDataRange\(\)\.getDisplayValues\(\)/g) || []).length;

  check("⚠️ the delete reads the sheet ONCE", reads('removeRecruitmentMeta') === 1,
    reads('removeRecruitmentMeta') + " reads — the materialiser hands its rows back so the " +
    "caller need not fetch them again");
  check("⚠️ the add reads the sheet ONCE", reads('addRecruitmentMeta') === 1,
    reads('addRecruitmentMeta') + " reads");
  check("⚠️ the header check does not probe the sheet on its own",
    !/getRange\(1, 5\)\.getDisplayValue\(\)/.test(CODE)
      && /function _recEnsureMetaHeader_\(sh, rows\)/.test(CODE),
    "it ran a second round trip to a sheet that had just been read in full, on every save");
  check("...and the materialiser takes rows in and hands rows back",
    /function _recMaterialiseLegacyCountries_\(sh, rows\)/.test(CODE)
      && /if \(!legacy\.length\) return data;/.test(CODE),
    "returning a boolean forces the caller to re-read");

  // ⚠️ RE-PINNED 2026-09-11, on MEASUREMENT (profileRecruitMeta, three runs on staging): the
  // full copy was ~1.5s of a ~5s delete, protecting one row of settings. A 国名 delete now takes
  // NO sheet copy and writes the deleted row into its 操作履歴 entry instead. The throttle this
  // section used to pin was the reasoning-only step before the numbers existed.
  const del = bodyOf('removeRecruitmentMeta');
  const noCountryCopy = function (b) {
    return /if \(k !== "country"\) \{ try \{ _snapshotSheet_\(SHEET_RECRUIT_META\); \} catch \(e\) \{\} \}/.test(b)
      && !/_snapshotSheetThrottled\(SHEET_RECRUIT_META\)/.test(b);
  };
  check("⚠️ a 国名 delete takes NO sheet copy; every other kind keeps the full one", noCountryCopy(del),
    "入学期 / 担当者 / 地域 deletes can orphan grid data and must still be backed up");
  check("  mutation: the old throttled copy fails it",
    noCountryCopy(del.replace('if (k !== "country") { try { _snapshotSheet_(SHEET_RECRUIT_META); } catch (e) {} }',
                              'try { if (k === "country") _snapshotSheetThrottled(SHEET_RECRUIT_META); else _snapshotSheet_(SHEET_RECRUIT_META); } catch (e) {}')) === false, "");
  const logsRow = function (b) {
    return /const gone = hits\.map\(function \(i\) \{ return data\[i\]; \}\);/.test(b)
      && b.indexOf('const gone') < b.indexOf('sh.deleteRow(i + 1)')
      && /gone\.map\(function \(r\) \{ return _rowForLog_\(data\[0\], r\); \}\)/.test(b)
      && /"募集リストから削除", k \+ ": " \+ v, detail\)/.test(b);
  };
  check("⚠️ ...instead the deleted ROW is captured BEFORE deleteRow and written to 操作履歴", logsRow(del),
    "without it, a mistaken 国名 delete would have no record of its 地域 / 並び順 / 入学期");
  check("  mutation: logging nothing fails it", logsRow(del.replace('k + ": " + v, detail)', 'k + ": " + v, "")')) === false, "");

  // In place, not a reload — measured at ~1.2s of server time plus a second round trip.
  const JSH = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || '';
  const di = JSH.indexOf('function recDeleteCountry(');
  const D = JSH.slice(di, JSH.indexOf('\n      function ', di + 1));
  const inPlace = function (b) {
    return /if \(res && res\.removed && recData && _recIntakeNow\(\) === intake\) \{/.test(b)
      && /recData\.addedCountries = \(recData\.addedCountries \|\| \[\]\)\.filter\(/.test(b)
      && /recRender\(\);\s*_recReapplyDirtyToDom\(\);\s*recRenderCountryList\(\);/.test(b)
      && b.indexOf('return;', b.indexOf('recRenderCountryList();')) < b.indexOf('recLoad(undefined');
  };
  check("⚠️ a successful 国名 delete redraws IN PLACE, and returns before any reload", inPlace(D), "");
  check("  mutation: reloading every time fails it",
    inPlace(D.replace('if (res && res.removed && recData && _recIntakeNow() === intake) {', 'if (false) {')) === false, "");
  check("...entries may be objects OR bare names, as _recNationalityRows allows",
    /return \(\(a && a\.name !== undefined\) \? a\.name : a\) !== name;/.test(D), "");
  check("...and anything unexpected (nothing removed, intake changed) still reloads",
    /recLoad\(undefined, function \(\) \{\s*recRenderCountryList\(\);/.test(D), "");

  // The client half: no more guessing when the reload finished.
  check("⚠️ the modals re-render on the reload's COMPLETION, not a timer",
    /function recLoad\(forceIntake, after\)/.test(HTML)
      && /if \(typeof after === 'function'\) after\(\);/.test(HTML)
      && !/setTimeout\(recRender/.test(HTML),
    "a setTimeout(500) fired when recLoad STARTED, so the list painted pre-delete data " +
    "whenever the round trip outran the guess — and wasted 500ms when it did not");
  check("⚠️ ...and the callback survives recLoad's own re-entry",
    /recLoad\(undefined, after\); return;/.test(HTML),
    "the blank-intake branch re-enters recLoad; dropping `after` there strands the caller " +
    "on exactly the path that takes longest");
}

console.log("\n8. the parked ~5s delete is MEASURED, and the measuring touches no real row");
{
  // ⚠️ Two rounds of reasoning removed real waste and still left ~5s. The next step is numbers:
  // profileRecruitMeta times the server legs; the console line times the same delete end to end.
  const at = CODE.indexOf('function profileRecruitMeta(');
  const P = CODE.slice(at, CODE.indexOf('\n}', at));
  // Each property is asserted, then asserted to FAIL on the unsafe shape (the mutation).
  const props = [
    ["it is locked to the editor", function (b) { return /_requireMaintenanceUnlock_\("profileRecruitMeta"\)/.test(b); },
     '_requireMaintenanceUnlock_("profileRecruitMeta")', 'void 0'],
    ["⚠️ it never calls deleteRow on the real meta sheet — only on its scratch sheet",
     function (b) { return !/meta\.deleteRow|sh\.deleteRow/.test(b) && /scratch\.deleteRow\(2\)/.test(b); },
     'scratch.deleteRow(2)', 'meta.deleteRow(2)'],
    ["the scratch sheet is removed in a finally",
     function (b) { return /finally \{\s*if \(scratch\) \{ try \{ ss\.deleteSheet\(scratch\); \}/.test(b); },
     'finally {\n        if (scratch) { try { ss.deleteSheet(scratch); }', '{\n        if (scratch) { try { ss.deleteSheet(scratch); }'],
    ["the snapshot copy is deleted at once, so no real backup is evicted",
     function (b) { return /const copy = meta\.copyTo\(backup\);\s*try \{ backup\.deleteSheet\(copy\); \}/.test(b) && !/_snapshotSheet_\(/.test(b); },
     'try { backup.deleteSheet(copy); } catch (e) {}', ''],
    ["the parked master session is restored in a finally",
     function (b) { return /finally \{\s*_authUser = wasAuthUser;\s*\}/.test(b); },
     '} finally {\n    _authUser = wasAuthUser;\n  }', '}\n  _authUser = wasAuthUser;'],
    ["three samples, reported as a median", function (b) { return /const SAMPLES = 3;/.test(b) && /const med = function/.test(b); },
     'const SAMPLES = 3;', 'const SAMPLES = 1;'],
  ];
  props.forEach(function (x) {
    check(x[0], P.length > 500 && x[1](P), "");
    let mutant;
    try {
      if (P.split(x[2]).length !== 2) throw new Error('anchor not unique');
      mutant = x[1](P.replace(x[2], x[3]));
    } catch (e) { mutant = 'mutation failed: ' + e.message; }
    check("  mutation: the unsafe shape fails it", mutant === false, String(mutant));
  });
  check("it is registered as a maintenance function (endpoints.test)",
    /'profileRecruitMeta'/.test(fs.readFileSync(path.join(ROOT, 'tests', 'endpoints.test.js'), 'utf8')), "");

  // The browser half: one console line, and nothing on screen.
  const JS = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || '';
  const di = JS.indexOf('function recDeleteCountry(');
  const D = JS.slice(di, JS.indexOf('\n      function ', di + 1));
  check("recDeleteCountry times the delete, the reload and the render",
    /const t0 = Date\.now\(\);/.test(D) && /const t1 = Date\.now\(\);/.test(D) &&
    /console\.info\('\[募集状況\] 国名削除 ' \+ \(t3 - t0\) \+ 'ms = 削除 ' \+ \(t1 - t0\)/.test(D), "");
  check("...console only — the timing never reaches the page",
    !/innerText|innerHTML|alert\(/.test(D.slice(D.indexOf('const t0'), D.indexOf('.removeRecruitmentMeta('))), "");
  check("...and recRenderCountryList still runs after the reload",
    /recLoad\(undefined, function \(\) \{\s*recRenderCountryList\(\);/.test(D), "");
  check("recLoad marks when the bundle ARRIVED, so the reload splits into transport + render",
    /window\._recBundleArrivedAt = Date\.now\(\);/.test(JS), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
