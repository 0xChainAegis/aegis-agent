"""Verifiable action records and on-chain attestation.

Pattern learned from Arbitra: the agent commits to the FULL record of an action
(raw request, parsed intent, policy decision, model, approval, execution result)
through a deterministic canonical keccak hash. The timestamp is excluded so
identical inputs always yield identical hashes. A third party can recompute the
hash from the stored record and confirm it matches the on-chain attestation.

This commits to the record and its hash; it does not independently prove the
model was honest — that is the honest boundary of off-chain AI.
"""

import json
from typing import Any

from aegis_agent.config import SETTINGS
from aegis_agent.tools.chain import ATTESTATION_ABI, contract, get_web3

RECORD_VERSION = "aegis-record-v1"


def canonicalize(record: Any) -> str:
    """Strict canonical JSON: keys sorted, whitespace removed, None omitted."""
    if isinstance(record, dict):
        entries = []
        for key in sorted(record):
            value = record[key]
            if value is None:
                continue
            entries.append(json.dumps(key, separators=(",", ":")) + ":" + canonicalize(value))
        return "{" + ",".join(entries) + "}"
    if isinstance(record, (list, tuple)):
        return "[" + ",".join(canonicalize(item) for item in record) + "]"
    return json.dumps(record, separators=(",", ":"))


def hash_record(record: dict[str, Any]) -> str:
    text = canonicalize(record)
    if SETTINGS.mock_mode:
        import hashlib

        return "0x" + hashlib.sha3_256(text.encode()).hexdigest()
    return get_web3().keccak(text=text).hex()


def verify_record(record: dict[str, Any], expected_hash: str) -> bool:
    """Recompute the hash and compare — third-party verification."""
    return hash_record(record) == expected_hash


def build_record(
    *,
    request: str,
    intent: dict[str, Any],
    decision: dict[str, Any],
    model: str,
    approved: bool | None,
    result: dict[str, Any],
    data_uri: str = "",
) -> dict[str, Any]:
    """Assemble the complete verifiable record. Timestamp is intentionally
    excluded (the chain records it separately)."""
    return {
        "recordVersion": RECORD_VERSION,
        "request": request,
        "intent": intent,
        "decision": decision,
        "model": model,
        "approved": approved,
        "result": result,
        "dataUri": data_uri,
    }


def onchain_attest(record_hash: str, risk_flag: bool, approved: bool, data_uri: str = "") -> dict:
    """Write the hash to the on-chain registry (simulated in mock mode)."""
    if SETTINGS.mock_mode:
        return {
            "attestationId": _next_mock_id(),
            "actionHash": record_hash,
            "riskFlag": risk_flag,
            "approved": approved,
            "dataUri": data_uri,
            "mode": "mock",
        }

    w3 = get_web3()
    att = contract(SETTINGS.attestation_address, ATTESTATION_ABI)
    tx = att.functions.record(
        w3.to_checksum_address(SETTINGS.agent_address),
        record_hash,
        data_uri,
        risk_flag,
        bool(approved),
    ).build_transaction(
        {
            "from": w3.to_checksum_address(SETTINGS.agent_address),
            "nonce": w3.eth.get_transaction_count(SETTINGS.agent_address),
        }
    )
    receipt = _sign_and_send(tx)
    return {
        "attestationId": -1,
        "txHash": receipt["transactionHash"].hex(),
        "actionHash": record_hash,
        "mode": "live",
    }


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


# Backward-compatible alias used by the wallet tool.
canonical_action_hash = hash_record
