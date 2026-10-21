import { isAddress, stringToHex, zeroAddress } from 'viem';
import { z } from 'zod';
import { api, hasSession, setToken } from './api';

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, callback: (...args: unknown[]) => void) => void;
}
export interface WalletConnection { address: string; chainId: number; role: 'viewer' | 'owner' }

const addressSchema = z.string().refine(value => isAddress(value) && value.toLowerCase() !== zeroAddress, 'Invalid wallet address');
const accountsSchema = z.array(addressSchema).min(1);
const chainIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const chainHexSchema = z.string().refine(value => {
  if (!/^0x[0-9a-f]+$/i.test(value)) return false;
  const chain = BigInt(value);
  return chain > 0n && chain <= BigInt(Number.MAX_SAFE_INTEGER);
}).transform(value => Number(BigInt(value)));
const hexSchema = z.string().regex(/^0x(?:[0-9a-f]{2})*$/i);
const signatureSchema = z.string().regex(/^0x[0-9a-f]{130}$/i);
const transactionHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/i);
const valueSchema = z.string().refine(value => {
  if (!/^(?:0|[1-9]\d*|0x[0-9a-f]+)$/i.test(value)) return false;
  return BigInt(value) < 2n ** 256n;
});
const configSchema = z.object({
  mode: z.enum(['local_chain', 'testnet', 'mock']), chainId: chainIdSchema,
  ownerAddress: addressSchema, walletAddress: addressSchema,
  rpcUrl: z.string().url().nullable().optional(),
  localTestWalletAvailable: z.boolean().optional(),
}).superRefine((config, context) => {
  if ((config.mode === 'local_chain' && config.chainId !== 31337) || (config.mode === 'testnet' && config.chainId !== 11155111)) {
    context.addIssue({ code: 'custom', message: 'Configured mode and chain do not match' });
  }
});
type WalletConfig = z.infer<typeof configSchema>;
const connectionSchema = z.object({ address: addressSchema, chainId: chainIdSchema, role: z.enum(['viewer', 'owner']) });
const challengeSchema = z.object({
  challengeId: z.string().uuid(), address: addressSchema, chainId: chainIdSchema,
  message: z.string().min(1).max(10_000), expiresAt: z.string().datetime(),
});
const sessionSchema = z.object({
  token: z.string().min(1).max(4096), address: addressSchema, chainId: chainIdSchema, expiresAt: z.string().datetime(),
});
const transactionSchema = z.object({
  from: addressSchema, to: addressSchema, chainId: chainIdSchema, data: hexSchema, value: valueSchema.default('0'),
});
const rpcEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
}).superRefine((body, context) => {
  if (('result' in body) === (body.error !== undefined)) context.addIssue({ code: 'custom', message: 'Invalid JSON-RPC result/error envelope' });
});
const requestArgsSchema = z.object({ method: z.string().min(1), params: z.array(z.unknown()).optional() });
const localTransactionSchema = z.object({ from: addressSchema, to: addressSchema, data: hexSchema, value: valueSchema.default('0') });
const providerErrorSchema = z.object({ code: z.number().int(), message: z.string().optional() });

function read<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(message);
  return result.data;
}
function validProvider(input: unknown): input is WalletProvider {
  if (!input || typeof input !== 'object' || !('request' in input) || typeof input.request !== 'function') return false;
  if ('on' in input && input.on !== undefined && typeof input.on !== 'function') return false;
  return !('removeListener' in input) || input.removeListener === undefined || typeof input.removeListener === 'function';
}
function providerErrorCode(input: unknown): number | undefined {
  const result = providerErrorSchema.safeParse(input);
  return result.success ? result.data.code : undefined;
}
function isLoopback(host: string) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase()); }
function localRpc(config: WalletConfig): URL | null {
  if (config.mode !== 'local_chain' || config.chainId !== 31337 || !isLoopback(location.hostname) || !config.rpcUrl) return null;
  try {
    const url = new URL(config.rpcUrl);
    return ['http:', 'https:'].includes(url.protocol) && isLoopback(url.hostname) && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}
export function localWalletAvailable(input: unknown): boolean {
  const result = configSchema.safeParse(input);
  return result.success && result.data.localTestWalletAvailable !== false && localRpc(result.data) !== null;
}

let provider: WalletProvider | undefined;
let activeConnection: WalletConnection | undefined;
let activeWallet = '';
let activeOwner = '';
let authenticated = false;
let connectionRevision = 0;
export function getActiveProvider() { return provider; }
export function disconnectProvider() { provider = undefined; activeConnection = undefined; activeWallet = ''; activeOwner = ''; authenticated = false; connectionRevision++; }

function localProvider(config: WalletConfig): WalletProvider {
  const url = localRpc(config);
  if (!url || config.localTestWalletAvailable === false) throw new Error('当前资金池使用个人 Owner，请选择对应的浏览器钱包连接。本地测试钱包仅用于公开开发账户。');
  const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    const id = crypto.randomUUID();
    const response = await fetch(url.href, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const raw: unknown = await response.json();
    const body = read(rpcEnvelopeSchema, raw, '本地节点返回了无效 JSON-RPC 结果，已停止操作。');
    if (body.id !== id && !(body.error && body.id === null)) throw new Error('本地节点响应与当前请求不匹配，已停止操作。');
    if (!response.ok || body.error) throw new Error(body.error?.message || '无法连接本地开发链。');
    return body.result;
  };
  return {
    async request(input) {
      const { method, params = [] } = read(requestArgsSchema, input, '本地钱包请求格式无效。');
      if (!localRpc(config)) throw new Error('本地钱包环境已变化，已停止操作。');
      const actualChain = read(chainHexSchema, await rpc('eth_chainId'), '本地节点没有返回有效网络。');
      if (actualChain !== 31337) throw new Error('RPC 已不在 31337 本地链，已停止签名与发送。');
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        const accounts = read(accountsSchema, await rpc('eth_accounts'), '本地节点未返回有效账户。');
        if (!accounts.some(address => address.toLowerCase() === config.ownerAddress.toLowerCase())) throw new Error('本地节点未解锁配置的开发 Owner 账户。');
        return [config.ownerAddress];
      }
      if (method === 'personal_sign') {
        const [message, address] = read(z.tuple([hexSchema, addressSchema]), params, '登录签名参数无效。');
        if (address.toLowerCase() !== config.ownerAddress.toLowerCase()) throw new Error('本地测试钱包只能签名配置的公开开发账户。');
        return read(signatureSchema, await rpc(method, [message, address]), '本地节点返回了无效签名。');
      }
      if (method === 'eth_sendTransaction') {
        const [tx] = read(z.tuple([localTransactionSchema]), params, '本地 Owner 交易格式无效。');
        if (tx.from.toLowerCase() !== config.ownerAddress.toLowerCase() || tx.to.toLowerCase() !== config.walletAddress.toLowerCase() || BigInt(tx.value) !== 0n) throw new Error('本地 Owner 入口只允许向当前钱包合约发送无附带金额的审批或取消交易。');
        return read(transactionHashSchema, await rpc(method, [tx]), '本地节点未返回有效交易哈希。');
      }
      throw new Error('本地测试钱包不支持 ' + method + '。');
    },
  };
}
function networkName(chainId: number) { return chainId === 31337 ? 'Local 本地开发链（31337）' : chainId === 11155111 ? 'Sepolia（11155111）' : '链 ' + chainId; }
function networkHelp(current: number, required: number, reason: string) {
  const next = required === 31337 ? '请在钱包中批准切换，或使用页面的“本地测试钱包”。若要使用 Sepolia，需先将后端配置为 Sepolia。' : '请在钱包中配置并切换到 Sepolia；后端也必须配置为 Sepolia 后才能使用该网络。';
  return new Error(reason + '连接时钱包位于 ' + networkName(current) + '，页面需要 ' + networkName(required) + '。' + next);
}
async function switchBrowserNetwork(selectedProvider: WalletProvider, current: number, config: WalletConfig): Promise<number> {
  const required = config.chainId;
  if (![31337, 11155111].includes(required)) throw networkHelp(current, required, '当前页面不支持自动切换此网络。');
  const chainId = '0x' + required.toString(16);
  try {
    try { await selectedProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
    catch (error) {
      const rpc = localRpc(config);
      if (providerErrorCode(error) !== 4902 || required !== 31337 || !rpc) throw error;
      await selectedProvider.request({ method: 'wallet_addEthereumChain', params: [{
        chainId, chainName: 'Aegis Local (31337)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [rpc.href],
      }] });
      await selectedProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    }
  } catch (error) {
    throw networkHelp(current, required, providerErrorCode(error) === 4001 ? '你取消了钱包网络切换。' : '钱包未能完成网络切换。');
  }
  const actual = read(chainHexSchema, await selectedProvider.request({ method: 'eth_chainId' }), '钱包没有返回有效网络。');
  if (actual !== required) throw networkHelp(actual, required, '钱包仍未切换到页面需要的网络。');
  return actual;
}
async function connectSelected(expectedChainId: number, input: unknown, selected: unknown, allowSwitch: boolean): Promise<WalletConnection> {
  setToken('');
  disconnectProvider();
  const revision = connectionRevision;
  const config = read(configSchema, input, '服务没有提供有效的钱包配置。');
  const expected = read(chainIdSchema, expectedChainId, '页面网络配置无效。');
  if (config.chainId !== expected) throw new Error('页面网络与钱包配置不一致，已停止连接。');
  if (!validProvider(selected)) throw new Error('浏览器钱包接口尚未就绪。请启用钱包插件并刷新页面后重试。');
  let accounts = read(accountsSchema, await selected.request({ method: 'eth_requestAccounts' }), '钱包没有提供有效账户。');
  let chainId = read(chainHexSchema, await selected.request({ method: 'eth_chainId' }), '钱包没有返回有效网络。');
  if (chainId !== expected) {
    if (!allowSwitch) throw networkHelp(chainId, expected, '本地节点的网络不匹配。');
    chainId = await switchBrowserNetwork(selected, chainId, config);
    accounts = read(accountsSchema, await selected.request({ method: 'eth_accounts' }), '切换网络后钱包没有提供有效账户。');
  }
  const address = accounts[0];
  if (!address) throw new Error('钱包没有提供有效账户。');
  let changed = false;
  const accountsChanged = (value: unknown) => { const result = accountsSchema.safeParse(value); if (!result.success || result.data[0]?.toLowerCase() !== address.toLowerCase()) changed = true; };
  const chainChanged = (value: unknown) => { const result = chainHexSchema.safeParse(value); if (!result.success || result.data !== chainId) changed = true; };
  const disconnected = () => { changed = true; };
  try {
    selected.on?.('accountsChanged', accountsChanged);
    selected.on?.('chainChanged', chainChanged);
    selected.on?.('disconnect', disconnected);
    // Reread before publishing a connection: neither an event nor storage is proof.
    const checkAccounts = read(accountsSchema, await selected.request({ method: 'eth_accounts' }), '钱包没有提供有效账户。');
    const checkChain = read(chainHexSchema, await selected.request({ method: 'eth_chainId' }), '钱包没有返回有效网络。');
    if (changed || revision !== connectionRevision || checkAccounts[0]?.toLowerCase() !== address.toLowerCase() || checkChain !== chainId) throw new Error('钱包账户或网络已变更，请重新连接。');
    const connection: WalletConnection = { address, chainId, role: address.toLowerCase() === config.ownerAddress.toLowerCase() ? 'owner' : 'viewer' };
    provider = selected;
    activeConnection = connection;
    activeWallet = config.walletAddress.toLowerCase();
    activeOwner = config.ownerAddress.toLowerCase();
    return connection;
  } finally {
    selected.removeListener?.('accountsChanged', accountsChanged);
    selected.removeListener?.('chainChanged', chainChanged);
    selected.removeListener?.('disconnect', disconnected);
  }
}

/** Connect the user's explicit provider; never requests an API challenge or signature. */
export async function connectBrowserWallet(expectedChainId: number, publicConfig: unknown, selectedProvider: WalletProvider): Promise<WalletConnection> {
  return connectSelected(expectedChainId, publicConfig, selectedProvider, true);
}
export async function authenticateOwner(input: WalletConnection, publicConfig: unknown): Promise<WalletConnection> {
  authenticated = false;
  setToken('');
  const connection = read(connectionSchema, input, '钱包连接状态无效，请重新连接。');
  const config = read(configSchema, publicConfig, '服务没有提供有效的钱包配置。');
  const selected = provider;
  const revision = connectionRevision;
  if (!selected || !activeConnection || activeWallet !== config.walletAddress.toLowerCase() || activeOwner !== config.ownerAddress.toLowerCase() || activeConnection.address.toLowerCase() !== connection.address.toLowerCase() || activeConnection.chainId !== connection.chainId) throw new Error('请先连接所选钱包，再以 Owner 签名登录。');
  if (connection.role !== 'owner' || connection.address.toLowerCase() !== config.ownerAddress.toLowerCase() || connection.chainId !== config.chainId) throw new Error('此资金池只允许 Owner ' + config.ownerAddress + ' 签名登录；当前账户为 ' + connection.address + '。当前连接保持只读。');
  let identityChanged = false;
  const accountChanged = (value: unknown) => {
    const parsed = accountsSchema.safeParse(value);
    if (!parsed.success || parsed.data[0]?.toLowerCase() !== connection.address.toLowerCase()) identityChanged = true;
  };
  const chainChanged = (value: unknown) => {
    const parsed = chainHexSchema.safeParse(value);
    if (!parsed.success || parsed.data !== connection.chainId) identityChanged = true;
  };
  const disconnected = () => { identityChanged = true; };
  const assertUnchanged = async () => {
    const accounts = read(accountsSchema, await selected.request({ method: 'eth_accounts' }), '钱包账户或网络已变更，请重新连接并签名登录。');
    const chainId = read(chainHexSchema, await selected.request({ method: 'eth_chainId' }), '钱包账户或网络已变更，请重新连接并签名登录。');
    if (identityChanged || revision !== connectionRevision || provider !== selected || activeWallet !== config.walletAddress.toLowerCase() || activeOwner !== config.ownerAddress.toLowerCase() || accounts[0]?.toLowerCase() !== connection.address.toLowerCase() || chainId !== connection.chainId) throw new Error('钱包账户或网络已变更，请重新连接并签名登录。');
  };
  try {
    selected.on?.('accountsChanged', accountChanged);
    selected.on?.('chainChanged', chainChanged);
    selected.on?.('disconnect', disconnected);
    await assertUnchanged();
    const challenge = read(challengeSchema, await api('/auth/challenge', 'POST', { address: connection.address, chainId: connection.chainId }), '登录服务返回了无效挑战，已停止签名。');
    if (challenge.address.toLowerCase() !== connection.address.toLowerCase() || challenge.chainId !== connection.chainId || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('登录挑战与当前账户或网络不一致，已停止签名。');
    await assertUnchanged();
    const signature = read(signatureSchema, await selected.request({ method: 'personal_sign', params: [stringToHex(challenge.message), connection.address] }), '钱包返回了无效登录签名。');
    await assertUnchanged();
    const session = read(sessionSchema, await api('/auth/verify', 'POST', { address: connection.address, challengeId: challenge.challengeId, signature }), '登录服务返回了无效会话。');
    await assertUnchanged();
    if (session.address.toLowerCase() !== connection.address.toLowerCase() || session.chainId !== connection.chainId || Date.parse(session.expiresAt) <= Date.now()) throw new Error('登录会话与当前账户或网络不一致。');
    setToken(session.token);
    authenticated = true;
    return connection;
  } catch (error) { setToken(''); throw error; }
  finally {
    selected.removeListener?.('accountsChanged', accountChanged);
    selected.removeListener?.('chainChanged', chainChanged);
    selected.removeListener?.('disconnect', disconnected);
  }
}

/** Legacy owner-login entry point; a Local provider is chosen only by argument two. */
export async function connectWallet(expectedChainId: number, localConfig?: unknown, publicConfig?: unknown): Promise<WalletConnection> {
  const input = localConfig ?? publicConfig;
  const config = read(configSchema, input, '服务没有提供有效的钱包配置。');
  let selected: unknown;
  if (localConfig !== undefined) selected = localProvider(config);
  else selected = Reflect.get(window, 'ethereum');
  if (!selected) throw new Error('未发现浏览器钱包。请安装或启用 MetaMask，或在本地环境选择本地测试钱包。');
  const connection = await connectSelected(expectedChainId, config, selected, localConfig === undefined);
  return authenticateOwner(connection, config);
}

export async function sendOwnerTransaction(input: unknown, currentAddress: string, localConfig?: unknown): Promise<string> {
  const tx = read(transactionSchema, input, 'Owner 交易参数无效，已停止签名。');
  const address = read(addressSchema, currentAddress, '当前钱包地址无效。');
  const local = localConfig === undefined ? null : read(configSchema, localConfig, '本地钱包配置无效。');
  const selected = local ? localProvider(local) : provider;
  const revision = connectionRevision;
  if (!selected) throw new Error('请先连接所选 Owner 钱包。');
  if (!authenticated || !hasSession() || !activeConnection || activeConnection.role !== 'owner' || activeConnection.address.toLowerCase() !== address.toLowerCase() || activeWallet !== tx.to.toLowerCase() || (local && activeWallet !== local.walletAddress.toLowerCase())) throw new Error('请先以当前资金池 Owner 签名登录，再发起审批交易。');
  let changed = false;
  const accountsChanged = (value: unknown) => { const result = accountsSchema.safeParse(value); if (!result.success || result.data[0]?.toLowerCase() !== address.toLowerCase()) changed = true; };
  const chainChanged = (value: unknown) => { const result = chainHexSchema.safeParse(value); if (!result.success || result.data !== tx.chainId) changed = true; };
  const disconnected = () => { changed = true; };
  try {
    selected.on?.('accountsChanged', accountsChanged);
    selected.on?.('chainChanged', chainChanged);
    selected.on?.('disconnect', disconnected);
    const accounts = read(accountsSchema, await selected.request({ method: 'eth_accounts' }), '钱包没有提供有效账户。');
    const chainId = read(chainHexSchema, await selected.request({ method: 'eth_chainId' }), '钱包没有返回有效网络。');
    if (changed || revision !== connectionRevision || !authenticated || !hasSession() || accounts[0]?.toLowerCase() !== address.toLowerCase() || tx.from.toLowerCase() !== address.toLowerCase()) throw new Error('钱包账户已变更或不是任务 Owner，已停止签名。');
    if (chainId !== tx.chainId || BigInt(tx.value) !== 0n || (local && tx.to.toLowerCase() !== local.walletAddress.toLowerCase()) || (!local && (provider !== selected || activeConnection?.role !== 'owner' || activeConnection.address.toLowerCase() !== address.toLowerCase() || activeWallet !== tx.to.toLowerCase()))) throw new Error('钱包网络或资金池与任务不同，已停止签名。');
    return read(transactionHashSchema, await selected.request({
      method: 'eth_sendTransaction', params: [{ from: address, to: tx.to, data: tx.data, value: '0x0' }],
    }), '钱包没有返回有效交易哈希，请核对原交易。');
  } finally {
    selected.removeListener?.('accountsChanged', accountsChanged);
    selected.removeListener?.('chainChanged', chainChanged);
    selected.removeListener?.('disconnect', disconnected);
  }
}
