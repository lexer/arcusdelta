/**
 * Composition root.
 *
 * The only place concrete implementations are constructed and wired together.
 * Every other module takes its dependencies as constructor parameters, so this
 * file is the single thing a test has to bypass.
 */

import {SpotRouterClient} from '@arcus-xyz/arcus-spot-sdk';
import {SpotSwapService} from '../arcus/spotSwapService.js';
import {TokenResolver} from '../arcus/tokenResolver.js';
import {createRobinhoodChain} from '../chain/robinhoodChain.js';
import {createWalletProvider} from '../chain/walletProvider.js';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {Config} from '../config/config.js';
import type {SymbolConfig} from '../config/symbols.js';
import {createLogger} from '../logging/logger.js';
import type {Logger} from '../logging/logger.js';
import {PnlReporter} from '../pnl/pnlReporter.js';
import {DepositService} from '../uniswap/depositService.js';
import {createFeeReader} from '../uniswap/feeReader.js';
import {resolvePoolIdentity} from '../uniswap/poolAddress.js';
import {createPoolReader} from '../uniswap/poolReader.js';
import {PositionExitService} from '../uniswap/positionExitService.js';
import {PositionMonitor} from '../uniswap/positionMonitor.js';
import {createPositionReader} from '../uniswap/positionReader.js';
import type {WatchedSymbol} from '../uniswap/positionMonitor.js';

/** Token spent on every buy, and the counter-asset of every LP pool. */
const SELL_SYMBOL = 'USDG';

export interface Container {
  readonly logger: Logger;
  readonly wallet: WalletProvider;
  readonly swapService: SpotSwapService;
  /**
   * Async because token decimals are resolved from the Arcus router rather
   * than hard-coded. Each takes the specific symbol it operates on — there is
   * no longer a single implicit stock token.
   */
  createDepositService(symbol: SymbolConfig): Promise<DepositService>;
  createExitService(symbol: SymbolConfig): Promise<PositionExitService>;
  /** Builds one monitor watching every symbol in `symbols` at once. */
  createMonitor(
    symbols: readonly SymbolConfig[],
    dryRun: boolean,
  ): Promise<PositionMonitor>;
  createPnlReporter(symbol: SymbolConfig): Promise<PnlReporter>;
}

export function createContainer(config: Config): Container {
  const logger = createLogger();
  const chain = createRobinhoodChain(config.rpcUrl, config.chainId);
  const wallet = createWalletProvider(config.seed, chain, config.rpcUrl);
  const router = new SpotRouterClient({baseUrl: config.arcusRouterUrl});
  const tokens = new TokenResolver(router, config.chainId);

  const swapService = new SpotSwapService({
    router,
    wallet,
    tokens,
    logger,
    chainId: config.chainId,
    sellSymbol: SELL_SYMBOL,
  });

  /** Resolves USDG/stock token metadata and the live v3 pool for one symbol. */
  async function resolvePoolContext(symbol: SymbolConfig) {
    const [usdgToken, stockToken] = await Promise.all([
      tokens.bySymbol(SELL_SYMBOL),
      tokens.byAddress(symbol.stockTokenAddress),
    ]);
    const usdg = {
      address: usdgToken.address,
      symbol: usdgToken.symbol,
      decimals: usdgToken.decimals,
    };
    const stock = {
      address: stockToken.address,
      symbol: stockToken.symbol,
      decimals: stockToken.decimals,
    };
    const pool = await resolvePoolIdentity(
      wallet.getPublicClient(),
      config.chainId,
      usdg.address,
      stock.address,
      symbol.poolFee,
    );
    return {pool, usdg, stock};
  }

  async function createDepositService(
    symbol: SymbolConfig,
  ): Promise<DepositService> {
    const {usdg, stock} = await resolvePoolContext(symbol);

    return new DepositService({
      wallet,
      poolReader: createPoolReader(wallet.getPublicClient()),
      logger,
      chainId: config.chainId,
      usdg,
      stock,
      rangeDeviationPercent: symbol.rangeDeviationPercent,
      poolFee: symbol.poolFee,
      lpSlippageBps: symbol.lpSlippageBps,
      mintDeadlineSeconds: symbol.mintDeadlineSeconds,
    });
  }

  async function createExitService(
    symbol: SymbolConfig,
  ): Promise<PositionExitService> {
    const {pool, usdg, stock} = await resolvePoolContext(symbol);

    return new PositionExitService({
      wallet,
      feeReader: createFeeReader(wallet.getPublicClient()),
      swapService,
      logger,
      chainId: config.chainId,
      pool,
      usdg,
      stock,
      closeSlippageBps: symbol.closeSlippageBps,
      sellSlippageBps: symbol.slippageBps,
      deadlineSeconds: symbol.mintDeadlineSeconds,
      twapChunks: symbol.twapChunks,
      twapIntervalSeconds: symbol.twapIntervalSeconds,
    });
  }

  async function createMonitor(
    symbols: readonly SymbolConfig[],
    dryRun: boolean,
  ): Promise<PositionMonitor> {
    const watchedSymbols: WatchedSymbol[] = await Promise.all(
      symbols.map(async symbol => {
        const {pool} = await resolvePoolContext(symbol);
        return {
          symbol: symbol.symbol,
          pool,
          exitService: await createExitService(symbol),
          checkIntervalSeconds: symbol.poolCheckIntervalSeconds,
          exitConfirmations: symbol.exitConfirmations,
        };
      }),
    );

    return new PositionMonitor({
      wallet,
      poolReader: createPoolReader(wallet.getPublicClient()),
      positionReader: createPositionReader(
        wallet.getPublicClient(),
        config.chainId,
      ),
      watchedSymbols,
      logger,
      dryRun,
    });
  }

  async function createPnlReporter(symbol: SymbolConfig): Promise<PnlReporter> {
    const {pool, usdg, stock} = await resolvePoolContext(symbol);

    return new PnlReporter({
      publicClient: wallet.getPublicClient(),
      poolReader: createPoolReader(wallet.getPublicClient()),
      positionReader: createPositionReader(
        wallet.getPublicClient(),
        config.chainId,
      ),
      feeReader: createFeeReader(wallet.getPublicClient()),
      logger,
      chainId: config.chainId,
      pool,
      usdg,
      stock,
    });
  }

  return {
    logger,
    wallet,
    swapService,
    createDepositService,
    createMonitor,
    createExitService,
    createPnlReporter,
  };
}

export {SELL_SYMBOL};
