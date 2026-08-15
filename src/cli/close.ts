/**
 * Entrypoint for `npm run close` — unwinds delta-neutral pairs.
 *
 * Defaults to every symbol in `symbols.json` that currently has a pair this
 * bot manages; `--symbol` narrows to one. Symbols with no open short are
 * skipped, and positions that fail the ownership check are reported rather
 * than touched.
 *
 * Chunked, and perp-first within every chunk: a reduce-only post-only buy-back
 * followed by a spot sell of the same size, so delta returns to flat at each
 * step rather than only at the end.
 *
 * Fund-moving, so it plans every symbol first, shows the whole thing, and
 * takes one explicit confirmation before anything is signed.
 */

import {randomUUID} from 'node:crypto';
import {Command} from 'commander';
import {erc20Abi, formatUnits, type Hex} from 'viem';
import {loadConfig, loggableConfig} from '../config/config.js';
import type {SymbolConfig} from '../config/symbols.js';
import {createContainer, type Container} from '../di/container.js';
import {createJournal} from '../di/observability.js';
import {PairCloseService, splitQuantity} from '../delta/pairCloseService.js';
import {ArcusPerpsClient} from '../perps/arcusPerpsClient.js';
import {AuthenticatedPerpsClient} from '../perps/authenticatedPerpsClient.js';
import {absDecimals} from '../perps/decimal.js';
import {MakerOrderExecutor} from '../perps/makerOrderExecutor.js';
import {MarketRegistry} from '../perps/marketRegistry.js';
import {isManagedPair, PerpsShortService} from '../perps/perpsShortService.js';
import {PerpsRequestSigner} from '../perps/signing.js';
import type {MarketSpec, PerpPosition} from '../perps/types.js';
import {alwaysYes, print, promptYes} from './prompt.js';
import {loadSelectedSymbols} from './symbolSelection.js';

/** One symbol ready to unwind, with everything already resolved. */
interface ClosePlan {
  readonly settings: SymbolConfig;
  readonly spec: MarketSpec;
  readonly position: PerpPosition;
  readonly tokenAddress: Hex;
  readonly decimals: number;
  readonly spotBalance: string;
  readonly quantity: string;
  readonly chunks: number;
  readonly pieces: readonly string[];
}

function readBalance(
  container: Container,
  token: Hex,
  owner: Hex,
): Promise<bigint> {
  return container.wallet.getPublicClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
}

async function main(): Promise<number> {
  const program = new Command()
    .name('close')
    .description('Unwind delta-neutral pairs, perp first, in chunks')
    .option(
      '--symbol <ticker>',
      'close only this symbol (default: every configured pair that is open)',
    )
    .option('--chunks <n>', 'override the chunk count')
    .option('--quantity <n>', 'close only this much; requires --symbol')
    .option('--improve-ticks <n>', 'post this many ticks in front of the touch')
    .option('-y, --yes', 'skip the confirmation')
    .option('--dry-run', 'show the plan and stop')
    .parse(process.argv);
  const options = program.opts<{
    symbol?: string;
    chunks?: string;
    quantity?: string;
    improveTicks?: string;
    yes?: boolean;
    dryRun?: boolean;
  }>();

  if (options.quantity !== undefined && options.symbol === undefined) {
    process.stderr.write(
      '--quantity applies to one position, so it needs --symbol too.\n',
    );
    return 1;
  }

  const config = loadConfig();
  if (config.arcusApiPrivateKey === undefined) {
    process.stderr.write(
      'ARCUS_API_PRIVATE_KEY is not set — run `npm run apikey` first.\n',
    );
    return 1;
  }

  const container = createContainer(config);
  const {logger, wallet} = container;
  const journal = createJournal(config, options.dryRun === true);
  const address = wallet.getAccount().address;

  const symbols = loadSelectedSymbols(config, options.symbol);
  logger.info(
    {
      command: 'close',
      symbols: symbols.map(s => s.symbol),
      dryRun: options.dryRun === true,
      ...loggableConfig(config),
    },
    'cli started',
  );

  const reader = new ArcusPerpsClient({baseUrl: config.arcusApiUrl, logger});
  const client = new AuthenticatedPerpsClient({
    baseUrl: config.arcusApiUrl,
    logger,
    signer: new PerpsRequestSigner(config.arcusApiPrivateKey),
    address,
    accountIndex: config.arcusAccountIndex,
  });
  const registry = new MarketRegistry(reader);
  const shorts = new PerpsShortService({
    client,
    marketData: reader,
    executor: new MakerOrderExecutor({
      client,
      marketData: reader,
      journal,
      logger,
    }),
    journal,
    logger,
    address,
    accountIndex: config.arcusAccountIndex,
  });

  const improveTicks = options.improveTicks
    ? Number(options.improveTicks)
    : config.makerImproveTicks;

  const plans: ClosePlan[] = [];
  const skipped: string[] = [];

  for (const settings of symbols) {
    const spec = await registry.byBaseAsset(settings.symbol);
    const position = await shorts.positionFor(spec.market);
    if (position === undefined || position.side !== 'SHORT') {
      skipped.push(`${settings.symbol}: no short position open`);
      continue;
    }

    const token = await container.tokens.bySymbol(settings.symbol);
    const tokenAddress = token.address as Hex;
    const spotBalance = formatUnits(
      await readBalance(container, tokenAddress, address),
      token.decimals,
    );

    // The same guard the monitor uses: only unwind what this strategy owns.
    if (!isManagedPair(position, spotBalance, config.maxDeltaBps)) {
      skipped.push(
        `${settings.symbol}: ${position.side} ${position.size} against ` +
          `${spotBalance} spot — not a pair this bot manages`,
      );
      continue;
    }

    const quantity = options.quantity ?? absDecimals(position.size);
    const chunks = options.chunks
      ? Number(options.chunks)
      : settings.twapChunks;
    plans.push({
      settings,
      spec,
      position,
      tokenAddress,
      decimals: token.decimals,
      spotBalance,
      quantity,
      chunks,
      pieces: splitQuantity(quantity, chunks, spec.stepSize),
    });
  }

  print('');
  for (const line of skipped) print(`  skipping ${line}`);
  if (plans.length === 0) {
    if (skipped.length === 0) print('  Nothing to close.');
    print('');
    return 0;
  }

  print(`About to UNWIND ${plans.length} pair(s) from ${address}`);
  print('');
  for (const plan of plans) {
    const ticker = plan.settings.symbol;
    print(`  ${ticker}  ${plan.quantity} ${ticker}`);
    print(
      `    perp     SHORT ${plan.position.size} @ ${plan.position.averageEntryPrice}` +
        `  |  spot ${plan.spotBalance}`,
    );
    print(
      `    chunks   ${plan.pieces.length} x ~${plan.pieces[0]}, ` +
        `${plan.settings.twapIntervalSeconds}s between completed chunks`,
    );
    print(
      `    maker    reduce-only POST-ONLY, ${config.makerMaxAttempts} x ` +
        `${config.makerRepriceSeconds}s, ${improveTicks} tick(s) in front`,
    );
    print(`    spot     ${plan.settings.slippageBps} bps slippage`);
  }
  print('');
  print('Each chunk buys the perp back first, waits for that maker order to');
  print('fill, sells the matching spot, and only then pauses before the next');
  print('chunk. Maker only: a chunk that will not fill stops that symbol');
  print('rather than crossing the spread.');
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

  let failures = 0;
  for (const plan of plans) {
    const closer = new PairCloseService({
      shorts,
      spotSeller: container.swapService,
      readSpotBalanceAtoms: () =>
        readBalance(container, plan.tokenAddress, address),
      journal,
      logger,
    });

    const result = await closer.close({
      tradeId: randomUUID(),
      symbol: plan.settings.symbol,
      spec: plan.spec,
      spot: {address: plan.tokenAddress, decimals: plan.decimals},
      quantity: plan.quantity,
      chunks: plan.chunks,
      intervalSeconds: plan.settings.twapIntervalSeconds,
      repriceSeconds: config.makerRepriceSeconds,
      maxAttempts: config.makerMaxAttempts,
      improveTicks,
      slippageBps: plan.settings.slippageBps,
    });

    print('');
    print(`  ${plan.settings.symbol}`);
    for (const chunk of result.chunks) {
      print(
        `    chunk ${chunk.chunk}: perp -${chunk.perpClosed} @ ` +
          `${chunk.perpPrice ?? '?'}  spot ${chunk.txHashes.join(', ')}`,
      );
    }
    print(`    perp closed ${result.perpClosed}`);
    if (result.stoppedBecause !== undefined) {
      print(`    STOPPED: ${result.stoppedBecause}`);
    }
    print(`    still short ${await closer.remainingShort(plan.spec.market)}`);

    if (!result.complete) failures++;
    // `result` already carries the symbol.
    logger.info({...result}, 'symbol unwound');
  }

  print('');
  logger.info({planned: plans.length, failures}, 'cli finished');
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
