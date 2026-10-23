import { z } from 'zod';
import { resolve } from 'node:path';
import { ViemGateway } from './chain.js';
import { loadConfig } from './config.js';
import { errorMessage } from './errors.js';
import { loadSepoliaPolicyConfig, runSepoliaPolicyCheck, ViemSepoliaPolicyReader } from './sepolia-policy-check.js';
import { GatewayPolicyWriter, runSepoliaPolicyWriteCheck } from './sepolia-policy-write.js';

const argumentsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal('--write'), z.literal('--confirm-spend')]),
]);

try {
  const args = argumentsSchema.parse(process.argv.slice(2));
  if (args.length === 0) {
    const config = loadSepoliaPolicyConfig();
    const report = await runSepoliaPolicyCheck(config, new ViemSepoliaPolicyReader(config));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else {
    const config = loadConfig({
      ...process.env,
      AEGIS_MODE: 'testnet',
      AEGIS_CHAIN_ID: '11155111',
      AEGIS_DEPLOYMENT_FILE: process.env.AEGIS_DEPLOYMENT_FILE ?? resolve('..', 'contracts/deployments/sepolia.json'),
      AEGIS_RPC_URL: process.env.AEGIS_RPC_URL ?? process.env.RPC_URL,
      AEGIS_LLM_MODE: 'off',
    });
    const report = await runSepoliaPolicyWriteCheck(config, new GatewayPolicyWriter(new ViemGateway(config)));
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: errorMessage(error),
    usage: 'npm run test:sepolia:policy [-- --write --confirm-spend]',
  }, null, 2));
  process.exitCode = 1;
}
