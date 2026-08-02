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

/** Token spent on every buy, and the counter-asset of the LP pool. */
const SELL_SYMBOL = 'USDG';

export interface Container {
  readonly logger: Logger;
  readonly wallet: WalletProvider;
  readonly swapService: SpotSwapService;
  /**
   * Async because token decimals are resolved from the Arcus router rather
   * than hard-coded.
   */
  createDepositService(): Promise<DepositService>;
  createMonitor(dryRun: boolean): Promise<PositionMonitor>;
  createExitService(): Promise<PositionExitService>;
  createPnlReporter(): Promise<PnlReporter>;
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

  /** Resolves USDG/stock token metadata and the live v3 pool together. */
  async function resolvePoolContext() {
    const [usdgToken, stockToken] = await Promise.all([
      tokens.bySymbol(SELL_SYMBOL),
      tokens.byAddress(config.stockTokenAddress),
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
      config.poolFee,
    );
    return {pool, usdg, stock};
  }

  async function createDepositService(): Promise<DepositService> {
    const {usdg, stock} = await resolvePoolContext();

    return new DepositService({
      wallet,
      poolReader: createPoolReader(wallet.getPublicClient()),
      logger,
      chainId: config.chainId,
      usdg,
      stock,
      rangeDeviationPercent: config.rangeDeviationPercent,
      poolFee: config.poolFee,
      lpSlippageBps: config.lpSlippageBps,
      mintDeadlineSeconds: config.mintDeadlineSeconds,
    });
  }

  async function createExitService(): Promise<PositionExitService> {
    const {pool, usdg, stock} = await resolvePoolContext();

    return new PositionExitService({
      wallet,
      feeReader: createFeeReader(wallet.getPublicClient()),
      swapService,
      logger,
      chainId: config.chainId,
      pool,
      usdg,
      stock,
      closeSlippageBps: config.closeSlippageBps,
      sellSlippageBps: config.slippageBps,
      deadlineSeconds: config.mintDeadlineSeconds,
    });
  }

  async function createMonitor(dryRun: boolean): Promise<PositionMonitor> {
    const {pool} = await resolvePoolContext();

    return new PositionMonitor({
      wallet,
      poolReader: createPoolReader(wallet.getPublicClient()),
      positionReader: createPositionReader(
        wallet.getPublicClient(),
        config.chainId,
      ),
      exitService: await createExitService(),
      logger,
      pool,
      checkIntervalSeconds: config.poolCheckIntervalSeconds,
      exitConfirmations: config.exitConfirmations,
      dryRun,
    });
  }

  async function createPnlReporter(): Promise<PnlReporter> {
    const {pool, usdg, stock} = await resolvePoolContext();

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
