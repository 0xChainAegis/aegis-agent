# 2026-10-17 · MIA · Gas-reserve top-up slice (frontend)

Output report, not the task instruction file.

## Baseline

- Repository: https://github.com/0xChainAegis/aegis-agent
- Base branch: `codex/integration-wallet-ui`
- Actual base SHA (fetched 2026-10-17): `a3bd9fbbea94745d1f601852ab21570ffd2ff853` (same as the prompt)
- Task branch: `2026-10-17-mia03ther-aegis-agent`
- Working copy: a fresh, isolated clone in the agent's cloud sandbox. No existing working copy on MIA's
  computer was opened or changed, so there was no overlap with another agent.
- Teammate branches checked (`git rev-list` against the base): `purple/1016-recovery-boundaries`,
  `qi/1016-oracle-approval-regressions`, `qi/1017-direct-call-security-cases` have no commits beyond the
  base (already merged); `docs/verifiable-policy` only adds `docs/VERIFIABLE-POLICY.md`. None touch
  `frontend/` or `e2e/`. The GitHub PR API was not reachable from the sandbox, so open PRs were not listed.
- No `AGENTS.md` exists in the repository.

## Changed files

| File | What |
|---|---|
| `frontend/src/reserve.ts` (new) | BigInt-only helpers: parse ETH input (`viem.parseEther`, ≤18 decimals, >0), validate threshold < target, bind config → `{chainId, treasury, recipient}`, validate snapshot, suggestion = target − balance, browser-local storage |
| `frontend/src/main.ts` | Gas-reserve card on Overview; prepare/recheck flow into the existing draft → preview → confirm path; draft-drawer context section; failed snapshot now clears stale wallet data |
| `frontend/src/style.css` | Card styles in the existing dark language (desktop, ≤1200px, ≤800px) |
| `e2e/gas-reserve.spec.ts` (new) | Healthy, invalid/missing/offline, changed-balance cases (no payment) |
| `e2e/wallet.topup.spec.ts` (new) | The one real local top-up payment + refresh case |
| `e2e/reserve-helpers.ts` (new) | Shared RPC/login/write-tracking helpers (not a spec file) |
| `docs/daily/2026-10-17/mia.md` | This report |

Not touched: `backend/`, `contracts/`, `packages/shared/`, root package/lock files, `scripts/`,
`playwright.config.ts`, CI, task instructions, other reports.

## What the user does / what the app does

1. Log in as Owner (browser wallet or explicit local test wallet).
2. Overview shows a **运行钱包 Gas 准备金 · Configured operating wallet** card: full recipient address
   (`config.recipientAddress`), network/chain, exact ETH balance (`recipientBalanceWei` only), and the
   observed block number, block hash and time.
3. Enter a reserve threshold and a target balance (ETH). They are saved only in this browser under
   `aegis.reserve.v1.<chainId>.<treasury>.<recipient>`. The card says they are not on-chain policy and
   not an automatic rule, and shows the server's read-only USD auto limit, hard per-payment limit and
   shared daily budget remaining separately.
4. Balance ≥ threshold → "暂无补给建议", no button. Balance < threshold → "低于你设置的下限" and the exact
   suggestion `target − balance`, with the caveat that this does not prove a task will fail or predict
   how many transactions the wallet can run.
5. **重新读取并准备预览** re-reads `/config`, `/wallets/current` and `/tasks`, checks the binding
   (chain, treasury, recipient), required snapshot fields and readiness, then recalculates. If anything in
   the suggestion changed (balance, binding, settings, amount) it shows the new amount and stops; the
   user must click again. Nothing is created on a changed amount.
6. Otherwise it creates a **new** draft (`POST /api/v1/intents {recipient, amountWei, purpose}`, never a
   PATCH of whatever draft was open), checks the echoed recipient/amount, calls the existing preview and
   opens the existing confirmation drawer with an extra "Gas 准备金补给" section. Payment only happens
   after **确认并提交**; Owner approval/cancel paths are unchanged.
7. After submit the drawer follows the returned task ID; the card links to the last top-up task and its
   authoritative status. If any submitted, non-final task to the operating wallet exists
   (READY/SUBMITTING/BROADCAST/UNKNOWN/AWAITING_APPROVAL), preparation is disabled with a link to that task.

States are distinct: `locked` (not logged in), `loading`, `unavailable` (offline, bad config, failed or
incomplete snapshot — shown as "—", never 0 and never "low"), `unset`, `invalid`, `healthy`, `low`.
The card exposes `data-state` for tests.

## Checks — actual results

Environment problem: the cloud sandbox has Node v22.22.0 and **no access to the npm registry or
nodejs.org** (proxy 403), so `npm ci --ignore-scripts` could not run and there is no `node_modules`.
A separate clone on MIA's computer was requested but no folder was connected during the session.

| Command | Result |
|---|---|
| `npm ci --ignore-scripts` | **NOT RUN** (registry unreachable) |
| `npm run typecheck --workspace frontend` | **NOT RUN** |
| `npm run build --workspace frontend` | **NOT RUN** |
| `npm run test:e2e -- e2e/gas-reserve.spec.ts e2e/wallet.spec.ts` | **NOT RUN** |
| `git diff --check` | **PASSED** (no output) |

Provisional checks that are *not* substitutes for the above:

- `tsc 6.0.3 --strict` on `frontend/src/main.ts` with a hand-written `viem` type shim: 0 errors.
- `reserve.ts` transpiled and run under Node 22 with a stub `parseEther`/`isAddress`: assertions for
  valid/invalid settings, low/healthy suggestion, binding, and rejected snapshots (missing/decimal
  balance, wrong chain, wrong treasury, non-chain source, bad hash/time, null) all passed.

No screenshots were produced. The topup spec writes `reserve-low.png`, `reserve-preview.png` and
`reserve-after-refresh.png` into `test-results/` when it runs.

## Test design (what the E2E checks once run)

- **Healthy** (`gas-reserve.spec.ts`): real balance text equals `eth_getBalance`; settings 0.01/0.02 →
  `healthy`, no prepare button; after a 6 s poll no `/intents` or `/tasks` writes, task count and balance
  unchanged; settings persisted under the namespaced key and restored on reload.
- **Invalid / missing / offline**: 7 invalid pairs (0, negative, text, 19 decimals, equal, inverted, empty
  target) → `invalid`, no button. Fixtures (marked in code, rendering only): snapshot without
  `recipientBalanceWei` → `unavailable`, "— ETH"; snapshot with `chainId: 1` → `unavailable`; 503 on the
  fresh re-read during preparation → `unavailable`, no draft; all API aborted → offline banner,
  `unavailable`. No POST writes.
- **Changed balance**: threshold B+0.0005, target B+0.001 → 0.001 ETH shown; polling paused; a real
  0.0002 ETH local transfer from an unused Hardhat account; first click shows the review note and
  0.0008 ETH with zero writes; second click creates one draft with `amountWei=800000000000000`, preview
  READY, drawer shows 0.0008; closed without confirming → no submit, no task, balance unchanged.
- **Low reserve, pays once, refresh** (`wallet.topup.spec.ts`): B read from RPC, threshold B+0.0005,
  target B+0.001 → exactly 0.001 ETH; preview AUTO/$3; before confirm no submit and balance unchanged;
  submit → 202 → poll task to `EXECUTED`; recipient delta exactly 10^15 wei; evidence
  `chainVerified/hashVerified`, `NativeTransferExecuted` hash whose RPC receipt has status 1 and a wallet
  log with the same request hash; reload → same task visible, card `healthy`, no new writes, task count
  +1 only, delta still 10^15.

**Why a separate topup file:** `wallet.spec.ts` uses the entire $15 shared daily budget of a fresh chain
($3 + $6 executed, then a $6 request it cancels). Any payment before it blocks that cancel case. Playwright
runs files alphabetically with `workers: 1`, so `wallet.topup.spec.ts` runs after `wallet.spec.ts`, when
$6 remains and the $3 top-up fits. To cover the payment, run all three files:

```bash
npm run test:e2e -- e2e/gas-reserve.spec.ts e2e/wallet.spec.ts e2e/wallet.topup.spec.ts
```

## Reproduce / shortest manual demo

```bash
npm ci --ignore-scripts
npm run chain            # terminal 1
npm run deploy:local     # terminal 2
npm run dev              # terminal 3, open http://localhost:5173
```

1. 本地测试钱包 → 确认使用公开开发账户.
2. Overview → reserve card shows Hardhat account 2 balance B (≈10000 ETH).
3. Set threshold 0.01, target 0.02 → "暂无补给建议".
4. Set threshold `B+0.0005`, target `B+0.001` (copy B from the card) → suggestion 0.001 ETH.
5. 重新读取并准备预览 → drawer shows the reserve section, $3, AUTO. 确认并提交 → task reaches 链上已确认.
6. Reload → same task, card healthy, no second payment.

## Limitations

- Single configured recipient only; no multi-agent registry. An application ID or label grants nothing.
- Balance read and payment are not atomic. The recheck reduces stale suggestions but another transaction
  can still change the wallet before execution, so the final balance may not equal the target. The
  confirmed amount is never rewritten.
- Threshold/target are browser-local recommendations, not policy; other browsers do not see them.
- The ETH/USD Feed prices the principal only; it is not a gas-price oracle. The top-up transaction's own
  fee is paid by the executor and is outside the principal and the USD budget. No future-workload
  prediction.
- The in-flight guard only knows tasks to this recipient that the backend lists; two independently
  created top-ups across browsers are not deduplicated by the backend.
- Preparing a top-up replaces the locally open draft in the composer (the old server draft stays an
  unsubmitted DRAFT; nothing is paid).
- No scheduler, automatic top-up, per-agent budget, x402/CCIP/CRE/ERC-8004/RAG/EZKL, new wallet SDK or
  LLM. Parser remains `rule_parser`.
- All required checks above are **not run** yet.

## Next action for purple sun (backend)

Add `recipientAddress` (and ideally the same `walletAddress`/`chainId` binding already present) to the
`GET /api/v1/wallets/current` snapshot, so the client can bind `recipientBalanceWei` to the address it was
read for instead of trusting the separately fetched `/config`. Exact contract proposal:
`Snapshot.recipientAddress: Address` — the address passed to `getBalance` for `recipientBalanceWei`, in
`backend/src/chain.ts` `snapshot()` and `packages/shared` types.
