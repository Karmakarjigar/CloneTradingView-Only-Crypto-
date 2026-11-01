/**
 * Canvas chart engine: candles, volume, indicator panes, axes, crosshair,
 * pan/zoom and a drawing layer hook. No external dependencies.
 */

const COLORS = {
  bg: '#131722',
  grid: '#1c202b',
  gridStrong: '#252a36',
  axis: '#2a2e39',
  text: '#787b86',
  textStrong: '#b2b5be',
  up: '#26a69a',
  down: '#ef5350',
  crosshair: '#9598a1',
  accent: '#2962ff',
  lastUp: '#26a69a',
  lastDown: '#ef5350',
};

const AXIS_W = 66;
const TIME_H = 24;
const VOL_H = 54;
const SUB_H = 88;

function niceStep(range, target) {
  if (!(range > 0)) return 1;
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function fmtCompact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const dayFmtCache = new Map();
function dayFormatter(tz) {
  let f = dayFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFmtCache.set(tz, f);
  }
  return f;
}

export class Chart {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.handlers = handlers;

    this.bars = [];
    this.meta = { symbol: '', name: '', exchange: '', currency: '', timezone: 'UTC' };
    this.interval = '1D';
    this.overlays = [];
    this.panes = [];
    this.drawings = null;
    this.tradeLevels = [];
    this.tradeMarks = [];

    this.view = { from: 0, to: 1 };
    this.padRight = 6;

    this.W = 0;
    this.H = 0;
    this.plotL = 0;
    this.plotR = 0;
    this.plotW = 0;

    this.hover = { active: false, x: 0, y: 0, index: -1, paneId: null };
    this.pointerMode = 'pan';
    this.replayLimit = null;
    this.externalCrosshair = null;
    this._pan = null;
    this._raf = 0;
    this._projection = null;

    this._bind();
    this.resize();
  }

  /* ---------------- data ---------------- */

  setData(payload) {
    this.bars = payload.bars || [];
    this.meta = {
      symbol: payload.symbol || '',
      name: payload.name || payload.symbol || '',
      exchange: payload.exchange || '',
      currency: payload.currency || '',
      timezone: payload.timezone || 'UTC',
      source: payload.source || '',
    };
    this.interval = payload.interval || this.interval;
    this.fit();
  }

  /** Called on live refresh: keep the window anchored to the right edge. */
  updateData(payload) {
    const prevLen = this.bars.length;
    const span = this.view.to - this.view.from;
    this.bars = payload.bars || [];
    this.meta = { ...this.meta, ...payload, timezone: payload.timezone || this.meta.timezone };
    const grew = this.bars.length - prevLen;
    if (grew > 0 && this.view.to >= prevLen - 1) {
      this.view.to += grew;
      this.view.from = this.view.to - span;
    }
    this.requestRender();
  }

  setOverlays(list) {
    this.overlays = list || [];
    this.requestRender();
  }

  setPanes(list) {
    this.panes = list || [];
    this.requestRender();
  }

  setDrawings(layer) {
    this.drawings = layer;
    this.requestRender();
  }

  /** Horizontal levels for paper positions / working orders. */
  setTradeLevels(levels) {
    this.tradeLevels = levels || [];
    this.requestRender();
  }

  /** Fill markers: { t, price, side }. */
  setTradeMarks(marks) {
    this.tradeMarks = marks || [];
    this.requestRender();
  }

  fit() {
    const n = this.count;
    const visible = Math.min(n, 180) || 1;
    this.view.from = Math.max(0, n - visible);
    this.view.to = n + this.padRight;
    this.requestRender();
  }

  /** Number of bars currently permitted to render (replay trims the tail). */
  get count() {
    const n = this.bars.length;
    if (this.replayLimit == null) return n;
    return Math.max(1, Math.min(this.replayLimit, n));
  }

  setReplayLimit(limit) {
    this.replayLimit = limit;
    if (limit != null) {
      const span = Math.max(20, this.view.to - this.view.from);
      this.view.to = limit + this.padRight;
      this.view.from = this.view.to - span;
    }
    this.clampView();
    this.requestRender();
    this.emitView();
  }

  setExternalCrosshair(time) {
    this.externalCrosshair = time;
    this.requestRender();
  }

  visibleTimes() {
    return {
      from: this.timeForIndex(this.view.from),
      to: this.timeForIndex(this.view.to),
    };
  }

  setViewByTime(t1, t2) {
    const from = this.indexForTime(t1);
    const to = this.indexForTime(t2);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    this.view.from = from;
    this.view.to = to;
    this.clampView();
    this.requestRender();
  }

  /** Scroll so `t` sits at the left edge, keeping the current zoom span. */
  setViewStartTime(t) {
    const from = this.indexForTime(t);
    if (!Number.isFinite(from)) return;
    const span = this.view.to - this.view.from;
    this.view.from = from;
    this.view.to = from + span;
    this.clampView();
    this.requestRender();
  }

  /* ---------------- geometry ---------------- */

  get candleW() {
    const span = this.view.to - this.view.from || 1;
    return this.plotW / span;
  }

  xForIndex(i) {
    return this.plotL + (i - this.view.from) * this.candleW;
  }

  indexAtX(x) {
    return this.view.from + (x - this.plotL) / (this.candleW || 1);
  }

  indexForTime(t) {
    const bars = this.bars;
    if (!bars.length) return 0;
    if (t <= bars[0].t) return 0;
    const last = bars.length - 1;
    if (t >= bars[last].t) {
      const gap = last > 0 ? bars[last].t - bars[last - 1].t : 1;
      return last + (t - bars[last].t) / (gap || 1);
    }
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const gap = bars[hi].t - bars[lo].t || 1;
    return lo + (t - bars[lo].t) / gap;
  }

  timeForIndex(f) {
    const bars = this.bars;
    if (!bars.length) return Date.now();
    const i = clamp(Math.floor(f), 0, bars.length - 1);
    const frac = f - i;
    if (i >= bars.length - 1) {
      const gap = i > 0 ? bars[i].t - bars[i - 1].t : 60000;
      return bars[i].t + frac * gap;
    }
    return bars[i].t + frac * (bars[i + 1].t - bars[i].t);
  }

  fmtPrice(p) {
    if (!Number.isFinite(p)) return '—';
    const abs = Math.abs(p);
    const digits = abs >= 10 ? 2 : abs >= 0.01 ? 4 : 6;
    return p.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  fmtTimeLabel(ts, isDayStart) {
    const tz = this.meta.timezone || 'UTC';
    try {
      if (this.interval === '1D' || this.interval === '1W') {
        return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short' }).format(ts);
      }
      if (isDayStart) {
        return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short' }).format(ts);
      }
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(ts);
    } catch {
      return '';
    }
  }

  /* ---------------- layout ---------------- */

  computeLayout() {
    const W = this.W;
    const H = this.H;
    const subCount = this.panes.length;
    const volH = Math.max(36, Math.min(VOL_H, H * 0.14));
    const subH = subCount ? Math.max(56, Math.min(SUB_H, (H - TIME_H - volH) / (subCount + 2))) : 0;

    this.plotL = 0;
    this.plotR = W - AXIS_W;
    this.plotW = Math.max(10, this.plotR - this.plotL);

    const bottom = H - TIME_H;
    const mainH = Math.max(80, bottom - volH - subH * subCount);

    const list = [];
    let y = 0;
    list.push({ id: 'main', kind: 'price', top: y, height: mainH });
    y += mainH;
    list.push({ id: 'volume', kind: 'volume', top: y, height: volH });
    y += volH;
    for (const p of this.panes) {
      list.push({ ...p, kind: 'indicator', top: y, height: subH });
      y += subH;
    }
    return { list, bottom, subH };
  }

  paneAtY(y) {
    const { list } = this.computeLayout();
    for (const p of list) {
      if (y >= p.top && y <= p.top + p.height) return p;
    }
    return list[0];
  }

  visibleRange() {
    const n = this.count;
    const from = Math.max(0, Math.floor(this.view.from));
    const to = Math.min(n - 1, Math.ceil(this.view.to));
    return { from, to: Math.max(from, to) };
  }

  /* ---------------- render ---------------- */

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, Math.round(rect.width));
    this.H = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  render() {
    const ctx = this.ctx;
    const { W, H } = this;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    if (!this.bars.length) {
      this.drawEmpty(ctx);
      return;
    }

    const layout = this.computeLayout();
    const { from, to } = this.visibleRange();
    if (to < from) return;

    const mainPane = layout.list[0];
    const scales = this.computeScales(from, to, layout.list, mainPane);

    this.drawGrid(ctx, layout, mainPane, scales);
    this.drawVolume(ctx, layout.list[1], from, to);
    this.drawCandles(ctx, mainPane, scales, from, to);
    this.drawOverlays(ctx, mainPane, scales, from, to);
    this.drawIndicatorPanes(ctx, layout.list, from, to);
    this.drawTradeAnnotations(ctx, mainPane, scales);
    this.drawLastPrice(ctx, mainPane, scales);
    this.drawTimeAxis(ctx, layout.bottom, from, to);
    this.drawWatermark(ctx, mainPane);

    if (this.drawings) {
      this.drawings.draw(ctx, this.projection(mainPane), { fmtPrice: (p) => this.fmtPrice(p) });
    }

    if (this.externalCrosshair != null) this.drawExternalCrosshair(ctx, layout);

    if (this.hover.active) this.drawCrosshair(ctx, layout, scales, mainPane);
  }

  drawEmpty(ctx) {
    ctx.fillStyle = COLORS.text;
    ctx.font = '13px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', this.W / 2, this.H / 2);
    ctx.textAlign = 'left';
  }

  computeScales(from, to, list, mainPane) {
    let min = Infinity;
    let max = -Infinity;

    for (let i = from; i <= to; i += 1) {
      const b = this.bars[i];
      if (!b) continue;
      if (b.l < min) min = b.l;
      if (b.h > max) max = b.h;
    }

    for (const ov of this.overlays) {
      const vals = ov.values || [];
      for (let i = from; i <= to; i += 1) {
        const v = vals[i];
        if (v == null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;

    const main = { min, max };
    this.mainScale = main;
    const map = { main };

    let volMax = 0;
    for (let i = from; i <= to; i += 1) volMax = Math.max(volMax, this.bars[i]?.v || 0);
    map.volume = { min: 0, max: volMax || 1 };

    for (const pane of list) {
      if (pane.kind !== 'indicator') continue;
      if (pane.fixed) {
        map[pane.id] = { min: pane.fixed[0], max: pane.fixed[1] };
        continue;
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of pane.series || []) {
        for (let i = from; i <= to; i += 1) {
          const v = s.values?.[i];
          if (v == null) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        lo = -1;
        hi = 1;
      }
      if (lo > 0) lo = 0;
      if (hi < 0) hi = 0;
      if (lo === hi) {
        lo -= 1;
        hi += 1;
      }
      const p = (hi - lo) * 0.12;
      map[pane.id] = { min: lo - p, max: hi + p };
    }

    return map;
  }

  yForPrice(p, pane, scale) {
    const s = scale || { min: 0, max: 1 };
    const h = pane.height || 1;
    const t = (p - s.min) / (s.max - s.min || 1);
    return pane.top + h - t * h;
  }

  priceForY(y, pane, scale) {
    const h = pane.height || 1;
    const t = (pane.top + h - y) / h;
    return scale.min + t * (scale.max - scale.min);
  }

  projection(mainPane, scale) {
    const sc = scale || this.mainScale || this._lastMainScale || { min: 0, max: 1 };
    const cache = {
      x: (t) => this.xForIndex(this.indexForTime(t)),
      y: (p) => this.yForPrice(p, mainPane, sc),
      width: this.plotR,
      shiftTime: (t, di) => this.timeForIndex(this.indexForTime(t) + di),
    };
    this._projection = cache;
    return cache;
  }

  /** Projection using the current main price scale (for drawings / previews). */
  projector() {
    const mainPane = this.computeLayout().list[0];
    const sc = this.mainScale || { min: 0, max: 1 };
    return {
      x: (t) => this.xForIndex(this.indexForTime(t)),
      y: (p) => this.yForPrice(p, mainPane, sc),
      width: this.plotR,
      shiftTime: (t, di) => this.timeForIndex(this.indexForTime(t) + di),
    };
  }

  /** Screen point -> data coordinates, clamped to the price pane. */
  dataAt(x, y) {
    const mainPane = this.computeLayout().list[0];
    const sc = this.mainScale || { min: 0, max: 1 };
    const cy = clamp(y, mainPane.top, mainPane.top + mainPane.height);
    const idx = this.indexAtX(x);
    return {
      index: idx,
      time: this.timeForIndex(idx),
      price: this.priceForY(cy, mainPane, sc),
    };
  }

  drawGrid(ctx, layout, mainPane, scales) {
    const { from, to } = this.visibleRange();
    const sc = scales.main;

    ctx.save();
    ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // horizontal price grid
    const range = sc.max - sc.min;
    const step = niceStep(range, Math.max(3, Math.floor(mainPane.height / 46)));

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const start = Math.ceil(sc.min / step) * step;
    for (let p = start; p <= sc.max; p += step) {
      const y = Math.round(this.yForPrice(p, mainPane, sc)) + 0.5;
      if (y < mainPane.top + 1 || y > mainPane.top + mainPane.height - 1) continue;
      ctx.moveTo(this.plotL, y);
      ctx.lineTo(this.plotR, y);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(this.fmtPrice(p), this.plotR + 6, y);
    }
    ctx.stroke();

    // pane separators
    ctx.strokeStyle = COLORS.axis;
    for (const pane of layout.list.slice(1)) {
      ctx.beginPath();
      const y = Math.round(pane.top) + 0.5;
      ctx.moveTo(this.plotL, y);
      ctx.lineTo(this.plotR, y);
      ctx.stroke();
    }

    // vertical time grid
    const span = to - from + 1;
    const tickEvery = Math.max(1, Math.ceil(span / Math.max(3, Math.floor(this.plotW / 110))));
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    const ticks = [];
    for (let i = Math.ceil(from / tickEvery) * tickEvery; i <= to; i += tickEvery) {
      const x = Math.round(this.xForIndex(i)) + 0.5;
      if (x < this.plotL || x > this.plotR) continue;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, layout.bottom);
      ticks.push(i);
    }
    ctx.stroke();

    // axis frame
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(this.plotR + 0.5, 0);
    ctx.lineTo(this.plotR + 0.5, layout.bottom);
    ctx.lineTo(this.plotL, layout.bottom + 0.5);
    ctx.stroke();

    ctx.restore();
    return ticks;
  }

  drawCandles(ctx, pane, scales, from, to) {
    const sc = scales.main;
    const cw = this.candleW;
    const bodyW = Math.max(1, Math.min(cw * 0.72, 22));
    const thin = bodyW < 2.5;

    ctx.save();
    for (let i = from; i <= to; i += 1) {
      const b = this.bars[i];
      if (!b) continue;
      const x = this.xForIndex(i);
      if (x < this.plotL - cw || x > this.plotR + cw) continue;

      const up = b.c >= b.o;
      const color = up ? COLORS.up : COLORS.down;
      const yHigh = this.yForPrice(b.h, pane, sc);
      const yLow = this.yForPrice(b.l, pane, sc);
      const yOpen = this.yForPrice(b.o, pane, sc);
      const yClose = this.yForPrice(b.c, pane, sc);

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;

      if (thin) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, yHigh);
        ctx.lineTo(Math.round(x) + 0.5, yLow);
        ctx.stroke();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, yHigh);
      ctx.lineTo(Math.round(x) + 0.5, yLow);
      ctx.stroke();

      const top = Math.min(yOpen, yClose);
      const h = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    }
    ctx.restore();
  }

  drawVolume(ctx, pane, from, to) {
    if (!pane) return;
    // volume pane has its own scale derived from visible bars
    let volMax = 0;
    for (let i = from; i <= to; i += 1) volMax = Math.max(volMax, this.bars[i]?.v || 0);
    if (volMax <= 0) return;

    const cw = this.candleW;
    const bodyW = Math.max(1, Math.min(cw * 0.72, 22));

    ctx.save();
    ctx.globalAlpha = 0.55;
    for (let i = from; i <= to; i += 1) {
      const b = this.bars[i];
      if (!b) continue;
      const x = this.xForIndex(i);
      const h = (b.v / volMax) * (pane.height - 3);
      if (h <= 0.4) continue;
      ctx.fillStyle = b.c >= b.o ? COLORS.up : COLORS.down;
      ctx.fillRect(x - bodyW / 2, pane.top + pane.height - h, bodyW, h);
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = COLORS.text;
    ctx.font = '9.5px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Vol ${fmtCompact(volMax)}`, this.plotR + 6, pane.top + 9);
    ctx.restore();
  }

  drawOverlays(ctx, pane, scales, from, to) {
    const sc = scales.main;
    ctx.save();
    ctx.lineJoin = 'round';
    for (const ov of this.overlays) {
      const vals = ov.values || [];
      ctx.strokeStyle = ov.color;
      ctx.lineWidth = ov.width || 1.4;
      ctx.beginPath();
      let started = false;
      for (let i = from; i <= to; i += 1) {
        const v = vals[i];
        if (v == null) {
          started = false;
          continue;
        }
        const x = this.xForIndex(i);
        const y = this.yForPrice(v, pane, sc);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Paper-trading annotations: dashed entry/order levels and small fill
   * markers. Drawn inside a clip so levels outside the view cannot bleed into
   * the price axis or the volume pane.
   */
  drawTradeAnnotations(ctx, pane, scales) {
    const levels = this.tradeLevels || [];
    const marks = this.tradeMarks || [];
    if (!levels.length && !marks.length) return;

    const sc = scales.main;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.plotL, pane.top, this.plotW, pane.height);
    ctx.clip();

    ctx.font = '9.5px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    for (const lv of levels) {
      if (!Number.isFinite(lv.price)) continue;
      const y = Math.round(this.yForPrice(lv.price, pane, sc)) + 0.5;
      if (y < pane.top + 2 || y > pane.top + pane.height - 2) continue;

      ctx.strokeStyle = lv.color || '#787b86';
      ctx.lineWidth = 1;
      ctx.setLineDash(lv.dash || [4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.plotL, y);
      ctx.lineTo(this.plotR, y);
      ctx.stroke();
      ctx.setLineDash([]);

      const label = lv.label || '';
      if (label) {
        const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = lv.color || '#787b86';
        ctx.globalAlpha = 0.9;
        ctx.fillRect(this.plotL + 4, y - 15, w, 13);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0b0e14';
        ctx.fillText(label, this.plotL + 8, y - 8.5);
        ctx.fillStyle = lv.color || '#787b86';
      }
    }

    for (const m of marks) {
      if (!Number.isFinite(m.price) || !m.t) continue;
      const i = this.indexForTime(m.t);
      if (!Number.isFinite(i) || i < this.view.from - 1 || i > this.view.to + 1) continue;
      const x = this.xForIndex(i);
      if (x < this.plotL || x > this.plotR) continue;
      const y = this.yForPrice(m.price, pane, sc);
      if (y < pane.top + 6 || y > pane.top + pane.height - 6) continue;

      const up = m.side === 'buy';
      const color = up ? '#26a69a' : '#ef5350';
      const d = up ? 5 : -5;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y - d * 0.6);
      ctx.lineTo(x - 4, y + d * 1.4);
      ctx.lineTo(x + 4, y + d * 1.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    ctx.restore();
  }

  drawIndicatorPanes(ctx, list, from, to) {
    for (const pane of list) {
      if (pane.kind !== 'indicator') continue;

      // scale for this pane
      const sc = pane.fixed
        ? { min: pane.fixed[0], max: pane.fixed[1] }
        : (() => {
            let lo = Infinity;
            let hi = -Infinity;
            for (const s of pane.series || []) {
              for (let i = from; i <= to; i += 1) {
                const v = s.values?.[i];
                if (v == null) continue;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
              }
            }
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: -1, max: 1 };
            if (lo > 0) lo = 0;
            if (hi < 0) hi = 0;
            if (lo === hi) return { min: lo - 1, max: hi + 1 };
            const p = (hi - lo) * 0.12;
            return { min: lo - p, max: hi + p };
          })();

      ctx.save();

      // guides (RSI 30/70 etc.)
      if (pane.guides) {
        ctx.strokeStyle = COLORS.gridStrong;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        for (const g of pane.guides) {
          const y = Math.round(this.yForPrice(g, pane, sc)) + 0.5;
          ctx.moveTo(this.plotL, y);
          ctx.lineTo(this.plotR, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const zeroY = this.yForPrice(0, pane, sc);

      for (const s of pane.series || []) {
        if (s.type === 'hist') {
          const cw = this.candleW;
          const bw = Math.max(1, Math.min(cw * 0.7, 16));
          for (let i = from; i <= to; i += 1) {
            const v = s.values?.[i];
            if (v == null) continue;
            const x = this.xForIndex(i);
            const y = this.yForPrice(v, pane, sc);
            ctx.fillStyle = s.colorFn ? s.colorFn(v) : s.color || COLORS.accent;
            ctx.globalAlpha = 0.75;
            const top = Math.min(y, zeroY);
            const h = Math.max(1, Math.abs(y - zeroY));
            ctx.fillRect(x - bw / 2, top, bw, h);
          }
          ctx.globalAlpha = 1;
          continue;
        }

        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width || 1.3;
        ctx.beginPath();
        let started = false;
        for (let i = from; i <= to; i += 1) {
          const v = s.values?.[i];
          if (v == null) {
            started = false;
            continue;
          }
          const x = this.xForIndex(i);
          const y = this.yForPrice(v, pane, sc);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      // pane title
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      let tx = this.plotL + 6;
      for (const s of pane.series || []) {
        const v = s.values?.[to];
        const txt = s.label ? `${s.label}${v != null ? ` ${fmtCompact(v)}` : ''}` : '';
        if (!txt) continue;
        ctx.fillStyle = s.color || COLORS.text;
        ctx.fillText(txt, tx, pane.top + 10);
        tx += ctx.measureText(txt).width + 12;
      }

      // scale labels
      ctx.fillStyle = COLORS.text;
      const hiLabel = pane.fixed ? pane.fixed[1] : sc.max;
      const loLabel = pane.fixed ? pane.fixed[0] : sc.min;
      ctx.fillText(fmtCompact(hiLabel), this.plotR + 6, pane.top + 9);
      ctx.fillText(fmtCompact(loLabel), this.plotR + 6, pane.top + pane.height - 9);

      ctx.restore();
    }
  }

  drawLastPrice(ctx, pane, scales) {
    const bar = this.bars[this.count - 1];
    if (!bar) return;
    const sc = scales.main;
    if (bar.c < sc.min || bar.c > sc.max) return;

    const y = Math.round(this.yForPrice(bar.c, pane, sc)) + 0.5;
    const up = bar.c >= bar.o;
    const color = up ? COLORS.lastUp : COLORS.lastDown;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.65;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(this.plotL, y);
    ctx.lineTo(this.plotR, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const label = this.fmtPrice(bar.c);
    ctx.font = '600 10.5px "Segoe UI", system-ui, sans-serif';
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = color;
    ctx.fillRect(this.plotR + 1, y - 9, Math.max(w, AXIS_W - 4), 18);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, this.plotR + 6, y);
    ctx.restore();
  }

  drawTimeAxis(ctx, bottom, from, to) {
    const span = to - from + 1;
    const target = Math.max(3, Math.floor(this.plotW / 115));
    const every = Math.max(1, Math.ceil(span / target));

    ctx.save();
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const prevDay = new Map();
    const usedX = [];
    for (let i = Math.ceil(from / every) * every; i <= to; i += every) {
      const b = this.bars[i];
      if (!b) continue;
      const x = this.xForIndex(i);
      if (x < 20 || x > this.plotR - 20) continue;
      if (usedX.some((ux) => Math.abs(ux - x) < 62)) continue;
      usedX.push(x);

      let isDayStart = false;
      try {
        const tz = this.meta.timezone || 'UTC';
        const k = dayFormatter(tz).format(new Date(b.t));
        if (i > 0) {
          const prevKey = dayFormatter(tz).format(new Date(this.bars[i - 1].t));
          isDayStart = k !== prevKey;
        }
        prevDay.set(i, k);
      } catch {
        /* ignore */
      }

      ctx.fillText(this.fmtTimeLabel(b.t, isDayStart), x, bottom + TIME_H / 2 + 1);
    }
    ctx.textAlign = 'left';
    ctx.restore();
  }

  /** Vertical guide mirrored from a linked tab. */
  drawExternalCrosshair(ctx, layout) {
    const t = this.externalCrosshair;
    if (t == null || !this.bars.length) return;
    const x = Math.round(this.xForIndex(this.indexForTime(t))) + 0.5;
    if (x < this.plotL || x > this.plotR) return;

    ctx.save();
    ctx.strokeStyle = '#f0a029';
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, layout.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#f0a029';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - 4, 6);
    ctx.lineTo(x + 4, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawWatermark(ctx, pane) {    const text = this.meta.symbol || '';
    if (!text) return;
    ctx.save();
    ctx.globalAlpha = 0.045;
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.min(64, Math.max(28, this.plotW / 16))}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.plotL + this.plotW / 2, pane.top + pane.height / 2);
    ctx.restore();
  }

  drawCrosshair(ctx, layout, scales, mainPane) {
    const { x, y } = this.hover;
    if (x < this.plotL || x > this.plotR || y < 0 || y > layout.bottom) return;

    const idxF = this.indexAtX(x);
    const idx = clamp(Math.round(idxF), 0, this.bars.length - 1);
    const snappedX = Math.round(this.xForIndex(idx)) + 0.5;
    const pane = this.paneAtY(y);
    const sc = pane.kind === 'price' ? scales.main : pane.kind === 'volume' ? scales.volume : null;

    ctx.save();
    ctx.strokeStyle = COLORS.crosshair;
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(snappedX, 0);
    ctx.lineTo(snappedX, layout.bottom);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(this.plotL, Math.round(y) + 0.5);
    ctx.lineTo(this.plotR, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // time tag
    const bar = this.bars[idx];
    if (bar) {
      const label = this.interval === '1D' || this.interval === '1W'
        ? new Intl.DateTimeFormat('en-GB', { timeZone: this.meta.timezone || 'UTC', day: '2-digit', month: 'short', year: '2-digit' }).format(bar.t)
        : new Intl.DateTimeFormat('en-GB', {
            timeZone: this.meta.timezone || 'UTC',
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
          }).format(bar.t);
      ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = '#363a45';
      ctx.fillRect(clamp(snappedX - w / 2, 0, this.plotR - w), layout.bottom + 2, w, 19);
      ctx.fillStyle = '#e8eaf0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, clampedLabelX(snappedX, w, this.plotR), layout.bottom + 12);
      ctx.textAlign = 'left';
    }

    // price tag
    if (sc && pane.kind !== 'volume') {
      const price = this.priceForY(y, pane, sc);
      const label = this.fmtPrice(price);
      ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = '#363a45';
      ctx.fillRect(this.plotR + 1, y - 9, Math.max(w, AXIS_W - 4), 18);
      ctx.fillStyle = '#e8eaf0';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, this.plotR + 6, y);
    }

    ctx.restore();
  }

  /* ---------------- interaction ---------------- */

  _bind() {
    const c = this.canvas;

    c.addEventListener('wheel', (e) => {
      if (!this.bars.length) return;
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const anchor = this.indexAtX(x);
      const span = this.view.to - this.view.from;
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const nextSpan = clamp(span * factor, 12, Math.max(60, this.bars.length * 3));
      const ratio = (anchor - this.view.from) / (span || 1);
      this.view.from = anchor - ratio * nextSpan;
      this.view.to = this.view.from + nextSpan;
      this.clampView();
      this.requestRender();
      this.emitView();
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      if (this.pointerMode !== 'pan') return;
      if (e.button !== 0 && e.button !== 1) return;
      const rect = c.getBoundingClientRect();
      this._pan = {
        startX: e.clientX - rect.left,
        from: this.view.from,
        to: this.view.to,
      };
      c.classList.add('panning');
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this._pan) {
        const dx = x - this._pan.startX;
        const shift = -dx / (this.candleW || 1);
        this.view.from = this._pan.from + shift;
        this.view.to = this._pan.to + shift;
        this.clampView();
        this.requestRender();
        this.emitView();
      }

      this.hover.active = true;
      this.hover.x = x;
      this.hover.y = y;
      this.hover.index = Math.round(this.indexAtX(x));
      this.hover.paneId = this.paneAtY(y).id;
      this.requestRender();
      this.emitHover();
    });

    const end = (e) => {
      if (this._pan) {
        this._pan = null;
        c.classList.remove('panning');
        try { c.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('pointerleave', () => {
      this.hover.active = false;
      this.requestRender();
      this.emitHover();
    });

    c.addEventListener('dblclick', () => this.fit());

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(c.parentElement || c);
    } else {
      this._winResize = () => this.resize();
      window.addEventListener('resize', this._winResize);
    }
  }

  dispose() {
    if (this._ro) this._ro.disconnect();
    if (this._winResize) window.removeEventListener('resize', this._winResize);
    cancelAnimationFrame(this._raf);
  }

  emitHover() {
    if (this.handlers.onHover) {
      const idx = this.hover.index;
      const bar = this.hover.active && idx >= 0 && idx < this.bars.length ? this.bars[idx] : null;
      this.handlers.onHover({ bar, index: idx, paneId: this.hover.paneId });
    }
  }

  emitView() {
    if (this.handlers.onViewChange) {
      this.handlers.onViewChange(this.visibleRange());
    }
  }

  clampView() {
    const n = this.count || 1;
    const span = this.view.to - this.view.from;
    const maxSpan = Math.max(30, n * 3);
    if (span > maxSpan) {
      this.view.to = this.view.from + maxSpan;
    }
    const minSpan = 10;
    if (this.view.to - this.view.from < minSpan) {
      this.view.to = this.view.from + minSpan;
    }
    const maxRight = n + Math.max(20, n * 0.5);
    if (this.view.to > maxRight) {
      const s = this.view.to - this.view.from;
      this.view.to = maxRight;
      this.view.from = maxRight - s;
    }
    if (this.view.from < -10) {
      const s = this.view.to - this.view.from;
      this.view.from = -10;
      this.view.to = s - 10;
    }
  }
}

function clampedLabelX(x, w, plotR) {
  return clamp(x, w / 2 + 1, plotR - w / 2 - 1);
}
