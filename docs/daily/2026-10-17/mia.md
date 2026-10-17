# 2026-10-17 · MIA · Gas-reserve top-up slice (frontend)

Output report, not the task instruction file.

## Baseline

- Repository: https://github.com/0xChainAegis/aegis-agent
- Base branch: `codex/integration-wallet-ui`
- Actual base SHA (fetched 2026-10-17): `a3bd9fbbea94745d1f601852ab21570ffd2ff853` (same as the prompt)
- Task branch: `2026-10-17-mia03ther-aegis-agent`
- Working copy: a fresh, isolated clone in the agent's cloud sandbox. No existing working copy on MIA's
  computer was opened or changed, so there was no overlap with another agent.
- Local integration review combined this delivery with `413c157`, which contains the reviewed
  PR #2 and PR #3 test changes. The cloud report's claim that those teammate branches were already
  merged into `a3bd9fb` was inaccurate; their verified integration occurred afterward. Other branch
  and PR statuses were not established by this delivery.
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

Not touched by the original Claude commits: `backend/`, `contracts/`, `packages/shared/`, root package/lock files, `scripts/`,
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

## Checks — local integration results, October 17

The authoring cloud sandbox could not install dependencies, so the original delivery had no real
build or browser result. The integration assistant subsequently verified the bundle SHA-256
`5566b0c7f8eacdb0fe26a7ebf07a7a6df4ec5a59c29047ddc00501c5272d11cb`, imported its two commits,
and ran the checks below on Windows with Node 24.19.0 and npm 11.17.0. Existing locked dependencies
from the successful October 17 offline `npm ci --ignore-scripts` were reused; no dependencies changed.

| Command | Result |
|---|---|
| `npm run check` | **PASSED**: backend/frontend type checks and builds; 24 contract tests; 26 backend test counts including nested tests |
| Original three-file Playwright command | **PASSED**: all 6 tests (50.7 s), before correcting the ordering dependency |
| `npm run test:e2e` after test-entry correction | **PASSED**: wallet group 2/2 (23.5 s), reserve group 4/4 (30.8 s), independent fresh stacks |
| `git diff --check` | **PASSED** (no output) |

Authoring-only provisional checks, which are *not* substitutes for the real checks above:

- `tsc 6.0.3 --strict` on `frontend/src/main.ts` with a hand-written `viem` type shim: 0 errors.
- `reserve.ts` transpiled and run under Node 22 with a stub `parseEther`/`isAddress`: assertions for
  valid/invalid settings, low/healthy suggestion, binding, and rejected snapshots (missing/decimal
  balance, wrong chain, wrong treasury, non-chain source, bad hash/time, null) all passed.

The successful local top-up test produced `reserve-low.png`, `reserve-preview.png` and
`reserve-after-refresh.png` under its `test-results/` directory. These show actual local-chain
behavior with a Mock Feed; they are not Sepolia or live Chainlink evidence.

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

**Test isolation correction:** the baseline wallet flow spends $9, then needs $6 of remaining
daily allowance to queue the request it cancels. Cancellation does not spend that $6. A $3 top-up
before that flow can prevent the cancellation case from queuing. The integration owner therefore
changed the default entry to run two separate Playwright processes, each with a fresh local chain,
deployment and SQLite database; file-name ordering is no longer the isolation mechanism:

```bash
npm run test:e2e           # both independent groups, stops on failure
npm run test:e2e:wallet    # existing 2 wallet cases only
npm run test:e2e:reserve   # 3 reserve UI cases + 1 real top-up
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
- Local checks above passed. Real Sepolia, real Feed and a live LLM remain unverified.

## Next action for purple sun (backend)

Add `recipientAddress` (and ideally the same `walletAddress`/`chainId` binding already present) to the
`GET /api/v1/wallets/current` snapshot, so the client can bind `recipientBalanceWei` to the address it was
read for instead of trusting the separately fetched `/config`. Exact contract proposal:
`Snapshot.recipientAddress: Address` — the address passed to `getBalance` for `recipientBalanceWei`, in
`backend/src/chain.ts` `snapshot()` and `packages/shared` types.
