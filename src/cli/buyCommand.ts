/**
 * The buy command's logic, kept free of process/IO wiring so the confirmation
 * gate can be tested directly.
 *
 * Invariant: `executeBuy` is only ever reached after `confirm` resolves true.
 */

import type {Hex} from 'viem';
import type {BuyRequest, BuyResult} from '../arcus/types.js';
import type {Config} from '../config/config.js';

export interface BuyCommandDeps {
  readonly config: Config;
  readonly walletAddress: Hex;
  readonly tradeId: string;
  readonly sellSymbol: string;
  readonly buyService: {executeBuy(request: BuyRequest): Promise<BuyResult>};
  /** Resolves true only on explicit operator approval. */
  readonly confirm: (summary: string) => Promise<boolean>;
  readonly print: (line: string) => void;
}

export function buildSummary(
  config: Config,
  walletAddress: Hex,
  sellSymbol: string,
): string {
  const slippagePercent = config.slippageBps / 100;
  return [
    '',
    `About to spend ${config.usdgBuyAmount} ${sellSymbol} from ${walletAddress}`,
    `to buy ${config.stockTokenAddress}`,
    `on Robinhood Chain (${config.chainId}) via ${config.arcusRouterUrl}`,
    `slippage tolerance ${config.slippageBps} bps (${slippagePercent}%)`,
    '',
    'This is a PRODUCTION wallet holding real funds.',
    '',
  ].join('\n');
}

/** Returns the trade result, or undefined when the operator declined. */
export async function runBuyCommand(
  deps: BuyCommandDeps,
): Promise<BuyResult | undefined> {
  const summary = buildSummary(
    deps.config,
    deps.walletAddress,
    deps.sellSymbol,
  );

  if (!(await deps.confirm(summary))) {
    deps.print('Aborted. Nothing was signed or submitted.');
    return undefined;
  }

  const result = await deps.buyService.executeBuy({
    tradeId: deps.tradeId,
    buyToken: deps.config.stockTokenAddress,
    sellAmount: deps.config.usdgBuyAmount,
    slippageBps: deps.config.slippageBps,
  });

  deps.print(`Trade confirmed. tx ${result.txHash}`);
  deps.print(`  spent      ${result.sellAmount} atoms`);
  deps.print(`  received   ${result.buyAmount} atoms (quoted)`);
  deps.print(`  guaranteed ${result.minBuyAmount} atoms minimum`);
  return result;
}
