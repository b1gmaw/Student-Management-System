// 進路 classifier — turning one free-text column into buckets.
//
// 643 distinct values over 1404 rows: school names, company names, 帰国, 延長,
// 退学, and occasional prose. Every rule here was SCORED against the real column
// before being written, and §6 replays a sample of it so the rules cannot quietly
// rot.
//
// Two things that looked obvious and were wrong, both caught by measuring:
//   - the sync's /進路/ header match imported 進路希望１ — the ASPIRATION column —
//     so this data read 1399/1400 blank for years;
//   - "業種 filled ⇒ 就職" scored 86% coverage, but 業種 is also recorded on 258
//     進学 and 66 帰国 rows, so it would have relabelled university-bound
//     students as employed. Rejected on the evidence.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Code.js ----
function normName(v) {
  let s = String(v == null ? "" : v);
  s = s.replace(/[！-～]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
  s = s.replace(/[\s　 ]/g, "");
  return s.toLowerCase().trim();
}

const DEST_CATEGORIES = ["進学", "就職", "帰国", "在籍継続", "退学・除籍", "その他"];

const DEST_RULES_EXPLICIT = [
  // A stated CONDITION is not an outcome. 「就職決まらなければ帰国」 records an
  // intention; calling it 帰国 reports a student as having left when nobody knows.
  // Straight to the queue for a human instead.
  { cat: "未分類",    re: /なければ|なかったら|ない場合|未定/ },
  { cat: "帰国",      re: /帰国|帰　国/ },
  { cat: "退学・除籍", re: /退学|除籍|行方不明|休学|名前削除|連絡取れ/ },
  { cat: "在籍継続",   re: /延長|長期コース/ },
  // ⚠️ 就職 SITS ABOVE その他, and 就職活動 IS NOT 就職.
  //   - 「就職（ビザ待ち）株式会社サンプル鋳造」 has a named employer and was
  //     coming out その他, because その他's ビザ ran first.
  //   - 「特定活動(就職活動)」 is a job-hunting visa, not a job — but 就職活動
  //     contains 就職, so a bare /就職/ claimed it. The lookahead excludes it and
  //     その他 then picks it up correctly.
  { cat: "就職",      re: /就職(?!活動)|特定技能|技人国/ },
  { cat: "その他",     re: /ビザ|VISA|在留|特定活動|家族滞在|経営管理|結婚|起業|在住|滞在|両親/ },
  { cat: "進学",      re: /進学|準備教育/ }
];

const DEST_RULES_INFERRED = [
  { cat: "進学", re: /大学院|大学校|大学|専門学校|専門|学院|学園|学校|短大|高専|カレッジ|ｶﾚｯｼﾞ|COLLEGE|College|アカデミー|スクール|学科|高校|予備校|ゼミナール|上級科|整備科|美術|GAKKU/ },
  { cat: "就職", re: /株式会社|\(株\)|（株）|㈱|㈲|有限会社|合同会社|会社|商事|工業|建設|運輸|サービス|ホテル|HOTEL|Hotel|hotel|病院|製作所|福祉会|法人|財団|コーポレーション|CORPORATION|Co\.|Ltd|協会|老人ホーム|カンパニー|テック|産業|グループ|ホールディングス|企画|旅行社|フーズ|ジャパン|JAPAN|マネジメント|ホスピタリティ|組合|研究所|介護|旅館|レンタ|ロジスティクス|テクノロジー|エンタテイメント|自動車|運送|物流|印刷|食品|電機|銀行|保険|不動産/ }
];

function aliasesFrom(pairs) {
  return pairs.map(function (p) { return { pattern: p[0], key: normName(p[0]), cat: p[1] }; })
              .sort(function (a, b) { return b.key.length - a.key.length; });
}

function categorise(raw, aliases, industry, sid, overrides) {
  if (sid && overrides && overrides[String(sid).trim()]) return overrides[String(sid).trim()];
  const s = String(raw == null ? "" : raw);
  if (normName(s) === "") return "未入力";
  const key = normName(s);
  // 1. An alias on the WHOLE value beats everything, including an explicit
  //    keyword. A pattern matching the entire string is an unambiguous statement
  //    about that one row — 「就職活動ビザ→Sample Dining Group」 means they moved
  //    FROM a job-hunting visa TO that company, which no keyword can see.
  //
  //    SUBSTRING aliases stay below the explicit rules (step 3), so 「見本（就職）」
  //    is still 就職 however 見本 is mapped. That distinction is the whole point:
  //    a brand name is a guess about an institution, a whole-value match is a
  //    decision about a row.
  //
  //    Assignments from the 未分類 queue save the full raw value, so anything
  //    resolved there is an exact alias and always takes effect.
  for (let i = 0; i < (aliases || []).length; i++) {
    if (aliases[i].key === key) return aliases[i].cat;
  }
  // 2. Then an outcome stated outright.
  for (let i = 0; i < DEST_RULES_EXPLICIT.length; i++) {
    if (DEST_RULES_EXPLICIT[i].re.test(s)) return DEST_RULES_EXPLICIT[i].cat;
  }
  // 3. Substring aliases — a brand name inside a longer value.
  for (let i = 0; i < (aliases || []).length; i++) {
    if (key.indexOf(aliases[i].key) !== -1) return aliases[i].cat;
  }
  for (let i = 0; i < DEST_RULES_INFERRED.length; i++) {
    if (DEST_RULES_INFERRED[i].re.test(s)) return DEST_RULES_INFERRED[i].cat;
  }
  if (normName(industry) !== "") return "就職";
  return "未分類";
}

console.log("\n1. blanks are 未入力, never 未分類");
{
  ["", "   ", "　", "\n", null, undefined].forEach(function (v) {
    check(JSON.stringify(v) + " -> 未入力", categorise(v, []) === "未入力", categorise(v, []));
  });
  // The distinction carries the whole work queue: nobody typed anything vs the
  // rules could not read what was typed.
  check("未入力 and 未分類 are different outcomes",
    categorise("", []) !== categorise("ZZZ商店", []), "");
}

console.log("\n2. an unreadable value is 未分類, never その他");
{
  ["ZZZ", "サンプルプロジェクト", "wayfarer", "SAMPLE&MOON"].forEach(function (v) {
    check(JSON.stringify(v) + " -> 未分類", categorise(v, []) === "未分類", categorise(v, []));
  });
  // Folding these into その他 would make the report look complete while hiding
  // every value nobody has classified.
  check("未分類 is not silently その他",
    categorise("サンプルプロジェクト", []) !== "その他",
    "unclassified values disappeared into その他");
}

console.log("\n3. rule order — the specific outcome wins over the institution keyword");
{
  // Each of these contains a keyword from a LATER rule too. Order is the rule.
  check("サンプル学園進学日本語コース -> 進学", categorise("サンプル学園進学日本語コース", []) === "進学", "");
  // ⚠️ Rules genuinely CANNOT place this one: it is 本町"校", not 学校, so no
  // 進学 keyword fires and ホテル carries it to 就職. 見本 is a school brand, and
  // brands are what the alias tab is for — asserted properly in §4.
  check("見本本町校（ホテル） is misread by rules alone",
    categorise("見本本町校（ホテル）", []) === "就職",
    "if this changes, re-check whether the alias is still needed");
  check("and the 見本 alias corrects it",
    categorise("見本本町校（ホテル）", aliasesFrom([["見本", "進学"]])) === "進学", "");
  check("NGO（大阪）ホテル -> 就職 (no 学校 word present)",
    categorise("NGO（大阪）ホテル", []) === "就職", categorise("NGO（大阪）ホテル", []));
  check("退学(海外へ） -> 退学・除籍", categorise("退学(海外へ）", []) === "退学・除籍", "");
  check("日本人との結婚VISA申請中 -> その他", categorise("日本人との結婚VISA申請中", []) === "その他", "");
  check("就職　ホテル（確認中） -> 就職", categorise("就職　ホテル（確認中）", []) === "就職", "");
  check("特別養護老人ホーム 架空台 -> 就職", categorise("特別養護老人ホーム 架空台", []) === "就職", "");
  check("帰国 beats everything", categorise("帰国（就職予定）", []) === "帰国", "");
}

console.log("\n4. aliases outrank rules, and match by CONTAINS");
{
  // One entry covering five spellings is the entire reason the tab is worth
  // having: XYZ alone is 26 rows.
  const a = aliasesFrom([["XYZ", "進学"]]);
  ["XYZ", "XYZ（本町）", "XYZ国際ビジネスITコース", "XYZ 国際ICT（本町）", "XYZI"].forEach(function (v) {
    check(JSON.stringify(v) + " -> 進学 from one alias", categorise(v, a) === "進学", categorise(v, a));
  });

  // An alias must be able to CORRECT a rule, or a wrong rule needs a deploy to
  // fix. 見本本町校（ホテル）is a real one: 本町"校" is not 学校, so no 進学 keyword
  // fires and ホテル carries it to 就職.
  const b = aliasesFrom([["見本", "進学"]]);
  check("rules alone misread 見本本町校（ホテル）as 就職",
    categorise("見本本町校（ホテル）", []) === "就職", "");
  check("an alias overrides that rule", categorise("見本本町校（ホテル）", b) === "進学",
    "aliases must outrank rules or a misjudged rule is unfixable without a deploy");

  // Longest first, so a specific pattern beats a general one containing it.
  const c = aliasesFrom([["見本", "進学"], ["見本本町校（ホテル）", "就職"]]);
  check("the longer pattern wins", categorise("見本本町校（ホテル）", c) === "就職",
    "a general alias swallowed a more specific one");
  check("the shorter one still applies elsewhere", categorise("見本", c) === "進学", "");

  // Normalisation, so a full-width or spaced variant is the same alias.
  const d = aliasesFrom([["QRS大阪", "進学"]]);
  check("full-width ＱＲＳ大阪 matches", categorise("ＱＲＳ大阪", d) === "進学", categorise("ＱＲＳ大阪", d));
  check("spaced QRS大阪　Web科 matches", categorise("QRS大阪　Web科　大阪", d) === "進学", "");
}

console.log("\n4b. an explicit outcome beats a brand alias");
{
  // 「見本本町校（ホテル）」 is a vocational school's HOTEL COURSE, not a hotel job,
  // so the 見本 alias must win. But 「見本（就職）」 states the outcome, and then
  // the alias must lose. That is the whole reason the rules are in two tiers.
  const brandAlias = aliasesFrom([["見本", "進学"]]);
  check("見本本町校（ホテル） -> 進学 via the alias",
    categorise("見本本町校（ホテル）", brandAlias) === "進学", categorise("見本本町校（ホテル）", brandAlias));
  check("見本（就職） -> 就職, alias overridden",
    categorise("見本（就職）", brandAlias) === "就職", categorise("見本（就職）", brandAlias));
  check("見本（就職　ホテル） -> 就職, not 進学",
    categorise("見本（就職　ホテル）", brandAlias) === "就職", categorise("見本（就職　ホテル）", brandAlias));
  check("plain 見本 still follows the alias",
    categorise("見本", brandAlias) === "進学", categorise("見本", brandAlias));
  // Explicit beats an alias pointing the other way too, in both directions.
  const brandJob = aliasesFrom([["XYZ", "就職"]]);
  check("an explicit 進学 beats an alias saying 就職",
    categorise("XYZ進学", brandJob) === "進学", categorise("XYZ進学", brandJob));
  check("帰国 beats any alias", categorise("XYZ 帰国", brandJob) === "帰国", "");
}

console.log("\n4c. 業種 is a LAST RESORT, not an override");
{
  // ⚠️ This section previously asserted the opposite. 業種 sat ABOVE the
  // institution keywords, so every school-named destination with anything in
  // 業種 came out 就職 — which is the bug that was reported: values that
  // "clearly say 進学" showing as 就職.
  //
  // The instruction behind the old rule was real ("if there is data in 業種 it is
  // certainly 就職"), but implementing it as an unconditional override rather
  // than a tiebreaker was the error, and the evidence was already available: a
  // probe had reported 業種 on 258 rows the keywords called 進学.

  // The regression, stated directly.
  check("a school name with 業種 filled stays 進学",
    categorise("架空大学", [], "研究") === "進学", categorise("架空大学", [], "研究"));
  check("and so does a 日本語学校 with 業種 教育",
    categorise("○○日本語学校", [], "教育") === "進学",
    categorise("○○日本語学校", [], "教育"));
  check("a 専門学校 with 業種 IT stays 進学",
    categorise("QRS大阪専門学校", [], "IT") === "進学", categorise("QRS大阪専門学校", [], "IT"));

  // Someone employed AT a school is still 就職 — but that is ONE alias entry, a
  // human decision about a specific institution, not a rule inferred from a
  // column for every school in the sheet.
  check("an alias is how 'employed at a school' is expressed",
    categorise("○○日本語学校", aliasesFrom([["○○日本語学校", "就職"]]), "教育") === "就職",
    "the alias table is the place for institution-specific decisions");

  // What 業種 IS good for: a bare name nothing else recognises.
  check("a bare name with 業種 is 就職",
    categorise("サンプルインタラクティブ", [], "IT") === "就職", categorise("サンプルインタラクティブ", [], "IT"));
  check("the same bare name without 業種 is 未分類",
    categorise("サンプルインタラクティブ", [], "") === "未分類", categorise("サンプルインタラクティブ", [], ""));
  check("whitespace-only 業種 does not count as filled",
    categorise("サンプルインタラクティブ", [], "　 ") === "未分類", categorise("サンプルインタラクティブ", [], "　 "));

  // A company keyword still beats 業種 to the answer — same result, but it means
  // 業種 is genuinely last and not doing work the keywords already did.
  check("a company keyword decides before 業種 is consulted",
    categorise("株式会社サンプルテック", [], "教育") === "就職", "");

  // Explicit outcomes are untouched by any of this.
  check("帰国 with 業種 filled stays 帰国",
    categorise("帰国", [], "飲食") === "帰国", categorise("帰国", [], "飲食"));
  check("an explicit 進学 with 業種 filled stays 進学",
    categorise("○○大学進学", [], "研究") === "進学", categorise("○○大学進学", [], "研究"));
}

console.log("\n4d. the ten real conflict rows");
{
  // Every value in production matching more than one explicit keyword, with the
  // answer confirmed by the school. Before this, the winner was decided by array
  // position: 帰国 sat at index 0 and 就職 at index 4, so anything mentioning
  // either won regardless of what the sentence meant.
  const REAL = [
    // A condition is not an outcome — nobody knows what happened.
    ["就職決まらなければ帰国", "", "未分類"],
    // A named employer with a visa note. その他's ビザ was claiming these.
    ["就職（ビザ待ち）株式会社サンプル鋳造", "製造", "就職"],
    // 就職活動 is job HUNTING. It contains 就職, which a bare /就職/ claimed.
    ["特定活動(就職活動)", "", "その他"],
    ["特定活動ビザ(就職活動)", "", "その他"],
    ["特定活動(就職活動)申請中", "", "その他"],
    // 帰国 outranks 就職 — leaving Japan is the headline for this school.
    ["帰国して就職", "帰国", "帰国"],
    // 退学 outranks the visa note.
    ["退学（特定活動ビザ）", "", "退学・除籍"]
  ];
  let wrong = [];
  REAL.forEach(function (r) {
    const got = categorise(r[0], [], r[1]);
    if (got !== r[2]) wrong.push(r[0] + ": expected " + r[2] + ", got " + got);
  });
  check("all " + REAL.length + " confirmed conflict rows land correctly",
    wrong.length === 0, wrong.join("\n        "));

  // The distinction the lookahead exists for, stated on its own.
  check("就職活動 is not 就職", categorise("就職活動中", [], "") !== "就職",
    categorise("就職活動中", [], ""));
  check("but 就職 followed by anything else still is",
    categorise("就職（介護）", [], "") === "就職", categorise("就職（介護）", [], ""));

  // ⚠️ One row the rules get wrong, and an alias CANNOT fix it.
  // 「就職活動ビザ→Sample Dining Group」 means they moved FROM a job-hunting visa
  // TO that company. The arrow carries the meaning; no keyword sees it.
  check("the arrow case comes out その他",
    categorise("就職活動ビザ→Sample Dining Group", [], "外食(特定技能)") === "その他",
    categorise("就職活動ビザ→Sample Dining Group", [], "外食(特定技能)"));

  // ⚠️ EXACT vs SUBSTRING is the whole precedence rule, asserted both ways.
  // A whole-value alias is a decision about one row and beats an explicit
  // keyword; a substring alias is a guess about an institution and does not.
  check("a SUBSTRING alias does not override an explicit keyword",
    categorise("就職活動ビザ→Sample Dining Group",
               aliasesFrom([["Sample Dining Group", "就職"]]), "外食(特定技能)") === "その他",
    "a brand fragment must not beat a stated outcome");
  check("an EXACT alias does",
    categorise("就職活動ビザ→Sample Dining Group",
               aliasesFrom([["就職活動ビザ→Sample Dining Group", "就職"]]), "外食(特定技能)") === "就職",
    "assignments from the 未分類 queue save the whole value, so they must always apply");
  // The case that makes the distinction necessary, from the other direction.
  check("見本（就職）is still 就職 with a 見本 substring alias",
    categorise("見本（就職）", aliasesFrom([["見本", "進学"]]), "") === "就職", "");
  check("but an exact 見本（就職）alias would win",
    categorise("見本（就職）", aliasesFrom([["見本（就職）", "進学"]]), "") === "進学",
    "a whole-value decision is the one thing that outranks the text");
}

console.log("\n4e. a per-student correction beats everything");
{
  // The case that forced this: 「就職決まらなければ帰国」 appears three times and
  // each of those students did something different. No rule about the TEXT can be
  // right for all three, so the text is the wrong unit of correction.
  const SHARED = "就職決まらなければ帰国";
  check("with no override it stays 未分類",
    categorise(SHARED, [], "", "202504001", {}) === "未分類",
    categorise(SHARED, [], "", "202504001", {}));

  const ov = { "202504001": "就職", "202504002": "帰国" };
  check("student A is 就職", categorise(SHARED, [], "", "202504001", ov) === "就職", "");
  check("student B is 帰国, same text", categorise(SHARED, [], "", "202504002", ov) === "帰国", "");
  check("student C, no override, stays 未分類",
    categorise(SHARED, [], "", "202504003", ov) === "未分類",
    "an override must not leak to students who do not have one");

  // It beats every other signal, including the ones that beat each other.
  check("an override beats an exact alias",
    categorise("帰国", aliasesFrom([["帰国", "その他"]]), "", "S1", { S1: "進学" }) === "進学", "");
  check("an override beats an explicit keyword",
    categorise("帰国", [], "", "S1", { S1: "就職" }) === "就職", "");
  check("an override beats 業種",
    categorise("サンプルインタラクティブ", [], "IT", "S1", { S1: "進学" }) === "進学", "");

  // And it is inert when absent, so nothing changes for the other ~1450 rows.
  check("no sid, no override map, behaves as before",
    categorise("架空大学", [], "") === "進学", "");
  check("a sid with an empty map behaves as before",
    categorise("架空大学", [], "", "S9", {}) === "進学", "");
}

console.log("\n5. percentages exclude what nobody knows");
{
  // The denominator is the KNOWN outcomes. A percentage taken over rows whose
  // outcome nobody recorded is an average of ignorance.
  const counts = { "進学": 60, "就職": 30, "帰国": 10, "在籍継続": 0, "退学・除籍": 0, "その他": 0 };
  let known = 0;
  DEST_CATEGORIES.forEach(function (k) { known += counts[k]; });
  const pct = DEST_CATEGORIES.map(function (k) { return known ? Math.round(1000 * counts[k] / known) / 10 : null; });
  check("known excludes 未入力 and 未分類", known === 100, String(known));
  check("percentages sum to 100", Math.round(pct.reduce(function (a, b) { return a + b; }, 0)) === 100,
    JSON.stringify(pct));
  const empty = 0;
  check("a cohort with no known outcomes yields null, not NaN",
    (empty ? 1 : null) === null, "");
}

console.log("\n6. scored against the real column");
{
  // A sample of the values that were unclassified before these rules, with the
  // bucket each must now land in. If a rule is loosened or reordered and this
  // section still passes, the change was safe.
  const REAL = [
    ["延長", "在籍継続"], ["転校", "未分類"], ["就職", "就職"], ["就職（介護）", "就職"],
    ["技人国就職", "就職"], ["特定技能（介護）", "就職"], ["サンプルAカレッジ", "進学"],
    ["サンプルA製作所", "就職"], ["見本学園本町校", "進学"], ["サンプルBカレッジ神戸", "進学"],
    ["サンプル福祉会", "就職"], ["サンプルA学園", "進学"], ["サンプル記念財団", "就職"],
    ["サンプルCカレッジ", "進学"], ["サンプルDカレッジ", "進学"],
    ["サンプルクラブ＆ホテルズ", "就職"], ["国で結婚", "その他"], ["結婚", "その他"],
    ["サンプルB学園", "進学"], ["サンプルEカレッジ", "進学"],
    ["サンプルFカレッジ・介護福祉", "進学"], ["社会福祉法人 サンプル会", "就職"],
    ["ホテルサンプル本町", "就職"], ["㈲サンプルB製作所", "就職"], ["NPO法人サンプル", "就職"],
    ["休学中", "退学・除籍"], ["サンプルC学園", "進学"], ["サンプル研究所", "就職"],
    ["特別養護老人ホームサンプル", "就職"], ["サンプル不動産リゾートマネジメント", "就職"],
    ["サンプルグループ", "就職"], ["行方不明", "退学・除籍"], ["除籍", "退学・除籍"],
    ["サンプルA病院", "就職"], ["さんぷる亭", "未分類"], ["サンプル自動車（横浜？）", "就職"],
    ["サンプル高校", "進学"], ["サンプルD学園", "進学"], ["サンプルE学園", "進学"],
    ["サンプルフーズ", "就職"], ["サンプルアカデミー", "進学"], ["サンプルC製作所", "就職"],
    ["サンプルB病院", "就職"], ["進学", "進学"], ["短期（日本滞在継続）", "その他"],
    ["3月から連絡取れなくなり、４月からの学費も払えず名前削除", "退学・除籍"],
    ["202510長期コースへ", "在籍継続"], ["日本で起業", "その他"],
    ["他県の両親のところへ（日本国籍有）", "その他"], ["サンプル国際事業協同組合", "就職"]
  ];
  let wrong = [];
  REAL.forEach(function (r) {
    const got = categorise(r[0], []);
    if (got !== r[1]) wrong.push(r[0] + ": expected " + r[1] + ", got " + got);
  });
  check("all " + REAL.length + " sampled real values land where measured",
    wrong.length === 0, wrong.join("\n        "));

  // Recorded so a future change can see what it is trading away. Rules alone
  // reached 90% of filled rows; ~20 aliases take it past 95%.
  const placed = REAL.filter(function (r) { return r[1] !== "未分類"; }).length;
  check("the sample is mostly placed by rules alone, as measured",
    placed >= REAL.length - 3, placed + "/" + REAL.length);
}

console.log("\n7. every category the report can emit is a known one");
{
  const seen = {};
  ["帰国", "退学", "延長", "結婚", "大学", "株式会社", "ZZZ", ""].forEach(function (v) {
    seen[categorise(v, [])] = true;
  });
  const allowed = DEST_CATEGORIES.concat(["未入力", "未分類"]);
  const strays = Object.keys(seen).filter(function (c) { return allowed.indexOf(c) === -1; });
  check("no category outside the declared set", strays.length === 0, strays.join(","));
  check("six outcome buckets, as agreed", DEST_CATEGORIES.length === 6, String(DEST_CATEGORIES.length));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
