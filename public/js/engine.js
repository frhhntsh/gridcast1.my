// GridCast.my – calculation engine (pure functions, no DOM).
// Runs in the browser and in Node (see tests/engine_check.mjs).

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const DAYS_IN_MONTH_2021 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// ---------------------------------------------------------------------------
// TARIFFS  (RM per kWh / RM per kW per month)
// Sources: TNB "Understand your electricity tariff" page (mapping, ToU hours, AFA) and the
// Energy Commission tariff schedule (jadual tarif) for the RP4 rates effective 1 Jul 2025.
// ---------------------------------------------------------------------------
export const TARIFF_PRESETS = {
  mvtou: {
    id: 'mvtou', name: 'Medium Voltage ToU', note: 'Peak / off-peak pricing (was Tariff C2)',
    energyPeak: 0.3132, energyOff: 0.2723, capacity: 30.19, network: 66.87, retail: 200, afaSen: 3.61, otherPct: 0,
    mdPeakOnly: true, peakStart: 14, peakEnd: 22, offDays: [5, 6],
  },
  mvgen: {
    id: 'mvgen', name: 'Medium Voltage General', note: 'One flat energy rate (was Tariff C1)',
    energyPeak: 0.2983, energyOff: 0.2983, capacity: 29.43, network: 59.84, retail: 200, afaSen: 3.61, otherPct: 0,
    mdPeakOnly: false, peakStart: 14, peakEnd: 22, offDays: [5, 6],
  },
  c2legacy: {
    id: 'c2legacy', name: 'Legacy C2 (before Jul 2025)', note: 'Old peak/off-peak commercial tariff',
    energyPeak: 0.365, energyOff: 0.224, capacity: 45.10, network: 0, retail: 0, afaSen: 0, otherPct: 0,
    mdPeakOnly: true, peakStart: 8, peakEnd: 22, offDays: [5, 6],
  },
  c1legacy: {
    id: 'c1legacy', name: 'Legacy C1 (before Jul 2025)', note: 'Old flat commercial tariff',
    energyPeak: 0.365, energyOff: 0.365, capacity: 30.30, network: 0, retail: 0, afaSen: 0, otherPct: 0,
    mdPeakOnly: false, peakStart: 8, peakEnd: 22, offDays: [5, 6],
  },
};

// ---------------------------------------------------------------------------
// TIMELINE  – the demo year has 8,760 hourly intervals starting Fri 1 Jan 2021 00:00
// ---------------------------------------------------------------------------
export function buildTimeline() {
  const N = 8760;
  const hour = new Uint8Array(N), dow = new Uint8Array(N), day = new Uint16Array(N), month = new Uint8Array(N);
  const monthStartDay = [];
  let acc = 0;
  DAYS_IN_MONTH_2021.forEach((d) => { monthStartDay.push(acc); acc += d; });
  for (let i = 0; i < N; i++) {
    const d = Math.floor(i / 24);
    hour[i] = i % 24;
    day[i] = d;
    dow[i] = (4 + d) % 7; // 1 Jan 2021 was a Friday (Mon = 0)
    let m = 11;
    while (monthStartDay[m] > d) m--;
    month[i] = m;
  }
  return { N, hour, dow, day, month, monthStartDay, daysInMonth: DAYS_IN_MONTH_2021 };
}

export function peakMask(tl, t) {
  const m = new Uint8Array(tl.N);
  for (let i = 0; i < tl.N; i++) {
    m[i] = tl.hour[i] >= t.peakStart && tl.hour[i] < t.peakEnd && !t.offDays.includes(tl.dow[i]) ? 1 : 0;
  }
  return m;
}

export function mdMaskFor(tl, t, pmask) {
  if (t.mdPeakOnly) return pmask;
  return new Uint8Array(tl.N).fill(1);
}

// ---------------------------------------------------------------------------
// BILLS
// ---------------------------------------------------------------------------
export function monthlyBills(loadKw, tl, pmask, mdmask, t) {
  const out = [];
  for (let m = 0; m < 12; m++) {
    let peakKwh = 0, offKwh = 0, mdKw = 0;
    const s = tl.monthStartDay[m] * 24, e = s + tl.daysInMonth[m] * 24;
    for (let i = s; i < e; i++) {
      if (pmask[i]) peakKwh += loadKw[i]; else offKwh += loadKw[i];
      if (mdmask[i] && loadKw[i] > mdKw) mdKw = loadKw[i];
    }
    const energy = peakKwh * t.energyPeak + offKwh * t.energyOff;
    const afa = (peakKwh + offKwh) * (t.afaSen / 100);
    const capacity = mdKw * t.capacity;
    const network = mdKw * t.network;
    const sub = energy + afa + capacity + network + t.retail;
    const other = sub * (t.otherPct / 100);
    out.push({ month: m, peakKwh, offKwh, kwh: peakKwh + offKwh, mdKw, energy, afa, capacity, network, retail: t.retail, other, md: capacity + network, total: sub + other });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DEMAND RESPONSE  (energy-conserving: shave the highest hours, refill the lowest hours)
// ---------------------------------------------------------------------------
function shaveDay(day, mask, maxKw, targetKwh, capKw) {
  const red = new Float64Array(24);
  const idx = [];
  for (let k = 0; k < 24; k++) if (mask[k]) idx.push(k);
  if (!idx.length || maxKw <= 0) return red;
  const x = idx.map((k) => day[k]);
  if (capKw != null) {
    idx.forEach((k, j) => { red[k] = Math.min(maxKw, Math.max(0, x[j] - capKw)); });
    return red;
  }
  const removed = (lvl) => x.reduce((a, v) => a + Math.min(maxKw, Math.max(0, v - lvl)), 0);
  let lo = Math.min(...x) - maxKw - 1, hi = Math.max(...x), level;
  if (removed(lo) <= targetKwh) level = lo;
  else {
    for (let n = 0; n < 60; n++) { const mid = (lo + hi) / 2; if (removed(mid) > targetKwh) lo = mid; else hi = mid; }
    level = hi;
  }
  idx.forEach((k, j) => { red[k] = Math.min(maxKw, Math.max(0, x[j] - level)); });
  return red;
}

function fillDay(day, mask, energyKwh, maxKw, ceiling) {
  const add = new Float64Array(24);
  const idx = [];
  for (let k = 0; k < 24; k++) if (mask[k]) idx.push(k);
  if (!idx.length || energyKwh <= 0 || maxKw <= 0) return add;
  const x = idx.map((k) => day[k]);
  const added = (lvl) => x.reduce((a, v) => a + Math.min(maxKw, Math.max(0, Math.min(lvl, ceiling) - v)), 0);
  let level;
  if (added(ceiling) <= energyKwh) level = ceiling;
  else {
    let lo = Math.min(...x), hi = ceiling;
    for (let n = 0; n < 60; n++) { const mid = (lo + hi) / 2; if (added(mid) < energyKwh) lo = mid; else hi = mid; }
    level = hi;
  }
  idx.forEach((k, j) => { add[k] = Math.min(maxKw, Math.max(0, Math.min(level, ceiling) - x[j])); });
  return add;
}

/** strategy: 'shift' | 'curtail' | 'cap' */
export function applyDR(loadKw, tl, pmask, mdmask, strategy, p) {
  const out = Float64Array.from(loadKw);
  const stats = { shavedKwh: 0, recoveredKwh: 0, unrecoveredKwh: 0 };
  let flat = true;
  for (let i = 0; i < tl.N; i++) if (!mdmask[i]) { flat = false; break; }
  const mdRef = [];
  for (let m = 0; m < 12; m++) {
    let mx = 0;
    const s = tl.monthStartDay[m] * 24, e = s + tl.daysInMonth[m] * 24;
    for (let i = s; i < e; i++) if (mdmask[i] && loadKw[i] > mx) mx = loadKw[i];
    mdRef.push(mx);
  }
  const ones = new Uint8Array(24).fill(1);
  for (let d = 0; d < 365; d++) {
    const s = d * 24;
    const pm = pmask.subarray(s, s + 24);
    const shaveOk = flat ? ones : pm;
    let any = false;
    for (let k = 0; k < 24; k++) if (shaveOk[k]) { any = true; break; }
    if (!any) continue;
    const day = loadKw.subarray(s, s + 24);
    let red;
    if (strategy === 'cap') {
      const cap = mdRef[tl.month[s]] * (1 - p.capPct / 100);
      red = shaveDay(day, shaveOk, p.flexKw, null, cap);
    } else {
      red = shaveDay(day, shaveOk, p.flexKw, p.flexKw * p.flexHours, null);
    }
    let shaved = 0;
    for (let k = 0; k < 24; k++) shaved += red[k];
    let add = new Float64Array(24);
    if (strategy !== 'curtail' && shaved > 0) {
      const need = shaved * (1 + p.reboundPct / 100);
      const after = new Float64Array(24), fillOk = new Uint8Array(24);
      let ceil = 0;
      for (let k = 0; k < 24; k++) {
        after[k] = day[k] - red[k];
        fillOk[k] = flat ? (red[k] === 0 ? 1 : 0) : (pm[k] ? 0 : 1);
        if (flat) { if (after[k] > ceil) ceil = after[k]; } else if (day[k] > ceil) ceil = day[k];
      }
      add = fillDay(after, fillOk, need, p.flexKw, ceil);
      let a = 0;
      for (let k = 0; k < 24; k++) a += add[k];
      stats.recoveredKwh += a;
      stats.unrecoveredKwh += Math.max(0, need - a);
    }
    for (let k = 0; k < 24; k++) out[s + k] = day[k] - red[k] + add[k];
    stats.shavedKwh += shaved;
  }
  return { out, stats };
}

// ---------------------------------------------------------------------------
// ALERTS / NEXT-HOUR STATUS
// ---------------------------------------------------------------------------
export function runningMd(actualKw, tl, mdmask, i) {
  const m = tl.month[i];
  const s = tl.monthStartDay[m] * 24;
  let mx = NaN;
  for (let j = s; j < i; j++) if (mdmask[j] && (isNaN(mx) || actualKw[j] > mx)) mx = actualKw[j];
  return mx;
}

export function exceedProb(relQ, ratio) {
  // relQ: 99 quantiles (1%..99%) of actual/forecast - 1.  P(actual/forecast - 1 > ratio)
  let above = 0;
  for (const q of relQ) if (q > ratio) above++;
  return above / relQ.length;
}

export function nextHourStatus(ctx, i) {
  const { actualKw, fcKw, tl, mdmask, tariff, relQ, margin } = ctx;
  const run = runningMd(actualKw, tl, mdmask, i);
  const nxt = fcKw[i];
  const mdRate = tariff.capacity + tariff.network;
  let tone, label, extra = 0, p = NaN;
  if (!mdmask[i]) { tone = 'ok'; label = 'Quiet hour'; }
  else if (isNaN(run)) { tone = 'info'; label = 'New month'; }
  else {
    p = exceedProb(relQ, run / nxt - 1);
    if (nxt > run) { tone = 'alert'; label = 'Peak alert'; extra = (nxt - run) * mdRate * (1 + tariff.otherPct / 100); }
    else if (nxt >= run * (1 - margin / 100)) { tone = 'watch'; label = 'Getting high'; }
    else { tone = 'ok'; label = 'All good'; }
  }
  return { tone, label, run, nxt, p, extra, inMdWindow: !!mdmask[i] };
}

export function monthAlerts(ctx, m) {
  const { actualKw, fcKw, tl, mdmask, margin } = ctx;
  const s = tl.monthStartDay[m] * 24, e = s + tl.daysInMonth[m] * 24;
  const list = [];
  let run = NaN;
  for (let i = s; i < e; i++) {
    const prev = run;
    if (mdmask[i] && (isNaN(run) || actualKw[i] > run)) run = actualKw[i];
    if (!mdmask[i] || isNaN(prev) || i - s < 24) continue;
    const alert = fcKw[i] > prev * (1 - margin / 100);
    const real = actualKw[i] > prev;
    if (alert || real) list.push({ i, fc: fcKw[i], run: prev, actual: actualKw[i], alert, real, hard: fcKw[i] > prev });
  }
  const alerts = list.filter((x) => x.alert);
  const tp = alerts.filter((x) => x.real).length;
  const nReal = list.filter((x) => x.real).length;
  return { alerts: alerts.reverse(), total: alerts.length, tp, nReal };
}

// ---------------------------------------------------------------------------
// DEMO CLOCK – map ANY calendar date onto a demo-year day with the same weekday
// ---------------------------------------------------------------------------
export function mapDateToDemo(y, mo, d) {
  // mo: 0-based. Returns {dayIdx, month, exact}
  const picked = new Date(Date.UTC(y, mo, d));
  if (y === 2021) {
    const dayIdx = Math.round((picked - Date.UTC(2021, 0, 1)) / 864e5);
    return { dayIdx, month: mo, exact: true };
  }
  const dd = mo === 1 && d > 28 ? 28 : d;
  const cand = new Date(Date.UTC(2021, mo, dd));
  const wdDiff = (picked.getUTCDay() - cand.getUTCDay() + 7) % 7;
  const options = [wdDiff, wdDiff - 7].map((sft) => new Date(cand.getTime() + sft * 864e5));
  const sameMonth = options.filter((o) => o.getUTCMonth() === mo && o.getUTCFullYear() === 2021);
  const pool = sameMonth.length ? sameMonth : options.filter((o) => o.getUTCFullYear() === 2021);
  pool.sort((a, b) => Math.abs(a - cand) - Math.abs(b - cand));
  const chosen = pool[0] || cand;
  const dayIdx = Math.round((chosen - Date.UTC(2021, 0, 1)) / 864e5);
  return { dayIdx, month: chosen.getUTCMonth(), exact: false };
}

export function dayIdxToDate(dayIdx) {
  return new Date(Date.UTC(2021, 0, 1) + dayIdx * 864e5);
}

// ---------------------------------------------------------------------------
// WHAT-IF SCENARIOS  (e.g. "turn the aircond down 2-4 pm on weekdays")
// The data has no aircond sub-meter, so the aircond is modelled as a SHARE of the building load.
// ---------------------------------------------------------------------------
/** o: {start,end,cutPct,acShare,catchupPct,catchupHours,weekdaysOnly}  — start/end are hours of day, end exclusive */
export function applyScenario(loadKw, tl, o) {
  const out = Float64Array.from(loadKw);
  const cut = o.cutPct / 100, share = o.acShare / 100;
  let saved = 0, back = 0, days = 0;
  for (let d = 0; d < 365; d++) {
    const s = d * 24;
    if (o.weekdaysOnly && tl.dow[s] >= 5) continue;
    let dayS = 0;
    for (let h = o.start; h < o.end; h++) { const r = loadKw[s + h] * share * cut; out[s + h] -= r; dayS += r; }
    if (dayS <= 0) continue;
    days++; saved += dayS;
    if (o.catchupPct > 0 && o.catchupHours > 0) {
      const per = (dayS * o.catchupPct) / 100 / o.catchupHours;
      for (let k = 0; k < o.catchupHours; k++) { const idx = s + o.end + k; if (idx < out.length) { out[idx] += per; back += per; } }
    }
  }
  return { out, savedKwh: saved, backKwh: back, netKwh: saved - back, days };
}

export function outdoorTemp(wx, dayIdx, hour) {
  const tmax = wx.tmax[dayIdx], tmin = wx.tmin[dayIdx];
  return (tmax + tmin) / 2 + ((tmax - tmin) / 2) * Math.cos((2 * Math.PI * (hour - 15)) / 24);
}

/** Very simple first-order thermal model of the indoor temperature (end of each hour). Indicative only. */
export function indoorProfile(wx, tl, dayIdx, o) {
  const applies = !(o.weekdaysOnly && tl.dow[dayIdx * 24] >= 5);
  let T = o.setC; const out = [];
  for (let h = 0; h < 24; h++) {
    const tout = outdoorTemp(wx, dayIdx, h + 0.5);
    const f = applies && h >= o.start && h < o.end ? o.cutPct / 100 : 0;
    // a cut of X% is the same as raising the setpoint by X/perDeg °C (rule of thumb), but the room can never get hotter than outdoors
    const Teq = f > 0 ? Math.min(Math.max(tout, o.setC), o.setC + o.cutPct / (o.perDeg || 6)) : o.setC;
    const tau = f > 0 ? o.tau : (T > o.setC ? o.tau / 2 : o.tau); // the aircond pulls the room down ~2x faster than it warms up
    T = Teq + (T - Teq) * Math.exp(-1 / tau);
    out.push(T);
  }
  return out;
}
