import { describe, expect, it, vi } from 'vitest';
import { checkCcipDelivery } from '../src/ccip-delivery.js';
import { loadConfig } from '../src/config.js';

const sender='0x1111111111111111111111111111111111111111' as const;
const recipient='0x2222222222222222222222222222222222222222' as const;
const messageId=`0x${'3'.repeat(64)}` as const;
const sourceHash=`0x${'4'.repeat(64)}` as const;
const destinationHash=`0x${'5'.repeat(64)}` as const;
const selector='10344971235874465080';
const sourceToken='0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05' as const;
const destinationToken='0x88A2d74F47a237a62e7A51cdDa67270CE381555e' as const;
const router='0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59' as const;
const amount='1000000000000';
const config={...loadConfig({AEGIS_MODE:'mock'}),mode:'testnet' as const,chainId:11155111,ccipSenderAddress:sender,ccipRouterAddress:router,ccipTokenAddress:sourceToken,ccipDestinationChainId:84532,ccipDestinationChainSelector:selector,ccipDestinationTokenAddress:destinationToken};
const task={actionKind:'CCIP_TRANSFER' as const,messageId,txHash:sourceHash,recipient,tokenAddress:sourceToken,amountWei:amount,destinationChainSelector:selector,transactions:[{hash:sourceHash,role:'request' as const,finality:'mined' as const}]};
const payload={messageId,sender,receiver:recipient,status:'SUCCESS',sendTransactionHash:sourceHash,routerAddress:router,receiptTransactionHash:destinationHash,sourceNetworkInfo:{name:'ethereum-testnet-sepolia',chainSelector:'16015286601757825753',chainId:'11155111',chainFamily:'EVM',environment:'testnet'},destNetworkInfo:{name:'ethereum-testnet-sepolia-base-1',chainSelector:selector,chainId:'84532',chainFamily:'EVM',environment:'testnet'},tokenAmounts:[{sourceTokenAddress:sourceToken,destTokenAddress:destinationToken,amount}]};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

describe('CCIP destination delivery verification',()=>{
  it('accepts a fully bound SUCCESS response with destination evidence',async()=>{
    const result=await checkCcipDelivery(config,task,async()=>response(payload));
    expect(result.state).toBe('DELIVERED');expect(result.destinationTransactionHash).toBe(destinationHash);expect(result.destinationChainId).toBe(84532);expect(result.amount).toBe(amount);
  });

  it('verifies an owner-approved transfer whose CCIP send is the approve tx, not the request tx',async()=>{
    const approveHash=`0x${'6'.repeat(64)}` as const;
    const approved={...task,transactions:[...task.transactions,{hash:approveHash,role:'approve' as const,finality:'mined' as const}]};
    const result=await checkCcipDelivery(config,approved,async()=>response({...payload,sendTransactionHash:approveHash}));
    expect(result.state).toBe('DELIVERED');
    expect(result.sourceTransactionHash).toBe(approveHash);
  });

  it('rejects a send transaction that the task never recorded',async()=>{
    const stranger=`0x${'7'.repeat(64)}` as const;
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,sendTransactionHash:stranger}))).rejects.toMatchObject({status:409,code:'CCIP_SOURCE_TX_MISMATCH'});
    await expect(checkCcipDelivery(config,{...task,txHash:null,transactions:[]},async()=>response({...payload,sendTransactionHash:stranger}))).rejects.toMatchObject({status:409});
  });

  it('rejects an empty task before making an external request',async()=>{
    const request=vi.fn(async()=>response(payload));
    await expect(checkCcipDelivery(config,{...task,messageId:undefined},request)).rejects.toThrow(/源链证据/);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects malformed API data and mismatched task identity',async()=>{
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,messageId:'bad'}))).rejects.toThrow();
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,receiver:sender}))).rejects.toThrow(/不一致/);
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,routerAddress:sender}))).rejects.toThrow(/不一致/);
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,sourceNetworkInfo:{...payload.sourceNetworkInfo,chainSelector:'1'}}))).rejects.toThrow(/不一致/);
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,tokenAmounts:[{...payload.tokenAmounts[0],amount:'2'}]}))).rejects.toThrow(/不一致/);
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,tokenAmounts:[]}))).rejects.toThrow(/不一致/);
    await expect(checkCcipDelivery(config,task,async()=>response({error:'UPSTREAM',message:'try later'},503))).rejects.toThrow(/try later/);
    await expect(checkCcipDelivery(config,task,async()=>{throw new Error('offline');})).rejects.toMatchObject({status:503,code:'CCIP_STATUS_UNAVAILABLE'});
    await expect(checkCcipDelivery(config,task,async()=>new Response('not json'))).rejects.toMatchObject({status:503,code:'CCIP_STATUS_UNAVAILABLE'});
  });

  it('distinguishes indexing, in-flight, failed, and invalid success boundaries',async()=>{
    await expect(checkCcipDelivery(config,task,async()=>response({},404))).resolves.toMatchObject({state:'INDEXING'});
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,status:'SENT',receiptTransactionHash:null}))).resolves.toMatchObject({state:'IN_FLIGHT'});
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,status:'FAILED',receiptTransactionHash:null}))).resolves.toMatchObject({state:'FAILED'});
    await expect(checkCcipDelivery(config,task,async()=>response({...payload,receiptTransactionHash:null}))).rejects.toThrow(/缺少目标链交易哈希/);
  });
});
