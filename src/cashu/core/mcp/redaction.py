"""The privacy layer between tool handlers and the agent.

``Redactor(privacy, guard).apply(tree)`` turns a handler's labelled tree into plain JSON:

- ``identifier`` -> the key is dropped (both modes);
- ``amount`` -> dropped in ``strict``, a number in ``amounts``;
- ``merchant`` -> sent, private-person payees as an opaque ``payee:`` reference (``names.NameGuard``);
- ``text`` / ``category`` / ``account`` / ``symbol`` -> scrubbed (``scrub_text``) on a normalized copy
  (Unicode spaces, zero-width characters and dashes folded): IBAN-like strings, digit runs with 9+
  digits (account / card / phone numbers), masked cards, letter-and-digit ids, e-mail addresses and
  known person names always; in ``strict`` every number with 2+ significant digits except dates;
- ``percent`` / ``level`` / ``count`` / ``ref`` / ``flag`` / ``date`` -> type-checked and sent.

Every scrubbed string is cut to ``MAX_SCRUB_CHARS`` (200 000) characters first and every rule runs in
linear time (S37fix3), so one long string cannot stall a call.

A raw (unlabelled) leaf raises :class:`UnlabelledValue`: the call fails closed. After redaction,
``leak_check`` scans the result once more (identifier-like strings and 10+ digit numbers in any mode;
in ``strict`` also any number under a money-like key) and raises :class:`LeakDetected` instead of sending.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import unicodedata
from bisect import bisect_left, bisect_right
from decimal import Decimal
from functools import lru_cache
from typing import Any

from .labels import Labelled, Sensitivity, market_ok
from .names import NameGuard

STRICT = "strict"
AMOUNTS = "amounts"


class UnlabelledValue(TypeError):
    """A tool returned a value without a sensitivity label (a bug; nothing is sent)."""


class LeakDetected(RuntimeError):
    """The final check found something that must not leave the machine (nothing is sent)."""


_DROP = object()
# numbers these labels carry are never money: a money-like key does not refuse them (D6, N7)
_NON_MONEY_LABELS = (Sensitivity.COUNT, Sensitivity.PERCENT, Sensitivity.REF)

# --------------------------------------------------------------------------- #
# Text scrubbing
# --------------------------------------------------------------------------- #

# Matching runs on a normalized copy of the text (S37fix D1): NFKC per character, every Unicode space,
# tab, line break and zero-width character becomes one ASCII space, soft hyphens are removed and every
# dash becomes "-". Each normalized character remembers the original one it came from, so the answer
# keeps the original text everywhere except the masked spans.
_ZERO_WIDTH = frozenset("\u200b\u200c\u200d\u2060\ufeff")
_LINE_SPACE = frozenset("\t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\u2028\u2029")
_REMOVED = frozenset("\u00ad")


@lru_cache(maxsize=4096)  # S37fix3: a pure function of one character, called per character
def _norm_char(ch: str) -> str:
    if ch in _REMOVED:
        return ""
    out: list[str] = []
    for c in unicodedata.normalize("NFKC", ch):
        if c in _REMOVED:
            continue
        cat = unicodedata.category(c)
        if c in _ZERO_WIDTH or c in _LINE_SPACE or cat == "Zs":
            out.append(" ")
        elif cat == "Pd" or c == "\u2212":
            out.append("-")
        else:
            out.append(c)
    return "".join(out)


def normalize_for_matching(text: str) -> str:
    """The normalized copy the identifier and amount rules match on (D1)."""
    return "".join(_norm_char(c) for c in text)


class _Work:
    """The normalized text being scrubbed, each character mapped to its original index (``None`` for
    a replacement). ``render`` rebuilds the original text with the replacements in place."""

    def __init__(self, text: str) -> None:
        self.orig = text
        chars = [_norm_char(ch) for ch in text]
        self.removed: list[bool] = [n == "" for n in chars]
        self.text = "".join(chars)
        if len(self.text) == len(text) and not any(self.removed):
            src: list[int | None] = list(range(len(text)))  # one character for one (S37fix3: fast)
        else:
            src = []
            for i, n in enumerate(chars):
                src.extend([i] * len(n))
        self.src = src
        self.touched: set[int] = set()
        self.changed = False

    def sub(self, pattern: re.Pattern, repl, *, mark: bool = True) -> None:
        """``pattern.sub`` on the normalized text; ``repl`` is a string or a function returning the
        replacement, ``None`` (keep the match) or ``(text, sources)`` (restore saved characters)."""
        out: list[str] = []
        src: list[int | None] = []
        last = 0
        for m in pattern.finditer(self.text):
            r = repl(m) if callable(repl) else repl
            if r is None:
                continue
            out.append(self.text[last : m.start()])
            src.extend(self.src[last : m.start()])
            if mark:
                self.touched.update(s for s in self.src[m.start() : m.end()] if s is not None)
            if isinstance(r, tuple):
                out.append(r[0])
                src.extend(r[1])
            else:
                out.append(r)
                src.extend([None] * len(r))
            last = m.end()
        if not out:
            return
        self.changed = True
        out.append(self.text[last:])
        src.extend(self.src[last:])
        self.text = "".join(out)
        self.src = src

    def render(self) -> str:
        if not self.changed:
            return self.orig  # nothing replaced: the original text as it is
        out: list[str] = []
        prev: int | None = None
        for k, c in enumerate(self.text):
            s = self.src[k]
            if s is None or s in self.touched:
                out.append(c)
                continue
            if s == prev:
                continue
            prev = s
            j = s - 1
            pre: list[str] = []
            while j >= 0 and self.removed[j]:
                pre.append(self.orig[j])
                j -= 1
            out.extend(reversed(pre))
            out.append(self.orig[s])
        tail = len(self.orig)
        while tail > 0 and self.removed[tail - 1]:
            tail -= 1
        out.append(self.orig[tail:])  # removed characters at the very end
        return "".join(out)


# Dates kept while the number rules run (D3, D5, S37fix N2 / N6): only valid ones (year 1900-2099,
# month 01-12, day 01-31): ISO dates and timestamps (a fraction of at most 9 digits), periods
# (2024-03, 03/2024, 2024-Q1) and DD.MM.YYYY. Any other date shape is plain digits.
_YEAR = r"(?:19|20)\d{2}"
_ISO_DATE = re.compile(
    rf"\b{_YEAR}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])"
    r"(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b"
)
_PERIOD = re.compile(rf"\b{_YEAR}-(?:0[1-9]|1[0-2]|Q[1-4])\b|\b(?:0[1-9]|1[0-2])/{_YEAR}\b")
_DMY_DATE = re.compile(
    rf"(?<![\w.,])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.{_YEAR}(?![\w]|[.,]\d)"
)
# Identifiers, every privacy level (D2, S37fix N4): a run of digit groups joined by any 1-5
# characters that are neither letters nor digits (spaces, punctuation, brackets: "4532, 0151",
# "(22) 123 45 67"), optionally led by a country code, with 9+ digits in all (accounts, IBANs, cards,
# phone numbers); IBANs with letters in the account part; masked cards with their visible digits;
# letter-and-digit ids (8+ characters, 4+ digits); a number after an account word; e-mail addresses.
_SEP = r"[\W_]{1,5}"
_RUN = re.compile(rf"(?:(?<!\w)([A-Z]{{2}}))?(?<!\d)(\d+(?:{_SEP}\d+)*)")
# the narrower separators of IBAN and masked-card shapes (letters take part in those)
_ID_SEP = r"(?: ?[/_-]{1,2} ?| {1,3}|[.,])"
_IBAN = re.compile(
    rf"\b[A-Z]{{2}}\d{{2}}(?:{_ID_SEP}?[A-Z0-9]{{4}}){{3,8}}(?:{_ID_SEP}?[A-Z0-9]{{1,4}})?\b"
)
# S37fix3: a run of mask characters is taken whole (possessive), never split between the groups: a
# long "xxxx..." word took polynomial time
_MASKED_CARD = re.compile(
    rf"(?<![\w*•])(?:\d{{1,6}}{_ID_SEP}?)?(?:[*xX•]{{2,}}+{_ID_SEP}?){{1,4}}\d{{2,6}}(?!\d)"
)
# grouped thousands with a decimal part, one separator throughout, at most 14 digits
_AMOUNT_FORMAT = re.compile(r"(?=(?:\D*\d){9,14}\D*$)\d{1,3}([ .,'])\d{3}(?:\1\d{3})*[.,]\d{1,2}")
_ALNUM_ID = re.compile(r"(?<!\w)\w{8,}(?!\w)")
_LETTER = re.compile(r"[^\W\d_]")
# a lower-case hex digest (a content hash prefix: 12+ characters, 3+ letters, no 9 digits in a row)
# is kept like a date: it is neither an account id nor an amount
_HEX_DIGEST = re.compile(r"(?<!\w)(?=(?:[0-9a-f]*[a-f]){3})(?![0-9a-f]*\d{9})[0-9a-f]{12,64}(?!\w)")
_DIGIT = re.compile(r"\d")
_ACCOUNT_ID = re.compile(r"\b[A-Za-z]{1,3}\d{6,9}\b")
_ID_CARD = re.compile(r"\b([A-Z]{3}) \d{6}\b")
_CURRENCY_CODES = frozenset(
    {"PLN", "EUR", "USD", "GBP", "CHF", "JPY", "CZK", "HUF", "SEK", "NOK", "DKK", "CAD", "AUD"}
)
# a shorter number right after an account word ("konto nr 12345678")
_ACCOUNT_WORD = re.compile(
    r"(?i:\b(?:konto|konta|rachunek|rachunku|account|acct|acc|nr|numer|no)(?:\b\.?|(?=\d))[ :#]{0,3})"
    r"(?:nr\.? ?)?(\d[\d -]{4,}\d)"
)
# S37fix3: an address starts only where a run of address characters starts (no rescan of a long word
# from each of its letters: linear time); addresses chained right after one ("a@b.pl+c@d.pl") join it
_EMAIL_ONE = r"(?:@|\(at\)|\[at\])[\w-]+(?:\.[\w-]+)+"
_EMAIL = re.compile(rf"(?<![\w.+-])[\w.+-]+{_EMAIL_ONE}(?:[.+][\w.+-]*{_EMAIL_ONE})*")
# Money (strict): a number next to a currency (any upper-case 3-letter code, Polish / English words,
# symbols), after a money word, with a multiplier (12 tys., 100k), grouped thousands, decimals; then
# every other number with 2+ significant digits (D3).
_CUR = (
    r"(?:[A-Z]{3}|(?i:zł|zl|złot\w*|zlot\w*|grosz\w*|euro|eur|usd|pln|gbp|chf|dolar\w*|funt\w*"
    r"|frank\w*)|€|\$|£)"
)
# S37fix2 W4: the characters that group digits ("2 000", "2'000", "2.000", "5•0000", "1・000",
# "1٬000", "2’000"). Unicode spaces (thin, narrow no-break) are already one ASCII space here (D1).
_GROUP = " '._•·,\u2019\u02bc\u2032\u30fb\u066c\u066b\u2e31\u2027\u2219\u22c5"
_G = f"[{_GROUP}]"
_NUM = rf"[-+]?\d(?:[\d{_GROUP}]*\d)?"
_MONEY_CUR = re.compile(rf"(?:{_NUM} ?{_CUR}(?![A-Za-z]))|(?:(?<![A-Za-z]){_CUR} ?{_NUM})")
# S37fix2 W1 / W2: a scale word takes the whole number before it, digit groups included, across any
# run of spaces ("2 tysiące", "3  miliony", "1,5 mln", "2 500 tysięcy", "5k", "2 tyś")
# S37fix3: the other number of a range or an alternative joins it ("2-3 tys.", "2 do 3 tysięcy")
_RANGE_JOIN = r"(?:\s*[-/]\s*|\s+(?i:lub|albo|do|or|to)\s+)"
_MULTIPLIED = re.compile(
    rf"(?<![\w.,])(?:[-+]?\d+(?:{_G}\d+)*{_RANGE_JOIN})?[-+]?\d+(?:{_G}\d+)*\s*"
    r"(?i:ty[sś]\.?|tysi[aąeę]c\w*|milion\w*|miliard\w*|bilion\w*|mln|mld|k|m|mn|bn"
    r"|thousands?|millions?|billions?)(?![\w])"
)
_GROUPED = re.compile(
    r"(?<![\w.,])[-+]?\d{1,3}(?:(?:[ ']\d{3})+|(?:,\d{3})+|(?:\.\d{3}){2,})(?:[.,]\d+)?"
    r"(?![\w%]|\s?pp\b|\s?%)"
)
_DECIMAL = re.compile(r"(?<![\w.,])[-+]?\d+[.,]\d+(?![\d%]|\s?%|\s?pp\b)")
_MONEY_WORD = re.compile(
    r"(?i:\b(?:price|prices|cena|ceny|cash|amount|kwota|kwoty|value|warto\w*|worth|cost|costs|"
    r"koszt\w*|saldo|balance|deposit\w*|wp[lł]at\w*|wyp[lł]at\w*|fee|fees|tax|prowizj\w*|"
    r"op[lł]at\w*|proceeds|income|expense\w*|przych\w*|wydat\w*|rata|raty|installment)\b"
    rf"[^\d\n]{{0,24}}?)(?<![\w.,])([-+]?\d+(?:{_G}\d+)*)"
    rf"(?![\d%]|{_G}\d|\s?%|\s?pp\b|\s?(?:days?|dni)\b)"
)
# S37fix2 N9: a number glued after letters ("kwota950", "nr1500") is a number too; a sign counts only
# when no letter or digit stands before it ("COVID-19" keeps its dash)
# S37fix3: an exponent is part of the number ("1e4%" is 10 000, not "1" and a kept "4%")
_ANY_NUMBER = re.compile(r"(?:(?<!\w)[-+])?(?<!\d)\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?")
# S37fix2 N10: digit groups joined by one grouping character ("2 000", "3 000 %", "2_000 x", "5•0000")
# are one number, masked whole by its significant digits, before a percent sign too
_GROUPED_ANY = re.compile(rf"(?:(?<!\w)[-+])?(?<!\d)\d+(?:{_G}\d+)+")
# S37fix2: amounts in words (strict free text). A run of Polish / English number words is masked when
# it holds a word worth 10 or more or a scale word ("dwa tysiące", "pół miliona", "fifty"); units
# alone ("dwa", "pięć") stay. Bare English "ten" is left out (Polish "ten" = "this").
# S37fix2 W1 / W2: words joined by any run of spaces, a comma, a dash, "i" / "and"; a number in
# digits right before the words joins the run ("2 i pół miliona"); a scale word glued after another
# word (a soft hyphen removed: "dwatysiące") is a scale word; "kilka", "parę", "półtorej", "kilkaset",
# "setki" and the slang "stówa" are number words; "koło", "bańka", "patyk" count as a scale word only
# right after a number or a number word ("dwa koła", "3 patyki"), "bańka spekulacyjna" stays.
_NUMBER_WORDS_BIG = (
    r"dziesi[eę][cć]|dziesi[eę]ciu|\w+na[sś]cie|\w+nastu|dwadzie[sś]cia|\w+dziestu|\w+dzie[sś]ci|"
    r"\w+dziesi[aą]t|\w+dziesi[eę]ciu|sto|stu|dwie[sś]cie|dwustu|trzysta|trzystu|czterysta|"
    r"czterystu|(?:pi[eę][cć]|sze[sś][cć]|siedem|osiem|dziewi[eę][cć])set|"
    r"(?:pi[eę]ciu|sze[sś]ciu|siedmiu|o[sś]miu|dziewi[eę]ciu)set|(?:kilka|kilku|par[eę]|paru)set|"
    r"setk\w*|setek|st[oó]w(?:a|y|ę|ą|ie|ami|ach|om|ka|ki|kę|ką|ek|ce|kami|kach)|stów|tysiak\w*|"
    r"\w*tysi[aąeę]c\w*|ty[sś]\.?|\w*milion\w*|\w*miliard\w*|\w*bilion\w*|mln\.?|mld\.?|eleven|twelve|thirteen|fourteen|fifteen|sixteen|"
    r"seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|"
    r"\w*thousands?|\w*millions?|\w*billions?"
)
_NUMBER_WORDS_SMALL = (
    r"zero|jeden|jedna|jedno|jednego|jednej|jednym|dwa|dwie|dw[oó]ch|dwu|dwoma|trzy|trzech|trzema|"
    r"cztery|czterech|pi[eę][cć]|pi[eę]ciu|sze[sś][cć]|sze[sś]ciu|siedem|siedmiu|osiem|o[sś]miu|"
    r"dziewi[eę][cć]|dziewi[eę]ciu|p[oó][lł]|p[oó][lł]tor(?:a|ej)|kilka|kilku|kilkoma|par[eę]|paru|"
    r"paroma|one|two|three|four|five|six|seven|eight|"
    r"nine|ten|half"
)
# S37fix3: slang after a number also in English ("2 grand"); a scale abbreviation glued to a number
# word ("dwatys", "pięćmln") is a scale word; a number in digits may be glued to the words ("2koła",
# "2stówy"); words of a range or an alternative join the run ("dwa lub trzy tysiące")
_NUMBER_WORDS_AFTER = r"ko[lł][oa]|bańk(?:a|i|ę|ą)|baniek|patyk\w*|grands?"
_GLUED_SCALE = rf"(?:{_NUMBER_WORDS_SMALL})(?:ty[sś]\.?|mln\.?|mld\.?)"
_NUMBER_WORD = rf"(?:{_NUMBER_WORDS_BIG}|{_GLUED_SCALE}|{_NUMBER_WORDS_SMALL})(?!\w)"
_WORD_AFTER = (
    rf"(?:{_NUMBER_WORDS_BIG}|{_GLUED_SCALE}|{_NUMBER_WORDS_SMALL}|{_NUMBER_WORDS_AFTER})(?!\w)"
)
_WORD_JOIN = r"(?:\s+(?:i|and|lub|albo|do|or|to|x)\s+|\s*[,/-]\s*|\s+)"
_DIGITS_BEFORE = rf"(?<![\w.,])[-+]?\d+(?:{_G}\d+)*{_WORD_JOIN}?"
_NUMBER_WORDS = re.compile(
    rf"(?i:(?:{_DIGITS_BEFORE}|(?<!\w)){_NUMBER_WORD}(?:{_WORD_JOIN}{_WORD_AFTER})*"
    rf"|{_DIGITS_BEFORE}(?:{_NUMBER_WORDS_AFTER})(?!\w)(?:{_WORD_JOIN}{_WORD_AFTER})*)"
)
_BIG_NUMBER_WORD = re.compile(
    rf"(?i:(?:(?<!\w)|(?<=\d))(?:{_NUMBER_WORDS_BIG}|{_GLUED_SCALE}|{_NUMBER_WORDS_AFTER})(?!\w))"
)
# Kept in strict free text (S37fix R1, R2, N1, N5): a number with at most 3 integer digits and no
# grouping right before a percent sign / percentage points (a decimal part of 1-2 digits allowed) or a
# non-money unit from this closed list (an integer only), or right after a position word ("line 12").
# A number that touches another digit group through a grouping separator ("1.250 x", "450.000 lat")
# or has a currency next to it, on either side ("zł 500 dni", "999 x PLN"), is never kept.
_KEPT_UNITS = (
    r"sesja|sesji|sesje|sessions?|dzień|dni|days?|tydzień|tygodni|weeks?|miesiąc|miesięcy|miesiące|"
    r"months?|rok|lat|lata|years?|x|znaków|characters?|linia|lines?|wiersz|rows?|pozycji|positions?"
)
_NOT_GROUPED = rf"(?<![\w.,])(?<!\d{_G})"
_KEPT_PERCENT = re.compile(
    rf"{_NOT_GROUPED}[-+]?\d{{1,3}}(?:[.,]\d{{1,2}})?(?!{_G}\d|\d)"
    r"(?= ?(?:%|pp\b|p\.p\.|pkt proc\.))"
)
# S37fix3: "2 x tysiąc" is an amount, not a multiplier
_KEPT_UNIT = re.compile(
    rf"{_NOT_GROUPED}[-+]?\d{{1,3}}(?= ?(?i:{_KEPT_UNITS})(?!\w))"
    rf"(?! ?(?i:x\s+(?:{_NUMBER_WORDS_BIG}|{_GLUED_SCALE}))(?!\w))"
)
_KEPT_POSITION = re.compile(
    r"((?i:\b(?:line|row|linia|linii|wiersz|wiersza|pozycja|pozycji)) )(\d{1,3})"
    rf"(?![\d\w]|{_G}\d)"
)
_CURRENCY_WORDS = (
    r"zł|zl|złot\w*|zlot\w*|grosz\w*|gr|pln|eur|euro|usd|chf|gbp|dolar\w*|funt\w*|frank\w*"
)
_CURRENCY_BEFORE = re.compile(rf"(?:(?i:\b(?:{_CURRENCY_WORDS}))|[$€£]|\b[A-Z]{{3}}) {{0,3}}[-+]?$")
# matched at the end of the number (``match(text, end)``: no slice of the rest of the text)
_CURRENCY_AFTER = re.compile(
    rf" {{0,3}}(?:(?:%|pp\b|p\.p\.|pkt proc\.|(?i:{_KEPT_UNITS}))(?!\w))? {{0,3}}"
    rf"(?:(?i:(?:{_CURRENCY_WORDS}))(?!\w)|[$€£]|[A-Z]{{3}}(?![A-Za-z]))"
)
_WORD_CHAR = re.compile(r"\w")
_ISIN = re.compile(r"\b[A-Z]{2}[A-Z0-9]{9}\d\b")
# A protected date / ISIN is swapped for NUL + its index + NUL while the number rules run. The index is
# written in private-use characters, not digits, so no number rule (``_MONEY_WORD`` after "[amount]",
# a decimal, ...) can touch it (F7 re-review B3: the agent got NUL bytes instead of the date).
_PLACEHOLDER_DIGITS = str.maketrans("0123456789", "".join(chr(0xE000 + d) for d in range(10)))
_PLACEHOLDER = re.compile("\u0000[\ue000-\ue009]+\u0000")
_LEFTOVER = re.compile("\u0000[^\u0000]*\u0000|\u0000")


def _placeholder(index: int) -> str:
    return f"\u0000{str(index).translate(_PLACEHOLDER_DIGITS)}\u0000"


def isin_valid(value: str) -> bool:
    """ISO 6166 check digit (Luhn over the letters-as-numbers expansion)."""
    if not _ISIN.fullmatch(value or ""):
        return False
    digits = "".join(str(int(c, 36)) for c in value[:-1])
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            n = n - 9 if n > 9 else n
        total += n
    return (10 - total % 10) % 10 == int(value[-1])


def _protect_dates(work: _Work, isins: frozenset[str] = frozenset()) -> list[tuple[str, list]]:
    """Swap dates, timestamps, periods (and the given ISINs) for placeholders, restored after
    scrubbing, so their digits never look like an account number or an amount. ISINs are protected
    only when a symbol field carried them: in free text an ISIN-shaped token (a VAT id, an account
    number that happens to pass the check digit) is scrubbed like any other number."""
    saved: list[tuple[str, list]] = []

    def keep(m: re.Match) -> str:
        saved.append((m.group(0), work.src[m.start() : m.end()]))
        return _placeholder(len(saved) - 1)

    for pattern in (_ISO_DATE, _PERIOD, _DMY_DATE, _HEX_DIGEST):
        work.sub(pattern, keep, mark=False)
    if isins:
        work.sub(_ISIN, lambda m: keep(m) if m.group(0) in isins else None, mark=False)
    return saved


def _protect_kept_numbers(work: _Work, saved: list[tuple[str, list]]) -> None:
    def near_currency(start: int, end: int) -> bool:
        # S37fix3 D1: only the window the rule can reach is read (a currency ends at most 4
        # characters before the number; the window goes back to the start of the word there), never
        # the whole text before each number, so many kept numbers stay linear
        text = work.text
        window = max(0, start - 5)
        while window > 0 and _WORD_CHAR.match(text, window - 1):
            window -= 1
        return bool(_CURRENCY_BEFORE.search(text[window:start]) or _CURRENCY_AFTER.match(text, end))

    def keep(m: re.Match):
        if near_currency(m.start(), m.end()):
            return None
        saved.append((m.group(0), work.src[m.start() : m.end()]))
        return _placeholder(len(saved) - 1)

    def keep_position(m: re.Match):
        if near_currency(m.start(2), m.end(2)):
            return None
        saved.append((m.group(2), work.src[m.start(2) : m.end(2)]))
        mark = _placeholder(len(saved) - 1)
        return m.group(1) + mark, work.src[m.start(1) : m.end(1)] + [None] * len(mark)

    work.sub(_KEPT_PERCENT, keep, mark=False)
    work.sub(_KEPT_UNIT, keep, mark=False)
    work.sub(_KEPT_POSITION, keep_position, mark=False)


def _restore_dates(work: _Work, saved: list[tuple[str, list]]) -> None:
    def back(m: re.Match):
        index = int(m.group(0)[1:-1].translate({0xE000 + d: str(d) for d in range(10)}))
        return saved[index] if index < len(saved) else "[date]"

    if "\u0000" in work.text:
        work.sub(_PLACEHOLDER, back, mark=False)
    # never hand placeholder internals to the agent: anything left becomes a clean "[date]"
    if "\u0000" in work.text:
        work.sub(_LEFTOVER, "[date]")


def _digit_count(text: str) -> int:
    return len(_DIGIT.findall(text))


def _run(m: re.Match) -> str | None:
    if _digit_count(m.group(2)) < 9:
        return None
    if not m.group(1) and _AMOUNT_FORMAT.fullmatch(m.group(2)):
        return None  # "1 234 567,89": an amount (strict masks it as one), not an identifier
    return "[iban]" if m.group(1) else "[number]"


def _alnum_id(m: re.Match) -> str | None:
    token = m.group(0)
    return "[account]" if _digit_count(token) >= 4 and _LETTER.search(token) else None


def _id_card(m: re.Match) -> str | None:
    return None if m.group(1) in _CURRENCY_CODES else "[account]"


def _significant(m: re.Match) -> str | None:
    digits = _DIGIT.findall(m.group(0))
    while digits and unicodedata.decimal(digits[0]) == 0:
        digits.pop(0)
    return "[amount]" if len(digits) >= 2 else None


# a link (public source): a number glued to letters in it ("/p11/") is part of a path, not an amount
# S37fix2 W3: only a link that starts the text or follows a space, "(", "<" or a quote ("xhttps://"
# is not a link)
# S37fix3: a glued number with 4+ digits is masked inside a link too ("https://x.pl/a4532b"); the link
# test reads an index of the text built once per pass (link starts and spaces), never a rescan of
# the text before each number, so a long text of glued numbers stays linear
_LINK_START = re.compile(r"(?:^|(?<=[\s(<\"'“”„‘’«»]))(?:https?://|www\.)")
_SPACE = re.compile(r"\s")
_LINK_DIGITS = 4


class _LinkIndex:
    """Where the links of a text start, to tell whether a position lies inside one: a link start
    (``https://``, ``http://``, ``www.``) ends before the position, with no space after it."""

    def __init__(self, text: str) -> None:
        found = sorted((m.end(), m.start()) for m in _LINK_START.finditer(text))
        self.ends = [end for end, _ in found]
        self.starts: list[int] = []  # the latest link start among the first k links by end
        latest = -1
        for _, start in found:
            latest = max(latest, start)
            self.starts.append(latest)
        self.spaces = [m.start() for m in _SPACE.finditer(text)]

    def inside(self, position: int) -> bool:
        k = bisect_right(self.ends, position)
        if not k:
            return False
        j = bisect_left(self.spaces, position)
        return (self.spaces[j - 1] if j else -1) < self.starts[k - 1]


def _any_number_in(text: str):
    """The ``_ANY_NUMBER`` replacement for one pass over ``text``."""
    links: _LinkIndex | None = None

    def any_number(m: re.Match) -> str | None:
        nonlocal links
        start = m.start()
        if start > 0 and text[start - 1].isalpha() and _digit_count(m.group(0)) < _LINK_DIGITS:
            if links is None:
                links = _LinkIndex(text)
            if links.inside(start):
                return None
        return _significant(m)

    return any_number


def _number_words(m: re.Match) -> str | None:
    return "[amount]" if _BIG_NUMBER_WORD.search(m.group(0)) else None


def _keep_prefix(replacement: str):
    return lambda m: m.group(0)[: m.start(1) - m.start(0)] + replacement


# S37fix3: every scrubbed string is cut to MAX_SCRUB_CHARS characters (the longest tool argument,
# ``registry.MAX_STRING``) before any rule reads it, and the rules run in linear time, so one long
# string cannot stall a call. The cut drops the word it splits and any digits or separators before
# it (no half of a number is left to slip under a threshold), then the whole word before that (the
# first half of a name split by the cut), and appends TRUNCATED.
MAX_SCRUB_CHARS = 200_000
TRUNCATED = " [truncated]"


def _cap(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_SCRUB_CHARS:
        return text, False
    end = MAX_SCRUB_CHARS
    for _ in range(2):  # the split word, then the word before it (half of a name, S37fix3)
        while end > 0 and not text[end - 1].isspace():
            end -= 1
        while end > 0 and not text[end - 1].isalpha():
            end -= 1
    return text[:end], True


def scrub_text(text: str | None, *, strict: bool, guard: NameGuard | None = None) -> str | None:
    if text is None:
        return None
    text, cut = _cap(str(text))
    if strict and guard is not None:
        # first, before any rewriting: an alias with a number ("IKE Oli 2030") must still match
        # the owner's label as typed (F7 review R6)
        text = guard.swap_aliases(text)
    work = _Work(text)
    dates = _protect_dates(work)
    work.sub(_MASKED_CARD, "[number]")
    work.sub(_IBAN, "[iban]")
    work.sub(_RUN, _run)
    work.sub(_ACCOUNT_ID, "[account]")
    work.sub(_ALNUM_ID, _alnum_id)
    work.sub(_ID_CARD, _id_card)
    work.sub(_ACCOUNT_WORD, _keep_prefix("[number]"))
    work.sub(_EMAIL, "[email]")
    if strict:
        _protect_kept_numbers(work, dates)
        work.sub(_MONEY_CUR, "[amount]")
        work.sub(_MONEY_WORD, _keep_prefix("[amount]"))
        work.sub(_MULTIPLIED, "[amount]")
        work.sub(_NUMBER_WORDS, _number_words)
        work.sub(_GROUPED_ANY, _significant)  # before the decimal rule: "1.2.3" is one number
        work.sub(_GROUPED, "[amount]")
        work.sub(_DECIMAL, "[amount]")
        work.sub(_ANY_NUMBER, _any_number_in(work.text))
    _restore_dates(work, dates)
    text = work.render()
    if guard is not None:
        text = guard.mask(text)
    return text + TRUNCATED if cut else text


def identifier_in(text: str, isins: frozenset[str] | set[str] = frozenset()) -> bool:
    """True when ``text`` still holds an identifier-like run (the leak check's string test)."""
    work = _Work(text)
    _protect_dates(work, frozenset(isins))
    t = work.text
    if _IBAN.search(t) or _MASKED_CARD.search(t):
        return True
    if any(_run(m) for m in _RUN.finditer(t)):
        return True
    if _REF.match(text):
        return False
    return any(_alnum_id(m) for m in _ALNUM_ID.finditer(t))


# --------------------------------------------------------------------------- #
# Redactor
# --------------------------------------------------------------------------- #

_KEY = re.compile(r"^[a-z_][a-z0-9_]{0,63}$")
_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9.\-:=^_/]{0,19}$")
_REF = re.compile(r"^(?:\d{1,12}|[a-z][a-z0-9_]*:[0-9a-z]{6,64})$")
# a date label: a year, a quarter, a month, a day or an ISO timestamp (fraction of at most 9 digits)
_DATE_STR = re.compile(
    r"^\d{4}(?:-Q[1-4]|-\d{2}(?:-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?"
    r"(?:Z|[+-]\d{2}:?\d{2})?)?)?)?$"
)
_HAS_LETTER = re.compile(r"[A-Z]")


def _number(value: Any, path: str) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise UnlabelledValue(f"{path}: a boolean is not a number")
    if isinstance(value, int):
        return value
    if isinstance(value, (float, Decimal)):
        return float(value)
    raise UnlabelledValue(f"{path}: expected a number, got {type(value).__name__}")


class Redactor:
    def __init__(self, privacy: str, guard: NameGuard | None = None) -> None:
        self.privacy = AMOUNTS if privacy == AMOUNTS else STRICT
        self.strict = self.privacy == STRICT
        self.guard = guard
        self.isins: set[str] = set()
        self.non_money: set[str] = set()
        """Paths (in the redacted answer) of count-, percent- and ref-labelled numbers: never money
        (D6, N7)."""

    def text(self, value: str | None) -> str | None:
        return scrub_text(value, strict=self.strict, guard=self.guard)

    def apply(self, tree: Any) -> Any:
        out = self._walk(tree, "$", "$")
        return None if out is _DROP else out

    def _walk(self, node: Any, path: str, out_path: str) -> Any:
        if node is None:
            return None
        if isinstance(node, Labelled):
            if node.label in _NON_MONEY_LABELS and node.value is not None:
                self.non_money.add(out_path)
            return self._leaf(node, path)
        if isinstance(node, dict):
            out: dict[str, Any] = {}
            for key, value in node.items():
                if not isinstance(key, str) or not _KEY.match(key):
                    # Keys are chosen by code (snake_case); data never becomes a key.
                    raise UnlabelledValue(f"{path}: dict keys must be snake_case names")
                item = self._walk(value, f"{path}.{key}", f"{out_path}.{key}")
                if item is not _DROP:
                    out[key] = item
            return out
        if isinstance(node, (list, tuple)):
            kept: list[Any] = []
            for i, v in enumerate(node):
                item = self._walk(v, f"{path}[{i}]", f"{out_path}[{len(kept)}]")
                if item is not _DROP:
                    kept.append(item)
            return kept
        raise UnlabelledValue(f"{path}: unlabelled {type(node).__name__}")

    def _leaf(self, node: Labelled, path: str) -> Any:
        label, value = node.label, node.value
        if label is Sensitivity.IDENTIFIER:
            return _DROP
        if label is Sensitivity.AMOUNT:
            return _DROP if self.strict else _number(value, path)
        if value is None:
            return None
        if label in (Sensitivity.PERCENT, Sensitivity.LEVEL):
            return _number(value, path)
        if label is Sensitivity.COUNT:
            if isinstance(value, bool) or not isinstance(value, int):
                raise UnlabelledValue(f"{path}: a count must be an integer")
            return value
        if label is Sensitivity.FLAG:
            if not isinstance(value, bool):
                raise UnlabelledValue(f"{path}: a flag must be a boolean")
            return value
        if label is Sensitivity.DATE:
            if isinstance(value, dt.datetime):
                if value.tzinfo is None:  # naive = UTC (SQLite), never sent naive (F7 FE1)
                    value = value.replace(tzinfo=dt.UTC)
                return value.astimezone(dt.UTC).isoformat()
            if isinstance(value, dt.date):
                return value.isoformat()
            if isinstance(value, str) and _DATE_STR.match(value):
                return value
            raise UnlabelledValue(f"{path}: not a date")
        if label is Sensitivity.REF:
            ref = str(value)
            if not _REF.match(ref):
                raise UnlabelledValue(f"{path}: not a reference")
            return value if isinstance(value, int) and not isinstance(value, bool) else ref
        if label is Sensitivity.MERCHANT:
            merchant = str(value)
            if self.guard is not None:
                merchant = self.guard.merchant(merchant)
            return self.text(merchant) if not merchant.startswith("payee:") else merchant
        if label is Sensitivity.SYMBOL:
            symbol = str(value)
            if isin_valid(symbol):
                self.isins.add(symbol)  # the leak check lets exactly these through
                return symbol
            if self.guard is not None and symbol in self.guard.symbols:
                # a digit-only ticker of one of the profile's instruments (S37fix R5)
                return scrub_text(symbol, strict=False, guard=self.guard)
            if (
                _SYMBOL.match(symbol)
                and not (symbol.isdigit() and len(symbol) >= 5)
                and (not self.strict or _HAS_LETTER.search(symbol))
            ):
                # a ticker-like token: identifiers and known names are still scrubbed (in strict
                # a symbol without a letter is a number and goes through the strict scrub, F8)
                return scrub_text(symbol, strict=False, guard=self.guard)
            return self.text(symbol)
        if label in (Sensitivity.TEXT, Sensitivity.CATEGORY, Sensitivity.ACCOUNT):
            return self.text(str(value))
        if label is Sensitivity.AUTHORED:
            authored = str(value)
            if self.strict and self.guard is not None:
                authored = self.guard.swap_aliases(authored)
            return scrub_text(authored, strict=False, guard=self.guard)
        if label is Sensitivity.MARKET:
            if not market_ok(value):
                raise UnlabelledValue(f"{path}: not market text")
            return scrub_text(str(value), strict=False, guard=self.guard)
        raise UnlabelledValue(f"{path}: unknown label {label}")  # pragma: no cover


# --------------------------------------------------------------------------- #
# Final check
# --------------------------------------------------------------------------- #

# Keys whose numbers are money or quantities: in strict mode none may carry a number. Besides these
# names, a key is a money key when its normalized form (lower case, separators removed) contains a
# money word, or one of its parts is "sum" / "net" or a currency code (S37fix D6, N7). Nothing
# overrides a money word; numbers the tool labelled as counts or percentages are exempt by their path
# (``Redactor.non_money``), not by their key.
MONEY_KEYS = frozenset(
    {
        "amount",
        "amounts",
        "value",
        "values",
        "total",
        "totals",
        "cost",
        "price",
        "quantity",
        "balance",
        "income",
        "expense",
        "expenses",
        "net",
        "outstanding",
        "principal",
        "payment",
        "monthly_payment",
        "cash",
        "market_value",
        "gross",
        "gross_amount",
        "cash_amount",
        "fee",
        "tax",
        "installment",
        "typical_amount",
        "assets",
        "liabilities",
        "realized",
        "unrealized",
        "to_target",
        "monthly_amount",
        "min_trade_value",
        "unit_value",
    }
)
MONEY_KEY_WORDS = (
    "amount",
    "kwota",
    "balance",
    "saldo",
    "value",
    "wartosc",
    "price",
    "cena",
    "cost",
    "koszt",
    "total",
    "suma",
    "cash",
    "income",
    "przychod",
    "expense",
    "fee",
    "tax",
    "payment",
    "platnosc",
    "principal",
    "outstanding",
    "quantity",
    "gross",
    "installment",
    "rata",
    "kredyt",
    "loan",
    "worth",
    "spend",
    "deposit",
    "withdrawal",
    "proceeds",
    "pnl",
    "profit",
    "gain",
    "saving",
    "debt",
    "salary",
    "capital",
    "equity",
    "budget",
)
MONEY_KEY_PARTS = frozenset(
    {"sum", "sums", "net", "pln", "eur", "usd", "chf", "gbp", "jpy", "czk", "huf", "sek", "nok"}
)
# an alert's last public price level or ratio ("last_value": the only level-labelled number under a
# money word; an owner-named instrument's price is amount-labelled and dropped)
NOT_MONEY_KEYS = frozenset({"last_value"})
_KEY_SEPARATORS = re.compile(r"[_\-\s]+")


def is_money_key(key: str) -> bool:
    """True when a number under ``key`` would be money or a quantity (strict mode refuses it)."""
    if key in MONEY_KEYS:
        return True
    if key in NOT_MONEY_KEYS:
        return False
    lowered = key.lower()
    joined = _KEY_SEPARATORS.sub("", lowered)
    if any(w in joined for w in MONEY_KEY_WORDS):
        return True
    return any(part in MONEY_KEY_PARTS for part in _KEY_SEPARATORS.split(lowered))


# a number of 10+ digits in its JSON text (an account number stored as a number)
_LONG_DIGITS = re.compile(r"(?<!\d)\d(?:[ \u00a0/_-]{0,2}\d){9,}(?!\d)")


def leak_check(
    result: Any,
    *,
    strict: bool,
    isins: frozenset[str] | set[str] = frozenset(),
    non_money: frozenset[str] | set[str] = frozenset(),
) -> None:
    """Raise :class:`LeakDetected` when the redacted ``result`` still holds an identifier-like
    string (any key or string value, normalized like the scrub), a number of 10+ digits, or
    (strict) a number under a money key. ``isins``: the ISINs symbol fields carried
    (``Redactor.isins``), the only digit runs of that shape allowed through; ``non_money``: the
    paths of count-, percent- and ref-labelled numbers (``Redactor.non_money``), which a money key
    does not refuse."""
    _check_identifiers(result, frozenset(isins))
    if strict:
        _check_money_keys(result, "$", frozenset(non_money))


def _check_identifiers(node: Any, isins: frozenset[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            _check_identifiers(key, isins)
            _check_identifiers(value, isins)
    elif isinstance(node, (list, tuple)):
        for value in node:
            _check_identifiers(value, isins)
    elif isinstance(node, str):
        if identifier_in(node, isins):
            raise LeakDetected("identifier-like value in the response")
    elif (
        isinstance(node, (int, float))
        and not isinstance(node, bool)
        and _LONG_DIGITS.search(json.dumps(node))
    ):
        raise LeakDetected("identifier-like value in the response")


def _check_money_keys(node: Any, path: str, non_money: frozenset[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            where = f"{path}.{key}"
            if (
                is_money_key(key)
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and where not in non_money
            ):
                raise LeakDetected(f"number under the money key {where} in strict mode")
            _check_money_keys(value, where, non_money)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            _check_money_keys(value, f"{path}[{i}]", non_money)
