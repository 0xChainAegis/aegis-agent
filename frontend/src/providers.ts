import { z } from 'zod';
import type { WalletProvider } from './wallet';

export interface WalletOption { id: string; name: string; rdns: string; icon?: string; provider: WalletProvider }
export interface DiscoveryHost extends EventTarget { ethereum?: unknown }

const providerSchema = z.custom<WalletProvider>((value: unknown) => {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try {
    return typeof Reflect.get(value, 'request') === 'function'
      && ['on', 'removeListener'].every(key => Reflect.get(value, key) === undefined || typeof Reflect.get(value, key) === 'function');
  } catch { return false; }
});
const announcementSchema = z.object({
  info: z.object({
    uuid: z.string().uuid(), name: z.string().trim().min(1).max(80),
    rdns: z.string().min(3).max(255).regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i),
    icon: z.string().max(131072),
  }), provider: providerSchema,
});
const legacySchema = z.object({
  providers: z.array(z.unknown()).max(30).optional(),
  isMetaMask: z.boolean().optional(), isTrust: z.boolean().optional(), isTrustWallet: z.boolean().optional(),
  isRabby: z.boolean().optional(), isOkxWallet: z.boolean().optional(), isOKExWallet: z.boolean().optional(),
  isCoinbaseWallet: z.boolean().optional(), isBitKeep: z.boolean().optional(), isRainbow: z.boolean().optional(), isZerion: z.boolean().optional(),
}).passthrough();
const selectionSchema = z.string().min(1).max(100);
const iconSchema = z.string().max(131072).regex(/^data:image\/(?:png|jpeg|webp|gif|svg\+xml)(?:;[^,]*)?,/i);

/** EIP-6963 announcements are discovery metadata, never proof of identity or authority. */
export function createWalletDiscovery(host: DiscoveryHost) {
  const announced = new Map<string, WalletOption>();
  const legacyIds = new WeakMap<WalletProvider, string>();
  let nextLegacyId = 0;
  const subscribers = new Set<() => void>();
  let started = false;
  function announce(event: Event) {
    if (!(event instanceof CustomEvent)) return;
    const parsed = announcementSchema.safeParse(event.detail);
    if (!parsed.success) return;
    const { info, provider } = parsed.data;
    if (announced.has(info.uuid) || [...announced.values()].some(option => option.provider === provider)) return;
    const icon = iconSchema.safeParse(info.icon);
    announced.set(info.uuid, { id: info.uuid, name: info.name, rdns: info.rdns, ...(icon.success ? {icon:icon.data} : {}), provider });
    for (const listener of subscribers) listener();
  }
  function legacy(): WalletOption[] {
    let injected: unknown;
    try { injected = host.ethereum; } catch { return []; }
    const parsed = legacySchema.safeParse(injected);
    const candidates = [...(parsed.success && parsed.data.providers?.length ? parsed.data.providers : [injected])];
    const namespaceNames = new Map<unknown,string>();
    for (const [key,name] of [['okxwallet','OKX Wallet'],['coinbaseWalletExtension','Coinbase Wallet'],['rabby','Rabby']]) {
      try { const candidate:unknown = Reflect.get(host,key); if (candidate) { candidates.push(candidate); namespaceNames.set(candidate,name); } } catch { /* An inaccessible extension is not a selectable wallet. */ }
    }
    const seen = new Set<WalletProvider>();
    return candidates.flatMap(candidate => {
      const provider = providerSchema.safeParse(candidate);
      if (!provider.success || seen.has(provider.data)) return [];
      seen.add(provider.data);
      const flags = legacySchema.safeParse(candidate);
      const trust = flags.success && (flags.data.isTrust === true || flags.data.isTrustWallet === true);
      const extraName = namespaceNames.get(candidate) || (flags.success ? flags.data.isRabby ? 'Rabby' : flags.data.isOkxWallet || flags.data.isOKExWallet ? 'OKX Wallet' : flags.data.isCoinbaseWallet ? 'Coinbase Wallet' : flags.data.isBitKeep ? 'Bitget Wallet' : flags.data.isRainbow ? 'Rainbow' : flags.data.isZerion ? 'Zerion' : '' : '');
      const metamask = flags.success && flags.data.isMetaMask === true && !trust && !extraName;
      let id = legacyIds.get(provider.data);
      if (!id) { id = 'legacy-' + nextLegacyId++; legacyIds.set(provider.data, id); }
      return [{ id, name: trust ? 'Trust Wallet' : extraName || (metamask ? 'MetaMask' : '浏览器钱包'), rdns: '', provider: provider.data }];
    });
  }
  function list(): WalletOption[] {
    const explicit = [...announced.values()];
    const options = [...explicit, ...legacy().filter(option => !explicit.some(item => item.provider === option.provider) && (!explicit.length || option.name !== '浏览器钱包'))];
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    start() { if (!started) { host.addEventListener('eip6963:announceProvider', announce); started = true; } host.dispatchEvent(new Event('eip6963:requestProvider')); },
    refresh() { host.dispatchEvent(new Event('eip6963:requestProvider')); for (const listener of subscribers) listener(); },
    list,
    select(input: unknown): WalletOption | undefined { const parsed = selectionSchema.safeParse(input); return parsed.success ? list().find(option => option.id === parsed.data) : undefined; },
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    dispose() { host.removeEventListener('eip6963:announceProvider', announce); subscribers.clear(); announced.clear(); started = false; },
  };
}

declare global { interface Window { ethereum?: unknown } }
