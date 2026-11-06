'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const market = require('./lib/market');
const alerts = require('./lib/alerts');
const { BinanceLive, getHistory } = require('./binance-live');
const { TickEngine } = require('./tick-engine');

const PORT = Number(process.env.PORT || 5577);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('request body too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const err = new Error('invalid JSON body');
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * Server-sent events
 * ------------------------------------------------------------------ */

const sseClients = new Set();

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client went away */
  }
}

function sseBroadcast(event, data) {
  for (const client of sseClients) sseWrite(client, event, data);
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  sseWrite(res, 'snapshot', { alerts: alerts.list(), log: alerts.log.slice(0, 50) });

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

/* ------------------------------------------------------------------ *
 * Binance live — crypto real-time (WebSocket ticks -> tick engine ->
 * alerts + paper fills, SSE fan-out per symbol, live price).
 * ------------------------------------------------------------------ */

const live = new BinanceLive();
const engine = new TickEngine();
const liveClients = new Map(); // symbol -> Set<http.ServerResponse>

function liveSend(symbol, event, data) {
  const set = liveClients.get(String(symbol || '').toUpperCase());
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch { /* client gone */ }
  }
}

live.on('tick', (tick) => {
  // One Binance trade -> one evaluation. Paper fills (engine orders) and
  // durable alert checks both run per tick, replacing the old 20s poll.
  engine.onTick(tick);
  liveSend(tick.symbol, 'tick', tick);

  const fired = alerts.evaluate([{ symbol: tick.symbol, price: tick.price }]);
  if (fired) console.log(`alerts: ${fired} triggered (live tick ${tick.symbol})`);
});
live.on('candle', (c) => liveSend(c.symbol, 'candle', c));
live.on('error', (e) => console.error('binance live error —', e));
live.start();

function liveSubscribe(symbol, interval = '1m') {
  live.subscribe(String(symbol || '').toUpperCase(), interval);
}

engine.on('fill', (o) => {
  console.log(`[live] fill: ${o.symbol} ${o.side} qty ${o.qty} @ ${o.fillPrice}`);
  liveSend(o.symbol, 'fill', o);
});

/* ------------------------------------------------------------------ *
 * Alert evaluation + delivery
 * ------------------------------------------------------------------ */

async function postJson(url, body, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`delivery responded ${res.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(alert) {
  const s = alerts.settings;
  const text = `${alert.symbol} ${alert.condition} ${alert.price} — last ${alert.triggerPrice}`;

  if (s.webhookUrl) {
    try {
      await postJson(s.webhookUrl, {
        event: 'alert',
        id: alert.id,
        symbol: alert.symbol,
        condition: alert.condition,
        price: alert.price,
        triggerPrice: alert.triggerPrice,
        triggeredAt: alert.triggeredAt,
        note: alert.note,
        text,
      });
    } catch (err) {
      console.error('alerts: webhook failed —', err.message);
    }
  }

  if (s.telegramToken && s.telegramChatId) {
    try {
      await postJson(
        `https://api.telegram.org/bot${s.telegramToken}/sendMessage`,
        { chat_id: s.telegramChatId, text, disable_web_page_preview: true },
      );
    } catch (err) {
      console.error('alerts: telegram failed —', err.message);
    }
  }
}

alerts.on('fired', (alert) => {
  console.log(`alert fired: ${alert.symbol} ${alert.condition} ${alert.price} @ ${alert.triggerPrice}`);
  sseBroadcast('alert', alert);
  deliver(alert).catch(() => {});
});

alerts.on('changed', (alert) => {
  sseBroadcast('changed', alert ? { id: alert.id } : { id: null });
});

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  try {
    if (route === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        uptime: process.uptime(),
        time: new Date().toISOString(),
        alerts: alerts.activeSymbols().length,
      });
    }

    if (route === '/api/search') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const q = url.searchParams.get('q') || '';
      const rows = await market.searchSymbols(q);
      return sendJson(res, 200, { query: q, results: rows });
    }

    if (route === '/api/ohlcv') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const symbol = url.searchParams.get('symbol');
      const interval = url.searchParams.get('interval') || '1D';
      const data = await market.getSeries(symbol, interval);
      return sendJson(res, 200, data);
    }

    if (route === '/api/quote') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const raw = url.searchParams.get('symbols') || '';
      const symbols = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 40);
      if (!symbols.length) return sendJson(res, 400, { error: 'symbols is required' });
      const quotes = await market.getQuotes(symbols);
      return sendJson(res, 200, { quotes });
    }

    if (route === '/api/price') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
      const price = live.getPrice(symbol);
      if (Number.isFinite(price)) {
        return sendJson(res, 200, { symbol, price, source: 'binance-live', asOf: Date.now() });
      }
      const q = await market.getQuote(symbol).catch(() => null);
      if (!q || !Number.isFinite(q.price)) return sendJson(res, 404, { error: `no price for ${symbol}` });
      return sendJson(res, 200, { symbol, ...q });
    }

    if (route === '/api/history') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
      const interval = url.searchParams.get('interval') || '1m';
      const limit = Math.min(Number(url.searchParams.get('limit') || 500), 1000);
      const candles = await getHistory(symbol, interval, limit);
      const bars = candles.map((c) => {
        const t = Number(c.time ?? c.t ?? 0);
        return {
          t,
          timeSec: Number(c.timeSec ?? Math.floor(t / 1000)),
          o: Number(c.open),
          h: Number(c.high),
          l: Number(c.low),
          c: Number(c.close),
          v: Number(c.volume || 0),
        };
      });
      return sendJson(res, 200, { symbol, interval, bars });
    }

    if (route === '/api/live/stream' && method === 'GET') {
      const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
      const interval = url.searchParams.get('interval') || '1m';
      liveSubscribe(symbol, interval);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      if (!liveClients.has(symbol)) liveClients.set(symbol, new Set());
      liveClients.get(symbol).add(res);
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 25000);
      req.on('close', () => {
        clearInterval(heartbeat);
        const set = liveClients.get(symbol);
        if (!set) return;
        set.delete(res);
        // Last chart gone: stop paying for this symbol's streams unless an
        // alert still needs it. Keeps long sessions from accumulating feeds.
        if (!set.size) {
          liveClients.delete(symbol);
          if (!alerts.activeSymbols().includes(symbol)) live.unsubscribeSymbol(symbol);
        }
      });
      return;
    }

    /* ---------------- alerts ---------------- */

    if (route === '/api/alerts' && method === 'GET') {
      return sendJson(res, 200, {
        alerts: alerts.list(),
        log: alerts.log.slice(0, 100),
        settings: alerts.publicSettings(),
        serverTime: Date.now(),
      });
    }

    if (route === '/api/alerts' && method === 'POST') {
      const body = await readJson(req);
      const created = alerts.add(body);
      if (created.error) return sendJson(res, 400, created);
      liveSubscribe(created.symbol, '1m');
      return sendJson(res, 201, created);
    }

    if (route === '/api/alerts/clear-log' && method === 'POST') {
      alerts.clearLog();
      return sendJson(res, 200, { ok: true });
    }

    const rearm = route.match(/^\/api\/alerts\/([^/]+)\/rearm$/);
    if (rearm && method === 'POST') {
      const updated = alerts.rearm(decodeURIComponent(rearm[1]));
      if (!updated) return sendJson(res, 404, { error: 'alert not found' });
      liveSubscribe(updated.symbol, '1m');
      return sendJson(res, 200, updated);
    }

    const one = route.match(/^\/api\/alerts\/([^/]+)$/);
    if (one && method === 'DELETE') {
      const id = decodeURIComponent(one[1]);
      const target = alerts.list().find((a) => a.id === id);
      const removed = alerts.remove(id);
      if (!removed) return sendJson(res, 404, { error: 'alert not found' });
      if (target && !alerts.activeSymbols().includes(target.symbol)) {
        live.unsubscribeSymbol(target.symbol);
      }
      return sendJson(res, 200, { ok: true });
    }

    /* ---------------- settings / stream ---------------- */

    if (route === '/api/settings' && method === 'GET') {
      return sendJson(res, 200, alerts.publicSettings());
    }

    if (route === '/api/settings' && method === 'PUT') {
      const body = await readJson(req);
      return sendJson(res, 200, alerts.updateSettings(body));
    }

    if (route === '/api/events' && method === 'GET') {
      return handleEvents(req, res);
    }

    return sendJson(res, 404, { error: 'Unknown API route' });
  } catch (err) {
    const status = err.status || 500;
    return sendJson(res, status, {
      error: err.message || 'Unexpected server error',
      route,
    });
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, rel);
  const normalized = path.normalize(filePath);

  if (!normalized.startsWith(PUBLIC_DIR + path.sep) && normalized !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendText(res, 403, 'Forbidden');
  }

  fs.stat(normalized, (err, stat) => {
    if (err || !stat.isFile()) {
      return sendText(res, 404, 'Not found');
    }
    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(normalized).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms > 1500 || res.statusCode >= 400) {
      console.log(`${res.statusCode} ${req.method} ${url.pathname}${url.search} (${ms}ms)`);
    }
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  return serveStatic(req, res, url);
});

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  CloneTradingView  —  local charting terminal');
  console.log(`  ${address}`);
  console.log('');
  console.log('  data: Binance public REST + WebSocket (crypto-only build)');
  console.log(`  alerts: server-side on Binance ticks (${alerts.list().length} stored)`);
  console.log('  press Ctrl+C to stop');
  console.log('');

  // Crypto live: stream every currently-armed alert symbol over the Binance
  // WebSocket. New alerts subscribe on creation; deletions unsubscribe when the
  // last alert for a symbol goes away.
  for (const s of alerts.activeSymbols()) liveSubscribe(s, '1m');

  if (process.argv.includes('--open')) {
    const cmd =
      process.platform === 'win32'
        ? `start "" "${address}"`
        : process.platform === 'darwin'
          ? `open "${address}"`
          : `xdg-open "${address}"`;
    exec(cmd, (err) => {
      if (err) console.log(`  could not auto-open browser: ${err.message}`);
    });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try: set PORT=5588 && node server.js\n`);
    process.exit(1);
  }
  throw err;
});
