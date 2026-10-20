# Aegis native ETH contracts

This implementation authorizes fixed native ETH payments with a locked ETH/USD
feed. It is a local integration MVP. ERC20 payments, subscriptions and CCIP are
excluded from the wallet's payment path. `AegisCCIPSender` remains experimental
source and is never deployed or granted access by the local deployment script.

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
version. It contains no private keys. The script requires chain 31337 and uses
three distinct Hardhat accounts: owner 0, agent 1, recipient 2. It funds the vault
with 1 mock ETH, locks a $3,000 ETH/USD mock feed, and sets USD6 thresholds to
$5 automatic / $10 hard per payment / $15 shared daily. Local Hardhat keys are
public development keys and must never hold real funds. `npm run deploy` uses
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
  The wallet enforces the request's USD maximum, hard per-payment cap and one
  shared vault budget keyed by UTC day (`block.timestamp / 86400`). Network gas
  paid by the transaction sender is outside the transferred-value USD budget.
- LowRisk requests at or below the automatic threshold execute immediately;
  other valid requests queue. Pending requests do not reserve balance or budget.
  Approval can therefore fail if other payments spend the budget first.
- Owner `approveAndExecute(attestationId)` executes the stored recipient and ETH
  amount. It rechecks role, tier, allowlist, expiry, original policy version,
  oracle quote, USD maximum, per-payment limit, today's cap and available ETH.
  Approval grants no exception to these hard rules.
- Policy and allowlist changes increment the policy version and invalidate old
  pending requests. They never erase daily spending. The owner can cancel an
  invalidated pending request; a new request must use a fresh nonce.
- A failed ETH call rolls back the nonce, budget, pending mutation and attestation
  changes. ReentrancyGuard protects payment and approval entry points.

`NativeTransferExecuted` is the execution evidence: request hash, attestation ID,
actor, fixed recipient/amount, actual USD6 cost, round ID, timestamp and policy
version. Attestation `approved` alone is not execution proof. Only the wallet is
initially granted ATTESTER_ROLE; the trusted owner retains administration powers.
There is no claim that this provides immutable records against a malicious owner.

## Compatibility and boundaries

`depositETH` and direct ETH receipt work. The old `requestTransfer`, ERC20 deposit
and subscription methods explicitly revert, including when called directly
without the UI. Legacy ACL raw `autoLimit` is informational; native authorization
uses wallet USD6 limits. Oracle `getUsdValue` retains a read-only USD8 return;
payment authorization exclusively uses `latestEthQuote` USD6.

An oracle configuration is locked once. Changing feeds requires a new oracle and
a versioned wallet policy update. The underlying feed operator remains trusted.
The wallet owner and ACL role administrator are trusted policy administrators;
they can change future policy. This design constrains the agent, not the owner.

`MockV3Aggregator` and `AdversarialReceiver` are local/test helpers, never suitable
production oracle or recipient implementations. Tests exercise real local ETH
balance changes and receipts, stale/invalid feed data, approval rechecks, shared
budgets across concurrent agents, expiry, replay, rejection rollback and reentry.

## Sepolia deployment

The Sepolia script is deliberately fail-closed. It requires an HTTPS RPC, a
non-development private key, three distinct owner/agent/recipient identities,
explicit USD6 policy limits, initial vault funding, and an explicitly supplied
ETH/USD Feed address. Before deploying, it verifies the Feed bytecode and current
round freshness. After deployment, it verifies contract bytecode, Wallet bindings,
roles, locked Feed configuration, allowlist, tier, and vault balance.

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
verification summary to `deployments/sepolia.json`; that runtime file is ignored
by Git. Never place an owner key in the backend executor-key setting.
