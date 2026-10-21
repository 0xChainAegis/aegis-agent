// Development only. Never imported by the automated E2E stack.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress} from 'viem';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESCRIPTION = 'LOCAL MOCK ETH / USD';
const feedAbi = parseAbi([
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function updateAnswer(int256 answer)',
]);
const walletAbi = parseAbi(['function owner() view returns (address)', 'function oracle() view returns (address)', 'function maxPriceAge() view returns (uint256)']);
const oracleAbi = parseAbi(['function feeds(address token) view returns (address)', 'function configurationLocked() view returns (bool)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function requireLoopbackRpc(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error('Local Mock heartbeat requires a loopback HTTP(S) RPC without credentials.');
  }
  return url.href;
}

export function loadLocalMockFeedConfig({env = process.env, root = ROOT} = {}) {
  if ((env.AEGIS_MODE ?? 'local_chain') !== 'local_chain') return null;
  const deployment = JSON.parse(readFileSync(env.AEGIS_DEPLOYMENT_FILE ?? path.join(root, 'contracts/deployments/localhost.json'), 'utf8'));
  if (Number(deployment.chainId) !== 31337 || Number(env.AEGIS_CHAIN_ID ?? 31337) !== 31337) throw new Error('Local Mock heartbeat requires chain 31337.');
  const rpcUrl = requireLoopbackRpc(env.AEGIS_RPC_URL ?? deployment.rpcUrl ?? 'http://127.0.0.1:8545');
  for (const name of ['walletAddress', 'oracleAddress', 'feedAddress', 'ownerAddress']) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(deployment[name] ?? '') || same(deployment[name], zeroAddress)) throw new Error(`Local deployment is missing ${name}.`);
  }
  const artifact = JSON.parse(readFileSync(path.join(root, 'contracts/artifacts/contracts/mocks/MockV3Aggregator.sol/MockV3Aggregator.json'), 'utf8'));
  if (!/^0x[0-9a-fA-F]+$/.test(artifact.deployedBytecode ?? '')) throw new Error('Compile the local MockV3Aggregator artifact first.');
  return {...deployment, rpcUrl, expectedBytecode: artifact.deployedBytecode};
}

export function createLocalMockFeedMaintainer(config, {request, now = Date.now, logger = console} = {}) {
  const rpcUrl = requireLoopbackRpc(config.rpcUrl);
  if (Number(config.chainId) !== 31337) throw new Error('Local Mock heartbeat requires chain 31337.');
  const controller = new AbortController();
  let stopped = false, timer, busy, settle;
  const done = new Promise(resolve => { settle = resolve; });
  const rpc = async (method, params = []) => {
    if (stopped) throw new Error('Local Mock heartbeat stopped.');
    if (request) return request(method, params);
    const response = await fetch(rpcUrl, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Local RPC returned HTTP ${response.status}.`);
    const result = await response.json();
    if (result.error || result.result === undefined) throw new Error(`Local RPC rejected ${method}.`);
    return result.result;
  };
  const read = async (address, abi, functionName, args = []) => decodeFunctionResult({
    abi, functionName, data: await rpc('eth_call', [{to: address, data: encodeFunctionData({abi, functionName, args})}, 'latest']),
  });
  async function checkOnce() {
    if (BigInt(await rpc('eth_chainId')) !== 31337n) throw new Error('Local Mock heartbeat refused a non-31337 RPC.');
    if (!same(await rpc('eth_getCode', [config.feedAddress, 'latest']), config.expectedBytecode)) throw new Error('Feed bytecode is not the compiled local MockV3Aggregator.');
    const [description, walletOracle, owner, feed, locked, maxAge, round, block] = await Promise.all([
      read(config.feedAddress, feedAbi, 'description'), read(config.walletAddress, walletAbi, 'oracle'),
      read(config.walletAddress, walletAbi, 'owner'), read(config.oracleAddress, oracleAbi, 'feeds', [zeroAddress]),
      read(config.oracleAddress, oracleAbi, 'configurationLocked'), read(config.walletAddress, walletAbi, 'maxPriceAge'),
      read(config.feedAddress, feedAbi, 'latestRoundData'), rpc('eth_getBlockByNumber', ['latest', false]),
    ]);
    if (description !== DESCRIPTION || !same(walletOracle, config.oracleAddress) || !same(feed, config.feedAddress)
        || !same(owner, config.ownerAddress) || !locked) throw new Error('Local Mock feed/deployment bindings do not match.');
    const [roundId, answer, , updatedAt, answeredInRound] = round;
    const blockTime = BigInt(block.timestamp), wallTime = BigInt(Math.floor(now() / 1000));
    if (maxAge <= 0n || roundId <= 0n || answer <= 0n || updatedAt <= 0n || updatedAt > blockTime || answeredInRound < roundId) {
      throw new Error('Local Mock round is invalid; heartbeat will not repair injected failure states.');
    }
    const margin = maxAge / 4n < 60n ? (maxAge / 4n || 1n) : 60n;
    const nextCheckMs = Number(maxAge < 120n ? maxAge * 250n : 30000n);
    const currentTime = wallTime > blockTime ? wallTime : blockTime;
    if (currentTime - updatedAt >= maxAge - margin) {
      const accounts = await rpc('eth_accounts');
      if (!accounts.some(account => same(account, owner))) throw new Error('Local Mock refresh requires the unlocked local deployment owner.');
      const hash = await rpc('eth_sendTransaction', [{
        from: owner, to: config.feedAddress, value: '0x0',
        data: encodeFunctionData({abi: feedAbi, functionName: 'updateAnswer', args: [answer]}),
      }]);
      let receipt;
      for (let attempts = 0; attempts < 50; attempts++) {
        receipt = await rpc('eth_getTransactionReceipt', [hash]);
        if (receipt) break;
        await delay(100, undefined, {signal: controller.signal});
      }
      if (receipt?.status !== '0x1') throw new Error('Local Mock refresh was not confirmed.');
      const refreshed = await read(config.feedAddress, feedAbi, 'latestRoundData');
      if (refreshed[1] !== answer || refreshed[0] <= roundId || refreshed[3] < updatedAt) throw new Error('Local Mock refresh did not preserve the existing answer.');
      logger.info('[local mock feed] Refreshed the unchanged development price; no payment was submitted.');
      return {action: 'refreshed', nextCheckMs};
    }
    // Hardhat's head otherwise stops between transactions. Mine naturally, without
    // setting timestamps, so an overnight idle head cannot conceal a stale round.
    if (wallTime - blockTime >= 30n) {
      await rpc('evm_mine');
      return {action: 'mined', nextCheckMs};
    }
    return {action: 'unchanged', nextCheckMs};
  }
  function tick() {
    if (!busy) busy = checkOnce().finally(() => { busy = undefined; });
    return busy;
  }
  function finish(error) {
    if (stopped) return;
    stopped = true; clearTimeout(timer); controller.abort(); settle(error);
  }
  async function schedule() {
    try {
      const result = await tick();
      if (!stopped) timer = setTimeout(schedule, Math.max(250, result.nextCheckMs));
    } catch (error) { finish(error); }
  }
  return {
    enabled: true, done, tick,
    async start() {
      try { const result = await tick(); if (!stopped) timer = setTimeout(schedule, Math.max(250, result.nextCheckMs)); return this; }
      catch (error) { finish(error); throw error; }
    },
    async stop() { finish(); await busy?.catch(() => {}); },
  };
}

export async function startLocalMockFeed(options = {}) {
  const config = loadLocalMockFeedConfig(options);
  if (!config) return {enabled: false, async stop() {}};
  return createLocalMockFeedMaintainer(config, options).start();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const keeper = await startLocalMockFeed();
    if (keeper.enabled) {
      process.once('SIGINT', () => { void keeper.stop(); });
      process.once('SIGTERM', () => { void keeper.stop(); });
      const error = await keeper.done;
      if (error) throw error;
    }
  } catch (error) { console.error(`[local mock feed] ${error.message}`); process.exitCode = 1; }
}
