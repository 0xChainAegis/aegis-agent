# Aegis HTTP backend

Node 24+, TypeScript, viem, Zod and built-in SQLite. Start from the repository root after the local deployment: `npm run start --workspace backend`. The default bind is `127.0.0.1:3001`; no `.env` files are read automatically.

The server reads `contracts/deployments/localhost.json`. Override its path with `AEGIS_DEPLOYMENT_FILE`, plus optional `AEGIS_MODE=local_chain|testnet|mock`, `AEGIS_RPC_URL`, `AEGIS_CHAIN_ID`, `AEGIS_DB_PATH`, `AEGIS_PORT`. `AEGIS_AGENT_PRIVATE_KEY` is an executor key, never an owner key. Only local chain 31337 on loopback RPC defaults to the public Hardhat account 1 key. Sepolia requires an explicitly configured agent key and matching deployment; missing RPC/Feed/key fails closed. The service never switches into mock on an error. Mock mode has no chain execution.

## Contract and API boundary

Amounts are decimal integer strings: ETH in wei, USD in USD6. Current parsing is explicitly `rule_parser`; no LLM network call or API key is needed. Only native ETH is supported. USD/other-token text asks for clarification, and never becomes an ETH amount. A complete draft still needs preview and explicit confirmation.

Public reads: `GET /health`, `GET /api/v1/config`, `GET /api/v1/docs/:slug`. Login: `POST /api/v1/auth/challenge {address,chainId}`, sign the returned message with the configured owner wallet, then `POST /api/v1/auth/verify {challengeId,address,signature}`. Every challenge binds domain, address, chain, random nonce and expiration, and is consumed once. Use the returned token in `Authorization: Bearer ...`.

Authenticated routes:

- `GET /api/v1/wallets/current`, `GET /api/v1/tasks`, `GET /api/v1/intents/:id`.
- `POST /api/v1/intents {message?,recipient?,amountWei?,purpose?}`.
- `PATCH /api/v1/intents/:id {expectedRevision,...editedFields}`.
- `POST /api/v1/intents/:id/preview {expectedRevision,maxUsdCost6?}`. Default cap is the displayed Feed valuation plus 1%, rounded up. The UI must show and confirm that cap.
- `POST /api/v1/intents/:id/submit {expectedRevision,quoteId}` returns a task with HTTP 202. The server verifies the stored quote, revision and expiry. Caller-supplied policy or execution fields are not accepted.
- `GET /api/v1/tasks/:id`, `GET /api/v1/tasks/:id/evidence`.
- `GET /api/v1/tasks/:id/owner-tx?action=approve|cancel` prepares calldata; only the browser owner wallet signs/sends it. High-risk execution uses `owner_approve_and_execute`, not an executor-signed post-approval transaction.
- `POST /api/v1/tasks/:id/observed-tx {txHash,action:approve|cancel}` registers a hint. The backend independently verifies sender, target, calldata, receipt and matching contract event.

All business writes require `Idempotency-Key` (8–128 safe characters). Same owner/chain/route/key and content returns the same result; changed content returns 409. Submitted intents cannot be edited. Entities and login sessions are persisted in SQLite; raw signed transactions are private and never returned by the API.

## Recovery and verification

Run one backend process per executor/database. Execution is serialized. Before broadcast, the server persists signed bytes, transaction hash, sender nonce, request nonce and request hash. After timeout or restart it checks the same hash. It may rebroadcast the identical signed bytes; it never generates a replacement payment automatically. An unresolved request blocks allocation of another executor nonce.

Receipt status alone cannot mark success. Only a matching `NativeTransferExecuted` event marks `EXECUTED`; queued events mark `AWAITING_APPROVAL`. One mined confirmation is shown explicitly and is not irreversible finality. This local integration does not implement production multi-process signing, replacement transactions, deep-reorg recovery, autonomous top-up monitoring, arbitrary contract calls, subscriptions, x402, CCIP or RAG.

`npm test --workspace backend` covers real-signature login, nonce replay rejection, parser unit handling, optimistic versions, HTTP idempotency, duplicate submits, persisted pre-broadcast state, accepted-then-timeout recovery after SQLite restart, business event requirements, owner transaction binding and fail-closed RPC/policy errors. The fake chain in these unit/API tests is explicit; the root integration tests must exercise the deployed local contracts and real RPC separately.
