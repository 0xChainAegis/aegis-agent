# AegisAgent — Python agent

Security-first LangGraph agent.

## Install

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

## Run

```bash
# Mock mode (default): full pipeline offline, no keys or chain
python -m aegis_agent.main

# Live mode: set MOCK_MODE=false and configure RPC + contracts + signing key
```

## Pipeline

```
guard (injection detection)
  -> intent (LLM structured extraction, offline parser fallback)
  -> policy (read / low / high / forbidden)
  -> approval (human interrupt for high risk)
  -> execute (bank adapter or on-chain tools)
```

## Test

```bash
pytest
```

The guardrail and policy tests are dependency-free and run without a chain.
