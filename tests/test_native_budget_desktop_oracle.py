"""Actual Python API semantics consumed by the native budget desktop adapters; synthetic fixtures."""


def test_merchant_result_counts_rows_even_when_rule_is_unchanged(api):
    row = api.get("/api/uncategorized").json()[0]
    key = row["merchant_key"]
    for _ in range(2):
        response = api.post("/api/merchant-category", json={"merchant_key": key, "category": "groceries"})
        assert response.status_code == 200
        assert response.json() == {"updated": 1}
    matches = [r for r in api.get("/api/category/groceries/transactions").json() if r["merchant_key"] == key]
    assert len(matches) == 1
    assert api.post(f"/api/transactions/{matches[0]['id']}/category", json={"category": "transport"}).json() == {"ok": True}
    assert api.post("/api/merchant-category", json={"merchant_key": key, "category": "groceries"}).json() == {"updated": 0}
