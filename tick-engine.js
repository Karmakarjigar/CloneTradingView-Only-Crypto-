'use strict';
/**
 * TVFREE — Tick engine: alerts + paper fills evaluated on EVERY tick.
 * -------------------------------------------------------------------
 * This replaces the old 20s poll:
 *   old: setInterval(checkAlerts, 20000)  +  setInterval(checkFills, 20000)
 *   new: live.on('tick', tick => engine.onTick(tick))
 *
 * Crossing conditions need the previous price, which BinanceLive
 * tracks for you (tick.prevPrice).
 *
 * Alerts:   price-above | price-below | crosses-above | crosses-below
 *           once=true (default) fires one time, like TV's "Once Per Bar Close"
 *           style one-shot alerts; set once=false for repeating alerts.
 *
 * Paper:    long-only spot, matching TVFREE's current scope.
 *           - market buy/sell fills immediately at the latest tick price
 *           - limit buy fills when a tick trades at or below the limit
 *           - limit sell fills when a tick trades at or above the limit
 *           Fill price is the tick price that crossed (no fees/slippage
 *           modelled — same honest limitation as the current build).
 */
const { EventEmitter } = require('events');

class TickEngine extends EventEmitter {
  constructor() {
    super();
    this.alerts = new Map(); // id -> alert
    this.orders = new Map(); // id -> order
    this.lastPrice = new Map();
  }

  addAlert({ id, symbol, condition, price, once = true }) {
    const alert = {
      id, symbol: String(symbol).toUpperCase(), condition,
      price: Number(price), once, active: true,
    };
    this.alerts.set(id, alert);
    return alert;
  }

  removeAlert(id) { this.alerts.delete(id); }

  addLimitOrder({ id, symbol, side, qty, limitPrice }) {
    const order = {
      id, symbol: String(symbol).toUpperCase(),
      side, // 'buy' | 'sell'
      type: 'limit',
      qty: Number(qty),
      limitPrice: Number(limitPrice),
      status: 'open',
    };
    this.orders.set(id, order);
    return order;
  }

  /** Market order: fills right now at the last known tick, if we have one. */
  addMarketOrder({ id, symbol, side, qty }) {
    symbol = String(symbol).toUpperCase();
    const price = this.lastPrice.get(symbol);
    const order = { id, symbol, side, type: 'market', qty: Number(qty), status: 'open' };
    this.orders.set(id, order);
    if (price != null) this._fill(order, price, Date.now());
    return order;
  }

  cancelOrder(id) {
    const o = this.orders.get(id);
    if (o && o.status === 'open') o.status = 'cancelled';
  }

  onTick({ symbol, price, prevPrice, time }) {
    this.lastPrice.set(symbol, price);
    this._checkAlerts(symbol, price, prevPrice ?? price, time);
    this._checkOrders(symbol, price, time);
  }

  _checkAlerts(symbol, price, prevPrice, time) {
    for (const a of this.alerts.values()) {
      if (!a.active || a.symbol !== symbol) continue;
      let hit = false;
      switch (a.condition) {
        case 'price-above':   hit = price > a.price; break;
        case 'price-below':   hit = price < a.price; break;
        case 'crosses-above': hit = prevPrice <= a.price && price > a.price; break;
        case 'crosses-below': hit = prevPrice >= a.price && price < a.price; break;
      }
      if (hit) {
        if (a.once) a.active = false;
        this.emit('alert', { ...a, triggerPrice: price, time });
      }
    }
  }

  _checkOrders(symbol, price, time) {
    for (const o of this.orders.values()) {
      if (o.status !== 'open' || o.symbol !== symbol || o.type !== 'limit') continue;
      const crossed =
        (o.side === 'buy' && price <= o.limitPrice) ||
        (o.side === 'sell' && price >= o.limitPrice);
      if (crossed) this._fill(o, price, time);
    }
  }

  _fill(order, price, time) {
    order.status = 'filled';
    order.fillPrice = price;
    order.fillTime = time;
    this.emit('fill', { ...order });
  }
}

module.exports = { TickEngine };
