import { encodeFunctionData, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { ccipDeliverySchema, ccipFormSchema, ccipTaskBindingSchema, ccipTaskDisplayState, validateOwnerTransaction } from './ccip';

const abi = parseAbi(['function approveAndExecute(uint64 attestationId)', 'function cancelPending(uint64 attestationId)']);
const owner='0x1111111111111111111111111111111111111111';
const sender='0x2222222222222222222222222222222222222222';
const recipient='0x3333333333333333333333333333333333333333';
const token='0x4444444444444444444444444444444444444444';
const destinationToken='0x5555555555555555555555555555555555555555';
const wallet='0x6666666666666666666666666666666666666666';
const config={chainId:31337,ownerAddress:owner,walletAddress:wallet,ccipSenderAddress:sender,ccipTokenAddress:token,ccipDestinationChainSelector:'99',capabilities:{ccip:true}};
const task={actionKind:'CCIP_TRANSFER',taskId:'task',status:'EXECUTED',chainId:31337,walletAddress:sender,requestHash:`0x${'ab'.repeat(32)}`,attestationId:'7',recipient,amountWei:'1000000000000',maxUsdCost6:'2',tokenAddress:token,ccipSenderAddress:sender,destinationChainSelector:'99',maxFeeWei:'100',quotedFeeWei:'90',planHash:`0x${'ef'.repeat(32)}`};
const tx={from:owner,to:sender,data:encodeFunctionData({abi,functionName:'approveAndExecute',args:[7n]}),value:'0',chainId:31337,action:'approve',chainBindingVerified:true,taskId:'task',requestHash:task.requestHash,attestationId:'7',recipient,amountWei:task.amountWei,maxUsdCost6:'2',tokenAddress:token,destinationChainSelector:'99',maxFeeWei:'100'};

describe('CCIP browser boundaries',()=>{
  it('parses a positive 18-decimal token amount and rejects empty, zero, malformed and overflow input',()=>{
    expect(ccipFormSchema.parse({recipient,amount:'0.000001',purpose:''}).amountWei).toBe('1000000000000');
    for(const value of ['', '0', '-1', '1.0000000000000000001', 'abc']) expect(ccipFormSchema.safeParse({recipient,amount:value,purpose:''}).success).toBe(false);
    expect(ccipFormSchema.safeParse({recipient:'0x12',amount:'1',purpose:''}).success).toBe(false);
    expect(ccipFormSchema.safeParse({recipient:'0x0000000000000000000000000000000000000000',amount:'1',purpose:''}).success).toBe(false);
  });
  it('accepts an exact CCIP Owner approval and rejects target, token, selector, fee and calldata changes',()=>{
    expect(validateOwnerTransaction(config,task,tx,'approve')).toMatchObject({to:sender,attestationId:'7'});
    for(const patch of [{to:recipient},{tokenAddress:recipient},{destinationChainSelector:'100'},{maxFeeWei:'101'},{data:encodeFunctionData({abi,functionName:'cancelPending',args:[7n]})}]) expect(()=>validateOwnerTransaction(config,task,{...tx,...patch},'approve')).toThrow();
  });
  it('keeps native Owner approval valid when CCIP is not configured',()=>{
    const nativeTask={taskId:'native',chainId:31337,walletAddress:wallet,requestHash:`0x${'cd'.repeat(32)}`,attestationId:'8',recipient,amountWei:'1',maxUsdCost6:'2'};
    const nativeTx={from:owner,to:wallet,data:encodeFunctionData({abi,functionName:'approveAndExecute',args:[8n]}),value:'0',chainId:31337,action:'approve',chainBindingVerified:true,taskId:'native',requestHash:nativeTask.requestHash,attestationId:'8',recipient,amountWei:'1',maxUsdCost6:'2'};
    expect(validateOwnerTransaction({chainId:31337,ownerAddress:owner,walletAddress:wallet},nativeTask,nativeTx,'approve')).toMatchObject({to:wallet});
    expect(()=>validateOwnerTransaction({chainId:31337,ownerAddress:owner,walletAddress:wallet},{...nativeTask,walletAddress:sender},nativeTx,'approve')).toThrow();
  });
  it('requires a destination receipt for delivered status and validates all external delivery fields',()=>{
    const delivery={state:'DELIVERED',messageId:`0x${'11'.repeat(32)}`,apiStatus:'SUCCESS',sourceTransactionHash:`0x${'22'.repeat(32)}`,destinationTransactionHash:`0x${'33'.repeat(32)}`,sourceChainId:11155111,destinationChainId:84532,destinationChainSelector:'99',sourceTokenAddress:token,destinationTokenAddress:destinationToken,amount:'1',explorerUrl:`https://ccip.chain.link/#/side-drawer/msg/0x${'11'.repeat(32)}`,verifiedAt:'2026-10-24T01:02:03.000Z'};
    expect(ccipDeliverySchema.parse(delivery).state).toBe('DELIVERED');
    expect(ccipDeliverySchema.safeParse({...delivery,destinationTransactionHash:null}).success).toBe(false);
    expect(ccipDeliverySchema.safeParse({...delivery,explorerUrl:'javascript:alert(1)'}).success).toBe(false);
  });
  it('keeps source-confirmed CCIP work active until a validated terminal delivery exists',()=>{
    expect(ccipTaskDisplayState(task)).toEqual({column:'ready',label:'源链已确认 · 等待目标链'});
    expect(ccipTaskDisplayState({...task,ccipDelivery:{state:'DELIVERED',messageId:`0x${'11'.repeat(32)}`,apiStatus:'SUCCESS',sourceTransactionHash:`0x${'22'.repeat(32)}`,destinationTransactionHash:`0x${'33'.repeat(32)}`,sourceChainId:11155111,destinationChainId:84532,destinationChainSelector:'99',sourceTokenAddress:token,destinationTokenAddress:destinationToken,amount:'1',explorerUrl:`https://ccip.chain.link/#/side-drawer/msg/0x${'11'.repeat(32)}`,verifiedAt:'2026-10-24T01:02:03.000Z'}})).toEqual({column:'done',label:'目标链已到账'});
  });
  it('shows a persisted delivery failure as blocked and rejects terminal evidence without verification time',()=>{
    const failed={state:'FAILED',messageId:`0x${'11'.repeat(32)}`,apiStatus:'FAILED',sourceTransactionHash:`0x${'22'.repeat(32)}`,destinationTransactionHash:null,sourceChainId:11155111,destinationChainId:84532,destinationChainSelector:'99',sourceTokenAddress:token,destinationTokenAddress:destinationToken,amount:'1',explorerUrl:`https://ccip.chain.link/#/side-drawer/msg/0x${'11'.repeat(32)}`,verifiedAt:'2026-10-24T01:02:03.000Z'};
    expect(ccipTaskDisplayState({...task,ccipDelivery:failed})).toEqual({column:'blocked',label:'跨链交付失败'});
    expect(ccipTaskBindingSchema.safeParse({...task,ccipDelivery:{...failed,verifiedAt:undefined}}).success).toBe(false);
  });
  it('does not apply CCIP labels to empty, malformed, or ordinary payment tasks',()=>{
    expect(ccipTaskDisplayState(null)).toBeNull();
    expect(ccipTaskDisplayState({})).toBeNull();
    expect(ccipTaskDisplayState({...task,actionKind:'NATIVE_TRANSFER'})).toBeNull();
  });
});
