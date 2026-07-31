/**
 * Entrypoint for `npm run pnl` — a read-only profit and loss report.
 *
 * Reconstructs everything from chain logs and current pool state. Sends
 * nothing and needs no local ledger.
 */

import {Command} from 'commander';
import {formatUnits} from 'viem';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import type {PnlReport} from '../pnl/pnlReporter.js';
import {print} from './prompt.js';

function signed(value: number, digits = 4): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function render(
  report: PnlReport,
  usdgSymbol: string,
  stockSymbol: string,
  stockDecimals: number,
  usdgDecimals: number,
): void {
  const {breakdown} = report;

  print('');
  print(`  wallet       ${report.walletAddress}`);
  print(
    `  pool price   ${report.priceUsdgPerStock.toFixed(4)} ${usdgSymbol} per ${stockSymbol} (tick ${report.poolTick})`,
  );
  print(
    `  scanned      blocks ${report.scannedFromBlock} to ${report.scannedToBlock}`,
  );
  print('');

  if (report.trades.length === 0) {
    print('  No Arcus trades found for this pair.');
  } else {
    print(`  Arcus trades (${report.trades.length})`);
    for (const trade of report.trades) {
      const usdg = formatUnits(trade.usdgAtoms, usdgDecimals);
      const stock = formatUnits(trade.stockAtoms, stockDecimals);
      const arrow = trade.direction === 'buy' ? '->' : '<-';
      print(
        `    block ${trade.blockNumber}  ${trade.direction.padEnd(4)} ${usdg} ${usdgSymbol} ${arrow} ${stock} ${stockSymbol}  @ ${trade.price.toFixed(4)}`,
      );
    }
  }
  print('');

  if (report.positions.length === 0) {
    print('  No open positions.');
  } else {
    print(`  Open positions (${report.positions.length})`);
    for (const entry of report.positions) {
      print(
        `    #${entry.position.tokenId}  ticks [${entry.position.tickLower}, ${entry.position.tickUpper}]`,
      );
      print(
        `      principal  ${formatUnits(entry.principalUsdg, usdgDecimals)} ${usdgSymbol} + ${formatUnits(entry.principalStock, stockDecimals)} ${stockSymbol}`,
      );
      print(
        `      fees       ${formatUnits(entry.fees0, usdgDecimals)} ${usdgSymbol} + ${formatUnits(entry.fees1, stockDecimals)} ${stockSymbol}`,
      );
      print(
        `      funded by  ${formatUnits(entry.depositedUsdg, usdgDecimals)} ${usdgSymbol} from the wallet`,
      );
    }
  }
  print('');

  print('  Summary');
  print(
    `    capital in   ${breakdown.capitalInUsdg.toFixed(4)} ${usdgSymbol}  (${stockSymbol} purchases + ${usdgSymbol} deposited)`,
  );
  print(
    `    capital out  ${breakdown.capitalOutUsdg.toFixed(4)} ${usdgSymbol}  (${stockSymbol} sold back)`,
  );
  print(
    `    still open   ${breakdown.openValueUsdg.toFixed(4)} ${usdgSymbol}  (position principal + loose ${stockSymbol})`,
  );
  print(`    fees earned  ${signed(breakdown.feesUsdg)} ${usdgSymbol}`);
  print(
    `    net          ${signed(breakdown.netUsdg)} ${usdgSymbol}  (${signed(breakdown.returnFraction * 100, 2)}%)`,
  );
  print('');
  print(
    '  Open value is marked at the pool price, so net moves with the market',
  );
  print('  and is only realized once the position is closed and sold.');
  print('');
}

async function main(): Promise<number> {
  const program = new Command()
    .name('pnl')
    .description('Report profit and loss, including fees earned')
    .option('--from-block <n>', 'start scanning at this block', '0')
    .parse(process.argv);
  const options = program.opts<{fromBlock: string}>();

  const config = loadConfig();
  const container = createContainer(config);
  const {logger, wallet} = container;

  logger.info({command: 'pnl', ...loggableConfig(config)}, 'cli started');

  try {
    const reporter = await container.createPnlReporter();
    const report = await reporter.report(
      wallet.getAccount().address,
      BigInt(options.fromBlock),
    );

    const {usdg, stock} = await container
      .createDepositService()
      .then(s => s.tokens);
    render(report, usdg.symbol, stock.symbol, stock.decimals, usdg.decimals);

    logger.info({netUsdg: report.breakdown.netUsdg}, 'cli finished');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({error: message}, 'cli failed');
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
