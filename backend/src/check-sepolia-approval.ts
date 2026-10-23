import { resolve } from 'node:path';
import { z } from 'zod';
import { ViemGateway } from './chain.js';
import { loadConfig } from './config.js';
import { errorMessage } from './errors.js';
import { GatewayApprovalReader, runSepoliaApprovalCheck } from './sepolia-approval-check.js';

const hash = z.custom<`0x${string}`>(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value));
const argumentsSchema = z.tuple([
  z.literal('--queue-tx'), hash,
  z.literal('--approval-tx'), hash,
]);

try {
  const [, queueHash, , approvalHash] = argumentsSchema.parse(process.argv.slice(2));
  const config = loadConfig({
    ...process.env,
    AEGIS_MODE: 'testnet',
    AEGIS_CHAIN_ID: '11155111',
    AEGIS_DEPLOYMENT_FILE: process.env.AEGIS_DEPLOYMENT_FILE ?? resolve('..', 'contracts/deployments/sepolia.json'),
    AEGIS_RPC_URL: process.env.AEGIS_RPC_URL ?? process.env.RPC_URL,
    AEGIS_LLM_MODE: 'off',
  });
  const gateway = new ViemGateway(config);
  const report = await runSepoliaApprovalCheck(config, new GatewayApprovalReader(config, gateway), queueHash, approvalHash);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: errorMessage(error),
    usage: 'npm run verify:sepolia:approval -- --queue-tx 0x... --approval-tx 0x...',
  }, null, 2));
  process.exitCode = 1;
}
