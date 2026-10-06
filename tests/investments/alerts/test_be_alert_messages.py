"""Alert signal messages as stable code + params (F6): every kind maps its payload facts; rule
signals get no code."""

from __future__ import annotations

from cashu.modules.investments.alerts.messages import alert_message


def test_rule_signals_have_no_code():
    assert alert_message("allocation_drift", {"bucket_id": "stocks"}, "m") == (None, None)


def test_change_pct_carries_direction_and_size():
    payload = {
        "title": "Big move",
        "symbol": "EXA",
        "change": -0.123,
        "threshold": 0.1,
        "direction": "any",
        "window_days": 5,
        "from_close": "10",
        "from_date": "2026-02-23",
        "close": "8.77",
        "price_date": "2026-03-02",
    }
    code, params = alert_message(
        "alert:change_pct",
        payload,
        "Big move: EXA: -12,3\u00a0% w 5 sesji (10 2026-02-23 -> 8,77 2026-03-02).",
    )
    assert code == "alert.change_pct"
    assert params == {
        "title": "Big move",
        "label": "EXA",
        "window_days": 5,
        "from_close": "10",
        "from_date": "2026-02-23",
        "close": "8.77",
        "date": "2026-03-02",
        "threshold": 0.1,
        "direction": "down",
        "change": 0.123,
    }


def test_weight_custom_and_profile_label():
    code, params = alert_message(
        "alert:weight_above",
        {"title": "Too much", "bucket_id": "stocks", "weight": 0.7, "threshold": 0.6},
        "Too much: Koszyk stocks: 70,0\u00a0% portfela (powyżej 60,0\u00a0%).",
    )
    assert code == "alert.weight_above"
    assert params == {
        "title": "Too much",
        "label": None,
        "weight": 0.7,
        "threshold": 0.6,
        "bucket_id": "stocks",
        "subject": "bucket",
    }
    _code, params = alert_message(
        "alert:weight_below",
        {"title": "Small", "symbol": "EXA", "weight": 0.0, "threshold": 0.05, "held": False},
        "Small: EXA: 0,0\u00a0% portfela (poniżej 5,0\u00a0%).",
        label="EXA profile view",
    )
    assert params["subject"] == "instrument" and params["label"] == "EXA profile view"
    assert params["held"] is False
    code, params = alert_message(
        "alert:custom",
        {"title": "Mine"},
        "Mine: Warunek spełniony: cash_weight > 15% (cash_weight 20,0\u00a0%).",
    )
    assert code == "alert.custom"
    assert params["detail"] == "Warunek spełniony: cash_weight > 15% (cash_weight 20,0\u00a0%)."
