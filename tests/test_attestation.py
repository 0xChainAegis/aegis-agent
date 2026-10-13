import os

os.environ.setdefault("MOCK_MODE", "true")

from aegis_agent.tools import attestation  # noqa: E402


def test_canonical_hash_is_key_order_independent():
    a = {"b": 1, "a": 2}
    b = {"a": 2, "b": 1}
    assert attestation.hash_record(a) == attestation.hash_record(b)


def test_none_values_are_omitted():
    a = {"a": 1, "b": None}
    b = {"a": 1}
    assert attestation.hash_record(a) == attestation.hash_record(b)


def test_verify_record_roundtrip():
    record = attestation.build_record(
        request="send 0.1 ETH to 0xabc",
        intent={"intent": "transfer", "amount": 0.1},
        decision={"risk": "low", "requires_approval": False},
        model="local-rule-parser",
        approved=None,
        result={"status": "ok"},
    )
    record_hash = attestation.hash_record(record)
    assert attestation.verify_record(record, record_hash)

    record["result"] = {"status": "tampered"}
    assert not attestation.verify_record(record, record_hash)
