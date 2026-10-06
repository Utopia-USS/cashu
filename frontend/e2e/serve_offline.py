"""`finanse serve` for the e2e suite, with the market sources swapped for the synthetic generator of
scripts/demo_data.py, so "Synchronizuj" on Inwestycje (POST /run) and the backfill never touch the network.

Run with FINANSE_DATA_DIR set (the e2e global setup does it); arguments go to `finanse serve`:

    FINANSE_DATA_DIR=<tmp> .venv/bin/python frontend/e2e/serve_offline.py --port 8711

It prints the same one-time `Dashboard: http://127.0.0.1:<port>/#token=...` line as `finanse serve`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _refuse_outbound_http() -> None:
    """Any httpx request to a non-loopback host fails loudly (tests never hit live HTTP)."""
    import httpx

    original = httpx.HTTPTransport.handle_request

    def guarded(self, request):
        if request.url.host not in ("127.0.0.1", "localhost", "::1"):
            raise httpx.ConnectError(f"e2e: outbound HTTP refused ({request.url.host})")
        return original(self, request)

    httpx.HTTPTransport.handle_request = guarded


def main() -> None:
    if not os.environ.get("FINANSE_DATA_DIR"):
        raise SystemExit("FINANSE_DATA_DIR must point at a temporary data dir")
    sys.path.insert(0, str(REPO / "scripts"))
    import demo_data  # scripts/ is not a package

    from finanse.modules.investments.service import daily

    daily.default_sources = demo_data.synthetic_sources  # the backfill reads it from daily too
    _refuse_outbound_http()
    from finanse.cli import app

    sys.argv = ["finanse", "serve", *sys.argv[1:]]
    app()


if __name__ == "__main__":
    main()
