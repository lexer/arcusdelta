/**
 * Entrypoint for `npm run close` — unwinds a delta-neutral pair.
 *
 * Chunked, and perp-first within every chunk: a reduce-only post-only buy-back
 * followed by a spot sell of the same size, so delta returns to flat at each
 * step rather than only at the end.
 *
 * This is the one command besides `open` that moves funds, so it refuses to
 * start on anything it does not own, shows exactly what it will do, and waits
 * for an explicit `yes`.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {erc20Abi, formatUnits, type Hex} from 'viem';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {createJournal} from '../di/observability.js';
import {PairCloseService, splitQuantity} from '../delta/pairCloseService.js';
import {AuthenticatedPerpsClient} from '../perps/authenticatedPerpsClient.js';
import {absDecimals} from '../perps/decimal.js';
import {ArcusPerpsClient} from '../perps/arcusPerpsClient.js';
import {MakerOrderExecutor} from '../perps/makerOrderExecutor.js';
import {MarketRegistry} from '../perps/marketRegistry.js';
import {isManagedPair, PerpsShortService} from '../perps/perpsShortService.js';
import {PerpsRequestSigner} from '../perps/signing.js';
import {alwaysYes, print, promptYes} from './prompt.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('close')
    .description('Unwind a delta-neutral pair, perp first, in chunks')
    .requiredOption('--symbol <ticker>', 'the pair to close')
    .option('--chunks <n>', 'override the chunk count')
    .option('--quantity <n>', 'close only this much, rather than all of it')
    .option('--improve-ticks <n>', 'post this many ticks in front of the touch')
    .option('-y, --yes', 'skip the confirmation')
    .option('--dry-run', 'show the plan and stop')
    .parse(process.argv);
  const options = program.opts<{
    symbol: string;
    chunks?: string;
    quantity?: string;
    improveTicks?: string;
    yes?: boolean;
    dryRun?: boolean;
  }>();

  const config = loadConfig();
  if (config.arcusApiPrivateKey === undefined) {
    process.stderr.write(
      'ARCUS_API_PRIVATE_KEY is not set — run `npm run apikey` first.\n',
    );
    return 1;
  }

  const container = createContainer(config);
  const {logger, wallet, swapService, tokens} = container;
  const journal = createJournal(config, options.dryRun === true);
  const address = wallet.getAccount().address;
  const symbol = options.symbol.toUpperCase();

  const reader = new ArcusPerpsClient({baseUrl: config.arcusApiUrl, logger});
  const client = new AuthenticatedPerpsClient({
    baseUrl: config.arcusApiUrl,
    logger,
    signer: new PerpsRequestSigner(config.arcusApiPrivateKey),
    address,
    accountIndex: config.arcusAccountIndex,
  });
  const registry = new MarketRegistry(reader);
  const executor = new MakerOrderExecutor({
    client,
    marketData: reader,
    journal,
    logger,
  });
  const shorts = new PerpsShortService({
    client,
    marketData: reader,
    executor,
    journal,
    logger,
    address,
    accountIndex: config.arcusAccountIndex,
  });

  logger.info(
    {
      command: 'close',
      symbol,
      dryRun: options.dryRun === true,
      ...loggableConfig(config),
    },
    'cli started',
  );

  const spec = await registry.byBaseAsset(symbol);
  const position = await shorts.positionFor(spec.market);
  if (position === undefined || position.side !== 'SHORT') {
    print(`\nNo short position open on ${spec.market}. Nothing to close.\n`);
    return 0;
  }

  const token = await tokens.bySymbol(symbol);
  const tokenAddress = token.address as Hex;
  const balanceAtoms = await wallet.getPublicClient().readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
  const spotBalance = formatUnits(balanceAtoms, token.decimals);

  // Same guard the monitor uses: only unwind what this strategy owns.
  if (!isManagedPair(position, spotBalance, config.maxDeltaBps)) {
    process.stderr.write(
      `\n${spec.market} is ${position.side} ${position.size} against a spot ` +
        `balance of ${spotBalance}. That is not a pair this bot manages — ` +
        'refusing to unwind it.\n\n',
    );
    return 1;
  }

  const openSize = absDecimals(position.size);
  const quantity = options.quantity ?? openSize;
  const chunks = options.chunks ? Number(options.chunks) : config.twapChunks;
  const improveTicks = options.improveTicks
    ? Number(options.improveTicks)
    : config.makerImproveTicks;
  const pieces = splitQuantity(quantity, chunks, spec.stepSize);

  print('');
  print(`About to UNWIND ${quantity} ${symbol} from ${address}`);
  print(
    `  perp position   SHORT ${position.size} @ ${position.averageEntryPrice}`,
  );
  print(`  spot balance    ${spotBalance} ${symbol}`);
  print(`  chunks          ${pieces.length} x ~${pieces[0]}`);
  print(
    `  perp leg        reduce-only POST-ONLY limit, ${config.makerMaxAttempts} x ${config.makerRepriceSeconds}s, ${improveTicks} tick(s) in front`,
  );
  print(
    `  spot leg        sold after each perp chunk fills, ${config.slippageBps} bps slippage`,
  );
  print('');
  print('Each chunk buys the perp back first, waits for that maker order to');
  print('fill, sells the matching spot, and only then pauses');
  print(
    `${config.twapIntervalSeconds}s before the next chunk — so a slow fill delays the`,
  );
  print('next chunk rather than overlapping with it, and net delta returns to');
  print(
    'flat between chunks. Maker only: a chunk that will not fill stops the',
  );
  print('unwind rather than crossing the spread.');
  print('');
  print('This is a PRODUCTION wallet holding real funds.');
  print('');

  if (options.dryRun) {
    print('Dry run — nothing was sent.\n');
    return 0;
  }

  const confirm = options.yes ? alwaysYes : promptYes;
  if (!(await confirm(''))) {
    print('Aborted. Nothing was sent.');
    return 1;
  }

  const closer = new PairCloseService({
    shorts,
    spotSeller: swapService,
    readSpotBalanceAtoms: async () =>
      wallet.getPublicClient().readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }),
    journal,
    logger,
  });

  const result = await closer.close({
    tradeId: randomUUID(),
    symbol,
    spec,
    spot: {address: tokenAddress, decimals: token.decimals},
    quantity,
    chunks,
    intervalSeconds: config.twapIntervalSeconds,
    repriceSeconds: config.makerRepriceSeconds,
    maxAttempts: config.makerMaxAttempts,
    improveTicks,
    slippageBps: config.slippageBps,
  });

  print('');
  for (const chunk of result.chunks) {
    print(
      `  chunk ${chunk.chunk}: perp -${chunk.perpClosed} @ ${chunk.perpPrice ?? '?'}` +
        `  spot sold, proceeds ${chunk.spotProceeds} atoms  ${chunk.txHashes.join(', ')}`,
    );
  }
  print('');
  print(`  perp closed  ${result.perpClosed} ${symbol}`);
  print(`  spot sold    ${result.spotSoldAtoms} atoms`);
  if (result.stoppedBecause !== undefined) {
    print('');
    print(`  STOPPED: ${result.stoppedBecause}`);
  }
  const remaining = await closer.remainingShort(spec.market);
  print(`  still short  ${remaining} ${symbol}`);
  print('');

  logger.info({...result, remaining}, 'cli finished');
  return result.complete ? 0 : 1;
}

process.exitCode = await main();
