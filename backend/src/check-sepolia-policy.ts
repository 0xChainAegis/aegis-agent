import { z } from 'zod';
import { errorMessage } from './errors.js';
import { loadSepoliaPolicyConfig, runSepoliaPolicyCheck, ViemSepoliaPolicyReader } from './sepolia-policy-check.js';

try {
  z.array(z.string()).max(0, 'This check is read-only and accepts no command-line arguments').parse(process.argv.slice(2));
  const config = loadSepoliaPolicyConfig();
  const report = await runSepoliaPolicyCheck(config, new ViemSepoliaPolicyReader(config));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, readOnly: true, error: errorMessage(error) }, null, 2));
  process.exitCode = 1;
}
