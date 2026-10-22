import { ConfigResponseSchema } from './schemas';

export const NORMAL_REFRESH_MS = 30_000;
export const PENDING_REFRESH_MS = 2_000;

/** External config is validated again so malformed API state cannot accelerate polling. */
export function nextRefreshDelay(config: unknown, pageActive = true): number {
  if (!pageActive) return NORMAL_REFRESH_MS;
  const parsed = ConfigResponseSchema.safeParse(config);
  return parsed.success && parsed.data.readiness.code === 'READINESS_CHECKING'
    ? PENDING_REFRESH_MS
    : NORMAL_REFRESH_MS;
}
