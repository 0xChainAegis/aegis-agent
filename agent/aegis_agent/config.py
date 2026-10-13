"""Runtime settings loaded from environment variables."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _as_bool(value: str, default: bool = True) -> bool:
    return os.getenv("MOCK_MODE", str(default).lower()).lower() == "true"


@dataclass(frozen=True)
class Settings:
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    mock_mode: bool = _as_bool("MOCK_MODE", True)
    rpc_url: str = os.getenv("RPC_URL", "http://127.0.0.1:8545")
    chain_id: int = int(os.getenv("CHAIN_ID", "31337"))
    agent_private_key: str = os.getenv("AGENT_PRIVATE_KEY", "")
    agent_address: str = os.getenv("AGENT_ADDRESS", "")
    acl_address: str = os.getenv("ACL_ADDRESS", "")
    attestation_address: str = os.getenv("ATTESTATION_ADDRESS", "")
    wallet_address: str = os.getenv("WALLET_ADDRESS", "")
    oracle_address: str = os.getenv("ORACLE_ADDRESS", "")
    ccip_address: str = os.getenv("CCIP_ADDRESS", "")
    max_auto_transfer_eth: float = float(os.getenv("MAX_AUTO_TRANSFER_ETH", "0.01"))


SETTINGS = Settings()
