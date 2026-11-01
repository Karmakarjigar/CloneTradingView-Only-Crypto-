# TVFREE — build plan (phase 3)

Order mattered: layout refactor touches every UI file, so it landed before
alerts and trading UI. Data trust was server-only and went first.

## 1. Data trust  (lib/market.js) — done
- [x] Longer history per timeframe: 1h/4h `1y`, 1D `5y`, 1W `10y`
      (NSE 1h 1706 bars, 4h 490, 1D 1236, 1W 523; Binance 1D 1000)
- [x] Bar hygiene: sort, dedupe, drop non-finite/zero, clamp H/L (0 bad rows)
- [x] Session-anchored 4h aggregation (NSE 4h first bar 09:15 IST)
- [x] Expose `asOf`, `splitAdjusted`, `splitEvents`, `marketState`
- [x] Quote fetch concurrency 4 instead of sequential (15 s → ~3 s)

## 2. Multi-chart layouts  (workspace.js, pane.js, app.js) — done
- [x] Tab = workspace; workspace holds 1–4 chart panes
- [x] Layouts 1x1, 2x1, 3x1, 2x2; hidden panes survive shrinking
- [x] Per-pane link dot; groups span cells and tabs
- [x] Default channels crosshair + time (symbol linking is opt-in)
- [x] Saved layouts: name, save, apply, delete, export
- [x] Persistence `tvfree.workspaces.v2` + v1 tab migration (active maps)
- [x] Verified: 4 distinct symbols, crosshair+time linked, symbol not linked,
      focus chrome, preset round-trip, shrink/regrow, reload restore,
      no console errors

## 3. Server-side alerts  (lib/alerts.js, server.js, public/js/alerts.js) — done
- [x] Durable store `data/alerts.json` with CRUD API
- [x] Evaluator runs on every Binance trade tick; fires with no tab open
- [x] SSE `/api/events` → snapshot, changed, alert, heartbeat
- [x] Webhook + Telegram delivery; tokens masked in `publicSettings()`
- [x] Panel reads/writes server, live repaint on open, one-time migration
- [x] Verified: create/validation, live tick fired in under a second with no
      browser, SSE `alert` event, re-arm, delete, 404 path, settings save/clear,
      panel live repaint, external-create toast, no console errors

## 4. Paper trading  (public/js/trading.js) — done
- [x] Account: cash, positions, realized, fills, equity samples in localStorage
- [x] Market + limit orders, buy/sell, qty, crossing limits fill immediately
- [x] Limits evaluated on every live trade tick, with cash/holding checks
- [x] Chart: dashed average/limit levels + fill markers, clipped to the plot
- [x] Trade panel: account, sparkline, ticket, positions, orders, fills, reset
- [x] Verified: 10 @ 100 → cash 99,000; sell 4 @ 110 → realized +40;
      mark at 90 → equity 99,980 / open −60; close 6 @ 90 → realized −20;
      insufficient sell rejected; two-step reset; reload persistence;
      levels/markers painted; no console errors

## 5. Docs + regression — done
- [x] README rewritten for layouts, server alerts, trading, data trust
- [x] Removed unused `public/js/tab.js` and its import alias
- [x] Full CDP regression pass (grid, links, replay, drawings, alerts, trading)
- [x] Screenshots reviewed; zero console errors

## 6. Binance live pack  (binance-live.js, tick-engine.js, public/js/client-live.js) — done
- [x] WebSocket ticks + klines, reconnect with backoff and host rotation
- [x] SSE fan-out per symbol: `tick`, `candle`, `fill`; `/api/price`, `/api/history`
- [x] Live candles fold into the last bar in place (`pane.applyLiveCandle`)
- [x] Interval normalization (`1D` → `1d`) and a stream whitelist, so an invalid
      name can never poison the socket and kill ticks
- [x] REST 20 s refresh demoted to fallback for panes with a live feed
- [x] Verified: 10–11 candles applied per 21 s, bar close tracks quotes,
      tick-driven alert fired over SSE, crypto gating, zero console errors

## 7. Desktop-shell parity  (linking.js, settings.js, alerts.js, app.js) — done
- [x] Recovered the original main-process TypeScript from `app.asar` →
      `index.js.map` (1,371 sources) and read `src/linking/*`,
      `services/window/tab/tv-tab-linking-agent.ts`, `notification/alert-notifier.ts`,
      `utils/hotkey-service.ts`, `services/settings/tabs.ts`
- [x] Link channels now match the desktop tuple: symbol / interval / time /
      dateRange with symbol-only defaults (was crosshair + time)
- [x] Focus-only broadcast, 500 ms debounce that merges channels into one
      update, `time` dropped while `dateRange` is on
- [x] time / dateRange excluded from `tvfree.links.v1`; crosshair moved to an
      app-wide switch
- [x] `saveSymbolInterval` (default on) gates per-tab symbol/interval restore;
      `⚙` menu + `Ctrl+,`
- [x] Alert sound parity: `alert/bell/ping/none`, volume, 30 s startup mute,
      notification click → focus + switch symbol
- [x] Desktop hotkeys: Ctrl+T/W/Shift+T/U, Ctrl+Tab/PageDown/PageUp, Ctrl+1…9,
      Ctrl+F4, Ctrl+R, F5, F11, Ctrl+,
- [x] Verified headlessly (24 checks): channel defaults, focus gating,
      debounce window, group isolation, interval opt-in, time/dateRange
      exclusion + persistence, restore on/off, seven hotkeys, sound mute and
      volume, click-to-symbol; plus crypto 2×2 smoke and a live tick alert run,
      zero console errors
- [x] Reconnect backoff only resets after 5 s of a healthy socket, and a
      repeating socket error logs once per 30 s (was one line per retry)
- [ ] Unverified and left as-is: indicator maths, replay stepping, alert
      evaluation, paper fills, crosshair rendering — not present in the shell
