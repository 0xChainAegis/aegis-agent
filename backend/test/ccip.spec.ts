import {describe,expect,it} from 'vitest';
import {AegisService} from '../src/service.js';
import {loadConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import type {Gateway,Quote} from '../src/chain.js';

const owner='0x1111111111111111111111111111111111111111' as const;
const sender='0x2222222222222222222222222222222222222222' as const;
const router='0x3333333333333333333333333333333333333333' as const;
const token='0x4444444444444444444444444444444444444444' as const;
const feed='0x5555555555555555555555555555555555555555' as const;
const recipient='0x6666666666666666666660000000000000000006' as const;
const selector='10344971235874465080';
const observedHash=`0x${'2'.repeat(64)}` as const;
const baseQuote:Omit<Quote,'quoteId'|'draftId'|'draftVersion'>={actionKind:'CCIP_TRANSFER',ccipSenderAddress:sender,tokenAddress:token,destinationChainSelector:selector,maxFeeWei:'110',quotedFeeWei:'100',status:'READY',chainId:31337,walletAddress:sender,agentAddress:owner,recipient,to:recipient,amountWei:'1',costUsd6:'1',maxUsdCost6:'2',policyVersion:'1',requestDeadlineSeconds:3000000000,quoteExpiresAtSeconds:3000000000,requestNonce:null,requestHash:null,decision:'AUTO',reasonCodes:[],budget:{autoThresholdUsd6:'5',hardPerTxUsd6:'10',dailyLimitUsd6:'15',spentTodayUsd6:'0',remainingUsd6:'15',window:'UTC_CALENDAR_DAY'},feedAddress:feed,feedDecimals:8,priceAnswer:'100000000',roundId:'1',updatedAtSeconds:1,observedBlockNumber:'1',observedBlockHash:observedHash,oracle:{},triggerType:'manual',ruleId:null};

function service(quote:Omit<Quote,'quoteId'|'draftId'|'draftVersion'>=baseQuote){
  const store=new Store(':memory:');
  const gateway:Gateway={readiness:async()=>({}),snapshot:async()=>{throw new Error('unused');},preview:async()=>{throw new Error('unused');},previewCcip:async()=>quote,prepare:async()=>{throw new Error('unused');},broadcast:async()=>{throw new Error('unused');},outcome:async()=>null,ownerTx:()=>{throw new Error('unused');}};
  const config={...loadConfig({AEGIS_MODE:'mock'}),deploymentReady:false,ownerAddress:owner,ccipSenderAddress:sender,ccipRouterAddress:router,ccipTokenAddress:token,ccipTokenFeedAddress:feed,ccipDestinationChainSelector:selector};
  return {store,value:new AegisService(config,store,gateway,null)};
}

const input={actionKind:'CCIP_TRANSFER' as const,recipient,amountWei:'1',tokenAddress:token,destinationChainSelector:selector};

describe('CCIP backend flow',()=>{
  it('creates a confirmed structured draft and quote',async()=>{
    const {store,value}=service();
    const draft=await value.createIntent(owner,input);const preview=await value.preview(owner,draft.draftId,1);
    expect(preview.status).toBe('READY');expect(preview.planHash).toMatch(/^0x[0-9a-f]{64}$/);expect(preview.maxFeeWei).toBe('110');store.close();
  });

  it('rejects missing external fields',async()=>{
    const {store,value}=service();
    await expect(value.createIntent(owner,{actionKind:'CCIP_TRANSFER',recipient,amountWei:'1'})).rejects.toMatchObject({code:'CCIP_FIELDS_REQUIRED'});store.close();
  });

  it('rejects an unconfigured route',async()=>{
    const {store,value}=service();
    await expect(value.createIntent(owner,{...input,destinationChainSelector:'1'})).rejects.toMatchObject({code:'CCIP_ROUTE_NOT_CONFIGURED'});store.close();
  });

  it('preserves a fee-cap boundary block from preview',async()=>{
    const {store,value}=service({...baseQuote,status:'BLOCKED',decision:'BLOCK',reasonCodes:['CCIP_FEE_EXCEEDS_MAX'],maxFeeWei:'99'});
    const draft=await value.createIntent(owner,input);const preview=await value.preview(owner,draft.draftId,1,undefined,'99');
    expect(preview.status).toBe('BLOCKED');expect(preview.reasonCodes).toEqual(['CCIP_FEE_EXCEEDS_MAX']);
    expect(()=>value.submit(owner,draft.draftId,1,preview.quoteId,preview.planHash)).toThrow(/阻止/);store.close();
  });
});
