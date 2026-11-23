# btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/bapenven-ctrl/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/bapenven-ctrl/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

DipSnap V1 — a shallow-dip mean-reversion bot for cbBTC on Solana. It buys shallow dips in an uptrend (with a momentum-cross entry as a second trigger), exits on take-profit, trailing stop, hard stop, time stop, or trend break, and carries a hard 8% drawdown guard. Deterministic: two runs on the same bars produce byte-identical orders. Standard library only; the `vendor/` shim is a byte-identical copy of the kit's `sdk/makefun-bars.ts`.

## Run it

```sh
node main.ts
```

It speaks `agent-fun/bars-replay/v1`: one JSON bar per minute on stdin, one reply of orders per batch on stdout.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
