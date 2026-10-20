import { isAddress, stringToHex } from 'viem';
import { api, setToken, type Data } from './api';

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, callback: (...args: unknown[]) => void) => void;
}

declare global { interface Window { ethereum?: WalletProvider } }

let provider: WalletProvider | undefined;

function isLoopback(host: string) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase()); }
export function localWalletAvailable(config: Data | null): boolean {
  if (!config || config.mode !== 'local_chain' || Number(config.chainId) !== 31337 || !isLoopback(location.hostname)) return false;
  try { const url = new URL(String(config.rpcUrl)); return ['http:', 'https:'].includes(url.protocol) && isLoopback(url.hostname) && !url.username && !url.password && isAddress(String(config.ownerAddress)); }
  catch { return false; }
}

function localProvider(config: Data): WalletProvider {
  if (!localWalletAvailable(config)) throw new Error('本地测试钱包只允许本机 31337 开发链，当前环境不符合条件。');
  const owner = String(config.ownerAddress);
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(String(config.rpcUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
    const body = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
    if (!response.ok || body.error) { const error = new Error(body.error?.message || '无法连接本地开发链。') as Error & { code?: number }; error.code = body.error?.code; throw error; }
    return body.result;
  };
  return {
    async request({ method, params = [] }) {
      if (!localWalletAvailable(config)) throw new Error('本地钱包环境已变化，已停止操作。');
      const actualChain = Number(await rpc('eth_chainId'));
      if (actualChain !== 31337) throw new Error('RPC 已不在 31337 本地链，已停止签名与发送。');
      const list = Array.isArray(params) ? params : [];
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        const accounts = await rpc('eth_accounts') as string[];
        if (!accounts.some(address => address.toLowerCase() === owner.toLowerCase())) throw new Error('本地节点未解锁配置的开发 Owner 账户。');
        return [owner];
      }
      if (method === 'personal_sign') {
        if (String(list[1]).toLowerCase() !== owner.toLowerCase()) throw new Error('本地测试钱包只能签名配置的公开开发账户。');
        return rpc('personal_sign', list);
      }
      if (method === 'eth_sendTransaction') {
        const tx = list[0] as Record<string, unknown>;
        if (String(tx?.from).toLowerCase() !== owner.toLowerCase() || String(tx?.to).toLowerCase() !== String(config.walletAddress).toLowerCase() || BigInt(String(tx?.value || '0')) !== 0n) throw new Error('本地 Owner 入口只允许向当前钱包合约发送无附带金额的审批或取消交易。');
        return rpc('eth_sendTransaction', list);
      }
      throw new Error(`本地测试钱包不支持 ${method}。`);
    },
  };
}

export function disconnectProvider() { provider = undefined; }

export async function connectWallet(expectedChainId: number, localConfig?: Data) {
  if (!localConfig && !window.ethereum) throw new Error('未发现浏览器钱包。请安装或启用 MetaMask，或在本地环境选择本地测试钱包。');
  const selectedProvider = localConfig ? localProvider(localConfig) : window.ethereum;
  if (!selectedProvider || typeof selectedProvider.request !== 'function') throw new Error('浏览器钱包接口尚未就绪。请启用钱包插件并刷新页面后重试。');
  const accounts = await selectedProvider.request({ method: 'eth_requestAccounts' }) as string[];
  if (!accounts?.[0] || !isAddress(accounts[0])) throw new Error('钱包没有提供有效账户。');
  const chainId = Number(await selectedProvider.request({ method: 'eth_chainId' }));
  if (expectedChainId && chainId !== expectedChainId) {
    throw new Error(`网络不匹配：请在钱包中切换到 ${expectedChainId === 31337 ? 'Local 本地开发链' : `链 ${expectedChainId}`} 后重新连接。`);
  }
  const address = accounts[0];
  let identityChanged = false;
  const accountsChanged = (value: unknown) => { if (!Array.isArray(value) || String(value[0]).toLowerCase() !== address.toLowerCase()) identityChanged = true; };
  const chainChanged = (value: unknown) => { if (Number(value) !== chainId) identityChanged = true; };
  const disconnected = () => { identityChanged = true; };
  // Track changes across async reads, including a change during the final chain check.
  const assertWalletUnchanged = async () => {
    const currentAccounts = await selectedProvider.request({ method: 'eth_accounts' }) as string[];
    const currentChainId = Number(await selectedProvider.request({ method: 'eth_chainId' }));
    if (identityChanged || currentAccounts?.[0]?.toLowerCase() !== address.toLowerCase() || currentChainId !== chainId) {
      throw new Error('钱包账户或网络已变更，请重新连接并签名登录。');
    }
  };
  try {
    selectedProvider.on?.('accountsChanged', accountsChanged);
    selectedProvider.on?.('chainChanged', chainChanged);
    selectedProvider.on?.('disconnect', disconnected);
    const challenge = await api('/auth/challenge', 'POST', { address, chainId });
    const signature = await selectedProvider.request({ method: 'personal_sign', params: [stringToHex(String(challenge.message)), address] });
    await assertWalletUnchanged();
    const session = await api('/auth/verify', 'POST', { address, challengeId: challenge.challengeId, signature });
    await assertWalletUnchanged();
    if (typeof session.token !== 'string' || !session.token) throw new Error('登录服务未返回有效会话，请重新连接。');
    provider = selectedProvider;
    setToken(session.token);
    return { address, chainId };
  } finally {
    selectedProvider.removeListener?.('accountsChanged', accountsChanged);
    selectedProvider.removeListener?.('chainChanged', chainChanged);
    selectedProvider.removeListener?.('disconnect', disconnected);
  }
}

export async function sendOwnerTransaction(tx: Record<string, unknown>, currentAddress: string, localConfig?: Data) {
  const currentProvider = localConfig ? localProvider(localConfig) : provider || window.ethereum;
  if (!currentProvider) throw new Error('请先连接 Owner 钱包。');
  const accounts = await currentProvider.request({ method: 'eth_accounts' }) as string[];
  const address = accounts?.[0];
  if (!address || address.toLowerCase() !== currentAddress.toLowerCase()) throw new Error('钱包账户已变更，请重新连接并签名登录。');
  if (tx.from && String(tx.from).toLowerCase() !== address.toLowerCase()) throw new Error('此操作仅限 Owner。请切换到页面所示的 Owner 地址并重新连接。');
  const chainId = Number(await currentProvider.request({ method: 'eth_chainId' }));
  if (chainId !== Number(tx.chainId)) throw new Error('钱包网络与任务网络不同，已停止签名。请切换网络后重试。');
  const value = String(tx.value || '0');
  return await currentProvider.request({
    method: 'eth_sendTransaction',
    params: [{ from: address, to: tx.to, data: tx.data, value: value.startsWith('0x') ? value : `0x${BigInt(value).toString(16)}` }],
  }) as string;
}
