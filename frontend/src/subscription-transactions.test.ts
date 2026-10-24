import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import * as subscriptions from './subscriptions';

const wallet = '0x1000000000000000000000000000000000000001';
const owner = '0x2000000000000000000000000000000000000002';
const agent = '0x3000000000000000000000000000000000000003';
const recipient = '0x4000000000000000000000000000000000000004';
const planHash = `0x${'1'.repeat(64)}` as `0x${string}`;
const abi = parseAbi(['function configureSubscriptionPolicy(uint256 maxPeriodCapUsd6,uint64 maxDurationSeconds,uint64 maxPayments)', 'function createFiniteSubscription(address agent,address to,uint256 amountWei,uint64 periodSeconds,uint64 startAt,uint64 endAt,uint64 maxPayments,uint256 periodCapUsd6,bytes32 parentPlanHash)', 'function pauseFiniteSubscription(uint64 subscriptionId,bool paused)', 'function cancelFiniteSubscription(uint64 subscriptionId)']);
const plan = { recipient, amountWei: '100', periodSeconds: '60', startAtSeconds: '1700000000', endAtSeconds: '1700003600', maxPayments: '3', periodCapUsd6: '5000000' };
const config = { mode: 'local_chain', chainId: 31337, ownerAddress: owner, walletAddress: wallet, agentAddress: agent, capabilities: { subscriptions: true } };
const transaction = { from: owner, to: wallet, value: '0', chainId: 31337, data: encodeFunctionData({ abi, functionName: 'createFiniteSubscription', args: [agent, recipient, 100n, 60n, 1700000000n, 1700003600n, 3n, 5000000n, planHash] }) };
const sepoliaConfig = { ...config, mode: 'testnet', chainId: 11155111 };
const policy = { maxPeriodCapUsd6: '10000000', maxDurationSeconds: '2592000', maxPayments: '30' };
const policyTransaction = { from: owner, to: wallet, value: '0', chainId: 11155111, data: encodeFunctionData({ abi, functionName: 'configureSubscriptionPolicy', args: [10000000n, 2592000n, 30n] }) };
describe('subscription Owner transaction review', () => {
  it('validates exact local creation calldata', () => {
    expect(subscriptions.validateSubscriptionTransaction(config, { registrationId: 'r', planHash, status: 'READY', subscription: plan, transaction, quoteExpiresAtSeconds: 1700000100 }, plan, 'create')).toEqual(transaction);
  });
  it.each([
    { amountWei: '101' }, { recipient: owner }, { periodSeconds: '61' }, { endAtSeconds: '1700003601' }, { maxPayments: '4' }, { periodCapUsd6: '6000000' },
  ])('rejects configuration substitutions %j', patch => {
    expect(() => subscriptions.validateSubscriptionTransaction(config, { registrationId: 'r', planHash, status: 'READY', subscription: { ...plan, ...patch }, transaction, quoteExpiresAtSeconds: 1700000100 }, plan, 'create')).toThrow();
  });
  it.each([{ mode: 'mock' }, { chainId: 11155111 }, { capabilities: { subscriptions: false } }])('never signs on unsupported or inconsistent config %j', patch => {
    expect(() => subscriptions.validateSubscriptionTransaction({ ...config, ...patch }, { registrationId: 'r', planHash, status: 'READY', subscription: plan, transaction, quoteExpiresAtSeconds: 1700000100 }, plan, 'create')).toThrow();
  });
  it('accepts an exactly bound creation transaction on Ethereum Sepolia', () => {
    const sepoliaTransaction = { ...transaction, chainId: 11155111 };
    expect(subscriptions.validateSubscriptionTransaction(sepoliaConfig, { registrationId: 'r', planHash, status: 'READY', subscription: plan, transaction: sepoliaTransaction, quoteExpiresAtSeconds: 1700000100 }, plan, 'create')).toEqual(sepoliaTransaction);
  });
  it('accepts exact Sepolia policy setup and rejects value, calldata, or network substitutions', () => {
    const preview = { policyId: crypto.randomUUID(), policy, transaction: policyTransaction };
    expect(subscriptions.validateSubscriptionPolicyTransaction(sepoliaConfig, preview, policy)).toEqual(policyTransaction);
    expect(() => subscriptions.validateSubscriptionPolicyTransaction(sepoliaConfig, { ...preview, policy: { ...policy, maxPayments: '31' } }, policy)).toThrow();
    expect(() => subscriptions.validateSubscriptionPolicyTransaction(sepoliaConfig, { ...preview, transaction: { ...policyTransaction, data: '0x' } }, policy)).toThrow();
    expect(() => subscriptions.validateSubscriptionPolicyTransaction(sepoliaConfig, { ...preview, transaction: { ...policyTransaction, chainId: 31337 } }, policy)).toThrow();
  });
  it.each([
    {},
    { maxPeriodCapUsd6: '0', maxDurationSeconds: '2592000', maxPayments: '30' },
    { maxPeriodCapUsd6: '10000000', maxDurationSeconds: '', maxPayments: '30' },
    { maxPeriodCapUsd6: '10000000', maxDurationSeconds: '2592000', maxPayments: String(2n ** 64n) },
  ])('rejects empty, zero, malformed, and uint64-overflow policy input %j', candidate => {
    expect(subscriptions.subscriptionPolicyPreviewSchema.safeParse({ policyId: crypto.randomUUID(), policy: candidate, transaction: policyTransaction }).success).toBe(false);
  });
  it('validates pause, resume and irreversible cancellation methods and IDs', () => {
    for (const action of ['pause', 'resume', 'cancel'] as const) {
      const data = action === 'cancel' ? encodeFunctionData({ abi, functionName: 'cancelFiniteSubscription', args: [1n] }) : encodeFunctionData({ abi, functionName: 'pauseFiniteSubscription', args: [1n, action === 'pause'] });
      const preview = { controlId: 'c', subscriptionId: '1', action, transaction: { ...transaction, data } };
      expect(subscriptions.validateSubscriptionTransaction(config, preview, { subscriptionId: '1' }, action)).toEqual(preview.transaction);
      expect(() => subscriptions.validateSubscriptionTransaction(config, preview, { subscriptionId: '2' }, action)).toThrow();
    }
  });
  it.each([{ from: agent }, { to: recipient }, { value: '1' }, { data: '0x' }])('rejects unbound Owner transaction %j', patch => {
    expect(() => subscriptions.validateSubscriptionTransaction(config, { registrationId: 'r', planHash, status: 'READY', subscription: plan, transaction: { ...transaction, ...patch }, quoteExpiresAtSeconds: 1700000100 }, plan, 'create')).toThrow();
  });
});
export { abi, plan, planHash, config, transaction };
