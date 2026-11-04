"""Offline Python API oracle for the isolated synthetic native Overview E2E fixture."""

from __future__ import annotations

from datetime import date, timedelta
import json
import os
from pathlib import Path
import sys
import tempfile


def main() -> None:
    root_value = os.environ.get("E2E_ROOT")
    data_value = os.environ.get("CASHU_DATA_DIR")
    if os.environ.get("CASHU_TESTING") != "1" or not root_value or not data_value:
        raise SystemExit("isolated_overview_oracle_required")
    root = Path(root_value).resolve()
    data = Path(data_value).resolve()
    if (not root.is_relative_to(Path(tempfile.gettempdir()).resolve())
            or not root.name.startswith("cashu-e2e-desktop-")
            or data != root / "data"):
        raise SystemExit("isolated_overview_oracle_path_refused")

    # This preflight precedes every normal cashU import in this interpreter.
    from cashu.core import paths
    if paths.data_dir().resolve() != data:
        raise SystemExit("isolated_overview_oracle_data_dir_mismatch")

    from fastapi.testclient import TestClient
    from cashu.api.app import app
    from cashu.core import security

    token = security.generate_token()
    security.configure(token=token, port=8500)
    start_of_month = date.today().replace(day=1)
    months = [
        start_of_month.strftime("%Y-%m"),
        (start_of_month - timedelta(days=1)).strftime("%Y-%m"),
    ]
    with TestClient(
        app,
        base_url="http://127.0.0.1:8500",
        headers={security.TOKEN_HEADER: token},
    ) as client:
        def get(slug: str, path: str):
            response = client.get(f"/api/p/{slug}{path}")
            if response.status_code != 200:
                raise RuntimeError(f"overview oracle endpoint refused: {path}, {response.status_code}")
            return response.json()

        result = {
            "anna": {
                "summary": get("demo-anna", "/summary"),
                "monthCloses": {
                    month: get("demo-anna", f"/budget/month-close?month={month}")
                    for month in months
                },
                "networth": get("demo-anna", "/networth"),
                "assets": get("demo-anna", "/assets/manual"),
                "loans": get("demo-anna", "/loans"),
                "investments": get("demo-anna", "/investments/overview"),
                "positions": get("demo-anna", "/investments/positions"),
                "series": get("demo-anna", "/networth/series?granularity=monthly&scope=total"),
            },
            "piotr": {"summary": get("demo-piotr", "/summary")},
        }
    destination = root / "overview-oracle.json"
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf8") as output:
        json.dump(result, output, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
