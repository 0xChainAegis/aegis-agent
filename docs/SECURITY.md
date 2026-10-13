# Security Design & Known Risk List

This document is the security design reference for AegisAgent and the basis
of the FinTechathon security self-assessment report.

## 1. Threat model

| Threat | Mitigation |
|---|---|
| Direct prompt injection ("ignore previous instructions") | Guardrail signatures block input before it reaches the LLM |
| Indirect injection via external data (bills, merchant names) | External text is treated as untrusted data; tool results are never executed as instructions; only structured fields are read |
| Prompt / secret extraction | Guardrail detects extraction requests; system prompt is never part of tool outputs |
| Excessive agent authority (stolen key or rogue model) | On-chain tiers, per-transaction ceiling, role separation; contracts cap what the agent can do |
| Unauthorized large transfers | Two gates: graph-level human approval + on-chain owner `approveAndExecute` |
| Payment to blocked / sanctioned payee | Bank adapter block list + on-chain chain allowlist |
| Replay / duplicated submission | Each action has a canonical hash and a unique attestation id; pending ops are deleted once resolved |
| Key leakage in config | `.env` gitignored; only disposable testnet keys; sample file committed |
| Fake confirmations / inventing data | Agent cannot generate hashes or balances; only the chain/API response is shown |
| Fee / parameter manipulation | CCIP destination chains allowlisted; fee quoted from router; `msg.value == fee` enforced |

## 2. Permission tiers

| Tier | Allowed actions |
|---|---|
| Frozen | none |
| ReadOnly | analyze, balances, listing |
| LowRisk | above actions plus transfers within the per-tx ceiling, auto-executed |
| HighRisk | every action queued for human approval |

## 3. Execution guarantees

- Ordering: `guard → intent → policy → approval → attestation → transfer`
- Attestation is a precondition of every transfer; transfers in
  `AegisWallet` are only reachable through the bounded agent path
- All high-risk actions are visible in two places: the graph's paused state
  and the contract's pending queue
- Audit: on-chain records are append-only and keyed by actor

## 4. Known risk list (honest residual risks)

1. **Regex-only injection guard** — novel, obfuscated or multilingual
   injections may evade signatures; residual risk is reduced by the
   fail-closed policy and tiered limits, but not eliminated
2. **LLM extraction errors** — intent or amount parsing can be wrong;
   high-risk defaults and confirmations are the safety net, and the
   offline parser is simpler rather than smarter
3. **Agent hot key** — a hot key on the agent host is a single point of
   compromise; contracts bound blast radius, but a robust deployment should
   move signing to an HSM / hardware signer or a multisig
4. **Custodial wallet** — the wallet contract holds funds; smart contract
   bugs in the payment path are a risk requiring a full audit before any
   non-testnet use
5. **Oracle dependency** — USD limits depend on Chainlink feeds; stale or
   misconfigured feeds distort risk decisions; feeds are per-token and
   must be wired and monitored
6. **Demo mock mode** — mock results are simulations, not evidence;
   evaluation must use live-mode receipts
7. **No rate limiting on the agent service** in the current scaffold;
   the hosted service needs authentication and per-user rate limits
8. **CCIP configuration drift** — router and selector addresses change per
   network; unverified configs can block or misroute transfers

## 5. Verification checklist before release

- [ ] Unit tests pass (`pytest`, `hardhat test`)
- [ ] Contracts verified on the block explorer
- [ ] Low-risk transfer auto-executes and is attested
- [ ] High-risk transfer cannot execute without both approvals
- [ ] Injection attempts are blocked and logged
- [ ] `.env` is not committed; keys used are testnet-only
- [ ] README documents every Chainlink integration used
