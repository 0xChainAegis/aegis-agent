"""Transfer execution tool: on-chain via AegisWallet, simulated in mock mode."""

from typing import Any

from aegis_agent.config import SETTINGS
from aegis_agent.tools.attestation import canonical_action_hash
from aegis_agent.tools.chain import WALLET_ABI, contract, get_web3

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def transfer(recipient: str, amount_eth: float, token: str = ZERO_ADDRESS) -> dict[str, Any]:
    """Execute a transfer. In mock mode returns a simulated receipt.
    On live mode calls AegisWallet.requestTransfer; an above-limit transfer is
    queued on-chain and must be approved by the owner out of band."""
    action = {
        "intent": "transfer",
        "recipient": recipient,
        "amount_eth": amount_eth,
        "token": token,
    }
    action_hash = canonical_action_hash(action)

    if SETTINGS.mock_mode:
        return {
            "status": "simulated",
            "recipient": recipient,
            "amount_eth": amount_eth,
            "actionHash": action_hash,
        }

    w3 = get_web3()
    wallet = contract(SETTINGS.wallet_address, WALLET_ABI)
    amount_wei = w3.to_wei(amount_eth, "ether")
    tx = wallet.functions.requestTransfer(
        w3.to_checksum_address(token),
        w3.to_checksum_address(recipient),
        amount_wei,
        action_hash,
        "",
    ).build_transaction(
        {
            "from": w3.to_checksum_address(SETTINGS.agent_address),
            "nonce": w3.eth.get_transaction_count(SETTINGS.agent_address),
        }
    )

    from eth_account import Account

    signed = Account.from_key(SETTINGS.agent_private_key).sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
    tx_hash = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    return {"status": "submitted", "txHash": receipt["transactionHash"].hex()}


def approve_pending(attestation_id: int) -> dict[str, Any]:
    """Owner-side helper to approve a queued high-risk operation."""
    if SETTINGS.mock_mode:
        return {"status": "simulated-approval", "attestationId": attestation_id}

    w3 = get_web3()
    wallet = contract(SETTINGS.wallet_address, WALLET_ABI)
    tx = wallet.functions.approveAndExecute(attestation_id).build_transaction(
        {
            "from": w3.eth.default_account.address if w3.eth.default_account else SETTINGS.agent_address,
            "nonce": w3.eth.get_transaction_count(SETTINGS.agent_address),
        }
    )
    from eth_account import Account

    signed = Account.from_key(SETTINGS.agent_private_key).sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
    tx_hash = w3.eth.send_raw_transaction(raw)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    return {"status": "approved", "txHash": receipt["transactionHash"].hex()}
