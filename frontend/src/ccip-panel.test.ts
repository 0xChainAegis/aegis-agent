import { describe,expect,it,vi } from 'vitest';
import { createCcipPanel } from './ccip-panel';
import type { Data } from './api';

const owner='0x1111111111111111111111111111111111111111';
const wallet='0x2222222222222222222222222222222222222222';
const sender='0x3333333333333333333333333333333333333333';
const token='0x4444444444444444444444444444444444444444';
const recipient='0x5555555555555555555555555555555555555555';
const selector='99';
const config={chainId:31337,ownerAddress:owner,walletAddress:wallet,ccipSenderAddress:sender,ccipTokenAddress:token,ccipDestinationChainSelector:selector,capabilities:{ccip:true}};
const draft={actionKind:'CCIP_TRANSFER',draftId:'draft',revision:1,recipient,amountWei:'1000000000000',tokenAddress:token,ccipSenderAddress:sender,destinationChainSelector:selector};
const quote={actionKind:'CCIP_TRANSFER',quoteId:'quote',draftId:'draft',draftVersion:1,status:'READY',walletAddress:sender,recipient,amountWei:'1000000000000',tokenAddress:token,ccipSenderAddress:sender,destinationChainSelector:selector,maxUsdCost6:'2',maxFeeWei:'110',quotedFeeWei:'100',planHash:`0x${'ab'.repeat(32)}`};
const input=(field:'recipient'|'amount'|'purpose',value:string)=>({dataset:{ccipField:field},value}) as unknown as HTMLInputElement;

function panel(replies:Data[]){
  const api=vi.fn<(path:string,method?:string,body?:Data)=>Promise<Data>>();
  for(const reply of replies)api.mockResolvedValueOnce(reply);
  const payment=vi.fn<(draft:Data,quote:Data)=>void>();
  const value=createCcipPanel({api,config:()=>config,disabled:()=>false,payment});
  value.input(input('recipient',recipient));value.input(input('amount','0.000001'));value.input(input('purpose','test'));
  return {value,api,payment};
}

describe('CCIP panel',()=>{
  it('creates only the configured structured route and binds its returned quote',async()=>{
    const {value,api,payment}=panel([draft,quote]);await value.preview();
    expect(api).toHaveBeenNthCalledWith(1,'/intents','POST',{actionKind:'CCIP_TRANSFER',recipient,amountWei:'1000000000000',tokenAddress:token,destinationChainSelector:selector,purpose:'test'});
    expect(api).toHaveBeenNthCalledWith(2,'/intents/draft/preview','POST',{expectedRevision:1});
    expect(payment).toHaveBeenCalledWith(draft,quote);
  });
  it('rejects empty or invalid input without calling the API',async()=>{
    const {value,api}=panel([]);value.input(input('amount','0'));
    await expect(value.preview()).rejects.toThrow('有效的目标链地址');expect(api).not.toHaveBeenCalled();
  });
  it('rejects the zero recipient without calling the API',async()=>{
    const {value,api}=panel([]);value.input(input('recipient','0x0000000000000000000000000000000000000000'));
    await expect(value.preview()).rejects.toThrow('有效的目标链地址');expect(api).not.toHaveBeenCalled();
  });
  it('rejects a draft or quote whose route, amount, recipient or sender changed',async()=>{
    for(const changed of [{...draft,recipient:owner},{...draft,tokenAddress:owner},{...draft,destinationChainSelector:'100'},{...draft,ccipSenderAddress:owner}]){
      const {value}=panel([changed]);await expect(value.preview()).rejects.toThrow('不一致');
    }
    const {value}=panel([draft,{...quote,maxFeeWei:undefined}]);await expect(value.preview()).rejects.toThrow();
  });
  it('preserves a validated BLOCKED quote so the confirmation UI can explain the rejection',async()=>{
    const blocked={...quote,status:'BLOCKED',planHash:`0x${'cd'.repeat(32)}`};
    const {value,payment}=panel([draft,blocked]);await value.preview();expect(payment).toHaveBeenCalledWith(draft,blocked);
  });
});
