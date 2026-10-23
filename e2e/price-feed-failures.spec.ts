import { test, expect, type Page } from '@playwright/test';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { z } from 'zod';

const rpcUrl = 'http://127.0.0.1:8545';
const feedAbi = parseAbi([
  'function updateAnswer(int256 answer)',
  'function updateRoundData(uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
]);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const quantitySchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const rpcEnvelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
}).superRefine((value, context) => {
  if ((value.result === undefined) === (value.error === undefined)) {
    context.addIssue({ code: 'custom', message: 'JSON-RPC response must contain exactly one result or error' });
  }
});
const configSchema = z.object({
  mode: z.literal('local_chain'),
  chainId: z.literal(31337),
  feedAddress: addressSchema,
  ownerAddress: addressSchema,
  recipientAddress: addressSchema,
  readiness: z.object({
    ready: z.boolean(),
    code: z.string().optional(),
    rpcChainId: z.number().optional(),
    contractsDeployed: z.boolean().optional(),
    deploymentBindingsVerified: z.boolean().optional(),
    feedFresh: z.boolean().optional(),
  }),
});

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`JSON-RPC HTTP ${response.status}`);
  const envelope = rpcEnvelopeSchema.parse(await response.json());
  if (envelope.error) throw new Error(envelope.error.message);
  return envelope.result;
}

async function sendFeedTransaction(from: Address, to: Address, data: Hex): Promise<Hex> {
  const hash = hashSchema.parse(await rpc('eth_sendTransaction', [{ from, to, data }])) as Hex;
  await expect.poll(async () => {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt === null) return null;
    return z.object({ status: quantitySchema }).parse(receipt).status;
  }).toBe('0x1');
  return hash;
}

async function currentTimestamp(): Promise<bigint> {
  const block = z.object({ timestamp: quantitySchema }).parse(await rpc('eth_getBlockByNumber', ['latest', false]));
  return BigInt(block.timestamp);
}

async function balance(address: Address): Promise<bigint> {
  return BigInt(quantitySchema.parse(await rpc('eth_getBalance', [address, 'latest'])));
}

async function readConfig(page: Page) {
  const response = await page.request.get('/api/v1/config');
  expect(response.ok()).toBe(true);
  return configSchema.parse(await response.json());
}

async function login(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('local-wallet')).toBeEnabled();
  await page.getByTestId('local-wallet').click();
  await page.getByTestId('confirm-local-wallet').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
}

async function refreshAndRead(page: Page) {
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/v1/config'));
  await page.locator('[data-action="refresh"]').first().click();
  const response = await responsePromise;
  return configSchema.parse(await response.json());
}

test('real local feed failures keep read-only access and stop every payment path', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await login(page);
  const initial = await readConfig(page);
  expect(initial.readiness.ready).toBe(true);

  const feedAddress = initial.feedAddress as Address;
  const ownerAddress = initial.ownerAddress as Address;
  const recipientAddress = initial.recipientAddress as Address;
  const recipientBalanceBefore = await balance(recipientAddress);
  let roundId = BigInt(Date.now());
  const normalAnswer = 300_000_000_000n;
  const cases: Array<{
    name: string;
    expectedCode: 'FEED_STALE' | 'FEED_UNAVAILABLE';
    expectedTitle: string;
    data(now: bigint, round: bigint): Hex;
  }> = [
    {
      name: 'zero answer', expectedCode: 'FEED_UNAVAILABLE', expectedTitle: 'Chainlink 价格源不可用',
      data: () => encodeFunctionData({ abi: feedAbi, functionName: 'updateAnswer', args: [0n] }),
    },
    {
      name: 'negative answer', expectedCode: 'FEED_UNAVAILABLE', expectedTitle: 'Chainlink 价格源不可用',
      data: () => encodeFunctionData({ abi: feedAbi, functionName: 'updateAnswer', args: [-1n] }),
    },
    {
      name: 'future timestamp', expectedCode: 'FEED_UNAVAILABLE', expectedTitle: 'Chainlink 价格源不可用',
      data: (now, round) => encodeFunctionData({
        abi: feedAbi, functionName: 'updateRoundData', args: [round, normalAnswer, now + 3_600n, now + 3_600n, round],
      }),
    },
    {
      name: 'stale timestamp', expectedCode: 'FEED_STALE', expectedTitle: 'Chainlink 报价待更新',
      data: (now, round) => encodeFunctionData({
        abi: feedAbi, functionName: 'updateRoundData', args: [round, normalAnswer, now - 3_601n, now - 3_601n, round],
      }),
    },
  ];

  try {
    for (const scenario of cases) {
      const now = await currentTimestamp();
      roundId += 1n;
      await sendFeedTransaction(ownerAddress, feedAddress, scenario.data(now, roundId));

      const failed = await refreshAndRead(page);
      expect(failed.readiness.ready, scenario.name).toBe(false);
      expect(failed.readiness.code, scenario.name).toBe(scenario.expectedCode);
      expect(failed.readiness.rpcChainId, scenario.name).toBe(31337);
      expect(failed.readiness.contractsDeployed, scenario.name).toBe(true);
      expect(failed.readiness.deploymentBindingsVerified, scenario.name).toBe(true);
      expect(failed.readiness.feedFresh, scenario.name).toBe(false);
      await expect(page.getByTestId('service-banner').getByText(scenario.expectedTitle, { exact: true })).toBeVisible();
      await expect(page.getByTestId('intent-message')).toBeDisabled();
      await expect(page.getByTestId('send-intent')).toBeDisabled();
      await expect(page.getByTestId('connect-wallet')).not.toContainText('连接钱包');
      expect(await balance(recipientAddress), scenario.name).toBe(recipientBalanceBefore);

      await sendFeedTransaction(ownerAddress, feedAddress, encodeFunctionData({
        abi: feedAbi, functionName: 'updateAnswer', args: [normalAnswer],
      }));
      const restored = await refreshAndRead(page);
      expect(restored.readiness.ready, `${scenario.name} recovery`).toBe(true);
      await expect(page.getByTestId('service-banner')).toHaveCount(0);
      await expect(page.getByTestId('intent-message')).toBeEnabled();
    }
  } finally {
    await sendFeedTransaction(ownerAddress, feedAddress, encodeFunctionData({
      abi: feedAbi, functionName: 'updateAnswer', args: [normalAnswer],
    }));
  }

  expect(await balance(recipientAddress)).toBe(recipientBalanceBefore);
  expect(pageErrors).toEqual([]);
});
