import { describe, expect, it } from 'vitest';
import { nextRefreshDelay, NORMAL_REFRESH_MS, PENDING_REFRESH_MS } from './polling';

const config = {
  mode: 'testnet', chainId: 11155111,
  walletAddress: '0x1111111111111111111111111111111111111111',
  ownerAddress: '0x2222222222222222222222222222222222222222',
  recipientAddress: '0x3333333333333333333333333333333333333333',
  agentAddress: '0x4444444444444444444444444444444444444444',
  readiness: { ready: false, code: 'READINESS_CHECKING' },
};

describe('adaptive service polling', () => {
  it('polls quickly only while a validated active page is waiting for readiness', () => {
    expect(nextRefreshDelay(config)).toBe(PENDING_REFRESH_MS);
    expect(nextRefreshDelay({ ...config, readiness: { ready: true } })).toBe(NORMAL_REFRESH_MS);
    expect(nextRefreshDelay(config, false)).toBe(NORMAL_REFRESH_MS);
  });

  it('polls active transaction states quickly and returns to normal after a terminal result', () => {
    const ready = { ...config, readiness: { ready: true } };
    for (const status of ['SUBMITTING', 'BROADCAST', 'UNKNOWN']) {
      expect(nextRefreshDelay(ready, true, [{ status }])).toBe(PENDING_REFRESH_MS);
    }
    for (const status of ['EXECUTED', 'AWAITING_APPROVAL', 'FAILED']) {
      expect(nextRefreshDelay(ready, true, [{ status }])).toBe(NORMAL_REFRESH_MS);
    }
    expect(nextRefreshDelay(ready, true, null)).toBe(NORMAL_REFRESH_MS);
    expect(nextRefreshDelay(ready, false, [{ status: 'SUBMITTING' }])).toBe(NORMAL_REFRESH_MS);
  });

  it.each([null, {}, { ...config, chainId: 0 }, { ...config, readiness: null }])(
    'uses the bounded normal interval for empty or malformed external state: %#', value => {
      expect(nextRefreshDelay(value)).toBe(NORMAL_REFRESH_MS);
    },
  );
});
