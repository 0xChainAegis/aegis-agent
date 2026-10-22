import { z } from 'zod';
import type { Config } from './config.js';
import type { Gateway } from './chain.js';

const readinessSchema = z.object({
  ready: z.boolean(),
  code: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
}).passthrough();

const snapshotSchema = z.object({
  chainId: z.number().int().positive(),
  walletBalanceWei: z.string().regex(/^\d+$/),
  agentBalanceWei: z.string().regex(/^\d+$/),
  recipientBalanceWei: z.string().regex(/^\d+$/),
  policyVersion: z.string().regex(/^\d+$/),
  observedBlockNumber: z.string().regex(/^\d+$/),
  observedBlockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  observedAt: z.string().datetime(),
  dataSource: z.literal('chain'),
}).passthrough();

export const sepoliaCheckReportSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string().datetime(),
  chainId: z.literal(11155111),
  readiness: readinessSchema,
  snapshot: snapshotSchema.optional(),
}).strict();
export type SepoliaCheckReport = z.infer<typeof sepoliaCheckReportSchema>;

export async function runSepoliaCheck(config: Config, gateway: Gateway): Promise<SepoliaCheckReport> {
  if (config.mode !== 'testnet' || config.chainId !== 11155111) {
    throw new Error('check:sepolia requires AEGIS_MODE=testnet and chainId 11155111');
  }
  // A dedicated gateway instance has no public display cache, so this is a
  // fresh authoritative sweep without coupling the CLI to HTTP cache policy.
  const readiness = readinessSchema.parse(await gateway.readiness());
  const snapshot = readiness.ready ? snapshotSchema.parse(await gateway.snapshot()) : undefined;
  return sepoliaCheckReportSchema.parse({
    ok: readiness.ready && snapshot?.chainId === 11155111,
    checkedAt: new Date().toISOString(),
    chainId: 11155111,
    readiness,
    ...(snapshot ? { snapshot } : {}),
  });
}
