import { randomUUID } from 'node:crypto';
import { decodeEventLog, decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { Task } from '@aegis/shared';
import { walletAbi, type Outcome, type ViemGateway } from './chain.js';
import type { Config } from './config.js';

const addressSchema = z.custom<Address>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value));
const hexSchema = z.custom<Hex>(value => typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value));
const hashSchema = z.custom<Hex>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value));
const unsigned = z.bigint().nonnegative();
const queueSchema = z.object({
  transactionHash: hashSchema,
  requestHash: hashSchema,
  attestationId: unsigned,
  requester: addressSchema,
  recipient: addressSchema,
  amountWei: unsigned,
  maxUsdCost6: unsigned,
  requestNonce: unsigned,
  deadline: unsigned,
  policyVersion: unsigned,
  senderNonce: unsigned,
}).strict();
export type SepoliaApprovalQueue = z.infer<typeof queueSchema>;

const approvalOutcomeSchema = z.object({
  status: z.literal('EXECUTED'),
  attestationId: z.string().regex(/^\d+$/),
  transaction: z.object({
    hash: hashSchema,
    receiptStatus: z.literal(1),
    event: z.literal('NativeTransferExecuted'),
    finality: z.literal('mined'),
  }).passthrough(),
  policyEvidence: z.object({
    event: z.literal('BudgetConsumed'),
    decision: z.enum(['ALLOW', 'REQUIRE_APPROVAL']),
    requestHash: hashSchema,
    actor: addressSchema,
    costUsd6: z.string().regex(/^\d+$/),
    transactionHash: hashSchema,
    verified: z.literal(true),
  }).passthrough(),
  eventData: z.object({
    to: addressSchema,
    amountWei: z.string().regex(/^\d+$/),
    requestHash: hashSchema,
    attestationId: z.string().regex(/^\d+$/),
  }).passthrough(),
}).passthrough();

export const sepoliaApprovalReportSchema = z.object({
  ok: z.literal(true),
  readOnly: z.literal(true),
  checkedAt: z.string().datetime(),
  chainId: z.literal(11155111),
  queueTransactionHash: hashSchema,
  approvalTransactionHash: hashSchema,
  requestHash: hashSchema,
  attestationId: z.string().regex(/^\d+$/),
  requester: addressSchema,
  recipient: addressSchema,
  amountWei: z.string().regex(/^\d+$/),
  costUsd6: z.string().regex(/^\d+$/),
  finalPolicyDecision: z.enum(['ALLOW', 'REQUIRE_APPROVAL']),
  evidence: z.object({
    queueBound: z.literal(true),
    ownerTransactionBound: z.literal(true),
    walletTransfer: z.literal(true),
    approvalBudgetConsumed: z.literal(true),
    requestHashBound: z.literal(true),
  }).strict(),
}).strict();
export type SepoliaApprovalReport = z.infer<typeof sepoliaApprovalReportSchema>;

export interface SepoliaApprovalReader {
  queued(hash: Hex): Promise<unknown>;
  approved(queue: SepoliaApprovalQueue, hash: Hex): Promise<unknown>;
}

const transactionSchema = z.object({
  hash: hashSchema, from: addressSchema, to: addressSchema, input: hexSchema,
  value: unsigned, nonce: unsigned,
}).passthrough();
const receiptSchema = z.object({
  status: z.literal('success'),
  logs: z.array(z.object({ address: addressSchema, data: hexSchema, topics: z.tuple([hexSchema]).rest(hexSchema) }).passthrough()),
}).passthrough();
const requestArgumentsSchema = z.tuple([addressSchema, unsigned, unsigned, unsigned, unsigned, unsigned]);
const queuedEventSchema = z.object({
  requestHash: hashSchema, attestationId: unsigned, agent: addressSchema, to: addressSchema,
  amountWei: unsigned, maxUsdCost6: unsigned, deadline: unsigned, policyVersion: unsigned,
}).strict();

function same(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }

export class GatewayApprovalReader implements SepoliaApprovalReader {
  constructor(private readonly config: Config, private readonly gateway: ViemGateway) {}

  async queued(hash: Hex): Promise<SepoliaApprovalQueue> {
    const [rawTransaction, rawReceipt] = await Promise.all([
      this.gateway.publicClient.getTransaction({ hash }),
      this.gateway.publicClient.getTransactionReceipt({ hash }),
    ]);
    const transaction = transactionSchema.parse(rawTransaction);
    const receipt = receiptSchema.parse(rawReceipt);
    if (!same(transaction.from, this.config.agentAddress) || !same(transaction.to, this.config.walletAddress) || transaction.value !== 0n) {
      throw new Error('Queue transaction is not an executor call to the configured Wallet');
    }
    const decodedCall = decodeFunctionData({ abi: walletAbi, data: transaction.input });
    if (decodedCall.functionName !== 'requestNativeTransfer') throw new Error('Queue transaction is not requestNativeTransfer');
    const call = requestArgumentsSchema.parse(decodedCall.args);

    let queuedEvent: z.infer<typeof queuedEventSchema> | undefined;
    for (const rawLog of receipt.logs) {
      if (!same(rawLog.address, this.config.walletAddress)) continue;
      try {
        const decoded = decodeEventLog({ abi: walletAbi, data: rawLog.data, topics: rawLog.topics, strict: true });
        if (decoded.eventName === 'NativeTransferQueued') queuedEvent = queuedEventSchema.parse(decoded.args);
      } catch { /* Ignore unrelated Wallet logs; the required event is checked below. */ }
    }
    if (!queuedEvent) throw new Error('Queue receipt does not contain NativeTransferQueued');
    if (
      !same(queuedEvent.agent, transaction.from) || !same(queuedEvent.to, call[0])
      || queuedEvent.amountWei !== call[1] || queuedEvent.maxUsdCost6 !== call[2]
      || queuedEvent.deadline !== call[4] || queuedEvent.policyVersion !== call[5]
    ) throw new Error('Queue event is not bound to requestNativeTransfer calldata');

    return queueSchema.parse({
      transactionHash: transaction.hash, requestHash: queuedEvent.requestHash,
      attestationId: queuedEvent.attestationId, requester: queuedEvent.agent, recipient: queuedEvent.to,
      amountWei: queuedEvent.amountWei, maxUsdCost6: queuedEvent.maxUsdCost6,
      requestNonce: call[3], deadline: queuedEvent.deadline, policyVersion: queuedEvent.policyVersion,
      senderNonce: transaction.nonce,
    });
  }

  async approved(queue: SepoliaApprovalQueue, hash: Hex): Promise<Outcome | null> {
    const now = new Date().toISOString();
    const identifier = randomUUID();
    const task: Task = {
      taskId: identifier, draftId: identifier, intentId: identifier, draftVersion: 1, stateVersion: 1,
      status: 'AWAITING_APPROVAL', chainId: this.config.chainId, walletAddress: this.config.walletAddress,
      ownerAddress: this.config.ownerAddress, agentAddress: getAddress(queue.requester),
      recipient: getAddress(queue.recipient), to: getAddress(queue.recipient), amountWei: queue.amountWei.toString(),
      maxUsdCost6: queue.maxUsdCost6.toString(), previewCostUsd6: '0',
      requestDeadlineSeconds: Number(queue.deadline), policyVersion: queue.policyVersion.toString(),
      requestNonce: queue.requestNonce.toString(), requestHash: queue.requestHash,
      attestationId: queue.attestationId.toString(), txHash: queue.transactionHash,
      triggerType: 'manual', ruleId: null, reasonCodes: ['OWNER_APPROVAL_REQUIRED'],
      transactions: [{ role: 'request', hash: queue.transactionHash, senderNonce: queue.senderNonce.toString(), finality: 'mined' }],
      availableActions: ['owner_approve_and_execute'], createdAt: now, updatedAt: now,
      parser: { kind: 'rule_parser', model: null, configuredModel: null, fallback: false, reason: 'SEPOLIA_APPROVAL_EVIDENCE' },
      verification: { kind: 'chain', chainVerified: false, hashVerified: false },
    };
    return this.gateway.outcome(task, hash, 'approve');
  }
}

export async function runSepoliaApprovalCheck(
  config: Config, reader: SepoliaApprovalReader, queueHash: Hex, approvalHash: Hex,
): Promise<SepoliaApprovalReport> {
  if (config.mode !== 'testnet' || config.chainId !== 11155111) throw new Error('Approval evidence check requires Sepolia chain 11155111');
  const queue = queueSchema.parse(await reader.queued(queueHash));
  if (!same(queue.requester, config.agentAddress) || !same(queue.recipient, config.recipientAddress)) {
    throw new Error('Queued request does not match the configured executor and recipient');
  }
  const approval = approvalOutcomeSchema.parse(await reader.approved(queue, approvalHash));
  if (
    approval.attestationId !== queue.attestationId.toString()
    || !same(approval.transaction.hash, approvalHash)
    || !same(approval.policyEvidence.transactionHash, approvalHash)
    || !same(approval.policyEvidence.requestHash, queue.requestHash)
    || !same(approval.policyEvidence.actor, queue.requester)
    || !same(approval.eventData.requestHash, queue.requestHash)
    || approval.eventData.attestationId !== queue.attestationId.toString()
    || !same(approval.eventData.to, queue.recipient)
    || approval.eventData.amountWei !== queue.amountWei.toString()
  ) throw new Error('Approval receipt evidence is not bound to the queued request');

  return sepoliaApprovalReportSchema.parse({
    ok: true, readOnly: true, checkedAt: new Date().toISOString(), chainId: 11155111,
    queueTransactionHash: queue.transactionHash, approvalTransactionHash: approval.transaction.hash,
    requestHash: queue.requestHash, attestationId: queue.attestationId.toString(), requester: queue.requester,
    recipient: queue.recipient, amountWei: queue.amountWei.toString(), costUsd6: approval.policyEvidence.costUsd6,
    finalPolicyDecision: approval.policyEvidence.decision,
    evidence: { queueBound: true, ownerTransactionBound: true, walletTransfer: true, approvalBudgetConsumed: true, requestHashBound: true },
  });
}
