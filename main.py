"""DipSnap V1 — a shallow-dip mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).

Strategy, in one paragraph: on a 1-minute bar stream where a full round trip
costs roughly 26 bps in fees, slippage and price impact, the only edge worth
taking is a snapback after a shallow dip, or a fresh uptrend leg. The bot stays
in cash until the latest close sits at least DIP_BPS below the rolling 60-bar
high while a slow trend gate (close above the 240-bar average) says the market
is dipping, not collapsing — or the fast EMA crosses back above the slow EMA
while the price holds above its 120-bar average. A second mode, TREND_ENTRY_ON,
skips the dip and cross entries entirely and simply goes long 100% whenever
the price holds above a rising 240-bar average, exiting on a trend break or a
trailing stop — it trades rarely, which is what survives flat markets where
every round trip costs ~26 bps. It then buys a large but not
full slice of equity, and leaves on the first of: a take-profit above its
fee-inclusive cost, a trailing exit once the bounce has run, a hard stop below
cost, a long time stop, or a trend break. A stop-out starts a cooldown so the
same falling dip is never bought twice, and a late, smaller fallback entry
guarantees the bot has traded at least once on a window where the primary dip
never quite fires. A hard drawdown guard flattens everything and halts trading
if equity ever falls 8% from its peak, far inside the 25% guardrail.
Everything is a pure function of the hello message and the batch stream — no
clock, no network, no randomness, no files — so two runs on the same bars
produce byte-identical orders.

The wire protocol (hello, one batch per bar, one reply of orders per batch)
is spoken by the vendored kit shim in vendor/makefun_bars.py (a byte-identical
copy of the kit's sdk/makefun_bars.py).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

SYMBOL = "CBBTC"

# --- Entry: what counts as a buyable dip -----------------------------------
DIP_BPS = 70            # buy when close is >= 0.70% below the rolling 60-bar high
HIGH_BARS = 60          # window for the rolling high
TREND_BARS = 240        # slow average for the trend gate (4 hours)
MID_BARS = 120          # medium average for the momentum entry gate
EMA_FAST = 8            # fast EMA for the momentum cross
EMA_SLOW = 21           # slow EMA for the momentum cross
RSI_BARS = 14           # RSI window (Wilder); dip needs RSI below this
RSI_DIP_BELOW = 45
EXIT_COOLDOWN_BARS = 120  # no re-entry for 120 bars after ANY exit (stops 1-minute churn)
NO_ENTRY_AFTER_BAR = 1320  # no new dip/momentum entries in the last 2 hours

# --- Position sizing ---------------------------------------------------------
BUY_FRACTION_BPS = 6000   # buy 60% of equity per entry
FALLBACK_FRACTION_BPS = 5000  # late fallback buys 50% of equity

# --- Exits -------------------------------------------------------------------
TP_BPS = 120            # take profit at +1.20% over fee-inclusive cost
SL_BPS = 60             # hard stop at -0.60% under fee-inclusive cost
TRAIL_ARM_BPS = 80      # trailing exit arms once +0.80% over cost
TRAIL_BPS = 50          # ...then exits 0.50% below the peak value since entry
TIME_BARS = 360         # time stop: exit after 6 hours held
TREND_BREAK_BPS = 20    # exit if close falls 0.20% below the 240-bar average

# --- Risk guards ---------------------------------------------------------------
MAX_DD_BPS = 800        # flatten + halt if equity falls 8% from its peak
FALLBACK_BAR = 1200     # if still no trade by bar 1200, take the fallback entry
MAX_SLIPPAGE_BPS = 100  # 1% past the close the order was decided on

# --- Trend-hold entry (regime filter) ----------------------------------------
TREND_ENTRY_ON = False  # when True, enter on uptrend, not on dips/crosses
TREND_SLOPE_BPS = 0     # min rise of the 240-bar average over the last 60 bars
TREND_SLOPE_BARS = 60
FALLBACK_TREND_GATE = True  # when False, the late fallback buys regardless of trend


class Series:
    """Rolling indicator state for one symbol, updated once per bar."""

    def __init__(self):
        self.closes = []          # closes, oldest first (ints, price_scale 5)
        self.ema_fast = None      # float EMAs
        self.ema_slow = None
        self.rsi_gain = None      # Wilder averages
        self.rsi_loss = None
        self._first_changes = []

    def push(self, close):
        prev = self.closes[-1] if self.closes else None
        self.closes.append(close)
        if len(self.closes) > TREND_BARS:
            self.closes.pop(0)
        if prev is None:
            self.ema_fast = float(close)
            self.ema_slow = float(close)
            return
        kf = 2.0 / (EMA_FAST + 1)
        ks = 2.0 / (EMA_SLOW + 1)
        self.ema_fast += kf * (close - self.ema_fast)
        self.ema_slow += ks * (close - self.ema_slow)
        change = close - prev
        if self.rsi_gain is None:
            self._first_changes.append(change)
            if len(self._first_changes) >= RSI_BARS:
                ups = sum(c for c in self._first_changes if c > 0)
                downs = sum(-c for c in self._first_changes if c < 0)
                self.rsi_gain = ups / RSI_BARS
                self.rsi_loss = downs / RSI_BARS
        else:
            up = change if change > 0 else 0
            down = -change if change < 0 else 0
            self.rsi_gain = (self.rsi_gain * (RSI_BARS - 1) + up) / RSI_BARS
            self.rsi_loss = (self.rsi_loss * (RSI_BARS - 1) + down) / RSI_BARS

    def rsi(self):
        if self.rsi_gain is None:
            return None
        moved = self.rsi_gain + self.rsi_loss
        if moved == 0:
            return 50.0
        return 100.0 * self.rsi_gain / moved

    def high(self, n):
        window = self.closes[-n:]
        return max(window) if window else None

    def sma(self, n):
        window = self.closes[-n:]
        if len(window) < n:
            return None
        return sum(window) // n

    def crossed_up(self):
        """True if the fast EMA crossed above the slow EMA on the latest bar."""
        return False  # set by caller using previous values; see Bot.crossed


class Bot:
    def __init__(self):
        self.series = Series()
        self.prev_ema_fast = None
        self.prev_ema_slow = None
        self.peak_equity = None
        self.halted = False
        self.entry_seq = None
        self.peak_ratio_num = None  # peak value/cost as (num, den) via ints
        self.peak_value = None
        self.trades = 0
        self.sma240_hist = []   # 240-bar average per bar, for the trend slope
        self.prev_dip = False   # dip condition on the previous bar (edge trigger)
        self.exit_seq = None    # seq of the last exit, for the re-entry cooldown

    def on_batch(self, state, batch):
        fresh = {b["symbol"] for b in batch["bars"]}
        if SYMBOL not in fresh:
            return []  # missing bar: never trade blind
        bar = state.latest[SYMBOL]
        close = int(bar["c"])

        # Track fills: count our own filled orders from this batch's report.
        for f in batch.get("fills", []):
            if f.get("status") == "filled" and f.get("symbol") == SYMBOL:
                self.trades += 1

        # Drawdown guard on marked equity.
        equity = state.equity
        if self.peak_equity is None:
            self.peak_equity = equity
        elif equity > self.peak_equity:
            self.peak_equity = equity
        if not self.halted and equity * 10000 <= self.peak_equity * (10000 - MAX_DD_BPS):
            self.halted = True
            held = state.positions.get(SYMBOL)
            if held is not None and held.qty > 0:
                return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                         "max_slippage_bps": MAX_SLIPPAGE_BPS}]
            return []

        # Update indicators; remember EMA values from before this bar for the cross.
        prev_fast, prev_slow = self.prev_ema_fast, self.prev_ema_slow
        self.series.push(close)
        self.prev_ema_fast, self.prev_ema_slow = self.series.ema_fast, self.series.ema_slow
        crossed_up = (
            prev_fast is not None and prev_slow is not None
            and prev_fast <= prev_slow and self.series.ema_fast > self.series.ema_slow
        )

        held = state.positions.get(SYMBOL)
        holding = held is not None and held.qty > 0

        if holding:
            value = state.value(SYMBOL, held.qty)
            cost = held.cost
            if self.peak_value is None or value > self.peak_value:
                self.peak_value = value
            sell = False
            if value * 10000 >= cost * (10000 + TP_BPS):
                sell = True  # take profit
            elif value * 10000 <= cost * (10000 - SL_BPS):
                sell = True  # hard stop
            elif (self.peak_value is not None
                  and self.peak_value * 10000 >= cost * (10000 + TRAIL_ARM_BPS)
                  and value * 10000 <= self.peak_value * (10000 - TRAIL_BPS)):
                sell = True  # trailing exit
            elif self.entry_seq is not None and state.seq - self.entry_seq >= TIME_BARS:
                sell = True  # time stop
            else:
                sma_trend = self.series.sma(TREND_BARS)
                if sma_trend is not None and close * 10000 <= sma_trend * (10000 - TREND_BREAK_BPS):
                    sell = True  # trend break
            if sell:
                self.entry_seq = None
                self.peak_value = None
                self.exit_seq = state.seq
                return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                         "max_slippage_bps": MAX_SLIPPAGE_BPS}]
            return []

        # Flat: look for an entry.
        if self.halted:
            return []
        if self.exit_seq is not None and state.seq - self.exit_seq < EXIT_COOLDOWN_BARS:
            return []  # cooldown after any exit: never re-buy the same dip
        if state.warming_up:
            return []
        sma_trend = self.series.sma(TREND_BARS)
        sma_mid = self.series.sma(MID_BARS)
        high60 = self.series.high(HIGH_BARS)
        rsi = self.series.rsi()
        if sma_trend is not None:
            self.sma240_hist.append(sma_trend)
        dip_now = (high60 is not None and sma_trend is not None and rsi is not None
                   and close * 10000 <= high60 * (10000 - DIP_BPS)
                   and close > sma_trend and rsi < RSI_DIP_BELOW)
        dip_edge = dip_now and not self.prev_dip
        self.prev_dip = dip_now
        frac = None
        if TREND_ENTRY_ON:
            slope_ok = False
            if len(self.sma240_hist) > TREND_SLOPE_BARS:
                old = self.sma240_hist[-1 - TREND_SLOPE_BARS]
                slope_ok = sma_trend * 10000 >= old * (10000 + TREND_SLOPE_BPS)
            if sma_trend is not None and close > sma_trend and slope_ok:
                frac = BUY_FRACTION_BPS  # uptrend: be long, let it run
        elif state.seq <= NO_ENTRY_AFTER_BAR and dip_edge:
            frac = BUY_FRACTION_BPS  # shallow dip, freshly triggered, in an uptrend
        elif state.seq <= NO_ENTRY_AFTER_BAR and crossed_up and sma_mid is not None and close > sma_mid:
            frac = BUY_FRACTION_BPS  # fresh momentum leg
        elif (state.seq >= FALLBACK_BAR and self.trades == 0
              and (not FALLBACK_TREND_GATE
                   or (sma_mid is not None and close > sma_mid))):
            frac = FALLBACK_FRACTION_BPS  # late fallback: guarantee >= 1 trade
        if frac is None:
            return []
        notional = state.equity * frac // 10000
        room = state.weight_room(SYMBOL)
        if room < notional:
            notional = room
        if notional > state.cash:
            notional = state.cash
        if notional < 1_000_000:  # min notional $1
            return []
        self.entry_seq = state.seq
        self.peak_value = None
        return [{"side": "buy", "symbol": SYMBOL,
                 "notional_quote_units": notional,
                 "max_slippage_bps": MAX_SLIPPAGE_BPS}]


BOT = Bot()


def on_batch(state, batch):
    return BOT.on_batch(state, batch)


if __name__ == "__main__":
    makefun_bars.run(on_batch)
