export class ReadinessCache<T> {
  private cached: { expiresAt: number; value: T } | undefined;
  private pending: Promise<T> | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(loader: () => Promise<T>, force = false): Promise<T> {
    const cached = this.cached;
    if (!force && cached && cached.expiresAt > this.now()) return cached.value;
    if (!force && this.pending) return this.pending;

    const pending = loader().then(value => {
      this.cached = { expiresAt: this.now() + this.ttlMs, value };
      return value;
    });
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  clear(): void {
    this.cached = undefined;
  }
}
