# 0002 — Uniswap v4 LP deposit

Status: implemented — read path verified against mainnet, mint not yet run live

## Context

Step 1 ([0001](0001-arcus-spot-buy-cli.md)) is implemented and has executed live on mainnet: `npm run buy` buys a stock token on Arcus spot, `npm run quote` previews it read-only.

This plan covers **step 2 and 3** of the strategy: deposit the acquired stock token into the Uniswap v4 USDG/`<STOCK_TOKEN>` pool on Robinhood Chain, with a concentrated range of ±X% (default 3%) around the current price.

Step 4 — monitoring the pool and closing/rebalancing when it shifts fully to one side — is **not** in this plan.

## Verified on-chain facts

All confirmed by direct RPC reads against Robinhood Chain mainnet (4663), not from documentation alone.

Uniswap v4 deployment — every address below returns contract code:

| Contract | Address |
| --- | --- |
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

The target pool exists and is funded:

- `currency0` = USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals)
- `currency1` = NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` (18 decimals)
- fee `3000` (0.3%), tickSpacing `60`, hooks `0x0`
- observed tick `223440`, liquidity `817184618165972105`, implied ≈197.96 USDG/NVDA

Other initialized pools for the same pair: fee 500/ts 10 (liquidity present), fee 10000/ts 200 and fee 100/ts 1 (both empty). Currency ordering is by ascending address, so USDG is always `currency0` for this pair.

## Decisions

- **Sizing**: the wallet's full stock-token balance is the fixed side; the USDG required by the range is computed from it. Fails with a clear error if the wallet holds less USDG than required.
- **Range center**: the pool's own current tick, not the Arcus price. The strategy text said Arcus price, but centering on the pool's price makes the mint's token ratio match what the pool actually needs, minimizing leftover dust. The two prices currently differ by ~0.3%.
- **Invocation**: chained — `npm run buy` buys and then deposits. Because the deposit amounts cannot be known until the buy settles, the command confirms **twice**: once for the buy, once for the deposit with real numbers. `--yes` skips both.
- **Standalone deposit**: `npm run deposit` runs the deposit alone against whatever stock token the wallet already holds. Needed because a buy has already executed, and a buy-only path would strand that balance.

## Why hand-rolled math instead of `@uniswap/v4-sdk`

The v4 SDK depends on ethers v5, JSBI, and the v3 SDK. Adding it would put a second BigNumber ecosystem alongside viem in production for what is deterministic integer math.

Instead: implement TickMath and LiquidityAmounts with native `bigint`, and install `@uniswap/v3-sdk` as a **devDependency only**, used exclusively in tests to cross-check our implementation against the official one across a wide tick range. Official correctness guarantees, no production dependency conflict.

## Module layout

```
src/uniswap/
  deployments.ts       verified v4 addresses for chain 4663
  poolKey.ts           PoolKey type, currency ordering, poolId hashing
  tickMath.ts          getSqrtRatioAtTick, getTickAtSqrtRatio, alignToSpacing
  liquidityMath.ts     liquidity <-> amount conversions
  poolReader.ts        StateView slot0 + liquidity reads
  rangeCalculator.ts   current tick + deviation% -> aligned tickLower/tickUpper
  permit2.ts           ERC20->Permit2 approve, Permit2->PositionManager allowance
  positionManager.ts   MINT_POSITION + SETTLE_PAIR encoding, simulate, send
  depositService.ts    orchestration
src/cli/deposit.ts     standalone entrypoint
```

## Configuration additions

| Var | Meaning | Default |
| --- | --- | --- |
| `RANGE_DEVIATION_PERCENT` | Half-width of the LP range | `3` |
| `POOL_FEE` | v4 fee units (hundredths of a bip); 3000 = 0.3% | `3000` |
| `POOL_TICK_SPACING` | Must match the initialized pool | `60` |
| `LP_SLIPPAGE_BPS` | Bound on `amount0Max`/`amount1Max` at mint | `50` |
| `MINT_DEADLINE_SECONDS` | Transaction deadline | `300` |

`POOL_FEE` and `POOL_TICK_SPACING` are separate because v4 does not derive one from the other — both are part of the `PoolKey` and must match an initialized pool exactly.

## Deposit flow

1. Read the wallet's stock-token and USDG balances.
2. Read pool `slot0` via StateView; abort if `sqrtPriceX96` is 0 (pool not initialized).
3. Compute the range: `tickLower/tickUpper` = current tick ∓ the tick delta for the deviation percent, each aligned **outward** to a multiple of `tickSpacing`, so the realized range is never narrower than requested.
4. Compute liquidity from the stock balance (`currency1`), then the USDG (`currency0`) that liquidity requires. Abort with a clear error if the USDG balance is short.
5. Apply `LP_SLIPPAGE_BPS` to derive `amount0Max`/`amount1Max`.
6. Ensure approvals: ERC20 `approve(Permit2, max)` if allowance is short, then `Permit2.approve(token, PositionManager, amount, expiration)`.
7. Encode `MINT_POSITION` + `SETTLE_PAIR` and call `modifyLiquidities(abi.encode(actions, params), deadline)`.
8. **Simulate before sending.** A failed simulation aborts without broadcasting.
9. Wait for the receipt; report the minted tokenId.

### Action encoding

`MINT_POSITION` = `0x02`, `SETTLE_PAIR` = `0x0d`.

```
unlockData = abi.encode(
  bytes actions,        // packed: 0x020d
  bytes[] params
)
params[0] = abi.encode(PoolKey, int24 tickLower, int24 tickUpper,
                       uint256 liquidity, uint128 amount0Max, uint128 amount1Max,
                       address recipient, bytes hookData)
params[1] = abi.encode(Currency currency0, Currency currency1)
```

`PoolKey` is `(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)`.

## Safety properties

Carried over from 0001, plus:

- The deposit is confirmed separately from the buy, with the actual computed amounts shown.
- Every fund-moving transaction is **simulated first**; a revert aborts before broadcast.
- `amount0Max`/`amount1Max` bound the spend even if our liquidity math were wrong.
- Approvals are only sent when the existing allowance is insufficient, and are simulated like any other transaction.
- The pool's fee and tickSpacing must match config exactly; a mismatched `PoolKey` addresses a different (possibly uninitialized) pool and is rejected up front.

## Testing

- `tickMath` cross-checked against `@uniswap/v3-sdk` (devDependency) across a wide tick range, including the pool's live tick 223440 and the MIN/MAX bounds.
- `liquidityMath` round-trip: liquidity → amounts → liquidity, and known-vector checks.
- `rangeCalculator`: alignment outward, spacing multiples, symmetric deviation, rejects a zero/negative deviation.
- `depositService` with mocked chain clients: happy path; insufficient USDG; uninitialized pool; simulation revert aborts without sending; approval skipped when allowance suffices.
- No test touches the live chain.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` green.
- Read-only preview against mainnet showing the computed range, liquidity, and required amounts for the real wallet balance.
- Live run executed by the operator, never by the agent.

## Findings from implementation

- **Deployment addresses must be checksummed.** The documented addresses are lowercase; viem rejects a mis-checksummed address at call time. `deployments.test.ts` now asserts every stored address equals its own `getAddress` form, so this fails in CI rather than against the chain.
- **Arcus delivers the plain stock token**, not a wrapped one. Confirmed from the `SwapExecuted` logs of a live buy: `tokenOut` was `0xd0601CE1…D9EEC`, exactly the token the v4 pool uses. No wrap/unwrap step is needed. Both `wNVDA` and `wUSDG` balances were zero.
- **The wallet held no stock token when this was built**, because the earlier live buy (10 USDG → 0.0504 NVDA, block 23925409) was followed ~35 seconds later by a sell (0.0755 NVDA → 14.99 USDG, block 23925759). The deposit correctly refused with `InsufficientBalanceError`. The mint path therefore remains unproven against a live pool.
- The poll/range math was validated against the live pool: `poolId` `0x3bb34a44…` matches the on-chain pool, and observed ticks (223440, later 223446) round-trip through the tick math exactly.
