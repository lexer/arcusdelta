/**
 * Entrypoint for `npm run position` — a read-only preflight for the deposit.
 *
 * Runs the same planning the deposit does (pool read, range, liquidity, both
 * amounts) and stops. Nothing is approved or minted, so this is always safe.
 */

import {randomUUID} from 'node:crypto';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {buildDepositSummary} from './depositCommand.js';
import {print} from './prompt.js';

async function main(): Promise<number> {
  const tradeId = randomUUID();
  const config = loadConfig();
  const container = createContainer(config);
  const log = container.logger.child({tradeId});

  log.info({command: 'position', ...loggableConfig(config)}, 'cli started');

  try {
    const depositService = await container.createDepositService();
    const plan = await depositService.plan();

    print(
      buildDepositSummary(plan, {
        usdg: depositService.tokens.usdg,
        stock: depositService.tokens.stock,
        rangeDeviationPercent: config.rangeDeviationPercent,
        depositService,
        confirm: async () => false,
        print,
      }),
    );
    print(
      '  Nothing was approved or minted. Run `npm run deposit` to open it.',
    );
    print('');

    log.info(
      {
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
        liquidity: plan.liquidity.toString(),
        stockAmount: plan.stockAmount.toString(),
        usdgAmount: plan.usdgAmount.toString(),
      },
      'cli finished',
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({error: message}, 'cli failed');
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
