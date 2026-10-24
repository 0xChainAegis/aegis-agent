# Chainlink integration

[简体中文首页](../README.md) · [English overview](../README.en.md) · [Execution evidence](EVIDENCE.md)

Aegis uses Chainlink ETH/USD Data Feeds to enforce a dollar-denominated spending policy for native ETH refills. The feed is read by the contracts at execution time; the application cannot replace the quote with an LLM response or a browser-supplied price.

## Execution path

1. `AegisPriceOracle.latestEthQuote` reads the configured feed with `latestRoundData()` and checks a positive answer, a complete round, a nonzero timestamp no later than the current block, and unchanged feed decimals. The feed configuration is locked after setup.
2. `AegisPolicyEngine.evaluate` checks the action, executor role and tier, recipient allowlist, request deadline and policy version. It obtains the ETH/USD quote, checks `maxPriceAge`, the request's maximum USD cost, the per-transaction cap and the shared UTC-day budget.
3. `AegisWallet` requires Owner approval when the policy requests it. Execution calls `validateAndConsume`, which evaluates the policy again and consumes the request once. An approval cannot override a rejected hard limit or a stale quote.
4. `BudgetConsumed` and `NativeTransferExecuted` bind the request hash, executor and cost. The wallet event also records the quote round, update time and policy version.

Source: [Oracle](../contracts/contracts/AegisPriceOracle.sol), [PolicyEngine](../contracts/contracts/AegisPolicyEngine.sol), [Wallet](../contracts/contracts/AegisWallet.sol).

## Units and rounding

For an ETH amount in wei, a positive feed answer and feed decimals `d`:

```text
costUsd6 = ceil(amountWei × answer / 10^(12 + d))
1 USD = 1,000,000 USD6
```

The implementation uses OpenZeppelin `Math.mulDiv` with upward rounding. It does not use floating-point arithmetic. Rounding upward prevents a small positive transfer from consuming zero budget through truncation.

The verified Sepolia instance has a **5 USD automatic-approval threshold**, **10 USD per-transaction limit** and **15 USD UTC-day limit**. These are this deployment's configured values, not fixed Chainlink parameters. The automatic path still requires the user's explicit confirmation in the web application. A high-risk executor can require Owner approval even below the automatic threshold.

## Verified Sepolia payment

- Network: Ethereum Sepolia, chain ID `11155111`.
- ETH/USD feed: [`0x694AA1769357215DE4FAC081bf1f309aDC325306`](https://sepolia.etherscan.io/address/0x694AA1769357215DE4FAC081bf1f309aDC325306).
- Aegis oracle: [`0x9e0ceDC45735fF77821EE24DF5305Bfe9FE961b4`](https://sepolia.etherscan.io/address/0x9e0ceDC45735fF77821EE24DF5305Bfe9FE961b4).
- Payment: [`0x47340b28f1b5eaa11c4ce8e2ffadc2937dfb0f3d55ffb35add32c40fb2bfcec2`](https://sepolia.etherscan.io/tx/0x47340b28f1b5eaa11c4ce8e2ffadc2937dfb0f3d55ffb35add32c40fb2bfcec2), block `11969287`.
- Principal: `100000000000000 wei` (`0.0001 ETH`). Recorded cost: `240072 USD6` (`0.240072 USD`).
- Recorded quote round: `18446744073709588605`; quote update timestamp: `1792667160`.
- The matching budget and wallet events, receipt and balance deltas are published in the [evidence JSON](evidence/sepolia-payment-2026-10-22.json).

## Boundaries

The ETH/USD feed values the transferred ETH principal. It does **not** estimate transaction gas prices. The restricted executor pays the transaction fee separately; that fee is not part of the principal's USD budget.

Feed validation and on-chain permissions do not prove an LLM understood a user's intent. The accepted payment above used the rule parser, not a live model. Prompt scanning is an additional heuristic, not a complete prompt-injection defense. Aegis also exposes finite ETH subscriptions and a fixed Sepolia → Base Sepolia CCIP-BnM route. Those flows use separate transaction bindings and evidence; this native-payment record does not prove their execution.

Local contract tests use a mock feed for deterministic price and boundary cases. A live read-only feed check proves connectivity and configuration only. The confirmed payment proves the execution described above. These are separate kinds of evidence; none is a production security audit.

Deployment and readiness instructions: [Sepolia demo](SEPOLIA-DEMO.md).
