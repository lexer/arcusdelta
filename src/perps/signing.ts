/**
 * Ed25519 request signing for the Arcus perpetuals gateway.
 *
 * Two schemes, picked by operation:
 *
 * - **Scheme 1 (orders)** — the signed message *is* the request payload: a
 *   compact, key-sorted JSON object of engine-native integers. Used by
 *   `placeOrder`, `cancelOrder`, and `modifyOrder`.
 * - **Scheme 2 (everything else)** — `timestamp + action + canonical_json(body)`
 *   concatenated with no delimiters. Used by `cancelAllOrders`, `setLeverage`,
 *   and the WebSocket `authenticate`.
 *
 * The canonical payload is built by string concatenation rather than
 * `JSON.stringify`, and that is not a micro-optimization: `ct` and `g` are
 * Unix **nanosecond** timestamps around 1.8e18, well past
 * `Number.MAX_SAFE_INTEGER` (9.0e15). Routing them through a JS `number` would
 * silently round them, producing a valid signature over the wrong timestamp —
 * which the gateway then rejects with no hint as to why. They stay `bigint`
 * end to end.
 *
 * Everything here is pure and synchronous, so the exact bytes that get signed
 * are pinned by unit tests rather than discovered against a live gateway.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import type {KeyObject} from 'node:crypto';

/** Operation discriminator in the signed payload. */
export const OP_PLACE = 1;
export const OP_CANCEL = 2;
export const OP_MODIFY = 3;

/** Payload version. Currently 1. */
const PAYLOAD_VERSION = 1;

/** `s` in the payload. */
export const OrderSide = {BUY: 0, SELL: 1} as const;
export type OrderSideCode = (typeof OrderSide)[keyof typeof OrderSide];

/** `t` in the payload. `ALO` is post-only: it rests or is rejected, never crosses. */
export const TimeInForce = {GTT: 0, FOK: 1, IOC: 2, ALO: 3} as const;
export type TimeInForceCode = (typeof TimeInForce)[keyof typeof TimeInForce];

/**
 * DER prefix for a PKCS#8-wrapped Ed25519 private key. Node has no API for
 * importing a raw 32-byte seed, so the seed is wrapped in this fixed header.
 */
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

/** An Ed25519 keypair. The public key *is* the API key. */
export interface ApiKeyPair {
  /** 64 hex chars. Secret — handle exactly like the wallet seed. */
  readonly privateKeyHex: string;
  /** 64 hex chars. Public, and not a secret. */
  readonly publicKeyHex: string;
}

export function generateApiKeyPair(): ApiKeyPair {
  const {privateKey} = generateKeyPairSync('ed25519');
  return {
    privateKeyHex: rawPrivateKeyHex(privateKey),
    publicKeyHex: publicKeyHexFrom(privateKey),
  };
}

/** Imports a raw 32-byte Ed25519 seed, with or without a `0x` prefix. */
export function importPrivateKey(privateKeyHex: string): KeyObject {
  const hex = privateKeyHex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'Arcus API private key must be 32 bytes of hex (64 characters)',
    );
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** The 32-byte public key, hex encoded. This is the value of `X-API-Key`. */
export function publicKeyHexFrom(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  // The raw key is the last 32 bytes of the SPKI structure.
  return spki.subarray(spki.length - 32).toString('hex');
}

function rawPrivateKeyHex(privateKey: KeyObject): string {
  const pkcs8 = privateKey.export({format: 'der', type: 'pkcs8'});
  return pkcs8.subarray(pkcs8.length - 32).toString('hex');
}

/** Lowercase hex Ed25519 signature (128 chars) over the exact message bytes. */
export function signMessage(privateKey: KeyObject, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
}

/** Renders a JSON string literal with the escaping JSON requires. */
function jsonString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Canonical JSON for scheme 2 bodies: keys sorted, no whitespace, and integers
 * emitted from `bigint` so a nanosecond timestamp survives intact.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(
      ([key, entryValue]) => `${jsonString(key)}:${canonicalJson(entryValue)}`,
    )
    .join(',')}}`;
}

export interface PlaceOrderPayload {
  /** Master Ethereum address. Lowercased in the payload. */
  readonly address: string;
  readonly accountIndex: number;
  /** Omitted from the payload entirely when absent. Lowercased when present. */
  readonly clientId?: string;
  /** Must equal the `X-Timestamp` header, in nanoseconds. */
  readonly clientTimestampNs: bigint;
  /** `goodTilTime` in nanoseconds. Required, and at least a month ahead. */
  readonly goodTilTimeNs: bigint;
  readonly marketId: number;
  /** `price / tickSize`, exact. */
  readonly priceTicks: bigint;
  /** `size / stepSize`, exact. */
  readonly quantityQuantums: bigint;
  readonly reduceOnly: boolean;
  readonly side: OrderSideCode;
  readonly timeInForce: TimeInForceCode;
}

/**
 * `{"ad","ai","c"?,"ct","g","m","op","p","q","r","s","t","v"}` — alphabetical,
 * no whitespace, `c` omitted when empty.
 */
export function buildPlaceOrderPayload(payload: PlaceOrderPayload): string {
  const fields = [
    `"ad":${jsonString(payload.address.toLowerCase())}`,
    `"ai":${payload.accountIndex}`,
    ...(payload.clientId === undefined || payload.clientId === ''
      ? []
      : [`"c":${jsonString(payload.clientId.toLowerCase())}`]),
    `"ct":${payload.clientTimestampNs.toString()}`,
    `"g":${payload.goodTilTimeNs.toString()}`,
    `"m":${payload.marketId}`,
    `"op":${OP_PLACE}`,
    `"p":${payload.priceTicks.toString()}`,
    `"q":${payload.quantityQuantums.toString()}`,
    `"r":${payload.reduceOnly ? 1 : 0}`,
    `"s":${payload.side}`,
    `"t":${payload.timeInForce}`,
    `"v":${PAYLOAD_VERSION}`,
  ];
  return `{${fields.join(',')}}`;
}

export interface CancelOrderPayload {
  readonly address: string;
  readonly accountIndex: number;
  readonly clientTimestampNs: bigint;
  readonly marketId: number;
  /** Server order id. Provide exactly one of `orderId` or `clientId`. */
  readonly orderId?: string;
  readonly clientId?: string;
}

/**
 * `{"ad","ai","c"?,"ct","id"?,"m","op","v"}`. Exactly one of `id` / `c` —
 * sending both, or neither, is a client bug and throws here rather than
 * producing a signature the gateway will reject.
 */
export function buildCancelOrderPayload(payload: CancelOrderPayload): string {
  const hasOrderId = payload.orderId !== undefined && payload.orderId !== '';
  const hasClientId = payload.clientId !== undefined && payload.clientId !== '';
  if (hasOrderId === hasClientId) {
    throw new Error(
      'cancelOrder needs exactly one of orderId or clientId, not both or neither',
    );
  }

  const fields = [
    `"ad":${jsonString(payload.address.toLowerCase())}`,
    `"ai":${payload.accountIndex}`,
    ...(hasClientId
      ? [`"c":${jsonString(payload.clientId!.toLowerCase())}`]
      : []),
    `"ct":${payload.clientTimestampNs.toString()}`,
    ...(hasOrderId ? [`"id":${jsonString(payload.orderId!)}`] : []),
    `"m":${payload.marketId}`,
    `"op":${OP_CANCEL}`,
    `"v":${PAYLOAD_VERSION}`,
  ];
  return `{${fields.join(',')}}`;
}

/**
 * Scheme 2: `timestamp + action + canonical_json(body)`, no delimiters.
 * `action` is the camelCase final path segment, e.g. `/v1/setLeverage` ->
 * `setLeverage`. The HTTP method is not part of the message.
 */
export function buildLegacyMessage(
  timestampNs: bigint,
  action: string,
  body: unknown,
): string {
  return `${timestampNs.toString()}${action}${canonicalJson(body)}`;
}

/**
 * The three headers every authenticated request carries.
 *
 * Indexed rather than a closed shape so it drops straight into a header bag
 * without a cast at every call site.
 */
export interface AuthHeaders extends Readonly<Record<string, string>> {
  readonly 'X-API-Key': string;
  readonly 'X-Timestamp': string;
  readonly 'X-Signature': string;
}

export function buildAuthHeaders(
  apiKeyHex: string,
  timestampNs: bigint,
  signatureHex: string,
): AuthHeaders {
  return {
    'X-API-Key': apiKeyHex,
    'X-Timestamp': timestampNs.toString(),
    'X-Signature': signatureHex,
  };
}

/**
 * Signs requests with one Ed25519 key.
 *
 * Holds the imported key so the private hex is read once at construction and
 * never passed around afterwards.
 */
export class PerpsRequestSigner {
  private readonly privateKey: KeyObject;
  readonly apiKeyHex: string;

  constructor(privateKeyHex: string) {
    this.privateKey = importPrivateKey(privateKeyHex);
    this.apiKeyHex = publicKeyHexFrom(this.privateKey);
  }

  /** Scheme 1. The payload string is both the signed message and the proof. */
  signPayload(payload: string): string {
    return signMessage(this.privateKey, payload);
  }

  /** Scheme 1, with the matching headers. `ct` inside must equal `timestampNs`. */
  authForPayload(payload: string, timestampNs: bigint): AuthHeaders {
    return buildAuthHeaders(
      this.apiKeyHex,
      timestampNs,
      this.signPayload(payload),
    );
  }

  /** Scheme 2. */
  authForAction(
    action: string,
    body: unknown,
    timestampNs: bigint,
  ): AuthHeaders {
    const message = buildLegacyMessage(timestampNs, action, body);
    return buildAuthHeaders(
      this.apiKeyHex,
      timestampNs,
      signMessage(this.privateKey, message),
    );
  }
}

/** Current wall clock in Unix nanoseconds, the resolution `X-Timestamp` wants. */
export function nowNanos(nowMs: number = Date.now()): bigint {
  return BigInt(nowMs) * 1_000_000n;
}
