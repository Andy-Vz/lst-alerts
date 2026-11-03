// LST (Liquidity Side Theory) - strategy logic. Pure functions, no UI.
// Candles: {t: openTime ms UTC, o, h, l, c}

const ASIA_START = 19, ASIA_END = 3;   // 7 PM -> 3 AM New York time (PDF page 5)
const HUNT_END = 12;                    // London + New York openings: 3 AM -> 12 PM NY
const MOVE_LOOKBACK = 12;               // candles used to find the start of the move that grabbed liquidity

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

function groupDays(candles, tfMs) {
  const days = new Map();
  for (const c of candles) {
    const d = tradingDay(c.t);
    if (!days.has(d)) days.set(d, { key: d, asia: [], hunt: [], seq: [] });
    const g = days.get(d);
    const s = sessionOf(c.t);
    if (s === 'asia') g.asia.push(c);
    else if (s === 'london' || s === 'newyork') g.hunt.push(c);
    else continue;
    g.seq.push(c);
  }
  const minAsia = Math.max(1, Math.floor((8 * 3600e3 / tfMs) * 0.6));
  for (const g of days.values()) {
    g.asiaOk = g.asia.length >= minAsia;
    if (g.asia.length) {
      g.hi = Math.max(...g.asia.map(c => c.h));
      g.lo = Math.min(...g.asia.map(c => c.l));
    }
  }
  return [...days.values()];
}

// Look for a liquidity grab of the Asia high (sell) or low (buy) and the 3 confirmation models.
function detectSide(day, side) {
  const sell = side === 'sell';
  const L = sell ? day.hi : day.lo;
  const H = day.hunt;
  const gi = H.findIndex(c => sell ? c.h > L : c.l < L);
  if (gi < 0) return { side, state: 'waiting', level: L };

  const g = H[gi];
  const closesBack = c => sell ? c.c < L : c.c > L;
  const dirCandle = c => sell ? c.c < c.o : c.c > c.o;
  const bHi = c => Math.max(c.o, c.c), bLo = c => Math.min(c.o, c.c);
  const engulfs = (a, b) => dirCandle(a) && bHi(a) >= bHi(b) && bLo(a) <= bLo(b);

  let model = null, ci = -1;
  if (closesBack(g)) { model = 1; ci = gi; }
  else if (H[gi + 1] && engulfs(H[gi + 1], g) && closesBack(H[gi + 1])) { model = 2; ci = gi + 1; }
  else if (H[gi + 2] && engulfs(H[gi + 2], H[gi + 1]) && closesBack(H[gi + 2])) { model = 3; ci = gi + 2; }

  const base = { side, level: L, grabT: g.t };
  if (model === null) {
    if (!H[gi + 2]) return { ...base, state: 'grabbed' };          // still inside the 3-candle window
    const last = H[H.length - 1];
    return { ...base, state: closesBack(last) ? 'nomodel' : 'continuation' };
  }

  const conf = H[ci];
  const span = H.slice(gi, ci + 1);
  const stop = sell ? Math.max(...span.map(c => c.h)) : Math.min(...span.map(c => c.l));
  const si = day.seq.indexOf(g);
  const before = day.seq.slice(Math.max(0, si - MOVE_LOOKBACK), si + 1);
  const origin = sell ? Math.min(...before.map(c => c.l)) : Math.max(...before.map(c => c.h));
  const partial = (stop + origin) / 2;   // 50% of the move that took the liquidity (PDF page 24)
  return {
    ...base, state: 'signal', model, confT: conf.t, entry: conf.c,
    stop, origin, partial, dir: sell ? 'SELL' : 'BUY'
  };
}

function analyze(candles, tfMs, now = Date.now()) {
  const days = groupDays(candles, tfMs).filter(d => d.asiaOk);
  const out = [];
  for (const d of days) {
    const asiaDone = d.hunt.length > 0;
    const res = { day: d.key, hi: d.hi, lo: d.lo, asiaDone, asiaCandles: d.asia.map(c => c.t), sides: [] };
    if (asiaDone) res.sides = [detectSide(d, 'sell'), detectSide(d, 'buy')];
    out.push(res);
  }
  return out;   // oldest -> newest
}

if (typeof module !== 'undefined') module.exports = { ny, tradingDay, sessionOf, groupDays, detectSide, analyze };
