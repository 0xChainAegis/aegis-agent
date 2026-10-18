# Security Boundaries

The current validation covers local-chain behavior with a Mock Feed. This project
has not undergone an independent security audit; Sepolia and mainnet execution
are not verified. Local tests do not establish safety for real funds.

## Authority and authorization

- Only the configured Owner can authenticate using a single-use, expiring wallet
  challenge bound to address, domain and chain. Login does not approve a payment.
- The backend holds the executor identity, never the Owner key. Queued approval
  and cancellation require an actual Owner-signed contract transaction.
- The contract checks role/tier, recipient allowlist, nonce, deadline, policy
  version, USD maximum, hard per-payment cap and shared UTC-day budget.
  Approval cannot bypass these checks; pending requests reserve no budget.
- ETH/USD data must be positive, complete and fresh with expected decimals.
  The adapter's Feed configuration is locked. USD6 valuation rounds upward.
- The Owner and ACL administrator remain trusted policy administrators. They can
  change future policy; attestations are not an immutable defense against them.
- Native ETH payment and approval entry points use reentrancy protection.
  Legacy ERC20 and subscription payment exits are disabled.

## Integrity and recovery

Business writes use scoped idempotency keys; editing a draft changes its revision.
The server validates the stored quote and revision rather than trusting client
execution fields. The UI's confirmation is not an extra on-chain Owner signature
for every automatic payment.

Before broadcast, SQLite stores signed bytes, transaction hash, sender nonce,
request nonce and request hash. An uncertain broadcast is reconciled against the
original hash; recovery may rebroadcast identical bytes, never automatically
create a replacement payment. One process owns each executor/database.

A matching wallet execution event is required for `EXECUTED`. Approval hints are
independently checked against sender, target, calldata, receipt and event binding.
One mined confirmation is not irreversible finality. Multi-process signing and
deep-reorganization recovery are not implemented; a local chain reset requires
a fresh matching database rather than reusing old transaction evidence.

## Operational limits

The reserve threshold and target are browser-local suggestions. Rechecking is
not an atomic guarantee of target balance or deduplication across browsers.
The rule parser is not an LLM or a prompt-injection defense. Current records do
not prove model reasoning, strategy quality or successful future Agent tasks.

RPC or Feed failure remains visible and never silently enables simulated success.
The local test wallet uses public development accounts only on loopback chain
31337. Never fund those accounts on public networks. Keep executor keys, session
tokens, raw transactions and SQLite files private. Public deployment commands
remain disabled pending separate configuration and validation.
