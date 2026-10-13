"""Mock banking API used by the FinTechathon (AI Banking Agent) variant.

It mirrors the shape of a retail bank's open API: balances, bills, payees and
a transfer endpoint. The same agent graph targets this module in banking mode
and the on-chain tools in blockchain mode.
"""

from dataclasses import dataclass, field

# Blacklist / freeze list used by the risk policy (sanctioned payees, closed
# accounts). Transfers to these are refused before any "posting" happens.
BLOCKED_PAYEES = {"0x-DEMO-SANCTIONED", "FROZEN-ACCOUNT-001"}


@dataclass
class Account:
    account_id: str
    holder: str
    currency: str
    balance: float
    payees: list[str] = field(default_factory=list)
    ledger: list[dict] = field(default_factory=list)


_ACCOUNTS = {
    "6222-0001": Account(
        account_id="6222-0001",
        holder="demo user",
        currency="CNY",
        balance=12800.00,
        payees=["LANDLORD-001", "UNIVERSITY-001"],
    )
}


def get_account(account_id: str = "6222-0001") -> dict:
    account = _ACCOUNTS[account_id]
    return {
        "account_id": account.account_id,
        "holder": account.holder,
        "currency": account.currency,
        "balance": account.balance,
        "payees": account.payees,
    }


def list_bills(account_id: str = "6222-0001") -> list[dict]:
    return [
        {"bill": "tuition installment", "amount": 5000.00, "due": "2026-11-10", "status": "unpaid"},
        {"bill": "rent", "amount": 1800.00, "due": "2026-11-05", "status": "unpaid"},
        {"bill": "electricity", "amount": 86.40, "due": "2026-10-28", "status": "unpaid"},
    ]


def transfer(account_id: str, payee: str, amount: float, memo: str = "") -> dict:
    """Simulated internal transfer with risk checks."""
    account = _ACCOUNTS[account_id]
    if payee in BLOCKED_PAYEES:
        return {"status": "refused", "reason": "payee blocked by risk policy"}
    if payee not in account.payees:
        return {"status": "refused", "reason": "payee not on trusted list"}
    if amount <= 0:
        return {"status": "refused", "reason": "invalid amount"}
    if amount > account.balance:
        return {"status": "refused", "reason": "insufficient balance"}

    account.balance -= amount
    account.ledger.append({"payee": payee, "amount": amount, "memo": memo})
    return {"status": "posted", "payee": payee, "amount": amount, "balance_after": account.balance}
