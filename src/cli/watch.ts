/**
 * Entrypoint for `npm run watch` — keeps an eye on open pairs and says when
 * closing one would realize a profit.
 *
 * Read-only. It values, reports, and logs; it never closes anything. Unwinding
 * moves funds and stays behind an explicit command.
 *
 * Pairs are discovered from live state rather than configuration: any perp
 * position that looks like one this strategy created (short, with a matching
 * spot balance) is valued. Positions the bot did not open are listed as
 * ignored rather than silently dropped.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {erc20Abi, formatUnits, type Hex} from 'viem';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {PairMonitor, type WatchedPair} from '../delta/pairMonitor.js';
import {FundingRecorder} from '../journal/fundingRecorder.js';
import {ArcusPerpsClient} from '../perps/arcusPerpsClient.js';
import {MarketRegistry} from '../perps/marketRegistry.js';
import {PerpsShortService} from '../perps/perpsShortService.js';
import {print} from './prompt.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('watch')
    .description('Watch open pairs for a profitable close')
    .option('--min-profit-bps <n>', 'override the close threshold')
    .option('--interval <seconds>', 'override the check interval')
    .option('--once', 'run a single pass and stop')
    .parse(process.argv);
  const options = program.opts<{
    minProfitBps?: string;
    interval?: string;
    once?: boolean;
  }>();

  const config = loadConfig();
  const container = createContainer(config);
  const {logger, wallet, swapService, journal} = container;
  const address = wallet.getAccount().address;

  const reader = new ArcusPerpsClient({baseUrl: config.arcusApiUrl, logger});
  const registry = new MarketRegistry(reader);
  const shorts = new PerpsShortService({
    // The monitor never places an order, so the write client is not needed.
    client: {
      placeOrder: () => {
        throw new Error('watch is read-only');
      },
    },
    marketData: reader,
    executor: {
      fill: () => {
        throw new Error('watch is read-only');
      },
    },
    journal,
    logger,
    address,
    accountIndex: config.arcusAccountIndex,
  });

  const minProfitBps = options.minProfitBps
    ? Number(options.minProfitBps)
    : config.minCloseProfitBps;
  const checkIntervalSeconds = options.interval
    ? Number(options.interval)
    : config.pairCheckIntervalSeconds;

  logger.info(
    {
      command: 'watch',
      minProfitBps,
      checkIntervalSeconds,
      ...loggableConfig(config),
    },
    'cli started',
  );

  // Every short currently open is a candidate; isManagedPair decides.
  const positions = await shorts.positions();
  const candidates = positions.filter(position => position.side === 'SHORT');
  if (candidates.length === 0) {
    print('\nNo short perp positions open — nothing to watch.\n');
    return 0;
  }

  const pairs: WatchedPair[] = [];
  for (const position of candidates) {
    const spec = await registry.byMarket(position.marketDisplayName);
    let token;
    try {
      token = await container.tokens.bySymbol(spec.baseAsset);
    } catch {
      logger.warn(
        {market: spec.market},
        'no spot token for this market; cannot value it as a pair',
      );
      continue;
    }
    const tokenAddress = token.address as Hex;
    const decimals = token.decimals;

    pairs.push({
      symbol: spec.baseAsset,
      market: spec.market,
      readSpotBalance: async () =>
        formatUnits(
          await wallet.getPublicClient().readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          }),
          decimals,
        ),
      quoteSpotExit: async (quantity: string) => {
        const preview = await swapService.previewSell({
          tradeId: randomUUID(),
          sellToken: tokenAddress,
          sellAmountAtoms: parseBase(quantity, decimals),
          slippageBps: config.slippageBps,
        });
        return preview.buyAmount;
      },
      // The taker side: what closing would cost if it had to cross. If the
      // pair is profitable at this price it is profitable resting too.
      quotePerpExit: async () => {
        const bbo = await reader.getBbo(spec.market);
        return bbo.bestAsk?.price ?? position.markPx;
      },
    });
  }

  const monitor = new PairMonitor({
    pairs,
    shorts,
    marketData: reader,
    journal,
    logger,
    minProfitBps,
    deltaToleranceBps: config.maxDeltaBps,
    checkIntervalSeconds,
    funding: new FundingRecorder({
      client: reader,
      journal,
      logger,
      address,
      accountIndex: config.arcusAccountIndex,
    }),
  });

  print(
    `\nWatching ${pairs.length} candidate position${pairs.length === 1 ? '' : 's'}. ` +
      'Read-only — nothing will be closed. Ctrl-C to stop.',
  );
  await monitor.run({
    ...(options.once ? {maxPasses: 1} : {}),
    print,
  });
  return 0;
}

/** Decimal string -> atoms, without going through a float. */
function parseBase(value: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals));
}

process.exitCode = await main();
