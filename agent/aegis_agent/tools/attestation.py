"""Action canonicalization and on-chain attestation."""

import json
from typing import Any

from aegis_agent.config import SETTINGS
from aegis_agent.tools.chain import ATTESTATION_ABI, contract, get_web3


def canonical_action_hash(action: dict[str, Any]) -> str:
    """Deterministic keccak hash of an action, regardless of key order."""
    canonical = json.dumps(action, sort_keys=True, separators=(",", ":"))
    if SETTINGS.mock_mode:
        import hashlib

        return "0x" + hashlib.sha3_256(canonical.encode()).hexdigest()
    w3 = get_web3()
    return w3.keccak(text=canonical).hex()


def attest(action: dict[str, Any], risk_flag: bool, approved: bool, data_uri: str = "") -> dict:
    """Record an action. Returns a receipt-like dict (simulated in mock mode)."""
    action_hash = canonical_action_hash(action)

    if SETTINGS.mock_mode:
        return {
            "attestationId": _next_mock_id(),
            "actionHash": action_hash,
            "riskFlag": risk_flag,
            "approved": approved,
            "dataUri": data_uri,
            "mode": "mock",
        }

    w3 = get_web3()
    att = contract(SETTINGS.attestation_address, ATTESTATION_ABI)
    tx = att.functions.record(
        w3.to_checksum_address(SETTINGS.agent_address),
        action_hash,
        data_uri,
        risk_flag,
        approved,
    ).build_transaction(
        {
            "from": w3.to_checksum_address(SETTINGS.agent_address),
            "nonce": w3.eth.get_transaction_count(SETTINGS.agent_address),
        }
    )
    receipt = _sign_and_send(tx)
    return {"txHash": receipt["transactionHash"].hex(), "actionHash": action_hash, "mode": "live"}


def _sign_and_send(tx: dict) -> dict:
    w3 = get_web3()
    from eth_account import Account

    signed = Account.from_key(SETTINGS.agent_private_key).sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
    tx_hash = w3.eth.send_raw_transaction(raw)
    return w3.eth.wait_for_transaction_receipt(tx_hash)


_MOCK_COUNTER = {"id": 0}


def _next_mock_id() -> int:
    _MOCK_COUNTER["id"] += 1
    return _MOCK_COUNTER["id"]
