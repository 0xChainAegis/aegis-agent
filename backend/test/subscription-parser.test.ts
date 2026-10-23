import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDraft } from '../src/parser.js';
import { parseDraftWithLlm, StubIntentClient } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
const recipient='0x1111111111111111111111111111111111111111';
test('recurring language never becomes an ordinary ETH payment draft',()=>{
 const draft=parseDraft({message:`每月向 ${recipient} 支付 0.001 ETH，订阅三次`},null);
 assert.equal(draft.status,'NEEDS_INPUT'); assert.ok(draft.missingFields.includes('subscriptionId'));
 assert.equal(draft.amountWei,null);
});
test('CCIP request stays unsupported on rule path',()=>{
 const draft=parseDraft({message:`跨链到 Arbitrum Sepolia 给 ${recipient} 0.001 ETH`},null);
 assert.equal(draft.status,'NEEDS_INPUT'); assert.ok(draft.missingFields.includes('unsupported'));
});
test('LLM cannot turn recurring intent into native transfer',async()=>{
 const config=loadConfig({AEGIS_LLM_MODE:'stub'});
 const client=new StubIntentClient(()=>({action:'transfer',recipient,amountEth:'0.001',purpose:'payment',missingFields:[],question:null}));
 const draft=await parseDraftWithLlm({message:`每月给 ${recipient} 0.001 ETH`},config,undefined,client);
 assert.equal(draft.status,'NEEDS_INPUT'); assert.equal(draft.amountWei,null);
});
