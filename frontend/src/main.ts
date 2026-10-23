import { decodeFunctionData, formatEther, formatUnits, isAddress, parseAbi, parseEther } from 'viem';
import { z } from 'zod';
import { api, ApiError, hasSession, setToken, type Data } from './api';
import { authenticateOwner, connectBrowserWallet, connectWallet, disconnectProvider, getActiveProvider, localWalletAvailable, sendOwnerTransaction, type WalletConnection, type WalletProvider } from './wallet';
import { createWalletDiscovery } from './providers';
import { icon, mark } from './icons';
import { currentTheme, initTheme, toggleTheme } from './theme';
import { serviceReadiness } from './readiness';
import { singleFlightByRevision } from './single-flight';
import { nextRefreshDelay } from './polling';
import { bindingFromConfig, loadSettings, observationFromSnapshot, parseSettings, sameBinding, saveSettings, storageKey, suggestTopUp, suggestionKey, type ReserveBinding, type ReserveObservation, type Suggestion } from './reserve';
import './style.css';

type View = 'overview' | 'operations' | 'approvals' | 'verification' | 'settings';
type Column = 'draft' | 'ready' | 'approval' | 'done' | 'blocked';
initTheme();
const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) throw new Error('Aegis 页面容器缺失。');
const app = appElement;
const addressInput = z.string().refine(value => isAddress(value));
const storedKind = z.enum(['browser', 'local', '']);
function stored<T>(key: string, schema: z.ZodType<T>, fallback: T): T { try { const parsed = schema.safeParse(sessionStorage.getItem(key)); return parsed.success ? parsed.data : fallback; } catch { return fallback; } }
const discovery = createWalletDiscovery(window);
let walletSessionRevision = 0;
class SessionChangedError extends Error {}
async function sessionApi(path: string, method = 'GET', body?: Data): Promise<Data> {
  const revision = walletSessionRevision;
  try {
    const response = await api(path, method, body);
    if (revision !== walletSessionRevision) throw new SessionChangedError('钱包会话已变更。');
    return response;
  } catch (error) {
    if (revision !== walletSessionRevision) throw new SessionChangedError('钱包会话已变更。');
    throw error;
  }
}
const state = {
  view: 'overview' as View,
  settingsTab: 'account',
  config: null as Data | null,
  wallet: null as Data | null,
  tasks: [] as Data[],
  online: false,
  initialLoading: true,
  refreshing: false,
  serviceErrorCode: '',
  serviceErrorMessage: '',
  address: hasSession() ? stored('aegis.address', addressInput, '') : '',
  chainId: 0,
  busy: '',
  toast: '',
  toastError: false,
  query: '',
  filter: 'all',
  composerMode: 'natural',
  message: '',
  recipient: '',
  amount: '',
  purpose: '',
  draft: null as Data | null,
  quote: null as Data | null,
  previewError: '',
  drawer: '' as string,
  detail: null as Data | null,
  evidence: null as Data | null,
  evidenceLoading: false,
  evidenceError: '',
  ownerReview: null as { tx: Data; task: Data; action: 'approve' | 'cancel' } | null,
  localWalletConfirm: false,
  walletKind: stored('aegis.wallet-kind', storedKind, ''),
  connection: null as WalletConnection | null,
  walletPicker: false,
  providerName: '',
  walletError: '',
  reserve: {
    bindingKey: '', threshold: '', target: '', lastTaskId: '',
    notice: null as { text: string; key: string } | null,
    draft: null as ReserveDraft | null,
  },
};
interface ReserveDraft { draftId: string; recipient: string; topUpWei: string; balanceWei: string; thresholdWei: string; targetWei: string; blockNumber: string; observedAt: string }

const nav: [View, string, string, string][] = [
  ['overview', 'grid', '总览', 'Overview'],
  ['operations', 'layers', '操作', 'Operations'],
  ['approvals', 'approve', '待审批', 'Approvals'],
  ['verification', 'verify', '验证记录', 'Verification'],
  ['settings', 'settings', '设置', 'Settings'],
];
const columns: [Column, string, string][] = [
  ['draft', '待补信息', 'neutral'], ['ready', '准备执行', 'blue'], ['approval', '待审批', 'amber'], ['done', '已完成', 'green'], ['blocked', '未通过', 'red'],
];

function esc(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c); }
function object(value: unknown): Data { const parsed = z.record(z.string(), z.unknown()).safeParse(value); return parsed.success ? parsed.data : {}; }
function get(obj: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    let result: unknown = obj;
    for (const key of path.split('.')) result = object(result)[key];
    if (result !== undefined && result !== null) return result;
  }
  return undefined;
}
function value(obj: unknown, ...paths: string[]): string { const item = get(obj, ...paths); return item === undefined ? '' : String(item); }
function short(address: unknown, width = 6): string { const text = String(address || ''); return text.length > width * 2 + 3 ? `${text.slice(0, width)}…${text.slice(-4)}` : text || '—'; }
function eth(amount: unknown): string { try { return formatEther(BigInt(String(amount))).replace(/(\.\d{0,6}).*$/, '$1').replace(/\.$/, ''); } catch { return '—'; } }
function usd(amount: unknown): string { try { return `$${Number(formatUnits(BigInt(String(amount)), 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; } catch { return '—'; } }
function id(task: Data): string { return value(task, 'taskId', 'intentId', 'draftId', 'id'); }
function status(task: Data): string { return value(task, 'status', 'state').toUpperCase(); }
function column(task: Data): Column {
  const s = status(task);
  if (/PENDING_APPROVAL|AWAITING_APPROVAL|NEEDS_APPROVAL|OWNER_APPROVAL|QUEUED/.test(s)) return 'approval';
  if (/EXECUTED|COMPLETED|CONFIRMED|SUCCESS|SETTLED/.test(s)) return 'done';
  if (/BLOCKED|REJECTED|FAILED|CANCELLED|CANCELED|EXPIRED|REVERTED/.test(s)) return 'blocked';
  if (/READY|SUBMITTING|SUBMITTED|BROADCAST|EXECUTING|APPROVING|UNKNOWN/.test(s)) return 'ready';
  return 'draft';
}
function statusLabel(task: Data): string {
  const s = status(task);
  const labels: Record<string, string> = { DRAFT: '待确认', NEEDS_INPUT: '待补信息', INCOMPLETE: '待补信息', READY: '已通过预检', SUBMITTED: '链上处理中', SUBMITTING: '提交中', EXECUTING: '执行中', PENDING_APPROVAL: '等待 Owner', AWAITING_APPROVAL: '等待 Owner', EXECUTED: '链上已确认', COMPLETED: '已完成', CONFIRMED: '链上已确认', BLOCKED: '规则已拦截', REJECTED: '已拒绝', FAILED: '执行失败', CANCELLED: '已取消', CANCELED: '已取消', EXPIRED: '已过期' };
  return labels[s] || ({ UNKNOWN: '结果待核对', REQUOTE_REQUIRED: '需要重新报价', BROADCAST: '已广播待回执' } as Record<string, string>)[s] || s || '待确认';
}
const reasonLabels: Record<string, string> = { AUTO_THRESHOLD_EXCEEDED: '超过自动额度，需要 Owner 审批', HARD_PER_TX_EXCEEDED: '超过单次硬上限', PER_TX_LIMIT: '超过单次硬上限', DAILY_BUDGET_EXCEEDED: '超过今日累计预算', DAILY_LIMIT: '超过今日累计预算', RECIPIENT_NOT_ALLOWED: '收款地址不在允许名单中', WALLET_BALANCE_LOW: '钱包余额不足', INSUFFICIENT_BALANCE: '钱包余额不足', FEED_STALE: '价格已过期，付款已停止', POLICY_BLOCKED: '未通过合约规则', BROADCAST_UNKNOWN: '广播结果不明，正在核对原交易，请勿重复付款', TX_REVERTED: '交易已回滚，未完成付款', EXPECTED_EVENT_MISSING: '未找到匹配的付款事件' };
function reasons(task: unknown): string { const codes = get(task, 'reasonCodes'); return Array.isArray(codes) ? codes.map(code => reasonLabels[String(code)] || String(code)).join('；') : ''; }
function taskReason(task: unknown): string { return value(task, 'error.message', 'lastError.message', 'reason', 'blockReason', 'errorMessage') || reasons(task); }
function broadcastKey(taskId: string): string { return `aegis.owner-broadcast.${expectedChain()}.${taskId}`; }
function pendingBroadcast(taskId: string): { txHash: string; action: 'approve' | 'cancel' } | null { try { const parsed = z.object({txHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),action:z.enum(['approve','cancel'])}).strict().safeParse(JSON.parse(sessionStorage.getItem(broadcastKey(taskId)) || 'null')); return parsed.success ? parsed.data : null; } catch { return null; } }
function taskName(task: Data): string { return value(task, 'purpose', 'intent.purpose', 'description', 'message', 'title') || '原生 ETH 付款'; }
function taskRecipient(task: Data): string { return value(task, 'recipient', 'intent.recipient', 'request.recipient', 'to'); }
function taskAmount(task: Data): string { return value(task, 'amountWei', 'intent.amountWei', 'request.amountWei'); }
function walletAddress(): string { return value(state.config, 'walletAddress', 'addresses.wallet', 'contracts.wallet', 'wallet.address') || value(state.wallet, 'walletAddress', 'address'); }
function expectedChain(): number { return Number(get(state.config, 'chainId', 'chain.id') || 0); }
function currentServiceStatus() {
  return serviceReadiness(state.config, {
    online: state.online,
    apiErrorCode: state.serviceErrorCode,
    apiErrorMessage: state.serviceErrorMessage,
  });
}
function displayedServiceStatus() {
  return serviceReadiness(state.config, {
    online: state.online,
    initialLoading: state.initialLoading,
    refreshing: state.refreshing,
    apiErrorCode: state.serviceErrorCode,
    apiErrorMessage: state.serviceErrorMessage,
  });
}
function validConfig(): boolean { return currentServiceStatus().canPay; }
function canConnect(): boolean { return currentServiceStatus().canConnect; }
function readinessMessage(): string { return currentServiceStatus().message; }
function connected(): boolean { return Boolean(state.address && hasSession()); }
function walletLinked(): boolean { return connected() || Boolean(state.address && state.connection); }
function boundOwner(): boolean { return Boolean(connected() && state.connection?.role === 'owner' && getActiveProvider() && state.connection.address.toLowerCase() === value(state.config, 'ownerAddress').toLowerCase() && state.connection.chainId === expectedChain()); }
function disabled(): boolean { return !state.online || !validConfig() || !boundOwner() || state.refreshing || Boolean(state.busy); }
function mode(): string { return expectedChain() === 31337 ? 'Local' : value(state.config, 'mode') === 'mock' ? 'Mock' : expectedChain() === 11155111 ? 'Sepolia' : expectedChain() ? `Chain ${expectedChain()}` : '未连接'; }
function dateTime(item: unknown): string { if (!item) return '—'; const n = Number(item); const d = new Date(Number.isFinite(n) ? n < 1e12 ? n * 1000 : n : String(item)); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function explorer(hash: string): string { const base = value(state.config, 'explorerBaseUrl', 'explorerUrl', 'blockExplorerUrl', 'chain.blockExplorerUrl'); return /^https?:\/\//.test(base) && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${base.replace(/\/$/, '')}/tx/${hash}` : ''; }
function allTasks(): Data[] { const list = [...state.tasks]; const draft = state.draft; if (draft && !list.some(item => id(item) === id(draft))) list.unshift({ ...draft, ...(state.quote ? { status: state.quote.status } : {}), _draft: true }); return list; }
function notify(message: string, error = false) { state.toast = message; state.toastError = error; render(); window.setTimeout(() => { if (state.toast === message) { state.toast = ''; render(); } }, 7000); }
function errorMessage(error: unknown): string { return Number(get(error, 'code')) === 4001 ? '你取消了钱包请求，尚未提交交易。' : error instanceof Error ? error.message : '操作未完成，请重试。'; }

function render() {
  const active = document.activeElement;
  const focused = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  const focusId = active instanceof HTMLElement ? active.id : '';
  const selection = focused?.selectionStart;
  const reserveDetailsOpen = document.querySelector<HTMLDetailsElement>('.reserve-technical')?.open || false;
  const contentScroll = document.querySelector('.content')?.scrollTop || 0;
  const drawerScroll = document.querySelector('.drawer-body')?.scrollTop || 0;
  const pendingCount = state.tasks.filter(t => column(t) === 'approval').length;
  const activeNav = nav.find(item => item[0] === state.view) ?? nav[0];
  const themeNow = currentTheme();
  const availability = displayedServiceStatus();
  const statusText = availability.phase === 'ready'
    ? expectedChain() === 31337 ? '本地演示 · 可操作' : `${esc(mode())} · 可操作`
    : esc(availability.title);
  const connectDisabledReason = availability.canConnect ? '' : ` title="${esc(availability.title)}：${esc(availability.message)}" aria-describedby="service-status-title"`;
  app.innerHTML = `<div class="app-shell">
    <header class="topbar">
      <button class="brand" data-nav="overview" aria-label="Aegis 总览"><span class="brand-symbol">${mark()}</span><span class="brand-name">Aegis</span></button>
      <nav class="main-nav" aria-label="主导航">${nav.map(([key, symbol, label]) => `<button data-nav="${key}" class="nav-item ${state.view === key ? 'active' : ''}" aria-current="${state.view === key ? 'page' : 'false'}">${icon(symbol)}<span>${label}</span>${key === 'approvals' && pendingCount ? `<b class="nav-count">${pendingCount}</b>` : ''}</button>`).join('')}</nav>
      <div class="topbar-status" role="status" data-testid="service-status"><span class="status-dot ${availability.tone}"></span><span>${statusText}</span></div>
      <div class="topbar-actions">
        <button class="icon-button ${state.refreshing ? 'is-loading' : ''}" data-action="refresh" aria-label="${state.refreshing ? '正在刷新服务状态' : '刷新服务状态'}" title="${state.refreshing ? '正在刷新服务状态' : '刷新服务状态'}" ${state.refreshing ? 'disabled' : ''}>${state.refreshing ? '<span class="spinner"></span>' : icon('refresh')}</button>
        <button class="icon-button" id="theme-toggle" data-action="toggle-theme" data-testid="theme-toggle" aria-label="${themeNow === 'dark' ? '切换到浅色模式' : '切换到深色模式'}" title="${themeNow === 'dark' ? '切换到浅色模式' : '切换到深色模式'}">${icon(themeNow === 'dark' ? 'sun' : 'moon')}</button>
        ${localWalletAvailable(state.config) && !boundOwner() ? `<button class="button subtle local-wallet-button" data-action="local-wallet" data-testid="local-wallet" ${!state.online || !canConnect() || state.refreshing || state.busy ? 'disabled' : ''}${connectDisabledReason}>本地测试钱包</button>` : ''}<button data-action="connect" data-testid="connect-wallet" class="button ${walletLinked() ? 'connected-button' : 'primary'}" ${state.busy || state.refreshing || !state.online || !canConnect() ? 'disabled' : ''}${connectDisabledReason}>${icon('wallet')}<span>${state.busy === 'connect' ? '等待钱包确认…' : walletLinked() ? short(state.address) : '连接钱包'}</span></button>
      </div>
    </header>
    <main class="main">
      <div class="content ${state.view === 'settings' ? 'settings-content' : ''}">
        ${availability.phase !== 'ready' ? `<div class="service-banner ${availability.tone}" role="${availability.phase === 'loading' ? 'status' : 'alert'}" data-testid="service-banner" aria-live="polite">${availability.phase === 'loading' ? '<span class="spinner"></span>' : icon('info')}<div class="service-banner-copy"><strong id="service-status-title">${esc(availability.title)}</strong><p>${esc(availability.message)}</p></div>${availability.actionLabel ? `<button class="text-button" data-action="refresh" ${state.refreshing ? 'disabled' : ''}>${esc(availability.actionLabel)}</button>` : ''}</div>` : ''}
        ${connected() && !boundOwner() ? '<div class="info-panel" data-testid="reconnect-owner-note">已恢复登录会话和任务。付款或审批前，请重新选择钱包并以 Owner 签名登录；本地演示可重新选择“本地测试钱包”。</div>' : ''}
        ${state.view === 'settings' ? settingsView() : state.view === 'verification' ? verificationView() : operationsView()}
        ${connected() && ['overview', 'operations'].includes(state.view) ? composer() : ''}
      </div>
    </main>
    ${state.drawer ? drawer() : ''}
    ${state.ownerReview ? ownerModal() : ''}
    ${state.localWalletConfirm ? localWalletModal() : ''}
    ${state.walletPicker ? walletPickerModal() : ''}
    ${state.toast ? `<div class="toast ${state.toastError ? 'error' : 'success'}" role="${state.toastError ? 'alert' : 'status'}">${icon(state.toastError ? 'info' : 'check')}<span>${esc(state.toast)}</span><button class="icon-button" data-action="dismiss-toast" aria-label="关闭通知">${icon('close')}</button></div>` : ''}
  </div>`;
  const reserveDetails = document.querySelector<HTMLDetailsElement>('.reserve-technical'); if (reserveDetails) reserveDetails.open = reserveDetailsOpen;
  const content = document.querySelector('.content'); if (content) content.scrollTop = contentScroll;
  const drawerBody = document.querySelector('.drawer-body'); if (drawerBody) drawerBody.scrollTop = drawerScroll;
  if (focusId) { const next = document.getElementById(focusId); next?.focus({ preventScroll: true }); if (selection !== null && selection !== undefined && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && ['text', 'textarea', 'search'].includes(next.type)) { try { next.setSelectionRange(selection, selection); } catch { /* Non-text controls do not have a caret. */ } } }
}

function operationsView(): string {
  const isApproval = state.view === 'approvals';
  const isOverview = state.view === 'overview';
  const title = isApproval ? '需要你的批准' : isOverview ? '钱包总览' : '操作工作台';
  const description = isApproval ? '逐项核对收款地址与金额，使用 Owner 钱包签名。' : isOverview ? '' : '草稿需先预览，经你明确确认后才会提交。';
  const heading = `<section class="page-heading"><div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div><button class="button subtle" data-action="refresh">${icon('refresh')}刷新状态</button></section>`;
  if (!connected() && walletLinked()) return walletConnectionPanel();
  if (isOverview) return connected() ? reserveCard() + summary() + recentTasks() : intro();
  let list = allTasks();
  if (isApproval) list = list.filter(t => column(t) === 'approval');
  if (state.filter === 'active') list = list.filter(t => !['done', 'blocked'].includes(column(t)));
  if (state.filter === 'completed') list = list.filter(t => column(t) === 'done');
  if (state.query) list = list.filter(t => JSON.stringify(t).toLowerCase().includes(state.query.toLowerCase()));
  return `${heading}
    <section class="operations-section"><div class="section-toolbar"><div class="view-tabs" role="tablist" aria-label="操作筛选">${[['all', isApproval ? '待审批' : '全部操作'], ['active', '进行中'], ['completed', '已完成']].map(([key, label]) => `<button class="view-tab ${state.filter === key ? 'selected' : ''}" data-filter="${key}" role="tab" aria-selected="${state.filter === key}">${label}${key === 'all' ? `<span>${list.length}</span>` : ''}</button>`).join('')}</div><div class="toolbar-right"><label class="search-field">${icon('search')}<input id="task-search" type="search" aria-label="搜索操作" placeholder="搜索操作或地址" value="${esc(state.query)}" /></label></div></div>
    ${isApproval ? `<div class="approval-grid">${list.length ? list.map(t => taskCard(t)).join('') : emptyState('approve', '暂时没有待审批操作', '超过自动额度的请求会在这里等待 Owner。')}</div>` : `<div class="board" data-testid="operations-board">${columns.map(([key, label]) => { const tasks = list.filter(t => column(t) === key); return `<section class="board-column ${key}" aria-label="${label}"><div class="column-heading"><h2>${label}</h2><span class="column-count">${tasks.length}</span>${key === 'draft' ? `<button class="icon-button" data-action="new-operation" aria-label="新建操作">${icon('plus')}</button>` : ''}</div><div class="column-cards">${tasks.length ? tasks.map(t => taskCard(t)).join('') : `<div class="column-empty">${key === 'draft' ? '从下方开始一笔操作' : key === 'approval' ? '无需你处理' : '暂无操作'}</div>`}</div></section>`; }).join('')}</div>`}</section>`;
}

/** One reading per column, separated by rules. Treasury, executor gas and the operating-wallet reserve stay distinct. */
function summary(): string {
  const budget = object(get(state.wallet, 'budget', 'policy.budget'));
  const balance = get(state.wallet, 'walletBalanceWei', 'balanceWei', 'nativeBalanceWei', 'balance.wei');
  const executorGas = get(state.wallet, 'agentBalanceWei');
  const spent = get(budget, 'spentTodayUsd6', 'spentUsd6', 'usedUsd6', 'dailySpentUsd6') ?? get(state.wallet, 'spentUsd6');
  const limit = get(budget, 'dailyLimitUsd6', 'limitUsd6', 'dailyBudgetUsd6') ?? get(state.wallet, 'dailyLimitUsd6');
  const remaining = get(budget, 'remainingUsd6', 'remainingDailyUsd6');
  const oracle = object(get(state.wallet, 'oracle') || state.quote);
  const ratio = spent !== undefined && limit !== undefined && Number(limit) > 0 ? Math.min(100, Math.max(0, Number(spent) / Number(limit) * 100)) : 0;
  const readState = state.wallet ? '链上余额' : state.walletError ? '读取失败' : connected() ? '读取中' : '连接后读取';
  const feedStale = get(oracle, 'stale') === true || value(state.config, 'readiness.code') === 'FEED_STALE';
  const priceText = feedStale ? '已过期' : get(oracle, 'updatedAt', 'updatedAtSeconds') ? '已读取' : get(state.config, 'readiness.feedFresh') === true ? '预检可用' : '等待数据';
  const priceDot = feedStale ? 'red' : get(oracle, 'updatedAt', 'updatedAtSeconds') ? 'green' : 'neutral';
  const priceNote = expectedChain() === 31337 ? '本地 Mock Feed · 非公网行情' : get(oracle, 'updatedAt', 'updatedAtSeconds') ? `更新于 ${dateTime(get(oracle, 'updatedAt', 'updatedAtSeconds'))}` : '执行时重查 Chainlink Feed';
  return `<section class="summary-block" aria-label="资金概览"><h2 class="block-title">资金概览</h2><div class="summary">
    <div class="summary-item"><span class="summary-label">补给资金池余额</span><strong class="summary-value" data-testid="wallet-balance">${balance !== undefined ? eth(balance) : '—'}<small> ETH</small></strong><span class="summary-note"><span class="mono">${short(walletAddress(), 7)}</span><button class="icon-button small" data-copy="${esc(walletAddress())}" aria-label="复制资金池合约地址">${icon('copy')}</button>${readState}</span></div>
    <div class="summary-item"><span class="summary-label">执行账户 Gas 余额</span><strong class="summary-value">${executorGas !== undefined ? eth(executorGas) : '—'}<small> ETH</small></strong><span class="summary-note">用于支付补给请求的链上手续费</span></div>
    <div class="summary-item"><span class="summary-label">今日美元预算</span><strong class="summary-value">${spent !== undefined ? usd(spent) : '—'}<small> / ${limit !== undefined ? usd(limit) : '—'}</small></strong><div class="budget-track"><span style="width:${ratio}%"></span></div><span class="summary-note">${remaining !== undefined ? `剩余 ${usd(remaining)} · 链上约束` : '按执行时价格累计支出'}</span></div>
    <div class="summary-item"><span class="summary-label">待审批</span><strong class="summary-value">${state.wallet ? state.tasks.filter(t => column(t) === 'approval').length : '—'}<small> 笔</small></strong><span class="summary-note">批准不会绕过硬预算</span></div>
    <div class="summary-item"><span class="summary-label">价格状态</span><strong class="summary-value summary-text"><span class="status-dot ${priceDot}"></span>${priceText}</strong><span class="summary-note">${priceNote}</span></div>
  </div></section>`;
}

/** Real tasks only. Rows open the existing detail drawer; nothing here is derived or invented. */
function taskRow(t: Data): string {
  const c = column(t);
  const tag = t._draft ? '草稿' : `AEG-${id(t).slice(-6).toUpperCase()}`;
  return `<button class="task-row" data-open-task="${esc(id(t))}" data-task-id="${esc(id(t))}"><span class="cell time">${dateTime(get(t, 'updatedAt', 'createdAt'))}</span><span class="cell name"><span class="task-mark ${c}">${icon(c === 'done' ? 'check' : c === 'approval' ? 'clock' : c === 'blocked' ? 'info' : 'arrow')}</span><span class="name-text">${esc(taskName(t))}</span></span><span class="cell amount">${taskAmount(t) ? eth(taskAmount(t)) : '—'} <small>ETH</small></span><span class="cell state task-status ${c}"><span class="status-dot ${columns.find(col => col[0] === c)?.[2] ?? 'neutral'}"></span>${statusLabel(t)}</span><span class="cell ref mono">${tag}</span></button>`;
}
function recentTasks(): string {
  const stamp = (t: Data) => String(get(t, 'updatedAt', 'createdAt') ?? '');
  const list = [...allTasks()].sort((a, b) => stamp(b).localeCompare(stamp(a))).slice(0, 5);
  return `<section class="recent" aria-label="最近任务"><div class="section-head"><h2>最近任务</h2><button class="text-button" data-nav="operations">查看全部</button></div>${list.length ? `<div class="task-table"><div class="task-head" aria-hidden="true"><span>时间</span><span>任务</span><span>金额</span><span>状态</span><span>编号</span></div>${list.map(taskRow).join('')}</div>` : '<p class="recent-empty">还没有任务。准备一笔补给并确认后，会显示在这里。</p>'}</section>`;
}

/** Signed-out introduction: product facts only, no balances or activity. */
function intro(): string {
  const localOffered = localWalletAvailable(state.config) && !connected();
  const availability = displayedServiceStatus();
  const disabledReason = availability.canConnect ? '' : ` title="${esc(availability.title)}：${esc(availability.message)}" aria-describedby="service-status-title"`;
  return `<section class="intro" aria-label="Aegis 简介">
    <div class="intro-copy">
      <p class="intro-word">Aegis</p>
      <h1>为运行钱包，补足下一步。</h1>
      <p class="intro-lead">读取一个运行钱包的真实 ETH 余额；低于你设定的下限时，建议补到目标余额。预览不会付款，需要你明确确认后，才会在链上美元限额内执行。</p>
      <div class="intro-actions">${localOffered ? `<button class="button primary" data-action="local-wallet" ${!state.online || !canConnect() || state.refreshing || state.busy ? 'disabled' : ''}${disabledReason}>使用本地测试钱包</button>` : ''}<button class="button ${localOffered ? '' : 'primary'}" data-action="connect" ${state.busy === 'connect' || !state.online || !canConnect() || state.refreshing ? 'disabled' : ''}${disabledReason}>${icon('wallet')}连接钱包</button></div>
      <p class="intro-note">登录只验证 Owner 身份，不会授权付款。${expectedChain() === 31337 ? '当前是本地链与 Mock Feed 演示，不涉及真实资金。' : ''}</p>
    </div>
    <div class="intro-art"><img class="intro-art-light" src="/aegis-hero.png" alt="Aegis 应用图标：白色陶瓷质感的 A 字标志" width="2022" height="778"><span class="intro-art-dark">${mark()}</span></div>
  </section>
  <section class="intro-facts" aria-label="工作方式">
    <div><h2>读取真实余额</h2><p>只读取这一个已配置运行钱包在最新区块的 ETH 余额；读取失败时显示不可用，不按 0 处理。</p></div>
    <div><h2>美元限额内执行</h2><p>合约用 ETH/USD 报价校验转出本金，并受单笔与每日限额约束。${expectedChain() === 31337 ? '本地使用 Mock Feed。' : ''}</p></div>
    <div><h2>明确确认</h2><p>草稿与预览不会付款；超过自动额度的请求需要 Owner 另行签名批准。</p></div>
  </section>`;
}

// ---- Gas reserve for the single configured operating wallet (browser-local recommendation) ----
type ReserveKind = 'locked' | 'loading' | 'unavailable' | 'unset' | 'invalid' | 'healthy' | 'low';
interface ReserveModel { kind: ReserveKind; binding: ReserveBinding | null; observation: ReserveObservation | null; suggestion: Suggestion | null; thresholdWei: bigint; targetWei: bigint; key: string; error: string; inflight: Data | null }
function ethExact(wei: bigint): string { return formatEther(wei); }
function observedTime(item: string): string { const d = new Date(item); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function reserveTaskKey(binding: ReserveBinding): string { return `${storageKey(binding)}.last-task`; }
function syncReserveSettings() {
  const binding = bindingFromConfig(state.config);
  const key = binding ? storageKey(binding) : '';
  if (key === state.reserve.bindingKey) return;
  state.reserve.bindingKey = key; state.reserve.notice = null; state.reserve.draft = null;
  const saved = binding ? loadSettings(binding) : { threshold: '', target: '' };
  state.reserve.threshold = saved.threshold; state.reserve.target = saved.target;
  try { state.reserve.lastTaskId = binding ? sessionStorage.getItem(reserveTaskKey(binding)) || '' : ''; } catch { state.reserve.lastTaskId = ''; }
}
/** Any submitted, not yet final task to the operating wallet blocks a new suggestion from being prepared. */
function inflightTopUp(tasks: Data[], recipient: string): Data | null {
  return tasks.find(t => !t._draft && taskRecipient(t).toLowerCase() === recipient && ['ready', 'approval'].includes(column(t))) || null;
}
function reserveModel(): ReserveModel {
  const binding = bindingFromConfig(state.config);
  const base: ReserveModel = { kind: 'loading', binding, observation: null, suggestion: null, thresholdWei: 0n, targetWei: 0n, key: '', error: '', inflight: null };
  if (!connected()) return { ...base, kind: 'locked' };
  if (!state.online) return { ...base, kind: 'unavailable', error: '服务离线，无法读取运行钱包余额。' };
  if (!binding || !canConnect()) return { ...base, kind: 'unavailable', error: readinessMessage() || '服务配置缺少网络、金库或运行钱包地址，无法读取余额。' };
  if (state.walletError) return { ...base, kind: 'unavailable', error: `无法读取链上余额：${state.walletError}` };
  if (!state.wallet) return base;
  const observed = observationFromSnapshot(state.wallet, binding);
  if (!observed.ok) return { ...base, kind: 'unavailable', error: observed.error };
  const settings = parseSettings(state.reserve.threshold, state.reserve.target);
  const inflight = inflightTopUp(state.tasks, binding.recipient);
  if (!settings.ok) return { ...base, observation: observed.observation, inflight, kind: settings.empty ? 'unset' : 'invalid', error: settings.error };
  const suggestion = suggestTopUp(observed.observation.balanceWei, settings.thresholdWei, settings.targetWei);
  return { ...base, kind: suggestion.kind, observation: observed.observation, suggestion, inflight, thresholdWei: settings.thresholdWei, targetWei: settings.targetWei, key: suggestionKey(binding, observed.observation.balanceWei, settings.thresholdWei, settings.targetWei, suggestion.topUpWei) };
}
function reserveCard(): string {
  const m = reserveModel();
  const labels: Record<ReserveKind, [string, string]> = { locked: ['连接后读取', ''], loading: ['读取中', ''], unavailable: ['无法判断', 'blocked'], unset: ['未设置', ''], invalid: ['设置无效', 'blocked'], healthy: ['未低于下限', 'green'], low: ['低于你设置的下限', 'approval'] };
  const [label, tone] = labels[m.kind];
  const recipient = m.binding ? value(state.config, 'recipientAddress') : '';
  const o = m.observation;
  const budget = object(get(state.wallet, 'budget'));
  const policy = (key: string) => get(budget, key) !== undefined ? usd(get(budget, key)) : '—';
  const lastTask = state.reserve.lastTaskId ? state.tasks.find(t => id(t) === state.reserve.lastTaskId) : undefined;
  const notice = state.reserve.notice && state.reserve.notice.key === m.key ? state.reserve.notice.text : '';
  let result = '';
  if (m.kind === 'locked') result = `<p class="reserve-message">连接 Owner 钱包并签名登录后读取运行钱包余额。</p>`;
  else if (m.kind === 'loading') result = `<p class="reserve-message"><span class="spinner"></span>正在读取链上余额…</p>`;
  else if (m.kind === 'unavailable') result = `<p class="reserve-message error-text" data-testid="reserve-error">${icon('info')}${esc(m.error)}</p><p class="reserve-caveat">余额未知时不按 0 处理，也不会提示准备金不足或准备付款。</p>`;
  else if (m.kind === 'unset' || m.kind === 'invalid') result = `<p class="reserve-message ${m.kind === 'invalid' ? 'error-text' : ''}" data-testid="reserve-error">${icon('info')}${esc(m.error)}</p>`;
  else if (m.kind === 'healthy') result = `<p class="reserve-message" data-testid="reserve-healthy">${icon('check')}当前余额未低于你设置的下限 ${esc(ethExact(m.thresholdWei))} ETH，暂无补给建议。</p>`;
  else if (m.kind === 'low' && m.suggestion && o) {
    const blocked = Boolean(m.inflight) || disabled();
    result = `<div class="reserve-suggestion"><span>建议补给</span><strong data-testid="reserve-suggestion">${esc(ethExact(m.suggestion.topUpWei))}<small> ETH</small></strong><span class="mono">= 目标 ${esc(ethExact(m.targetWei))} − 当前 ${esc(ethExact(o.balanceWei))}</span></div>
      ${notice ? `<div class="missing-note" role="alert" data-testid="reserve-review-note">${icon('info')}${esc(notice)}</div>` : ''}
      ${m.inflight ? `<div class="missing-note" data-testid="reserve-inflight">${icon('clock')}已有进行中的付款 AEG-${esc(id(m.inflight).slice(-6).toUpperCase())}（${esc(statusLabel(m.inflight))}）。请先查看原任务，不要再建一笔。<button class="text-button" data-open-task="${esc(id(m.inflight))}">查看原任务</button></div>` : ''}
      <button class="button primary" data-action="reserve-prepare" data-testid="reserve-prepare" data-reserve-key="${esc(m.key)}" ${blocked ? 'disabled' : ''}>${state.busy === 'reserve' ? '<span class="spinner"></span>正在重新读取…' : `${icon('arrow')}${notice ? '已核对新金额，准备预览' : '重新读取并准备预览'}`}</button>
      <p class="reserve-caveat">准备前会重新读取配置与余额；有变化会先请你再次核对。生成预览不会付款，仍需你确认提交。</p>`;
  }
  if (notice && m.kind !== 'low') result += `<div class="missing-note" role="status" data-testid="reserve-review-note">${icon('info')}${esc(notice)}</div>`;
  const balanceText = o ? ethExact(o.balanceWei) : '—';
  const lastTaskRow = lastTask ? `<button class="text-button reserve-last" data-open-task="${esc(id(lastTask))}" data-testid="reserve-last-task">${icon('activity')}最近补给 AEG-${esc(id(lastTask).slice(-6).toUpperCase())} · ${esc(statusLabel(lastTask))}</button>` : '';
  return `<section class="reserve" data-testid="reserve-card" data-state="${m.kind}" aria-label="收款运行钱包 Gas 准备金">
    <div class="wallet-card">
      <div class="wallet-card-head"><div><h2>收款运行钱包</h2><p>接收资金池转入的 ETH 补给</p></div>${recipient ? `<button class="icon-button wallet-copy" data-copy="${esc(recipient)}" aria-label="复制收款运行钱包地址">${icon('copy')}</button>` : ''}</div>
      <p class="wallet-address mono break-all">${esc(recipient || '运行钱包地址尚未获取')}</p>
      <div class="wallet-balance"><span class="wallet-label">运行钱包余额</span><strong data-testid="reserve-balance" data-long="${balanceText.length > 14}">${esc(balanceText)}<small> ETH</small></strong></div>
      <div class="wallet-foot"><span class="reserve-status ${tone}" data-testid="reserve-status">${label}</span><p class="reserve-meta">${m.binding ? `${esc(mode())} · Chain ${m.binding.chainId}` : '网络未知'}${o ? ` · 区块 #${esc(o.blockNumber)} · ${esc(observedTime(o.observedAt))}` : ''}</p></div>
    </div>
    <div class="reserve-editor">
      <div class="editor-head"><h2>设置 ETH 储备补给</h2><p>当余额低于下限时，补充到目标金额。设置只保存在这个浏览器。</p></div>
      <div class="reserve-settings">
        <label>下限 · ETH<input id="reserve-threshold" data-testid="reserve-threshold" class="mono" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="例如 0.05" value="${esc(state.reserve.threshold)}" ${!m.binding ? 'disabled' : ''} /></label>
        <label>目标 · ETH<input id="reserve-target" data-testid="reserve-target" class="mono" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="例如 0.1" value="${esc(state.reserve.target)}" ${!m.binding ? 'disabled' : ''} /></label>
        <p class="reserve-caveat">浏览器本地保存，按网络、资金池和收款钱包分别存储。不是链上策略，不会自动补给。</p>
      </div>
      <div class="reserve-result">${result}${lastTaskRow}</div>
    </div>
    <details class="reserve-technical">
      <summary id="reserve-details-toggle">策略与观测详情 ${icon('down')}</summary>
      <div class="reserve-technical-body">
        ${detailRow('补给资金池合约', walletAddress(), true)}${detailRow('收款运行钱包', recipient, true)}${o ? detailRow('区块哈希', short(o.blockHash, 10)) : ''}
        <p class="reserve-caveat">补给建议仅表示余额低于你自己设置的下限，不证明某个任务一定会失败，也不预测还能执行多少笔交易。美元成本与是否需要审批以下一步的预览为准。补款交易手续费由执行账户另付，不计入补给数量和美元预算。</p>
        <p class="reserve-caveat">服务器链上策略（只读）：自动额度 ${policy('autoThresholdUsd6')} · 单笔硬上限 ${policy('hardPerTxUsd6')} · 今日共享预算剩余 ${policy('remainingUsd6')}。${expectedChain() === 31337 ? 'Mock Feed · 非公网行情。' : 'Feed 不是 Gas 价格预言机。'}</p>
      </div>
    </details>
  </section>`;
}
function reserveDraftFor(draft: Data | null): ReserveDraft | null {
  const ctx = state.reserve.draft;
  return ctx && draft && id(draft) === ctx.draftId && taskAmount(draft) === ctx.topUpWei && taskRecipient(draft).toLowerCase() === ctx.recipient ? ctx : null;
}
function reserveDraftSection(draft: Data | null): string {
  const ctx = reserveDraftFor(draft);
  if (!ctx) return '';
  return `<div class="detail-section" data-testid="reserve-draft-context"><h3>Gas 准备金补给</h3>${detailRow('收款运行钱包', ctx.recipient, true)}${detailRow('观测余额', `${ethExact(BigInt(ctx.balanceWei))} ETH · 区块 #${ctx.blockNumber}`)}${detailRow('你的下限 / 目标', `${ethExact(BigInt(ctx.thresholdWei))} / ${ethExact(BigInt(ctx.targetWei))} ETH`)}${detailRow('补给本金', `${ethExact(BigInt(ctx.topUpWei))} ETH`)}<p class="reserve-caveat">补款交易手续费由执行账户另付。读取余额与付款不是原子操作：若其间运行钱包余额被其他交易改变，到账后不一定恰好等于目标。确认后金额不会被改写。</p></div>`;
}

async function prepareReserve(shownKey: string) {
  if (disabled()) return;
  await run('reserve', async () => {
    state.reserve.notice = null;
    const shownBinding = bindingFromConfig(state.config);
    const freshConfig = await sessionApi('/config');
    const binding = bindingFromConfig(freshConfig);
    state.config = freshConfig;
    if (!binding || !serviceReadiness(freshConfig).canPay) throw new Error(readinessMessage() || '服务尚未就绪，已停止准备补给。');
    if (!sameBinding(shownBinding, binding)) { state.wallet = null; syncReserveSettings(); throw new Error('网络、金库或运行钱包配置已变化。请等待重新读取余额并核对设置。'); }
    let snapshot: Data; let taskList: unknown;
    try { [snapshot, taskList] = await Promise.all([sessionApi('/wallets/current'), sessionApi('/tasks')]); }
    catch (error) { state.wallet = null; state.walletError = errorMessage(error); throw error; }
    const tasks = get(taskList, 'tasks');
    if (Array.isArray(tasks)) state.tasks = tasks as Data[];
    const observed = observationFromSnapshot(snapshot, binding);
    if (!observed.ok) { state.wallet = null; state.walletError = observed.error; throw new Error(observed.error); }
    state.wallet = snapshot; state.walletError = '';
    const settings = parseSettings(state.reserve.threshold, state.reserve.target);
    if (!settings.ok) throw new Error(settings.error);
    const { balanceWei, blockNumber, observedAt } = observed.observation;
    const suggestion = suggestTopUp(balanceWei, settings.thresholdWei, settings.targetWei);
    const key = suggestionKey(binding, balanceWei, settings.thresholdWei, settings.targetWei, suggestion.topUpWei);
    if (suggestion.kind !== 'low') { state.reserve.notice = { key, text: '最新余额已不低于你设置的下限，无需补给。没有创建付款草稿。' }; return; }
    if (key !== shownKey) { state.reserve.notice = { key, text: `余额或配置已变化，建议补给已更新为 ${ethExact(suggestion.topUpWei)} ETH（区块 #${blockNumber}）。请核对新金额后再准备。` }; return; }
    const running = inflightTopUp(state.tasks, binding.recipient);
    if (running) throw new Error(`已有进行中的付款 AEG-${id(running).slice(-6).toUpperCase()}，请先查看原任务。`);
    const recipient = String(freshConfig.recipientAddress);
    const amountWei = suggestion.topUpWei.toString();
    // Always a new draft: never PATCH whichever draft happens to be open.
    const draft = await sessionApi('/intents', 'POST', { recipient, amountWei, purpose: `Gas 准备金补给：补到目标 ${ethExact(settings.targetWei)} ETH` });
    const missing = get(draft, 'missingFields');
    if (taskRecipient(draft).toLowerCase() !== binding.recipient || taskAmount(draft) !== amountWei || (Array.isArray(missing) && missing.length)) throw new Error('服务返回的草稿与补给建议不一致，已停止。');
    const quote = await sessionApi(`/intents/${encodeURIComponent(id(draft))}/preview`, 'POST', { expectedRevision: get(draft, 'revision', 'version', 'draftVersion') });
    state.draft = draft; state.quote = quote;
    state.message = ''; state.recipient = recipient; state.amount = formatEther(suggestion.topUpWei); state.purpose = value(draft, 'purpose');
    state.reserve.draft = { draftId: id(draft), recipient: binding.recipient, topUpWei: amountWei, balanceWei: balanceWei.toString(), thresholdWei: settings.thresholdWei.toString(), targetWei: settings.targetWei.toString(), blockNumber, observedAt };
    state.drawer = 'draft';
    if (value(quote, 'status') === 'BLOCKED') notify(value(quote, 'message', 'reason', 'blockReason') || reasons(quote) || '这笔补给未通过规则检查，尚未发起付款。', true);
  });
}

function taskCard(task: Data): string {
  const key = column(task);
  const taskId = id(task);
  return `<button class="task-card" data-task-id="${esc(taskId)}" data-open-task="${esc(taskId)}"><div class="task-card-top"><span class="task-kind">${task._draft ? '草稿' : `AEG-${taskId.slice(-6).toUpperCase()}`}</span></div><h3>${esc(taskName(task))}</h3><div class="task-amount">${taskAmount(task) ? eth(taskAmount(task)) : '待填写'} <span>${taskAmount(task) ? 'ETH' : ''}</span></div><div class="task-recipient mono">${esc(short(taskRecipient(task), 8))}</div>${taskReason(task) ? `<p class="card-reason">${esc(taskReason(task))}</p>` : ''}<div class="task-card-bottom"><span class="task-status ${key}"><span class="status-dot ${columns.find(c => c[0] === key)?.[2] ?? 'neutral'}"></span>${statusLabel(task)}</span><span>${dateTime(get(task, 'updatedAt', 'createdAt'))}</span></div></button>`;
}

function composer(): string {
  const missing = get(state.draft, 'missingFields');
  return `<section class="composer-wrap" aria-label="新建钱包操作"><div class="composer">
    <div class="composer-head"><div class="composer-tabs" role="group" aria-label="输入方式"><button class="${state.composerMode === 'natural' ? 'active' : ''}" data-composer="natural">自然语言补给</button><button class="${state.composerMode === 'manual' ? 'active' : ''}" data-composer="manual">填写金额与地址</button></div>
    <div class="composer-hint"><span>先预览，再确认提交；只支持原生 ETH</span>${state.composerMode === 'manual' && exampleRecipient() ? `<button class="text-button example-button" data-action="fill-example">填入测试收款地址</button>` : ''}</div></div>
    <div class="composer-row">
    ${state.composerMode === 'natural' ? `<textarea id="intent-message" data-testid="intent-message" rows="2" placeholder="例如：向 0x… 转 0.001 ETH，用于支付服务费用" aria-label="描述你的付款意图" ${disabled() ? 'disabled' : ''}>${esc(state.message)}</textarea>` : `<div class="manual-fields"><label>收款地址<input id="recipient" data-testid="recipient-input" class="mono" autocomplete="off" spellcheck="false" placeholder="0x…" value="${esc(state.recipient)}" ${disabled() ? 'disabled' : ''} /></label><label class="amount-field">金额 · ETH<input id="amount" data-testid="amount-input" inputmode="decimal" autocomplete="off" placeholder="0.001" value="${esc(state.amount)}" ${disabled() ? 'disabled' : ''} /></label><label>用途<input id="purpose" placeholder="这笔付款用于什么？" value="${esc(state.purpose)}" ${disabled() ? 'disabled' : ''} /></label></div>`}
    <button class="send-button" data-action="send-intent" data-testid="send-intent" ${disabled() ? 'disabled' : ''} aria-label="预览操作">${state.busy === 'intent' ? '<span class="spinner"></span>' : icon('up')}<span>${state.busy === 'intent' ? '处理中' : '预览'}</span></button>
    </div>
    ${value(state.draft, 'question') ? `<div class="missing-note" role="status" data-testid="intent-question">${icon('info')}<span>${esc(value(state.draft, 'question'))}</span></div>` : ''}
    ${state.draft ? `<p class="composer-disclaimer" data-testid="intent-parser">${get(state.draft, 'parser.kind') === 'llm' ? `解析来源：${esc(value(state.draft, 'parser.model'))} · ${get(state.draft, 'parser.model') === 'stub-intent-v1' ? '离线测试' : '真实模型'}` : `解析来源：规则解析${get(state.draft, 'parser.fallback') ? ` · 回退原因：${esc(value(state.draft, 'parser.reason'))}` : ''}`} · 草稿未付款</p>` : ''}
    ${Array.isArray(missing) && missing.length ? `<div class="missing-note">${icon('info')}还需要补充：${missing.map(item => esc(({ recipient: '收款地址', amountWei: 'ETH 金额', amount: 'ETH 金额', purpose: '用途' } as Record<string, string>)[String(item)] || item)).join('、')}。请填写后重新预览。</div>` : ''}
    <p class="composer-disclaimer">${expectedChain() === 31337 ? 'Local 本地链 · Mock Feed · 仅限开发资产' : '测试环境 · 金额、地址与规则以最终预览为准'} · ${get(state.config, 'planner.mode') === 'stub' ? 'Stub 离线测试解析，未调用在线模型' : get(state.config, 'planner.llmEnabled') === false ? '自然语言使用规则解析，未调用大模型' : '意图解析结果需你确认'}</p>
  </div></section>`;
}

function exampleRecipient(): string { return value(state.config, 'recipientAddress', 'addresses.recipient', 'exampleRecipient', 'demoRecipient', 'examples.recipient', 'examples.allowedRecipient', 'demo.recipient'); }
function emptyState(symbol: string, title: string, description: string): string { return `<div class="empty-state">${icon(symbol)}<h3>${title}</h3><p>${description}</p></div>`; }

function settingsView(): string {
  const labels: Record<string, [string, string]> = { account: ['wallet', '钱包与账户'], policy: ['shield', '授权与预算'], network: ['layers', '网络与合约'], developer: ['activity', '开发环境'] };
  return `<div class="settings-layout"><aside class="settings-nav"><h1>设置</h1><p>查看当前环境和授权配置</p>${Object.entries(labels).map(([key, [symbol, text]]) => `<button class="${state.settingsTab === key ? 'active' : ''}" data-settings="${key}">${icon(symbol)}${text}${icon('chevron')}</button>`).join('')}<div class="settings-help">这里展示服务的实际配置。<br/>更改链上规则需要单独授权。</div></aside><section class="settings-panel"><h2>${labels[state.settingsTab][1]}<span class="toolbar-pill">只读</span></h2>${settingsBody()}</section></div>`;
}
function row(label: string, content: unknown, hint = '', mono = false): string { return `<div class="setting-row"><div><strong>${label}</strong>${hint ? `<p>${hint}</p>` : ''}</div><div class="setting-value ${mono ? 'mono' : ''}">${esc(content || '尚未获取')}${mono && content ? `<button class="icon-button small" data-copy="${esc(content)}" aria-label="复制${label}">${icon('copy')}</button>` : ''}</div></div>`; }
function settingsBody(): string {
  if (state.settingsTab === 'account') return `<div class="settings-card"><div class="account-profile"><span class="large-avatar">${mark()}</span><div><h3>Aegis 补给资金池</h3><p>原生 ETH · 受策略约束的操作</p></div><span class="badge ${connected() ? 'green' : ''}">${connected() ? '已签名登录' : '未登录'}</span></div>${row('当前连接账户', state.address, '用于登录与 Owner 审批签名', true)}${row('补给资金池合约', walletAddress(), '存放用于补给的 ETH，由合约规则约束付款', true)}${row('资金池管理员（Owner）', value(state.wallet, 'ownerAddress', 'owner') || value(state.config, 'ownerAddress', 'owner', 'addresses.owner'), '管理资金池规则，并签名审批待确认付款', true)}${row('Agent 执行账户', value(state.config, 'agentAddress', 'addresses.agent'), '在资金池规则内提交付款请求', true)}${row('收款运行钱包', exampleRecipient(), '接收补给 ETH；收款不会获得资金池管理权限', true)}</div><button class="button subtle danger-text" data-action="disconnect" ${!connected() ? 'disabled' : ''}>${icon('logout')}断开本次会话</button>`;
  if (state.settingsTab === 'policy') { const policy = get(state.wallet, 'policy') || get(state.wallet, 'budget') || get(state.config, 'policy'); const p = object(policy); return `<div class="settings-card">${row('策略版本', value(p, 'policyVersion', 'version') || value(state.wallet, 'policyVersion'))}${row('自动执行上限', get(p, 'autoThresholdUsd6', 'autoLimitUsd6', 'autoApproveLimitUsd6') !== undefined ? usd(get(p, 'autoThresholdUsd6', 'autoLimitUsd6', 'autoApproveLimitUsd6')) : '', '超过自动上限需要 Owner 审批')}${row('单次硬上限', get(p, 'hardPerTxUsd6', 'perTxLimitUsd6', 'singleLimitUsd6') !== undefined ? usd(get(p, 'hardPerTxUsd6', 'perTxLimitUsd6', 'singleLimitUsd6')) : '', 'Owner 批准也不能绕过硬上限')}${row('每日硬预算', get(p, 'dailyLimitUsd6', 'dailyBudgetUsd6') !== undefined ? usd(get(p, 'dailyLimitUsd6', 'dailyBudgetUsd6')) : '', '执行时按真实价格累计')}${row('冻结状态', get(p, 'paused', 'frozen') === true ? '已冻结' : get(p, 'paused', 'frozen') === false ? '未冻结' : '', '执行与审批时都重新检查')}</div><p class="settings-caption">白名单、预算、策略版本和冻结状态最终由合约校验。这里不会伪造或本地覆盖链上权限。</p>`; }
  if (state.settingsTab === 'network') return `<div class="settings-card">${row('网络', mode())}${row('Chain ID', String(expectedChain() || ''))}${row('补给资金池合约', walletAddress(), '', true)}${row('Access Control', value(state.config, 'aclAddress', 'addresses.acl', 'contracts.acl'), '', true)}${row('存证合约', value(state.config, 'attestationAddress', 'addresses.attestation', 'contracts.attestation'), '', true)}${row('Chainlink Feed', value(state.config, 'feedAddress', 'addresses.feed', 'oracle.feedAddress'), '价格的新鲜度和精度由服务读取', true)}${row('RPC', value(state.config, 'rpcUrl', 'chain.rpcUrl'), '浏览器签名前必须与任务 Chain ID 一致')}</div>`;
  return `<div class="settings-card">${row('运行模式', mode(), expectedChain() === 31337 ? 'Local 仅为本机开发链，不能用于公网资金' : '当前不是本地链')}${row('API 状态', state.online ? '已连接 · /api/v1' : '离线')}${row('前端连接', '浏览器 EIP-1193 钱包', '连接后先签名登录；Owner 交易由浏览器钱包单独签名')}${row('验证方式', '链上回执与记录对照', '本地计算一致不等于付款成功')}</div><div class="info-panel">${icon('info')}<p>历史静态演示位于 <code>legacy-demo.html</code>，其中数据为模拟，不能用于本界面的操作或验证。</p></div>`;
}

function verificationView(): string {
  const tasks = state.tasks.filter(t => ['done', 'approval', 'blocked'].includes(column(t)));
  return `<section class="page-heading"><div><h1>验证每一笔结果</h1><p>对照任务、真实交易回执与存证记录。尚未取得的证据会明确标记。</p></div><button class="button subtle" data-action="refresh">${icon('refresh')}刷新记录</button></section><div class="verification-callout">${icon('verify')}<div><strong>证据来自服务与链上查询</strong><p>一次本地哈希重算无法单独证明付款成功。打开记录查看网络、金额、回执与验证结果。</p></div></div><div class="activity-list">${tasks.length ? tasks.map(t => `<button class="activity-row" data-open-task="${esc(id(t))}" data-task-id="${esc(id(t))}"><span class="activity-symbol ${column(t)}">${icon(column(t) === 'done' ? 'check' : column(t) === 'approval' ? 'clock' : 'info')}</span><div><strong>${esc(taskName(t))}</strong><p class="mono">${esc(id(t))}</p></div><span class="activity-amount">${eth(taskAmount(t))} ETH</span><span class="task-status ${column(t)}">${statusLabel(t)}</span>${icon('chevron')}</button>`).join('') : emptyState('verify', '还没有可验证的操作', '完成一笔真实测试交易后，在这里查看回执与存证。')}</div>`;
}

function drawer(): string {
  const isDraft = state.drawer === 'draft';
  const task = isDraft ? state.draft : state.detail || state.tasks.find(t => id(t) === state.drawer);
  if (!task) return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" aria-label="操作详情"><div class="drawer-header"><h2>正在读取操作</h2><button class="icon-button" data-action="close-drawer" aria-label="关闭详情">${icon('close')}</button></div><div class="drawer-body">${emptyState('clock', '读取实际状态', '正在向服务请求这笔操作的最新记录。')}</div></aside>`;
  const quote = isDraft ? state.quote : object(get(task, 'quote', 'preview'));
  const taskId = id(task);
  const s = isDraft && quote ? value(quote, 'status') : status(task);
  const c = isDraft && quote ? column({ status: s }) : column(task);
  const transactions = Array.isArray(task.transactions) ? task.transactions as Data[] : [];
  return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" aria-label="操作详情" role="dialog" aria-modal="true"><div class="drawer-header"><span>${icon(isDraft ? 'layers' : 'activity')} ${isDraft ? '确认操作' : '操作详情'}</span><button class="icon-button" data-action="close-drawer" aria-label="关闭详情">${icon('close')}</button></div><div class="drawer-body"><div class="drawer-title"><div class="eyebrow">${isDraft ? '提交前确认' : `AEG-${esc(taskId.slice(-6).toUpperCase())}`}</div><h2>${esc(taskName(task))}</h2><span class="badge ${c}">${isDraft && !quote ? '等待预览' : statusLabel({ status: s })}</span></div><div class="transfer-hero"><span>付款金额</span><strong>${eth(taskAmount(task))}<small> ETH</small></strong>${get(quote, 'costUsd6') !== undefined ? `<span>预计 ${usd(get(quote, 'costUsd6'))} · 执行时重新计价</span>` : ''}</div>${isDraft ? reserveDraftSection(task) : ''}<div class="detail-section"><h3>付款信息</h3>${detailRow('收款地址', taskRecipient(task), true)}${detailRow('所在网络', `${mode()} · Chain ${expectedChain() || '—'}`)}${detailRow('资金池合约', walletAddress(), true)}${detailRow('任务 ID', taskId, true)}${detailRow('策略版本', value(quote, 'policyVersion') || value(task, 'policyVersion'))}</div>
    ${quote && Object.keys(quote).length ? `<div class="detail-section"><h3>规则预检</h3>${detailRow('状态', s === 'READY' ? '已通过预检，提交时仍会重新检查' : value(quote, 'reason', 'message', 'blockReason') || reasons(quote) || s)}${detailRow('美元最高成本', get(quote, 'maxUsdCost6') !== undefined ? usd(get(quote, 'maxUsdCost6')) : '')}${detailRow('报价有效至', dateTime(get(quote, 'quoteExpiresAtSeconds', 'expiresAt')))}${detailRow('授权路径', get(quote, 'requiresApproval') === true || /APPROVAL/.test(value(quote, 'decision', 'path')) ? '需要 Owner 审批' : value(quote, 'decision', 'path') || '以提交后链上结果为准')}</div>` : ''}
    ${isDraft && state.previewError ? `<div class="info-panel error-panel">${icon('info')}<p>${esc(state.previewError)} 草稿已保留，可重新预览。</p></div>` : taskReason(task) ? `<div class="info-panel error-panel">${icon('info')}<p>${esc(taskReason(task))}</p></div>` : ''}
    ${transactions.length ? `<div class="detail-section"><h3>交易记录</h3>${transactions.map(tx => { const hash = value(tx, 'txHash', 'hash', 'transactionHash'); const link = explorer(hash); return `<div class="transaction-item"><div><span>${esc(value(tx, 'action', 'kind', 'type') || '链上交易')}</span><span>${esc(value(tx, 'status') || '待核对')}</span></div>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="mono">${esc(short(hash, 12))}${icon('external')}</a>` : `<span class="mono">${esc(hash || '尚未取得交易哈希')}</span>`}</div>`; }).join('')}</div>` : ''}
    ${!isDraft ? `<div class="detail-section"><div class="section-title-row"><h3>结果验证</h3><button class="text-button" data-action="load-evidence">${icon('refresh')}重新核验</button></div>${evidenceView()}</div>` : `<div class="review-note">${icon('info')}<p>请核对完整地址与金额。确认后由服务发起链上请求；若需要审批，Owner 仍需在钱包中签名。</p></div>`}</div>
    <div class="drawer-footer">${drawerActions(task, isDraft, quote, c)}</div></aside>`;
}
function drawerActions(task: Data, isDraft: boolean, quote: Data | null, c: Column): string {
  if (isDraft && !quote) return `<button class="button subtle" data-action="edit-draft">返回修改</button><button class="button primary" data-action="retry-preview" data-testid="retry-preview" ${disabled() ? 'disabled' : ''}>${state.busy === 'preview' || state.busy === 'intent' ? '<span class="spinner"></span>正在预览…' : `${icon('refresh')}重新预览`}</button>`;
  if (isDraft) return `<button class="button subtle" data-action="edit-draft">返回修改</button><button class="button primary" data-action="confirm-transfer" data-testid="confirm-transfer" ${disabled() || value(quote, 'status') !== 'READY' ? 'disabled' : ''}>${state.busy === 'submit' ? '<span class="spinner"></span>提交中…' : `${icon('arrow')}确认并提交`}</button>`;
  if (c === 'approval' && pendingBroadcast(id(task))) return `<span class="muted">已广播原交易，请勿重复签名</span><button class="button subtle" data-action="observe-owner" ${state.busy ? 'disabled' : ''}>${icon('refresh')}核对原交易</button>`;
  if (c === 'approval') return `<button class="button subtle" data-action="cancel-task" data-testid="cancel-task" ${disabled() ? 'disabled' : ''}>取消请求</button><button class="button primary" data-action="approve-task" data-testid="approve-task" ${disabled() ? 'disabled' : ''}>${icon('approve')}批准并付款</button>`;
  return `<span class="muted">${c === 'done' ? '最终结果以链上回执为准' : '任务状态由服务读取'}</span><button class="button subtle" data-action="close-drawer">关闭</button>`;
}
function detailRow(label: string, content: unknown, mono = false): string { return `<div class="detail-row"><span>${label}</span><div class="${mono ? 'mono break-all' : ''}">${esc(content || '尚未取得')}${mono && content ? `<button class="icon-button small" data-copy="${esc(content)}" aria-label="复制${label}">${icon('copy')}</button>` : ''}</div></div>`; }
function evidenceView(): string {
  if (state.evidenceLoading) return '<div class="evidence-placeholder"><span class="spinner"></span>正在读取回执与存证…</div>';
  if (state.evidenceError) return `<div class="evidence-placeholder error-text">${icon('info')}${esc(state.evidenceError)}</div>`;
  if (!state.evidence) return '<div class="evidence-placeholder">尚未取得验证记录；不能据此宣称付款成功。</div>';
  const evidence = state.evidence;
  const checks = get(evidence, 'checks', 'verification.checks');
  const rows = Array.isArray(checks) ? (checks as Data[]).map(check => `<div class="evidence-check ${get(check, 'passed', 'ok', 'valid') === true ? 'pass' : 'unknown'}">${icon(get(check, 'passed', 'ok', 'valid') === true ? 'check' : 'info')}<span>${esc(value(check, 'label', 'name', 'type'))}</span><span>${esc(value(check, 'status') || (get(check, 'passed', 'ok', 'valid') === true ? '一致' : '未证实'))}</span></div>`).join('') : '';
  const verification = value(evidence, 'status', 'verification.status', 'verificationStatus');
  const chainVerified = get(evidence, 'verification.chainVerified') === true;
  const hashVerified = get(evidence, 'verification.hashVerified') === true;
  const nativeChecks = !rows ? `<div class="evidence-check ${chainVerified ? 'pass' : 'unknown'}">${icon(chainVerified ? 'check' : 'info')}<span>链上任务事件</span><span>${chainVerified ? '已匹配' : '尚未证实'}</span></div><div class="evidence-check ${hashVerified ? 'pass' : 'unknown'}">${icon(hashVerified ? 'check' : 'info')}<span>请求哈希绑定</span><span>${hashVerified ? '一致' : '尚未证实'}</span></div>${detailRow('存证记录 ID', value(evidence, 'attestationId'))}${detailRow('请求哈希', value(evidence, 'intent.requestHash'), true)}` : '';
  return `${verification ? `<div class="verification-summary"><span class="status-dot ${chainVerified ? 'green' : 'neutral'}"></span>${esc(statusLabel({ status: verification }))}</div>` : ''}${rows}${nativeChecks}${value(evidence, 'message', 'summary') ? `<p class="muted">${esc(value(evidence, 'message', 'summary'))}</p>` : ''}<p class="muted" style="font-size:9px;margin-top:12px">${chainVerified && verification === 'EXECUTED' ? '匹配到付款执行事件。' : verification === 'AWAITING_APPROVAL' ? '入队事件表示等待审批，资金尚未支付。' : '状态与交易事件需一并核对。'}一次 mined 确认不表示最终不可逆。</p><details class="raw-evidence"><summary>查看原始验证数据${icon('down')}</summary><pre>${esc(JSON.stringify(evidence, null, 2))}</pre></details>`;
}

function ownerModal(): string {
  const review = state.ownerReview;
  if (!review) return '';
  return `<div class="modal-backdrop"><section class="owner-modal" role="dialog" aria-modal="true" aria-labelledby="owner-review-title"><div class="modal-symbol">${icon('shield')}</div><h2 id="owner-review-title">${review.action === 'approve' ? '确认 Owner 批准' : '确认取消这笔请求'}</h2><p>${review.action === 'approve' ? '此签名将批准并执行付款。请再次核对收款地址和金额。' : '此签名将取消链上的待审批请求。'}</p><div class="modal-details">${detailRow('金额', `${eth(taskAmount(review.task))} ETH`)}${detailRow('收款地址', taskRecipient(review.task), true)}${detailRow('网络', `${mode()} · Chain ${expectedChain()}`)}${detailRow('签名账户', value(review.tx, 'from'), true)}${detailRow('目标合约', value(review.tx, 'to'), true)}</div><div class="review-note">${icon('verify')}<p>已核对合约、方法与待审批记录 ID。钱包打开后，请继续检查交易详情。</p></div><div class="modal-actions"><button class="button subtle" data-action="dismiss-owner">返回</button><button class="button primary" data-action="sign-owner" data-testid="sign-owner-transaction" ${disabled() ? 'disabled' : ''}>${icon('wallet')}${state.busy ? '等待钱包…' : review.action === 'approve' ? '打开钱包批准' : '打开钱包取消'}</button></div></section></div>`;
}
function localWalletModal(): string {
  return `<div class="modal-backdrop"><section class="owner-modal" role="dialog" aria-modal="true" aria-labelledby="local-wallet-title"><div class="modal-symbol">${icon('wallet')}</div><h2 id="local-wallet-title">使用本地测试钱包</h2><p>使用本机节点已解锁的公开开发 Owner 账户。仅限 Chain 31337，测试 ETH 没有真实价值。此入口不会读取或保存私钥，也不能用于 Sepolia 或公网资金。</p><div class="modal-details">${detailRow('网络', 'Local · 真实本地链')}${detailRow('价格', '本地 Mock Feed，非公网 Chainlink 行情')}${detailRow('公开开发账户', value(state.config, 'ownerAddress'), true)}${detailRow('RPC', value(state.config, 'rpcUrl'))}</div><div class="modal-actions"><button class="button subtle" data-action="dismiss-local-wallet">返回</button><button class="button primary" data-action="confirm-local-wallet" data-testid="confirm-local-wallet" ${!state.online || !canConnect() || state.refreshing || state.busy ? 'disabled' : ''}>${state.busy ? '正在签名登录…' : '确认使用公开开发账户'}</button></div></section></div>`;
}

function walletPickerModal(): string {
  const options = discovery.list();
  return `<div class="modal-backdrop"><section class="owner-modal wallet-picker" role="dialog" aria-modal="true" aria-labelledby="wallet-picker-title"><div class="modal-symbol">${icon('wallet')}</div><h2 id="wallet-picker-title">选择你的钱包</h2><p>选择你安装的钱包。连接只读取账户和网络，Owner 签名登录是下一步。</p><div class="wallet-options">${options.map(option => `<button class="wallet-option" data-action="choose-wallet" data-wallet-id="${esc(option.id)}" data-testid="wallet-option-${esc(option.id)}"><span class="wallet-option-symbol">${option.icon ? `<img src="${esc(option.icon)}" alt="${esc(option.name)} Logo" width="36" height="36">` : icon('wallet')}</span><span><strong>${esc(option.name)}</strong><small>${option.rdns ? esc(option.rdns) : '浏览器提供的兼容入口'}</small></span>${icon('arrow')}</button>`).join('') || '<p class="settings-caption" data-testid="wallet-not-detected">未检测到可用钱包插件。请在安装并启用了 MetaMask 的 Chrome 或 Edge 中打开本页面，然后重新检测。</p>'}</div><p class="wallet-support-note">支持 MetaMask、Trust Wallet、Rabby、OKX、Coinbase 等浏览器钱包。未检测到的钱包请先在浏览器中安装或启用，再重新检测。</p><div class="modal-actions"><button class="button subtle" data-action="dismiss-wallet-picker">返回</button><button class="button" data-action="rescan-wallets">重新检测钱包</button></div></section></div>`;
}

function walletConnectionPanel(): string {
  const isOwner = state.connection?.role === 'owner';
  return `<section class="connection-panel" data-testid="wallet-connection"><div class="section-head"><div><p class="eyebrow">${esc(state.providerName || '浏览器钱包')}</p><h1>钱包已连接</h1></div><span class="badge ${isOwner ? 'amber' : ''}" data-testid="connection-role">${isOwner ? '待签名登录' : '只读连接'}</span></div><p>${isOwner ? '这是资金池配置的 Owner 地址。确认登录消息后，才能读取私有任务并使用付款操作。' : '你的钱包已连接，但不是这个资金池的 Owner。当前不会请求登录签名，也不能付款、审批或读取私有任务。'}</p><div class="modal-details">${detailRow('当前账户', state.address, true)}${detailRow('钱包网络', `${mode()} · Chain ${state.connection?.chainId || '—'}`)}${detailRow('资金池 Owner', value(state.config, 'ownerAddress'), true)}${detailRow('补给资金池合约', walletAddress(), true)}</div><div class="connection-actions">${isOwner ? '<button class="button primary" data-action="owner-login" data-testid="owner-login">以 Owner 签名登录</button>' : ''}<button class="button" data-action="connect">更换钱包</button>${localWalletAvailable(state.config) ? '<button class="button subtle" data-action="local-wallet">体验本地测试钱包</button>' : ''}<button class="text-button" data-action="disconnect">断开连接</button></div><p class="settings-caption">${expectedChain() === 31337 ? '当前页面连接 Local 开发链。现场使用个人钱包付款前，需要把演示部署的 Owner 与实际签名账户配置一致。' : '当前资金池采用单 Owner 授权。连接个人地址不会授予这个资金池的管理权限。'}</p></section>`;
}

function clearWalletSession() {
  walletSessionRevision++;
  setToken(''); disconnectProvider();
  try { sessionStorage.removeItem('aegis.address'); sessionStorage.removeItem('aegis.wallet-kind'); } catch { /* Clear in-memory private state even when browser storage is blocked. */ }
  state.address = ''; state.connection = null; state.walletKind = ''; state.providerName = '';
  state.wallet = null; state.tasks = []; state.draft = null; state.quote = null;
  state.ownerReview = null; state.drawer = ''; state.detail = null; state.evidence = null; state.evidenceLoading = false;
  state.reserve.draft = null; state.localWalletConfirm = false;
  registerWalletListeners();
}

function rememberWalletIdentity(kind: 'browser' | 'local', address: string) {
  try { sessionStorage.setItem('aegis.wallet-kind', kind); sessionStorage.setItem('aegis.address', address); }
  catch { /* A blocked browser store must not prevent the current in-memory connection. */ }
}

const refresh = singleFlightByRevision(() => walletSessionRevision, refreshSnapshot);
async function refreshSnapshot(revision: number, initial: boolean) {
  if (revision !== walletSessionRevision) return;
  try {
    const config = await sessionApi('/config');
    if (revision !== walletSessionRevision) return;
    state.config = config;
    state.chainId = expectedChain();
    state.online = true;
    state.serviceErrorCode = '';
    state.serviceErrorMessage = '';
    if (!canConnect()) { state.wallet = null; state.walletError = readinessMessage(); state.tasks = []; state.ownerReview = null; state.drawer = ''; }
    if (hasSession() && canConnect()) {
      const results = await Promise.allSettled([sessionApi('/wallets/current'), sessionApi('/tasks')]);
      if (revision !== walletSessionRevision) return;
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === 'fulfilled') {
          if (index === 0) { state.wallet = object(result.value); state.walletError = ''; }
          else { const response = result.value; const list = Array.isArray(response) ? response : get(response, 'tasks', 'items'); if (Array.isArray(list)) state.tasks = list as Data[]; }
        } else {
          // A failed snapshot is "unavailable", never a stale or zero balance.
          if (index === 0) { state.wallet = null; state.walletError = errorMessage(result.reason); }
          if (result.reason instanceof ApiError && result.reason.status === 401) {
            clearWalletSession();
            // This refresh owns the logout transition; its old revision must
            // not leave a private snapshot rendered until the next poll.
            render();
            return;
          }
          // /config already proved that the API is online. A slower optional
          // chain snapshot is unavailable data, not an offline backend.
        }
      }
      if (state.drawer && state.drawer !== 'draft') {
        const drawer = state.drawer;
        try {
          const detail = await sessionApi(`/tasks/${encodeURIComponent(drawer)}`);
          if (revision !== walletSessionRevision) return;
          if (state.drawer === drawer) state.detail = detail;
        } catch { /* Retain the last server response while the network recovers. */ }
      }
    }
  } catch (error) {
    if (revision !== walletSessionRevision || error instanceof SessionChangedError) return;
    state.config = null;
    state.online = error instanceof ApiError && error.status !== 0;
    state.serviceErrorCode = error instanceof ApiError ? error.code : 'OFFLINE';
    state.serviceErrorMessage = errorMessage(error);
    if (!initial && state.busy) throw error;
  }
  finally {
    if (revision === walletSessionRevision) {
      state.initialLoading = false; syncReserveSettings(); render();
    }
  }
}

async function refreshWithFeedback() {
  if (state.refreshing) return;
  state.refreshing = true;
  render();
  try { await refresh(true); }
  finally { state.refreshing = false; render(); scheduleNextRefresh(); }
}

let refreshTimer: number | undefined;
function scheduleNextRefresh() {
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
  const active = !document.hidden && !state.busy && !state.refreshing;
  const trackedTasks: unknown[] = [...state.tasks];
  if (state.detail) trackedTasks.push(state.detail);
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = undefined;
    if (!document.hidden && !state.busy && !state.refreshing) await refresh();
    scheduleNextRefresh();
  }, nextRefreshDelay(state.config, active, trackedTasks));
}

async function run(name: string, operation: () => Promise<void>) {
  if (state.busy) return;
  state.busy = name; render();
  try { await operation(); }
  catch (error) { if (!(error instanceof SessionChangedError)) notify(errorMessage(error), true); }
  finally { state.busy = ''; render(); }
}

async function createIntent() {
  if (disabled()) return;
  await run('intent', async () => {
    let body: Data;
    if (state.composerMode === 'natural') {
      const message = z.string().trim().min(1).max(4000).safeParse(state.message);
      if (!message.success) throw new Error('请填写 1–4000 字符的操作意图。');
      body = { message: message.data };
    } else {
      const fields = z.object({recipient:addressInput,amount:z.string().max(96).regex(/^\d+(\.\d{1,18})?$/),purpose:z.string().trim().max(500)}).safeParse({recipient:state.recipient,amount:state.amount,purpose:state.purpose});
      if (!fields.success) throw new Error('请填写有效地址、最多 18 位小数的 ETH 金额和不超过 500 字符的用途。');
      const amount = parseEther(fields.data.amount);
      if (amount <= 0n || amount >= 2n ** 256n) throw new Error('ETH 金额必须大于零且不超过合约范围。');
      body = { recipient: fields.data.recipient, amountWei: amount.toString(), purpose: fields.data.purpose || '原生 ETH 付款' };
    }
    const draftId = state.composerMode === 'manual' && state.draft ? id(state.draft) : '';
    const draft = draftId ? await sessionApi(`/intents/${encodeURIComponent(draftId)}`, 'PATCH', { ...body, expectedRevision: get(state.draft, 'revision', 'version', 'draftVersion') }) : await sessionApi('/intents', 'POST', body);
    state.draft = draft; state.quote = null; state.previewError = '';
    state.recipient = taskRecipient(draft);
    state.amount = taskAmount(draft) ? formatEther(BigInt(taskAmount(draft))) : '';
    state.purpose = value(draft, 'purpose');
    const missing = get(draft, 'missingFields');
    if (Array.isArray(missing) && missing.length) { state.composerMode = 'manual'; notify('已整理意图，请补齐金额和收款地址。'); return; }
    if (!taskRecipient(draft) || !taskAmount(draft)) { state.composerMode = 'manual'; notify('请补齐收款地址与 ETH 金额，再预览操作。'); return; }
    state.drawer = 'draft';
    render();
    try { state.quote = await previewDraft(draft); }
    catch (error) { state.previewError = errorMessage(error); throw error; }
    if (value(state.quote, 'status') === 'BLOCKED') notify(value(state.quote, 'message', 'reason', 'blockReason') || reasons(state.quote) || '这笔操作未通过规则检查，尚未发起付款。', true);
  });
}

function previewDraft(draft: Data): Promise<Data> {
  return sessionApi(`/intents/${encodeURIComponent(id(draft))}/preview`, 'POST', { expectedRevision: get(draft, 'revision', 'version', 'draftVersion') });
}

async function retryPreview() {
  if (!state.draft || disabled()) return;
  const draft = state.draft;
  await run('preview', async () => {
    state.previewError = '';
    try { state.quote = await previewDraft(draft); }
    catch (error) { state.previewError = errorMessage(error); throw error; }
  });
}

async function submitIntent() {
  if (!state.draft || !state.quote || disabled()) return;
  const draft = state.draft;
  const quote = state.quote;
  await run('submit', async () => {
    const reserveContext = reserveDraftFor(state.draft);
    const result = await sessionApi(`/intents/${encodeURIComponent(id(draft))}/submit`, 'POST', { expectedRevision: get(draft, 'revision', 'version', 'draftVersion'), quoteId: get(quote, 'quoteId', 'id') });
    const taskId = value(result, 'taskId', 'id');
    if (!taskId) throw new Error('服务没有返回任务 ID。请查看操作列表，不要重复提交。');
    const binding = bindingFromConfig(state.config);
    if (reserveContext && binding) { state.reserve.lastTaskId = taskId; try { sessionStorage.setItem(reserveTaskKey(binding), taskId); } catch { /* Task list still recovers it. */ } }
    state.reserve.draft = null; state.reserve.notice = null;
    state.draft = null; state.quote = null; state.message = ''; state.recipient = ''; state.amount = ''; state.purpose = '';
    state.drawer = taskId; state.detail = result; state.evidence = null;
    await refresh();
    notify('已提交请求，正在核对链上结果。');
    void loadEvidence();
  });
  // run() clears the busy flag in its finally block. Schedule only afterwards,
  // otherwise an active transaction is incorrectly assigned the 30-second idle delay.
  scheduleNextRefresh();
}

async function openTask(taskId: string) {
  if (state.draft && id(state.draft) === taskId) { state.drawer = 'draft'; render(); return; }
  state.drawer = taskId; state.detail = state.tasks.find(t => id(t) === taskId) || null; state.evidence = null; state.evidenceError = ''; render();
  try { state.detail = await sessionApi(`/tasks/${encodeURIComponent(taskId)}`); render(); await loadEvidence(); }
  catch (error) { notify(errorMessage(error), true); }
}

async function loadEvidence() {
  const taskId = state.drawer;
  if (!taskId || taskId === 'draft' || state.evidenceLoading) return;
  state.evidenceLoading = true; state.evidenceError = ''; render();
  try { const response = await sessionApi(`/tasks/${encodeURIComponent(taskId)}/evidence`); if (state.drawer === taskId) state.evidence = response; }
  catch (error) { if (state.drawer === taskId) state.evidenceError = errorMessage(error); }
  finally { state.evidenceLoading = false; render(); }
}

const ownerAbi = parseAbi(['function approveAndExecute(uint64 attestationId)', 'function cancelPending(uint64 attestationId)']);

async function reviewOwner(action: 'approve' | 'cancel') {
  if (!state.detail || disabled()) return;
  if (pendingBroadcast(state.drawer)) { notify('这笔任务已有已广播交易，请先核对原交易，不要重复签名。', true); return; }
  await run('owner-review', async () => {
    const task = await sessionApi(`/tasks/${encodeURIComponent(state.drawer)}`);
    const tx = await sessionApi(`/tasks/${encodeURIComponent(state.drawer)}/owner-tx?action=${action}`);
    if (!isAddress(String(tx.to)) || String(tx.to).toLowerCase() !== walletAddress().toLowerCase() || Number(tx.chainId) !== expectedChain()) throw new Error('审批交易的网络或合约与当前钱包不一致，已停止签名。');
    if (tx.chainBindingVerified !== true || value(tx, 'taskId') !== id(task) || value(tx, 'requestHash').toLowerCase() !== value(task, 'requestHash').toLowerCase() || value(tx, 'attestationId') !== value(task, 'attestationId') || value(tx, 'recipient').toLowerCase() !== taskRecipient(task).toLowerCase() || value(tx, 'amountWei') !== taskAmount(task)) throw new Error('链上待审批内容与任务记录不一致，已停止签名。');
    if (BigInt(String(tx.value || '0')) !== 0n) throw new Error('审批交易携带了额外 ETH，已停止签名。');
    const decoded = decodeFunctionData({ abi: ownerAbi, data: String(tx.data) as `0x${string}` });
    const expectedMethods = action === 'approve' ? ['approveAndExecute'] : ['cancelPending'];
    const attestationId = value(task, 'attestationId', 'pendingId', 'attId', 'onchain.attestationId', 'result.attestationId');
    if (!expectedMethods.includes(decoded.functionName) || !attestationId || !decoded.args || String(decoded.args[0]) !== attestationId) throw new Error('审批方法或待审批记录 ID 与任务不一致，已停止签名。');
    if (column(task) !== 'approval') throw new Error('此任务不再处于待审批状态，请刷新查看。');
    state.detail = task; state.ownerReview = { tx, task, action };
  });
}

async function signOwner() {
  if (!state.ownerReview || disabled()) return;
  await run('owner-sign', async () => {
    const review = state.ownerReview;
    if (!review) return;
    const hash = await sendOwnerTransaction(review.tx, state.address, state.walletKind === 'local' && state.config ? state.config : undefined);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('钱包未返回有效交易哈希。请先在钱包中核对，不要重复签名。');
    sessionStorage.setItem(broadcastKey(id(review.task)), JSON.stringify({ txHash: hash, action: review.action }));
    state.ownerReview = null;
    try { await sessionApi(`/tasks/${encodeURIComponent(id(review.task))}/observed-tx`, 'POST', { txHash: hash, action: review.action }); }
    catch { notify(`交易已广播 ${short(hash, 10)}。服务尚未确认，请刷新核对；不要重复签名。`, true); return; }
    sessionStorage.removeItem(broadcastKey(id(review.task)));
    await refresh(); await loadEvidence();
    notify(review.action === 'approve' ? '批准交易已广播，正在核对付款回执。' : '取消交易已广播，正在核对最终状态。');
  });
}
async function observeOwner() {
  const pending = pendingBroadcast(state.drawer);
  if (!pending) return;
  await run('observe-owner', async () => {
    await sessionApi(`/tasks/${encodeURIComponent(state.drawer)}/observed-tx`, 'POST', pending);
    sessionStorage.removeItem(broadcastKey(state.drawer));
    await refresh(); await loadEvidence();
    notify('已核对原交易结果。');
  });
}

app.addEventListener('error', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.parentElement?.classList.contains('wallet-option-symbol')) return;
  image.parentElement.innerHTML = icon('wallet');
}, true);

app.addEventListener('input', event => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
  const text = z.string().safeParse(input.value);
  if (!text.success) return;
  const fields: Record<string, 'message' | 'recipient' | 'amount' | 'purpose' | 'query'> = { 'intent-message': 'message', recipient: 'recipient', amount: 'amount', purpose: 'purpose', 'task-search': 'query' };
  if (fields[input.id]) { state[fields[input.id]] = text.data; if (input.id === 'task-search') render(); }
  if (input.id === 'reserve-threshold' || input.id === 'reserve-target') {
    state.reserve[input.id === 'reserve-threshold' ? 'threshold' : 'target'] = text.data;
    state.reserve.notice = null;
    const binding = bindingFromConfig(state.config);
    if (binding) saveSettings(binding, state.reserve.threshold, state.reserve.target);
    render();
  }
});
app.addEventListener('keydown', event => { if (event.key === 'Escape' && !state.busy) { state.ownerReview = null; state.localWalletConfirm = false; state.walletPicker = false; state.drawer = ''; render(); } if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target instanceof HTMLElement && event.target.id === 'intent-message') { event.preventDefault(); void createIntent(); } });
app.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>('button, [data-action]');
  if (!button || button.hasAttribute('disabled')) return;
  if (button.dataset.nav) { const parsed=z.enum(['overview','operations','approvals','verification','settings']).safeParse(button.dataset.nav); if (!parsed.success) return; state.view = parsed.data; state.filter = 'all'; state.drawer = ''; render(); return; }
  if (button.dataset.settings) { const parsed=z.enum(['account','policy','network','developer']).safeParse(button.dataset.settings); if (!parsed.success) return; state.settingsTab = parsed.data; render(); return; }
  if (button.dataset.filter) { const parsed=z.enum(['all','active','completed']).safeParse(button.dataset.filter); if (!parsed.success) return; state.filter = parsed.data; render(); return; }
  if (button.dataset.composer) { const parsed=z.enum(['natural','manual']).safeParse(button.dataset.composer); if (!parsed.success) return; state.composerMode = parsed.data; render(); return; }
  if (button.dataset.openTask) { void openTask(button.dataset.openTask); return; }
  if (button.dataset.copy) { void navigator.clipboard.writeText(button.dataset.copy).then(() => notify('已复制')).catch(() => notify('无法访问剪贴板，请手动复制。', true)); return; }
  switch (button.dataset.action) {
    case 'refresh': void refreshWithFeedback(); break;
    case 'connect': if (state.online && canConnect() && !state.refreshing) { state.walletPicker = true; discovery.refresh(); render(); } break;
    case 'dismiss-wallet-picker': state.walletPicker = false; render(); break;
    case 'rescan-wallets': discovery.refresh(); render(); break;
    case 'choose-wallet': void run('connect', async () => {
      const option = discovery.select(button.dataset.walletId);
      if (!option || !state.config || !state.online || !canConnect() || state.refreshing) throw new Error('钱包或服务状态已变化，请重新检测后选择。');
      const config = state.config;
      clearWalletSession();
      const connection = await connectBrowserWallet(expectedChain(), config, option.provider);
      state.connection = connection; state.address = connection.address; state.chainId = connection.chainId;
      state.providerName = option.name; state.walletKind = 'browser'; state.walletPicker = false; state.view = 'overview';
      registerWalletListeners();
      notify(connection.role === 'owner' ? '钱包已连接，请以 Owner 签名登录。' : '钱包已连接，当前为只读连接。');
    }); break;
    case 'owner-login': void run('connect', async () => {
      const connection = state.connection;
      if (!connection || !state.config || !state.online || !canConnect() || state.refreshing) throw new Error('请先重新连接钱包。');
      await authenticateOwner(connection, state.config);
      rememberWalletIdentity('browser', connection.address);
      await refresh(); notify('Owner 签名登录成功。');
    }); break;
    case 'local-wallet': state.localWalletConfirm = true; render(); break;
    case 'dismiss-local-wallet': if (!state.busy) { state.localWalletConfirm = false; render(); } break;
    case 'confirm-local-wallet': void run('connect', async () => { const config = state.config; if (!config || state.refreshing || !state.online || !canConnect() || !localWalletAvailable(config)) throw new Error('当前环境不允许本地测试钱包。'); clearWalletSession(); const session = await connectWallet(31337, config); state.address = session.address; state.chainId = session.chainId; state.walletKind = 'local'; state.connection = session; rememberWalletIdentity('local', session.address); await refresh(); notify('已登录本地公开开发账户，仅用于 Local 测试。'); }); break;
    case 'disconnect': clearWalletSession(); notify('本次会话已断开。'); break;
    case 'send-intent': void createIntent(); break;
    case 'retry-preview': void retryPreview(); break;
    case 'reserve-prepare': void prepareReserve(button.dataset.reserveKey || ''); break;
    case 'confirm-transfer': void submitIntent(); break;
    case 'close-drawer': state.drawer = ''; state.ownerReview = null; render(); break;
    case 'edit-draft': state.drawer = ''; state.composerMode = 'manual'; render(); document.getElementById('recipient')?.focus(); break;
    case 'fill-example': if (isAddress(exampleRecipient())) { state.recipient = exampleRecipient(); render(); notify('已填入测试地址，请核对后再预览。'); } break;
    case 'new-operation': state.view = 'operations'; state.drawer = ''; render(); document.getElementById(state.composerMode === 'natural' ? 'intent-message' : 'recipient')?.focus(); break;
    case 'load-evidence': void loadEvidence(); break;
    case 'approve-task': void reviewOwner('approve'); break;
    case 'cancel-task': void reviewOwner('cancel'); break;
    case 'dismiss-owner': state.ownerReview = null; render(); break;
    case 'sign-owner': void signOwner(); break;
    case 'observe-owner': void observeOwner(); break;
    case 'toggle-theme': toggleTheme(); render(); break;
    case 'dismiss-toast': state.toast = ''; render(); break;
  }
});

function invalidateWallet() { if (!walletLinked() || state.walletKind !== 'browser') return; clearWalletSession(); notify('钱包账户或网络已变更，请重新连接并签名登录。', true); }
let observedProvider: WalletProvider | undefined;
function registerWalletListeners() {
  const active = getActiveProvider();
  if (active === observedProvider) return;
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) observedProvider?.removeListener?.(event, invalidateWallet);
  observedProvider = active;
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) active?.on?.(event, invalidateWallet);
}
discovery.subscribe(() => { if (state.walletPicker) render(); });
discovery.start();
render();
void refresh(true).finally(scheduleNextRefresh);
