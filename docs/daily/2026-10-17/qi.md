# 2026-10-17 合约直接调用与审批边界（某齐任务）报告

## 基线

- 仓库：`0xChainAegis/aegis-agent`
- 基线：`origin/codex/integration-wallet-ui` @ `a3bd9fbbea94745d1f601852ab21570ffd2ff853`
- 任务分支：`qi/1017-direct-call-security-cases`
- 本日只改 `contracts/test/` 和本报告；未修改合约源码、前端、后端、共享包、根配置或 CI。

## 新增验证（3 项）

新增 `contracts/test/AegisWallet.direct-call.test.js`：

1. `blocks a direct request to a recipient that was never allowlisted`
   - Agent 绕过 UI 直接请求从未进入白名单的地址。
   - 精确 `revert RECIPIENT_NOT_ALLOWED`。
   - Agent nonce 仍为 0、attestation `nextId` 仍为 1（没有创建新记录）、`spentUsd6` 仍为 0。
2. `does not treat the wallet owner as an agent for direct requests`
   - Owner 绕过 Agent 身份直接发起付款请求。
   - 精确 `revert NOT_AGENT`，Owner nonce 仍为 0。
3. `rejects every invalid feed state at approval time without changing pending evidence`
   - 先创建一笔 $6 的合法待审批请求，再分别把 Feed 改成：answer 为 0、answer 为负数、轮次未完成、时间戳在未来、decimals 变为 18。
   - 审批时分别精确 `revert ORACLE_BAD_ANSWER`、`ORACLE_INCOMPLETE_ROUND`、`ORACLE_BAD_TIMESTAMP`、`ORACLE_DECIMALS_CHANGED`。
   - 每次失败后都断言：pending 仍存在、attestation `approved` 仍为 false、收款人余额不变、`spentUsd6` 仍为 0、排队时已消耗的 Agent nonce 不会再次变化。

## 相对现有 19 项的价值

现有测试已经覆盖非 Agent/Frozen/ReadOnly、单笔与共享日额、nonce 重放、过期、策略版本、Owner 无法绕过硬限额，以及请求阶段的 Feed 异常。新增用例补的是三个不同缺口：

- “从未被 allowlist”本身需要 fail closed；现有相关用例主要验证白名单修改后旧 pending 失效。
- `owner` 这个身份不能自动等同于可执行付款的 `agent`；避免把“合约管理员”和“资金执行者”混为一谈。
- 请求时报价合法，不代表 Owner 审批时仍合法；审批必须重新读取并校验 Feed，这是待审批窗口内的真实攻击面。

这些断言都直接读取合约状态和真实 ETH 余额，不依赖 UI、正则或 AI Judge。

## 本机验证

环境：本地 Node `v24.22.0`，使用仓库锁定依赖；本地 Hardhat 链与 Mock Feed。

- `npm exec --workspace contracts -- hardhat test test/AegisWallet.direct-call.test.js`
  - **3 passing**
- `npm run compile`
  - **Nothing to compile**（未改合约源码）
- `npm run test:contracts`
  - **22 passing**（集成分支原有 19 项 + 新增 3 项，无回归）

## 未验证

- 未连接 Sepolia、真实 Chainlink Feed，未广播任何公网交易。
- 未验证前端如何展示上述错误；本日不跨目录修改。
- 未声称模型或 EZKL 已进入合约付款前置条件；本日只验证链上硬边界和直接调用路径。

## 给 MIA 的可展示证据（仅本地链）

现场如果需要演示“绕过界面直接攻击”，可以展示三组“攻击 → 被链上拒绝”：

- 请求一个从未白名单化的收款地址 → `RECIPIENT_NOT_ALLOWED`
- 用 Owner 身份冒充 Agent 发起请求 → `NOT_AGENT`
- 先让合法请求排队，再把 Feed 变坏后审批 → `ORACLE_BAD_ANSWER` / `ORACLE_INCOMPLETE_ROUND` / `ORACLE_BAD_TIMESTAMP` / `ORACLE_DECIMALS_CHANGED`

第三组同时能看到：pending 和 attestation 保留、`approved` 仍为 false、余额与预算不变；失败只拒绝这一次审批，不会伪造“已经付款成功”的记录。

## 给 purple sun / MIA 的交接

- 以上错误均来自本地 Mock Feed 和本地链，不代表 Sepolia 已实测。
- 合约 ABI、事件和错误字符串未改变；本日没有合约源码改动。
- 前端展示时应把这类错误明确标成“链上拒绝”，不能把 pending 存在或 attestation 已创建当作付款完成；只有匹配的执行事件和实际余额变化才算完成。
- 若要公网演示，仍需要对真实 Feed 的新鲜度、失败提示和恢复流程单独验收。

## 提交与 PR

- 测试提交：`c36f657` `test(contracts): block direct calls that bypass hard boundaries`
- 本报告作为同一任务分支的后续文档提交。
- 目标分支：`codex/integration-wallet-ui`
- 建议 PR 标题：`test(contracts): block direct calls that bypass hard boundaries`
- PR 描述要点：三个新增用例、22 项全过、无合约源码改动、仅本地 Mock Feed 验证。
