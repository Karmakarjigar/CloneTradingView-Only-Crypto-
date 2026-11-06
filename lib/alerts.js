'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DATA_DIR = process.env.TVFREE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'alerts.json');
const LOG_LIMIT = 200;

const DEFAULT_SETTINGS = {
  webhookUrl: '',
  telegramToken: '',
  telegramChatId: '',
};

function uid() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function cleanSymbol(value) {
  return String(value || '').trim().toUpperCase().slice(0, 32);
}

// Crypto-only build: alert symbols must be Binance-style spot pairs.
const CRYPTO_PAIR_RE = /^(?:BINANCE:)?[A-Z0-9]{2,10}(USDT|USDC|BUSD|FDUSD)$/i;

function isCryptoSymbol(value) {
  return CRYPTO_PAIR_RE.test(String(value || '').trim().toUpperCase());
}

/**
 * Durable alert store. Evaluation runs in the server process, so rules keep
 * firing when no browser tab is open. UI clients receive `fired` events and
 * read the same store over HTTP.
 */
class AlertStore extends EventEmitter {
  constructor() {
    super();
    this.alerts = [];
    this.log = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (Array.isArray(raw.alerts)) this.alerts = raw.alerts;
      if (Array.isArray(raw.log)) this.log = raw.log.slice(0, LOG_LIMIT);
      if (raw.settings && typeof raw.settings === 'object') {
        this.settings = { ...DEFAULT_SETTINGS, ...raw.settings };
      }
    } catch {
      /* first run or unreadable file: start empty */
    }
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        FILE,
        JSON.stringify({ alerts: this.alerts, log: this.log, settings: this.settings }, null, 2),
      );
    } catch (err) {
      console.error('alerts: could not persist', err.message);
    }
  }

  /* ---------------- CRUD ---------------- */

  list() {
    return this.alerts;
  }

  add({ symbol, condition = 'above', price, note = '' }) {
    const sym = cleanSymbol(symbol);
    const level = Number(price);
    const cond = ['above', 'below', 'crossing'].includes(condition) ? condition : 'above';
    if (!sym) return { error: 'symbol is required' };
    if (!isCryptoSymbol(sym)) return { error: 'Crypto-only build: only crypto pairs are supported (e.g. BTCUSDT, ETHUSDT, SOLUSDT)' };
    if (!Number.isFinite(level) || level <= 0) return { error: 'price must be a positive number' };

    const alert = {
      id: uid(),
      symbol: sym,
      condition: cond,
      price: level,
      note: String(note || '').slice(0, 200),
      createdAt: Date.now(),
      active: true,
      lastSeen: null,
      triggeredAt: null,
      triggerPrice: null,
    };
    this.alerts.unshift(alert);
    this._save();
    this.emit('changed', alert);
    return alert;
  }

  remove(id) {
    const before = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.id !== id);
    if (this.alerts.length !== before) {
      this._save();
      this.emit('changed', null);
    }
    return this.alerts.length !== before;
  }

  rearm(id) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return null;
    a.active = true;
    a.triggeredAt = null;
    a.triggerPrice = null;
    a.lastSeen = null;
    this._save();
    this.emit('changed', a);
    return a;
  }

  clearLog() {
    this.log = [];
    this._save();
  }

  /**
   * Mark an alert fired (from the live tick engine): deactivate it, stamp the
   * trigger, and re-arm the crossing watch. Emits `fired` so SSE + delivery run.
   */
  acknowledge(id, triggerPrice) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return false;
    a.active = false;
    a.triggeredAt = Date.now();
    a.triggerPrice = Number(triggerPrice);
    a.lastSeen = Number(triggerPrice);
    this._save();
    this.emit('fired', a);
    return true;
  }

  /* ---------------- settings ---------------- */

  publicSettings() {
    const s = this.settings;
    let host = '';
    if (s.webhookUrl) {
      try {
        host = new URL(s.webhookUrl).host;
      } catch {
        host = 'invalid URL';
      }
    }
    return {
      webhookSet: Boolean(s.webhookUrl),
      webhookHost: host,
      telegramSet: Boolean(s.telegramToken && s.telegramChatId),
      telegramChatSet: Boolean(s.telegramChatId),
    };
  }

  updateSettings(patch = {}) {
    if (patch.clear) {
      this.settings = { ...DEFAULT_SETTINGS };
    } else {
      if (typeof patch.webhookUrl === 'string' && patch.webhookUrl.trim()) {
        this.settings.webhookUrl = patch.webhookUrl.trim().slice(0, 500);
      }
      if (typeof patch.telegramToken === 'string' && patch.telegramToken.trim()) {
        this.settings.telegramToken = patch.telegramToken.trim().slice(0, 200);
      }
      if (typeof patch.telegramChatId === 'string' && patch.telegramChatId.trim()) {
        this.settings.telegramChatId = patch.telegramChatId.trim().slice(0, 80);
      }
    }
    this._save();
    return this.publicSettings();
  }

  /* ---------------- evaluation ---------------- */

  /**
   * @param {Array<{symbol:string, price:number, error?:string}>} quotes
   * @returns {number} how many alerts fired
   */
  evaluate(quotes) {
    const bySymbol = new Map();
    for (const q of quotes) {
      if (q && q.symbol && Number.isFinite(q.price)) bySymbol.set(String(q.symbol).toUpperCase(), q);
    }

    let fired = 0;

    for (const a of this.alerts) {
      if (!a.active) continue;
      const q = bySymbol.get(a.symbol);
      if (!q) continue;
      const now = q.price;
      let hit = false;

      if (a.condition === 'above') {
        hit = now >= a.price;
      } else if (a.condition === 'below') {
        hit = now <= a.price;
      } else if (a.lastSeen != null) {
        hit = (a.lastSeen < a.price && now >= a.price) || (a.lastSeen > a.price && now <= a.price);
      }

      a.lastSeen = now;

      if (hit) {
        a.active = false;
        a.triggeredAt = Date.now();
        a.triggerPrice = now;
        fired += 1;

        const entry = {
          at: a.triggeredAt,
          id: a.id,
          symbol: a.symbol,
          condition: a.condition,
          price: a.price,
          triggerPrice: now,
          note: a.note,
        };
        this.log.unshift(entry);
        this.log = this.log.slice(0, LOG_LIMIT);
        this.emit('fired', a);
      }
    }

    // Only persist when something actually fired — ticks arrive far more often
    // than alerts fire, and rewriting the store file on every tick would thrash.
    if (fired) this._save();
    return fired;
  }

  activeSymbols() {
    return [...new Set(this.alerts.filter((a) => a.active).map((a) => a.symbol))];
  }
}

module.exports = new AlertStore();
module.exports.AlertStore = AlertStore;
