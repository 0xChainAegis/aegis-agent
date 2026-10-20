import { isAddress, zeroAddress } from 'viem';
import type { Data } from './api';

export function serviceReadiness(config: Data | null): { canConnect: boolean; canPay: boolean; message: string } {
  const stopped = (message: string) => ({ canConnect: false, canPay: false, message });
  const readiness = config?.readiness && typeof config.readiness === 'object' ? config.readiness as Data : {};
  const chainId = Number(config?.chainId);
  const addresses = ['walletAddress', 'ownerAddress', 'recipientAddress', 'agentAddress'];
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || addresses.some(key => !isAddress(String(config?.[key] || '')) || String(config?.[key]).toLowerCase() === zeroAddress)) {
    return stopped('网络或资金池配置不完整，无法核对钱包身份。已停止连接和付款，请检查服务配置后重试。');
  }
  const code = String(readiness.code || '');
  if (code === 'CHAIN_MISMATCH' || (readiness.rpcChainId !== undefined && Number(readiness.rpcChainId) !== chainId)) {
    return stopped('链上节点的网络与服务配置不一致。已停止连接和付款，请修正网络后重试。');
  }
  const verified = Number(readiness.rpcChainId) === chainId && readiness.contractsDeployed === true && readiness.deploymentBindingsVerified === true;
  if (readiness.ready === true && verified && !code) return { canConnect: true, canPay: true, message: '' };
  if (code === 'FEED_STALE') return { canConnect: verified, canPay: false, message: '价格已过期，已暂停付款。请等待报价更新后刷新状态；网络与资金池已核对时仍可登录查看余额。' };
  if (code === 'FUNDING_REQUIRED') return { canConnect: verified, canPay: false, message: '补给资金池或执行账户余额不足，已暂停付款。请补充 ETH 后刷新状态；仍可登录查看余额。' };
  if (['CHAIN_UNAVAILABLE', 'RPC_UNAVAILABLE', 'RPC_ERROR'].includes(code)) return stopped('无法连接链上节点，已暂停连接和付款。请检查节点服务后刷新状态。');
  if (['DEPLOYMENT_MISSING', 'CONTRACT_MISSING', 'OWNER_MISMATCH', 'DEPLOYMENT_BINDING_MISMATCH', 'POLICY_ENGINE_MISMATCH', 'ORACLE_CONFIGURATION_CHANGED', 'EXECUTOR_MISMATCH'].includes(code)) {
    return stopped('资金池身份或部署配置尚未通过链上核对。已停止连接和付款，请检查服务配置后重试。');
  }
  return stopped('服务尚未确认链上就绪状态，已停止连接和付款。请刷新状态重试；持续出现时请检查服务配置。');
}
