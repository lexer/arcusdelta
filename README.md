# arcusamm

Automated market-making bot for tokenized stocks on Arcus spot and Robinhood Chain.

> **This tool spends real money from a production wallet.** The buy command executes against mainnet. There is no dry-run mode — the only guard is the confirmation prompt.

## Status

The full strategy is implemented: buy a stock token on Arcus, open a Uniswap v4 position with a ±X% range, then watch the pool and exit when it goes one-sided — closing the position, collecting fees, and selling the stock token back to USDG. See [docs/architecture.md](docs/architecture.md).

## Setup

```sh
npm install
cp .env.example .env
```

Fill in `.env`. `SEED` is the production wallet mnemonic and has no default; everything else defaults to Robinhood Chain mainnet and the hosted Arcus router. `.env` is gitignored — never commit it.

| Variable | Default |
| --- | --- |
| `SEED` | *(required)* |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` |
| `CHAIN_ID` | `4663` |
| `ARCUS_ROUTER_URL` | `https://router.spot.arcus.xyz/v1` |
| `STOCK_TOKEN_ADDRESS` | NVDA (`0xd0601CE1…D9EEC`) |
| `USDG_BUY_AMOUNT` | `100` |
| `SLIPPAGE_BPS` | `1` (0.01%) |
| `RANGE_DEVIATION_PERCENT` | `3` |
| `POOL_FEE` | `3000` (0.3%) |
| `POOL_TICK_SPACING` | `60` |
| `LP_SLIPPAGE_BPS` | `50` |
| `MINT_DEADLINE_SECONDS` | `300` |
| `POOL_CHECK_INTERVAL_SECONDS` | `30` |
| `EXIT_CONFIRMATIONS` | `3` |
| `POSITION_LOOKBACK_BLOCKS` | `500000` |
| `CLOSE_SLIPPAGE_BPS` | `100` |

`POOL_FEE` and `POOL_TICK_SPACING` must together match an initialized pool — v4 does not derive one from the other, and a mismatched pair addresses a different pool.

## Read-only previews

```sh
npm run quote                # what the Arcus buy would cost
npm run position             # what liquidity position would be opened
npm run monitor -- --dry-run # which positions are watched, and their status
npm run pnl                  # profit and loss, including fees earned
npm run exit -- --dry-run    # what withdrawing right now would return
```

Neither signs, approves, nor mints. Both run the same code paths the spending commands do, then stop — so they are always safe, and they show the real numbers.

## Buying and depositing

```sh
npm run buy
```

Buys on Arcus, then opens the liquidity position. The two steps are confirmed **separately**, because the deposit amounts cannot be known until the buy settles. Each prompt prints the real figures and waits for you to type `yes`; anything else aborts.

- `--no-deposit` stops after the buy.
- `--yes` skips both prompts. Only for intentional unattended runs.

```sh
npm run deposit
```

Opens a position from the stock-token balance the wallet already holds, without buying. Use this when a balance was acquired earlier.

The position uses the wallet's **entire** stock-token balance as the fixed side and derives the USDG needed for the range; it fails clearly if USDG is short. Start with a small `USDG_BUY_AMOUNT` on your first live run.

## Monitoring

```sh
npm run monitor
```

A long-running loop. Every `POOL_CHECK_INTERVAL_SECONDS` it checks whether the pool has left each position's range. After `EXIT_CONFIRMATIONS` consecutive out-of-range readings it closes the position, collects principal and fees, and sells the stock token back to USDG on Arcus.

**This runs unattended and moves real funds without prompting.** It only ever touches positions the wallet owns *in the configured pool* — position NFTs from other pools are invisible to it. Every transaction is simulated first, and a revert aborts without broadcasting.

- `--dry-run` runs the full detection path and reports what it would do, sending nothing.
- `--token-id <id>` watches a single position.
- `--max-polls <n>` stops after a fixed number of checks.

The debounce exists so a single-block wick that mean-reverts cannot trigger a close. At the defaults, a position must read out-of-range for ~90 seconds before it exits.

## Exiting manually

```sh
npm run exit
```

Withdraws the liquidity, claims the accrued fees, and sells the resulting stock token back to USDG on Arcus — the same flow the monitor runs automatically when a position goes one-sided, triggered by hand.

It prints principal, fees, and the guaranteed minimums, then waits for you to type `yes`:

```
  #422596  ticks [223080, 223740]
    principal  15.014571 USDG + 0.064233316680481947 NVDA
    fees       0.021363 USDG + 0.000072849752983344 NVDA
    at least   14.864425 USDG + 0.063590983513677127 NVDA
```

The burn returns principal and fees together, so there is no separate claim step. `--dry-run` reports without sending, `--token-id <id>` exits one position, `--yes` skips the prompt.

## Profit and loss

```sh
npm run pnl
```

Reconstructs every Arcus fill and open position from chain logs — there is no local ledger, so nothing can drift if you also trade manually. Uncollected pool fees are read live from `feeGrowthInside`.

```
capital in   42.6845 USDG  (NVDA purchases + USDG deposited)
capital out  14.9895 USDG  (NVDA sold back)
still open   27.7126 USDG  (position principal + loose NVDA)
fees earned  +0.0273 USDG
net          +0.0449 USDG  (+0.11%)
```

Capital in counts **both** the Arcus purchases and the USDG taken from the wallet to fund a deposit — the latter never passes through a trade, and omitting it invents profit equal to that amount. Net marks open value at the pool price, so it moves with the market until the position is closed.

`--from-block <n>` narrows the scan; the default walks all history and is slower.

## Development

```sh
npm test        # vitest
npm run lint    # gts (Google TypeScript style)
npm run fix     # autofix lint and formatting
npm run typecheck
npm run build   # emit dist/
```

No test touches the live router or chain — the Arcus client is mocked throughout.
