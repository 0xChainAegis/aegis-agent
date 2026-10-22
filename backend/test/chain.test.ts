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
import {
  POLICY_EVIDENCE_VERIFICATION_SCOPE, POLICY_EVIDENCE_VERIFIED_FIELDS, type Task,
} from '@aegis/shared';
import { ViemGateway, policyEngineAbi, walletAbi } from '../src/chain.js';
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
const policyEngine = '0x7000000000000000000000000000000000000007' as Address;
const requestHash = keccak256(toHex('gateway-bound-request'));
const transactionHash = keccak256(toHex('gateway-transaction'));
const blockHash = keccak256(toHex('gateway-block'));

function gatewayConfig(): Config {
  return {
    ...loadConfig({}), deploymentReady: true, walletAddress: wallet,
    ownerAddress: owner, agentAddress: agent.address, recipientAddress: recipient,
    aclAddress: acl, attestationAddress: attestation, oracleAddress: oracle, policyEngineAddress: policyEngine, feedAddress: feed,
  };
}

function readinessHarness(options: { attestation?: Address; locked?: boolean; policyEngine?: Address; policyOwner?: Address; policyAuthorized?: boolean; stale?: boolean; authorized?: boolean; chainId?: number } = {}) {
  const gateway = new ViemGateway(gatewayConfig());
  const client = gateway.publicClient as any;
  const bytecodeReads: Address[] = [];
  client.getChainId = async () => options.chainId ?? 31337;
  client.getBytecode = async ({ address }: { address: Address }) => { bytecodeReads.push(address); return '0x01'; };
  client.getBlock = async () => ({ number: 42n, hash: blockHash, timestamp: 1_700_000_000n });
  client.getBalance = async ({ address }: { address: Address }) => address === recipient ? 0n : 1n;
  client.readContract = async ({ address, functionName }: { address: Address; functionName: string }) => {
    switch (functionName) {
      case 'owner': return address === policyEngine ? options.policyOwner ?? owner : owner;
      case 'acl': return acl;
      case 'attestations': return options.attestation ?? attestation;
      case 'oracle': return oracle;
      case 'policyEngine': return options.policyEngine ?? policyEngine;
      case 'authorizedConsumers': case 'policyManagers': return options.policyAuthorized ?? true;
      case 'feeds': return feed;
      case 'configurationLocked': return options.locked ?? true;
      case 'AGENT_ROLE': case 'ATTESTER_ROLE': case 'APPROVER_ROLE': return requestHash;
      case 'hasRole': return options.authorized ?? true;
      case 'tierOf': return 2;
      case 'policyVersion': return 7n;
      case 'autoLimitUsd6': return 5_000_000n;
      case 'perTxLimitUsd6': return 10_000_000n;
      case 'dailyLimitUsd6': return 20_000_000n;
      case 'spendingToday': return [4_000_000n, 16_000_000n];
      case 'latestEthQuote': return [1n, 1n, 300_000_000_000n, options.stale ? 1_699_990_000n : 1_699_999_999n, 8];
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

test('stale readiness preserves read-only identity proofs only after all structural and role checks', async () => {
  const stale = await readinessHarness({ stale: true }).gateway.readiness();
  assert.equal(stale.ready, false);
  assert.equal(stale.code, 'FEED_STALE');
  assert.equal('rpcChainId' in stale && stale.rpcChainId, 31337);
  assert.equal('deploymentBindingsVerified' in stale && stale.deploymentBindingsVerified, true);
  assert.equal('feedFresh' in stale && stale.feedFresh, false);
  for (const options of [{ stale: true, authorized: false }, { stale: true, attestation: otherContract }, { stale: true, chainId: 1 }]) {
    const failed = await readinessHarness(options).gateway.readiness();
    assert.equal(failed.ready, false);
    assert.equal('rpcChainId' in failed, false);
    assert.equal('deploymentBindingsVerified' in failed, false);
  }
});

test('ViemGateway readiness fails closed for changed bindings or unlocked feed', async () => {
  const changed = await readinessHarness({ attestation: otherContract }).gateway.readiness();
  assert.equal(changed.ready, false);
  assert.equal(changed.code, 'DEPLOYMENT_BINDING_MISMATCH');

  const unlocked = await readinessHarness({ locked: false }).gateway.readiness();
  assert.equal(unlocked.ready, false);
  assert.equal(unlocked.code, 'ORACLE_CONFIGURATION_CHANGED');

  const wrongPolicy = await readinessHarness({ policyEngine: otherContract }).gateway.readiness();
  assert.equal(wrongPolicy.ready, false);
  assert.equal(wrongPolicy.code, 'DEPLOYMENT_BINDING_MISMATCH');

  const unauthorizedPolicy = await readinessHarness({ policyAuthorized: false }).gateway.readiness();
  assert.equal(unauthorizedPolicy.ready, false);
  assert.equal(unauthorizedPolicy.code, 'POLICY_ENGINE_MISMATCH');

  const wrongPolicyOwner = await readinessHarness({ policyOwner: otherContract }).gateway.readiness();
  assert.equal(wrongPolicyOwner.ready, false);
  assert.equal(wrongPolicyOwner.code, 'POLICY_ENGINE_MISMATCH');
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

function executedLog(current: Task, options: { address?: Address; hash?: Hex; costUsd6?: bigint } = {}) {
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
      [recipient, BigInt(current.amountWei), options.costUsd6 ?? 3_000_000n, 1n, 1_999_999_999n, BigInt(current.policyVersion)],
    ),
    logIndex: 1,
  };
}

function budgetLog(current: Task, options: {
  address?: Address; hash?: Hex; actor?: Address; actionType?: number;
  decision?: number; costUsd6?: bigint; spentUsd6?: bigint;
} = {}) {
  return {
    address: options.address ?? policyEngine,
    topics: encodeEventTopics({
      abi: policyEngineAbi,
      eventName: 'BudgetConsumed',
      args: {
        requestHash: options.hash ?? current.requestHash!,
        actionType: options.actionType ?? 0,
        actor: options.actor ?? agent.address,
      },
    }),
    data: encodeAbiParameters(
      parseAbiParameters('uint8,uint256,uint256,uint256'),
      [options.decision ?? 1, options.costUsd6 ?? 3_000_000n, 20_000n, options.spentUsd6 ?? 3_000_000n],
    ),
    logIndex: 0,
  };
}

function queuedLog(current: Task) {
  return {
    address: wallet,
    topics: encodeEventTopics({
      abi: walletAbi,
      eventName: 'NativeTransferQueued',
      args: { requestHash: current.requestHash!, attestationId: 1n, agent: agent.address },
    }),
    data: encodeAbiParameters(
      parseAbiParameters('address,uint256,uint256,uint64,uint64'),
      [recipient, BigInt(current.amountWei), BigInt(current.maxUsdCost6), BigInt(current.requestDeadlineSeconds), BigInt(current.policyVersion)],
    ),
    logIndex: 0,
  };
}

function harness(options: {
  from?: Address; to?: Address | null; input?: Hex; value?: bigint;
  receiptStatus?: 'success' | 'reverted'; logs?: Array<ReturnType<typeof executedLog> | ReturnType<typeof budgetLog> | ReturnType<typeof queuedLog>>;
  missingReceipt?: boolean; role?: 'request' | 'approve';
  priceSource?: Pick<Config, 'oracleAddress' | 'feedAddress'>;
} = {}) {
  const current = task();
  if (options.role === 'approve') current.attestationId = '1';
  const gateway = new ViemGateway({ ...gatewayConfig(), ...options.priceSource });
  const client = gateway.publicClient as any;
  client.getChainId = async () => 31337;
  client.getTransactionReceipt = async () => {
    if (options.missingReceipt) throw new Error('Transaction receipt could not be found');
    return {
      status: options.receiptStatus ?? 'success', blockNumber: 2n, blockHash,
      logs: options.logs ?? [budgetLog(current, { decision: options.role === 'approve' ? 2 : 1 }), executedLog(current)],
    };
  };
  client.getTransaction = async () => ({
    from: options.from ?? (options.role === 'approve' ? owner : agent.address),
    to: options.to === undefined ? wallet : options.to,
    input: options.input ?? (options.role === 'approve'
      ? encodeFunctionData({ abi: walletAbi, functionName: 'approveAndExecute', args: [1n] })
      : requestInput(current)),
    value: options.value ?? 0n,
    nonce: 7,
  });
  return { current, gateway };
}

test('ViemGateway outcome binds matching Wallet and PolicyEngine evidence', async () => {
  const { current, gateway } = harness();
  const outcome = await gateway.outcome(current, transactionHash, 'request');
  assert.equal(outcome?.status, 'EXECUTED');
  assert.equal(outcome?.attestationId, '1');
  assert.equal(outcome?.transaction.event, 'NativeTransferExecuted');
  assert.equal(outcome?.eventData?.requestHash, requestHash);
  assert.equal(outcome?.eventData?.amountWei, current.amountWei);
  assert.equal(outcome?.policyEvidence?.decision, 'ALLOW');
  assert.equal(outcome?.policyEvidence?.costUsd6, '3000000');
  assert.equal(outcome?.policyEvidence?.spentUsd6, '3000000');
  assert.equal(outcome?.policyEvidence?.engineAddress, policyEngine);
  assert.equal(outcome?.policyEvidence?.policyVersion, current.policyVersion);
  assert.equal(outcome?.policyEvidence?.roundId, '1');
  assert.equal(outcome?.policyEvidence?.updatedAtSeconds, '1999999999');
  assert.equal(outcome?.policyEvidence?.verified, true);
  assert.equal(outcome?.policyEvidence?.verificationScope, POLICY_EVIDENCE_VERIFICATION_SCOPE);
  assert.deepEqual(outcome?.policyEvidence?.verifiedFields, POLICY_EVIDENCE_VERIFIED_FIELDS);
});

test('recovering an old receipt under changed price-source configuration preserves only receipt facts', async () => {
  const original = harness();
  const changed = harness({ priceSource: { oracleAddress: otherContract, feedAddress: recipient } });
  const originalOutcome = await original.gateway.outcome(original.current, transactionHash, 'request');
  const recovered = await changed.gateway.outcome(changed.current, transactionHash, 'request');
  assert.equal(recovered?.status, 'EXECUTED');
  assert.ok(recovered?.policyEvidence);
  assert.deepEqual(recovered.policyEvidence, originalOutcome?.policyEvidence);
  assert.equal('oracleAddress' in recovered.policyEvidence, false);
  assert.equal('feedAddress' in recovered.policyEvidence, false);
});

test('ViemGateway records REQUIRE_APPROVAL for an owner execution', async () => {
  const { current, gateway } = harness({ role: 'approve' });
  const outcome = await gateway.outcome(current, transactionHash, 'approve');
  assert.equal(outcome?.status, 'EXECUTED');
  assert.equal(outcome?.policyEvidence?.decision, 'REQUIRE_APPROVAL');
});

test('ViemGateway accepts an ALLOW re-evaluation in an owner execution after risk falls', async () => {
  const base = task();
  const { current, gateway } = harness({ role: 'approve', logs: [budgetLog(base, { decision: 1 }), executedLog(base)] });
  const outcome = await gateway.outcome(current, transactionHash, 'approve');
  assert.equal(outcome?.status, 'EXECUTED');
  assert.equal(outcome?.policyEvidence?.decision, 'ALLOW');
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
    { name: 'wrong request hash', logs: [budgetLog(base), executedLog(base, { hash: keccak256(toHex('another request')) })] },
    { name: 'foreign contract log', logs: [budgetLog(base), executedLog(base, { address: otherContract })] },
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

test('ViemGateway fails closed for missing or mismatched PolicyEngine evidence', async t => {
  const current = task();
  const cases = [
    { name: 'missing event', logs: [executedLog(current)], reason: 'POLICY_EVENT_MISSING' },
    { name: 'foreign engine', logs: [budgetLog(current, { address: otherContract }), executedLog(current)], reason: 'POLICY_EVENT_MISSING' },
    { name: 'wrong request hash', logs: [budgetLog(current, { hash: keccak256(toHex('wrong policy request')) }), executedLog(current)], reason: 'POLICY_EVENT_MISMATCH' },
    { name: 'wrong actor', logs: [budgetLog(current, { actor: recipient }), executedLog(current)], reason: 'POLICY_EVENT_MISMATCH' },
    { name: 'wrong decision', logs: [budgetLog(current, { decision: 2 }), executedLog(current)], reason: 'POLICY_EVENT_MISMATCH' },
    { name: 'cost mismatch', logs: [budgetLog(current, { costUsd6: 4_000_000n }), executedLog(current)], reason: 'POLICY_EVENT_MISMATCH' },
    { name: 'invalid cumulative spend', logs: [budgetLog(current, { spentUsd6: 2_000_000n }), executedLog(current)], reason: 'POLICY_EVENT_MISMATCH' },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { current: bound, gateway } = harness({ logs: entry.logs });
      const outcome = await gateway.outcome(bound, transactionHash, 'request');
      assert.equal(outcome?.status, 'FAILED');
      assert.equal(outcome?.reasonCode, entry.reason);
    });
  }
});

test('ViemGateway treats queued requests as unconsumed and rejects an unexpected budget event', async () => {
  const base = task();
  const queued = harness({ logs: [queuedLog(base)] });
  const waiting = await queued.gateway.outcome(queued.current, transactionHash, 'request');
  assert.equal(waiting?.status, 'AWAITING_APPROVAL');
  assert.equal(waiting?.policyEvidence, undefined);

  const inconsistent = harness({ logs: [budgetLog(base), queuedLog(base)] });
  const failed = await inconsistent.gateway.outcome(inconsistent.current, transactionHash, 'request');
  assert.equal(failed?.status, 'FAILED');
  assert.equal(failed?.reasonCode, 'UNEXPECTED_POLICY_EVENT');
});

test('ViemGateway keeps an unmined transaction pending and reports a reverted receipt as failed', async () => {
  const pending = harness({ missingReceipt: true });
  assert.equal(await pending.gateway.outcome(pending.current, transactionHash, 'request'), null);

  const reverted = harness({ receiptStatus: 'reverted', logs: [] });
  const outcome = await reverted.gateway.outcome(reverted.current, transactionHash, 'request');
  assert.equal(outcome?.status, 'FAILED');
  assert.equal(outcome?.reasonCode, 'TX_REVERTED');
});
