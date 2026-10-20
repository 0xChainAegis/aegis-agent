# wow 真实模型联调记录

## 已验证范围

项目快照：593af6918a8039e1e29997992fe9f7c850da8d3c（通过 GitHub API 下载 ZIP，未创建 git 仓库）。

实际使用 Node 24.19.0、OpenAI-compatible 服务 `https://wow.wvv.pp.ua/v1`、模型 `gpt-6.1-sol`。

调用的是项目原有 `OpenAiCompatibleIntentClient.extract`，随后将同一次真实响应传入原有 `parseDraftWithLlm` 进行完整校验。没有用 stub，也没有用规则回退掩盖结果。

| 用例 | 真实调用延迟 | 最终状态 | 解析器 |
|---|---:|---|---|
| 完整中文 ETH 转账 | 3936 ms | DRAFT | llm / LLM_OK / fallback=false |
| 缺金额时追问 | 3810 ms | NEEDS_INPUT | llm / LLM_OK / fallback=false |
| 不支持的美元转账 | 4429 ms | NEEDS_INPUT | llm / LLM_OK / fallback=false |

详细模型原始 JSON、校验后草稿和时间记录在本机 `test-results/live-intent-smoke.json`。`test-results/` 被 gitignore 排除，**原始证据不随仓库分发**；仓库只保留脱敏的评测报告与失败归因。

后端原有回归测试：37 passed，0 failed。后端 TypeScript 类型检查退出码 0。

## 本机复现（仅项目作者本机）

在项目根目录执行：

```powershell
py scripts/with-live-llm.py
```

**这个入口是本机专用的，不是团队通用的密钥配置工具。** 它优先读取进程环境变量 `AEGIS_LLM_API_KEY` / `AEGIS_LLM_BASE_URL`；两者都没有时，才回退到当前 Hermes profile 的 `auth.json`（`custom:wow`）并打印实际来源。回退路径依赖这台电脑已有的 Hermes wow 凭据池和相邻 `.runtime/node24/node.exe`（可用 `AEGIS_NODE_EXE` 覆盖）。

其他成员不要依赖该脚本，直接用自己的安全机制注入以下变量，再用 Node 24+ 执行 `node --import tsx scripts/live-intent-smoke.mts`（或 `scripts/run-intent-eval.mts`）：

- `AEGIS_MODE=mock`：只验证草稿，不连接或广播链上交易；并不表示模型是 mock。
- `AEGIS_LLM_MODE=live`
- `AEGIS_LLM_PROVIDER=openai`
- `AEGIS_LLM_MODEL=gpt-6.1-sol`
- `AEGIS_LLM_BASE_URL=https://wow.wvv.pp.ua/v1`
- `AEGIS_LLM_TIMEOUT_MS=30000`
- `AEGIS_LLM_API_KEY`：通过安全渠道提供，不在命令历史、文档或仓库中写出。

后端不自动加载 `.env`，只把变量写进去不等于启用了 live。wow 的 `/keys` 是管理网页，API 使用 `/v1`。现有后端超时默认 2000 ms，小于本轮真实模型延迟，因此本机联调入口显式设置 30000 ms，未修改业务默认值。

## 环境限制与处理

终端全局 Node 是 22.23.2，不满足项目的 Node >=24 要求。通过 npm registry 下载 Node 24.19.0 到项目之外的 `../.runtime/node24`，未修改全局 Node。

完整 `npm ci --ignore-scripts` 因合约依赖包含 Git SSH 包而遭 npm 12 的 EALLOWGIT 策略阻断。为本轮 LLM 联调，单独把 viem、zod、tsx、TypeScript、Node types 安装到 `../.runtime/llm-deps`，用目录联接供原项目解析；未修改 package.json 或 lockfile。当前 node_modules 不是完整前端/合约开发环境。后续全栈联调需单独解决合约依赖安装，不能把本轮结果当作完整安装成功。

## 网页接入：后续已完成

已启动真实本地 Hardhat 链与 Mock Feed，部署本地合约；前端 5173、后端 3001、RPC 8545。后端配置回读确认 planner.mode=live、model=gpt-6.1-sol。密钥只在后端进程环境中。

真实 Chrome 经“使用本地测试钱包”完成 Owner 签名登录，从网页发送缺金额、USD、完整 0.001 ETH 三类请求，三个响应均为 llm / LLM_OK / fallback=false。前两项页面显示模型追问，完整请求打开确认抽屉，显示 0.001 ETH、Mock 估值 $3.00、最高本金成本 $3.03。没有点击确认提交，SQLite 只读检查确认 task=0。

修复了前端没有展示 draft.question 的问题，新增实际解析来源/回退原因显示。此前浏览器等待模型追问的断言失败，修改后断言通过。浏览器与 live 的原始证据保存在本机 `test-results/web-live-evidence.json`，同样不入库。

复验：前端类型检查、生产构建通过；37 项后端测试、27 项合约测试通过；浏览器控制台 0 error。

### 本机重新启动

以下 PowerShell 命令在项目根目录执行，使用已准备的隔离依赖和 Node 24。

终端 1：

```powershell
Push-Location contracts
& ../../.runtime/node24/node.exe node_modules/hardhat/internal/cli/cli.js node --hostname 127.0.0.1
Pop-Location
```

终端 2，在 RPC 就绪后：

```powershell
Push-Location contracts
& ../../.runtime/node24/node.exe node_modules/hardhat/internal/cli/cli.js run scripts/deploy-local.js --network localhost
Pop-Location
# 重建链必须使用新数据库，不能混用旧任务。
$env:AEGIS_DB_PATH = Join-Path $PWD ("backend/data/web-live-" + [guid]::NewGuid().ToString() + ".sqlite")
py scripts/start-live-web.py
```

打开 http://127.0.0.1:5173，选择“使用本地测试钱包”，确认开发账户登录，在“操作”页选择“自然语言补给”。测试地址使用部署记录中的 recipientAddress，本轮为 `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`。

start-live-web.py 已实际启动并通过 HTTP 200 和 live planner 回读验证；端口占用时拒绝重复启动。Ctrl+C 停止其前后端，本地链需在单独终端停止。

### 依赖处理补充

已补齐 Vite、Hardhat、ethers、solc、OpenZeppelin。Chainlink 两个包从 npm registry 官方 tarball 解包，绕过 Git SSH 依赖拉取，没有替换其源码；实际成功编译 27 个 Solidity 文件。依赖在相邻 .runtime/llm-deps，子项目 node_modules 使用 Windows junction。根目录完整 npm ci 仍未修复，团队通用安装流程需另行处理。

## 尚未验证

没有进行网页端实际付款，没有验证公网 Chainlink/Sepolia。未修改后端解析与权限逻辑，未提交或推送 GitHub。
