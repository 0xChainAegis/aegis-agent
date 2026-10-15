# AegisAgent

让 Agent 在明确的收款人、美元预算和审批规则内支付 ETH，并让 Owner 看清每笔请求最终有没有付款。

面向 ETH Shenzhen 2026 的当前版本聚焦**受控 native ETH 支付**：自然语言或表单生成草稿，Owner 核对后提交，独立 Agent 账户发起链上请求。小额付款自动执行，超过自动额度的付款进入链上待审批；Owner 批准也不能绕过单笔、每日预算或价格新鲜度限制。

目前交付是本地开发链集成。**本地交易真实执行，价格来自本地 Mock Feed，资金是无价值测试 ETH；不是 Sepolia 或主网演示。**当前解析器明确显示为 `rule_parser`，不需要 LLM API key。

## 运行

需要 Node.js **24+**、npm 和三个终端。全部命令在仓库根目录运行，无需 Python，也不需要创建或填写真实 `.env`。

先安装依赖。有锁文件时使用：

```bash
npm ci --ignore-scripts
```

首次没有锁文件时可用 `npm install --ignore-scripts`。

终端 1：启动本地链，并保持运行。

```bash
npm run chain
```

终端 2：部署与初始化本地合约。

```bash
npm run deploy:local
```

这一步生成 `contracts/deployments/localhost.json`，默认向金库充值 1 ETH，允许 Hardhat 账户 2 收款，并设置 $5 自动额度、$10 单笔硬上限、$15 全金库 UTC 日预算。ETH/USD Mock Feed 初始价格为 $3,000。

终端 3：启动前后端。

```bash
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。API 在 `http://127.0.0.1:3001`，RPC 在 `http://127.0.0.1:8545`，Chain ID 为 `31337`。

页面可显式选择“本地测试钱包”，阅读提示后使用本机节点解锁的公开开发 Owner（默认 Hardhat 账户 0）签名登录。该入口不读取或保存私钥，只允许本机的 31337 开发链。也可连接浏览器钱包，但必须使用配置的 Owner 和同一条链。**公开开发账户不能用于真实资金。**

RPC、合约、Feed 或执行账户未就绪时，页面应显示原因；服务不会自动切成模拟成功。

## 体验三笔付款

收款人使用部署配置中的 `recipientAddress`，默认 Hardhat 账户 2：`0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`。金额是示例；页面以当次报价和链上预算为准。

1. 在表单填写上述完整地址与 `0.001`，也可用包含完整地址的自然语言。检查草稿、约 $3 估值和最高可接受 USD 成本，确认后查看 Agent 付款交易与执行事件。
2. 输入 `0.002 ETH`。约 $6 的请求进入待审批；Owner 在浏览器或显式本地测试钱包单独签 `approveAndExecute`，付款完成后再显示已执行。也可选择链上取消。
3. 输入 `0.004 ETH`。约 $12 超出 $10 单笔硬上限，应在预览阻断，Owner 不能批准绕过。

在初始预算下，依次支付前两笔共花费约 $9，剩余约 $6。刷新页面可恢复已提交任务；打开任务查看请求 hash、回执、事件与验证结果。入队只代表等待审批，不能当作付款成功。

美元、其他代币、缺失地址或不明确的数额会要求补齐；当前不会把 USD 数字当 ETH，也不会自动换算其他资产。Agent 钱包补 ETH 仍是候选场景，自动监控和触发未启用。

## 可用范围与信任边界

- 当前用户是单一资金池的 **Owner**，与后台 **Agent 执行账户**分开。登录签名只创建会话，不批准高风险付款。设置页目前只读，策略变更需要 Owner 的链上交易。
- Agent 可在既定链上策略内付款。界面的草稿确认是当前产品流程，不是每笔低风险付款额外的链上 Owner 签名。Owner 是可信策略管理员。
- 合约最终检查允许收款人、Agent 权限与 tier、整数 USD6 单笔/日预算、nonce、期限、策略版本和 Feed 时间。审批时重新检查；其他付款可能先消耗预算。
- SQLite 保存任务与广播前的原始签名交易。广播结果未知先核对原 hash，不自动创建新付款。成功回执还必须包含匹配的业务事件，才标记 `EXECUTED`。
- 当前采用一次 mined 确认，未实现深重组恢复、多进程签名协调或生产密钥管理。本地闭环测试不能证明公网资金安全；测试网和主网均未验证。

真正的 LLM、CRE、CCIP、x402、EZKL、ERC20、订阅和自动补款均不在当前运行链路。`agent/` 中的 Python 实现与 `frontend/legacy-demo.html` 保留为早期参考，不是当前入口或本轮能力证据。

## Chainlink 在付款中的作用

当前核心是 **ETH/USD Data Feed 决定链上 USD 预算是否允许付款**，并在 Owner 批准时重新检查：

- [`AegisPriceOracle.sol`](contracts/contracts/AegisPriceOracle.sol)：检查 Feed round、answer、updatedAt 和 decimals，USD6 估值向上取整，Feed 配置锁定。
- [`AegisWallet.sol`](contracts/contracts/AegisWallet.sol)：请求及审批执行都检查价格 freshness、USD 上限与日预算，并原子扣账。
- [`deploy-local.js`](contracts/scripts/deploy-local.js)：本地部署 [`MockV3Aggregator.sol`](contracts/contracts/mocks/MockV3Aggregator.sol)，价格与故障测试使用模拟数据。
- [`backend/src/chain.ts`](backend/src/chain.ts)：生成报价、模拟交易、读取真实回执并校验事件绑定；最终授权由合约执行。

请求 hash 绑定链、Wallet、Agent、收款人、金额、最高 USD 成本、nonce、期限与策略版本；付款结果通过同一 hash 的业务事件关联。当前没有把自然语言、模型推理与执行后的完整记录一并提前上链，也没有 AI 推理正确性证明。

旧公网部署命令已显式禁用。公网部署需要先人工检查脚本、Feed 地址、角色、资金、策略和密钥方案，并完成独立验证；直接运行旧命令不是受支持流程。

## 本届集成增量

在原有 Solidity/Python/静态演示基础上，本轮新增或调整：

- TS + viem HTTP 后端与共享 API/ABI 类型，替代当前主线的 Python CLI 入口。
- Owner 真实挑战签名登录、HTTP 任务归属、版本确认与幂等提交。
- Native ETH 合约统一硬限制，禁用旧 ERC20/订阅资金出口。
- SQLite 交易恢复、请求/结果事件绑定和可核查任务证据。
- Vite 前端草稿、操作卡片、Owner 审批与验证页；本地测试钱包有显式环境限制。

比赛提交时应固定最终提交版本，并根据实际完成情况更新能力、部署与验证证据；开发分支不等于比赛已提交。

## 开发与验证

```bash
npm run typecheck
npm run build
npm test
npm run check
```

`check` 包含类型检查、构建、合约和后端测试。后端 API 测试使用真实测试账户签名与显式假链适配器，不能单独当作链上端到端证明。

本轮已记录：后端类型检查通过，8 项后端 API 测试通过；合约编译及 19 项合约测试通过。代码见 [`backend/test/api.test.ts`](backend/test/api.test.ts) 和 [`contracts/test/AegisWallet.test.js`](contracts/test/AegisWallet.test.js)。

浏览器端到端由 `npm run test:e2e` 从零启动本地链、部署、API 和页面。本轮 2 项浏览器测试已通过，覆盖实际到账、Owner 审批后付款、链上取消、硬预算拒绝、请求哈希与事件核对、刷新恢复、缺字段补充和离线停止。首次运行需 `npx playwright install chromium`；Windows 已安装 Chrome 时可直接使用。

端到端测试使用 8545、3001、5173 端口；运行前停止手工启动的开发服务。已有本机服务且确认使用全新链和数据库时，才可设置 `AEGIS_E2E_EXTERNAL=1` 复用。当前测试在本机通过，GitHub Actions 需推送分支后查看实际运行结果。

接口、角色、重试与本地重置见 [联调说明](docs/INTEGRATION.md)。三人分工与检查流程见 [团队任务说明](docs/agent-tasks/README.md)。

## 目录

```text
frontend/          Vite + TypeScript 用户界面
backend/           Node 24 HTTP + viem + SQLite
packages/shared/   API 类型与当前 ABI 签名
contracts/         Solidity、Hardhat 测试与本地部署
agent/             早期 Python 实现，保留参考
docs/              联调和团队文档
```

MIT — see [LICENSE](LICENSE).
