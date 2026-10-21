import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, parseEthAmount, parseSettings, saveSettings, storageKey, type ReserveBinding } from './reserve';
import { applyTheme, currentTheme, initTheme, THEME_KEY, toggleTheme } from './theme';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const binding: ReserveBinding = { chainId: 31337, treasury: '0x1111111111111111111111111111111111111111', recipient: '0x2222222222222222222222222222222222222222' };
const empty = { threshold: '', target: '' };
let storage: MemoryStorage;
let dataset: Record<string, string | undefined>;
let setMeta = vi.fn<(name: string, value: string) => void>();

beforeEach(() => {
  storage = new MemoryStorage(); dataset = {}; setMeta = vi.fn();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('document', { documentElement: { dataset }, querySelector: () => ({ setAttribute: setMeta }) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('reserve amount inputs', () => {
  it('keeps exact integer wei for decimal ETH including the smallest unit', () => {
    expect(parseEthAmount(' 0.1 ')).toEqual({ ok: true, wei: 100_000_000_000_000_000n });
    expect(parseEthAmount('0.000000000000000001')).toEqual({ ok: true, wei: 1n });
  });

  it('retains separate empty, decimal-format, and zero messages', () => {
    expect(parseEthAmount('  ')).toEqual({ ok: false, error: '请填写 ETH 数量。' });
    expect(parseEthAmount('0')).toEqual({ ok: false, error: 'ETH 数量必须大于 0。' });
    expect(parseEthAmount('1e-3')).toEqual({ ok: false, error: '请输入十进制 ETH 数量，最多 18 位小数。' });
  });

  it.each([null, undefined, false, 1, {}, '-1', '0.0000000000000000001'])('rejects malformed amount input without throwing: %j', input => {
    expect(parseEthAmount(input)).toEqual({ ok: false, error: '请输入十进制 ETH 数量，最多 18 位小数。' });
  });

  it('accepts uint256 maximum wei and rejects the next wei', () => {
    expect(parseEthAmount('115792089237316195423570985008687907853269984665640564039457.584007913129639935'))
      .toEqual({ ok: true, wei: 2n ** 256n - 1n });
    expect(parseEthAmount('115792089237316195423570985008687907853269984665640564039457.584007913129639936'))
      .toEqual({ ok: false, error: 'ETH 数量超过合约允许范围。' });
  });

  it('validates both settings while preserving the field-specific messages', () => {
    expect(parseSettings('0.05', '0.1')).toEqual({ ok: true, thresholdWei: 50_000_000_000_000_000n, targetWei: 100_000_000_000_000_000n });
    expect(parseSettings('', ' ')).toMatchObject({ ok: false, empty: true });
    expect(parseSettings(null, '0.1')).toMatchObject({ ok: false, empty: false, error: expect.stringContaining('下限：') });
    expect(parseSettings('0.05', {})).toMatchObject({ ok: false, empty: false, error: expect.stringContaining('目标余额：') });
    expect(parseSettings('0.1', '0.05')).toMatchObject({ ok: false, error: '下限必须小于目标余额。' });
  });
});

describe('browser-local reserve settings', () => {
  it('round-trips typed text and isolates settings by environment identity', () => {
    saveSettings(binding, '0.05', '0.1');
    expect(loadSettings(binding)).toEqual({ threshold: '0.05', target: '0.1' });
    expect(loadSettings({ ...binding, chainId: 11155111 })).toEqual(empty);
    expect(loadSettings({ ...binding, recipient: '0x3333333333333333333333333333333333333333' })).toEqual(empty);
  });

  it.each([null, '', '{broken', 'null', '[]', '123', '"text"'])('falls back safely for empty or corrupt storage: %s', raw => {
    if (raw !== null) storage.setItem(storageKey(binding), raw);
    expect(loadSettings(binding)).toEqual(empty);
  });

  it('keeps a valid field when the other stored field has the wrong type', () => {
    storage.setItem(storageKey(binding), JSON.stringify({ threshold: 0.05, target: '0.1', extra: 'ignored' }));
    expect(loadSettings(binding)).toEqual({ threshold: '', target: '0.1' });
    storage.setItem(storageKey(binding), JSON.stringify({ threshold: '0.05' }));
    expect(loadSettings(binding)).toEqual({ threshold: '0.05', target: '' });
  });

  it('rejects oversized stored text while preserving the other field', () => {
    storage.setItem(storageKey(binding), JSON.stringify({ threshold: '9'.repeat(97), target: '0.1' }));
    expect(loadSettings(binding)).toEqual({ threshold: '', target: '0.1' });
  });

  it('does not overwrite saved values with invalid runtime input', () => {
    saveSettings(binding, '0.05', '0.1');
    saveSettings(binding, 0.02, '0.2');
    saveSettings(binding, '0.02', '9'.repeat(97));
    expect(loadSettings(binding)).toEqual({ threshold: '0.05', target: '0.1' });
  });

  it('allows invalid decimal draft text to remain editable until amount validation', () => {
    saveSettings(binding, '0.', '');
    expect(loadSettings(binding)).toEqual({ threshold: '0.', target: '' });
    expect(parseSettings('0.', '')).toMatchObject({ ok: false, empty: false });
  });

  it('tolerates denied storage reads and writes', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } });
    expect(loadSettings(binding)).toEqual(empty);
    expect(() => saveSettings(binding, '0.05', '0.1')).not.toThrow();
  });
});

describe('appearance preference', () => {
  it('restores a saved theme and updates page chrome', () => {
    storage.setItem(THEME_KEY, 'dark'); initTheme();
    expect(currentTheme()).toBe('dark'); expect(dataset.theme).toBe('dark');
    expect(setMeta).toHaveBeenCalledWith('content', '#121314');
    expect(toggleTheme()).toBe('light'); expect(storage.getItem(THEME_KEY)).toBe('light');
    expect(setMeta).toHaveBeenLastCalledWith('content', '#f4f3ef');
  });

  it.each([null, '', 'Dark', 'invalid', '{"theme":"dark"}'])('defaults to light for an absent or corrupt saved theme: %s', raw => {
    if (raw !== null) storage.setItem(THEME_KEY, raw);
    initTheme(); expect(currentTheme()).toBe('light');
  });

  it('rejects an invalid runtime storage type', () => {
    vi.stubGlobal('localStorage', { getItem: () => 42 });
    initTheme(); expect(currentTheme()).toBe('light');
  });

  it('keeps the current page usable when storage is blocked', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } });
    expect(() => initTheme()).not.toThrow(); expect(currentTheme()).toBe('light');
    expect(toggleTheme()).toBe('dark'); expect(currentTheme()).toBe('dark');
  });

  it('defaults an invalid DOM preference to light', () => {
    dataset.theme = 'unsupported'; expect(currentTheme()).toBe('light');
    applyTheme('dark'); expect(currentTheme()).toBe('dark');
  });
});
