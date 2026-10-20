# Architecture

AegisAgent provides gas-reserve recommendations for one configured operating
wallet and executes explicitly confirmed native ETH payments under on-chain
USD limits. The current verified environment is a local Hardhat chain with a
Mock Feed. A real Sepolia deployment and live Chainlink Feed remain unverified.

## Components

- `frontend/`: Vite and TypeScript DOM interface; wallet login, reserve card,
  draft review, approval, task history and transaction evidence.
- `backend/`: Node.js 24+, TypeScript HTTP API, viem RPC/signing adapter, Zod
  validation and built-in SQLite persistence.
- `packages/shared/`: API types and current contract ABI signatures.
- `contracts/`: Solidity wallet, shared deterministic PolicyEngine, access
  control, attestation and locked ETH/USD oracle adapter; Hardhat builds, tests
  and local deployment.
- `agent/`: historical Python prototype, outside the current runtime.

## Identities and balances

The Owner signs login challenges and approval/cancellation transactions. The
backend executor is a separate authorized account that submits payment requests.
The operating wallet is the configured recipient, not the executor by definition.

Balance snapshots distinguish the treasury contract (`walletBalanceWei`),
executor gas (`agentBalanceWei`) and recipient reserve (`recipientBalanceWei`).
The snapshot identifies chain, treasury, the operating wallet's `recipientAddress`
and the observed block. The UI accepts `recipientBalanceWei` only when that address
matches the configured recipient; a missing or different address is rejected.

## Reserve and payment lifecycle

1. Read the configured recipient balance. Browser-local threshold and target
   settings produce `target - balance` only when below the threshold; unavailable
   balance data remains unknown.
2. Re-read configuration, balance and in-flight tasks before preparing a draft.
   A changed suggestion requires review. These reads do not reserve funds.
3. Form input or the deterministic `rule_parser` creates a draft. No live LLM
   participates. Preview binds the draft revision, ETH amount, USD maximum,
   policy version and expiry; the user must explicitly confirm submission.
4. The backend persists the signed transaction and its identities before
   broadcast. The Wallet enforces the nonce and owns execution; the PolicyEngine
   enforces action kind, recipient, executor role/tier, deadline, policy version,
   freshly priced USD limits and the shared daily budget.
5. LowRisk requests within the automatic threshold execute. Other permitted
   requests queue for Owner `approveAndExecute`; hard-limit failures are rejected.
   Approval rechecks the original request against current conditions.
6. Policy consumption and transfer occur in one transaction, so a failed transfer
   rolls back the budget. Matching contract events determine task outcome. A
   queued request or a successful receipt without the expected event is not
   evidence of payment.

ETH quantities use integer wei; USD budgets use USD6 with upward rounding.
Chainlink ETH/USD values transferred principal, not gas prices. Sender fees are
outside this budget. Reserve settings are recommendations, not on-chain policy,
and concurrent wallet activity can change the final balance.

See [API and local operation](INTEGRATION.md), [security boundaries](SECURITY.md)
and the [contract rules](../contracts/README.md). Subscription and CCIP action
kinds are reserved but rejected in phase one; automatic monitoring, multiple
wallet profiles, CCIP execution and x402 are outside the current flow.
