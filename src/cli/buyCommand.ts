/**
 * The buy command's logic, kept free of process/IO wiring so the confirmation
 * gate can be tested directly.
 *
 * Invariant: `executeBuy` is only ever reached after `confirm` resolves true,
 * and only once, covering every selected symbol.
 */

import type {Hex} from 'viem';
import type {BuyRequest, BuyResult} from '../arcus/types.js';

/** One symbol's buy request. Independent of every other symbol's. */
export interface BuyRequestItem {
  readonly symbol: string;
  readonly stockTokenAddress: Hex;
  readonly usdgBuyAmount: string;
  readonly slippageBps: number;
}

/** Per-symbol outcome. Exactly one of `result`/`error` is set. */
export interface BuyOutcome {
  readonly symbol: string;
  readonly result?: BuyResult;
  readonly error?: string;
}

export interface BuyCommandDeps {
  readonly items: readonly BuyRequestItem[];
  readonly walletAddress: Hex;
  readonly chainId: number;
  readonly arcusRouterUrl: string;
  readonly sellSymbol: string;
  readonly buyService: {executeBuy(request: BuyRequest): Promise<BuyResult>};
  /** Resolves true only on explicit operator approval, covering the whole batch. */
  readonly confirm: (summary: string) => Promise<boolean>;
  readonly print: (line: string) => void;
  /** One fresh id per buy, so each Arcus trade is independently traceable. */
  readonly newTradeId: () => string;
}

export function buildBuySummary(
  items: readonly BuyRequestItem[],
  deps: Pick<
    BuyCommandDeps,
    'walletAddress' | 'chainId' | 'arcusRouterUrl' | 'sellSymbol'
  >,
): string {
  const lines = [
    '',
    `About to buy ${items.length} symbol${items.length === 1 ? '' : 's'} from ${deps.walletAddress}`,
    `on Robinhood Chain (${deps.chainId}) via ${deps.arcusRouterUrl}`,
    '',
  ];

  for (const item of items) {
    lines.push(
      `  ${item.symbol}  spend ${item.usdgBuyAmount} ${deps.sellSymbol} -> ${item.stockTokenAddress}  slippage ${item.slippageBps} bps`,
    );
  }

  lines.push('', 'This is a PRODUCTION wallet holding real funds.', '');
  return lines.join('\n');
}

/**
 * Returns one outcome per selected symbol, or undefined when the operator
 * declined the whole batch. A failure on one symbol does not stop the rest —
 * each buy is an independent Arcus trade with no cross-dependency, so losing
 * track of the ones that already succeeded would be worse than continuing.
 */
export async function runBuyCommand(
  deps: BuyCommandDeps,
): Promise<BuyOutcome[] | undefined> {
  if (deps.items.length === 0) {
    deps.print('No symbols selected to buy.');
    return [];
  }

  const summary = buildBuySummary(deps.items, deps);

  if (!(await deps.confirm(summary))) {
    deps.print('Aborted. Nothing was signed or submitted.');
    return undefined;
  }

  const outcomes: BuyOutcome[] = [];
  for (const item of deps.items) {
    try {
      const result = await deps.buyService.executeBuy({
        tradeId: deps.newTradeId(),
        buyToken: item.stockTokenAddress,
        sellAmount: item.usdgBuyAmount,
        slippageBps: item.slippageBps,
      });
      outcomes.push({symbol: item.symbol, result});

      deps.print(`${item.symbol}: trade confirmed. tx ${result.txHash}`);
      deps.print(`  spent      ${result.sellAmount} atoms`);
      deps.print(`  received   ${result.buyAmount} atoms (quoted)`);
      deps.print(`  guaranteed ${result.minBuyAmount} atoms minimum`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({symbol: item.symbol, error: message});
      deps.print(`${item.symbol}: buy failed — ${message}`);
    }
  }
  return outcomes;
}
