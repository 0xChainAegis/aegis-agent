# Execution evidence

[简体中文首页](../README.md) · [English overview](../README.en.md) · [Chainlink integration](CHAINLINK.md)

## Confirmed public-testnet payment

On 2026-10-22, the deployment Owner confirmed a native ETH refill through the Aegis web application. The restricted executor submitted it to Ethereum Sepolia. The acceptance checkout was commit `19ed4404342e949d55f849bf18f10023a5eb2a1d`.

- [Transaction](https://sepolia.etherscan.io/tx/0x47340b28f1b5eaa11c4ce8e2ffadc2937dfb0f3d55ffb35add32c40fb2bfcec2): `0x47340b28f1b5eaa11c4ce8e2ffadc2937dfb0f3d55ffb35add32c40fb2bfcec2`.
- Block: `11969287`; receipt status: `1`; block time: `2026-10-22T11:36:36Z`.
- Request hash: `0x6494a3827ff2fb7ae32316a5ad045eb6db2d5fe988687b4ff86fc39ab7765f9d`.
- Principal: `0.0001 ETH`; policy cost: `240072 USD6` (`0.240072 USD`).
- [Public read-only verification snapshot](evidence/sepolia-payment-2026-10-22.json), recorded at `2026-10-22T11:40:18.958Z`.

The pool contract `0xD7FD1c334c24FcAb35cF6200F470ab8F238347E8`, executor `0xB9E9E2a7F26D135f5A51B3e785A844b3C12a51c3`, Owner `0x17cB337e22e6B0F1471a8ff0491198dfF2882913` and recipient `0xB2a6b60D51A24a8Dc7DFCE8A2be0a64188f7A87F` are distinct roles. Merely connecting an address does not give it control of this pool.

## What was checked

An independent read-only JSON-RPC check examined the transaction, receipt, canonical block, calldata, decoded logs, and balances at the preceding and execution blocks. The published snapshot contains 13 explicit checks:

1. Receipt status is successful.
2. Transaction hash matches.
3. Receipt block hash matches the canonical block.
4. Sender and destination match the configured executor and pool.
5. Decoded calldata binds the recipient and amount.
6. Request hash is consistent with the execution evidence.
7. Wallet event matches the actor, recipient and amount.
8. Wallet event records the accepted policy version.
9. Policy event matches the actor and native-transfer action.
10. Wallet and policy events agree on cost and cumulative spend.
11. Recipient balance increased by exactly `100000000000000 wei`.
12. Pool balance decreased by exactly that principal.
13. Executor balance decreased by exactly the receipt's transaction fee.

All 13 were true in the recorded snapshot. The pool changed from `0.005` to `0.0049 ETH`; the recipient changed from `0` to `0.0001 ETH`.

The receipt used `1216072` gas at `37 wei` effective gas price, for a fee of `44994664 wei`. The 19 confirmations observed at verification time are historical observations, not a promise of irreversible finality or current balances.

## Reproduce the public checks

No wallet connection or private key is required to inspect this transaction. Open the transaction link and compare its status, block, sender, destination, input and logs with the snapshot. A Sepolia JSON-RPC provider can supply:

```text
eth_chainId
eth_getTransactionByHash(transactionHash)
eth_getTransactionReceipt(transactionHash)
eth_getBlockByNumber(11969287, false)
eth_getBalance(address, 11969286)
eth_getBalance(address, 11969287)
```

JSON-RPC block arguments must be hex quantities. Decode calldata and logs with the ABIs built from the [Wallet](../contracts/contracts/AegisWallet.sol) and [PolicyEngine](../contracts/contracts/AegisPolicyEngine.sol) sources. Some providers limit historical reads; a failed provider request alone does not invalidate a mined receipt. Do not send another transaction just to inspect this evidence.

## Evidence scope

- **This payment:** one user-confirmed, native ETH refill on Sepolia, using the **rule parser**. It is not evidence of a live LLM request, multi-user onboarding, CCIP execution, or all rejection and approval cases working on Sepolia.
- **Local automated tests:** deterministic unit, contract and browser cases, using a local chain and mock feed. The [CI workflow](../.github/workflows/ci.yml) and its [actual runs](https://github.com/0xChainAegis/aegis-agent/actions/workflows/ci.yml) show which revisions were checked.
- **Read-only Sepolia readiness:** verifies the deployed contract configuration, roles, live feed and balances without spending funds. See [Sepolia setup](SEPOLIA-DEMO.md). It does not prove a payment occurred.
- **Historical model evaluation:** the [40-case report](../eval/REPORT.md) states its model, baseline and limitations. Those historical scores are not current-version accuracy measurements.

Public evidence contains only chain-visible addresses, hashes, receipt fields and verification results. Private keys, API keys, authentication messages, session tokens and local databases are excluded. This evidence is not a production security audit or a claim of product-market fit.
