# arcusamm

Automated market-making bot for tokenized stocks on Arcus spot and Robinhood Chain.

> **This tool spends real money from a production wallet.** The buy command executes against mainnet. There is no dry-run mode — the only guard is the confirmation prompt.

## Status

Step 1 of the strategy is implemented: a manually triggered spot buy on Arcus. Pool deposits, range management, and rebalancing are not built yet. See [docs/architecture.md](docs/architecture.md).

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

## Buying

```sh
npm run buy
```

The command prints the wallet address, spend amount, token, chain, and slippage, then waits for you to type `yes`. Anything else aborts with nothing signed. Pass `--yes` to skip the prompt only when you intend unattended execution.

Start with a small `USDG_BUY_AMOUNT` on your first live run.

## Development

```sh
npm test        # vitest
npm run lint    # gts (Google TypeScript style)
npm run fix     # autofix lint and formatting
npm run typecheck
npm run build   # emit dist/
```

No test touches the live router or chain — the Arcus client is mocked throughout.
