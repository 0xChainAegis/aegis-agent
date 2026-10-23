import test from 'node:test';
import assert from 'node:assert/strict';
import { planHash } from '../src/plan.js';
test('subscription commitment covers all draft and quote fields independent of key order',()=>{
 const draft={actionKind:'SUBSCRIPTION',subscriptionId:'1',occurrenceIndex:'0',subscription:{periodSeconds:'60',maxPayments:'3'}};
 const quote={costUsd6:'3000000',maxUsdCost6:'3030000',quoteExpiresAtSeconds:123};
 const hash=planHash(draft,quote);
 assert.match(hash,/^0x[0-9a-f]{64}$/);
 assert.equal(hash,planHash({...draft,subscription:{maxPayments:'3',periodSeconds:'60'}},quote));
 for(const change of [{...draft,occurrenceIndex:'1'},{...draft,subscription:{...draft.subscription,maxPayments:'4'}}]) assert.notEqual(hash,planHash(change,quote));
 assert.notEqual(hash,planHash(draft,{...quote,maxUsdCost6:'4030000'}));
 assert.equal(hash,planHash(draft,{...quote,planHash:hash}));
});
