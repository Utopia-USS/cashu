"""Near-duplicate research notes (P9): the same fact written again in other words. Pure (no IO).

A text becomes a token set: casefolded, diacritics stripped (``ł`` -> ``l`` too), split on anything
but letters and digits, Polish / English stopwords and one-letter tokens dropped, numbers-only tokens
dropped except in titles, and each word cut to its first :data:`STEM` characters (a crude stem: Polish
inflection changes word endings, ``prognozę`` / ``prognozy`` -> ``prog``).

Two notes are near duplicates when one rule matches: the Jaccard similarity of their titles, or of
their brief headlines (both present), is above :data:`TITLE_MIN`, or that of their bodies (brief
headline + the first :data:`BODY_CHARS` characters of the summary) is above :data:`BODY_MIN`. A rule
needs at least :data:`MIN_UNION` distinct tokens across both texts. Never a near duplicate (review
fix pass): a different polarity or thesis relation; different direction words in the compared texts
(:data:`UP_WORDS` vs :data:`DOWN_WORDS`, ``rośnie`` vs ``spada``, or a direction on one side only:
a reversal or a new move is a new fact); titles
with different numbers (``10 %`` vs ``20 %``, ``2 kwartał`` vs ``3 kwartał``). The headline rule is
skipped when both notes carry a brief whose ``why`` differs (Jaccard below :data:`TITLE_MIN`): a new
brief of an unchanged state with changed drivers replaces the shown one.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass

TITLE_MIN = 0.6
BODY_MIN = 0.7
MIN_UNION = 4
BODY_CHARS = 200
STEM = 4
WINDOW_DAYS = 60
"""Notes of the same scope observed this many days back are compared."""

_STOPWORDS_TEXT = """
    a aby albo ale az bardzo bez beda bedzie bo by byc byl byla byli bylo byly ci co czy dla do
    gdy go i ich im ja jak jako jednak jego jej jest jeszcze juz ku lub ma maja mi mnie na nad nie
    niz o od oraz po pod przed przez przy sa sie sobie ta tak takze tam te tego tej ten to tu tym
    u w we wiec wobec wsrod z za ze zas
    about after an and are as at be been but by for from has have in into is it its of on or
    over than that the their this to under was were will with
"""
STOPWORDS = frozenset(_STOPWORDS_TEXT.split())
"""Polish (without diacritics) and English function words, ignored by :func:`tokens`."""

UP_WORDS = (
    ("rosn", "rosl", "wzros", "wzrost", "podnos", "podnio", "podnie", "zwieksz", "wchodz", "weszl")
    + ("wejsc", "umacn", "umocn", "drozej", "podroz", "increas"),
    frozenset({"up", "rise", "rises", "rose", "risen", "raise", "raises", "raised", "higher"}),
)
"""Words of an upward move (prefixes of folded tokens, then exact English words): ``rośnie`` /
``rosną`` / ``wzrost`` / ``wzrósł`` / ``podnosi`` / ``podniósł`` / ``zwiększa`` / ``wchodzi`` /
``umacnia`` / ``drożeje`` / ``up`` / ``raises`` / ``increase``."""
DOWN_WORDS = (
    ("spad", "obniz", "zmniejsz", "wychodz", "wyszl", "wyjsc", "slabn", "oslab", "tanie", "potani")
    + ("decreas",),
    frozenset(
        {"down", "cut", "cuts", "fall", "falls", "fell", "fallen", "lower", "drop", "drops"}
        | {"dropped"}
    ),
)
"""Words of a downward move: ``spada`` / ``spadek`` / ``spadł`` / ``obniża`` / ``obniżył`` /
``zmniejsza`` / ``wychodzi`` / ``słabnie`` / ``tanieje`` / ``down`` / ``cuts`` / ``decrease``."""

_TOKEN = re.compile(r"[a-z0-9]+")


def _ascii(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text.casefold().replace("ł", "l"))
    return "".join(c for c in folded if not unicodedata.combining(c))


def _words(text: str | None) -> list[str]:
    return _TOKEN.findall(_ascii(text or ""))


def tokens(text: str | None, *, numbers: bool = False) -> frozenset[str]:
    """The normalized token set of ``text`` (see the module doc); ``numbers`` keeps numbers-only
    tokens (titles)."""
    out = set()
    for token in _words(text):
        if token.isdigit():
            if numbers:
                out.add(token)
            continue
        if len(token) < 2 or token in STOPWORDS:
            continue
        out.add(token[:STEM])
    return frozenset(out)


def _has(words: list[str], lexicon: tuple[tuple[str, ...], frozenset[str]]) -> bool:
    prefixes, exact = lexicon
    return any(w in exact or w.startswith(prefixes) for w in words)


def directions(text: str | None) -> frozenset[str]:
    """``{"up"}``, ``{"down"}``, both or none: the direction words in ``text``."""
    words = _words(text)
    found = set()
    if _has(words, UP_WORDS):
        found.add("up")
    if _has(words, DOWN_WORDS):
        found.add("down")
    return frozenset(found)


def opposite(a: frozenset[str], b: frozenset[str]) -> bool:
    """The two texts do not name the same direction: opposite words (``rośnie`` / ``spada``), or a
    direction on one side only (``w konsolidacji`` / ``wychodzi z konsolidacji``): a move is a new
    fact."""
    return a != b


def numbers(text: str | None) -> frozenset[str]:
    return frozenset(w for w in _words(text) if w.isdigit())


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _similar(a: frozenset[str], b: frozenset[str], threshold: float) -> bool:
    return len(a | b) >= MIN_UNION and jaccard(a, b) > threshold


def body(summary: str | None, headline: str | None = None) -> str:
    """The text the body comparison reads: the brief headline (when any) and the summary's start."""
    return f"{headline or ''} {(summary or '')[:BODY_CHARS]}".strip()


@dataclass(frozen=True)
class Fingerprint:
    title: frozenset[str]
    body: frozenset[str]
    headline: frozenset[str] = frozenset()
    """Tokens of the brief headline (empty without a brief)."""
    why: frozenset[str] = frozenset()
    """Tokens of the brief's ``why`` (empty without a brief)."""
    title_dir: frozenset[str] = frozenset()
    headline_dir: frozenset[str] = frozenset()
    body_dir: frozenset[str] = frozenset()
    title_numbers: frozenset[str] = frozenset()
    polarity: str | None = None
    relation: str | None = None

    @classmethod
    def of(
        cls,
        title: str,
        summary: str,
        headline: str | None = None,
        *,
        why: str | None = None,
        polarity: str | None = None,
        relation: str | None = None,
    ) -> Fingerprint:
        text = body(summary, headline)
        return cls(
            title=tokens(title, numbers=True),
            body=tokens(text),
            headline=tokens(headline),
            why=tokens(why),
            title_dir=directions(title),
            headline_dir=directions(headline),
            body_dir=directions(text),
            title_numbers=numbers(title),
            polarity=polarity,
            relation=relation,
        )


def is_near_duplicate(a: Fingerprint, b: Fingerprint) -> bool:
    if a.polarity != b.polarity or (a.relation or "none") != (b.relation or "none"):
        return False
    if a.title_numbers and b.title_numbers and a.title_numbers != b.title_numbers:
        return False
    if not opposite(a.title_dir, b.title_dir) and _similar(a.title, b.title, TITLE_MIN):
        return True
    drivers_changed = bool(a.why) and bool(b.why) and jaccard(a.why, b.why) < TITLE_MIN
    if (
        not drivers_changed
        and not opposite(a.headline_dir, b.headline_dir)
        and _similar(a.headline, b.headline, TITLE_MIN)
    ):
        return True
    return not opposite(a.body_dir, b.body_dir) and _similar(a.body, b.body, BODY_MIN)


def first_near_duplicate[T](
    new: Fingerprint, candidates: Iterable[tuple[T, Fingerprint]]
) -> T | None:
    """The first candidate (in the given order) that ``new`` nearly duplicates, else None."""
    for item, fingerprint in candidates:
        if is_near_duplicate(new, fingerprint):
            return item
    return None
