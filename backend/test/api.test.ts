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
import { StubIntentClient, type LlmIntentClient } from '../src/llm.js';
import { z } from 'zod';
import type { Gateway, Snapshot, Quote, Prepared, Outcome } from '../src/chain.js';
import {
  POLICY_EVIDENCE_VERIFICATION_SCOPE, POLICY_EVIDENCE_VERIFIED_FIELDS,
  type PolicyEvidence, type Task,
} from '@aegis/shared';

const OWNER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const owner = privateKeyToAccount(OWNER_KEY);
const agent = privateKeyToAccount(LOCAL_AGENT_KEY);
const recipient = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const wallet = '0x1000000000000000000000000000000000000001' as Address;
const policyEngine = '0x7000000000000000000000000000000000000007' as Address;
const blockHash = keccak256(toHex('block'));
function config(dbPath = ':memory:'): Config {
  return { ...loadConfig({}), dbPath, port: 0, deploymentReady: true, walletAddress: wallet, policyEngineAddress: policyEngine, ownerAddress: owner.address, agentAddress: agent.address, recipientAddress: recipient };
}
class FakeChain implements Gateway {
  preparations = 0; broadcasts = 0; mined = false; queue = false; missingEvent = false;
  timeoutAfterBroadcast = false; unavailable = false; policyChanged = false;
  ownerOutcome: 'approve' | 'cancel' | null = null;
  ownerObservedRevert = false;
  ownerOutcomeChecks = 0;
  autoMine = true;
  beforeBroadcast?: (raw: Hex) => void;
  readonly raw = toHex('signed transaction fixture');
  readonly hash = keccak256(this.raw);
  async readiness() { return { ready: !this.unavailable }; }
  async snapshot(): Promise<Snapshot> {
    if (this.unavailable) throw new ApiError(503, 'CHAIN_UNAVAILABLE', 'RPC unavailable');
    return { chainId: 31337, walletAddress: wallet, ownerAddress: owner.address, agentAddress: agent.address, recipientAddress: recipient, walletBalanceWei: '1000000000000000000', agentBalanceWei: '1000000000000000000', recipientBalanceWei: '0', policyVersion: '1', budget: { autoThresholdUsd6: '5000000', hardPerTxUsd6: '10000000', dailyLimitUsd6: '20000000', spentTodayUsd6: '0', remainingUsd6: '20000000', window: 'UTC_CALENDAR_DAY' }, observedBlockNumber: '1', observedBlockHash: blockHash, observedAt: new Date().toISOString(), dataSource: 'chain' };
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
    if (role !== 'request' && this.ownerObservedRevert) {
      return { status: 'FAILED', transaction: { role, hash, receiptStatus: 0, blockNumber: '3', blockHash, finality: 'mined' }, reasonCode: 'TX_REVERTED' };
    }
    const event = this.missingEvent ? undefined : role === 'cancel' ? 'NativeTransferCancelled' : this.queue && role === 'request' ? 'NativeTransferQueued' : 'NativeTransferExecuted';
    const executed = event === 'NativeTransferExecuted';
    return {
      status: this.missingEvent ? 'FAILED' : role === 'cancel' ? 'CANCELLED' : this.queue && role === 'request' ? 'AWAITING_APPROVAL' : 'EXECUTED',
      transaction: { role, hash, receiptStatus: 1, event, blockNumber: '2', blockHash, finality: 'mined' },
      attestationId: '1', reasonCode: this.missingEvent ? 'EXPECTED_EVENT_MISSING' : undefined,
      eventData: event ? { requestHash: task.requestHash!, amountWei: task.amountWei } : undefined,
      policyEvidence: executed ? {
        engineAddress: policyEngine, event: 'BudgetConsumed', actionType: 'NATIVE_TRANSFER',
        decision: role === 'approve' ? 'REQUIRE_APPROVAL' : 'ALLOW', requestHash: task.requestHash!, actor: task.agentAddress,
        costUsd6: '3000000', day: '20000', spentUsd6: '3000000', transactionHash: hash,
        policyVersion: task.policyVersion, roundId: '1', updatedAtSeconds: '1999999999',
        blockNumber: '2', blockHash, logIndex: 0, verified: true,
        verificationScope: POLICY_EVIDENCE_VERIFICATION_SCOPE, verifiedFields: POLICY_EVIDENCE_VERIFIED_FIELDS,
      } : undefined,
    };
  }
  async findOwnerOutcome(task: Task): Promise<Outcome | null> {
    this.ownerOutcomeChecks++;
    if (!this.ownerOutcome) return null;
    const action = this.ownerOutcome === 'cancel' ? 'cancel' : 'approve';
    const hash = keccak256(toHex(`discovered owner ${this.ownerOutcome}`));
    const event = action === 'cancel' ? 'NativeTransferCancelled' : 'NativeTransferExecuted';
    return {
      status: action === 'cancel' ? 'CANCELLED' : 'EXECUTED',
      transaction: { role: action, hash, receiptStatus: 1, event, blockNumber: '3', blockHash, finality: 'mined' },
      attestationId: task.attestationId ?? '1',
      eventData: { requestHash: task.requestHash!, amountWei: task.amountWei },
      policyEvidence: action === 'approve' ? {
        engineAddress: policyEngine, event: 'BudgetConsumed', actionType: 'NATIVE_TRANSFER', decision: 'REQUIRE_APPROVAL',
        requestHash: task.requestHash!, actor: task.agentAddress, costUsd6: '3000000', day: '20000', spentUsd6: '3000000',
        policyVersion: task.policyVersion, roundId: '1', updatedAtSeconds: '1999999999',
        transactionHash: hash, blockNumber: '3', blockHash, logIndex: 0, verified: true,
        verificationScope: POLICY_EVIDENCE_VERIFICATION_SCOPE, verifiedFields: POLICY_EVIDENCE_VERIFIED_FIELDS,
      } : undefined,
    };
  }
  ownerTx(task: Task, action: 'approve' | 'cancel') { return { to: wallet, data: '0x1234' as Hex, value: '0', from: owner.address, chainId: 31337, action }; }
}
async function setup(options: { dbPath?: string; chain?: FakeChain; cfg?: Config; llmClient?: LlmIntentClient } = {}) {
  const cfg = options.cfg ?? config(options.dbPath);
  const store = new Store(cfg.dbPath); const chain = options.chain ?? new FakeChain();
  const service = new AegisService(cfg, store, chain, options.llmClient); const server = createApiServer(service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let token: string | undefined;
  async function call(path: string, method = 'GET', body?: unknown, key: string | null = 'test-key-0001', authorization = token) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any>, replay: response.headers.get('idempotency-replayed') };
  }
  async function rawCall(path: string, init: RequestInit, authorization: string | null | undefined = token) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  async function login() {
    const challenge = await call('/auth/challenge', 'POST', { address: owner.address, chainId: 31337 });
    const signature = await owner.signMessage({ message: challenge.body.message });
    const verified = await call('/auth/verify', 'POST', { address: owner.address, challengeId: challenge.body.challengeId, signature });
    assert.equal(verified.status, 200); token = verified.body.token;
    return { challenge, signature, verified };
  }
  async function draftAndSubmit(suffix = 'pay-0001', amountWei = '1000000000000000') {
    const draft = await call('/intents', 'POST', { recipient, amountWei }, `create-${suffix}`);
    const preview = await call(`/intents/${draft.body.draftId}/preview`, 'POST', { expectedRevision: 1 }, `preview-${suffix}`);
    const submit = await call(`/intents/${draft.body.draftId}/submit`, 'POST', { expectedRevision: 1, quoteId: preview.body.quoteId }, `submit-${suffix}`);
    assert.equal(submit.status, 202);
    return { draft, preview, submit };
  }
  async function close() { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
  return { cfg, store, chain, service, call, rawCall, login, draftAndSubmit, close };
}

test('public configuration offers the development wallet only for the default local Owner', async () => {
  const publicConfig = z.object({ localTestWalletAvailable: z.boolean(), ownerAddress: z.string() });
  const cases: Array<{ mode: Config['mode']; chainId: number; ownerAddress: Address; expected: boolean }> = [
    { mode: 'local_chain', chainId: 31337, ownerAddress: owner.address, expected: true },
    { mode: 'local_chain', chainId: 31337, ownerAddress: recipient, expected: false },
    { mode: 'testnet', chainId: 11155111, ownerAddress: owner.address, expected: false },
    { mode: 'mock', chainId: 31337, ownerAddress: owner.address, expected: false },
  ];
  for (const row of cases) {
    const app = await setup({ cfg: { ...config(), mode: row.mode, chainId: row.chainId, ownerAddress: row.ownerAddress } });
    try {
      const response = await app.call('/config');
      assert.equal(response.status, 200);
      const body = publicConfig.parse(response.body);
      assert.equal(body.localTestWalletAvailable, row.expected);
      assert.equal(body.ownerAddress, row.ownerAddress);
    } finally { await app.close(); }
  }
});

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
test('authenticated wallet snapshot identifies the recipient whose balance was observed', async () => {
  const app = await setup();
  try {
    assert.equal((await app.call('/wallets/current')).status, 401);
    await app.login();
    const snapshot = await app.call('/wallets/current');
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.recipientAddress, recipient);
    assert.equal(snapshot.body.recipientBalanceWei, '0');
    assert.equal(snapshot.body.observedBlockNumber, '1');
    assert.equal(snapshot.body.observedBlockHash, blockHash);
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
    assert.equal(task.body.policyEvidence, undefined);
    const evidence = await app.call(`/tasks/${submit.body.taskId}/evidence`);
    assert.equal(evidence.body.policy.state, 'VERIFIED');
    assert.equal(evidence.body.policy.decision, 'ALLOW');
    assert.equal(evidence.body.policy.requestHash, task.body.requestHash);
    assert.equal(evidence.body.policy.engineAddress, policyEngine);
    assert.equal(evidence.body.policy.transactionHash, task.body.txHash);
    assert.equal(evidence.body.policy.verificationScope, POLICY_EVIDENCE_VERIFICATION_SCOPE);
    assert.deepEqual(evidence.body.policy.verifiedFields, POLICY_EVIDENCE_VERIFIED_FIELDS);
    assert.equal(evidence.body.policy.oracleAddress, undefined);
    assert.equal(evidence.body.policy.feedAddress, undefined);
    assert.deepEqual(evidence.body.configuredPriceSource, {
      oracleAddress: app.cfg.oracleAddress, feedAddress: app.cfg.feedAddress,
      verified: false, scope: 'CURRENT_CONFIGURATION',
    });
    assert.equal(evidence.body.previewPolicy.source, 'chain_read');
    assert.equal(evidence.body.previewPolicy.decision, 'ALLOW');
    assert.equal(evidence.body.previewPolicy.observedBlockNumber, '1');
    assert.equal(evidence.body.sources.evidence, 'wallet_and_policy_contract_events');
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
  const changedConfig = { ...config(path), oracleAddress: wallet, feedAddress: recipient };
  const second = await setup({ cfg: changedConfig, chain });
  try {
    await second.login(); await second.service.tick();
    const task = await second.call(`/tasks/${taskId!}`);
    assert.equal(task.body.status, 'EXECUTED'); assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 1);
    const evidence = await second.call(`/tasks/${taskId!}/evidence`);
    assert.equal(evidence.body.policy.verified, true);
    assert.equal(evidence.body.policy.decision, 'ALLOW');
    assert.equal(evidence.body.policy.policyVersion, '1');
    assert.equal(evidence.body.policy.roundId, '1');
    assert.equal(evidence.body.policy.updatedAtSeconds, '1999999999');
    assert.equal(evidence.body.policy.oracleAddress, undefined);
    assert.equal(evidence.body.policy.feedAddress, undefined);
    assert.deepEqual(evidence.body.configuredPriceSource, {
      oracleAddress: wallet, feedAddress: recipient, verified: false, scope: 'CURRENT_CONFIGURATION',
    });
  } finally { await second.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('legacy stored evidence drops configuration addresses from its verified receipt projection after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-legacy-evidence-')); const path = join(directory, 'state.sqlite');
  const first = await setup({ dbPath: path });
  let taskId = ''; let expectedPolicy: PolicyEvidence | undefined;
  try {
    await first.login(); const created = await first.draftAndSubmit(); taskId = created.submit.body.taskId;
    await first.service.tick(); await first.service.tick();
    const persisted = first.service.getTask(owner.address, taskId);
    assert.equal(persisted.status, 'EXECUTED');
    assert.ok(persisted.policyEvidence);
    expectedPolicy = persisted.policyEvidence;
    const legacyPolicy: Record<string, unknown> = { ...expectedPolicy, oracleAddress: wallet, feedAddress: recipient };
    delete legacyPolicy.verificationScope; delete legacyPolicy.verifiedFields;
    first.store.put('task', taskId, owner.address, { ...persisted, policyEvidence: legacyPolicy });
  } finally { await first.close(); }
  const second = await setup({ cfg: { ...config(path), oracleAddress: policyEngine, feedAddress: wallet } });
  try {
    await second.login();
    const evidence = await second.call(`/tasks/${taskId}/evidence`);
    assert.ok(expectedPolicy);
    assert.deepEqual(evidence.body.policy, { ...expectedPolicy, consumed: true, state: 'VERIFIED' });
    assert.deepEqual(evidence.body.configuredPriceSource, {
      oracleAddress: policyEngine, feedAddress: wallet, verified: false, scope: 'CURRENT_CONFIGURATION',
    });
  } finally { await second.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('a transaction persisted before broadcast is reused after service reconstruction and blocks the next nonce', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-prebroadcast-recovery-')); const path = join(directory, 'state.sqlite');
  const chain = new FakeChain(); chain.autoMine = false;
  const first = await setup({ dbPath: path, chain });
  let firstTaskId: string; let secondTaskId: string; let persisted: ReturnType<typeof first.service.getTask>;
  try {
    await first.login();
    firstTaskId = (await first.draftAndSubmit('first-payment-0001')).submit.body.taskId;
    secondTaskId = (await first.draftAndSubmit('second-payment-001', '2')).submit.body.taskId;

    const put = first.store.put.bind(first.store);
    first.store.put = ((kind: string, id: string, taskOwner: string, payload: unknown) => {
      put(kind, id, taskOwner, payload);
      if (kind === 'task' && payload && typeof payload === 'object' && 'rawTransaction' in payload) {
        throw new Error('injected stop after signed transaction persistence');
      }
    }) as Store['put'];

    await assert.rejects(first.service.tick(), /injected stop after signed transaction persistence/);
    persisted = first.service.getTask(owner.address, firstTaskId);
    assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 0);
    assert.equal(persisted.rawTransaction, chain.raw); assert.equal(persisted.txHash, chain.hash);
    assert.equal(persisted.senderNonce, '0'); assert.equal(persisted.requestNonce, '0');
    assert.equal(persisted.requestHash, keccak256(toHex('bound intent')));
    assert.equal(first.service.getTask(owner.address, secondTaskId).rawTransaction, undefined);
  } finally { await first.close(); }

  const second = await setup({ dbPath: path, chain });
  try {
    await second.login();
    const recovered = second.service.getTask(owner.address, firstTaskId!);
    assert.equal(recovered.rawTransaction, persisted!.rawTransaction);
    assert.equal(recovered.txHash, persisted!.txHash);
    assert.equal(recovered.senderNonce, persisted!.senderNonce);
    assert.equal(recovered.requestNonce, persisted!.requestNonce);
    assert.equal(recovered.requestHash, persisted!.requestHash);
    assert.equal(second.store.list<Task>('task', owner.address).length, 2);

    await second.service.tick();
    assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 1);
    assert.equal(second.service.getTask(owner.address, firstTaskId!).status, 'BROADCAST');
    assert.equal(second.service.getTask(owner.address, secondTaskId!).rawTransaction, undefined);

    chain.mined = true;
    await second.service.tick();
    assert.equal(second.service.getTask(owner.address, firstTaskId!).status, 'EXECUTED');
    assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 1);
  } finally { await second.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('owner outcomes discovered after restart complete or retain queued tasks without another agent payment', async t => {
  for (const scenario of [
    { outcome: 'approve' as const, expected: 'EXECUTED' },
    { outcome: 'cancel' as const, expected: 'CANCELLED' },
    { outcome: null, expected: 'AWAITING_APPROVAL' },
  ]) {
    await t.test(scenario.outcome ?? 'owner transaction not mined', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'aegis-owner-recovery-')); const path = join(directory, 'state.sqlite');
      const chain = new FakeChain(); chain.queue = true;
      const first = await setup({ dbPath: path, chain }); let taskId: string;
      try {
        await first.login(); taskId = (await first.draftAndSubmit()).submit.body.taskId;
        await first.service.tick(); await first.service.tick();
        const queued = first.service.getTask(owner.address, taskId);
        assert.equal(queued.status, 'AWAITING_APPROVAL'); assert.equal(queued.ownerObserved, undefined);
      } finally { await first.close(); }

      chain.ownerOutcome = scenario.outcome;
      const second = await setup({ dbPath: path, chain });
      try {
        await second.login(); await second.service.tick();
        const recovered = second.service.getTask(owner.address, taskId!);
        assert.equal(recovered.status, scenario.expected);
        const evidence = await second.call(`/tasks/${taskId!}/evidence`);
        if (scenario.outcome === 'approve') {
          assert.equal(evidence.body.policy.state, 'VERIFIED');
          assert.equal(evidence.body.policy.decision, 'REQUIRE_APPROVAL');
        } else {
          assert.equal(evidence.body.policy.consumed, false);
          assert.equal(evidence.body.policy.state, scenario.outcome === 'cancel' ? 'NOT_CONSUMED' : 'WAITING_FOR_EXECUTION');
        }
        assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 1);
        await second.service.tick();
        assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 1);
      } finally { await second.close(); rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
test('a reported owner transaction that later reverts stays queued after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-owner-revert-')); const path = join(directory, 'state.sqlite');
  const chain = new FakeChain(); chain.queue = true;
  const first = await setup({ dbPath: path, chain }); let taskId: string;
  try {
    await first.login(); taskId = (await first.draftAndSubmit()).submit.body.taskId;
    await first.service.tick(); await first.service.tick();
    chain.mined = false;
    const pending = await first.service.observed(owner.address, taskId, keccak256(toHex('owner tx')), 'approve');
    assert.equal(pending.status, 'AWAITING_APPROVAL'); assert.ok(pending.ownerObserved);
  } finally { await first.close(); }

  chain.mined = true; chain.ownerObservedRevert = true;
  const second = await setup({ dbPath: path, chain });
  try {
    await second.login(); await second.service.tick();
    const recovered = second.service.getTask(owner.address, taskId!);
    assert.equal(recovered.status, 'AWAITING_APPROVAL');
    assert.equal(recovered.lastError?.code, 'TX_REVERTED');
    assert.equal(recovered.ownerObserved, undefined);
    assert.equal(chain.preparations, 1); assert.equal(chain.broadcasts, 1);
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
test('HTTP boundaries reject malformed or unauthorized writes and never expose signing material', async () => {
  const cfg = config(); cfg.rpcUrl = 'http://rpc-user:rpc-password@127.0.0.1:8545';
  const chain = new FakeChain(); chain.autoMine = false;
  const app = await setup({ cfg, chain });
  try {
    const unauthorized = await app.rawCall('/intents', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'unauthorized-0001' },
      body: JSON.stringify({ recipient, amountWei: '1' }),
    }, null);
    assert.equal(unauthorized.status, 401); assert.equal(app.store.list<Task>('task').length, 0);

    const { verified } = await app.login();
    const missingKey = await app.call('/intents', 'POST', { recipient, amountWei: '1' }, null);
    assert.equal(missingKey.status, 400); assert.equal(missingKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const invalidKey = await app.call('/intents', 'POST', { recipient, amountWei: '1' }, 'bad key');
    assert.equal(invalidKey.status, 400); assert.equal(invalidKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const invalidJson = await app.rawCall('/intents', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-json-0001' }, body: '{',
    });
    assert.equal(invalidJson.status, 400); assert.equal(invalidJson.body.error.code, 'INVALID_JSON');
    const unknownField = await app.call('/intents', 'POST', { recipient, amountWei: '1', skipApproval: true }, 'unknown-field-01');
    assert.equal(unknownField.status, 400); assert.equal(unknownField.body.error.code, 'INVALID_REQUEST');
    assert.equal(app.store.list<Task>('task').length, 0);

    const { submit } = await app.draftAndSubmit(); await app.service.tick();
    const configResponse = await app.rawCall('/config', { method: 'GET' }, null);
    const list = await app.call('/tasks');
    const detail = await app.call(`/tasks/${submit.body.taskId}`);
    const evidence = await app.call(`/tasks/${submit.body.taskId}/evidence`);
    assert.equal(configResponse.body.rpcUrl, null);
    assert.ok(Array.isArray(configResponse.body.abi.policyEngine));
    for (const response of [configResponse, list, detail, evidence, unknownField]) {
      const payload = JSON.stringify(response.body);
      assert.equal(payload.includes(chain.raw), false);
      assert.equal(payload.includes(LOCAL_AGENT_KEY), false);
      assert.equal(payload.includes(verified.body.token), false);
    }
  } finally { await app.close(); }
});

test('LLM drafts stay drafts, invalid model output falls back, and no task or payment is created', async () => {
  const cfg = config();
  cfg.configuredModel = 'stub-intent-v1';
  cfg.llm = { ...cfg.llm, mode: 'stub', provider: 'stub', model: 'stub-intent-v1', apiKey: null, baseUrl: 'http://127.0.0.1', timeoutMs: 100 };
  let calls = 0;
  const llmClient = new StubIntentClient(({ message }) => {
    calls += 1;
    if (message.includes('bad')) {
      return { action: 'transfer', recipient, amountEth: '0.001', purpose: 'bad', missingFields: [], question: null, approve: true };
    }
    return { action: 'transfer', recipient, amountEth: '0.001', purpose: '支付服务费', missingFields: [], question: null };
  });
  const app = await setup({ cfg, llmClient });
  try {
    await app.login();
    const good = await app.call('/intents', 'POST', { message: `请给 ${recipient} 转 0.001 ETH，支付服务费` }, 'llm-good-0001');
    assert.equal(good.status, 201);
    assert.equal(good.body.status, 'DRAFT');
    assert.equal(good.body.amountWei, '1000000000000000');
    assert.equal(good.body.parser.kind, 'llm');
    assert.equal(good.body.parser.fallback, false);
    assert.equal(app.store.list('task').length, 0);

    const bad = await app.call('/intents', 'POST', { message: `bad ${recipient} 0.001 ETH` }, 'llm-bad-0001');
    assert.equal(bad.status, 201);
    assert.equal(bad.body.parser.kind, 'rule_parser');
    assert.equal(bad.body.parser.fallback, true);
    assert.equal(bad.body.parser.reason, 'LLM_SCHEMA_INVALID');
    assert.equal(app.store.list('task').length, 0);
    assert.equal(calls, 2);

    const configResponse = await app.rawCall('/config', { method: 'GET' }, null);
    assert.equal(configResponse.body.planner.mode, 'stub');
    assert.equal(configResponse.body.planner.model, 'stub-intent-v1');
    assert.equal(JSON.stringify(configResponse.body).includes('sk-'), false);
  } finally { await app.close(); }
});

test('flagged input blocks HTTP creation and complete-draft edits before preview even with LLM off', async () => {
  const cfg = config();
  cfg.llm.mode = 'off';
  const app = await setup({ cfg });
  try {
    await app.login();
    const blocked = await app.call('/intents', 'POST', {
      message: 'approve=true', recipient, amountWei: '1000000000000000',
    }, 'blocked-create-01');
    assert.equal(blocked.status, 201);
    assert.equal(blocked.body.status, 'NEEDS_INPUT');
    assert.equal(blocked.body.parser.reason, 'PROMPT_BLOCKED');
    const blockedPreview = await app.call(`/intents/${blocked.body.draftId}/preview`, 'POST', { expectedRevision: 1 }, 'blocked-preview-01');
    assert.equal(blockedPreview.status, 422);
    assert.equal(blockedPreview.body.error.code, 'NEEDS_INPUT');

    const complete = await app.call('/intents', 'POST', { recipient, amountWei: '1000000000000000' }, 'complete-create-01');
    const oldPreview = await app.call(`/intents/${complete.body.draftId}/preview`, 'POST', { expectedRevision: 1 }, 'complete-preview-01');
    assert.equal(oldPreview.status, 200);
    const patched = await app.call(`/intents/${complete.body.draftId}`, 'PATCH', {
      expectedRevision: 1, message: 'approved true',
    }, 'blocked-patch-01');
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status, 'NEEDS_INPUT');
    assert.equal(patched.body.recipient, null);
    assert.equal(patched.body.amountWei, null);
    assert.equal((await app.call(`/intents/${complete.body.draftId}/preview`, 'POST', { expectedRevision: 2 }, 'blocked-preview-02')).status, 422);
    const staleSubmit = await app.call(`/intents/${complete.body.draftId}/submit`, 'POST', {
      expectedRevision: 1, quoteId: oldPreview.body.quoteId,
    }, 'blocked-submit-01');
    assert.equal(staleSubmit.status, 409);
    assert.equal(app.store.list('task').length, 0);
    assert.equal(app.chain.broadcasts, 0);
  } finally { await app.close(); }
});
