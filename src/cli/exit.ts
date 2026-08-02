/**
 * Entrypoint for `npm run exit` — manually withdraw from the pool, claim fees,
 * and sell the stock token back to USDG on Arcus, for every configured
 * symbol (or just `--symbol`).
 *
 * The same flow the monitor runs automatically when a position goes
 * one-sided, triggered by hand and gated on a single confirmation covering
 * every symbol's positions.
 */

import {Command} from 'commander';
import {loadConfig, loggableConfig} from '../config/config.js';
import {createContainer} from '../di/container.js';
import {createPoolReader} from '../uniswap/poolReader.js';
import {createPositionReader} from '../uniswap/positionReader.js';
import {runExitCommand, type ExitRequestItem} from './exitCommand.js';
import {alwaysYes, print, promptYes} from './prompt.js';
import {loadSelectedSymbols} from './symbolSelection.js';

async function main(): Promise<number> {
  const program = new Command()
    .name('exit')
    .description(
      'Withdraw liquidity, claim fees, and sell the stock token back to USDG',
    )
    .option('-y, --yes', 'skip the interactive confirmation')
    .option('--dry-run', 'report what would happen without sending anything')
    .option('--symbol <ticker>', 'act on only this configured symbol')
    .option(
      '--token-id <id>',
      'exit only this position (requires --symbol, since a token id alone does not say which pool it is in)',
    )
    .parse(process.argv);
  const options = program.opts<{
    yes?: boolean;
    dryRun?: boolean;
    symbol?: string;
    tokenId?: string;
  }>();

  const config = loadConfig();
  const symbols = loadSelectedSymbols(config, options.symbol);
  const container = createContainer(config);
  const {logger, wallet} = container;
  const startedAt = Date.now();
  const owner = wallet.getAccount().address;

  logger.info(
    {
      command: 'exit',
      dryRun: options.dryRun === true,
      symbols: symbols.map(s => s.symbol),
      ...loggableConfig(config),
    },
    'cli started',
  );
  logger.info({walletAddress: owner}, 'wallet derived');

  if (options.tokenId !== undefined && symbols.length !== 1) {
    const message =
      '--token-id requires exactly one symbol; pass --symbol too.';
    logger.error({tokenId: options.tokenId}, message);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  try {
    const poolReader = createPoolReader(wallet.getPublicClient());
    const positionReader = createPositionReader(
      wallet.getPublicClient(),
      config.chainId,
    );

    const items: ExitRequestItem[] = [];
    for (const s of symbols) {
      const exitService = await container.createExitService(s);
      const {usdg, stock} = exitService.tokens;
      const pool = exitService.pool;

      const [poolState, positions] = await Promise.all([
        poolReader.readState(pool),
        options.tokenId
          ? positionReader
              .read(BigInt(options.tokenId), pool, owner)
              .then(p => (p ? [p] : []))
          : positionReader.discover(pool, owner),
      ]);

      if (options.tokenId && positions.length === 0) {
        logger.error(
          {symbol: s.symbol, tokenId: options.tokenId},
          'requested position is not an open position of this wallet in this pool',
        );
        process.stderr.write(
          `Position ${options.tokenId} is not an open position of this wallet in the ${s.symbol} pool.\n`,
        );
        return 1;
      }

      items.push({
        symbol: s.symbol,
        usdg,
        stock,
        positions,
        sqrtPriceX96: poolState.sqrtPriceX96,
        exitService,
      });
    }

    const results = await runExitCommand({
      items,
      confirm: options.yes ? alwaysYes : promptYes,
      print,
      dryRun: options.dryRun === true,
    });

    const outcome = results === undefined ? 'aborted' : 'exited';
    logger.info(
      {
        outcome,
        exited: results?.filter(r => r.result !== undefined).length ?? 0,
        elapsedMs: Date.now() - startedAt,
      },
      'cli finished',
    );
    return results === undefined ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      {error: message, elapsedMs: Date.now() - startedAt},
      'cli failed',
    );
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = await main();
