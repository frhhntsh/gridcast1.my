// Runs the JS engine on the exported data and writes results for comparison with Python.
import fs from 'node:fs';
import { buildTimeline, peakMask, mdMaskFor, monthlyBills, applyDR, TARIFF_PRESETS, mapDateToDemo } from '../public/js/engine.js';
const data = JSON.parse(fs.readFileSync(new URL('../public/data/gridcast_data.json', import.meta.url)));
const tl = buildTimeline();
const scale = (kw) => kw / data.meta.ref_peak_mw;
const scenarios = [
  { name: 'tou_shift', peakKw: 2000, tariff: 'mvtou', strategy: 'shift', p: { flexKw: 200, flexHours: 4, reboundPct: 5, capPct: 8 } },
  { name: 'gen_cap', peakKw: 3500, tariff: 'mvgen', strategy: 'cap', p: { flexKw: 400, flexHours: 4, reboundPct: 5, capPct: 8 } },
  { name: 'legacy_curtail', peakKw: 1200, tariff: 'c2legacy', strategy: 'curtail', p: { flexKw: 150, flexHours: 3, reboundPct: 0, capPct: 8 } },
  { name: 'gen_shift', peakKw: 2000, tariff: 'mvgen', strategy: 'shift', p: { flexKw: 300, flexHours: 5, reboundPct: 10, capPct: 8 } },
];
const out = {};
for (const sc of scenarios) {
  const t = { ...TARIFF_PRESETS[sc.tariff], otherPct: 1.6 };
  const k = sc.peakKw / data.meta.ref_peak_mw;
  const fc = Float64Array.from(data.forecast_mw.XGBoost, (v) => v * k);
  const act = Float64Array.from(data.actual_mw, (v) => v * k);
  const pm = peakMask(tl, t), md = mdMaskFor(tl, t, pm);
  const base = monthlyBills(act, tl, pm, md, t);
  const dr = applyDR(fc, tl, pm, md, sc.strategy, sc.p);
  const after = monthlyBills(dr.out, tl, pm, md, t);
  out[sc.name] = { baseTotals: base.map((b) => b.total), baseMd: base.map((b) => b.mdKw), afterTotals: after.map((b) => b.total),
    afterMd: after.map((b) => b.mdKw), drOut: Array.from(dr.out), stats: dr.stats };
}
out.mapping = ['2026-10-31', '2024-02-29', '2025-01-01', '2021-06-15', '2030-12-31'].map((s) => {
  const [y, m, d] = s.split('-').map(Number); return { s, ...mapDateToDemo(y, m - 1, d) };
});
fs.writeFileSync(new URL('./js_out.json', import.meta.url), JSON.stringify(out));
console.log('wrote', Object.keys(out));
console.log(JSON.stringify(out.mapping));
