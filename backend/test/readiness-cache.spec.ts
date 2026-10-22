import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicReadinessCache, readinessIdentity } from '../src/readiness-cache.js';
import { loadConfig } from '../src/config.js';

const ready = {
  ready: true, rpcChainId: 11155111, contractsDeployed: true,
  deploymentBindingsVerified: true, executorAuthorized: true,
  executorConfigured: true, agentTier: 2, feedFresh: true,
  walletFunded: true, executorFunded: true,
};
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Resolver not initialized'); };
  let reject: (reason?: unknown) => void = () => { throw new Error('Rejector not initialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const caches: PublicReadinessCache[] = [];
function cache(load: () => Promise<unknown>, identity: () => string = () => 'deployment-one') {
  const result = new PublicReadinessCache(load, identity, {
    ttlMs: 15_000, refreshAfterMs: 5000, staleIfErrorMs: 60_000,
    now: Date.now, wallTime: Date.now,
  });
  caches.push(result);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T01:00:00Z'));
});
afterEach(() => {
  for (const value of caches.splice(0)) value.close();
  vi.useRealTimers();
});

describe('public Sepolia readiness display cache', () => {
  it('coalesces concurrent callers into one chain sweep and labels later cache reads', async () => {
    const pending = deferred<unknown>();
    const load = vi.fn(() => pending.promise);
    const value = cache(load);
    const first = value.read();
    const second = value.read();
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(ready);
    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect(result).toMatchObject({ ready: true, source: 'fresh', cacheAgeMs: 0, cacheTtlMs: 15000, checkedAt: '2026-10-22T01:00:00.000Z' });
    }
    await vi.advanceTimersByTimeAsync(4999);
    expect(await value.read()).toMatchObject({ ready: true, source: 'cache', cacheAgeMs: 4999 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('bounds a public caller to one second while the single sweep keeps running', async () => {
    const pending = deferred<unknown>();
    const load = vi.fn(() => pending.promise);
    const value = cache(load);
    const first = value.read();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toEqual({ ready: false, code: 'READINESS_CHECKING', message: '正在核对 Sepolia 网络、合约和价格源，请稍候。', source: 'checking', checkedAt: null, cacheAgeMs: null, cacheTtlMs: 15000 });
    const second = value.read();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await second).toMatchObject({ ready: false, code: 'READINESS_CHECKING' });
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(await value.read()).toMatchObject({ ready: true, source: 'cache' });
  });

  it('does not serve expired ready proofs while a replacement sweep is pending', async () => {
    const second = deferred<unknown>();
    const load = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(ready).mockImplementationOnce(() => second.promise);
    const value = cache(load);
    expect((await value.read()).ready).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    const expired = value.read();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await expired).toMatchObject({ ready: false, code: 'READINESS_CHECKING', source: 'checking', checkedAt: '2026-10-22T01:00:00.000Z', cacheAgeMs: 16_000 });
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve({ ready: false, code: 'FEED_STALE', feedFresh: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(await value.read()).toMatchObject({ ready: false, code: 'FEED_STALE', source: 'cache' });
  });

  it('runtime-validates malformed, null and incomplete positive results instead of caching ready', async () => {
    for (const raw of [null, {}, { ready: 'true' }, { ready: true }, { ...ready, feedFresh: false }, { ...ready, code: 'FAILED' }, { ...ready, rpcChainId: -1 }]) {
      const value = cache(async () => raw);
      const result = await value.read();
      expect(result).toMatchObject({ ready: false, code: 'READINESS_INVALID', source: 'error' });
      expect(result).not.toHaveProperty('deploymentBindingsVerified');
    }
  });

  it('strips unknown fields from a chain result before returning public metadata', async () => {
    const value = cache(async () => ({ ...ready, credential: 'never-return-this', source: 'invented', cacheAgeMs: -1 }));
    const result = await value.read();
    expect(result).toMatchObject({ ready: true, source: 'fresh', cacheAgeMs: 0 });
    expect(result).not.toHaveProperty('credential');
  });

  it('returns generic RPC failures without leaking thrown URLs and retries after the TTL', async () => {
    const load = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('https://rpc.invalid/private-key')).mockResolvedValueOnce(ready);
    const value = cache(load);
    const failed = await value.read();
    expect(failed).toMatchObject({ ready: false, code: 'CHAIN_UNAVAILABLE', source: 'error' });
    expect(JSON.stringify(failed)).not.toContain('private-key');
    expect((await value.read()).ready).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await value.read()).ready).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('times out a hung sweep without allowing overlapping abandoned sweeps or late success', async () => {
    const old = deferred<unknown>();
    const load = vi.fn<() => Promise<unknown>>().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(ready);
    const value = cache(load);
    const first = value.read();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).ready).toBe(false);
    await vi.advanceTimersByTimeAsync(89_000);
    expect(await value.read()).toMatchObject({ ready: false, code: 'READINESS_TIMEOUT', source: 'error' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await value.read()).toMatchObject({ ready: false, code: 'READINESS_TIMEOUT' });
    expect(load).toHaveBeenCalledTimes(1);
    old.resolve(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(await value.read()).toMatchObject({ ready: false, code: 'READINESS_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await value.read()).toMatchObject({ ready: true, source: 'cache' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('revalidates after five seconds without delaying a still-valid display proof', async () => {
    const next = deferred<unknown>();
    const load = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(ready).mockImplementationOnce(() => next.promise);
    const value = cache(load);
    expect(await value.read()).toMatchObject({ ready: true, cacheTtlMs: 15_000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await value.read()).toMatchObject({ ready: true, source: 'cache', cacheAgeMs: 5000 });
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8999);
    expect(await value.read()).toMatchObject({ ready: true, source: 'cache', cacheAgeMs: 13_999 });
    expect(load).toHaveBeenCalledTimes(2);
    next.resolve(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(await value.read()).toMatchObject({ ready: true, source: 'cache', cacheAgeMs: 0, checkedAt: '2026-10-22T01:00:13.999Z' });
  });

  it('stops returning ready at the hard fifteen-second boundary during background revalidation', async () => {
    const next = deferred<unknown>();
    const load = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(ready).mockImplementationOnce(() => next.promise);
    const value = cache(load);
    await value.read();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await value.read()).ready).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    const expired = value.read();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await expired).toMatchObject({ ready: false, code: 'READINESS_CHECKING', checkedAt: '2026-10-22T01:00:00.000Z', cacheAgeMs: 16_000 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('replaces an old ready proof immediately when background revalidation fails', async () => {
    const next = deferred<unknown>();
    const load = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(ready).mockImplementationOnce(() => next.promise);
    const value = cache(load);
    await value.read();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await value.read()).ready).toBe(true);
    next.resolve({ ready: false, code: 'FEED_STALE', feedFresh: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(await value.read()).toMatchObject({ ready: false, code: 'FEED_STALE', source: 'cache', cacheAgeMs: 0 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('validates the revalidation threshold against the bounded hard TTL', () => {
    for (const options of [
      { ttlMs: 300_001 }, { refreshAfterMs: 300_000 },
      { ttlMs: 100, refreshAfterMs: 100 }, { ttlMs: 100, refreshAfterMs: 101 },
      { refreshAfterMs: 0 }, { ttlMs: 100, staleIfErrorMs: 100 },
    ]) expect(() => new PublicReadinessCache(async () => ready, () => 'fixture', options)).toThrow();
    const value = new PublicReadinessCache(async () => ready, () => 'fixture', { ttlMs: 100, refreshAfterMs: 25, staleIfErrorMs: 200 });
    caches.push(value);
  });

  it('uses a one-minute fresh window and starts background revalidation after thirty seconds', async () => {
    const next = deferred<unknown>();
    const load = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(ready).mockImplementationOnce(() => next.promise);
    const value = new PublicReadinessCache(load, () => 'default-timing', { now: Date.now, wallTime: Date.now });
    caches.push(value);
    expect(await value.read()).toMatchObject({ ready: true, cacheTtlMs: 60_000 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect((await value.read()).ready).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await value.read()).toMatchObject({ ready: true, source: 'cache', cacheAgeMs: 30_000 });
    expect(load).toHaveBeenCalledTimes(2);
    next.resolve(ready);
  });

  it('retains verified read-only evidence across a transient refresh error but never marks it ready', async () => {
    const load = vi.fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(ready)
      .mockResolvedValue({ ready: false, code: 'CHAIN_UNAVAILABLE', message: 'private upstream detail' });
    const value = cache(load);
    expect((await value.read()).ready).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await value.read()).ready).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await value.read()).toMatchObject({
      ready: false, code: 'CHAIN_UNAVAILABLE', source: 'error',
      rpcChainId: 11155111, contractsDeployed: true, deploymentBindingsVerified: true,
      checkedAt: '2026-10-22T01:00:00.000Z', cacheTtlMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(55_000);
    const expired = await value.read();
    expect(expired).toMatchObject({ ready: false, code: 'CHAIN_UNAVAILABLE' });
    expect(expired).not.toHaveProperty('deploymentBindingsVerified');
  });

  it('invalidates a young proof when a deployment identity changes', async () => {
    let identity = 'old';
    const load = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(ready).mockResolvedValueOnce({ ready: false, code: 'OWNER_MISMATCH' });
    const value = cache(load, () => identity);
    expect((await value.read()).ready).toBe(true);
    identity = 'new';
    expect(await value.read()).toMatchObject({ ready: false, code: 'OWNER_MISMATCH', source: 'fresh' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('discards an old in-flight result after invalidation and waits before the next sweep', async () => {
    let identity = 'old';
    const old = deferred<unknown>();
    const load = vi.fn<() => Promise<unknown>>().mockImplementationOnce(() => old.promise).mockResolvedValueOnce({ ready: false, code: 'OWNER_MISMATCH' });
    const value = cache(load, () => identity);
    const oldRead = value.read();
    identity = 'new';
    const newRead = value.read();
    old.resolve(ready);
    expect(await oldRead).toMatchObject({ ready: false, code: 'READINESS_CHECKING' });
    expect(await newRead).toMatchObject({ ready: false, code: 'READINESS_CHECKING' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await value.read()).toMatchObject({ ready: false, code: 'OWNER_MISMATCH' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('closes waiting reads and prevents a late result or new sweep from reviving readiness', async () => {
    const pending = deferred<unknown>();
    const load = vi.fn(() => pending.promise);
    const value = cache(load);
    const first = value.read();
    value.close();
    expect(await first).toMatchObject({ ready: false, code: 'READINESS_UNAVAILABLE', source: 'error' });
    pending.resolve(ready);
    await vi.advanceTimersByTimeAsync(0);
    expect(await value.read()).toMatchObject({ ready: false, code: 'READINESS_UNAVAILABLE' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fingerprints all relevant deployment and signer configuration without exposing it', () => {
    const original = loadConfig({});
    const key = readinessIdentity(original);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { rpcUrl: 'https://rpc.example.invalid/private-path' }, { chainId: 11155111 },
      { ownerAddress: '0x1111111111111111111111111111111111111111' as const },
      { agentKey: undefined }, { deploymentReady: !original.deploymentReady },
      { abiVersion: 'changed' },
    ]) expect(readinessIdentity({ ...original, ...change })).not.toBe(key);
  });
});
