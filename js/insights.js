/* Moon&Us — analysis screens and the doctor's report (render-only; data from cycle.js engine).
   Every block states its time range and how much data it used, and says so when data is
   insufficient. No sample data is ever drawn. Associations are described as co-occurrence. */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const range = (a, b) => (a && b ? `${Cal.full(fromKey(a))} تا ${Cal.full(fromKey(b))}` : '');
const card = (title, sub, body, cls = 'white') => `<div class="card ${cls}"><div class="card-label">${title}${sub ? `<span>${sub}</span>` : ''}</div>${body}</div>`;
const empty = text => `<p class="muted" style="font-size:14.5px">${text}</p>`;
const meta = text => `<p class="data-meta">${text}</p>`;

// ---------- small SVG charts ----------
function lineChart(points, opts = {}) {
  // points: [{x, y, label?}] ; x numeric (day index), y numeric
  if (points.length < 2) return '';
  const W = 320, H = opts.h || 150, P = 26;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys); if (opts.yPad) { y0 -= opts.yPad; y1 += opts.yPad; } if (y1 === y0) { y1 += 1; y0 -= 1; }
  const X = x => P + (x - x0) / Math.max(1, x1 - x0) * (W - P * 1.4);
  const Y = y => H - P + 6 - (y - y0) / (y1 - y0) * (H - P - 12);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(' ');
  const dots = points.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="${opts.color || 'var(--teal)'}"/>`).join('');
  const hline = opts.hline != null ? `<line x1="${P}" x2="${W - 4}" y1="${Y(opts.hline).toFixed(1)}" y2="${Y(opts.hline).toFixed(1)}" stroke="var(--coral)" stroke-dasharray="4 3"/>` : '';
  const vline = opts.vline != null ? `<line x1="${X(opts.vline).toFixed(1)}" x2="${X(opts.vline).toFixed(1)}" y1="6" y2="${H - P + 6}" stroke="var(--teal)" stroke-dasharray="3 3"/>` : '';
  const yl = [y0, y1].map(v => `<text x="2" y="${Y(v).toFixed(1)}" font-size="9" fill="var(--muted)" dominant-baseline="middle">${fa((Math.round(v * 10) / 10).toString())}</text>`).join('');
  const xl = [x0, x1].map(v => `<text x="${X(v).toFixed(1)}" y="${H - 4}" font-size="9" fill="var(--muted)" text-anchor="middle">${fa(opts.xFmt ? opts.xFmt(v) : v)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'نمودار')}" style="direction:ltr">${hline}${vline}<path d="${path}" fill="none" stroke="${opts.color || 'var(--teal)'}" stroke-width="2"/>${dots}${yl}${xl}</svg>`;
}
function dayHeat(rows, maxDay, cycles) {
  // rows: [{label, color, arr}] arr[i] = cycles with the experience on day i+1
  const cell = 100 / Math.max(maxDay, 1);
  return `<div class="dayheat" style="--days:${maxDay}">
    <div class="dh-row dh-axis"><span></span><div class="dh-cells">${Array.from({ length: maxDay }, (_, i) => `<i>${(i + 1) % 7 === 1 ? fa(i + 1) : ''}</i>`).join('')}</div></div>
    ${rows.map(r => `<div class="dh-row"><span>${esc(r.label)}</span><div class="dh-cells">${r.arr.slice(0, maxDay).map((v, i) => `<i style="background:${v ? r.color : 'transparent'};opacity:${v ? (0.25 + 0.75 * v / cycles).toFixed(2) : 1}" title="روز ${fa(i + 1)}: ${fa(v)} از ${fa(cycles)} چرخه"></i>`).join('')}</div></div>`).join('')}
  </div>`;
}

// ---------- analysis ----------
export function viewInsights(ctx) {
  const { S, p, compare } = ctx;
  const mode = p.mode;
  let html = `<div><h1 class="page-title">تحلیل <span class="serif">${mode === 'noperiod' ? 'بازه‌ها' : 'چرخه‌ها'}</span></h1><p class="page-lead" style="margin-top:4px">هرچی بیشتر ثبت کنی، الگوها واضح‌تر می‌شن. همه‌ی تحلیل‌ها فقط از ثبت‌های خودت ساخته می‌شن.</p></div>`;
  if (mode === 'noperiod') return html + intervalsBlock(S, p) + feelingsBlock(S, null) + sleepBlock(S, null) + reportLink(false);
  if (mode === 'pregnancy') return html + card('در حالت بارداری', '', empty('تحلیل چرخه در دوران بارداری متوقف می‌شه. تاریخچه‌ی قبلی حفظ شده و بعد از برگشت به حالت پیگیری پریود دوباره نمایش داده می‌شه.'));

  const a = analyzeCycles(engine(S), p.today);
  if (!a.periods.length) return html + card('هنوز داده‌ای نیست', '', empty('اولین پریود که ثبت بشه، تحلیل‌ها اینجا میان. هیچ نمودار نمونه‌ای نمایش داده نمی‌شه.'));

  const inc = a.included; const last6 = a.recentCycles;
  html += meta(inc.length
    ? `بر اساس ${fa(last6.length)} چرخه‌ی کامل اخیر (${range(last6[0].start, last6[last6.length - 1].end)})${a.cycles.length > inc.length ? `؛ ${fa(a.cycles.length - inc.length)} چرخه کنار گذاشته شده` : ''}.`
    : 'هنوز هیچ چرخه‌ی کاملی ثبت نشده؛ میانگین‌ها از تنظیمات میان.');

  const ov = (S.profile.avgOverride || {});
  const vr = a.variation === null ? ['info', 'داده‌ی کافی نیست'] : a.variation <= 7 ? ['ok', 'منظم'] : a.variation <= 9 ? ['warn', 'کمی نامنظم'] : ['warn', 'نامنظم'];
  html += `<div class="stats">
    <div class="stat"><div class="k">میانگین طول چرخه</div><div class="v">${fa(a.avgCycle)} <small>روز</small></div><span class="tag ${ov.cycle ? 'info' : inc.length ? (a.avgCycle >= 21 && a.avgCycle <= 35 ? 'ok' : 'warn') : 'info'}">${ov.cycle ? 'میانگین دستی' : inc.length ? (a.avgCycle >= 21 && a.avgCycle <= 35 ? 'در محدوده‌ی رایج' : 'خارج از ۲۱ تا ۳۵') : 'از تنظیمات'}</span></div>
    <div class="stat"><div class="k">میانگین طول پریود</div><div class="v">${fa(a.avgPeriod)} <small>روز</small></div><span class="tag ${ov.period ? 'info' : a.avgPeriodObserved ? 'ok' : 'info'}">${ov.period ? 'میانگین دستی' : a.avgPeriodObserved ? 'از ثبت‌ها' : 'از تنظیمات'}</span></div>
    <div class="stat"><div class="k">نوسان طول چرخه</div><div class="v">${a.variation === null ? '–' : fa(a.variation)} <small>${a.variation === null ? '' : 'روز'}</small></div><span class="tag ${vr[0]}">${vr[1]}</span></div>
    <div class="stat"><div class="k">چرخه‌های کامل</div><div class="v">${fa(a.cycles.length)}</div><span class="tag info">${a.shortest ? `${fa(a.shortest)} تا ${fa(a.longest)} روز` : 'بدون بازه'}</span></div>
  </div>`;

  // bars
  const list = a.cycles.slice(-8);
  if (list.length) {
    const max = Math.max(36, ...list.map(c => Math.min(c.length, 90)), p.cycleDay || 0);
    const bar = (len, per, lbl, cls) => `<div class="b"><span class="n">${fa(len)}</span><div class="col ${cls}" style="height:${(Math.min(len, max) / max * 100).toFixed(1)}%"><i style="height:${(Math.min(per, len) / len * 100).toFixed(1)}%"></i></div><span class="l">${lbl}</span></div>`;
    html += card('طول چرخه‌ها', 'قرمز: پریود', `<div class="bars">${list.map(c => bar(c.length, c.periodLength, Cal.short(fromKey(c.start)), c.excluded || c.outlier ? 'off' : '')).join('')}${p.hasData ? bar(p.cycleDay, a.lastPeriod.length, 'فعلی', 'cur') : ''}</div>
      ${meta('چرخه‌های کم‌رنگ از محاسبات کنار گذاشته شدن.')}`);
  }

  html += historyBlock(S, a, p, compare);
  if (compare && compare.length === 2) html += compareBlock(S, a, compare);
  html += flowBlock(S, a);
  if (mode === 'perimenopause') html += perimenoBlock(S, a);
  html += typicalCycleBlock(S, a);
  html += crampsReviewBlock(S, a);
  html += patternsBlock(S, a);
  html += feelingsBlock(S, a);
  html += painBlock(S, a, p);
  html += sleepBlock(S, a);
  html += bbtBlock(S, a, p);
  html += weightBlock(S);
  html += reportLink(true);
  return html;
}

const engine = S => ({ logs: S.logs, profile: S.profile, modeHistory: S.modeHistory, pregnancy: S.pregnancy, intervals: S.intervals, ovObserved: S.ovObserved || [] });

function historyBlock(S, a, p, compare) {
  const rows = [];
  if (p.hasData && a.lastPeriod) rows.push({ start: a.lastPeriod.start, length: p.cycleDay, periodLength: a.lastPeriod.length, current: true });
  a.cycles.slice().reverse().slice(0, 12).forEach(c => rows.push(c));
  return card('تاریخچه‌ی چرخه‌ها', `${fa(a.cycles.length)} چرخه‌ی کامل`, rows.map(c => {
    const s = fromKey(c.start); const len = Math.max(1, c.length);
    const ovIdx = c.current ? (p.cur && p.cur.ov ? dayDiff(s, p.cur.ov) : -99) : len - (S.profile.luteal || 14);
    let dots = '';
    for (let i = 0; i < Math.min(len, 70); i++) {
      const lg = S.logs[toKey(addDays(s, i))];
      const cl = lg && BLEED.includes(lg.period) ? 'p' : i === ovIdx ? 'o' : (i >= ovIdx - 5 && i <= ovIdx + 1) ? 'f' : '';
      dots += `<i class="${cl}${c.current && i === len - 1 ? ' now' : ''}"></i>`;
    }
    const sel = compare && compare.includes(c.start);
    const tags = [c.outlier ? '<span class="tag warn">بیرون از ۱۵ تا ۹۰ روز</span>' : '', c.excluded ? '<span class="tag info">کنار گذاشته‌شده</span>' : ''].join('');
    return `<div class="hist-row ${c.excluded ? 'dim' : ''}"><div class="meta"><span>${c.current ? '<b>چرخه‌ی فعلی</b>' : `<b>${fa(c.length)} روز</b>`}، پریود ${fa(c.periodLength)} روز ${tags}</span><span>${Cal.full(s)}</span></div>
      <div class="hist-dots">${dots}</div>
      ${c.current ? '' : `<div class="hist-actions"><button class="text-link" data-act="cycle-exclude" data-k="${c.start}">${c.excluded ? 'برگردوندن به محاسبات' : 'کنار گذاشتن از محاسبات'}</button>
        <button class="text-link ${sel ? 'red' : ''}" data-act="cycle-compare" data-k="${c.start}">${sel ? 'حذف از مقایسه' : 'مقایسه'}</button></div>`}</div>`;
  }).join('') + meta('کنار گذاشتن یه چرخه چیزی رو پاک نمی‌کنه؛ فقط از میانگین‌ها و پیش‌بینی‌ها حذفش می‌کنه. برای مقایسه، دو چرخه انتخاب کن.'));
}

function compareBlock(S, a, keys) {
  const cs = keys.map(k => a.cycles.find(c => c.start === k)).filter(Boolean);
  if (cs.length !== 2) return '';
  const top = c => {
    const counts = {}; const s = fromKey(c.start);
    for (let i = 0; i < c.length; i++) { const l = S.logs[toKey(addDays(s, i))]; tagList(l).forEach(id => { counts[id] = (counts[id] || 0) + 1; }); }
    return Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([id, n]) => `${esc(labelOf(id).label)} (${fa(n)})`).join('، ') || 'ثبتی نیست';
  };
  const col = c => `<div class="cmp-col"><b>${Cal.full(fromKey(c.start))}</b><div>طول: ${fa(c.length)} روز</div><div>پریود: ${fa(c.periodLength)} روز</div><div class="muted" style="font-size:13px">بیشترین ثبت‌ها: ${top(c)}</div></div>`;
  return card('مقایسه‌ی دو چرخه', '', `<div class="cmp">${col(cs[0])}${col(cs[1])}</div>`, 'sky');
}

function flowBlock(S, a) {
  const ps = a.periods.slice(-6);
  if (!ps.length) return '';
  const maxLen = Math.max(...ps.map(p => p.length), 5);
  const col = { spotting: '#F7C3C0', light: '#F59A95', medium: '#E5484D', heavy: '#A3001B' };
  const rows = ps.slice().reverse().map(pd => {
    const s0 = fromKey(pd.start); let cells = '';
    for (let i = 0; i < maxLen; i++) { const l = S.logs[toKey(addDays(s0, i))]; cells += `<i style="background:${l && l.period ? col[l.period] : 'transparent'}"></i>`; }
    return `<div class="ps-row"><span>${Cal.short(s0)}</span><div class="ps-cells" style="--n:${maxLen}">${cells}</div></div>`;
  }).join('');
  return card('شدت پریود', `${fa(ps.length)} پریود اخیر`, `${rows}<div class="ps-row axis"><span></span><div class="ps-cells" style="--n:${maxLen}">${Array.from({ length: maxLen }, (_, i) => `<i>${fa(i + 1)}</i>`).join('')}</div></div>
    <div class="legend" style="justify-content:flex-start">${Object.entries({ spotting: 'لکه‌بینی', light: 'کم', medium: 'متوسط', heavy: 'زیاد' }).map(([k, v]) => `<span><i style="background:${col[k]}"></i>${v}</span>`).join('')}</div>`
    + meta('خونه‌ی خالی یعنی برای اون روز چیزی ثبت نشده.'));
}

function typicalCycleBlock(S, a) {
  const r = symptomByCycleDay(S, a, { cycles: 6, cats: ['emotion', 'energy', 'mind'], limit: 4 });
  if (r.cycles < 2) return card('چرخه‌ی معمول تو', '', empty('بعد از دو چرخه‌ی کامل با ثبت احساسات، اینجا می‌بینی هر حس معمولاً کجای چرخه‌ات پیدا می‌شه.'));
  const L = a.avgCycle, P = a.avgPeriod, ov = L - ((S.profile && S.profile.luteal) || 14);
  const pct = d => (Math.max(0, Math.min(L, d)) / L * 100).toFixed(1);
  const top = `<div class="tc-axis"><i class="tc-period" style="right:0;width:${pct(P)}%"></i><i class="tc-fertile" style="right:${pct(ov - 5)}%;width:${pct(7)}%"></i><b class="tc-ov" style="right:${pct(ov)}%"></b></div>`;
  const rows = r.rows.map(row => `<div class="tc-row"><span>${esc(row.label)}</span><div class="tc-track">${row.arr.map((v, i) => v ? `<i style="right:${pct(i)}%;width:${Math.max(1.6, 100 / L).toFixed(1)}%;opacity:${(0.35 + 0.65 * v / r.cycles).toFixed(2)};background:${row.color}"></i>` : '').join('')}</div></div>`).join('');
  return card('چرخه‌ی معمول تو', `${fa(r.cycles)} چرخه`, `<div class="tc-hump"><div class="h1" style="width:${pct(ov)}%"></div><div class="h2"></div></div>${top}${rows || empty('هنوز احساسی دو بار یا بیشتر ثبت نشده.')}`
    + meta(`میانگین چرخه ${fa(L)} روز؛ قرمز: پریود، آبی: پنجره‌ی باروری. نشانه‌ها جاهایی‌ان که اون حس در چرخه‌های قبلی ثبت شده (همزمانی، نه علت).`), 'white');
}

function crampsReviewBlock(S, a) {
  const cycles = a.cycles.filter(c => !c.excluded && !c.outlier).slice(-6);
  const days = 11; const sum = new Array(days).fill(0), cnt = new Array(days).fill(0);
  let any = false;
  for (const c of cycles) { const s0 = fromKey(c.start); for (let i = 0; i < days; i++) { const l = S.logs[toKey(addDays(s0, i))]; if (l && tagList(l).includes('pain:cramps')) { any = true; sum[i] += l.painLevel || 1; cnt[i]++; } } }
  if (!any) return '';
  const cols = ['#9DB8F5', '#4A78E0', '#1F3FA8', '#0B1F66'];
  const bars = sum.map((v, i) => { const avg = cnt[i] ? v / cnt[i] : 0; const share = cnt[i] / cycles.length; return `<div class="cr-b"><i style="height:${cnt[i] ? 10 + avg * 16 * Math.max(.4, share) : 0}px;background:${cols[Math.min(3, Math.round(avg))]}"></i></div>`; }).join('');
  const P = Math.round(a.avgPeriod);
  return card('مرور دل‌درد', `${fa(cycles.length)} چرخه‌ی اخیر`, `<div class="chips" style="margin-bottom:10px">${['خفیف', 'متوسط', 'شدید'].map((l, i) => `<span class="chip static on" style="--c:${cols[i + 1]}">${l}</span>`).join('')}</div>
    <div class="cr-bars">${bars}</div><div class="cr-line"><i style="width:${(P / days * 100).toFixed(0)}%"></i></div><div class="cr-axis">${Array.from({ length: days }, (_, i) => `<span>${i % 2 === 0 ? fa(i + 1) : ''}</span>`).join('')}</div>`
    + meta('ارتفاع ستون: میانگین شدت دل‌درد در اون روز از پریود، در چرخه‌هایی که ثبت شده. خط قرمز: میانگین طول پریود.'), 'white');
}

function patternsBlock(S, a) {
  const r = symptomByCycleDay(S, a, { cycles: 6, limit: 8 });
  if (r.cycles < 2 || !r.rows.length) return card('الگوهای تکرارشونده بر اساس روز چرخه', '', empty('برای دیدن الگو، علائم رو حداقل در دو چرخه‌ی کامل ثبت کن.'));
  return card('الگوهای تکرارشونده بر اساس روز چرخه', `${fa(r.cycles)} چرخه`, dayHeat(r.rows, r.maxDay, r.cycles) + meta(`${range(r.range[0], r.range[1])}. رنگ پررنگ‌تر یعنی در چرخه‌های بیشتری همون روز ثبت شده.`));
}

function feelingsBlock(S, a) {
  const ids = [...new Set(Object.values(S.logs).flatMap(l => tagList(l)).filter(id => id.startsWith('emotion:')))];
  const rows = ids.map(id => ({ id, ...coOccurrence(S, id), ...labelOf(id) })).filter(r => r.days >= 2).sort((x, y) => y.days - x.days).slice(0, 6);
  if (!rows.length) return card('احساسات', '', empty('احساساتت رو حداقل دو بار ثبت کن تا ببینی کی‌ها بیشتر پیش میان و با چه چیزهایی همزمان ثبت شدن.'));
  const when = id => {
    if (!a) return '';
    const counts = { period: 0, follicular: 0, fertile: 0, luteal: 0, pms: 0 };
    for (const [k, l] of Object.entries(S.logs)) if (tagList(l).includes(id)) { const ph = pastPhase(S, a, k); if (ph in counts) counts[ph]++; }
    const names = { period: 'پریود', follicular: 'فاز فولیکولار', fertile: 'روزهای باروری', luteal: 'فاز لوتئال', pms: 'روزهای PMS' };
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
    return top && top[1] ? `بیشتر در ${names[top[0]]} (${fa(top[1])} روز)` : '';
  };
  return card('احساسات', 'چه زمانی و همراه با چه چیزی', rows.map(r => `<div class="list-row"><span class="dot" style="background:${r.color}"></span><div class="main"><b>${esc(r.label)}</b><small>${fa(r.days)} روز ثبت شده${when(r.id) ? '، ' + when(r.id) : ''}</small>
    ${r.items.length ? `<small>همزمان ثبت شده با: ${r.items.map(i => `${esc(i.label)} (${fa(i.count)})`).join('، ')}</small>` : ''}</div></div>`).join('') + meta('همزمانی به معنی رابطه‌ی علت و معلولی نیست.'));
}

function painBlock(S, a, p) {
  const recent = a.cycles.filter(c => !c.excluded && !c.outlier).slice(-6);
  const hist = recent.map(c => {
    const s = fromKey(c.start); let days = 0, max = 0;
    for (let i = 0; i < c.length; i++) { const l = S.logs[toKey(addDays(s, i))]; if (l && tagList(l).includes('pain:cramps')) { days++; max = Math.max(max, l.painLevel || 0); } }
    return { c, days, max };
  });
  const lv = ['ثبت نشده', 'خفیف', 'متوسط', 'شدید'];
  const preds = p.hasData ? painPredictions(S, p) : [];
  const predHtml = preds.map(r => `<div class="list-row"><span class="dot" style="background:${r.color}"></span><div class="main"><b>${esc(r.label)}</b><small>${
    r.status === 'ok' ? `احتمالاً ${Cal.dayMonth(r.from)}${r.to > r.from ? ` تا ${Cal.dayMonth(r.to)}` : ''} (در ${fa(r.hits)} از ${fa(r.cyclesUsed)} چرخه‌ی اخیر)`
      : r.status === 'no-pattern' ? `الگوی تکرارشونده‌ای در ${fa(r.cyclesUsed)} چرخه‌ی اخیر دیده نشد`
        : `برای پیش‌بینی حداقل ۳ چرخه‌ی کامل لازمه (الان ${fa(r.cyclesUsed)})`}</small></div></div>`).join('');
  const histHtml = hist.length ? hist.map(h => `<div class="list-row"><div class="main"><b>${Cal.short(fromKey(h.c.start))}</b><small>${h.days ? `${fa(h.days)} روز دل‌درد، بیشترین شدت: ${lv[h.max]}` : 'دل‌درد ثبت نشده'}</small></div></div>`).join('') : empty('هنوز چرخه‌ی کاملی نیست.');
  return card('درد و پیش‌بینی درد', 'بر اساس ۳ تا ۴ چرخه‌ی اخیر', `<div class="card-label" style="margin-top:2px">پیش‌بینی چرخه‌ی بعد</div>${predHtml}<div class="card-label" style="margin-top:14px">تاریخچه‌ی دل‌درد</div>${histHtml}`
    + meta('این‌ها تخمین از روی ثبت‌های خودته، نه تشخیص. اگه درد شدیده یا بدتر شده، با پزشک صحبت کن.'));
}

function sleepBlock(S, a) {
  const rows = Object.entries(S.logs).filter(([, l]) => tagList(l).some(id => id.startsWith('sleep:') || id.startsWith('sleepq:')));
  if (rows.length < 3) return card('خواب', '', empty('مدت یا کیفیت خواب رو حداقل سه شب ثبت کن.'));
  if (!a) {
    const counts = {}; rows.forEach(([, l]) => tagList(l).filter(id => id.startsWith('sleep')).forEach(id => { counts[id] = (counts[id] || 0) + 1; }));
    return card('خواب', `${fa(rows.length)} شب`, Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([id, n]) => `<div class="list-row"><div class="main"><b>${esc(labelOf(id).label)}</b></div><span class="end">${fa(n)} شب</span></div>`).join(''));
  }
  const byPh = sleepByPhase(S, a);
  const names = { period: 'پریود', follicular: 'فولیکولار', fertile: 'باروری', luteal: 'لوتئال', pms: 'PMS' };
  return card('خواب در فازهای چرخه', `${fa(rows.length)} شب ثبت‌شده`, Object.entries(names).filter(([k]) => byPh[k]).map(([k, n]) => {
    const items = Object.entries(byPh[k]).sort((x, y) => y[1] - x[1]).slice(0, 3);
    return `<div class="list-row"><div class="main"><b>${n}</b><small>${items.map(([id, c]) => `${esc(labelOf(id).label)} (${fa(c)})`).join('، ')}</small></div></div>`;
  }).join('') || empty('ثبت‌های خواب هنوز به چرخه‌ای تعلق ندارن.'));
}

function bbtBlock(S, a, p) {
  if (!a.lastPeriod) return '';
  const curStart = a.lastPeriod.start;
  const series = bbtSeries(S, curStart, toKey(p.today));
  const prev = a.cycles.length ? a.cycles[a.cycles.length - 1] : null;
  const prevSeries = prev ? bbtSeries(S, prev.start, prev.end) : [];
  const one = (s, title) => {
    if (s.length < 6) return `<div class="card-label" style="margin-top:6px">${title}</div>${empty(`${fa(s.length)} اندازه‌گیری؛ برای نمودار حداقل ۶ روز لازمه.`)}`;
    const shift = detectBbtShift(s);
    return `<div class="card-label" style="margin-top:6px">${title}</div>${lineChart(s.map(x => ({ x: x.day, y: x.t })), { yPad: 0.1, hline: shift ? shift.coverline : null, vline: shift ? s[shift.index].day - 1 : null, label: 'دمای پایه', xFmt: v => 'روز ' + v })}
      ${meta(shift ? `جهش دمایی دیده شد؛ تخمک‌گذاری احتمالاً حدود ${Cal.dayMonth(fromKey(shift.ovKey))} بوده (روش ۳ روز بالاتر از ۶ روز قبل).` : 'هنوز جهش دمایی واضحی دیده نشده.')}`;
  };
  if (!series.length && !prevSeries.length) return card('دمای پایه‌ی بدن', '', empty('دمای پایه رو صبح‌ها قبل از بلند شدن ثبت کن تا نمودارش اینجا بیاد. دمای پوست از دستگاه‌های پوشیدنی جدا از این اندازه‌گیری نگه داشته می‌شه.'));
  return card('دمای پایه‌ی بدن', '°C', one(series, 'چرخه‌ی فعلی') + (prevSeries.length ? one(prevSeries, 'چرخه‌ی قبل') : ''));
}

function weightBlock(S) {
  const pts = Object.entries(S.logs).filter(([, l]) => typeof l.weight === 'number').sort((x, y) => (x[0] < y[0] ? -1 : 1));
  if (pts.length < 2) return pts.length ? card('وزن', '', empty('برای نمودار حداقل دو اندازه‌گیری لازمه.')) : '';
  const first = fromKey(pts[0][0]);
  return card('وزن', `${fa(pts.length)} اندازه‌گیری، کیلوگرم`, lineChart(pts.map(([k, l]) => ({ x: dayDiff(first, fromKey(k)), y: l.weight })), { yPad: 0.5, color: 'var(--plum)', xFmt: v => Cal.short(addDays(first, v)) }) + meta(range(pts[0][0], pts[pts.length - 1][0])));
}

function perimenoBlock(S, a) {
  const cs = a.cycles;
  let html = '';
  if (cs.length >= 2) html += `<div class="card-label">روند طول چرخه</div>${lineChart(cs.map((c, i) => ({ x: i + 1, y: Math.min(c.length, 120) })), { color: 'var(--orange)', label: 'طول چرخه', xFmt: v => 'چرخه ' + v })}`;
  else html += empty('برای دیدن روند، حداقل دو چرخه‌ی کامل لازمه.');
  const months = {};
  for (const [k, l] of Object.entries(S.logs)) for (const id of tagList(l)) if (id.startsWith('meno:')) { const m = k.slice(0, 7); months[m] = months[m] || {}; months[m][id] = (months[m][id] || 0) + 1; }
  const keys = Object.keys(months).sort().slice(-6);
  html += `<div class="card-label" style="margin-top:14px">گرگرفتگی و تعریق در ماه‌های اخیر</div>` + (keys.length ? keys.map(m => `<div class="list-row"><div class="main"><b>${Cal.monthName(fromKey(m + '-15'))} ${Cal.year(fromKey(m + '-15'))}</b><small>${Object.entries(months[m]).map(([id, n]) => `${esc(labelOf(id).label)}: ${fa(n)} روز`).join('، ')}</small></div></div>`).join('') : empty('هنوز ثبت نشده.'));
  return card('تغییرات پیش‌یائسگی', a.irregular ? 'چرخه‌ها نامنظم‌ان' : '', html + meta('این خلاصه برای گفت‌وگو با پزشکه و یائسگی یا بیماری‌ای رو تشخیص نمی‌ده. در چرخه‌های نامنظم، پیش‌بینی‌ها به‌صورت بازه نشون داده می‌شن.'), 'peach');
}

function intervalsBlock(S, p) {
  const info = p.interval || intervalInfo(S, p.today);
  if (!info.intervals.length) return card('بازه‌ها', '', empty('هنوز بازه‌ای شروع نشده. از صفحه‌ی اصلی «شروع بازه‌ی جدید» رو بزن.'));
  const rows = info.intervals.slice(-6).reverse().map(iv => {
    const counts = {}; let days = 0;
    for (let d = fromKey(iv.start); toKey(d) <= iv.end; d = addDays(d, 1)) { const l = S.logs[toKey(d)]; const t = tagList(l); if (t.length) days++; t.forEach(id => { counts[id] = (counts[id] || 0) + 1; }); }
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([id, n]) => `${esc(labelOf(id).label)} (${fa(n)})`).join('، ');
    return `<div class="list-row"><div class="main"><b>${Cal.full(fromKey(iv.start))}</b><small>${fa(dayDiff(fromKey(iv.start), fromKey(iv.end)) + 1)} روز، ${fa(days)} روز ثبت‌شده</small><small>${top || 'ثبتی نیست'}</small></div></div>`;
  }).join('');
  return card('مقایسه‌ی بازه‌ها', `${fa(info.intervals.length)} بازه`, rows + meta('شروع بازه پریود حساب نمی‌شه و برای بازه‌ها تخمک‌گذاری یا باروری تخمین زده نمی‌شه.'));
}

const reportLink = can => can ? `<div class="card"><div class="card-label">گزارش برای پزشک</div><p style="color:var(--ink-2);font-size:14.5px;margin-bottom:14px">گزارش PDF از شش چرخه‌ی کامل اخیر، آمار و نقشه‌ی علائم. قبل از ذخیره بازبینی‌اش می‌کنی و خودت تصمیم می‌گیری با کی به اشتراک بذاری.</p><a class="pill-btn blush block" href="#report">ساخت گزارش</a></div>` : '';

// ---------- doctor's report ----------
export function reportView(ctx) {
  const { S, rep } = ctx; const opt = rep;
  const r = reportData(engine(S), todayDate());
  const lv = { light: 'کم', medium: 'متوسط', heavy: 'زیاد' };
  const controls = `<div class="no-print stack">
    <div><h1 class="page-title">گزارش <span class="serif">برای پزشک</span></h1><p class="page-lead" style="margin-top:4px">قبل از ذخیره، همه‌چیز رو بازبینی کن. گزارش خودکار برای کسی فرستاده نمی‌شه.</p></div>
    <div class="card white stack">
      <label class="check-row"><input type="checkbox" data-act="rep-opt" data-k="personal" ${opt.personal ? 'checked' : ''}> مشخصات شخصی و پزشکی رو اضافه کن (اختیاری)</label>
      ${opt.personal ? `<div class="grid2">
        <div class="field"><label for="rep-name">نام</label><input class="input" id="rep-name" data-rep="name" value="${esc(opt.name || '')}"></div>
        <div class="field"><label for="rep-year">سال تولد</label><input class="input ltr" id="rep-year" data-rep="year" inputmode="numeric" value="${esc(opt.year || '')}"></div></div>
        <div class="field"><label for="rep-cond">شرایط پزشکی</label><input class="input" id="rep-cond" data-rep="cond" value="${esc(opt.cond || '')}"></div>
        <div class="field"><label for="rep-meds">داروها و روش پیشگیری</label><input class="input" id="rep-meds" data-rep="meds" value="${esc(opt.meds || '')}"></div>
        <div class="field"><label for="rep-q">سؤال‌ها یا نکته‌ها برای پزشک</label><textarea class="input" id="rep-q" data-rep="q">${esc(opt.q || '')}</textarea></div>` : ''}
      <label class="check-row"><input type="checkbox" data-act="rep-opt" data-k="heat" ${opt.heat ? 'checked' : ''}> نقشه‌ی علائم</label>
      <label class="check-row"><input type="checkbox" data-act="rep-opt" data-k="history" ${opt.history ? 'checked' : ''}> جدول چرخه‌ها و پریودها</label>
      <p class="fine" style="text-align:right">مشخصات شخصی فقط روی همین صفحه می‌مونه و جایی ذخیره نمی‌شه.</p>
      <button class="pill-btn red block" data-act="rep-print" ${r.insufficient ? 'disabled' : ''}>ذخیره یا اشتراک PDF</button>
      <p class="fine" style="text-align:right">در پنجره‌ی چاپ، مقصد رو «Save as PDF» بذار.</p>
    </div></div>`;
  if (r.insufficient) return controls + card('داده‌ی کافی نیست', '', empty('برای گزارش حداقل یک چرخه‌ی کامل لازمه (از شروع یه پریود تا شروع پریود بعدی).'));

  const s = r.stats;
  const maxLen = Math.max(...r.trend.map(c => c.length), 35);
  const trend = r.trend.length ? `<div class="rep-bars">${r.trend.map(c => `<div><span>${fa(c.length)}</span><i style="height:${(c.length / maxLen * 100).toFixed(0)}%"></i><small>${Cal.short(fromKey(c.start))}</small></div>`).join('')}</div>` : '<p>همه‌ی چرخه‌ها بلندتر از ۹۰ روزن و در نمودار نمایش داده نمی‌شن.</p>';
  const maxDay = Math.min(45, Math.max(...r.cycles.map(c => c.length)));
  const heat = r.heat.length ? `<table class="rep-heat"><thead><tr><th></th>${r.cycles.map(c => `<th>${Cal.short(fromKey(c.start))}</th>`).join('')}</tr></thead><tbody>
    ${r.heat.map(h => `<tr><td>${esc(h.label)}</td>${h.byCycle.map(days => `<td><div class="rep-strip">${Array.from({ length: maxDay }, (_, i) => `<i class="${days.includes(i + 1) ? 'on' : ''}" style="${days.includes(i + 1) ? `background:${h.color}` : ''}"></i>`).join('')}</div></td>`).join('')}</tr>`).join('')}
  </tbody></table><p class="rep-note">هر نوار یک چرخه است؛ هر خانه یک روز چرخه (تا روز ${fa(maxDay)}). فقط علائمی که حداقل ۳ بار ثبت شدن. یادداشت‌ها، داروها، مکمل‌ها، تست‌ها (به‌جز تست تخمک‌گذاری)، وزن و دما در این نقشه نیستن.</p>`
    : '<p class="rep-note">هیچ علامتی در این بازه حداقل ۳ بار ثبت نشده.</p>';
  const flowOf = c => { const out = []; const st = fromKey(c.start); for (let i = 0; i < c.periodLength; i++) { const l = S.logs[toKey(addDays(st, i))]; out.push(l && l.period ? (lv[l.period] || 'لکه‌بینی') : '–'); } return out.join('، '); };
  return controls + `<article class="report" id="report">
    <header class="rep-head"><div>${ctx.logo}</div><div><b>گزارش چرخه‌ی قاعدگی</b><div>تهیه‌شده: ${Cal.full(todayDate())}</div><div>بازه: ${range(r.cycles[0].start, r.cycles[r.cycles.length - 1].end)}</div></div></header>
    ${opt.personal ? `<section><h2>مشخصات</h2><table class="rep-kv">
      ${opt.name ? `<tr><td>نام</td><td>${esc(opt.name)}</td></tr>` : ''}${opt.year ? `<tr><td>سال تولد</td><td>${esc(opt.year)}</td></tr>` : ''}
      ${opt.cond ? `<tr><td>شرایط پزشکی</td><td>${esc(opt.cond)}</td></tr>` : ''}${opt.meds ? `<tr><td>داروها و پیشگیری</td><td>${esc(opt.meds)}</td></tr>` : ''}
      ${opt.q ? `<tr><td>سؤال‌ها</td><td>${esc(opt.q)}</td></tr>` : ''}</table></section>` : ''}
    <section><h2>آمار (${fa(s.cycles)} چرخه‌ی کامل اخیر)</h2><table class="rep-kv">
      <tr><td>میانگین طول چرخه</td><td>${s.avgCycle != null ? fa(s.avgCycle) + ' روز' : '–'}</td></tr>
      <tr><td>کوتاه‌ترین / بلندترین</td><td>${s.shortest != null ? `${fa(s.shortest)} / ${fa(s.longest)} روز` : '–'}</td></tr>
      <tr><td>میانگین طول پریود</td><td>${s.avgPeriod != null ? fa(s.avgPeriod) + ' روز' : '–'}</td></tr>
      ${r.hiddenCount ? `<tr><td>چرخه‌های کنار گذاشته‌شده</td><td>${fa(r.hiddenCount)} (در آمار نیستن)</td></tr>` : ''}
    </table></section>
    <section><h2>طول چرخه‌ها</h2>${trend}<p class="rep-note">چرخه‌های بلندتر از ۹۰ روز در نمودار نیستن ولی در آمار و جدول هستن.</p></section>
    ${opt.history ? `<section><h2>چرخه‌ها و پریودها</h2><table class="rep-table"><thead><tr><th>شروع</th><th>طول چرخه</th><th>طول پریود</th><th>شدت خونریزی روزانه</th></tr></thead><tbody>
      ${r.cycles.slice().reverse().map(c => `<tr><td>${Cal.full(fromKey(c.start))}</td><td>${fa(c.length)}</td><td>${fa(c.periodLength)}</td><td>${flowOf(c)}</td></tr>`).join('')}</tbody></table></section>` : ''}
    ${opt.heat ? `<section><h2>نقشه‌ی علائم</h2>${heat}</section>` : ''}
    <footer class="rep-foot">این گزارش از ثبت‌های شخصی در Moon&Us ساخته شده و تشخیص پزشکی نیست. پیش‌بینی‌ها تخمینی‌اند.</footer>
  </article>`;
}
