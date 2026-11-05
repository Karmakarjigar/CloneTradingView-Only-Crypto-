/**
 * Drawing storage.
 *
 * Drawings are kept per symbol so switching charts never mixes them. The
 * v1 format (flat t1/p1/t2/p2 objects) is migrated on first read and the old
 * key is left untouched as a fallback.
 */

const SETTINGS_KEY = 'tvfree.drawings.settings.v1';
const CLIPBOARD_KEY = 'tvfree.drawings.clipboard.v1';
const V2_PREFIX = 'tvfree.drawings.v2:';
const V1_PREFIX = 'tvfree.drawings.v1:';

const TYPE_MAP = {
  trend: 'trend',
  hline: 'hline',
  rect: 'rectangle',
  fib: 'fibRetracement',
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function migrateShape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw.points)) return raw;

  const type = TYPE_MAP[raw.type] || raw.type || 'polyline';
  const points = [];
  if (Number.isFinite(raw.t1) && Number.isFinite(raw.p1)) points.push({ t: raw.t1, p: raw.p1 });
  if (Number.isFinite(raw.t2) && Number.isFinite(raw.p2)) points.push({ t: raw.t2, p: raw.p2 });
  if (!points.length) return null;

  const style = {};
  if (raw.color) style.color = raw.color;
  if (raw.width) style.width = raw.width;
  if (raw.lineStyle != null) style.lineStyle = raw.lineStyle;
  if (raw.fillOpacity != null) style.fillOpacity = raw.fillOpacity;

  return {
    id: raw.id || `mig${Math.random().toString(36).slice(2, 9)}`,
    type,
    points,
    ...style,
    locked: Boolean(raw.locked),
    hidden: Boolean(raw.hidden),
  };
}

export class DrawingStore {
  key(symbol) {
    return `${V2_PREFIX}${symbol || ''}`;
  }

  load(symbol) {
    const key = this.key(symbol);
    const raw = readJson(key, null);
    if (Array.isArray(raw)) return raw.map(migrateShape).filter(Boolean);

    // First run with the v2 key: migrate the old flat format.
    const legacy = readJson(`${V1_PREFIX}${symbol || ''}`, null);
    if (!Array.isArray(legacy)) return [];
    const migrated = legacy.map(migrateShape).filter(Boolean);
    if (migrated.length) this.save(symbol, migrated);
    return migrated;
  }

  save(symbol, shapes) {
    return writeJson(this.key(symbol), shapes);
  }

  loadSettings() {
    const s = readJson(SETTINGS_KEY, {}) || {};
    return {
      magnet: s.magnet === 'weak' || s.magnet === 'strong' ? s.magnet : 'off',
      stay: Boolean(s.stay),
      hiddenAll: Boolean(s.hiddenAll),
      lockedAll: Boolean(s.lockedAll),
      lastTool: typeof s.lastTool === 'string' ? s.lastTool : 'trend',
      lastByGroup: s.lastByGroup && typeof s.lastByGroup === 'object' ? s.lastByGroup : {},
      stickerEmoji: typeof s.stickerEmoji === 'string' ? s.stickerEmoji : '😀',
    };
  }

  saveSettings(settings) {
    return writeJson(SETTINGS_KEY, settings);
  }

  loadClipboard() {
    const list = readJson(CLIPBOARD_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  saveClipboard(list) {
    return writeJson(CLIPBOARD_KEY, list);
  }
}

export const drawingStore = new DrawingStore();
export const DRAWING_STORAGE_KEYS = { SETTINGS_KEY, CLIPBOARD_KEY, V2_PREFIX, V1_PREFIX };
