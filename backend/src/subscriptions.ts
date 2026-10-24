import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {isAddress,zeroAddress,parseAbi,encodeFunctionData,decodeEventLog,type Abi,type Address,type Hex} from 'viem';
import {subscriptionAbiSignatures,type SubscriptionConfig} from '@aegis/shared';
import type {Config} from './config.js';
import type {Store} from './store.js';
import type {ViemGateway} from './chain.js';
import {ApiError,errorMessage} from './errors.js';
import {planHash} from './plan.js';
const uint=(bits:number,zero=false)=>z.string().regex(zero?/^(0|[1-9]\d*)$/:/^[1-9]\d*$/).max(78).refine(s=>BigInt(s)<2n**BigInt(bits));
export const registrationSchema=z.object({recipient:z.string().refine(s=>isAddress(s)&&s.toLowerCase()!==zeroAddress),amountWei:uint(256),periodSeconds:uint(64),startAtSeconds:uint(64),endAtSeconds:uint(64),maxPayments:uint(64),periodCapUsd6:uint(256)}).strict();
const abi=parseAbi(subscriptionAbiSignatures);
const limitsAbi=parseAbi(['function maxSubscriptionPeriodCapUsd6() view returns(uint256)','function maxSubscriptionDurationSeconds() view returns(uint64)','function maxSubscriptionPayments() view returns(uint64)','event SubscriptionPolicyConfigured(uint64 indexed version,uint256 maxPeriodCapUsd6,uint64 maxDurationSeconds,uint64 maxPayments)']);
export const subscriptionPolicyInputSchema=z.object({maxPeriodCapUsd6:uint(256),maxDurationSeconds:uint(64),maxPayments:uint(64)}).strict();
type Transaction={to:Address;from:Address;data:Hex;value:string;chainId:number};
type PreparedControl={controlId:string;subscriptionId:string;action:'pause'|'resume'|'cancel';transaction:Transaction};
type Registration={registrationId:string;planHash:Hex;status:'READY';subscription: z.infer<typeof registrationSchema>&{agentAddress:Address};transaction:Transaction;quoteExpiresAtSeconds:number};
type PreparedPolicy={policyId:string;policy:z.infer<typeof subscriptionPolicyInputSchema>;transaction:Transaction};
const equal=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export class SubscriptionManager {
 constructor(readonly config:Config,readonly store:Store,readonly gateway:ViemGateway){}
 private available(owner?:Address){
  const supported=(this.config.mode==='local_chain'&&this.config.chainId===31337)||(this.config.mode==='testnet'&&this.config.chainId===11155111);
  if(!supported||!this.config.deploymentReady)throw new ApiError(422,'SUBSCRIPTIONS_UNAVAILABLE','订阅需要已部署的 Local 31337 或 Ethereum Sepolia 合约');
  if(owner&&!equal(owner,this.config.ownerAddress))throw new ApiError(403,'OWNER_REQUIRED','仅 Owner 可管理订阅');
 }
 private tx(data:Hex):Transaction{return {to:this.config.walletAddress,from:this.config.ownerAddress,data,value:'0',chainId:this.config.chainId};}
 async policy(){this.available();const [cap,duration,count]=await this.limits();return {configured:cap>0n&&duration>0n&&count>0n,maxPeriodCapUsd6:String(cap),maxDurationSeconds:String(duration),maxPayments:String(count)};}
 async supported(){try{this.available();await this.limits();return true;}catch{return false;}}
 async enabled(){try{return (await this.policy()).configured;}catch{return false;}}
 private async limits(){return Promise.all(['maxSubscriptionPeriodCapUsd6','maxSubscriptionDurationSeconds','maxSubscriptionPayments'].map(functionName=>this.gateway.publicClient.readContract({address:this.config.policyEngineAddress,abi:limitsAbi,functionName:functionName as 'maxSubscriptionPeriodCapUsd6'})));}
 async get(id:string):Promise<SubscriptionConfig>{
  this.available();uint(64).parse(id);
  if(await this.gateway.publicClient.getChainId()!==this.config.chainId)throw new ApiError(503,'CHAIN_MISMATCH','RPC 链不匹配');
  const block=await this.gateway.publicClient.getBlock();
  const s=await this.gateway.publicClient.readContract({address:this.config.walletAddress,abi,functionName:'subscriptions',args:[BigInt(id)],blockNumber:block.number});
  if(!s.exists)throw new ApiError(404,'SUBSCRIPTION_NOT_FOUND','订阅不存在');
  const now=block.timestamp; const index=now>=s.startAt?(now-s.startAt)/s.periodSeconds:null;
  const status=s.cancelled?'CANCELLED':s.paused?'PAUSED':now>=s.endAt?'EXPIRED':s.paidCount>=s.maxPayments?'COMPLETED':now<s.startAt?'NOT_STARTED':'ACTIVE';
  return {subscriptionId:id,agentAddress:s.agent,recipient:s.to,amountWei:String(s.amountWei),periodSeconds:String(s.periodSeconds),startAtSeconds:String(s.startAt),endAtSeconds:String(s.endAt),maxPayments:String(s.maxPayments),periodCapUsd6:String(s.periodCapUsd6),parentPlanHash:s.parentPlanHash,paidCount:String(s.paidCount),paused:s.paused,cancelled:s.cancelled,currentOccurrenceIndex:index===null?null:String(index),status};
 }
 async list(owner:Address){this.available(owner);const rows=this.store.list<{subscriptionId:string}>('subscription',owner);return {subscriptions:await Promise.all(rows.map(s=>this.get(s.subscriptionId))),policy:await this.policy()};}
 async policyPreview(owner:Address,input:unknown){
  this.available(owner);const policy=subscriptionPolicyInputSchema.parse(input);
  const args=[BigInt(policy.maxPeriodCapUsd6),BigInt(policy.maxDurationSeconds),BigInt(policy.maxPayments)] as const;
  const data=encodeFunctionData({abi,functionName:'configureSubscriptionPolicy',args});
  await this.gateway.publicClient.simulateContract({address:this.config.walletAddress,abi,functionName:'configureSubscriptionPolicy',account:owner,args});
  const result:PreparedPolicy={policyId:randomUUID(),policy,transaction:this.tx(data)};this.store.put('subscription-policy',result.policyId,owner,result);return result;
 }
 async policyObserved(owner:Address,policyId:string,hash:Hex){
  const prepared=this.store.get<PreparedPolicy>('subscription-policy',policyId,owner);if(!prepared)throw new ApiError(404,'SUBSCRIPTION_POLICY_PREVIEW_NOT_FOUND','订阅策略预览不存在');
  const event=await this.verified(owner,hash,prepared.transaction,'SubscriptionPolicyConfigured',this.config.policyEngineAddress,limitsAbi);const policy=prepared.policy;
  if(String(event.maxPeriodCapUsd6)!==policy.maxPeriodCapUsd6||String(event.maxDurationSeconds)!==policy.maxDurationSeconds||String(event.maxPayments)!==policy.maxPayments)throw new ApiError(422,'SUBSCRIPTION_POLICY_BINDING_MISMATCH','订阅策略事件与确认内容不一致');
  const current=await this.policy();if(!current.configured||current.maxPeriodCapUsd6!==policy.maxPeriodCapUsd6||current.maxDurationSeconds!==policy.maxDurationSeconds||current.maxPayments!==policy.maxPayments)throw new ApiError(422,'SUBSCRIPTION_POLICY_BINDING_MISMATCH','链上订阅策略与确认内容不一致');
  return current;
 }
 async preview(owner:Address,input:unknown){
  this.available(owner);const sub=registrationSchema.parse(input);const [cap,duration,count]=await this.limits();
  if(!cap||!duration||!count)throw new ApiError(422,'SUBSCRIPTION_POLICY_NOT_CONFIGURED','订阅限额未配置');
  if(BigInt(sub.endAtSeconds)<=BigInt(sub.startAtSeconds)||BigInt(sub.endAtSeconds)-BigInt(sub.startAtSeconds)>duration||BigInt(sub.periodSeconds)>BigInt(sub.endAtSeconds)-BigInt(sub.startAtSeconds)||BigInt(sub.maxPayments)>count||BigInt(sub.periodCapUsd6)>cap)throw new ApiError(422,'SUBSCRIPTION_BOUNDS','订阅周期、期限、次数或单期上限不符合配置');
  const registrationId=randomUUID();const quoteExpiresAtSeconds=Math.floor(Date.now()/1000)+this.config.quoteSeconds;
  const subscription={...sub,agentAddress:this.config.agentAddress};
  const hash=planHash(subscription,{registrationId,quoteExpiresAtSeconds,chainId:this.config.chainId,walletAddress:this.config.walletAddress});
  const data=encodeFunctionData({abi,functionName:'createFiniteSubscription',args:[this.config.agentAddress,sub.recipient as Address,BigInt(sub.amountWei),BigInt(sub.periodSeconds),BigInt(sub.startAtSeconds),BigInt(sub.endAtSeconds),BigInt(sub.maxPayments),BigInt(sub.periodCapUsd6),hash]});
  await this.gateway.publicClient.simulateContract({address:this.config.walletAddress,abi,functionName:'createFiniteSubscription',account:owner,args:[this.config.agentAddress,sub.recipient as Address,BigInt(sub.amountWei),BigInt(sub.periodSeconds),BigInt(sub.startAtSeconds),BigInt(sub.endAtSeconds),BigInt(sub.maxPayments),BigInt(sub.periodCapUsd6),hash]});
  const result:Registration={registrationId,planHash:hash,status:'READY',subscription,transaction:this.tx(data),quoteExpiresAtSeconds};this.store.put('subscription-registration',registrationId,owner,result);return result;
 }
 private async verified(owner:Address,hash:Hex,expected:Transaction,eventName:string,eventAddress:Address=expected.to,eventAbi:Abi=abi){
  this.available(owner);
  if(await this.gateway.publicClient.getChainId()!==this.config.chainId)throw new ApiError(503,'CHAIN_MISMATCH','RPC 链不匹配');
  let receipt;try{receipt=await this.gateway.publicClient.getTransactionReceipt({hash});}catch(e){if(/not found|could not be found/i.test(errorMessage(e)))throw new ApiError(409,'TX_PENDING','交易尚未确认，请核对同一 hash');throw e;}
  const tx=await this.gateway.publicClient.getTransaction({hash});
  if(receipt.status!=='success')throw new ApiError(422,'TX_REVERTED','订阅控制交易回滚');
  if(!equal(tx.from,owner)||!tx.to||!equal(tx.to,expected.to)||tx.value!==0n||!equal(tx.input,expected.data))throw new ApiError(422,'TX_BINDING_MISMATCH','Owner 交易与确认计划不一致');
  const events=[];
  for(const log of receipt.logs){if(!equal(log.address,eventAddress))continue;try{const decoded=decodeEventLog({abi:eventAbi,data:log.data,topics:log.topics,strict:true});if(decoded.eventName===eventName)events.push(decoded.args as unknown as Record<string,unknown>);}catch{}}
  if(events.length!==1)throw new ApiError(422,'EXPECTED_EVENT_MISSING','订阅控制事件缺失或重复');
  return events[0];
 }
 async observed(owner:Address,registrationId:string,hash:Hex){
  const registration=this.store.get<Registration>('subscription-registration',registrationId,owner);if(!registration)throw new ApiError(404,'REGISTRATION_NOT_FOUND','订阅预览不存在');
  const e=await this.verified(owner,hash,registration.transaction,'FiniteSubscriptionCreated');
  if(e.parentPlanHash!==registration.planHash||!equal(String(e.agent),registration.subscription.agentAddress)||!equal(String(e.to),registration.subscription.recipient))throw new ApiError(422,'SUBSCRIPTION_BINDING_MISMATCH','登记事件与计划不一致');
  const record=await this.get(String(e.subscriptionId));const sub=registration.subscription;
  if(record.parentPlanHash!==registration.planHash||!equal(record.agentAddress,sub.agentAddress)||!equal(record.recipient,sub.recipient)||['amountWei','periodSeconds','startAtSeconds','endAtSeconds','maxPayments','periodCapUsd6'].some(k=>record[k as keyof SubscriptionConfig]!==sub[k as keyof typeof sub]))throw new ApiError(422,'SUBSCRIPTION_BINDING_MISMATCH','链上计划与确认内容不一致');
  this.store.put('subscription',record.subscriptionId,owner,{...record,registrationId,transactionHash:hash,verification:{chainVerified:true,event:'FiniteSubscriptionCreated'},consumed:false});return record;
 }
 async controlPreview(owner:Address,id:string,action:'pause'|'resume'|'cancel'){
  this.available(owner);if(!['pause','resume','cancel'].includes(action))throw new ApiError(400,'INVALID_ACTION','控制动作无效');await this.get(id);
  const transaction=this.tx(action==='cancel'?encodeFunctionData({abi,functionName:'cancelFiniteSubscription',args:[BigInt(id)]}):encodeFunctionData({abi,functionName:'pauseFiniteSubscription',args:[BigInt(id),action==='pause']}));
  const result:PreparedControl={controlId:randomUUID(),subscriptionId:id,action,transaction};this.store.put('subscription-control',result.controlId,owner,result);return result;
 }
 async controlObserved(owner:Address,id:string,controlId:string,hash:Hex){
  const control=this.store.get<PreparedControl>('subscription-control',controlId,owner);if(!control||control.subscriptionId!==id)throw new ApiError(404,'CONTROL_NOT_FOUND','控制预览不存在');
  const e=await this.verified(owner,hash,control.transaction,control.action==='cancel'?'FiniteSubscriptionCancelled':'FiniteSubscriptionPaused');
  if(String(e.subscriptionId)!==id||(control.action!=='cancel'&&e.paused!==(control.action==='pause')))throw new ApiError(422,'SUBSCRIPTION_BINDING_MISMATCH','控制事件不匹配');
  return this.get(id);
 }
}
