"""Generic allocation interface (F7-GB): the overview's allocation says which buckets are generic (GB3);
a drift signal of the owner's own bucket carries ``bucket_generic: false`` (GB2), stays a signal for the
API and the agent, and is skipped by macOS notifications and the weekly digest (GB4)."""

from __future__ import annotations

import datetime as dt

from invp_support import STRATEGY_YAML
from sqlmodel import select
from test_invp_api import client, imported  # noqa: F401 - client is a pytest fixture

from finanse.core.db import get_session
from finanse.core.mcp.server import FinanseMcp
from finanse.core.models import Profile
from finanse.core.worker import investments as inv
from finanse.core.worker import notifications
from finanse.core.worker.notifier import Delivery
from finanse.modules.investments.models import InvNotification, InvSignal
from finanse.modules.investments.service import files

# The synthetic strategy with the owner's own bucket id "core" instead of "stocks", far from its
# target, and an allocation_drift rule (action: notified at once by the default policy).
OWN_BUCKETS = (
    STRATEGY_YAML.replace("id: stocks", "id: core").replace(
        "targets: { stocks: 0.9, cash: 0.1 }", "targets: { core: 0.5, cash: 0.5 }"
    )
    + "  - id: drift\n    kind: allocation_drift\n    severity: action\n"
)


class Recorder:
    name = "fake"

    def __init__(self) -> None:
        self.sent = []

    def send(self, notification) -> Delivery:
        self.sent.append(notification)
        return Delivery(True, self.name)


def _overview(client, slug: str) -> dict:  # noqa: F811 - the client fixture
    r = client.get(f"/api/p/{slug}/investments/overview")
    assert r.status_code == 200, r.text
    return r.json()["allocation"]


def test_allocation_flags_generic_buckets(client):  # noqa: F811
    slug, _ = imported(client)
    alloc = _overview(client, slug)
    assert [(b["bucket_id"], b["generic"]) for b in alloc["buckets"]] == [
        ("stocks", True),
        ("cash", True),
    ]
    assert alloc["buckets_generic"] is True
    stocks = alloc["buckets"][0]
    assert {"weight", "target", "drift_pp", "out_of_band", "band_note", "to_target"} <= set(stocks)

    files.write_text_private(files.strategy_yaml_path(slug), OWN_BUCKETS)
    own = _overview(client, slug)
    assert [(b["bucket_id"], b["generic"]) for b in own["buckets"]] == [
        ("core", False),
        ("cash", True),
    ]
    assert own["buckets_generic"] is False
    assert own["band"] is not None and own["has_strategy"] is True  # old fields unchanged


def test_without_a_strategy_there_are_no_generic_buckets(client):  # noqa: F811
    slug, _ = imported(client, "Bez Strategii", strategy=False)
    alloc = _overview(client, slug)
    assert alloc["buckets"] == [] and alloc["buckets_generic"] is False


def test_own_bucket_drift_is_a_signal_but_never_notified_or_digested(client):  # noqa: F811
    slug, _ = imported(client)
    files.write_text_private(files.strategy_yaml_path(slug), OWN_BUCKETS)
    r = client.post(f"/api/p/{slug}/investments/run", json={})
    assert r.status_code == 200, r.text

    signals = client.get(f"/api/p/{slug}/investments/signals").json()
    drift = {s["payload"]["bucket_id"]: s for s in signals if s["kind"] == "allocation_drift"}
    assert drift["core"]["payload"]["bucket_generic"] is False
    assert drift["cash"]["payload"]["bucket_generic"] is True
    core_id, cash_id = drift["core"]["id"], drift["cash"]["id"]

    with get_session() as s:
        profile = s.exec(select(Profile).where(Profile.slug == slug)).one()
        pid = profile.id
        assert inv.review_count(s, pid) == len(signals) - 1
    # the agent still sees it (MCP unchanged)
    mcp_signals = FinanseMcp(pid).call("signals", {}).data["signals"]
    assert sum(1 for x in mcp_signals if x["kind"] == "allocation_drift") == 2

    fake = Recorder()
    result = notifications.deliver_pending(
        profile, fake, now=dt.datetime.now(dt.UTC), session_factory=get_session
    )
    with get_session() as s:
        channels = {
            n.signal_id: n.channel
            for n in s.exec(select(InvNotification).where(InvNotification.profile_id == pid))
        }
        assert s.get(InvSignal, core_id).status == "active"
    assert channels[core_id] == "skipped:hidden"
    assert channels[cash_id] in ("fake", "fake:summary")
    assert result.skipped == 1 and result.failed == 0
    assert all("Koszyk core" not in n.message for n in fake.sent)

    digest = client.get(f"/api/p/{slug}/investments/review-digest").json()
    listed = [s["id"] for s in digest["signals"]["new"]]
    assert cash_id in listed and core_id not in listed
    assert digest["signals"]["open"] == len(signals) - 1
    assert all(e.get("signal_id") != core_id for e in digest["events"])


def test_drift_rows_stored_before_the_key_get_it_on_read(client):  # noqa: F811
    slug, _ = imported(client)
    with get_session() as s:
        pid = s.exec(select(Profile).where(Profile.slug == slug)).one().id
        s.add(
            InvSignal(
                profile_id=pid,
                rule_id="drift",
                kind="allocation_drift",
                dedup_key="drift|s:active",
                severity="info",
                status="active",
                message="Koszyk active powyżej celu",
                payload={"bucket_id": "active", "drift_pp": 9.0},
            )
        )
    (row,) = [
        x
        for x in client.get(f"/api/p/{slug}/investments/signals").json()
        if x["kind"] == "allocation_drift"
    ]
    assert row["payload"] == {"bucket_id": "active", "drift_pp": 9.0, "bucket_generic": False}
    with get_session() as s:
        assert inv.review_count(s, pid) == 0  # hidden from the weekly digest too


# GB5: one own bucket with the largest drift, two generic ones (gold empty: 10 pp under target).
THREE = (
    STRATEGY_YAML.replace("id: stocks", "id: core")
    .replace("targets: { stocks: 0.9, cash: 0.1 }", "targets: { core: 0.3, cash: 0.6, gold: 0.1 }")
    .replace(
        "  - id: cash\n    match: { asset_class: cash }\n",
        "  - id: cash\n    match: { asset_class: cash }\n"
        "  - id: gold\n    match: { asset_class: commodity }\n",
    )
    + "  - id: drift\n    kind: allocation_drift\n    severity: action\n"
)
OWN_ONLY = (
    STRATEGY_YAML.replace("id: stocks", "id: core")
    .replace("id: cash", "id: reserve")
    .replace("targets: { stocks: 0.9, cash: 0.1 }", "targets: { core: 0.3, reserve: 0.7 }")
)


def _expected(rows: list[dict], buckets: list[dict]) -> dict:
    """The KPI numbers computed from the given open signals and allocation rows."""
    top = max(buckets, key=lambda b: abs(b["drift_pp"]), default=None)
    return {
        "signals": {
            "action": sum(r["severity"] == "action" for r in rows),
            "info": sum(r["severity"] == "info" for r in rows),
            "new": sum(r["status"] == "active" for r in rows),
        },
        "polarity": {
            p: sum(r["polarity"] == p for r in rows) for p in ("positive", "negative", "neutral")
        },
        "max_drift": None if top is None else top["bucket_id"],
        "out_of_band": sum(1 for b in buckets if b["out_of_band"]),
    }


def test_owner_kpis_leave_out_own_buckets_and_mcp_keeps_them(client):  # noqa: F811
    slug, _ = imported(client)
    files.write_text_private(files.strategy_yaml_path(slug), THREE)
    assert client.post(f"/api/p/{slug}/investments/run", json={}).status_code == 200
    ov = client.get(f"/api/p/{slug}/investments/overview").json()
    k, buckets = ov["kpis"], ov["allocation"]["buckets"]
    assert [(b["bucket_id"], b["generic"], b["out_of_band"]) for b in buckets] == [
        ("core", False, True),
        ("cash", True, True),
        ("gold", True, True),
    ]
    rows = client.get(f"/api/p/{slug}/investments/signals").json()
    drift = {r["payload"]["bucket_id"] for r in rows if r["kind"] == "allocation_drift"}
    assert drift == {"core", "cash", "gold"}
    shown = [r for r in rows if r["payload"].get("bucket_generic") is not False]

    owner = _expected(shown, [b for b in buckets if b["generic"]])
    assert k["signals"] == owner["signals"]
    assert k["polarity"] == owner["polarity"]
    assert k["max_drift"]["bucket_id"] == owner["max_drift"] == "cash"
    assert k["out_of_band"] == owner["out_of_band"] == 2
    assert k["signals"]["action"] == len(rows) - 1  # every signal here is "action"; core left out

    # MCP: every signal and bucket, as before GB5
    with get_session() as s:
        pid = s.exec(select(Profile).where(Profile.slug == slug)).one().id
    data = FinanseMcp(pid).call("portfolio_overview", {}).data
    agent = _expected(rows, buckets)
    assert data["signals"] == agent["signals"]
    assert data["max_drift"]["bucket"] == agent["max_drift"] == "core"
    assert data["out_of_band"] == agent["out_of_band"] == 3
    assert [b["bucket"] for b in data["buckets"]] == ["core", "cash", "gold"]


def test_no_generic_bucket_means_no_max_drift_for_the_owner(client):  # noqa: F811
    slug, _ = imported(client, "Tylko Moje")
    files.write_text_private(files.strategy_yaml_path(slug), OWN_ONLY)
    assert client.post(f"/api/p/{slug}/investments/run", json={}).status_code == 200
    ov = client.get(f"/api/p/{slug}/investments/overview").json()
    assert ov["allocation"]["buckets_generic"] is False
    assert [b["out_of_band"] for b in ov["allocation"]["buckets"]] == [True, True]
    k = ov["kpis"]
    assert k["max_drift"] is None and k["out_of_band"] == 0
    with get_session() as s:
        pid = s.exec(select(Profile).where(Profile.slug == slug)).one().id
    data = FinanseMcp(pid).call("portfolio_overview", {}).data
    assert data["max_drift"]["bucket"] in ("core", "reserve") and data["out_of_band"] == 2
