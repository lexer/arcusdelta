/**
 * Error types for the Arcus perpetuals API.
 *
 * Deliberately a separate hierarchy from `arcus/errors.ts`: those all carry a
 * `tradeId` because every one of them happens inside a trade, whereas the
 * perps read path (markets, funding history, account state) runs outside any
 * trade. Order-path errors added later carry a `tradeId` of their own.
 */

export abstract class PerpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A non-2xx response from the perps gateway. */
export class PerpsApiError extends PerpsError {
  readonly status: number;
  readonly path: string;
  /** Parsed JSON body when the gateway sent one, else the raw text. */
  readonly body: unknown;

  constructor(message: string, path: string, status: number, body: unknown) {
    super(message);
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/**
 * The gateway throttled the request (HTTP 429) and the client's retry budget
 * was exhausted. `retryAfterSeconds` is the gateway's own `Retry-After`.
 *
 * The per-IP bucket holds 1,500 weight and refills at 1,500/minute;
 * `fundingRates` and `markets` cost 20 each, so a wide scan sits right at the
 * ceiling and must be paced by the caller as well as retried here.
 */
export class PerpsRateLimitError extends PerpsError {
  readonly path: string;
  readonly retryAfterSeconds: number;

  constructor(message: string, path: string, retryAfterSeconds: number) {
    super(message);
    this.path = path;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never produced a response — transport failure or timeout. */
export class PerpsTransportError extends PerpsError {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.path = path;
  }
}

/**
 * The API key could not be created or used — a malformed key, an expiry
 * outside the gateway's window, or a signature the gateway would not accept.
 */
export class PerpsAuthError extends PerpsError {}

/** No perp market matches the requested name or base asset. */
export class PerpMarketNotFoundError extends PerpsError {}

/**
 * A size or notional falls outside what the market accepts — below
 * `minOrderSize`, above `maxOrderSize`, or under the minimum notional.
 * Caught before signing, since the engine would reject it anyway.
 */
export class PerpsOrderSizeError extends PerpsError {}

/** The gateway rejected an order. Nothing rested and nothing filled. */
export class PerpsOrderRejectedError extends PerpsError {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * A price or size does not sit exactly on the market's `tickSize` /
 * `stepSize` grid. The engine rejects these, so they are caught here — before
 * anything is signed — rather than round-tripped for a rejection.
 */
export class PerpsAlignmentError extends PerpsError {
  readonly value: string;
  readonly increment: string;

  constructor(message: string, value: string, increment: string) {
    super(message);
    this.value = value;
    this.increment = increment;
  }
}
