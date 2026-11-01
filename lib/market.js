'use strict';

const cache = require('./cache');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const HOUR = 3600e3;

/** Cumulative volume needs a session anchor; these are per-interval ranges for Yahoo. */
const TIMEFRAMES = {
  '1m': { yahoo: '1m', range: '5d', ttl: 20e3 },
  '5m': { yahoo: '5m', range: '1mo', ttl: 30e3 },
  '15m': { yahoo: '15m', range: '1mo', ttl: 45e3 },
  '30m': { yahoo: '30m', range: '1mo', ttl: 60e3 },
  '1h': { yahoo: '60m', range: '1y', ttl: 90e3 },
  '4h': { yahoo: '60m', range: '1y', aggregateHours: 4, ttl: 120e3 },
  '1D': { yahoo: '1d', range: '5y', ttl: 300e3 },
  '1W': { yahoo: '1wk', range: '10y', ttl: 600e3 },
};

const BINANCE_TF = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
  '1W': '1w',
};

class ProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function getJson(url, { timeoutMs = 12000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (res.status === 429) {
        lastErr = new ProviderError('Rate limited by the data provider. Wait a moment and retry.', 429);
        await sleep(500 + i * 700);
        continue;
      }
      if (!res.ok) {
        lastErr = new ProviderError(`Upstream responded ${res.status}`, 502);
        await sleep(250 + i * 300);
        continue;
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        lastErr = new ProviderError('Upstream returned a non-JSON payload', 502);
      }
    } catch (err) {
      lastErr =
        err.name === 'AbortError'
          ? new ProviderError('Data provider timed out', 504)
          : new ProviderError(`Network error: ${err.message}`, 502);
      await sleep(250 + i * 300);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new ProviderError('Unknown provider failure', 502);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isCryptoSymbol(symbol) {
  const s = String(symbol || '').trim().replace(/^BINANCE:/i, '').toUpperCase();
  if (!s) return false;
  if (s.startsWith('BINANCE:')) return true;
  // Binance-style spot pair: BASE + USDT/USDC/BUSD/FDUSD (BTCUSDT, SOLUSDT, ETHUSDT, …)
  if (/(USDT|USDC|BUSD|FDUSD)$/.test(s)) return true;
  // Legacy Binance ids: BTC / ETH / BNB (+ coin suffix)
  if (/^[A-Z0-9]{2,10}(BTC|ETH|BNB)$/.test(s)) return true;
  return false;
}

function cleanSymbol(symbol) {
  return String(symbol || '').trim().replace(/^BINANCE:/i, '').toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Binance
 * ------------------------------------------------------------------ */

async function binanceBars(symbol, interval) {
  const sym = cleanSymbol(symbol);
  const binanceInterval = BINANCE_TF[interval] || '1d';
  const url =
    `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(sym)}` +
    `&interval=${binanceInterval}&limit=1000`;
  const rows = await getJson(url);
  if (!Array.isArray(rows)) throw new ProviderError('Unexpected Binance payload');

  const bars = normalizeBars(
    rows.map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    })),
  );

  return {
    symbol: sym,
    name: sym,
    exchange: 'BINANCE',
    currency: sym.endsWith('USDT') ? 'USDT' : 'USD',
    timezone: 'UTC',
    source: 'binance',
    asOf: bars.length ? bars[bars.length - 1].t : Date.now(),
    splitAdjusted: true,
    splitEvents: 0,
    bars,
  };
}

async function binanceQuote(symbol) {
  const sym = cleanSymbol(symbol);
  const j = await getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`);
  const price = Number(j.lastPrice);
  const prev = Number(j.prevClosePrice) || price;
  return {
    symbol: sym,
    name: sym,
    price,
    prevClose: prev,
    change: price - prev,
    changePct: prev ? ((price - prev) / prev) * 100 : 0,
    currency: sym.endsWith('USDT') ? 'USDT' : 'USD',
    exchange: 'BINANCE',
    source: 'binance',
    asOf: Number(j.closeTime) || Date.now(),
  };
}

/* ------------------------------------------------------------------ *
 * Yahoo Finance (stocks, indices, FX, futures)
 * ------------------------------------------------------------------ */

async function yahooChart(symbol, interval, range) {
  const sym = String(symbol).trim();
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const qs =
    `/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}` +
    `&range=${range}&includePrePost=false&events=div%2Csplit`;

  let lastErr;
  for (const host of hosts) {
    try {
      const j = await getJson(`https://${host}${qs}`);
      const result = j && j.chart && j.chart.result && j.chart.result[0];
      if (!result) {
        const desc = (j && j.chart && j.chart.error && j.chart.error.description) || 'symbol not found';
        throw new ProviderError(desc, 404);
      }
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new ProviderError('Yahoo Finance unavailable', 502);
}

function yahooBarsFromResult(result) {
  const ts = result.timestamp || [];
  const q = (result.indicators.quote && result.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = q.open ? q.open[i] : null;
    const h = q.high ? q.high[i] : null;
    const l = q.low ? q.low[i] : null;
    const c = q.close ? q.close[i] : null;
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({ t: ts[i] * 1000, o, h, l, c, v: (q.volume && q.volume[i]) || 0 });
  }
  return bars;
}

/** Drop junk rows, sort ascending, and make H/L actually contain O/C. */
function normalizeBars(input) {
  const byTime = new Map();
  for (const b of input || []) {
    const t = Number(b.t);
    const o = Number(b.o);
    const h = Number(b.h);
    const l = Number(b.l);
    const c = Number(b.c);
    const v = Number(b.v);
    if (![t, o, h, l, c].every(Number.isFinite)) continue;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    if (t <= 0) continue;
    byTime.set(t, {
      t,
      o,
      h: Math.max(h, o, c, l),
      l: Math.min(l, o, c, h),
      c,
      v: Number.isFinite(v) && v > 0 ? v : 0,
    });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

const dayFmtCache = new Map();
function dayKey(ts, tz) {
  let fmt = dayFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFmtCache.set(tz, fmt);
  }
  return fmt.format(new Date(ts));
}

/**
 * Aggregate intraday bars into N-hour buckets anchored to each trading
 * session's first bar, not the UTC epoch. A 4h NSE bar therefore starts at
 * 09:15 IST instead of splitting the morning across an arbitrary boundary.
 */
function aggregateSession(bars, hours, timezone) {
  const step = HOUR * hours;
  const out = [];
  let day = null;
  let anchor = 0;
  let cur = null;
  let curBucket = null;

  for (const b of bars) {
    const key = dayKey(b.t, timezone);
    if (key !== day) {
      day = key;
      anchor = b.t;
    }
    const bucket = Math.floor((b.t - anchor) / step);
    if (!cur || bucket !== curBucket) {
      if (cur) out.push(cur);
      cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      curBucket = bucket;
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function yahooSeries(symbol, interval) {
  const tf = TIMEFRAMES[interval];
  if (!tf) throw new ProviderError(`Unsupported interval "${interval}"`, 400);

  const result = await yahooChart(symbol, tf.yahoo, tf.range);
  const m = result.meta || {};
  const timezone = m.exchangeTimezoneName || m.timezone || 'UTC';

  let bars = normalizeBars(yahooBarsFromResult(result));
  if (tf.aggregateHours) bars = normalizeBars(aggregateSession(bars, tf.aggregateHours, timezone));

  return {
    symbol: m.symbol || String(symbol).toUpperCase(),
    name: m.longName || m.shortName || m.symbol || String(symbol),
    exchange: m.fullExchangeName || m.exchangeName || '',
    currency: m.currency || '',
    timezone,
    instrumentType: m.instrumentType || '',
    source: 'yahoo',
    regularMarketPrice: m.regularMarketPrice,
    previousClose: m.chartPreviousClose ?? m.previousClose,
    dayHigh: m.regularMarketDayHigh,
    dayLow: m.regularMarketDayLow,
    week52High: m.fiftyTwoWeekHigh,
    week52Low: m.fiftyTwoWeekLow,
    marketVolume: m.regularMarketVolume,
    marketState: m.marketState || null,
    asOf: bars.length ? bars[bars.length - 1].t : Date.now(),
    splitAdjusted: true,
    splitEvents: result.events && result.events.splits ? Object.keys(result.events.splits).length : 0,
    bars,
  };
}

/* ------------------------------------------------------------------ *
 * Facade
 * ------------------------------------------------------------------ */

async function getSeries(symbol, interval = '1D') {
  if (!symbol) throw new ProviderError('symbol is required', 400);
  if (!TIMEFRAMES[interval]) throw new ProviderError(`Unsupported interval "${interval}"`, 400);
  if (!isCryptoSymbol(symbol)) {
    throw new ProviderError('Crypto-only build: only crypto pairs are supported (e.g. BTCUSDT, ETHUSDT, SOLUSDT)', 400);
  }

  const key = `series:${symbol}:${interval}`;
  const ttl = TIMEFRAMES[interval].ttl;

  const fresh = cache.get(key, ttl);
  if (fresh) return { ...fresh, cached: true, fetchedAt: Date.now() };

  try {
    const data = isCryptoSymbol(symbol)
      ? await binanceBars(symbol, interval)
      : await yahooSeries(symbol, interval);
    if (!data.bars.length) throw new ProviderError('No price data returned for this symbol', 404);
    cache.set(key, data);
    return { ...data, cached: false, fetchedAt: Date.now() };
  } catch (err) {
    const fallback = cache.stale(key);
    if (fallback) return { ...fallback, cached: true, stale: true, fetchedAt: Date.now(), warning: err.message };
    throw err;
  }
}

async function getQuote(symbol) {
  const key = `quote:${symbol}`;
  const fresh = cache.get(key, 12e3);
  if (fresh) return fresh;
  if (!isCryptoSymbol(symbol)) {
    return { symbol, error: 'Crypto-only build: only crypto pairs are supported (e.g. BTCUSDT, ETHUSDT, SOLUSDT)' };
  }
  try {
    const q = isCryptoSymbol(symbol) ? await binanceQuote(symbol) : await yahooQuote(symbol);
    return cache.set(key, q);
  } catch (err) {
    const fallback = cache.stale(key);
    if (fallback) return { ...fallback, stale: true };
    return { symbol, error: err.message };
  }
}

async function yahooQuote(symbol) {
  const result = await yahooChart(symbol, '1d', '5d');
  const m = result.meta || {};
  const price = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose ?? price;
  return {
    symbol: m.symbol || symbol,
    name: m.longName || m.shortName || m.symbol || symbol,
    price,
    prevClose: prev,
    change: price - prev,
    changePct: prev ? ((price - prev) / prev) * 100 : 0,
    currency: m.currency || '',
    exchange: m.fullExchangeName || m.exchangeName || '',
    source: 'yahoo',
    marketState: m.marketState || null,
    asOf: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
  };
}

async function getQuotes(symbols) {
  const unique = [...new Set(symbols)];
  const out = new Array(unique.length);
  let cursor = 0;

  // Small concurrency: 8 sequential Yahoo calls took up to 15 s, too slow for
  // the 20 s alert loop. Four at a time stays polite but finishes in ~1/3.
  const worker = async () => {
    while (cursor < unique.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await getQuote(unique[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
  return out;
}

async function searchSymbols(query) {
  const q = String(query || '').trim();
  if (!q) return [];

  const key = `search:${q.toLowerCase()}`;
  const fresh = cache.get(key, 6 * 3600e3);
  if (fresh) return fresh;

  const url =
    'https://query1.finance.yahoo.com/v1/finance/search' +
    `?q=${encodeURIComponent(q)}&quotesCount=20&newsCount=0&listsCount=0&enableFuzzyQuery=true`;

  try {
    const j = await getJson(url);
    const rows = (j.quotes || [])
      .filter((r) => r.symbol)
      .map((r) => ({
        symbol: r.symbol,
        name: r.longname || r.shortname || r.symbol,
        exchange: r.exchDisp || r.exchange || '',
        type: r.typeDisp || r.quoteType || '',
        source: isCryptoSymbol(r.symbol) ? 'binance' : 'yahoo',
      }))
      .filter((r) => r.source === 'binance' || /crypto/i.test(String(r.type || '')));
    return cache.set(key, rows);
  } catch {
    // Offline / blocked: fall back to a tiny built-in catalogue.
    return FALLBACK_UNIVERSE.filter(
      (r) =>
        r.symbol.toLowerCase().includes(q.toLowerCase()) ||
        r.name.toLowerCase().includes(q.toLowerCase()),
    );
  }
}

const FALLBACK_UNIVERSE = [
  { symbol: 'BTCUSDT', name: 'Bitcoin / Tether', exchange: 'BINANCE', type: 'Crypto', source: 'binance' },
  { symbol: 'ETHUSDT', name: 'Ethereum / Tether', exchange: 'BINANCE', type: 'Crypto', source: 'binance' },
  { symbol: 'SOLUSDT', name: 'Solana / USDt', exchange: 'BINANCE', type: 'Crypto', source: 'binance' },
  { symbol: 'XRPUSDT', name: 'XRP / USDt', exchange: 'BINANCE', type: 'Crypto', source: 'binance' },
  { symbol: 'ADAUSDT', name: 'Cardano / USDt', exchange: 'BINANCE', type: 'Crypto', source: 'binance' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin / USDt', exchange: 'BINANCE', type: 'Crypto', source: 'binance' },
];

module.exports = {
  TIMEFRAMES,
  ProviderError,
  getSeries,
  getQuote,
  getQuotes,
  searchSymbols,
  FALLBACK_UNIVERSE,
};
