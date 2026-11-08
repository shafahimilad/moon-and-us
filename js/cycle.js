/* Moon&Us — date helpers + cycle engine (no UI here) */

// ---------- dates ----------
const pad2 = n => String(n).padStart(2, '0');
const toKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const dayDiff = (a, b) => Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000); // b - a
const todayDate = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const sameDay = (a, b) => a && b && toKey(a) === toKey(b);

// Persian digits
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const fa = v => String(v).replace(/\d/g, d => FA_DIGITS[d]);
const toLatinDigits = s => String(s).replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

// ---------- calendar (Jalali or Gregorian via Intl) ----------
const Cal = {
  type: 'persian',
  _fmt: {},
  fmt(opts, key) {
    const k = this.type + key;
    if (!this._fmt[k]) this._fmt[k] = new Intl.DateTimeFormat(`fa-IR-u-ca-${this.type}-nu-arabext`, opts);
    return this._fmt[k];
  },
  parts(date) { // numeric {y,m,d} in the active calendar
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
  monthDays(date) { // array of Dates in the month that contains `date`
    const start = this.monthStart(date); const m = this.parts(start).m; const out = [];
    for (let i = 0; i < 32; i++) { const d = addDays(start, i); if (this.parts(d).m !== m) break; out.push(d); }
    return out;
  },
  weekIndex(date) { return (date.getDay() + 1) % 7; }, // Saturday = 0
  WEEKDAYS: ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'],
};

// ---------- cycle engine ----------
const BLEED = ['light', 'medium', 'heavy'];

function analyzeCycles(state) {
  const logs = state.logs || {};
  const prof = state.profile;
  const t = todayDate();
  const bleedKeys = Object.keys(logs).filter(k => BLEED.includes(logs[k].period) && fromKey(k) <= t).sort();

  // group bleeding days into periods (gaps of up to 2 days stay in the same period)
  const periods = [];
  for (const k of bleedKeys) {
    const last = periods[periods.length - 1];
    if (!last || dayDiff(fromKey(last.end), fromKey(k)) > 2) periods.push({ start: k, end: k });
    else last.end = k;
  }
  periods.forEach(p => { p.length = dayDiff(fromKey(p.start), fromKey(p.end)) + 1; });

  const cycles = [];
  for (let i = 0; i < periods.length - 1; i++) {
    cycles.push({
      start: periods[i].start,
      length: dayDiff(fromKey(periods[i].start), fromKey(periods[i + 1].start)),
      periodLength: periods[i].length,
    });
  }
  const recent = cycles.filter(c => c.length >= 15 && c.length <= 90).slice(-6);
  const avgCycle = recent.length ? Math.round(recent.reduce((a, c) => a + c.length, 0) / recent.length) : prof.cycleLength;

  // period length: completed periods only (ended 2+ days ago)
  const done = periods.filter(p => dayDiff(fromKey(p.end), t) >= 2).slice(-6);
  const avgPeriod = done.length ? Math.max(1, Math.min(12, Math.round(done.reduce((a, p) => a + p.length, 0) / done.length))) : prof.periodLength;

  const lens = recent.map(c => c.length);
  const variation = lens.length >= 2 ? Math.max(...lens) - Math.min(...lens) : null;

  return { periods, cycles, recentCycles: recent, avgCycle, avgPeriod, variation, lastPeriod: periods[periods.length - 1] || null };
}

function predict(state) {
  const a = analyzeCycles(state);
  const t = todayDate();
  const luteal = state.profile.luteal || 14;
  const res = { ...a, today: t, hasData: !!a.lastPeriod, future: [], dayMap: new Map() };
  if (!a.lastPeriod) return res;

  const lastStart = fromKey(a.lastPeriod.start);
  res.lastStart = lastStart;
  res.cycleDay = dayDiff(lastStart, t) + 1;
  const expected = addDays(lastStart, a.avgCycle);
  res.lateDays = Math.max(0, dayDiff(expected, t));
  // When late, assume the period may come any day now.
  const nextStart = res.lateDays > 0 ? addDays(t, 1) : expected;
  res.nextStart = nextStart;
  res.daysToNext = dayDiff(t, nextStart);

  // the current period (if ongoing) – predict its remaining days
  const inPeriod = res.cycleDay <= Math.max(a.avgPeriod, a.lastPeriod.length) && dayDiff(fromKey(a.lastPeriod.end), t) <= 1;
  res.inPeriod = inPeriod;
  const mark = (d, prop, val = true) => {
    const k = toKey(d); const o = res.dayMap.get(k) || {}; o[prop] = val; res.dayMap.set(k, o);
  };
  if (inPeriod) {
    for (let i = a.lastPeriod.length; i < a.avgPeriod; i++) {
      const d = addDays(lastStart, i); if (d > t) mark(d, 'predPeriod');
    }
  }

  // project 12 cycles forward. k=0 is the cycle that ends at nextStart.
  for (let k = 0; k < 12; k++) {
    const start = addDays(nextStart, k * a.avgCycle);       // period start that ends cycle k
    const cycleBegin = k === 0 ? lastStart : addDays(nextStart, (k - 1) * a.avgCycle);
    const ov = addDays(start, -luteal);
    const fertileStart = addDays(ov, -5), fertileEnd = addDays(ov, 1);
    const pmsStart = addDays(start, -5), pmsEnd = addDays(start, -1);
    const periodEnd = addDays(start, a.avgPeriod - 1);
    const ovValid = dayDiff(cycleBegin, ov) >= 6; // very short cycles: skip implausible ovulation
    res.future.push({ start, periodEnd, ov: ovValid ? ov : null, fertileStart: ovValid ? fertileStart : null, fertileEnd: ovValid ? fertileEnd : null, pmsStart, pmsEnd });
    for (let i = 0; i < a.avgPeriod; i++) mark(addDays(start, i), 'predPeriod');
    if (ovValid) {
      for (let d = fertileStart; d <= fertileEnd; d = addDays(d, 1)) mark(d, 'fertile');
      mark(ov, 'ovulation');
    }
    for (let d = pmsStart; d <= pmsEnd; d = addDays(d, 1)) mark(d, 'pms');
  }
  res.cur = res.future[0];
  res.phase = phaseOn(state, res, t);
  return res;
}

// Phase for a given day (today or future). Uses logs first, then predictions.
function phaseOn(state, p, date) {
  if (!p.hasData) return 'unknown';
  const k = toKey(date);
  const log = state.logs[k];
  if (log && BLEED.includes(log.period)) return 'period';
  if (sameDay(date, p.today)) {
    if (p.inPeriod) return 'period';
    if (p.lateDays > 0) return 'late';
  }
  const info = p.dayMap.get(k) || {};
  if (info.ovulation) return 'ovulation';
  if (info.fertile) return 'fertile';
  if (info.pms) return 'pms';
  if (info.predPeriod && date > p.today) return 'period';
  // between: decide follicular vs luteal by the cycle containing the date
  const cyc = p.future.find(c => date < c.start) || p.cur;
  if (cyc && cyc.ov) return date < cyc.ov ? 'follicular' : 'luteal';
  return 'follicular';
}

// Phase of a past day, judged against the actual cycle it belonged to.
function pastPhase(state, a, key) {
  const date = fromKey(key);
  const log = state.logs[key];
  if (log && BLEED.includes(log.period)) return 'period';
  const starts = a.periods.map(p => fromKey(p.start));
  let i = -1; for (let j = 0; j < starts.length; j++) if (starts[j] <= date) i = j;
  if (i < 0) return null;
  const start = starts[i];
  const next = starts[i + 1] || addDays(start, a.avgCycle);
  const fromStart = dayDiff(start, date);
  const toNext = dayDiff(date, next);
  if (fromStart < a.periods[i].length) return 'period';
  const luteal = state.profile.luteal || 14;
  const ov = addDays(next, -luteal);
  const dOv = dayDiff(ov, date);
  if (dOv >= -5 && dOv <= 1) return 'fertile';
  if (toNext >= 1 && toNext <= 5) return 'pms';
  return date < ov ? 'follicular' : 'luteal';
}

// "You might feel..." — symptoms that showed up around this point in past cycles
function anticipate(state, p, date = todayDate()) {
  if (!p.hasData || p.cycles.length < 2) return [];
  const a = p;
  const dFrom = dayDiff(p.lastStart, date);
  const dTo = p.nextStart ? dayDiff(date, p.nextStart) : null;
  const useEnd = dTo !== null && dTo <= 10 && dTo >= 0; // late-cycle symptoms align to the next period
  const counts = {};
  const considered = a.cycles.slice(-6);
  considered.forEach(c => {
    const s = fromKey(c.start);
    const seen = new Set();
    for (let off = -1; off <= 1; off++) {
      const target = useEnd ? addDays(s, c.length - dTo + off) : addDays(s, dFrom + off);
      if (useEnd ? (c.length - dTo + off < 0) : (dFrom + off < 0 || dFrom + off >= c.length)) continue;
      const log = state.logs[toKey(target)];
      if (!log || !log.tags) continue;
      for (const [cat, arr] of Object.entries(log.tags)) {
        if (['sex', 'meds', 'test', 'exercise', 'sleep'].includes(cat)) continue;
        for (const v of arr) seen.add(cat + ':' + v);
      }
    }
    seen.forEach(x => { counts[x] = (counts[x] || 0) + 1; });
  });
  const n = considered.length;
  return Object.entries(counts)
    .filter(([, c]) => c >= 2 && c / n >= 0.4)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 4)
    .map(([key, c]) => {
      const [cat, val] = key.split(':');
      const C = CAT_BY_ID[cat]; const item = C && C.items.find(i => i[0] === val);
      return item ? { cat, val, label: item[1], icon: C.icon, catName: C.name, count: c, of: n } : null;
    }).filter(Boolean);
}

// Which tags show up in which phase (for the insights table)
function phaseInsights(state, a) {
  const res = {}; const totals = { period: 0, follicular: 0, fertile: 0, luteal: 0, pms: 0 };
  for (const [k, log] of Object.entries(state.logs)) {
    if (!log.tags) continue;
    const ph = pastPhase(state, a, k); if (!ph || !(ph in totals)) continue;
    let any = false;
    for (const [cat, arr] of Object.entries(log.tags)) {
      if (!['pain', 'emotion', 'energy', 'craving', 'digestion', 'skin', 'mind', 'social'].includes(cat)) continue;
      for (const v of arr) {
        const id = cat + ':' + v;
        res[id] = res[id] || { period: 0, follicular: 0, fertile: 0, luteal: 0, pms: 0, total: 0 };
        res[id][ph]++; res[id].total++; any = true;
      }
    }
    if (any) totals[ph]++;
  }
  const rows = Object.entries(res).filter(([, r]) => r.total >= 2).sort((x, y) => y[1].total - x[1].total).slice(0, 10)
    .map(([id, r]) => {
      const [cat, val] = id.split(':'); const C = CAT_BY_ID[cat]; const item = C.items.find(i => i[0] === val);
      const top = ['period', 'follicular', 'fertile', 'luteal', 'pms'].reduce((b, ph) => r[ph] > r[b] ? ph : b, 'period');
      return { id, label: item ? item[1] : val, icon: C.icon, r, top };
    });
  return { rows, totals };
}

// fertility chance label (for "trying to conceive" mode)
function fertilityChance(p, date) {
  if (!p.hasData) return null;
  const c = p.future.find(x => x.ov && date <= addDays(x.ov, 1) && date >= addDays(x.ov, -5));
  if (!c) return { level: 'low', label: 'کم' };
  const d = dayDiff(date, c.ov);
  if (d >= 0 && d <= 2) return { level: 'high', label: 'زیاد' };
  return { level: 'mid', label: 'متوسط' };
}
