import { decodeFunctionData, isAddress, parseAbi, parseUnits, zeroAddress } from 'viem';
import { z } from 'zod';

const address = z.string().refine(value => isAddress(value), '无效 EVM 地址');
const nonZeroAddress = address.refine(value => value.toLowerCase() !== zeroAddress, '地址不能是零地址');
const uint = z.string().max(78).regex(/^(?:0|[1-9]\d*)$/).refine(value => BigInt(value) < 2n ** 256n);
const positiveUint = uint.refine(value => BigInt(value) > 0n);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const ccipRouteSchema = z.looseObject({
  chainId: z.number().int().positive(),
  ownerAddress: address,
  ccipSenderAddress: address,
  ccipTokenAddress: address,
  ccipDestinationChainSelector: positiveUint,
  ccipDestinationChainId: z.number().int().positive().nullable().optional(),
  ccipDestinationNetwork: z.string().min(1).max(64).nullable().optional(),
  ccipDestinationTokenAddress: address.nullable().optional(),
  ccipTokenPriceSource: z.literal('OWNER_MAINTAINED_TESTNET_VALUE').nullable().optional(),
  capabilities: z.looseObject({ ccip: z.literal(true) }),
});
const ownerConfigSchema=z.looseObject({chainId:z.number().int().positive(),ownerAddress:address,walletAddress:address});

export const ccipFormSchema = z.object({
  recipient: nonZeroAddress,
  amount: z.string().max(96).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/),
  purpose: z.string().trim().max(500),
}).strict().transform(value => ({
  ...value,
  amountWei: parseUnits(value.amount, 18).toString(),
})).refine(value => BigInt(value.amountWei) > 0n && BigInt(value.amountWei) < 2n ** 256n, { path: ['amount'], message: '数量必须为正数' });

export const ccipIntentBindingSchema = z.looseObject({
  actionKind: z.literal('CCIP_TRANSFER'), draftId: z.string().min(1), revision: z.number().int().positive(),
  recipient: address, amountWei: positiveUint, tokenAddress: address,
  ccipSenderAddress: address, destinationChainSelector: positiveUint,
});

export const ccipQuoteBindingSchema = z.looseObject({
  actionKind: z.literal('CCIP_TRANSFER'), quoteId: z.string().min(1), draftId: z.string().min(1),
  draftVersion: z.number().int().positive(), status: z.enum(['READY', 'BLOCKED']),
  walletAddress: address, recipient: address, amountWei: positiveUint,
  tokenAddress: address, ccipSenderAddress: address, destinationChainSelector: positiveUint,
  maxUsdCost6: positiveUint, maxFeeWei: positiveUint, quotedFeeWei: positiveUint,
  planHash: hash,
});

export const ccipTaskBindingSchema = z.looseObject({
  actionKind: z.literal('CCIP_TRANSFER'), taskId: z.string().min(1), chainId: z.number().int().positive(),
  walletAddress: address, recipient: address, amountWei: positiveUint, tokenAddress: address,
  ccipSenderAddress: address, destinationChainSelector: positiveUint, maxUsdCost6: positiveUint,
  maxFeeWei: positiveUint, quotedFeeWei: positiveUint, planHash: hash,
});

export const ccipDeliverySchema = z.looseObject({
  state: z.enum(['INDEXING', 'IN_FLIGHT', 'DELIVERED', 'FAILED']),
  messageId: hash, apiStatus: z.string().nullable(), sourceTransactionHash: hash,
  destinationTransactionHash: hash.nullable(), sourceChainId: z.number().int().positive(),
  destinationChainId: z.number().int().positive(), destinationChainSelector: positiveUint,
  sourceTokenAddress: address, destinationTokenAddress: address, amount: positiveUint,
  explorerUrl: z.url().refine(value => value.startsWith('https://ccip.chain.link/')),
}).superRefine((value, context) => {
  if (value.state === 'DELIVERED' && value.destinationTransactionHash === null) context.addIssue({ code: 'custom', path: ['destinationTransactionHash'], message: '已送达状态必须有目标链交易' });
});

const ownerAbi = parseAbi(['function approveAndExecute(uint64 attestationId)', 'function cancelPending(uint64 attestationId)']);
const ownerTransactionSchema = z.looseObject({
  from: address, to: address, data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/), value: z.literal('0'),
  chainId: z.number().int().positive(), action: z.enum(['approve', 'cancel']), chainBindingVerified: z.literal(true),
  taskId: z.string().min(1), requestHash: hash, attestationId: positiveUint, recipient: address,
  amountWei: positiveUint, tokenAddress: address.optional(), destinationChainSelector: positiveUint.optional(),
  maxUsdCost6: positiveUint, maxFeeWei: positiveUint.optional(),
});

type RecordData = Record<string, unknown>;
const same = (first: unknown, second: unknown) => String(first).toLowerCase() === String(second).toLowerCase();

/** Browser-side final check before asking the Owner wallet to sign. */
export function validateOwnerTransaction(configInput: unknown, taskInput: unknown, transactionInput: unknown, action: 'approve' | 'cancel'): RecordData {
  const config = ownerConfigSchema.parse(configInput);
  const task = z.looseObject({
    actionKind: z.enum(['NATIVE_TRANSFER', 'SUBSCRIPTION', 'CCIP_TRANSFER']).optional(),
    taskId: z.string().min(1), chainId: z.number().int().positive(), walletAddress: address,
    requestHash: hash, attestationId: positiveUint, recipient: address, amountWei: positiveUint,
    maxUsdCost6: positiveUint, tokenAddress: address.optional(), destinationChainSelector: positiveUint.optional(),
    maxFeeWei: positiveUint.optional(),
  }).parse(taskInput);
  const tx = ownerTransactionSchema.parse(transactionInput);
  const ccip = task.actionKind === 'CCIP_TRANSFER';
  const ccipRoute=ccip?ccipRouteSchema.parse(configInput):null;
  const expectedTarget = ccipRoute?.ccipSenderAddress??config.walletAddress;
  if (!same(tx.from, config.ownerAddress) || !same(tx.to, expectedTarget) || tx.chainId !== config.chainId || tx.action !== action) throw new Error('审批交易账户、网络或目标合约不匹配。');
  if(!ccip&&!same(task.walletAddress,config.walletAddress))throw new Error('审批任务不属于当前资金池合约。');
  if (tx.taskId !== task.taskId || !same(tx.requestHash, task.requestHash) || tx.attestationId !== task.attestationId || !same(tx.recipient, task.recipient) || tx.amountWei !== task.amountWei || tx.maxUsdCost6 !== task.maxUsdCost6) throw new Error('审批交易与显示任务不一致。');
  if (ccip && (!ccipRoute||!task.tokenAddress || !task.destinationChainSelector || !task.maxFeeWei || !same(task.walletAddress, ccipRoute.ccipSenderAddress) || !same(tx.tokenAddress, task.tokenAddress) || tx.destinationChainSelector !== task.destinationChainSelector || tx.maxFeeWei !== task.maxFeeWei)) throw new Error('跨链审批缺少或改变了代币、目标链或费用上限。');
  const decoded = decodeFunctionData({ abi: ownerAbi, data: tx.data as `0x${string}` });
  const expectedMethod = action === 'approve' ? 'approveAndExecute' : 'cancelPending';
  if (decoded.functionName !== expectedMethod || String(decoded.args[0]) !== task.attestationId) throw new Error('审批方法或待审批记录 ID 不匹配。');
  return tx;
}
