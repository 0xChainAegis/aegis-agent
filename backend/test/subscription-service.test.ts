import test from 'node:test';
import assert from 'node:assert/strict';
import { AegisService, type InternalTask } from '../src/service.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Gateway, Quote } from '../src/chain.js';
import type { SubscriptionConfig } from '@aegis/shared';
const owner='0x1111111111111111111111111111111111111111' as const;
const hash=`0x${'1'.repeat(64)}` as const;
const sub:SubscriptionConfig={subscriptionId:'1',agentAddress:owner,recipient:owner,amountWei:'1000000000000000',periodSeconds:'60',startAtSeconds:'1',endAtSeconds:'3000000000',maxPayments:'3',periodCapUsd6:'4000000',parentPlanHash:hash,paidCount:'0',paused:false,cancelled:false,currentOccurrenceIndex:'0',status:'ACTIVE'};
const quote:Omit<Quote,'quoteId'|'draftId'|'draftVersion'>={status:'READY',chainId:31337,walletAddress:owner,agentAddress:owner,recipient:owner,to:owner,amountWei:sub.amountWei,costUsd6:'3000000',maxUsdCost6:'3030000',policyVersion:'1',requestDeadlineSeconds:3000000000,quoteExpiresAtSeconds:3000000000,requestNonce:null,requestHash:null,reasonCodes:[],decision:'AUTO',budget:{autoThresholdUsd6:'10000000',hardPerTxUsd6:'50000000',dailyLimitUsd6:'100000000',spentTodayUsd6:'0',remainingUsd6:'100000000',window:'UTC_CALENDAR_DAY'},feedAddress:owner,feedDecimals:8,priceAnswer:'300000000000',roundId:'1',updatedAtSeconds:1,observedBlockNumber:'1',observedBlockHash:hash,oracle:{},triggerType:'manual',ruleId:null,actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0',subscription:sub};
function baseGateway():Gateway{return {readiness:async()=>({}),snapshot:async()=>{throw new Error('not used');},preview:async()=>{throw new Error('not used');},prepare:async()=>{throw new Error('not used');},broadcast:async()=>{throw new Error('not used');},outcome:async()=>null,ownerTx:()=>{throw new Error('not used');}};}
function setup(){const store=new Store(':memory:');let prepared=0;const chain:Gateway={...baseGateway(),previewSubscription:async()=>({...quote}),prepare:async()=>{prepared++;throw new Error('should not prepare');}};const service=new AegisService({...loadConfig({}),deploymentReady:false,ownerAddress:owner},store,chain,null);service.subscriptions={get:async()=>sub};return {store,service,prepared:()=>prepared};}
test('subscription intents cannot silently use native preview without subscription manager',async()=>{
 const store=new Store(':memory:');const service=new AegisService({...loadConfig({}),deploymentReady:false,ownerAddress:owner},store,baseGateway(),null);
 await assert.rejects(()=>service.createIntent(owner,{actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0'}),/订阅|subscription/i);store.close();
});
test('fresh subscription draft quote and submit carry an exact mandatory plan commitment',async()=>{
 const {store,service}=setup();const draft=await service.createIntent(owner,{actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0'});const preview=await service.preview(owner,draft.draftId,1);
 assert.throws(()=>service.submit(owner,draft.draftId,1,preview.quoteId),/变化/);
 const task=service.submit(owner,draft.draftId,1,preview.quoteId,preview.planHash);assert.equal(task.planHash,preview.planHash);assert.equal(task.actionKind,'SUBSCRIPTION');store.close();
});
test('changed quote cap is rejected before task creation',async()=>{
 const {store,service}=setup();const draft=await service.createIntent(owner,{actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0'});const q=await service.preview(owner,draft.draftId,1);store.put('quote',q.quoteId,owner,{...q,maxUsdCost6:'9999999'});
 assert.throws(()=>service.submit(owner,draft.draftId,1,q.quoteId,q.planHash),/变化/);assert.equal(store.list('task').length,0);store.close();
});
test('persisted subscription cannot be downgraded to native before broadcast',async()=>{
 const {store,service,prepared}=setup();const draft=await service.createIntent(owner,{actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0'});const q=await service.preview(owner,draft.draftId,1);const task=service.submit(owner,draft.draftId,1,q.quoteId,q.planHash);store.put('task',task.taskId,task.ownerAddress,{...task,actionKind:'NATIVE_TRANSFER'});
 await service.tick();assert.equal(prepared(),0);const saved=store.get<InternalTask>('task',task.taskId);assert.ok(saved);assert.equal(saved.status,'REQUOTE_REQUIRED');store.close();
});
test('changed occurrence in persisted task is blocked before prepare and broadcast',async()=>{
 const {store,service,prepared}=setup();const draft=await service.createIntent(owner,{actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0'});const q=await service.preview(owner,draft.draftId,1);const task=service.submit(owner,draft.draftId,1,q.quoteId,q.planHash);store.put('task',task.taskId,task.ownerAddress,{...task,occurrenceIndex:'1'});
 await service.tick();assert.equal(prepared(),0);const saved=store.get<InternalTask>('task',task.taskId);assert.ok(saved);assert.equal(saved.status,'REQUOTE_REQUIRED');store.close();
});
