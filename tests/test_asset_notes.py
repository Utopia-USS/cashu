"""F7 OB5: manual positions carry an optional one-line note (max 500 characters) on create, patch and
list; the note never leaves its profile. Synthetic data (conftest.seed_demo)."""

from __future__ import annotations

from sqlmodel import select

from cashu.db import get_session
from cashu.models import Account, AssetDetails

MANUAL = "/api/assets/manual"


def _by_name(rows: list[dict], name: str) -> dict:
    return next(r for r in rows if r["name"] == name)


def test_list_shows_manual_positions_and_vehicles_with_a_null_note(api):
    rows = api.get(MANUAL).json()
    names = {r["name"]: r for r in rows}
    assert {"Mieszkanie Test", "Kredyt hipoteczny Test", "Auto Test"} <= set(names)
    assert names["Auto Test"]["kind"] == "vehicle" and names["Mieszkanie Test"]["kind"] == "manual"
    assert names["Kredyt hipoteczny Test"]["is_liability"] is True
    assert all(r["note"] is None for r in rows)
    assert "Gotówka" not in names and "mKonto Test" not in names  # cash pool / bank accounts


def test_create_with_a_note_then_patch_and_clear_it(api):
    r = api.post(
        MANUAL,
        json={
            "name": "Wierzytelność Test",
            "type": "other",
            "value": 1200,
            "note": "Zgłoszona do syndyka,\n termin 2026-12-31",
        },
    )
    assert r.status_code == 201, r.text
    row = r.json()
    assert row["note"] == "Zgłoszona do syndyka, termin 2026-12-31"  # one line
    assert row["balance"] == 1200.0 and row["kind"] == "manual" and row["currency"] == "PLN"
    assert _by_name(api.get(MANUAL).json(), "Wierzytelność Test")["note"] == row["note"]

    patched = api.patch(f"{MANUAL}/{row['id']}", json={"note": "Wypłata częściowa"}).json()
    assert patched["note"] == "Wypłata częściowa" and patched["balance"] == 1200.0
    revalued = api.patch(f"{MANUAL}/{row['id']}", json={"value": 900}).json()
    assert revalued["note"] == "Wypłata częściowa" and revalued["balance"] == 900.0
    cleared = api.patch(f"{MANUAL}/{row['id']}", json={"note": None}).json()
    assert cleared["note"] is None
    with get_session() as s:
        assert s.exec(select(AssetDetails)).one().note is None

    # a note on an existing seeded position
    flat = _by_name(api.get(MANUAL).json(), "Mieszkanie Test")
    assert api.patch(f"{MANUAL}/{flat['id']}", json={"note": "Wycena 2026"}).json()["note"] == "Wycena 2026"


def test_note_and_input_validation(api):
    flat = _by_name(api.get(MANUAL).json(), "Mieszkanie Test")
    too_long = api.patch(f"{MANUAL}/{flat['id']}", json={"note": "x" * 501})
    assert too_long.status_code == 422 and "500" in too_long.json()["detail"]
    assert api.patch(f"{MANUAL}/{flat['id']}", json={"note": "x" * 500}).status_code == 200
    r = api.post(MANUAL, json={"name": "Za długa", "type": "other", "value": 1, "note": "y" * 501})
    assert r.status_code == 422
    with get_session() as s:  # refused before anything was written
        assert s.exec(select(Account).where(Account.name == "Za długa")).first() is None
    assert api.post(MANUAL, json={"name": "X", "type": "checking", "value": 1}).status_code == 422
    assert api.post(MANUAL, json={"name": "X", "type": "other", "value": -5}).status_code == 422
    dup = api.post(MANUAL, json={"name": "Mieszkanie Test", "type": "property", "value": 1})
    assert dup.status_code == 409 and dup.headers["X-Cashu-Error-Code"] == "name_taken"
    car = _by_name(api.get(MANUAL).json(), "Auto Test")
    assert api.patch(f"{MANUAL}/{car['id']}", json={"value": 1}).status_code == 422
    checking = next(a for a in api.get("/api/accounts").json() if a["name"] == "mKonto Test")
    assert api.patch(f"{MANUAL}/{checking['id']}", json={"note": "x"}).status_code == 404


def test_a_note_never_reaches_another_profile(api):
    from cashu.core import profiles

    with get_session() as s:
        other = profiles.create_profile(s, name="Druga Test", modules_=["assets"])
        slug = other.slug
        s.commit()
    flat = _by_name(api.get(MANUAL).json(), "Mieszkanie Test")
    api.patch(f"{MANUAL}/{flat['id']}", json={"note": "Tylko moje"})
    assert api.get(f"/api/p/{slug}/assets/manual").json() == []
    assert api.patch(f"/api/p/{slug}/assets/manual/{flat['id']}", json={"note": "x"}).status_code == 404
    assert _by_name(api.get(MANUAL).json(), "Mieszkanie Test")["note"] == "Tylko moje"
