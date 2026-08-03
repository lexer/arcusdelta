# 0010 — Robinhood price feed as the price impact reference

Status: in progress

## Context

Plan 0009 gated buys on price impact, measured against a small reference quote requested from Arcus itself (1% of the trade size). The user asked to replace that reference with Robinhood's own price feed (`https://api.robinhood.com/rhj/prices/`), which reports true exchange bid/ask for every Robinhood-tokenized asset, looked up by on-chain contract address — a real independent reference instead of a same-venue proxy.

### The endpoint, as verified live

`GET https://api.robinhood.com/rhj/prices/` — no auth, no query params needed, returns every listed asset in one response:

```json
{
  "quotes": [
    {
      "tokenSymbol": "NVDA",
      "deployments": [{"contractAddress": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "chainId": 4663}],
      "bid": "206.66", "ask": "206.74", "currency": "USD",
      "isTradingHalt": false, "generatedAt": "...", "dailyHigh": "...", "dailyLow": "..."
    }
  ]
}
```

Confirmed live for NVDA, AAPL, GME, and USAR — all four symbols in the operator's `symbols.json` are listed. Lookup is by `deployments[].contractAddress` (case-insensitive) + `chainId`, not a request parameter — the only two query-param names it revealed on a bad guess belong to a stricter internal schema that a plain fetch-all-and-filter avoids depending on.

## Design

### Where it lives

A new top-level module, `src/prices/`, parallel to `arcus/`, `uniswap/`, `pnl/` — this is a generic on-chain-asset price oracle, not an Arcus concept:

- `priceFeed.ts`: the `PriceFeed` interface (`getPrice(chainId, tokenAddress): Promise<TokenPrice>`) and `PriceNotFoundError`.
- `robinhoodPriceFeed.ts`: `createRobinhoodPriceFeed(fetchImpl = fetch): PriceFeed` — fetches the full quote list, finds the matching deployment, returns `{bid, ask, isTradingHalt}` as numbers.

### What replaces what in `SpotSwapService`

`checkPriceImpact` no longer requests a synthetic reference quote from Arcus (`referenceSellAmount`/the second `fetchQuote` call are removed entirely). Instead it calls `priceFeed.getPrice(chainId, buyToken.address)` and compares the Arcus quote's effective price to the feed's **ask** (the side a buyer actually crosses, so a two-sided bid/ask spread with zero size-impact reads as zero, not half-a-spread of "impact"). USDG is treated 1:1 with USD, matching every other place in the codebase that already does this. A lookup failure, a fetch failure, or `isTradingHalt: true` all refuse the buy via a new `ArcusPriceFeedError` — "cannot verify" fails closed, the same posture as everywhere else in this gate.

The check still runs once per execution attempt (the un-chunked path and every TWAP chunk), unchanged from plan 0009 — this pivot only changes the reference source, not when it's checked.

### What does NOT change

- Config (`maxPriceImpactBps`, per-symbol/`.env` default) — untouched.
- Buy-only scope, `ArcusTwapPartialFillError` wrapping on a mid-sequence breach — untouched, since the check still throws from the same place.

## Module changes

```
src/prices/
  priceFeed.ts            PriceFeed interface, TokenPrice, PriceNotFoundError
  robinhoodPriceFeed.ts    createRobinhoodPriceFeed(fetchImpl?): PriceFeed

src/arcus/
  errors.ts            ArcusPriceFeedError
  spotSwapService.ts   SpotSwapServiceOptions gains priceFeed: PriceFeed;
                        checkPriceImpact rewritten around it; referenceSellAmount
                        removed (dead once the synthetic reference quote is gone)

src/di/container.ts    constructs createRobinhoodPriceFeed(), passes into SpotSwapService
```

## Commit sequence

Typecheck, lint, and the full test suite must pass before each commit.

1. `feat(prices): add Robinhood price feed client`
2. `feat(arcus): use the Robinhood price feed as the price impact reference`
3. `docs: document the Robinhood price feed in README and architecture`

## Verification

- New tests: `robinhoodPriceFeed.test.ts` (finds by address case-insensitively, filters by chainId, throws `PriceNotFoundError` when absent, propagates a non-ok response as an error). `spotSwapService.test.ts`'s price-impact tests rewritten around a mocked `PriceFeed` instead of a second Arcus quote; add a trading-halt case and a lookup-failure case.
- Live read-only check: fetch the real endpoint for the operator's actual `symbols.json` addresses (NVDA, AAPL, GME, USAR) and confirm all four resolve, matching what was already verified in this plan's Context section.
