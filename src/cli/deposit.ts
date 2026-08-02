/**
 * Entrypoint for `npm run deposit` — open a Uniswap v3 position from the
 * stock-token balance the wallet already holds, for every configured symbol
 * (or just `--symbol`).
 *
 * Exists alongside the chained `buy` flow so a balance acquired earlier is
 * never stranded. `--yes` skips the confirmation.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {runDepositCommand, type DepositRequestItem} from './depositCommand.js';
import {alwaysYes, print, promptYes} from './prompt.js';
import {loadSelectedSymbols} from './symbolSelection.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('deposit')
    .description('Open Uniswap v3 positions from the wallet stock balances')
    .option('-y, --yes', 'skip the interactive confirmation')
    .option('--symbol <ticker>', 'act on only this configured symbol')
    .parse(process.argv);
  const options = program.opts<{yes?: boolean; symbol?: string}>();

  const config = loadConfig();
  const symbols = loadSelectedSymbols(config, options.symbol);
  const container = createContainer(config);
  const log = container.logger.child({tradeId: randomUUID()});
  const startedAt = Date.now();

  log.info(
    {
      command: 'deposit',
      symbols: symbols.map(s => s.symbol),
      ...loggableConfig(config),
    },
    'cli started',
  );
  log.info(
    {walletAddress: container.wallet.getAccount().address},
    'wallet derived',
  );

  try {
    const items: DepositRequestItem[] = await Promise.all(
      symbols.map(async s => {
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

    const result = await runDepositCommand({
      items,
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
