# MIA · 10 月 16 日前端 Agent 提示词

复制下面整个 `text` 区块交给编码 Agent。先做 P0；P1 有余力再做。任务尚未执行，结果以运行记录为准。

```text
你是 AegisAgent 项目今天的前端工程师，我是 MIA。请在真实仓库中完成下述任务、测试、提交和交接，不要停在建议或重做项目。

一、项目与已完成事实

仓库：https://github.com/0xChainAegis/aegis-agent
工作基线：origin/codex/integration-wallet-ui。
已知实现检查点：c3164e6a16fe6a324b47e04168481dacc5c3db73；执行时先记录实际最新基线 SHA。
这是 ETH Shenzhen 的 AegisAgent，不是 VeritasOS。
产品是受收款名单、USD 预算和 Owner 审批约束的 native ETH 付款钱包。
前端当前是 Vite + TypeScript + DOM，不是 React。已有 Multica 风格暗色侧栏、看板、操作卡片、详情抽屉和设置页，不要迁移框架或另建演示页面。
后端为 TS + viem + SQLite；本地链 31337，Mock Feed 初始 $3000，自动/单笔/共享每日额度 $5/$10/$15。真实 LLM 未接入，parser 为 rule_parser，Sepolia 未验收。
历史检查点已有 2 项浏览器 E2E 通过；今天必须按当前环境重新记录结果，不能直接复制历史成绩。

二、允许的文件与职责

允许修改 frontend/、e2e/ 下今天必要的浏览器用例，以及 docs/daily/2026-10-16/mia.md。
先读 README.md、docs/DECISIONS.md、docs/HANDOFF.md、docs/DEVELOPMENT.md、docs/INTEGRATION.md、frontend/README.md。
重点读 frontend/src/main.ts、api.ts、wallet.ts、style.css，e2e/wallet.spec.ts 和 playwright.config.ts。
不改 backend/、contracts/、packages/shared/、根 package/lockfile、scripts/、CI、总 HANDOFF 或其他人的日报。
如需接口变化，给 purple sun 准备“现请求/现响应/期望契约/复现步骤”交接，由本人传递；不要越界改服务或悄悄兼容一份虚构响应。

三、开工与分支

先运行 git status --short、git log -5 --oneline、git remote -v、node --version。
保留已有未提交改动；不要 reset、stash 别人的工作或强行切分支。
工作区干净时 git fetch origin，并从当前集成分支新建 mia/1016-quote-owner-recovery；同名分支已存在则核查并延续本人工作。不要从旧 main 重新开发，也不要直接在集成分支提交。
Node 要 24+；使用提交的 lockfile 安装 npm ci --ignore-scripts。已有依赖且未变化时无需反复安装。
先跑 npm run typecheck --workspace frontend 和 npm run build --workspace frontend，记录实际结果，区分已有失败和本任务引入的失败。

四、P0-A：报价失效后的交互与安全边界

先复现再修改：生成 0.001 ETH 的真实本地草稿/报价，核查 quoteExpiresAtSeconds、requestDeadlineSeconds 和当前确认按钮逻辑。重点函数为 main.ts 的 drawerActions、createIntent、submitIntent。
当前后端/合约承担执行校验，不要把“前端按钮没倒计时”直接称为可绕过资金限制的漏洞。
目标体验：报价过期或后端明确要求重新报价时，用户看得懂原因，有清楚的下一步，不能把旧报价当新报价反复提交。
如果当前确有缺口，做最小修改：
1. 对过期报价禁用原确认，显示“报价已过期，请重新预览”；缺失/非法时间字段应阻止确认，不能默认无限有效。
2. 提供重新预览入口，沿用当前草稿与 expectedRevision，成功后明确展示新报价/新 cap，要求用户再确认；不得自动 submit。
3. 草稿金额/收款人修改后不复用旧 quoteId；版本冲突或服务端报价失效需显示真实错误。
4. 若任务已经有 taskId 或广播不明，不能通过“重新报价”启动另一笔付款；先核对原任务。不要把所有错误统一导向重试支付。
先读后端实际错误 code，再选择映射；没发现现成需求时写清验证结果，不凭空改协议。
为报价恢复增加有意义的浏览器行为验证：旧报价不能确认，重新预览不会付款，新报价仍要用户确认。可以用显式页面时钟控制检查客户端到期，但必须说明这是界面测试，不能称为合约过期证明；合约时间边界由某齐另测。

五、P0-B：Owner 已广播、回报失败的恢复回归

已有 pendingBroadcast、signOwner、observeOwner 逻辑，不重新设计审批系统。
在 e2e/ 新增一项有区分度的回归：本地真实生成约 $6 的待审批任务，Owner 签实际审批交易后，让浏览器第一次向 observed-tx 的通知请求失败。
需要断言：
1. 页面只根据服务端任务/事件显示最终结果，不得因钱包返回 hash 就自行置 EXECUTED。
2. 已记录的原 txHash 在本次页面会话刷新后还能用于核对；恢复时复用原 hash，不再次 eth_sendTransaction、不产生第二次付款。
3. 后端若已从链上主动恢复成 EXECUTED，页面接受权威结果；不要依赖固定等待时间或强求中间状态必然停留。
4. 收款余额最终只增加一次目标 amountWei，任务 requestHash/事件一致；以余额与调用/交易记录验证，而非仅看绿色文案。
5. 未拿到 txHash 的钱包拒签，不能假称“已经广播”，应保留尚未执行状态。
Playwright 可拦截客户端通知或注入显式 EIP-1193 测试 provider 复现异常。测试替身只用于异常注入，关键付款仍走本地真实合约。不要把 route.fulfill 的虚构 EXECUTED 当链上证据。
如发现 UI 的重复签名窗口或错误恢复，先形成失败回归，再做范围最小的修复。若既有逻辑通过，只提交缺失的关键回归，不故意改坏代码凑修复。

六、P1：顺手改善演示可读性

只在两个 P0 完成后做：检查 UNKNOWN、BROADCAST、AWAITING_APPROVAL、EXECUTED、REQUOTE_REQUIRED 的标签和下一步是否明确，保留 queued 不等于 executed 的区别。
优先展示完整收款人、ETH 数量、USD cap、报价时间和 Owner 动作含义。保留 Mock Feed 与 rule_parser 标识，不加“已验证 AI 推理”的宣传。
暗色 Multica 风格延续现有设计；1440 宽与 390 宽浏览、抽屉和审批弹窗要可用。可做键盘焦点/Escape/长地址换行的小修，不做换框架、复杂动画、图像识别、RAG或新的钱包SDK。
视觉变化无需为每个CSS样式写单元测试；用截图与人工检查，重要操作恢复用行为测试。

七、如何跑真链 E2E

从根运行 npm run test:e2e。playwright.config.ts 默认会通过 scripts/e2e-stack.mjs 启动新的本地链、部署、新SQLite、API和前端；不要同时手动启动第二套占用8545/3001/5173的服务。
端口被已有服务占用时先辨认属于谁，不杀别人的进程；安排本人隔离工作副本或与集成人约定测试时段。未经确认不能设置 AEGIS_E2E_EXTERNAL=1 复用旧链/旧DB冒充干净测试。
Windows有本地Chrome时现配置会使用它；缺浏览器按现README安装。依赖/浏览器安装失败要记录原错误，不编通过结果。
若需要短时推进链上时间，只能对隔离31337链进行测试控制，不能改系统时钟或真实网络数据。

八、验收与证据

必须执行并记录：
  npm run typecheck --workspace frontend
  npm run build --workspace frontend
  npm run test:e2e
  git diff --check

已有2项E2E仍应通过；新增检查按实际条目记录，不提前承诺最终总数。
报价重预览不得付款；恢复测试应证明只到账一次；原小额到账、Owner批准/取消、硬预算拒绝、缺地址、离线停止不得退化。
仅有测试代码但没运行，写“已添加，未运行”；页面截图不是付款证明。浏览器执行不了时交付修复/用例和精确阻塞，禁止标记全绿。
截图可以保存在本地test-results供本人查看；日报只留必要、脱敏、稳定证据路径或公开hash，不提交整个自动生成目录。

九、真实开发交付

写 docs/daily/2026-10-16/mia.md，包含：
- 当天实际开始/完成时间（仅有真实记录才填）、基线SHA、任务分支。
- 检查过的已实现项、问题及复现步骤、修复前后用户行为。
- 改动文件、每条命令及通过/失败/未跑结果、真实环境。
- 是否修改API/ABI（预期为无）；未完成项和给purple sun的具体请求。
- 30–60秒演示步骤：失效报价怎样恢复、审批通知丢失怎样核对原交易。

按真正独立的改动做小提交，例如报价恢复一项、审批恢复回归一项；不要为了数量硬拆或空提交，不改历史作者/日期。若代码本来正确，只提交有新证据的测试或报告，完全无新增则无变更交接。
本提示词授权你创建本人分支、本地提交真实变更；验收完成且origin确认为指定仓库后，允许普通push本人分支。没有写权限时保留本地提交并输出push命令。禁止force push、直接push main/集成分支、自动合并或修改权限。
提交前查看 git diff --stat 和暂存文件列表，精确git add本人文件，不用git add .带入运行数据。不要提交密钥、.env、token、raw signed transaction、SQLite或自动构建目录。
最后给出：结果一句话、真实commit/分支、检查结果、未完成/风险、PR标题与正文草案。PR目标是codex/integration-wallet-ui，建议purple sun评审，由本人创建和协调评审。不要自动发群消息、开PR评论或改其他人的任务。

不要在本任务接真实LLM、x402、CRE/CCIP、自动补款监控或EZKL。只用无价值31337测试资产，不发Sepolia/主网交易。后端不得拿Owner私钥，UI不得用硬编码成功绕过真实接口。
```
