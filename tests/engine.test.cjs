// Engine tests: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEngine() {
  const ctx = { console, Intl, Date, Math };
  vm.createContext(ctx);
  const root = path.join(__dirname, '..', 'js');
  const src = fs.readFileSync(path.join(root, 'content.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'cycle.js'), 'utf8')
    + '\nthis.E = { toKey, fromKey, addDays, dayDiff, analyzeCycles, predict, modeAt, subphaseOn, pregnancyInfo, intervalInfo, anticipate, painPredictions, symptomByCycleDay, coOccurrence, reportData, sharedProjection, stateFromProjection, computeReminders, detectBbtShift, bbtSeries };';
  vm.runInContext(src, ctx);
  return ctx.E;
}
const E = loadEngine();
const K = (y, m, d) => E.toKey(new Date(y, m - 1, d));
const D = (y, m, d) => new Date(y, m - 1, d);

/** Build a state with periods starting at the given keys (5 bleeding days each). */
function stateWith(starts, extra = {}) {
  const logs = {};
  for (const s of starts) for (let i = 0; i < 5; i++) logs[E.toKey(E.addDays(E.fromKey(s), i))] = { period: i < 2 ? 'heavy' : 'medium', u: 1 };
  return { logs, profile: { cycleLength: 28, periodLength: 5, luteal: 14 }, modeHistory: [], ...extra };
}
function starts(from, lengths) { const out = [from]; let d = E.fromKey(from); for (const l of lengths) { d = E.addDays(d, l); out.push(E.toKey(d)); } return out; }

test('no data: no fabricated predictions', () => {
  const p = E.predict({ logs: {}, profile: { cycleLength: 28 } }, { today: D(2026, 11, 8) });
  assert.equal(p.hasData, false);
  assert.equal(p.future.length, 0);
});

test('single period uses the profile length and reports insufficient data', () => {
  const s = stateWith([K(2026, 11, 1)]);
  const p = E.predict(s, { today: D(2026, 11, 8) });
  assert.equal(p.hasData, true);
  assert.equal(E.toKey(p.nextStart), K(2026, 11, 29));
  assert.equal(p.confidence, 'insufficient');
});

test('averages use last 6 included cycles; predictions use last 12; not fixed at 28', () => {
  const st = starts(K(2025, 1, 1), [30, 30, 30, 30, 30, 30, 32, 32, 32, 32, 32, 32]);
  const s = stateWith(st);
  const today = E.addDays(E.fromKey(st[st.length - 1]), 3);
  const p = E.predict(s, { today });
  assert.equal(p.avgCycle, 32);       // last 6
  assert.equal(p.predLen, 31);        // last 12
  assert.equal(E.dayDiff(E.fromKey(st[st.length - 1]), p.nextStart), 31);
});

test('editing history recalculates (adding an earlier period changes the average)', () => {
  const st = starts(K(2026, 6, 1), [30, 30]);
  const s = stateWith(st);
  const today = D(2026, 8, 10);
  const before = E.predict(s, { today }).avgCycle;
  // correct history: the second period actually started 4 days later
  for (let i = 0; i < 5; i++) delete s.logs[E.toKey(E.addDays(E.fromKey(st[1]), i))];
  for (let i = 0; i < 5; i++) s.logs[E.toKey(E.addDays(E.fromKey(st[1]), 4 + i))] = { period: 'medium', u: 2 };
  const after = E.predict(s, { today }).avgCycle;
  assert.equal(before, 30);
  assert.equal(after, 30); // 34 + 26 → 30, but individual cycles changed:
  const a = E.analyzeCycles(s, today);
  assert.equal(JSON.stringify(a.cycles.map(c => c.length)), "[34, 26]".replace(/ /g, ""));
});

test('irregular cycles produce a date range instead of a single precise date', () => {
  const st = starts(K(2026, 1, 1), [24, 38, 27, 41, 25]);
  const s = stateWith(st);
  const p = E.predict(s, { today: E.addDays(E.fromKey(st[st.length - 1]), 2) });
  assert.equal(p.irregular, true);
  assert.equal(p.confidence, 'irregular');
  assert.ok(p.nextRange);
  assert.equal(E.dayDiff(p.nextRange[0], p.nextRange[1]), 41 - 24);
});

test('excluding a cycle keeps it in history but removes it from averages', () => {
  const st = starts(K(2026, 1, 1), [28, 28, 60, 28]);
  const s = stateWith(st);
  const today = E.addDays(E.fromKey(st[st.length - 1]), 2);
  assert.equal(E.analyzeCycles(s, today).avgCycle, 36);
  s.profile.excludedCycles = [st[2]];
  const a = E.analyzeCycles(s, today);
  assert.equal(a.avgCycle, 28);
  assert.equal(a.cycles.length, 4);
  assert.ok(a.cycles.find(c => c.start === st[2]).excluded);
});

test('manual average override replaces the observed average', () => {
  const s = stateWith(starts(K(2026, 1, 1), [28, 28]), {});
  s.profile.avgOverride = { cycle: 33, period: 6 };
  const p = E.predict(s, { today: D(2026, 3, 2) });
  assert.equal(p.avgCycle, 33); assert.equal(p.avgPeriod, 6);
});

test('switching to pregnancy preserves history and excludes later bleeding from cycles', () => {
  const st = starts(K(2026, 1, 1), [28, 28]);
  const s = stateWith(st);
  s.modeHistory = [{ mode: 'period', from: '2000-01-01' }, { mode: 'pregnancy', from: K(2026, 3, 20) }];
  s.pregnancy = { ref: st[2], start: K(2026, 3, 20) };
  s.logs[K(2026, 4, 5)] = { period: 'light', u: 1 }; // bleeding during pregnancy
  const today = D(2026, 4, 10);
  const a = E.analyzeCycles(s, today);
  assert.equal(a.periods.length, 3);          // pregnancy bleeding ignored
  assert.equal(Object.keys(s.logs).length, 16); // nothing deleted
  const p = E.predict(s, { today });
  assert.equal(p.mode, 'pregnancy');
  assert.equal(p.future.length, 0);
  assert.equal(p.pregnancy.week, 6); // 43 days after the reference date
  // back to period tracking later: old cycles still there, no cycle formed across pregnancy
  s.modeHistory.push({ mode: 'period', from: K(2026, 12, 1) });
  for (let i = 0; i < 5; i++) s.logs[E.toKey(E.addDays(D(2026, 12, 10), i))] = { period: 'medium', u: 1 };
  const a2 = E.analyzeCycles(s, D(2026, 12, 20));
  assert.equal(JSON.stringify(a2.cycles.map(c => c.length)), "[28, 28]".replace(/ /g, ""));
});

test('reminders: period/fertility reminders stop during pregnancy, check-in continues', () => {
  const st = starts(K(2026, 1, 1), [28, 28]);
  const s = stateWith(st);
  const cfg = { period_soon: { on: true, days: 2, time: '09:00' }, period_due: { on: true }, fertile_soon: { on: true }, daily_checkin: { on: true } };
  const before = E.computeReminders(s, cfg, { today: D(2026, 2, 26), days: 30 });
  assert.ok(before.some(r => r.type === 'period_due'));
  s.modeHistory = [{ mode: 'pregnancy', from: K(2026, 2, 20) }];
  const during = E.computeReminders(s, cfg, { today: D(2026, 2, 26), days: 30 });
  assert.ok(!during.some(r => ['period_soon', 'period_due', 'fertile_soon'].includes(r.type)));
  assert.ok(during.some(r => r.type === 'daily_checkin'));
  // ids are unique (no duplicates)
  assert.equal(new Set(before.map(r => r.id)).size, before.length);
});

test('tracking without a period: interval starts are not periods and get no ovulation', () => {
  const s = { logs: {}, profile: {}, modeHistory: [{ mode: 'noperiod', from: K(2026, 1, 1) }], intervals: [K(2026, 10, 1), K(2026, 11, 1)] };
  s.logs[K(2026, 11, 3)] = { tags: { emotion: ['calm'] }, u: 1 };
  const p = E.predict(s, { today: D(2026, 11, 8) });
  assert.equal(p.mode, 'noperiod');
  assert.equal(p.hasData, false);
  assert.equal(p.future.length, 0);
  assert.equal(p.interval.day, 8);
  assert.equal(E.analyzeCycles(s, D(2026, 11, 8)).periods.length, 0);
});

test('positive ovulation test moves the ovulation estimate', () => {
  const s = stateWith(starts(K(2026, 9, 1), [30, 30]));
  const last = K(2026, 10, 31);
  s.logs[K(2026, 11, 11)] = { tags: { test: ['ovu_pos'] }, u: 1 };
  const p = E.predict(s, { today: D(2026, 11, 14) });
  assert.equal(p.ovSource, 'test');
  assert.equal(E.toKey(p.cur.ov), K(2026, 11, 12));
  assert.ok(last);
});

test('BBT thermal shift is detected (3 over 6 rule)', () => {
  const series = [36.4, 36.3, 36.4, 36.35, 36.4, 36.3, 36.7, 36.75, 36.7].map((t, i) => ({ key: K(2026, 11, 10 + i), day: i + 1, t }));
  const r = E.detectBbtShift(series);
  assert.ok(r); assert.equal(r.ovKey, K(2026, 11, 15));
});

test('subphases are withheld with hormonal contraception or short predicted cycles', () => {
  const s = stateWith(starts(K(2026, 9, 1), [28, 28]));
  const today = D(2026, 11, 10);
  let p = E.predict(s, { today });
  assert.ok(p.subphase);
  s.profile.hormonal = true;
  p = E.predict(s, { today });
  assert.equal(p.subphase, null);
  const short = stateWith(starts(K(2026, 9, 1), [18, 18, 18]));
  p = E.predict(short, { today: D(2026, 10, 30) });
  assert.equal(p.subphase, null);
});

test('sharing projection never contains symptoms, notes, tags, temperatures or weights', () => {
  const s = stateWith(starts(K(2026, 9, 1), [28, 28]));
  s.logs[K(2026, 10, 5)] = { tags: { emotion: ['sad'], pain: ['cramps'] }, note: 'SECRET NOTE', temp: 36.6, weight: 60, custom: ['t1'], u: 1 };
  s.logs[K(2026, 10, 29)].note = 'ANOTHER SECRET';
  const proj = E.sharedProjection(s, D(2026, 11, 8));
  const json = JSON.stringify(proj);
  for (const forbidden of ['SECRET', 'sad', 'cramps', 'note', 'temp"', 'weight"', 'custom', 'tags']) assert.ok(!json.includes(forbidden), forbidden);
  // viewer engine produces the same period predictions
  const viewer = E.predict(E.stateFromProjection(proj), { today: D(2026, 11, 8) });
  const owner = E.predict(s, { today: D(2026, 11, 8) });
  assert.equal(E.toKey(viewer.nextStart), E.toKey(owner.nextStart));
  assert.equal(E.toKey(viewer.cur.ov), E.toKey(owner.cur.ov));
});

test('sharing is paused in pregnancy', () => {
  const s = stateWith([K(2026, 9, 1)]);
  s.modeHistory = [{ mode: 'pregnancy', from: K(2026, 10, 1) }];
  const proj = E.sharedProjection(s, D(2026, 11, 8));
  assert.equal(proj.paused, true);
  assert.equal(proj.bleedDays, undefined);
});

test('report: last six completed cycles, hidden cycles skipped and back-filled, heatmap ≥3 and filtered', () => {
  const st = starts(K(2025, 1, 1), [28, 29, 30, 31, 95, 27, 28, 29]);
  const s = stateWith(st);
  s.profile.excludedCycles = [st[6]];
  // cramps on day 1 of four cycles; a medication 5 times; headache twice
  [0, 1, 2, 3].forEach(i => { s.logs[st[st.length - 2 - i]].tags = { pain: ['cramps'], meds: ['painkiller'] }; });
  s.logs[st[7]].tags = { pain: ['cramps', 'headache'], meds: ['painkiller'] };
  s.logs[st[6]].tags = { pain: ['headache'] };
  const r = E.reportData(s, E.addDays(E.fromKey(st[st.length - 1]), 3));
  assert.equal(r.cycles.length, 6);
  assert.ok(!r.cycles.some(c => c.start === st[6]));        // hidden
  assert.ok(r.cycles.some(c => c.start === st[1]));          // back-filled with an older cycle
  assert.ok(r.trend.every(c => c.length <= 90));              // >90 excluded from trend
  assert.ok(r.cycles.some(c => c.length === 95));             // but kept in the set/history
  const ids = r.heat.map(h => h.id);
  assert.ok(ids.includes('pain:cramps'));
  assert.ok(!ids.includes('meds:painkiller'));
  assert.ok(!ids.includes('pain:headache'));                  // fewer than 3 times in range
});

test('time zones: day keys follow the local calendar, not UTC', () => {
  const late = new Date(2026, 10, 8, 23, 59, 59);
  const early = new Date(2026, 10, 8, 0, 0, 1);
  assert.equal(E.toKey(late), '2026-11-08');
  assert.equal(E.toKey(early), '2026-11-08');
  // DST transitions don't shift day differences
  assert.equal(E.dayDiff(new Date(2026, 2, 28), new Date(2026, 2, 30)), 2);
  assert.equal(E.dayDiff(new Date(2026, 9, 24), new Date(2026, 9, 26)), 2);
});

test('pain predictions need at least 3 cycles and report insufficient data otherwise', () => {
  const st = starts(K(2026, 6, 1), [28]);
  const s = stateWith(st);
  const p = E.predict(s, { today: D(2026, 7, 5) });
  const r = E.painPredictions(s, p);
  assert.ok(r.every(x => x.status === 'insufficient'));
});

test('symptom patterns count recorded days only (missing is not zero)', () => {
  const st = starts(K(2026, 1, 1), [28, 28, 28]);
  const s = stateWith(st);
  s.logs[E.toKey(E.addDays(E.fromKey(st[0]), 25))] = { tags: { emotion: ['irritable'] }, u: 1 };
  s.logs[E.toKey(E.addDays(E.fromKey(st[1]), 25))] = { tags: { emotion: ['irritable'] }, u: 1 };
  const a = E.analyzeCycles(s, D(2026, 4, 1));
  const r = E.symptomByCycleDay(s, a);
  const row = r.rows.find(x => x.id === 'emotion:irritable');
  assert.equal(row.arr[25], 2);
  assert.equal(r.cycles, 3);
  const co = E.coOccurrence(s, 'emotion:irritable');
  assert.equal(co.days, 2);
});
