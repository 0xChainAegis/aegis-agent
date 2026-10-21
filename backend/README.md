# Aegis HTTP backend

Node 24+, TypeScript, viem, Zod and built-in SQLite. Start from the repository root after the local deployment: `npm run start --workspace backend`. The default bind is `127.0.0.1:3001`; no `.env` files are read automatically.

The server reads `contracts/deployments/localhost.json`. Override its path with `AEGIS_DEPLOYMENT_FILE`, plus optional `AEGIS_MODE=local_chain|testnet|mock`, `AEGIS_RPC_URL`, `AEGIS_CHAIN_ID`, `AEGIS_DB_PATH`, `AEGIS_PORT`. `AEGIS_AGENT_PRIVATE_KEY` is an executor key, never an owner key. Only local chain 31337 on loopback RPC defaults to the public Hardhat account 1 key. Sepolia requires an explicit deployment file, HTTPS RPC and non-development agent key; missing contract/identity addresses fail during configuration. The service never switches into mock on an error. Mock mode has no chain execution.

For Sepolia, start from the repository root after `contracts/deployments/sepolia.json` has been created:

```sh
export AEGIS_MODE=testnet
export AEGIS_CHAIN_ID=11155111
export AEGIS_DEPLOYMENT_FILE="$PWD/contracts/deployments/sepolia.json"
export AEGIS_RPC_URL="https://your-sepolia-rpc"
export AEGIS_AGENT_PRIVATE_KEY="0x_your_agent_key"
npm run start --workspace backend
```

Before starting the UI, the same environment can run a read-only gate with
`npm run check:sepolia`. This command reads `contracts/.env`; exported
`AEGIS_*` variables take precedence. It maps the
deployment script's `RPC_URL` to the backend RPC setting, never
prints the RPC URL or private key, and never signs or broadcasts a transaction.

`GET /health` and `GET /api/v1/health` are process-liveness probes. They do not
depend on RPC availability. `GET /api/v1/readiness` checks all six bytecode
addresses: Wallet, ACL, Attestation, Oracle, PolicyEngine and Feed. It also verifies Wallet and
PolicyEngine bindings, Wallet consumer/manager authorization, the locked native
ETH Feed, executor and Wallet roles, Feed freshness, and both Wallet and executor
test-ETH balances. Readiness calls are deduplicated and cached briefly; use the
CLI for an explicit fresh check. Testnet deployment files must include `policyEngineAddress`;
old v1 deployment files fail closed instead of silently bypassing the engine.

RPC behavior can be bounded with `AEGIS_RPC_TIMEOUT_MS` (1000–30000,
default 8000), `AEGIS_RPC_RETRY_COUNT` (0–3, default 1), and
`AEGIS_READINESS_TTL_MS` (0–60000, default 5000). These inputs are validated at
startup.

Optional LLM draft parsing uses `AEGIS_LLM_MODE=off|stub|live` (default `off`), `AEGIS_LLM_PROVIDER=anthropic|openai`, `AEGIS_LLM_MODEL`, `AEGIS_LLM_BASE_URL`, `AEGIS_LLM_TIMEOUT_MS` and a process-environment API key. The model deadline defaults to 10 seconds (configurable from 1 to 30000 milliseconds). Public `planner.timeoutMs` lets the browser wait for intent parsing without extending payment deadlines. Keys are never committed or returned by `/api/v1/config`; `stub` is not live-model evidence.

## Contract and API boundary

Amounts are decimal integer strings: ETH in wei, USD in USD6. Parsing defaults to the deterministic `rule_parser`; an optional `AEGIS_LLM_MODE=stub|live` path can produce a draft with a strict JSON schema, but never authorizes or executes it. Only native ETH is supported. USD/other-token text asks for clarification, and never becomes an ETH amount. A complete draft still needs preview and explicit confirmation.

Public reads: `GET /health`, `GET /api/v1/health`, `GET /api/v1/readiness`, `GET /api/v1/config`, `GET /api/v1/docs/:slug`. Login: `POST /api/v1/auth/challenge {address,chainId}`, sign the returned message with the configured owner wallet, then `POST /api/v1/auth/verify {challengeId,address,signature}`. Every challenge binds domain, address, chain, random nonce and expiration, and is consumed once. Use the returned token in `Authorization: Bearer ...`.

Authenticated routes:

- `GET /api/v1/wallets/current`, `GET /api/v1/tasks`, `GET /api/v1/intents/:id`.
- `POST /api/v1/intents {message?,recipient?,amountWei?,purpose?}`.
- `PATCH /api/v1/intents/:id {expectedRevision,...editedFields}`.
- `POST /api/v1/intents/:id/preview {expectedRevision,maxUsdCost6?}`. Default cap is the displayed Feed valuation plus 1%, rounded up. The UI must show and confirm that cap.
- `POST /api/v1/intents/:id/submit {expectedRevision,quoteId}` returns a task with HTTP 202. The server verifies the stored quote, revision and expiry. Caller-supplied policy or execution fields are not accepted.
- `GET /api/v1/tasks/:id`, `GET /api/v1/tasks/:id/evidence`. Evidence preserves the preview-time chain-read decision and observed block, then binds an executed task's Wallet payment event to the PolicyEngine budget event in the same receipt. It exposes the actual decision, USD6 cost, cumulative daily spend, policy version and Chainlink Feed round. A rejected preview has no contract event because reverted EVM logs do not persist; its source remains explicitly `chain_read`, never `contract_event`.
- `GET /api/v1/tasks/:id/owner-tx?action=approve|cancel` prepares calldata; only the browser owner wallet signs/sends it. High-risk execution uses `owner_approve_and_execute`, not an executor-signed post-approval transaction.
- `POST /api/v1/tasks/:id/observed-tx {txHash,action:approve|cancel}` registers a hint. The backend independently verifies sender, target, calldata, receipt and matching contract event.

All business writes require `Idempotency-Key` (8–128 safe characters). Same owner/chain/route/key and content returns the same result; changed content returns 409. Submitted intents cannot be edited. Entities and login sessions are persisted in SQLite; raw signed transactions are private and never returned by the API.

## Recovery and verification

Run one backend process per executor/database. Execution is serialized. Before broadcast, the server persists signed bytes, transaction hash, sender nonce, request nonce and request hash. After timeout or restart it checks the same hash. It may rebroadcast the identical signed bytes; it never generates a replacement payment automatically. An unresolved request blocks allocation of another executor nonce.

Receipt status alone cannot mark success. `EXECUTED` requires both a matching Wallet `NativeTransferExecuted` event and a PolicyEngine `BudgetConsumed` event from the configured contracts in the same receipt. The backend verifies request hash, actor, native action type, AUTO/Owner-approval decision and USD6 cost before persisting the audit evidence in the task document. Queued and cancelled tasks correctly have no consumed-budget event. One mined confirmation is shown explicitly and is not irreversible finality. This local integration does not implement production multi-process signing, replacement transactions, deep-reorg recovery, autonomous top-up monitoring, arbitrary contract calls, subscriptions, x402, CCIP or RAG.

`npm test --workspace backend` covers real-signature login, nonce replay rejection, parser unit handling, optimistic versions, HTTP idempotency, duplicate submits, persisted pre-broadcast state, accepted-then-timeout recovery after SQLite restart, business event requirements, owner transaction binding and fail-closed RPC/policy errors. The fake chain in these unit/API tests is explicit; the root integration tests must exercise the deployed local contracts and real RPC separately.
