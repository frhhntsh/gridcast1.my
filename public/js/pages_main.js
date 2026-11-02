// Pages: Today, Usage, Bills
import { h, nf, rm, kw, fmtHour, fmtDate } from './dom.js';
import { S, ctx, dr, clockInfo } from './store.js';
import { nextHourStatus, monthlyBills, peakMask, mdMaskFor, TARIFF_PRESETS, MONTHS, MONTHS_SHORT, DAY_NAMES } from './engine.js';
import { make, afterMount, ranges, COL } from './charts.js';
import { hooks, section, card, stat, callout, chartBox, monthSelect, seg, csvDownload } from './ui.js';
import { dayIdxToDate } from './engine.js';

const ord = (n) => n + (([11, 12, 13].includes(n % 100)) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const SUN = `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="9" fill="#FF7A2F" stroke="#261A47" stroke-width="2"/><g stroke="#261A47" stroke-width="2.4" stroke-linecap="round"><path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.5 10.5l4.2 4.2M33.3 33.3l4.2 4.2M10.5 37.5l4.2-4.2M33.3 14.7l4.2-4.2"/></g></svg>`;

// ===========================================================================
// TODAY
// ===========================================================================
export function pageToday() {
  const c = ctx(), ci = clockInfo(), i = ci.idx, s = S.settings, hr = S.clock.hour, t = c.tariff, tl = c.tl;
  const st = nextHourStatus(c, i);
  const name = s.managerName || 'there';
  const hello = hr < 5 ? `Still up, ${name}?` : `Good ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}, ${name}.`;
  const wx = S.data.weather_daily, temp = wx.temp[ci.dayIdx], hum = wx.hum[ci.dayIdx];

  const msgs = {
    alert: `Demand is heading for a new monthly high. That one hour could add about <b>${rm(st.extra)}</b> to this month’s bill.`,
    watch: `Demand is close to this month’s highest level (${kw(st.run)}). Keep an eye on the next reading.`,
    ok: st.inMdWindow ? `Comfortably below this month’s highest level (${kw(st.run)}). Nothing to do right now.`
      : (t.mdPeakOnly ? 'This hour is outside your peak-charge window, so it can’t raise your monthly peak charge. A good time for flexible jobs.' : 'Steady demand — nothing to do right now.'),
    info: 'A new billing month has just started, so the “highest demand” mark is still being set.',
  };
  const hand = { alert: 'this is the hour that costs you', watch: 'almost there… watch this one', ok: 'all calm for now', info: 'fresh month, fresh start' }[st.tone];

  // ---- header ----
  const head = h('div', { style: 'margin:20px 0 22px' },
    h('h1', { style: 'font-size:clamp(34px,4.6vw,54px);line-height:1.05' }, hello),
    h('p', { class: 'muted', style: 'margin-top:8px;font-size:16px' },
      `${s.building} · ${fmtDate(ci.pickedMs)}`,
      ci.exact ? '' : h('span', { class: 'tiny' }, `  — demo meter data from ${fmtDate(ci.demoMs, true)} 2021 (same weekday)`)));

  // ---- hero + side ----
  const hero = h('div', { class: 'hero' },
    h('div', { class: 'label' }, `Next hour · ${fmtHour(hr)} – ${fmtHour(hr + 1)}`),
    h('div', { class: 'hero-num' }, nf(st.nxt), h('small', null, 'kW expected')),
    h('span', { class: 'sticker ' + st.tone }, st.label),
    h('p', { class: 'msg', html: msgs[st.tone] }),
    h('div', { class: 'hand' }, hand));
  const pTxt = isNaN(st.p) ? '—' : (st.p < 0.01 ? '<1%' : Math.round(st.p * 100) + '%');
  const side = h('div', { class: 'side-stack' },
    stat('Chance of a new monthly peak', pTxt, 'How likely the next hour is to beat this month’s highest so far.', 'lilac'),
    stat('Expected range', `${nf(c.loKw[i])} – ${nf(c.hiKw[i])}`, 'kW — real demand lands in this range 9 times out of 10.', 'sky'),
    h('div', { class: 'card weather' }, h('div', { html: SUN, style: 'width:46px' }),
      h('div', null, h('div', { class: 'label' }, 'Outdoors today (demo weather)'), h('div', { style: 'font-family:var(--serif);font-size:24px;font-weight:600' }, `${nf(temp, 0)}°C · humidity ${nf(hum)}%`),
        h('div', { class: 'tiny' }, temp >= 33 ? 'Hot day — cooling load will lean on your chillers.' : 'Mild day — cooling demand should stay moderate.'))));

  // ---- chart ----
  const lo = Math.max(0, i - 24), n = i - lo + 1;
  const labels = Array.from({ length: n }, (_, k) => fmtHour(tl.hour[lo + k]).replace('\u00A0', ' '));
  const actual = Array.from({ length: n }, (_, k) => (lo + k < i ? Math.round(c.actualKw[lo + k]) : null));
  const fc = Array.from({ length: n }, (_, k) => Math.round(c.fcKw[lo + k]));
  const hi = Array.from({ length: n }, (_, k) => Math.round(c.hiKw[lo + k]));
  const lw = Array.from({ length: n }, (_, k) => Math.round(c.loKw[lo + k]));
  const { box, canvas } = chartBox();
  afterMount(() => make(canvas, 'line', { labels, datasets: [
    { label: 'Used', data: actual, borderColor: COL.ink, backgroundColor: COL.ink, borderWidth: 3, pointRadius: 0, tension: .35 },
    { label: 'GridCast forecast', data: fc, borderColor: COL.orange, borderWidth: 2.6, borderDash: [2, 5], pointRadius: 0, tension: .35 },
    { label: 'Range', data: hi, borderWidth: 0, pointRadius: 0, backgroundColor: 'rgba(255,122,47,.15)', fill: '+1', tension: .35 },
    { label: 'range-lo', data: lw, borderWidth: 0, pointRadius: 0, tension: .35 },
    { label: 'Next hour', data: fc.map((v, k) => (k === n - 1 ? v : null)), borderColor: COL.ink, backgroundColor: st.tone === 'alert' ? COL.alert : COL.orange, pointRadius: 9, pointBorderWidth: 3, showLine: false },
  ] }, { plugins: {
    legend: { labels: { filter: (l) => !['range-lo', 'Range'].includes(l.text) } },
    peakBands: { ranges: ranges(c.pmask, lo, i + 1), label: t.mdPeakOnly ? 'peak-charge hours' : 'peak-rate hours' },
    hline: { y: st.run, label: 'this month’s highest so far' },
    notes: { items: [{ i: n - 1, v: fc[n - 1], text: 'next hour', dx: -120, dy: -52 }] } },
  scales: { y: { title: { display: true, text: 'kW' } } } }));

  // ---- what to do ----
  const flex = s.flexKw, avoid = Math.min(Math.max(st.nxt - st.run, 0), flex) * c.mdRate * (1 + t.otherPct / 100);
  const steps = [];
  if (st.tone === 'alert') {
    steps.push(`Pause up to <b>${nf(flex)} kW</b> of flexible load for this hour — pre-cooling chillers, water pumps, EV chargers.`);
    steps.push(`That protects about <b>${rm(avoid)}</b> of this month’s peak charge.`);
    steps.push(t.mdPeakOnly ? `Switch things back on after <b>${fmtHour(t.peakEnd)}</b>, when energy is cheaper.` : 'Spread the restart over the next hour so it doesn’t spike again.');
  } else if (st.tone === 'watch') {
    steps.push('Nothing to switch off yet — you’re still under this month’s highest level.');
    steps.push(`If the next reading climbs, be ready to pause <b>${nf(flex)} kW</b> of flexible load.`);
    steps.push('GridCast checks again every hour and will tell you.');
  } else if (st.tone === 'info') {
    steps.push('A new month means a clean slate for your peak charge.');
    steps.push('Peak charge is set by your single highest half-hour, so smooth starts matter.');
  } else if (!st.inMdWindow && t.mdPeakOnly) {
    steps.push(`This hour is outside the <b>${fmtHour(t.peakStart)}–${fmtHour(t.peakEnd)}</b> peak window — it can’t raise your peak charge.`);
    steps.push(`Energy is also cheaper now (${nf((t.energyPeak - t.energyOff) * 100, 1)} sen/kWh less than peak). Good time for EV charging or pre-cooling.`);
  } else {
    steps.push('All calm. No action needed this hour.');
    steps.push(`Your highest so far is ${isNaN(st.run) ? '—' : kw(st.run)}; today’s forecast sits below it.`);
  }
  const todo = card('', h('h3', null, 'What to do right now'), h('ul', { class: 'todo' }, steps.map((x, k) => h('li', null, h('span', { class: 'n' }, k + 1), h('div', { html: x })))),
    h('p', { class: 'tiny', style: 'margin-top:14px' }, 'GridCast only recommends — it never switches anything by itself.'));

  // ---- month at a glance ----
  const m = ci.month, b = c.billsFc[m], prev = m > 0 ? c.billsAct[m - 1].total : NaN;
  const d = isNaN(prev) ? null : (b.total / prev - 1) * 100;
  const drr = dr(s.strategy), sv = b.total - drr.bills[m].total;
  const glance = h('div', { class: 'grid g3' },
    h('div', { class: 'card' }, h('div', { class: 'label' }, `Estimated bill · ${MONTHS[m]}`), h('div', { class: 'stat-big' }, rm(b.total)),
      h('div', { class: 'stat-sub' }, d == null ? 'Forecast for the whole month' : h('span', { class: d > 0 ? 'bad' : 'good' }, `${d > 0 ? '▲' : '▼'} ${nf(Math.abs(d), 1)}% vs last month`))),
    h('div', { class: 'card' }, h('div', { class: 'label' }, 'Highest demand so far'), h('div', { class: 'stat-big' }, isNaN(st.run) ? '—' : kw(st.run)),
      h('div', { class: 'stat-sub' }, isNaN(st.run) ? 'Builds up as the month goes on' : `Sets your peak charge: about ${rm(st.run * c.mdRate)}`)),
    h('div', { class: 'card peach tilt2' }, h('div', { class: 'label' }, 'You could save this month'), h('div', { class: 'stat-big' }, rm(Math.max(sv, 0))),
      h('div', { class: 'stat-sub' }, `with “${{ shift: 'shift to quiet hours', curtail: 'switch off for a while', cap: 'stay under a limit' }[s.strategy]}” — see Savings`)));

  const quick = h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
    [['usage', 'See my usage'], ['bills', 'Understand my bill'], ['savings', 'Plan my savings'], ['alerts', 'Check alerts']].map(([p, l]) => h('button', { class: 'chipbtn', onclick: () => hooks.go(p) }, l)));

  return h('div', null, head,
    h('div', { class: 'grid g-hero' }, hero, side),
    section('The last 24 hours', 'What your building used, what GridCast expected, and the hour coming up.'),
    h('div', { class: 'grid g-wide' }, card('', box), todo),
    section(`${MONTHS[m]} at a glance`), glance,
    h('div', { style: 'margin-top:26px' }, quick));
}

// ===========================================================================
// USAGE
// ===========================================================================
export function pageUsage() {
  const c = ctx(), tl = c.tl, m = S.month, t = c.tariff;
  const s0 = tl.monthStartDay[m], nd = tl.daysInMonth[m];
  if (S.usageDay == null || S.usageDay < s0 || S.usageDay >= s0 + nd) {
    let best = s0, bv = -1;
    for (let d = s0; d < s0 + nd; d++) { let mx = 0; for (let k = 0; k < 24; k++) { const v = c.actualKw[d * 24 + k]; if (c.mdmask[d * 24 + k] && v > mx) mx = v; } if (mx > bv) { bv = mx; best = d; } }
    S.usageDay = best;
  }
  const controls = h('div', { style: 'display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;margin-bottom:6px' },
    monthSelect(() => { S.usageDay = null; hooks.rerender(); }),
    h('div', null, h('div', { class: 'tiny', style: 'font-weight:700;margin-bottom:4px' }, 'View'), seg([['day', 'By hour'], ['month', 'By day']], S.usageView, (v) => { S.usageView = v; hooks.rerender(); })),
    S.usageView === 'day' ? h('label', { class: 'field', style: 'margin:0;max-width:220px' }, h('span', null, 'Day'),
      h('select', { class: 'sel', onchange: (e) => { S.usageDay = +e.target.value; hooks.rerender(); } },
        Array.from({ length: nd }, (_, k) => h('option', { value: s0 + k, selected: s0 + k === S.usageDay }, fmtDate(dayIdxToDate(s0 + k).getTime(), true))))) : null);

  let body;
  if (S.usageView === 'day') {
    const d = S.usageDay, a0 = d * 24;
    const act = Array.from({ length: 24 }, (_, k) => c.actualKw[a0 + k]);
    const f = Array.from({ length: 24 }, (_, k) => c.fcKw[a0 + k]);
    const total = act.reduce((x, y) => x + y, 0), pk = act.indexOf(Math.max(...act)), lo = act.indexOf(Math.min(...act));
    let peakKwh = 0; for (let k = 0; k < 24; k++) if (c.pmask[a0 + k]) peakKwh += act[k];
    const { box, canvas } = chartBox('tall');
    afterMount(() => make(canvas, 'bar', { labels: Array.from({ length: 24 }, (_, k) => fmtHour(k).replace('\u00A0', ' ')), datasets: [
      { type: 'bar', label: 'Used', data: act.map(Math.round), backgroundColor: act.map((_, k) => (c.pmask[a0 + k] ? COL.orange : COL.sky)), borderRadius: 7, borderSkipped: false },
      { type: 'line', label: 'GridCast forecast', data: f.map(Math.round), borderColor: COL.ink, borderWidth: 2.6, pointRadius: 0, tension: .35 }] },
    { plugins: { notes: { items: [{ i: pk, v: act[pk], text: 'busiest hour', dx: 40, dy: -34 }] } }, scales: { y: { title: { display: true, text: 'kW' }, beginAtZero: true } } }));
    body = h('div', null,
      h('div', { class: 'grid g3' },
        stat('Energy used', `${nf(total)} kWh`, `${nf(total ? peakKwh / total * 100 : 0)}% during peak-rate hours`),
        stat('Highest demand', kw(act[pk]), `around ${fmtHour(pk)}`, 'peach'),
        stat('Lowest demand', kw(act[lo]), `around ${fmtHour(lo)}`, 'sky')),
      section('Hour by hour', 'Orange bars are peak-rate hours, blue bars are off-peak. The dark line is GridCast’s forecast.'),
      card('', box),
      h('div', { style: 'margin-top:18px' }, callout(`Your busiest hour was around ${fmtHour(pk)} at ${kw(act[pk])}. `,
        c.mdmask[a0 + pk] ? 'That falls inside the period your peak charge is measured, so it counts.' : 'That falls outside the period your peak charge is measured, so it doesn’t raise your peak charge.')));
  } else {
    const kwh = [], peaks = [], fpeaks = [];
    for (let d = s0; d < s0 + nd; d++) {
      let e = 0, mx = 0, fm = 0;
      for (let k = 0; k < 24; k++) { const j = d * 24 + k; e += c.actualKw[j]; if (c.mdmask[j]) { if (c.actualKw[j] > mx) mx = c.actualKw[j]; if (c.fcKw[j] > fm) fm = c.fcKw[j]; } }
      kwh.push(e); peaks.push(mx); fpeaks.push(fm);
    }
    const tot = kwh.reduce((a, b) => a + b, 0), top = kwh.indexOf(Math.max(...kwh));
    const prevKwh = m > 0 ? c.billsAct[m - 1].kwh : NaN, dd = isNaN(prevKwh) ? null : (tot / prevKwh - 1) * 100;
    const labels = Array.from({ length: nd }, (_, k) => String(k + 1));
    const c1 = chartBox(), c2 = chartBox('short');
    afterMount(() => {
      make(c1.canvas, 'bar', { labels, datasets: [{ label: 'Energy per day (kWh)', data: kwh.map(Math.round), backgroundColor: kwh.map((_, k) => (k === top ? COL.purple : COL.orange)), borderRadius: 7, borderSkipped: false }] },
        { plugins: { legend: { display: false }, notes: { items: [{ i: top, v: kwh[top], text: 'busiest day', dx: 30, dy: 26 }] } }, scales: { y: { title: { display: true, text: 'kWh' }, beginAtZero: true } } });
      make(c2.canvas, 'bar', { labels, datasets: [
        { type: 'bar', label: 'Actual daily peak', data: peaks.map(Math.round), backgroundColor: COL.sky, borderRadius: 6 },
        { type: 'line', label: 'GridCast forecast', data: fpeaks.map(Math.round), borderColor: COL.ink, borderWidth: 2.4, pointRadius: 2, tension: .3 }] },
      { scales: { y: { title: { display: true, text: 'kW' } } } });
    });
    body = h('div', null,
      h('div', { class: 'grid g3' },
        stat('Energy used', `${nf(tot)} kWh`, dd == null ? '' : h('span', { class: dd > 0 ? 'bad' : 'good' }, `${dd > 0 ? '▲' : '▼'} ${nf(Math.abs(dd), 1)}% vs last month`)),
        stat('Average per day', `${nf(tot / nd)} kWh`, `${nd} days`, 'sky'),
        stat('Highest demand', kw(Math.max(...peaks)), `on ${ord(peaks.indexOf(Math.max(...peaks)) + 1)} ${MONTHS[m]}`, 'peach')),
      section('Day by day', 'One bar per day. The purple bar is the busiest day of the month.'), card('', c1.box),
      h('details', { class: 'fold', style: 'margin-top:20px' }, h('summary', null, 'Daily peak demand — actual vs forecast'), c2.box));
  }
  return h('div', null, section('Your usage', 'See how much power the building uses — by the hour, or day by day.'), controls, body);
}

// ===========================================================================
// BILLS
// ===========================================================================
export function pageBills() {
  const c = ctx(), m = S.month, t = c.tariff, b = c.billsAct[m], f = c.billsFc[m], tl = c.tl;
  const err = (f.total / b.total - 1) * 100;
  const energyAfa = b.energy + b.afa, tot = b.total;
  const parts = [['Energy', energyAfa, COL.sky], ['Peak charge', b.md, COL.orange], ['Fixed + other', b.retail + b.other, '#B9A8F5']];
  const hero = h('div', { class: 'hero' },
    h('div', { class: 'label' }, `Your bill · ${MONTHS[m]}`), h('div', { class: 'hero-num', style: 'font-size:clamp(54px,7vw,84px)' }, rm(tot)),
    h('span', { class: 'sticker info' }, `GridCast guessed ${rm(f.total)} (${err >= 0 ? '+' : ''}${nf(err, 1)}%)`),
    h('p', { class: 'msg', html: `<b>${nf(b.md / tot * 100)}%</b> of this bill is your <b>peak charge</b> — and it comes from <b>one single half-hour</b>: your busiest one this month (${kw(b.mdKw)}).` }),
    h('div', { class: 'hand' }, 'one hour can cost thousands'));
  const money = card('',
    h('h3', null, 'Where the money goes'),
    h('div', { class: 'moneybar' }, parts.map(([, v, col]) => h('span', { style: `width:${Math.max(v / tot * 100, 0.5)}%;background:${col}` }))),
    h('div', { class: 'legend' }, parts.map(([l, v, col]) => h('span', null, h('i', { style: `background:${col}` }), `${l} ${rm(v)}`))),
    h('div', { style: 'margin-top:14px' }, callout('Energy is what you ', h('i', null, 'use'), '. The peak charge is what you ', h('i', null, 'could have needed'), ' at your worst moment — that’s the part GridCast helps you shrink.')));

  const lines = [];
  const L = (name, sub, v) => lines.push(h('div', { class: 'line' }, h('div', null, name, sub ? h('small', null, sub) : null), h('b', null, rm(v))));
  if (t.energyPeak !== t.energyOff) { L('Peak-hour energy', `${nf(b.peakKwh)} kWh × ${nf(t.energyPeak * 100, 2)} sen`, b.peakKwh * t.energyPeak); L('Off-peak energy', `${nf(b.offKwh)} kWh × ${nf(t.energyOff * 100, 2)} sen`, b.offKwh * t.energyOff); }
  else L('Energy', `${nf(b.kwh)} kWh × ${nf(t.energyPeak * 100, 2)} sen`, b.energy);
  if (t.afaSen) L('Fuel adjustment (AFA)', `${nf(b.kwh)} kWh × ${nf(t.afaSen, 2)} sen`, b.afa);
  L('Capacity charge', `${nf(b.mdKw)} kW × RM ${nf(t.capacity, 2)}`, b.capacity);
  if (t.network) L('Network charge', `${nf(b.mdKw)} kW × RM ${nf(t.network, 2)}`, b.network);
  if (t.retail) L('Retail charge', 'fixed monthly', b.retail);
  if (t.otherPct) L('Other charges', `${nf(t.otherPct, 1)}% on top`, b.other);
  const items = card('', h('h3', null, 'Bill breakdown'), h('div', null, lines), h('div', { class: 'line total' }, h('span', null, 'Total'), h('span', null, rm(tot))),
    h('p', { class: 'tiny', style: 'margin-top:10px' }, 'Estimate from your settings. A real TNB bill may add items such as KWTBB or service tax.'));

  // ---- which tariff fits ----
  const rows = Object.values(TARIFF_PRESETS).map((p) => {
    const tt = { ...p, otherPct: t.otherPct, afaSen: p.id.includes('legacy') ? 0 : (t.afaSen || p.afaSen) };
    const pm = peakMask(tl, tt), md = mdMaskFor(tl, tt, pm);
    return { p, bill: monthlyBills(c.actualKw, tl, pm, md, tt)[m] };
  });
  const rp4 = rows.filter((r) => !r.p.id.includes('legacy')), best = rp4.reduce((a, r) => (r.bill.total < a.bill.total ? r : a), rp4[0]);
  const cmp = card('', h('h3', null, 'Which tariff fits this building best?'), h('p', { class: 'tiny', style: 'margin-bottom:8px' }, `Same demand, ${MONTHS[m]}, priced under each tariff.`),
    h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Tariff', 'Energy', 'Peak charge', 'Total'].map((x, k) => h('th', { class: k ? 'r' : '' }, x)))),
      h('tbody', null, rows.map(({ p, bill }) => h('tr', { class: (p.id === best.p.id ? 'best ' : '') + (p.id === t.id ? 'on' : '') },
        h('td', null, p.name, p.id === t.id ? ' ← yours' : '', p.id === best.p.id ? ' ★ cheapest now' : ''), h('td', { class: 'r' }, rm(bill.energy + bill.afa)), h('td', { class: 'r' }, rm(bill.md)), h('td', { class: 'r' }, rm(bill.total)))))),
    h('p', { class: 'tiny', style: 'margin-top:10px' }, 'Legacy rows show what the old (pre-July 2025) tariffs would have cost — useful to see how RP4 changed the peak charge.'));

  // ---- history ----
  const { box, canvas } = chartBox();
  afterMount(() => make(canvas, 'bar', { labels: MONTHS_SHORT, datasets: [
    { type: 'bar', label: 'Energy + fuel adj.', data: c.billsAct.map((x) => Math.round(x.energy + x.afa)), backgroundColor: COL.sky, borderRadius: 4, stack: 's' },
    { type: 'bar', label: 'Peak charge', data: c.billsAct.map((x) => Math.round(x.md)), backgroundColor: COL.orange, borderRadius: 4, stack: 's' },
    { type: 'bar', label: 'Fixed + other', data: c.billsAct.map((x) => Math.round(x.retail + x.other)), backgroundColor: '#B9A8F5', borderRadius: 4, stack: 's' },
    { type: 'line', label: 'GridCast estimate', data: c.billsFc.map((x) => Math.round(x.total)), borderColor: COL.ink, borderWidth: 2.6, pointRadius: 3, pointBackgroundColor: COL.ink, tension: .3 }] },
  { scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: 'RM' } } } }));
  const dl = () => csvDownload('gridcast_bills.csv', [['Month', 'kWh', 'MD kW', 'Energy RM', 'AFA RM', 'Capacity RM', 'Network RM', 'Retail RM', 'Other RM', 'Total RM', 'Forecast total RM'],
    ...c.billsAct.map((x, k) => [MONTHS[k], x.kwh, x.mdKw, x.energy, x.afa, x.capacity, x.network, x.retail, x.other, x.total, c.billsFc[k].total])]);

  return h('div', null, section('Your bill', 'What you pay each month, and why.'), monthSelect(),
    h('div', { class: 'grid g-hero', style: 'margin-top:18px' }, hero, money),
    section('The itemised bill'), h('div', { class: 'grid g2' }, items, cmp),
    section('Twelve months', 'Bars are what the meter says you owe. The dark line is what GridCast predicted.'), card('', box),
    h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn ghost small', onclick: dl }, 'Download as CSV')));
}
