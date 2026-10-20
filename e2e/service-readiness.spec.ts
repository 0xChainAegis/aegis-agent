import { test, expect, type Page } from '@playwright/test';

// Rendering and fail-closed UI fixtures only. All API traffic is intercepted;
// these tests do not log into the backend or send any chain transaction.
const owner = '0x1111111111111111111111111111111111111111';
const wallet = '0x2222222222222222222222222222222222222222';
const recipient = '0x3333333333333333333333333333333333333333';
const agent = '0x4444444444444444444444444444444444444444';
const verified = { rpcChainId: 31337, contractsDeployed: true, deploymentBindingsVerified: true };
const ready = { ...verified, ready: true, feedFresh: true };
type Readiness = Record<string, unknown>;

async function fixture(page: Page, readiness: Readiness, signedIn = false) {
  let current = readiness;
  const writes: string[] = [];
  if (signedIn) await page.addInitScript(({ owner }) => {
    sessionStorage.setItem('aegis.session', 'readiness-render-fixture');
    sessionStorage.setItem('aegis.address', owner);
    sessionStorage.setItem('aegis.wallet-kind', 'local');
  }, { owner });
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      writes.push(path);
      await route.fulfill({ status: 503, json: { error: { code: 'FIXTURE_NO_WRITES', message: 'Fixture does not accept writes' } } });
      return;
    }
    if (path.endsWith('/config')) {
      await route.fulfill({ json: { mode: 'local_chain', chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', walletAddress: wallet, ownerAddress: owner, recipientAddress: recipient, agentAddress: agent, readiness: current } });
    } else if (path.endsWith('/wallets/current')) {
      await route.fulfill({ json: { chainId: 31337, walletAddress: wallet, ownerAddress: owner, recipientAddress: recipient, walletBalanceWei: '1000000000000000000', agentBalanceWei: '1000000000000000000', recipientBalanceWei: '1000000000000000', observedBlockNumber: '42', observedBlockHash: '0x' + 'ab'.repeat(32), observedAt: new Date().toISOString(), dataSource: 'chain' } });
    } else if (path.endsWith('/tasks')) await route.fulfill({ json: { tasks: [] } });
    else await route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await expect(page.locator('.topbar-status')).not.toContainText('API 离线');
  return { writes, setReadiness(value: Readiness) { current = value; } };
}

async function lowReserve(page: Page) {
  await page.getByTestId('reserve-threshold').fill('0.05');
  await page.getByTestId('reserve-target').fill('0.1');
  await expect(page.getByTestId('reserve-suggestion')).toHaveText('0.099 ETH');
}

test('expired price preserves verified read-only balances and blocks preparation and payment', async ({ page }) => {
  const { writes } = await fixture(page, { ...verified, ready: false, code: 'FEED_STALE', feedFresh: false }, true);
  await expect(page.locator('.service-banner')).toContainText('价格已过期，已暂停付款');
  await expect(page.getByTestId('reserve-balance')).toHaveText('0.001 ETH');
  await lowReserve(page);
  await expect(page.getByTestId('reserve-prepare')).toBeDisabled();
  await expect(page.getByTestId('send-intent')).toBeDisabled();
  await expect(page.getByTestId('intent-message')).toBeDisabled();
  // The action guard must also stop a forced DOM click.
  for (const name of ['reserve-prepare', 'send-intent']) {
    await page.getByTestId(name).evaluate(element => { (element as HTMLButtonElement).disabled = false; (element as HTMLButtonElement).click(); });
  }
  expect(writes).toEqual([]);
});

test('funding requirement has an actionable message and permits read-only connection', async ({ page }) => {
  const { writes } = await fixture(page, { ...verified, ready: false, code: 'FUNDING_REQUIRED', walletFunded: false }, true);
  await expect(page.locator('.service-banner')).toContainText('补给资金池或执行账户余额不足');
  await expect(page.getByTestId('connect-wallet')).toBeEnabled();
  await expect(page.getByTestId('reserve-balance')).toHaveText('0.001 ETH');
  await lowReserve(page);
  await expect(page.getByTestId('reserve-prepare')).toBeDisabled();
  await expect(page.getByTestId('send-intent')).toBeDisabled();
  expect(writes).toEqual([]);
});

for (const [name, readiness, message] of [
  ['unknown', { ready: false, code: 'FUTURE_UNKNOWN_FAILURE' }, '服务尚未确认链上就绪状态'],
  ['RPC unavailable', { ready: false, code: 'CHAIN_UNAVAILABLE' }, '无法连接链上节点'],
  ['mismatched network', { ...verified, rpcChainId: 1, ready: true }, '网络与服务配置不一致'],
  ['stale without identity proofs', { ready: false, code: 'FEED_STALE' }, '价格已过期'],
] as [string, Readiness, string][]) {
  test(name + ' cannot enable connection or payment', async ({ page }) => {
    const { writes } = await fixture(page, readiness);
    await expect(page.locator('.service-banner')).toContainText(message);
    await expect(page.getByTestId('connect-wallet')).toBeDisabled();
    await expect(page.getByTestId('local-wallet')).toBeDisabled();
    expect(writes).toEqual([]);
  });
}

test('retry reads recovered readiness, clears the banner, and enables connection', async ({ page }) => {
  const state = await fixture(page, { ready: false });
  await expect(page.getByTestId('connect-wallet')).toBeDisabled();
  state.setReadiness(ready);
  await page.locator('.service-banner [data-action="refresh"]').click();
  await expect(page.locator('.service-banner')).toHaveCount(0);
  await expect(page.getByTestId('connect-wallet')).toBeEnabled();
  await expect(page.getByTestId('local-wallet')).toBeEnabled();
  expect(state.writes).toEqual([]);
});

test('a ready session detects deterioration on refresh and immediately disables payment', async ({ page }) => {
  const state = await fixture(page, ready, true);
  await lowReserve(page);
  await expect(page.getByTestId('reserve-prepare')).toBeEnabled();
  state.setReadiness({ ...verified, ready: false, code: 'FEED_STALE', feedFresh: false });
  await page.getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await expect(page.locator('.service-banner')).toContainText('价格已过期');
  await expect(page.getByTestId('reserve-prepare')).toBeDisabled();
  await expect(page.getByTestId('send-intent')).toBeDisabled();
  expect(state.writes).toEqual([]);
});
