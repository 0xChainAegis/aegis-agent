import { keccak256, toHex, type Hex } from 'viem';
// v2 has its own domain; never change PR #11's native v1 commitments.
export function canonicalPlan(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPlan).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([key,v])=>key!=='planHash' && v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>`${JSON.stringify(key)}:${canonicalPlan(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function planHash(draft: unknown, quote: unknown): Hex {
  return keccak256(toHex(`aegis.draft-plan.v2\n${canonicalPlan({draft,quote})}`));
}
