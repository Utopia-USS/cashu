"""The investments API end to end: profile with investments, brokerage account, multipart import
preview + commit, rules run (fake sources), overview / positions / signals, decisions, theses,
classification, manual valuations, strategy, reconciliation; the token middleware."""

from __future__ import annotations

import pytest
from invp_support import AS_OF, STRATEGY_YAML, canonical_csv, sources

from cashu.core import security
from cashu.modules.investments.service import daily, files, portfolio


@pytest.fixture
def client(api_empty, monkeypatch):
    monkeypatch.setattr(daily, "default_sources", lambda: sources())
    monkeypatch.setattr(portfolio, "today", lambda: AS_OF)
    return api_empty


def setup_profile(client, name: str = "Jan Inwestor") -> tuple[str, int]:
    r = client.post("/api/profiles", json={"name": name, "modules": ["investments"]})
    assert r.status_code == 201, r.text
    slug = r.json()["slug"]
    r = client.post(
        f"/api/p/{slug}/investments/accounts",
        json={"name": "DIF", "broker": "dif", "wrapper": "regular"},
    )
    assert r.status_code == 201, r.text
    return slug, r.json()["id"]


def upload(client, slug: str, account_id: int, content: bytes, name: str = "history.csv") -> dict:
    r = client.post(
        f"/api/p/{slug}/investments/import/preview",
        files={"file": (name, content, "text/csv")},
        data={"account_id": str(account_id)},
    )
    assert r.status_code == 200, r.text
    return r.json()


def commit(client, slug: str, account_id: int, preview: dict, **extra) -> dict:
    r = client.post(
        f"/api/p/{slug}/investments/import/commit",
        json={
            "file_id": preview["file_id"],
            "file_name": preview["file_name"],
            "account_id": account_id,
            **extra,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def imported(client, name: str = "Jan Inwestor", *, strategy: bool = True) -> tuple[str, int]:
    slug, aid = setup_profile(client, name)
    commit(client, slug, aid, upload(client, slug, aid, canonical_csv()))
    if strategy:
        files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    return slug, aid


def test_token_is_required(client):
    slug, _ = setup_profile(client)
    bare = client.get(
        f"/api/p/{slug}/investments/overview", headers={security.TOKEN_HEADER: "nope"}
    )
    assert bare.status_code == 401


def test_preview_and_commit_flow(client):
    slug, aid = setup_profile(client)
    preview = upload(client, slug, aid, canonical_csv(xmpl_quantity=25))
    assert preview["can_commit"] and preview["importer"]["id"] == "cashu"
    assert preview["counts"] == {
        "rows": 5,
        "new": 5,
        "duplicates": 0,
        "positions": 3,
        "renames": 0,
        "status_changes": 0,
        "new_instruments": 3,
        "warnings": 1,
        "errors": 0,
    }
    assert [r["status"] for r in preview["rows"]] == ["new"] * 5
    assert preview["rows"][1]["instrument"]["new"] is True
    rec = preview["reconciliation"]
    (mismatch,) = [d for d in rec["diffs"] if d["kind"] != "match"]
    assert (mismatch["label"], mismatch["delta"], mismatch["correction"]["type"]) == (
        "XMPL",
        5.0,
        "adjustment",
    )

    done = commit(client, slug, aid, preview, corrections=[mismatch["instrument_id"]])
    assert (done["inserted"], done["corrections"], len(done["new_instrument_ids"])) == (5, 1, 3)
    # the staged upload is gone; committing it again is a 404
    r = client.post(
        f"/api/p/{slug}/investments/import/commit",
        json={"file_id": preview["file_id"], "file_name": preview["file_name"], "account_id": aid},
    )
    assert r.status_code == 404
    again = upload(client, slug, aid, canonical_csv(xmpl_quantity=25))
    assert again["counts"]["duplicates"] == 5 and again["previous_imports"]
    batches = client.get(f"/api/p/{slug}/investments/imports").json()
    assert [(b["inserted"], b["corrections"]) for b in batches] == [(5, 1)]
    rec = client.get(f"/api/p/{slug}/investments/reconciliation").json()
    assert rec[0]["account_id"] == aid and rec[0]["mismatches"] == 0


def test_raw_body_preview_and_errors(client):
    slug, aid = setup_profile(client)
    r = client.post(
        f"/api/p/{slug}/investments/import/preview?account_id={aid}&filename=h.csv",
        content=canonical_csv(),
        headers={"content-type": "text/csv"},
    )
    assert r.status_code == 200 and r.json()["counts"]["new"] == 5
    assert (
        client.post(
            f"/api/p/{slug}/investments/import/preview?account_id=999&filename=h.csv",
            content=canonical_csv(),
            headers={"content-type": "text/csv"},
        ).status_code
        == 404
    )
    bad = upload(client, slug, aid, b"a,b\n1,2\n", name="x.csv")
    assert not bad["can_commit"] and bad["errors"][0]["kind"] == "file_format"
    r = client.post(
        f"/api/p/{slug}/investments/import/commit",
        json={"file_id": bad["file_id"], "file_name": "x.csv", "account_id": aid},
    )
    assert r.status_code == 422
    r = client.post(
        f"/api/p/{slug}/investments/import/commit",
        json={"file_id": "../../etc", "file_name": "x.csv", "account_id": aid},
    )
    assert r.status_code == 422


def test_run_overview_positions_signals(client):
    slug, aid = imported(client)
    r = client.post(f"/api/p/{slug}/investments/run", json={})
    assert r.status_code == 200, r.text
    (run,) = r.json()["profiles"]
    assert run["status"] == "ok" and [s["rule_id"] for s in run["new_signals"]] == ["concentration"]

    ov = client.get(f"/api/p/{slug}/investments/overview").json()
    k = ov["kpis"]
    assert ov["base_currency"] == "PLN" and k["value"]["total"] == 21459.0
    assert k["value"]["cash"] == pytest.approx(2729.0)  # 2695 PLN + 8.5 USD x 4.0
    assert k["unrealized"]["cost"] == pytest.approx(5005 + 4300 + 8000)
    assert k["signals"] == {"action": 1, "info": 0, "new": 1}
    assert k["last_run"]["status"] == "ok"
    alloc = ov["allocation"]
    assert [b["bucket_id"] for b in alloc["buckets"]] == ["stocks", "cash"]
    stocks = alloc["buckets"][0]
    assert stocks["target"] == 0.9 and stocks["out_of_band"] is False  # 87.3 % vs 90 %, inside 5 pp
    assert ov["freshness"]["prices"]["newest_bar"] == AS_OF.isoformat()
    assert ov["freshness"]["strategy"]["state"] == "valid"
    assert ov["accounts"][0]["id"] == aid and ov["accounts"][0]["value"] == 21459.0

    pos = client.get(f"/api/p/{slug}/investments/positions").json()
    labels = [p["instrument"]["label"] for p in pos["positions"]]
    assert labels == ["XMPL", "ABC", "WRLD"]  # by value
    xmpl = pos["positions"][0]
    assert xmpl["value"] == 8000.0 and xmpl["open_signals"] == 1 and xmpl["bucket"] == "stocks"
    assert xmpl["lots"][0]["quantity"] == 20.0 and xmpl["accounts"][0]["account_id"] == aid
    assert xmpl["dividends"] == {"USD": 8.5}
    detail = client.get(f"/api/p/{slug}/investments/positions/{xmpl['instrument']['id']}").json()
    assert detail["series"] and detail["high_52w"] == 100.0 and len(detail["transactions"]) == 2

    filtered = client.get(f"/api/p/{slug}/investments/overview?accounts={aid}").json()
    assert filtered["kpis"]["value"]["total"] == 21459.0
    assert client.get(f"/api/p/{slug}/investments/overview?accounts=999").status_code == 404

    signals = client.get(f"/api/p/{slug}/investments/signals").json()
    (sig,) = signals
    assert sig["severity"] == "action" and sig["instrument_label"] == "XMPL"
    r = client.post(
        f"/api/p/{slug}/investments/signals/{sig['id']}/decision",
        json={"action": "held", "reason": "Long-term position", "quantity": "0"},
    )
    assert r.status_code == 201 and r.json()["signal"]["status"] == "acknowledged"
    assert (
        client.post(
            f"/api/p/{slug}/investments/signals/{sig['id']}/decision", json={"action": "nope"}
        ).status_code
        == 422
    )
    r = client.post(f"/api/p/{slug}/investments/signals/{sig['id']}/acknowledge", json={})
    assert r.status_code == 200
    journal = client.get(f"/api/p/{slug}/investments/decisions").json()
    assert [d["action"] for d in journal] == ["held", "held"]
    assert client.get(f"/api/p/{slug}/investments/signals?status=history").json() == []
    runs = client.get(f"/api/p/{slug}/investments/runs").json()
    assert runs[0]["status"] == "ok" and runs[0]["new_signal_ids"] == [sig["id"]]


def test_run_busy_is_409(client):
    from cashu.core import locks

    slug, _ = imported(client)
    with locks.run_lock(daily.LOCK_NAME):
        assert client.post(f"/api/p/{slug}/investments/run", json={}).status_code == 409


def test_theses_classification_manual_valuations(client):
    slug, _ = imported(client)
    unclassified = client.get(f"/api/p/{slug}/investments/instruments?unclassified=true").json()
    assert {i["label"] for i in unclassified} == {"ABC", "WRLD", "XMPL"}
    wrld = next(i for i in unclassified if i["label"] == "WRLD")
    r = client.patch(
        f"/api/p/{slug}/investments/instruments/{wrld['id']}",
        json={
            "asset_class": "etf",
            "tags": ["global_equity"],
            "region": "global",
            "aliases": [{"namespace": "yahoo", "value": "WRLD.DE"}],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["needs_classification"] is False and body["tags"] == ["global_equity"]
    assert {"namespace": "yahoo", "value": "WRLD.DE", "guessed": False} in body["aliases"]
    assert (
        client.patch(
            f"/api/p/{slug}/investments/instruments/{wrld['id']}", json={"asset_class": "stonks"}
        ).status_code
        == 422
    )
    assert client.patch(f"/api/p/{slug}/investments/instruments/99999", json={}).status_code == 404

    base = f"/api/p/{slug}/investments/instruments/{wrld['id']}/theses"
    r = client.post(
        base,
        json={
            "entry_type": "trend",
            "thesis": "Global growth",
            "invalidation": "Below the 200-day average",
            "exit_plan": "Rebalance",
            "size_plan": "10 %",
        },
    )
    assert r.status_code == 201, r.text
    thesis = r.json()
    assert client.post(base, json={"entry_type": "hunch", "thesis": "x"}).status_code == 422
    assert client.post(base, json={"entry_type": "trend"}).status_code == 422
    r = client.patch(
        f"/api/p/{slug}/investments/theses/{thesis['id']}",
        json={"exit_plan": "Sell above 150", "reviewed": True},
    )
    assert r.json()["exit_plan"] == "Sell above 150" and r.json()["reviewed_at"]
    assert r.json()["thesis"] == "Global growth"
    assert [t["id"] for t in client.get(base).json()] == [thesis["id"]]
    assert client.delete(f"/api/p/{slug}/investments/theses/{thesis['id']}").status_code == 200
    assert client.get(base).json() == []

    r = client.post(
        f"/api/p/{slug}/investments/manual-valuations",
        json={"instrument_id": wrld["id"], "unit_value": "120", "as_of": "2026-02-27"},
    )
    assert r.status_code == 201 and r.json()["currency"] == "EUR"
    assert (
        client.post(
            f"/api/p/{slug}/investments/manual-valuations",
            json={"instrument_id": wrld["id"], "unit_value": "-1"},
        ).status_code
        == 422
    )
    assert len(client.get(f"/api/p/{slug}/investments/manual-valuations").json()) == 1


def test_strategy_endpoints(client):
    slug, _ = setup_profile(client)
    st = client.get(f"/api/p/{slug}/investments/strategy").json()
    assert st["state"] == "missing" and st["versions"] == []
    r = client.post(f"/api/p/{slug}/investments/strategy/init", json={"template": "passive_etf"})
    assert r.status_code == 201 and r.json()["status"]["state"] == "valid"
    assert client.post(f"/api/p/{slug}/investments/strategy/init", json={}).status_code == 409
    assert (
        client.post(
            f"/api/p/{slug}/investments/strategy/init", json={"template": "yolo"}
        ).status_code
        == 422
    )
    reloaded = client.post(f"/api/p/{slug}/investments/strategy/reload").json()
    assert reloaded["version"] == 1 and reloaded["changed"] is False
    assert reloaded["facts"]["buckets"] == ["global_equity", "bond_etfs", "treasury_bonds", "cash"]
    path = files.strategy_yaml_path(slug)
    path.write_text(path.read_text().replace("kind: allocation_drift", "kind: allocation_drif"))
    st = client.get(f"/api/p/{slug}/investments/strategy").json()
    assert st["state"] == "partial" and st["changed"] is True
    (inactive,) = st["inactive_rules"]
    assert inactive["rule_id"] == "rebalance_check" and inactive["line"]
    issue = inactive["issues"][0]
    assert issue["path"] == "rules[0].kind" and issue["line"] and issue["column"]


def test_accounts_endpoint(client):
    slug, aid = setup_profile(client)
    rows = client.get(f"/api/p/{slug}/investments/accounts").json()
    assert rows == [
        {
            "id": aid,
            "name": "DIF",
            "broker": "dif",
            "broker_name": "DIF Broker",
            "wrapper": "regular",
            "currency": "PLN",
            "importer": None,
            "has_mapping": False,
            "active": True,
            "value": None,
            "share": None,
            "snapshot_date": None,
            "last_import": None,
        }
    ]
    assert (
        client.post(
            f"/api/p/{slug}/investments/accounts", json={"name": "dif", "broker": "dif"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/p/{slug}/investments/accounts", json={"name": "X", "broker": "mbank"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/p/{slug}/investments/accounts",
            json={"name": "X", "broker": "xtb", "wrapper": "ike", "currency": "eur"},
        ).status_code
        == 201
    )
    setup = client.get(f"/api/p/{slug}/modules/investments/setup").json()
    assert [s["status"] for s in setup["steps"]] == ["done", "on", "todo", "todo"]
    assert (
        setup["steps"][1]["actions"][0]["target"]
        == f"cashu --profile {slug} invest strategy init"
    )
