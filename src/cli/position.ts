/**
 * Entrypoint for `npm run position` — a read-only preflight for the deposit.
 *
 * Runs the same planning the deposit does (pool read, range, liquidity, both
 * amounts) for every configured symbol (or just `--symbol`) and stops.
 * Nothing is approved or minted, so this is always safe.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import type {DepositPlan} from '../uniswap/depositService.js';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {
  buildDepositSummary,
  type DepositRequestItem,
} from './depositCommand.js';
import {print} from './prompt.js';
import {loadSelectedSymbols} from './symbolSelection.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('position')
    .description(
      'Preview the Uniswap v3 deposit plan for every configured symbol',
    )
    .option('--symbol <ticker>', 'preview only this configured symbol')
    .parse(process.argv);
  const options = program.opts<{symbol?: string}>();

  const config = loadConfig();
  const symbols = loadSelectedSymbols(config, options.symbol);
  const container = createContainer(config);
  const log = container.logger.child({tradeId: randomUUID()});

  log.info(
    {
      command: 'position',
      symbols: symbols.map(s => s.symbol),
      ...loggableConfig(config),
    },
    'cli started',
  );

  let failures = 0;
  const planned: {item: DepositRequestItem; plan: DepositPlan}[] = [];
  for (const s of symbols) {
    try {
      const depositService = await container.createDepositService(s);
      const item: DepositRequestItem = {
        symbol: s.symbol,
        usdg: depositService.tokens.usdg,
        stock: depositService.tokens.stock,
        rangeDeviationPercent: s.rangeDeviationPercent,
        depositService,
      };
      const plan = await depositService.plan();
      planned.push({item, plan});
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message : String(error);
      log.error({symbol: s.symbol, error: message}, 'symbol plan failed');
      process.stderr.write(`${s.symbol}: ${message}\n`);
    }
  }

  if (planned.length > 0) {
    print(buildDepositSummary(planned));
  }
  print('  Nothing was approved or minted. Run `npm run deposit` to open it.');
  print('');

  log.info(
    {
      planned: planned.map(({item, plan}) => ({
        symbol: item.symbol,
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
        liquidity: plan.liquidity.toString(),
        stockAmount: plan.stockAmount.toString(),
        usdgAmount: plan.usdgAmount.toString(),
      })),
      failures,
    },
    'cli finished',
  );
  return failures === symbols.length && symbols.length > 0 ? 1 : 0;
}

process.exitCode = await main();
