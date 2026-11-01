/**
 * Drawing tools. Shapes are stored in DATA coordinates (timestamp x price),
 * so they survive zoom, pan and timeframe changes.
 */

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

let seq = 0;
const uid = () => `s${Date.now().toString(36)}${(seq += 1).toString(36)}`;

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export class DrawingLayer {
  constructor() {
    /** @type {Array<object>} */
    this.shapes = [];
    this.symbol = null;
    this.selectedId = null;
    this.preview = null;
  }

  get storageKey() {
    return `tvfree.drawings.v1:${this.symbol || ''}`;
  }

  load(symbol) {
    this.symbol = symbol;
    this.selectedId = null;
    try {
      const raw = localStorage.getItem(this.storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      this.shapes = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.shapes = [];
    }
  }

  persist() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.shapes));
    } catch {
      /* quota / private mode */
    }
  }

  add(shape) {
    const s = { id: uid(), ...shape };
    this.shapes.push(s);
    this.selectedId = s.id;
    this.persist();
    return s;
  }

  remove(id) {
    const i = this.shapes.findIndex((s) => s.id === id);
    if (i >= 0) {
      this.shapes.splice(i, 1);
      if (this.selectedId === id) this.selectedId = null;
      this.persist();
    }
  }

  clear() {
    this.shapes = [];
    this.selectedId = null;
    this.persist();
  }

  undo() {
    if (!this.shapes.length) return false;
    this.shapes.pop();
    this.selectedId = null;
    this.persist();
    return true;
  }

  /** Move a shape by a screen delta, converted through the projection. */
  move(id, dPrice, dTime, project, persist = false) {
    const s = this.shapes.find((x) => x.id === id);
    if (!s) return;
    if (s.type === 'hline') {
      s.p1 += dPrice;
    } else {
      s.p1 += dPrice;
      s.p2 += dPrice;
      s.t1 = project.shiftTime(s.t1, dTime);
      s.t2 = project.shiftTime(s.t2, dTime);
    }
    if (persist) this.persist();
  }

  /** @returns {string|null} id of the shape under the cursor */
  hitTest(px, py, project) {
    const threshold = 7;
    for (let i = this.shapes.length - 1; i >= 0; i -= 1) {
      const s = this.shapes[i];
      const x1 = project.x(s.t1);
      const y1 = project.y(s.p1);

      if (s.type === 'hline') {
        if (Math.abs(py - y1) <= threshold) return s.id;
        continue;
      }

      const x2 = project.x(s.t2);
      const y2 = project.y(s.p2);

      if (s.type === 'trend') {
        if (distToSegment(px, py, x1, y1, x2, y2) <= threshold) return s.id;
      } else if (s.type === 'rect') {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);
        const inside = px >= left && px <= right && py >= top && py <= bottom;
        const nearEdge =
          (Math.abs(px - left) <= threshold || Math.abs(px - right) <= threshold) && py >= top && py <= bottom;
        const nearTopBottom =
          (Math.abs(py - top) <= threshold || Math.abs(py - bottom) <= threshold) && px >= left && px <= right;
        if (inside || nearEdge || nearTopBottom) return s.id;
      } else if (s.type === 'fib') {
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);
        if (px >= Math.min(x1, x2) - threshold && py >= top - threshold && py <= bottom + threshold) {
          return s.id;
        }
      }
    }
    return null;
  }

  draw(ctx, project, opts = {}) {
    const { width } = project;
    for (const s of this.shapes) {
      const selected = s.id === this.selectedId;
      this.drawShape(ctx, s, project, width, selected, opts);
    }
    if (this.preview) {
      this.drawShape(ctx, this.preview, project, width, false, opts);
    }
  }

  drawShape(ctx, s, project, width, selected, opts) {
    const x1 = project.x(s.t1);
    const y1 = project.y(s.p1);
    const color = s.color || '#2962ff';

    ctx.save();
    ctx.lineWidth = selected ? 2 : 1.25;
    ctx.strokeStyle = color;

    if (s.type === 'hline') {
      ctx.beginPath();
      ctx.moveTo(0, y1);
      ctx.lineTo(width, y1);
      ctx.stroke();
      this.tag(ctx, width, y1, opts.fmtPrice ? opts.fmtPrice(s.p1) : String(s.p1), color);
    } else if (s.type === 'trend') {
      const x2 = project.x(s.t2);
      const y2 = project.y(s.p2);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      this.handle(ctx, x1, y1, color, selected);
      this.handle(ctx, x2, y2, color, selected);
    } else if (s.type === 'rect') {
      const x2 = project.x(s.t2);
      const y2 = project.y(s.p2);
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      ctx.fillStyle = hexA(color, 0.09);
      ctx.fillRect(left, top, w, h);
      ctx.strokeRect(left, top, w, h);
      this.handle(ctx, x1, y1, color, selected);
      this.handle(ctx, x2, y2, color, selected);
    } else if (s.type === 'fib') {
      const x2 = project.x(s.t2);
      const y2 = project.y(s.p2);
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2, width);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      const span = bottom - top || 1;

      for (const level of FIB_LEVELS) {
        const y = bottom - span * level;
        ctx.globalAlpha = level === 0 || level === 1 ? 0.95 : 0.7;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.font = '10px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(`${(level * 100).toFixed(1)}%  ${fmtPriceSmart(s.p1 + (s.p2 - s.p1) * level)}`, left + 4, y - 3);
      }
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = color;
      ctx.fillRect(left, top, right - left, bottom - top);
      ctx.globalAlpha = 1;
      this.handle(ctx, x1, y1, color, selected);
      this.handle(ctx, x2, y2, color, selected);
    }
    ctx.restore();
  }

  handle(ctx, x, y, color, selected) {
    if (!selected) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#131722';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }

  tag(ctx, x, y, text, color) {
    ctx.save();
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x - w - 4, y - 7, w, 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x - w + 1, y + 3.5);
    ctx.restore();
  }
}

function hexA(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function fmtPriceSmart(p) {
  if (!Number.isFinite(p)) return '';
  const abs = Math.abs(p);
  if (abs >= 1000) return p.toFixed(2);
  if (abs >= 1) return p.toFixed(2);
  return p.toFixed(4);
}
