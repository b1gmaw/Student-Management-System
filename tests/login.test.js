// Login brute-force limits, read from Code.js (not transcribed).
//
// ⚠️ Until 2026-10-26 this file transcribed an escalating GLOBAL delay (1.5s → 8s cap) and tested
// the transcription, never the source. That design did not hold: a delay slows one request, not
// thirty parallel ones, and every sleeping failure held one of the deployer's executions. The
// limit is now per ACCOUNT, and tests/authz.test.js §7 runs the real loginUser against it. This
// file pins the constants from the source and states, in numbers, what the limit does and does
// not buy.

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'Code.js'), 'utf8');
const num = function (name) {
  const m = SRC.match(new RegExp('\\nconst ' + name + '\\s+=\\s*(\\d+)'));
  return m ? Number(m[1]) : NaN;
};
const LOGIN_FAIL_DELAY_MS = num('LOGIN_FAIL_DELAY_MS');
const LOGIN_ACCOUNT_MAX = num('LOGIN_ACCOUNT_MAX');
const LOGIN_ACCOUNT_WINDOW = num('LOGIN_ACCOUNT_WINDOW');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

console.log("\n1. the limit's constants, from the source");
{
  check("a per-account limit exists", LOGIN_ACCOUNT_MAX > 0 && LOGIN_ACCOUNT_WINDOW > 0,
    LOGIN_ACCOUNT_MAX + " / " + LOGIN_ACCOUNT_WINDOW);
  check("a typo or three never trips it", LOGIN_ACCOUNT_MAX >= 4, String(LOGIN_ACCOUNT_MAX));
  check("a refusal lasts minutes, not hours (it can be aimed at a colleague)",
    LOGIN_ACCOUNT_WINDOW <= 1800, LOGIN_ACCOUNT_WINDOW + "s");
}

console.log("\n2. the delay is flat and short: it no longer does the limiting");
{
  check("one flat delay of at most 1.5s", LOGIN_FAIL_DELAY_MS > 0 && LOGIN_FAIL_DELAY_MS <= 1500, String(LOGIN_FAIL_DELAY_MS));
  // An escalating delay is what held executions under a flood (finding 4).
  check("⚠️ no escalation remains", !/LOGIN_FAIL_ESCALATE_AT|LOGIN_FAIL_MAX_DELAY_MS/.test(SRC), "");
}

console.log("\n3. the limit sits BEFORE anything reads a sheet or a password");
{
  const body = (SRC.match(/\nfunction loginUser\([\s\S]*?\n\}\n/) || [""])[0];
  const r = body.indexOf('_reserveLoginAttempt_(id, '), s = body.indexOf('_systemPin_()'),
        f = body.indexOf('_findAccountByEmail_(id)');
  check("reserved first", r !== -1 && r < s && r < f, r + " / " + s + " / " + f);
}

console.log("\n4. honest limit: what the per-account rate buys");
{
  // Parallel requests no longer help: the rate is per account, whatever the concurrency.
  const perDay = LOGIN_ACCOUNT_MAX * (86400 / LOGIN_ACCOUNT_WINDOW);
  const days = function (combos) { return combos / perDay; };
  console.log("        guesses per account per day: " + perDay);
  console.log("        top-1,000 common passwords: " + days(1000).toFixed(1) + " days per account");
  console.log("        8-digit PIN: " + (days(1e8) / 365).toFixed(0) + " years");
  check("one account gets at most a few hundred guesses a day", perDay <= 1000, String(perDay));
  // ⚠️ The limit does NOT save a common password: a top-1,000 list falls in days. That is why
  // _commonPasswordProblem_ refuses them when a password is set (2026-10-26, authz.test §10).
  // A password set BEFORE that rule is only as safe as it was then; it applies on the next change.
  check("a common-password list still falls within a week (stated, not hidden)", days(1000) < 7,
    days(1000).toFixed(1) + " days");
  check("an 8-digit PIN is out of reach", days(1e8) / 365 > 100, (days(1e8) / 365).toFixed(0) + " years");
}

console.log("\n6. setSystemPin validation");
{
  // Transcribed from Code.js setSystemPin. Staff PINs here include a long one,
  // because a 4-digit staff PIN can never collide with an 8-character minimum —
  // the collision rule only bites once somebody's own PIN is long too.
  const SYSTEM_PIN_MIN_LENGTH = 8;
  const STAFF_PINS = ["1234", "4321", "sakura2026"];

  function validate(newPin) {
    const v = String(newPin == null ? "" : newPin).trim();
    if (v.length < SYSTEM_PIN_MIN_LENGTH) return "too-short";
    if (STAFF_PINS.indexOf(v) !== -1) return "collision";
    return "ok";
  }

  check("minimum length is 8", SYSTEM_PIN_MIN_LENGTH === 8, String(SYSTEM_PIN_MIN_LENGTH));
  check("rejects a 4-digit PIN", validate("4242") === "too-short", validate("4242"));
  check("rejects empty", validate("") === "too-short", validate(""));
  check("rejects null", validate(null) === "too-short", validate(null));
  check("rejects undefined", validate(undefined) === "too-short", validate(undefined));
  check("rejects 7 characters", validate("1234567") === "too-short", validate("1234567"));
  check("accepts exactly 8", validate("12345678") === "ok", validate("12345678"));
  check("whitespace is trimmed before the length test",
    validate("  abc   ") === "too-short", validate("  abc   "));
  check("accepts a normal long value", validate("Sample-2026") === "ok", validate("Sample-2026"));

  // The one that matters. _resolveUserByPin tests the master PIN FIRST and
  // returns immediately, so a master PIN equal to somebody's staff PIN would
  // hand that person master access — and they would never reach their own row,
  // so nothing would look wrong from their side either.
  check("rejects a value matching an existing staff PIN",
    validate("sakura2026") === "collision", validate("sakura2026"));
  check("a value merely similar to a staff PIN is fine",
    validate("sakura2027") === "ok", validate("sakura2027"));
  check("the collision test runs after the length test",
    validate("1234") === "too-short",
    "a short staff PIN should be rejected for length, not reported as a collision");
}

// ---------------------------------------------------------------------------
console.log("\n7. Sessions expire — transcribed from Code.js _sessionExpired_");
{
  // Tokens used to live forever: nothing ever read the LastSeen column that had
  // been written for months, so a token in localStorage on a shared machine was
  // a permanent credential.
  const SESSION_MAX_AGE_DAYS = 30;
  const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  function _sessionAgeMs_(lastSeen, now) {
    const s = String(lastSeen == null ? "" : lastSeen).trim();
    if (s === "") return -1;
    const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return -1;
    const t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    if (isNaN(t)) return -1;
    return now - t;
  }
  function _sessionExpired_(lastSeen, now) {
    const age = _sessionAgeMs_(lastSeen, now);
    return age >= 0 && age > SESSION_MAX_AGE_MS;
  }

  const NOW = new Date(2026, 7, 19, 12, 0, 0).getTime();   // 2026-08-19 12:00
  const daysAgo = function (d) {
    const t = new Date(NOW - d * 24 * 60 * 60 * 1000);
    const p = function (n) { return (n < 10 ? "0" : "") + n; };
    return t.getFullYear() + "/" + p(t.getMonth() + 1) + "/" + p(t.getDate()) +
           " " + p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds());
  };

  check("a session used today is valid", !_sessionExpired_(daysAgo(0), NOW), "");
  check("29 days idle is still valid", !_sessionExpired_(daysAgo(29), NOW), daysAgo(29));
  check("31 days idle is expired", _sessionExpired_(daysAgo(31), NOW), daysAgo(31));
  check("a year idle is expired", _sessionExpired_(daysAgo(365), NOW), "");

  // ⚠️ The boundary itself. Off-by-one here is the difference between "expires
  // after a month" and "expires a day early for everyone", and nobody would
  // notice the second one except as mysterious logouts.
  check("exactly 30 days is NOT yet expired",
    !_sessionExpired_(daysAgo(30), NOW),
    "the comparison must be > MAX_AGE, not >=");

  // ⚠️ Both must FAIL OPEN. Signing out every member of staff at once because a
  // date printed in an unexpected shape is far worse than one stale token
  // outliving its window, and the failure would be invisible from the inside.
  check("a blank LastSeen is not treated as expired",
    !_sessionExpired_("", NOW),
    "rows predating the column would log those people out with no explanation");
  check("an unparseable LastSeen is not treated as expired",
    !_sessionExpired_("last tuesday", NOW) && !_sessionExpired_("19/08/2026", NOW),
    "fail open — an unanticipated locale format must not become a mass logout");

  // FORMATTED_STRING renders per the spreadsheet's locale, so the parser takes
  // both separators and tolerates a missing time.
  check("ISO-style separators parse too", _sessionExpired_("2020-01-01 09:00:00", NOW), "");
  check("a date with no time parses", _sessionExpired_("2020/01/01", NOW), "");

  // The renewal is sliding, and SESSION_TOUCH_WINDOW is its granularity.
  const SESSION_TOUCH_WINDOW = 21600;   // 6h, from Code.js
  check("the touch window is far inside the expiry window",
    SESSION_TOUCH_WINDOW * 1000 * 4 < SESSION_MAX_AGE_MS,
    "LastSeen is only rewritten once per touch window, so bringing the two " +
    "close together logs out users who are actively working");

  // Source assertions — the transcription above is worthless if the real code
  // stopped calling it, which is exactly how a guard goes quietly dead.
  const fs2 = require('fs');
  const CODE = fs2.readFileSync(require('path').join(__dirname, '..', 'Code.js'), 'utf8');

  // ⚠️ Scoped to resumeSession's OWN body. Written against the whole file these
  // matched _pruneExpiredSessions instead — which also calls _sessionExpired_ on
  // data[i][5] — so they stayed green with the check ripped out of resumeSession
  // entirely. Caught by mutation; the same "assertion measures the wrong thing"
  // failure the uploadedfile suite hit.
  // ⚠️ RE-PINNED 2026-09-11: the decision moved into _sessionLookup_(token, touch), which
  // resumeSession wraps and checkSession shares. Every property below is asserted where the
  // decision now lives — and that resumeSession still reaches it WITH the touch.
  check("resumeSession is the touching wrapper around the one decision",
    /function resumeSession\(token\) \{\s*return _sessionLookup_\(token, true\);\s*\}/.test(CODE), "");
  const rsAt = CODE.indexOf('function _sessionLookup_(');
  const RS = CODE.slice(rsAt, CODE.indexOf('\n}', rsAt));
  check("resumeSession's body was located", rsAt !== -1 && RS.length > 200,
    "the anchor moved — every assertion below is meaningless until this passes");
  // ⚠️ RE-PINNED 2026-09-11: judged by _sessionSeenOf_ (LastSeen, else Created), and deleted by
  // TOKEN under the lock — a remembered row number goes stale the moment another request deletes.
  check("resumeSession actually checks expiry",
    /_sessionExpired_\(_sessionSeenOf_\(data\[i\]\), Date\.now\(\)\)/.test(RS),
    "the helper exists but resumeSession does not call it");
  check("the expiry check runs BEFORE _authUser is parked",
    RS.indexOf('_sessionExpired_(_sessionSeenOf_(data[i])') !== -1 &&
    RS.indexOf('_sessionExpired_(_sessionSeenOf_(data[i])') < RS.indexOf('_authUser = user;'),
    "parking an expired session makes it live for every guard in the file");
  check("expired rows are deleted, not just refused — by token",
    /_sessionExpired_\(_sessionSeenOf_\(data\[i\]\)[\s\S]{0,200}?_deleteSessionByToken_\(token\)/.test(RS), "");
  // ⚠️ RE-PINNED 2026-09-11: the per-row prune became ONE-PASS compaction (_compactSessions_),
  // which also normalises dates and applies the per-account cap. It never ran at all before:
  // month-first dates made every row "unreadable", i.e. current.
  const IS = CODE.slice(CODE.indexOf('function _issueSessionToken_('), CODE.indexOf('\n}', CODE.indexOf('function _issueSessionToken_(')));
  check("login compacts sessions, under the lock, AFTER appending its own row",
    /_withSessionLock_\(10000, function \(\) \{\s*sh\.appendRow\([\s\S]{0,120}\);\s*_compactSessions_\(sh, Date\.now\(\)\);/.test(IS),
    "without this the Sessions sheet still grows without bound");

  // ⚠️ The prune runs inside _issueSessionToken_, on loginUser's critical path,
  // and Sessions had never been pruned before — so the first login after this
  // shipped met the whole backlog, one Sheets call per row. Unbounded, that is a
  // login that hangs and then times out, and an execution timeout is not
  // catchable. The transcription above cannot see an unbounded loop; only this
  // source assertion can.
  // The login-path stall this section guarded against is now impossible by construction: the
  // compaction is one read and at most two writes, however large the backlog, and never a
  // deleteRow per row.
  // Comments stripped: the function's own comment explains WHY it avoids deleteRow.
  const CS = CODE.slice(CODE.indexOf('function _compactSessions_('), CODE.indexOf('\n}', CODE.indexOf('function _compactSessions_(')))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check("compaction never deletes row by row (the stall the old cap bounded)",
    CS.length > 200 && !/deleteRow/.test(CS) && (CS.match(/\.getValues\(\)/g) || []).length === 1,
    "a deleteRow per expired row on the login path can time out the execution");
  check("SESSION_MAX_AGE_DAYS is still " + SESSION_MAX_AGE_DAYS,
    new RegExp("const SESSION_MAX_AGE_DAYS = " + SESSION_MAX_AGE_DAYS + ";").test(CODE),
    "the transcription above is pinned to this number");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
