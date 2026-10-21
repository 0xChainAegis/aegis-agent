# 本地真实 LLM 联调

## 环境配置

使用 Python 3、Node 24+，并在项目根目录安装依赖（`npm ci`）。Node 从 PATH 查找；也可把 `AEGIS_NODE_BINARY` 设置为自己的 Node 可执行文件绝对路径。启动脚本不会读取 Hermes、用户凭据文件或 `.env`。

通过当前终端或自己的安全环境注入机制提供：

- `AEGIS_LLM_PROVIDER`：`openai`（OpenAI-compatible）或 `anthropic`。
- `AEGIS_LLM_MODEL`：所选服务实际支持的模型 ID。
- `AEGIS_LLM_BASE_URL`：所选服务的 HTTP(S) API 基础地址；OpenAI-compatible 使用包含服务所需版本路径的地址，Anthropic 使用追加 `/v1/messages` 前的基础地址。
- `AEGIS_LLM_API_KEY`：服务密钥，仅放入后端环境，不写入文档或仓库。
- 可选 `AEGIS_LLM_TIMEOUT_MS`：1–30000，后端和启动脚本均默认 10000。网页从公开配置读取等待预算，仅延长意图解析请求的等待时间，付款请求不随之延长。

脚本要求显式提供服务、模型、基础地址和密钥，不替用户选择供应商。它会设置 `AEGIS_LLM_MODE=live`。先执行离线配置检查：

```powershell
python scripts/with-live-llm.py --check
python scripts/start-live-web.py --check
```

检查只验证配置、Node 版本和网页所需 Vite 路径，不连接模型、不启动服务，也不验证 API 可达性、链或部署状态。缺少配置会列出变量名称，不输出密钥。

## 只验证草稿

以下命令会向配置的模型发送真实请求，并写入本机 `test-results/live-intent-smoke.json`。默认 `AEGIS_MODE=mock` 只隔离链上执行；模型仍为 live。

```powershell
python scripts/with-live-llm.py
```

也可转发其他 Node 参数，例如：

```powershell
python scripts/with-live-llm.py --import tsx scripts/run-intent-eval.mts
```

规则扫描命中的输入统一走「整条拒绝」：返回 `NEEDS_INPUT / PROMPT_BLOCKED`，清空地址、金额和用途，只留一句固定追问，并且不调用模型。关闭 LLM、显式字段、多轮继承和网页 PATCH 都适用，不允许靠「剥离越权子句」保留剩下的转账。模型返回的 `purpose` / `question` 也受同一套扫描：模型若把越权指令复述回来，同样整条拒绝。未命中的普通修正继续沿用原有多轮解析。这是有限的输入启发式检查；确认、字段校验和链上授权仍各自执行。

## 网页联调

终端 1，在项目根目录启动本地链：

```powershell
npm run chain
```

终端 2，配置上述环境变量后，部署本地合约并启动网页：

```powershell
npm run deploy:local
python scripts/start-live-web.py
```

使用本地 RPC `127.0.0.1:8545`、后端 `3001`、前端 `5173`；当前 Vite 代理要求后端端口为 3001。端口占用、RPC 未启动或部署文件缺失时会明确停止。Vite 从根目录安装或前端独立安装中查找。

打开 [本地网页](http://127.0.0.1:5173)，选择“使用本地测试钱包”，登录后进入“自然语言补给”。收款地址使用当前 `contracts/deployments/localhost.json` 中的 `recipientAddress`。

网页启动器设置 `AEGIS_MODE=local_chain`，每次启动默认使用新的 `backend/data/web-live-<随机标识>.sqlite`。显式设置 `AEGIS_DB_PATH` 会保留该选择；链重建后应使用新数据库，避免继承旧链任务。Ctrl+C 或终止启动器会停止其前后端及子进程；本地链在终端 1 单独停止。任一网页服务退出时，启动器也会清理另一服务。

## 历史验证快照

PR #7 的原始联调与 40 条评测结果属于 2026-10-20 的历史模型、提示词及解析校验快照；此次修复没有重新请求模型，也没有重算或修改该快照的得分。

历史报告见 [eval/REPORT.md](../eval/REPORT.md)。原始逐条记录由作者本地保留，公开仓库仅保留固定样本和脱敏汇总。后续运行产生的结果写入忽略的 `test-results/`，不覆盖已提交的历史报告。

历史上已验证三类真实模型草稿、网页展示及本地链部署；没有通过网页确认付款，也没有验证公网 Chainlink/Sepolia。修复后的离线回归结果不能替代新的真实模型或付款验证。
