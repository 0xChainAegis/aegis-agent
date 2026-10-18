# Next Claude task: make the existing Gas reserve flow easier to understand

Work in English. Implement the task; do not stop after proposing a plan.

Use a LOCAL Claude Code session with this existing project folder attached:
`C:\Users\24525\Documents\Codex\2026-10-14\referenced-chatgpt-conversation-this-is-an\outputs\aegis-agent`

Repository: https://github.com/0xChainAegis/aegis-agent
The only branch is `main`. Do not create any branch, PR, fork, release branch or
daily branch. Do not restore old integration branches. Do not rewrite authorship.

If you are still in a cloud sandbox with no access to this folder, stop before
editing. State that the task must be opened locally. The previous cloud error
was a repository authorization restriction, not a Git command syntax problem.
Do not repeat SSH retries, request private keys or claim you fixed cloud access.

## Preflight

Inspect git status, actual main HEAD and the latest origin/main. Preserve all
unrelated work. One agent may write this working copy at a time. Read README.md,
docs/DECISIONS.md, docs/DEVELOPMENT.md, docs/HANDOFF.md and the October 18 release
report. Use Node 24+ and the committed lockfile. A local Node 24 executable is
available at `C:\Users\24525\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`;
use that runtime directory on PATH if the default Node is older.

The last local release passed type checks/builds, 27 contract tests, 26 backend
test counts and six browser cases. These are historical results, not your tests.

## Product goal

Make the current single-wallet top-up flow understandable to a first-time user:
see the real ETH reserve, set a threshold and target, review the exact suggested
top-up, explicitly confirm, and follow the actual payment result.

Keep the existing Vite/TypeScript DOM application, dark visual language and
confirmation drawer. This is a focused usability improvement, not a rewrite.

1. Give the operating-wallet reserve card clear visual priority on Overview.
   Distinguish it from the treasury balance. Keep real values; do not change the
   large prefunded local-test balance to a fabricated smaller number.
2. Use short user-facing Chinese labels. Keep the primary card focused on wallet,
   balance, threshold/target, suggestion and the next action. Move detailed
   technical explanation into accessible expandable details; retain network,
   observation, budget, Mock Feed and manual-confirmation information for review.
3. Keep states clear: not connected, loading, data unavailable, not configured,
   invalid settings, healthy reserve, low reserve, in-flight payment and outcome.
   Missing data must never become zero or a fabricated low-reserve warning.
4. Keep all payment behavior: BigInt amounts, browser-local scoped settings,
   fresh config/balance/task recheck, changed-amount second review, original
   recipient and amount binding, explicit confirmation, existing Owner flow,
   and matching task/event evidence. A preview is not a payment.
5. Make the layout usable at 1440 px desktop and 390 px mobile. Ensure the fixed
   composer does not cover the reserve inputs or primary action. Keep full
   address/copy and verification details accessible.

## Scope and validation

Allowed application files: frontend/src/main.ts and frontend/src/style.css.
Keep frontend/src/reserve.ts calculation/validation behavior unchanged unless a
specific reproducible defect requires a narrowly explained fix. Update the
existing e2e files only for deliberate layout/selector changes; retain all
financial, recheck, offline, receipt and no-duplicate-payment assertions.
Add your actual delivery report at docs/daily/2026-10-18/mia-ui.md.

Do not change backend, contracts, shared interfaces, root dependencies, CI or
test orchestration. Do not add React, a wallet SDK, a model, multiple wallets,
CRE, CCIP, x402, RAG, EZKL or automatic top-up. No fake online agent or success state.

Run npm run check and npm run test:e2e. The latter starts two independent local
stacks. Do not kill a preview owned by someone else; report occupied ports for
the integration owner to stop. Record actual results and desktop/mobile screenshots.
No type shims, fake parseEther or invented passing results. Local chain 31337
testing is allowed; do not send public-chain transactions or read secret files.

After checks pass, inspect the diff, commit the focused change on main and fetch
origin/main again. Preserve any newer teammate commits and revalidate affected
behavior. MIA authorizes a normal fast-forward push to main for this task after
successful checks. Never force-push or create another remote branch. If publishing
is unavailable, leave the real local changes/commit and exact blocker for handoff.

Return the actual base/final commit, changed files, real check results, screenshots,
push outcome and remaining limits. Do not describe rules-based parsing as a live LLM.
