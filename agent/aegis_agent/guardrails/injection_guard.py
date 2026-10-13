"""Prompt-injection and prompt-extraction detection.

A lightweight, dependency-free first line of defense. The LLM is never trusted
to protect itself: raw user text is scored against known attack patterns before
it reaches the planner, and high-scoring input is blocked outright.
"""

import re
from dataclasses import dataclass, field
from enum import Enum

# (regex, weight) — weights reflect how directly the pattern hijacks the model.
SIGNATURES: list[tuple[str, int]] = [
    (r"ignore\s+(all|any|the|previous|above|prior|earlier)", 3),
    (r"disregard\s+(all|any|the|previous|above|prior|earlier)", 3),
    (r"(forget|override|bypass)\s+(all|any|the|previous|above|prior|earlier|rules|instructions)", 3),
    (r"(reveal|print|show|repeat|output|leak|drop)\b.{0,40}(system|developer|hidden|original)?\s*prompt", 3),
    (r"(reveal|print|show|repeat|output)\b.{0,30}(instruction|rules|directive)", 3),
    (r"system\s+prompt", 3),
    (r"you\s+are\s+now\b", 3),
    (r"act\s+as\s+(a|an|my)\b", 2),
    (r"new\s+instructions?\s*[:=]", 3),
    (r"developer\s+mode|jail\s*break|dan\s+mode|do\s+anything\s+now|unrestricted\s+mode", 3),
    (r"(do|execute|run)\s+(this|the)\s+(command|code|script|sql|curl|wget)", 3),
    (r"<\s*\|?\s*[a-z_]+\s*\|?\s*>", 2),  # fake role/tool markers like <|system|>
    (r"\[\s*(system|developer|instruction|system_assistant)\s*\]", 2),
    (r"send\s+(all|my|the)\s+(funds|money|balance|tokens|eth)\s+to\s+", 2),
    (r"wrap\s+(your|the)\s+(response|reply)\s+in\s+", 1),
]

BLOCK_THRESHOLD = 3
REVIEW_THRESHOLD = 2


class Action(str, Enum):
    ALLOW = "allow"
    REVIEW = "review"
    BLOCK = "block"


@dataclass
class Verdict:
    action: Action
    score: int
    hits: list[str] = field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return self.action != Action.BLOCK


def scan(text: str) -> Verdict:
    """Score raw user text and return allow / review / block."""
    normalized = text.lower()
    score = 0
    hits: list[str] = []

    for pattern, weight in SIGNATURES:
        match = re.search(pattern, normalized)
        if match:
            score += weight
            hits.append(match.group(0).strip())

    # Repetitive exclamation / ALL CAPS spam is a weak coercion signal.
    if "!" in text and text.count("!") >= 5:
        score += 1
        hits.append("exclamation spam")

    if score >= BLOCK_THRESHOLD:
        action = Action.BLOCK
    elif score >= REVIEW_THRESHOLD:
        action = Action.REVIEW
    else:
        action = Action.ALLOW

    return Verdict(action=action, score=score, hits=hits)
