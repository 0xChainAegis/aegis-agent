<p align="center">
  <img src="frontend/public/aegis-hero.png" width="100%" alt="Aegis: a white ceramic A icon and wordmark with the line Agent wallet control.">
</p>

<p align="center">
  <strong>Gas-reserve top-ups for agent operating wallets, with every payment under control.</strong><br>
  On-chain USD limits · Explicit confirmation · Verifiable outcomes
</p>

<p align="center">
  English · <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="#product-screenshots">Screenshots</a> ·
  <a href="#problem-and-solution">About</a> ·
  <a href="#user-flow">Flow</a> ·
  <a href="#where-chainlink-and-ai-fit">Chainlink</a> ·
  <a href="#quickstart">Run</a> ·
  <a href="#validation">Validation</a> ·
  <a href="#event-origin">Event</a> ·
  <a href="#team">Team</a> ·
  <a href="#documentation">Docs</a>
</p>

## <img src="docs/images/section-screens.svg" width="24" height="24" alt="" align="absmiddle"> Product screenshots

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

### 4. Light, dark, and mobile

The top-right appearance button switches between light and dark. The choice is saved in the current browser. Switching appearance does not submit a payment or clear reserve settings. This is the actual dark workspace; the top-up suggestion has not been submitted.

![Actual dark wallet workspace on the local chain and Mock Feed, with the same amounts and explicit confirmation boundary](docs/images/reserve-dark.png)

Actual light and dark interfaces at 390px. The operating wallet, reserve editor, and preparation action stack vertically, with reachable bottom navigation.

<p align="center">
  <img src="docs/images/reserve-mobile.png" width="300" alt="Actual light mobile interface showing the operating wallet and ETH reserve settings.">
  <img src="docs/images/reserve-mobile-dark.png" width="300" alt="Actual dark mobile interface for the same wallet and settings.">
</p>

## <img src="docs/images/section-problem.svg" width="24" height="24" alt="" align="absmiddle"> Problem and solution

**Problem.** An agent's operating wallet needs native ETH to pay transaction fees. When it runs dry the agent stops, and letting the agent refill itself would hand fund authority to automation.

**Solution.** One funding-pool smart contract pays native ETH to one configured receiving operating wallet to replenish its gas reserve. The user sets a threshold and target in the browser; Aegis suggests target minus actual balance, rechecks when preparing, and after explicit user confirmation the contract executes within its whitelist, permissions and USD limits. Payments above the approval threshold need Owner approval; payments above the hard cap are blocked.

**Four distinct roles.**

- **Owner (funding administrator)**, `ownerAddress`: administers the pool and approves pending payments.
- **Executor**, `agentAddress`: submits payment requests within authorized rules.
- **Pool contract**, `walletAddress`: holds and pays the top-up funds.
- **Receiving operating wallet**, `recipientAddress`: receives ETH and is shown on the overview; receiving grants no administrative rights.

Pool and operating-wallet balances are read separately. The LLM only drafts: it never signs and cannot bypass approvals.

## <img src="docs/images/section-flow.svg" width="24" height="24" alt="" align="absmiddle"> User flow

1. Choose and connect a wallet extension, then select “Sign in as Owner.” The default local deployment also offers a local test wallet. Login does not authorize a payment.
2. On Overview, read operating-wallet balance B. Set the threshold to B + 0.0005 ETH and the target to B + 0.001 ETH.
3. Prepare the 0.001 ETH suggestion, inspect the confirmation drawer, confirm, then check the task, receipt and event evidence.
4. At the initial mock price a 0.002 ETH payment needs a separate Owner approval; 0.004 ETH exceeds the hard cap and is blocked. Owner approval cannot override hard limits.
5. Refresh to recover the same task. An unknown broadcast stays under reconciliation; it is not reported as a successful payment or replaced with a new one.

Budget accumulates across executed payments; pending requests reserve neither funds nor budget. Start a fresh local chain and database to repeat the full scenario.

## <img src="docs/images/section-features.svg" width="24" height="24" alt="" align="absmiddle"> Features

- Read the operating wallet's actual ETH balance, bound to the returned wallet address and observation block.
- Set a browser-local reserve threshold and target; calculate the exact target-minus-balance top-up. The settings are not on-chain policy and not an automatic scheduler.
- Re-read configuration, balance and pending tasks before preparing; a changed amount must be reviewed again.
- Preview the recipient, ETH amount, USD estimate, user-confirmed USD cap on the transferred principal and approval requirement.
- After explicit confirmation, follow the original task through execution, Owner approval, cancellation or reconciliation.
- Light/dark appearance with a browser-local preference; the same workflow on desktop and mobile.

The pool balance, the executor's transaction-gas balance and the recipient's operating reserve are separate.

## <img src="docs/images/section-chainlink.svg" width="24" height="24" alt="" align="absmiddle"> Where Chainlink and AI fit

**Chainlink ETH/USD Data Feed** prices the transferred principal and takes part in the contract's final authorization decision, including approval-time revalidation:

- [AegisPriceOracle.sol](contracts/contracts/AegisPriceOracle.sol) validates feed rounds, answers, timestamps and decimals, and rounds USD6 valuations upward.
- [AegisPolicyEngine.sol](contracts/contracts/AegisPolicyEngine.sol) applies permissions, the recipient allowlist, approval thresholds and the shared daily USD budget.
- [AegisWallet.sol](contracts/contracts/AegisWallet.sol) enforces quote freshness, user-confirmed USD maximums, per-payment and shared daily limits, recipient permissions, nonce, deadline and policy version.
- [chain.ts](backend/src/chain.ts) reads snapshots and quotes, simulates execution, and validates transaction and event binding.
- [MockV3Aggregator.sol](contracts/contracts/mocks/MockV3Aggregator.sol) supplies the local demo and fault-test data.

ETH/USD values the transferred principal; it is not a gas-price oracle. The sender pays transaction gas separately.

**AI.** Rules are the default. `AEGIS_LLM_MODE=live` enables Anthropic or OpenAI-compatible draft parsing; `stub` is an offline test mode and does not demonstrate a real model. Model responses undergo schema and parameter checks: stale values cannot replace the user's new address or amount, and ambiguous fields require clarification. Every draft still needs preview and explicit confirmation, subject to on-chain limits, fresh prices and replay protection. See [integration configuration](docs/INTEGRATION.md).

Optional live models were evaluated on a historical 40-case dataset and have not been re-tested since the safety fixes; rules and stub scores are not model accuracy. See the [intent evaluation report](eval/REPORT.md). The Python Agent under `agent/` is an early prototype outside the current TypeScript runtime.

## <img src="docs/images/section-architecture.svg" width="24" height="24" alt="" align="absmiddle"> Architecture and stack

```text
Browser UI ─ local API + SQLite ─ funding pool ─ ETH/USD feed
 (Vite/TS)   (Node 24, viem, Zod)  (Solidity)    (Mock locally)
```

- One funding pool, one allowed receiving operating wallet, one Owner and one restricted executor; Owner login and approvals use wallet signatures.
- Local chain 31337 is used for repeatable tests. Ethereum Sepolia is the public test network; see Validation below for acceptance status.
- See [architecture](docs/ARCHITECTURE.md), [API and local integration](docs/INTEGRATION.md) and [security boundaries](docs/SECURITY.md).

## <img src="docs/images/section-start.svg" width="24" height="24" alt="" align="absmiddle"> Quickstart

Requires Node.js 24+ and npm. Run commands from the repository root.

```bash
npm ci --ignore-scripts
```

> If npm 12 reports `EALLOWGIT`, the lockfile contains a commit-pinned Git dependency. Verify its source and follow [npm's allow-git configuration](https://docs.npmjs.com/cli/v12/using-npm/config/#allow-git). Switching SSH to HTTPS still leaves a Git dependency; retain the repository lockfile.

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

Connect first opens a chooser with the detected extensions' names and icons, using EIP-6963 with legacy injection support. Choosing an extension reads its account and network. If the account matches the pool's Owner, explicitly select “Sign in as Owner.” Other accounts can remain connected in read-only mode.

A network mismatch requests the extension's native switch confirmation. Switching to Sepolia does not change the backend or the Owner of a testnet contract. For a personal-wallet local demo, set the public `AEGIS_LOCAL_OWNER_ADDRESS` before deployment; see [wallet connection and Owner configuration](docs/INTEGRATION.md#owner-登录). Local `npm run dev` maintains the verified Mock Feed's timestamp; this maintainer is disabled for testnet and the automated E2E stack.

The deployment funds the pool with 1 ETH and configures a $5 threshold for execution without separate Owner approval, a $10 hard per-payment cap and a $15 shared UTC daily budget. The local Mock Feed initially returns $3,000 per ETH.

Layout: `frontend/` (Vite + TypeScript UI), `backend/` (Node.js, viem, Zod, SQLite), `contracts/` (Solidity, Hardhat, deployment, contract tests), `packages/shared/` (API types and ABI), `agent/skills/` (intent parsing prompt; other Python prototypes are outside the current runtime).

## <img src="docs/images/section-verify.svg" width="24" height="24" alt="" align="absmiddle"> Validation

```bash
npm run check
npm run test:e2e
```

Verified on this version with Node 24: type checks and production builds, **34 contract tests**, **47 backend test counts** including nested tests, and **38 browser cases** (31 wallet, network and readiness cases; 7 reserve cases). Another **9 offline Mock-maintainer tests** and **7 offline model-launcher tests** pass. Browser cases cover real local payments, Owner approval and cancellation, network switching, account changes during login, expired-price payment blocking, disconnection, and recovery after refresh.

Contract tests cover authorization, oracle boundaries, budgets, approvals, replay and direct-call rejection. Backend tests cover HTTP boundaries, persistent recovery, event binding and operating-wallet address binding with explicit chain fixtures. Browser tests use real local contracts and balances with a Mock Feed, including confirmation, approval/cancellation, changed suggestions, missing data, missing or mismatched operating-wallet identity, offline failure and refresh without duplicate payment.

The browser entry starts a fresh chain and database for each group. Stop manually running services on ports 5173, 3001 and 8545 first. Windows can use installed Chrome; other environments may need `npx playwright install chromium`.

### Deployment and execution evidence

The local payment flow is verified. The Sepolia v2 deployment report provides contract addresses and read-only binding checks, but live browser payments are still pending acceptance. The [intent evaluation report](eval/REPORT.md) preserves historical model results and limitations; its scores do not describe the current version.

The demo covers one funding pool, one receiving operating wallet and native ETH. Scheduled automatic payments, multi-wallet management, subscriptions and CCIP execution are outside the delivered scope.

All published payment-execution evidence comes from the local chain; there is no accepted record of a Sepolia browser payment yet. Running `npm run deploy:local` writes the actual addresses to the local `contracts/deployments/localhost.json` file. Each executed task exposes its transaction receipt, matching contract event, recipient, amount and request hash in the verification view.

Public-network payment transaction links will be published after a browser payment is accepted. A read-only Feed connectivity check does not establish that Aegis was deployed or made a payment.

## <img src="docs/images/section-team.svg" width="24" height="24" alt="" align="absmiddle"> Event origin

Built at the ETH Shenzhen 2026 Hackathon.

<img src="docs/images/eth-shenzhen-2026-poster.png" width="100%" alt="ETH Shenzhen 2026 Hackathon event poster.">

## <img src="docs/images/section-team.svg" width="24" height="24" alt="" align="absmiddle"> Team

<table width="100%">
  <tr>
    <td width="25%" align="center" valign="top">
      <a href="https://github.com/mia03ther"><img src="https://github.com/mia03ther.png?size=144" width="64" height="64" alt="GitHub avatar of MIA_Ether"><br><b>MIA_Ether</b></a><br>
      <sub>Product · Frontend<br>Integration</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <a href="https://github.com/gitgdut"><img src="https://github.com/gitgdut.png?size=144" width="64" height="64" alt="GitHub avatar of purple sun"><br><b>purple sun</b></a><br>
      <sub>Backend<br>Smart contracts</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <a href="https://github.com/qiwei999"><img src="https://github.com/qiwei999.png?size=144" width="64" height="64" alt="GitHub avatar of qiwei999"><br><b>qiwei999</b></a><br>
      <sub>Intent parsing<br>Boundary validation</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <a href="https://github.com/mantianxingdou10086"><img src="https://github.com/mantianxingdou10086.png?size=144" width="64" height="64" alt="GitHub avatar of 满天星斗烟火繁"><br><b>满天星斗烟火繁</b></a><br>
      <sub>Agent engineering<br>Intent evaluation</sub>
    </td>
  </tr>
</table>

## <img src="docs/images/section-architecture.svg" width="24" height="24" alt="" align="absmiddle"> Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Components, identities and balances, reserve and payment lifecycle |
| [API and local integration](docs/INTEGRATION.md) | Endpoints, local operation and verification record |
| [Security boundaries](docs/SECURITY.md) | Authorization, integrity and known limits |
| [Contract rules](contracts/README.md) | On-chain authorization rules and local deployment |
| [Interface design system](frontend/DESIGN.md) | Layout, themes, components and accessibility |
| [Live LLM integration](docs/LLM-LIVE-LOCAL.md) | Environment variables, launchers and local limits for live mode |
| [Intent evaluation report](eval/REPORT.md) | 40 cases, results for three parsers and failure attribution |

[Contributors](https://github.com/0xChainAegis/aegis-agent/graphs/contributors) · MIT — see [LICENSE](LICENSE).

<p align="center">
  <img src="frontend/public/favicon.svg" width="28" height="28" alt="Aegis">
</p>
