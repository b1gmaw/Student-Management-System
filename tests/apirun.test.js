// apiRun() — the client-side chainable that replaced google.script.run.
//
// ⚠️ THIS SUITE EXISTS BECAUSE THE FIRST VERSION TOOK THE WHOLE APP DOWN ON
// STAGING. The handler setters returned the proxy's TARGET instead of the proxy:
//
//     const self = { withSuccessHandler: f => { ok = f; return self; }, … };
//     return new Proxy(self, { get: … });
//
// so `.withSuccessHandler(f)` handed back a plain object, and the `.method()`
// that followed was undefined. Every call carrying a handler died with a
// TypeError. Only the student list still rendered — it comes from the boot
// payload without a round trip, which is exactly what made the failure look
// selective rather than total.
//
// The chain shape is the contract. Assert it, not the internals.

let sent = null;
const google = { script: { run: (function mk(ok, fail) { return {
  withSuccessHandler: f => mk(f, fail),
  withFailureHandler: f => mk(ok, f),
  apiCall: (t, m, a) => { sent = { token: t, method: m, args: a, ok: !!ok, fail: !!fail }; }
}; })(null, null) } };
const localStorage = { getItem: () => "TOKEN123" };

function apiRun() {
  let ok = null, fail = null;
  const proxy = new Proxy({}, {
    get: function (t, prop) {
      if (prop === 'withSuccessHandler') return function (f) { ok = f; return proxy; };
      if (prop === 'withFailureHandler') return function (f) { fail = f; return proxy; };
      if (typeof prop !== 'string') return undefined;
      return function () {
        const args = Array.prototype.slice.call(arguments);
        let token = "";
        try { token = localStorage.getItem('sms_session') || ""; } catch (e) {}
        let r = google.script.run;
        if (ok) r = r.withSuccessHandler(ok);
        if (fail) r = r.withFailureHandler(fail);
        r.apiCall(token, prop, args);
      };
    }
  });
  return proxy;
}

let p = 0, f = 0;
const ck = (n, c, d) => c ? (p++, console.log("  PASS  " + n)) : (f++, console.log("  FAIL  " + n + "\n        " + d));

// The three shapes that actually appear in Index.html.
apiRun().withSuccessHandler(r => r).withFailureHandler(e => e).getDormData("master");
ck("success+failure chain reaches the method", sent && sent.method === "getDormData", JSON.stringify(sent));
ck("both handlers survive the chain", sent.ok && sent.fail, JSON.stringify(sent));
ck("the token is attached", sent.token === "TOKEN123", JSON.stringify(sent));
ck("args are passed as an array", Array.isArray(sent.args) && sent.args[0] === "master", JSON.stringify(sent.args));

sent = null;
apiRun().withFailureHandler(e => e).saveRecruitmentCount("master", "ALL", "2027年1月");
ck("failure-only chain works", sent && sent.method === "saveRecruitmentCount" && sent.fail && !sent.ok, JSON.stringify(sent));

sent = null;
apiRun().getSchedule("T1");
ck("no-handler call works", sent && sent.method === "getSchedule", JSON.stringify(sent));

sent = null;
const r2 = apiRun();
ck("a Symbol property does not fire a call", r2[Symbol.toPrimitive] === undefined && sent === null, "inspecting the object triggered a server call");

// Two runners must not share handler state.
sent = null;
const a = apiRun().withSuccessHandler(() => "A");
const b = apiRun();
b.getBuildingList("master");
ck("runners are independent", sent.ok === false, "handler leaked between apiRun() instances");
console.log(f === 0 ? "\nALL " + p + " CHECKS PASSED" : "\n" + p + " passed, " + f + " FAILED");
process.exitCode = f ? 1 : 0;
