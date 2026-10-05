"""Research API: notes list with filters, summary, runs, dismiss / restore, candidate accept / undo,
error codes, and profile isolation for every research endpoint (another profile's notes, runs and
candidates are invisible and untouchable, and writes through one profile never change another).
Synthetic data only."""

from __future__ import annotations

import datetime as dt

import pytest
from invp_support import canonical_csv
from sqlmodel import select

from finanse.core.db import get_session
from finanse.core.models import Profile, utcnow
from finanse.modules.investments.models import InvInstrument, InvSignal
from finanse.modules.investments.research import service
from finanse.modules.investments.research.validation import RunScope, validate_note
from finanse.modules.investments.store import journal

ROUTES = ("research", "research/summary", "research/runs")


def profile(client, name: str) -> tuple[str, int]:
    slug = client.post("/api/profiles", json={"name": name, "modules": ["investments"]}).json()[
        "slug"
    ]
    aid = client.post(
        f"/api/p/{slug}/investments/accounts", json={"name": "DIF", "broker": "dif"}
    ).json()["id"]
    preview = client.post(
        f"/api/p/{slug}/investments/import/preview",
        files={"file": ("h.csv", canonical_csv(), "text/csv")},
        data={"account_id": str(aid)},
    ).json()
    client.post(
        f"/api/p/{slug}/investments/import/commit",
        json={"file_id": preview["file_id"], "file_name": "h.csv", "account_id": aid},
    )
    with get_session() as s:
        pid = s.exec(select(Profile.id).where(Profile.slug == slug)).one()
    return slug, pid


def iid(symbol: str) -> int:
    with get_session() as s:
        return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).one()


def note(pid: int, n: int, *, instrument: str | None = "XMPL", **changes) -> int:
    raw = {
        "kind": "news",
        "polarity": "negative",
        "strength": 2,
        "title": f"Example fact {n}",
        "summary": "Przykladowy fakt ze zrodla, opisany neutralnie.",
        "sources": [
            {
                "url": f"https://example.com/n/{n}",
                "publisher": "Example News",
                "published_at": utcnow().date().isoformat(),
            }
        ],
        **changes,
    }
    with get_session() as s:
        p = s.get(Profile, pid)
        ref = service.resolve_reference(s, pid, instrument) if instrument else None
        return service.add_note(s, p, validate_note(raw, now=utcnow()), instrument_id=ref).note.id


CANDIDATE = {
    "kind": "candidate",
    "polarity": "positive",
    "candidate": {"symbol_or_isin": "NEWCO.WA", "name": "Newco SA"},
    "details": {"entry_type": "trend", "criteria": [{"text": "C/Z 9,8", "met": True}]},
}


@pytest.fixture
def two(api_empty):
    a_slug, a_pid = profile(api_empty, "Anna Przykladowa")
    b_slug, b_pid = profile(api_empty, "Bartek Przykladowy")
    return api_empty, (a_slug, a_pid), (b_slug, b_pid)


def test_notes_list_filters_and_codes(two):
    client, (slug, pid), _ = two
    base = f"/api/p/{slug}/investments/research"
    with get_session() as s:
        journal.create_thesis(s, pid, iid("XMPL"), {"entry_type": "trend", "thesis": "T"})
        run = service.start_run(s, s.get(Profile, pid), RunScope())
        run_id = run.id
    n1 = note(pid, 1, thesis_relation="invalidates", thesis_field="invalidation")
    n2 = note(pid, 2, instrument=None, theme="Energia", kind="macro", polarity="neutral")
    n3 = note(pid, 3, instrument=None, **CANDIDATE)
    n4 = note(pid, 4, instrument="ABC", expires_in_days=1)
    rows = client.get(base).json()
    assert {r["id"] for r in rows} == {n1, n2, n3, n4}
    first = next(r for r in rows if r["id"] == n1)
    assert first["instrument"]["symbol"] == "XMPL" and first["held"] is True
    assert first["signal"]["severity"] == "action" and first["run_id"] == run_id
    assert first["sources"][0]["publisher"] == "Example News"
    assert first["restorable_until"] is None and first["dismissed"] is False
    cand = next(r for r in rows if r["id"] == n3)
    assert cand["candidate"]["symbol"] == "NEWCO.WA" and cand["candidate"]["accepted_at"] is None
    assert cand["details"]["entry_type"] == "trend"
    assert [r["id"] for r in client.get(f"{base}?instrument={iid('XMPL')}").json()] == [n1]
    assert [r["id"] for r in client.get(f"{base}?theme=energia").json()] == [n2]
    assert {r["id"] for r in client.get(f"{base}?kind=candidate,macro").json()} == {n2, n3}
    assert {r["id"] for r in client.get(f"{base}?run_id={run_id}").json()} == {n1, n2, n3, n4}
    tomorrow = (utcnow() + dt.timedelta(days=1)).date().isoformat()
    assert client.get(f"{base}?since={tomorrow}").json() == []
    assert len(client.get(f"{base}?since={utcnow().date().isoformat()}").json()) == 4
    for bad in ("kind=rumour", "since=yesterday", "limit=0"):
        r = client.get(f"{base}?{bad}")
        assert r.status_code == 422, bad
    assert client.get(f"{base}?kind=rumour").headers["X-Finanse-Error-Code"] == "research_invalid"
    with get_session() as s:
        row = service.note(s, pid, n4)
        row.expires_at = utcnow() - dt.timedelta(hours=1)
        s.add(row)
    assert n4 not in {r["id"] for r in client.get(base).json()}
    expired = client.get(f"{base}?include_expired=true").json()
    assert next(r for r in expired if r["id"] == n4)["expired"] is True


def test_dismiss_restore_and_codes(two):
    client, (slug, pid), _ = two
    base = f"/api/p/{slug}/investments/research"
    with get_session() as s:
        journal.create_thesis(s, pid, iid("XMPL"), {"entry_type": "trend", "thesis": "T"})
    n1 = note(pid, 1, thesis_relation="invalidates")
    r = client.patch(f"{base}/{n1}", json={"dismissed": True})
    assert r.status_code == 200 and r.json()["dismissed"] and r.json()["restorable_until"]
    with get_session() as s:
        sig = s.exec(select(InvSignal).where(InvSignal.profile_id == pid)).all()
        research = [x for x in sig if x.dedup_key.startswith("research:")]
        assert research[0].status == "resolved"
    assert client.get(base).json() == []
    assert client.get(f"{base}?include_dismissed=true").json()[0]["id"] == n1
    r = client.patch(f"{base}/{n1}", json={"dismissed": False})
    assert r.status_code == 200 and not r.json()["dismissed"]
    assert r.json()["signal"]["status"] == "active"
    assert client.patch(f"{base}/{n1}", json={"dismissed": True, "x": 1}).status_code == 422
    assert client.patch(f"{base}/{n1}", json={}).status_code == 422
    missing = client.patch(f"{base}/999999", json={"dismissed": True})
    assert missing.status_code == 404 and missing.headers["X-Finanse-Error-Code"] == "not_found"
    client.patch(f"{base}/{n1}", json={"dismissed": True})
    with get_session() as s:
        row = service.note(s, pid, n1)
        row.dismissed_at = utcnow() - dt.timedelta(minutes=16)
        s.add(row)
    late = client.patch(f"{base}/{n1}", json={"dismissed": False})
    assert late.status_code == 409 and late.headers["X-Finanse-Error-Code"] == "undo_expired"


def test_candidate_accept_and_undo(two):
    client, (slug, pid), _ = two
    base = f"/api/p/{slug}/investments/research"
    n = note(pid, 1, instrument=None, **CANDIDATE)
    r = client.post(f"{base}/{n}/accept")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["watchlist_item"]["source"] == "user"
    assert body["watchlist_item"]["note"].startswith("kandydat: ")
    assert body["thesis"]["entry_type"] == "trend" and body["thesis"]["reviewed_at"] is None
    assert body["note"]["candidate"]["accepted_at"] and body["note"]["watched"] is True
    watch = client.get(f"/api/p/{slug}/investments/watchlist").json()
    assert [w["id"] for w in watch] == [body["watchlist_item"]["id"]]
    again = client.post(f"{base}/{n}/accept")
    assert again.status_code == 409 and again.headers["X-Finanse-Error-Code"] == "research_conflict"
    undone = client.delete(f"{base}/{n}/accept")
    assert undone.status_code == 200 and undone.json()["candidate"]["accepted_at"] is None
    assert client.get(f"/api/p/{slug}/investments/watchlist").json() == []
    assert client.delete(f"{base}/{n}/accept").status_code == 409
    # dismiss -> 90-day cooldown, visible on the note
    dismissed = client.patch(f"{base}/{n}", json={"dismissed": True}).json()
    assert dismissed["cooldown_until"] is not None
    assert client.post(f"{base}/{n}/accept").status_code == 409


def test_summary_and_runs(two):
    client, (slug, pid), _ = two
    base = f"/api/p/{slug}/investments/research"
    empty = client.get(f"{base}/summary").json()
    assert empty["last_run"] is None and empty["themes"] == []
    assert {r["label"] for r in empty["instruments"]} == {"ABC", "WRLD", "XMPL"}
    assert all(r["health"] == "no_thesis" for r in empty["instruments"])
    assert client.get(f"{base}/runs").json() == []
    with get_session() as s:
        journal.create_thesis(s, pid, iid("XMPL"), {"entry_type": "trend", "thesis": "T"})
        run = service.start_run(s, s.get(Profile, pid), RunScope(scheduled=True))
        run_id = run.id
    note(pid, 1, thesis_relation="weakens", theme="Technologia")
    with get_session() as s:
        service.finish_run(s, s.get(Profile, pid), run_id, counts={"sources_checked": 3})
    summary = client.get(f"{base}/summary").json()
    top = summary["instruments"][0]
    assert top["label"] == "XMPL" and top["health"] == "weakened"
    assert top["counts"]["weakens"] == 1 and top["held"] and top["has_thesis"]
    assert len(top["sentiment_8w"]) == 8 and top["direction"] in ("rising", "falling", "stable")
    assert summary["themes"][0]["theme"] == "Technologia"
    assert summary["last_run"]["id"] == run_id and summary["last_run"]["scheduled"] is True
    runs = client.get(f"{base}/runs").json()
    assert runs[0]["status"] == "done" and runs[0]["counts"]["sources_checked"] == 3
    assert runs[0]["notes"] == 1 and runs[0]["duration_s"] is not None
    assert client.get(f"{base}/runs?limit=0").status_code == 422


def test_profile_isolation_for_every_research_endpoint(two):
    client, (a_slug, a_pid), (b_slug, b_pid) = two
    a = f"/api/p/{a_slug}/investments"
    b = f"/api/p/{b_slug}/investments"
    with get_session() as s:
        journal.create_thesis(s, a_pid, iid("XMPL"), {"entry_type": "trend", "thesis": "T"})
        run = service.start_run(s, s.get(Profile, a_pid), RunScope())
        a_run = run.id
    a_note = note(a_pid, 1, thesis_relation="invalidates", theme="Banki")
    a_cand = note(a_pid, 2, instrument=None, **CANDIDATE)
    before = {route: client.get(f"{b}/{route}").json() for route in ROUTES}
    # B sees nothing of A
    assert before["research"] == [] and before["research/runs"] == []
    assert before["research/summary"]["themes"] == []
    assert before["research/summary"]["totals"]["signals_open"] == 0
    assert all(i["health"] == "no_thesis" for i in before["research/summary"]["instruments"])
    assert client.get(f"{b}/research?run_id={a_run}").json() == []
    assert client.get(f"{b}/research?include_dismissed=true&include_expired=true").json() == []
    # B cannot change A's notes or candidates
    assert client.patch(f"{b}/research/{a_note}", json={"dismissed": True}).status_code == 404
    assert client.patch(f"{b}/research/{a_note}", json={"dismissed": False}).status_code == 404
    assert client.post(f"{b}/research/{a_cand}/accept").status_code == 404
    assert client.delete(f"{b}/research/{a_cand}/accept").status_code == 404
    assert client.get(f"{a}/research").json()[0]["dismissed"] is False
    # A's writes never change B's view
    client.patch(f"{a}/research/{a_note}", json={"dismissed": True})
    client.post(f"{a}/research/{a_cand}/accept")
    after = {route: client.get(f"{b}/{route}").json() for route in ROUTES}
    for route in ROUTES:
        x, y = before[route], after[route]
        if route == "research/summary":
            x, y = dict(x), dict(y)
            for d in (x, y):
                d.pop("last_run", None)
                d["instruments"] = [
                    {k: v for k, v in i.items() if k != "last_researched_at"}
                    for i in d["instruments"]
                ]
        assert x == y, route
    assert client.get(f"{b}/watchlist").json() == []
    # the service refuses cross-profile ids too
    with get_session() as s:
        bp = s.get(Profile, b_pid)
        with pytest.raises(service.ResearchNotFound):
            service.finish_run(s, bp, a_run)
        with pytest.raises(service.ResearchNotFound):
            service.dismiss(s, bp, a_note)
    with get_session() as s:
        assert service.run(s, b_pid, a_run) is None and service.note(s, b_pid, a_note) is None


def test_research_reaches_signals_attention_and_the_review_digest(two):
    client, (slug, pid), _ = two
    base = f"/api/p/{slug}/investments"
    with get_session() as s:
        journal.create_thesis(s, pid, iid("XMPL"), {"entry_type": "trend", "thesis": "T"})
    digest_before = client.get(f"{base}/review-digest").json()["research"]
    assert digest_before["run"] is None and digest_before["notes_count"] == 0
    with get_session() as s:
        run = service.start_run(s, s.get(Profile, pid), RunScope())
        run_id = run.id
    n1 = note(pid, 1, thesis_relation="invalidates", thesis_field="invalidation")
    (sig,) = [x for x in client.get(f"{base}/signals").json() if x["source"] == "research"]
    assert sig["note_id"] == n1 and sig["severity"] == "action" and sig["polarity"] == "negative"
    assert sig["kind"] == "research:news" and sig["payload"]["relation"] == "invalidates"
    attention = client.get(f"{base}/overview").json()["attention"]
    assert any(a.get("note_id") == n1 for a in attention)
    block = client.get(f"{base}/review-digest").json()["research"]
    assert block["run"]["id"] == run_id and block["ran_in_period"]
    assert block["notes_count"] == 1 and block["highlights"] == [n1]
    assert block["theses_changed"][0]["to"] == "invalidated"
    client.patch(f"{base}/research/{n1}", json={"dismissed": True})
    closed = next(
        x for x in client.get(f"{base}/signals?status=history").json() if x["id"] == sig["id"]
    )
    assert closed["status"] == "resolved" and closed["payload"]["closed_reason"] == "note_dismissed"
