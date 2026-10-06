"""Weekly review records: the service (``cashu.core.reviews``), the API (``/api/p/{slug}/reviews``) and
the MCP tool ``mark_review_done``; records stay in their profile."""

from __future__ import annotations

import datetime as dt

import pytest

from cashu.core import profiles, reviews
from cashu.core.db import get_session


@pytest.fixture
def two_profiles(db_engine):
    with get_session() as s:
        a = profiles.create_profile(s, name="Anna", modules_=["investments", "budget"])
        b = profiles.create_profile(s, name="Bartek", modules_=["investments"])
        return a.id, a.slug, b.id, b.slug


@pytest.fixture
def api():
    from conftest import make_client

    from cashu.api.app import app

    return make_client(app)


def test_service_mark_done_last_and_list(two_profiles):
    a, _a_slug, b, _b_slug = two_profiles
    with get_session() as s:
        assert reviews.last(s, a, "investments") is None
        first = reviews.mark_done(s, a, "investments", "  ok  ", {"open_signals": 2})
        second = reviews.mark_done(s, a, "investments")
        reviews.mark_done(s, a, "budget", "b")
        reviews.mark_done(s, b, "investments", "other profile")
        assert first.notes == "ok" and first.stats == {"open_signals": 2}
        assert second.notes is None
        assert first.done_at.tzinfo is not None
        last = reviews.last(s, a, "investments")
        assert last.id == second.id
        assert [r.module for r in reviews.list_reviews(s, a)] == [
            "budget",
            "investments",
            "investments",
        ]
        assert len(reviews.list_reviews(s, a, "investments", limit=1)) == 1
        assert [r.notes for r in reviews.list_reviews(s, b)] == ["other profile"]
        profile = s.get(profiles.Profile, a)
        assert reviews.last(s, profile, "budget").notes == "b"  # a Profile works as well as an id
        d = reviews.review_dict(first)
        assert set(d) == {"id", "module", "done_at", "notes", "stats"}
        assert dt.datetime.fromisoformat(d["done_at"]).tzinfo is not None


def test_service_rejects_bad_input(two_profiles):
    a, *_ = two_profiles
    with get_session() as s:
        with pytest.raises(reviews.ReviewError):
            reviews.mark_done(s, a, "nope")
        with pytest.raises(reviews.ReviewError):
            reviews.mark_done(s, a, "investments", "x" * (reviews.MAX_NOTES + 1))


def test_api_create_and_list(two_profiles, api):
    _a, a_slug, _b, b_slug = two_profiles
    created = api.post(
        f"/api/p/{a_slug}/reviews", json={"module": "investments", "notes": "tydzien 40"}
    )
    assert created.status_code == 201
    body = created.json()
    assert body["module"] == "investments" and body["notes"] == "tydzien 40"
    assert body["stats"] == {
        "source": "app",
        "open_signals": 0,
        "action_signals": 0,
        "decisions_since_last_review": 0,
    }
    api.post(f"/api/p/{a_slug}/reviews", json={"module": "budget"})
    assert [r["module"] for r in api.get(f"/api/p/{a_slug}/reviews").json()] == [
        "budget",
        "investments",
    ]
    assert [r["module"] for r in api.get(f"/api/p/{a_slug}/reviews?module=budget").json()] == [
        "budget"
    ]
    assert api.get(f"/api/p/{b_slug}/reviews").json() == []
    assert api.post(f"/api/p/{a_slug}/reviews", json={"module": "nope"}).status_code == 422
    assert api.get("/api/p/nobody/reviews").status_code == 404


def test_mcp_mark_review_done_counts_decisions_since_last_review(db_engine):
    from mcp_support import TODAY, seed_profile

    from cashu.core.mcp.server import CashuMcp

    pid, _slug = seed_profile()
    host = CashuMcp(pid, today=TODAY)
    signal_id = host.call("signals", {}).data["signals"][0]["signal_id"]
    host.call("record_decision", {"signal_id": signal_id, "action": "ignored", "reason": "x"})
    first = host.call("mark_review_done", {"notes": "pierwszy"}).data
    assert first["stats"]["decisions_since_last_review"] == 1
    assert first["stats"]["open_signals"] >= 1
    second = host.call("mark_review_done", {}).data
    assert second["stats"]["decisions_since_last_review"] == 0
    overview = host.call("profile_overview", {}).data
    assert overview["last_reviews"][0]["module"] == "investments"
    budget = host.call("mark_review_done", {"module": "budget"}).data
    assert budget["module"] == "budget"
