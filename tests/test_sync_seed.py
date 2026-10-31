"""Genesis seeding of the gid map (S26, ``sync_outbox.seed_ids`` / ``cashu sync seed``): every row the
genesis exporter exported gets its gid in ``sync_ids`` with source ``genesis``, the vault is linked,
re-seeding is a no-op and a different mapping is never overwritten. Synthetic data only."""

from __future__ import annotations

import json

import pytest
from sqlmodel import select
from typer.testing import CliRunner

from cashu.cli import app
from cashu.core import profiles, sync_outbox
from cashu.core.db import get_session
from cashu.core.models import Profile
from cashu.core.sync_models import SyncId, SyncVault

VAULT = "0123456789abcdef0123456789abcdef"
OTHER_VAULT = "fedcba9876543210fedcba9876543210"
G1 = "c1e52d4d-d9a5-84e6-8d7a-c21b36691202"
G2 = "70cc61c8-79b5-80ae-b8cc-fdca7caef49e"
G3 = "01JC0ZA1B2C3D4E5F6G7H8J9K0"


@pytest.fixture
def pid(db_engine):
    with get_session() as s:
        return profiles.create_profile(s, name="Seed", modules_=["budget", "investments"]).id


def entries(pid: int) -> list[dict]:
    return [
        {"table": "profiles", "localId": str(pid), "gid": VAULT},
        {"table": "accounts", "localId": "1", "gid": G2},
        {"table": "inv_theses", "localId": "7", "gid": G1},
        {"table": "profile_modules", "localId": f"{pid}|budget", "gid": G3},
    ]


def mapped(pid: int) -> dict[tuple[str, str], tuple[str, str]]:
    with get_session() as s:
        rows = s.exec(select(SyncId).where(SyncId.profile_id == pid)).all()
        return {(r.table_name, r.local_id): (r.gid, r.source) for r in rows}


def test_seed_maps_every_row_and_links_the_vault(pid):
    with get_session() as s:
        counts = sync_outbox.seed_ids(s, pid, entries(pid))
    assert counts == {"inserted": 3, "kept": 0, "conflicts": 0}
    assert mapped(pid) == {
        ("accounts", "1"): (G2, "genesis"),
        ("inv_theses", "7"): (G1, "genesis"),
        ("profile_modules", f"{pid}|budget"): (G3, "genesis"),
    }
    with get_session() as s:
        assert s.exec(select(SyncVault.vault_id).where(SyncVault.profile_id == pid)).one() == VAULT


def test_seed_twice_is_seed_once_and_never_overwrites(pid):
    with get_session() as s:
        sync_outbox.seed_ids(s, pid, entries(pid))
    other = [*entries(pid)[:1], {"table": "accounts", "localId": "1", "gid": G1}]
    with get_session() as s:
        assert sync_outbox.seed_ids(s, pid, entries(pid)) == {"inserted": 0, "kept": 3, "conflicts": 0}
        assert sync_outbox.seed_ids(s, pid, other) == {"inserted": 0, "kept": 0, "conflicts": 1}
    assert mapped(pid)[("accounts", "1")] == (G2, "genesis")


@pytest.mark.parametrize(
    "bad",
    [
        {"table": "nope", "localId": "1", "gid": G1},
        {"table": "inv_decision_signals", "localId": "1|2", "gid": G1},
        {"table": "accounts", "localId": 1, "gid": G1},
        {"table": "accounts", "localId": "1", "gid": "12"},
    ],
)
def test_seed_refuses_a_malformed_entry(pid, bad):
    with get_session() as s, pytest.raises(ValueError):
        sync_outbox.seed_ids(s, pid, [entries(pid)[0], bad])


def test_seed_refuses_another_profiles_file(pid):
    with get_session() as s, pytest.raises(ValueError):
        sync_outbox.seed_ids(s, pid, [{"table": "profiles", "localId": str(pid + 1), "gid": VAULT}])


def test_cli_seed_prints_counts_only(pid, tmp_path):
    path = tmp_path / "ids.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in entries(pid)), encoding="utf-8")
    with get_session() as s:
        slug = s.get(Profile, pid).slug
    result = CliRunner().invoke(app, ["--profile", slug, "sync", "seed", "--ids", str(path)])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output.strip().splitlines()[-1]) == {"conflicts": 0, "inserted": 3, "kept": 0}


def test_seed_with_a_conflict_writes_nothing(pid):
    with get_session() as s:
        sync_outbox.seed_ids(s, pid, entries(pid)[:2])
    clash = [*entries(pid), {"table": "inv_theses", "localId": "8", "gid": G3}]
    clash[1] = {"table": "accounts", "localId": "1", "gid": G1}
    with get_session() as s:
        assert sync_outbox.seed_ids(s, pid, clash) == {"inserted": 0, "kept": 0, "conflicts": 1}
    assert mapped(pid) == {("accounts", "1"): (G2, "genesis")}


def test_seed_counts_a_row_or_gid_twice_in_the_file_as_a_conflict(pid):
    twice = [*entries(pid), {"table": "inv_theses", "localId": "8", "gid": G1}]
    with get_session() as s:
        assert sync_outbox.seed_ids(s, pid, twice)["conflicts"] == 1
    assert mapped(pid) == {}
    with get_session() as s:
        assert s.exec(select(SyncVault).where(SyncVault.profile_id == pid)).first() is None


def test_seed_refuses_a_profile_linked_to_another_vault(pid):
    with get_session() as s:
        sync_outbox.link_vault(s, pid, OTHER_VAULT)
    with get_session() as s, pytest.raises(ValueError, match="another vault"):
        sync_outbox.seed_ids(s, pid, entries(pid))
    assert mapped(pid) == {}
    with get_session() as s:
        assert s.exec(select(SyncVault.vault_id).where(SyncVault.profile_id == pid)).one() == OTHER_VAULT


def test_seed_into_the_same_linked_vault_is_fine(pid):
    with get_session() as s:
        sync_outbox.link_vault(s, pid, VAULT)
    with get_session() as s:
        assert sync_outbox.seed_ids(s, pid, entries(pid))["inserted"] == 3


def test_seed_refuses_a_non_string_gid_with_a_value_error(pid):
    with get_session() as s, pytest.raises(ValueError):
        sync_outbox.seed_ids(s, pid, [entries(pid)[0], {"table": "accounts", "localId": "1", "gid": 12}])
    with get_session() as s, pytest.raises(ValueError):
        sync_outbox.seed_ids(s, pid, [{"table": "profiles", "localId": str(pid), "gid": 12}])


def test_cli_seed_exits_non_zero_on_a_conflict(pid, tmp_path):
    with get_session() as s:
        sync_outbox.seed_ids(s, pid, entries(pid)[:2])
        slug = s.get(Profile, pid).slug
    clash = [*entries(pid)]
    clash[1] = {"table": "accounts", "localId": "1", "gid": G1}
    path = tmp_path / "ids.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in clash), encoding="utf-8")
    result = CliRunner().invoke(app, ["--profile", slug, "sync", "seed", "--ids", str(path)])
    assert result.exit_code == 1
    assert mapped(pid) == {("accounts", "1"): (G2, "genesis")}
