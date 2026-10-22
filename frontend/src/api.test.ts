import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const owner = '0x1111111111111111111111111111111111111111';
const wallet = '0x2222222222222222222222222222222222222222';
const recipient = '0x3333333333333333333333333333333333333333';
const agent = '0x4444444444444444444444444444444444444444';
const config = {
  mode: 'local_chain', chainId: 31337, ownerAddress: owner, walletAddress: wallet,
  recipientAddress: recipient, agentAddress: agent, rpcUrl: 'http://127.0.0.1:8545',
  readiness: { ready: true, rpcChainId: 31337, contractsDeployed: true, deploymentBindingsVerified: true },
};
const draft = { draftId: 'draft-1', status: 'READY', revision: 1, recipient, amountWei: '1', purpose: 'reserve' };
const task = { taskId: 'task-1', status: 'SUBMITTING', chainId: 31337, ownerAddress: owner, walletAddress: wallet, recipient, agentAddress: agent, amountWei: '1', maxUsdCost6: '2' };
const snapshot = {
  chainId: 31337, walletAddress: wallet, recipientAddress: recipient, recipientBalanceWei: '0',
  observedBlockNumber: '1', observedBlockHash: `0x${'ab'.repeat(32)}`, observedAt: '2026-10-21T00:00:00Z', dataSource: 'chain',
};
const quote = {
  quoteId: 'quote-1', draftId: 'draft-1', draftVersion: 1, status: 'READY', chainId: 31337,
  walletAddress: wallet, recipient, amountWei: '1', maxUsdCost6: '2', decision: 'AUTO', quoteExpiresAtSeconds: 1_900_000_000,
};
const ownerTx = { from: owner, to: wallet, data: '0x1234', value: '0', chainId: 31337, action: 'approve' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let storage: MemoryStorage;
let fetchMock = vi.fn<typeof fetch>();
let client: typeof import('./api');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  storage = new MemoryStorage();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.stubGlobal('fetch', fetchMock);
  client = await import('./api');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('validated API responses', () => {
  it('preserves validated data and server metadata and sends the session header', async () => {
    client.setToken('fixture-token');
    fetchMock.mockResolvedValue(json({ ...config, schemaVersion: 'aegis.v1', requestId: 'fixture-request' }));
    await expect(client.api('/config')).resolves.toMatchObject({ ...config, requestId: 'fixture-request' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/config', expect.objectContaining({
      credentials: 'same-origin', headers: { Accept: 'application/json', Authorization: 'Bearer fixture-token' },
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts an empty response for a route without required business fields', async () => {
    fetchMock.mockResolvedValue(new Response(''));
    await expect(client.api('/health')).resolves.toEqual({});
  });

  it.each(['<html>bad gateway</html>', 'null', '[]', '42', 'true', '"success"'])('rejects malformed or non-object JSON: %s', async raw => {
    fetchMock.mockResolvedValue(new Response(raw));
    await expect(client.api('/health')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { path: '/config', body: config },
    { path: '/auth/challenge', body: { challengeId: 'fixture-challenge', message: 'Fixture login' } },
    { path: '/auth/verify', body: { token: 'fixture-token', address: owner, chainId: 31337 } },
    { path: '/wallets/current', body: snapshot },
    { path: '/tasks', body: { tasks: [task] } },
    { path: '/tasks/task-1', body: task },
    { path: '/tasks/task-1/owner-tx?action=approve', body: ownerTx },
    { path: '/intents/draft-1', body: draft },
    { path: '/intents/draft-1/preview', body: quote },
    { path: '/intents/draft-1/submit', body: task },
  ])('accepts the documented core response for $path', async ({ path, body }) => {
    fetchMock.mockResolvedValue(json(body));
    await expect(client.api(path)).resolves.toEqual(body);
  });

  it.each([
    { path: '/config', body: {} },
    { path: '/config', body: { ...config, chainId: '31337' } },
    { path: '/config', body: { ...config, rpcUrl: 'javascript:alert(1)' } },
    { path: '/config', body: { ...config, ownerAddress: '0x12' } },
    { path: '/auth/challenge', body: { challengeId: 'fixture', message: '' } },
    { path: '/auth/verify', body: { token: 'bad\r\ntoken', address: owner, chainId: 31337 } },
    { path: '/wallets/current', body: { ...snapshot, recipientBalanceWei: '-1' } },
    { path: '/wallets/current', body: { ...snapshot, recipientBalanceWei: 'not-a-number' } },
    { path: '/wallets/current', body: { ...snapshot, recipientBalanceWei: (2n ** 256n).toString() } },
    { path: '/wallets/current', body: { ...snapshot, observedBlockHash: '0x1234' } },
    { path: '/tasks', body: { tasks: [null] } },
    { path: '/tasks/task-1', body: { ...task, status: 'PAID_PROBABLY' } },
    { path: '/tasks/task-1/owner-tx?action=approve', body: { ...ownerTx, value: '1' } },
    { path: '/tasks/task-1/owner-tx?action=approve', body: { ...ownerTx, data: '0x123' } },
    { path: '/intents/draft-1', body: { ...draft, revision: 0 } },
    { path: '/intents/draft-1/preview', body: { ...quote, quoteExpiresAtSeconds: 'later' } },
  ])('rejects invalid business data for $path', async ({ path, body }) => {
    fetchMock.mockResolvedValue(json(body));
    await expect(client.api(path)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('accepts a needs-input draft without inventing executable fields', async () => {
    const incomplete = { ...draft, status: 'NEEDS_INPUT', recipient: null, amountWei: null, purpose: '', missingFields: ['recipient', 'amountWei'], question: 'Recipient?' };
    fetchMock.mockResolvedValue(json(incomplete));
    await expect(client.api('/intents', 'POST', { message: 'help' })).resolves.toEqual(incomplete);
  });

  it.each([
    { field: 'recipientAddress', value: undefined, message: '缺少运行钱包地址' },
    { field: 'recipientAddress', value: null, message: '缺少运行钱包地址' },
    { field: 'recipientAddress', value: '0x1234', message: '缺少运行钱包地址' },
    { field: 'recipientBalanceWei', value: undefined, message: '运行钱包余额' },
    { field: 'recipientBalanceWei', value: '-1', message: '运行钱包余额' },
    { field: 'walletAddress', value: 'invalid', message: '钱包身份' },
    { field: 'observedBlockHash', value: '0x1234', message: '观测区块或时间' },
    { field: 'observedAt', value: 'invalid', message: '观测区块或时间' },
  ])('explains invalid snapshot $field without treating it as zero', async ({ field, value, message }) => {
    fetchMock.mockResolvedValue(json({ ...snapshot, [field]: value }));
    await expect(client.api('/wallets/current')).rejects.toMatchObject({
      status: 200, code: 'INVALID_RESPONSE', message: expect.stringContaining(message),
    });
    fetchMock.mockResolvedValue(json({ ...snapshot, [field]: value }));
    await expect(client.api('/wallets/current')).rejects.toMatchObject({ message: expect.stringContaining('不按 0 处理') });
  });

  it('validates evidence hashes and intent identity', async () => {
    const evidence = { taskId: 'task-1', status: 'EXECUTED', chainId: 31337,
      verification: { kind: 'chain', chainVerified: true, hashVerified: true },
      intent: { recipient, amountWei: '1', walletAddress: wallet }, transactions: [{ role: 'request', hash: `0x${'ab'.repeat(32)}` }] };
    fetchMock.mockResolvedValueOnce(json(evidence)).mockResolvedValueOnce(json({ ...evidence, transactions: [{ role: 'request', hash: '0xbad' }] }));
    await expect(client.api('/tasks/task-1/evidence')).resolves.toEqual(evidence);
    await expect(client.api('/tasks/task-1/evidence')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('errors, retries, and deadlines', () => {
  it.each([
    { status: 409, body: { error: { code: 'REVISION_CONFLICT', message: 'Read the current draft', details: { currentRevision: 2 } } }, code: 'REVISION_CONFLICT' },
    { status: 404, body: { code: 'NOT_FOUND', message: 'Missing task' }, code: 'NOT_FOUND' },
    { status: 403, body: { code: 'FORBIDDEN', message: 'Not allowed', error: null }, code: 'FORBIDDEN' },
  ])('preserves a validated error response ($status)', async ({ status, body, code }) => {
    fetchMock.mockResolvedValue(json(body, status));
    await expect(client.api('/health')).rejects.toMatchObject({ status, code });
  });

  it('rejects malformed error envelopes without coercing objects into messages', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: {}, message: ['invalid'] } }, 503));
    await expect(client.api('/health')).rejects.toMatchObject({ status: 503, code: 'INVALID_RESPONSE' });
  });

  it('clears an expired session even when the unauthorized response is malformed', async () => {
    client.setToken('old-token');
    fetchMock.mockResolvedValue(new Response('not-json', { status: 401 }));
    await expect(client.api('/tasks')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(client.hasSession()).toBe(false);
    expect(storage.getItem('aegis.session')).toBeNull();
  });

  it.each([false, true])('keeps a newer token after a delayed old 401, with blocked storage=%s', async blocked => {
    if (blocked) vi.stubGlobal('sessionStorage', {
      getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); }, removeItem() { throw new Error('Storage blocked'); },
    });
    let complete: (response: Response) => void = () => { throw new Error('Deferred response not initialized'); };
    const delayed = new Promise<Response>(resolve => { complete = resolve; });
    fetchMock.mockReturnValueOnce(delayed).mockResolvedValueOnce(json({ ok: true }));
    client.setToken('old-token');
    const oldRequest = client.api('/tasks').catch((error: unknown) => error);
    client.setToken('new-token');
    complete(json({ error: { code: 'SESSION_EXPIRED', message: 'Old session expired' } }, 401));
    await expect(oldRequest).resolves.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
    expect(client.hasSession()).toBe(true);
    if (!blocked) expect(storage.getItem('aegis.session')).toBe('new-token');
    await client.api('/health');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer old-token');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer new-token');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports transport failures as offline and clears the deadline', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network unavailable'));
    await expect(client.api('/health')).rejects.toMatchObject({ status: 0, code: 'OFFLINE' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { path: '/intents', method: 'POST', message: '意图解析等待超时' },
    { path: '/intents/draft-1/submit', method: 'POST', message: '不能据此判断付款结果' },
  ])('reports an elapsed $path deadline without claiming a payment result', async ({ path, method, message }) => {
    fetchMock.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const result = client.api(path, method, {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    const error = await result;
    expect(error).toBeInstanceOf(client.ApiError);
    expect(error).toMatchObject({ code: 'REQUEST_TIMEOUT', message: expect.stringContaining(message) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('extends only intent parsing to 35 seconds and resets when live planning is disabled', async () => {
    const schedule = vi.spyOn(window, 'setTimeout');
    fetchMock.mockResolvedValueOnce(json({ ...config, planner: { mode: 'live', timeoutMs: 30_000 } }))
      .mockResolvedValueOnce(json(draft)).mockResolvedValueOnce(json(draft)).mockResolvedValueOnce(json(task))
      .mockResolvedValueOnce(json({ ...config, planner: { mode: 'off', timeoutMs: 30_000 } })).mockResolvedValueOnce(json(draft));
    await client.api('/config');
    await client.api('/intents', 'POST', { message: 'first' });
    await client.api('/intents/draft-1', 'PATCH', { message: 'correction', expectedRevision: 1 });
    await client.api('/intents/draft-1/submit', 'POST', { quoteId: 'quote-1', expectedRevision: 1 });
    await client.api('/config');
    await client.api('/intents', 'POST', { message: 'rules only' });
    expect(schedule.mock.calls.map(call => call[1])).toEqual([12_000, 35_000, 35_000, 12_000, 12_000, 12_000]);
  });

  it('gives validated Sepolia chain reads time to finish without extending ordinary writes', () => {
    expect(client.requestDeadlineMs('/wallets/current', 'GET')).toBe(45_000);
    expect(client.requestDeadlineMs('/intents/draft-1/preview', 'POST')).toBe(45_000);
    expect(client.requestDeadlineMs('/tasks/task-1/owner-tx?action=approve', 'GET')).toBe(45_000);
    expect(client.requestDeadlineMs('/tasks/task-1/observed-tx', 'POST')).toBe(45_000);
    expect(client.requestDeadlineMs('/intents/draft-1/submit', 'POST')).toBe(12_000);
    expect(client.requestDeadlineMs('', 'GET')).toBe(12_000);
  });

  it.each([0, 30_001, '30000'])('rejects an invalid planner budget: %s', async timeoutMs => {
    fetchMock.mockResolvedValue(json({ ...config, planner: { mode: 'live', timeoutMs } }));
    await expect(client.api('/config')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reuses the same mutation key after a server failure, then rotates after success', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'BUSY', message: 'Try again' } }, 503))
      .mockResolvedValueOnce(json(draft)).mockResolvedValueOnce(json(draft));
    await expect(client.api('/intents', 'POST', { message: 'same request' })).rejects.toMatchObject({ code: 'BUSY' });
    await client.api('/intents', 'POST', { message: 'same request' });
    await client.api('/intents', 'POST', { message: 'same request' });
    const keys = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('Idempotency-Key'));
    expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]); expect(keys[2]).not.toBe(keys[1]);
  });

  it('retains a mutation key after an unreadable success response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('broken-json')).mockResolvedValueOnce(json(draft));
    await expect(client.api('/intents', 'POST', { message: 'same request' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await client.api('/intents', 'POST', { message: 'same request' });
    const keys = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('Idempotency-Key'));
    expect(keys[1]).toBe(keys[0]);
  });

  it('rotates a mutation key after a definite client error', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'INVALID_REQUEST', message: 'Fix request' } }, 400)).mockResolvedValueOnce(json(draft));
    await expect(client.api('/intents', 'POST', { message: 'same request' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await client.api('/intents', 'POST', { message: 'same request' });
    const keys = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('Idempotency-Key'));
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe('session storage and request boundaries', () => {
  it('loads a valid stored session', async () => {
    storage.setItem('aegis.session', 'restored-token');
    vi.resetModules();
    const restored = await import('./api');
    expect(restored.hasSession()).toBe(true);
    fetchMock.mockResolvedValue(json({ ok: true }));
    await restored.api('/health');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer restored-token');
  });

  it.each(['', ' ', 'bad\ntoken', 'x'.repeat(4097)])('rejects invalid stored tokens', async raw => {
    storage.setItem('aegis.session', raw);
    vi.resetModules();
    const restored = await import('./api');
    expect(restored.hasSession()).toBe(false);
    expect(storage.getItem('aegis.session')).toBeNull();
  });

  it('tolerates unavailable session storage during initialization and token updates', async () => {
    const unavailable = { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); }, removeItem() { throw new Error('Storage blocked'); } };
    vi.stubGlobal('sessionStorage', unavailable);
    vi.resetModules();
    const isolated = await import('./api');
    expect(isolated.hasSession()).toBe(false);
    expect(() => isolated.setToken('in-memory-token')).not.toThrow();
    expect(isolated.hasSession()).toBe(true);
    expect(() => isolated.setToken('')).not.toThrow();
    expect(isolated.hasSession()).toBe(false);
  });

  it('rejects an invalid token setter and clears the previous session', () => {
    client.setToken('valid-token');
    expect(() => client.setToken('bad token')).toThrow(client.ApiError);
    expect(client.hasSession()).toBe(false);
    expect(storage.getItem('aegis.session')).toBeNull();
  });

  it.each([
    { path: 'https://example.invalid/collect', method: 'GET', body: undefined },
    { path: '//example.invalid/collect', method: 'GET', body: undefined },
    { path: '/tasks', method: 'DELETE', body: undefined },
    { path: '/intents', method: 'POST', body: { amountWei: 1n } },
    { path: '/intents', method: 'POST', body: { amountWei: Number.NaN } },
  ])('rejects invalid request data before fetch: $path $method', async ({ path, method, body }) => {
    await expect(client.api(path, method, body)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a circular request before validation or fetch', async () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    await expect(client.api('/intents', 'POST', circular)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
