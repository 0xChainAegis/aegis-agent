import test from 'node:test';
import assert from 'node:assert/strict';
import { ViemGateway } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
test('subscription payment gateway refuses missing authoritative config rather than native fallback', async()=>{
 const gateway=new ViemGateway({...loadConfig({}),deploymentReady:false});
 await assert.rejects(()=>gateway.previewSubscription({subscriptionId:'1',occurrenceIndex:'0'}), /deployment|部署|config/i);
});
test('draft metadata cannot overwrite READY quote identity or status',async()=>{
 const gateway=new ViemGateway({...loadConfig({}),deploymentReady:true,mode:'local_chain',chainId:31337});
 gateway.preview=async()=>({status:'READY',quoteId:'authoritative',maxUsdCost6:'3',requestDeadlineSeconds:123,policyVersion:'1',observedBlockNumber:'1'} as any);
 (gateway as any).publicClient={readContract:async()=>[3n,false]};
 const result=await gateway.previewSubscription({status:'DRAFT',quoteId:'tampered',actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0',subscription:{recipient:'0x1111111111111111111111111111111111111111',amountWei:'1'}} as any);
 assert.equal(result.status,'READY');assert.equal((result as any).quoteId,'authoritative');assert.equal(result.decision,'AUTO');
});
