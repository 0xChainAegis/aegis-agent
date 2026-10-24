# 阶段 1：有限订阅本地实现与验收

> 历史阶段说明：本文保留最初仅支持 Local 31337 时的设计边界。当前分支已经增加 Ethereum Sepolia API/UI 与 Owner 首次配置订阅上限的流程；最新启动和验收步骤以 [启动与网页验收](STARTUP.zh-CN.md) 为准。尚未完成一次新的 Sepolia 订阅付款证据前，不应把本地 E2E 当作公网执行证明。

状态：历史阶段已完成并进入主线；当前 Sepolia 扩展仍需独立公网验收，不代表已经完成生产安全审计。

## 范围与用户操作

1. Owner 填写固定 ETH 金额、白名单收款人、周期秒数、起止时间、最大付款次数和单期 USD 上限。
2. 后端严格校验，前端解码待签名 calldata 与填写内容逐项比较。Owner 在浏览器签名登记，后端核实 sender、目标合约、金额、calldata、事件与链上计划，才将其列入已登记订阅。
3. 每次付款都新建本期草稿、取新报价并人工确认。没有定时器、后台自动扣款或自动补缴。链上策略需要额外审批时，仍须 Owner 审批并执行。
4. 可以暂停、恢复或永久取消；暂停不移动到期时间。控制操作不依赖新鲜价格；付款仍依赖价格新鲜度。
5. 固定计划不可原地改收款人/金额；修改应取消旧计划并重新登记。

## 文件级变更

| 区域 | 文件 | 作用 |
|---|---|---|
| 合约 | `contracts/contracts/AegisPolicyEngine.sol` | 有限计划、周期校验、单期上限；与普通转账共享日预算和三档决策 |
| 合约 | `contracts/contracts/AegisWallet.sol` | Owner 登记/控制、订阅付款、排队与审批时重验、订阅事件及请求域 |
| 本地夹具 | `contracts/scripts/deploy-local.js`、`scripts/e2e-stack.mjs` | 仅显式开启本地测试配置；正常部署不默认为已启用 |
| 后端 | `backend/src/subscriptions.ts` | 严格 schema、链上登记/控制观察、local-only gate |
| 后端 | `backend/src/parser.ts`、`llm.ts` | 不支持的订阅/跨链自然语言不得降级为普通 ETH 付款 |
| 后端 | `backend/src/service.ts`、`chain.ts`、`server.ts` | 草稿→报价→确认→提交→事件证据；审批前核对订阅期号与哈希 |
| 溯源 | `backend/src/plan.ts`、`packages/shared/src/index.ts` | 新动作 v2 commitment 和 ABI；原 native 请求哈希保持不变 |
| 前端 | `frontend/src/subscriptions.ts`、`subscription-panel.ts`、`main.ts`、`schemas.ts`、`api.ts`、`style.css` | 订阅页、签名前逐字段核对、状态与人工确认流程 |
| 测试 | `contracts/test/Aegis.subscription.test.js`、`LocalSubscriptionDeployment.test.js` | 周期、安全边界与显式夹具 |
| 测试 | `backend/test/subscription-*.test.ts` | schema、拒绝降级、哈希防篡改、pending 绑定、同构证据 |
| 测试 | `frontend/src/*subscription*.test.ts`、`api.test.ts`、`e2e/subscriptions.spec.ts` | schema/交易核对、正常付款、超限、到期、取消 |
| 命令 | `package.json` | 将四个订阅 E2E 纳入统一测试命令 |

## 验证结果

最终本地 `npm run check` 退出码 **0**。可机读汇总见 [`docs/evidence/subscriptions-local-validation.json`](./evidence/subscriptions-local-validation.json)。类型检查及前后端构建通过；合约 **73**、后端 Node **88**、后端 Vitest **43**、前端 Vitest **260** 项通过，共 **464** 项，0 失败。日志：仓库外 `D:/黑客松/subscription-check-final.log`。

订阅合约专项及部署夹具 **25** 项通过，包含在合约全量中，不重复相加。最终执行 `npm run test:e2e`：普通转账/钱包 **49**、订阅 **4**、Gas 储备 **7** 项通过，共 **60** 项，0 失败。日志：仓库外 `D:/黑客松/subscription-e2e-final.log`。

第一次统一 E2E 为 52 通过、1 失败：普通转账第三次预览被共享日预算正确拒绝，先前订阅测试已在同一本地链花费 $0.60。修复方式是将钱包、订阅、储备拆为独立 Playwright 调用，各自重新部署本地链和数据库；**没有增加日预算，没有跳过原场景或减弱安全断言**。四个订阅场景均独立创建计划，覆盖真实付款及证据、单期超限、排除式到期边界和取消后禁止审批执行。

浏览器已留存桌面浅色/手机暗色截图；手机 E2E 补充滚动后末尾输入与操作按钮可达性检查。视觉核对未见明显横向溢出；Unix 秒输入仍偏开发工具体验，尚非面向普通用户的最终产品表单。

## 安全边界和未完成事项

- 阶段 1 当时仅在本地链 31337 启用 API/UI；当前实现已扩展到 Ethereum Sepolia，但首次使用需要 Owner 设置非零订阅上限。
- 未配置订阅上限时默认拒绝。仅本地测试显式设置：单期最大 `$10`、最长 `3600` 秒、最多 `10` 次。这些是测试夹具，不是团队正式额度。
- LLM 仍只能提供草稿；新订阅走结构化表单，SKILL 未扩展新意图。解析保护不是完整自然语言理解，不应宣称支持任意订阅表达。
- 人工确认由当前认证 API/UI 流程执行；planHash 是内容溯源，**不是人类签名证明**。持有已授权 Agent 私钥的人仍能直接调合约，在链上限额内发起请求；本阶段不新增可验证的人类签名授权协议。
- 订阅不补缴；仅当前周期可付款。链上到期和次数都会约束执行；到期/取消后已排队的审批也不能付款。
- 本阶段仅 ETH 本金的 USD 单期与共享日预算。Gas 由发送交易的账户承担，**不宣称已纳入完整 gas USD 总成本预算**。这与跨链费用统一预算仍是后续工作，未实现自动扣费授权。
- 普通转账保持原有语义；有限订阅使用独立 action kind、计划哈希和链上事件，不把订阅付款降级为普通转账。
- CCIP 原有独立出口本轮未改造；不能声称所有跨链动作已经过 PolicyEngine。
- 已有本地测试不等于独立安全审计。专用独立审查子代理启动时反复报内部 `vars() argument must have __dict__ attribute`。随后由未编写合约/后端的 UI 工作代理对订阅后端与合约做了有限只读交叉审查，未发现具体新增 High/Critical 绕过，但未审查完整部署权限、CCIP 或全部 RPC 对抗场景，**不能标记为完整安全审核通过**。当前按用户要求提交为 Draft PR 供评审；不合并、不部署，发布前仍需完整审查。旧部署合约不会被源代码修改自动升级；任何测试网部署/迁移需要单独确认。
- 本地列表只索引通过本 API 观察确认过的订阅；不会自动发现任意历史外部登记。

## 复现

需要 Node 24、按锁文件安装依赖、可用 Chromium。运行仓库根目录：

```bash
npm run check
npm run test:e2e
```

本机使用独立 Node 24 和现有 npm CLI；首次依赖安装被 npm 的 git 依赖许可拦截，随后在只读锁文件安装中显式允许依赖下载，安装成功。未将执行密钥写入新增文件或文档。

## 给非技术队友的变化摘要

- 页面增加“订阅”，但不是“自动扣款”：登记后每期仍需要点一次预览和确认。
- 收款人、固定 ETH、周期、期限、次数、单期美元上限都必须明确，系统不猜。
- 同一周期最多成功付款一次，过期不追补，取消后不能恢复；共享每日预算不足也会拒绝。
- 页面显示计划 ID 和确认哈希；执行结果需要钱包事件和策略预算事件互相对应，不能仅凭交易回执显示成功。
- 目前只是本地演示和验证，正式额度、测试网部署和跨链仍未开放。

## 下一步（另行确认）

先评审本地订阅实现及正式产品限额；再决定是否合入/部署。跨链阶段需要单独完成目标链白名单、费用预览与计入预算、出口封堵、messageId 状态和失败处理。任何真实测试网跨链前必须人工批准。
