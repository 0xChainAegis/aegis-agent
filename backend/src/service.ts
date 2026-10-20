import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { verifyMessage, getAddress, type Address, type Hex } from 'viem';
import { type Intent, type Task } from '@aegis/shared';
import type { Config } from './config.js';
import { Store } from './store.js';
import { type Gateway, type Quote, type Outcome, chainError } from './chain.js';
import { computeDraftHash, computePlanProvenance, verifyPlanHash } from './plan.js';
import type { DraftInput } from './parser.js';
import { createLlmClient, parseDraftWithLlm, type LlmIntentClient } from './llm.js';
import { ApiError, Mutex } from './errors.js';

export interface InternalTask extends Task {
  quoteId: string; rawTransaction?: Hex; senderNonce?: string; broadcastAttempts?: number;
  lastBroadcastAt?: number; ownerObserved?: { hash: Hex; action: 'approve' | 'cancel' };
  eventData?: Record<string, string>; lastError?: { code: string; message: string };
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export class AegisService {
  readonly writes = new Mutex();
  readonly worker = new Mutex();
  constructor(readonly config: Config, readonly store: Store, readonly chain: Gateway, readonly llmClient: LlmIntentClient | null = createLlmClient(config.llm)) {
    if (!config.deploymentReady) return;
    const namespace = { mode: config.mode, chainId: config.chainId, wallet: config.walletAddress.toLowerCase(), agent: config.agentAddress.toLowerCase(), owner: config.ownerAddress.toLowerCase() };
    const previous = store.get<typeof namespace>('metadata', 'deployment');
    if (previous && canonical(previous) !== canonical(namespace)) throw new Error('Database belongs to another chain, wallet or signer deployment. Use a separate AEGIS_DB_PATH.');
    store.put('metadata', 'deployment', config.ownerAddress, namespace);
  }
  challenge(addressInput: string, chainId: number) {
    const address = getAddress(addressInput);
    if (address.toLowerCase() !== this.config.ownerAddress.toLowerCase()) throw new ApiError(403, 'OWNER_REQUIRED', '当前资金池只允许部署 owner 登录');
    if (chainId !== this.config.chainId) throw new ApiError(409, 'CHAIN_MISMATCH', '请切换到配置链再登录');
    const challengeId = randomUUID();
    const nonce = randomBytes(24).toString('hex');
    const issuedAt = new Date().toISOString();
    const expires = Date.now() + 5 * 60_000;
    const message = `Aegis Wallet Login\nDomain: ${this.config.authDomain}\nURI: http://127.0.0.1:${this.config.port}\nAddress: ${address}\nChain ID: ${this.config.chainId}\nNonce: ${nonce}\nChallenge: ${challengeId}\nIssued At: ${issuedAt}\nExpiration Time: ${new Date(expires).toISOString()}\nThis signature only opens a session. It does not approve a payment.`;
    this.store.db.prepare('INSERT INTO challenges(id,address,message,expires) VALUES(?,?,?,?)').run(challengeId, address.toLowerCase(), message, expires);
    return { challengeId, address, chainId, message, expiresAt: new Date(expires).toISOString() };
  }
  async verify(challengeId: string, addressInput: string, signature: Hex) {
    const address = getAddress(addressInput);
    const row = this.store.db.prepare('SELECT * FROM challenges WHERE id=?').get(challengeId) as { address: string; message: string; expires: number; used: number } | undefined;
    if (!row || row.used || row.expires <= Date.now() || row.address !== address.toLowerCase() || row.address !== this.config.ownerAddress.toLowerCase()) throw new ApiError(401, 'CHALLENGE_INVALID', '登录挑战不存在、已使用、已过期或地址不匹配');
    let valid = false;
    try { valid = await verifyMessage({ address, message: row.message, signature }); } catch { /* malformed signatures are authentication failures */ }
    if (!valid) throw new ApiError(401, 'SIGNATURE_INVALID', '登录签名无效');
    const consumed = this.store.db.prepare('UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires>?').run(challengeId, Date.now());
    if (Number(consumed.changes) !== 1) throw new ApiError(401, 'CHALLENGE_USED', '该登录挑战已使用');
    const token = randomBytes(32).toString('base64url');
    const expires = Date.now() + this.config.sessionSeconds * 1000;
    this.store.db.prepare('INSERT INTO sessions(hash,address,expires) VALUES(?,?,?)').run(digest(token), row.address, expires);
    return { token, address, expiresAt: new Date(expires).toISOString(), chainId: this.config.chainId };
  }
  authenticate(token: string | undefined): Address {
    if (!token) throw new ApiError(401, 'AUTH_REQUIRED', '请先用 owner 钱包签名登录');
    const row = this.store.db.prepare('SELECT address,expires FROM sessions WHERE hash=?').get(digest(token)) as { address: string; expires: number } | undefined;
    if (!row || row.expires <= Date.now() || row.address !== this.config.ownerAddress.toLowerCase()) throw new ApiError(401, 'SESSION_EXPIRED', '会话无效或已过期');
    return getAddress(row.address);
  }
  async idempotent(owner: Address, route: string, key: string | undefined, body: unknown, operation: () => Promise<{ status: number; body: unknown }>) {
    if (!key || key.length < 8 || key.length > 128 || !/^[a-zA-Z0-9_.:-]+$/.test(key)) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '写请求需要 8–128 字符的 Idempotency-Key');
    return this.writes.run(async () => {
      const scope = `${owner.toLowerCase()}:${this.config.chainId}:${route}:${key}`;
      const hash = digest(canonical(body));
      const existing = this.store.db.prepare('SELECT hash,status,payload FROM idempotency WHERE scope=?').get(scope) as { hash: string; status: number; payload: string } | undefined;
      if (existing) {
        if (existing.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '相同幂等 key 不能用于不同内容');
        return { status: existing.status, body: JSON.parse(existing.payload), replay: true };
      }
      const result = await operation();
      this.store.db.prepare('INSERT INTO idempotency(scope,hash,status,payload) VALUES(?,?,?,?)').run(scope, hash, result.status, JSON.stringify(result.body));
      return result;
    });
  }
  async createIntent(owner: Address, input: DraftInput): Promise<Intent> {
    const id = randomUUID(); const now = new Date().toISOString();
    const intent: Intent = { ...await parseDraftWithLlm(input, this.config, undefined, this.llmClient), draftId: id, intentId: id, version: 1, revision: 1, createdAt: now, updatedAt: now };
    intent.draftHash = computeDraftHash(intent);
    this.store.put('intent', id, owner, intent);
    return intent;
  }
  getIntent(owner: Address, id: string): Intent {
    const intent = this.store.get<Intent>('intent', id, owner);
    if (!intent) throw new ApiError(404, 'INTENT_NOT_FOUND', '找不到该草稿');
    return intent;
  }
  async patchIntent(owner: Address, id: string, expected: number, input: DraftInput): Promise<Intent> {
    const previous = this.getIntent(owner, id);
    if (previous.version !== expected) throw new ApiError(409, 'REVISION_CONFLICT', '草稿已更新，请读取最新版本');
    if (this.store.list<InternalTask>('task', owner).some(task => task.draftId === id)) throw new ApiError(409, 'INTENT_ALREADY_SUBMITTED', '已提交的付款内容不能编辑；请新建草稿');
    const intent: Intent = { ...previous, ...await parseDraftWithLlm(input, this.config, previous, this.llmClient), version: previous.version + 1, revision: previous.version + 1, updatedAt: new Date().toISOString() };
    intent.draftHash = computeDraftHash(intent);
    this.store.put('intent', id, owner, intent);
    return intent;
  }
  async preview(owner: Address, id: string, expected: number, maxUsdCost6?: string): Promise<Quote> {
    const intent = this.getIntent(owner, id);
    if (intent.version !== expected) throw new ApiError(409, 'REVISION_CONFLICT', '草稿已更新，请重新预览');
    if (!intent.recipient || !intent.amountWei || intent.missingFields.length) throw new ApiError(422, 'NEEDS_INPUT', '请先补齐地址、数额和单位', intent.missingFields);
    if (this.store.list<InternalTask>('task', owner).some(task => task.draftId === id)) throw new ApiError(409, 'INTENT_ALREADY_SUBMITTED', '该草稿已提交');
    const quote: Quote = { ...await this.chain.preview(intent.recipient, intent.amountWei, maxUsdCost6), quoteId: randomUUID(), draftId: id, draftVersion: intent.version };
    const provenance = computePlanProvenance(intent, quote);
    const quoteWithProvenance: Quote = { ...quote, draftHash: provenance.draftHash, quoteHash: provenance.quoteHash, planHash: provenance.planHash };
    this.store.put('quote', quote.quoteId, owner, quoteWithProvenance);
    this.store.put('intent', id, owner, { ...intent, status: quote.status, updatedAt: new Date().toISOString() });
    return quoteWithProvenance;
  }
  submit(owner: Address, id: string, expected: number, quoteId: string, planHash: string): InternalTask {
    const existing = this.store.list<InternalTask>('task', owner).find(task => task.draftId === id && task.quoteId === quoteId);
    if (existing) {
      if (existing.draftVersion !== expected) throw new ApiError(409, 'REVISION_CONFLICT', '提交版本与原任务不一致');
      if (existing.provenance?.planHash.toLowerCase() !== planHash.toLowerCase()) throw new ApiError(409, 'PLAN_HASH_MISMATCH', '计划指纹与原任务不一致');
      return existing;
    }
    const intent = this.getIntent(owner, id);
    const quote = this.store.get<Quote>('quote', quoteId, owner);
    if (!quote || quote.draftId !== id || quote.draftVersion !== expected || intent.version !== expected) throw new ApiError(409, 'QUOTE_MISMATCH', '报价与当前草稿版本不一致');
    if (quote.status !== 'READY') throw new ApiError(422, 'POLICY_BLOCKED', '硬规则阻止该付款', quote.reasonCodes);
    if (quote.quoteExpiresAtSeconds <= Math.floor(Date.now() / 1000)) throw new ApiError(409, 'QUOTE_EXPIRED', '报价已过期，请重新预览并确认');
    if (quote.recipient !== intent.recipient || quote.amountWei !== intent.amountWei) throw new ApiError(409, 'INTENT_CHANGED', '报价动作与草稿不一致');
    if (!verifyPlanHash(intent, quote, planHash)) throw new ApiError(409, 'PLAN_HASH_MISMATCH', '计划指纹与当前草稿或报价不一致');
    if (this.store.list<InternalTask>('task', owner).some(task => task.draftId === id)) throw new ApiError(409, 'INTENT_ALREADY_SUBMITTED', '同一草稿只能提交一次');
    const now = new Date().toISOString(); const taskId = randomUUID();
    const task: InternalTask = {
      taskId, draftId: id, intentId: id, quoteId, draftVersion: expected, stateVersion: 1, status: 'SUBMITTING',
      chainId: this.config.chainId, walletAddress: this.config.walletAddress, ownerAddress: this.config.ownerAddress, agentAddress: this.config.agentAddress,
      recipient: quote.recipient, to: quote.recipient, amountWei: quote.amountWei, maxUsdCost6: quote.maxUsdCost6, previewCostUsd6: quote.costUsd6,
      requestDeadlineSeconds: quote.requestDeadlineSeconds, policyVersion: quote.policyVersion, requestNonce: null, requestHash: null, attestationId: null, txHash: null,
      triggerType: 'manual', ruleId: null, reasonCodes: quote.reasonCodes, transactions: [], availableActions: [],
      createdAt: now, updatedAt: now, parser: intent.parser, provenance: computePlanProvenance(intent, quote),
      verification: { kind: this.config.mode === 'mock' ? 'mock' : 'chain', chainVerified: false, hashVerified: false },
    };
    this.store.put('task', taskId, owner, task);
    this.store.put('intent', id, owner, { ...intent, status: 'SUBMITTING', updatedAt: now });
    return task;
  }
  getTask(owner: Address, id: string): InternalTask {
    const task = this.store.get<InternalTask>('task', id, owner);
    if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', '找不到该任务');
    return task;
  }
  publicTask(task: InternalTask): Task & { lastError?: InternalTask['lastError'] } {
    const { rawTransaction: _raw, broadcastAttempts: _attempts, lastBroadcastAt: _last, senderNonce: _nonce, ownerObserved: _owner, eventData: _event, quoteId: _quote, ...safe } = task;
    return safe;
  }
  private save(task: InternalTask) {
    task.stateVersion += 1; task.updatedAt = new Date().toISOString();
    task.availableActions = task.status === 'AWAITING_APPROVAL' ? ['owner_approve_and_execute', 'owner_cancel'] : task.status === 'UNKNOWN' || task.status === 'BROADCAST' ? ['observe_transaction'] : [];
    this.store.put('task', task.taskId, task.ownerAddress, task);
  }
  private apply(task: InternalTask, outcome: Outcome, ownerAction = false) {
    task.transactions = task.transactions.filter(tx => !(tx.role === outcome.transaction.role && tx.hash === outcome.transaction.hash));
    task.transactions.push(outcome.transaction);
    if (ownerAction && outcome.status === 'FAILED') {
      task.lastError = { code: outcome.reasonCode ?? 'OWNER_TX_FAILED', message: 'Owner 交易未完成业务动作；链上 pending 仍需核查，可重新准备 owner 交易' };
      delete task.ownerObserved;
    } else {
      task.status = outcome.status; task.attestationId = outcome.attestationId ?? task.attestationId;
      task.reasonCodes = outcome.reasonCode ? [outcome.reasonCode] : outcome.status === 'AWAITING_APPROVAL' ? task.reasonCodes.length ? task.reasonCodes : ['OWNER_APPROVAL_REQUIRED'] : [];
      task.eventData = outcome.eventData;
      task.verification = { kind: 'chain', chainVerified: outcome.status !== 'FAILED', hashVerified: outcome.status !== 'FAILED' };
      delete task.lastError;
      if (ownerAction) delete task.ownerObserved;
    }
    this.save(task);
  }
  async observed(owner: Address, id: string, hash: Hex, action: 'approve' | 'cancel') {
    return this.worker.run(async () => {
      const task = this.getTask(owner, id);
      if (task.status !== 'AWAITING_APPROVAL') throw new ApiError(409, 'NOT_PENDING', '任务不处于等待 owner 的状态');
      if (task.ownerObserved && (task.ownerObserved.hash !== hash || task.ownerObserved.action !== action)) throw new ApiError(409, 'OWNER_TX_PENDING', '已有 owner 交易在核对，请等待原交易结果');
      const outcome = await this.chain.outcome(task, hash, action);
      if (outcome) this.apply(task, outcome, true);
      else {
        task.ownerObserved = { hash, action };
        if (!task.transactions.some(tx => tx.hash === hash)) task.transactions.push({ role: action, hash, finality: 'pending' });
        this.save(task);
      }
      return task;
    });
  }
  async ownerTx(owner: Address, id: string, action: 'approve' | 'cancel') {
    const task = this.getTask(owner, id);
    if (task.status !== 'AWAITING_APPROVAL') throw new ApiError(409, 'NOT_PENDING', '只有链上 pending 任务可由 owner 审批或取消');
    await this.chain.preflightOwner?.(task, action);
    return { ...this.chain.ownerTx(task, action), taskId: id, requestHash: task.requestHash, attestationId: task.attestationId, approvalMode: 'owner_approve_and_execute', chainBindingVerified: !!this.chain.preflightOwner, recipient: task.recipient, amountWei: task.amountWei, maxUsdCost6: task.maxUsdCost6, requestNonce: task.requestNonce, requestDeadlineSeconds: task.requestDeadlineSeconds, policyVersion: task.policyVersion };
  }
  evidence(owner: Address, id: string) {
    const task = this.getTask(owner, id);
    return {
      taskId: id, status: task.status, chainId: task.chainId, verification: task.verification,
      intent: { draftId: task.draftId, draftVersion: task.draftVersion, walletAddress: task.walletAddress, agentAddress: task.agentAddress, recipient: task.recipient, amountWei: task.amountWei, maxUsdCost6: task.maxUsdCost6, policyVersion: task.policyVersion, requestNonce: task.requestNonce, requestDeadlineSeconds: task.requestDeadlineSeconds, requestHash: task.requestHash },
      attestationId: task.attestationId, provenance: task.provenance ?? null, transactions: task.transactions, outcome: task.eventData ?? null,
      approvalMode: 'owner_approve_and_execute', finality: 'mined_is_not_irreversible', confirmationsRequired: 1,
      explorerBaseUrl: this.config.mode === 'testnet' ? 'https://sepolia.etherscan.io' : null,
      sources: { planner: task.parser.kind, quote: this.config.mode === 'mock' ? 'mock' : 'chain', transaction: this.config.mode === 'mock' ? 'none' : 'chain', evidence: task.verification.chainVerified ? 'contract_event' : 'unverified' },
    };
  }
  async tick() {
    return this.worker.run(async () => {
      const tasks = this.store.list<InternalTask>('task');
      // Recover signed transactions before allocating another agent nonce. A single
      // unresolved broadcast blocks the queue, including after a process restart.
      const active = tasks.find(task => ['SUBMITTING', 'BROADCAST', 'UNKNOWN'].includes(task.status));
      if (active) {
        try {
          if (!active.rawTransaction) {
            const prepared = await this.chain.prepare(active);
            active.rawTransaction = prepared.rawTransaction; active.txHash = prepared.hash;
            active.senderNonce = prepared.senderNonce; active.requestNonce = prepared.requestNonce; active.requestHash = prepared.requestHash;
            active.transactions = [{ role: 'request', hash: prepared.hash, senderNonce: prepared.senderNonce, finality: 'pending' }];
            this.save(active); // Commit raw bytes/hash/nonce before ANY network broadcast.
          }
          const outcome = await this.chain.outcome(active, active.txHash!, 'request');
          if (outcome) this.apply(active, outcome);
          else if (active.status === 'BROADCAST' && active.lastBroadcastAt && Date.now() - active.lastBroadcastAt > 60_000) {
            active.status = 'UNKNOWN'; active.reasonCodes = ['BROADCAST_UNKNOWN']; this.save(active);
          }
          else if (!active.lastBroadcastAt || (active.status === 'UNKNOWN' && Date.now() - active.lastBroadcastAt > 10_000 && (active.broadcastAttempts ?? 0) < 2)) {
            active.lastBroadcastAt = Date.now(); active.broadcastAttempts = (active.broadcastAttempts ?? 0) + 1;
            this.save(active);
            try {
              const sentHash = await this.chain.broadcast(active.rawTransaction);
              if (sentHash.toLowerCase() !== active.txHash!.toLowerCase()) throw new Error('RPC returned another hash');
              active.status = 'BROADCAST'; active.reasonCodes = []; delete active.lastError; this.save(active);
            } catch {
              active.status = 'UNKNOWN'; active.reasonCodes = ['BROADCAST_UNKNOWN'];
              active.lastError = { code: 'BROADCAST_UNKNOWN', message: '广播结果不明；正在核对原哈希，不会创建另一笔付款' }; this.save(active);
            }
          }
        } catch (error) {
          const failure = chainError(error);
          if (active.rawTransaction) {
            active.status = 'UNKNOWN'; active.reasonCodes = ['BROADCAST_UNKNOWN'];
          } else {
            active.status = failure.status === 409 ? 'REQUOTE_REQUIRED' : failure.status === 422 || failure.status === 403 ? 'BLOCKED' : 'FAILED';
            active.reasonCodes = [failure.code];
          }
          active.lastError = { code: failure.code, message: failure.message }; this.save(active);
        }
      }
      for (const pending of this.store.list<InternalTask>('task').filter(task => task.status === 'AWAITING_APPROVAL')) {
        try {
          const outcome = pending.ownerObserved ? await this.chain.outcome(pending, pending.ownerObserved.hash, pending.ownerObserved.action) : await this.chain.findOwnerOutcome?.(pending);
          if (outcome) this.apply(pending, outcome, true);
        } catch (error) {
          const failure = chainError(error);
          pending.lastError = { code: failure.code, message: failure.message };
          if (failure.code === 'TX_BINDING_MISMATCH' && pending.ownerObserved) {
            pending.transactions = pending.transactions.filter(tx => tx.hash !== pending.ownerObserved!.hash);
            delete pending.ownerObserved;
          }
          this.save(pending);
        }
      }
    });
  }
}
