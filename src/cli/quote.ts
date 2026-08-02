/**
 * Entrypoint for `npm run quote` — a read-only preflight.
 *
 * Runs the same token resolution, quoting, and validation a buy does for
 * every configured symbol (or just `--symbol`), then stops. Nothing is
 * signed or submitted, so this is always safe to run.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {ArcusError} from '../arcus/errors.js';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {loadSelectedSymbols} from './symbolSelection.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('quote')
    .description('Preview an Arcus quote for every configured symbol')
    .option('--symbol <ticker>', 'preview only this configured symbol')
    .parse(process.argv);
  const options = program.opts<{symbol?: string}>();

  const config = loadConfig();
  const symbols = loadSelectedSymbols(config, options.symbol);
  const {logger, wallet, swapService} = createContainer(config);
  const log = logger.child({tradeId: randomUUID()});

  log.info(
    {
      command: 'quote',
      symbols: symbols.map(s => s.symbol),
      ...loggableConfig(config),
    },
    'cli started',
  );

  let failures = 0;
  for (const symbol of symbols) {
    const tradeId = randomUUID();
    try {
      const preview = await swapService.previewQuote({
        tradeId,
        buyToken: symbol.stockTokenAddress,
        sellAmount: symbol.usdgBuyAmount,
        slippageBps: symbol.slippageBps,
      });

      const out = [
        '',
        `  ${symbol.symbol}`,
        `  wallet       ${wallet.getAccount().address}`,
        `  venue        ${preview.venue}`,
        `  spend        ${preview.sellAmount} ${preview.sellSymbol}`,
        `  receive      ${preview.buyAmount} ${preview.buySymbol}`,
        `  guaranteed   ${preview.minBuyAmount} ${preview.buySymbol} minimum`,
        `  price        ${preview.pricePerUnit} ${preview.sellSymbol} per ${preview.buySymbol}`,
        `  slippage     ${symbol.slippageBps} bps`,
        `  quote expiry ${preview.expiresAt}`,
        `  fees         ${preview.fees.length === 0 ? 'none reported' : JSON.stringify(preview.fees)}`,
        '',
      ].join('\n');
      process.stdout.write(`${out}\n`);

      log.info({symbol: symbol.symbol, ...preview, tradeId}, 'symbol quoted');
    } catch (error) {
      failures++;
      const context = error instanceof ArcusError ? {...error} : {};
      const message = error instanceof Error ? error.message : String(error);
      log.error(
        {symbol: symbol.symbol, tradeId, ...context, error: message},
        'symbol quote failed',
      );
      process.stderr.write(`${symbol.symbol}: ${message}\n`);
    }
  }

  process.stdout.write(
    '  Nothing was signed. Run `npm run buy` to execute.\n\n',
  );
  log.info({failures, total: symbols.length}, 'cli finished');
  return failures === symbols.length && symbols.length > 0 ? 1 : 0;
}

process.exitCode = await main();
