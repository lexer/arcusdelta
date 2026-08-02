/**
 * Entrypoint for `npm run buy` — buy every configured stock token on Arcus,
 * then deposit each into its Uniswap v3 pool.
 *
 * Defaults to every symbol in `symbols.json`; `--symbol` narrows to one. The
 * two steps are confirmed separately because deposit amounts cannot be known
 * until the buys settle. `--yes` skips both prompts; `--no-deposit` stops
 * after the buys.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {ArcusError} from '../arcus/errors.js';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer, SELL_SYMBOL} from '../di/container.js';
import {runBuyCommand, type BuyRequestItem} from './buyCommand.js';
import {runDepositCommand, type DepositRequestItem} from './depositCommand.js';
import {alwaysYes, print, promptYes} from './prompt.js';
import {loadSelectedSymbols} from './symbolSelection.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('buy')
    .description(
      'Buy configured stock tokens on Arcus and deposit them into their Uniswap v3 pools',
    )
    .option('-y, --yes', 'skip the interactive confirmations')
    .option('--no-deposit', 'stop after the buys, without opening any position')
    .option('--symbol <ticker>', 'act on only this configured symbol')
    .parse(process.argv);
  const options = program.opts<{
    yes?: boolean;
    deposit: boolean;
    symbol?: string;
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
      command: 'buy',
      deposit: options.deposit,
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

    if (!options.deposit) {
      log.info(
        {outcome: 'bought', elapsedMs: Date.now() - startedAt},
        'cli finished',
      );
      print('Skipping deposit (--no-deposit). Run `npm run deposit` later.');
      return 0;
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

    const outcome = deposited ? 'deposited' : 'bought-not-deposited';
    log.info({outcome, elapsedMs: Date.now() - startedAt}, 'cli finished');
    return deposited ? 0 : 1;
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
