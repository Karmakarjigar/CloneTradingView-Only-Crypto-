/**
 * TradingView-style left drawing toolbar.
 *
 * Top: the eight drawing categories, each with a hover/click flyout.
 * Middle: measure + box zoom.
 * Bottom: magnet, stay-in-mode, lock, hide, remove, undo/redo.
 */

import { TOOL_GROUPS, TOOL_BY_ID, toolDef, groupOf } from './drawings/registry.js';

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  cursor: svg('<path d="M5 2l13 8.4-5.6 1.3L15.5 18l-2.2 1.1-3.1-6.2L5 18z" fill="currentColor" stroke="none"/>'),
  dot: svg('<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3" opacity=".55"/>'),
  arrowCursor: svg('<path d="M5 2l13 8.4-5.6 1.3L15.5 18l-2.2 1.1-3.1-6.2L5 18z" fill="currentColor" stroke="none"/>'),
  eraser: svg('<path d="M4 16l7-7 6 6-4 4H7z"/><path d="M11 9l3-3 6 6-4 4"/>'),
  trend: svg('<path d="M4 19L20 5"/><circle cx="4" cy="19" r="1.9" fill="currentColor" stroke="none"/><circle cx="20" cy="5" r="1.9" fill="currentColor" stroke="none"/>'),
  hline: svg('<path d="M3 12h18"/><circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/>'),
  hray: svg('<path d="M5 12h16"/><circle cx="5" cy="12" r="2.1" fill="currentColor" stroke="none"/>'),
  vline: svg('<path d="M12 3v18"/><circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/>'),
  crossline: svg('<path d="M12 3v18M3 12h18"/>'),
  channel: svg('<path d="M3 17l13-9M7 21L20 12"/>'),
  fib: svg('<path d="M3 6h18M3 10.5h18M3 15h18M3 19.5h18"/>'),
  patterns: svg('<path d="M3 18l4-7 4 4 5-9 5 6"/><circle cx="7" cy="11" r="1.5" fill="currentColor" stroke="none"/>'),
  forecast: svg('<rect x="3" y="8" width="18" height="9" rx="1"/><path d="M7 8V5h10v3M7 17v2h10v-2"/>'),
  shapes: svg('<rect x="3" y="10" width="10" height="8" rx="1"/><circle cx="17" cy="9" r="4"/>'),
  text: svg('<path d="M5 5h14M12 5v14M8.5 19h7"/>'),
  icons: svg('<circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/><path d="M8 14c1.1 1.6 2.4 2.4 4 2.4s2.9-.8 4-2.4"/>'),
  measure: svg('<path d="M4 16L16 4l4 4L8 20z"/><path d="M9 15l2 2M12 12l2 2M15 9l2 2"/>'),
  zoom: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5"/>'),
  magnet: svg('<path d="M5 4v8a7 7 0 0014 0V4h-4v8a3 3 0 01-6 0V4z"/><path d="M5 8h4M15 8h4"/>'),
  magnetWeak: svg('<path d="M5 4v8a7 7 0 0014 0V4h-4v8a3 3 0 01-6 0V4z"/><path d="M5 8h4M15 8h4" opacity=".8"/><path d="M3 20h4" opacity=".65"/>'),
  magnetStrong: svg('<path d="M5 4v8a7 7 0 0014 0V4h-4v8a3 3 0 01-6 0V4z"/><path d="M5 8h4M15 8h4"/><path d="M3 20h4M10 20h4M17 20h4"/>'),
  stay: svg('<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M13 6l3 3M15 4l3 3"/>'),
  lock: svg('<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V8a4 4 0 018 0v2"/>'),
  unlock: svg('<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V8a4 4 0 017-2.6"/>'),
  eye: svg('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M9.5 5.4A10.8 10.8 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4M6.2 6.8A17.7 17.7 0 002 12s3.5 7 10 7c1.3 0 2.5-.3 3.6-.7"/>'),
  trash: svg('<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
  undo: svg('<path d="M9 7L4 12l5 5"/><path d="M4 12h9a6 6 0 016 6"/>'),
  redo: svg('<path d="M15 7l5 5-5 5"/><path d="M20 12h-9a6 6 0 00-6 6"/>'),
  channelPf: svg('<path d="M5 20L12 4M10 20l7-16M3 20h18" opacity=".8"/>'),
  gann: svg('<rect x="4" y="4" width="16" height="16"/><path d="M4 4l16 16M20 4L4 20M4 12h16M12 4v16"/>'),
  position: svg('<rect x="3" y="7" width="18" height="5" fill="currentColor" opacity=".22" stroke="none"/><rect x="3" y="12" width="18" height="5" fill="currentColor" opacity=".22" stroke="none"/><path d="M3 10h18M3 14h18M3 7h18M3 19h18"/>'),
  ranges: svg('<rect x="4" y="6" width="16" height="12" rx="1"/><path d="M4 12h16M12 6v12" opacity=".6"/>'),
  profile: svg('<path d="M4 4v16M20 4v16" opacity=".6"/><path d="M4 7h13M4 11h8M4 15h16M4 19h5"/>'),
  vwap: svg('<path d="M3 16c3 0 4-7 7-7s4 5 7 5 4-3 4-3"/><path d="M3 20h18" opacity=".4"/>'),
  shapesMisc: svg('<path d="M4 18c5-9 11-9 16 0"/><circle cx="6" cy="8" r="2"/><rect x="13" y="4" width="7" height="6"/>'),
  flag: svg('<path d="M6 21V4M6 4h11l-2.2 4L17 12H6"/>'),
  emoji: svg('<circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/><path d="M8 14c1.1 1.6 2.4 2.4 4 2.4s2.9-.8 4-2.4"/>'),
  expand: '<svg viewBox="0 0 8 8" width="8" height="8" fill="currentColor"><path d="M8 8H4l4-4z"/></svg>',
};

const TOOL_ICONS = {
  ray: ICONS.trend,
  info: ICONS.trend,
  extended: ICONS.trend,
  trendAngle: ICONS.trend,
  arrow: svg('<path d="M4 20L20 4M20 4h-7M20 4v7"/>'),
  parallelChannel: ICONS.channel,
  regression: ICONS.channel,
  flatTopBottom: ICONS.channel,
  disjointChannel: ICONS.channel,
  hline: ICONS.hline,
  hray: ICONS.hray,
  vline: ICONS.vline,
  crossLine: ICONS.crossline,
  fibRetracement: ICONS.fib,
  fibExtension: ICONS.fib,
  fibChannel: ICONS.channel,
  fibTimeZone: ICONS.vline,
  fibSpeedFan: ICONS.trend,
  fibTime: ICONS.vline,
  fibCircles: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>'),
  fibSpiral: svg('<path d="M12 12c0-3 5-3 5 1s-7 5-7 0 9-6 9 1-12 8-12 0 12-10 12-1"/>'),
  fibArcs: svg('<path d="M4 20a16 16 0 0116 0M7 20a10 10 0 0110 0M10 20a4 4 0 014 0"/>'),
  fibWedge: svg('<path d="M3 20L16 4l5 16z"/>'),
  pitchfork: ICONS.channelPf,
  pitchforkSchiff: ICONS.channelPf,
  pitchforkModifiedSchiff: ICONS.channelPf,
  pitchforkInside: ICONS.channelPf,
  gannBox: ICONS.gann,
  gannSquareFixed: ICONS.gann,
  gannSquare: ICONS.gann,
  gannFan: ICONS.trend,
  xabcd: ICONS.patterns,
  cypher: ICONS.patterns,
  abcd: ICONS.patterns,
  trianglePattern: svg('<path d="M12 4l8 16H4z"/>'),
  threeDrives: ICONS.patterns,
  headShoulders: svg('<path d="M3 15c2 0 2-6 4-6s2 4 3 4 2-8 4-8 2 8 4 8 1-4 3-4"/>'),
  elliottImpulse: ICONS.patterns,
  elliottTriangle: svg('<path d="M3 18l5-12 5 9 5-6 3 9z"/>'),
  elliottCorrection: ICONS.patterns,
  elliottDoubleCombo: ICONS.patterns,
  elliottTripleCombo: ICONS.patterns,
  cyclicLines: svg('<path d="M5 3v18M10 3v18M15 3v18M20 3v18" opacity=".8"/>'),
  timeCycles: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  sineLine: svg('<path d="M3 12c3-8 6-8 9 0s6 8 9 0"/>'),
  longPosition: ICONS.position,
  shortPosition: ICONS.position,
  positionForecast: ICONS.position,
  dateRange: ICONS.ranges,
  priceRange: ICONS.ranges,
  datePriceRange: ICONS.ranges,
  barsPattern: svg('<path d="M4 18v-5M8 18V8M12 18v-3M16 18V6M20 18v-8"/>'),
  ghostFeed: svg('<path d="M4 18v-5M8 18V8M12 18v-3M16 18V6M20 18v-8" opacity=".55"/>'),
  sector: svg('<path d="M12 12L4 8a9 9 0 0112-4z"/><path d="M12 12l6 7"/>'),
  fixedRangeVolumeProfile: ICONS.profile,
  anchoredVolumeProfile: ICONS.profile,
  anchoredVWAP: ICONS.vwap,
  brush: svg('<path d="M4 20c2-1 2-5 5-8s8-6 11-8c0 4-4 9-7 11s-7 3-9 5z"/>'),
  highlighter: svg('<path d="M4 18l3 3 4-4-3-3zM8 14l8-9 4 4-9 8z"/>'),
  rectangle: ICONS.shapes,
  rotatedRectangle: svg('<rect x="5" y="6" width="15" height="10" rx="1" transform="rotate(-15 12 12)"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="5"/>'),
  path: svg('<path d="M4 17c4-9 9 3 16-10"/>'),
  polyline: svg('<path d="M3 18l5-8 5 5 7-10"/>'),
  triangleShape: svg('<path d="M12 4l8 16H4z"/>'),
  arc: svg('<path d="M4 18a10 10 0 0116 0"/>'),
  curve: svg('<path d="M4 18C7 4 17 4 20 18"/>'),
  doubleCurve: svg('<path d="M3 18C6 4 9 4 12 12s6 8 9-4"/>'),
  text: ICONS.text,
  note: svg('<path d="M5 4h14v12l-4 4H5z"/><path d="M15 20v-4h4M9 9h6M9 12h4"/>'),
  anchoredNote: svg('<path d="M8 4h12v11l-3 3H8z"/><path d="M8 18L4 21M11 8h5M11 11h3"/>'),
  signpost: svg('<path d="M6 21V4M6 4h12l-2 4 2 4H6"/>'),
  callout: svg('<path d="M4 5h16v10H10l-4 4v-4H4z"/><path d="M8 9h8M8 12h5"/>'),
  comment: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
  priceLabel: svg('<path d="M3 12h12M15 8l5 4-5 4z" fill="currentColor" stroke="none"/><path d="M3 12h10"/>'),
  priceNote: svg('<path d="M3 12h9M12 8l6 4-6 4z"/><rect x="3" y="16" width="9" height="4"/>'),
  arrowMarker: ICONS.arrow || svg('<path d="M12 3v18M12 3l-6 8h12z"/>'),
  arrowMarkLeft: svg('<path d="M21 12H3M3 12l7-6M3 12l7 6"/>'),
  arrowMarkRight: svg('<path d="M3 12h18M21 12l-7-6M21 12l-7 6"/>'),
  arrowMarkUp: svg('<path d="M12 21V3M12 3L6 11M12 3l6 8"/>'),
  arrowMarkDown: svg('<path d="M12 3v18M12 21l-6-8M12 21l6-8"/>'),
  flagMark: ICONS.flag,
  sticker: ICONS.emoji,
  measure: ICONS.measure,
  zoom: ICONS.zoom,
  cursorCross: svg('<path d="M12 3v18M3 12h18" opacity=".8"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  cursorDot: ICONS.dot,
  cursorArrow: ICONS.cursor,
  eraser: ICONS.eraser,
};

const SHORTCUTS = {
  trend: 'Alt+T',
  hline: 'Alt+H',
  vline: 'Alt+V',
  rectangle: 'Alt+R',
  fibRetracement: 'Alt+F',
  text: 'Alt+X',
  longPosition: 'Alt+P',
  parallelChannel: 'Alt+C',
  measure: 'Alt+M',
};

const EMOJIS = [
  '😀', '😎', '🤔', '😱', '🚀', '🔥', '💎', '🤑',
  '📈', '📉', '🐂', '🐻', '✅', '❌', '⚠️', '⭐',
  '🎯', '💰', '🏦', '⚡', '🌙', '☀️', '🧲', '🔔',
];

function iconFor(id) {
  return TOOL_ICONS[id] || ICONS.tools || ICONS.shapesMisc;
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

export function buildDrawbar(container, api) {
  container.innerHTML = '';

  const top = el('div', 'drawbar-top');
  const spacer = el('div', 'drawbar-spacer');
  const bottom = el('div', 'drawbar-bottom');
  container.append(top, spacer, bottom);

  const tip = el('div', 'draw-tip');
  tip.hidden = true;
  document.body.appendChild(tip);

  let flyout = null;
  let flyoutGroup = null;
  let openTimer = 0;
  let closeTimer = 0;

  const settings = () => api.getSettings() || {};

  function selectTool(id) {
    const def = toolDef(id);
    if (!def) return;
    const g = groupOf(id);
    if (g) {
      const s = settings();
      const lastByGroup = { ...(s.lastByGroup || {}), [g]: id };
      api.saveSettings({ lastByGroup, lastTool: id });
    }
    api.setTool(id);
    closeFlyout();
    refresh();
  }

  function toolForGroup(group) {
    const last = (settings().lastByGroup || {})[group.id];
    if (last && TOOL_BY_ID[last]) return last;
    if (group.tools && group.tools.length) return group.tools[0];
    if (group.sections && group.sections.length) return group.sections[0].tools[0];
    return null;
  }

  function makeCategory(group) {
    const btn = el('button', 'tool draw-cat');
    btn.dataset.group = group.id;
    btn.dataset.tip = group.label;
    btn.setAttribute('aria-label', group.label);
    const icon = toolForGroup(group);
    btn.innerHTML = `<span class="cat-icon">${iconFor(icon || group.id)}</span><span class="cat-caret">${ICONS.expand}</span>`;
    btn.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
      clearTimeout(openTimer);
      openTimer = setTimeout(() => openFlyout(group.id, btn), 220);
    });
    btn.addEventListener('mouseleave', () => {
      clearTimeout(openTimer);
      scheduleClose();
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(openTimer);
      if (flyout && flyoutGroup === group.id) {
        closeFlyout();
        return;
      }
      openFlyout(group.id, btn);
    });
    return btn;
  }

  for (const group of TOOL_GROUPS) top.appendChild(makeCategory(group));

  /* ---------------- flyout ---------------- */

  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => closeFlyout(), 180);
  }

  function closeFlyout() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (flyout) flyout.remove();
    flyout = null;
    flyoutGroup = null;
  }

  function openFlyout(groupId, anchor) {
    closeFlyout();
    const group = TOOL_GROUPS.find((g) => g.id === groupId);
    if (!group) return;
    flyoutGroup = groupId;
    flyout = el('div', 'draw-flyout');
    flyout.dataset.group = groupId;

    const head = el('div', 'fly-head', `<span>${group.label}</span>`);
    flyout.appendChild(head);

    const activeTool = api.getTool();

    const renderSection = (section) => {
      if (section.label) flyout.appendChild(el('div', 'fly-section', section.label));
      for (const id of section.tools) {
        const def = TOOL_BY_ID[id];
        if (!def) continue;
        const item = el('button', 'fly-item' + (id === activeTool ? ' active' : ''));
        item.dataset.tool = id;
        item.innerHTML = `<span class="fly-ico">${iconFor(id)}</span><span class="fly-label">${def.label}</span>` +
          (SHORTCUTS[id] ? `<kbd>${SHORTCUTS[id]}</kbd>` : '');
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          selectTool(id);
        });
        flyout.appendChild(item);
      }
    };

    if (group.sections) {
      for (const section of group.sections) renderSection(section);
    } else {
      renderSection({ tools: group.tools });
    }

    if (group.id === 'icons') {
      const grid = el('div', 'emoji-grid');
      const current = settings().stickerEmoji || '😀';
      for (const emoji of EMOJIS) {
        const b = el('button', 'emoji' + (emoji === current ? ' active' : ''), emoji);
        b.dataset.emoji = emoji;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          api.saveSettings({ stickerEmoji: emoji });
          api.setStickerEmoji(emoji);
          selectTool('sticker');
        });
        grid.appendChild(b);
      }
      flyout.appendChild(grid);
      flyout.appendChild(el('div', 'fly-hint', 'Pick an emoji, then click the chart'));
    }

    flyout.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
      clearTimeout(openTimer);
    });
    flyout.addEventListener('mouseleave', scheduleClose);
    flyout.addEventListener('click', (e) => e.stopPropagation());

    document.body.appendChild(flyout);
    const r = anchor.getBoundingClientRect();
    const fw = flyout.offsetWidth;
    const fh = flyout.offsetHeight;
    let left = r.right + 8;
    if (left + fw > window.innerWidth - 8) left = Math.max(8, r.left - fw - 8);
    const topPos = Math.max(8, Math.min(r.top - 8, window.innerHeight - fh - 8));
    flyout.style.left = `${Math.round(left)}px`;
    flyout.style.top = `${Math.round(topPos)}px`;
  }

  /* ---------------- management ---------------- */

  function manageButton({ id, icon, tipText, onClick, className = '' }) {
    const btn = el('button', `tool tool-manage ${className}`.trim(), icon);
    btn.dataset.manage = id;
    btn.dataset.tip = tipText;
    btn.setAttribute('aria-label', tipText);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(btn);
      refresh();
    });
    btn.addEventListener('mouseenter', () => {
      const label = btn.dataset.tip;
      if (label) showTip(btn, label);
    });
    btn.addEventListener('mouseleave', hideTip);
    return btn;
  }

  const measureBtn = manageButton({
    id: 'measure',
    icon: ICONS.measure,
    tipText: 'Measure (Alt+M)',
    onClick: () => api.setTool('measure'),
  });
  const zoomBtn = manageButton({
    id: 'zoom',
    icon: ICONS.zoom,
    tipText: 'Zoom in',
    onClick: () => api.setTool('zoom'),
  });

  const magnetBtn = manageButton({
    id: 'magnet',
    icon: ICONS.magnet,
    tipText: 'Magnet: Off',
    onClick: () => {
      const mode = api.cycleMagnet();
      magnetBtn.dataset.tip = `Magnet: ${mode === 'off' ? 'Off' : mode === 'weak' ? 'Weak' : 'Strong'}`;
      refresh();
    },
  });

  const stayBtn = manageButton({
    id: 'stay',
    icon: ICONS.stay,
    tipText: 'Stay in Drawing Mode',
    onClick: () => api.toggleStay(),
  });

  const lockBtn = manageButton({
    id: 'lock',
    icon: ICONS.lock,
    tipText: 'Lock All Drawings',
    onClick: () => api.toggleLock(),
  });

  const hideBtn = manageButton({
    id: 'hide',
    icon: ICONS.eye,
    tipText: 'Hide All Drawings',
    onClick: () => api.toggleHide(),
  });

  const trashBtn = manageButton({
    id: 'trash',
    icon: ICONS.trash,
    tipText: 'Remove drawings',
    onClick: (btn) => openRemoveMenu(btn),
  });

  const undoBtn = manageButton({
    id: 'undo',
    icon: ICONS.undo,
    tipText: 'Undo (Ctrl+Z)',
    onClick: () => api.undo(),
    className: 'tool-undo',
  });
  const redoBtn = manageButton({
    id: 'redo',
    icon: ICONS.redo,
    tipText: 'Redo (Ctrl+Shift+Z)',
    onClick: () => api.redo(),
    className: 'tool-redo',
  });

  bottom.append(measureBtn, zoomBtn, el('div', 'drawbar-sep'));
  bottom.append(magnetBtn, stayBtn, lockBtn, hideBtn, trashBtn);
  bottom.append(el('div', 'drawbar-sep'));
  bottom.append(undoBtn, redoBtn);

  /* ---------------- remove menu ---------------- */

  let mini = null;

  function closeMini() {
    if (mini) mini.remove();
    mini = null;
  }

  function openRemoveMenu(anchor) {
    closeMini();
    const pane = api.getPane();
    const hasSelection = Boolean(pane?.drawings?.selectedIds?.size);
    mini = el('div', 'draw-mini');
    const add = (label, action, disabled = false) => {
      const b = el('button', 'mini-item', label);
      b.disabled = disabled;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMini();
        action();
        refresh();
      });
      mini.appendChild(b);
    };
    add('Remove selected', () => api.remove('selected'), !hasSelection);
    add('Remove all drawings', () => api.remove('all'));
    mini.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(mini);
    const r = anchor.getBoundingClientRect();
    mini.style.left = `${Math.round(r.right + 8)}px`;
    mini.style.top = `${Math.round(Math.min(r.top, window.innerHeight - 90))}px`;
  }

  /* ---------------- tooltips ---------------- */

  function showTip(anchor, text) {
    tip.textContent = text;
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.right + 8;
    if (left + tw > window.innerWidth - 6) left = Math.max(6, r.left - tw - 8);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(r.top + r.height / 2 - th / 2)}px`;
  }

  function hideTip() {
    tip.hidden = true;
  }

  container.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('.draw-cat, .tool-manage');
    if (!btn || btn.classList.contains('tool-manage') && btn.dataset.manage !== 'magnet') return;
    if (btn.dataset.tip) showTip(btn, btn.dataset.tip);
  });
  container.addEventListener('mouseout', (e) => {
    if (e.target.closest('.draw-cat, .tool-manage')) hideTip();
  });

  /* ---------------- outside click ---------------- */

  const onDocClick = () => { closeFlyout(); closeMini(); };
  document.addEventListener('click', onDocClick);
  window.addEventListener('resize', closeFlyout);

  /* ---------------- refresh ---------------- */

  function refresh() {
    const current = api.getTool();
    const currentGroup = current ? groupOf(current) : null;
    const s = settings();

    for (const btn of top.querySelectorAll('.draw-cat')) {
      const group = btn.dataset.group;
      const active = group === currentGroup;
      btn.classList.toggle('active', active);
      const id = toolForGroup(TOOL_GROUPS.find((g) => g.id === group));
      const icon = btn.querySelector('.cat-icon');
      if (icon) icon.innerHTML = iconFor(id || group);
      btn.title = TOOL_GROUPS.find((g) => g.id === group)?.label || '';
    }

    const magnetMode = s.magnet || 'off';
    magnetBtn.innerHTML = magnetMode === 'strong' ? ICONS.magnetStrong : magnetMode === 'weak' ? ICONS.magnetWeak : ICONS.magnet;
    magnetBtn.classList.toggle('on', magnetMode !== 'off');
    magnetBtn.dataset.tip = `Magnet: ${magnetMode === 'off' ? 'Off' : magnetMode === 'weak' ? 'Weak' : 'Strong'}`;

    stayBtn.classList.toggle('on', Boolean(s.stay));
    stayBtn.dataset.tip = s.stay ? 'Stay in Drawing Mode: On' : 'Stay in Drawing Mode: Off';

    lockBtn.innerHTML = s.lockedAll ? ICONS.lock : ICONS.unlock;
    lockBtn.classList.toggle('on', Boolean(s.lockedAll));
    lockBtn.dataset.tip = s.lockedAll ? 'Unlock All Drawings' : 'Lock All Drawings';

    hideBtn.innerHTML = s.hiddenAll ? ICONS.eyeOff : ICONS.eye;
    hideBtn.classList.toggle('on', Boolean(s.hiddenAll));
    hideBtn.dataset.tip = s.hiddenAll ? 'Show All Drawings' : 'Hide All Drawings';

    measureBtn.classList.toggle('active', current === 'measure');
    zoomBtn.classList.toggle('active', current === 'zoom');

    const pane = api.getPane();
    const drawings = pane?.drawings;
    undoBtn.disabled = !(drawings?.canUndo);
    redoBtn.disabled = !(drawings?.canRedo);

    if (flyout) {
      for (const item of flyout.querySelectorAll('.fly-item')) {
        item.classList.toggle('active', item.dataset.tool === current);
      }
      for (const emoji of flyout.querySelectorAll('.emoji')) {
        emoji.classList.toggle('active', emoji.dataset.emoji === s.stickerEmoji);
      }
    }
  }

  // Buttons in the toolbar need the tooltip as well; the category button has
  // data-tip set at build time, management buttons get theirs in refresh().
  for (const btn of container.querySelectorAll('[data-tip]')) {
    btn.addEventListener('mouseenter', () => showTip(btn, btn.dataset.tip));
    btn.addEventListener('mouseleave', hideTip);
  }

  refresh();

  return {
    refresh,
    close: closeFlyout,
    selectTool,
    destroy() {
      closeFlyout();
      closeMini();
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('resize', closeFlyout);
      tip.remove();
    },
  };
}
