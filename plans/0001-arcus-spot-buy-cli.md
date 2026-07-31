# 0001 — Arcus spot buy CLI

Status: in progress

## Context

`arcusamm` is an automated market-making bot for tokenized stocks. The full strategy is:

1. Buy a stock token (starting with NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`) on Arcus spot, manually triggered.
2. Deposit into a Uniswap v4 USDG/`<STOCK_TOKEN>` pool on Robinhood Chain.
3. Set a concentrated range at ±X% (start: 3%) around the current Arcus price.
4. Poll the pool every N seconds (start: 30s); when it shifts fully to one side, close the position, claim fees, and sell the accumulated token back on Arcus.

**This plan covers step 1 only.** It is a deliberately narrow vertical slice that proves out the riskiest integration — production wallet, real funds, live router — before any LP logic exists, and establishes the foundation (config, wallet/chain, logging, Arcus wrapper, composition root) that steps 2–4 build on.

Configuration knobs for later steps (deviation %, v4 fee tier, poll frequency) are intentionally **not** added yet.

## Decisions

- **DI**: manual constructor injection via `src/di/container.ts`. See the Dependency injection section of `CLAUDE.md`.
- **Scope**: buy only. No Uniswap/LP/monitoring code.
- **Safety**: no dry-run mode. The CLI always executes for real, but prints wallet address, token, amount, and slippage, and requires the operator to type `yes` before anything is signed.

## Arcus SDK reference (verified against `@arcus-xyz/arcus-spot-sdk@1.0.2` type definitions)

```ts
new SpotRouterClient({baseUrl})       // https://router.spot.arcus.xyz/v1
client.getQuote({chainId, sellToken, buyToken, sellAmount, taker, slippageBps})
  // -> QuoteResponse {recommended, all: FirmQuote[], errors?}
client.submitSignedQuote(signed)      // -> ArcusSubmitResponse {venue, txHash, status:'submitted', orderId?}
client.getStatus({venue, id, chainId})// -> StatusResponse {venue, status, txHash?, raw}
client.getTokenList()                 // -> TokenInfo[] {chainId, address, symbol, decimals, category, ...}
buildArcusSellTokenPermitIfNeeded({quote, publicClient, walletClient}) // -> Permit | undefined
signQuote(quote, walletClient, {permits})  // -> SignedQuote
```

Key details:

- `sellAmount` is a **string in atomic units**; USDG decimals come from `getTokenList()`.
- `slippageBps` is **basis points** — 0.01% is `1`.
- We use the **`arcus` venue** specifically: `ArcusFirmQuote` carries `arcus.minAmountOut`, and `buildArcusSellTokenPermitIfNeeded` is arcus-specific.
- `NormalizedStatus` is `'pending' | 'submitted' | 'confirmed' | 'failed' | 'unknown'`. Terminal states are `confirmed` and `failed`.
- `PermitUnsupportedError` (exposing `token`, `spender`, `sellAmount`, `currentAllowance`) means the sell token has no EIP-2612 `permit()` and needs a one-time on-chain `approve` to Permit2 instead.
- Slippage protection is enforced by the router via `minAmountOut` derived from `slippageBps`; we do not re-derive it. Instead we validate the returned quote before signing (see below).

## Module layout

```
src/
  config/env.schema.ts     zod schema over process.env
  config/config.ts          dotenv + validate + freeze -> typed Config
  logging/logger.ts         pino factory, secret redaction, per-trade child logger
  chain/robinhoodChain.ts   viem Chain for id 4663
  chain/walletProvider.ts   mnemonicToAccount(SEED) -> WalletClient + PublicClient
  arcus/types.ts            BuyRequest / BuyResult
  arcus/errors.ts           typed errors carrying structured context
  arcus/tokenResolver.ts    getTokenList() -> address + decimals by symbol, cached
  arcus/spotBuyService.ts   quote -> validate -> permit -> sign -> submit -> poll
  di/container.ts           composition root
  cli/buy.ts                arg parsing, confirmation gate, invoke, report
```

## Configuration

| Var | Validation | `.env.example` default |
| --- | --- | --- |
| `SEED` | non-empty string, required, never logged | commented placeholder + warning |
| `RPC_URL` | url | `https://rpc.mainnet.chain.robinhood.com` |
| `CHAIN_ID` | coerced int | `4663` |
| `ARCUS_ROUTER_URL` | url | `https://router.spot.arcus.xyz/v1` |
| `STOCK_TOKEN_ADDRESS` | 0x address | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` (NVDA) |
| `USDG_BUY_AMOUNT` | positive decimal string | `100` |
| `SLIPPAGE_BPS` | int 0..10000 | `1` (= 0.01%) |

`USDG_BUY_AMOUNT` stays a human decimal and is converted to atomic units with viem's `parseUnits` using decimals from `getTokenList()` — never float math. USDG's address is resolved from the token list by symbol rather than hard-coded, which also validates that the configured stock token is routable before any funds move.

## Buy flow

`ArcusBuyService.executeBuy(request)`:

1. Resolve USDG and the stock token (address, decimals) from the cached token list; convert the configured USDG amount to atoms.
2. `getQuote(...)`, then select the `arcus` venue quote from `quotes.all`. None available → `ArcusQuoteError` (including any per-venue `errors[]` context).
3. **Validate before signing** → `QuoteValidationError` if: the quote's `sellAmount` differs from what we requested (we never spend more than intended), `arcus.minAmountOut` is not positive, or `expiry` is already in the past.
4. `buildArcusSellTokenPermitIfNeeded(...)`. `PermitUnsupportedError` is wrapped in `ArcusPermitError` explaining the required one-time on-chain approve — we deliberately do **not** auto-send the approve tx in this feature, since it spends gas without operator confirmation.
5. `signQuote(quote, walletClient, {permits})`.
6. `submitSignedQuote(signed)` → `{txHash, orderId}`. Failure → `ArcusSubmissionError`.
7. Poll `getStatus({venue:'arcus', id: orderId ?? txHash, chainId})` on a bounded loop (2s interval, 60s budget). `confirmed` → `BuyResult`; `failed` → `ArcusExecutionFailedError`; budget exhausted → `ArcusPollTimeoutError` (the trade may still land — the message says so and reports the txHash).

Only the read-only poll retries. Nothing in the quote → permit → sign → submit chain is retried automatically.

## CLI

`npm run buy`, `commander` command with `--yes` to skip the prompt (for later automation; not the default). Prints a confirmation block naming the wallet address, spend amount, token, chain, and slippage, then requires the operator to type `yes`. Anything else aborts with exit 1 and nothing signed.

## Logging

pino, with a `tradeId` child logger on every line. Points: CLI start; config loaded (non-secret only); wallet derived (address only); token list resolved; quote entry/result (venue, buyAmount, minAmountOut, expiry); permit needed/built; sign entry/exit; submit entry/exit (txHash, orderId); each poll attempt at debug (attempt, elapsedMs, status); terminal state; every error path with its structured context; CLI exit (outcome, elapsedMs). `redact` is configured for `SEED` and private-key paths as a second guard on top of never logging them.

## Testing

`SpotRouterClient` is mocked throughout; no test touches the live router or chain.

- Config: defaults apply; missing `SEED` throws; malformed address throws.
- Wallet: a known **test** mnemonic derives a fixed expected address.
- Token resolver: symbol → address/decimals; unknown symbol throws; list fetched once.
- Buy service: happy path; no arcus quote; quote validation failures (sellAmount mismatch, expired) assert **sign and submit were never called**; permit unsupported → `ArcusPermitError` with nothing signed; submission failure; `failed` status; poll timeout terminates rather than looping forever.
- CLI: the confirmation gate blocks execution unless the operator types `yes` — asserts `executeBuy` was never called. This is the most important test in the feature.

## Open items

- Robinhood Chain native currency symbol/decimals and explorer URL are unverified; current values are best-effort and affect only fee display, not the ERC-20 swap.
- USDG must appear in the router's token list under symbol `USDG`. Verify with a read-only `getTokenList()` call against mainnet before the first live run.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test` all green.
- Read-only smoke against the live mainnet router: `getTokenList()` resolves USDG and NVDA, and `getQuote()` for 100 USDG returns a sane arcus quote. No signing.
- First live run: use a reduced `USDG_BUY_AMOUNT` (e.g. 5 USDG) to limit exposure, confirm the printed details, then verify the txHash on-chain and the NVDA balance increase.
