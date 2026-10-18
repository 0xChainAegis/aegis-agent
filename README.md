# AegisAgent

English | [简体中文](README.zh-CN.md)

Gas-reserve top-ups for agent operating wallets, bounded by on-chain USD budgets and explicit confirmation.

Built during ETH Shenzhen 2026 Hackathon. The current release runs on a local Ethereum development chain with a Mock ETH/USD Feed. Natural-language input uses a rule parser; a live LLM and public-testnet deployment have not been verified.

## Product

- Read the configured operating wallet's actual ETH balance and observation block.
- Set a browser-local reserve threshold and target; calculate the exact target-minus-balance top-up.
- Re-read configuration, balance and pending tasks before preparing. Review a changed amount again.
- Preview the recipient, ETH amount, USD estimate, maximum accepted cost and approval requirement.
- Confirm explicitly, then follow the original task through execution, Owner approval, cancellation or reconciliation.

The treasury balance, executor's transaction-gas balance and recipient's operating reserve are separate. Reserve settings are suggestions, not on-chain policy or an automatic scheduler.

## Product screenshots

Captured from the running application on local chain **31337**, using a **Mock ETH/USD Feed**. The demonstration thresholds are set relative to the actual prefunded wallet balance; the displayed balance is not fabricated.

### 1. Check the operating reserve

The balance is below the explicitly configured demo threshold. The application suggests the exact target-minus-balance amount: **0.001 ETH**.

![Operating-wallet reserve and an exact 0.001 ETH top-up suggestion](docs/images/reserve-low.png)

### 2. Review before paying

Review the recipient, **0.001 ETH** amount and **$3.00** mock-feed valuation. Preparing a preview does not pay; the user must confirm explicitly.

![Top-up preview showing recipient, amount, USD valuation and confirmation](docs/images/reserve-preview.png)

### 3. Recover the completed task

After the confirmed local-chain transfer and a page refresh, the reserve is healthy and the original executed task is recovered. The accompanying browser test verifies that no second payment is created.

![Healthy operating reserve and the recovered task after refresh](docs/images/reserve-after-refresh.png)

## Run locally

Requires Node.js 24+ and npm. Run commands from the repository root.

```bash
npm ci --ignore-scripts
```

Terminal 1:

```bash
npm run chain
```

Terminal 2, after the RPC starts:

```bash
npm run deploy:local
```

Terminal 3:

```bash
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API listens on port 3001 and the local RPC on 8545; chain ID is 31337. Select the explicit local test-wallet entry to sign in with the public development Owner. These development accounts and ETH have no real-world value and must not be used for public funds.

The deployment funds the treasury with 1 ETH and configures a $5 threshold for execution without separate Owner approval, a $10 hard per-payment cap and a $15 shared UTC daily budget. Every payment still requires explicit user confirmation. The local Mock Feed initially returns $3,000 per ETH.

## Demo

1. Read operating-wallet balance B on Overview. Set the threshold to B + 0.0005 ETH and target to B + 0.001 ETH. These test settings account for the prefunded local account; no balance is fabricated.
2. Prepare the 0.001 ETH suggestion. Inspect the confirmation drawer, then confirm. Check the resulting task and receipt/event evidence.
3. A 0.002 ETH payment at the initial mock price requires a separate Owner approval. A 0.004 ETH payment exceeds the hard cap and is blocked. Owner approval cannot override hard limits.
4. Refresh to recover the same task. An unknown broadcast remains under reconciliation; it is not reported as a successful payment or replaced with a new payment.

Budget accumulates across executed payments. Pending requests do not reserve funds or budget. Start a fresh local chain and database when repeating the complete test scenario.

## Chainlink integration

ETH/USD data is part of the contract's final authorization decision, including approval-time revalidation:

- [AegisPriceOracle.sol](contracts/contracts/AegisPriceOracle.sol) validates feed rounds, answers, timestamps and decimals, and rounds USD6 valuations upward.
- [AegisWallet.sol](contracts/contracts/AegisWallet.sol) enforces quote freshness, user-confirmed USD maximums, per-payment and shared daily limits, recipient permissions, nonce, deadline and policy version.
- [chain.ts](backend/src/chain.ts) reads snapshots and quotes, simulates execution, and validates transaction and event binding.
- [MockV3Aggregator.sol](contracts/contracts/mocks/MockV3Aggregator.sol) supplies the local demo and fault-test data.

ETH/USD values the transferred principal; it is not a gas-price oracle. The sender pays transaction gas separately. This repository does not claim a verified Sepolia payment or live Chainlink Feed integration yet.

## Validation

```bash
npm run check
npm run test:e2e
```

Verified locally on October 18, 2026 with Node 24.19.0: type checks and production builds; **27 contract tests**, **26 backend test counts** including nested tests; **6 browser cases** across independent wallet and reserve stacks.

Contract tests cover authorization, oracle boundaries, budgets, approvals, replay and direct-call rejection. Backend tests cover HTTP boundaries, persistent recovery and event binding with explicit chain fixtures. Browser tests use real local contracts and balances with a Mock Feed, including confirmation, approval/cancellation, changed suggestions, missing data, offline failure and refresh without duplicate payment.

The browser entry starts a fresh chain and database for each group. Stop manually running services on ports 5173, 3001 and 8545 first. Windows can use installed Chrome; other environments may need `npx playwright install chromium`.

## Implementation

- `frontend/`: Vite and TypeScript DOM interface.
- `backend/`: Node.js, viem, Zod and SQLite.
- `contracts/`: Solidity, Hardhat, deployment and contract tests.
- `packages/shared/`: API types and ABI signatures.
- `agent/`: early Python prototype, outside the current runtime.

[Architecture](docs/ARCHITECTURE.md) · [API and local integration](docs/INTEGRATION.md) · [Security boundaries](docs/SECURITY.md)

MIT — see [LICENSE](LICENSE).
