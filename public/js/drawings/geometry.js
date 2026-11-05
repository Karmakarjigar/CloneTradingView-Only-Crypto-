/** Shared geometry + formatting helpers for the drawing engine. */

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function rectOf(a, b, width = 0, height = 0) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(width, Math.abs(a.x - b.x)),
    h: Math.max(height, Math.abs(a.y - b.y)),
    left: x,
    top: y,
    right: x + Math.max(width, Math.abs(a.x - b.x)),
    bottom: y + Math.max(height, Math.abs(a.y - b.y)),
  };
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function distToPolyline(px, py, pts, closed = false) {
  if (!pts || pts.length < 2) {
    return pts && pts.length === 1 ? Math.hypot(px - pts[0].x, py - pts[0].y) : Infinity;
  }
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i += 1) {
    best = Math.min(best, distToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y));
  }
  if (closed) {
    best = Math.min(best, distToSegment(px, py, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y));
  }
  return best;
}

export function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Intersect an infinite line through a/b with a viewport rectangle.
 * `range` controls how far the result may travel:
 *   segment | ray | back | extended
 */
export function clipLineToRect(a, b, rect, range = 'segment') {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ts = [];
  const add = (t, x, y) => {
    if (!Number.isFinite(t)) return;
    if (x < rect.left - 0.5 || x > rect.right + 0.5) return;
    if (y < rect.top - 0.5 || y > rect.bottom + 0.5) return;
    ts.push(t);
  };

  if (Math.abs(dx) > 1e-9) {
    add((rect.left - a.x) / dx, rect.left, a.y + dy * ((rect.left - a.x) / dx));
    add((rect.right - a.x) / dx, rect.right, a.y + dy * ((rect.right - a.x) / dx));
  }
  if (Math.abs(dy) > 1e-9) {
    add((rect.top - a.y) / dy, a.x + dx * ((rect.top - a.y) / dy), rect.top);
    add((rect.bottom - a.y) / dy, a.x + dx * ((rect.bottom - a.y) / dy), rect.bottom);
  }

  let lo = 0;
  let hi = 1;
  if (range === 'ray') hi = Infinity;
  else if (range === 'back') lo = -Infinity;
  else if (range === 'extended') { lo = -Infinity; hi = Infinity; }

  const kept = ts.filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9).sort((p, q) => p - q);
  if (!kept.length) {
    if (range === 'segment') return { a: { ...a }, b: { ...b } };
    return null;
  }
  return {
    a: { x: a.x + dx * kept[0], y: a.y + dy * kept[0] },
    b: { x: a.x + dx * kept[kept.length - 1], y: a.y + dy * kept[kept.length - 1] },
  };
}

export function hexA(hex, alpha) {
  if (!hex) return `rgba(41, 98, 255, ${alpha})`;
  if (hex.startsWith('rgb')) return hex;
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function priceDigits(p) {
  const abs = Math.abs(p);
  if (!Number.isFinite(abs)) return 2;
  if (abs >= 1000) return 2;
  if (abs >= 10) return 2;
  if (abs >= 0.01) return 4;
  return 6;
}

export function fmtPrice(p) {
  if (!Number.isFinite(p)) return '—';
  const d = priceDigits(p);
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPct(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function fmtCompact(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtDate(t) {
  if (!Number.isFinite(t)) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
  } catch {
    return '—';
  }
}

export function fmtDateShort(t) {
  if (!Number.isFinite(t)) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(t);
  } catch {
    return '—';
  }
}

/** Circle through three points, or null when they are collinear. */
export function circleFrom3(p1, p2, p3) {
  const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-7) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
}

/** Draw a smooth path through points using quadratic mid-points. */
export function smoothPolyline(ctx, pts) {
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }
  for (let i = 1; i < pts.length - 1; i += 1) {
    const m = mid(pts[i], pts[i + 1]);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

export function angleOf(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function polar(origin, radius, angle) {
  return { x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius };
}

export function niceAngle(a, b) {
  let deg = (angleOf(a, b) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  return deg;
}
