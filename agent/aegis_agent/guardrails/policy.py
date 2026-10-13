"""Risk classification and permission policy.

Every parsed action is mapped onto a risk level before execution. The policy
engine — not the model — decides whether an action runs automatically, waits
for human approval, or is denied.
"""

from dataclasses import dataclass
from enum import Enum

from aegis_agent.config import SETTINGS


class RiskLevel(str, Enum):
    READ = "read"            # analytics, balances, listing
    LOW = "low"              # within auto limit
    HIGH = "high"            # above limit or sensitive action
    FORBIDDEN = "forbidden"  # never allowed


@dataclass
class Decision:
    risk: RiskLevel
    requires_approval: bool
    reason: str


# Categories that are always treated as sensitive regardless of size.
SENSITIVE_KEYWORDS = ("full balance", "all funds", "entire balance", "max", "self-destruct")


def _to_eth(amount: float | None, unit: str) -> float:
    if amount is None:
        return 0.0
    if unit == "gwei":
        return amount / 1e9
    if unit == "wei":
        return amount / 1e18
    return amount  # already ETH


def classify(
    intent: str,
    amount: float | None = None,
    unit: str = "eth",
    recipient: str | None = None,
) -> Decision:
    """Decide how a parsed action should be handled."""
    intent_l = intent.lower()

    # Read-only actions never move value.
    if intent_l in {"analyze", "balance", "list_subscriptions", "list", "inspect", "history"}:
        return Decision(RiskLevel.READ, False, "read-only action")

    if intent_l in {"deny", "freeze", "frozen"}:
        return Decision(RiskLevel.FORBIDDEN, True, "explicitly forbidden action")

    if intent_l in {"transfer", "pay", "subscribe", "cancel_subscription", "approve"}:
        value_eth = _to_eth(amount, unit)
        haystack = f"{intent_l} {value_eth} {recipient or ''}"

        if any(keyword in haystack for keyword in SENSITIVE_KEYWORDS):
            return Decision(RiskLevel.HIGH, True, "sensitive sweep-style operation")

        if intent_l == "transfer" and value_eth > SETTINGS.max_auto_transfer_eth:
            return Decision(
                RiskLevel.HIGH,
                True,
                f"amount {value_eth} ETH exceeds auto ceiling {SETTINGS.max_auto_transfer_eth} ETH",
            )

        return Decision(RiskLevel.LOW, False, "within auto-execution policy")

    # Unknown intents fail closed.
    return Decision(RiskLevel.HIGH, True, "unknown intent, fails closed")
