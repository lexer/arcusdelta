/**
 * REST client for the Arcus perpetuals gateway.
 *
 * This phase covers the **public read** surface only — every endpoint here is
 * unauthenticated, so market data, funding history, and account state can be
 * inspected with no API key and no funds at risk. The authenticated order
 * endpoints are layered on later and reuse {@link ArcusPerpsClient.request}.
 *
 * Errors are normalized to `PerpsApiError` / `PerpsTransportError` so callers
 * never have to distinguish a gateway rejection from a dropped connection by
 * inspecting a `fetch` failure.
 */

import type {Logger} from '../logging/logger.js';
import {
  PerpsApiError,
  PerpsRateLimitError,
  PerpsTransportError,
} from './errors.js';
import type {
  Bbo,
  FundingRateSample,
  FundingRatesRequest,
  L2OrderBook,
  PerpAccount,
  PerpMarket,
  PerpPosition,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
/** Used only when a 429 arrives without a parseable `Retry-After`. */
const FALLBACK_RETRY_AFTER_SECONDS = 2;

/** Injected so tests never wait on a real timer. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface ArcusPerpsClientOptions {
  /** Gateway origin, e.g. `https://api.arcus.xyz`. No trailing `/v1`. */
  readonly baseUrl: string;
  readonly logger: Logger;
  /** Injected so tests never touch the network. */
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  /** Attempts after a 429 before giving up. Reads only — see `request`. */
  readonly maxRateLimitRetries?: number;
  readonly sleep?: Sleep;
}

interface QueryParams {
  readonly [key: string]: string | number | undefined;
}

/**
 * Whole seconds from the gateway's `Retry-After`, which it documents as always
 * present on a 429 with a minimum of 1. Falls back rather than trusting a
 * missing or malformed header to mean "retry immediately".
 */
function parseRetryAfter(response: Response): number {
  const header = response.headers?.get('Retry-After');
  const parsed = header === null || header === undefined ? NaN : Number(header);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return FALLBACK_RETRY_AFTER_SECONDS;
  }
  return parsed;
}

export class ArcusPerpsClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly sleep: Sleep;

  constructor(options: ArcusPerpsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRateLimitRetries =
      options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Every configured market, including the crypto ones this bot ignores. */
  async getMarkets(): Promise<PerpMarket[]> {
    const body = await this.get<{markets: PerpMarket[]}>('/v1/markets');
    return body.markets;
  }

  /** Top of book. Either side is null when nothing is resting on it. */
  async getBbo(market: string): Promise<Bbo> {
    return this.get<Bbo>(`/v1/bbo/${encodeURIComponent(market)}`);
  }

  async getL2OrderBook(market: string, levels?: number): Promise<L2OrderBook> {
    return this.get<L2OrderBook>(
      `/v1/l2OrderBook/${encodeURIComponent(market)}`,
      levels === undefined ? {} : {levels},
    );
  }

  /**
   * Historical hourly funding, newest-first. The gateway clamps `limit` to
   * 1000 (~41 days), so a longer lookback has to be paged — see
   * `funding/fundingAnalyzer.ts`, which owns that walk.
   */
  async getFundingRates(
    request: FundingRatesRequest,
  ): Promise<FundingRateSample[]> {
    const body = await this.get<{fundingRates: FundingRateSample[]}>(
      '/v1/fundingRates',
      {
        market: request.market,
        from: request.from,
        to: request.to,
        limit: request.limit,
      },
    );
    return body.fundingRates;
  }

  async getAccount(address: string, accountIndex = 0): Promise<PerpAccount> {
    return this.get<PerpAccount>('/v1/account', {address, accountIndex});
  }

  async getPositions(
    address: string,
    accountIndex = 0,
  ): Promise<PerpPosition[]> {
    const body = await this.get<{positions: PerpPosition[]}>('/v1/positions', {
      address,
      accountIndex,
    });
    return body.positions;
  }

  private async get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.request<T>('GET', path, url, {}, this.maxRateLimitRetries);
  }

  /**
   * The one place a perps HTTP call is made. Shared with the authenticated
   * endpoints added later so timeout, error normalization, and logging cannot
   * diverge between the read and write paths.
   *
   * `retriesLeft` covers **429 only**, and only because a throttled request is
   * rejected before the handler runs — the gateway deducts weight up front —
   * so a retry cannot double-apply anything. Reads pass the configured budget;
   * writes pass `0` and surface the throttle to their caller, which knows
   * whether re-sending an order is safe.
   */
  protected async request<T>(
    method: string,
    path: string,
    url: URL,
    init: RequestInit = {},
    retriesLeft = 0,
  ): Promise<T> {
    const startedAt = Date.now();
    this.logger.debug({method, path}, 'perps request started');

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {method, path, error: message, elapsedMs: Date.now() - startedAt},
        'perps request failed to reach the gateway',
      );
      throw new PerpsTransportError(
        `${method} ${path} did not reach the Arcus perps gateway: ${message}`,
        path,
      );
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = text;
    }

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(response);
      if (retriesLeft > 0) {
        this.logger.warn(
          {method, path, retryAfterSeconds, retriesLeft},
          'perps request throttled, backing off',
        );
        await this.sleep(retryAfterSeconds * 1000);
        return this.request<T>(method, path, url, init, retriesLeft - 1);
      }

      this.logger.error(
        {method, path, retryAfterSeconds},
        'perps request throttled and out of retries',
      );
      throw new PerpsRateLimitError(
        `${method} ${path} was rate limited; retry after ${retryAfterSeconds}s`,
        path,
        retryAfterSeconds,
      );
    }

    if (!response.ok) {
      const detail =
        typeof body === 'object' && body !== null && 'error' in body
          ? String((body as {error: unknown}).error)
          : response.statusText;
      this.logger.error(
        {
          method,
          path,
          status: response.status,
          detail,
          elapsedMs: Date.now() - startedAt,
        },
        'perps request rejected',
      );
      throw new PerpsApiError(
        `${method} ${path} returned ${response.status}: ${detail}`,
        path,
        response.status,
        body,
      );
    }

    this.logger.debug(
      {
        method,
        path,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
      },
      'perps request completed',
    );
    return body as T;
  }
}
