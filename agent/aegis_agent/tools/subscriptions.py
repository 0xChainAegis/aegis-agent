"""Subscription management: list, cancel, and summarize recurring payments."""

from dataclasses import asdict, dataclass

# In mock mode the fixture stands in for on-chain/Subscription records.
_FIXTURE = [
    {"id": 1, "merchant": "Netflix", "amount": 15.49, "cycle": "monthly", "active": True},
    {"id": 2, "merchant": "Spotify", "amount": 9.99, "cycle": "monthly", "active": True},
    {"id": 3, "merchant": "iCloud+ 200GB", "amount": 2.99, "cycle": "monthly", "active": True},
    {"id": 4, "merchant": "Annual domain renewal", "amount": 12.00, "cycle": "yearly", "active": False},
]


@dataclass
class Subscription:
    id: int
    merchant: str
    amount: float
    cycle: str
    active: bool


def list_subscriptions() -> list[dict]:
    return [asdict(s) for s in (Subscription(**row) for row in _FIXTURE)]


def cancel(subscription_id: int) -> dict:
    for row in _FIXTURE:
        if row["id"] == subscription_id:
            if not row["active"]:
                return {"status": "already inactive", "id": subscription_id}
            row["active"] = False
            return {"status": "cancelled", "id": subscription_id, "merchant": row["merchant"]}
    return {"status": "not found", "id": subscription_id}


def monthly_burn() -> dict:
    """Total active monthly subscription cost (yearly items amortized)."""
    monthly_total = 0.0
    for row in _FIXTURE:
        if not row["active"]:
            continue
        if row["cycle"] == "monthly":
            monthly_total += row["amount"]
        elif row["cycle"] == "yearly":
            monthly_total += row["amount"] / 12
    return {"monthly_burn": round(monthly_total, 2), "yearly_projection": round(monthly_total * 12, 2)}
