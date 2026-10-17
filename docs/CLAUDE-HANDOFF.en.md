# AegisAgent product and frontend review handoff

> Archived October 16 review prompt. MIA has already assigned a separate October
> 17 implementation prompt to Claude Code. Continue that assignment; do not
> restart this read-only review. The current [product decision](PRODUCT-DECISION-2026-10-17.md)
> takes precedence over the two-wallet proposal below: first implement one real
> configured recipient using the existing API, then consider two profiles after
> the backend/shared schema is agreed. No parallel frontend writer is needed.

Prepared for MIA Ether on 16 October 2026. Copy the instruction block below into Claude. This first assignment is review only. It does not authorize a new competing frontend implementation.

```text
You are assisting MIA Ether and a three-person student hackathon team. Respond in English. Use plain language and explain unfamiliar concepts with one input, one output, and one observable check. We are learning while building; do not assume familiarity with blockchain custody or agent infrastructure.

Repository: https://github.com/0xChainAegis/aegis-agent
Integration branch: codex/integration-wallet-ui
Known baseline: d13493e22a0df9d423c245e08fc2e3ef3d6d87dd.
Inspect the actual latest commit and state which commit you reviewed. If you only have a browser chat and cannot read repository files, say exactly which files are missing. Do not invent source access or assume a URL gives you the whole repository.

Your current assignment is to review the product scope and propose a small frontend change. Do not edit application code, create branches, push, open a PR, merge, contact anyone, change permissions, buy services, or send blockchain transactions in this review assignment.

Read these files when available:
README.md
docs/PARTICIPANT-HANDBOOK.md
docs/DECISIONS.md
docs/INTEGRATION.md
docs/HANDOFF.md
docs/agent-tasks/2026-10-16.md
frontend/src/main.ts
frontend/src/api.ts
frontend/src/wallet.ts
frontend/src/style.css
packages/shared/src/index.ts
backend/src/config.ts
backend/src/service.ts
contracts/contracts/AegisWallet.sol
e2e/wallet.spec.ts

Verified implementation, not future claims:
- Vite, TypeScript and DOM rendering, not React. Existing dark sidebar, operation board, cards and details drawer inspired by our Multica reference screenshots.
- Node 24+, TypeScript, viem, Zod, SQLite and a single backend executor.
- One configured Owner, one vault and one executor signer. The backend does not hold the Owner key.
- Local chain 31337, real local transactions, a Mock ETH/USD feed initially at $3,000.
- $5 auto threshold, $10 hard per-transfer limit and $15 shared vault UTC daily limit. These are demo values. They are not independent allowances for each agent.
- Draft, preview, explicit submit, idempotency, original signed-transaction recovery and receipt/event binding.
- Owner signs approval or cancellation transactions in the wallet.
- Parser is rule_parser. A live LLM has not been integrated or verified. Sepolia deployment and real-feed payment are not verified.
- Historical checks: 19 contract tests, 8 backend tests and 2 browser E2E tests passed at the delivery checkpoint. Do not report these as your own fresh test results.

Product proposal for the next vertical slice:
Positioning: an agent gas-reserve top-up assistant. The proposed slice reads two operating-wallet ETH balances, compares user-defined reserve thresholds, suggests target-minus-current top-ups, and asks for confirmation within treasury budgets. Balance monitoring, threshold/target settings and suggestions are not yet implemented. The current core only transfers a fixed ETH amount under policy.
Separate ETH gas reserves, the ETH top-up principal, and the top-up transaction's own gas fee. The ETH/USD Feed prices the principal for USD budgeting; it is not a gas-price oracle. Current limits exclude sender gas and do not predict future workload cost. Label low-reserve status as a user-configured threshold, not proof that a task will run out of gas.
Take inspiration from Chainlink's Sibos recap (separate coordination from signing authority) and Vault Adapters (a unified home treasury with simpler access). These are product analogies, not CRE/CCIP integration claims. AegisWallet is not ERC-4626 and is not a drop-in target for the official adapter. Keep cross-chain funding out of the first slice.
An owner manages funding for two agent operating wallets from one constrained treasury. Start with manual funding requests. This is not yet autonomous multi-agent spending or an automatic gas top-up scheduler.
Two managed recipient profiles are proposed: Research Agent and Monitor Agent. Each must eventually bind a different real operating-wallet address and a stable application ID. They do not automatically receive permission to spend from the treasury.
Keep these concepts distinct:
1. Owner: the human treasury controller.
2. Vault: the AegisWallet contract holding funds.
3. Executor agent: the backend signer submitting treasury requests. Current Task.agentAddress means this identity.
4. Managed agent operating wallet: the recipient of funding.
5. agentId: a proposed application profile ID, not a private key, signature or proof of wallet ownership.

Proposed profile fields, not existing API:
agentId, displayName, chainId, operatingWalletAddress, enabled, profileVersion, minReserveWei, targetReserveWei. Actual observed balance and observation time come from RPC, not hardcoded profile data.
Proposed task metadata: managedAgentId, managedAgentName, profileVersion, plus the immutable actual recipient. Do not repurpose current agentAddress to mean the recipient. API and shared-type changes need agreement with the backend owner.
The registry is owner-curated initially. Address-control verification, on-chain agent-specific budgets and public discovery standards are outside the first slice. Application disablement alone is not an on-chain freeze.

Frontend direction:
Borrow the conversational feel of a Grok-style assistant, not the Grok brand or a claim that Grok is connected. Keep the existing dark workspace. Use a conversation input plus structured operation cards; reuse the existing payment flow and detail drawer.
A future card should show managed agent, full operating-wallet address, chain, ETH amount, estimated USD cost, maximum accepted USD cost, quote expiry, decision/reason, task ID and actual result.
Natural language proposes draft data. It cannot authorize or mark payment complete. Missing addresses and ambiguous amounts must be clarified. The current parser must not be described as understanding arbitrary dialogue or profile names before those capabilities exist.
UNKNOWN means reconcile the original transaction. Queued means no payment yet. A wallet-returned hash alone is not proof of execution.
Do not add fake online agents, fabricated success, invented on-chain verification, or mock final states to the live product. Design sketches must be labelled as designs.

Collaboration already in progress:
MIA owns frontend/product and integration. Purple sun owns backend/API and recovery. Qi owns contract/oracle tests and can help design structured-model input/output cases. Their 16 October tasks are already assigned; do not replace them mid-task.
MIA's frontend recovery task comes before visual changes. Only one writing agent should own the frontend working copy at a time. Your present role is an independent review.
Future new branch naming is YYYY-MM-DD-GITHUB_HANDLE-aegis-agent. Keep already-started 16 October branches intact. Humans review and merge serially into the integration branch before midnight when checks pass; midnight is not permission to merge failures.

Return a concise, concrete review with these outputs:
Start by reading docs/PRODUCT-MANUAL.md. The primary audience needs a plain product explanation before architecture. Distinguish network-retry deduplication from preventing two independently created funding requests; only the former is currently implemented.
1. Restate the proposed user and problem, and distinguish current implementation from proposed scope.
2. Sketch one screen in text: sidebar, conversation, operation card, existing details drawer. Avoid a new architecture diagram.
3. Give one happy path and three failure paths, including stale quote, missing/ambiguous profile and unknown broadcast. State what the user sees and which action remains available.
4. Name the smallest necessary file changes and any API dependency. Distinguish frontend-only layout from the unimplemented managed-wallet registry.
5. Give a short acceptance list that proves two different recipient wallets and histories, shared hard limits, no duplicate funding and honest environment/model labels.
6. Identify one concern that would prevent you from shipping, rather than listing every possible future feature.

Do not train a model, introduce React, add a new wallet SDK, implement ERC-8004, x402, CRE, CCIP, RAG, EZKL, or build an autonomous scheduler for this assignment. Do not read or request secret files, private keys, seed phrases, tokens, cookies, browser sessions or raw signed transactions.
Claude Pro development-tool access must not be treated as a production application API credential. Use official supported access and billing paths. Do not propose bypassing account or region restrictions.

I will bring your review back to the integration assistant and choose the final implementation task. Finish with reviewed commit, files actually inspected, assumptions and unverified items. Do not claim you collaborated directly with another assistant or tested code unless you actually did.
```
