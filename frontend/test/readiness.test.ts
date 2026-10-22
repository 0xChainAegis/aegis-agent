import { describe, expect, it } from 'vitest';
import { serviceReadiness } from '../src/readiness';
import { ConfigResponseSchema } from '../src/schemas';

const config = {
  mode: 'testnet',
  chainId: 11155111,
  walletAddress: '0x1111111111111111111111111111111111111111',
  ownerAddress: '0x2222222222222222222222222222222222222222',
  recipientAddress: '0x3333333333333333333333333333333333333333',
  agentAddress: '0x4444444444444444444444444444444444444444',
  readiness: {
    ready: true,
    rpcChainId: 11155111,
    contractsDeployed: true,
    deploymentBindingsVerified: true,
    feedFresh: true,
  },
} as const;

describe('ConfigResponseSchema', () => {
  it('accepts a complete runtime response and preserves extra safe fields', () => {
    const result = ConfigResponseSchema.safeParse({ ...config, explorerBaseUrl: 'https://sepolia.etherscan.io' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.explorerBaseUrl).toBe('https://sepolia.etherscan.io');
  });

  it.each([
    ['empty input', null],
    ['missing addresses', { mode: 'testnet', chainId: 11155111, readiness: { ready: false } }],
    ['zero address', { ...config, walletAddress: '0x0000000000000000000000000000000000000000' }],
    ['invalid readiness value', { ...config, readiness: { ready: 'yes' } }],
  ])('rejects %s', (_name, value) => {
    expect(ConfigResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe('serviceReadiness', () => {
  it('enables connection and payment only after all readiness proofs pass', () => {
    expect(serviceReadiness(config)).toMatchObject({
      phase: 'ready', code: 'READY', tone: 'green', title: 'Sepolia 已就绪', canConnect: true, canPay: true,
    });
  });

  it('treats empty and malformed config as blocked instead of throwing', () => {
    expect(serviceReadiness(null)).toMatchObject({ code: 'CONFIG_INVALID', canConnect: false, canPay: false });
    expect(serviceReadiness({ ...config, chainId: -1 })).toMatchObject({ code: 'CONFIG_INVALID', canConnect: false, canPay: false });
  });

  it('distinguishes initial loading, API offline, and API timeout', () => {
    expect(serviceReadiness(null, { initialLoading: true })).toMatchObject({ code: 'LOADING', phase: 'loading' });
    expect(serviceReadiness(null, { online: false })).toMatchObject({ code: 'API_OFFLINE', title: 'API 离线' });
    expect(serviceReadiness(null, { online: false, apiErrorCode: 'REQUEST_TIMEOUT' })).toMatchObject({ code: 'REQUEST_TIMEOUT', title: 'API 响应超时' });
  });

  it('allows read-only login for a stale feed only when deployment identity is verified', () => {
    const stale = { ...config, readiness: { ...config.readiness, ready: false, code: 'FEED_STALE', feedFresh: false } };
    expect(serviceReadiness(stale)).toMatchObject({ phase: 'limited', canConnect: true, canPay: false });
    expect(serviceReadiness({ ...stale, readiness: { ready: false, code: 'FEED_STALE' } })).toMatchObject({ canConnect: false, canPay: false });
  });

  it.each([
    ['DEPLOYMENT_BINDING_MISMATCH', '合约配置未就绪'],
    ['FUTURE_UNKNOWN_FAILURE', '链上状态未确认'],
  ])('maps %s to an actionable blocked state', (code, title) => {
    const result = serviceReadiness({ ...config, readiness: { ...config.readiness, ready: false, code } });
    expect(result).toMatchObject({ title, canPay: false });
    expect(result.actionLabel).not.toBe('');
  });

  it('keeps a verified wallet connected across a transient RPC error but blocks payment', () => {
    expect(serviceReadiness({ ...config, readiness: { ...config.readiness, ready: false, code: 'CHAIN_UNAVAILABLE' } }))
      .toMatchObject({ phase: 'limited', title: 'Sepolia RPC 暂时波动', canConnect: true, canPay: false });
    expect(serviceReadiness({ ...config, readiness: { ready: false, code: 'CHAIN_UNAVAILABLE' } }))
      .toMatchObject({ title: 'Sepolia RPC 暂不可用', canConnect: false, canPay: false });
  });

  it('blocks a mismatched chain even if the backend says ready', () => {
    const result = serviceReadiness({ ...config, readiness: { ...config.readiness, rpcChainId: 1 } });
    expect(result).toMatchObject({ code: 'CHAIN_MISMATCH', canConnect: false, canPay: false });
  });

  it('keeps pending or timed-out Sepolia checks separate from API outages and blocks signing', () => {
    expect(serviceReadiness({ ...config, readiness: { ready: false, code: 'READINESS_CHECKING', source: 'checking', checkedAt: null, cacheAgeMs: null } }))
      .toMatchObject({ phase: 'loading', title: '正在核对 Sepolia', canConnect: false, canPay: false });
    expect(serviceReadiness({ ...config, readiness: { ready: false, code: 'READINESS_TIMEOUT' } }))
      .toMatchObject({ title: 'Sepolia 检查超时', canConnect: false, canPay: false });
  });

  it.each([
    { checkedAt: 'yesterday' }, { cacheAgeMs: -1 }, { cacheAgeMs: '0' }, { source: 'trusted_forever' },
  ])('rejects malformed readiness metadata instead of enabling payment: %j', metadata => {
    expect(serviceReadiness({ ...config, readiness: { ...config.readiness, ...metadata } }))
      .toMatchObject({ code: 'CONFIG_INVALID', canConnect: false, canPay: false });
  });

  it('rejects expired or incomplete cached proofs and accepts a bounded recent result', () => {
    const proof = { ...config.readiness, source: 'cache', checkedAt: '2026-10-22T00:00:00.000Z', cacheAgeMs: 14_999, cacheTtlMs: 15_000 };
    expect(serviceReadiness({ ...config, readiness: proof }).canPay).toBe(true);
    for (const change of [{ cacheAgeMs: 15_000 }, { checkedAt: null }, { cacheAgeMs: null }, { source: 'checking' }]) {
      expect(serviceReadiness({ ...config, readiness: { ...proof, ...change } }))
        .toMatchObject({ code: 'CONFIG_INVALID', canConnect: false, canPay: false });
    }
  });
});
