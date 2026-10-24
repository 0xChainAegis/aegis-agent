import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, LOCAL_AGENT_KEY } from '../src/config.js';

const safeKey = `0x${'11'.repeat(32)}`;

test('model timeout defaults to ten seconds and validates explicit overrides', () => {
  assert.equal(loadConfig({ AEGIS_MODE: 'mock' }).llm.timeoutMs, 10_000);
  assert.equal(loadConfig({ AEGIS_MODE: 'mock', AEGIS_LLM_TIMEOUT_MS: '' }).llm.timeoutMs, 10_000);
  assert.equal(loadConfig({ AEGIS_MODE: 'mock', AEGIS_LLM_TIMEOUT_MS: '30000' }).llm.timeoutMs, 30_000);
  for (const timeout of ['0', '-1', '30001', 'NaN']) {
    assert.throws(() => loadConfig({ AEGIS_MODE: 'mock', AEGIS_LLM_TIMEOUT_MS: timeout }), /AEGIS_LLM_TIMEOUT_MS/);
  }
});

test('RPC transport defaults to one bounded retry and validates external tuning', () => {
  const defaults = loadConfig({ AEGIS_MODE: 'mock' });
  assert.equal(defaults.rpcTimeoutMs, 15_000);
  assert.equal(defaults.rpcRetryCount, 1);
  const empty = loadConfig({ AEGIS_MODE: 'mock', AEGIS_RPC_TIMEOUT_MS: '', AEGIS_RPC_RETRY_COUNT: '' });
  assert.equal(empty.rpcTimeoutMs, 15_000);
  assert.equal(empty.rpcRetryCount, 1);
  const boundary = loadConfig({ AEGIS_MODE: 'mock', AEGIS_RPC_TIMEOUT_MS: '30000', AEGIS_RPC_RETRY_COUNT: '2' });
  assert.equal(boundary.rpcTimeoutMs, 30_000);
  assert.equal(boundary.rpcRetryCount, 2);
  assert.throws(() => loadConfig({ AEGIS_MODE: 'mock', AEGIS_RPC_TIMEOUT_MS: '999' }), /AEGIS_RPC_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ AEGIS_MODE: 'mock', AEGIS_RPC_RETRY_COUNT: '3' }), /AEGIS_RPC_RETRY_COUNT/);
  assert.throws(() => loadConfig({ AEGIS_MODE: 'mock', AEGIS_RPC_RETRY_COUNT: 'NaN' }), /AEGIS_RPC_RETRY_COUNT/);
});

function withDeployment(run: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-config-'));
  const path = join(directory, 'sepolia.json');
  writeFileSync(path, JSON.stringify({
    chainId: 11155111,
    walletAddress: '0x1000000000000000000000000000000000000001',
    aclAddress: '0x2000000000000000000000000000000000000002',
    attestationAddress: '0x3000000000000000000000000000000000000003',
    oracleAddress: '0x4000000000000000000000000000000000000004',
    policyEngineAddress: '0x5000000000000000000000000000000000000005',
    feedAddress: '0x6000000000000000000000000000000000000006',
    ownerAddress: '0x7000000000000000000000000000000000000007',
    agentAddress: '0x8000000000000000000000000000000000000008',
    recipientAddress: '0x9000000000000000000000000000000000000009',
  }));
  try { run(path); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('testnet config requires an explicit deployment, RPC, and executor key', () => {
  assert.throws(() => loadConfig({ AEGIS_MODE: 'testnet' }), /AEGIS_DEPLOYMENT_FILE/);
  withDeployment(path => {
    assert.throws(() => loadConfig({ AEGIS_MODE: 'testnet', AEGIS_DEPLOYMENT_FILE: path }), /AEGIS_RPC_URL/);
    assert.throws(() => loadConfig({ AEGIS_MODE: 'testnet', AEGIS_DEPLOYMENT_FILE: path, AEGIS_RPC_URL: 'https:\/\/rpc.invalid' }), /AEGIS_AGENT_PRIVATE_KEY/);
  });
});

test('testnet config accepts a complete deployment and rejects a public local key', () => {
  withDeployment(path => {
    const base = { AEGIS_MODE: 'testnet', AEGIS_DEPLOYMENT_FILE: path, AEGIS_RPC_URL: 'https://rpc.invalid' };
    const config = loadConfig({ ...base, AEGIS_AGENT_PRIVATE_KEY: safeKey });
    assert.equal(config.chainId, 11155111);
    assert.equal(config.deploymentReady, true);
    assert.throws(() => loadConfig({ ...base, AEGIS_AGENT_PRIVATE_KEY: LOCAL_AGENT_KEY }), /known local development key/);
  });
});

test('optional CCIP deployment fields are accepted only as one validated set', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-ccip-config-'));
  const path = join(directory, 'local.json');
  const base = {
    chainId: 31337,
    walletAddress: '0x1000000000000000000000000000000000000001',
    aclAddress: '0x2000000000000000000000000000000000000002',
    attestationAddress: '0x3000000000000000000000000000000000000003',
    oracleAddress: '0x4000000000000000000000000000000000000004',
    policyEngineAddress: '0x5000000000000000000000000000000000000005',
    feedAddress: '0x6000000000000000000000000000000000000006',
    ownerAddress: '0x7000000000000000000000000000000000000007',
    agentAddress: '0x8000000000000000000000000000000000000008',
    recipientAddress: '0x9000000000000000000000000000000000000009',
  };
  try {
    writeFileSync(path, JSON.stringify({ ...base, ccipSenderAddress: '0xA00000000000000000000000000000000000000A' }));
    assert.throws(() => loadConfig({ AEGIS_DEPLOYMENT_FILE: path }), /CCIP deployment fields/);
    writeFileSync(path, JSON.stringify({
      ...base,
      ccipSenderAddress: '0xA00000000000000000000000000000000000000A',
      ccipRouterAddress: '0xB00000000000000000000000000000000000000B',
      ccipTokenAddress: '0xC00000000000000000000000000000000000000C',
      ccipTokenFeedAddress: '0xD00000000000000000000000000000000000000D',
      ccipDestinationChainSelector: '10344971235874465080',
    }));
    const config = loadConfig({ AEGIS_DEPLOYMENT_FILE: path });
    assert.equal(config.ccipSenderAddress, '0xA00000000000000000000000000000000000000A');
    assert.equal(config.ccipDestinationChainSelector, '10344971235874465080');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Sepolia CCIP config requires and exposes validated destination evidence metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-sepolia-ccip-config-'));
  const path = join(directory, 'sepolia.json');
  const deployment = {
    chainId: 11155111,
    walletAddress: '0x1000000000000000000000000000000000000001',
    aclAddress: '0x2000000000000000000000000000000000000002',
    attestationAddress: '0x3000000000000000000000000000000000000003',
    oracleAddress: '0x4000000000000000000000000000000000000004',
    policyEngineAddress: '0x5000000000000000000000000000000000000005',
    feedAddress: '0x6000000000000000000000000000000000000006',
    ownerAddress: '0x7000000000000000000000000000000000000007',
    agentAddress: '0x8000000000000000000000000000000000000008',
    recipientAddress: '0x9000000000000000000000000000000000000009',
    ccipSenderAddress: '0xA00000000000000000000000000000000000000A',
    ccipRouterAddress: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59',
    ccipTokenAddress: '0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05',
    ccipTokenFeedAddress: '0xD00000000000000000000000000000000000000D',
    ccipDestinationChainSelector: '10344971235874465080',
  };
  const env = { AEGIS_MODE: 'testnet', AEGIS_DEPLOYMENT_FILE: path, AEGIS_RPC_URL: 'https://rpc.invalid', AEGIS_AGENT_PRIVATE_KEY: safeKey };
  try {
    writeFileSync(path, JSON.stringify(deployment));
    assert.throws(() => loadConfig(env), /destination metadata/);
    writeFileSync(path, JSON.stringify({
      ...deployment,
      ccipDestinationChainId: 84532,
      ccipDestinationNetwork: 'base-sepolia',
      ccipDestinationTokenAddress: '0x88A2d74F47a237a62e7A51cdDa67270CE381555e',
      ccipTokenPriceSource: 'OWNER_MAINTAINED_TESTNET_VALUE',
    }));
    const config = loadConfig(env);
    assert.equal(config.ccipDestinationChainId, 84532);
    assert.equal(config.ccipDestinationNetwork, 'base-sepolia');
    assert.equal(config.ccipDestinationTokenAddress, '0x88A2d74F47a237a62e7A51cdDa67270CE381555e');
    assert.equal(config.ccipTokenPriceSource, 'OWNER_MAINTAINED_TESTNET_VALUE');
    writeFileSync(path, JSON.stringify({
      ...deployment,
      ccipDestinationChainId: 84532,
      ccipDestinationNetwork: 'base-sepolia',
      ccipDestinationTokenAddress: '0x0000000000000000000000000000000000000001',
      ccipTokenPriceSource: 'OWNER_MAINTAINED_TESTNET_VALUE',
    }));
    assert.throws(() => loadConfig(env), /canonical Ethereum Sepolia to Base Sepolia/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deployment files reject invalid JSON and out-of-range CCIP selectors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-invalid-deployment-'));
  const path = join(directory, 'local.json');
  try {
    writeFileSync(path, '{');
    assert.throws(() => loadConfig({ AEGIS_DEPLOYMENT_FILE: path }), /not valid JSON/);
    writeFileSync(path, JSON.stringify({
      ccipSenderAddress: '0xA00000000000000000000000000000000000000A',
      ccipRouterAddress: '0xB00000000000000000000000000000000000000B',
      ccipTokenAddress: '0xC00000000000000000000000000000000000000C',
      ccipTokenFeedAddress: '0xD00000000000000000000000000000000000000D',
      ccipDestinationChainSelector: (2n ** 64n).toString(),
    }));
    assert.throws(() => loadConfig({ AEGIS_DEPLOYMENT_FILE: path }), /ccipDestinationChainSelector/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
