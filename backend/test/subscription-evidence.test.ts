import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters,encodeEventTopics,encodeFunctionData,parseAbiParameters,type Address,type Hex} from 'viem';
import type {Task} from '@aegis/shared';
import {ViemGateway,walletAbi,policyEngineAbi} from '../src/chain.js';
import {loadConfig} from '../src/config.js';
const address='0x1111111111111111111111111111111111111111' as const;
const engine='0x2222222222222222222222222222222222222222' as const;
const hash=`0x${'1'.repeat(64)}` as Hex;
function harness(change:{index?:bigint;actionType?:number;missingBudget?:boolean;plan?:Hex}={}){
 const task:Task={taskId:'task',draftId:'draft',intentId:'draft',draftVersion:1,stateVersion:1,status:'BROADCAST',chainId:31337,walletAddress:address,ownerAddress:address,agentAddress:address,recipient:address,to:address,amountWei:'1',maxUsdCost6:'3',previewCostUsd6:'3',requestDeadlineSeconds:2000000000,policyVersion:'1',requestNonce:'0',requestHash:hash,attestationId:null,txHash:hash,triggerType:'manual',ruleId:null,reasonCodes:[],transactions:[],availableActions:[],createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',parser:{kind:'rule_parser',model:null,configuredModel:null,fallback:false,reason:'TEST'},verification:{kind:'chain',chainVerified:false,hashVerified:false},actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0',planHash:hash};
 const gateway=new ViemGateway({...loadConfig({}),mode:'local_chain',chainId:31337,deploymentReady:true,walletAddress:address,agentAddress:address,policyEngineAddress:engine});
 const logs=[{address:address as Address,topics:encodeEventTopics({abi:walletAbi,eventName:'SubscriptionPaymentExecuted',args:{requestHash:hash,attestationId:1n,agent:address}}),data:encodeAbiParameters(parseAbiParameters('address,uint256,uint256,uint80,uint256,uint64,uint64,uint64,bytes32'),[address,1n,3n,1n,1999999999n,1n,1n,change.index??0n,change.plan??hash])}];
 if(!change.missingBudget)logs.push({address:engine,topics:encodeEventTopics({abi:policyEngineAbi,eventName:'BudgetConsumed',args:{requestHash:hash,actionType:change.actionType??1,actor:address}}),data:encodeAbiParameters(parseAbiParameters('uint8,uint256,uint256,uint256'),[1,3n,20000n,3n])});
 Object.assign(gateway.publicClient, {
  getChainId: async () => 31337,
  getTransactionReceipt: async () => ({status:'success',blockNumber:1n,blockHash:hash,logs}),
  getTransaction: async () => ({from:address,to:address,input:encodeFunctionData({abi:walletAbi,functionName:'requestSubscriptionPayment',args:[1n,0n,3n,0n,2000000000n,1n,hash]}),value:0n,nonce:1}),
 });
 return {gateway,task};
}
test('subscription receipt requires matching wallet context AND kind=1 shared budget event',async()=>{
 const {gateway,task}=harness();const outcome=await gateway.outcome(task,hash,'request');assert.equal(outcome?.status,'EXECUTED');assert.equal(outcome?.policyEvidence?.actionType,'SUBSCRIPTION');assert.equal(outcome?.eventData?.planHash,hash);
});
for(const [name,change] of Object.entries({wrongOccurrence:{index:1n},wrongPlan:{plan:`0x${'2'.repeat(64)}` as Hex},nativeBudget:{actionType:0},missingBudget:{missingBudget:true}}))test(`subscription evidence rejects ${name}`,async()=>{const {gateway,task}=harness(change);assert.equal((await gateway.outcome(task,hash,'request'))?.status,'FAILED');});
