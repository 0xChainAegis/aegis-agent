import { describe, expect, it, vi } from 'vitest';
import { createWalletDiscovery, type DiscoveryHost } from './providers';

const metaId = '11111111-1111-4111-8111-111111111111';
const trustId = '22222222-2222-4222-8222-222222222222';
const provider = () => ({ request: vi.fn(async () => []) });
function host(): DiscoveryHost { return new EventTarget(); }
function announce(target: DiscoveryHost, id: string, name: string, wallet: unknown, icon = 'data:image/png;base64,AA==') {
  target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: id, name, rdns: name === 'MetaMask' ? 'io.metamask' : 'com.trustwallet.app', icon }, provider: wallet } }));
}

describe('explicit wallet discovery', () => {
  it.each(['data:image/png;base64,AA==','data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'])('retains an inline wallet logo for safe image rendering: %s', icon => {
    const target=host(), discovery=createWalletDiscovery(target); discovery.start(); announce(target,metaId,'MetaMask',provider(),icon);
    expect(discovery.select(metaId)?.icon).toBe(icon);
  });
  it.each(['https://tracker.example/icon.svg','javascript:alert(1)','data:text/html,<script>alert(1)</script>',''])('keeps a wallet usable without an unsafe or missing icon: %s', icon => {
    const target=host(), discovery=createWalletDiscovery(target); discovery.start(); announce(target,metaId,'MetaMask',provider(),icon);
    expect(discovery.select(metaId)?.name).toBe('MetaMask'); expect(discovery.select(metaId)?.icon).toBeUndefined();
  });
  it.each([['isRabby','Rabby'],['isOkxWallet','OKX Wallet'],['isCoinbaseWallet','Coinbase Wallet'],['isBitKeep','Bitget Wallet'],['isRainbow','Rainbow'],['isZerion','Zerion']])('recognizes the explicit legacy %s provider', (flag,name) => {
    const target=host(), discovery=createWalletDiscovery(target); target.ethereum={...provider(),isMetaMask:true,[flag]:true}; discovery.start();
    expect(discovery.list().map(option=>option.name)).toEqual([name]);
  });
  it('discovers a named extension alongside the default injected wallet without calling it', () => {
    const target=host(), discovery=createWalletDiscovery(target), okx=provider(); Reflect.set(target,'okxwallet',okx); target.ethereum={...provider(),isTrust:true}; discovery.start();
    expect(discovery.list().map(option=>option.name)).toEqual(['OKX Wallet','Trust Wallet']); expect(okx.request).not.toHaveBeenCalled();
  });
  it('keeps MetaMask separate even when Trust Wallet owns window.ethereum', () => {
    const target = host(), meta = provider(), trust = provider(); target.ethereum = trust;
    target.addEventListener('eip6963:requestProvider', () => { announce(target, trustId, 'Trust Wallet', trust); announce(target, metaId, 'MetaMask', meta); });
    const discovery = createWalletDiscovery(target); discovery.start();
    expect(discovery.list().map(option => option.name)).toEqual(['MetaMask', 'Trust Wallet']);
    expect(discovery.select(metaId)?.provider).toBe(meta); expect(trust.request).not.toHaveBeenCalled(); expect(meta.request).not.toHaveBeenCalled();
  });
  it('supports late announcements and deduplicates repeated provider identities', () => {
    const target = host(), discovery = createWalletDiscovery(target), changed = vi.fn(), wallet = provider(); discovery.subscribe(changed); discovery.start();
    expect(discovery.list()).toEqual([]); announce(target, metaId, 'MetaMask', wallet); announce(target, metaId, 'MetaMask', wallet); announce(target, trustId, 'Other', wallet);
    expect(discovery.list()).toHaveLength(1); expect(changed).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { info: {} }, { info: { uuid: 'bad' }, provider: provider() }, { info: { uuid: metaId, name: '', rdns: 'io.metamask', icon: '' }, provider: provider() }])('ignores malformed announcement %j', detail => {
    const target = host(), discovery = createWalletDiscovery(target); discovery.start(); target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })); expect(discovery.list()).toEqual([]);
  });
  it('does not replace an existing UUID with another provider', () => {
    const target = host(), discovery = createWalletDiscovery(target), first = provider(); discovery.start(); announce(target, metaId, 'MetaMask', first); announce(target, metaId, 'Impersonator', provider()); expect(discovery.select(metaId)?.provider).toBe(first);
  });
  it('falls back to explicit legacy provider options without calling them', () => {
    const target = host(), discovery = createWalletDiscovery(target), meta = { ...provider(), isMetaMask: true }, trust = { ...provider(), isMetaMask: true, isTrust: true };
    target.ethereum = { providers: [trust, meta, meta, null] }; discovery.start();
    expect(discovery.list().map(option => option.name)).toEqual(['MetaMask', 'Trust Wallet']); expect(discovery.select('legacy-1')?.provider).toBe(meta); expect(discovery.select(null)).toBeUndefined();
  });
  it('rejects non-callable request and malformed optional methods', () => {
    const target = host(), discovery = createWalletDiscovery(target); target.ethereum = { request: 'bad' }; discovery.start(); expect(discovery.list()).toEqual([]); target.ethereum = { request: vi.fn(), on: 1 }; expect(discovery.list()).toEqual([]);
  });
  it('keeps a displayed legacy choice bound when the provider array is reordered', () => {
    const target = host(), discovery = createWalletDiscovery(target), meta = { ...provider(), isMetaMask: true }, trust = { ...provider(), isTrust: true };
    target.ethereum = {providers:[trust,meta]}; discovery.start(); const selected = discovery.list().find(option => option.name === 'MetaMask');
    target.ethereum = {providers:[meta,trust]}; expect(discovery.select(selected?.id)?.provider).toBe(meta);
  });
  it('includes a legacy-only MetaMask alongside an announced Trust Wallet', () => {
    const target = host(), discovery = createWalletDiscovery(target), meta = { ...provider(), isMetaMask: true }, trust = provider();
    target.ethereum = {providers:[trust,meta]}; discovery.start(); announce(target, trustId, 'Trust Wallet', trust);
    expect(discovery.list().map(option => option.name)).toEqual(['MetaMask','Trust Wallet']);
  });
  it('can clean up its own listeners without touching wallet listeners', () => {
    const target = host(), discovery = createWalletDiscovery(target); discovery.start(); discovery.dispose(); announce(target, metaId, 'MetaMask', provider()); expect(discovery.list()).toEqual([]);
  });
});
