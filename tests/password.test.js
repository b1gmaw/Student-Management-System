// Account login: email + hashed password, replacing plaintext PINs.
//
// The migration is self-completing: while a user has no hash, their old PIN works
// ONCE and forces a password set. The moment a hash exists that branch must stop
// applying to them — otherwise the PIN becomes a permanent second way in, which
// would defeat the entire change. §3 is where that is pinned.
//
// The hash itself is not exercised here (Utilities.* only exists in Apps Script);
// it is modelled as a pure function so the surrounding decisions can be tested.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// Stand-in for _hashPassword_ in §2-6: deterministic in (password, salt,
// iterations), which is the only property that logic depends on. §0 tests the
// REAL SHA-256 transcribed from Code.js.
function hash(password, salt, iterations) {
  return "s1$H(" + password + "|" + salt + "|" + (parseInt(iterations, 10) || 10000) + ")";
}

const PW_MIN_LENGTH = 8;

// Column indices, mirroring the master sheets.
const C = { id: 0, name: 1, pin: 2, email: 3, notif: 4, perms: 5,
            hash: 6, salt: 7, iters: 8, updated: 9, mustChange: 10 };

function row(o) {
  const r = new Array(11).fill("");
  Object.keys(o).forEach(function (k) { r[C[k]] = o[k]; });
  return r;
}

// Mirrors _verifyAccountPassword_, including the algorithm-tag dispatch.
const PW_ALGO_TAG = "s1";
function verify(r, password) {
  const h = String(r[C.hash] || "").trim();
  const salt = String(r[C.salt] || "").trim();
  const iters = String(r[C.iters] || "").trim();
  if (h !== "" && salt !== "") {
    if (h.indexOf(PW_ALGO_TAG + "$") !== 0) return { ok: false, mustSetPassword: false };
    const ok = hash(password, salt, iters) === h;
    return { ok: ok, mustSetPassword: ok && String(r[C.mustChange] || "").trim() === "Y" };
  }
  const legacyPin = String(r[C.pin] || "").trim();
  if (legacyPin !== "" && String(password) === legacyPin) return { ok: true, mustSetPassword: true };
  return { ok: false, mustSetPassword: false };
}

// Mirrors _findAccountByEmail_.
function findByEmail(sheets, email) {
  const want = String(email || "").trim().toLowerCase();
  if (want === "") return null;
  const names = Object.keys(sheets);
  for (let n = 0; n < names.length; n++) {
    const rows = sheets[names[n]];
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][C.email] || "").trim().toLowerCase() === want) {
        return { sheetName: names[n], rowIndex: i + 1, row: rows[i] };
      }
    }
  }
  return null;
}

// Mirrors _passwordProblem_.
function pwProblem(pw) {
  const v = String(pw == null ? "" : pw);
  if (v.length < PW_MIN_LENGTH) return "too-short";
  if (/^\s|\s$/.test(v)) return "whitespace";
  return "";
}

// ============================================================================
// §0. The real SHA-256, transcribed verbatim from Code.js.
//
// Code.js implements SHA-256 by hand because Utilities.computeHmacSha256Signature
// costs ~1.25ms per CALL in Apps Script — 10,000 iterations took 9 seconds there.
// Hand-writing a crypto primitive is only acceptable if it is verified rather
// than trusted, which is what this section is for: official NIST vectors, plus
// agreement with Node's own crypto across the padding boundaries where such
// implementations characteristically break.
// ============================================================================
const _SHA256_K = [
  0x428a2f98|0,0x71374491|0,0xb5c0fbcf|0,0xe9b5dba5|0,0x3956c25b|0,0x59f111f1|0,0x923f82a4|0,0xab1c5ed5|0,
  0xd807aa98|0,0x12835b01|0,0x243185be|0,0x550c7dc3|0,0x72be5d74|0,0x80deb1fe|0,0x9bdc06a7|0,0xc19bf174|0,
  0xe49b69c1|0,0xefbe4786|0,0x0fc19dc6|0,0x240ca1cc|0,0x2de92c6f|0,0x4a7484aa|0,0x5cb0a9dc|0,0x76f988da|0,
  0x983e5152|0,0xa831c66d|0,0xb00327c8|0,0xbf597fc7|0,0xc6e00bf3|0,0xd5a79147|0,0x06ca6351|0,0x14292967|0,
  0x27b70a85|0,0x2e1b2138|0,0x4d2c6dfc|0,0x53380d13|0,0x650a7354|0,0x766a0abb|0,0x81c2c92e|0,0x92722c85|0,
  0xa2bfe8a1|0,0xa81a664b|0,0xc24b8b70|0,0xc76c51a3|0,0xd192e819|0,0xd6990624|0,0xf40e3585|0,0x106aa070|0,
  0x19a4c116|0,0x1e376c08|0,0x2748774c|0,0x34b0bcb5|0,0x391c0cb3|0,0x4ed8aa4a|0,0x5b9cca4f|0,0x682e6ff3|0,
  0x748f82ee|0,0x78a5636f|0,0x84c87814|0,0x8cc70208|0,0x90befffa|0,0xa4506ceb|0,0xbef9a3f7|0,0xc67178f2|0
];
function _sha256Bytes_(bytes) {
  let h0=0x6a09e667|0,h1=0xbb67ae85|0,h2=0x3c6ef372|0,h3=0xa54ff53a|0,
      h4=0x510e527f|0,h5=0x9b05688c|0,h6=0x1f83d9ab|0,h7=0x5be0cd19|0;
  const len = bytes.length;
  const blocks = ((len + 8) >> 6) + 1;
  const m = new Int32Array(blocks * 16);
  for (let i = 0; i < len; i++) m[i >> 2] |= (bytes[i] & 0xff) << (24 - (i % 4) * 8);
  m[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  m[blocks * 16 - 1] = len * 8;
  const w = new Int32Array(64);
  for (let b = 0; b < blocks; b++) {
    for (let j = 0; j < 16; j++) w[j] = m[b * 16 + j];
    for (let j = 16; j < 64; j++) {
      const x = w[j-15], y = w[j-2];
      const s0 = ((x>>>7)|(x<<25)) ^ ((x>>>18)|(x<<14)) ^ (x>>>3);
      const s1 = ((y>>>17)|(y<<15)) ^ ((y>>>19)|(y<<13)) ^ (y>>>10);
      w[j] = (s0 + w[j-7] + s1 + w[j-16]) | 0;
    }
    let a=h0,b2=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;
    for (let j = 0; j < 64; j++) {
      const S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + _SHA256_K[j] + w[j]) | 0;
      const S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
      const maj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + maj) | 0;
      hh=g; g=f; f=e; e=(d+t1)|0; d=c; c=b2; b2=a; a=(t1+t2)|0;
    }
    h0=(h0+a)|0; h1=(h1+b2)|0; h2=(h2+c)|0; h3=(h3+d)|0;
    h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+hh)|0;
  }
  const out = new Array(32);
  const hs = [h0,h1,h2,h3,h4,h5,h6,h7];
  for (let i = 0; i < 8; i++) {
    out[i*4]=(hs[i]>>>24)&0xff; out[i*4+1]=(hs[i]>>>16)&0xff;
    out[i*4+2]=(hs[i]>>>8)&0xff; out[i*4+3]=hs[i]&0xff;
  }
  return out;
}
function _utf8Bytes_(str) {
  const s = String(str); let out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0|(c>>6), 0x80|(c&63)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i+1);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0|(cp>>18), 0x80|((cp>>12)&63), 0x80|((cp>>6)&63), 0x80|(cp&63));
      i++;
    } else { out.push(0xe0|(c>>12), 0x80|((c>>6)&63), 0x80|(c&63)); }
  }
  return out;
}
const toHex = (b) => b.map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
const sha256hex = (s) => toHex(_sha256Bytes_(_utf8Bytes_(s)));

console.log("\n0. SHA-256 — verified, not trusted");
{
  const nodeCrypto = require("crypto");
  const ref = (s) => nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");

  // Official FIPS 180-4 / NIST vectors.
  check('NIST: "" (empty)',
    sha256hex("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    sha256hex(""));
  check('NIST: "abc"',
    sha256hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    sha256hex("abc"));
  check('NIST: 448-bit two-block message',
    sha256hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ===
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    sha256hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"));

  // The padding boundary: a 64-byte block holds the message plus 0x80 plus an
  // 8-byte length, so 56+ bytes forces an extra block. This is where
  // hand-written SHA-256 goes wrong, and none of the NIST vectors above sit here.
  let boundaryOk = true, firstBad = "";
  for (let n = 0; n <= 130; n++) {
    const s = "a".repeat(n);
    if (sha256hex(s) !== ref(s)) { boundaryOk = false; firstBad = "length " + n; break; }
  }
  check("matches node crypto for every length 0-130 (spans 55/56/64/119/120)",
    boundaryOk, "first mismatch at " + firstBad);

  check("matches node crypto on multi-byte UTF-8 (日本語)",
    sha256hex("○○日本語学校") === ref("○○日本語学校"), sha256hex("○○日本語学校"));
  check("matches node crypto on an emoji (surrogate pair)",
    sha256hex("pass🔐word") === ref("pass🔐word"), sha256hex("pass🔐word"));
  check("matches node crypto on a long input (1000 chars)",
    sha256hex("x".repeat(1000)) === ref("x".repeat(1000)), "mismatch");

  check("output is always 32 bytes", _sha256Bytes_(_utf8Bytes_("anything")).length === 32,
    String(_sha256Bytes_(_utf8Bytes_("anything")).length));
  check("every byte is in range 0-255",
    _sha256Bytes_(_utf8Bytes_("anything")).every(function (b) { return b >= 0 && b <= 255; }),
    "byte out of range — a sign extension bug");

  // Chaining is what provides the stretching.
  const chain = function (n) {
    let b = _sha256Bytes_(_utf8Bytes_("seed"));
    for (let i = 1; i < n; i++) b = _sha256Bytes_(b.concat(_utf8Bytes_("salt")));
    return toHex(b);
  };
  check("chaining is deterministic", chain(50) === chain(50), "not deterministic");
  check("N and N+1 iterations differ", chain(50) !== chain(51), "iteration count had no effect");
}

console.log("\n1. Hash inputs");
{
  check("same password + salt + iterations is stable",
    hash("hunter2xx", "S1", 10000) === hash("hunter2xx", "S1", 10000), "not deterministic");
  check("a different salt gives a different hash for the same password",
    hash("hunter2xx", "S1", 10000) !== hash("hunter2xx", "S2", 10000),
    "two users with the same password would share a hash");
  // Iterations are stored per row so PW_ITERATIONS can be raised later without
  // invalidating everyone's existing password.
  check("iteration count is part of the hash",
    hash("hunter2xx", "S1", 10000) !== hash("hunter2xx", "S1", 25000), "iterations ignored");
  check("verification uses the ROW's iteration count, not the current constant",
    verify(row({ hash: hash("hunter2xx", "S1", 5000), salt: "S1", iters: "5000" }), "hunter2xx").ok,
    "a row written at an older iteration count stopped verifying");
}

console.log("\n2. Password verification");
{
  const r = row({ hash: hash("hunter2xx", "S1", 10000), salt: "S1", iters: "10000" });
  check("correct password accepted", verify(r, "hunter2xx").ok, "rejected");
  check("wrong password rejected", !verify(r, "hunter2xy").ok, "accepted");
  check("empty password rejected", !verify(r, "").ok, "accepted");
  check("no forced change when the flag is clear", !verify(r, "hunter2xx").mustSetPassword, "flagged");

  const forced = row({ hash: hash("temp1234abcd", "S9", 10000), salt: "S9", iters: "10000", mustChange: "Y" });
  check("PwMustChange forces a set after a correct password",
    verify(forced, "temp1234abcd").mustSetPassword, "not flagged");
  check("PwMustChange does not rescue a wrong password",
    !verify(forced, "nope").ok, "accepted");

  // Algorithm tag. Verification must FAIL CLOSED on anything it did not produce,
  // so a future algorithm change forces a reset rather than silently comparing
  // against a hash computed a different way.
  check("a correctly tagged hash verifies", verify(r, "hunter2xx").ok, "rejected");
  const untagged = row({ hash: "H(hunter2xx|S1|10000)", salt: "S1", iters: "10000" });
  check("an UNTAGGED hash is rejected", !verify(untagged, "hunter2xx").ok,
    "a pre-tag hash was accepted — a future algorithm change would silently mis-verify");
  const wrongTag = row({ hash: "s2$H(hunter2xx|S1|10000)", salt: "S1", iters: "10000" });
  check("a hash with a DIFFERENT tag is rejected", !verify(wrongTag, "hunter2xx").ok,
    "must fail closed on an unknown algorithm");
  check("the tag alone is not enough — the digest still has to match",
    !verify(row({ hash: "s1$nonsense", salt: "S1", iters: "10000" }), "hunter2xx").ok,
    "tagged garbage was accepted");
}

console.log("\n3. Legacy PIN — works once, then never again");
{
  const legacy = row({ pin: "1234" });
  const v = verify(legacy, "1234");
  check("old PIN logs in while no hash exists", v.ok, "rejected");
  check("...and forces a password set", v.mustSetPassword, "not forced");
  check("a wrong PIN is still rejected", !verify(legacy, "9999").ok, "accepted");

  // THE property this whole design rests on.
  const migrated = row({ pin: "1234", hash: hash("newpassword1", "S2", 10000), salt: "S2", iters: "10000" });
  check("once a hash exists the old PIN STOPS working",
    !verify(migrated, "1234").ok,
    "the PIN would remain a permanent second way in — the change would be pointless");
  check("...and the new password works", verify(migrated, "newpassword1").ok, "rejected");

  // _writeAccountPassword_ blanks column 2, so this is the normal end state.
  const cleaned = row({ hash: hash("newpassword1", "S2", 10000), salt: "S2", iters: "10000" });
  check("a blank PIN cannot be used to log in", !verify(cleaned, "").ok, "empty password accepted");

  const noCreds = row({ id: "STAFF9" });
  check("an account with neither PIN nor hash cannot log in at all",
    !verify(noCreds, "").ok && !verify(noCreds, "anything").ok,
    "a new user with no password should be unable to log in until one is issued");
}

console.log("\n4. Email lookup");
{
  const sheets = {
    Staff_Master: [["ID"], row({ id: "S1", email: "staff.a@example.jp" }), row({ id: "S2", email: "Staff.B@Example.JP" })],
    Teacher_Master: [["ID"], row({ id: "T1", email: "  teacher.a@example.jp  " })],
  };
  check("exact match", findByEmail(sheets, "staff.a@example.jp").row[C.id] === "S1", "miss");
  check("case-insensitive", findByEmail(sheets, "STAFF.B@EXAMPLE.JP").row[C.id] === "S2", "miss");
  check("stored value is trimmed", findByEmail(sheets, "teacher.a@example.jp").row[C.id] === "T1", "miss");
  check("submitted value is trimmed", findByEmail(sheets, "  staff.a@example.jp ").row[C.id] === "S1", "miss");
  check("searches both sheets", findByEmail(sheets, "teacher.a@example.jp").sheetName === "Teacher_Master", "wrong sheet");
  check("unknown email returns null", findByEmail(sheets, "nobody@example.jp") === null, "matched");
  check("empty email returns null rather than matching a blank row",
    findByEmail(sheets, "") === null, "an empty email must never match");
  check("whitespace-only email returns null", findByEmail(sheets, "   ") === null, "matched");
}

console.log("\n5. Password rules");
{
  check("minimum length is 8", PW_MIN_LENGTH === 8, String(PW_MIN_LENGTH));
  check("rejects 7 characters", pwProblem("1234567") === "too-short", pwProblem("1234567"));
  check("accepts exactly 8", pwProblem("12345678") === "", pwProblem("12345678"));
  check("rejects an old 4-digit PIN as a new password", pwProblem("1234") === "too-short", pwProblem("1234"));
  check("rejects empty", pwProblem("") === "too-short", pwProblem(""));
  check("rejects null", pwProblem(null) === "too-short", pwProblem(null));
  check("rejects leading whitespace", pwProblem(" password") === "whitespace", pwProblem(" password"));
  check("rejects trailing whitespace", pwProblem("password ") === "whitespace", pwProblem("password "));
  check("allows spaces inside", pwProblem("correct horse") === "", pwProblem("correct horse"));
}

console.log("\n6. completePasswordSetup is not a back door");
{
  // It skips the current-password check, so it must refuse any account that is
  // not actually in a must-set state — otherwise anyone with a session token
  // could reset their own password without knowing the old one.
  function allowSetup(r) {
    const hasHash = String(r[C.hash] || "").trim() !== "";
    const mustChange = String(r[C.mustChange] || "").trim() === "Y";
    return !(hasHash && !mustChange);
  }
  check("allowed for a legacy user with no hash", allowSetup(row({ pin: "1234" })), "refused");
  check("allowed after an admin reset",
    allowSetup(row({ hash: "H", salt: "S", mustChange: "Y" })), "refused");
  check("REFUSED for a normal account with a password already set",
    !allowSetup(row({ hash: "H", salt: "S" })),
    "would let a session holder change their password without knowing the current one");
}

console.log("\n7. Admin-issued temporary passwords come from a CSPRNG");
{
  // ⚠️ This used to be Math.random(), while _newSalt_ three lines above it had
  // always used Utilities.getUuid(). Not demonstrably exploitable — each Apps
  // Script execution is a fresh V8 isolate, so there is no output sequence to
  // recover the PRNG state from — but a credential should not come from a
  // non-CSPRNG, and the fix cost nothing.
  const fs2 = require('fs');
  const CODE2 = fs2.readFileSync(require('path').join(__dirname, '..', 'Code.js'), 'utf8');
  const at = CODE2.indexOf('function _tempPassword_()');
  const body = CODE2.slice(at, CODE2.indexOf('\n}', at));
  check("_tempPassword_'s body was located", at !== -1 && body.length > 100,
    "the anchor moved — every assertion below is vacuous until this passes");
  check("no Math.random anywhere in it", body.indexOf('Math.random') === -1,
    "a credential drawn from a non-cryptographic PRNG");
  check("it draws from Utilities.getUuid", /Utilities\.getUuid\(\)/.test(body), "");
  check("it still produces 12 characters", /s\.length < 12/.test(body), "");
  check("it still draws from TEMP_PW_ALPHABET", /TEMP_PW_ALPHABET\.charAt/.test(body), "");

  // ⚠️ Rejection sampling, not a modulo. 256 % 56 is 32, so `byte % 56` would
  // make the first 32 characters of the alphabet ~25% more likely than the rest.
  check("it rejects out-of-range bytes rather than folding them",
    /const limit = Math\.floor\(256 \/ n\) \* n;/.test(body) && /if \(b < limit\)/.test(body),
    "a bare modulo biases the low third of the alphabet");
  // ⚠️ And rejection means the byte pool can run dry, so it must top itself up —
  // otherwise the while loop spins forever and the reset never returns.
  check("the pool tops itself up so the loop cannot hang",
    /if \(pool\.length < 2\) pool \+= Utilities\.getUuid\(\)/.test(body),
    "rejected bytes exhaust a fixed pool; an empty pool here is an infinite loop");

  // Transcribed, to prove the sampler actually yields the alphabet and length.
  const ALPHABET = (CODE2.match(/const TEMP_PW_ALPHABET = "([^"]+)"/) || [])[1] || "";
  check("the alphabet excludes look-alike characters",
    ALPHABET.length === 56 && !/[l1IO0]/.test(ALPHABET),
    "got " + ALPHABET.length + " chars: " + ALPHABET);
  const n = ALPHABET.length, limit = Math.floor(256 / n) * n;
  let hex = "", pool = "", s = "";
  let seed = 12345;
  const fakeUuid = function () {   // deterministic stand-in for getUuid
    let out = "";
    for (let i = 0; i < 32; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += "0123456789abcdef".charAt(seed % 16); }
    return out;
  };
  while (s.length < 12) {
    if (pool.length < 2) pool += fakeUuid();
    const b = parseInt(pool.substring(0, 2), 16);
    pool = pool.substring(2);
    if (b < limit) s += ALPHABET.charAt(b % n);
  }
  check("the sampler yields 12 characters", s.length === 12, s);
  check("every character is in the alphabet",
    s.split('').every(function (c) { return ALPHABET.indexOf(c) !== -1; }), s);
  check("no byte at or above the limit is ever used", limit === 224 && 256 % n === 32,
    "limit " + limit + ", remainder " + (256 % n) + " — the bias this avoids");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
