# 0003 — Position monitor, close, and rebalance

Status: in progress

## Context

Steps 1–3 ([0001](0001-arcus-spot-buy-cli.md), [0002](0002-uniswap-v4-lp-deposit.md)) are implemented and have executed live on mainnet. A position is open: tokenId `422596`, ticks `[223080, 223740]`, liquidity `60210398382745` in the USDG/NVDA 0.3% pool.

This plan covers **step 4**: poll the pool, and when it has shifted fully to one side of the range, close the position, collect principal and fees, and sell any stock token back to USDG on Arcus.

## Exit condition

`currency0` is USDG and `currency1` is the stock token, so by Uniswap's own convention:

| Pool tick | Position composition | Strategy wording |
| --- | --- | --- |
| `<= tickLower` | entirely USDG | "pool shifted all the way to USDG" |
| `>= tickUpper` | entirely stock token | "pool shifted to STOCK_TOKEN 100%" |

Both branches close and then sell whatever stock token the wallet holds, so the resting state is all USDG.

## Decisions

- **Position selection**: auto-discover positions the wallet owns *in the configured pool* with non-zero liquidity. The wallet holds unrelated position NFTs (3 at time of writing, only one from this bot), so filtering by pool key is what prevents closing the wrong thing. `--token-id` pins one explicitly.
- **On trigger**: execute automatically, no prompt. This is an unattended market-making loop the operator launches deliberately. `--dry-run` runs the full detection path and reports what it *would* do without sending anything.
- **Debounce**: close only after `EXIT_CONFIRMATIONS` consecutive out-of-range polls (default 3 ≈ 90s), so a single-block wick that mean-reverts does not realize a loss. The counter resets the moment the pool reads back in range.

## Verified from source

Read from `v4-periphery` directly, not prose docs:

- `BURN_POSITION` = `0x03`, params `(uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData)`.
- `TAKE_PAIR` = `0x11`, params `(address currency0, address currency1, address recipient)`.
- `PositionManager._burn` removes all liquidity **and** returns `feesAccrued` in the same call, so closing collects principal and fees together. No separate collect step.
- `PositionInfo` packs `hasSubscriber` in bits 0–7, `tickLower` in 8–31, `tickUpper` in 32–55. Confirmed by decoding the live position to `[223080, 223740]`, both multiples of the 60 spacing.
- PositionManager is not `ERC721Enumerable`, so ownership discovery must come from `Transfer` logs rather than `tokenOfOwnerByIndex`.

## Module layout

```
src/uniswap/
  positionReader.ts    discover owned positions in a pool; decode PositionInfo
  positionCloser.ts    BURN_POSITION + TAKE_PAIR encoding, simulate, send
  positionMonitor.ts   poll loop, debounce, close, hand off to the Arcus sell
src/arcus/
  spotSwapService.ts   renamed from spotBuyService; gains executeSell
src/cli/monitor.ts     entrypoint
```

## Configuration additions

| Var | Meaning | Default |
| --- | --- | --- |
| `POOL_CHECK_INTERVAL_SECONDS` | Poll period | `30` |
| `EXIT_CONFIRMATIONS` | Consecutive out-of-range reads before closing | `3` |
| `POSITION_LOOKBACK_BLOCKS` | How far back to scan for owned positions | `500000` |
| `CLOSE_SLIPPAGE_BPS` | Headroom under expected amounts for `amount0Min`/`amount1Min` | `100` |

## Flow

1. Discover positions: scan `Transfer` logs to the wallet in chunks over the lookback, then keep those where `ownerOf` is still the wallet, liquidity > 0, and the pool key matches config.
2. Every `POOL_CHECK_INTERVAL_SECONDS`, read `slot0` and compare the tick to each position's range.
3. In range → reset that position's breach counter.
4. Out of range → increment. On reaching `EXIT_CONFIRMATIONS`, close.
5. Close: compute expected amounts from liquidity at the current price, apply `CLOSE_SLIPPAGE_BPS` downward for the minimums, encode `BURN_POSITION` + `TAKE_PAIR`, **simulate**, then send.
6. Sell the resulting stock-token balance on Arcus back to USDG, reusing the existing quote → permit → sign → submit → poll path.
7. Continue polling remaining positions; exit when none are left.

## Safety properties

- Every transaction is simulated before broadcast; a revert aborts without sending.
- `amount0Min`/`amount1Min` bound what the burn may return, so a sandwiched close reverts rather than settling badly.
- Only positions matching the configured pool key are ever touched — unrelated position NFTs in the same wallet are invisible to the monitor.
- The debounce means a transient wick cannot trigger a close.
- `--dry-run` exercises discovery, polling, and the close decision while sending nothing.

## Testing

- Exit detection: in range, at each boundary, and beyond both, plus the boundary equality cases.
- Debounce: no close before the threshold; counter resets on a return to range; closes exactly at the threshold.
- Position filtering: ignores positions in other pools, zero-liquidity positions, and positions no longer owned.
- Close encoding: `BURN_POSITION` + `TAKE_PAIR` round-trip, recipient correct, minimums applied.
- Monitor: simulation failure aborts without sending; dry-run never sends.
- No test touches the live chain.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` green.
- `npm run monitor -- --dry-run` against mainnet, showing the live position and its in/out-of-range status.
- Live unattended run launched by the operator, never by the agent.
