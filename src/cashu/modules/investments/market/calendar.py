"""Market calendar of the weekly review: what happens in the next ``DAYS`` days.

Three sources, merged into one list of dated events:

- **Macro** - ForexFactory's public weekly feed (``ff_calendar_thisweek.json`` / ``nextweek``): only
  high-impact releases of the big economies (``COUNTRIES``); central-bank meetings are folded into one
  "decyzja o stopach" row per bank and day, the common releases get a Polish name (``RELEASES``).
  The cache stores the Polish ``title`` next to the feed's English ``source_title`` and ``country``;
  :func:`calendar_view` renders the title and country label again in the current UI language.
- **Earnings** - Nasdaq's public daily earnings list (one request per weekday), matched *locally* to the
  profile's held and watched US-listed instruments.
- **Research** - events the research agent stored on a note (``details.event_date`` / ``event``).

Privacy: both feeds are fetched as whole public lists; no symbol, amount or profile detail is sent. The
fetched lists are shared by every profile and cached in the data dir (``market/calendar.json``) for
``CACHE_TTL``; a failed feed keeps the last cache's rows, is marked ``stale`` and retried after ``RETRY_AFTER``. Under tests
(``CASHU_TESTING=1``) nothing is fetched unless a fetcher is passed in.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx
from sqlmodel import Session, select

from cashu.core import paths
from cashu.core.i18n import lang, tr, use_language
from cashu.core.models import Profile

DAYS = 14
CACHE_TTL = dt.timedelta(hours=6)
RETRY_AFTER = dt.timedelta(minutes=30)
CACHE_FILE = "calendar.json"

FF_URLS = (
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
)
NASDAQ_URL = "https://api.nasdaq.com/api/calendar/earnings?date={day}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}
TIMEOUT = 10.0

COUNTRIES = {"USD": "USA", "EUR": "strefa euro", "GBP": "Wielka Brytania", "JPY": "Japonia", "CNY": "Chiny"}
"""Feed country code -> Polish label; other countries' releases are left out."""
COUNTRIES_EN = {"USD": "US", "EUR": "euro area", "GBP": "UK", "JPY": "Japan", "CNY": "China"}

CENTRAL_BANKS = {"USD": "Fed", "EUR": "EBC", "GBP": "BoE", "JPY": "BoJ", "CNY": "LBC"}
CENTRAL_BANKS_EN = {"USD": "Fed", "EUR": "ECB", "GBP": "BoE", "JPY": "BoJ", "CNY": "PBoC"}

_RATE_MEETING = re.compile(
    r"(funds rate|refinancing rate|policy rate|bank rate|rate statement|policy statement|press conference|"
    r"outlook report|monetary policy report|rate votes|fomc statement|loan prime rate)",
    re.IGNORECASE,
)

RELEASES: tuple[tuple[str, str], ...] = (
    (r"fomc meeting minutes|monetary policy meeting minutes|account of monetary", "protokół z posiedzenia banku centralnego"),
    (r"non-farm|unemployment rate|average hourly earnings|employment change|claimant count", "rynek pracy"),
    (r"core pce", "inflacja PCE"),
    (r"\bcpi\b|consumer price|hicp", "inflacja CPI"),
    (r"\bppi\b|producer price", "inflacja producencka PPI"),
    (r"\bgdp\b", "PKB"),
    (r"retail sales", "sprzedaż detaliczna"),
    (r"ism manufacturing|manufacturing pmi", "PMI przemysł"),
    (r"ism services|services pmi", "PMI usługi"),
    (r"speaks|testifies", "wystąpienie szefa banku centralnego"),
    (r"budget", "budżet państwa"),
)
"""Ordered (pattern, Polish name) of the common high-impact releases; the first match wins."""

RELEASES_EN: tuple[str, ...] = (
    "central bank meeting minutes",
    "labor market",
    "PCE inflation",
    "CPI inflation",
    "PPI producer inflation",
    "GDP",
    "retail sales",
    "manufacturing PMI",
    "services PMI",
    "central bank chief speaks",
    "government budget",
)
"""English names of :data:`RELEASES`, in the same order."""

US_MICS = {"XNAS", "XNYS", "ARCX", "BATS", "XASE", "XNGS", "XNCM", "XNMS", "IEXG"}

Fetcher = Callable[[dt.date, int], dict]
"""``(today, days) -> feed dict`` (``fetched_at``, ``from``, ``to``, ``macro``, ``earnings``, ``errors``)."""


class CalendarError(ValueError):
    """Invalid calendar input (message safe to show)."""


# ---- parsing -------------------------------------------------------------------------------------------


def macro_name(country: str, title: str) -> str:
    """The name of a high-impact release in the current UI language (Polish in the cache), the feed's
    English title when it is not a known one."""
    english = lang() == "en"
    if _RATE_MEETING.search(title) and "unemployment" not in title.lower():
        if english:
            return f"{CENTRAL_BANKS_EN.get(country, country)}: rate decision"
        return f"{CENTRAL_BANKS.get(country, country)}: decyzja o stopach"
    for (pattern, name), name_en in zip(RELEASES, RELEASES_EN, strict=True):
        if re.search(pattern, title, re.IGNORECASE):
            return name_en if english else name
    return title


def _polish_name(country: str, title: str) -> str:
    """:func:`macro_name` in Polish: the cache keeps Polish titles whatever the current language."""
    with use_language("pl"):
        return macro_name(country, title)


def parse_ff(body: str) -> list[dict]:
    """High-impact releases of ``COUNTRIES`` from one ForexFactory weekly feed, in local time."""
    rows = json.loads(body)
    if not isinstance(rows, list):
        raise TypeError("ForexFactory feed is not a list")
    out = []
    for row in rows:
        if not isinstance(row, dict) or row.get("impact") != "High" or row.get("country") not in COUNTRIES:
            continue
        try:
            moment = dt.datetime.fromisoformat(str(row["date"])).astimezone()
        except (KeyError, ValueError):
            continue
        title = str(row.get("title") or "").strip()
        out.append(
            {
                "date": moment.date().isoformat(),
                "time": moment.strftime("%H:%M"),
                "country": row["country"],
                "title": _polish_name(row["country"], title),
                "source_title": title,
            }
        )
    return out


def parse_nasdaq(body: str, day: dt.date) -> list[dict]:
    """Companies reporting on ``day`` (symbol, name, before / after the session)."""
    data = json.loads(body).get("data") or {}
    rows = data.get("rows") or []
    out = []
    for row in rows:
        symbol = str(row.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        when = str(row.get("time") or "")
        out.append(
            {
                "date": day.isoformat(),
                "symbol": symbol,
                "name": str(row.get("name") or "").strip(),
                "when": "pre" if "pre" in when else "after" if "after" in when else None,
            }
        )
    return out


# ---- fetching and the cache ----------------------------------------------------------------------------


def _weekdays(start: dt.date, days: int) -> list[dt.date]:
    return [d for d in (start + dt.timedelta(n) for n in range(days)) if d.weekday() < 5]


def fetch_feeds(today: dt.date, days: int = DAYS, client: httpx.Client | None = None) -> dict:
    """Fetch both public feeds (best effort: each failed request adds an ``errors`` code)."""
    own = client is None
    client = client or httpx.Client(timeout=TIMEOUT, headers=HEADERS, follow_redirects=True)
    errors: list[str] = []
    macro: list[dict] = []
    earnings: list[dict] = []
    try:
        for url in FF_URLS:
            try:
                r = client.get(url)
                if r.status_code == 404:  # next week's feed appears only late in the week
                    continue
                r.raise_for_status()
                macro.extend(parse_ff(r.text))
            except (httpx.HTTPError, ValueError, TypeError):
                errors.append("macro_unavailable")

        def one(day: dt.date) -> list[dict] | None:
            try:
                r = client.get(NASDAQ_URL.format(day=day.isoformat()))
                r.raise_for_status()
                return parse_nasdaq(r.text, day)
            except (httpx.HTTPError, ValueError, AttributeError):
                return None

        with ThreadPoolExecutor(max_workers=4) as pool:
            for got in pool.map(one, _weekdays(today, days)):
                if got is None:
                    errors.append("earnings_unavailable")
                else:
                    earnings.extend(got)
    finally:
        if own:
            client.close()
    return {
        "fetched_at": dt.datetime.now(dt.UTC).isoformat(),
        "from": today.isoformat(),
        "to": (today + dt.timedelta(days)).isoformat(),
        "macro": _unique(macro, ("date", "country", "title")),
        "earnings": earnings,
        "errors": sorted(set(errors)),
    }


def _unique(rows: Iterable[dict], keys: tuple[str, ...]) -> list[dict]:
    seen, out = set(), []
    for row in rows:
        key = tuple(row.get(k) for k in keys)
        if key not in seen:
            seen.add(key)
            out.append(row)
    return out


def cache_path() -> Path:
    return paths.data_dir() / "market" / CACHE_FILE


def _read_cache(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write_cache(path: Path, data: dict) -> None:
    paths.ensure_private_dir(path.parent)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _fresh(data: dict | None, today: dt.date, days: int, now: dt.datetime) -> bool:
    """Young enough and covering the range; a fetch with errors is retried after ``RETRY_AFTER``."""
    if not data:
        return False
    try:
        fetched = dt.datetime.fromisoformat(data["fetched_at"])
        start, end = dt.date.fromisoformat(data["from"]), dt.date.fromisoformat(data["to"])
    except (KeyError, TypeError, ValueError):
        return False
    ttl = RETRY_AFTER if data.get("errors") else CACHE_TTL
    return now - fetched < ttl and start <= today and end >= today + dt.timedelta(days)


def _testing() -> bool:
    return os.environ.get("CASHU_TESTING") == "1"


def feeds(
    today: dt.date, days: int = DAYS, *, fetch: Fetcher | None = None, now: dt.datetime | None = None
) -> tuple[dict, bool]:
    """The cached feeds, refetched when older than ``CACHE_TTL`` or not covering the range.
    Returns ``(feeds, stale)``: ``stale`` when part of the last fetch failed (the failed part keeps the
    previous cache's rows)."""
    now = now or dt.datetime.now(dt.UTC)
    path = cache_path()
    cached = _read_cache(path)
    if _fresh(cached, today, days, now):
        return cached, bool(cached.get("errors"))  # type: ignore[union-attr]
    if fetch is None:
        if _testing():
            return cached or _empty(today, days, ["offline"]), True
        fetch = fetch_feeds
    got = fetch(today, days)
    if cached and got.get("errors"):  # keep what the old cache had for the failed part
        for part in ("macro", "earnings"):
            if not got.get(part):
                got[part] = cached.get(part) or []
    got["fetched_at"] = now.isoformat()
    _write_cache(path, got)
    return got, bool(got.get("errors"))


def _empty(today: dt.date, days: int, errors: list[str]) -> dict:
    return {
        "fetched_at": None,
        "from": today.isoformat(),
        "to": (today + dt.timedelta(days)).isoformat(),
        "macro": [],
        "earnings": [],
        "errors": errors,
    }


# ---- the profile's view --------------------------------------------------------------------------------


def _us_symbol(inst: Any, yahoo: str | None) -> str | None:
    """The bare US ticker of an instrument (``NVDA``), None when it is not US-listed."""
    if yahoo and "." not in yahoo and "=" not in yahoo and "^" not in yahoo:
        return yahoo.upper()
    symbol = (inst.symbol or "").strip().upper()
    if not symbol:
        return None
    if symbol.endswith(".US"):
        return symbol[:-3]
    if (inst.mic or "").upper() in US_MICS and "." not in symbol:
        return symbol
    return None


def _instruments(session: Session, profile: Profile) -> dict[int, tuple[Any, bool]]:
    """Held and watched instruments of the profile: id -> (instrument row, held)."""
    from ..models import InvInstrument
    from ..service import views as inv_views
    from ..store import alerts as alert_store

    out: dict[int, tuple[Any, bool]] = {}
    for p in inv_views.positions(session, profile)["positions"]:
        iid = (p.get("instrument") or {}).get("id")
        if isinstance(iid, int):
            row = session.get(InvInstrument, iid)
            if row is not None:
                out[iid] = (row, True)
    for item in alert_store.watchlist(session, int(profile.id)):
        if item.instrument_id not in out:
            row = session.get(InvInstrument, item.instrument_id)
            if row is not None:
                out[item.instrument_id] = (row, False)
    return out


def _yahoo_aliases(session: Session, ids: Iterable[int]) -> dict[int, str]:
    from ..models import InvInstrumentAlias

    ids = list(ids)
    if not ids:
        return {}
    rows = session.exec(
        select(InvInstrumentAlias).where(
            InvInstrumentAlias.instrument_id.in_(ids), InvInstrumentAlias.namespace == "yahoo"
        )
    ).all()
    return {r.instrument_id: r.value for r in rows}


def _label(inst: Any) -> str:
    return inst.label if getattr(inst, "label", None) else (inst.symbol or inst.name)


def calendar_view(
    session: Session,
    profile: Profile,
    *,
    today: dt.date | None = None,
    days: int = DAYS,
    fetch: Fetcher | None = None,
) -> dict:
    """The next ``days`` days for one profile: macro releases, earnings of its held / watched US
    instruments and its research notes' events, sorted by date and time."""
    from ..research import service as research_service
    from ..research.segments import segment_label

    if not 1 <= days <= 31:
        raise CalendarError("days must be between 1 and 31")
    today = today or dt.date.today()  # local calendar day
    end = today + dt.timedelta(days)
    data, stale = feeds(today, days, fetch=fetch)
    in_range = lambda d: today.isoformat() <= d < end.isoformat()

    events: list[dict] = []
    for m in data.get("macro") or []:
        if in_range(m["date"]):
            events.append(
                {
                    "date": m["date"],
                    "time": m.get("time"),
                    "kind": "macro",
                    "title": (
                        macro_name(m["country"], m["source_title"])
                        if m.get("source_title")
                        else m["title"]
                    ),
                    "country": m["country"],
                    "country_label": tr(pl=COUNTRIES, en=COUNTRIES_EN).get(
                        m["country"], m["country"]
                    ),
                    "instrument_id": None,
                    "label": None,
                    "held": None,
                    "note_id": None,
                }
            )

    instruments = _instruments(session, profile)
    aliases = _yahoo_aliases(session, instruments)
    by_symbol: dict[str, tuple[int, Any, bool]] = {}
    for iid, (inst, held) in instruments.items():
        symbol = _us_symbol(inst, aliases.get(iid))
        if symbol:
            by_symbol[symbol] = (iid, inst, held)
    for e in data.get("earnings") or []:
        hit = by_symbol.get(e["symbol"])
        if hit is None or not in_range(e["date"]):
            continue
        iid, inst, held = hit
        when = e.get("when")
        events.append(
            {
                "date": e["date"],
                "time": (
                    tr(pl="przed sesją", en="before the open")
                    if when == "pre"
                    else tr(pl="po sesji", en="after the close")
                    if when == "after"
                    else None
                ),
                "kind": "earnings",
                "title": tr(
                    pl=f"Wyniki kwartalne {_label(inst)}",
                    en=f"Quarterly results {_label(inst)}",
                ),
                "country": None,
                "country_label": None,
                "instrument_id": iid,
                "label": _label(inst),
                "held": held,
                "note_id": None,
            }
        )

    earnings_ids = {e["instrument_id"] for e in events if e["kind"] == "earnings"}
    for note in research_service.notes(session, int(profile.id)):
        details = note.details or {}
        when = details.get("event_date")
        if not isinstance(when, str) or not in_range(when[:10]):
            continue
        if note.kind == "earnings" and note.instrument_id in earnings_ids:
            continue  # the feed already has it
        inst = instruments.get(note.instrument_id) if note.instrument_id is not None else None
        events.append(
            {
                "date": when[:10],
                "time": None,
                "kind": "research",
                "title": str(details.get("event") or note.title),
                "country": None,
                "country_label": segment_label(note.segment) if note.segment else None,
                "instrument_id": note.instrument_id,
                "label": _label(inst[0]) if inst else None,
                "held": inst[1] if inst else None,
                "note_id": note.id,
            }
        )

    events.sort(key=lambda e: (e["date"], e["time"] or "99", e["kind"] != "earnings"))
    return {
        "as_of": today.isoformat(),
        "from": today.isoformat(),
        "to": end.isoformat(),
        "fetched_at": data.get("fetched_at"),
        "stale": stale,
        "errors": list(data.get("errors") or []),
        "events": events,
    }
