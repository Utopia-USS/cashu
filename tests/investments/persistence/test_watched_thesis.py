"""Q27: a watched (never held) instrument has the asset panel's two blocks. The watchlist note (why it
is watched) is read in full and edited through ``PATCH /watchlist/{id}``; theses are listed (newest
first), created and updated for it like for a held position, and only within the profile. Synthetic
data only."""

from __future__ import annotations

import pytest
from invp_support import make_profile

NOTE = "Korekta po wynikach, wysoka dywidenda; czekam na stabilizacje kursu. " * 5


@pytest.fixture
def api(api_empty):
    _, slug = make_profile("Inwestor")
    return api_empty, f"/api/p/{slug}/investments"


def watch(client, base: str, note: str | None = NOTE) -> tuple[int, int]:
    r = client.post(f"{base}/watchlist", json={"symbol_or_isin": "VWCE.DE", "note": note})
    assert r.status_code == 201, r.text
    return r.json()["id"], r.json()["instrument"]["id"]


def test_watchlist_note_is_full_and_editable(api):
    client, base = api
    item, _ = watch(client, base)
    row = client.get(f"{base}/watchlist").json()[0]
    assert row["note"] == NOTE.strip()
    assert row["held"] is False

    r = client.patch(f"{base}/watchlist/{item}", json={"note": "  Nowy powod  "})
    assert r.status_code == 200, r.text
    assert r.json()["note"] == "Nowy powod"
    # an empty note clears it, a missing one keeps it
    assert (
        client.patch(f"{base}/watchlist/{item}", json={"tags": ["x"]}).json()["note"]
        == "Nowy powod"
    )
    assert client.patch(f"{base}/watchlist/{item}", json={"note": ""}).json()["note"] is None


def test_watched_instrument_theses_create_list_update(api):
    client, base = api
    _, iid = watch(client, base)
    assert client.get(f"{base}/instruments/{iid}/theses").json() == []

    first = client.post(
        f"{base}/instruments/{iid}/theses",
        json={"entry_type": "sentiment_correction", "thesis": "Pierwsza"},
    )
    assert first.status_code == 201, first.text
    second = client.post(
        f"{base}/instruments/{iid}/theses",
        json={
            "entry_type": "trend",
            "thesis": "Wejscie",
            "invalidation": "Uniewaznienie",
            "exit_plan": "Plan wyjscia",
            "size_plan": "Wielkosc",
        },
    )
    assert second.status_code == 201, second.text

    listed = client.get(f"{base}/instruments/{iid}/theses").json()
    assert [t["id"] for t in listed] == [second.json()["id"], first.json()["id"]]  # newest first
    latest = listed[0]
    assert (latest["thesis"], latest["invalidation"], latest["exit_plan"], latest["size_plan"]) == (
        "Wejscie",
        "Uniewaznienie",
        "Plan wyjscia",
        "Wielkosc",
    )

    r = client.patch(f"{base}/theses/{latest['id']}", json={"exit_plan": "Nowy plan"})
    assert r.status_code == 200, r.text
    assert r.json()["exit_plan"] == "Nowy plan"
    assert r.json()["thesis"] == "Wejscie"
    # the asset detail of a watched instrument carries the same theses
    detail = client.get(f"{base}/positions/{iid}").json()
    assert detail["position"] is None
    assert [t["id"] for t in detail["theses"]] == [t["id"] for t in listed]


def test_watched_theses_and_note_stay_in_the_profile(api):
    client, base = api
    item, iid = watch(client, base)
    client.post(f"{base}/instruments/{iid}/theses", json={"entry_type": "trend", "thesis": "A"})
    _, other_slug = make_profile("Ktos")
    other = f"/api/p/{other_slug}/investments"
    assert client.get(f"{other}/instruments/{iid}/theses").status_code == 404
    r = client.post(
        f"{other}/instruments/{iid}/theses", json={"entry_type": "trend", "thesis": "B"}
    )
    assert r.status_code == 404
    assert client.patch(f"{other}/watchlist/{item}", json={"note": "x"}).status_code == 404
    assert client.get(f"{base}/watchlist").json()[0]["note"] == NOTE.strip()
