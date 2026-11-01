/**
 * Indicator maths. Every function returns an array aligned 1:1 with `bars`,
 * using `null` where the indicator has no value yet.
 */

export function sma(bars, length) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].c;
    if (i >= length) sum -= bars[i - length].c;
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

export function ema(bars, length) {
  return emaValues(bars.map((b) => b.c), length);
}

/** Exponential MA over a possibly sparse value series (nulls are carried). */
export function emaValues(values, length) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (length + 1);
  let prev = null;
  let seed = [];

  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null) {
      out[i] = prev;
      continue;
    }
    if (prev == null) {
      seed.push(v);
      if (seed.length === length) {
        prev = seed.reduce((a, b) => a + b, 0) / length;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(bars, length = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= length) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i += 1) {
    const d = bars[i].c - bars[i - 1].c;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= length;
  loss /= length;
  out[length] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = length + 1; i < bars.length; i += 1) {
    const d = bars[i].c - bars[i - 1].c;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (length - 1) + g) / length;
    loss = (loss * (length - 1) + l) / length;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(bars, fast = 12, slow = 26, signalLength = 9) {
  const fastEma = ema(bars, fast);
  const slowEma = ema(bars, slow);
  const line = bars.map((_, i) => (fastEma[i] == null || slowEma[i] == null ? null : fastEma[i] - slowEma[i]));
  const signal = emaValues(line, signalLength);
  const hist = line.map((v, i) => (v == null || signal[i] == null ? null : v - signal[i]));
  return { line, signal, hist };
}

export function bollinger(bars, length = 20, mult = 2) {
  const mid = sma(bars, length);
  const upper = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);

  for (let i = length - 1; i < bars.length; i += 1) {
    let variance = 0;
    for (let j = i - length + 1; j <= i; j += 1) {
      variance += (bars[j].c - mid[i]) ** 2;
    }
    const sd = Math.sqrt(variance / length);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

const dayFormatters = new Map();

function dayKey(ts, timeZone) {
  const tz = timeZone || 'UTC';
  let fmt = dayFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(tz, fmt);
  }
  return fmt.format(new Date(ts));
}

/** Session-anchored VWAP: resets at the first bar of each exchange-local day. */
export function vwap(bars, timeZone = 'UTC') {
  const out = new Array(bars.length).fill(null);
  let day = null;
  let pv = 0;
  let vol = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    const key = dayKey(b.t, timeZone);
    if (key !== day) {
      day = key;
      pv = 0;
      vol = 0;
    }
    const typical = (b.h + b.l + b.c) / 3;
    pv += typical * b.v;
    vol += b.v;
    out[i] = vol > 0 ? pv / vol : typical;
  }
  return out;
}

export function atr(bars, length = 14) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const prev = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
  });
  const out = new Array(bars.length).fill(null);
  if (bars.length <= length) return out;
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += tr[i];
  let prev = sum / length;
  out[length - 1] = prev;
  for (let i = length; i < bars.length; i += 1) {
    prev = (prev * (length - 1) + tr[i]) / length;
    out[i] = prev;
  }
  return out;
}
