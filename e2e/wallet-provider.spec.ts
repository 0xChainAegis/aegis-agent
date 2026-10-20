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
            if (changeDuringFinalCheck && chainReads === 3) {
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
