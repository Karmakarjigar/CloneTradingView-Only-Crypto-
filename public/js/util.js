export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function priceDigits(p) {
  const abs = Math.abs(p);
  if (abs >= 10) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

export function fmtPrice(p) {
  if (!Number.isFinite(p)) return '—';
  const d = priceDigits(p);
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtSigned(v, refPrice) {
  const d = priceDigits(refPrice);
  const body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${v >= 0 ? '+' : '−'}${body}`;
}

export function fmtVol(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function uid(prefix = 't') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
