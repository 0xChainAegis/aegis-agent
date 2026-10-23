import { describe, expect, it } from 'vitest';
import { FiniteSubscriptionFormSchema } from './schemas';

const valid = { recipient: '0x1000000000000000000000000000000000000001', amount: '0.001', periodSeconds: '60', startAt: '1700000000', endAt: '1700003600', maxPayments: '3', periodCap: '5', purpose: '' };
describe('finite subscription form', () => {
  it('accepts explicit finite ETH configuration without rounding', () => {
    expect(FiniteSubscriptionFormSchema.parse(valid)).toEqual(valid);
  });
  it.each([
    { periodSeconds: '' }, { periodSeconds: '01' }, { periodSeconds: '1e3' }, { periodSeconds: '18446744073709551616' },
    { startAt: '' }, { endAt: '1700000000' }, { maxPayments: '0' }, { maxPayments: '' },
    { amount: '0' }, { amount: '1e-3' }, { amount: '0.0000000000000000001' },
    { periodCap: '0' }, { periodCap: '1.0000001' }, { recipient: '0x0000000000000000000000000000000000000000' },
    { approvalMode: 'BOUNDED_MANDATE' },
  ])('rejects invalid/missing/implicit plan bounds %j', patch => {
    expect(FiniteSubscriptionFormSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
