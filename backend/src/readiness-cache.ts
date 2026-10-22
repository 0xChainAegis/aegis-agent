import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';

const readinessSchema = z.object({
  ready: z.boolean(),
  code: z.string().trim().min(1).max(128).optional(),
  message: z.string().max(2000).optional(),
  rpcChainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  contractsDeployed: z.boolean().optional(),
  deploymentBindingsVerified: z.boolean().optional(),
  executorAuthorized: z.boolean().optional(),
  executorConfigured: z.boolean().optional(),
  agentTier: z.number().int().min(0).max(3).optional(),
  feedFresh: z.boolean().optional(),
  walletFunded: z.boolean().optional(),
  executorFunded: z.boolean().optional(),
}).refine(value => !value.ready || (
  value.code === undefined && value.rpcChainId !== undefined && value.contractsDeployed === true
  && value.deploymentBindingsVerified === true && value.executorAuthorized === true
  && value.executorConfigured === true && value.feedFresh === true
  && value.walletFunded === true && value.executorFunded === true
  && (value.agentTier === undefined || value.agentTier >= 2)
), 'A ready result requires complete positive deployment checks');

type Readiness = z.infer<typeof readinessSchema>;
export type PublicReadiness = Readiness & {
  checkedAt: string | null;
  cacheAgeMs: number | null;
  cacheTtlMs: number;
  source: 'fresh' | 'cache' | 'checking' | 'error';
};
interface Entry {
  value: Readiness;
  checkedAt: string;
  completedAt: number;
  error: boolean;
}
interface Flight {
  generation: number;
  done: Promise<void>;
  finish: () => void;
  expired: boolean;
  deadline?: ReturnType<typeof setTimeout>;
}
interface Options {
  ttlMs?: number;
  refreshAfterMs?: number;
  staleIfErrorMs?: number;
  waitMs?: number;
  checkTimeoutMs?: number;
  now?: () => number;
  wallTime?: () => number;
}
const timingSchema = z.object({
  ttlMs: z.number().int().min(2).max(300_000),
  refreshAfterMs: z.number().int().min(1).max(299_999),
  staleIfErrorMs: z.number().int().min(3).max(300_000),
  waitMs: z.number().int().min(1).max(1000),
  checkTimeoutMs: z.number().int().min(1).max(30_000),
}).refine(value => value.refreshAfterMs < value.ttlMs, 'Revalidation must start before the hard display expiry')
  .refine(value => value.ttlMs < value.staleIfErrorMs, 'Transient-error retention must exceed the fresh display expiry');

const transientCodes = new Set(['CHAIN_UNAVAILABLE', 'RPC_UNAVAILABLE', 'RPC_ERROR', 'READINESS_TIMEOUT']);

// The key is never returned by an endpoint. Changes to transport, identities,
// contracts or the executor key invalidate even a still-young cached proof.
export function readinessIdentity(config: Config): string {
  return createHash('sha256').update(JSON.stringify([
    config.mode, config.chainId, config.rpcUrl, config.deploymentReady,
    config.walletAddress, config.aclAddress, config.attestationAddress,
    config.oracleAddress, config.policyEngineAddress, config.feedAddress,
    config.ownerAddress, config.agentAddress, config.recipientAddress,
    config.abiVersion, config.agentKey ?? null,
  ])).digest('hex');
}

/** Public display checks only; never used to authorize or price a payment. */
export class PublicReadinessCache {
  private readonly timing;
  private readonly now;
  private readonly wallTime;
  private identity: string | undefined;
  private generation = 0;
  private entry: Entry | undefined;
  private lastReady: Entry | undefined;
  private flight: Flight | undefined;
  private closed = false;

  constructor(
    private readonly load: () => Promise<unknown>,
    private readonly getIdentity: () => string,
    options: Options = {},
  ) {
    this.timing = timingSchema.parse({
      ttlMs: options.ttlMs ?? 60_000,
      refreshAfterMs: options.refreshAfterMs ?? 30_000,
      staleIfErrorMs: options.staleIfErrorMs ?? 300_000,
      waitMs: options.waitMs ?? 1000,
      checkTimeoutMs: options.checkTimeoutMs ?? 30_000,
    });
    this.now = options.now ?? (() => performance.now());
    this.wallTime = options.wallTime ?? Date.now;
  }

  async read(): Promise<PublicReadiness> {
    const identity = this.getIdentity();
    if (identity !== this.identity) {
      this.identity = identity;
      this.generation++;
      this.entry = undefined;
      this.lastReady = undefined;
    }
    const generation = this.generation;
    const cached = this.current('cache');
    if (cached) {
      // A still-valid display proof may be returned immediately while one
      // replacement sweep runs. The hard TTL below is never extended by reads.
      if (!this.closed && !this.flight && (cached.cacheAgeMs ?? 0) >= this.timing.refreshAfterMs) this.start();
      return cached;
    }
    if (this.closed) return this.pending('READINESS_UNAVAILABLE', '服务已停止检查。', 'error');
    // An expired/invalidated underlying RPC sweep cannot be cancelled through
    // Gateway.readiness(). Keep admission locked until it settles, so repeated
    // callers cannot create parallel abandoned sweeps.
    if (!this.flight) this.start();
    const flight = this.flight;
    if (flight) await this.wait(flight.done);
    if (this.closed) return this.pending('READINESS_UNAVAILABLE', '服务已停止检查。', 'error');
    if (generation !== this.generation) return this.pending('READINESS_CHECKING', '部署配置已变化，正在重新核对。', 'checking');
    if (flight?.expired && flight.generation === generation) {
      return this.current('fresh') ?? this.degraded('READINESS_TIMEOUT', 'Sepolia 链上检查超时；已保留上次核对结果用于只读连接，付款仍暂停。', 'error')
        ?? this.pending('READINESS_TIMEOUT', 'Sepolia 链上检查超时；请检查 RPC 后重试。', 'error');
    }
    return this.current('fresh') ?? this.degraded('READINESS_CHECKING', '正在后台更新 Sepolia 状态；已保留上次核对结果用于只读连接。', 'checking')
      ?? this.pending('READINESS_CHECKING', '正在核对 Sepolia 网络、合约和价格源，请稍候。', 'checking');
  }

  close(): void {
    this.closed = true;
    this.generation++;
    this.entry = undefined;
    this.lastReady = undefined;
    if (this.flight) {
      if (this.flight.deadline) clearTimeout(this.flight.deadline);
      this.flight.finish();
    }
  }

  private current(source: 'fresh' | 'cache'): PublicReadiness | undefined {
    const entry = this.entry;
    if (!entry) return undefined;
    const age = this.now() - entry.completedAt;
    if (age < 0 || age >= this.timing.ttlMs) return undefined;
    if (entry.error && entry.value.code && transientCodes.has(entry.value.code)) {
      const fallback = this.degraded(entry.value.code, entry.value.message ?? 'Sepolia RPC 暂时不可用；付款已暂停。', 'error');
      if (fallback) return fallback;
    }
    return {
      ...entry.value, checkedAt: entry.checkedAt, cacheAgeMs: Math.floor(age),
      cacheTtlMs: this.timing.ttlMs, source: entry.error ? 'error' : source,
    };
  }

  private degraded(code: string, message: string, source: 'checking' | 'error'): PublicReadiness | undefined {
    const entry = this.lastReady;
    if (!entry) return undefined;
    const age = this.now() - entry.completedAt;
    if (age < 0 || age >= this.timing.staleIfErrorMs) return undefined;
    return {
      ...entry.value, ready: false, code, message,
      checkedAt: entry.checkedAt, cacheAgeMs: Math.floor(age),
      cacheTtlMs: this.timing.staleIfErrorMs, source,
    };
  }

  private pending(code: string, message: string, source: 'checking' | 'error'): PublicReadiness {
    return { ready: false, code, message, checkedAt: null, cacheAgeMs: null, cacheTtlMs: this.timing.ttlMs, source };
  }

  private save(value: Readiness, error = false): void {
    const entry = { value, completedAt: this.now(), checkedAt: new Date(this.wallTime()).toISOString(), error };
    this.entry = entry;
    if (value.ready) this.lastReady = entry;
  }

  private start(): void {
    let finish = () => {};
    const done = new Promise<void>(resolve => { finish = resolve; });
    const flight: Flight = { generation: this.generation, done, finish, expired: false };
    this.flight = flight;
    flight.deadline = setTimeout(() => {
      flight.expired = true;
      if (!this.closed && flight.generation === this.generation) {
        this.save({ ready: false, code: 'READINESS_TIMEOUT', message: 'Sepolia 链上检查超时；当前不会放行付款，请检查 RPC 后重试。' }, true);
      }
      flight.finish();
    }, this.timing.checkTimeoutMs);
    flight.deadline.unref();
    void this.complete(flight);
  }

  private async complete(flight: Flight): Promise<void> {
    try {
      const raw = await this.load();
      if (this.closed || flight.expired || flight.generation !== this.generation) return;
      const parsed = readinessSchema.safeParse(raw);
      if (parsed.success) this.save(parsed.data, Boolean(parsed.data.code && transientCodes.has(parsed.data.code)));
      else this.save({ ready: false, code: 'READINESS_INVALID', message: '链上检查结果未通过校验，请检查服务配置。' }, true);
    } catch {
      if (!this.closed && !flight.expired && flight.generation === this.generation) {
        this.save({ ready: false, code: 'CHAIN_UNAVAILABLE', message: '暂时无法完成 Sepolia 链上检查，请检查 RPC 后重试。' }, true);
      }
    } finally {
      if (flight.deadline) clearTimeout(flight.deadline);
      if (this.flight === flight) this.flight = undefined;
      flight.finish();
    }
  }

  private async wait(done: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, this.timing.waitMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
