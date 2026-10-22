import { describe, expect, it } from 'vitest';
import { ConcurrencyGate } from '../src/rpc-concurrency.js';

const defer = () => {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

describe('ConcurrencyGate', () => {
  it('admits no more than the configured number of tasks', async () => {
    const gate = new ConcurrencyGate(2);
    const blockers = [defer(), defer(), defer(), defer()];
    let active = 0;
    let maximum = 0;
    const tasks = blockers.map(blocker => gate.run(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await blocker.promise;
      active -= 1;
    }));
    await Promise.resolve();
    expect(active).toBe(2);
    blockers[0].release();
    blockers[1].release();
    await Promise.resolve();
    await Promise.resolve();
    expect(maximum).toBe(2);
    blockers[2].release();
    blockers[3].release();
    await Promise.all(tasks);
  });

  it('releases a slot when a task rejects', async () => {
    const gate = new ConcurrencyGate(1);
    await expect(gate.run(async () => { throw new Error('RPC failed'); })).rejects.toThrow('RPC failed');
    await expect(gate.run(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('preserves FIFO admission at the single-request boundary', async () => {
    const gate = new ConcurrencyGate(1);
    const first = defer();
    const order: number[] = [];
    const one = gate.run(async () => { order.push(1); await first.promise; });
    const two = gate.run(async () => { order.push(2); });
    const three = gate.run(async () => { order.push(3); });
    await Promise.resolve();
    expect(order).toEqual([1]);
    first.release();
    await Promise.all([one, two, three]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects empty, negative and fractional limits', () => {
    for (const value of [0, -1, 1.5]) expect(() => new ConcurrencyGate(value)).toThrow('positive integer');
  });
});
