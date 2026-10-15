export type Data = Record<string, unknown>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

let token = sessionStorage.getItem('aegis.session') || '';
const pendingMutationKeys = new Map<string, string>();

export function setToken(value: string) {
  token = value;
  if (value) sessionStorage.setItem('aegis.session', value);
  else sessionStorage.removeItem('aegis.session');
}

export function hasSession() { return Boolean(token); }

export async function api<T = Data>(path: string, method = 'GET', body?: Data): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12_000);
  const fingerprint = method === 'GET' ? '' : `${method}:${path}:${JSON.stringify(body || {})}`;
  const mutationKey = fingerprint ? pendingMutationKeys.get(fingerprint) || crypto.randomUUID() : '';
  if (fingerprint) pendingMutationKeys.set(fingerprint, mutationKey);
  try {
    const response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(mutationKey ? { 'Idempotency-Key': mutationKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    let data: Data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { throw new ApiError(response.status, 'INVALID_RESPONSE', '服务返回了无法读取的结果，请检查后端是否启动。'); }
    if (!response.ok) {
      const error = data.error && typeof data.error === 'object' ? data.error as Data : data;
      if (response.status === 401) setToken('');
      if (response.status < 500 && fingerprint) pendingMutationKeys.delete(fingerprint);
      throw new ApiError(response.status, String(error.code || data.code || 'API_ERROR'), String(error.message || data.message || '操作未完成，请稍后重试。'), error.details || data.details);
    }
    if (fingerprint) pendingMutationKeys.delete(fingerprint);
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'OFFLINE', '无法连接本地服务。请确认 API 已在 3001 端口启动，再重试。');
  } finally { clearTimeout(timeout); }
}
