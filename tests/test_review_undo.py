"""Undo of "review done" (F5 R4): the app saves the review at once and its "Cofnij" deletes it within
15 minutes (409 ``undo_expired`` later); records of another profile are never reachable."""

from __future__ import annotations

import datetime as dt

import pytest

from cashu.core import profiles, reviews
from cashu.core.agent_models import Review
from cashu.core.db import get_session


@pytest.fixture
def setup(db_engine):
    from conftest import make_client

    from cashu.api.app import app

    with get_session() as s:
        a = profiles.create_profile(s, name="Anna", modules_=["investments"])
        b = profiles.create_profile(s, name="Bartek", modules_=["investments"])
        slugs = a.slug, b.slug
    return slugs, make_client(app)


def test_review_saved_at_once_can_be_undone_once(setup):
    (a, b), api = setup
    saved = api.post(f"/api/p/{a}/reviews", json={"module": "investments", "notes": "ok"})
    assert saved.status_code == 201
    review_id = saved.json()["id"]
    assert api.delete(f"/api/p/{b}/reviews/{review_id}").status_code == 404  # other profile
    undone = api.delete(f"/api/p/{a}/reviews/{review_id}")
    assert undone.status_code == 200 and undone.json() == {"deleted": review_id}
    assert api.get(f"/api/p/{a}/reviews?module=investments").json() == []
    assert api.delete(f"/api/p/{a}/reviews/{review_id}").status_code == 404


def test_review_undo_expires_after_15_minutes(setup):
    (a, _b), api = setup
    review_id = api.post(f"/api/p/{a}/reviews", json={"module": "investments"}).json()["id"]
    with get_session() as s:
        row = s.get(Review, review_id)
        row.done_at = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=16)
        s.add(row)
    late = api.delete(f"/api/p/{a}/reviews/{review_id}")
    assert late.status_code == 409 and late.headers["X-Cashu-Error-Code"] == "undo_expired"
    with get_session() as s:
        assert s.get(Review, review_id) is not None
        now = dt.datetime.now(dt.UTC)
        with pytest.raises(reviews.ReviewUndoExpired):
            reviews.undo(s, s.get(Review, review_id).profile_id, review_id, now=now)


def test_a_review_can_be_recorded_for_a_past_day(setup):
    """F7 OB3: an imported check-in keeps its own day (not in the future); its undo window still
    counts from saving it."""
    (a, _b), api = setup
    past = (_today() - dt.timedelta(days=10)).isoformat()
    saved = api.post(f"/api/p/{a}/reviews", json={"module": "investments", "done_at": past})
    assert saved.status_code == 201, saved.text
    body = saved.json()
    assert body["done_at"] == f"{past}T12:00:00+00:00"
    assert api.get(f"/api/p/{a}/reviews?module=investments").json()[0]["done_at"].startswith(past)
    with get_session() as s:
        assert reviews.last(s, s.get(Review, body["id"]).profile_id, "investments").id == body["id"]
    assert api.delete(f"/api/p/{a}/reviews/{body['id']}").status_code == 200  # just saved

    today = api.post(
        f"/api/p/{a}/reviews",
        json={"module": "investments", "done_at": _today().isoformat()},
    ).json()
    assert "recorded_at" not in today["stats"]  # today: saved now, as without done_at

    future = (_today() + dt.timedelta(days=1)).isoformat()
    r = api.post(f"/api/p/{a}/reviews", json={"module": "investments", "done_at": future})
    assert r.status_code == 422 and "future" in r.json()["detail"]
    r = api.post(f"/api/p/{a}/reviews", json={"module": "investments", "done_at": "05.10.2026"})
    assert r.status_code == 422


def _today() -> dt.date:
    return dt.date.today()  # noqa: DTZ011 - the service compares with the local calendar day
