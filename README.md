# arcusamm

Automated market-making bot for tokenized stocks on Arcus spot and Robinhood Chain.

> **This tool spends real money from a production wallet.** The buy command executes against mainnet. There is no dry-run mode — the only guard is the confirmation prompt.

## Status

Steps 1–3 are implemented: buy a stock token on Arcus, then open a Uniswap v4 position with a ±X% range around the pool price. Step 4 — monitoring the pool and closing/rebalancing when it shifts fully to one side — is not built yet. See [docs/architecture.md](docs/architecture.md).

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

`POOL_FEE` and `POOL_TICK_SPACING` must together match an initialized pool — v4 does not derive one from the other, and a mismatched pair addresses a different pool.

## Read-only previews

```sh
npm run quote      # what the Arcus buy would cost
npm run position   # what liquidity position would be opened
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

## Development

```sh
npm test        # vitest
npm run lint    # gts (Google TypeScript style)
npm run fix     # autofix lint and formatting
npm run typecheck
npm run build   # emit dist/
```

No test touches the live router or chain — the Arcus client is mocked throughout.
