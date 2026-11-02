// Page: What-if studio — "what happens if we turn the aircond down at certain hours?"
import { h, nf, rm, kw, fmtHour, fmtDate } from './dom.js';
import { S, ctx, saveSettings } from './store.js';
import { applyScenario, indoorProfile, outdoorTemp, monthlyBills, MONTHS, dayIdxToDate } from './engine.js';
import { make, afterMount, ranges, COL } from './charts.js';
import { hooks, section, card, stat, callout, chartBox, monthSelect, seg, slider } from './ui.js';

const setScn = (patch) => { Object.assign(S.settings.scn, patch); S.plan = null; saveSettings(); hooks.rerender(); };
const hrs = (a, b) => { const n = b - a; return `${fmtHour(a)} → ${fmtHour(b % 24 === 0 && b === 24 ? 0 : b)} (${n} h)`; };

const PRESETS = [
  ['Aircond off, 2–4 PM', { start: 14, end: 16, cutPct: 100, catchupPct: 30, catchupHours: 3 }],
  ['Setpoint +2 °C, 2–6 PM', { start: 14, end: 18, cutPct: 12, catchupPct: 30, catchupHours: 4 }],
  ['Trim 30%, 2–6 PM', { start: 14, end: 18, cutPct: 30, catchupPct: 30, catchupHours: 4 }],
  ['Off late evening, 8–10 PM', { start: 20, end: 22, cutPct: 100, catchupPct: 30, catchupHours: 3 }],
];

function run(c, sc, month) {
  const r = applyScenario(c.fcKw, c.tl, sc);
  const bills = monthlyBills(r.out, c.tl, c.pmask, c.mdmask, c.tariff);
  return { r, bills, b0: c.billsFc[month], b1: bills[month] };
}
function peakHour(c, arr, month) {
  const s = c.tl.monthStartDay[month] * 24, e = s + c.tl.daysInMonth[month] * 24; let best = s;
  for (let i = s; i < e; i++) if (c.mdmask[i] && arr[i] > arr[best]) best = i;
  return best % 24;
}
/** Search window position × depth × restart-spread for the biggest saving that keeps the room under the comfort limit. */
function wxSource(sc) {
  if (sc.wxMode === 'demo') return S.data.weather_daily;
  return { tmax: new Array(365).fill(33), tmin: new Array(365).fill(25) }; // typical Malaysian day: 25–33 °C
}
function bestPlan(c, sc, month, day) {
  const dur = sc.end - sc.start, b0 = c.billsFc[month], wx = wxSource(sc); let best = null;
  for (let st = 6; st + dur <= 24; st++) for (let cut = 10; cut <= 100; cut += 10) for (let sp = 2; sp <= 6; sp++) {
    const o = { ...sc, start: st, end: st + dur, cutPct: cut, catchupHours: sp };
    const T = indoorProfile(wx, c.tl, day, o); if (Math.max(...T) > sc.limitC + 1e-9) continue;
    const r = applyScenario(c.fcKw, c.tl, o), b = monthlyBills(r.out, c.tl, c.pmask, c.mdmask, c.tariff)[month], saving = b0.total - b.total;
    if (saving > (best ? best.saving : 0)) best = { ...o, saving, md: b.mdKw, maxT: Math.max(...T) };
  }
  return best;
}

export function pageWhatIf() {
  const c = ctx(), s = S.settings, sc = s.scn, m = S.month, tl = c.tl, t = c.tariff, wx = wxSource(sc);
  const s0 = tl.monthStartDay[m], nd = tl.daysInMonth[m];
  if (S.whatDay == null || S.whatDay < s0 || S.whatDay >= s0 + nd) {
    let best = s0, bv = -1;
    for (let d = s0; d < s0 + nd; d++) { if (sc.weekdaysOnly && tl.dow[d * 24] >= 5) continue; for (let k = 0; k < 24; k++) { const j = d * 24 + k; if (c.mdmask[j] && c.fcKw[j] > bv) { bv = c.fcKw[j]; best = d; } } }
    S.whatDay = best;
  }
  const day = S.whatDay, a0 = day * 24;
  const { r, bills, b0, b1 } = run(c, sc, m);
  const T = indoorProfile(wx, tl, day, sc), Tmax = Math.max(...T), Tpk = T.indexOf(Tmax);
  const over = T.filter((v) => v > sc.limitC + 1e-9).length;
  const saving = b0.total - b1.total, mdDelta = b1.mdKw - b0.mdKw, kwhDelta = b1.kwh - b0.kwh;
  const ph0 = peakHour(c, c.fcKw, m), ph1 = peakHour(c, r.out, m);
  const yearSave = c.billsFc.reduce((a, x, k) => a + x.total - bills[k].total, 0);
  const dayApplies = !(sc.weekdaysOnly && tl.dow[a0] >= 5);
  const touches = c.tariff.mdPeakOnly ? (sc.start < t.peakEnd && sc.end > t.peakStart) : true;

  // ------------------------------------------------------------------ controls
  const presets = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px' },
    PRESETS.map(([label, patch]) => h('button', { class: 'chipbtn', onclick: () => setScn(patch) }, label)));
  const perDeg = sc.perDeg;
  const controls = card('', h('div', { class: 'label' }, 'Try a scenario'), h('div', { style: 'margin:10px 0 6px' }, presets),
    h('div', { class: 'grid g2', style: 'margin-top:14px' },
      slider({ label: 'From', min: 0, max: 23, value: sc.start, fmt: (v) => fmtHour(v), onChange: (v) => setScn({ start: v, end: Math.max(sc.end, v + 1) }) }),
      slider({ label: 'Until', min: 1, max: 24, value: sc.end, fmt: (v) => (v === 24 ? '12 AM' : fmtHour(v)), onChange: (v) => setScn({ end: v, start: Math.min(sc.start, v - 1) }) })),
    slider({ label: 'How much of the aircond do you cut?', min: 0, max: 100, step: 5, value: sc.cutPct, fmt: (v) => (v === 100 ? 'Off' : v + '%'), onChange: (v) => setScn({ cutPct: v }),
      hint: `Quick picks: raising the setpoint ≈ ${perDeg}% less cooling per °C (rule of thumb — you can change it under More options).` }),
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 14px' }, [['Off', 100], ['+1 °C', perDeg], ['+2 °C', 2 * perDeg], ['+3 °C', 3 * perDeg]].map(([l, v]) => h('button', { class: 'chipbtn' + (sc.cutPct === v ? ' accent' : ''), onclick: () => setScn({ cutPct: v }) }, l))),
    slider({ label: 'When it comes back on, how many hours do you stagger the restart?', min: 1, max: 6, value: sc.catchupHours, fmt: (v) => `${v} h`, onChange: (v) => setScn({ catchupHours: v }),
      hint: 'A sudden restart makes every chiller work flat out at once — that “snap-back” can create a new peak.' }),
    h('div', { class: 'grid g2' },
      h('div', { class: 'field' }, h('span', null, 'Which days?'), seg([['wk', 'Weekdays'], ['all', 'Every day']], sc.weekdaysOnly ? 'wk' : 'all', (v) => setScn({ weekdaysOnly: v === 'wk' }))),
      monthSelect()),
    h('details', { class: 'fold' }, h('summary', null, 'More options (assumptions)'),
      h('div', { class: 'grid g2' },
        slider({ label: 'Aircond share of building load', min: 20, max: 70, value: sc.acShare, fmt: (v) => v + '%', onChange: (v) => setScn({ acShare: v }), hint: 'Use your chiller sub-meter if you have one. Offices in hot climates are often around half.' }),
        slider({ label: 'Energy that comes back after', min: 0, max: 60, step: 5, value: sc.catchupPct, fmt: (v) => v + '%', onChange: (v) => setScn({ catchupPct: v }), hint: 'Share of the saved energy that must be made up when cooling resumes.' }),
        slider({ label: 'Aircond setpoint', min: 22, max: 26, value: sc.setC, fmt: (v) => v + ' °C', onChange: (v) => setScn({ setC: v }) }),
        slider({ label: 'Comfort limit', min: 25, max: 29, value: sc.limitC, fmt: (v) => v + ' °C', onChange: (v) => setScn({ limitC: v }) }),
        slider({ label: '% cooling cut per +1 °C setpoint', min: 3, max: 12, value: sc.perDeg, fmt: (v) => v + '%', onChange: (v) => setScn({ perDeg: v }) })),
      h('div', { class: 'field' }, h('span', null, 'How quickly does the building warm up?'), seg([[3, 'Light glass tower'], [6, 'Typical'], [10, 'Heavy concrete']], sc.tau, (v) => setScn({ tau: v }))),
      h('div', { class: 'field' }, h('span', null, 'Outdoor weather for the room model'), seg([['my', 'Typical Malaysia 25–33 °C'], ['demo', 'Demo data (hot desert)']], sc.wxMode || 'my', (v) => setScn({ wxMode: v })), h('small', null, 'The research dataset is from the UAE, so by default the room model uses a typical Malaysian day.'))));

  // ------------------------------------------------------------------ results
  const good = saving > 0.5, tone = good ? (over ? 'watch' : 'ok') : 'alert';
  const sticker = !good ? 'Costs you money' : over ? 'Saves, but too warm' : 'Good trade';
  const rebound = mdDelta > 1 && ph1 >= sc.end;
  const resCards = h('div', { class: 'grid g4' },
    h('div', { class: 'card ' + (good ? 'sky' : 'peach') }, h('div', { class: 'label' }, `Bill · ${MONTHS[m]}`), h('div', { class: 'stat-big' }, (saving >= 0 ? '− ' : '+ ') + rm(Math.abs(saving))),
      h('div', { class: 'stat-sub' }, `${rm(b0.total)} → ${rm(b1.total)}`)),
    stat('Peak charge level', kw(b1.mdKw), mdDelta === 0 ? 'unchanged' : h('span', { class: mdDelta < 0 ? 'good' : 'bad' }, `${mdDelta < 0 ? '▼' : '▲'} ${kw(Math.abs(mdDelta))} vs ${kw(b0.mdKw)}`)),
    stat('Energy used', `${nf(Math.abs(kwhDelta))} kWh`, kwhDelta <= 0 ? h('span', { class: 'good' }, `less than before (${nf(Math.abs(kwhDelta / b0.kwh) * 100, 1)}%)`) : h('span', { class: 'bad' }, 'more than before')),
    h('div', { class: 'card ' + (over ? 'peach' : 'lilac') }, h('div', { class: 'label' }, 'Warmest the room gets'), h('div', { class: 'stat-big' }, `${nf(Tmax, 1)} °C`),
      h('div', { class: 'stat-sub' }, dayApplies ? (Tmax <= sc.setC + 0.05 ? 'stays at setpoint' : `around ${fmtHour(Tpk + 1)}${over ? ` · ${over} h over your ${sc.limitC} °C limit` : ' · within your limit'}`) : 'selected day is not affected')));

  const verdictBits = [];
  if (!touches) verdictBits.push(`Your window (${fmtHour(sc.start)}–${sc.end === 24 ? '12 AM' : fmtHour(sc.end)}) falls outside the period your peak charge is measured (${fmtHour(t.peakStart)}–${fmtHour(t.peakEnd)}), so it can only save energy, not the peak charge.`);
  if (rebound) verdictBits.push(`<b>Rebound warning:</b> when cooling resumes, demand snaps back and the month’s highest peak moves to <b>${fmtHour(ph1)}</b> and rises by <b>${kw(mdDelta)}</b>. Stagger the restart over more hours or end the cut later.`);
  else if (good && mdDelta < -1) verdictBits.push(`The monthly peak drops by <b>${kw(-mdDelta)}</b>, worth about <b>${rm(-mdDelta * c.mdRate * (1 + t.otherPct / 100))}</b> in peak charge.`);
  if (over) verdictBits.push(`The room reaches about <b>${nf(Tmax, 1)} °C</b> — ${over} hour${over > 1 ? 's' : ''} above your ${sc.limitC} °C comfort limit. Try a shallower cut over a longer window.`);
  if (good && !over && dayApplies) verdictBits.push('The room stays within your comfort limit.');
  verdictBits.push(yearSave >= 0 ? `Across the whole year this would be worth about <b>${rm(yearSave)}</b>.` : `Across the whole year this would cost you about <b>${rm(-yearSave)}</b> more.`);
  const verdict = h('div', { class: 'card', style: 'margin-top:20px' }, h('span', { class: 'sticker ' + tone, style: 'margin-bottom:12px' }, sticker),
    h('p', { style: 'margin-top:8px;font-size:16.5px;line-height:1.6', html: verdictBits.join(' ') }));

  // ------------------------------------------------------------------ charts
  const lab = Array.from({ length: 24 }, (_, k) => fmtHour(k).replace('\u00A0', ' '));
  const cA = chartBox(), cB = chartBox('short');
  const win = dayApplies ? [[sc.start, sc.end - 1]] : [];
  afterMount(() => {
    make(cA.canvas, 'line', { labels: lab, datasets: [
      { label: 'Before', data: Array.from({ length: 24 }, (_, k) => Math.round(c.fcKw[a0 + k])), borderColor: COL.ink, borderWidth: 3, pointRadius: 0, tension: .3 },
      { label: 'After your scenario', data: Array.from({ length: 24 }, (_, k) => Math.round(r.out[a0 + k])), borderColor: COL.ok, backgroundColor: 'rgba(31,163,138,.13)', fill: 0, borderWidth: 3.4, pointRadius: 0, tension: .3 }] },
    { plugins: { peakBands: { ranges: ranges(c.pmask, a0, a0 + 24), label: 'peak hours' }, windowBand: { ranges: win, label: 'your change' } }, scales: { y: { title: { display: true, text: 'kW' } } } });
    make(cB.canvas, 'line', { labels: lab, datasets: [
      { label: 'Indoor (estimate)', data: T.map((v) => +v.toFixed(2)), borderColor: over ? COL.alert : COL.orangeDeep, borderWidth: 3.2, pointRadius: 0, tension: .3 },
      { label: sc.wxMode === 'demo' ? 'Outdoor (demo data, hot desert)' : 'Outdoor (typical Malaysia)', data: Array.from({ length: 24 }, (_, k) => +outdoorTemp(wx, day, k + 0.5).toFixed(1)), borderColor: COL.sky, borderWidth: 2, borderDash: [5, 4], pointRadius: 0, tension: .3 }] },
    { plugins: { hline: { y: sc.limitC, label: 'comfort limit', color: COL.purple }, windowBand: { ranges: win } }, scales: { y: { title: { display: true, text: '°C' }, suggestedMin: sc.setC - 1 } } });
  });
  const daySel = h('label', { class: 'field', style: 'max-width:240px' }, h('span', null, 'Show day'),
    h('select', { class: 'sel', onchange: (e) => { S.whatDay = +e.target.value; hooks.rerender(); } },
      Array.from({ length: nd }, (_, k) => h('option', { value: s0 + k, selected: s0 + k === day }, fmtDate(dayIdxToDate(s0 + k).getTime(), true)))));

  // ------------------------------------------------------------------ best plan + pins
  const plan = S.plan;
  const planCard = card('lilac tilt2', h('h3', null, 'Not sure? Let GridCast find a better plan'),
    h('p', { class: 'tiny', style: 'margin:4px 0 12px' }, `Keeps the same ${sc.end - sc.start}-hour length, tries every start time, depth and restart speed, and keeps only plans that stay under ${sc.limitC} °C on the day shown.`),
    h('button', { class: 'btn small', onclick: () => { S.plan = bestPlan(c, sc, m, day) || 'none'; hooks.rerender(); } }, '✨ Find the best plan'),
    plan === 'none' ? h('p', { style: 'margin-top:12px' }, 'No plan of that length keeps the room under your limit and saves money. Try a shorter window or a higher comfort limit.')
      : plan ? h('div', { style: 'margin-top:14px' },
        h('p', { style: 'font-size:16px' }, plan.cutPct === 100 ? 'Turn the aircond ' : `Cut the aircond by ${plan.cutPct}% `, plan.cutPct === 100 ? h('b', null, 'off') : null, ' from ', h('b', null, fmtHour(plan.start)), ' to ', h('b', null, plan.end === 24 ? '12 AM' : fmtHour(plan.end)), ', restarting over ', h('b', null, `${plan.catchupHours} h`), '.'),
        h('p', { class: 'muted', style: 'margin-top:4px' }, `Saves about ${rm(plan.saving)} in ${MONTHS[m]} · peak ${kw(plan.md)} · room peaks at ${nf(plan.maxT, 1)} °C.`),
        h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn small', onclick: () => setScn({ start: plan.start, end: plan.end, cutPct: plan.cutPct, catchupHours: plan.catchupHours }) }, 'Apply this plan'))) : null);

  const label = `${sc.cutPct === 100 ? 'Off' : sc.cutPct + '% cut'} ${fmtHour(sc.start)}–${sc.end === 24 ? '12 AM' : fmtHour(sc.end)} · restart ${sc.catchupHours} h · ${sc.weekdaysOnly ? 'weekdays' : 'daily'}`;
  const pin = () => { if (S.pins.length >= 5) S.pins.shift(); S.pins.push({ label, month: MONTHS[m], saving, md: b1.mdKw, kwh: kwhDelta, maxT: Tmax, over }); hooks.rerender(); };
  const pins = card('', h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap' }, h('h3', null, 'Compare scenarios side by side'), h('button', { class: 'btn ghost small', onclick: pin }, '📌 Pin this scenario')),
    S.pins.length ? h('div', { style: 'overflow-x:auto;margin-top:10px' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Scenario', 'Month', 'Bill change', 'Peak (kW)', 'Warmest room', ''].map((x, k) => h('th', { class: k > 1 && k < 5 ? 'r' : '' }, x)))),
      h('tbody', null, S.pins.map((p, k) => h('tr', null, h('td', null, p.label), h('td', null, p.month), h('td', { class: 'r ' + (p.saving > 0 ? 'good' : 'bad') }, (p.saving >= 0 ? '− ' : '+ ') + rm(Math.abs(p.saving))), h('td', { class: 'r' }, nf(p.md)),
        h('td', { class: 'r ' + (p.over ? 'bad' : '') }, nf(p.maxT, 1) + ' °C'), h('td', null, h('button', { class: 'chipbtn', onclick: () => { S.pins.splice(k, 1); hooks.rerender(); } }, 'remove')))))))
      : h('p', { class: 'tiny', style: 'margin-top:8px' }, 'Set up a scenario, press “Pin”, change it, pin again — and compare them here. Handy for choosing a plan to show your boss.'));

  return h('div', null,
    section('What-if studio', 'Move the sliders and see what would happen to the bill, the peak charge and the room temperature — before you touch a single aircond.'),
    h('div', { class: 'grid g-wide', style: 'align-items:start' }, controls, h('div', { style: 'display:grid;gap:20px' }, planCard, card('sky', h('h3', null, 'How to read this'), h('ul', { style: 'padding-left:18px;margin:8px 0 0;display:grid;gap:7px;font-size:14.5px' }, [
      'The peak charge is set by ONE hour a month — cutting that hour matters far more than cutting energy overall.',
      'Turning the aircond fully off for a short spell often backfires: the room warms and the restart creates a bigger peak.',
      'Shallower cuts over longer windows, or cuts just after the peak, usually win. Try the presets, then “Find the best plan”.'].map((x) => h('li', null, x)))))),
    section('What changes', `${label} — ${MONTHS[m]}`), resCards, verdict,
    section('That day, hour by hour', 'Purple band = your change. Orange band = hours your peak charge is measured.'), daySel,
    h('div', { class: 'grid g-wide' }, card('', h('h3', null, 'Building demand'), cA.box), card('', h('h3', null, 'Room temperature (indicative)'), cB.box)),
    h('p', { class: 'tiny', style: 'margin:12px 0 18px' }, 'Assumptions: the aircond is a fixed share of building load (no sub-meter in the demo data); room temperature uses a simple one-room warm-up model driven by the demo weather, not a simulation of your building. Treat comfort numbers as a guide and tune them with your own readings.'),
    pins);
}
