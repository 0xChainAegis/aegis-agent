import { describe, expect, it } from 'vitest';
import { formatPolicyReasons } from './policy-reasons';

describe('formatPolicyReasons', () => {
  it('maps backend and contract policy codes to readable client messages', () => {
    expect(formatPolicyReasons(['NOT_ALLOWLISTED', 'PER_TX_LIMIT', 'BUDGET_EXCEEDED']))
      .toBe('收款地址不在允许名单中；超过单次硬上限；超过今日累计预算');
    expect(formatPolicyReasons(['EXECUTOR_UNAUTHORIZED', 'FEED_UNAVAILABLE']))
      .toBe('执行账户没有操作权限；价格源不可用，付款已停止');
  });

  it('handles an empty reason list without inventing a failure', () => {
    expect(formatPolicyReasons([])).toBe('');
  });

  it.each([null, {}, [''], [1], 'PER_TX_LIMIT'])('rejects malformed external reason data: %j', input => {
    expect(formatPolicyReasons(input)).toBe('');
  });

  it('preserves a bounded unknown code for diagnosis and rejects oversized input', () => {
    expect(formatPolicyReasons(['FUTURE_POLICY_CODE'])).toBe('FUTURE_POLICY_CODE');
    expect(formatPolicyReasons(Array.from({ length: 51 }, () => 'PER_TX_LIMIT'))).toBe('');
  });
});
