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
import type {ExecutionJournal} from '../journal/executionJournal.js';
import type {Logger} from '../logging/logger.js';
import {createRobinhoodPriceFeed} from '../prices/robinhoodPriceFeed.js';
import {createJournal, createRunLogger} from './observability.js';

/** Token spent acquiring every spot leg, and the perps settlement asset. */
const SELL_SYMBOL = 'USDG';

export interface Container {
  readonly logger: Logger;
  /** Durable record of every fill and funding payment. */
  readonly journal: ExecutionJournal;
  /** Token metadata from the Arcus router, shared and cached. */
  readonly tokens: TokenResolver;
  readonly wallet: WalletProvider;
  readonly swapService: SpotSwapService;
}

export function createContainer(config: Config): Container {
  const logger = createRunLogger(config);
  const journal = createJournal(config);
  const chain = createRobinhoodChain(config.rpcUrl, config.chainId);
  const wallet = createWalletProvider(config.seed, chain, config.rpcUrl);
  const router = new SpotRouterClient({baseUrl: config.arcusRouterUrl});
  const tokens = new TokenResolver(router, config.chainId);
  const priceFeed = createRobinhoodPriceFeed();

  const swapService = new SpotSwapService({
    router,
    wallet,
    tokens,
    logger,
    chainId: config.chainId,
    sellSymbol: SELL_SYMBOL,
    priceFeed,
  });

  return {
    logger,
    journal,
    tokens,
    wallet,
    swapService,
  };
}

export {SELL_SYMBOL};
