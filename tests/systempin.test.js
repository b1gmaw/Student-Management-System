// The master account fails CLOSED when SYSTEM_PIN is not set.
//
// There used to be a hard-coded SYSTEM_PIN_FALLBACK. It failed open and silently:
// script properties are not carried by File → Make a copy, and staging is its own
// project, so any copy of the code accepted a password that is in this repo's git
// history — for the one role that bypasses every permission check.
//
// The dangerous shape of the fix is `pw !== _systemPin_()`, because an unset PIN
// is "" and a submitted empty password would then MATCH. These checks exist to
// keep that from creeping back.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// Mirrors _systemPin_(): property value, trimmed; "" when unset or unreadable.
function systemPin(prop) {
  let v = "";
  try { v = String(prop == null ? "" : prop).trim(); } catch (e) { v = ""; }
  return v;
}

// Mirrors the MASTER branch of loginUser. Returns "ok" | "unset" | "rejected".
function masterLogin(prop, submitted) {
  const sysPin = systemPin(prop);
  if (sysPin === "") return "unset";
  if (String(submitted == null ? "" : submitted) !== sysPin) return "rejected";
  return "ok";
}

// Mirrors the MASTER branch of _resolveUserById_. null => resumeSession revokes.
function resolveMaster(prop) {
  return systemPin(prop) === "" ? null : { role: "master", permissions: "ALL" };
}

console.log("\n1. unset property disables the account");
{
  const unset = [null, undefined, "", "   ", "\n"];
  unset.forEach(function (p) {
    check("prop " + JSON.stringify(p) + " -> unset, not a comparison",
      masterLogin(p, "anything") === "unset", masterLogin(p, "anything"));
  });

  // The specific bug the guard exists for.
  check('empty password does NOT match an unset PIN',
    masterLogin("", "") === "unset",
    'submitted "" matched an unset PIN — the emptiness check must come first');
  check('empty password does NOT match a whitespace-only property',
    masterLogin("   ", "") === "unset", masterLogin("   ", ""));
}

console.log("\n2. no hard-coded value works anywhere");
{
  // The shapes people reach for when re-adding a hard-coded fallback.
  ["4242", "0000", "1234", "master", "admin"].forEach(function (guess) {
    check('unset project rejects "' + guess + '"',
      masterLogin(null, guess) === "unset",
      "a hard-coded credential came back — the fallback has returned");
  });
}

console.log("\n3. a set property still works normally");
{
  check("correct password -> ok", masterLogin("Sample-2026!x", "Sample-2026!x") === "ok",
    masterLogin("Sample-2026!x", "Sample-2026!x"));
  check("wrong password -> rejected (throttled path, not 'unset')",
    masterLogin("Sample-2026!x", "nope") === "rejected", masterLogin("Sample-2026!x", "nope"));
  // Stored values are trimmed; a submitted password is not, so trailing spaces
  // in the property must not become part of the secret.
  check("property is trimmed before comparing",
    masterLogin("  Sample-2026!x  ", "Sample-2026!x") === "ok",
    masterLogin("  Sample-2026!x  ", "Sample-2026!x"));
  check("password is compared exactly (case-sensitive)",
    masterLogin("Sample-2026!x", "sample-2026!x") === "rejected",
    masterLogin("Sample-2026!x", "sample-2026!x"));
}

console.log("\n4. live sessions die when the PIN is cleared");
{
  // Clearing the property is how you disable master. If resume still resolved
  // the user, the account would stay usable for the rest of the token's life.
  check("unset -> _resolveUserById_ returns null (session revoked)",
    resolveMaster(null) === null, JSON.stringify(resolveMaster(null)));
  check("unset -> whitespace property also revokes",
    resolveMaster("  ") === null, JSON.stringify(resolveMaster("  ")));
  check("set -> master resolves with ALL permissions",
    (resolveMaster("Sample-2026!x") || {}).permissions === "ALL",
    JSON.stringify(resolveMaster("Sample-2026!x")));
}

console.log("\n5. login and resume agree");
{
  // A project where login is refused must not be one where a token still works,
  // and vice versa. Divergence here is how a "disabled" account stays alive.
  [null, "", "   ", "Sample-2026!x"].forEach(function (p) {
    const loginPossible = masterLogin(p, "x") !== "unset";
    const resumePossible = resolveMaster(p) !== null;
    check("prop " + JSON.stringify(p) + ": login/resume agree",
      loginPossible === resumePossible,
      "login=" + loginPossible + " resume=" + resumePossible);
  });
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
