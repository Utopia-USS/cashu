"""Profiles: the platform API (system, modules, profiles, setup) and isolation.

Isolation: two profiles seeded with the same synthetic household (same account
numbers) must each see exactly what a single-profile database shows, on every
profile-scoped endpoint, and writes through one profile never touch the other.
"""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal

import keyring
import pytest
from conftest import IBAN_MAIN, seed_demo
from keyring.backend import KeyringBackend
from sqlmodel import select

from finanse.api.app import app
from finanse.core import profiles
from finanse.core.db import get_session
from finanse.models import Profile, ProfileModule, Transaction

# Every profile-scoped GET route, with the query variants worth comparing.
PROFILE_GETS = [
    "/summary",
    "/networth",
    "/networth/series",
    "/networth/series?granularity=monthly",
    "/networth/series?scope=liquid",
    "/networth/series?currency=EUR",
    "/accounts",
    "/cashflow",
    "/cashflow?currency=EUR",
    "/recurring",
    "/categories",
    "/spending",
    "/spending?year=2026&month=9",
    "/spending?year=2026&quarter=3",
    "/spending?currency=EUR",
    "/uncategorized",
    "/category/groceries/transactions",
    "/category/loans/transactions?sort=amount",
    "/category/subscriptions/transactions?currency=EUR",
    "/cash",
    "/cash?currency=EUR",
    "/loan",
    "/loans",
    "/modules/budget/setup",
    "/modules/assets/setup",
    "/modules/loans/setup",
    "/modules/investments/setup",
]
LEGACY_LESS = ("/modules/",)  # profile-only routes (no /api alias)
ID_KEYS = {"id", "account_id"}


class MemoryKeyring(KeyringBackend):
    priority = 1

    def __init__(self):
        super().__init__()
        self.store: dict[tuple[str, str], str] = {}

    def get_password(self, service, username):
        return self.store.get((service, username))

    def set_password(self, service, username, password):
        self.store[(service, username)] = password

    def delete_password(self, service, username):
        self.store.pop((service, username), None)


@pytest.fixture(autouse=True)
def _memory_keyring():
    """/api/system reports secret presence: never touch the real OS keychain."""
    previous = keyring.get_keyring()
    keyring.set_keyring(MemoryKeyring())
    yield
    keyring.set_keyring(previous)


def _strip(value, slug: str | None = None):
    """Drop row ids (they differ between profiles) and the profile slug in copyable
    commands, so two profiles with the same data compare equal."""
    if isinstance(value, dict):
        return {k: _strip(v, slug) for k, v in value.items() if k not in ID_KEYS}
    if isinstance(value, list):
        return [_strip(v, slug) for v in value]
    if isinstance(value, str) and slug:
        return re.sub(rf"\b{re.escape(slug)}\b", "<slug>", value)
    return value


def _snapshot(client, slug: str) -> dict:
    out = {}
    for path in PROFILE_GETS:
        r = client.get(f"/api/p/{slug}{path}")
        assert r.status_code == 200, (path, r.status_code, r.text)
        out[path] = _strip(r.json(), slug)
    return out


def _profile_id(slug: str) -> int:
    with get_session() as s:
        return profiles.get_by_slug(s, slug).id


# --------------------------------------------------------------------------- #
# Platform endpoints
# --------------------------------------------------------------------------- #

def test_system(api_empty, tmp_path):
    body = api_empty.get("/api/system").json()
    assert set(body) == {
        "version", "data_dir", "legacy_db_detected", "legacy_db_path", "worker", "secrets",
    }
    assert body["data_dir"] == str((tmp_path / "data").resolve())
    assert body["legacy_db_detected"] is False and body["legacy_db_path"] is None
    assert body["worker"] == {"installed": False, "last_run": None}
    assert body["secrets"] == {"anthropic": False, "enable_banking_key": False}


def test_modules(api_empty):
    mods = api_empty.get("/api/modules").json()
    assert [m["id"] for m in mods] == ["budget", "assets", "loans", "investments"]
    for m in mods:
        assert set(m) == {"id", "name", "description", "depends_on", "available"}
        assert m["depends_on"] == [] and m["name"] and m["description"]
    assert {m["id"]: m["available"] for m in mods} == {
        "budget": True, "assets": True, "loans": True, "investments": False,
    }


def test_profiles_crud(api_empty):
    assert api_empty.get("/api/profiles").json() == []
    r = api_empty.post("/api/profiles", json={
        "name": "Jakub Łoś", "base_currency": "pln", "modules": ["budget", "loans"],
        "mcp_privacy": "strict",
    })
    assert r.status_code == 201
    p = r.json()
    assert p["slug"] == "jakub-los" and p["name"] == "Jakub Łoś" and p["base_currency"] == "PLN"
    assert p["mcp_privacy"] == "strict"
    assert p["modules"] == [
        {"id": "budget", "enabled": True, "setup_state": "empty"},
        {"id": "assets", "enabled": False, "setup_state": "empty"},
        {"id": "loans", "enabled": True, "setup_state": "empty"},
        {"id": "investments", "enabled": False, "setup_state": "empty"},
    ]
    # a second profile with a derived name gets its own slug
    marta = api_empty.post("/api/profiles", json={
        "name": "Marta", "base_currency": "EUR", "modules": [], "mcp_privacy": "amounts",
    }).json()
    assert marta["slug"] == "marta" and not any(m["enabled"] for m in marta["modules"])
    assert [p["slug"] for p in api_empty.get("/api/profiles").json()] == ["jakub-los", "marta"]

    patched = api_empty.patch("/api/profiles/marta", json={"name": "Marta K", "mcp_privacy": "strict"})
    assert patched.status_code == 200
    assert (patched.json()["name"], patched.json()["mcp_privacy"]) == ("Marta K", "strict")
    assert patched.json()["slug"] == "marta"  # the slug never changes

    mods = api_empty.put("/api/profiles/jakub-los/modules", json={"modules": ["assets"]}).json()
    assert {m["id"]: m["enabled"] for m in mods["modules"]} == {
        "budget": False, "assets": True, "loans": False, "investments": False,
    }
    # disabling keeps the row (and the data): re-enabling brings it back
    with get_session() as s:
        rows = s.exec(select(ProfileModule).where(ProfileModule.module_id == "budget")).all()
        assert [r.enabled for r in rows] == [False]
    again = api_empty.put("/api/profiles/jakub-los/modules", json={"modules": ["budget", "assets"]})
    assert [m["id"] for m in again.json()["modules"] if m["enabled"]] == ["budget", "assets"]
    assert api_empty.get("/api/profiles/marta").json()["name"] == "Marta K"


def test_profile_validation(api_empty):
    ok = {"name": "Jan", "base_currency": "PLN", "modules": [], "mcp_privacy": "strict"}
    assert api_empty.post("/api/profiles", json=ok).status_code == 201
    # names are unique ignoring case (the UI blocks "jan" next to "Jan" too)
    dup = api_empty.post("/api/profiles", json=ok | {"name": " jan "})
    assert dup.status_code == 409 and "already exists" in dup.json()["detail"]
    other = api_empty.post("/api/profiles", json=ok | {"name": "Ola"}).json()
    rename = api_empty.patch(f"/api/profiles/{other['slug']}", json={"name": "JAN"})
    assert rename.status_code == 409
    for bad in (
        {"name": "  "},
        {"name": "X", "base_currency": "EURO"},
        {"name": "Y", "mcp_privacy": "everything"},
        {"name": "Z", "modules": ["budget", "nope"]},
    ):
        r = api_empty.post("/api/profiles", json=ok | bad)
        assert r.status_code == 422, bad
        assert isinstance(r.json()["detail"], str)
    assert api_empty.patch("/api/profiles/nope", json={"name": "A"}).status_code == 404
    assert api_empty.put("/api/profiles/nope/modules", json={"modules": []}).status_code == 404
    assert api_empty.get("/api/p/nope/summary").status_code == 404
    assert api_empty.get("/api/p/jan/modules/nope/setup").status_code == 404


def test_slugs_are_ascii_and_unique():
    assert profiles.slugify("Żółć Gęślą") == "zolc-gesla"
    assert profiles.slugify("Jakub & Marta!") == "jakub-marta"
    assert profiles.slugify("!!!") == "profil"
    assert len(profiles.slugify("a" * 100)) == 40


def test_slug_collision_gets_a_suffix(api_empty):
    a = api_empty.post("/api/profiles", json={"name": "Dom", "modules": []}).json()
    b = api_empty.post("/api/profiles", json={"name": "Dom!", "modules": []}).json()
    assert (a["slug"], b["slug"]) == ("dom", "dom-2")


def test_setup_endpoint_shape(api_empty):
    api_empty.post("/api/profiles", json={"name": "Jan", "modules": ["budget"]})
    body = api_empty.get("/api/p/jan/modules/budget/setup").json()
    assert set(body) == {"state", "steps", "skill"}
    assert body["state"] == "empty"
    assert [s["status"] for s in body["steps"]] == ["on", "todo", "todo", "todo"]
    for step in body["steps"]:
        assert set(step) == {"id", "title", "description", "status", "actions"}
        for a in step["actions"]:
            assert set(a) == {"kind", "label", "target"} and a["kind"] in {"cli", "tab"}
            if a["kind"] == "cli":
                assert a["target"].startswith("finanse --profile jan ")
    assert body["skill"] == {
        "command": "/budget-setup",
        "mcp_add": "claude mcp add finanse-jan -- finanse mcp --profile jan",
    }


def test_setup_status_follows_the_data(api):
    """The seeded default profile: budget, assets and loans are set up."""
    for module_id in ("budget", "assets", "loans"):
        body = api.get(f"/api/p/default/modules/{module_id}/setup").json()
        assert body["state"] == "ready", (module_id, body)
        assert {s["status"] for s in body["steps"]} == {"done"}
    inv = api.get("/api/p/default/modules/investments/setup").json()
    assert inv["state"] == "empty" and inv["skill"]["command"] == "/investments-setup"
    states = {m["id"]: m["setup_state"] for m in api.get("/api/profiles").json()[0]["modules"]}
    assert states == {"budget": "ready", "assets": "ready", "loans": "ready", "investments": "empty"}


# --------------------------------------------------------------------------- #
# Legacy aliases and the default profile
# --------------------------------------------------------------------------- #

def test_legacy_read_before_any_profile_creates_nothing(api_empty):
    assert api_empty.get("/api/summary").json()["networth"] == {}
    assert api_empty.get("/api/accounts").json() == []
    assert api_empty.get("/api/profiles").json() == []  # the wizard still shows


def test_legacy_write_creates_the_default_profile(api_empty):
    r = api_empty.post("/api/cash/expense", json={
        "amount": 12.5, "title": "Targ Test", "category": "groceries", "date": "2026-09-01",
    })
    assert r.json()["ok"] is True
    (p,) = api_empty.get("/api/profiles").json()
    assert p["slug"] == "default" and p["name"] == "Domyślny"
    assert [m["id"] for m in p["modules"] if m["enabled"]] == ["budget", "assets", "loans"]
    assert api_empty.get("/api/p/default/cash").json()["balance"] == -12.5


def test_legacy_aliases_equal_the_default_profile(api):
    for path in PROFILE_GETS:
        if path.startswith(LEGACY_LESS):
            continue
        assert api.get(f"/api{path}").json() == api.get(f"/api/p/default{path}").json(), path


def test_every_profile_route_is_in_the_isolation_list():
    """A new profile-scoped GET route must be added to PROFILE_GETS."""
    templates = {
        path.removeprefix("/api/p/{slug}")
        for path, ops in app.openapi()["paths"].items()
        if path.startswith("/api/p/{slug}/") and "get" in ops
    }
    covered = {re.sub(r"/category/[^/]+/", "/category/{key}/", p.split("?")[0]) for p in PROFILE_GETS}
    covered = {re.sub(r"/modules/[^/]+/setup", "/modules/{module_id}/setup", p) for p in covered}
    assert templates <= covered, templates - covered


# --------------------------------------------------------------------------- #
# Isolation
# --------------------------------------------------------------------------- #

def test_two_profiles_with_the_same_ibans_do_not_leak(api):
    reference = _snapshot(api, "default")
    marta = api.post("/api/profiles", json={
        "name": "Marta", "modules": ["budget", "assets", "loans"],
    }).json()["slug"]

    # an empty second profile sees nothing of the first
    empty = _snapshot(api, marta)
    assert empty["/networth"]["totals"] == {} and empty["/networth"]["accounts"] == []
    assert empty["/accounts"] == [] and empty["/cashflow"] == [] and empty["/loans"] == []
    assert empty["/summary"]["networth"] == {} and empty["/recurring"]["items"] == []
    assert empty["/cash"]["exists"] is False and empty["/loan"] == {"has_loan": False}
    assert empty["/networth/series"]["points"] == []
    assert empty["/category/groceries/transactions"] == [] and empty["/uncategorized"] == []
    assert _snapshot(api, "default") == reference

    # same household, same account numbers, in the second profile
    with get_session() as s:
        seed_demo(s, profile_id=_profile_id(marta))
    assert _snapshot(api, "default") == reference
    assert _snapshot(api, marta) == reference
    # same IBAN, two accounts (one per profile)
    with get_session() as s:
        from finanse.models import Account

        rows = s.exec(select(Account).where(Account.iban == IBAN_MAIN)).all()
        assert sorted(a.profile_id for a in rows) == sorted(
            [_profile_id("default"), _profile_id(marta)]
        )


def test_writes_through_one_profile_never_touch_another(api):
    marta = api.post("/api/profiles", json={"name": "Marta", "modules": ["budget"]}).json()["slug"]
    with get_session() as s:
        seed_demo(s, profile_id=_profile_id(marta))
    before = _snapshot(api, "default")

    default_txn = api.get("/api/p/default/category/groceries/transactions").json()[0]["id"]
    r = api.post(f"/api/p/{marta}/transactions/{default_txn}/category", json={"category": "fuel"})
    assert r.json() == {"ok": False}
    default_cash = api.get("/api/p/default/cash").json()["transactions"][0]["id"]
    assert api.delete(f"/api/p/{marta}/cash/transaction/{default_cash}").json() == {"ok": False}

    # a merchant rule learned in one profile applies to that profile only
    r = api.post(f"/api/p/{marta}/merchant-category",
                 json={"merchant_key": "BIEDRONKA 123 TEST", "category": "fuel"})
    assert r.json()["updated"] == 8
    marta_sep = {x["category"]: x["amount"] for x in
                 api.get(f"/api/p/{marta}/spending?year=2026&month=9").json()}
    default_sep = {x["category"]: x["amount"] for x in before["/spending?year=2026&month=9"]}
    assert marta_sep["groceries"] == 40.0  # only the cash-pool spend is still groceries
    assert marta_sep["fuel"] == pytest.approx(
        default_sep["fuel"] + default_sep["groceries"] - 40.0
    )
    api.post(f"/api/p/{marta}/cash/expense",
             json={"amount": 99, "title": "Tylko Marta", "category": "dining", "date": "2026-09-20"})
    with get_session() as s:
        from finanse.modules.budget.service import categorize_all

        categorize_all(s, profile_id=_profile_id("default"))  # re-run: default keeps its rules
    assert _snapshot(api, "default") == before
    marta_cash = api.get(f"/api/p/{marta}/cash").json()
    assert any(t["title"] == "Tylko Marta" for t in marta_cash["transactions"])


def test_own_ibans_are_per_profile(session):
    """A transfer to an account of *another* profile is a real outflow here."""
    from finanse.core.accounts import get_or_create_account
    from finanse.modules.budget.analytics import monthly_cashflow
    from finanse.modules.budget.ingestion.normalize import RawTransaction
    from finanse.modules.budget.ingestion.transfers import match_internal_transfers
    from finanse.modules.budget.service import categorize_all, ingest_transactions

    jan = profiles.create_profile(session, name="Jan", modules_=["budget"])
    ola = profiles.create_profile(session, name="Ola", modules_=["budget"])
    jan_acc = get_or_create_account(session, bank="mbank", iban="99114000000000000000000101",
                                    profile_id=jan.id)
    ola_acc = get_or_create_account(session, bank="erste", iban="99109000000000000000000202",
                                    profile_id=ola.id)
    from finanse.models import Source

    ingest_transactions(session, jan_acc, [RawTransaction(
        booking_date=date(2026, 9, 1), amount=Decimal("-500.00"), reference="DLA OLI TEST",
        counterparty_iban="99109000000000000000000202", source=Source.CSV,
    )], source=Source.CSV)
    ingest_transactions(session, ola_acc, [RawTransaction(
        booking_date=date(2026, 9, 1), amount=Decimal("500.00"), reference="OD JANA TEST",
        counterparty_iban="99114000000000000000000101", source=Source.CSV,
    )], source=Source.CSV)
    session.flush()
    assert match_internal_transfers(session, profile_id=jan.id) == 0
    categorize_all(session, profile_id=jan.id)
    categorize_all(session, profile_id=ola.id)
    jan_txn = session.exec(select(Transaction).where(Transaction.account_id == jan_acc.id)).one()
    assert jan_txn.category != "transfer" and not jan_txn.is_internal_transfer
    assert monthly_cashflow(session, profile_id=jan.id)[0].expense == Decimal("500.00")
    assert monthly_cashflow(session, profile_id=ola.id)[0].income == Decimal("500.00")


def test_resync_uses_the_profile_sessions(api, monkeypatch, fake_eb):
    from finanse.config import settings
    from finanse.modules.budget.ingestion.enable_banking import state

    monkeypatch.setattr(type(settings), "eb_configured", property(lambda self: True))
    seen: list[str] = []

    def load(profile, **_kw):
        seen.append(profile)
        return []

    monkeypatch.setattr(state, "load_sessions", load)
    api.post("/api/profiles", json={"name": "Marta", "modules": ["budget"]})
    assert api.post("/api/p/marta/resync").json()["ok"] is False
    assert api.post("/api/resync").json()["ok"] is False
    assert seen == ["marta", "default"]


def test_profiles_table_is_the_only_source_of_slugs(api_empty):
    api_empty.post("/api/profiles", json={"name": "Jan", "modules": []})
    with get_session() as s:
        assert [p.slug for p in s.exec(select(Profile)).all()] == ["jan"]


# --------------------------------------------------------------------------- #
# R-04: the overview / net worth headline uses the profile's base currency
# --------------------------------------------------------------------------- #

def test_a_eur_profile_sees_its_own_net_worth(api_empty):
    from finanse.core.accounts import get_or_create_account, upsert_balance
    from finanse.models import Source

    api = api_empty
    slug = api.post("/api/profiles", json={
        "name": "Anna", "base_currency": "EUR", "modules": ["budget"],
    }).json()["slug"]
    with get_session() as s:
        pid = _profile_id(slug)
        eur = get_or_create_account(s, bank="mbank", iban="99114000000000000000000071",
                                    currency="EUR", profile_id=pid)
        pln = get_or_create_account(s, bank="mbank", iban="99114000000000000000000072",
                                    profile_id=pid)
        upsert_balance(s, eur, date(2026, 9, 30), Decimal("1200.00"), source=Source.CSV)
        upsert_balance(s, pln, date(2026, 9, 30), Decimal("300.00"), source=Source.CSV)

    summary = api.get(f"/api/p/{slug}/summary").json()
    assert summary["breakdown"]["currency"] == "EUR"
    assert summary["breakdown"]["net"] == 1200.0
    # every currency keeps its own total (no conversion, no silent sum)
    assert summary["networth"] == {"EUR": 1200.0, "PLN": 300.0}
    networth = api.get(f"/api/p/{slug}/networth").json()
    assert networth["breakdown"]["currency"] == "EUR"
    assert networth["totals"] == {"EUR": 1200.0, "PLN": 300.0}
    series = api.get(f"/api/p/{slug}/networth/series").json()
    assert series["currency"] == "EUR"
    assert series["points"] and series["points"][-1]["value"] == 1200.0
    explicit = api.get(f"/api/p/{slug}/networth/series?currency=PLN").json()
    assert explicit["currency"] == "PLN" and explicit["points"][-1]["value"] == 300.0
    # a PLN profile is unchanged
    assert api.get("/api/p/" + slug + "/networth/series?currency=EUR").json() == series


def test_system_secret_keys_match_the_frontend_contract(api_empty):
    """R-06: the SPA reads secret presence by the keys listed in `SECRET_KEYS`
    (frontend/src/core/api.ts, which TypeScript enforces for every read); they
    must be exactly the keys `/api/system` sends."""
    from pathlib import Path

    api_ts = Path(__file__).resolve().parents[1] / "frontend" / "src" / "core" / "api.ts"
    m = re.search(r"SECRET_KEYS\s*=\s*\[([^\]]*)\]", api_ts.read_text(encoding="utf-8"))
    assert m, "SECRET_KEYS not found in frontend/src/core/api.ts"
    frontend_keys = set(re.findall(r'"([a-z_]+)"', m.group(1)))
    assert set(api_empty.get("/api/system").json()["secrets"]) == frontend_keys
