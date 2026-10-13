"""Pytest bootstrap: make the `agent/` package directory importable."""

import sys
from pathlib import Path

AGENT_DIR = Path(__file__).parent / "agent"
sys.path.insert(0, str(AGENT_DIR))
