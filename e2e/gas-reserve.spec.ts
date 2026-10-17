import {test,expect} from '@playwright/test';
import {balanceOf,config,eth,login,pausePolling,rpc,setReserve,tasks,trackWrites} from './reserve-helpers';

// Gas-reserve card for the single configured operating wallet (config.recipientAddress).
// These cases never pay. The one real payment lives in wallet.topup.spec.ts, which sorts
// after wallet.spec.ts: wallet.spec.ts needs the whole $15 shared daily budget of the fresh
// chain, and Playwright runs files alphabetically with workers:1.

const MILLI=10n**15n; // 0.001 ETH in wei

test('healthy reserve: real balance shown, no suggestion and nothing submitted',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const writes=trackWrites(page);
 await login(page);
 const cfg=await config(page);
 const card=page.getByTestId('reserve-card');
 await expect(card).toHaveAttribute('data-state','unset');
 const balance=await balanceOf(cfg.recipientAddress);
 await expect(page.getByTestId('reserve-balance')).toHaveText(`${eth(balance)} ETH`);
 await expect(card).toContainText(cfg.recipientAddress);
 await expect(card).toContainText('Chain 31337');
 await expect(card).toContainText(/区块 #\d+/);
 const before=(await tasks(page)).length;
 // Explicit test settings far below the real Hardhat balance.
 await setReserve(page,'0.01','0.02');
 await expect(card).toHaveAttribute('data-state','healthy');
 await expect(page.getByTestId('reserve-healthy')).toBeVisible();
 await expect(page.getByTestId('reserve-prepare')).toHaveCount(0);
 await page.waitForTimeout(6000); // one background poll
 await expect(card).toHaveAttribute('data-state','healthy');
 expect(writes).toEqual([]);
 expect((await tasks(page)).length).toBe(before);
 expect(await balanceOf(cfg.recipientAddress)).toBe(balance);
 // Settings are browser-local and namespaced by chain, treasury and recipient.
 const key=`aegis.reserve.v1.${cfg.chainId}.${cfg.walletAddress.toLowerCase()}.${cfg.recipientAddress.toLowerCase()}`;
 expect(JSON.parse(await page.evaluate(k=>localStorage.getItem(k)||'null',key))).toEqual({threshold:'0.01',target:'0.02'});
 await page.reload();await expect(page.getByTestId('reserve-threshold')).toHaveValue('0.01');
 expect(errors).toEqual([]);
});

test('invalid settings and missing/offline data never prepare a payment',async({page})=>{
 const writes=trackWrites(page);
 await login(page);
 const cfg=await config(page);
 const card=page.getByTestId('reserve-card');
 const invalid:[string,string,RegExp][]=[
  ['0','1',/大于 0/],['-1','1',/十进制/],['abc','1',/十进制/],
  ['0.0000000000000000001','1',/18 位小数/],['1','1',/下限必须小于目标余额/],['2','1',/下限必须小于目标余额/],['1','',/请填写/],
 ];
 for(const [threshold,target,message] of invalid){
  await setReserve(page,threshold,target);
  await expect(card).toHaveAttribute('data-state','invalid');
  await expect(page.getByTestId('reserve-error')).toContainText(message);
  await expect(page.getByTestId('reserve-prepare')).toHaveCount(0);
 }
 // Valid settings above the real balance → low, preparation available.
 const balance=await balanceOf(cfg.recipientAddress);
 await setReserve(page,eth(balance+MILLI/2n),eth(balance+MILLI));
 await expect(card).toHaveAttribute('data-state','low');
 await expect(page.getByTestId('reserve-prepare')).toBeEnabled();

 // FIXTURE (rendering only, not chain evidence): snapshot missing recipientBalanceWei.
 await page.route('**/api/v1/wallets/current',async route=>{const response=await route.fetch();const body=await response.json();delete body.recipientBalanceWei;await route.fulfill({response,json:body});});
 await page.locator('[data-action="refresh"]').first().click();
 await expect(card).toHaveAttribute('data-state','unavailable');
 await expect(page.getByTestId('reserve-balance')).toHaveText('— ETH');
 await expect(page.getByTestId('reserve-error')).toContainText('不按 0 处理');
 await expect(page.getByTestId('reserve-suggestion')).toHaveCount(0);
 await expect(page.getByTestId('reserve-prepare')).toHaveCount(0);
 await page.unroute('**/api/v1/wallets/current');

 // FIXTURE: snapshot bound to another chain is rejected, not shown.
 await page.route('**/api/v1/wallets/current',async route=>{const response=await route.fetch();const body=await response.json();body.chainId=1;await route.fulfill({response,json:body});});
 await page.locator('[data-action="refresh"]').first().click();
 await expect(card).toHaveAttribute('data-state','unavailable');
 await expect(page.getByTestId('reserve-error')).toContainText('网络与当前配置不一致');
 await page.unroute('**/api/v1/wallets/current');
 await page.locator('[data-action="refresh"]').first().click();
 await expect(card).toHaveAttribute('data-state','low');

 // FIXTURE: the fresh re-read at preparation time fails (RPC error) → stop, no draft.
 await pausePolling(page,true);
 await page.route('**/api/v1/wallets/current',route=>route.fulfill({status:503,json:{error:{code:'RPC_UNAVAILABLE',message:'RPC 暂不可用'}}}));
 await page.getByTestId('reserve-prepare').click();
 await expect(card).toHaveAttribute('data-state','unavailable');
 await expect(page.getByTestId('reserve-error')).toContainText('RPC 暂不可用');
 await expect(page.getByTestId('reserve-prepare')).toHaveCount(0);
 await page.unroute('**/api/v1/wallets/current');
 await pausePolling(page,false);

 // Offline: every API call fails.
 await page.route('**/api/v1/**',route=>route.abort());
 await page.locator('[data-action="refresh"]').first().click();
 await expect(page.getByText('服务离线',{exact:true})).toBeVisible();
 await expect(card).toHaveAttribute('data-state','unavailable');
 await expect(page.getByTestId('reserve-balance')).toHaveText('— ETH');
 await expect(page.getByTestId('reserve-prepare')).toHaveCount(0);
 expect(writes.filter(w=>w.method==='POST')).toEqual([]);
});

test('balance changes before preparation: suggestion refreshes and needs another review',async({page})=>{
 const writes=trackWrites(page);
 await login(page);
 const cfg=await config(page);
 const card=page.getByTestId('reserve-card');
 const balance=await balanceOf(cfg.recipientAddress);
 await setReserve(page,eth(balance+MILLI/2n),eth(balance+MILLI));
 await expect(page.getByTestId('reserve-suggestion')).toHaveText('0.001 ETH');
 const before=(await tasks(page)).length;

 // Keep the displayed suggestion fixed, then change the real balance with a real local
 // transfer from another Hardhat account (not the treasury, not a faked balance).
 await pausePolling(page,true);
 const accounts=await rpc('eth_accounts',[]) as string[];
 const sender=accounts.find(a=>![cfg.ownerAddress,cfg.agentAddress,cfg.recipientAddress].map((x:string)=>x.toLowerCase()).includes(a.toLowerCase()))!;
 const hash=await rpc('eth_sendTransaction',[{from:sender,to:cfg.recipientAddress,value:'0x'+(2n*10n**14n).toString(16)}]);
 expect((await rpc('eth_getTransactionReceipt',[hash])).status).toBe('0x1');
 expect(await balanceOf(cfg.recipientAddress)).toBe(balance+2n*10n**14n);
 await expect(page.getByTestId('reserve-suggestion')).toHaveText('0.001 ETH'); // still the old display

 await page.getByTestId('reserve-prepare').click();
 await expect(page.getByTestId('reserve-review-note')).toContainText('0.0008');
 await expect(page.getByTestId('reserve-suggestion')).toHaveText('0.0008 ETH');
 await expect(page.getByTestId('confirm-transfer')).toHaveCount(0);
 expect(writes).toEqual([]); // nothing created on the changed amount

 // Deliberate second review → the new exact amount reaches the existing preview.
 const previewed=page.waitForResponse(r=>r.url().endsWith('/preview')&&r.request().method()==='POST');
 await page.getByTestId('reserve-prepare').click();
 const preview=await (await previewed).json();
 expect(preview.status).toBe('READY');
 const created=writes.filter(w=>w.method==='POST'&&w.path==='/api/v1/intents');
 expect(created).toHaveLength(1);
 expect(created[0].body.amountWei).toBe('800000000000000');
 expect(created[0].body.recipient.toLowerCase()).toBe(cfg.recipientAddress.toLowerCase());
 await expect(page.getByTestId('reserve-draft-context')).toBeVisible();
 await expect(page.locator('.transfer-hero strong')).toHaveText('0.0008 ETH');
 await expect(page.getByTestId('confirm-transfer')).toBeEnabled();
 // Not confirmed → no submission, no task, no payment.
 await page.getByRole('button',{name:'关闭详情',exact:true}).click();
 await page.waitForTimeout(1500);
 expect(writes.some(w=>w.path.endsWith('/submit'))).toBe(false);
 expect((await tasks(page)).length).toBe(before);
 expect(await balanceOf(cfg.recipientAddress)).toBe(balance+2n*10n**14n);
 await pausePolling(page,false);
});
