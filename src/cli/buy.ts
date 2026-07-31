/**
 * Entrypoint for `npm run buy` — a manually triggered Arcus spot buy.
 *
 * Always executes against the production wallet. The operator must type `yes`
 * unless they pass `--yes`.
 */

import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {Command} from 'commander';
import {ArcusError} from '../arcus/errors.js';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer, SELL_SYMBOL} from '../di/container.js';
import {runBuyCommand} from './buyCommand.js';

async function promptYes(summary: string): Promise<boolean> {
  process.stdout.write(summary);
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await rl.question("Type 'yes' to continue: ");
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const program = new Command()
    .name('buy')
    .description('Buy a stock token on Arcus spot with the production wallet')
    .option('-y, --yes', 'skip the interactive confirmation')
    .parse(process.argv);
  const options = program.opts<{yes?: boolean}>();

  const tradeId = randomUUID();
  const config = loadConfig();
  const {logger, wallet, buyService} = createContainer(config);
  const log = logger.child({tradeId});
  const startedAt = Date.now();

  log.info({command: 'buy', ...loggableConfig(config)}, 'cli started');
  log.info({walletAddress: wallet.getAccount().address}, 'wallet derived');

  try {
    const result = await runBuyCommand({
      config,
      walletAddress: wallet.getAccount().address,
      tradeId,
      sellSymbol: SELL_SYMBOL,
      buyService,
      confirm: options.yes ? async () => true : promptYes,
      print: line => process.stdout.write(`${line}\n`),
    });

    const outcome = result ? 'confirmed' : 'aborted';
    log.info({outcome, elapsedMs: Date.now() - startedAt}, 'cli finished');
    return result ? 0 : 1;
  } catch (error) {
    const context = error instanceof ArcusError ? {...error} : {};
    log.error(
      {
        ...context,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      },
      'cli failed',
    );
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

process.exitCode = await main();
