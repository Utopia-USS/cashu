"""F7 MB: vehicle rows carry their depreciation terms (MB1); a manual position or vehicle can be removed
from the profile's view and restored (MB2): gone from the list, from net worth now and in the history,
from the accounts list and the loans list, kept in the database; idempotent; profile-isolated.
Synthetic data (conftest.seed_demo)."""

from __future__ import annotations

import datetime as dt

from sqlmodel import select

from finanse.core import profiles
from finanse.core.institutions import MANUAL as MANUAL_BANK
from finanse.db import get_session
from finanse.models import Account
from finanse.modules.assets import depreciation

MANUAL = "/api/assets/manual"


def _by_name(rows: list[dict], name: str) -> dict:
    return next(r for r in rows if r["name"] == name)


def _names(api) -> list[str]:
    return [r["name"] for r in api.get(MANUAL).json()]


def _snapshot(api) -> dict:
    """Everything net-worth related the app shows (current and history)."""
    return {
        "networth": api.get("/api/networth").json(),
        "series": api.get("/api/networth/series").json(),
        "monthly": api.get("/api/networth/series?granularity=monthly").json(),
        "accounts": api.get("/api/accounts").json(),
        "summary": api.get("/api/summary").json(),
    }


# --------------------------------------------------------------------------- #
# MB1: depreciation terms on vehicle rows
# --------------------------------------------------------------------------- #


def test_vehicle_rows_carry_their_depreciation_terms(api):
    rows = api.get(MANUAL).json()
    assert all("depreciation" in r for r in rows)
    car = _by_name(rows, "Auto Test")
    # stored as 15 (percent); the contract's annual_rate is a fraction
    assert car["depreciation"] == {
        "purchase_price": 80000.0,
        "purchase_date": "2025-05-01",
        "annual_rate": 0.15,
        "floor": 10000.0,
    }
    expected = depreciation.value(80000, dt.date(2025, 5, 1), 15, dt.date.today(), 10000)  # noqa: DTZ011
    assert car["balance"] == float(expected)
    assert _by_name(rows, "Mieszkanie Test")["depreciation"] is None
    assert _by_name(rows, "Kredyt hipoteczny Test")["depreciation"] is None


def test_a_vehicle_without_stored_terms_has_null_depreciation(api):
    with get_session() as s:
        pid = profiles.scope(s, None)
        s.add(
            Account(
                bank=MANUAL_BANK,
                name="Rower Test",
                external_id="vehicle:Rower Test",
                type="vehicle",
                currency="PLN",
                profile_id=pid,
            )
        )
        s.commit()
    bike = _by_name(api.get(MANUAL).json(), "Rower Test")
    assert bike["kind"] == "vehicle" and bike["depreciation"] is None


# --------------------------------------------------------------------------- #
# MB2: remove + restore
# --------------------------------------------------------------------------- #


def test_remove_hides_everywhere_and_restore_brings_everything_back(api):
    flat = _by_name(api.get(MANUAL).json(), "Mieszkanie Test")
    assert api.patch(f"{MANUAL}/{flat['id']}", json={"note": "Do sprzedaży"}).status_code == 200
    flat = _by_name(api.get(MANUAL).json(), "Mieszkanie Test")
    before = _snapshot(api)

    r = api.delete(f"{MANUAL}/{flat['id']}")
    assert r.status_code == 200 and r.json() == {"id": flat["id"], "removed": True}
    assert "Mieszkanie Test" not in _names(api)
    after = _snapshot(api)
    pln = before["networth"]["totals"]["PLN"]
    assert after["networth"]["totals"]["PLN"] == pln - 600000.0
    assert flat["id"] not in {a["id"] for a in after["networth"]["accounts"]}
    assert flat["id"] not in {a["id"] for a in after["accounts"]}
    assert after["networth"]["breakdown"] != before["networth"]["breakdown"]
    for series in (after["series"], after["monthly"]):
        assert "property" not in {c["key"] for c in series["components"]}
        assert all("property" not in p["components"] for p in series["points"])
    assert any("property" in p["components"] for p in before["series"]["points"])
    with get_session() as s:  # kept in the database for a restore
        row = s.get(Account, flat["id"])
        assert row is not None and row.removed_at is not None

    # idempotent; a removed position is gone for PATCH
    again = api.delete(f"{MANUAL}/{flat['id']}")
    assert again.status_code == 200 and again.json() == {"id": flat["id"], "removed": True}
    assert api.patch(f"{MANUAL}/{flat['id']}", json={"note": "x"}).status_code == 404

    restored = api.post(f"{MANUAL}/{flat['id']}/restore")
    assert restored.status_code == 200
    assert restored.json() == flat  # the row as GET returned it, note included
    assert _snapshot(api) == before
    unchanged = api.post(f"{MANUAL}/{flat['id']}/restore")
    assert unchanged.status_code == 200 and unchanged.json() == flat


def test_a_vehicle_is_removed_and_restored_too(api):
    before = _snapshot(api)
    car = _by_name(api.get(MANUAL).json(), "Auto Test")
    assert api.delete(f"{MANUAL}/{car['id']}").json() == {"id": car["id"], "removed": True}
    after = _snapshot(api)
    assert "Auto Test" not in _names(api)
    assert after["networth"]["totals"]["PLN"] == round(
        before["networth"]["totals"]["PLN"] - car["balance"], 2
    )
    assert all("vehicle" not in p["components"] for p in after["series"]["points"])
    assert api.post(f"{MANUAL}/{car['id']}/restore").json() == car
    assert _snapshot(api) == before


def test_profile_routes_unknown_ids_and_isolation(api):
    with get_session() as s:
        other = profiles.create_profile(s, name="Druga Test", modules_=["assets"])
        slug = other.slug
        default_slug = profiles.default_profile(s).slug
        s.commit()
    flat = _by_name(api.get(MANUAL).json(), "Mieszkanie Test")
    # another profile cannot remove or restore it
    assert api.delete(f"/api/p/{slug}/assets/manual/{flat['id']}").status_code == 404
    assert api.post(f"/api/p/{slug}/assets/manual/{flat['id']}/restore").status_code == 404
    assert "Mieszkanie Test" in _names(api)
    # unknown ids and accounts that are not manual positions
    checking = next(a for a in api.get("/api/accounts").json() if a["name"] == "mKonto Test")
    for bad in (999999, checking["id"]):
        assert api.delete(f"{MANUAL}/{bad}").status_code == 404
        assert api.post(f"{MANUAL}/{bad}/restore").status_code == 404
    # the profile-scoped routes work like the legacy aliases
    base = f"/api/p/{default_slug}/assets/manual"
    assert api.delete(f"{base}/{flat['id']}").json() == {"id": flat["id"], "removed": True}
    assert "Mieszkanie Test" not in [r["name"] for r in api.get(base).json()]
    assert api.get(f"/api/p/{slug}/assets/manual").json() == []
    assert api.post(f"{base}/{flat['id']}/restore").json() == flat


def test_a_new_position_with_a_removed_name_starts_fresh(api):
    flat = _by_name(api.get(MANUAL).json(), "Mieszkanie Test")
    api.delete(f"{MANUAL}/{flat['id']}")
    created = api.post(MANUAL, json={"name": "Mieszkanie Test", "type": "property", "value": 1000})
    assert created.status_code == 201, created.text
    fresh = created.json()
    assert fresh["id"] != flat["id"] and fresh["balance"] == 1000.0
    networth = api.get("/api/networth").json()
    assert fresh["id"] in {a["id"] for a in networth["accounts"]}
    assert flat["id"] not in {a["id"] for a in networth["accounts"]}
    # the old one can still come back; the name shows twice then (its key stays parked)
    assert api.post(f"{MANUAL}/{flat['id']}/restore").json()["balance"] == 600000.0
    assert _names(api).count("Mieszkanie Test") == 2
    with get_session() as s:
        keys = {
            a.id: a.external_id
            for a in s.exec(select(Account).where(Account.name == "Mieszkanie Test"))
        }
    assert keys == {
        fresh["id"]: "manual:Mieszkanie Test",
        flat["id"]: f"manual:Mieszkanie Test~{flat['id']}",
    }
    # removing the new one frees the key: restoring the old one again takes its name key back
    api.delete(f"{MANUAL}/{fresh['id']}")
    api.delete(f"{MANUAL}/{flat['id']}")
    api.post(f"{MANUAL}/{flat['id']}/restore")
    with get_session() as s:
        assert s.get(Account, flat["id"]).external_id == "manual:Mieszkanie Test"


def test_a_removed_loan_account_leaves_the_loans_list(api):
    loans = api.get("/api/loans").json()
    assert loans, "the demo profile has a loan"
    account_id = loans[0]["account_id"]
    assert api.delete(f"{MANUAL}/{account_id}").status_code == 200
    assert account_id not in {x["account_id"] for x in api.get("/api/loans").json()}
    api.post(f"{MANUAL}/{account_id}/restore")
    assert api.get("/api/loans").json() == loans


# --------------------------------------------------------------------------- #
# F7 re-review B2: loans follow the same name re-use rule
# --------------------------------------------------------------------------- #

LOAN_KEYS = ("account_id", "principal", "annual_rate", "term_months", "start_date")


def _loans(api) -> list[dict]:
    return [{k: x[k] for k in LOAN_KEYS} for x in api.get("/api/loans").json()]
