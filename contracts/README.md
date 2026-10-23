# Aegis native ETH contracts

This implementation authorizes fixed native ETH payments and finite subscriptions
through a shared deterministic `AegisPolicyEngine`. A policy-gated
`AegisCCIPSender` is also implemented and contract-tested for allowlisted ERC20
CCIP transfers. CCIP is not yet included in the default local or Sepolia
deployment scripts and is not exposed by the HTTP/UI product flow.

## Local integration

The project uses Hardhat 2 and npm-pinned solc 0.8.24. Configuration does not load
`.env` files automatically.

```sh
npm install
npm test
npm run node
```

In another terminal, from this directory:

```sh
npm run deploy:local
```

`deployments/localhost.json` contains public addresses, chain ID, RPC URL and ABI
version. It contains no private keys. The deployment includes ACL, Attestation,
Oracle, PolicyEngine and Wallet contracts. The script requires chain 31337 and
uses three distinct Hardhat accounts: owner 0, agent 1, recipient 2. It funds the
vault with 1 mock ETH, locks a $3,000 ETH/USD mock feed, and sets USD6 thresholds
to $5 automatic / $10 hard per payment / $15 shared daily. Local Hardhat keys
are public development keys and must never hold real funds. `npm run deploy` uses
an ephemeral in-process chain and writes `hardhat.json` instead.

## Authorization rules

- `requestNativeTransfer` accepts recipient, fixed ETH amount, maximum USD6 cost,
  nonce, deadline and current policy version. The contract derives the hash from
  these fields plus requester, chain ID, wallet address and a domain constant.
- The requester needs AGENT_ROLE and LowRisk or HighRisk tier. Frozen and
  ReadOnly cannot queue or execute. Recipient must be allowlisted.
- Every accepted request consumes its requester nonce, including queued requests.
  Reverting requests consume no wallet nonce. Cancelled nonces cannot be reused.
- USD6 costs round upward. Each execution uses fresh positive, complete feed data
  with a valid timestamp, stable decimals, and age at most `maxPriceAge` seconds.
  The PolicyEngine enforces the request's USD maximum, hard per-payment cap and
  one shared budget keyed by UTC day (`block.timestamp / 86400`). Every registered
  executor consumes this same budget. Network gas paid by the transaction sender
  is outside the transferred-value USD budget.
- LowRisk requests at or below the automatic threshold execute immediately;
  other valid requests queue. Pending requests do not reserve balance or budget.
  Approval can therefore fail if other payments spend the budget first.
- Owner `approveAndExecute(attestationId)` executes the stored recipient and ETH
  amount. It rechecks role, tier, allowlist, expiry, original policy version,
  oracle quote, USD maximum, per-payment limit, today's cap and available ETH.
  Approval grants no exception to these hard rules.
- Policy and allowlist changes in the PolicyEngine increment the policy version
  and invalidate old pending requests. They never erase daily spending. The
  owner can cancel an invalidated pending request; a new request must use a fresh
  nonce.
- A failed ETH call rolls back the nonce, budget, pending mutation and attestation
  changes. ReentrancyGuard protects payment and approval entry points.

`NativeTransferExecuted` is the payment execution evidence: request hash,
attestation ID, actor, fixed recipient/amount, actual USD6 cost, round ID,
timestamp and policy version. PolicyEngine `BudgetConsumed` additionally records the request hash,
action kind, ALLOW/REQUIRE_APPROVAL decision and shared-budget total. Attestation
`approved` alone is not execution proof. Only the Wallet is registered as the
initial policy consumer and manager and granted ATTESTER_ROLE; the trusted owner
retains administration powers. A consumer must be a deployed contract and is a
trusted execution boundary: arbitrary consumers must never be authorized.

## Compatibility and boundaries

`depositETH` and direct ETH receipt work. The old `requestTransfer`, ERC20 deposit
and subscription methods explicitly revert, including when called directly
without the UI. Legacy ACL raw `autoLimit` is informational; native authorization
uses wallet USD6 limits. Oracle `getUsdValue` retains a read-only USD8 return;
payment authorization exclusively uses `latestEthQuote` USD6.

An oracle configuration is locked once. Changing feeds requires a new oracle and
a versioned PolicyEngine update. The underlying feed operator remains trusted.
The PolicyEngine owner and ACL role administrator are trusted policy
administrators; they can change future policy and authorized executors. This
design constrains the agent, not the owner.

`MockV3Aggregator` and `AdversarialReceiver` are local/test helpers, never suitable
production oracle or recipient implementations. Tests exercise real local ETH
balance changes and receipts, stale/invalid feed data, approval rechecks, shared
budgets across concurrent agents, expiry, replay, rejection rollback and reentry.

## CCIP contract stage

`AegisCCIPSender` holds allowlisted ERC20 liquidity and native ETH for router
fees. Agent requests bind the source token, amount, destination receiver, CCIP
chain selector, maximum USD6 value, maximum native fee, nonce, deadline and
policy version. The PolicyEngine prices the token with its locked token/USD feed
and applies the same roles, recipient allowlist, automatic/Owner decision,
per-action limit and UTC daily budget used by native payments and subscriptions.

The Owner cannot override hard policy through approval. Execution requotes both
the asset and router fee; a changed price, policy, route or fee can keep a queued
request pending. Router failure rolls back budget, nonce and attestation changes.
`CCIPTransferExecuted` plus the matching `BudgetConsumed` event is the source-side
execution evidence. It proves submission to the configured router, not final
delivery on the destination chain. The current mock router only supports local
tests and must never be deployed.

## Sepolia deployment

The Sepolia script is deliberately fail-closed. It requires an HTTPS RPC, a
non-development deployer private key, three distinct final Owner/agent/recipient identities,
explicit USD6 policy limits, initial vault funding, and an explicitly supplied
ETH/USD Feed address. Before deploying, it verifies the Feed bytecode and current
round freshness. After deployment, it verifies contract bytecode, Wallet and
PolicyEngine bindings, Wallet consumer/manager authorization, roles, locked Feed
configuration, allowlist, tier, vault balance, final ownership and administration roles.

`PRIVATE_KEY` identifies the funded deployer that sends the deployment and setup
transactions. Optional `OWNER_ADDRESS` is the public address of the final Owner's
externally owned wallet; it does not require that Owner's private key. When omitted,
the deployer remains Owner, preserving the existing default. Explicit blank, zero,
invalid or conflicting Owner addresses fail before deployment. Owner preflight
accepts empty account code or an exact 23-byte [EIP-7702 delegation indicator](https://eips.ethereum.org/EIPS/eip-7702)
(`0xef0100` followed by a nonzero 20-byte target). Delegated EOAs retain normal
ECDSA signing and transaction origination; nonempty code alone does not make them
ordinary contract wallets. A zero-target authorization clears code to empty; a
stored zero-target marker or any malformed indicator is rejected. Ordinary contract
wallets and addresses of the five contracts about to be deployed remain rejected.
This format check does not audit the delegated implementation. Owner login still
requires a normal EOA message signature; ERC-1271-only or relayed account-abstraction
wallet flows are not implemented, and the presenting browser must support that flow.

Setup completes under the deployer before handing Wallet, PolicyEngine and Oracle
ownership to the final Owner. The final Owner also receives ACL `DEFAULT_ADMIN_ROLE`,
`OWNER_ROLE`, `GUARDIAN_ROLE`, and Attestation `DEFAULT_ADMIN_ROLE` and `APPROVER_ROLE`.
When the final Owner differs from the deployer, all five deployer administration
roles are revoked and checked. The agent's restricted executor role and the Wallet's
policy consumer/manager and attester/approver grants remain intact. Owner approvals
still obey the hard transaction and daily budget rules. This handoff consists of
separate confirmed transactions; it is not atomic, and a failed run requires checking
the completed on-chain steps before continuing.

Each user's pool is a separate deployment with that user's own `OWNER_ADDRESS` and
a separate `AGENT_ADDRESS`. Fund that restricted executor with Sepolia ETH for gas;
vault funding does not fund the executor. The deployer cannot also be the agent or
recipient. Keep each executor's key and backend/database specific to its own pool;
the current backend serves one configured pool, without a universal Owner login.

Copy `.env.example` to the ignored `contracts/.env`, fill every value, and verify
`ETH_USD_FEED_ADDRESS` against Chainlink's official deployment list. Then run:

```sh
cd contracts
set -a
source .env
set +a
npm run validate:sepolia
npm run deploy:sepolia
```

This is the only command in this section that broadcasts transactions and spends
Sepolia ETH. A successful run writes the public, non-secret addresses and its
verification summary to `deployments/sepolia.json`, the compatibility pointer to the
latest pool. It also preserves each pool at
`deployments/sepolia/<owner-address>/<wallet-address>.json`, using lowercase addresses,
so deploying another pool does not overwrite earlier handoff records. Both locations
are ignored runtime files, contain public metadata only, and include `deployerAddress`
separately from the final `ownerAddress`. PolicyEngine v2 changes constructor bindings, so a v1 deployment JSON is
not compatible and must be replaced by an explicit new deployment. Never place
an owner key in the backend executor-key setting.
