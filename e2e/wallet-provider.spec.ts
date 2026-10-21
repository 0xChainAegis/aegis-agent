import { test, expect, type Page } from '@playwright/test';

async function installWallet(page: Page, changeDuringFinalCheck = false) {
  const response = await page.request.get('/api/v1/config');
  expect(response.ok()).toBe(true);
  const config = await response.json();
  expect(config.mode).toBe('local_chain');
  expect(config.chainId).toBe(31337);
  expect(config.readiness.ready, `Local chain must be ready: ${config.readiness.code || 'unknown'}`).toBe(true);
  await page.addInitScript(({ owner, rpcUrl, changeDuringFinalCheck }) => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    let chainReads = 0;
    const wallet = {
      account: owner,
      chainId: '0x7a69',
      emit(event: string) {
        const value = event === 'accountsChanged' ? [this.account] : this.chainId;
        for (const callback of listeners.get(event) || []) callback(value);
      },
    };
    Object.assign(window, { __aegisTestWallet: wallet });
    Object.assign(window, {
      ethereum: {
        on(event: string, callback: (...args: unknown[]) => void) {
          listeners.set(event, [...listeners.get(event) || [], callback]);
        },
        removeListener(event: string, callback: (...args: unknown[]) => void) {
          listeners.set(event, (listeners.get(event) || []).filter(item => item !== callback));
        },
        async request({ method, params = [] }: { method: string; params?: unknown[] }) {
          if (method === 'eth_requestAccounts') {
            // Extensions can announce the first authorized account before resolving this request.
            wallet.emit('accountsChanged');
            return [wallet.account];
          }
          if (method === 'eth_accounts') return [wallet.account];
          if (method === 'eth_chainId') {
            chainReads++;
            if (changeDuringFinalCheck && chainReads === 4) {
              wallet.account = '0x0000000000000000000000000000000000000001';
              wallet.emit('accountsChanged');
            }
            return wallet.chainId;
          }
          if (method === 'personal_sign') {
            const result = await fetch(rpcUrl, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            }).then(response => response.json());
            if (result.error) throw new Error(result.error.message);
            return result.result;
          }
          throw new Error(`Unexpected wallet request: ${method}`);
        },
      },
    });
  }, { owner: config.ownerAddress, rpcUrl: config.rpcUrl, changeDuringFinalCheck });
  await page.goto('/');
  await expect(page.getByTestId('connect-wallet')).toBeEnabled();
  return config;
}

async function changeWallet(page: Page, kind: 'account' | 'chain') {
  await page.evaluate(kind => {
    const wallet = (window as unknown as { __aegisTestWallet: {
      account: string; chainId: string; emit(event: string): void;
    } }).__aegisTestWallet;
    if (kind === 'account') {
      wallet.account = '0x0000000000000000000000000000000000000001';
      wallet.emit('accountsChanged');
    } else {
      wallet.chainId = '0xaa36a7';
      wallet.emit('chainChanged');
    }
  }, kind);
}

test('extension authorization event does not clear the connecting provider', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const config = await installWallet(page);
  await page.getByTestId('connect-wallet').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeTruthy();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.address'))).toBe(config.ownerAddress);
  await expect(page.getByText('钱包账户或网络已变更，请重新连接并签名登录。', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);

  await changeWallet(page, 'account');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.address'))).toBeNull();
  await expect(page.getByTestId('connect-wallet')).toContainText('连接钱包');
});

for (const kind of ['account', 'chain'] as const) {
  test(`rejects ${kind} change while login verification is pending`, async ({ page }) => {
    await installWallet(page);
    await page.route('**/api/v1/auth/verify', async route => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await changeWallet(page, kind);
      await route.fulfill({ response });
    });
    await page.getByTestId('connect-wallet').click();
    await expect(page.getByText('钱包账户或网络已变更，请重新连接并签名登录。', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('aegis.address'))).toBeNull();
    await expect(page.getByTestId('connect-wallet')).toContainText('连接钱包');
  });
}

test('incomplete injected wallet shows a readable error', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { ethereum: {} }));
  await page.goto('/');
  await page.getByTestId('connect-wallet').click();
  await expect(page.getByText('浏览器钱包接口尚未就绪。请启用钱包插件并刷新页面后重试。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
});

test('rejects an account change during the final chain check', async ({ page }) => {
  await installWallet(page, true);
  await page.getByTestId('connect-wallet').click();
  await expect(page.getByText('钱包账户或网络已变更，请重新连接并签名登录。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.address'))).toBeNull();
});

test('extension disconnect invalidates an established session', async ({ page }) => {
  await installWallet(page);
  await page.getByTestId('connect-wallet').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  await page.evaluate(() => (window as unknown as { __aegisTestWallet: { emit(event: string): void } }).__aegisTestWallet.emit('disconnect'));
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
  await expect(page.getByTestId('connect-wallet')).toContainText('连接钱包');
});

test('local wallet session is independent of browser extension events', async ({ page }) => {
  const config = await installWallet(page);
  await page.getByTestId('local-wallet').click();
  await page.getByTestId('confirm-local-wallet').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  const token = await page.evaluate(() => sessionStorage.getItem('aegis.session'));
  expect(token).toBeTruthy();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.wallet-kind'))).toBe('local');
  await changeWallet(page, 'account');
  await changeWallet(page, 'chain');
  await page.evaluate(() => (window as unknown as { __aegisTestWallet: { emit(event: string): void } }).__aegisTestWallet.emit('disconnect'));
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBe(token);
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.address'))).toBe(config.ownerAddress);
  await expect(page.getByTestId('intent-message')).toBeEnabled();
});

type SwitchFixtureOptions = {
  missingChain?: boolean; reject?: boolean; unsupported?: boolean; stillWrong?: boolean;
  accountAfterSwitch?: string; initialAccount?: string; expectedChain?: number; rpcUrl?: string;
  rejectAdd?: boolean; raceAfterChallenge?: boolean;
};
const fixtureOwner = '0x1111111111111111111111111111111111111111';
const fixtureOther = '0x5555555555555555555555555555555555555555';

// All new switch cases use an intercepted provider and API. No browser extension,
// backend session, chain setup, or transaction is touched by these fixtures.
async function installSwitchFixture(page: Page, options: SwitchFixtureOptions = {}) {
  const expectedChain = options.expectedChain ?? 31337;
  const config = {
    mode: expectedChain === 31337 ? 'local_chain' : 'testnet', chainId: expectedChain,
    rpcUrl: options.rpcUrl ?? 'http://127.0.0.1:8545',
    ownerAddress: fixtureOwner, walletAddress: '0x2222222222222222222222222222222222222222',
    recipientAddress: '0x3333333333333333333333333333333333333333', agentAddress: '0x4444444444444444444444444444444444444444',
    readiness: { ready: true, rpcChainId: expectedChain, contractsDeployed: true, deploymentBindingsVerified: true, feedFresh: true },
  };
  const auth: { path: string; body: Record<string, unknown> }[] = [];
  await page.addInitScript(({ options, owner, expectedChain }) => {
    const listeners = new Map<string, ((value: unknown) => void)[]>();
    const calls: { method: string; params: unknown[] }[] = [];
    let switches = 0;
    const state = { account: options.initialAccount ?? owner, chainId: expectedChain === 31337 ? '0xaa36a7' : '0x7a69' };
    const emit = (event: string, value: unknown) => { for (const callback of listeners.get(event) || []) callback(value); };
    Object.assign(window, { __switchFixture: { calls, state, emit } });
    Object.assign(window, { ethereum: {
      on(event: string, callback: (value: unknown) => void) { listeners.set(event, [...listeners.get(event) || [], callback]); },
      removeListener(event: string, callback: (value: unknown) => void) { listeners.set(event, (listeners.get(event) || []).filter(item => item !== callback)); },
      async request({ method, params = [] }: { method: string; params?: unknown[] }) {
        calls.push({ method, params });
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [state.account];
        if (method === 'eth_chainId') return state.chainId;
        if (method === 'wallet_switchEthereumChain') {
          switches++;
          if (options.reject) throw { code: 4001 };
          if (options.unsupported) throw { code: 4200 };
          if (options.missingChain && switches === 1) throw { code: 4902 };
          if (!options.stillWrong) { state.chainId = '0x' + expectedChain.toString(16); emit('chainChanged', state.chainId); }
          if (options.accountAfterSwitch) { state.account = options.accountAfterSwitch; emit('accountsChanged', [state.account]); }
          return null;
        }
        if (method === 'wallet_addEthereumChain') {
          if (options.rejectAdd) throw { code: 4001 };
          return null;
        }
        if (method === 'personal_sign') return '0x' + 'ab'.repeat(65);
        throw new Error('Fixture forbids wallet method: ' + method);
      },
    } });
  }, { options, owner: fixtureOwner, expectedChain });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') auth.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith('/config')) await route.fulfill({ json: config });
    else if (path.endsWith('/auth/challenge')) {
      if (options.raceAfterChallenge) await page.evaluate(() => {
        const fixture = (window as unknown as { __switchFixture: { state: { account: string }; emit(event: string, value: unknown): void } }).__switchFixture;
        fixture.state.account = '0x6666666666666666666666666666666666666666';
        fixture.emit('accountsChanged', [fixture.state.account]);
      });
      await route.fulfill({ json: { challengeId: 'render-only-challenge', message: 'fixture login' } });
    } else if (path.endsWith('/auth/verify')) await route.fulfill({ json: { token: 'network-switch-render-fixture', address: fixtureOwner, chainId: expectedChain } });
    else if (path.endsWith('/tasks')) await route.fulfill({ json: { tasks: [] } });
    else if (path.endsWith('/wallets/current')) await route.fulfill({ json: { chainId: expectedChain, walletAddress: config.walletAddress, recipientAddress: config.recipientAddress, recipientBalanceWei: '1', observedBlockNumber: '1', observedBlockHash: '0x' + 'ab'.repeat(32), observedAt: new Date().toISOString(), dataSource: 'chain' } });
    else await route.fulfill({ status: 503, json: { error: { code: 'FIXTURE_FORBIDS_WRITE', message: 'No payment in switch fixtures' } } });
  });
  await page.goto('/');
  await expect(page.getByTestId('connect-wallet')).toBeEnabled();
  await page.getByTestId('connect-wallet').click();
  return { auth, async calls() { return page.evaluate(() => (window as unknown as { __switchFixture: { calls: { method: string; params: unknown[] }[] } }).__switchFixture.calls); } };
}

test('switch fixture: connect requests Local and verifies chain and new account before login', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { initialAccount: fixtureOther, accountAfterSwitch: fixtureOwner });
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  expect(fixture.auth[0].body).toEqual({ address: fixtureOwner, chainId: 31337 });
  const calls = await fixture.calls();
  const switchIndex = calls.findIndex(call => call.method === 'wallet_switchEthereumChain');
  expect(calls[switchIndex].params).toEqual([{ chainId: '0x7a69' }]);
  expect(calls[switchIndex + 1].method).toBe('eth_chainId');
  expect(calls[switchIndex + 2].method).toBe('eth_accounts');
  expect(calls.some(call => call.method === 'eth_sendTransaction')).toBe(false);
});

test('switch fixture: missing Local chain adds only the verified loopback RPC then switches', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { missingChain: true });
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  const calls = await fixture.calls();
  expect(calls.find(call => call.method === 'wallet_addEthereumChain')?.params).toEqual([{
    chainId: '0x7a69', chainName: 'Aegis Local (31337)',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['http://127.0.0.1:8545/'],
  }]);
  expect(calls.filter(call => call.method === 'wallet_switchEthereumChain')).toHaveLength(2);
  expect(fixture.auth).toHaveLength(2);
});

for (const [name, options] of [
  ['rejected switch', { reject: true }],
  ['unsupported switch', { unsupported: true }],
  ['wallet stayed on Sepolia', { stillWrong: true }],
  ['rejected Local addition', { missingChain: true, rejectAdd: true }],
] as [string, SwitchFixtureOptions][]) {
  test('switch fixture: ' + name + ' never requests a challenge or signature', async ({ page }) => {
    const fixture = await installSwitchFixture(page, options);
    await expect(page.getByRole('alert')).toContainText('页面需要 Local 本地开发链（31337）');
    await expect(page.getByRole('alert')).toContainText('本地测试钱包');
    await expect(page.getByRole('alert')).toContainText('Sepolia');
    expect(fixture.auth).toEqual([]);
    expect((await fixture.calls()).some(call => call.method === 'personal_sign')).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
  });
}

for (const rpcUrl of ['https://rpc.example.invalid', 'http://127.0.0.1:8545/?key=placeholder']) {
  test('switch fixture: never adds a non-loopback or query-bearing Local RPC ' + rpcUrl, async ({ page }) => {
    const fixture = await installSwitchFixture(page, { missingChain: true, rpcUrl });
    await expect(page.getByRole('alert')).toContainText('钱包未能完成网络切换');
    expect(fixture.auth).toEqual([]);
    expect((await fixture.calls()).some(call => call.method === 'wallet_addEthereumChain')).toBe(false);
  });
}

test('switch fixture: known Sepolia switches without adding a public RPC', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { expectedChain: 11155111 });
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  const calls = await fixture.calls();
  expect(calls.find(call => call.method === 'wallet_switchEthereumChain')?.params).toEqual([{ chainId: '0xaa36a7' }]);
  expect(calls.some(call => call.method === 'wallet_addEthereumChain')).toBe(false);
  expect(fixture.auth[0].body.chainId).toBe(11155111);
});

test('switch fixture: missing Sepolia stops with configuration guidance and no auto-add', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { expectedChain: 11155111, missingChain: true });
  await expect(page.getByRole('alert')).toContainText('后端也必须配置为 Sepolia');
  expect(fixture.auth).toEqual([]);
  expect((await fixture.calls()).some(call => call.method === 'wallet_addEthereumChain')).toBe(false);
});

test('switch fixture: a switched non-owner account cannot request an owner challenge', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { accountAfterSwitch: fixtureOther });
  await expect(page.getByRole('alert')).toContainText('此资金池只允许 Owner ' + fixtureOwner);
  await expect(page.getByRole('alert')).toContainText('当前钱包为 ' + fixtureOther);
  expect(fixture.auth).toEqual([]);
  expect((await fixture.calls()).some(call => call.method === 'personal_sign')).toBe(false);
});

test('switch fixture: account change during challenge stops before signing', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { raceAfterChallenge: true });
  await expect(page.getByRole('alert')).toContainText('钱包账户或网络已变更');
  expect(fixture.auth.map(item => item.path)).toEqual(['/api/v1/auth/challenge']);
  expect((await fixture.calls()).some(call => call.method === 'personal_sign')).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
});
