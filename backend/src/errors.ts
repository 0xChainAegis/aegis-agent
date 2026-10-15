export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'shortMessage' in error) return String(error.shortMessage).slice(0, 400);
  return error instanceof Error ? error.message.slice(0, 400) : 'Unknown failure';
}
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}
