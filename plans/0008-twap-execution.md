# 0008 — TWAP execution for Arcus swaps

Status: in progress

## Context

Every Arcus trade today — the initial buy and the post-exit sell — executes as one quote-sign-submit-poll cycle for the full amount. The user asked to be able to split a trade into smaller chunks executed over time (time-weighted average price execution), to reduce the price impact of a single large order.

## Decisions (confirmed with the user)

1. **Scope**: both buys and sells go through the same chunking, since both go through `SpotSwapService`.
2. **Chunk sizing**: a fixed chunk *count* per symbol (`twapChunks`), not a max-chunk-size threshold. `twapChunks: 1` (the default) disables TWAP — the trade executes exactly as it does today, one quote for the full amount.
3. **Config scope**: `twapChunks` and `twapIntervalSeconds` are per-symbol overridable in `symbols.json`, falling back to `.env` defaults (`TWAP_CHUNKS`, `TWAP_INTERVAL_SECONDS`), the same pattern every other strategy field already uses.

## Design

### Chunking mechanics

Splitting happens *inside* `SpotSwapService`, not as a wrapper around it, because each chunk needs its own live quote (that's the entire point — one big quote walks the router's price once, N small quotes each get requoted). `executeBuy`/`executeSell` gain optional `twapChunks`/`twapIntervalSeconds` on their request (default 1 / 0 → unchanged behavior):

- Resolve tokens once, compute the total sell amount in atoms once (unchanged from today).
- Split the atoms across `twapChunks`: `floor(total / chunks)` for every chunk but the last, which takes the remainder — so the sum is always exactly the requested total, no dust lost to rounding.
- For each chunk, in sequence: `quoteAndValidate` (a fresh quote for just that chunk) → `settle` (permit, sign, submit, poll) — reusing the exact same private methods a single-shot trade already uses, so a chunk cannot diverge from the tested single-trade path. `settle`'s existing submission-failure reconciliation (added in the prior fix) applies per chunk unchanged.
- Sleep `twapIntervalSeconds` between chunks (not after the last one).
- A chunk's `tradeId` is `${tradeId}-N` so every log line and the router's own records can be traced to the exact chunk, while the parent `tradeId` still ties them together.

### Partial fills are surfaced, never hidden

If a chunk fails after some earlier chunks already settled, the trade is left partially filled — real money already moved for the completed chunks. This must never come back as a generic error that looks like nothing happened (the same lesson as the recent submission-reconciliation fix). A new `ArcusTwapPartialFillError` carries every completed chunk's result, the failed chunk's index, the total chunk count, and the underlying cause, so the caller can report exactly what filled and what didn't rather than treating it as a clean all-or-nothing failure.

A chunk amount that would round to zero atoms (`twapChunks` too high for the trade size) is rejected before anything is signed, via a new `ArcusTwapConfigError`.

### Result shape

`BuyResult.txHash: Hex` becomes `txHashes: readonly Hex[]` — one hash per chunk, a one-element array when TWAP is off. A single hash silently reporting only one of several chunk transactions would misrepresent what happened, so every caller that prints or stores it is updated rather than papering over the rename. `sellAmount`/`buyAmount`/`minBuyAmount` become true aggregates summed across chunks (for `buyAmount` specifically, this is *more* accurate than today's single pre-trade quote estimate, since it is now the sum of what each chunk's own quote actually promised). `orderId` is only meaningful for a single-chunk trade; it is `undefined` when `chunks > 1`.

`ExitResult.saleTxHash?: Hex` becomes `saleTxHashes?: readonly Hex[]` for the same reason.

## Module changes

```
src/config/
  env.schema.ts     TWAP_CHUNKS (default 1), TWAP_INTERVAL_SECONDS (default 10)
  config.ts         surfaces both as Config fields (fallback defaults)
  symbols.schema.ts twapChunks/twapIntervalSeconds optional per entry
  symbols.ts        SymbolConfig gains both, resolved same as every other field

src/arcus/
  errors.ts         ArcusTwapConfigError, ArcusTwapPartialFillError
  types.ts          BuyRequest/SellRequest gain twapChunks?/twapIntervalSeconds?;
                     BuyResult.txHash -> txHashes
  spotSwapService.ts  chunk-splitting loop in executeBuy/executeSell, reusing
                       the existing quoteAndValidate/settle primitives per chunk

src/uniswap/
  positionExitService.ts  options gain twapChunks/twapIntervalSeconds, threaded
                           into executeSell; ExitResult.saleTxHash -> saleTxHashes

src/di/container.ts   createExitService passes the symbol's twap fields into
                       PositionExitService

src/cli/
  buyCommand.ts    BuyRequestItem gains twap fields, threaded into executeBuy;
                    tx print updated for possibly-multiple hashes
  exitCommand.ts    tx print updated for possibly-multiple hashes
  buy.ts, cycle.ts  pass the resolved symbol's twap fields into BuyRequestItem
```

## What does NOT change

- `previewQuote` (used by `npm run quote`) stays a single quote for the full amount — it is a preflight of the *un-split* trade size, not a per-chunk simulation. TWAP's benefit is in execution, not in what gets previewed.
- The confirmation-gate commands (`buyCommand`, `depositCommand`, `exitCommand`) keep their existing plan-all/confirm-once/execute-each pattern; TWAP is an internal detail of how one item's execution happens; not a new batching layer.

## Commit sequence

Typecheck, lint, and the full test suite must pass before each commit.

1. `feat(config): add twapChunks/twapIntervalSeconds config and schema`
2. `feat(arcus): add TWAP chunk-splitting to SpotSwapService, with partial-fill error`
3. `feat(uniswap): thread TWAP config into PositionExitService, saleTxHashes`
4. `feat(cli): thread TWAP config through buy/exit commands and entrypoints`
5. `docs: document TWAP in README and architecture`

## Verification

- Full test suite, typecheck, and lint green after each commit.
- New tests: chunk splitting arithmetic (remainder goes to the last chunk), a full multi-chunk happy path (asserting N quotes, N submissions, the inter-chunk sleep, and aggregated amounts), a partial-fill failure (chunk 2 of 3 fails; asserts the error carries exactly the one completed chunk and that chunk 3 was never attempted), and the zero-amount-chunk config error.
- Read-only verification only: `npm run quote`/`npm run position` are unaffected by this change and can be re-checked against mainnet, but a live chunked buy/sell must be run by the operator — never executed by the assistant, per existing project convention.
