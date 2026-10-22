import { http, type HttpTransport, type HttpTransportConfig } from 'viem';

export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('RPC concurrency limit must be a positive integer');
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export function boundedHttp(url: string, config: HttpTransportConfig, concurrency = 20): HttpTransport {
  // Readiness performs groups of independent reads at one observed block.
  // Admit one bounded batch at a time and let viem collapse it into a small
  // number of HTTP round trips instead of exhausting a hosted RPC with dozens.
  const base = http(url, { ...config, batch: config.batch ?? { batchSize: 20, wait: 10 } });
  const gate = new ConcurrencyGate(concurrency);
  return parameters => {
    const transport = base(parameters);
    const request: typeof transport.request = async requestArgs => gate.run(() => transport.request(requestArgs));
    return { ...transport, config: { ...transport.config, request }, request };
  };
}
