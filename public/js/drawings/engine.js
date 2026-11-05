/**
 * Drawing engine: selection, editing, history, magnet snapping and storage.
 * Rendering/hit geometry is delegated to render.js so this class stays about
 * object state and user intent.
 */

import { toolDef, TOOLS } from './registry.js';
import { drawingStore } from './store.js';
import { clamp } from './geometry.js';
import { renderShape, hitShape, shapeHandles } from './render.js';

const HISTORY_LIMIT = 80;

function uid() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function defaultsFor(type) {
  const def = toolDef(type) || TOOLS[type] || {};
  return {
    color: def.color || '#2962ff',
    width: def.width ?? 1.5,
    lineStyle: def.lineStyle ?? 0,
    fillOpacity: def.fillOpacity ?? 0.08,
    fontSize: def.fontSize ?? 12,
    text: def.text ?? '',
    emoji: def.emoji ?? '😀',
    accountSize: def.accountSize,
    riskPercent: def.riskPercent,
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type || 'trend';
  const shape = {
    ...defaultsFor(type),
    ...raw,
    id: raw.id || uid(),
    type,
    points: Array.isArray(raw.points) ? raw.points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p)) : [],
    locked: Boolean(raw.locked),
    hidden: Boolean(raw.hidden),
  };
  if (!shape.points.length) return null;
  return shape;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class DrawingLayer {
  constructor({ store = drawingStore } = {}) {
    this.store = store;
    this.shapes = [];
    this.symbol = null;
    this.selectedId = null;
    this.selectedIds = new Set();
    this.preview = null;

    const settings = store.loadSettings();
    this.magnet = settings.magnet;
    this.hiddenAll = settings.hiddenAll;
    this.lockedAll = settings.lockedAll;

    this.undoStack = [];
    this.redoStack = [];
    this.clipboard = store.loadClipboard();
    this.onChange = null;
    this._before = null;
    this._project = null;
    this._lastSnap = null;
  }

  /* ---------------- lifecycle ---------------- */

  load(symbol) {
    if (this.symbol) this.persist();
    this.symbol = symbol;
    this.shapes = this.store.load(symbol).map(normalize).filter(Boolean);
    this.selectedId = null;
    this.selectedIds.clear();
    this.preview = null;
    this.undoStack = [];
    this.redoStack = [];
    this._before = null;
    this.emit();
  }

  persist() {
    if (!this.symbol) return;
    this.store.save(this.symbol, this.shapes);
  }

  emit() {
    if (this.onChange) this.onChange(this);
  }

  /* ---------------- history ---------------- */

  begin() {
    if (this._before == null) this._before = JSON.stringify(this.shapes);
  }

  commit() {
    if (this._before != null) {
      const now = JSON.stringify(this.shapes);
      if (now !== this._before) {
        this.undoStack.push(this._before);
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
        this.redoStack.length = 0;
        this.persist();
      }
      this._before = null;
    }
    this.emit();
  }

  cancel() {
    if (this._before != null) {
      try { this.shapes = JSON.parse(this._before); } catch { /* ignore */ }
      this._before = null;
    }
    this.emit();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.shapes));
    this.shapes = JSON.parse(this.undoStack.pop());
    this.selectedId = null;
    this.selectedIds.clear();
    this.persist();
    this.emit();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.shapes));
    this.shapes = JSON.parse(this.redoStack.pop());
    this.selectedId = null;
    this.selectedIds.clear();
    this.persist();
    this.emit();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /* ---------------- CRUD ---------------- */

  add(raw, { select = true, emit = true } = {}) {
    const shape = normalize(raw);
    if (!shape) return null;
    this.begin();
    this.shapes.push(shape);
    if (select) this.select(shape.id, { emit: false });
    if (emit) this.commit();
    return shape;
  }

  addMany(list, { select = false } = {}) {
    if (!Array.isArray(list) || !list.length) return [];
    this.begin();
    const added = [];
    for (const raw of list) {
      const shape = normalize(raw);
      if (shape) {
        shape.id = uid();
        this.shapes.push(shape);
        added.push(shape);
      }
    }
    if (select && added.length) this.select(added[added.length - 1].id, { emit: false });
    this.commit();
    return added;
  }

  remove(id, { emit = true } = {}) {
    const i = this.shapes.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.begin();
    this.shapes.splice(i, 1);
    this.selectedIds.delete(id);
    if (this.selectedId === id) this.selectedId = [...this.selectedIds][0] || null;
    if (emit) this.commit();
    return true;
  }

  removeSelected() {
    if (!this.selectedIds.size) return false;
    this.begin();
    const ids = new Set(this.selectedIds);
    this.shapes = this.shapes.filter((s) => !ids.has(s.id));
    this.selectedId = null;
    this.selectedIds.clear();
    this.commit();
    return true;
  }

  removeAll() {
    if (!this.shapes.length) return false;
    this.begin();
    this.shapes = [];
    this.selectedId = null;
    this.selectedIds.clear();
    this.commit();
    return true;
  }

  clear() {
    return this.removeAll();
  }

  update(id, patch, { commit = true } = {}) {
    const s = this.shapes.find((x) => x.id === id);
    if (!s) return null;
    if (this.isLocked(s) && !('locked' in patch)) return null;
    if (commit) this.begin();
    Object.assign(s, patch);
    if (commit) this.commit();
    return s;
  }

  get(id) {
    return this.shapes.find((s) => s.id === id) || null;
  }

  /* ---------------- selection ---------------- */

  select(id, { additive = false, emit = true } = {}) {
    if (!id) {
      this.selectedId = null;
      this.selectedIds.clear();
    } else if (additive) {
      if (this.selectedIds.has(id)) this.selectedIds.delete(id);
      else this.selectedIds.add(id);
      this.selectedId = this.selectedIds.has(id) ? id : [...this.selectedIds][0] || null;
    } else {
      this.selectedIds.clear();
      this.selectedIds.add(id);
      this.selectedId = id;
    }
    if (emit) this.emit();
  }

  selectAll() {
    this.selectedIds = new Set(this.visibleShapes().filter((s) => !this.isLocked(s)).map((s) => s.id));
    this.selectedId = [...this.selectedIds][0] || null;
    this.emit();
  }

  clearSelection() {
    this.select(null);
  }

  selectedShapes() {
    return this.shapes.filter((s) => this.selectedIds.has(s.id));
  }

  selectedShape() {
    return this.selectedId ? this.get(this.selectedId) : null;
  }

  isLocked(shape) {
    return Boolean(this.lockedAll || shape?.locked);
  }

  isHidden(shape) {
    return Boolean(this.hiddenAll || shape?.hidden);
  }

  visibleShapes() {
    return this.shapes.filter((s) => !this.isHidden(s));
  }

  /* ---------------- settings ---------------- */

  settingsSnapshot() {
    return {
      ...this.store.loadSettings(),
      magnet: this.magnet,
      hiddenAll: this.hiddenAll,
      lockedAll: this.lockedAll,
    };
  }

  saveSettings(patch = {}) {
    const next = { ...this.store.loadSettings(), ...patch };
    this.store.saveSettings(next);
    return next;
  }

  setMagnet(mode, { save = true } = {}) {
    this.magnet = mode === 'weak' || mode === 'strong' ? mode : 'off';
    if (save) this.saveSettings({ magnet: this.magnet });
    this.emit();
  }

  cycleMagnet() {
    const next = this.magnet === 'off' ? 'weak' : this.magnet === 'weak' ? 'strong' : 'off';
    this.setMagnet(next);
    return next;
  }

  setHiddenAll(value, { save = true } = {}) {
    this.hiddenAll = Boolean(value);
    if (save) this.saveSettings({ hiddenAll: this.hiddenAll });
    if (this.hiddenAll) this.clearSelection();
    this.emit();
  }

  setLockedAll(value, { save = true } = {}) {
    this.lockedAll = Boolean(value);
    if (save) this.saveSettings({ lockedAll: this.lockedAll });
    this.emit();
  }

  /* ---------------- pointer math ---------------- */

  snapPoint(t, p, chart, project, mode = this.magnet) {
    if (!mode || mode === 'off' || !chart?.bars?.length) return { t, p };
    const bars = chart.bars;
    const idx = clamp(Math.round(chart.indexForTime(t)), 0, bars.length - 1);
    const bar = bars[idx];
    if (!bar) return { t, p };
    const rawX = project.x(t);
    const rawY = project.y(p);
    let best = null;
    let bestD = Infinity;
    for (const candidate of [bar.o, bar.h, bar.l, bar.c]) {
      const d = Math.abs(project.y(candidate) - rawY);
      if (d < bestD) { bestD = d; best = candidate; }
    }
    const strong = mode === 'strong';
    const snappedP = strong || bestD <= 10 ? best : p;
    const barX = project.x(bar.t);
    const snappedT = strong || Math.abs(barX - rawX) <= 14 ? bar.t : t;
    this._lastSnap = { x: project.x(snappedT), y: project.y(snappedP), t: snappedT, p: snappedP };
    return { t: snappedT, p: snappedP };
  }

  hitTest(x, y, project, opts = {}) {
    if (this.hiddenAll) return null;
    const includeLocked = Boolean(opts.includeLocked);
    for (let i = this.shapes.length - 1; i >= 0; i -= 1) {
      const s = this.shapes[i];
      if (this.isHidden(s)) continue;
      if (!includeLocked && this.isLocked(s)) continue;
      if (hitShape(s, x, y, project, opts)) return s;
    }
    return null;
  }

  handleAt(x, y, project, radius = 9) {
    const s = this.selectedShape();
    if (!s || this.isLocked(s)) return null;
    const handles = shapeHandles(s, project);
    let best = null;
    let bestD = radius;
    for (const h of handles) {
      const d = Math.hypot(x - h.x, y - h.y);
      if (d <= bestD) { bestD = d; best = h; }
    }
    return best ? { shape: s, handle: best } : null;
  }

  getHandles(shape, project) {
    return shapeHandles(shape, project);
  }

  moveShape(id, dPrice, dIndex, project) {
    const s = this.get(id);
    if (!s || this.isLocked(s)) return;
    const timeOnly = s.type === 'vline';
    const priceOnly = s.type === 'hline' || s.type === 'hray';
    for (const pt of s.points) {
      if (!priceOnly) pt.t = project.shiftTime(pt.t, dIndex);
      if (!timeOnly) pt.p += dPrice;
    }
  }

  moveSelected(dPrice, dIndex, project) {
    for (const s of this.selectedShapes()) this.moveShape(s.id, dPrice, dIndex, project);
  }

  setPoint(id, index, t, p) {
    const s = this.get(id);
    if (!s || this.isLocked(s)) return;
    const pt = s.points[index];
    if (!pt) return;
    const timeOnly = s.type === 'vline';
    const priceOnly = s.type === 'hline' || s.type === 'hray';
    if (!priceOnly) pt.t = t;
    if (!timeOnly) pt.p = p;
  }

  setPointScreen(id, index, x, y, chart, project, useMagnet = true) {
    const data = chart.dataAt(x, y);
    const point = useMagnet ? this.snapPoint(data.time, data.price, chart, project) : { t: data.time, p: data.price };
    this.setPoint(id, index, point.t, point.p);
    return point;
  }

  /* ---------------- clipboard / order ---------------- */

  copySelected() {
    const selected = this.selectedShapes();
    if (!selected.length) return false;
    this.clipboard = clone(selected).map((s) => { delete s.id; return s; });
    this.store.saveClipboard(this.clipboard);
    return true;
  }

  paste() {
    if (!this.clipboard.length) this.clipboard = this.store.loadClipboard();
    if (!this.clipboard.length) return null;
    const project = this._project;
    this.begin();
    const added = [];
    for (const raw of this.clipboard) {
      const shape = normalize(raw);
      if (!shape) continue;
      shape.id = uid();
      const timeOnly = shape.type === 'vline';
      const priceOnly = shape.type === 'hline' || shape.type === 'hray';
      for (const pt of shape.points) {
        if (!priceOnly) pt.t = project ? project.shiftTime(pt.t, 6) : pt.t + 360000;
        if (!timeOnly) pt.p *= 1.002;
      }
      this.shapes.push(shape);
      added.push(shape);
    }
    if (added.length) this.select(added[added.length - 1].id, { emit: false });
    this.commit();
    return added;
  }

  duplicateSelected() {
    if (!this.selectedShapes().length) return null;
    this.copySelected();
    return this.paste();
  }

  bringToFront() {
    if (!this.selectedIds.size) return;
    this.begin();
    const picked = this.shapes.filter((s) => this.selectedIds.has(s.id));
    this.shapes = this.shapes.filter((s) => !this.selectedIds.has(s.id)).concat(picked);
    this.commit();
  }

  sendToBack() {
    if (!this.selectedIds.size) return;
    this.begin();
    const picked = this.shapes.filter((s) => this.selectedIds.has(s.id));
    this.shapes = picked.concat(this.shapes.filter((s) => !this.selectedIds.has(s.id)));
    this.commit();
  }

  toggleLockSelected() {
    const selected = this.selectedShapes();
    if (!selected.length) return;
    this.begin();
    const lock = !selected.every((s) => s.locked);
    for (const s of selected) s.locked = lock;
    this.commit();
  }

  toggleHideSelected() {
    const selected = this.selectedShapes();
    if (!selected.length) return;
    this.begin();
    const hide = !selected.every((s) => s.hidden);
    for (const s of selected) s.hidden = hide;
    this.commit();
    if (hide) this.clearSelection();
  }

  /* ---------------- render ---------------- */

  draw(ctx, project, opts = {}) {
    this._project = project;
    const rect = {
      left: project.left ?? 0,
      top: project.top ?? 0,
      right: project.right ?? project.width,
      bottom: project.bottom ?? 100000,
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left, rect.top, Math.max(1, rect.right - rect.left), Math.max(1, rect.bottom - rect.top));
    ctx.clip();

    const ro = { ...opts, bars: opts.bars || project.bars || [] };
    for (const s of this.shapes) {
      if (this.isHidden(s)) continue;
      renderShape(ctx, s, project, ro);
    }
    if (this.preview) {
      renderShape(ctx, this.preview, project, { ...ro, preview: true });
    }

    // Handles sit above every shape.
    for (const s of this.selectedShapes()) {
      if (this.isHidden(s)) continue;
      this.drawHandles(ctx, s, project);
    }
    ctx.restore();
  }

  drawHandles(ctx, s, project) {
    const handles = shapeHandles(s, project);
    const color = s.color || '#2962ff';
    for (const h of handles) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(h.x, h.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#131722';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(h.x, h.y, 1.4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }
  }
}

export { normalize as normalizeShape, defaultsFor };
