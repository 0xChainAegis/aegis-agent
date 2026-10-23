import { describe, expect, it } from 'vitest';
import { getAddress, stringToHex, zeroAddress, type Address, type Hex } from 'viem';
import {
  minimumWeiForUsd6, runSepoliaPolicyCheck,
  type RiskRequest, type SepoliaPolicyConfig, type SepoliaPolicyReader,
} from '../src/sepolia-policy-check.js';

const policyEngineAddress = getAddress('0x1000000000000000000000000000000000000001');
const oracleAddress = getAddress('0x2000000000000000000000000000000000000002');
const feedAddress = getAddress('0x3000000000000000000000000000000000000003');
const agentAddress = getAddress('0x4000000000000000000000000000000000000004');
const recipientAddress = getAddress('0x5000000000000000000000000000000000000005');
const blockHash = `0x${'ab'.repeat(32)}`;
const answer = 2_500_00000000n;
const decimals = 8;
const denominator = 10n ** (12n + BigInt(decimals));

function config(): SepoliaPolicyConfig {
  return {
    chainId: 11155111, rpcUrl: 'https://rpc.example.test', policyEngineAddress, oracleAddress, feedAddress,
    agentAddress, recipientAddress, rpcTimeoutMs: 15_000, rpcRetryCount: 1,
  };
}

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 11155111, blockNumber: 42n, blockHash, blockTimestamp: 2_000_000_000n,
    policyVersion: 2n, autoLimitUsd6: 10_000_000n, perTxLimitUsd6: 50_000_000n,
    dailyLimitUsd6: 100_000_000n, spentUsd6: 20_000_000n, remainingUsd6: 80_000_000n,
    maxPriceAge: 3_600n, feedAddress,
    quote: { costUsd6: 2_500_000_000n, roundId: 99n, answer, updatedAt: 1_999_999_900n, decimals },
    ...overrides,
  };
}

function reason(value: string): Hex {
  return value ? stringToHex(value, { size: 32 }) : `0x${'00'.repeat(32)}` as Hex;
}

class FakeReader implements SepoliaPolicyReader {
  constructor(private readonly stateValue: unknown = state(), private readonly failure?: Error, private readonly resultValue?: unknown) {}

  async state(): Promise<unknown> {
    if (this.failure) throw this.failure;
    return this.stateValue;
  }

  async evaluate(request: RiskRequest): Promise<unknown> {
    if (this.resultValue !== undefined) return this.resultValue;
    const current = state() as {
      blockTimestamp: bigint; policyVersion: bigint; autoLimitUsd6: bigint; perTxLimitUsd6: bigint;
      dailyLimitUsd6: bigint; spentUsd6: bigint;
    };
    let rejection = '';
    const cost = request.amount === 0n ? 0n : (request.amount * answer + denominator - 1n) / denominator;
    if (request.actionType !== 0 || request.asset !== zeroAddress || request.destinationChainSelector !== 0n) rejection = 'UNSUPPORTED_ACTION';
    else if (request.actor.toLowerCase() !== agentAddress.toLowerCase()) rejection = 'NOT_AGENT';
    else if (request.recipient.toLowerCase() !== recipientAddress.toLowerCase()) rejection = 'RECIPIENT_NOT_ALLOWED';
    else if (request.amount === 0n || request.maxUsdCost6 === 0n) rejection = 'ZERO_AMOUNT';
    else if (current.blockTimestamp > request.deadline) rejection = 'REQUEST_EXPIRED';
    else if (request.policyVersion !== current.policyVersion) rejection = 'POLICY_VERSION_MISMATCH';
    else if (cost > request.maxUsdCost6) rejection = 'QUOTE_EXCEEDS_MAX';
    else if (cost > current.perTxLimitUsd6) rejection = 'PER_TX_LIMIT';
    else if (current.spentUsd6 + cost > current.dailyLimitUsd6) rejection = 'DAILY_LIMIT';
    const decision = rejection ? 0 : cost > current.autoLimitUsd6 ? 2 : 1;
    return {
      decision, reasonCode: reason(rejection), costUsd6: cost,
      remainingUsd6: rejection ? current.dailyLimitUsd6 - current.spentUsd6 : current.dailyLimitUsd6 - current.spentUsd6 - cost,
      roundId: rejection && ['UNSUPPORTED_ACTION', 'NOT_AGENT', 'RECIPIENT_NOT_ALLOWED', 'ZERO_AMOUNT', 'REQUEST_EXPIRED', 'POLICY_VERSION_MISMATCH'].includes(rejection) ? 0n : 99n,
      updatedAt: rejection && ['UNSUPPORTED_ACTION', 'NOT_AGENT', 'RECIPIENT_NOT_ALLOWED', 'ZERO_AMOUNT', 'REQUEST_EXPIRED', 'POLICY_VERSION_MISMATCH'].includes(rejection) ? 0n : 1_999_999_900n,
    };
  }
}

describe('Sepolia read-only policy regression', () => {
  it('covers allow, approval, authorization, recipient, quote, limit and unsupported-action decisions', async () => {
    const report = await runSepoliaPolicyCheck(config(), new FakeReader());
    expect(report.ok).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.cases.every(item => item.ok)).toBe(true);
    expect(report.cases.map(item => item.id)).toEqual(expect.arrayContaining([
      'authorized_allow_boundary', 'approval_boundary', 'unauthorized_actor', 'recipient_not_allowlisted',
      'zero_amount', 'expired_request', 'policy_version_mismatch', 'quote_cap_exceeded',
      'per_transaction_limit', 'subscription_unsupported', 'ccip_unsupported',
    ]));
    expect(JSON.stringify(report)).not.toContain('rpc.example.test');
  });

  it('marks stale, future and mismatched Feed observations unsafe without throwing away the report', async () => {
    const stale = await runSepoliaPolicyCheck(config(), new FakeReader(state({
      quote: { costUsd6: 2_500_000_000n, roundId: 99n, answer, updatedAt: 1_999_996_399n, decimals },
    })));
    expect(stale.ok).toBe(false);
    expect(stale.cases.find(item => item.id === 'chainlink_feed_fresh')?.ok).toBe(false);

    const future = await runSepoliaPolicyCheck(config(), new FakeReader(state({
      quote: { costUsd6: 2_500_000_000n, roundId: 99n, answer, updatedAt: 2_000_000_001n, decimals },
    })));
    expect(future.ok).toBe(false);
    expect(future.cases.find(item => item.id === 'chainlink_feed_fresh')?.ok).toBe(false);

    const wrongFeed = await runSepoliaPolicyCheck(config(), new FakeReader(state({ feedAddress: policyEngineAddress })));
    expect(wrongFeed.ok).toBe(false);
    expect(wrongFeed.cases.find(item => item.id === 'feed_binding')?.ok).toBe(false);
  });

  it('rejects empty or malformed RPC-derived state and propagates transport errors', async () => {
    await expect(runSepoliaPolicyCheck(config(), new FakeReader({}))).rejects.toThrow();
    await expect(runSepoliaPolicyCheck(config(), new FakeReader(state(), undefined, {}))).rejects.toThrow();
    await expect(runSepoliaPolicyCheck(config(), new FakeReader(undefined, new Error('RPC timeout')))).rejects.toThrow('RPC timeout');
  });

  it('fails closed when the remaining budget cannot exercise required boundaries', async () => {
    await expect(runSepoliaPolicyCheck(config(), new FakeReader(state({ spentUsd6: 100_000_000n, remainingUsd6: 0n })))).rejects.toThrow('budget is exhausted');
    await expect(runSepoliaPolicyCheck(config(), new FakeReader(state({ autoLimitUsd6: 50_000_000n, perTxLimitUsd6: 50_000_000n })))).rejects.toThrow('cannot exercise REQUIRE_APPROVAL');
  });

  it('calculates the first wei that reaches each USD6 boundary with ceiling rounding', () => {
    for (const target of [1n, 10_000_000n, 50_000_001n]) {
      const amount = minimumWeiForUsd6(target, answer, decimals);
      const cost = (amount * answer + denominator - 1n) / denominator;
      const previousCost = amount > 0n ? ((amount - 1n) * answer + denominator - 1n) / denominator : 0n;
      expect(cost).toBe(target);
      expect(previousCost).toBeLessThan(target);
    }
    expect(minimumWeiForUsd6(0n, answer, decimals)).toBe(0n);
    expect(() => minimumWeiForUsd6(1n, 0n, decimals)).toThrow('positive');
    expect(() => minimumWeiForUsd6(1n, answer, 19)).toThrow('0 to 18');
  });
});
