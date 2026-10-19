// Gas-reserve recommendation helpers for the single configured operating wallet.
// All payment quantities are integer wei (bigint). No Number/float arithmetic on amounts.
import { isAddress, parseEther } from 'viem';

type Data = Record<string, unknown>;

/** Environment identity a reserve suggestion is bound to. Addresses are lower-cased. */
export interface ReserveBinding { chainId: number; treasury: string; recipient: string }

/** One validated chain observation of the operating wallet's ETH balance. */
export interface ReserveObservation {
  balanceWei: bigint; blockNumber: string; blockHash: string; observedAt: string; chainId: number;
}

export type ParsedAmount = { ok: true; wei: bigint } | { ok: false; error: string };
export type ReserveSettings =
  | { ok: true; thresholdWei: bigint; targetWei: bigint }
  | { ok: false; empty: boolean; error: string };
export type Suggestion = { kind: 'low'; topUpWei: bigint } | { kind: 'healthy'; topUpWei: 0n };

const ETH_TEXT = /^\d+(\.\d{1,18})?$/;
const UINT = /^\d+$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseEthAmount(text: string): ParsedAmount {
  const value = text.trim();
  if (!value) return { ok: false, error: '请填写 ETH 数量。' };
  if (!ETH_TEXT.test(value)) return { ok: false, error: '请输入十进制 ETH 数量，最多 18 位小数。' };
  const wei = parseEther(value);
  if (wei <= 0n) return { ok: false, error: 'ETH 数量必须大于 0。' };
  return { ok: true, wei };
}

export function parseSettings(thresholdText: string, targetText: string): ReserveSettings {
  if (!thresholdText.trim() && !targetText.trim()) return { ok: false, empty: true, error: '设置准备金下限和目标余额后，才会给出补给建议。' };
  const threshold = parseEthAmount(thresholdText);
  if (!threshold.ok) return { ok: false, empty: false, error: `下限：${threshold.error}` };
  const target = parseEthAmount(targetText);
  if (!target.ok) return { ok: false, empty: false, error: `目标余额：${target.error}` };
  if (threshold.wei >= target.wei) return { ok: false, empty: false, error: '下限必须小于目标余额。' };
  return { ok: true, thresholdWei: threshold.wei, targetWei: target.wei };
}

/** Below the user's own threshold → suggest target − balance. Otherwise no top-up. */
export function suggestTopUp(balanceWei: bigint, thresholdWei: bigint, targetWei: bigint): Suggestion {
  if (balanceWei < thresholdWei) return { kind: 'low', topUpWei: targetWei - balanceWei };
  return { kind: 'healthy', topUpWei: 0n };
}

/** Binding comes only from validated GET /api/v1/config. Returns null when incomplete. */
export function bindingFromConfig(config: Data | null): ReserveBinding | null {
  if (!config) return null;
  const chainId = Number(config.chainId);
  const treasury = String(config.walletAddress ?? '');
  const recipient = String(config.recipientAddress ?? '');
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAddress(treasury) || !isAddress(recipient)) return null;
  return { chainId, treasury: treasury.toLowerCase(), recipient: recipient.toLowerCase() };
}

export function sameBinding(a: ReserveBinding | null, b: ReserveBinding | null): boolean {
  return Boolean(a && b && a.chainId === b.chainId && a.treasury === b.treasury && a.recipient === b.recipient);
}

/**
 * Validate an authenticated GET /api/v1/wallets/current snapshot against the binding.
 * Only recipientBalanceWei is the operating-wallet balance, and only when snapshot.recipientAddress equals the bound recipient; walletBalanceWei (treasury)
 * and agentBalanceWei (executor gas) are never used here. A missing field is an error,
 * never a zero balance.
 */
export function observationFromSnapshot(snapshot: Data | null, binding: ReserveBinding | null): { ok: true; observation: ReserveObservation } | { ok: false; error: string } {
  if (!binding) return { ok: false, error: '服务配置缺少网络、金库或运行钱包地址，无法判断。' };
  if (!snapshot) return { ok: false, error: '尚未取得链上余额快照。' };
  if (snapshot.dataSource !== 'chain') return { ok: false, error: '余额快照不是链上数据，无法判断。' };
  if (Number(snapshot.chainId) !== binding.chainId) return { ok: false, error: '余额快照的网络与当前配置不一致，已停止判断。' };
  if (String(snapshot.walletAddress ?? '').toLowerCase() !== binding.treasury) return { ok: false, error: '余额快照的金库地址与当前配置不一致，已停止判断。' };
  // The balance is only meaningful for the wallet it names: a missing or different identity is never shown as a balance.
  if (typeof snapshot.recipientAddress !== 'string' || !isAddress(snapshot.recipientAddress)) return { ok: false, error: '快照缺少运行钱包地址，无法确认余额属于哪个钱包，已停止判断（不按 0 处理）。' };
  if (snapshot.recipientAddress.toLowerCase() !== binding.recipient) return { ok: false, error: '余额快照的运行钱包地址与当前配置不一致，已停止判断。' };
  const balance = snapshot.recipientBalanceWei;
  if (typeof balance !== 'string' || !UINT.test(balance)) return { ok: false, error: '快照缺少运行钱包余额，无法判断（不按 0 处理）。' };
  const blockNumber = snapshot.observedBlockNumber;
  const blockHash = snapshot.observedBlockHash;
  const observedAt = snapshot.observedAt;
  if (typeof blockNumber !== 'string' || !UINT.test(blockNumber) || typeof blockHash !== 'string' || !HASH.test(blockHash) || typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
    return { ok: false, error: '快照缺少观测区块或时间，无法判断。' };
  }
  return { ok: true, observation: { balanceWei: BigInt(balance), blockNumber, blockHash, observedAt, chainId: binding.chainId } };
}

/** Fingerprint of what the user is looking at; any change requires another review. */
export function suggestionKey(binding: ReserveBinding, balanceWei: bigint, thresholdWei: bigint, targetWei: bigint, topUpWei: bigint): string {
  return [binding.chainId, binding.treasury, binding.recipient, balanceWei, thresholdWei, targetWei, topUpWei].join('|');
}

export function storageKey(binding: ReserveBinding): string {
  return `aegis.reserve.v1.${binding.chainId}.${binding.treasury}.${binding.recipient}`;
}

/** Browser-local recommendation settings. Storage may be unavailable; never throws. */
export function loadSettings(binding: ReserveBinding): { threshold: string; target: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(binding)) || 'null') as Data | null;
    return { threshold: typeof raw?.threshold === 'string' ? raw.threshold : '', target: typeof raw?.target === 'string' ? raw.target : '' };
  } catch { return { threshold: '', target: '' }; }
}

export function saveSettings(binding: ReserveBinding, threshold: string, target: string): void {
  try { localStorage.setItem(storageKey(binding), JSON.stringify({ threshold, target })); } catch { /* Local convenience only. */ }
}
