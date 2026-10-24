import { isAddress, zeroAddress } from 'viem';
import { z } from 'zod';

const AddressSchema = z.string().refine(
  value => isAddress(value) && value.toLowerCase() !== zeroAddress,
  'Expected a non-zero EVM address',
);

export const ReadinessSchema = z.object({
  ready: z.boolean(),
  code: z.string().trim().min(1).optional(),
  message: z.string().optional(),
  rpcChainId: z.number().int().positive().optional(),
  contractsDeployed: z.boolean().optional(),
  deploymentBindingsVerified: z.boolean().optional(),
  executorAuthorized: z.boolean().optional(),
  executorConfigured: z.boolean().optional(),
  feedFresh: z.boolean().optional(),
  walletFunded: z.boolean().optional(),
  executorFunded: z.boolean().optional(),
  checkedAt: z.iso.datetime().nullable().optional(),
  cacheAgeMs: z.number().int().nonnegative().nullable().optional(),
  cacheTtlMs: z.number().int().nonnegative().optional(),
  source: z.enum(['fresh', 'cache', 'checking', 'error']).optional(),
}).passthrough().superRefine((value, context) => {
  if (value.source === undefined) return;
  if (!value.ready) return;
  if (!['fresh', 'cache'].includes(value.source) || !value.checkedAt
      || value.cacheAgeMs === undefined || value.cacheAgeMs === null
      || value.cacheTtlMs === undefined || value.cacheTtlMs <= 0 || value.cacheTtlMs > 300_000
      || value.cacheAgeMs >= value.cacheTtlMs) {
    context.addIssue({ code: 'custom', message: 'Ready display proof must be complete and within its hard expiry' });
  }
});

export const ConfigResponseSchema = z.object({
  mode: z.enum(['local_chain', 'testnet', 'mock']),
  chainId: z.number().int().positive(),
  walletAddress: AddressSchema,
  ownerAddress: AddressSchema,
  recipientAddress: AddressSchema,
  agentAddress: AddressSchema,
  ccipSenderAddress: AddressSchema.nullable().optional(),
  ccipRouterAddress: AddressSchema.nullable().optional(),
  ccipTokenAddress: AddressSchema.nullable().optional(),
  ccipTokenFeedAddress: AddressSchema.nullable().optional(),
  ccipDestinationChainSelector: z.string().regex(/^[1-9]\d*$/).refine(value => BigInt(value) < 2n ** 64n).nullable().optional(),
  ccipDestinationChainId: z.number().int().positive().nullable().optional(),
  ccipDestinationNetwork: z.string().min(1).max(64).nullable().optional(),
  ccipDestinationTokenAddress: AddressSchema.nullable().optional(),
  ccipTokenPriceSource: z.literal('OWNER_MAINTAINED_TESTNET_VALUE').nullable().optional(),
  capabilities: z.looseObject({ ccip: z.boolean().optional(), subscriptions: z.boolean().optional() }).optional(),
  subscriptionPolicy: z.looseObject({
    configured:z.boolean(),
    maxPeriodCapUsd6:z.string().regex(/^\d+$/).max(78).refine(value=>BigInt(value)<2n**256n),
    maxDurationSeconds:z.string().regex(/^\d+$/).max(20).refine(value=>BigInt(value)<2n**64n),
    maxPayments:z.string().regex(/^\d+$/).max(20).refine(value=>BigInt(value)<2n**64n),
  }).nullable().optional(),
  readiness: ReadinessSchema,
}).passthrough().superRefine((value, context) => {
  const enabled=value.capabilities?.ccip===true;
  const route=[value.ccipSenderAddress,value.ccipRouterAddress,value.ccipTokenAddress,value.ccipTokenFeedAddress,value.ccipDestinationChainSelector];
  if(enabled&&route.some(item=>item===null||item===undefined))context.addIssue({code:'custom',path:['capabilities','ccip'],message:'CCIP capability requires a complete validated route'});
});

const positiveUint = (bits: number) => z.string().max(78).regex(/^[1-9]\d*$/).refine(value => /^[1-9]\d*$/.test(value) && value.length <= 78 && BigInt(value) < 2n ** BigInt(bits), '超出合约整数范围');

/** Explicit UTC seconds and both finite boundaries; never infer a calendar month or mandate. */
export const FiniteSubscriptionFormSchema = z.object({
  recipient: AddressSchema,
  amount: z.string().max(96).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/),
  periodSeconds: positiveUint(64),
  startAt: positiveUint(64),
  endAt: positiveUint(64),
  maxPayments: positiveUint(64),
  periodCap: z.string().max(84).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/),
  purpose: z.string().trim().max(500),
}).strict().superRefine((value, context) => {
  if (/^[1-9]\d*$/.test(value.startAt) && /^[1-9]\d*$/.test(value.endAt) && BigInt(value.endAt) <= BigInt(value.startAt)) context.addIssue({ code: 'custom', path: ['endAt'], message: '结束时间必须晚于开始时间' });
  for (const [field, decimals] of [['amount', 18], ['periodCap', 6]] as const) {
    if (!/^\d+(?:\.\d+)?$/.test(value[field]) || value[field].length > 96) continue;
    const [whole, fraction = ''] = value[field].split('.');
    const base = BigInt(whole + fraction.padEnd(decimals, '0'));
    if (base <= 0n || base >= 2n ** 256n) context.addIssue({ code: 'custom', path: [field], message: '金额必须为合约范围内的正数' });
  }
});

export const ApiObjectSchema = z.record(z.string(), z.unknown());
export const SessionTokenSchema = z.string().max(16_384);

export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;
