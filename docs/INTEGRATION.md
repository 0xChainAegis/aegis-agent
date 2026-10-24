# 本地联调说明

本文对应 TS + viem + Hardhat/Sepolia 集成，接口版本 `aegis.v1`。运行钱包准备金卡片读取实际余额，按用户设置建议补给量，再经人工确认进入受限 native ETH 支付流程。系统还提供有限订阅和固定路线 CCIP-BnM 跨链；下限与目标仅保存在浏览器，后台监控与无人值守自动触发尚未实现。日常启动见[启动与网页验收](STARTUP.zh-CN.md)。

## 环境与启动

Node.js 24+，仓库根目录执行 `npm ci --ignore-scripts`；无锁文件时用 `npm install --ignore-scripts`。然后在三个终端依次运行：

1. `npm run chain`，保持 RPC 运行。
2. `npm run deploy:local`，生成 `contracts/deployments/localhost.json`。
3. `npm run dev`，同时启动前后端，并维护已核验的本地 Mock 报价时间戳。

前端 `http://localhost:5173`；API `http://127.0.0.1:3001`；RPC `http://127.0.0.1:8545`；Chain ID `31337`。后端绑定 loopback，CORS 仅允许代码配置的 localhost 前端来源。

默认 Owner 为公开 Hardhat 账户 0，Agent 为账户 1，允许收款人为账户 2。1 ETH 在 Wallet 合约金库里，Agent 自己的余额用于交易 Gas。PolicyEngine 统一判断 ALLOW、REQUIRE_APPROVAL 或 REJECT，并由所有已授权执行器共享 UTC 日预算；当前只授权 Wallet。地址以部署 JSON 或 `GET /api/v1/config` 为准，不在文档或 UI 中粘贴私钥。

Feed 初始价格 $3,000，自动额度 $5、单笔硬上限 $10、UTC 日预算 $15。`0.001 ETH` 约 $3 自动执行，`0.002 ETH` 约 $6 等待 Owner，`0.004 ETH` 约 $12 硬阻断。日预算按实际执行累计；pending 不预留预算，审批可能因其他付款先占用预算而失败。

本地维护器只在 loopback、chain 31337、准确的 Mock 字节码及合约绑定核验通过后，使用相同的正价格刷新临近过期的模拟轮次；不会补款或改变预算。测试网不会启动该维护器，自动 E2E 启动栈也不包含它。无效价格或身份不一致仍会停止，不自动修复故障测试数据。

后端不自动读取 `.env`。可使用进程环境变量 `AEGIS_MODE`、`AEGIS_DEPLOYMENT_FILE`、`AEGIS_RPC_URL`、`AEGIS_CHAIN_ID`、`AEGIS_DB_PATH`、`AEGIS_PORT`、`AEGIS_AGENT_PRIVATE_KEY`。只有本地 31337 + loopback RPC 可默认使用公开账户 1；测试网没有显式 Agent 密钥会阻断执行。后台不持有 Owner 私钥。测试网部署文件必须包含 `policyEngineAddress`；旧 v1 文件不会被兼容性猜测，需显式重新部署 v2。

可选的意图解析模式由 `AEGIS_LLM_MODE=off|stub|live` 控制，默认 `off`。live 模式需要 `AEGIS_LLM_PROVIDER=anthropic|openai`、`AEGIS_LLM_MODEL` 和进程环境中的 API key；key 不写入仓库、不返回 API。`stub` 只用于离线演示和可重复测试，不代表真实模型效果。

## 实际与模拟来源

- `local_chain`：真实本地链交易与事件；当前部署使用本地 Mock Feed，不是公网 Chainlink 行情或 Sepolia。
- `testnet`：Ethereum Sepolia 实际部署模式。原生 ETH 网页付款已有独立公开证据；CCIP 已完成 Sepolia → Base Sepolia 实际验收并保留源链、message ID 与目标链状态核验。有限订阅的 Sepolia 代码路径已实现，但新资金池仍需 Owner 首次设置订阅上限后再做独立公网付款验收。不同证据范围不能互相替代。
- `mock`：不广播、不伪造随机交易 hash。RPC/Feed 出错不会切换成该模式。
- `parser.kind=rule_parser,model=null`：默认规则解析或模型失败后的确定性 fallback。配置模型名不代表调用过 LLM。
- `parser.kind=llm,model=<model>`：只有严格 JSON 通过地址、金额、字段白名单校验后才会出现。缺字段、冲突、超时、429、乱码或 schema 多字段会回退规则解析。注入规则命中则整条返回 `NEEDS_INPUT / PROMPT_BLOCKED`，清空付款字段，不生成可付款草稿；解析器不授权、不提交、不付款。
- stub 模式显示 `model=stub-intent-v1`，用于验证接口和边界；它不是 live LLM 的证明。

金额使用十进制整数字符串：`amountWei` 表示 wei；`costUsd6,maxUsdCost6` 及预算表示 USD6（`1000000` = $1）。界面小数只用于展示，不能将 ETH/USD 小数 `Number` 作为交易金额。

## Owner 登录

当前只有配置 Owner 可以登录；不是多租户资金池，Agent 不能代替 Owner 登录或审批。

点击“连接钱包”后，先在选择器中按扩展名称与图标选择实际使用的插件。选择器支持 EIP-6963 发现，并兼容旧式注入；插件提供的图标用于辨认钱包。连接只读取账户和网络；只有账户匹配资金池 Owner 时，才可继续点击“以 Owner 签名登录”。其他账户保持只读连接，不请求登录签名，也不能读取 Owner 的私有任务或付款。

1. `POST /api/v1/auth/challenge`，输入 `{address,chainId}`，返回 `challengeId,message,expiresAt`。
2. 钱包对完整 `message` 执行 `personal_sign`。消息绑定 domain、Owner、链、随机 nonce、签发和过期时间。
3. `POST /api/v1/auth/verify`，输入 `{challengeId,address,signature}`，返回 `token,expiresAt`。有效挑战仅消费一次，实际密码学验签没有测试绕过。
4. 后续请求带 `Authorization: Bearer <token>`。前端使用 `sessionStorage`；会话过期或钱包账户/链变化后重新连接。

登录只创建 HTTP 会话，不批准付款。低风险由 Agent 在链上策略内付款；高风险需要 Owner 单独签链上 `approveAndExecute`。界面确认不是额外的低风险链上 Owner 许可，Owner 仍是可信策略管理员。

“本地测试钱包”是用户明确选择的开发入口，仅用于默认的公开 Hardhat Owner 账户，并核对本机来源、loopback RPC 和 31337 链。它不读取或保存私钥，不能用于公网资金。浏览器钱包通过所选插件的 EIP-1193 Provider 连接、签名和发送。

需要用个人浏览器钱包演示时，在运行 `npm run deploy:local` 的终端进程环境中设置 `AEGIS_LOCAL_OWNER_ADDRESS` 为该钱包的公开 EOA 地址，再部署。脚本将新资金池的 Owner 与管理角色交给该地址，并写入 `contracts/deployments/localhost.json`；无需提供 Owner 私钥。地址必须非零，且与 Agent、收款人及合约地址不同。个人 Owner 部署会关闭“本地测试钱包”入口，应在选择器中连接对应插件后签名登录。

浏览器钱包网络不匹配时，连接会请求插件显示网络切换确认；批准切换并重新核对账户后，仍需主动点击 Owner 登录。未添加的本地网络可在严格的 loopback/31337 配置核验后请求添加；Sepolia 只请求切换已有网络。`AEGIS_LOCAL_OWNER_ADDRESS` 只影响新的 31337 本地部署，切换钱包至 Sepolia 也不会改变测试网合约的 Owner。测试网必须另行配置匹配其部署的 Owner、RPC 与执行账户。

报价过期或资金不足时，服务会明确暂停付款；只有网络、合约绑定和角色均已核对的情况仍可登录查看。身份或网络校验失败时，连接和付款都停止。页面定期重新核对就绪状态。

## API 与版本

响应为 flat JSON，包含 `schemaVersion,mode,requestId,serverTime` 与实体字段。HTTP 成功不等于付款成功，必须同时检查业务 `status`。

公共读取：

- `GET /health` 或 `/api/v1/health` 返回 readiness；未就绪 HTTP 503，不模拟成功。
- `GET /api/v1/config` 返回链、部署地址（含 `policyEngineAddress`）、`abiVersion,abi.wallet,abi.oracle`、readiness、实际 parser 与静态文档链接。`planner` 包含 `mode/provider/model/llmEnabled/timeoutMs`，但不返回 API key、完整提示词或凭据。模型等待默认 10 秒；浏览器按配置仅延长意图解析请求，付款与状态查询保留独立的 12 秒等待上限。含凭据的 RPC 不直接暴露。
- `GET /api/v1/docs/:slug` 返回固定 allowlist 的 Markdown 和链接，没有 RAG。

以下接口需要 Bearer 会话；业务写接口还需 `Idempotency-Key`：

1. `GET /api/v1/wallets/current`：金库/Agent 余额，以及由 `recipientAddress` 明确标识归属的 `recipientBalanceWei` 运行钱包余额、policyVersion、budget、观测区块。地址、余额和其他链上读取来自同一个观测区块；budget 含自动/单笔/每日额度与已花费/剩余。快照不是执行保证。
2. `POST /api/v1/intents`：输入 `{message}` 或 `{recipient,amountWei,purpose?}`。返回 `draftId/intentId,version/revision,status,recipient,amountWei,missingFields,question,parser`。仅支持 native ETH；缺字段、USD/代币歧义、多个收款人或冲突金额进入 `NEEDS_INPUT`，不广播。模型只产生草稿，不能改变 policy、approval、signer、nonce 或 calldata。
3. `PATCH /api/v1/intents/:id`：输入 `{expectedRevision,...editedFields}`，编辑产生新版本，旧报价不可提交；多轮消息会保留上一轮已知字段，只让一个明确的新地址或 ETH 金额覆盖旧值。已提交草稿不能修改。
4. `POST /api/v1/intents/:id/preview`：输入 `{expectedRevision,maxUsdCost6?}`。返回 `quoteId,draftVersion,status,decision,costUsd6,maxUsdCost6,policyVersion,quoteExpiresAtSeconds,requestDeadlineSeconds,budget,oracle` 与报价区块。默认 cap 为当时估值加 1% 向上取整，确认界面必须显示。硬条件失败为 `BLOCKED`，与等待 Owner 不同。
5. `POST /api/v1/intents/:id/submit`：输入 `{expectedRevision,quoteId}`。后端核对保存的动作、业务版本和报价期限，返回 HTTP 202 与 `taskId,status,stateVersion`。客户端不能覆盖 nonce、策略版本或金额。
6. `GET /api/v1/tasks/:id` 或 `/api/v1/tasks`：读取权威状态、transactions、requestHash、requestNonce、attestationId、availableActions 和 verification。列表仅返回登录 Owner 的任务。
7. `GET /api/v1/tasks/:id/evidence`：绑定请求参数、实际交易/事件与来源。`verification.chainVerified/hashVerified` 仅匹配业务事件后为 true；入队验证通过仍不代表付款。

不要混用四种版本：`expectedRevision` 是草稿编辑版本，`draftVersion` 是报价绑定版本，`stateVersion` 是任务状态版本，`policyVersion` 是链上策略版本。

报价过期与请求 deadline 是两个边界：提交前检查报价；合约执行/审批时再检查固定期限、当时 Feed 和当前策略。超出已确认 USD cap 或策略改变时，不能静默改金额继续付款。

## Owner 审批与取消

只有 `AWAITING_APPROVAL` 任务可准备 Owner 交易：

1. `GET /api/v1/tasks/:id/owner-tx?action=approve|cancel`。后端读取链上 pending，逐项比对 requestHash、Agent、收款人、金额、USD cap、nonce、deadline、policyVersion，再做只读交易模拟。
2. 返回 `to,data,value,from,chainId`、taskId/requestHash/attestationId、完整付款字段和 `chainBindingVerified`。前端核对任务后才调用 Owner 钱包发送。
3. Owner 签 `approveAndExecute(attestationId)` 或 `cancelPending(attestationId)`。后台没有 Owner 密钥，不接受 `{approved:true}` 作为授权。
4. `POST /api/v1/tasks/:id/observed-tx`，输入 `{txHash,action}`。hash 仅是线索；后台自行检查 sender、目标、精确 calldata、value、回执和匹配事件。

高风险最终交易由 Owner 签发，模式是 `owner_approve_and_execute`。不是 Owner 签证明后再由 Agent 签最终付款。页面关闭而未回报 hash 时，后台可按已核验请求 hash 查找 Owner 结果事件。

过期、策略改变或预算竞争会使审批预检/执行失败；pending 仍存在时可取消，再新建草稿。不能靠本地 bool 或修改数据库撤销已广播交易。

## 幂等、nonce 与 UNKNOWN

业务写请求使用 8–128 个安全字符的 `Idempotency-Key`，作用域含 Owner、链与路由。同 key 同内容返回原结果；同 key 异内容返回 409。网络超时重试保留原 key。同一草稿与报价重复 submit 也返回原任务，不能创建第二笔付款。

发送前先将原始签名交易、预计算 hash、sender nonce、业务 request nonce 与 request hash 落盘 SQLite，再广播。raw transaction 和执行密钥不返回前端。

当前每个 executor/database 只运行一个后端进程。worker 串行执行，未决广播阻止下一笔 nonce 分配。重启优先查原 hash；必要时只重播相同 raw bytes，不自动创建替代付款。重复提交、轮询和刷新不能生成新 nonce。

- `DRAFT/NEEDS_INPUT`：草稿或缺信息，没有付款。
- `READY/BLOCKED`：预检结果；READY 仍需确认，BLOCKED 是硬阻断。
- `SUBMITTING/BROADCAST`：准备或已发送，不能显示成功。
- `UNKNOWN`：广播结果不明，继续查原 hash，不能引导用户重建付款。
- `AWAITING_APPROVAL`：匹配到入队事件，尚未付款。
- `EXECUTED`：匹配到付款执行事件。
- `REQUOTE_REQUIRED`：原报价/策略不再可用，需要重新确认；旧已签交易仍须核对。
- `FAILED`：预检、链上执行或业务事件校验失败，查看 reasonCodes。
- `CANCELLED`：匹配到链上取消事件。

类型还预留 `EXPIRED`，当前不会仅凭浏览器计时把已广播/pending 任务伪装成已取消或已终结。

## 验证与当前证据

回执 status=1 只证明交易成功执行。还需核对 Wallet 事件的同一请求：NativeTransferExecuted 才是已执行；NativeTransferQueued 是待审批；NativeTransferCancelled 是已取消。PolicyEngine 的 BudgetConsumed 记录同一 requestHash 的动作类型、策略决定和累计预算，但不能单独替代付款事件。缺预期事件或参数不符，不得显示付款成功。

请求 hash 使用与合约一致的编码，绑定 domain、chainId、Wallet、Agent、收款人、amountWei、maxUsdCost6、nonce、deadline、policyVersion。它不是自然语言、模型推理与执行后完整记录的证明。结果证据来自回执/事件；一次 mined 确认不代表最终不可逆。

当前合并前入口为 `npm run check` 和 `npm run test:e2e`，覆盖 strict TypeScript、生产构建、合约、后端、前端以及真实本地 RPC/部署/SQLite/API/浏览器流程。专项命令分别覆盖钱包、储备、有限订阅和 CCIP。自动化本地链使用 Mock Feed；`npm run check:sepolia` 是只读公网就绪检查。已记录的 Sepolia 原生付款和 CCIP 跨链验收属于独立公网证据，任何一次历史成功都不能替代当前部署的新鲜度、余额与权限检查。

## 重置本地链

重建 Hardhat 链会使旧交易与证明失效，即使部署地址相同。重新部署后使用**新的 SQLite 文件**（设置新的 `AEGIS_DB_PATH`），清除当前开发会话并重新登录，不把旧任务当作新链记录。

后端检查 mode、chain、Wallet、Agent 与 Owner 的数据库命名空间，不同部署拒绝混用。相同地址重建和深重组没有完整自动恢复，需要显式区分开发实例。不要编辑数据库把未知交易改成成功。

相关入口：[运行指南](../README.md)、[后端说明](../backend/README.md)、[架构](ARCHITECTURE.md)、[安全边界](SECURITY.md)。
