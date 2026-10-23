import test from 'node:test';
import assert from 'node:assert/strict';
import { ViemGateway, type Quote } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import type { SubscriptionAction, SubscriptionConfig } from '@aegis/shared';
const address='0x1111111111111111111111111111111111111111' as const;
const hash=`0x${'1'.repeat(64)}` as const;
const subscription:SubscriptionConfig={subscriptionId:'1',agentAddress:address,recipient:address,amountWei:'1',periodSeconds:'60',startAtSeconds:'1',endAtSeconds:'3000000000',maxPayments:'3',periodCapUsd6:'4',parentPlanHash:hash,paidCount:'0',paused:false,cancelled:false,currentOccurrenceIndex:'0',status:'ACTIVE'};
const previewQuote:Omit<Quote,'quoteId'|'draftId'|'draftVersion'>={status:'READY',chainId:31337,walletAddress:address,agentAddress:address,recipient:address,to:address,amountWei:'1',costUsd6:'3',maxUsdCost6:'3',policyVersion:'1',requestDeadlineSeconds:123,quoteExpiresAtSeconds:456,requestNonce:null,requestHash:null,decision:'AUTO',reasonCodes:[],budget:{autoThresholdUsd6:'10',hardPerTxUsd6:'20',dailyLimitUsd6:'30',spentTodayUsd6:'0',remainingUsd6:'30',window:'UTC_CALENDAR_DAY'},feedAddress:address,feedDecimals:8,priceAnswer:'300000000000',roundId:'1',updatedAtSeconds:1,observedBlockNumber:'1',observedBlockHash:hash,oracle:{},triggerType:'manual',ruleId:null};
test('subscription payment gateway refuses missing authoritative config rather than native fallback', async()=>{
 const gateway=new ViemGateway({...loadConfig({}),deploymentReady:false});
 await assert.rejects(()=>gateway.previewSubscription({subscriptionId:'1',occurrenceIndex:'0'}), /deployment|部署|config/i);
});
test('draft metadata cannot overwrite READY quote identity or status',async()=>{
 const gateway=new ViemGateway({...loadConfig({}),deploymentReady:true,mode:'local_chain',chainId:31337});
 gateway.preview=async()=>previewQuote;
 Object.assign(gateway.publicClient,{readContract:async()=>[3n,false] as const});
 const action:SubscriptionAction={actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0',subscription};
 const result=await gateway.previewSubscription(action);
 assert.equal(result.status,'READY');assert.equal(result.observedBlockNumber,'1');assert.equal(result.decision,'AUTO');
});
