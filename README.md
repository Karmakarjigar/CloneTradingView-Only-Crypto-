# CloneTradingView

A local charting terminal with a TradingView-shaped workflow, running on free
Binance market data. No account, no subscription. Ships as an installable
Windows desktop app, and the same chart still runs from a tiny Node server if
you prefer a browser.

## Install (Windows)

1. Download `CloneTradingView-Setup-<version>.exe` (built into `dist/`).
2. Run it and choose an install folder if you want one.
3. Launch **CloneTradingView** from the Start Menu or desktop shortcut.

The installed app starts its own local chart server on a free loopback port
(`5577` and up), then opens the chart in a desktop window. Alerts, drawings and
market cache live in `%APPDATA%\CloneTradingView`, so they survive upgrades.
Uninstall through **Settings → Apps → CloneTradingView**.

The installer is unsigned, so Windows SmartScreen may show “Unknown publisher”
the first time. Choose **More info → Run anyway**, or build it yourself below.

## Run from source

```
start.bat                 # or: npm start
http://127.0.0.1:5577
```

For server/browser mode, Node 18+ is the only requirement — nothing to install
and no build step. The desktop shell and installer use Electron:

```
npm install
npm run desktop           # dev desktop window
npm run dist              # build dist/CloneTradingView-Setup-<version>.exe
```

If Electron or the NSIS tooling downloads slowly, point the build at a mirror:

```
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

---

## What works

**Charting**
- Candlesticks, wicks, volume pane, last-price line, watermark
- Pan freely in both axes: drag sideways to scroll time, drag up/down to move
  the price window (vertical drag pins it until reset)
- Zoom with the wheel, fit with double-click
- Drag the price axis up to stretch / down to compress the chart vertically;
  drag the time axis to change bar spacing. Wheel over an axis zooms just that
  axis, and double-clicking an axis resets it (double-click the plot resets both)
- Crosshair with time and price tags, OHLCV legend that follows the cursor
- Timeframes: `1m 5m 15m 30m 1h 4h 1D 1W` (`4h` is aggregated from hourly,
  anchored to each exchange session's first bar)

**Multi-chart layouts**
- Layout picker in the tab strip: `1×1`, `2×1`, `3×1`, `2×2`
- Every tab is a *workspace* holding 1–4 independent charts
- Shrinking a layout hides charts instead of destroying them, so growing it
  again restores the same symbols, timeframes and indicators
- Click a cell to focus it; the top bar, indicator menu and drawing tools
  follow the focused chart
- `Alt+1…4` switches layout; layout + all cells persist across reloads

**Saved layouts**
- Layout menu → name it (`Bitcoin night`, `Altcoins`, …) → Save
- Restores grid, symbols, timeframes, indicators and each cell's link group
- Export all saved layouts as JSON; the last 30 are kept
- `⚙` → *Remember symbol & interval per tab* (on by default). Turn it off and a
  tab reopens on the default symbol but keeps its layout and indicators

**Link groups**
- Every chart has a coloured dot (top-right of the cell and on its tab)
- Charts in one group share the channels you enable: **symbol**, **interval**,
  **time**, **date range** — symbol only by default, so a 2×2 can hold four
  different symbols
- Only the focused chart broadcasts, and bursts are merged over 500 ms — the
  same rules the desktop shell uses
- `time` / `date range` are live-only: never written to storage, reset on reload
- Crosshair sync is a separate app-wide switch in `⚙` (on by default)
- Groups work across cells and across tabs

**Indicators** (Indicators menu)
- Overlays: MA 20, MA 50, EMA 200, Bollinger 20, session VWAP
- Panes: RSI 14 (with 30/70 guides), MACD 12/26/9 (histogram + signal)
- History is sized for indicator warm-up (a year of hourly, 5 years of daily)

**Alerts — server-side**
- Bell menu → `+ New`: price ≥ / ≤ / crossing, with a note
- Rules live in `data/alerts.json` and are evaluated by the **server on every
  Binance trade tick**, so they keep firing with the browser closed
- Symbols are subscribed/unsubscribed over WebSocket as alerts are created or
  deleted, so idle symbols cost nothing
- Open tabs receive fired alerts over SSE (`/api/events`): toast, sound and
  desktop notification
- Sound follows the desktop shell: `alert` / `bell` / `ping` / `none`, volume
  0–100, and **muted for the first 30 s after startup**
- Clicking a notification focuses the window and switches the chart to the
  alert's symbol
- Fired alerts stay in the list with trigger time/price; one click re-arms
- Delivery settings: webhook (JSON POST) and/or a Telegram bot. Tokens are
  stored server-side and never sent back to the browser
- Existing browser-only alerts are migrated to the server once

**Paper trading**
- Right sidebar → `Trade`: virtual cash, market and limit orders, positions,
  working orders and recent fills
- Account equity, cash, realized and open P&L, plus an equity sparkline
- Positions draw a dashed average-price line on the chart; fills draw entry
  markers; working limits show as dashed order lines
- Limit orders are checked against every live trade tick and fill when crossed
- Click `close` on a position to exit at market; reset is two-step
- The whole account persists in `localStorage`

**Bar replay**
- `Replay` in the tab strip rewinds to a bar and pauses live updates
- Step back/forward, play at 0.5×–5×, exit to return to realtime
- Legend, last-price line and indicators follow the replay cursor
- Replay is per chart, so a 2×2 can replay one cell while others stay live

**Drawing**
- TradingView-style left toolbar with eight flyout categories: Cursor, Trend
  Line, Fibonacci & Gann, Patterns, Forecasting & Measurement, Geometric
  Shapes, Text & Annotation, and Icons & Stickers (85 drawing tools)
- Draw by dragging or by clicking anchors; multi-point tools finish on the
  last click, paths/brush finish on double-click or `Enter`
- Fibonacci retracement/extension/time/channel/fan/circles/spiral/arcs/wedge,
  pitchforks, Gann box/square/fan, XABCD/ABCD/elliott/head-and-shoulders,
  channels, ranges, volume profile, anchored VWAP, text notes and stickers
- Long/Short/Position Forecast show entry, stop, target, R:R, risk %, size,
  potential profit and loss, recalculated while the level handles are dragged
- Every drawing is anchored to timestamp and price, so it survives zoom, pan,
  timeframe and chart-type changes
- Select, move, resize, duplicate, copy/paste, delete; per-drawing color, line
  width, line style, fill opacity and text size; properties persist per symbol
- Magnet off/weak/strong, stay-in-drawing-mode, lock/unlock all, hide/show all
  (hidden drawings are kept), remove selected/all, undo/redo
- Measure and zoom tools; right-click context menu; inline text editor
- Saved per symbol in browser storage (`tvfree.drawings.v2:<symbol>`), with
  automatic migration from the old flat format

**Watchlist**
- Click any row to load it into the focused chart; `+` adds the current symbol;
  `×` removes
- Live quotes pushed over WebSocket; the 20 s REST refresh is only a fallback

**Shareable state**
- `?symbol=BTCUSDT&tf=1D&ind=sma20,rsi` restores a view

## Data sources

| Asset class | Source | Notes |
|---|---|---|
| Crypto | Binance public REST + WebSocket | real-time, no key — the app is **crypto-only** |

**Live mode.** Each chart opens an SSE feed (`/api/live/stream`); the server
subscribes that symbol/interval to Binance over WebSocket and pushes `tick`
and `candle` frames. The in-progress candle is repainted from **every trade
tick** (median ~5 ms from frame to bar), so it moves at trade speed instead of
waiting for Binance's ~1 s kline snapshot. The first trade of a new bucket
creates the next bar immediately and the kline frame later reconciles its
exchange open and volume; indicators and the legend refresh at 10 Hz so the
render loop stays smooth. Quotes repaint once per animation frame, paper
trading DOM updates at 10 Hz, and alerts/limit fills still evaluate on every
trade.

A 20 s watchdog reconnects a socket that stays open but stops delivering
market data (sleep/resume, Wi-Fi change), and the server drops a symbol's
streams when its last chart disconnects unless an alert still needs it.
Endpoints: `/api/price`, `/api/history`, `/api/live/stream`. If SSE is
unavailable the app falls back to the 20 s REST refresh.

**Bar hygiene.** Every series is normalized before it reaches the chart: rows
are sorted, duplicate timestamps collapsed, non-finite or zero prices dropped,
and high/low widened so they always contain open/close.

**Sessions.** `4h` bars are built from hourly data in the exchange's own
timezone and bucket from the session's first bar, so NSE 4 h bars start at
09:15 IST rather than splitting the morning at an arbitrary UTC boundary.

**Metadata.** OHLCV responses carry `asOf` (last bar), `marketState`,
`splitAdjusted` and the split-event count, and quotes carry `asOf`, so staleness
is visible instead of implied.

Server-side caching: 20 s (1m) up to 10 min (1W). Every response is also
mirrored to `.cache/`, so if a provider rate-limits you the chart falls back
to the last good copy.

## Keyboard

| Key | Action |
|---|---|
| `/` | focus symbol search |
| `1`–`8` | timeframe |
| `Alt+1…4` | layout: 1×1, 2×1, 3×1, 2×2 |
| `R`, `Ctrl+R`, `F5` | reload the focused chart |
| `Ctrl+T` | new tab |
| `Ctrl+W`, `Ctrl+F4` | close tab |
| `Ctrl+Shift+T` | reopen closed tab |
| `Ctrl+U` | duplicate tab |
| `Ctrl+Tab`, `Ctrl+PageDown` | next tab |
| `Ctrl+Shift+Tab`, `Ctrl+PageUp` | previous tab |
| `Ctrl+1…8` / `Ctrl+9` | select tab / last tab |
| `Ctrl+,` | settings |
| `F11` | fullscreen |
| `Esc` | cancel tool / deselect / close popovers |
| `Delete`, `Backspace` | delete selected drawing |
| `Ctrl+Z` | undo drawing |
| `Ctrl+Shift+Z`, `Ctrl+Y` | redo drawing |
| `Ctrl+C` / `Ctrl+V` / `Ctrl+D` | copy / paste / duplicate drawing |
| `Alt+T` | trend line |
| `Alt+H` / `Alt+V` | horizontal / vertical line |
| `Alt+R` | rectangle |
| `Alt+F` | fib retracement |
| `Alt+X` | text |
| `Alt+P` | long position |
| `Alt+C` | parallel channel |
| `Alt+M` | measure |

Page zoom is left to the browser (`Ctrl+±/0`), which is what Desktop's page
zoom does too.

## Layout

```
server.js                HTTP server, static files, APIs, SSE, alert loop
desktop/main.js          Electron shell: starts the server, opens the app window
lib/market.js            Binance adapter, normalization, aggregation
lib/cache.js             memory + disk cache with stale fallback
lib/alerts.js            durable alert store, evaluator, delivery settings
public/js/chart.js       canvas engine (panes, scales, axes, crosshair, replay)
public/js/pane.js        one chart cell: engine + legend + drawings + replay
public/js/workspace.js   a tab: layout grid, 1–4 panes, serialization
public/js/indicators.js  SMA/EMA/RSI/MACD/Bollinger/VWAP maths
public/js/indicator-defs.js  indicator registry shared by panes
public/js/drawings.js    public drawing API (re-exports the modules below)
public/js/drawings/registry.js  tool ids, labels, anchors, categories
public/js/drawings/store.js     per-symbol storage, settings, clipboard, migration
public/js/drawings/geometry.js  projection, clipping and distance helpers
public/js/drawings/render.js    drawing, hit-testing and position metrics
public/js/drawings/engine.js    selection, history, magnet, CRUD
public/js/drawbar.js     left drawing toolbar, flyouts, management buttons
public/js/drawing-ui.js  properties panel, context menu, inline text editor
public/js/linking.js     link groups: per-group channels, focus gate, debounce
public/js/alerts.js      alert panel, SSE client, notifications, settings
public/js/settings.js    local app settings (saveSymbolInterval, alert sound)
public/js/trading.js     paper account, orders, fills, trade panel
public/js/app.js         workspaces, chrome, search, watchlist, keyboard, boot
public/js/util.js        number/HTML formatting helpers
data/alerts.json         server-side alerts, fired log, delivery settings
```

## TradingView Desktop parity

Checked against the Microsoft Store build of Desktop 3.4.1 (`app.asar`,
SHA-256 `8aac3410…79f2b1`, Electron 41.7.1). That app is an Electron shell
around `https://www.tradingview.com/`, so the shell's behaviour was readable
but the chart engine is not shipped locally.

Replicated from the shell:

- per-group link channels `symbol` / `interval` / `time` / `dateRange`,
  symbol-only default, focused chart only, 500 ms debounce, `time` suppressed
  while `dateRange` is on, and neither persisted
- `saveSymbolInterval` (default on) gating symbol/interval restore per tab
- alert sound: named sound, volume, 30 s startup mute, notification click
  focuses the window and switches the chart symbol
- the desktop hotkey map for tabs (`Ctrl+T/W/Shift+T/U`, `Ctrl+Tab`,
  `Ctrl+1…9`), reload (`Ctrl+R`/`F5`), fullscreen (`F11`), settings (`Ctrl+,`)

Not in the artifact, so not claimed: indicator maths, replay stepping, alert
evaluation semantics, paper-trade fills and crosshair drawing. Those run in the
hosted web app; here they are this project's own implementations.

## Honest limits

- **Not a TradingView replacement for licensed data.** NSE real-time ticks,
  broker feeds and exchange-licensed history cost money; this uses free,
  often delayed sources. Quotes can lag the real market.
- Yahoo's endpoints are unofficial and can change or throttle.
- Alerts and limit-order fills evaluate on every live Binance trade tick. If
  the WebSocket drops they pause until it reconnects (the server retries with
  backoff); REST history/quotes keep working meanwhile. A fast spike can still
  fill a resting limit at a worse price than the limit.
- Server-side alerts need `node server.js` running; closing the browser is
  fine, stopping the server is not.
- Paper trading is long-only spot with one shared virtual balance. Symbols in
  different currencies are not FX-converted, there are no fees, no slippage,
  and no short selling. It is a workflow tool, not a simulator.
- No Pine Script, no broker integration, no options/futures contracts.
- VWAP resets on the UTC calendar day; right for 24/7 crypto sessions (there
  is no trading day to anchor to, so a daily reset is a design choice).
- `4h` is aggregated from Yahoo's hourly bars, so its first bucket of a session
  is anchored correctly but volume is provider-dependent.
