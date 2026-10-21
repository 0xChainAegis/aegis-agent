import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { ViemGateway } from './chain.js';
import { errorMessage } from './errors.js';
import { runSepoliaCheck } from './sepolia-check.js';

try {
  const config = loadConfig({
    ...process.env,
    AEGIS_MODE: 'testnet',
    AEGIS_CHAIN_ID: '11155111',
    AEGIS_DEPLOYMENT_FILE: process.env.AEGIS_DEPLOYMENT_FILE ?? resolve('..', 'contracts/deployments/sepolia.json'),
    AEGIS_RPC_URL: process.env.AEGIS_RPC_URL ?? process.env.RPC_URL,
  });
  const report = await runSepoliaCheck(config, new ViemGateway(config));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2));
  process.exitCode = 1;
}
