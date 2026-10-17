import {test,expect} from '@playwright/test';
import {authed,balanceOf,config,eth,login,rpc,setReserve,tasks,trackWrites} from './reserve-helpers';

// The real-chain top-up payment for the gas-reserve card runs in the separate reserve group.
// The baseline wallet flow spends $9 and later needs $6 of headroom to queue its cancellation
// case. npm run test:e2e runs the two groups in independent Playwright processes, each with
// a fresh local chain and SQLite database, so this payment cannot consume that headroom.

const MILLI=10n**15n; // 0.001 ETH

test('low reserve (explicit test settings): exact suggestion previews, needs confirmation, pays once, survives refresh',async({page},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const writes=trackWrites(page);
 await login(page);
 const cfg=await config(page);
 expect(cfg.mode).toBe('local_chain');expect(cfg.chainId).toBe(31337);
 const wallet=await authed(page,'/api/v1/wallets/current');
 expect(BigInt(wallet.budget.remainingUsd6)).toBeGreaterThanOrEqual(3_000_000n); // fits the shared budget
 const card=page.getByTestId('reserve-card');
 const B=await balanceOf(cfg.recipientAddress);
 const tasksBefore=await tasks(page);
 // Test-only settings relative to the real balance B: threshold B+0.0005, target B+0.001.
 await setReserve(page,eth(B+MILLI/2n),eth(B+MILLI));
 await expect(card).toHaveAttribute('data-state','low');
 await expect(page.getByTestId('reserve-status')).toHaveText('低于你设置的下限');
 await expect(page.getByTestId('reserve-suggestion')).toHaveText('0.001 ETH');
 await page.screenshot({path:testInfo.outputPath('reserve-low.png'),fullPage:true});

 const previewed=page.waitForResponse(r=>r.url().endsWith('/preview')&&r.request().method()==='POST');
 await page.getByTestId('reserve-prepare').click();
 const preview=await (await previewed).json();
 expect(preview.status).toBe('READY');expect(preview.decision).toBe('AUTO');expect(preview.costUsd6).toBe('3000000');
 const created=writes.filter(w=>w.method==='POST'&&w.path==='/api/v1/intents');
 expect(created).toHaveLength(1);
 expect(created[0].body).toMatchObject({amountWei:'1000000000000000',recipient:cfg.recipientAddress});
 // Preview is not payment: confirmation is still required and nothing moved.
 await expect(page.getByTestId('reserve-draft-context')).toBeVisible();
 await expect(page.getByTestId('confirm-transfer')).toBeEnabled();
 await page.waitForTimeout(1500);
 expect(writes.some(w=>w.path.endsWith('/submit'))).toBe(false);
 expect(await balanceOf(cfg.recipientAddress)).toBe(B);
 expect((await tasks(page)).length).toBe(tasksBefore.length);
 await page.screenshot({path:testInfo.outputPath('reserve-preview.png'),fullPage:true});

 const submitted=page.waitForResponse(r=>r.url().endsWith('/submit')&&r.request().method()==='POST');
 await page.getByTestId('confirm-transfer').click();
 const submitResponse=await submitted;expect(submitResponse.status()).toBe(202);
 const {taskId}=await submitResponse.json();expect(taskId).toBeTruthy();
 // 202 is not a receipt: follow the original task to its authoritative status.
 await expect.poll(async()=>(await authed(page,`/api/v1/tasks/${taskId}`)).status,{timeout:30_000}).toBe('EXECUTED');
 expect(await balanceOf(cfg.recipientAddress)-B).toBe(MILLI);
 const evidence=await authed(page,`/api/v1/tasks/${taskId}/evidence`);
 expect(evidence.verification).toMatchObject({kind:'chain',chainVerified:true,hashVerified:true});
 expect(evidence.intent.amountWei).toBe('1000000000000000');
 expect(evidence.intent.recipient.toLowerCase()).toBe(cfg.recipientAddress.toLowerCase());
 const executed=evidence.transactions.find((t:any)=>t.event==='NativeTransferExecuted');
 expect(executed).toBeTruthy();
 // Independent receipt check straight from the local RPC.
 const receipt=await rpc('eth_getTransactionReceipt',[executed.hash]);
 expect(receipt.status).toBe('0x1');
 expect(receipt.logs.some((l:any)=>l.address.toLowerCase()===cfg.walletAddress.toLowerCase()&&l.topics[1]?.toLowerCase()===evidence.intent.requestHash.toLowerCase())).toBe(true);
 expect(evidence.outcome.amountWei).toBe('1000000000000000');

 // Refresh: the same task is recovered and no second payment is created.
 const writesBeforeReload=writes.length;
 await page.reload();
 await expect(page.locator(`[data-task-id="${taskId}"]`).first()).toBeVisible();
 await expect(page.getByTestId('reserve-last-task')).toContainText(taskId.slice(-6).toUpperCase());
 await expect(card).toHaveAttribute('data-state','healthy'); // B+0.001 ≥ threshold B+0.0005
 await expect(page.getByTestId('reserve-prepare')).toHaveCount(0);
 await page.waitForTimeout(6000);
 expect(writes.length).toBe(writesBeforeReload);
 const after=await tasks(page);
 expect(after.length).toBe(tasksBefore.length+1);
 expect(after.filter(t=>t.taskId===taskId)).toHaveLength(1);
 expect(await balanceOf(cfg.recipientAddress)-B).toBe(MILLI);
 await page.screenshot({path:testInfo.outputPath('reserve-after-refresh.png'),fullPage:true});
 expect(errors).toEqual([]);
});
