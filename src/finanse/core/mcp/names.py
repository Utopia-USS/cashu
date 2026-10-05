"""Person names the MCP layer must never send (identifiers in both privacy modes).

Sources, per call and per profile: the profile's name, the stored account names, and from the budget
module the counterparties of the profile's own transfers (usually the owner's name) and bank-transfer
payees that look like a private person (no business marker such as "SP Z O O", "SKLEP", "BANK"). Card
merchants (no counterparty account number) are businesses and are sent as they are.

A private-person payee is replaced by an opaque reference ``payee:<10 hex>`` (an HMAC of the merchant
key with a per-installation secret, so a reference cannot be reversed by guessing names);
``set_merchant_category`` accepts the reference instead of the name. Known names inside free text are
replaced by ``[name]``, matching case- and diacritic-insensitively on word boundaries.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib
import re
import secrets
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field
from itertools import permutations

from sqlmodel import Session, select

from .. import paths
from ..models import Account, Profile

REF_PREFIX = "payee:"
_HEX_TO_LETTERS = str.maketrans("0123456789abcdef", "abcdefghijklmnop")
_REF = re.compile(r"^payee:[a-p]{10}$")  # hex digest spelled with letters: never a digit run

# Words that mark an organisation, not a person (normalized: upper case, no diacritics, no dots).
BUSINESS_MARKERS = frozenset(
    """
    SP OO ZOO SA SK SKA SPJ SPOLKA SPOLDZIELNIA SPOLDZIELCZY SKLEP SKLEPY SHOP STORE STORES
    MARKET SUPERMARKET HIPERMARKET MARKETS BANK BANKU URZAD SKARBOWY SKARBOWA US ZUS KRUS GMINA
    GMINY MIASTO MIASTA POWIAT WOJEWODZTWO WSPOLNOTA WSPOLNOTY MIESZKANIOWA MIESZKANIOWY
    MIESZKANIOWE FUNDACJA STOWARZYSZENIE PHU PPHU FHU PPH PHP FPHU ZAKLAD ZAKLADY USLUGI
    USLUGOWY USLUGOWE SERWIS SERVICE SERVICES STACJA APTEKA APTEKI RESTAURACJA BAR CAFE
    KAWIARNIA PIEKARNIA HOTEL KLUB CENTRUM SZKOLA PRZEDSZKOLE UCZELNIA UNIWERSYTET KANCELARIA
    BIURO GROUP GRUPA HOLDING LTD LLC INC GMBH AG CO CORP COMPANY POLSKA POLAND ENERGIA ENERGA
    TAURON PGE ENEA ORANGE PLAY PLUS TMOBILE NETIA UPC VECTRA INSURANCE UBEZPIECZENIA
    UBEZPIECZEN TU TUIR PZU LEASING FINANCE FINANSE CREDIT KREDYT KREDYTU POZYCZKA TOWARZYSTWO
    INWESTYCYJNE TFI DOM MAKLERSKI BROKER ADMINISTRACJA ZARZAD NIERUCHOMOSCI OPERATOR GAZOWNIA
    WODOCIAGI WODOCIAGOW CIEPLOWNICTWO PARAFIA KOSCIOL ALLEGRO PAYU PAYPAL REVOLUT WISE STRIPE
    PRZELEWY24 DOTPAY BLIK TPAY POCZTA POLSKA PKP PKO MBANK ING SANTANDER PEKAO ERSTE MILLENNIUM
    ALIOR CITI NEST VELO PROFIT FIRMA HANDEL HANDLOWE HANDLOWA PRODUKCJA TRANSPORT AUTO MOTO
    GARAGE WARSZTAT SALON STUDIO GABINET KLINIKA SZPITAL PRZYCHODNIA MEDICAL MEDICOVER LUXMED
    ENEL FORTUM VEOLIA OPLATA OPLATY RATA PODATEK CZYNSZ
    """.split()  # noqa: SIM905 - a word list reads better as text
)

_FOLD_EXTRA = {
    "Ł": "L",
    "ł": "L",
    "Đ": "D",
    "đ": "D",
    "Ø": "O",
    "ø": "O",
    "ß": "SS",
    "Æ": "AE",
    "æ": "AE",
}


def _fold_char(ch: str) -> str:
    if ch in _FOLD_EXTRA:
        return _FOLD_EXTRA[ch]
    decomposed = unicodedata.normalize("NFKD", ch)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).upper()


def fold(text: str) -> str:
    """Upper case without diacritics (``"Łoś"`` -> ``"LOS"``)."""
    return "".join(_fold_char(c) for c in text)


def normalize(text: str | None) -> str:
    """Folded, dots and commas removed, whitespace collapsed (merchant comparison key)."""
    folded = fold(text or "")
    folded = re.sub(r"[.,]", "", folded)
    return re.sub(r"\s+", " ", folded).strip()


_TOKEN = re.compile(r"^[A-Z][A-Z'-]*$")
# Markers that are also plausible surnames or first names: they only count with another marker or in
# names of 3+ words ("JAN BAR" is a person, "BAR MLECZNY POD ORLEM" is not).
AMBIGUOUS_MARKERS = frozenset(
    """
    DOM BAR PLUS AUTO MOTO SALON STUDIO PLAY NEST VELO PROFIT CO US TU AG SK SA ING CITI WISE
    SERWIS FIRMA HANDEL BIURO KLUB HOTEL ORANGE
    """.split()  # noqa: SIM905 - a word list reads better as text
)
# Where an address starts after a name ("ANNA NOWAK UL. POLNA 5 WARSZAWA").
_ADDRESS = frozenset(
    """
    UL ULICA AL ALEJA ALEJE OS OSIEDLE PL PLAC KOD ADRES
    """.split()  # noqa: SIM905 - a word list reads better as text
)


def _tokens(text: str | None) -> list[str]:
    tokens = normalize(text).replace("-", " - ").split()
    return [t for t in tokens if t != "-"]


def person_part(text: str | None) -> list[str]:
    """The leading words before an address or a number ("ANNA NOWAK UL POLNA 5" -> ANNA NOWAK)."""
    out: list[str] = []
    for t in _tokens(text):
        if t in _ADDRESS or any(c.isdigit() for c in t):
            break
        out.append(t)
    return out


def looks_like_person(text: str | None) -> bool:
    """2-4 words of letters (initials allowed) before any address, none of them a business marker
    (an ambiguous marker counts only next to another marker or in a longer name)."""
    tokens = person_part(text)
    if not 2 <= len(tokens) <= 4:
        return False
    if any(not _TOKEN.match(t) for t in tokens):
        return False
    if sum(len(t) >= 2 for t in tokens) < 1:
        return False
    strong = [t for t in tokens if t in BUSINESS_MARKERS and t not in AMBIGUOUS_MARKERS]
    weak = [t for t in tokens if t in AMBIGUOUS_MARKERS]
    if strong:
        return False
    return not (weak and (len(weak) >= 2 or len(tokens) >= 3))


def _name_terms(name: str, *, tokens: bool) -> set[str]:
    """Folded terms to mask for a known name: the whole name (2+ words), and with ``tokens`` each
    word of 3+ letters (a profile name is a person's or household's name)."""
    words = [w for w in re.split(r"[^\w'-]+", fold(name)) if w]
    out: set[str] = set()
    if len(words) >= 2:
        out.add(" ".join(words))
    if tokens or len(words) == 1:
        out |= {w for w in words if len(w) >= 3 and not w.isdigit()}
    if not tokens and len(words) == 1:
        out = set()  # a one-word account name ("IKE", "Konto") is not a person's name
    return out


def _secret() -> bytes:
    path = paths.data_dir() / "mcp" / "payee.key"
    try:
        data = path.read_bytes()
        if len(data) >= 32:
            return data
    except OSError:
        pass
    paths.ensure_private_dir(paths.data_dir())
    paths.ensure_private_dir(path.parent)
    data = secrets.token_bytes(32)
    tmp = path.with_name(".payee.key.tmp")
    tmp.write_bytes(data)
    tmp.chmod(0o600)
    tmp.replace(path)
    return data


@dataclass
class NameGuard:
    profile_id: int
    names: frozenset[str] = frozenset()
    """Folded terms masked in free text."""
    private_payees: frozenset[str] = frozenset()
    """Normalized merchant keys treated as private persons."""
    _secret: bytes | None = field(default=None, repr=False)
    strict_aliases: tuple[tuple[str, str], ...] = ()
    """(owner-typed label, public replacement) pairs swapped in free text in strict mode only: a
    profile's display-name override of a market instrument becomes its shared market name (F6 V6)."""

    def swap_aliases(self, text: str) -> str:
        """``text`` with every owner-typed alias replaced by its public name (case-insensitive,
        whole words, longest first)."""
        if not text or not self.strict_aliases:
            return text
        for alias, public in sorted(self.strict_aliases, key=lambda a: len(a[0]), reverse=True):
            pattern = r"(?<![\w])" + re.escape(alias) + r"(?![\w])"
            text = re.sub(pattern, lambda _m, public=public: public, text, flags=re.IGNORECASE)
        return text

    def public_name(self, label: str | None) -> str | None:
        """The shared market name when ``label`` is (exactly, ignoring case and outer spaces) one
        of the owner-typed aliases, else ``label`` (F7 review R6: structured name fields carry
        the market name in strict mode, not only free text)."""
        if not label or not self.strict_aliases:
            return label
        key = label.strip().casefold()
        for alias, public in self.strict_aliases:
            if alias.strip().casefold() == key:
                return public
        return label

    def is_private(self, merchant: str) -> bool:
        key = normalize(merchant)
        if key in self.private_payees:
            return True
        folded = " ".join(re.split(r"[^\w'-]+", fold(merchant))).strip()
        if any(_contains_term(folded, term) for term in self.names):
            return True
        # the same words in another order ("NOWAK ANNA" for a known "ANNA NOWAK")
        words = set(folded.split())
        return any(len(t) >= 2 and t <= words for t in self._name_sets)

    @property
    def _name_sets(self) -> list[frozenset[str]]:
        return [frozenset(n.split()) for n in self.names if " " in n]

    def payee_ref(self, merchant: str) -> str:
        if self._secret is None:
            self._secret = _secret()
        msg = f"{self.profile_id}:{normalize(merchant)}".encode()
        digest = hmac.new(self._secret, msg, hashlib.sha256).hexdigest()[:10]
        return REF_PREFIX + digest.translate(_HEX_TO_LETTERS)

    def merchant(self, value: str | None) -> str | None:
        if value is None:
            return None
        return self.payee_ref(value) if self.is_private(value) else value

    def resolve(self, value: str, candidates: Iterable[str]) -> str | None:
        """The candidate merchant key behind ``value`` (a ``payee:`` ref or the key itself)."""
        if _REF.match(value or ""):
            for c in candidates:
                if self.payee_ref(c) == value:
                    return c
            return None
        key = normalize(value)
        return next((c for c in candidates if normalize(c) == key), None)

    def mask(self, text: str) -> str:
        """Replace known names in ``text`` by ``[name]`` (case / diacritic insensitive)."""
        if not text or not self.names:
            return text
        folded_chars: list[str] = []
        index: list[int] = []
        for i, ch in enumerate(text):
            f = _fold_char(ch)
            for c in f:
                folded_chars.append(c)
                index.append(i)
        folded = "".join(folded_chars)
        spans: list[tuple[int, int]] = []
        for term in sorted(self.names, key=len, reverse=True):
            words = term.split()
            orders = {tuple(words)} | (set(permutations(words)) if 2 <= len(words) <= 3 else set())
            pattern = "|".join(
                r"(?<![\w])" + r"[\s,.-]+".join(map(re.escape, order)) + r"(?![\w])"
                for order in sorted(orders)
            )
            for m in re.finditer(pattern, folded):
                start, end = index[m.start()], index[m.end() - 1] + 1
                if not any(s < end and start < e for s, e in spans):
                    spans.append((start, end))
        for start, end in sorted(spans, reverse=True):
            text = text[:start] + "[name]" + text[end:]
        return text


def is_payee_ref(value: str | None) -> bool:
    return bool(value) and bool(_REF.match(value))


def _contains_term(folded: str, term: str) -> bool:
    return re.search(r"(?<![\w])" + re.escape(term) + r"(?![\w])", folded) is not None


# Modules that contribute names (each exports ``name_sources(session, profile_id) ->
# (person_names, private_payee_keys)``); a module whose tables are absent contributes nothing.
NAME_PROVIDERS = ("finanse.core.mcp.tools.budget", "finanse.core.mcp.tools.investments")


def collect(session: Session, profile: Profile) -> NameGuard:
    names: set[str] = set()
    names |= _name_terms(profile.name or "", tokens=True)
    for account_name in session.exec(
        select(Account.name).where(Account.profile_id == profile.id)
    ).all():
        names |= _name_terms(account_name or "", tokens=False)
    payees: set[str] = set()
    aliases: list[tuple[str, str]] = []
    for provider in NAME_PROVIDERS:
        module = importlib.import_module(provider)
        for strong in getattr(module, "strong_names", lambda *_: set())(session, profile.id):
            names |= _name_terms(strong, tokens=True)
            names |= _name_terms(" ".join(person_part(strong)), tokens=True)
        persons, private = module.name_sources(session, profile.id)
        for person in persons:
            names |= _name_terms(person, tokens=False)
            # also the words before a number / address ("ADAM NOWAK 950" -> "ADAM NOWAK")
            names |= _name_terms(" ".join(person_part(person)), tokens=False)
        payees |= {normalize(p) for p in private}
        for p in private:
            if looks_like_person(p):
                names |= _name_terms(" ".join(person_part(p)), tokens=False)
        aliases.extend(getattr(module, "strict_aliases", lambda *_: [])(session, profile.id))
    names = {n for n in names if fold(n) not in BUSINESS_MARKERS}
    return NameGuard(
        profile.id, frozenset(names), frozenset(payees), strict_aliases=tuple(aliases)
    )
