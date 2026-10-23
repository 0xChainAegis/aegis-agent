import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient, defineChain, getAddress, hexToString, http, isAddress, zeroAddress,
  type Address, type Hex,
} from 'viem';
import { z } from 'zod';
import { oracleAbi } from './chain.js';
import { boundedHttp } from './rpc-concurrency.js';

const SEPOLIA_CHAIN_ID = 11155111;
const decisionNames = ['REJECT', 'ALLOW', 'REQUIRE_APPROVAL'] as const;
const reasonHexSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintStringSchema = z.string().regex(/^\d+$/);

const deploymentSchema = z.object({
  chainId: z.literal(SEPOLIA_CHAIN_ID),
  policyEngineAddress: z.string().refine(isAddress),
  oracleAddress: z.string().refine(isAddress),
  feedAddress: z.string().refine(isAddress),
  agentAddress: z.string().refine(isAddress),
  recipientAddress: z.string().refine(isAddress),
}).passthrough();

const policyStateSchema = z.object({
  chainId: z.literal(SEPOLIA_CHAIN_ID),
  blockNumber: z.bigint().nonnegative(),
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockTimestamp: z.bigint().positive(),
  policyVersion: z.bigint().nonnegative(),
  autoLimitUsd6: z.bigint().nonnegative(),
  perTxLimitUsd6: z.bigint().positive(),
  dailyLimitUsd6: z.bigint().positive(),
  spentUsd6: z.bigint().nonnegative(),
  remainingUsd6: z.bigint().nonnegative(),
  maxPriceAge: z.bigint().positive(),
  feedAddress: z.string().refine(isAddress),
  quote: z.object({
    costUsd6: z.bigint().positive(),
    roundId: z.bigint().positive(),
    answer: z.bigint().positive(),
    updatedAt: z.bigint().positive(),
    decimals: z.number().int().min(0).max(18),
  }).strict(),
}).strict();

const riskResultSchema = z.object({
  decision: z.number().int().min(0).max(2),
  reasonCode: reasonHexSchema,
  costUsd6: z.bigint().nonnegative(),
  remainingUsd6: z.bigint().nonnegative(),
  roundId: z.bigint().nonnegative(),
  updatedAt: z.bigint().nonnegative(),
}).strict();

const caseReportSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  expectedDecision: z.enum(decisionNames).optional(),
  actualDecision: z.enum(decisionNames).optional(),
  expectedReason: z.string().optional(),
  actualReason: z.string().optional(),
  amountWei: uintStringSchema.optional(),
  costUsd6: uintStringSchema.optional(),
  message: z.string().min(1),
}).strict();

export const sepoliaPolicyReportSchema = z.object({
  ok: z.boolean(),
  readOnly: z.literal(true),
  checkedAt: z.string().datetime(),
  chainId: z.literal(SEPOLIA_CHAIN_ID),
  observedBlockNumber: uintStringSchema,
  observedBlockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  policyEngineAddress: z.string().refine(isAddress),
  oracleAddress: z.string().refine(isAddress),
  policyVersion: uintStringSchema,
  feed: z.object({
    address: z.string().refine(isAddress),
    roundId: uintStringSchema,
    answer: uintStringSchema,
    decimals: z.number().int().min(0).max(18),
    updatedAtSeconds: z.number().int().positive(),
    ageSeconds: z.number().int().nonnegative(),
    maxAgeSeconds: z.number().int().positive(),
  }).strict(),
  budget: z.object({
    autoLimitUsd6: uintStringSchema,
    perTxLimitUsd6: uintStringSchema,
    dailyLimitUsd6: uintStringSchema,
    spentUsd6: uintStringSchema,
    remainingUsd6: uintStringSchema,
  }).strict(),
  cases: z.array(caseReportSchema).min(1),
}).strict();

export type SepoliaPolicyReport = z.infer<typeof sepoliaPolicyReportSchema>;
export type PolicyState = z.infer<typeof policyStateSchema>;
export type RiskResult = z.infer<typeof riskResultSchema>;

export interface SepoliaPolicyConfig {
  chainId: typeof SEPOLIA_CHAIN_ID;
  rpcUrl: string;
  policyEngineAddress: Address;
  oracleAddress: Address;
  feedAddress: Address;
  agentAddress: Address;
  recipientAddress: Address;
  rpcTimeoutMs: number;
  rpcRetryCount: number;
}

export interface RiskRequest {
  actionType: number;
  actor: Address;
  recipient: Address;
  asset: Address;
  amount: bigint;
  maxUsdCost6: bigint;
  deadline: bigint;
  policyVersion: bigint;
  requestHash: Hex;
  destinationChainSelector: bigint;
}

export interface SepoliaPolicyReader {
  state(): Promise<unknown>;
  evaluate(request: RiskRequest, blockNumber: bigint): Promise<unknown>;
}

const policyReadAbi = [
  { type: 'function', name: 'policyVersion', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'autoLimitUsd6', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'perTxLimitUsd6', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'dailyLimitUsd6', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'maxPriceAge', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'function', name: 'spendingToday', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'spentUsd6', type: 'uint256' }, { name: 'remainingUsd6', type: 'uint256' }, { name: 'day', type: 'uint256' }],
  },
  {
    type: 'function', name: 'evaluate', stateMutability: 'view',
    inputs: [{
      name: 'request', type: 'tuple', components: [
        { name: 'actionType', type: 'uint8' }, { name: 'actor', type: 'address' },
        { name: 'recipient', type: 'address' }, { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' }, { name: 'maxUsdCost6', type: 'uint256' },
        { name: 'deadline', type: 'uint64' }, { name: 'policyVersion', type: 'uint64' },
        { name: 'requestHash', type: 'bytes32' }, { name: 'destinationChainSelector', type: 'uint64' },
      ],
    }],
    outputs: [{
      name: 'result', type: 'tuple', components: [
        { name: 'decision', type: 'uint8' }, { name: 'reasonCode', type: 'bytes32' },
        { name: 'costUsd6', type: 'uint256' }, { name: 'remainingUsd6', type: 'uint256' },
        { name: 'roundId', type: 'uint80' }, { name: 'updatedAt', type: 'uint256' },
      ],
    }],
  },
] as const;

const envSchema = z.object({
  AEGIS_RPC_URL: z.string().trim().url().optional(),
  RPC_URL: z.string().trim().url().optional(),
  AEGIS_DEPLOYMENT_FILE: z.string().trim().min(1).optional(),
  AEGIS_RPC_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(15_000),
  AEGIS_RPC_RETRY_COUNT: z.coerce.number().int().min(0).max(2).default(1),
}).passthrough();

export function loadSepoliaPolicyConfig(env: NodeJS.ProcessEnv = process.env): SepoliaPolicyConfig {
  const parsedEnv = envSchema.parse(env);
  const rpcUrl = parsedEnv.AEGIS_RPC_URL ?? parsedEnv.RPC_URL;
  if (!rpcUrl) throw new Error('Sepolia policy check requires AEGIS_RPC_URL or RPC_URL');
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:') throw new Error('Sepolia policy check requires an HTTPS RPC URL');
  const deploymentPath = parsedEnv.AEGIS_DEPLOYMENT_FILE ?? resolve('..', 'contracts/deployments/sepolia.json');
  const deployment = deploymentSchema.parse(JSON.parse(readFileSync(deploymentPath, 'utf8')));
  return {
    chainId: SEPOLIA_CHAIN_ID,
    rpcUrl,
    policyEngineAddress: getAddress(deployment.policyEngineAddress),
    oracleAddress: getAddress(deployment.oracleAddress),
    feedAddress: getAddress(deployment.feedAddress),
    agentAddress: getAddress(deployment.agentAddress),
    recipientAddress: getAddress(deployment.recipientAddress),
    rpcTimeoutMs: parsedEnv.AEGIS_RPC_TIMEOUT_MS,
    rpcRetryCount: parsedEnv.AEGIS_RPC_RETRY_COUNT,
  };
}

export class ViemSepoliaPolicyReader implements SepoliaPolicyReader {
  private readonly client;

  constructor(private readonly config: SepoliaPolicyConfig) {
    const chain = defineChain({
      id: SEPOLIA_CHAIN_ID, name: 'Ethereum Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.client = createPublicClient({
      chain,
      transport: boundedHttp(config.rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: config.rpcRetryCount }),
      batch: { multicall: true },
    });
  }

  async state(): Promise<unknown> {
    const [chainId, block] = await Promise.all([this.client.getChainId(), this.client.getBlock()]);
    const blockNumber = block.number;
    const base = { address: this.config.policyEngineAddress, abi: policyReadAbi, blockNumber } as const;
    const [policyVersion, autoLimitUsd6, perTxLimitUsd6, dailyLimitUsd6, maxPriceAge, spending, quote, feedAddress] = await Promise.all([
      this.client.readContract({ ...base, functionName: 'policyVersion' }),
      this.client.readContract({ ...base, functionName: 'autoLimitUsd6' }),
      this.client.readContract({ ...base, functionName: 'perTxLimitUsd6' }),
      this.client.readContract({ ...base, functionName: 'dailyLimitUsd6' }),
      this.client.readContract({ ...base, functionName: 'maxPriceAge' }),
      this.client.readContract({ ...base, functionName: 'spendingToday' }),
      this.client.readContract({ address: this.config.oracleAddress, abi: oracleAbi, functionName: 'latestEthQuote', args: [10n ** 18n], blockNumber }),
      this.client.readContract({ address: this.config.oracleAddress, abi: oracleAbi, functionName: 'feeds', args: [zeroAddress], blockNumber }),
    ]);
    return policyStateSchema.parse({
      chainId, blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp,
      policyVersion, autoLimitUsd6, perTxLimitUsd6, dailyLimitUsd6, maxPriceAge,
      spentUsd6: spending[0], remainingUsd6: spending[1], feedAddress,
      quote: { costUsd6: quote[0], roundId: quote[1], answer: quote[2], updatedAt: quote[3], decimals: quote[4] },
    });
  }

  async evaluate(request: RiskRequest, blockNumber: bigint): Promise<unknown> {
    const result = await this.client.readContract({
      address: this.config.policyEngineAddress, abi: policyReadAbi, functionName: 'evaluate', args: [request], blockNumber,
    });
    return riskResultSchema.parse(result);
  }
}

export function minimumWeiForUsd6(targetUsd6: bigint, answer: bigint, decimals: number): bigint {
  if (targetUsd6 <= 0n) return 0n;
  if (answer <= 0n) throw new Error('Chainlink answer must be positive');
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Chainlink decimals must be from 0 to 18');
  const denominator = 10n ** (12n + BigInt(decimals));
  return ((targetUsd6 - 1n) * denominator) / answer + 1n;
}

function reasonText(reasonCode: string): string {
  const parsed = reasonHexSchema.parse(reasonCode);
  if (/^0x0{64}$/i.test(parsed)) return '';
  return hexToString(parsed as Hex, { size: 32 }).replace(/\0+$/u, '');
}

function decisionText(decision: number): typeof decisionNames[number] {
  const parsed = z.number().int().min(0).max(2).parse(decision);
  return decisionNames[parsed] ?? 'REJECT';
}

interface ExpectedRiskCase {
  id: string;
  request: RiskRequest;
  decision: typeof decisionNames[number];
  reason?: string;
}

export async function runSepoliaPolicyCheck(config: SepoliaPolicyConfig, reader: SepoliaPolicyReader): Promise<SepoliaPolicyReport> {
  if (config.chainId !== SEPOLIA_CHAIN_ID) throw new Error('Sepolia policy check requires chainId 11155111');
  const state = policyStateSchema.parse(await reader.state());
  const fresh = state.quote.updatedAt <= state.blockTimestamp && state.blockTimestamp - state.quote.updatedAt <= state.maxPriceAge;
  const budgetConsistent = state.spentUsd6 >= state.dailyLimitUsd6
    ? state.remainingUsd6 === 0n
    : state.spentUsd6 + state.remainingUsd6 === state.dailyLimitUsd6;
  const baseTarget = state.autoLimitUsd6 > 0n ? state.autoLimitUsd6 : 1n;
  const allowTarget = baseTarget <= state.remainingUsd6 ? baseTarget : state.remainingUsd6;
  if (allowTarget <= 0n) throw new Error('Sepolia daily budget is exhausted; ALLOW boundary cannot be verified read-only');
  const approvalTarget = state.autoLimitUsd6 + 1n;
  if (approvalTarget > state.perTxLimitUsd6 || approvalTarget > state.remainingUsd6) {
    throw new Error('Current Sepolia budget cannot exercise REQUIRE_APPROVAL without changing policy or spending');
  }
  const quoteAnswer = state.quote.answer;
  const quoteDecimals = state.quote.decimals;
  const deadline = state.blockTimestamp + 600n;
  const requestHash = `0x${'00'.repeat(32)}` as Hex;
  const baseRequest = (targetUsd6: bigint): RiskRequest => ({
    actionType: 0, actor: config.agentAddress, recipient: config.recipientAddress, asset: zeroAddress,
    amount: minimumWeiForUsd6(targetUsd6, quoteAnswer, quoteDecimals), maxUsdCost6: targetUsd6,
    deadline, policyVersion: state.policyVersion, requestHash, destinationChainSelector: 0n,
  });
  const allowed = baseRequest(allowTarget);
  const capped = baseRequest(2n);
  capped.maxUsdCost6 = 1n;
  const cases: ExpectedRiskCase[] = [
    { id: 'authorized_allow_boundary', request: allowed, decision: 'ALLOW' },
    { id: 'approval_boundary', request: baseRequest(approvalTarget), decision: 'REQUIRE_APPROVAL' },
    { id: 'unauthorized_actor', request: { ...baseRequest(1n), actor: getAddress('0x000000000000000000000000000000000000dEaD') }, decision: 'REJECT', reason: 'NOT_AGENT' },
    { id: 'recipient_not_allowlisted', request: { ...baseRequest(1n), recipient: zeroAddress }, decision: 'REJECT', reason: 'RECIPIENT_NOT_ALLOWED' },
    { id: 'zero_amount', request: { ...baseRequest(1n), amount: 0n }, decision: 'REJECT', reason: 'ZERO_AMOUNT' },
    { id: 'expired_request', request: { ...baseRequest(1n), deadline: state.blockTimestamp - 1n }, decision: 'REJECT', reason: 'REQUEST_EXPIRED' },
    { id: 'policy_version_mismatch', request: { ...baseRequest(1n), policyVersion: state.policyVersion + 1n }, decision: 'REJECT', reason: 'POLICY_VERSION_MISMATCH' },
    { id: 'quote_cap_exceeded', request: capped, decision: 'REJECT', reason: 'QUOTE_EXCEEDS_MAX' },
    { id: 'per_transaction_limit', request: baseRequest(state.perTxLimitUsd6 + 1n), decision: 'REJECT', reason: 'PER_TX_LIMIT' },
    { id: 'subscription_unsupported', request: { ...baseRequest(1n), actionType: 1 }, decision: 'REJECT', reason: 'UNSUPPORTED_ACTION' },
    { id: 'ccip_unsupported', request: { ...baseRequest(1n), actionType: 2, destinationChainSelector: 1n }, decision: 'REJECT', reason: 'UNSUPPORTED_ACTION' },
  ];
  const reports: SepoliaPolicyReport['cases'] = [
    { id: 'feed_binding', ok: state.feedAddress.toLowerCase() === config.feedAddress.toLowerCase(), message: state.feedAddress.toLowerCase() === config.feedAddress.toLowerCase() ? 'Oracle is bound to the deployment Chainlink Feed.' : 'Oracle Feed binding differs from the deployment manifest.' },
    { id: 'chainlink_feed_fresh', ok: fresh, message: fresh ? 'Chainlink quote is within the on-chain freshness limit.' : 'Chainlink quote is stale or has a future timestamp.' },
    { id: 'daily_budget_accounting', ok: budgetConsistent, message: budgetConsistent ? 'Spent and remaining USD6 match the on-chain daily limit.' : 'Daily budget totals are inconsistent.' },
  ];
  for (const item of cases) {
    const result = riskResultSchema.parse(await reader.evaluate(item.request, state.blockNumber));
    const actualDecision = decisionText(result.decision);
    const actualReason = reasonText(result.reasonCode);
    const ok = actualDecision === item.decision && (item.reason === undefined || actualReason === item.reason);
    reports.push({
      id: item.id, ok, expectedDecision: item.decision, actualDecision,
      ...(item.reason !== undefined ? { expectedReason: item.reason } : {}),
      ...(actualReason ? { actualReason } : {}),
      amountWei: item.request.amount.toString(), costUsd6: result.costUsd6.toString(),
      message: ok ? 'On-chain PolicyEngine decision matches the expected boundary.' : 'On-chain PolicyEngine decision does not match the expected boundary.',
    });
  }
  const age = state.blockTimestamp >= state.quote.updatedAt ? state.blockTimestamp - state.quote.updatedAt : 0n;
  return sepoliaPolicyReportSchema.parse({
    ok: reports.every(item => item.ok), readOnly: true, checkedAt: new Date().toISOString(), chainId: SEPOLIA_CHAIN_ID,
    observedBlockNumber: state.blockNumber.toString(), observedBlockHash: state.blockHash,
    policyEngineAddress: config.policyEngineAddress, oracleAddress: config.oracleAddress, policyVersion: state.policyVersion.toString(),
    feed: { address: state.feedAddress, roundId: state.quote.roundId.toString(), answer: state.quote.answer.toString(), decimals: state.quote.decimals, updatedAtSeconds: Number(state.quote.updatedAt), ageSeconds: Number(age), maxAgeSeconds: Number(state.maxPriceAge) },
    budget: { autoLimitUsd6: state.autoLimitUsd6.toString(), perTxLimitUsd6: state.perTxLimitUsd6.toString(), dailyLimitUsd6: state.dailyLimitUsd6.toString(), spentUsd6: state.spentUsd6.toString(), remainingUsd6: state.remainingUsd6.toString() },
    cases: reports,
  });
}
