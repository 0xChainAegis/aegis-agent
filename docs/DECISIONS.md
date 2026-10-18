# AegisAgent decisions

Updated: 2026-10-18. Read this with the latest code and `docs/HANDOFF.md`.

Repository decision: `main` is the only local and remote branch retained after
the October 18 consolidation. Prior daily/integration branch instructions are
historical. MIA coordinates reviewed, tested fast-forward pushes to `main`;
teammates use separate working copies and hand over commits/bundles without
creating new branches. See `docs/DEVELOPMENT.md` for the current workflow.

Current product direction is recorded in [the October 17 product decision](PRODUCT-DECISION-2026-10-17.md): gas-reserve top-up assistance for agent operating wallets. The first frontend slice now reads one real configured recipient balance, stores browser-local thresholds and targets, rechecks the suggestion, and uses the bounded payment core after explicit confirmation. It passed local-chain browser checks with a Mock Feed. Multi-wallet profiles, automatic monitoring, Sepolia/real Feed and a live LLM remain unverified or unimplemented.

## Product and authority

- The selected product story is gas-reserve top-up assistance for an agent's
  operating wallet, using the existing constrained native ETH payment core.
  The first slice reads one real recipient balance and proposes a top-up for
  explicit confirmation. Automatic monitoring or automatic top-up is not an
  implemented feature or a prerequisite for the demo.
- **Owner means the user who controls the on-chain wallet owner address.** Owner
  signs login messages and queued approve/cancel transactions in a wallet. The
  backend holds only the agent executor identity. A GitHub organization Owner is
  a repository administration role, not permission to move wallet funds. Three
  organization Owners do not imply three on-chain wallet Owners.
- The owner and ACL administrator are trusted policy administrators. The hard
  boundaries constrain agents under the active policy; they do not claim to
  prevent a trusted owner from changing future policy.

## Scope and security invariants

- One public target: Ethereum Sepolia, native ETH only. Local development uses
  chain 31337. No mainnet or real assets are part of this work.
- Baseline thresholds are USD6: automatic $5, hard per-payment $10, shared vault
  UTC calendar-day $15. The contract reprices at execution and rounds upward.
  These are configurable demo policy values, not investment or risk ratings.
- Every payment path enforces recipient allowlist, agent role/tier, valid quote,
  amount, USD maximum, hard caps, nonce, deadline and policy version. Owner
  approval is not a hard-limit exception. Frozen and ReadOnly cannot queue or pay.
- Approval binds the originally queued recipient and ETH amount. Repricing may
  make approval fail. Pending requests do not reserve funds or daily budget.
- Policy/allowlist changes invalidate old pending requests without clearing
  today's spending. Cancelling an old request does not free its consumed nonce.
- The legacy ERC20 and subscription wallet exits are disabled. CCIP, x402, MCP,
  autonomous top-up, multi-chain execution and arbitrary calls are outside P0.
- A successful transaction receipt alone is insufficient. Execution evidence
  needs the correct wallet event and matching complete intent hash/parameters.
  A queued attestation or an `approved` flag alone does not prove payment.

## Implementation baseline

- Runtime: Node.js 24+, TypeScript backend, viem, Zod, built-in SQLite; Vite/TS
  frontend; Solidity/Hardhat 2 contracts. The legacy Python files are not the
  runtime for the new wallet flow. Do not rebuild the backend in Python.
- `packages/shared/` owns shared API types and ABI signatures. Changes require
  coordination between frontend, backend and contracts; avoid silent ABI drift.
- Current natural-language handling is `rule_parser`. **No live LLM integration
  is implemented or verified in this baseline.** A future model may propose a
  validated draft; it cannot authorize payment, set policy or bypass confirmation.
- Local transactions use actual local contracts with a **Mock Feed**. Mock quotes
  are not live Chainlink market data. Failure never silently switches to mock.
- Real Sepolia deployment, real ETH/USD Feed wiring and the complete public
  testnet demo are **not yet verified**. Preparation and read-only checks do not
  count as a completed testnet payment. Record human-run evidence before claiming
  otherwise. Public deployment remains disabled in the baseline scripts.
- EZKL is P2 optional research, isolated from payment authorization. A proof is
  not required for a quote, approval or transfer. Omit it if the core is not green.

## Collaboration and release

- MIA: frontend and product; purple sun: TypeScript backend and API; 某齐:
  contracts, oracle and tests. The user resolves cross-domain scope decisions.
- Use small changes based on current `main`, with one writer per working copy.
  Do not recreate dated branches, integration branches or release branches.
  Deliver commits or a bundle to MIA for serialized integration and publishing.
- Another person reviews each change. Humans decide integration. No auto-merge, automatic
  permission changes, self-approved releases or unsolicited external messages.
- Agents must not open/read/print/submit real secret files, private keys, seed
  phrases or API secrets. Configuration is performed by the Owner locally. Never
  paste secrets into issues, PRs, screenshots, logs or the repository.
- Task agents do not broadcast Sepolia/mainnet transactions. They prepare code,
  dry runs and public configuration guides; explicit human execution is a separate
  step. Local chain 31337 transactions are allowed for tests.
- Work from the latest HEAD and handoff. If a task is already implemented, verify
  it and report evidence; do not repeat it or create an empty PR.
- Deadline: 2026-10-23 15:59 China time submission. Freeze earlier that day.
  2026-10-24 morning is rehearsal; the onsite presentation is in the afternoon.
  Verify official event instructions before the human submits materials.
