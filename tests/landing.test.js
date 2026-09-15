// ホーム landing: first visit of the day wins over the remembered tab.
//
// The gap this closes is the person who never logs out — logout already clears
// sms_lastTab, so an explicit sign-out lands on ホーム anyway. What was left
// was the tab open overnight and refreshed in the morning, which would return
// straight to 寮管理 and never show the day's requests.
//
// Month and year boundaries are checked because the stamp is a YYYY-MM-DD string
// built by hand; an off-by-one there would either force ホーム every load or
// never force it at all, and both would look like "it just does that".

let store = {};
const localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
function landOn(now, lastTab) {
  if (lastTab === null) localStorage.removeItem('sms_lastTab');
  else localStorage.setItem('sms_lastTab', lastTab);
  let defaultTab = 'home';
  let firstOfDay = false;
  const d = now;
  const today = d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2);
  firstOfDay = localStorage.getItem('sms_lastSeenDay') !== today;
  localStorage.setItem('sms_lastSeenDay', today);
  const lt = firstOfDay ? null : localStorage.getItem('sms_lastTab');
  if (lt) defaultTab = lt;
  return defaultTab;
}
let p=0,f=0; const ck=(n,c,d)=>c?(p++,console.log("  PASS  "+n)):(f++,console.log("  FAIL  "+n+"\n        "+d));

store = {};
ck("first ever load -> home", landOn(new Date(2026,7,6,9,0), 'dorms') === 'home', "");
ck("same day, second load -> remembered tab", landOn(new Date(2026,7,6,14,0), 'dorms') === 'dorms', "");
ck("same day again -> still remembered", landOn(new Date(2026,7,6,17,0), 'dorms') === 'dorms', "");
ck("next morning -> home again", landOn(new Date(2026,7,7,8,0), 'dorms') === 'home', "");
ck("and later that day -> remembered", landOn(new Date(2026,7,7,13,0), 'dorms') === 'dorms', "");
// Crossing a month and a year boundary must still count as a new day.
store = {};
landOn(new Date(2026,7,31,23,0), 'dorms');
ck("Aug 31 -> Sep 1 is a new day", landOn(new Date(2026,8,1,0,30), 'dorms') === 'home', "");
store = {};
landOn(new Date(2026,11,31,23,0), 'dorms');
ck("Dec 31 -> Jan 1 is a new day", landOn(new Date(2027,0,1,0,30), 'dorms') === 'home', "");
// No remembered tab at all: home either way.
store = {};
ck("no remembered tab, first load -> home", landOn(new Date(2026,7,6,9,0), null) === 'home', "");
ck("no remembered tab, later -> home", landOn(new Date(2026,7,6,15,0), null) === 'home', "");
console.log(f===0 ? `\nALL ${p} CHECKS PASSED` : `\n${p} passed, ${f} FAILED`);
process.exitCode = f?1:0;
