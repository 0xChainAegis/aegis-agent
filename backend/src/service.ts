import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { verifyMessage, getAddress, zeroAddress, type Address, type Hex } from 'viem';
import {
  POLICY_EVIDENCE_VERIFICATION_SCOPE, POLICY_EVIDENCE_VERIFIED_FIELDS,
  type ConfiguredPriceSource, type Intent, type PolicyEvidence, type Task,
} from '@aegis/shared';
import type { Config } from './config.js';
import { Store } from './store.js';
import { type Gateway, type Quote, type Outcome, chainError } from './chain.js';
import type { DraftInput } from './parser.js';
import { createLlmClient, parseDraftWithLlm, type LlmIntentClient } from './llm.js';
import { ApiError, Mutex } from './errors.js';
import { planHash } from './plan.js';
import { checkCcipDelivery, terminalCcipDelivery } from './ccip-delivery.js';
import type { SubscriptionConfig } from '@aegis/shared';
interface SubscriptionReader { get(id:string):Promise<SubscriptionConfig> }

export interface InternalTask extends Task {
  quoteId: string; rawTransaction?: Hex; senderNonce?: string; broadcastAttempts?: number;
  lastBroadcastAt?: number; ownerObserved?: { hash: Hex; action: 'approve' | 'cancel' };
  eventData?: Record<string, string>; policyEvidence?: PolicyEvidence;
  lastError?: { code: string; message: string };
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
  subscriptions?: SubscriptionReader;
  private subscriptionCommitment(intent: Intent) {
    const { status:_status,updatedAt:_updated,...frozen }=intent; return frozen;
  }
  private requirePlan(intent:Intent,quote:Quote,expected?:Hex) {
    if(intent.actionKind!=='SUBSCRIPTION' && intent.actionKind!=='CCIP_TRANSFER') return;
    if(!expected || expected!==quote.planHash || planHash(this.subscriptionCommitment(intent),quote)!==expected) throw new ApiError(409,'PLAN_HASH_MISMATCH','动作草稿或报价已变化，请重新预览');
  }
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
    let intent:Intent;
    if(input.actionKind==='SUBSCRIPTION') {
      if(!this.subscriptions || !input.subscriptionId || input.occurrenceIndex===undefined) throw new ApiError(422,'SUBSCRIPTION_CONFIG_REQUIRED','请提供已登记订阅与期号 subscription');
      if(input.message || input.purpose || input.recipient || input.amountWei) throw new ApiError(400,'SUBSCRIPTION_FIELDS_DERIVED','订阅收款人与金额只从链上计划读取');
      const subscription=await this.subscriptions.get(input.subscriptionId);
      intent={draftId:id,intentId:id,version:1,revision:1,createdAt:now,updatedAt:now,status:'DRAFT',message:'',purpose:'',recipient:subscription.recipient,to:subscription.recipient,amountWei:subscription.amountWei,missingFields:[],question:null,parser:{kind:'rule_parser',model:null,configuredModel:null,fallback:false,reason:'STRUCTURED_SUBSCRIPTION'},actionKind:'SUBSCRIPTION',subscriptionId:input.subscriptionId,occurrenceIndex:input.occurrenceIndex,subscription};
    } else if(input.actionKind==='CCIP_TRANSFER') {
      const {ccipSenderAddress,ccipTokenAddress,ccipDestinationChainSelector}=this.config;
      if(!ccipSenderAddress||!ccipTokenAddress||!ccipDestinationChainSelector) throw new ApiError(422,'CCIP_CONFIG_REQUIRED','当前部署尚未配置 CCIP 路线');
      if(input.message) throw new ApiError(400,'CCIP_STRUCTURED_ONLY','CCIP 阶段只接受结构化字段，不接受自然语言降级');
      if(!input.recipient||!input.amountWei||!input.tokenAddress||!input.destinationChainSelector) throw new ApiError(422,'CCIP_FIELDS_REQUIRED','CCIP 需要收款地址、代币、数量和目标链');
      const recipient=getAddress(input.recipient);const token=getAddress(input.tokenAddress);
      if(recipient===zeroAddress) throw new ApiError(422,'CCIP_RECIPIENT_REQUIRED','CCIP 目标链收款地址不能是零地址');
      if(token.toLowerCase()!==ccipTokenAddress.toLowerCase()||input.destinationChainSelector!==ccipDestinationChainSelector) throw new ApiError(422,'CCIP_ROUTE_NOT_CONFIGURED','代币或目标链不属于已配置 CCIP 路线');
      intent={draftId:id,intentId:id,version:1,revision:1,createdAt:now,updatedAt:now,status:'DRAFT',message:'',purpose:(input.purpose??'').slice(0,500),recipient,to:recipient,amountWei:input.amountWei,missingFields:[],question:null,parser:{kind:'rule_parser',model:null,configuredModel:null,fallback:false,reason:'STRUCTURED_CCIP'},actionKind:'CCIP_TRANSFER',ccipSenderAddress,tokenAddress:token,destinationChainSelector:ccipDestinationChainSelector};
    } else intent = { ...await parseDraftWithLlm(input, this.config, undefined, this.llmClient), draftId: id, intentId: id, version: 1, revision: 1, createdAt: now, updatedAt: now };
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
    if(previous.actionKind==='SUBSCRIPTION' || input.actionKind==='SUBSCRIPTION') throw new ApiError(409,'NEW_SUBSCRIPTION_DRAFT_REQUIRED','更改订阅请新建当期草稿');
    if(previous.actionKind==='CCIP_TRANSFER' || input.actionKind==='CCIP_TRANSFER') throw new ApiError(409,'NEW_CCIP_DRAFT_REQUIRED','更改跨链动作请新建草稿');
    if (previous.version !== expected) throw new ApiError(409, 'REVISION_CONFLICT', '草稿已更新，请读取最新版本');
    if (this.store.list<InternalTask>('task', owner).some(task => task.draftId === id)) throw new ApiError(409, 'INTENT_ALREADY_SUBMITTED', '已提交的付款内容不能编辑；请新建草稿');
    const intent: Intent = { ...previous, ...await parseDraftWithLlm(input, this.config, previous, this.llmClient), version: previous.version + 1, revision: previous.version + 1, updatedAt: new Date().toISOString() };
    this.store.put('intent', id, owner, intent);
    return intent;
  }
  async preview(owner: Address, id: string, expected: number, maxUsdCost6?: string, maxFeeWei?: string): Promise<Quote> {
    const intent = this.getIntent(owner, id);
    if (intent.version !== expected) throw new ApiError(409, 'REVISION_CONFLICT', '草稿已更新，请重新预览');
    if (!intent.recipient || !intent.amountWei || intent.missingFields.length) throw new ApiError(422, 'NEEDS_INPUT', '请先补齐地址、数额和单位', intent.missingFields);
    if (this.store.list<InternalTask>('task', owner).some(task => task.draftId === id)) throw new ApiError(409, 'INTENT_ALREADY_SUBMITTED', '该草稿已提交');
    const result=intent.actionKind==='SUBSCRIPTION'
      ? await (()=>{if(!this.chain.previewSubscription) throw new ApiError(422,'SUBSCRIPTION_CONFIG_REQUIRED','订阅能力未配置'); return this.chain.previewSubscription(intent,maxUsdCost6);})()
      : intent.actionKind==='CCIP_TRANSFER'
        ? await (()=>{if(!this.chain.previewCcip) throw new ApiError(422,'CCIP_CONFIG_REQUIRED','CCIP 能力未配置'); return this.chain.previewCcip(intent,maxUsdCost6,maxFeeWei);})()
        : await this.chain.preview(intent.recipient,intent.amountWei,maxUsdCost6);
    const quote: Quote = { ...result, quoteId: randomUUID(), draftId: id, draftVersion: intent.version };
    if(intent.actionKind==='SUBSCRIPTION'||intent.actionKind==='CCIP_TRANSFER') quote.planHash=planHash(this.subscriptionCommitment(intent),quote);
    this.store.put('quote', quote.quoteId, owner, quote);
    this.store.put('intent', id, owner, { ...intent, status: quote.status, updatedAt: new Date().toISOString() });
    return quote;
  }
  submit(owner: Address, id: string, expected: number, quoteId: string, expectedPlanHash?:Hex): InternalTask {
    const existing = this.store.list<InternalTask>('task', owner).find(task => task.draftId === id && task.quoteId === quoteId);
    if (existing) {
      if (existing.draftVersion !== expected) throw new ApiError(409, 'REVISION_CONFLICT', '提交版本与原任务不一致');
      return existing;
    }
    const intent = this.getIntent(owner, id);
    const quote = this.store.get<Quote>('quote', quoteId, owner);
    if (!quote || quote.draftId !== id || quote.draftVersion !== expected || intent.version !== expected) throw new ApiError(409, 'QUOTE_MISMATCH', '报价与当前草稿版本不一致');
    this.requirePlan(intent,quote,expectedPlanHash);
    if (quote.status !== 'READY') throw new ApiError(422, 'POLICY_BLOCKED', '硬规则阻止该付款', quote.reasonCodes);
    if (quote.quoteExpiresAtSeconds <= Math.floor(Date.now() / 1000)) throw new ApiError(409, 'QUOTE_EXPIRED', '报价已过期，请重新预览并确认');
    if (quote.recipient !== intent.recipient || quote.amountWei !== intent.amountWei) throw new ApiError(409, 'INTENT_CHANGED', '报价动作与草稿不一致');
    if (this.store.list<InternalTask>('task', owner).some(task => task.draftId === id)) throw new ApiError(409, 'INTENT_ALREADY_SUBMITTED', '同一草稿只能提交一次');
    const now = new Date().toISOString(); const taskId = randomUUID();
    const task: InternalTask = {
      ...(intent.actionKind==='SUBSCRIPTION'?{actionKind:'SUBSCRIPTION' as const,subscriptionId:intent.subscriptionId,occurrenceIndex:intent.occurrenceIndex,subscription:intent.subscription,planHash:quote.planHash}:{}),
      ...(intent.actionKind==='CCIP_TRANSFER'?{actionKind:'CCIP_TRANSFER' as const,ccipSenderAddress:intent.ccipSenderAddress,tokenAddress:intent.tokenAddress,destinationChainSelector:intent.destinationChainSelector,maxFeeWei:quote.maxFeeWei,quotedFeeWei:quote.quotedFeeWei,planHash:quote.planHash}:{}),
      taskId, draftId: id, intentId: id, quoteId, draftVersion: expected, stateVersion: 1, status: 'SUBMITTING',
      chainId: this.config.chainId, walletAddress: quote.walletAddress, ownerAddress: this.config.ownerAddress, agentAddress: this.config.agentAddress,
      recipient: quote.recipient, to: quote.recipient, amountWei: quote.amountWei, maxUsdCost6: quote.maxUsdCost6, previewCostUsd6: quote.costUsd6,
      requestDeadlineSeconds: quote.requestDeadlineSeconds, policyVersion: quote.policyVersion, requestNonce: null, requestHash: null, attestationId: null, txHash: null,
      triggerType: 'manual', ruleId: null, reasonCodes: quote.reasonCodes, transactions: [], availableActions: [],
      createdAt: now, updatedAt: now, parser: intent.parser, verification: { kind: this.config.mode === 'mock' ? 'mock' : 'chain', chainVerified: false, hashVerified: false },
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
    const { rawTransaction: _raw, broadcastAttempts: _attempts, lastBroadcastAt: _last, senderNonce: _nonce, ownerObserved: _owner, eventData: _event, policyEvidence: _policy, quoteId: _quote, ...safe } = task;
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
      task.policyEvidence = outcome.policyEvidence;
      const messageId = outcome.eventData?.messageId;
      if (task.actionKind === 'CCIP_TRANSFER' && outcome.status === 'EXECUTED' && typeof messageId === 'string' && /^0x[0-9a-fA-F]{64}$/.test(messageId)) {
        task.messageId = messageId as Hex;
      }
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
    return { ...this.chain.ownerTx(task, action), taskId: id, requestHash: task.requestHash, attestationId: task.attestationId, approvalMode: 'owner_approve_and_execute', chainBindingVerified: !!this.chain.preflightOwner, recipient: task.recipient, amountWei: task.amountWei, maxUsdCost6: task.maxUsdCost6, maxFeeWei:task.maxFeeWei,tokenAddress:task.tokenAddress,destinationChainSelector:task.destinationChainSelector,requestNonce: task.requestNonce, requestDeadlineSeconds: task.requestDeadlineSeconds, policyVersion: task.policyVersion };
  }
  async ccipDelivery(owner: Address, id: string, fetchImpl: typeof fetch = fetch) {
    const task = this.getTask(owner, id);
    if (task.ccipDelivery) return task.ccipDelivery;
    const checked = await checkCcipDelivery(this.config, { actionKind: task.actionKind, messageId: task.messageId, txHash: task.txHash, recipient: task.recipient, tokenAddress: task.tokenAddress, amountWei: task.amountWei, destinationChainSelector: task.destinationChainSelector, transactions: task.transactions }, fetchImpl);
    const terminal = terminalCcipDelivery(checked);
    if (!terminal) return checked;
    return this.worker.run(async () => {
      const current = this.getTask(owner, id);
      if (current.ccipDelivery) return current.ccipDelivery;
      if (current.messageId?.toLowerCase() !== terminal.messageId.toLowerCase()) throw new ApiError(409, 'CCIP_DELIVERY_TASK_CHANGED', 'CCIP 任务在核验期间已变化');
      current.ccipDelivery = terminal;
      this.save(current);
      return terminal;
    });
  }
  evidence(owner: Address, id: string) {
    const task = this.getTask(owner, id);
    const quote = this.store.get<Quote>('quote', task.quoteId, owner);
    const previewPolicy = quote ? {
      source: this.config.mode === 'mock' ? 'mock' : 'chain_read',
      decision: quote.decision === 'AUTO' ? 'ALLOW' : quote.decision === 'OWNER_APPROVAL' ? 'REQUIRE_APPROVAL' : 'REJECT',
      reasonCodes: quote.reasonCodes, costUsd6: quote.costUsd6, maxUsdCost6: quote.maxUsdCost6,
      policyVersion: quote.policyVersion, observedBlockNumber: quote.observedBlockNumber,
      observedBlockHash: quote.observedBlockHash, oracle: quote.oracle,
    } : null;
    const receipt = task.policyEvidence;
    // Older stored rows also contain configuration addresses; only project receipt facts.
    const policy = receipt ? {
      engineAddress: receipt.engineAddress, event: receipt.event, actionType: receipt.actionType,
      decision: receipt.decision, requestHash: receipt.requestHash, actor: receipt.actor,
      costUsd6: receipt.costUsd6, day: receipt.day, spentUsd6: receipt.spentUsd6,
      transactionHash: receipt.transactionHash, policyVersion: receipt.policyVersion,
      roundId: receipt.roundId, updatedAtSeconds: receipt.updatedAtSeconds,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, logIndex: receipt.logIndex,
      verified: true, verificationScope: POLICY_EVIDENCE_VERIFICATION_SCOPE,
      verifiedFields: POLICY_EVIDENCE_VERIFIED_FIELDS, consumed: true, state: 'VERIFIED',
    } : {
      engineAddress: this.config.policyEngineAddress, consumed: false, verified: false,
      state: task.status === 'AWAITING_APPROVAL' ? 'WAITING_FOR_EXECUTION' : task.status === 'CANCELLED' ? 'NOT_CONSUMED' : 'UNVERIFIED',
    };
    const configuredPriceSource: ConfiguredPriceSource = {
      oracleAddress: this.config.oracleAddress, feedAddress: task.actionKind==='CCIP_TRANSFER'&&this.config.ccipTokenFeedAddress?this.config.ccipTokenFeedAddress:this.config.feedAddress,
      verified: false, scope: 'CURRENT_CONFIGURATION',
    };
    return {
      taskId: id, status: task.status, chainId: task.chainId, verification: task.verification,
      provenance: task.planHash ? {version:'aegis.draft-plan.v2',planHash:task.planHash,scope:task.actionKind==='CCIP_TRANSFER'?'CONFIRMED_CCIP_DRAFT_AND_QUOTE':'CONFIRMED_SUBSCRIPTION_DRAFT_AND_QUOTE'} : null,
      subscription: task.subscription ?? null,
      intent: { actionKind:task.actionKind ?? 'NATIVE_TRANSFER',subscriptionId:task.subscriptionId,occurrenceIndex:task.occurrenceIndex,ccipSenderAddress:task.ccipSenderAddress,tokenAddress:task.tokenAddress,destinationChainSelector:task.destinationChainSelector,maxFeeWei:task.maxFeeWei,quotedFeeWei:task.quotedFeeWei,planHash:task.planHash,draftId: task.draftId, draftVersion: task.draftVersion, walletAddress: task.walletAddress, agentAddress: task.agentAddress, recipient: task.recipient, amountWei: task.amountWei, maxUsdCost6: task.maxUsdCost6, policyVersion: task.policyVersion, requestNonce: task.requestNonce, requestDeadlineSeconds: task.requestDeadlineSeconds, requestHash: task.requestHash },
      attestationId: task.attestationId, transactions: task.transactions, outcome: task.eventData ?? null, ccipDelivery: task.ccipDelivery ?? null, previewPolicy, policy, configuredPriceSource,
      approvalMode: 'owner_approve_and_execute', finality: 'mined_is_not_irreversible', confirmationsRequired: 1,
      explorerBaseUrl: this.config.mode === 'testnet' ? 'https://sepolia.etherscan.io' : null,
      sources: { planner: task.parser.kind, quote: this.config.mode === 'mock' ? 'mock' : 'chain', transaction: this.config.mode === 'mock' ? 'none' : 'chain', evidence: task.policyEvidence ? 'wallet_and_policy_contract_events' : task.verification.chainVerified ? 'wallet_contract_event' : 'unverified' },
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
            const originalKind=this.getIntent(active.ownerAddress,active.draftId).actionKind ?? 'NATIVE_TRANSFER';
            if(originalKind!==(active.actionKind ?? 'NATIVE_TRANSFER')) throw new ApiError(409,'PLAN_HASH_MISMATCH','任务动作类型与原草稿不一致');
            if(active.actionKind==='SUBSCRIPTION') {
              const original=this.getIntent(active.ownerAddress,active.draftId); const savedQuote=this.store.get<Quote>('quote',active.quoteId,active.ownerAddress);
              if(!savedQuote) throw new ApiError(409,'PLAN_HASH_MISMATCH','报价丢失');
              this.requirePlan(original,savedQuote,active.planHash);
              if(active.subscriptionId!==original.subscriptionId || active.occurrenceIndex!==original.occurrenceIndex || active.recipient!==original.recipient || active.amountWei!==original.amountWei || active.maxUsdCost6!==savedQuote.maxUsdCost6 || active.policyVersion!==savedQuote.policyVersion || active.requestDeadlineSeconds!==savedQuote.requestDeadlineSeconds) throw new ApiError(409,'PLAN_HASH_MISMATCH','任务与确认计划不一致');
            }
            if(active.actionKind==='CCIP_TRANSFER') {
              const original=this.getIntent(active.ownerAddress,active.draftId);const savedQuote=this.store.get<Quote>('quote',active.quoteId,active.ownerAddress);
              if(!savedQuote) throw new ApiError(409,'PLAN_HASH_MISMATCH','CCIP 报价丢失');
              this.requirePlan(original,savedQuote,active.planHash);
              if(active.ccipSenderAddress!==original.ccipSenderAddress||active.tokenAddress!==original.tokenAddress||active.destinationChainSelector!==original.destinationChainSelector||active.recipient!==original.recipient||active.amountWei!==original.amountWei||active.maxUsdCost6!==savedQuote.maxUsdCost6||active.maxFeeWei!==savedQuote.maxFeeWei||active.policyVersion!==savedQuote.policyVersion||active.requestDeadlineSeconds!==savedQuote.requestDeadlineSeconds) throw new ApiError(409,'PLAN_HASH_MISMATCH','CCIP 任务与确认计划不一致');
            }
            const prepared = await this.chain.prepare(active);
            active.rawTransaction = prepared.rawTransaction; active.txHash = prepared.hash;
            active.senderNonce = prepared.senderNonce; active.requestNonce = prepared.requestNonce; active.requestHash = prepared.requestHash;
            active.transactions = [{ role: 'request', hash: prepared.hash, senderNonce: prepared.senderNonce, finality: 'pending' }];
            this.save(active); // Commit raw bytes/hash/nonce before ANY network broadcast.
          }
          if (!active.txHash) throw new ApiError(503,'TRANSACTION_HASH_MISSING','已签交易缺少确定性 hash');
          const outcome = await this.chain.outcome(active, active.txHash, 'request');
          if (outcome) this.apply(active, outcome);
          else if (active.status === 'BROADCAST' && active.lastBroadcastAt && Date.now() - active.lastBroadcastAt > 60_000) {
            active.status = 'UNKNOWN'; active.reasonCodes = ['BROADCAST_UNKNOWN']; this.save(active);
          }
          else if (!active.lastBroadcastAt || (active.status === 'UNKNOWN' && Date.now() - active.lastBroadcastAt > 10_000 && (active.broadcastAttempts ?? 0) < 2)) {
            active.lastBroadcastAt = Date.now(); active.broadcastAttempts = (active.broadcastAttempts ?? 0) + 1;
            this.save(active);
            try {
              const sentHash = await this.chain.broadcast(active.rawTransaction);
              if (!active.txHash || sentHash.toLowerCase() !== active.txHash.toLowerCase()) throw new Error('RPC returned another hash');
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
            const rejectedHash=pending.ownerObserved.hash;
            pending.transactions = pending.transactions.filter(tx => tx.hash !== rejectedHash);
            delete pending.ownerObserved;
          }
          this.save(pending);
        }
      }
    });
  }
}
