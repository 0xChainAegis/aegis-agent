# October 18 main consolidation

The user explicitly requested that `main` be the only branch retained locally
and on GitHub. The integration assistant prepared this release directly from
the actual GitHub commits; Claude's cloud session could not publish its separate
release and its reported `5c8f996` bundle was not present locally. This report
does not claim to have imported or tested that unavailable cloud commit.

## Preserved source

- Existing verified product: `28f8a7915666da7fd7906d3b325bae4e5477d6ee`.
- PR #4 original head: `1dc0ab0ba57669b5be2af0a992980e9ef4addd81`, merged as `f7139e3`.
- PR #1 original design head: `34dce68c66ea42c9fbc52236f9892e87c144dc55`, merged as `5259359`.
- All seven original remote branch heads are ancestors of the consolidated
  release. Their original commit identities and authors were preserved.
- The design note is retained at `docs/VERIFIABLE-POLICY.md` with an explicit
  archived-proposal notice. It does not add EZKL or change payment authorization.
- A complete pre-consolidation Git bundle and ref inventory were saved outside
  the repository. `git bundle verify` passed before branch cleanup.

## Actual verification

Environment: Windows, Node 24.19.0, npm 11.17.0, unchanged locked dependencies.

- `npm run check`: passed backend/frontend type checks and builds;
  **27 passing contract tests**, **26 passing backend test counts** including nested tests.
- `npm run test:e2e`: passed **2 wallet cases** (26.6 s) and
  **4 reserve cases** (33.9 s), each group using a fresh local chain and SQLite DB.
- `git diff --check`: passed.
- No production budget checks, assertions, ABI or dependency requirements were relaxed.
- Public Feed, Sepolia, live LLM and automatic top-up remain unverified or unimplemented.

## Repository workflow

`main` is the only retained branch. Historical dated/integration/release branch
instructions are superseded. Each person uses a separate working copy; MIA
serializes reviewed, tested normal pushes to `main`. A collaborator can deliver
local commits or a real bundle without creating another GitHub branch. No
force-push or author-history rewriting is part of consolidation.

Deleting a merged branch does not remove its commits. GitHub account attribution
still depends on the original author identity/email being associated with the
correct account; pushing and merging do not repair an unassociated email.

Claude cloud's repository allowlist is a separate platform authorization boundary.
The integration assistant used the existing local Git identity rather than
changing or bypassing that cloud restriction.
