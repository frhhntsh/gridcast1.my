// Pages: Savings, Alerts, Behind the scenes (AI)
import { h, nf, rm, kw, fmtHour, fmtDate } from './dom.js';
import { S, ctx, dr, saveSettings, jumpTo } from './store.js';
import { monthAlerts, MONTHS, MONTHS_SHORT, dayIdxToDate } from './engine.js';
import { make, afterMount, ranges, COL } from './charts.js';
import { hooks, section, card, stat, callout, chartBox, monthSelect, seg, slider, FEATURE_NAMES, csvDownload } from './ui.js';

const STRATS = {
  shift: ['Shift to quiet hours', 'Move flexible usage (pre-cooling, pumps, EV charging) out of the busy hours and into the quiet ones. Energy is kept — just moved.'],
  curtail: ['Switch off for a while', 'Pause non-essential equipment during your busiest hours. The energy is saved, but comfort or output may dip a little.'],
  cap: ['Stay under a limit', 'Set a ceiling just below this month’s peak and push anything above it into quiet hours.'],
};
const set = (k, v) => { S.settings[k] = v; saveSettings(); hooks.rerender(); };

// ===========================================================================
// SAVINGS
// ===========================================================================
export function pageSavings() {
  const c = ctx(), s = S.settings, m = S.month, tl = c.tl, t = c.tariff;
  const r = dr(s.strategy), base = c.billsFc[m], after = r.bills[m];
  const saving = base.total - after.total, pctSave = base.total ? saving / base.total * 100 : 0;
  const maxFlex = Math.round(s.peakKw * 0.5 / 10) * 10;

  const picks = h('div', { class: 'picks' }, Object.entries(STRATS).map(([k, [name, desc]]) =>
    h('button', { class: 'pick' + (k === s.strategy ? ' on' : ''), onclick: () => set('strategy', k) }, h('b', null, name), h('span', null, desc))));

  const controls = h('div', { class: 'grid g2', style: 'margin-top:20px' },
    slider({ label: 'How much power can you move or switch off?', min: 0, max: maxFlex, step: 10, value: Math.min(s.flexKw, maxFlex), fmt: (v) => kw(v), onChange: (v) => set('flexKw', v),
      hint: 'Think chillers on a timer, water pumps, EV chargers, back-of-house equipment.' }),
    slider({ label: 'For how many hours a day?', min: 1, max: 8, step: 1, value: s.flexHours, fmt: (v) => `${v} h`, onChange: (v) => set('flexHours', v) }));
  const more = h('details', { class: 'fold' }, h('summary', null, 'More options'),
    h('div', { class: 'grid g2' },
      slider({ label: 'Extra energy when catching up', min: 0, max: 20, step: 1, value: s.reboundPct, fmt: (v) => v + '%', onChange: (v) => set('reboundPct', v), hint: 'Pre-cooling and catch-up usually cost a little extra.' }),
      slider({ label: '“Stay under a limit”: how far below this month’s peak?', min: 1, max: 30, step: 1, value: s.capPct, fmt: (v) => v + '%', onChange: (v) => set('capPct', v) })));

  const result = saving > 0.5
    ? h('div', { class: 'saving' }, h('div', { class: 'label' }, `You could save in ${MONTHS[m]}`), h('div', { class: 'big' }, rm(saving), h('small', { style: 'font-size:22px;margin-left:10px;color:#0D7A67' }, `${nf(pctSave, 1)}%`)),
      h('p', { style: 'margin-top:10px;font-size:16px' }, `Your peak drops from `, h('b', null, kw(base.mdKw)), ' to ', h('b', null, kw(after.mdKw)), ` and the bill from `, h('b', null, rm(base.total)), ' to ', h('b', null, rm(after.total)), '.'),
      h('div', { class: 'hand', style: 'margin-top:8px' }, 'that’s real money'))
    : card('peach', h('h3', null, 'No saving with these settings'), h('p', null, 'These settings don’t lower this month’s single highest peak, and the peak charge only moves when the highest one does. Try more power, more hours, or “Stay under a limit”.'));

  // day picture
  const s0 = tl.monthStartDay[m], nd = tl.daysInMonth[m];
  let day = S.savDay;
  if (day == null || day < s0 || day >= s0 + nd) {
    let best = s0, bv = -1;
    for (let d = s0; d < s0 + nd; d++) for (let k = 0; k < 24; k++) { const j = d * 24 + k; if (c.mdmask[j] && c.fcKw[j] > bv) { bv = c.fcKw[j]; best = d; } }
    day = S.savDay = best;
  }
  const a0 = day * 24;
  const { box, canvas } = chartBox();
  afterMount(() => make(canvas, 'line', { labels: Array.from({ length: 24 }, (_, k) => fmtHour(k).replace('\u00A0', ' ')), datasets: [
    { label: 'Before', data: Array.from({ length: 24 }, (_, k) => Math.round(c.fcKw[a0 + k])), borderColor: COL.ink, borderWidth: 3, pointRadius: 0, tension: .35 },
    { label: 'After', data: Array.from({ length: 24 }, (_, k) => Math.round(r.out[a0 + k])), borderColor: COL.ok, backgroundColor: 'rgba(31,163,138,.14)', borderWidth: 3.4, pointRadius: 0, tension: .35 }] },
  { plugins: { peakBands: { ranges: ranges(c.pmask, a0, a0 + 24), label: 'peak hours' } },
    scales: { y: { title: { display: true, text: 'kW' } } } }));
  const daySel = h('label', { class: 'field', style: 'max-width:240px' }, h('span', null, 'Show day'),
    h('select', { class: 'sel', onchange: (e) => { S.savDay = +e.target.value; hooks.rerender(); } },
      Array.from({ length: nd }, (_, k) => h('option', { value: s0 + k, selected: s0 + k === day }, fmtDate(dayIdxToDate(s0 + k).getTime(), true)))));

  // compare strategies
  const comp = Object.keys(STRATS).map((k) => ({ k, name: STRATS[k][0], save: base.total - dr(k).bills[m].total }));
  const { box: b2, canvas: c2 } = chartBox('short');
  afterMount(() => make(c2, 'bar', { labels: comp.map((x) => x.name), datasets: [{ label: 'Saving (RM)', data: comp.map((x) => Math.round(x.save)), backgroundColor: comp.map((x) => (x.k === s.strategy ? COL.orange : COL.sky)), borderRadius: 8 }] },
    { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: `RM saved in ${MONTHS[m]}` }, beginAtZero: true }, y: { grid: { display: false } } } }));

  // all months
  const tot = c.billsFc.reduce((a, x, k) => a + (x.total - r.bills[k].total), 0);
  const yr = h('details', { class: 'fold', style: 'margin-top:18px' }, h('summary', null, `Month by month — about ${rm(tot)} over the year`),
    h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Month', 'Before', 'After', 'Saving'].map((x, k) => h('th', { class: k ? 'r' : '' }, x)))),
      h('tbody', null, c.billsFc.map((x, k) => h('tr', null, h('td', null, MONTHS[k]), h('td', { class: 'r' }, rm(x.total)), h('td', { class: 'r' }, rm(r.bills[k].total)), h('td', { class: 'r good' }, rm(x.total - r.bills[k].total)))))));

  return h('div', null,
    section('Plan your savings', 'Try a way to save and see what it would do to the bill. Nothing is switched automatically — you decide.'), monthSelect(),
    h('div', { class: 'sec', style: 'margin-top:22px' }, h('div', { class: 'hand' }, 'step 1 — pick a way to save')), picks,
    h('div', { class: 'sec', style: 'margin-top:26px' }, h('div', { class: 'hand' }, 'step 2 — how much can you flex?')), controls, more,
    h('div', { class: 'sec', style: 'margin-top:26px' }, h('div', { class: 'hand' }, 'step 3 — what it’s worth')), result,
    section('What a busy day looks like', 'The green line is the same day after your change. The orange band is when the peak charge is measured.'), daySel, card('', box),
    section('Which way saves most?', 'Using your power and hours settings.'), card('', b2), yr,
    h('p', { class: 'tiny', style: 'margin-top:14px' }, `Calculated on GridCast’s forecast for ${MONTHS[m]} under ${t.name}. Energy is conserved when shifting; “switch off” removes it.`));
}

// ===========================================================================
// ALERTS
// ===========================================================================
export function pageAlerts() {
  const c = ctx(), m = S.month, t = c.tariff;
  const r = monthAlerts(c, m);
  const precision = r.total ? r.tp / r.total * 100 : null, recall = r.nReal ? r.tp / r.nReal * 100 : null;
  const slideM = slider({ label: 'How early should GridCast warn you?', min: 0, max: 15, step: 1, value: S.settings.margin, fmt: (v) => `${v}% below peak`, onChange: (v) => set('margin', v),
    hint: 'Higher = more warnings, earlier. Lower = only when it’s really close.' });
  const rowsEl = r.alerts.slice(0, 14).map((a) => h('div', { class: 'row' },
    h('div', null, h('b', null, `${fmtDate(dayIdxToDate(Math.floor(a.i / 24)).getTime(), true)} · ${fmtHour(a.i % 24)}`),
      h('span', { class: 'tiny' }, `Expected ${kw(a.fc)} vs month’s highest ${kw(a.run)} — `, a.real ? 'and it really did set a new high.' : 'it stayed just under.')),
    h('span', { class: 'tag ' + (a.hard ? 'alert' : 'watch') }, a.hard ? 'Peak alert' : 'Getting high')));
  const replay = () => { const first = r.alerts.filter((a) => a.hard).sort((x, y) => x.i - y.i)[0]; if (!first) return hooks.toast('No hard alerts this month'); jumpTo(Math.floor(first.i / 24), (first.i % 24) - 3 < 0 ? 0 : (first.i % 24) - 3); S.clock.playing = true; hooks.go('today'); };
  return h('div', null, section('Peak alerts', 'Moments when GridCast expected demand to reach, or come close to, this month’s highest level.'),
    h('div', { style: 'display:flex;gap:20px;align-items:flex-end;flex-wrap:wrap' }, monthSelect(), h('button', { class: 'btn small', onclick: replay }, '▶  Replay this month’s first alert')),
    h('div', { class: 'grid g3', style: 'margin-top:20px' },
      stat('Alerts raised', nf(r.total), `in ${MONTHS[m]}`, 'peach'),
      stat('New peaks caught', recall == null ? '—' : nf(recall) + '%', recall == null ? 'No new peaks were set after day 1' : `${r.tp} of ${r.nReal} real new highs were flagged in time`, 'lilac'),
      stat('Alerts that were real', precision == null ? '—' : nf(precision) + '%', 'The rest were “better safe than sorry”.', 'sky')),
    section('Recent alerts'), r.alerts.length ? h('div', null, rowsEl, r.alerts.length > 14 ? h('p', { class: 'tiny' }, `…and ${r.alerts.length - 14} more earlier in the month.`) : null)
      : card('sky', h('p', null, 'No alerts this month — demand stayed comfortably below the monthly high.')),
    section('Tune it'), card('', slideM),
    h('details', { class: 'fold', style: 'margin-top:16px' }, h('summary', null, 'How do alerts work?'),
      h('p', { style: 'padding-bottom:14px' }, `Every hour GridCast forecasts the next hour using only readings that already exist. If the forecast is near or above the highest ${t.mdPeakOnly ? `peak-period (${fmtHour(t.peakStart)}–${fmtHour(t.peakEnd)}, weekdays)` : ''} demand recorded so far this month, it raises an alert — because a new monthly high raises the peak charge for the whole month.`)));
}

// ===========================================================================
// BEHIND THE SCENES
// ===========================================================================
export function pageAI() {
  const d = S.data, B = d.benchmark, s = S.settings, models = d.meta.models;
  const T = B.test, V = B.validation, P = B.peak, boot = B.xgb_vs_lgbm_bootstrap;
  const f1 = (x) => nf(x, 1), f2 = (x) => nf(x, 2);
  const steps = h('div', { class: 'steps' },
    [['Read the meter', 'Hourly demand plus daily weather flows in. Gaps, spikes and impossible values are cleaned first.'],
      ['Learn the habits', 'Models learn how your hour-of-day, day-of-week, last hour, yesterday and the weather shape demand.'],
      ['Forecast the next hour', 'Every hour: what will demand be, and how sure are we? You get a range, not just a number.'],
      ['Suggest a move', 'If a new monthly peak looms, GridCast tells you what to pause and what it’s worth in ringgit.']]
      .map(([t, p], k) => h('div', { class: 'st' }, h('div', { class: 'no' }, k + 1), h('b', null, t), h('span', { class: 'tiny' }, p))));

  const rowsT = [...models, 'Naive (lag-1)', 'Seasonal naive (lag-24)', 'Seasonal naive (lag-168)'];
  const table = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Model', 'MAE (MW)', 'RMSE (MW)', 'MAPE', 'R²', 'Peak-hour F1', ''].map((x, k) => h('th', { class: k && k < 6 ? 'r' : '' }, x)))),
    h('tbody', null, rowsT.map((n) => {
      const isModel = models.includes(n), best = n === B.best_test_single;
      return h('tr', { class: n === s.model ? 'on' : (best ? 'best' : '') }, h('td', null, n, best ? ' ★' : ''), h('td', { class: 'r' }, f2(T[n].MAE)), h('td', { class: 'r' }, f2(T[n].RMSE)), h('td', { class: 'r' }, f2(T[n]['MAPE_%']) + '%'),
        h('td', { class: 'r' }, nf(T[n].R2, 4)), h('td', { class: 'r' }, nf(P[n]['Peak-hour F1'], 3)),
        h('td', null, isModel ? h('button', { class: 'chipbtn' + (n === s.model ? ' accent' : ''), onclick: () => set('model', n) }, n === s.model ? 'In use' : 'Use this') : ''));
    })));

  const why = card('lilac tilt', h('h3', null, 'Why XGBoost?'),
    h('p', { style: 'margin-top:6px' }, h('b', null, 'It was the most accurate single model on the 2021 test year'), ` — MAE ${f2(T.XGBoost.MAE)} MW vs ${f2(T.LightGBM.MAE)} for LightGBM and ${f2(T.CatBoost.MAE)} for CatBoost. `,
      `The gap to LightGBM is small (about ${nf((T.LightGBM.RMSE / T.XGBoost.RMSE - 1) * 100, 1)}%) but consistent: XGBoost wins on ${nf(boot.mae.share_days_A_better * 100)}% of days, and the 95% bootstrap range for the difference (${f2(boot.mae.ci95[0])} to ${f2(boot.mae.ci95[1])} MW) stays above zero.`),
    h('p', { style: 'margin-top:10px' }, h('b', null, 'Where did LightGBM come from earlier? '), `An earlier “auto-pick” used only two validation folds inside 2020. There LightGBM led on RMSE by ${nf((V.XGBoost.RMSE / V.LightGBM.RMSE - 1) * 100, 1)}% while XGBoost led on MAE — a coin-flip. Two folds can’t settle it, so GridCast now shows every model and defaults to the proposal’s rule: best on the held-out test year.`),
    h('p', { style: 'margin-top:10px' }, h('b', null, 'Bonus: '), `averaging XGBoost and LightGBM does slightly better still (RMSE ${f2(T[models[3]].RMSE)} MW). It’s one click away in the table.`));

  const c1 = chartBox('short'), c2 = chartBox('short'), c3 = chartBox('short');
  const cols = { XGBoost: COL.orange, CatBoost: COL.sky, LightGBM: COL.purple };
  afterMount(() => {
    make(c1.canvas, 'line', { labels: Array.from({ length: 24 }, (_, k) => k), datasets: models.map((n, k) => ({ label: n, data: B.hourly_mae[n], borderColor: cols[n] || COL.ok, borderWidth: n === s.model ? 3.4 : 1.8, pointRadius: 0, tension: .3 })) },
      { scales: { x: { title: { display: true, text: 'hour of day' } }, y: { title: { display: true, text: 'MAE (MW)' } } } });
    make(c2.canvas, 'line', { labels: MONTHS_SHORT, datasets: models.map((n) => ({ label: n, data: B.monthly_mape[n].map((v) => +v.toFixed(2)), borderColor: cols[n] || COL.ok, borderWidth: n === s.model ? 3.4 : 1.8, pointRadius: 2, tension: .3 })) },
      { scales: { y: { title: { display: true, text: 'MAPE (%)' } } } });
    const imp = Object.entries(B.importance_xgb).slice(0, 10);
    make(c3.canvas, 'bar', { labels: imp.map(([k]) => FEATURE_NAMES[k] || k), datasets: [{ data: imp.map(([, v]) => +(v * 100).toFixed(1)), backgroundColor: COL.orange, borderRadius: 6 }] },
      { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'share of the model’s decisions (%)' } }, y: { grid: { display: false }, ticks: { autoSkip: false } } } });
  });

  const q = d.data_quality;
  const links = [['TNB — Understand your tariff (RP4 mapping, ToU hours, fuel adjustment)', 'https://www.mytnb.com.my/business/understand-your-bill'],
    ['Energy Commission — current TNB tariff schedule (jadual tarif)', 'https://myenergystats.st.gov.my/documents/d/guest/jadual-tarif-tnb-terkini'],
    ['Trexon — RP4 medium-voltage guide (AFA, worked examples; secondary source)', 'https://trexon.my/guides/tnb-medium-voltage-tariff-rp4'],
    ['Dataset — Jawad et al. (2024), Data in Brief 52, 109788', 'https://doi.org/10.1016/j.dib.2023.109788']];

  return h('div', null, section('Behind the scenes', 'For lecturers, analysts and the curious: how GridCast is built and how well it performs.'),
    steps,
    section('The scoreboard', `All models trained on 2020 and tested on the unseen 2021 year. ★ = best single model. Click “Use this” to switch the whole dashboard.`),
    card('', h('div', { style: 'overflow-x:auto' }, table), h('p', { class: 'tiny', style: 'margin-top:10px' }, 'Errors are in MW because the research data is a whole utility network; the dashboard rescales to your building. Peak-hour = demand ≥ the 90th percentile of the training year.')),
    h('div', { class: 'grid g-wide', style: 'margin-top:20px' }, why, card('', h('h3', null, 'Hour of day: where each model errs'), c1.box)),
    h('div', { class: 'grid g2', style: 'margin-top:20px' }, card('', h('h3', null, 'Month by month (MAPE)'), c2.box), card('', h('h3', null, 'What the forecast leans on'), c3.box)),
    section('Data & assumptions'),
    h('div', { class: 'grid g2' },
      card('', h('h3', null, 'Cleaning report'), h('div', null, Object.entries(q).map(([k, v]) => h('div', { class: 'line' }, h('span', null, k), h('b', null, nf(v)))))),
      card('', h('h3', null, 'Please note'), h('ul', { style: 'padding-left:18px;margin:8px 0 0;display:grid;gap:8px' }, [
        'Demo building = the SEWA utility load (Sharjah, 2021) rescaled to your building’s peak. Real deployment trains on your own smart-meter history.',
        'Forecasts are one hour ahead and use the real reading from the previous hour. Weather is the daily value in the dataset (a stand-in for a weather forecast).',
        'Peak charge uses hourly averages; TNB uses the highest half-hour, so real peaks are slightly higher.',
        'Tariff rates follow the RP4 schedule effective 1 Jul 2025. AFA changes monthly — update it in Settings. Public holidays aren’t treated as off-peak.',
        'GridCast advises; it never switches equipment.'].map((x) => h('li', null, x))))),
    h('div', { style: 'margin-top:20px' }, card('peach tilt2', h('h3', null, 'Sources'), h('ul', { style: 'padding-left:18px;margin:8px 0 0;display:grid;gap:6px' }, links.map(([t, u]) => h('li', null, h('a', { href: u, target: '_blank', rel: 'noopener' }, t)))))),
    h('div', { style: 'margin-top:20px' }, card('sky', h('h3', null, 'Connecting a real building'), h('p', { style: 'margin-top:6px' }, 'The next step after the demo: export 12+ months of half-hourly data from the building’s TNB smart meter (AMR), run it through the same training pipeline, and GridCast serves forecasts for that building instead of the demo data. Nothing else in this app changes.'))));
}
