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

async function fixture(page: Page, readiness: Readiness, signedIn = false, interactiveOwner = false) {
  let current = readiness;
  const writes: string[] = [];
  const authRequests: string[] = [];
  if (signedIn) await page.addInitScript(({ owner }) => {
    sessionStorage.setItem('aegis.session', 'readiness-render-fixture');
    sessionStorage.setItem('aegis.address', owner);
    sessionStorage.setItem('aegis.wallet-kind', 'local');
  }, { owner });
  if (interactiveOwner) await page.addInitScript(({ owner }) => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    Object.assign(window, { ethereum: {
      isMetaMask: true,
      on(event: string, callback: (...args: unknown[]) => void) { listeners.set(event, [...listeners.get(event) || [], callback]); },
      removeListener(event: string, callback: (...args: unknown[]) => void) { listeners.set(event, (listeners.get(event) || []).filter(item => item !== callback)); },
      async request({ method }: { method: string }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner];
        if (method === 'eth_chainId') return '0x7a69';
        if (method === 'personal_sign') return '0x' + 'ab'.repeat(65);
        throw new Error('Readiness fixture forbids wallet method: ' + method);
      },
    } });
  }, { owner });
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    if (interactiveOwner && request.method() === 'POST' && path.endsWith('/auth/challenge')) {
      authRequests.push(path);
      await route.fulfill({ json: { challengeId: '11111111-1111-4111-8111-111111111111', message: 'Readiness fixture Owner login', address: owner, chainId: 31337, expiresAt } });
      return;
    }
    if (interactiveOwner && request.method() === 'POST' && path.endsWith('/auth/verify')) {
      authRequests.push(path);
      await route.fulfill({ json: { token: 'readiness-interactive-owner-fixture', address: owner, chainId: 31337, expiresAt } });
      return;
    }
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
  return { writes, authRequests, setReadiness(value: Readiness) { current = value; } };
}

async function lowReserve(page: Page) {
  await page.getByTestId('reserve-threshold').fill('0.05');
  await page.getByTestId('reserve-target').fill('0.1');
  await expect(page.getByTestId('reserve-suggestion')).toHaveText('0.099 ETH');
}

test('expired price preserves verified read-only balances and blocks preparation and payment', async ({ page }) => {
  const { writes } = await fixture(page, { ...verified, ready: false, code: 'FEED_STALE', feedFresh: false }, true);
  await expect(page.getByTestId('service-banner')).toContainText('Chainlink 报价待更新');
  await expect(page.getByTestId('reserve-balance')).toHaveText('0.001 ETH');
  await lowReserve(page);
  await expect(page.getByTestId('reserve-prepare')).toBeDisabled();
  await expect(page.getByTestId('send-intent')).toBeDisabled();
  await expect(page.getByTestId('intent-message')).toBeDisabled();
  // The action guard must also stop a forced DOM click.
  for (const name of ['reserve-prepare', 'send-intent']) {
    await page.getByTestId(name).evaluate(element => { if (element instanceof HTMLButtonElement) { element.disabled = false; element.click(); } });
  }
  expect(writes).toEqual([]);
});

test('funding requirement has an actionable message and permits read-only connection', async ({ page }) => {
  const { writes } = await fixture(page, { ...verified, ready: false, code: 'FUNDING_REQUIRED', walletFunded: false }, true);
  await expect(page.getByTestId('service-banner')).toContainText('测试 ETH 余额不足');
  await expect(page.getByTestId('connect-wallet')).toBeEnabled();
  await expect(page.getByTestId('reserve-balance')).toHaveText('0.001 ETH');
  await lowReserve(page);
  await expect(page.getByTestId('reserve-prepare')).toBeDisabled();
  await expect(page.getByTestId('send-intent')).toBeDisabled();
  expect(writes).toEqual([]);
});

const unavailableCases: { name: string; readiness: Readiness; message: string }[] = [
  { name: 'unknown', readiness: { ready: false, code: 'FUTURE_UNKNOWN_FAILURE' }, message: '链上状态未确认' },
  { name: 'RPC unavailable', readiness: { ready: false, code: 'CHAIN_UNAVAILABLE' }, message: '本地链 RPC 暂不可用' },
  { name: 'mismatched network', readiness: { ...verified, rpcChainId: 1, ready: true }, message: '网络配置不一致' },
  { name: 'stale without identity proofs', readiness: { ready: false, code: 'FEED_STALE' }, message: 'Chainlink 报价待更新' },
];
for (const { name, readiness, message } of unavailableCases) {
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
  const state = await fixture(page, ready, false, true);
  await page.getByTestId('connect-wallet').click();
  await expect(page.getByRole('heading', { name: '选择你的钱包' })).toBeVisible();
  await page.getByTestId('wallet-option-legacy-0').click();
  await expect(page.getByTestId('owner-login')).toBeVisible();
  expect(state.authRequests).toEqual([]);
  await page.getByTestId('owner-login').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  expect(state.authRequests).toEqual(['/api/v1/auth/challenge', '/api/v1/auth/verify']);
  await lowReserve(page);
  await expect(page.getByTestId('reserve-prepare')).toBeEnabled();
  state.setReadiness({ ...verified, ready: false, code: 'FEED_STALE', feedFresh: false });
  await page.getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await expect(page.getByTestId('service-banner')).toContainText('Chainlink 报价待更新');
  await expect(page.getByTestId('reserve-prepare')).toBeDisabled();
  await expect(page.getByTestId('send-intent')).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test('a connected owner stays connected during verified background revalidation while payment remains disabled', async ({ page }) => {
  const state = await fixture(page, ready, false, true);
  await page.getByTestId('connect-wallet').click();
  await page.getByTestId('wallet-option-legacy-0').click();
  await page.getByTestId('owner-login').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  state.setReadiness({ ...verified, ready: false, code: 'READINESS_CHECKING', source: 'checking' });
  await page.getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await expect(page.getByTestId('service-banner')).toContainText('保留上次成功核对');
  await expect(page.getByTestId('connect-wallet')).toContainText('0x1111…1111');
  await expect(page.getByTestId('intent-message')).toBeDisabled();
  await expect(page.getByTestId('send-intent')).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test('topbar and retry communicate the current service phase', async ({ page }) => {
  const state = await fixture(page, ready);
  await expect(page.getByTestId('service-status')).toContainText('本地演示 · 可操作');
  state.setReadiness({ ready: false, code: 'CHAIN_UNAVAILABLE' });
  await page.getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await expect(page.getByTestId('service-status')).toContainText('本地链 RPC 暂不可用');
  await expect(page.getByTestId('service-banner')).toContainText('API 正在运行');
  await expect(page.getByTestId('connect-wallet')).toHaveAttribute('title', /RPC 暂不可用/);
});

test('background readiness checking stays responsive, blocks wallet actions, and recovers', async ({ page }) => {
  const state = await fixture(page, { ready: false, code: 'READINESS_CHECKING', source: 'checking', checkedAt: null, cacheAgeMs: null });
  await expect(page.getByTestId('service-status')).toContainText('正在核对 本地链');
  await expect(page.getByTestId('service-banner')).toContainText('正在后台读取');
  await expect(page.getByTestId('connect-wallet')).toBeDisabled();
  state.setReadiness(ready);
  // Pending readiness is polled automatically instead of forcing the user to
  // click retry or wait for the normal thirty-second refresh interval.
  await expect(page.getByTestId('service-banner')).toHaveCount(0);
  await expect(page.getByTestId('connect-wallet')).toBeEnabled();
  expect(state.writes).toEqual([]);
});
