# 0004 — PnL reporting

Status: implemented and verified against mainnet

## Context

Steps 1–4 ([0001](0001-arcus-spot-buy-cli.md), [0002](0002-uniswap-v4-lp-deposit.md), [0003](0003-position-monitor.md)) run the strategy. This adds `npm run pnl`: a read-only report of profit and loss that accounts for fees earned in the pool.

## Decisions

- **Numéraire is USDG.** The strategy rests in USDG, so profit is what came back plus what is still deployed, minus what went in. No external price feed is needed — the stock token is marked at the pool's own price, the same price that determines the position's composition.
- **Chain-derived, no local ledger.** The wallet is used outside this bot, and a bot-kept record would drift the moment that happens. It already would have: a buy this project made was followed 35 seconds later by a manual sell, and only the on-chain logs showed it. Logs cannot drift.
- **All history by default**, with `--from-block` to narrow. Manual trades in the same pair are therefore included, which is intended — they are real exposure to the same position.

## How fees are measured

`accruedFees = liquidity × (feeGrowthInside_now − feeGrowthInside_last) / 2^128`, read from StateView with PositionManager as the owner and the NFT id as the salt. The subtraction is taken modulo 2^256 because the pool deliberately lets those accumulators overflow.

This reads uncollected fees on an **open** position without sending a transaction.

## Capital accounting

The first working version reported +42% profit, which was wrong. The bug is worth recording because it is easy to reintroduce:

> A deposit funds the position from **two** sources — the stock token bought on Arcus, and USDG taken straight from the wallet. Only the first passes through an Arcus trade. Counting the position's full value as a gain while counting only the Arcus spend as capital invents profit equal to the USDG side of the deposit (~12.7 USDG here).

So capital in is `Arcus purchases + USDG deposited into positions`, where the deposited amount is recovered from the mint transaction's ERC20 `Transfer` logs. `pnlCalculator.test.ts` pins this with a case asserting that omitting the deposit inflates net by exactly the deposited amount.

```
net = (USDG from sells) + (open value at pool price) + (uncollected fees) − (Arcus purchases + USDG deposited)
```

## Known limitation

The RPC serves historical **state** only ~1000 blocks back — verified: a read 100k blocks back fails. A position that closed long ago therefore cannot have its exit price read, so fees cannot be split from principal for historical closed positions.

This does not affect realized PnL, which comes from logs. It only limits the fee/principal split to positions still open. If it matters later, the pool price at any past block can be recovered from `PoolManager`'s `Swap` events, since logs are retained even where state is not.

## Verified against mainnet

```
capital in   42.6845 USDG  (NVDA purchases + USDG deposited)
capital out  14.9895 USDG
still open   27.7126 USDG
fees earned  +0.0273 USDG
net          +0.0449 USDG  (+0.11%)
```

Position 422596 was funded by 12.684530 USDG from the wallet, read from mint tx `0x7a72ea7e…`. Accrued fees at the time of writing were 0.011842 USDG + 0.000071740 NVDA, reproduced exactly by a unit test against the values read from chain.

## Not built

- Splitting net into divergence loss vs. fee income vs. execution spread. Net is currently a single figure plus fees.
- Gas, which is paid in ETH and would need a rate to express in USDG.
- Annualized return. Deliberately omitted: over one short cycle it is almost entirely noise.
