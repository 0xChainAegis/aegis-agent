import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, LOCAL_AGENT_KEY } from '../src/config.js';

const safeKey = `0x${'11'.repeat(32)}`;

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
