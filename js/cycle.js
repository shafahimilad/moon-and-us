/* =====================================================================
   Moon&Us — cycle engine (pure functions, no UI).
   Runs in the browser as a classic script (globals) and in Node for tests
   (module.exports at the bottom). Depends on CAT_BY_ID from content.js.

   Data model (state):
     state.logs[YYYY-MM-DD]  = observations the user recorded for that calendar day:
         { period?: 'spotting'|'light'|'medium'|'heavy', tags?: {catId: [optionId]},
           painLevel?: 1..3, temp?: number (BBT °C), weight?: number (kg),
           note?: string, custom?: [tagId], u: timestamp }
     state.profile           = { cycleLength, periodLength, luteal, horizon, hormonal,
                                 excludedCycles: [startKey], avgOverride: {cycle, period} }
     state.modeHistory       = [{ mode, from: YYYY-MM-DD }]  (mode in force from that day)
     state.pregnancy         = { ref, due, start, end, outcome } | null
     state.intervals         = [YYYY-MM-DD]  (tracking-without-period interval starts)
     state.ovObserved        = [YYYY-MM-DD]  (ovulation dates observed on another device; sharing)

   Observations (logs) are never modified here. Everything returned by predict()
   is an estimate and is recalculated from scratch on every call.

   Method (documented, not clinically validated):
     - A period = bleeding days (light/medium/heavy) grouped with gaps of ≤2 days.
       Spotting never starts a period. Bleeding recorded while the active mode is
       pregnancy or tracking-without-period is ignored for cycle maths.
     - A cycle = period start → next period start. Cycles crossing a pregnancy /
       no-period interval are not formed. Cycles <15 or >90 days are "outliers";
       cycles the user excluded are kept in history but skipped in averages.
     - Averages = mean of the last 6 included cycles. Prediction length = mean of
       the last 12 included cycles. Manual overrides replace either.
     - Irregularity: variation (max − min of last 12 included) > 9 days. Then the
       next start is shown as a range [last + shortest, last + longest].
     - Ovulation: observed if a positive ovulation test (day after the test) or a
       BBT thermal shift is found in the current cycle; otherwise estimated as
       next start − luteal length (default 14). Fertile window = ov−5 … ov+1.
       An observed ovulation also re-estimates the next start (ov + luteal) when
       that falls later than the length-based estimate.
     - No confidence percentages are produced.
   ===================================================================== */

// ---------- dates (local calendar days; never UTC) ----------
const pad2 = n => String(n).padStart(2, '0');
const toKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const dayDiff = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
const todayDate = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const sameDay = (a, b) => !!a && !!b && toKey(a) === toKey(b);

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const fa = v => String(v).replace(/\d/g, d => FA_DIGITS[d]);
const toLatinDigits = s => String(s).replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

// ---------- calendar formatting (Jalali or Gregorian via Intl) ----------
const Cal = {
  type: 'persian',
  _fmt: {},
  fmt(opts, key) {
    const k = this.type + key;
    if (!this._fmt[k]) this._fmt[k] = new Intl.DateTimeFormat(`fa-IR-u-ca-${this.type}-nu-arabext`, opts);
    return this._fmt[k];
  },
  parts(date) {
    const k = this.type + 'num';
    if (!this._fmt[k]) this._fmt[k] = new Intl.DateTimeFormat(`en-US-u-ca-${this.type}-nu-latn`, { year: 'numeric', month: 'numeric', day: 'numeric' });
    const p = this._fmt[k].formatToParts(date);
    const g = t => parseInt((p.find(x => x.type === t) || {}).value, 10);
    return { y: g('year') || g('relatedYear'), m: g('month'), d: g('day') };
  },
  dayMonth(date) { return this.fmt({ day: 'numeric', month: 'long' }, 'dm').format(date); },
  weekdayDayMonth(date) { return this.fmt({ weekday: 'long', day: 'numeric', month: 'long' }, 'wdm').format(date); },
  full(date) { return this.fmt({ day: 'numeric', month: 'long', year: 'numeric' }, 'full').format(date); },
  monthName(date) { return this.fmt({ month: 'long' }, 'mn').format(date); },
  year(date) { return fa(this.parts(date).y); },
  short(date) { return this.fmt({ day: 'numeric', month: 'short' }, 'sh').format(date); },
  monthStart(date) { return addDays(date, -(this.parts(date).d - 1)); },
  monthDays(date) {
    const start = this.monthStart(date); const m = this.parts(start).m; const out = [];
    for (let i = 0; i < 32; i++) { const d = addDays(start, i); if (this.parts(d).m !== m) break; out.push(d); }
    return out;
  },
  weekIndex(date) { return (date.getDay() + 1) % 7; }, // Saturday = 0
  WEEKDAYS: ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'],
};

const BLEED = ['light', 'medium', 'heavy'];
const CYCLE_MODES = ['period', 'conceive', 'perimenopause'];

// ---------- modes ----------
/** Mode in force on a given day key. History entries apply from their `from` date. */
function modeAt(state, key) {
  const h = (state.modeHistory || []).slice().sort((a, b) => (a.from < b.from ? -1 : 1));
  let m = (state.profile && state.profile.mode) && !h.length ? state.profile.mode : 'period';
  for (const e of h) if (e.from <= key) m = e.mode;
  return m;
}
const currentMode = (state, today = todayDate()) => modeAt(state, toKey(today));

// ---------- cycles ----------
function analyzeCycles(state, today = todayDate()) {
  const logs = state.logs || {};
  const prof = state.profile || {};
  const tKey = toKey(today);
  const bleedKeys = Object.keys(logs)
    .filter(k => k <= tKey && BLEED.includes(logs[k] && logs[k].period) && CYCLE_MODES.includes(modeAt(state, k)))
    .sort();

  const periods = [];
  for (const k of bleedKeys) {
    const last = periods[periods.length - 1];
    if (!last || dayDiff(fromKey(last.end), fromKey(k)) > 2) periods.push({ start: k, end: k });
    else last.end = k;
  }
  periods.forEach(p => { p.length = dayDiff(fromKey(p.start), fromKey(p.end)) + 1; });

  // mode switches that break cycle continuity
  const breaks = (state.modeHistory || []).filter(e => !CYCLE_MODES.includes(e.mode)).map(e => e.from);
  const excluded = new Set(prof.excludedCycles || []);
  const cycles = [];
  for (let i = 0; i < periods.length - 1; i++) {
    const a = periods[i].start, b = periods[i + 1].start;
    if (breaks.some(f => f > a && f <= b)) continue;
    const length = dayDiff(fromKey(a), fromKey(b));
    cycles.push({
      start: a, end: toKey(addDays(fromKey(b), -1)), length, periodLength: periods[i].length,
      outlier: length < 15 || length > 90, excluded: excluded.has(a),
    });
  }
  const included = cycles.filter(c => !c.outlier && !c.excluded);
  const last6 = included.slice(-6), last12 = included.slice(-12);
  const mean = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;

  const avgOver = prof.avgOverride || {};
  const avgCycleObserved = last6.length ? Math.round(mean(last6.map(c => c.length))) : null;
  const avgCycle = avgOver.cycle || avgCycleObserved || prof.cycleLength || 28;
  const predLen = avgOver.cycle || (last12.length ? Math.round(mean(last12.map(c => c.length))) : avgCycle);

  const donePeriods = periods.filter(p => dayDiff(fromKey(p.end), today) >= 2 && !excluded.has(p.start)).slice(-6);
  const avgPeriodObserved = donePeriods.length ? Math.max(1, Math.min(12, Math.round(mean(donePeriods.map(p => p.length))))) : null;
  const avgPeriod = avgOver.period || avgPeriodObserved || prof.periodLength || 5;

  const lens = last12.map(c => c.length);
  const variation = lens.length >= 2 ? Math.max(...lens) - Math.min(...lens) : null;
  const shortest = lens.length ? Math.min(...lens) : null;
  const longest = lens.length ? Math.max(...lens) : null;

  return {
    periods, cycles, included, recentCycles: last6,
    avgCycle, avgCycleObserved, predLen, avgPeriod, avgPeriodObserved,
    variation, shortest, longest,
    irregular: variation !== null && variation > 9,
    dataLevel: included.length === 0 ? 'none' : included.length < 3 ? 'low' : 'ok',
    lastPeriod: periods[periods.length - 1] || null,
  };
}

// ---------- BBT ----------
/** Temperatures between two keys (inclusive) as [{key, day, t}]. */
function bbtSeries(state, startKey, endKey) {
  const out = []; const s = fromKey(startKey);
  for (let d = s, i = 0; toKey(d) <= endKey && i < 120; d = addDays(d, 1), i++) {
    const l = state.logs && state.logs[toKey(d)];
    if (l && typeof l.temp === 'number') out.push({ key: toKey(d), day: i + 1, t: l.temp });
  }
  return out;
}
/** Classic 3-over-6 rule: three readings ≥0.2 °C above the max of the previous six.
    Returns the estimated ovulation key (day before the first high reading) or null. */
function detectBbtShift(series) {
  for (let i = 6; i + 2 < series.length; i++) {
    const base = Math.max(...series.slice(i - 6, i).map(x => x.t));
    if (series[i].t >= base + 0.2 && series[i + 1].t >= base + 0.2 && series[i + 2].t >= base + 0.2) {
      return { ovKey: toKey(addDays(fromKey(series[i].key), -1)), coverline: Math.round((base + 0.05) * 100) / 100, index: i };
    }
  }
  return null;
}

/** Observed ovulation in the current cycle, if any. */
function observedOvulation(state, startKey, today) {
  const tKey = toKey(today);
  const shared = (state.ovObserved || []).filter(k => k >= startKey && k <= tKey).sort();
  if (shared.length) return { key: shared[shared.length - 1], source: 'shared' };
  let test = null;
  for (let d = fromKey(startKey); toKey(d) <= tKey; d = addDays(d, 1)) {
    const l = state.logs && state.logs[toKey(d)];
    if (l && l.tags && (l.tags.test || []).includes('ovu_pos')) test = toKey(addDays(d, 1));
  }
  if (test) return { key: test, source: 'test' };
  const shift = detectBbtShift(bbtSeries(state, startKey, tKey));
  if (shift) return { key: shift.ovKey, source: 'bbt' };
  return null;
}

// ---------- predictions ----------
function predict(state, opts = {}) {
  const t = opts.today || todayDate();
  const a = analyzeCycles(state, t);
  const prof = state.profile || {};
  const luteal = prof.luteal || 14;
  const horizon = Math.max(1, Math.min(24, opts.horizon || prof.horizon || 12));
  const mode = currentMode(state, t);
  const res = { ...a, today: t, mode, hasData: !!a.lastPeriod && CYCLE_MODES.includes(mode), future: [], dayMap: new Map(), ovSource: null };
  if (mode === 'pregnancy') { res.pregnancy = pregnancyInfo(state, t); return res; }
  if (mode === 'noperiod') { res.interval = intervalInfo(state, t); return res; }
  if (!res.hasData) return res;

  const lastStart = fromKey(a.lastPeriod.start);
  res.lastStart = lastStart;
  res.cycleDay = dayDiff(lastStart, t) + 1;
  let expected = addDays(lastStart, a.predLen);

  const obs = observedOvulation(state, a.lastPeriod.start, t);
  if (obs) {
    res.ovSource = obs.source; res.ovObservedKey = obs.key;
    const byOv = addDays(fromKey(obs.key), luteal);
    if (byOv > expected) expected = byOv;
  } else res.ovSource = 'estimate';

  res.expectedStart = expected;
  res.lateDays = Math.max(0, dayDiff(expected, t));
  const nextStart = res.lateDays > 0 ? addDays(t, 1) : expected;
  res.nextStart = nextStart;
  res.daysToNext = dayDiff(t, nextStart);
  if (a.irregular && a.shortest && a.longest) {
    res.nextRange = [addDays(lastStart, a.shortest), addDays(lastStart, a.longest)];
  }
  res.confidence = a.dataLevel === 'none' ? 'insufficient' : a.irregular ? 'irregular' : a.dataLevel === 'low' ? 'low' : 'ok';

  res.inPeriod = res.cycleDay <= Math.max(a.avgPeriod, a.lastPeriod.length) && dayDiff(fromKey(a.lastPeriod.end), t) <= 1;
  const mark = (d, prop) => { const k = toKey(d); const o = res.dayMap.get(k) || {}; o[prop] = true; res.dayMap.set(k, o); };
  if (res.inPeriod) for (let i = a.lastPeriod.length; i < a.avgPeriod; i++) { const d = addDays(lastStart, i); if (d > t) mark(d, 'predPeriod'); }

  for (let k = 0; k < horizon; k++) {
    const start = addDays(nextStart, k * a.predLen);
    const cycleBegin = k === 0 ? lastStart : addDays(nextStart, (k - 1) * a.predLen);
    let ov = addDays(start, -luteal);
    let ovSource = 'estimate';
    if (k === 0 && obs) { ov = fromKey(obs.key); ovSource = obs.source; }
    const ovValid = dayDiff(cycleBegin, ov) >= 6;
    const c = {
      start, periodEnd: addDays(start, a.avgPeriod - 1),
      ov: ovValid ? ov : null, ovSource,
      fertileStart: ovValid ? addDays(ov, -5) : null, fertileEnd: ovValid ? addDays(ov, 1) : null,
      moreFertileStart: ovValid ? addDays(ov, -2) : null,
      pmsStart: addDays(start, -5), pmsEnd: addDays(start, -1),
    };
    res.future.push(c);
    for (let i = 0; i < a.avgPeriod; i++) mark(addDays(start, i), 'predPeriod');
    if (ovValid) {
      for (let d = c.fertileStart; d <= c.fertileEnd; d = addDays(d, 1)) mark(d, 'fertile');
      mark(ov, 'ovulation');
    }
    for (let d = c.pmsStart; d <= c.pmsEnd; d = addDays(d, 1)) mark(d, 'pms');
  }
  res.cur = res.future[0];
  res.phase = phaseOn(state, res, t);
  res.subphase = subphaseOn(state, res, t);
  return res;
}

function phaseOn(state, p, date) {
  if (!p.hasData) return 'unknown';
  const k = toKey(date); const log = state.logs && state.logs[k];
  if (log && BLEED.includes(log.period)) return 'period';
  if (sameDay(date, p.today)) { if (p.inPeriod) return 'period'; if (p.lateDays > 0) return 'late'; }
  const info = p.dayMap.get(k) || {};
  if (info.ovulation) return 'ovulation';
  if (info.fertile) return 'fertile';
  if (info.pms) return 'pms';
  if (info.predPeriod && date > p.today) return 'period';
  const cyc = p.future.find(c => date < c.start) || p.cur;
  if (cyc && cyc.ov) return date < cyc.ov ? 'follicular' : 'luteal';
  return 'follicular';
}

/** Six estimated subphases. Null when hormonal contraception is set, when the predicted
    cycle is shorter than 20 days, when the mode has no cycle, or when there is no data. */
function subphaseOn(state, p, date) {
  if (!p.hasData || (state.profile && state.profile.hormonal) || p.predLen < 20) return null;
  if (!['period', 'conceive'].includes(p.mode)) return null;
  if (p.lateDays > 0 && sameDay(date, p.today)) return null;
  const c = p.future.find(x => date < x.start) || p.cur; if (!c || !c.ov) return null;
  const begin = p.future.indexOf(c) === 0 ? p.lastStart : p.future[p.future.indexOf(c) - 1].start;
  const dFromStart = dayDiff(begin, date); const dOv = dayDiff(c.ov, date); const toNext = dayDiff(date, c.start);
  if (dFromStart < p.avgPeriod) return 'early_follicular';
  if (dOv < -2) return 'late_follicular';
  if (dOv <= 1) return 'ovulation';
  if (toNext <= 5) return 'late_luteal';
  if (dOv <= 5) return 'early_luteal';
  return 'mid_luteal';
}

/** Phase of a past day, judged against the actual cycle it belonged to. */
function pastPhase(state, a, key) {
  const date = fromKey(key);
  const log = state.logs && state.logs[key];
  if (log && BLEED.includes(log.period)) return 'period';
  const starts = a.periods.map(p => fromKey(p.start));
  let i = -1; for (let j = 0; j < starts.length; j++) if (starts[j] <= date) i = j;
  if (i < 0) return null;
  const start = starts[i]; const next = starts[i + 1] || addDays(start, a.avgCycle);
  const fromStart = dayDiff(start, date), toNext = dayDiff(date, next);
  if (fromStart < a.periods[i].length) return 'period';
  const ov = addDays(next, -((state.profile && state.profile.luteal) || 14));
  const dOv = dayDiff(ov, date);
  if (dOv >= -5 && dOv <= 1) return 'fertile';
  if (toNext >= 1 && toNext <= 5) return 'pms';
  return date < ov ? 'follicular' : 'luteal';
}

// ---------- pregnancy & intervals ----------
function pregnancyInfo(state, today = todayDate()) {
  const pg = state.pregnancy; if (!pg || !pg.ref) return null;
  const ref = fromKey(pg.ref);
  const due = pg.due ? fromKey(pg.due) : addDays(ref, 280);
  const days = dayDiff(ref, today);
  const week = Math.floor(days / 7), day = days % 7;
  const trimester = week < 14 ? 1 : week < 28 ? 2 : 3;
  return { ref, due, days, week, day, trimester, daysToDue: dayDiff(today, due), ended: !!pg.end };
}
function intervalInfo(state, today = todayDate()) {
  const tKey = toKey(today);
  const starts = (state.intervals || []).filter(k => k <= tKey).sort();
  if (!starts.length) return { current: null, intervals: [] };
  const intervals = starts.map((s, i) => ({ start: s, end: starts[i + 1] ? toKey(addDays(fromKey(starts[i + 1]), -1)) : tKey }));
  const cur = intervals[intervals.length - 1];
  return { current: cur, day: dayDiff(fromKey(cur.start), today) + 1, intervals };
}

// ---------- symptom patterns ----------
const PATTERN_CATS = ['pain', 'emotion', 'energy', 'craving', 'digestion', 'skin', 'mind', 'social', 'sleepq', 'vulva', 'urine', 'meno'];
function tagList(log) {
  const out = [];
  for (const [cat, arr] of Object.entries((log && log.tags) || {})) for (const v of arr || []) out.push(cat + ':' + v);
  return out;
}
function labelOf(id) {
  const [cat, val] = id.split(':'); const C = typeof CAT_BY_ID !== 'undefined' && CAT_BY_ID[cat];
  const it = C && C.items.find(i => i[0] === val);
  return { cat, val, label: it ? it[1] : val, color: C ? C.color : '#888', catName: C ? C.name : cat };
}

/** Symptoms that showed up around this point in previous cycles (default: last 6 cycles). */
function anticipate(state, p, date = todayDate(), opts = {}) {
  if (!p.hasData || p.cycles.length < 2) return [];
  const n = opts.cycles || 6; const only = opts.only || null;
  const dFrom = dayDiff(p.lastStart, date);
  const dTo = p.nextStart ? dayDiff(date, p.nextStart) : null;
  const useEnd = dTo !== null && dTo <= 10 && dTo >= 0;
  const considered = p.cycles.filter(c => !c.outlier && !c.excluded).slice(-n);
  if (considered.length < 2) return [];
  const counts = {};
  considered.forEach(c => {
    const s = fromKey(c.start); const seen = new Set();
    for (let off = -1; off <= 1; off++) {
      const idx = useEnd ? c.length - dTo + off : dFrom + off;
      if (idx < 0 || idx >= c.length) continue;
      const log = state.logs[toKey(addDays(s, idx))]; if (!log) continue;
      for (const id of tagList(log)) {
        const cat = id.split(':')[0];
        if (only ? only.includes(id) : PATTERN_CATS.includes(cat)) seen.add(id);
      }
    }
    seen.forEach(x => { counts[x] = (counts[x] || 0) + 1; });
  });
  const k = considered.length;
  return Object.entries(counts).filter(([, c]) => c >= 2 && c / k >= 0.4).sort((x, y) => y[1] - x[1]).slice(0, 5)
    .map(([id, c]) => ({ id, ...labelOf(id), count: c, of: k }));
}

/** Pain predictions (cramps, headache, back pain, breast tenderness) from the last 3–4 cycles:
    the next date range in the upcoming cycle where the symptom recurred. */
const PAIN_IDS = ['pain:cramps', 'pain:headache', 'pain:back', 'pain:breasts'];
function painPredictions(state, p) {
  if (!p.hasData) return [];
  const cycles = p.cycles.filter(c => !c.outlier && !c.excluded).slice(-4);
  if (cycles.length < 3) return PAIN_IDS.map(id => ({ id, ...labelOf(id), status: 'insufficient', cyclesUsed: cycles.length }));
  return PAIN_IDS.map(id => {
    const offsets = []; let hits = 0;
    for (const c of cycles) {
      const s = fromKey(c.start); let any = false;
      for (let i = 0; i < c.length; i++) {
        const l = state.logs[toKey(addDays(s, i))];
        if (l && tagList(l).includes(id)) { any = true; offsets.push(i - c.length); } // relative to next start
      }
      if (any) hits++;
    }
    if (hits < Math.ceil(cycles.length / 2)) return { id, ...labelOf(id), status: 'no-pattern', cyclesUsed: cycles.length, hits };
    // most common relative window (days before / after next period start)
    offsets.sort((a, b) => a - b);
    const lo = offsets[Math.floor(offsets.length * 0.2)], hi = offsets[Math.floor(offsets.length * 0.8)];
    const base = p.nextStart; // next period start
    let from = addDays(base, lo), to = addDays(base, hi);
    // symptoms recorded during the period itself (offset ≥ −0 relative to the *current* cycle start)
    const periodOffsets = []; for (const c of cycles) { const s = fromKey(c.start); for (let i = 0; i < Math.min(c.length, 8); i++) { const l = state.logs[toKey(addDays(s, i))]; if (l && tagList(l).includes(id)) periodOffsets.push(i); } }
    if (periodOffsets.length > offsets.length / 2) { periodOffsets.sort((a, b) => a - b); from = addDays(base, periodOffsets[0]); to = addDays(base, periodOffsets[periodOffsets.length - 1]); }
    return { id, ...labelOf(id), status: 'ok', from, to, cyclesUsed: cycles.length, hits };
  });
}

/** Phase distribution of tracked experiences (past, completed and current cycles). */
function phaseInsights(state, a) {
  const res = {}; const totals = { period: 0, follicular: 0, fertile: 0, luteal: 0, pms: 0 };
  for (const [k, log] of Object.entries(state.logs || {})) {
    const ph = pastPhase(state, a, k); if (!ph || !(ph in totals)) continue;
    let any = false;
    for (const id of tagList(log)) {
      if (!PATTERN_CATS.includes(id.split(':')[0])) continue;
      res[id] = res[id] || { period: 0, follicular: 0, fertile: 0, luteal: 0, pms: 0, total: 0 };
      res[id][ph]++; res[id].total++; any = true;
    }
    if (any) totals[ph]++;
  }
  const rows = Object.entries(res).filter(([, r]) => r.total >= 2).sort((x, y) => y[1].total - x[1].total).slice(0, 10)
    .map(([id, r]) => ({ id, ...labelOf(id), r, top: ['period', 'follicular', 'fertile', 'luteal', 'pms'].reduce((b, ph) => (r[ph] > r[b] ? ph : b), 'period') }));
  return { rows, totals };
}

/** Recurring patterns by cycle day: for each experience, in how many included cycles it was
    recorded on each cycle day. Missing days are "not recorded", never "absent". */
function symptomByCycleDay(state, a, opts = {}) {
  const cycles = a.cycles.filter(c => !c.outlier && !c.excluded).slice(-(opts.cycles || 6));
  const maxDay = Math.min(opts.maxDay || 40, Math.max(0, ...cycles.map(c => c.length)));
  const grid = {};
  for (const c of cycles) {
    const s = fromKey(c.start);
    for (let i = 0; i < Math.min(c.length, maxDay); i++) {
      const l = state.logs[toKey(addDays(s, i))]; if (!l) continue;
      for (const id of tagList(l)) {
        if (opts.cats && !opts.cats.includes(id.split(':')[0])) continue;
        grid[id] = grid[id] || new Array(maxDay).fill(0); grid[id][i]++;
      }
    }
  }
  const rows = Object.entries(grid).map(([id, arr]) => ({ id, ...labelOf(id), arr, total: arr.reduce((s, x) => s + x, 0) }))
    .filter(r => r.total >= 2).sort((x, y) => y.total - x.total).slice(0, opts.limit || 8);
  return { rows, cycles: cycles.length, maxDay, range: cycles.length ? [cycles[0].start, cycles[cycles.length - 1].end] : null };
}

/** Experiences recorded on the same days as a given experience (co-occurrence, not causation). */
function coOccurrence(state, id, limit = 3) {
  let days = 0; const counts = {};
  for (const log of Object.values(state.logs || {})) {
    const tags = tagList(log); if (!tags.includes(id)) continue; days++;
    for (const o of tags) if (o !== id) counts[o] = (counts[o] || 0) + 1;
  }
  return { days, items: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([o, c]) => ({ id: o, ...labelOf(o), count: c })) };
}

/** Sleep (duration + quality) recorded per phase. */
function sleepByPhase(state, a) {
  const out = {};
  for (const [k, log] of Object.entries(state.logs || {})) {
    const ids = tagList(log).filter(x => x.startsWith('sleep:') || x.startsWith('sleepq:')); if (!ids.length) continue;
    const ph = pastPhase(state, a, k); if (!ph) continue;
    out[ph] = out[ph] || {}; ids.forEach(id => { out[ph][id] = (out[ph][id] || 0) + 1; });
  }
  return out;
}

/** Bleeding intensity per day for a period (observations only). */
const FLOW_LEVEL = { spotting: 0.5, light: 1, medium: 2, heavy: 3 };
function periodFlow(state, period) {
  const out = []; const s = fromKey(period.start);
  for (let i = 0; i < period.length + 1; i++) { const l = state.logs[toKey(addDays(s, i))]; out.push(l && l.period ? FLOW_LEVEL[l.period] : 0); }
  return out;
}

// ---------- doctor's report selection ----------
/** Most recent six completed cycles, skipping user-hidden ones (older cycles fill the set).
    Cycles > 90 days stay in stats/history but are excluded from the trend visualisation.
    Heatmap: experiences recorded ≥3 times; excludes notes, meds, tests (except ovulation
    tests), weight and temperature. */
const REPORT_EXCLUDED_CATS = ['meds', 'supp', 'sex'];
function reportData(state, today = todayDate()) {
  const a = analyzeCycles(state, today);
  const completed = a.cycles.filter(c => !c.excluded);
  const six = completed.slice(-6);
  const trend = six.filter(c => c.length <= 90);
  const statsSet = six.filter(c => c.length >= 15);
  const mean = arr => arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length * 10) / 10 : null;
  const stats = {
    cycles: six.length,
    avgCycle: mean(statsSet.map(c => c.length)),
    avgPeriod: mean(six.map(c => c.periodLength)),
    shortest: statsSet.length ? Math.min(...statsSet.map(c => c.length)) : null,
    longest: statsSet.length ? Math.max(...statsSet.map(c => c.length)) : null,
  };
  const counts = {};
  const inRange = k => six.length && k >= six[0].start && k <= six[six.length - 1].end;
  for (const [k, log] of Object.entries(state.logs || {})) {
    if (!inRange(k)) continue;
    for (const id of tagList(log)) {
      const [cat, val] = id.split(':');
      if (REPORT_EXCLUDED_CATS.includes(cat)) continue;
      if (cat === 'test' && !['ovu_pos', 'ovu_neg'].includes(val)) continue;
      counts[id] = (counts[id] || 0) + 1;
    }
  }
  const heatIds = Object.entries(counts).filter(([, c]) => c >= 3).sort((x, y) => y[1] - x[1]).map(([id]) => id);
  const heat = heatIds.map(id => ({ id, ...labelOf(id), byCycle: six.map(c => {
    const s = fromKey(c.start); const days = [];
    for (let i = 0; i < c.length; i++) { const l = state.logs[toKey(addDays(s, i))]; if (l && tagList(l).includes(id)) days.push(i + 1); }
    return days;
  }) }));
  return { cycles: six, trend, stats, heat, insufficient: six.length === 0, hiddenCount: a.cycles.filter(c => c.excluded).length };
}

// ---------- sharing projection ----------
/** What a connected viewer may see: observed period days and the settings needed to run the
    same engine (so period / fertile / ovulation / PMS days match). No symptoms, feelings,
    pain, notes, tags, tests, temperatures or weights. Paused during pregnancy. */
function sharedProjection(state, today = todayDate()) {
  const mode = currentMode(state, today);
  if (mode === 'pregnancy') return { v: 1, paused: true, mode: 'paused', updatedAt: Date.now() };
  const a = analyzeCycles(state, today);
  const bleedDays = [];
  a.periods.slice(-14).forEach(p => { for (let d = fromKey(p.start); toKey(d) <= p.end; d = addDays(d, 1)) if (state.logs[toKey(d)] && BLEED.includes(state.logs[toKey(d)].period)) bleedDays.push(toKey(d)); });
  const p = predict(state, { today });
  const prof = state.profile || {};
  return {
    v: 1, paused: false, mode, updatedAt: Date.now(), bleedDays,
    ovObserved: p.ovObservedKey && p.ovSource !== 'estimate' ? [p.ovObservedKey] : [],
    engine: { cycleLength: prof.cycleLength || 28, periodLength: prof.periodLength || 5, luteal: prof.luteal || 14, horizon: prof.horizon || 12, excludedCycles: prof.excludedCycles || [], avgOverride: prof.avgOverride || {}, hormonal: !!prof.hormonal },
  };
}
/** Rebuilds a minimal engine state from a projection (viewer side). */
function stateFromProjection(proj) {
  const logs = {}; (proj.bleedDays || []).forEach(k => { logs[k] = { period: 'medium' }; });
  return { logs, profile: { ...(proj.engine || {}) }, modeHistory: [{ mode: proj.mode === 'paused' ? 'pregnancy' : (proj.mode || 'period'), from: '1900-01-01' }], ovObserved: proj.ovObserved || [] };
}

// ---------- reminders ----------
/** Upcoming reminder occurrences in local time. Period/fertility/phase/stat reminders are
    suspended during pregnancy and when there is no cycle data. Ids are type+date (dedup). */
const PAUSED_IN_PREGNANCY = ['period_soon', 'period_due', 'period_late', 'fertile_soon', 'phase_change', 'stats_change'];
function computeReminders(state, settings, opts = {}) {
  const today = opts.today || todayDate(); const days = opts.days || 14;
  const p = opts.p || predict(state, { today });
  const out = []; const S = settings || {};
  const mode = currentMode(state, today);
  const at = (d, time) => { const [h, m] = (time || '09:00').split(':').map(Number); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m); };
  const push = (type, d, extra = {}) => {
    const cfg = S[type]; if (!cfg || !cfg.on) return;
    if (mode === 'pregnancy' && PAUSED_IN_PREGNANCY.includes(type)) return;
    if (d < today || dayDiff(today, d) > days) return;
    out.push({ id: `${type}:${toKey(d)}`, type, date: toKey(d), when: at(d, type === 'daily_checkin' ? '20:00' : cfg.time), ...extra });
  };
  for (let i = 0; i <= days; i++) {
    const d = addDays(today, i);
    push('daily_checkin', d);
    if (state.profile && state.profile.pill) push('pill', d);
  }
  if (p.hasData) {
    p.future.slice(0, 3).forEach((c, idx) => {
      const before = (S.period_soon && S.period_soon.days) || 2;
      push('period_soon', addDays(c.start, -before), { daysBefore: before });
      if (!(idx === 0 && p.lateDays > 0)) push('period_due', c.start);
      if (c.fertileStart && ['period', 'conceive'].includes(mode)) push('fertile_soon', addDays(c.fertileStart, -1));
    });
    if (p.expectedStart) { const late = (S.period_late && S.period_late.days) || 2; push('period_late', addDays(p.expectedStart, late), { daysLate: late }); }
    if (S.phase_change && S.phase_change.on) {
      for (let i = 1; i <= days; i++) {
        const d = addDays(today, i), prev = addDays(d, -1);
        const s1 = subphaseOn(state, p, prev), s2 = subphaseOn(state, p, d);
        if (s2 && s1 !== s2) push('phase_change', d, { subphase: s2 });
      }
    }
  }
  return out.sort((x, y) => x.when - y.when);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pad2, toKey, fromKey, addDays, dayDiff, todayDate, sameDay, fa, toLatinDigits, Cal, BLEED,
    modeAt, currentMode, analyzeCycles, bbtSeries, detectBbtShift, observedOvulation, predict, phaseOn,
    subphaseOn, pastPhase, pregnancyInfo, intervalInfo, anticipate, painPredictions, phaseInsights,
    symptomByCycleDay, coOccurrence, sleepByPhase, periodFlow, reportData, sharedProjection,
    stateFromProjection, computeReminders, PAUSED_IN_PREGNANCY, tagList,
  };
}
