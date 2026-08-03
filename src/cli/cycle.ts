/**
 * Entrypoint for `npm run cycle` — buy on Arcus, open liquidity positions,
 * then stay running and watch them until each pool's exit condition fires.
 *
 * Pure orchestration: buy, deposit, and monitor are the same tested,
 * independently-run pieces `npm run buy` and `npm run monitor` already use,
 * across every configured symbol (or just `--symbol`). Buy and deposit are
 * confirmed exactly as `npm run buy` already does; monitoring then runs
 * unattended exactly as `npm run monitor` already does. `--yes` skips both
 * confirmations. This runs one cycle and stops — it does not re-enter the
 * strategy after a position closes.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {ArcusError} from '../arcus/errors.js';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer, SELL_SYMBOL} from '../di/container.js';
import type {SymbolConfig} from '../config/symbols.js';
import {runBuyCommand, type BuyRequestItem} from './buyCommand.js';
import {runDepositCommand, type DepositRequestItem} from './depositCommand.js';
import {alwaysYes, print, promptYes} from './prompt.js';
import {loadSelectedSymbols} from './symbolSelection.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('cycle')
    .description(
      'Buy on Arcus, open liquidity positions, then watch them until exit',
    )
    .option('-y, --yes', 'skip the interactive confirmations')
    .option('--symbol <ticker>', 'act on only this configured symbol')
    .option('--max-polls <n>', 'stop monitoring after this many checks')
    .parse(process.argv);
  const options = program.opts<{
    yes?: boolean;
    symbol?: string;
    maxPolls?: string;
  }>();

  const config = loadConfig();
  const symbols = loadSelectedSymbols(config, options.symbol);
  const container = createContainer(config);
  const {logger, wallet, swapService} = container;
  const log = logger.child({tradeId: randomUUID()});
  const startedAt = Date.now();
  const confirm = options.yes ? alwaysYes : promptYes;

  log.info(
    {
      command: 'cycle',
      symbols: symbols.map(s => s.symbol),
      ...loggableConfig(config),
    },
    'cli started',
  );
  log.info({walletAddress: wallet.getAccount().address}, 'wallet derived');

  try {
    const buyItems: BuyRequestItem[] = symbols.map(s => ({
      symbol: s.symbol,
      stockTokenAddress: s.stockTokenAddress,
      usdgBuyAmount: s.usdgBuyAmount,
      slippageBps: s.slippageBps,
      twapChunks: s.twapChunks,
      twapIntervalSeconds: s.twapIntervalSeconds,
      maxPriceImpactBps: s.maxPriceImpactBps,
    }));

    const bought = await runBuyCommand({
      items: buyItems,
      walletAddress: wallet.getAccount().address,
      chainId: config.chainId,
      arcusRouterUrl: config.arcusRouterUrl,
      sellSymbol: SELL_SYMBOL,
      buyService: swapService,
      confirm,
      print,
      newTradeId: () => randomUUID(),
    });

    const boughtSymbols = new Set(
      (bought ?? []).filter(o => o.result !== undefined).map(o => o.symbol),
    );
    if (boughtSymbols.size === 0) {
      log.info(
        {outcome: 'aborted-at-buy', elapsedMs: Date.now() - startedAt},
        'cli finished',
      );
      return 1;
    }

    const toDeposit = symbols.filter(s => boughtSymbols.has(s.symbol));
    const depositItems: DepositRequestItem[] = await Promise.all(
      toDeposit.map(async s => {
        const depositService = await container.createDepositService(s);
        return {
          symbol: s.symbol,
          usdg: depositService.tokens.usdg,
          stock: depositService.tokens.stock,
          rangeDeviationPercent: s.rangeDeviationPercent,
          depositService,
        };
      }),
    );

    const deposited = await runDepositCommand({
      items: depositItems,
      confirm,
      print,
    });

    const openedSymbols = new Map(
      (deposited ?? [])
        .filter(o => o.result !== undefined)
        .map(o => [o.symbol, o.result!.tokenId] as const),
    );
    if (openedSymbols.size === 0) {
      log.info(
        {outcome: 'aborted-at-deposit', elapsedMs: Date.now() - startedAt},
        'cli finished',
      );
      return 1;
    }

    const watching: SymbolConfig[] = symbols.filter(s =>
      openedSymbols.has(s.symbol),
    );

    let tokenId: bigint | undefined;
    if (watching.length === 1) {
      tokenId = openedSymbols.get(watching[0]!.symbol);
      if (tokenId === undefined) {
        log.warn(
          {symbol: watching[0]!.symbol},
          'could not read the minted tokenId from the mint receipt; ' +
            'falling back to discovering all positions in the pool',
        );
      } else {
        print(`Position #${tokenId} opened. Now watching it.`);
      }
    } else {
      print(
        `${watching.length} positions opened across ${watching.map(s => s.symbol).join(', ')}. Now watching them.`,
      );
    }

    print('');
    print('Running unattended: positions will be closed and the stock');
    print(
      'token sold automatically when each pool goes one-sided. Ctrl-C to stop.',
    );
    print('');

    const monitor = await container.createMonitor(watching, false);
    await monitor.run({
      ...(tokenId !== undefined ? {tokenId} : {}),
      ...(options.maxPolls ? {maxPolls: Number(options.maxPolls)} : {}),
    });

    log.info(
      {outcome: 'cycle-complete', elapsedMs: Date.now() - startedAt},
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
