/* Moon&Us — app (ES module). Globals from content.js + cycle.js. */
import CFG from './firebase-config.js';
import { viewInsights, reportView } from './insights.js';

const FORCE_LOCAL = new URLSearchParams(location.search).has('local'); // dev/testing only
const CLOUD = !!(CFG && CFG.apiKey) && !FORCE_LOCAL;
let Cloud = null;

// =================================================================
// State
// =================================================================
const PREFS_KEY = 'moonus.prefs';
const LOCAL_KEY = 'moonus.local';
const DELIVERED_KEY = 'moonus.delivered';
const DEFAULT_PROFILE = {
  cycleLength: 28, periodLength: 5, luteal: 14, horizon: 12, hormonal: false, pill: false,
  hiddenCats: ['test', 'skin', 'social', 'mind', 'urine', 'vulva', 'supp', 'sleepq'], catOrder: [],
  excludedCycles: [], avgOverride: { cycle: null, period: null },
};
const DEFAULT_REMINDERS = Object.fromEntries(REMINDER_TYPES.map(r => [r.id, { on: ['period_soon', 'period_due', 'period_late'].includes(r.id), time: r.time, days: r.days, text: '' }]));
const SETTINGS_KEYS = ['profile', 'modeHistory', 'pregnancy', 'pregHistory', 'intervals', 'tags', 'reminders'];
const emptyState = () => ({
  profile: { ...DEFAULT_PROFILE }, modeHistory: [], pregnancy: null, pregHistory: [], intervals: [], tags: [],
  reminders: JSON.parse(JSON.stringify(DEFAULT_REMINDERS)),
  logs: {}, status: null, kit: { u: 0, items: {} }, notes: [],
  herName: '', partners: {}, inviteCode: null, onboarded: false,
  shared: null, ovObserved: [], gifts: [], requests: [],
});

let S = emptyState();
let ME = { uid: null, role: 'her', spaceId: null, name: '', email: '' };
let P = { theme: 'auto', calendar: 'persian', pin: null, showDrafts: false, discreet: false, installSeen: false };
try { P = { ...P, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch (e) {}

let screen = 'boot';
let route = 'cycle';
let authMode = 'signup', authCtx = 'her', authError = '';
let busy = false, holdAuth = false;
let pendingInvite = null;
let unwatch = null;
let calAnchor = todayDate(), calEdit = false, calSel = toKey(todayDate()), calFilters = [];
let compareSel = [];
let rep = { personal: false, heat: true, history: true };
const freshOnb = () => ({ step: 0, account: null, consent: { terms: false, privacy: false, health: false }, goals: [], mode: 'period', name: '', birthYear: 1998, hormonal: null, picked: null, unknown: false, cycle: 28, period: 5, code: '', pname: '', codeError: '' });
let onb = freshOnb();
let logSearch = '', helpOpen = null;
let unlocked = false;
try { unlocked = sessionStorage.getItem('moonus.unlocked') === '1'; } catch (e) {}

const isHer = () => ME.role === 'her';
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(P)); } catch (e) {} };
const cacheKey = () => CLOUD ? 'moonus.cache.' + ME.uid : LOCAL_KEY;
function saveCache() { try { localStorage.setItem(cacheKey(), JSON.stringify(S)); } catch (e) {} }
function migrate(s) {
  const out = { ...emptyState(), ...s, profile: { ...DEFAULT_PROFILE, ...(s.profile || {}) }, reminders: { ...JSON.parse(JSON.stringify(DEFAULT_REMINDERS)), ...(s.reminders || {}) } };
  const legacy = s.profile && s.profile.mode;
  if (!out.modeHistory || !out.modeHistory.length) out.modeHistory = [{ mode: LEGACY_MODES[legacy] || (MODES[legacy] ? legacy : 'period'), from: '1900-01-01' }];
  delete out.profile.mode;
  return out;
}
function loadCache() { try { const s = JSON.parse(localStorage.getItem(cacheKey()) || 'null'); if (s) S = migrate(s); } catch (e) {} }
const onbKey = () => 'moonus.onb.' + (ME.uid || 'local');
function saveOnb() { try { const { codeError, ...keep } = onb; localStorage.setItem(onbKey(), JSON.stringify(keep)); } catch (e) {} }
function loadOnb() { try { return JSON.parse(localStorage.getItem(onbKey()) || 'null'); } catch (e) { return null; } }
function clearOnb() { try { localStorage.removeItem(onbKey()); } catch (e) {} }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { const e = new Error('timeout'); e.code = 'timeout'; throw e; })]);
const engineState = () => ({ logs: S.logs, profile: S.profile, modeHistory: S.modeHistory, pregnancy: S.pregnancy, intervals: S.intervals, ovObserved: S.ovObserved || [] });
const mode = () => currentMode(engineState());

// =================================================================
// Helpers
// =================================================================
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const herN = () => esc(S.herName || 'او');
const partnerNames = () => Object.values(S.partners || {}).map(p => p.name).filter(Boolean);
const partnerN = () => esc(partnerNames().join(' و ') || 'پارتنرت');
const initial = s => esc((s || '؟').trim().charAt(0));
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800); }
function relDays(n) { if (n === 0) return 'امروز'; if (n === 1) return 'فردا'; if (n === -1) return 'دیروز'; return n > 0 ? `${fa(n)} روز دیگه` : `${fa(-n)} روز پیش`; }
function logIsEmpty(l) { return !l || (!l.period && !l.note && l.temp == null && l.weight == null && !l.painLevel && !(l.custom && l.custom.length) && !Object.values(l.tags || {}).some(a => a && a.length)); }
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
  const dark = P.theme === 'dark' || (P.theme === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
  const tc = document.querySelector('meta[name=theme-color]'); if (tc) tc.content = dark ? '#1F1E1C' : '#FBF9F6';
  if (Cal.type !== P.calendar) { Cal.type = P.calendar; Cal._fmt = {}; }
}
const AUTH_ERR = {
  'auth/email-already-in-use': 'با این ایمیل قبلاً حساب ساخته شده. «ورود» رو بزن.',
  'auth/invalid-email': 'ایمیل درست نیست.', 'auth/weak-password': 'رمز باید حداقل ۶ کاراکتر باشه.',
  'auth/invalid-credential': 'ایمیل یا رمز اشتباهه.', 'auth/wrong-password': 'ایمیل یا رمز اشتباهه.',
  'auth/user-not-found': 'حسابی با این ایمیل پیدا نشد.', 'auth/too-many-requests': 'تلاش زیاد بود. چند دقیقه بعد دوباره امتحان کن.',
  'auth/network-request-failed': 'اتصال اینترنت برقرار نیست.', timeout: 'اتصال به سرور خیلی کند بود. اینترنت رو چک کن و دوباره امتحان کن.', 'auth/requires-recent-login': 'برای این کار یه بار خارج شو و دوباره وارد شو.',
};
const errMsg = e => AUTH_ERR[e && e.code] || 'یه مشکلی پیش اومد. دوباره امتحان کن.';
let syncWarned = false;
function syncErr(e) { console.error('sync failed', e && e.code); if (!syncWarned) { syncWarned = true; toast('ذخیره در سرور انجام نشد؛ تغییرات روی همین دستگاه نگه داشته شد و دوباره تلاش می‌شه'); setTimeout(() => { syncWarned = false; }, 10000); } }

// =================================================================
// Icons
// =================================================================
const UI = {
  menu: '<path d="M5 9h14M5 15h14"/>', chevR: '<path d="M9 5l7 7-7 7"/>', chevL: '<path d="M15 5l-7 7 7 7"/>', chevD: '<path d="M6 9.5l6 6 6-6"/>',
  chevU: '<path d="M6 14.5l6-6 6 6"/>', close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cycle: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="4" r="1.8" fill="currentColor" stroke="none"/>',
  cal: '<rect x="3.8" y="5.2" width="16.4" height="15" rx="3.4"/><path d="M3.8 9.8h16.4M8.3 3.2v3.6M15.7 3.2v3.6"/><circle cx="8.5" cy="14.2" r=".9" fill="currentColor"/><circle cx="12" cy="14.2" r=".9" fill="currentColor"/><circle cx="15.5" cy="14.2" r=".9" fill="currentColor"/>',
  insights: '<rect x="3.8" y="3.8" width="16.4" height="16.4" rx="4.4"/><path d="M7.6 15.2l3.1-3.6 2.6 2.1 3.2-4.6"/>',
  us: '<circle cx="9.2" cy="12" r="5.4"/><circle cx="14.8" cy="12" r="5.4"/>',
  heart: '<path d="M12 19.5s-7.4-4.5-7.4-10a4.1 4.1 0 0 1 7.4-2.4 4.1 4.1 0 0 1 7.4 2.4c0 5.5-7.4 10-7.4 10z"/>',
  share: '<path d="M12 15V4M8 7.5l4-3.5 4 3.5"/><path d="M6 11v7.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V11"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  send: '<path d="M20 4L9.5 14.5M20 4l-6.5 16-4-5.5L4 10.5 20 4z"/>', info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
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
  bell: '<path d="M12 3a6 6 0 0 1 6 6v5.5l1.6 2.2c.3.4 0 1-.5 1H4.9c-.5 0-.8-.6-.5-1L6 14.5V9a6 6 0 0 1 6-6zM9.5 19h5a2.5 2.5 0 0 1-5 0z"/>',
  tag: '<path d="M3.5 4.7A1.2 1.2 0 0 1 4.7 3.5h6.6l9.2 9.2-7.8 7.8-9.2-9.2zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z"/>',
};
const glyph = (name, color, cls = 'ic') => `<span class="${cls}" style="background:${color}"><svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true">${GLYPHS[name] || ''}</svg></span>`;
function logo(size = '') {
  if (size === 'mark') return `<svg viewBox="0 0 40 40" class="mark" aria-hidden="true"><path d="M20 9.75A11 11 0 0 1 20 30.25A11 11 0 0 1 20 9.75Z" fill="#FFD3CC"/><circle cx="15.5" cy="20" r="11" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="24.5" cy="20" r="11" fill="none" stroke="#fff" stroke-width="1.7"/></svg>`;
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
const draftBadge = () => `<span class="tag warn">پیش‌نویس، بازبینی پزشکی نشده</span>`;

// =================================================================
// Data layer (owner writes; viewer reads projection)
// =================================================================
let shareTimer;
function publishShared() {
  if (!CLOUD || !isHer() || !ME.spaceId || !Object.keys(S.partners || {}).length) return;
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => Cloud.saveShared(ME.spaceId, sharedProjection(engineState())).catch(syncErr), 1200);
}
const DB = {
  setLog(k, l) {
    if (logIsEmpty(l)) { delete S.logs[k]; l = null; } else { l.u = Date.now(); S.logs[k] = l; }
    saveCache(); scheduleRender(); afterDataChange();
    if (CLOUD) Cloud.writeLog(ME.spaceId, k, l).catch(syncErr);
  },
  setLogs(map) {
    for (const [k, l] of Object.entries(map)) { if (logIsEmpty(l)) { delete S.logs[k]; map[k] = null; } else S.logs[k] = l; }
    saveCache(); scheduleRender(); afterDataChange();
    if (CLOUD) Cloud.writeLogs(ME.spaceId, map).catch(syncErr);
  },
  settings(patch) {
    Object.assign(S, patch); saveCache(); scheduleRender(); afterDataChange();
    if (CLOUD) Cloud.saveSettings(ME.spaceId, Object.fromEntries(SETTINGS_KEYS.map(k => [k, S[k] ?? null]))).catch(syncErr);
  },
  space(patch) { Object.assign(S, patch); saveCache(); scheduleRender(); if (CLOUD) Cloud.updateSpace(ME.spaceId, patch).catch(syncErr); },
  status(st) { S.status = st; saveCache(); scheduleRender(); if (CLOUD) Cloud.saveStatus(ME.spaceId, st).catch(syncErr); },
  kit(kit) { S.kit = kit; saveCache(); scheduleRender(); if (CLOUD) Cloud.saveKit(ME.spaceId, kit).catch(syncErr); },
  addNote(text) {
    const n = { from: ME.role, uid: ME.uid || 'local', name: ME.name || '', text, at: Date.now() };
    if (CLOUD) { Cloud.addNote(ME.spaceId, n).catch(syncErr); pushEvent(isHer() ? 'partners' : 'owner', ME.name || 'Moon&Us', 'یه یادداشت جدید برات نوشت', 'note-' + n.at, 'us'); }
    else { S.notes.push({ id: Date.now().toString(36), ...n }); saveCache(); scheduleRender(); }
  },
  addGift(g) {
    const doc = { ...g, uid: ME.uid || 'local', fromName: ME.name || '', at: Date.now(), openedAt: null, redeemedAt: null, reaction: null };
    if (CLOUD) {
      const { id, done } = Cloud.addItemWithId(ME.spaceId, 'gifts', doc); done.catch(syncErr);
      if (!g.unlockAt) pushEvent('owner', 'Moon&Us', `${ME.name || 'یه نفر'} یه چیزی برات گذاشت`, 'gift-' + id, 'us');
      return;
    }
    S.gifts.push({ id: 'g' + Date.now().toString(36), ...doc }); saveCache(); scheduleRender();
  },
  updateGift(id, patch) { S.gifts = S.gifts.map(g => g.id === id ? { ...g, ...patch } : g); saveCache(); scheduleRender(); if (CLOUD) Cloud.updateItem(ME.spaceId, 'gifts', id, patch).catch(syncErr); },
  deleteGift(id) { S.gifts = S.gifts.filter(g => g.id !== id); saveCache(); scheduleRender(); if (CLOUD) Cloud.deleteItem(ME.spaceId, 'gifts', id).catch(syncErr); },
  addRequest(kind) {
    const doc = { kind, uid: ME.uid || 'local', at: Date.now(), status: 'open', ackAt: null };
    if (CLOUD) {
      const { id, done } = Cloud.addItemWithId(ME.spaceId, 'requests', doc); done.catch(syncErr);
      pushEvent('partners', S.herName || 'Moon&Us', (REQ_BY_ID[kind] || [, 'درخواست'])[1], 'req-' + id, 'us');
      return;
    }
    S.requests.push({ id: 'r' + Date.now().toString(36), ...doc }); saveCache(); scheduleRender();
  },
  updateRequest(id, patch) {
    const r0 = S.requests.find(r => r.id === id);
    S.requests = S.requests.map(r => r.id === id ? { ...r, ...patch } : r); saveCache(); scheduleRender();
    if (CLOUD) {
      Cloud.updateItem(ME.spaceId, 'requests', id, patch).catch(syncErr);
      if (!isHer() && patch.status && r0) pushEvent('owner', ME.name || 'Moon&Us', `${REQ_STATUS[patch.status]}: ${(REQ_BY_ID[r0.kind] || [, ''])[1]}`, 'ack-' + id + patch.status, 'us');
    }
  },
  deleteRequest(id) { S.requests = S.requests.filter(r => r.id !== id); saveCache(); scheduleRender(); if (CLOUD) Cloud.deleteItem(ME.spaceId, 'requests', id).catch(syncErr); },
  deleteNote(id) { S.notes = S.notes.filter(n => n.id !== id); saveCache(); scheduleRender(); if (CLOUD) Cloud.deleteNote(ME.spaceId, id).catch(syncErr); },
};
function afterDataChange() { publishShared(); scheduleReminders(); }
function editLog(k, fn) {
  const l = S.logs[k] ? JSON.parse(JSON.stringify(S.logs[k])) : {};
  l.tags = l.tags || {};
  fn(l);
  for (const c of Object.keys(l.tags)) if (!l.tags[c] || !l.tags[c].length) delete l.tags[c];
  if (!Object.keys(l.tags).length) delete l.tags;
  for (const f of ['period', 'painLevel', 'note']) if (!l[f]) delete l[f];
  if (l.custom && !l.custom.length) delete l.custom;
  DB.setLog(k, l);
}
function setMode(m, from = toKey(todayDate()), extra = {}) {
  const h = (S.modeHistory || []).filter(e => e.from !== from);
  h.push({ mode: m, from }); h.sort((a, b) => (a.from < b.from ? -1 : 1));
  DB.settings({ modeHistory: h, ...extra });
}

let giftsLoaded = false, requestsLoaded = false;
function startWatch() {
  stopWatch(); giftsLoaded = false; requestsLoaded = false;
  const onError = e => { console.error('watch', e && e.code); if (e && e.code === 'permission-denied') spaceGone(); };
  const common = {
    onSpace: d => {
      if (!d) return spaceGone();
      S.herName = d.herName || ''; S.partners = d.partners || {}; S.inviteCode = d.inviteCode || null;
      if (!isHer() && !(ME.uid in S.partners)) return spaceGone();
      saveCache(); scheduleRender();
    },
    onStatus: d => { S.status = d && d.date ? d : null; saveCache(); scheduleRender(); },
    onKit: d => { S.kit = d || { u: 0, items: {} }; saveCache(); scheduleRender(); },
    onNotes: notes => { S.notes = notes; saveCache(); scheduleRender(); },
    onGifts: gifts => {
      const known = new Set((S.gifts || []).map(g => g.id)); const first = !giftsLoaded; giftsLoaded = true;
      S.gifts = gifts; saveCache(); scheduleRender();
      if (!first && isHer()) gifts.filter(g => !known.has(g.id) && g.uid !== ME.uid).forEach(g => notify('Moon&Us', P.discreet ? DISCREET_TEXT : `${g.fromName || 'یه نفر'} یه چیزی برات گذاشت`, 'gift-' + g.id));
    },
    onRequests: reqs => {
      const prev = Object.fromEntries((S.requests || []).map(r => [r.id, r])); const first = !requestsLoaded; requestsLoaded = true;
      S.requests = reqs; saveCache(); scheduleRender();
      if (first) return;
      for (const r of reqs) {
        const R = REQ_BY_ID[r.kind] || [, 'درخواست'];
        if (!isHer() && !prev[r.id]) notify(`${S.herName || 'Moon&Us'}`, P.discreet ? DISCREET_TEXT : R[1], 'req-' + r.id);
        if (isHer() && prev[r.id] && prev[r.id].status !== r.status && r.status !== 'open') notify('Moon&Us', P.discreet ? DISCREET_TEXT : `${pname()}: ${REQ_STATUS[r.status]} (${R[1]})`, 'ack-' + r.id + r.status);
      }
    },
    onError,
  };
  if (isHer()) {
    let first = true;
    unwatch = Cloud.watchOwner(ME.spaceId, {
      ...common,
      onSettings: d => { if (d) { for (const k of SETTINGS_KEYS) if (d[k] !== undefined && d[k] !== null) S[k] = d[k]; S.profile = { ...DEFAULT_PROFILE, ...S.profile }; S.reminders = { ...DEFAULT_REMINDERS, ...S.reminders }; } saveCache(); scheduleRender(); scheduleReminders(); },
      onLogs: logs => { S.logs = logs; saveCache(); scheduleRender(); if (first) { first = false; publishShared(); } scheduleReminders(); },
    });
  } else {
    unwatch = Cloud.watchViewer(ME.spaceId, {
      ...common,
      onShared: proj => {
        S.shared = proj || null;
        const st = stateFromProjection(proj || { bleedDays: [], mode: 'period' });
        S.logs = st.logs; S.profile = { ...DEFAULT_PROFILE, ...st.profile }; S.modeHistory = st.modeHistory; S.ovObserved = st.ovObserved;
        saveCache(); scheduleRender();
      },
    });
  }
}
function stopWatch() { if (unwatch) { unwatch(); unwatch = null; } }
function spaceGone() {
  stopWatch();
  if (isHer()) { S = emptyState(); screen = 'onboard'; onb.step = 0; } else screen = 'disconnected';
  render();
}

// =================================================================
// Reminders (in-app + system notifications, calendar export)
// =================================================================
function reminderText(r) {
  const t = REMINDER_TYPES.find(x => x.id === r.type); const cfg = S.reminders[r.type] || {};
  if (P.discreet) return DISCREET_TEXT;
  const txt = (t.custom !== false && cfg.text) ? cfg.text : t.def;
  return txt.replace('{n}', fa(r.daysBefore || cfg.days || '')).replace('{phase}', r.subphase && SUBPHASES[r.subphase] ? SUBPHASES[r.subphase].name : 'فاز جدید');
}
function upcomingReminders(days = 7) {
  if (!isHer()) return [];
  const p = predict(engineState());
  return computeReminders(engineState(), S.reminders, { days, p });
}
function delivered() { try { return JSON.parse(localStorage.getItem(DELIVERED_KEY) || '[]'); } catch (e) { return []; } }
function markDelivered(id) { const d = delivered(); d.push(id); try { localStorage.setItem(DELIVERED_KEY, JSON.stringify(d.slice(-200))); } catch (e) {} }
async function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') { toast(body); return; }
  try { const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration(); if (reg) { await reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', lang: 'fa', dir: 'rtl' }); return; } } catch (e) {}
  try { new Notification(title, { body, tag }); } catch (e) { toast(body); }
}
function tickReminders() {
  if (screen !== 'app' || !isHer()) return;
  const now = new Date(); const done = new Set(delivered());
  for (const r of upcomingReminders(1)) if (r.when <= now && !done.has(r.id)) { markDelivered(r.id); notify('Moon&Us', reminderText(r), r.id); }
  if (S.reminders.stats_change && S.reminders.stats_change.on && mode() !== 'pregnancy') {
    const p = predict(engineState()); const key = 'moonus.lastAvg.' + (ME.uid || 'local');
    let last = null; try { last = JSON.parse(localStorage.getItem(key)); } catch (e) {}
    if (p.hasData && p.avgCycleObserved) {
      if (last && last !== p.avgCycleObserved) notify('Moon&Us', P.discreet ? DISCREET_TEXT : `میانگین طول چرخه‌ات از ${fa(last)} به ${fa(p.avgCycleObserved)} روز تغییر کرد.`, 'stats');
      try { localStorage.setItem(key, JSON.stringify(p.avgCycleObserved)); } catch (e) {}
    }
  }
}
let remTimer;
function scheduleReminders() {
  clearTimeout(remTimer);
  remTimer = setTimeout(async () => {
    tickReminders();
    uploadPushSchedule();
    try {
      if (!('caches' in window) || !isHer()) return;
      const list = upcomingReminders(7).map(r => ({ id: r.id, when: r.when.getTime(), body: reminderText(r) }));
      const c = await caches.open('moonus-reminders');
      await c.put('reminders.json', new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } }));
    } catch (e) {}
  }, 800);
}
setInterval(tickReminders, 60000);

// =================================================================
// Rendering
// =================================================================
let rafPending = false;
function scheduleRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); }
let lastView = '';
function render() {
  applyPrefs();
  const app = $('#app');
  const a = document.activeElement; let keep = null;
  if (a && a.id && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && app.contains(a)) keep = { id: a.id, v: a.value, s: a.selectionStart, e: a.selectionEnd };
  let html; let nav = false;
  if (screen === 'app' && P.pin && !unlocked) html = lockView();
  else switch (screen) {
    case 'boot': html = `<div class="boot">${logo('lg')}<div class="spinner"></div></div>`; break;
    case 'welcome': html = welcomeView(); break;
    case 'auth': html = authView(); break;
    case 'onboard': html = onboardView(); if (ME.uid) saveOnb(); break;
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
// Welcome, auth, invite, onboarding
// =================================================================
function welcomeView() {
  // Three full-bleed intro slides, swipeable (scroll-snap). Written only for her.
  const tiles = [['bolt', '#E0457B', 'سردرد'], ['leaf', '#4A6FD0', 'نفخ'], ['sun', '#E8730C', 'پرانرژی'], ['flame', '#0E8A70', 'میل زیاد'], ['heart', '#4A6FD0', 'حساسیت سینه'], ['run', '#0E8A70', 'دویدن'], ['cookie', '#E8730C', 'هوس شیرینی'], ['moon', '#B8467A', 'خواب بد']];
  const miniWheel = () => {
    const R = 120, W = 24; const arc = (a0, a1, c) => { const p = a => [(R * Math.cos((a - 90) * Math.PI / 180)).toFixed(1), (R * Math.sin((a - 90) * Math.PI / 180)).toFixed(1)]; const [x0, y0] = p(a0), [x1, y1] = p(a1); return `<path d="M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1}" stroke="${c}" stroke-width="${W}" stroke-linecap="round" fill="none"/>`; };
    return `<svg viewBox="-160 -160 320 320" class="intro-wheel" aria-hidden="true"><circle r="${R}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="${W}"/>${arc(8, 60, '#FF4D41')}${arc(130, 205, '#16A3BF')}${arc(300, 345, '#C9AEE6')}<circle cx="${(R * Math.cos(160 * Math.PI / 180 - Math.PI / 2)).toFixed(1)}" cy="${(R * Math.sin(160 * Math.PI / 180 - Math.PI / 2)).toFixed(1)}" r="11" fill="#8FD6EE"/><g transform="translate(-120 0)"><circle r="26" fill="#2B2A28"/><text y="-6" text-anchor="middle" font-size="10" fill="#bbb" font-family="Vazirmatn">روز</text><text y="13" text-anchor="middle" font-size="19" font-weight="600" fill="#fff" font-family="Vazirmatn">۲۳</text></g><text y="-6" text-anchor="middle" font-size="22" font-weight="600" fill="#fff" font-family="Vazirmatn">۶ روز تا</text><text y="24" text-anchor="middle" font-size="22" font-weight="600" fill="#fff" font-family="Vazirmatn">پریود بعدی</text></svg>`;
  };
  const slides = [
    { bg: '#0B4756', accent: '#8FDCF5', t1: 'نقطه‌ها رو به هم وصل کن.', t2: 'چرخه‌ات، رمزگشایی‌شده.', vis: miniWheel() },
    { bg: '#5E2508', accent: '#FF8A3D', t1: 'فراتر از خونریزی.', t2: 'هرچی بیشتر ثبت کنی، بیشتر می‌دونی.', vis: `<div class="intro-tiles">${tiles.map(t => `<div>${glyph(t[0], t[1], 'tile')}<span>${t[2]}</span></div>`).join('')}</div>` },
    { bg: '#0A4A40', accent: '#3FD0A8', t1: 'توی ذهنت نیست.', t2: 'توی داده‌هاته.', vis: `<div class="intro-stats">
        <div class="is-card"><b>آمار چرخه</b><div class="is-row teal"><small>طول چرخه</small><span>۳۰ روز</span></div><div class="is-row brown"><small>نوسان چرخه</small><span>۸ روز</span></div></div>
        <div class="is-card"><b>مرور دل‌درد</b><div class="is-bars">${[2, 5, 7, 5, 3, 1, 0, 0].map(h => `<i style="height:${6 + h * 7}px"></i>`).join('')}</div><div class="is-line"></div></div>
        <div class="is-card wide"><b>شدت پریود</b>${[4, 5, 4, 5, 3].map(n => `<div class="is-flow">${Array.from({ length: n }, (_, i) => `<i class="f${i === 2 ? 3 : i === 1 || i === 3 ? 2 : 1}"></i>`).join('')}</div>`).join('')}</div></div>` },
  ];
  return `<div class="intro">
    <div class="intro-track" id="intro-track">${slides.map((s, i) => `<section class="intro-slide" style="--bg:${s.bg};--acc:${s.accent}" data-i="${i}">
      <div class="intro-dots">${slides.map((_, j) => `<i class="${i === j ? 'on' : ''}"></i>`).join('')}</div>
      <h1>${s.t1}<span>${s.t2}</span></h1><div class="intro-vis">${s.vis}</div></section>`).join('')}</div>
    <div class="intro-foot"><button class="intro-link" data-act="to-auth" data-mode="login">حساب دارم</button><button class="intro-cta" data-act="to-auth" data-mode="signup">ساخت حساب</button></div>
  </div>`;
}

function authView() {
  const partner = authCtx === 'partner'; const inv = pendingInvite && pendingInvite.data;
  const titles = { signup: partner ? 'حسابت رو بساز' : 'یه حساب بساز', login: 'خوش برگشتی', reset: 'بازیابی رمز' };
  const subs = {
    signup: partner && inv ? `بعد از ساخت حساب، به ${esc(inv.herName)} وصل می‌شی.` : 'با حساب، اطلاعاتت روی همه‌ی دستگاه‌ها امن می‌مونه.',
    login: partner && inv ? `بعد از ورود، دعوت ${esc(inv.herName)} رو قبول کن.` : 'با ایمیل و رمزت وارد شو.', reset: 'ایمیلت رو بنویس تا لینک ساخت رمز جدید برات بفرستیم.',
  };
  return `<div class="qscreen"><div class="qtop"><button class="round-btn" data-act="auth-back" aria-label="برگشت">${ic('chevR')}</button><span style="flex:1"></span>${logo('sm')}</div>
    <form class="qbody" id="auth-form" autocomplete="on" novalidate><h1 class="qtitle">${titles[authMode]}</h1><p class="qsub">${subs[authMode]}</p>
      ${authMode === 'signup' && partner ? `<div class="field"><label for="a-name">اسمت</label><input class="input" id="a-name" maxlength="24" autocomplete="given-name" placeholder="مثلاً علی"></div>` : ''}
      <div class="field"><label for="a-email">ایمیل</label><input class="input ltr" id="a-email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com"></div>
      ${authMode !== 'reset' ? `<div class="field"><label for="a-pass">رمز عبور</label><input class="input ltr" id="a-pass" type="password" autocomplete="${authMode === 'signup' ? 'new-password' : 'current-password'}" placeholder="${authMode === 'signup' ? 'حداقل ۶ کاراکتر' : ''}"></div>` : ''}
      ${authError ? `<div class="form-error">${esc(authError)}</div>` : ''}
      ${authMode === 'login' ? `<button type="button" class="text-link" data-act="to-auth" data-mode="reset" style="align-self:flex-start">رمزت رو فراموش کردی؟</button>` : ''}
      <div class="qfoot"><button type="submit" class="pill-btn red block" ${busy ? 'disabled' : ''}>${busy ? 'کمی صبر کن…' : authMode === 'signup' ? (partner ? 'ساخت حساب و اتصال' : 'ساخت حساب') : authMode === 'login' ? 'ورود' : 'ارسال لینک'}</button>
        ${authMode === 'signup' ? `<button type="button" class="text-link" style="justify-content:center" data-act="to-auth" data-mode="login">حساب داری؟ وارد شو</button>` : ''}
        ${authMode === 'login' ? `<button type="button" class="text-link" style="justify-content:center" data-act="to-auth" data-mode="signup">حساب نداری؟ بساز</button>` : ''}</div>
    </form></div>`;
}
async function submitAuth() {
  const email = ($('#a-email')?.value || '').trim(); const pass = $('#a-pass')?.value || ''; const name = ($('#a-name')?.value || '').trim();
  authError = '';
  if (!email) { authError = 'ایمیلت رو بنویس.'; return render(); }
  if (authMode === 'signup' && authCtx === 'partner' && !name) { authError = 'اسمت رو بنویس.'; return render(); }
  busy = true; render();
  try {
    if (authMode === 'reset') { await Cloud.resetPassword(email); busy = false; authMode = 'login'; toast('لینک بازیابی به ایمیلت فرستاده شد'); render(); return; }
    if (authMode === 'signup') {
      if (authCtx === 'partner') { holdAuth = true; const cred = await Cloud.signUp(email, pass); ME = { uid: cred.user.uid, role: 'partner', spaceId: null, name, email }; await acceptInvite(name); }
      else await Cloud.signUp(email, pass);
    } else await Cloud.signIn(email, pass);
  } catch (e) { holdAuth = false; authError = errMsg(e); }
  busy = false; render();
}
async function handleAuth(user) {
  if (holdAuth) return;
  stopWatch();
  if (!user) { ME = { uid: null, role: 'her', spaceId: null, name: '', email: '' }; S = emptyState(); if (screen !== 'auth') screen = pendingInvite ? 'invite' : 'welcome'; render(); return; }
  ME.uid = user.uid; ME.email = user.email || '';
  let u = null; try { u = await Cloud.getUserDoc(user.uid); } catch (e) { console.error('user doc', e && e.code); }
  if (pendingInvite && u && u.role === 'her') { toast('این لینک دعوت برای کس دیگه‌ایه'); clearInvite(); }
  if (pendingInvite && (!u || u.role === 'partner')) { ME.role = 'partner'; ME.name = (u && u.name) || ''; screen = 'invite'; render(); return; }
  if (!u || !u.spaceId) {
    if (u && u.role === 'partner') { ME.role = 'partner'; ME.name = u.name || ''; screen = 'disconnected'; render(); return; }
    ME.role = 'her';
    if (screen !== 'onboard') { const saved = loadOnb(); onb = saved ? { ...freshOnb(), ...saved, consent: { ...freshOnb().consent, ...(saved.consent || {}) } } : freshOnb(); }
    screen = 'onboard'; render();
    if (onb.done) finishOnboarding();
    return;
  }
  ME.role = u.role; ME.spaceId = u.spaceId; ME.name = u.name || '';
  loadCache(); screen = 'app'; route = routeFromHash() || 'cycle';
  startWatch(); render(); scheduleReminders(); setTimeout(maybeInstallPrompt, 2500);
}
async function acceptInvite(name) {
  const inv = pendingInvite.data;
  await withTimeout(Cloud.joinSpace(pendingInvite.code, inv, ME.uid, name || ME.name || ''), 20000);
  ME.spaceId = inv.spaceId; ME.role = 'partner'; ME.name = name || ME.name; holdAuth = false;
  const herName = inv.herName; clearInvite();
  screen = 'app'; route = 'cycle'; history.replaceState(null, '', '#cycle');
  S = emptyState(); startWatch(); render(); toast(`به ${herName} وصل شدی`); setTimeout(maybeInstallPrompt, 2000);
}
function clearInvite() { pendingInvite = null; if (location.hash.startsWith('#invite/')) history.replaceState(null, '', '#'); }
async function signOut() {
  stopWatch(); try { localStorage.removeItem(cacheKey()); } catch (e) {}
  S = emptyState(); route = 'cycle'; history.replaceState(null, '', '#'); closeSheet(false);
  if (CLOUD) await Cloud.signOutUser();
  screen = 'welcome'; render();
}
function inviteView() {
  const inv = pendingInvite && pendingInvite.data;
  if (!inv || inv.usedBy) return `<header class="sitebar">${logo('sm')}<span></span></header><section class="hero-band"><h1 class="headline">این لینک دعوت <span class="serif">دیگه معتبر نیست</span></h1><p class="lead">شاید لغو شده یا قبلاً استفاده شده. ازش بخواه یه لینک جدید برات بفرسته.</p><button class="pill-btn red" data-act="invite-decline">باشه</button></section>`;
  const her = esc(inv.herName || 'او'); const loggedIn = !!ME.uid;
  const items = [['drop', '#E13336', `روزهای پریود ${her} و پیش‌بینی پریود بعدی`], ['egg', '#0C7A92', 'روزهای باروری، تخمک‌گذاری و PMS'], ['heart', '#E0457B', 'حال امروزش، اگه خودش بخواد به اشتراک بذاره'], ['people', '#2D8FD5', 'یادداشت‌های دونفره و کیت مراقبت']];
  return `<header class="sitebar">${logo('sm')}<span></span></header>
  <section class="hero-band"><div class="duo"><span class="avatar her">${initial(inv.herName)}</span><span class="avatar him">${loggedIn && ME.name ? initial(ME.name) : '+'}</span></div>
    <h1 class="headline" style="margin-top:14px">${her} تو رو به <span class="serif">Moon&Us</span> دعوت کرده</h1>
    <p class="lead">با قبول این دعوت، چرخه‌ی ${her} رو کنار هم دنبال می‌کنید و هر روز می‌دونی چطور بهتر کنارش باشی.</p></section>
  <section class="band" style="padding-top:28px"><div class="card">${items.map(i => `<div class="list-row">${glyph(i[0], i[1])}<div class="main"><b>${i[2]}</b></div></div>`).join('')}</div>
    <p class="fine" style="margin-top:14px">فقط می‌بینی و چیزی رو تغییر نمی‌دی. علائم، احساسات و یادداشت‌های روزانه‌اش به اشتراک گذاشته نمی‌شن. ${her} هر وقت بخواد اتصال رو قطع می‌کنه.</p>
    <div class="stack" style="margin-top:22px">${loggedIn
      ? `<button class="pill-btn red block" data-act="invite-accept" ${busy ? 'disabled' : ''}>${busy ? 'در حال اتصال…' : 'قبول دعوت'}</button><button class="text-link" style="justify-content:center" data-act="sign-out">با حساب دیگه وارد شو</button>`
      : `<button class="pill-btn red block" data-act="invite-signup">قبول دعوت</button><button class="pill-btn ghost block" data-act="invite-login">حساب دارم، ورود</button>`}
      <button class="text-link" style="justify-content:center;color:var(--muted)" data-act="invite-decline">نه، ممنون</button></div></section>`;
}
function disconnectedView() {
  return `<header class="sitebar">${logo('sm')}<span></span></header><section class="hero-band"><div class="duo"><span class="avatar empty">؟</span><span class="avatar him">${initial(ME.name)}</span></div>
    <h1 class="headline" style="margin-top:14px">فعلاً به کسی <span class="serif">وصل نیستی</span></h1><p class="lead">دسترسی قطع شده. اگه دوباره دعوتت کنه، کافیه لینک جدید رو باز کنی.</p>
    <div class="stack" style="margin-top:26px;max-width:320px;margin-inline:auto"><button class="pill-btn ghost block" data-act="sign-out">خروج از حساب</button><button class="text-link" style="justify-content:center;color:var(--muted)" data-act="delete-account">حذف حساب</button></div></section>`;
}

// ---- onboarding (after the account is created) ----
const GOALS = [
  ['next', 'drop', '#E13336', 'بدونم پریود بعدی کی میاد'],
  ['body', 'sparkle', '#16A3BF', 'بدنم رو بهتر بشناسم'],
  ['symptoms', 'chart', '#0E8A70', 'علائم رو ثبت کنم و الگوها رو ببینم'],
  ['doctor', 'bulb', '#9A4DB5', 'علائمم رو برای پزشک ثبت کنم'],
  ['conceive', 'egg', '#3B6FD8', 'باردار بشم'],
  ['pregnant', 'heart', '#7B5CD6', 'باردارم'],
  ['meno', 'flame', '#D9541E', 'تغییرات پیش‌یائسگی رو دنبال کنم'],
  ['noperiod', 'moon', '#B8467A', 'پریود نمی‌شم ولی می‌خوام علائمم رو ثبت کنم'],
];
const modeFromGoals = g => g.includes('pregnant') ? 'pregnancy' : g.includes('conceive') ? 'conceive' : g.includes('meno') ? 'perimenopause' : g.includes('noperiod') ? 'noperiod' : 'period';
const ENCOURAGE = {
  period: ['#7A1F3D', 'بدنت داستان خودش رو داره', ['هر روزی که ثبت می‌کنی، Moon&Us الگوی چرخه‌ی خودت رو بهتر یاد می‌گیره؛ نه یه عدد کلی برای همه.', 'کم‌کم می‌فهمی کی انرژیت بیشتره، کی دلت آرامش می‌خواد و پریودت کی میاد.']],
  conceive: ['#123F7A', 'قدم‌به‌قدم کنارتیم', ['اقدام به بارداری می‌تونه پر از امید و گاهی خستگی باشه.', 'روزهای پربارورتر رو از روی تاریخ پریودهات تخمین می‌زنیم. تست تخمک‌گذاری و دمای پایه اختیاری‌ان و اگه ثبتشون کنی، تخمین دقیق‌تر می‌شه.']],
  pregnancy: ['#5B2A86', 'به این سفر خوش اومدی', ['هفته‌به‌هفته کنارتیم: هفته و سه‌ماهه‌ات، حرکات جنین و تجربه‌هایی که می‌خوای ثبت کنی.', 'برای هر نگرانی، تیم درمانت بهترین همراهه.']],
  perimenopause: ['#7A2342', 'کنارت هستیم', ['پیش‌یائسگی می‌تونه دوره‌ای پر از احساسات متفاوت باشه. اگه تغییرات جسمی و ذهنی رو حس می‌کنی، بدون که تنها نیستی.', 'ثبت تجربه‌هات کمک می‌کنه ببینی چرخه‌ات در طول زمان چطور تغییر می‌کنه و با اطلاعات بیشتری با پزشکت صحبت کنی.']],
  noperiod: ['#3E2A6E', 'پریود نداری؟ مشکلی نیست', ['می‌تونی بدون ثبت خونریزی، احساسات و علائمت رو دنبال کنی و بازه‌ها رو خودت تعیین کنی؛ مثلاً اول هر ماه یا از روزی که دارو عوض شد.']],
};
function heartsArt() {
  const cols = ['#FF8A8A', '#F7B2C4', '#FFE0D2', '#FF6B4A', '#F5A6E8', '#FFC9A8', '#FF4D41', '#FFF1EA'];
  let s = ''; let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 22; i++) { const x = 60 + rnd() * 200, y = 30 + rnd() * 130, k = .6 + rnd() * .7, r = -30 + rnd() * 60; s += `<path transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) rotate(${r.toFixed(0)}) scale(${k.toFixed(2)})" d="M0 12C-14 2-20-6-12-13c5-4 10-2 12 3 2-5 7-7 12-3 8 7 2 15-12 25z" fill="${cols[i % cols.length]}"/>`; }
  return `<svg viewBox="0 0 320 190" class="onb-art" aria-hidden="true">${s}</svg>`;
}
function moonsArt() {
  const cols = [['#B3A6FF', '#FFE2CF'], ['#D8F2EC', '#2F6FB3'], ['#FF8E86', '#B7222A'], ['#3FC1A8', '#1E3F8A'], ['#FFE8E8', '#E58AA6'], ['#D9DEFF', '#3FC1A8'], ['#FF8A3D', '#3B6FD8'], ['#FFF0EE', '#1B8AA0']];
  return `<div class="onb-moons">${cols.map(c => `<svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="38" fill="${c[0]}"/><path d="M44 18A22 22 0 1 0 60 54 18 18 0 1 1 44 18z" fill="${c[1]}"/></svg>`).join('')}</div>`;
}
const TERMS_HTML = `<p>Moon&Us ابزاریه برای ثبت و آگاهی از چرخه‌ی قاعدگی. پیش‌بینی‌ها تخمینی‌اند و تشخیص پزشکی، درمان یا روش پیشگیری از بارداری نیستن.</p><p>تو مسئول اطلاعاتی هستی که ثبت می‌کنی و هر وقت بخوای می‌تونی حسابت و همه‌ی داده‌هات رو پاک کنی.</p><p>اگه کسی رو دعوت کنی، فقط چیزهایی رو می‌بینه که در صفحه‌ی «ما دوتا» نوشته شده و هر وقت بخوای دسترسی‌اش رو قطع می‌کنی.</p>`;
const PRIVACY_HTML = `<p><b>چی ذخیره می‌شه:</b> ایمیل، اسمت، تاریخ‌ها و چیزهایی که ثبت می‌کنی.</p><p><b>کجا:</b> در پایگاه داده‌ی Google Firebase (مرکز داده‌ی فرانکفورت) و روی دستگاه خودت.</p><p><b>کی می‌بینه:</b> فقط خودت. اگه کسی رو دعوت کنی، فقط روزهای پریود، باروری، تخمک‌گذاری و PMS و چیزهایی که خودت براش می‌فرستی رو می‌بینه؛ علائم، احساسات و یادداشت‌هات رو نه.</p><p><b>چی نمی‌کنیم:</b> فروش داده، تبلیغات، یا فرستادن داده‌ی سلامت به ابزارهای آماری یا هوش مصنوعی.</p><p><b>حذف:</b> از منو، «حذف حساب و همه‌ی اطلاعات».</p>`;

function onbSteps() {
  if (onb.account === 'code') return ['account', 'code'];
  const m = onb.mode;
  const base = ['account', 'consent', 'goals', 'encourage', 'name', 'age'];
  if (m === 'pregnancy') return [...base, 'preg', 'notify'];
  if (m === 'noperiod') return [...base, 'contra', 'interval', 'notify'];
  return [...base, 'contra', 'last', 'cycle', 'period', 'notify'];
}
function datePickerCard(selKey, act, maxDate = todayDate()) {
  return `<div class="card white">${monthGrid(calAnchor, d => {
    const k = toKey(d); const fut = d > maxDate;
    return `<button class="cal-day ${selKey === k ? 'picked' : ''} ${sameDay(d, todayDate()) ? 'today' : ''}" ${fut ? 'disabled' : `data-act="${act}" data-k="${k}"`}>${fa(Cal.parts(d).d)}</button>`;
  })}</div>`;
}
function onboardView() {
  const steps = onbSteps(); const s = Math.min(onb.step, steps.length - 1); const step = steps[s]; const t = todayDate();
  let body = '', canNext = true, top = '', foot = null, cls = '';
  if (step === 'account') {
    cls = 'band-top'; top = `<div class="onb-band" style="--band:#0A4A40">${moonsArt()}</div>`;
    body = `<h1 class="qtitle center">می‌خوای با این حساب <span class="serif">چرخه‌ی خودت</span> رو دنبال کنی؟</h1>
      <div class="stack" style="margin-top:8px"><button class="choice row-choice" data-act="onb-account" data-v="self">${glyph('cycle', '#0C7A92')}<div><b>آره</b></div><span class="chev">${ic('chevL')}</span></button>
      <button class="choice row-choice" data-act="onb-account" data-v="code">${glyph('heart', '#C2185B')}<div><b>نه، یه کد دارم تا چرخه‌ی کسی رو که دوستش دارم ببینم</b></div><span class="chev">${ic('chevL')}</span></button></div>`;
    foot = '';
  } else if (step === 'code') {
    canNext = !busy;
    body = `<h1 class="qtitle">کد دعوت رو <span class="serif">وارد کن</span></h1><p class="qsub">کدی که برات فرستاده رو بنویس. بعد از اتصال، فقط چیزهایی رو می‌بینی که خودش به اشتراک می‌ذاره.</p>
      <div class="field"><label for="o-code">کد دعوت</label><input class="input big ltr" id="o-code" autocomplete="off" autocapitalize="none" placeholder="abcd-efgh-jkmn" value="${esc(onb.code || '')}"></div>
      <div class="field"><label for="o-pname">اسم خودت</label><input class="input" id="o-pname" maxlength="24" placeholder="مثلاً میلاد" value="${esc(onb.pname || '')}"></div>
      ${onb.codeError ? `<div class="form-error">${esc(onb.codeError)}</div>` : ''}`;
    foot = `<button class="pill-btn red block" data-act="onb-join" ${busy ? 'disabled' : ''}>${busy ? 'در حال اتصال…' : 'وصل شو'}</button>`;
  } else if (step === 'consent') {
    const c = onb.consent; canNext = c.terms && c.privacy && c.health;
    body = `<div class="center"><span class="consent-logo">${logo('mark')}</span></div><h1 class="qtitle center">تو و <span class="serif">Moon&Us</span></h1>
      <p class="qsub center">قول می‌دیم اطلاعاتت رو امن و محرمانه نگه داریم. یه لحظه وقت بذار و ببین باهاشون چی کار می‌کنیم.</p><div class="divider"></div>
      ${[['terms', `<button class="text-link inline" data-act="legal" data-v="terms">شرایط استفاده</button>ی Moon&Us رو می‌پذیرم.`], ['privacy', `<button class="text-link inline" data-act="legal" data-v="privacy">حریم خصوصی</button> Moon&Us رو خوندم.`], ['health', 'موافقم Moon&Us اطلاعات سلامتی که ثبت می‌کنم رو پردازش کنه تا بتونه پیش‌بینی‌ها و تحلیل‌ها رو بسازه.']]
        .map(([k, txt]) => `<div class="consent-row"><button class="cbox ${c[k] ? 'on' : ''}" data-act="onb-consent" data-v="${k}" aria-label="تأیید">${c[k] ? ic('check') : ''}</button><p>${txt}</p></div>`).join('')}`;
  } else if (step === 'goals') {
    canNext = onb.goals.length > 0;
    body = `<h1 class="qtitle center">از Moon&Us <span class="serif">برای چی</span> می‌خوای استفاده کنی؟</h1><p class="qsub center">می‌تونی چند تا انتخاب کنی.</p>
      <div class="goal-grid">${GOALS.map(([id, g, col, label]) => `<button class="goal ${onb.goals.includes(id) ? 'on' : ''}" data-act="onb-goal" data-v="${id}">${glyph(g, col)}<b>${label}</b></button>`).join('')}</div>`;
  } else if (step === 'encourage') {
    const [band, title, paras] = ENCOURAGE[onb.mode];
    cls = 'band-top'; top = `<div class="onb-band tall" style="--band:${band}">${heartsArt()}</div>`;
    body = `<h1 class="qtitle center">${title}</h1>${paras.map(x => `<p class="qsub" style="margin-top:0">${x}</p>`).join('')}`;
  } else if (step === 'name') body = `<h1 class="qtitle">اسمت چیه؟</h1><p class="qsub">Moon&Us با همین اسم صدات می‌کنه.</p><input class="input big" id="o-name" maxlength="24" autocomplete="given-name" placeholder="مثلاً بهاره" value="${esc(onb.name)}">`;
  else if (step === 'age') {
    const y = new Date().getFullYear();
    body = `<h1 class="qtitle">سال تولدت <span class="serif">چنده؟</span></h1><p class="qsub">برای راهنمایی‌هایی که به سن بستگی دارن، مثل اقدام به بارداری یا پیش‌یائسگی. فقط سالش کافیه.</p>
      <div class="number-picker"><button data-act="num" data-id="birthYear" data-d="1" data-min="${y - 70}" data-max="${y - 9}" aria-label="بیشتر">+</button><div class="val" id="v-birthYear" data-v="${onb.birthYear}"><b>${fa(onb.birthYear)}</b><span>میلادی، حدود ${fa(y - onb.birthYear)} سال</span></div><button data-act="num" data-id="birthYear" data-d="-1" data-min="${y - 70}" data-max="${y - 9}" aria-label="کمتر">−</button></div>
      <button class="text-link" style="justify-content:center" data-act="onb-skip">ترجیح می‌دم نگم</button>`;
  } else if (step === 'contra') {
    canNext = onb.hormonal !== null;
    const opts = [['none', 'از روش هورمونی استفاده نمی‌کنم', 'یا از روش غیرهورمونی مثل کاندوم یا آی‌یودی مسی'], ['pill', 'قرص ضدبارداری', 'یادآور روزانه‌ی قرص رو هم روشن می‌کنیم'], ['other', 'روش هورمونی دیگه', 'آی‌یودی هورمونی، ایمپلنت، آمپول، حلقه یا چسب']];
    body = `<h1 class="qtitle">از روش پیشگیری <span class="serif">هورمونی</span> استفاده می‌کنی؟</h1><p class="qsub">روش‌های هورمونی الگوی چرخه رو تغییر می‌دن؛ برای همین تخمین فازها رو براشون نشون نمی‌دیم.</p>
      <div class="stack">${opts.map(([v, b, sm]) => `<button class="choice ${onb.hormonal === v ? 'on' : ''}" data-act="onb-contra" data-v="${v}"><div><b>${b}</b><small>${sm}</small></div><span class="radio"></span></button>`).join('')}</div>`;
  } else if (step === 'last') {
    canNext = !!(onb.picked || onb.unknown);
    body = `<h1 class="qtitle">آخرین پریودت کی <span class="serif">شروع شد؟</span></h1><p class="qsub">روز اولش رو روی تقویم انتخاب کن.</p>${datePickerCard(onb.picked, 'onb-pick')}
      ${onb.picked ? `<p class="center" style="color:var(--ink-2)">${Cal.weekdayDayMonth(fromKey(onb.picked))}، ${relDays(dayDiff(t, fromKey(onb.picked)))}</p>` : ''}
      <button class="choice ${onb.unknown ? 'on' : ''}" data-act="onb-unknown"><div><b>یادم نیست</b><small>بعداً از تقویم ثبتش می‌کنم</small></div><span class="radio"></span></button>`;
  } else if (step === 'cycle') body = `<h1 class="qtitle">چرخه‌ات معمولاً <span class="serif">چند روزه؟</span></h1><p class="qsub">از روز اول یه پریود تا روز اول پریود بعدی. اگه نمی‌دونی، ۲۸ رو نگه دار؛ از روی ثبت‌هات یاد می‌گیریم.</p>${numberPicker('cycle', onb.cycle, 18, 60)}`;
  else if (step === 'period') body = `<h1 class="qtitle">پریودت معمولاً <span class="serif">چند روز</span> طول می‌کشه؟</h1><p class="qsub">بیشتر آدم‌ها بین ۲ تا ۷ روز.</p>${numberPicker('period', onb.period, 1, 12)}`;
  else if (step === 'preg') { canNext = !!onb.picked; body = `<h1 class="qtitle">اولین روز <span class="serif">آخرین پریودت</span> کی بود؟</h1><p class="qsub">هفته‌ی بارداری از این تاریخ حساب می‌شه. تاریخ زایمانی که پزشکت گفته رو بعداً می‌تونی وارد کنی.</p>${datePickerCard(onb.picked, 'onb-pick')}`; }
  else if (step === 'interval') { canNext = !!onb.picked; body = `<h1 class="qtitle">بازه‌ی اول از <span class="serif">کی شروع بشه؟</span></h1><p class="qsub">مثلاً اول همین ماه یا روزی که دارو عوض شد.</p>${datePickerCard(onb.picked, 'onb-pick')}`; }
  else if (step === 'notify') {
    body = `<div class="center">${glyph('bell', '#E8A013', 'ic big')}</div><h1 class="qtitle center">یادت بندازیم؟</h1><p class="qsub center">قبل از پریود، روز پیش‌بینی‌شده و اگه تأخیر داشت، یه یادآوری کوچیک می‌فرستیم. هر وقت بخوای از منو خاموش یا محرمانه‌اش می‌کنی.</p>`;
    foot = `<button class="pill-btn red block" data-act="onb-notify-yes" ${busy ? 'disabled' : ''}>آره، یادم بنداز</button><button class="text-link" style="justify-content:center" data-act="onb-done">بعداً</button>`;
  }
  const last = s === steps.length - 1;
  const defaultFoot = `<button class="pill-btn red block" data-act="${last ? 'onb-done' : 'onb-next'}" ${canNext && !busy ? '' : 'disabled'}>${busy ? 'کمی صبر کن…' : last ? 'تموم شد' : 'ادامه'}</button>`;
  return `<div class="qscreen ${cls}">${top}
    <div class="qtop">${s > 0 ? `<button class="round-btn" data-act="onb-back" aria-label="قبلی">${ic('chevR')}</button>` : (CLOUD ? `<button class="text-link" style="color:var(--muted)" data-act="sign-out">خروج</button>` : '<span></span>')}${!top ? `<div class="qprogress"><i style="width:${((s + 1) / steps.length * 100).toFixed(0)}%"></i></div>` : ''}</div>
    <div class="qbody">${body}</div>
    <div class="qfoot">${foot === null ? defaultFoot : foot}</div></div>`;
}
function numberPicker(id, val, min, max) {
  return `<div class="number-picker"><button data-act="num" data-id="${id}" data-d="1" data-min="${min}" data-max="${max}" aria-label="بیشتر">+</button><div class="val" id="v-${id}" data-v="${val}"><b>${fa(val)}</b><span>روز</span></div><button data-act="num" data-id="${id}" data-d="-1" data-min="${min}" data-max="${max}" aria-label="کمتر">−</button></div>`;
}
async function joinWithCode() {
  const raw = ($('#o-code')?.value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = ($('#o-pname')?.value || '').trim();
  onb.code = raw; onb.pname = name; onb.codeError = '';
  if (raw.length < 6) { onb.codeError = 'کد کامل نیست.'; return render(); }
  if (!name) { onb.codeError = 'اسمت رو بنویس.'; return render(); }
  busy = true; render();
  try {
    const inv = await withTimeout(Cloud.getInvite(raw), 15000);
    if (!inv || inv.usedBy) { onb.codeError = 'این کد معتبر نیست یا قبلاً استفاده شده.'; busy = false; return render(); }
    if (inv.ownerUid === ME.uid) { onb.codeError = 'این کد مال حساب خودته.'; busy = false; return render(); }
    pendingInvite = { code: raw, data: inv }; holdAuth = true;
    await acceptInvite(name);
  } catch (e) { console.error('join code', e && e.code); holdAuth = false; onb.codeError = 'اتصال انجام نشد. دوباره امتحان کن.'; }
  busy = false; render();
}
async function finishOnboarding() {
  const name = onb.name.trim(); const t = todayDate(); const m = onb.mode;
  const profile = { ...DEFAULT_PROFILE, cycleLength: onb.cycle, periodLength: onb.period, birthYear: onb.birthYear || null, goals: onb.goals, hormonal: ['pill', 'other'].includes(onb.hormonal), pill: onb.hormonal === 'pill' };
  const logs = {}; let pregnancy = null; const intervals = [];
  if (['period', 'conceive', 'perimenopause'].includes(m) && onb.picked) {
    const s = fromKey(onb.picked); for (let i = 0; i < onb.period; i++) { const d = addDays(s, i); if (d <= t) logs[toKey(d)] = { period: 'medium', u: Date.now() }; }
  }
  if (m === 'pregnancy' && onb.picked) pregnancy = { ref: onb.picked, due: toKey(addDays(fromKey(onb.picked), 280)), start: toKey(t), end: null };
  if (m === 'noperiod' && onb.picked) intervals.push(onb.picked);
  const modeHistory = [{ mode: 'period', from: '1900-01-01' }]; if (m !== 'period') modeHistory.push({ mode: m, from: toKey(t) });
  const reminders = JSON.parse(JSON.stringify(DEFAULT_REMINDERS)); if (profile.pill) reminders.pill.on = true;
  const settings = { profile, modeHistory, pregnancy, pregHistory: [], intervals, tags: [], reminders };
  busy = true; onb.done = true; saveOnb(); render();
  try {
    if (CLOUD) {
      const { sid, done } = Cloud.setupOwner(ME.uid, name, settings, logs, { role: 'her', name, consent: { v: 1, at: Date.now() } });
      done.then(() => clearOnb()).catch(e => { console.error('setup sync', e && e.code); toast('ذخیره در سرور انجام نشد؛ دفعه‌ی بعد که اپ رو باز کنی دوباره امتحان می‌شه'); });
      ME.spaceId = sid; ME.role = 'her'; ME.name = name;
      S = { ...emptyState(), ...settings, herName: name, logs, onboarded: true }; startWatch();
      const synced = await Promise.race([done.then(() => true, () => true), sleep(5000).then(() => false)]);
      if (!synced) toast('اینترنت کنده؛ اطلاعاتت روی گوشی ذخیره شده و خودکار فرستاده می‌شه');
    } else { S = { ...emptyState(), ...settings, herName: name, logs, onboarded: true }; ME = { uid: 'local', role: 'her', spaceId: 'local', name, email: '' }; }
    saveCache(); screen = 'app'; route = 'cycle'; history.replaceState(null, '', '#cycle'); scheduleReminders();
    setTimeout(maybeInstallPrompt, 1500);
  } catch (e) { console.error('onboarding', e && e.code); holdAuth = false; toast(errMsg(e)); }
  busy = false; render();
}

// =================================================================
// App shell
// =================================================================
function appView() {
  const [r, arg] = route.split('/');
  const p = predict(engineState());
  const m = p.mode;
  let title = '', body = '';
  switch (r) {
    case 'calendar': title = 'تقویم'; body = viewCalendar(p); break;
    case 'insights': title = 'تحلیل'; body = isHer() ? viewInsights({ S, p, compare: compareSel }) : `<p class="muted">تحلیل‌ها خصوصی‌ان.</p>`; break;
    case 'report': title = 'گزارش برای پزشک'; body = isHer() ? reportView({ S, rep, logo: logo('sm') }) : ''; break;
    case 'us': title = 'ما دوتا'; body = viewUs(p); break;
    case 'more': title = 'منو'; body = viewMore(); break;
    case 'library': title = 'دانستنی‌ها'; body = viewLibrary(); break;
    case 'article': title = 'دانستنی‌ها'; body = viewArticle(arg); break;
    default: title = isHer() ? (m === 'pregnancy' ? 'بارداری' : m === 'noperiod' ? 'بازه‌ی فعلی' : 'چرخه‌ی فعلی تو') : `چرخه‌ی ${herN()}`; body = viewHome(p);
  }
  const back = { article: 'library', library: 'more', report: 'insights' }[r] || null;
  return `<header class="apphead no-print">${back ? `<button class="round-btn" data-act="go" data-r="${back}" aria-label="برگشت">${ic('chevR')}</button>` : '<span></span>'}<h1>${title}</h1><button class="round-btn" data-act="go" data-r="more" aria-label="منو">${ic('menu')}</button></header>
    <main class="page">${body}</main>${navBar(r)}`;
}
function navBar(cur) {
  const item = (r, icon, label) => `<button class="nav-item ${cur === r ? 'on' : ''}" data-act="go" data-r="${r}">${ic(icon)}<span>${label}</span></button>`;
  const center = isHer() ? `<button class="nav-center" data-act="log" aria-label="ثبت امروز"><span class="plus">${ic('plus')}</span><span>ثبت</span></button>`
    : `<button class="nav-center" data-act="compose" aria-label="یادداشت"><span class="plus">${ic('heart')}</span><span>یادداشت</span></button>`;
  return `<nav class="nav no-print"><div class="nav-inner">${item('cycle', 'cycle', 'چرخه')}${item('calendar', 'cal', 'تقویم')}${center}${isHer() ? item('insights', 'insights', 'تحلیل') : item('more', 'menu', 'منو')}${item('us', 'us', 'ما دوتا')}</div></nav>`;
}

// =================================================================
// Home (mode-aware)
// =================================================================
function dayStatus(p, d) {
  const k = toKey(d); const log = S.logs[k]; const info = p.dayMap.get(k) || {};
  if (log && BLEED.includes(log.period) && ['period', 'conceive', 'perimenopause'].includes(modeAt(engineState(), k))) return 'P';
  if (info.predPeriod && d >= p.today) return 'Q';
  if (info.ovulation) return 'O';
  if (info.fertile) return 'F';
  if (info.pms) return 'M';
  return '';
}
function wheelSVG(p) {
  const N = Math.min(Math.max(p.predLen, p.cycleDay + (p.lateDays > 0 ? 1 : 0)), 75);
  const R = 134, W = 25, step = 360 / N;
  const rad = a => a * Math.PI / 180; const pt = (deg, r) => [(r * Math.cos(rad(deg))).toFixed(2), (r * Math.sin(rad(deg))).toFixed(2)];
  const capDeg = (W / 2) / R * 180 / Math.PI;
  const arc = (i0, i1, color) => {
    const pad = Math.min(capDeg, step * 0.5); const a0 = -90 + i0 * step + pad; let a1 = -90 + (i1 + 1) * step - pad; if (a1 <= a0) a1 = a0 + 0.01;
    const [x0, y0] = pt(a0, R), [x1, y1] = pt(a1, R);
    return `<path d="M${x0} ${y0} A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}" stroke="${color}" stroke-width="${W}" stroke-linecap="round" fill="none"/>`;
  };
  const COLORS = { P: 'var(--period)', Q: 'var(--period-pred)', F: 'var(--teal)', M: '#C9AEE6' };
  const st = []; for (let i = 0; i < N; i++) { const s = dayStatus(p, addDays(p.lastStart, i)); st.push(s === 'O' ? 'F' : s); }
  let arcs = '';
  for (let i = 0; i < N;) { let j = i; while (j + 1 < N && st[j + 1] === st[i]) j++; if (st[i]) arcs += arc(i, j, COLORS[st[i]]); i = j + 1; }
  let marks = '';
  for (let i = 0; i < N; i++) if (dayStatus(p, addDays(p.lastStart, i)) === 'O') { const [x, y] = pt(-90 + (i + 0.5) * step, R); marks += `<circle cx="${x}" cy="${y}" r="10" fill="var(--egg)"/><circle cx="${x}" cy="${y}" r="3" fill="var(--teal)"/>`; }
  const rIn = R - W / 2 - 13;
  for (let i = 0; i < N; i++) {
    const log = S.logs[toKey(addDays(p.lastStart, i))]; const [x, y] = pt(-90 + (i + 0.5) * step, rIn);
    if (i === 0) { marks += `<path transform="translate(${x} ${y}) scale(.62) translate(-12 -12)" d="M12 3.2c3.2 4.2 6.2 7.4 6.2 10.9a6.2 6.2 0 0 1-12.4 0C5.8 10.6 8.8 7.4 12 3.2z" fill="var(--period)"/>`; continue; }
    const cat = log && log.tags && Object.keys(log.tags)[0];
    marks += cat && CAT_BY_ID[cat] ? `<circle cx="${x}" cy="${y}" r="3.4" fill="${CAT_BY_ID[cat].color}"/>` : `<circle cx="${x}" cy="${y}" r="1.7" fill="var(--dot)"/>`;
  }
  // selected-day marker (today by default); dragged around the ring
  const todayIdx = Math.min(N - 1, p.cycleDay - 1);
  let sel = WH.selKey ? dayDiff(p.lastStart, fromKey(WH.selKey)) : todayIdx;
  if (!(sel >= 0 && sel < N)) { sel = todayIdx; WH.selKey = null; }
  Object.assign(WH, { N, step, R, p, todayIdx, sel });
  const [mx, my] = pt(-90 + (sel + 0.5) * step, R);
  const hint = WH.showHint ? wheelHintArt(todayIdx, step, R, N) : '';
  const mark = `<g id="wmark" class="wmark" transform="translate(${mx} ${my})"><g class="tmark"><circle r="24" fill="var(--surface)"/></g><circle class="wm-ring" r="27" fill="none" stroke="var(--teal)" stroke-width="2" opacity="${sel === todayIdx ? 0 : 1}"/><text y="-5" text-anchor="middle" font-size="9.5" fill="var(--muted)" font-family="Vazirmatn">روز</text><text id="wm-day" y="12" text-anchor="middle" font-size="17" font-weight="600" fill="var(--ink)" font-family="Vazirmatn">${fa(sel + 1)}</text></g>`;
  return `<svg viewBox="-170 -170 340 340" role="img" aria-label="دایره‌ی چرخه؛ برای دیدن روزهای دیگه بکش" data-drag="1"><circle r="${R}" fill="none" stroke="var(--track)" stroke-width="${W}"/>${arcs}${marks}${hint}${mark}</svg>`;
}
// ---- wheel interaction state ----
const WH = { selKey: null, showHint: false };
function wheelHintArt(todayIdx, step, R, N) {
  const a0 = -90 + (todayIdx + 0.5) * step, a1 = a0 + Math.min(70, step * 6);
  const P = a => [(R * Math.cos(a * Math.PI / 180)).toFixed(1), (R * Math.sin(a * Math.PI / 180)).toFixed(1)];
  const [x0, y0] = P(a0), [x1, y1] = P(a1);
  const path = `M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} A${R} ${R} 0 0 0 ${x0} ${y0}`;
  return `<g class="wheel-hint-art" pointer-events="none"><path d="M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1}" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="2 7" stroke-linecap="round" opacity=".8"/>
    <g><circle r="25" fill="none" stroke="#fff" stroke-width="2.5" opacity=".9"/><path d="M-4 6 V-10 a4 4 0 0 1 8 0 V2 l7 2 a4 4 0 0 1 3 4 l-1 12 h-17 l-6-9 a3 3 0 0 1 5-3z" transform="translate(6 18) scale(.9)" fill="#fff" stroke="#2B2A28" stroke-width="1.2"/>
      <animateMotion dur="2.6s" repeatCount="indefinite" path="${path}" keyPoints="0;1;0" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"/></g></g>`;
}
let hapticLabel = null;
function haptic() {
  try { if (navigator.vibrate && navigator.vibrate(7)) return; } catch (e) {}
  // iOS 18+: tapping a hidden native switch gives the system "tick" haptic in Safari
  try {
    if (!hapticLabel) {
      hapticLabel = document.createElement('label'); hapticLabel.setAttribute('aria-hidden', 'true');
      hapticLabel.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); i.tabIndex = -1;
      hapticLabel.appendChild(i); document.body.appendChild(hapticLabel);
    }
    hapticLabel.click();
  } catch (e) {}
}
function wheelCenterFor(p, d) {
  const t = p.today; const k = toKey(d); const you = isHer();
  if (sameDay(d, t)) return null; // today's center is built by cycleHome
  const log = S.logs[k]; const info = p.dayMap.get(k) || {};
  const idx = dayDiff(p.lastStart, d);
  let big, sub = '';
  if (log && BLEED.includes(log.period)) big = 'پریود <small>(ثبت‌شده)</small>';
  else if (info.predPeriod && d > t) big = 'پریود احتمالی';
  else if (info.ovulation) big = 'تخمک‌گذاری <small>(تخمینی)</small>';
  else if (info.fertile) big = 'روزهای باروری <small>(تخمینی)</small>';
  else if (info.pms && d > t) big = 'PMS احتمالی';
  else big = `روز <span class="num">${fa(idx + 1)}</span> چرخه`;
  if (d > t && p.nextStart && !info.predPeriod) { const n = dayDiff(d, p.nextStart); if (n > 0) sub = `${fa(n)} روز مونده به پریود`; }
  if (d < t && you) { const n = logChips(log).length; sub = n ? `${fa(n)} مورد ثبت شده` : 'چیزی ثبت نشده'; }
  const ph = d > t ? phaseOn(engineState(), p, d) : pastPhase(engineState(), p, k);
  return `<div class="today"><b>${Cal.weekdayDayMonth(d)}</b></div><div class="muted" style="font-size:13px">${relDays(dayDiff(t, d))}${ph && PHASES[ph] ? '، ' + PHASES[ph].name : ''}</div>
    <div class="big">${big}</div>${sub ? `<div class="muted" style="font-size:14px">${sub}</div>` : ''}
    <div class="wc-actions">${you && d <= t ? `<button class="text-link" data-act="open-log" data-k="${k}">ثبت برای این روز</button>` : ''}<button class="text-link" data-act="wheel-today">برگشت به امروز</button></div>`;
}
function wheelSelect(idx, fromDrag) {
  if (idx === WH.sel) return;
  WH.sel = idx; const p = WH.p;
  const a = (-90 + (idx + 0.5) * WH.step) * Math.PI / 180;
  const mk = document.getElementById('wmark'); if (!mk) return;
  mk.setAttribute('transform', `translate(${(WH.R * Math.cos(a)).toFixed(2)} ${(WH.R * Math.sin(a)).toFixed(2)})`);
  document.getElementById('wm-day').textContent = fa(idx + 1);
  mk.querySelector('.wm-ring').setAttribute('opacity', idx === WH.todayIdx ? 0 : 1);
  const d = addDays(p.lastStart, idx);
  WH.selKey = idx === WH.todayIdx ? null : toKey(d);
  const c = document.getElementById('wcenter');
  if (c) c.innerHTML = wheelCenterFor(p, d) || WH.todayCenter;
  if (fromDrag) haptic();
}
let wheelDrag = null;
function wheelPoint(e) {
  const r = wheelDrag.svg.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  let ang = Math.atan2(dy, dx) * 180 / Math.PI + 90; if (ang < 0) ang += 360;
  return Math.min(WH.N - 1, Math.floor(ang / WH.step));
}
document.addEventListener('pointerdown', e => {
  const svg = e.target.closest && e.target.closest('.wheel svg[data-drag]'); if (!svg || !WH.p) return;
  const r = svg.getBoundingClientRect(); const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / (r.width / 340);
  if (dist < WH.R - 45 || dist > WH.R + 45) return; // only the ring itself starts a drag
  wheelDrag = { svg, id: e.pointerId }; try { svg.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
  if (WH.showHint) { WH.showHint = false; P.wheelHintSeen = true; savePrefs(); svg.querySelector('.wheel-hint-art')?.remove(); document.querySelector('.wheel-hint-pill')?.remove(); }
  wheelSelect(wheelPoint(e), true);
});
document.addEventListener('pointermove', e => { if (wheelDrag && e.pointerId === wheelDrag.id) { e.preventDefault(); wheelSelect(wheelPoint(e), true); } }, { passive: false });
const endDrag = e => { if (wheelDrag && e.pointerId === wheelDrag.id) wheelDrag = null; };
document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
function emptyWheel() { let d = ''; for (let i = 0; i < 28; i++) { const a = (-90 + (i + .5) * 360 / 28) * Math.PI / 180; d += `<circle cx="${(108 * Math.cos(a)).toFixed(1)}" cy="${(108 * Math.sin(a)).toFixed(1)}" r="1.7" fill="var(--dot)"/>`; } return `<svg viewBox="-170 -170 340 340"><circle r="134" fill="none" stroke="var(--track)" stroke-width="25"/>${d}</svg>`; }

function phaseSentence(p) {
  const you = isHer(); const her = herN();
  if (!p.hasData) return you ? 'اولین پریودت رو ثبت کن تا شروع کنیم' : `هنوز اولین پریود ${her} ثبت نشده`;
  if (p.phase === 'late') return you ? `پریودت ${fa(p.lateDays)} روز از تخمین عقب‌تره` : `پریود ${her} ${fa(p.lateDays)} روز از تخمین عقب‌تره`;
  const sp = p.subphase && SUBPHASES[p.subphase];
  if (sp) return you ? `احتمالاً در <b>${sp.name}</b> هستی` : `${her} احتمالاً در <b>${sp.name}</b> است`;
  const names = { period: 'پریود', follicular: 'فاز فولیکولار', fertile: 'روزهای باروری', ovulation: 'حوالی تخمک‌گذاری', luteal: 'فاز لوتئال', pms: 'روزهای PMS' };
  return you ? `احتمالاً در <b>${names[p.phase]}</b> هستی` : `${her} احتمالاً در <b>${names[p.phase]}</b> است`;
}
function confidenceNote(p) {
  if (!p.hasData) return '';
  if (p.confidence === 'irregular' && p.nextRange) return `<div class="card peach" style="margin-top:10px"><div class="card-label">چرخه‌ها نامنظم‌ان</div><p style="font-size:14.5px;color:var(--ink-2)">پریود بعدی احتمالاً بین <b>${Cal.dayMonth(p.nextRange[0])}</b> و <b>${Cal.dayMonth(p.nextRange[1])}</b> شروع می‌شه. چون فاصله‌ی کوتاه‌ترین و بلندترین چرخه‌های اخیر ${fa(p.variation)} روزه، یه تاریخ دقیق گمراه‌کننده‌ست.</p></div>`;
  if (p.confidence === 'insufficient') return `<p class="data-meta">پیش‌بینی فعلاً از تنظیمات اولیه ساخته شده (${fa(p.predLen)} روز). با ثبت چند چرخه، از الگوی خودت ساخته می‌شه.</p>`;
  if (p.confidence === 'low') return `<p class="data-meta">بر اساس ${fa(p.included.length)} چرخه‌ی کامل. با چرخه‌های بیشتر، پیش‌بینی بهتر می‌شه.</p>`;
  return `<p class="data-meta">بر اساس ${fa(Math.min(12, p.included.length))} چرخه‌ی اخیر (میانگین ${fa(p.predLen)} روز).</p>`;
}
function viewHome(p) {
  const m = p.mode; const you = isHer();
  if (!you && S.shared && S.shared.paused) return requestsBanner() + `<div class="card peach center" style="margin-top:20px">${face(3, 52)}<h3 style="margin-top:10px">اشتراک‌گذاری موقتاً متوقفه</h3><p style="color:var(--ink-2);margin-top:6px">${herN()} الان از حالتی استفاده می‌کنه که اطلاعات چرخه در اون به اشتراک گذاشته نمی‌شه.</p></div>${statusCard()}`;
  if (!you && !S.shared) return requestsBanner() + `<div class="card center" style="margin-top:20px"><p style="color:var(--ink-2)">هنوز اطلاعاتی از ${herN()} نرسیده. وقتی اپ رو باز کنه، اینجا به‌روز می‌شه.</p></div>${statusCard()}`;
  const banner = you ? '' : requestsBanner();
  if (m === 'pregnancy') return banner + pregnancyHome(p);
  if (m === 'noperiod') return banner + noPeriodHome(p);
  return banner + cycleHome(p);
}
function modePill() { const m = mode(); return isHer() ? `<button class="mode-pill" data-act="mode-sheet">حالت: <b>${MODES[m].name}</b> ${ic('chevD')}</button>` : ''; }
function cycleHome(p) {
  const t = p.today; const log = S.logs[toKey(t)]; const you = isHer();
  const ph = PHASES[p.phase || 'unknown'] || PHASES.unknown;
  let center;
  if (!p.hasData) center = `<div class="today"><b>امروز</b>، ${Cal.dayMonth(t)}</div><div class="big">${you ? 'اولین روز پریودت رو ثبت کن' : 'منتظر اولین ثبت'}</div>${you ? `<button class="text-link" data-act="go" data-r="calendar">ثبت در تقویم ${ic('chevL')}</button>` : ''}`;
  else {
    let big;
    if (p.inPeriod) big = `روز <span class="num">${fa(p.cycleDay)}</span> پریود`;
    else if (p.lateDays > 0) big = `<span class="num">${fa(p.lateDays)}</span> روز تأخیر`;
    else if (p.confidence === 'irregular' && p.nextRange) big = `پریود بعدی بین ${Cal.dayMonth(p.nextRange[0])} و ${Cal.dayMonth(p.nextRange[1])}`;
    else if (p.daysToNext === 0) big = 'احتمالاً پریود امروز شروع می‌شه';
    else big = `<span class="num">${fa(p.daysToNext)}</span> روز تا پریود بعدی`;
    center = `<div class="today"><b>امروز</b>، ${Cal.dayMonth(t)}</div><div class="big">${big}</div><button class="text-link" data-act="phase-sheet">درباره‌ی این فاز ${ic('chevD')}</button>`;
  }
  if (p.hasData && isHer() && !P.wheelHintSeen && !WH.showHint && !WH.hintShown) { WH.showHint = true; WH.hintShown = true; }
  WH.todayCenter = center;
  const wheelHtml = p.hasData ? wheelSVG(p) : emptyWheel();
  const selCenter = p.hasData && WH.selKey ? wheelCenterFor(p, fromKey(WH.selKey)) : null;
  let html = `<section class="cycle-hero">${modePill()}<div class="wheel">${wheelHtml}<div class="wheel-center" id="wcenter">${selCenter || center}</div></div>
    ${WH.showHint ? `<div class="wheel-hint-pill"><span>دایره رو بکش تا روزهای قبل و بعد رو ببینی</span><button class="text-link" data-act="wheel-hint-ok">فهمیدم</button></div>` : ''}${feelCard(log)}</section>`;
  if (you && !(log && BLEED.includes(log.period))) html += `<button class="pill-btn blush block" data-act="quick-period">${p.inPeriod ? 'امروز هم پریودم' : 'پریودم امروز شروع شد'}</button>`;
  html += `<div><h2 class="sec-title">${phaseSentence(p)}</h2>${confidenceNote(p)}</div>`;
  html += pushCardHtml(false);
  html += phaseInsightCard(p);
  if (p.mode === 'conceive') html += conceiveCard(p);
  if (you && S.profile.pill) {
    const took = log && (log.tags?.meds || []).includes('pill');
    html += `<button class="card check ${took ? 'on' : ''}" style="border:0;padding:18px 20px" data-act="pill"><span class="box">${took ? ic('check') : ''}</span><span class="lbl" style="flex:1;font-weight:500">قرص امروز</span>${glyph('pill', '#3B6FD8', 'ic')}</button>`;
  }
  if (p.hasData) html += predictionsCard(p);
  if (you && p.hasData) html += anticipationCard(p);
  if (p.mode === 'perimenopause' && you) html += `<div class="card peach"><div class="card-label">پیش‌یائسگی</div><p style="font-size:14.5px;color:var(--ink-2)">گرگرفتگی، تعریق شبانه، خواب و خلق رو ثبت کن تا کنار تغییرات چرخه در تحلیل‌ها و گزارش پزشک ببینی. این اپ یائسگی رو تشخیص نمی‌ده.</p><button class="text-link" data-act="log" style="margin-top:8px">ثبت امروز ${ic('chevL')}</button></div>`;
  html += `<div class="card ${ph.card}"><div class="card-label">${you ? 'مراقبت از خودت' : `چطور کنار ${herN()} باشی`} ${draftBadge()}</div><ul class="bullets">${(you ? ph.her : ph.him).map(x => `<li>${x}</li>`).join('')}</ul>
    ${!you && ph.avoid.length ? `<div class="card-label" style="margin-top:16px">بهتره نه</div><ul class="bullets x">${ph.avoid.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}</div>`;
  if (!you) html += statusCard();
  if (!you && p.hasData && (p.phase === 'pms' || p.phase === 'late' || p.daysToNext <= 5)) {
    const done = Object.values(S.kit.items || {}).filter(Boolean).length;
    html += `<button class="card list-row" style="padding:18px 20px;border:0" data-act="go" data-r="us">${glyph('heart', '#E13336')}<div class="main"><b>کیت مراقبت رو آماده کن</b><small>${fa(done)} از ${fa(CARE_KIT.length)} آماده‌ست</small></div><span class="chev">${ic('chevL')}</span></button>`;
  }
  if (you) html += todayLogCard(log);
  html += postpartumCard();
  html += `<p class="fine">پیش‌بینی‌ها تخمینی‌اند، از ثبت‌های خودت محاسبه می‌شن و جایگزین مشاوره‌ی پزشکی یا روش پیشگیری از بارداری نیستند.</p>`;
  return html;
}
function phaseInsightCard(p) {
  if (!p.hasData) return '';
  const sp = p.subphase && SUBPHASES[p.subphase];
  if (!sp) {
    const why = S.profile.hormonal ? 'چون روش پیشگیری هورمونی در تنظیماتت فعاله' : p.predLen < 20 ? 'چون چرخه‌ی پیش‌بینی‌شده کوتاه‌تر از ۲۰ روزه' : p.mode === 'perimenopause' ? 'در حالت پیش‌یائسگی' : p.lateDays > 0 ? 'وقتی پریود از تخمین عقب‌تره' : '';
    return why ? `<p class="data-meta">تخمین زیرفازها ${why} نمایش داده نمی‌شه.</p>` : '';
  }
  return `<div class="card sky"><div class="card-label">${sp.name} <span>تخمینی، نه اندازه‌گیری هورمون</span></div>${hormoneChart(p.subphase, true)}${hormoneLegend(p.subphase)}
    <p style="font-size:15px;color:var(--ink-2)"><b style="font-weight:500;color:var(--ink)">هورمون‌ها معمولاً: </b>${sp.hormones}</p>
    <p style="font-size:15px;color:var(--ink-2);margin-top:6px"><b style="font-weight:500;color:var(--ink)">ممکنه: </b>${sp.may}</p>
    ${isHer() ? `<p style="font-size:14px;color:var(--ink-2);margin-top:8px">پیشنهاد برای ثبت: ${sp.track.join('، ')}</p>` : ''}
    <div style="margin-top:8px">${draftBadge()}</div></div>`;
}
function conceiveCard(p) {
  const c = p.future.find(x => x.ov && x.fertileEnd >= p.today); if (!c) return '';
  const inMore = p.today >= c.moreFertileStart && p.today <= c.ov; const inFert = p.today >= c.fertileStart && p.today <= c.fertileEnd;
  const src = { test: 'تست تخمک‌گذاری', bbt: 'دمای پایه', shared: 'داده‌ی ثبت‌شده' }[c.ovSource];
  return `<div class="card teal"><div class="card-label">اقدام به بارداری ${draftBadge()}</div>
    <div class="list-row">${glyph('egg', '#0C7A92')}<div class="main"><b>روزهای پربارورتر</b><small>${Cal.dayMonth(c.moreFertileStart)} تا ${Cal.dayMonth(c.ov)}${src ? ` (بر اساس ${src})` : ''}</small></div><span class="end">${inMore ? 'الان' : relDays(dayDiff(p.today, c.moreFertileStart))}</span></div>
    <div class="list-row">${glyph('egg', '#0E8FA8')}<div class="main"><b>پنجره‌ی باروری</b><small>${Cal.dayMonth(c.fertileStart)} تا ${Cal.dayMonth(c.fertileEnd)}</small></div><span class="end">${inFert ? 'الان' : relDays(dayDiff(p.today, c.fertileStart))}</span></div>
    <ul class="bullets" style="margin-top:10px"><li>در پنجره‌ی باروری، رابطه یا تلقیح خانگی هر یک تا دو روز یک‌بار پوشش خوبی می‌ده.</li><li>تست تخمک‌گذاری و دمای پایه اختیاری‌ان و اگه ثبت بشن، تخمین همین چرخه رو دقیق‌تر می‌کنن.</li></ul>
    <p class="data-meta">این تخمین تضمین بارداری نیست و ناباروری رو تشخیص نمی‌ده.</p>
    <button class="text-link" data-act="go" data-r="article/conceive">بیشتر بخون ${ic('chevL')}</button></div>`;
}
function predictionsCard(p) {
  const c = p.cur; const t = p.today; const rows = [];
  const nextWhen = p.lateDays > 0 ? `قرار بود ${Cal.dayMonth(p.expectedStart)} شروع بشه` : p.nextRange && p.confidence === 'irregular' ? `بین ${Cal.dayMonth(p.nextRange[0])} و ${Cal.dayMonth(p.nextRange[1])}` : Cal.weekdayDayMonth(p.nextStart);
  rows.push(['drop', '#E13336', p.lateDays > 0 ? 'پریود (با تأخیر)' : 'پریود بعدی', nextWhen, p.lateDays > 0 ? `${fa(p.lateDays)} روز` : relDays(p.daysToNext)]);
  rows.push(['drop', '#F59A95', 'مدت تقریبی خونریزی', `حدود ${fa(p.avgPeriod)} روز`, '']);
  const dP = dayDiff(t, c.pmsStart); if (dP > 0) rows.push(['sparkle', '#9A6CC6', 'شروع احتمالی PMS', Cal.weekdayDayMonth(c.pmsStart), relDays(dP)]);
  const fc = c.ov && dayDiff(t, c.fertileEnd) >= 0 ? c : p.future[1];
  if (fc && fc.ov && p.mode !== 'perimenopause') {
    const dF = dayDiff(t, fc.fertileStart);
    rows.push(['egg', '#0C7A92', 'روزهای باروری', `${Cal.dayMonth(fc.fertileStart)} تا ${Cal.dayMonth(fc.fertileEnd)}`, dF > 0 ? relDays(dF) : 'الان']);
    const dO = dayDiff(t, fc.ov); if (dO >= 0) rows.push(['cycle', '#0E8FA8', fc.ovSource === 'estimate' ? 'تخمک‌گذاری (تخمینی)' : 'تخمک‌گذاری (از داده‌ی ثبت‌شده)', Cal.weekdayDayMonth(fc.ov), relDays(dO)]);
  }
  return `<div class="card"><div class="card-label">پیش‌بینی‌ها <span>${p.future.length > 1 ? `${fa(p.future.length)} چرخه در تقویم` : ''}</span></div>${rows.map(r => `<div class="list-row">${glyph(r[0], r[1])}<div class="main"><b>${r[2]}</b><small>${r[3]}</small></div><span class="end">${r[4]}</span></div>`).join('')}</div>`;
}
function anticipationCard(p) {
  const t = p.today; const ant = []; const seen = new Set();
  for (let i = 0; i <= 3 && ant.length < 5; i++) for (const a of anticipate(engineState(), p, addDays(t, i))) if (!seen.has(a.id)) { seen.add(a.id); a.when = i; ant.push(a); }
  const pains = painPredictions(engineState(), p).filter(x => x.status === 'ok' && dayDiff(t, x.to) >= 0 && dayDiff(t, x.from) <= 10 && !seen.has(x.id));
  if (!ant.length && !pains.length) return p.cycles.length < 2 ? `<div class="card"><div class="card-label">پیش‌بینی علائم</div><p style="color:var(--ink-2);font-size:15px">با ثبت علائم در دو چرخه، Moon&Us بهت می‌گه چه علائمی معمولاً همین موقع برات پیش میان.</p></div>` : '';
  return `<div class="card plum"><div class="card-label">ممکنه این روزها تجربه کنی</div>
    ${ant.map(a => `<div class="list-row"><span class="dot" style="background:${a.color}"></span><div class="main"><b>${esc(a.label)}</b><small>در ${fa(a.count)} از ${fa(a.of)} چرخه‌ی اخیر همین موقع ثبت شده</small></div><span class="end">${relDays(a.when)}</span></div>`).join('')}
    ${pains.map(x => `<div class="list-row"><span class="dot" style="background:${x.color}"></span><div class="main"><b>${esc(x.label)}</b><small>بر اساس ${fa(x.cyclesUsed)} چرخه‌ی اخیر</small></div><span class="end">${Cal.dayMonth(x.from)}</span></div>`).join('')}</div>`;
}
function todayLogCard(log) {
  const chips = logChips(log);
  return `<div class="card white"><div class="card-label">ثبت‌های امروز <button class="text-link" data-act="log">${chips.length ? 'ویرایش' : 'افزودن'}</button></div>
    ${chips.length ? `<div class="chips">${chips.map(c => `<span class="chip static on" style="--c:${c[0]}">${esc(c[1])}</span>`).join('')}</div>` : `<p class="muted" style="font-size:14.5px">هنوز چیزی ثبت نشده. ثبت روزانه، تحلیل‌ها و پیش‌بینی‌ها رو دقیق‌تر می‌کنه.</p>`}</div>`;
}
function pregnancyHome(p) {
  const pi = p.pregnancy; const t = p.today;
  if (!pi) return `${modePill()}<div class="card"><p>تاریخ مرجع بارداری ثبت نشده.</p><button class="pill-btn red block" data-act="preg-setup" style="margin-top:12px">ثبت تاریخ</button></div>`;
  const tri = PREG_TRIMESTERS[pi.trimester]; const log = S.logs[toKey(t)];
  return `<section class="cycle-hero">${modePill()}<div class="preg-hero"><div class="today"><b>امروز</b>، ${Cal.dayMonth(t)}</div>
      <div class="preg-week"><span class="num">${fa(pi.week)}</span> هفته و ${fa(pi.day)} روز</div><div class="muted">${tri.name}</div>
      <div class="preg-bar"><i style="width:${Math.min(100, pi.days / 280 * 100).toFixed(1)}%"></i></div>
      <div class="muted" style="font-size:14px">تاریخ تخمینی زایمان: <b style="color:var(--ink)">${Cal.full(pi.due)}</b> (${pi.daysToDue >= 0 ? relDays(pi.daysToDue) : `${fa(-pi.daysToDue)} روز گذشته`})</div>
      <button class="text-link" data-act="preg-edit">تغییر تاریخ زایمان ${ic('chevL')}</button></div>${feelCard(log)}</section>
    <div class="card peach"><div class="card-label">${tri.name} ${draftBadge()}</div><p style="font-size:15px;color:var(--ink-2)">${tri.info}</p>
      <p class="data-meta">اطلاعات آموزشی عمومیه و اندازه‌گیری وضعیت جنین تو نیست. محتوای هفته‌به‌هفته بعد از بازبینی پزشکی اضافه می‌شه.</p></div>
    <div class="card white"><div class="card-label">حرکات جنین امروز</div><div class="chips">${CAT_BY_ID.fetal.items.map(([v, l]) => `<button class="chip ${(log && (log.tags?.fetal || []).includes(v)) ? 'on' : ''}" style="--c:${CAT_BY_ID.fetal.color}" data-act="tag" data-k="${toKey(t)}" data-c="fetal" data-v="${v}" data-inline="1">${l}</button>`).join('')}</div>
      <p class="data-meta">${CAT_HELP.fetal.doctor}</p></div>
    ${todayLogCard(log)}
    <div class="card"><div class="card-label">اشتراک‌گذاری و یادآورها</div><p style="font-size:14.5px;color:var(--ink-2)">در حالت بارداری، اشتراک چرخه با پارتنر متوقف می‌شه و یادآورهای پریود و باروری ارسال نمی‌شن.</p></div>
    <button class="pill-btn ghost block" data-act="preg-end">پایان پیگیری بارداری</button>
    <p class="fine">برای هر نگرانی در بارداری با تیم درمانت تماس بگیر.</p>`;
}
function noPeriodHome(p) {
  const info = p.interval; const t = p.today; const log = S.logs[toKey(t)];
  return `<section class="cycle-hero">${modePill()}<div class="preg-hero"><div class="today"><b>امروز</b>، ${Cal.dayMonth(t)}</div>
      ${info.current ? `<div class="preg-week">روز <span class="num">${fa(info.day)}</span> این بازه</div><div class="muted">شروع: ${Cal.full(fromKey(info.current.start))}</div>` : `<div class="preg-week">هنوز بازه‌ای شروع نشده</div>`}
      <button class="pill-btn blush" style="margin-top:12px" data-act="interval-new">شروع بازه‌ی جدید</button></div>${feelCard(log)}</section>
    <p class="data-meta">در این حالت پیش‌بینی پریود، تخمک‌گذاری یا باروری انجام نمی‌شه. شروع بازه پریود حساب نمی‌شه.</p>
    ${todayLogCard(log)}
    <a class="card list-row" style="padding:18px 20px" href="#insights">${glyph('chart', '#7B5CD6')}<div class="main"><b>مقایسه‌ی بازه‌ها</b><small>${fa(info.intervals.length)} بازه</small></div><span class="chev">${ic('chevL')}</span></a>
    <button class="text-link" data-act="go" data-r="article/noperiod">درباره‌ی پیگیری بدون پریود ${ic('chevL')}</button>`;
}
function postpartumCard() {
  const last = (S.pregHistory || []).slice(-1)[0];
  if (!last || last.outcome !== 'birth' || !last.end) return '';
  const d = dayDiff(fromKey(last.end), todayDate()); if (d < 0 || d > POSTPARTUM_WEEKS * 7) return '';
  return `<div class="card peach"><div class="card-label">هفته‌ی ${fa(Math.floor(d / 7) + 1)} بعد از زایمان ${draftBadge()}</div><p style="font-size:15px;color:var(--ink-2)">${POSTPARTUM_INFO}</p></div>`;
}
function feelCard(log) {
  if (isHer()) {
    const chips = logChips(log).filter(c => c[2] !== 'period');
    return `<button class="feel-card" data-act="log"><span class="ic">${face(3, 40)}</span><span class="t">امروز چه حسی داری؟${chips.length ? `<small>${chips.slice(0, 3).map(c => esc(c[1])).join('، ')}</small>` : ''}</span><span class="chev">${ic('chevL')}</span></button>`;
  }
  const st = todayStatus();
  if (!st) return `<button class="feel-card" data-act="go" data-r="us"><span class="ic">${face(2, 40)}</span><span class="t">${herN()} هنوز حال امروزش رو نگفته<small>یه یادداشت بفرست و حالش رو بپرس</small></span><span class="chev">${ic('chevL')}</span></button>`;
  const needs = (st.needs || []).map(n => (NEEDS.find(x => x[0] === n) || [])[1]).filter(Boolean);
  return `<button class="feel-card" data-act="go" data-r="us"><span class="ic">${face(st.mood != null ? st.mood : 2, 40)}</span><span class="t">حال امروز ${herN()}: ${st.mood != null ? MOODS[st.mood] : '–'}<small>${needs.length ? 'لازم داره: ' + needs.slice(0, 3).join('، ') : (st.text ? '«' + esc(st.text) + '»' : '')}</small></span><span class="chev">${ic('chevL')}</span></button>`;
}
function todayStatus() { const st = S.status; return st && st.date === toKey(todayDate()) ? st : null; }
function logChips(log) {
  if (logIsEmpty(log)) return [];
  const out = [];
  if (log.period) { const it = CAT_BY_ID.period.items.find(i => i[0] === log.period); out.push([CAT_BY_ID.period.color, 'خونریزی ' + (it ? it[1] : ''), 'period']); }
  for (const [cat, arr] of Object.entries(log.tags || {})) { const C = CAT_BY_ID[cat]; if (!C) continue; for (const v of arr) { const it = C.items.find(i => i[0] === v); if (it) out.push([C.color, it[1], cat]); } }
  if (log.painLevel) out.push(['#F26B1D', 'شدت درد: ' + PAIN_LEVELS.find(x => x[0] === log.painLevel)[1], 'pain']);
  for (const id of log.custom || []) { const tg = (S.tags || []).find(x => x.id === id); if (tg) out.push(['#5A6B7B', '#' + tg.name, 'custom']); }
  if (log.temp != null) out.push(['#5A6B7B', `دمای پایه ${fa(log.temp)}°`, 'temp']);
  if (log.weight != null) out.push(['#9A6CC6', `وزن ${fa(log.weight)}`, 'weight']);
  if (log.note) out.push(['#8D8781', 'یادداشت', 'note']);
  return out;
}

// =================================================================
// Calendar (with up to three filters and selected-day details)
// =================================================================
function monthGrid(anchor, cellFn) {
  const days = Cal.monthDays(anchor);
  let cells = Cal.WEEKDAYS.map(w => `<div class="cal-wd">${w}</div>`).join('');
  for (let i = 0; i < Cal.weekIndex(days[0]); i++) cells += `<div class="cal-day empty"></div>`;
  for (const d of days) cells += cellFn(d);
  return `<div class="cal-head"><button class="round-btn flat" data-act="cal-prev" aria-label="ماه قبل">${ic('chevR')}</button><h3>${Cal.monthName(days[0])} <span>${Cal.year(days[0])}</span></h3><button class="round-btn flat" data-act="cal-next" aria-label="ماه بعد">${ic('chevL')}</button></div><div class="cal-grid">${cells}</div>`;
}
const FILTER_COLORS = ['#E13336', '#0C7A92', '#E8A013'];
function calCell(p, d) {
  const k = toKey(d); const log = S.logs[k];
  const s = p.hasData ? dayStatus(p, d) : (log && BLEED.includes(log.period) ? 'P' : '');
  const cls = ['cal-day', { P: 'period', Q: 'pred', O: 'ovulation', F: 'fertile', M: 'pms' }[s] || ''];
  if (log && log.period === 'spotting') cls.push('spotting');
  if (sameDay(d, p.today)) cls.push('today');
  if (k === calSel) cls.push('sel');
  if ((S.intervals || []).includes(k)) cls.push('ivstart');
  let dots = '';
  if (calFilters.length) { const t = tagList(log); dots = `<span class="fdots">${calFilters.map((f, i) => t.includes(f) ? `<i style="background:${FILTER_COLORS[i]}"></i>` : '').join('')}</span>`; }
  else if (log && (log.note || log.temp != null || log.tags || log.custom)) dots = '<span class="logdot"></span>';
  return `<button class="${cls.join(' ')}" data-act="cal-day" data-k="${k}">${fa(Cal.parts(d).d)}${dots}</button>`;
}
function legend() {
  return `<div class="legend"><span><i style="background:var(--period)"></i>پریود ثبت‌شده</span><span><i class="dash"></i>پیش‌بینی پریود</span><span><i style="background:var(--teal-soft);box-shadow:inset 0 0 0 1.5px var(--teal)"></i>باروری (تخمینی)</span><span><i style="background:var(--teal)"></i>تخمک‌گذاری (تخمینی)</span><span><i style="background:var(--plum-soft);box-shadow:inset 0 0 0 1.5px var(--plum)"></i>PMS (تخمینی)</span></div>`;
}
function viewCalendar(p) {
  const you = isHer();
  let html = '';
  if (you) html += `<div class="filters">${calFilters.map((f, i) => `<button class="chip on" style="--c:${FILTER_COLORS[i]}" data-act="filter-remove" data-v="${f}">${esc(labelOf(f).label)} ✕</button>`).join('')}
    ${calFilters.length < 3 ? `<button class="chip" data-act="filter-add">${calFilters.length ? '+ فیلتر' : '+ فیلتر علائم (تا ۳ مورد)'}</button>` : ''}</div>`;
  html += `<div class="card white">${monthGrid(calAnchor, d => calCell(p, d))}${legend()}
    ${!sameDay(Cal.monthStart(calAnchor), Cal.monthStart(todayDate())) ? `<div class="center" style="margin-top:12px"><button class="text-link" data-act="cal-today">برگشت به امروز</button></div>` : ''}</div>`;
  html += dayDetails(p, calSel);
  if (calFilters.length) html += filterSummary();
  if (you && ['period', 'conceive', 'perimenopause'].includes(p.mode)) html += `<div class="card ${calEdit ? 'blush' : ''}"><div class="row between"><div><b style="font-weight:500">${calEdit ? 'روی روزها بزن تا پریود ثبت یا حذف بشه' : 'ویرایش سریع روزهای پریود'}</b><div class="muted" style="font-size:13.5px">${calEdit ? 'وقتی تموم شد، «تمام» رو بزن' : 'برای ثبت تاریخچه‌ی قبلی، چند روز پشت سر هم'}</div></div><button class="pill-btn sm ${calEdit ? 'red' : 'ghost'}" data-act="cal-edit">${calEdit ? 'تمام' : 'ویرایش'}</button></div></div>`;
  if (p.hasData) html += `<div class="card"><div class="card-label">پریودهای پیش رو <span>تخمینی</span></div>${p.future.slice(0, 4).map(c => `<div class="list-row"><span class="dot" style="background:var(--period-pred)"></span><div class="main"><b>${Cal.dayMonth(c.start)} تا ${Cal.dayMonth(c.periodEnd)}</b>${c.ov ? `<small>تخمک‌گذاری قبلش: ${Cal.dayMonth(c.ov)}</small>` : ''}</div><span class="end">${relDays(dayDiff(p.today, c.start))}</span></div>`).join('')}
    ${p.confidence === 'irregular' ? '<p class="data-meta">چرخه‌ها نامنظم‌ان؛ تاریخ‌ها ممکنه چند روز جابه‌جا بشن.</p>' : ''}</div>`;
  return html;
}
function dayDetails(p, k) {
  const d = fromKey(k); const t = p.today; const log = S.logs[k]; const info = p.dayMap.get(k) || {};
  const observed = isHer() ? logChips(log) : (log && log.period ? [[CAT_BY_ID.period.color, 'پریود', 'period']] : []);
  const est = [];
  if (info.predPeriod && d >= t && !(log && log.period)) est.push('پیش‌بینی پریود');
  if (info.ovulation) est.push('تخمک‌گذاری'); else if (info.fertile) est.push('پنجره‌ی باروری');
  if (info.pms) est.push('PMS احتمالی');
  const ph = p.hasData ? (d > t ? phaseOn(engineState(), p, d) : sameDay(d, t) ? p.phase : pastPhase(engineState(), p, k)) : null;
  return `<div class="card white"><div class="card-label">${Cal.weekdayDayMonth(d)} <span>${relDays(dayDiff(t, d))}</span></div>
    ${ph && PHASES[ph] ? `<p style="font-size:14px;color:var(--ink-2)">فاز: ${PHASES[ph].name} (تخمینی)</p>` : ''}
    <div class="card-label" style="margin-top:10px">ثبت‌شده</div>${observed.length ? `<div class="chips">${observed.map(c => `<span class="chip static on" style="--c:${c[0]}">${esc(c[1])}</span>`).join('')}</div>` : '<p class="muted" style="font-size:14px">چیزی ثبت نشده.</p>'}
    ${est.length ? `<div class="card-label" style="margin-top:12px">تخمین Moon&Us</div><div class="chips">${est.map(e => `<span class="chip static">${e}</span>`).join('')}</div>` : ''}
    ${isHer() && d <= t ? `<button class="pill-btn ghost block" style="margin-top:14px" data-act="open-log" data-k="${k}">${observed.length ? 'ویرایش ثبت' : 'ثبت برای این روز'}</button>` : ''}</div>`;
}
function filterSummary() {
  const counts = calFilters.map(f => Object.values(S.logs).filter(l => tagList(l).includes(f)).length);
  return `<div class="card"><div class="card-label">فیلترها در کل تاریخچه</div>${calFilters.map((f, i) => `<div class="list-row"><span class="dot" style="background:${FILTER_COLORS[i]}"></span><div class="main"><b>${esc(labelOf(f).label)}</b></div><span class="end">${fa(counts[i])} روز</span></div>`).join('')}<p class="data-meta">ماه‌های قبل رو با فلش‌های تقویم ببین.</p></div>`;
}

// =================================================================
// Sheets
// =================================================================
let sheetDay = null;
function openSheet(html) { $('#sheet-root').innerHTML = `<div class="sheet-backdrop" data-act="sheet-bg"><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${html}</div></div>`; document.body.style.overflow = 'hidden'; }
function refreshSheet(html) {
  const sh = $('.sheet'); if (!sh) return; const top = sh.scrollTop;
  const a = document.activeElement; const keep = a && a.id && sh.contains(a) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  sh.innerHTML = `<div class="sheet-grip"></div>${html}`; sh.scrollTop = top;
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (e) {} } }
}
function closeSheet(rerender = true) { $('#sheet-root').innerHTML = ''; document.body.style.overflow = ''; sheetDay = null; logSearch = ''; helpOpen = null; if (rerender) render(); }
const sheetHead = (title, sub = '', left = '') => `<div class="sheet-head">${left || '<span></span>'}<h2>${title}${sub ? `<small>${sub}</small>` : ''}</h2><button class="round-btn flat" data-act="sheet-close" aria-label="بستن">${ic('close')}</button></div>`;

function orderedCats(m) {
  const order = S.profile.catOrder || [];
  const all = CATEGORIES.filter(c => !c.modes || c.modes.includes(m));
  return all.slice().sort((a, b) => { const ia = order.indexOf(a.id), ib = order.indexOf(b.id); return (ia < 0 ? 999 + CATEGORIES.indexOf(a) : ia) - (ib < 0 ? 999 + CATEGORIES.indexOf(b) : ib); });
}
function logSheetHtml(k) {
  const d = fromKey(k); const t = todayDate(); const log = S.logs[k] || {}; const m = modeAt(engineState(), k);
  const canNext = addDays(d, 1) <= t; const q = logSearch.trim();
  const cats = orderedCats(m).filter(c => q || c.id === 'period' || !S.profile.hiddenCats.includes(c.id));
  let html = `<div class="sheet-head"><button class="round-btn flat" data-act="log-day" data-k="${toKey(addDays(d, -1))}" aria-label="روز قبل">${ic('chevR')}</button>
    <h2>${sameDay(d, t) ? 'امروز، ' : ''}${Cal.weekdayDayMonth(d)}<small>${MODES[m].name}</small></h2>
    <button class="round-btn flat" data-act="log-day" data-k="${toKey(addDays(d, 1))}" ${canNext ? '' : 'disabled style="opacity:.25"'} aria-label="روز بعد">${ic('chevL')}</button></div>
    <div class="sheet-body"><div class="searchbox">${ic('search')}<input class="input" id="log-search" placeholder="جستجوی گزینه‌ها (مثلاً سردرد)" value="${esc(logSearch)}" data-input="log-search"></div>`;
  let shown = 0;
  for (const c of cats) {
    let items = c.items; if (q) items = items.filter(([, l]) => l.includes(q) || c.name.includes(q)); if (!items.length) continue;
    shown++;
    const sel = c.id === 'period' ? (log.period ? [log.period] : []) : (log.tags?.[c.id] || []);
    const help = CAT_HELP[c.id];
    html += `<div class="track-cat"><div class="track-cat-head">${glyph(c.glyph, c.color)}<b>${c.name}</b><small>${c.single ? 'یکی رو انتخاب کن' : ''}</small>${help ? `<button class="round-btn flat sm" data-act="cat-help" data-c="${c.id}" aria-label="راهنمای ${c.name}">${ic('info')}</button>` : ''}</div>
      ${helpOpen === c.id && help ? `<div class="help-box"><p><b>چیه:</b> ${help.what}</p><p><b>چرا ثبت کنم:</b> ${help.why}</p><p><b>کی با پزشک صحبت کنم:</b> ${help.doctor}</p>${relatedArticles({ cats: [c.id] })}${draftBadge()}</div>` : ''}
      <div class="chips">${items.map(([v, l]) => `<button class="chip ${sel.includes(v) ? 'on' : ''}" style="--c:${c.color}" data-act="tag" data-k="${k}" data-c="${c.id}" data-v="${v}">${l}</button>`).join('')}</div>
      ${c.id === 'pain' && !q ? `<div class="sub-label">شدت درد</div><div class="chips">${PAIN_LEVELS.map(([v, l]) => `<button class="chip ${log.painLevel === v ? 'on' : ''}" style="--c:${c.color}" data-act="pain-level" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>` : ''}</div>`;
  }
  const tags = (S.tags || []).filter(tg => !q || tg.name.includes(q));
  if (!q || tags.length) {
    shown++;
    html += `<div class="track-cat"><div class="track-cat-head">${glyph('tag', '#5A6B7B')}<b>برچسب‌های من</b><small>نامحدود</small></div>
      <div class="chips">${tags.map(tg => `<button class="chip ${(log.custom || []).includes(tg.id) ? 'on' : ''}" style="--c:#5A6B7B" data-act="custom-tag" data-k="${k}" data-v="${tg.id}">#${esc(tg.name)}</button>`).join('')}</div>
      ${!q ? `<div class="composer" style="margin-top:10px"><input class="input" id="new-tag" maxlength="30" placeholder="برچسب جدید"><button class="pill-btn ghost sm" data-act="tag-add" data-k="${k}">افزودن</button></div>` : ''}</div>`;
  }
  if (q && !shown) html += `<p class="muted center">گزینه‌ای با «${esc(q)}» پیدا نشد. می‌تونی برچسب خودت رو بسازی.</p>`;
  if (!q) html += `<div class="track-cat"><div class="track-cat-head">${glyph('sun', '#5A6B7B')}<b>اندازه‌گیری‌ها</b></div>
      <div class="grid2"><div class="field"><label for="log-temp">دمای پایه‌ی بدن (°C)</label><input class="input ltr" id="log-temp" inputmode="decimal" placeholder="36.5" value="${log.temp ?? ''}" data-input="temp" data-k="${k}"></div>
      <div class="field"><label for="log-weight">وزن (kg)</label><input class="input ltr" id="log-weight" inputmode="decimal" placeholder="60" value="${log.weight ?? ''}" data-input="weight" data-k="${k}"></div></div>
      <p class="data-meta">دمای پایه رو صبح قبل از بلند شدن اندازه بگیر. دمای پوست دستگاه‌های پوشیدنی جداگانه نگه داشته می‌شه.</p></div>
    <div class="track-cat"><div class="track-cat-head">${glyph('bulb', '#8D8781')}<b>یادداشت روزانه</b><small>فقط برای خودت</small></div><textarea class="input" id="log-note" placeholder="هرچی دوست داری بنویس…" data-input="note" data-k="${k}">${esc(log.note || '')}</textarea></div>`;
  html += `<div class="row" style="margin-top:6px"><button class="pill-btn red" style="flex:1" data-act="sheet-close">ذخیره</button><button class="pill-btn ghost" data-act="cats-sheet">دسته‌ها</button></div>
    ${!logIsEmpty(S.logs[k]) ? `<button class="text-link" style="justify-content:center;color:var(--muted)" data-act="log-clear" data-k="${k}">پاک کردن همه‌ی ثبت‌های این روز</button>` : ''}</div>`;
  return html;
}
function openLog(k) { if (!isHer()) return; sheetDay = k; openSheet(logSheetHtml(k)); }


// Typical hormone pattern (textbook shapes, not her measurements). x = 0..100 across the cycle, RTL.
const HORMONES = [
  ['E2', 'استروژن (E2)', '#4A78E0', x => 0.12 + 0.62 * Math.exp(-((x - 45) ** 2) / 90) + 0.3 * Math.exp(-((x - 72) ** 2) / 160)],
  ['PG', 'پروژسترون (PG)', '#2EC4A0', x => 0.06 + 0.72 * Math.exp(-((x - 72) ** 2) / 210)],
  ['FSH', 'هورمون محرک فولیکول (FSH)', '#F5D27A', x => 0.16 + 0.12 * Math.exp(-((x - 6) ** 2) / 60) + 0.14 * Math.exp(-((x - 50) ** 2) / 6) + 0.06 * Math.exp(-((x - 98) ** 2) / 30)],
  ['LH', 'هورمون لوتئینی (LH)', '#E0607E', x => 0.1 + 0.85 * Math.exp(-((x - 49) ** 2) / 5)],
];
function hormoneChart(sub, compact = false) {
  const W = 340, H = compact ? 120 : 160, top = 22, bottom = H - 22;
  const X = x => (W - 8 - x / 100 * (W - 16)).toFixed(1); // RTL: day 1 on the right
  const Y = v => (bottom - v * (bottom - top - 6)).toFixed(1);
  const blocks = Object.entries(SUBPHASE_RANGE).map(([k, [a, b]]) => `<rect x="${X(b)}" y="${top}" width="${(+X(a) - +X(b) - 3).toFixed(1)}" height="${bottom - top}" rx="8" fill="${b <= 50 ? '#7A2342' : '#0A6A55'}" opacity="${k === sub ? 1 : 0.38}"/>`).join('');
  const curves = HORMONES.map(([, , col, f]) => { let d = ''; for (let x = 0; x <= 100; x += 2) d += `${x ? 'L' : 'M'}${X(x)} ${Y(f(x))}`; return `<path d="${d}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round"/>`; }).join('');
  return `<svg class="hormones" viewBox="0 0 ${W} ${H}" role="img" aria-label="الگوی معمول هورمون‌ها در چرخه">${blocks}
    <line x1="${X(50)}" x2="${X(50)}" y1="${top - 6}" y2="${bottom}" stroke="#7FB3FF" stroke-width="2"/><circle cx="${X(50)}" cy="${top - 8}" r="4" fill="#7FB3FF"/>
    <text x="${X(50)}" y="11" text-anchor="middle" font-size="10" fill="#7FB3FF" font-family="Vazirmatn">تخمک‌گذاری</text>${curves}
    <text x="${X(25)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#E58AA6" font-family="Vazirmatn">فاز فولیکولار</text><text x="${X(75)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#3FD0A8" font-family="Vazirmatn">فاز لوتئال</text></svg>`;
}
function hormoneLegend(sub) {
  const lv = sub && SUBPHASES[sub] && SUBPHASES[sub].levels;
  return `<div class="h-legend">${HORMONES.map(([k, name, col]) => `<span><i style="background:${col}"></i>${name}${lv ? `: <b>${lv[k]}</b>` : ''}</span>`).join('')}</div>`;
}
function phaseSheet() {
  const p = predict(engineState()); const ph = PHASES[p.phase || 'unknown'] || PHASES.unknown; const you = isHer(); const sp = p.subphase && SUBPHASES[p.subphase];
  openSheet(`${sheetHead(sp ? sp.name : ph.name, 'تخمینی')}<div class="sheet-body">
    ${sp ? `<div class="card white">${hormoneChart(p.subphase)}${hormoneLegend(p.subphase)}<p class="data-meta">الگوی معمول از منابع آموزشی؛ هورمون‌های خودت اندازه‌گیری نشده.</p></div>` : ''}
    <div class="card ${ph.card}"><p style="font-size:16px;line-height:1.95">${ph.body}</p>${sp ? `<p style="margin-top:8px;color:var(--ink-2)">${sp.hormones} ${sp.may}</p>` : ''}<div style="margin-top:8px">${draftBadge()}</div></div>
    <div class="card white"><div class="card-label">${you ? 'مراقبت از خودت' : 'چطور کنارش باشی'}</div><ul class="bullets">${(you ? ph.her : ph.him).map(x => `<li>${x}</li>`).join('')}</ul></div>
    ${!you && ph.avoid.length ? `<div class="card white"><div class="card-label">بهتره نه</div><ul class="bullets x">${ph.avoid.map(x => `<li>${x}</li>`).join('')}</ul></div>` : ''}
    ${relatedArticles({ phases: [p.phase], modes: [p.mode] })}
    <p class="data-meta">فازها از روی تاریخ‌ها تخمین زده می‌شن و اندازه‌گیری هورمون نیستن. مقایسه با کاربران دیگه در دسترس نیست چون داده‌ی تجمیعی واقعی نداریم.</p></div>`);
}
function relatedArticles(f) {
  const list = ARTICLES.filter(a => (f.cats || []).some(c => a.cats.includes(c)) || (f.phases || []).some(c => a.phases.includes(c)) || (f.modes || []).some(c => a.modes.includes(c)));
  const visible = list.filter(a => a.status === 'published' || P.showDrafts);
  if (!list.length) return '';
  if (!visible.length) return `<p class="data-meta">${fa(list.length)} مطلب مرتبط در انتظار بازبینی پزشکیه.</p>`;
  return `<div class="related">${visible.slice(0, 3).map(a => `<a href="#article/${a.id}">${esc(a.title)}${a.status !== 'published' ? ' (پیش‌نویس)' : ''}</a>`).join('')}</div>`;
}
function modeSheet() {
  const cur = mode();
  openSheet(`${sheetHead('حالت Moon&Us', 'تاریخچه‌ات با تغییر حالت حفظ می‌شه')}<div class="sheet-body">
    ${Object.entries(MODES).map(([k, m]) => `<button class="choice ${cur === k ? 'on' : ''}" data-act="set-mode" data-v="${k}">${glyph(m.glyph, m.color)}<div><b>${m.name}</b><small>${m.desc}</small></div><span class="radio"></span></button>`).join('')}
    <p class="fine">پیش‌بینی روزهای باروری روش پیشگیری از بارداری نیست.</p></div>`);
}
function pregSetupSheet(editDue = false) {
  const pg = S.pregnancy || {}; const ref = pg.ref || (predict(engineState()).lastPeriod || {}).start || toKey(todayDate());
  openSheet(`${sheetHead(editDue ? 'تاریخ تخمینی زایمان' : 'شروع پیگیری بارداری')}<div class="sheet-body">
    ${editDue ? '' : `<div class="field"><label for="preg-ref">اولین روز آخرین پریود</label><input class="input ltr" type="date" id="preg-ref" value="${ref}" max="${toKey(todayDate())}"></div>`}
    <div class="field"><label for="preg-due">تاریخ تخمینی زایمان (اختیاری؛ خالی یعنی ۴۰ هفته بعد از تاریخ بالا)</label><input class="input ltr" type="date" id="preg-due" value="${editDue ? (pg.due || '') : ''}"></div>
    <p class="data-meta">تاریخ‌ها میلادی وارد می‌شن و در اپ با تقویم انتخابی‌ات نمایش داده می‌شن. اگه پزشک تاریخ دیگه‌ای گفته، همون رو وارد کن.</p>
    <button class="pill-btn red block" data-act="${editDue ? 'preg-due-save' : 'preg-start'}">ذخیره</button></div>`);
}
function pregEndSheet() {
  openSheet(`${sheetHead('پایان پیگیری بارداری')}<div class="sheet-body">
    <div class="field"><label for="preg-end">تاریخ</label><input class="input ltr" type="date" id="preg-end" value="${toKey(todayDate())}" max="${toKey(todayDate())}"></div>
    <div class="field"><label>وضعیت</label><div class="seg" id="preg-outcome"><button class="on" data-act="seg" data-v="birth">تولد نوزاد</button><button data-act="seg" data-v="ended">پایان بارداری</button></div></div>
    <div class="field"><label>ادامه با حالت</label><div class="stack">${['period', 'noperiod', 'conceive'].map((k, i) => `<button class="choice ${i === 0 ? 'on' : ''}" data-act="pick-next-mode" data-v="${k}">${glyph(MODES[k].glyph, MODES[k].color)}<div><b>${MODES[k].name}</b></div><span class="radio"></span></button>`).join('')}</div></div>
    <p class="data-meta">همه‌ی ثبت‌های دوران بارداری حفظ می‌شن.</p><button class="pill-btn red block" data-act="preg-end-save">تأیید</button></div>`);
}
function intervalSheet() {
  openSheet(`${sheetHead('شروع بازه‌ی جدید')}<div class="sheet-body">
    <div class="field"><label for="iv-date">تاریخ شروع</label><input class="input ltr" type="date" id="iv-date" value="${toKey(todayDate())}" max="${toKey(todayDate())}"></div>
    <div class="chips"><button class="chip" data-act="iv-quick" data-v="month">اول همین ماه</button><button class="chip" data-act="iv-quick" data-v="today">امروز</button></div>
    <p class="data-meta">مثلاً روزی که دارو عوض شد. شروع بازه پریود حساب نمی‌شه.</p><button class="pill-btn red block" data-act="interval-save">شروع</button></div>`);
}
function catsSheet() {
  const m = mode(); const cats = orderedCats(m).filter(c => c.id !== 'period');
  openSheet(`${sheetHead('دسته‌های ثبت', 'نمایش، پنهان کردن و ترتیب')}<div class="sheet-body"><div class="card white">
    ${cats.map((c, i) => `<div class="list-row">${glyph(c.glyph, c.color)}<div class="main"><b>${c.name}</b><small>${c.items.slice(0, 3).map(x => x[1]).join('، ')}</small></div>
      <button class="round-btn flat sm" data-act="cat-move" data-c="${c.id}" data-d="-1" ${i === 0 ? 'disabled style="opacity:.25"' : ''} aria-label="بالا">${ic('chevU')}</button><button class="round-btn flat sm" data-act="cat-move" data-c="${c.id}" data-d="1" ${i === cats.length - 1 ? 'disabled style="opacity:.25"' : ''} aria-label="پایین">${ic('chevD')}</button>
      <label class="switch"><input type="checkbox" data-act="cat-toggle" data-c="${c.id}" ${S.profile.hiddenCats.includes(c.id) ? '' : 'checked'}><span></span></label></div>`).join('')}
  </div><button class="pill-btn red block" data-act="cats-done">تمام</button></div>`);
}
let catReturn = null;
function tagsSheet() {
  const usage = id => Object.values(S.logs).filter(l => (l.custom || []).includes(id)).length;
  openSheet(`${sheetHead('برچسب‌های من', 'نامحدود')}<div class="sheet-body"><div class="card white">
    ${(S.tags || []).length ? S.tags.map(tg => `<div class="list-row"><div class="main"><input class="input" id="tg-${tg.id}" value="${esc(tg.name)}" maxlength="30"><small>${fa(usage(tg.id))} روز استفاده شده</small></div><button class="pill-btn ghost sm" data-act="tag-rename" data-v="${tg.id}">ذخیره</button><button class="pill-btn ghost sm" data-act="tag-delete" data-v="${tg.id}">حذف</button></div>`).join('') : '<p class="muted">هنوز برچسبی نساختی. از صفحه‌ی ثبت روزانه برچسب بساز.</p>'}
  </div></div>`);
}
function filterSheet() {
  const used = {}; for (const l of Object.values(S.logs)) for (const id of tagList(l)) used[id] = (used[id] || 0) + 1;
  const ids = Object.keys(used).filter(id => !calFilters.includes(id)).sort((a, b) => used[b] - used[a]);
  openSheet(`${sheetHead('فیلتر علائم', 'تا ۳ مورد')}<div class="sheet-body"><div class="searchbox">${ic('search')}<input class="input" id="filter-q" placeholder="جستجو" data-input="filter-q"></div>
    <div class="chips" id="filter-list">${ids.length ? ids.map(id => `<button class="chip" data-label="${esc(labelOf(id).label)}" style="--c:${labelOf(id).color}" data-act="filter-pick" data-v="${id}">${esc(labelOf(id).label)} (${fa(used[id])})</button>`).join('') : '<p class="muted">هنوز علامتی ثبت نشده.</p>'}</div></div>`);
}
function cycleSettingsSheet() {
  const pr = S.profile; const ov = pr.avgOverride || {};
  const stepper = (id, v, min, max, label, sub) => `<div class="list-row"><div class="main"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</div><div class="row" style="gap:6px"><button class="round-btn flat sm stp" data-act="num" data-id="${id}" data-d="1" data-min="${min}" data-max="${max}">+</button><div class="val" id="v-${id}" data-v="${v}" style="min-width:44px;text-align:center"><b style="font-family:var(--serif-fa);font-size:26px;color:var(--crimson);font-weight:500">${fa(v)}</b></div><button class="round-btn flat sm stp" data-act="num" data-id="${id}" data-d="-1" data-min="${min}" data-max="${max}">−</button></div></div>`;
  openSheet(`${sheetHead('تنظیمات چرخه')}<div class="sheet-body">
    <div class="card white"><div class="field"><label for="f-her">اسمت</label><input class="input" id="f-her" maxlength="24" value="${esc(S.herName)}"></div></div>
    <div class="card white">${stepper('cycle', pr.cycleLength, 18, 60, 'طول معمول چرخه', 'وقتی هنوز چرخه‌ی کامل ثبت نشده')}${stepper('period', pr.periodLength, 1, 12, 'طول معمول پریود', '')}${stepper('luteal', pr.luteal, 9, 18, 'طول فاز لوتئال', 'معمولاً ۱۴')}${stepper('horizon', pr.horizon || 12, 1, 24, 'تعداد چرخه‌های پیش‌بینی', 'در تقویم')}</div>
    <div class="card white"><div class="list-row"><div class="main"><b>میانگین دستی</b><small>به‌جای میانگین ثبت‌ها از این عددها استفاده کن</small></div><label class="switch"><input type="checkbox" id="ov-on" ${ov.cycle ? 'checked' : ''}><span></span></label></div>
      ${stepper('ovc', ov.cycle || pr.cycleLength, 15, 90, 'طول چرخه', '')}${stepper('ovp', ov.period || pr.periodLength, 1, 12, 'طول پریود', '')}</div>
    <div class="card white"><div class="list-row"><div class="main"><b>روش پیشگیری هورمونی</b><small>قرص، آی‌یودی هورمونی، ایمپلنت و… (تخمین زیرفازها غیرفعال می‌شه)</small></div><label class="switch"><input type="checkbox" id="hormonal" ${pr.hormonal ? 'checked' : ''}><span></span></label></div></div>
    <button class="pill-btn red block" data-act="save-cycle">ذخیره</button></div>`);
}
function remindersSheet() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const pushRow = pushCardHtml(true);
  const preg = mode() === 'pregnancy';
  openSheet(`${sheetHead('یادآورها')}<div class="sheet-body">
    <div class="card ${perm === 'granted' ? 'teal' : 'peach'}"><p style="font-size:14.5px">${perm === 'granted' ? 'اعلان‌ها روی این دستگاه فعال‌ان.' : perm === 'denied' ? 'اعلان‌ها در تنظیمات مرورگر مسدود شدن؛ یادآورها داخل اپ نشون داده می‌شن.' : perm === 'unsupported' ? 'این مرورگر از اعلان پشتیبانی نمی‌کنه؛ یادآورها داخل اپ نشون داده می‌شن.' : 'برای دریافت یادآور، اجازه‌ی اعلان بده.'}</p>
      ${perm === 'default' ? `<button class="pill-btn red block" style="margin-top:10px" data-act="notif-perm">اجازه‌ی اعلان</button>` : ''}
      <p class="data-meta">اعلان‌ها وقتی اپ بازه یا به‌تازگی باز شده ارسال می‌شن. برای اطمینان در پس‌زمینه، یادآورها رو به تقویم گوشی هم اضافه کن.</p></div>
    ${pushRow}
    <div class="card white"><div class="list-row"><div class="main"><b>متن محرمانه</b><small>اعلان‌ها فقط «${DISCREET_TEXT}» نشون بدن</small></div><label class="switch"><input type="checkbox" data-act="discreet" ${P.discreet ? 'checked' : ''}><span></span></label></div></div>
    ${REMINDER_TYPES.map(r => { const c = S.reminders[r.id] || {}; const paused = preg && PAUSED_IN_PREGNANCY.includes(r.id); const pillOff = r.id === 'pill' && !S.profile.pill;
      return `<div class="card white ${paused || pillOff ? 'dim' : ''}"><div class="list-row"><div class="main"><b>${r.name}</b><small>${paused ? 'در بارداری متوقفه' : pillOff ? 'اول «قرص ضدبارداری» رو در منو روشن کن' : (r.custom === false ? 'ساعت و متن ثابت (۲۰:۰۰)' : '')}</small></div><label class="switch"><input type="checkbox" data-act="rem-on" data-id="${r.id}" ${c.on ? 'checked' : ''}><span></span></label></div>
      ${c.on && r.custom !== false ? `<div class="grid2"><div class="field"><label>ساعت</label><input class="input ltr" type="time" value="${c.time || r.time}" data-rem="time" data-id="${r.id}"></div>${r.days ? `<div class="field"><label>${r.id === 'period_late' ? 'چند روز بعد' : 'چند روز قبل'}</label><input class="input ltr" type="number" min="1" max="10" value="${c.days || r.days}" data-rem="days" data-id="${r.id}"></div>` : '<span></span>'}</div>
      <div class="field" style="margin-top:8px"><label>متن (خالی یعنی پیش‌فرض)</label><input class="input" maxlength="120" placeholder="${esc(r.def)}" value="${esc(c.text || '')}" data-rem="text" data-id="${r.id}"></div>` : ''}</div>`; }).join('')}
    <button class="pill-btn ghost block" data-act="ics">افزودن یادآورهای پیش رو به تقویم گوشی</button></div>`);
}
function feedbackSheet() {
  openSheet(`${sheetHead('پشتیبانی و بازخورد')}<div class="sheet-body">
    <div class="seg" id="fb-kind"><button class="on" data-act="seg" data-v="bug">مشکل</button><button data-act="seg" data-v="idea">پیشنهاد</button><button data-act="seg" data-v="question">سؤال</button></div>
    <textarea class="input" id="fb-text" maxlength="4000" placeholder="بنویس چی شده یا چی می‌خوای…"></textarea>
    <label class="check-row"><input type="checkbox" id="fb-email" checked> ایمیلم رو برای پاسخ بفرست</label>
    <p class="data-meta">پیامت به صف پشتیبانی Moon&Us می‌ره. اطلاعات سلامتت همراهش فرستاده نمی‌شه. این بخش مشاوره‌ی پزشکی نیست.</p>
    <button class="pill-btn red block" data-act="fb-send">ارسال</button></div>`);
}
function lookSheet() {
  openSheet(`${sheetHead('ظاهر و تقویم')}<div class="sheet-body">
    <div class="card white"><div class="card-label">تقویم</div><div class="seg"><button class="${P.calendar === 'persian' ? 'on' : ''}" data-act="pref" data-k="calendar" data-v="persian">شمسی</button><button class="${P.calendar === 'gregory' ? 'on' : ''}" data-act="pref" data-k="calendar" data-v="gregory">میلادی</button></div></div>
    <div class="card white"><div class="card-label">حالت نمایش</div><div class="seg"><button class="${P.theme !== 'dark' ? 'on' : ''}" data-act="pref" data-k="theme" data-v="light">روشن</button><button class="${P.theme === 'dark' ? 'on' : ''}" data-act="pref" data-k="theme" data-v="dark">تیره</button></div></div></div>`);
}
function pinSheet() {
  if (P.pin) openSheet(`${sheetHead('قفل رمز')}<div class="sheet-body"><div class="card white"><p>قفل رمز روی این دستگاه فعاله.</p></div><button class="pill-btn ghost block" data-act="pin-off">غیرفعال کردن قفل</button></div>`);
  else openSheet(`${sheetHead('قفل رمز این دستگاه')}<div class="sheet-body"><div class="card white stack"><p style="color:var(--ink-2);font-size:14.5px">هر بار که Moon&Us رو باز می‌کنی، رمز چهاررقمی پرسیده می‌شه.</p><input class="input big ltr" id="pin-in" inputmode="numeric" maxlength="4" placeholder="••••" style="text-align:center;letter-spacing:14px"></div><button class="pill-btn red block" data-act="pin-set">فعال کردن</button></div>`);
}
function confirmSheet(title, text, act, btn, data = '') {
  openSheet(`${sheetHead(title)}<div class="sheet-body"><div class="card white"><p style="color:var(--ink-2)">${text}</p></div><button class="pill-btn red block" data-act="${act}" ${data}>${btn}</button><button class="pill-btn ghost block" data-act="sheet-close">انصراف</button></div>`);
}
function composeSheet() {
  openSheet(`${sheetHead(`یادداشت برای ${isHer() ? partnerN() : herN()}`)}<div class="sheet-body"><textarea class="input" id="compose-text" maxlength="1000" placeholder="یه جمله‌ی مهربون، یه یادآوری یا یه «دوستت دارم»…"></textarea><button class="pill-btn red block" data-act="compose-send">فرستادن</button></div>`);
  setTimeout(() => $('#compose-text')?.focus(), 250);
}

// =================================================================
// Us — two different worlds: hers (receives, asks) and his (responds, gives)
// =================================================================
const inviteUrl = code => `${location.origin}${location.pathname.replace(/index\.html$/, '')}#invite/${code}`;
const fmtCode = c => (c || '').replace(/(.{4})(?=.)/g, '$1-');
const REQUESTS = [
  ['hug', 'بغل', 'heart', '#E0457B'], ['chocolate', 'شکلات', 'cookie', '#8A4B2A'], ['hotwater', 'کیسه آب‌گرم', 'flame', '#F26B1D'],
  ['massage', 'ماساژ', 'sparkle', '#9A6CC6'], ['tea', 'دمنوش گرم', 'leaf', '#3A9B5C'], ['food', 'یه غذای خوشمزه', 'cookie', '#E8A013'],
  ['movie', 'فیلم با هم', 'moon', '#3B6FD8'], ['comehere', 'بیا پیشم', 'people', '#C2185B'], ['painkiller', 'مسکن', 'pill', '#3B6FD8'],
  ['pads', 'نوار بهداشتی', 'drop', '#E13336'], ['space', 'کمی تنهایی', 'moon', '#5A6B7B'], ['quiet', 'سکوت و آرامش', 'bulb', '#16A3BF'],
];
const REQ_BY_ID = Object.fromEntries([...REQUESTS, ['need_you', 'الان بهت نیاز دارم', 'heart', '#BD131F']].map(r => [r[0], r]));
const REQ_STATUS = { open: 'فرستاده شد', seen: 'دید', onit: 'داره انجامش می‌ده', done: 'انجام شد' };
const COUPONS = ['ماساژ ۲۰ دقیقه‌ای', 'یه شام به انتخاب تو', 'یه روز بدون کار خونه', 'صبحونه توی تخت', 'یه فیلم به انتخاب تو، بدون غر زدن', 'بستنی، هر وقت خواستی'];
const COMPLIMENTS = ['امروز هم مثل همیشه قشنگی.', 'به داشتنت افتخار می‌کنم.', 'هر روز بیشتر از دیروز دوستت دارم.', 'تو قوی‌ترین آدمی هستی که می‌شناسم.', 'لبخندت بهترین قسمت روزمه.', 'هر چی لازم داشته باشی، کنارتم.'];
const GIFT_KINDS = { note: ['یادداشت عاشقانه', 'heart', '#E0457B'], photo: ['عکس', 'sun', '#E8730C'], coupon: ['کوپن', 'tag', '#0E8A70'], song: ['آهنگ یا لینک', 'sparkle', '#3B6FD8'], compliment: ['یه جمله‌ی قشنگ', 'bulb', '#9A6CC6'] };
const pname = () => esc((Object.values(S.partners || {})[0] || {}).name || 'پارتنرت');
const ago = at => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'همین الان' : m < 60 ? `${fa(m)} دقیقه پیش` : m < 1440 ? `${fa(Math.round(m / 60))} ساعت پیش` : Cal.short(new Date(at)); };
const giftOpenable = g => !g.unlockAt || g.unlockAt <= toKey(todayDate());
const activeRequests = () => (S.requests || []).filter(r => r.status !== 'done' && Date.now() - r.at < 36 * 3600 * 1000).sort((a, b) => b.at - a.at);

function viewUs(p) {
  if (isHer()) {
    if (!CLOUD && !Object.keys(S.partners || {}).length) return `<div class="center"><div class="duo"><span class="avatar her">${initial(S.herName)}</span><span class="avatar empty">+</span></div><h1 class="page-title">کسی که دوستش داری رو <span class="serif">اضافه کن</span></h1></div><div class="card"><p style="color:var(--ink-2)">اتصال فقط در نسخه‌ی آنلاین با حساب کاربری کار می‌کنه.</p></div>`;
    return Object.keys(S.partners || {}).length ? herUs(p) : herInvite();
  }
  return hisUs(p);
}

// ---------- hers ----------
function herInvite() {
  return `<div class="center" style="padding-top:8px"><div class="duo"><span class="avatar her">${initial(S.herName)}</span><span class="avatar empty">+</span></div>
    <h1 class="page-title">کسی که دوستش داری رو <span class="serif">کنارت بیار</span></h1>
    <p class="page-lead" style="margin-top:8px">با یه کلیک بهش می‌گی چه حسی داری یا چی لازم داری، و اون هم می‌تونه برات یادداشت، عکس و سورپرایز بذاره.</p></div>
    <div class="card"><div class="card-label">چیزی که می‌بینه</div>${[['drop', '#E13336', 'روزهای پریود و پیش‌بینی پریود بعدی'], ['egg', '#0C7A92', 'روزهای باروری، تخمک‌گذاری و PMS'], ['heart', '#E0457B', 'حال و درخواست‌هایی که خودت براش می‌فرستی']].map(i => `<div class="list-row">${glyph(i[0], i[1])}<div class="main"><b>${i[2]}</b></div></div>`).join('')}
      <div class="card-label" style="margin-top:12px">چیزی که نمی‌بینه</div><p style="font-size:14.5px;color:var(--ink-2)">علائم، احساسات ثبت‌شده، درد، یادداشت‌های روزانه، برچسب‌ها، دما، وزن و تست‌ها. این‌ها اصلاً به حساب اون فرستاده نمی‌شن.</p></div>
    ${S.inviteCode ? invitePending() : `<button class="pill-btn red block" data-act="invite" ${busy ? 'disabled' : ''}>${busy ? 'کمی صبر کن…' : 'دعوتش کن'}</button><p class="fine">لینک یا کد دعوت فقط یک بار کار می‌کنه و هر وقت بخوای دسترسی رو قطع می‌کنی.</p>`}`;
}
function invitePending() {
  const url = inviteUrl(S.inviteCode);
  return `<div class="card white stack"><div class="card-label">دعوت آماده‌ست</div><p style="font-size:14.5px;color:var(--ink-2)">لینک رو براش بفرست، یا کد رو بهش بگو تا موقع ثبت‌نام وارد کنه.</p>
    <div class="code-box latin">${esc(fmtCode(S.inviteCode))}</div>
    <div class="linkbox"><code>${esc(url)}</code><button class="round-btn flat" data-act="invite-copy" aria-label="کپی">${ic('copy')}</button></div>
    <button class="pill-btn red block" data-act="invite-share">${ic('share')} فرستادن لینک</button><button class="text-link" style="justify-content:center;color:var(--muted)" data-act="invite-cancel">لغو دعوت</button></div>`;
}
function herUs(p) {
  const him = pname();
  const gifts = (S.gifts || []).slice().sort((a, b) => b.at - a.at);
  const fresh = gifts.filter(g => giftOpenable(g) && !g.openedAt);
  const locked = gifts.filter(g => !giftOpenable(g));
  const opened = gifts.filter(g => giftOpenable(g) && g.openedAt);
  const st = todayStatus() || { mood: null };
  const act = activeRequests();
  const kitDone = CARE_KIT.filter(c => (S.kit.items || {})[c[0]]).length;
  let html = `<div class="us-head"><div class="duo small"><span class="avatar her">${initial(S.herName)}</span>${Object.values(S.partners).map(x => `<span class="avatar him">${initial(x.name)}</span>`).join('')}</div>
    <div><h1 class="page-title" style="font-size:24px;padding:0">${him} <span class="serif">کنارته</span></h1><p class="muted" style="font-size:13px">هر چی اینجا بفرستی، همون لحظه می‌بینه.</p></div>
    <button class="round-btn" data-act="sharing-sheet" aria-label="تنظیمات اشتراک">${ic('us')}</button></div>`;
  if (fresh.length) {
    html += `<button class="gift-hero" data-act="gift-open" data-id="${fresh[0].id}">${giftBoxArt()}<div><b>${him} یه چیزی برات گذاشته</b><small>${fresh.length > 1 ? `${fa(fresh.length)} هدیه‌ی باز‌نشده` : 'برای باز کردنش بزن'}</small></div></button>`;
  }
  if (locked.length) {
    const next = locked.sort((a, b) => (a.unlockAt < b.unlockAt ? -1 : 1))[0];
    html += `<div class="card plum row">${glyph('lock', '#7B5CD6')}<div style="flex:1"><b style="font-weight:500">یه سورپرایز قفل‌شده داری</b><div class="muted" style="font-size:13.5px">${next.unlockLabel ? esc(next.unlockLabel) + '، ' : ''}${Cal.weekdayDayMonth(fromKey(next.unlockAt))} باز می‌شه</div></div></div>`;
  }
  html += `<div class="card peach"><div class="card-label">حالت رو با یه لمس بگو</div><div class="moods">${MOODS.map((m, i) => `<button class="mood ${st.mood === i ? 'on' : ''}" data-act="mood" data-i="${i}">${face(i)}<span>${m}</span></button>`).join('')}</div>
    ${todayStatus() ? `<p class="data-meta">${him} می‌بینه: «${MOODS[st.mood] || ''}»${st.text ? `، «${esc(st.text)}»` : ''}</p>` : ''}
    <div class="field" style="margin-top:10px"><input class="input" id="status-text" maxlength="140" placeholder="یه جمله براش بنویس (اختیاری)" value="${esc(st.text || '')}" data-input="status-text"></div></div>`;
  html += `<button class="need-you" data-act="request" data-v="need_you">${glyph('heart', '#BD131F')}<span>الان بهت نیاز دارم</span></button>`;
  html += `<div class="card white"><div class="card-label">با یه کلیک بهش بگو <span>همون لحظه خبردار می‌شه</span></div>
    <div class="req-grid">${REQUESTS.map(([id, label, g, col]) => { const on = act.find(r => r.kind === id); return `<button class="req ${on ? 'on' : ''}" data-act="request" data-v="${id}">${glyph(g, col)}<span>${label}</span>${on ? `<small>${REQ_STATUS[on.status]}</small>` : ''}</button>`; }).join('')}</div>
    ${act.length ? `<div class="card-label" style="margin-top:14px">درخواست‌های فعال</div>${act.map(r => `<div class="list-row">${glyph(REQ_BY_ID[r.kind][2], REQ_BY_ID[r.kind][3])}<div class="main"><b>${REQ_BY_ID[r.kind][1]}</b><small>${ago(r.at)}</small></div><span class="status-chip s-${r.status}">${REQ_STATUS[r.status]}${r.status !== 'open' && r.ackAt ? '' : ''}</span><button class="round-btn flat sm" data-act="request-cancel" data-id="${r.id}" aria-label="لغو">${ic('close')}</button></div>`).join('')}` : ''}</div>`;
  html += `<div class="card white"><div class="card-label">از طرف ${him} <span>${fa(opened.length)} هدیه</span></div>
    ${opened.length ? `<div class="gift-wall">${opened.map(giftCard).join('')}</div>` : `<p class="muted" style="font-size:14.5px">هنوز چیزی اینجا نیست. هر یادداشت، عکس یا کوپنی که ${him} بفرسته، اینجا نگه داشته می‌شه.</p>`}</div>`;
  html += notesCard();
  html += `<div class="card row"><span style="flex:1;font-size:14.5px;color:var(--ink-2)">کیت مراقبت: ${him} ${fa(kitDone)} از ${fa(CARE_KIT.length)} مورد رو آماده کرده.</span></div>`;
  return html;
}
function giftBoxArt() {
  return `<svg viewBox="0 0 80 80" class="gift-art" aria-hidden="true"><rect x="12" y="34" width="56" height="36" rx="5" fill="#FF4D41"/><rect x="8" y="24" width="64" height="14" rx="4" fill="#E13336"/><rect x="36" y="24" width="8" height="46" fill="#FFD3CC"/><path d="M40 24c-4-10-18-14-18-5 0 6 10 5 18 5zM40 24c4-10 18-14 18-5 0 6-10 5-18 5z" fill="#FFD3CC"/></svg>`;
}
function giftCard(g) {
  const head = `<div class="gc-head">${glyph(GIFT_KINDS[g.type][1], GIFT_KINDS[g.type][2])}<small>${ago(g.at)}</small>${g.reaction ? '<span class="gc-love">دوستش داشتی</span>' : ''}</div>`;
  let body = '';
  if (g.type === 'photo') body = `<img class="gc-img" src="${esc(g.img)}" alt="عکس">${g.text ? `<p>${esc(g.text)}</p>` : ''}`;
  else if (g.type === 'coupon') body = `<div class="coupon"><small>کوپن</small><b>${esc(g.title)}</b>${g.text ? `<p>${esc(g.text)}</p>` : ''}${g.redeemedAt ? `<span class="status-chip s-done">استفاده شد</span>` : (isHer() ? `<button class="pill-btn sm red" data-act="coupon-use" data-id="${g.id}">استفاده می‌کنم</button>` : '')}</div>`;
  else if (g.type === 'song') body = `<a class="song" href="${esc(g.url)}" target="_blank" rel="noopener">${ic('send')}<span>${esc(g.title || 'یه آهنگ برات')}</span></a>${g.text ? `<p>${esc(g.text)}</p>` : ''}`;
  else body = `<p class="gc-text">${esc(g.text)}</p>`;
  const foot = isHer() ? `<button class="text-link" data-act="gift-love" data-id="${g.id}">${g.reaction ? 'دوستش داشتم' : 'دوستش داشتم؟'}</button>` : `<span class="muted" style="font-size:12px">${g.unlockAt && !giftOpenable(g) ? `قفل تا ${Cal.dayMonth(fromKey(g.unlockAt))}` : g.openedAt ? `باز شد، ${ago(g.openedAt)}` : 'هنوز باز نشده'}${g.redeemedAt ? '، استفاده شد' : ''}${g.reaction ? '، دوستش داشت' : ''}</span><button class="text-link" style="color:var(--muted)" data-act="gift-delete" data-id="${g.id}">حذف</button>`;
  return `<div class="gift-card g-${g.type}">${head}${body}<div class="gc-foot">${foot}</div></div>`;
}
function giftRevealSheet(g) {
  const him = pname();
  openSheet(`${sheetHead(`از طرف ${him}`)}<div class="sheet-body"><div class="reveal">${giftCard({ ...g, openedAt: g.openedAt || Date.now() })}</div>
    <button class="pill-btn red block" data-act="gift-love" data-id="${g.id}">دوستش داشتم</button><button class="pill-btn ghost block" data-act="sheet-close">بستن</button></div>`);
}
function sharingSheet() {
  const partners = Object.entries(S.partners || {});
  openSheet(`${sheetHead('اشتراک‌گذاری')}<div class="sheet-body">
    <div class="card white">${partners.map(([uid, x]) => `<div class="list-row"><span class="avatar him" style="width:40px;height:40px;font-size:16px;border:0">${initial(x.name)}</span><div class="main"><b>${esc(x.name || 'بدون نام')}</b><small>از ${Cal.full(new Date(x.joinedAt))}، فقط مشاهده</small></div><button class="pill-btn ghost sm" data-act="remove-partner" data-v="${uid}">قطع دسترسی</button></div>`).join('')}</div>
    <div class="card"><p style="font-size:14px;color:var(--ink-2)">می‌بینه: روزهای پریود، باروری، تخمک‌گذاری و PMS، و حال و درخواست‌هایی که خودت می‌فرستی. نمی‌بینه: علائم، احساسات ثبت‌شده، یادداشت‌های روزانه، برچسب‌ها، دما، وزن و تست‌ها.</p>
    ${mode() === 'pregnancy' ? '<p class="data-meta">در حالت بارداری، اشتراک تقویم متوقفه.</p>' : ''}</div>
    ${S.inviteCode ? invitePending() : `<button class="pill-btn ghost block" data-act="invite">دعوت یه نفر دیگه</button>`}</div>`);
}

// ---------- his ----------
function hisUs(p) {
  const her = herN(); const st = todayStatus(); const act = activeRequests();
  const sent = (S.gifts || []).filter(g => g.uid === ME.uid).sort((a, b) => b.at - a.at);
  const needs = st ? (st.needs || []).map(n => (NEEDS.find(x => x[0] === n) || [])[1]).filter(Boolean) : [];
  const ph = PHASES[p.phase || 'unknown'] || PHASES.unknown;
  const idea = ph.him.length ? ph.him[(todayDate().getDate()) % ph.him.length] : '';
  let html = `<div class="her-hero"><div class="hh-face">${face(st && st.mood != null ? st.mood : 2, 72)}</div>
    <div><div class="muted" style="font-size:13px">${st ? `حال ${her}، ${ago(st.u || Date.now())}` : `${her} هنوز حال امروزش رو نگفته`}</div>
    <h2>${st && st.mood != null ? MOODS[st.mood] : 'منتظر خبر'}</h2>${st && st.text ? `<p>«${esc(st.text)}»</p>` : ''}
    ${p.hasData && !(S.shared && S.shared.paused) ? `<p class="hh-phase">${p.inPeriod ? `روز ${fa(p.cycleDay)} پریود` : p.lateDays > 0 ? `پریود ${fa(p.lateDays)} روز عقب‌تر از تخمین` : `${fa(p.daysToNext)} روز تا پریود بعدی`}، ${(PHASES[p.phase] || {}).name || ''}</p>` : ''}</div></div>`;
  html += `<div class="card white"><div class="card-label">درخواست‌های ${her} <span>${act.length ? `${fa(act.length)} فعال` : ''}</span></div>
    ${act.length ? act.map(r => { const R = REQ_BY_ID[r.kind]; return `<div class="req-item ${r.status === 'open' ? 'urgent' : ''} ${r.kind === 'need_you' ? 'need' : ''}">${glyph(R[2], R[3])}<div class="main"><b>${R[1]}</b><small>${ago(r.at)}، ${REQ_STATUS[r.status]}</small></div>
      <div class="req-actions">${r.status === 'open' ? `<button class="pill-btn sm ghost" data-act="req-ack" data-id="${r.id}" data-s="seen">دیدم</button>` : ''}${r.status !== 'onit' ? `<button class="pill-btn sm blush" data-act="req-ack" data-id="${r.id}" data-s="onit">دارم میام</button>` : ''}<button class="pill-btn sm red" data-act="req-ack" data-id="${r.id}" data-s="done">انجام شد</button></div></div>`; }).join('')
      : `<p class="muted" style="font-size:14.5px">فعلاً درخواستی نداره. ${needs.length ? `امروز گفته لازم داره: ${needs.join('، ')}` : ''}</p>`}</div>`;
  html += `<div class="card"><div class="card-label">یه چیزی براش بذار</div><div class="give-grid">
    ${Object.entries(GIFT_KINDS).map(([k, v]) => `<button class="give" data-act="give" data-v="${k}">${glyph(v[1], v[2])}<span>${v[0]}</span></button>`).join('')}
    <button class="give special" data-act="give" data-v="surprise">${glyph('lock', '#7B5CD6')}<span>سورپرایز قفل‌دار</span><small>مثلاً روز اول پریودش باز بشه</small></button></div></div>`;
  if (idea) html += `<div class="card ${ph.card}"><div class="card-label">ایده‌ی امروز <span>${ph.name}</span></div><p style="font-size:15.5px">${idea}</p></div>`;
  html += kitCard(p);
  html += `<div class="card white"><div class="card-label">چیزهایی که براش گذاشتی <span>${fa(sent.length)}</span></div>${sent.length ? `<div class="gift-wall">${sent.slice(0, 20).map(giftCard).join('')}</div>` : '<p class="muted" style="font-size:14.5px">اولین یادداشت یا سورپرایز رو بفرست.</p>'}</div>`;
  html += notesCard();
  html += `<div class="center"><button class="text-link" style="color:var(--muted)" data-act="leave">قطع اتصال</button></div>`;
  return html;
}
// ---------- phone notifications ----------
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function pushCardHtml(inSheet) {
  if (!CLOUD || !CFG.vapidKey) return '';
  const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  if (P.pushOn && supported && Notification.permission === 'granted') return inSheet ? `<div class="card teal"><b style="font-weight:500">اعلان‌های گوشی روشنه</b><p class="data-meta">یادآورها و پیام‌ها حتی وقتی اپ بسته‌ست میان (معمولاً با چند دقیقه تأخیر).</p></div>` : '';
  if (!inSheet && (P.pushAskAt && Date.now() - P.pushAskAt < 3 * 86400000)) return '';
  if (!supported && isIOS() && !isStandalone()) return inSheet || !P.installSeen ? `<div class="card sky"><b style="font-weight:500">برای اعلان روی آیفون</b><p style="font-size:14px;color:var(--ink-2);margin-top:4px">اول Moon&Us رو از سافاری به صفحه‌ی اصلی اضافه کن (دکمه‌ی اشتراک، Add to Home Screen) و از همون آیکون بازش کن؛ بعد اینجا اعلان‌ها رو روشن کن.</p></div>` : '';
  if (!supported) return inSheet ? `<div class="card"><p style="font-size:14px;color:var(--ink-2)">این مرورگر اعلان پشتیبانی نمی‌کنه.</p></div>` : '';
  if (Notification.permission === 'denied') return inSheet ? `<div class="card peach"><p style="font-size:14px">اعلان‌ها در تنظیمات گوشی برای این اپ خاموشه. از تنظیمات گوشی روشنش کن.</p></div>` : '';
  const who = isHer() ? (Object.keys(S.partners || {}).length ? `و پیام‌های ${pname()}` : '') : `و درخواست‌های ${herN()}`;
  return `<div class="card sky push-card"><div class="row">${glyph('bell', '#E8A013')}<div style="flex:1"><b style="font-weight:500">اعلان‌ها رو روشن کن</b><div style="font-size:13.5px;color:var(--ink-2)">یادآورهای مهم ${who} حتی وقتی اپ بسته‌ست.</div></div></div>
    <div class="btn-row" style="margin-top:12px"><button class="pill-btn red sm" data-act="push-on">روشن کن</button>${inSheet ? '' : `<button class="pill-btn ghost sm" data-act="push-later">بعداً</button>`}</div></div>`;
}
async function enablePushFlow() {
  try {
    if (!('Notification' in window)) { toast(isIOS() ? 'اول اپ رو به صفحه‌ی اصلی اضافه کن و از اونجا بازش کن' : 'این مرورگر اعلان پشتیبانی نمی‌کنه'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('اجازه‌ی اعلان داده نشد'); render(); return; }
    const reg = await withTimeout(navigator.serviceWorker.ready, 8000);
    await withTimeout(Cloud.enablePush(ME.uid, CFG.vapidKey, reg), 20000);
    if (P.discreet) Cloud.setPushDiscreet(ME.uid, true).catch(() => {});
    P.pushOn = true; savePrefs(); uploadPushSchedule(true); toast('اعلان‌ها روشن شد'); render();
    if ($('.sheet')) remindersSheet();
  } catch (e) { console.error('push', e && (e.code || e.message)); toast('روشن کردن اعلان انجام نشد؛ دوباره امتحان کن'); }
}
let lastSchedule = '';
function uploadPushSchedule(force) {
  if (!CLOUD || !P.pushOn || !ME.uid || !ME.spaceId || screen !== 'app') return;
  let items = [];
  if (isHer()) {
    items = upcomingReminders(14).filter(r => r.type !== 'daily_checkin' || (S.reminders.daily_checkin || {}).on).map(r => ({ id: r.id, at: r.when.getTime(), body: reminderText(r) }));
    // locked surprises: tell her the morning they open
    for (const g of S.gifts || []) if (g.unlockAt && !g.openedAt && g.unlockAt >= toKey(todayDate())) { const d = fromKey(g.unlockAt); items.push({ id: 'unlock-' + g.id, at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0).getTime(), body: P.discreet ? DISCREET_TEXT : `یه سورپرایز از طرف ${g.fromName || pname()} امروز برات باز شد` }); }
  }
  const sig = JSON.stringify(items);
  if (!force && sig === lastSchedule) return;
  lastSchedule = sig;
  Cloud.savePushSchedule(ME.uid, items).catch(e => console.error('schedule', e && e.code));
}
function pushEvent(to, title, body, tag, route) {
  if (!CLOUD || !ME.spaceId) return;
  Cloud.addOutbox(ME.spaceId, { from: ME.uid, to, title: String(title).slice(0, 60), body: String(body).slice(0, 180), tag, url: './index.html#' + (route || 'cycle') }).catch(e => console.error('outbox', e && e.code));
}

function requestsBanner() {
  const act = activeRequests().filter(r => r.status === 'open'); if (!act.length) return '';
  const r = act[0]; const R = REQ_BY_ID[r.kind];
  return `<button class="req-banner ${r.kind === 'need_you' ? 'need' : ''}" data-act="go" data-r="us">${glyph(R[2], R[3])}<div><b>${herN()}: ${R[1]}</b><small>${ago(r.at)}${act.length > 1 ? `، و ${fa(act.length - 1)} درخواست دیگه` : ''}</small></div><span class="chev">${ic('chevL')}</span></button>`;
}
function giveSheet(kind) {
  const her = herN(); const p = predict(engineState());
  const nextStart = p.hasData && p.nextStart ? toKey(p.nextStart) : null;
  let body = '';
  if (kind === 'note') body = `<textarea class="input" id="g-text" maxlength="600" placeholder="هر چی از ته دلت می‌خوای بهش بگی…"></textarea>`;
  if (kind === 'compliment') body = `<div class="stack">${COMPLIMENTS.map((c, i) => `<button class="choice ${i === 0 ? 'on' : ''}" data-act="pick-one" data-v="${esc(c)}"><div><b>${c}</b></div><span class="radio"></span></button>`).join('')}</div><input type="hidden" id="g-text" value="${esc(COMPLIMENTS[0])}">`;
  if (kind === 'photo') body = `<label class="photo-drop" for="g-file"><span id="g-preview">${ic('plus')}<b>یه عکس انتخاب کن</b><small>خودکار کوچیک می‌شه</small></span></label><input type="file" id="g-file" accept="image/*" hidden><input class="input" id="g-text" maxlength="200" placeholder="یه جمله کنار عکس (اختیاری)" style="margin-top:10px">`;
  if (kind === 'coupon') body = `<div class="chips">${COUPONS.map((c, i) => `<button class="chip ${i === 0 ? 'on' : ''}" style="--c:#0E8A70" data-act="pick-coupon" data-v="${esc(c)}">${c}</button>`).join('')}</div><input class="input" id="g-title" maxlength="60" value="${esc(COUPONS[0])}" style="margin-top:10px"><input class="input" id="g-text" maxlength="200" placeholder="توضیح (اختیاری)" style="margin-top:8px">`;
  if (kind === 'song') body = `<input class="input ltr" id="g-url" placeholder="https://…  (اسپاتیفای، یوتیوب، ساندکلاد…)"><input class="input" id="g-title" maxlength="80" placeholder="اسم آهنگ" style="margin-top:8px"><input class="input" id="g-text" maxlength="200" placeholder="چرا این آهنگ؟ (اختیاری)" style="margin-top:8px">`;
  if (kind === 'surprise') body = `<div class="seg" id="g-type">${Object.entries(GIFT_KINDS).filter(([k]) => k !== 'compliment').map(([k, v], i) => `<button class="${i === 0 ? 'on' : ''}" data-act="seg" data-v="${k}">${v[0]}</button>`).join('')}</div>
    <textarea class="input" id="g-text" maxlength="600" placeholder="متن سورپرایز…" style="margin-top:10px"></textarea>
    <div class="field" style="margin-top:10px"><label>کی باز بشه؟</label><div class="stack">
      ${nextStart ? `<button class="choice on" data-act="pick-unlock" data-v="${nextStart}" data-l="روز اول پریود"><div><b>روز اول پریود بعدی</b><small>حدود ${Cal.dayMonth(fromKey(nextStart))}</small></div><span class="radio"></span></button>` : ''}
      <button class="choice ${nextStart ? '' : 'on'}" data-act="pick-unlock" data-v="custom"><div><b>یه تاریخ دیگه</b></div><span class="radio"></span></button></div>
      <input class="input ltr" type="date" id="g-date" min="${toKey(addDays(todayDate(), 1))}" value="${toKey(addDays(todayDate(), 7))}" style="margin-top:8px"></div>
    <input type="hidden" id="g-unlock" value="${nextStart || 'custom'}"><input type="hidden" id="g-unlock-label" value="${nextStart ? 'روز اول پریود' : ''}">`;
  openSheet(`${sheetHead(kind === 'surprise' ? 'سورپرایز قفل‌دار' : GIFT_KINDS[kind][0], `برای ${her}`)}<div class="sheet-body">${body}
    <button class="pill-btn red block" data-act="give-send" data-v="${kind}">فرستادن</button><p class="fine">${her} همون لحظه که اپ رو باز کنه می‌بینه.</p></div>`);
  if (kind === 'photo') $('#g-file').addEventListener('change', onPhotoPicked);
}
let pickedPhoto = null;
async function onPhotoPicked(e) {
  const f = e.target.files[0]; if (!f) return;
  try { pickedPhoto = await shrinkImage(f, 1024, 600000); $('#g-preview').innerHTML = `<img src="${pickedPhoto}" alt="">`; }
  catch (err) { toast('این عکس باز نشد'); }
}
function shrinkImage(file, maxSide, maxBytes) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width: w, height: h } = img; const k = Math.min(1, maxSide / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
      let q = 0.8, out = c.toDataURL('image/jpeg', q);
      while (out.length > maxBytes && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      out.length > maxBytes ? reject(new Error('too big')) : resolve(out);
    };
    img.onerror = reject; img.src = url;
  });
}

function statusCard() {
  const st = todayStatus();
  if (!st) return `<div class="card peach"><div class="row">${face(2, 44)}<div><b style="font-weight:500">${herN()} هنوز حال امروزش رو نگفته</b><div class="muted" style="font-size:13.5px">یه یادداشت مهربون بفرست</div></div></div></div>`;
  const needs = (st.needs || []).map(n => (NEEDS.find(x => x[0] === n) || [])[1]).filter(Boolean);
  return `<div class="card peach"><div class="card-label">حال امروز ${herN()}</div><div class="row">${face(st.mood != null ? st.mood : 2, 52)}<div><h3>${st.mood != null ? MOODS[st.mood] : ''}</h3>${st.text ? `<p style="color:var(--ink-2)">«${esc(st.text)}»</p>` : ''}</div></div>
    ${needs.length ? `<div class="card-label" style="margin-top:16px">امروز لازم داره</div><div class="chips">${needs.map(n => `<span class="chip static on" style="--c:var(--orange)">${n}</span>`).join('')}</div>` : ''}</div>`;
}
function notesCard() {
  const notes = (S.notes || []).slice(-50);
  const nameOf = n => n.from === 'her' ? herN() : esc((S.partners[n.uid] || {}).name || n.name || 'پارتنر');
  return `<div class="card white"><div class="card-label">یادداشت‌ها</div><div class="notes" id="notes">${notes.length ? notes.map(n => { const mine = n.uid === ME.uid; return `<div class="note ${mine ? 'mine' : 'theirs'}"><div>${esc(n.text)}</div><div class="meta"><span>${nameOf(n)}، ${Cal.short(new Date(n.at))}</span>${mine || isHer() ? `<button data-act="note-del" data-id="${n.id}">حذف</button>` : ''}</div></div>`; }).join('') : `<p class="muted" style="font-size:14.5px">یه جمله‌ی مهربون، یه یادآوری یا یه «دوستت دارم» بنویس.</p>`}</div>
    <div class="composer"><input class="input" id="note-new" maxlength="1000" placeholder="بنویس…"><button class="pill-btn red" data-act="note-add" aria-label="فرستادن">${ic('send')}</button></div></div>`;
}
function kitCard(p) {
  const items = S.kit.items || {}; const done = CARE_KIT.filter(c => items[c[0]]).length;
  const dn = p.hasData ? (p.lateDays > 0 ? 0 : p.daysToNext) : null;
  const sub = !p.hasData ? '' : p.inPeriod ? 'الان روزهای پریوده؛ همه چی آماده‌ست؟' : dn <= 5 ? `حدود ${fa(dn)} روز مونده؛ وقت آماده شدنه.` : `پریود بعدی ${relDays(dn)}.`;
  return `<div class="card"><div class="card-label">کیت مراقبت <span>${fa(done)} از ${fa(CARE_KIT.length)}</span></div>${sub ? `<p style="color:var(--ink-2);font-size:14.5px;margin:-4px 0 6px">${sub}</p>` : ''}
    ${CARE_KIT.map(([id, l]) => `<button class="check ${items[id] ? 'on' : ''}" data-act="kit" data-v="${id}"><span class="box">${items[id] ? ic('check') : ''}</span><span class="lbl">${l}</span></button>`).join('')}
    <button class="text-link" style="margin-top:10px" data-act="kit-reset">شروع دوباره برای چرخه‌ی بعد</button></div>`;
}

// =================================================================
// Menu, library, articles
// =================================================================
function viewMore() {
  const you = isHer(); const pr = S.profile; const m = mode();
  const row = (act, g, color, t, sub) => `<button class="list-row" data-act="${act}">${glyph(g, color)}<div class="main"><b>${t}</b>${sub ? `<small>${sub}</small>` : ''}</div><span class="chev">${ic('chevL')}</span></button>`;
  const onCount = Object.values(S.reminders || {}).filter(r => r && r.on).length;
  return `<div class="card white"><div class="row"><span class="avatar ${you ? 'her' : 'him'}" style="width:52px;height:52px;font-size:20px;border:0">${initial(you ? S.herName : ME.name)}</span><div style="flex:1;min-width:0"><b style="font-weight:500;font-size:17px">${esc(you ? S.herName : ME.name)}</b><div class="muted latin" style="font-size:13px;overflow:hidden;text-overflow:ellipsis">${esc(ME.email || (CLOUD ? '' : 'نسخه‌ی محلی'))}</div></div></div></div>
    ${you ? `<div class="card white"><div class="card-label">چرخه و ثبت</div>
      ${row('mode-sheet', MODES[m].glyph, MODES[m].color, 'حالت', MODES[m].name)}
      ${row('cycle-settings', 'cycle', '#0C7A92', 'تنظیمات چرخه و پیش‌بینی', `چرخه ${fa(pr.cycleLength)} روزه، ${fa(pr.horizon || 12)} چرخه پیش‌بینی`)}
      ${row('cats-sheet', 'sparkle', '#9A6CC6', 'دسته‌های ثبت', 'نمایش، پنهان کردن و ترتیب')}
      ${row('tags-sheet', 'tag', '#5A6B7B', 'برچسب‌های من', `${fa((S.tags || []).length)} برچسب`)}
      <div class="list-row">${glyph('pill', '#3B6FD8')}<div class="main"><b>قرص ضدبارداری</b><small>کارت روزانه و یادآور</small></div><label class="switch"><input type="checkbox" data-act="pill-toggle" ${pr.pill ? 'checked' : ''}><span></span></label></div>
      ${row('reminders-sheet', 'bell', '#E8A013', 'یادآورها', onCount ? `${fa(onCount)} فعال` : 'خاموش')}
      ${row('go-report', 'chart', '#E13336', 'گزارش برای پزشک', 'PDF از شش چرخه‌ی اخیر')}</div>` : ''}
    <div class="card white"><div class="card-label">برنامه</div>
      ${row('go-library', 'bulb', '#7B5CD6', 'دانستنی‌ها', P.showDrafts ? 'شامل پیش‌نویس‌ها' : 'فقط مطالب بازبینی‌شده')}
      ${row('look-sheet', 'sun', '#F26B1D', 'ظاهر و تقویم', `${P.calendar === 'persian' ? 'شمسی' : 'میلادی'}، ${P.theme === 'dark' ? 'تیره' : 'روشن'}`)}
      ${row('pin-sheet', 'lock', '#5A6B7B', 'قفل رمز', P.pin ? 'فعال' : 'غیرفعال')}
      ${you ? row('ics', 'chart', '#0E8FA8', 'افزودن به تقویم گوشی', 'پریودها، باروری و یادآورها') : ''}
      ${you ? row('backup', 'drops', '#0C7A92', 'خروجی گرفتن از اطلاعات', 'فایل JSON از همه‌ی ثبت‌ها و تنظیمات') : ''}
      ${CLOUD ? row('feedback-sheet', 'people', '#2D8FD5', 'پشتیبانی و بازخورد', '') : ''}</div>
    <div class="card white">${CLOUD ? `<button class="list-row" data-act="sign-out">${glyph('people', '#8D8781')}<div class="main"><b>خروج از حساب</b></div></button>` : ''}
      <button class="list-row" data-act="delete-account">${glyph('bolt', '#BD131F')}<div class="main"><b style="color:var(--red-deep)">حذف حساب و همه‌ی اطلاعات</b></div></button></div>
    <p class="fine">Moon&Us، ساخته‌شده برای دو نفر<br>پیش‌بینی‌ها تخمینی‌اند و جایگزین مشاوره‌ی پزشکی نیستند.</p>`;
}
function viewLibrary() {
  const visible = ARTICLES.filter(a => a.status === 'published' || P.showDrafts);
  const drafts = ARTICLES.filter(a => a.status !== 'published').length;
  return `<div><h1 class="page-title">دانستنی‌ها</h1><p class="page-lead" style="margin-top:4px">مطالب فقط بعد از بازبینی متخصص منتشر می‌شن.</p></div>
    <div class="card white"><div class="list-row"><div class="main"><b>نمایش پیش‌نویس‌های بازبینی‌نشده</b><small>${fa(drafts)} مطلب هنوز توسط متخصص بازبینی نشده و با برچسب مشخص نمایش داده می‌شه.</small></div><label class="switch"><input type="checkbox" data-act="show-drafts" ${P.showDrafts ? 'checked' : ''}><span></span></label></div></div>
    ${visible.length ? `<div class="card white">${visible.map((a, i) => `<a class="art-row" href="#article/${a.id}"><span class="art-num" style="background:${a.tint};color:var(--crimson)">${fa(i + 1)}</span><span><b>${a.title}</b><small>${fa(a.min)} دقیقه مطالعه${a.status !== 'published' ? '، پیش‌نویس' : ''}</small></span></a>`).join('')}</div>` : `<div class="card center"><p class="muted">هنوز مطلب بازبینی‌شده‌ای منتشر نشده.</p></div>`}`;
}
function viewArticle(id) {
  const a = ARTICLES.find(x => x.id === id);
  if (!a) return `<p class="muted">مطلب پیدا نشد.</p>`;
  if (a.status !== 'published' && !P.showDrafts) return `<div class="card"><p>این مطلب هنوز بازبینی نشده. برای دیدنش، «نمایش پیش‌نویس‌ها» رو در دانستنی‌ها روشن کن.</p><a class="text-link" href="#library">دانستنی‌ها ${ic('chevL')}</a></div>`;
  return `<article class="article">${a.status !== 'published' ? `<div class="card peach" style="margin-bottom:14px">${draftBadge()}<p style="font-size:14px;margin-top:6px;color:var(--ink-2)">این متن پیش‌نویسه و هنوز توسط متخصص سلامت بازبینی نشده.</p></div>` : ''}
    <h1>${a.title}</h1><p class="muted" style="font-size:13.5px;margin:6px 0 16px">${fa(a.min)} دقیقه مطالعه</p><div class="article-body">${a.body}</div>
    <div class="art-meta"><div>نویسنده: ${esc(a.author)}</div><div>بازبین: ${a.reviewer ? esc(a.reviewer) : 'هنوز بازبینی نشده'}</div><div>تاریخ بازبینی: ${a.reviewedAt ? esc(a.reviewedAt) : '–'}</div>
      ${a.sources.length ? `<div>منابع برای بازبین: ${a.sources.map(s => `<a href="${esc(s)}" target="_blank" rel="noopener" class="latin">${esc(s.replace(/^https?:\/\//, ''))}</a>`).join('، ')}</div>` : ''}</div></article>`;
}

// =================================================================
// Calendar export (.ics)
// =================================================================
function buildICS() {
  const p = predict(engineState()); const d8 = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const dt = d => `${d8(d)}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Moon&Us//FA', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Moon&Us'];
  const head = out.length;
  const ev = (id, lines) => out.push('BEGIN:VEVENT', `UID:${id}@moonandus`, `DTSTAMP:${stamp}`, ...lines, 'END:VEVENT');
  const T = s => P.discreet ? DISCREET_TEXT : s;
  if (p.hasData) p.future.slice(0, 6).forEach(c => {
    ev(`period-${d8(c.start)}`, [`DTSTART;VALUE=DATE:${d8(c.start)}`, `DTEND;VALUE=DATE:${d8(addDays(c.periodEnd, 1))}`, `SUMMARY:${T('پریود (تخمینی)')}`, 'TRANSP:TRANSPARENT']);
    if (c.ov && c.fertileEnd >= p.today && p.mode !== 'perimenopause') ev(`fertile-${d8(c.fertileStart)}`, [`DTSTART;VALUE=DATE:${d8(c.fertileStart)}`, `DTEND;VALUE=DATE:${d8(addDays(c.fertileEnd, 1))}`, `SUMMARY:${T('روزهای باروری (تخمینی)')}`, 'TRANSP:TRANSPARENT']);
  });
  for (const r of upcomingReminders(30)) ev(`rem-${r.id}`, [`DTSTART:${dt(r.when)}`, `DTEND:${dt(new Date(r.when.getTime() + 15 * 60000))}`, `SUMMARY:${reminderText(r)}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${reminderText(r)}`, 'TRIGGER:PT0M', 'END:VALARM']);
  if (out.length === head) return null;
  out.push('END:VCALENDAR'); return out.join('\r\n');
}

// =================================================================
// Lock
// =================================================================
let pinBuf = '';
function lockView() {
  return `<div class="lock">${logo()}<p class="muted">رمز رو وارد کن</p><div class="pin-dots" id="pin-dots">${[0, 1, 2, 3].map(i => `<i class="${i < pinBuf.length ? 'on' : ''}"></i>`).join('')}</div>
    <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="pin-key" data-v="${n}">${fa(n)}</button>`).join('')}<span></span><button data-act="pin-key" data-v="0">${fa(0)}</button><button data-act="pin-key" data-v="del" aria-label="پاک کردن">⌫</button></div>
    ${CLOUD ? `<button class="text-link" data-act="sign-out" style="color:var(--muted)">رمز یادم رفته (خروج و ورود دوباره)</button>` : ''}</div>`;
}

// =================================================================
// Actions
// =================================================================
function updateStatus(fn) {
  const k = toKey(todayDate());
  const cur = todayStatus() ? JSON.parse(JSON.stringify(S.status)) : { date: k, mood: null, needs: [], text: '' };
  cur.needs = cur.needs || []; fn(cur); cur.u = Date.now(); DB.status(cur);
}
const segValue = id => { const b = document.querySelector(`#${id} button.on`); return b ? b.dataset.v : null; };
let nextModeAfterPreg = 'period';
const A = {
  reload: () => location.reload(),
  go: el => { closeSheet(false); location.hash = el.dataset.r; },
  'go-report': () => { closeSheet(false); location.hash = 'report'; },
  'go-library': () => { closeSheet(false); location.hash = 'library'; },
  'to-auth': el => { authMode = el.dataset.mode; authError = ''; if (screen !== 'auth') authCtx = 'her'; if (!CLOUD) { onb = freshOnb(); screen = 'onboard'; } else screen = 'auth'; render(); },
  'auth-back': () => { authError = ''; screen = pendingInvite ? 'invite' : 'welcome'; render(); },
  'sign-out': () => signOut(),
  'invite-signup': () => { authCtx = 'partner'; authMode = 'signup'; authError = ''; screen = 'auth'; render(); },
  'invite-login': () => { authCtx = 'partner'; authMode = 'login'; authError = ''; screen = 'auth'; render(); },
  'invite-decline': () => { clearInvite(); screen = ME.uid ? (ME.spaceId ? 'app' : ME.role === 'her' ? 'onboard' : 'disconnected') : 'welcome'; render(); },
  'invite-accept': async () => { busy = true; render(); try { await acceptInvite(ME.name); } catch (e) { console.error('join', e && e.code); toast('اتصال انجام نشد. شاید لینک قبلاً استفاده شده.'); } busy = false; render(); },
  invite: async () => { busy = true; render(); try { await Cloud.createInvite(ME.spaceId, ME.uid, S.herName); } catch (e) { console.error('invite', e && e.code); toast('ساخت دعوت انجام نشد'); } busy = false; render(); },
  'invite-share': () => shareText(`${S.herName} تو رو به Moon&Us دعوت کرده تا چرخه‌اش رو با هم دنبال کنید:\n${inviteUrl(S.inviteCode)}`, 'دعوت به Moon&Us'),
  'invite-copy': async () => { if (await copyText(inviteUrl(S.inviteCode))) toast('لینک کپی شد'); },
  'invite-cancel': () => { const c = S.inviteCode; DB.space({ inviteCode: null }); if (CLOUD && c) Cloud.deleteInvite(c); },
  'remove-partner': el => { const x = S.partners[el.dataset.v] || {}; confirmSheet('قطع دسترسی', `${esc(x.name || 'این فرد')} دیگه هیچ اطلاعاتی از چرخه‌ات نمی‌بینه و درخواست‌هاش رد می‌شه. برای اتصال دوباره باید دوباره دعوتش کنی.`, 'remove-partner-yes', 'قطع دسترسی', `data-v="${el.dataset.v}"`); },
  'remove-partner-yes': el => { const uid = el.dataset.v; const partners = { ...S.partners }; delete partners[uid]; S.partners = partners; saveCache(); if (CLOUD) Cloud.removePartner(ME.spaceId, uid).catch(syncErr); closeSheet(); toast('دسترسی قطع شد'); },
  leave: () => confirmSheet('قطع اتصال', `دیگه چرخه‌ی ${herN()} رو نمی‌بینی، مگه اینکه دوباره دعوتت کنه.`, 'leave-yes', 'قطع اتصال'),
  'leave-yes': async () => { closeSheet(false); try { stopWatch(); await Cloud.leaveSpace(ME.spaceId, ME.uid); } catch (e) { console.error('leave', e && e.code); } ME.spaceId = null; screen = 'disconnected'; render(); },

  log: () => openLog(toKey(todayDate())),
  'open-log': el => openLog(el.dataset.k),
  'log-day': el => { if (el.disabled) return; sheetDay = el.dataset.k; refreshSheet(logSheetHtml(el.dataset.k)); },
  'log-clear': el => confirmSheet('پاک کردن ثبت‌های این روز', 'همه‌ی ثبت‌ها، یادداشت و اندازه‌گیری‌های این روز پاک می‌شن و پیش‌بینی‌ها دوباره محاسبه می‌شن.', 'log-clear-yes', 'پاک کن', `data-k="${el.dataset.k}"`),
  'log-clear-yes': el => { DB.setLog(el.dataset.k, null); closeSheet(); toast('پاک شد'); },
  'quick-period': () => { editLog(toKey(todayDate()), l => { l.period = 'medium'; }); toast('پریود امروز ثبت شد'); },
  tag: el => {
    const { k, c, v } = el.dataset; const C = CAT_BY_ID[c];
    editLog(k, l => { if (c === 'period') { l.period = l.period === v ? null : v; return; } const arr = l.tags[c] || []; l.tags[c] = arr.includes(v) ? arr.filter(x => x !== v) : (C.single ? [v] : [...arr, v]); });
    if (!el.dataset.inline) refreshSheet(logSheetHtml(k));
  },
  'pain-level': el => { const { k } = el.dataset; const v = +el.dataset.v; editLog(k, l => { l.painLevel = l.painLevel === v ? null : v; }); refreshSheet(logSheetHtml(k)); },
  'custom-tag': el => { const { k, v } = el.dataset; editLog(k, l => { const c = l.custom || []; l.custom = c.includes(v) ? c.filter(x => x !== v) : [...c, v]; }); refreshSheet(logSheetHtml(k)); },
  'tag-add': el => {
    const name = ($('#new-tag')?.value || '').trim().replace(/^#/, ''); if (!name) return;
    let tg = (S.tags || []).find(x => x.name === name);
    if (!tg) { tg = { id: 't' + Date.now().toString(36), name }; DB.settings({ tags: [...(S.tags || []), tg] }); }
    editLog(el.dataset.k, l => { const c = l.custom || []; if (!c.includes(tg.id)) l.custom = [...c, tg.id]; });
    refreshSheet(logSheetHtml(el.dataset.k));
  },
  'tags-sheet': () => tagsSheet(),
  'tag-rename': el => { const id = el.dataset.v; const name = ($('#tg-' + id)?.value || '').trim(); if (!name) return; DB.settings({ tags: S.tags.map(t => t.id === id ? { ...t, name } : t) }); toast('ذخیره شد'); },
  'tag-delete': el => {
    const id = el.dataset.v; const n = Object.values(S.logs).filter(l => (l.custom || []).includes(id)).length; const tg = S.tags.find(t => t.id === id);
    confirmSheet('حذف برچسب', n ? `«${esc(tg.name)}» در ${fa(n)} روز استفاده شده. با حذفش، از همه‌ی این روزها هم برداشته می‌شه. بقیه‌ی ثبت‌های اون روزها دست نمی‌خورن.` : `«${esc(tg.name)}» هنوز استفاده نشده.`, 'tag-delete-yes', 'حذف برچسب', `data-v="${id}"`);
  },
  'tag-delete-yes': el => {
    const id = el.dataset.v; const changes = {};
    for (const [k, l] of Object.entries(S.logs)) if ((l.custom || []).includes(id)) { const c = { ...l, custom: l.custom.filter(x => x !== id), u: Date.now() }; if (!c.custom.length) delete c.custom; changes[k] = c; }
    if (Object.keys(changes).length) DB.setLogs(changes);
    DB.settings({ tags: S.tags.filter(t => t.id !== id) }); tagsSheet(); toast('برچسب حذف شد');
  },
  'cat-help': el => { helpOpen = helpOpen === el.dataset.c ? null : el.dataset.c; if (sheetDay) refreshSheet(logSheetHtml(sheetDay)); },
  pill: () => editLog(toKey(todayDate()), l => { const m = l.tags.meds || []; l.tags.meds = m.includes('pill') ? m.filter(x => x !== 'pill') : [...m, 'pill']; }),
  'pill-toggle': el => DB.settings({ profile: { ...S.profile, pill: el.checked } }),

  'sheet-close': () => closeSheet(),
  'sheet-bg': (el, e) => { if (e.target === el) closeSheet(); },
  'phase-sheet': () => phaseSheet(),
  'mode-sheet': () => modeSheet(),
  'set-mode': el => {
    const v = el.dataset.v; if (v === mode()) return closeSheet();
    if (v === 'pregnancy') return pregSetupSheet();
    if (v === 'noperiod') return intervalSheet();
    setMode(v); closeSheet(); toast(`حالت «${MODES[v].name}» فعال شد`);
  },
  'preg-setup': () => pregSetupSheet(),
  'preg-start': () => {
    const ref = $('#preg-ref').value; if (!ref) return toast('تاریخ رو وارد کن');
    const due = $('#preg-due').value || toKey(addDays(fromKey(ref), 280));
    setMode('pregnancy', toKey(todayDate()), { pregnancy: { ref, due, start: toKey(todayDate()), end: null } });
    closeSheet(); toast('پیگیری بارداری شروع شد');
  },
  'preg-edit': () => pregSetupSheet(true),
  'preg-due-save': () => { const due = $('#preg-due').value; if (!due) return; DB.settings({ pregnancy: { ...S.pregnancy, due } }); closeSheet(); },
  'preg-end': () => { nextModeAfterPreg = 'period'; pregEndSheet(); },
  'pick-next-mode': el => { nextModeAfterPreg = el.dataset.v; el.parentElement.querySelectorAll('.choice').forEach(b => b.classList.toggle('on', b === el)); },
  seg: el => { el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); },
  'preg-end-save': () => {
    const end = $('#preg-end').value || toKey(todayDate()); const outcome = segValue('preg-outcome') || 'birth';
    const ended = { ...S.pregnancy, end, outcome };
    const next = toKey(addDays(fromKey(end), 1)); const from = next <= toKey(todayDate()) ? next : toKey(todayDate());
    const h = (S.modeHistory || []).filter(e => e.from !== from); h.push({ mode: nextModeAfterPreg, from }); h.sort((a, b) => (a.from < b.from ? -1 : 1));
    const extra = { modeHistory: h, pregnancy: null, pregHistory: [...(S.pregHistory || []), ended] };
    if (nextModeAfterPreg === 'noperiod') extra.intervals = [...(S.intervals || []), from];
    DB.settings(extra); closeSheet(); toast('ذخیره شد؛ تاریخچه‌ی بارداری حفظ شده');
  },
  'interval-new': () => intervalSheet(),
  'iv-quick': el => { const t = todayDate(); $('#iv-date').value = el.dataset.v === 'month' ? toKey(Cal.monthStart(t)) : toKey(t); },
  'interval-save': () => {
    const k = $('#iv-date').value; if (!k) return;
    const intervals = [...new Set([...(S.intervals || []), k])].sort();
    if (mode() !== 'noperiod') setMode('noperiod', toKey(todayDate()), { intervals }); else DB.settings({ intervals });
    closeSheet(); toast('بازه‌ی جدید شروع شد');
  },
  'cats-sheet': () => { catReturn = sheetDay; catsSheet(); },
  'cat-toggle': el => { const h = new Set(S.profile.hiddenCats); el.checked ? h.delete(el.dataset.c) : h.add(el.dataset.c); DB.settings({ profile: { ...S.profile, hiddenCats: [...h] } }); },
  'cat-move': el => {
    if (el.disabled) return; const ids = orderedCats(mode()).filter(c => c.id !== 'period').map(c => c.id);
    const i = ids.indexOf(el.dataset.c); const j = i + +el.dataset.d; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]]; DB.settings({ profile: { ...S.profile, catOrder: ['period', ...ids] } }); catsSheet();
  },
  'cats-done': () => { if (catReturn) { const k = catReturn; catReturn = null; openLog(k); } else closeSheet(); },
  'cycle-settings': () => cycleSettingsSheet(),
  'save-cycle': () => {
    const v = id => +$('#v-' + id).dataset.v; const name = $('#f-her').value.trim();
    const ovOn = $('#ov-on').checked;
    DB.settings({ profile: { ...S.profile, cycleLength: v('cycle'), periodLength: v('period'), luteal: v('luteal'), horizon: v('horizon'), hormonal: $('#hormonal').checked, avgOverride: ovOn ? { cycle: v('ovc'), period: v('ovp') } : { cycle: null, period: null } } });
    if (name && name !== S.herName) { DB.space({ herName: name }); if (CLOUD) Cloud.setUserDoc(ME.uid, { name }).catch(() => {}); }
    closeSheet(); toast('ذخیره شد؛ پیش‌بینی‌ها دوباره محاسبه شدن');
  },
  'cycle-exclude': el => { const k = el.dataset.k; const ex = new Set(S.profile.excludedCycles || []); ex.has(k) ? ex.delete(k) : ex.add(k); DB.settings({ profile: { ...S.profile, excludedCycles: [...ex] } }); },
  'cycle-compare': el => { const k = el.dataset.k; compareSel = compareSel.includes(k) ? compareSel.filter(x => x !== k) : [...compareSel.slice(-1), k]; render(); },
  'look-sheet': () => lookSheet(),
  pref: el => { P[el.dataset.k] = el.dataset.v; savePrefs(); applyPrefs(); lookSheet(); render(); },
  'show-drafts': el => { P.showDrafts = el.checked; savePrefs(); render(); },
  discreet: el => { P.discreet = el.checked; savePrefs(); scheduleReminders(); if (CLOUD && P.pushOn) Cloud.setPushDiscreet(ME.uid, P.discreet).catch(() => {}); },
  'push-on': () => enablePushFlow(),
  'push-later': () => { P.pushAskAt = Date.now(); savePrefs(); render(); },
  'pin-sheet': () => pinSheet(),
  'pin-set': () => { const v = toLatinDigits($('#pin-in').value.trim()); if (!/^\d{4}$/.test(v)) return toast('رمز باید ۴ رقم باشه'); P.pin = hashPin(v); savePrefs(); unlocked = true; try { sessionStorage.setItem('moonus.unlocked', '1'); } catch (e) {} closeSheet(); toast('قفل فعال شد'); },
  'pin-off': () => { P.pin = null; savePrefs(); closeSheet(); toast('قفل غیرفعال شد'); },
  'pin-key': el => {
    const v = el.dataset.v; if (v === 'del') pinBuf = pinBuf.slice(0, -1); else if (pinBuf.length < 4) pinBuf += v;
    if (pinBuf.length === 4) { const ok = hashPin(pinBuf) === P.pin; pinBuf = ''; if (ok) { unlocked = true; try { sessionStorage.setItem('moonus.unlocked', '1'); } catch (e) {} render(); return; } render(); $('#pin-dots')?.classList.add('shake'); return; }
    render();
  },
  num: el => { const { id, d, min, max } = el.dataset; const v = $('#v-' + id); const nv = Math.max(+min, Math.min(+max, +v.dataset.v + +d)); v.dataset.v = nv; v.querySelector('b').textContent = fa(nv); if (screen === 'onboard') { onb[id] = nv; if (id === 'birthYear') v.querySelector('span').textContent = `میلادی، حدود ${fa(new Date().getFullYear() - nv)} سال`; } },
  'reminders-sheet': () => remindersSheet(),
  'rem-on': el => { const id = el.dataset.id; DB.settings({ reminders: { ...S.reminders, [id]: { ...(S.reminders[id] || {}), on: el.checked } } }); remindersSheet(); },
  'notif-perm': async () => { try { await Notification.requestPermission(); } catch (e) {} remindersSheet(); scheduleReminders(); },
  'feedback-sheet': () => feedbackSheet(),
  'fb-send': async el => {
    const text = $('#fb-text').value.trim(); if (!text) return toast('چند کلمه بنویس');
    el.disabled = true;
    try { await Cloud.sendFeedback(ME.uid, { kind: segValue('fb-kind') || 'bug', text, email: $('#fb-email').checked ? ME.email : null, role: ME.role, app: 'web-1' }); closeSheet(); toast('پیامت ثبت شد، ممنون'); }
    catch (e) { el.disabled = false; toast('ارسال نشد؛ اتصال رو چک کن'); }
  },

  'cal-prev': () => { calAnchor = addDays(Cal.monthStart(calAnchor), -1); render(); },
  'cal-next': () => { calAnchor = addDays(Cal.monthDays(calAnchor).slice(-1)[0], 1); render(); },
  'cal-today': () => { calAnchor = todayDate(); calSel = toKey(todayDate()); render(); },
  'cal-edit': () => { calEdit = !calEdit; render(); },
  'cal-day': el => {
    const k = el.dataset.k; const d = fromKey(k);
    if (calEdit && isHer()) { if (d > todayDate()) return toast('روزهای آینده رو نمی‌شه ثبت کرد'); editLog(k, l => { l.period = BLEED.includes(l.period) ? null : 'medium'; }); return; }
    calSel = k; render();
  },
  'filter-add': () => filterSheet(),
  'filter-pick': el => { if (calFilters.length < 3 && !calFilters.includes(el.dataset.v)) calFilters.push(el.dataset.v); closeSheet(); },
  'filter-remove': el => { calFilters = calFilters.filter(x => x !== el.dataset.v); render(); },

  mood: el => updateStatus(st => { const i = +el.dataset.i; st.mood = st.mood === i ? null : i; }),
  need: el => updateStatus(st => { const v = el.dataset.v; st.needs = st.needs.includes(v) ? st.needs.filter(x => x !== v) : [...st.needs, v]; }),
  'status-clear': () => DB.status(null),
  kit: el => { const items = { ...(S.kit.items || {}) }; items[el.dataset.v] = !items[el.dataset.v]; DB.kit({ u: Date.now(), items }); },
  'kit-reset': () => DB.kit({ u: Date.now(), items: {} }),
  'note-add': () => { const inp = $('#note-new'); const text = inp.value.trim(); if (!text) return; inp.value = ''; DB.addNote(text); setTimeout(() => { const w = $('#notes'); if (w) w.scrollTop = w.scrollHeight; }, 300); },
  'note-del': el => DB.deleteNote(el.dataset.id),
  compose: () => composeSheet(),
  'compose-send': () => { const t = $('#compose-text').value.trim(); if (!t) return; DB.addNote(t); closeSheet(); toast('یادداشت فرستاده شد'); },

  'wheel-today': () => { if (WH.p) wheelSelect(WH.todayIdx, false); WH.selKey = null; },
  'wheel-hint-ok': () => { WH.showHint = false; P.wheelHintSeen = true; savePrefs(); render(); },
  'rep-opt': el => { rep[el.dataset.k] = el.checked; render(); },
  'rep-print': () => window.print(),
  ics: () => { const ics = buildICS(); if (!ics) return toast('هنوز چیزی برای افزودن به تقویم نیست'); download('moon-and-us.ics', ics, 'text/calendar'); toast('فایل تقویم دانلود شد؛ بازش کن تا اضافه بشه'); },
  backup: () => { download(`moon-and-us-${toKey(todayDate())}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), herName: S.herName, ...Object.fromEntries(SETTINGS_KEYS.map(k => [k, S[k]])), logs: S.logs }, null, 1), 'application/json'); toast('فایل دانلود شد'); },

  'delete-account': () => confirmSheet('حذف حساب', isHer() ? 'حساب و همه‌ی ثبت‌ها، یادداشت‌ها و اتصال‌ها برای همیشه پاک می‌شن و قابل برگشت نیستن. اگه می‌خوای، اول از اطلاعاتت خروجی بگیر.' : 'حسابت پاک می‌شه و اتصالت قطع می‌شه. این کار قابل برگشت نیست.', 'delete-yes', 'حذف برای همیشه'),
  'delete-yes': async () => {
    closeSheet(false);
    if (!CLOUD) { try { localStorage.removeItem(LOCAL_KEY); } catch (e) {} S = emptyState(); screen = 'welcome'; render(); return; }
    try {
      stopWatch();
      if (isHer() && ME.spaceId) await Cloud.deleteSpaceAll(ME.spaceId, S.inviteCode); else if (ME.spaceId) await Cloud.leaveSpace(ME.spaceId, ME.uid).catch(() => {});
      await Cloud.deleteUserDoc(ME.uid); await Cloud.deleteAuthUser();
      try { localStorage.removeItem(cacheKey()); } catch (e) {}
      S = emptyState(); ME = { uid: null, role: 'her' }; screen = 'welcome'; render(); toast('حساب حذف شد');
    } catch (e) { console.error('delete', e && e.code); toast(errMsg(e)); if (ME.spaceId) startWatch(); }
  },

  'onb-next': () => { if (onbSteps()[onb.step] === 'name') { onb.name = ($('#o-name')?.value || '').trim(); if (!onb.name) return toast('اسمت رو بنویس'); } onb.step = Math.min(onbSteps().length - 1, onb.step + 1); render(); },
  'onb-back': () => { if (onb.step === 0) return; onb.step--; render(); },
  'onb-pick': el => { onb.picked = el.dataset.k; onb.unknown = false; render(); },
  'onb-unknown': () => { onb.unknown = !onb.unknown; if (onb.unknown) onb.picked = null; render(); },
  'onb-account': el => { onb.account = el.dataset.v; onb.step = 1; render(); },
  'onb-consent': el => { onb.consent[el.dataset.v] = !onb.consent[el.dataset.v]; render(); },
  'onb-goal': el => {
    const v = el.dataset.v; let g = onb.goals.includes(v) ? onb.goals.filter(x => x !== v) : [...onb.goals, v];
    if (v === 'pregnant' && g.includes('pregnant')) g = g.filter(x => !['conceive', 'noperiod', 'meno'].includes(x));
    if (['conceive', 'noperiod', 'meno'].includes(v) && g.includes(v)) g = g.filter(x => x !== 'pregnant');
    onb.goals = g; const m = modeFromGoals(g); if (m !== onb.mode) { onb.mode = m; onb.picked = null; onb.unknown = false; } render();
  },
  'onb-skip': () => { onb.birthYear = null; onb.step++; render(); },
  'onb-contra': el => { onb.hormonal = el.dataset.v; render(); },
  'onb-join': () => joinWithCode(),
  'onb-notify-yes': async () => { try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch (e) {} finishOnboarding(); },
  'onb-done': () => finishOnboarding(),
  legal: el => openSheet(`${sheetHead(el.dataset.v === 'terms' ? 'شرایط استفاده' : 'حریم خصوصی')}<div class="sheet-body"><div class="card white article-body" style="font-size:15px">${el.dataset.v === 'terms' ? TERMS_HTML : PRIVACY_HTML}</div><button class="pill-btn red block" data-act="sheet-close">متوجه شدم</button></div>`),

  // ---- couple: hers ----
  request: el => {
    const v = el.dataset.v; const open = activeRequests().find(r => r.kind === v);
    if (open) { toast(`قبلاً فرستادی: ${REQ_STATUS[open.status]}`); return; }
    DB.addRequest(v); toast(v === 'need_you' ? `${pname()} همین الان خبردار می‌شه` : 'فرستاده شد');
  },
  'request-cancel': el => DB.deleteRequest(el.dataset.id),
  'gift-open': el => { const g = S.gifts.find(x => x.id === el.dataset.id); if (!g) return; if (!g.openedAt) DB.updateGift(g.id, { openedAt: Date.now() }); giftRevealSheet(g); },
  'gift-love': el => { const g = S.gifts.find(x => x.id === el.dataset.id); if (g && !g.reaction) DB.updateGift(g.id, { reaction: 'love' }); closeSheet(); },
  'coupon-use': el => { DB.updateGift(el.dataset.id, { redeemedAt: Date.now() }); toast(`${pname()} خبردار شد که می‌خوای از کوپن استفاده کنی`); },
  'sharing-sheet': () => sharingSheet(),
  // ---- couple: his ----
  'req-ack': el => { DB.updateRequest(el.dataset.id, { status: el.dataset.s, ackAt: Date.now() }); toast(el.dataset.s === 'done' ? 'عالی!' : 'بهش خبر دادیم'); },
  'gift-delete': el => DB.deleteGift(el.dataset.id),
  give: el => { pickedPhoto = null; giveSheet(el.dataset.v); },
  'pick-one': el => { el.parentElement.querySelectorAll('.choice').forEach(b => b.classList.toggle('on', b === el)); $('#g-text').value = el.dataset.v; },
  'pick-coupon': el => { el.parentElement.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b === el)); $('#g-title').value = el.dataset.v; },
  'pick-unlock': el => { el.parentElement.querySelectorAll('.choice').forEach(b => b.classList.toggle('on', b === el)); $('#g-unlock').value = el.dataset.v; $('#g-unlock-label').value = el.dataset.l || ''; },
  'give-send': el => {
    const kind = el.dataset.v; const val = id => ($('#' + id)?.value || '').trim();
    let g;
    if (kind === 'note' || kind === 'compliment') { if (!val('g-text')) return toast('یه چیزی بنویس'); g = { type: kind, text: val('g-text') }; }
    if (kind === 'photo') { if (!pickedPhoto) return toast('اول یه عکس انتخاب کن'); g = { type: 'photo', img: pickedPhoto, text: val('g-text') }; }
    if (kind === 'coupon') { if (!val('g-title')) return toast('عنوان کوپن رو بنویس'); g = { type: 'coupon', title: val('g-title'), text: val('g-text') }; }
    if (kind === 'song') { const u = val('g-url'); if (!/^https?:\/\//.test(u)) return toast('لینک باید با https شروع بشه'); g = { type: 'song', url: u, title: val('g-title'), text: val('g-text') }; }
    if (kind === 'surprise') {
      const type = segValue('g-type') || 'note'; if (!val('g-text')) return toast('متن سورپرایز رو بنویس');
      const u = val('g-unlock'); const unlockAt = u === 'custom' ? val('g-date') : u; if (!unlockAt) return toast('تاریخ باز شدن رو انتخاب کن');
      g = { type: type === 'coupon' ? 'coupon' : 'note', text: val('g-text'), unlockAt, unlockLabel: val('g-unlock-label') || null };
      if (type === 'coupon') g.title = val('g-text').slice(0, 60);
    }
    DB.addGift(g); pickedPhoto = null; closeSheet(); toast('فرستاده شد');
  },
  'install-now': async () => { if (deferredInstall) { deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) {} deferredInstall = null; } closeSheet(); },
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
  const el = e.target;
  if (el.dataset.rep) { rep[el.dataset.rep] = el.value; return; }
  if (el.dataset.rem) {
    clearTimeout(typeTimer); const id = el.dataset.id; const key = el.dataset.rem;
    typeTimer = setTimeout(() => { const v = key === 'days' ? Math.max(1, Math.min(10, +el.value || 1)) : el.value; DB.settings({ reminders: { ...S.reminders, [id]: { ...(S.reminders[id] || {}), [key]: v } } }); }, 500);
    return;
  }
  const kind = el.dataset.input; if (!kind) return;
  if (kind === 'log-search') { logSearch = el.value; if (sheetDay) refreshSheet(logSheetHtml(sheetDay)); return; }
  if (kind === 'filter-q') { const q = el.value.trim(); document.querySelectorAll('#filter-list .chip').forEach(c => { c.style.display = !q || c.dataset.label.includes(q) ? '' : 'none'; }); return; }
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => {
    const num = v => { const n = parseFloat(toLatinDigits(v).replace(/[٫,]/g, '.')); return isNaN(n) ? null : n; };
    if (kind === 'note') editLog(el.dataset.k, l => { const v = el.value.trim(); if (v) l.note = v; else delete l.note; });
    if (kind === 'temp') editLog(el.dataset.k, l => { const n = num(el.value); if (n != null && n > 34 && n < 43) l.temp = Math.round(n * 100) / 100; else delete l.temp; });
    if (kind === 'weight') editLog(el.dataset.k, l => { const n = num(el.value); if (n != null && n > 20 && n < 300) l.weight = Math.round(n * 10) / 10; else delete l.weight; });
    if (kind === 'status-text') updateStatus(st => { st.text = el.value.trim(); });
  }, 500);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'note-new') A['note-add']();
  if (e.key === 'Enter' && e.target.id === 'o-name') A['onb-next']();
  if (e.key === 'Escape' && $('.sheet')) closeSheet();
});

// =================================================================
// Add to home screen (after sign-in, once per device)
// =================================================================
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
function maybeInstallPrompt() {
  if (isStandalone() || P.installSeen || screen !== 'app' || $('.sheet')) return;
  P.installSeen = true; savePrefs();
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  const shareIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4px"><path d="M12 15V4M8 7.5l4-3.5 4 3.5"/><path d="M6 11v7.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V11"/></svg>`;
  const steps = ios
    ? `<ol class="install-steps"><li>پایین صفحه‌ی سافاری، دکمه‌ی اشتراک ${shareIcon} رو بزن.</li><li>«Add to Home Screen» یا «افزودن به صفحه‌ی اصلی» رو انتخاب کن.</li><li>«Add» رو بزن. حالا Moon&Us مثل یه اپ روی صفحه‌ی گوشیته.</li></ol>`
    : deferredInstall ? `<p style="color:var(--ink-2)">با یه لمس، Moon&Us مثل یه اپ روی صفحه‌ی گوشیت میاد؛ تمام‌صفحه، سریع‌تر و با اعلان.</p>`
      : `<ol class="install-steps"><li>منوی مرورگر (سه نقطه) رو باز کن.</li><li>«Install app» یا «Add to Home screen» رو بزن.</li></ol>`;
  openSheet(`${sheetHead('Moon&Us رو به گوشیت اضافه کن')}<div class="sheet-body"><div class="install-hero"><img src="icons/icon-192.png" alt="" width="72" height="72"><div><b>Moon&Us</b><small>همیشه یه لمس فاصله</small></div></div>
    <div class="card white">${steps}</div>
    ${deferredInstall && !ios ? `<button class="pill-btn red block" data-act="install-now">نصب</button>` : ''}<button class="pill-btn ghost block" data-act="sheet-close">بعداً</button>
    <p class="fine">بعد از نصب، یک بار دوباره وارد حسابت شو.</p></div>`);
}

// =================================================================
// Routing & boot
// =================================================================
function routeFromHash() { const h = location.hash.slice(1); return !h || h.startsWith('invite/') ? null : h; }
function readInviteFromHash() { const m = location.hash.match(/^#invite\/([a-z0-9]{6,20})$/); if (m) pendingInvite = { code: m[1], data: null }; }
window.addEventListener('hashchange', async () => {
  const m = location.hash.match(/^#invite\/([a-z0-9]{6,20})$/);
  if (m) {
    if (isHer() && ME.spaceId) { toast('این لینک دعوت برای کس دیگه‌ایه'); history.replaceState(null, '', '#cycle'); return; }
    pendingInvite = { code: m[1], data: null };
    if (CLOUD) { try { pendingInvite.data = await Cloud.getInvite(m[1]); } catch (e) {} }
    screen = 'invite'; render(); return;
  }
  if (screen !== 'app') return;
  route = routeFromHash() || 'cycle'; render(); window.scrollTo(0, 0);
});
let lastDay = toKey(todayDate());
setInterval(() => { const k = toKey(todayDate()); if (k !== lastDay) { lastDay = k; calSel = k; if (!$('.sheet')) render(); scheduleReminders(); } }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (toKey(todayDate()) !== lastDay) { lastDay = toKey(todayDate()); calSel = lastDay; render(); } tickReminders(); } });

async function boot() {
  render(); readInviteFromHash();
  if (!CLOUD) {
    loadCache(); ME = { uid: 'local', role: 'her', spaceId: 'local', name: S.herName, email: '' };
    if (FORCE_LOCAL && new URLSearchParams(location.search).get('as') === 'him') ME = { uid: 'local-him', role: 'partner', spaceId: 'local', name: 'میلاد', email: '' }; // dev preview of his side
    screen = S.onboarded ? 'app' : 'welcome'; route = routeFromHash() || 'cycle'; render(); scheduleReminders(); return;
  }
  try { Cloud = await import('./cloud.js'); await Cloud.init(CFG); } catch (e) { console.error('init', e && e.message); screen = 'error'; render(); return; }
  if (pendingInvite) { try { pendingInvite.data = await Cloud.getInvite(pendingInvite.code); } catch (e) { console.error('invite read', e && e.code); } }
  Cloud.onAuth(handleAuth);
}
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      if ('periodicSync' in reg) { try { await reg.periodicSync.register('moonus-reminders', { minInterval: 60 * 60 * 1000 }); } catch (e) {} }
    } catch (e) {}
  });
}
boot();
