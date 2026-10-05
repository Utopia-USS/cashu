"""allocation_drift payloads say whether the bucket is generic (F7-GB GB2), and the helpers that keep a
non-generic bucket out of notifications and the weekly digest."""

from __future__ import annotations

from rules_fixtures import alloc, candidate, context, h, instrument, portfolio, run

from finanse.modules.investments.domain import AssetClass
from finanse.modules.investments.rules import AllocationDriftParams, AllocationDriftRule, Fired
from finanse.modules.investments.rules.kinds.allocation_drift import (
    drift_bucket_generic,
    hidden_from_owner,
    with_bucket_generic,
)

ETF = instrument("VWCE", asset_class=AssetClass.ETF)


def test_payload_carries_bucket_generic():
    ctx = context(
        portfolio_value=portfolio([h(ETF, value="100000")]),
        allocations=[
            alloc("core", weight=0.78, target=0.70),
            alloc("bonds", weight=0.22, target=0.30),
        ],
    )
    outcomes = run(AllocationDriftRule(), ctx, AllocationDriftParams())
    assert all(isinstance(o, Fired) for o in outcomes)
    core, bonds = (candidate(o).payload for o in outcomes)
    assert (core["bucket_id"], core["bucket_generic"]) == ("core", False)
    assert (bonds["bucket_id"], bonds["bucket_generic"]) == ("bonds", True)
    assert core["direction"] == "overweight"  # the other payload keys are unchanged
    assert set(core) - {"bucket_generic", "direction"} == {
        "bucket_id",
        "weight",
        "target",
        "drift_pp",
        "drift_rel",
        "value_base",
        "drift_value_base",
        "currency",
        "absolute_band_pp",
        "relative_band",
        "min_trade_value",
    }


def test_rows_stored_before_the_key_derive_it_from_the_bucket_id():
    assert drift_bucket_generic({"bucket_id": "cash"}) is True
    assert drift_bucket_generic({"bucket_id": "active"}) is False
    assert drift_bucket_generic({"bucket_id": "active", "bucket_generic": True}) is True
    assert drift_bucket_generic({}) is True and drift_bucket_generic(None) is True
    assert with_bucket_generic("allocation_drift", {"bucket_id": "core"}) == {
        "bucket_id": "core",
        "bucket_generic": False,
    }
    stored = {"bucket_id": "core", "bucket_generic": False}
    assert with_bucket_generic("allocation_drift", stored) is stored
    other = {"bucket_id": "core"}
    assert with_bucket_generic("custom", other) is other
    assert with_bucket_generic("allocation_drift", None) is None


def test_only_non_generic_drift_signals_are_hidden_from_the_owner():
    assert hidden_from_owner("allocation_drift", {"bucket_id": "core", "bucket_generic": False})
    assert hidden_from_owner("allocation_drift", {"bucket_id": "core"})  # stored before the key
    assert not hidden_from_owner("allocation_drift", {"bucket_id": "cash", "bucket_generic": True})
    # custom bucket rules and bucket alerts stay as they are (only allocation_drift is filtered)
    assert not hidden_from_owner("custom", {"bucket_id": "core"})
    assert not hidden_from_owner("alert:weight_below", {"bucket_id": "core"})
