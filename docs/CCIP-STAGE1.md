# CCIP unified policy — backend and testnet route

## What is complete

- `AegisCCIPSender` sends an allowlisted ERC-20 through Chainlink CCIP while the
  shared `AegisPolicyEngine` enforces role, recipient, destination, USD6
  per-action limit, shared UTC daily budget, policy version and expiry.
- The request binds token, amount, destination receiver, chain selector, policy
  quote cap, native Router-fee cap and the sender contract's own agent nonce.
- Automatic execution, Owner approval, cancellation, replay protection and
  rollback on Router failure are contract-tested.
- Local development remains opt-in with `AEGIS_LOCAL_CCIP_FIXTURE=1`; it uses an
  explicit Mock Router and never claims public delivery.
- Sepolia deployment is also opt-in with `CCIP_ENABLED=1`. The supported public
  route is Ethereum Sepolia to Base Sepolia with CCIP-BnM:
  - source selector: `16015286601757825753`
  - destination selector: `10344971235874465080`
  - destination chain ID: `84532`
- Deployment validates the official Router lane and source token, deploys the
  sender and test valuation feed, configures policy roles, deposits CCIP-BnM and
  Sepolia ETH for fees, performs the Owner handoff and records destination
  metadata in `deployments/sepolia.json`.
- The backend accepts only a structured `CCIP_TRANSFER` draft. Preview reads the
  token valuation and current Router fee, then binds both user-confirmed caps in
  the plan hash. Natural-language CCIP is rejected instead of silently becoming
  an ETH payment.
- Source success requires matching `CCIPTransferExecuted` and `BudgetConsumed`
  events in the same receipt. The backend retains the emitted CCIP `messageId`.
- `GET /api/v1/tasks/:id/ccip-delivery` separately checks Chainlink's CCIP status
  service. It binds message ID, source transaction, sender, receiver, both chain
  identities, both token addresses and amount. `DELIVERED` also requires a
  destination transaction hash.
- `npm run check:sepolia` fails when a configured CCIP deployment does not pass
  its on-chain sender, route, funding and freshness preflight.

## Testnet valuation boundary

CCIP-BnM is a faucet token and has no meaningful public USD market price. The
deployment therefore uses `AegisTestnetPriceFeed`, an Owner-controlled test-only
Aggregator-compatible value. `CCIP_TEST_TOKEN_PRICE_USD8=100000000` means the
policy treats one CCIP-BnM as test $1. This is not a Chainlink Data Feed and must
never be presented as market evidence.

The test value is still freshness-bounded by `MAX_PRICE_AGE`. Once stale, preview
and execution stop until the final Owner calls `updateAnswer` with a positive
test value. This makes the trust boundary visible and fail-closed.

The feed never updates itself, so a deployment stops working for CCIP one
`MAX_PRICE_AGE` after the last update. Check the age read-only, then refresh as
the Owner (the configured signer must be the feed Owner):

```bash
set -a
source contracts/.env
set +a
npm run refresh:ccip-feed --workspace contracts
CCIP_FEED_REFRESH=1 npm run refresh:ccip-feed --workspace contracts
```

The first invocation is read-only. The second broadcasts an Owner transaction,
spends a small amount of Sepolia ETH and resubmits the current positive test
value unless `CCIP_TOKEN_PRICE_USD8` is explicitly provided.

## Deployment and validation

Copy the documented values from `contracts/.env.example` into the ignored
`contracts/.env`. Obtain CCIP-BnM from Chainlink's test-token faucet and fund the
deployer with Sepolia ETH. Then run:

```bash
cd contracts
set -a
source .env
set +a
npm run validate:sepolia
npm run deploy:sepolia
cd ..
npm run check:sepolia
```

`validate:sepolia` is read-only. `deploy:sepolia` broadcasts multiple Sepolia
transactions and spends test ETH/CCIP-BnM. `check:sepolia` is read-only.

After Owner authentication, the HTTP draft is:

```json
{
  "actionKind": "CCIP_TRANSFER",
  "recipient": "0x...",
  "tokenAddress": "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
  "amountWei": "1000000000000",
  "destinationChainSelector": "10344971235874465080",
  "purpose": "Sepolia to Base Sepolia CCIP test"
}
```

Preview accepts optional decimal-string `maxUsdCost6` and `maxFeeWei`; submit
requires the returned `planHash`. Poll the task until its source state is
`EXECUTED`, then query `/api/v1/tasks/:id/ccip-delivery` until it becomes
`DELIVERED` or `FAILED`.

## Contract behaviour notes

- A queued transfer past its deadline cannot be executed: `approveAndExecute`
  reverts with `REQUEST_EXPIRED`, and the Owner can only `cancelPending` it. The
  Agent must submit a fresh request (new nonce).
- `depositToken` is permissionless by design. Extra tokens only enlarge the vault;
  spending still requires an Agent request approved by the shared PolicyEngine.
- Messages use `gasLimit = 0`, which is correct for token-only delivery to an
  EOA. Allowlisted receivers must be EOAs; a contract receiver would need
  destination gas added to the CCIP `extraArgs` first.
- The `CCIPTransferExecuted` log is emitted with raw `log4` to avoid
  stack-too-deep. Its topic comes from `CCIPTransferExecuted.selector` and a test
  decodes the log against the ABI, so the event and the emitter cannot drift.

## Remaining boundary

- The frontend has a dedicated CCIP page: fixed-route form, preview with fee and
  plan hash, Owner approval, and a destination-delivery panel that only reports
  delivery after Chainlink's status API matches the source task. It is covered by
  `npm run test:e2e:ccip` against a real local chain (auto, Owner approval,
  per-transaction block, fee increase after preview, browser input rejection).
  A local chain has no Chainlink destination record, so those tests assert the
  UI never claims delivery; destination delivery is only provable on Sepolia.
- No public testnet deployment or transfer is claimed by source tests alone. A
  real end-to-end claim requires a fresh deployment manifest, a source receipt,
  the emitted message ID and a matching Base Sepolia destination receipt.
- Deep-reorg recovery, multi-process signing and replacement transactions remain
  outside this stage.
