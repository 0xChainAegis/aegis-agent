import { describe, expect, it } from 'vitest';
import { serviceReadiness } from './readiness';

const addresses = {
  walletAddress: '0x1111111111111111111111111111111111111111',
  ownerAddress: '0x2222222222222222222222222222222222222222',
  recipientAddress: '0x3333333333333333333333333333333333333333',
  agentAddress: '0x4444444444444444444444444444444444444444',
};
const structural = { rpcChainId: 31337, contractsDeployed: true, deploymentBindingsVerified: true };
const config = { chainId: 31337, ...addresses };

describe('service readiness permissions', () => {
  it('allows payment only for explicitly ready and structurally verified service', () => {
    expect(serviceReadiness({ ...config, readiness: { ...structural, ready: true } })).toEqual({ canConnect: true, canPay: true, message: '' });
    for (const readiness of [
      { ...structural, ready: false }, { ready: true }, { ...structural, contractsDeployed: false, ready: true },
      { ...structural, deploymentBindingsVerified: false, ready: true }, { ...structural, ready: true, code: 'UNKNOWN' },
    ]) {
      const result = serviceReadiness({ ...config, readiness });
      expect(result.canPay).toBe(false);
      expect(result.canConnect).toBe(false);
      expect(result.message).not.toBe('');
    }
  });

  it.each([
    ['FEED_STALE', '价格已过期'],
    ['FUNDING_REQUIRED', '余额不足'],
  ])('allows verified %s read-only connection while blocking payment', (code, message) => {
    const result = serviceReadiness({ ...config, readiness: { ...structural, ready: false, code } });
    expect(result.canConnect).toBe(true);
    expect(result.canPay).toBe(false);
    expect(result.message).toContain(message);
    expect(serviceReadiness({ ...config, readiness: { ready: false, code } }).canConnect).toBe(false);
  });

  it.each([
    ['CHAIN_UNAVAILABLE', '无法连接链上节点'], ['RPC_UNAVAILABLE', '无法连接链上节点'],
    ['DEPLOYMENT_MISSING', '部署配置'], ['OWNER_MISMATCH', '部署配置'],
    ['EXECUTOR_MISMATCH', '部署配置'], ['UNRECOGNIZED_FAILURE', '尚未确认链上就绪状态'],
  ])('keeps %s stopped and gives the relevant explanation', (code, message) => {
    const result = serviceReadiness({ ...config, readiness: { ...structural, ready: false, code } });
    expect(result.canConnect).toBe(false);
    expect(result.canPay).toBe(false);
    expect(result.message).toContain(message);
  });

  it('prioritizes wrong-network evidence over a stale-price label', () => {
    const result = serviceReadiness({ ...config, readiness: { ...structural, rpcChainId: 1, ready: false, code: 'FEED_STALE' } });
    expect(result.canConnect).toBe(false);
    expect(result.canPay).toBe(false);
    expect(result.message).toContain('网络与服务配置不一致');
  });

  it.each(['walletAddress', 'ownerAddress', 'recipientAddress', 'agentAddress'])('rejects an invalid or zero %s', key => {
    for (const address of ['invalid', '0x0000000000000000000000000000000000000000']) {
      const result = serviceReadiness({ ...config, [key]: address, readiness: { ...structural, ready: true } });
      expect(result.canConnect).toBe(false);
      expect(result.canPay).toBe(false);
      expect(result.message).toContain('配置不完整');
    }
  });

  it.each([null, {}, { ...config, chainId: 0 }, { ...config, chainId: 1.1 }])('rejects incomplete or invalid configuration %#', value => {
    const result = serviceReadiness(value);
    expect(result.canConnect).toBe(false);
    expect(result.canPay).toBe(false);
  });
});
