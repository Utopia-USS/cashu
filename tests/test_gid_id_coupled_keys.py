"""Guard (gid.md 6, S26 / S30): a local integer id embedded in a key-like string (``f"...:{x.id}"``,
``f"...|{x_id}"``, ``f"...~{x.id}"``) does not survive the move to the event log, where ids are gids.
Every such site in ``src/cashu`` must be one gid.md 6 lists (genesis and the outbox rewrite it, or it
is device-local). A new site fails here: add it to gid.md 6, to the genesis rewriter
(``packages/store/src/genesis/rewrite.ts``) and to the outbox, then to ``ALLOWED`` below."""

from __future__ import annotations

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "cashu"

# An f-string literal with a `:`, `|` or `~` right before a replacement field naming an id.
SITE = re.compile(r"""f(["'])[^"'\n]*?[:|~]\{[^}]*?(?:_id\b|\.id\b|\bid\b)[^}]*\}[^"'\n]*\1""")

# (path under src/cashu, the f-string literal) -> where gid.md 6 covers it.
ALLOWED: dict[tuple[str, str], str] = {
    ("modules/investments/rules/outcomes.py", 'f"i:{instrument_id}"'): "signal dedup key, instrument scope",
    ("modules/investments/rules/outcomes.py", 'f"a:{account_id}"'): "signal dedup key, account scope",
    ("modules/investments/plan/keys.py", 'f"{PLAN_PREFIX}{check}|i:{instrument_id}"'): "plan-check key",
    ("modules/investments/research/keys.py", 'f"i:{instrument_id}"'): "research key",
    ("modules/investments/service/alerts.py", 'f"alert:{row.id}"'): "alert signal rule id / key",
    ("modules/budget/cash.py", 'f"cashleg:{bank_txn.id}"'): "cash leg dedup_hash (derived)",
    ("modules/budget/monthclose.py", 'f"cashleg:{t.id}"'): "cash leg lookup (derived)",
    ("core/accounts.py", 'f"{key}~{holder.id}"'): "parked account key (derived)",
    ("core/accounts.py", 'f"~{account.id}"'): "parked account key (derived)",
    ("core/sync_outbox.py", """f"~{row['id']}\""""): "parked account key (the outbox filter)",
    ("core/connectors/sync.py", 'f"connector:{ctx.state.connector_id}"'): "connector id is a name, not a row id",
    ("core/connectors/proposals.py", """f"connector:{p.get('connector_id')}\""""): "connector id is a name",
    ("core/connectors/sync.py", 'f"investments:{result.batch_id}"'): "connector_runs.batch_ref (device-local)",
    ("core/connectors/sync.py", """f"budget:{result['batch_id']}\""""): "connector_runs.batch_ref (device-local)",
    ("core/connectors/proposals.py", """f"budget:{result['batch_id']}\""""): "connector_runs.batch_ref (device-local)",
    ("core/mcp/tools/investments_proposals.py", 'f"investments:{result.batch_id}"'): "connector_runs.batch_ref (device-local)",
}


def sites() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(SRC).as_posix()
        for match in SITE.finditer(path.read_text(encoding="utf-8")):
            found.add((rel, match.group(0)))
    return found


def test_every_id_coupled_key_site_is_listed_in_gid_md_6():
    unlisted = sorted(sites() - ALLOWED.keys())
    assert not unlisted, f"new id-coupled key site(s), see this module's docstring: {unlisted}"


def test_the_allow_list_has_no_stale_entries():
    assert not sorted(ALLOWED.keys() - sites())


def test_the_pattern_catches_the_known_shapes():
    for text in ('f"i:{instrument_id}"', 'f"x|{row.id}"', 'f"{k}~{a.id}"', "f'alert:{id}'"):
        assert SITE.search(text), text
    for text in ('f"{name}: {count}"', '"i:{instrument_id}"', 'f"{a}|{b}"'):
        assert not SITE.search(text), text
