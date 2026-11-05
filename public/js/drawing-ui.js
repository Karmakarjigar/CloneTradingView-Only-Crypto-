/**
 * Floating properties panel, context menu and inline text editor for drawings.
 * Kept separate from both the toolbar and the engine.
 */

import { toolDef } from './drawings/registry.js';

export const TEXT_TYPES = new Set([
  'text', 'note', 'anchoredNote', 'signpost', 'callout', 'comment', 'priceNote',
]);

const POSITION_TYPES = new Set(['longPosition', 'shortPosition', 'positionForecast']);

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function field(label, control, extra = '') {
  return `<label class="dp-row ${extra}"><span>${label}</span>${control}</label>`;
}

export function createDrawingPanel(host, layer, opts = {}) {
  const root = el('div', 'draw-props');
  root.hidden = true;
  host.appendChild(root);

  let currentId = null;
  let currentType = null;

  function commit(patch) {
    const s = layer.selectedShape();
    if (!s) return;
    layer.begin();
    layer.update(s.id, patch, { commit: false });
    layer.commit();
  }

  const onInput = (e) => {
    const target = e.target.closest('[data-prop]');
    if (!target) return;
    const prop = target.dataset.prop;
    let value = target.value;
    if (prop === 'width' || prop === 'lineStyle' || prop === 'fontSize' || prop === 'accountSize' || prop === 'riskPercent') {
      value = Number(value);
      if (!Number.isFinite(value)) return;
    } else if (prop === 'fillOpacity') {
      value = Number(value) / 100;
      const label = root.querySelector('[data-fill]');
      if (label) label.textContent = `${target.value}%`;
    }
    commit({ [prop]: value });
  };
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);

  function build(s) {
    const def = toolDef(s.type) || {};
    const title = def.label || s.type;
    const color = s.color || '#2962ff';
    const width = String(s.width ?? 1.5);
    const style = String(s.lineStyle ?? 0);
    const fill = Math.round((s.fillOpacity ?? 0.08) * 100);
    const isText = TEXT_TYPES.has(s.type) || s.type === 'sticker';
    const isPosition = POSITION_TYPES.has(s.type);

    root.innerHTML = `
      <div class="dp-head">
        <span class="dp-title">${title}</span>
        <button class="dp-close" data-act="close" title="Close">×</button>
      </div>
      <div class="dp-body">
        ${field('Color', `<input type="color" data-prop="color" value="${color}" />`)}
        ${field('Line', `<select data-prop="width">${[1, 1.5, 2, 3, 4, 5].map((w) => `<option value="${w}"${Number(width) === w ? ' selected' : ''}>${w} px</option>`).join('')}</select>`)}
        ${field('Style', `<select data-prop="lineStyle">
          <option value="0"${style === '0' ? ' selected' : ''}>Solid</option>
          <option value="1"${style === '1' ? ' selected' : ''}>Dashed</option>
          <option value="2"${style === '2' ? ' selected' : ''}>Dotted</option>
        </select>`)}
        ${field('Fill', `<span class="dp-range"><input type="range" min="0" max="100" step="1" data-prop="fillOpacity" value="${fill}" /><b data-fill>${fill}%</b></span>`)}
        ${isText ? field('Text', `<textarea data-prop="text" rows="2" spellcheck="false">${escapeHtml(s.text || '')}</textarea>`, 'dp-wide') : ''}
        ${isText ? field('Size', `<input type="number" min="8" max="72" step="1" data-prop="fontSize" value="${s.fontSize || 12}" />`) : ''}
        ${s.type === 'sticker' ? field('Emoji', `<input type="text" maxlength="8" data-prop="emoji" value="${escapeHtml(s.emoji || '😀')}" />`) : ''}
        ${isPosition ? field('Account', `<input type="number" min="1" step="100" data-prop="accountSize" value="${s.accountSize ?? 10000}" />`) : ''}
        ${isPosition ? field('Risk %', `<input type="number" min="0.01" max="100" step="0.1" data-prop="riskPercent" value="${s.riskPercent ?? 1}" />`) : ''}
        <div class="dp-toggles">
          <button class="dp-toggle${s.locked ? ' on' : ''}" data-act="lock">${s.locked ? 'Locked' : 'Lock'}</button>
          <button class="dp-toggle${s.hidden ? ' on' : ''}" data-act="hide">${s.hidden ? 'Hidden' : 'Hide'}</button>
        </div>
        <div class="dp-actions">
          <button data-act="duplicate">Duplicate</button>
          <button data-act="front">Front</button>
          <button data-act="back">Back</button>
          <button class="danger" data-act="delete">Delete</button>
        </div>
      </div>
    `;

    root.querySelector('.dp-close').addEventListener('click', () => {
      layer.clearSelection();
    });

    root.querySelector('[data-act="lock"]').addEventListener('click', () => {
      const s2 = layer.selectedShape();
      commit({ locked: !s2.locked });
      refresh(true);
    });
    root.querySelector('[data-act="hide"]').addEventListener('click', () => {
      const s2 = layer.selectedShape();
      commit({ hidden: !s2.hidden });
      if (s2.hidden) layer.clearSelection();
      refresh(true);
    });
    root.querySelector('[data-act="duplicate"]').addEventListener('click', () => {
      layer.duplicateSelected();
      refresh(true);
    });
    root.querySelector('[data-act="front"]').addEventListener('click', () => layer.bringToFront());
    root.querySelector('[data-act="back"]').addEventListener('click', () => layer.sendToBack());
    root.querySelector('[data-act="delete"]').addEventListener('click', () => {
      layer.removeSelected();
      refresh(true);
    });
  }

  function refresh(force = false) {
    const s = layer.selectedShape();
    if (!s || layer.hiddenAll) {
      root.hidden = true;
      currentId = null;
      currentType = null;
      return;
    }
    if (force || !currentId || currentId !== s.id || currentType !== s.type) {
      currentId = s.id;
      currentType = s.type;
      build(s);
    }
    root.hidden = false;
  }

  function destroy() {
    root.remove();
  }

  return { refresh, destroy, root };
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ------------------------------------------------------------------ */

let openMenu = null;

export function closeContextMenu() {
  if (openMenu) openMenu.remove();
  openMenu = null;
}

export function openContextMenu(x, y, items) {
  closeContextMenu();
  const menu = el('div', 'draw-ctx');
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(el('div', 'ctx-sep'));
      continue;
    }
    const btn = el('button', 'ctx-item' + (item.danger ? ' danger' : ''), item.label);
    btn.disabled = Boolean(item.disabled);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.action?.();
    });
    menu.appendChild(btn);
  }
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(menu);
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = Math.min(x, window.innerWidth - mw - 8);
  const top = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  openMenu = menu;
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
  }, 0);
  return menu;
}

/* ------------------------------------------------------------------ */

export function openInlineEditor(host, { x, y, value, fontSize = 13, color = '#d1d4dc', onCommit, onCancel }) {
  const wrap = el('div', 'inline-editor');
  const input = document.createElement('textarea');
  input.value = value || '';
  input.rows = Math.max(1, String(value || '').split('\n').length);
  input.spellcheck = false;
  input.style.fontSize = `${fontSize}px`;
  input.style.color = color;
  wrap.appendChild(input);
  host.appendChild(wrap);
  wrap.style.left = `${Math.max(4, x)}px`;
  wrap.style.top = `${Math.max(4, y)}px`;

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const text = input.value;
    wrap.remove();
    if (commit) onCommit?.(text);
    else onCancel?.();
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
  });
  input.addEventListener('blur', () => finish(true));
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return { close: () => finish(false), el: wrap };
}
