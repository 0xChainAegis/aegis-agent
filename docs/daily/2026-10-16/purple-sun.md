# Purple Sun：支付恢复边界测试报告

- 日期：2026-10-16
- 负责人：Purple Sun
- 工作分支：`purple/1016-recovery-boundaries`
- PR 目标分支：`codex/integration-wallet-ui`
- 基线提交：`a3bd9fbbea94745d1f601852ab21570ffd2ff853`
- 测试提交：`ca55f37c1f16f1d326d811e68a851e0e8a49231b`
- 运行环境：Node.js `v24.21.0`
- 结论：后端全量测试 26/26 通过，TypeScript 类型检查通过；本次没有修改生产代码、接口或共享类型。

## 1. 任务目的

本任务补齐付款流程在异常中断、服务重启和链上结果校验时的恢复边界，重点验证：

1. 已完成签名并持久化、但尚未广播时发生中断，重启后能否复用原交易，且不会提前处理下一笔 nonce。
2. Owner 审批交易没有由浏览器上报哈希时，服务重启后能否通过已知任务数据发现 approve/cancel 结果。
3. `ViemGateway.outcome` 是否严格绑定正确的交易发送者、目标合约、calldata、value、request hash 和业务事件。
4. HTTP 写接口是否拒绝非法输入和未授权请求，响应是否泄露敏感字段。

源码中的实际付款顺序为：`submit` 落任务 → `prepare` 签名 → 保存 raw/hash/nonce → `broadcast` → 查询 receipt 和业务事件。恢复测试围绕这条真实顺序构造，没有更改生产流程。

### 原问题与复现

基线已覆盖广播被节点接受后客户端超时的恢复，但以下相邻窗口缺少可重复的回归证明：

- `prepare` 的真实结果已经落库、`broadcast` 尚未进入时服务中断。
- `AWAITING_APPROVAL` 跨重启，且网页来不及上报 Owner 交易哈希。
- `FakeChain.outcome` 测试无法独立证明生产 `ViemGateway.outcome` 的交易和事件绑定正确。
- 选定的 HTTP 输入校验及响应脱敏边界缺少集中回归。

复现方式就是分别运行第 4、5 节的定向命令；在新增测试之前，这些边界没有对应测试用例，而不是已有用例失败。本次新增回归全部通过，未暴露需要修改生产代码的缺陷。

基线已有 8 项后端测试通过。该截图只显示历史基线汇总，用作改动前的辅助证据；最终完整回归结果见第 6 节。

![改动前的历史测试基线：8 项通过](<./images/Screenshot 2026-10-16 215822.png>)

## 2. 实际改动

### `backend/test/api.test.ts`

- 在真实 `prepare` 结果写入 SQLite 后、进入 `broadcast` 前注入一次持久化失败。
- 使用同一临时 SQLite 文件重建服务，验证重启后广播的是同一笔已签名交易。
- 验证第一笔交易未解决前，下一笔排队任务不会获取 nonce。
- 覆盖重启后发现 Owner approve/cancel、Owner 交易未上链、Owner 交易回滚等结果。
- 覆盖缺失/非法幂等键、非法 JSON、未知字段、未授权写请求，以及敏感响应字段过滤。

### `backend/test/chain.test.ts`

- 直接调用真实的 `ViemGateway.outcome` 方法。
- 使用可控的 viem client fixture 返回交易、receipt 和日志。
- 覆盖正确事件，以及 sender、target、calldata、value、request hash、日志合约地址、事件缺失、未上链和回滚等错误情况。

没有修改 `backend/src`、合约、前端、共享类型、ABI、根目录脚本或 CI 配置。

## 3. 环境与类型检查

执行命令：

```bash
git branch --show-current
git log -1 --oneline
node --version
npm run typecheck --workspace backend
```

结果：分支为 `purple/1016-recovery-boundaries`，测试提交为 `ca55f37`，Node.js 为 `v24.21.0`，后端 `tsc --noEmit` 正常退出。

![分支、提交、Node.js 版本及后端类型检查](<./images/Screenshot 2026-10-16 220913.png>)

此外执行了仓库级 `npm run typecheck`，结果通过。

## 4. 三个 P0 恢复案例

### 案例 A：持久化后、广播前中断

执行命令：

```bash
node --import tsx --test \
  --test-name-pattern="persisted before broadcast" \
  backend/test/api.test.ts
```

验证结果：1/1 通过。

- 第一次执行在已签名交易写入 SQLite 后故障退出。
- 重建服务后复用完全相同的 raw transaction 和 transaction hash。
- 恢复中的第一笔交易只广播一次。
- 第一笔未解决时，下一笔排队任务不会获得 nonce。

![案例 A：持久化后广播前的恢复测试](<./images/Screenshot 2026-10-16 221117.png>)

### 案例 B：服务重启后恢复 Owner 决策

执行命令：

```bash
node --import tsx --test \
  --test-name-pattern="owner outcomes discovered|reported owner transaction" \
  backend/test/api.test.ts
```

验证结果：5/5 通过。

- 未上报 Owner 交易哈希时，重启后仍能发现 approve 结果。
- 未上报 Owner 交易哈希时，重启后仍能发现 cancel 结果。
- Owner 交易尚未上链时，任务保持等待/排队状态。
- 已上报但回滚的 Owner 交易不会把付款标记为完成。
- 相关审批恢复路径没有造成后续付款错误推进。

![案例 B：Owner approve、cancel、pending 和 reverted 结果](<./images/Screenshot 2026-10-16 221142.png>)

### 案例 C：真实 `ViemGateway.outcome` 的交易与事件绑定

执行命令：

```bash
node --import tsx --test backend/test/chain.test.ts
```

验证结果：11/11 通过。

覆盖内容：

- 正确交易及正确业务事件返回有效 outcome。
- sender、target、calldata 或 value 不匹配时拒绝结果。
- request hash 不匹配时拒绝结果。
- 外部合约伪造日志或缺少预期事件时拒绝结果。
- receipt 未产生时保持 pending。
- receipt 回滚时返回 failed。

![案例 C：ViemGateway outcome 的 11 项验证](<./images/Screenshot 2026-10-16 221236.png>)

## 5. HTTP 接口边界

执行命令：

```bash
node --import tsx --test \
  --test-name-pattern="HTTP boundaries" \
  backend/test/api.test.ts
```

验证结果：1/1 通过。该组合测试覆盖：

- 缺失或非法的幂等键。
- 非法 JSON 和请求体中的未知字段。
- 未授权写请求。
- 响应不暴露 raw transaction、execution key、session token 或含认证信息的 RPC URL。

基线中已有的“同一幂等键但不同请求体返回 409”和“过期 `expectedRevision` 返回 409”用例也在第 6 节全量回归中继续通过；本次没有重复包装为新功能。

这些边界的意义是把不可信 HTTP 输入挡在状态机和签名流程之外，同时防止可用于签名、会话冒用或 RPC 认证的材料通过接口响应泄露。

![HTTP 输入校验和响应脱敏边界](<./images/Screenshot 2026-10-16 221339.png>)

## 6. 全量回归

执行命令：

```bash
npm run test:backend
```

结果：26 项通过、0 项失败、0 项跳过。

![后端全量回归：26 项全部通过](<./images/Screenshot 2026-10-16 221410.png>)

最终检查命令：

```bash
git show --stat --oneline HEAD
git diff HEAD^ --check
```

`git diff HEAD^ --check` 无输出并以状态码 0 结束，表示该提交不存在空白字符错误。截图中的 `git status --short` 无输出，是加入本报告截图附件前、测试提交 `ca55f37` 的干净状态记录。

![测试提交统计和 diff 格式检查](<./images/Screenshot 2026-10-16 221540.png>)

## 7. 证据边界与尚未覆盖项

- 案例 A/B 使用临时 SQLite 和显式 `FakeChain`，证明单进程持久化及状态机恢复边界；它不等同于操作系统级崩溃、多实例并发签名或真实节点验证。
- 案例 C 执行的确实是生产代码中的 `ViemGateway.outcome` 和真实 viem 解码路径，但 client 的交易、receipt 和日志响应是可控 fixture；因此不能据此声称已验证真实 RPC 事件过滤或链重组行为。
- 本次没有运行本地链浏览器 E2E，也没有在 Sepolia 或主网广播交易。
- 现有实现仍以单个已挖出 receipt 作为足够确认，没有覆盖多确认块最终性。
- 本次没有验证多进程/多实例之间的 nonce 协调。

## 8. API 兼容性与安全说明

- HTTP 请求/响应结构未变。
- shared types 和 ABI 未变。
- 前端调用方式未变。
- 合约行为未变。
- 没有新增环境变量或运行时依赖。
- 文档和截图不包含私钥、助记词、Bearer token、raw transaction、带认证信息的 RPC 地址或 `.env` 内容。

## 9. 交接说明

- 给 MIA：本次没有 API 或共享类型变化，UI 不需要适配；可以继续按现有响应结构联调。
- 给某齐：请重点复核 `backend/test/chain.test.ts` 中钱包事件字段和 request hash 的绑定假设；集成负责人可在环境空闲时运行现有本地链 E2E，补充真实 RPC 路径证据。

## 10. PR 建议

PR 目标：`codex/integration-wallet-ui`

标题：

```text
test(backend): cover persisted payment recovery boundaries
```

正文：

```text
## Summary

- add regression coverage for SQLite recovery after signing and before broadcast
- recover Owner approve/cancel outcomes across service restart
- exercise the real ViemGateway receipt/event binding with controlled viem fixtures
- cover selected HTTP validation and response-redaction boundaries

## Validation

- npm run typecheck --workspace backend
- npm run typecheck
- npm run test:backend (26 passed, 0 failed)
- git diff --check

## Scope

Production code, APIs, shared types, contracts and frontend behavior are unchanged.
The tests use SQLite/FakeChain or controlled viem fixtures and do not claim live-RPC,
local-chain browser E2E or public-testnet coverage.
```

## 11. 交付文件与 Git

- `backend/test/api.test.ts`：案例 A/B 及 HTTP 边界回归。
- `backend/test/chain.test.ts`：案例 C 的真实 `ViemGateway.outcome` 单元测试。
- `docs/daily/2026-10-16/purple-sun.md`：本报告。
- `docs/daily/2026-10-16/images/`：本报告引用的 8 张测试截图。

测试代码提交：`ca55f37c1f16f1d326d811e68a851e0e8a49231b`。

分支推送后地址：[purple/1016-recovery-boundaries](https://github.com/0xChainAegis/aegis-agent/tree/purple/1016-recovery-boundaries)。截图和本报告需要作为后续文档提交一并加入该任务分支，然后以 `codex/integration-wallet-ui` 为 base 创建 PR；不要直接推送或合并集成分支。
