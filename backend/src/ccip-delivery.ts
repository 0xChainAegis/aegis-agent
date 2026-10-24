import { z } from 'zod';
import { isAddress, type Hex } from 'viem';
import type { CcipDeliveryEvidence, Task } from '@aegis/shared';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().refine((value) => isAddress(value), 'Invalid EVM address');
const network = z.object({
  name: z.string().min(1),
  chainSelector: z.string().regex(/^[1-9]\d*$/),
  chainId: z.string().regex(/^[1-9]\d*$/),
  chainFamily: z.string().min(1),
  environment: z.string().min(1),
}).passthrough();
const tokenAmount = z.object({
  sourceTokenAddress: address,
  destTokenAddress: address,
  amount: z.string().regex(/^[1-9]\d*$/),
}).passthrough();
const message = z.object({
  messageId: hex32,
  sender: address,
  receiver: address,
  status: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  sendTransactionHash: hex32,
  routerAddress: address,
  receiptTransactionHash: hex32.nullable(),
  sourceNetworkInfo: network,
  destNetworkInfo: network,
  tokenAmounts: z.array(tokenAmount),
}).passthrough();
const apiError = z.object({ error: z.string(), message: z.string() }).passthrough();

export type CcipDelivery = {
  state: 'INDEXING' | 'IN_FLIGHT' | 'DELIVERED' | 'FAILED';
  messageId: Hex;
  apiStatus: string | null;
  sourceTransactionHash: Hex;
  destinationTransactionHash: Hex | null;
  sourceChainId: number;
  destinationChainId: number;
  destinationChainSelector: string;
  sourceTokenAddress: Hex;
  destinationTokenAddress: Hex;
  amount: string;
  explorerUrl: string;
};
export type TerminalCcipDelivery = CcipDeliveryEvidence;

export function terminalCcipDelivery(delivery: CcipDelivery, verifiedAt = new Date().toISOString()): TerminalCcipDelivery | null {
  if (delivery.state !== 'DELIVERED' && delivery.state !== 'FAILED') return null;
  return { ...delivery, state: delivery.state, verifiedAt };
}

const same = (first: string, second: string) => first.toLowerCase() === second.toLowerCase();

export async function checkCcipDelivery(
  config: Config,
  task: Pick<Task, 'actionKind' | 'messageId' | 'txHash' | 'recipient' | 'tokenAddress' | 'amountWei' | 'destinationChainSelector' | 'transactions'>,
  fetchImpl: typeof fetch = fetch,
): Promise<CcipDelivery> {
  if (task.actionKind !== 'CCIP_TRANSFER' || !task.messageId) {
    throw new ApiError(409, 'CCIP_SOURCE_EVIDENCE_REQUIRED', '任务还没有可核验的 CCIP 源链证据');
  }
  const messageId = hex32.parse(task.messageId) as Hex;
  if (!config.ccipSenderAddress || !config.ccipRouterAddress || !config.ccipTokenAddress || !config.ccipDestinationChainId || !config.ccipDestinationChainSelector || !config.ccipDestinationTokenAddress) {
    throw new ApiError(422, 'CCIP_DESTINATION_CONFIG_REQUIRED', '部署缺少 CCIP 目标链核验配置');
  }
  const explorerUrl = `https://ccip.chain.link/#/side-drawer/msg/${messageId}`;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.ccip.chain.link/v2/messages/${messageId}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.rpcTimeoutMs),
    });
  } catch {
    throw new ApiError(503, 'CCIP_STATUS_UNAVAILABLE', 'CCIP 状态服务暂不可用');
  }
  if (response.status === 404) return {
    state: 'INDEXING', messageId, apiStatus: null, sourceTransactionHash: task.txHash ?? '0x',
    destinationTransactionHash: null, sourceChainId: config.chainId,
    destinationChainId: config.ccipDestinationChainId,
    destinationChainSelector: config.ccipDestinationChainSelector, explorerUrl,
    sourceTokenAddress: config.ccipTokenAddress, destinationTokenAddress: config.ccipDestinationTokenAddress,
    amount: task.amountWei,
  };
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ApiError(503, 'CCIP_STATUS_UNAVAILABLE', 'CCIP 状态服务返回了无法解析的响应'); }
  if (!response.ok) {
    const parsed = apiError.safeParse(payload);
    throw new ApiError(503, 'CCIP_STATUS_UNAVAILABLE', parsed.success ? parsed.data.message : 'CCIP 状态服务暂不可用');
  }
  const result = message.safeParse(payload);
  if (!result.success) throw new ApiError(503, 'CCIP_STATUS_INVALID', 'CCIP 状态服务返回的数据不符合预期');
  const parsed = result.data;
  const apiSendTxHash = hex32.parse(parsed.sendTransactionHash) as Hex;
  const expectedSelector = task.destinationChainSelector ?? config.ccipDestinationChainSelector;
  const transferred = parsed.tokenAmounts.length === 1 ? parsed.tokenAmounts[0] : undefined;
  if (!same(parsed.messageId, messageId)
    || !same(parsed.sender, config.ccipSenderAddress)
    || !same(parsed.routerAddress, config.ccipRouterAddress)
    || !same(parsed.receiver, task.recipient)
    || parsed.sourceNetworkInfo.chainId !== String(config.chainId)
    || parsed.sourceNetworkInfo.chainSelector !== '16015286601757825753'
    || parsed.destNetworkInfo.chainId !== String(config.ccipDestinationChainId)
    || parsed.destNetworkInfo.chainSelector !== expectedSelector
    || !task.tokenAddress
    || !transferred
    || !same(transferred.sourceTokenAddress, task.tokenAddress)
    || !same(transferred.sourceTokenAddress, config.ccipTokenAddress)
    || !same(transferred.destTokenAddress, config.ccipDestinationTokenAddress)
    || transferred.amount !== task.amountWei) {
    throw new ApiError(409, 'CCIP_DELIVERY_MISMATCH', 'CCIP 状态与已确认的源链任务不一致');
  }
  const recordedSend = task.transactions?.some(tx => same(tx.hash, apiSendTxHash)) || (task.txHash !== undefined && task.txHash !== null && same(task.txHash, apiSendTxHash));
  if (!recordedSend) {
    throw new ApiError(409, 'CCIP_SOURCE_TX_MISMATCH', 'CCIP API 报告的源链交易不在任务已记录的交易中');
  }
  if (parsed.status === 'SUCCESS' && parsed.receiptTransactionHash === null) {
    throw new ApiError(503, 'CCIP_DESTINATION_RECEIPT_MISSING', 'CCIP 报告成功但缺少目标链交易哈希');
  }
  const terminalStates = ['SUCCESS', 'FAILURE', 'FAILED'];
  const state = parsed.status === 'SUCCESS' ? 'DELIVERED' : terminalStates.includes(parsed.status) ? 'FAILED' : 'IN_FLIGHT';
  return {
    state, messageId, apiStatus: parsed.status, sourceTransactionHash: apiSendTxHash,
    destinationTransactionHash: parsed.receiptTransactionHash as Hex | null,
    sourceChainId: Number(parsed.sourceNetworkInfo.chainId),
    destinationChainId: Number(parsed.destNetworkInfo.chainId),
    destinationChainSelector: parsed.destNetworkInfo.chainSelector,
    sourceTokenAddress: transferred.sourceTokenAddress as Hex,
    destinationTokenAddress: transferred.destTokenAddress as Hex,
    amount: transferred.amount,
    explorerUrl,
  };
}
