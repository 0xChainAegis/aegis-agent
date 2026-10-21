import {
  createPublicClient, createWalletClient, http, defineChain, parseAbi, encodeFunctionData,
  decodeEventLog, keccak256, zeroAddress, encodeAbiParameters, parseAbiParameters, toHex,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  walletAbiSignatures, oracleAbiSignatures, policyEngineAbiSignatures,
  type PolicyEvidence, type Task, type TransactionEvidence,
} from '@aegis/shared';
import type { Config } from './config.js';
import { ApiError, errorMessage } from './errors.js';
import { ReadinessCache } from './readiness-cache.js';

export const walletAbi = parseAbi(walletAbiSignatures);
export const oracleAbi = parseAbi(oracleAbiSignatures);
const aclAbi = parseAbi([
  'function AGENT_ROLE() view returns (bytes32)',
  'function tierOf(address account) view returns (uint8)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
]);
const attestationAbi = parseAbi([
  'function ATTESTER_ROLE() view returns (bytes32)',
  'function APPROVER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
]);
const walletBindingAbi = parseAbi([
  'function owner() view returns (address)',
  'function acl() view returns (address)',
  'function attestations() view returns (address)',
  'function oracle() view returns (address)',
  'function policyEngine() view returns (address)',
]);
const oracleBindingAbi = parseAbi([
  'function feeds(address token) view returns (address)',
  'function configurationLocked() view returns (bool)',
]);
export const policyEngineAbi = parseAbi([
  ...policyEngineAbiSignatures,
  'function owner() view returns (address)',
  'function acl() view returns (address)',
  'function oracle() view returns (address)',
  'function authorizedConsumers(address consumer) view returns (bool)',
  'function policyManagers(address manager) view returns (bool)',
]);
export interface Budget {
  autoThresholdUsd6: string; hardPerTxUsd6: string; dailyLimitUsd6: string;
  spentTodayUsd6: string; remainingUsd6: string; window: 'UTC_CALENDAR_DAY';
}
export interface Snapshot {
  chainId: number; walletAddress: Address; ownerAddress: Address; agentAddress: Address; recipientAddress: Address;
  walletBalanceWei: string; agentBalanceWei: string; recipientBalanceWei: string;
  policyVersion: string; budget: Budget; observedBlockNumber: string; observedBlockHash: Hex;
  observedAt: string; dataSource: 'chain';
  observedBlockTimestamp?: string;
}
export interface Quote {
  quoteId: string; draftId: string; draftVersion: number; status: 'READY' | 'BLOCKED';
  chainId: number; walletAddress: Address; agentAddress: Address; recipient: Address; to: Address;
  amountWei: string; costUsd6: string; maxUsdCost6: string; policyVersion: string;
  requestDeadlineSeconds: number; quoteExpiresAtSeconds: number;
  requestNonce: null; requestHash: null; decision: 'AUTO' | 'OWNER_APPROVAL' | 'BLOCK';
  reasonCodes: string[]; budget: Budget; feedAddress: Address; feedDecimals: number;
  priceAnswer: string; roundId: string; updatedAtSeconds: number;
  observedBlockNumber: string; observedBlockHash: Hex; oracle: Record<string, unknown>;
  triggerType: 'manual'; ruleId: null;
}
export interface Prepared {
  rawTransaction: Hex; hash: Hex; senderNonce: string; requestNonce: string; requestHash: Hex;
}
export interface Outcome {
  status: 'EXECUTED' | 'AWAITING_APPROVAL' | 'CANCELLED' | 'FAILED';
  transaction: TransactionEvidence; attestationId?: string; reasonCode?: string;
  eventData?: Record<string, string>; policyEvidence?: PolicyEvidence;
}
export interface Gateway {
  readiness(force?: boolean): Promise<Record<string, unknown>>;
  snapshot(): Promise<Snapshot>;
  preview(recipient: Address, amountWei: string, maxUsdCost6?: string): Promise<Omit<Quote, 'quoteId' | 'draftId' | 'draftVersion'>>;
  prepare(task: Task): Promise<Prepared>;
  broadcast(raw: Hex): Promise<Hex>;
  outcome(task: Task, hash: Hex, role: 'request' | 'approve' | 'cancel'): Promise<Outcome | null>;
  ownerTx(task: Task, action: 'approve' | 'cancel'): { to: Address; data: Hex; value: string; from: Address; chainId: number; action: string };
  findOwnerOutcome?(task: Task): Promise<Outcome | null>;
  preflightOwner?(task: Task, action: 'approve' | 'cancel'): Promise<void>;
}
function equal(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
export function chainError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = errorMessage(error);
  const mapping: [RegExp, string, number][] = [
    [/TIER_BLOCKED/i, 'AGENT_FROZEN', 422],
    [/NO_PENDING/i, 'NOT_PENDING', 409],
    [/stale|fresh|future timestamp|OracleStale/i, 'FEED_STALE', 503],
    [/recipient|allowlist/i, 'NOT_ALLOWLISTED', 422],
    [/daily|budget/i, 'BUDGET_EXCEEDED', 422],
    [/per.?tx|per.?transfer|single/i, 'PER_TX_LIMIT', 422],
    [/version|policy changed/i, 'POLICY_CHANGED', 409],
    [/deadline|expired/i, 'QUOTE_EXPIRED', 409],
    [/max.*cost|slippage|quote|price moved/i, 'REQUOTE_REQUIRED', 409],
    [/REQUEST_ALREADY_CONSUMED|replay|nonce/i, 'NONCE_CONFLICT', 409],
    [/insufficient|balance/i, 'INSUFFICIENT_FUNDS', 422],
    [/agent|role|unauthoriz/i, 'EXECUTOR_UNAUTHORIZED', 403],
    [/price|round|feed|oracle/i, 'FEED_UNAVAILABLE', 503],
  ];
  const found = mapping.find(([pattern]) => pattern.test(message));
  return new ApiError(found?.[2] ?? 503, found?.[1] ?? 'CHAIN_UNAVAILABLE', message);
}
export class ViemGateway implements Gateway {
  readonly publicClient;
  readonly account;
  readonly walletClient;
  private readonly readinessCache: ReadinessCache<Record<string, unknown>>;
  constructor(readonly config: Config) {
    const chain = defineChain({ id: config.chainId, name: config.mode === 'local_chain' ? 'Hardhat local' : 'Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
    this.publicClient = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: config.rpcRetryCount }) });
    try { this.account = config.agentKey ? privateKeyToAccount(config.agentKey) : undefined; }
    catch { throw new Error('AEGIS_AGENT_PRIVATE_KEY is invalid'); }
    this.walletClient = this.account ? createWalletClient({ chain, account: this.account, transport: http(config.rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: config.rpcRetryCount }) }) : undefined;
    this.readinessCache = new ReadinessCache(config.readinessTtlMs);
  }
  private async requireChain() {
    if (this.config.mode === 'mock') throw new ApiError(422, 'MOCK_EXECUTION_DISABLED', 'Mock 模式没有链上执行或真实交易证据');
    if (!this.config.deploymentReady || this.config.walletAddress === zeroAddress) throw new ApiError(503, 'DEPLOYMENT_MISSING', '请先部署合约并启动后端');
    if (await this.publicClient.getChainId() !== this.config.chainId) throw new ApiError(503, 'CHAIN_MISMATCH', 'RPC chainId 与配置不一致');
  }
  async readiness(force = false) {
    return this.readinessCache.get(() => this.inspectReadiness(), force);
  }
  private async inspectReadiness(): Promise<Record<string, unknown>> {
    let verifiedStructure: Record<string, unknown> = {};
    try {
      await this.requireChain();
      const addresses = [this.config.walletAddress, this.config.aclAddress, this.config.attestationAddress, this.config.oracleAddress, this.config.policyEngineAddress, this.config.feedAddress];
      const code = await Promise.all(addresses.map(address => this.publicClient.getBytecode({ address })));
      if (code.some(value => !value || value === '0x')) throw new ApiError(503, 'CONTRACT_MISSING', '部署地址没有合约 bytecode');
      if (!this.account) throw new ApiError(503, 'EXECUTOR_KEY_MISSING', '执行账户未配置；测试网不会使用本地公开私钥');
      if (!equal(this.account.address, this.config.agentAddress)) throw new ApiError(503, 'EXECUTOR_MISMATCH', '执行密钥与部署 agent 地址不一致');
      const snapshot = await this.snapshot();
      const observedBlock = BigInt(snapshot.observedBlockNumber);
      await this.checkDeploymentBindings(observedBlock);
      const [agentRole, attesterRole, approverRole] = await Promise.all([
        this.publicClient.readContract({ address: this.config.aclAddress, abi: aclAbi, functionName: 'AGENT_ROLE', blockNumber: observedBlock }),
        this.publicClient.readContract({ address: this.config.attestationAddress, abi: attestationAbi, functionName: 'ATTESTER_ROLE', blockNumber: observedBlock }),
        this.publicClient.readContract({ address: this.config.attestationAddress, abi: attestationAbi, functionName: 'APPROVER_ROLE', blockNumber: observedBlock }),
      ]);
      const [authorized, agentTier, walletCanAttest, walletCanApprove] = await Promise.all([
        this.publicClient.readContract({ address: this.config.aclAddress, abi: aclAbi, functionName: 'hasRole', args: [agentRole, this.config.agentAddress], blockNumber: observedBlock }),
        this.publicClient.readContract({ address: this.config.aclAddress, abi: aclAbi, functionName: 'tierOf', args: [this.config.agentAddress], blockNumber: observedBlock }),
        this.publicClient.readContract({ address: this.config.attestationAddress, abi: attestationAbi, functionName: 'hasRole', args: [attesterRole, this.config.walletAddress], blockNumber: observedBlock }),
        this.publicClient.readContract({ address: this.config.attestationAddress, abi: attestationAbi, functionName: 'hasRole', args: [approverRole, this.config.walletAddress], blockNumber: observedBlock }),
      ]);
      if (!authorized) throw new ApiError(503, 'EXECUTOR_UNAUTHORIZED', '执行账户没有 AGENT_ROLE');
      if (agentTier < 2) throw new ApiError(503, 'AGENT_FROZEN', '执行账户处于 Frozen 或 ReadOnly tier');
      if (!walletCanAttest || !walletCanApprove) throw new ApiError(503, 'WALLET_ROLE_MISSING', 'Wallet 缺少写入或审批 attestation 所需角色');
      // These proofs permit read-only access when only price freshness fails.
      // Do not retain them for a network, binding, deployment, or role failure.
      verifiedStructure = { rpcChainId: this.config.chainId, contractsDeployed: true, deploymentBindingsVerified: true, executorAuthorized: true, executorConfigured: true, agentTier: Number(agentTier) };
      const quote = await this.publicClient.readContract({ address: this.config.oracleAddress, abi: oracleAbi, functionName: 'latestEthQuote', args: [1n], blockNumber: observedBlock });
      const maxAge = await this.publicClient.readContract({ address: this.config.walletAddress, abi: walletAbi, functionName: 'maxPriceAge', blockNumber: observedBlock });
      const timestamp = BigInt(snapshot.observedBlockTimestamp!);
      if (!quote[3] || quote[3] > timestamp || timestamp - quote[3] > maxAge) throw new ApiError(503, 'FEED_STALE', 'Feed 超过合约 freshness 限制');
      const funded = BigInt(snapshot.walletBalanceWei) > 0n && BigInt(snapshot.agentBalanceWei) > 0n;
      return { ready: funded, ...(!funded ? { code: 'FUNDING_REQUIRED', message: '资金池或执行账户需要测试 ETH' } : {}), rpcChainId: this.config.chainId, contractsDeployed: true, deploymentBindingsVerified: true, executorAuthorized: true, executorConfigured: true, agentTier: Number(agentTier), feedFresh: true, walletFunded: BigInt(snapshot.walletBalanceWei) > 0n, executorFunded: BigInt(snapshot.agentBalanceWei) > 0n };
    } catch (error) { const result = chainError(error); return { ready: false, code: result.code, message: result.message, ...(result.code === 'FEED_STALE' && Object.keys(verifiedStructure).length ? { ...verifiedStructure, feedFresh: false } : {}) }; }
  }
  async snapshot(): Promise<Snapshot> {
    try {
      await this.requireChain();
      const block = await this.publicClient.getBlock();
      const observedBlockNumber = block.number;
      const recipientAddress = this.config.recipientAddress;
      const base = { address: this.config.walletAddress, abi: walletAbi, blockNumber: observedBlockNumber } as const;
      const [walletBalance, agentBalance, recipientBalance, version, auto, perTx, daily, spending] = await Promise.all([
        this.publicClient.getBalance({ address: this.config.walletAddress, blockNumber: observedBlockNumber }),
        this.publicClient.getBalance({ address: this.config.agentAddress, blockNumber: observedBlockNumber }),
        this.publicClient.getBalance({ address: recipientAddress, blockNumber: observedBlockNumber }),
        this.publicClient.readContract({ ...base, functionName: 'policyVersion' }),
        this.publicClient.readContract({ ...base, functionName: 'autoLimitUsd6' }),
        this.publicClient.readContract({ ...base, functionName: 'perTxLimitUsd6' }),
        this.publicClient.readContract({ ...base, functionName: 'dailyLimitUsd6' }),
        this.publicClient.readContract({ ...base, functionName: 'spendingToday' }),
      ]);
      return {
        chainId: this.config.chainId, walletAddress: this.config.walletAddress, ownerAddress: this.config.ownerAddress, agentAddress: this.config.agentAddress, recipientAddress,
        walletBalanceWei: walletBalance.toString(), agentBalanceWei: agentBalance.toString(), recipientBalanceWei: recipientBalance.toString(),
        policyVersion: version.toString(), budget: { autoThresholdUsd6: auto.toString(), hardPerTxUsd6: perTx.toString(), dailyLimitUsd6: daily.toString(), spentTodayUsd6: spending[0].toString(), remainingUsd6: spending[1].toString(), window: 'UTC_CALENDAR_DAY' },
        observedBlockNumber: observedBlockNumber.toString(), observedBlockHash: block.hash, observedBlockTimestamp: block.timestamp.toString(), observedAt: new Date().toISOString(), dataSource: 'chain',
      };
    } catch (error) { throw chainError(error); }
  }
  private async checkDeploymentBindings(blockNumber: bigint) {
    const [owner, acl, attestations, oracle, policyEngine, policyOwner, policyAcl, policyOracle, consumerAuthorized, managerAuthorized, feed, locked] = await Promise.all([
      this.publicClient.readContract({ address: this.config.walletAddress, abi: walletBindingAbi, functionName: 'owner', blockNumber }),
      this.publicClient.readContract({ address: this.config.walletAddress, abi: walletBindingAbi, functionName: 'acl', blockNumber }),
      this.publicClient.readContract({ address: this.config.walletAddress, abi: walletBindingAbi, functionName: 'attestations', blockNumber }),
      this.publicClient.readContract({ address: this.config.walletAddress, abi: walletBindingAbi, functionName: 'oracle', blockNumber }),
      this.publicClient.readContract({ address: this.config.walletAddress, abi: walletBindingAbi, functionName: 'policyEngine', blockNumber }),
      this.publicClient.readContract({ address: this.config.policyEngineAddress, abi: policyEngineAbi, functionName: 'owner', blockNumber }),
      this.publicClient.readContract({ address: this.config.policyEngineAddress, abi: policyEngineAbi, functionName: 'acl', blockNumber }),
      this.publicClient.readContract({ address: this.config.policyEngineAddress, abi: policyEngineAbi, functionName: 'oracle', blockNumber }),
      this.publicClient.readContract({ address: this.config.policyEngineAddress, abi: policyEngineAbi, functionName: 'authorizedConsumers', args: [this.config.walletAddress], blockNumber }),
      this.publicClient.readContract({ address: this.config.policyEngineAddress, abi: policyEngineAbi, functionName: 'policyManagers', args: [this.config.walletAddress], blockNumber }),
      this.publicClient.readContract({ address: this.config.oracleAddress, abi: oracleBindingAbi, functionName: 'feeds', args: [zeroAddress], blockNumber }),
      this.publicClient.readContract({ address: this.config.oracleAddress, abi: oracleBindingAbi, functionName: 'configurationLocked', blockNumber }),
    ]);
    if (!equal(owner, this.config.ownerAddress)) throw new ApiError(503, 'OWNER_MISMATCH', '部署配置的 owner 与 Wallet 不一致');
    if (!equal(acl, this.config.aclAddress) || !equal(attestations, this.config.attestationAddress) || !equal(policyEngine, this.config.policyEngineAddress)) {
      throw new ApiError(503, 'DEPLOYMENT_BINDING_MISMATCH', 'Wallet 绑定的 ACL/Attestation/PolicyEngine 与部署配置不一致');
    }
    if (!equal(policyOwner, this.config.ownerAddress) || !equal(policyAcl, this.config.aclAddress) || !equal(policyOracle, this.config.oracleAddress) || !consumerAuthorized || !managerAuthorized) {
      throw new ApiError(503, 'POLICY_ENGINE_MISMATCH', 'PolicyEngine 绑定或 Wallet 授权与部署配置不一致');
    }
    if (!equal(oracle, this.config.oracleAddress) || !equal(feed, this.config.feedAddress) || !locked) {
      throw new ApiError(503, 'ORACLE_CONFIGURATION_CHANGED', 'Oracle/Feed 未锁定或与部署配置不一致');
    }
  }
  async preview(recipient: Address, amountWei: string, requestedMax?: string): Promise<Omit<Quote, 'quoteId' | 'draftId' | 'draftVersion'>> {
    try {
      const state = await this.snapshot();
      await this.checkDeploymentBindings(BigInt(state.observedBlockNumber));
      const quote = await this.publicClient.readContract({ address: this.config.oracleAddress, abi: oracleAbi, functionName: 'latestEthQuote', args: [BigInt(amountWei)], blockNumber: BigInt(state.observedBlockNumber) });
      const [cost, round, answer, updatedAt, decimals] = quote;
      const now = Math.floor(Date.now() / 1000);
      const chainTime = BigInt(state.observedBlockTimestamp!);
      const maxAge = await this.publicClient.readContract({ address: this.config.walletAddress, abi: walletAbi, functionName: 'maxPriceAge', blockNumber: BigInt(state.observedBlockNumber) });
      if (answer <= 0n || !updatedAt || updatedAt > chainTime || chainTime - updatedAt > maxAge) throw new ApiError(503, 'FEED_STALE', 'Feed 缺失、时间异常或超过 freshness 限制');
      const maxCost = requestedMax ? BigInt(requestedMax) : (cost * 101n + 99n) / 100n;
      const deadline = Number(chainTime) + this.config.requestSeconds;
      const allowed = await this.publicClient.readContract({ address: this.config.walletAddress, abi: walletAbi, functionName: 'allowedRecipients', args: [recipient], blockNumber: BigInt(state.observedBlockNumber) });
      const reasons: string[] = [];
      if (!allowed) reasons.push('NOT_ALLOWLISTED');
      if (cost > BigInt(state.budget.hardPerTxUsd6)) reasons.push('PER_TX_LIMIT');
      if (cost > BigInt(state.budget.remainingUsd6)) reasons.push('BUDGET_EXCEEDED');
      if (BigInt(amountWei) > BigInt(state.walletBalanceWei)) reasons.push('INSUFFICIENT_FUNDS');
      if (cost > maxCost) reasons.push('REQUOTE_REQUIRED');
      let requiresApproval = cost > BigInt(state.budget.autoThresholdUsd6);
      if (!reasons.length) {
        const check = await this.publicClient.readContract({ address: this.config.walletAddress, abi: walletAbi, functionName: 'previewNativeTransfer', args: [this.config.agentAddress, recipient, BigInt(amountWei), maxCost, BigInt(deadline), BigInt(state.policyVersion)], blockNumber: BigInt(state.observedBlockNumber) });
        requiresApproval = check[1];
      }
      return {
        status: reasons.length ? 'BLOCKED' : 'READY', chainId: this.config.chainId, walletAddress: this.config.walletAddress, agentAddress: this.config.agentAddress, recipient, to: recipient,
        amountWei, costUsd6: cost.toString(), maxUsdCost6: maxCost.toString(), policyVersion: state.policyVersion,
        requestDeadlineSeconds: deadline, quoteExpiresAtSeconds: now + this.config.quoteSeconds, requestNonce: null, requestHash: null,
        decision: reasons.length ? 'BLOCK' : requiresApproval ? 'OWNER_APPROVAL' : 'AUTO',
        reasonCodes: reasons.length ? reasons : requiresApproval ? [cost > BigInt(state.budget.autoThresholdUsd6) ? 'AUTO_THRESHOLD_EXCEEDED' : 'AGENT_TIER_REQUIRES_APPROVAL'] : [], budget: state.budget,
        feedAddress: this.config.feedAddress, feedDecimals: decimals, priceAnswer: answer.toString(), roundId: round.toString(), updatedAtSeconds: Number(updatedAt),
        observedBlockNumber: state.observedBlockNumber, observedBlockHash: state.observedBlockHash,
        oracle: { feedAddress: this.config.feedAddress, roundId: round.toString(), answer: answer.toString(), decimals, updatedAt: updatedAt.toString(), observedAt: new Date().toISOString(), maxAgeSeconds: maxAge.toString(), freshnessStatus: 'FRESH' },
        triggerType: 'manual', ruleId: null,
      };
    } catch (error) { throw chainError(error); }
  }
  async prepare(task: Task): Promise<Prepared> {
    try {
      await this.requireChain();
      if (!this.account || !this.walletClient) throw new ApiError(503, 'EXECUTOR_KEY_MISSING', '未配置执行密钥');
      if (!equal(this.account.address, this.config.agentAddress)) throw new ApiError(503, 'EXECUTOR_MISMATCH', '执行账户与部署不一致');
      const nonce = await this.publicClient.readContract({ address: this.config.walletAddress, abi: walletAbi, functionName: 'nextNonce', args: [this.account.address] });
      const args = [task.recipient, BigInt(task.amountWei), BigInt(task.maxUsdCost6), nonce, BigInt(task.requestDeadlineSeconds), BigInt(task.policyVersion)] as const;
      await this.publicClient.simulateContract({ address: this.config.walletAddress, abi: walletAbi, functionName: 'requestNativeTransfer', account: this.account, args });
      const requestHash = await this.publicClient.readContract({ address: this.config.walletAddress, abi: walletAbi, functionName: 'hashRequest', args: [this.account.address, ...args] });
      const localHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,address,address,address,uint256,uint256,uint256,uint64,uint64'), [keccak256(toHex('aegis.native-transfer.v1')), BigInt(this.config.chainId), this.config.walletAddress, this.account.address, ...args]));
      if (localHash !== requestHash) throw new ApiError(503, 'REQUEST_HASH_MISMATCH', '本地重建请求 hash 与合约不同');
      const data = encodeFunctionData({ abi: walletAbi, functionName: 'requestNativeTransfer', args });
      const senderNonce = await this.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
      const request = await this.walletClient.prepareTransactionRequest({ account: this.account, to: this.config.walletAddress, data, nonce: senderNonce, value: 0n });
      const rawTransaction = await this.walletClient.signTransaction(request);
      return { rawTransaction, hash: keccak256(rawTransaction), senderNonce: senderNonce.toString(), requestNonce: nonce.toString(), requestHash };
    } catch (error) { throw chainError(error); }
  }
  async broadcast(raw: Hex) { return this.publicClient.sendRawTransaction({ serializedTransaction: raw }); }
  ownerTx(task: Task, action: 'approve' | 'cancel') {
    if (!task.attestationId) throw new ApiError(409, 'NOT_PENDING', '任务没有待审批 attestationId');
    return { to: this.config.walletAddress, data: encodeFunctionData({ abi: walletAbi, functionName: action === 'approve' ? 'approveAndExecute' : 'cancelPending', args: [BigInt(task.attestationId)] }), value: '0', from: this.config.ownerAddress, chainId: this.config.chainId, action };
  }
  async preflightOwner(task: Task, action: 'approve' | 'cancel') {
    try {
      await this.requireChain();
      if (!task.attestationId) throw new ApiError(409, 'NOT_PENDING', '没有 pending attestationId');
      const pending = await this.publicClient.readContract({ address: this.config.walletAddress, abi: walletAbi, functionName: 'pending', args: [BigInt(task.attestationId)] });
      if (!pending[8] || !equal(pending[0], task.agentAddress) || !equal(pending[1], task.recipient) || pending[2].toString() !== task.amountWei || pending[3].toString() !== task.maxUsdCost6 || pending[4].toString() !== task.requestNonce || pending[5].toString() !== String(task.requestDeadlineSeconds) || pending[6].toString() !== task.policyVersion || !equal(pending[7], task.requestHash!)) throw new ApiError(409, 'PENDING_BINDING_MISMATCH', '链上 pending 内容与显示任务不同；请停止签名并核对部署');
      await this.publicClient.simulateContract({ address: this.config.walletAddress, abi: walletAbi, functionName: action === 'approve' ? 'approveAndExecute' : 'cancelPending', args: [BigInt(task.attestationId)], account: this.config.ownerAddress });
    } catch (error) { throw chainError(error); }
  }
  async findOwnerOutcome(task: Task): Promise<Outcome | null> {
    const request = task.transactions.find(transaction => transaction.role === 'request');
    if (!request?.blockNumber || !task.requestHash) return null;
    const base = { address: this.config.walletAddress, abi: walletAbi, args: { requestHash: task.requestHash }, fromBlock: BigInt(request.blockNumber), toBlock: 'latest' as const };
    const [executed, cancelled] = await Promise.all([
      this.publicClient.getContractEvents({ ...base, eventName: 'NativeTransferExecuted' }),
      this.publicClient.getContractEvents({ ...base, eventName: 'NativeTransferCancelled' }),
    ]);
    if (executed[0]?.transactionHash) return this.outcome(task, executed[0].transactionHash, 'approve');
    if (cancelled[0]?.transactionHash) return this.outcome(task, cancelled[0].transactionHash, 'cancel');
    return null;
  }
  async outcome(task: Task, hash: Hex, role: 'request' | 'approve' | 'cancel'): Promise<Outcome | null> {
    await this.requireChain();
    let receipt;
    try { receipt = await this.publicClient.getTransactionReceipt({ hash }); }
    catch (error) { if (/not found|could not be found/i.test(errorMessage(error))) return null; throw chainError(error); }
    const transaction = await this.publicClient.getTransaction({ hash });
    const expected = role === 'request' ? encodeFunctionData({ abi: walletAbi, functionName: 'requestNativeTransfer', args: [task.recipient, BigInt(task.amountWei), BigInt(task.maxUsdCost6), BigInt(task.requestNonce!), BigInt(task.requestDeadlineSeconds), BigInt(task.policyVersion)] }) : this.ownerTx(task, role).data;
    const sender = role === 'request' ? this.config.agentAddress : this.config.ownerAddress;
    if (!equal(transaction.from, sender) || !transaction.to || !equal(transaction.to, this.config.walletAddress) || !equal(transaction.input, expected) || transaction.value !== 0n) throw new ApiError(422, 'TX_BINDING_MISMATCH', '交易的 sender、合约、calldata 或金额不属于该任务');
    const evidence: TransactionEvidence = { role, hash, receiptStatus: receipt.status === 'success' ? 1 : 0, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, senderNonce: transaction.nonce.toString(), finality: 'mined' };
    if (receipt.status !== 'success') return { status: 'FAILED', transaction: evidence, reasonCode: 'TX_REVERTED' };
    let walletEvent: { eventName: 'NativeTransferExecuted' | 'NativeTransferQueued' | 'NativeTransferCancelled'; args: Record<string, string | bigint> } | undefined;
    let policyEvent: { args: Record<string, string | bigint>; logIndex: number } | undefined;
    let sawPolicyEvent = false;
    for (const [index, log] of receipt.logs.entries()) {
      if (equal(log.address, this.config.walletAddress)) {
        let decoded;
        try { decoded = decodeEventLog({ abi: walletAbi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
        if (!['NativeTransferExecuted', 'NativeTransferQueued', 'NativeTransferCancelled'].includes(decoded.eventName)) continue;
        const args = decoded.args as unknown as Record<string, string | bigint>;
        if (!task.requestHash || !equal(String(args.requestHash), task.requestHash)) continue;
        if (task.attestationId && String(args.attestationId) !== task.attestationId) continue;
        if (decoded.eventName === 'NativeTransferCancelled') {
          if (role === 'cancel') walletEvent = { eventName: decoded.eventName, args };
          continue;
        }
        if (role === 'cancel' || !equal(String(args.agent), task.agentAddress) || !equal(String(args.to), task.recipient) || String(args.amountWei) !== task.amountWei || String(args.policyVersion) !== task.policyVersion) continue;
        if (decoded.eventName === 'NativeTransferQueued' && (role !== 'request' || String(args.maxUsdCost6) !== task.maxUsdCost6 || String(args.deadline) !== String(task.requestDeadlineSeconds))) continue;
        walletEvent = { eventName: decoded.eventName, args };
        continue;
      }
      if (!equal(log.address, this.config.policyEngineAddress)) continue;
      let decoded;
      try { decoded = decodeEventLog({ abi: policyEngineAbi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
      if (decoded.eventName !== 'BudgetConsumed') continue;
      sawPolicyEvent = true;
      const args = decoded.args as unknown as Record<string, string | bigint>;
      const decision = BigInt(args.decision);
      const decisionMatchesExecution = role === 'request' ? decision === 1n : role === 'approve' ? decision === 1n || decision === 2n : false;
      if (!task.requestHash || !equal(String(args.requestHash), task.requestHash) || !equal(String(args.actor), task.agentAddress)) continue;
      if (BigInt(args.actionType) !== 0n || !decisionMatchesExecution) continue;
      policyEvent = { args, logIndex: Number(log.logIndex ?? index) };
    }
    if (!walletEvent) return { status: 'FAILED', transaction: evidence, reasonCode: 'EXPECTED_EVENT_MISSING' };
    const eventData = Object.fromEntries(Object.entries(walletEvent.args).map(([key, value]) => [key, String(value)]));
    const boundTransaction = { ...evidence, event: walletEvent.eventName };
    if (walletEvent.eventName === 'NativeTransferCancelled') {
      if (sawPolicyEvent) return { status: 'FAILED', transaction: boundTransaction, reasonCode: 'UNEXPECTED_POLICY_EVENT' };
      return { status: 'CANCELLED', attestationId: String(walletEvent.args.attestationId), transaction: boundTransaction, eventData };
    }
    if (walletEvent.eventName === 'NativeTransferQueued') {
      if (sawPolicyEvent) return { status: 'FAILED', transaction: boundTransaction, reasonCode: 'UNEXPECTED_POLICY_EVENT' };
      return { status: 'AWAITING_APPROVAL', attestationId: String(walletEvent.args.attestationId), transaction: boundTransaction, eventData };
    }
    if (!policyEvent) return { status: 'FAILED', transaction: boundTransaction, reasonCode: sawPolicyEvent ? 'POLICY_EVENT_MISMATCH' : 'POLICY_EVENT_MISSING' };
    const policyCost = String(policyEvent.args.costUsd6);
    if (policyCost !== String(walletEvent.args.costUsd6) || BigInt(policyEvent.args.spentUsd6) < BigInt(policyEvent.args.costUsd6)) {
      return { status: 'FAILED', transaction: boundTransaction, reasonCode: 'POLICY_EVENT_MISMATCH' };
    }
    const decision = BigInt(policyEvent.args.decision) === 1n ? 'ALLOW' : 'REQUIRE_APPROVAL';
    const policyEvidence: PolicyEvidence = {
      engineAddress: this.config.policyEngineAddress, event: 'BudgetConsumed', actionType: 'NATIVE_TRANSFER', decision,
      requestHash: String(policyEvent.args.requestHash) as Hex, actor: String(policyEvent.args.actor) as Hex,
      costUsd6: policyCost, day: String(policyEvent.args.day), spentUsd6: String(policyEvent.args.spentUsd6),
      policyVersion: String(walletEvent.args.policyVersion), oracleAddress: this.config.oracleAddress, feedAddress: this.config.feedAddress,
      roundId: String(walletEvent.args.roundId), updatedAtSeconds: String(walletEvent.args.updatedAt),
      transactionHash: hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
      logIndex: policyEvent.logIndex, verified: true,
    };
    return { status: 'EXECUTED', attestationId: String(walletEvent.args.attestationId), transaction: boundTransaction, eventData, policyEvidence };
  }
}
