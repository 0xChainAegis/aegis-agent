import { decodeFunctionData, parseAbi } from 'viem';
import { z } from 'zod';

const uint = z.string().max(78).regex(/^(?:0|[1-9]\d*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const subscriptionFieldsSchema = z.looseObject({
  recipient: address, amountWei: uint, periodSeconds: uint, startAtSeconds: uint,
  endAtSeconds: uint, maxPayments: uint, periodCapUsd6: uint,
});
export const subscriptionRecordSchema = subscriptionFieldsSchema.extend({
  subscriptionId: uint, parentPlanHash: hash, paidCount: uint, paused: z.boolean(), cancelled: z.boolean(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'NOT_STARTED']),
  currentOccurrenceIndex: uint.nullable(),
});
export const subscriptionListSchema = z.looseObject({ subscriptions: z.array(subscriptionRecordSchema) });
const transactionSchema = z.looseObject({ from: address, to: address, chainId: z.literal(31337), data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/), value: z.literal('0') });
export const subscriptionPreviewSchema = z.looseObject({ registrationId: z.string().min(1), planHash: hash, status: z.literal('READY'), subscription: subscriptionFieldsSchema, transaction: transactionSchema, quoteExpiresAtSeconds: z.union([uint, z.number().int().positive()]) });
export const subscriptionControlPreviewSchema = z.looseObject({ controlId: z.string().min(1), subscriptionId: uint, action: z.enum(['pause', 'resume', 'cancel']), transaction: transactionSchema });
const abi = parseAbi([
  'function createFiniteSubscription(address agent,address to,uint256 amountWei,uint64 periodSeconds,uint64 startAt,uint64 endAt,uint64 maxPayments,uint256 periodCapUsd6,bytes32 parentPlanHash)',
  'function pauseFiniteSubscription(uint64 subscriptionId,bool paused)',
  'function cancelFiniteSubscription(uint64 subscriptionId)',
]);
const configSchema = z.looseObject({ mode: z.literal('local_chain'), chainId: z.literal(31337), walletAddress: address, ownerAddress: address, agentAddress: address, capabilities: z.looseObject({ subscriptions: z.literal(true) }) });
type Data = Record<string, unknown>;

/** Validate every signed byte against the user's reviewed plan, not API assertions. */
export function validateSubscriptionTransaction(configInput: unknown, previewInput: unknown, expected: Data, action: 'create' | 'pause' | 'resume' | 'cancel'): Data {
  const config = configSchema.parse(configInput);
  const preview = action === 'create' ? subscriptionPreviewSchema.parse(previewInput) : subscriptionControlPreviewSchema.parse(previewInput);
  const tx = preview.transaction;
  const equal = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  if (!equal(tx.from, config.ownerAddress) || !equal(tx.to, config.walletAddress)) throw new Error('订阅交易账户或目标合约与当前资金池不一致。');
  const decoded = decodeFunctionData({ abi, data: tx.data as `0x${string}` });
  if (action === 'create') {
    const registration = subscriptionPreviewSchema.parse(preview);
    const fields = subscriptionFieldsSchema.parse(expected);
    for (const key of Object.keys(fields)) if (!equal(registration.subscription[key], fields[key])) throw new Error('订阅预览与填写的有限计划不一致。');
    const args = [config.agentAddress, fields.recipient, fields.amountWei, fields.periodSeconds, fields.startAtSeconds, fields.endAtSeconds, fields.maxPayments, fields.periodCapUsd6, registration.planHash];
    if (decoded.functionName !== 'createFiniteSubscription' || decoded.args.length !== args.length || !args.every((arg, index) => equal(arg, decoded.args[index]))) throw new Error('订阅登记 calldata 与已确认计划不一致。');
    if (/^0x0{64}$/i.test(registration.planHash)) throw new Error('订阅父计划哈希无效。');
  } else {
    const control = subscriptionControlPreviewSchema.parse(preview);
    const method = action === 'cancel' ? 'cancelFiniteSubscription' : 'pauseFiniteSubscription';
    if (control.action !== action || control.subscriptionId !== expected.subscriptionId || decoded.functionName !== method || !equal(decoded.args[0], expected.subscriptionId) || (action !== 'cancel' && decoded.args[1] !== (action === 'pause'))) throw new Error('订阅控制方法或计划 ID 不一致。');
  }
  return tx;
}
