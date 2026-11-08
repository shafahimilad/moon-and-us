/* Moon&Us — app (ES module). Globals from content.js + cycle.js. */
import CFG from './firebase-config.js';

const CLOUD = !!(CFG && CFG.apiKey);
let Cloud = null;

// =================================================================
// State
// =================================================================
const PREFS_KEY = 'moonus.prefs';
const LOCAL_KEY = 'moonus.local';
const DEFAULT_PROFILE = { cycleLength: 28, periodLength: 5, luteal: 14, mode: 'track', pill: false, hiddenCats: ['test', 'skin', 'social', 'mind'] };
const emptyState = () => ({
  profile: { ...DEFAULT_PROFILE }, logs: {}, status: null, kit: { u: 0, items: {} }, notes: [],
  herName: '', partnerName: '', partnerUid: null, inviteCode: null, onboarded: false,
});

let S = emptyState();
let ME = { uid: null, role: 'her', spaceId: null, name: '', email: '' };
let P = { theme: 'light', calendar: 'persian', pin: null };
try { P = { ...P, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch (e) {}

let screen = 'boot';        // boot | welcome | auth | onboard | invite | disconnected | error | app
let route = 'cycle';
let authMode = 'signup';    // signup | login | reset
let authCtx = 'her';        // her | partner
let authError = '';
let busy = false;
let holdAuth = false;
let pendingInvite = null;   // { code, data }
let unwatch = null;
let calAnchor = todayDate();
let calEdit = false;
let onb = { step: 0, name: '', picked: null, unknown: false, cycle: 28, period: 5, mode: 'track' };
let unlocked = false;
try { unlocked = sessionStorage.getItem('moonus.unlocked') === '1'; } catch (e) {}

const isHer = () => ME.role === 'her';
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(P)); } catch (e) {} };
const cacheKey = () => CLOUD ? 'moonus.cache.' + ME.uid : LOCAL_KEY;
function saveCache() { try { localStorage.setItem(cacheKey(), JSON.stringify(S)); } catch (e) {} }
function loadCache() { try { const s = JSON.parse(localStorage.getItem(cacheKey()) || 'null'); if (s) S = { ...emptyState(), ...s, profile: { ...DEFAULT_PROFILE, ...s.profile } }; } catch (e) {} }

// =================================================================
// Helpers
// =================================================================
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const herN = () => esc(S.herName || 'او');
const partnerN = () => esc(S.partnerName || 'پارتنرت');
const initial = s => esc((s || '؟').trim().charAt(0));
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }
function relDays(n) {
  if (n === 0) return 'امروز'; if (n === 1) return 'فردا'; if (n === -1) return 'دیروز';
  return n > 0 ? `${fa(n)} روز دیگه` : `${fa(-n)} روز پیش`;
}
function logIsEmpty(l) { return !l || (!l.period && !l.note && !l.temp && !Object.values(l.tags || {}).some(a => a && a.length)); }
function hashPin(pin) { let h = 2166136261; for (const c of 'moonus:' + pin) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {} ta.remove(); return ok;
  }
}
async function shareText(text, title) {
  if (navigator.share) { try { await navigator.share({ text, title }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  if (await copyText(text)) toast('کپی شد؛ حالا تو پیام‌رسان پیست کن');
}
function download(name, content, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function applyPrefs() {
  if (P.theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  if (Cal.type !== P.calendar) { Cal.type = P.calendar; Cal._fmt = {}; }
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = P.theme === 'dark' ? '#161314' : '#FBF9F6';
}
const AUTH_ERR = {
  'auth/email-already-in-use': 'با این ایمیل قبلاً حساب ساخته شده. «ورود» رو بزن.',
  'auth/invalid-email': 'ایمیل درست نیست.',
  'auth/weak-password': 'رمز باید حداقل ۶ کاراکتر باشه.',
  'auth/invalid-credential': 'ایمیل یا رمز اشتباهه.',
  'auth/wrong-password': 'ایمیل یا رمز اشتباهه.',
  'auth/user-not-found': 'حسابی با این ایمیل پیدا نشد.',
  'auth/too-many-requests': 'تلاش زیاد بود. چند دقیقه بعد دوباره امتحان کن.',
  'auth/network-request-failed': 'اتصال اینترنت برقرار نیست.',
  'auth/requires-recent-login': 'برای این کار یه بار خارج شو و دوباره وارد شو.',
};
const errMsg = e => AUTH_ERR[e && e.code] || 'یه مشکلی پیش اومد. دوباره امتحان کن.';
let syncWarned = false;
function syncErr(e) { console.error(e); if (!syncWarned) { syncWarned = true; toast('ذخیره در سرور انجام نشد؛ اتصال رو چک کن'); setTimeout(() => { syncWarned = false; }, 10000); } }

// =================================================================
// Icons
// =================================================================
const UI = {
  menu: '<path d="M5 9h14M5 15h14"/>',
  chevR: '<path d="M9 5l7 7-7 7"/>',
  chevL: '<path d="M15 5l-7 7 7 7"/>',
  chevD: '<path d="M6 9.5l6 6 6-6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cycle: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="4" r="1.8" fill="currentColor" stroke="none"/>',
  cal: '<rect x="3.8" y="5.2" width="16.4" height="15" rx="3.4"/><path d="M3.8 9.8h16.4M8.3 3.2v3.6M15.7 3.2v3.6"/><circle cx="8.5" cy="14.2" r=".9" fill="currentColor"/><circle cx="12" cy="14.2" r=".9" fill="currentColor"/><circle cx="15.5" cy="14.2" r=".9" fill="currentColor"/>',
  insights: '<rect x="3.8" y="3.8" width="16.4" height="16.4" rx="4.4"/><path d="M7.6 15.2l3.1-3.6 2.6 2.1 3.2-4.6"/>',
  us: '<circle cx="9.2" cy="12" r="5.4"/><circle cx="14.8" cy="12" r="5.4"/>',
  heart: '<path d="M12 19.5s-7.4-4.5-7.4-10a4.1 4.1 0 0 1 7.4-2.4 4.1 4.1 0 0 1 7.4 2.4c0 5.5-7.4 10-7.4 10z"/>',
  share: '<path d="M12 15V4M8 7.5l4-3.5 4 3.5"/><path d="M6 11v7.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V11"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  send: '<path d="M20 4L9.5 14.5M20 4l-6.5 16-4-5.5L4 10.5 20 4z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/>',
  edit: '<path d="M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L8.5 18.5l-4 1z"/>',
  out: '<path d="M14 4.5h3.5A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5H14M10 8l-4 4 4 4M6 12h9"/>',
};
const ic = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI[name]}</svg>`;

const GLYPHS = {
  drop: '<path d="M12 3.2c3.2 4.2 6.2 7.4 6.2 10.9a6.2 6.2 0 0 1-12.4 0C5.8 10.6 8.8 7.4 12 3.2z"/>',
  bolt: '<path d="M13.2 2.8 5.8 13.4h5.1l-1.1 7.8 7.6-10.9h-5.2l1-7.5z"/>',
  heart: '<path d="M12 20s-7.6-4.6-7.6-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.6 2.5C19.6 15.4 12 20 12 20z"/>',
  battery: '<path fill-rule="evenodd" d="M5.7 6.5h11.1a2.7 2.7 0 0 1 2.7 2.7v.8h.5a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-.5v.8a2.7 2.7 0 0 1-2.7 2.7H5.7A2.7 2.7 0 0 1 3 14.8V9.2a2.7 2.7 0 0 1 2.7-2.7zm0 2a.7.7 0 0 0-.7.7v5.6c0 .4.3.7.7.7h11.1c.4 0 .7-.3.7-.7V9.2a.7.7 0 0 0-.7-.7H5.7zm.8 1.3h6.5v4.4H6.5z"/>',
  moon: '<path d="M15.5 3.6A8.6 8.6 0 1 0 20.4 15 7 7 0 0 1 15.5 3.6z"/>',
  flame: '<path d="M12 21c-3.7 0-6.2-2.5-6.2-5.8 0-3.7 3.1-5.6 3.7-9.7 2.5 1.6 3.6 3.7 3.6 5.4 1-.6 1.6-1.9 1.8-3.1 1.9 1.6 3.3 4.1 3.3 7.1 0 3.6-2.5 6.1-6.2 6.1z"/>',
  drops: '<path d="M8.5 4.5c2 2.6 3.8 4.6 3.8 6.8a3.8 3.8 0 0 1-7.6 0c0-2.2 1.8-4.2 3.8-6.8zM16 10.5c1.6 2 3 3.6 3 5.3a3 3 0 0 1-6 0c0-1.7 1.4-3.3 3-5.3z"/>',
  cookie: '<path fill-rule="evenodd" d="M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM9.5 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm-4 3.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z"/>',
  leaf: '<path d="M19.5 4.5C10 4.5 4.5 9 4.5 15.5c0 1.4.4 2.8 1 4 .9-4.5 3.9-7.9 8.5-9.5-3.7 2.3-6 5.6-6.7 9.6 1 .3 2 .4 3 .4 6.3 0 9.2-6.3 9.2-15.5z"/>',
  sparkle: '<path d="M12 2.8l1.9 6.3 6.3 1.9-6.3 1.9L12 19.2l-1.9-6.3L3.8 11l6.3-1.9z"/>',
  bulb: '<path d="M12 3a6.3 6.3 0 0 0-3.8 11.3c.6.5 1 1.2 1 2v.7h5.6v-.7c0-.8.4-1.5 1-2A6.3 6.3 0 0 0 12 3zM9.3 18.4h5.4v1.3a1.1 1.1 0 0 1-1.1 1.1h-3.2a1.1 1.1 0 0 1-1.1-1.1z"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M2.8 19c.4-3.6 3-5.6 6.2-5.6s5.8 2 6.2 5.6zM16.2 19c-.2-2-1-3.6-2.2-4.7.8-.4 1.6-.6 2.5-.6 2.6 0 4.5 1.7 4.8 5.3z"/>',
  run: '<rect x="2.5" y="9.5" width="2.6" height="5" rx="1"/><rect x="18.9" y="9.5" width="2.6" height="5" rx="1"/><rect x="5.4" y="7" width="3" height="10" rx="1.2"/><rect x="15.6" y="7" width="3" height="10" rx="1.2"/><rect x="8.4" y="11" width="7.2" height="2"/>',
  pill: '<path fill-rule="evenodd" d="M14.6 3.9a5 5 0 0 1 7.1 7.1l-10.7 10.7a5 5 0 0 1-7.1-7.1zm1.4 1.4-5.3 5.3 4.6 4.6 5.3-5.3a3.2 3.2 0 0 0-4.6-4.6z"/>',
  tube: '<path d="M8.5 3h7v1.8h-1.2V16a2.3 2.3 0 0 1-4.6 0V4.8H8.5z"/>',
  cycle: '<path fill-rule="evenodd" d="M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zm0 2.3a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4z"/><circle cx="12" cy="4.6" r="2.6"/>',
  shield: '<path d="M12 3l7 2.8v5.4c0 4.6-3 8.3-7 9.8-4-1.5-7-5.2-7-9.8V5.8z"/>',
  egg: '<path d="M12 3c3.4 0 6.2 5.3 6.2 9.6a6.2 6.2 0 0 1-12.4 0C5.8 8.3 8.6 3 12 3z"/>',
  sun: '<circle cx="12" cy="12" r="4.3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  chart: '<path d="M4 19.5h16v1.5H4zM5.5 12h3v6h-3zM10.5 7h3v11h-3zM15.5 10h3v8h-3z"/>',
  lock: '<path fill-rule="evenodd" d="M7.5 10V8a4.5 4.5 0 0 1 9 0v2h.5A2 2 0 0 1 19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zm2 0h5V8a2.5 2.5 0 0 0-5 0z"/>',
};
const glyph = (name, color, cls = 'ic') => `<span class="${cls}" style="background:${color}"><svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true">${GLYPHS[name] || ''}</svg></span>`;

function logo(size = '') {
  return `<span class="logo ${size}" aria-label="Moon&Us"><svg viewBox="0 0 40 40" aria-hidden="true">
    <path d="M20 9.75A11 11 0 0 1 20 30.25A11 11 0 0 1 20 9.75Z" fill="var(--coral)"/>
    <circle cx="15.5" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="1.7"/>
    <circle cx="24.5" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="1.7"/>
  </svg><span class="wm"><span class="word">Moon</span><span class="word amp">&amp;</span><span class="word">Us</span></span></span>`;
}

function face(i, size = 44) {
  const mouth = ['M13 28.5q7-6.5 14 0', 'M14 27q6-3.5 12 0', 'M14 25.5h12', 'M14 24q6 4.5 12 0', 'M12.5 23q7.5 8 15 0'][i];
  const fill = ['#F7B79A', '#F9C08E', '#FAD07A', '#F8A455', '#F26B1D'][i];
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="${fill}"/><circle cx="14.5" cy="16.5" r="2.1" fill="#3B2A22"/><circle cx="25.5" cy="16.5" r="2.1" fill="#3B2A22"/><path d="${mouth}" stroke="#3B2A22" stroke-width="2.3" fill="none" stroke-linecap="round"/></svg>`;
}

// =================================================================
// Data layer (local or cloud)
// =================================================================
const DB = {
  setLog(k, l) {
    if (logIsEmpty(l)) { delete S.logs[k]; l = null; } else { l.u = Date.now(); S.logs[k] = l; }
    saveCache(); scheduleRender();
    if (CLOUD) Cloud.writeLog(ME.spaceId, k, l).catch(syncErr);
  },
  setLogs(map) {
    for (const [k, l] of Object.entries(map)) { if (logIsEmpty(l)) { delete S.logs[k]; map[k] = null; } else S.logs[k] = l; }
    saveCache(); scheduleRender();
    if (CLOUD) Cloud.writeLogs(ME.spaceId, map).catch(syncErr);
  },
  patch(p) {
    Object.assign(S, p); saveCache(); scheduleRender();
    if (CLOUD) Cloud.updateSpace(ME.spaceId, p).catch(syncErr);
  },
  addNote(text) {
    const n = { from: ME.role, uid: ME.uid || 'local', text, at: Date.now() };
    if (CLOUD) { Cloud.addNote(ME.spaceId, n).catch(syncErr); }
    else { S.notes.push({ id: Date.now().toString(36), ...n }); saveCache(); scheduleRender(); }
  },
  deleteNote(id) {
    S.notes = S.notes.filter(n => n.id !== id); saveCache(); scheduleRender();
    if (CLOUD) Cloud.deleteNote(ME.spaceId, id).catch(syncErr);
  },
};
function editLog(k, fn) {
  const l = S.logs[k] ? JSON.parse(JSON.stringify(S.logs[k])) : {};
  l.tags = l.tags || {};
  fn(l);
  for (const c of Object.keys(l.tags)) if (!l.tags[c] || !l.tags[c].length) delete l.tags[c];
  if (!Object.keys(l.tags).length) delete l.tags;
  if (!l.period) delete l.period;
  DB.setLog(k, l);
}

function startWatch() {
  stopWatch();
  unwatch = Cloud.watchSpace(ME.spaceId, {
    onSpace: d => {
      if (!d) return spaceGone();
      S.herName = d.herName || ''; S.partnerName = d.partnerName || ''; S.partnerUid = d.partnerUid || null;
      S.inviteCode = d.inviteCode || null; S.profile = { ...DEFAULT_PROFILE, ...(d.profile || {}) };
      S.status = d.status || null; S.kit = d.kit || { u: 0, items: {} };
      if (!isHer() && d.partnerUid !== ME.uid) return spaceGone();
      saveCache(); scheduleRender();
    },
    onLogs: logs => { S.logs = logs; saveCache(); scheduleRender(); },
    onNotes: notes => { S.notes = notes; saveCache(); scheduleRender(); },
    onError: e => { console.error(e); if (e.code === 'permission-denied') spaceGone(); },
  });
}
function stopWatch() { if (unwatch) { unwatch(); unwatch = null; } }
function spaceGone() {
  stopWatch();
  if (isHer()) { S = emptyState(); screen = 'onboard'; onb.step = 0; }
  else { screen = 'disconnected'; }
  render();
}

// =================================================================
// Rendering
// =================================================================
let rafPending = false;
function scheduleRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); }

let lastView = '';
function render() {
  applyPrefs();
  const app = $('#app');
  // keep what's being typed when the screen refreshes (e.g. a new note arrives)
  const a = document.activeElement; let keep = null;
  if (a && a.id && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && app.contains(a)) keep = { id: a.id, v: a.value, s: a.selectionStart, e: a.selectionEnd };

  let html; let nav = false;
  if (screen === 'app' && P.pin && !unlocked) html = lockView();
  else switch (screen) {
    case 'boot': html = `<div class="boot">${logo('lg')}<div class="spinner"></div></div>`; break;
    case 'welcome': html = welcomeView(); break;
    case 'auth': html = authView(); break;
    case 'onboard': html = onboardView(); break;
    case 'invite': html = inviteView(); break;
    case 'disconnected': html = disconnectedView(); break;
    case 'error': html = `<div class="boot">${logo('lg')}<p class="muted center">اتصال به سرور برقرار نشد.<br>اینترنت رو چک کن و صفحه رو دوباره باز کن.</p><button class="pill-btn red" data-act="reload">تلاش دوباره</button></div>`; break;
    default: html = appView(); nav = true;
  }
  const viewId = screen + ':' + route + ':' + (screen === 'onboard' ? onb.step : '') + authMode;
  app.classList.toggle('has-nav', nav && !(P.pin && !unlocked));
  app.innerHTML = `<div class="${viewId !== lastView ? 'fade-in' : ''}">${html}</div>`;
  lastView = viewId;
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.value = keep.v; el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (e) {} } }
}

// =================================================================
// Welcome (landing)
// =================================================================
function welcomeView() {
  const feat = [
    ['cycle', '#0C7A92', 'علائم چرخه رو در چند ثانیه ثبت کن'],
    ['sun', '#F26B1D', 'ببین چرخه چطور روی حالت اثر می‌ذاره'],
    ['drop', '#E13336', 'بدون پریود، PMS و تخمک‌گذاری کی میاد'],
    ['sparkle', '#9A6CC6', 'علائم رو قبل از اومدنشون پیش‌بینی کن'],
    ['egg', '#3B6FD8', 'روزهای باروریت رو بشناس'],
    ['heart', '#C2185B', 'پارتنرت رو همراه کن تا بدونه چطور کنارت باشه'],
  ];
  return `<header class="sitebar">${logo('sm')}<button class="pill-btn deep sm" data-act="to-auth" data-mode="login">ورود</button></header>
  <section class="hero-band">
    <h1 class="headline">پیگیری پریود و چرخه، برای <span class="serif">هر دوتامون</span></h1>
    <p class="lead">بدنت رو بهتر از همیشه بشناس و پارتنرت رو هم همراه کن. پیش‌بینی دقیق، ثبت سریع علائم و حریم خصوصی کامل.</p>
    <button class="pill-btn red" data-act="to-auth" data-mode="signup">همین حالا شروع کن</button>
    <div class="hero-meta">رایگان، بدون تبلیغ، فقط برای شما دوتا</div>
  </section>
  <section class="band">
    <h2><b>با هر چرخه</b> خودت رو بهتر بشناس</h2>
    <p>Moon&Us از اولین روز پریود تا آخرین روز چرخه کنارته و کمک می‌کنه الگوهای بدنت رو ببینی.</p>
    <div class="feature-cards">${feat.map(f => `<div class="feature-card">${glyph(f[0], f[1])}<span>${f[2]}</span></div>`).join('')}</div>
    <div class="center" style="margin-top:30px"><button class="pill-btn red" data-act="to-auth" data-mode="signup">با Moon&Us شروع کن</button></div>
  </section>
  <section class="band crimson">
    <h2>اطلاعاتت <span class="serif">پیش ما امنه</span></h2>
    <p>داده‌های سلامتت هیچ‌وقت فروخته نمی‌شه و جز پارتنری که خودت دعوت کنی، کسی بهش دسترسی نداره.</p>
    <div class="privacy-seal">${privacySeal()}</div>
    <button class="pill-btn blush" data-act="to-auth" data-mode="signup">ساخت حساب</button>
  </section>
  <footer class="site-foot">${logo('sm')}<p style="margin-top:12px">Moon&Us ابزار آگاهی از بدنه و جایگزین مشاوره پزشکی یا روش پیشگیری از بارداری نیست.</p></footer>`;
}
function privacySeal() {
  let dots = '';
  for (let i = 0; i < 12; i++) { const a = (i * 30 - 90) * Math.PI / 180; dots += `<circle cx="${(60 + 46 * Math.cos(a)).toFixed(1)}" cy="${(60 + 46 * Math.sin(a)).toFixed(1)}" r="4.2" fill="#FF4D41"/>`; }
  return `<svg viewBox="0 0 120 120" width="150" height="150">${dots}<g transform="translate(40 36)"><rect x="3" y="18" width="34" height="27" rx="6" fill="#FF4D41"/><path d="M10 18v-5a10 10 0 0 1 20 0v5" fill="none" stroke="#FF4D41" stroke-width="5"/><circle cx="20" cy="30" r="3.6" fill="#FFE4E0"/><rect x="18.4" y="31" width="3.2" height="7" rx="1.4" fill="#FFE4E0"/></g></svg>`;
}

// =================================================================
// Auth
// =================================================================
function authView() {
  const partner = authCtx === 'partner';
  const inv = pendingInvite && pendingInvite.data;
  const titles = {
    signup: partner ? 'حسابت رو بساز' : 'یه حساب بساز',
    login: 'خوش برگشتی',
    reset: 'بازیابی رمز',
  };
  const subs = {
    signup: partner && inv ? `بعد از ساخت حساب، به ${esc(inv.herName)} وصل می‌شی.` : 'با حساب، اطلاعاتت روی همه‌ی دستگاه‌ها امن می‌مونه.',
    login: partner && inv ? `بعد از ورود، دعوت ${esc(inv.herName)} رو قبول کن.` : 'با ایمیل و رمزت وارد شو.',
    reset: 'ایمیلت رو بنویس تا لینک ساخت رمز جدید برات بفرستیم.',
  };
  return `<div class="qscreen">
    <div class="qtop"><button class="round-btn" data-act="auth-back" aria-label="برگشت">${ic('chevR')}</button><span style="flex:1"></span>${logo('sm')}</div>
    <form class="qbody" id="auth-form" autocomplete="on" novalidate>
      <h1 class="qtitle">${titles[authMode]}</h1>
      <p class="qsub">${subs[authMode]}</p>
      ${authMode === 'signup' && partner ? `<div class="field"><label for="a-name">اسمت</label><input class="input" id="a-name" maxlength="24" autocomplete="given-name" placeholder="مثلاً علی"></div>` : ''}
      <div class="field"><label for="a-email">ایمیل</label><input class="input ltr" id="a-email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com"></div>
      ${authMode !== 'reset' ? `<div class="field"><label for="a-pass">رمز عبور</label><input class="input ltr" id="a-pass" type="password" autocomplete="${authMode === 'signup' ? 'new-password' : 'current-password'}" placeholder="${authMode === 'signup' ? 'حداقل ۶ کاراکتر' : ''}"></div>` : ''}
      ${authError ? `<div class="form-error">${esc(authError)}</div>` : ''}
      ${authMode === 'login' ? `<button type="button" class="text-link" data-act="to-auth" data-mode="reset" style="align-self:flex-start">رمزت رو فراموش کردی؟</button>` : ''}
      <div class="qfoot">
        <button type="submit" class="pill-btn red block" ${busy ? 'disabled' : ''}>${busy ? 'کمی صبر کن…' : authMode === 'signup' ? (partner ? 'ساخت حساب و اتصال' : 'ساخت حساب') : authMode === 'login' ? 'ورود' : 'ارسال لینک'}</button>
        ${authMode === 'signup' ? `<button type="button" class="text-link" style="justify-content:center" data-act="to-auth" data-mode="login">حساب داری؟ وارد شو</button>` : ''}
        ${authMode === 'login' ? `<button type="button" class="text-link" style="justify-content:center" data-act="to-auth" data-mode="signup">حساب نداری؟ بساز</button>` : ''}
        ${authMode === 'signup' ? `<p class="form-note center">با ساخت حساب، اطلاعاتت فقط برای خودت و کسی که خودت دعوت کنی قابل دیدنه.</p>` : ''}
      </div>
    </form>
  </div>`;
}

async function submitAuth() {
  const email = ($('#a-email')?.value || '').trim();
  const pass = $('#a-pass')?.value || '';
  const name = ($('#a-name')?.value || '').trim();
  authError = '';
  if (!email) { authError = 'ایمیلت رو بنویس.'; return render(); }
  if (authMode === 'signup' && authCtx === 'partner' && !name) { authError = 'اسمت رو بنویس.'; return render(); }
  busy = true; render();
  try {
    if (authMode === 'reset') {
      await Cloud.resetPassword(email); busy = false; authMode = 'login';
      toast('لینک بازیابی به ایمیلت فرستاده شد'); render(); return;
    }
    if (authMode === 'signup') {
      if (authCtx === 'partner') {
        holdAuth = true;
        const cred = await Cloud.signUp(email, pass);
        ME = { uid: cred.user.uid, role: 'partner', spaceId: null, name, email };
        await acceptInvite(name);
      } else {
        await Cloud.signUp(email, pass); // onAuth → onboarding
      }
    } else {
      await Cloud.signIn(email, pass); // onAuth routes
    }
  } catch (e) {
    holdAuth = false; authError = errMsg(e);
  }
  busy = false; render();
}

async function handleAuth(user) {
  if (holdAuth) return;
  stopWatch();
  if (!user) {
    ME = { uid: null, role: 'her', spaceId: null, name: '', email: '' };
    S = emptyState();
    if (screen !== 'auth') screen = pendingInvite ? 'invite' : 'welcome';
    render(); return;
  }
  ME.uid = user.uid; ME.email = user.email || '';
  let u = null;
  try { u = await Cloud.getUserDoc(user.uid); } catch (e) { console.error(e); }
  if (pendingInvite && u && u.role === 'her') { toast('این لینک دعوت برای پارتنرته'); clearInvite(); }
  if (pendingInvite && (!u || u.role === 'partner')) {
    ME.role = 'partner'; ME.name = (u && u.name) || ''; screen = 'invite'; render(); return;
  }
  if (!u || !u.spaceId) {
    if (u && u.role === 'partner') { ME.role = 'partner'; ME.name = u.name || ''; screen = 'disconnected'; render(); return; }
    ME.role = 'her'; screen = 'onboard'; render(); return;
  }
  ME.role = u.role; ME.spaceId = u.spaceId; ME.name = u.name || '';
  loadCache();
  screen = 'app'; route = routeFromHash() || 'cycle';
  startWatch(); render();
}

async function acceptInvite(name) {
  const inv = pendingInvite.data;
  await Cloud.joinSpace(pendingInvite.code, inv, ME.uid, name || ME.name || '');
  ME.spaceId = inv.spaceId; ME.role = 'partner'; ME.name = name || ME.name;
  holdAuth = false;
  const herName = inv.herName;
  clearInvite();
  screen = 'app'; route = 'cycle'; history.replaceState(null, '', '#cycle');
  S = emptyState(); startWatch(); render();
  toast(`به ${herName} وصل شدی`);
}
function clearInvite() { pendingInvite = null; if (location.hash.startsWith('#invite/')) history.replaceState(null, '', '#'); }

async function signOut() {
  stopWatch();
  try { localStorage.removeItem(cacheKey()); } catch (e) {}
  S = emptyState(); route = 'cycle'; history.replaceState(null, '', '#');
  closeSheet(false);
  if (CLOUD) await Cloud.signOutUser();
  screen = 'welcome'; render();
}

// =================================================================
// Invite landing (partner)
// =================================================================
function inviteView() {
  const inv = pendingInvite && pendingInvite.data;
  if (!inv) {
    return `<header class="sitebar">${logo('sm')}<span></span></header>
    <section class="hero-band"><h1 class="headline">این لینک دعوت <span class="serif">دیگه معتبر نیست</span></h1>
    <p class="lead">شاید لغو شده یا قبلاً استفاده شده. ازش بخواه یه لینک جدید برات بفرسته.</p>
    <button class="pill-btn red" data-act="invite-decline">باشه</button></section>`;
  }
  const her = esc(inv.herName || 'او');
  const loggedIn = !!ME.uid;
  const items = [
    ['drop', '#E13336', `پریود بعدی ${her} کی شروع می‌شه`],
    ['cycle', '#0C7A92', 'امروز تو کدوم فاز چرخه‌ست و چطور می‌تونی کمکش کنی'],
    ['heart', '#E0457B', 'حال امروزش و اینکه چی لازم داره'],
    ['people', '#2D8FD5', 'یادداشت‌های دونفره و کیت مراقبت'],
  ];
  return `<header class="sitebar">${logo('sm')}<span></span></header>
  <section class="hero-band">
    <div class="duo"><span class="avatar her">${initial(inv.herName)}</span><span class="avatar him">${loggedIn && ME.name ? initial(ME.name) : '+'}</span></div>
    <h1 class="headline" style="margin-top:14px">${her} تو رو به <span class="serif">Moon&Us</span> دعوت کرده</h1>
    <p class="lead">با قبول این دعوت، چرخه‌ی ${her} رو کنار هم دنبال می‌کنید و هر روز می‌دونی چطور بهتر کنارش باشی.</p>
  </section>
  <section class="band" style="padding-top:28px">
    <div class="card">${items.map(i => `<div class="list-row">${glyph(i[0], i[1])}<div class="main"><b>${i[2]}</b></div></div>`).join('')}</div>
    <p class="fine" style="margin-top:14px">فقط می‌بینی و نمی‌تونی اطلاعاتش رو تغییر بدی. ${her} هر وقت بخواد می‌تونه اتصال رو قطع کنه.</p>
    <div class="stack" style="margin-top:22px">
      ${loggedIn
        ? `<button class="pill-btn red block" data-act="invite-accept" ${busy ? 'disabled' : ''}>${busy ? 'در حال اتصال…' : 'قبول دعوت'}</button>
           <button class="text-link" style="justify-content:center" data-act="sign-out">با حساب دیگه وارد شو</button>`
        : `<button class="pill-btn red block" data-act="invite-signup">قبول دعوت</button>
           <button class="pill-btn ghost block" data-act="invite-login">حساب دارم، ورود</button>`}
      <button class="text-link" style="justify-content:center;color:var(--muted)" data-act="invite-decline">نه، ممنون</button>
    </div>
  </section>`;
}

function disconnectedView() {
  return `<header class="sitebar">${logo('sm')}<span></span></header>
  <section class="hero-band">
    <div class="duo"><span class="avatar empty">؟</span><span class="avatar him">${initial(ME.name)}</span></div>
    <h1 class="headline" style="margin-top:14px">فعلاً به کسی <span class="serif">وصل نیستی</span></h1>
    <p class="lead">اتصال قطع شده. اگه دوباره دعوتت کنه، کافیه لینک جدید رو باز کنی.</p>
    <div class="stack" style="margin-top:26px;max-width:320px;margin-inline:auto">
      <button class="pill-btn ghost block" data-act="sign-out">خروج از حساب</button>
      <button class="text-link" style="justify-content:center;color:var(--muted)" data-act="delete-account">حذف حساب</button>
    </div>
  </section>`;
}

// =================================================================
// Onboarding (her only)
// =================================================================
const ONB_STEPS = 5;
function onboardView() {
  const s = onb.step; const t = todayDate();
  let body = '', canNext = true;
  if (s === 0) {
    body = `<h1 class="qtitle">سلام! اسمت چیه؟</h1><p class="qsub">برای اینکه Moon&Us باهات صمیمی‌تر حرف بزنه.</p>
      <input class="input big" id="o-name" maxlength="24" autocomplete="given-name" placeholder="مثلاً بهاره" value="${esc(onb.name)}">`;
  } else if (s === 1) {
    canNext = !!(onb.picked || onb.unknown);
    body = `<h1 class="qtitle">آخرین پریودت کی <span class="serif">شروع شد؟</span></h1><p class="qsub">روز اولش رو روی تقویم انتخاب کن.</p>
      <div class="card white">${monthGrid(calAnchor, d => {
        const k = toKey(d); const fut = d > t;
        return `<button class="cal-day ${onb.picked === k ? 'picked' : ''} ${sameDay(d, t) ? 'today' : ''}" ${fut ? 'disabled' : `data-act="onb-pick" data-k="${k}"`}>${fa(Cal.parts(d).d)}</button>`;
      })}</div>
      ${onb.picked ? `<p class="center" style="color:var(--ink-2)">${Cal.weekdayDayMonth(fromKey(onb.picked))}، ${relDays(dayDiff(t, fromKey(onb.picked)))}</p>` : ''}
      <button class="choice ${onb.unknown ? 'on' : ''}" data-act="onb-unknown"><div><b>یادم نیست</b><small>بعداً از تقویم ثبتش می‌کنم</small></div><span class="radio"></span></button>`;
  } else if (s === 2) {
    body = `<h1 class="qtitle">چرخه‌ات معمولاً <span class="serif">چند روزه؟</span></h1><p class="qsub">از روز اول یه پریود تا روز اول پریود بعدی. اگه نمی‌دونی، ۲۸ رو نگه دار؛ Moon&Us خودش یاد می‌گیره.</p>
      ${numberPicker('cycle', onb.cycle, 18, 60)}`;
  } else if (s === 3) {
    body = `<h1 class="qtitle">پریودت معمولاً <span class="serif">چند روز</span> طول می‌کشه؟</h1><p class="qsub">بیشتر آدم‌ها بین ۲ تا ۷ روز.</p>
      ${numberPicker('period', onb.period, 1, 12)}`;
  } else {
    body = `<h1 class="qtitle">هدفت از Moon&Us <span class="serif">چیه؟</span></h1><p class="qsub">بعداً هم می‌تونی عوضش کنی.</p>
      <div class="stack">${Object.entries(MODES).map(([k, m]) => `<button class="choice ${onb.mode === k ? 'on' : ''}" data-act="onb-mode" data-v="${k}">${glyph(m.glyph, m.color)}<div><b>${m.name}</b><small>${m.desc}</small></div><span class="radio"></span></button>`).join('')}</div>
      <p class="fine">پیش‌بینی‌ها تقریبی‌اند و روش پیشگیری از بارداری نیستند.</p>`;
  }
  const last = s === ONB_STEPS - 1;
  return `<div class="qscreen">
    <div class="qtop">${s > 0 ? `<button class="round-btn" data-act="onb-back" aria-label="قبلی">${ic('chevR')}</button>` : `<span style="width:44px"></span>`}
      <div class="qprogress"><i style="width:${((s + 1) / ONB_STEPS * 100).toFixed(0)}%"></i></div></div>
    <div class="qbody">${body}</div>
    <div class="qfoot"><button class="pill-btn red block" data-act="${last ? 'onb-done' : 'onb-next'}" ${canNext && !busy ? '' : 'disabled'}>${busy ? 'کمی صبر کن…' : last ? 'تموم شد' : 'ادامه'}</button>
    ${s === 0 && CLOUD ? `<button class="text-link" style="justify-content:center;color:var(--muted)" data-act="sign-out">خروج</button>` : ''}</div>
  </div>`;
}
function numberPicker(id, val, min, max) {
  return `<div class="number-picker"><button data-act="num" data-id="${id}" data-d="1" data-min="${min}" data-max="${max}" aria-label="بیشتر">+</button>
    <div class="val" id="v-${id}" data-v="${val}"><b>${fa(val)}</b><span>روز</span></div>
    <button data-act="num" data-id="${id}" data-d="-1" data-min="${min}" data-max="${max}" aria-label="کمتر">−</button></div>`;
}
async function finishOnboarding() {
  const name = onb.name.trim();
  const profile = { ...DEFAULT_PROFILE, cycleLength: onb.cycle, periodLength: onb.period, mode: onb.mode };
  const logs = {};
  if (onb.picked) {
    const s = fromKey(onb.picked); const t = todayDate();
    for (let i = 0; i < onb.period; i++) { const d = addDays(s, i); if (d <= t) logs[toKey(d)] = { period: 'medium', u: Date.now() }; }
  }
  busy = true; render();
  try {
    if (CLOUD) {
      holdAuth = true;
      const sid = await Cloud.createSpace(ME.uid, { herName: name, profile, status: null, kit: { u: 0, items: {} } }, logs);
      await Cloud.setUserDoc(ME.uid, { spaceId: sid, role: 'her', name });
      ME.spaceId = sid; ME.role = 'her'; ME.name = name; holdAuth = false;
      S = { ...emptyState(), herName: name, profile, logs, onboarded: true };
      startWatch();
    } else {
      S = { ...emptyState(), herName: name, profile, logs, onboarded: true };
      ME = { uid: 'local', role: 'her', spaceId: 'local', name, email: '' };
    }
    saveCache();
    screen = 'app'; route = 'cycle'; history.replaceState(null, '', '#cycle');
  } catch (e) { console.error(e); holdAuth = false; toast(errMsg(e)); }
  busy = false; render();
}

// =================================================================
// App shell
// =================================================================
function appView() {
  const [r, arg] = route.split('/');
  const p = predict(S);
  let title = '', body = '';
  switch (r) {
    case 'calendar': title = 'تقویم'; body = viewCalendar(p); break;
    case 'insights': title = 'تحلیل'; body = viewInsights(p); break;
    case 'us': title = 'ما دوتا'; body = viewUs(p); break;
    case 'more': title = 'منو'; body = viewMore(); break;
    case 'article': title = 'دانستنی‌ها'; body = viewArticle(arg); break;
    default: title = isHer() ? 'چرخه‌ی فعلی تو' : `چرخه‌ی ${herN()}`; body = viewCycle(p);
  }
  const back = r === 'article';
  return `<header class="apphead">
      ${back ? `<button class="round-btn" data-act="go" data-r="more" aria-label="برگشت">${ic('chevR')}</button>` : '<span></span>'}
      <h1>${title}</h1>
      <button class="round-btn" data-act="go" data-r="more" aria-label="منو">${ic('menu')}</button>
    </header>
    <main class="page">${body}</main>${navBar(r)}`;
}
function navBar(cur) {
  const item = (r, icon, label) => `<button class="nav-item ${cur === r ? 'on' : ''}" data-act="go" data-r="${r}">${ic(icon)}<span>${label}</span></button>`;
  const center = isHer()
    ? `<button class="nav-center" data-act="log" aria-label="ثبت امروز"><span class="plus">${ic('plus')}</span><span>ثبت</span></button>`
    : `<button class="nav-center" data-act="compose" aria-label="یادداشت"><span class="plus">${ic('heart')}</span><span>یادداشت</span></button>`;
  return `<nav class="nav"><div class="nav-inner">${item('cycle', 'cycle', 'چرخه')}${item('calendar', 'cal', 'تقویم')}${center}${item('insights', 'insights', 'تحلیل')}${item('us', 'us', 'ما دوتا')}</div></nav>`;
}

// =================================================================
// Cycle (home)
// =================================================================
function dayStatus(p, d) {
  const k = toKey(d); const log = S.logs[k]; const info = p.dayMap.get(k) || {};
  if (log && BLEED.includes(log.period)) return 'P';
  if (info.predPeriod && d >= p.today) return 'Q';
  if (info.ovulation) return 'O';
  if (info.fertile) return 'F';
  if (info.pms) return 'M';
  return '';
}

function wheelSVG(p) {
  const N = Math.min(Math.max(p.avgCycle, p.cycleDay + (p.lateDays > 0 ? 1 : 0)), 75);
  const R = 134, W = 25, step = 360 / N;
  const rad = a => a * Math.PI / 180;
  const pt = (deg, r) => [(r * Math.cos(rad(deg))).toFixed(2), (r * Math.sin(rad(deg))).toFixed(2)];
  const capDeg = (W / 2) / R * 180 / Math.PI;
  const arc = (i0, i1, color) => {
    const pad = Math.min(capDeg, step * 0.5);
    const a0 = -90 + i0 * step + pad; let a1 = -90 + (i1 + 1) * step - pad;
    if (a1 <= a0) a1 = a0 + 0.01;
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R);
    return `<path d="M${x0} ${y0} A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}" stroke="${color}" stroke-width="${W}" stroke-linecap="round" fill="none"/>`;
  };
  const COLORS = { P: 'var(--period)', Q: 'var(--period-pred)', F: 'var(--teal)', M: '#C9AEE6' };
  const st = []; for (let i = 0; i < N; i++) { const s = dayStatus(p, addDays(p.lastStart, i)); st.push(s === 'O' ? 'F' : s); }
  let arcs = '';
  for (let i = 0; i < N;) {
    let j = i; while (j + 1 < N && st[j + 1] === st[i]) j++;
    if (st[i]) arcs += arc(i, j, COLORS[st[i]]);
    i = j + 1;
  }
  let marks = '';
  // ovulation egg
  for (let i = 0; i < N; i++) {
    if (dayStatus(p, addDays(p.lastStart, i)) === 'O') {
      const [x, y] = pt(-90 + (i + 0.5) * step, R);
      marks += `<circle cx="${x}" cy="${y}" r="10" fill="var(--egg)"/><circle cx="${x}" cy="${y}" r="3" fill="var(--teal)"/>`;
    }
  }
  // inner day dots (logged symptoms in colour)
  const rIn = R - W / 2 - 13;
  for (let i = 0; i < N; i++) {
    const d = addDays(p.lastStart, i); const log = S.logs[toKey(d)];
    const [x, y] = pt(-90 + (i + 0.5) * step, rIn);
    if (i === 0) { marks += `<path transform="translate(${x} ${y}) scale(.62) translate(-12 -12)" d="M12 3.2c3.2 4.2 6.2 7.4 6.2 10.9a6.2 6.2 0 0 1-12.4 0C5.8 10.6 8.8 7.4 12 3.2z" fill="var(--period)"/>`; continue; }
    const cat = log && log.tags && Object.keys(log.tags)[0];
    if (cat && CAT_BY_ID[cat]) marks += `<circle cx="${x}" cy="${y}" r="3.4" fill="${CAT_BY_ID[cat].color}"/>`;
    else marks += `<circle cx="${x}" cy="${y}" r="1.7" fill="var(--dot)"/>`;
  }
  // today marker
  let today = '';
  if (p.cycleDay <= N) {
    const [x, y] = pt(-90 + (p.cycleDay - 0.5) * step, R);
    today = `<g class="tmark"><circle cx="${x}" cy="${y}" r="24" fill="var(--surface)"/></g>
      <text x="${x}" y="${(+y - 5).toFixed(1)}" text-anchor="middle" font-size="9.5" fill="var(--muted)" font-family="Vazirmatn">روز</text>
      <text x="${x}" y="${(+y + 12).toFixed(1)}" text-anchor="middle" font-size="17" font-weight="600" fill="var(--ink)" font-family="Vazirmatn">${fa(p.cycleDay)}</text>`;
  }
  return `<svg viewBox="-170 -170 340 340" role="img" aria-label="دایره‌ی چرخه"><circle r="${R}" fill="none" stroke="var(--track)" stroke-width="${W}"/>${arcs}${marks}${today}</svg>`;
}
function emptyWheel() {
  let dots = ''; for (let i = 0; i < 28; i++) { const a = (-90 + (i + .5) * 360 / 28) * Math.PI / 180; dots += `<circle cx="${(108 * Math.cos(a)).toFixed(1)}" cy="${(108 * Math.sin(a)).toFixed(1)}" r="1.7" fill="var(--dot)"/>`; }
  return `<svg viewBox="-170 -170 340 340"><circle r="134" fill="none" stroke="var(--track)" stroke-width="25"/>${dots}</svg>`;
}

function phaseRange(p, ph) {
  const c = p.cur; const ls = p.lastStart;
  const pEnd = addDays(ls, Math.max(p.avgPeriod, p.lastPeriod ? p.lastPeriod.length : 1) - 1);
  switch (ph) {
    case 'period': return [ls, pEnd];
    case 'follicular': return [addDays(pEnd, 1), c.fertileStart ? addDays(c.fertileStart, -1) : addDays(c.start, -15)];
    case 'fertile': case 'ovulation': return [c.fertileStart, c.fertileEnd];
    case 'luteal': return [c.fertileEnd ? addDays(c.fertileEnd, 1) : addDays(pEnd, 1), addDays(c.pmsStart, -1)];
    case 'pms': return [c.pmsStart, addDays(c.start, -1)];
  }
  return null;
}
function phaseSentence(p) {
  const you = isHer(); const her = herN();
  if (!p.hasData) return you ? 'اولین پریودت رو ثبت کن تا شروع کنیم' : `هنوز اولین پریود ${her} ثبت نشده`;
  if (p.phase === 'late') return you ? `پریودت ${fa(p.lateDays)} روز تأخیر داره` : `پریود ${her} ${fa(p.lateDays)} روز تأخیر داره`;
  if (p.phase === 'ovulation') return you ? 'احتمالاً امروز روز تخمک‌گذاریته' : `احتمالاً امروز روز تخمک‌گذاری ${her}ه`;
  const names = { period: 'پریود', follicular: 'فاز فولیکولار', fertile: 'روزهای باروری', luteal: 'فاز لوتئال', pms: 'روزهای PMS' };
  let pos = 'اواسط';
  const r = phaseRange(p, p.phase);
  if (r && r[0] && r[1]) { const len = dayDiff(r[0], r[1]); const f = len > 0 ? dayDiff(r[0], p.today) / len : .5; pos = f < .34 ? 'ابتدای' : f < .67 ? 'اواسط' : 'اواخر'; }
  return you ? `تو در <b>${pos} ${names[p.phase]}</b> هستی` : `${her} در <b>${pos} ${names[p.phase]}</b> است`;
}

function viewCycle(p) {
  const t = p.today; const k = toKey(t); const log = S.logs[k]; const you = isHer();
  const ph = PHASES[p.phase || 'unknown'];
  let center;
  if (!p.hasData) {
    center = `<div class="today"><b>امروز</b>، ${Cal.dayMonth(t)}</div><div class="big">${you ? 'اولین روز پریودت رو ثبت کن' : 'منتظر اولین ثبت'}</div>
      ${you ? `<button class="text-link" data-act="go" data-r="calendar">ثبت در تقویم ${ic('chevL')}</button>` : ''}`;
  } else {
    let big;
    if (p.inPeriod) big = `روز <span class="num">${fa(p.cycleDay)}</span> پریود`;
    else if (p.lateDays > 0) big = `<span class="num">${fa(p.lateDays)}</span> روز تأخیر`;
    else if (p.daysToNext === 0) big = 'احتمالاً پریود امروز شروع می‌شه';
    else big = `<span class="num">${fa(p.daysToNext)}</span> روز تا پریود بعدی`;
    center = `<div class="today"><b>امروز</b>، ${Cal.dayMonth(t)}</div><div class="big">${big}</div>
      <button class="text-link" data-act="phase-sheet">درباره‌ی ${ph.name} ${ic('chevD')}</button>`;
  }
  let html = `<section class="cycle-hero">
    ${you ? `<button class="mode-pill" data-act="mode-sheet">حالت: <b>${MODES[S.profile.mode].name}</b> ${ic('chevD')}</button>` : ''}
    <div class="wheel">${p.hasData ? wheelSVG(p) : emptyWheel()}<div class="wheel-center">${center}</div></div>
    ${feelCard(log)}
  </section>`;

  // quick period button for her
  if (you && !(log && BLEED.includes(log.period))) {
    html += `<button class="pill-btn blush block" data-act="quick-period">${p.inPeriod ? 'امروز هم پریودم' : 'پریودم امروز شروع شد'}</button>`;
  }

  html += `<div><h2 class="sec-title">${phaseSentence(p)}</h2><p class="sec-lead" style="margin-top:8px">${ph.body}</p></div>`;

  // fertility chance (avoid / conceive modes)
  if (p.hasData && S.profile.mode !== 'track') {
    const ch = fertilityChance(p, t);
    const col = ch.level === 'high' ? 'var(--red)' : ch.level === 'mid' ? 'var(--orange)' : 'var(--teal)';
    const txt = S.profile.mode === 'conceive'
      ? (ch.level === 'low' ? 'امروز خارج از پنجره‌ی باروریه.' : 'امروز داخل پنجره‌ی باروریه؛ زمان مناسبی برای اقدامه.')
      : (ch.level === 'low' ? 'امروز خارج از پنجره‌ی باروری پیش‌بینی‌شده‌ست، ولی صددرصد امن نیست.' : 'امروز روز پرخطره؛ حتماً از روش پیشگیری مطمئن استفاده کنید.');
    html += `<div class="card"><div class="row between"><div><div class="card-label" style="margin:0">شانس بارداری امروز</div><h3 style="color:${col};font-size:24px">${ch.label}</h3></div>${glyph(MODES[S.profile.mode].glyph, MODES[S.profile.mode].color, 'ic')}</div><p class="muted" style="font-size:14.5px;margin-top:6px">${txt}</p></div>`;
  }

  // pill reminder
  if (you && S.profile.pill) {
    const took = log && (log.tags?.meds || []).includes('pill');
    html += `<button class="card check ${took ? 'on' : ''}" style="border:0;padding:18px 20px" data-act="pill"><span class="box">${took ? ic('check') : ''}</span><span class="lbl" style="flex:1;font-weight:500">قرص امروز</span>${glyph('pill', '#3B6FD8', 'ic')}</button>`;
  }

  // predictions
  if (p.hasData) {
    const c = p.cur; const rows = [];
    rows.push(['drop', '#E13336', p.lateDays > 0 ? 'پریود (با تأخیر)' : 'پریود بعدی', p.lateDays > 0 ? `قرار بود ${Cal.dayMonth(addDays(p.lastStart, p.avgCycle))} شروع بشه` : Cal.weekdayDayMonth(p.nextStart), p.lateDays > 0 ? `${fa(p.lateDays)} روز` : relDays(p.daysToNext)]);
    const dP = dayDiff(t, c.pmsStart);
    if (dP > 0) rows.push(['sparkle', '#9A6CC6', 'شروع PMS', Cal.weekdayDayMonth(c.pmsStart), relDays(dP)]);
    const fc = c.ov && dayDiff(t, c.fertileEnd) >= 0 ? c : p.future[1];
    if (fc && fc.ov) {
      const dF = dayDiff(t, fc.fertileStart);
      rows.push(['egg', '#0C7A92', 'روزهای باروری', `${Cal.dayMonth(fc.fertileStart)} تا ${Cal.dayMonth(fc.fertileEnd)}`, dF > 0 ? relDays(dF) : 'الان']);
      const dO = dayDiff(t, fc.ov); if (dO >= 0) rows.push(['cycle', '#0E8FA8', 'تخمک‌گذاری', Cal.weekdayDayMonth(fc.ov), relDays(dO)]);
    }
    html += `<div class="card"><div class="card-label">پیش‌بینی‌ها <span>چرخه‌ی ~${fa(p.avgCycle)} روزه</span></div>
      ${rows.map(r => `<div class="list-row">${glyph(r[0], r[1])}<div class="main"><b>${r[2]}</b><small>${r[3]}</small></div><span class="end">${r[4]}</span></div>`).join('')}</div>`;
  }

  // anticipated symptoms (next 3 days)
  const ant = []; const seen = new Set();
  for (let i = 0; i <= 3 && ant.length < 5; i++) for (const a of anticipate(S, p, addDays(t, i))) { const id = a.cat + a.val; if (!seen.has(id)) { seen.add(id); a.when = i; ant.push(a); } }
  if (ant.length) {
    html += `<div class="card plum"><div class="card-label">${you ? 'ممکنه این روزها تجربه کنی' : `ممکنه ${herN()} این روزها تجربه کنه`}</div>
      ${ant.slice(0, 5).map(a => `<div class="list-row"><span class="dot" style="background:${CAT_BY_ID[a.cat].color}"></span><div class="main"><b>${esc(a.label)}</b><small>در ${fa(a.count)} از ${fa(a.of)} چرخه‌ی اخیر، همین موقع ثبت شده</small></div><span class="end">${relDays(a.when)}</span></div>`).join('')}</div>`;
  } else if (you && p.hasData && p.cycles.length < 2) {
    html += `<div class="card"><div class="card-label">پیش‌بینی علائم</div><p style="color:var(--ink-2);font-size:15px">با ثبت علائم در دو چرخه، Moon&Us یاد می‌گیره چه علائمی رو قبل از اومدنشون بهت خبر بده.</p></div>`;
  }

  // phase guide
  html += `<div class="card ${ph.card}"><div class="card-label">${you ? 'مراقبت از خودت' : `چطور کنار ${herN()} باشی`}</div>
    <ul class="bullets">${(you ? ph.her : ph.him).map(x => `<li>${x}</li>`).join('')}</ul>
    ${!you && ph.avoid.length ? `<div class="card-label" style="margin-top:16px">بهتره نه</div><ul class="bullets x">${ph.avoid.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
  </div>`;

  // partner: care kit nudge
  if (!you && p.hasData && (p.phase === 'pms' || p.phase === 'late' || p.daysToNext <= 5)) {
    const done = Object.values(S.kit.items || {}).filter(Boolean).length;
    html += `<button class="card list-row" style="padding:18px 20px;border:0" data-act="go" data-r="us">${glyph('heart', '#E13336')}<div class="main"><b>کیت مراقبت رو آماده کن</b><small>${fa(done)} از ${fa(CARE_KIT.length)} آماده‌ست</small></div><span class="chev">${ic('chevL')}</span></button>`;
  }

  // today's tracking (her)
  if (you) {
    const chips = logChips(log);
    html += `<div class="card white"><div class="card-label">ثبت‌های امروز <button class="text-link" data-act="log">${chips.length ? 'ویرایش' : 'افزودن'}</button></div>
      ${chips.length ? `<div class="chips">${chips.map(c => `<span class="chip static on" style="--c:${c[0]}">${esc(c[1])}</span>`).join('')}</div>` : `<p class="muted" style="font-size:14.5px">هنوز چیزی ثبت نشده. ثبت روزانه، پیش‌بینی‌ها رو دقیق‌تر می‌کنه.</p>`}
    </div>`;
  }
  html += `<p class="fine">پیش‌بینی‌ها بر اساس داده‌های ثبت‌شده و تقریبی‌اند و جایگزین مشاوره‌ی پزشکی یا روش پیشگیری از بارداری نیستند.</p>`;
  return html;
}

function feelCard(log) {
  if (isHer()) {
    const chips = logChips(log).filter(c => c[2] !== 'period');
    return `<button class="feel-card" data-act="log"><span class="ic">${face(3, 40)}</span><span class="t">امروز چه حسی داری؟${chips.length ? `<small>${chips.slice(0, 3).map(c => esc(c[1])).join('، ')}</small>` : ''}</span><span class="chev">${ic('chevL')}</span></button>`;
  }
  const st = todayStatus();
  if (!st) return `<button class="feel-card" data-act="go" data-r="us"><span class="ic">${face(2, 40)}</span><span class="t">${herN()} هنوز حال امروزش رو نگفته<small>یه یادداشت بفرست و حالش رو بپرس</small></span><span class="chev">${ic('chevL')}</span></button>`;
  const needs = (st.needs || []).map(n => (NEEDS.find(x => x[0] === n) || [])[1]).filter(Boolean);
  return `<button class="feel-card" data-act="go" data-r="us"><span class="ic">${st.mood != null ? face(st.mood, 40) : face(2, 40)}</span><span class="t">حال امروز ${herN()}: ${st.mood != null ? MOODS[st.mood] : '—'}<small>${needs.length ? 'لازم داره: ' + needs.slice(0, 3).join('، ') : (st.text ? '«' + esc(st.text) + '»' : '')}</small></span><span class="chev">${ic('chevL')}</span></button>`;
}
function todayStatus() { const st = S.status; return st && st.date === toKey(todayDate()) ? st : null; }

function logChips(log) {
  if (logIsEmpty(log)) return [];
  const out = [];
  if (log.period) { const it = CAT_BY_ID.period.items.find(i => i[0] === log.period); out.push([CAT_BY_ID.period.color, 'خونریزی ' + (it ? it[1] : ''), 'period']); }
  for (const [cat, arr] of Object.entries(log.tags || {})) {
    const C = CAT_BY_ID[cat]; if (!C) continue;
    for (const v of arr) { const it = C.items.find(i => i[0] === v); if (it) out.push([C.color, it[1], cat]); }
  }
  if (log.temp) out.push(['#5A6B7B', `دما ${fa(log.temp)}°`, 'temp']);
  if (log.note) out.push(['#8D8781', 'یادداشت', 'note']);
  return out;
}

// =================================================================
// Calendar
// =================================================================
function monthGrid(anchor, cellFn) {
  const days = Cal.monthDays(anchor);
  let cells = Cal.WEEKDAYS.map(w => `<div class="cal-wd">${w}</div>`).join('');
  for (let i = 0; i < Cal.weekIndex(days[0]); i++) cells += `<div class="cal-day empty"></div>`;
  for (const d of days) cells += cellFn(d);
  return `<div class="cal-head"><button class="round-btn flat" data-act="cal-prev" aria-label="ماه قبل">${ic('chevR')}</button>
    <h3>${Cal.monthName(days[0])} <span>${Cal.year(days[0])}</span></h3>
    <button class="round-btn flat" data-act="cal-next" aria-label="ماه بعد">${ic('chevL')}</button></div>
    <div class="cal-grid">${cells}</div>`;
}
function calCell(p, d) {
  const k = toKey(d); const t = p.today; const log = S.logs[k];
  const s = p.hasData ? dayStatus(p, d) : (log && BLEED.includes(log.period) ? 'P' : '');
  const cls = ['cal-day', { P: 'period', Q: 'pred', O: 'ovulation', F: 'fertile', M: 'pms' }[s] || ''];
  if (log && log.period === 'spotting') cls.push('spotting');
  if (sameDay(d, t)) cls.push('today');
  const dot = log && (log.note || log.temp || (log.tags && Object.keys(log.tags).length)) ? '<span class="logdot"></span>' : '';
  return `<button class="${cls.join(' ')}" data-act="cal-day" data-k="${k}">${fa(Cal.parts(d).d)}${dot}</button>`;
}
function legend() {
  return `<div class="legend"><span><i style="background:var(--period)"></i>پریود</span><span><i class="dash"></i>پیش‌بینی پریود</span><span><i style="background:var(--teal-soft);box-shadow:inset 0 0 0 1.5px var(--teal)"></i>باروری</span><span><i style="background:var(--teal)"></i>تخمک‌گذاری</span><span><i style="background:var(--plum-soft);box-shadow:inset 0 0 0 1.5px var(--plum)"></i>PMS</span></div>`;
}
function viewCalendar(p) {
  let html = `<div class="card white">${monthGrid(calAnchor, d => calCell(p, d))}${legend()}
    ${!sameDay(Cal.monthStart(calAnchor), Cal.monthStart(todayDate())) ? `<div class="center" style="margin-top:12px"><button class="text-link" data-act="cal-today">برگشت به امروز</button></div>` : ''}</div>`;
  if (isHer()) {
    html += `<div class="card ${calEdit ? 'blush' : ''}"><div class="row between"><div><b style="font-weight:500">${calEdit ? 'روی روزها بزن تا پریود ثبت یا حذف بشه' : 'ویرایش روزهای پریود'}</b><div class="muted" style="font-size:13.5px">${calEdit ? 'وقتی تموم شد، «تمام» رو بزن' : 'برای وارد کردن تاریخچه‌ی قبلی'}</div></div>
      <button class="pill-btn sm ${calEdit ? 'red' : 'ghost'}" data-act="cal-edit">${calEdit ? 'تمام' : 'ویرایش'}</button></div></div>`;
  }
  if (p.hasData) {
    html += `<div class="card"><div class="card-label">پریودهای پیش رو</div>
      ${p.future.slice(0, 4).map(c => `<div class="list-row"><span class="dot" style="background:var(--period-pred)"></span><div class="main"><b>${Cal.dayMonth(c.start)} تا ${Cal.dayMonth(c.periodEnd)}</b>${c.ov ? `<small>تخمک‌گذاری قبلش: ${Cal.dayMonth(c.ov)}</small>` : ''}</div><span class="end">${relDays(dayDiff(p.today, c.start))}</span></div>`).join('')}</div>`;
  }
  return html;
}

// =================================================================
// Sheets
// =================================================================
let sheetDay = null;
function openSheet(html) {
  $('#sheet-root').innerHTML = `<div class="sheet-backdrop" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${html}</div></div>`;
  document.body.style.overflow = 'hidden';
}
function refreshSheet(html) { const sh = $('.sheet'); if (!sh) return; const top = sh.scrollTop; sh.innerHTML = `<div class="sheet-grip"></div>${html}`; sh.scrollTop = top; }
function closeSheet(rerender = true) { $('#sheet-root').innerHTML = ''; document.body.style.overflow = ''; sheetDay = null; if (rerender) render(); }
const sheetHead = (title, sub = '', left = '') => `<div class="sheet-head">${left || '<span></span>'}<h2>${title}${sub ? `<small>${sub}</small>` : ''}</h2><button class="round-btn flat" data-act="sheet-close" aria-label="بستن">${ic('close')}</button></div>`;

function logSheetHtml(k) {
  const d = fromKey(k); const t = todayDate(); const p = predict(S);
  const log = S.logs[k] || {};
  const phKey = sameDay(d, t) ? p.phase : pastPhase(S, p, k);
  const canNext = addDays(d, 1) <= t;
  const cats = CATEGORIES.filter(c => c.id === 'period' || !S.profile.hiddenCats.includes(c.id));
  let html = `<div class="sheet-head">
    <button class="round-btn flat" data-act="log-day" data-k="${toKey(addDays(d, -1))}" aria-label="روز قبل">${ic('chevR')}</button>
    <h2>${sameDay(d, t) ? 'امروز، ' : ''}${Cal.weekdayDayMonth(d)}<small>${phKey && PHASES[phKey] ? PHASES[phKey].name : ''}</small></h2>
    <button class="round-btn flat" data-act="log-day" data-k="${toKey(addDays(d, 1))}" ${canNext ? '' : 'disabled style="opacity:.25"'} aria-label="روز بعد">${ic('chevL')}</button>
  </div><div class="sheet-body">`;
  for (const c of cats) {
    const sel = c.id === 'period' ? (log.period ? [log.period] : []) : (log.tags?.[c.id] || []);
    html += `<div class="track-cat"><div class="track-cat-head">${glyph(c.glyph, c.color)}<b>${c.name}</b>${c.single ? '<small>یکی رو انتخاب کن</small>' : ''}</div>
      <div class="chips">${c.items.map(([v, l]) => `<button class="chip ${sel.includes(v) ? 'on' : ''}" style="--c:${c.color}" data-act="tag" data-k="${k}" data-c="${c.id}" data-v="${v}">${l}</button>`).join('')}</div></div>`;
  }
  html += `<div class="track-cat"><div class="track-cat-head">${glyph('sun', '#5A6B7B')}<b>دمای پایه‌ی بدن</b><small>صبح، قبل از بلند شدن</small></div>
      <input class="input ltr" id="log-temp" inputmode="decimal" placeholder="36.5" value="${log.temp || ''}" data-input="temp" data-k="${k}" style="max-width:160px"></div>
    <div class="track-cat"><div class="track-cat-head">${glyph('bulb', '#8D8781')}<b>یادداشت</b></div>
      <textarea class="input" id="log-note" placeholder="هرچی دوست داری بنویس…" data-input="note" data-k="${k}">${esc(log.note || '')}</textarea></div>
    <div class="row" style="margin-top:6px"><button class="pill-btn red" style="flex:1" data-act="sheet-close">ذخیره</button><button class="pill-btn ghost" data-act="cats-sheet">دسته‌ها</button></div>
  </div>`;
  return html;
}
function openLog(k) { if (!isHer()) return dayInfoSheet(k); sheetDay = k; openSheet(logSheetHtml(k)); }

function dayInfoSheet(k) {
  const d = fromKey(k); const p = predict(S); const t = p.today;
  const info = p.dayMap.get(k) || {}; const log = S.logs[k];
  const phKey = d > t ? phaseOn(S, p, d) : (sameDay(d, t) ? p.phase : pastPhase(S, p, k));
  const ph = PHASES[phKey || 'unknown'];
  const items = [];
  if (info.predPeriod && d >= t) items.push(['drop', '#E13336', 'پیش‌بینی پریود']);
  if (info.ovulation) items.push(['egg', '#0C7A92', 'روز تخمک‌گذاری (تخمینی)']);
  else if (info.fertile) items.push(['egg', '#0E8FA8', 'داخل پنجره‌ی باروری']);
  if (info.pms) items.push(['sparkle', '#9A6CC6', 'احتمال علائم PMS']);
  const chips = logChips(log).filter(c => isHer() || c[2] !== 'note');
  openSheet(`${sheetHead(Cal.weekdayDayMonth(d), relDays(dayDiff(t, d)))}<div class="sheet-body">
    <div class="card ${ph.card}"><div class="card-label">${ph.name}</div><p style="font-size:15px;color:var(--ink-2)">${ph.body}</p></div>
    ${items.length ? `<div class="card white">${items.map(i => `<div class="list-row">${glyph(i[0], i[1])}<div class="main"><b>${i[2]}</b></div></div>`).join('')}</div>` : ''}
    ${chips.length ? `<div class="card white"><div class="card-label">ثبت‌های این روز</div><div class="chips">${chips.map(c => `<span class="chip static on" style="--c:${c[0]}">${esc(c[1])}</span>`).join('')}</div></div>` : ''}
    ${d > t && isHer() ? `<p class="fine">روزهای آینده رو نمی‌شه ثبت کرد.</p>` : ''}
  </div>`);
}

function phaseSheet() {
  const p = predict(S); const ph = PHASES[p.phase || 'unknown']; const you = isHer();
  openSheet(`${sheetHead(ph.name)}<div class="sheet-body">
    <div class="card ${ph.card}"><p style="font-size:16px;line-height:1.95">${ph.body}</p></div>
    <div class="card white"><div class="card-label">${you ? 'مراقبت از خودت' : 'چطور کنارش باشی'}</div><ul class="bullets">${(you ? ph.her : ph.him).map(x => `<li>${x}</li>`).join('')}</ul></div>
    ${!you && ph.avoid.length ? `<div class="card white"><div class="card-label">بهتره نه</div><ul class="bullets x">${ph.avoid.map(x => `<li>${x}</li>`).join('')}</ul></div>` : ''}
    <button class="text-link" style="justify-content:center" data-act="go" data-r="article/phases">بیشتر بخون: چرخه به زبان ساده ${ic('chevL')}</button>
  </div>`);
}

function modeSheet() {
  openSheet(`${sheetHead('حالت Moon&Us')}<div class="sheet-body">
    ${Object.entries(MODES).map(([k, m]) => `<button class="choice ${S.profile.mode === k ? 'on' : ''}" data-act="set-mode" data-v="${k}">${glyph(m.glyph, m.color)}<div><b>${m.name}</b><small>${m.desc}</small></div><span class="radio"></span></button>`).join('')}
    <p class="fine">پیش‌بینی روزهای باروری روش پیشگیری از بارداری نیست.</p></div>`);
}

function catsSheet(returnTo) {
  catReturn = returnTo || null;
  openSheet(`${sheetHead('دسته‌های ثبت', 'انتخاب کن چه چیزهایی رو دنبال کنی')}<div class="sheet-body"><div class="card white">
    ${CATEGORIES.filter(c => c.id !== 'period').map(c => `<div class="list-row">${glyph(c.glyph, c.color)}<div class="main"><b>${c.name}</b><small>${c.items.slice(0, 3).map(i => i[1]).join('، ')}</small></div><label class="switch"><input type="checkbox" data-act="cat-toggle" data-c="${c.id}" ${S.profile.hiddenCats.includes(c.id) ? '' : 'checked'}><span></span></label></div>`).join('')}
  </div><button class="pill-btn red block" data-act="cats-done">تمام</button></div>`);
}
let catReturn = null;

function cycleSettingsSheet() {
  const pr = S.profile;
  const stepper = (id, v, min, max, label, sub) => `<div class="list-row"><div class="main"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</div>
    <div class="row" style="gap:6px"><button class="round-btn flat" style="background:var(--sand);color:var(--crimson);font-size:20px" data-act="num" data-id="${id}" data-d="1" data-min="${min}" data-max="${max}">+</button>
    <div class="val" id="v-${id}" data-v="${v}" style="min-width:44px;text-align:center"><b style="font-family:var(--serif-fa);font-size:26px;color:var(--crimson);font-weight:500">${fa(v)}</b></div>
    <button class="round-btn flat" style="background:var(--sand);color:var(--crimson);font-size:20px" data-act="num" data-id="${id}" data-d="-1" data-min="${min}" data-max="${max}">−</button></div></div>`;
  openSheet(`${sheetHead('تنظیمات چرخه')}<div class="sheet-body">
    <div class="card white"><div class="field"><label for="f-her">اسمت</label><input class="input" id="f-her" maxlength="24" value="${esc(S.herName)}"></div></div>
    <div class="card white">
      ${stepper('cycle', pr.cycleLength, 18, 60, 'طول معمول چرخه', 'تا وقتی چرخه‌ی کامل ثبت نشده')}
      ${stepper('period', pr.periodLength, 1, 12, 'طول معمول پریود', '')}
      ${stepper('luteal', pr.luteal, 9, 18, 'طول فاز لوتئال', 'معمولاً ۱۴؛ اگه نمی‌دونی تغییر نده')}
    </div>
    <button class="pill-btn red block" data-act="save-cycle">ذخیره</button></div>`);
}

function lookSheet() {
  openSheet(`${sheetHead('ظاهر و تقویم')}<div class="sheet-body">
    <div class="card white"><div class="card-label">تقویم</div><div class="seg"><button class="${P.calendar === 'persian' ? 'on' : ''}" data-act="pref" data-k="calendar" data-v="persian">شمسی</button><button class="${P.calendar === 'gregory' ? 'on' : ''}" data-act="pref" data-k="calendar" data-v="gregory">میلادی</button></div></div>
    <div class="card white"><div class="card-label">حالت نمایش</div><div class="seg"><button class="${P.theme !== 'dark' ? 'on' : ''}" data-act="pref" data-k="theme" data-v="light">روشن</button><button class="${P.theme === 'dark' ? 'on' : ''}" data-act="pref" data-k="theme" data-v="dark">تیره</button></div></div>
  </div>`);
}

function pinSheet() {
  if (P.pin) {
    openSheet(`${sheetHead('قفل رمز')}<div class="sheet-body"><div class="card white"><p>قفل رمز روی این دستگاه فعاله.</p></div><button class="pill-btn ghost block" data-act="pin-off">غیرفعال کردن قفل</button></div>`);
  } else {
    openSheet(`${sheetHead('قفل رمز این دستگاه')}<div class="sheet-body"><div class="card white stack">
      <p style="color:var(--ink-2);font-size:14.5px">هر بار که Moon&Us رو باز می‌کنی، رمز چهاررقمی پرسیده می‌شه.</p>
      <input class="input big ltr" id="pin-in" inputmode="numeric" maxlength="4" placeholder="••••" style="text-align:center;letter-spacing:14px">
    </div><button class="pill-btn red block" data-act="pin-set">فعال کردن</button></div>`);
  }
}

function confirmSheet(title, text, act, btn) {
  openSheet(`${sheetHead(title)}<div class="sheet-body"><div class="card white"><p style="color:var(--ink-2)">${text}</p></div>
    <button class="pill-btn red block" data-act="${act}">${btn}</button><button class="pill-btn ghost block" data-act="sheet-close">انصراف</button></div>`);
}

function composeSheet() {
  openSheet(`${sheetHead(`یادداشت برای ${isHer() ? partnerN() : herN()}`)}<div class="sheet-body">
    <textarea class="input" id="compose-text" maxlength="300" placeholder="یه جمله‌ی مهربون، یه یادآوری یا یه «دوستت دارم»…"></textarea>
    <button class="pill-btn red block" data-act="compose-send">فرستادن</button></div>`);
  setTimeout(() => $('#compose-text')?.focus(), 250);
}

// =================================================================
// Insights
// =================================================================
function viewInsights(p) {
  const you = isHer();
  let html = `<div><h1 class="page-title">تحلیل <span class="serif">چرخه‌ها</span></h1><p class="page-lead" style="margin-top:4px">${you ? 'هرچی بیشتر ثبت کنی، الگوهای بدنت واضح‌تر می‌شه.' : `الگوهای چرخه‌ی ${herN()}`}</p></div>`;
  if (!p.hasData) return html + `<div class="card center"><p class="muted">هنوز داده‌ای نیست. اولین پریود که ثبت بشه، تحلیل‌ها اینجا میان.</p></div>`;
  const n = p.cycles.length;
  const cOk = p.avgCycle >= 21 && p.avgCycle <= 35, pOk = p.avgPeriod >= 2 && p.avgPeriod <= 7;
  const vr = p.variation === null ? ['info', 'داده‌ی کافی نیست'] : p.variation <= 7 ? ['ok', 'منظم'] : p.variation <= 9 ? ['warn', 'کمی نامنظم'] : ['warn', 'نامنظم'];
  html += `<div class="stats">
    <div class="stat"><div class="k">میانگین طول چرخه</div><div class="v">${fa(p.avgCycle)} <small>روز</small></div><span class="tag ${n ? (cOk ? 'ok' : 'warn') : 'info'}">${n ? (cOk ? 'در محدوده‌ی طبیعی' : 'خارج از ۲۱ تا ۳۵') : 'از تنظیمات'}</span></div>
    <div class="stat"><div class="k">میانگین طول پریود</div><div class="v">${fa(p.avgPeriod)} <small>روز</small></div><span class="tag ${pOk ? 'ok' : 'warn'}">${pOk ? 'در محدوده‌ی طبیعی' : 'خارج از ۲ تا ۷'}</span></div>
    <div class="stat"><div class="k">نوسان طول چرخه</div><div class="v">${p.variation === null ? '–' : fa(p.variation)} <small>${p.variation === null ? '' : 'روز'}</small></div><span class="tag ${vr[0]}">${vr[1]}</span></div>
    <div class="stat"><div class="k">چرخه‌های ثبت‌شده</div><div class="v">${fa(n)}</div><span class="tag info">روز ${fa(p.cycleDay)} چرخه‌ی فعلی</span></div>
  </div>`;

  const list = p.cycles.slice(-7);
  if (list.length) {
    const max = Math.max(36, ...list.map(c => c.length), p.cycleDay);
    const bar = (len, per, lbl, cur) => `<div class="b"><span class="n">${fa(len)}</span><div class="col ${cur ? 'cur' : ''}" style="height:${(len / max * 100).toFixed(1)}%"><i style="height:${(Math.min(per, len) / len * 100).toFixed(1)}%"></i></div><span class="l">${lbl}</span></div>`;
    html += `<div class="card white"><div class="card-label">طول چرخه‌ها <span>قرمز: روزهای پریود</span></div><div class="bars">
      ${list.map(c => bar(c.length, c.periodLength, Cal.short(fromKey(c.start)), false)).join('')}${bar(p.cycleDay, p.lastPeriod.length, 'فعلی', true)}</div></div>`;
  }

  const hist = [{ start: p.lastPeriod.start, length: p.cycleDay, periodLength: p.lastPeriod.length, current: true }, ...p.cycles.slice().reverse()].slice(0, 12);
  html += `<div class="card white"><div class="card-label">تاریخچه‌ی چرخه‌ها</div>${hist.map(c => {
    const s = fromKey(c.start); const len = Math.max(1, c.length);
    const ov = c.current ? (p.cur.ov ? dayDiff(s, p.cur.ov) : -99) : len - (S.profile.luteal || 14);
    let dots = '';
    for (let i = 0; i < Math.min(len, 70); i++) {
      const lg = S.logs[toKey(addDays(s, i))];
      const cl = lg && BLEED.includes(lg.period) ? 'p' : i === ov ? 'o' : (i >= ov - 5 && i <= ov + 1) ? 'f' : '';
      dots += `<i class="${cl}${c.current && i === len - 1 ? ' now' : ''}"></i>`;
    }
    return `<div class="hist-row"><div class="meta"><span>${c.current ? '<b>چرخه‌ی فعلی</b>' : `<b>${fa(c.length)} روز</b>`}، پریود ${fa(c.periodLength)} روز</span><span>${Cal.full(s)}</span></div><div class="hist-dots">${dots}</div></div>`;
  }).join('')}</div>`;

  const ins = phaseInsights(S, p);
  const phs = [['period', 'پریود', 'var(--period)'], ['follicular', 'فولیکولار', 'var(--teal-2)'], ['fertile', 'باروری', 'var(--teal)'], ['luteal', 'لوتئال', 'var(--orange)'], ['pms', 'PMS', 'var(--plum)']];
  html += `<div class="card white"><div class="card-label">چرخه چطور روی حال‌وهوا اثر می‌ذاره</div>`;
  if (ins.rows.length) {
    html += `<table class="heat"><thead><tr><th></th>${phs.map(x => `<th>${x[1]}</th>`).join('')}</tr></thead><tbody>
      ${ins.rows.map(r => { const m = Math.max(...phs.map(x => r.r[x[0]])); const C = CAT_BY_ID[r.id.split(':')[0]];
        return `<tr><td><span class="c" style="width:8px;height:8px;background:${C.color};margin-inline-end:8px"></span>${esc(r.label)}</td>${phs.map(x => { const v = r.r[x[0]]; const sz = v ? 8 + Math.round(14 * v / m) : 4; return `<td><span class="c" style="width:${sz}px;height:${sz}px;background:${v ? x[2] : 'var(--dot)'};opacity:${v ? (.35 + .65 * v / m).toFixed(2) : 1}"></span></td>`; }).join('')}</tr>`; }).join('')}
    </tbody></table>
    <p class="muted" style="font-size:13px;margin-top:10px">«${esc(ins.rows[0].label)}» بیشتر از همه در ${phs.find(x => x[0] === ins.rows[0].top)[1]} ثبت شده.</p>`;
  } else html += `<p class="muted" style="font-size:14.5px">با ثبت احساسات، درد و انرژی، اینجا می‌بینید هر علامت بیشتر توی کدوم فاز چرخه پیش میاد.</p>`;
  html += `</div>`;
  if (you) html += `<div class="card"><div class="card-label">برای ویزیت پزشک</div><p style="color:var(--ink-2);font-size:14.5px;margin-bottom:14px">خلاصه‌ای از چرخه‌ها و علائم رایجت رو کپی کن و به پزشک نشون بده.</p><button class="pill-btn blush block" data-act="doctor">کپی خلاصه</button></div>`;
  return html;
}
function doctorSummary(p) {
  const L = ['خلاصه‌ی چرخه‌ی قاعدگی (Moon&Us)', `تاریخ: ${Cal.full(p.today)}`, '', `میانگین طول چرخه: ${fa(p.avgCycle)} روز`, `میانگین طول پریود: ${fa(p.avgPeriod)} روز`];
  if (p.variation !== null) L.push(`نوسان طول چرخه: ${fa(p.variation)} روز`);
  L.push(`آخرین پریود: ${Cal.full(p.lastStart)}`, '', 'چرخه‌های اخیر:');
  p.cycles.slice(-8).reverse().forEach(c => L.push(`- ${Cal.full(fromKey(c.start))}: چرخه ${fa(c.length)} روز، پریود ${fa(c.periodLength)} روز`));
  const ins = phaseInsights(S, p);
  if (ins.rows.length) { L.push('', 'علائم پرتکرار:'); ins.rows.slice(0, 6).forEach(r => L.push(`- ${r.label} (${fa(r.r.total)} بار)`)); }
  return L.join('\n');
}

// =================================================================
// Us (partner connection)
// =================================================================
const inviteUrl = code => `${location.origin}${location.pathname.replace(/index\.html$/, '')}#invite/${code}`;

function viewUs(p) {
  const you = isHer();
  if (you && !CLOUD) {
    return `<div class="center"><div class="duo"><span class="avatar her">${initial(S.herName)}</span><span class="avatar empty">+</span></div>
      <h1 class="page-title">پارتنرت رو <span class="serif">اضافه کن</span></h1></div>
      <div class="card"><p style="color:var(--ink-2)">برای وصل کردن پارتنر، Moon&Us باید روی سرور اجرا بشه. این نسخه‌ی آزمایشیِ محلیه.</p></div>`;
  }
  if (you && !S.partnerUid) return S.inviteCode ? usPending() : usEmpty();
  let html = `<div class="center"><div class="duo"><span class="avatar her">${initial(S.herName)}</span><span class="avatar him">${initial(S.partnerName)}</span></div>
    <h1 class="page-title" style="font-size:26px">${you ? `تو و ${partnerN()} <span class="serif">به هم وصلید</span>` : `تو به ${herN()} <span class="serif">وصلی</span>`}</h1></div>`;
  html += you ? statusEditor() : statusView();
  html += notesCard();
  html += kitCard(p);
  html += `<div class="center"><button class="text-link" style="color:var(--muted)" data-act="${you ? 'remove-partner' : 'leave'}">قطع اتصال</button></div>`;
  return html;
}
function usEmpty() {
  const items = [
    ['drop', '#E13336', 'پیش‌بینی پریود، PMS و روزهای باروریت'],
    ['cycle', '#0C7A92', 'فاز امروزت و راهنمای اینکه چطور کنارت باشه'],
    ['heart', '#E0457B', 'حال امروزت و چیزهایی که لازم داری'],
    ['people', '#2D8FD5', 'یادداشت‌های دونفره و کیت مراقبت'],
  ];
  return `<div class="center" style="padding-top:8px"><div class="duo"><span class="avatar her">${initial(S.herName)}</span><span class="avatar empty">+</span></div>
    <h1 class="page-title">چرخه‌ات رو با <span class="serif">پارتنرت</span> به اشتراک بذار</h1>
    <p class="page-lead" style="margin-top:8px">یه لینک دعوت براش می‌فرستیم. وقتی قبول کنه، هر روز می‌دونه چطور کنارت باشه.</p></div>
    <div class="card"><div class="card-label">پارتنرت چی می‌بینه</div>${items.map(i => `<div class="list-row">${glyph(i[0], i[1])}<div class="main"><b>${i[2]}</b></div></div>`).join('')}</div>
    <p class="fine">پارتنرت نمی‌تونه چیزی رو ثبت یا تغییر بده و یادداشت‌های روزانه‌ات رو نمی‌بینه. هر وقت بخوای اتصال رو قطع می‌کنی.</p>
    <button class="pill-btn red block" data-act="invite" ${busy ? 'disabled' : ''}>${busy ? 'کمی صبر کن…' : 'افزودن پارتنر'}</button>`;
}
function usPending() {
  const url = inviteUrl(S.inviteCode);
  return `<div class="center" style="padding-top:8px"><div class="duo"><span class="avatar her">${initial(S.herName)}</span><span class="avatar empty">…</span></div>
    <h1 class="page-title">دعوت <span class="serif">آماده‌ست</span></h1>
    <p class="page-lead" style="margin-top:8px">این لینک رو برای پارتنرت بفرست. وقتی بازش کنه و قبول کنه، اینجا به هم وصل می‌شید.</p></div>
    <div class="card white stack"><div class="linkbox"><code>${esc(url)}</code><button class="round-btn flat" data-act="invite-copy" aria-label="کپی">${ic('copy')}</button></div>
      <button class="pill-btn red block" data-act="invite-share">${ic('share')} فرستادن لینک</button></div>
    <div class="card"><div class="row">${glyph('lock', '#8D8781')}<p style="font-size:14px;color:var(--ink-2)">لینک فقط یه بار کار می‌کنه و فقط برای کسیه که براش می‌فرستی.</p></div></div>
    <div class="center"><button class="text-link" style="color:var(--muted)" data-act="invite-cancel">لغو دعوت</button></div>`;
}
function statusEditor() {
  const st = todayStatus() || { mood: null, needs: [], text: '' };
  return `<div class="card peach"><div class="card-label">امروز حالم…</div>
    <div class="moods">${MOODS.map((m, i) => `<button class="mood ${st.mood === i ? 'on' : ''}" data-act="mood" data-i="${i}">${face(i)}<span>${m}</span></button>`).join('')}</div>
    <div class="card-label" style="margin-top:18px">امروز لازم دارم…</div>
    <div class="chips">${NEEDS.map(n => `<button class="chip ${(st.needs || []).includes(n[0]) ? 'on' : ''}" style="--c:var(--orange)" data-act="need" data-v="${n[0]}">${n[1]}</button>`).join('')}</div>
    <div class="field" style="margin-top:16px"><label for="status-text">یه جمله برای ${partnerN()}</label><input class="input" id="status-text" maxlength="140" placeholder="مثلاً امروز فقط بغل می‌خوام" value="${esc(st.text || '')}" data-input="status-text"></div>
    <p class="fine" style="text-align:right;padding:8px 0 0">${partnerN()} همین الان می‌بینه.</p>
  </div>`;
}
function statusView() {
  const st = todayStatus();
  if (!st) return `<div class="card peach"><div class="row">${face(2, 44)}<div><b style="font-weight:500">${herN()} هنوز حال امروزش رو نگفته</b><div class="muted" style="font-size:13.5px">یه یادداشت مهربون بفرست</div></div></div></div>`;
  const needs = (st.needs || []).map(n => (NEEDS.find(x => x[0] === n) || [])[1]).filter(Boolean);
  return `<div class="card peach"><div class="card-label">حال امروز ${herN()}</div>
    <div class="row">${face(st.mood != null ? st.mood : 2, 52)}<div><h3>${st.mood != null ? MOODS[st.mood] : ''}</h3>${st.text ? `<p style="color:var(--ink-2)">«${esc(st.text)}»</p>` : ''}</div></div>
    ${needs.length ? `<div class="card-label" style="margin-top:16px">امروز لازم داره</div><div class="chips">${needs.map(n => `<span class="chip static on" style="--c:var(--orange)">${n}</span>`).join('')}</div>` : ''}
  </div>`;
}
function notesCard() {
  const notes = (S.notes || []).slice(-50);
  return `<div class="card white"><div class="card-label">یادداشت‌ها</div>
    <div class="notes" id="notes">${notes.length ? notes.map(n => { const mine = n.uid === ME.uid || (!CLOUD && n.from === ME.role); return `<div class="note ${mine ? 'mine' : 'theirs'}"><div>${esc(n.text)}</div><div class="meta"><span>${n.from === 'her' ? herN() : partnerN()}، ${Cal.short(new Date(n.at))}</span>${mine || isHer() ? `<button data-act="note-del" data-id="${n.id}">حذف</button>` : ''}</div></div>`; }).join('') : `<p class="muted" style="font-size:14.5px">یه جمله‌ی مهربون، یه یادآوری یا یه «دوستت دارم» بنویس.</p>`}</div>
    <div class="composer"><input class="input" id="note-new" maxlength="300" placeholder="بنویس…"><button class="pill-btn red" data-act="note-add" aria-label="فرستادن">${ic('send')}</button></div></div>`;
}
function kitCard(p) {
  const items = S.kit.items || {}; const done = CARE_KIT.filter(c => items[c[0]]).length;
  const dn = p.hasData ? (p.lateDays > 0 ? 0 : p.daysToNext) : null;
  const sub = !p.hasData ? '' : p.inPeriod ? 'الان روزهای پریوده؛ همه چی آماده‌ست؟' : dn <= 5 ? `فقط ${fa(dn)} روز مونده؛ وقت آماده شدنه.` : `پریود بعدی ${relDays(dn)}.`;
  return `<div class="card"><div class="card-label">کیت مراقبت <span>${fa(done)} از ${fa(CARE_KIT.length)}</span></div>${sub ? `<p style="color:var(--ink-2);font-size:14.5px;margin:-4px 0 6px">${sub}</p>` : ''}
    ${CARE_KIT.map(([id, l]) => `<button class="check ${items[id] ? 'on' : ''}" data-act="kit" data-v="${id}"><span class="box">${items[id] ? ic('check') : ''}</span><span class="lbl">${l}</span></button>`).join('')}
    <button class="text-link" style="margin-top:10px" data-act="kit-reset">شروع دوباره برای چرخه‌ی بعد</button></div>`;
}

// =================================================================
// Menu (more) & articles
// =================================================================
function viewMore() {
  const you = isHer(); const pr = S.profile;
  const row = (act, g, color, t, sub, extra = '') => `<button class="list-row" data-act="${act}" ${extra}>${glyph(g, color)}<div class="main"><b>${t}</b>${sub ? `<small>${sub}</small>` : ''}</div><span class="chev">${ic('chevL')}</span></button>`;
  return `<div class="card white"><div class="row">${`<span class="avatar ${you ? 'her' : 'him'}" style="width:52px;height:52px;font-size:20px;border:0">${initial(you ? S.herName : (ME.name || S.partnerName))}</span>`}
      <div style="flex:1;min-width:0"><b style="font-weight:500;font-size:17px">${esc(you ? S.herName : (ME.name || S.partnerName))}</b><div class="muted latin" style="font-size:13px;overflow:hidden;text-overflow:ellipsis">${esc(ME.email || (CLOUD ? '' : 'نسخه‌ی محلی'))}</div></div></div></div>
    ${you ? `<div class="card white"><div class="card-label">چرخه</div>
      ${row('cycle-settings', 'cycle', '#0C7A92', 'تنظیمات چرخه', `چرخه ${fa(pr.cycleLength)} روزه، پریود ${fa(pr.periodLength)} روزه`)}
      ${row('mode-sheet', MODES[pr.mode].glyph, MODES[pr.mode].color, 'حالت', MODES[pr.mode].name)}
      ${row('cats-sheet', 'sparkle', '#9A6CC6', 'دسته‌های ثبت', 'انتخاب کن چی رو دنبال کنی')}
      <div class="list-row">${glyph('pill', '#3B6FD8')}<div class="main"><b>یادآور قرص ضدبارداری</b><small>یه کارت روزانه در صفحه‌ی چرخه</small></div><label class="switch"><input type="checkbox" data-act="pill-toggle" ${pr.pill ? 'checked' : ''}><span></span></label></div>
    </div>` : ''}
    <div class="card white"><div class="card-label">برنامه</div>
      ${row('look-sheet', 'sun', '#F26B1D', 'ظاهر و تقویم', `${P.calendar === 'persian' ? 'شمسی' : 'میلادی'}، ${P.theme === 'dark' ? 'تیره' : 'روشن'}`)}
      ${row('pin-sheet', 'lock', '#5A6B7B', 'قفل رمز', P.pin ? 'فعال' : 'غیرفعال')}
      ${row('ics', 'chart', '#E13336', 'افزودن به تقویم گوشی', 'پریودهای پیش رو با یادآور')}
      ${you ? row('backup', 'drops', '#0C7A92', 'دانلود نسخه‌ی پشتیبان', 'فایل JSON از همه‌ی ثبت‌ها') : ''}
    </div>
    <div class="card white"><div class="card-label">دانستنی‌ها</div>
      ${ARTICLES.map((a, i) => `<button class="art-row" data-act="go" data-r="article/${a.id}"><span class="art-num" style="background:${a.tint};color:var(--crimson)">${fa(i + 1)}</span><span><b>${a.title}</b><small>${fa(a.min)} دقیقه مطالعه</small></span></button>`).join('')}
    </div>
    <div class="card white">
      ${CLOUD ? `<button class="list-row" data-act="sign-out">${glyph('people', '#8D8781')}<div class="main"><b>خروج از حساب</b></div></button>` : ''}
      <button class="list-row" data-act="delete-account">${glyph('bolt', '#BD131F')}<div class="main"><b style="color:var(--red-deep)">حذف حساب و همه‌ی اطلاعات</b></div></button>
    </div>
    <p class="fine">Moon&Us، ساخته‌شده برای دو نفر<br>پیش‌بینی‌ها تقریبی‌اند و جایگزین مشاوره‌ی پزشکی نیستند.</p>
    <input type="file" id="restore-file" accept=".json,application/json" hidden>`;
}
function viewArticle(id) {
  const a = ARTICLES.find(x => x.id === id);
  if (!a) return `<p class="muted">مطلب پیدا نشد.</p>`;
  return `<article class="article"><h1>${a.title}</h1><p class="muted" style="font-size:13.5px;margin:6px 0 16px">${fa(a.min)} دقیقه مطالعه</p><div class="article-body">${a.body}</div></article>
    <p class="fine">این مطالب برای آگاهی عمومیه و جایگزین نظر پزشک نیست.</p>`;
}

// =================================================================
// Calendar export & backup
// =================================================================
function buildICS() {
  const p = predict(S); if (!p.hasData) return null;
  const d8 = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const who = isHer() ? '' : ` ${S.herName}`;
  const ev = (id, s, e, title, desc, alarm) => ['BEGIN:VEVENT', `UID:${id}@moonandus`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d8(s)}`, `DTEND;VALUE=DATE:${d8(addDays(e, 1))}`, `SUMMARY:${title}`, `DESCRIPTION:${desc}`, 'TRANSP:TRANSPARENT',
    ...(alarm ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, 'TRIGGER:-PT12H', 'END:VALARM'] : []), 'END:VEVENT'];
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Moon&Us//FA', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Moon&Us'];
  p.future.slice(0, 6).forEach(c => {
    out.push(...ev(`period-${d8(c.start)}`, c.start, c.periodEnd, `پریود${who} (پیش‌بینی)`, 'پیش‌بینی Moon&Us', true));
    if (c.ov && c.fertileEnd >= p.today) out.push(...ev(`fertile-${d8(c.fertileStart)}`, c.fertileStart, c.fertileEnd, `روزهای باروری${who}`, 'پنجره‌ی باروری تخمینی', false));
    if (c.pmsEnd >= p.today) out.push(...ev(`pms-${d8(c.pmsStart)}`, c.pmsStart, c.pmsEnd, `PMS احتمالی${who}`, 'صبوری و مهربونی بیشتر', false));
  });
  out.push('END:VCALENDAR');
  return out.join('\r\n');
}

// =================================================================
// Lock
// =================================================================
let pinBuf = '';
function lockView() {
  return `<div class="lock">${logo()}<p class="muted">رمز رو وارد کن</p>
    <div class="pin-dots" id="pin-dots">${[0, 1, 2, 3].map(i => `<i class="${i < pinBuf.length ? 'on' : ''}"></i>`).join('')}</div>
    <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="pin-key" data-v="${n}">${fa(n)}</button>`).join('')}<span></span><button data-act="pin-key" data-v="0">${fa(0)}</button><button data-act="pin-key" data-v="del" aria-label="پاک کردن">⌫</button></div>
    ${CLOUD ? `<button class="text-link" data-act="sign-out" style="color:var(--muted)">رمز یادم رفته (خروج و ورود دوباره)</button>` : ''}</div>`;
}

// =================================================================
// Actions
// =================================================================
function updateStatus(fn) {
  const k = toKey(todayDate());
  const cur = todayStatus() ? JSON.parse(JSON.stringify(S.status)) : { date: k, mood: null, needs: [], text: '' };
  cur.needs = cur.needs || [];
  fn(cur); cur.u = Date.now();
  DB.patch({ status: cur });
}

const A = {
  reload: () => location.reload(),
  go: el => { closeSheet(false); location.hash = el.dataset.r; },
  'to-auth': el => { authMode = el.dataset.mode; authError = ''; if (screen !== 'auth') authCtx = 'her'; if (!CLOUD && authMode === 'signup') { screen = 'onboard'; onb.step = 0; } else screen = 'auth'; render(); },
  'auth-back': () => { authError = ''; screen = pendingInvite ? 'invite' : 'welcome'; render(); },
  'sign-out': () => signOut(),

  'invite-signup': () => { authCtx = 'partner'; authMode = 'signup'; authError = ''; screen = 'auth'; render(); },
  'invite-login': () => { authCtx = 'partner'; authMode = 'login'; authError = ''; screen = 'auth'; render(); },
  'invite-decline': () => { clearInvite(); screen = ME.uid ? (ME.spaceId ? 'app' : 'disconnected') : 'welcome'; if (ME.uid && !ME.spaceId && ME.role === 'her') screen = 'onboard'; render(); },
  'invite-accept': async () => {
    busy = true; render();
    try { await acceptInvite(ME.name); } catch (e) { console.error(e); toast('اتصال انجام نشد. شاید لینک منقضی شده.'); }
    busy = false; render();
  },
  invite: async () => {
    busy = true; render();
    try { await Cloud.createInvite(ME.spaceId, ME.uid, S.herName); } catch (e) { console.error(e); toast('ساخت دعوت انجام نشد'); }
    busy = false; render();
  },
  'invite-share': () => shareText(`${S.herName} تو رو به Moon&Us دعوت کرده تا چرخه‌اش رو با هم دنبال کنید:\n${inviteUrl(S.inviteCode)}`, 'دعوت به Moon&Us'),
  'invite-copy': async () => { if (await copyText(inviteUrl(S.inviteCode))) toast('لینک کپی شد'); },
  'invite-cancel': () => { const c = S.inviteCode; DB.patch({ inviteCode: null }); if (CLOUD && c) Cloud.deleteInvite(c); },
  'remove-partner': () => confirmSheet('قطع اتصال', `${partnerN()} دیگه چرخه‌ات رو نمی‌بینه. هر وقت بخوای می‌تونی دوباره دعوتش کنی.`, 'remove-partner-yes', 'قطع اتصال'),
  'remove-partner-yes': () => { const c = S.inviteCode; DB.patch({ partnerUid: null, partnerName: '', inviteCode: null, joinedWith: null, joinedAt: null }); if (CLOUD && c) Cloud.deleteInvite(c); closeSheet(); toast('اتصال قطع شد'); },
  leave: () => confirmSheet('قطع اتصال', `دیگه چرخه‌ی ${herN()} رو نمی‌بینی، مگه اینکه دوباره دعوتت کنه.`, 'leave-yes', 'قطع اتصال'),
  'leave-yes': async () => { closeSheet(false); try { stopWatch(); await Cloud.leaveSpace(ME.spaceId, ME.uid); } catch (e) { console.error(e); } ME.spaceId = null; screen = 'disconnected'; render(); },

  log: () => openLog(toKey(todayDate())),
  'log-day': el => { if (el.disabled) return; sheetDay = el.dataset.k; refreshSheet(logSheetHtml(el.dataset.k)); },
  'quick-period': () => { editLog(toKey(todayDate()), l => { l.period = 'medium'; }); toast('پریود امروز ثبت شد'); },
  tag: el => {
    const { k, c, v } = el.dataset; const C = CAT_BY_ID[c];
    editLog(k, l => {
      if (c === 'period') { l.period = l.period === v ? null : v; return; }
      const arr = l.tags[c] || [];
      l.tags[c] = arr.includes(v) ? arr.filter(x => x !== v) : (C.single ? [v] : [...arr, v]);
    });
    refreshSheet(logSheetHtml(k));
  },
  pill: () => editLog(toKey(todayDate()), l => { const m = l.tags.meds || []; l.tags.meds = m.includes('pill') ? m.filter(x => x !== 'pill') : [...m, 'pill']; }),
  'pill-toggle': el => DB.patch({ profile: { ...S.profile, pill: el.checked } }),

  'sheet-close': () => closeSheet(),
  'sheet-bg': (el, e) => { if (e.target === el) closeSheet(); },
  'phase-sheet': () => phaseSheet(),
  'mode-sheet': () => modeSheet(),
  'set-mode': el => { DB.patch({ profile: { ...S.profile, mode: el.dataset.v } }); closeSheet(); },
  'cats-sheet': () => catsSheet(sheetDay),
  'cat-toggle': el => { const h = new Set(S.profile.hiddenCats); el.checked ? h.delete(el.dataset.c) : h.add(el.dataset.c); DB.patch({ profile: { ...S.profile, hiddenCats: [...h] } }); },
  'cats-done': () => { if (catReturn) { const k = catReturn; catReturn = null; openLog(k); } else closeSheet(); },
  'cycle-settings': () => cycleSettingsSheet(),
  'save-cycle': () => {
    const name = $('#f-her').value.trim();
    DB.patch({ herName: name || S.herName, profile: { ...S.profile, cycleLength: +$('#v-cycle').dataset.v, periodLength: +$('#v-period').dataset.v, luteal: +$('#v-luteal').dataset.v } });
    if (CLOUD && name) Cloud.setUserDoc(ME.uid, { name }).catch(() => {});
    closeSheet(); toast('ذخیره شد');
  },
  'look-sheet': () => lookSheet(),
  pref: el => { P[el.dataset.k] = el.dataset.v; savePrefs(); applyPrefs(); lookSheet(); render(); },
  'pin-sheet': () => pinSheet(),
  'pin-set': () => {
    const v = toLatinDigits($('#pin-in').value.trim());
    if (!/^\d{4}$/.test(v)) return toast('رمز باید ۴ رقم باشه');
    P.pin = hashPin(v); savePrefs(); unlocked = true; try { sessionStorage.setItem('moonus.unlocked', '1'); } catch (e) {}
    closeSheet(); toast('قفل فعال شد');
  },
  'pin-off': () => { P.pin = null; savePrefs(); closeSheet(); toast('قفل غیرفعال شد'); },
  'pin-key': el => {
    const v = el.dataset.v;
    if (v === 'del') pinBuf = pinBuf.slice(0, -1); else if (pinBuf.length < 4) pinBuf += v;
    if (pinBuf.length === 4) {
      const ok = hashPin(pinBuf) === P.pin; pinBuf = '';
      if (ok) { unlocked = true; try { sessionStorage.setItem('moonus.unlocked', '1'); } catch (e) {} render(); return; }
      render(); $('#pin-dots')?.classList.add('shake'); return;
    }
    render();
  },
  num: el => {
    const { id, d, min, max } = el.dataset; const v = $('#v-' + id);
    const nv = Math.max(+min, Math.min(+max, +v.dataset.v + +d)); v.dataset.v = nv; v.querySelector('b').textContent = fa(nv);
    if (screen === 'onboard') onb[id] = nv;
  },

  'cal-prev': () => { calAnchor = addDays(Cal.monthStart(calAnchor), -1); render(); },
  'cal-next': () => { calAnchor = addDays(Cal.monthDays(calAnchor).slice(-1)[0], 1); render(); },
  'cal-today': () => { calAnchor = todayDate(); render(); },
  'cal-edit': () => { calEdit = !calEdit; render(); },
  'cal-day': el => {
    const k = el.dataset.k; const d = fromKey(k); const t = todayDate();
    if (calEdit && isHer()) {
      if (d > t) return toast('روزهای آینده رو نمی‌شه ثبت کرد');
      editLog(k, l => { l.period = BLEED.includes(l.period) ? null : 'medium'; }); return;
    }
    if (d > t || !isHer()) dayInfoSheet(k); else openLog(k);
  },

  mood: el => updateStatus(st => { const i = +el.dataset.i; st.mood = st.mood === i ? null : i; }),
  need: el => updateStatus(st => { const v = el.dataset.v; st.needs = st.needs.includes(v) ? st.needs.filter(x => x !== v) : [...st.needs, v]; }),
  kit: el => { const items = { ...(S.kit.items || {}) }; items[el.dataset.v] = !items[el.dataset.v]; DB.patch({ kit: { u: Date.now(), items } }); },
  'kit-reset': () => DB.patch({ kit: { u: Date.now(), items: {} } }),
  'note-add': () => { const inp = $('#note-new'); const text = inp.value.trim(); if (!text) return; inp.value = ''; DB.addNote(text); setTimeout(() => { const w = $('#notes'); if (w) w.scrollTop = w.scrollHeight; }, 300); },
  'note-del': el => DB.deleteNote(el.dataset.id),
  compose: () => composeSheet(),
  'compose-send': () => { const t = $('#compose-text').value.trim(); if (!t) return; DB.addNote(t); closeSheet(); toast('یادداشت فرستاده شد'); },

  doctor: async () => { if (await copyText(doctorSummary(predict(S)))) toast('خلاصه کپی شد'); },
  ics: () => { const ics = buildICS(); if (!ics) return toast('هنوز پریودی ثبت نشده'); download('moon-and-us.ics', ics, 'text/calendar'); toast('فایل تقویم دانلود شد؛ بازش کن تا اضافه بشه'); },
  backup: () => { download(`moon-and-us-${toKey(todayDate())}.json`, JSON.stringify({ herName: S.herName, profile: S.profile, logs: S.logs }, null, 1), 'application/json'); toast('پشتیبان دانلود شد'); },

  'delete-account': () => confirmSheet('حذف حساب', isHer()
    ? 'حساب و همه‌ی ثبت‌ها، یادداشت‌ها و اتصال پارتنرت برای همیشه پاک می‌شه و قابل برگشت نیست. اگه می‌خوای، اول نسخه‌ی پشتیبان بگیر.'
    : 'حسابت پاک می‌شه و اتصالت به چرخه‌ی او قطع می‌شه. این کار قابل برگشت نیست.', 'delete-yes', 'حذف برای همیشه'),
  'delete-yes': async () => {
    closeSheet(false);
    if (!CLOUD) { try { localStorage.removeItem(LOCAL_KEY); } catch (e) {} S = emptyState(); screen = 'welcome'; render(); return; }
    try {
      stopWatch();
      if (isHer() && ME.spaceId) await Cloud.deleteSpaceAll(ME.spaceId, S.inviteCode);
      else if (ME.spaceId) await Cloud.leaveSpace(ME.spaceId, ME.uid).catch(() => {});
      await Cloud.deleteUserDoc(ME.uid);
      await Cloud.deleteAuthUser();
      try { localStorage.removeItem(cacheKey()); } catch (e) {}
      S = emptyState(); ME = { uid: null, role: 'her' }; screen = 'welcome'; render(); toast('حساب حذف شد');
    } catch (e) { console.error(e); toast(errMsg(e)); if (ME.spaceId) startWatch(); }
  },

  // onboarding
  'onb-next': () => {
    if (onb.step === 0) { onb.name = ($('#o-name')?.value || '').trim(); if (!onb.name) return toast('اسمت رو بنویس'); }
    onb.step = Math.min(ONB_STEPS - 1, onb.step + 1); render();
  },
  'onb-back': () => { if (onb.step === 0) return; onb.step--; render(); },
  'onb-pick': el => { onb.picked = el.dataset.k; onb.unknown = false; render(); },
  'onb-unknown': () => { onb.unknown = !onb.unknown; if (onb.unknown) onb.picked = null; render(); },
  'onb-mode': el => { onb.mode = el.dataset.v; render(); },
  'onb-done': () => finishOnboarding(),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = A[el.dataset.act]; if (!fn) return;
  if (el.tagName === 'BUTTON' && el.type === 'submit' && el.form) return;
  fn(el, e);
});
document.addEventListener('submit', e => { if (e.target.id === 'auth-form') { e.preventDefault(); submitAuth(); } });
let typeTimer;
document.addEventListener('input', e => {
  const el = e.target; const kind = el.dataset.input; if (!kind) return;
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => {
    if (kind === 'note') editLog(el.dataset.k, l => { const v = el.value.trim(); if (v) l.note = v; else delete l.note; });
    if (kind === 'temp') editLog(el.dataset.k, l => { const n = parseFloat(toLatinDigits(el.value).replace(/[٫,]/g, '.')); if (n > 34 && n < 43) l.temp = Math.round(n * 100) / 100; else delete l.temp; });
    if (kind === 'status-text') updateStatus(st => { st.text = el.value.trim(); });
  }, 500);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'note-new') A['note-add']();
  if (e.key === 'Enter' && e.target.id === 'o-name') A['onb-next']();
  if (e.key === 'Escape' && $('.sheet')) closeSheet();
});

// =================================================================
// Routing & boot
// =================================================================
function routeFromHash() {
  const h = location.hash.slice(1);
  if (!h || h.startsWith('invite/')) return null;
  return h;
}
function readInviteFromHash() {
  const m = location.hash.match(/^#invite\/([a-z0-9]{6,20})$/);
  if (m) pendingInvite = { code: m[1], data: null };
}
window.addEventListener('hashchange', async () => {
  const m = location.hash.match(/^#invite\/([a-z0-9]{6,20})$/);
  if (m) {
    if (isHer() && ME.spaceId) { toast('این لینک دعوت برای پارتنرته'); history.replaceState(null, '', '#cycle'); return; }
    pendingInvite = { code: m[1], data: null };
    if (CLOUD) { try { pendingInvite.data = await Cloud.getInvite(m[1]); } catch (e) {} }
    screen = 'invite'; render(); return;
  }
  if (screen !== 'app') return;
  route = routeFromHash() || 'cycle';
  render(); window.scrollTo(0, 0);
});

let lastDay = toKey(todayDate());
setInterval(() => { const k = toKey(todayDate()); if (k !== lastDay) { lastDay = k; if (!$('.sheet')) render(); } }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && toKey(todayDate()) !== lastDay) { lastDay = toKey(todayDate()); render(); } });

async function boot() {
  render();
  readInviteFromHash();
  if (!CLOUD) {
    loadCache();
    ME = { uid: 'local', role: 'her', spaceId: 'local', name: S.herName, email: '' };
    screen = S.onboarded ? 'app' : 'welcome';
    route = routeFromHash() || 'cycle';
    render(); return;
  }
  try { Cloud = await import('./cloud.js'); await Cloud.init(CFG); }
  catch (e) { console.error(e); screen = 'error'; render(); return; }
  if (pendingInvite) { try { pendingInvite.data = await Cloud.getInvite(pendingInvite.code); } catch (e) { console.error(e); } }
  Cloud.onAuth(handleAuth);
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
boot();
