"""Research layer: sourced notes about held, watched and candidate instruments and sector / macro
themes, written by the agent through MCP (``core/mcp/tools/research.py``), shown in the app
(``research_api.py``). Facts and sentiment with sources only: no recommendation, no price prediction.

- ``keys``: identity of research signals (stdlib only; the daily check and views import it).
- ``scoring``: pure sentiment / direction / thesis health.
- ``validation``: pure input validation of notes and runs.
- ``signals``: research signals through the rule-signal lifecycle and notification policy.
- ``service``: runs, notes, dismiss / restore, candidate accept / dismiss, housekeeping.
- ``views``: JSON dicts for the API and MCP, the summary and the review-digest block.

Keep this module light (no service imports): the daily check imports ``research.keys``.
"""

from __future__ import annotations

from .keys import RESEARCH_PREFIX, is_research_key, research_dedup_key, research_rule_id

__all__ = ["RESEARCH_PREFIX", "is_research_key", "research_dedup_key", "research_rule_id"]
