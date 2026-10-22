import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import type { Gateway } from '../src/chain.js';
import { loadConfig, type Config } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { createApiServer } from '../src/server.js';
import { AegisService } from '../src/service.js';
import { Store } from '../src/store.js';

// Explicit fake gateway and the public development signing key: these HTTP
// boundary tests contact no Sepolia RPC and provide no testnet payment proof.
const owner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const recipient = '0x3333333333333333333333333333333333333333';
const ready = {
  ready: true, rpcChainId: 11155111, contractsDeployed: true,
  deploymentBindingsVerified: true, executorAuthorized: true,
  executorConfigured: true, feedFresh: true, walletFunded: true, executorFunded: true,
};
class DisplayGateway implements Gateway {
  checks = 0;
  previews = 0;
  broadcasts = 0;
  result: Promise<Record<string, unknown>> = Promise.resolve(ready);
  async readiness() { this.checks++; return this.result; }
  async snapshot(): Promise<never> { throw new Error('No snapshot in display fixture'); }
  async preview(): Promise<never> { this.previews++; throw new ApiError(503, 'FEED_STALE', 'Fresh preview rejects the price'); }
  async prepare(): Promise<never> { throw new Error('No transaction preparation in display fixture'); }
  async broadcast(): Promise<never> { this.broadcasts++; throw new Error('No transaction broadcasting in display fixture'); }
  async outcome(): Promise<never> { throw new Error('No transaction observation in display fixture'); }
  ownerTx(): never { throw new Error('No owner transaction in display fixture'); }
}
async function setup() {
  const cfg: Config = {
    ...loadConfig({}), mode: 'testnet', chainId: 11155111, port: 0, dbPath: ':memory:',
    deploymentReady: true, ownerAddress: owner.address,
    walletAddress: '0x2222222222222222222222222222222222222222', recipientAddress: recipient,
  };
  const store = new Store(':memory:');
  const gateway = new DisplayGateway();
  const service = new AegisService(cfg, store, gateway);
  const server = createApiServer(service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
  const port = address.port;
  async function call(path: string, method = 'GET', body?: unknown, token?: string) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method, headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Idempotency-Key': `fixture-${method}-${path.replaceAll('/', '-')}`,
      }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json();
    return { status: response.status, body: json };
  }
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
  return { gateway, call, close };
}
const displaySchema = z.object({ readiness: z.object({
  ready: z.boolean(), code: z.string().optional(), source: z.enum(['fresh', 'cache', 'checking', 'error']),
  checkedAt: z.string().nullable(), cacheAgeMs: z.number().int().nonnegative().nullable(),
}) });

test('Sepolia public config and health share one bounded pending sweep and recover from checking', async () => {
  const app = await setup();
  let release: (value: Record<string, unknown>) => void = () => { throw new Error('Gate not initialized'); };
  app.gateway.result = new Promise(resolve => { release = resolve; });
  try {
    const responses = await Promise.all([app.call('/config'), app.call('/health')]);
    assert.deepEqual(responses.map(row => row.status), [200, 503]);
    for (const response of responses) {
      assert.deepEqual(displaySchema.parse(response.body).readiness, {
        ready: false, code: 'READINESS_CHECKING', source: 'checking', checkedAt: null, cacheAgeMs: null,
      });
    }
    assert.equal(app.gateway.checks, 1);
    release(ready);
    const health = await app.call('/health');
    assert.equal(health.status, 200);
    assert.equal(displaySchema.parse(health.body).readiness.ready, true);
    assert.equal(app.gateway.checks, 1);
  } finally { release(ready); await app.close(); }
});

test('cached public readiness cannot authorize a preview after a fresh price failure', async () => {
  const app = await setup();
  try {
    assert.equal(displaySchema.parse((await app.call('/config')).body).readiness.ready, true);
    const challenge = z.object({ challengeId: z.string().uuid(), message: z.string() }).parse((await app.call('/auth/challenge', 'POST', { address: owner.address, chainId: 11155111 })).body);
    const signature = await owner.signMessage({ message: challenge.message });
    const login = await app.call('/auth/verify', 'POST', { challengeId: challenge.challengeId, address: owner.address, signature });
    assert.equal(login.status, 200);
    const { token } = z.object({ token: z.string().min(1) }).parse(login.body);
    const draft = await app.call('/intents', 'POST', { recipient, amountWei: '1' }, token);
    assert.equal(draft.status, 201);
    const { draftId, revision } = z.object({ draftId: z.string().uuid(), revision: z.number().int().positive() }).parse(draft.body);
    const preview = await app.call(`/intents/${draftId}/preview`, 'POST', { expectedRevision: revision }, token);
    assert.equal(preview.status, 503);
    assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(preview.body).error.code, 'FEED_STALE');
    assert.equal(app.gateway.previews, 1);
    assert.equal(app.gateway.checks, 1);
    assert.equal(app.gateway.broadcasts, 0);
  } finally { await app.close(); }
});
