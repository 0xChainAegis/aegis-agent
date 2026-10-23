<p align="center">
  <img src="frontend/public/aegis-hero.png" width="100%" alt="Aegis 白色陶瓷标识 · Agent wallet control">
</p>

<p align="center"><strong>为 Agent 运行钱包补充 Gas 储备，让支出受链上规则约束。</strong><br>真实余额 · 明确确认 · Chainlink 美元限额 · 可核查的执行结果</p>

<p align="center">简体中文 · <a href="README.en.md">English</a></p>

<p align="center">
  <a href="https://github.com/0xChainAegis/aegis-agent/actions/workflows/ci.yml"><img src="https://github.com/0xChainAegis/aegis-agent/actions/workflows/ci.yml/badge.svg?branch=main" alt="Integration checks"></a>
  <a href="https://sepolia.etherscan.io/tx/0x47340b28f1b5eaa11c4ce8e2ffadc2937dfb0f3d55ffb35add32c40fb2bfcec2"><img src="https://img.shields.io/badge/Sepolia-payment%20verified-4f6b5a" alt="Verified Sepolia payment"></a>
  <a href="docs/CHAINLINK.md"><img src="https://img.shields.io/badge/Chainlink-Data%20Feeds-375bd2" alt="Chainlink Data Feeds"></a>
  <img src="https://img.shields.io/badge/Node.js-24%2B-252b2a" alt="Node.js 24 or newer">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-66716b" alt="MIT license"></a>
</p>

<p align="center"><a href="#问题与方案">产品</a> · <a href="#sepolia-实测">测试网证据</a> · <a href="#chainlink-如何参与付款">Chainlink</a> · <a href="#快速开始">运行</a> · <a href="#功能边界">范围</a> · <a href="#团队">团队</a></p>

## <img src="docs/images/section-problem.svg" width="24" height="24" alt="" align="absmiddle"> 问题与方案

Agent 的运行钱包需要原生 ETH 支付交易费用。钱包耗尽会中断任务，而直接开放资金池又扩大了自动化流程的资金权限。

Aegis 面向运行链上任务的 Agent 运营者：读取一个运行钱包的真实 ETH 余额，根据用户设置的下限与目标建议补给金额。用户检查并明确确认后，受限执行账户才向资金池合约提交请求。合约使用 Chainlink ETH/USD 报价，强制校验收款白名单、权限、美元额度、请求期限与策略版本。

输入可以来自表单或自然语言。模型只整理草稿，不能修改链上预算、取得 Owner 权限或跳过用户确认。

## <img src="docs/images/section-verify.svg" width="24" height="24" alt="" align="absmiddle"> Sepolia 实测

**2026-10-22，一笔通过网页确认的 0.0001 ETH 补给已在 Ethereum Sepolia 执行。**

- [交易回执与事件](https://sepolia.etherscan.io/tx/0x47340b28f1b5eaa11c4ce8e2ffadc2937dfb0f3d55ffb35add32c40fb2bfcec2)：区块 **11969287**，receipt status 为 1。
- [补给资金池](https://sepolia.etherscan.io/address/0xD7FD1c334c24FcAb35cF6200F470ab8F238347E8)：`0xD7FD1c334c24FcAb35cF6200F470ab8F238347E8`。
- 运行钱包余额从 **0 增至 0.0001 ETH**，资金池从 **0.005 减至 0.0049 ETH**。
- 同一交易的 Wallet `NativeTransferExecuted` 与 PolicyEngine `BudgetConsumed` 匹配请求哈希、执行账户和美元成本。
- 独立只读 RPC 复核通过 13 项回执、事件与余额检查。[公开核验记录](docs/evidence/sepolia-payment-2026-10-22.json) · [核验范围](docs/EVIDENCE.md)。

这笔验收使用规则解析器。实时 LLM 与其余测试网安全场景分别验收，当前记录只对应上述付款。

## <img src="docs/images/section-chainlink.svg" width="24" height="24" alt="" align="absmiddle"> Chainlink 如何参与付款

Chainlink 参与合约的最终支付判断。ETH/USD Feed 将 ETH 转账本金换算成美元，帮助运营者用稳定的美元额度管理补给风险。

- **5 USD 自动审批阈值**：在阈值内的请求仍须先由用户在网页明确确认。
- **10 USD 单笔硬上限、15 USD UTC 自然日累计上限**：所有执行路径共享；Owner 审批也不能绕过。
- **报价校验**：正价格、完整轮次、有效时间戳、固定精度与新鲜度；审批执行时重新检查。
- **执行证据**：付款事件记录对应轮次和报价更新时间，预算事件记录实际消耗。

Sepolia ETH/USD Feed 为 [`0x694AA1769357215DE4FAC081bf1f309aDC325306`](https://sepolia.etherscan.io/address/0x694AA1769357215DE4FAC081bf1f309aDC325306)。在已验证付款中，0.0001 ETH 的本金按向上取整的 USD6 估值为 **0.240072 USD**。

ETH/USD Feed **不提供网络 Gas 价格**。补给本金与执行账户支付的交易手续费分开计算。[集成路径、公式与限制](docs/CHAINLINK.md)。

## <img src="docs/images/section-flow.svg" width="24" height="24" alt="" align="absmiddle"> 使用流程

1. 选择钱包插件并连接，再以部署配置中的 Owner 签名登录。登录消息不授权付款。
2. 总览读取运行钱包余额 B。设置下限与目标，建议补给金额为“目标减 B”。这些设置只保存在当前浏览器，不会后台自动付款。
3. 点击准备时重新读取网络、钱包、余额与任务；金额变化需要再次检查。
4. 预览完整地址、金额、美元上限和审批路径，再由用户确认提交。
5. 在任务与验证记录中核对链上回执。超出自动阈值时，由 Owner 另行签署审批交易；硬限制始终有效。

四个角色各自独立：**Owner** 管理规则和审批，**执行账户** 在授权内提交请求，**资金池合约** 持有补给资金，**运行钱包** 接收 ETH。连接任意地址不会获得已有资金池的管理权限。

## <img src="docs/images/section-screens.svg" width="24" height="24" alt="" align="absmiddle"> 产品界面

网页使用与仓库主图一致的陶瓷与石墨视觉，支持明暗主题和移动端。

![Aegis 运行钱包与储备设置，本地测试链截图](docs/images/reserve-low.png)

上图使用本地链 31337 与 Mock Feed 拍摄，可在本机重复运行。Sepolia 实测详见本页交易链接。

<details>
<summary>查看确认、恢复与手机界面</summary>

![本地演示的明确确认抽屉](docs/images/reserve-preview.png)

![本地演示刷新后恢复同一任务](docs/images/reserve-after-refresh.png)

<p align="center"><img src="docs/images/reserve-mobile.png" width="280" alt="浅色手机界面"><img src="docs/images/reserve-mobile-dark.png" width="280" alt="深色手机界面"></p>

</details>

## <img src="docs/images/section-architecture.svg" width="24" height="24" alt="" align="absmiddle"> 架构与技术栈

`Vite / TypeScript 界面 → Node.js 24 API / SQLite → viem → Solidity 资金池与策略合约 → Chainlink ETH/USD Feed`

- **界面**：钱包发现、储备建议、自然语言与手动输入、预览、审批及验证记录。
- **后端**：Zod 运行时校验、Owner 登录、持久化任务、幂等提交和原交易核对。
- **合约**：ACL、锁定价格源、统一风险策略、资金池和行为存证。
- **AI 输入层**：规则解析默认可用；Anthropic 与 OpenAI-compatible 接口为可选 live 模式。Python Agent 为早期原型，不在当前运行链路中。

## <img src="docs/images/section-start.svg" width="24" height="24" alt="" align="absmiddle"> 快速开始

需要 **Node.js 24+** 与 npm。在仓库根目录安装锁定依赖：

```bash
npm ci --ignore-scripts
```

分别在三个终端执行：

```bash
# 终端 1：本地开发链
npm run chain
# 终端 2：节点启动后部署本地合约
npm run deploy:local
# 终端 3：启动前后端
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。本地链为 31337，API 为 3001，RPC 为 8545，使用 Mock Feed；公开开发私钥只能用于本地。

**Sepolia** 使用真实合约、真实 Feed 与独立配置的 Owner 和执行账户。[Sepolia 部署与启动](docs/SEPOLIA-DEMO.md)说明 `npm run check:sepolia`、`npm run start:sepolia` 和无模型模式。生成的部署文件与私密环境变量不加入 Git，不能复制他人私钥；Windows 启动也可使用文档中的 Python 入口。

**真实模型**需要服务端 API key、可访问的 Base URL 与准确模型 ID。[live 配置](docs/LLM-LIVE-LOCAL.md)。页面与响应会标识实际解析器及回退原因；`off` 与 `stub` 均不等于真实模型调用。

## <img src="docs/images/section-verify.svg" width="24" height="24" alt="" align="absmiddle"> 验证

```bash
npm run check
npm run test:e2e
```

检查覆盖 strict TypeScript、构建、合约、后端、前端与浏览器流程。CI 运行记录见顶部徽章。E2E 会启动独立本地链与数据库；请先停用占据 5173、3001、8545 的手动服务，或在另一台机器/CI 运行。

测试覆盖报价、预算、权限、事件绑定、重放、审批、取消、缺失数据与恢复等不同范围。本地自动化测试、只读测试网检查、已确认的公网付款分别标注，不能互相替代。[证据说明](docs/EVIDENCE.md)。

## <img src="docs/images/section-features.svg" width="24" height="24" alt="" align="absmiddle"> 功能边界

当前运行实例服务 **一个 Owner 资金池、一个配置的运行钱包、原生 ETH 补给**。储备设置是建议，不是调度器。支持可选 LLM 草稿，但模型不能直接付款。

提示词扫描是启发式辅助检查，结构化输出还须校验；资金权限由合约规则约束。当前没有自动多用户建池、多钱包分配、定时付款、订阅或 CCIP 执行，也不声称完成生产安全审计。

历史 40 条意图评测的版本和限制见 [评测报告](eval/REPORT.md)，不把历史样本分数当作当前版本准确率。

## <img src="docs/images/section-team.svg" width="24" height="24" alt="" align="absmiddle"> 活动来源

本项目在 **ETH Shenzhen 2026** 赛期内新开发。以 Agent 支付执行安全与可核查结果为切入点。

<img src="docs/images/eth-shenzhen-2026-poster.png" width="100%" alt="ETH Shenzhen 2026 Hackathon 活动海报">

## <img src="docs/images/section-team.svg" width="24" height="24" alt="" align="absmiddle"> 团队

<table width="100%">
  <tr>
    <td width="25%" align="center" valign="top">
      <a href="https://github.com/mia03ther"><img src="https://github.com/mia03ther.png?size=144" width="64" height="64" alt="MIA_Ether 的 GitHub 头像"><br><b>MIA_Ether</b></a><br>
      <sub>产品 · 前端<br>集成</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <a href="https://github.com/gitgdut"><img src="https://github.com/gitgdut.png?size=144" width="64" height="64" alt="purple sun 的 GitHub 头像"><br><b>purple sun</b></a><br>
      <sub>后端<br>智能合约</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <a href="https://github.com/qiwei999"><img src="https://github.com/qiwei999.png?size=144" width="64" height="64" alt="qiwei999 的 GitHub 头像"><br><b>qiwei999</b></a><br>
      <sub>AI 意图解析<br>边界校验</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <a href="https://github.com/mantianxingdou10086"><img src="https://github.com/mantianxingdou10086.png?size=144" width="64" height="64" alt="满天星斗烟火繁的 GitHub 头像"><br><b>满天星斗烟火繁</b></a><br>
      <sub>Agent 工程<br>意图评测</sub>
    </td>
  </tr>
</table>

## <img src="docs/images/section-architecture.svg" width="24" height="24" alt="" align="absmiddle"> 文档

[架构](docs/ARCHITECTURE.md) · [API](docs/INTEGRATION.md) · [Chainlink 集成](docs/CHAINLINK.md) · [测试网证据](docs/EVIDENCE.md) · [安全边界](docs/SECURITY.md) · [合约](contracts/README.md) · [设计系统](frontend/DESIGN.md) · [Sepolia](docs/SEPOLIA-DEMO.md) · [实时模型](docs/LLM-LIVE-LOCAL.md)

[贡献者](https://github.com/0xChainAegis/aegis-agent/graphs/contributors) · MIT，参见 [LICENSE](LICENSE)。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/aegis-footer-dark.svg">
  <img src="docs/images/aegis-footer-light.svg" width="100%" alt="Aegis · 陶瓷白、石墨与渐变纹理">
</picture>
