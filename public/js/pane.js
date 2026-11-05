import { Chart } from './chart.js';
import { DrawingLayer, toolDef, defaultsFor } from './drawings.js';
import { createDrawingPanel, openContextMenu, openInlineEditor, TEXT_TYPES } from './drawing-ui.js';
import { IND, DEFAULT_INDICATORS } from './indicator-defs.js';
import { fmtPrice, fmtSigned, fmtVol, esc, clamp } from './util.js';

const INTERVAL_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

/** Open time of the candle that `ms` belongs to (Binance UTC buckets). */
function bucketStart(interval, ms) {
  const key = String(interval || '').toLowerCase();
  const size = INTERVAL_MS[key];
  if (!size) return null;
  if (key === '1w') {
    // Binance weekly candles open Monday 00:00 UTC; the epoch was a Thursday.
    const offset = 3 * 24 * 60 * 60 * 1000;
    return Math.floor((ms + offset) / size) * size - offset;
  }
  return Math.floor(ms / size) * size;
}

/**
 * One chart inside a workspace grid: canvas, engine, indicators, drawings,
 * link dot and replay. Layout is owned by Workspace; this class only knows
 * its own cell.
 */
export class ChartPane {
  constructor({ id, symbol, interval, indicators, host, services }) {
    this.id = id;
    this.symbol = symbol;
    this.interval = interval;
    this.indicators = new Set(indicators && indicators.length ? indicators : DEFAULT_INDICATORS);
    this.services = services;

    this.data = null;
    this.tool = null;
    this._loading = false;
    this._queued = false;
    this._suppressPublish = false;
    this._pendingView = null;
    this._viewTimer = null;
    this._releaseTimer = null;
    this._lastHover = null;
    this._draft = null;
    this._action = null;
    this._measure = null;
    this._measureTimer = null;
    this._hoverCursor = null;
    this._editor = null;
    this._tickOverlayTimer = null;
    this._lastTickAt = 0;
    this._lastTickBucket = null;

    this.replay = { active: false, index: 0, playing: false, timer: null, speed: 700 };

    this.el = document.createElement('div');
    this.el.className = 'pane-cell';
    this.el.dataset.id = id;
    this.el.innerHTML = `
      <canvas class="pane-canvas"></canvas>
      <div class="legend"></div>
      <div class="pane-link-wrap">
        <button class="pane-link" title="Link group (click to change)"><span class="pane-link-dot"></span></button>
      </div>
      <div class="pane-loader" hidden><div class="spinner"></div></div>
      <div class="pane-error" hidden></div>
      <div class="replay-bar" hidden>
        <button class="rb-btn" data-act="back" title="Step back">&#9664;</button>
        <button class="rb-btn rb-play" data-act="play" title="Play / pause">&#9654;</button>
        <button class="rb-btn" data-act="fwd" title="Step forward">&#9654;&#124;</button>
        <span class="rb-label"></span>
        <select class="rb-speed" title="Speed">
          <option value="1200">0.5x</option>
          <option value="700" selected>1x</option>
          <option value="350">2x</option>
          <option value="150">5x</option>
        </select>
        <button class="rb-btn rb-exit" data-act="exit" title="Exit replay">&#10005;</button>
      </div>
    `;
    host.appendChild(this.el);

    this.canvas = this.el.querySelector('.pane-canvas');
    this.legendEl = this.el.querySelector('.legend');
    this.loaderEl = this.el.querySelector('.pane-loader');
    this.errorEl = this.el.querySelector('.pane-error');
    this.replayBar = this.el.querySelector('.replay-bar');
    this.linkBtn = this.el.querySelector('.pane-link');

    this.drawings = new DrawingLayer();
    this.drawings.onChange = () => {
      this.chart.requestRender();
      this.drawingPanel?.refresh();
      this.services.onDrawingChange?.(this);
    };

    this.chart = new Chart(this.canvas, {
      onHover: ({ bar }) => {
        this.updateLegend(bar, -1);
        if (this._suppressPublish) return;
        const t = bar ? bar.t : null;
        if (this._lastHover !== t) {
          this._lastHover = t;
          this.services.onHover?.(this, t);
        }
      },
      onViewChange: () => {
        if (this._suppressPublish) return;
        clearTimeout(this._viewTimer);
        this._viewTimer = setTimeout(() => {
          this.services.onViewChange?.(this, this.chart.visibleTimes());
        }, 140);
      },
    });

    this.chart.setDrawings(this.drawings);
    this.drawings.load(this.symbol);
    this.drawingPanel = createDrawingPanel(this.el, this.drawings);
    this.drawingPanel.refresh(true);

    this.renderLink();
    this.linkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.services.onCycleLink?.(this);
      this.renderLink();
    });

    this.el.addEventListener(
      'pointerdown',
      () => this.services.onFocus?.(this),
      true,
    );

    this.bindDrawing();
    this.bindReplay();
  }

  /* ---------------- lifecycle ---------------- */

  activate() {
    this.el.classList.add('focused');
    requestAnimationFrame(() => this.chart.resize());
  }

  deactivate() {
    this.el.classList.remove('focused');
  }

  show() {
    this.el.hidden = false;
    requestAnimationFrame(() => this.chart.resize());
  }

  hide() {
    this.el.hidden = true;
  }

  dispose() {
    clearInterval(this.replay.timer);
    clearTimeout(this._viewTimer);
    clearTimeout(this._releaseTimer);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    this.chart.dispose?.();
    this.el.remove();
  }

  serialize() {
    return {
      id: this.id,
      symbol: this.symbol,
      interval: this.interval,
      indicators: [...this.indicators],
    };
  }

  /* ---------------- data ---------------- */

  async load({ silent = false } = {}) {
    // A symbol/interval change can arrive while the first fetch is still in
    // flight (cloned cells load immediately). Queue exactly one follow-up run
    // instead of dropping the request.
    if (this._loading) {
      this._queued = true;
      return;
    }
    this._loading = true;
    if (!silent) this.loaderEl.hidden = false;
    this.errorEl.hidden = true;

    const reqSymbol = this.symbol;
    const reqInterval = this.interval;
    this._lastTickAt = 0;
    this._lastTickBucket = null;
    const started = performance.now();
    try {
      const url = `/api/ohlcv?symbol=${encodeURIComponent(reqSymbol)}&interval=${encodeURIComponent(reqInterval)}`;
      const res = await fetch(url);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);

      // The chart moved on while this response was in transit: discard it and
      // let the queued reload fetch the current symbol/interval.
      if (this.symbol !== reqSymbol || this.interval !== reqInterval) {
        this._queued = true;
        return;
      }

      this.data = payload;
      this.chart.setData({ ...payload, interval: this.interval });
      this.applyIndicators();
      this.updateLegend(null, -1);

      if (this.replay.active) this.chart.setReplayLimit(this.replay.index);

      if (this._pendingView) {
        const view = this._pendingView;
        this._pendingView = null;
        this._applyView(view);
      }

      this.services.onStatus?.('ok', `${payload.symbol} · ${this.interval} · ${payload.bars.length} bars`);
      this.services.onLoaded?.(this, payload, Math.round(performance.now() - started));
    } catch (err) {
      if (this.symbol === reqSymbol && this.interval === reqInterval) {
        this.errorEl.innerHTML =
          `<b>Could not load chart</b><span>${esc(err.message)}</span>` +
          '<button class="btn" data-act="retry">Retry</button>';
        this.errorEl.hidden = false;
        this.errorEl.querySelector('[data-act="retry"]').addEventListener('click', () => this.load());
        this.services.onStatus?.('err', `load failed: ${err.message}`);
      }
    } finally {
      this._loading = false;
      this.loaderEl.hidden = true;
      if (this._queued) {
        this._queued = false;
        this.load({ silent: true });
      }
    }
  }

  async refresh() {
    if (!this.data || this.replay.active || document.visibilityState !== 'visible') return;
    try {
      const url = `/api/ohlcv?symbol=${encodeURIComponent(this.symbol)}&interval=${encodeURIComponent(this.interval)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const payload = await res.json();
      if (!payload.bars || !payload.bars.length) return;
      this.data = payload;
      this.chart.updateData({ ...payload, interval: this.interval });
      this.applyIndicators();
    } catch {
      /* keep last good */
    }
  }

  /**
   * Live candle from the Binance SSE stream: fold the in-progress bar into the
   * last bar, or append it once closed. Used instead of a REST refetch.
   * This arrives about once a second; `applyLiveTick` does the per-trade work.
   */
  applyLiveCandle(payload) {
    if (this.replay.active) return false;
    // Accept both the SSE envelope ({symbol, interval, candle, isClosed})
    // and a bare candle object.
    if (payload?.interval && String(payload.interval).toLowerCase() !== String(this.interval).toLowerCase()) return false;
    const c = payload?.candle || payload;
    const bars = this.data?.bars;
    if (!bars || !c) return false;
    // SSE frames carry `time` (ms); a bare candle may only carry `timeSec`.
    const t = Number(c.time) || (Number(c.timeSec) ? Number(c.timeSec) * 1000 : 0);
    const last = bars[bars.length - 1];
    if (!last) return false;
    // A tick may already have opened the next bucket. A late *closed* frame
    // for the previous bucket still carries its final volume and close.
    if (t && Number(last.t) && t < Number(last.t)) {
      const prev = bars.length > 1 ? bars[bars.length - 2] : null;
      if (payload?.isClosed && prev && t === Number(prev.t)) {
        const high = Number(c.high);
        const low = Number(c.low);
        const close = Number(c.close);
        const volume = Number(c.volume);
        if (Number.isFinite(high)) prev.h = Math.max(prev.h, high);
        if (Number.isFinite(low)) prev.l = Math.min(prev.l, low);
        if (Number.isFinite(close)) prev.c = close;
        if (Number.isFinite(volume)) prev.v = volume;
        this._commitLiveBars(false);
        this.applyIndicators();
        return true;
      }
      return false; // stale frame for an older bucket
    }
    let created = false;
    if (t && Number(last.t) && t > Number(last.t)) {
      bars.push({
        t,
        timeSec: Number(c.timeSec ?? Math.floor(t / 1000)),
        o: Number(c.open),
        h: Number(c.high),
        l: Number(c.low),
        c: Number(c.close),
        v: Number(c.volume || 0),
      });
      created = true;
    } else if (t) {
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      const volume = Number(c.volume);
      // The first tick of a new bucket may have synthesized this bar; adopt
      // the exchange open once the kline snapshot arrives.
      if (Number.isFinite(open)) last.o = open;
      if (Number.isFinite(high)) last.h = Math.max(last.h, high);
      if (Number.isFinite(low)) last.l = Math.min(last.l, low);
      // A kline frame was generated up to a second before it reaches us; if a
      // newer trade already set the close, keep the tick price instead of
      // flashing backwards once per second.
      const fresherTick = this._lastTickBucket === Number(last.t) && Date.now() - this._lastTickAt < 2000;
      if (Number.isFinite(close) && !fresherTick) last.c = close;
      if (Number.isFinite(volume)) last.v = volume;
    }
    this._commitLiveBars(created);
    this.applyIndicators();
    return true;
  }

  /**
   * Per-trade update: mutate the in-progress bar immediately instead of
   * waiting for Binance's ~1 s kline frame, so the candle moves as fast as
   * the trade feed. New buckets are synthesized on the first trade and later
   * reconciled by `applyLiveCandle`.
   */
  applyLiveTick(tick) {
    if (this.replay.active) return false;
    const bars = this.data?.bars;
    if (!bars || !bars.length) return false;
    const price = Number(tick?.price);
    if (!Number.isFinite(price)) return false;
    if (tick.symbol && String(tick.symbol).toUpperCase() !== String(this.symbol).toUpperCase()) return false;

    const ts = Number(tick.time) || Date.now();
    const openTime = bucketStart(this.interval, ts);
    if (openTime == null) return false;

    let last = bars[bars.length - 1];
    // Out-of-order trade from a bucket that already closed: ignore.
    if (Number(last.t) && openTime < Number(last.t)) return false;

    let created = false;
    if (openTime > Number(last.t)) {
      last = {
        t: openTime,
        timeSec: Math.floor(openTime / 1000),
        o: price,
        h: price,
        l: price,
        c: price,
        v: 0,
      };
      bars.push(last);
      created = true;
    } else {
      last.c = price;
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
    }
    this._lastTickAt = Date.now();
    this._lastTickBucket = Number(last.t);

    this._commitLiveBars(created);
    this._scheduleTickOverlayRefresh();
    return created;
  }

  /** Push mutated bars to the canvas and keep the view pinned when at right. */
  _commitLiveBars(created) {
    const bars = this.data?.bars;
    const chart = this.chart;
    if (!bars || !chart) return;
    const span = chart.view.to - chart.view.from;
    const followed = chart.view.to >= chart.count - 1;
    chart.updateData({ ...this.data, bars, interval: this.interval });
    if (created && followed) {
      chart.view.to = chart.count + chart.padRight;
      chart.view.from = chart.view.to - span;
      chart.clampView();
      chart.requestRender();
    }
  }

  /** Rebuild indicators/legend at ~10 Hz, not once per trade. */
  _scheduleTickOverlayRefresh() {
    if (this._tickOverlayTimer) return;
    this._tickOverlayTimer = setTimeout(() => {
      this._tickOverlayTimer = null;
      if (this.replay.active || !this.data) return;
      this.applyIndicators();
      // Keep the legend on the hovered bar if the pointer is over the chart.
      if (this.chart.hover.active) {
        const idx = this.chart.hover.index;
        this.updateLegend(idx >= 0 ? this.data.bars[idx] : null, idx);
      }
    }, 100);
  }


  /* ---------------- state changes ---------------- */

  setSymbol(symbol, { silent = false } = {}) {
    const s = String(symbol || '').trim().toUpperCase();
    if (!s || s === this.symbol) return;
    this.symbol = s;
    this.drawings.load(s);
    this.load();
    this.renderLink();
    if (!silent) this.services.onSymbolChange?.(this, s);
    this.services.onDirty?.(this);
  }

  setInterval(interval, { silent = false } = {}) {
    if (!interval || interval === this.interval) return;
    this.interval = interval;
    this.load();
    if (!silent) this.services.onIntervalChange?.(this, interval);
    this.services.onDirty?.(this);
  }

  toggleIndicator(key) {
    if (this.indicators.has(key)) this.indicators.delete(key);
    else this.indicators.add(key);
    this.applyIndicators();
    this.services.onDirty?.(this);
  }

  setIndicatorSet(keys) {
    this.indicators = new Set(keys && keys.length ? keys : DEFAULT_INDICATORS);
    this.applyIndicators();
    this.services.onDirty?.(this);
  }

  applyIndicators() {
    const data = this.data;
    if (!data) return;
    const bars = data.bars;
    const meta = { timezone: data.timezone };

    const overlays = [];
    const panes = [];
    for (const key of this.indicators) {
      const def = IND[key];
      if (!def) continue;
      if (def.group === 'overlay') overlays.push(...def.build(bars, meta));
      else panes.push(def.build(bars, meta));
    }
    this.chart.setOverlays(overlays);
    this.chart.setPanes(panes);
    this.updateLegend(null, -1);
  }

  /* ---------------- legend / link ---------------- */

  updateLegend(bar, index) {
    const data = this.data;
    if (!data || !data.bars.length) {
      this.legendEl.innerHTML = '';
      return;
    }

    let idx = index;
    if (bar == null || idx < 0 || idx >= data.bars.length) {
      // Follow the replay cursor when replay is trimming the tail.
      idx = Math.max(0, Math.min(this.chart.count, data.bars.length) - 1);
      bar = data.bars[idx];
    }
    const prev = idx > 0 ? data.bars[idx - 1] : null;
    const chg = prev ? bar.c - prev.c : 0;
    const chgPct = prev && prev.c ? (chg / prev.c) * 100 : 0;
    const dir = chg >= 0 ? 'up' : 'down';

    const ovLines = [];
    for (const ov of this.chart.overlays || []) {
      if (!ov.label) continue;
      const v = ov.values[idx];
      if (v == null) continue;
      ovLines.push(
        `<span style="color:${ov.color}">${esc(ov.label)} <b style="color:${ov.color}">${fmtPrice(v)}</b></span>`,
      );
    }

    this.legendEl.innerHTML =
      '<div class="l1">' +
      `<span class="legend-sym">${esc(data.symbol || this.symbol)}</span>` +
      `<span class="legend-tf">${esc(this.interval)}</span>` +
      `<span class="legend-exch">${esc(data.exchange || '')}</span>` +
      '</div>' +
      '<div class="ohlc">' +
      `<span>O <b class="${dir}">${fmtPrice(bar.o)}</b></span>` +
      `<span>H <b class="${dir}">${fmtPrice(bar.h)}</b></span>` +
      `<span>L <b class="${dir}">${fmtPrice(bar.l)}</b></span>` +
      `<span>C <b class="${dir}">${fmtPrice(bar.c)}</b></span>` +
      `<span class="${dir}">${fmtSigned(chg, bar.c)} (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)</span>` +
      `<span>V <b>${fmtVol(bar.v)}</b></span>` +
      '</div>' +
      (ovLines.length ? `<div class="l2">${ovLines.join('')}</div>` : '');
  }

  renderLink() {
    const info = this.services.linkInfo?.(this.id) || { group: null, color: null, label: '' };
    this.linkBtn.classList.toggle('on', Boolean(info.group));
    if (info.color) this.linkBtn.style.setProperty('--link', info.color);
    else this.linkBtn.style.removeProperty('--link');
    this.linkBtn.title = info.group
      ? `Link group: ${info.label} (click to change)`
      : 'Not linked (click to join a group)';
  }

  /* ---------------- linking ---------------- */

  applyRemote(channelOrValues, payload) {
    const values = typeof channelOrValues === 'string'
      ? { [channelOrValues]: payload }
      : (channelOrValues || {});

    this._suppressPublish = true;
    try {
      if (values.symbol !== undefined) this.setSymbol(values.symbol, { silent: true });
      if (values.interval !== undefined) this.setInterval(values.interval, { silent: true });
      if (values.crosshair !== undefined) this.chart.setExternalCrosshair(values.crosshair);

      const view = {};
      if (values.dateRange) view.dateRange = values.dateRange;
      else if (values.time !== undefined) view.time = values.time;
      if (Object.keys(view).length) {
        // A symbol/interval change is still fetching: replay the view once the
        // new bars land, otherwise set it against the data already on screen.
        if (this._loading) this._pendingView = view;
        else this._applyView(view);
      }
    } finally {
      clearTimeout(this._releaseTimer);
      this._releaseTimer = setTimeout(() => {
        this._suppressPublish = false;
      }, 260);
    }
  }

  _applyView(view) {
    if (!view) return;
    if (view.dateRange) this.chart.setViewByTime(view.dateRange.startTime, view.dateRange.endTime);
    else if (Number.isFinite(view.time)) this.chart.setViewStartTime(view.time);
  }

  /* ---------------- drawing ---------------- */

  setTool(id) {
    this.tool = id || null;
    const def = this.tool ? toolDef(this.tool) : null;
    const kind = def ? def.kind : null;
    const drawMode = kind === 'draw' || kind === 'measure' || kind === 'zoom' || this.tool === 'eraser';
    this.chart.pointerMode = drawMode ? 'draw' : 'pan';
    this.canvas.classList.toggle('drawing', drawMode);
    this.canvas.classList.toggle('tool-eraser', this.tool === 'eraser');
    this.canvas.classList.toggle('cursor-cross', this.tool === 'cursorCross');
    this.canvas.classList.toggle('cursor-dot', this.tool === 'cursorDot');
    this.canvas.classList.toggle('cursor-arrow', this.tool === 'cursorArrow' || !this.tool);
    this.canvas.style.cursor = kind === 'cursor' ? (def.cursorStyle || '') : '';
    if (this._draft) this.cancelDraft();
    this.clearMeasure();
    this.chart.requestRender();
  }

  xy(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pointAt(e, { snap = true } = {}) {
    const { x, y } = this.xy(e);
    const raw = this.chart.dataAt(x, y);
    const project = this.chart.projector();
    let t = raw.time;
    let p = raw.price;
    if (snap && this.tool !== 'brush' && this.tool !== 'highlighter') {
      const snapped = this.drawings.snapPoint(raw.time, raw.price, this.chart, project);
      t = snapped.t;
      p = snapped.p;
    }
    return { x, y, t, p, index: raw.index, price: raw.price, project };
  }

  buildPreview() {
    const d = this._draft;
    if (!d) {
      this.drawings.preview = null;
      return;
    }
    const pts = d.points.slice();
    if (!d.freehand && d.hover && d.def.anchors > 1 && pts.length < d.def.anchors) pts.push(d.hover);
    if (!pts.length) {
      this.drawings.preview = null;
      return;
    }
    this.drawings.preview = { ...defaultsFor(d.type), type: d.type, points: pts };
  }

  cancelDraft() {
    if (!this._draft) return;
    this._draft = null;
    this.drawings.preview = null;
    this.chart.requestRender();
  }

  startDraft(point) {
    const def = toolDef(this.tool);
    if (!def) return false;
    this._draft = {
      type: this.tool,
      def,
      points: [{ t: point.t, p: point.p }],
      hover: null,
      freehand: def.anchors === 0,
      pressed: true,
      downX: point.x,
      downY: point.y,
      moved: false,
    };
    if (def.anchors === 1) this._draft.hover = { t: point.t, p: point.p };
    this.buildPreview();
    this.chart.requestRender();
    return true;
  }

  addDraftPoint(point) {
    const d = this._draft;
    if (!d) return;
    d.points.push({ t: point.t, p: point.p });
    d.hover = null;
    d.pressed = true;
    d.downX = point.x;
    d.downY = point.y;
    d.moved = false;
    if (d.def.anchors > 0 && d.points.length >= d.def.anchors) this.finishDraft();
    else this.buildPreview();
    this.chart.requestRender();
  }

  finishDraft(point, { force = false } = {}) {
    const d = this._draft;
    if (!d) return null;
    const anchors = d.def.anchors;
    let pts = d.points.slice();
    if (point) {
      if (anchors === 1) {
        pts = [{ t: point.t, p: point.p }];
      } else {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(point.x - (last.x ?? 0), point.y - (last.y ?? 0)) > 0.5) {
          pts.push({ t: point.t, p: point.p });
        }
      }
    }
    if (anchors > 0) {
      while (pts.length < anchors && d.hover) {
        pts.push({ t: d.hover.t, p: d.hover.p });
      }
      pts = pts.slice(0, anchors);
      if (pts.length < anchors && !force) {
        this.buildPreview();
        return null;
      }
    }
    if ((anchors === 0 || anchors === -1) && pts.length < 2) {
      this.cancelDraft();
      return null;
    }
    const type = d.type;
    this._draft = null;
    this.drawings.preview = null;
    const extra = {};
    if (type === 'sticker') extra.emoji = this.services.getStickerEmoji?.() || '😀';
    const shape = this.drawings.add({ type, points: pts, ...extra });
    this.chart.requestRender();
    if (shape) {
      this.services.onToolConsumed?.(this);
      if (TEXT_TYPES.has(shape.type)) this.editShapeText(shape, { fresh: true });
    }
    return shape;
  }

  clearMeasure() {
    clearTimeout(this._measureTimer);
    this._measureTimer = null;
    this._measure = null;
    if (this.drawings.preview && (this.drawings.preview.type === 'measure' || this.drawings.preview.type === 'zoom')) {
      this.drawings.preview = null;
      this.chart.requestRender();
    }
  }

  startMeasure(point) {
    this.clearMeasure();
    const type = this.tool;
    const first = { t: point.t, p: point.p };
    this._measure = {
      type,
      points: [first, { ...first }],
      downX: point.x,
      downY: point.y,
      moved: false,
    };
    this.drawings.preview = { type, points: this._measure.points, color: type === 'zoom' ? '#2962ff' : '#26a69a' };
    this.chart.requestRender();
  }

  finishMeasure() {
    const m = this._measure;
    if (!m) return;
    this._measure = null;
    const [a, b] = m.points;
    if (!m.moved) {
      this.drawings.preview = null;
      this.chart.requestRender();
      return;
    }
    if (m.type === 'zoom') {
      this.drawings.preview = null;
      const t1 = Math.min(a.t, b.t);
      const t2 = Math.max(a.t, b.t);
      if (t2 > t1) this.chart.setViewByTime(t1, t2);
      this.chart.requestRender();
    } else {
      this.drawings.preview = { type: 'measure', points: [{ ...a }, { ...b }], color: '#26a69a' };
      this._measureTimer = setTimeout(() => {
        this.drawings.preview = null;
        this.chart.requestRender();
      }, 4000);
      this.chart.requestRender();
    }
    this.services.onToolConsumed?.(this);
  }

  editShapeText(shape, { fresh = false } = {}) {
    if (!shape) return;
    this._editor?.close();
    const project = this.chart.projector();
    const pt = shape.points[0];
    if (!pt) return;
    const x = project.x(pt.t);
    const y = project.y(pt.p);
    this._editor = openInlineEditor(this.el, {
      x: Math.min(x + 8, this.chart.plotR - 60),
      y: Math.max(6, y - 28),
      value: fresh ? '' : (shape.text || ''),
      fontSize: shape.fontSize || 12,
      color: shape.color || '#d1d4dc',
      onCommit: (text) => {
        this._editor = null;
        this.drawings.begin();
        this.drawings.update(shape.id, { text }, { commit: false });
        this.drawings.commit();
        this.chart.requestRender();
      },
      onCancel: () => { this._editor = null; },
    });
  }

  updateCursor(x, y) {
    if (this.tool) return;
    const project = this.chart.projector();
    const handle = this.drawings.handleAt(x, y, project);
    if (handle) {
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const hit = this.drawings.hitTest(x, y, project, { includeLocked: true });
    if (hit) this.canvas.style.cursor = this.drawings.isLocked(hit) ? 'not-allowed' : 'move';
    else this.canvas.style.cursor = '';
  }

  handleKey(e) {
    if (e.key === 'Escape') {
      if (this._draft) { this.cancelDraft(); return true; }
      if (this._measure) { this.clearMeasure(); return true; }
      if (this._editor) { this._editor.close(); return true; }
      if (this.drawings.selectedIds.size) { this.drawings.clearSelection(); return true; }
      return false;
    }
    if (e.key === 'Enter') {
      if (this._draft) { this.finishDraft(); return true; }
      const s = this.drawings.selectedShape();
      if (s && TEXT_TYPES.has(s.type)) { this.editShapeText(s); return true; }
      return false;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.drawings.selectedIds.size) {
        this.drawings.removeSelected();
        this.chart.requestRender();
        return true;
      }
      return false;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) this.drawings.redo();
      else this.drawings.undo();
      this.chart.requestRender();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      this.drawings.redo();
      this.chart.requestRender();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'c') {
      this.drawings.copySelected();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      this.drawings.paste();
      this.chart.requestRender();
      return true;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      this.drawings.duplicateSelected();
      this.chart.requestRender();
      return true;
    }
    return false;
  }

  bindDrawing() {
    this.el.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        if (!this.data) return;
        if (e.target.closest('.pane-link') || e.target.closest('.replay-bar') || e.target.closest('.draw-props') || e.target.closest('.inline-editor')) return;
        const point = this.pointAt(e);

        if (this.tool === 'eraser') {
          e.stopPropagation();
          e.preventDefault();
          const hit = this.drawings.hitTest(point.x, point.y, point.project);
          if (hit) {
            this.drawings.remove(hit.id);
            this.chart.requestRender();
            this.services.onToolConsumed?.(this);
          }
          return;
        }

        if (this.tool === 'measure' || this.tool === 'zoom') {
          e.stopPropagation();
          e.preventDefault();
          this.startMeasure(point);
          return;
        }

        const def = this.tool ? toolDef(this.tool) : null;
        if (def && def.kind === 'draw') {
          e.stopPropagation();
          e.preventDefault();
          if (!this._draft) {
            this.startDraft(point);
          } else {
            this.addDraftPoint(point);
          }
          return;
        }

        const handle = this.drawings.handleAt(point.x, point.y, point.project);
        if (handle) {
          e.stopPropagation();
          e.preventDefault();
          this.drawings.begin();
          this._action = { kind: 'handle', id: handle.shape.id, index: handle.handle.index };
          return;
        }

        const hit = this.drawings.hitTest(point.x, point.y, point.project);
        if (hit) {
          e.stopPropagation();
          e.preventDefault();
          if (e.shiftKey) this.drawings.select(hit.id, { additive: true });
          else if (!this.drawings.selectedIds.has(hit.id)) this.drawings.select(hit.id);
          this.drawings.begin();
          this._action = { kind: 'move', lastIndex: point.index, lastPrice: point.price };
          this.chart.requestRender();
          return;
        }

        if (this.drawings.selectedIds.size) this.drawings.clearSelection();
      },
      true,
    );

    this._onMove = (e) => {
      if (this._draft) {
        const d = this._draft;
        const point = this.pointAt(e, { snap: d.type !== 'brush' && d.type !== 'highlighter' });
        d.moved = Math.hypot(point.x - d.downX, point.y - d.downY) > 3 || d.moved;
        if (d.freehand) {
          const last = d.points[d.points.length - 1];
          if (!last || Math.hypot(point.x - this.chart.projector().x(last.t), point.y - this.chart.projector().y(last.p)) > 2) {
            d.points.push({ t: point.t, p: point.p });
          }
        } else if (d.def.anchors === 1) {
          d.points[0] = { t: point.t, p: point.p };
        } else {
          d.hover = { t: point.t, p: point.p };
        }
        this.buildPreview();
        this.chart.requestRender();
        return;
      }

      if (this._measure) {
        const point = this.pointAt(e);
        this._measure.points[1] = { t: point.t, p: point.p };
        this._measure.moved = Math.hypot(point.x - this._measure.downX, point.y - this._measure.downY) > 3 || this._measure.moved;
        this.drawings.preview = {
          type: this._measure.type,
          points: this._measure.points,
          color: this._measure.type === 'zoom' ? '#2962ff' : '#26a69a',
        };
        this.chart.requestRender();
        return;
      }

      if (this._action) {
        const point = this.pointAt(e);
        if (this._action.kind === 'handle') {
          this.drawings.setPoint(this._action.id, this._action.index, point.t, point.p);
        } else {
          const dPrice = point.price - this._action.lastPrice;
          const dIndex = point.index - this._action.lastIndex;
          if (dPrice !== 0 || dIndex !== 0) {
            this.drawings.moveSelected(dPrice, dIndex, this.chart.projector());
            this._action.lastPrice = point.price;
            this._action.lastIndex = point.index;
          }
        }
        this.chart.requestRender();
        return;
      }

      this.updateCursor(this.xy(e).x, this.xy(e).y);
    };

    this._onUp = (e) => {
      if (this._draft) {
        const d = this._draft;
        const wasPressed = d.pressed;
        d.pressed = false;
        if (!wasPressed) return;
        const point = this.pointAt(e, { snap: d.type !== 'brush' && d.type !== 'highlighter' });
        if (d.freehand) {
          this.finishDraft();
        } else if (d.def.anchors === 1) {
          this.finishDraft(point);
        } else if (d.def.anchors === 2 && d.moved) {
          this.finishDraft(point);
        } else {
          d.hover = null;
          this.buildPreview();
          this.chart.requestRender();
        }
        return;
      }

      if (this._measure) {
        this.finishMeasure();
        return;
      }

      if (this._action) {
        this.drawings.commit();
        this._action = null;
        this.chart.requestRender();
      }
    };

    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);

    this.el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.draw-props') || e.target.closest('.inline-editor')) return;
      if (this._draft && (this._draft.def.anchors === -1 || this._draft.def.anchors === 0)) {
        const pts = this._draft.points;
        if (pts.length > 2) {
          const a = pts[pts.length - 1];
          const b = pts[pts.length - 2];
          const project = this.chart.projector();
          if (Math.hypot(project.x(a.t) - project.x(b.t), project.y(a.p) - project.y(b.p)) < 3) pts.pop();
        }
        e.preventDefault();
        e.stopPropagation();
        this.finishDraft();
        return;
      }
      const { x, y } = this.xy(e);
      const hit = this.drawings.hitTest(x, y, this.chart.projector());
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        this.drawings.select(hit.id);
        if (TEXT_TYPES.has(hit.type)) this.editShapeText(hit);
      }
    }, true);

    this.canvas.addEventListener('contextmenu', (e) => {
      if (!this.data) return;
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = this.xy(e);
      const project = this.chart.projector();
      const hit = this.drawings.hitTest(x, y, project, { includeLocked: true });
      if (hit) {
        this.drawings.select(hit.id);
        this.drawingPanel.refresh(true);
        openContextMenu(e.clientX, e.clientY, [
          { label: 'Edit properties', action: () => this.drawingPanel.refresh(true) },
          { label: 'Duplicate', action: () => { this.drawings.duplicateSelected(); this.chart.requestRender(); } },
          { label: 'Copy', action: () => this.drawings.copySelected() },
          { separator: true },
          { label: 'Bring to front', action: () => this.drawings.bringToFront() },
          { label: 'Send to back', action: () => this.drawings.sendToBack() },
          { separator: true },
          {
            label: this.drawings.lockedAll ? 'Unlock all drawings' : (hit.locked ? 'Unlock' : 'Lock'),
            action: () => {
              if (this.drawings.lockedAll) this.drawings.setLockedAll(false);
              else this.drawings.toggleLockSelected();
            },
          },
          {
            label: hit.hidden ? 'Show' : 'Hide',
            action: () => { this.drawings.toggleHideSelected(); this.chart.requestRender(); },
          },
          { separator: true },
          { label: 'Delete', danger: true, action: () => { this.drawings.removeSelected(); this.chart.requestRender(); } },
        ]);
        return;
      }
      const hiddenCount = this.drawings.shapes.filter((s) => s.hidden).length;
      openContextMenu(e.clientX, e.clientY, [
        { label: 'Paste', disabled: !this.drawings.clipboard.length, action: () => { this.drawings.paste(); this.chart.requestRender(); } },
        { label: 'Select all drawings', action: () => this.drawings.selectAll() },
        { separator: true },
        { label: this.drawings.hiddenAll ? 'Show all drawings' : 'Hide all drawings', action: () => { this.drawings.setHiddenAll(!this.drawings.hiddenAll); this.chart.requestRender(); } },
        { label: hiddenCount ? `Show ${hiddenCount} hidden` : 'Show hidden drawings', disabled: !hiddenCount, action: () => { for (const s of this.drawings.shapes) s.hidden = false; this.drawings.persist(); this.chart.requestRender(); } },
        { label: this.drawings.lockedAll ? 'Unlock all drawings' : 'Lock all drawings', action: () => { this.drawings.setLockedAll(!this.drawings.lockedAll); this.chart.requestRender(); } },
        { separator: true },
        { label: 'Remove all drawings', danger: true, action: () => { this.drawings.removeAll(); this.chart.requestRender(); } },
      ]);
    });

    this.canvas.addEventListener('pointerleave', () => {
      if (!this.tool) this.canvas.style.cursor = '';
    });
  }

  /* ---------------- replay ---------------- */

  bindReplay() {
    this.replayBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'back') this.stepReplay(-1);
      else if (act === 'fwd') this.stepReplay(1);
      else if (act === 'play') this.toggleReplayPlay();
      else if (act === 'exit') this.stopReplay();
    });

    this.replayBar.querySelector('.rb-speed').addEventListener('change', (e) => {
      this.replay.speed = Number(e.target.value);
      if (this.replay.playing) {
        this._stopTimer();
        this._startTimer();
      }
    });
  }

  startReplay() {
    const bars = this.data?.bars;
    if (!bars || !bars.length) return;
    this.replay.active = true;
    this.replay.index = Math.max(20, bars.length - 120);
    this.chart.setReplayLimit(this.replay.index);
    this.replayBar.hidden = false;
    this._updateReplayLabel();
    this.updateLegend(null, -1);
    this.services.onStatus?.('warn', 'replay mode — live updates paused');
  }

  stopReplay() {
    this._stopTimer();
    this.replay.active = false;
    this.replay.playing = false;
    this.replayBar.hidden = true;
    this.chart.setReplayLimit(null);
    this.chart.fit();
    this.updateLegend(null, -1);
    this.services.onStatus?.('ok', 'replay ended');
  }

  stepReplay(delta) {
    const bars = this.data?.bars;
    if (!bars || !this.replay.active) return;
    this.replay.index = clamp(this.replay.index + delta, 10, bars.length);
    this.chart.setReplayLimit(this.replay.index);
    this._updateReplayLabel();
    this.updateLegend(null, -1);
    if (this.replay.index >= bars.length) this._stopTimer();
  }

  toggleReplayPlay() {
    if (this.replay.playing) this._stopTimer();
    else {
      this._startTimer();
      this.replay.playing = true;
      this.replayBar.querySelector('.rb-play').innerHTML = '&#10074;&#10074;';
    }
  }

  _startTimer() {
    clearInterval(this.replay.timer);
    this.replay.timer = setInterval(() => this.stepReplay(1), this.replay.speed);
    this.replay.playing = true;
    this.replayBar.querySelector('.rb-play').innerHTML = '&#10074;&#10074;';
  }

  _stopTimer() {
    clearInterval(this.replay.timer);
    this.replay.timer = null;
    this.replay.playing = false;
    const btn = this.replayBar.querySelector('.rb-play');
    if (btn) btn.innerHTML = '&#9654;';
  }

  _updateReplayLabel() {
    const n = this.data?.bars?.length || 0;
    this.replayBar.querySelector('.rb-label').textContent = `bar ${this.replay.index} / ${n}`;
  }
}
