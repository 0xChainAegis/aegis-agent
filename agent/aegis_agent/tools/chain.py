"""Lazy-loaded web3 client and minimal ABIs for the deployed Aegis contracts."""

from functools import lru_cache
from typing import Any

from aegis_agent.config import SETTINGS

# Minimal ABIs — only the functions the agent calls.
WALLET_ABI = [
    {
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "amount", "type": "uint256"},
            {"name": "actionHash", "type": "bytes32"},
            {"name": "dataUri", "type": "string"},
        ],
        "name": "requestTransfer",
        "outputs": [{"name": "attId", "type": "uint64"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"name": "attId", "type": "uint64"}],
        "name": "approveAndExecute",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"name": "attId", "type": "uint64"}],
        "name": "cancelPending",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]

ATTESTATION_ABI = [
    {
        "inputs": [
            {"name": "id", "type": "uint64"},
        ],
        "name": "records",
        "outputs": [
            {
                "components": [
                    {"name": "id", "type": "uint64"},
                    {"name": "actor", "type": "address"},
                    {"name": "actionHash", "type": "bytes32"},
                    {"name": "dataUri", "type": "string"},
                    {"name": "riskFlag", "type": "bool"},
                    {"name": "approved", "type": "bool"},
                    {"name": "timestamp", "type": "uint64"},
                ],
                "name": "",
                "type": "tuple",
            }
        ],
        "stateMutability": "view",
        "type": "function",
    },
]


@lru_cache(maxsize=1)
def get_web3() -> Any:
    """Return a connected Web3 instance. Imported lazily so mock mode and unit
    tests do not require web3 to be installed."""
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(SETTINGS.rpc_url))
    if not w3.is_connected():
        raise ConnectionError(f"cannot reach RPC {SETTINGS.rpc_url}")
    return w3


def contract(address: str, abi: list[dict]) -> Any:
    if not address:
        raise ValueError("contract address not configured")
    return get_web3().eth.contract(address=get_web3().to_checksum_address(address), abi=abi)
