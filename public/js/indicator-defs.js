import { sma, ema, rsi, macd, bollinger, vwap } from './indicators.js';

export const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W'];

export const IND = {
  sma20: {
    label: 'Moving Avg 20',
    color: '#f0a029',
    group: 'overlay',
    build: (bars) => [{ label: 'MA 20', color: '#f0a029', values: sma(bars, 20) }],
  },
  sma50: {
    label: 'Moving Avg 50',
    color: '#2962ff',
    group: 'overlay',
    build: (bars) => [{ label: 'MA 50', color: '#2962ff', values: sma(bars, 50) }],
  },
  ema200: {
    label: 'EMA 200',
    color: '#e91e63',
    group: 'overlay',
    build: (bars) => [{ label: 'EMA 200', color: '#e91e63', values: ema(bars, 200) }],
  },
  bb: {
    label: 'Bollinger Bands 20',
    color: '#7e8bd6',
    group: 'overlay',
    build: (bars) => {
      const b = bollinger(bars, 20, 2);
      return [
        { label: 'BB 20', color: '#7e8bd6', values: b.upper, width: 1 },
        { label: '', color: '#7e8bd6', values: b.mid, width: 1 },
        { label: '', color: '#7e8bd6', values: b.lower, width: 1 },
      ];
    },
  },
  vwap: {
    label: 'VWAP (session)',
    color: '#ffb74d',
    group: 'overlay',
    build: (bars, meta) => [{ label: 'VWAP', color: '#ffb74d', values: vwap(bars, meta.timezone) }],
  },
  rsi: {
    label: 'RSI 14',
    color: '#b39ddb',
    group: 'pane',
    build: (bars) => ({
      id: 'rsi',
      fixed: [0, 100],
      guides: [30, 70],
      series: [{ label: 'RSI 14', color: '#b39ddb', values: rsi(bars, 14) }],
    }),
  },
  macd: {
    label: 'MACD 12 26 9',
    color: '#2962ff',
    group: 'pane',
    build: (bars) => {
      const m = macd(bars, 12, 26, 9);
      return {
        id: 'macd',
        guides: [0],
        series: [
          { type: 'hist', values: m.hist, colorFn: (v) => (v >= 0 ? '#26a69a' : '#ef5350') },
          { label: 'MACD', color: '#2962ff', values: m.line },
          { label: 'Signal', color: '#ff6d00', values: m.signal },
        ],
      };
    },
  },
};

export const DEFAULT_INDICATORS = ['sma20', 'sma50'];
