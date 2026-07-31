/**
 * Entrypoint for `npm run quote` — a read-only preflight.
 *
 * Runs the same token resolution, quoting, and validation a buy does, then
 * stops. Nothing is signed or submitted, so this is always safe to run.
 */

import {randomUUID} from 'node:crypto';
import {ArcusError} from '../arcus/errors.js';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';

async function main(): Promise<number> {
  const tradeId = randomUUID();
  const config = loadConfig();
  const {logger, wallet, swapService} = createContainer(config);
  const log = logger.child({tradeId});

  log.info({command: 'quote', ...loggableConfig(config)}, 'cli started');

  try {
    const preview = await swapService.previewQuote({
      tradeId,
      buyToken: config.stockTokenAddress,
      sellAmount: config.usdgBuyAmount,
      slippageBps: config.slippageBps,
    });

    const out = [
      '',
      `  wallet       ${wallet.getAccount().address}`,
      `  venue        ${preview.venue}`,
      `  spend        ${preview.sellAmount} ${preview.sellSymbol}`,
      `  receive      ${preview.buyAmount} ${preview.buySymbol}`,
      `  guaranteed   ${preview.minBuyAmount} ${preview.buySymbol} minimum`,
      `  price        ${preview.pricePerUnit} ${preview.sellSymbol} per ${preview.buySymbol}`,
      `  slippage     ${config.slippageBps} bps`,
      `  quote expiry ${preview.expiresAt}`,
      `  fees         ${preview.fees.length === 0 ? 'none reported' : JSON.stringify(preview.fees)}`,
      '',
      '  Nothing was signed. Run `npm run buy` to execute.',
      '',
    ].join('\n');
    process.stdout.write(`${out}\n`);

    // tradeId is already bound on the child logger.
    log.info({...preview, tradeId: undefined}, 'cli finished');
    return 0;
  } catch (error) {
    const context = error instanceof ArcusError ? {...error} : {};
    const message = error instanceof Error ? error.message : String(error);
    log.error({...context, error: message}, 'cli failed');
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
