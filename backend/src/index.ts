import { loadConfig } from './config.js';
import { Store } from './store.js';
import { ViemGateway } from './chain.js';
import { AegisService } from './service.js';
import { createApiServer } from './server.js';

const config = loadConfig();
const store = new Store(config.dbPath);
const service = new AegisService(config, store, new ViemGateway(config));
const server = createApiServer(service);
let stopped = false;
let timer: NodeJS.Timeout | undefined;
async function runWorker() {
  try { await service.tick(); } catch { console.error('Background reconciliation unavailable; saved transactions remain pending.'); }
  if (!stopped) timer = setTimeout(runWorker, 1000);
}
server.listen(config.port, config.host, () => {
  console.log(`Aegis backend http://${config.host}:${config.port} mode=${config.mode} chainId=${config.chainId}`);
  void runWorker();
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; stopped = true; store.close(); });
async function stop() {
  if (stopped) return;
  stopped = true; if (timer) clearTimeout(timer);
  await new Promise<void>(resolve => server.close(() => resolve()));
  await service.worker.run(async () => { store.close(); });
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
