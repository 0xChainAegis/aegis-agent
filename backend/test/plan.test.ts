import assert from 'node:assert/strict';
import test from 'node:test';
import type { Intent } from '@aegis/shared';
import type { Quote } from '../src/chain.js';
import {
  buildDraftPlanV1,
  canonicalJson,
  computeDraftHash,
  computePlanHash,
  computePlanProvenance,
  computeQuoteHash,
  verifyPlanHash,
} from '../src/plan.js';

const intent: Intent = {
  draftId: '11111111-1111-4111-8111-111111111111',
  intentId: '11111111-1111-4111-8111-111111111111',
  version: 1,
  revision: 1,
  status: 'READY',
  message: 'send 0.001 ETH to 0x1111111111111111111111111111111111111111 for hosting',
  recipient: '0x1111111111111111111111111111111111111111',
  to: '0x1111111111111111111111111111111111111111',
  amountWei: '1000000000000000',
  purpose: 'hosting',
  missingFields: [],
  question: null,
  parser: { kind: 'rule_parser', model: null, configuredModel: null, fallback: false, reason: 'RULE_PARSER_ONLY' },
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
};

const quote: Quote = {
  quoteId: '22222222-2222-4222-8222-222222222222',
  draftId: intent.draftId,
  draftVersion: intent.revision,
  status: 'READY',
  chainId: 31337,
  walletAddress: '0x3333333333333333333333333333333333333333',
  agentAddress: '0x4444444444444444444444444444444444444444',
  recipient: intent.recipient!,
  to: intent.recipient!,
  amountWei: intent.amountWei!,
  costUsd6: '3000000',
  maxUsdCost6: '3030000',
  policyVersion: '1',
  requestDeadlineSeconds: 1760000600,
  quoteExpiresAtSeconds: 1760000060,
  requestNonce: null,
  requestHash: null,
  decision: 'AUTO',
  reasonCodes: [],
  budget: {
    autoThresholdUsd6: '5000000',
    hardPerTxUsd6: '10000000',
    dailyLimitUsd6: '15000000',
    spentTodayUsd6: '0',
    remainingUsd6: '15000000',
    window: 'UTC_CALENDAR_DAY',
  },
  feedAddress: '0x5555555555555555555555555555555555555555',
  feedDecimals: 8,
  priceAnswer: '300000000000',
  roundId: '1',
  updatedAtSeconds: 1760000000,
  observedBlockNumber: '123',
  observedBlockHash: '0x6666666666666666666666666666666666666666666666666666666666666666',
  oracle: {},
  triggerType: 'manual',
  ruleId: null,
};

test('canonicalJson sorts object keys and produces a stable plan golden vector', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');

  const provenance = computePlanProvenance(intent, quote);
  assert.deepEqual(provenance, {
    schemaVersion: 'aegis.draft-plan.v1',
    draftHash: '0xa866ab19da51b250a20543db6d18d03208126372124d68f91b2670a672630454',
    quoteHash: '0x972dfe589b544285b0a6000ebad024821b95d91877c81c01e4f24ad96e7c7b78',
    planHash: '0x69551de5ba7ddfa0f5f3a745dd1f4990b9b9111cfe8edcc3a4158353c3f57a7a',
    hashAlgorithm: 'keccak256',
    recompute: 'docs/DRAFT-PLAN-PROVENANCE.md',
  });
});

test('plan hash changes when draft provenance changes', () => {
  const base = computePlanProvenance(intent, quote);
  const changedMessage = computePlanProvenance({ ...intent, message: `${intent.message}.` }, quote);
  const changedPurpose = computePlanProvenance({ ...intent, purpose: `${intent.purpose}.` }, quote);
  const changedParser = computePlanProvenance(
    { ...intent, parser: { ...intent.parser, fallback: true, reason: 'LLM_REQUEST_FAILED' } },
    quote
  );

  assert.notEqual(changedMessage.draftHash, base.draftHash);
  assert.notEqual(changedMessage.planHash, base.planHash);
  assert.notEqual(changedPurpose.draftHash, base.draftHash);
  assert.notEqual(changedParser.draftHash, base.draftHash);
});

test('plan hash changes when quote context changes', () => {
  const base = computePlanProvenance(intent, quote);
  const changedPolicy = computePlanProvenance(intent, { ...quote, policyVersion: '2' });
  const changedBlock = computePlanProvenance(intent, {
    ...quote,
    observedBlockHash: '0x7777777777777777777777777777777777777777777777777777777777777777',
  });
  const changedCap = computePlanProvenance(intent, { ...quote, maxUsdCost6: '3040000' });

  assert.notEqual(changedPolicy.quoteHash, base.quoteHash);
  assert.notEqual(changedPolicy.planHash, base.planHash);
  assert.notEqual(changedBlock.quoteHash, base.quoteHash);
  assert.notEqual(changedCap.quoteHash, base.quoteHash);
});

test('verifyPlanHash accepts only the exact bound plan', () => {
  const provenance = computePlanProvenance(intent, quote);
  assert.equal(verifyPlanHash(intent, quote, provenance.planHash), true);
  assert.equal(verifyPlanHash(intent, quote, `0x${'0'.repeat(64)}`), false);
  assert.equal(computePlanHash(computeDraftHash(intent), computeQuoteHash(quote)), provenance.planHash);
});

test('DraftPlanV1 exposes the reviewed fields without raw message text', () => {
  const plan = buildDraftPlanV1(intent, quote);
  assert.equal(plan.schemaVersion, 'aegis.draft-plan.v1');
  assert.equal(plan.recipient, intent.recipient);
  assert.equal(plan.amountWei, intent.amountWei);
  assert.equal(plan.parser.reason, 'RULE_PARSER_ONLY');
  assert.equal(plan.quote.policyVersion, '1');
  assert.equal(JSON.stringify(plan).includes(intent.message), false);
});
