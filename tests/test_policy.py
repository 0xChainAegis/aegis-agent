from aegis_agent.guardrails.policy import RiskLevel, classify


def test_read_only_analysis():
    decision = classify("analyze")
    assert decision.risk == RiskLevel.READ
    assert decision.requires_approval is False


def test_small_transfer_is_low_risk():
    decision = classify("transfer", amount=0.005, recipient="0x123")
    assert decision.risk == RiskLevel.LOW
    assert decision.requires_approval is False


def test_large_transfer_is_high_risk():
    decision = classify("transfer", amount=1.0, recipient="0x123")
    assert decision.risk == RiskLevel.HIGH
    assert decision.requires_approval is True


def test_full_balance_sweep_is_high_risk():
    decision = classify("transfer", amount=0.001, recipient="0x123 full balance")
    assert decision.risk == RiskLevel.HIGH


def test_unknown_intent_fails_closed():
    decision = classify("definitely_not_a_real_intent")
    assert decision.risk == RiskLevel.HIGH
    assert decision.requires_approval is True
