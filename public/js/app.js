import { Workspace, LAYOUTS, layoutDef } from './workspace.js';
import { LinkBus, LINK_GROUPS, LINK_CHANNELS } from './linking.js';
import { AlertCenter } from './alerts.js';
import { TradeDesk } from './trading.js';
import { IND, INTERVALS, DEFAULT_INDICATORS } from './indicator-defs.js';
import { getSettings, setSetting, saveSymbolInterval } from './settings.js';
import { buildDrawbar as createDrawbar } from './drawbar.js';
import { drawingStore, toolDef, TOOL_BY_ID } from './drawings.js';
import { fmtPrice, esc, uid, debounce } from './util.js';

const $ = (id) => document.getElementById(id);

const WS_KEY = 'tvfree.workspaces.v2';
const WATCHLIST_KEY = 'tvfree.watchlist.v1';
const PRESETS_KEY = 'tvfree.layouts.v1';

const DEFAULT_WATCHLIST = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT',
];

function isCryptoSymbol(s) {
  const sym = String(s || '').trim().replace(/^BINANCE:/i, '').toUpperCase();
  if (!sym) return false;
  if (sym.startsWith('BINANCE:')) return true;
  if (/(USDT|USDC|BUSD|FDUSD)$/.test(sym)) return true;
  return /^(BTC|ETH|BNB)[A-Z0-9]{1,8}$/.test(sym);
}

const links = new LinkBus();

const state = {
  workspaces: [],
  activeWorkspaceId: null,
  watchlist: (loadJson(WATCHLIST_KEY, DEFAULT_WATCHLIST) || []).filter(isCryptoSymbol),
  quotes: new Map(),
};

let tool = null;
let drawbar = null;
const closedStack = [];
let searchTimer = null;
let searchRows = [];
let searchActive = -1;

const canvasHost = $('chartwrap');
const tabsEl = $('tabs');
const inputEl = $('symbolInput');
const resultsEl = $('searchResults');
const indicatorMenu = $('indicatorMenu');

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function boot() {
  buildIntervals();
  buildDrawbar();
  buildIndicatorMenu();
  bindSearch();
  bindToolbar();
  bindTabs();
  bindLayoutMenu();
  bindKeyboard();
  bindWatchlist();
  bindLinkBus();
  bindSideTabs();
  startClock();

  const restored = restoreWorkspaces();
  for (const cfg of restored.workspaces) createWorkspace(cfg, { activate: false });

  const preferred = restored.active;
  const first = state.workspaces.find((w) => w.id === preferred) || state.workspaces[0];
  activateWorkspace(first.id);

  renderTabs();
  renderWatchlist();
  refreshQuotes();
  setInterval(tick, 20000);

  // Alerts live on the server; pull them once and then listen over SSE.
  alerts.init().catch(() => setStatus('warn', 'alerts: server unreachable'));
}

function restoreWorkspaces() {
  const saved = loadJson(WS_KEY, null);
  if (saved && Array.isArray(saved.workspaces) && saved.workspaces.length) {
    return saved;
  }

  // Migrate v1 tabs: one tab became one single-chart workspace.
  const v1 = loadJson('tvfree.tabs.v1', null);
  if (v1 && Array.isArray(v1.tabs) && v1.tabs.length) {
    const workspaces = v1.tabs.map((t) => ({
      id: uid('ws'),
      layout: '1x1',
      activePaneId: t.id,
      panes: [{
        id: t.id,
        symbol: t.symbol,
        interval: t.interval,
        indicators: t.indicators,
      }],
    }));
    const active = workspaces.find((w) => w.panes[0].id === v1.active)?.id || null;
    return { active, workspaces };
  }

  return {
    active: null,
    workspaces: [{
      id: uid('ws'),
      layout: '1x1',
      panes: [{
        symbol: loadJson('tvfree.symbol', 'BTCUSDT'),
        interval: loadJson('tvfree.interval', '1D'),
        indicators: loadJson('tvfree.indicators', DEFAULT_INDICATORS),
      }],
    }],
  };
}

/* ------------------------------------------------------------------ *
 * Storage helpers
 * ------------------------------------------------------------------ */

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const persistWorkspaces = debounce(() => {
  const keepSymbol = saveSymbolInterval();
  saveJson(WS_KEY, {
    version: 2,
    active: state.activeWorkspaceId,
    workspaces: state.workspaces.map((w) => {
      const ser = w.serialize();
      if (!keepSymbol) {
        // Desktop's saveSymbolInterval=false keeps the tab, drops the
        // symbol/interval it was showing.
        for (const p of ser.panes) {
          delete p.symbol;
          delete p.interval;
        }
      }
      return ser;
    }),
  });
}, 260);

/* ------------------------------------------------------------------ *
 * Workspaces
 * ------------------------------------------------------------------ */

function workspaceOfPane(pane) {
  return state.workspaces.find((w) => w.panes.includes(pane)) || null;
}

function activeWorkspace() {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId) || null;
}

function activePane() {
  return activeWorkspace()?.activePane() || null;
}

/**
 * Desktop only broadcasts link values from the focused chart
 * (tvd-tab-linking-agent: `shouldUpdateValues()` requires focus).
 */
function paneFocused(pane) {
  const ws = workspaceOfPane(pane);
  return Boolean(ws && ws.el.classList.contains('active') && ws.activePane() === pane);
}

const services = {
  onHover: (pane, time) => links.publishCrosshair(pane.id, time),
  onViewChange: (pane, times) => {
    if (!times || !Number.isFinite(times.from) || !Number.isFinite(times.to)) return;
    const focused = paneFocused(pane);
    // Same tuple the desktop sends: single `time` plus an explicit dateRange.
    // LinkBus drops `time` whenever dateRange is enabled.
    links.publish(pane.id, 'time', times.from, { focused });
    links.publish(pane.id, 'dateRange', { startTime: times.from, endTime: times.to }, { focused });
  },
  onSymbolChange: (pane, symbol) => {
    links.publish(pane.id, 'symbol', symbol, { focused: paneFocused(pane) });
    startLive(pane);
    trading.paintPane(pane);
    renderTabs();
    if (pane === activePane()) {
      syncChrome();
      trading.syncSymbol();
    }
    persistWorkspaces();
  },
  onIntervalChange: (pane, interval) => {
    links.publish(pane.id, 'interval', interval, { focused: paneFocused(pane) });
    startLive(pane);
    renderTabs();
    if (pane === activePane()) syncChrome();
    persistWorkspaces();
  },
  onPaneCreated: (pane, source) => {
    // New cells inherit the source chart's link group so a 2×2 starts synced.
    const group = links.groupOf(source.id);
    if (group) links.setGroup(pane.id, group);
    pane.renderLink();
    applyDrawingSettingsToPane(pane);
  },
  onFocus: (pane) => focusPane(pane),
  onStatus: (kind, text) => setStatus(kind, text),
  onDirty: () => {
    renderTabs();
    persistWorkspaces();
  },
  onLoaded: (pane, payload, ms) => {
    startLive(pane);
    if (pane === activePane()) syncChrome(payload, ms);
    trading.paintPane(pane);
    if (pane === activePane()) trading.syncSymbol();
    renderTabs();
    persistWorkspaces();
  },
  onToolConsumed: () => {
    if (drawingStore.loadSettings().stay) drawbar?.refresh();
    else setTool(null);
  },
  onDrawingChange: (pane) => {
    if (pane === activePane()) drawbar?.refresh();
  },
  getStickerEmoji: () => drawingStore.loadSettings().stickerEmoji,
  linkInfo: (paneId) => {
    const group = links.groupOf(paneId);
    const def = LINK_GROUPS.find((g) => g.id === group);
    return { group, color: def ? def.color : null, label: def ? def.label : '' };
  },
  onCycleLink: (pane) => {
    links.cycleGroup(pane.id);
    renderTabs();
    updateLinkState();
    persistWorkspaces();
  },
};

/** Strip the fields the desktop stops restoring when saveSymbolInterval is off. */
function paneConfigForRestore(cfg) {
  const out = { ...(cfg || {}) };
  if (!saveSymbolInterval()) {
    delete out.symbol;
    delete out.interval;
  }
  return out;
}

function createWorkspace(cfg, { activate = false } = {}) {
  const panes = (cfg.panes && cfg.panes.length ? cfg.panes : [{
    symbol: 'BTCUSDT',
    interval: '1D',
    indicators: DEFAULT_INDICATORS,
  }]).map(paneConfigForRestore);

  const ws = new Workspace({
    id: cfg.id || uid('ws'),
    layout: cfg.layout || '1x1',
    panes,
    activePaneId: cfg.activePaneId || null,
    host: canvasHost,
    services,
  });

  state.workspaces.push(ws);
  if (activate) activateWorkspace(ws.id);
  return ws;
}

function activateWorkspace(id) {
  const next = state.workspaces.find((w) => w.id === id);
  if (!next) return;

  for (const w of state.workspaces) if (w !== next) w.deactivate();
  state.activeWorkspaceId = id;
  next.activate();

  const pane = next.activePane();
  if (pane && tool) pane.setTool(tool);
  applyDrawingSettings();
  drawbar?.refresh();
  startLive(pane);

  renderTabs();
  syncChrome();
  syncIndicatorMenu();
  renderLayoutLabel();
  trading.syncSymbol();
  persistWorkspaces();
}

function closeWorkspace(id, { remember = true } = {}) {
  if (state.workspaces.length <= 1) return;
  const idx = state.workspaces.findIndex((w) => w.id === id);
  if (idx < 0) return;
  const wasActive = state.activeWorkspaceId === id;
  const ws = state.workspaces[idx];

  if (remember) {
    closedStack.unshift({
      cfg: ws.serialize(),
      groups: ws.panes.map((p) => ({ index: ws.panes.indexOf(p), group: links.groupOf(p.id) })),
    });
    if (closedStack.length > 10) closedStack.length = 10;
  }

  for (const p of ws.panes) links.setGroup(p.id, null);
  ws.dispose();
  state.workspaces.splice(idx, 1);

  if (wasActive) {
    const fallback = state.workspaces[Math.max(0, idx - 1)];
    state.activeWorkspaceId = fallback.id;
    fallback.activate();
  }
  renderTabs();
  syncChrome();
  syncIndicatorMenu();
  renderLayoutLabel();
  persistWorkspaces();
}

/** Ctrl+Shift+T — reopen the most recently closed tab. */
function reopenWorkspace() {
  const entry = closedStack.shift();
  if (!entry) {
    setStatus('warn', 'no closed tab to reopen');
    return;
  }
  const cfg = JSON.parse(JSON.stringify(entry.cfg));
  cfg.id = uid('ws');
  const idMap = new Map();
  cfg.panes = (cfg.panes || []).map((p) => {
    const next = { ...p, id: uid('pane') };
    idMap.set(p.id, next.id);
    return next;
  });
  cfg.activePaneId = idMap.get(entry.cfg.activePaneId) || cfg.panes[0]?.id || null;

  const ws = createWorkspace(cfg, { activate: true });
  for (const g of entry.groups) {
    const pane = ws.panes[g.index];
    if (pane && g.group) links.setGroup(pane.id, g.group);
  }
  for (const p of ws.panes) p.renderLink();
  updateLinkState();
  setStatus('ok', `reopened tab (${ws.panes.length} chart${ws.panes.length === 1 ? '' : 's'})`);
}

/** Ctrl+U — duplicate the active tab. */
function duplicateWorkspace() {
  const ws = activeWorkspace();
  if (!ws) return;
  const cfg = ws.serialize();
  cfg.id = uid('ws');
  const groups = ws.panes.map((p, i) => ({ index: i, group: links.groupOf(p.id) }));
  cfg.panes = cfg.panes.map((p) => ({ ...p, id: uid('pane') }));
  cfg.activePaneId = cfg.panes[0]?.id || null;

  const copy = createWorkspace(cfg, { activate: true });
  for (const g of groups) {
    const pane = copy.panes[g.index];
    if (pane && g.group) links.setGroup(pane.id, g.group);
  }
  for (const p of copy.panes) p.renderLink();
  updateLinkState();
}

function cycleWorkspace(dir) {
  if (state.workspaces.length < 2) return;
  const i = state.workspaces.findIndex((w) => w.id === state.activeWorkspaceId);
  const next = (i + dir + state.workspaces.length) % state.workspaces.length;
  activateWorkspace(state.workspaces[next].id);
}

/** Ctrl+1…8 select a tab, Ctrl+9 selects the last one (desktop mapping). */
function selectWorkspaceByIndex(n) {
  const list = state.workspaces;
  if (!list.length) return;
  const target = n === 9 ? list[list.length - 1] : list[n - 1];
  if (target) activateWorkspace(target.id);
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  } catch {
    /* browser denied it */
  }
}

function newWorkspace() {
  const source = activePane();
  createWorkspace({
    id: uid('ws'),
    layout: '1x1',
    panes: [{
      symbol: source?.symbol || 'BTCUSDT',
      interval: source?.interval || '1D',
      indicators: source ? [...source.indicators] : DEFAULT_INDICATORS,
    }],
  }, { activate: true });
  renderTabs();
  persistWorkspaces();
}

function focusPane(pane) {
  const ws = workspaceOfPane(pane);
  if (!ws) return;
  if (ws.id !== state.activeWorkspaceId) {
    activateWorkspace(ws.id);
    return;
  }
  if (ws.activatePane(pane)) {
    if (tool) pane.setTool(tool);
    applyDrawingSettingsToPane(pane);
    drawbar?.refresh();
    renderTabs();
    syncChrome();
    syncIndicatorMenu();
    trading.syncSymbol();
    trading.paintPane(pane);
    startLive(pane);
    persistWorkspaces();
  }
}

/* ------------------------------------------------------------------ *
 * Tab strip
 * ------------------------------------------------------------------ */

function renderTabs() {
  tabsEl.innerHTML = '';

  for (const ws of state.workspaces) {
    const pane = ws.activePane();
    const info = pane ? services.linkInfo(pane.id) : { group: null, color: null };
    const def = layoutDef(ws.layout);

    const el = document.createElement('div');
    el.className = 'tab-item' + (ws.id === state.activeWorkspaceId ? ' active' : '');
    el.dataset.id = ws.id;
    el.innerHTML =
      `<span class="tab-link ${info.group ? 'on' : ''}" ${info.color ? `style="--link:${info.color}"` : ''} title="Link group (click to change)"></span>` +
      `<span class="tab-label">${esc(pane?.symbol || '—')}</span>` +
      `<span class="tab-tf">${esc(pane?.interval || '')}</span>` +
      (def.cells > 1 ? `<span class="tab-layout">${def.label.replace(/ /g, '')}</span>` : '') +
      `<button class="tab-close" title="Close workspace">×</button>`;

    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.tab-close') || e.target.closest('.tab-link')) return;
      activateWorkspace(ws.id);
    });

    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeWorkspace(ws.id);
    });

    el.querySelector('.tab-link').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pane) return;
      links.cycleGroup(pane.id);
      pane.renderLink();
      renderTabs();
      updateLinkState();
      persistWorkspaces();
    });

    tabsEl.appendChild(el);
  }

  updateLinkState();
  renderLayoutLabel();
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function syncChrome(payload, ms) {
  const pane = activePane();
  if (!pane) return;

  if (!payload) payload = pane.data;
  inputEl.value = pane.symbol;

  for (const b of document.querySelectorAll('.tf')) {
    b.classList.toggle('active', b.dataset.tf === pane.interval);
  }

  if (!payload) return;

  $('symName').textContent = payload.name || payload.symbol;
  $('symSub').textContent = [payload.exchange, payload.currency].filter(Boolean).join(' · ');
  $('sourceBadge').textContent = payload.source === 'binance' ? 'BINANCE' : 'YAHOO';
  $('barCount').textContent = `${payload.bars.length} bars`;
  if (ms != null) $('latencyText').textContent = `${ms} ms`;
  document.title = `${payload.symbol} — TVFREE`;
}

function updateLinkState() {
  const pane = activePane();
  const el = $('linkState');
  if (!pane) {
    el.textContent = '';
    return;
  }
  const info = services.linkInfo(pane.id);
  if (!info.group) {
    el.innerHTML = '<span class="muted">unlinked</span>';
    el.dataset.group = '';
    el.title = 'Link this chart to a group';
    return;
  }
  const g = LINK_GROUPS.find((x) => x.id === info.group);
  if (!g) {
    el.innerHTML = '<span class="muted">unlinked</span>';
    el.dataset.group = '';
    return;
  }
  el.innerHTML = `<span class="dotc" style="background:${g.color}"></span>${g.label}`;
  const channels = links.enabledChannels(info.group);
  const parts = [channels.length ? channels.join(', ') : 'no channels'];
  if (links.getCrosshairSync()) parts.push('crosshair');
  el.title = `Linked: ${parts.join(', ')}`;
  el.dataset.group = info.group;
}

function renderLayoutLabel() {
  const ws = activeWorkspace();
  const btn = $('btnLayout');
  if (!btn || !ws) return;
  btn.querySelector('#layoutLabel').textContent = ws.def.label;
  btn.title = `Chart layout — ${ws.def.label} (Alt+1…4)`;
}

/* ------------------------------------------------------------------ *
 * Link popover
 * ------------------------------------------------------------------ */

let linkPop = null;

function bindLinkBus() {
  links.subscribe((evt) => {
    if (evt.kind === 'change') {
      const values = evt.values || {};
      if (!Object.keys(values).length) return;
      for (const ws of state.workspaces) {
        for (const p of ws.panes) {
          if (p.id === evt.sourceTabId) continue;
          if (links.groupOf(p.id) !== evt.groupId) continue;
          p.applyRemote(values);
        }
      }
      return;
    }
    for (const ws of state.workspaces) for (const p of ws.panes) p.renderLink();
    renderTabs();
    updateLinkState();
  });

  $('linkState').addEventListener('click', (e) => {
    e.stopPropagation();
    const pane = activePane();
    if (!pane) return;
    if (linkPop) { closeLinkPop(); return; }
    openLinkPop($('linkState'), pane);
  });

  document.addEventListener('click', (e) => {
    if (linkPop && !linkPop.contains(e.target)) closeLinkPop();
  });
}

function closeLinkPop() {
  if (linkPop) linkPop.remove();
  linkPop = null;
}

function openLinkPop(anchor, pane) {
  closeLinkPop();
  const group = links.groupOf(pane.id);
  const pop = document.createElement('div');
  pop.className = 'link-pop';
  pop.innerHTML =
    '<div class="menu-title">Link group</div>' +
    '<div class="link-groups">' +
    `<button class="lg ${!group ? 'on' : ''}" data-g="" title="Unlinked">∅</button>` +
    LINK_GROUPS.map(
      (g) => `<button class="lg ${group === g.id ? 'on' : ''}" data-g="${g.id}" style="--c:${g.color}" title="${g.label}"></button>`,
    ).join('') +
    '</div>' +
    '<div class="menu-title">Channels</div>' +
    LINK_CHANNELS.map(
      (ch) =>
        `<label class="menu-row ${group ? '' : 'disabled'}" title="${ch.id === 'time' || ch.id === 'dateRange' ? 'Reset on reload' : ''}">` +
        `<input type="checkbox" data-ch="${ch.id}" ${group && links.isEnabled(group, ch.id) ? 'checked' : ''} ${group ? '' : 'disabled'}/>` +
        `<span class="label">${ch.label}</span></label>`,
    ).join('') +
    '<div class="link-hint">Only the focused chart broadcasts. Symbol is the only channel on by default; time and date range reset on reload.</div>';

  document.body.appendChild(pop);
  linkPop = pop;
  pop.addEventListener('click', (e) => e.stopPropagation());

  const r = anchor.getBoundingClientRect();
  pop.style.right = `${Math.max(10, window.innerWidth - r.right)}px`;
  pop.style.top = `${r.bottom + 6}px`;

  pop.querySelectorAll('[data-g]').forEach((b) =>
    b.addEventListener('click', () => {
      links.setGroup(pane.id, b.dataset.g || null);
      pane.renderLink();
      closeLinkPop();
      renderTabs();
      updateLinkState();
      persistWorkspaces();
    }),
  );

  pop.querySelectorAll('input[data-ch]').forEach((cb) =>
    cb.addEventListener('change', () => {
      if (!group) return;
      links.setChannel(group, cb.dataset.ch, cb.checked);
      updateLinkState();
    }),
  );
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

let settingsPop = null;

function closeSettingsPop() {
  if (settingsPop) settingsPop.remove();
  settingsPop = null;
}

function openSettingsMenu(anchor) {
  closeSettingsPop();
  const pop = document.createElement('div');
  pop.className = 'link-pop';
  pop.style.width = '252px';
  pop.innerHTML =
    '<div class="menu-title">Session</div>' +
    `<label class="menu-row"><input type="checkbox" data-set="saveSymbolInterval" ${saveSymbolInterval() ? 'checked' : ''}/>` +
    '<span class="label">Remember symbol &amp; interval per tab</span></label>' +
    '<div class="menu-title">Charts</div>' +
    `<label class="menu-row"><input type="checkbox" data-crosshair ${links.getCrosshairSync() ? 'checked' : ''}/>` +
    '<span class="label">Sync crosshair across linked charts</span></label>' +
    '<div class="link-hint">Link groups share symbols by default; only the focused chart broadcasts. ' +
    'Time and date range are live-only and reset on reload.</div>';

  document.body.appendChild(pop);
  settingsPop = pop;
  pop.addEventListener('click', (e) => e.stopPropagation());

  const r = anchor.getBoundingClientRect();
  pop.style.right = `${Math.max(10, window.innerWidth - r.right)}px`;
  pop.style.top = `${r.bottom + 6}px`;

  pop.querySelector('[data-set="saveSymbolInterval"]').addEventListener('change', (e) => {
    setSetting('saveSymbolInterval', e.target.checked);
    persistWorkspaces();
    setStatus('ok', e.target.checked
      ? 'session restore: symbol + interval'
      : 'session restore: layout only');
  });

  const cross = pop.querySelector('[data-crosshair]');
  cross.addEventListener('change', () => {
    links.setCrosshairSync(cross.checked);
    updateLinkState();
  });
}

/* ------------------------------------------------------------------ *
 * Layout menu + saved layouts
 * ------------------------------------------------------------------ */

let layoutPop = null;

function getPresets() {
  const v = loadJson(PRESETS_KEY, []);
  return Array.isArray(v) ? v : [];
}

function savePresets(list) {
  saveJson(PRESETS_KEY, list);
}

function savePreset(name) {
  const ws = activeWorkspace();
  if (!ws) return null;
  const trimmed = String(name || '').trim().slice(0, 40);
  if (!trimmed) return null;

  const preset = {
    name: trimmed,
    savedAt: Date.now(),
    layout: ws.layout,
    activePaneIndex: Math.max(0, ws.visiblePanes().findIndex((p) => p.id === ws.activePaneId)),
    panes: ws.visiblePanes().map((p) => {
      const s = p.serialize();
      delete s.id;
      return { ...s, group: links.groupOf(p.id) };
    }),
  };

  const list = getPresets().filter((p) => p.name !== trimmed);
  list.unshift(preset);
  savePresets(list.slice(0, 30));
  return preset;
}

function applyPreset(preset) {
  const ws = activeWorkspace();
  if (!ws || !preset) return;

  ws.setLayout(preset.layout || '1x1');

  for (let i = 0; i < preset.panes.length; i += 1) {
    const pane = ws.panes[i];
    const cfg = preset.panes[i];
    if (!pane) break;

    links.setGroup(pane.id, cfg.group || null);
    pane.renderLink();
    pane.setIndicatorSet(cfg.indicators || DEFAULT_INDICATORS);

    const symbolChanged = pane.symbol !== String(cfg.symbol || '').toUpperCase();
    const intervalChanged = pane.interval !== cfg.interval;
    pane.setSymbol(cfg.symbol, { silent: true });
    pane.setInterval(cfg.interval, { silent: true });
    if (!symbolChanged && !intervalChanged) pane.load();
  }

  const target = ws.panes[preset.activePaneIndex || 0];
  if (target) ws.activatePane(target);
  ws.activate();

  syncChrome();
  renderTabs();
  syncIndicatorMenu();
  renderLayoutLabel();
  for (const p of ws.panes) trading.paintPane(p);
  trading.syncSymbol();
  persistWorkspaces();
  setStatus('ok', `layout applied: ${preset.name}`);
}

function bindLayoutMenu() {
  $('btnLayout').addEventListener('click', (e) => {
    e.stopPropagation();
    if (layoutPop) { closeLayoutPop(); return; }
    openLayoutMenu($('btnLayout'));
  });

  document.addEventListener('click', (e) => {
    if (layoutPop && !layoutPop.contains(e.target)) closeLayoutPop();
  });
}

function closeLayoutPop() {
  if (layoutPop) layoutPop.remove();
  layoutPop = null;
}

function openLayoutMenu(anchor) {
  closeLayoutPop();
  const ws = activeWorkspace();
  if (!ws) return;

  const presets = getPresets();
  const pop = document.createElement('div');
  pop.className = 'layout-pop';
  pop.innerHTML =
    '<div class="menu-title">Grid</div>' +
    '<div class="layout-grid">' +
    LAYOUTS.map(
      (l) =>
        `<button class="layout-btn ${ws.layout === l.id ? 'on' : ''}" data-layout="${l.id}">` +
        `<span class="lg-glyph lg-${l.id}"><i></i><i></i><i></i><i></i></span>` +
        `<span>${l.label}</span></button>`,
    ).join('') +
    '</div>' +
    '<div class="menu-title">Saved layouts</div>' +
    '<div class="saved-list">' +
    (presets.length
      ? presets.map((p, i) =>
          `<div class="saved-row"><button class="saved-apply" data-apply="${i}">${esc(p.name)}` +
          `<em>${layoutDef(p.layout).label} · ${p.panes.length} chart${p.panes.length === 1 ? '' : 's'}</em></button>` +
          `<button class="saved-del" data-del="${i}" title="Delete">×</button></div>`,
        ).join('')
      : '<div class="saved-empty">None yet — configure a grid, then save it.</div>') +
    '</div>' +
    '<div class="save-row">' +
    '<input class="save-name" placeholder="Layout name, e.g. NSE open" maxlength="40" />' +
    '<button class="btn tiny" data-save="1">Save</button>' +
    '</div>' +
    '<button class="lp-export" data-export="1">Export layouts JSON</button>';

  document.body.appendChild(pop);
  layoutPop = pop;
  pop.addEventListener('click', (e) => e.stopPropagation());

  const r = anchor.getBoundingClientRect();
  pop.style.right = `${Math.max(10, window.innerWidth - r.right)}px`;
  pop.style.top = `${r.bottom + 6}px`;

  pop.querySelectorAll('[data-layout]').forEach((b) =>
    b.addEventListener('click', () => {
      ws.setLayout(b.dataset.layout);
      closeLayoutPop();
      syncChrome();
      renderTabs();
      renderLayoutLabel();
      syncIndicatorMenu();
      persistWorkspaces();
    }),
  );

  pop.querySelectorAll('[data-apply]').forEach((b) =>
    b.addEventListener('click', () => {
      const preset = getPresets()[Number(b.dataset.apply)];
      closeLayoutPop();
      applyPreset(preset);
    }),
  );

  pop.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      const list = getPresets();
      list.splice(Number(b.dataset.del), 1);
      savePresets(list);
      closeLayoutPop();
      openLayoutMenu(anchor);
    }),
  );

  const doSave = () => {
    const input = pop.querySelector('.save-name');
    const preset = savePreset(input.value);
    if (!preset) {
      input.focus();
      return;
    }
    closeLayoutPop();
    setStatus('ok', `layout saved: ${preset.name}`);
  };
  pop.querySelector('[data-save]').addEventListener('click', doSave);
  pop.querySelector('.save-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSave();
  });

  pop.querySelector('[data-export]').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(getPresets(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tvfree-layouts.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  setTimeout(() => pop.querySelector('.save-name')?.focus(), 30);
}

/* ------------------------------------------------------------------ *
 * Top bar
 * ------------------------------------------------------------------ */

function buildIntervals() {
  const nav = $('intervals');
  nav.innerHTML = '';
  for (const tf of INTERVALS) {
    const b = document.createElement('button');
    b.className = 'tf';
    b.textContent = tf;
    b.dataset.tf = tf;
    b.addEventListener('click', () => activePane()?.setInterval(tf));
    nav.appendChild(b);
  }
}

function buildIndicatorMenu() {
  indicatorMenu.innerHTML = '';
  for (const [gid, title] of Object.entries({ overlay: 'Overlays', pane: 'Panes' })) {
    const head = document.createElement('div');
    head.className = 'menu-title';
    head.textContent = title;
    indicatorMenu.appendChild(head);

    for (const [key, def] of Object.entries(IND)) {
      if (def.group !== gid) continue;
      const row = document.createElement('div');
      row.className = 'menu-row';
      row.dataset.key = key;
      row.innerHTML =
        `<span class="swatch" style="background:${def.color}"></span>` +
        `<span class="label">${def.label}</span><span class="chk">✓</span>`;
      row.addEventListener('click', () => {
        const pane = activePane();
        if (!pane) return;
        pane.toggleIndicator(key);
        row.classList.toggle('on', pane.indicators.has(key));
      });
      indicatorMenu.appendChild(row);
    }
  }
}

function syncIndicatorMenu() {
  const pane = activePane();
  if (!pane) return;
  for (const row of indicatorMenu.querySelectorAll('.menu-row')) {
    row.classList.toggle('on', pane.indicators.has(row.dataset.key));
  }
}

function bindToolbar() {
  $('btnIndicators').addEventListener('click', (e) => {
    e.stopPropagation();
    syncIndicatorMenu();
    indicatorMenu.hidden = !indicatorMenu.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!indicatorMenu.hidden && !indicatorMenu.contains(e.target)) indicatorMenu.hidden = true;
  });

  $('btnReload').addEventListener('click', () => activePane()?.load());
  $('btnSettings').addEventListener('click', (e) => {
    e.stopPropagation();
    if (settingsPop) { closeSettingsPop(); return; }
    openSettingsMenu($('btnSettings'));
  });

  document.addEventListener('click', (e) => {
    if (settingsPop && !settingsPop.contains(e.target)) closeSettingsPop();
  });
  $('btnReplay').addEventListener('click', () => {
    const pane = activePane();
    if (!pane) return;
    if (pane.replay.active) pane.stopReplay();
    else pane.startReplay();
  });
}

/* ------------------------------------------------------------------ *
 * Drawing toolbar
 *
 * Settings (magnet, stay, lock, hide, last tool per group, sticker) are
 * global like the desktop, stored under tvfree.drawings.settings.v1.
 * ------------------------------------------------------------------ */

function drawingSettings() {
  return drawingStore.loadSettings();
}

function saveDrawingSettings(patch) {
  const next = { ...drawingSettings(), ...patch };
  drawingStore.saveSettings(next);
  applyDrawingSettings(next);
  drawbar?.refresh();
  return next;
}

function applyDrawingSettingsToPane(pane, settings = drawingSettings()) {
  const d = pane?.drawings;
  if (!d) return;
  d.magnet = settings.magnet;
  d.hiddenAll = settings.hiddenAll;
  d.lockedAll = settings.lockedAll;
  if (settings.hiddenAll) d.clearSelection();
  d.emit();
}

function applyDrawingSettings(settings = drawingSettings()) {
  for (const ws of state.workspaces) {
    for (const p of ws.panes) {
      applyDrawingSettingsToPane(p, settings);
      p.chart.requestRender();
    }
  }
}

function cycleMagnet() {
  const current = drawingSettings().magnet;
  const next = current === 'off' ? 'weak' : current === 'weak' ? 'strong' : 'off';
  saveDrawingSettings({ magnet: next });
  return next;
}

function toggleStay() {
  return saveDrawingSettings({ stay: !drawingSettings().stay }).stay;
}

function toggleLock() {
  return saveDrawingSettings({ lockedAll: !drawingSettings().lockedAll }).lockedAll;
}

function toggleHide() {
  return saveDrawingSettings({ hiddenAll: !drawingSettings().hiddenAll }).hiddenAll;
}

function removeDrawings(what) {
  const pane = activePane();
  if (!pane) return;
  if (what === 'selected') pane.drawings.removeSelected();
  else pane.drawings.removeAll();
  pane.chart.requestRender();
  drawbar?.refresh();
}

function undoDrawings() {
  const pane = activePane();
  if (!pane) return false;
  const ok = pane.drawings.undo();
  if (ok) pane.chart.requestRender();
  drawbar?.refresh();
  return ok;
}

function redoDrawings() {
  const pane = activePane();
  if (!pane) return false;
  const ok = pane.drawings.redo();
  if (ok) pane.chart.requestRender();
  drawbar?.refresh();
  return ok;
}

function setStickerEmoji(emoji) {
  const settings = { ...drawingSettings(), stickerEmoji: emoji };
  drawingStore.saveSettings(settings);
  drawbar?.refresh();
  return settings;
}

function buildDrawbar() {
  drawbar = createDrawbar($('drawbar'), {
    getTool: () => tool,
    setTool: (id) => setTool(id),
    getPane: () => activePane(),
    getSettings: drawingSettings,
    saveSettings: (patch) => {
      const next = { ...drawingSettings(), ...patch };
      drawingStore.saveSettings(next);
      return next;
    },
    cycleMagnet,
    toggleStay,
    toggleLock,
    toggleHide,
    remove: removeDrawings,
    undo: undoDrawings,
    redo: redoDrawings,
    setStickerEmoji,
  });
}

function setTool(next) {
  tool = next && TOOL_BY_ID[next] ? next : null;
  const pane = activePane();
  if (pane) pane.setTool(tool);

  drawbar?.refresh();

  const hint = $('hint');
  if (tool) {
    const def = toolDef(tool);
    const label = (def?.label || tool).toLowerCase();
    const steps = tool === 'measure'
      ? 'Drag across the chart to measure'
      : tool === 'zoom'
        ? 'Drag a time range to zoom'
        : tool === 'eraser'
          ? 'Click a drawing to erase it'
          : def?.kind === 'cursor'
            ? `${def.label} cursor`
            : def?.anchors === 1
              ? `Click to place a ${label}`
              : def?.anchors > 1
                ? `Click ${def.anchors} points to draw a ${label}`
                : `Click points, double-click to finish the ${label}`;
    hint.textContent = tool === 'cursorArrow' ? 'Arrow cursor · Esc to cancel' : `${steps} · Esc to cancel`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function bindSearch() {
  inputEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = inputEl.value.trim();
    if (!q) return showDefaults();
    searchTimer = setTimeout(() => runSearch(q), 220);
  });

  inputEl.addEventListener('focus', () => {
    inputEl.select();
    if (!inputEl.value.trim()) showDefaults();
    else runSearch(inputEl.value.trim());
  });

  inputEl.addEventListener('keydown', (e) => {
    if (resultsEl.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchActive = Math.min(searchActive + 1, searchRows.length - 1);
      paintActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchActive = Math.max(searchActive - 1, 0);
      paintActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = searchRows[searchActive] || searchRows[0];
      if (pick) {
        activePane()?.setSymbol(pick.symbol);
        inputEl.value = pick.symbol;
        inputEl.blur();
        closeResults();
      }
    } else if (e.key === 'Escape') {
      closeResults();
      inputEl.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (!resultsEl.contains(e.target) && e.target !== inputEl) closeResults();
  });
}

function showDefaults() {
  renderResults([
    { symbol: 'BTCUSDT', name: 'Bitcoin / Tether', exchange: 'BINANCE' },
    { symbol: 'ETHUSDT', name: 'Ethereum / Tether', exchange: 'BINANCE' },
    { symbol: 'SOLUSDT', name: 'Solana / USDt', exchange: 'BINANCE' },
  ]);
}

async function runSearch(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const payload = await res.json();
    renderResults(payload.results || []);
  } catch {
    renderResults([]);
  }
}

function renderResults(rows) {
  searchRows = rows;
  searchActive = rows.length ? 0 : -1;
  resultsEl.innerHTML = '';

  if (!rows.length) {
    resultsEl.innerHTML = '<div class="sr-empty">no matches</div>';
    resultsEl.hidden = false;
    return;
  }

  rows.forEach((r, i) => {
    const item = document.createElement('div');
    item.className = 'sr-item' + (i === searchActive ? ' active' : '');
    item.innerHTML =
      `<span class="sr-sym">${esc(r.symbol)}</span>` +
      `<span class="sr-name">${esc(r.name || '')}</span>` +
      `<span class="sr-exch">${esc(r.exchange || '')}</span>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      activePane()?.setSymbol(r.symbol);
      inputEl.value = r.symbol;
      closeResults();
      inputEl.blur();
    });
    item.addEventListener('mouseenter', () => {
      searchActive = i;
      paintActive();
    });
    resultsEl.appendChild(item);
  });

  resultsEl.hidden = false;
}

function paintActive() {
  resultsEl.querySelectorAll('.sr-item').forEach((el, i) => el.classList.toggle('active', i === searchActive));
}

function closeResults() {
  resultsEl.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Watchlist
 * ------------------------------------------------------------------ */

const wlRows = new Map();

function bindWatchlist() {
  $('btnAddSymbol').addEventListener('click', () => {
    const pane = activePane();
    if (!pane) return;
    if (state.watchlist.includes(pane.symbol)) return;
    state.watchlist.push(pane.symbol);
    saveJson(WATCHLIST_KEY, state.watchlist);
    renderWatchlist();
    refreshQuotes([pane.symbol]);
  });
}

function renderWatchlist() {
  const activeSym = activePane()?.symbol;
  const host = $('watchlist');
  host.innerHTML = '';
  wlRows.clear();

  for (const symbol of state.watchlist) {
    const row = document.createElement('div');
    row.className = 'wl-row' + (symbol === activeSym ? ' active' : '');
    row.innerHTML =
      `<div class="wl-sym">${esc(symbol)}</div>` +
      `<div class="wl-price">—</div>` +
      `<div class="wl-desc">—</div>` +
      `<div class="wl-chg">—</div>` +
      `<button class="wl-remove" title="Remove">×</button>`;

    row.addEventListener('click', () => activePane()?.setSymbol(symbol));
    row.querySelector('.wl-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      state.watchlist = state.watchlist.filter((s) => s !== symbol);
      saveJson(WATCHLIST_KEY, state.watchlist);
      renderWatchlist();
    });

    host.appendChild(row);
    wlRows.set(symbol, row);
  }

  for (const [symbol, q] of state.quotes) paintQuote(symbol, q);
}

function paintQuote(symbol, q) {
  const row = wlRows.get(symbol);
  if (!row) return;
  if (!q || q.error) {
    row.querySelector('.wl-desc').textContent = q && q.error ? 'unavailable' : '—';
    return;
  }
  const up = q.change >= 0;
  row.querySelector('.wl-price').textContent = fmtPrice(q.price);
  row.querySelector('.wl-desc').textContent = q.name || '';
  const chgEl = row.querySelector('.wl-chg');
  chgEl.textContent = `${up ? '+' : ''}${(q.changePct ?? 0).toFixed(2)}%`;
  chgEl.style.color = up ? 'var(--up)' : 'var(--down)';
}

async function refreshQuotes(extra = []) {
  const symbols = [...new Set([...extra, ...state.watchlist, ...trading.symbols()])];
  if (!symbols.length) return;
  try {
    const res = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols.join(','))}`);
    const payload = await res.json();
    for (const q of payload.quotes || []) {
      state.quotes.set(q.symbol, q);
      paintQuote(q.symbol, q);
    }
    trading.onQuotes();
  } catch {
    /* keep previous */
  }
}

/* ------------------------------------------------------------------ *
 * Binance live stream (SSE) — real-time candles + quotes per pane
 * ------------------------------------------------------------------ */

const liveFeeds = new Map(); // paneId -> feed

function startLive(pane) {
  if (!pane) return;
  stopLive(pane.id);
  let feed;
  try {
    feed = window.TVFreeLive.connect(pane.symbol, pane.interval, {
      onTick: (tick) => onLiveTick(pane, tick),
      onCandle: (c) => onLiveCandle(pane, c),
      onError: () => { /* EventSource auto-reconnects */ },
    });
  } catch {
    return; // EventSource unavailable -> 20s REST polling fallback stays on
  }
  liveFeeds.set(pane.id, feed);
}

function stopLive(paneId) {
  const feed = liveFeeds.get(paneId);
  if (!feed) return;
  try { feed.close?.(); } catch { /* ignore */ }
  liveFeeds.delete(paneId);
}

function onLiveTick(pane, tick) {
  if (tick.symbol !== pane.symbol) return;
  const prev = tick.prevPrice ?? tick.price;
  state.quotes.set(tick.symbol, {
    symbol: tick.symbol,
    name: tick.symbol,
    price: tick.price,
    prevClose: prev,
    change: tick.price - prev,
    changePct: prev ? ((tick.price - prev) / prev) * 100 : 0,
    currency: 'USDT',
    exchange: 'BINANCE',
    source: 'binance-live',
    asOf: tick.time || Date.now(),
  });
  trading.onQuotes();
  renderWatchlist();
}

function onLiveCandle(pane, c) {
  if (c.symbol !== pane.symbol) return;
  pane.applyLiveCandle(c);
}

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

const alerts = new AlertCenter({
  bellButton: $('btnAlerts'),
  panelHost: $('alertHost'),
  getContext: () => {
    const pane = activePane();
    const bars = pane?.data?.bars;
    const last = bars && bars.length ? bars[bars.length - 1] : null;
    return { symbol: pane?.symbol, price: last ? last.c : 0, interval: pane?.interval };
  },
  onStatus: (kind, text) => setStatus(kind, text),
  onActivateSymbol: (symbol) => {
    const pane = activePane();
    if (!pane || !symbol) return;
    if (String(pane.symbol).toUpperCase() !== String(symbol).toUpperCase()) pane.setSymbol(symbol);
    focusPane(pane);
  },
});

/* ------------------------------------------------------------------ *
 * Paper trading
 * ------------------------------------------------------------------ */

const trading = new TradeDesk({
  host: $('tradeBody'),
  getSymbol: () => activePane()?.symbol || null,
  getQuote: (symbol) => state.quotes.get(symbol),
  getLastBar: (symbol) => {
    for (const ws of state.workspaces) {
      for (const p of ws.panes) {
        if (p.symbol !== symbol) continue;
        const bars = p.data?.bars;
        if (bars && bars.length) return bars[bars.length - 1];
      }
    }
    return null;
  },
  onStatus: (kind, text) => setStatus(kind, text),
  onChange: () => {
    for (const ws of state.workspaces) {
      for (const p of ws.panes) trading.paintPane(p);
    }
  },
});

let sideMode = loadJson('tvfree.sidemode', 'watchlist');

function bindSideTabs() {
  const host = $('sideTabs');
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    setSideMode(btn.dataset.mode);
  });
  setSideMode(sideMode === 'trade' ? 'trade' : 'watchlist');
}

function setSideMode(mode) {
  sideMode = mode === 'trade' ? 'trade' : 'watchlist';
  saveJson('tvfree.sidemode', sideMode);

  for (const b of $('sideTabs').querySelectorAll('[data-mode]')) {
    b.classList.toggle('on', b.dataset.mode === sideMode);
  }

  $('watchlist').hidden = sideMode !== 'watchlist';
  $('tradeBody').hidden = sideMode !== 'trade';
  $('btnAddSymbol').hidden = sideMode !== 'watchlist';

  trading.setMode(sideMode);
  if (sideMode === 'trade') {
    for (const ws of state.workspaces) {
      for (const p of ws.panes) trading.paintPane(p);
    }
    trading.syncSymbol();
  }
}

/* ------------------------------------------------------------------ *
 * Tabs / keyboard / status
 * ------------------------------------------------------------------ */

function bindTabs() {
  $('btnNewTab').addEventListener('click', newWorkspace);
}

const TOOL_HOTKEYS = {
  t: 'trend',
  h: 'hline',
  v: 'vline',
  r: 'rectangle',
  f: 'fibRetracement',
  x: 'text',
  p: 'longPosition',
  c: 'parallelChannel',
  m: 'measure',
};

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

    // Drawing editing wins first: Escape cancels a draft, Enter finishes a
    // multi-point tool, Delete removes the selection, Ctrl+Z/Y undo/redo,
    // Ctrl+C/V/D copy, paste and duplicate.
    if (!inField) {
      const pane0 = activePane();
      if (pane0 && pane0.handleKey(e)) {
        e.preventDefault();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const id = TOOL_HOTKEYS[e.key.toLowerCase()];
        if (id) {
          e.preventDefault();
          setTool(tool === id ? null : id);
          return;
        }
      }
    }

    if (e.altKey && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      const ws = activeWorkspace();
      if (ws) {
        ws.setLayout(LAYOUTS[Number(e.key) - 1].id);
        renderTabs();
        renderLayoutLabel();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      reopenWorkspace();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      newWorkspace();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (state.activeWorkspaceId) closeWorkspace(state.activeWorkspaceId);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'F4') {
      e.preventDefault();
      if (state.activeWorkspaceId) closeWorkspace(state.activeWorkspaceId);
      return;
    }

    // Desktop tab navigation: Ctrl+Tab / Ctrl+PageDown forward,
    // Ctrl+Shift+Tab / Ctrl+PageUp back, Ctrl+1…8 direct, Ctrl+9 last.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault();
      cycleWorkspace(e.key === 'PageUp' || e.shiftKey ? -1 : 1);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      selectWorkspaceByIndex(Number(e.key));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'u') {
      e.preventDefault();
      duplicateWorkspace();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      if (settingsPop) closeSettingsPop();
      else openSettingsMenu($('btnSettings'));
      return;
    }
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      activePane()?.load();
      return;
    }
    if (e.key === '/' && !inField) {
      e.preventDefault();
      inputEl.focus();
      inputEl.select();
      return;
    }
    if (e.key === 'Escape') {
      setTool(null);
      closeResults();
      closeLinkPop();
      closeLayoutPop();
      closeSettingsPop();
      alerts.close();
      return;
    }
    if (inField) return;

    const pane = activePane();
    if (!pane) return;

    if (e.key === 'r' || e.key === 'R') {
      pane.load();
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= INTERVALS.length) pane.setInterval(INTERVALS[n - 1]);
  });
}

function setStatus(kind, text) {
  $('statusDot').className = 'dot' + (kind ? ` ${kind}` : '');
  $('statusText').textContent = text;
}

function startClock() {
  const paint = () => {
    $('clockText').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  };
  paint();
  setInterval(paint, 1000);
}

function tick() {
  for (const ws of state.workspaces) {
    for (const p of ws.panes) {
      // A live SSE feed already keeps the last bar current; REST is the fallback.
      if (!liveFeeds.has(p.id)) p.refresh();
    }
  }
  refreshQuotes();
  renderWatchlist();
}

/* ------------------------------------------------------------------ */

window.__tv = {
  state,
  links,
  alerts,
  trading,
  liveFeeds,
  getActiveWorkspace: activeWorkspace,
  getActivePane: activePane,
  activateWorkspace,
  newWorkspace,
  closeWorkspace,
  createWorkspace,
  focusPane,
  reopenWorkspace,
  duplicateWorkspace,
  cycleWorkspace,
  selectWorkspaceByIndex,
  paneFocused,
  persistWorkspaces,
  settings: {
    get: getSettings,
    set: setSetting,
  },
  setLayout: (id) => {
    const ws = activeWorkspace();
    ws?.setLayout(id);
    renderTabs();
    renderLayoutLabel();
    persistWorkspaces();
  },
  applyPreset,
  savePreset,
  getPresets,
  setTool,
  setSideMode,
  drawings: {
    store: drawingStore,
    get pane() { return activePane(); },
    tool: () => tool,
    setTool,
    list: () => activePane()?.drawings.shapes ?? [],
    export: () => JSON.stringify(activePane()?.drawings.shapes ?? []),
    create(type, points, extra = {}) {
      const pane = activePane();
      if (!pane || !TOOL_BY_ID[type]) return null;
      const shape = pane.drawings.add({ type, points, ...extra });
      pane.chart.requestRender();
      drawbar?.refresh();
      return shape;
    },
    remove(id) {
      const pane = activePane();
      if (!pane) return false;
      pane.drawings.remove(id);
      pane.chart.requestRender();
      return true;
    },
    clear() {
      const pane = activePane();
      if (!pane) return;
      pane.drawings.removeAll();
      pane.chart.requestRender();
      drawbar?.refresh();
    },
    selected: () => activePane()?.drawings.selectedShape() ?? null,
    settings: {
      get: drawingSettings,
      set: saveDrawingSettings,
    },
    setMagnet: (mode) => saveDrawingSettings({ magnet: mode }).magnet,
    cycleMagnet,
    setStay: (value) => saveDrawingSettings({ stay: Boolean(value) }).stay,
    setHiddenAll: (value) => saveDrawingSettings({ hiddenAll: Boolean(value) }).hiddenAll,
    setLockedAll: (value) => saveDrawingSettings({ lockedAll: Boolean(value) }).lockedAll,
    setStickerEmoji,
    undo: undoDrawings,
    redo: redoDrawings,
  },
};

boot();
