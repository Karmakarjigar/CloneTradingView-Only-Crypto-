/**
 * Link groups — the colour-coded chart linking from TradingView Desktop.
 *
 * Behaviour mirrors the desktop main process (src/linking/*):
 *  - each group owns a channel config: symbol / interval / time / dateRange
 *  - symbol is the only channel on by default
 *  - only the focused chart broadcasts
 *  - broadcasts are debounced 500 ms and merged into one values tuple
 *  - `time` is dropped when `dateRange` is also on (time is the fallback)
 *  - time / dateRange are never persisted across reloads
 * Crosshair sync is a separate app-wide setting, not a link channel.
 */

export const LINK_GROUPS = [
  { id: 'a', color: '#2962ff', label: 'Blue' },
  { id: 'b', color: '#f0a029', label: 'Orange' },
  { id: 'c', color: '#26a69a', label: 'Green' },
  { id: 'd', color: '#ef5350', label: 'Red' },
];

export const LINK_CHANNELS = [
  { id: 'symbol', label: 'Symbol' },
  { id: 'interval', label: 'Interval' },
  { id: 'time', label: 'Time' },
  { id: 'dateRange', label: 'Date range' },
];

const CHANNEL_IDS = LINK_CHANNELS.map((c) => c.id);
const PERSISTED_CHANNELS = ['symbol', 'interval'];
const TRANSIENT_CHANNELS = new Set(['time', 'dateRange']);
const DEBOUNCE_MS = 500;

export const DEFAULT_LINK_CHANNELS = Object.freeze({
  symbol: true,
  interval: false,
  time: false,
  dateRange: false,
});

const STORAGE_KEY = 'tvfree.links.v1';

export class LinkBus {
  constructor() {
    this.tabGroup = new Map();
    this.configs = new Map(); // groupId -> { symbol, interval, time, dateRange }
    this.crosshairSync = true;
    this.listeners = new Set();
    this._pending = new Map(); // sourceTabId -> { groupId, values, timer }
    this._restore();
  }

  _restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const [tabId, groupId] of Object.entries(raw.tabGroup || {})) {
        if (this.isGroup(groupId)) this.tabGroup.set(tabId, groupId);
      }
      for (const [groupId, stored] of Object.entries(raw.channels || {})) {
        if (!this.isGroup(groupId)) continue;
        this.configs.set(groupId, this._configFrom(stored));
      }
      if (typeof raw.crosshairSync === 'boolean') this.crosshairSync = raw.crosshairSync;
    } catch {
      /* ignore corrupt state */
    }
  }

  /** Accept both the old array form and the current object form. */
  _configFrom(stored) {
    const cfg = { ...DEFAULT_LINK_CHANNELS };
    if (Array.isArray(stored)) {
      for (const id of stored) {
        if (CHANNEL_IDS.includes(id) && !TRANSIENT_CHANNELS.has(id)) cfg[id] = true;
      }
    } else if (stored && typeof stored === 'object') {
      for (const id of PERSISTED_CHANNELS) {
        if (typeof stored[id] === 'boolean') cfg[id] = stored[id];
      }
    }
    return cfg;
  }

  isGroup(groupId) {
    return LINK_GROUPS.some((g) => g.id === groupId);
  }

  _persist() {
    try {
      const channels = {};
      for (const [groupId, cfg] of this.configs) {
        const out = {};
        for (const id of PERSISTED_CHANNELS) out[id] = cfg[id] === true;
        channels[groupId] = out;
      }
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          tabGroup: Object.fromEntries(this.tabGroup),
          channels,
          crosshairSync: this.crosshairSync,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  colorOf(groupId) {
    const g = LINK_GROUPS.find((x) => x.id === groupId);
    return g ? g.color : null;
  }

  groupOf(tabId) {
    return this.tabGroup.get(tabId) || null;
  }

  setGroup(tabId, groupId) {
    if (this.isGroup(groupId)) this.tabGroup.set(tabId, groupId);
    else this.tabGroup.delete(tabId);
    this._cancel(tabId);
    this._persist();
    this._emit({ kind: 'group', tabId });
  }

  /** Cycle: none -> blue -> orange -> green -> red -> none */
  cycleGroup(tabId) {
    const order = [null, ...LINK_GROUPS.map((g) => g.id)];
    const current = this.groupOf(tabId);
    const next = order[(order.indexOf(current) + 1) % order.length];
    this.setGroup(tabId, next);
    return next;
  }

  /** Live channel config for a group (created on first use). */
  configOf(groupId) {
    let cfg = this.configs.get(groupId);
    if (!cfg) {
      cfg = { ...DEFAULT_LINK_CHANNELS };
      this.configs.set(groupId, cfg);
    }
    return cfg;
  }

  getChannels(groupId) {
    return { ...this.configOf(groupId) };
  }

  enabledChannels(groupId) {
    const cfg = this.configOf(groupId);
    return CHANNEL_IDS.filter((id) => cfg[id] === true);
  }

  setChannel(groupId, channel, enabled) {
    if (!CHANNEL_IDS.includes(channel)) return;
    const cfg = this.configOf(groupId);
    cfg[channel] = Boolean(enabled);
    // Time/dateRange stay out of storage — see PERSISTED_CHANNELS.
    this._persist();
    this._emit({ kind: 'channels', groupId });
  }

  toggleChannel(groupId, channel) {
    const cfg = this.configOf(groupId);
    this.setChannel(groupId, channel, !cfg[channel]);
  }

  isEnabled(groupId, channel) {
    return this.configOf(groupId)[channel] === true;
  }

  getCrosshairSync() {
    return this.crosshairSync;
  }

  setCrosshairSync(enabled) {
    this.crosshairSync = Boolean(enabled);
    this._persist();
    this._emit({ kind: 'channels', groupId: null });
  }

  /**
   * Broadcast one channel from a chart. Returns true when the value was
   * queued (i.e. the group listens to that channel and the chart is focused).
   */
  publish(sourceTabId, channel, payload, { focused = true } = {}) {
    const groupId = this.groupOf(sourceTabId);
    if (!groupId) return false;
    const cfg = this.configOf(groupId);
    if (cfg[channel] !== true) return false;
    if (!focused) return false;
    if (channel === 'time' && cfg.dateRange) return false;

    const pending = this._pending.get(sourceTabId) || { groupId, values: {}, timer: null };
    pending.groupId = groupId;
    pending.values[channel] = payload;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.flush(sourceTabId), DEBOUNCE_MS);
    this._pending.set(sourceTabId, pending);
    return true;
  }

  /** Crosshair sync is app-wide (not a link channel) but still group-scoped. */
  publishCrosshair(sourceTabId, time) {
    if (!this.crosshairSync) return false;
    const groupId = this.groupOf(sourceTabId);
    if (!groupId) return false;
    this._emit({ kind: 'change', groupId, values: { crosshair: time }, sourceTabId });
    return true;
  }

  /** Flush pending broadcasts immediately (one tab, or all when omitted). */
  flush(sourceTabId) {
    const ids = sourceTabId ? [sourceTabId] : [...this._pending.keys()];
    for (const id of ids) {
      const pending = this._pending.get(id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this._pending.delete(id);

      const groupId = this.groupOf(id);
      if (!groupId || groupId !== pending.groupId) continue;

      const cfg = this.configOf(groupId);
      const values = {};
      for (const [channel, value] of Object.entries(pending.values)) {
        if (cfg[channel] !== true || value === undefined) continue;
        if (channel === 'time' && cfg.dateRange) continue;
        values[channel] = value;
      }
      if (!Object.keys(values).length) continue;
      this._emit({ kind: 'change', groupId, values, sourceTabId: id });
    }
  }

  pendingCount() {
    return this._pending.size;
  }

  _cancel(tabId) {
    const pending = this._pending.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pending.delete(tabId);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(evt) {
    for (const fn of this.listeners) fn(evt);
  }
}
