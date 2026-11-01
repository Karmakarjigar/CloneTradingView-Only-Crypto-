/**
 * Local app settings. Mirrors the desktop settings that change how the shell
 * behaves, not how charts are drawn.
 *
 * `saveSymbolInterval` is the one that matters for session restore: when off,
 * a tab keeps its layout/indicators but reopens on the default symbol.
 */

const KEY = 'tvfree.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  saveSymbolInterval: true,
  alertVolume: 100,
  alertSound: 'alert',
});

let cache = null;

export function getSettings() {
  if (cache) return cache;
  cache = { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (raw && typeof raw === 'object') {
      if (typeof raw.saveSymbolInterval === 'boolean') cache.saveSymbolInterval = raw.saveSymbolInterval;
      if (Number.isFinite(raw.alertVolume)) cache.alertVolume = Math.max(0, Math.min(100, raw.alertVolume));
      if (typeof raw.alertSound === 'string') cache.alertSound = raw.alertSound;
    }
  } catch {
    /* ignore corrupt settings */
  }
  return cache;
}

export function setSetting(key, value) {
  const cfg = getSettings();
  cfg[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
  return cfg;
}

export function saveSymbolInterval() {
  return getSettings().saveSymbolInterval !== false;
}
