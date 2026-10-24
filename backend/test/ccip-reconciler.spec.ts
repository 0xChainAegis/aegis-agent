import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { Gateway } from '../src/chain.js';
import { AegisService, CCIP_RECONCILE_BATCH_SIZE, ccipRetryDelayMs, type InternalTask } from '../src/service.js';
import { Store } from '../src/store.js';

const owner='0x1111111111111111111111111111111111111111' as const;
const sender='0x2222222222222222222222222222222222222222' as const;
const router='0x3333333333333333333333333333333333333333' as const;
const token='0x4444444444444444444444444444444444444444' as const;
const recipient='0x5555555555555555555555555555555555555555' as const;
const destinationToken='0x6666666666666666666666666666666666666666' as const;
const selector='10344971235874465080';
const messageId=`0x${'7'.repeat(64)}` as const;
const sourceHash=`0x${'8'.repeat(64)}` as const;
const destinationHash=`0x${'9'.repeat(64)}` as const;
const amount='1000000000000000000';

const gateway:Gateway={
  readiness:async()=>({}),snapshot:async()=>{throw new Error('not used');},preview:async()=>{throw new Error('not used');},
  prepare:async()=>{throw new Error('not used');},broadcast:async()=>{throw new Error('not used');},outcome:async()=>null,
  ownerTx:()=>{throw new Error('not used');},
};
const config={...loadConfig({AEGIS_MODE:'mock'}),deploymentReady:false,chainId:11155111,ownerAddress:owner,ccipSenderAddress:sender,ccipRouterAddress:router,ccipTokenAddress:token,ccipDestinationChainSelector:selector,ccipDestinationChainId:84532,ccipDestinationNetwork:'base-sepolia',ccipDestinationTokenAddress:destinationToken,ccipTokenPriceSource:'OWNER_MAINTAINED_TESTNET_VALUE' as const};

function task(id:string, idMessage:Hex=messageId):InternalTask {
  const now='2026-10-24T00:00:00.000Z';
  return {
    taskId:id,draftId:`draft-${id}`,intentId:`draft-${id}`,quoteId:`quote-${id}`,draftVersion:1,stateVersion:1,status:'EXECUTED',
    chainId:11155111,walletAddress:sender,ownerAddress:owner,agentAddress:owner,recipient,to:recipient,amountWei:amount,maxUsdCost6:'1000000',previewCostUsd6:'1000000',
    requestDeadlineSeconds:3000000000,policyVersion:'1',requestNonce:'0',requestHash:`0x${'a'.repeat(64)}`,attestationId:'1',txHash:sourceHash,
    triggerType:'manual',ruleId:null,reasonCodes:[],transactions:[{role:'request',hash:sourceHash,receiptStatus:1,finality:'mined'}],availableActions:[],createdAt:now,updatedAt:now,
    parser:{kind:'rule_parser',model:null,configuredModel:null,fallback:false,reason:'TEST'},verification:{kind:'chain',chainVerified:true,hashVerified:true},
    actionKind:'CCIP_TRANSFER',ccipSenderAddress:sender,tokenAddress:token,destinationChainSelector:selector,maxFeeWei:'1000',quotedFeeWei:'900',messageId:idMessage,planHash:`0x${'b'.repeat(64)}`,
  };
}
function payload(status='SENT') {
  return {messageId,sender,receiver:recipient,status,sendTransactionHash:sourceHash,routerAddress:router,receiptTransactionHash:status==='SUCCESS'?destinationHash:null,sourceNetworkInfo:{name:'ethereum-testnet-sepolia',chainSelector:'16015286601757825753',chainId:'11155111',chainFamily:'EVM',environment:'testnet'},destNetworkInfo:{name:'ethereum-testnet-sepolia-base-1',chainSelector:selector,chainId:'84532',chainFamily:'EVM',environment:'testnet'},tokenAmounts:[{sourceTokenAddress:token,destTokenAddress:destinationToken,amount}]};
}
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

describe('automatic CCIP delivery reconciliation',()=>{
  it('does nothing when there are no eligible tasks',async()=>{
    const store=new Store(':memory:');const service=new AegisService(config,store,gateway,null);const fetcher=vi.fn(async()=>response(payload()));
    await expect(service.reconcileCcipDeliveries(fetcher,1000)).resolves.toEqual({eligible:0,due:0,checked:0,terminal:0,failed:0});
    expect(fetcher).not.toHaveBeenCalled();store.close();
  });

  it('persists retry state, resumes after restart, and stores a verified terminal delivery',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'aegis-ccip-reconciler-'));const path=join(directory,'tasks.sqlite');
    try {
      const firstStore=new Store(path);firstStore.put('task','task-1',owner,task('task-1'));
      const first=new AegisService(config,firstStore,gateway,null);const initial=vi.fn(async()=>response(payload()));
      await expect(first.reconcileCcipDeliveries(initial,1000)).resolves.toMatchObject({checked:1,terminal:0,failed:0});
      const waiting=firstStore.get<InternalTask>('task','task-1',owner);expect(waiting?.ccipDeliveryTracking).toMatchObject({attempts:1,nextCheckAt:16000});expect(waiting?.updatedAt).toBe('2026-10-24T00:00:00.000Z');firstStore.close();
      const restartedStore=new Store(path);const restarted=new AegisService(config,restartedStore,gateway,null);const delivered=vi.fn(async()=>response(payload('SUCCESS')));
      await expect(restarted.reconcileCcipDeliveries(delivered,15999)).resolves.toMatchObject({due:0,checked:0});expect(delivered).not.toHaveBeenCalled();
      await expect(restarted.reconcileCcipDeliveries(delivered,16000)).resolves.toMatchObject({checked:1,terminal:1});
      const saved=restartedStore.get<InternalTask>('task','task-1',owner);expect(saved?.ccipDelivery).toMatchObject({state:'DELIVERED',destinationTransactionHash:destinationHash});expect(saved?.ccipDeliveryTracking).toBeUndefined();
      await restarted.reconcileCcipDeliveries(delivered,999999);expect(delivered).toHaveBeenCalledTimes(1);restartedStore.close();
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });

  it('backs off after a temporary external error without changing the business task status',async()=>{
    const store=new Store(':memory:');store.put('task','task-1',owner,task('task-1'));const service=new AegisService(config,store,gateway,null);
    const fetcher:typeof fetch=async()=>{throw new Error('offline');};
    await expect(service.reconcileCcipDeliveries(fetcher,2000)).resolves.toMatchObject({checked:1,terminal:0,failed:1});
    const saved=store.get<InternalTask>('task','task-1',owner);expect(saved?.status).toBe('EXECUTED');expect(saved?.ccipDelivery).toBeUndefined();expect(saved?.ccipDeliveryTracking).toMatchObject({attempts:1,nextCheckAt:17000,lastError:{code:'CCIP_STATUS_UNAVAILABLE'}});store.close();
  });

  it('does not expose private retry metadata in task API output',()=>{
    const store=new Store(':memory:');const service=new AegisService(config,store,gateway,null);const item=task('task-1');item.ccipDeliveryTracking={attempts:2,nextCheckAt:30000,lastCheckedAt:'2026-10-24T00:00:01.000Z',lastError:{code:'CCIP_STATUS_UNAVAILABLE',message:'offline'}};
    expect(service.publicTask(item)).not.toHaveProperty('ccipDeliveryTracking');store.close();
  });

  it('caps exponential delay and checks only the bounded batch',async()=>{
    expect(ccipRetryDelayMs(0)).toBe(15000);expect(ccipRetryDelayMs(1)).toBe(15000);expect(ccipRetryDelayMs(99)).toBe(300000);
    const store=new Store(':memory:');
    for(let index=0;index<3;index+=1){const id=`task-${index}`;const idMessage=`0x${String(index+1).repeat(64)}` as Hex;const item=task(id,idMessage);store.put('task',id,owner,item);}
    const service=new AegisService(config,store,gateway,null);const fetcher=vi.fn(async()=>response({},404));
    await expect(service.reconcileCcipDeliveries(fetcher,3000,99)).resolves.toMatchObject({eligible:3,due:CCIP_RECONCILE_BATCH_SIZE,checked:CCIP_RECONCILE_BATCH_SIZE});expect(fetcher).toHaveBeenCalledTimes(CCIP_RECONCILE_BATCH_SIZE);store.close();
  });
});
