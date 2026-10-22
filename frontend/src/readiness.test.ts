import { describe, expect, it } from 'vitest';
import { serviceReadiness } from './readiness';

const addresses = {
  walletAddress: '0x1111111111111111111111111111111111111111',
  ownerAddress: '0x2222222222222222222222222222222222222222',
  recipientAddress: '0x3333333333333333333333333333333333333333',
  agentAddress: '0x4444444444444444444444444444444444444444',
};
const structural = { rpcChainId: 31337, contractsDeployed: true, deploymentBindingsVerified: true };
const config = { mode: 'local_chain', chainId: 31337, ...addresses };

describe('service readiness permissions', () => {
  it('allows payment only for explicitly ready and structurally verified service', () => {
    expect(serviceReadiness({ ...config, readiness: { ...structural, ready: true } })).toMatchObject({ phase: 'ready', code: 'READY', title: '本地演示可用', canConnect: true, canPay: true });
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
    ['FEED_STALE', 'Chainlink 报价待更新'],
    ['FUNDING_REQUIRED', '测试 ETH 余额不足'],
  ])('allows verified %s read-only connection while blocking payment', (code, title) => {
    const result = serviceReadiness({ ...config, readiness: { ...structural, ready: false, code } });
    expect(result.canConnect).toBe(true);
    expect(result.canPay).toBe(false);
    expect(result.title).toBe(title);
    expect(result.message).toContain('付款已暂停');
    expect(serviceReadiness({ ...config, readiness: { ready: false, code } }).canConnect).toBe(false);
  });

  it.each([
    ['DEPLOYMENT_MISSING', '合约配置未就绪'], ['OWNER_MISMATCH', '合约配置未就绪'],
    ['EXECUTOR_MISMATCH', '合约配置未就绪'], ['UNRECOGNIZED_FAILURE', '链上状态未确认'],
  ])('keeps %s stopped and gives the relevant explanation', (code, title) => {
    const result = serviceReadiness({ ...config, readiness: { ...structural, ready: false, code } });
    expect(result.canConnect).toBe(false);
    expect(result.canPay).toBe(false);
    expect(result.title).toBe(title);
    expect(result.message).not.toBe('');
    expect(result.actionLabel).not.toBe('');
  });

  it.each(['READINESS_CHECKING', 'READINESS_TIMEOUT', 'CHAIN_UNAVAILABLE'])('keeps a verified wallet connected during transient %s while blocking payment', code => {
    const result = serviceReadiness({ ...config, readiness: { ...structural, ready: false, code } });
    expect(result.canConnect).toBe(true);
    expect(result.canPay).toBe(false);
    expect(result.phase).toBe('limited');
    expect(result.message).toContain('保留上次成功核对');
    expect(serviceReadiness({ ...config, readiness: { ready: false, code } }).canConnect).toBe(false);
  });

  it('prioritizes wrong-network evidence over a stale-price label', () => {
    const result = serviceReadiness({ ...config, readiness: { ...structural, rpcChainId: 1, ready: false, code: 'FEED_STALE' } });
    expect(result.canConnect).toBe(false);
    expect(result.canPay).toBe(false);
    expect(result.code).toBe('CHAIN_MISMATCH');
    expect(result.title).toBe('网络配置不一致');
  });

  it.each(['walletAddress', 'ownerAddress', 'recipientAddress', 'agentAddress'])('rejects an invalid or zero %s', key => {
    for (const address of ['invalid', '0x0000000000000000000000000000000000000000']) {
      const result = serviceReadiness({ ...config, [key]: address, readiness: { ...structural, ready: true } });
      expect(result.canConnect).toBe(false);
      expect(result.canPay).toBe(false);
      expect(result.code).toBe('CONFIG_INVALID');
      expect(result.title).toContain('配置不完整');
    }
  });

  it.each([null, {}, { ...config, chainId: 0 }, { ...config, chainId: 1.1 }])('rejects incomplete or invalid configuration %#', value => {
    const result = serviceReadiness(value);
    expect(result.canConnect).toBe(false);
    expect(result.canPay).toBe(false);
  });
});
