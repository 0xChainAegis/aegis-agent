import {test, expect} from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.route('**/api-fixture', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>API regression fixture</title>'}));
  await page.goto('/api-fixture');
});

test('intent deadlines follow the live model budget without extending payment deadlines', async ({page}) => {
  let planner:Record<string,unknown> = {mode:'live',timeoutMs:30_000};
  const owner = '0x1111111111111111111111111111111111111111';
  const wallet = '0x2222222222222222222222222222222222222222';
  const recipient = '0x3333333333333333333333333333333333333333';
  const agent = '0x4444444444444444444444444444444444444444';
  const config = {mode:'local_chain',chainId:31337,ownerAddress:owner,walletAddress:wallet,recipientAddress:recipient,agentAddress:agent,readiness:{ready:true,rpcChainId:31337,contractsDeployed:true,deploymentBindingsVerified:true,feedFresh:true}};
  const draft = {draftId:'draft-1',status:'READY',revision:1,recipient,amountWei:'1',purpose:'Timeout fixture'};
  const task = {taskId:'task-1',status:'SUBMITTING',chainId:31337,ownerAddress:owner,walletAddress:wallet,recipient,agentAddress:agent,amountWei:'1',maxUsdCost6:'2'};
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/config')) return route.fulfill({json:{...config,planner}});
    if (path.endsWith('/submit')) return route.fulfill({json:task});
    return route.fulfill({json:draft});
  });
  const result = await page.evaluate(async (moduleUrl) => {
    const {api}: typeof import('../frontend/src/api') = await import(moduleUrl);
    const observed:number[] = [];
    const original = window.setTimeout.bind(window);
    window.setTimeout = (handler:TimerHandler, timeout?:number, ...args:unknown[]) => { observed.push(timeout ?? 0); return original(handler,timeout,...args); };
    try {
      await api('/config');
      await api('/intents','POST',{message:'test'});
      await api('/intents/draft-1','PATCH',{message:'test correction',expectedRevision:1});
      await api('/intents/draft-1/submit','POST',{quoteId:'fixture-only',expectedRevision:1});
      return observed;
    } finally { window.setTimeout = original; }
  }, '/src/api.ts');
  expect(result).toEqual([12_000,35_000,35_000,12_000]);
  planner = {mode:'off',timeoutMs:30_000};
  expect(await page.evaluate(async(moduleUrl)=>{
    const {api}: typeof import('../frontend/src/api')=await import(moduleUrl);const observed:number[]=[];const original=window.setTimeout.bind(window);
    window.setTimeout=(handler:TimerHandler, timeout?:number,...args:unknown[])=>{observed.push(timeout??0);return original(handler,timeout,...args)};
    try { await api('/config');await api('/intents','POST',{message:'rules only'});return observed; }
    finally { window.setTimeout=original; }
  },'/src/api.ts')).toEqual([12_000,12_000]);
});

test('an elapsed request deadline is reported as a timeout rather than an offline server', async({page})=>{
  const error=await page.evaluate(async(moduleUrl)=>{
    const {api,ApiError}: typeof import('../frontend/src/api')=await import(moduleUrl);const original=window.setTimeout.bind(window);
    window.setTimeout=(handler:TimerHandler)=>original(handler,0);
    window.fetch=async(_input,init)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
    try{await api('/tasks');return null}catch(error){if(error instanceof ApiError)return {code:error.code,message:error.message};throw error}
    finally { window.setTimeout=original; }
  },'/src/api.ts');
  expect(error?.code).toBe('REQUEST_TIMEOUT');expect(error?.message).toContain('超时');expect(error?.message).not.toContain('无法连接');
});
