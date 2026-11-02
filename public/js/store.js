// State, persistence and derived numbers (everything the pages need, computed once per change).
import { buildTimeline, peakMask, mdMaskFor, monthlyBills, applyDR, TARIFF_PRESETS, mapDateToDemo, dayIdxToDate, monthAlerts } from './engine.js';

const KEY = 'gridcast.v2';
export const S = {
  data: null, tl: null,
  settings: null,
  clock: { y: 2021, m: 5, d: 23, hour: 14, playing: false, speed: 1, pauseOnAlert: true },
  page: 'today', month: 5, usageView: 'day', usageDay: null, savMonth: null,
  _ctx: null, _ctxKey: '', _dr: {}, pins: [], whatDay: null, plan: null,
};

export const defaultSettings = () => ({
  managerName: 'Aisyah', company: 'Demo Holdings Sdn Bhd', building: 'Menara Demo', type: 'Office tower',
  peakKw: 2000, tariff: { ...TARIFF_PRESETS.mvtou }, model: 'XGBoost',
  strategy: 'shift', flexKw: 200, flexHours: 4, reboundPct: 5, capPct: 8, margin: 3, onboarded: false,
  scn: { start: 14, end: 16, cutPct: 100, acShare: 50, catchupPct: 30, catchupHours: 3, weekdaysOnly: true, setC: 24, limitC: 26, tau: 6, perDeg: 6, wxMode: 'my' },
});

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch (e) { /* private mode etc. */ }
  return defaultSettings();
}
export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(S.settings)); } catch (e) { /* ignore */ }
  S._ctx = null; S._dr = {};
}
export function resetSettings() { S.settings = defaultSettings(); saveSettings(); }

export function init(data) {
  S.data = data; S.tl = buildTimeline(); S.settings = loadSettings();
}

// ---- derived context -------------------------------------------------------
export function ctx() {
  const s = S.settings, key = JSON.stringify([s.peakKw, s.tariff, s.model, s.margin]);
  if (S._ctx && S._ctxKey === key) return S._ctx;
  const { data, tl } = S;
  const k = s.peakKw / data.meta.ref_peak_mw;
  const actualKw = Float64Array.from(data.actual_mw, (v) => v * k);
  const fcKw = Float64Array.from(data.forecast_mw[s.model], (v) => v * k);
  const relQ = data.rel_q[s.model];
  const loKw = Float64Array.from(fcKw, (v) => v * (1 + relQ[4]));
  const hiKw = Float64Array.from(fcKw, (v) => v * (1 + relQ[94]));
  const t = s.tariff;
  const pmask = peakMask(tl, t), mdmask = mdMaskFor(tl, t, pmask);
  const c = {
    tl, tariff: t, k, actualKw, fcKw, loKw, hiKw, relQ, pmask, mdmask, margin: s.margin, mdRate: t.capacity + t.network,
    billsAct: monthlyBills(actualKw, tl, pmask, mdmask, t), billsFc: monthlyBills(fcKw, tl, pmask, mdmask, t),
  };
  S._ctx = c; S._ctxKey = key; S._dr = {};
  return c;
}

export function drParams() { const s = S.settings; return { flexKw: s.flexKw, flexHours: s.flexHours, reboundPct: s.reboundPct, capPct: s.capPct }; }

export function dr(strategy) {
  const c = ctx(), p = drParams(), key = strategy + JSON.stringify(p);
  if (!S._dr[key]) {
    const r = applyDR(c.fcKw, c.tl, c.pmask, c.mdmask, strategy, p);
    S._dr[key] = { ...r, bills: monthlyBills(r.out, c.tl, c.pmask, c.mdmask, c.tariff) };
  }
  return S._dr[key];
}

// ---- demo clock --------------------------------------------------------------
export function clockInfo() {
  const c = S.clock, map = mapDateToDemo(c.y, c.m, c.d);
  return { idx: map.dayIdx * 24 + c.hour, dayIdx: map.dayIdx, month: map.month, exact: map.exact,
    pickedMs: Date.UTC(c.y, c.m, c.d), demoMs: dayIdxToDate(map.dayIdx).getTime() };
}
export function setClockDate(y, m, d) { Object.assign(S.clock, { y, m, d }); S.month = clockInfo().month; }
export function stepClock(n = 1) {
  const c = S.clock;
  let hr = c.hour + n;
  let dt = Date.UTC(c.y, c.m, c.d);
  while (hr >= 24) { hr -= 24; dt += 864e5; }
  while (hr < 0) { hr += 24; dt -= 864e5; }
  const d = new Date(dt);
  c.y = d.getUTCFullYear(); c.m = d.getUTCMonth(); c.d = d.getUTCDate(); c.hour = hr;
  S.month = clockInfo().month;
}
export function jumpTo(dayIdx, hour) {
  const d = dayIdxToDate(dayIdx);
  Object.assign(S.clock, { y: 2021, m: d.getUTCMonth(), d: d.getUTCDate(), hour });
  S.month = d.getUTCMonth();
}
/** Find the moment, in a given month, when GridCast would raise its first hard peak alert. */
export function findAlertMoment(month) {
  const c = ctx(), r = monthAlerts(c, month);
  const hard = r.alerts.filter((a) => a.hard).sort((a, b) => a.i - b.i);
  return hard.length ? hard[0].i : null;
}
export function findBusiestHour(month) {
  const c = ctx(), s = c.tl.monthStartDay[month] * 24, e = s + c.tl.daysInMonth[month] * 24;
  let best = s;
  for (let i = s; i < e; i++) if (c.mdmask[i] && c.actualKw[i] > c.actualKw[best]) best = i;
  return best;
}
