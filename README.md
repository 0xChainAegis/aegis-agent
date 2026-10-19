<p align="center">
  <img src="docs/images/aegis-hero.png" alt="Aegis 原创品牌主视觉：暖白背景、石墨黑字标与陶瓷材质的 A 应用图标。概念图，实际产品界面见下方截图。" width="100%">
</p>

<h1 align="center">给智能体补给。<br>让每笔支出可控。</h1>

<p align="center">
  AegisAgent · 为智能体运行钱包补充 Gas 储备。<br>
  <strong>链上美元预算 · 用户明确确认 · 可核对的执行结果</strong>
</p>

<p align="center">
  <a href="README.en.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="#chainlink-与-ai-的位置"><img src="https://img.shields.io/badge/Chainlink-Data%20Feeds-375BD2?style=flat-square&amp;logo=chainlink&amp;logoColor=white" alt="Chainlink Data Feeds 集成"></a>
  <img src="https://img.shields.io/badge/Demo-Local%20chain%2031337-59615F?style=flat-square&amp;labelColor=252B2A" alt="本地链 31337 演示">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-59615F?style=flat-square&amp;labelColor=252B2A" alt="MIT 许可证"></a>
</p>

<p align="center">
  <a href="#问题与方案">问题与方案</a> ·
  <a href="#架构与技术栈">架构</a> ·
  <a href="#chainlink-与-ai-的位置">Chainlink</a> ·
  <a href="#产品截图">截图</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#验证">验证</a> ·
  <a href="#团队">团队</a>
</p>

本项目诞生于 ETH Shenzhen 2026 黑客松。

- **已验证：** 本地开发链（31337）与 Mock ETH/USD Feed，单资金库、单运行钱包的原生 ETH 补给流程。
- **意图输入：** 规则解析器生成草稿，缺失或有歧义的内容会要求补充。
- **待交付：** 应用内真实 Chainlink Feed 验证、Sepolia 部署与付款、在线 LLM。

## 问题与方案

**问题。** 智能体的运行钱包需要原生 ETH 来支付交易费用。余额耗尽时智能体会停止工作；而让它自行补款，又意味着把资金权限交给自动化流程。

**方案。** Aegis 读取一个指定运行钱包的真实 ETH 余额，按用户设置的下限与目标值建议补充金额，并由资金库合约在链上美元限额内、经用户明确确认后执行转账。

## 架构与技术栈

```text
浏览器界面 ─ 本地 API 与 SQLite ─ 资金库合约 ─ ETH/USD Feed
 (Vite/TS)    (Node 24, viem, Zod)   (Solidity)   (本地为 Mock)
```

- 一个资金库、一个允许的运行钱包、一个 Owner、一个受限执行账户；Owner 登录与审批使用钱包签名。
- 本地链 31337 用于可重复测试；Ethereum Sepolia 是唯一计划中的公共网络目标，尚未部署验证。
- 详见 [架构](docs/ARCHITECTURE.md)、[API 与本地集成](docs/INTEGRATION.md)、[安全边界](docs/SECURITY.md)。

## 功能

- 读取运行钱包的真实 ETH 余额，并绑定返回的运行钱包地址与观测区块。
- 在浏览器本地设置储备下限与目标值，按“目标值减当前余额”精确计算补充金额；设置不是链上策略，也不是自动调度器。
- 准备付款前重新读取配置、余额与待处理任务；金额发生变化时，要求再次检查。
- 预览收款地址、ETH 金额、美元估值、可接受的最高费用及审批要求。
- 用户明确确认后，持续跟踪原任务的执行、Owner 审批、取消或交易核对状态。

资金库余额、执行账户支付交易 Gas 的余额与收款钱包的运行储备相互独立。

## Chainlink 与 AI 的位置

**Chainlink ETH/USD Data Feed** 为转账本金定价，并参与合约的最终授权判断，包括审批时的重新校验：

- [AegisPriceOracle.sol](contracts/contracts/AegisPriceOracle.sol) 校验 Feed 轮次、价格、时间戳及精度，并将 USD6 估值向上取整。
- [AegisWallet.sol](contracts/contracts/AegisWallet.sol) 强制校验报价时效、用户确认的美元上限、单笔与共享每日限额、收款地址权限、nonce、截止时间及策略版本。
- [chain.ts](backend/src/chain.ts) 读取快照与报价、模拟执行，并校验交易和事件的绑定关系。
- [MockV3Aggregator.sol](contracts/contracts/mocks/MockV3Aggregator.sol) 提供本地演示与故障测试所需的数据。

ETH/USD 用于计算转账本金的美元价值，并非 Gas 价格预言机；发送方另行支付交易 Gas。

**AI。** 目前没有在线大模型参与：自然语言输入只由规则解析器生成草稿，缺失或有歧义的内容（例如美元金额）会要求用户补充。任何草稿都必须预览并经用户确认，解析结果不能绕过确认、链上限额、实时价格或重放保护。

**状态。** 已验证：本地链 + Mock Feed。尚未验证：真实 Feed 读取、Sepolia 部署与付款、真实 LLM。

## 产品截图

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

## 完整用户流程

1. 用本地测试钱包（或浏览器钱包）以 Owner 身份签名登录；登录不授权付款。
2. 在总览读取运行钱包余额 B，将下限设为 B + 0.0005 ETH、目标值设为 B + 0.001 ETH。
3. 准备 0.001 ETH 的补充建议，检查确认抽屉后明确确认，查看任务、交易回执与事件证据。
4. 按初始 Mock 价格，0.002 ETH 的付款需要单独的 Owner 审批；0.004 ETH 超过单笔硬上限，将被阻止。Owner 审批不能绕过硬性限制。
5. 刷新页面恢复同一个任务。广播结果未知的交易会继续核对，不会被报告为付款成功，也不会被新付款替代。

预算按已执行付款累计消耗，待处理请求不会预占资金或预算。重复完整测试场景时，请使用全新的本地链与数据库。

## 快速开始

需要 Node.js 24+ 与 npm。请在仓库根目录执行以下命令。

```bash
npm ci --ignore-scripts
```

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

部署脚本向资金库注入 1 ETH，并设置无需单独 Owner 审批的 5 美元阈值、10 美元单笔硬上限及 15 美元共享 UTC 每日预算。本地 Mock Feed 的初始价格为每 ETH 3,000 美元。

目录：`frontend/`（Vite + TypeScript 界面）、`backend/`（Node.js、viem、Zod、SQLite）、`contracts/`（Solidity、Hardhat、部署与合约测试）、`packages/shared/`（API 类型与 ABI）、`agent/`（早期 Python 原型，不在当前运行链路中）。

## 验证

```bash
npm run check
npm run test:e2e
```

2026 年 10 月 19 日使用 Node 24.19.0 在本地完成验证：类型检查与生产构建；**27 项合约测试**、**28 项后端测试（含嵌套测试）**；独立钱包与储备测试环境中的 **9 个浏览器用例**（钱包组 2 个、储备组 7 个）。

合约测试覆盖授权、预言机边界、预算、审批、重放及直接调用拒绝。后端测试通过明确的链测试夹具覆盖 HTTP 边界、持久化恢复、事件绑定与运行钱包地址绑定。浏览器测试使用真实本地合约与余额以及 Mock Feed，覆盖确认、审批与取消、建议金额变化、数据缺失、运行钱包身份缺失或不一致、离线失败，以及刷新后不重复付款。

浏览器测试入口为每组测试启动全新的链与数据库。运行前，请先停止手动运行且占用 5173、3001、8545 端口的服务。Windows 可使用已安装的 Chrome；其他环境可能需要执行 `npx playwright install chromium`。

## 团队

<table align="center">
  <tr>
    <td align="center" width="220"><a href="https://github.com/mia03ther"><img src="https://github.com/mia03ther.png?size=120" width="72" height="72" alt="mia03ther 的 GitHub 头像"><br><b>MIA_Ether</b></a><br>产品 · 前端 · 集成</td>
    <td align="center" width="220"><a href="https://github.com/gitgdut"><img src="https://github.com/gitgdut.png?size=120" width="72" height="72" alt="gitgdut 的 GitHub 头像"><br><b>purple sun</b></a><br>后端 · 合约</td>
    <td align="center" width="220"><a href="https://github.com/qiwei999"><img src="https://github.com/qiwei999.png?size=120" width="72" height="72" alt="qiwei999 的 GitHub 头像"><br><b>qiwei999</b></a><br>AI 意图解析 · 边界校验</td>
  </tr>
</table>

### 文档

| 文档 | 内容 |
|---|---|
| [架构](docs/ARCHITECTURE.md) | 组件、身份与余额、储备与付款生命周期 |
| [API 与本地集成](docs/INTEGRATION.md) | 接口、本地运行与验证记录 |
| [安全边界](docs/SECURITY.md) | 授权、完整性与已知限制 |
| [合约规则](contracts/README.md) | 链上授权规则与本地部署 |

[贡献者](https://github.com/0xChainAegis/aegis-agent/graphs/contributors)

MIT 许可证 — 参见 [LICENSE](LICENSE)。
