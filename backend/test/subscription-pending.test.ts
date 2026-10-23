import test from 'node:test';
import assert from 'node:assert/strict';
import {ViemGateway} from '../src/chain.js';
import {loadConfig} from '../src/config.js';
const address='0x1111111111111111111111111111111111111111' as const;
const hash=`0x${'1'.repeat(64)}` as const;
test('Owner preflight binds subscription metadata as well as generic pending payment',async()=>{
 const task={actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0',planHash:hash,attestationId:'1',agentAddress:address,recipient:address,amountWei:'1',maxUsdCost6:'3',requestNonce:'0',requestDeadlineSeconds:2000000000,policyVersion:'1',requestHash:hash} as any;
 const gateway=new ViemGateway({...loadConfig({}),mode:'local_chain',chainId:31337,walletAddress:address,ownerAddress:address});
 let simulations=0;const client=gateway.publicClient as any;client.getChainId=async()=>31337;client.readContract=async({functionName}:any)=>functionName==='pending'?[address,address,1n,3n,0n,2000000000n,1n,hash,true]:[2n,0n,hash];client.simulateContract=async()=>{simulations++;};
 await assert.rejects(()=>gateway.preflightOwner(task,'approve'),/订阅|subscription/i);assert.equal(simulations,0);
});
