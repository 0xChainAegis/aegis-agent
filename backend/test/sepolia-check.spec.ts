import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Task } from '@aegis/shared';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { Gateway, Outcome, Prepared, Quote, Snapshot } from '../src/chain.js';
import { runSepoliaCheck } from '../src/sepolia-check.js';

const address = '0x1000000000000000000000000000000000000001' as Address;
const blockHash = `0x${'11'.repeat(32)}` as Hex;

function testnetConfig(): Config {
  return {
    ...loadConfig({ AEGIS_MODE: 'mock' }), mode: 'testnet', chainId: 11155111,
    ccipSenderAddress: undefined, ccipRouterAddress: undefined, ccipTokenAddress: undefined,
    ccipTokenFeedAddress: undefined, ccipDestinationChainSelector: undefined,
    ccipDestinationChainId: undefined, ccipDestinationNetwork: undefined,
    ccipDestinationTokenAddress: undefined, ccipTokenPriceSource: undefined,
  };
}

function snapshot(): Snapshot {
  return {
    chainId: 11155111, walletAddress: address, ownerAddress: address, agentAddress: address, recipientAddress: address,
    walletBalanceWei: '1', agentBalanceWei: '1', recipientBalanceWei: '0', policyVersion: '2',
    budget: { autoThresholdUsd6: '1', hardPerTxUsd6: '2', dailyLimitUsd6: '3', spentTodayUsd6: '0', remainingUsd6: '3', window: 'UTC_CALENDAR_DAY' },
    observedBlockNumber: '42', observedBlockHash: blockHash, observedAt: new Date(0).toISOString(), dataSource: 'chain',
  };
}

class FakeGateway implements Gateway {
  constructor(private readonly readinessValue: Record<string, unknown>, private readonly snapshotValue: Snapshot = snapshot(), private readonly ccipReady = false) {}
  async readiness(): Promise<Record<string, unknown>> { return this.readinessValue; }
  async snapshot(): Promise<Snapshot> { return this.snapshotValue; }
  async preview(): Promise<Omit<Quote, 'quoteId' | 'draftId' | 'draftVersion'>> { throw new Error('unused'); }
  async prepare(_task: Task): Promise<Prepared> { throw new Error('unused'); }
  async broadcast(_raw: Hex): Promise<Hex> { throw new Error('unused'); }
  async outcome(_task: Task, _hash: Hex, _role: 'request' | 'approve' | 'cancel'): Promise<Outcome | null> { throw new Error('unused'); }
  ownerTx(_task: Task, _action: 'approve' | 'cancel'): never { throw new Error('unused'); }
  async ccipEnabled(): Promise<boolean> { return this.ccipReady; }
}

describe('runSepoliaCheck', () => {
  it('returns a sanitized successful report for a ready Sepolia deployment', async () => {
    const report = await runSepoliaCheck(testnetConfig(), new FakeGateway({ ready: true, feedFresh: true }));
    expect(report.ok).toBe(true);
    expect(report.snapshot?.observedBlockNumber).toBe('42');
    expect(report.ccip).toEqual({ configured: false, ready: false });
    expect(JSON.stringify(report)).not.toContain('rpcUrl');
  });

  it('requires the configured CCIP route to pass its on-chain preflight', async () => {
    const config = { ...testnetConfig(), ccipSenderAddress: address };
    await expect(runSepoliaCheck(config, new FakeGateway({ ready: true, feedFresh: true }, snapshot(), false))).resolves.toMatchObject({ ok: false, ccip: { configured: true, ready: false } });
    await expect(runSepoliaCheck(config, new FakeGateway({ ready: true, feedFresh: true }, snapshot(), true))).resolves.toMatchObject({ ok: true, ccip: { configured: true, ready: true } });
  });

  it('keeps a valid not-ready result without requesting a snapshot', async () => {
    const report = await runSepoliaCheck(testnetConfig(), new FakeGateway({ ready: false, code: 'FUNDING_REQUIRED', message: 'fund test wallets' }));
    expect(report.ok).toBe(false);
    expect(report.snapshot).toBeUndefined();
  });

  it('rejects empty or malformed RPC-derived readiness data', async () => {
    await expect(runSepoliaCheck(testnetConfig(), new FakeGateway({}))).rejects.toThrow();
  });

  it('rejects the non-Sepolia boundary before making chain calls', async () => {
    const config = { ...testnetConfig(), chainId: 31337 };
    await expect(runSepoliaCheck(config, new FakeGateway({ ready: true }))).rejects.toThrow('chainId 11155111');
  });
});
