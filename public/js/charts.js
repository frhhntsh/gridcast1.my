// Chart.js helpers + three small plugins that give the charts a hand-drawn, annotated feel.
const C = window.Chart;
export const COL = { ink: '#261A47', soft: '#62597F', purple: '#6B4EE6', orange: '#FF7A2F', orangeDeep: '#E8590C', sky: '#7CC7EE', skyDeep: '#3FA3DB',
  peach: 'rgba(255,122,47,.14)', ok: '#1FA38A', alert: '#E0386B', grid: 'rgba(38,26,71,.08)', lilac: '#E8E2FC' };

C.defaults.font.family = "'Figtree', system-ui, sans-serif";
C.defaults.font.size = 12.5;
C.defaults.color = COL.soft;
C.defaults.animation = false;
C.defaults.plugins.legend.labels.usePointStyle = true;
C.defaults.plugins.legend.labels.boxWidth = 8;
C.defaults.plugins.legend.labels.boxHeight = 8;

const peakBands = {
  id: 'peakBands',
  beforeDatasetsDraw(chart, _a, opts) {
    if (!opts || !opts.ranges || !opts.ranges.length) return;
    const { ctx, chartArea, scales } = chart, x = scales.x;
    const step = chart.data.labels.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : 0;
    ctx.save(); ctx.fillStyle = opts.color || COL.peach;
    for (const [a, b] of opts.ranges) {
      const x0 = Math.max(chartArea.left, x.getPixelForValue(a) - step / 2), x1 = Math.min(chartArea.right, x.getPixelForValue(b) + step / 2);
      ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
    }
    if (opts.label && opts.ranges[0]) {
      ctx.fillStyle = COL.orangeDeep; ctx.font = "700 17px 'Caveat', cursive";
      const [a] = opts.ranges[0]; ctx.fillText(opts.label, Math.max(chartArea.left, x.getPixelForValue(a) - step / 2) + 8, chartArea.top + 17);
    }
    ctx.restore();
  },
};
const hline = {
  id: 'hline',
  afterDatasetsDraw(chart, _a, opts) {
    if (!opts || opts.y == null || isNaN(opts.y)) return;
    const { ctx, chartArea, scales } = chart, y = scales.y.getPixelForValue(opts.y);
    if (y < chartArea.top || y > chartArea.bottom) return;
    ctx.save(); ctx.strokeStyle = opts.color || COL.alert; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = opts.color || COL.alert; ctx.font = "700 18px 'Caveat', cursive"; ctx.textAlign = 'right';
    ctx.fillText(opts.label || '', chartArea.right - 44, y - 6); ctx.restore();
  },
};
const notes = {
  id: 'notes',
  afterDatasetsDraw(chart, _a, opts) {
    if (!opts || !opts.items) return;
    const { ctx, scales, chartArea } = chart;
    for (const n of opts.items) {
      const px = scales.x.getPixelForValue(n.i), py = scales.y.getPixelForValue(n.v);
      let tx = px + (n.dx || -90), ty = py + (n.dy || -46);
      tx = Math.min(Math.max(tx, chartArea.left + 4), chartArea.right - 130); ty = Math.min(Math.max(ty, chartArea.top + 16), chartArea.bottom - 6);
      ctx.save(); ctx.fillStyle = n.color || COL.orangeDeep; ctx.strokeStyle = n.color || COL.orangeDeep; ctx.lineWidth = 1.8; ctx.font = "700 20px 'Caveat', cursive"; ctx.textAlign = 'left';
      ctx.fillText(n.text, tx, ty);
      const w = ctx.measureText(n.text).width, sx = tx + w / 2, sy = ty + (ty < py ? 6 : -18);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo((sx + px) / 2 + 12, (sy + py) / 2 - 6, px - (px > sx ? 7 : -7), py - (py > sy ? 8 : -8)); ctx.stroke();
      ctx.restore();
    }
  },
};
const windowBand = {
  id: 'windowBand',
  beforeDatasetsDraw(chart, _a, opts) {
    if (!opts || !opts.ranges || !opts.ranges.length) return;
    const { ctx, chartArea, scales } = chart, x = scales.x;
    const step = x.getPixelForValue(1) - x.getPixelForValue(0);
    ctx.save(); ctx.fillStyle = opts.color || 'rgba(107,78,230,.16)';
    for (const [a, b] of opts.ranges) {
      const x0 = Math.max(chartArea.left, x.getPixelForValue(a) - step / 2), x1 = Math.min(chartArea.right, x.getPixelForValue(b) + step / 2);
      ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
      if (opts.label) { ctx.fillStyle = '#3D2B94'; ctx.font = "700 17px 'Caveat', cursive"; ctx.fillText(opts.label, x0 + 6, chartArea.bottom - 8); ctx.fillStyle = opts.color || 'rgba(107,78,230,.16)'; }
    }
    ctx.restore();
  },
};
C.register(peakBands, windowBand, hline, notes);

const live = [];
export function destroyCharts() { while (live.length) live.pop().destroy(); }
const mountQueue = [];
export const afterMount = (fn) => mountQueue.push(fn);
export function runMount() { while (mountQueue.length) mountQueue.shift()(); }

export function make(canvas, type, data, options = {}) {
  const base = {
    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'top', align: 'start' }, tooltip: { backgroundColor: '#261A47', titleFont: { family: 'Figtree', weight: '700' }, padding: 10, cornerRadius: 10 } },
    scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }, y: { grid: { color: COL.grid }, border: { display: false } } },
  };
  const merge = (a, b) => { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') merge(a[k], b[k]); else a[k] = b[k]; } return a; };
  const chart = new C(canvas, { type, data, options: merge(base, options) });
  live.push(chart);
  return chart;
}
export const ranges = (mask, from, to) => {  // contiguous index ranges where mask is 1, relative to `from`
  const out = []; let start = null;
  for (let i = from; i < to; i++) {
    if (mask[i] && start === null) start = i;
    if (start !== null && (!mask[i] || i === to - 1)) { out.push([start - from, (mask[i] ? i : i - 1) - from]); start = null; }
  }
  return out;
};
