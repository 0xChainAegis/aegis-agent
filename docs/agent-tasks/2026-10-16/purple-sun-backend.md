# 10 月 16 日 · purple sun · TS 后端与恢复联调

将下面整段复制给你的开发 Agent。目标是交付可复现的真实改进；已实现的功能先验证，不重复造轮子。预计半天至一天，可依据实际缺陷缩小范围。

```text
你是 AegisAgent 的后端开发 Agent，今天代表 purple sun 完成 2026-10-16 的任务。
项目仓库：https://github.com/0xChainAegis/aegis-agent
今天聚焦：验证付款在进程退出、接口重试与 Owner 审批交接时不会重复执行，并补齐真实缺口。
你要实际检查、修改、验证和交接，不能只写设计建议，也不能为了提交数量制造改动。

一、基线和协作方式
1. 先执行并阅读 git status --short、git branch --show-current、git remote -v、git log -5 --oneline。保护现有未提交修改；不要 reset、clean、强制切分支或覆盖别人的文件。
2. 基线是 origin/codex/integration-wallet-ui，历史交付点 c3164e6；不要从旧 main 开发。核对 origin 对应指定仓库，然后正常 fetch。已有本人任务分支则先核对来源并继续，不重复开分支。
3. 新任务建议从更新后的集成分支创建 purple/1016-recovery-boundaries。若远端读取受限，先核对本地 c3164e6 与集成引用并注明离线基线，不能假装已同步。
4. 阅读根 README.md、docs/DECISIONS.md、docs/DEVELOPMENT.md、docs/INTEGRATION.md、docs/HANDOFF.md、backend/README.md，以及本任务依赖的源码。若最新 HEAD 已完成下面任务，验证后交付结果；不要重复实现。
5. 允许修改 backend/src/、backend/test/、backend/README.md 和你自己的 docs/daily/2026-10-16/purple-sun.md。原则上只增加必要测试并修复其暴露的真实缺陷。
6. 不修改 frontend/、contracts/、agent/、packages/shared/、e2e/、根 package/lock、脚本或 CI。若确需共享类型/ABI变化，先记录具体字段、兼容影响和建议，交给 MIA、某齐协调，别自行扩大修改范围。

二、理解已有实现，避免重做
当前是 Node 24+、TS、viem、Zod、node:sqlite 的单进程服务。不是 Python 后端，不需要改 Go。
重点读 backend/src/service.ts、chain.ts、server.ts、store.ts、config.ts、parser.ts、index.ts 和 backend/test/api.test.ts；只读 packages/shared/src/index.ts 了解边界。
已经具备 Owner 真签名挑战登录、草稿版本、报价与提交、HTTP幂等、原始签名交易先落库再广播、串行 nonce、UNKNOWN恢复、事件核验、浏览器 Owner 审批/取消。旧测试已有 accepted-then-timeout 跨 SQLite 重启案例，不要把它重新包装成今天的新功能。
当前规则解析为 rule_parser/model=null，没有实际LLM调用。local_chain 使用真实本地链和 Mock Feed；不是已部署的 Sepolia Chainlink Feed。保留这些事实标签。
业务金额是 amountWei 整数字符串与 USD6；不能使用 Number 计算交易金额，不能把美元输入解释成 ETH。

三、P0：补足恢复窗口的可复现回归，必要时做最小修复
先画出源码中实际顺序：submit落任务→prepare签名→保存raw/hash/nonce→broadcast→查receipt和业务event。现有服务通过 writes/worker Mutex 串行，数据库跨重启保存；今天不做多实例执行器。

案例A：签名已持久化，但广播前进程退出。
利用现有 Store、AegisService 和显式 FakeChain，扩展测试夹具，在原始签名交易真正落盘后的窗口制造可控中断，再关闭并重新打开同一临时SQLite路径。不要通过调用内部save伪造“已保存”，应验证实际prepare路径写入的数据。
验收：第二个服务复用原raw/hash/senderNonce/requestNonce/requestHash；prepare总次数仍为1；只广播相同raw；只出现一份任务与付款；第二笔排队任务在第一笔未决时不能获得新的prepare。测试完成清理仅本测试创建的临时目录，不能动开发者现有DB。
如框架不便模拟真正进程崩溃，可明确说明在同一持久化边界注入故障并重建服务，不把它称为操作系统崩溃测试。不要为了测试改动广播顺序或放松原有约束。

案例B：AWAITING_APPROVAL 跨后端重启，Owner已发送交易而网页来不及回报hash。
核对 service.tick 中 ownerObserved 与 findOwnerOutcome 分支，以及 chain.ts 的 findOwnerOutcome。用显式适配器测试验证：保存queued任务→关闭Store→重建服务→发现已存在Owner事件→核验后变成EXECUTED或CANCELLED；重跑tick不再prepare/broadcast付款。
补充Owner交易未被收录时仍是等待，不得仅因观察到hash显示成功；Owner交易revert时不得标成付款完成，原pending仍需核查。
测试只能把链作为显式夹具，不能对外宣称这就证明了真实RPC事件过滤正确。

案例C：真实 ViemGateway 的交易/事件绑定不能由FakeChain自证。
现有api.test.ts大多调用FakeChain.outcome。至少为 ViemGateway.outcome 增加一组独立测试：用本地测试RPC响应夹具或最小可控client注入，实际执行该方法的解码与判断，使用viem编码事件，不能把被测方法本身替换成固定成功结果。
覆盖匹配事件的正常结果，以及错误sender/目标/calldata、错误requestHash、其他合约地址日志、receipt成功但缺业务事件等代表性反例。选择少量有区分度的组合，明确返回TX_BINDING_MISMATCH、EXPECTED_EVENT_MISSING或保持未决的预期；无关hash不能推进本任务。
如果为了注入需要微调构造器，保持原默认行为、签名权限和生产调用兼容，不做大重构。若当天时间不足，优先A/B，把C的具体未覆盖项交接给某齐，报告必须如实注明。

四、P1：HTTP边界与前端交接，P0完成后再做
使用现有真实HTTP测试服务补一组有业务价值的接口边界验证，可新建 backend/test/http-boundaries.test.ts；先复用现有可用fixture，避免大规模重构。
重点选择：缺失/非法Idempotency-Key；同key不同body的409；旧expectedRevision的409；非法JSON/未知字段不被静默接收；未授权的写请求不创建任务。对于重试，核对HTTP状态与error.code稳定，业务拒绝不能变成EXECUTED。
核对 /config、tasks列表/详情、evidence、错误响应不会返回 rawTransaction、执行私钥或Bearer token。认证verify合法返回新token是例外，不要把正常登录误判为泄露。
不要为了通过测试放宽schema、返回假成功或默默切mock。若发现HTTP契约要改，优先兼容修复，并在报告给MIA列出旧行为、新行为、具体响应样例。

五、运行和验收
从仓库根目录、Node 24+执行。若依赖尚未安装，使用锁文件 npm ci --ignore-scripts；不自动升级依赖。
    node --version
    npm run typecheck --workspace backend
    npm run test:backend
    git diff --check
涉及共享返回行为时，再执行 npm run typecheck，确认已有消费者仍可类型检查。没有修改消费者不等于可直接忽略兼容性。
本地链验证需先确认没有占用团队现有端口或正在演示的进程。沿用 README 的已有启动流程，确认chainId=31337及对应部署、使用匹配的新临时DB，读取 /api/v1/health 和 /api/v1/config；不擅自停止他人服务、重置链或删除DB。
若需要真链完整复验，交给集成人在空闲环境跑已有 npm run test:e2e；记录实际执行人/结果。未跑写未跑，FakeChain/夹具测试不能冒充真链验收。测试失败先保存最小复现，只修本任务引入或触及的缺陷。
已知历史检查点是8项后端测试；今天以实际命令输出为准，不承诺固定增加多少条。不要复制历史通过数字充作本次结果。

六、交付与Git
将事实报告写入 docs/daily/2026-10-16/purple-sun.md：基线完整SHA、本人分支、原问题与复现、实际改动、精确测试命令和结果、夹具/真链区别、API兼容性、未完成项、给MIA与某齐各一条具体交接。不要写密钥、raw交易、Bearer token或含凭据RPC地址。
允许本地提交本任务的真实变更；按可独立理解的修复/测试单元提交即可，不硬凑数量，不补造日期、不改作者身份、不空提交。
全部验收完成且origin核对为指定仓库后，允许普通push自己的任务分支；不force、不直接push集成分支或main、不自动merge。无远端写权限则交付本地commit与正确push命令，不反复尝试越权。
提交前查看 git diff --stat 和暂存文件列表，只 git add 本人文件，不用 git add . 带入运行数据。不要读取/打印/提交真实.env、密钥、助记词、token、raw交易或数据库；后端只持Agent执行身份，不得引入Owner私钥。只允许无价值31337链测试，不广播Sepolia/主网交易，不引入LLM、x402、CRE/CCIP、EZKL或新的产品路径。
最后输出：修改文件、解决的问题、执行的检查及实际结果、剩余限制、commit SHA/分支链接，以及PR标题和正文草案。PR目标为codex/integration-wallet-ui，建议某齐评审链上假设，MIA核对接口影响。PR由本人创建并指定另一位同学review，不由Agent自动发布评论或联系他人。
建议PR题目：test(backend): cover persisted payment recovery boundaries。若确有实现修复，标题改为真实问题对应的fix，不让提交名掩盖实际变更。
如果所有目标已被当前HEAD覆盖，交付带命令和证据的无代码变更报告即可；真实核验也是有效工作。
```
