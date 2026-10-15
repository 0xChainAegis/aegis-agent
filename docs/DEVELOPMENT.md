# Development and Agent task protocol

## Start from the current repository

Use Node.js 24+ and the committed lockfile. Read `docs/DECISIONS.md` and
`docs/HANDOFF.md`, inspect current HEAD/PRs, then read today's task under
`docs/agent-tasks/`. Task files describe desired work, not facts already verified.

```sh
git status --short
git log -5 --oneline
npm ci
```

Confirm the base branch with the team. Create the task's suggested branch only
when executing that task; do not change branches over another person's unsaved
work. Do not force push, reset, delete another person's changes, auto-merge, send
messages to others or change organization permissions.

If a task is already implemented, run the relevant acceptance check. Report the
verified result and remaining gaps; do not reconstruct it or create an empty PR.

## Directory ownership

- MIA: `frontend/`, browser tests in the actual repository E2E directory, and
  product/demo documentation specifically allowed by the daily prompt.
- purple sun: `backend/` and `packages/shared/`. Shared ABI/type changes require
  an agreed contract with both consumers before editing.
- 某齐: `contracts/`, including source, tests, local deployment and package/config.
- Root package/lockfile, root scripts and CI are integration concerns. Ask the
  integration owner to coordinate dependency or CI changes instead of modifying
  those files from three competing branches. A task may propose an exact change.
- `docs/HANDOFF.md` updates are serialized by the integration owner. Each PR
  supplies its handoff entry in the PR body; no three-person concurrent rewrite.

## Run the local stack

Terminal 1, from the repository root:

```sh
npm run chain
```

Terminal 2, after the RPC is listening:

```sh
npm run deploy:local
npm run dev
```

Open `http://127.0.0.1:5173`. This runs real local transactions against a Mock Feed.
Local success does not prove Sepolia or a real market feed. If addresses or chain
are reset, use the corresponding fresh local database path rather than reusing
old-chain task evidence. Read `backend/README.md` for runtime configuration.

Useful checks, all from the repository root:

```sh
npm run compile
npm run typecheck
npm run build
npm run test:contracts
npm run test:backend
npm run check
```

`npm run check` does not include browser E2E. For browser testing, first inspect
the actual `playwright.config.*` and integration owner instructions. Then use
`npm run test:e2e` with its required services. If the suite/config/browser is not
available, record that exact blocker; do not report it as a passed check.

## What every task must return

1. Short outcome and changed paths, plus any verified no-change work.
2. Exact acceptance commands, pass/fail/skipped result and actual environment.
3. A reviewable diff and copyable PR title/body: problem, resulting behavior,
   validation, limits, and a handoff entry for the next person.
4. Dependencies that another teammate must merge or configure. Do not hide them
   by hardcoding addresses, changing shared units or adding a silent mock fallback.

Keep PRs small. Another teammate reviews; humans merge manually. An unavailable
check is a limitation, not a successful check. Never change assertions merely to
make a failing security test green.

## Fixed safety boundary for all daily prompts

- Do not open, print, upload or commit real `.env`, private keys, seed phrases,
  API secrets, session tokens, raw signed transactions or local databases.
- Code may read explicitly configured process environment at runtime. The Owner
  configures secrets locally; an Agent does not ask to paste them into chat/PRs.
- Never broadcast a Sepolia/mainnet transaction in these task runs. Prepare safe
  code, dry runs and guides. Human testnet execution is separately authorized and
  performed in the user's wallet; report it as pending until evidence is provided.
- Local chain 31337 transactions and tests are allowed. The public local account
  identity must remain loopback-only and must never be used with public funds.
- Do not change the $5/$10/$15 demo policy, remove hard checks, enable legacy
  funds exits or fake evidence to make the demo work.
- Model output is untrusted draft data. Policy, allowlist, signer and transaction
  authority remain deterministic and on-chain. Model text cannot trigger payment.
- Failure stays visible; no automatic mock mode. Label `rule_parser`, real model,
  Mock Feed, real Feed, queued, broadcast, unknown and executed truthfully.

## Schedule and cutoffs

10/16 verify the actual integration baseline. 10/17 integrate a draft-only model
adapter if practical. 10/18 prepare human-managed Sepolia setup. 10/19 establish
actual model/testnet evidence or cut claims and optional work. 10/20–21 stabilize
and regress; no new product paths. 10/22 finalize README/demo materials. 10/23
freeze before the 15:59 China time submission; the Owner submits. 10/24 morning
rehearse the frozen release, then present onsite in the afternoon.

EZKL is P2 only after the main flow is green. It must remain an optional separate
experiment and cannot block the demo, alter payment authorization or consume the
10/20–24 stabilization window.
