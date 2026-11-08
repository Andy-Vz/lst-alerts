// LST (Liquidity Side Theory) - strategy logic, following LST 2.0 (with 1.0 as background).
// Pure functions, no UI. Candles: {t: openTime ms UTC, o, h, l, c}

const ASIA_START = 19, ASIA_END = 2;    // 7 PM -> 2 AM New York time (LST 2.0, "Indicador LST 2.0 Asian Session")
const HUNT_END = 12;                    // grabs are hunted after Asia until 12 PM NY (end of London/NY overlap)
const PRIME = [[3, 5], [9, 11]];        // "Horarios Prime": London 3-5 AM, New York 9-11 AM (NY time)
const MOVE_LOOKBACK = 12;               // candles used to find the origin of the move that took the liquidity
const M1_MIN_WICK = 0.25;               // Model 1: wick on the liquidity side >= 25% of the candle (visible "damage")
const M1_MIN_DAMAGE = 0.2;              // Model 1: the wick must go past the line by >= 20% of the candle (a graze is not allowed, p.109)
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
      && (sell ? c.h - Math.max(c.o, c.c) : Math.min(c.o, c.c) - c.l) / range(c) >= M1_MIN_WICK
      && (sell ? c.h - L : L - c.l) / range(c) >= M1_MIN_DAMAGE,
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
      // Type 1 only if price never closed back inside after the grab. This must not depend on the latest candle,
      // otherwise a later model (re-sweep) would disappear when price moves beyond the level again.
      let cameBack = false;
      for (let i = gi + 2; i < H.length && !cameBack; i++) if (k.closesBack(H[i])) cameBack = true;
      if (!cameBack) return { ...base, state: 'continuation' };       // Type 1
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
      partialPassed: sell ? conf.c <= partial : conf.c >= partial,  // model closed already at/after the 50% (LST 2.0 p.176)
      // Model 1 variant 4 (p.108): body closes right at the line, big wick -> may only reach the 50%
      m1weak: model === 1 && Math.abs(conf.c - L) / Math.max(conf.h - conf.l, 1e-12) < 0.15
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

// ---------- Setup B: "the second chance" (LST 2.0 pp. 182-186) ----------
// A model is already confirmed -> price breaks the nearest S/R with force in favour of the model (A) ->
// a corrective retest comes back to that broken zone (B) -> a model confirms there, at an internal liquidity
// point, sweeping the first buyers/sellers, or at the S/R line itself (C).
const SR_LOOKBACK = 48;      // candles before the model used to find S/R (swing points)
const FORCE_BODY = 0.5;      // breaking candle: body >= 50% of its range...
const FORCE_RANGE = 1.0;     // ...and range >= the day's average candle range
const ZONE_TOL = 0.25;       // S/R is a zone: level +/- 25% of the average candle range

function detectSetupB(day, sd, prevDay) {
  if (sd.state !== 'signal') return null;
  const X = day.seq.concat(day.post);
  const sell = sd.dir === 'SELL', dir = sd.dir;
  const ci = X.findIndex(c => c.t === sd.confT);
  if (ci < 0) return null;
  const avgRange = X.reduce((s, c) => s + (c.h - c.l), 0) / X.length;
  const tol = ZONE_TOL * avgRange;
  const pull = c => sell ? c.h : c.l;           // retest side
  const ext = c => sell ? c.l : c.h;            // trend side
  const beyond = (a, b) => sell ? a < b : a > b; // a is further in the trade direction than b
  const body = c => Math.abs(c.c - c.o), range = c => Math.max(c.h - c.l, 1e-12);

  // S/R candidates in the direction of the trade: swing points before the model + previous day's high/low
  let cands = [];
  for (let j = Math.max(PIVOT, ci - SR_LOOKBACK); j + PIVOT <= ci; j++) {
    const v = ext(X[j]); let piv = true;
    for (let k = 1; k <= PIVOT && piv; k++) if (!beyond(v, ext(X[j - k])) || !beyond(v, ext(X[j + k]))) piv = false;
    if (piv) cands.push(v);
  }
  if (prevDay) {   // previous trading day's full high / low
    const pd = prevDay.seq.concat(prevDay.post);
    if (pd.length) cands.push(Math.max(...pd.map(c => c.h)), Math.min(...pd.map(c => c.l)));
  }
  const entry0 = X[ci].c;
  cands = [...new Set(cands)].filter(v => beyond(v, entry0) && Math.abs(v - entry0) > tol)
    .sort((a, b) => Math.abs(a - entry0) - Math.abs(b - entry0));
  const base = { kind: 'setupB', side: sd.side, dir, modelT: sd.confT };
  if (!cands.length) return null;

  let level = null, bi = -1;
  let i = ci + 1;
  for (; i < X.length && level === null; i++) {
    const c = X[i];
    if (!beyond(pull(c), sd.stop)) return null;                 // original model stopped out
    const passed = cands.filter(v => beyond(c.c, v));            // levels this candle closed through
    if (!passed.length) continue;
    const forceful = (sell ? c.c < c.o : c.c > c.o) && body(c) / range(c) >= FORCE_BODY && range(c) >= FORCE_RANGE * avgRange;
    if (forceful) { level = passed[passed.length - 1]; bi = i; }
    else cands = cands.filter(v => !passed.includes(v));         // broken without force: not a valid zone
  }
  if (level === null) return cands.length ? { ...base, state: 'srwait', level: cands[0] } : null;

  // B: corrective retest of the broken zone, then C: a model there
  let E = ext(X[bi]), eIdx = bi;
  const breakBody = body(X[bi]);
  for (; i < X.length; i++) {
    const c = X[i];
    if (!beyond(pull(c), sd.stop)) return { ...base, state: 'invalid', level };
    if (beyond(ext(c), E)) { E = ext(c); eIdx = i; }
    const inZone = sell ? c.h >= level - tol : c.l <= level + tol;
    if (!inZone) continue;
    const leg = X.slice(eIdx + 1, i + 1);
    const corrective = leg.length > 0 && leg.reduce((s, x) => s + body(x), 0) / leg.length < breakBody;
    if (!corrective) continue;
    // liquidity points: the S/R line itself + swing points (retest side) since the model that this candle sweeps
    const pts = [{ v: level, what: 'S/R zone' }];
    for (let j = ci + PIVOT; j + PIVOT <= i - 1; j++) {
      const v = pull(X[j]); let piv = true;
      for (let k = 1; k <= PIVOT && piv; k++) if (!beyond(pull(X[j - k]), v) || !beyond(pull(X[j + k]), v)) piv = false;
      if (!piv) continue;
      let taken = false;
      for (let k = j + 1; k < i && !taken; k++) if (beyond(v, pull(X[k]))) taken = true;
      if (!taken) pts.push({ v, what: j < eIdx ? 'internal liquidity' : 'first ' + (sell ? 'buyers' : 'sellers') + ' of the retest' });
    }
    const swept = pts.filter(p => beyond(p.v, pull(c)));
    if (!swept.length) continue;
    const P = swept.reduce((a, b) => beyond(a.v, b.v) ? b : a);
    const k = helpers(sell, P.v);
    let model = null, mi = -1;
    if (k.m1(c)) { model = 1; mi = i; }
    else if (X[i + 1] && k.m2(X[i + 1], c)) { model = 2; mi = i + 1; }
    else if (X[i + 2] && k.m3(X[i + 2])) { model = 3; mi = i + 2; }
    if (model === null) {
      if (!X[i + 2]) return { ...base, state: 'grabbed', level, breakT: X[bi].t };
      continue;
    }
    const span = X.slice(i, mi + 1), conf = X[mi];
    const stop = sell ? Math.max(...span.map(x => x.h)) : Math.min(...span.map(x => x.l));
    const partial = (stop + E) / 2;
    const target = sd.target != null && beyond(sd.target, conf.c) ? sd.target : beyond(E, conf.c) ? E : null;
    const rr = target != null ? Math.abs(target - conf.c) / Math.max(Math.abs(conf.c - stop), 1e-12) : null;   // book p.169: skip below 1:2
    return {
      ...base, state: 'signal', level, breakT: X[bi].t, model, grabT: c.t, confT: conf.t, entry: conf.c, stop,
      partial, partialPassed: sell ? conf.c <= partial : conf.c >= partial, target, rr, pointKind: P.what
    };
  }
  const last = X[X.length - 1];
  const inZoneNow = sell ? last.h >= level - tol : last.l <= level + tol;
  return { ...base, state: inZoneNow ? 'retest' : 'broken', level, breakT: X[bi].t };
}

// ---------- Higher-timeframe trend from price structure (LST 2.0 pp. 103, 149, 172-175) ----------
// No indicators: higher highs + higher lows = up, lower highs + lower lows = down, otherwise range.
const TREND_PIVOT = 3;

function structure(c) {
  const hs = [], ls = [];
  for (let j = TREND_PIVOT; j + TREND_PIVOT < c.length; j++) {
    let isH = true, isL = true;
    for (let k = 1; k <= TREND_PIVOT; k++) {
      if (c[j].h <= c[j - k].h || c[j].h < c[j + k].h) isH = false;
      if (c[j].l >= c[j - k].l || c[j].l > c[j + k].l) isL = false;
    }
    if (isH) hs.push({ i: j, v: c[j].h });
    if (isL) ls.push({ i: j, v: c[j].l });
  }
  if (hs.length < 2 || ls.length < 2) return { dir: 'range' };
  const [h1, h2] = hs.slice(-2), [l1, l2] = ls.slice(-2);
  const last = c[c.length - 1];
  let dir = h2.v > h1.v && l2.v > l1.v ? 'up' : h2.v < h1.v && l2.v < l1.v ? 'down' : 'range';
  if (dir === 'up' && last.c < l2.v) dir = 'range';     // structure broken since the last swing
  if (dir === 'down' && last.c > h2.v) dir = 'range';
  // the last leg of the trend (used for the counter-trend take profit at 50% / 61.8%)
  let leg = null;
  if (dir === 'up') leg = { lo: l2.v, hi: Math.max(...c.slice(l2.i).map(x => x.h)) };
  if (dir === 'down') leg = { hi: h2.v, lo: Math.min(...c.slice(h2.i).map(x => x.l)) };
  return { dir, leg };
}

function toDaily(c) {
  const m = new Map();
  for (const x of c) {
    const d = tradingDay(x.t);
    const g = m.get(d);
    if (!g) m.set(d, { t: x.t, o: x.o, h: x.h, l: x.l, c: x.c });
    else { g.h = Math.max(g.h, x.h); g.l = Math.min(g.l, x.l); g.c = x.c; }
  }
  return [...m.values()];
}

// Trend for an instrument from its 4h candles: daily structure first, H4 if the daily is ranging.
function trendInfo(c4h) {
  if (!c4h || c4h.length < 30) return null;
  const h4 = structure(c4h), d1 = structure(toDaily(c4h));
  const dir = d1.dir !== 'range' ? d1.dir : h4.dir;
  const leg = h4.dir === dir && h4.leg ? h4.leg : d1.leg;
  return { dir, h4: h4.dir, d1: d1.dir, leg };
}

// ---------- What happened after a signal (LST 2.0 pp. 167, 176-180) ----------
// Follows the candles after the model closed: stop -> STOPPED; 50% -> partials + stop to break-even;
// after that, back to entry -> BE; target -> TARGET. If one candle touches stop and target, the stop counts (conservative).
function outcome(sig, candles) {
  const sell = sig.dir === 'SELL';
  const risk = Math.abs(sig.entry - sig.stop), oneRLvl = sell ? sig.entry - risk : sig.entry + risk;   // price at which the trade is 1:1
  let half = false, halfT = null, oneR = false;
  for (const c of candles) {
    if (c.t <= sig.confT) continue;
    const stopLvl = half ? sig.entry : sig.stop;
    if (sell ? c.h >= stopLvl : c.l <= stopLvl) return { state: half ? 'be' : 'stopped', t: c.t, halfT, oneR };   // same candle: the stop counts, 1:1 does not
    if (sell ? c.l <= oneRLvl : c.h >= oneRLvl) oneR = true;
    if (sig.target != null && (sell ? c.l <= sig.target : c.h >= sig.target)) return { state: 'target', t: c.t, halfT, oneR };
    if (!half && sig.partial != null && (sell ? c.l <= sig.partial : c.h >= sig.partial)) { half = true; halfT = c.t; }
  }
  return { state: half ? 'half' : 'open', halfT, oneR };
}

// ---------- Stop loss by ZONES, never at the wick (LST 2.0 pp. 170-171) ----------
// SELL: beyond the next resistance (a previous swing high) above the model's wick. BUY: beyond the next support below it.
// A small margin is added beyond the zone. If there is no zone (e.g. all-time high), wick + margin, flagged.
const STOP_LOOKBACK = 300;   // candles back to look for S/R zones
const STOP_PIVOT = 3;        // swing point = extreme vs 3 candles on each side
const STOP_MARGIN = 0.25;    // margin beyond the zone = 25% of the average candle range
const STOP_BUFFER = 0.10;    // wick + 10% of the average candle (kept only for backtests: sd.stopBuf)

function zoneStop(candles, ci, sell, wick) {
  const from = Math.max(0, ci - STOP_LOOKBACK);
  const recent = candles.slice(Math.max(0, ci - 100), ci + 1);
  const avg = recent.reduce((s, c) => s + (c.h - c.l), 0) / Math.max(1, recent.length);
  const margin = STOP_MARGIN * avg;
  let best = null;
  for (let j = from + STOP_PIVOT; j + STOP_PIVOT <= ci; j++) {   // only swings already confirmed before the model closed
    const v = sell ? candles[j].h : candles[j].l;
    let piv = true;
    for (let k = 1; k <= STOP_PIVOT && piv; k++) {
      if (sell ? (candles[j - k].h > v || candles[j + k].h > v) : (candles[j - k].l < v || candles[j + k].l < v)) piv = false;
    }
    if (!piv) continue;
    if (sell ? v <= wick + margin * 0.4 : v >= wick - margin * 0.4) continue;   // must be a zone beyond the wick, not the wick itself
    if (best == null || (sell ? v < best : v > best)) best = v;                 // the nearest one
  }
  if (best == null) return { stop: sell ? wick + 2 * margin : wick - 2 * margin, stopKind: 'wick + margin (no zone found)', stopZone: null };
  return { stop: sell ? best + margin : best - margin, stopKind: 'S/R zone', stopZone: best };
}

function applyZoneStops(candles, res) {
  const idx = new Map(candles.map((c, i) => [c.t, i]));
  for (const d of res) {
    for (const sd of [].concat(d.sides || [], d.fibs || [], d.setupB || [], d.tl || [])) {
      if (sd.state !== 'signal' || sd.wick != null) continue;
      const ci = idx.get(sd.confT);
      if (ci == null) continue;
      sd.wick = sd.stop;   // the extreme of the wick that took the liquidity (still used for the 50%)
      // Book stop (pp. 170-171): beyond the next S/R zone. 10-year backtest (Nov 2026): smallest loss of all stop rules tested.
      const recent = candles.slice(Math.max(0, ci - 100), ci + 1);
      sd.stopBuf = STOP_BUFFER * recent.reduce((a, c) => a + (c.h - c.l), 0) / Math.max(1, recent.length);
      Object.assign(sd, zoneStop(candles, ci, sd.dir === 'SELL', sd.wick));
    }
  }
}

// ---------- Trend lines (LST 2.0 pp. 61-66, 103, 126) ----------
// A trend line is a dynamic S/R: at least 2 swing points joined by a line that price respects.
// The book: never enter on the 2nd point; wait for speed away from the line and a corrective pullback, then a
// Model 1/2/3 at the NEXT touch (3rd point or later) = BOUNCE. When a line with 3+ touches breaks with force,
// price usually comes back to retest it from the other side: a model there = RETEST (the trade goes the other way).
const TL_PIVOT = 3;          // swing point = extreme vs 3 candles on each side
const TL_MIN_GAP = 5;        // candles between the two points that start a line
const TL_MAX_SPAN = 200;     // a line older than this (from its first point) is dropped
const TL_TOL = 0.3;          // touch zone around the line = 30% of the average candle range
const TL_AWAY = 3;           // after a touch price must move away >= 3 average candles before the next touch counts
const TL_RETEST_MAX = 30;    // candles after the break to get the retest
const TL_MAX_LINES = 3;      // lines kept per direction

function detectTrendlines(X) {
  const n = X.length, signals = [], lines = [];
  if (n < 30) return { signals, lines };
  const pre = [0]; for (const c of X) pre.push(pre[pre.length - 1] + (c.h - c.l));
  const avgAt = i => { const a = Math.max(0, i - 99); return (pre[i + 1] - pre[a]) / (i + 1 - a); };
  const body = c => Math.abs(c.c - c.o), range = c => Math.max(c.h - c.l, 1e-12);
  const avgBody = (a, b) => { let s = 0, k = 0; for (let j = a; j <= b; j++) { s += body(X[j]); k++; } return k ? s / k : 0; };
  const piv = { up: [], down: [] };            // confirmed swing lows (for rising lines) / highs (for falling lines)
  const act = { up: [], down: [] };
  const val = (L, i) => L.v1 + L.slope * (i - L.i1);

  for (let i = 0; i < n; i++) {
    const tol = TL_TOL * avgAt(i);
    // 1. a swing point confirmed now (TL_PIVOT candles later) -> new line or touch of an existing one
    const j = i - TL_PIVOT;
    if (j >= TL_PIVOT) for (const dir of ['up', 'down']) {
      const lowSide = dir === 'up', v = lowSide ? X[j].l : X[j].h;
      let ok = true;
      for (let k = 1; k <= TL_PIVOT && ok; k++) ok = lowSide ? (X[j - k].l > v && X[j + k].l >= v) : (X[j - k].h < v && X[j + k].h <= v);
      if (!ok) continue;
      const P = piv[dir];
      while (P.length && j - P[0].i > TL_MAX_SPAN) P.shift();
      const onLine = act[dir].some(L => L.state === 'active' && Math.abs(val(L, j) - v) <= tol);
      if (!onLine) {
        // the oldest earlier point that makes a line no candle crossed in between (rising: higher low; falling: lower high)
        for (const q of P) {
          if (j - q.i < TL_MIN_GAP || (lowSide ? q.v >= v : q.v <= v)) continue;
          const slope = (v - q.v) / (j - q.i);
          let clean = true;
          for (let k = q.i + 1; k <= i && clean; k++) {
            const lv = q.v + slope * (k - q.i);
            clean = lowSide ? X[k].l >= lv - tol && X[k].c >= lv - tol : X[k].h <= lv + tol && X[k].c <= lv + tol;
          }
          if (!clean) continue;
          let ext = j; for (let k = j; k <= i; k++) if (lowSide ? X[k].h > X[ext].h : X[k].l < X[ext].l) ext = k;
          const L = { dir, i1: q.i, v1: q.v, i2: j, v2: v, slope, touches: [q.i, j], state: 'active', last: j, ext, pend: null };
          act[dir] = act[dir].filter(o => o.i1 !== q.i && o.state !== 'dead');
          act[dir].push(L);
          if (act[dir].filter(o => o.state === 'active').length > TL_MAX_LINES) act[dir].splice(act[dir].findIndex(o => o.state === 'active'), 1);
          break;
        }
      }
      P.push({ i: j, v });
    }

    // 2. follow every line with this candle
    for (const dir of ['up', 'down']) for (const L of act[dir]) {
      if (L.state === 'dead' || i <= L.i2 + TL_PIVOT) continue;
      const c = X[i], Li = val(L, i), up = dir === 'up';
      if (L.state === 'active' && i - L.i1 > TL_MAX_SPAN) { L.state = 'dead'; continue; }

      if (!L.pend) {
        if (L.state === 'active') {
          // break: a close through the line beyond the touch zone
          if (up ? c.c < Li - tol : c.c > Li + tol) {
            const forceful = (up ? c.c < c.o : c.c > c.o) && body(c) / range(c) >= FORCE_BODY && range(c) >= FORCE_RANGE * avgAt(i);
            if (forceful && L.touches.length >= 3) Object.assign(L, { state: 'broken', bi: i, E: i, breakBody: body(c) });
            else L.state = 'dead';
            continue;
          }
          if (up ? c.h > X[L.ext].h : c.l < X[L.ext].l) L.ext = i;
          const touch = up ? c.l <= Li + tol : c.h >= Li - tol;
          if (!touch || L.ext <= L.last) continue;
          const away = up ? X[L.ext].h - val(L, L.ext) : val(L, L.ext) - X[L.ext].l;
          if (away < TL_AWAY * avgAt(i)) continue;   // price never really left the line: still the same touch
          const corrective = avgBody(L.ext + 1, i) < avgBody(L.last, L.ext);
          const swept = up ? c.l < Li : c.h > Li;
          L.touches.push(i);
          if (swept && corrective) L.pend = { sub: 'bounce', sell: !up, gi: i, level: Li, target: up ? X[L.ext].h : X[L.ext].l, touchNo: L.touches.length };
          L.last = i; L.ext = i;
        } else {   // broken: waiting for the retest from the other side
          if (up ? c.c > Li + tol : c.c < Li - tol) { L.state = 'dead'; continue; }   // false break: back on the old side
          if (i - L.bi > TL_RETEST_MAX) { L.state = 'dead'; continue; }
          if (up ? c.l < X[L.E].l : c.h > X[L.E].h) L.E = i;
          const swept = up ? c.h > Li : c.l < Li;
          if (!swept || L.E >= i) continue;
          if (avgBody(L.E + 1, i) >= L.breakBody) continue;   // the retest must be weaker (corrective) than the break
          L.pend = { sub: 'retest', sell: up, gi: i, level: Li, target: up ? X[L.E].l : X[L.E].h, touchNo: L.touches.length };
        }
      }

      // a touch / retest waiting for its model (3-candle window, the same 3 models as everywhere else)
      const p = L.pend; if (!p) continue;
      const k = helpers(p.sell, p.level);
      const model = i === p.gi && k.m1(c) ? 1 : i === p.gi + 1 && k.m2(c, X[p.gi]) ? 2 : i === p.gi + 2 && k.m3(c) ? 3 : null;
      if (model) {
        const span = X.slice(p.gi, i + 1);
        const wick = p.sell ? Math.max(...span.map(x => x.h)) : Math.min(...span.map(x => x.l));
        const tgtOk = p.sell ? p.target < c.c : p.target > c.c;
        const partial = (wick + p.target) / 2;   // 50% of the move that came back to the line
        signals.push({
          kind: 'tl', sub: p.sub, side: p.sell ? 'sell' : 'buy', dir: p.sell ? 'SELL' : 'BUY', state: 'signal', model,
          grabT: X[p.gi].t, confT: c.t, entry: c.c, stop: wick, partial, partialPassed: p.sell ? c.c <= partial : c.c >= partial,
          target: tgtOk ? p.target : null, level: p.level, touches: p.touchNo, lineDir: dir, breakT: L.bi != null ? X[L.bi].t : null,
          line: { t1: X[L.i1].t, v1: L.v1, slope: L.slope, i1: L.i1 },
          m1weak: model === 1 && Math.abs(c.c - p.level) / range(c) < 0.15
        });
        L.pend = null;
        if (p.sub === 'retest') L.state = 'dead';   // one retest trade per broken line
      } else if (i >= p.gi + 2) L.pend = null;
    }
    for (const dir of ['up', 'down']) act[dir] = act[dir].filter(L => L.state !== 'dead');
  }
  // lines still alive at the last candle (for the chart and the cells)
  const last = n - 1;
  for (const dir of ['up', 'down']) for (const L of act[dir]) {
    lines.push({
      dir, state: L.state === 'broken' ? 'broken' : L.touches.length >= 3 ? 'valid' : 'forming',
      t1: X[L.i1].t, v1: L.v1, i1: L.i1, slope: L.slope, touches: L.touches.map(k => ({ t: X[k].t, v: val(L, k) })),
      now: val(L, last), breakT: L.bi != null ? X[L.bi].t : null, valAt: k => val(L, k)
    });
  }
  return { signals, lines };
}

// ---------- Liquidity + S/R zone (LST 2.0 p.103 "the 4 places"; how Mr.LQDT trades in his channel) ----------
// $$$ = an old swing high/low (often equal highs/lows) that price has not taken yet. When a candle sweeps it AND it
// sits on an S/R zone (a price where the market already turned at least ZONE_MIN_REACT times before), a Model 1/2/3
// at that level is the signal - at any hour, not only around the Asia range.
// Stop: beyond the next S/R zone (pp.170-171). Target: the next opposite $$$ still untaken, far enough for 1:LQ_MIN_RR.
const LQ = {
  PIVOT: 3,            // swing point that holds liquidity (stops behind it)
  LOOKBACK: 150,       // how old that swing may be (candles)
  ZONE_PIVOT: 5,       // bigger swing points used to find S/R zones
  ZONE_LOOKBACK: 400,  // candles back to look for those reactions
  ZONE_TOL: 0.5,       // a reaction counts if within 50% of an average candle of the level
  ZONE_MIN_REACT: 2,   // earlier reactions needed for the level to be a zone
  MIN_RR: 1.5,         // target: first opposite liquidity at >= 1:1.5 with the zone stop (else: no target)
};

function detectLiquidity(X, opt = {}) {
  const P = Object.assign({}, LQ, opt), n = X.length, signals = [];
  if (n < 50) return signals;
  const pre = [0]; for (const c of X) pre.push(pre[pre.length - 1] + (c.h - c.l));
  const avgAt = i => { const a = Math.max(0, i - 99); return (pre[i + 1] - pre[a]) / (i + 1 - a); };
  const isPiv = (j, p, hi) => {
    if (j - p < 0 || j + p >= n) return false;
    const v = hi ? X[j].h : X[j].l;
    for (let k = 1; k <= p; k++) {
      if (hi ? (X[j - k].h >= v || X[j + k].h > v) : (X[j - k].l <= v || X[j + k].l < v)) return false;
    }
    return true;
  };
  const liq = { hi: [], lo: [] };       // untaken swing points (the $$$)
  const zp = [];                         // zone reactions: {i, v} of both swing highs and lows (S/R flips)
  const pend = { hi: null, lo: null };

  for (let i = 0; i < n; i++) {
    const c = X[i], avg = avgAt(i), ztol = P.ZONE_TOL * avg;
    // newly confirmed swing points (only what was knowable at this candle)
    const j = i - P.PIVOT;
    if (j >= 0) {
      if (isPiv(j, P.PIVOT, true)) liq.hi.push({ i: j, v: X[j].h });
      if (isPiv(j, P.PIVOT, false)) liq.lo.push({ i: j, v: X[j].l });
    }
    const jz = i - P.ZONE_PIVOT;
    if (jz >= 0) {
      if (isPiv(jz, P.ZONE_PIVOT, true)) zp.push({ i: jz, v: X[jz].h });
      if (isPiv(jz, P.ZONE_PIVOT, false)) zp.push({ i: jz, v: X[jz].l });
    }
    while (zp.length && i - zp[0].i > P.ZONE_LOOKBACK) zp.shift();

    for (const side of ['hi', 'lo']) {
      const sell = side === 'hi';
      // a sweep waiting for its model (same 3 models and 3-candle window as everywhere else)
      const p = pend[side];
      if (p) {
        const k = helpers(sell, p.level);
        const model = i === p.gi + 1 && k.m2(c, X[p.gi]) ? 2 : i === p.gi + 2 && k.m3(c) ? 3 : null;
        if (model) signals.push(build(p, i, model, sell));
        if (model || i >= p.gi + 2) pend[side] = null;
      }
      // liquidity this candle takes
      const L = liq[side];
      while (L.length && i - L[0].i > P.LOOKBACK) L.shift();
      const swept = L.filter(s => s.i + P.PIVOT < i && (sell ? c.h > s.v : c.l < s.v));
      if (!swept.length) continue;
      liq[side] = L.filter(s => !swept.includes(s));          // taken: that $$$ is gone
      if (pend[side]) continue;
      const S = swept.reduce((a, b) => sell ? (b.v > a.v ? b : a) : (b.v < a.v ? b : a));   // the furthest level taken
      // S/R zone: other reactions (already confirmed swing points, not the swing itself) around that price
      const react = zp.filter(z => z.i !== S.i && Math.abs(z.v - S.v) <= ztol).length;
      if (react < P.ZONE_MIN_REACT) continue;
      const equal = swept.filter(s => Math.abs(s.v - S.v) <= ztol).length;   // equal highs / lows = more $$$
      pend[side] = { gi: i, level: S.v, swingT: X[S.i].t, react, equal };
      const k = helpers(sell, S.v);
      if (k.m1(c)) { signals.push(build(pend[side], i, 1, sell)); pend[side] = null; }
    }
  }
  return signals;

  function build(p, ci, model, sell) {
    const conf = X[ci], span = X.slice(p.gi, ci + 1);
    const wick = sell ? Math.max(...span.map(x => x.h)) : Math.min(...span.map(x => x.l));
    const zs = zoneStop(X, ci, sell, wick);
    const risk = Math.abs(conf.c - zs.stop);
    // origin of the move that took the liquidity (for the book's 50%)
    const before = X.slice(Math.max(0, p.gi - MOVE_LOOKBACK), p.gi + 1);
    const origin = sell ? Math.min(...before.map(x => x.l)) : Math.max(...before.map(x => x.h));
    // opposite liquidity still untaken at the close of the model candle, nearest first
    const opp = (sell ? liq.lo : liq.hi).filter(s => s.i + P.PIVOT <= ci && (sell ? s.v < conf.c : s.v > conf.c))
      .map(s => s.v).sort((a, b) => Math.abs(a - conf.c) - Math.abs(b - conf.c));
    const target = opp.find(v => Math.abs(v - conf.c) >= P.MIN_RR * risk);
    const partial = (wick + origin) / 2;
    return {
      kind: 'lq', side: sell ? 'sell' : 'buy', dir: sell ? 'SELL' : 'BUY', state: 'signal', model,
      grabT: X[p.gi].t, confT: conf.t, entry: conf.c, level: p.level, swingT: p.swingT, react: p.react, equal: p.equal,
      wick, ...zs, origin, partial, partialPassed: sell ? conf.c <= partial : conf.c >= partial,
      target: target != null ? target : null, nearestOpp: opp.length ? opp[0] : null, opp,
      m1weak: model === 1 && Math.abs(conf.c - p.level) / Math.max(conf.h - conf.l, 1e-12) < 0.15
    };
  }
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
    res.setupB = res.sides.map(sd => detectSetupB(d, sd, idx > 0 ? days[idx - 1] : null)).filter(b => b && b.state !== 'invalid');
    out.push(res);
  });
  // trend lines run over the whole series (not tied to the Asia day); each signal is filed under its trading day
  const tl = detectTrendlines(candles), byDay = new Map(out.map(r => [r.day, r]));
  for (const r of out) r.tl = [];
  for (const sg of tl.signals) { const r = byDay.get(tradingDay(sg.confT)); if (r) r.tl.push(sg); }
  out.tlLines = tl.lines;
  applyZoneStops(candles, out);
  return out;   // oldest -> newest
}

if (typeof module !== 'undefined') module.exports = { ny, tradingDay, sessionOf, isPrime, groupDays, detectSide, detectFib, detectSetupB, structure, toDaily, trendInfo, outcome, zoneStop, detectTrendlines, detectLiquidity, LQ, analyze };
