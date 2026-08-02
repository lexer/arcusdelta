/**
 * Entrypoint for `npm run cycle` — buy on Arcus, open the liquidity position,
 * then stay running and watch it until the pool's exit condition fires.
 *
 * Pure orchestration: buy, deposit, and monitor are the same tested,
 * independently-run pieces `npm run buy` and `npm run monitor` already use.
 * Buy and deposit are confirmed exactly as `npm run buy` already does;
 * monitoring then runs unattended exactly as `npm run monitor` already does.
 * `--yes` skips both confirmations. This runs one cycle and stops — it does
 * not re-enter the strategy after the position closes.
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
    .name('cycle')
    .description(
      'Buy on Arcus, open the liquidity position, then watch it until exit',
    )
    .option('-y, --yes', 'skip the interactive confirmations')
    .option('--max-polls <n>', 'stop monitoring after this many checks')
    .parse(process.argv);
  const options = program.opts<{yes?: boolean; maxPolls?: string}>();

  const tradeId = randomUUID();
  const config = loadConfig();
  const container = createContainer(config);
  const {logger, wallet, swapService} = container;
  const log = logger.child({tradeId});
  const startedAt = Date.now();
  const confirm = options.yes ? alwaysYes : promptYes;

  log.info({command: 'cycle', ...loggableConfig(config)}, 'cli started');
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
        {outcome: 'aborted-at-buy', elapsedMs: Date.now() - startedAt},
        'cli finished',
      );
      return 1;
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

    if (!deposited) {
      log.info(
        {outcome: 'aborted-at-deposit', elapsedMs: Date.now() - startedAt},
        'cli finished',
      );
      return 1;
    }

    if (deposited.tokenId === undefined) {
      log.warn(
        {hash: deposited.hash},
        'could not read the minted tokenId from the mint receipt; ' +
          'falling back to discovering all positions in the pool',
      );
    } else {
      print(`Position #${deposited.tokenId} opened. Now watching it.`);
    }

    print('');
    print('Running unattended: the position will be closed and the stock');
    print(
      'token sold automatically when the pool goes one-sided. Ctrl-C to stop.',
    );
    print('');

    const monitor = await container.createMonitor(false);
    await monitor.run({
      ...(deposited.tokenId !== undefined ? {tokenId: deposited.tokenId} : {}),
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
