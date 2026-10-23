import { z } from 'zod';

const policyReasonCodesSchema = z.array(z.string().trim().min(1).max(100)).max(50);

const policyReasonLabels: Readonly<Record<string, string>> = {
  AUTO_THRESHOLD_EXCEEDED: '超过自动额度，需要 Owner 审批',
  HARD_PER_TX_EXCEEDED: '超过单次硬上限',
  PER_TX_LIMIT: '超过单次硬上限',
  DAILY_BUDGET_EXCEEDED: '超过今日累计预算',
  DAILY_LIMIT: '超过今日累计预算',
  BUDGET_EXCEEDED: '超过今日累计预算',
  RECIPIENT_NOT_ALLOWED: '收款地址不在允许名单中',
  NOT_ALLOWLISTED: '收款地址不在允许名单中',
  EXECUTOR_UNAUTHORIZED: '执行账户没有操作权限',
  AGENT_FROZEN: '执行账户已被冻结或仅可读取',
  ZERO_AMOUNT: '付款金额必须大于 0',
  REQUEST_EXPIRED: '付款请求已过期，请重新预览',
  POLICY_VERSION_MISMATCH: '策略已经更新，请重新预览',
  QUOTE_EXCEEDS_MAX: '最新价格超过本次允许的最高成本',
  WALLET_BALANCE_LOW: '钱包余额不足',
  INSUFFICIENT_BALANCE: '钱包余额不足',
  FEED_STALE: '价格已过期，付款已停止',
  FEED_UNAVAILABLE: '价格源不可用，付款已停止',
  POLICY_BLOCKED: '未通过合约规则',
  BROADCAST_UNKNOWN: '广播结果不明，正在核对原交易，请勿重复付款',
  TX_REVERTED: '交易已回滚，未完成付款',
  EXPECTED_EVENT_MISSING: '未找到匹配的付款事件',
};

export function formatPolicyReasons(input: unknown): string {
  const parsed = policyReasonCodesSchema.safeParse(input);
  if (!parsed.success) return '';
  return parsed.data.map(code => policyReasonLabels[code] ?? code).join('；');
}
