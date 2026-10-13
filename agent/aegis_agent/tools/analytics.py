"""Bill / transaction analysis. Serves both the banking (FinTechathon) and
on-chain (ETH Shenzhen) variants: parse a transaction list into category
spend, top counterparties and trend."""

from collections import defaultdict

# Category-tagged fixture. In production this is fed by bank API rows or
# decoded on-chain transactions.
_TRANSACTIONS = [
    {"counterparty": "Netflix", "category": "entertainment", "amount": 15.49, "month": "2026-09"},
    {"counterparty": "Spotify", "category": "entertainment", "amount": 9.99, "month": "2026-09"},
    {"counterparty": "Starbucks", "category": "food", "amount": 38.50, "month": "2026-09"},
    {"counterparty": "Metro", "category": "groceries", "amount": 96.30, "month": "2026-09"},
    {"counterparty": "Starbucks", "category": "food", "amount": 24.00, "month": "2026-10"},
    {"counterparty": "Metro", "category": "groceries", "amount": 112.80, "month": "2026-10"},
    {"counterparty": "Gas station", "category": "transport", "amount": 60.00, "month": "2026-10"},
]


def spending_by_category(month: str | None = None) -> dict:
    totals: dict[str, float] = defaultdict(float)
    for row in _TRANSACTIONS:
        if month and row["month"] != month:
            continue
        totals[row["category"]] += row["amount"]
    return dict(sorted(totals.items(), key=lambda kv: kv[1], reverse=True))


def top_counterparties(limit: int = 3) -> list[dict]:
    totals: dict[str, float] = defaultdict(float)
    for row in _TRANSACTIONS:
        totals[row["counterparty"]] += row["amount"]
    ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    return [{"counterparty": name, "total": round(total, 2)} for name, total in ranked]


def monthly_trend() -> list[dict]:
    totals: dict[str, float] = defaultdict(float)
    for row in _TRANSACTIONS:
        totals[row["month"]] += row["amount"]
    return [{"month": month, "total": round(total, 2)} for month, total in sorted(totals.items())]
