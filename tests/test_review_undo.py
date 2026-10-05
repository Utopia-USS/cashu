"""Undo of "review done" (F5 R4): the app saves the review at once and its "Cofnij" deletes it within
15 minutes (409 ``undo_expired`` later); records of another profile are never reachable."""

from __future__ import annotations

import datetime as dt

import pytest

from finanse.core import profiles, reviews
from finanse.core.agent_models import Review
from finanse.core.db import get_session


@pytest.fixture
def setup(db_engine):
    from conftest import make_client

    from finanse.api.app import app

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
    assert late.status_code == 409 and late.headers["X-Finanse-Error-Code"] == "undo_expired"
    with get_session() as s:
        assert s.get(Review, review_id) is not None
        now = dt.datetime.now(dt.UTC)
        with pytest.raises(reviews.ReviewUndoExpired):
            reviews.undo(s, s.get(Review, review_id).profile_id, review_id, now=now)
