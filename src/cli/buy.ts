/**
 * Entrypoint for `npm run buy` — buy the spot leg of every configured symbol
 * on Arcus.
 *
 * The spot half on its own, with no hedge: useful for acquiring inventory
 * deliberately, but it is **not** the delta-neutral strategy. Pairing a buy
 * with the matching perp short is what `npm run open` will do.
 *
 * Defaults to every symbol in `symbols.json`; `--symbol` narrows to one.
 * `--yes` skips the confirmation.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {ArcusError} from '../arcus/errors.js';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer, SELL_SYMBOL} from '../di/container.js';
import {runBuyCommand, type BuyRequestItem} from './buyCommand.js';
import {alwaysYes, print, promptYes} from './prompt.js';
import {loadSelectedSymbols} from './symbolSelection.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('buy')
    .description('Buy the spot leg of configured symbols on Arcus (unhedged)')
    .option('-y, --yes', 'skip the interactive confirmations')
    .option('--symbol <ticker>', 'act on only this configured symbol')
    .parse(process.argv);
  const options = program.opts<{yes?: boolean; symbol?: string}>();

  const config = loadConfig();
  const symbols = loadSelectedSymbols(config, options.symbol);
  const container = createContainer(config);
  const {logger, wallet, swapService} = container;
  const log = logger.child({tradeId: randomUUID()});
  const startedAt = Date.now();
  const confirm = options.yes ? alwaysYes : promptYes;

  log.info(
    {
      command: 'buy',
      symbols: symbols.map(s => s.symbol),
      ...loggableConfig(config),
    },
    'cli started',
  );
  log.info({walletAddress: wallet.getAccount().address}, 'wallet derived');

  try {
    const items: BuyRequestItem[] = symbols.map(s => ({
      symbol: s.symbol,
      stockTokenAddress: s.stockTokenAddress,
      usdgBuyAmount: s.usdgBuyAmount,
      slippageBps: s.slippageBps,
      twapChunks: s.twapChunks,
      twapIntervalSeconds: s.twapIntervalSeconds,
      maxPriceImpactBps: s.maxPriceImpactBps,
    }));

    const bought = await runBuyCommand({
      items,
      walletAddress: wallet.getAccount().address,
      chainId: config.chainId,
      arcusRouterUrl: config.arcusRouterUrl,
      sellSymbol: SELL_SYMBOL,
      buyService: swapService,
      confirm,
      print,
      newTradeId: () => randomUUID(),
    });

    if (!bought) {
      log.info(
        {outcome: 'aborted', elapsedMs: Date.now() - startedAt},
        'cli finished',
      );
      return 1;
    }

    const boughtSymbols = new Set(
      bought.filter(o => o.result !== undefined).map(o => o.symbol),
    );

    if (boughtSymbols.size === 0) {
      log.info(
        {outcome: 'all-buys-failed', elapsedMs: Date.now() - startedAt},
        'cli finished',
      );
      return 1;
    }

    log.info(
      {outcome: 'bought', elapsedMs: Date.now() - startedAt},
      'cli finished',
    );
    return 0;
  } catch (error) {
    const context = error instanceof ArcusError ? {...error} : {};
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      {...context, error: message, elapsedMs: Date.now() - startedAt},
      'cli failed',
    );
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
