// LST (Liquidity Side Theory) - strategy logic, following LST 2.0 (with 1.0 as background).
// Pure functions, no UI. Candles: {t: openTime ms UTC, o, h, l, c}

const ASIA_START = 19, ASIA_END = 2;    // 7 PM -> 2 AM New York time (LST 2.0, "Indicador LST 2.0 Asian Session")
const HUNT_END = 12;                    // grabs are hunted after Asia until 12 PM NY (end of London/NY overlap)
const PRIME = [[3, 5], [9, 11]];        // "Horarios Prime": London 3-5 AM, New York 9-11 AM (NY time)
const MOVE_LOOKBACK = 12;               // candles used to find the origin of the move that took the liquidity
const M1_MIN_WICK = 0.25;               // Model 1: wick on the liquidity side >= 25% of the candle (visible "damage")
const M3_MIN_BODY = 1 / 3;              // Model 3: solid body, at least 1/3 of the candle
const RANGE_LOOKBACK = 10;              // previous Asia ranges used to call today's range small / large

const nyFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});

function ny(t) {
  const p = {};
  for (const x of nyFmt.formatToParts(new Date(t))) p[x.type] = x.value;
  let h = +p.hour; if (h === 24) h = 0;
  return { date: `${p.year}-${p.month}-${p.day}`, h, m: +p.minute };
}

// A trading day starts at 7 PM NY the evening before (Asia open).
function tradingDay(t) {
  const n = ny(t);
  return n.h >= ASIA_START ? ny(t + 6 * 3600e3).date : n.date;
}

function sessionOf(t) {
  const h = ny(t).h;
  if (h >= ASIA_START || h < ASIA_END) return 'asia';
  if (h < 8) return 'london';
  if (h < HUNT_END) return 'newyork';
  return 'off';
}

function isPrime(t) {
  const n = ny(t), x = n.h + n.m / 60;
  return PRIME.some(([a, b]) => x >= a && x <= b);
}

function groupDays(candles, tfMs) {
  const days = new Map();
  for (const c of candles) {
    const d = tradingDay(c.t);
    if (!days.has(d)) days.set(d, { key: d, asia: [], hunt: [], post: [], seq: [] });
    const g = days.get(d);
    const s = sessionOf(c.t);
    if (s === 'asia') g.asia.push(c);
    else if (s === 'london' || s === 'newyork') g.hunt.push(c);
    else { g.post.push(c); continue; }   // after 12 PM: only used to finish a confirmation
    g.seq.push(c);
  }
  const asiaHours = (24 - ASIA_START + ASIA_END);
  const minAsia = Math.max(1, Math.floor((asiaHours * 3600e3 / tfMs) * 0.6));
  for (const g of days.values()) {
    g.asiaOk = g.asia.length >= minAsia;
    if (g.asia.length) {
      g.hi = Math.max(...g.asia.map(c => c.h));
      g.lo = Math.min(...g.asia.map(c => c.l));
    }
  }
  return [...days.values()];
}

// Candle helpers (side-aware). For a SELL setup the liquidity is above (Asia high).
function helpers(sell, L) {
  const range = c => Math.max(c.h - c.l, 1e-12);
  const body = c => Math.abs(c.c - c.o);
  return {
    takes: c => sell ? c.h > L : c.l < L,
    closesBack: c => sell ? c.c < L : c.c > L,                       // closed back below/above the liquidity line
    dirCandle: c => sell ? c.c < c.o : c.c > c.o,                    // candle in the direction of the trade
    // Model 1: closes back + rejection: close in the opposite half of the candle + visible wick on the liquidity side
    m1: c => (sell ? c.c < L : c.c > L)
      && (sell ? (c.h - c.c) : (c.c - c.l)) / range(c) >= 0.5
      && (sell ? c.h - Math.max(c.o, c.c) : Math.min(c.o, c.c) - c.l) / range(c) >= M1_MIN_WICK,
    // Model 2 (2.0): engulfing that covers at least 50% of candle #1's body and closes back past the line
    m2: (b, a) => (sell ? b.c < b.o : b.c > b.o) && (sell ? b.c < L : b.c > L)
      && (sell ? b.c <= (a.o + a.c) / 2 : b.c >= (a.o + a.c) / 2),
    // Model 3 (2.0): third candle closes back past the line with a solid body
    m3: c => (sell ? c.c < c.o : c.c > c.o) && (sell ? c.c < L : c.c > L) && body(c) / range(c) >= M3_MIN_BODY,
  };
}

// Look for a liquidity grab of the Asia high (sell) or low (buy) and the 3 confirmation models.
// If a grab gives no model but price returns inside the range, a later new sweep is evaluated again.
function detectSide(day, side) {
  const sell = side === 'sell';
  const L = sell ? day.hi : day.lo;
  const H = day.hunt.concat(day.post);   // grabs must start inside the hunt window; candles #2/#3 may close after it
  const huntN = day.hunt.length;
  const k = helpers(sell, L);

  let from = 0, lastGrab = null;
  while (true) {
    let gi = -1;
    for (let i = from; i < huntN; i++) {
      if (!k.takes(H[i])) continue;
      if (lastGrab !== null) {   // a re-sweep must take a new extreme beyond the previous grab
        const prevExt = sell ? Math.max(...H.slice(lastGrab, i).map(c => c.h)) : Math.min(...H.slice(lastGrab, i).map(c => c.l));
        if (sell ? H[i].h <= prevExt : H[i].l >= prevExt) continue;
      }
      gi = i; break;
    }
    if (gi < 0) return lastGrab === null ? { side, state: 'waiting', level: L } : { side, state: 'nomodel', level: L, grabT: H[lastGrab].t };

    const g = H[gi];
    let model = null, ci = -1;
    if (k.m1(g)) { model = 1; ci = gi; }
    else if (H[gi + 1] && k.m2(H[gi + 1], g)) { model = 2; ci = gi + 1; }
    else if (H[gi + 2] && k.m3(H[gi + 2])) { model = 3; ci = gi + 2; }

    const base = { side, level: L, grabT: g.t };
    if (model === null) {
      if (!H[gi + 2]) return { ...base, state: 'grabbed' };          // still inside the 3-candle window
      const after = H.slice(gi + 2);
      const last = H[H.length - 1];
      if (!k.closesBack(after[0]) && !k.closesBack(last)) return { ...base, state: 'continuation' };   // Type 1
      lastGrab = gi; from = gi + 3;                                   // back inside: wait for a new sweep
      continue;
    }

    const conf = H[ci];
    const span = H.slice(gi, ci + 1);
    const stop = sell ? Math.max(...span.map(c => c.h)) : Math.min(...span.map(c => c.l));
    const si = day.seq.indexOf(g);
    const before = day.seq.slice(Math.max(0, si - MOVE_LOOKBACK), si + 1);
    const origin = sell ? Math.min(...before.map(c => c.l)) : Math.max(...before.map(c => c.h));
    const partial = (stop + origin) / 2;   // 50% of the move that took the liquidity
    const target = sell ? day.lo : day.hi; // next liquidity: the opposite side of the Asia range
    const targetOk = sell ? target < conf.c : target > conf.c;
    return {
      ...base, state: 'signal', model, confT: conf.t, entry: conf.c,
      stop, origin, partial, target: targetOk ? target : null, dir: sell ? 'SELL' : 'BUY',
      partialPassed: sell ? conf.c <= partial : conf.c >= partial   // model closed already at/after the 50% (LST 2.0 p.176)
    };
  }
}

// ---------- v2: Fibonacci pullbacks + internal liquidity (LST 2.0 pp. 97, 138-144) ----------
// Once the direction is known (a confirmed model, or Type 1 continuation through the Asia level), the impulse
// runs from its origin A to its extreme B. In the pullback we wait in the Fibonacci zone (>= 50%, best 61.8-78.6%)
// for price to take an internal liquidity point (a swing low/high inside the move, or the first buyers/sellers
// of the correction) and confirm one of the same 3 models in favour of the trend.
const FIB_MIN = 0.5;                       // pullback must reach at least the 50%
const FIB_LEVELS = [0.5, 0.618, 0.7, 0.786];
const PIVOT = 2;                           // swing point = extreme vs 2 candles on each side
const MIN_IMPULSE = 3;                     // impulse must be >= 3x the average candle range of the day

function fibZone(d) { return d < 0.618 ? '50%' : d <= 0.786 ? 'Golden zone' : 'Deep (>78.6%)'; }

function detectFib(day, sd) {
  if (sd.state !== 'signal' && sd.state !== 'continuation') return null;
  const X = day.seq.concat(day.post);
  const buy = sd.state === 'signal' ? sd.dir === 'BUY' : sd.side === 'sell';   // Type 1 above the Asia high = bullish
  const sell = !buy;
  const dir = buy ? 'BUY' : 'SELL';
  const ext = c => buy ? c.h : c.l;        // impulse side
  const pull = c => buy ? c.l : c.h;       // pullback side
  const beyond = (a, b) => buy ? a > b : a < b;
  const gi = X.findIndex(c => c.t === sd.grabT);
  if (gi < 0) return null;

  let A, aIdx, start;
  if (sd.state === 'signal') {
    const ci = X.findIndex(c => c.t === sd.confT);
    A = sd.stop; aIdx = gi; for (let j = gi; j <= ci; j++) if (pull(X[j]) === A) aIdx = j;
    start = ci;
  } else {
    aIdx = Math.max(0, gi - MOVE_LOOKBACK);   // origin of the move that broke the level
    for (let j = aIdx; j <= gi; j++) if (beyond(pull(X[aIdx]), pull(X[j]))) aIdx = j;
    A = pull(X[aIdx]);
    start = gi;
  }
  let B = ext(X[aIdx]), bIdx = aIdx;
  for (let j = aIdx; j <= start; j++) if (beyond(ext(X[j]), B)) { B = ext(X[j]); bIdx = j; }

  const avgRange = X.reduce((s, c) => s + (c.h - c.l), 0) / X.length;
  const depthOf = v => (B - v) / (B - A);   // works for both directions (A and B swap sides)
  const out = { kind: 'fib', side: sd.side, dir, source: sd.state === 'signal' ? 'model' : 'type1', A, aT: X[aIdx].t };
  const levels = () => Object.fromEntries(FIB_LEVELS.map(f => [f, B - f * (B - A)]));
  let state = 'impulse', lastDepth = 0;

  for (let i = start + 1; i < X.length; i++) {
    const c = X[i];
    if (!beyond(pull(c), A)) return   // pullback reached the origin: the impulse is invalid { ...out, B, bT: X[bIdx].t, levels: levels(), state: 'invalid' };
    if (beyond(ext(c), B)) { B = ext(c); bIdx = i; state = 'impulse'; continue; }   // new leg of the impulse
    if (Math.abs(B - A) < MIN_IMPULSE * avgRange) continue;
    const depth = depthOf(pull(c));
    lastDepth = depth;
    if (depth < FIB_MIN) continue;
    state = 'zone';

    // liquidity points: swing extremes (pullback side) between A and now, not taken yet, sitting between A and B
    const pts = [];
    for (let j = aIdx + PIVOT; j + PIVOT <= i - 1; j++) {
      const v = pull(X[j]);
      let piv = true;
      for (let k = 1; k <= PIVOT && piv; k++) if (!beyond(pull(X[j - k]), v) || !beyond(pull(X[j + k]), v)) piv = false;
      if (!piv || !beyond(v, A) || !beyond(B, v)) continue;
      let taken = false;
      for (let k = j + 1; k < i && !taken; k++) if (beyond(v, pull(X[k]))) taken = true;
      if (!taken && beyond(v, pull(c))) pts.push({ v, t: X[j].t, internal: j < bIdx });
    }
    if (!pts.length) continue;
    const P = pts.reduce((a, b) => beyond(a.v, b.v) ? b : a);   // deepest point taken by this candle
    const k = helpers(sell, P.v);
    let model = null, ci = -1;
    if (k.m1(c)) { model = 1; ci = i; }
    else if (X[i + 1] && k.m2(X[i + 1], c)) { model = 2; ci = i + 1; }
    else if (X[i + 2] && k.m3(X[i + 2])) { model = 3; ci = i + 2; }
    if (model === null) {
      if (!X[i + 2]) return { ...out, B, bT: X[bIdx].t, levels: levels(), state: 'grabbed', point: P.v, depth, zone: fibZone(depth) };
      continue;
    }
    const span = X.slice(i, ci + 1);
    const stop = buy ? Math.min(...span.map(x => x.l)) : Math.max(...span.map(x => x.h));
    const conf = X[ci];
    const partial = (stop + B) / 2;   // 50% of the pullback move that took the liquidity
    return {
      ...out, B, bT: X[bIdx].t, levels: levels(), state: 'signal', model, grabT: c.t, confT: conf.t, entry: conf.c,
      stop, partial, partialPassed: buy ? conf.c >= partial : conf.c <= partial,
      target: beyond(B, conf.c) ? B : null, point: P.v, pointKind: P.internal ? 'internal liquidity' : 'first ' + (buy ? 'sellers' : 'buyers') + ' of the pullback',
      depth: depthOf(stop), zone: fibZone(depthOf(stop))
    };
  }
  if (Math.abs(B - A) < MIN_IMPULSE * avgRange) state = 'small';   // impulse still too small to measure
  return { ...out, B, bT: X[bIdx].t, levels: levels(), state, depth: lastDepth };
}

function analyze(candles, tfMs) {
  const days = groupDays(candles, tfMs).filter(d => d.asiaOk);
  const out = [];
  days.forEach((d, idx) => {
    const asiaDone = d.hunt.length > 0;
    const prev = days.slice(Math.max(0, idx - RANGE_LOOKBACK), idx).map(x => x.hi - x.lo).filter(x => x > 0);
    const avg = prev.length >= 3 ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
    const ratio = avg ? (d.hi - d.lo) / avg : null;
    const rangeSize = ratio == null ? null : ratio < 0.75 ? 'small' : ratio > 1.3 ? 'large' : 'normal';
    const res = { day: d.key, hi: d.hi, lo: d.lo, asiaDone, rangeRatio: ratio, rangeSize, asiaCandles: d.asia.map(c => c.t), sides: [] };
    if (asiaDone) res.sides = [detectSide(d, 'sell'), detectSide(d, 'buy')];
    res.fibs = res.sides.map(sd => detectFib(d, sd)).filter(f => f && f.state !== 'invalid' && f.state !== 'small');
    out.push(res);
  });
  return out;   // oldest -> newest
}

if (typeof module !== 'undefined') module.exports = { ny, tradingDay, sessionOf, isPrime, groupDays, detectSide, detectFib, analyze };
