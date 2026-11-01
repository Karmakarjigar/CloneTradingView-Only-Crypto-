/**
 * Alerts UI. Rules live on the server (lib/alerts.js) so they keep firing with
 * no browser open; this module reads them over HTTP and receives `alert`
 * events on /api/events.
 */

import { getSettings, setSetting } from './settings.js';

const LEGACY_KEY = 'tvfree.alerts.v1';
const MIGRATED_KEY = 'tvfree.alerts.migrated.v2';

/** Desktop mutes alert sounds for 30 s after startup (alert-notifier.ts). */
const STARTUP_MUTE_MS = 30000;

/** Named tone patterns; `duration` repeats the pattern like the desktop. */
const SOUNDS = {
  alert: [[880, 0, 0.16], [1320, 0.18, 0.16]],
  bell: [[1568, 0, 0.22], [2093, 0.24, 0.3]],
  ping: [[1046, 0, 0.12]],
};

export const CONDITIONS = {
  above: 'crossing up to',
  below: 'crossing down to',
  crossing: 'crossing',
};

export class AlertCenter {
  constructor({ bellButton, panelHost, getContext, onStatus, onActivateSymbol }) {
    this.bell = bellButton;
    this.panelHost = panelHost;
    this.getContext = getContext;
    this.onStatus = onStatus;
    this.onActivateSymbol = onActivateSymbol;

    this.alerts = [];
    this.log = [];
    this.settings = {};
    this.ready = false;
    this.serverOk = true;

    this.panel = null;
    this.modal = null;
    this._audio = null;
    this._refreshTimer = null;
    this._changedTimer = null;
    this._startedAt = Date.now();
    this._soundMutedUntil = this._startedAt + STARTUP_MUTE_MS;

    this.bell.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this._unlockAudio();
    this.render();
  }

  async init() {
    await this.refresh();
    await this._migrateLegacy();
    this._connectEvents();
    this.ready = true;
  }

  /* ---------------- server sync ---------------- */

  async refresh() {
    try {
      const res = await fetch('/api/alerts', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      this.alerts = payload.alerts || [];
      this.log = payload.log || [];
      this.settings = payload.settings || {};
      this.serverOk = true;
    } catch {
      this.serverOk = false;
    }
    this.render();
    if (this.panel) this.renderPanel();
  }

  _connectEvents() {
    try {
      const es = new EventSource('/api/events');
      this._es = es;

      es.addEventListener('snapshot', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (Array.isArray(data.alerts)) this.alerts = data.alerts;
          if (Array.isArray(data.log)) this.log = data.log;
          this.serverOk = true;
          this.render();
          if (this.panel) this.renderPanel();
        } catch {
          /* ignore */
        }
      });

      es.addEventListener('alert', (e) => {
        try {
          this._fired(JSON.parse(e.data));
        } catch {
          /* ignore */
        }
      });

      es.addEventListener('changed', () => {
        clearTimeout(this._changedTimer);
        this._changedTimer = setTimeout(() => this.refresh(), 350);
      });

      es.onerror = () => {
        this.serverOk = false;
      };
    } catch {
      /* EventSource missing: polling below still works */
    }
    clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => {
      if (this.panel) this.refresh();
    }, 30000);
  }

  async _migrateLegacy() {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;
      const raw = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
      localStorage.setItem(MIGRATED_KEY, '1');
      if (!Array.isArray(raw) || !raw.length) return;

      for (const a of raw) {
        if (!a || !a.symbol || !Number.isFinite(Number(a.price))) continue;
        await this._post('/api/alerts', {
          symbol: a.symbol,
          condition: a.condition || 'above',
          price: Number(a.price),
          note: a.note || '',
        }, true);
      }
      localStorage.removeItem(LEGACY_KEY);
      await this.refresh();
    } catch {
      /* migration is best-effort */
    }
  }

  /* ---------------- actions ---------------- */

  async _post(url, body, silent = false) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    if (!silent) await this.refresh();
    return payload;
  }

  async add(alert, { silent = false } = {}) {
    const created = await this._post('/api/alerts', alert, true);
    const i = this.alerts.findIndex((a) => a.id === created.id);
    if (i >= 0) this.alerts[i] = created;
    else this.alerts.unshift(created);

    this.render();
    if (this.panel) this.renderPanel();
    this._requestPermission();

    if (!silent) {
      this._toast(`Alert armed: ${created.symbol} ${created.condition} ${fmt(created.price)}`);
      this.onStatus?.('ok', `alert armed: ${created.symbol}`);
    }
    return created;
  }

  async remove(id) {
    await fetch(`/api/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.render();
    if (this.panel) this.renderPanel();
  }

  async rearm(id) {
    const res = await fetch(`/api/alerts/${encodeURIComponent(id)}/rearm`, { method: 'POST' });
    const updated = await res.json().catch(() => null);
    if (updated && !updated.error) {
      const i = this.alerts.findIndex((a) => a.id === id);
      if (i >= 0) this.alerts[i] = updated;
    }
    this.render();
    if (this.panel) this.renderPanel();
  }

  async clearFired() {
    const fired = this.alerts.filter((a) => !a.active);
    for (const a of fired) {
      await fetch(`/api/alerts/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
    }
    await this.refresh();
  }

  /* ---------------- fire path ---------------- */

  _fired(alert) {
    if (!alert || !alert.id) return;
    const i = this.alerts.findIndex((a) => a.id === alert.id);
    if (i >= 0) this.alerts[i] = alert;
    else this.alerts.unshift(alert);

    const text = `${alert.symbol} ${alert.condition} ${fmt(alert.price)} — last ${fmt(alert.triggerPrice)}`;
    this._playSound(alert.soundParams);
    this._notify(`TVFREE alert · ${alert.symbol}`, text, alert.symbol);
    this._toast(text);
    this.onStatus?.('warn', text);
    this.render();
    if (this.panel) this.renderPanel();
  }

  _unlockAudio() {
    const unlock = () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this._audio) this._audio = new Ctx();
        if (this._audio.state === 'suspended') this._audio.resume();
      } catch {
        /* ignore */
      }
    };
    document.addEventListener('pointerdown', unlock, { passive: true });
    document.addEventListener('keydown', unlock);
  }

  _requestPermission() {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch {
      /* ignore */
    }
  }

  _notify(title, body, symbol) {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const n = new Notification(title, { body, silent: true });
        // Desktop: clicking an alert notification focuses the window and
        // switches the chart to the alert's symbol.
        n.onclick = () => {
          try {
            window.focus();
            if (symbol) this.onActivateSymbol?.(symbol);
          } finally {
            n.close();
          }
        };
        setTimeout(() => n.close(), 12000);
      }
    } catch {
      /* toast still shows */
    }
  }

  soundsMuted() {
    return Date.now() < this._soundMutedUntil;
  }

  _playSound(soundParams) {
    if (this.soundsMuted()) return;

    const cfg = getSettings();
    if (cfg.alertSound === 'none') return;
    const volume = Math.max(0, Math.min(100, Number(cfg.alertVolume ?? 100))) / 100;
    if (!volume) return;

    const name = (soundParams && soundParams.name) || cfg.alertSound || 'alert';
    const pattern = SOUNDS[name] || SOUNDS.alert;
    const duration = Number((soundParams && soundParams.duration) || 0);

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this._audio) this._audio = new Ctx();
      const ctx = this._audio;
      if (ctx.state === 'suspended') ctx.resume();

      const last = pattern[pattern.length - 1];
      const cycle = last[1] + last[2] + 0.4;
      const repeats = duration > 0 ? Math.min(20, Math.ceil(duration / cycle)) : 1;

      for (let r = 0; r < repeats; r += 1) {
        for (const [freq, offset, len] of pattern) {
          const at = ctx.currentTime + r * cycle + offset;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.18 * volume, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.02 + len);
          osc.connect(gain).connect(ctx.destination);
          osc.start(at);
          osc.stop(at + 0.04 + len);
        }
      }
      this.lastSoundAt = Date.now();
    } catch {
      /* audio blocked until the first gesture */
    }
  }

  _toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<b>Alert</b><span>${escapeHtml(text)}</span>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 5000);
  }

  /* ---------------- UI ---------------- */

  toggle() {
    if (this.panel) this.close();
    else this.open();
  }

  async open() {
    this.close();
    const panel = document.createElement('div');
    panel.className = 'alert-panel';
    panel.addEventListener('click', (e) => e.stopPropagation());
    this.panelHost.appendChild(panel);
    this.panel = panel;
    this.renderPanel();

    this._outside = (e) => {
      if (this.panel && !this.panel.contains(e.target) && e.target !== this.bell) this.close();
    };
    setTimeout(() => document.addEventListener('click', this._outside), 0);

    await this.refresh();
  }

  close() {
    if (this._outside) document.removeEventListener('click', this._outside);
    this._outside = null;
    if (this.panel) this.panel.remove();
    this.panel = null;
  }

  render() {
    const active = this.alerts.filter((a) => a.active).length;
    const total = this.alerts.length;
    this.bell.classList.toggle('has-alerts', active > 0);

    let badge = this.bell.querySelector('.bell-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'bell-count';
      this.bell.appendChild(badge);
    }
    badge.textContent = active || '';
    badge.hidden = active === 0;

    const delivery = this.settings.webhookSet || this.settings.telegramSet;
    this.bell.title =
      `${active} active alert${active === 1 ? '' : 's'} (${total} total)` +
      `${delivery ? ' · server delivery on' : ''}`;

    if (this.panel) this.renderPanel();
  }

  renderPanel() {
    if (!this.panel) return;

    const rows = this.alerts.map((a) => {
      const fired = !a.active && a.triggeredAt;
      return `
        <div class="alert-row ${a.active ? '' : 'fired'}">
          <div class="ar-head">
            <span class="ar-sym">${escapeHtml(a.symbol)}</span>
            <span class="ar-cond">${a.condition === 'above' ? '≥' : a.condition === 'below' ? '≤' : '⤫'} ${fmt(a.price)}</span>
            <button class="ar-del" data-del="${a.id}" title="Delete">×</button>
          </div>
          <div class="ar-sub">
            ${fired
              ? `<span class="ar-fired">fired ${new Date(a.triggeredAt).toLocaleTimeString('en-GB', { hour12: false })} @ ${fmt(a.triggerPrice)}</span>
                 <button class="ar-rearm" data-rearm="${a.id}">re-arm</button>`
              : `<span class="ar-live">armed${a.lastSeen != null ? ` · last ${fmt(a.lastSeen)}` : ''}</span>`}
            ${a.note ? `<span class="ar-note">${escapeHtml(a.note)}</span>` : ''}
          </div>
        </div>`;
    });

    const deliveryLine = this.settings.webhookSet || this.settings.telegramSet
      ? [this.settings.webhookSet ? `webhook ${this.settings.webhookHost || ''}` : '', this.settings.telegramSet ? 'Telegram' : '']
        .filter(Boolean)
        .join(' · ')
      : 'browser notifications only';

    this.panel.innerHTML = `
      <div class="ap-head">
        <span>Alerts</span>
        <div class="ap-actions">
          <button class="ar-icon" id="btnAlertSettings" title="Delivery settings">⚙</button>
          <button class="btn tiny" id="btnNewAlert">+ New</button>
        </div>
      </div>
      <div class="ap-list">
        ${rows.length ? rows.join('') : '<div class="ap-empty">No alerts yet.<br><span>They keep running when this tab is closed.</span></div>'}
      </div>
      <div class="ap-foot">
        <span class="ap-delivery ${this.serverOk ? '' : 'off'}">${this.serverOk ? deliveryLine : 'server offline'}</span>
        <button class="ap-clear" id="btnClearFired">clear fired</button>
      </div>
    `;

    this.panel.querySelector('#btnNewAlert').addEventListener('click', () => this.openCreate());
    this.panel.querySelector('#btnAlertSettings').addEventListener('click', () => this.openSettings());
    this.panel.querySelector('#btnClearFired').addEventListener('click', () => this.clearFired());
    this.panel.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => this.remove(b.dataset.del)),
    );
    this.panel.querySelectorAll('[data-rearm]').forEach((b) =>
      b.addEventListener('click', () => this.rearm(b.dataset.rearm)),
    );
  }

  openCreate() {
    this.close();
    const ctx = this.getContext?.() || {};
    const symbol = ctx.symbol || 'BTCUSDT';
    const price = Number.isFinite(ctx.price) && ctx.price > 0 ? Number(ctx.price.toFixed(2)) : 0;

    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal">
        <div class="modal-head">New alert</div>
        <label class="field">
          <span>Symbol</span>
          <input id="alSymbol" value="${escapeHtml(symbol)}" spellcheck="false" />
        </label>
        <label class="field">
          <span>Condition</span>
          <select id="alCond">
            <option value="above">Price ≥</option>
            <option value="below">Price ≤</option>
            <option value="crossing" selected>Price crossing</option>
          </select>
        </label>
        <label class="field">
          <span>Price</span>
          <input id="alPrice" type="number" step="any" value="${price}" />
        </label>
        <label class="field">
          <span>Note <em>optional</em></span>
          <input id="alNote" placeholder="why this level matters" />
        </label>
        <div class="modal-hint">Runs on the local server on every Binance trade tick — no tab needed.</div>
        <div class="modal-actions">
          <button class="btn" id="alCancel">Cancel</button>
          <button class="btn primary" id="alCreate">Create alert</button>
        </div>
      </div>
    `;
    document.body.appendChild(back);
    this.modal = back;

    const close = () => {
      back.remove();
      this.modal = null;
    };
    back.addEventListener('click', (e) => {
      if (e.target === back) close();
    });
    back.querySelector('#alCancel').addEventListener('click', close);

    const create = async () => {
      const sym = back.querySelector('#alSymbol').value.trim().toUpperCase();
      const condition = back.querySelector('#alCond').value;
      const priceVal = Number(back.querySelector('#alPrice').value);
      const note = back.querySelector('#alNote').value.trim();
      if (!sym || !Number.isFinite(priceVal) || priceVal <= 0) {
        back.querySelector('#alPrice').focus();
        return;
      }
      const btn = back.querySelector('#alCreate');
      btn.disabled = true;
      try {
        await this.add({ symbol: sym, condition, price: priceVal, note });
        close();
        this.open();
      } catch (err) {
        btn.disabled = false;
        this._toast(`could not create alert: ${err.message}`);
      }
    };

    back.querySelector('#alCreate').addEventListener('click', create);
    back.querySelector('#alPrice').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
    });

    setTimeout(() => back.querySelector('#alPrice').select(), 30);
  }

  openSettings() {
    this.close();
    const s = this.settings;
    const local = getSettings();
    const vol = Math.max(0, Math.min(100, Number(local.alertVolume ?? 100)));
    const sound = local.alertSound || 'alert';

    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal">
        <div class="modal-head">Alert delivery</div>
        <div class="modal-hint">
          Alerts run on the server. Add a webhook or a Telegram bot to get them
          off-machine; browser notifications cover the open-tab case. Sounds are
          muted for the first 30 seconds after startup.
        </div>
        <label class="field">
          <span>Sound</span>
          <select id="setSound">
            <option value="alert">Alert</option>
            <option value="bell">Bell</option>
            <option value="ping">Ping</option>
            <option value="none">None</option>
          </select>
        </label>
        <label class="field">
          <span>Volume <em id="volLabel">${vol}%</em></span>
          <input id="setVolume" type="range" min="0" max="100" step="5" value="${vol}" />
        </label>
        <label class="field">
          <span>Webhook URL <em>${s.webhookSet ? `configured — ${escapeHtml(s.webhookHost || '')}` : 'optional'}</em></span>
          <input id="setWebhook" placeholder="${s.webhookSet ? 'enter a new URL to replace' : 'https://example.com/hook'}" spellcheck="false" />
        </label>
        <label class="field">
          <span>Telegram bot token <em>${s.telegramSet ? 'configured' : 'optional'}</em></span>
          <input id="setTelegramToken" placeholder="${s.telegramSet ? 'enter a new token to replace' : '123456:ABC…'}" spellcheck="false" />
        </label>
        <label class="field">
          <span>Telegram chat ID <em>${s.telegramChatSet ? 'configured' : 'optional'}</em></span>
          <input id="setTelegramChat" placeholder="${s.telegramChatSet ? 'enter a new chat ID to replace' : '-1001234567890'}" spellcheck="false" />
        </label>
        <div class="modal-actions spread">
          <button class="btn danger" id="setClear">Clear delivery</button>
          <span class="grow"></span>
          <button class="btn" id="setCancel">Cancel</button>
          <button class="btn primary" id="setSave">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(back);
    this.modal = back;

    const close = () => {
      back.remove();
      this.modal = null;
    };
    back.addEventListener('click', (e) => {
      if (e.target === back) close();
    });
    back.querySelector('#setCancel').addEventListener('click', close);

    const soundEl = back.querySelector('#setSound');
    soundEl.value = sound;
    const volEl = back.querySelector('#setVolume');
    volEl.addEventListener('input', () => {
      back.querySelector('#volLabel').textContent = `${volEl.value}%`;
    });

    back.querySelector('#setSave').addEventListener('click', async () => {
      setSetting('alertSound', soundEl.value);
      setSetting('alertVolume', Number(volEl.value));

      const body = {};
      const webhook = back.querySelector('#setWebhook').value.trim();
      const token = back.querySelector('#setTelegramToken').value.trim();
      const chat = back.querySelector('#setTelegramChat').value.trim();
      if (webhook) body.webhookUrl = webhook;
      if (token) body.telegramToken = token;
      if (chat) body.telegramChatId = chat;

      if (!Object.keys(body).length) {
        close();
        this._toast(`alert sound: ${soundEl.value === 'none' ? 'muted' : soundEl.value} at ${volEl.value}%`);
        this.open();
        return;
      }
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        this.settings = await res.json();
        close();
        this._toast('alert delivery updated');
        this.open();
      } catch (err) {
        this._toast(`could not save: ${err.message}`);
      }
    });

    back.querySelector('#setClear').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear: true }),
        });
        this.settings = await res.json();
        close();
        this._toast('delivery settings cleared');
        this.open();
      } catch (err) {
        this._toast(`could not clear: ${err.message}`);
      }
    });
  }
}

function fmt(p) {
  if (!Number.isFinite(p)) return '—';
  const abs = Math.abs(p);
  const d = abs >= 10 ? 2 : abs >= 0.01 ? 4 : 6;
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
