/**
 * Drawing renderer + hit geometry.
 *
 * Every shape is projected from data coordinates (timestamp/price) at draw
 * time, so nothing here stores screen pixels. `solid` helpers keep the
 * renderer and hit-testing in sync for the common line/polygon cases.
 */

import { FIB_LEVELS, FIB_EXT_LEVELS, toolDef } from './registry.js';
import {
  clamp, lerp, mid, rectOf, distToSegment, distToPolyline, pointInPoly,
  clipLineToRect, hexA, fmtPrice, fmtPct, fmtCompact, fmtDuration, fmtDate, fmtDateShort,
  circleFrom3, smoothPolyline, angleOf, polar, niceAngle,
} from './geometry.js';

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, Roboto, Arial, sans-serif';
const DASH = { 0: [], 1: [6, 4], 2: [1.5, 3] };

function dashFor(style) {
  return DASH[style] || [];
}

function applyStyle(ctx, s, extraWidth = 0, alpha = 1) {
  ctx.strokeStyle = s.color || '#2962ff';
  ctx.lineWidth = Math.max(1, (s.width || 1.5) + extraWidth);
  ctx.setLineDash(dashFor(s.lineStyle));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha *= alpha;
}

function seg(ctx, a, b) {
  if (!a || !b) return;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function poly(ctx, pts, close = false) {
  if (!pts || !pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
}

function fillPoly(ctx, pts, color, alpha) {
  if (!pts || pts.length < 3) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  poly(ctx, pts, true);
  ctx.fill();
  ctx.restore();
}

function projectPoints(s, project) {
  return s.points.map((p) => ({ x: project.x(p.t), y: project.y(p.p) }));
}

function viewRect(project) {
  return {
    left: project.left ?? 0,
    top: project.top ?? 0,
    right: project.right ?? project.width,
    bottom: project.bottom ?? (project.height ? project.top + project.height : 100000),
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawLabel(ctx, text, x, y, opts = {}) {
  if (text == null || text === '') return null;
  const font = opts.font || `10.5px ${FONT}`;
  const padX = opts.padX ?? 5;
  const padY = opts.padY ?? 3;
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lines = String(text).split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  const lineH = opts.lineH ?? 14;
  const h = lines.length * lineH + padY * 2 - 3;
  let bx = x;
  if (opts.align === 'right') bx = x - w - padX * 2;
  else if (opts.align === 'center') bx = x - (w + padX * 2) / 2;
  const by = y - h / 2;
  if (opts.bg !== false) {
    ctx.fillStyle = opts.bg || 'rgba(19, 23, 34, 0.88)';
    roundRectPath(ctx, bx, by, w + padX * 2, h, opts.radius ?? 3);
    ctx.fill();
    if (opts.border) {
      ctx.strokeStyle = opts.border;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.stroke();
    }
  }
  ctx.fillStyle = opts.color || '#d1d4dc';
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], bx + padX, by + padY + lineH * i + lineH / 2 - 2);
  }
  ctx.restore();
  return { x: bx, y: by, w: w + padX * 2, h, lines };
}

function drawTag(ctx, text, x, y, color, opts = {}) {
  if (text == null) return;
  ctx.save();
  ctx.font = opts.font || `10.5px ${FONT}`;
  const w = ctx.measureText(text).width + 10;
  const h = opts.height || 16;
  const bx = opts.toLeft ? x - w : x;
  ctx.fillStyle = color || '#2962ff';
  roundRectPath(ctx, bx, y - h / 2, w, h, 2);
  ctx.fill();
  ctx.fillStyle = opts.color || '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 5, y + 0.5);
  ctx.restore();
}

function drawArrowHead(ctx, from, to, color, size = 8) {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(a - spread) * size, to.y - Math.sin(a - spread) * size);
  ctx.lineTo(to.x - Math.cos(a + spread) * size, to.y - Math.sin(a + spread) * size);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSmallDot(ctx, x, y, color, r = 3) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#131722';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Segment / level helpers
 * ------------------------------------------------------------------ */

function costLine(ctx, s, a, b, alpha = 1) {
  applyStyle(ctx, s, 0, alpha);
  seg(ctx, a, b);
}

function costClipped(ctx, s, a, b, rect, range, alpha = 1) {
  const clipped = clipLineToRect(a, b, rect, range);
  if (!clipped) return;
  costLine(ctx, s, clipped.a, clipped.b, alpha);
  return clipped;
}

function levelLine(ctx, x1, x2, y, color, alpha, style = 0, width = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashFor(style));
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

function verticalLine(ctx, x, y1, y2, color, alpha, style = 0, width = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashFor(style));
  ctx.beginPath();
  ctx.moveTo(x, y1);
  ctx.lineTo(x, y2);
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Trend tools
 * ------------------------------------------------------------------ */

function drawTrend(ctx, s, pts, rect, opts) {
  const [a, b] = pts;
  const color = s.color || '#2962ff';
  if (s.type === 'trend') {
    costLine(ctx, s, a, b);
  } else if (s.type === 'ray') {
    costClipped(ctx, s, a, b, rect, 'ray');
  } else if (s.type === 'extended') {
    costClipped(ctx, s, a, b, rect, 'extended');
  } else if (s.type === 'arrow') {
    costLine(ctx, s, a, b);
    drawArrowHead(ctx, a, b, color, 9);
  } else if (s.type === 'info') {
    costLine(ctx, s, a, b);
    const dPrice = s.points[1].p - s.points[0].p;
    const pct = s.points[0].p ? (dPrice / s.points[0].p) * 100 : 0;
    const dTime = s.points[1].t - s.points[0].t;
    drawLabel(ctx, `${fmtPrice(s.points[1].p)}  ${fmtPct(pct)}\n${fmtDuration(Math.abs(dTime))}`, b.x + 8, b.y - 12, {
      bg: 'rgba(19,23,34,0.92)', border: hexA(color, 0.5), color,
    });
  } else if (s.type === 'trendAngle') {
    costLine(ctx, s, a, b);
    const deg = niceAngle(a, b);
    drawLabel(ctx, `${deg.toFixed(1)}°`, b.x + 8, b.y, {
      bg: 'rgba(19,23,34,0.9)', border: hexA(color, 0.45), color,
    });
  }
}

function drawHorizontal(ctx, s, pts, rect, opts) {
  const p = pts[0];
  const color = s.color || '#787b86';
  applyStyle(ctx, s);
  if (s.type === 'hline' || s.type === 'crossLine') {
    seg(ctx, { x: rect.left, y: p.y }, { x: rect.right, y: p.y });
    drawTag(ctx, opts.fmtPrice ? opts.fmtPrice(s.points[0].p) : fmtPrice(s.points[0].p), rect.right, p.y, color, { toLeft: true });
  }
  if (s.type === 'hray') {
    seg(ctx, { x: p.x, y: p.y }, { x: rect.right, y: p.y });
    drawTag(ctx, opts.fmtPrice ? opts.fmtPrice(s.points[0].p) : fmtPrice(s.points[0].p), rect.right, p.y, color, { toLeft: true });
  }
  if (s.type === 'vline' || s.type === 'crossLine') {
    seg(ctx, { x: p.x, y: rect.top }, { x: p.x, y: rect.bottom });
    drawLabel(ctx, fmtDate(s.points[0].t), p.x, rect.bottom - 10, {
      bg: 'rgba(19,23,34,0.9)', border: hexA(color, 0.45), color, align: 'center',
    });
  }
}

function drawChannel(ctx, s, pts, rect, opts) {
  const color = s.color || '#2962ff';
  const [a, b, c] = pts;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = { x: c.x + dx, y: c.y + dy };
  const alpha = s.fillOpacity ?? 0.07;
  fillPoly(ctx, [a, b, d, c], color, alpha);
  costLine(ctx, s, a, b);
  costClipped(ctx, s, c, d, rect, 'extended');
  drawSmallDot(ctx, c.x, c.y, color);
}

function drawFlatChannel(ctx, s, pts, rect, opts) {
  const color = s.color || '#2962ff';
  const [a, b, c] = pts;
  const y = a.y;
  const left = Math.min(b.x, c.x, a.x);
  const right = Math.max(b.x, c.x, a.x);
  fillPoly(ctx, [{ x: left, y }, { x: right, y }, c, b], color, s.fillOpacity ?? 0.07);
  levelLine(ctx, left, right, y, color, 1, s.lineStyle, s.width);
  costLine(ctx, s, b, c);
}

function drawDisjoint(ctx, s, pts, rect, opts) {
  const color = s.color || '#2962ff';
  const [a, b, c] = pts;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = { x: c.x + dx, y: c.y + dy };
  fillPoly(ctx, [a, b, d, c], color, s.fillOpacity ?? 0.07);
  costLine(ctx, s, a, b);
  costClipped(ctx, s, c, d, rect, 'extended');
}

function drawRegression(ctx, s, pts, rect, opts) {
  const color = s.color || '#2962ff';
  const bars = opts.bars || [];
  const [a, b] = pts;
  const t1 = Math.min(s.points[0].t, s.points[1].t);
  const t2 = Math.max(s.points[0].t, s.points[1].t);
  const sample = bars.filter((bar) => bar.t >= t1 && bar.t <= t2);
  if (sample.length < 2) {
    costLine(ctx, s, a, b);
    return;
  }
  const xs = sample.map((bar) => projectX(opts.project, bar.t));
  const ys = sample.map((bar) => opts.project.y(bar.c));
  const n = xs.length;
  const sx = xs.reduce((v, x) => v + x, 0);
  const sy = ys.reduce((v, y) => v + y, 0);
  const sxx = xs.reduce((v, x) => v + x * x, 0);
  const sxy = xs.reduce((v, x, i) => v + x * ys[i], 0);
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const intercept = (sy - slope * sx) / n;
  const xs2 = xs;
  const resid = ys.map((y, i) => y - (slope * xs2[i] + intercept));
  const sd = Math.sqrt(resid.reduce((v, r) => v + r * r, 0) / Math.max(1, n));
  const x1 = Math.min(...xs);
  const x2 = Math.max(...xs);
  const lineY = (x, k) => slope * x + intercept + k * sd;
  fillPoly(ctx, [
    { x: x1, y: lineY(x1, -2) }, { x: x2, y: lineY(x2, -2) },
    { x: x2, y: lineY(x2, 2) }, { x: x1, y: lineY(x1, 2) },
  ], color, 0.05);
  for (const [k, alpha, style] of [[-2, 0.5, 2], [2, 0.5, 2], [-1, 0.7, 1], [1, 0.7, 1], [0, 1, 0]]) {
    levelLine(ctx, x1, x2, lineY(x1, k), color, alpha, style, k === 0 ? (s.width || 1.5) : 1);
  }
}

function drawVLine(ctx, s, pts, rect, opts) {
  const p = pts[0];
  const color = s.color || '#787b86';
  applyStyle(ctx, s);
  seg(ctx, { x: p.x, y: rect.top }, { x: p.x, y: rect.bottom });
  drawLabel(ctx, fmtDate(s.points[0].t), p.x, rect.bottom - 10, {
    bg: 'rgba(19,23,34,0.9)', border: hexA(color, 0.45), color, align: 'center',
  });
}

function projectX(project, t) {
  return project.x(t);
}

/* ------------------------------------------------------------------ *
 * Fibonacci & Gann
 * ------------------------------------------------------------------ */

function fibLineSet(ctx, s, project, rect, x1, x2, entries, opts = {}) {
  const color = s.color || '#f0a029';
  const sorted = entries.slice().sort((a, b) => a.y - b.y);
  // soft band fill between consecutive levels
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const alpha = i % 2 ? 0.035 : 0.07;
    fillPoly(ctx, [
      { x: x1, y: sorted[i].y }, { x: x2, y: sorted[i].y },
      { x: x2, y: sorted[i + 1].y }, { x: x1, y: sorted[i + 1].y },
    ], color, alpha);
  }
  for (const e of entries) {
    levelLine(ctx, x1, x2, e.y, color, e.alpha ?? 0.9, s.lineStyle, e.level === 0 || e.level === 1 ? 1.4 : 1);
    const text = e.text ?? `${(e.level * 100).toFixed(1)}%`;
    drawLabel(ctx, text, Math.min(x2 - 4, Math.max(x1 + 4, opts.labelX ?? x1 + 4)), e.y - 8, {
      bg: 'rgba(19,23,34,0.78)', color, font: `10px ${FONT}`,
    });
  }
}

function drawFibRetracement(ctx, s, pts, project, rect, opts) {
  const [a, b] = pts;
  const p1 = s.points[0].p;
  const p2 = s.points[1].p;
  const x1 = Math.min(a.x, b.x);
  const x2 = rect.right;
  const entries = FIB_LEVELS.map((level) => ({
    level,
    y: project.y(p1 + (p2 - p1) * level),
    text: `${(level * 100).toFixed(1)}%  ${fmtPrice(p1 + (p2 - p1) * level)}`,
  }));
  fibLineSet(ctx, s, project, rect, x1, x2, entries, { labelX: x1 + 4 });
  costLine(ctx, s, a, b, 0.55);
}

function drawFibExtension(ctx, s, pts, project, rect, opts) {
  const [a, b, c] = pts;
  const dir = s.points[1].p - s.points[0].p;
  const base = s.points[2].p;
  const x1 = Math.min(b.x, c.x);
  const x2 = rect.right;
  const entries = FIB_EXT_LEVELS.map((level) => ({
    level,
    y: project.y(base + dir * level),
    text: `${(level * 100).toFixed(1)}%  ${fmtPrice(base + dir * level)}`,
  }));
  fibLineSet(ctx, s, project, rect, x1, x2, entries, { labelX: x1 + 4 });
  costLine(ctx, s, a, b, 0.5);
  costLine(ctx, s, b, c, 0.5);
}

function drawFibChannel(ctx, s, pts, project, rect, opts) {
  const [a, b, c] = pts;
  const color = s.color || '#f0a029';
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const dist = (c.x - a.x) * nx + (c.y - a.y) * ny;
  const x1 = Math.min(a.x, b.x);
  const x2 = rect.right;
  const edges = FIB_LEVELS.map((level) => {
    const ox = nx * dist * level;
    const oy = ny * dist * level;
    return { level, a: { x: a.x + ox, y: a.y + oy }, b: { x: b.x + ox, y: b.y + oy } };
  });
  for (let i = 0; i < edges.length - 1; i += 1) {
    fillPoly(ctx, [edges[i].a, edges[i].b, edges[i + 1].b, edges[i + 1].a], color, i % 2 ? 0.04 : 0.07);
  }
  for (const e of edges) {
    costClipped(ctx, s, e.a, e.b, rect, 'ray');
    const y = e.a.y + (e.b.y - e.a.y) * ((x2 - e.a.x) / ((e.b.x - e.a.x) || 1));
    drawLabel(ctx, `${(e.level * 100).toFixed(1)}%`, x2 - 4, y, {
      bg: 'rgba(19,23,34,0.78)', color, align: 'right', font: `10px ${FONT}`,
    });
  }
  costLine(ctx, s, a, b, 0.45);
}

function drawFibTime(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#f0a029';
  const a = pts[0];
  const b = pts[1];
  const levels = s.type === 'fibTime' ? FIB_LEVELS : [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const t1 = s.points[0].t;
  const dt = s.points[1].t - t1;
  for (const level of levels) {
    const x = project.x(t1 + dt * level);
    verticalLine(ctx, x, rect.top, rect.bottom, color, level === 0 || level === 1 ? 0.9 : 0.55, s.lineStyle, 1);
    drawLabel(ctx, `${(level * 100).toFixed(1)}%`, x, rect.top + 10, {
      bg: 'rgba(19,23,34,0.78)', color, align: 'center', font: `10px ${FONT}`,
    });
  }
  costLine(ctx, s, a, b, 0.45);
}

function drawFibTimeZone(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#f0a029';
  const t1 = s.points[0].t;
  const dt = s.points[1].t - t1;
  const steps = [1, 2, 3, 5, 8, 13, 21];
  for (const n of steps) {
    const x = project.x(t1 + dt * n);
    if (x < rect.left - 2 || x > rect.right + 2) continue;
    verticalLine(ctx, x, rect.top, rect.bottom, color, 0.55, s.lineStyle, 1);
    drawLabel(ctx, String(n), x, rect.bottom - 10, {
      bg: 'rgba(19,23,34,0.78)', color, align: 'center', font: `10px ${FONT}`,
    });
  }
  costLine(ctx, s, pts[0], pts[1], 0.5);
}

function drawFibSpeedFan(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#f0a029';
  const [a, b] = pts;
  for (const level of FIB_LEVELS) {
    const end = { x: b.x, y: a.y + (b.y - a.y) * level };
    const clipped = clipLineToRect(a, end, rect, 'ray');
    if (clipped) costLine(ctx, s, clipped.a, clipped.b, level === 0 || level === 1 ? 0.95 : 0.55);
    const ly = a.y + (b.y - a.y) * level;
    drawLabel(ctx, `${(level * 100).toFixed(1)}%`, rect.right - 4, ly, {
      bg: 'rgba(19,23,34,0.78)', color, align: 'right', font: `10px ${FONT}`,
    });
  }
  costLine(ctx, s, a, b, 0.4);
}

function drawFibCircles(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#f0a029';
  const [a, b] = pts;
  const base = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ratios = [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
  for (const r of ratios) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dashFor(s.lineStyle));
    ctx.globalAlpha *= 0.55;
    ctx.beginPath();
    ctx.arc(a.x, a.y, base * r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  drawLabel(ctx, `${fmtPrice(s.points[0].p)} → ${fmtPrice(s.points[1].p)}`, a.x + base * 0.25, a.y - base * 0.25, {
    bg: 'rgba(19,23,34,0.72)', color, font: `10px ${FONT}`,
  });
}

function drawFibSpiral(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#f0a029';
  const [a, b] = pts;
  const total = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const start = angleOf(a, b);
  const spiral = [];
  for (let i = 0; i <= 220; i += 1) {
    const t = i / 220;
    const theta = start + t * Math.PI * 5;
    spiral.push(polar(a, total * Math.pow(t, 1.15), theta));
  }
  applyStyle(ctx, s);
  poly(ctx, spiral);
  ctx.stroke();
  drawSmallDot(ctx, a.x, a.y, color);
}

function drawFibArcs(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#f0a029';
  const [a, b] = pts;
  const base = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const start = angleOf(a, b);
  const ratios = [0.236, 0.382, 0.5, 0.618, 0.786, 1];
  for (const r of ratios) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dashFor(s.lineStyle));
    ctx.globalAlpha *= 0.6;
    ctx.beginPath();
    ctx.arc(a.x, a.y, base * r, start - Math.PI / 2, start + Math.PI / 2);
    ctx.stroke();
    ctx.restore();
  }
  drawSmallDot(ctx, a.x, a.y, color);
}

function drawFibWedge(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#f0a029';
  const [a, b, c] = pts;
  const a1 = angleOf(a, b);
  const a2 = angleOf(a, c);
  const radius = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y));
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  for (const level of levels) {
    const ang = lerp(a1, a2, level);
    const end = polar(a, radius * 1.6, ang);
    const clipped = clipLineToRect(a, end, rect, 'ray');
    if (clipped) costLine(ctx, s, clipped.a, clipped.b, 0.6);
  }
  fillPoly(ctx, [a, b, c], color, s.fillOpacity ?? 0.04);
  costLine(ctx, s, a, b, 0.9);
  costLine(ctx, s, a, c, 0.9);
}

function drawPitchfork(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#2962ff';
  const [a, b, c] = pts;
  const baseMid = mid(b, c);
  let origin = a;
  if (s.type === 'pitchforkSchiff') origin = mid(a, b);
  else if (s.type === 'pitchforkModifiedSchiff') origin = mid(a, mid(a, b));
  else if (s.type === 'pitchforkInside') origin = mid(a, baseMid);

  const dx = baseMid.x - origin.x;
  const dy = baseMid.y - origin.y;
  const far = { x: origin.x + dx * 4, y: origin.y + dy * 4 };
  const farB = { x: b.x + dx * 4, y: b.y + dy * 4 };
  const farC = { x: c.x + dx * 4, y: c.y + dy * 4 };

  const median = clipLineToRect(origin, far, rect, 'extended');
  const lineB = clipLineToRect(b, farB, rect, 'extended');
  const lineC = clipLineToRect(c, farC, rect, 'extended');

  if (lineB && lineC) {
    fillPoly(ctx, [lineB.a, lineB.b, lineC.b, lineC.a], color, s.fillOpacity ?? 0.05);
  }
  if (median) costLine(ctx, s, median.a, median.b, 0.95);
  if (lineB) costLine(ctx, s, lineB.a, lineB.b, 0.7);
  if (lineC) costLine(ctx, s, lineC.a, lineC.b, 0.7);
  costLine(ctx, s, b, c, 0.55);
  drawSmallDot(ctx, origin.x, origin.y, color);
}

function drawGannBox(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#9c6ade';
  const [a, b] = pts;
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  fillPoly(ctx, [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }], color, s.fillOpacity ?? 0.04);
  applyStyle(ctx, s);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  for (let i = 1; i < 8; i += 1) {
    const f = i / 8;
    levelLine(ctx, x1, x2, lerp(y1, y2, f), color, 0.35, 2, 1);
    verticalLine(ctx, lerp(x1, x2, f), y1, y2, color, 0.35, 2, 1);
  }
  levelLine(ctx, x1, x2, (y1 + y2) / 2, color, 0.65, 1, 1);
  verticalLine(ctx, (x1 + x2) / 2, y1, y2, color, 0.65, 1, 1);
  ctx.save();
  ctx.globalAlpha *= 0.65;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.moveTo(x2, y1);
  ctx.lineTo(x1, y2);
  ctx.stroke();
  ctx.restore();
}

function drawGannSquare(ctx, s, pts, project, rect, opts) {
  const [a, b] = pts;
  const w = b.x - a.x;
  const h = b.y - a.y;
  const size = Math.max(Math.abs(w), Math.abs(h));
  const bb = {
    x: a.x + Math.sign(w || 1) * size,
    y: a.y + Math.sign(h || 1) * size,
  };
  drawGannBox(ctx, s, [a, bb], project, rect, opts);
}

function drawGannFan(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#9c6ade';
  const [a, b] = pts;
  const ratios = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8];
  for (const r of ratios) {
    const end = { x: b.x, y: a.y + (b.y - a.y) * r };
    const clipped = clipLineToRect(a, end, rect, 'ray');
    if (clipped) costLine(ctx, s, clipped.a, clipped.b, r === 1 ? 0.95 : 0.55);
    drawLabel(ctx, `1×${r < 1 ? `1/${Math.round(1 / r)}` : r}`, rect.right - 4, end.y, {
      bg: 'rgba(19,23,34,0.72)', color, align: 'right', font: `9px ${FONT}`,
    });
  }
  costLine(ctx, s, a, b, 0.35);
}

/* ------------------------------------------------------------------ *
 * Patterns
 * ------------------------------------------------------------------ */

const PATTERN_LABELS = {
  xabcd: ['X', 'A', 'B', 'C', 'D'],
  cypher: ['X', 'A', 'B', 'C', 'D'],
  abcd: ['A', 'B', 'C', 'D'],
  trianglePattern: ['A', 'B', 'C'],
  threeDrives: ['1', '2', '3', '4', '5'],
  headShoulders: ['LS', 'T', 'H', 'T', 'RS'],
  elliottImpulse: ['0', '1', '2', '3', '4', '5'],
  elliottTriangle: ['A', 'B', 'C', 'D', 'E'],
  elliottCorrection: ['A', 'B', 'C'],
  elliottDoubleCombo: ['W', 'X', 'Y'],
  elliottTripleCombo: ['W', 'X', 'Y', 'X', 'Z'],
};

function drawPattern(ctx, s, pts) {
  const color = s.color || '#f0a029';
  applyStyle(ctx, s);
  const closed = s.type === 'trianglePattern' || s.type === 'elliottTriangle' || s.type === 'headShoulders';
  poly(ctx, pts, closed);
  ctx.stroke();
  if (s.type === 'headShoulders') {
    // neckline through the two troughs
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha *= 0.55;
    seg(ctx, pts[1], pts[3]);
    ctx.restore();
  }
  const labels = PATTERN_LABELS[s.type] || [];
  for (let i = 0; i < pts.length; i += 1) {
    drawSmallDot(ctx, pts[i].x, pts[i].y, color, 3);
    if (labels[i]) {
      drawLabel(ctx, labels[i], pts[i].x + 8, pts[i].y - 10, {
        bg: 'rgba(19,23,34,0.8)', color, font: `bold 10px ${FONT}`,
      });
    }
  }
}

function drawCyclicLines(ctx, s, pts, project, rect) {
  const color = s.color || '#787b86';
  const t1 = s.points[0].t;
  const dt = s.points[1].t - t1;
  if (!dt) return;
  let n = 1;
  if (project.indexForTime && project.indexAtX) {
    const i1 = project.indexForTime(t1);
    const per = project.indexForTime(t1 + dt) - i1;
    if (per > 0.01) n = Math.max(1, Math.floor((project.indexAtX(rect.left) - i1) / per));
  }
  for (let guard = 0; guard < 400; guard += 1) {
    const x = project.x(t1 + dt * n);
    if (x > rect.right + 2) break;
    if (x >= rect.left - 2) {
      verticalLine(ctx, x, rect.top, rect.bottom, color, 0.55, s.lineStyle, 1);
      drawLabel(ctx, String(n), x, rect.bottom - 10, {
        bg: 'rgba(19,23,34,0.7)', color, align: 'center', font: `9px ${FONT}`,
      });
    }
    n += 1;
  }
}

function drawTimeCycles(ctx, s, pts, project, rect) {
  const color = s.color || '#787b86';
  const [a, b] = pts;
  const base = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  for (let n = 1; n <= 6; n += 1) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha *= 0.5;
    ctx.lineWidth = 1;
    ctx.setLineDash(dashFor(s.lineStyle));
    ctx.beginPath();
    ctx.arc(a.x, a.y, base * n, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  drawSmallDot(ctx, a.x, a.y, color);
}

function drawSine(ctx, s, pts) {
  const color = s.color || '#2962ff';
  const [a, b] = pts;
  const amp = Math.abs(b.y - a.y) / 2;
  const midY = (a.y + b.y) / 2;
  const waves = 2;
  applyStyle(ctx, s);
  ctx.beginPath();
  const steps = 120;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = lerp(a.x, b.x, t);
    const y = midY + Math.sin(t * Math.PI * 2 * waves) * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  drawSmallDot(ctx, a.x, a.y, color);
  drawSmallDot(ctx, b.x, b.y, color);
}

/* ------------------------------------------------------------------ *
 * Forecasting / position / profiles
 * ------------------------------------------------------------------ */

export function positionMetrics(s, opts = {}) {
  const entry = s.points[0]?.p;
  const target = s.points[1]?.p;
  const stop = s.points[2]?.p;
  if (![entry, target, stop].every(Number.isFinite)) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  const account = Number.isFinite(s.accountSize) ? s.accountSize : 10000;
  const riskPct = Number.isFinite(s.riskPercent) ? s.riskPercent : 1;
  const size = risk > 0 ? (account * (riskPct / 100)) / risk : 0;
  const profit = reward * size;
  const loss = risk * size;
  const direction = s.position === 'short' ? -1 : 1;
  const favorable = direction > 0 ? target > entry : target < entry;
  const stopOk = direction > 0 ? stop < entry : stop > entry;
  return {
    entry, target, stop, risk, reward, rr, size, profit, loss, account, riskPct,
    direction, favorable, stopOk,
  };
}

function drawPosition(ctx, s, pts, project, rect, opts) {
  const [entry, target, stop] = pts;
  const m = positionMetrics(s);
  if (!m) return;
  const x1 = entry.x;
  const x2 = Math.max(target.x, stop.x, entry.x + 40);
  const entryY = entry.y;
  const targetY = target.y;
  const stopY = stop.y;
  const green = '#26a69a';
  const red = '#ef5350';
  const forecast = s.type === 'positionForecast';

  // Reward / risk boxes
  fillPoly(ctx, [
    { x: x1, y: entryY }, { x: x2, y: entryY },
    { x: x2, y: targetY }, { x: x1, y: targetY },
  ], green, forecast ? 0.1 : 0.16);
  fillPoly(ctx, [
    { x: x1, y: entryY }, { x: x2, y: entryY },
    { x: x2, y: stopY }, { x: x1, y: stopY },
  ], red, forecast ? 0.1 : 0.16);

  // borders
  ctx.save();
  ctx.strokeStyle = hexA(green, 0.9);
  ctx.lineWidth = 1;
  ctx.setLineDash(forecast ? [5, 4] : []);
  ctx.beginPath();
  ctx.moveTo(x1, targetY);
  ctx.lineTo(x2, targetY);
  ctx.stroke();
  ctx.strokeStyle = hexA(red, 0.9);
  ctx.beginPath();
  ctx.moveTo(x1, stopY);
  ctx.lineTo(x2, stopY);
  ctx.stroke();
  ctx.restore();

  costLine(ctx, { ...s, color: '#d1d4dc', lineStyle: 0, width: 1.2 }, { x: x1, y: entryY }, { x: x2, y: entryY }, 0.9);

  const pct = (p) => (m.entry ? ((p - m.entry) / m.entry) * 100 : 0);
  const right = Math.min(rect.right - 4, x2);
  drawTag(ctx, `Target ${fmtPrice(m.target)}  ${fmtPct(pct(m.target))}`, right, targetY, green, { toLeft: true });
  drawTag(ctx, `Entry ${fmtPrice(m.entry)}`, right, entryY, '#4c525e', { toLeft: true });
  drawTag(ctx, `Stop ${fmtPrice(m.stop)}  ${fmtPct(pct(m.stop))}`, right, stopY, red, { toLeft: true });

  const base = String(opts.symbol || '').replace(/(USDT|USDC|BUSD|FDUSD)$/, '') || 'units';
  const lines = [
    `${s.position === 'short' ? 'SHORT' : s.position === 'forecast' ? 'FORECAST' : 'LONG'}  ·  R:R 1 : ${m.rr.toFixed(2)}`,
    `Risk ${m.riskPct.toFixed(2)}%  (${fmtCompact(m.loss)})  ·  Reward ${fmtCompact(m.profit)}`,
    `Size ${m.size.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${base}`,
    `Entry ${fmtPrice(m.entry)}  →  Target ${fmtPrice(m.target)}  /  Stop ${fmtPrice(m.stop)}`,
  ];
  drawLabel(ctx, lines.join('\n'), Math.min(x1 + 8, rect.right - 240), Math.max(rect.top + 30, Math.min(entryY, targetY, stopY) - 12), {
    bg: 'rgba(19,23,34,0.92)', border: hexA(s.position === 'short' ? red : green, 0.55), color: '#d1d4dc', lineH: 15,
  });
}

function drawRange(ctx, s, pts, project, rect, opts) {
  const [a, b] = pts;
  const color = s.color || '#2962ff';
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  const showTime = s.type === 'dateRange' || s.type === 'datePriceRange';
  const showPrice = s.type === 'priceRange' || s.type === 'datePriceRange';

  const left = showTime ? x1 : rect.left;
  const right = showTime ? x2 : rect.right;
  const top = showPrice ? y1 : rect.top;
  const bottom = showPrice ? y2 : rect.bottom;
  fillPoly(ctx, [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }], color, s.fillOpacity ?? 0.08);

  ctx.save();
  applyStyle(ctx, s);
  ctx.globalAlpha *= 0.8;
  if (showTime) {
    seg(ctx, { x: x1, y: top }, { x: x1, y: bottom });
    seg(ctx, { x: x2, y: top }, { x: x2, y: bottom });
  }
  if (showPrice) {
    seg(ctx, { x: left, y: y1 }, { x: right, y: y1 });
    seg(ctx, { x: left, y: y2 }, { x: right, y: y2 });
  }
  ctx.restore();

  const lines = [];
  if (showTime) {
    const dTime = Math.abs(s.points[1].t - s.points[0].t);
    lines.push(`${fmtDuration(dTime)}  ·  ${fmtDateShort(Math.min(s.points[0].t, s.points[1].t))} → ${fmtDateShort(Math.max(s.points[0].t, s.points[1].t))}`);
  }
  if (showPrice) {
    const dPrice = s.points[1].p - s.points[0].p;
    const pct = s.points[0].p ? (dPrice / s.points[0].p) * 100 : 0;
    lines.push(`${fmtPrice(Math.abs(dPrice))}  (${fmtPct(pct)})  ·  ${fmtPrice(s.points[0].p)} → ${fmtPrice(s.points[1].p)}`);
  }
  const cx = showTime ? (x1 + x2) / 2 : rect.right - 150;
  const cy = showPrice ? (y1 + y2) / 2 : rect.top + 30;
  drawLabel(ctx, lines.join('\n'), cx, cy, {
    bg: 'rgba(19,23,34,0.9)', border: hexA(color, 0.5), color, align: 'center',
  });
}

function ghostBars(ctx, s, pts, project, rect, opts) {
  const bars = opts.bars || [];
  if (!bars.length) {
    const [a, b] = pts;
    costLine(ctx, s, a, b);
    return;
  }
  const [a, b] = pts;
  const n = Math.min(40, bars.length);
  const start = bars.length - n;
  const base = bars[start];
  const width = Math.max(30, b.x - a.x);
  const step = width / n;
  const offset = s.points[0].p - base.c;
  const alpha = s.type === 'ghostFeed' ? 0.32 : 0.55;
  const up = '#26a69a';
  const down = '#ef5350';
  const bodyW = Math.max(1, step * 0.62);

  ctx.save();
  ctx.globalAlpha *= alpha;
  for (let i = 0; i < n; i += 1) {
    const bar = bars[start + i];
    const x = a.x + (i + 0.5) * step;
    if (x < rect.left - 2 || x > rect.right + 2) continue;
    const o = project.y(bar.o + offset);
    const c = project.y(bar.c + offset);
    const h = project.y(bar.h + offset);
    const l = project.y(bar.l + offset);
    ctx.strokeStyle = c >= o ? up : down;
    ctx.fillStyle = c >= o ? up : down;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x, l);
    ctx.stroke();
    ctx.fillRect(x - bodyW / 2, Math.min(o, c), bodyW, Math.max(1, Math.abs(c - o)));
  }
  ctx.restore();
  drawLabel(ctx, s.type === 'ghostFeed' ? 'Ghost feed' : `Bars pattern · ${n}`, a.x + 8, a.y - 12, {
    bg: 'rgba(19,23,34,0.8)', color: s.color || '#787b86', font: `10px ${FONT}`,
  });
  applyStyle(ctx, s);
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha *= 0.6;
  poly(ctx, [a, b, { x: b.x, y: b.y + 1 }, { x: a.x, y: a.y + 1 }]);
  ctx.stroke();
}

function drawSector(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#2962ff';
  const [a, b, c] = pts;
  const radius = Math.hypot(b.x - a.x, b.y - a.y);
  const a1 = angleOf(a, b);
  const a2 = angleOf(a, c);
  ctx.save();
  ctx.globalAlpha *= s.fillOpacity ?? 0.08;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.arc(a.x, a.y, radius, a1, a2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  applyStyle(ctx, s);
  ctx.globalAlpha *= 0.85;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.arc(a.x, a.y, radius, a1, a2);
  ctx.closePath();
  ctx.stroke();
}

function volumeProfileData(project, t1, t2, price1, price2, bins = 24) {
  const bars = (project.bars || []).filter((b) => b.t >= t1 && b.t <= t2);
  if (!bars.length) return null;
  let lo = price1;
  let hi = price2;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = Infinity;
    hi = -Infinity;
    for (const b of bars) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
  }
  if (!(hi > lo)) return null;
  const volumes = new Array(bins).fill(0);
  for (const b of bars) {
    const price = (b.h + b.l + b.c) / 3;
    const idx = clamp(Math.floor(((price - lo) / (hi - lo)) * bins), 0, bins - 1);
    volumes[idx] += b.v || 0;
  }
  let poc = 0;
  for (let i = 1; i < bins; i += 1) if (volumes[i] > volumes[poc]) poc = i;
  return { bars, lo, hi, volumes, poc, bins, max: Math.max(...volumes) || 1 };
}

function drawVolumeProfile(ctx, s, pts, project, rect, opts, anchored = false) {
  const color = s.color || '#2962ff';
  const [a, b] = pts;
  const t1 = Math.min(s.points[0].t, s.points[1].t);
  const t2 = Math.max(s.points[0].t, s.points[1].t);
  const profile = volumeProfileData(project, t1, t2, anchored ? null : Math.min(s.points[0].p, s.points[1].p), anchored ? null : Math.max(s.points[0].p, s.points[1].p));
  if (!profile) {
    costLine(ctx, s, a, b);
    return;
  }
  const xRight = Math.max(a.x, b.x);
  const width = Math.max(40, Math.min(180, Math.abs(b.x - a.x) || 120));
  const binH = (project.y(profile.lo) - project.y(profile.hi)) / profile.bins;
  for (let i = 0; i < profile.bins; i += 1) {
    const price = lerp(profile.lo, profile.hi, (i + 0.5) / profile.bins);
    const y = project.y(price);
    const w = (profile.volumes[i] / profile.max) * width;
    ctx.save();
    ctx.globalAlpha *= i === profile.poc ? 0.8 : (s.fillOpacity ?? 0.16);
    ctx.fillStyle = i === profile.poc ? '#f0a029' : color;
    ctx.fillRect(xRight - w, y - Math.abs(binH) / 2, w, Math.max(1, Math.abs(binH) - 0.5));
    ctx.restore();
  }
  const top = project.y(profile.hi);
  const bottom = project.y(profile.lo);
  applyStyle(ctx, s);
  ctx.setLineDash([4, 3]);
  ctx.globalAlpha *= 0.6;
  ctx.strokeRect(xRight - width, Math.min(top, bottom), width, Math.abs(bottom - top));
  drawLabel(ctx, `${fmtCompact(profile.volumes[profile.poc])} POC`, xRight - width, Math.min(top, bottom) - 10, {
    bg: 'rgba(19,23,34,0.85)', color: '#f0a029', font: `10px ${FONT}`,
  });
}

function vwapPoints(project, t1, opts) {
  const bars = project.bars || [];
  const points = [];
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (b.t < t1) continue;
    const typical = (b.h + b.l + b.c) / 3;
    const v = b.v || 0;
    pv += typical * v;
    vol += v;
    if (vol > 0) points.push({ x: project.x(b.t), y: project.y(pv / vol), t: b.t, p: pv / vol });
  }
  return points;
}

function drawVwap(ctx, s, pts, project, rect, opts) {
  const color = s.color || '#2962ff';
  const points = vwapPoints(project, s.points[0].t, opts);
  if (points.length < 2) {
    drawHorizontal(ctx, { ...s, type: 'hline' }, pts, rect, opts);
    return;
  }
  applyStyle(ctx, s);
  poly(ctx, points);
  ctx.stroke();
  const last = points[points.length - 1];
  drawTag(ctx, `VWAP ${fmtPrice(last.p)}`, last.x, last.y, color, { toLeft: true });
  drawSmallDot(ctx, points[0].x, points[0].y, color);
}

/* ------------------------------------------------------------------ *
 * Geometric shapes
 * ------------------------------------------------------------------ */

function drawShape(ctx, s, pts, rect, opts) {
  const color = s.color || '#2962ff';
  const alpha = s.fillOpacity ?? 0.08;
  if (s.type === 'brush' || s.type === 'highlighter' || s.type === 'path' || s.type === 'polyline') {
    ctx.save();
    ctx.globalAlpha *= s.type === 'highlighter' ? 0.45 : 1;
    applyStyle(ctx, s);
    if (s.width) ctx.lineWidth = s.width;
    if (s.type === 'brush') {
      ctx.beginPath();
      smoothPolyline(ctx, pts);
      ctx.stroke();
    } else {
      poly(ctx, pts);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  if (s.type === 'rectangle') {
    const r = rectOf(pts[0], pts[1]);
    fillPoly(ctx, [
      { x: r.left, y: r.top }, { x: r.right, y: r.top },
      { x: r.right, y: r.bottom }, { x: r.left, y: r.bottom },
    ], color, alpha);
    applyStyle(ctx, s);
    ctx.strokeRect(r.left, r.top, r.w, r.h);
    return;
  }
  if (s.type === 'rotatedRectangle') {
    const [a, b, c] = pts;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const off = (c.x - a.x) * nx + (c.y - a.y) * ny;
    const corners = [
      a, b, { x: b.x + nx * off, y: b.y + ny * off }, { x: a.x + nx * off, y: a.y + ny * off },
    ];
    fillPoly(ctx, corners, color, alpha);
    applyStyle(ctx, s);
    poly(ctx, corners, true);
    ctx.stroke();
    return;
  }
  if (s.type === 'circle') {
    const [a, b] = pts;
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    applyStyle(ctx, s);
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (s.type === 'ellipse') {
    const [a, b] = pts;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2 || 1;
    const ry = Math.abs(b.y - a.y) / 2 || 1;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    applyStyle(ctx, s);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (s.type === 'triangleShape') {
    fillPoly(ctx, pts, color, alpha);
    applyStyle(ctx, s);
    poly(ctx, pts, true);
    ctx.stroke();
    return;
  }
  if (s.type === 'arc') {
    const circle = circleFrom3(pts[0], pts[1], pts[2]);
    if (!circle) { costLine(ctx, s, pts[0], pts[2]); return; }
    const a1 = Math.atan2(pts[0].y - circle.y, pts[0].x - circle.x);
    const a3 = Math.atan2(pts[2].y - circle.y, pts[2].x - circle.x);
    const cross = (pts[1].x - pts[0].x) * (pts[2].y - pts[0].y) - (pts[1].y - pts[0].y) * (pts[2].x - pts[0].x);
    applyStyle(ctx, s);
    ctx.beginPath();
    ctx.arc(circle.x, circle.y, circle.r, a1, a3, cross < 0);
    ctx.stroke();
    return;
  }
  if (s.type === 'curve') {
    applyStyle(ctx, s);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.quadraticCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y);
    ctx.stroke();
    return;
  }
  if (s.type === 'doubleCurve') {
    applyStyle(ctx, s);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.bezierCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y);
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------ *
 * Text, annotations & stickers
 * ------------------------------------------------------------------ */

function drawTextShape(ctx, s, pts, rect, opts) {
  const [a] = pts;
  const color = s.color || '#d1d4dc';
  const font = `${s.fontSize || 12}px ${FONT}`;
  const text = s.text || (s.type === 'text' ? 'Text' : s.type);
  const lines = String(text).split('\n');
  ctx.save();
  ctx.font = font;
  let w = 0;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  const lineH = (s.fontSize || 12) * 1.35;
  const h = lines.length * lineH + 10;
  const pad = 6;

  if (s.type === 'priceLabel') {
    drawTag(ctx, fmtPrice(s.points[0].p), rect.right, a.y, color, { toLeft: true });
    return;
  }

  if (s.type === 'priceNote') {
    drawTag(ctx, fmtPrice(s.points[0].p), rect.right, a.y, color, { toLeft: true });
    drawLabel(ctx, text, rect.right - 70, a.y - 24, {
      bg: hexA(color, 0.16), border: color, color: '#d1d4dc', font: `11px ${FONT}`,
    });
    return;
  }

  if (s.type === 'note' || s.type === 'comment' || s.type === 'anchoredNote') {
    const bx = a.x + 8;
    const by = a.y - h - 8;
    ctx.fillStyle = hexA(color, s.type === 'comment' ? 0.16 : 0.14);
    roundRectPath(ctx, bx, by, w + pad * 2, h, 4);
    ctx.fill();
    ctx.strokeStyle = hexA(color, 0.65);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
    if (s.type === 'anchoredNote') {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(bx, by + h);
      ctx.stroke();
    }
    ctx.fillStyle = '#e8eaf0';
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], bx + pad, by + pad + lineH * (i + 0.8));
    }
    drawSmallDot(ctx, a.x, a.y, color, 2.5);
    return;
  }

  if (s.type === 'signpost') {
    const bx = a.x + 8;
    const by = a.y - h - 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x, by + h);
    ctx.stroke();
    ctx.fillStyle = hexA(color, 0.9);
    roundRectPath(ctx, bx, by, w + pad * 2, h, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], bx + pad, by + pad + lineH * (i + 0.8));
    }
    return;
  }

  if (s.type === 'callout') {
    const bx = a.x + 12;
    const by = a.y - h - 20;
    ctx.fillStyle = hexA(color, 0.16);
    roundRectPath(ctx, bx, by, w + pad * 2, h, 6);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx + 8, by + h);
    ctx.lineTo(a.x, a.y);
    ctx.lineTo(bx + 22, by + h);
    ctx.closePath();
    ctx.fillStyle = hexA(color, 0.16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8eaf0';
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], bx + pad, by + pad + lineH * (i + 0.8));
    }
    drawSmallDot(ctx, a.x, a.y, color, 2.5);
    return;
  }

  // plain text
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], a.x, a.y + i * lineH);
  }
  ctx.restore();
}

function drawMarker(ctx, s, pts) {
  const [a] = pts;
  const color = s.color || '#2962ff';
  const dir = s.marker || 'up';
  const size = 15;
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.fillStyle = color;
  if (dir === 'up') {
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size * 0.55);
    ctx.lineTo(0, size * 0.2);
    ctx.lineTo(-size * 0.7, size * 0.55);
    ctx.closePath();
    ctx.fill();
  } else if (dir === 'down') {
    ctx.rotate(Math.PI);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size * 0.55);
    ctx.lineTo(0, size * 0.2);
    ctx.lineTo(-size * 0.7, size * 0.55);
    ctx.closePath();
    ctx.fill();
  } else if (dir === 'left') {
    ctx.rotate(-Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size * 0.55);
    ctx.lineTo(0, size * 0.2);
    ctx.lineTo(-size * 0.7, size * 0.55);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size * 0.55);
    ctx.lineTo(0, size * 0.2);
    ctx.lineTo(-size * 0.7, size * 0.55);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawFlag(ctx, s, pts) {
  const [a] = pts;
  const color = s.color || '#2962ff';
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(a.x, a.y - 26);
  ctx.stroke();
  ctx.fillStyle = hexA(color, 0.85);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - 26);
  ctx.lineTo(a.x + 22, a.y - 19);
  ctx.lineTo(a.x, a.y - 12);
  ctx.closePath();
  ctx.fill();
  drawSmallDot(ctx, a.x, a.y, color, 2.5);
  ctx.restore();
}

function drawSticker(ctx, s, pts, opts) {
  const [a] = pts;
  const size = s.fontSize || 26;
  ctx.save();
  ctx.font = `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(s.emoji || '😀', a.x, a.y);
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Measure / zoom preview
 * ------------------------------------------------------------------ */

function drawMeasure(ctx, s, pts, project, rect, opts) {
  const [a, b] = pts;
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  const color = s.type === 'zoom' ? '#2962ff' : '#26a69a';
  fillPoly(ctx, [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }], color, 0.12);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  ctx.restore();
  const dPrice = s.points[1].p - s.points[0].p;
  const pct = s.points[0].p ? (dPrice / s.points[0].p) * 100 : 0;
  const dTime = s.points[1].t - s.points[0].t;
  const bars = project.indexForTime ? Math.round(Math.abs(project.indexForTime(s.points[1].t) - project.indexForTime(s.points[0].t))) : 0;
  if (s.type === 'zoom') {
    drawLabel(ctx, `Zoom to ${bars} bars`, (x1 + x2) / 2, (y1 + y2) / 2, {
      bg: 'rgba(19,23,34,0.92)', border: color, color, align: 'center',
    });
    return;
  }
  const lines = [
    `${dPrice >= 0 ? '+' : ''}${fmtPrice(dPrice)}  (${fmtPct(pct)})`,
    `${bars} bars  ·  ${fmtDuration(Math.abs(dTime))}`,
  ];
  drawLabel(ctx, lines.join('\n'), (x1 + x2) / 2, (y1 + y2) / 2, {
    bg: 'rgba(19,23,34,0.92)', border: color, color, align: 'center', lineH: 16,
  });
}

/* ------------------------------------------------------------------ *
 * Public render
 * ------------------------------------------------------------------ */

export function renderShape(ctx, s, project, opts = {}) {
  if (!s || !s.points || !s.points.length) return;
  const pts = projectPoints(s, project);
  const rect = viewRect(project);
  const ro = { ...opts, project, bars: opts.bars || project.bars || [] };

  // While a multi-anchor tool is being drawn there are fewer anchors than the
  // finished shape needs. Draw a generic guide instead of letting the
  // type-specific renderer index points that do not exist yet.
  const def = toolDef(s.type);
  if (opts.preview && def && def.kind === 'draw' && def.anchors > 0 && pts.length < def.anchors) {
    const color = s.color || '#2962ff';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = s.width ?? 1.5;
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha *= 0.8;
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  ctx.save();
  if (opts.preview) ctx.globalAlpha *= 0.72;
  switch (s.type) {
    case 'trend': case 'ray': case 'extended': case 'info': case 'trendAngle': case 'arrow':
      drawTrend(ctx, s, pts, rect, ro); break;
    case 'hline': case 'hray': case 'vline': case 'crossLine':
      drawHorizontal(ctx, s, pts, rect, ro); break;
    case 'parallelChannel': drawChannel(ctx, s, pts, rect, ro); break;
    case 'flatTopBottom': drawFlatChannel(ctx, s, pts, rect, ro); break;
    case 'disjointChannel': drawDisjoint(ctx, s, pts, rect, ro); break;
    case 'regression': drawRegression(ctx, s, pts, rect, ro); break;

    case 'fibRetracement': drawFibRetracement(ctx, s, pts, project, rect, ro); break;
    case 'fibExtension': drawFibExtension(ctx, s, pts, project, rect, ro); break;
    case 'fibChannel': drawFibChannel(ctx, s, pts, project, rect, ro); break;
    case 'fibTimeZone': drawFibTimeZone(ctx, s, pts, project, rect, ro); break;
    case 'fibTime': drawFibTime(ctx, s, pts, project, rect, ro); break;
    case 'fibSpeedFan': drawFibSpeedFan(ctx, s, pts, project, rect, ro); break;
    case 'fibCircles': drawFibCircles(ctx, s, pts, project, rect, ro); break;
    case 'fibSpiral': drawFibSpiral(ctx, s, pts, project, rect, ro); break;
    case 'fibArcs': drawFibArcs(ctx, s, pts, project, rect, ro); break;
    case 'fibWedge': drawFibWedge(ctx, s, pts, project, rect, ro); break;
    case 'pitchfork': case 'pitchforkSchiff': case 'pitchforkModifiedSchiff': case 'pitchforkInside':
      drawPitchfork(ctx, s, pts, project, rect, ro); break;
    case 'gannBox':
      drawGannBox(ctx, s, pts, project, rect, ro); break;
    case 'gannSquareFixed': case 'gannSquare':
      drawGannSquare(ctx, s, pts, project, rect, ro); break;
    case 'gannFan': drawGannFan(ctx, s, pts, project, rect, ro); break;

    case 'xabcd': case 'cypher': case 'abcd': case 'trianglePattern': case 'threeDrives':
    case 'headShoulders': case 'elliottImpulse': case 'elliottTriangle': case 'elliottCorrection':
    case 'elliottDoubleCombo': case 'elliottTripleCombo':
      drawPattern(ctx, s, pts); break;
    case 'cyclicLines': drawCyclicLines(ctx, s, pts, project, rect); break;
    case 'timeCycles': drawTimeCycles(ctx, s, pts, project, rect); break;
    case 'sineLine': drawSine(ctx, s, pts); break;

    case 'longPosition': case 'shortPosition': case 'positionForecast':
      drawPosition(ctx, s, pts, project, rect, ro); break;
    case 'dateRange': case 'priceRange': case 'datePriceRange':
      drawRange(ctx, s, pts, project, rect, ro); break;
    case 'barsPattern': case 'ghostFeed': ghostBars(ctx, s, pts, project, rect, ro); break;
    case 'sector': drawSector(ctx, s, pts, project, rect, ro); break;
    case 'fixedRangeVolumeProfile': drawVolumeProfile(ctx, s, pts, project, rect, ro, false); break;
    case 'anchoredVolumeProfile': drawVolumeProfile(ctx, s, pts, project, rect, ro, true); break;
    case 'anchoredVWAP': drawVwap(ctx, s, pts, project, rect, ro); break;

    case 'brush': case 'highlighter': case 'rectangle': case 'rotatedRectangle': case 'circle':
    case 'ellipse': case 'path': case 'polyline': case 'triangleShape': case 'arc': case 'curve':
    case 'doubleCurve':
      drawShape(ctx, s, pts, rect, ro); break;

    case 'text': case 'note': case 'anchoredNote': case 'signpost': case 'callout': case 'comment':
    case 'priceLabel': case 'priceNote':
      drawTextShape(ctx, s, pts, rect, ro); break;
    case 'arrowMarker': case 'arrowMarkLeft': case 'arrowMarkRight': case 'arrowMarkUp': case 'arrowMarkDown':
      drawMarker(ctx, s, pts); break;
    case 'flagMark': drawFlag(ctx, s, pts); break;
    case 'sticker': drawSticker(ctx, s, pts, ro); break;

    case 'measure': case 'zoom':
      drawMeasure(ctx, s, pts, project, rect, ro); break;

    default:
      // Unknown/legacy type: draw a safe polyline so it is never invisible.
      applyStyle(ctx, s);
      poly(ctx, pts);
      ctx.stroke();
      for (const p of pts) drawSmallDot(ctx, p.x, p.y, s.color || '#2962ff', 2.5);
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Hit geometry
 * ------------------------------------------------------------------ */

function pushSeg(out, a, b) {
  if (a && b && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.x) && Number.isFinite(b.y)) {
    out.segs.push({ a, b });
  }
}

function pushPoly(out, pts, closed = false, filled = false, fillAlpha = 0.08) {
  out.polys.push({ pts, closed, filled, fillAlpha });
  for (let i = 0; i < pts.length - 1; i += 1) pushSeg(out, pts[i], pts[i + 1]);
  if (closed && pts.length) pushSeg(out, pts[pts.length - 1], pts[0]);
}

function pushRect(out, r, filled = false) {
  out.rects.push({ ...r, filled });
  pushSeg(out, { x: r.left, y: r.top }, { x: r.right, y: r.top });
  pushSeg(out, { x: r.right, y: r.top }, { x: r.right, y: r.bottom });
  pushSeg(out, { x: r.right, y: r.bottom }, { x: r.left, y: r.bottom });
  pushSeg(out, { x: r.left, y: r.bottom }, { x: r.left, y: r.top });
}

function pushCircle(out, c, r, filled = false) {
  out.circles.push({ x: c.x, y: c.y, r, filled });
}

/**
 * Approximate outline used for pointer hit-testing. It intentionally mirrors
 * the renderer's main strokes rather than its decorative labels.
 */
export function shapeOutline(s, project, opts = {}) {
  const out = { segs: [], polys: [], rects: [], circles: [] };
  if (!s || !s.points || !s.points.length) return out;
  const pts = projectPoints(s, project);
  const rect = viewRect(project);
  const bars = opts.bars || project.bars || [];
  const addLine = (a, b, range = 'segment') => {
    const c = clipLineToRect(a, b, rect, range);
    if (c) pushSeg(out, c.a, c.b);
  };

  switch (s.type) {
    case 'trend': addLine(pts[0], pts[1]); break;
    case 'ray': addLine(pts[0], pts[1], 'ray'); break;
    case 'extended': addLine(pts[0], pts[1], 'extended'); break;
    case 'info': case 'trendAngle': case 'arrow': addLine(pts[0], pts[1]); break;
    case 'hline': pushSeg(out, { x: rect.left, y: pts[0].y }, { x: rect.right, y: pts[0].y }); break;
    case 'hray': pushSeg(out, { x: pts[0].x, y: pts[0].y }, { x: rect.right, y: pts[0].y }); break;
    case 'vline': pushSeg(out, { x: pts[0].x, y: rect.top }, { x: pts[0].x, y: rect.bottom }); break;
    case 'crossLine':
      pushSeg(out, { x: rect.left, y: pts[0].y }, { x: rect.right, y: pts[0].y });
      pushSeg(out, { x: pts[0].x, y: rect.top }, { x: pts[0].x, y: rect.bottom });
      break;
    case 'parallelChannel': case 'disjointChannel': {
      const [a, b, c] = pts;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = { x: c.x + dx, y: c.y + dy };
      pushPoly(out, [a, b, d, c], false, true, s.fillOpacity ?? 0.07);
      break;
    }
    case 'flatTopBottom': {
      const [a, b, c] = pts;
      const left = Math.min(b.x, c.x, a.x);
      const right = Math.max(b.x, c.x, a.x);
      pushPoly(out, [{ x: left, y: a.y }, { x: right, y: a.y }, c, b], false, true, s.fillOpacity ?? 0.07);
      break;
    }
    case 'regression': {
      const t1 = Math.min(s.points[0].t, s.points[1].t);
      const t2 = Math.max(s.points[0].t, s.points[1].t);
      const sample = bars.filter((bar) => bar.t >= t1 && bar.t <= t2);
      if (sample.length >= 2) {
        const xs = sample.map((bar) => project.x(bar.t));
        const ys = sample.map((bar) => project.y(bar.c));
        const n = xs.length;
        const sx = xs.reduce((v, x) => v + x, 0);
        const sy = ys.reduce((v, y) => v + y, 0);
        const sxx = xs.reduce((v, x) => v + x * x, 0);
        const sxy = xs.reduce((v, x, i) => v + x * ys[i], 0);
        const den = n * sxx - sx * sx;
        const slope = den ? (n * sxy - sx * sy) / den : 0;
        const intercept = (sy - slope * sx) / n;
        const resid = ys.map((y, i) => y - (slope * xs[i] + intercept));
        const sd = Math.sqrt(resid.reduce((v, r) => v + r * r, 0) / Math.max(1, n));
        const x1 = Math.min(...xs);
        const x2 = Math.max(...xs);
        for (const k of [-2, -1, 0, 1, 2]) {
          pushSeg(out, { x: x1, y: slope * x1 + intercept + k * sd }, { x: x2, y: slope * x2 + intercept + k * sd });
        }
      } else addLine(pts[0], pts[1]);
      break;
    }
    case 'fibRetracement': {
      const p1 = s.points[0].p;
      const p2 = s.points[1].p;
      const x1 = Math.min(pts[0].x, pts[1].x);
      for (const level of FIB_LEVELS) {
        const y = project.y(p1 + (p2 - p1) * level);
        pushSeg(out, { x: x1, y }, { x: rect.right, y });
      }
      break;
    }
    case 'fibExtension': {
      const dir = s.points[1].p - s.points[0].p;
      const base = s.points[2].p;
      const x1 = Math.min(pts[1].x, pts[2].x);
      for (const level of FIB_EXT_LEVELS) {
        const y = project.y(base + dir * level);
        pushSeg(out, { x: x1, y }, { x: rect.right, y });
      }
      break;
    }
    case 'fibChannel': {
      const [a, b, c] = pts;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const dist = (c.x - a.x) * nx + (c.y - a.y) * ny;
      for (const level of FIB_LEVELS) {
        addLine({ x: a.x + nx * dist * level, y: a.y + ny * dist * level }, { x: b.x + nx * dist * level, y: b.y + ny * dist * level }, 'ray');
      }
      break;
    }
    case 'fibTime': case 'fibTimeZone': {
      const t1 = s.points[0].t;
      const dt = s.points[1].t - t1;
      const steps = s.type === 'fibTimeZone' ? [1, 2, 3, 5, 8, 13, 21] : FIB_LEVELS;
      for (const n of steps) {
        const x = project.x(t1 + dt * n);
        pushSeg(out, { x, y: rect.top }, { x, y: rect.bottom });
      }
      break;
    }
    case 'fibSpeedFan': {
      const [a, b] = pts;
      for (const level of FIB_LEVELS) addLine(a, { x: b.x, y: a.y + (b.y - a.y) * level }, 'ray');
      break;
    }
    case 'fibCircles': case 'fibArcs': {
      const [a, b] = pts;
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      for (const ratio of [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618]) pushCircle(out, a, r * ratio);
      break;
    }
    case 'fibSpiral': {
      const [a, b] = pts;
      const total = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const start = angleOf(a, b);
      let prev = null;
      for (let i = 0; i <= 120; i += 1) {
        const t = i / 120;
        const p = polar(a, total * Math.pow(t, 1.15), start + t * Math.PI * 5);
        if (prev) pushSeg(out, prev, p);
        prev = p;
      }
      break;
    }
    case 'fibWedge': {
      const [a, b, c] = pts;
      const a1 = angleOf(a, b);
      const a2 = angleOf(a, c);
      const radius = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y)) * 1.6;
      for (const level of FIB_LEVELS) addLine(a, polar(a, radius, lerp(a1, a2, level)), 'ray');
      pushPoly(out, [a, b, c], true, true, s.fillOpacity ?? 0.04);
      break;
    }
    case 'pitchfork': case 'pitchforkSchiff': case 'pitchforkModifiedSchiff': case 'pitchforkInside': {
      const [a, b, c] = pts;
      const baseMid = mid(b, c);
      let origin = a;
      if (s.type === 'pitchforkSchiff') origin = mid(a, b);
      else if (s.type === 'pitchforkModifiedSchiff') origin = mid(a, mid(a, b));
      else if (s.type === 'pitchforkInside') origin = mid(a, baseMid);
      const dx = baseMid.x - origin.x;
      const dy = baseMid.y - origin.y;
      addLine(origin, { x: origin.x + dx * 4, y: origin.y + dy * 4 }, 'extended');
      addLine(b, { x: b.x + dx * 4, y: b.y + dy * 4 }, 'extended');
      addLine(c, { x: c.x + dx * 4, y: c.y + dy * 4 }, 'extended');
      break;
    }
    case 'gannBox': case 'gannSquareFixed': case 'gannSquare': {
      let [a, b] = pts;
      if (s.type !== 'gannBox') {
        const w = b.x - a.x;
        const h = b.y - a.y;
        const size = Math.max(Math.abs(w), Math.abs(h));
        b = { x: a.x + Math.sign(w || 1) * size, y: a.y + Math.sign(h || 1) * size };
      }
      const r = rectOf(a, b);
      pushRect(out, r, true);
      for (let i = 1; i < 8; i += 1) {
        const f = i / 8;
        pushSeg(out, { x: r.left, y: lerp(r.top, r.bottom, f) }, { x: r.right, y: lerp(r.top, r.bottom, f) });
        pushSeg(out, { x: lerp(r.left, r.right, f), y: r.top }, { x: lerp(r.left, r.right, f), y: r.bottom });
      }
      break;
    }
    case 'gannFan': {
      const [a, b] = pts;
      for (const r of [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8]) {
        addLine(a, { x: b.x, y: a.y + (b.y - a.y) * r }, 'ray');
      }
      break;
    }
    case 'xabcd': case 'cypher': case 'abcd': case 'threeDrives': case 'headShoulders':
    case 'elliottImpulse': case 'elliottTriangle': case 'elliottCorrection':
    case 'elliottDoubleCombo': case 'elliottTripleCombo': case 'polyline': case 'path':
      pushPoly(out, pts, s.type === 'elliottTriangle', false);
      if (s.type === 'headShoulders') pushSeg(out, pts[1], pts[3]);
      break;
    case 'trianglePattern':
      pushPoly(out, pts, true, true, s.fillOpacity ?? 0.08);
      break;
    case 'cyclicLines': {
      const t1 = s.points[0].t;
      const dt = s.points[1].t - t1;
      if (dt) {
        for (let n = 1; n < 200; n += 1) {
          const x = project.x(t1 + dt * n);
          if (x > rect.right + 2) break;
          if (x >= rect.left - 2) pushSeg(out, { x, y: rect.top }, { x, y: rect.bottom });
        }
      }
      break;
    }
    case 'timeCycles': {
      const [a, b] = pts;
      const base = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (let n = 1; n <= 6; n += 1) pushCircle(out, a, base * n);
      break;
    }
    case 'sineLine': {
      const [a, b] = pts;
      const amp = Math.abs(b.y - a.y) / 2;
      const midY = (a.y + b.y) / 2;
      let prev = null;
      for (let i = 0; i <= 60; i += 1) {
        const t = i / 60;
        const p = { x: lerp(a.x, b.x, t), y: midY + Math.sin(t * Math.PI * 4) * amp };
        if (prev) pushSeg(out, prev, p);
        prev = p;
      }
      break;
    }
    case 'longPosition': case 'shortPosition': case 'positionForecast': {
      const [entry, target, stop] = pts;
      const x1 = entry.x;
      const x2 = Math.max(target.x, stop.x, entry.x + 40);
      pushRect(out, { left: x1, top: Math.min(entry.y, target.y), right: x2, bottom: Math.max(entry.y, target.y), x: x1, y: Math.min(entry.y, target.y), w: x2 - x1, h: Math.abs(entry.y - target.y) }, true);
      pushRect(out, { left: x1, top: Math.min(entry.y, stop.y), right: x2, bottom: Math.max(entry.y, stop.y), x: x1, y: Math.min(entry.y, stop.y), w: x2 - x1, h: Math.abs(entry.y - stop.y) }, true);
      break;
    }
    case 'dateRange': case 'datePriceRange': {
      const x1 = Math.min(pts[0].x, pts[1].x);
      const x2 = Math.max(pts[0].x, pts[1].x);
      pushRect(out, { left: x1, right: x2, top: rect.top, bottom: rect.bottom, x: x1, y: rect.top, w: x2 - x1, h: rect.bottom - rect.top }, true);
      break;
    }
    case 'priceRange': {
      const y1 = Math.min(pts[0].y, pts[1].y);
      const y2 = Math.max(pts[0].y, pts[1].y);
      pushRect(out, { left: rect.left, right: rect.right, top: y1, bottom: y2, x: rect.left, y: y1, w: rect.right - rect.left, h: y2 - y1 }, true);
      break;
    }
    case 'barsPattern': case 'ghostFeed': {
      const [a, b] = pts;
      pushRect(out, { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y) - 40, bottom: Math.max(a.y, b.y) + 40, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) - 40, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) + 80 }, true);
      break;
    }
    case 'sector': {
      const [a, b, c] = pts;
      const radius = Math.hypot(b.x - a.x, b.y - a.y);
      const a1 = angleOf(a, b);
      const a2 = angleOf(a, c);
      const arc = [];
      for (let i = 0; i <= 24; i += 1) arc.push(polar(a, radius, lerp(a1, a2, i / 24)));
      pushPoly(out, [a, ...arc], true, true, s.fillOpacity ?? 0.08);
      break;
    }
    case 'fixedRangeVolumeProfile': case 'anchoredVolumeProfile': {
      const [a, b] = pts;
      const x1 = Math.min(a.x, b.x);
      const x2 = Math.max(a.x, b.x);
      const width = Math.max(40, Math.min(180, Math.abs(b.x - a.x) || 120));
      pushRect(out, { left: x2 - width, right: x2, top: rect.top, bottom: rect.bottom, x: x2 - width, y: rect.top, w: width, h: rect.bottom - rect.top }, true);
      pushSeg(out, { x: x1, y: a.y }, { x: x2, y: b.y });
      break;
    }
    case 'anchoredVWAP': {
      const points = vwapPoints(project, s.points[0].t, opts);
      if (points.length > 1) pushPoly(out, points, false, false);
      else pushSeg(out, { x: rect.left, y: pts[0].y }, { x: rect.right, y: pts[0].y });
      break;
    }
    case 'rectangle': {
      const r = rectOf(pts[0], pts[1]);
      pushRect(out, r, true);
      break;
    }
    case 'rotatedRectangle': {
      const [a, b, c] = pts;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const off = (c.x - a.x) * nx + (c.y - a.y) * ny;
      pushPoly(out, [a, b, { x: b.x + nx * off, y: b.y + ny * off }, { x: a.x + nx * off, y: a.y + ny * off }], true, true, s.fillOpacity ?? 0.08);
      break;
    }
    case 'circle': {
      const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      pushCircle(out, pts[0], r, true);
      break;
    }
    case 'ellipse': {
      const [a, b] = pts;
      const r = rectOf(a, b);
      pushRect(out, r, true);
      break;
    }
    case 'triangleShape':
      pushPoly(out, pts, true, true, s.fillOpacity ?? 0.08);
      break;
    case 'arc': {
      const circle = circleFrom3(pts[0], pts[1], pts[2]);
      if (circle) pushCircle(out, circle, circle.r);
      else pushSeg(out, pts[0], pts[2]);
      break;
    }
    case 'curve': {
      let prev = pts[0];
      for (let i = 1; i <= 20; i += 1) {
        const t = i / 20;
        const p = {
          x: (1 - t) * (1 - t) * pts[0].x + 2 * (1 - t) * t * pts[1].x + t * t * pts[2].x,
          y: (1 - t) * (1 - t) * pts[0].y + 2 * (1 - t) * t * pts[1].y + t * t * pts[2].y,
        };
        pushSeg(out, prev, p);
        prev = p;
      }
      break;
    }
    case 'doubleCurve': {
      let prev = pts[0];
      for (let i = 1; i <= 20; i += 1) {
        const t = i / 20;
        const mt = 1 - t;
        const p = {
          x: mt * mt * mt * pts[0].x + 3 * mt * mt * t * pts[1].x + 3 * mt * t * t * pts[2].x + t * t * t * pts[3].x,
          y: mt * mt * mt * pts[0].y + 3 * mt * mt * t * pts[1].y + 3 * mt * t * t * pts[2].y + t * t * t * pts[3].y,
        };
        pushSeg(out, prev, p);
        prev = p;
      }
      break;
    }
    case 'brush': case 'highlighter': {
      if (pts.length > 1) pushPoly(out, pts, false, false);
      else pushCircle(out, pts[0], 4);
      break;
    }
    case 'measure': case 'zoom': {
      const x1 = Math.min(pts[0].x, pts[1].x);
      const x2 = Math.max(pts[0].x, pts[1].x);
      const y1 = Math.min(pts[0].y, pts[1].y);
      const y2 = Math.max(pts[0].y, pts[1].y);
      pushRect(out, { left: x1, right: x2, top: y1, bottom: y2, x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, true);
      break;
    }
    case 'text': case 'note': case 'anchoredNote': case 'signpost': case 'callout': case 'comment':
    case 'priceNote': case 'sticker': case 'priceLabel': case 'arrowMarker': case 'arrowMarkLeft':
    case 'arrowMarkRight': case 'arrowMarkUp': case 'arrowMarkDown': case 'flagMark': {
      const size = s.fontSize || 14;
      const w = Math.max(40, (String(s.text || s.emoji || s.type).length * size * 0.62) + 18);
      const h = Math.max(24, size * 1.7);
      pushRect(out, { left: pts[0].x - 4, right: pts[0].x + w, top: pts[0].y - h, bottom: pts[0].y + 6, x: pts[0].x - 4, y: pts[0].y - h, w: w + 4, h: h + 6 }, true);
      break;
    }
    default:
      if (pts.length > 1) pushPoly(out, pts, false, false);
      else pushCircle(out, pts[0], 5, true);
  }
  return out;
}

export function hitShape(s, x, y, project, opts = {}) {
  if (!s || s.hidden) return false;
  const threshold = opts.threshold ?? 7;
  const out = shapeOutline(s, project, opts);
  for (const seg of out.segs) {
    if (distToSegment(x, y, seg.a.x, seg.a.y, seg.b.x, seg.b.y) <= threshold) return true;
  }
  for (const poly of out.polys) {
    if (distToPolyline(x, y, poly.pts, poly.closed) <= threshold) return true;
    if (poly.filled && out.polys.length && pointInPoly(x, y, poly.pts)) return true;
  }
  for (const r of out.rects) {
    const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    const near =
      (Math.abs(x - r.left) <= threshold && y >= r.top - threshold && y <= r.bottom + threshold) ||
      (Math.abs(x - r.right) <= threshold && y >= r.top - threshold && y <= r.bottom + threshold) ||
      (Math.abs(y - r.top) <= threshold && x >= r.left - threshold && x <= r.right + threshold) ||
      (Math.abs(y - r.bottom) <= threshold && x >= r.left - threshold && x <= r.right + threshold);
    if (near || (r.filled && inside)) return true;
  }
  for (const c of out.circles) {
    const d = Math.hypot(x - c.x, y - c.y);
    if (Math.abs(d - c.r) <= threshold || (c.filled && d <= c.r)) return true;
  }
  // Anchors are always grabbable: several tools (fib extensions, Gann, time
  // cycles) draw geometry away from the point that created them.
  for (const p of projectPoints(s, project)) {
    if (Math.hypot(x - p.x, y - p.y) <= threshold + 2) return true;
  }
  return false;
}

export function shapeHandles(s, project) {
  if (!s || !s.points) return [];
  return s.points.map((p, index) => ({
    x: project.x(p.t),
    y: project.y(p.p),
    index,
  }));
}
