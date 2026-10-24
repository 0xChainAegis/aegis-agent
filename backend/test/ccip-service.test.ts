import test from 'node:test';
import assert from 'node:assert/strict';
import { AegisService, type InternalTask } from '../src/service.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Gateway, Quote } from '../src/chain.js';

const owner='0x1111111111111111111111111111111111111111' as const;
const sender='0x2222222222222222222222222222222222222222' as const;
const router='0x3333333333333333333333333333333333333333' as const;
const token='0x4444444444444444444444444444444444444444' as const;
const feed='0x5555555555555555555555555555555555555555' as const;
const recipient='0x6666666666666666666666666666666666666666' as const;
const destinationToken='0x7777777777777777777777777777777777777777' as const;
const blockHash=`0x${'1'.repeat(64)}` as const;
const selector='10344971235874465080';

const quote:Omit<Quote,'quoteId'|'draftId'|'draftVersion'>={
  actionKind:'CCIP_TRANSFER',ccipSenderAddress:sender,tokenAddress:token,destinationChainSelector:selector,maxFeeWei:'1100',quotedFeeWei:'1000',
  status:'READY',chainId:31337,walletAddress:sender,agentAddress:owner,recipient,to:recipient,amountWei:'1000000000000000000',costUsd6:'1000000',maxUsdCost6:'1010000',policyVersion:'4',requestDeadlineSeconds:3000000000,quoteExpiresAtSeconds:3000000000,requestNonce:null,requestHash:null,decision:'AUTO',reasonCodes:[],
  budget:{autoThresholdUsd6:'5000000',hardPerTxUsd6:'10000000',dailyLimitUsd6:'15000000',spentTodayUsd6:'0',remainingUsd6:'15000000',window:'UTC_CALENDAR_DAY'},
  feedAddress:feed,feedDecimals:8,priceAnswer:'100000000',roundId:'1',updatedAtSeconds:1,observedBlockNumber:'1',observedBlockHash:blockHash,oracle:{},triggerType:'manual',ruleId:null,
};

function baseGateway():Gateway{return {readiness:async()=>({}),snapshot:async()=>{throw new Error('not used');},preview:async()=>{throw new Error('not used');},prepare:async()=>{throw new Error('not used');},broadcast:async()=>{throw new Error('not used');},outcome:async()=>null,ownerTx:()=>{throw new Error('not used');}};}

function setup(){
  const store=new Store(':memory:');let prepared=0;
  const chain:Gateway={...baseGateway(),previewCcip:async()=>({...quote}),prepare:async()=>{prepared+=1;throw new Error('should not prepare');}};
  const config={...loadConfig({AEGIS_MODE:'mock'}),deploymentReady:false,chainId:11155111,ownerAddress:owner,ccipSenderAddress:sender,ccipRouterAddress:router,ccipTokenAddress:token,ccipTokenFeedAddress:feed,ccipDestinationChainSelector:selector,ccipDestinationChainId:84532,ccipDestinationNetwork:'base-sepolia',ccipDestinationTokenAddress:destinationToken,ccipTokenPriceSource:'OWNER_MAINTAINED_TESTNET_VALUE' as const};
  const service=new AegisService(config,store,chain,null);
  return {store,service,prepared:()=>prepared};
}

const validInput={actionKind:'CCIP_TRANSFER' as const,recipient,amountWei:'1000000000000000000',tokenAddress:token,destinationChainSelector:selector,purpose:'local CCIP test'};

test('structured CCIP draft, preview and submit preserve both confirmed caps',async()=>{
  const {store,service}=setup();
  const draft=await service.createIntent(owner,validInput);
  const preview=await service.preview(owner,draft.draftId,1,'1010000','1100');
  assert.equal(preview.actionKind,'CCIP_TRANSFER');assert.equal(preview.maxFeeWei,'1100');assert.ok(preview.planHash);
  assert.throws(()=>service.submit(owner,draft.draftId,1,preview.quoteId),/变化/);
  const task=service.submit(owner,draft.draftId,1,preview.quoteId,preview.planHash);
  assert.equal(task.actionKind,'CCIP_TRANSFER');assert.equal(task.walletAddress,sender);assert.equal(task.maxFeeWei,'1100');
  store.close();
});

test('CCIP rejects empty required fields instead of falling back to native ETH',async()=>{
  const {store,service}=setup();
  await assert.rejects(()=>service.createIntent(owner,{actionKind:'CCIP_TRANSFER',recipient,amountWei:'1'}),/CCIP 需要/);
  assert.equal(store.list('intent').length,0);store.close();
});

test('CCIP rejects a token or destination outside the configured lane',async()=>{
  const {store,service}=setup();
  await assert.rejects(()=>service.createIntent(owner,{...validInput,tokenAddress:owner}),/路线/);
  await assert.rejects(()=>service.createIntent(owner,{...validInput,destinationChainSelector:'1'}),/路线/);
  assert.equal(store.list('intent').length,0);store.close();
});

test('CCIP rejects the zero recipient before storing a draft',async()=>{
  const {store,service}=setup();
  await assert.rejects(()=>service.createIntent(owner,{...validInput,recipient:'0x0000000000000000000000000000000000000000'}),/不能是零地址/);
  assert.equal(store.list('intent').length,0);store.close();
});

test('CCIP rejects natural-language scope rather than silently parsing it as native ETH',async()=>{
  const {store,service}=setup();
  await assert.rejects(()=>service.createIntent(owner,{...validInput,message:'bridge this token'}),/结构化/);
  store.close();
});

test('tampered persisted CCIP fee cap is stopped before signing',async()=>{
  const {store,service,prepared}=setup();
  const draft=await service.createIntent(owner,validInput);const preview=await service.preview(owner,draft.draftId,1);
  const task=service.submit(owner,draft.draftId,1,preview.quoteId,preview.planHash);
  store.put('task',task.taskId,task.ownerAddress,{...task,maxFeeWei:'999'});
  await service.tick();
  assert.equal(prepared(),0);
  const saved=store.get<InternalTask>('task',task.taskId);assert.ok(saved);assert.equal(saved.status,'REQUOTE_REQUIRED');
  store.close();
});

test('verified source execution persists the emitted CCIP message id',async()=>{
  const store=new Store(':memory:');
  const messageId=`0x${'7'.repeat(64)}` as const;
  const txHash=`0x${'8'.repeat(64)}` as const;
  const requestHash=`0x${'9'.repeat(64)}` as const;
  const chain:Gateway={
    ...baseGateway(),previewCcip:async()=>({...quote}),
    prepare:async()=>({rawTransaction:'0x02',hash:txHash,senderNonce:'3',requestNonce:'4',requestHash}),
    outcome:async()=>({
      status:'EXECUTED',transaction:{role:'request',hash:txHash,receiptStatus:1,blockNumber:'5',blockHash,finality:'mined',event:'CCIPTransferExecuted'},
      attestationId:'6',eventData:{messageId},
    }),
  };
  const config={...loadConfig({AEGIS_MODE:'mock'}),deploymentReady:false,ownerAddress:owner,ccipSenderAddress:sender,ccipRouterAddress:router,ccipTokenAddress:token,ccipTokenFeedAddress:feed,ccipDestinationChainSelector:selector};
  const service=new AegisService(config,store,chain,null);
  const draft=await service.createIntent(owner,validInput);const preview=await service.preview(owner,draft.draftId,1);
  const submitted=service.submit(owner,draft.draftId,1,preview.quoteId,preview.planHash);
  await service.tick();
  const completed=service.getTask(owner,submitted.taskId);
  assert.equal(completed.status,'EXECUTED');assert.equal(completed.messageId,messageId);
  store.close();
});

test('terminal CCIP delivery is persisted and reused without another external request',async()=>{
  const {store,service}=setup();
  const draft=await service.createIntent(owner,validInput);const preview=await service.preview(owner,draft.draftId,1);
  const submitted=service.submit(owner,draft.draftId,1,preview.quoteId,preview.planHash);
  const messageId=`0x${'a'.repeat(64)}` as const;
  const sourceHash=`0x${'b'.repeat(64)}` as const;
  const destinationHash=`0x${'c'.repeat(64)}` as const;
  const task=service.getTask(owner,submitted.taskId);
  task.status='EXECUTED';task.messageId=messageId;task.txHash=sourceHash;
  task.transactions=[{role:'request',hash:sourceHash,receiptStatus:1,finality:'mined'}];
  store.put('task',task.taskId,owner,task);
  const payload={messageId,sender,receiver:recipient,status:'SUCCESS',sendTransactionHash:sourceHash,routerAddress:router,receiptTransactionHash:destinationHash,sourceNetworkInfo:{name:'ethereum-testnet-sepolia',chainSelector:'16015286601757825753',chainId:'11155111',chainFamily:'EVM',environment:'testnet'},destNetworkInfo:{name:'ethereum-testnet-sepolia-base-1',chainSelector:selector,chainId:'84532',chainFamily:'EVM',environment:'testnet'},tokenAmounts:[{sourceTokenAddress:token,destTokenAddress:destinationToken,amount:validInput.amountWei}]};
  let requests=0;
  const fetcher:typeof fetch=async()=>{requests+=1;const body=requests===1?{...payload,status:'SENT',receiptTransactionHash:null}:payload;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
  const interim=await service.ccipDelivery(owner,task.taskId,fetcher);
  assert.equal(interim.state,'IN_FLIGHT');assert.equal(service.getTask(owner,task.taskId).ccipDelivery,undefined);assert.equal(requests,1);
  const first=await service.ccipDelivery(owner,task.taskId,fetcher);
  const verifiedAt='verifiedAt' in first?first.verifiedAt:undefined;
  assert.equal(first.state,'DELIVERED');assert.equal(first.destinationTransactionHash,destinationHash);assert.equal(typeof verifiedAt,'string');
  if(typeof verifiedAt!=='string')throw new Error('terminal delivery timestamp was not persisted');
  assert.match(verifiedAt,/^\d{4}-\d{2}-\d{2}T/);assert.equal(requests,2);
  const persisted=service.getTask(owner,task.taskId).ccipDelivery;
  assert.deepEqual(persisted,first);
  const restarted=new AegisService(service.config,store,service.chain,null);
  const neverFetch:typeof fetch=async()=>{throw new Error('terminal evidence must not be fetched again');};
  assert.deepEqual(await restarted.ccipDelivery(owner,task.taskId,neverFetch),first);
  assert.deepEqual(restarted.evidence(owner,task.taskId).ccipDelivery,first);
  assert.equal(requests,2);
  store.close();
});
