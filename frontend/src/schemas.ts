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
      || value.cacheTtlMs === undefined || value.cacheTtlMs <= 0 || value.cacheTtlMs > 15_000
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
  readiness: ReadinessSchema,
}).passthrough();

export const ApiObjectSchema = z.record(z.string(), z.unknown());
export const SessionTokenSchema = z.string().max(16_384);

export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;
