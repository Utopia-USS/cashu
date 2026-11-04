"""Actual Python async-family MCP paths, isolated stores and real public-source MockTransport."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/mcp/src/tools/fixtures/investmentAsync.json"
NOW = dt.datetime(2026, 11, 1, 12, 0, 0, 123000, tzinfo=dt.UTC)
YAML = "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n"


def generate(root: Path, privacy_mode: str):
    root = root.resolve()
    os.environ.update(
        HOME=str(root / "home"),
        CASHU_DATA_DIR=str(root / "data"),
        CASHU_TESTING="1",
        CASHU_AUTO_DAILY="0",
        CASHU_PRICE_REFRESH="0",
        CASHU_LANG="pl",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_LEGACY_DATA_DIR=str(root / "legacy"),
        CASHU_LAUNCH_AGENTS_DIR=str(root / "LaunchAgents"),
        CASHU_APP_BUNDLE="none",
        CASHU_DATABASE_URL=f"sqlite:///{root / 'data' / 'cashu.db'}",
        PYTHON_KEYRING_BACKEND="keyring.backends.fail.Keyring",
    )
    # Environment isolation is established BEFORE any actual cashu application import.
    sys.path.insert(0, str(REPO / "parity/python/oracle/tests/investments/persistence"))
    import httpx
    from invp_support import HEADER, add_account, make_profile

    from cashu.core import paths
    from cashu.core.db import get_session, init_db
    from cashu.core.mcp.redaction import Redactor, leak_check
    from cashu.core.mcp.registry import ToolContext
    from cashu.core.mcp.tools import alerts as tools
    from cashu.core.mcp.tools import investments_proposals as proposals
    from cashu.core.profiles import Profile
    from cashu.modules.investments.market import MarketHttp, YahooPriceSource
    from cashu.modules.investments.market.search import YahooSymbolSearch
    from cashu.modules.investments.service import files, instrument_search, portfolio, watchlist

    assert watchlist and paths.data_dir().resolve() == root / "data"
    for name, module in list(sys.modules.items()):
        if name.startswith("cashu.") and hasattr(module, "utcnow"):
            module.utcnow = lambda: NOW
    portfolio.today = lambda: NOW.date()
    init_db()
    calls = {"search": 0, "chart": 0}
    timestamps = [
        int(dt.datetime(2026, 10, 10, tzinfo=dt.UTC).timestamp()) + i * 86400 for i in range(22)
    ]

    def respond(request):
        if "/search" in request.url.path:
            calls["search"] += 1
            return httpx.Response(
                200,
                json={
                    "quotes": [
                        {
                            "symbol": "ABC.WA",
                            "shortname": "Synthetic Public",
                            "quoteType": "EQUITY",
                            "exchange": "WSE",
                        }
                    ]
                },
            )
        if "/chart/" in request.url.path:
            calls["chart"] += 1
            symbol = request.url.path.rsplit("/", 1)[-1]
            return httpx.Response(
                200,
                json={
                    "chart": {
                        "result": [
                            {
                                "meta": {
                                    "symbol": symbol,
                                    "currency": "PLN",
                                    "instrumentType": "EQUITY",
                                    "longName": "Synthetic Public",
                                    "exchangeName": "WSE",
                                },
                                "timestamp": timestamps,
                                "indicators": {"quote": [{"close": list(range(100, 122))}]},
                            }
                        ],
                        "error": None,
                    }
                },
            )
        raise AssertionError("unexpected synthetic public resource")

    def sources():
        client = httpx.Client(transport=httpx.MockTransport(respond))
        http = MarketHttp(client, max_retries=0)
        return instrument_search.SearchSources(
            YahooSymbolSearch(http), chart=YahooPriceSource(http), close=client.close
        )

    instrument_search.default_sources = sources
    output = {}
    content = (
        HEADER + "\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n"
    ).encode()
    valid = root / "synthetic.csv"
    valid.write_bytes(content)
    invalid = root / "blocked.csv"
    invalid.write_bytes(b"not an export\n")
    for privacy in (privacy_mode,):
        instrument_search.clear_cache()
        pid, slug = make_profile(f"Anna Nowak {privacy}")
        aid = add_account(pid, name="Synthetic broker")
        files.write_text_private(files.strategy_yaml_path(slug), YAML)
        with get_session() as session:
            profile = session.get(Profile, pid)
            assert profile
            responses, refs = {}, {}

            def call(
                label, fn, *args, _profile=profile, _privacy=privacy, _responses=responses, **kwargs
            ):
                ctx = ToolContext(session, _profile, _privacy, NOW.date())
                tree = fn(ctx, *args, **kwargs)
                redactor = Redactor(_privacy, ctx.guard)
                result = redactor.apply(tree)
                leak_check(
                    result,
                    strict=redactor.strict,
                    isins=redactor.isins,
                    non_money=redactor.non_money,
                )
                _responses[label] = result
                return result

            call("search_remote", tools.search_instruments, "ABC")
            added = call("watch_public", tools.add_to_watchlist, "ABC.WA")
            refs[("instrument_id", added["item"]["instrument"]["instrument_id"])] = (
                "instrument_public"
            )
            refs[("item_id", added["item"]["item_id"])] = "watch_public"
            call("search_local", tools.search_instruments, "ABC")
            private = call(
                "watch_private",
                tools.add_to_watchlist,
                "PRIV",
                name="Synthetic Private Owner",
                currency="PLN",
                note="Synthetic Private Owner",
            )
            refs[("instrument_id", private["item"]["instrument"]["instrument_id"])] = (
                "instrument_private"
            )
            refs[("item_id", private["item"]["item_id"])] = "watch_private"
            numeric = call("watch_numeric", tools.add_to_watchlist, "1234.WA")
            refs[("instrument_id", numeric["item"]["instrument"]["instrument_id"])] = (
                "instrument_numeric"
            )
            refs[("item_id", numeric["item"]["item_id"])] = "watch_numeric"
            proposed = call(
                "import",
                proposals.propose_import,
                str(valid),
                str(aid),
                importer="cashu",
                reason="Synthetic pending import",
            )
            refs[("proposal_id", proposed["proposal_id"])] = "proposal_import"
            call(
                "import_blocked", proposals.propose_import, str(invalid), str(aid), importer="cashu"
            )

            def normalized(value, refmap=refs):
                if isinstance(value, list):
                    return [normalized(v) for v in value]
                if isinstance(value, dict):
                    result = {}
                    for key, item in value.items():
                        if (
                            key in {"instrument_id", "item_id", "proposal_id"}
                            and (key, item) in refmap
                        ):
                            result[key] = refmap[(key, item)]
                        elif key == "key" and isinstance(item, str) and item.startswith("i:"):
                            result[key] = "i:" + refmap[("instrument_id", int(item[2:]))]
                        else:
                            result[key] = normalized(item)
                    return result
                return value

            canonical = normalized(responses)
            output[privacy] = {
                "responses": canonical,
                "wire": json.dumps(canonical, sort_keys=True, ensure_ascii=False),
            }
    assert calls["search"] > 0 and calls["chart"] > 0
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--worker-mode", choices=("strict", "amounts"), help=argparse.SUPPRESS)
    parser.add_argument("--worker-output", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker_mode:
        if args.worker_output is None:
            raise SystemExit("worker output is required")
        with tempfile.TemporaryDirectory(prefix="cashu-mcp-async-mode-") as directory:
            generated = generate(Path(directory), args.worker_mode)
        args.worker_output.write_text(json.dumps(generated, ensure_ascii=False))
        return
    # Python uses a shared market catalog across profiles. Each native fixture is a fresh vault,
    # so each privacy workflow must also start with a genuinely fresh reference catalog/database.
    result = {}
    with tempfile.TemporaryDirectory(prefix="cashu-mcp-async-oracle-") as directory:
        for mode in ("strict", "amounts"):
            output = Path(directory) / f"{mode}.json"
            subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--worker-mode",
                    mode,
                    "--worker-output",
                    str(output),
                ],
                check=True,
                cwd=REPO,
            )
            result.update(json.loads(output.read_text()))
    text = subprocess.run(
        ["pnpm", "exec", "biome", "format", "--stdin-file-path", str(TARGET)],
        input=json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2) + "\n",
        text=True,
        capture_output=True,
        check=True,
        cwd=REPO,
    ).stdout
    if args.check:
        if TARGET.read_text() != text:
            raise SystemExit("investment async oracle differs")
    else:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        TARGET.write_text(text)
    print(
        "investment async oracle: actual public MockTransport + pending import, two synthetic privacy modes"
    )


if __name__ == "__main__":
    main()
