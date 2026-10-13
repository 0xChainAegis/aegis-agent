"""LangGraph orchestration: guardrail -> intent -> policy -> approval -> execute.

Every user turn passes through the same deterministic security pipeline; the
LLM only performs intent extraction, never authorization.
"""

import re
from typing import Any, Literal, Optional, TypedDict

from pydantic import BaseModel, Field

from aegis_agent.config import SETTINGS
from aegis_agent.guardrails import injection_guard, policy
from aegis_agent.tools import analytics, attestation, subscriptions, wallet


class IntentSchema(BaseModel):
    intent: Literal["transfer", "pay", "analyze", "list_subscriptions", "cancel_subscription", "unknown"]
    amount: Optional[float] = None
    unit: str = "eth"
    recipient: Optional[str] = None
    time_range: Optional[str] = None
    subscription_id: Optional[int] = None


class AgentState(TypedDict, total=False):
    user_input: str
    blocked: bool
    block_reason: str
    intent: dict[str, Any]
    decision: dict[str, Any]
    approved: bool
    result: dict[str, Any]
    attestation: dict[str, Any]


# -------------------------------------------------------------------- nodes


def guard_node(state: AgentState) -> AgentState:
    verdict = injection_guard.scan(state["user_input"])
    if verdict.action == injection_guard.Action.BLOCK:
        return {
            "blocked": True,
            "block_reason": f"request blocked by injection guard ({', '.join(verdict.hits)})",
        }
    return {}


def intent_node(state: AgentState) -> AgentState:
    parsed = _parse_intent(state["user_input"])
    return {"intent": parsed}


def policy_node(state: AgentState) -> AgentState:
    intent = state["intent"]
    decision = policy.classify(
        intent=intent["intent"],
        amount=intent.get("amount"),
        unit=intent.get("unit", "eth"),
        recipient=intent.get("recipient"),
    )
    return {"decision": {"risk": decision.risk.value, "requires_approval": decision.requires_approval, "reason": decision.reason}}


def approval_node(state: AgentState) -> AgentState:
    """High-risk actions pause here until a human resumes with a bool."""
    from langgraph.types import interrupt

    intent = state["intent"]
    approved = interrupt(
        {
            "question": "High-risk action requires approval",
            "intent": intent["intent"],
            "recipient": intent.get("recipient"),
            "amount": intent.get("amount"),
            "reason": state["decision"]["reason"],
        }
    )
    return {"approved": bool(approved)}


def execute_node(state: AgentState) -> AgentState:
    if state["decision"]["risk"] == "high" and not state.get("approved"):
        return {"result": {"status": "denied", "reason": "human approval not granted"}}

    intent = state["intent"]
    name = intent["intent"]

    if name in ("transfer", "pay"):
        result = wallet.transfer(
            recipient=intent["recipient"] or "",
            amount_eth=float(intent.get("amount") or 0),
        )
    elif name == "analyze":
        result = {
            "by_category": analytics.spending_by_category(),
            "top_counterparties": analytics.top_counterparties(),
            "trend": analytics.monthly_trend(),
        }
    elif name == "list_subscriptions":
        result = {
            "subscriptions": subscriptions.list_subscriptions(),
            "burn": subscriptions.monthly_burn(),
        }
    elif name == "cancel_subscription":
        result = subscriptions.cancel(int(intent.get("subscription_id") or 0))
    else:
        result = {"status": "refused", "reason": "no matching capability"}

    return {"result": result}


def attest_node(state: AgentState) -> AgentState:
    """Commit the full action record (request, intent, decision, model,
    approval, result) to a canonical hash; write it to the on-chain registry
    before value moves. The same record is what a verifier re-hashes."""
    approved = state.get("approved")
    decision = state["decision"]
    record = attestation.build_record(
        request=state["user_input"],
        intent=state["intent"],
        decision=decision,
        model=SETTINGS.openai_model if SETTINGS.openai_api_key else "local-rule-parser",
        approved=approved,
        result=state["result"],
    )
    record_hash = attestation.hash_record(record)
    chain_receipt = attestation.onchain_attest(
        record_hash,
        risk_flag=decision["risk"] == "high",
        approved=bool(approved),
    )
    return {"attestation": {"record": record, "hash": record_hash, "chain": chain_receipt}}


# ---------------------------------------------------------------- intent parsing


def _parse_intent(text: str) -> dict[str, Any]:
    """Structured extraction via the LLM; falls back to a rule-based parser when
    no API key is configured so the agent stays demoable offline."""
    if SETTINGS.openai_api_key and not SETTINGS.mock_mode:
        try:
            from langchain_openai import ChatOpenAI

            model = ChatOpenAI(model=SETTINGS.openai_model, api_key=SETTINGS.openai_api_key)
            structured = model.with_structured_output(IntentSchema)
            parsed = structured.invoke(text)
            return parsed.model_dump()
        except Exception as exc:  # network/key issues fall through to the parser
            print(f"[planner] LLM extraction failed, using local parser: {exc}")

    return _rule_based_parser(text)


def _rule_based_parser(text: str) -> dict[str, Any]:
    lower = text.lower()

    if any(word in lower for word in ("subscription", "subscriptions", "recurring", "订阅")):
        match = re.search(r"cancel\s+(\d+)", lower)
        if match:
            return {"intent": "cancel_subscription", "subscription_id": int(match.group(1))}
        return {"intent": "list_subscriptions"}

    if any(word in lower for word in ("analyze", "spending", "bill", "history", "分析", "账单")):
        return {"intent": "analyze", "time_range": "month"}

    if any(word in lower for word in ("transfer", "send", "pay", "转", "支付")):
        amount = _extract_amount(lower)
        recipient = _extract_recipient(text)
        return {
            "intent": "transfer",
            "amount": amount,
            "unit": "eth",
            "recipient": recipient,
        }

    return {"intent": "unknown"}


def _extract_amount(lower: str) -> Optional[float]:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(eth|ether|gwei|usd|美元|刀)?", lower)
    if not match:
        return None
    value = float(match.group(1))
    if match.group(2) == "gwei":
        return round(value / 1e9, 9)
    return value


def _extract_recipient(text: str) -> Optional[str]:
    addr = re.search(r"0x[a-fA-F0-9]{40}", text)
    if addr:
        return addr.group(0)
    to = re.search(r"(?:to|给)\s+([A-Za-z0-9_\-]+)", text, re.IGNORECASE)
    return to.group(1) if to else None


# ---------------------------------------------------------------- graph wiring


def build_graph():
    from langgraph.checkpoint.memory import MemorySaver
    from langgraph.graph import END, START, StateGraph

    graph = StateGraph(AgentState)

    graph.add_node("guard", guard_node)
    graph.add_node("intent", intent_node)
    graph.add_node("policy", policy_node)
    graph.add_node("approval", approval_node)
    graph.add_node("execute", execute_node)
    graph.add_node("attest", attest_node)

    graph.add_edge(START, "guard")
    graph.add_conditional_edges(
        "guard",
        lambda s: "block" if s.get("blocked") else "pass",
        {"block": END, "pass": "intent"},
    )
    graph.add_edge("intent", "policy")
    graph.add_conditional_edges(
        "policy",
        lambda s: "approval" if s["decision"]["requires_approval"] else "execute",
        {"approval": "approval", "execute": "execute"},
    )
    graph.add_edge("approval", "execute")
    graph.add_edge("execute", "attest")
    graph.add_edge("attest", END)

    return graph.compile(checkpointer=MemorySaver())
