# Aegis wallet UI

A Vite + TypeScript interface for the real `/api/v1` native ETH payment flow. No random transaction hashes, simulated wallet connections or client-only success states are used.

Run from the repository workspace:

```sh
npm ci --ignore-scripts
npm run dev:frontend
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to `http://127.0.0.1:3001`. Start the chain, deploy local contracts and start the backend using the repository instructions. If the API or on-chain readiness check fails, payment controls stay disabled and the UI reports the actual problem.

## Wallets and environment

- Browser wallet: EIP-1193, explicit `eth_requestAccounts`, personal-sign challenge login, session token in `sessionStorage`. Account/network changes invalidate the session. Login does not approve a payment.
- Local test wallet: shown only when the API reports `local_chain`, chain ID 31337 and a loopback RPC, and the page itself is on localhost. The user must explicitly confirm use of the public, unlocked development Owner account. No private key is included or read. Every RPC action checks the actual chain ID. The proxy refuses arbitrary accounts and value-bearing Owner transactions. This cannot be used for Sepolia or public assets.
- Local means real transactions on a local development chain with a **Mock Feed**, not public Chainlink market data. The interface labels this distinction. The current natural-language parser is a deterministic rule parser, not an LLM.

## Payment flow

Overview includes a reserve card for the configured operating wallet. It reads
the actual recipient balance, stores browser-local threshold/target preferences,
and calculates the exact top-up with BigInt arithmetic. Preparing re-reads the
configuration, balance and tasks; a changed suggestion requires another review.
The card uses the same preview and explicit confirmation path described below.
Missing data is shown as unavailable, never zero. No automatic scheduler runs.

1. Describe an ETH payment or enter an address and ETH amount. ETH is parsed using `viem.parseEther`; integer wei strings are sent to the API.
2. Review the server draft and current chain preview. Missing fields must be supplied; a blocked preview cannot be submitted. The sample recipient is filled only after an explicit user click.
3. Confirm submission. Poll the original task for its actual status and transactions; a broadcast is not shown as payment completion.
4. For queued payments, review Owner action data. The UI checks chain, target wallet, zero attached value, exact approve/cancel method, attestation ID and backend-confirmed pending binding before opening the wallet.
5. Owner signs and sends. The original hash is kept in session storage before observation; if observation fails, retry observation of that hash rather than sign again.
6. Open task evidence for chain event matching, request-hash binding, transaction details and the raw server response. A queued event is explicitly distinguished from an executed transfer.

`legacy-demo.html` preserves the former static simulation with a prominent warning. It is not connected to the live application.

## Validation

`npm run build --workspace frontend` runs strict TypeScript checking and a production Vite build. Browser test hooks are provided for the repository integration suite:

- `local-wallet` → `confirm-local-wallet`, or `connect-wallet`
- `intent-message`, `recipient-input`, `amount-input`, `send-intent`
- `confirm-transfer`, `approve-task`, `cancel-task`, `sign-owner-transaction`
- Operation cards carry `data-task-id`; navigation uses `.nav-item[data-nav=...]`.

Meaningful integration cases: offline controls disabled; local-wallet guard refuses nonlocal config; unsigned draft never pays; successful small payment produces a real matching receipt; above-auto-limit request waits for Owner; Owner approve/cancel uses the actual wallet transaction; hard budget blocks both automatic and Owner execution; changed input or expired quote requires new preview; unknown broadcasts only reconcile the original task; account/network change clears the session; task evidence distinguishes queued and executed results. The root integration tests own these real-chain scenarios.
