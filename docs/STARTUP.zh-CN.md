# Aegis 启动与网页验收

本文是当前版本的日常启动入口。需要 Node.js 24+，所有命令均在仓库根目录执行。

## 第一次安装

```bash
npm ci --ignore-scripts
```

私密配置保存在 Git 忽略的文件中：

- `contracts/.env`：Sepolia RPC、部署账户和后端受限执行账户配置。
- `contracts/.env.llm`：可选的模型地址、模型名和 API key。
- `contracts/deployments/sepolia.json`：当前资金池的公开部署地址，不含私钥。

不要把 `.env` 内容、RPC 密钥或私钥复制到文档、截图、聊天或 Git。

## 日常启动 Sepolia 网页

只测试钱包、原生 ETH、有限订阅和 CCIP，不调用 AI：

```bash
npm run check:sepolia
npm run start:sepolia:no-ai
```

使用已经配置好的 DeepSeek/OpenAI-compatible 模型：

```bash
npm run check:sepolia
npm run start:sepolia
```

打开 <http://127.0.0.1:5173>。API 位于 `http://127.0.0.1:3001`。Sepolia 启动不需要本地 Hardhat 节点；`Ctrl+C` 会同时停止前端和后端。

启动器自动读取上述私密文件，并固定使用 Ethereum Sepolia（chain ID `11155111`）。它不会在 Sepolia 不可用时退回本地链或模拟成功。

## 网页验收顺序

1. 等页面右上角显示“Sepolia · 可操作”。初次检查可能短暂显示“正在核对”。
2. 连接部署文件中记录的 Owner 钱包，切换到 Sepolia，再签署 Owner 登录消息。登录不会转账。
3. 原生 ETH：填写或描述一笔很小的白名单收款地址付款，先预览再确认。
4. 有限订阅：进入“订阅”。若链上上限尚未设置，先由 Owner 签署一次“启用有限订阅策略”；该交易不付款。随后可登记计划，并逐期重新预览、人工确认付款，也可暂停、恢复或永久取消。
5. CCIP：进入“跨链”，填写 Base Sepolia 收款地址、CCIP-BnM 数量和用途。核对固定路线、代币金额、USD 上限和 Router 手续费上限后提交。源链成功不等于目标链到账；以页面的目标链交付状态为准。

当前有限订阅不是后台自动扣款：每一期都要产生新报价并由用户再次确认。当前 CCIP 固定支持 Ethereum Sepolia → Base Sepolia 的 CCIP-BnM 测试路线。

## CCIP 显示不可用

CCIP-BnM 没有可靠的公开美元行情，项目使用 Owner 维护的测试价格。该价格超过 `MAX_PRICE_AGE` 后会主动停止跨链，避免使用过期数据。

先只读查看价格及更新时间：

```bash
set -a
source contracts/.env
set +a
npm run refresh:ccip-feed --workspace contracts
```

如果确认只是价格过期，并且 `PRIVATE_KEY` 对应输出中的 Feed Owner，重新提交同一个测试价格：

```bash
CCIP_FEED_REFRESH=1 npm run refresh:ccip-feed --workspace contracts
npm run check:sepolia
```

第一条刷新命令只读；设置 `CCIP_FEED_REFRESH=1` 后会发送 Sepolia 交易并消耗少量测试 ETH。它不会转移 CCIP-BnM，也不会自动更改价格值。若 Owner 不匹配、余额不足或路线/权限错误，不要绕过检查。

## 本地开发链

分别开启三个终端：

```bash
# 终端 1
npm run chain

# 终端 2，等待终端 1 就绪后执行
npm run deploy:local

# 终端 3
npm run dev
```

本地网页仍是 <http://127.0.0.1:5173>，RPC 为 `http://127.0.0.1:8545`，chain ID 为 `31337`。本地账户和 Mock Feed 只用于开发，不能持有真实资产。

## 合并前检查

```bash
npm run check
npm run test:e2e
```

专项浏览器测试：

```bash
npm run test:e2e:subscriptions
npm run test:e2e:ccip
```

自动化 E2E 使用独立本地链验证网页与合约，不等于新的公网跨链证明。公网验收还需要 Sepolia 源链交易、CCIP message ID 和匹配的 Base Sepolia 目标链交易。

## 常见问题

- **端口占用**：先停止占用 `3001` 或 `5173` 的旧进程，再重新启动。
- **一直显示正在核对**：等待当前 RPC 请求完成；仍无结果时点击“重新检查状态”，再运行 `npm run check:sepolia` 查看具体原因。
- **连接钱包后不能操作**：确认网络为 Sepolia、账户是部署 Owner，并完成单独的 Owner 登录签名。
- **RPC 正常但 CCIP 不可用**：按上面的只读价格源检查操作；不要把普通 ETH/USD Feed 与 CCIP-BnM 测试价格源混为一谈。
- **订阅页面要求先启用策略**：这是新部署订阅上限为零时的正常安全状态，需要 Owner 完成一次策略设置交易。
