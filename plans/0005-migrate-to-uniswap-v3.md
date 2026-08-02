# 0005 — Migrate from Uniswap v4 to v3

Status: in progress

## Context

Steps 1–4 run against Uniswap v4 on Robinhood Chain. The user closed the open v4 AAPL position and asked to rewrite the AMM integration to use v3 pools instead — a full replacement, not a dual-mode toggle. This plan covers `src/uniswap/` and everything downstream of it (deposit, monitor, exit, PnL, CLI, config).

## Verified on-chain facts

Every address below returns contract code; the doc addresses were correctly checksummed this time (v4's were not).

| Contract | Address |
| --- | --- |
| UniswapV3Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| TickLens | `0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468` |

`factory.feeAmountTickSpacing(fee)`: 100→1, 500→10, 3000→60, 10000→200 — confirmed by direct read, not assumed.

Live pools exist and are liquid for both pairs currently in use:
- USDG/NVDA fee 3000: pool `0xB944cec3...F7E2B`, tick 223347, liquidity `1638404869487262501`
- USDG/AAPL fee 3000: pool `0x783C9bbB...4b7Ed`, tick 218994, liquidity `181942931595074286`

Both ticks bracket the ranges the closed v4 positions used, confirming the underlying market price is the same — only the pool contract differs.

## Why v3 is a meaningful simplification for this codebase

- **Position discovery no longer needs log scanning.** `NonfungiblePositionManager` implements `IERC721Enumerable` (confirmed from `v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol`), so owned positions come from `balanceOf` + `tokenOfOwnerByIndex` — a direct read with no block-range window. This eliminates the exact bug class that just caused `exit`/`monitor` to miss a real position: v4's discovery depended on `POSITION_LOOKBACK_BLOCKS`, and a position older than that window went invisible.
- **No Permit2.** v3's `mint()` pulls funds via a plain `transferFrom`, so a direct `ERC20.approve(NFPM, amount)` is sufficient. `permit2.ts` is deleted rather than ported.
- **No PositionInfo bit-packing.** `positions(tokenId)` returns `tickLower`, `tickUpper`, `liquidity`, and both `feeGrowthInsideLastX128` values directly, typed. v4 needed a hand-decoded packed `uint256`.
- **No hooks, no PoolKey with a hooks slot, no poolId hash.** A pool is identified by `(token0, token1, fee)` and looked up as a concrete address via `factory.getPool(...)`. tickSpacing is *derived* from fee, not user-supplied — removing `POOL_TICK_SPACING` from config removes the exact class of mismatch that broke `npm run position` earlier in this project (a spacing that didn't match any initialized pool).

## What v3 requires that v4 didn't

- **Fee growth has no single-call lens.** v4's `StateView.getFeeGrowthInside` doesn't exist in v3. It must be computed from three reads — `pool.feeGrowthGlobal0X128()`, `pool.feeGrowthGlobal1X128()`, `pool.ticks(tickLower)`, `pool.ticks(tickUpper)`, `pool.slot0().tick` — using the same inside/outside formula v4's lens applies internally. The existing pure `accruedFees` function in `pnlCalculator.ts` is unaffected; only what feeds it changes.
- **Pool address is always resolved live via `factory.getPool()`**, never computed offline via CREATE2 + init-code-hash. Robinhood Chain's init code hash for this deployment is not something to assume; a live factory call cannot be wrong in the way a hardcoded hash could.

## Decisions

- **Full replacement, not a v3/v4 switch.** No abstraction layer over "the AMM" — that would be speculative generality for a single-operator bot with one deployment target. v4 modules are deleted.
- **`POOL_FEE` stays in config** (default `3000`, matches the pools already in use). **`POOL_TICK_SPACING` is removed** — it's derived from the fee via the factory, so keeping it as a separate setting only recreates the mismatch risk that already caused one failure.
- **`POSITION_LOOKBACK_BLOCKS` is removed entirely.** It only ever drove position discovery (in `monitor`/`exit` and in `PnlReporter`'s position listing); the Arcus trade-log scan in `PnlReporter` uses its own `--from-block` CLI flag and internal chunk size, and never read this setting. Enumeration replaces the lookback for finding owned positions everywhere it was used.
- **Close flow**: `multicall([decreaseLiquidity(all liquidity, min0, min1), collect(max0, max1)])`, mirroring v4's two-action burn+take — still one transaction, still simulated before broadcast.

## Module changes

```
src/uniswap/
  deployments.ts       v3 addresses; drop stateView/universalRouter/permit2
  poolKey.ts     ->     poolAddress.ts: (token0, token1, fee) + live factory.getPool lookup
  poolReader.ts         reads Pool.slot0() + Pool.liquidity() directly, no poolId
  positionManager.ts    replaced: plain NFPM.mint(MintParams), no action encoding
  positionCloser.ts     multicall([decreaseLiquidity, collect]), no action encoding
  positionReader.ts     balanceOf + tokenOfOwnerByIndex + positions(), no log scan, no bit-unpack
  feeReader.ts          computes feeGrowthInside from pool.feeGrowthGlobal + ticks(lower/upper)
  permit2.ts            deleted; replaced by a plain ERC20 approveIfNeeded helper
  depositService.ts     adapts to the new pool/mint interfaces
  positionExitService.ts  adapts to the new closer/feeReader interfaces
  positionMonitor.ts    adapts to the new pool key shape
  tickMath.ts, liquidityMath.ts, rangeCalculator.ts   unchanged — pure math, version-agnostic
```

`di/container.ts`, every `src/cli/*.ts` entrypoint, and `pnl/pnlReporter.ts` are updated to the new shapes. `pnlReporter`'s deposit-detection (reading the mint tx's USDG `Transfer` log with `from = owner`) is unaffected by v3 routing tokens through the pool instead of through the position manager, since it never filtered on `to`.

## Testing

- `poolAddress`/pool-key tests reproduce the two live pool addresses above via `factory.getPool` semantics.
- Fee-growth-inside math cross-checked the same way v4's was: against values read from the live pools, and against `@uniswap/v3-sdk` (already a devDependency) where applicable.
- Mint/close encoding tests replaced with plain call-shape tests, since there is no more custom action encoding to round-trip.
- Discovery tests updated to enumerate via index rather than filter log candidates.
- No test touches the live chain.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` green.
- `npm run position` / `npm run pnl` run read-only against mainnet against the live NVDA and AAPL pools.
- Live mint/close executed by the operator, never by the agent.
