import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationSchema, SubscriptionManager } from '../src/subscriptions.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
const input={recipient:'0x1111111111111111111111111111111111111111',amountWei:'1000000000000000',periodSeconds:'60',startAtSeconds:'2000000000',endAtSeconds:'2000000180',maxPayments:'3',periodCapUsd6:'4000000'};
test('registration requires finite duration/count and rejects authority fields',()=>{
 assert.equal(registrationSchema.safeParse(input).success,true);
 for(const change of [{endAtSeconds:undefined},{maxPayments:'0'},{periodSeconds:'0'},{ownerApproved:true},{agentAddress:input.recipient}]) assert.equal(registrationSchema.safeParse({...input,...change}).success,false);
});
test('subscription manager refuses nonlocal mode before RPC',async()=>{
 const store=new Store(':memory:');const manager=new SubscriptionManager({...loadConfig({}),mode:'mock'},store,{} as any);
 await assert.rejects(()=>manager.preview(input.recipient as any,input),/本地|local/i);store.close();
});

test('registration observation rejects a transaction from a different sender before storing subscription',async()=>{
 const store=new Store(':memory:');const owner=input.recipient as `0x${string}`;const transaction={to:owner,from:owner,data:'0x1234',value:'0',chainId:31337};store.put('subscription-registration','registration',owner,{registrationId:'registration',transaction});
 const manager=new SubscriptionManager({...loadConfig({}),mode:'local_chain',chainId:31337,deploymentReady:true,ownerAddress:owner},store,{publicClient:{getChainId:async()=>31337,getTransactionReceipt:async()=>({status:'success',logs:[]}),getTransaction:async()=>({from:'0x2222222222222222222222222222222222222222',to:owner,value:0n,input:'0x1234'})}} as any);
 await assert.rejects(()=>manager.observed(owner,'registration',`0x${'1'.repeat(64)}`),/不一致/);assert.equal(store.list('subscription').length,0);store.close();
});
test('unconfirmed registration never appears as an active subscription',async()=>{
 const store=new Store(':memory:');const owner=input.recipient as `0x${string}`;store.put('subscription-registration','registration',owner,{transaction:{to:owner,data:'0x1234'}});
 const manager=new SubscriptionManager({...loadConfig({}),mode:'local_chain',chainId:31337,deploymentReady:true,ownerAddress:owner},store,{publicClient:{getChainId:async()=>31337,getTransactionReceipt:async()=>{throw new Error('Transaction receipt could not be found');}}} as any);
 await assert.rejects(()=>manager.observed(owner,'registration',`0x${'1'.repeat(64)}`),/尚未确认/);assert.equal(store.list('subscription').length,0);store.close();
});
