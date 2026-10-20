import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Task } from '@aegis/shared';
import { ViemGateway, walletAbi } from '../src/chain.js';
import { loadConfig, LOCAL_AGENT_KEY, type Config } from '../src/config.js';
import { ApiError } from '../src/errors.js';

const agent = privateKeyToAccount(LOCAL_AGENT_KEY);
const owner = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const recipient = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const wallet = '0x1000000000000000000000000000000000000001' as Address;
const otherContract = '0x2000000000000000000000000000000000000002' as Address;
const acl = '0x3000000000000000000000000000000000000003' as Address;
const attestation = '0x4000000000000000000000000000000000000004' as Address;
const oracle = '0x5000000000000000000000000000000000000005' as Address;
const feed = '0x6000000000000000000000000000000000000006' as Address;
const requestHash = keccak256(toHex('gateway-bound-request'));
const transactionHash = keccak256(toHex('gateway-transaction'));
const blockHash = keccak256(toHex('gateway-block'));

function gatewayConfig(): Config {
  return {
    ...loadConfig({}), deploymentReady: true, walletAddress: wallet,
    ownerAddress: owner, agentAddress: agent.address, recipientAddress: recipient,
    aclAddress: acl, attestationAddress: attestation, oracleAddress: oracle, feedAddress: feed,
  };
}

function readinessHarness(options: { attestation?: Address; locked?: boolean } = {}) {
  const gateway = new ViemGateway(gatewayConfig());
  const client = gateway.publicClient as any;
  const bytecodeReads: Address[] = [];
  client.getChainId = async () => 31337;
  client.getBytecode = async ({ address }: { address: Address }) => { bytecodeReads.push(address); return '0x01'; };
  client.getBlock = async () => ({ number: 42n, hash: blockHash, timestamp: 1_700_000_000n });
  client.getBalance = async ({ address }: { address: Address }) => address === recipient ? 0n : 1n;
  client.readContract = async ({ address, functionName }: { address: Address; functionName: string }) => {
    switch (functionName) {
      case 'owner': return owner;
      case 'acl': return acl;
      case 'attestations': return options.attestation ?? attestation;
      case 'oracle': return oracle;
      case 'feeds': return feed;
      case 'configurationLocked': return options.locked ?? true;
      case 'AGENT_ROLE': case 'ATTESTER_ROLE': case 'APPROVER_ROLE': return requestHash;
      case 'hasRole': return true;
      case 'tierOf': return 2;
      case 'policyVersion': return 7n;
      case 'autoLimitUsd6': return 5_000_000n;
      case 'perTxLimitUsd6': return 10_000_000n;
      case 'dailyLimitUsd6': return 20_000_000n;
      case 'spendingToday': return [4_000_000n, 16_000_000n];
      case 'latestEthQuote': return [1n, 1n, 300_000_000_000n, 1_699_999_999n, 8];
      case 'maxPriceAge': return 3600n;
      default: throw new Error(`Unexpected contract read: ${address} ${functionName}`);
    }
  };
  return { gateway, bytecodeReads };
}

test('ViemGateway readiness verifies all bytecode, bindings, roles, and locked feed', async () => {
  const { gateway, bytecodeReads } = readinessHarness();
  const result = await gateway.readiness();
  assert.equal(result.ready, true);
  assert.equal('deploymentBindingsVerified' in result && result.deploymentBindingsVerified, true);
  assert.ok(bytecodeReads.includes(attestation));
});

test('ViemGateway readiness fails closed for changed bindings or unlocked feed', async () => {
  const changed = await readinessHarness({ attestation: otherContract }).gateway.readiness();
  assert.equal(changed.ready, false);
  assert.equal(changed.code, 'DEPLOYMENT_BINDING_MISMATCH');

  const unlocked = await readinessHarness({ locked: false }).gateway.readiness();
  assert.equal(unlocked.ready, false);
  assert.equal(unlocked.code, 'ORACLE_CONFIGURATION_CHANGED');
});

test('ViemGateway snapshot binds distinct balances and contract reads to one observed block', async () => {
  const gateway = new ViemGateway(gatewayConfig());
  const client = gateway.publicClient as any;
  const observedBlockNumber = 42n;
  const balanceReads: Array<{ address: Address; blockNumber: bigint }> = [];
  const contractReads: Array<{ functionName: string; blockNumber: bigint }> = [];
  const balances = new Map<string, bigint>([
    [wallet.toLowerCase(), 11n],
    [agent.address.toLowerCase(), 22n],
    [recipient.toLowerCase(), 33n],
  ]);

  client.getChainId = async () => 31337;
  client.getBlock = async () => ({ number: observedBlockNumber, hash: blockHash, timestamp: 1_700_000_000n });
  client.getBalance = async ({ address, blockNumber }: { address: Address; blockNumber: bigint }) => {
    balanceReads.push({ address, blockNumber });
    return balances.get(address.toLowerCase())!;
  };
  client.readContract = async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
    contractReads.push({ functionName, blockNumber });
    switch (functionName) {
      case 'policyVersion': return 7n;
      case 'autoLimitUsd6': return 5_000_000n;
      case 'perTxLimitUsd6': return 10_000_000n;
      case 'dailyLimitUsd6': return 20_000_000n;
      case 'spendingToday': return [4_000_000n, 16_000_000n];
      default: throw new Error(`Unexpected contract read: ${functionName}`);
    }
  };

  const snapshot = await gateway.snapshot();

  assert.equal(snapshot.recipientAddress, recipient);
  assert.equal(snapshot.walletBalanceWei, '11');
  assert.equal(snapshot.agentBalanceWei, '22');
  assert.equal(snapshot.recipientBalanceWei, '33');
  assert.equal(snapshot.observedBlockNumber, observedBlockNumber.toString());
  assert.equal(snapshot.observedBlockHash, blockHash);
  assert.deepEqual(balanceReads, [
    { address: wallet, blockNumber: observedBlockNumber },
    { address: agent.address, blockNumber: observedBlockNumber },
    { address: recipient, blockNumber: observedBlockNumber },
  ]);
  assert.equal(contractReads.length, 5);
  assert.ok(contractReads.every(read => read.blockNumber === observedBlockNumber));
});

function task(): Task {
  const now = new Date().toISOString();
  return {
    taskId: 'task-gateway', draftId: 'draft-gateway', intentId: 'draft-gateway', draftVersion: 1, stateVersion: 1,
    status: 'BROADCAST', chainId: 31337, walletAddress: wallet, ownerAddress: owner, agentAddress: agent.address,
    recipient, to: recipient, amountWei: '1000000000000000', maxUsdCost6: '3030000', previewCostUsd6: '3000000',
    requestDeadlineSeconds: 2_000_000_000, policyVersion: '1', requestNonce: '0', requestHash,
    attestationId: null, txHash: transactionHash, triggerType: 'manual', ruleId: null, reasonCodes: [], transactions: [],
    availableActions: [], createdAt: now, updatedAt: now,
    parser: { kind: 'rule_parser', model: null, configuredModel: null, fallback: false, reason: 'test fixture' },
    verification: { kind: 'chain', chainVerified: false, hashVerified: false },
  };
}

function requestInput(current: Task) {
  return encodeFunctionData({
    abi: walletAbi,
    functionName: 'requestNativeTransfer',
    args: [
      current.recipient, BigInt(current.amountWei), BigInt(current.maxUsdCost6), BigInt(current.requestNonce!),
      BigInt(current.requestDeadlineSeconds), BigInt(current.policyVersion),
    ],
  });
}

function executedLog(current: Task, options: { address?: Address; hash?: Hex } = {}) {
  const hash = options.hash ?? current.requestHash!;
  return {
    address: options.address ?? wallet,
    topics: encodeEventTopics({
      abi: walletAbi,
      eventName: 'NativeTransferExecuted',
      args: { requestHash: hash, attestationId: 1n, agent: agent.address },
    }),
    data: encodeAbiParameters(
      parseAbiParameters('address,uint256,uint256,uint80,uint256,uint64'),
      [recipient, BigInt(current.amountWei), 3_000_000n, 1n, 1_999_999_999n, BigInt(current.policyVersion)],
    ),
  };
}

function harness(options: {
  from?: Address; to?: Address | null; input?: Hex; value?: bigint;
  receiptStatus?: 'success' | 'reverted'; logs?: ReturnType<typeof executedLog>[];
  missingReceipt?: boolean;
} = {}) {
  const current = task();
  const gateway = new ViemGateway(gatewayConfig());
  const client = gateway.publicClient as any;
  client.getChainId = async () => 31337;
  client.getTransactionReceipt = async () => {
    if (options.missingReceipt) throw new Error('Transaction receipt could not be found');
    return {
      status: options.receiptStatus ?? 'success', blockNumber: 2n, blockHash,
      logs: options.logs ?? [executedLog(current)],
    };
  };
  client.getTransaction = async () => ({
    from: options.from ?? agent.address,
    to: options.to === undefined ? wallet : options.to,
    input: options.input ?? requestInput(current),
    value: options.value ?? 0n,
    nonce: 7,
  });
  return { current, gateway };
}

test('ViemGateway outcome accepts only a bound transaction with the matching wallet event', async () => {
  const { current, gateway } = harness();
  const outcome = await gateway.outcome(current, transactionHash, 'request');
  assert.equal(outcome?.status, 'EXECUTED');
  assert.equal(outcome?.attestationId, '1');
  assert.equal(outcome?.transaction.event, 'NativeTransferExecuted');
  assert.equal(outcome?.eventData?.requestHash, requestHash);
  assert.equal(outcome?.eventData?.amountWei, current.amountWei);
});

test('ViemGateway rejects transaction sender, target, calldata, and value mismatches', async t => {
  const cases = [
    { name: 'sender', options: { from: recipient } },
    { name: 'target', options: { to: otherContract } },
    { name: 'calldata', options: { input: '0x1234' as Hex } },
    { name: 'value', options: { value: 1n } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { current, gateway } = harness(entry.options);
      await assert.rejects(
        gateway.outcome(current, transactionHash, 'request'),
        error => error instanceof ApiError && error.code === 'TX_BINDING_MISMATCH',
      );
    });
  }
});

test('ViemGateway does not accept wrong hashes, foreign contract logs, or missing business events', async t => {
  const base = task();
  const cases = [
    { name: 'wrong request hash', logs: [executedLog(base, { hash: keccak256(toHex('another request')) })] },
    { name: 'foreign contract log', logs: [executedLog(base, { address: otherContract })] },
    { name: 'no business event', logs: [] },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { current, gateway } = harness({ logs: entry.logs });
      const outcome = await gateway.outcome(current, transactionHash, 'request');
      assert.equal(outcome?.status, 'FAILED');
      assert.equal(outcome?.reasonCode, 'EXPECTED_EVENT_MISSING');
    });
  }
});

test('ViemGateway keeps an unmined transaction pending and reports a reverted receipt as failed', async () => {
  const pending = harness({ missingReceipt: true });
  assert.equal(await pending.gateway.outcome(pending.current, transactionHash, 'request'), null);

  const reverted = harness({ receiptStatus: 'reverted', logs: [] });
  const outcome = await reverted.gateway.outcome(reverted.current, transactionHash, 'request');
  assert.equal(outcome?.status, 'FAILED');
  assert.equal(outcome?.reasonCode, 'TX_REVERTED');
});
