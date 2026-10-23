import { expect, test, type Page } from '@playwright/test';
import { encodeFunctionData, parseAbi } from 'viem';
import { authed, balanceOf, config, login, rpc, tasks, token, trackWrites } from './reserve-helpers';

// Real Hardhat + backend + browser. No route fulfillment, mock success, shared IDs,
// ordered parent tests or pre-existing plan/payment is used by any of these four cases.
const walletAbi = parseAbi([
  'function approveAndExecute(uint64 attestationId)',
  'function requestSubscriptionPayment(uint64 subscriptionId,uint64 occurrenceIndex,uint256 maxUsdCost6,uint256 nonce,uint64 deadline,uint64 version,bytes32 planHash)',
  'function nextNonce(address agent) view returns(uint256)', 'function policyVersion() view returns(uint64)',
]);
const amountWei = 100_000_000_000_000n; // 0.0001 ETH, $0.30 under the local $3000 fixture.
async function post(page: Page, path: string, body: object) {
  return page.request.post(`/api/v1${path}`, { headers: { Authorization: `Bearer ${await token(page)}`, 'Idempotency-Key': crypto.randomUUID() }, data: body });
}
async function chainTime(): Promise<number> { return Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp)); }
async function record(page: Page, id: string) { return (await authed(page, '/api/v1/subscriptions')).subscriptions.find((record: any) => record.subscriptionId === id); }
async function refresh(page: Page) { await page.locator('[data-action="refresh"]').first().click(); await expect(page.getByTestId('subscription-preview')).toBeEnabled(); }
async function createPlan(page: Page, overrides: { amount?: string; cap?: string; duration?: number } = {}) {
  await login(page);
  const cfg = await config(page);
  expect(cfg.mode).toBe('local_chain'); expect(cfg.chainId).toBe(31337); expect(cfg.capabilities.subscriptions).toBe(true);
  await page.locator('[data-nav="subscriptions"]').click();
  const start = Math.max(await chainTime(), Math.floor(Date.now() / 1000)) - 1;
  const end = start + (overrides.duration ?? 600);
  const fields = { recipient: cfg.recipientAddress, amount: overrides.amount ?? '0.0001', periodSeconds: '60', startAt: String(start), endAt: String(end), maxPayments: '3', periodCap: overrides.cap ?? '5' };
  for (const [field, value] of Object.entries(fields)) await page.getByTestId(`subscription-${field}`).fill(value);
  const before = await balanceOf(cfg.recipientAddress);
  const previewResponse = page.waitForResponse(r => r.url().endsWith('/subscriptions/preview') && r.request().method() === 'POST');
  await page.getByTestId('subscription-preview').click();
  const preview = await (await previewResponse).json(); expect(preview.status).toBe('READY');
  await expect(page.getByRole('dialog', { name: '确认 Owner 登记有限计划' })).toContainText('不付款');
  expect(await balanceOf(cfg.recipientAddress)).toBe(before);
  const observed = page.waitForResponse(r => r.url().endsWith('/subscriptions/observed') && r.request().method() === 'POST');
  await page.getByTestId('subscription-sign').click();
  const response = await observed; expect(response.ok()).toBe(true);
  const plan = await response.json(); expect(plan.subscriptionId).toBeTruthy();
  await expect(page.getByTestId(`subscription-record-${plan.subscriptionId}`)).toHaveAttribute('data-status', 'ACTIVE');
  expect(await balanceOf(cfg.recipientAddress)).toBe(before); expect((await record(page, plan.subscriptionId)).paidCount).toBe('0');
  return { cfg, plan, start, end };
}
async function previewPayment(page: Page, id: string) {
  const response = page.waitForResponse(r => /\/intents\/[^/]+\/preview$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  await page.getByTestId(`subscription-record-${id}`).getByRole('button', { name: '预览本期付款' }).click();
  const reply = await response; const quote = await reply.json();
  return { reply, quote };
}
async function submit(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith('/submit') && r.request().method() === 'POST');
  await page.getByTestId('confirm-transfer').click();
  const reply = await response; expect(reply.ok()).toBe(true); return reply.json();
}
async function task(page: Page, id: string) { return authed(page, `/api/v1/tasks/${id}`); }
async function closeDrawer(page: Page) { await page.getByRole('button', { name: '关闭详情', exact: true }).click(); }
async function control(page: Page, id: string, action: 'pause' | 'resume' | 'cancel') {
  await page.getByTestId(`subscription-record-${id}`).locator(`[data-action="subscription-${action}"]`).click();
  await expect(page.getByTestId('subscription-sign')).toBeEnabled();
  const observed = page.waitForResponse(r => r.url().endsWith(`/subscriptions/${id}/control-observed`) && r.request().method() === 'POST');
  await page.getByTestId('subscription-sign').click(); const response = await observed; expect(response.ok()).toBe(true);
  await expect(page.getByRole('dialog', { name: /确认.*计划/ })).toHaveCount(0);
  return response.json();
}
async function call(cfg: any, functionName: 'nextNonce' | 'policyVersion') {
  const value = await rpc('eth_call', [{ to: cfg.walletAddress, data: functionName === 'nextNonce' ? encodeFunctionData({ abi: walletAbi, functionName, args: [cfg.agentAddress] }) : encodeFunctionData({ abi: walletAbi, functionName }) }, 'latest']); return BigInt(value);
}
async function directPayMustReject(cfg: any, plan: any, occurrence: string, reason: RegExp) {
  const data = encodeFunctionData({ abi: walletAbi, functionName: 'requestSubscriptionPayment', args: [BigInt(plan.subscriptionId), BigInt(occurrence), 10_000_000n, await call(cfg, 'nextNonce'), BigInt(await chainTime() + 300), await call(cfg, 'policyVersion'), `0x${'a'.repeat(64)}`] });
  await expect(rpc('eth_call', [{ from: cfg.agentAddress, to: cfg.walletAddress, data }, 'latest'])).rejects.toThrow(reason);
}

test('finite subscription: Owner registers, pause/resume, each real payment needs a fresh preview and human confirmation', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const writes = trackWrites(page);
  const { cfg, plan, start } = await createPlan(page);
  const before = await balanceOf(cfg.recipientAddress);
  await control(page, plan.subscriptionId, 'pause');
  await expect(page.getByTestId(`subscription-record-${plan.subscriptionId}`)).toHaveAttribute('data-status', 'PAUSED');
  await directPayMustReject(cfg, plan, '0', /SUBSCRIPTION_PAUSED/);
  await control(page, plan.subscriptionId, 'resume');
  const { quote: first } = await previewPayment(page, plan.subscriptionId);
  expect(first).toMatchObject({ status: 'READY', actionKind: 'SUBSCRIPTION', subscriptionId: plan.subscriptionId, occurrenceIndex: '0' });
  await expect(page.getByTestId('subscription-payment-context')).toContainText(first.planHash);
  expect(await balanceOf(cfg.recipientAddress)).toBe(before);
  expect(writes.filter(write => write.path.endsWith('/submit'))).toHaveLength(0);
  const firstTask = await submit(page);
  await expect.poll(async () => (await task(page, firstTask.taskId)).status).toBe('EXECUTED');
  const evidence = await authed(page, `/api/v1/tasks/${firstTask.taskId}/evidence`);
  expect(evidence.verification).toMatchObject({ chainVerified: true, hashVerified: true });
  expect(evidence.policy).toMatchObject({ event: 'BudgetConsumed', actionType: 'SUBSCRIPTION', verified: true, consumed: true });
  expect(await balanceOf(cfg.recipientAddress) - before).toBe(amountWei);
  await closeDrawer(page);
  await rpc('evm_setNextBlockTimestamp', [start + 61]); await rpc('evm_mine', []); await refresh(page);
  const { quote: second } = await previewPayment(page, plan.subscriptionId);
  expect(second.occurrenceIndex).toBe('1'); expect(second.planHash).not.toBe(first.planHash); expect(second.quoteId).not.toBe(first.quoteId); expect(second.draftId).not.toBe(first.draftId);
  expect(await balanceOf(cfg.recipientAddress) - before).toBe(amountWei);
  const secondTask = await submit(page); expect(secondTask.taskId).not.toBe(firstTask.taskId);
  await expect.poll(async () => (await task(page, secondTask.taskId)).status).toBe('EXECUTED');
  expect(await balanceOf(cfg.recipientAddress) - before).toBe(amountWei * 2n);
  expect((await record(page, plan.subscriptionId)).paidCount).toBe('2');
  const paymentWrites = writes.filter(write => write.path.endsWith('/submit')); expect(paymentWrites).toHaveLength(2);
  expect(paymentWrites[0].body.planHash).toBe(first.planHash); expect(paymentWrites[1].body.planHash).toBe(second.planHash);
  await closeDrawer(page); await page.reload(); await page.locator('[data-nav="subscriptions"]').click();
  await expect(page.getByTestId(`subscription-record-${plan.subscriptionId}`)).toContainText('2 / 3');
  await page.screenshot({ path: testInfo.outputPath('subscriptions-desktop-light.png'), fullPage: true });
  await page.getByTestId('theme-toggle').click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Scroll each bottom field/action into view and assert the real hit target, not
  // merely DOM visibility (a fixed mobile nav can otherwise cover valid controls).
  for (const locator of [page.getByTestId('subscription-periodCap'), page.getByTestId('subscription-preview'), page.getByTestId(`subscription-record-${plan.subscriptionId}`).locator('[data-action="subscription-cancel"]')]) {
    await locator.scrollIntoViewIfNeeded();
    expect(await locator.evaluate(element => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return box.top >= 0 && box.bottom <= innerHeight && (hit === element || element.contains(hit)); })).toBe(true);
  }
  await page.locator('.content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const lastAction = page.getByTestId(`subscription-record-${plan.subscriptionId}`).locator('[data-action="subscription-cancel"]');
  expect(await lastAction.evaluate(element => { const box = element.getBoundingClientRect(); const nav = document.querySelector('.main-nav')!.getBoundingClientRect(); const content = document.querySelector('.content')!.getBoundingClientRect(); return box.top >= content.top && box.bottom <= Math.min(nav.top, content.bottom); })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('subscriptions-mobile-dark.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('period cap rejection: real policy blocks payment without a task, receipt or balance change', async ({ page }) => {
  const { cfg, plan } = await createPlan(page, { cap: '0.1' });
  const before = await balanceOf(cfg.recipientAddress); const taskCount = (await tasks(page)).length;
  const { reply, quote } = await previewPayment(page, plan.subscriptionId);
  if (reply.ok()) { expect(quote.status).toBe('BLOCKED'); expect(quote.reasonCodes).toContain('PERIOD_LIMIT'); await expect(page.getByTestId('confirm-transfer')).toBeDisabled(); }
  else { expect(reply.status()).toBe(422); expect(JSON.stringify(quote)).toMatch(/PERIOD_LIMIT/); }
  await directPayMustReject(cfg, plan, '0', /PERIOD_LIMIT/);
  expect(await balanceOf(cfg.recipientAddress)).toBe(before); expect((await tasks(page)).length).toBe(taskCount); expect((await record(page, plan.subscriptionId)).paidCount).toBe('0');
});

test('expiry: a once-valid preview cannot execute after the exclusive end boundary', async ({ page }) => {
  const { cfg, plan, end } = await createPlan(page, { duration: 120 });
  const before = await balanceOf(cfg.recipientAddress);
  const { quote } = await previewPayment(page, plan.subscriptionId); expect(quote.status).toBe('READY');
  await rpc('evm_setNextBlockTimestamp', [end]); await rpc('evm_mine', []);
  await directPayMustReject(cfg, plan, '0', /SUBSCRIPTION_EXPIRED/);
  const response = await post(page, `/intents/${quote.draftId}/submit`, { expectedRevision: quote.draftVersion, quoteId: quote.quoteId, planHash: quote.planHash });
  if (response.ok()) { const result = await response.json(); await expect.poll(async () => (await task(page, result.taskId)).status).toMatch(/BLOCKED|REQUOTE_REQUIRED|EXPIRED|FAILED/); }
  else expect(response.status()).toBeGreaterThanOrEqual(400);
  await closeDrawer(page); await refresh(page);
  await expect(page.getByTestId(`subscription-record-${plan.subscriptionId}`)).toHaveAttribute('data-status', 'EXPIRED');
  await expect(page.getByTestId(`subscription-record-${plan.subscriptionId}`).getByRole('button', { name: '预览本期付款' })).toBeDisabled();
  expect(await balanceOf(cfg.recipientAddress)).toBe(before); expect((await record(page, plan.subscriptionId)).paidCount).toBe('0');
});

test('cancelled plan: pending Owner approval and worker revalidation cannot execute after on-chain cancellation', async ({ page }) => {
  const { cfg, plan } = await createPlan(page, { amount: '0.002', cap: '10' });
  const before = await balanceOf(cfg.recipientAddress);
  const { quote } = await previewPayment(page, plan.subscriptionId); expect(quote.status).toBe('READY'); expect(quote.decision).toBe('OWNER_APPROVAL');
  const queued = await submit(page);
  await expect.poll(async () => (await task(page, queued.taskId)).status).toBe('AWAITING_APPROVAL');
  const awaiting = await task(page, queued.taskId);
  await closeDrawer(page); await control(page, plan.subscriptionId, 'cancel');
  await expect(page.getByTestId(`subscription-record-${plan.subscriptionId}`)).toHaveAttribute('data-status', 'CANCELLED');
  await directPayMustReject(cfg, plan, '0', /SUBSCRIPTION_CANCELLED/);
  const approvalData = encodeFunctionData({ abi: walletAbi, functionName: 'approveAndExecute', args: [BigInt(awaiting.attestationId)] });
  await expect(rpc('eth_call', [{ from: cfg.ownerAddress, to: cfg.walletAddress, data: approvalData }, 'latest'])).rejects.toThrow(/SUBSCRIPTION_CANCELLED/);
  const owner = await page.request.get(`/api/v1/tasks/${queued.taskId}/owner-tx?action=approve`, { headers: { Authorization: `Bearer ${await token(page)}` } });
  expect(owner.ok()).toBe(false);
  const stale = await post(page, `/intents/${quote.draftId}/submit`, { expectedRevision: quote.draftVersion, quoteId: quote.quoteId, planHash: quote.planHash });
  if (stale.ok()) expect((await stale.json()).taskId).toBe(queued.taskId); // Same frozen task, never a replacement payment.
  await page.waitForTimeout(1500); // Allow multiple actual backend worker ticks, not a mocked timer.
  expect((await task(page, queued.taskId)).status).not.toBe('EXECUTED');
  const evidence = await authed(page, `/api/v1/tasks/${queued.taskId}/evidence`);
  expect(evidence.policy.consumed).toBe(false); expect(evidence.policy.verified).toBe(false);
  expect(await balanceOf(cfg.recipientAddress)).toBe(before); expect((await record(page, plan.subscriptionId)).paidCount).toBe('0');
  await expect(page.getByTestId(`subscription-record-${plan.subscriptionId}`).getByRole('button', { name: '预览本期付款' })).toBeDisabled();
});
