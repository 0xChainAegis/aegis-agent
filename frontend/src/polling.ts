import { ConfigResponseSchema } from './schemas';
import { z } from 'zod';

export const NORMAL_REFRESH_MS = 30_000;
export const PENDING_REFRESH_MS = 2_000;
const taskListSchema = z.array(z.looseObject({
  status: z.enum(['SUBMITTING', 'BROADCAST', 'UNKNOWN', 'AWAITING_APPROVAL', 'EXECUTED', 'BLOCKED', 'REQUOTE_REQUIRED', 'CANCELLED', 'EXPIRED', 'FAILED']),
}));

/** External config is validated again so malformed API state cannot accelerate polling. */
export function nextRefreshDelay(config: unknown, pageActive = true, tasks: unknown = []): number {
  if (!pageActive) return NORMAL_REFRESH_MS;
  const parsed = ConfigResponseSchema.safeParse(config);
  const parsedTasks = taskListSchema.safeParse(tasks);
  const activeTask = parsedTasks.success && parsedTasks.data.some(task => ['SUBMITTING', 'BROADCAST', 'UNKNOWN'].includes(task.status));
  return parsed.success && (parsed.data.readiness.code === 'READINESS_CHECKING' || activeTask)
    ? PENDING_REFRESH_MS
    : NORMAL_REFRESH_MS;
}
