import { ConfigResponseSchema } from './schemas';

export type ServiceTone = 'neutral' | 'green' | 'amber' | 'red';
export type ServicePhase = 'loading' | 'ready' | 'limited' | 'blocked';

export interface ServiceStatus {
  phase: ServicePhase;
  tone: ServiceTone;
  code: string;
  title: string;
  message: string;
  actionLabel: string;
  canConnect: boolean;
  canPay: boolean;
}

export interface ServiceContext {
  online?: boolean;
  initialLoading?: boolean;
  refreshing?: boolean;
  apiErrorCode?: string;
  apiErrorMessage?: string;
}

function status(value: ServiceStatus): ServiceStatus { return value; }

const stopped = (code: string, title: string, message: string, tone: ServiceTone = 'red'): ServiceStatus => status({
  phase: 'blocked', tone, code, title, message, actionLabel: '刷新状态重试', canConnect: false, canPay: false,
});

export function serviceReadiness(config: unknown, context: ServiceContext = {}): ServiceStatus {
  if (context.initialLoading) return status({
    phase: 'loading', tone: 'neutral', code: 'LOADING', title: '正在检查服务',
    message: '正在读取 API、链上网络、合约和价格源状态。', actionLabel: '', canConnect: false, canPay: false,
  });
  if (context.refreshing) return status({
    phase: 'loading', tone: 'neutral', code: 'REFRESHING', title: '正在重新检查',
    message: '正在重新读取最新状态，完成前不会提交任何操作。', actionLabel: '', canConnect: false, canPay: false,
  });
  if (context.apiErrorCode === 'REQUEST_TIMEOUT') return stopped(
    'REQUEST_TIMEOUT', 'API 响应超时', '本地 API 未在限定时间内返回状态。请检查后端日志后重试；当前不会提交任何操作。', 'amber',
  );
  if (context.online === false) return stopped(
    'API_OFFLINE', 'API 离线', '无法连接本地 API。请确认后端已在 3001 端口启动，然后重新连接。',
  );
  if (context.apiErrorCode) return stopped(
    context.apiErrorCode, '服务响应无法使用', context.apiErrorMessage || 'API 已响应，但返回内容无法通过安全校验。请检查后端版本和日志。',
  );

  const parsed = ConfigResponseSchema.safeParse(config);
  if (!parsed.success) return stopped(
    'CONFIG_INVALID', '服务配置不完整', 'API 已连接，但网络、合约地址或就绪信息不完整。请检查后端配置后重试。',
  );

  const { chainId, mode, readiness } = parsed.data;
  const network = chainId === 11155111 ? 'Sepolia' : chainId === 31337 ? '本地链' : `Chain ${chainId}`;
  const code = readiness.code || '';
  const verified = readiness.rpcChainId === chainId
    && readiness.contractsDeployed === true
    && readiness.deploymentBindingsVerified === true;
  if (code === 'READINESS_CHECKING') return status({
    phase: verified ? 'limited' : 'loading', tone: verified ? 'amber' : 'neutral', code,
    title: verified ? `${network} 正在后台更新` : `正在核对 ${network}`,
    message: verified
      ? '保留上次成功核对的连接与只读信息；最新检查完成前暂停预览和付款。'
      : '正在后台读取网络、部署和价格源。检查完成前不会请求付款；页面会自动更新。',
    actionLabel: '重新检查状态', canConnect: verified, canPay: false,
  });
  if (code === 'READINESS_TIMEOUT') return verified ? status({
    phase: 'limited', tone: 'amber', code, title: `${network} 状态更新超时`,
    message: '保留上次成功核对的连接与只读信息；付款已暂停，请稍后重新检查 RPC。',
    actionLabel: '刷新状态重试', canConnect: true, canPay: false,
  }) : stopped(code, `${network} 检查超时`, '节点检查未在限定时间内完成，付款已暂停。请检查 RPC；完成中的检查结束后可重试。', 'amber');
  if (code === 'CHAIN_MISMATCH' || (readiness.rpcChainId !== undefined && readiness.rpcChainId !== chainId)) {
    return stopped('CHAIN_MISMATCH', '网络配置不一致', `RPC 返回的网络与 ${network} 配置不一致。请修正节点配置后重试。`);
  }

  if (readiness.ready && verified && !code) return status({
    phase: 'ready', tone: 'green', code: 'READY',
    title: mode === 'local_chain' ? '本地演示可用' : `${network} 已就绪`,
    message: mode === 'testnet' ? '最近一次网络、合约和价格源检查通过，可以连接钱包。付款前仍会重新校验链上规则。' : 'API、网络、合约和价格源均已核对，可以连接钱包并准备操作。',
    actionLabel: '', canConnect: true, canPay: true,
  });
  if (code === 'FEED_STALE') return status({
    phase: 'limited', tone: 'amber', code, title: 'Chainlink 报价待更新',
    message: '最新价格超过合约允许的新鲜度，付款已暂停。链和合约核对通过时仍可登录查看余额。',
    actionLabel: '重新检查报价', canConnect: verified, canPay: false,
  });
  if (['FEED_UNAVAILABLE', 'ORACLE_UNAVAILABLE', 'INVALID_PRICE'].includes(code)) return status({
    phase: 'limited', tone: 'amber', code, title: 'Chainlink 价格源不可用',
    message: '价格为零、负数、未来时间或无法读取时，付款已暂停。链和合约核对通过时仍可登录查看余额。',
    actionLabel: '重新检查价格源', canConnect: verified, canPay: false,
  });
  if (['EXECUTOR_UNAUTHORIZED', 'AGENT_FROZEN'].includes(code)) return status({
    phase: 'limited', tone: 'amber', code, title: '执行账户不可用',
    message: '执行账户未获授权、已冻结或仅可读取，付款已暂停。Owner 仍可登录查看当前状态。',
    actionLabel: '修复权限后重试', canConnect: verified, canPay: false,
  });
  if (code === 'FUNDING_REQUIRED') return status({
    phase: 'limited', tone: 'amber', code, title: '测试 ETH 余额不足',
    message: '资金池或执行账户需要补充测试 ETH，付款已暂停。仍可登录查看当前余额。',
    actionLabel: '补充后重新检查', canConnect: verified, canPay: false,
  });
  if (['CHAIN_UNAVAILABLE', 'RPC_UNAVAILABLE', 'RPC_ERROR'].includes(code)) return verified ? status({
    phase: 'limited', tone: 'amber', code, title: `${network} RPC 暂时波动`,
    message: '保留上次成功核对的连接与只读信息；最新链上读取恢复前暂停预览和付款。',
    actionLabel: '刷新状态重试', canConnect: true, canPay: false,
  }) : stopped(code, `${network} RPC 暂不可用`, 'API 正在运行，但暂时无法读取链上状态。请检查 RPC 服务或稍后重试。', 'amber');
  if (['DEPLOYMENT_MISSING', 'CONTRACT_MISSING', 'OWNER_MISMATCH', 'DEPLOYMENT_BINDING_MISMATCH', 'POLICY_ENGINE_MISMATCH', 'ORACLE_CONFIGURATION_CHANGED', 'EXECUTOR_MISMATCH'].includes(code)) {
    return stopped(code, '合约配置未就绪', '部署地址、合约绑定或权限未通过链上核对。请检查部署文件和后端配置。');
  }
  return stopped('READINESS_UNKNOWN', '链上状态未确认', '服务尚未确认网络、合约和价格源全部可用。请刷新；持续出现时检查后端日志。', 'amber');
}
