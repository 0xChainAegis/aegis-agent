import { randomUUID } from 'node:crypto';
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { Task } from '@aegis/shared';
import type { Config } from './config.js';
import type { Gateway } from './chain.js';

const uintString = z.string().regex(/^\d+$/);
const addressSchema = z.custom<Address>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value));
const hexSchema = z.custom<Hex>(value => typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value));
const hex32 = z.custom<Hex>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value));
const snapshotSchema = z.object({
  chainId: z.literal(11155111),
  walletBalanceWei: uintString,
  agentBalanceWei: uintString,
  recipientBalanceWei: uintString,
  policyVersion: uintString,
  budget: z.object({
    autoThresholdUsd6: uintString,
    hardPerTxUsd6: uintString,
    dailyLimitUsd6: uintString,
    spentTodayUsd6: uintString,
    remainingUsd6: uintString,
    window: z.literal('UTC_CALENDAR_DAY'),
  }).strict(),
  observedBlockNumber: uintString,
  observedBlockHash: hex32,
  observedBlockTimestamp: uintString,
}).passthrough();

const quoteSchema = z.object({
  status: z.enum(['READY', 'BLOCKED']),
  decision: z.enum(['AUTO', 'OWNER_APPROVAL', 'BLOCK']),
  chainId: z.literal(11155111),
  walletAddress: addressSchema,
  agentAddress: addressSchema,
  recipient: addressSchema,
  to: addressSchema,
  amountWei: uintString,
  costUsd6: uintString,
  maxUsdCost6: uintString,
  policyVersion: uintString,
  requestDeadlineSeconds: z.number().int().positive(),
  reasonCodes: z.array(z.string()),
}).passthrough();

const preparedSchema = z.object({
  rawTransaction: hexSchema,
  hash: hex32,
  senderNonce: uintString,
  requestNonce: uintString,
  requestHash: hex32,
}).strict();

const outcomeSchema = z.object({
  status: z.enum(['EXECUTED', 'AWAITING_APPROVAL', 'CANCELLED', 'FAILED']),
  transaction: z.object({
    hash: hex32,
    receiptStatus: z.literal(1),
    event: z.literal('NativeTransferExecuted'),
    finality: z.literal('mined'),
  }).passthrough(),
  policyEvidence: z.object({
    event: z.literal('BudgetConsumed'),
    decision: z.enum(['ALLOW', 'REQUIRE_APPROVAL']),
    requestHash: hex32,
    actor: addressSchema,
    costUsd6: uintString,
    spentUsd6: uintString,
    transactionHash: hex32,
    verified: z.literal(true),
  }).passthrough().optional(),
}).passthrough();

export const sepoliaPolicyWriteReportSchema = z.object({
  ok: z.literal(true),
  readOnly: z.literal(false),
  checkedAt: z.string().datetime(),
  chainId: z.literal(11155111),
  amountWei: uintString,
  costUsd6: uintString,
  transactionHash: hex32,
  requestHash: hex32,
  broadcastAcknowledged: z.boolean(),
  before: z.object({ walletBalanceWei: uintString, recipientBalanceWei: uintString, spentTodayUsd6: uintString }).strict(),
  after: z.object({ walletBalanceWei: uintString, recipientBalanceWei: uintString, spentTodayUsd6: uintString }).strict(),
  evidence: z.object({ walletTransfer: z.literal(true), budgetConsumed: z.literal(true), requestHashBound: z.literal(true) }).strict(),
}).strict();
export type SepoliaPolicyWriteReport = z.infer<typeof sepoliaPolicyWriteReportSchema>;

export interface SepoliaPolicyWriteGateway {
  snapshot(): Promise<unknown>;
  preview(recipient: Address, amountWei: string): Promise<unknown>;
  prepare(task: Task): Promise<unknown>;
  broadcast(raw: Hex): Promise<unknown>;
  outcome(task: Task, hash: Hex): Promise<unknown>;
}

export class GatewayPolicyWriter implements SepoliaPolicyWriteGateway {
  constructor(private readonly gateway: Gateway) {}
  snapshot(): Promise<unknown> { return this.gateway.snapshot(); }
  preview(recipient: Address, amountWei: string): Promise<unknown> { return this.gateway.preview(recipient, amountWei); }
  prepare(task: Task): Promise<unknown> { return this.gateway.prepare(task); }
  broadcast(raw: Hex): Promise<unknown> { return this.gateway.broadcast(raw); }
  outcome(task: Task, hash: Hex): Promise<unknown> { return this.gateway.outcome(task, hash, 'request'); }
}

export interface SepoliaPolicyWriteOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const writeOptionsSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(300_000).default(120_000),
  pollIntervalMs: z.number().int().min(0).max(30_000).default(3_000),
}).strict();

function same(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }

function buildTask(config: Config, quote: z.infer<typeof quoteSchema>): Task {
  const now = new Date().toISOString();
  const taskId = randomUUID();
  return {
    taskId, draftId: taskId, intentId: taskId, draftVersion: 1, stateVersion: 1,
    status: 'SUBMITTING', chainId: config.chainId, walletAddress: config.walletAddress,
    ownerAddress: config.ownerAddress, agentAddress: config.agentAddress,
    recipient: getAddress(quote.recipient), to: getAddress(quote.to), amountWei: quote.amountWei,
    maxUsdCost6: quote.maxUsdCost6, previewCostUsd6: quote.costUsd6,
    requestDeadlineSeconds: quote.requestDeadlineSeconds, policyVersion: quote.policyVersion,
    requestNonce: null, requestHash: null, attestationId: null, txHash: null,
    triggerType: 'manual', ruleId: null, reasonCodes: quote.reasonCodes, transactions: [], availableActions: [],
    createdAt: now, updatedAt: now,
    parser: { kind: 'rule_parser', model: null, configuredModel: null, fallback: false, reason: 'SEPOLIA_POLICY_WRITE_SMOKE' },
    verification: { kind: 'chain', chainVerified: false, hashVerified: false },
  };
}

async function waitForOutcome(
  gateway: SepoliaPolicyWriteGateway, task: Task, hash: Hex,
  options: z.infer<typeof writeOptionsSchema>, sleep: (milliseconds: number) => Promise<void>,
): Promise<z.infer<typeof outcomeSchema>> {
  const expires = Date.now() + options.timeoutMs;
  do {
    const candidate = await gateway.outcome(task, hash);
    if (candidate !== null) return outcomeSchema.parse(candidate);
    await sleep(options.pollIntervalMs);
  } while (Date.now() < expires);
  throw new Error(`Sepolia transaction ${hash} remains unresolved; do not rerun the write check until this hash is verified`);
}

export async function runSepoliaPolicyWriteCheck(
  config: Config, gateway: SepoliaPolicyWriteGateway, options: SepoliaPolicyWriteOptions = {},
): Promise<SepoliaPolicyWriteReport> {
  if (config.mode !== 'testnet' || config.chainId !== 11155111) throw new Error('Sepolia write check requires testnet chain 11155111');
  if (!config.agentKey) throw new Error('Sepolia write check requires the configured executor key');
  const parsedOptions = writeOptionsSchema.parse({ timeoutMs: options.timeoutMs, pollIntervalMs: options.pollIntervalMs });
  const sleep = options.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const amountWei = '1';
  const before = snapshotSchema.parse(await gateway.snapshot());
  const quote = quoteSchema.parse(await gateway.preview(config.recipientAddress, amountWei));
  if (quote.status !== 'READY' || quote.decision !== 'AUTO') throw new Error(`One-wei write smoke is not AUTO/READY: ${quote.reasonCodes.join(',') || quote.decision}`);
  if (
    !same(quote.walletAddress, config.walletAddress) || !same(quote.agentAddress, config.agentAddress)
    || !same(quote.recipient, config.recipientAddress) || !same(quote.to, config.recipientAddress)
    || quote.amountWei !== amountWei || quote.policyVersion !== before.policyVersion
    || BigInt(quote.maxUsdCost6) < BigInt(quote.costUsd6)
  ) {
    throw new Error('Sepolia write quote does not match the configured deployment and one-wei request');
  }
  if (BigInt(before.walletBalanceWei) < 1n) throw new Error('Wallet does not hold the one wei required by the write smoke');
  const draftTask = buildTask(config, quote);
  const prepared = preparedSchema.parse(await gateway.prepare(draftTask));
  const task: Task = {
    ...draftTask, requestNonce: prepared.requestNonce, requestHash: prepared.requestHash, txHash: prepared.hash,
    transactions: [{ role: 'request', hash: prepared.hash, senderNonce: prepared.senderNonce, finality: 'pending' }],
  };
  let broadcastResult: unknown = null;
  try {
    broadcastResult = await gateway.broadcast(prepared.rawTransaction);
  } catch {
    // Accepted-then-timeout is ambiguous. Never sign a replacement; only poll
    // the deterministic hash derived from the already persisted raw bytes.
  }
  let broadcastAcknowledged = false;
  if (broadcastResult !== null) {
    const sentHash = hex32.parse(broadcastResult);
    if (!same(sentHash, prepared.hash)) throw new Error('RPC returned a transaction hash different from the signed transaction');
    broadcastAcknowledged = true;
  }
  const outcome = await waitForOutcome(gateway, task, prepared.hash, parsedOptions, sleep);
  if (outcome.status !== 'EXECUTED' || !outcome.policyEvidence) throw new Error(`Sepolia write smoke ended as ${outcome.status}`);
  const evidence = outcome.policyEvidence;
  if (!same(outcome.transaction.hash, prepared.hash) || !same(evidence.transactionHash, prepared.hash) || !same(evidence.requestHash, prepared.requestHash) || !same(evidence.actor, config.agentAddress) || evidence.decision !== 'ALLOW') {
    throw new Error('Sepolia write receipt evidence is not bound to the prepared request');
  }
  const after = snapshotSchema.parse(await gateway.snapshot());
  const amount = BigInt(amountWei);
  const cost = BigInt(evidence.costUsd6);
  if (BigInt(before.observedBlockTimestamp) / 86_400n !== BigInt(after.observedBlockTimestamp) / 86_400n) {
    throw new Error('Sepolia write smoke crossed a UTC budget boundary; verify the transaction hash manually');
  }
  if (BigInt(after.recipientBalanceWei) - BigInt(before.recipientBalanceWei) !== amount) throw new Error('Recipient balance did not increase by exactly one wei');
  if (BigInt(before.walletBalanceWei) - BigInt(after.walletBalanceWei) !== amount) throw new Error('Wallet balance did not decrease by exactly one wei');
  if (BigInt(after.budget.spentTodayUsd6) - BigInt(before.budget.spentTodayUsd6) !== cost) throw new Error('Daily budget did not increase by the verified policy cost');
  if (after.budget.spentTodayUsd6 !== evidence.spentUsd6) throw new Error('Snapshot budget does not match the verified PolicyEngine event');
  return sepoliaPolicyWriteReportSchema.parse({
    ok: true, readOnly: false, checkedAt: new Date().toISOString(), chainId: 11155111,
    amountWei, costUsd6: evidence.costUsd6, transactionHash: prepared.hash, requestHash: prepared.requestHash,
    broadcastAcknowledged,
    before: { walletBalanceWei: before.walletBalanceWei, recipientBalanceWei: before.recipientBalanceWei, spentTodayUsd6: before.budget.spentTodayUsd6 },
    after: { walletBalanceWei: after.walletBalanceWei, recipientBalanceWei: after.recipientBalanceWei, spentTodayUsd6: after.budget.spentTodayUsd6 },
    evidence: { walletTransfer: true, budgetConsumed: true, requestHashBound: true },
  });
}
