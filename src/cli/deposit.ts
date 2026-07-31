/**
 * Entrypoint for `npm run deposit` — open a Uniswap v4 position from the
 * stock-token balance the wallet already holds.
 *
 * Exists alongside the chained `buy` flow so a balance acquired earlier is
 * never stranded. `--yes` skips the confirmation.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {runDepositCommand} from './depositCommand.js';
import {alwaysYes, print, promptYes} from './prompt.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('deposit')
    .description('Open a Uniswap v4 position from the wallet stock balance')
    .option('-y, --yes', 'skip the interactive confirmation')
    .parse(process.argv);
  const options = program.opts<{yes?: boolean}>();

  const tradeId = randomUUID();
  const config = loadConfig();
  const container = createContainer(config);
  const log = container.logger.child({tradeId});
  const startedAt = Date.now();

  log.info({command: 'deposit', ...loggableConfig(config)}, 'cli started');
  log.info(
    {walletAddress: container.wallet.getAccount().address},
    'wallet derived',
  );

  try {
    const depositService = await container.createDepositService();
    const result = await runDepositCommand({
      usdg: depositService.tokens.usdg,
      stock: depositService.tokens.stock,
      rangeDeviationPercent: config.rangeDeviationPercent,
      depositService,
      confirm: options.yes ? alwaysYes : promptYes,
      print,
    });

    const outcome = result ? 'deposited' : 'aborted';
    log.info({outcome, elapsedMs: Date.now() - startedAt}, 'cli finished');
    return result ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(
      {error: message, elapsedMs: Date.now() - startedAt},
      'cli failed',
    );
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
