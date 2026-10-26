// 面接結果 → the 詳細 pop-up's 編集 button (2026-10-05).
//
// The table's own 編集 sits in its LAST column, so staff scrolled the wide table all the way right
// to edit a row. Clicking a row already opens 詳細 (showDetail); it now carries 編集 too. Runs the
// REAL showDetail / detailEditResult from Index.html in a vm, against a fake DOM.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}

const HTML = fs.readFileSync(path.join(__dirname, "..", "Index.html"), "utf8");
const CLIENT = (HTML.match(/<script>([\s\S]*?)<\/script>/g) || [])[1] || "";
function fnSrc(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++; continue; }
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

function run(client, opts) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, innerHTML: "", innerText: "" });
  const calls = [];
  const ctx = vm.createContext({
    document: { getElementById: (id) => el(id) },
    escHtmlJs: (v) => String(v),
    hasPermission: (p) => (opts.perms || []).indexOf(p) !== -1,
    openInterviewResultEdit: (row) => calls.push(row),
    pastInterviewsData: opts.interviews,
    currentStudentsData: opts.students || [["氏名"], ["学生 一郎"]],
  });
  vm.runInContext("var _detailIrRow = null;\n" + ["showDetail", "detailEditResult"].map(n => {
    const f = fnSrc(client, n); if (!f) throw new Error("missing " + n); return f;
  }).join("\n"), ctx);
  return { ctx, els: el, calls };
}

// Sorted data: array position no longer equals sheet row, which is the point of the tag.
const IV = () => { const d = [["日付", "名前"], ["2026/09/02", "SAMPLE B"], ["2026/09/01", "SAMPLE A"]];
  d[1]._sheetRow = 7; d[2]._sheetRow = 3; return d; };
const EDIT = ["entry_interview_results"];

console.log("1. the button and the row it opens");
{
  const t = run(CLIENT, { perms: EDIT, interviews: IV() });
  t.ctx.showDetail(null, 1, "interview");
  check("an interview row, with permission → 編集 is shown", t.els("detailActions").style.display === "flex");
  t.ctx.detailEditResult();
  check("編集 closes the pop-up and opens the editor on the row's _sheetRow tag (7, not index 2)",
    t.els("detailCard").style.display === "none" && JSON.stringify(t.calls) === "[7]", JSON.stringify(t.calls));
  const byIndex = CLIENT.replace("_detailIrRow = canEdit ? (rowData._sheetRow || (rowIndex + 1)) : null;", "_detailIrRow = canEdit ? (rowIndex + 1) : null;");
  const m = run(byIndex, { perms: EDIT, interviews: IV() });
  m.ctx.showDetail(null, 1, "interview"); m.ctx.detailEditResult();
  check("  mutation: naming the row by array position opens the WRONG row after a sort", byIndex !== CLIENT && m.calls[0] === 2);
}

console.log("\n2. who does not see it");
{
  const viewer = run(CLIENT, { perms: [], interviews: IV() });
  viewer.ctx.showDetail(null, 1, "interview");
  viewer.ctx.detailEditResult();
  check("no entry_interview_results → hidden, and nothing opens", viewer.els("detailActions").style.display === "none" && viewer.calls.length === 0);
  const noPerm = CLIENT.replace("const canEdit = type === 'interview' && hasPermission('entry_interview_results');", "const canEdit = type === 'interview';");
  const m = run(noPerm, { perms: [], interviews: IV() });
  m.ctx.showDetail(null, 1, "interview");
  check("  mutation: without the permission check a viewer gets 編集", noPerm !== CLIENT && m.els("detailActions").style.display === "flex");
  const t = run(CLIENT, { perms: EDIT, interviews: IV() });
  t.ctx.showDetail(null, 1, "interview");
  t.ctx.showDetail(null, 1, "student");
  t.ctx.detailEditResult();
  check("学生詳細 hides it, and clears the row an earlier 面接結果 open left behind",
    t.els("detailActions").style.display === "none" && t.calls.length === 0);
}

console.log("\n3. markup");
{
  const card = (HTML.match(/<div id="detailCard"[\s\S]*?<div id="detailActions"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/) || [""])[0];
  const header = (card.match(/<div class="modal-box"[^>]*>\s*(<div[^>]*>[\s\S]*?<\/div>)/) || [, ""])[1];
  check("⚠️ 編集 is NOT in the header div (the media block floats every button there as the ✕)",
    card.indexOf('id="detailEditBtn"') !== -1 && header.indexOf("detailEditBtn") === -1, header);
  check("it comes after the grid", card.indexOf('id="detailGrid"') < card.indexOf('id="detailActions"'));
  const btn = (HTML.match(/<button id="detailEditBtn"[^>]*>[\s\S]*?<\/button>/) || [""])[0];
  check("text only: no .btn-ico SVG in a modal without a clip rule", btn !== "" && !/btn-ico|<svg/.test(btn), btn);
  // The sticky bar spans the box edge to edge by negative margins that must EQUAL the box's
  // padding: the desktop's 30px overhung a phone's 16px box by 14px a side (measured in the driver).
  const desk = (HTML.match(/^\s*#detailActions \{[^}]*\}/m) || [""])[0];
  const media = HTML.slice(HTML.lastIndexOf("@media (max-width: 820px)"));
  const phone = (media.match(/#detailActions \{[^}]*\}/) || [""])[0];
  check("desktop: offsets equal .modal-box's 30px padding, without !important",
    /bottom: -30px/.test(desk) && /margin: 16px -30px -30px/.test(desk) && /padding: 12px 30px/.test(desk) && !/!important/.test(desk) &&
    /\.modal-box \{[^}]*padding: 30px/.test(HTML), desk);
  check("phone: the media block restates them for its 16px padding",
    /bottom: -16px !important/.test(phone) && /margin: 12px -16px -16px !important/.test(phone) && /padding: 12px 16px 16px !important/.test(phone) &&
    /padding: 16px !important/.test(media), phone);
  check("no geometry inline on the element (an inline style would beat the phone rule)",
    /<div id="detailActions" style="display:none;">/.test(HTML));
  check("_detailIrRow is declared above showDetail (rule 3)",
    CLIENT.indexOf("let _detailIrRow = null;") !== -1 && CLIENT.indexOf("let _detailIrRow = null;") < CLIENT.indexOf("function showDetail("));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
