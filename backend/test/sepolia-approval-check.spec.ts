import { describe, expect, it } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { loadConfig, type Config } from '../src/config.js';
import {
  runSepoliaApprovalCheck, type SepoliaApprovalQueue, type SepoliaApprovalReader,
} from '../src/sepolia-approval-check.js';

const wallet = getAddress('0x1000000000000000000000000000000000000001');
const agent = getAddress('0x2000000000000000000000000000000000000002');
const recipient = getAddress('0x3000000000000000000000000000000000000003');
const queueHash = `0x${'11'.repeat(32)}` as Hex;
const approvalHash = `0x${'22'.repeat(32)}` as Hex;
const requestHash = `0x${'33'.repeat(32)}` as Hex;

function config(): Config {
  return {
    ...loadConfig({}), mode: 'testnet', chainId: 11155111,
    walletAddress: wallet, agentAddress: agent, recipientAddress: recipient,
  };
}

function queued(overrides: Partial<SepoliaApprovalQueue> = {}): SepoliaApprovalQueue {
  return {
    transactionHash: queueHash, requestHash, attestationId: 0n, requester: agent, recipient,
    amountWei: 1n, maxUsdCost6: 1n, requestNonce: 0n, deadline: 2_000_000_000n,
    policyVersion: 2n, senderNonce: 7n, ...overrides,
  };
}

function approved(overrides: Record<string, unknown> = {}) {
  return {
    status: 'EXECUTED', attestationId: '0',
    transaction: { hash: approvalHash, receiptStatus: 1, event: 'NativeTransferExecuted', finality: 'mined' },
    policyEvidence: {
      event: 'BudgetConsumed', decision: 'REQUIRE_APPROVAL', requestHash, actor: agent,
      costUsd6: '1', transactionHash: approvalHash, verified: true,
    },
    eventData: { to: recipient, amountWei: '1', requestHash, attestationId: '0' },
    ...overrides,
  };
}

class FakeReader implements SepoliaApprovalReader {
  constructor(private readonly queueResult: unknown, private readonly approvalResult: unknown, private readonly failure?: Error) {}
  async queued(): Promise<unknown> {
    if (this.failure) throw this.failure;
    return this.queueResult;
  }
  async approved(): Promise<unknown> { return this.approvalResult; }
}

describe('Sepolia Owner approval evidence', () => {
  it('binds queue, Owner execution, Wallet event and REQUIRE_APPROVAL budget evidence', async () => {
    const report = await runSepoliaApprovalCheck(config(), new FakeReader(queued(), approved()), queueHash, approvalHash);
    expect(report).toMatchObject({
      ok: true, readOnly: true, chainId: 11155111, attestationId: '0', amountWei: '1', costUsd6: '1',
      finalPolicyDecision: 'REQUIRE_APPROVAL',
      evidence: { queueBound: true, ownerTransactionBound: true, walletTransfer: true, approvalBudgetConsumed: true, requestHashBound: true },
    });
  });

  it('rejects empty external queue or approval responses', async () => {
    await expect(runSepoliaApprovalCheck(config(), new FakeReader({}, approved()), queueHash, approvalHash)).rejects.toThrow();
    await expect(runSepoliaApprovalCheck(config(), new FakeReader(queued(), null), queueHash, approvalHash)).rejects.toThrow();
  });

  it('accepts a safe ALLOW re-evaluation after queuing and reports the final decision', async () => {
    const report = await runSepoliaApprovalCheck(
      config(), new FakeReader(queued(), approved({ policyEvidence: { ...approved().policyEvidence, decision: 'ALLOW' } })),
      queueHash, approvalHash,
    );
    expect(report.finalPolicyDecision).toBe('ALLOW');
  });

  it('rejects mismatched actors and unsupported budget decisions', async () => {
    await expect(runSepoliaApprovalCheck(
      config(), new FakeReader(queued(), approved({ policyEvidence: { ...approved().policyEvidence, decision: 'REJECT' } })),
      queueHash, approvalHash,
    )).rejects.toThrow();
    await expect(runSepoliaApprovalCheck(
      config(), new FakeReader(queued({ requester: recipient }), approved()), queueHash, approvalHash,
    )).rejects.toThrow('configured executor');
  });

  it('propagates RPC failures without fabricating an evidence report', async () => {
    await expect(runSepoliaApprovalCheck(
      config(), new FakeReader(queued(), approved(), new Error('RPC timeout')), queueHash, approvalHash,
    )).rejects.toThrow('RPC timeout');
  });
});
