import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, hasSession, setToken } from './api';
import { authenticateOwner, connectBrowserWallet, connectWallet, disconnectProvider, getActiveProvider, localWalletAvailable, sendOwnerTransaction, type WalletProvider } from './wallet';

vi.mock('./api', () => ({ api: vi.fn(), hasSession: vi.fn(), setToken: vi.fn() }));

const owner = '0x1111111111111111111111111111111111111111';
const viewer = '0x2222222222222222222222222222222222222222';
const treasury = '0x3333333333333333333333333333333333333333';
const hash = '0x' + 'ab'.repeat(32);
const signature = '0x' + 'cd'.repeat(65);
const config = { mode: 'local_chain', chainId: 31337, ownerAddress: owner, walletAddress: treasury, rpcUrl: 'http://127.0.0.1:8545' };
const tx = { from: owner, to: treasury, chainId: 31337, data: '0x1234', value: '0' };
type Request = Parameters<WalletProvider['request']>[0];
interface FakeWallet extends WalletProvider {
  account: string; chain: string; calls: Request[];
  respond?: (request: Request) => unknown;
  emit(event: string, value: unknown): void;
}
function wallet(account = owner): FakeWallet {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    account, chain: '0x7a69', calls: [],
    on(event, callback) { const group = listeners.get(event) ?? new Set(); group.add(callback); listeners.set(event, group); },
    removeListener(event, callback) { listeners.get(event)?.delete(callback); },
    emit(event, value) { for (const callback of listeners.get(event) ?? []) callback(value); },
    async request(request) {
      this.calls.push(request);
      const custom = this.respond?.(request);
      if (custom !== undefined) return await custom;
      if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [this.account];
      if (request.method === 'eth_chainId') return this.chain;
      if (request.method === 'personal_sign') return signature;
      if (request.method === 'eth_sendTransaction') return hash;
      if (request.method === 'wallet_switchEthereumChain') {
        const parsed = z.tuple([z.object({ chainId: z.string() })]).parse(request.params);
        this.chain = parsed[0].chainId;
        this.emit('chainChanged', this.chain);
        return null;
      }
      if (request.method === 'wallet_addEthereumChain') return null;
      throw new Error('Unexpected fake wallet request ' + request.method);
    },
  };
}
function challenge(overrides: Record<string, unknown> = {}) {
  return { challengeId: 'cf7d497f-3a06-481b-9735-e5127a3873cb', address: owner, chainId: 31337, message: 'Aegis test login', expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides };
}
function session(overrides: Record<string, unknown> = {}) {
  return { token: 'unit-test-session', address: owner, chainId: 31337, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides };
}
async function login(selected: FakeWallet) {
  const connection = await connectBrowserWallet(31337, config, selected);
  vi.mocked(api).mockResolvedValueOnce(challenge()).mockResolvedValueOnce(session());
  await authenticateOwner(connection, config);
  return connection;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasSession).mockReturnValue(true);
  vi.unstubAllGlobals();
  vi.stubGlobal('location', { hostname: '127.0.0.1' });
  vi.stubGlobal('window', {});
  disconnectProvider();
});

describe('explicit provider connection', () => {
  it('keeps a non-owner connected read-only without any auth API or signature', async () => {
    const selected = wallet(viewer);
    const connection = await connectBrowserWallet(31337, config, selected);
    expect(connection).toEqual({ address: viewer, chainId: 31337, role: 'viewer' });
    expect(getActiveProvider()).toBe(selected);
    expect(api).not.toHaveBeenCalled();
    expect(selected.calls.some(call => call.method === 'personal_sign')).toBe(false);
    await expect(authenticateOwner(connection, config)).rejects.toThrow('只读');
    expect(api).not.toHaveBeenCalled();
  });

  it.each([[], ['not-an-address'], { accounts: [owner] }])('rejects malformed or empty account output %#', async accounts => {
    const selected = wallet();
    selected.respond = request => request.method === 'eth_requestAccounts' ? accounts : undefined;
    await expect(connectBrowserWallet(31337, config, selected)).rejects.toThrow('有效账户');
    expect(getActiveProvider()).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });

  it.each(['31337', '0x0', '0xnothex', 31337])('rejects invalid provider chain output %s', async chain => {
    const selected = wallet();
    selected.respond = request => request.method === 'eth_chainId' ? chain : undefined;
    await expect(connectBrowserWallet(31337, config, selected)).rejects.toThrow('有效网络');
    expect(api).not.toHaveBeenCalled();
  });

  it('uses accounts reread after switching and refuses a provider that stayed on the wrong chain', async () => {
    const selected = wallet(viewer);
    selected.chain = '0xaa36a7';
    selected.respond = request => {
      if (request.method === 'wallet_switchEthereumChain') {
        selected.account = owner; selected.chain = '0x7a69';
        return null;
      }
      return undefined;
    };
    expect(await connectBrowserWallet(31337, config, selected)).toEqual({ address: owner, chainId: 31337, role: 'owner' });
    const stuck = wallet();
    stuck.chain = '0xaa36a7';
    stuck.respond = request => request.method === 'wallet_switchEthereumChain' ? null : undefined;
    await expect(connectBrowserWallet(31337, config, stuck)).rejects.toThrow('仍未切换');
    expect(api).not.toHaveBeenCalled();
  });

  it('catches an account event during the final connection chain read', async () => {
    const selected = wallet();
    let reads = 0;
    selected.respond = request => {
      if (request.method === 'eth_chainId' && ++reads === 2) {
        selected.account = viewer;
        selected.emit('accountsChanged', [viewer]);
        return '0x7a69';
      }
      return undefined;
    };
    await expect(connectBrowserWallet(31337, config, selected)).rejects.toThrow('账户或网络已变更');
    expect(getActiveProvider()).toBeUndefined();
  });

  it('clears previous authentication when selecting another provider', async () => {
    await login(wallet());
    vi.mocked(setToken).mockClear();
    const selected = wallet(viewer);
    await connectBrowserWallet(31337, config, selected);
    expect(setToken).toHaveBeenCalledWith('');
    await expect(sendOwnerTransaction(tx, owner)).rejects.toThrow('Owner 签名登录');
    expect(selected.calls.some(call => call.method === 'eth_sendTransaction')).toBe(false);
  });

  it('does not let an older pending connection replace a newer chosen provider', async () => {
    let complete: (value: unknown) => void = () => { throw new Error('Deferred request not initialized'); };
    const pending = new Promise<unknown>(resolve => { complete = resolve; });
    const old = wallet();
    old.respond = request => request.method === 'eth_requestAccounts' ? pending : undefined;
    const oldConnection = connectBrowserWallet(31337, config, old);
    const rejected = expect(oldConnection).rejects.toThrow('账户或网络已变更');
    const selected = wallet(viewer);
    await connectBrowserWallet(31337, config, selected);
    complete([owner]);
    await rejected;
    expect(getActiveProvider()).toBe(selected);
    expect(api).not.toHaveBeenCalled();
  });

  it('does not promote a viewer by replacing the supplied config owner', async () => {
    const selected = wallet(viewer);
    const connection = await connectBrowserWallet(31337, config, selected);
    await expect(authenticateOwner({ ...connection, role: 'owner' }, { ...config, ownerAddress: viewer })).rejects.toThrow('先连接所选钱包');
    expect(api).not.toHaveBeenCalled();
  });
});

describe('Owner login and transaction guards', () => {
  it('validates a complete challenge/session before authenticating', async () => {
    const selected = wallet();
    await login(selected);
    expect(api).toHaveBeenCalledTimes(2);
    expect(setToken).toHaveBeenLastCalledWith('unit-test-session');
  });

  it.each([{}, challenge({ chainId: 11155111 }), challenge({ address: viewer }), challenge({ expiresAt: '2000-01-01T00:00:00.000Z' })])('rejects invalid or unbound challenges before signing %#', async value => {
    const selected = wallet();
    const connection = await connectBrowserWallet(31337, config, selected);
    vi.mocked(api).mockResolvedValueOnce(value);
    await expect(authenticateOwner(connection, config)).rejects.toThrow(/挑战/);
    expect(selected.calls.some(call => call.method === 'personal_sign')).toBe(false);
    expect(setToken).not.toHaveBeenCalledWith('unit-test-session');
  });

  it('rejects a malformed session and account changes while a signature resolves', async () => {
    const selected = wallet();
    const connection = await connectBrowserWallet(31337, config, selected);
    vi.mocked(api).mockResolvedValueOnce(challenge()).mockResolvedValueOnce(session({ chainId: 11155111 }));
    await expect(authenticateOwner(connection, config)).rejects.toThrow('会话与当前账户或网络不一致');
    expect(setToken).not.toHaveBeenCalledWith('unit-test-session');
    vi.mocked(api).mockReset().mockResolvedValueOnce(challenge());
    selected.respond = request => {
      if (request.method === 'personal_sign') {
        selected.account = viewer; selected.emit('accountsChanged', [viewer]); return signature;
      }
      return undefined;
    };
    await expect(authenticateOwner(connection, config)).rejects.toThrow('账户或网络已变更');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('always sends through the authenticated selected provider and never window.ethereum', async () => {
    const selected = wallet();
    const other = wallet();
    vi.stubGlobal('window', { ethereum: other });
    await login(selected);
    expect(await sendOwnerTransaction(tx, owner)).toBe(hash);
    expect(selected.calls.filter(call => call.method === 'eth_sendTransaction')).toHaveLength(1);
    expect(other.calls).toEqual([]);
    disconnectProvider();
    await expect(sendOwnerTransaction(tx, owner)).rejects.toThrow('连接所选 Owner');
    expect(other.calls).toEqual([]);
  });

  it('blocks unauthenticated, wrong-chain, wrong-target, and funded Owner transactions', async () => {
    const selected = wallet();
    await connectBrowserWallet(31337, config, selected);
    await expect(sendOwnerTransaction(tx, owner)).rejects.toThrow('Owner 签名登录');
    await login(selected);
    await expect(sendOwnerTransaction({ ...tx, to: viewer }, owner)).rejects.toThrow();
    await expect(sendOwnerTransaction({ ...tx, value: '1' }, owner)).rejects.toThrow('已停止签名');
    selected.chain = '0xaa36a7';
    await expect(sendOwnerTransaction(tx, owner)).rejects.toThrow('已停止签名');
    expect(selected.calls.some(call => call.method === 'eth_sendTransaction')).toBe(false);
  });

  it('rejects an invalid wallet transaction hash instead of claiming broadcast success', async () => {
    const selected = wallet();
    await login(selected);
    selected.respond = request => request.method === 'eth_sendTransaction' ? 'invalid-hash' : undefined;
    await expect(sendOwnerTransaction(tx, owner)).rejects.toThrow('有效交易哈希');
  });

  it('does not send after the HTTP Owner session has been cleared', async () => {
    const selected = wallet();
    await login(selected);
    vi.mocked(hasSession).mockReturnValue(false);
    await expect(sendOwnerTransaction(tx, owner)).rejects.toThrow('Owner 签名登录');
    expect(selected.calls.some(call => call.method === 'eth_sendTransaction')).toBe(false);
  });

  it('blocks an account race during the final transaction chain read', async () => {
    const selected = wallet();
    await login(selected);
    selected.respond = request => {
      if (request.method === 'eth_chainId') {
        selected.account = viewer;
        selected.emit('accountsChanged', [viewer]);
        return '0x7a69';
      }
      return undefined;
    };
    await expect(sendOwnerTransaction(tx, owner)).rejects.toThrow('账户已变更');
    expect(selected.calls.some(call => call.method === 'eth_sendTransaction')).toBe(false);
  });
});

describe('explicit Local RPC input', () => {
  it('hides and rejects the unlocked development helper for a personal Owner deployment', async () => {
    const custom = {...config, localTestWalletAvailable:false};
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch',fetchSpy);
    expect(localWalletAvailable(custom)).toBe(false);
    await expect(connectWallet(31337,custom)).rejects.toThrow('个人 Owner');
    expect(fetchSpy).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
  });

  it('still adds and switches the verified Local network when the public helper is disabled', async () => {
    const custom = { ...config, localTestWalletAvailable: false };
    const selected = wallet();
    selected.chain = '0xaa36a7';
    let switches = 0;
    selected.respond = request => {
      if (request.method === 'wallet_switchEthereumChain' && switches++ === 0) throw { code: 4902 };
      return undefined;
    };
    expect(localWalletAvailable(custom)).toBe(false);
    expect(await connectBrowserWallet(31337, custom, selected)).toEqual({ address: owner, chainId: 31337, role: 'owner' });
    expect(selected.calls.find(call => call.method === 'wallet_addEthereumChain')?.params).toEqual([{
      chainId: '0x7a69', chainName: 'Aegis Local (31337)',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['http://127.0.0.1:8545/'],
    }]);
    expect(selected.calls.filter(call => call.method === 'wallet_switchEthereumChain')).toHaveLength(2);
    expect(api).not.toHaveBeenCalled();
    expect(selected.calls.some(call => call.method === 'personal_sign')).toBe(false);
  });

  it('retains explicit Local Owner login using validated JSON-RPC replies', async () => {
    const requestSchema = z.object({ id: z.string(), method: z.string() });
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = requestSchema.parse(JSON.parse(String(init?.body)));
      methods.push(request.method);
      const result = request.method === 'eth_chainId' ? '0x7a69' : request.method === 'eth_accounts' ? [owner] : signature;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
    }));
    vi.mocked(api).mockResolvedValueOnce(challenge()).mockResolvedValueOnce(session());
    expect(await connectWallet(31337, config)).toEqual({ address: owner, chainId: 31337, role: 'owner' });
    expect(methods).toContain('personal_sign');
    expect(methods).not.toContain('eth_sendTransaction');
    expect(setToken).toHaveBeenLastCalledWith('unit-test-session');
  });

  it.each(['https://rpc.example.invalid', 'http://127.0.0.1:8545/?key=placeholder', 'http://user:password@127.0.0.1:8545'])('does not allow Local wallet URL %s', rpcUrl => {
    expect(localWalletAvailable({ ...config, rpcUrl })).toBe(false);
  });

  it('rejects malformed JSON-RPC envelopes and mismatched response ids without authenticating', async () => {
    const requestSchema = z.object({ id: z.string() });
    for (const mode of ['malformed', 'wrong-id']) {
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
        const request = requestSchema.parse(JSON.parse(String(init?.body)));
        const json = mode === 'malformed' ? { result: '0x7a69' } : { jsonrpc: '2.0', id: request.id + '-wrong', result: '0x7a69' };
        return new Response(JSON.stringify(json), { status: 200 });
      }));
      await expect(connectWallet(31337, config)).rejects.toThrow(/JSON-RPC|不匹配/);
    }
    expect(api).not.toHaveBeenCalled();
  });
});
