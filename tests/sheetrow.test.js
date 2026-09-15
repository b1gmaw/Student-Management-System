// _recDropRow / _recRestoreRow, transcribed from Index.html.
//
// The dangerous bug is a WRONG _sheetRow after a delete, because the next delete
// then removes a different person. Each case is checked against a simulated
// sheet: rows are actually removed by the index the client sends, and every
// surviving row must still resolve to itself.

function _recDropRow(list, rowIndex) {
  const ri = parseInt(rowIndex, 10);
  let at = -1;
  for (let i = 0; i < list.length; i++) {
    if (parseInt(list[i]._sheetRow, 10) === ri) { at = i; break; }
  }
  if (at === -1) return null;
  const row = list[at];
  list.splice(at, 1);
  list.forEach(function (r) {
    const n = parseInt(r._sheetRow, 10);
    if (n > ri) r._sheetRow = n - 1;
  });
  return { row: row, at: at, ri: ri };
}

function _recRestoreRow(list, undo) {
  list.forEach(function (r) {
    const n = parseInt(r._sheetRow, 10);
    if (n >= undo.ri) r._sheetRow = n + 1;
  });
  list.splice(undo.at, 0, undo.row);
}

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

const makeSheet = names => ["<header>"].concat(names);        // index 0 == sheet row 1
const sheetDelete = (sheet, ri) => sheet.slice(0, ri - 1).concat(sheet.slice(ri));
const sheetRows = sheet => sheet.slice(1);

console.log("\n1. Single delete keeps client and sheet in agreement");
{
  let sheet = makeSheet(["RowA", "RowB", "RowC", "RowD"]);
  let list = ["RowA", "RowB", "RowC", "RowD"].map((n, i) => ({ name: n, _sheetRow: i + 2 }));
  _recDropRow(list, 3);
  sheet = sheetDelete(sheet, 3);
  check("RowB removed", list.map(r => r.name).join() === "RowA,RowC,RowD", list.map(r => r.name).join());
  check("sheet agrees", sheetRows(sheet).join() === "RowA,RowC,RowD", sheetRows(sheet).join());
  check("_sheetRow renumbered", list.map(r => r._sheetRow).join() === "2,3,4", list.map(r => r._sheetRow).join());
  check("each row resolves to itself", list.every(r => sheet[r._sheetRow - 1] === r.name), JSON.stringify(list));
}

console.log("\n2. THREE sequential deletes — the case that hits the wrong person");
{
  let sheet = makeSheet(["RowA", "RowB", "RowC", "RowD", "RowE"]);
  let list = ["RowA", "RowB", "RowC", "RowD", "RowE"].map((n, i) => ({ name: n, _sheetRow: i + 2 }));
  ["RowC", "RowE", "RowA"].forEach(function (target) {
    const ri = list.filter(r => r.name === target)[0]._sheetRow;
    _recDropRow(list, ri);
    sheet = sheetDelete(sheet, ri);
    check("deleted " + target + " and only " + target,
      sheetRows(sheet).indexOf(target) === -1 && list.filter(r => r.name === target).length === 0,
      "sheet=" + sheetRows(sheet).join());
  });
  check("survivors are RowB,RowD", sheetRows(sheet).join() === "RowB,RowD", sheetRows(sheet).join());
  check("model matches sheet", list.map(r => r.name).join() === "RowB,RowD", list.map(r => r.name).join());
  check("every _sheetRow still resolves", list.every(r => sheet[r._sheetRow - 1] === r.name), JSON.stringify(list));
}

console.log("\n3. First and last rows");
{
  let sheet = makeSheet(["RowA", "RowB", "RowC"]);
  let list = ["RowA", "RowB", "RowC"].map((n, i) => ({ name: n, _sheetRow: i + 2 }));
  _recDropRow(list, 2); sheet = sheetDelete(sheet, 2);
  check("first row ok", list.every(r => sheet[r._sheetRow - 1] === r.name) && sheetRows(sheet).join() === "RowB,RowC", JSON.stringify(list));
  const last = list[list.length - 1]._sheetRow;
  _recDropRow(list, last); sheet = sheetDelete(sheet, last);
  check("last row ok", list.every(r => sheet[r._sheetRow - 1] === r.name) && sheetRows(sheet).join() === "RowB", JSON.stringify(list));
}

console.log("\n4. Restore after server rejection is an exact inverse");
{
  [2, 5].forEach(function (ri) {
    const before = ["RowA", "RowB", "RowC", "RowD"].map((n, i) => ({ name: n, _sheetRow: i + 2 }));
    const list = before.map(r => ({ name: r.name, _sheetRow: r._sheetRow }));
    _recRestoreRow(list, _recDropRow(list, ri));
    check("restore row " + ri + " is exact", JSON.stringify(list) === JSON.stringify(before), JSON.stringify(list));
  });
}

console.log("\n5. Gaps — other intakes occupy sheet rows in between");
{
  const list = [{ name: "RowA", _sheetRow: 2 }, { name: "RowC", _sheetRow: 4 },
                { name: "RowD", _sheetRow: 5 }, { name: "RowF", _sheetRow: 7 }];
  _recDropRow(list, 4);
  check("only later rows shift", list.map(r => r._sheetRow).join() === "2,4,6", list.map(r => r._sheetRow).join());
  check("row before is untouched", list[0]._sheetRow === 2, String(list[0]._sheetRow));
}

console.log("\n6. Unknown index returns null so the caller can resync");
{
  const list = [{ name: "RowA", _sheetRow: 2 }];
  check("returns null", _recDropRow(list, 99) === null, "did not");
  check("list untouched", list.length === 1, JSON.stringify(list));
}

console.log("\n7. String indices (dataset values arrive as strings)");
{
  const list = [{ name: "RowA", _sheetRow: 2 }, { name: "RowB", _sheetRow: "3" }, { name: "RowC", _sheetRow: 4 }];
  const undo = _recDropRow(list, "3");
  check("matched despite string types", undo !== null && undo.row.name === "RowB", JSON.stringify(undo));
  check("renumbered correctly", list.map(r => r._sheetRow).join() === "2,3", list.map(r => r._sheetRow).join());
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
