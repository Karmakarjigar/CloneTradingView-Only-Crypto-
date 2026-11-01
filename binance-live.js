'use strict';
/**
 * TVFREE — Binance real-time market data (no API key, no npm packages)
 * -------------------------------------------------------------------
 * Replaces REST polling for crypto with Binance's public WebSocket.
 *
 *  - Ticks:   <symbol>@trade        -> every real trade, pushed instantly
 *  - Candles: <symbol>@kline_<int>  -> the live candle updates as it forms,
 *                                      with isClosed=true on the final update
 *
 * Requires Node 18+ (global fetch) / Node 22+ recommended (global WebSocket).
 * Binance disconnects each connection after ~24h and may drop it sooner;
 * this module reconnects automatically with backoff and re-subscribes.
 *
 * Usage in server.js:
 *   const { BinanceLive } = require('./binance-live');
 *   const live = new BinanceLive();
 *   live.on('tick',   ({ symbol, price, time }) => { ... });
 *   live.on('candle', ({ symbol, interval, candle, isClosed }) => { ... });
 *   live.subscribe('BTCUSDT', '1m');
 *   live.start();
 */
const { EventEmitter } = require('events');

// Main hosts first; the *.binance.vision hosts are Binance's official
// public-market-data-only hosts and are tried automatically if the main
// host is unreachable or geo-blocked (REST 451) from your network.
const WS_BASES = [
  'wss://stream.binance.com:9443/ws',
  'wss://data-stream.binance.vision/ws',
];
const REST_BASES = ['https://api.binance.com', 'https://data-api.binance.vision'];

// UI intervals are '1D' / '1W'; Binance stream and REST names are lowercase.
const normInterval = (interval) => String(interval || '1m').toLowerCase();

// Binance closes the whole socket if any stream name is invalid, so never
// subscribe to anything outside this set.
const BINANCE_INTERVALS = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w',
]);

class BinanceLive extends EventEmitter {
  constructor({ wsBases = WS_BASES } = {}) {
    super();
    this.wsBases = wsBases;
    this._wsIdx = 0;
    this.ws = null;
    this.subscriptions = new Map(); // symbol -> Set of intervals
    this.lastPrice = new Map();     // symbol -> number
    this.prevPrice = new Map();     // symbol -> number (for crossing checks)
    this.lastCandle = new Map();    // `${symbol}|${interval}` -> candle
    this._msgId = 1;
    this._backoffMs = 1000;
    this._stopped = true;
    this._reconnectTimer = null;
    this._healthyTimer = null;
    this._lastErrMsg = null;
    this._lastErrAt = 0;
  }

  /** Register a symbol/interval before or after start(). Safe to call twice. */
  subscribe(symbol, interval = '1m') {
    symbol = String(symbol).toUpperCase();
    interval = normInterval(interval);
    if (!BINANCE_INTERVALS.has(interval)) return this; // never poison the socket
    if (!this.subscriptions.has(symbol)) this.subscriptions.set(symbol, new Set());
    const isNew = !this.subscriptions.get(symbol).has(interval);
    this.subscriptions.get(symbol).add(interval);
    if (isNew && this.ws && this.ws.readyState === 1) {
      this._sendSubscribe(symbol, interval);
    }
    return this;
  }

  start() {
    this._stopped = false;
    this._connect();
    return this;
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._healthyTimer);
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
  }

  getPrice(symbol) {
    return this.lastPrice.get(String(symbol).toUpperCase()) ?? null;
  }

  getPrevPrice(symbol) {
    return this.prevPrice.get(String(symbol).toUpperCase()) ?? null;
  }

  unsubscribe(symbol, interval = '1m') {
    const sym = String(symbol || '').toUpperCase();
    interval = normInterval(interval);
    const set = this.subscriptions.get(sym);
    if (set) {
      set.delete(interval);
      if (!set.size) this.subscriptions.delete(sym);
    }
    const stream = `${String(symbol || '').toLowerCase()}@kline_${interval}`;
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [stream], id: this._msgId++ }));
    }
    return this;
  }

  /** Drop every subscription for a symbol (e.g. its alerts were all removed). */
  unsubscribeSymbol(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const set = this.subscriptions.get(sym);
    if (set) {
      for (const i of [...set]) this.unsubscribe(sym, i);
    }
    const lower = sym.toLowerCase();
    for (const stream of [`${lower}@trade`, `${lower}@kline_1m`, `${lower}@kline_5m`, `${lower}@kline_15m`, `${lower}@kline_30m`, `${lower}@kline_1h`, `${lower}@kline_4h`, `${lower}@kline_1d`, `${lower}@kline_1w`]) {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [stream], id: this._msgId++ }));
      }
    }
    return this;
  }

  _streamsFor(symbol, interval) {
    const s = symbol.toLowerCase();
    return [`${s}@trade`, `${s}@kline_${normInterval(interval)}`];
  }

  _sendSubscribe(symbol, interval) {
    this.ws.send(JSON.stringify({
      method: 'SUBSCRIBE',
      params: this._streamsFor(symbol, interval),
      id: this._msgId++,
    }));
  }

  _connect() {
    if (this._stopped) return;
    const url = this.wsBases[this._wsIdx % this.wsBases.length];
    this._wsIdx++; // rotate host on each retry, so a blocked host isn't retried forever
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      // Only reset the backoff once the socket has stayed up: Binance can
      // accept then immediately drop a connection, and resetting on 'open'
      // turns that into a ~1 s retry loop that floods the log.
      clearTimeout(this._healthyTimer);
      this._healthyTimer = setTimeout(() => {
        if (this.ws === ws && ws.readyState === 1) this._backoffMs = 1000;
      }, 5000);

      for (const [symbol, intervals] of this.subscriptions) {
        for (const interval of intervals) this._sendSubscribe(symbol, interval);
      }
      this.emit('open');
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._lastErrMsg = null; // traffic proves the socket is healthy
      if (!msg || msg.result === null || msg.id) return; // subscribe acks
      this._handle(msg);
    });

    const retry = () => {
      if (this._stopped) return;
      clearTimeout(this._healthyTimer);
      this.emit('close');
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => this._connect(), this._backoffMs);
      this._backoffMs = Math.min(this._backoffMs * 2, 30000);
    };
    ws.addEventListener('close', retry);
    ws.addEventListener('error', (e) => {
      const msg = e.message || String(e);
      const now = Date.now();
      // Same failure repeating: log once per 30 s instead of once per retry.
      if (msg !== this._lastErrMsg || now - this._lastErrAt > 30000) {
        this._lastErrMsg = msg;
        this._lastErrAt = now;
        this.emit('error', msg);
      }
      try { ws.close(); } catch {} // 'close' handler schedules the reconnect
    });
  }

  _handle(msg) {
    if (msg.e === 'trade') {
      const symbol = msg.s;
      const price = Number(msg.p);
      if (!Number.isFinite(price)) return;
      this.prevPrice.set(symbol, this.lastPrice.get(symbol) ?? price);
      this.lastPrice.set(symbol, price);
      this.emit('tick', {
        symbol,
        price,
        prevPrice: this.prevPrice.get(symbol),
        qty: Number(msg.q),
        time: msg.T, // ms epoch
        tradeId: msg.t,
      });
    }

    if (msg.e === 'kline') {
      const k = msg.k;
      const candle = {
        time: k.t,                 // ms epoch, candle open time
        timeSec: Math.floor(k.t / 1000), // for Lightweight Charts
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
      };
      this.lastCandle.set(`${k.s}|${k.i}`, candle);
      this.emit('candle', {
        symbol: k.s,
        interval: k.i,
        candle,
        isClosed: k.x === true,
      });
    }
  }
}

/**
 * Seed a chart with history over REST (public, no key).
 * Returns candles oldest -> newest:
 *   [{ time, timeSec, open, high, low, close, volume }]
 */
async function getHistory(symbol = 'BTCUSDT', interval = '1m', limit = 500) {
  const qs = `symbol=${encodeURIComponent(
    String(symbol).toUpperCase()
  )}&interval=${encodeURIComponent(normInterval(interval))}&limit=${limit}`;
  let lastErr;
  let rows = null;
  for (const base of REST_BASES) {
    try {
      const res = await fetch(`${base}/api/v3/klines?${qs}`);
      if (!res.ok) { lastErr = new Error(`Binance history ${res.status} via ${base}`); continue; }
      rows = await res.json();
      break;
    } catch (e) { lastErr = e; }
  }
  if (!rows) throw lastErr || new Error('Binance history failed on all hosts');
  return rows.map((r) => ({
    time: r[0],
    timeSec: Math.floor(r[0] / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}

module.exports = { BinanceLive, getHistory };
