export const SCHEMA_VERSION = 'aegis.v1' as const;
export type RuntimeMode = 'local_chain' | 'testnet' | 'mock';
export type TaskStatus = 'DRAFT' | 'NEEDS_INPUT' | 'READY' | 'SUBMITTING' | 'BROADCAST' | 'UNKNOWN' | 'AWAITING_APPROVAL' | 'EXECUTED' | 'BLOCKED' | 'REQUOTE_REQUIRED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type Hex = `0x${string}`;
export interface ParserInfo { kind: 'rule_parser' | 'llm'; model: string | null; configuredModel: string | null; fallback: boolean; reason: string }
export interface SubscriptionConfig {
  subscriptionId: string; agentAddress: Hex; recipient: Hex; amountWei: string;
  periodSeconds: string; startAtSeconds: string; endAtSeconds: string; maxPayments: string;
  periodCapUsd6: string; parentPlanHash: Hex; paidCount: string; paused: boolean; cancelled: boolean;
  currentOccurrenceIndex: string | null; status: string;
}
export interface SubscriptionAction {
  actionKind?: 'NATIVE_TRANSFER' | 'SUBSCRIPTION'; subscriptionId?: string; occurrenceIndex?: string;
  subscription?: SubscriptionConfig; planHash?: Hex;
}
export interface Intent extends SubscriptionAction {
  draftId: string; intentId: string; version: number; revision: number; status: TaskStatus;
  message: string; recipient: Hex | null; to: Hex | null; amountWei: string | null; purpose: string;
  missingFields: string[]; question: string | null; parser: ParserInfo;
  createdAt: string; updatedAt: string;
}
export interface TransactionEvidence {
  role: 'request' | 'approve' | 'cancel'; hash: Hex; receiptStatus?: number; blockNumber?: string;
  blockHash?: Hex; event?: string; senderNonce?: string; finality?: 'mined' | 'pending';
}
export const POLICY_EVIDENCE_VERIFICATION_SCOPE = 'MATCHED_WALLET_AND_POLICY_RECEIPT_EVENTS' as const;
export const POLICY_EVIDENCE_VERIFIED_FIELDS = [
  'engineAddress', 'event', 'actionType', 'decision', 'requestHash', 'actor',
  'costUsd6', 'day', 'spentUsd6', 'transactionHash', 'policyVersion',
  'roundId', 'updatedAtSeconds', 'blockNumber', 'blockHash', 'logIndex',
] as const;
export interface ConfiguredPriceSource {
  oracleAddress: Hex; feedAddress: Hex;
  verified: false; scope: 'CURRENT_CONFIGURATION';
}
export interface PolicyEvidence {
  engineAddress: Hex; event: 'BudgetConsumed'; actionType: 'NATIVE_TRANSFER' | 'SUBSCRIPTION';
  decision: 'ALLOW' | 'REQUIRE_APPROVAL'; requestHash: Hex; actor: Hex;
  costUsd6: string; day: string; spentUsd6: string; transactionHash: Hex;
  policyVersion: string;
  roundId: string; updatedAtSeconds: string;
  blockNumber: string; blockHash: Hex; logIndex: number; verified: true;
  verificationScope: typeof POLICY_EVIDENCE_VERIFICATION_SCOPE;
  verifiedFields: typeof POLICY_EVIDENCE_VERIFIED_FIELDS;
}
export interface Task extends SubscriptionAction {
  taskId: string; draftId: string; intentId: string; draftVersion: number; stateVersion: number;
  status: TaskStatus; chainId: number; walletAddress: Hex; ownerAddress: Hex; agentAddress: Hex;
  recipient: Hex; to: Hex; amountWei: string; maxUsdCost6: string; previewCostUsd6: string;
  requestDeadlineSeconds: number; policyVersion: string; requestNonce: string | null;
  requestHash: Hex | null; attestationId: string | null; txHash: Hex | null;
  triggerType: 'manual'; ruleId: null; reasonCodes: string[]; transactions: TransactionEvidence[];
  availableActions: string[]; createdAt: string; updatedAt: string; parser: ParserInfo;
  verification: { kind: 'chain' | 'mock'; chainVerified: boolean; hashVerified: boolean };
}
export const subscriptionAbiSignatures = [
  'function configureSubscriptionPolicy(uint256 maxPeriodCapUsd6,uint64 maxDurationSeconds,uint64 maxPayments)',
  'function createFiniteSubscription(address agent,address to,uint256 amountWei,uint64 periodSeconds,uint64 startAt,uint64 endAt,uint64 maxPayments,uint256 periodCapUsd6,bytes32 parentPlanHash) returns (uint64 subscriptionId)',
  'function subscriptions(uint64 subscriptionId) view returns ((address agent,address to,uint256 amountWei,uint64 periodSeconds,uint64 startAt,uint64 endAt,uint64 maxPayments,uint256 periodCapUsd6,bytes32 parentPlanHash,uint64 paidCount,uint64 lastPaidOccurrence,bool hasPaid,bool paused,bool cancelled,bool exists))',
  'function pauseFiniteSubscription(uint64 subscriptionId,bool paused)',
  'function cancelFiniteSubscription(uint64 subscriptionId)',
  'function previewSubscriptionPayment(address requester,uint64 subscriptionId,uint64 occurrenceIndex,uint256 maxUsdCost6,uint64 deadline,uint64 version) view returns (uint256 costUsd6,bool requiresApproval)',
  'function requestSubscriptionPayment(uint64 subscriptionId,uint64 occurrenceIndex,uint256 maxUsdCost6,uint256 nonce,uint64 deadline,uint64 version,bytes32 planHash) returns (uint64 attId)',
  'function hashSubscriptionRequest(address agent,uint64 subscriptionId,uint64 occurrenceIndex,uint256 maxUsdCost6,uint256 nonce,uint64 deadline,uint64 version,bytes32 planHash) view returns (bytes32)',
  'function subscriptionPending(uint64 attId) view returns (uint64 subscriptionId,uint64 occurrenceIndex,bytes32 planHash)',
  'event FiniteSubscriptionCreated(uint64 indexed subscriptionId,address indexed agent,address indexed to,bytes32 parentPlanHash)',
  'event FiniteSubscriptionPaused(uint64 indexed subscriptionId,bool paused)',
  'event FiniteSubscriptionCancelled(uint64 indexed subscriptionId)',
  'event SubscriptionPaymentExecuted(bytes32 indexed requestHash,uint64 indexed attestationId,address indexed agent,address to,uint256 amountWei,uint256 costUsd6,uint80 roundId,uint256 updatedAt,uint64 policyVersion,uint64 subscriptionId,uint64 occurrenceIndex,bytes32 planHash)',
  'event SubscriptionPaymentQueued(bytes32 indexed requestHash,uint64 indexed attestationId,address indexed agent,address to,uint256 amountWei,uint256 maxUsdCost6,uint64 deadline,uint64 policyVersion,uint64 subscriptionId,uint64 occurrenceIndex,bytes32 planHash)',
] as const;
export const walletAbiSignatures = [
  ...subscriptionAbiSignatures,
  'function owner() view returns (address)',
  'function depositETH() payable',
  'function oracle() view returns (address)',
  'function policyEngine() view returns (address)',
  'function configurePolicy(address oracle,uint256 autoUsd6,uint256 perTxUsd6,uint256 dailyUsd6,uint256 maxAge)',
  'function setRecipientAllowed(address recipient,bool allowed)',
  'function policyVersion() view returns (uint64)',
  'function nextNonce(address agent) view returns (uint256)',
  'function autoLimitUsd6() view returns (uint256)',
  'function perTxLimitUsd6() view returns (uint256)',
  'function dailyLimitUsd6() view returns (uint256)',
  'function allowedRecipients(address recipient) view returns (bool)',
  'function maxPriceAge() view returns (uint256)',
  'function spendingToday() view returns (uint256 spentUsd6,uint256 remainingUsd6,uint256 day)',
  'function pending(uint64 attId) view returns (address requester,address to,uint256 amountWei,uint256 maxUsdCost6,uint256 nonce,uint64 deadline,uint64 policyVersion,bytes32 requestHash,bool exists)',
  'function previewNativeTransfer(address requester,address to,uint256 amountWei,uint256 maxUsdCost6,uint64 deadline,uint64 version) view returns (uint256 costUsd6,bool requiresApproval)',
  'function requestNativeTransfer(address to,uint256 amountWei,uint256 maxUsdCost6,uint256 nonce,uint64 deadline,uint64 version) returns (uint64 attId)',
  'function approveAndExecute(uint64 attId)',
  'function cancelPending(uint64 attId)',
  'function hashRequest(address agent,address to,uint256 amount,uint256 maxCost,uint256 nonce,uint64 deadline,uint64 version) view returns (bytes32)',
  'event NativeTransferExecuted(bytes32 indexed requestHash,uint64 indexed attestationId,address indexed agent,address to,uint256 amountWei,uint256 costUsd6,uint80 roundId,uint256 updatedAt,uint64 policyVersion)',
  'event NativeTransferQueued(bytes32 indexed requestHash,uint64 indexed attestationId,address indexed agent,address to,uint256 amountWei,uint256 maxUsdCost6,uint64 deadline,uint64 policyVersion)',
  'event NativeTransferCancelled(bytes32 indexed requestHash,uint64 indexed attestationId)',
] as const;
export const oracleAbiSignatures = [
  'function latestEthQuote(uint256 amountWei) view returns (uint256 costUsd6,uint80 roundId,int256 answer,uint256 updatedAt,uint8 decimals)',
  'function feeds(address token) view returns (address)',
] as const;
export const policyEngineAbiSignatures = [
  'event BudgetConsumed(bytes32 indexed requestHash,uint8 indexed actionType,address indexed actor,uint8 decision,uint256 costUsd6,uint256 day,uint256 spentUsd6)',
] as const;
