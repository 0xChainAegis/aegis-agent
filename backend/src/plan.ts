import { keccak256, toHex, type Hex } from 'viem';
import type { DraftPlanV1, Intent, PlanProvenance } from '@aegis/shared';
import type { Quote } from './chain.js';

export const PLAN_SCHEMA_VERSION = 'aegis.draft-plan.v1' as const;
export const PLAN_RECOMPUTE_PATH = 'docs/DRAFT-PLAN-PROVENANCE.md';

function sortValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  throw new TypeError(`canonicalJson does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function hashDomain(domain: string, value: unknown): Hex {
  return keccak256(toHex(`${PLAN_SCHEMA_VERSION}\n${domain}\n${canonicalJson(value)}`));
}

function hashText(domain: string, text: string): Hex {
  return keccak256(toHex(`${PLAN_SCHEMA_VERSION}\n${domain}\n${text}`));
}

export function computeDraftHash(intent: Intent): Hex {
  return hashDomain('draft', {
    schemaVersion: PLAN_SCHEMA_VERSION,
    draftId: intent.draftId,
    revision: intent.revision,
    action: 'transfer',
    messageHash: hashText('message', intent.message),
    purposeHash: hashText('purpose', intent.purpose),
    recipient: intent.recipient,
    amountWei: intent.amountWei,
    parser: intent.parser,
  });
}

export function quotePlanPayload(quote: Quote) {
  return {
    quoteId: quote.quoteId,
    draftVersion: quote.draftVersion,
    chainId: quote.chainId,
    walletAddress: quote.walletAddress,
    agentAddress: quote.agentAddress,
    recipient: quote.recipient,
    amountWei: quote.amountWei,
    costUsd6: quote.costUsd6,
    maxUsdCost6: quote.maxUsdCost6,
    policyVersion: quote.policyVersion,
    quoteExpiresAtSeconds: quote.quoteExpiresAtSeconds,
    requestDeadlineSeconds: quote.requestDeadlineSeconds,
    observedBlockNumber: quote.observedBlockNumber,
    observedBlockHash: quote.observedBlockHash,
    decision: quote.decision,
  };
}

export function computeQuoteHash(quote: Quote): Hex {
  return hashDomain('quote', quotePlanPayload(quote));
}

export function computePlanHash(draftHash: Hex, quoteHash: Hex): Hex {
  return keccak256(toHex(`${PLAN_SCHEMA_VERSION}\nplan\n${draftHash}\n${quoteHash}`));
}

export function buildDraftPlanV1(intent: Intent, quote: Quote): DraftPlanV1 {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    draftId: intent.draftId,
    revision: intent.revision,
    action: 'transfer',
    messageHash: hashText('message', intent.message),
    purposeHash: hashText('purpose', intent.purpose),
    recipient: intent.recipient,
    amountWei: intent.amountWei,
    parser: intent.parser,
    quote: quotePlanPayload(quote),
  };
}

export function computePlanProvenance(intent: Intent, quote: Quote): PlanProvenance {
  const draftHash = computeDraftHash(intent);
  const quoteHash = computeQuoteHash(quote);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    draftHash,
    quoteHash,
    planHash: computePlanHash(draftHash, quoteHash),
    hashAlgorithm: 'keccak256',
    recompute: PLAN_RECOMPUTE_PATH,
  };
}

export function verifyPlanHash(intent: Intent, quote: Quote, expected: string): boolean {
  const expectedHash = computePlanHash(computeDraftHash(intent), computeQuoteHash(quote));
  return expectedHash.toLowerCase() === expected.toLowerCase();
}
