# Copy shipped with this skill, generated from the finanse sources; do not edit it here.
"""Example finanse connector (kind fetch, module investments): the trade history of the made-up
ExampleExchange API (https://api.example.com) -> finanse-import v1 JSON (import-format.md).

Protocol (connectors.md): one JSON request on stdin, one JSON response on stdout, logs on stderr.
Python standard library only.

- Network: only through the app's egress proxy (HTTPS_PROXY), only to the hosts in connector.yaml,
  port 443. urllib is given the proxy explicitly.
- Secrets: `secrets.api_key` arrives on stdin. It is sent only in the Authorization header and is never
  printed, logged or put into a message.
- Cursor: the id of the newest entry already returned. The app hands it back on the next fetch (after
  the owner committed the import); with no cursor the history starts at `params.start` or `since`.
- Tests: `finanse connectors test <dir> --fixture fixture.json` runs `fetch` offline and passes the
  fixture's text as `params.fixture` (never declared in connector.yaml, so a real binding can never
  set it). The fixture holds the API pages this script would have downloaded.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, InvalidOperation

HOST = "api.example.com"
SOURCE = "exampleexchange"
PAGE_SIZE = 500
MAX_PAGES = 200
TYPES = {"DEPOSIT": "deposit", "WITHDRAWAL": "withdrawal", "BUY": "buy", "SELL": "sell"}


class ConnectorError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


def reply(payload, code=0):
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()
    sys.exit(code)


# --------------------------------------------------------------------------- #
# API access: real HTTP through the proxy, or the recorded fixture
# --------------------------------------------------------------------------- #


class HttpApi:
    def __init__(self, api_key):
        if not api_key:
            raise ConnectorError("auth_failed", "the API key is not set")
        self.api_key = api_key
        proxy = os.environ.get("HTTPS_PROXY")
        # An explicit proxy handler: without HTTPS_PROXY nothing can reach the network anyway.
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"https": proxy} if proxy else {})
        )

    def get(self, path, query=None):
        url = f"https://{HOST}{path}"
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        request = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "User-Agent": "finanse-fetch-example/1.0",
        })
        try:
            with self.opener.open(request, timeout=30) as response:
                body = response.read()
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise ConnectorError("auth_failed", f"the API refused the key (HTTP {e.code})") from None
            if e.code == 429:
                raise ConnectorError("rate_limited", "the API asks to slow down (HTTP 429)") from None
            raise ConnectorError("upstream", f"the API answered HTTP {e.code}") from None
        except (urllib.error.URLError, OSError):
            raise ConnectorError("network", f"{HOST} cannot be reached") from None
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ConnectorError("upstream", "the API answer is not JSON") from None


class FixtureApi:
    """Answers from a recorded synthetic fixture: {"pages": [<page 1>, <page 2>, ...]}."""

    def __init__(self, fixture_text):
        try:
            self.pages = list(json.loads(fixture_text)["pages"])
        except (ValueError, KeyError, TypeError):
            raise ConnectorError("internal", "the fixture must be {\"pages\": [...]}") from None

    def get(self, path, query=None):
        if path == "/v1/account":
            return {"status": "active"}
        if not self.pages:
            return {"entries": [], "has_more": False}
        return self.pages.pop(0)


def api_for(request):
    fixture = (request.get("params") or {}).get("fixture")
    if fixture:
        return FixtureApi(fixture)
    return HttpApi((request.get("secrets") or {}).get("api_key"))


# --------------------------------------------------------------------------- #
# Conversion
# --------------------------------------------------------------------------- #


def number(entry, key, row, *, required=True):
    raw = entry.get(key)
    if raw in (None, ""):
        if required:
            raise ConnectorError("upstream", f"entry {row}: field {key}: missing")
        return None
    try:
        return Decimal(str(raw))
    except InvalidOperation:
        raise ConnectorError("upstream", f"entry {row}: field {key}: not a number") from None


def record(entry, row):
    if not isinstance(entry, dict):
        raise ConnectorError("upstream", f"entry {row}: not an object")
    kind = entry.get("type")
    if kind not in TYPES:
        raise ConnectorError("upstream", f"entry {row}: field type: unknown entry type")
    stamp = str(entry.get("time") or "")
    out = {
        "record": "txn",
        "date": stamp[:10],
        "time": stamp[11:19] or None,
        "type": TYPES[kind],
        "external_ref": str(entry.get("id") or "") or None,
        "currency": entry.get("currency"),
    }
    if out["external_ref"] is None:
        raise ConnectorError("upstream", f"entry {row}: field id: missing")
    if out["type"] in ("buy", "sell"):
        quantity, price = number(entry, "quantity", row), number(entry, "price", row)
        fee = number(entry, "fee", row, required=False) or Decimal(0)
        gross = quantity * price
        cash = -(gross + fee) if out["type"] == "buy" else gross - fee
        out.update({"symbol": entry.get("asset"), "quantity": str(quantity), "price": str(price),
                    "gross_amount": str(gross), "fee": str(fee), "cash_amount": str(cash)})
    else:
        amount = abs(number(entry, "amount", row))
        out["cash_amount"] = str(amount if out["type"] == "deposit" else -amount)
    return {k: v for k, v in out.items() if v is not None}


def fetch(request):
    api = api_for(request)
    cursor = request.get("cursor")
    since = (request.get("params") or {}).get("start") or request.get("since")
    after = cursor
    records = []
    for _ in range(MAX_PAGES):
        query = {"after": after} if after else {"since": since}
        query["limit"] = PAGE_SIZE
        page = api.get("/v1/history", query)
        if not isinstance(page, dict):
            raise ConnectorError("upstream", "the API answer has an unexpected shape")
        entries = page.get("entries") or []
        for entry in entries:
            records.append(record(entry, len(records)))
        if entries:
            after = str(entries[-1]["id"])
        if not page.get("has_more"):
            break
    else:
        raise ConnectorError("upstream", f"more than {MAX_PAGES} pages")
    print(f"fetched {len(records)} entries", file=sys.stderr)  # counts only, never values
    document = {"format": "finanse-import", "format_version": 1, "source": SOURCE, "records": records}
    # The cursor: the newest id seen, or the old cursor when nothing new arrived.
    return {"document": document, "cursor": after}


def check(request):
    api_for(request).get("/v1/account")  # raises auth_failed / network / upstream
    return {"ok": True}


def main():
    try:
        request = json.load(sys.stdin)
    except ValueError:
        reply({"error": {"kind": "internal", "message": "the request is not JSON"}}, 1)
    if request.get("api_version") != 1:
        reply({"error": {"kind": "unsupported_version", "message": "api_version 1 only"}}, 1)
    command = request.get("command")
    try:
        if command == "fetch":
            reply(fetch(request))
        if command == "check":
            reply(check(request))
        raise ConnectorError("internal", f"unknown command {command}")
    except ConnectorError as e:
        reply({"error": {"kind": e.kind, "message": e.message}}, 1)


if __name__ == "__main__":
    main()
