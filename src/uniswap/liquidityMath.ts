/**
 * Conversions between liquidity and token amounts for a concentrated range.
 *
 * A port of the LiquidityAmounts library. All arithmetic is integer, matching
 * the on-chain rounding: liquidity from amounts rounds down (never claim more
 * liquidity than the tokens support), amounts from liquidity round up (never
 * understate what the mint will pull).
 */

const Q96 = 2n ** 96n;

function ordered(a: bigint, b: bigint): [bigint, bigint] {
  return a <= b ? [a, b] : [b, a];
}

function divRoundingUp(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

/** Liquidity supported by `amount0` across the range. Rounds down. */
export function getLiquidityForAmount0(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
): bigint {
  const [lower, upper] = ordered(sqrtRatioAX96, sqrtRatioBX96);
  if (upper === lower) return 0n;
  const intermediate = (lower * upper) / Q96;
  return (amount0 * intermediate) / (upper - lower);
}

/** Liquidity supported by `amount1` across the range. Rounds down. */
export function getLiquidityForAmount1(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount1: bigint,
): bigint {
  const [lower, upper] = ordered(sqrtRatioAX96, sqrtRatioBX96);
  if (upper === lower) return 0n;
  return (amount1 * Q96) / (upper - lower);
}

/** Liquidity that both amounts can support at the current price. */
export function getLiquidityForAmounts(
  sqrtRatioX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const [lower, upper] = ordered(sqrtRatioAX96, sqrtRatioBX96);

  if (sqrtRatioX96 <= lower) {
    return getLiquidityForAmount0(lower, upper, amount0);
  }
  if (sqrtRatioX96 < upper) {
    const liquidity0 = getLiquidityForAmount0(sqrtRatioX96, upper, amount0);
    const liquidity1 = getLiquidityForAmount1(lower, sqrtRatioX96, amount1);
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return getLiquidityForAmount1(lower, upper, amount1);
}

/** Amount of token0 that `liquidity` requires across the range. Rounds up. */
export function getAmount0ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  const [lower, upper] = ordered(sqrtRatioAX96, sqrtRatioBX96);
  if (upper === lower) return 0n;
  return divRoundingUp((liquidity << 96n) * (upper - lower), upper * lower);
}

/** Amount of token1 that `liquidity` requires across the range. Rounds up. */
export function getAmount1ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  const [lower, upper] = ordered(sqrtRatioAX96, sqrtRatioBX96);
  if (upper === lower) return 0n;
  return divRoundingUp(liquidity * (upper - lower), Q96);
}

/** Both token amounts `liquidity` requires at the current price. */
export function getAmountsForLiquidity(
  sqrtRatioX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): {amount0: bigint; amount1: bigint} {
  const [lower, upper] = ordered(sqrtRatioAX96, sqrtRatioBX96);

  if (sqrtRatioX96 <= lower) {
    return {
      amount0: getAmount0ForLiquidity(lower, upper, liquidity),
      amount1: 0n,
    };
  }
  if (sqrtRatioX96 < upper) {
    return {
      amount0: getAmount0ForLiquidity(sqrtRatioX96, upper, liquidity),
      amount1: getAmount1ForLiquidity(lower, sqrtRatioX96, liquidity),
    };
  }
  return {
    amount0: 0n,
    amount1: getAmount1ForLiquidity(lower, upper, liquidity),
  };
}
