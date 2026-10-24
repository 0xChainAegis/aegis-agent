import { formatEther, formatUnits, parseEther, parseUnits } from 'viem';
import { z } from 'zod';
import { FiniteSubscriptionFormSchema } from './schemas';
import { subscriptionListSchema, subscriptionPreviewSchema, subscriptionControlPreviewSchema, subscriptionPolicyPreviewSchema, subscriptionPolicySchema, validateSubscriptionPolicyTransaction, validateSubscriptionTransaction } from './subscriptions';
import { ApiError, type Data } from './api';

type Action = 'configure' | 'create' | 'pause' | 'resume' | 'cancel';
type Review = { action: Action; preview: Data; expected: Data; txHash?: string };
const storedReviewSchema=z.object({action:z.enum(['configure','create','pause','resume','cancel']),preview:z.record(z.string(),z.unknown()),expected:z.record(z.string(),z.unknown()),txHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict();
type Hooks = {
  api: (path: string, method?: string, body?: Data) => Promise<Data>;
  config: () => Data | null;
  disabled: () => boolean;
  controlDisabled: () => boolean;
  render: () => void;
  sign: (tx: Data) => Promise<string>;
  payment: (draft: Data, quote: Data) => void;
};
const htmlEntities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => htmlEntities[character] ?? character);
const row = (label: string, value: unknown) => `<div class="detail-row"><span>${label}</span><div class="mono break-all">${esc(value)}</div></div>`;
const labels: Record<string, string> = { ACTIVE: '有效', PAUSED: '已暂停', CANCELLED: '已取消', EXPIRED: '已到期', COMPLETED: '次数已用尽', NOT_STARTED: '尚未开始' };
const utc = (seconds: unknown) => new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
export function createSubscriptionPanel(hooks: Hooks) {
  const form = { recipient: '', amount: '', periodSeconds: '', startAt: '', endAt: '', maxPayments: '', periodCap: '', purpose: '' };
  let records: Data[] = [];
  let error = '';
  let loaded = false;
  let review: Review | null = null;
  let policy:Data|null=null;
  const demoPolicy={maxPeriodCapUsd6:'10000000',maxDurationSeconds:'2592000',maxPayments:'30'};
  const enabled = () => ['local_chain','testnet'].includes(String(hooks.config()?.mode)) && [31337,11155111].includes(Number(hooks.config()?.chainId)) && (hooks.config()?.capabilities as Data | undefined)?.subscriptions === true;
  const configured=()=>policy?.configured===true;
  const key = () => `aegis.subscription-owner.${hooks.config()?.chainId}.${hooks.config()?.walletAddress}.${hooks.config()?.ownerAddress}`;
  function storeReview() { try { if (review?.txHash) sessionStorage.setItem(key(), JSON.stringify(review)); else sessionStorage.removeItem(key()); } catch { /* In-memory original hash remains available. */ } }
  function restoreReview() {
    if (review) return;
    try {
      const parsed = storedReviewSchema.parse(JSON.parse(sessionStorage.getItem(key()) || 'null'));
      if (parsed) {
        if(parsed.action==='configure')validateSubscriptionPolicyTransaction(hooks.config(),parsed.preview,parsed.expected);
        else validateSubscriptionTransaction(hooks.config(), parsed.preview, parsed.expected, parsed.action);
        review = parsed;
      }
    } catch { /* Untrusted persisted payload never triggers a transaction. */ }
  }
  async function refresh() {
    if (!enabled()) { records = []; loaded = false; review = null; return; }
    restoreReview();
    try { const result=subscriptionListSchema.parse(await hooks.api('/subscriptions'));records=result.subscriptions;policy=subscriptionPolicySchema.parse(result.policy??hooks.config()?.subscriptionPolicy);error = ''; loaded = true; }
    catch (cause) { records = []; error = cause instanceof Error ? cause.message : '无法读取链上订阅'; }
  }
  function render() {
    if (!enabled()) return '<div class="info-panel">当前部署不支持有限订阅。</div>';
    const blocked = hooks.disabled() || Boolean(review?.txHash);
    const controlBlocked = hooks.controlDisabled() || Boolean(review?.txHash);
    const fields: [keyof typeof form, string, string][] = [
      ['recipient', '固定收款地址', '0x…'], ['amount', '每期固定金额 · ETH', '例如 0.001'],
      ['periodSeconds', '固定周期 · 秒', '不自动换算日历月'], ['startAt', '开始 · UTC Unix 秒', '明确填写 UTC 秒'],
      ['endAt', '结束 · UTC Unix 秒（不含）', '必须晚于开始'], ['maxPayments', '最多成功付款次数', '有限正整数'],
      ['periodCap', '每期本金硬上限 · USD', '最多 6 位小数'],
    ];
    const network=hooks.config()?.mode==='testnet'?'Ethereum Sepolia':'Local 31337';
    if(!configured())return `<section class="page-heading"><div><h1>有限 ETH 订阅</h1><p>${network} · 每期重新预览并人工确认。</p></div><button class="button subtle" data-action="refresh">刷新链上状态</button></section><section class="settings-card" data-testid="subscription-policy-setup"><h2>先启用有限订阅</h2><p>当前链上订阅上限尚未配置。Owner 需要先签一笔策略交易；这不会付款，也不会授权自动扣款。</p>${row('单期本金上限','$10.00')}${row('最长计划期限','30 天')}${row('最多成功次数','30 次')}<button class="button primary" data-action="subscription-configure" data-testid="subscription-configure" ${blocked?'disabled':''}>预览启用策略</button></section>${error?`<div class="info-panel error-panel" role="alert">${esc(error)}</div>`:''}${review?modal(review):''}`;
    return `<section class="page-heading"><div><h1>有限 ETH 订阅</h1><p>${network} · 每期重新预览、人工确认；没有自动扣款授权。</p></div><button class="button subtle" data-action="refresh">刷新链上状态</button></section>
      <section class="subscription-editor settings-card" data-testid="subscription-form"><h2>登记有限计划</h2><div class="subscription-fields">${fields.map(([name, label, placeholder]) => `<label>${label}<input id="subscription-${name}" data-subscription-field="${name}" data-testid="subscription-${name}" value="${esc(form[name])}" placeholder="${placeholder}" autocomplete="off" ${blocked ? 'disabled' : ''}></label>`).join('')}</div><p class="settings-caption">开始和结束均按 UTC Unix 秒登记，不推断“立即开始”或“每月”。结束时间和最大次数都必须填写。漏期跳过、不追补；暂停不顺延。周期/每日预算只计 ETH 本金，不包含执行账户另付的 Gas。</p><button class="button primary" data-action="subscription-preview" data-testid="subscription-preview" ${blocked ? 'disabled' : ''}>预览 Owner 登记</button></section>
      ${error ? `<div class="info-panel error-panel" role="alert" data-testid="subscription-error">${esc(error)}</div>` : ''}
      <section class="subscription-list" data-testid="subscription-list"><h2>链上有限计划</h2>${records.length ? records.map(record => {
        const id = String(record.subscriptionId);
        const active = record.status === 'ACTIVE';
        return `<article class="settings-card subscription-record" data-testid="subscription-record-${esc(id)}" data-status="${esc(record.status)}"><div class="section-title-row"><h3>订阅 #${esc(id)}</h3><span class="badge">${labels[String(record.status)]}</span></div>${row('固定收款地址', record.recipient)}${row('每期 ETH', formatEther(BigInt(String(record.amountWei))))}${row('周期 / 单期本金硬上限', `${record.periodSeconds} 秒 / $${formatUnits(BigInt(String(record.periodCapUsd6)), 6)}`)}${row('开始 / 结束（不含）', `${utc(record.startAtSeconds)} / ${utc(record.endAtSeconds)}`)}${row('已成功 / 最多次数', `${record.paidCount} / ${record.maxPayments}`)}${row('当期索引 / 父计划哈希', `${record.currentOccurrenceIndex ?? '—'} / ${record.parentPlanHash}`)}<div class="subscription-actions"><button class="button primary" data-action="subscription-pay" data-subscription-id="${esc(id)}" ${blocked || !active || record.currentOccurrenceIndex === null ? 'disabled' : ''}>预览本期付款</button><button class="button subtle" data-action="subscription-${record.paused ? 'resume' : 'pause'}" data-subscription-id="${esc(id)}" ${controlBlocked || !['ACTIVE', 'PAUSED', 'NOT_STARTED'].includes(String(record.status)) ? 'disabled' : ''}>${record.paused ? '恢复计划' : '暂停计划'}</button><button class="button subtle danger-text" data-action="subscription-cancel" data-subscription-id="${esc(id)}" ${controlBlocked || record.cancelled || ['EXPIRED', 'COMPLETED'].includes(String(record.status)) ? 'disabled' : ''}>取消计划</button></div></article>`;
      }).join('') : `<p class="settings-caption">${loaded ? '没有已登记计划。预览不会登记，也不会付款。' : '正在读取真实链上计划…'}</p>`}</section>${review ? modal(review) : ''}`;
  }
  function modal(item: Review) {
    const configuring=item.action==='configure';
    const creating = item.action === 'create';
    const title = configuring?'确认启用有限订阅策略':creating ? '确认 Owner 登记有限计划' : item.action === 'cancel' ? '确认不可逆取消计划' : item.action === 'pause' ? '确认暂停计划' : '确认恢复有限计划';
    const plan = item.expected;
    const detail=configuring?row('单期本金上限','$10.00')+row('最长计划期限','30 天')+row('最多成功次数','30 次'):creating ? row('收款地址', plan.recipient) + row('每期固定 ETH', formatEther(BigInt(String(plan.amountWei)))) + row('周期 / 本金硬上限', `${plan.periodSeconds} 秒 / $${formatUnits(BigInt(String(plan.periodCapUsd6)), 6)}`) + row('开始 UTC', utc(plan.startAtSeconds)) + row('结束 UTC（不含）', utc(plan.endAtSeconds)) + row('最大成功次数', plan.maxPayments) + row('父计划哈希', item.preview.planHash) : row('订阅 ID', plan.subscriptionId);
    return `<div class="modal-backdrop"><section class="owner-modal subscription-review" role="dialog" aria-modal="true" aria-label="${title}"><h2>${title}</h2><p>${configuring?'这只设置链上硬上限，不会登记计划或付款。':creating ? '登记只保存有限配置，不付款、不预留预算、不授权后台自动扣款。每次付款仍需当期新预览和你的确认。' : item.action === 'cancel' ? '取消先上链后，后续付款将被拒绝。无法撤回已经执行或先于取消上链的付款。取消后不可恢复。' : '暂停不顺延日期，恢复不会追补漏期。控制交易不消耗付款预算。'}</p><div class="modal-details">${detail}${row('网络',String(hooks.config()?.mode==='testnet'?'Ethereum Sepolia':'Local 31337'))}${row('Owner / 合约', `${hooks.config()?.ownerAddress} / ${hooks.config()?.walletAddress}`)}${item.txHash ? row('已广播原交易', item.txHash) : ''}</div><p class="settings-caption">ETH 本金美元预算不包含执行账户另付的 Gas。${item.txHash ? '结果尚待核对，不要再次签名；只查询原交易。' : '请核对以上完整配置，然后主动打开 Owner 钱包签名。'}</p><div class="modal-actions">${item.txHash ? '' : '<button class="button subtle" data-action="subscription-dismiss">返回修改</button>'}<button class="button primary" data-action="subscription-sign" data-testid="subscription-sign" ${(item.action === 'create' ? hooks.disabled() : hooks.controlDisabled()) ? 'disabled' : ''}>${item.txHash ? '核对原交易' : '确认并打开 Owner 钱包'}</button></div></section></div>`;
  }
  async function observe() {
    const item = review;
    if (!item?.txHash) return;
    const path = item.action==='configure'?'/subscriptions/policy-observed':item.action === 'create' ? '/subscriptions/observed' : `/subscriptions/${item.expected.subscriptionId}/control-observed`;
    const body = item.action==='configure'?{policyId:item.preview.policyId,txHash:item.txHash}:item.action === 'create' ? { registrationId: item.preview.registrationId, txHash: item.txHash } : { controlId: item.preview.controlId, txHash: item.txHash };
    await hooks.api(path, 'POST', body);
    // Read back actual chain status before closing review or claiming completion.
    await refresh();
    if (error) throw new Error(error);
    review = null; storeReview();
  }
  async function action(action: string, subscriptionId = '') {
    if (!enabled()) throw new Error('当前网络未启用订阅。');
    if (action === 'subscription-dismiss') { if (!review?.txHash) review = null; return; }
    if(action==='subscription-configure'){
      const preview=subscriptionPolicyPreviewSchema.parse(await hooks.api('/subscriptions/policy-preview','POST',demoPolicy));validateSubscriptionPolicyTransaction(hooks.config(),preview,demoPolicy);review={action:'configure',preview,expected:demoPolicy};return;
    }
    if (action === 'subscription-preview') {
      const parsed = FiniteSubscriptionFormSchema.safeParse(form);
      if (!parsed.success) throw new Error('请填写有效非零收款地址、固定 ETH、正整数周期、UTC 起止秒、有限次数和最多 6 位小数的 USD 上限。结束必须晚于开始。');
      const fields = parsed.data;
      const expected = { recipient: fields.recipient, amountWei: parseEther(fields.amount).toString(), periodSeconds: fields.periodSeconds, startAtSeconds: fields.startAt, endAtSeconds: fields.endAt, maxPayments: fields.maxPayments, periodCapUsd6: parseUnits(fields.periodCap, 6).toString() };
      const preview = subscriptionPreviewSchema.parse(await hooks.api('/subscriptions/preview', 'POST', expected));
      validateSubscriptionTransaction(hooks.config(), preview, expected, 'create');
      review = { action: 'create', preview, expected }; return;
    }
    if (action === 'subscription-sign') {
      if (!review) return;
      if (!review.txHash) {
        const item = review;
        const tx = item.action==='configure'?validateSubscriptionPolicyTransaction(hooks.config(),item.preview,item.expected):validateSubscriptionTransaction(hooks.config(), item.preview, item.expected, item.action);
        if (item.action === 'create' && Number(item.preview.quoteExpiresAtSeconds) <= Date.now() / 1000) throw new Error('登记预览已过期，请返回并重新预览。');
        item.txHash = await hooks.sign(tx);
        if (!/^0x[0-9a-fA-F]{64}$/.test(item.txHash)) throw new Error('钱包没有返回有效交易哈希，请在钱包核对原交易。');
        storeReview();
      }
      try { await observe(); } catch (cause) { if (cause instanceof ApiError && cause.code === 'TX_PENDING') throw new Error('原交易已广播，尚待上链；请只核对原交易，不要重新签名。'); throw cause; }
      return;
    }
    // Every pay click re-reads on-chain state and creates a NEW child draft. Never reuse a quote.
    const fresh = subscriptionListSchema.parse(await hooks.api('/subscriptions')).subscriptions;
    const record = fresh.find(record => record.subscriptionId === subscriptionId);
    if (!record) throw new Error('订阅链上记录不存在，请刷新。');
    if (action === 'subscription-pay') {
      if (record.status !== 'ACTIVE' || record.currentOccurrenceIndex === null) throw new Error('订阅当前不可付款，请核对起止、暂停、取消和次数。');
      const draft = await hooks.api('/intents', 'POST', { actionKind: 'SUBSCRIPTION', subscriptionId, occurrenceIndex: record.currentOccurrenceIndex });
      if (draft.actionKind !== 'SUBSCRIPTION' || draft.subscriptionId !== subscriptionId || draft.occurrenceIndex !== record.currentOccurrenceIndex || draft.recipient?.toString().toLowerCase() !== record.recipient.toLowerCase() || draft.amountWei !== record.amountWei) throw new Error('当期草稿与链上有限计划不一致，已停止。');
      const quote = await hooks.api(`/intents/${draft.draftId}/preview`, 'POST', { expectedRevision: draft.revision });
      if (quote.actionKind !== 'SUBSCRIPTION' || quote.subscriptionId !== subscriptionId || quote.occurrenceIndex !== record.currentOccurrenceIndex || !/^0x[0-9a-fA-F]{64}$/.test(String(quote.planHash))) throw new Error('当期报价缺少订阅与计划哈希绑定，已停止。');
      hooks.payment(draft, quote); return;
    }
    const control = action.slice('subscription-'.length);
    if (!['pause', 'resume', 'cancel'].includes(control)) return;
    const controlAction=control as 'pause'|'resume'|'cancel';
    const preview = subscriptionControlPreviewSchema.parse(await hooks.api(`/subscriptions/${subscriptionId}/control-preview`, 'POST', { action: control }));
    const expected = { subscriptionId };
    validateSubscriptionTransaction(hooks.config(), preview, expected, controlAction);
    review = { action: controlAction, preview, expected };
  }
  return { enabled, refresh, render, action, input(input: HTMLInputElement) { const field = input.dataset.subscriptionField; if (field && Object.hasOwn(form, field)) form[field as keyof typeof form] = input.value; }, clear() { records = []; policy=null;review = null; error = ''; loaded = false; } };
}
