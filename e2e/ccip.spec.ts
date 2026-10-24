import { expect, test, type Page } from '@playwright/test';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { authed, config, login, rpc, tasks, token, trackWrites } from './reserve-helpers';

// Real Hardhat + backend + browser against the opt-in local CCIP fixture (Mock Router,
// local CCIP-BnM, $1 test feed, funded AegisCCIPSender). Nothing is route-fulfilled.
// Local limits: auto $5, per-transaction $10, daily $15. One token is valued at $1, the
// router fee is 0.001 ETH and the backend defaults the fee cap to 110% of the quote.
// The mock router moves tokens immediately, so the recipient's token balance is the
// real local proof of transfer. Destination delivery through Chainlink's API cannot
// exist on a local chain, and these tests assert the UI never claims it.
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const router = parseAbi(['function setFee(uint256 value)', 'function fee() view returns (uint256)']);
const feed = parseAbi(['function updateAnswer(int256 answer)']);
const unit = 10n ** 18n;
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const quantitySchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const ccipConfigSchema = z.looseObject({
  mode: z.literal('local_chain'), chainId: z.literal(31337), ownerAddress: addressSchema,
  recipientAddress: addressSchema, ccipSenderAddress: addressSchema, ccipRouterAddress: addressSchema,
  ccipTokenAddress: addressSchema, ccipTokenFeedAddress: addressSchema,
  ccipDestinationChainSelector: z.string().regex(/^[1-9]\d*$/), capabilities: z.looseObject({ ccip: z.literal(true) }),
});
const quoteSchema = z.looseObject({
  actionKind: z.literal('CCIP_TRANSFER'), quoteId: z.string().min(1), draftId: z.string().min(1),
  status: z.enum(['READY', 'BLOCKED']), costUsd6: z.string(), decision: z.string(),
  destinationChainSelector: z.string(), tokenAddress: addressSchema, quotedFeeWei: z.string(),
  maxFeeWei: z.string(), planHash: hashSchema, reasonCodes: z.array(z.string()).default([]),
});
const submittedTaskSchema = z.looseObject({ taskId: z.string().min(1) });
const taskSchema = z.looseObject({
  taskId: z.string().min(1), status: z.string(), actionKind: z.string().optional(),
  messageId: hashSchema.nullish(), reasonCodes: z.array(z.string()).optional(), lastError: z.unknown().optional(),
  transactions: z.array(z.looseObject({ role: z.string() })).optional(),
});
const evidenceSchema = z.looseObject({
  verification: z.looseObject({ chainVerified: z.boolean(), hashVerified: z.boolean() }),
  policy: z.looseObject({ actionType: z.string(), event: z.string(), decision: z.string(), costUsd6: z.string(), verified: z.boolean(), consumed: z.boolean(), state: z.string(), requestHash: hashSchema }),
  intent: z.looseObject({ actionKind: z.string(), destinationChainSelector: z.string(), planHash: hashSchema, requestHash: hashSchema }),
  configuredPriceSource: z.looseObject({ feedAddress: addressSchema }),
});
const apiErrorSchema = z.looseObject({ error: z.looseObject({ code: z.string() }) });
type Cfg = z.infer<typeof ccipConfigSchema>;

async function tokenBalance(cfg: Cfg, holder: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [holder as `0x${string}`] });
  return BigInt(quantitySchema.parse(await rpc('eth_call', [{ to: cfg.ccipTokenAddress, data }, 'latest'])));
}
async function routerFee(cfg: Cfg): Promise<bigint> {
  return BigInt(quantitySchema.parse(await rpc('eth_call', [{ to: cfg.ccipRouterAddress, data: encodeFunctionData({ abi: router, functionName: 'fee' }) }, 'latest'])));
}
async function setRouterFee(cfg: Cfg, wei: bigint) {
  const hash = hashSchema.parse(await rpc('eth_sendTransaction', [{ from: cfg.ownerAddress, to: cfg.ccipRouterAddress, data: encodeFunctionData({ abi: router, functionName: 'setFee', args: [wei] }) }]));
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await rpc('eth_getTransactionReceipt', [hash])) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Router fee update was not mined');
}
async function setTokenPrice(cfg: Cfg, value: bigint) {
  const hash = hashSchema.parse(await rpc('eth_sendTransaction', [{
    from: cfg.ownerAddress, to: cfg.ccipTokenFeedAddress,
    data: encodeFunctionData({ abi: feed, functionName: 'updateAnswer', args: [value] }),
  }]));
  await expect.poll(async () => {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    return receipt === null ? null : z.looseObject({ status: quantitySchema }).parse(receipt).status;
  }).toBe('0x1');
}
async function openCcip(page: Page): Promise<Cfg> {
  await login(page);
  const cfg = ccipConfigSchema.parse(await config(page));
  expect(cfg.mode).toBe('local_chain'); expect(cfg.chainId).toBe(31337);
  expect(cfg.capabilities.ccip).toBe(true);
  await page.locator('[data-nav="ccip"]').click();
  await expect(page.getByTestId('ccip-form')).toBeVisible();
  return cfg;
}
async function fill(page: Page, recipient: string, amount: string, purpose = 'E2E CCIP') {
  await page.getByTestId('ccip-recipient').fill(recipient);
  await page.getByTestId('ccip-amount').fill(amount);
  await page.getByTestId('ccip-purpose').fill(purpose);
}
async function preview(page: Page) {
  const response = page.waitForResponse(r => /\/intents\/[^/]+\/preview$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  await page.getByTestId('ccip-preview').click();
  return quoteSchema.parse(await (await response).json());
}
async function submit(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith('/submit') && r.request().method() === 'POST');
  await page.getByTestId('confirm-transfer').click();
  const reply = await response; expect(reply.ok()).toBe(true);
  return submittedTaskSchema.parse(await reply.json());
}
async function task(page: Page, id: string) { return taskSchema.parse(await authed(page, `/api/v1/tasks/${id}`)); }
async function evidence(page: Page, id: string) { return evidenceSchema.parse(await authed(page, `/api/v1/tasks/${id}/evidence`)); }
async function authToken(page: Page) { return z.string().min(1).parse(await token(page)); }
async function closeDrawer(page: Page) { await page.getByRole('button', { name: '关闭详情', exact: true }).click(); }

test('CCIP auto transfer: fixed route, real token movement, source evidence, and no premature delivery claim', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const cfg = await openCcip(page);
  const before = await tokenBalance(cfg, cfg.recipientAddress);

  await fill(page, cfg.recipientAddress, '3');
  const quote = await preview(page);
  expect(quote).toMatchObject({ actionKind: 'CCIP_TRANSFER', status: 'READY', costUsd6: '3000000', decision: 'AUTO' });
  expect(quote.destinationChainSelector).toBe(cfg.ccipDestinationChainSelector);
  expect(quote.tokenAddress.toLowerCase()).toBe(cfg.ccipTokenAddress.toLowerCase());
  expect(BigInt(quote.quotedFeeWei)).toBe(10n ** 15n);
  expect(BigInt(quote.maxFeeWei)).toBeGreaterThanOrEqual(BigInt(quote.quotedFeeWei));
  expect(quote.planHash).toMatch(/^0x[0-9a-f]{64}$/);
  const context = page.getByTestId('ccip-payment-context');
  await expect(context).toContainText('固定 CCIP 路线');
  await expect(context).toContainText(quote.planHash);
  await expect(page.getByRole('dialog', { name: '操作详情' })).toContainText('Router 费用上限');
  expect(await tokenBalance(cfg, cfg.recipientAddress)).toBe(before);

  const queued = await submit(page);
  await expect.poll(async () => (await task(page, queued.taskId)).status).toBe('EXECUTED');
  expect(await tokenBalance(cfg, cfg.recipientAddress) - before).toBe(3n * unit);
  const executed = await task(page, queued.taskId);
  expect(executed.actionKind).toBe('CCIP_TRANSFER');
  expect(executed.messageId).toMatch(/^0x[0-9a-f]{64}$/);

  const proof = await evidence(page, queued.taskId);
  expect(proof.verification).toMatchObject({ chainVerified: true, hashVerified: true });
  expect(proof.policy).toMatchObject({ actionType: 'CCIP_TRANSFER', event: 'BudgetConsumed', decision: 'ALLOW', costUsd6: '3000000', verified: true, consumed: true, state: 'VERIFIED' });
  expect(proof.policy.requestHash.toLowerCase()).toBe(proof.intent.requestHash.toLowerCase());
  expect(proof.intent).toMatchObject({ actionKind: 'CCIP_TRANSFER', destinationChainSelector: cfg.ccipDestinationChainSelector, planHash: quote.planHash });
  expect(proof.configuredPriceSource.feedAddress.toLowerCase()).toBe(cfg.ccipTokenFeedAddress.toLowerCase());

  // A local chain has no Chainlink destination record. The API must refuse to verify
  // and the UI must never show the delivered claim just because the source succeeded.
  const delivery = await page.request.get(`/api/v1/tasks/${queued.taskId}/ccip-delivery`, { headers: { Authorization: `Bearer ${await token(page)}` } });
  expect(delivery.status()).toBe(422);
  expect((await delivery.json()).error.code).toBe('CCIP_DESTINATION_CONFIG_REQUIRED');
  const panel = page.getByTestId('ccip-delivery');
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText('目标链到账已核实');
  await expect(page.locator('body')).not.toContainText('目标链到账已核实');
  await closeDrawer(page);
  await page.locator('[data-nav="operations"]').click();
  await expect(page.locator(`[data-task-id="${queued.taskId}"]`)).toContainText('源链已确认 · 等待目标链');
  expect(errors).toEqual([]);
});

test('repeating the same CCIP submit returns one task and cannot move tokens twice', async ({ page }) => {
  const cfg = await openCcip(page);
  const before = await tokenBalance(cfg, cfg.recipientAddress);
  await fill(page, cfg.recipientAddress, '1', 'idempotent CCIP');
  const quote = await preview(page);
  const first = await submit(page);
  await expect.poll(async () => (await task(page, first.taskId)).status).toBe('EXECUTED');
  expect(await tokenBalance(cfg, cfg.recipientAddress) - before).toBe(unit);

  const repeated = await page.request.post(`/api/v1/intents/${quote.draftId}/submit`, {
    headers: { Authorization: `Bearer ${await authToken(page)}`, 'Idempotency-Key': 'repeat-ccip-submit-0001' },
    data: { expectedRevision: 1, quoteId: quote.quoteId },
  });
  expect(repeated.status()).toBe(202);
  expect(submittedTaskSchema.parse(await repeated.json()).taskId).toBe(first.taskId);
  await page.waitForTimeout(500);
  expect(await tokenBalance(cfg, cfg.recipientAddress) - before).toBe(unit);
});

test('CCIP above the auto threshold waits for the Owner, moves nothing until approved, then executes once', async ({ page }) => {
  const cfg = await openCcip(page);
  const before = await tokenBalance(cfg, cfg.recipientAddress);

  await fill(page, cfg.recipientAddress, '8');
  const quote = await preview(page);
  expect(quote).toMatchObject({ actionKind: 'CCIP_TRANSFER', status: 'READY', costUsd6: '8000000', decision: 'OWNER_APPROVAL' });
  const queued = await submit(page);
  await expect.poll(async () => (await task(page, queued.taskId)).status).toBe('AWAITING_APPROVAL');
  expect(await tokenBalance(cfg, cfg.recipientAddress)).toBe(before);
  expect((await task(page, queued.taskId)).messageId).toBeFalsy();

  await expect(page.getByTestId('approve-task')).toBeVisible();
  await page.getByTestId('approve-task').click();
  const review = page.getByRole('dialog', { name: '确认 Owner 批准' });
  await expect(review).toContainText('目标链收款地址');
  await expect(review).toContainText('目标链 Selector');
  await expect(review).toContainText(cfg.ccipDestinationChainSelector);
  await expect(review).toContainText('Router 费用上限');
  await expect(review).toContainText('代币、目标链和费用上限');
  await expect(page.getByTestId('sign-owner-transaction')).toBeEnabled();
  await page.getByTestId('sign-owner-transaction').click();

  await expect.poll(async () => (await task(page, queued.taskId)).status).toBe('EXECUTED');
  expect(await tokenBalance(cfg, cfg.recipientAddress) - before).toBe(8n * unit);
  const approved = await task(page, queued.taskId);
  expect(approved.messageId).toMatch(/^0x[0-9a-f]{64}$/);
  expect((approved.transactions ?? []).map(tx => tx.role)).toEqual(expect.arrayContaining(['request', 'approve']));
  const proof = await evidence(page, queued.taskId);
  expect(proof.policy).toMatchObject({ actionType: 'CCIP_TRANSFER', decision: 'REQUIRE_APPROVAL', verified: true, consumed: true, state: 'VERIFIED' });
});

test('CCIP over the per-transaction limit is blocked at preview and never submitted', async ({ page }) => {
  const cfg = await openCcip(page);
  const writes = trackWrites(page);
  const before = await tokenBalance(cfg, cfg.recipientAddress);
  const taskCount = (await tasks(page)).length;

  await fill(page, cfg.recipientAddress, '12');
  const quote = await preview(page);
  expect(quote.status).toBe('BLOCKED');
  expect(quote.reasonCodes).toContain('PER_TX_LIMIT');
  await expect(page.getByTestId('confirm-transfer')).toBeDisabled();
  expect(writes.some(write => /\/submit$/.test(write.path))).toBe(false);
  expect(await tokenBalance(cfg, cfg.recipientAddress)).toBe(before);
  expect((await tasks(page)).length).toBe(taskCount);
});

test('a router fee increase after preview is rejected instead of silently accepted', async ({ page }) => {
  const cfg = await openCcip(page);
  const originalFee = await routerFee(cfg);
  try {
    const before = await tokenBalance(cfg, cfg.recipientAddress);
    await fill(page, cfg.recipientAddress, '2');
    const quote = await preview(page);
    expect(quote.status).toBe('READY');
    expect(BigInt(quote.maxFeeWei)).toBeLessThan(10n ** 16n);

    await setRouterFee(cfg, 10n ** 16n); // ten times the confirmed fee cap
    const queued = await submit(page);
    await expect.poll(async () => (await task(page, queued.taskId)).status).not.toMatch(/^(SUBMITTING|BROADCAST)$/);
    const result = await task(page, queued.taskId);
    expect(result.status).not.toBe('EXECUTED');
    expect(JSON.stringify(result.reasonCodes) + JSON.stringify(result.lastError ?? {})).toMatch(/CCIP_FEE_EXCEEDS_MAX/);
    expect(await tokenBalance(cfg, cfg.recipientAddress)).toBe(before);
    expect(result.messageId).toBeFalsy();
  } finally {
    await setRouterFee(cfg, originalFee);
  }
});

test('the CCIP form rejects bad input in the browser without calling the backend', async ({ page }) => {
  const cfg = await openCcip(page);
  const writes = trackWrites(page);
  for (const [recipient, amount] of [['not-an-address', '1'], ['0x0000000000000000000000000000000000000000', '1'], [cfg.recipientAddress, '0'], [cfg.recipientAddress, '1.0000000000000000001'], [cfg.recipientAddress, '']] as const) {
    await fill(page, recipient, amount);
    await page.getByTestId('ccip-preview').click();
    await expect(page.locator('body')).toContainText('请填写有效的目标链地址');
  }
  expect(writes.length).toBe(0);
});

test('the API rejects a destination route that is not the verified deployment route', async ({ page }) => {
  const cfg = await openCcip(page);
  const response = await page.request.post('/api/v1/intents', {
    headers: { Authorization: `Bearer ${await authToken(page)}`, 'Idempotency-Key': 'wrong-ccip-route-0001' },
    data: {
      actionKind: 'CCIP_TRANSFER', recipient: cfg.recipientAddress, amountWei: unit.toString(),
      tokenAddress: cfg.ccipTokenAddress,
      destinationChainSelector: (BigInt(cfg.ccipDestinationChainSelector) + 1n).toString(),
      purpose: 'must fail closed',
    },
  });
  expect(response.status()).toBe(422);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe('CCIP_ROUTE_NOT_CONFIGURED');
});

test('an invalid CCIP token price stops preview and creates no payment task', async ({ page }) => {
  const cfg = await openCcip(page);
  const count = (await tasks(page)).length;
  try {
    await setTokenPrice(cfg, 0n);
    await fill(page, cfg.recipientAddress, '1', 'invalid price must fail');
    const previewResponse = page.waitForResponse(response => /\/intents\/[^/]+\/preview$/.test(new URL(response.url()).pathname));
    await page.getByTestId('ccip-preview').click();
    const response = await previewResponse;
    expect(response.status()).toBe(503);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('FEED_UNAVAILABLE');
    expect((await tasks(page)).length).toBe(count);
  } finally {
    await setTokenPrice(cfg, 100_000_000n);
  }
});
