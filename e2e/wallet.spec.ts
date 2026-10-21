import {test,expect,type Page} from '@playwright/test';

async function rpc(method:string,params:unknown[]){const response=await fetch('http://127.0.0.1:8545',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const value=await response.json();if(value.error)throw new Error(value.error.message);return value.result;}
async function login(page:Page){await page.goto('/');await expect(page.getByTestId('local-wallet')).toBeEnabled();await page.getByTestId('local-wallet').click();await page.getByTestId('confirm-local-wallet').click();await expect(page.getByTestId('intent-message')).toBeEnabled();}
async function token(page:Page){return await page.evaluate(()=>sessionStorage.getItem('aegis.session'));}
async function task(page:Page,id:string){return await page.request.get(`/api/v1/tasks/${id}`,{headers:{Authorization:`Bearer ${await token(page)}`}}).then(r=>r.json());}
async function preview(page:Page,recipient:string,amount:string){await page.getByTestId('intent-message').fill(`向 ${recipient} 转 ${amount} ETH`);const ready=page.waitForResponse(r=>r.url().endsWith('/preview')&&r.request().method()==='POST');await page.getByTestId('send-intent').click();return await (await ready).json();}
async function submit(page:Page){const submitted=page.waitForResponse(r=>r.url().endsWith('/submit')&&r.request().method()==='POST');await page.getByTestId('confirm-transfer').click();return await (await submitted).json();}
async function close(page:Page){await page.getByRole('button',{name:'关闭详情',exact:true}).click();}

test('real local chain: auto payment, owner approval, cancel, hard block, evidence and refresh',async({page},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await login(page);const config=await page.request.get('/api/v1/config').then(r=>r.json());
 expect(config.mode).toBe('local_chain');expect(config.chainId).toBe(31337);expect(config.planner.llmEnabled).toBe(false);
 const before=BigInt(await rpc('eth_getBalance',[config.recipientAddress,'latest']));
 const autoPreview=await preview(page,config.recipientAddress,'0.001');expect(autoPreview.costUsd6).toBe('3000000');expect(autoPreview.decision).toBe('AUTO');
 const auto=await submit(page);expect(auto.taskId).toBeTruthy();
 await expect.poll(async()=>(await task(page,auto.taskId)).status).toBe('EXECUTED');
 expect(BigInt(await rpc('eth_getBalance',[config.recipientAddress,'latest']))-before).toBe(1_000_000_000_000_000n);
 const evidence=await page.request.get(`/api/v1/tasks/${auto.taskId}/evidence`,{headers:{Authorization:`Bearer ${await token(page)}`}}).then(r=>r.json());
 expect(evidence.verification.chainVerified).toBe(true);expect(evidence.verification.hashVerified).toBe(true);
 expect(evidence.policy).toMatchObject({engineAddress:config.policyEngineAddress,event:'BudgetConsumed',actionType:'NATIVE_TRANSFER',decision:'ALLOW',costUsd6:'3000000',verified:true,consumed:true,state:'VERIFIED'});
 expect(evidence.policy.requestHash.toLowerCase()).toBe(evidence.intent.requestHash.toLowerCase());
 expect(evidence.configuredPriceSource).toMatchObject({verified:false,scope:'CURRENT_CONFIGURATION'});
 expect(evidence.configuredPriceSource.oracleAddress.toLowerCase()).toBe(config.oracleAddress.toLowerCase());expect(evidence.configuredPriceSource.feedAddress.toLowerCase()).toBe(config.feedAddress.toLowerCase());
 expect(evidence.policy).not.toHaveProperty('oracleAddress');expect(evidence.policy).not.toHaveProperty('feedAddress');expect(evidence.policy.roundId).toBeTruthy();
 await close(page);
 const approvalPreview=await preview(page,config.recipientAddress,'0.002');expect(approvalPreview.decision).toBe('OWNER_APPROVAL');
 const queued=await submit(page);await expect.poll(async()=>(await task(page,queued.taskId)).status).toBe('AWAITING_APPROVAL');
 expect(BigInt(await rpc('eth_getBalance',[config.recipientAddress,'latest']))-before).toBe(1_000_000_000_000_000n);
 await expect(page.getByTestId('approve-task')).toBeVisible();await page.getByTestId('approve-task').click();
 await expect(page.getByTestId('sign-owner-transaction')).toBeEnabled();await page.getByTestId('sign-owner-transaction').click();
 await expect.poll(async()=>(await task(page,queued.taskId)).status).toBe('EXECUTED');
 expect(BigInt(await rpc('eth_getBalance',[config.recipientAddress,'latest']))-before).toBe(3_000_000_000_000_000n);
 const approvedEvidence=await page.request.get(`/api/v1/tasks/${queued.taskId}/evidence`,{headers:{Authorization:`Bearer ${await token(page)}`}}).then(r=>r.json());
 expect(approvedEvidence.policy).toMatchObject({decision:'REQUIRE_APPROVAL',verified:true,consumed:true,state:'VERIFIED'});
 await close(page);
 await preview(page,config.recipientAddress,'0.002');const cancelled=await submit(page);await expect.poll(async()=>(await task(page,cancelled.taskId)).status).toBe('AWAITING_APPROVAL');
 await expect(page.getByTestId('cancel-task')).toBeVisible();await page.getByTestId('cancel-task').click();await page.getByTestId('sign-owner-transaction').click();
 await expect.poll(async()=>(await task(page,cancelled.taskId)).status).toBe('CANCELLED');
 const cancelledEvidence=await page.request.get(`/api/v1/tasks/${cancelled.taskId}/evidence`,{headers:{Authorization:`Bearer ${await token(page)}`}}).then(r=>r.json());
 expect(cancelledEvidence.policy).toMatchObject({consumed:false,verified:false,state:'NOT_CONSUMED'});
 await close(page);
 const blocked=await preview(page,config.recipientAddress,'0.004');expect(blocked.status).toBe('BLOCKED');await expect(page.getByTestId('confirm-transfer')).toBeDisabled();
 expect(BigInt(await rpc('eth_getBalance',[config.recipientAddress,'latest']))-before).toBe(3_000_000_000_000_000n);
 await close(page);await page.reload();await expect(page.locator(`[data-task-id="${queued.taskId}"]`).first()).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('wallet-desktop.png'),fullPage:true});
 await page.locator('[data-nav="settings"]').first().click();await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('wallet-mobile.png'),fullPage:true});
 expect(errors).toEqual([]);
});

test('missing recipient needs user input and offline never fabricates success',async({page})=>{
 await login(page);await page.getByTestId('intent-message').fill('转 0.001 ETH');await page.getByTestId('send-intent').click();
 await expect(page.getByTestId('recipient-input')).toBeVisible();await expect(page.getByTestId('recipient-input')).toHaveValue('');
 await page.route('**/api/v1/**',route=>route.abort());await page.locator('[data-action="refresh"]').first().click();
 await expect(page.getByTestId('send-intent')).toBeDisabled();await expect(page.getByTestId('service-banner').getByText('API 离线',{exact:true})).toBeVisible();
});
