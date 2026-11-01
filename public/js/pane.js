import { Chart } from './chart.js';
import { DrawingLayer } from './drawings.js';
import { IND, DEFAULT_INDICATORS } from './indicator-defs.js';
import { fmtPrice, fmtSigned, fmtVol, esc, clamp } from './util.js';

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
    this._drag = null;

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
   */
  applyLiveCandle(payload) {
    if (this.replay.active) return false;
    // Accept both the SSE envelope ({symbol, interval, candle, isClosed})
    // and a bare candle object.
    if (payload?.interval && String(payload.interval).toLowerCase() !== String(this.interval).toLowerCase()) return false;
    const c = payload?.candle || payload;
    const bars = this.data?.bars;
    if (!bars || !c) return false;
    const t = Number(c.time ?? c.timeSec ?? 0);
    const last = bars[bars.length - 1];
    if (!last) return false;
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
    } else if (t) {
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      const volume = Number(c.volume);
      if (Number.isFinite(high)) last.h = Math.max(last.h, high);
      if (Number.isFinite(low)) last.l = Math.min(last.l, low);
      if (Number.isFinite(close)) last.c = close;
      if (Number.isFinite(volume)) last.v = volume;
    }
    this.chart.updateData({ ...this.data, bars: [...bars], interval: this.interval });
    this.applyIndicators();
    return true;
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

  setTool(tool) {
    this.tool = tool;
    this.chart.pointerMode = tool ? 'draw' : 'pan';
    this.canvas.classList.toggle('drawing', Boolean(tool));
    if (!tool) {
      this.drawings.preview = null;
      this.chart.requestRender();
    }
  }

  xy(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  draftToShape(d) {
    if (!d) return null;
    if (d.type === 'hline') return { type: 'hline', t1: d.t1, p1: d.p1, color: '#787b86' };
    const colors = { trend: '#2962ff', rect: '#2962ff', fib: '#f0a029' };
    return { type: d.type, t1: d.t1, p1: d.p1, t2: d.t2, p2: d.p2, color: colors[d.type] || '#2962ff' };
  }

  bindDrawing() {
    this.el.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.pane-link') || e.target.closest('.replay-bar')) return;
        const { x, y } = this.xy(e);

        if (this.tool) {
          e.stopPropagation();
          e.preventDefault();
          const p = this.chart.dataAt(x, y);
          this._draft = {
            type: this.tool,
            t1: p.time, p1: p.price, t2: p.time, p2: p.price,
            _sx: x, _sy: y, _moved: false,
          };
          this.drawings.preview = this._draft;
          this.chart.requestRender();
          this.canvas.setPointerCapture?.(e.pointerId);
          return;
        }

        const hitId = this.drawings.hitTest(x, y, this.chart.projector());
        if (hitId) {
          e.stopPropagation();
          e.preventDefault();
          this.drawings.selectedId = hitId;
          const p = this.chart.dataAt(x, y);
          this._drag = { id: hitId, lastIndex: p.index, lastPrice: p.price };
          this.chart.requestRender();
        } else if (this.drawings.selectedId) {
          this.drawings.selectedId = null;
          this.chart.requestRender();
        }
      },
      true,
    );

    this._onMove = (e) => {
      if (!this._draft && !this._drag) return;
      const { x, y } = this.xy(e);

      if (this._draft) {
        if (Math.hypot(x - this._draft._sx, y - this._draft._sy) > 3) this._draft._moved = true;
        const p = this.chart.dataAt(x, y);
        this._draft.t2 = p.time;
        this._draft.p2 = p.price;
        this.drawings.preview = this._draft;
        this.chart.requestRender();
        return;
      }

      if (this._drag) {
        const p = this.chart.dataAt(x, y);
        const dPrice = p.price - this._drag.lastPrice;
        const dIndex = p.index - this._drag.lastIndex;
        if (dPrice !== 0 || dIndex !== 0) {
          this.drawings.move(this._drag.id, dPrice, dIndex, this.chart.projector());
          this._drag.lastPrice = p.price;
          this._drag.lastIndex = p.index;
          this.chart.requestRender();
        }
      }
    };

    this._onUp = () => {
      if (this._draft) {
        const shape = this.draftToShape(this._draft);
        const ok = this._draft.type === 'hline' || this._draft._moved;
        this.drawings.preview = null;
        if (ok && shape) {
          this.drawings.add(shape);
          this.services.onToolConsumed?.(this);
        }
        this._draft = null;
        this.chart.requestRender();
      }
      if (this._drag) {
        this.drawings.persist();
        this._drag = null;
      }
    };

    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);

    this.canvas.addEventListener('contextmenu', (e) => {
      if (!this.data) return;
      const { x, y } = this.xy(e);
      const hitId = this.drawings.hitTest(x, y, this.chart.projector());
      if (hitId) {
        e.preventDefault();
        this.drawings.remove(hitId);
        this.chart.requestRender();
      }
    });

    this.canvas.addEventListener('pointerleave', () => {
      if (this._draft) {
        this._draft = null;
        this.drawings.preview = null;
        this.chart.requestRender();
      }
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
