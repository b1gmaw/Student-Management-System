#!/usr/bin/env node
// Render Index.html locally, with the Apps Script backend stubbed out.
//
// WHY THIS EXISTS
// This app only "runs" inside Google's infrastructure: HtmlService serves
// Index.html in a sandboxed iframe and injects google.script.run, which is the
// only bridge to Code.js. There is no local runtime — you cannot npm start it.
//
// But the frontend is ONE self-contained HTML file, and google.script.run is a
// small, uniform API. Stub it, serve the file over http, and the entire UI
// renders in headless chromium: every tab, every modal, both themes, any
// viewport. That is enough to see layout and to answer "where did this element
// actually land", which is the question that costs the most round trips.
//
// ⚠️ FIXTURES ARE SYNTHETIC AND MUST STAY THAT WAY. The real spreadsheet holds
// ~600 students' records. Never point this at live data and never paste real
// rows in here — the screenshots it writes are ordinary files on disk.
//
// Usage:  node .claude/skills/run-local/driver.mjs <command> [options]
//   shot   [--tab home] [--sub recruit] [--call "stuOpenGender()"] [--hover "#sel"] [--vp …] [--dark] [--out f.png]
//   probe  [--vp phone] [--tab students]     computed styles for the nav
//   tabs   [--vp phone]                      screenshot every tab in one go
//   overflow [--vp phone] [--tab students]   name the elements poking past the viewport
//   errors [--vp phone]                      boot and print console errors only
//
// Exit code is non-zero if the page threw during boot, so it works in a chain.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const UNIT = path.resolve(SKILL_DIR, '../../..');
const INDEX = path.join(UNIT, 'Index.html');
const OUTDIR = path.join(SKILL_DIR, 'shots');

const VIEWPORTS = {
  phone:   { width: 390, height: 844 },   // iPhone 14-ish, below the 820px breakpoint
  tablet:  { width: 820, height: 1180 },  // exactly ON the breakpoint — the boundary case
  desktop: { width: 1440, height: 900 },
};

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0] || 'shot';
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : (argv[i + 1] || dflt);
};
const flag = (name) => argv.includes('--' + name);

// ---- the stub ---------------------------------------------------------------
// google.script.run is a chained builder: .withSuccessHandler(f).withFailureHandler(g).method(args).
// Everything in Index.html goes through apiRun(), which wraps exactly that shape,
// so one Proxy covers all ~150 endpoints. Unlisted methods resolve to null, which
// every caller here tolerates (they all guard their payloads).
function makeInitScript(fixtures, dark) {
  return `
    (function () {
      const FIX = ${JSON.stringify(fixtures)};
      // Exposed so --call can seed state the default fixtures deliberately leave empty (ホーム's
      // notifications: filling the boot bundle would put a bell badge on EVERY tab's screenshot).
      window.__FIX = FIX;
      try { localStorage.setItem('sms_session', 'LOCAL-DRIVER-TOKEN'); } catch (e) {}
      // ⚠️ Dark mode is a localStorage flag the app reads in applySavedTheme(), NOT
      // prefers-color-scheme. Setting the browser's colorScheme alone renders light
      // and looks like the flag is broken.
      try { localStorage.setItem('sms_theme', ${JSON.stringify(dark ? 'dark' : 'light')}); } catch (e) {}

      // ⚠️ ONE CHAIN PER CALL. ok/fail live in this closure, so a single shared
      // builder leaks a caller's success handler into the next call that registers
      // only a failure handler — google.script.run does no such thing. See the
      // getter on window.google.script.run below.
      function builder() {
        let ok = null, fail = null;
        const proxy = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'withSuccessHandler') return (f) => { ok = f; return proxy; };
            if (prop === 'withFailureHandler') return (f) => { fail = f; return proxy; };
            if (typeof prop !== 'string') return undefined;
            return function (...args) {
              const name = (prop === 'apiCall') ? String(args[1] || '') : prop;
              // apiRun() posts apiCall(token, method, [args…]); a direct
              // google.script.run.foo(a, b) passes them positionally.
              const cargs = (prop === 'apiCall') ? (args[2] || []) : args;
              // async, like the real thing — code that assumes synchronous
              // completion is a bug worth surfacing here rather than in Safari
              setTimeout(() => {
                try {
                  let v = Object.prototype.hasOwnProperty.call(FIX, name) ? FIX[name] : null;
                  // ⚠️ Set window.__sessionDead = true to make every apiCall answer the way the
                  // server does for a revoked or expired session. The stub's session otherwise
                  // never dies, so this is the only way to reach _forceLogout locally.
                  if (prop === 'apiCall' && window.__sessionDead) throw new Error('セッションが無効です。再度ログインしてください。');
                  // The idle check. window.__sessionAlive = false answers "dead".
                  if (name === 'checkSession') v = { alive: window.__sessionAlive !== false };
                  // The バックアップ pane's three states: fresh (default), stale, never run.
                  if (name === 'getSnapshotList' && v) {
                    if (window.__backupNever) v = Object.assign({}, v, { scheduled: null });
                    else if (window.__backupStale) v = Object.assign({}, v, { scheduled: Object.assign({}, v.scheduled, { atMs: Date.now() - 20 * 3600 * 1000 }) });
                  }
                  // ⚠️ saveRecruitmentBatch answers ONE RESULT PER OP, in order —
                  // its reply depends on what was sent, which a static fixture
                  // cannot express. Set window.__recBatchFailAt to an index to make
                  // that op fail, which is the only way to reach the partial-failure
                  // path where the saved rows clear and the rest stay marked.
                  // ⚠️ Answers PER STUDENT. A single static row cannot express the edit
                  // round trip, which is the thing that was broken: 入学期 must come back
                  // into the form and go out again in the save payload.
                  if (name === 'shinsei_getStudentDataForEdit') {
                    v = (FIX.shinsei_getStudentDataForEdit || {})[String(cargs[0] || '')] || null;
                  }
                  // ⚠️ Answers PER INTAKE. The country list is no longer shared across
                  // intakes, and a single static addedCountries cannot show that — switching
                  // intake would render an identical grid and the change would look like a
                  // no-op locally. 二郎's intake deliberately has a SHORTER list, which is
                  // the state a user reaches by pruning one intake and not the others.
                  if (name === 'getRecruitmentBundle') {
                    const want = String(cargs[2] || '') || v.data.resolvedIntake;
                    const per = FIX.__recCountriesByIntake || {};
                    v = Object.assign({}, v, {
                      data: Object.assign({}, v.data, {
                        resolvedIntake: want,
                        addedCountries: per[want] || v.data.addedCountries,
                      }),
                    });
                  }
                  // ⚠️ Set window.__pwResetFail = true to make the reset FAIL. The case worth
                  // reaching is save-succeeded-but-reset-failed: the new user EXISTS and cannot
                  // log in, and the editor must say exactly that rather than show success.
                  if (name === 'adminResetPassword') {
                    if (window.__pwResetFail) throw new Error('テスト用の失敗');
                    v = { tempPassword: 'k7Q-3fPm-92x' };
                  }
                  if (name === 'saveRecruitmentBatch') {
                    const sent = cargs[3] || [];
                    const failAt = window.__recBatchFailAt;
                    window.__recBatchOps = sent;
                    let nextRow = 90;
                    const results = sent.map((op, i) => (i === failAt)
                      ? { ok: false, error: 'テスト用の失敗' }
                      : (String(op && op.t || '').indexOf('add') === 0
                          ? { ok: true, value: { added: true, sheetRow: nextRow++, no: 9 } }
                          : { ok: true }));
                    const bad = results.filter((r) => !r.ok).length;
                    v = { results, okCount: results.length - bad, failCount: bad };
                  }
                  if (ok) ok(v);
                } catch (e) {
                  if (fail) fail(e); else console.error('[stub] handler threw', e);
                }
              }, 0);
            };
          }
        });
        return proxy;
      }
      window.google = {
        script: {
          get run() { return builder(); },
          host: { close() {} },
        },
      };
    })();
  `;
}

// ⚠️ Who the app boots as. The default is `master`, which sees EVERYTHING — so it
// cannot show a permission-gated screen being wrongly hidden, and that is exactly the
// class of bug this app keeps hitting (a flagged 営業 could not see ユーザー管理).
// `--as <persona>` swaps the boot user; the personas mirror real shapes.
//
// ⚠️ isAdmin is the SERVER's decision, mirrored onto the client — never re-derived
// from the role name. A flagged persona therefore sets isAdmin true while its role
// and label stay its department, which is the whole point of 管理者権限.
const PERSONAS = {
  master:       { id: 'LOCAL01', name: 'ドライバ 太郎',   role: 'master',  roleLabel: 'マスター', permissions: 'ALL', isAdmin: true },
  // The reported bug: admin-level, but ticked for almost nothing. Before the override
  // this persona could not see ユーザー管理; now it must.
  'sales-admin':{ id: 'S01',     name: 'サンプル 一郎',   role: 'sales',   roleLabel: '営業',     permissions: 'view_students', isAdmin: true },
  sales:        { id: 'S05',     name: 'サンプル 五郎',   role: 'sales',   roleLabel: '営業',     permissions: 'view_students', isAdmin: false },
  // ⚠️ Role stays literally 'teacher' — that is what keeps currentTeacherId and their
  // own 面接スケジュール working while they hold admin level.
  'teacher-admin': { id: 'T01',  name: 'サンプル 三郎',   role: 'teacher', roleLabel: '教務',     permissions: 'view_teacher_schedule', isAdmin: true },
  teacher:      { id: 'T05',     name: 'サンプル 七郎',   role: 'teacher', roleLabel: '教務',     permissions: 'view_teacher_schedule', isAdmin: false },
  // ⚠️ Holds manage_users WITHOUT admin level. 操作履歴・バックアップ's three endpoints all
  // require _isAdminLevel_, and this is the one caller who used to see those buttons and have
  // every one of them answer 権限がありません. It must see the ユーザー sub-tab and nothing else.
  'users-only': { id: 'S06',     name: 'サンプル 六子',   role: 'sales',   roleLabel: '営業',     permissions: 'manage_users', isAdmin: false },
};

// Synthetic fixture set. Names are obviously fake on purpose.
const FIXTURES = {
  getBootBundle: {
    user: {
      id: 'LOCAL01', name: 'ドライバ 太郎', email: 'driver@example.invalid',
      role: 'master', roleLabel: 'マスター', permissions: 'ALL', isAdmin: true,
    },
    mustSetPassword: false,
    boot: { announcements: [], notifications: [] },
  },
  // ⚠️ SYNTHETIC. Obviously-invented names on purpose — the real spreadsheet holds
  // ~600 students and the screenshots this writes are ordinary files on disk.
  //
  // Shape matters: initStudentTable reads data.current as an array-of-arrays with a
  // HEADER ROW, and _studentFilterColumns builds one filter control per column it
  // recognises — 国名 / コース / ビザの種類 / ビザ警告. Without those four headers the
  // filter bar is never built and 在籍学生 renders as just the search box, which is
  // why layout bugs in that row were invisible here.
  getDashboardData: {
    current: [
      ['学籍番号', '名前', '国名', '名前英語', 'クラス', 'コース', 'ビザの種類', 'ビザ警告', '寮'],
      ['202601001', 'サンプル 一郎', 'ネパール', 'Sample Ichiro', 'A1', '進学2年', '留学', '', 'テスト寮101'],
      ['202601002', 'サンプル 二郎', 'ベトナム', 'Sample Jiro', 'A1', '進学2年', '留学', '要確認', 'テスト寮102'],
      ['202601003', 'サンプル 三郎', 'ミャンマー', 'Sample Saburo', 'B2', '進学1.5年', '家族滞在', '', ''],
      ['202601004', 'サンプル 四郎', 'ネパール', 'Sample Shiro', 'B2', '進学1.5年', '留学', '', 'テスト寮201'],
      ['202601005', 'サンプル 五子', 'スリランカ', 'Sample Goko', 'C1', '一般2年', '留学', '要確認', ''],
      ['202601006', 'サンプル 六子', 'ベトナム', 'Sample Rokuko', 'C1', '一般2年', '特定活動', '', 'テスト寮202'],
      ['202601007', 'サンプル 七子', 'インドネシア', 'Sample Nanako', 'A2', '進学2年', '留学', '', ''],
      ['202601008', 'サンプル 八郎', 'ミャンマー', 'Sample Hachiro', 'A2', '進学2年', '留学', '', 'テスト寮203'],
    ],
    past: [], headers: [],
  },
  getAnnouncements: [],
  getPendingNotifications: [],
  getTeacherNotifications: [],
  // ホーム, seeded ON DEMAND so every other tab keeps its empty-bell rendering:
  //   --call "_notifRequests = __FIX.__homeRequests; _notifAnnouncements = __FIX.__homeAnnouncements; _notifMerge()"
  // One of each request type, so every badge renders; one long announcement for wrapping.
  __homeRequests: [
    { type: 'datechange', rowIndex: 12, teacherName: 'サンプル 三郎', student: 'サンプル 学生A', date: '2026-09-16', period: '10:00 ~ 10:30', newDate: '2026-09-18', newPeriod: '13:30 ~ 14:00', reason: '授業と重なるため' },
    { type: 'cancel', teacherName: 'サンプル 七郎', student: 'サンプル 学生B', date: '2026-09-17', period: '09:30 ~ 10:00', reason: '学生の都合により' },
    { type: 'reassign', fromTeacherName: 'サンプル 一美', student: 'サンプル 学生C', date: '2026-09-19', period: '14:00 ~ 14:30' },
  ],
  __homeAnnouncements: [
    { type: 'announcement', id: 'A1', body: '9月18日（金）15時から職員会議を行います。\n資料は共有フォルダの「会議」に置いてあります。出席できない方は前日までに連絡してください。', by: 'サンプル 管理者', at: '2026-09-12 09:30:00' },
    { type: 'announcement', id: 'A2', body: '10月生の面接枠を増やしました。', by: 'サンプル 管理者', at: '2026-09-10 17:05:00' },
  ],
  getUpcomingForUser: [
    { type: 'interview', date: '2026-09-15', period: '10:00 ~ 10:30', student: 'サンプル 学生D', nationality: 'ネパール', course: '進学2年課程', teacherName: 'サンプル 三郎', link: '' },
    { type: 'interview', date: '2026-09-16', period: '13:00 ~ 13:30', student: 'サンプル 学生E', nationality: 'ベトナム', course: '就職2年課程', teacherName: 'サンプル 一美', link: '' },
    { type: 'interview', date: '2026-09-18', period: '09:00 ~ 09:30', student: '', nationality: '', course: '', teacherName: 'サンプル 七郎', link: '' },
  ],
  getDormData: {
    buildings: [
      { id: 'B012', nameJp: '学生会館 第二アネックス', nameEn: 'Annex II',
        address: '○○県○○市サンプル町1-2-3', docCount: 2 },
      { id: 'B003', nameJp: '北寮', nameEn: 'North', address: '○○県○○市サンプル4-5', docCount: 0 },
    ],
    rooms: [
      { rowIndex: 2, building: 'B012', roomNumber: '101', studentName: 'サンプル 一郎',
        nationality: 'ベトナム', studentClass: '進学1年', status: '入居中' },
      { rowIndex: 3, building: 'B012', roomNumber: '102', studentName: '', nationality: '', studentClass: '', status: '空室' },
      { rowIndex: 4, building: 'B012', roomNumber: '203', studentName: 'サンプル 八郎',
        nationality: 'ミャンマー', studentClass: '進学2年', status: '入居中' },
      { rowIndex: 5, building: 'B003', roomNumber: 'A1', studentName: 'サンプル 三代',
        nationality: '中国', studentClass: '進学1年', status: '入居中' },
      { rowIndex: 6, building: 'B003', roomNumber: 'A2', studentName: '', nationality: '', studentClass: '', status: '空室' },
      // ⚠️ Deliberately matches a getScheduleApplicants name. 入寮時渡すスケジュール
      // auto-fills 建物/部屋 from whoever holds the room, and with only Japanese sample
      // tenants here that path could never be reached locally.
      { rowIndex: 7, building: 'B003', roomNumber: 'A3',
        studentName: 'SAMPLE RIVERA ALEX MORGAN',
        nationality: 'インドネシア', studentClass: '進学1年', status: '入居中' },
    ],
    lastSync: null,
  },
  // ⚠️ DATES ARE COMPUTED, NOT LITERAL. calRenderGrid opens on getMonday(new Date())
  // and only paints slots whose date falls in that week, so a hardcoded fixture is
  // an empty grid on every day but the week it was written. This is what made the
  // calendar invisible here: the old stub was `{ teachers: [], slots: [] }` — empty,
  // and `slots` is not even the key the backend returns (it is scheduleByTeacher).
  getAllTeachersSchedule: (function () {
    const mon = new Date();
    mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    const day = (i) => {
      const d = new Date(mon); d.setDate(d.getDate() + i);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
           + '-' + String(d.getDate()).padStart(2, '0');
    };
    const per = (h, half) => String(h).padStart(2, '0') + ':' + (half ? '30' : '00')
      + ' ~ ' + String(half ? h + 1 : h).padStart(2, '0') + ':' + (half ? '00' : '30');
    const slot = (d, h, half, status, extra) => Object.assign({
      date: day(d), period: per(h, half), status: status, student: '', nationality: '',
      meetingLink: '', documentUrl: '', course: '', inCharge: '', intake: '', remarks: '',
      reassignToId: '', reassignToName: '', reassignNewDate: '', reassignNewPeriod: '',
      bookerNewDate: '', bookerNewPeriod: '', bookerReason: '', bookerReqStatus: '',
    }, extra || {});
    // Every state the cell mapper can paint, so a screenshot shows all five colours.
    return {
      teachers: [
        { id: 'T1', name: 'サンプル 一美' },
        { id: 'T2', name: 'サンプル 二葉' },
        { id: 'T3', name: 'サンプル 三枝' },
        { id: 'T4', name: 'サンプル 四方山' },
      ],
      scheduleByTeacher: {
        T1: [
          slot(0, 9, 0, 'Available'), slot(0, 9, 1, 'Available'),
          slot(0, 10, 0, 'Unavailable'), slot(1, 9, 0, 'Available'),
          slot(2, 11, 0, 'Booked', { student: 'サンプル 一郎\nネパール', nationality: 'ネパール',
                                     course: '進学2年', inCharge: 'ドライバ 太郎' }),
          slot(3, 13, 0, 'Available'), slot(4, 14, 1, 'Available'),
        ],
        T2: [
          slot(0, 9, 0, 'Unavailable'), slot(1, 10, 0, 'Available'),
          slot(1, 10, 1, 'Booked', { student: 'サンプル 二郎\nベトナム', nationality: 'ベトナム',
                                     course: '進学1.5年', inCharge: 'ドライバ 太郎' }),
          slot(2, 9, 0, 'Available'),
          slot(3, 15, 0, 'Cancel_Request', { student: 'サンプル 三郎\nミャンマー' }),
          slot(4, 9, 1, 'Available'),
        ],
        T3: [
          slot(0, 16, 0, 'Available'),
          // Addressed to T1 — the case a one-teacher-at-a-time view could hide.
          slot(2, 13, 1, 'Reassign_Pending', { student: 'サンプル 四郎\nネパール',
                                               reassignToId: 'T1', reassignToName: 'サンプル 一美',
                                               reassignNewDate: day(3), reassignNewPeriod: per(13, 1) }),
          slot(4, 11, 0, 'Unavailable'),
        ],
        T4: [
          slot(1, 9, 0, 'Available'), slot(1, 9, 1, 'Available'), slot(1, 10, 0, 'Available'),
          slot(3, 17, 0, 'Unavailable'),
        ],
      },
    };
  })(),
  // ⚠️ Row 0 is the HEADER ROW — renderPastInterviewsTable iterates data[0] for the
  // <th>s and showDetail pairs the same array against each row. The real sheet ships
  // these 20 columns (Code.js ~2392); the point of carrying all of them here is that
  // the mobile column-hiding pass is only visible against the full width.
  getInterviewResults: (function () {
    const H = ['Timestamp', '日付', '入学期', '課程', '国籍', '名前', '性別', '年齢',
               '学歴', '現在のレベル', '点数', 'プレースメントテスト点数', '合否',
               '面接者', '担当', '申請', '2回目面接', '3回目面接', '備考', 'EnteredBy'];
    const row = (d, intake, course, nat, name, sex, age, lvl, score, pt, result) =>
      ['2026-08-20 10:00', d, intake, course, nat, name, sex, age, '高校卒業', lvl,
       score, pt, result, 'サンプル 一美', 'ドライバ 太郎', '申請済', '', '', '', 'driver@example.invalid'];
    return [H,
      row('2026-08-24', '2026年10月生', '進学2年', 'ネパール', 'サンプル 一郎', '男', '19', 'N4', '78', '65', '合格'),
      row('2026-08-24', '2026年10月生', '進学2年', 'ベトナム', 'サンプル 二郎', '男', '21', 'N5', '52', '48', '保留'),
      row('2026-08-25', '2026年10月生', '進学1.5年', 'ミャンマー', 'サンプル 三郎', '男', '20', 'N4', '81', '72', '合格'),
      row('2026-08-25', '2026年10月生', '一般2年', 'スリランカ', 'サンプル 五子', '女', '22', 'N5', '44', '39', '不合格'),
      row('2026-08-26', '2027年4月生', '進学2年', 'インドネシア', 'サンプル 七子', '女', '18', 'N4', '69', '61', '合格'),
    ];
  })(),
  // ⚠️ One 【要翻訳】 placeholder and one genuinely-translated language, on purpose.
  // The placeholder must render as Japanese ALONE (that is the guard against a
  // seeded placeholder reaching a student), and the real Devanagari/Burmese strings
  // are the only way to see whether the fonts actually resolve — Latin placeholders
  // would render fine and prove nothing.
  getScheduleBundle: {
    languages: ['日本語', 'English', 'ネパール語', 'ミャンマー語'],
    phrases: [
      { key: 'bring_passport', category: '持ち物', text: {
          '日本語': 'パスポートと在留カードをお持ちください。',
          'English': 'Please bring your passport and residence card.',
          'ネパール語': 'कृपया आफ्नो राहदानी र निवास कार्ड ल्याउनुहोस्।',
          'ミャンマー語': 'ကျေးဇူးပြု၍ သင်၏ နိုင်ငံကူးလက်မှတ်နှင့် နေထိုင်ခွင့်ကတ်ကို ယူဆောင်လာပါ။' } },
      { key: 'jp_interview', category: '手続き', text: {
          '日本語': '日本語のインタビューと住所登録',
          'English': 'Japanese interview and address registration',
          'ネパール語': '【要翻訳】Japanese interview and address registration',
          'ミャンマー語': '' } },
      { key: 'bank_account', category: '手続き', text: {
          '日本語': '銀行口座の開設',
          'English': 'To open a bank account',
          'ネパール語': 'बैंक खाता खोल्न',
          'ミャンマー語': 'ဘဏ်စာရင်းဖွင့်ရန်' } },
      { key: 'entrance_ceremony', category: '行事', text: {
          '日本語': '入学式',
          'English': 'Entrance Ceremony',
          'ネパール語': 'प्रवेश समारोह',
          'ミャンマー語': 'ကျောင်းဝင်အခမ်းအနား' } },
      { key: 'bring_slippers', category: '持ち物', text: {
          '日本語': '上履きと、筆記用具・ノートをお持ちください。',
          'English': '(Please bring indoor slippers and a notebook with a pen for taking notes.)',
          'ネパール語': 'कृपया भित्री चप्पल र नोटबुक ल्याउनुहोस्।',
          'ミャンマー語': '' } },
      // ⚠️ 分類 = キャンパス. These must appear ONLY in a block's place select and in
      // NEITHER phrase picker — that split is the thing worth eyeballing locally.
      { key: 'campus_main', category: 'キャンパス', text: {
          '日本語': '本校キャンパス',
          'English': 'Main Campus',
          'ネパール語': 'साइन क्याम्पस',
          'ミャンマー語': '' } },
      { key: 'campus_second', category: 'キャンパス', text: {
          '日本語': '第二キャンパス',
          'English': 'Second Campus',
          'ネパール語': '',
          'ミャンマー語': '' } },
    ],
    // ⚠️ 入学式 names a phrase that is NOT in the phrase list below ('lunch_provided'),
    // on purpose: materialising must SKIP it rather than emit a blank bullet.
    dayTypes: [
      { name: '手続き',   order: 1, keys: ['bring_passport', 'jp_interview'] },
      { name: '口座開設', order: 2, keys: ['bank_account'] },
      { name: '入学式',   order: 3, keys: ['entrance_ceremony', 'lunch_provided', 'bring_slippers'] },
    ],
    // ⚠️ This template's `place` values are deliberately still FREE TEXT: it is the
    // pre-dropdown blob, and loading it must show 「@Main Campus（一覧にありません）」
    // rather than silently snapping to the first campus in the list.
    templates: [
      { name: '2026年4月生 標準', intake: '2026年4月生',
        body: JSON.stringify({ v: 1, blocks: [
          { date: '2026-04-02', time: '9:00am', place: '@Main Campus',
            items: [{ type: 'phrase', key: 'bring_passport', note: false },
                    { type: 'phrase', key: 'jp_interview', note: false }] },
          { date: '2026-04-03', time: '13:00pm', place: '@Second Campus',
            items: [{ type: 'phrase', key: 'bank_account', note: false }] },
          { date: '2026-04-08', time: '9:15am', place: '@Main Campus',
            items: [{ type: 'phrase', key: 'entrance_ceremony', note: false },
                    { type: 'phrase', key: 'bring_slippers', note: true }] },
        ] }),
        updatedAt: '2026-09-01 10:00', updatedBy: 'ドライバ 太郎' },
    ],
  },
  // ⚠️ Returns a token PDF, not a real render. The point of driving this locally is
  // the button's save-swap-restore and that downloadBase64Pdf is reached at all — the
  // font embedding only happens on Google's servers and cannot be checked from here.
  downloadSchedulePdf: { base64: 'JVBERi0xLjEKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK', fileName: 'driver.pdf' },
  // ⚠️ Without this, 募集シミュレーション renders an empty grid and simExportRows()
  // returns a lone 合計 row — so an export check against it passes while proving
  // nothing. The projection figures below are what make the <input> trap visible:
  // the AOA carries them, _expReadTable('simulationTable') does not.
  // ⚠️ simData keys must name an intake in `structure` and a course inside that
  // intake, or simLoad never adds the intake and the columns never render.
  getSimulationData: {
    structure: [
      { intake: '2026年4月生',  courses: ['進学2年', '進学1.5年'] },
      { intake: '2026年10月生', courses: ['進学2年', '一般2年'] },
    ],
    baseGroups: ['進学', '就職', '文化'],
    countries: ['ネパール', 'ベトナム', 'ミャンマー'],
    countryTotals: { 'ネパール': 12, 'ベトナム': 8, 'ミャンマー': 5 },
    realGrouped: {
      'ネパール':   { '進学': 9, '就職': 2, '文化': 1 },
      'ベトナム':   { '進学': 5, '就職': 2, '文化': 1 },
      'ミャンマー': { '進学': 4, '就職': 1, '文化': 0 },
    },
    realByCountryCourse: {
      'ネパール':   { '進学': 9, '就職': 2, '文化': 1 },
      'ベトナム':   { '進学': 5, '就職': 2, '文化': 1 },
      'ミャンマー': { '進学': 4, '就職': 1, '文化': 0 },
    },
    simData: {
      'ネパール||2026年4月生||進学2年': 4,
      'ネパール||2026年4月生||進学1.5年': 2,
      'ベトナム||2026年4月生||進学2年': 3,
      'ミャンマー||2026年10月生||一般2年': 6,
    },
  },
  // ⚠️ MIXED intakes, including one blank. A fixture where every student shares an
  // intake makes the 一括出力 filter check pass while proving nothing — and the blank is
  // the case every existing record is in until 入学期 is backfilled.
  shinsei_getStudentNames: {
    students: [
      { name: 'SAMPLE RIVERA ALEX MORGAN', intake: '2026年4月生' },
      { name: 'サンプル 一郎', intake: '2026年4月生' },
      { name: 'サンプル 二郎', intake: '2026年10月生' },
      { name: 'サンプル 三郎', intake: '' },
    ],
    intakes: ['2026年4月生', '2026年10月生', '2027年4月生'],
  },
  // 1-based aligned rows (index 1 = column A), so index 47 is 入学期.
  // ⚠️ 二郎's stored intake is deliberately ABSENT from the list above. In production the
  // list is the data's own intakes ∪ Recruitment_Meta, so a stored value is normally in it
  // — this reaches the case where the sheet moved under the session, which is the only way
  // a <select> silently swaps one intake for another and then writes it back.
  // ⚠️ Length 49, not 48: the aligned array is 1-based, so column 48 (the extras blob)
  // needs index 48 to exist. Sized one short it reads as undefined and every extras test
  // passes against a record that simply has none.
  shinsei_getStudentDataForEdit: {
    'サンプル 一郎': (() => { const r = new Array(49).fill(''); r[1] = 'サンプル 一郎'; r[2] = '進学2年課程'; r[47] = '2026年4月生'; return r; })(),
    'サンプル 二郎': (() => { const r = new Array(49).fill(''); r[1] = 'サンプル 二郎'; r[2] = '進学1年課程'; r[47] = '2025年10月生'; return r; })(),
    // ⚠️ 三郎 carries EXTRAS — 2 further exams and 1 further 教育機関. Without a record that
    // has them, opening 既存編集 never rebuilds a single dynamic block and the round trip
    // proves nothing. Its 3回目 試験名 is deliberately a value the select does not offer, so
    // the carried-option guard is exercised here too.
    'サンプル 三郎': (() => {
      const r = new Array(49).fill(''); r[1] = 'サンプル 三郎'; r[2] = '就職2年課程'; r[47] = '';
      r[48] = JSON.stringify({ v: 1,
        exams: [
          { name: '廃止された試験', score: '2級', date: '2024-06-02', place: 'ヤンゴン', no: 'OLD-77' },
          { name: 'JPT', score: '480', date: '2025-05-11', place: 'マンダレー', no: 'JP-4412' },
        ],
        edus: [
          { name: 'Sample Japanese Academy', addr: 'Yangon, Myanmar', tel: '+95-0-000000',
            rep: 'Sample Rep', url: 'https://example.invalid/', period: '2022年度', total: '300', done: '280' },
        ] });
      return r;
    })(),
  },
  // ⚠️ Carries a `failed` entry on purpose. A student whose record cannot be built is
  // SKIPPED so one bad row does not lose the batch — which means the client must say so,
  // and a fixture where everything succeeds would never show whether it does.
  shinsei_exportBatchMergedFromWebApp: {
    base64: 'JVBERi0xLjQK',
    fileName: '2026年4月生_各種確認書_1名.pdf',
    count: 1,
    failed: ['サンプル 二郎'],
  },
  getScheduleApplicants: [
    { name: 'SAMPLE RIVERA ALEX MORGAN', nationality: 'インドネシア' },
    { name: 'SAMPLE STUDENT', nationality: 'ネパール' },
    { name: 'サンプル 三郎', nationality: 'ミャンマー' },
  ],
  getPlacementConfig: [
    { intakeName: '2026年10月生', course: 'か', resultsUrl: 'https://docs.google.com/spreadsheets/d/EXAMPLE/edit',
      tabName: 'フォームの回答 1', columns: [], entryLink: 'https://forms.gle/EXAMPLEabcdefgh' },
    { intakeName: '2026年10月生', course: 'さ', resultsUrl: 'https://docs.google.com/spreadsheets/d/EXAMPLE/edit',
      tabName: 'フォームの回答 2', columns: [], entryLink: '' },
    { intakeName: '2027年4月生', course: '', resultsUrl: 'https://docs.google.com/spreadsheets/d/EXAMPLE/edit',
      tabName: 'フォームの回答 1', columns: [], entryLink: 'https://forms.gle/EXAMPLEijklmnop' },
  ],
  // ⚠️ Headers come from an EXTERNAL sheet, so they are unknown at build time — which
  // is why the placement table keeps every column on mobile and only pins the first.
  // A wide fixture is the whole point here.
  getPlacementResults: {
    headers: ['氏名', 'タイムスタンプ', '国籍', '文字・語彙', '文法', '読解', '聴解', '合計', '判定', '備考'],
    rows: [
      ['サンプル 一郎', '2026/08/22 9:12', 'ネパール', '18', '16', '14', '17', '65', 'B', ''],
      ['サンプル 二郎', '2026/08/22 9:31', 'ベトナム', '12', '11', '13', '12', '48', 'C', '再テスト希望'],
      ['サンプル 三郎', '2026/08/22 10:04', 'ミャンマー', '20', '18', '17', '17', '72', 'A', ''],
      ['サンプル 五子', '2026/08/22 10:40', 'スリランカ', '10', '9', '11', '9', '39', 'C', ''],
    ],
  },
  // ⚠️ Shape mirrors getRecruitmentBundle (Code.js:7247): { data, context, lastYear,
  // note }. Without this the view renders only 「入学期を選択してください。」 and the
  // キャンセル / 不交付 tables never appear at all, so nothing about them can be
  // measured locally.
  //
  // ⚠️ resolvedIntake MUST match an entry in data.intakes. recLoad re-calls itself
  // once when the select lands somewhere the server did not resolve; a static stub
  // that never agrees would bounce between the two branches.
  //
  // ⚠️ The cancel counts are deliberately UNEVEN across the three 種別 (3 / 1 / 2).
  // Evening them out is exactly what the old merged table's maxRows padding did, so
  // an even fixture would hide whether the split renders ragged groups correctly.
  // ⚠️ Per-intake country lists. 2027年4月生 has had ミャンマー pruned and ラオス added, so
  // switching intake in 募集状況 visibly changes the grid rows — without this the per-intake
  // change cannot be seen locally at all.
  __recCountriesByIntake: {
    '2026年10月生': [{ name: 'ネパール' }, { name: 'ベトナム' }, { name: 'ミャンマー' }],
    '2027年4月生':  [{ name: 'ネパール' }, { name: 'ラオス' }],
  },
  getRecruitmentBundle: {
    context: {
      intakes: ['2026年10月生', '2027年4月生'],
      courses: ['進学2年課程', '進学1.5年課程', '日本語・文化2年課程'],
      nationalities: ['ネパール', 'ベトナム', 'ミャンマー', 'スリランカ'],
      staff: ['サンプル商事', 'サンプル学院', 'ドライバ 太郎'],
      coursesByMonth: {},
      enrolled: {},
    },
    data: {
      intakes: ['2026年10月生', '2027年4月生'],
      resolvedIntake: '2026年10月生',
      addedCountries: [{ name: 'ネパール' }, { name: 'ベトナム' }, { name: 'ミャンマー' }],
      recruiters: ['サンプル商事', 'サンプル学院'],
      capacity: {},
      counts: {
        '進学2年課程||ネパール||サンプル商事': 4,
        '進学2年課程||ベトナム||サンプル学院': 2,
        '進学1.5年課程||ミャンマー||サンプル商事': 3,
      },
      cancels: [
        { _sheetRow: 2, kind: '申請キャンセル',   nationality: 'ネパール',   name: 'サンプル 一郎', course: '進学2年課程',   incharge: 'サンプル商事' },
        { _sheetRow: 3, kind: '申請キャンセル',   nationality: 'ベトナム',   name: 'サンプル 二郎', course: '進学2年課程',   incharge: 'サンプル学院' },
        { _sheetRow: 4, kind: '申請キャンセル',   nationality: 'ミャンマー', name: 'サンプル 三郎', course: '進学1.5年課程', incharge: 'サンプル商事' },
        { _sheetRow: 5, kind: '申請取り下げ',     nationality: 'ネパール',   name: 'サンプル 五子', course: '進学2年課程',   incharge: 'サンプル商事' },
        { _sheetRow: 6, kind: 'COE後キャンセル', nationality: 'ベトナム',   name: 'サンプル 七子', course: '進学1.5年課程', incharge: 'サンプル学院' },
        { _sheetRow: 7, kind: 'COE後キャンセル', nationality: 'ミャンマー', name: 'サンプル 八郎', course: '進学2年課程',   incharge: 'サンプル学院' },
      ],
      // ⚠️ NOT empty. An empty roster renders a table with no data rows, so every
      // path that addresses a row by its _sheetRow — the 保存 queue's op keys, the
      // renumbering a delete does — is unreachable and looks fine. That gap hid a
      // real 「対象の行が見つかりません」 bug.
      otherVisa: [
        { _sheetRow: 2, no: '1', nationality: 'ネパール',   name: 'サンプル 四郎', visa: '家族滞在', visaDesired: '留学', course: '進学2年課程',   incharge: 'サンプル商事', matsuno: '', fee: '' },
        { _sheetRow: 3, no: '2', nationality: 'ベトナム',   name: 'サンプル 六子', visa: '技能実習', visaDesired: '留学', course: '進学1.5年課程', incharge: 'サンプル学院', matsuno: '', fee: '' },
        { _sheetRow: 4, no: '3', nationality: 'ミャンマー', name: 'サンプル 九郎', visa: '定住者',   visaDesired: '',     course: '',              incharge: '',             matsuno: '', fee: '' },
      ],
      notIssued: [
        { _sheetRow: 2, nationality: 'ネパール', name: 'サンプル 十子', course: '進学2年課程', incharge: 'サンプル商事' },
        { _sheetRow: 3, nationality: 'ベトナム', name: 'サンプル 十一', course: '',            incharge: '' },
      ],
    },
    lastYear: { available: false, counts: {} },
    note: { html: '', by: '', at: '' },
  },
  // ⚠️ 'sales' carries an OVERRIDDEN label (営業部, not 営業) so the built-in merge is
  // visible locally — an un-overridden list would render identically either way and
  // prove nothing. jimu_bu is flagged at the ROLE level, the two adminUser rows below
  // are flagged at the PERSON level; both must reach _isAdminLevel_ by different paths.
  getRoles: [
    { key: 'admin',   label: '管理者',   perms: 'view_students,manage_users', admin: true,  builtin: true },
    { key: 'sales',   label: '営業部',   perms: 'view_students,view_admissions', admin: false, builtin: true },
    { key: 'teacher', label: '教務',     perms: 'view_teacher_schedule', admin: false, builtin: true },
    { key: 'jimu',    label: '事務',     perms: 'view_students', admin: false, builtin: false },
    { key: 'jimu_bu', label: '事務部長', perms: 'view_students,manage_users', admin: true, builtin: false },
  ],
  // ⚠️ T01 is the case the per-user flag exists for: a 教務 with admin level who must
  // keep role 'teacher' (and so Teacher_Master, and so their own 面接スケジュール).
  // S09 is stored as `admin` — a role the dropdown never offers — so it exercises the
  // absent-value trap in editUser.
  // ⚠️ ONE user signed in, deliberately not all of them: 「ログアウトさせる」 appears only on a
  // signed-in row, and a fixture where everyone (or no one) is signed in cannot show that.
  // Keyed by (role, id) on the client — T01 is a teacher and S01 staff, so they cannot collide.
  // ⚠️ One of each kind the sent list must handle: a role target (so 既読 N / M has a
  // denominator), an adminlevel target (N人 only — counting admin level in the browser is the
  // re-derivation CLAUDE.md warns against), an EXPIRED one (the 期限切れ badge), and a body
  // over 60 characters (the <details> expander). Dates are fixed and in the past on purpose.
  listAnnouncements: [
    { _sheetRow: 4, id: 'A1757551200000', at: '2026/09/10 09:12:00', by: 'ドライバ 太郎', target: 'jimu',
      body: '事務の方へ：来週から書類の提出期限が変わります。', expires: '', readCount: 1 },
    { _sheetRow: 3, id: 'A1757378400000', at: '2026/09/08 14:30:00', by: 'ドライバ 太郎', target: 'adminlevel',
      body: '管理者権限のある方へ：バックアップの確認手順を更新しました。操作履歴・バックアップの「バックアップ」から、シートごとの最新の状態を確かめられます。', expires: '', readCount: 2 },
    { _sheetRow: 2, id: 'A1756080000000', at: '2026/08/25 08:00:00', by: 'ドライバ 太郎', target: 'all',
      body: '夏季休業のお知らせ', expires: '2026/08/31', readCount: 3 },
  ],
  getActivityLog: {
    headers: ['Timestamp', 'User', 'ID', 'Role', 'Action', 'Target', 'Details'],
    rows: [
      ['2026/09/11 10:42:07', 'ドライバ 太郎', 'LOCAL01', 'master', 'ユーザー追加', 'Staff_Master: サンプル 六郎 (S10)', ''],
      ['2026/09/11 09:05:51', 'サンプル 一郎', 'S01', 'sales', '国名を追加', 'ラオス', ''],
      ['2026/09/10 16:20:13', 'サンプル 二子', 'S02', 'jimu', 'お知らせを送信', 'all', '夏季休業のお知らせ'],
    ],
  },
  getSnapshotList: {
    backupUrl: 'https://docs.google.com/spreadsheets/d/EXAMPLE/edit',
    // The last scheduled backup. ⚠️ atMs is COMPUTED (two hours ago) — a fixed date goes
    // stale the day after it is written and the pane would render its warning instead.
    // Set window.__backupStale / __backupNever in --call to see the other two states.
    scheduled: { at: '(2時間前)', atMs: Date.now() - 2 * 3600 * 1000, copied: ['Schedule_DB', 'Interview_Results', 'Recruitment_DB'],
                 unchanged: 21, failed: [], cells: 1843200, nearLimit: false, error: '' },
    // ⚠️ Announcements is deliberately the NEWEST and alphabetically FIRST: with reverse-alpha
    // group ordering it would sort last, so this fixture only renders right when the groups
    // really are ordered by their latest backup.
    snapshots: ['Staff_Master__20260911_104207', 'Staff_Master__20260910_081500',
                'Recruitment_Meta__20260911_090551', 'Announcements__20260911_162013'],
  },
  diagnoseInChargeMatching: {
    summary: '3 件の担当名が一致、1 件が不一致（通知・メールが届かない可能性）',
    unmatched: [{ value: 'サンプル一郎', bookings: 2 }],
    matched: [{ value: 'サンプル 一郎', bookings: 14 }, { value: 'サンプル 二子', bookings: 6 }, { value: 'サンプル 三郎', bookings: 3 }],
  },
  // ⚠️ Newest-first, as the server sorts — and S01 has TWO sessions, the older one last.
  // With one session per user the client's old `m[key] = r` looked correct: it kept the
  // LAST row, i.e. the oldest, and that is how 最終操作 showed a May date in production.
  // S02's session carries a STALE role ('sales'; the account is now 'jimu'), the case a
  // literal-role key cannot see. T01 and S09 have none: all-or-none hides the button logic.
  // The server's real reply. With the stub's default null, recDeleteCountry takes its
  // fallback reload every time and the in-place redraw is never exercised locally.
  removeRecruitmentMeta: { removed: true },
  // アカウント設定. THREE sessions, the current one first: with fewer, 「他の端末をすべてログアウト」
  // (shown only when more than one OTHER exists) never renders locally.
  getMyAccount: {
    pwUpdatedAt: '2026-09-02 09:14:31',
    sessions: [
      { sid: 'a1b2c3d4e5f60718', started: '2026-09-12 08:30:02', lastSeen: '2026-09-14 13:05:44', seenAt: 3, current: true, device: 'Windows · Edge', deviceId: '3f9a2c1b' },
      { sid: '0f1e2d3c4b5a6978', started: '2026-09-08 17:20:15', lastSeen: '2026-09-13 18:41:09', seenAt: 2, current: false, device: 'iPhone · Safari', deviceId: 'b71e04d9' },
      // A session from before the device columns: no label, no id.
      { sid: '99aa88bb77cc66dd', started: '2026-08-29 12:02:50', lastSeen: '2026-09-01 10:11:23', seenAt: 1, current: false, device: '', deviceId: '' },
    ],
  },
  signOutMySession: { signedOut: 1 },
  signOutMyOtherSessions: { signedOut: 2 },
  getActiveSessions: [
    { name: 'サンプル 一郎', role: 'sales', id: 'S01', lastSeen: '2026-09-11 10:42:07', seenAt: Date.parse('2026-09-11T10:42:07+09:00') },
    { name: 'サンプル 二子', role: 'sales', id: 'S02', lastSeen: '2026-09-10 16:03:11', seenAt: Date.parse('2026-09-10T16:03:11+09:00') },
    { name: 'サンプル 一郎', role: 'sales', id: 'S01', lastSeen: '2026-09-02 08:15:00', seenAt: Date.parse('2026-09-02T08:15:00+09:00') },
  ],
  getSystemUsers: [
    { role: 'sales',   id: 'S01', name: 'サンプル 一郎', pwStatus: '設定済み', email: 'a@example.jp', notif: 'ON', permissions: 'view_students', adminUser: false },
    { role: 'jimu',    id: 'S02', name: 'サンプル 二子', pwStatus: '要変更',   email: 'b@example.jp', notif: 'ON', permissions: 'view_students', adminUser: true },
    { role: 'teacher', id: 'T01', name: 'サンプル 三郎', pwStatus: '設定済み', email: 'c@example.jp', notif: 'ON', permissions: 'view_teacher_schedule', adminUser: true },
    { role: 'admin',   id: 'S09', name: 'サンプル 九子', pwStatus: '未設定',   email: 'd@example.jp', notif: 'ON', permissions: 'manage_users', adminUser: false },
  ],
  getEnrollmentHistory: { rows: [], canEdit: true, today: '2026-08' },
};

// ---- boot -------------------------------------------------------------------
async function boot({ vp = 'phone', dark = false, as = 'master' } = {}) {
  if (!fs.existsSync(INDEX)) throw new Error('Index.html not found at ' + INDEX);
  const html = fs.readFileSync(INDEX, 'utf8');

  // Served over http, not file://. localStorage is partitioned/blocked on the
  // file: origin in Chromium, and the app stores its session there — on file://
  // it silently never resumes and you stare at the PIN screen.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: VIEWPORTS[vp] || VIEWPORTS.phone,
    deviceScaleFactor: 2,
    colorScheme: dark ? 'dark' : 'light',
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const persona = PERSONAS[as];
  if (!persona) throw new Error('unknown --as persona: ' + as + ' (have: ' + Object.keys(PERSONAS).join(', ') + ')');
  // Shallow-cloned so one run cannot mutate the fixture set for the next.
  const fixtures = Object.assign({}, FIXTURES, {
    getBootBundle: Object.assign({}, FIXTURES.getBootBundle, { user: persona }),
  });
  await page.addInitScript(makeInitScript(fixtures, dark));
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // The app boots asynchronously through the stub. Wait for the sidebar to be
  // revealed by setupInterfaceBasedOnRole rather than a fixed sleep.
  await page.waitForFunction(() => {
    const sb = document.getElementById('appSidebar');
    return sb && getComputedStyle(sb).display !== 'none';
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);   // let tab render settle

  return { browser, page, errors, close: async () => { await browser.close(); server.close(); } };
}

async function gotoTab(page, tab, sub) {
  if (!tab) return;
  await page.evaluate((t) => window.switchMainTab && window.switchMainTab(t), tab);
  await page.waitForTimeout(400);
  // 学生一覧's five sub-views (current | report | dest | simulation | recruit) and the
  // dorm pair are reached through their own switcher, not switchMainTab — without
  // this the driver can only ever see each tab's default sub-view.
  if (sub) {
    await page.evaluate(({ t, sv }) => {
      if (t === 'dorms' && window.switchDormSubTab) window.switchDormSubTab(sv);
      // 入試関連's three (schedule | past-interviews | placement) have their own
      // switcher as well; without this branch --sub silently fell through to the
      // students one and the driver could only ever screenshot the calendar.
      else if (t === 'admissions' && window.switchAdmissionsSubTab) window.switchAdmissionsSubTab(sv);
      else if (window.switchSubTab) window.switchSubTab(sv);
    }, { t: tab, sv: sub });
    await page.waitForTimeout(500);
  }
}

// --hover <css selector>: move the REAL mouse over the first match after --call, so :hover rules
// apply to shots and to getComputedStyle in --expr. A page.evaluate cannot fake :hover.
async function hoverOpt(page) {
  const sel = opt('hover', '');
  if (!sel) return;
  await page.hover(sel);
  await page.waitForTimeout(400);   // past the 0.15–0.3s transitions
}

// ---- commands ---------------------------------------------------------------
fs.mkdirSync(OUTDIR, { recursive: true });

if (cmd === 'shot') {
  const vp = opt('vp', 'phone'), tab = opt('tab', 'home');
  const sub = opt('sub', '');
  const out = opt('out', path.join(OUTDIR, `${tab}${sub ? '-' + sub : ''}-${vp}${flag('dark') ? '-dark' : ''}.png`));
  const s = await boot({ as: opt('as', 'master'), vp, dark: flag('dark') });
  await gotoTab(s.page, tab, opt('sub', ''));
  // --call runs any expression before the shot, which is how you reach a modal:
  //   --call "stuOpenGender()"    --call "document.querySelector('#x').click()"
  const call = opt('call', '');
  if (call) {
    await s.page.evaluate((expr) => { try { eval(expr); } catch (e) { console.error('[--call] ' + e.message); } }, call);
    await s.page.waitForTimeout(600);
  }
  await hoverOpt(s.page);
  await s.page.screenshot({ path: out, fullPage: false });
  console.log('wrote', out);
  if (s.errors.length) console.log('console errors:\n  ' + s.errors.join('\n  '));
  await s.close();
  process.exit(s.errors.length ? 1 : 0);
}

if (cmd === 'tabs') {
  const vp = opt('vp', 'phone');
  const s = await boot({ as: opt('as', 'master'), vp });
  const tabs = await s.page.evaluate(() =>
    [...document.querySelectorAll('.app-sidebar .nav-btn[id^="btn-"]')]
      .map((b) => (b.getAttribute('onclick') || '').match(/switchMainTab\('(\w+)'\)/)?.[1])
      .filter(Boolean));
  for (const t of tabs) {
    await gotoTab(s.page, t);
    const out = path.join(OUTDIR, `${t}-${vp}.png`);
    await s.page.screenshot({ path: out });
    console.log('wrote', out);
  }
  if (s.errors.length) console.log('console errors:\n  ' + s.errors.join('\n  '));
  await s.close();
  process.exit(0);
}

if (cmd === 'probe') {
  // The command that pays for the driver. Reports where the navigation chrome
  // ACTUALLY landed, computed — which is the thing screenshots make you squint at
  // and which cost several review rounds to establish by eye.
  const vp = opt('vp', 'phone'), tab = opt('tab', 'students');
  const s = await boot({ as: opt('as', 'master'), vp });
  await gotoTab(s.page, tab, opt('sub', ''));
  const report = await s.page.evaluate(() => {
    const info = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, present: false };
      const c = getComputedStyle(el), r = el.getBoundingClientRect();
      return {
        sel, present: true, display: c.display, position: c.position,
        textAlign: c.textAlign, alignItems: c.alignItems,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      };
    };
    return {
      viewport: { w: innerWidth, h: innerHeight },
      bodyClass: document.body.className,
      // does the page slide sideways?
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      bodyPadding: (() => { const c = getComputedStyle(document.body);
        return { top: c.paddingTop, bottom: c.paddingBottom, left: c.paddingLeft }; })(),
      nav: ['#appSidebar', '.app-sidebar .sb-nav', '.app-sidebar .sb-sub.open',
            '.app-sidebar .sb-footer', '#btn-logout', '#userBadge', '#btn-dark-mode',
            '#acctLogout'].map(info),
      activeTab: (() => {
        const a = document.querySelector('.app-sidebar .nav-btn.active');
        if (!a) return null;
        const c = getComputedStyle(a);
        return { id: a.id, color: c.color, background: c.backgroundColor,
                 boxShadow: c.boxShadow, textAlign: c.textAlign,
                 borderBottom: c.borderBottom, outline: c.outline,
                 // ::after is how an underline gets drawn without a border
                 after: (() => { const p = getComputedStyle(a, '::after');
                   return p.content === 'none' ? null
                     : { content: p.content, background: p.backgroundColor,
                         height: p.height, position: p.position }; })() };
      })(),
    };
  });
  console.log(JSON.stringify(report, null, 2));
  if (s.errors.length) console.log('console errors:\n  ' + s.errors.join('\n  '));
  await s.close();
  process.exit(0);
}

if (cmd === 'overflow') {
  // Names the elements poking past the viewport. `probe` tells you THAT the page
  // slides sideways; this tells you WHICH element is doing it, which is otherwise
  // a bisect-by-eye through 700KB of markup.
  const vp = opt('vp', 'phone'), tab = opt('tab', 'students');
  const s = await boot({ as: opt('as', 'master'), vp });
  await gotoTab(s.page, tab, opt('sub', ''));
  const call = opt('call', '');
  if (call) { await s.page.evaluate((e) => { try { eval(e); } catch (_) {} }, call);
              await s.page.waitForTimeout(600); }
  const out = await s.page.evaluate(() => {
    const vw = document.documentElement.clientWidth, bad = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 0.5) return;
      const c = getComputedStyle(el);
      if (c.position === 'fixed') return;   // fixed chrome is meant to sit at the edge
      // ⚠️ Skip anything already inside a scroller. The bottom bar's own tabs sit
      // far past the viewport by design — .sb-nav scrolls them — and reporting
      // those buries the one element actually widening the PAGE.
      let a = el.parentElement, clipped = false;
      while (a && a !== document.documentElement) {
        const ac = getComputedStyle(a);
        if (ac.overflowX === 'auto' || ac.overflowX === 'scroll' || ac.overflowX === 'hidden' ||
            ac.overflowX === 'clip' || ac.position === 'fixed') { clipped = true; break; }
        a = a.parentElement;
      }
      if (clipped) return;
      bad.push({ tag: el.tagName, id: el.id || null,
                 cls: String(el.className || '').slice(0, 44) || null,
                 right: Math.round(r.right), width: Math.round(r.width),
                 minWidth: c.minWidth, overflowX: c.overflowX });
    });
    return { viewportWidth: vw, scrollWidth: document.documentElement.scrollWidth,
             overflowing: bad.length, worst: bad.sort((a, b) => b.right - a.right).slice(0, 12) };
  });
  console.log(JSON.stringify(out, null, 2));
  await s.close();
  process.exit(0);
}

if (cmd === 'eval') {
  // Run an expression in the page and print its JSON result. The escape hatch for
  // anything the fixed commands do not cover — notably MODALS, which `overflow`
  // cannot see because .modal-overlay is position:fixed and that whole subtree is
  // skipped as "chrome meant to sit at the edge".
  //   node driver.mjs eval --tab students --sub report --call "stuOpenGender()" \
  //     --expr "({w: document.querySelector('#stuGenderModal .modal-box').getBoundingClientRect().width})"
  const s = await boot({ as: opt('as', 'master'), vp: opt('vp', 'phone') });
  await gotoTab(s.page, opt('tab', 'students'), opt('sub', ''));
  const call = opt('call', '');
  if (call) { await s.page.evaluate((e) => { try { eval(e); } catch (_) {} }, call);
              await s.page.waitForTimeout(600); }
  await hoverOpt(s.page);
  const r = await s.page.evaluate((e) => {
    try { return JSON.parse(JSON.stringify(eval(e))); } catch (err) { return { error: err.message }; }
  }, opt('expr', '({})'));
  console.log(JSON.stringify(r, null, 2));
  await s.close();
  process.exit(0);
}

if (cmd === 'errors') {
  const s = await boot({ as: opt('as', 'master'), vp: opt('vp', 'phone') });
  console.log(s.errors.length ? s.errors.join('\n') : '(no console errors on boot)');
  await s.close();
  process.exit(s.errors.length ? 1 : 0);
}

console.error('unknown command: ' + cmd + '  (shot|tabs|probe|overflow|eval|errors)');
process.exit(2);
