# arcusamm

Automated market-making bot for tokenized stocks on Arcus spot and Robinhood Chain.

> **This tool spends real money from a production wallet.** The buy command executes against mainnet. There is no dry-run mode — the only guard is the confirmation prompt.

## Status

The full strategy is implemented across a portfolio of symbols: buy a stock token on Arcus, open a Uniswap v3 position with a ±X% range, then watch the pool and exit when it goes one-sided — closing the position, collecting fees, and selling the stock token back to USDG. See [docs/architecture.md](docs/architecture.md).

## Setup

```sh
npm install
cp .env.example .env
cp symbols.example.json symbols.json
```

Fill in `.env`. `SEED` is the production wallet mnemonic and has no default; everything else defaults to Robinhood Chain mainnet and the hosted Arcus router, and doubles as the **fallback** every `symbols.json` entry falls back to when it doesn't override that field itself. `.env` and `symbols.json` are both gitignored — never commit either.

| Variable | Default |
| --- | --- |
| `SEED` | *(required)* |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` |
| `CHAIN_ID` | `4663` |
| `ARCUS_ROUTER_URL` | `https://router.spot.arcus.xyz/v1` |
| `USDG_BUY_AMOUNT` | *(none — fallback only; a symbol with no amount from either source is a config error)* |
| `SLIPPAGE_BPS` | `1` (0.01%) |
| `RANGE_DEVIATION_PERCENT` | `3` |
| `POOL_FEE` | `3000` (0.3%) |
| `LP_SLIPPAGE_BPS` | `50` |
| `MINT_DEADLINE_SECONDS` | `300` |
| `POOL_CHECK_INTERVAL_SECONDS` | `30` |
| `EXIT_CONFIRMATIONS` | `3` |
| `CLOSE_SLIPPAGE_BPS` | `100` |

Fill in `symbols.json` — the list of stock tokens the bot trades. Each entry needs at minimum a `symbol` and `stockTokenAddress`; every other field is optional and falls back to the corresponding `.env` default above when omitted:

```jsonc
[
  {"symbol": "NVDA", "stockTokenAddress": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"},
  {"symbol": "AAPL", "stockTokenAddress": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", "usdgBuyAmount": "100"}
]
```

`poolFee` must match a pool the factory has actually created for the pair — tickSpacing is derived from it live via `factory.feeAmountTickSpacing()`, not configured.

## Selecting symbols

Every command below defaults to acting on **every symbol in `symbols.json`**. Pass `--symbol <TICKER>` to narrow to one:

```sh
npm run buy -- --symbol NVDA
```

Fund-moving commands (`buy`, `deposit`, `exit`) batch across whatever symbols are selected: every symbol is planned first (read-only), one combined summary is printed, one confirmation covers the whole batch, then each symbol executes independently — a failure on one symbol does not stop or lose track of the others.

## Read-only previews

```sh
npm run quote                # what each Arcus buy would cost
npm run position             # what liquidity position each symbol would open
npm run monitor -- --dry-run # which positions are watched, and their status
npm run pnl                  # profit and loss per symbol, including fees earned
npm run exit -- --dry-run    # what withdrawing right now would return
```

None of these sign, approve, or mint. They run the same code paths the spending commands do, then stop — so they are always safe, and they show the real numbers.

## Buying and depositing

```sh
npm run buy
```

Buys every selected symbol on Arcus, then opens each liquidity position. The two steps are confirmed **separately**, because deposit amounts cannot be known until the buys settle. Each prompt prints the real figures for every symbol and waits for you to type `yes`; anything else aborts the whole batch.

- `--symbol <ticker>` narrows to one symbol.
- `--no-deposit` stops after the buys.
- `--yes` skips both prompts. Only for intentional unattended runs.

```sh
npm run deposit
```

Opens a position for each selected symbol from the stock-token balance the wallet already holds, without buying. Use this when a balance was acquired earlier.

Each position uses the wallet's **entire** balance of that symbol's stock token as the fixed side and derives the USDG needed for the range; it fails clearly if USDG is short for that symbol. Start with a small `usdgBuyAmount` on your first live run.

## Running the full cycle

```sh
npm run cycle
```

Buys, deposits, and then stays running to watch every opened position until it exits — one command instead of running `buy` and `monitor` separately, across every selected symbol. It's orchestration only: the same `runBuyCommand`, `runDepositCommand`, and `PositionMonitor` the individual commands use, just chained.

Buy and deposit confirm exactly as `npm run buy` does; once deposited, it watches exactly the symbols that opened a position and runs unattended from there, exactly as `npm run monitor` does — no further prompts.

- `--symbol <ticker>` narrows to one symbol.
- `--yes` skips both confirmations, for a fully hands-off run.
- `--max-polls <n>` stops monitoring after a fixed number of checks (mainly for testing).

This runs **one cycle** — it stops once each position closes rather than buying back in. Re-entering afterward is a manual step (`npm run cycle` again, or `npm run buy`).

## Monitoring

```sh
npm run monitor
```

A long-running loop that watches every selected symbol's pool in one process. It ticks at the cadence of the *fastest* configured `poolCheckIntervalSeconds` and checks every symbol's pool on every tick; each position still uses its own symbol's `exitConfirmations` threshold. After enough consecutive out-of-range readings for a position, it closes it, collects principal and fees, and sells the stock token back to USDG on Arcus.

**This runs unattended and moves real funds without prompting.** It only ever touches positions the wallet owns *in a configured pool* — position NFTs from other pools are invisible to it. Every transaction is simulated first, and a revert aborts without broadcasting.

- `--dry-run` runs the full detection path and reports what it would do, sending nothing.
- `--symbol <ticker>` watches only that symbol.
- `--token-id <id>` watches a single position (requires `--symbol`, since a token id alone doesn't say which pool it's in).
- `--max-polls <n>` stops after a fixed number of checks.

The debounce exists so a single-block wick that mean-reverts cannot trigger a close. At the defaults, a position must read out-of-range for ~90 seconds before it exits.

## Exiting manually

```sh
npm run exit
```

Withdraws liquidity, claims accrued fees, and sells the resulting stock token back to USDG on Arcus, across every selected symbol's positions — the same flow the monitor runs automatically when a position goes one-sided, triggered by hand.

It prints principal, fees, and the guaranteed minimums for every position, then waits once for you to type `yes`, covering the whole batch:

```
  NVDA #422596  ticks [223080, 223740]
    principal  15.014571 USDG + 0.064233316680481947 NVDA
    fees       0.021363 USDG + 0.000072849752983344 NVDA
    at least   14.864425 USDG + 0.063590983513677127 NVDA
```

`decreaseLiquidity` and `collect` are bundled into one `multicall` transaction, so principal and fees arrive together with no separate claim step. `--dry-run` reports without sending, `--symbol <ticker>` narrows to one symbol, `--token-id <id>` exits one position (requires `--symbol`), `--yes` skips the prompt.

## Profit and loss

```sh
npm run pnl
```

Reconstructs every Arcus fill and open position from chain logs, per symbol — there is no local ledger, so nothing can drift if you also trade manually. Uncollected pool fees are read live from `feeGrowthInside`.

```
capital in   42.6845 USDG  (NVDA purchases + USDG deposited)
capital out  14.9895 USDG  (NVDA sold back)
still open   27.7126 USDG  (position principal + loose NVDA)
fees earned  +0.0273 USDG
net          +0.0449 USDG  (+0.11%)
```

Capital in counts **both** the Arcus purchases and the USDG taken from the wallet to fund a deposit — the latter never passes through a trade, and omitting it invents profit equal to that amount. Net marks open value at the pool price, so it moves with the market until the position is closed.

`--symbol <ticker>` narrows to one symbol; `--from-block <n>` narrows the scan (the default walks all history and is slower).

## Development

```sh
npm test        # vitest
npm run lint    # gts (Google TypeScript style)
npm run fix     # autofix lint and formatting
npm run typecheck
npm run build   # emit dist/
```

No test touches the live router or chain — the Arcus client is mocked throughout.
