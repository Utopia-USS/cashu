"""Pure validation of research input (notes and runs) written by the agent. No IO; ``now`` is passed in.

A note is facts and sentiment with sources: at least one source with an ``http(s)`` URL, a publisher
and a publication date; bounded lengths; enums from the data contract; no amounts, targets or sizes
(``details`` takes only the whitelisted keys below); never a recommendation or a price prediction (a
small phrase check refuses the obvious ones); never a paywall-bypass link. Messages name the field and
never echo the value (they reach the agent).
"""

from __future__ import annotations

import datetime as dt
import ipaddress
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from ..models import (
    FULFILLS_THESIS_FIELDS,
    RESEARCH_NOTE_KINDS,
    RESEARCH_NOTE_TTL_DAYS,
    RESEARCH_POLARITIES,
    RESEARCH_SUMMARY_MAX,
    RESEARCH_THESIS_FIELDS,
    RESEARCH_THESIS_RELATIONS,
    RESEARCH_TITLE_MAX,
    THESIS_ENTRY_TYPES,
)
from .scoring import clean_theme

TITLE_MIN = 3
SUMMARY_MIN = 10
THEME_MAX = 60
SOURCES_MAX = 10
SOURCE_TITLE_MAX = 200
PUBLISHER_MAX = 80
URL_MAX = 500
CRITERIA_MAX = 12
CRITERION_TEXT_MAX = 160
THRESHOLD_TEXT_MAX = 60
CONTEXT_MAX = 200
EVENT_MAX = 80
EXPIRES_MAX_DAYS = 90
OBSERVED_MAX_AGE_DAYS = 365
SOURCE_MAX_AGE_DAYS = 3650
FUTURE_TOLERANCE = dt.timedelta(days=1)
SCOPE_THEMES_MAX = 20
SCOPE_INSTRUMENTS_MAX = 100
COUNT_MAX = 100_000
REASON_MAX = 200
RUN_COUNT_KEYS = (
    "sources_checked",
    "instruments_covered",
    "themes_covered",
    "candidates_screened",
    "skipped",
)
"""Counters the agent may report when finishing a run (the server adds notes / signals / kinds)."""
COMMUNITY_SCALES = ("small", "medium", "large")
DETAILS_KEYS = (
    "entry_type",
    "criteria",
    "context",
    "bucket",
    "event",
    "event_date",
    "scale",
    "criteria_version",
)
_CANDIDATE_SYMBOL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:\-_^=]{0,39}$")
_EXCHANGE = re.compile(r"^[A-Za-z0-9 .\-]{1,20}$")
_CURRENCY = re.compile(r"^[A-Za-z]{3}$")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")

BYPASS_HOSTS = (
    "archive.ph",
    "archive.today",
    "archive.is",
    "archive.li",
    "archive.vn",
    "archive.md",
    "12ft.io",
    "1ft.io",
    "removepaywall.com",
    "removepaywalls.com",
    "smry.ai",
    "paywallreader.com",
    "bypasspaywalls.org",
    "freedium.cfd",
)
"""Paywall / bot-protection bypass services: research never cites them (use the original source)."""

_ADVICE = re.compile(
    r"(?i)"
    r"\b(?:cen\w*|kurs\w*)\s+docelow\w*"
    r"|\b(?:price|share)[\s-]+targets?\b|\btarget\s+price\b"
    r"|\brekomendacj\w*\s+(?:kupuj|kupno|sprzedaj|sprzeda[zż]|trzymaj|akumuluj|redukuj|neutraln\w*"
    r"|przewa[zż]\w*|niedowa[zż]\w*)"
    r"|\b(?:strong\s+)?(?:buy|sell|hold|overweight|underweight|outperform|underperform)\s+rating\b"
    r"|\b(?:upgrade[sd]?|downgrade[sd]?)\s+to\s+(?:buy|sell|hold|overweight|underweight|outperform"
    r"|underperform)\b"
    r"|\b(?:kupuj|sprzedawaj|kup\s+teraz|sprzedaj\s+teraz|warto\s+(?:kupi[cć]|sprzeda[cć])"
    r"|nale[zż]y\s+(?:kupi[cć]|sprzeda[cć])|buy\s+now|sell\s+now)\b"
    r"|\b(?:you\s+should|we\s+recommend|i\s+recommend)\s+(?:buy|sell)\w*"
    r"|\b(?:wzro[sś]nie|urośnie|urosnie|spadnie|podro[zż]eje|potanieje|dojdzie)\s+do\s+\d"
    r"|\bwill\s+(?:rise|fall|reach|hit|drop|climb|trade)\s+(?:(?:to|at)\s+)?\d"
)


class ResearchInputError(ValueError):
    """Invalid research input. ``issues``: (field, message); the message is safe to show."""

    def __init__(self, message: str, issues: list[tuple[str, str]] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or [("", message)]


class _Issues:
    def __init__(self) -> None:
        self.items: list[tuple[str, str]] = []

    def add(self, where: str, message: str) -> None:
        self.items.append((where, message))

    def raise_if_any(self) -> None:
        if self.items:
            text = "; ".join(f"{w}: {m}" if w else m for w, m in self.items[:8])
            raise ResearchInputError(text, list(self.items))


# --------------------------------------------------------------------------- #
# Small parsers
# --------------------------------------------------------------------------- #


def _text(
    issues: _Issues,
    where: str,
    value: Any,
    *,
    minimum: int = 1,
    maximum: int,
    required: bool = True,
    multiline: bool = False,
) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            issues.add(where, "is required")
        return None
    if not isinstance(value, str):
        issues.add(where, "must be text")
        return None
    text = value.strip()
    if not multiline:
        text = re.sub(r"\s+", " ", text)
    else:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"\n{3,}", "\n\n", text)
    if _CONTROL.search(text) or (not multiline and "\n" in text):
        issues.add(
            where, "must not contain control characters" + ("" if multiline else " or lines")
        )
        return None
    if len(text) < minimum:
        issues.add(where, f"is too short (min {minimum} characters)")
        return None
    if len(text) > maximum:
        issues.add(where, f"is too long (max {maximum} characters)")
        return None
    return text


def _enum(issues: _Issues, where: str, value: Any, allowed: Sequence[str]) -> str | None:
    if not isinstance(value, str) or value not in allowed:
        issues.add(where, f"must be one of: {', '.join(allowed)}")
        return None
    return value


def parse_moment(value: Any) -> dt.datetime | None:
    """An ISO date (``2026-10-03`` = midnight UTC) or an ISO timestamp (naive = UTC) -> aware UTC."""
    if isinstance(value, dt.datetime):
        moment = value
    elif isinstance(value, dt.date):
        moment = dt.datetime(value.year, value.month, value.day, tzinfo=dt.UTC)
    elif isinstance(value, str):
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            moment = (
                dt.datetime.fromisoformat(text)
                if len(text) > 10
                else dt.datetime.combine(dt.date.fromisoformat(text), dt.time())
            )
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.UTC)
    return moment.astimezone(dt.UTC)


def _moment(
    issues: _Issues,
    where: str,
    value: Any,
    now: dt.datetime,
    *,
    max_age_days: int,
    required: bool = True,
) -> dt.datetime | None:
    if value is None or value == "":
        if required:
            issues.add(where, "is required (YYYY-MM-DD or an ISO timestamp)")
        return None
    moment = parse_moment(value)
    if moment is None:
        issues.add(where, "must be a date (YYYY-MM-DD) or an ISO timestamp")
        return None
    if moment > now + FUTURE_TOLERANCE:
        issues.add(where, "must not be in the future")
        return None
    if moment < now - dt.timedelta(days=max_age_days):
        issues.add(where, f"is older than {max_age_days} days")
        return None
    return moment


def check_url(value: Any) -> str | None:
    """None when ``value`` is an acceptable source URL, else the reason."""
    if not isinstance(value, str) or not value.strip():
        return "is required (the article / report URL)"
    url = value.strip()
    if len(url) > URL_MAX:
        return f"is too long (max {URL_MAX} characters)"
    if any(c.isspace() for c in url) or _CONTROL.search(url):
        return "must not contain spaces or control characters"
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower().rstrip(".")
        parts.port  # noqa: B018 - raises on a malformed port
    except ValueError:
        return "is not a valid URL"
    if parts.scheme not in ("http", "https"):
        return "must be an http(s) URL"
    if not host or parts.username or parts.password:
        return "must name a public host (no credentials)"
    try:
        ipaddress.ip_address(host.strip("[]"))
        return "must use a host name, not an IP address"
    except ValueError:
        pass
    if (
        host == "localhost"
        or host.endswith((".localhost", ".local", ".internal"))
        or "." not in host
    ):
        return "must name a public host"
    if any(host == b or host.endswith("." + b) for b in BYPASS_HOSTS):
        return "is a paywall-bypass service; cite the original publisher's URL"
    return None


def advice_problem(text: str | None) -> bool:
    """True when ``text`` reads like a recommendation, an analyst rating or a price prediction."""
    return bool(text) and _ADVICE.search(text) is not None


# --------------------------------------------------------------------------- #
# Notes
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class SourceInput:
    url: str
    publisher: str
    published_at: dt.datetime
    title: str | None = None

    def as_json(self) -> dict:
        return {
            "title": self.title,
            "url": self.url,
            "publisher": self.publisher,
            "published_at": self.published_at.date().isoformat()
            if self.published_at.time() == dt.time()
            else self.published_at.isoformat(),
        }


@dataclass(frozen=True, slots=True)
class CandidateInput:
    """A candidate instrument not (yet) in the profile: ticker with market or ISIN, display name."""

    symbol_or_isin: str
    name: str | None = None
    exchange: str | None = None
    currency: str | None = None

    @property
    def key(self) -> str:
        """Cooldown key: the upper-case ticker or ISIN as given."""
        return self.symbol_or_isin.upper()

    def as_json(self) -> dict:
        return {
            "symbol": self.symbol_or_isin,
            "name": self.name,
            "exchange": self.exchange,
            "currency": self.currency,
        }


@dataclass(frozen=True, slots=True)
class NoteInput:
    kind: str
    polarity: str
    strength: int
    thesis_relation: str
    title: str
    summary: str
    sources: tuple[SourceInput, ...]
    theme: str | None = None
    thesis_field: str | None = None
    observed_at: dt.datetime | None = None
    expires_in_days: int = RESEARCH_NOTE_TTL_DAYS
    details: dict | None = None
    candidate: CandidateInput | None = None

    def expires_at(self, now: dt.datetime) -> dt.datetime:
        return (self.observed_at or now) + dt.timedelta(days=self.expires_in_days)

    def sources_json(self) -> list[dict]:
        return [s.as_json() for s in self.sources]


def _sources(issues: _Issues, raw: Any, now: dt.datetime) -> tuple[SourceInput, ...]:
    if not isinstance(raw, list) or not raw:
        issues.add("sources", "at least one source is required: [{url, publisher, published_at}]")
        return ()
    if len(raw) > SOURCES_MAX:
        issues.add("sources", f"at most {SOURCES_MAX} sources")
        return ()
    out: list[SourceInput] = []
    seen: set[str] = set()
    for i, item in enumerate(raw):
        where = f"sources[{i}]"
        if not isinstance(item, Mapping):
            issues.add(where, "must be an object {url, publisher, published_at, title?}")
            continue
        unknown = sorted(set(item) - {"url", "publisher", "published_at", "title"})
        if unknown:
            issues.add(where, "allowed keys: url, publisher, published_at, title")
            continue
        problem = check_url(item.get("url"))
        if problem:
            issues.add(f"{where}.url", problem)
            continue
        publisher = _text(
            issues, f"{where}.publisher", item.get("publisher"), maximum=PUBLISHER_MAX
        )
        title = _text(
            issues, f"{where}.title", item.get("title"), maximum=SOURCE_TITLE_MAX, required=False
        )
        published = _moment(
            issues,
            f"{where}.published_at",
            item.get("published_at"),
            now,
            max_age_days=SOURCE_MAX_AGE_DAYS,
        )
        url = str(item["url"]).strip()
        if url in seen:
            issues.add(f"{where}.url", "is listed twice")
            continue
        seen.add(url)
        if publisher and published:
            out.append(SourceInput(url, publisher, published, title))
    return tuple(out)


def _criteria(issues: _Issues, raw: Any) -> list[dict] | None:
    if not isinstance(raw, list) or not raw:
        issues.add("details.criteria", "a candidate needs criteria: [{text, met, threshold?}]")
        return None
    if len(raw) > CRITERIA_MAX:
        issues.add("details.criteria", f"at most {CRITERIA_MAX} criteria")
        return None
    out: list[dict] = []
    for i, item in enumerate(raw):
        where = f"details.criteria[{i}]"
        if not isinstance(item, Mapping) or set(item) - {"text", "met", "threshold"}:
            issues.add(where, "must be an object {text, met, threshold?}")
            continue
        text = _text(issues, f"{where}.text", item.get("text"), maximum=CRITERION_TEXT_MAX)
        threshold = _text(
            issues,
            f"{where}.threshold",
            item.get("threshold"),
            maximum=THRESHOLD_TEXT_MAX,
            required=False,
        )
        if not isinstance(item.get("met"), bool):
            issues.add(f"{where}.met", "must be true or false")
            continue
        if text:
            out.append({"text": text, "met": item["met"], "threshold": threshold})
    return out


def _details(issues: _Issues, raw: Any, kind: str, now: dt.datetime) -> dict | None:
    if raw is None:
        if kind == "candidate":
            issues.add("details", "a candidate needs details {entry_type, criteria}")
        return None
    if not isinstance(raw, Mapping):
        issues.add("details", "must be an object")
        return None
    unknown = sorted(set(raw) - set(DETAILS_KEYS))
    if unknown:
        issues.add(
            "details",
            f"{len(unknown)} unknown key(s); allowed: {', '.join(DETAILS_KEYS)} "
            "(no amounts, targets or position sizes)",
        )
        return None
    out: dict = {}
    if kind == "candidate":
        entry = _enum(issues, "details.entry_type", raw.get("entry_type"), THESIS_ENTRY_TYPES)
        criteria = _criteria(issues, raw.get("criteria"))
        if entry:
            out["entry_type"] = entry
        if criteria is not None:
            out["criteria"] = criteria
        version = raw.get("criteria_version")
        if version is not None:
            if isinstance(version, bool) or not isinstance(version, int) or version < 1:
                issues.add("details.criteria_version", "must be the strategy version (integer)")
            else:
                out["criteria_version"] = version
        bucket = _text(issues, "details.bucket", raw.get("bucket"), maximum=40, required=False)
        if bucket:
            out["bucket"] = bucket
    else:
        for key in ("entry_type", "criteria", "criteria_version", "bucket"):
            if raw.get(key) is not None:
                issues.add(f"details.{key}", "only candidate notes carry it")
    context = _text(
        issues, "details.context", raw.get("context"), maximum=CONTEXT_MAX, required=False
    )
    if context:
        out["context"] = context
    if raw.get("scale") is not None:
        if kind != "community":
            issues.add("details.scale", "only community notes carry a scale")
        else:
            scale = _enum(issues, "details.scale", raw.get("scale"), COMMUNITY_SCALES)
            if scale:
                out["scale"] = scale
    event = _text(issues, "details.event", raw.get("event"), maximum=EVENT_MAX, required=False)
    event_raw = raw.get("event_date")
    if event_raw is not None:
        try:
            event_date = dt.date.fromisoformat(str(event_raw))
        except ValueError:
            issues.add("details.event_date", "must be a date (YYYY-MM-DD)")
            event_date = None
        if event_date is not None:
            if abs((event_date - now.date()).days) > 400:
                issues.add("details.event_date", "must be within 400 days of today")
            elif not event:
                issues.add("details.event", "name the event the date belongs to")
            else:
                out["event_date"] = event_date.isoformat()
                out["event"] = event
    elif event:
        issues.add("details.event_date", "an event needs its date (YYYY-MM-DD)")
    return out or None


def _candidate(issues: _Issues, raw: Any) -> CandidateInput | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping) or set(raw) - {
        "symbol_or_isin",
        "name",
        "exchange",
        "currency",
    }:
        issues.add("candidate", "must be an object {symbol_or_isin, name?, exchange?, currency?}")
        return None
    symbol = raw.get("symbol_or_isin")
    if not isinstance(symbol, str) or not _CANDIDATE_SYMBOL.match(symbol.strip()):
        issues.add(
            "candidate.symbol_or_isin",
            "must be a ticker with its market (NVDA.US, PKN.WA, VWCE.DE) or an ISIN",
        )
        return None
    name = _text(issues, "candidate.name", raw.get("name"), maximum=120, required=False)
    exchange = raw.get("exchange")
    if exchange is not None and (not isinstance(exchange, str) or not _EXCHANGE.match(exchange)):
        issues.add("candidate.exchange", "must be an exchange code (GPW, XETRA, NASDAQ, US)")
        exchange = None
    currency = raw.get("currency")
    if currency is not None and (not isinstance(currency, str) or not _CURRENCY.match(currency)):
        issues.add("candidate.currency", "must be a 3-letter currency code")
        currency = None
    return CandidateInput(
        symbol.strip(),
        name,
        exchange.strip() if isinstance(exchange, str) else None,
        currency.upper() if isinstance(currency, str) else None,
    )


def validate_note(raw: Mapping[str, Any], *, now: dt.datetime) -> NoteInput:
    """Check one note (the MCP arguments, without instrument / run resolution, which need the DB).
    Raises :class:`ResearchInputError` listing every problem."""
    issues = _Issues()
    kind = _enum(issues, "kind", raw.get("kind"), RESEARCH_NOTE_KINDS)
    polarity = _enum(issues, "polarity", raw.get("polarity"), RESEARCH_POLARITIES)
    strength = raw.get("strength")
    if isinstance(strength, bool) or not isinstance(strength, int) or not 1 <= strength <= 3:
        issues.add("strength", "must be 1, 2 or 3")
        strength = None
    relation = _enum(
        issues, "thesis_relation", raw.get("thesis_relation") or "none", RESEARCH_THESIS_RELATIONS
    )
    thesis_field = raw.get("thesis_field")
    if thesis_field is not None:
        thesis_field = _enum(issues, "thesis_field", thesis_field, RESEARCH_THESIS_FIELDS)
        if thesis_field and relation in (None, "none"):
            issues.add("thesis_field", "only with a thesis_relation other than none")
        elif thesis_field and relation == "fulfills" and thesis_field not in FULFILLS_THESIS_FIELDS:
            issues.add(
                "thesis_field",
                "a fulfills note names the thesis or its exit_plan (the outcome that happened)",
            )
    title = _text(issues, "title", raw.get("title"), minimum=TITLE_MIN, maximum=RESEARCH_TITLE_MAX)
    summary = _text(
        issues,
        "summary",
        raw.get("summary"),
        minimum=SUMMARY_MIN,
        maximum=RESEARCH_SUMMARY_MAX,
        multiline=True,
    )
    for where, text in (("title", title), ("summary", summary)):
        if advice_problem(text):
            issues.add(
                where,
                "reads like a recommendation, an analyst rating or a price prediction; notes carry "
                "sourced facts and sentiment only",
            )
    theme_raw = raw.get("theme")
    theme = None
    if theme_raw is not None:
        theme = _text(issues, "theme", clean_theme(str(theme_raw)), minimum=2, maximum=THEME_MAX)
    sources = _sources(issues, raw.get("sources"), now)
    observed = _moment(
        issues,
        "observed_at",
        raw.get("observed_at"),
        now,
        max_age_days=OBSERVED_MAX_AGE_DAYS,
        required=False,
    )
    expires_in = raw.get("expires_in_days")
    if expires_in is None:
        expires_in = RESEARCH_NOTE_TTL_DAYS
    elif isinstance(expires_in, bool) or not isinstance(expires_in, int):
        issues.add("expires_in_days", "must be an integer")
        expires_in = RESEARCH_NOTE_TTL_DAYS
    elif not 1 <= expires_in <= EXPIRES_MAX_DAYS:
        issues.add("expires_in_days", f"must be between 1 and {EXPIRES_MAX_DAYS}")
        expires_in = RESEARCH_NOTE_TTL_DAYS
    details = _details(issues, raw.get("details"), kind or "", now) if kind else None
    candidate = _candidate(issues, raw.get("candidate"))
    if kind == "candidate":
        if relation not in (None, "none"):
            issues.add("thesis_relation", "a candidate has no thesis yet: use none")
    elif candidate is not None:
        issues.add("candidate", "only candidate notes name a candidate instrument")
    if observed is not None and observed + dt.timedelta(days=expires_in) <= now:
        issues.add("observed_at", "the note would already be expired (raise expires_in_days)")
    issues.raise_if_any()
    assert kind and polarity and strength and relation and title and summary
    return NoteInput(
        kind=kind,
        polarity=polarity,
        strength=strength,
        thesis_relation=relation,
        title=title,
        summary=summary,
        sources=sources,
        theme=theme,
        thesis_field=thesis_field,
        observed_at=observed,
        expires_in_days=expires_in,
        details=details,
        candidate=candidate,
    )


# --------------------------------------------------------------------------- #
# Runs
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class RunScope:
    held: bool = True
    watchlist: bool = True
    candidates: bool = True
    themes: tuple[str, ...] = ()
    instruments: tuple[str, ...] = ()
    """Explicit instrument references (ids, symbols, ISINs); resolved by the service."""
    scheduled: bool = False
    """True for the scheduled (Saturday) routine, False on demand."""


def validate_scope(raw: Mapping[str, Any] | None) -> RunScope:
    issues = _Issues()
    data = dict(raw or {})
    allowed = {"held", "watchlist", "candidates", "themes", "instruments", "scheduled"}
    unknown = sorted(set(data) - allowed)
    if unknown:
        issues.add("scope", f"allowed keys: {', '.join(sorted(allowed))}")
    flags = {}
    for key, default in (("held", True), ("watchlist", True), ("candidates", True)):
        value = data.get(key, default)
        if not isinstance(value, bool):
            issues.add(f"scope.{key}", "must be true or false")
            value = default
        flags[key] = value
    scheduled = data.get("scheduled", False)
    if not isinstance(scheduled, bool):
        issues.add("scope.scheduled", "must be true or false")
        scheduled = False
    themes: list[str] = []
    raw_themes = data.get("themes") or []
    if not isinstance(raw_themes, list) or len(raw_themes) > SCOPE_THEMES_MAX:
        issues.add("scope.themes", f"must be a list of at most {SCOPE_THEMES_MAX} themes")
    else:
        for i, theme in enumerate(raw_themes):
            text = _text(
                issues, f"scope.themes[{i}]", clean_theme(str(theme)), minimum=2, maximum=THEME_MAX
            )
            if text and text.casefold() not in {t.casefold() for t in themes}:
                themes.append(text)
    instruments: list[str] = []
    raw_instruments = data.get("instruments") or []
    if not isinstance(raw_instruments, list) or len(raw_instruments) > SCOPE_INSTRUMENTS_MAX:
        issues.add(
            "scope.instruments", f"must be a list of at most {SCOPE_INSTRUMENTS_MAX} references"
        )
    else:
        for i, ref in enumerate(raw_instruments):
            text = str(ref).strip() if isinstance(ref, str | int) else ""
            if not text or len(text) > 40:
                issues.add(f"scope.instruments[{i}]", "must be an instrument id, symbol or ISIN")
            else:
                instruments.append(text)
    issues.raise_if_any()
    return RunScope(
        held=flags["held"],
        watchlist=flags["watchlist"],
        candidates=flags["candidates"],
        themes=tuple(themes),
        instruments=tuple(dict.fromkeys(instruments)),
        scheduled=scheduled,
    )


def validate_counts(raw: Mapping[str, Any] | None) -> dict[str, int]:
    """Agent-reported counters (``RUN_COUNT_KEYS``), each an integer in [0, 100000]."""
    issues = _Issues()
    out: dict[str, int] = {}
    for key, value in dict(raw or {}).items():
        if key not in RUN_COUNT_KEYS:
            issues.add("counts", f"allowed keys: {', '.join(RUN_COUNT_KEYS)}")
            break
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= COUNT_MAX:
            issues.add(f"counts.{key}", f"must be an integer between 0 and {COUNT_MAX}")
            continue
        out[key] = value
    issues.raise_if_any()
    return out
