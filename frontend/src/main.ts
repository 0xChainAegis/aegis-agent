import { decodeFunctionData, formatEther, formatUnits, isAddress, parseAbi, parseEther } from 'viem';
import { api, ApiError, hasSession, setToken, type Data } from './api';
import { connectWallet, disconnectProvider, localWalletAvailable, sendOwnerTransaction } from './wallet';
import { icon } from './icons';
import './style.css';

type View = 'overview' | 'operations' | 'approvals' | 'verification' | 'settings';
type Column = 'draft' | 'ready' | 'approval' | 'done' | 'blocked';
const app = document.querySelector<HTMLDivElement>('#app')!;
const state = {
  view: 'overview' as View,
  settingsTab: 'account',
  config: null as Data | null,
  wallet: null as Data | null,
  tasks: [] as Data[],
  online: false,
  initialLoading: true,
  address: sessionStorage.getItem('aegis.address') || '',
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
  drawer: '' as string,
  detail: null as Data | null,
  evidence: null as Data | null,
  evidenceLoading: false,
  evidenceError: '',
  ownerReview: null as { tx: Data; task: Data; action: 'approve' | 'cancel' } | null,
  localWalletConfirm: false,
  walletKind: sessionStorage.getItem('aegis.wallet-kind') || '',
};

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

function esc(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function object(value: unknown): Data { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}; }
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
function pendingBroadcast(taskId: string): { txHash: string; action: 'approve' | 'cancel' } | null { try { return JSON.parse(sessionStorage.getItem(broadcastKey(taskId)) || 'null'); } catch { return null; } }
function taskName(task: Data): string { return value(task, 'purpose', 'intent.purpose', 'description', 'message', 'title') || '原生 ETH 付款'; }
function taskRecipient(task: Data): string { return value(task, 'recipient', 'intent.recipient', 'request.recipient', 'to'); }
function taskAmount(task: Data): string { return value(task, 'amountWei', 'intent.amountWei', 'request.amountWei'); }
function walletAddress(): string { return value(state.config, 'walletAddress', 'addresses.wallet', 'contracts.wallet', 'wallet.address') || value(state.wallet, 'walletAddress', 'address'); }
function expectedChain(): number { return Number(get(state.config, 'chainId', 'chain.id') || 0); }
function validConfig(): boolean { return Boolean(expectedChain() > 0 && isAddress(walletAddress()) && get(state.config, 'readiness.ready') === true && Number(get(state.config, 'readiness.rpcChainId')) === expectedChain()); }
function connected(): boolean { return Boolean(state.address && hasSession()); }
function disabled(): boolean { return !state.online || !validConfig() || !connected() || Boolean(state.busy); }
function mode(): string { return expectedChain() === 31337 ? 'Local' : value(state.config, 'mode') === 'mock' ? 'Mock' : expectedChain() === 11155111 ? 'Sepolia' : expectedChain() ? `Chain ${expectedChain()}` : '未连接'; }
function dateTime(item: unknown): string { if (!item) return '—'; const n = Number(item); const d = new Date(Number.isFinite(n) ? n < 1e12 ? n * 1000 : n : String(item)); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function explorer(hash: string): string { const base = value(state.config, 'explorerBaseUrl', 'explorerUrl', 'blockExplorerUrl', 'chain.blockExplorerUrl'); return /^https?:\/\//.test(base) && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${base.replace(/\/$/, '')}/tx/${hash}` : ''; }
function allTasks(): Data[] { const list = [...state.tasks]; if (state.draft && !list.some(item => id(item) === id(state.draft!))) list.unshift({ ...state.draft, ...(state.quote ? { status: state.quote.status } : {}), _draft: true }); return list; }
function notify(message: string, error = false) { state.toast = message; state.toastError = error; render(); window.setTimeout(() => { if (state.toast === message) { state.toast = ''; render(); } }, 7000); }
function errorMessage(error: unknown): string { return Number(get(error, 'code')) === 4001 ? '你取消了钱包请求，尚未提交交易。' : error instanceof Error ? error.message : '操作未完成，请重试。'; }

function render() {
  const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusId = focused?.id;
  const selection = focused?.selectionStart;
  const contentScroll = document.querySelector('.content')?.scrollTop || 0;
  const drawerScroll = document.querySelector('.drawer-body')?.scrollTop || 0;
  const pendingCount = state.tasks.filter(t => column(t) === 'approval').length;
  const activeNav = nav.find(item => item[0] === state.view)!;
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <button class="brand" data-nav="overview" aria-label="Aegis 总览"><span class="brand-symbol">${icon('shield')}</span><span>AEGIS<span class="brand-caption">AGENT WALLET</span></span></button>
      <button class="workspace" data-nav="settings"><span class="workspace-avatar">A</span><span>Aegis 工作空间<small>受策略约束的钱包</small></span>${icon('down')}</button>
      <div class="sidebar-label">工作空间</div>
      <nav aria-label="主导航">${nav.map(([key, symbol, label, en]) => `<button data-nav="${key}" class="nav-item ${state.view === key ? 'active' : ''}" aria-current="${state.view === key ? 'page' : 'false'}">${icon(symbol)}<span>${label}<small>${en}</small></span>${key === 'approvals' && pendingCount ? `<b class="nav-count">${pendingCount}</b>` : ''}</button>`).join('')}</nav>
      <div class="sidebar-bottom"><div class="network-note"><span class="status-dot ${state.online ? 'green' : 'red'}"></span><span>${state.online ? 'API 已连接' : 'API 离线'}<small>${esc(mode())} · ${expectedChain() === 31337 ? '仅本地开发' : '测试环境'}</small></span><button class="icon-button" data-action="refresh" aria-label="刷新服务状态">${icon('refresh')}</button></div><div class="sidebar-footnote">授权有边界，结果可核对。</div></div>
    </aside>
    <main class="main">
      <header class="topbar"><div class="breadcrumb"><span class="mobile-brand">${icon('shield')}</span><span>工作空间</span>${icon('chevron')}<strong>${activeNav[2]}</strong></div><div class="topbar-actions"><span class="network-badge ${expectedChain() === 31337 ? 'local' : ''}"><span class="status-dot ${state.online ? 'green' : 'neutral'}"></span>${esc(mode())}</span>${localWalletAvailable(state.config) && !connected() ? `<button class="button subtle local-wallet-button" data-action="local-wallet" data-testid="local-wallet" ${!validConfig() || state.busy ? 'disabled' : ''}>本地测试钱包</button>` : ''}<button data-action="connect" data-testid="connect-wallet" class="button ${connected() ? 'connected-button' : 'primary'}" ${state.busy === 'connect' || !state.online || !validConfig() ? 'disabled' : ''}>${icon('wallet')}<span>${state.busy === 'connect' ? '等待钱包签名…' : connected() ? short(state.address) : '连接钱包'}</span></button></div></header>
      <div class="content ${state.view === 'settings' ? 'settings-content' : ''}">
        ${!state.online ? `<div class="service-banner" role="status">${icon('info')}<span><strong>${state.initialLoading ? '正在连接服务' : '服务离线'}</strong> · ${state.initialLoading ? '正在读取实际网络与钱包配置。' : '无法获取真实钱包状态。启动本地 API 后刷新，当前不会提交任何操作。'}</span><button class="text-button" data-action="refresh">重新连接</button></div>` : !validConfig() ? `<div class="service-banner" role="alert">${icon('info')}<span>网络或钱包合约配置不完整。已停止付款操作，请检查服务配置。</span></div>` : ''}
        ${state.view === 'settings' ? settingsView() : state.view === 'verification' ? verificationView() : operationsView()}
      </div>
      ${['overview', 'operations'].includes(state.view) ? composer() : ''}
    </main>
    ${state.drawer ? drawer() : ''}
    ${state.ownerReview ? ownerModal() : ''}
    ${state.localWalletConfirm ? localWalletModal() : ''}
    ${state.toast ? `<div class="toast ${state.toastError ? 'error' : 'success'}" role="${state.toastError ? 'alert' : 'status'}">${icon(state.toastError ? 'info' : 'check')}<span>${esc(state.toast)}</span><button class="icon-button" data-action="dismiss-toast" aria-label="关闭通知">${icon('close')}</button></div>` : ''}
  </div>`;
  const content = document.querySelector('.content'); if (content) content.scrollTop = contentScroll;
  const drawerBody = document.querySelector('.drawer-body'); if (drawerBody) drawerBody.scrollTop = drawerScroll;
  if (focusId) { const next = document.getElementById(focusId) as HTMLInputElement | HTMLTextAreaElement | null; next?.focus({ preventScroll: true }); if (selection !== null && selection !== undefined && next && ['text', 'textarea', 'search'].includes(next.type)) { try { next.setSelectionRange(selection, selection); } catch { /* Non-text controls do not have a caret. */ } } }
}

function operationsView(): string {
  const isApproval = state.view === 'approvals';
  const title = isApproval ? '需要你的批准' : state.view === 'overview' ? '钱包总览' : '操作工作台';
  let list = allTasks();
  if (isApproval) list = list.filter(t => column(t) === 'approval');
  if (state.filter === 'active') list = list.filter(t => !['done', 'blocked'].includes(column(t)));
  if (state.filter === 'completed') list = list.filter(t => column(t) === 'done');
  if (state.query) list = list.filter(t => JSON.stringify(t).toLowerCase().includes(state.query.toLowerCase()));
  return `<section class="page-heading"><div><div class="eyebrow">${isApproval ? 'OWNER APPROVAL' : 'WALLET WORKSPACE'}</div><h1>${title}</h1><p>${isApproval ? '逐项核对收款地址与金额，使用 Owner 钱包签名。' : '提出操作，检查预算，在需要时保留你的最终决定。'}</p></div><button class="button subtle" data-action="refresh">${icon('refresh')}刷新状态</button></section>
    ${state.view === 'overview' ? metrics() : ''}
    <section class="operations-section"><div class="section-toolbar"><div class="view-tabs" role="tablist" aria-label="操作筛选">${[['all', isApproval ? '待审批' : '全部操作'], ['active', '进行中'], ['completed', '已完成']].map(([key, label]) => `<button class="view-tab ${state.filter === key ? 'selected' : ''}" data-filter="${key}" role="tab" aria-selected="${state.filter === key}">${label}${key === 'all' ? `<span>${list.length}</span>` : ''}</button>`).join('')}</div><div class="toolbar-right"><label class="search-field">${icon('search')}<input id="task-search" type="search" aria-label="搜索操作" placeholder="搜索操作或地址" value="${esc(state.query)}" /></label><span class="toolbar-pill">${icon('layers')}看板</span></div></div>
    ${isApproval ? `<div class="approval-grid">${list.length ? list.map(t => taskCard(t)).join('') : emptyState('approve', '暂时没有待审批操作', '超过自动额度的请求会在这里等待 Owner。')}</div>` : `<div class="board" data-testid="operations-board">${columns.map(([key, label, color]) => { const tasks = list.filter(t => column(t) === key); return `<section class="board-column ${key}" aria-label="${label}"><div class="column-heading"><span class="column-status ${color}"></span><h2>${label}</h2><span class="column-count">${tasks.length}</span>${key === 'draft' ? `<button class="icon-button" data-action="new-operation" aria-label="新建操作">${icon('plus')}</button>` : `<span class="column-more">···</span>`}</div><div class="column-cards">${tasks.length ? tasks.map(t => taskCard(t)).join('') : `<div class="column-empty">${icon(key === 'done' ? 'check' : key === 'approval' ? 'clock' : 'layers')}<span>${key === 'draft' ? '从下方开始一笔操作' : key === 'approval' ? '无需你处理' : '暂无操作'}</span></div>`}</div></section>`; }).join('')}</div>`}</section>`;
}

function metrics(): string {
  const budget = object(get(state.wallet, 'budget', 'policy.budget'));
  const balance = get(state.wallet, 'walletBalanceWei', 'balanceWei', 'nativeBalanceWei', 'balance.wei');
  const spent = get(budget, 'spentTodayUsd6', 'spentUsd6', 'usedUsd6', 'dailySpentUsd6') ?? get(state.wallet, 'spentUsd6');
  const limit = get(budget, 'dailyLimitUsd6', 'limitUsd6', 'dailyBudgetUsd6') ?? get(state.wallet, 'dailyLimitUsd6');
  const remaining = get(budget, 'remainingUsd6', 'remainingDailyUsd6');
  const oracle = object(get(state.wallet, 'oracle') || state.quote);
  const ratio = spent !== undefined && limit !== undefined && Number(limit) > 0 ? Math.min(100, Math.max(0, Number(spent) / Number(limit) * 100)) : 0;
  return `<section class="metrics" aria-label="实际钱包概况"><article class="metric-card balance-card"><div class="metric-label">${icon('wallet')}钱包余额<span>ETH</span></div><div class="metric-value" data-testid="wallet-balance">${balance !== undefined ? eth(balance) : '—'}<small> ETH</small></div><div class="metric-footer"><span class="mono">${short(walletAddress(), 7)}</span><button class="icon-button small" data-copy="${esc(walletAddress())}" aria-label="复制钱包合约地址">${icon('copy')}</button><span class="live-label">${state.wallet ? '链上余额' : connected() ? '读取中' : '连接后读取'}</span></div></article>
    <article class="metric-card"><div class="metric-label">${icon('activity')}今日美元预算<span>UTC</span></div><div class="metric-value">${spent !== undefined ? usd(spent) : '—'}<small> / ${limit !== undefined ? usd(limit) : '—'}</small></div><div class="budget-track"><span style="width:${ratio}%"></span></div><div class="metric-footer muted">${remaining !== undefined ? `剩余 ${usd(remaining)}` : '按执行时价格累计支出'}<span class="push-right">链上约束</span></div></article>
    <article class="metric-card"><div class="metric-label">${icon('approve')}需要你处理</div><div class="metric-value">${state.wallet ? state.tasks.filter(t => column(t) === 'approval').length : '—'}<small> 笔待审批</small></div><div class="metric-footer muted"><span class="status-dot amber"></span>批准不会绕过硬预算</div></article>
    <article class="metric-card"><div class="metric-label">${icon('verify')}价格状态</div><div class="metric-value metric-text">${get(oracle, 'stale') === true ? '已过期' : get(oracle, 'updatedAt', 'updatedAtSeconds') ? '已读取' : get(state.config, 'readiness.feedFresh') === true ? '预检可用' : '等待数据'}<span class="status-dot ${get(oracle, 'stale') === true ? 'red' : get(oracle, 'updatedAt', 'updatedAtSeconds') ? 'green' : 'neutral'}"></span></div><div class="metric-footer muted">${expectedChain() === 31337 ? '本地 Mock Feed · 非公网行情' : get(oracle, 'updatedAt', 'updatedAtSeconds') ? `更新于 ${dateTime(get(oracle, 'updatedAt', 'updatedAtSeconds'))}` : '执行时重查 Chainlink Feed'}</div></article></section>`;
}

function taskCard(task: Data): string {
  const key = column(task);
  const taskId = id(task);
  return `<button class="task-card" data-task-id="${esc(taskId)}" data-open-task="${esc(taskId)}"><div class="task-card-top"><span class="task-kind">${icon(task._draft ? 'layers' : 'arrow')} ${task._draft ? 'DRAFT' : `AEG-${taskId.slice(-6).toUpperCase()}`}</span><span class="task-menu">···</span></div><h3>${esc(taskName(task))}</h3><div class="task-amount">${taskAmount(task) ? eth(taskAmount(task)) : '待填写'} <span>${taskAmount(task) ? 'ETH' : ''}</span></div><div class="task-recipient mono">${icon('wallet')}${esc(short(taskRecipient(task), 8))}</div>${taskReason(task) ? `<p class="card-reason">${esc(taskReason(task))}</p>` : ''}<div class="task-card-bottom"><span class="task-status ${key}"><span class="status-dot ${columns.find(c => c[0] === key)![2]}"></span>${statusLabel(task)}</span><span>${dateTime(get(task, 'updatedAt', 'createdAt'))}</span></div></button>`;
}

function composer(): string {
  const missing = get(state.draft, 'missingFields');
  return `<section class="composer-wrap" aria-label="新建钱包操作"><div class="composer"><div class="composer-top"><span class="composer-symbol">${icon('shield')}</span><span>让 Aegis 帮你发起操作</span><div class="composer-tabs"><button class="${state.composerMode === 'natural' ? 'active' : ''}" data-composer="natural">自然语言</button><button class="${state.composerMode === 'manual' ? 'active' : ''}" data-composer="manual">填写金额与地址</button></div></div>
    ${state.composerMode === 'natural' ? `<textarea id="intent-message" data-testid="intent-message" rows="2" placeholder="例如：向 0x… 转 0.001 ETH，用于支付服务费用" aria-label="描述你的付款意图" ${disabled() ? 'disabled' : ''}>${esc(state.message)}</textarea>` : `<div class="manual-fields"><label>收款地址<input id="recipient" data-testid="recipient-input" class="mono" autocomplete="off" spellcheck="false" placeholder="0x…" value="${esc(state.recipient)}" ${disabled() ? 'disabled' : ''} /></label><label class="amount-field">金额 · ETH<input id="amount" data-testid="amount-input" inputmode="decimal" autocomplete="off" placeholder="0.001" value="${esc(state.amount)}" ${disabled() ? 'disabled' : ''} /></label><label>用途<input id="purpose" placeholder="这笔付款用于什么？" value="${esc(state.purpose)}" ${disabled() ? 'disabled' : ''} /></label></div>`}
    ${Array.isArray(missing) && missing.length ? `<div class="missing-note">${icon('info')}还需要补充：${missing.map(item => esc(({ recipient: '收款地址', amountWei: 'ETH 金额', amount: 'ETH 金额', purpose: '用途' } as Record<string, string>)[String(item)] || item)).join('、')}。请填写后重新预览。</div>` : ''}
    <div class="composer-bottom"><div class="composer-hint">${icon('verify')}<span>${!connected() ? '连接钱包后开始 · 签名登录不发送交易' : '先预览，再确认提交；只支持原生 ETH'}</span></div>${state.composerMode === 'manual' && exampleRecipient() ? `<button class="text-button example-button" data-action="fill-example">填入测试收款地址</button>` : ''}<button class="send-button" data-action="send-intent" data-testid="send-intent" ${disabled() ? 'disabled' : ''} aria-label="预览操作">${state.busy === 'intent' ? '<span class="spinner"></span>' : icon('up')}<span>${state.busy === 'intent' ? '处理中' : '预览'}</span></button></div></div><div class="composer-disclaimer">${expectedChain() === 31337 ? 'Local 本地链 · Mock Feed · 仅限开发资产' : '测试环境 · 金额、地址与规则以最终预览为准'} · ${get(state.config, 'planner.llmEnabled') === false ? '自然语言使用规则解析，未调用大模型' : '意图解析结果需你确认'}</div></section>`;
}

function exampleRecipient(): string { return value(state.config, 'recipientAddress', 'addresses.recipient', 'exampleRecipient', 'demoRecipient', 'examples.recipient', 'examples.allowedRecipient', 'demo.recipient'); }
function emptyState(symbol: string, title: string, description: string): string { return `<div class="empty-state">${icon(symbol)}<h3>${title}</h3><p>${description}</p></div>`; }

function settingsView(): string {
  const labels: Record<string, [string, string]> = { account: ['wallet', '钱包与账户'], policy: ['shield', '授权与预算'], network: ['layers', '网络与合约'], developer: ['activity', '开发环境'] };
  return `<div class="settings-layout"><aside class="settings-nav"><h1>设置</h1><p>查看当前环境和授权配置</p>${Object.entries(labels).map(([key, [symbol, text]]) => `<button class="${state.settingsTab === key ? 'active' : ''}" data-settings="${key}">${icon(symbol)}${text}${icon('chevron')}</button>`).join('')}<div class="settings-help">这里展示服务的实际配置。<br/>更改链上规则需要单独授权。</div></aside><section class="settings-panel"><div class="eyebrow">WORKSPACE SETTINGS</div><h2>${labels[state.settingsTab][1]}<span class="toolbar-pill">只读</span></h2>${settingsBody()}</section></div>`;
}
function row(label: string, content: unknown, hint = '', mono = false): string { return `<div class="setting-row"><div><strong>${label}</strong>${hint ? `<p>${hint}</p>` : ''}</div><div class="setting-value ${mono ? 'mono' : ''}">${esc(content || '尚未获取')}${mono && content ? `<button class="icon-button small" data-copy="${esc(content)}" aria-label="复制${label}">${icon('copy')}</button>` : ''}</div></div>`; }
function settingsBody(): string {
  if (state.settingsTab === 'account') return `<div class="settings-card"><div class="account-profile"><span class="large-avatar">${icon('shield')}</span><div><h3>Aegis 钱包</h3><p>原生 ETH · 受策略约束的操作</p></div><span class="badge ${connected() ? 'green' : ''}">${connected() ? '已签名登录' : '未登录'}</span></div>${row('当前连接账户', state.address, '用于登录与 Owner 审批签名', true)}${row('钱包合约', walletAddress(), '资产保存在合约中，账户签名不会转移 Owner 密钥', true)}${row('Owner 地址', value(state.wallet, 'ownerAddress', 'owner') || value(state.config, 'ownerAddress', 'owner', 'addresses.owner'), '只有 Owner 可以批准待审批付款', true)}</div><button class="button subtle danger-text" data-action="disconnect" ${!connected() ? 'disabled' : ''}>${icon('logout')}断开本次会话</button>`;
  if (state.settingsTab === 'policy') { const policy = get(state.wallet, 'policy') || get(state.wallet, 'budget') || get(state.config, 'policy'); const p = object(policy); return `<div class="settings-card">${row('策略版本', value(p, 'policyVersion', 'version') || value(state.wallet, 'policyVersion'))}${row('自动执行上限', get(p, 'autoThresholdUsd6', 'autoLimitUsd6', 'autoApproveLimitUsd6') !== undefined ? usd(get(p, 'autoThresholdUsd6', 'autoLimitUsd6', 'autoApproveLimitUsd6')) : '', '超过自动上限需要 Owner 审批')}${row('单次硬上限', get(p, 'hardPerTxUsd6', 'perTxLimitUsd6', 'singleLimitUsd6') !== undefined ? usd(get(p, 'hardPerTxUsd6', 'perTxLimitUsd6', 'singleLimitUsd6')) : '', 'Owner 批准也不能绕过硬上限')}${row('每日硬预算', get(p, 'dailyLimitUsd6', 'dailyBudgetUsd6') !== undefined ? usd(get(p, 'dailyLimitUsd6', 'dailyBudgetUsd6')) : '', '执行时按真实价格累计')}${row('冻结状态', get(p, 'paused', 'frozen') === true ? '已冻结' : get(p, 'paused', 'frozen') === false ? '未冻结' : '', '执行与审批时都重新检查')}</div><p class="settings-caption">白名单、预算、策略版本和冻结状态最终由合约校验。这里不会伪造或本地覆盖链上权限。</p>`; }
  if (state.settingsTab === 'network') return `<div class="settings-card">${row('网络', mode())}${row('Chain ID', String(expectedChain() || ''))}${row('钱包合约', walletAddress(), '', true)}${row('Access Control', value(state.config, 'aclAddress', 'addresses.acl', 'contracts.acl'), '', true)}${row('存证合约', value(state.config, 'attestationAddress', 'addresses.attestation', 'contracts.attestation'), '', true)}${row('Chainlink Feed', value(state.config, 'feedAddress', 'addresses.feed', 'oracle.feedAddress'), '价格的新鲜度和精度由服务读取', true)}${row('RPC', value(state.config, 'rpcUrl', 'chain.rpcUrl'), '浏览器签名前必须与任务 Chain ID 一致')}</div>`;
  return `<div class="settings-card">${row('运行模式', mode(), expectedChain() === 31337 ? 'Local 仅为本机开发链，不能用于公网资金' : '当前不是本地链')}${row('API 状态', state.online ? '已连接 · /api/v1' : '离线')}${row('前端连接', '浏览器 EIP-1193 钱包', '连接后先签名登录；Owner 交易由浏览器钱包单独签名')}${row('验证方式', '链上回执与记录对照', '本地计算一致不等于付款成功')}</div><div class="info-panel">${icon('info')}<p>历史静态演示位于 <code>legacy-demo.html</code>，其中数据为模拟，不能用于本界面的操作或验证。</p></div>`;
}

function verificationView(): string {
  const tasks = state.tasks.filter(t => ['done', 'approval', 'blocked'].includes(column(t)));
  return `<section class="page-heading"><div><div class="eyebrow">VERIFIABLE ACTIVITY</div><h1>验证每一笔结果</h1><p>对照任务、真实交易回执与存证记录。尚未取得的证据会明确标记。</p></div><button class="button subtle" data-action="refresh">${icon('refresh')}刷新记录</button></section><div class="verification-callout">${icon('verify')}<div><strong>证据来自服务与链上查询</strong><p>一次本地哈希重算无法单独证明付款成功。打开记录查看网络、金额、回执与验证结果。</p></div></div><div class="activity-list">${tasks.length ? tasks.map(t => `<button class="activity-row" data-open-task="${esc(id(t))}" data-task-id="${esc(id(t))}"><span class="activity-symbol ${column(t)}">${icon(column(t) === 'done' ? 'check' : column(t) === 'approval' ? 'clock' : 'info')}</span><div><strong>${esc(taskName(t))}</strong><p class="mono">${esc(id(t))}</p></div><span class="activity-amount">${eth(taskAmount(t))} ETH</span><span class="task-status ${column(t)}">${statusLabel(t)}</span>${icon('chevron')}</button>`).join('') : emptyState('verify', '还没有可验证的操作', '完成一笔真实测试交易后，在这里查看回执与存证。')}</div>`;
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
  return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" aria-label="操作详情" role="dialog" aria-modal="true"><div class="drawer-header"><span>${icon(isDraft ? 'layers' : 'activity')} ${isDraft ? '确认操作' : '操作详情'}</span><button class="icon-button" data-action="close-drawer" aria-label="关闭详情">${icon('close')}</button></div><div class="drawer-body"><div class="drawer-title"><div class="eyebrow">${isDraft ? 'REVIEW BEFORE SUBMIT' : `AEG-${esc(taskId.slice(-6).toUpperCase())}`}</div><h2>${esc(taskName(task))}</h2><span class="badge ${c}">${isDraft && !quote ? '等待预览' : statusLabel({ status: s })}</span></div><div class="transfer-hero"><span>付款金额</span><strong>${eth(taskAmount(task))}<small> ETH</small></strong>${get(quote, 'costUsd6') !== undefined ? `<span>预计 ${usd(get(quote, 'costUsd6'))} · 执行时重新计价</span>` : ''}</div><div class="detail-section"><h3>付款信息</h3>${detailRow('收款地址', taskRecipient(task), true)}${detailRow('所在网络', `${mode()} · Chain ${expectedChain() || '—'}`)}${detailRow('钱包合约', walletAddress(), true)}${detailRow('任务 ID', taskId, true)}${detailRow('策略版本', value(quote, 'policyVersion') || value(task, 'policyVersion'))}</div>
    ${quote && Object.keys(quote).length ? `<div class="detail-section"><h3>规则预检</h3>${detailRow('状态', s === 'READY' ? '已通过预检，提交时仍会重新检查' : value(quote, 'reason', 'message', 'blockReason') || reasons(quote) || s)}${detailRow('美元最高成本', get(quote, 'maxUsdCost6') !== undefined ? usd(get(quote, 'maxUsdCost6')) : '')}${detailRow('报价有效至', dateTime(get(quote, 'quoteExpiresAtSeconds', 'expiresAt')))}${detailRow('授权路径', get(quote, 'requiresApproval') === true || /APPROVAL/.test(value(quote, 'decision', 'path')) ? '需要 Owner 审批' : value(quote, 'decision', 'path') || '以提交后链上结果为准')}</div>` : ''}
    ${taskReason(task) ? `<div class="info-panel error-panel">${icon('info')}<p>${esc(taskReason(task))}</p></div>` : ''}
    ${transactions.length ? `<div class="detail-section"><h3>交易记录</h3>${transactions.map(tx => { const hash = value(tx, 'txHash', 'hash', 'transactionHash'); const link = explorer(hash); return `<div class="transaction-item"><div><span>${esc(value(tx, 'action', 'kind', 'type') || '链上交易')}</span><span>${esc(value(tx, 'status') || '待核对')}</span></div>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="mono">${esc(short(hash, 12))}${icon('external')}</a>` : `<span class="mono">${esc(hash || '尚未取得交易哈希')}</span>`}</div>`; }).join('')}</div>` : ''}
    ${!isDraft ? `<div class="detail-section"><div class="section-title-row"><h3>结果验证</h3><button class="text-button" data-action="load-evidence">${icon('refresh')}重新核验</button></div>${evidenceView()}</div>` : `<div class="review-note">${icon('info')}<p>请核对完整地址与金额。确认后由服务发起链上请求；若需要审批，Owner 仍需在钱包中签名。</p></div>`}</div>
    <div class="drawer-footer">${drawerActions(task, isDraft, quote, c)}</div></aside>`;
}
function drawerActions(task: Data, isDraft: boolean, quote: Data | null, c: Column): string {
  if (isDraft) return `<button class="button subtle" data-action="edit-draft">返回修改</button><button class="button primary" data-action="confirm-transfer" data-testid="confirm-transfer" ${disabled() || !quote || value(quote, 'status') !== 'READY' ? 'disabled' : ''}>${state.busy === 'submit' ? '<span class="spinner"></span>提交中…' : `${icon('arrow')}确认并提交`}</button>`;
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
  const review = state.ownerReview!;
  return `<div class="modal-backdrop"><section class="owner-modal" role="dialog" aria-modal="true" aria-labelledby="owner-review-title"><div class="modal-symbol">${icon('shield')}</div><h2 id="owner-review-title">${review.action === 'approve' ? '确认 Owner 批准' : '确认取消这笔请求'}</h2><p>${review.action === 'approve' ? '此签名将批准并执行付款。请再次核对收款地址和金额。' : '此签名将取消链上的待审批请求。'}</p><div class="modal-details">${detailRow('金额', `${eth(taskAmount(review.task))} ETH`)}${detailRow('收款地址', taskRecipient(review.task), true)}${detailRow('网络', `${mode()} · Chain ${expectedChain()}`)}${detailRow('签名账户', value(review.tx, 'from'), true)}${detailRow('目标合约', value(review.tx, 'to'), true)}</div><div class="review-note">${icon('verify')}<p>已核对合约、方法与待审批记录 ID。钱包打开后，请继续检查交易详情。</p></div><div class="modal-actions"><button class="button subtle" data-action="dismiss-owner">返回</button><button class="button primary" data-action="sign-owner" data-testid="sign-owner-transaction" ${state.busy ? 'disabled' : ''}>${icon('wallet')}${state.busy ? '等待钱包…' : review.action === 'approve' ? '打开钱包批准' : '打开钱包取消'}</button></div></section></div>`;
}
function localWalletModal(): string {
  return `<div class="modal-backdrop"><section class="owner-modal" role="dialog" aria-modal="true" aria-labelledby="local-wallet-title"><div class="modal-symbol">${icon('wallet')}</div><h2 id="local-wallet-title">使用本地测试钱包</h2><p>使用本机节点已解锁的公开开发 Owner 账户。仅限 Chain 31337，测试 ETH 没有真实价值。此入口不会读取或保存私钥，也不能用于 Sepolia 或公网资金。</p><div class="modal-details">${detailRow('网络', 'Local · 真实本地链')}${detailRow('价格', '本地 Mock Feed，非公网 Chainlink 行情')}${detailRow('公开开发账户', value(state.config, 'ownerAddress'), true)}${detailRow('RPC', value(state.config, 'rpcUrl'))}</div><div class="modal-actions"><button class="button subtle" data-action="dismiss-local-wallet">返回</button><button class="button primary" data-action="confirm-local-wallet" data-testid="confirm-local-wallet" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在签名登录…' : '确认使用公开开发账户'}</button></div></section></div>`;
}

async function refresh(initial = false) {
  try {
    if (!state.config || initial || !validConfig()) {
      state.config = await api('/config');
      state.chainId = expectedChain();
    }
    state.online = true;
    if (hasSession()) {
      const results = await Promise.allSettled([api('/wallets/current'), api<unknown>('/tasks')]);
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === 'fulfilled') {
          if (index === 0) state.wallet = object(result.value);
          else { const response = result.value; const list = Array.isArray(response) ? response : get(response, 'tasks', 'items'); if (Array.isArray(list)) state.tasks = list as Data[]; }
        } else if (result.reason instanceof ApiError && result.reason.status === 401) { state.address = ''; state.wallet = null; state.tasks = []; state.ownerReview = null; state.drawer = ''; sessionStorage.removeItem('aegis.address'); }
        else if (result.reason instanceof ApiError && result.reason.status === 0) state.online = false;
      }
      if (state.drawer && state.drawer !== 'draft') { try { state.detail = await api(`/tasks/${encodeURIComponent(state.drawer)}`); } catch { /* Retain the last server response while the network recovers. */ } }
    }
  } catch (error) { state.online = false; if (!initial && state.busy) throw error; }
  finally { state.initialLoading = false; render(); }
}

async function run(name: string, operation: () => Promise<void>) {
  if (state.busy) return;
  state.busy = name; render();
  try { await operation(); }
  catch (error) { notify(errorMessage(error), true); }
  finally { state.busy = ''; render(); }
}

async function createIntent() {
  if (disabled()) return;
  await run('intent', async () => {
    let body: Data;
    if (state.composerMode === 'natural') {
      if (!state.message.trim()) throw new Error('先写下你的操作意图。');
      body = { message: state.message.trim() };
    } else {
      if (!isAddress(state.recipient)) throw new Error('请输入完整、有效的收款地址。');
      if (!/^\d+(\.\d{1,18})?$/.test(state.amount) || parseEther(state.amount) <= 0n) throw new Error('请输入大于零的 ETH 金额，最多保留 18 位小数。');
      body = { recipient: state.recipient, amountWei: parseEther(state.amount).toString(), purpose: state.purpose.trim() || '原生 ETH 付款' };
    }
    const draftId = state.composerMode === 'manual' && state.draft ? id(state.draft) : '';
    const draft = draftId ? await api(`/intents/${encodeURIComponent(draftId)}`, 'PATCH', { ...body, expectedRevision: get(state.draft, 'revision', 'version', 'draftVersion') }) : await api('/intents', 'POST', body);
    state.draft = draft; state.quote = null;
    state.recipient = taskRecipient(draft);
    state.amount = taskAmount(draft) ? formatEther(BigInt(taskAmount(draft))) : '';
    state.purpose = value(draft, 'purpose');
    const missing = get(draft, 'missingFields');
    if (Array.isArray(missing) && missing.length) { state.composerMode = 'manual'; notify('已整理意图，请补齐金额和收款地址。'); return; }
    if (!taskRecipient(draft) || !taskAmount(draft)) { state.composerMode = 'manual'; notify('请补齐收款地址与 ETH 金额，再预览操作。'); return; }
    state.quote = await api(`/intents/${encodeURIComponent(id(draft))}/preview`, 'POST', { expectedRevision: get(draft, 'revision', 'version', 'draftVersion') });
    state.drawer = 'draft';
    if (value(state.quote, 'status') === 'BLOCKED') notify(value(state.quote, 'message', 'reason', 'blockReason') || reasons(state.quote) || '这笔操作未通过规则检查，尚未发起付款。', true);
  });
}

async function submitIntent() {
  if (!state.draft || !state.quote || disabled()) return;
  await run('submit', async () => {
    const result = await api(`/intents/${encodeURIComponent(id(state.draft!))}/submit`, 'POST', { expectedRevision: get(state.draft, 'revision', 'version', 'draftVersion'), quoteId: get(state.quote, 'quoteId', 'id') });
    const taskId = value(result, 'taskId', 'id');
    if (!taskId) throw new Error('服务没有返回任务 ID。请查看操作列表，不要重复提交。');
    state.draft = null; state.quote = null; state.message = ''; state.recipient = ''; state.amount = ''; state.purpose = '';
    state.drawer = taskId; state.detail = result; state.evidence = null;
    await refresh();
    notify('已提交请求，正在核对链上结果。');
    void loadEvidence();
  });
}

async function openTask(taskId: string) {
  if (state.draft && id(state.draft) === taskId) { state.drawer = 'draft'; render(); return; }
  state.drawer = taskId; state.detail = state.tasks.find(t => id(t) === taskId) || null; state.evidence = null; state.evidenceError = ''; render();
  try { state.detail = await api(`/tasks/${encodeURIComponent(taskId)}`); render(); await loadEvidence(); }
  catch (error) { notify(errorMessage(error), true); }
}

async function loadEvidence() {
  const taskId = state.drawer;
  if (!taskId || taskId === 'draft' || state.evidenceLoading) return;
  state.evidenceLoading = true; state.evidenceError = ''; render();
  try { const response = await api(`/tasks/${encodeURIComponent(taskId)}/evidence`); if (state.drawer === taskId) state.evidence = response; }
  catch (error) { if (state.drawer === taskId) state.evidenceError = errorMessage(error); }
  finally { state.evidenceLoading = false; render(); }
}

const ownerAbi = parseAbi(['function approveAndExecute(uint64 attestationId)', 'function cancelPending(uint64 attestationId)']);

async function reviewOwner(action: 'approve' | 'cancel') {
  if (!state.detail || disabled()) return;
  if (pendingBroadcast(state.drawer)) { notify('这笔任务已有已广播交易，请先核对原交易，不要重复签名。', true); return; }
  await run('owner-review', async () => {
    const task = await api(`/tasks/${encodeURIComponent(state.drawer)}`);
    const tx = await api(`/tasks/${encodeURIComponent(state.drawer)}/owner-tx?action=${action}`);
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
  if (!state.ownerReview) return;
  await run('owner-sign', async () => {
    const review = state.ownerReview!;
    const hash = await sendOwnerTransaction(review.tx, state.address, state.walletKind === 'local' && state.config ? state.config : undefined);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('钱包未返回有效交易哈希。请先在钱包中核对，不要重复签名。');
    sessionStorage.setItem(broadcastKey(id(review.task)), JSON.stringify({ txHash: hash, action: review.action }));
    state.ownerReview = null;
    try { await api(`/tasks/${encodeURIComponent(id(review.task))}/observed-tx`, 'POST', { txHash: hash, action: review.action }); }
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
    await api(`/tasks/${encodeURIComponent(state.drawer)}/observed-tx`, 'POST', pending);
    sessionStorage.removeItem(broadcastKey(state.drawer));
    await refresh(); await loadEvidence();
    notify('已核对原交易结果。');
  });
}

app.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  const fields: Record<string, 'message' | 'recipient' | 'amount' | 'purpose' | 'query'> = { 'intent-message': 'message', recipient: 'recipient', amount: 'amount', purpose: 'purpose', 'task-search': 'query' };
  if (fields[input.id]) { state[fields[input.id]] = input.value; if (input.id === 'task-search') render(); }
});
app.addEventListener('keydown', event => { if (event.key === 'Escape' && !state.busy) { state.ownerReview = null; state.localWalletConfirm = false; state.drawer = ''; render(); } if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && (event.target as HTMLElement).id === 'intent-message') { event.preventDefault(); void createIntent(); } });
app.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('button, [data-action]');
  if (!button || button.hasAttribute('disabled')) return;
  if (button.dataset.nav) { state.view = button.dataset.nav as View; state.filter = 'all'; state.drawer = ''; render(); return; }
  if (button.dataset.settings) { state.settingsTab = button.dataset.settings; render(); return; }
  if (button.dataset.filter) { state.filter = button.dataset.filter; render(); return; }
  if (button.dataset.composer) { state.composerMode = button.dataset.composer; render(); return; }
  if (button.dataset.openTask) { void openTask(button.dataset.openTask); return; }
  if (button.dataset.copy) { void navigator.clipboard.writeText(button.dataset.copy).then(() => notify('已复制')).catch(() => notify('无法访问剪贴板，请手动复制。', true)); return; }
  switch (button.dataset.action) {
    case 'refresh': void refresh(true); break;
    case 'connect': void run('connect', async () => { if (connected()) { state.view = 'settings'; state.settingsTab = 'account'; return; } if (!validConfig()) throw new Error('服务尚未提供有效钱包配置。'); const session = await connectWallet(expectedChain()); state.address = session.address; state.chainId = session.chainId; state.walletKind = 'browser'; sessionStorage.setItem('aegis.wallet-kind', 'browser'); sessionStorage.setItem('aegis.address', session.address); registerWalletListeners(); await refresh(); notify('钱包已连接，签名登录成功。'); }); break;
    case 'local-wallet': state.localWalletConfirm = true; render(); break;
    case 'dismiss-local-wallet': if (!state.busy) { state.localWalletConfirm = false; render(); } break;
    case 'confirm-local-wallet': void run('connect', async () => { if (!validConfig() || !localWalletAvailable(state.config)) throw new Error('当前环境不允许本地测试钱包。'); const session = await connectWallet(31337, state.config!); state.address = session.address; state.chainId = session.chainId; state.walletKind = 'local'; sessionStorage.setItem('aegis.wallet-kind', 'local'); sessionStorage.setItem('aegis.address', session.address); state.localWalletConfirm = false; await refresh(); notify('已登录本地公开开发账户，仅用于 Local 测试。'); }); break;
    case 'disconnect': setToken(''); disconnectProvider(); sessionStorage.removeItem('aegis.address'); sessionStorage.removeItem('aegis.wallet-kind'); state.walletKind = ''; state.address = ''; state.wallet = null; state.tasks = []; state.drawer = ''; notify('本次会话已断开。'); break;
    case 'send-intent': void createIntent(); break;
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
    case 'dismiss-toast': state.toast = ''; render(); break;
  }
});

function invalidateWallet() { setToken(''); disconnectProvider(); sessionStorage.removeItem('aegis.address'); sessionStorage.removeItem('aegis.wallet-kind'); state.walletKind = ''; state.address = ''; state.wallet = null; state.tasks = []; state.ownerReview = null; state.drawer = ''; notify('钱包账户或网络已变更，请重新连接并签名登录。', true); }
let observedProvider: unknown;
function registerWalletListeners() { if (window.ethereum && window.ethereum !== observedProvider) { window.ethereum.on?.('accountsChanged', invalidateWallet); window.ethereum.on?.('chainChanged', invalidateWallet); observedProvider = window.ethereum; } }
registerWalletListeners();
render();
void refresh(true);
window.setInterval(() => { if (!document.hidden && !state.busy) void refresh(); }, 5000);
