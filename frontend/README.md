# Frontend demo

A single-file, zero-build demo console for AegisAgent.

## Run

```bash
# simply open in a browser
open index.html
```

## What it shows

- The full request pipeline: injection guard → intent → risk policy → human
  approval → execution → attestation
- Read-only flows (spending analysis, subscriptions)
- Auto-executed low-risk transfers and queued high-risk transfers
- A blocked prompt-injection attempt
- Optional injected-wallet connection (MetaMask), not required for the demo

## Production wiring

The UI mirrors the agent's guardrail/policy logic client-side so it works
without a backend. In the deployed product, the console calls the Python
agent over HTTP and renders its streamed policy and execution results.
