# CCIP unified policy — contract stage

## What is complete

- `AegisPolicyEngine` accepts `CCIPTransfer` only for a non-native asset and a
  nonzero, allowlisted destination chain selector.
- Token value is read from a locked Chainlink-compatible token/USD feed and
  consumes the same USD6 daily budget as native ETH and subscription payments.
- `AegisCCIPSender` supports preview, automatic execution, Owner approval,
  cancellation, per-agent nonces, request hashes, attestations and source-chain
  execution events.
- The request binds a maximum native CCIP fee. Approval and execution requote the
  router fee and reject an increase above that user-confirmed bound.
- Local tests cover allow, approval, unauthorized callers, disabled routes,
  unknown recipients/assets, fee limits, changed quotes, cancellation, replay,
  router rollback and shared-budget contention with the native wallet.

## What is not complete

- The default local and Sepolia deployment scripts do not deploy the sender,
  token feed or CCIP router configuration yet.
- Backend/API/UI action models do not expose CCIP yet.
- No public testnet token has been sent. Destination-chain delivery and finality
  evidence are not implemented.

For that reason this stage must not be described as a complete end-to-end CCIP
product. `CCIPTransferExecuted` proves a source-chain router submission only.
