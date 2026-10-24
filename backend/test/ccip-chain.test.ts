import test from 'node:test';
import assert from 'node:assert/strict';
import { ViemGateway, type Snapshot } from '../src/chain.js';
import { LOCAL_AGENT_KEY, loadConfig } from '../src/config.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { Intent, Task } from '@aegis/shared';

const owner='0x1111111111111111111111111111111111111111' as const;
const sender='0x2222222222222222222222222222222222222222' as const;
const router='0x3333333333333333333333333333333333333333' as const;
const token='0x4444444444444444444444444444444444444444' as const;
const feed='0x5555555555555555555555555555555555555555' as const;
const recipient='0x6666666666666666666666666666666666666666' as const;
const blockHash=`0x${'1'.repeat(64)}` as const;
const selector='10344971235874465080';
const intent:Intent={draftId:'draft',intentId:'draft',version:1,revision:1,status:'DRAFT',message:'',recipient,to:recipient,amountWei:'1000000000000000000',purpose:'test',missingFields:[],question:null,parser:{kind:'rule_parser',model:null,configuredModel:null,fallback:false,reason:'STRUCTURED_CCIP'},createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z',actionKind:'CCIP_TRANSFER',ccipSenderAddress:sender,tokenAddress:token,destinationChainSelector:selector};

function gateway(mode:'local_chain'|'testnet'='local_chain'){
  const chainId=mode==='testnet'?11155111:31337;
  const config={...loadConfig({}),mode,chainId,deploymentReady:true,ownerAddress:owner,walletAddress:owner,oracleAddress:owner,policyEngineAddress:owner,attestationAddress:owner,ccipSenderAddress:sender,ccipRouterAddress:router,ccipTokenAddress:token,ccipTokenFeedAddress:feed,ccipDestinationChainSelector:selector};
  const instance=new ViemGateway(config);
  const snapshot:Snapshot={chainId,walletAddress:owner,ownerAddress:owner,agentAddress:config.agentAddress,recipientAddress:recipient,walletBalanceWei:'1000000000000000000',agentBalanceWei:'1000000000000000000',recipientBalanceWei:'0',policyVersion:'4',budget:{autoThresholdUsd6:'5000000',hardPerTxUsd6:'10000000',dailyLimitUsd6:'15000000',spentTodayUsd6:'0',remainingUsd6:'15000000',window:'UTC_CALENDAR_DAY'},observedBlockNumber:'10',observedBlockHash:blockHash,observedBlockTimestamp:'2000',observedAt:'2026-10-23T00:00:00.000Z',dataSource:'chain'};
  instance.snapshot=async()=>snapshot;
  Object.assign(instance.publicClient,{
    getChainId:async()=>chainId,
    readContract:async(request:{functionName?:string})=>{
      if(request.functionName==='latestQuote') return [1_000_000n,1n,100_000_000n,1_999n,8] as const;
      if(request.functionName==='quoteCrossChainFee') return 100n;
      if(request.functionName==='maxPriceAge') return 3_600n;
      if(request.functionName==='previewCrossChainTransfer') return {costUsd6:1_000_000n,feeWei:100n,roundId:1n,updatedAt:1_999n,requiresApproval:false};
      throw new Error(`unexpected read ${request.functionName??'unknown'}`);
    },
  });
  return instance;
}

test('CCIP preview returns token valuation and a bounded native fee quote',async()=>{
  const result=await gateway().previewCcip(intent);
  assert.equal(result.status,'READY');assert.equal(result.costUsd6,'1000000');assert.equal(result.quotedFeeWei,'100');assert.equal(result.maxFeeWei,'110');assert.equal(result.feedAddress,feed);assert.equal(result.walletAddress,sender);
});

test('CCIP preview blocks when the current router fee exceeds the confirmed cap',async()=>{
  const result=await gateway().previewCcip(intent,undefined,'99');
  assert.equal(result.status,'BLOCKED');assert.deepEqual(result.reasonCodes,['CCIP_FEE_EXCEEDS_MAX']);
});

test('CCIP preview uses the configured public testnet lane instead of requiring chain 31337',async()=>{
  const result=await gateway('testnet').previewCcip(intent);
  assert.equal(result.status,'READY');assert.equal(result.chainId,11155111);assert.equal(result.destinationChainSelector,selector);
});

test('CCIP preview rejects a mismatched token and an incomplete deployment',async()=>{
  await assert.rejects(()=>gateway().previewCcip({...intent,tokenAddress:owner}),/路线/);
  const incomplete=new ViemGateway({
    ...loadConfig({}),
    deploymentReady:false,
    ccipSenderAddress:undefined,
    ccipRouterAddress:undefined,
    ccipTokenAddress:undefined,
    ccipTokenFeedAddress:undefined,
    ccipDestinationChainSelector:undefined,
  });
  await assert.rejects(()=>incomplete.previewCcip(intent),/CCIP 路线配置/);
});

test('CCIP transaction preparation reads the sender nonce, not the native wallet nonce',async()=>{
  const agent=privateKeyToAccount(LOCAL_AGENT_KEY).address;
  const instance=gateway();
  instance.config.agentAddress=agent;
  const nonceReads:string[]=[];
  Object.assign(instance.publicClient,{
    getChainId:async()=>31337,
    readContract:async(request:{address:string;functionName?:string})=>{
      if(request.functionName==='nextNonce'){nonceReads.push(request.address);return 7n;}
      if(request.functionName==='hashRequest') return `0x${'0'.repeat(64)}`;
      throw new Error(`unexpected read ${request.functionName??'unknown'}`);
    },
    simulateContract:async()=>({}),
  });
  const task:Task={
    taskId:'task',draftId:'draft',intentId:'draft',draftVersion:1,stateVersion:1,status:'SUBMITTING',chainId:31337,
    walletAddress:sender,ownerAddress:owner,agentAddress:agent,recipient,to:recipient,amountWei:'1',maxUsdCost6:'2',previewCostUsd6:'1',
    requestDeadlineSeconds:3000000000,policyVersion:'1',requestNonce:null,requestHash:null,attestationId:null,txHash:null,
    triggerType:'manual',ruleId:null,reasonCodes:[],transactions:[],availableActions:[],createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z',
    parser:{kind:'rule_parser',model:null,configuredModel:null,fallback:false,reason:'STRUCTURED_CCIP'},verification:{kind:'chain',chainVerified:false,hashVerified:false},
    actionKind:'CCIP_TRANSFER',ccipSenderAddress:sender,tokenAddress:token,destinationChainSelector:selector,maxFeeWei:'110',quotedFeeWei:'100',
  };
  await assert.rejects(()=>instance.prepare(task),/CCIP 请求 hash 不一致/);
  assert.deepEqual(nonceReads,[sender]);
});
