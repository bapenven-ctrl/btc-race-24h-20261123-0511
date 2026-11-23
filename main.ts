// DipSnap V1 — a shallow-dip mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).
//
// Strategy, in one paragraph: on a 1-minute bar stream where a full round trip
// costs roughly 26 bps in fees, slippage and price impact, the only edge worth
// taking is a snapback after a shallow dip, or a fresh uptrend leg. The bot stays
// in cash until the latest close sits at least DIP_BPS below the rolling 60-bar
// high while a slow trend gate (close above the 240-bar average) says the market
// is dipping, not collapsing — or the fast EMA crosses back above the slow EMA
// while the price holds above its 120-bar average. A dip entry fires only on the
// bar the condition first becomes true, and no re-entry follows any exit for
// 120 bars, so a falling dip is never bought twice in a row. It then buys a
// large but not full slice of equity, and leaves on the first of: a take-profit
// above its fee-inclusive cost, a trailing exit once the bounce has run, a hard
// stop below cost, a long time stop, or a trend break. A late, smaller fallback
// entry guarantees the bot has traded at least once on a window where the
// primary dip never quite fires. A hard drawdown guard flattens everything and
// halts trading if equity ever falls 8% from its peak, far inside the 25%
// guardrail. Everything is a pure function of the hello message and the batch
// stream — no clock, no network, no randomness, no files — so two runs on the
// same bars produce byte-identical orders.
//
// The wire protocol (hello, one batch per bar, one reply of orders per batch)
// is spoken by the vendored kit shim in vendor/makefun-bars.ts (a byte-identical
// copy of the kit's sdk/makefun-bars.ts).

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- Entry: what counts as a buyable dip -----------------------------------
const DIP_BPS = 70; // buy when close is >= 0.70% below the rolling 60-bar high
const HIGH_BARS = 60; // window for the rolling high
const TREND_BARS = 240; // slow average for the trend gate (4 hours)
const MID_BARS = 120; // medium average for the momentum entry gate
const EMA_FAST = 8; // fast EMA for the momentum cross
const EMA_SLOW = 21; // slow EMA for the momentum cross
const RSI_BARS = 14; // RSI window (Wilder); dip needs RSI below this
const RSI_DIP_BELOW = 45;
const EXIT_COOLDOWN_BARS = 120; // no re-entry for 120 bars after ANY exit
const NO_ENTRY_AFTER_BAR = 1320; // no new dip/momentum entries in the last 2 hours

// --- Position sizing ---------------------------------------------------------
const BUY_FRACTION_BPS = 6000; // buy 60% of equity per entry
const FALLBACK_FRACTION_BPS = 5000; // late fallback buys 50% of equity

// --- Exits -------------------------------------------------------------------
const TP_BPS = 120; // take profit at +1.20% over fee-inclusive cost
const SL_BPS = 60; // hard stop at -0.60% under fee-inclusive cost
const TRAIL_ARM_BPS = 80; // trailing exit arms once +0.80% over cost
const TRAIL_BPS = 50; // ...then exits 0.50% below the peak value since entry
const TIME_BARS = 360; // time stop: exit after 6 hours held
const TREND_BREAK_BPS = 20; // exit if close falls 0.20% below the 240-bar average

// --- Risk guards ---------------------------------------------------------------
const MAX_DD_BPS = 800; // flatten + halt if equity falls 8% from its peak
const FALLBACK_BAR = 1200; // if still no trade by bar 1200, take the fallback entry
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// --- Trend-hold entry (regime filter) ----------------------------------------
const TREND_ENTRY_ON = false; // when true, enter on uptrend, not on dips/crosses
const TREND_SLOPE_BPS = 0; // min rise of the 240-bar average over the last 60 bars
const TREND_SLOPE_BARS = 60;
const FALLBACK_TREND_GATE = true; // when false, the late fallback buys regardless of trend

const BPS = 10000n;
const MIN_NOTIONAL = 1000000n; // $1 in quote units

/** Rolling indicator state for one symbol, updated once per bar. */
class Series {
  closes: bigint[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  rsiGain: number | null = null;
  rsiLoss: number | null = null;
  private firstChanges: number[] = [];

  push(close: bigint): void {
    const prev = this.closes.length > 0 ? this.closes[this.closes.length - 1] : null;
    this.closes.push(close);
    if (this.closes.length > TREND_BARS) this.closes.shift();
    const c = Number(close);
    if (prev === null) {
      this.emaFast = c;
      this.emaSlow = c;
      return;
    }
    const kf = 2 / (EMA_FAST + 1);
    const ks = 2 / (EMA_SLOW + 1);
    this.emaFast! += kf * (c - this.emaFast!);
    this.emaSlow! += ks * (c - this.emaSlow!);
    const change = c - Number(prev);
    if (this.rsiGain === null) {
      this.firstChanges.push(change);
      if (this.firstChanges.length >= RSI_BARS) {
        const ups = this.firstChanges.reduce((a, x) => a + (x > 0 ? x : 0), 0);
        const downs = this.firstChanges.reduce((a, x) => a + (x < 0 ? -x : 0), 0);
        this.rsiGain = ups / RSI_BARS;
        this.rsiLoss = downs / RSI_BARS;
      }
    } else {
      const up = change > 0 ? change : 0;
      const down = change < 0 ? -change : 0;
      this.rsiGain = (this.rsiGain * (RSI_BARS - 1) + up) / RSI_BARS;
      this.rsiLoss = (this.rsiLoss * (RSI_BARS - 1) + down) / RSI_BARS;
    }
  }

  rsi(): number | null {
    if (this.rsiGain === null || this.rsiLoss === null) return null;
    const moved = this.rsiGain + this.rsiLoss;
    if (moved === 0) return 50;
    return (100 * this.rsiGain) / moved;
  }

  high(n: number): bigint | null {
    const w = this.closes.slice(-n);
    if (w.length === 0) return null;
    let m = w[0];
    for (const x of w) if (x > m) m = x;
    return m;
  }

  sma(n: number): bigint | null {
    const w = this.closes.slice(-n);
    if (w.length < n) return null;
    let s = 0n;
    for (const x of w) s += x;
    return s / BigInt(n);
  }
}

class Bot {
  series = new Series();
  prevEmaFast: number | null = null;
  prevEmaSlow: number | null = null;
  peakEquity: bigint | null = null;
  halted = false;
  entrySeq: number | null = null;
  peakValue: bigint | null = null;
  trades = 0;
  sma240Hist: bigint[] = [];
  prevDip = false;
  exitSeq: number | null = null;

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const fresh = new Set(batch.bars.map((b) => b.symbol));
    if (!fresh.has(SYMBOL)) return []; // missing bar: never trade blind
    const bar = state.latest.get(SYMBOL)!;
    const close = BigInt(bar.c);

    for (const f of batch.fills) {
      if (f.status === 'filled' && f.symbol === SYMBOL) this.trades += 1;
    }

    const equity = state.equity;
    if (this.peakEquity === null) this.peakEquity = equity;
    else if (equity > this.peakEquity) this.peakEquity = equity;
    if (!this.halted && equity * BPS <= this.peakEquity * (BPS - BigInt(MAX_DD_BPS))) {
      this.halted = true;
      const held = state.positions.get(SYMBOL);
      if (held !== undefined && held.qty > 0n) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    const prevFast = this.prevEmaFast;
    const prevSlow = this.prevEmaSlow;
    this.series.push(close);
    this.prevEmaFast = this.series.emaFast;
    this.prevEmaSlow = this.series.emaSlow;
    const crossedUp =
      prevFast !== null && prevSlow !== null &&
      prevFast <= prevSlow && this.series.emaFast! > this.series.emaSlow!;

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    if (holding) {
      const value = state.value(SYMBOL, held!.qty);
      const cost = held!.cost;
      if (this.peakValue === null || value > this.peakValue) this.peakValue = value;
      let sell = false;
      if (value * BPS >= cost * (BPS + BigInt(TP_BPS))) {
        sell = true; // take profit
      } else if (value * BPS <= cost * (BPS - BigInt(SL_BPS))) {
        sell = true; // hard stop
      } else if (
        this.peakValue !== null &&
        this.peakValue * BPS >= cost * (BPS + BigInt(TRAIL_ARM_BPS)) &&
        value * BPS <= this.peakValue * (BPS - BigInt(TRAIL_BPS))
      ) {
        sell = true; // trailing exit
      } else if (this.entrySeq !== null && state.seq - this.entrySeq >= TIME_BARS) {
        sell = true; // time stop
      } else {
        const smaTrend = this.series.sma(TREND_BARS);
        if (smaTrend !== null && close * BPS <= smaTrend * (BPS - BigInt(TREND_BREAK_BPS))) {
          sell = true; // trend break
        }
      }
      if (sell) {
        this.entrySeq = null;
        this.peakValue = null;
        this.exitSeq = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for an entry.
    if (this.halted) return [];
    if (this.exitSeq !== null && state.seq - this.exitSeq < EXIT_COOLDOWN_BARS) {
      return []; // cooldown after any exit: never re-buy the same dip
    }
    if (state.warmingUp) return [];
    const smaTrend = this.series.sma(TREND_BARS);
    const smaMid = this.series.sma(MID_BARS);
    const high60 = this.series.high(HIGH_BARS);
    const rsi = this.series.rsi();
    if (smaTrend !== null) this.sma240Hist.push(smaTrend);
    const dipNow =
      high60 !== null && smaTrend !== null && rsi !== null &&
      close * BPS <= high60 * (BPS - BigInt(DIP_BPS)) &&
      close > smaTrend && rsi < RSI_DIP_BELOW;
    const dipEdge = dipNow && !this.prevDip;
    this.prevDip = dipNow;
    let frac: number | null = null;
    if (TREND_ENTRY_ON) {
      let slopeOk = false;
      if (this.sma240Hist.length > TREND_SLOPE_BARS) {
        const old = this.sma240Hist[this.sma240Hist.length - 1 - TREND_SLOPE_BARS];
        slopeOk = smaTrend! * BPS >= old * (BPS + BigInt(TREND_SLOPE_BPS));
      }
      if (smaTrend !== null && close > smaTrend && slopeOk) {
        frac = BUY_FRACTION_BPS; // uptrend: be long, let it run
      }
    } else if (state.seq <= NO_ENTRY_AFTER_BAR && dipEdge) {
      frac = BUY_FRACTION_BPS; // shallow dip, freshly triggered, in an uptrend
    } else if (state.seq <= NO_ENTRY_AFTER_BAR && crossedUp && smaMid !== null && close > smaMid) {
      frac = BUY_FRACTION_BPS; // fresh momentum leg
    } else if (
      state.seq >= FALLBACK_BAR && this.trades === 0 &&
      (!FALLBACK_TREND_GATE || (smaMid !== null && close > smaMid))
    ) {
      frac = FALLBACK_FRACTION_BPS; // late fallback: guarantee >= 1 trade
    }
    if (frac === null) return [];
    let notional = (state.equity * BigInt(frac)) / BPS;
    const room = state.weightRoom(SYMBOL);
    if (room < notional) notional = room;
    if (notional > state.cash) notional = state.cash;
    if (notional < MIN_NOTIONAL) return []; // min notional $1
    this.entrySeq = state.seq;
    this.peakValue = null;
    const buy: BuyInput = {
      side: 'buy', symbol: SYMBOL,
      notional_quote_units: notional,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
    return [buy];
  }
}

const bot = new Bot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
