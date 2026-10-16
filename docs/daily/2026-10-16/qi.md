# 2026-10-16 合约与边界验证（某齐任务）报告

## 基线

- 仓库：`0xChainAegis/aegis-agent`（origin 已核对为指定组织仓库）
- 任务书给点：`origin/codex/integration-wallet-ui`，已知交付基线 `c3164e6a16fe6a324b47e04168481dacc5c3db73`
- 本机 fetch 后集成分支最新 SHA（起分支所用）：`a3bd9fbbea94745d1f601852ab21570ffd2ff853`（10-16 10:52）
- 任务分支：`qi/1016-oracle-approval-regressions`（基于 `a3bd9fb`）
- 未从旧 main、`docs/verifiable-policy` 或个人 fork 起分支；未改动他人未提交工作

## 新增文件与测试（共 5 项）

1. `contracts/test/AegisPriceOracle.test.js`（2 项）
   - `quotes native ETH in USD6 across supported feed decimals with ceiling rounding`
   - `rejects feed decimals above 18 before locking`
2. `contracts/test/AegisWallet.boundaries.test.js`（3 项）
   - `rechecks stale feed on pending approval and recovers with a fresh round`
   - `treats age equal to maxPriceAge as fresh and one second older as stale`
   - `keeps a queued payment pending when another payment consumes its ETH balance`

## 真实命令与结果（本机）

环境：**node v24.22.0 / npm 11.19.1**（本地独立安装在 `D:\黑客松\.node24`，未改系统 PATH；用于复核仓库声明的 `engines >=24`）。同一套命令也在 node v22.23.3 / npm 10.9.9 上跑过，两边结果一致。

- `npm ci --ignore-scripts` → added 466 packages
- `npm exec --workspace contracts -- hardhat compile --force`（Node 24）→ Compiled 26 Solidity files successfully（本地 pinned solc 0.8.24）
- `npm exec --workspace contracts -- hardhat test test/AegisPriceOracle.test.js` → **2 passing**
- `npm exec --workspace contracts -- hardhat test test/AegisWallet.boundaries.test.js` → **3 passing**
- `npm run test:contracts` → **24 passing**（原有 19 项无回归 + 新增 5 项；Node 24 与 Node 22 均通过）
- `git diff --check` → 通过（无空白问题）

## 对应任务书的边界

- **P0-A 已排队付款的价格新鲜度重检与恢复**：报价过期时审批 `revert ORACLE_STALE`；pending 原样保留、attestation 未批准、收款余额与预算不变、不额外消耗 nonce。随后只补一轮同价新数据，Owner 对同一 `attestationId` 重新审批成功：只付款一次、pending 删除、`spentUsd6 = $6`、执行事件 `requestHash` 与原 pending 一致、`roundId/updatedAt` 来自新轮次。
- **P0-B Feed 精度的独立算术验证**：0/6/8/18 位小数、$3,000、向上取整；期望值全部用纯 BigInt 独立计算（`ceil(amountWei * answer / 10^(12+decimals))`）；1 wei 至少计 1 USD6；>18 位精度在锁定前被 `UNSUPPORTED_DECIMALS` 拒绝，且 `configurationLocked` 保持 false。
- **P1-C 待审批付款的余额竞争**：pending 不预留余额；另一笔自动付款（$4.5）花掉金库后，审批原 $6 请求精确 `revert INSUFFICIENT_BALANCE`（此时日预算仍然足够，触发条件确认为余额）；失败审批不改变收款余额与预算；通过真实 `depositETH` 补足后重新审批成功，总预算 `$10.5`，同一 `attestationId` 之后 `NO_PENDING`。

## 发现的缺陷与修复

- **未发现合约缺陷；未修改 `contracts/contracts/` 任何文件。**
- 测试方法学备注（非合约缺陷）：`eth_call` 不采用 `evm_setNextBlockTimestamp` 指定的下一区块时间，因此 `maxPriceAge` 精确边界断言改用**真实交易**在精确时间戳的区块中执行，避免把工具行为误判为合约行为。

## 仍未验证

- Sepolia 真实 Feed、公网部署与交易（本日范围外，有意未做）。
- 后端/前端对这两种审批失败的 UI 呈现与恢复提示（本日不跨目录修改）。

## 给 purple sun 的交接

- 审批时链上可能出现：`ORACLE_STALE`（报价过期）与 `INSUFFICIENT_BALANCE`（金库余额不足）。两者都会**保留 pending**、不消耗额外 nonce、不改变已花预算与收款余额。
- 只有匹配的 `NativeTransferExecuted` 事件（`requestHash`、`attestationId`、`roundId`、`updatedAt`、`costUsd6`）才算付款完成；单独的 `approved` 标志不代表付款。
- 恢复条件满足后（Feed 出新轮次 / 真实补款），仍需 Owner 对**同一个**待审批请求重新签 `approveAndExecute`；不要自动重建付款，也不要绕过 Owner 审批。
- **ABI 与错误字符串完全未变**（本日无合约改动）：事件字段保持 `NativeTransferExecuted(requestHash, attestationId, agent, to, amountWei, costUsd6, roundId, updatedAt, policyVersion)`；错误串 `ORACLE_STALE`、`INSUFFICIENT_BALANCE` 未变。
- 建议（由 backend 负责人决定）：把这两种失败归类为"可恢复的审批失败"——保留并展示原请求，提示用户重新确认，而不是重建付款或自动重试。

## 提交与推送

- `ad47cad` `test(contracts): quote native ETH in USD6 across feed decimals`
- `7862285` `test(contracts): recheck stale feed and vault balance on pending approval`
- 已推送：`origin/qi/1016-oracle-approval-regressions`（`7862285`）；本报告提交后一并推送到同一分支。

## PR 草案（由某齐创建并指定 review 人）

- 目标分支：`codex/integration-wallet-ui`（**不要**选旧 main）
- 标题：`test: cover oracle precision and pending approval boundaries`
- 描述：

```text
## 问题
付款授权在"已排队等待审批"阶段仍可能因报价过期或金库余额被其他付款占用而失败；此前没有对应回归用例。

## 本 PR
- 新增 contracts/test/AegisPriceOracle.test.js：0/6/8/18 位小数精度、向上取整、>18 位拒绝（2 项）
- 新增 contracts/test/AegisWallet.boundaries.test.js：排队审批的 ORACLE_STALE 重检与恢复、maxPriceAge 精确边界、INSUFFICIENT_BALANCE 余额竞争（3 项）
- 无合约源码改动；ABI/事件/错误字符串不变

## 验证（本机）
- npm run compile → 26 files；npm run test:contracts → 24 passing（19 原有 + 5 新增，无回归）
- 环境：node v22.23.3（仓库声明 >=24）、Hardhat 2.26.5、本地 Mock Feed + chain 31337；未做 Sepolia/公网验证

## 范围
仅本地集成回归测试；不含部署脚本修改、不含前端/后端改动。

建议 review：purple sun 核对 ABI 与事件假设；MIA 核对验收是否对应用户行为。
```
