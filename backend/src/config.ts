import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, zeroAddress, type Address, type Hex } from 'viem';
import type { RuntimeMode } from '@aegis/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const LOCAL_AGENT_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const UNSAFE_PUBLIC_KEYS = new Set([
  LOCAL_AGENT_KEY.toLowerCase(),
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x0000000000000000000000000000000000000000000000000000000000000001',
]);
const deploymentAddressKeys = [
  'walletAddress', 'aclAddress', 'attestationAddress', 'oracleAddress',
  'policyEngineAddress', 'feedAddress', 'ownerAddress', 'agentAddress', 'recipientAddress',
] as const;
export type LlmMode = 'off' | 'stub' | 'live';
export type LlmProvider = 'stub' | 'anthropic' | 'openai';
export interface LlmConfig {
  mode: LlmMode;
  provider: LlmProvider;
  model: string | null;
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
}
export interface Config {
  mode: RuntimeMode; chainId: number; rpcUrl: string; port: number; host: string; dbPath: string;
  walletAddress: Address; aclAddress: Address; attestationAddress: Address; oracleAddress: Address;
  policyEngineAddress: Address; feedAddress: Address; ownerAddress: Address; agentAddress: Address; recipientAddress: Address;
  abiVersion: string; deploymentReady: boolean; agentKey?: Hex; origins: string[];
  authDomain: string; sessionSeconds: number; quoteSeconds: number; requestSeconds: number;
  maxAgeSeconds: number; configuredModel: string | null; llm: LlmConfig;
}
export function loadConfig(env = process.env): Config {
  const mode = env.AEGIS_MODE ?? 'local_chain';
  if (!['local_chain', 'testnet', 'mock'].includes(mode)) throw new Error('AEGIS_MODE must be local_chain, testnet, or mock');
  if (mode === 'testnet' && !env.AEGIS_DEPLOYMENT_FILE) throw new Error('AEGIS_MODE=testnet requires AEGIS_DEPLOYMENT_FILE');
  const deploymentPath = env.AEGIS_DEPLOYMENT_FILE ?? resolve(root, 'contracts/deployments/localhost.json');
  if (mode === 'testnet' && !existsSync(deploymentPath)) throw new Error(`Sepolia deployment file does not exist: ${deploymentPath}`);
  const deployment = existsSync(deploymentPath) ? JSON.parse(readFileSync(deploymentPath, 'utf8')) : {};
  if (mode === 'testnet' && Number(deployment.chainId) !== 11155111) throw new Error('Sepolia deployment file must declare chainId 11155111');
  const chainId = Number(env.AEGIS_CHAIN_ID ?? deployment.chainId ?? 31337);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid chain id');
  if (mode === 'local_chain' && chainId !== 31337) throw new Error('local_chain is restricted to chain 31337');
  if (mode === 'testnet' && chainId !== 11155111) throw new Error('This integration supports Sepolia testnet only');
  const address = (key: string) => getAddress(deployment[key] ?? zeroAddress);
  const deploymentReady = deploymentAddressKeys.every(key => address(key) !== zeroAddress);
  if (mode === 'testnet' && !deploymentReady) throw new Error('Sepolia deployment file is missing one or more required addresses');
  if (mode === 'testnet') {
    const identities = new Set(['ownerAddress', 'agentAddress', 'recipientAddress'].map(key => address(key).toLowerCase()));
    if (identities.size !== 3) throw new Error('Sepolia owner, agent, and recipient must be different addresses');
  }
  if (mode === 'testnet' && !env.AEGIS_RPC_URL) throw new Error('AEGIS_MODE=testnet requires AEGIS_RPC_URL');
  const rpcUrl = env.AEGIS_RPC_URL ?? deployment.rpcUrl ?? 'http://127.0.0.1:8545';
  const url = new URL(rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC must use HTTP(S)');
  if (mode === 'local_chain' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local default key may only be used with loopback RPC');
  if (mode === 'testnet' && url.protocol !== 'https:') throw new Error('Sepolia RPC must use HTTPS');
  const agentKey = env.AEGIS_AGENT_PRIVATE_KEY || (mode === 'local_chain' ? LOCAL_AGENT_KEY : undefined);
  if (agentKey && !/^0x[0-9a-fA-F]{64}$/.test(agentKey)) throw new Error('AEGIS_AGENT_PRIVATE_KEY must be a 32-byte hexadecimal key');
  if (mode === 'testnet' && !agentKey) throw new Error('AEGIS_MODE=testnet requires AEGIS_AGENT_PRIVATE_KEY');
  if (mode === 'testnet' && agentKey && UNSAFE_PUBLIC_KEYS.has(agentKey.toLowerCase())) throw new Error('A known local development key must not be used on Sepolia');
  const llmMode = env.AEGIS_LLM_MODE ?? 'off';
  if (!['off', 'stub', 'live'].includes(llmMode)) throw new Error('AEGIS_LLM_MODE must be off, stub, or live');
  const configuredProvider = env.AEGIS_LLM_PROVIDER ?? 'anthropic';
  if (!['anthropic', 'openai'].includes(configuredProvider)) throw new Error('AEGIS_LLM_PROVIDER must be anthropic or openai');
  const provider: LlmProvider = llmMode === 'stub' ? 'stub' : configuredProvider as LlmProvider;
  const firstNonEmpty = (...values: Array<string | undefined>) => values.find(value => !!value?.trim()) ?? null;
  const llmApiKey = firstNonEmpty(env.AEGIS_LLM_API_KEY, provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  const llmModel = firstNonEmpty(env.AEGIS_LLM_MODEL, llmMode === 'stub' ? 'stub-intent-v1' : undefined);
  const llmTimeoutMs = Number(env.AEGIS_LLM_TIMEOUT_MS || 10_000);
  if (!Number.isSafeInteger(llmTimeoutMs) || llmTimeoutMs < 1 || llmTimeoutMs > 30_000) throw new Error('AEGIS_LLM_TIMEOUT_MS must be an integer from 1 to 30000');
  if (llmMode === 'live' && (!llmModel || !llmApiKey)) throw new Error('AEGIS_LLM_MODE=live requires AEGIS_LLM_MODEL and an API key');
  const llmBaseUrl = env.AEGIS_LLM_BASE_URL ?? (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
  const llm: LlmConfig = { mode: llmMode as LlmMode, provider, model: llmModel, apiKey: llmApiKey, baseUrl: llmBaseUrl, timeoutMs: llmTimeoutMs };
  return {
    mode: mode as RuntimeMode, chainId, rpcUrl, port: Number(env.AEGIS_PORT ?? 3001), host: '127.0.0.1',
    dbPath: env.AEGIS_DB_PATH ?? resolve(root, 'backend/data/aegis.sqlite'),
    walletAddress: address('walletAddress'), aclAddress: address('aclAddress'), attestationAddress: address('attestationAddress'),
    oracleAddress: address('oracleAddress'), policyEngineAddress: address('policyEngineAddress'), feedAddress: address('feedAddress'), ownerAddress: address('ownerAddress'),
    agentAddress: address('agentAddress'), recipientAddress: address('recipientAddress'),
    abiVersion: deployment.abiVersion ?? 'aegis.v1', deploymentReady,
    agentKey: agentKey as Hex | undefined,
    origins: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:4173', 'http://127.0.0.1:4173'],
    authDomain: 'localhost', sessionSeconds: 3600, quoteSeconds: 60, requestSeconds: 600,
    maxAgeSeconds: 3600, configuredModel: llmModel ?? env.OPENAI_MODEL ?? null, llm,
  };
}
