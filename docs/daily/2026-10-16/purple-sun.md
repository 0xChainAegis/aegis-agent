# Purple Sun backend recovery boundaries — 2026-10-16

## Baseline

- Base: `origin/codex/integration-wallet-ui`
- Base SHA: `a3bd9fbbea94745d1f601852ab21570ffd2ff853`
- Branch: `purple/1016-recovery-boundaries`
- Runtime: Node.js `v24.21.0`

## Problem and reproduction

The baseline already persisted a signed transaction before broadcast and recovered an accepted-then-timeout broadcast. It lacked reproducible regressions for these adjacent boundaries:

1. A service interruption after the real `prepare` result is persisted but before `broadcast` is entered.
2. An `AWAITING_APPROVAL` task surviving restart when the browser did not report the Owner transaction hash.
3. `ViemGateway.outcome` transaction/event binding independently of `FakeChain.outcome`.
4. Selected HTTP validation and response secrecy boundaries.

No production defect was exposed by the new regressions, so production source was not changed.

## Changes

- `backend/test/api.test.ts`
  - Injects a failure at the SQLite persistence boundary after the actual `prepare` path writes raw/hash/sender nonce/request nonce/request hash.
  - Reconstructs the service over the same temporary SQLite file and verifies the identical signed transaction is broadcast once, while the next queued task receives no nonce.
  - Recovers discovered Owner approve/cancel events after restart; an unmined Owner action remains queued, and a reported reverted Owner transaction cannot mark payment complete.
  - Exercises missing/invalid idempotency keys, invalid JSON, strict unknown-field rejection, unauthorized writes, revision/idempotency behavior already covered by the baseline, and response redaction for raw transactions, execution keys, session tokens, and credentialed RPC URLs.
- `backend/test/chain.test.ts`
  - Calls the real `ViemGateway.outcome` against a controlled viem client response fixture.
  - Covers the valid executed event, sender/target/calldata/value mismatches, wrong request hash, foreign-contract logs, missing business events, unmined receipts, and reverted receipts.

## Validation

- `node --version` — pass: `v24.21.0`
- `npm run typecheck --workspace backend` — pass
- `npm run test:backend` — pass: 26 tests, 0 failed
- `git diff --check` — pass

No shared type, ABI, HTTP response shape, production service behavior, frontend, contract, root package, script, or CI file changed.

## Evidence boundary and remaining limitations

- Recovery tests use temporary SQLite databases plus an explicit `FakeChain`; they verify the single-process persistence/state-machine boundary, not an operating-system crash, multi-instance signing, or a real node.
- Gateway tests execute the real decoding/binding method with viem-encoded events, but the RPC client responses are controlled fixtures. They do not prove live RPC event filtering or chain reorganization behavior.
- Local-chain browser E2E and public testnet transactions were not run. No Sepolia/mainnet transaction was broadcast.
- Existing behavior still treats one mined receipt as sufficient finality and does not provide multi-process nonce coordination.

## Handoff

- MIA: no API or shared-type change is required; UI behavior and response shapes remain compatible.
- 某齐: please review the wallet event-field assumptions in `backend/test/chain.test.ts`; the integration owner can run the existing local-chain E2E in an idle environment to validate the real RPC path.

## Suggested PR

Title: `test(backend): cover persisted payment recovery boundaries`

Body:

> Adds regressions for pre-broadcast SQLite recovery, Owner outcome discovery across restart, real ViemGateway receipt/event binding, and selected HTTP request/redaction boundaries. All changes are test-only plus this report. Backend typecheck and 26 backend tests pass. Fixtures do not claim live-RPC or public-chain coverage; local-chain E2E remains an integration-owner follow-up.
