import {test, expect} from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.route('**/api-fixture', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>API regression fixture</title>'}));
  await page.goto('/api-fixture');
});

test('intent deadlines follow the live model budget without extending payment deadlines', async ({page}) => {
  let planner:Record<string,unknown> = {mode:'live',timeoutMs:30_000};
  const config = {mode:'testnet',chainId:11155111,walletAddress:'0x1111111111111111111111111111111111111111',ownerAddress:'0x2222222222222222222222222222222222222222',recipientAddress:'0x3333333333333333333333333333333333333333',agentAddress:'0x4444444444444444444444444444444444444444',readiness:{ready:true,rpcChainId:11155111,contractsDeployed:true,deploymentBindingsVerified:true,feedFresh:true}};
  await page.route('**/api/v1/**', route => route.fulfill({json:route.request().url().endsWith('/config')?{...config,planner}:{ok:true}}));
  const result = await page.evaluate(async (moduleUrl) => {
    const {api} = await import(moduleUrl);
    const observed:number[] = [];
    const original = window.setTimeout.bind(window);
    window.setTimeout = ((handler:TimerHandler, timeout?:number, ...args:unknown[]) => { observed.push(timeout ?? 0); return original(handler,timeout,...args); }) as typeof window.setTimeout;
    await api('/config');
    await api('/intents','POST',{message:'test'});
    await api('/intents/draft-1','PATCH',{message:'test correction'});
    await api('/intents/draft-1/submit','POST',{quoteId:'fixture-only'});
    return observed;
  }, '/src/api.ts');
  expect(result).toEqual([12_000,35_000,35_000,12_000]);
  planner = {mode:'off',timeoutMs:30_000};
  expect(await page.evaluate(async(moduleUrl)=>{
    const {api}=await import(moduleUrl);const observed:number[]=[];const original=window.setTimeout.bind(window);
    window.setTimeout=((handler:TimerHandler, timeout?:number,...args:unknown[])=>{observed.push(timeout??0);return original(handler,timeout,...args)})as typeof window.setTimeout;
    await api('/config');await api('/intents','POST',{message:'rules only'});return observed;
  },'/src/api.ts')).toEqual([12_000,12_000]);
});

test('an elapsed request deadline is reported as a timeout rather than an offline server', async({page})=>{
  const error=await page.evaluate(async(moduleUrl)=>{
    const {api}=await import(moduleUrl);const original=window.setTimeout.bind(window);
    window.setTimeout=((handler:TimerHandler)=>original(handler,0))as typeof window.setTimeout;
    window.fetch=async(_input,init)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
    try{await api('/tasks');return null}catch(error){const value=error as {code:string;message:string};return {code:value.code,message:value.message}}
  },'/src/api.ts');
  expect(error?.code).toBe('REQUEST_TIMEOUT');expect(error?.message).toContain('超时');expect(error?.message).not.toContain('无法连接');
});
