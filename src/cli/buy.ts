/**
 * Entrypoint for `npm run buy` — buy a stock token on Arcus, then deposit it
 * into the Uniswap v4 pool.
 *
 * Always executes against the production wallet. The two steps are confirmed
 * separately because the deposit amounts cannot be known until the buy
 * settles. `--yes` skips both prompts; `--no-deposit` stops after the buy.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {ArcusError} from '../arcus/errors.js';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer, SELL_SYMBOL} from '../di/container.js';
import {runBuyCommand} from './buyCommand.js';
import {runDepositCommand} from './depositCommand.js';
import {alwaysYes, print, promptYes} from './prompt.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('buy')
    .description(
      'Buy a stock token on Arcus and deposit it into the Uniswap v4 pool',
    )
    .option('-y, --yes', 'skip the interactive confirmations')
    .option('--no-deposit', 'stop after the buy, without opening a position')
    .parse(process.argv);
  const options = program.opts<{yes?: boolean; deposit: boolean}>();

  const tradeId = randomUUID();
  const config = loadConfig();
  const container = createContainer(config);
  const {logger, wallet, swapService} = container;
  const log = logger.child({tradeId});
  const startedAt = Date.now();
  const confirm = options.yes ? alwaysYes : promptYes;

  log.info(
    {command: 'buy', deposit: options.deposit, ...loggableConfig(config)},
    'cli started',
  );
  log.info({walletAddress: wallet.getAccount().address}, 'wallet derived');

  try {
    const bought = await runBuyCommand({
      config,
      walletAddress: wallet.getAccount().address,
      tradeId,
      sellSymbol: SELL_SYMBOL,
      buyService: swapService,
      confirm,
      print,
    });

    if (!bought) {
      log.info(
        {outcome: 'aborted', elapsedMs: Date.now() - startedAt},
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

    const depositService = await container.createDepositService();
    const deposited = await runDepositCommand({
      usdg: depositService.tokens.usdg,
      stock: depositService.tokens.stock,
      rangeDeviationPercent: config.rangeDeviationPercent,
      depositService,
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
