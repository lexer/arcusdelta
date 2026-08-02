# 0007 — Multi-symbol configuration

Status: in progress

## Context

The bot currently manages exactly one stock token, configured via a single `STOCK_TOKEN_ADDRESS` in `.env`. The user asked to rework this so the bot can run a portfolio of symbols — buy, deposit, monitor, and exit each independently — configured as a list rather than one hardcoded value.

## Decisions (confirmed with the user)

1. **Config format**: a separate JSON file, `symbols.json` at the repo root (sibling to `.env`, not nested under `src/config/` to avoid confusion with the module of the same name). Gitignored like `.env`; a committed `symbols.example.json` serves as the template, mirroring the existing `.env`/`.env.example` pattern.
2. **Scope of per-symbol overrides**: every strategy parameter is independently overridable per symbol (buy amount, pool fee, range deviation, slippage, poll interval, exit confirmations, mint deadline, close slippage). Fields omitted in an entry fall back to the corresponding `.env` value, which becomes the *default*, not the only option.
3. **One-shot commands** (`buy`, `quote`, `deposit`, `position`, `exit`, `cycle`) act on **all configured symbols by default**, narrowed to one via `--symbol <TICKER>`. Fund-moving commands batch: build every symbol's plan first (read-only), print one combined summary, take one confirmation, then execute each in sequence — extending the pattern `exitCommand.ts` already uses for multiple positions in one pool to multiple symbols across pools.
4. **`monitor` watches every configured symbol in one process.** Its core loop is restructured from "one pool, N positions" to "N pools, each with its own positions." No per-symbol scheduler: the loop ticks at the cadence of the *fastest* configured `poolCheckIntervalSeconds` and checks every symbol's pool on every tick — a symbol configured with a slower interval is simply checked more often than it asked for, which is harmless (extra RPC reads, not extra risk). Each position keeps its own `exitConfirmations` threshold regardless of tick cadence, since the breach counter is already keyed per tokenId.

## What does NOT change

- `SpotSwapService`, `DepositService`, `PositionExitService`, `PoolReader`, `PositionReader`, `FeeReader`, tick/liquidity math — all already take a resolved pool/token pair as a parameter, not a global. They are already symbol-agnostic; only the *callers* currently source that parameter from one global `Config` field.
- `RPC_URL`, `CHAIN_ID`, `ARCUS_ROUTER_URL`, `SEED` stay global in `.env` — wallet and chain identity, not a strategy parameter.

## Config schema changes

`.env`:
- `STOCK_TOKEN_ADDRESS` is **removed**. A single global address made sense for one symbol; it does not for a list, and each `symbols.json` entry supplies its own, required.
- `USDG_BUY_AMOUNT` becomes **optional** (previously required with no default). It still serves as the fallback when a symbol entry omits its own `usdgBuyAmount`; if neither is set for a given symbol, that is a config error naming the symbol.
- Every other existing field (`SLIPPAGE_BPS`, `RANGE_DEVIATION_PERCENT`, `POOL_FEE`, `LP_SLIPPAGE_BPS`, `MINT_DEADLINE_SECONDS`, `POOL_CHECK_INTERVAL_SECONDS`, `EXIT_CONFIRMATIONS`, `CLOSE_SLIPPAGE_BPS`) keeps its existing default, now serving as the fallback for symbols that don't override it.

`symbols.json` — array of:

```jsonc
{
  "symbol": "NVDA",                 // required, unique, matched by --symbol
  "stockTokenAddress": "0xd060...", // required
  "usdgBuyAmount": "100",           // optional, falls back to USDG_BUY_AMOUNT
  "poolFee": 3000,                  // optional, falls back to POOL_FEE
  "rangeDeviationPercent": 3,       // optional, falls back to RANGE_DEVIATION_PERCENT
  "slippageBps": 1,
  "lpSlippageBps": 50,
  "mintDeadlineSeconds": 300,
  "poolCheckIntervalSeconds": 30,
  "exitConfirmations": 3,
  "closeSlippageBps": 100
}
```

Validated with the same Zod rules as the equivalent `.env` fields. A symbol entry is merged shallowly against the `.env` defaults; the result is a fully-resolved `SymbolConfig` with every field required.

## Module changes

```
src/config/
  symbols.schema.ts   Zod schema for one symbols.json entry (all fields but
                       symbol/stockTokenAddress optional) and the array
  symbols.ts          loadSymbols(path, defaults): SymbolConfig[] — parse,
                       validate, merge with defaults, enforce unique symbol
                       names, error naming the symbol if usdgBuyAmount
                       resolves to nothing
  config.ts           drops stockTokenAddress; usdgBuyAmount becomes optional

src/di/container.ts   createDepositService/createExitService/createPnlReporter
                       take a SymbolConfig instead of reading the global
                       Config; createMonitor takes the full resolved symbol
                       list and builds one PositionMonitor watching all of them

src/uniswap/positionMonitor.ts
  - PositionMonitorOptions.pool -> watchedSymbols: WatchedSymbol[], each
    {symbol, pool, exitService, checkIntervalSeconds, exitConfirmations}
  - BreachCounter.record(tokenId, status, threshold) takes the threshold
    per call instead of fixing it at construction, since different
    positions can now require different EXIT_CONFIRMATIONS
  - the poll loop reads every distinct watched pool once per tick, then
    classifies each position against its own pool's tick and its own
    threshold

src/cli/buyCommand.ts, depositCommand.ts, exitCommand.ts
  - move from a single plan/request to a list, with one combined summary
    and one confirmation covering the whole batch (depositCommand.ts and
    buyCommand.ts adopt the shape exitCommand.ts already has)

src/cli/*.ts entrypoints
  - add --symbol <TICKER> to buy, quote, deposit, position, exit, cycle,
    and monitor (monitor's is an optional narrow-to-one, not required)
  - load symbols.json, resolve the selected subset, drive the batched
    command logic
```

## Testing

- `symbols.ts`: parses a valid file, merges partial overrides against defaults, rejects duplicate symbol names, rejects a symbol missing `usdgBuyAmount` with no global fallback, rejects a malformed entry with a per-field Zod error.
- `BreachCounter`: per-call threshold, independent per tokenId, unaffected by unrelated positions' thresholds.
- `PositionMonitor`: watches positions across two different pools in one run; a position in pool A triggers independently of pool B's tick; polls at the faster of two configured intervals.
- `buyCommand.ts`/`depositCommand.ts`: batch summary lists every symbol; one decline aborts the whole batch; one confirm executes every symbol in sequence; a failure partway through does not silently swallow the remaining symbols' outcomes.
- No test touches the live chain.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` green.
- `npm run quote` / `npm run position` / `npm run pnl` run read-only against mainnet with a real multi-entry `symbols.json` (NVDA + AAPL, both pools already confirmed live).
- Live buy/deposit/exit/monitor/cycle executed by the operator, never by the agent.
