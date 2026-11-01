/**
 * TVFREE — browser side: receive live ticks/candles over SSE.
 * Replaces client-side polling of /api/quote.
 *
 * Usage:
 *   const feed = TVFreeLive.connect('BTCUSDT', '1m', {
 *     onTick:   ({ price }) => { ...update price header... },
 *     onCandle: ({ candle, isClosed }) => { ...update chart... },
 *   });
 *   feed.close(); // when switching symbols
 *
 * Lightweight Charts wiring example:
 *   onCandle: ({ candle }) => candleSeries.update({
 *     time: candle.timeSec, open: candle.open, high: candle.high,
 *     low: candle.low, close: candle.close,
 *   })
 *
 * Custom canvas engine wiring example:
 *   onCandle: ({ candle, isClosed }) => window.TVFREE.updateCandle(candle, isClosed)
 */
(function () {
  function connect(symbol, interval = '1m', { onTick, onCandle, onError } = {}) {
    const url = `/api/live/stream?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`;
    const es = new EventSource(url);

    es.addEventListener('tick', (e) => {
      try { onTick && onTick(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('candle', (e) => {
      try { onCandle && onCandle(JSON.parse(e.data)); } catch {}
    });
    es.onerror = (e) => { onError && onError(e); }; // EventSource auto-reconnects

    return { close: () => es.close(), source: es };
  }

  window.TVFreeLive = { connect };
})();
