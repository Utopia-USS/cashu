"""The Python service exposes API routes without a dashboard fallback."""

from __future__ import annotations


def test_python_service_does_not_serve_legacy_dashboard(api_empty):
    for path in ("/", "/assets/missing.js", "/static/index.html"):
        assert api_empty.get(path).status_code == 404
