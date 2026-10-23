import { describe, expect, it } from 'vitest';
import { createClient } from 'viem';
import { sendRawTransaction } from 'viem/actions';
import { z } from 'zod';
import { boundedHttp, ConcurrencyGate } from '../src/rpc-concurrency.js';

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

const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.number(), method: z.string(), params: z.unknown().optional(),
});
const rpcPayloadSchema = z.union([rpcRequestSchema, z.array(rpcRequestSchema)]);
function requestsFrom(init?: RequestInit) {
  const payload = rpcPayloadSchema.parse(JSON.parse(String(init?.body)));
  return Array.isArray(payload) ? payload : [payload];
}

describe('boundedHttp request options', () => {
  it('retries a failed read but preserves sendRawTransaction zero-retry policy', async () => {
    const methods: string[] = [];
    const client = createClient({
      transport: boundedHttp('http://rpc.invalid/retries', {
        retryCount: 1, retryDelay: 0,
        fetchFn: async (_input, init) => {
          methods.push(...requestsFrom(init).map(request => request.method));
          return new Response('RPC unavailable', { status: 503, statusText: 'Service Unavailable' });
        },
      }),
    });
    await expect(client.request({ method: 'eth_blockNumber' })).rejects.toThrow('503');
    expect(methods).toEqual(['eth_blockNumber', 'eth_blockNumber']);
    methods.length = 0;
    // The real viem action supplies retryCount: 0. The fetch substitute never broadcasts.
    await expect(sendRawTransaction(client, { serializedTransaction: '0x00' })).rejects.toThrow('503');
    expect(methods).toEqual(['eth_sendRawTransaction']);
  });

  it('forwards cancellation to fetch and releases the slot for a waiting read', async () => {
    const started = defer();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const client = createClient({
      transport: boundedHttp('http://rpc.invalid/cancellation', {
        batch: false, retryCount: 1, retryDelay: 0, timeout: 1000,
        fetchFn: async (_input, init) => {
          calls += 1;
          const [request] = requestsFrom(init);
          if (!request) throw new Error('Expected one RPC request');
          if (calls === 1) {
            const signal = init?.signal;
            if (!signal) throw new Error('Expected a cancellable fetch');
            signals.push(signal);
            started.release();
            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          }
          return Response.json({ jsonrpc: '2.0', id: request.id, result: '0x2' });
        },
      }, 1),
    });
    const controller = new AbortController();
    const cancelled = expect(client.request({ method: 'eth_blockNumber' }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    const waiting = client.request({ method: 'eth_blockNumber' });
    controller.abort();
    await cancelled;
    await expect(waiting).resolves.toBe('0x2');
    expect(signals[0]?.aborted).toBe(true);
    expect(calls).toBe(2);
  });

  it('batches requests sharing a signal and matches responses without mixing signals', async () => {
    const batches: Array<{ methods: string[]; signal: AbortSignal | null | undefined }> = [];
    const results: Record<string, string> = { eth_blockNumber: '0x2', eth_chainId: '0xaa36a7', net_version: '11155111' };
    const client = createClient({
      transport: boundedHttp('http://rpc.invalid/signal-batches', {
        retryCount: 0, timeout: 0,
        fetchFn: async (_input, init) => {
          const requests = requestsFrom(init);
          batches.push({ methods: requests.map(request => request.method), signal: init?.signal });
          return Response.json(requests.map(request => ({
            jsonrpc: '2.0', id: request.id, result: results[request.method],
          })).reverse());
        },
      }),
    });
    const first = new AbortController();
    const second = new AbortController();
    await expect(Promise.all([
      client.request({ method: 'eth_blockNumber' }, { signal: first.signal }),
      client.request({ method: 'eth_chainId' }, { signal: first.signal }),
      client.request({ method: 'net_version' }, { signal: second.signal }),
    ])).resolves.toEqual(['0x2', '0xaa36a7', '11155111']);
    expect(batches).toHaveLength(2);
    expect(batches.find(batch => batch.signal === first.signal)?.methods).toEqual(['eth_blockNumber', 'eth_chainId']);
    expect(batches.find(batch => batch.signal === second.signal)?.methods).toEqual(['net_version']);
  });
});
