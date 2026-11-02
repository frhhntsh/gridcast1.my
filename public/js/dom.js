// Tiny DOM + formatting helpers (no framework).
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (k) => {
    if (k == null || k === false) return;
    if (Array.isArray(k)) k.forEach(add);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
}
export const html = (s) => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
export const nf = (x, d = 0) => Number(x).toLocaleString('en-MY', { minimumFractionDigits: d, maximumFractionDigits: d });
export const rm = (x, d = 0) => 'RM\u00A0' + nf(x, d);
export const kw = (x) => nf(x) + '\u00A0kW';
export const fmtHour = (hr) => `${(hr % 12) || 12}\u00A0${hr % 24 < 12 ? 'AM' : 'PM'}`;
export const pct = (x, d = 1) => nf(x, d) + '%';
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const fmtDate = (ms, short = false) => {
  const d = new Date(ms);
  return short ? `${WD[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MN[d.getUTCMonth()].slice(0, 3)}` : `${WD[d.getUTCDay()]}, ${d.getUTCDate()} ${MN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
export const isoDate = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const LOGO_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="2" y="2" width="44" height="44" rx="14" fill="#6B4EE6"/><rect x="2" y="2" width="44" height="44" rx="14" fill="none" stroke="#261A47" stroke-width="2.4"/>
<g fill="#FFF7EE"><circle cx="13" cy="15" r="2.6"/><circle cx="24" cy="15" r="2.6"/><circle cx="13" cy="26" r="2.6"/><circle cx="24" cy="26" r="2.6"/><circle cx="13" cy="37" r="2.6"/><circle cx="24" cy="37" r="2.6"/><circle cx="35" cy="37" r="2.6"/><circle cx="35" cy="26" r="2.6"/></g>
<circle cx="35" cy="15" r="4.4" fill="#FF7A2F" stroke="#261A47" stroke-width="1.8"/>
<path d="M33 7.6a9.6 9.6 0 0 1 8.4 8.4M33.4 3.6a13.6 13.6 0 0 1 11 11" fill="none" stroke="#FFD2B0" stroke-width="2.2" stroke-linecap="round"/></svg>`;
