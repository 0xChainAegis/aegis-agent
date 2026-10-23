import { describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import type { Task } from '@aegis/shared';
import { loadConfig, type Config } from '../src/config.js';
import {
  runSepoliaPolicyWriteCheck, type SepoliaPolicyWriteGateway,
} from '../src/sepolia-policy-write.js';

const walletAddress = getAddress('0x1000000000000000000000000000000000000001');
const ownerAddress = getAddress('0x2000000000000000000000000000000000000002');
const agentAddress = getAddress('0x3000000000000000000000000000000000000003');
const recipientAddress = getAddress('0x4000000000000000000000000000000000000004');
const transactionHash = `0x${'11'.repeat(32)}` as Hex;
const requestHash = `0x${'22'.repeat(32)}` as Hex;
const blockHash = `0x${'33'.repeat(32)}` as Hex;

function config(): Config {
  return {
    ...loadConfig({ AEGIS_MODE: 'mock' }),
    mode: 'testnet', chainId: 11155111, walletAddress, ownerAddress, agentAddress, recipientAddress,
    agentKey: `0x${'44'.repeat(32)}` as Hex,
  };
}

function snapshot(walletBalanceWei: string, recipientBalanceWei: string, spentTodayUsd6: string): Record<string, unknown> {
  return {
    chainId: 11155111, walletBalanceWei, agentBalanceWei: '100', recipientBalanceWei, policyVersion: '2',
    budget: {
      autoThresholdUsd6: '10000000', hardPerTxUsd6: '50000000', dailyLimitUsd6: '100000000',
      spentTodayUsd6, remainingUsd6: (100000000n - BigInt(spentTodayUsd6)).toString(), window: 'UTC_CALENDAR_DAY',
    },
    observedBlockNumber: '42', observedBlockHash: blockHash, observedBlockTimestamp: '2000000000',
  };
}

function quote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'READY', decision: 'AUTO', chainId: 11155111, walletAddress, agentAddress,
    recipient: recipientAddress, to: recipientAddress, amountWei: '1', costUsd6: '1', maxUsdCost6: '2',
    policyVersion: '2', requestDeadlineSeconds: 2_000_000_000, reasonCodes: [], ...overrides,
  };
}

function outcome(): Record<string, unknown> {
  return {
    status: 'EXECUTED',
    transaction: { hash: transactionHash, receiptStatus: 1, event: 'NativeTransferExecuted', finality: 'mined' },
    policyEvidence: {
      event: 'BudgetConsumed', decision: 'ALLOW', requestHash, actor: agentAddress,
      costUsd6: '1', spentUsd6: '21', transactionHash, verified: true,
    },
  };
}

class FakeWriteGateway implements SepoliaPolicyWriteGateway {
  prepareCalls = 0;
  broadcastCalls = 0;
  outcomeCalls = 0;

  constructor(
    private readonly snapshots: unknown[] = [snapshot('100', '5', '20'), snapshot('99', '6', '21')],
    private readonly quoteValue: unknown = quote(),
    private readonly outcomeValues: unknown[] = [outcome()],
    private readonly broadcastFailure?: Error,
    private readonly snapshotFailure?: Error,
  ) {}

  async snapshot(): Promise<unknown> {
    if (this.snapshotFailure) throw this.snapshotFailure;
    return this.snapshots.shift();
  }
  async preview(_recipient: Address, _amountWei: string): Promise<unknown> { return this.quoteValue; }
  async prepare(_task: Task): Promise<unknown> {
    this.prepareCalls += 1;
    return { rawTransaction: '0x01', hash: transactionHash, senderNonce: '7', requestNonce: '9', requestHash };
  }
  async broadcast(_raw: Hex): Promise<unknown> {
    this.broadcastCalls += 1;
    if (this.broadcastFailure) throw this.broadcastFailure;
    return transactionHash;
  }
  async outcome(_task: Task, _hash: Hex): Promise<unknown> {
    this.outcomeCalls += 1;
    return this.outcomeValues.shift() ?? null;
  }
}

describe('Sepolia one-wei policy write smoke', () => {
  it('verifies the signed transaction, Wallet transfer, PolicyEngine event, balances and budget', async () => {
    const gateway = new FakeWriteGateway();
    const report = await runSepoliaPolicyWriteCheck(config(), gateway, { sleep: async () => undefined });
    expect(report).toMatchObject({
      ok: true, readOnly: false, amountWei: '1', costUsd6: '1', transactionHash, requestHash,
      broadcastAcknowledged: true,
      evidence: { walletTransfer: true, budgetConsumed: true, requestHashBound: true },
    });
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.broadcastCalls).toBe(1);
  });

  it('polls the same deterministic hash after an accepted-then-timeout without signing or broadcasting twice', async () => {
    const gateway = new FakeWriteGateway(
      undefined, undefined, [null, outcome()], new Error('RPC response timed out'),
    );
    const report = await runSepoliaPolicyWriteCheck(config(), gateway, { pollIntervalMs: 0, sleep: async () => undefined });
    expect(report.broadcastAcknowledged).toBe(false);
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.broadcastCalls).toBe(1);
    expect(gateway.outcomeCalls).toBe(2);
  });

  it('fails closed on empty or malformed external chain responses and transport errors', async () => {
    await expect(runSepoliaPolicyWriteCheck(config(), new FakeWriteGateway([{}]))).rejects.toThrow();
    await expect(runSepoliaPolicyWriteCheck(config(), new FakeWriteGateway(undefined, {}))).rejects.toThrow();
    await expect(runSepoliaPolicyWriteCheck(config(), new FakeWriteGateway(undefined, undefined, [{}]))).rejects.toThrow();
    await expect(runSepoliaPolicyWriteCheck(config(), new FakeWriteGateway(undefined, undefined, undefined, undefined, new Error('RPC unavailable')))).rejects.toThrow('RPC unavailable');
  });

  it('does not sign blocked or mismatched previews', async () => {
    const blocked = new FakeWriteGateway(undefined, quote({ status: 'BLOCKED', decision: 'BLOCK', reasonCodes: ['DAILY_LIMIT'] }));
    await expect(runSepoliaPolicyWriteCheck(config(), blocked)).rejects.toThrow('not AUTO/READY');
    expect(blocked.prepareCalls).toBe(0);

    const mismatched = new FakeWriteGateway(undefined, quote({ recipient: ownerAddress }));
    await expect(runSepoliaPolicyWriteCheck(config(), mismatched)).rejects.toThrow('does not match');
    expect(mismatched.prepareCalls).toBe(0);
  });

  it('rejects invalid timing boundaries before any chain call', async () => {
    const gateway = new FakeWriteGateway();
    await expect(runSepoliaPolicyWriteCheck(config(), gateway, { timeoutMs: 999 })).rejects.toThrow();
    expect(gateway.prepareCalls).toBe(0);
    expect(gateway.broadcastCalls).toBe(0);
  });
});
