export const SCHEMA_VERSION = 'aegis.v1' as const;
export type RuntimeMode = 'local_chain' | 'testnet' | 'mock';
export type TaskStatus = 'DRAFT' | 'NEEDS_INPUT' | 'READY' | 'SUBMITTING' | 'BROADCAST' | 'UNKNOWN' | 'AWAITING_APPROVAL' | 'EXECUTED' | 'BLOCKED' | 'REQUOTE_REQUIRED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type Hex = `0x${string}`;
export interface ParserInfo { kind: 'rule_parser'; model: null; configuredModel: string | null; fallback: boolean; reason: string }
export interface Intent {
  draftId: string; intentId: string; version: number; revision: number; status: TaskStatus;
  message: string; recipient: Hex | null; to: Hex | null; amountWei: string | null; purpose: string;
  missingFields: string[]; question: string | null; parser: ParserInfo;
  createdAt: string; updatedAt: string;
}
export interface TransactionEvidence {
  role: 'request' | 'approve' | 'cancel'; hash: Hex; receiptStatus?: number; blockNumber?: string;
  blockHash?: Hex; event?: string; senderNonce?: string; finality?: 'mined' | 'pending';
}
export interface Task {
  taskId: string; draftId: string; intentId: string; draftVersion: number; stateVersion: number;
  status: TaskStatus; chainId: number; walletAddress: Hex; ownerAddress: Hex; agentAddress: Hex;
  recipient: Hex; to: Hex; amountWei: string; maxUsdCost6: string; previewCostUsd6: string;
  requestDeadlineSeconds: number; policyVersion: string; requestNonce: string | null;
  requestHash: Hex | null; attestationId: string | null; txHash: Hex | null;
  triggerType: 'manual'; ruleId: null; reasonCodes: string[]; transactions: TransactionEvidence[];
  availableActions: string[]; createdAt: string; updatedAt: string; parser: ParserInfo;
  verification: { kind: 'chain' | 'mock'; chainVerified: boolean; hashVerified: boolean };
}
export const walletAbiSignatures = [
  'function owner() view returns (address)',
  'function depositETH() payable',
  'function oracle() view returns (address)',
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
