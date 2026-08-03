# 0009 — Price impact gate on buys

Status: in progress

## Context

The user asked to calculate price impact when buying and refuse to execute a buy whose price impact exceeds a configured threshold.

## Decisions (confirmed with the user)

1. **Reference price**: a small reference quote requested from Arcus itself alongside the real one (not the Uniswap pool's spot price). Self-contained — no coupling from the buy path to Uniswap pool state, and correct even if Arcus routes the small and large sizes through different venues.
2. **Check granularity**: before every individual trade attempt — which, since TWAP (plan 0008) already splits a buy into chunks, means before every chunk's quote is acted on, not just once for the whole trade. This catches the market moving mid-sequence, not just a bad starting quote.
3. **On breach**: skip that symbol (report why) and continue with the rest of the batch — the same per-item resilience pattern already used for buy/deposit/exit.
4. **Scope**: buys only (`executeBuy`), not the post-exit sell (`executeSell`) — matching the user's literal request. `SellRequest`/`PositionExitService` are untouched.

## Design

### Reference quote and impact formula

For a trade of `sellAmountAtoms`, request a second quote for `sellAmountAtoms / 100` (1%, floored at 1 atom) — small enough to approximate the un-impacted price, proportional so it scales sensibly across chunk sizes and stock tokens of very different prices/decimals. Compute both quotes' effective price (`sellAmount / sellDecimals` divided by `buyAmount / buyDecimals`, i.e. USDG per stock token) and the impact as:

```
impactBps = (tradePrice - referencePrice) / referencePrice * 10_000
```

Positive means the trade pays more per stock token than the reference — the expected direction for a buy walking the price up. If `impactBps > maxPriceImpactBps`, the chunk is rejected before it is signed.

### Where it lives

Inside `SpotSwapService.executeSingle` (the same helper the chunk loop already calls once per chunk, and the direct path calls once when `twapChunks <= 1`), gated by a new optional `maxPriceImpactBps` parameter threaded only from `executeBuy`/`BuyRequest`. This means:

- The check runs on every execution attempt regardless of whether TWAP is enabled — `twapChunks: 1` is not a special case.
- A breach on a chunk after earlier chunks already filled falls straight into the *existing* `executeWithTwap` catch block, which already wraps any chunk failure into `ArcusTwapPartialFillError` carrying what filled — no new partial-fill handling needed, this reuses the plan-0008 safety net as-is.
- A breach on the only/first chunk (nothing filled yet) propagates as a plain `ArcusPriceImpactError` — matching how e.g. `ArcusSubmissionError` already propagates unwrapped at `twapChunks <= 1`.
- `executeSell` never passes `maxPriceImpactBps`, so the check never runs for sells — no behavior change there.

### Config

`maxPriceImpactBps`, per-symbol overridable in `symbols.json`, falling back to `.env`'s `MAX_PRICE_IMPACT_BPS` (default 100 bps = 1%) — same pattern as every other strategy field.

## Module changes

```
src/config/
  env.schema.ts      MAX_PRICE_IMPACT_BPS, default 100
  config.ts           surfaces it as a Config field
  symbols.schema.ts   maxPriceImpactBps optional per entry
  symbols.ts          SymbolConfig gains it, resolved the same way as every other field

src/arcus/
  errors.ts    ArcusPriceImpactError (tradeId, priceImpactBps, maxPriceImpactBps)
  types.ts     BuyRequest gains maxPriceImpactBps?: number (SellRequest untouched)
  spotSwapService.ts   executeSingle takes maxPriceImpactBps, fetches the reference
                        quote and checks impact before settle() when set

src/cli/
  buyCommand.ts    BuyRequestItem gains maxPriceImpactBps, threaded into executeBuy;
                    summary shows the configured threshold per symbol
  buy.ts, cycle.ts  pass the resolved symbol's maxPriceImpactBps into BuyRequestItem
```

## What does NOT change

- `PositionExitService`/`executeSell`/`SellRequest` — the check is buy-only per the user's request.
- `previewQuote` — a preflight of the requested size, not a simulation of the impact check (consistent with previewQuote also not simulating TWAP chunking).
- The deposit/exit/monitor code paths.

## Commit sequence

Typecheck, lint, and the full test suite must pass before each commit.

1. `feat(config): add maxPriceImpactBps config and schema`
2. `feat(arcus): gate buys on price impact, checked per TWAP chunk`
3. `feat(cli): thread price impact threshold through buy command and entrypoints`
4. `docs: document the price impact gate in README and architecture`

## Verification

- New tests: impact computed and compared correctly (within/over threshold), the check runs per chunk (breach on chunk 2 of 3 produces `ArcusTwapPartialFillError` with exactly 1 completed chunk), a breach on an un-chunked trade propagates as a plain `ArcusPriceImpactError`, `executeSell` is never affected.
- Read-only verification only (`npm run quote`), since a live buy is the operator's call per existing project convention.
