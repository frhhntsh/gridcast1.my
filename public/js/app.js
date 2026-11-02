// GridCast.my – app shell: boot, header/nav, demo clock, settings drawer, onboarding, play loop.
import { h, fmtHour, fmtDate, isoDate, LOGO_SVG, nf } from './dom.js';
import { S, init, ctx, saveSettings, resetSettings, clockInfo, setClockDate, stepClock, jumpTo, findAlertMoment, findBusiestHour } from './store.js';
import { nextHourStatus, TARIFF_PRESETS, DAY_NAMES, MONTHS } from './engine.js';
import { destroyCharts, runMount } from './charts.js';
import { hooks } from './ui.js';
import { pageToday, pageUsage, pageBills } from './pages_main.js';
import { pageSavings, pageAlerts, pageAI } from './pages_more.js';
import { pageWhatIf } from './pages_whatif.js';

const PAGES = { today: ['Today', pageToday], usage: ['Usage', pageUsage], bills: ['Bills', pageBills], whatif: ['What-if', pageWhatIf], savings: ['Savings', pageSavings], alerts: ['Alerts', pageAlerts], ai: ['Behind the scenes', pageAI] };
const $ = (s) => document.querySelector(s);
let timer = null;

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------
hooks.toast = (msg) => {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 4200);
};

// ---------------------------------------------------------------------------
// header + nav
// ---------------------------------------------------------------------------
function header() {
  const c = ctx(), st = nextHourStatus(c, clockInfo().idx), s = S.settings;
  const nav = h('nav', { class: 'nav' }, Object.entries(PAGES).map(([k, [label]]) =>
    h('button', { class: S.page === k ? 'on' : '', onclick: () => hooks.go(k) }, label, k === 'alerts' && st.tone === 'alert' ? h('span', { class: 'dotbadge' }) : null)));
  return h('header', { class: 'top' }, h('div', { class: 'wrap top-inner' },
    h('a', { class: 'logo', href: '#', onclick: (e) => { e.preventDefault(); hooks.go('today'); } }, h('span', { html: LOGO_SVG }), h('span', { class: 'logo-word' }, 'GridCast', h('i', null, '.my'))),
    nav,
    h('button', { class: 'who', onclick: () => hooks.openSettings() }, h('span', { class: 'avatar' }, (s.managerName || '?').trim().charAt(0).toUpperCase()),
      h('span', null, s.building, h('small', null, 'Building settings')))));
}

// ---------------------------------------------------------------------------
// demo clock
// ---------------------------------------------------------------------------
const PLAY = '<svg viewBox="0 0 20 20"><path d="M5 3.5v13l11-6.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 20 20"><rect x="4.5" y="3.5" width="4" height="13" rx="1.2" fill="currentColor"/><rect x="11.5" y="3.5" width="4" height="13" rx="1.2" fill="currentColor"/></svg>';

function clockBar() {
  const c = S.clock, ci = clockInfo();
  const date = h('input', { type: 'date', value: isoDate(c.y, c.m, c.d), min: '2000-01-01', max: '2100-12-31', onchange: (e) => {
    const [y, m, d] = e.target.value.split('-').map(Number); if (!y) return; stopPlay(); setClockDate(y, m - 1, d); hooks.rerender(); } });
  const hourLabel = h('b', null, fmtHour(c.hour));
  const hr = h('input', { type: 'range', min: 0, max: 23, value: c.hour });
  hr.addEventListener('input', () => { hourLabel.textContent = fmtHour(+hr.value); });
  hr.addEventListener('change', () => { stopPlay(); S.clock.hour = +hr.value; hooks.rerender(); });
  const play = h('button', { class: 'btn-play', title: c.playing ? 'Pause' : 'Run the live demo', html: c.playing ? PAUSE : PLAY, onclick: () => (c.playing ? stopPlay(true) : startPlay()) });
  const speed = h('select', { onchange: (e) => { c.speed = +e.target.value; if (c.playing) { startPlay(); } } },
    [1, 2, 4].map((v) => h('option', { value: v, selected: v === c.speed }, v + '×')));
  const jump = (label, fn, accent) => h('button', { class: 'chipbtn' + (accent ? ' accent' : ''), onclick: () => { stopPlay(); fn(); hooks.rerender(); } }, label);
  const alertJump = () => {
    for (const m of [S.month, 5, 6, 7, 8, 4, 9, 3, 10, 2, 11, 1, 0]) { const i = findAlertMoment(m); if (i != null) { jumpTo(Math.floor(i / 24), i % 24); return; } }
    hooks.toast('No peak alert found in the demo year with these settings');
  };
  const today = () => { const n = new Date(); Object.assign(S.clock, { y: n.getFullYear(), m: n.getMonth(), d: n.getDate(), hour: n.getHours() }); S.month = clockInfo().month; };
  return h('div', { class: 'wrap' }, h('div', { class: 'clock' },
    h('div', { class: 'clock-tag' }, '⏱ demo clock'),
    play,
    h('div', null, h('div', { class: 'clock-read' }, `${fmtDate(ci.pickedMs, true)} · ${fmtHour(c.hour)}`)),
    h('label', null, 'Date — any day', date),
    h('label', null, h('span', null, 'Hour ', hourLabel), hr),
    h('label', null, 'Speed', speed),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: c.pauseOnAlert, onchange: (e) => { c.pauseOnAlert = e.target.checked; } }), 'pause on alert'),
    h('div', { class: 'jumps' }, jump('Jump to a peak alert', alertJump, true), jump('Busiest hour', () => { const i = findBusiestHour(S.month); jumpTo(Math.floor(i / 24), i % 24); }), jump('Now', today)),
    h('div', { class: 'clock-note' }, ci.exact
      ? 'Showing the demo building’s 2021 meter data. With a real meter connected, this clock is simply “now”.'
      : `Your date is matched to ${fmtDate(ci.demoMs, true)} 2021 — the same weekday in the demo meter data (the research dataset covers one year). With a real meter this would be live.`)));
}
function startPlay() {
  const c = S.clock; c.playing = true; clearInterval(timer);
  timer = setInterval(() => {
    stepClock(1);
    const st = nextHourStatus(ctx(), clockInfo().idx);
    if (c.pauseOnAlert && st.tone === 'alert') { stopPlay(false); hooks.toast(`⚠ Peak alert for ${fmtHour(c.hour)} – ${fmtHour(c.hour + 1)} — demo paused`); }
    hooks.rerender();
  }, 1500 / c.speed);
  hooks.rerender();
}
function stopPlay(rerender) { S.clock.playing = false; clearInterval(timer); if (rerender) hooks.rerender(); }

// ---------------------------------------------------------------------------
// settings form (shared by the drawer and the first-run welcome)
// ---------------------------------------------------------------------------
const persist = () => { saveSettings(); hooks.rerender(); };
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null);
const txt = (key, label, hint) => field(label, h('input', { type: 'text', value: S.settings[key], onchange: (e) => { S.settings[key] = e.target.value; persist(); } }), hint);
const num = (label, get, setv, { step = 1, min = 0, max, hint } = {}) => field(label, h('input', { type: 'number', value: get(), step, min, max, onchange: (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { setv(v); persist(); } } }), hint);
const TYPES = ['Office tower', 'Shopping mall', 'Hotel', 'Hospital', 'University / college', 'Data room / lab', 'Mixed-use', 'Other'];

function tariffEdit(t, markCustom) {
  const T = S.settings.tariff;
  const edit = (k, scale = 1) => (v) => { T[k] = v / scale; markCustom(); };
  return h('div', null,
    h('div', { class: 'grid g2' },
      num('Energy — peak (sen/kWh)', () => nf(T.energyPeak * 100, 2), edit('energyPeak', 100), { step: 0.01 }),
      num('Energy — off-peak (sen/kWh)', () => nf(T.energyOff * 100, 2), edit('energyOff', 100), { step: 0.01 }),
      num('Capacity charge (RM/kW)', () => T.capacity, edit('capacity'), { step: 0.01 }),
      num('Network charge (RM/kW)', () => T.network, edit('network'), { step: 0.01 }),
      num('Retail charge (RM/month)', () => T.retail, edit('retail'), { step: 1 }),
      num('Fuel adjustment AFA (sen/kWh)', () => T.afaSen, edit('afaSen'), { step: 0.01, hint: 'Changes monthly — check Single Buyer / TNB.' }),
      num('Other charges (%)', () => T.otherPct, edit('otherPct'), { step: 0.1, hint: 'e.g. KWTBB or service tax, if they apply to you.' }),
      h('div')),
    h('div', { class: 'grid g2' },
      num('Peak period starts (hour, 0–24)', () => T.peakStart, edit('peakStart'), { max: 24 }),
      num('Peak period ends (hour, 0–24)', () => T.peakEnd, edit('peakEnd'), { max: 24 })),
    h('label', { class: 'chk', style: 'margin:4px 0 12px' }, h('input', { type: 'checkbox', checked: T.mdPeakOnly, onchange: (e) => { T.mdPeakOnly = e.target.checked; markCustom(); } }), 'Peak charge measured in the peak period only (ToU)'),
    h('div', { class: 'field' }, h('span', null, 'Off-peak all day on'), h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, DAY_NAMES.map((d, k) => h('label', { class: 'chk' },
      h('input', { type: 'checkbox', checked: T.offDays.includes(k), onchange: (e) => { T.offDays = e.target.checked ? [...new Set([...T.offDays, k])] : T.offDays.filter((x) => x !== k); markCustom(); } }), d)))));
}

function settingsForm(full) {
  const s = S.settings;
  const tariffSel = h('select', { class: 'sel', onchange: (e) => {
    const id = e.target.value; if (id !== 'custom') s.tariff = { ...TARIFF_PRESETS[id] }; else s.tariff = { ...s.tariff, id: 'custom', name: 'Custom tariff' };
    persist(); if (drawerOpen) openSettings(true); } },
    [...Object.values(TARIFF_PRESETS), { id: 'custom', name: 'Custom tariff', note: 'Edited rates' }].map((t) => h('option', { value: t.id, selected: t.id === s.tariff.id }, `${t.name} — ${t.note}`)));
  const markCustom = () => { s.tariff.id = 'custom'; s.tariff.name = 'Custom tariff'; tariffSel.value = 'custom'; persist(); };
  const parts = [
    h('h3', { style: 'font-size:20px;margin:6px 0 12px' }, 'You'),
    h('div', { class: 'grid g2' }, txt('managerName', 'Your first name'), txt('company', 'Company')),
    h('h3', { style: 'font-size:20px;margin:10px 0 12px' }, 'Your building'),
    txt('building', 'Building name'),
    field('Building type', h('select', { class: 'sel', onchange: (e) => { s.type = e.target.value; persist(); } }, TYPES.map((t) => h('option', { selected: t === s.type }, t)))),
    num('Highest demand you normally reach (kW)', () => s.peakKw, (v) => { const old = s.peakKw; s.peakKw = v; s.flexKw = Math.max(10, Math.round((s.flexKw * v / old) / 10) * 10); }, { step: 50, min: 100, max: 50000, hint: 'Look at the “Maximum Demand” line on a past TNB bill. GridCast scales the demo meter data to this size.' }),
    h('h3', { style: 'font-size:20px;margin:10px 0 12px' }, 'Your tariff'),
    field('TNB tariff', tariffSel, 'Since 1 July 2025 TNB groups customers by voltage. Most commercial buildings are Medium Voltage.'),
  ];
  if (full) parts.push(
    h('details', { class: 'fold' }, h('summary', null, 'Edit tariff rates & peak hours'), tariffEdit(s.tariff, markCustom)),
    h('h3', { style: 'font-size:20px;margin:10px 0 12px' }, 'How flexible are you?'),
    h('div', { class: 'grid g2' }, num('Power you can move / switch off (kW)', () => s.flexKw, (v) => { s.flexKw = v; }, { step: 10 }), num('For how many hours a day', () => s.flexHours, (v) => { s.flexHours = v; }, { min: 1, max: 8 })),
    h('h3', { style: 'font-size:20px;margin:10px 0 12px' }, 'The forecast'),
    field('Forecast model', h('select', { class: 'sel', onchange: (e) => { s.model = e.target.value; persist(); } }, S.data.meta.models.map((m) => h('option', { value: m, selected: m === s.model }, m))), 'XGBoost is the default. Compare all models under “Behind the scenes”.'),
    h('div', { style: 'margin-top:18px;display:flex;gap:10px;flex-wrap:wrap' }, h('button', { class: 'btn ghost small', onclick: () => { resetSettings(); hooks.rerender(); openSettings(true); } }, 'Reset to demo building')));
  return h('div', null, ...parts);
}

// ---------------------------------------------------------------------------
// drawer + welcome
// ---------------------------------------------------------------------------
let drawerOpen = false;
function closeOverlay() { drawerOpen = false; $('#overlay').replaceChildren(); hooks.rerender(); }
function openSettings(keep) {
  drawerOpen = true;
  const scrollTop = keep ? ($('.drawer') || {}).scrollTop || 0 : 0;
  $('#overlay').replaceChildren(h('div', { class: 'scrim', onclick: closeOverlay }),
    h('aside', { class: 'drawer' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:12px' }, h('div', null, h('h2', null, 'Your building'), h('p', { class: 'muted' }, 'Everything in GridCast recalculates as you change these. Saved in this browser.')),
        h('button', { class: 'btn small', onclick: closeOverlay }, 'Done')),
      h('div', { style: 'margin-top:20px' }, settingsForm(true))));
  if (keep) $('.drawer').scrollTop = scrollTop;
}
hooks.openSettings = openSettings;

function welcome() {
  const done = () => { S.settings.onboarded = true; saveSettings(); $('#overlay').replaceChildren(); hooks.rerender(); };
  $('#overlay').replaceChildren(h('div', { class: 'scrim' }),
    h('div', { class: 'modal' },
      h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:6px' }, h('span', { html: LOGO_SVG, style: 'width:46px;display:block' }), h('div', { class: 'hand', style: 'font-size:26px' }, 'selamat datang!')),
      h('h2', { style: 'font-size:34px;line-height:1.1' }, 'Meet GridCast.'),
      h('p', { class: 'muted', style: 'margin:8px 0 18px;font-size:16px' }, 'It forecasts your building’s demand hour by hour, warns you before a costly monthly peak, and shows what you’d save by moving flexible loads. Tell us about your building — or just try the demo.'),
      settingsForm(false),
      h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:14px' }, h('button', { class: 'btn', onclick: done }, 'Show me my building'), h('button', { class: 'btn ghost', onclick: () => { resetSettings(); S.settings.onboarded = true; saveSettings(); done(); } }, 'Just try the demo')),
      h('p', { class: 'tiny', style: 'margin-top:12px' }, 'You can change all of this later from the building chip at the top right.')));
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function footer() {
  return h('footer', null, h('div', { class: 'wrap' },
    h('b', null, 'GridCast.my'), ' — AI load forecasting & demand-response decision support for Malaysian commercial buildings. A Final Year Project, Universiti Putra Malaysia.',
    h('br'), 'Demo data: SEWA hourly demand (2021), rescaled to your building. Tariff: TNB RP4 (from 1 Jul 2025). GridCast gives advice only and never switches equipment.'));
}
function render() {
  destroyCharts();
  const [, fn] = PAGES[S.page];
  const main = h('main', null, h('div', { class: 'wrap' }, fn()));
  $('#app').replaceChildren(header(), clockBar(), main, footer());
  runMount();
}
hooks.rerender = render;
hooks.go = (p) => { S.page = p; render(); window.scrollTo({ top: 0 }); };

async function boot() {
  try {
    const res = await fetch('data/gridcast_data.json'); if (!res.ok) throw new Error(res.status);
    init(await res.json());
  } catch (e) {
    $('#app').replaceChildren(h('div', { class: 'wrap', style: 'padding:80px 0' }, h('h1', null, 'Couldn’t load the forecast data'), h('p', { class: 'muted' }, 'Run the pipeline first (python pipeline/gridcast_pipeline.py --excel …) and serve this folder over http. ' + e)));
    return;
  }
  await (document.fonts ? document.fonts.ready : Promise.resolve());
  try { await Promise.all([document.fonts.load("700 20px Caveat"), document.fonts.load("600 20px Fraunces")]); } catch (e) { /* ignore */ }
  const i = findAlertMoment(5) ?? findBusiestHour(5);
  jumpTo(Math.floor(i / 24), i % 24);
  render();
  if (!S.settings.onboarded) welcome();
}
boot();
