"""F9 backend (asset detail Q25): one decision covering several signals of a position. The
``inv_decision_signals`` link table, ``POST /positions/{instrument_id}/decision`` (acknowledges every
listed signal, one journal row + one link per signal; 404 / 409 / 422 checks), the undo reverting every
acknowledgement it caused, ``signal.decisions`` / ``decision.signal_ids`` through the links, the
legacy per-signal endpoints still writing one link, and the worker's "decided" check. Synthetic data
only."""

from __future__ import annotations

import pytest
from invp_support import STRATEGY_YAML, add_account, canonical_csv, import_file, make_profile
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.worker import investments as worker_investments
from cashu.modules.investments.models import (
    InvDecision,
    InvDecisionSignal,
    InvInstrument,
    InvNotification,
    InvSignal,
)
from cashu.modules.investments.service import files
from cashu.modules.investments.store import journal


def setup_investor() -> tuple[int, str]:
    pid, slug = make_profile()
    aid = add_account(pid)
    import_file(pid, aid, canonical_csv())
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return pid, slug


@pytest.fixture
def api(api_empty):
    pid, slug = setup_investor()
    return api_empty, pid, f"/api/p/{slug}/investments"


def instrument_id(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def add_signal(pid: int, iid: int | None, key: str, *, status: str = "active") -> int:
    with get_session() as s:
        row = InvSignal(
            profile_id=pid,
            rule_id=f"test_{key}",
            kind="gain_from_cost",
            dedup_key=key,
            severity="action",
            status=status,
            message=f"Example signal {key}",
            instrument_id=iid,
            payload={},
        )
        s.add(row)
        s.commit()
        return row.id


def signal_row(sid: int) -> InvSignal:
    with get_session() as s:
        row = s.get(InvSignal, sid)
        s.expunge(row)
        return row


def links() -> list[tuple[int, int]]:
    with get_session() as s:
        return sorted((r.decision_id, r.signal_id) for r in s.exec(select(InvDecisionSignal)).all())


def decision_count() -> int:
    with get_session() as s:
        return len(s.exec(select(InvDecision.id)).all())


def test_position_decision_over_two_signals_acknowledges_both_with_one_row(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    r = client.post(
        f"{base}/positions/{xmpl}/decision",
        json={
            "action": "bought",
            "quantity": "5",
            "price": "12.5",
            "reason": "dokupuję",
            "signal_ids": [s1, s2, s1],
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    decision = body["decision"]
    assert decision["signal_id"] == s1 and decision["signal_ids"] == [s1, s2]
    assert decision["instrument_id"] == xmpl and decision["action"] == "bought"
    assert decision["quantity"] == 5.0 and decision["price"] == 12.5
    assert [s["id"] for s in body["signals"]] == [s1, s2]
    for sig in body["signals"]:
        assert sig["status"] == "acknowledged"
        assert sig["acknowledged_at"] == decision["created_at"]
        assert [d["id"] for d in sig["decisions"]] == [decision["id"]]
        assert sig["decisions"][0]["signal_ids"] == [s1, s2]
    assert decision_count() == 1
    assert links() == [(decision["id"], s1), (decision["id"], s2)]


def test_signal_dict_lists_the_shared_decision_under_both_signals(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    other = add_signal(pid, xmpl, "c")
    did = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [s1, s2]}
    ).json()["decision"]["id"]
    by_id = {s["id"]: s for s in client.get(f"{base}/signals").json()}
    assert [d["id"] for d in by_id[s1]["decisions"]] == [did]
    assert [d["id"] for d in by_id[s2]["decisions"]] == [did]
    assert by_id[other]["decisions"] == [] and by_id[other]["status"] == "active"
    listed = next(d for d in client.get(f"{base}/decisions").json() if d["id"] == did)
    assert listed["signal_ids"] == [s1, s2]
    detail = client.get(f"{base}/positions/{xmpl}").json()
    assert next(d for d in detail["decisions"] if d["id"] == did)["signal_ids"] == [s1, s2]
    digest = client.get(f"{base}/review-digest").json()
    assert digest["signals"]["undecided"] == 1  # only `other`; still counted per signal
    assert next(d for d in digest["decisions"] if d["id"] == did)["signal_ids"] == [s1, s2]
    with get_session() as s:
        assert [d.id for d in journal.decisions(s, pid, signal_id=s2)] == [did]


def test_undo_reverts_every_linked_acknowledgement(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    did = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [s1, s2]}
    ).json()["decision"]["id"]
    r = client.delete(f"{base}/decisions/{did}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["deleted"] == did
    assert [s["id"] for s in body["signals"]] == [s1, s2]
    assert body["signal"] == body["signals"][0]
    assert all(s["status"] == "active" and s["acknowledged_at"] is None for s in body["signals"])
    assert all(signal_row(i).status == "active" for i in (s1, s2))
    assert decision_count() == 0 and links() == []


def test_undo_leaves_a_signal_another_decision_covers_acknowledged(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    did = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [s1, s2]}
    ).json()["decision"]["id"]
    later = client.post(f"{base}/signals/{s2}/decision", json={"action": "other"})
    assert later.status_code == 201
    body = client.delete(f"{base}/decisions/{did}").json()
    status = {s["id"]: s["status"] for s in body["signals"]}
    assert status == {s1: "active", s2: "acknowledged"}
    assert signal_row(s2).status == "acknowledged"
    s2_dict = next(s for s in body["signals"] if s["id"] == s2)
    assert [d["id"] for d in s2_dict["decisions"]] == [later.json()["decision"]["id"]]


def test_an_earlier_acknowledgement_survives_until_its_last_decision_is_undone(api):
    """A signal acknowledged before the position decision keeps that acknowledgement while any
    decision covers it; once none does (whatever the undo order) it is active again (BE-1)."""
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    ack = client.post(f"{base}/signals/{s2}/acknowledge", json={})
    assert ack.status_code == 200
    acked_at = ack.json()["signal"]["acknowledged_at"]
    body = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [s1, s2]}
    ).json()
    assert {s["id"]: s["acknowledged_at"] for s in body["signals"]}[s2] == acked_at
    client.delete(f"{base}/decisions/{ack.json()['decision']['id']}")  # the ack's own entry
    assert signal_row(s2).status == "acknowledged"  # the position decision still covers it
    client.delete(f"{base}/decisions/{body['decision']['id']}")
    assert signal_row(s1).status == "active"
    assert signal_row(s2).status == "active" and signal_row(s2).acknowledged_at is None


def test_undoing_two_position_decisions_oldest_first_leaves_the_signals_active(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    post = {"action": "held", "signal_ids": [s1, s2]}
    first = client.post(f"{base}/positions/{xmpl}/decision", json=post).json()["decision"]["id"]
    second = client.post(f"{base}/positions/{xmpl}/decision", json=post).json()["decision"]["id"]
    undo = client.delete(f"{base}/decisions/{first}").json()
    assert {s["id"]: s["status"] for s in undo["signals"]} == {
        s1: "acknowledged",
        s2: "acknowledged",
    }
    assert all([d["id"] for d in s["decisions"]] == [second] for s in undo["signals"])
    undo = client.delete(f"{base}/decisions/{second}").json()
    assert {s["id"]: s["status"] for s in undo["signals"]} == {s1: "active", s2: "active"}
    assert links() == []


def test_a_signal_of_another_instrument_is_422_and_writes_nothing(api):
    client, pid, base = api
    xmpl, abc = instrument_id("XMPL"), instrument_id("ABC")
    mine, foreign = add_signal(pid, xmpl, "a"), add_signal(pid, abc, "b")
    r = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [mine, foreign]}
    )
    assert r.status_code == 422
    assert r.json()["detail"] == f"Signal {foreign} is not about instrument {xmpl}"
    assert decision_count() == 0 and links() == []
    assert signal_row(mine).status == "active"


def test_a_portfolio_level_signal_is_422(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    portfolio = add_signal(pid, None, "p")
    r = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [portfolio]}
    )
    assert r.status_code == 422
    assert r.json()["detail"] == f"Signal {portfolio} is not about instrument {xmpl}"
    assert decision_count() == 0 and signal_row(portfolio).status == "active"


def test_a_closed_signal_is_409(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    open_, closed = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b", status="resolved")
    r = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [open_, closed]}
    )
    assert r.status_code == 409
    assert r.json()["detail"] == f"Signal {closed} is resolved"
    assert decision_count() == 0 and signal_row(open_).status == "active"


def test_unknown_instrument_signal_or_account_is_404_and_bad_input_422(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    sid = add_signal(pid, xmpl, "a")
    other_pid, _ = make_profile("Druga")
    theirs = add_signal(other_pid, xmpl, "z")
    post = lambda iid, **body: client.post(f"{base}/positions/{iid}/decision", json=body)
    assert post(999_999, action="held").status_code == 404
    assert post(xmpl, action="held", signal_ids=[999_999]).status_code == 404
    assert post(xmpl, action="held", signal_ids=[theirs]).status_code == 404
    assert post(xmpl, action="held", account_id=999_999).status_code == 404
    assert post(xmpl, action="nope", signal_ids=[sid]).status_code == 422
    assert post(xmpl, action="sold", quantity="-1").status_code == 422
    assert decision_count() == 0 and signal_row(sid).status == "active"
    assert signal_row(theirs).status == "active"


def test_a_position_decision_without_signals(api):
    client, _pid, base = api
    xmpl = instrument_id("XMPL")
    r = client.post(f"{base}/positions/{xmpl}/decision", json={"action": "ignored", "reason": "x"})
    assert r.status_code == 201
    body = r.json()
    assert body["signals"] == []
    assert body["decision"]["signal_id"] is None and body["decision"]["signal_ids"] == []
    assert body["decision"]["instrument_id"] == xmpl
    assert links() == []
    undo = client.delete(f"{base}/decisions/{body['decision']['id']}").json()
    assert undo["signal"] is None and undo["signals"] == []


def test_legacy_per_signal_endpoints_write_one_link(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    d1 = client.post(f"{base}/signals/{s1}/decision", json={"action": "held"}).json()
    d2 = client.post(f"{base}/signals/{s2}/acknowledge", json={}).json()
    assert d1["decision"]["signal_ids"] == [s1] and d2["decision"]["signal_ids"] == [s2]
    assert d1["signal"]["status"] == "acknowledged"
    assert links() == [(d1["decision"]["id"], s1), (d2["decision"]["id"], s2)]
    undo = client.delete(f"{base}/decisions/{d1['decision']['id']}").json()
    assert undo["signal"]["id"] == s1 and undo["signal"]["status"] == "active"
    assert [s["id"] for s in undo["signals"]] == [s1]


def test_record_decision_refuses_signals_of_different_instruments(db_engine):
    pid, _slug = setup_investor()
    xmpl, abc = instrument_id("XMPL"), instrument_id("ABC")
    a, b = add_signal(pid, xmpl, "a"), add_signal(pid, abc, "b")
    with get_session() as s:
        rows = [s.get(InvSignal, a), s.get(InvSignal, b)]
        with pytest.raises(journal.JournalError, match="different instruments"):
            journal.record_decision(s, pid, action="held", signal_rows=rows)
        with pytest.raises(journal.JournalError, match="another instrument"):
            journal.record_decision(s, pid, action="held", signal_rows=rows[:1], instrument_id=abc)
        row = journal.record_decision(
            s, pid, action="held", signal_row=rows[0], signal_rows=[rows[0]]
        )
        assert row.signal_id == a and row.instrument_id == xmpl
        assert journal.decision_signal_ids(s, [row]) == {row.id: [a]}


def test_worker_counts_a_linked_signal_as_decided(db_engine):
    pid, _slug = setup_investor()
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    with get_session() as s:
        s.add(InvNotification(profile_id=pid, signal_id=s2, severity="action"))
        s.commit()
    with get_session() as s:
        assert [p.decided for p in worker_investments.pending(s, pid)] == [False]
        journal.record_decision(
            s, pid, action="held", signal_rows=[s.get(InvSignal, s1), s.get(InvSignal, s2)]
        )
        s.commit()
    with get_session() as s:
        assert [p.decided for p in worker_investments.pending(s, pid)] == [True]


def test_post_and_reads_list_signal_ids_in_the_same_order(api):
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    a, b, c = (add_signal(pid, xmpl, k) for k in "abc")
    posted = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [a, c, b]}
    ).json()["decision"]
    assert posted["signal_id"] == a and posted["signal_ids"] == [a, b, c]
    listed = next(d for d in client.get(f"{base}/decisions").json() if d["id"] == posted["id"])
    assert listed == posted
    by_id = {s["id"]: s for s in client.get(f"{base}/signals").json()}
    assert all(by_id[i]["decisions"] == [posted] for i in (a, b, c))


def test_per_signal_responses_list_every_covering_decision(api):
    """BE-3: decide / acknowledge / snooze answer with the signal as GET /signals shows it."""
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    shared = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [s1, s2]}
    ).json()["decision"]["id"]

    def listed(sid: int) -> dict:
        return next(s for s in client.get(f"{base}/signals").json() if s["id"] == sid)

    decided = client.post(f"{base}/signals/{s2}/decision", json={"action": "other"}).json()
    assert [d["id"] for d in decided["signal"]["decisions"]] == [decided["decision"]["id"], shared]
    assert decided["signal"] == listed(s2)
    acked = client.post(f"{base}/signals/{s1}/acknowledge", json={}).json()
    assert [d["id"] for d in acked["signal"]["decisions"]] == [acked["decision"]["id"], shared]
    assert acked["signal"] == listed(s1)
    snoozed = client.post(f"{base}/signals/{s1}/snooze", json={"until": "2099-01-01"}).json()
    assert snoozed == listed(s1)
    assert snoozed["instrument_label"] == "XMPL"


def test_deleting_a_decision_row_cascades_its_links(db_engine):
    pid, _slug = setup_investor()
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    with get_session() as s:
        row = journal.record_decision(
            s, pid, action="held", signal_rows=[s.get(InvSignal, s1), s.get(InvSignal, s2)]
        )
        s.commit()
        did = row.id
    assert links() == [(did, s1), (did, s2)]
    with db_engine.begin() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        conn.exec_driver_sql("DELETE FROM inv_decisions WHERE id = ?", (did,))
    assert links() == []


def test_the_mcp_record_decision_tool_writes_one_link_row(db_engine):
    import datetime as dt

    from cashu.core.mcp.registry import ToolContext
    from cashu.core.mcp.tools import investments as mcp_investments
    from cashu.core.models import Profile

    pid, _slug = setup_investor()
    sid = add_signal(pid, instrument_id("XMPL"), "a")
    with get_session() as s:
        ctx = ToolContext(
            session=s, profile=s.get(Profile, pid), privacy="strict", today=dt.date(2026, 3, 2)
        )
        mcp_investments.record_decision(ctx, sid, "held", reason="x")
        s.commit()
    with get_session() as s:
        did = s.exec(select(InvDecision.id)).one()
    assert links() == [(did, sid)]
    assert signal_row(sid).status == "acknowledged"


def test_review_digest_over_a_multi_signal_decision(api):
    """The digest lists the decision once (with every signal id), counts both signals decided and
    keeps its ``decision`` event unchanged (``signal_id`` = the first signal only)."""
    client, pid, base = api
    xmpl = instrument_id("XMPL")
    s1, s2 = add_signal(pid, xmpl, "a"), add_signal(pid, xmpl, "b")
    did = client.post(
        f"{base}/positions/{xmpl}/decision", json={"action": "held", "signal_ids": [s1, s2]}
    ).json()["decision"]["id"]
    digest = client.get(f"{base}/review-digest").json()
    assert [d["signal_ids"] for d in digest["decisions"] if d["id"] == did] == [[s1, s2]]
    assert digest["signals"]["undecided"] == 0
    events = [e for e in digest["events"] if e.get("type") == "decision"]
    assert len(events) == 1 and events[0]["decision_id"] == did
    assert events[0]["signal_id"] == s1 and "signal_ids" not in events[0]
