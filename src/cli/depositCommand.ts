/**
 * The deposit command's logic, kept free of process/IO wiring so the
 * confirmation gate can be tested directly.
 *
 * Invariant: `execute` is only ever reached after `confirm` resolves true.
 */

import {formatUnits} from 'viem';
import type {
  DepositPlan,
  DepositResult,
  TokenMeta,
} from '../uniswap/depositService.js';

export interface DepositCommandDeps {
  readonly usdg: TokenMeta;
  readonly stock: TokenMeta;
  readonly rangeDeviationPercent: number;
  readonly depositService: {
    plan(): Promise<DepositPlan>;
    execute(plan: DepositPlan): Promise<DepositResult>;
  };
  /** Resolves true only on explicit operator approval. */
  readonly confirm: (summary: string) => Promise<boolean>;
  readonly print: (line: string) => void;
}

/** Price of one stock token in USDG at a given tick, for human display. */
function priceAtTick(tick: number, usdg: TokenMeta, stock: TokenMeta): string {
  // p = 1.0001^tick is token1 per token0 in atoms; USDG is token0.
  const rawPrice = 1.0001 ** tick;
  const adjusted = rawPrice * 10 ** (usdg.decimals - stock.decimals);
  if (!Number.isFinite(adjusted) || adjusted === 0) return 'n/a';
  return (1 / adjusted).toFixed(4);
}

export function buildDepositSummary(
  plan: DepositPlan,
  deps: DepositCommandDeps,
): string {
  const {usdg, stock} = deps;
  return [
    '',
    `About to open a Uniswap v3 liquidity position in ${usdg.symbol}/${stock.symbol}`,
    '',
    `  deposit      ${formatUnits(plan.stockAmount, stock.decimals)} ${stock.symbol}`,
    `  deposit      ${formatUnits(plan.usdgAmount, usdg.decimals)} ${usdg.symbol}`,
    `  max pull     ${formatUnits(plan.amount0Desired, usdg.decimals)} ${usdg.symbol} / ${formatUnits(plan.amount1Desired, stock.decimals)} ${stock.symbol}`,
    `  min accepted ${formatUnits(plan.amount0Min, usdg.decimals)} ${usdg.symbol} / ${formatUnits(plan.amount1Min, stock.decimals)} ${stock.symbol}`,
    `  range        ticks ${plan.tickLower} to ${plan.tickUpper} (±${deps.rangeDeviationPercent}%)`,
    `  price band   ${priceAtTick(plan.tickUpper, usdg, stock)} to ${priceAtTick(plan.tickLower, usdg, stock)} ${usdg.symbol} per ${stock.symbol}`,
    `  pool price   ${priceAtTick(plan.currentTick, usdg, stock)} ${usdg.symbol} per ${stock.symbol} (tick ${plan.currentTick})`,
    `  liquidity    ${plan.liquidity}`,
    '',
    'This is a PRODUCTION wallet holding real funds.',
    '',
  ].join('\n');
}

/** Returns the deposit result, or undefined when the operator declined. */
export async function runDepositCommand(
  deps: DepositCommandDeps,
): Promise<DepositResult | undefined> {
  const plan = await deps.depositService.plan();

  if (!(await deps.confirm(buildDepositSummary(plan, deps)))) {
    deps.print('Aborted. No position was opened.');
    return undefined;
  }

  const result = await deps.depositService.execute(plan);

  deps.print(`Position opened. tx ${result.hash}`);
  if (result.tokenId !== undefined) {
    deps.print(`  position NFT #${result.tokenId}`);
  }
  for (const hash of result.approvalHashes) {
    deps.print(`  approval tx  ${hash}`);
  }
  return result;
}
