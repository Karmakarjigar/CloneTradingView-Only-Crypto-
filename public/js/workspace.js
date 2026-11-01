import { ChartPane } from './pane.js';
import { uid } from './util.js';

/** Layout presets. `cells` is how many panes are visible at once. */
export const LAYOUTS = [
  { id: '1x1', label: '1 × 1', cells: 1, cols: 1, rows: 1 },
  { id: '2x1', label: '2 × 1', cells: 2, cols: 2, rows: 1 },
  { id: '3x1', label: '3 × 1', cells: 3, cols: 3, rows: 1 },
  { id: '2x2', label: '2 × 2', cells: 4, cols: 2, rows: 2 },
];

export function layoutDef(id) {
  return LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
}

/**
 * A tab in the strip. Holds a grid of 1–4 chart panes plus its own layout.
 * Shrinking a layout hides panes instead of destroying them, so raising it
 * again restores the same charts.
 */
export class Workspace {
  constructor({ id, layout = '1x1', panes = [], activePaneId = null, host, services }) {
    this.id = id || uid('ws');
    this.services = services;
    this.layout = layoutDef(layout).id;
    this.activePaneId = activePaneId;

    this.el = document.createElement('div');
    this.el.className = 'workspace';
    this.el.dataset.id = this.id;

    this.grid = document.createElement('div');
    this.grid.className = 'ws-grid';
    this.el.appendChild(this.grid);
    host.appendChild(this.el);

    this.panes = [];
    for (const cfg of panes.length ? panes : [{}]) {
      this.panes.push(this._makePane(cfg));
    }

    if (!this.panes.some((p) => p.id === this.activePaneId)) {
      this.activePaneId = this.panes[0].id;
    }

    this.applyLayoutDom();

    // Restored panes must still be loaded; new ones too.
    for (const p of this.panes) p.load();
  }

  _makePane(cfg = {}) {
    return new ChartPane({
      id: cfg.id || uid('pane'),
      symbol: cfg.symbol || 'BTCUSDT',
      interval: cfg.interval || '1D',
      indicators: cfg.indicators,
      host: this.grid,
      services: this.services,
    });
  }

  get def() {
    return layoutDef(this.layout);
  }

  activePane() {
    const visible = this.visiblePanes();
    return visible.find((p) => p.id === this.activePaneId) || visible[0] || this.panes[0];
  }

  visiblePanes() {
    return this.panes.slice(0, this.def.cells);
  }

  setLayout(id) {
    const def = layoutDef(id);
    this.layout = def.id;

    while (this.panes.length < def.cells) {
      const source = this.panes[this.panes.length - 1];
      const pane = this._makePane({
        symbol: source.symbol,
        interval: source.interval,
        indicators: [...source.indicators],
      });
      this.panes.push(pane);
      this.services.onPaneCreated?.(pane, source);
      pane.renderLink();
      pane.load();
    }

    this.panes.forEach((p, i) => {
      if (i < def.cells) p.show();
      else p.hide();
    });

    this.applyLayoutDom();

    const activeVisible = this.visiblePanes().some((p) => p.id === this.activePaneId);
    if (!activeVisible) {
      this.activePaneId = this.visiblePanes()[0]?.id || this.panes[0].id;
      for (const p of this.panes) p.deactivate();
      const pane = this.activePane();
      if (this.el.classList.contains('active') && pane) pane.activate();
    }

    requestAnimationFrame(() => {
      for (const p of this.visiblePanes()) p.chart.resize();
    });
    this.services.onDirty?.(this);
  }

  applyLayoutDom() {
    const def = this.def;
    this.grid.style.gridTemplateColumns = `repeat(${def.cols}, minmax(0, 1fr))`;
    this.grid.style.gridTemplateRows = `repeat(${def.rows}, minmax(0, 1fr))`;
    this.panes.forEach((p, i) => {
      p.el.dataset.cell = String(i + 1);
      p.el.classList.toggle('in-cell', i < def.cells);
      if (i >= def.cells) p.hide();
    });
    this.el.dataset.layout = def.id;
  }

  activate() {
    this.el.classList.add('active');
    const pane = this.activePane();
    for (const p of this.panes) p.deactivate();
    if (pane) {
      pane.activate();
      requestAnimationFrame(() => {
        for (const p of this.visiblePanes()) p.chart.resize();
      });
    }
  }

  deactivate() {
    this.el.classList.remove('active');
    for (const p of this.panes) p.deactivate();
  }

  activatePane(pane) {
    if (!pane || !this.visiblePanes().includes(pane)) return false;
    if (this.activePaneId === pane.id) return false;
    this.activePaneId = pane.id;
    for (const p of this.panes) p.deactivate();
    pane.activate();
    return true;
  }

  /* Groups live in the LinkBus, keyed by pane id; presets carry them. */
  groupOf(pane) {
    return this.services.linkInfo?.(pane.id)?.group || null;
  }

  serialize() {
    return {
      id: this.id,
      layout: this.layout,
      activePaneId: this.activePaneId,
      panes: this.panes.map((p) => p.serialize()),
    };
  }

  dispose() {
    for (const p of this.panes) p.dispose();
    this.el.remove();
  }
}
