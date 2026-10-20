import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, parseEther, zeroAddress } from 'viem';
import { z } from 'zod';
import type { Config, LlmConfig } from './config.js';
import type { ParserInfo } from '@aegis/shared';
import { parseDraft, type DraftInput, type ParsedDraft } from './parser.js';

const ETH_AMOUNT_RE = /(?:^|[^\w.])(\d+(?:\.\d+)?)\s*(ETH|ether|以太坊|以太)\b/gi;
const UNSUPPORTED_UNIT_RE = /\b(USD|USDC|USDT|DAI|BTC|wei|gwei)\b|美元|美金|\$/i;
const NEGATIVE_ETH_RE = /-\s*\d+(?:\.\d+)?\s*(ETH|ether|以太坊|以太)/i;
const SKILL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../agent/skills/aegis-intent/SKILL.md');

export type LlmClientErrorCode =
  | 'LLM_TIMEOUT'
  | 'LLM_HTTP_429'
  | 'LLM_HTTP_ERROR'
  | 'LLM_EMPTY'
  | 'LLM_INVALID_JSON'
  | 'LLM_RESPONSE_INVALID'
  | 'LLM_REQUEST_FAILED';

export class LlmClientError extends Error {
  constructor(readonly code: LlmClientErrorCode, message: string) {
    super(message);
    this.name = 'LlmClientError';
  }
}

export interface LlmIntentRequest {
  message: string;
  previous: {
    message: string;
    recipient: string | null;
    amountWei: string | null;
    purpose: string;
  } | null;
}

export interface LlmIntentClient {
  readonly provider: 'stub' | 'anthropic' | 'openai';
  readonly model: string;
  extract(request: LlmIntentRequest): Promise<unknown>;
}

const candidateSchema = z.object({
  action: z.enum(['transfer', 'clarify', 'unsupported']),
  recipient: z.string().max(128).nullable(),
  amountEth: z.string().max(64).nullable(),
  purpose: z.string().max(500),
  missingFields: z.array(z.enum(['recipient', 'amount'])).max(2),
  question: z.string().max(500).nullable(),
}).strict();

export type LlmIntentCandidate = z.infer<typeof candidateSchema>;
interface ValidatedCandidate extends LlmIntentCandidate { amountWei: string | null }

export function loadSkillPrompt() {
  try {
    return readFileSync(SKILL_PATH, 'utf8');
  } catch {
    throw new Error(`Aegis intent skill is missing: ${SKILL_PATH}`);
  }
}

export function scanPrompt(text: string) {
  const patterns = [
    /ignore\s+(all|any|the|previous|above|prior|earlier)/i,
    /disregard\s+(all|any|the|previous|above|prior|earlier)/i,
    /(forget|override|bypass)\s+(all|any|the|previous|above|prior|earlier|rules|instructions)/i,
    /(reveal|print|show|repeat|output|leak|drop)\b.{0,40}(system|developer|hidden|original)?\s*prompt/i,
    /system\s+prompt/i,
    /you\s+are\s+now\b/i,
    /new\s+instructions?\s*[:=]/i,
    /developer\s+mode|jail\s*break|dan\s+mode|unrestricted\s+mode/i,
    /(skip|bypass)\s+(the\s+)?(approval|confirmation)/i,
    /ignore.{0,16}(rules|instructions)|忽略.{0,16}(规则|指令)|绕过.{0,16}(审批|规则)|跳过.{0,16}审批|立即付款|系统提示|泄露.{0,16}(提示|prompt)/i,
  ];
  const hits = patterns.filter(pattern => pattern.test(text)).map(pattern => pattern.source);
  return { blocked: hits.length > 0, hits };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new LlmClientError('LLM_EMPTY', '模型返回空内容');
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1].trim() : trimmed);
  } catch {
    throw new LlmClientError('LLM_INVALID_JSON', '模型没有返回合法 JSON');
  }
}

function candidateFromMessage(message: string): LlmIntentCandidate {
  const addresses = [...new Set(message.match(/0x[a-fA-F0-9]{40}\b/g) ?? [])];
  const amounts = [...message.matchAll(ETH_AMOUNT_RE)];
  const unsupported = UNSUPPORTED_UNIT_RE.test(message);
  const negative = NEGATIVE_ETH_RE.test(message);
  const tooPrecise = amounts.some(match => (match[1].split('.')[1]?.length ?? 0) > 18);
  const ambiguous = addresses.length > 1 || amounts.length > 1 || unsupported || negative || tooPrecise;
  const recipient = addresses.length === 1 ? addresses[0] : null;
  const amountEth = !ambiguous && amounts.length === 1 ? amounts[0][1] : null;
  const missingFields: Array<'recipient' | 'amount'> = [];
  if (!recipient) missingFields.push('recipient');
  if (!amountEth) missingFields.push('amount');
  if (ambiguous) {
    return {
      action: 'clarify', recipient: null, amountEth: null, purpose: message.slice(0, 500),
      missingFields: ['recipient', 'amount'], question: '请只提供一个 native ETH 收款地址和一个明确金额。',
    };
  }
  return {
    action: recipient && amountEth ? 'transfer' : 'clarify',
    recipient, amountEth, purpose: message.slice(0, 500), missingFields,
    question: missingFields.length ? '请补充收款地址与明确的 ETH 数额。' : null,
  };
}

export class StubIntentClient implements LlmIntentClient {
  readonly provider = 'stub' as const;
  readonly model: string;
  constructor(
    private readonly handler: (request: LlmIntentRequest) => unknown | Promise<unknown> = request => candidateFromMessage(request.message),
    model = 'stub-intent-v1'
  ) {
    this.model = model;
  }
  async extract(request: LlmIntentRequest) {
    return await this.handler(request);
  }
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new LlmClientError(response.status === 429 ? 'LLM_HTTP_429' : 'LLM_HTTP_ERROR', `模型服务返回 HTTP ${response.status}`);
    if (!text.trim()) throw new LlmClientError('LLM_EMPTY', '模型服务返回空内容');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LlmClientError('LLM_INVALID_JSON', '模型服务返回的响应不是 JSON');
    }
  } catch (error) {
    if (error instanceof LlmClientError) throw error;
    if ((error as { name?: string }).name === 'AbortError') throw new LlmClientError('LLM_TIMEOUT', '模型请求超时');
    throw new LlmClientError('LLM_REQUEST_FAILED', '模型请求失败');
  } finally {
    clearTimeout(timer);
  }
}

export class AnthropicIntentClient implements LlmIntentClient {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly systemPrompt: string;
  constructor(private readonly config: LlmConfig) {
    if (!config.model || !config.apiKey) throw new Error('Anthropic intent client requires a model and API key');
    this.model = config.model;
    this.systemPrompt = loadSkillPrompt();
  }
  async extract(request: LlmIntentRequest) {
    const data = await requestJson(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.config.apiKey!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: this.model, max_tokens: 800, temperature: 0,
        system: this.systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(request) }],
      }),
    }, this.config.timeoutMs);
    const content = (data as { content?: Array<{ type?: string; text?: string }> }).content;
    const text = content?.find(part => part.type === 'text' && typeof part.text === 'string')?.text;
    if (!text) throw new LlmClientError('LLM_EMPTY', 'Anthropic 没有返回文本内容');
    return extractJson(text);
  }
}

export class OpenAiCompatibleIntentClient implements LlmIntentClient {
  readonly provider = 'openai' as const;
  readonly model: string;
  private readonly systemPrompt: string;
  constructor(private readonly config: LlmConfig) {
    if (!config.model || !config.apiKey) throw new Error('OpenAI-compatible intent client requires a model and API key');
    this.model = config.model;
    this.systemPrompt = loadSkillPrompt();
  }
  async extract(request: LlmIntentRequest) {
    const data = await requestJson(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey!}` },
      body: JSON.stringify({
        model: this.model, temperature: 0,
        messages: [{ role: 'system', content: this.systemPrompt }, { role: 'user', content: JSON.stringify(request) }],
        response_format: { type: 'json_object' },
      }),
    }, this.config.timeoutMs);
    const text = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
    if (!text) throw new LlmClientError('LLM_EMPTY', 'OpenAI-compatible provider 没有返回文本内容');
    return extractJson(text);
  }
}

export function createLlmClient(config: LlmConfig): LlmIntentClient | null {
  if (config.mode === 'off') return null;
  if (config.mode === 'stub') return new StubIntentClient();
  if (!config.model || !config.apiKey) throw new Error('Live LLM requires a model and API key');
  if (config.provider === 'anthropic') return new AnthropicIntentClient(config);
  if (config.provider === 'openai') return new OpenAiCompatibleIntentClient(config);
  throw new Error('Live LLM provider must be anthropic or openai');
}

function validateCandidate(raw: unknown): ValidatedCandidate {
  const candidate = candidateSchema.parse(raw);
  let recipient: string | null = null;
  if (candidate.recipient !== null) {
    if (!isAddress(candidate.recipient) || candidate.recipient.toLowerCase() === zeroAddress) {
      throw new LlmClientError('LLM_RESPONSE_INVALID', '模型返回了无效收款地址');
    }
    recipient = getAddress(candidate.recipient);
  }
  let amountWei: string | null = null;
  if (candidate.amountEth !== null) {
    if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(candidate.amountEth)) {
      throw new LlmClientError('LLM_RESPONSE_INVALID', '模型返回了无效 ETH 金额');
    }
    try {
      const parsed = parseEther(candidate.amountEth);
      if (parsed <= 0n || parsed >= 2n ** 256n) throw new Error('out of range');
      amountWei = parsed.toString();
    } catch {
      throw new LlmClientError('LLM_RESPONSE_INVALID', '模型返回了无效 ETH 金额');
    }
  }
  return { ...candidate, recipient, amountWei };
}

export async function parseDraftWithLlm(
  input: DraftInput,
  config: Config,
  previous: import('@aegis/shared').Intent | undefined,
  client: LlmIntentClient | null
): Promise<ParsedDraft> {
  const fallback = (reason: string): ParserInfo => ({
    kind: 'rule_parser', model: null, configuredModel: config.configuredModel, fallback: true, reason,
  });
  if (!client) return parseDraft(input, config.configuredModel, previous, fallback(config.llm.mode === 'off' ? 'LLM_DISABLED_RULE_PARSER_ONLY' : 'LLM_NOT_CONFIGURED'));
  if (input.message === undefined) return parseDraft(input, config.configuredModel, previous, fallback('LLM_NOT_USED_EXPLICIT_FIELDS'));

  const message = input.message ?? previous?.message ?? '';
  if (scanPrompt(message).blocked) return parseDraft(input, config.configuredModel, previous, fallback('PROMPT_BLOCKED'));

  let raw: unknown;
  try {
    raw = await client.extract({
      message,
      previous: previous ? {
        message: previous.message,
        recipient: previous.recipient,
        amountWei: previous.amountWei,
        purpose: previous.purpose,
      } : null,
    });
  } catch (error) {
    return parseDraft(input, config.configuredModel, previous, fallback(error instanceof LlmClientError ? error.code : 'LLM_REQUEST_FAILED'));
  }

  let candidate: ValidatedCandidate;
  try {
    candidate = validateCandidate(raw);
  } catch {
    return parseDraft(input, config.configuredModel, previous, fallback('LLM_SCHEMA_INVALID'));
  }

  // Validate against the current merged request. A prior value is only valid
  // when the latest input did not replace it or make that field ambiguous.
  const authoritativeDraft = parseDraft(input, config.configuredModel, previous);
  const unsupportedRecipient = candidate.recipient !== null && candidate.recipient !== authoritativeDraft.recipient;
  const unsupportedAmount = candidate.amountWei !== null && candidate.amountWei !== authoritativeDraft.amountWei;
  if (unsupportedRecipient || unsupportedAmount) {
    return parseDraft(input, config.configuredModel, previous, fallback('LLM_FIELD_CONFLICT'));
  }

  const parser: ParserInfo = { kind: 'llm', model: client.model, configuredModel: config.configuredModel, fallback: false, reason: 'LLM_OK' };
  const candidateInput: DraftInput = {
    message,
    ...(candidate.recipient !== null ? { recipient: candidate.recipient } : {}),
    ...(candidate.amountWei !== null ? { amountWei: candidate.amountWei } : {}),
    ...(candidate.purpose ? { purpose: candidate.purpose } : {}),
  };
  const draft = parseDraft(candidateInput, config.configuredModel, previous, parser);

  if (candidate.action === 'unsupported') {
    return {
      ...draft, recipient: null, to: null, amountWei: null,
      missingFields: ['unsupported'], status: 'NEEDS_INPUT',
      question: candidate.question ?? '当前仅支持 native ETH 转账；订阅与跨链不在本轮范围。', parser,
    };
  }
  if (candidate.action === 'clarify') {
    return {
      ...draft, status: 'NEEDS_INPUT',
      missingFields: draft.missingFields.length ? draft.missingFields : ['clarification'],
      question: candidate.question ?? draft.question ?? '请补充更明确的转账信息。', parser,
    };
  }
  return { ...draft, question: draft.status === 'NEEDS_INPUT' ? candidate.question ?? draft.question : null };
}
