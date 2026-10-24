import { resolve } from 'node:path';
import { z } from 'zod';
import type { Hex } from 'viem';
import { loadConfig } from './config.js';
import { ViemGateway } from './chain.js';
import { AegisService } from './service.js';
import { Store } from './store.js';
import { ApiError, errorMessage } from './errors.js';
import { checkCcipDelivery } from './ccip-delivery.js';

const hex32 = z.custom<Hex>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), 'Expected a 32-byte hex value');
const inputSchema = z.object({
  amountWei: z.string().regex(/^[1-9]\d*$/).refine(value => BigInt(value) < 2n ** 256n),
  sourceTimeoutMs: z.coerce.number().int().min(30_000).max(600_000),
  deliveryTimeoutMs: z.coerce.number().int().min(60_000).max(1_800_000),
  resumeMessageId: hex32.optional(),
  resumeSourceTransactionHash: hex32.optional(),
}).strict().superRefine((value, context) => {
  if ((value.resumeMessageId === undefined) !== (value.resumeSourceTransactionHash === undefined)) {
    context.addIssue({ code: 'custom', message: 'Both CCIP resume values are required together', path: ['resumeMessageId'] });
  }
});

const sleep = (milliseconds: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, milliseconds));

try {
  const input = inputSchema.parse({
    amountWei: process.env.AEGIS_CCIP_SMOKE_AMOUNT_WEI ?? '1000000000000',
    sourceTimeoutMs: process.env.AEGIS_CCIP_SOURCE_TIMEOUT_MS ?? '240000',
    deliveryTimeoutMs: process.env.AEGIS_CCIP_DELIVERY_TIMEOUT_MS ?? '1200000',
    resumeMessageId: process.env.AEGIS_CCIP_RESUME_MESSAGE_ID,
    resumeSourceTransactionHash: process.env.AEGIS_CCIP_RESUME_SOURCE_TX,
  });
  const config = loadConfig({
    ...process.env,
    AEGIS_MODE: 'testnet',
    AEGIS_CHAIN_ID: '11155111',
    AEGIS_DEPLOYMENT_FILE: process.env.AEGIS_DEPLOYMENT_FILE ?? resolve('..', 'contracts/deployments/sepolia.json'),
    AEGIS_RPC_URL: process.env.AEGIS_RPC_URL ?? process.env.RPC_URL,
    AEGIS_LLM_MODE: 'off',
  });
  if (!config.ccipSenderAddress || !config.ccipTokenAddress || !config.ccipDestinationChainSelector) {
    throw new Error('Sepolia deployment does not expose a complete CCIP route');
  }
  const store = new Store(':memory:');
  try {
    let taskId = 'resume';
    let messageId = input.resumeMessageId;
    let sourceTransactionHash = input.resumeSourceTransactionHash;
    if (!messageId || !sourceTransactionHash) {
      const service = new AegisService(config, store, new ViemGateway(config), null);
      const intent = await service.createIntent(config.ownerAddress, {
        actionKind: 'CCIP_TRANSFER', recipient: config.recipientAddress,
        tokenAddress: config.ccipTokenAddress, amountWei: input.amountWei,
        destinationChainSelector: config.ccipDestinationChainSelector,
        purpose: 'Aegis Sepolia to Base Sepolia CCIP smoke test',
      });
      const quote = await service.preview(config.ownerAddress, intent.draftId, intent.revision);
      if (quote.status !== 'READY' || !quote.planHash) throw new Error(`CCIP preview blocked: ${quote.reasonCodes.join(',')}`);
      const submitted = service.submit(config.ownerAddress, intent.draftId, intent.revision, quote.quoteId, quote.planHash);
      taskId = submitted.taskId;
      console.log(JSON.stringify({ phase: 'SOURCE_SUBMITTED', taskId, amountWei: input.amountWei, quotedFeeWei: quote.quotedFeeWei, maxFeeWei: quote.maxFeeWei }));

      const sourceDeadline = Date.now() + input.sourceTimeoutMs;
      let task = service.getTask(config.ownerAddress, submitted.taskId);
      while (Date.now() < sourceDeadline) {
        await service.tick();
        task = service.getTask(config.ownerAddress, submitted.taskId);
        if (task.status === 'EXECUTED') break;
        if (['FAILED', 'BLOCKED', 'REQUOTE_REQUIRED', 'CANCELLED', 'EXPIRED', 'AWAITING_APPROVAL'].includes(task.status)) {
          throw new Error(`CCIP source task stopped in ${task.status}: ${task.reasonCodes.join(',')}`);
        }
        await sleep(5_000);
      }
      if (task.status !== 'EXECUTED' || !task.messageId || !task.txHash) throw new Error('Timed out waiting for verified CCIP source execution');
      messageId = task.messageId;
      sourceTransactionHash = task.txHash;
      console.log(JSON.stringify({ phase: 'SOURCE_EXECUTED', taskId, sourceTransactionHash, messageId }));
    } else {
      console.log(JSON.stringify({ phase: 'SOURCE_RESUMED', sourceTransactionHash, messageId }));
    }

    const deliveryDeadline = Date.now() + input.deliveryTimeoutMs;
    let previousState = '';
    while (Date.now() < deliveryDeadline) {
      let delivery;
      try {
        delivery = await checkCcipDelivery(config, {
          actionKind: 'CCIP_TRANSFER', messageId, txHash: sourceTransactionHash,
          recipient: config.recipientAddress, tokenAddress: config.ccipTokenAddress,
          amountWei: input.amountWei, destinationChainSelector: config.ccipDestinationChainSelector,
          transactions: [{ role: 'request', hash: sourceTransactionHash, finality: 'mined' }],
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'CCIP_STATUS_UNAVAILABLE') {
          console.log(JSON.stringify({ phase: 'DESTINATION_STATUS_RETRY', code: error.code }));
          await sleep(20_000);
          continue;
        }
        throw error;
      }
      if (delivery.state !== previousState) {
        previousState = delivery.state;
        console.log(JSON.stringify({ phase: 'DESTINATION_STATUS', ...delivery }));
      }
      if (delivery.state === 'DELIVERED') {
        console.log(JSON.stringify({ ok: true, taskId, messageId, sourceTransactionHash, destinationTransactionHash: delivery.destinationTransactionHash, explorerUrl: delivery.explorerUrl }, null, 2));
        break;
      }
      if (delivery.state === 'FAILED') throw new Error(`CCIP delivery failed with API status ${delivery.apiStatus ?? 'UNKNOWN'}`);
      await sleep(15_000);
    }
    if (previousState !== 'DELIVERED') throw new Error('Timed out waiting for Base Sepolia delivery');
  } finally {
    store.close();
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2));
  process.exitCode = 1;
}
