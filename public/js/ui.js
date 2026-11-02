// Shared UI building blocks for the pages.
import { h, nf } from './dom.js';
import { S } from './store.js';
import { MONTHS } from './engine.js';

export const hooks = { go() {}, rerender() {}, openSettings() {}, toast() {} };

export const section = (title, sub) => h('div', { class: 'sec' }, h('h2', null, title), sub ? h('p', null, sub) : null);
export const card = (cls, ...kids) => h('div', { class: 'card ' + (cls || '') }, ...kids);
export const stat = (label, big, sub, cls = '') => h('div', { class: 'card ' + cls }, h('div', { class: 'label' }, label), h('div', { class: 'stat-big' }, big), h('div', { class: 'stat-sub' }, sub));
export const callout = (...kids) => h('div', { class: 'callout' }, ...kids);
export const chartBox = (cls = '') => { const canvas = h('canvas'); return { box: h('div', { class: 'chart-box ' + cls }, canvas), canvas }; };

export function monthSelect(onPick) {
  return h('label', { class: 'field', style: 'max-width:240px;margin:0' }, h('span', null, 'Month'),
    h('select', { class: 'sel', onchange: (e) => { S.month = +e.target.value; (onPick || hooks.rerender)(); } },
      MONTHS.map((n, i) => h('option', { value: i, selected: i === S.month }, n))));
}
export function seg(options, current, onPick) {
  return h('div', { class: 'seg' }, options.map(([val, label]) => h('button', { class: val === current ? 'on' : '', onclick: () => onPick(val) }, label)));
}
export function slider({ label, min, max, step = 1, value, fmt, onInput, onChange, hint }) {
  const out = h('b', null, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => { out.textContent = fmt(+input.value); onInput && onInput(+input.value); });
  input.addEventListener('change', () => onChange(+input.value));
  return h('div', { class: 'field' }, h('span', null, label), h('div', { class: 'range-row' }, input, out), hint ? h('small', null, hint) : null);
}
export const FEATURE_NAMES = {
  lag_1: "Last hour's demand", lag_2: 'Demand 2 hours ago', lag_3: 'Demand 3 hours ago', lag_24: 'Same hour yesterday', lag_48: 'Same hour 2 days ago',
  lag_168: 'Same hour last week', roll_mean_24: 'Average of last 24 h', roll_std_24: 'Swings in last 24 h', roll_mean_168: 'Average of last week',
  hour: 'Hour of day', dayofweek: 'Day of week', month: 'Month', is_friday: 'Is it Friday', hour_sin: 'Hour (cycle)', hour_cos: 'Hour (cycle, 2)',
  doy_sin: 'Season (cycle)', doy_cos: 'Season (cycle, 2)', Temp: 'Temperature', Hum: 'Humidity', 'MAX Tem': 'Daily max temp', 'Min Tem': 'Daily min temp',
  temp_range: 'Temp swing', cooling_deg: 'Cooling need',
};
export const toneWord = { ok: 'ok', watch: 'watch', alert: 'alert', info: 'info' };
export const mdRateOf = (t) => t.capacity + t.network;
export const csvDownload = (name, rows) => {
  const csv = rows.map((r) => r.map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : `"${v}"`)).join(',')).join('\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: name });
  document.body.append(a); a.click(); a.remove();
};
export const nfc = nf;
