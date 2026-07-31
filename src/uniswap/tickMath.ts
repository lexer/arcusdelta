/**
 * Uniswap tick <-> sqrt price conversions, in native bigint.
 *
 * A direct port of the on-chain TickMath library. The constants and shift
 * sequence are load-bearing: they reproduce 1.0001^(tick/2) in Q64.96 fixed
 * point exactly as the pool does. Cross-checked against @uniswap/v3-sdk in
 * tickMath.test.ts.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO =
  1461446703485210103287273052203988822378723970342n;

const Q32 = 2n ** 32n;

/** Magic constants from TickMath: 2^128 / 1.0001^(2^i / 2). */
const RATIOS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/** Q64.96 sqrt price for a tick. Mirrors TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) {
    throw new RangeError(`tick must be an integer, got ${tick}`);
  }
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick ${tick} is outside [${MIN_TICK}, ${MAX_TICK}]`);
  }

  const absTick = BigInt(Math.abs(tick));
  let ratio =
    (absTick & 0x1n) !== 0n ? RATIOS[0]! : 0x100000000000000000000000000000000n;

  for (let i = 1; i < RATIOS.length; i++) {
    if ((absTick & (1n << BigInt(i))) !== 0n) {
      ratio = (ratio * RATIOS[i]!) >> 128n;
    }
  }

  if (tick > 0) {
    ratio = (2n ** 256n - 1n) / ratio;
  }

  // Q128.128 -> Q64.96, rounding up so the result never understates the price.
  return ratio / Q32 + (ratio % Q32 === 0n ? 0n : 1n);
}

/**
 * Greatest tick whose sqrt ratio is <= the input.
 *
 * Uses binary search rather than the on-chain log-based routine: this runs off
 * chain where clarity beats gas, and the search is exact by construction
 * because getSqrtRatioAtTick is monotonic.
 */
export function getTickAtSqrtRatio(sqrtRatioX96: bigint): number {
  if (sqrtRatioX96 < MIN_SQRT_RATIO || sqrtRatioX96 >= MAX_SQRT_RATIO) {
    throw new RangeError(`sqrt ratio ${sqrtRatioX96} is out of range`);
  }

  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtRatioX96) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * Rounds a tick to a multiple of `spacing`, away from `reference`.
 *
 * Rounding outward guarantees the realized range is never narrower than the
 * one that was asked for.
 */
export function alignTickOutward(
  tick: number,
  spacing: number,
  direction: 'down' | 'up',
): number {
  if (spacing <= 0) {
    throw new RangeError(`tick spacing must be positive, got ${spacing}`);
  }
  const aligned =
    direction === 'down'
      ? Math.floor(tick / spacing) * spacing
      : Math.ceil(tick / spacing) * spacing;

  const clamped = Math.min(Math.max(aligned, MIN_TICK), MAX_TICK);
  // Clamping can land off-spacing at the extremes; pull back inside.
  return direction === 'down'
    ? Math.ceil(clamped / spacing) * spacing
    : Math.floor(clamped / spacing) * spacing;
}
