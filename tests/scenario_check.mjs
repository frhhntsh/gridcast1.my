import fs from 'node:fs';
import assert from 'node:assert/strict';
import { buildTimeline, applyScenario, indoorProfile, TARIFF_PRESETS, peakMask, mdMaskFor, monthlyBills } from '../public/js/engine.js';
const data = JSON.parse(fs.readFileSync(new URL('../public/data/gridcast_data.json', import.meta.url)));
const tl = buildTimeline(), k = 2000 / data.meta.ref_peak_mw, fc = Float64Array.from(data.forecast_mw.XGBoost, (v) => v * k);
const base = { start: 14, end: 16, cutPct: 100, acShare: 50, catchupPct: 40, catchupHours: 2, weekdaysOnly: true };
const r = applyScenario(fc, tl, base);
const sum = (a) => a.reduce((x, y) => x + y, 0);
// 1. energy bookkeeping: change in total energy == -(saved - catch-up)
assert.ok(Math.abs(sum(r.out) - (sum(fc) - r.netKwh)) < 1e-6, 'energy bookkeeping');
// 2. weekends untouched
for (let d = 0; d < 365; d++) if (tl.dow[d * 24] >= 5) for (let h = 0; h < 24; h++) assert.equal(r.out[d * 24 + h], fc[d * 24 + h]);
// 3. cut=0 changes nothing; more cut => never less saving
assert.equal(applyScenario(fc, tl, { ...base, cutPct: 0 }).savedKwh, 0);
let prev = -1; for (const c of [20, 40, 60, 80, 100]) { const s = applyScenario(fc, tl, { ...base, cutPct: c }).savedKwh; assert.ok(s > prev); prev = s; }
// 4. money: window inside the ToU peak period lowers the monthly peak charge
const t = TARIFF_PRESETS.mvtou, pm = peakMask(tl, t), md = mdMaskFor(tl, t, pm);
const b0 = monthlyBills(fc, tl, pm, md, t);
const clean = applyScenario(fc, tl, { ...base, catchupPct: 0 }), bc = monthlyBills(clean.out, tl, pm, md, t);
assert.ok(bc[5].total < b0[5].total && bc[5].mdKw < b0[5].mdKw, 'with no catch-up the June bill and peak must fall');
// REBOUND: a hard cut with a sharp catch-up right after the window creates a HIGHER peak (a real effect)
const hard = applyScenario(fc, tl, { ...base, catchupPct: 40, catchupHours: 2 }), bh = monthlyBills(hard.out, tl, pm, md, t);
assert.ok(bh[5].mdKw > b0[5].mdKw, 'sharp rebound must be able to create a new, higher peak');
// ...and spreading the catch-up over more hours softens it
const soft = applyScenario(fc, tl, { ...base, catchupPct: 40, catchupHours: 6 }), bs = monthlyBills(soft.out, tl, pm, md, t);
assert.ok(bs[5].mdKw < bh[5].mdKw, 'spreading the restart must lower the rebound peak');
const b1 = bc;
// 5. indoor temperature: rises while off, stays at setpoint if no cut, light building warms faster than heavy
const wx = data.weather_daily, day = 175; // a weekday in June
const o = { ...base, setC: 24, tau: 6 };
const p = indoorProfile(wx, tl, day, o), idle = indoorProfile(wx, tl, day, { ...o, cutPct: 0 });
assert.ok(idle.every((x) => Math.abs(x - 24) < 1e-9)); assert.ok(p[15] > p[13] && p[15] > 24);
assert.ok(indoorProfile(wx, tl, day, { ...o, tau: 3 })[15] > indoorProfile(wx, tl, day, { ...o, tau: 10 })[15]);
console.log('scenario engine OK — June saving RM', Math.round(b0[5].total - b1[5].total), '| MD', Math.round(b0[5].mdKw), '->', Math.round(b1[5].mdKw), '| indoor at 4 pm', p[15].toFixed(1), '°C');
