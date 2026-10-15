import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { Store } from '../src/store.js';
import { AegisService } from '../src/service.js';
import { createApiServer } from '../src/server.js';
import { loadConfig, LOCAL_AGENT_KEY, type Config } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import type { Gateway, Snapshot, Quote, Prepared, Outcome } from '../src/chain.js';
import type { Task } from '@aegis/shared';

const OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const owner = privateKeyToAccount(OWNER_KEY);
const agent = privateKeyToAccount(LOCAL_AGENT_KEY);
const recipient = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const wallet = '0x1000000000000000000000000000000000000001' as Address;
const blockHash = keccak256(toHex('block'));
function config(dbPath = ':memory:'): Config {
  return { ...loadConfig({}), dbPath, port: 0, deploymentReady: true, walletAddress: wallet, ownerAddress: owner.address, agentAddress: agent.address, recipientAddress: recipient };
}
class FakeChain implements Gateway {
  preparations = 0; broadcasts = 0; mined = false; queue = false; missingEvent = false;
  timeoutAfterBroadcast = false; unavailable = false; policyChanged = false;
  autoMine = true;
  beforeBroadcast?: (raw: Hex) => void;
  readonly raw = toHex('signed transaction fixture');
  readonly hash = keccak256(this.raw);
  async readiness() { return { ready: !this.unavailable }; }
  async snapshot(): Promise<Snapshot> {
    if (this.unavailable) throw new ApiError(503, 'CHAIN_UNAVAILABLE', 'RPC unavailable');
    return { chainId: 31337, walletAddress: wallet, ownerAddress: owner.address, agentAddress: agent.address, walletBalanceWei: '1000000000000000000', agentBalanceWei: '1000000000000000000', recipientBalanceWei: '0', policyVersion: '1', budget: { autoThresholdUsd6: '5000000', hardPerTxUsd6: '10000000', dailyLimitUsd6: '20000000', spentTodayUsd6: '0', remainingUsd6: '20000000', window: 'UTC_CALENDAR_DAY' }, observedBlockNumber: '1', observedBlockHash: blockHash, observedAt: new Date().toISOString(), dataSource: 'chain' };
  }
  async preview(to: Address, amountWei: string): Promise<Omit<Quote, 'quoteId' | 'draftId' | 'draftVersion'>> {
    const snapshot = await this.snapshot(); const now = Math.floor(Date.now() / 1000);
    return { status: 'READY', chainId: 31337, walletAddress: wallet, agentAddress: agent.address, recipient: to, to, amountWei, costUsd6: '3000000', maxUsdCost6: '3030000', policyVersion: '1', requestDeadlineSeconds: now + 600, quoteExpiresAtSeconds: now + 60, requestNonce: null, requestHash: null, decision: this.queue ? 'OWNER_APPROVAL' : 'AUTO', reasonCodes: [], budget: snapshot.budget, feedAddress: wallet, feedDecimals: 8, priceAnswer: '300000000000', roundId: '1', updatedAtSeconds: now, observedBlockNumber: '1', observedBlockHash: blockHash, oracle: {}, triggerType: 'manual', ruleId: null };
  }
  async prepare(): Promise<Prepared> {
    this.preparations++;
    if (this.policyChanged) throw new ApiError(409, 'POLICY_CHANGED', 'Policy version changed');
    return { rawTransaction: this.raw, hash: this.hash, senderNonce: '0', requestNonce: '0', requestHash: keccak256(toHex('bound intent')) };
  }
  async broadcast(raw: Hex) {
    this.beforeBroadcast?.(raw); this.broadcasts++; this.mined = this.autoMine;
    if (this.timeoutAfterBroadcast) throw new Error('RPC timeout after accept');
    return this.hash;
  }
  async outcome(task: Task, hash: Hex, role: 'request' | 'approve' | 'cancel'): Promise<Outcome | null> {
    if (!this.mined) return null;
    if (role !== 'request' && hash !== keccak256(toHex('owner tx'))) throw new ApiError(422, 'TX_BINDING_MISMATCH', 'Not the owner transaction');
    const event = this.missingEvent ? undefined : role === 'cancel' ? 'NativeTransferCancelled' : this.queue && role === 'request' ? 'NativeTransferQueued' : 'NativeTransferExecuted';
    return { status: this.missingEvent ? 'FAILED' : role === 'cancel' ? 'CANCELLED' : this.queue && role === 'request' ? 'AWAITING_APPROVAL' : 'EXECUTED', transaction: { role, hash, receiptStatus: 1, event, blockNumber: '2', blockHash, finality: 'mined' }, attestationId: '1', reasonCode: this.missingEvent ? 'EXPECTED_EVENT_MISSING' : undefined, eventData: event ? { requestHash: task.requestHash!, amountWei: task.amountWei } : undefined };
  }
  ownerTx(task: Task, action: 'approve' | 'cancel') { return { to: wallet, data: '0x1234' as Hex, value: '0', from: owner.address, chainId: 31337, action }; }
}
async function setup(options: { dbPath?: string; chain?: FakeChain; cfg?: Config } = {}) {
  const cfg = options.cfg ?? config(options.dbPath);
  const store = new Store(cfg.dbPath); const chain = options.chain ?? new FakeChain();
  const service = new AegisService(cfg, store, chain); const server = createApiServer(service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let token: string | undefined;
  async function call(path: string, method = 'GET', body?: unknown, key = 'test-key-0001', authorization = token) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any>, replay: response.headers.get('idempotency-replayed') };
  }
  async function login() {
    const challenge = await call('/auth/challenge', 'POST', { address: owner.address, chainId: 31337 });
    const signature = await owner.signMessage({ message: challenge.body.message });
    const verified = await call('/auth/verify', 'POST', { address: owner.address, challengeId: challenge.body.challengeId, signature });
    assert.equal(verified.status, 200); token = verified.body.token;
    return { challenge, signature, verified };
  }
  async function draftAndSubmit() {
    const draft = await call('/intents', 'POST', { recipient, amountWei: '1000000000000000' }, 'create-pay-0001');
    const preview = await call(`/intents/${draft.body.draftId}/preview`, 'POST', { expectedRevision: 1 }, 'preview-pay-0001');
    const submit = await call(`/intents/${draft.body.draftId}/submit`, 'POST', { expectedRevision: 1, quoteId: preview.body.quoteId }, 'submit-pay-0001');
    assert.equal(submit.status, 202);
    return { draft, preview, submit };
  }
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
  return { cfg, store, chain, service, call, login, draftAndSubmit, close };
}

test('owner login uses real signatures, one-time challenge, chain binding, and protected HTTP routes', async () => {
  const app = await setup();
  try {
    assert.equal((await app.call('/tasks')).status, 401);
    assert.equal((await app.call('/auth/challenge', 'POST', { address: recipient, chainId: 31337 })).status, 403);
    assert.equal((await app.call('/auth/challenge', 'POST', { address: owner.address, chainId: 1 })).status, 409);
    const { challenge, signature } = await app.login();
    assert.match(challenge.body.message, /Domain: localhost/); assert.match(challenge.body.message, /Chain ID: 31337/); assert.match(challenge.body.message, /Expiration Time:/);
    assert.equal((await app.call('/auth/verify', 'POST', { address: owner.address, challengeId: challenge.body.challengeId, signature })).status, 401);
    assert.equal((await app.call('/tasks')).status, 200);
    const newChallenge = await app.call('/auth/challenge', 'POST', { address: owner.address });
    assert.equal((await app.call('/auth/verify', 'POST', { address: owner.address, challengeId: newChallenge.body.challengeId, signature: '0x1234' })).status, 401);
  } finally { await app.close(); }
});
test('USD is never ETH; rule fallback is explicit and revision changes invalidate old drafts', async () => {
  const cfg = config(); cfg.configuredModel = 'unavailable-model'; const app = await setup({ cfg });
  try {
    await app.login();
    const first = await app.call('/intents', 'POST', { message: `Send 10 USD to ${recipient}` });
    assert.equal(first.body.status, 'NEEDS_INPUT'); assert.equal(first.body.amountWei, null);
    assert.equal(first.body.parser.kind, 'rule_parser'); assert.equal(first.body.parser.model, null); assert.equal(first.body.parser.fallback, true);
    const changed = await app.call(`/intents/${first.body.draftId}`, 'PATCH', { expectedRevision: 1, amountWei: '1000000000000000' });
    assert.equal(changed.body.version, 2); assert.equal(changed.body.status, 'DRAFT');
    const stale = await app.call(`/intents/${first.body.draftId}/preview`, 'POST', { expectedRevision: 1 });
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
    const decimalWei = await app.call('/intents', 'POST', { recipient, amountWei: '0.1' }, 'bad-decimal-0001');
    assert.equal(decimalWei.status, 400);
    const negative = await app.call('/intents', 'POST', { message: `send -1 ETH to ${recipient}` }, 'negative-eth-0001');
    assert.equal(negative.body.status, 'NEEDS_INPUT'); assert.equal(negative.body.amountWei, null);
    const excessPrecision = await app.call('/intents', 'POST', { message: `send 0.1000000000000000001 ETH to ${recipient}` }, 'precision-eth-0001');
    assert.equal(excessPrecision.body.status, 'NEEDS_INPUT'); assert.equal(excessPrecision.body.amountWei, null);
  } finally { await app.close(); }
});
test('idempotent writes return the same entity; different contents conflict; duplicate submit cannot double pay', async () => {
  const app = await setup();
  try {
    await app.login();
    const one = await app.call('/intents', 'POST', { recipient, amountWei: '1' }, 'same-key-00001');
    const two = await app.call('/intents', 'POST', { amountWei: '1', recipient }, 'same-key-00001');
    assert.equal(one.body.draftId, two.body.draftId); assert.equal(two.replay, 'true');
    const conflict = await app.call('/intents', 'POST', { recipient, amountWei: '2' }, 'same-key-00001');
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    const { draft, preview, submit } = await app.draftAndSubmit();
    const double = await app.call(`/intents/${draft.body.draftId}/submit`, 'POST', { expectedRevision: 1, quoteId: preview.body.quoteId }, 'different-submit-key');
    assert.equal(double.body.taskId, submit.body.taskId);
    app.chain.beforeBroadcast = raw => { const saved = app.service.getTask(owner.address, submit.body.taskId); assert.equal(saved.rawTransaction, raw); assert.equal(saved.txHash, keccak256(raw)); assert.equal(saved.requestNonce, '0'); };
    await app.service.tick(); await app.service.tick();
    const task = await app.call(`/tasks/${submit.body.taskId}`);
    assert.equal(task.body.status, 'EXECUTED'); assert.equal(app.chain.preparations, 1); assert.equal(app.chain.broadcasts, 1);
    assert.equal(task.body.rawTransaction, undefined); assert.equal(task.body.verification.chainVerified, true);
    assert.throws(() => app.service.getTask(recipient, submit.body.taskId), /找不到/);
  } finally { await app.close(); }
});
test('accepted broadcast followed by timeout survives SQLite restart without re-signing or a second payment', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-recovery-')); const path = join(directory, 'state.sqlite');
  const chain = new FakeChain(); chain.timeoutAfterBroadcast = true;
  const first = await setup({ dbPath: path, chain }); let taskId: string;
  try {
    await first.login(); const created = await first.draftAndSubmit(); taskId = created.submit.body.taskId;
    await first.service.tick(); assert.equal(first.service.getTask(owner.address, taskId).status, 'UNKNOWN');
  } finally { await first.close(); }
  const second = await setup({ dbPath: path, chain });
  try {
    await second.login(); await second.service.tick();
    const task = await second.call(`/tasks/${taskId!}`);
    assert.equal(task.body.status, 'EXECUTED'); assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 1);
  } finally { await second.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('receipt success without the expected business event is not a successful payment', async () => {
  const chain = new FakeChain(); chain.missingEvent = true; const app = await setup({ chain });
  try {
    await app.login(); const { submit } = await app.draftAndSubmit(); await app.service.tick(); await app.service.tick();
    const task = await app.call(`/tasks/${submit.body.taskId}`);
    assert.equal(task.body.status, 'FAILED'); assert.deepEqual(task.body.reasonCodes, ['EXPECTED_EVENT_MISSING']); assert.equal(task.body.verification.chainVerified, false);
  } finally { await app.close(); }
});
test('owner approval is browser transaction data and observed hashes must belong to the pending task', async () => {
  const chain = new FakeChain(); chain.queue = true; const app = await setup({ chain });
  try {
    await app.login(); const { submit } = await app.draftAndSubmit(); await app.service.tick(); await app.service.tick();
    const id = submit.body.taskId;
    assert.equal((await app.call(`/tasks/${id}`)).body.status, 'AWAITING_APPROVAL');
    const ownerTx = await app.call(`/tasks/${id}/owner-tx?action=approve`);
    assert.equal(ownerTx.body.from, owner.address); assert.equal(ownerTx.body.value, '0'); assert.equal(ownerTx.body.approvalMode, 'owner_approve_and_execute');
    assert.equal((await app.call(`/tasks/${id}/observed-tx`, 'POST', { action: 'approve', txHash: keccak256(toHex('other tx')) })).status, 422);
    const approved = await app.call(`/tasks/${id}/observed-tx`, 'POST', { action: 'approve', txHash: keccak256(toHex('owner tx')) }, 'observed-real-0001');
    assert.equal(approved.body.status, 'EXECUTED'); assert.equal(chain.broadcasts, 1);
  } finally { await app.close(); }
});
test('policy change fails before broadcast and RPC failure never silently switches to mock', async () => {
  const app = await setup();
  try {
    await app.login(); const { submit } = await app.draftAndSubmit(); app.chain.policyChanged = true; await app.service.tick();
    assert.equal((await app.call(`/tasks/${submit.body.taskId}`)).body.status, 'REQUOTE_REQUIRED'); assert.equal(app.chain.broadcasts, 0);
    app.chain.unavailable = true;
    const state = await app.call('/wallets/current'); assert.equal(state.status, 503); assert.equal(state.body.mode, 'local_chain');
    assert.equal((await app.call('/health')).status, 503);
  } finally { await app.close(); }
});
test('an unresolved agent transaction blocks another nonce allocation and expired quotes never submit', async () => {
  const chain = new FakeChain(); chain.autoMine = false; const app = await setup({ chain });
  try {
    await app.login(); const first = await app.draftAndSubmit();
    const draft = await app.call('/intents', 'POST', { recipient, amountWei: '2' }, 'second-create-001');
    const preview = await app.call(`/intents/${draft.body.draftId}/preview`, 'POST', { expectedRevision: 1 }, 'second-preview-001');
    const expired = { ...preview.body, quoteExpiresAtSeconds: Math.floor(Date.now() / 1000) - 1 };
    app.store.put('quote', preview.body.quoteId, owner.address, expired);
    assert.equal((await app.call(`/intents/${draft.body.draftId}/submit`, 'POST', { expectedRevision: 1, quoteId: preview.body.quoteId }, 'expired-submit-001')).status, 409);
    app.store.put('quote', preview.body.quoteId, owner.address, preview.body);
    const second = await app.call(`/intents/${draft.body.draftId}/submit`, 'POST', { expectedRevision: 1, quoteId: preview.body.quoteId }, 'second-submit-001');
    await app.service.tick(); await app.service.tick();
    assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 1);
    assert.equal((await app.call(`/tasks/${first.submit.body.taskId}`)).body.status, 'BROADCAST');
    assert.equal((await app.call(`/tasks/${second.body.taskId}`)).body.status, 'SUBMITTING');
  } finally { await app.close(); }
});
