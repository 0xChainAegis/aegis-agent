import { describe, expect, it } from 'vitest';
import { singleFlightByRevision } from '../src/single-flight';

function deferred() {
  let resolve: () => void = () => { throw new Error('Uninitialized resolve'); };
  let reject: (reason: Error) => void = () => { throw new Error('Uninitialized reject'); };
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('wallet-session refresh coordination', () => {
  it('coalesces timer and manual requests while the same check is pending', async () => {
    const gate = deferred();
    const calls: boolean[] = [];
    const refresh = singleFlightByRevision(() => 0, async (_revision, initial) => {
      calls.push(initial); await gate.promise;
    });
    const timer = refresh();
    const manual = refresh(true);
    const nextTick = refresh();
    await Promise.resolve();
    expect(calls).toEqual([false]);
    expect(manual).toBe(timer); expect(nextTick).toBe(timer);
    gate.resolve(); await timer;
    await refresh(true);
    expect(calls).toEqual([false, true]);
  });

  it('releases a rejected flight so recovery can perform a fresh check', async () => {
    let calls = 0;
    const refresh = singleFlightByRevision(() => 0, async () => {
      if (++calls === 1) throw new Error('RPC unavailable');
    });
    await expect(refresh()).rejects.toThrow('RPC unavailable');
    await expect(refresh()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it.each(['resolve', 'reject'] as const)('an old session %s cannot release the new session flight', async completion => {
    let revision = 0;
    const old = deferred(); const current = deferred();
    const calls: number[] = [];
    const refresh = singleFlightByRevision(() => revision, async captured => {
      calls.push(captured); await (captured === 0 ? old.promise : current.promise);
    });
    const first = refresh();
    const oldResult = first.catch(() => {});
    await Promise.resolve();
    revision++;
    const second = refresh();
    await Promise.resolve();
    expect(calls).toEqual([0, 1]);
    expect(second).not.toBe(first);
    if (completion === 'reject') old.reject(new Error('old timeout'));
    else old.resolve();
    await oldResult;
    expect(refresh(true)).toBe(second);
    expect(calls).toEqual([0, 1]);
    current.resolve(); await second;
  });

  it('discards a queued check when the wallet session changes before it starts', async () => {
    let revision = 0;
    const calls: number[] = [];
    const refresh = singleFlightByRevision(() => revision, async captured => { calls.push(captured); });
    const stale = refresh();
    revision++;
    const current = refresh();
    await Promise.all([stale, current]);
    expect(calls).toEqual([1]);
  });
});
