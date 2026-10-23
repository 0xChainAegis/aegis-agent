import test from 'node:test';
import assert from 'node:assert/strict';
import {ViemGateway} from '../src/chain.js';
import {loadConfig} from '../src/config.js';
import type {Task} from '@aegis/shared';
const address='0x1111111111111111111111111111111111111111' as const;
const hash=`0x${'1'.repeat(64)}` as const;
test('Owner preflight binds subscription metadata as well as generic pending payment',async()=>{
 const task:Task={taskId:'task',draftId:'draft',intentId:'draft',draftVersion:1,stateVersion:1,status:'AWAITING_APPROVAL',chainId:31337,walletAddress:address,ownerAddress:address,agentAddress:address,recipient:address,to:address,amountWei:'1',maxUsdCost6:'3',previewCostUsd6:'3',requestDeadlineSeconds:2000000000,policyVersion:'1',requestNonce:'0',requestHash:hash,attestationId:'1',txHash:hash,triggerType:'manual',ruleId:null,reasonCodes:[],transactions:[],availableActions:[],createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',parser:{kind:'rule_parser',model:null,configuredModel:null,fallback:false,reason:'TEST'},verification:{kind:'chain',chainVerified:false,hashVerified:false},actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0',planHash:hash};
 const gateway=new ViemGateway({...loadConfig({}),mode:'local_chain',chainId:31337,deploymentReady:true,walletAddress:address,ownerAddress:address});
 let simulations=0;Object.assign(gateway.publicClient,{getChainId:async()=>31337,readContract:async({functionName}:{functionName:string})=>functionName==='pending'?[address,address,1n,3n,0n,2000000000n,1n,hash,true]:[2n,0n,hash],simulateContract:async()=>{simulations++;}});
 await assert.rejects(()=>gateway.preflightOwner(task,'approve'),/订阅|subscription/i);assert.equal(simulations,0);
});
