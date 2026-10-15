import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, zeroAddress, type Address, type Hex } from 'viem';
import type { RuntimeMode } from '@aegis/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const LOCAL_AGENT_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export interface Config {
  mode: RuntimeMode; chainId: number; rpcUrl: string; port: number; host: string; dbPath: string;
  walletAddress: Address; aclAddress: Address; attestationAddress: Address; oracleAddress: Address;
  feedAddress: Address; ownerAddress: Address; agentAddress: Address; recipientAddress: Address;
  abiVersion: string; deploymentReady: boolean; agentKey?: Hex; origins: string[];
  authDomain: string; sessionSeconds: number; quoteSeconds: number; requestSeconds: number;
  maxAgeSeconds: number; configuredModel: string | null;
}
export function loadConfig(env = process.env): Config {
  const deploymentPath = env.AEGIS_DEPLOYMENT_FILE ?? resolve(root, 'contracts/deployments/localhost.json');
  const deployment = existsSync(deploymentPath) ? JSON.parse(readFileSync(deploymentPath, 'utf8')) : {};
  const mode = env.AEGIS_MODE ?? 'local_chain';
  if (!['local_chain', 'testnet', 'mock'].includes(mode)) throw new Error('AEGIS_MODE must be local_chain, testnet, or mock');
  const chainId = Number(env.AEGIS_CHAIN_ID ?? deployment.chainId ?? 31337);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid chain id');
  if (mode === 'local_chain' && chainId !== 31337) throw new Error('local_chain is restricted to chain 31337');
  if (mode === 'testnet' && chainId !== 11155111) throw new Error('This integration supports Sepolia testnet only');
  const address = (key: string) => getAddress(deployment[key] ?? zeroAddress);
  const rpcUrl = env.AEGIS_RPC_URL ?? deployment.rpcUrl ?? 'http://127.0.0.1:8545';
  const url = new URL(rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC must use HTTP(S)');
  if (mode === 'local_chain' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local default key may only be used with loopback RPC');
  const agentKey = env.AEGIS_AGENT_PRIVATE_KEY || (mode === 'local_chain' ? LOCAL_AGENT_KEY : undefined);
  if (agentKey && !/^0x[0-9a-fA-F]{64}$/.test(agentKey)) throw new Error('AEGIS_AGENT_PRIVATE_KEY must be a 32-byte hexadecimal key');
  return {
    mode: mode as RuntimeMode, chainId, rpcUrl, port: Number(env.AEGIS_PORT ?? 3001), host: '127.0.0.1',
    dbPath: env.AEGIS_DB_PATH ?? resolve(root, 'backend/data/aegis.sqlite'),
    walletAddress: address('walletAddress'), aclAddress: address('aclAddress'), attestationAddress: address('attestationAddress'),
    oracleAddress: address('oracleAddress'), feedAddress: address('feedAddress'), ownerAddress: address('ownerAddress'),
    agentAddress: address('agentAddress'), recipientAddress: address('recipientAddress'),
    abiVersion: deployment.abiVersion ?? 'aegis.v1', deploymentReady: !!deployment.walletAddress,
    agentKey: agentKey as Hex | undefined,
    origins: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:4173', 'http://127.0.0.1:4173'],
    authDomain: 'localhost', sessionSeconds: 3600, quoteSeconds: 60, requestSeconds: 600,
    maxAgeSeconds: 3600, configuredModel: env.OPENAI_MODEL ?? null,
  };
}
