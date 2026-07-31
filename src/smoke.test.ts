import {describe, expect, it} from 'vitest';

describe('toolchain', () => {
  it('runs typescript tests', () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });
});
