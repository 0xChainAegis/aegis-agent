<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/aegis-hero-dark.svg">
    <img src="docs/images/aegis-hero-light.svg" width="100%" alt="Aegis：A 字标与文字标识">
  </picture>
</p>

<p align="center">
  <strong>为智能体运行钱包补充 Gas 储备，让每笔支出可控。</strong><br>
  链上美元限额 · 用户明确确认 · 可核对的执行结果
</p>

<p align="center">
  简体中文 · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="#chainlink-与-ai-的位置"><img src="https://img.shields.io/badge/Chainlink-Data%20Feeds-59615F?style=flat-square&amp;labelColor=252B2A" alt="Chainlink Data Feeds"></a>
  <img src="https://img.shields.io/badge/TypeScript-Node%2024-59615F?style=flat-square&amp;labelColor=252B2A" alt="TypeScript 与 Node 24">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-59615F?style=flat-square&amp;labelColor=252B2A" alt="MIT 许可证"></a>
</p>

<p align="center">
  <a href="#问题与方案">简介</a> ·
  <a href="#产品截图">截图</a> ·
  <a href="#完整用户流程">流程</a> ·
  <a href="#chainlink-与-ai-的位置">Chainlink</a> ·
  <a href="#快速开始">运行</a> ·
  <a href="#验证">验证</a> ·
  <a href="#团队与文档">团队</a>
</p>

<p align="center">
  本项目诞生于 ETH Shenzhen 2026 黑客松。
</p>

<details>
  <summary>活动参考：ETH Shenzhen 2026 海报</summary>
  <p align="center">
    <img src="docs/images/eth-shenzhen-2026-poster.png" width="420" alt="ETH Shenzhen 2026 Hackathon 活动海报。">
  </p>
</details>

## <img src="docs/images/section-problem.svg" width="24" height="24" alt="" align="absmiddle"> 问题与方案

**问题。** 智能体的运行钱包需要原生 ETH 支付交易费用。余额耗尽时智能体会停止工作；让它自行补款，又等于把资金权限交给自动化流程。

**方案。** 一个资金池智能合约，向一个已配置的收款运行钱包支付原生 ETH，补充其 Gas 储备。用户在浏览器本地设置下限与目标值，Aegis 建议“目标值减当前余额”的补充金额；准备付款时重新校验，经用户明确确认后，由合约在白名单、权限与美元限额内执行。

**四个独立角色。**

| 角色 | 字段 | 职责 |
|---|---|---|
| Owner（资金管理员） | `ownerAddress` | 管理资金池、审批待处理付款 |
| 执行账户 | `agentAddress` | 在授权规则内提交付款请求 |
| 资金池合约 | `walletAddress` | 持有并支付补给资金 |
| 收款运行钱包 | `recipientAddress` | 接收 ETH，余额显示在总览；收款不授予任何管理权限 |

资金池与运行钱包的余额分别读取。LLM 只生成草稿，不签名，也不能绕过审批。

## <img src="docs/images/section-screens.svg" width="24" height="24" alt="" align="absmiddle"> 产品截图

以下截图来自本地开发链（chain ID 31337），使用 Mock ETH/USD Feed。演示阈值基于实际余额设置，未伪造余额。

### 1. 发现运行储备不足

读取钱包真实余额 B，以 B + 0.0005 ETH 为演示下限、B + 0.001 ETH 为目标值，得到 0.001 ETH 的补充建议。

![本地链真实余额低于演示下限，显示 0.001 ETH 补充建议](docs/images/reserve-low.png)

### 2. 检查并明确确认

预览收款地址与 0.001 ETH 补充金额；按本地 Mock ETH/USD Feed 的演示价格估值为 3.00 美元。预览不会转账，仍须用户明确确认。

![确认抽屉预览 0.001 ETH 金额及 3.00 美元 Mock Feed 估值](docs/images/reserve-preview.png)

### 3. 刷新后恢复原任务

确认后的本地链转账使真实余额增加 0.001 ETH，储备恢复充足。刷新后仍显示同一个已执行任务，不会创建重复付款。

![刷新后储备充足，恢复原已执行任务且没有重复付款](docs/images/reserve-after-refresh.png)

### 4. 明暗主题与移动端

右上角的主题按钮可切换浅色与深色，选择保存在当前浏览器中。切换仅改变外观，不会提交付款或清空储备设置。下图为实际深色工作区，补给建议尚未提交。

![实际深色钱包工作区，本地链与 Mock Feed，保留相同的金额与确认边界](docs/images/reserve-dark.png)

390px 下的浅色与深色运行界面：运行钱包、储备设置和补给操作按纵向布局，底部导航保持可达。

<p align="center">
  <img src="docs/images/reserve-mobile.png" width="300" alt="实际浅色手机界面，显示运行钱包与 ETH 储备设置。">
  <img src="docs/images/reserve-mobile-dark.png" width="300" alt="同一钱包与设置的实际深色手机界面。">
</p>

## <img src="docs/images/section-flow.svg" width="24" height="24" alt="" align="absmiddle"> 完整用户流程

1. 用本地测试钱包（或浏览器钱包）以 Owner 身份签名登录；登录不授权付款。
2. 在总览读取运行钱包余额 B，将下限设为 B + 0.0005 ETH、目标值设为 B + 0.001 ETH。
3. 准备 0.001 ETH 的补充建议，检查确认抽屉后明确确认，查看任务、交易回执与事件证据。
4. 按初始 Mock 价格，0.002 ETH 的付款需要单独的 Owner 审批；0.004 ETH 超过单笔硬上限，将被阻止。Owner 审批不能绕过硬性限制。
5. 刷新页面恢复同一个任务。广播结果未知的交易会继续核对，不会被报告为付款成功，也不会被新付款替代。

预算按已执行付款累计消耗，待处理请求不会预占资金或预算。重复完整测试场景时，请使用全新的本地链与数据库。

## <img src="docs/images/section-features.svg" width="24" height="24" alt="" align="absmiddle"> 功能

- 读取运行钱包的真实 ETH 余额，并绑定返回的运行钱包地址与观测区块。
- 在浏览器本地设置储备下限与目标值，按“目标值减当前余额”精确计算补充金额；设置不是链上策略，也不是自动调度器。
- 准备付款前重新读取配置、余额与待处理任务；金额发生变化时，要求再次检查。
- 预览收款地址、ETH 金额、美元估值、用户确认的转账本金美元上限及审批要求。
- 用户明确确认后，持续跟踪原任务的执行、Owner 审批、取消或交易核对状态。
- 浅色与深色主题，记住当前浏览器的外观选择；桌面与移动端流程一致。

资金池余额、执行账户支付交易 Gas 的余额与收款钱包的运行储备相互独立。

## <img src="docs/images/section-chainlink.svg" width="24" height="24" alt="" align="absmiddle"> Chainlink 与 AI 的位置

**Chainlink ETH/USD Data Feed** 为转账本金定价，并参与合约的最终授权判断，包括审批时的重新校验：

- [AegisPriceOracle.sol](contracts/contracts/AegisPriceOracle.sol) 校验 Feed 轮次、价格、时间戳及精度，并将 USD6 估值向上取整。
- [AegisPolicyEngine.sol](contracts/contracts/AegisPolicyEngine.sol) 统一判断权限、白名单、审批阈值和共享每日美元预算。
- [AegisWallet.sol](contracts/contracts/AegisWallet.sol) 强制校验报价时效、用户确认的美元上限、单笔与共享每日限额、收款地址权限、nonce、截止时间及策略版本。
- [chain.ts](backend/src/chain.ts) 读取快照与报价、模拟执行，并校验交易和事件的绑定关系。
- [MockV3Aggregator.sol](contracts/contracts/mocks/MockV3Aggregator.sol) 提供本地演示与故障测试所需的数据。

ETH/USD 用于计算转账本金的美元价值，并非 Gas 价格预言机；发送方另行支付交易 Gas。

**AI。** 默认使用规则解析器；`AEGIS_LLM_MODE=live` 可接入 Anthropic 或 OpenAI-compatible 模型，仅生成草稿。`stub` 是离线测试模式，不代表真实模型效果。模型输出须通过结构和参数校验，旧值不能覆盖用户的新地址或新金额；缺失或有歧义的内容会要求补充。任何草稿都必须预览并经用户确认，解析结果不能绕过链上限额、实时价格或重放保护。配置方式见 [联调文档](docs/INTEGRATION.md)。

## <img src="docs/images/section-architecture.svg" width="24" height="24" alt="" align="absmiddle"> 架构与技术栈

```text
浏览器界面 ─ 本地 API 与 SQLite ─ 资金池合约 ─ ETH/USD Feed
 (Vite/TS)    (Node 24, viem, Zod)   (Solidity)   (本地为 Mock)
```

- 一个资金池、一个允许的收款运行钱包、一个 Owner、一个受限执行账户；Owner 登录与审批使用钱包签名。
- 本地链 31337 用于可重复测试；Ethereum Sepolia 为公共测试网络，验收状态见下文“验证”。
- 详见 [架构](docs/ARCHITECTURE.md)、[API 与本地集成](docs/INTEGRATION.md)、[安全边界](docs/SECURITY.md)。

## <img src="docs/images/section-start.svg" width="24" height="24" alt="" align="absmiddle"> 快速开始

需要 Node.js 24+ 与 npm。请在仓库根目录执行以下命令。

```bash
npm ci --ignore-scripts
```

> 如果 npm 12 报 `EALLOWGIT`：锁文件包含固定提交的 Git 依赖，请先核对依赖来源，再按 [npm 的 allow-git 配置](https://docs.npmjs.com/cli/v12/using-npm/config/#allow-git)处理安装策略。只把 SSH 改为 HTTPS 仍属于 Git 依赖；保留仓库锁文件。

终端 1：

```bash
npm run chain
```

终端 2，在 RPC 启动后执行：

```bash
npm run deploy:local
```

终端 3：

```bash
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。API 监听 3001 端口，本地 RPC 监听 8545 端口，chain ID 为 31337。选择明确标注的本地测试钱包入口，使用公开的开发用 Owner 账户登录。这些开发账户与 ETH 没有现实价值，不得用于存放真实资金。

部署脚本向资金池注入 1 ETH，并设置无需单独 Owner 审批的 5 美元阈值、10 美元单笔硬上限及 15 美元共享 UTC 每日预算。本地 Mock Feed 的初始价格为每 ETH 3,000 美元。

目录：`frontend/`（Vite + TypeScript 界面）、`backend/`（Node.js、viem、Zod、SQLite）、`contracts/`（Solidity、Hardhat、部署与合约测试）、`packages/shared/`（API 类型与 ABI）、`agent/skills/`（意图解析提示词；其他 Python 原型不在当前运行链路中）。

## <img src="docs/images/section-verify.svg" width="24" height="24" alt="" align="absmiddle"> 验证

```bash
npm run check
npm run test:e2e
```

2026 年 10 月 20 日在合并后的主线版本、Node 24 环境下验证通过：类型检查与生产构建、**34 项合约测试**、**45 项后端测试（含嵌套测试）**、**16 个浏览器用例**（钱包与连接组 9 个、储备组 7 个）。另有 **7 项离线模型启动器测试**。浏览器用例覆盖本地真实付款、Owner 审批与取消、登录时账户变化、断连和刷新恢复。

合约测试覆盖授权、预言机边界、预算、审批、重放及直接调用拒绝。后端测试通过明确的链测试夹具覆盖 HTTP 边界、持久化恢复、事件绑定与运行钱包地址绑定。浏览器测试使用真实本地合约与余额以及 Mock Feed，覆盖确认、审批与取消、建议金额变化、数据缺失、运行钱包身份缺失或不一致、离线失败，以及刷新后不重复付款。

浏览器测试入口为每组测试启动全新的链与数据库。运行前，请先停止手动运行且占用 5173、3001、8545 端口的服务。Windows 可使用已安装的 Chrome；其他环境可能需要执行 `npx playwright install chromium`。

### 部署与执行证据

本地付款流程已验证。Sepolia 已有部署与只读绑定校验记录，最新策略引擎版本的网页付款闭环仍待验收。真实模型评测的汇总与限制见 [意图评测报告](eval/REPORT.md)；历史分数不代表当前版本的测试结果。

当前演示覆盖单资金池、单收款运行钱包与原生 ETH；定时自动付款、多钱包管理、订阅和 CCIP 跨链不在交付范围。

当前公开的付款执行证据均来自本地链，Sepolia 网页付款尚无已验收的记录。执行 `npm run deploy:local` 后，实际合约地址写入本机的 `contracts/deployments/localhost.json`。每笔已执行任务可在界面的验证记录中核对交易回执、合约事件、收款地址、金额与请求哈希。

公共网络部署经独立核验、网页付款验收通过后，再公开对应网络的实际合约地址和交易链接。只读 Feed 连通性检查不代表 Aegis 已部署或已付款。

## <img src="docs/images/section-team.svg" width="24" height="24" alt="" align="absmiddle"> 团队与文档

<a href="https://github.com/mia03ther"><img src="https://github.com/mia03ther.png?size=80" width="28" height="28" alt="mia03ther 的 GitHub 头像" align="absmiddle"> <b>MIA_Ether</b></a> — 产品 · 前端 · 集成<br>
<a href="https://github.com/gitgdut"><img src="https://github.com/gitgdut.png?size=80" width="28" height="28" alt="gitgdut 的 GitHub 头像" align="absmiddle"> <b>purple sun</b></a> — 后端 · 合约<br>
<a href="https://github.com/qiwei999"><img src="https://github.com/qiwei999.png?size=80" width="28" height="28" alt="qiwei999 的 GitHub 头像" align="absmiddle"> <b>qiwei999</b></a> — AI 意图解析 · 边界校验<br>
<a href="https://github.com/mantianxingdou10086"><img src="https://github.com/mantianxingdou10086.png?size=80" width="28" height="28" alt="mantianxingdou10086 的 GitHub 头像" align="absmiddle"> <b>满天星斗烟火繁</b></a> — Agent 工程 · 意图评测

| 文档 | 内容 |
|---|---|
| [架构](docs/ARCHITECTURE.md) | 组件、身份与余额、储备与付款生命周期 |
| [API 与本地集成](docs/INTEGRATION.md) | 接口、本地运行与验证记录 |
| [安全边界](docs/SECURITY.md) | 授权、完整性与已知限制 |
| [合约规则](contracts/README.md) | 链上授权规则与本地部署 |
| [界面设计系统](frontend/DESIGN.md) | 布局、明暗主题、组件与可访问性 |
| [真实 LLM 联调](docs/LLM-LIVE-LOCAL.md) | live 模式的环境变量、启动脚本与本地联调限制 |
| [意图评测报告](eval/REPORT.md) | 40 条样本、三种解析器的结果与失败归因 |

[贡献者](https://github.com/0xChainAegis/aegis-agent/graphs/contributors) · MIT 许可证，参见 [LICENSE](LICENSE)。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/aegis-footer-dark.svg">
    <img src="docs/images/aegis-footer-light.svg" width="100%" alt="Aegis 页脚标识">
  </picture>
</p>
