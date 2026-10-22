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
    const wallet = {
      account: owner,
      chainId: '0x7a69',
      changeOnNextChainRead: false,
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
            if (wallet.changeOnNextChainRead) {
              wallet.changeOnNextChainRead = false;
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
  if (changeDuringFinalCheck) await page.route('**/api/v1/auth/verify', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await page.evaluate(() => {
      const wallet = (window as unknown as { __aegisTestWallet: { changeOnNextChainRead: boolean } }).__aegisTestWallet;
      wallet.changeOnNextChainRead = true;
    });
    await route.fulfill({ response });
  });
  await page.goto('/');
  await expect(page.getByTestId('connect-wallet')).toBeEnabled();
  return config;
}


async function chooseLegacyWallet(page: Page) {
  await page.getByTestId('connect-wallet').click();
  await expect(page.getByRole('heading', { name: '选择你的钱包' })).toBeVisible();
  await page.getByTestId('wallet-option-legacy-0').click();
}
async function connectOwner(page: Page) {
  await chooseLegacyWallet(page);
  await page.getByTestId('owner-login').click();
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
  await connectOwner(page);
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
    await connectOwner(page);
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
  await expect(page.getByTestId('wallet-not-detected')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
});

test('rejects an account change during the final chain check', async ({ page }) => {
  await installWallet(page, true);
  await connectOwner(page);
  await expect(page.getByText('钱包账户或网络已变更，请重新连接并签名登录。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.address'))).toBeNull();
});

test('extension disconnect invalidates an established session', async ({ page }) => {
  await installWallet(page);
  await connectOwner(page);
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
  discovery?: 'announced' | 'legacy'; reorderBeforeChoice?: boolean; leavePickerOpen?: boolean;
};
const fixtureOwner = '0x1111111111111111111111111111111111111111';
const fixtureOther = '0x5555555555555555555555555555555555555555';
const fixtureMetaLogo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" rx="8" fill="#f6851b"/><text x="18" y="25" text-anchor="middle" font-family="sans-serif" font-size="23" fill="white">M</text></svg>');
const fixtureTrustLogo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" rx="8" fill="#1769ff"/><text x="18" y="25" text-anchor="middle" font-family="sans-serif" font-size="23" fill="white">T</text></svg>');

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
  const reads: string[] = [];
  await page.addInitScript(({ options, owner, expectedChain, metaLogo, trustLogo }) => {
    const listeners = new Map<string, ((value: unknown) => void)[]>();
    const calls: { method: string; params: unknown[] }[] = [];
    let switches = 0;
    const state = { account: options.initialAccount ?? owner, chainId: expectedChain === 31337 ? '0xaa36a7' : '0x7a69' };
    const emit = (event: string, value: unknown) => { for (const callback of listeners.get(event) || []) callback(value); };
    Object.assign(window, { __switchFixture: { calls, state, emit } });
    const provider = {
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
    };
    Object.assign(window, { ethereum: provider });
    if (options.discovery) {
      const meta = { ...provider, isMetaMask: true };
      const trustCalls: string[] = [];
      const trust = { ...provider, isMetaMask: true, isTrust: true, async request({ method }: { method: string }) {
        trustCalls.push(method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x7777777777777777777777777777777777777777'];
        if (method === 'eth_chainId') return '0x7a69';
        throw new Error('Trust fixture must not receive a signing request');
      } };
      Object.assign(window, { __pickerFixture: { trustCalls, reorder() { Object.assign(window, { ethereum: { providers: [meta, trust] } }); } } });
      if (options.discovery === 'announced') {
        Object.assign(window, { ethereum: trust });
        window.addEventListener('eip6963:requestProvider', () => {
          for (const [uuid, name, rdns, selected] of [
            ['11111111-1111-4111-8111-111111111111', 'MetaMask', 'io.metamask', meta],
            ['22222222-2222-4222-8222-222222222222', 'Trust Wallet', 'com.trustwallet.app', trust],
          ] as const) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, name, rdns, icon: name === 'MetaMask' ? metaLogo : trustLogo }, provider: selected } }));
        });
      } else Object.assign(window, { ethereum: { providers: [trust, meta] } });
    }
  }, { options, owner: fixtureOwner, expectedChain, metaLogo: fixtureMetaLogo, trustLogo: fixtureTrustLogo });
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') reads.push(path);
    if (route.request().method() !== 'GET') auth.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith('/config')) await route.fulfill({ json: config });
    else if (path.endsWith('/auth/challenge')) {
      if (options.raceAfterChallenge) await page.evaluate(() => {
        const fixture = (window as unknown as { __switchFixture: { state: { account: string }; emit(event: string, value: unknown): void } }).__switchFixture;
        fixture.state.account = '0x6666666666666666666666666666666666666666';
        fixture.emit('accountsChanged', [fixture.state.account]);
      });
      await route.fulfill({ json: { challengeId: 'cf7d497f-3a06-481b-9735-e5127a3873cb', message: 'fixture login', address: fixtureOwner, chainId: expectedChain, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    } else if (path.endsWith('/auth/verify')) await route.fulfill({ json: { token: 'network-switch-render-fixture', address: fixtureOwner, chainId: expectedChain, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    else if (path.endsWith('/tasks')) await route.fulfill({ json: { tasks: [] } });
    else if (path.endsWith('/wallets/current')) await route.fulfill({ json: { chainId: expectedChain, walletAddress: config.walletAddress, recipientAddress: config.recipientAddress, recipientBalanceWei: '1', observedBlockNumber: '1', observedBlockHash: '0x' + 'ab'.repeat(32), observedAt: new Date().toISOString(), dataSource: 'chain' } });
    else await route.fulfill({ status: 503, json: { error: { code: 'FIXTURE_FORBIDS_WRITE', message: 'No payment in switch fixtures' } } });
  });
  await page.goto('/');
  await expect(page.getByTestId('connect-wallet')).toBeEnabled();
  if (options.discovery) {
    await page.getByTestId('connect-wallet').click();
    await expect(page.locator('.wallet-option').filter({ hasText: 'MetaMask' })).toBeVisible();
    if (options.reorderBeforeChoice) await page.evaluate(() => {
      const fixture = (window as unknown as { __pickerFixture: { reorder(): void } }).__pickerFixture;
      fixture.reorder();
    });
    if (!options.leavePickerOpen) await page.locator('.wallet-option').filter({ hasText: 'MetaMask' }).click();
  } else await chooseLegacyWallet(page);
  return { auth, reads, async calls() { return page.evaluate(() => (window as unknown as { __switchFixture: { calls: { method: string; params: unknown[] }[] } }).__switchFixture.calls); } };
}

test('switch fixture: connect requests Local and verifies chain and new account before login', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { initialAccount: fixtureOther, accountAfterSwitch: fixtureOwner });
  expect(fixture.auth).toEqual([]);
  await page.getByTestId('owner-login').click();
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
  expect(fixture.auth).toEqual([]);
  await page.getByTestId('owner-login').click();
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
  expect(fixture.auth).toEqual([]);
  await page.getByTestId('owner-login').click();
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
  await expect(page.getByTestId('connection-role')).toHaveText('只读连接');
  await expect(page.getByTestId('wallet-connection')).toContainText(fixtureOther);
  await expect(page.getByTestId('wallet-connection')).toContainText(fixtureOwner);
  await expect(page.getByTestId('owner-login')).toHaveCount(0);
  await expect(page.getByTestId('send-intent')).toHaveCount(0);
  expect(fixture.auth).toEqual([]);
  expect((await fixture.calls()).some(call => call.method === 'personal_sign')).toBe(false);
});

test('switch fixture: account change during challenge stops before signing', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { raceAfterChallenge: true });
  expect(fixture.auth).toEqual([]);
  await page.getByTestId('owner-login').click();
  await expect(page.getByRole('alert')).toContainText('钱包账户或网络已变更');
  expect(fixture.auth.map(item => item.path)).toEqual(['/api/v1/auth/challenge']);
  expect((await fixture.calls()).some(call => call.method === 'personal_sign')).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('aegis.session'))).toBeNull();
});

test('picker fixture: MetaMask is explicitly selected while Trust Wallet owns the default injection', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { discovery: 'announced', initialAccount: fixtureOther });
  await expect(page.getByTestId('connection-role')).toHaveText('只读连接');
  await expect(page.getByTestId('wallet-connection')).toContainText('MetaMask');
  await expect(page.getByTestId('wallet-connection')).toContainText(fixtureOther);
  expect(await page.evaluate(() => Reflect.get(Reflect.get(window, 'ethereum'), 'isTrust'))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __pickerFixture: { trustCalls: string[] } }).__pickerFixture.trustCalls)).toEqual([]);
  expect(fixture.auth).toEqual([]);
  expect(fixture.reads.every(path => path.endsWith('/config'))).toBe(true);
  expect((await fixture.calls()).some(call => ['personal_sign', 'eth_sendTransaction'].includes(call.method))).toBe(false);
  await expect(page.getByTestId('send-intent')).toHaveCount(0);
  await expect(page.getByTestId('owner-login')).toHaveCount(0);
});

test('picker fixture: legacy provider reordering cannot redirect a MetaMask click to Trust Wallet', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { discovery: 'legacy', reorderBeforeChoice: true, initialAccount: fixtureOther });
  await expect(page.getByTestId('connection-role')).toHaveText('只读连接');
  await expect(page.getByTestId('wallet-connection')).toContainText('MetaMask');
  await expect(page.getByTestId('wallet-connection')).toContainText(fixtureOther);
  expect(await page.evaluate(() => (window as unknown as { __pickerFixture: { trustCalls: string[] } }).__pickerFixture.trustCalls)).toEqual([]);
  expect(fixture.auth).toEqual([]);
  expect((await fixture.calls()).some(call => ['personal_sign', 'eth_sendTransaction'].includes(call.method))).toBe(false);
});

test('picker fixture: old private poll responses stay discarded after disconnect and a viewer connection', async ({ page }) => {
  const fixture = await installSwitchFixture(page);
  await page.getByTestId('owner-login').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  let markStarted: () => void = () => { throw new Error('Task wait not initialized'); };
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let release: () => void = () => { throw new Error('Task gate not initialized'); };
  const gate = new Promise<void>(resolve => { release = resolve; });
  let blocked = false;
  await page.route('**/api/v1/tasks', async route => {
    if (blocked) { await route.fallback(); return; }
    blocked = true; markStarted(); await gate;
    await route.fulfill({ json: { tasks: [{
      taskId: 'old-private-task', status: 'AWAITING_APPROVAL', purpose: '旧 Owner 私密任务',
      chainId: 31337, walletAddress: '0x2222222222222222222222222222222222222222',
      ownerAddress: fixtureOwner, agentAddress: '0x4444444444444444444444444444444444444444',
      recipient: '0x3333333333333333333333333333333333333333', amountWei: '1', maxUsdCost6: '1',
    }] } });
  });
  // Exercise the real background poll: manual refresh intentionally locks wallet
  // reconnect until it finishes, which would expire this gated response first.
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
  await started;
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('[data-action="disconnect"]').click();
  await page.evaluate(other => {
    const fixture = (window as unknown as { __switchFixture: { state: { account: string }; emit(event: string, value: unknown): void } }).__switchFixture;
    fixture.state.account = other; fixture.emit('accountsChanged', [other]);
  }, fixtureOther);
  await chooseLegacyWallet(page);
  await expect(page.getByTestId('connection-role')).toHaveText('只读连接');
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/tasks'));
  release();
  const response = await oldResponse;
  expect(response.status()).toBe(200);
  await response.finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('旧 Owner 私密任务', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '验证记录', exact: true }).click();
  await expect(page.getByText('旧 Owner 私密任务', { exact: true })).toHaveCount(0);
  expect(fixture.auth.map(item => item.path)).toEqual(['/api/v1/auth/challenge', '/api/v1/auth/verify']);
  expect((await fixture.calls()).some(call => call.method === 'eth_sendTransaction')).toBe(false);
});

test('picker fixture: restored HTTP session shows read-only data until a fresh Owner provider login', async ({ page }) => {
  const fixture = await installSwitchFixture(page);
  await page.getByTestId('owner-login').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId('reconnect-owner-note')).toBeVisible();
  await expect(page.getByTestId('send-intent')).toBeDisabled();
  await expect(page.getByTestId('intent-message')).toBeDisabled();
  expect(fixture.auth.map(item => item.path)).toEqual(['/api/v1/auth/challenge', '/api/v1/auth/verify']);
  expect((await fixture.calls()).some(call => ['personal_sign', 'eth_sendTransaction'].includes(call.method))).toBe(false);
});

test('picker fixture: blocked session storage preserves in-memory Owner login and disconnect clears private data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const attempts = { getItem: 0, setItem: 0, removeItem: 0 };
    Object.assign(window, { __blockedStorageFixture: attempts });
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      Object.defineProperty(sessionStorage, method, { configurable: true, value() {
        attempts[method]++;
        throw new DOMException('Session storage blocked by fixture', 'SecurityError');
      } });
    }
  });
  const fixture = await installSwitchFixture(page, { discovery: 'announced' });
  const privateHeaders: string[] = [];
  const purpose = '仅在内存会话中可见的私有任务';
  await page.route('**/api/v1/tasks', async route => {
    privateHeaders.push(route.request().headers().authorization || '');
    await route.fulfill({ json: { tasks: [{
      taskId: 'blocked-storage-private-task', status: 'AWAITING_APPROVAL', purpose,
      chainId: 31337, walletAddress: '0x2222222222222222222222222222222222222222',
      ownerAddress: fixtureOwner, agentAddress: '0x4444444444444444444444444444444444444444',
      recipient: '0x3333333333333333333333333333333333333333', amountWei: '1', maxUsdCost6: '1',
    }] } });
  });
  await expect(page.getByTestId('connection-role')).toHaveText('待签名登录');
  expect(fixture.auth).toEqual([]);
  expect((await fixture.calls()).some(call => call.method === 'personal_sign')).toBe(false);
  await page.getByTestId('owner-login').click();
  await expect(page.getByTestId('intent-message')).toBeEnabled();
  await expect(page.getByText(purpose, { exact: true })).toBeVisible();
  await expect(page.getByTestId('wallet-balance')).toBeVisible();
  expect(privateHeaders).toEqual(['Bearer network-switch-render-fixture']);
  expect(fixture.auth.map(item => item.path)).toEqual(['/api/v1/auth/challenge', '/api/v1/auth/verify']);
  expect((await fixture.calls()).filter(call => call.method === 'personal_sign')).toHaveLength(1);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByText('已签名登录', { exact: true })).toBeVisible();
  await page.locator('[data-action="disconnect"]').click();
  await expect(page.getByTestId('connect-wallet')).toContainText('连接钱包');
  await expect(page.getByText('未登录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '验证记录', exact: true }).click();
  await expect(page.getByText(purpose, { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-task-id="blocked-storage-private-task"]')).toHaveCount(0);
  await expect(page.getByTestId('intent-message')).toHaveCount(0);
  await expect(page.getByTestId('wallet-balance')).toHaveCount(0);
  const snapshotReads = fixture.reads.filter(path => path.endsWith('/wallets/current')).length;
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/v1/config'));
  await page.getByRole('button', { name: '刷新服务状态', exact: true }).click();
  await (await refreshed).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(privateHeaders).toHaveLength(1);
  expect(fixture.reads.filter(path => path.endsWith('/wallets/current'))).toHaveLength(snapshotReads);
  const attempts = await page.evaluate(() => (window as unknown as { __blockedStorageFixture: { getItem: number; setItem: number; removeItem: number } }).__blockedStorageFixture);
  expect(attempts.getItem).toBeGreaterThan(0);
  expect(attempts.setItem).toBeGreaterThan(0);
  expect(attempts.removeItem).toBeGreaterThan(0);
  expect((await fixture.calls()).some(call => call.method === 'eth_sendTransaction')).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __pickerFixture: { trustCalls: string[] } }).__pickerFixture.trustCalls)).toEqual([]);
  expect(errors).toEqual([]);
});

test('picker fixture: supplied wallet logos remain visible in light, dark, and mobile layouts', async ({ page }) => {
  const fixture = await installSwitchFixture(page, { discovery: 'announced', initialAccount: fixtureOther, leavePickerOpen: true });
  const metaLogo = page.getByAltText('MetaMask Logo', { exact: true });
  const trustLogo = page.getByAltText('Trust Wallet Logo', { exact: true });
  await expect(metaLogo).toHaveAttribute('src', fixtureMetaLogo);
  await expect(trustLogo).toHaveAttribute('src', fixtureTrustLogo);
  await expect.poll(() => metaLogo.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
  await expect.poll(() => trustLogo.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
  const theme = page.getByTestId('theme-toggle');
  if (await theme.getAttribute('aria-label') === '切换到浅色模式') await theme.evaluate(button => { if (button instanceof HTMLButtonElement) button.click(); });
  await page.screenshot({ path: 'backend/data/picker-light.png', fullPage: true });
  await theme.evaluate(button => { if (button instanceof HTMLButtonElement) button.click(); });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(metaLogo).toHaveAttribute('src', fixtureMetaLogo);
  await page.screenshot({ path: 'backend/data/picker-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = page.getByRole('dialog', { name: '选择你的钱包' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth + 1;
  })).toBe(true);
  await expect(metaLogo).toBeVisible();
  await page.screenshot({ path: 'backend/data/picker-mobile.png', fullPage: true });
  await page.locator('.wallet-option').filter({ hasText: 'MetaMask' }).focus();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(fixture.auth).toEqual([]);
  expect(await fixture.calls()).toEqual([]);
});
