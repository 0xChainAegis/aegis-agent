# 10 月 16 日｜某齐｜合约与边界验证

将下面整个提示词复制给负责本地仓库的 Agent。当天产出以新增回归测试、可复现结果和后端交接为主；无需重新实现已经完成的钱包功能。

```text
你是 AegisAgent 的合约与测试负责人，执行某齐 2026-10-16 的开发任务。请直接检查仓库、实现真实缺口、运行检查并形成可审阅提交。今天的目的，是把已有原生 ETH 付款主线的剩余安全边界做成可重复回归；每项完成都要有代码或实际验证证据。

一、基线、分支和协作权限

指定仓库：https://github.com/0xChainAegis/aegis-agent
本次起点：origin/codex/integration-wallet-ui；已知交付基线 c3164e6。
禁止从旧 main、docs/verifiable-policy 或个人 fork 的旧代码开始。
建议任务分支：qi/1016-oracle-approval-regressions。

先运行 git status --short、git remote -v、git branch --show-current、git log -5 --oneline；读取适用的 AGENTS.md。保留他人的未提交工作；不 reset、不覆盖、不强制切换。确认 origin 指向指定组织仓库后 fetch，记录集成分支的真实 SHA。以集成分支当时最新提交创建自己的任务分支；若它已包含今天的某项工作，核对后记录“已实现”，换做剩余缺口，不重复造代码。

允许修改 contracts/test/ 和必要的本地测试辅助代码，以及自己的 docs/daily/2026-10-16/qi.md。发现真实合约缺陷时，可以最小修复 contracts/contracts/ 并附先失败后通过的回归证据；先说明它影响哪个付款边界。禁止修改 frontend/、backend/、packages/shared/、根 package/lock、CI、他人的日报和任务文件。contracts/scripts/、hardhat.config.js 的本日工作先只审阅，不开放公网部署；需要修改须先与集成人协调。

允许在自己的任务分支提交真实变更。全部验收完成且 origin 核对为指定仓库后，允许正常 push 自己的任务分支；禁止 force、直接推集成分支或 main。没有远端写权限时保留本地 commit，并给出精确 push 命令。PR 只给标题和描述草案，由某齐本人创建并指定另一人 review；不要自动发 PR、评论或合并。

二、先读这些真实文件

README.md
docs/DECISIONS.md、docs/HANDOFF.md、docs/DEVELOPMENT.md、docs/INTEGRATION.md
contracts/README.md、contracts/hardhat.config.js、contracts/package.json
contracts/contracts/AegisWallet.sol
contracts/contracts/AegisPriceOracle.sol
contracts/contracts/AegisAccessControl.sol
contracts/contracts/AegisAttestation.sol
contracts/contracts/mocks/MockV3Aggregator.sol
contracts/test/AegisWallet.test.js
contracts/scripts/deploy-local.js、deploy.js、wire-feed.js

已完成事实：当前使用 TS + viem + Hardhat，Node 24+；已有 19 项合约测试。原生 ETH 付款、Owner 链上审批、白名单、共享美元日预算、nonce、期限、版本和基础预言机异常已实现。19 项测试已覆盖普通付款、软阈值排队、HighRisk、角色撤销、硬限额、审批涨价、共享日预算、过期和策略修改、重放、负数/零/未来/缺时间/不完整轮次/精度变更、配置锁、1 wei 向上取整、UTC 换日、收款人拒付和重入。先通读，不再逐项复制这些断言。

本地部署是 chainId=31337 + Mock ETH/USD $3000，自动/单笔/每日 $5/$10/$15，金库 1 ETH，Owner/Agent/recipient 独立。尚未验证真实 Sepolia Feed 或公网交易；不把 mock 结果写成 Chainlink 公网验证。生产合约不因为测试难写而放宽规则。

三、P0-A：补全已排队付款的预言机失效和恢复回归

建议新增 contracts/test/AegisWallet.boundaries.test.js，或在现有文件合理追加，复用 fixture 但不大幅重构测试。先搜索最新分支是否已有等价测试。

建议测试名：rechecks stale feed on pending approval and recovers with a fresh round。
1. 使用现有 fixture，先将 maxPriceAge 配成 60 秒，其他美元限额不变，再创建 $6 的待审批请求。deadline 留足，避免测试先碰到 REQUEST_EXPIRED。
2. 记录实际 feed.updatedAt、pending、请求 nonce、attestation、recipient 余额及已花预算，用 evm_setNextBlockTimestamp 精确制造 feed age > 60 秒；禁止真实 sleep。审批应 revert ORACLE_STALE。
3. 断言拒绝后 pending 原样保留、attestation.approved 仍为 false、收款余额和 spentUsd6 不变。排队时 nonce 已消耗，审批失败不得再消耗 nonce。
4. 只更新 mock Feed 为同价格的新有效轮次，不更改付款参数和策略。对同一个 attestationId 再审批成功；断言只付款一次，pending 删除，spentUsd6=$6，NativeTransferExecuted 的 requestHash 与原 pending 一致，roundId/updatedAt 来自新轮次。
5. 可在同一组添加 age == maxPriceAge 的只读预检边界；如果做，精确控制区块时间，避免自动挖下一个区块使其多 1 秒。不要把时钟误差当合约缺陷。

四、P0-B：补全 Feed 精度的独立算术验证

建议新增 contracts/test/AegisPriceOracle.test.js。
建议测试名：quotes native ETH in USD6 across supported feed decimals with ceiling rounding。
1. 参数化 deploy decimals 为 0、6、8、18 的独立 MockV3Aggregator，各自价格表示 $3000；每个独立 Oracle setFeed 后 lockConfiguration。
2. 对 1 wei、0.001 ETH、0.001234567890123456 ETH 调用 latestEthQuote。测试中的期望用纯 BigInt 独立计算：分母=10n ** (12n + BigInt(decimals))；期望=(amountWei * answer + 分母 - 1n) / 分母。禁止 Number、小数乘法或拿合约返回值推导期望。
3. 核对 costUsd6、answer、decimals、有效 roundId/updatedAt；相同经济价格与 ETH 数量在这些精度下应一致。正数 1 wei 仍至少计 1 USD6 单位。
4. 建议测试名 rejects feed decimals above 18 before locking；部署 decimals=19 的 mock，setFeed 应 revert UNSUPPORTED_DECIMALS，configurationLocked 仍 false。这是配置输入边界，不重复现有“锁定后精度变化”用例。
5. 若发现某种精度失败，先保留最小复现，再判断是测试单位错误还是代码错误；不要限制生产代码只支持 8 位来让测试通过。

五、P1-C：补全待审批付款的真实余额竞争

建议测试名：keeps a queued payment pending when another payment consumes its ETH balance。
1. 使用独立 fixture，金库实际只存入 0.003 ETH，Feed $3000，仍保留 $5/$10/$15 的策略和充足期限。不要使用 hardhat_setBalance 直接篡改金库；通过 Owner 实际存入 ETH。
2. 先排队 0.002 ETH（$6），再让 Agent 自动支付 0.0015 ETH（$4.5），金库只剩 0.0015 ETH。pending 不预留余额是现有设计，不应以此修改业务。
3. Owner 审批原 pending 应精确 revert INSUFFICIENT_BALANCE；日剩余额度足够，Feed 新鲜，确保触发的是余额条件。
4. 核对 pending、已排队 nonce、attestation 和预算的原子性；失败审批不增加 recipient 余额或 spentUsd6。随后通过真实 depositETH 补足余额，再审批原请求，核对总预算=$10.5，成功后不可再执行同一个 attestationId。
若 P0 用尽当天时间，P1 留作明确未完成项，不捏造通过记录。

六、验证命令与证据

先记录 node --version、npm --version；使用锁定依赖，不升级框架。未安装依赖时在根目录 npm ci --ignore-scripts；不要读取 .env 或真实密钥。
在仓库根运行：
    npm run compile
    npm run test:contracts
如需仅定位新组：
    npm exec --workspace contracts -- hardhat test test/AegisPriceOracle.test.js
最后运行 git diff --check。精确记录命令、测试名称、通过/失败数量、环境和未执行项；基线 19 项只是此前结果，今天必须写本机实际结果。已有 19 项不得回归。正常补测试不必重跑浏览器 E2E。

本日不需要真实网络交易，不连接真实资金钱包，不启动占用别人 8545 的节点，不复用别人的链/数据库作证据。若审阅 deploy-local.js，只核对三账户独立、锁 Feed、授权 Wallet、美元策略与公开地址输出；不要为了日报在共享链反复部署。

七、向后端交接与当日提交

写 docs/daily/2026-10-16/qi.md，包含：base SHA/任务分支；实际新增文件与测试；真实命令/结果；发现的缺陷及最小修复；仍未验证事项；给 purple sun 的具体交接。
交接须明确 ORACLE_STALE、INSUFFICIENT_BALANCE 在审批时可能出现，链上失败会保留 pending；只有匹配执行事件才算付款完成，恢复条件满足后仍由 Owner 对同一待审批请求重新确认。不要要求后端自动重建付款或绕过 Owner。列事件字段与错误字符串是否改变；正常目标是 ABI/API 完全不变。发现后端需要调整时写建议，不跨目录修改。

提交按真实工作单元组织，例如一个 Oracle 精度测试提交、一个 pending 审批边界测试提交（仅在它们各自真实完成时）。每个提交写清问题和验证；不要硬凑提交数、空提交、修改作者/日期、回填历史或为了“像开发”拆无意义改动。发现已覆盖且无变更时交付诚实的验证报告也有效。截图中的“提交记录可能影响资格”不是已确认活动规则，不写入项目事实。

提交前查看 git diff --stat 和暂存文件列表，只 git add 本人文件，不用 git add . 带入运行数据。不读/打印/提交真实.env、私钥、助记词、token、raw签名交易或数据库；不接CRE/CCIP、EZKL或新的资金出口，不广播Sepolia/主网交易。
完成后报告：新增验证了什么、修改文件、实际测试结果、真实 commit SHA、推送结果/分支链接、待 review 风险和下一步。最后给 PR 草案，目标为codex/integration-wallet-ui，标题建议 test: cover oracle precision and pending approval boundaries；描述写问题、具体边界、验证及本地 mock 范围。建议purple sun核对ABI与事件假设，MIA核对验收是否对应用户行为。不要声称已公开部署、通过审计、已获奖金或有真实用户。
```
