/**
 * The exit command's logic, free of process/IO wiring so the confirmation gate
 * is testable.
 *
 * Invariant: `exit` is only reached after `confirm` resolves true.
 */

import {formatUnits} from 'viem';
import type {TokenMeta} from '../uniswap/depositService.js';
import type {ExitPlan, ExitResult} from '../uniswap/positionExitService.js';
import type {OwnedPosition} from '../uniswap/positionReader.js';

export interface ExitCommandDeps {
  readonly usdg: TokenMeta;
  readonly stock: TokenMeta;
  readonly positions: readonly OwnedPosition[];
  readonly sqrtPriceX96: bigint;
  readonly exitService: {
    plan(position: OwnedPosition, sqrtPriceX96: bigint): Promise<ExitPlan>;
    exit(plan: ExitPlan): Promise<ExitResult>;
  };
  /** Resolves true only on explicit operator approval. */
  readonly confirm: (summary: string) => Promise<boolean>;
  readonly print: (line: string) => void;
  /** Report what would happen and stop. */
  readonly dryRun: boolean;
}

export function buildExitSummary(
  plans: readonly ExitPlan[],
  deps: ExitCommandDeps,
): string {
  const {usdg, stock} = deps;
  const lines = [
    '',
    `About to withdraw ${plans.length} liquidity position${plans.length === 1 ? '' : 's'}, claim fees,`,
    `and sell the resulting ${stock.symbol} back to ${usdg.symbol} on Arcus.`,
    '',
  ];

  for (const plan of plans) {
    lines.push(
      `  #${plan.position.tokenId}  ticks [${plan.position.tickLower}, ${plan.position.tickUpper}]`,
      `    principal  ${formatUnits(plan.principalUsdg, usdg.decimals)} ${usdg.symbol} + ${formatUnits(plan.principalStock, stock.decimals)} ${stock.symbol}`,
      `    fees       ${formatUnits(plan.fees0, usdg.decimals)} ${usdg.symbol} + ${formatUnits(plan.fees1, stock.decimals)} ${stock.symbol}`,
      `    at least   ${formatUnits(plan.amount0Min, usdg.decimals)} ${usdg.symbol} + ${formatUnits(plan.amount1Min, stock.decimals)} ${stock.symbol}`,
    );
  }

  lines.push('', 'This is a PRODUCTION wallet holding real funds.', '');
  return lines.join('\n');
}

/** Returns the exits performed, or undefined when the operator declined. */
export async function runExitCommand(
  deps: ExitCommandDeps,
): Promise<ExitResult[] | undefined> {
  if (deps.positions.length === 0) {
    deps.print('No open positions in the configured pool. Nothing to exit.');
    return [];
  }

  const plans = await Promise.all(
    deps.positions.map(position =>
      deps.exitService.plan(position, deps.sqrtPriceX96),
    ),
  );

  const summary = buildExitSummary(plans, deps);

  if (deps.dryRun) {
    deps.print(summary);
    deps.print('  Dry run. Nothing was withdrawn or sold.');
    return undefined;
  }

  if (!(await deps.confirm(summary))) {
    deps.print('Aborted. Nothing was withdrawn.');
    return undefined;
  }

  const results: ExitResult[] = [];
  for (const plan of plans) {
    const result = await deps.exitService.exit(plan);
    results.push(result);

    deps.print(`Position #${result.tokenId} closed. tx ${result.closeHash}`);
    if (result.stockSold === 0n) {
      deps.print(`  no ${deps.stock.symbol} to sell`);
      continue;
    }
    deps.print(
      `  sold ${formatUnits(result.stockSold, deps.stock.decimals)} ${deps.stock.symbol}  tx ${result.saleTxHash}`,
    );
    if (result.usdgReceived !== undefined) {
      deps.print(
        `  received ${formatUnits(BigInt(result.usdgReceived), deps.usdg.decimals)} ${deps.usdg.symbol}`,
      );
    }
  }
  return results;
}
