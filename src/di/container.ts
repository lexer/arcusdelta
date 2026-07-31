/**
 * Composition root.
 *
 * The only place concrete implementations are constructed and wired together.
 * Every other module takes its dependencies as constructor parameters, so this
 * file is the single thing a test has to bypass.
 */

import {SpotRouterClient} from '@arcus-xyz/arcus-spot-sdk';
import {SpotBuyService} from '../arcus/spotBuyService.js';
import {TokenResolver} from '../arcus/tokenResolver.js';
import {createRobinhoodChain} from '../chain/robinhoodChain.js';
import {createWalletProvider} from '../chain/walletProvider.js';
import type {WalletProvider} from '../chain/walletProvider.js';
import type {Config} from '../config/config.js';
import {createLogger} from '../logging/logger.js';
import type {Logger} from '../logging/logger.js';

/** Token spent on every buy. */
const SELL_SYMBOL = 'USDG';

export interface Container {
  readonly logger: Logger;
  readonly wallet: WalletProvider;
  readonly buyService: SpotBuyService;
}

export function createContainer(config: Config): Container {
  const logger = createLogger();
  const chain = createRobinhoodChain(config.rpcUrl, config.chainId);
  const wallet = createWalletProvider(config.seed, chain, config.rpcUrl);
  const router = new SpotRouterClient({baseUrl: config.arcusRouterUrl});
  const tokens = new TokenResolver(router, config.chainId);

  const buyService = new SpotBuyService({
    router,
    wallet,
    tokens,
    logger,
    chainId: config.chainId,
    sellSymbol: SELL_SYMBOL,
  });

  return {logger, wallet, buyService};
}

export {SELL_SYMBOL};
