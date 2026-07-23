"""Hybrid transaction categorization: deterministic rules + optional LLM fallback.

Pipeline (first match wins): internal-transfer guard → learned rule (manual/LLM,
cached by merchant_key) → seed keyword rules (Polish merchants) → recurring
signal → income/other default. The LLM only ever classifies a merchant once;
its answer is cached as a rule, so ongoing cost trends to zero.
"""

from . import taxonomy
from .engine import categorize
from .rules import load_rules, upsert_rule

__all__ = ["taxonomy", "categorize", "load_rules", "upsert_rule"]
