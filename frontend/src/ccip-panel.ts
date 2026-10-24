import { formatUnits } from 'viem';
import { ccipFormSchema, ccipIntentBindingSchema, ccipQuoteBindingSchema, ccipRouteSchema } from './ccip';
import type { Data } from './api';

type Hooks = {
  api: (path: string, method?: string, body?: Data) => Promise<Data>;
  config: () => Data | null;
  disabled: () => boolean;
  payment: (draft: Data, quote: Data) => void;
};
const entities: Record<string,string>={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>entities[char]??char);
const short=(value:unknown)=>{const text=String(value??'');return text.length>20?`${text.slice(0,10)}…${text.slice(-8)}`:text;};

export function createCcipPanel(hooks: Hooks) {
  const form={recipient:'',amount:'',purpose:''};
  const route=()=>ccipRouteSchema.safeParse(hooks.config());
  const enabled=()=>route().success;
  function render() {
    const parsed=route();
    if(!parsed.success)return '<div class="info-panel">当前部署没有通过校验的 CCIP 路线，不能创建跨链转账。</div>';
    const config=parsed.data;
    const destination=config.ccipDestinationNetwork??(config.ccipDestinationChainId?`Chain ${config.ccipDestinationChainId}`:'本地模拟目标链');
    const blocked=hooks.disabled();
    return `<section class="page-heading"><div><h1>CCIP 跨链转账</h1><p>发送与到账分开核验；源链成功不等于目标链已到账。</p></div></section>
      <section class="settings-card ccip-editor" data-testid="ccip-form"><div class="section-title-row"><div><h2>固定安全路线</h2><p class="settings-caption">路线由已验证部署提供，页面不能自行更换代币或目标链。</p></div><span class="badge green">${esc(destination)}</span></div>
      <div class="ccip-route"><div><span>源链</span><strong>Chain ${config.chainId}</strong></div><div><span>跨链协议</span><strong>Chainlink CCIP</strong></div><div><span>目标链</span><strong>${esc(destination)}</strong></div></div>
      <div class="subscription-fields"><label>目标链收款地址<input id="ccip-recipient" data-ccip-field="recipient" data-testid="ccip-recipient" class="mono" value="${esc(form.recipient)}" placeholder="0x…" autocomplete="off" ${blocked?'disabled':''}></label><label>数量 · CCIP-BnM<input id="ccip-amount" data-ccip-field="amount" data-testid="ccip-amount" value="${esc(form.amount)}" placeholder="例如 0.000001" inputmode="decimal" autocomplete="off" ${blocked?'disabled':''}></label><label>用途<input id="ccip-purpose" data-ccip-field="purpose" data-testid="ccip-purpose" value="${esc(form.purpose)}" placeholder="说明本次跨链用途" autocomplete="off" ${blocked?'disabled':''}></label></div>
      <div class="detail-section"><h3>已绑定路线</h3><div class="detail-row"><span>源链 Token</span><div class="mono break-all">${esc(config.ccipTokenAddress)}</div></div><div class="detail-row"><span>目标链 Token</span><div class="mono break-all">${esc(config.ccipDestinationTokenAddress??'本地夹具未配置')}</div></div><div class="detail-row"><span>目标链 Selector</span><div class="mono">${esc(config.ccipDestinationChainSelector)}</div></div></div>
      <p class="settings-caption">预览会读取测试估值和 Router 当前费用，并生成美元上限、费用上限与计划哈希。确认提交后仍会在链上重新检查。</p><button class="button primary" data-action="ccip-preview" data-testid="ccip-preview" ${blocked?'disabled':''}>预览跨链转账</button></section>`;
  }
  async function preview() {
    const config=ccipRouteSchema.parse(hooks.config());
    const input=ccipFormSchema.safeParse(form);
    if(!input.success)throw new Error('请填写有效的目标链地址、正数 CCIP-BnM 数量（最多 18 位小数）和不超过 500 字符的用途。');
    const body={actionKind:'CCIP_TRANSFER',recipient:input.data.recipient,amountWei:input.data.amountWei,tokenAddress:config.ccipTokenAddress,destinationChainSelector:config.ccipDestinationChainSelector,purpose:input.data.purpose||'CCIP 跨链转账'};
    const draft=ccipIntentBindingSchema.parse(await hooks.api('/intents','POST',body));
    if(draft.recipient.toLowerCase()!==input.data.recipient.toLowerCase()||draft.amountWei!==input.data.amountWei||draft.tokenAddress.toLowerCase()!==config.ccipTokenAddress.toLowerCase()||draft.ccipSenderAddress.toLowerCase()!==config.ccipSenderAddress.toLowerCase()||draft.destinationChainSelector!==config.ccipDestinationChainSelector)throw new Error('服务返回的跨链草稿与固定路线或填写内容不一致。');
    const quote=ccipQuoteBindingSchema.parse(await hooks.api(`/intents/${encodeURIComponent(draft.draftId)}/preview`,'POST',{expectedRevision:draft.revision}));
    if(quote.draftId!==draft.draftId||quote.draftVersion!==draft.revision||quote.walletAddress.toLowerCase()!==config.ccipSenderAddress.toLowerCase()||quote.recipient.toLowerCase()!==draft.recipient.toLowerCase()||quote.amountWei!==draft.amountWei||quote.tokenAddress.toLowerCase()!==draft.tokenAddress.toLowerCase()||quote.destinationChainSelector!==draft.destinationChainSelector)throw new Error('跨链报价没有完整绑定草稿和部署路线。');
    hooks.payment(draft,quote);
  }
  return {
    enabled,render,preview,
    input(input:HTMLInputElement){const field=input.dataset.ccipField;if(field==='recipient'||field==='amount'||field==='purpose')form[field]=input.value;},
    fillRecipient(value:string){form.recipient=value;},
    clear(){form.recipient='';form.amount='';form.purpose='';},
    describeAmount(value:unknown){try{return formatUnits(BigInt(String(value)),18);}catch{return '—';}},
    routeLabel(){const parsed=route();return parsed.success?short(parsed.data.ccipDestinationNetwork??parsed.data.ccipDestinationChainId):'—';},
  };
}
