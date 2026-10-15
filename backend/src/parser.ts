import { getAddress, isAddress, parseEther, zeroAddress, type Address } from 'viem';
import type { Intent, ParserInfo } from '@aegis/shared';
import { ApiError } from './errors.js';

export interface DraftInput { message?: string; recipient?: string | null; amountWei?: string | null; purpose?: string }
export function parseDraft(input: DraftInput, configuredModel: string | null, previous?: Intent) {
  const message = input.message ?? previous?.message ?? '';
  const parser: ParserInfo = { kind: 'rule_parser', model: null, configuredModel, fallback: !!configuredModel, reason: configuredModel ? 'LLM_NOT_ENABLED_RULE_PARSER_ONLY' : 'RULE_PARSER_ONLY' };
  let recipient: Address | null = (previous?.recipient as Address | null) ?? null;
  let amountWei: string | null = previous?.amountWei ?? null;
  let ambiguousUnit = false;
  if (input.message !== undefined) {
    recipient = null; amountWei = null;
    const addresses = [...new Set(message.match(/0x[a-fA-F0-9]{40}\b/g) ?? [])];
    if (addresses.length === 1 && isAddress(addresses[0]) && addresses[0].toLowerCase() !== zeroAddress) recipient = getAddress(addresses[0]);
    const values = [...message.matchAll(/(?:^|[^\w.])(\d+(?:\.\d+)?)\s*(ETH|ether|以太坊|以太)\b/gi)];
    ambiguousUnit = /\b(USD|USDC|USDT|DAI|BTC|wei|gwei)\b|美元|美金|\$/i.test(message) || values.length > 1;
    const negativeAmount = /-\s*\d+(?:\.\d+)?\s*(ETH|ether|以太坊|以太)/i.test(message);
    if (values.length === 1 && !ambiguousUnit && !negativeAmount && (values[0][1].split('.')[1]?.length ?? 0) <= 18) {
      try { const parsed = parseEther(values[0][1]); if (parsed > 0n && parsed < 2n ** 256n) amountWei = parsed.toString(); } catch { /* ask for an exact amount */ }
    }
  }
  if (input.recipient !== undefined) {
    if (input.recipient === null) recipient = null;
    else if (!isAddress(input.recipient) || input.recipient.toLowerCase() === zeroAddress) throw new ApiError(400, 'INVALID_RECIPIENT', '收款地址必须是非零 Ethereum 地址');
    else recipient = getAddress(input.recipient);
  }
  if (input.amountWei !== undefined) {
    if (input.amountWei === null) amountWei = null;
    else if (!/^[1-9]\d*$/.test(input.amountWei) || BigInt(input.amountWei) >= 2n ** 256n) throw new ApiError(400, 'INVALID_AMOUNT', 'amountWei 必须是正整数字符串');
    else { amountWei = input.amountWei; ambiguousUnit = false; }
  }
  const missingFields: string[] = [];
  if (!recipient) missingFields.push('recipient');
  if (!amountWei) missingFields.push(ambiguousUnit ? 'unit' : 'amountWei');
  return {
    message, recipient, to: recipient, amountWei, purpose: (input.purpose ?? previous?.purpose ?? message).slice(0, 500),
    missingFields, status: missingFields.length ? 'NEEDS_INPUT' as const : 'DRAFT' as const,
    question: missingFields.length ? (ambiguousUnit ? '目前仅支持 native ETH；请明确输入 ETH 数额或整数 amountWei，美元与其他代币不会自动换算。' : `请补充${missingFields.includes('recipient') ? '收款钱包地址' : ''}${missingFields.length > 1 ? '与' : ''}${missingFields.includes('amountWei') ? '明确 ETH 数额' : ''}`) : null,
    parser,
  };
}
