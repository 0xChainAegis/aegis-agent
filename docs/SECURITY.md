# Security Boundaries

The PolicyEngine v2 validation covers local-chain behavior with a Mock Feed. This
project has not undergone an independent security audit; the existing v1 Sepolia
deployment does not validate v2, and v2 Sepolia/mainnet execution is not verified.
Local tests do not establish safety for real funds.

## Authority and authorization

- Only the configured Owner can authenticate using a single-use, expiring wallet
  challenge bound to address, domain and chain. Login does not approve a payment.
- The backend holds the executor identity, never the Owner key. Queued approval
  and cancellation require an actual Owner-signed contract transaction.
- The Wallet owns payment nonces and pending approvals. The shared PolicyEngine
  checks action kind, role/tier, recipient allowlist, deadline, policy version,
  USD maximum, hard per-payment cap and shared UTC-day budget. Approval cannot
  bypass these checks; pending requests reserve no budget.
- Only explicitly registered contract consumers can atomically consume policy
  budget. The Wallet is the initial consumer; registering another executor is a
  trusted Owner operation. Request hashes are consumed globally across consumers,
  and future action domains must remain collision-resistant and action-specific.
- ETH/USD data must be positive, complete and fresh with expected decimals.
  The adapter's Feed configuration is locked. USD6 valuation rounds upward.
- The PolicyEngine Owner and ACL administrator remain trusted policy
  administrators. They can change future policy and authorized consumers;
  attestations are not an immutable defense against them.
- Native ETH payment and approval entry points use reentrancy protection.
  Legacy ERC20 and subscription payment exits are disabled.
- The optional LLM is a draft-only parser. It cannot approve, sign, choose a
  policy, create an executor nonce, submit a task or move funds; strict input
  and output schemas reject extra authorization fields.

## Integrity and recovery

Business writes use scoped idempotency keys; editing a draft changes its revision.
The server validates the stored quote and revision rather than trusting client
execution fields. The UI's confirmation is not an extra on-chain Owner signature
for every automatic payment.

Before broadcast, SQLite stores signed bytes, transaction hash, sender nonce,
request nonce and request hash. An uncertain broadcast is reconciled against the
original hash; recovery may rebroadcast identical bytes, never automatically
create a replacement payment. One process owns each executor/database.

A matching Wallet execution event and PolicyEngine budget event in the same
receipt are required for `EXECUTED`. Their request hash, actor, action type,
decision and USD6 cost must agree. Approval hints are independently checked
against sender, target, calldata, receipt and event binding.
One mined confirmation is not irreversible finality. Multi-process signing and
deep-reorganization recovery are not implemented; a local chain reset requires
a fresh matching database rather than reusing old transaction evidence.

## Operational limits

The reserve threshold and target are browser-local suggestions. Rechecking is
not an atomic guarantee of target balance or deduplication across browsers.
The default rule parser is deterministic. The optional LLM path is guarded by
prompt-injection screening, a fixed skill, strict JSON validation and an
explicit rule-parser fallback; it still does not prove model reasoning,
strategy quality or future Agent behavior. `stub` mode is not live-model
evidence, and live provider calls require an externally configured key that is
never committed or exposed by the API. Current records do not prove that model
reasoning was honest; only the contract event and Chainlink-backed policy can
establish payment outcomes.

A screening hit is handled as whole-request rejection, never as sanitisation. A
flagged message, purpose, or model-authored purpose/question yields
`NEEDS_INPUT / PROMPT_BLOCKED` with the recipient and amount cleared and one
fixed question, and the model is not called. The original text stays only in the
blocked draft so that later turns on that same draft remain blocked; it never
becomes a previewable draft. This holds for the rule parser, the LLM path,
explicit-field edits, multi-turn inheritance and draft PATCHes. A payment that
arrives together with an unsafe instruction is rejected as a whole; stripping
only the unsafe clause and keeping the rest of the transfer is not an accepted
behaviour. The scanner is a bounded heuristic, so confirmation, field validation
and on-chain authorisation remain separate checks rather than being implied by a
successful scan.

RPC or Feed failure remains visible and never silently enables simulated success.
The local test wallet uses public development accounts only on loopback chain
31337. Never fund those accounts on public networks. Keep executor keys, session
tokens, raw transactions and SQLite files private. The public deployment command
is fail-closed and requires explicit reviewed Sepolia configuration; running it
broadcasts transactions and does not constitute an audit.
