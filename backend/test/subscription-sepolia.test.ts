import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, type Address } from 'viem';
import { loadConfig } from '../src/config.js';
import { ViemGateway } from '../src/chain.js';
import { Store } from '../src/store.js';
import { SubscriptionManager, subscriptionPolicyInputSchema } from '../src/subscriptions.js';
import { subscriptionAbiSignatures } from '@aegis/shared';
import { parseAbi } from 'viem';

const owner='0x1111111111111111111111111111111111111111' as Address;
const agent='0x2222222222222222222222222222222222222222' as Address;
const wallet='0x3333333333333333333333333333333333333333' as Address;
const engine='0x4444444444444444444444444444444444444444' as Address;
const policy={maxPeriodCapUsd6:'10000000',maxDurationSeconds:'2592000',maxPayments:'30'};
const abi=parseAbi(subscriptionAbiSignatures);

function setup(reads:[bigint,bigint,bigint]=[0n,0n,0n]){
 const config={...loadConfig({}),mode:'testnet' as const,chainId:11155111,deploymentReady:true,ownerAddress:owner,agentAddress:agent,walletAddress:wallet,policyEngineAddress:engine};
 const store=new Store(':memory:');const gateway=new ViemGateway(config);let index=0;
 Object.assign(gateway.publicClient,{readContract:async()=>reads[index++%3],simulateContract:async()=>({})});
 return {config,store,manager:new SubscriptionManager(config,store,gateway)};
}

test('Sepolia exposes supported but unconfigured subscription policy without pretending payments are enabled',async()=>{
 const {store,manager}=setup();
 assert.equal(await manager.supported(),true);assert.equal(await manager.enabled(),false);
 assert.deepEqual(await manager.policy(),{configured:false,maxPeriodCapUsd6:'0',maxDurationSeconds:'0',maxPayments:'0'});
 store.close();
});

test('Sepolia policy preview binds Owner, wallet, chain and exact finite limits',async()=>{
 const {store,manager}=setup();const preview=await manager.policyPreview(owner,policy);
 assert.equal(preview.transaction.from,owner);assert.equal(preview.transaction.to,wallet);assert.equal(preview.transaction.chainId,11155111);assert.equal(preview.transaction.value,'0');
 const decoded=decodeFunctionData({abi,data:preview.transaction.data});
 assert.equal(decoded.functionName,'configureSubscriptionPolicy');assert.deepEqual(decoded.args,[10000000n,2592000n,30n]);
 store.close();
});

test('Sepolia policy input rejects empty, zero, unknown, and uint64-overflow values',()=>{
 for(const candidate of [{},{...policy,maxPayments:'0'},{...policy,extra:'1'},{...policy,maxDurationSeconds:String(2n**64n)}])assert.equal(subscriptionPolicyInputSchema.safeParse(candidate).success,false);
});

test('unsupported mode and non-Owner policy setup fail before a wallet transaction is prepared',async()=>{
 const first=setup();await assert.rejects(()=>first.manager.policyPreview(agent,policy),/Owner/);first.store.close();
 const second=setup();const unsupported=new SubscriptionManager({...second.config,mode:'mock'},second.store,new ViemGateway({...second.config,mode:'mock'}));
 await assert.rejects(()=>unsupported.policyPreview(owner,policy),/Local|Sepolia/);second.store.close();
});
