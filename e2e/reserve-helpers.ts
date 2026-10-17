import {expect,type Page,type Request} from '@playwright/test';

export const RPC='http://127.0.0.1:8545';
export async function rpc(method:string,params:unknown[]){const response=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const value=await response.json();if(value.error)throw new Error(value.error.message);return value.result;}
export async function balanceOf(address:string){return BigInt(await rpc('eth_getBalance',[address,'latest']));}

/** Exact wei → ETH text, same shape as viem.formatEther (no float). */
export function eth(wei:bigint){const negative=wei<0n;const v=negative?-wei:wei;const whole=v/10n**18n;const fraction=(v%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return `${negative?'-':''}${whole}${fraction?`.${fraction}`:''}`;}

export async function login(page:Page){await page.goto('/');await expect(page.getByTestId('local-wallet')).toBeEnabled();await page.getByTestId('local-wallet').click();await page.getByTestId('confirm-local-wallet').click();await expect(page.getByTestId('intent-message')).toBeEnabled();}
export async function token(page:Page){return await page.evaluate(()=>sessionStorage.getItem('aegis.session'));}
export async function authed(page:Page,path:string){return await page.request.get(path,{headers:{Authorization:`Bearer ${await token(page)}`}}).then(r=>r.json());}
export async function config(page:Page){return await page.request.get('/api/v1/config').then(r=>r.json());}
export async function tasks(page:Page):Promise<Record<string,any>[]>{return (await authed(page,'/api/v1/tasks')).tasks;}

/** Records every payment-relevant write the page makes. */
export function trackWrites(page:Page){const writes:{method:string;path:string;body:any}[]=[];page.on('request',(request:Request)=>{const url=new URL(request.url());if(request.method()!=='GET'&&/\/api\/v1\/(intents|tasks)/.test(url.pathname)){let body:any=null;try{body=request.postDataJSON();}catch{}writes.push({method:request.method(),path:url.pathname,body});}});return writes;}

export async function setReserve(page:Page,threshold:string,target:string){await page.getByTestId('reserve-threshold').fill(threshold);await page.getByTestId('reserve-target').fill(target);}

/** Pause the page's 5-second background poll so a test controls when the UI re-reads data. */
export async function pausePolling(page:Page,paused:boolean){await page.evaluate(value=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>value}),paused);}
