import { z } from 'zod';
import { ConfigResponseSchema } from './schemas';
import { subscriptionFieldsSchema, subscriptionListSchema, subscriptionRecordSchema, subscriptionPreviewSchema, subscriptionControlPreviewSchema, subscriptionPolicyPreviewSchema, subscriptionPolicySchema } from './subscriptions';
import { ccipDeliverySchema, ccipIntentBindingSchema, ccipQuoteBindingSchema, ccipTaskBindingSchema } from './ccip';

export type Data = Record<string, unknown>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

// JSON starts as unknown; route schemas validate the fields used for identity,
// authentication, and payment preparation while retaining server metadata.
export const apiRecordSchema = z.record(z.string(), z.json());
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintSchema = z.string().regex(/^\d+$/).max(78).refine(value => value.length <= 78 && /^\d+$/.test(value) && BigInt(value) < 2n ** 256n);
const httpUrlSchema = z.url().refine(value => /^https?:/.test(value));
const positiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.string().refine(value => Number.isFinite(Date.parse(value)));
const statusSchema = z.enum(['DRAFT', 'NEEDS_INPUT', 'READY', 'SUBMITTING', 'BROADCAST', 'UNKNOWN', 'AWAITING_APPROVAL', 'EXECUTED', 'BLOCKED', 'REQUOTE_REQUIRED', 'CANCELLED', 'EXPIRED', 'FAILED']);
export const sessionTokenSchema = z.string().min(1).max(4096).regex(/^[\x21-\x7E]+$/);

export const configResponseSchema = ConfigResponseSchema.safeExtend({
  chainId: positiveIntegerSchema,
  rpcUrl: httpUrlSchema.nullable().optional(), explorerBaseUrl: httpUrlSchema.nullable().optional(),
  localTestWalletAvailable: z.boolean().optional(),
  planner: z.looseObject({ mode: z.enum(['off', 'stub', 'live']), timeoutMs: z.number().int().min(1).max(30_000) }).optional(),
});
export const authChallengeResponseSchema = z.looseObject({
  challengeId: z.string().min(1).max(200), message: z.string().min(1).max(16_384),
  address: addressSchema.optional(), chainId: positiveIntegerSchema.optional(), expiresAt: timestampSchema.optional(),
});
export const authSessionResponseSchema = z.looseObject({
  token: sessionTokenSchema, address: addressSchema, chainId: positiveIntegerSchema, expiresAt: timestampSchema.optional(),
});
export const walletSnapshotResponseSchema = z.looseObject({
  chainId: positiveIntegerSchema, walletAddress: addressSchema, recipientAddress: addressSchema,
  ownerAddress: addressSchema.optional(), agentAddress: addressSchema.optional(),
  recipientBalanceWei: uintSchema, walletBalanceWei: uintSchema.optional(), agentBalanceWei: uintSchema.optional(),
  observedBlockNumber: uintSchema, observedBlockHash: hashSchema, observedAt: timestampSchema, dataSource: z.enum(['chain', 'mock']),
});
export const intentResponseSchema = z.looseObject({
  draftId: z.string().min(1), status: statusSchema, revision: positiveIntegerSchema,
  recipient: addressSchema.nullable(), amountWei: uintSchema.nullable(), purpose: z.string(),
  missingFields: z.array(z.string()).optional(), question: z.string().nullable().optional(),
});
export const quoteResponseSchema = z.looseObject({
  quoteId: z.string().min(1), draftId: z.string().min(1), draftVersion: positiveIntegerSchema,
  status: z.enum(['READY', 'BLOCKED']), chainId: positiveIntegerSchema, walletAddress: addressSchema,
  recipient: addressSchema, amountWei: uintSchema, maxUsdCost6: uintSchema,
  decision: z.enum(['BLOCK', 'OWNER_APPROVAL', 'AUTO']), quoteExpiresAtSeconds: positiveIntegerSchema,
});
export const taskResponseSchema = z.looseObject({
  taskId: z.string().min(1), status: statusSchema, chainId: positiveIntegerSchema,
  walletAddress: addressSchema, ownerAddress: addressSchema, agentAddress: addressSchema,
  recipient: addressSchema, amountWei: uintSchema, maxUsdCost6: uintSchema,
  txHash: hashSchema.nullable().optional(), requestHash: hashSchema.nullable().optional(),
  reasonCodes: z.array(z.string()).optional(), availableActions: z.array(z.string()).optional(),
  ccipDelivery: ccipDeliverySchema.optional(),
});
export const tasksResponseSchema = z.looseObject({ tasks: z.array(taskResponseSchema) });
export const ownerTransactionResponseSchema = z.looseObject({
  from: addressSchema, to: addressSchema, data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  value: z.literal('0'), chainId: positiveIntegerSchema, action: z.enum(['approve', 'cancel']),
});
const verificationSchema = z.looseObject({ kind: z.enum(['chain', 'mock']), chainVerified: z.boolean(), hashVerified: z.boolean() });
const evidenceResponseSchema = z.looseObject({
  taskId: z.string().min(1), status: statusSchema, chainId: positiveIntegerSchema, verification: verificationSchema,
  intent: z.looseObject({ recipient: addressSchema, amountWei: uintSchema, walletAddress: addressSchema }),
  transactions: z.array(z.looseObject({ role: z.enum(['request', 'approve', 'cancel']), hash: hashSchema })),
});
const errorInfoSchema = z.looseObject({ code: z.string().min(1).max(200), message: z.string().min(1).max(16_384), details: z.json().optional() });
const errorResponseSchema = z.union([z.looseObject({ error: errorInfoSchema }).transform(value => value.error), errorInfoSchema]);
const requestPathSchema = z.string().regex(/^\/(?!\/)[^\s#]*$/).max(2048);
const requestMethodSchema = z.enum(['GET', 'POST', 'PATCH']);

function clearStoredToken() {
  try { sessionStorage.removeItem('aegis.session'); } catch { /* Session storage is optional. */ }
}
function loadToken(): string {
  try {
    const raw: unknown = sessionStorage.getItem('aegis.session');
    if (raw === null) return '';
    const parsed = sessionTokenSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    clearStoredToken();
  } catch { /* Browsers can deny access to session storage. */ }
  return '';
}

let token = loadToken();
const pendingMutationKeys = new Map<string, string>();
let intentTimeoutMs = 12_000;
const chainReadTimeoutMs = 45_000;

export function requestDeadlineMs(path: string, method: string, plannerTimeoutMs = intentTimeoutMs): number {
  const isIntentParsing = method === 'POST' && path === '/intents' || method === 'PATCH' && /^\/intents\/[^/]+$/.test(path);
  if (isIntentParsing) return plannerTimeoutMs;
  const isChainRead = method === 'GET' && path === '/wallets/current'
    || method === 'POST' && /^\/intents\/[^/]+\/preview$/.test(path)
    || method === 'GET' && /^\/tasks\/[^/]+\/owner-tx\?/.test(path)
    || method === 'POST' && /^\/tasks\/[^/]+\/observed-tx$/.test(path)
    || /^\/subscriptions(?:\/|$)/.test(path);
  return isChainRead ? chainReadTimeoutMs : 12_000;
}

export function setToken(value: string) {
  const parsed = value === '' ? undefined : sessionTokenSchema.safeParse(value);
  if (parsed && !parsed.success) {
    token = ''; clearStoredToken();
    throw new ApiError(0, 'INVALID_SESSION', '登录服务返回了无效会话，请重新连接。');
  }
  token = parsed?.success ? parsed.data : '';
  try {
    if (token) sessionStorage.setItem('aegis.session', token);
    else sessionStorage.removeItem('aegis.session');
  } catch { /* Keep the in-memory session when storage is unavailable. */ }
}
export function hasSession() { return Boolean(token); }

function responseSchema(path: string, method: string): z.ZodType<Data> {
  const pathname = path.split('?')[0];
  if (pathname === '/config') return configResponseSchema;
  if (pathname === '/auth/challenge') return authChallengeResponseSchema;
  if (pathname === '/auth/verify') return authSessionResponseSchema;
  if (pathname === '/wallets/current') return walletSnapshotResponseSchema;
  if (pathname === '/subscriptions') return subscriptionListSchema;
  if (pathname === '/subscriptions/policy-preview') return subscriptionPolicyPreviewSchema;
  if (pathname === '/subscriptions/policy-observed') return subscriptionPolicySchema;
  if (pathname === '/subscriptions/preview') return subscriptionPreviewSchema;
  if (/^\/subscriptions\/[^/]+\/control-preview$/.test(pathname)) return subscriptionControlPreviewSchema;
  if (pathname === '/subscriptions/observed' || /^\/subscriptions\/[^/]+\/control-observed$/.test(pathname)) return subscriptionRecordSchema;
  if (pathname === '/tasks') return tasksResponseSchema;
  if (/^\/tasks\/[^/]+\/owner-tx$/.test(pathname)) return ownerTransactionResponseSchema;
  if (/^\/tasks\/[^/]+\/ccip-delivery$/.test(pathname)) return ccipDeliverySchema;
  if (/^\/tasks\/[^/]+\/evidence$/.test(pathname)) return evidenceResponseSchema;
  if (/^\/tasks\/[^/]+(?:\/observed-tx)?$/.test(pathname)) return taskResponseSchema;
  if (/^\/intents\/[^/]+\/submit$/.test(pathname)) return taskResponseSchema;
  if (/^\/intents\/[^/]+\/preview$/.test(pathname)) return quoteResponseSchema;
  if (pathname === '/intents' && method === 'POST' || /^\/intents\/[^/]+$/.test(pathname)) return intentResponseSchema;
  return apiRecordSchema;
}
function invalidResponse(status: number, path = '', fields: string[] = []) {
  let message = '服务返回了无法读取的结果，请检查后端是否启动。';
  if (status >= 200 && status < 300 && path.split('?')[0] === '/wallets/current') {
    if (fields.includes('recipientAddress')) message = '快照缺少运行钱包地址或地址无效，无法确认余额属于哪个钱包，已停止判断（不按 0 处理）。';
    else if (fields.some(field => ['chainId', 'walletAddress', 'ownerAddress', 'agentAddress'].includes(field))) message = '链上快照缺少或包含无效的钱包身份（网络、资金池或运行钱包地址），无法确认余额归属（不按 0 处理）。';
    else if (fields.some(field => ['recipientBalanceWei', 'walletBalanceWei', 'agentBalanceWei'].includes(field))) message = '链上快照缺少运行钱包余额或余额无效，已停止判断（不按 0 处理）。';
    else if (fields.some(field => ['observedBlockNumber', 'observedBlockHash', 'observedAt'].includes(field))) message = '链上快照缺少有效的观测区块或时间，已停止判断（不按 0 处理）。';
    else message = '链上快照的钱包身份、余额、观测区块或时间缺失或无效，已停止判断（不按 0 处理）。';
  }
  return new ApiError(status, 'INVALID_RESPONSE', message);
}

export async function api(path: string, method = 'GET', body?: Data): Promise<Data> {
  let serializedBody: string | undefined;
  try { serializedBody = body === undefined ? undefined : JSON.stringify(body); }
  catch { throw new ApiError(0, 'INVALID_REQUEST', '请求字段不符合接口约定，已停止操作。'); }
  if (!requestPathSchema.safeParse(path).success || !requestMethodSchema.safeParse(method).success || (body !== undefined && !apiRecordSchema.safeParse(body).success)) {
    throw new ApiError(0, 'INVALID_REQUEST', '请求字段不符合接口约定，已停止操作。');
  }
  const controller = new AbortController();
  // Intent parsing follows the configured model deadline; payment requests keep
  // an independent 12-second cap and their original idempotency key on retry.
  const isIntentParsing = method === 'POST' && path === '/intents' || method === 'PATCH' && /^\/intents\/[^/]+$/.test(path);
  const timeout = window.setTimeout(() => controller.abort(), requestDeadlineMs(path, method));
  const fingerprint = method === 'GET' ? '' : `${method}:${path}:${serializedBody ?? '{}'}`;
  const mutationKey = fingerprint ? pendingMutationKeys.get(fingerprint) || crypto.randomUUID() : '';
  if (fingerprint) pendingMutationKeys.set(fingerprint, mutationKey);
  const requestToken = token;
  try {
    const response = await fetch(`/api/v1${path}`, {
      method, credentials: 'same-origin', signal: controller.signal,
      headers: {
        Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}), ...(mutationKey ? { 'Idempotency-Key': mutationKey } : {}),
      },
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
    if (response.status === 401 && token === requestToken) setToken('');
    if (!response.ok && response.status < 500 && fingerprint) pendingMutationKeys.delete(fingerprint);
    const raw = await response.text();
    let data: unknown;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw invalidResponse(response.status, path); }
    const json = apiRecordSchema.safeParse(data);
    if (!json.success) throw invalidResponse(response.status, path);
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(json.data);
      if (!parsed.success) throw invalidResponse(response.status);
      const error = parsed.data;
      throw new ApiError(response.status, error.code, error.message, error.details);
    }
    const parsed = responseSchema(path, method).safeParse(json.data);
    if (!parsed.success) throw invalidResponse(response.status, path, parsed.error.issues.map(issue => String(issue.path[0] ?? '')));
    if (parsed.data.actionKind === 'SUBSCRIPTION' && /^\/(intents|tasks)(?:\/|$)/.test(path) && !path.endsWith('/evidence')) {
      const binding = z.looseObject({ subscriptionId: uintSchema, occurrenceIndex: uintSchema, subscription: subscriptionFieldsSchema });
      if (!binding.safeParse(parsed.data).success || (/\/(preview|submit)$/.test(path) && !hashSchema.safeParse(parsed.data.planHash).success)) throw invalidResponse(response.status, path);
    }
    if (parsed.data.actionKind === 'CCIP_TRANSFER' && /^\/(intents|tasks)(?:\/|$)/.test(path) && !path.endsWith('/evidence')) {
      const ccipParsed=/\/preview$/.test(path)?ccipQuoteBindingSchema.safeParse(parsed.data):/^\/tasks(?:\/|$)/.test(path)||/\/submit$/.test(path)?ccipTaskBindingSchema.safeParse(parsed.data):ccipIntentBindingSchema.safeParse(parsed.data);
      if(!ccipParsed.success)throw invalidResponse(response.status,path,ccipParsed.error.issues.map(issue=>String(issue.path[0]??'')));
    }
    if (fingerprint) pendingMutationKeys.delete(fingerprint);
    if (method === 'GET' && path === '/config') {
      const config = configResponseSchema.parse(parsed.data);
      intentTimeoutMs = config.planner?.mode === 'live' ? Math.max(12_000, config.planner.timeoutMs + 5_000) : 12_000;
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) throw new ApiError(0, 'REQUEST_TIMEOUT', isIntentParsing
      ? '意图解析等待超时，请稍后重试；尚未提交付款。'
      : '服务响应超时，请查看原任务状态；不能据此判断付款结果。');
    throw new ApiError(0, 'OFFLINE', '无法连接本地服务。请确认 API 已在 3001 端口启动，再重试。');
  } finally { window.clearTimeout(timeout); }
}
