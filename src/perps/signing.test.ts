import {createPublicKey, verify} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  buildAuthHeaders,
  buildCancelOrderPayload,
  buildLegacyMessage,
  buildPlaceOrderPayload,
  canonicalJson,
  generateApiKeyPair,
  importPrivateKey,
  nowNanos,
  OrderSide,
  PerpsRequestSigner,
  publicKeyHexFrom,
  signMessage,
  TimeInForce,
} from './signing.js';

const ADDRESS = '0x742D35Cc6634C0532925a3b844Bc9e7595f2BD18';
/** ~1.786e18 — comfortably past Number.MAX_SAFE_INTEGER (9.007e15). */
const TIMESTAMP_NS = 1_786_269_600_123_456_789n;
const GOOD_TIL_NS = 1_790_000_000_000_000_000n;

function basePlaceOrder() {
  return {
    address: ADDRESS,
    accountIndex: 0,
    clientTimestampNs: TIMESTAMP_NS,
    goodTilTimeNs: GOOD_TIL_NS,
    marketId: 28,
    priceTicks: 22439n,
    quantityQuantums: 4449308n,
    reduceOnly: false,
    side: OrderSide.SELL,
    timeInForce: TimeInForce.ALO,
  };
}

describe('buildPlaceOrderPayload', () => {
  it('emits the documented fields in alphabetical order with no whitespace', () => {
    expect(buildPlaceOrderPayload(basePlaceOrder())).toBe(
      '{"ad":"0x742d35cc6634c0532925a3b844bc9e7595f2bd18","ai":0,' +
        '"ct":1786269600123456789,"g":1790000000000000000,"m":28,"op":1,' +
        '"p":22439,"q":4449308,"r":0,"s":1,"t":3,"v":1}',
    );
  });

  it('preserves nanosecond timestamps that a JS number would round', () => {
    const payload = buildPlaceOrderPayload(basePlaceOrder());

    expect(payload).toContain('"ct":1786269600123456789');
    // The precision this protects: the same value through a double.
    expect(String(Number(TIMESTAMP_NS))).not.toBe(TIMESTAMP_NS.toString());
  });

  it('lowercases the address', () => {
    expect(buildPlaceOrderPayload(basePlaceOrder())).toContain(
      `"ad":"${ADDRESS.toLowerCase()}"`,
    );
  });

  it('includes a lowercased client id in alphabetical position', () => {
    const payload = buildPlaceOrderPayload({
      ...basePlaceOrder(),
      clientId: 'Chunk-1A',
    });

    expect(payload).toContain('"ai":0,"c":"chunk-1a","ct":');
  });

  it('omits the client id entirely when absent or empty', () => {
    expect(buildPlaceOrderPayload(basePlaceOrder())).not.toContain('"c":');
    expect(
      buildPlaceOrderPayload({...basePlaceOrder(), clientId: ''}),
    ).not.toContain('"c":');
  });

  it('encodes reduceOnly as an integer, not a boolean', () => {
    expect(
      buildPlaceOrderPayload({...basePlaceOrder(), reduceOnly: true}),
    ).toContain('"r":1');
    expect(buildPlaceOrderPayload(basePlaceOrder())).toContain('"r":0');
  });

  it('encodes side and time-in-force as their numeric codes', () => {
    const buyIoc = buildPlaceOrderPayload({
      ...basePlaceOrder(),
      side: OrderSide.BUY,
      timeInForce: TimeInForce.IOC,
    });

    expect(buyIoc).toContain('"s":0');
    expect(buyIoc).toContain('"t":2');
  });
});

describe('buildCancelOrderPayload', () => {
  const base = {
    address: ADDRESS,
    accountIndex: 0,
    clientTimestampNs: TIMESTAMP_NS,
    marketId: 28,
  };

  it('cancels by server order id', () => {
    expect(buildCancelOrderPayload({...base, orderId: 'abc123'})).toBe(
      '{"ad":"0x742d35cc6634c0532925a3b844bc9e7595f2bd18","ai":0,' +
        '"ct":1786269600123456789,"id":"abc123","m":28,"op":2,"v":1}',
    );
  });

  it('cancels by client id, omitting the server id', () => {
    const payload = buildCancelOrderPayload({...base, clientId: 'Chunk-1'});

    expect(payload).toContain('"c":"chunk-1"');
    expect(payload).not.toContain('"id":');
  });

  it('refuses both identifiers rather than signing a doomed request', () => {
    expect(() =>
      buildCancelOrderPayload({...base, orderId: 'abc', clientId: 'x'}),
    ).toThrow(/exactly one/);
  });

  it('refuses neither identifier', () => {
    expect(() => buildCancelOrderPayload(base)).toThrow(/exactly one/);
  });
});

describe('canonicalJson', () => {
  it('sorts keys and emits no whitespace', () => {
    expect(canonicalJson({b: 2, a: 1, c: 'x'})).toBe('{"a":1,"b":2,"c":"x"}');
  });

  it('emits bigints as bare integers', () => {
    expect(canonicalJson({t: TIMESTAMP_NS})).toBe('{"t":1786269600123456789}');
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({z: {b: 1, a: 2}})).toBe('{"z":{"a":2,"b":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson({a: [3, 1, 2]})).toBe('{"a":[3,1,2]}');
  });

  it('drops undefined values', () => {
    expect(canonicalJson({a: 1, b: undefined})).toBe('{"a":1}');
  });

  it('escapes strings as JSON requires', () => {
    expect(canonicalJson({a: 'he said "hi"'})).toBe('{"a":"he said \\"hi\\""}');
  });
});

describe('buildLegacyMessage', () => {
  it('concatenates timestamp, action, and canonical body with no delimiters', () => {
    expect(
      buildLegacyMessage(TIMESTAMP_NS, 'setLeverage', {
        marketId: 28,
        address: ADDRESS,
      }),
    ).toBe(
      `1786269600123456789setLeverage{"address":"${ADDRESS}","marketId":28}`,
    );
  });
});

describe('key handling', () => {
  it('round-trips a generated keypair through import', () => {
    const pair = generateApiKeyPair();

    expect(pair.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(pair.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyHexFrom(importPrivateKey(pair.privateKeyHex))).toBe(
      pair.publicKeyHex,
    );
  });

  it('accepts a 0x-prefixed private key', () => {
    const pair = generateApiKeyPair();

    expect(publicKeyHexFrom(importPrivateKey(`0x${pair.privateKeyHex}`))).toBe(
      pair.publicKeyHex,
    );
  });

  it('rejects a key that is not 32 bytes of hex', () => {
    expect(() => importPrivateKey('deadbeef')).toThrow(/32 bytes/);
    expect(() => importPrivateKey('z'.repeat(64))).toThrow(/32 bytes/);
  });
});

describe('signing', () => {
  it('produces a 128-character hex signature that verifies against the public key', () => {
    const pair = generateApiKeyPair();
    const privateKey = importPrivateKey(pair.privateKeyHex);
    const message = buildPlaceOrderPayload(basePlaceOrder());

    const signature = signMessage(privateKey, message);

    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    // Rebuild the public key from the raw 32 bytes the gateway would hold.
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const publicKey = createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(pair.publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    expect(
      verify(
        null,
        Buffer.from(message, 'utf8'),
        publicKey,
        Buffer.from(signature, 'hex'),
      ),
    ).toBe(true);
  });

  it('signs the exact bytes, so a one-character change invalidates it', () => {
    const pair = generateApiKeyPair();
    const privateKey = importPrivateKey(pair.privateKeyHex);

    expect(signMessage(privateKey, '{"a":1}')).not.toBe(
      signMessage(privateKey, '{"a":2}'),
    );
  });
});

describe('PerpsRequestSigner', () => {
  it('exposes the public key as the API key', () => {
    const pair = generateApiKeyPair();

    expect(new PerpsRequestSigner(pair.privateKeyHex).apiKeyHex).toBe(
      pair.publicKeyHex,
    );
  });

  it('builds scheme-1 headers whose timestamp matches the payload ct', () => {
    const pair = generateApiKeyPair();
    const signer = new PerpsRequestSigner(pair.privateKeyHex);
    const payload = buildPlaceOrderPayload(basePlaceOrder());

    const headers = signer.authForPayload(payload, TIMESTAMP_NS);

    expect(headers['X-Timestamp']).toBe(TIMESTAMP_NS.toString());
    expect(payload).toContain(`"ct":${headers['X-Timestamp']}`);
    expect(headers['X-API-Key']).toBe(pair.publicKeyHex);
    expect(headers['X-Signature']).toMatch(/^[0-9a-f]{128}$/);
  });

  it('builds scheme-2 headers over the concatenated message', () => {
    const pair = generateApiKeyPair();
    const signer = new PerpsRequestSigner(pair.privateKeyHex);
    const body = {address: ADDRESS, marketId: 28};

    const headers = signer.authForAction('setLeverage', body, TIMESTAMP_NS);

    expect(headers['X-Signature']).toBe(
      signMessage(
        importPrivateKey(pair.privateKeyHex),
        buildLegacyMessage(TIMESTAMP_NS, 'setLeverage', body),
      ),
    );
  });
});

describe('nowNanos', () => {
  it('converts milliseconds to nanoseconds without float loss', () => {
    expect(nowNanos(1_786_269_600_123)).toBe(1_786_269_600_123_000_000n);
  });
});

describe('buildAuthHeaders', () => {
  it('renders the timestamp as a decimal string', () => {
    expect(buildAuthHeaders('key', TIMESTAMP_NS, 'sig')).toEqual({
      'X-API-Key': 'key',
      'X-Timestamp': '1786269600123456789',
      'X-Signature': 'sig',
    });
  });
});
