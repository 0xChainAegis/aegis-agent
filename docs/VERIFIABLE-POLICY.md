# Verifiable Policy Inference (Design Note)

Status: proposal for review · Date: 2026-10-14
Related: roadmap item "Add zkML inference proof (EZKL) for verifiable policy decisions";
team draft "Aegis Agent 分层评价体系" (layered evaluation framework).

> TL;DR — today our evidence proves that *records were not altered*. This note adds two small,
> checkable things: (1) the numeric step of the authorization decision can be *proved* (EZKL),
> not just committed; (2) the claims produced by the layered evaluation framework can cite
> public, recomputable records instead of self-reports. Scope stays honest: the language layer
> is **not** proven, and this note does not claim "safety" — it supplies evidence plumbing.

## 1. Problem (from first principles)

AegisAgent claims that "every value-moving action is authorized, attested and bounded"
(ARCHITECTURE.md §4). Today:

- the guardrail filters untrusted text before the LLM;
- the LLM extracts intent and never authorizes;
- the decision path is **rule-based** (`guardrails/policy.py`: tier + per-transaction ceiling).
  There is no model in the path yet; the rules are deterministic, but they are enforced by our
  own code, running on our own machine;
- `AegisAttestation` commits the canonical hash of the full record before value moves.

Our own code states the remaining gap — `tools/attestation.py`:
"it does not independently prove the model was honest — that is the honest boundary of off-chain AI."

In one sentence: the decision is *committed*, not *verifiable*. A third party can check that the
record was not altered, but cannot check that the decision was computed from the declared inputs
by the declared rules/model.

## 2. Claim to add (the smallest honest increment)

> Given a committed feature vector, the risk score that feeds the authorization decision was
> produced by the declared model, unmodified — and every executed action can cite the receipt
> for that score.

Two ways to get there; we recommend A for the 10/24 demo:

- **Option A (recommended):** add a small tabular scoring model as an *additional input* to the
  existing rules (rules remain the final gate). EZKL is built for exactly this shape.
- **Option B (later):** circuit-ify the rule evaluation itself (comparisons/thresholds) and
  prove the rules directly. Same demo outcome, larger engineering effort first.

In scope: the numeric scoring step and its binding (model, inputs, output).
Explicitly out of scope: LLM honesty (the language layer stays outside the boundary), model
quality, training provenance, and the threshold semantics (already deterministic and public).

## 3. Design (proposal)

### 3.1 Pipeline

```
features --(small model, ONNX)--> score --(EZKL)--> proof --(on-chain)--> decision gate
```

### 3.2 Interfaces

New registry (or an extension of `AegisAttestation`):

- `registerModel(bytes32 modelHash, bytes32 vkHash, address verifier, string metadataUri)`
- `recordInference(bytes32 modelHash, bytes32 inputHash, bytes32 outputHash, bytes proof)` → `inferenceId`

`AegisWallet.requestTransfer(...)` gains an optional `uint64 inferenceId`.

- Ordering discipline (same as attestation): the receipt is recorded **before** the value-moving
  call; evidence first, value second.
- When the current tier requires verification: the wallet requires a valid, matching inference
  record before it executes or queues.
- Fail-closed: missing / invalid / mismatched proof ⇒ treat as HIGH risk (queue for owner
  approval); never silently execute.

### 3.3 Data hygiene

- The chain stores hashes and the proof only; raw payloads stay off-chain via `dataUri`
  (see roadmap: IPFS upload).
- Model artifacts (pk ≈ 156 MB) stay out of the repo; ship a build script with pinned hashes.

## 4. Acceptance criteria

- [ ] Valid proof → low-risk path executes unchanged; invalid/tampered proof → rejected or queued.
- [ ] Reference numbers (laptop CPU, 8-feature model): prove ≤ 5 s, verify ≤ 0.1 s, proof ≤ 32 KB.
- [ ] Tests: verifier unit test (tampered proof fails); wallet gating test (both paths); mock mode unaffected.
- [ ] **Evaluation hooks:** a report can be recomputed from public records (attestation ids +
      inference ids), not from team-reported numbers.
- [ ] README + docs updated; 60-second demo recorded.

## 5. Demo script (60 s)

1. Show a decision + its attestation (existing flow).
2. Show the same decision with a proof: verify ✔ → executed.
3. Change one input value → proof fails → wallet queues/rejects.
4. One sentence: "the policy step is proven; the language layer is outside the boundary and is
   handled by provenance (IPFS planned)."

## 6. Hooking into the layered evaluation framework

The team's layered framework scores an agent's **worthiness for real-capital authority**:
Layer 1 objective metrics (performance / risk / security), Layer 2 scenario response (market
states without event names), Layer 3 AI-judge decision quality, combined into a certification.
Verifiability does not replace evaluation; it upgrades *the evidence each layer cites*.

| Layer | Today (typical) | With inference receipts |
|---|---|---|
| L1 Metrics | claims computed by the harness itself ("Policy Violation: 0") | security/limit claims become recomputable from on-chain records (attestation ids) |
| L2 Scenario | outcome reported as prose | every executed move in a scenario cites an `inferenceId`; episodes become evidence-backed |
| L3 AI Judge | judge reads the agent's own explanation | judge reads the *proven* decision record; the narrative stays, but is explicitly marked "narration, unproven" |

**Reproducibility rule (same first principle as proofs):** an evaluation report should pin the
hashes it depends on — agent version, scenario set, model (`modelHash`) and verifier key
(`vkHash`). Anyone can then re-derive the numbers instead of trusting the report. Same
"two-fingerprint" discipline we apply to inference, applied to evaluation.

**Boundary:** this supplies *evidence plumbing*, not judgment. Strategy quality, safety, and
profitability remain the framework's questions.

## 7. What this does NOT fix (dialectical counterpoints)

- A bad policy, correctly proven, is still bad. Proof ≠ quality.
- The Layer-3 judge is still a trusted party. Attestation can pin *what the judge saw*; it
  cannot show the judgment itself is right.
- Scenario coverage is still curated by us — test-design risk is out of scope here.
- Fail-closed gating adds friction (missing proof ⇒ queue). Keep it tiered: only where the risk
  justifies the wait.
- LLM narration can still rationalize post hoc. That is why Layer 3 output should be labeled as
  narration, next to the proven record, not above it.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Proving cost grows with model size | only score the small tabular model; document the boundary |
| Artifact/circuit drift breaks verifiers | pin `modelHash` + `vkHash` in the registry from day one |
| Proof latency spikes on demo day | pre-generate artifacts; keep a recorded backup |
| Scope creep into "prove the LLM" | non-goals in §2; keep the boundary explicit |

## 9. Open questions for the team

1. Registry: a new contract, or extend `AegisAttestation`?
2. Gate location: `AegisWallet.requestTransfer` (enforceable on-chain) or the Python agent (cheaper)?
3. For the 10/24 demo: transfers only, or also prove the subscription path?
4. Should the evaluation harness *read* attestation / inference ids directly (Layer 1/2 evidence),
   or emit its own evaluation-attestation records?

> Reference: a local EZKL reference pipeline (EZKL 23.0.5, 8-feature logistic regression,
> on-chain Halo2 verifier, tamper test) has been built and measured (prove ≈ 1.4 s,
> verify ≈ 0.03 s, proof ≈ 21 KB). Happy to hand it over as the implementation basis once the
> interface is agreed.
