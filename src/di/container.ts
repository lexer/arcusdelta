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
import {createPoolKey} from '../uniswap/poolKey.js';
import {createPoolReader} from '../uniswap/poolReader.js';
import {createFeeReader} from '../uniswap/feeReader.js';
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

  async function createDepositService(): Promise<DepositService> {
    const [usdgToken, stockToken] = await Promise.all([
      tokens.bySymbol(SELL_SYMBOL),
      tokens.byAddress(config.stockTokenAddress),
    ]);

    return new DepositService({
      wallet,
      poolReader: createPoolReader(wallet.getPublicClient(), config.chainId),
      logger,
      chainId: config.chainId,
      usdg: {
        address: usdgToken.address,
        symbol: usdgToken.symbol,
        decimals: usdgToken.decimals,
      },
      stock: {
        address: stockToken.address,
        symbol: stockToken.symbol,
        decimals: stockToken.decimals,
      },
      rangeDeviationPercent: config.rangeDeviationPercent,
      poolFee: config.poolFee,
      poolTickSpacing: config.poolTickSpacing,
      lpSlippageBps: config.lpSlippageBps,
      mintDeadlineSeconds: config.mintDeadlineSeconds,
    });
  }

  async function resolvePoolTokens() {
    const [usdgToken, stockToken] = await Promise.all([
      tokens.bySymbol(SELL_SYMBOL),
      tokens.byAddress(config.stockTokenAddress),
    ]);
    return {
      poolKey: createPoolKey(
        usdgToken.address,
        stockToken.address,
        config.poolFee,
        config.poolTickSpacing,
      ),
      usdg: {
        address: usdgToken.address,
        symbol: usdgToken.symbol,
        decimals: usdgToken.decimals,
      },
      stock: {
        address: stockToken.address,
        symbol: stockToken.symbol,
        decimals: stockToken.decimals,
      },
    };
  }

  async function createExitService(): Promise<PositionExitService> {
    const {poolKey, usdg, stock} = await resolvePoolTokens();

    return new PositionExitService({
      wallet,
      feeReader: createFeeReader(wallet.getPublicClient(), config.chainId),
      swapService,
      logger,
      chainId: config.chainId,
      poolKey,
      usdg,
      stock,
      closeSlippageBps: config.closeSlippageBps,
      sellSlippageBps: config.slippageBps,
      deadlineSeconds: config.mintDeadlineSeconds,
    });
  }

  async function createMonitor(dryRun: boolean): Promise<PositionMonitor> {
    const {poolKey} = await resolvePoolTokens();

    return new PositionMonitor({
      wallet,
      poolReader: createPoolReader(wallet.getPublicClient(), config.chainId),
      positionReader: createPositionReader(
        wallet.getPublicClient(),
        config.chainId,
        config.positionLookbackBlocks,
        logger,
      ),
      exitService: await createExitService(),
      logger,
      poolKey,
      checkIntervalSeconds: config.poolCheckIntervalSeconds,
      exitConfirmations: config.exitConfirmations,
      dryRun,
    });
  }

  async function createPnlReporter(): Promise<PnlReporter> {
    const [usdgToken, stockToken] = await Promise.all([
      tokens.bySymbol(SELL_SYMBOL),
      tokens.byAddress(config.stockTokenAddress),
    ]);

    return new PnlReporter({
      publicClient: wallet.getPublicClient(),
      poolReader: createPoolReader(wallet.getPublicClient(), config.chainId),
      positionReader: createPositionReader(
        wallet.getPublicClient(),
        config.chainId,
        config.positionLookbackBlocks,
        logger,
      ),
      feeReader: createFeeReader(wallet.getPublicClient(), config.chainId),
      logger,
      chainId: config.chainId,
      poolKey: createPoolKey(
        usdgToken.address,
        stockToken.address,
        config.poolFee,
        config.poolTickSpacing,
      ),
      usdg: {
        address: usdgToken.address,
        symbol: usdgToken.symbol,
        decimals: usdgToken.decimals,
      },
      stock: {
        address: stockToken.address,
        symbol: stockToken.symbol,
        decimals: stockToken.decimals,
      },
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
