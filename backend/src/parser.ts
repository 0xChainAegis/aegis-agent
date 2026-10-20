import { getAddress, isAddress, parseEther, zeroAddress, type Address } from 'viem';
import type { Intent, ParserInfo } from '@aegis/shared';
import { ApiError } from './errors.js';

export interface DraftInput { message?: string; recipient?: string | null; amountWei?: string | null; purpose?: string }

export interface ParsedDraft {
  message: string;
  recipient: Address | null;
  to: Address | null;
  amountWei: string | null;
  purpose: string;
  missingFields: string[];
  status: 'NEEDS_INPUT' | 'DRAFT';
  question: string | null;
  parser: ParserInfo;
}

const ETH_AMOUNT_RE = /(?:^|[^\w.])(\d+(?:\.\d+)?)\s*(ETH|ether|以太坊|以太)\b/gi;
const UNSUPPORTED_UNIT_RE = /\b(USD|USDC|USDT|DAI|BTC|wei|gwei)\b|美元|美金|\$/i;
const NEGATIVE_ETH_RE = /-\s*\d+(?:\.\d+)?\s*(ETH|ether|以太坊|以太)/i;

// A narrow input heuristic, shared by rule and LLM entry points. This does not
// replace the explicit confirmation and on-chain authorization checks.
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
    /\b(?:approve|approved)\b["']?\s*(?:(?:[:=]|\bto\b)\s*|\s+)["']?true\b/i,
    /ignore.{0,16}(rules|instructions)|忽略.{0,16}(规则|指令)|绕过.{0,16}(审批|规则)|跳过.{0,16}审批|立即付款|系统提示|泄露.{0,16}(提示|prompt)/i,
  ];
  const hits = patterns.filter(pattern => pattern.test(text)).map(pattern => pattern.source);
  return { blocked: hits.length > 0, hits };
}

function messageFields(message: string) {
  const addresses = [...new Set(message.match(/0x[a-fA-F0-9]{40}\b/g) ?? [])];
  const values = [...message.matchAll(ETH_AMOUNT_RE)];
  return {
    addresses,
    values,
    unsupportedUnit: UNSUPPORTED_UNIT_RE.test(message),
    negative: NEGATIVE_ETH_RE.test(message),
    tooPrecise: values.some(match => (match[1].split('.')[1]?.length ?? 0) > 18),
    amountConflict: values.length > 1,
    recipientConflict: addresses.length > 1,
  };
}

function questionFor(
  missingFields: string[],
  flags: { unsupportedUnit: boolean; amountConflict: boolean; recipientConflict: boolean; negative: boolean; tooPrecise: boolean }
) {
  if (flags.recipientConflict) return '检测到多个收款地址；请只保留一个 Ethereum 地址。';
  if (flags.amountConflict) return '检测到多个金额；请只保留一个 ETH 金额。';
  if (flags.unsupportedUnit) return '目前仅支持 native ETH；美元与其他代币不会自动换算。';
  if (flags.negative || flags.tooPrecise) return '请提供正的 ETH 金额，最多 18 位小数。';
  if (missingFields.includes('recipient') && missingFields.includes('amountWei')) return '请补充收款钱包地址与明确的 ETH 数额。';
  if (missingFields.includes('recipient')) return '请补充收款钱包地址。';
  if (missingFields.includes('amountWei')) return '请补充明确的 ETH 数额。';
  return null;
}

export function parseDraft(input: DraftInput, configuredModel: string | null, previous?: Intent, parserOverride?: ParserInfo): ParsedDraft {
  const message = input.message ?? previous?.message ?? '';
  const purpose = input.purpose ?? previous?.purpose ?? message;
  const parser: ParserInfo = parserOverride ?? { kind: 'rule_parser', model: null, configuredModel, fallback: !!configuredModel, reason: configuredModel ? 'LLM_NOT_ENABLED_RULE_PARSER_ONLY' : 'RULE_PARSER_ONLY' };
  if (scanPrompt(message).blocked || scanPrompt(purpose).blocked) {
    return {
      message, recipient: null, to: null, amountWei: null,
      purpose: purpose.slice(0, 500),
      missingFields: ['prompt'], status: 'NEEDS_INPUT',
      question: '请求包含修改规则或审批状态的指令；请重新提供收款地址与 ETH 金额。',
      parser: { ...parser, kind: 'rule_parser', model: null, reason: 'PROMPT_BLOCKED' },
    };
  }
  let recipient: Address | null = (previous?.recipient as Address | null) ?? null;
  let amountWei: string | null = previous?.amountWei ?? null;
  let flags = { unsupportedUnit: false, amountConflict: false, recipientConflict: false, negative: false, tooPrecise: false };
  if (input.message !== undefined) {
    const fields = messageFields(message);
    flags = {
      unsupportedUnit: fields.unsupportedUnit,
      amountConflict: fields.amountConflict,
      recipientConflict: fields.recipientConflict,
      negative: fields.negative,
      tooPrecise: fields.tooPrecise,
    };

    if (fields.recipientConflict) recipient = null;
    else if (fields.addresses.length === 1) {
      recipient = isAddress(fields.addresses[0]) && fields.addresses[0].toLowerCase() !== zeroAddress
        ? getAddress(fields.addresses[0])
        : null;
    }

    if (fields.unsupportedUnit || fields.amountConflict || fields.negative || fields.tooPrecise) {
      amountWei = null;
    } else if (fields.values.length === 1) {
      try {
        const parsed = parseEther(fields.values[0][1]);
        amountWei = parsed > 0n && parsed < 2n ** 256n ? parsed.toString() : null;
      } catch {
        amountWei = null;
      }
    }
  }
  if (input.recipient !== undefined) {
    if (input.recipient === null) recipient = null;
    else if (!isAddress(input.recipient) || input.recipient.toLowerCase() === zeroAddress) throw new ApiError(400, 'INVALID_RECIPIENT', '收款地址必须是非零 Ethereum 地址');
    else { recipient = getAddress(input.recipient); flags.recipientConflict = false; }
  }
  if (input.amountWei !== undefined) {
    if (input.amountWei === null) amountWei = null;
    else if (!/^[1-9]\d*$/.test(input.amountWei) || BigInt(input.amountWei) >= 2n ** 256n) throw new ApiError(400, 'INVALID_AMOUNT', 'amountWei 必须是正整数字符串');
    else { amountWei = input.amountWei; flags.unsupportedUnit = false; flags.amountConflict = false; flags.negative = false; flags.tooPrecise = false; }
  }
  const missingFields: string[] = [];
  if (!recipient) missingFields.push('recipient');
  if (!amountWei) missingFields.push(flags.unsupportedUnit ? 'unit' : 'amountWei');
  return {
    message, recipient, to: recipient, amountWei, purpose: purpose.slice(0, 500),
    missingFields, status: missingFields.length ? 'NEEDS_INPUT' as const : 'DRAFT' as const,
    question: missingFields.length ? questionFor(missingFields, flags) : null,
    parser,
  };
}
