import { describe, expect, it } from 'vitest';
import { ReadinessCache } from '../src/readiness-cache.js';

describe('ReadinessCache', () => {
  it('deduplicates concurrent reads and reuses the value inside the TTL', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cache = new ReadinessCache<string>(1_000, () => 100);
    const loader = async () => { calls += 1; await gate; return 'ready'; };
    const first = cache.get(loader);
    const second = cache.get(loader);
    if (release) release();
    await expect(Promise.all([first, second])).resolves.toEqual(['ready', 'ready']);
    await expect(cache.get(loader)).resolves.toBe('ready');
    expect(calls).toBe(1);
  });

  it('reloads after the TTL boundary', async () => {
    let now = 100;
    let calls = 0;
    const cache = new ReadinessCache<string>(10, () => now);
    const loader = async () => String(++calls);
    await expect(cache.get(loader)).resolves.toBe('1');
    now = 110;
    await expect(cache.get(loader)).resolves.toBe('2');
  });

  it('does not cache loader exceptions', async () => {
    let calls = 0;
    const cache = new ReadinessCache<string>(1_000);
    const loader = async () => { calls += 1; if (calls === 1) throw new Error('RPC failed'); return 'recovered'; };
    await expect(cache.get(loader)).rejects.toThrow('RPC failed');
    await expect(cache.get(loader)).resolves.toBe('recovered');
  });

  it('force bypasses a populated cache', async () => {
    let calls = 0;
    const cache = new ReadinessCache<number>(1_000);
    const loader = async () => ++calls;
    await expect(cache.get(loader)).resolves.toBe(1);
    await expect(cache.get(loader, true)).resolves.toBe(2);
  });
});
