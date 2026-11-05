import { fmtPrice, fmtSigned, esc, uid } from './util.js';

const KEY = 'tvfree.trading.v1';
const MAX_FILLS = 200;
const MAX_EQUITY = 240;
const START_CASH = 100000;

function load(fallback) {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signedMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
}

function qtyText(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/**
 * Paper trading desk. Long-only spot account, one shared virtual cash balance
 * (no FX conversion between symbol currencies), no fees or slippage. Market
 * orders fill at the last quote; limit orders fill on a later quote tick.
 */
export class TradeDesk {
  constructor({ host, getSymbol, getQuote, getLastBar, onStatus, onChange }) {
    this.host = host;
    this.getSymbol = getSymbol;
    this.getQuote = getQuote;
    this.getLastBar = getLastBar;
    this.onStatus = onStatus;
    this.onChange = onChange;

    const saved = load(null);
    this.account = saved && saved.positions ? saved : TradeDesk.freshAccount();
    this.account.positions ||= {};
    this.account.orders ||= [];
    this.account.fills ||= [];
    this.account.equity ||= [];
    this.account.realized ||= 0;
    this.account.cash = Number.isFinite(this.account.cash) ? this.account.cash : START_CASH;
    this.account.startCash ||= START_CASH;
    this.account.seeded = Boolean(this.account.seeded);

    this.mode = 'watchlist';
    this.side = 'buy';
    this.type = 'market';
    this.qty = 10;
    this._resetArmed = 0;
    this._saveTimer = null;
    this._lastEquitySample = 0;
    this._lastQuoteRender = 0;
    this.mounted = false;
  }

  static freshAccount() {
    return {
      startCash: START_CASH,
      cash: START_CASH,
      realized: 0,
      positions: {},
      orders: [],
      fills: [],
      equity: [],
      seeded: false,
    };
  }

  /* ------------------------------------------------------------------ *
   * Mount
   * ------------------------------------------------------------------ */

  mount() {
    if (this.mounted) return;
    this.mounted = true;

    this.host.innerHTML = `
      <div class="tr-account">
        <div class="tr-acct-head">
          <span>Virtual account</span>
          <button class="tr-reset" id="trReset" title="Reset paper account">reset</button>
        </div>
        <div class="tr-acct-grid">
          <div><em>Equity</em><b id="trEquity">—</b></div>
          <div><em>Cash</em><b id="trCash">—</b></div>
          <div><em>Realized</em><b id="trRealized">—</b></div>
          <div><em>Open P&amp;L</em><b id="trOpen">—</b></div>
        </div>
        <canvas class="tr-spark" id="trSpark" height="34"></canvas>
        <div class="tr-acct-note">virtual funds · no FX conversion · no fees</div>
      </div>

      <div class="tr-ticket">
        <div class="tr-sym-row">
          <span class="tr-sym" id="trSym">—</span>
          <span class="tr-last" id="trLast">—</span>
        </div>
        <div class="seg" id="trSide">
          <button data-side="buy" class="on">Buy</button>
          <button data-side="sell">Sell</button>
        </div>
        <div class="tr-line">
          <label class="tr-field">
            <span>Qty</span>
            <input id="trQty" type="number" min="0" step="1" value="10" inputmode="decimal" />
          </label>
          <label class="tr-field">
            <span>Order</span>
            <select id="trType">
              <option value="market">Market</option>
              <option value="limit">Limit</option>
            </select>
          </label>
        </div>
        <label class="tr-field" id="trLimitWrap" hidden>
          <span>Limit price</span>
          <input id="trLimit" type="number" min="0" step="any" inputmode="decimal" />
        </label>
        <div class="tr-est">
          <span>Est. value</span><b id="trEst">—</b>
          <span class="tr-max" id="trMax">max 0</span>
        </div>
        <button class="btn primary tr-submit" id="trSubmit">Buy 10</button>
        <div class="tr-hint" id="trHint"></div>
      </div>

      <div class="tr-block">
        <div class="tr-block-head"><span>Positions</span><b id="trPosCount">0</b></div>
        <div class="tr-list" id="trPositions"></div>
      </div>

      <div class="tr-block">
        <div class="tr-block-head"><span>Working orders</span><b id="trOrdCount">0</b></div>
        <div class="tr-list" id="trOrders"></div>
      </div>

      <div class="tr-block">
        <div class="tr-block-head"><span>Recent fills</span><b id="trFillCount">0</b></div>
        <div class="tr-list" id="trFills"></div>
      </div>
    `;

    this.$ = (id) => this.host.querySelector(`#${id}`);
    this.equityEl = this.$('trEquity');
    this.cashEl = this.$('trCash');
    this.realizedEl = this.$('trRealized');
    this.openEl = this.$('trOpen');
    this.sparkEl = this.$('trSpark');
    this.symEl = this.$('trSym');
    this.lastEl = this.$('trLast');
    this.estEl = this.$('trEst');
    this.maxEl = this.$('trMax');
    this.submitEl = this.$('trSubmit');
    this.hintEl = this.$('trHint');
    this.qtyEl = this.$('trQty');
    this.limitEl = this.$('trLimit');
    this.limitWrap = this.$('trLimitWrap');
    this.typeEl = this.$('trType');

    this.$('trSide').addEventListener('click', (e) => {
      const b = e.target.closest('[data-side]');
      if (!b) return;
      this.setSide(b.dataset.side);
    });

    this.typeEl.addEventListener('change', () => {
      this.type = this.typeEl.value === 'limit' ? 'limit' : 'market';
      if (this.type === 'limit' && !this.limitEl.value) {
        const px = this.priceOf(this.getSymbol());
        if (px) this.limitEl.value = px.toFixed(2);
      }
      this.limitWrap.hidden = this.type !== 'limit';
      this.renderTicket();
    });

    this.qtyEl.addEventListener('input', () => {
      this.qty = Number(this.qtyEl.value) || 0;
      this.renderTicket();
    });

    this.limitEl.addEventListener('input', () => this.renderTicket());

    this.submitEl.addEventListener('click', () => this.submit());
    this.qtyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
    });
    this.limitEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
    });

    this.$('trReset').addEventListener('click', () => this.reset());
    this.$('trPositions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-close]');
      if (b) this.closePosition(b.dataset.close);
    });
    this.$('trOrders').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cancel]');
      if (b) this.cancelOrder(b.dataset.cancel);
    });

    this.render();
  }

  setMode(mode) {
    this.mode = mode === 'trade' ? 'trade' : 'watchlist';
    if (this.mode === 'trade') {
      this.mount();
      this.syncSymbol();
    }
  }

  syncSymbol() {
    if (!this.mounted) return;
    const sym = this.getSymbol() || '';
    if (this.symEl.dataset.sym !== sym) {
      this.symEl.dataset.sym = sym;
      this.symEl.textContent = sym || '—';
      if (this.type === 'limit') {
        const px = this.priceOf(sym);
        if (px) this.limitEl.value = px.toFixed(2);
      }
    }
    this.renderTicket();
  }

  /* ------------------------------------------------------------------ *
   * Pricing
   * ------------------------------------------------------------------ */

  priceOf(symbol) {
    if (!symbol) return null;
    const q = this.getQuote?.(symbol);
    if (q && !q.error && Number.isFinite(q.price) && q.price > 0) return q.price;
    const bar = this.getLastBar?.(symbol);
    if (bar && Number.isFinite(bar.c)) return bar.c;
    return null;
  }

  /** Symbols the quote loop must keep warm for this account. */
  symbols() {
    return [...new Set([
      ...Object.keys(this.account.positions || {}),
      ...(this.account.orders || []).map((o) => o.symbol),
    ])];
  }

  /** Snapshot of positions valued at the latest quotes. */
  snapshot() {
    let open = 0;
    let value = 0;
    const rows = [];
    for (const [symbol, pos] of Object.entries(this.account.positions)) {
      if (!pos || pos.qty <= 0) continue;
      const last = this.priceOf(symbol);
      const pnl = last != null ? (last - pos.avg) * pos.qty : 0;
      const val = last != null ? last * pos.qty : pos.avg * pos.qty;
      open += pnl;
      value += val;
      rows.push({ symbol, qty: pos.qty, avg: pos.avg, last, pnl, value: val });
    }
    const equity = this.account.cash + value;
    return { rows, open, value, equity };
  }

  /* ------------------------------------------------------------------ *
   * Orders
   * ------------------------------------------------------------------ */

  submit() {
    const symbol = this.getSymbol();
    if (!symbol) return this.flash('no active chart');
    const qty = Number(this.qtyEl.value);
    if (!Number.isFinite(qty) || qty <= 0) return this.flash('quantity must be positive');

    const price = this.priceOf(symbol);
    if (price == null) return this.flash('waiting for a quote on this symbol');

    if (this.type === 'limit') {
      const limit = Number(this.limitEl.value);
      if (!Number.isFinite(limit) || limit <= 0) return this.flash('limit price must be positive');
      return this.placeLimit({ symbol, side: this.side, qty, limit });
    }

    return this.fill({ symbol, side: this.side, qty, price, kind: 'market' });
  }

  fill({ symbol, side, qty, price, kind, orderId = null }) {
    const sym = String(symbol).toUpperCase();
    const pos = this.account.positions[sym] || { qty: 0, avg: 0 };
    const cost = qty * price;

    if (side === 'buy') {
      if (cost > this.account.cash + 1e-9) {
        this.flash(`not enough cash — need ${money(cost)}, have ${money(this.account.cash)}`);
        return null;
      }
      this.account.cash -= cost;
      const newQty = pos.qty + qty;
      pos.avg = newQty > 0 ? (pos.avg * pos.qty + cost) / newQty : 0;
      pos.qty = newQty;
      this.account.positions[sym] = pos;
    } else {
      if (qty > pos.qty + 1e-9) {
        this.flash(`you hold ${qtyText(pos.qty)} ${sym}`);
        return null;
      }
      this.account.cash += cost;
      this.account.realized += (price - pos.avg) * qty;
      pos.qty -= qty;
      if (pos.qty <= 1e-9) delete this.account.positions[sym];
      else this.account.positions[sym] = pos;
    }

    if (orderId) this.account.orders = this.account.orders.filter((o) => o.id !== orderId);

    this.account.fills.unshift({
      id: uid('f'),
      at: Date.now(),
      barTime: this.getLastBar?.(sym)?.t || Date.now(),
      symbol: sym,
      side,
      qty,
      price,
      kind,
    });
    this.account.fills = this.account.fills.slice(0, MAX_FILLS);

    this.recordEquity();
    this.commit(`filled: ${side} ${qtyText(qty)} ${sym} @ ${fmtPrice(price)}`);
    return true;
  }

  placeLimit({ symbol, side, qty, limit }) {
    const sym = String(symbol).toUpperCase();
    const price = this.priceOf(sym);
    const pos = this.account.positions[sym];

    if (side === 'sell' && (!pos || qty > pos.qty + 1e-9)) {
      this.flash(`you hold ${qtyText(pos?.qty || 0)} ${sym}`);
      return null;
    }
    if (side === 'buy' && qty * limit > this.account.cash + 1e-9) {
      this.flash(`not enough cash for ${money(qty * limit)}`);
      return null;
    }

    // A limit that already crosses the market should fill now, like a real book.
    if (price != null && ((side === 'buy' && price <= limit) || (side === 'sell' && price >= limit))) {
      return this.fill({ symbol: sym, side, qty, price, kind: 'limit' });
    }

    this.account.orders.unshift({
      id: uid('o'),
      symbol: sym,
      side,
      qty,
      limit,
      createdAt: Date.now(),
    });
    this.commit(`order working: ${side} ${qtyText(qty)} ${sym} @ ${fmtPrice(limit)}`);
    return true;
  }

  cancelOrder(id) {
    const order = this.account.orders.find((o) => o.id === id);
    if (!order) return;
    this.account.orders = this.account.orders.filter((o) => o.id !== id);
    this.commit(`order cancelled: ${order.side} ${qtyText(order.qty)} ${order.symbol}`);
  }

  closePosition(symbol) {
    const pos = this.account.positions[symbol];
    if (!pos || pos.qty <= 0) return;
    const price = this.priceOf(symbol);
    if (price == null) return this.flash(`no quote for ${symbol}`);
    this.fill({ symbol, side: 'sell', qty: pos.qty, price, kind: 'close' });
  }

  reset() {
    const btn = this.$('trReset');
    if (Date.now() - this._resetArmed > 3500) {
      this._resetArmed = Date.now();
      btn.textContent = 'confirm?';
      setTimeout(() => {
        if (this.mounted) btn.textContent = 'reset';
      }, 3600);
      return;
    }

    this.account = TradeDesk.freshAccount();
    this.account.equity = [{ t: Date.now(), v: START_CASH }];
    this.account.seeded = true;
    this._resetArmed = 0;
    btn.textContent = 'reset';
    this.commit('paper account reset');
    this.onStatus?.('ok', 'paper account reset');
  }

  /* ------------------------------------------------------------------ *
   * Ticks
   * ------------------------------------------------------------------ */

  onQuotes() {
    if (!this.mounted && !this.account.orders.length && !this.account.seeded) return;

    let changed = false;
    for (const order of [...this.account.orders]) {
      const price = this.priceOf(order.symbol);
      if (price == null) continue;

      const hit = order.side === 'buy' ? price <= order.limit : price >= order.limit;
      if (!hit) continue;

      const pos = this.account.positions[order.symbol];
      if (order.side === 'sell' && (!pos || order.qty > pos.qty + 1e-9)) {
        this.account.orders = this.account.orders.filter((o) => o.id !== order.id);
        changed = true;
        this.onStatus?.('warn', `limit sell cancelled — ${order.symbol} position no longer covers it`);
        continue;
      }
      if (order.side === 'buy' && order.qty * Math.min(price, order.limit) > this.account.cash + 1e-9) {
        this.account.orders = this.account.orders.filter((o) => o.id !== order.id);
        changed = true;
        this.onStatus?.('warn', `limit buy cancelled — not enough cash for ${order.symbol}`);
        continue;
      }

      const fillPrice = order.side === 'buy' ? Math.min(price, order.limit) : Math.max(price, order.limit);
      this.fill({ symbol: order.symbol, side: order.side, qty: order.qty, price: fillPrice, kind: 'limit', orderId: order.id });
      changed = true;
    }

    if (!this.account.seeded) {
      this.account.seeded = true;
      this.recordEquity(true);
      changed = true;
    } else if (Date.now() - this._lastEquitySample > 60000) {
      this.recordEquity();
      changed = true;
    }

    if (changed) {
      this.persist();
      this.render();
      this.onChange?.();
    } else if (this.mounted) {
      // Quotes move, so equity/unrealized text must follow even without a
      // fill. Trade ticks can arrive dozens of times a second, so cap the
      // DOM refresh at 10 Hz while keeping fill checks per tick.
      const now = Date.now();
      if (now - this._lastQuoteRender < 100) return;
      this._lastQuoteRender = now;
      this.renderAccount();
      this.renderPositions();
      this.renderTicket();
    }
  }

  recordEquity(force = false) {
    const snap = this.snapshot();
    const last = this.account.equity[this.account.equity.length - 1];
    if (!force && last && Math.abs(last.v - snap.equity) < 1e-9 && Date.now() - last.t < 60000) return;
    this.account.equity.push({ t: Date.now(), v: snap.equity });
    this.account.equity = this.account.equity.slice(-MAX_EQUITY);
    this._lastEquitySample = Date.now();
  }

  /* ------------------------------------------------------------------ *
   * Persistence / events
   * ------------------------------------------------------------------ */

  persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.account));
    } catch {
      /* ignore quota */
    }
  }

  commit(message) {
    this.persist();
    this.render();
    this.onChange?.();
    if (message) this.onStatus?.('ok', message);
  }

  flash(text) {
    if (!this.mounted) return null;
    this.hintEl.textContent = text;
    this.hintEl.classList.add('warn');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      this.hintEl.textContent = '';
      this.hintEl.classList.remove('warn');
    }, 3200);
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Charts
   * ------------------------------------------------------------------ */

  levelsFor(symbol) {
    const levels = [];
    const pos = this.account.positions[symbol];
    if (pos && pos.qty > 0) {
      levels.push({ price: pos.avg, color: '#2962ff', label: `avg ${fmtPrice(pos.avg)}`, dash: [5, 4] });
    }
    for (const o of this.account.orders) {
      if (o.symbol !== symbol) continue;
      levels.push({
        price: o.limit,
        color: o.side === 'buy' ? '#26a69a' : '#ef5350',
        label: `${o.side} ${qtyText(o.qty)}`,
        dash: [2, 3],
      });
    }
    return levels;
  }

  marksFor(symbol) {
    return this.account.fills
      .filter((f) => f.symbol === symbol)
      .slice(0, 60)
      .map((f) => ({ t: f.barTime || f.at, price: f.price, side: f.side }));
  }

  paintPane(pane) {
    if (!pane?.chart) return;
    pane.chart.setTradeLevels(this.levelsFor(pane.symbol));
    pane.chart.setTradeMarks(this.marksFor(pane.symbol));
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  render() {
    if (!this.mounted) return;
    this.renderAccount();
    this.renderPositions();
    this.renderOrders();
    this.renderFills();
    this.renderTicket();
    this.drawSpark();
  }

  renderAccount() {
    const snap = this.snapshot();
    this.equityEl.textContent = money(snap.equity);
    this.cashEl.textContent = money(this.account.cash);
    this.realizedEl.textContent = signedMoney(this.account.realized);
    this.realizedEl.className = this.account.realized >= 0 ? 'up' : 'down';
    this.openEl.textContent = signedMoney(snap.open);
    this.openEl.className = snap.open >= 0 ? 'up' : 'down';
  }

  renderPositions() {
    const snap = this.snapshot();
    this.$('trPosCount').textContent = String(snap.rows.length);
    if (!snap.rows.length) {
      this.$('trPositions').innerHTML = '<div class="tr-empty">no open positions</div>';
      return;
    }
    this.$('trPositions').innerHTML = snap.rows
      .map(
        (p) => `
        <div class="tr-pos">
          <div class="tr-pos-main">
            <span class="tr-pos-sym">${esc(p.symbol)}</span>
            <span class="tr-pos-qty">${qtyText(p.qty)} @ ${fmtPrice(p.avg)}</span>
          </div>
          <div class="tr-pos-nums">
            <span class="${p.pnl >= 0 ? 'up' : 'down'}">${p.last == null ? '—' : signedMoney(p.pnl)}</span>
            <button class="tr-pos-close" data-close="${esc(p.symbol)}" title="Close position at market">close</button>
          </div>
        </div>`,
      )
      .join('');
  }

  renderOrders() {
    this.$('trOrdCount').textContent = String(this.account.orders.length);
    if (!this.account.orders.length) {
      this.$('trOrders').innerHTML = '<div class="tr-empty">none</div>';
      return;
    }
    this.$('trOrders').innerHTML = this.account.orders
      .map(
        (o) => `
        <div class="tr-ord">
          <span class="tr-side ${o.side}">${o.side === 'buy' ? 'BUY' : 'SELL'}</span>
          <span class="tr-ord-body">${qtyText(o.qty)} ${esc(o.symbol)}</span>
          <span class="tr-ord-px">@ ${fmtPrice(o.limit)}</span>
          <button class="tr-ord-x" data-cancel="${esc(o.id)}" title="Cancel order">×</button>
        </div>`,
      )
      .join('');
  }

  renderFills() {
    this.$('trFillCount').textContent = String(this.account.fills.length);
    if (!this.account.fills.length) {
      this.$('trFills').innerHTML = '<div class="tr-empty">no fills yet</div>';
      return;
    }
    this.$('trFills').innerHTML = this.account.fills
      .slice(0, 12)
      .map(
        (f) => `
        <div class="tr-fill">
          <span class="tr-side ${f.side}">${f.side === 'buy' ? 'B' : 'S'}</span>
          <span class="tr-fill-sym">${esc(f.symbol)}</span>
          <span class="tr-fill-qty">${qtyText(f.qty)} @ ${fmtPrice(f.price)}</span>
          <span class="tr-fill-time">${new Date(f.at).toLocaleTimeString('en-GB', { hour12: false })}</span>
        </div>`,
      )
      .join('');
  }

  renderTicket() {
    const sym = this.getSymbol() || '';
    this.syncSymbolText(sym);
    const price = this.priceOf(sym);
    this.lastEl.textContent = price == null ? '—' : fmtPrice(price);

    const qty = Number(this.qtyEl.value) || 0;
    const limit = this.type === 'limit' ? Number(this.limitEl.value) || 0 : 0;
    const px = this.type === 'limit' ? limit : price;
    const est = px ? px * qty : 0;
    this.estEl.textContent = money(est);

    const maxQty = price ? Math.floor(this.account.cash / price) : 0;
    this.maxEl.textContent = `max ${qtyText(maxQty)}`;

    const verb = this.side === 'buy' ? 'Buy' : 'Sell';
    const suffix = this.type === 'limit' ? (limit ? ` @ ${fmtPrice(limit)}` : '') : '';
    this.submitEl.textContent = `${verb} ${qtyText(qty)}${suffix}`;
    this.submitEl.classList.toggle('sell', this.side === 'sell');

    for (const b of this.$('trSide').querySelectorAll('[data-side]')) {
      b.classList.toggle('on', b.dataset.side === this.side);
      b.classList.toggle('sell', b.dataset.side === 'sell');
    }

    this.limitWrap.hidden = this.type !== 'limit';
    this.typeEl.value = this.type;

    const held = this.account.positions[sym]?.qty || 0;
    this.hintEl.classList.remove('warn');
    if (this.side === 'sell') {
      this.hintEl.textContent = held ? `holding ${qtyText(held)} ${sym}` : `no ${sym} position to sell`;
    } else if (this.hintEl.classList.contains('warn') === false) {
      this.hintEl.textContent = '';
    }
  }

  syncSymbolText(sym) {
    if (this.symEl.dataset.sym !== sym) {
      this.symEl.dataset.sym = sym;
      this.symEl.textContent = sym || '—';
    }
  }

  drawSpark() {
    const c = this.sparkEl;
    if (!c || !c.isConnected) return;
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(40, Math.round(rect.width || 236));
    const h = 34;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pts = this.account.equity.slice(-MAX_EQUITY);
    if (pts.length < 2) {
      const v = pts.length ? pts[0].v : this.account.startCash;
      ctx.strokeStyle = 'rgba(120,123,134,0.5)';
      ctx.beginPath();
      ctx.moveTo(0, h - 2);
      ctx.lineTo(w, h - 2);
      ctx.stroke();
      ctx.fillStyle = '#787b86';
      ctx.font = '9px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(`start ${money(v)}`, 2, 10);
      return;
    }

    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      min = Math.min(min, p.v);
      max = Math.max(max, p.v);
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;

    const x = (i) => (i / (pts.length - 1)) * (w - 2) + 1;
    const y = (v) => h - ((v - min) / (max - min)) * (h - 4) - 2;

    const lastVal = pts[pts.length - 1].v;
    const up = lastVal >= pts[0].v;
    ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(x(i), y(p.v));
      else ctx.lineTo(x(i), y(p.v));
    });
    ctx.stroke();

    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, up ? 'rgba(38,166,154,0.28)' : 'rgba(239,83,80,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.lineTo(x(pts.length - 1), h);
    ctx.lineTo(x(0), h);
    ctx.closePath();
    ctx.fill();
  }

  setSide(side) {
    if (side !== 'buy' && side !== 'sell') return;
    this.side = side;
    this.renderTicket();
  }
}
