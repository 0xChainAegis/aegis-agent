import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, encodeFunctionResult, parseAbi} from 'viem';
import {createLocalMockFeedMaintainer, requireLoopbackRpc, startLocalMockFeed} from './local-mock-feed.mjs';

const wallet = '0x1000000000000000000000000000000000000001';
const oracle = '0x2000000000000000000000000000000000000002';
const feed = '0x3000000000000000000000000000000000000003';
const owner = '0x4000000000000000000000000000000000000004';
const presenter = '0x5000000000000000000000000000000000000005';
const updater = '0x6000000000000000000000000000000000000006';
const bytecode = '0x6000600055';
const NOW = 1_700_000_000;
const abi = parseAbi([
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function updateAnswer(int256 answer)',
  'function owner() view returns (address)', 'function oracle() view returns (address)',
  'function maxPriceAge() view returns (uint256)', 'function feeds(address token) view returns (address)',
  'function configurationLocked() view returns (bool)',
]);
const config = {rpcUrl: 'http://127.0.0.1:8545', chainId: 31337, walletAddress: wallet, oracleAddress: oracle, feedAddress: feed, ownerAddress: owner, expectedBytecode: bytecode};

function harness(overrides = {}, configOverrides = {}) {
  const localConfig = {...config, ...configOverrides};
  const state = {chainId: 31337, code: bytecode, description: 'LOCAL MOCK ETH / USD', blockTime: NOW,
    updatedAt: NOW - 100, answer: 300_000_000_000n, round: 1n, maxAge: 3600n, boundFeed: feed,
    boundOwner: localConfig.ownerAddress, accounts: [localConfig.mockUpdaterAddress ?? localConfig.ownerAddress], ...overrides};
  const calls = [];
  const request = async (method, params = []) => {
    calls.push({method, params});
    if (method === 'eth_chainId') return `0x${state.chainId.toString(16)}`;
    if (method === 'eth_getCode') return state.code;
    if (method === 'eth_getBlockByNumber') return {timestamp: `0x${state.blockTime.toString(16)}`};
    if (method === 'eth_accounts') return state.accounts;
    if (method === 'eth_getTransactionReceipt') return {status: '0x1'};
    if (method === 'evm_mine') { state.blockTime = Math.max(state.blockTime + 1, NOW); return '0x0'; }
    const input = params[0];
    const decoded = decodeFunctionData({abi, data: input.data});
    if (method === 'eth_sendTransaction') {
      assert.equal(input.to, feed);
      assert.equal(input.from.toLowerCase(), (localConfig.mockUpdaterAddress ?? localConfig.ownerAddress).toLowerCase());
      assert.equal(input.value, '0x0');
      assert.equal(decoded.functionName, 'updateAnswer');
      assert.equal(decoded.args[0], state.answer, 'the existing answer must be retained');
      state.round++; state.updatedAt = state.blockTime = Math.max(state.blockTime + 1, NOW);
      return `0x${'ab'.repeat(32)}`;
    }
    assert.equal(method, 'eth_call', `unexpected RPC method ${method}`);
    const result = {
      description: state.description, owner: state.boundOwner, oracle, feeds: state.boundFeed, configurationLocked: true,
      maxPriceAge: state.maxAge,
      latestRoundData: [state.round, state.answer, BigInt(state.updatedAt), BigInt(state.updatedAt), state.round],
    }[decoded.functionName];
    return encodeFunctionResult({abi, functionName: decoded.functionName, result});
  };
  const keeper = createLocalMockFeedMaintainer(localConfig, {request, now: () => NOW * 1000, logger: {info() {}}});
  const writes = () => calls.filter(call => ['eth_sendTransaction', 'evm_mine'].includes(call.method));
  return {keeper, state, calls, writes};
}

test('testnet and mock modes do not read deployment files or contact any RPC', async () => {
  for (const mode of ['testnet', 'mock']) {
    let contacted = false;
    const keeper = await startLocalMockFeed({env: {AEGIS_MODE: mode}, root: '/missing', request: () => { contacted = true; }});
    assert.equal(keeper.enabled, false); await keeper.stop(); assert.equal(contacted, false);
  }
});

test('public/non-HTTP RPCs and credential-bearing URLs cannot be selected', () => {
  for (const rpcUrl of ['https://ethereum-sepolia.publicnode.com', 'http://127.0.0.1.example.com', 'file:///tmp/rpc', 'http://user:password@localhost:8545', 'http://localhost:8545/?upstream=public']) {
    let contacted = false;
    assert.throws(() => createLocalMockFeedMaintainer({...config, rpcUrl}, {request: () => { contacted = true; }}), /loopback/);
    assert.equal(contacted, false, 'must refuse before any public request or transaction');
  }
  assert.equal(requireLoopbackRpc('http://[::1]:8545'), 'http://[::1]:8545/');
});

test('the transport forbids following a loopback redirect to an external RPC', async () => {
  const original = globalThis.fetch;
  let attempted = false;
  globalThis.fetch = async (url, options) => {
    attempted = true;
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).method, 'eth_chainId');
    throw new TypeError('redirect refused');
  };
  const keeper = createLocalMockFeedMaintainer(config);
  try { await assert.rejects(keeper.start(), /redirect refused/); assert.equal(attempted, true); }
  finally { await keeper.stop(); globalThis.fetch = original; }
});

test('wrong chain and different bytecode fail before any mutation', async () => {
  for (const overrides of [{chainId: 11155111}, {code: '0x6001'}, {code: '0x'}]) {
    const h = harness(overrides);
    await assert.rejects(h.keeper.tick(), /non-31337|bytecode/);
    assert.deepEqual(h.writes(), []); await h.keeper.stop();
  }
});

test('wrong description/binding and invalid prices are not automatically repaired', async () => {
  for (const overrides of [{description: 'ETH / USD'}, {boundFeed: owner}, {answer: 0n}, {answer: -1n}, {updatedAt: NOW + 1}]) {
    const h = harness(overrides);
    await assert.rejects(h.keeper.tick(), /bindings|invalid/);
    assert.deepEqual(h.writes(), []); await h.keeper.stop();
  }
});

test('only a near-expiry round refreshes, with the exact positive existing answer and zero value', async () => {
  const fresh = harness({updatedAt: NOW - 3500});
  assert.equal((await fresh.keeper.tick()).action, 'unchanged');
  assert.deepEqual(fresh.writes(), []); await fresh.keeper.stop();
  const old = harness({updatedAt: NOW - 3550}); const answer = old.state.answer;
  assert.equal((await old.keeper.tick()).action, 'refreshed');
  assert.equal(old.state.answer, answer);
  assert.equal(old.writes().length, 1);
  assert.equal(old.writes()[0].method, 'eth_sendTransaction');
  await old.keeper.stop();
});

test('an overnight idle head refreshes from wall time rather than mistaking its old round as fresh', async () => {
  const h = harness({blockTime: NOW - 86400, updatedAt: NOW - 86400});
  assert.equal((await h.keeper.tick()).action, 'refreshed');
  assert.equal(h.state.answer, 300_000_000_000n); await h.keeper.stop();
});

test('a presenter-owned wallet refreshes the same Mock answer using the separate unlocked updater', async () => {
  const h = harness({updatedAt: NOW - 3550}, {ownerAddress: presenter, mockUpdaterAddress: updater});
  assert.equal((await h.keeper.tick()).action, 'refreshed');
  assert.equal(h.state.answer, 300_000_000_000n);
  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].params[0].from, updater);
  assert.equal(h.writes()[0].params[0].value, '0x0');
  await h.keeper.stop();
});

test('updater separation never bypasses Owner bindings or signs as a locked presenter', async () => {
  const mismatch = harness({updatedAt: NOW - 3550, boundOwner: owner}, {ownerAddress: presenter, mockUpdaterAddress: updater});
  await assert.rejects(mismatch.keeper.tick(), /bindings/);
  assert.deepEqual(mismatch.writes(), []); await mismatch.keeper.stop();
  const locked = harness({updatedAt: NOW - 3550, accounts: [presenter]}, {ownerAddress: presenter, mockUpdaterAddress: updater});
  await assert.rejects(locked.keeper.tick(), /unlocked.*updater/);
  assert.deepEqual(locked.writes(), []); await locked.keeper.stop();
  for (const mockUpdaterAddress of ['', 'invalid', '0x0000000000000000000000000000000000000000', feed, wallet, oracle]) {
    let contacted = false;
    assert.throws(() => createLocalMockFeedMaintainer({...config, mockUpdaterAddress}, {request() {contacted = true;}}), /updater/);
    assert.equal(contacted, false);
  }
});

test('idle head mining uses no timestamp override, payment or price mutation', async () => {
  const h = harness({blockTime: NOW - 45, updatedAt: NOW - 100});
  assert.equal((await h.keeper.tick()).action, 'mined');
  assert.deepEqual(h.writes(), [{method: 'evm_mine', params: []}]);
  assert.equal(h.state.answer, 300_000_000_000n); await h.keeper.stop();
});

test('stopping cancels scheduling and prevents further requests even during an in-flight check', async () => {
  let release; const calls = [];
  const keeper = createLocalMockFeedMaintainer(config, {request: method => {
    calls.push(method); return new Promise(resolve => { release = resolve; });
  }});
  const pending = assert.rejects(keeper.tick(), /stopped/);
  const stopped = keeper.stop(); release('0x7a69');
  await pending; await stopped;
  assert.deepEqual(calls, ['eth_chainId']);
  await assert.rejects(keeper.tick(), /stopped/);
  const h = harness(); await h.keeper.start(); await h.keeper.stop();
  assert.equal(await h.keeper.done, undefined);
});
