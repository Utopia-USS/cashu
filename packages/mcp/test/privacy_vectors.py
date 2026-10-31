"""Differential vectors for the TS MCP privacy layer (scope S37): Python is the oracle.

Writes ``packages/mcp/test/vectors/*.jsonl`` from the Python modules the TS code ports
(``core/mcp/{redaction,labels,names,registry}.py``, ``core/mcp/tools/messages.py``,
``modules/investments/rules/expr/privacy.py``, ``macro/texts.summary_ok``). Everything is synthetic:
seeded random texts and trees built from invented names, IBAN-shaped strings with valid check digits
and made-up amounts; no dataset is opened (the payee key is a fixed test key).

    .venv/bin/python packages/mcp/test/privacy_vectors.py           # rewrite the vectors
    .venv/bin/python packages/mcp/test/privacy_vectors.py --check   # fail when they would change
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import random
import re
import sys
import unicodedata
from decimal import Decimal
from pathlib import Path

from cashu.core.mcp import labels as L
from cashu.core.mcp import names as N
from cashu.core.mcp.redaction import (
    LeakDetected,
    Redactor,
    UnlabelledValue,
    isin_valid,
    leak_check,
    scrub_text,
)
from cashu.core.mcp.registry import ToolError, ToolSpec, validate_arguments
from cashu.core.mcp.tools.messages import scrub_numbers
from cashu.modules.investments.macro.texts import summary_ok, vocabulary
from cashu.modules.investments.rules.expr import parser as P
from cashu.modules.investments.rules.expr.catalog import METRICS
from cashu.modules.investments.rules.expr.lexer import ExpressionError
from cashu.modules.investments.rules.expr.privacy import scrub_amount_literals

OUT = Path(__file__).resolve().parent / "vectors"
SECRET = hashlib.sha256(b"cashu-ts-privacy-vectors").digest()
SEED = 37

# --------------------------------------------------------------------------- synthetic fragments

FIRST = ["Anna", "Jan", "Zofia", "Grzegorz", "Łucja", "Ewa", "Piotr", "Tomasz", "Kasia", "Oliwia", "Iga", "Igor"]
LAST = ["Nowak", "Wiśniewska", "Kowalski", "Brzęczyszczykiewicz", "Żółć", "Lis", "Dąbrowska", "Sikorski"]
BUSINESS = ["BIEDRONKA 123", "ORLEN STACJA 7", "ABC SP. Z O.O.", "NETFLIX.COM", "WSPOLNOTA MIESZKANIOWA",
            "JAN BAR", "BAR MLECZNY POD ORLEM", "PKO BANK POLSKI", "Sklep u Ani", "CAFE NERO"]
CURRENCIES = ["PLN", "EUR", "USD", "zł", "złotych", "zl", "euro", "€", "$", "£", "RON", "gr", "groszy", "dolarów", "CHF"]
MONEY_WORDS = ["price", "prıce", "PRİCE", "cena", "cash", "kwota", "value", "wartość", "koszt", "saldo", "balance",
               "deposit", "wpłata", "wypłaty", "fee", "tax", "prowizja", "opłata", "income", "ıncome", "expenses",
               "przychód", "wydatki", "rata", "installment", "worth"]
YEAR_WORDS = ["in", "ın", "w", "rok", "since", "sınce", "od", "do", "until", "from", "przed", "po", "IN", "Since"]
ACCOUNT_WORDS = ["konto", "Konto nr", "rachunek", "rachunku", "account", "acct", "nr", "numer", "no.", "No:"]
UNI_DIGITS = ["0123456789", "٠١٢٣٤٥٦٧٨٩", "۰۱۲۳۴۵۶۷۸۹", "０１２３４５６７８９", "०१२३४५६७८९", "𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗"]
SEPS = [" ", "  ", " ", ".", "/", "_", "-", "", " ", "'", ","]
WORDS = ["Bucket", "plan", "per", "month", "drift", "row", "rule", "rebalance_check", "the", "of", "above",
         "target", "zamknięcie", "powyżej", "spadła", "o", "Pozycja", "przelew", "dla", "Rozmowa", "z", "i",
         "p.", "tys.", "k", "mln", "mld", "bn", "pp", "%", "days", "dni", "r.", "rok", "@", "#", ":", ";", "(", ")"]


def iban(rng: random.Random) -> str:
    country = rng.choice(["PL", "DE", "GB", "FR", "LT"])
    body = "".join(rng.choice("0123456789") for _ in range(rng.choice([18, 20, 22, 24])))
    check = 98 - int(body + "".join(str(ord(c) - 55) for c in country) + "00") % 97
    return f"{country}{check:02d}{body}"


def spaced(rng: random.Random, digits: str) -> str:
    sep = rng.choice(SEPS)
    size = rng.choice([2, 3, 4])
    return sep.join(digits[i : i + size] for i in range(0, len(digits), size))


def uni(rng: random.Random, digits: str) -> str:
    table = rng.choice(UNI_DIGITS)
    return "".join(table[int(d)] for d in digits)


def num(rng: random.Random, lo: int = 0, hi: int = 9_999_999) -> str:
    n = rng.randint(lo, hi)
    shape = rng.randrange(8)
    if shape == 0:
        return f"{n:,}".replace(",", rng.choice([" ", " ", " ", "'", ",", "."]))
    if shape == 1:
        return f"{n}{rng.choice(['.', ','])}{rng.randint(0, 99):02d}"
    if shape == 2:
        return rng.choice(["-", "+", ""]) + str(n)
    if shape == 3:
        return uni(rng, str(n))
    return str(n)


def isin(rng: random.Random, valid: bool) -> str:
    base = rng.choice(["US", "IE", "PL", "DE", "LU"]) + "".join(
        rng.choice("0123456789ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(9)
    )
    for d in "0123456789":
        if isin_valid(base + d) == valid:
            return base + d
    return base + "0"


def name(rng: random.Random) -> str:
    out = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
    shape = rng.randrange(6)
    if shape == 0:
        out = out.upper()
    elif shape == 1:
        out = N.fold(out)
    elif shape == 2:
        out = " ".join(reversed(out.split()))
    elif shape == 3:
        out = out.lower()
    return out


def fragment(rng: random.Random, names: list[str]) -> str:
    kind = rng.randrange(26)
    if kind == 0:
        return iban(rng)
    if kind == 1:
        return spaced(rng, iban(rng))
    if kind == 2:
        return spaced(rng, "".join(rng.choice("0123456789") for _ in range(rng.randint(8, 26))))
    if kind == 3:
        return uni(rng, "".join(rng.choice("0123456789") for _ in range(rng.randint(4, 16))))
    if kind == 4:
        return f"{num(rng)}{rng.choice(['', ' ', chr(0xA0)])}{rng.choice(CURRENCIES)}"
    if kind == 5:
        return f"{rng.choice(CURRENCIES)}{rng.choice(['', ' '])}{num(rng)}"
    if kind == 6:
        return f"{rng.choice(MONEY_WORDS)}{rng.choice([' ', ': ', ' of the ', ' was '])}{num(rng)}"
    if kind == 7:
        return f"{rng.choice(YEAR_WORDS)} {rng.randint(1890, 2110)}"
    if kind == 8:
        return f"{rng.randint(1900, 2100)}{rng.choice(['', ' r.', ' rok', '-09', '-Q3'])}"
    if kind == 9:
        y, m, d = rng.randint(1990, 2030), rng.randint(1, 12), rng.randint(1, 28)
        return rng.choice([f"{y}-{m:02d}-{d:02d}", f"{y}-{m:02d}-{d:02d}T{rng.randint(0, 23):02d}:15:00+00:00",
                           f"{m:02d}/{y}", f"{y}-{m:02d}"])
    if kind == 10:
        return isin(rng, rng.random() < 0.6)
    if kind == 11:
        return f"{rng.choice(['a.b', 'jan.nowak', 'x+y'])}@{rng.choice(['example.com', 'mail.pl', 'x.co.uk'])}"
    if kind == 12:
        return f"{rng.choice(ACCOUNT_WORDS)} {spaced(rng, str(rng.randint(10**5, 10**9)))}"
    if kind == 13:
        return f"{rng.choice('UAB')}{rng.randint(10**5, 10**9)}"
    if kind == 14:
        return rng.choice(names) if names and rng.random() < 0.7 else name(rng)
    if kind == 15:
        return f"{rng.randint(0, 999)}{rng.choice(['.', ','])}{rng.randint(0, 9)}{rng.choice(['%', ' %', ' pp', 'pp'])}"
    if kind == 16:
        return f"{rng.randint(1, 999)}{rng.choice(['', ' '])}{rng.choice(['tys.', 'tysięcy', 'TYSİĘCY', 'k', 'K', 'mln', 'mld', 'bn', 'm'])}"
    if kind == 17:
        return ".".join(f"{rng.randint(0, 9999):04d}" for _ in range(rng.randint(3, 5)))
    if kind == 18:
        return rng.choice(["\x00", "a\x00b", "", "\x00\x00", "\n", "\t"])
    if kind == 19:
        return rng.choice(BUSINESS)
    if kind == 20:
        return "".join(chr(rng.choice([rng.randint(0x41, 0x7A), rng.randint(0xC0, 0x17F), rng.randint(0x391, 0x3C9),
                                       rng.randint(0x1F600, 0x1F64F), rng.randint(0x10400, 0x1044F)]))
                       for _ in range(rng.randint(1, 6)))
    if kind == 21:
        return f"{rng.randint(1, 9999)}{rng.choice(['', ' '])}{rng.choice(['days', 'dni', 'day', 'units'])}"
    if kind == 22:
        return str(rng.randint(0, 99999))
    if kind == 23:
        return rng.choice(["rules[3]", "line 12", "column 4", "row 7", "(got 1.5)", "-480", "12 345,67"])
    return rng.choice(WORDS)


def text(rng: random.Random, names: list[str], n: int | None = None) -> str:
    parts = [fragment(rng, names) for _ in range(n if n is not None else rng.randint(1, 7))]
    return "".join(p + rng.choice([" ", " ", ", ", "", "; ", " - ", " ", "/"]) for p in parts).strip()


# --------------------------------------------------------------------------- guards


def guard(rng: random.Random, gid: int) -> tuple[dict, N.NameGuard]:
    persons = [f"{rng.choice(FIRST)} {rng.choice(LAST)}" for _ in range(rng.randint(1, 4))]
    names: set[str] = set()
    for p in persons:
        names |= N._name_terms(p, tokens=rng.random() < 0.5)
    names = {n for n in names if N.fold(n) not in N.BUSINESS_MARKERS}
    payees = {N.normalize(rng.choice(persons + BUSINESS)) for _ in range(rng.randint(0, 3))}
    aliases = []
    for _ in range(rng.randint(0, 2)):
        alias = rng.choice(["Wesele 45000 Kasi", "IKE Oli 2030", "Na mieszkanie dla Tomka Lis", "Cel 50k Tomek",
                            "Studia Ani 1 200 zł", "Mój ETF", "iShares dla Igi", "İKE Igi"])
        aliases.append((alias, rng.choice(["Public Market Name", "iShares Core MSCI World", "PKO Bank Polski"])))
    pid = rng.randint(1, 40)
    g = N.NameGuard(pid, frozenset(names), frozenset(payees), SECRET, strict_aliases=tuple(aliases))
    spec = {"id": gid, "profile_id": pid, "names": sorted(names), "private_payees": sorted(payees),
            "strict_aliases": [list(a) for a in aliases]}
    return spec, g


# --------------------------------------------------------------------------- typed values


def enc(value) -> dict:
    if value is None:
        return {"T": "none"}
    if isinstance(value, bool):
        return {"T": "bool", "V": value}
    if isinstance(value, int):
        return {"T": "int", "V": str(value)}
    if isinstance(value, float):
        return {"T": "float", "V": repr(value)}
    if isinstance(value, Decimal):
        return {"T": "dec", "V": str(value)}
    if isinstance(value, dt.datetime):
        return {"T": "dt", "V": value.isoformat()}
    if isinstance(value, str):
        return {"T": "str", "V": value}
    raise TypeError(type(value))


def rand_float(rng: random.Random) -> float:
    shape = rng.randrange(8)
    if shape == 0:
        return rng.choice([float("nan"), float("inf"), -float("inf"), 0.0, -0.0, 1e16, 1e-5, 123456789012.5])
    if shape == 1:
        return rng.uniform(-1, 1)
    if shape == 2:
        return rng.uniform(0, 1e7) * rng.choice([1, 3.98765432, 4.31234567])
    return round(rng.uniform(-1e6, 1e6), rng.randint(0, 12))


def rand_numeric(rng: random.Random):
    shape = rng.randrange(4)
    if shape == 0:
        return rng.randint(-10**7, 10**7)
    if shape == 1:
        return Decimal(f"{rng.randint(-10**9, 10**9)}E{rng.randint(-9, 3)}")
    return rand_float(rng)


def rand_value(rng: random.Random, names: list[str]):
    kind = rng.randrange(9)
    if kind == 0:
        return None
    if kind == 1:
        return rng.random() < 0.5
    if kind == 2:
        return rng.randint(-10**13, 10**13)
    if kind == 3:
        return rand_float(rng)
    if kind == 4:
        return Decimal(f"{rng.randint(-10**8, 10**8)}E{rng.randint(-6, 2)}")
    if kind == 5:
        tz = rng.choice([None, dt.UTC, dt.timezone(dt.timedelta(hours=2)), dt.timezone(-dt.timedelta(hours=5, minutes=30))])
        return dt.datetime(2026, rng.randint(1, 12), rng.randint(1, 28), rng.randint(0, 23), rng.randint(0, 59),
                           rng.randint(0, 59), rng.choice([0, 0, 123456]), tzinfo=tz)
    return text(rng, names, rng.randint(1, 3))


def leaf(rng: random.Random, names: list[str], summaries: list[str]):
    label = rng.choice(list(L.Sensitivity))
    roll = rng.random()
    if roll < 0.04:
        value = rand_value(rng, names)  # any type: wrong ones must fail closed
    elif label is L.Sensitivity.AMOUNT:
        return L.amount(rand_numeric(rng), rng.choice([2, 8]))
    elif label is L.Sensitivity.PERCENT:
        return L.pct(rand_numeric(rng))
    elif label is L.Sensitivity.LEVEL:
        return L.level(rand_numeric(rng))
    elif label is L.Sensitivity.COUNT:
        value = rng.randint(-5, 10**6)
    elif label is L.Sensitivity.FLAG:
        value = rng.random() < 0.5
    elif label is L.Sensitivity.REF:
        value = rng.choice([rng.randint(1, 10**12), "payee:abcdefghij", f"signal:{rng.randint(10**6, 10**9)}",
                            "x y", "١٢٣", str(rng.randint(1, 999)), "a:12345", "123\n"])
    elif label is L.Sensitivity.DATE:
        value = rng.choice([rand_value(rng, names), f"2026-{rng.randint(1, 12):02d}-0{rng.randint(1, 9)}", "2026-10",
                            "yesterday", "2026-10-01T12:00:00+00:00", "٢٠٢٦-١٠-٠١"])
        if isinstance(value, dt.datetime) or rng.random() < 0.5:
            value = rand_value(rng, names) if rng.random() < 0.2 else dt.datetime(
                2026, 3, 1, 1, 30, tzinfo=rng.choice([None, dt.UTC, dt.timezone(dt.timedelta(hours=-3))]))
    elif label is L.Sensitivity.SYMBOL:
        value = rng.choice([isin(rng, True), isin(rng, False), "AAPL", "CDR", "0700", "123456", "BRK.B", "EUNL",
                            rng.choice(names) if names else "KOWALSKI", "JAN KOWALSKI 15000", "12345\n", "^GSPC"])
    elif label is L.Sensitivity.MERCHANT:
        value = rng.choice([rng.choice(names) if names else name(rng), name(rng), rng.choice(BUSINESS),
                            "payee:" + iban(rng), "payee:abcdefghij", text(rng, names, 2)])
    elif label is L.Sensitivity.MARKET:
        value = rng.choice([rng.choice(sorted(L.MARKET_LABELS)), f"{rng.randint(-999, 999)},{rng.randint(0, 9)} %",
                            "1 234 mld", "+12 pp", rng.choice(summaries), text(rng, names, 2), "4,23 %\n"])
    else:
        value = text(rng, names)
    return L.Labelled(value, label)


KEYS = sorted(["amount", "value", "values", "total", "cash", "quantity", "net", "weight", "name", "message",
               "note", "iban", "payee", "symbol", "when", "items", "rows", "id", "account", "price", "fee", "a_b",
               "x1", "_private", "income"])
BAD_KEYS = ["Konto Jana", "PL61109010140000071219812874", "abc\n", "__proto__", "Value", "1abc", "a" * 65]


def tree(rng: random.Random, names: list[str], summaries: list[str], depth: int = 0):
    roll = rng.random()
    if depth >= 3 or roll < 0.35:
        r = rng.random()
        if r < 0.01:
            return rand_value(rng, names)  # unlabelled leaf
        if r < 0.04:
            return None
        return leaf(rng, names, summaries)
    if roll < 0.7:
        out = {}
        for _ in range(rng.randint(0, 5)):
            key = rng.choice(BAD_KEYS) if rng.random() < 0.02 else rng.choice(KEYS)
            out[key] = tree(rng, names, summaries, depth + 1)
        return out
    return [tree(rng, names, summaries, depth + 1) for _ in range(rng.randint(0, 4))]


def enc_tree(node):
    if isinstance(node, L.Labelled):
        return {"L": str(node.label.value), **enc(node.value)}
    if node is None:
        return {"N": 1}
    if isinstance(node, dict):
        return {"D": [[k, enc_tree(v)] for k, v in node.items()]}
    if isinstance(node, list):
        return {"A": [enc_tree(v) for v in node]}
    return {"R": enc(node)}


# --------------------------------------------------------------------------- sections


def blocks(fn) -> list[str]:
    out = []
    for block in range(0x110000 // 4096):
        h = hashlib.sha256()
        for c in range(block * 4096, (block + 1) * 4096):
            if 0xD800 <= c <= 0xDFFF:
                continue
            h.update(fn(chr(c)).encode("utf-8", "surrogatepass"))
            h.update(b"\0")
        out.append(h.hexdigest()[:16])
    return out


def classes() -> dict:
    w, d = re.compile(r"\w"), re.compile(r"\d")
    return {
        "w": blocks(lambda c: "1" if w.match(c) else "0"),
        "d": blocks(lambda c: "1" if d.match(c) else "0"),
        "isdigit": blocks(lambda c: "1" if c.isdigit() else "0"),
        "casefold": blocks(lambda c: c.casefold()),
        "fold": blocks(N.fold),
        "word_letters": blocks(lambda c: "1" if re.match(r"[^\W\d_]", c) else "0"),
    }


def texts_section(rng: random.Random, guards: list[tuple[dict, N.NameGuard]]) -> dict:
    out = []
    for i in range(3000):
        gspec, g = rng.choice(guards) if rng.random() < 0.6 else (None, None)
        names = sorted(g.names) if g else []
        t = text(rng, names)
        if g and g.strict_aliases and rng.random() < 0.3:
            t = f"{t} {rng.choice(g.strict_aliases)[0]} {text(rng, names, 1)}"
        row = {"text": t, "guard": gspec["id"] if gspec else None}
        for strict in (True, False):
            row["strict" if strict else "amounts"] = scrub_text(t, strict=strict, guard=g)
        row["isin"] = isin_valid(t)
        row["numbers"] = scrub_numbers(t)
        if i % 3 == 0:
            isins = {isin(rng, True) for _ in range(2)}
            sample = t + " " + " ".join(sorted(isins))
            try:
                leak_check({"note": sample}, strict=False, isins=isins)
                leak = False
            except LeakDetected:
                leak = True
            row["leak"] = {"sample": sample, "isins": sorted(isins), "leak": leak}
        out.append(row)
    return {"rows": out}


def names_section(rng: random.Random, guards: list[tuple[dict, N.NameGuard]]) -> dict:
    rows = []
    for _ in range(1500):
        gspec, g = rng.choice(guards)
        names = sorted(g.names)
        candidate = rng.choice([name(rng), rng.choice(BUSINESS), text(rng, names, 2),
                                rng.choice(names) if names else "X", f"{name(rng)} UL. POLNA 5 WARSZAWA",
                                f"{rng.choice(LAST).upper()} {rng.choice(FIRST).upper()}", "J. Z. KOWALSKI",
                                "Anna Nowak-Kowalska", ""])
        mask_text = text(rng, names, 3) + " " + candidate
        public_input = candidate if rng.random() < 0.5 or not g.strict_aliases else f"  {g.strict_aliases[0][0].upper()} "
        swap_input = candidate + (" " + g.strict_aliases[0][0] if g.strict_aliases else "")
        rows.append({
            "guard": gspec["id"],
            "value": candidate,
            "fold": N.fold(candidate),
            "normalize": N.normalize(candidate),
            "person_part": N.person_part(candidate),
            "looks_like_person": N.looks_like_person(candidate),
            "terms": sorted(N._name_terms(candidate, tokens=False)),
            "terms_tokens": sorted(N._name_terms(candidate, tokens=True)),
            "is_private": g.is_private(candidate),
            "payee_ref": g.payee_ref(candidate),
            "merchant": g.merchant(candidate),
            "mask_input": mask_text,
            "mask": g.mask(mask_text),
            "public_input": public_input,
            "public_name": g.public_name(public_input),
            "swap_input": swap_input,
            "swap": g.swap_aliases(swap_input),
        })
    return {"rows": rows}


def masks_section(rng: random.Random, guards: list[tuple[dict, N.NameGuard]]) -> dict:
    rows = []
    for _ in range(1500):
        gspec, g = rng.choice(guards)
        names = sorted(g.names)
        t = text(rng, names, rng.randint(1, 5))
        refs = [rng.choice(names + BUSINESS) for _ in range(3)]
        target = rng.choice(refs)
        rows.append({
            "guard": gspec["id"], "text": t, "mask": g.mask(t),
            "candidates": refs, "resolve_ref": g.resolve(g.payee_ref(target), refs),
            "resolve_name": g.resolve(target.lower(), refs), "resolve_target": target,
        })
    return {"rows": rows}


def collect_section(rng: random.Random) -> dict:
    """``names.collect`` over invented provider outputs (the DB part is the providers' job)."""
    rows = []
    for _ in range(400):
        profile = rng.choice([name(rng), f"Rodzina {rng.choice(LAST)}", "Dom", "", "Jan"])
        accounts = [rng.choice(["IKE", "Konto", f"Konto {name(rng)}", name(rng), "Wspólne 2", None, "mBank 1"])
                    for _ in range(rng.randint(0, 4))]
        providers = []
        for _ in range(2):
            strong = [rng.choice(["KOWALSKI", "Pożyczka dla Jana Lisa", name(rng), "IKE"]) for _ in range(rng.randint(0, 2))]
            persons = [rng.choice([name(rng), f"{name(rng)} 950", f"{name(rng)} UL. POLNA 5", "BANK"])
                       for _ in range(rng.randint(0, 3))]
            private = [rng.choice([name(rng), rng.choice(BUSINESS), f"przelew {name(rng)}"]) for _ in range(rng.randint(0, 3))]
            aliases = [[rng.choice(["Mój ETF", "IKE Oli 2030"]), "Public"] for _ in range(rng.randint(0, 1))]
            providers.append({"strong": strong, "persons": persons, "private": private, "aliases": aliases})
        names: set[str] = set()
        names |= N._name_terms(profile or "", tokens=True)
        for a in accounts:
            names |= N._name_terms(a or "", tokens=False)
        payees: set[str] = set()
        aliases_out: list = []
        for pr in providers:
            for s in pr["strong"]:
                names |= N._name_terms(s, tokens=True)
                names |= N._name_terms(" ".join(N.person_part(s)), tokens=True)
            for p in pr["persons"]:
                names |= N._name_terms(p, tokens=False)
                names |= N._name_terms(" ".join(N.person_part(p)), tokens=False)
            payees |= {N.normalize(p) for p in pr["private"]}
            for p in pr["private"]:
                if N.looks_like_person(p):
                    names |= N._name_terms(" ".join(N.person_part(p)), tokens=False)
            aliases_out.extend(pr["aliases"])
        names = {n for n in names if N.fold(n) not in N.BUSINESS_MARKERS}
        rows.append({"profile": profile, "accounts": accounts, "providers": providers,
                     "names": sorted(names), "payees": sorted(payees), "aliases": aliases_out})
    return {"rows": rows}


def labels_section(rng: random.Random) -> dict:
    rows = []
    for _ in range(2000):
        v = rand_numeric(rng)
        base = rand_numeric(rng) if rng.random() < 0.9 else rng.choice([0, 0.0, Decimal("0E+3"), None])
        digits = rng.choice([2, 8, 0, 6])
        row = {"v": enc(v), "digits": digits, "amount": enc(L.amount(v, digits).value), "pct": enc(L.pct(v).value),
               "level": enc(L.level(v).value), "base": enc(base)}
        try:
            row["share"] = enc(L.share(v, base).value)
        except Exception as e:  # noqa: BLE001 - decimal.InvalidOperation (inf / inf)
            row["share"] = {"error": type(e).__name__}
        if isinstance(v, float) and v == v and abs(v) < 1e13:
            big = v * rng.choice([1, 1e3, 1e6, 1e9])
            row["compact"] = {"v": repr(big), "out": L.compact_number(big)}
        rows.append(row)
    return {"rows": rows}


def market_section(rng: random.Random, summaries: list[str]) -> dict:
    rows = []
    vocab = sorted(vocabulary())
    for _ in range(3000):
        s = rng.choice(summaries)
        roll = rng.randrange(6)
        if roll == 0:
            s = s.replace(".", "", 1)
        elif roll == 1:
            s = s + " " + rng.choice(vocab + ["Kowalski", "12345", "PLN"]) + "."
        elif roll == 2:
            s = rng.choice(sorted(L.MARKET_LABELS)) + rng.choice(["", "\n", " ", "x"])
        elif roll == 3:
            s = f"{rng.choice(['', '+', '-'])}{rng.randint(0, 999)}{rng.choice(['', ' 000', ' 123 456'])}" \
                f"{rng.choice(['', ',5', ',25'])}{rng.choice(['', ' %', ' pp', ' bp', ' mln', ' mld', '%'])}"
        elif roll == 4:
            s = text(rng, [], 3) + "."
        rows.append({"text": s, "market_ok": L.market_ok(s), "summary_ok": summary_ok(s)})
    return {"vocabulary": vocab, "summary_max": 140, "rows": rows}


def macro_summaries(rng: random.Random) -> list[str]:
    vocab = sorted(vocabulary())
    out = []
    for _ in range(200):
        words = [rng.choice(vocab) for _ in range(rng.randint(3, 12))]
        nums = [f"{rng.randint(-99, 99)},{rng.randint(0, 9)} %", f"{rng.randint(0, 999)} pp"]
        parts = words + rng.sample(nums, rng.randint(0, 2))
        rng.shuffle(parts)
        out.append(" ".join(parts) + rng.choice([".", ".", ": x."]))
    return out


def trees_section(rng: random.Random, guards: list[tuple[dict, N.NameGuard]], summaries: list[str]) -> dict:
    rows = []
    for _ in range(2500):
        gspec, g = rng.choice(guards) if rng.random() < 0.8 else (None, None)
        names = sorted(g.names) if g else []
        t = tree(rng, names, summaries)
        row = {"guard": gspec["id"] if gspec else None, "tree": enc_tree(t)}
        for privacy in ("strict", "amounts"):
            r = Redactor(privacy, g)
            # the vectors use only the market vocabulary checker the TS test also builds
            try:
                data = r.apply(t)
                try:
                    leak_check(data, strict=r.strict, isins=r.isins)
                    row[privacy] = {"out": json.dumps(data, ensure_ascii=False), "isins": sorted(r.isins)}
                except LeakDetected:
                    row[privacy] = {"error": "leak", "isins": sorted(r.isins)}
            except UnlabelledValue:
                row[privacy] = {"error": "unlabelled"}
        rows.append(row)
    return {"rows": rows}


# --- expressions

def ast(node):
    match node:
        case P.Number(value=v, text=t, column=c):
            return {"kind": "number", "value": str(v), "text": t, "column": c}
        case P.String(value=v, column=c):
            return {"kind": "string", "value": v, "column": c}
        case P.Boolean(value=v, column=c):
            return {"kind": "boolean", "value": v, "column": c}
        case P.Name(name=n, column=c):
            return {"kind": "name", "name": n, "column": c}
        case P.Call(name=n, args=a, column=c):
            return {"kind": "call", "name": n, "args": [ast(x) for x in a], "column": c}
        case P.Unary(op=o, operand=x, column=c):
            return {"kind": "unary", "op": o, "operand": ast(x), "column": c}
        case P.Binary(op=o, left=lft, right=rgt, column=c):
            return {"kind": "binary", "op": o, "left": ast(lft), "right": ast(rgt), "column": c}
        case P.Compare(op=o, left=lft, right=rgt, column=c):
            return {"kind": "compare", "op": o, "left": ast(lft), "right": ast(rgt), "column": c}
        case P.Logical(op=o, operands=xs, column=c):
            return {"kind": "logical", "op": o, "operands": [ast(x) for x in xs], "column": c}
    raise TypeError(type(node))


ORACLE_EXPRESSIONS = [
    "cash_value > 735", "weight < 0.03 and value > 800", "drawdown_from_high(252) >= 20% and weight < 3%",
    "days_since_last_deposit > 45", "last_close > 120", "cash_value / total_value > 0.1",
    "total_value - cash_value < -50", "cash_value >", "broken ( 500 and 5%", "last_close * 40 > 5000",
    "weight * 120000 > 900", "last_close + 15 > 120", "40 * last_close > 5000", "weight * 100 > 5",
    "drawdown_from_high(252) / 2 > 0.1", "weight > 900 / 120000", "last_close > 5000 / 40", "weight > 5 * 0.01",
    "weight > 5% / 100", "weight > 1 / 100", "cash_value > 7 and cash_weight < 99%",
]


def expressions_section(rng: random.Random) -> dict:
    metric_names = sorted(METRICS)
    units = {n: str(METRICS[n].unit.value) if METRICS[n].unit is not None else None for n in metric_names}
    sources = list(ORACLE_EXPRESSIONS)
    numbers = ["0", "1", "100", "1.0", "100.00", "0.03", "5%", "20%", "45", "735", "5000", ".5", "1e3", "7"]
    for _ in range(1000):
        def operand():
            r = rng.random()
            if r < 0.4:
                return rng.choice(numbers)
            if r < 0.8:
                return rng.choice(metric_names)
            return f"{rng.choice(metric_names)}({rng.choice(['252', '20', '5%', ''])})"
        def arith(depth=0):
            if depth > 1 or rng.random() < 0.5:
                return operand()
            return f"{arith(depth + 1)} {rng.choice(['+', '-', '*', '/'])} {arith(depth + 1)}"
        def comp():
            return f"{arith()} {rng.choice(['<', '<=', '>', '>=', '==', '!='])} {arith()}"
        expr = comp()
        for _ in range(rng.randint(0, 2)):
            expr = f"{expr} {rng.choice(['and', 'or'])} {rng.choice([comp(), 'not ' + comp(), '(' + comp() + ')'])}"
        if rng.random() < 0.1:
            expr = expr.replace(" ", rng.choice(["", "  "]), 1)
        if rng.random() < 0.05:
            expr += rng.choice([" (", " and", " 12 34", " ł 5"])
        sources.append(expr)
    rows = []
    for s in sources:
        try:
            tree_ = ast(P.parse(s))
        except ExpressionError:
            tree_ = None
        rows.append({"source": s, "ast": tree_, "scrubbed": scrub_amount_literals(s),
                     "scrubbed_private": scrub_amount_literals(s, private_prices=True)})
    return {"units": units, "rows": rows}


# --- registry

def _noop(ctx, **kw):
    return {}


SPECS = [
    ToolSpec("t_basic", "core", "basic", _noop,
             properties={"query": {"type": "string", "maxLength": 20}, "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
                         "status": {"type": "string", "enum": ["open", "history", "all"], "default": "open"},
                         "weight": {"type": "number"}, "flag": {"type": "boolean"}, "params": {"type": "object"},
                         "ids": {"type": "array"}},
             required=("query",), refused={"converter": "MCP never runs converters; use a connector.", "profile": "One profile per server."},
             refused_values={"status": {"macro": "Use the macro tool for macro notes."}}),
    ToolSpec("t_nullable", "investments", "nullable", _noop,
             properties={"segment": {"type": "string", "enum": ["a", "b"]}, "note": {"type": "string"}},
             nullable=("segment",), also=("budget",)),
]


def registry_section(rng: random.Random) -> dict:
    values = [None, True, False, 0, 1, 7, 51, -3, 2.5, "x", "open", "macro", "history", "a" * 21, "", {}, {"a": 1}, [], [1], "b", "zz"]
    names = ["query", "limit", "status", "weight", "flag", "params", "ids", "converter", "profile", "unknown_x",
             "segment", "note", "zeta"]
    specs = []
    for s in SPECS:
        specs.append({"name": s.name, "module": s.module, "properties": [[k, v] for k, v in s.properties.items()], "required": list(s.required),
                      "refused": s.refused, "refused_values": s.refused_values, "nullable": list(s.nullable),
                      "also": list(s.also), "input_schema": s.input_schema,
                      "enabled": {m: s.enabled_in({m}) for m in ("budget", "investments", "loans")},
                      "listed": {m: s.listed_module({m}) for m in ("budget", "investments", "loans")}})
    rows = []
    for _ in range(1500):
        spec = rng.choice(SPECS)
        args = {}
        for _ in range(rng.randint(0, 4)):
            args[rng.choice(names)] = rng.choice(values)
        if rng.random() < 0.5:
            args.setdefault("query", "abc")
        if rng.random() < 0.5 and spec.nullable:
            args.setdefault("segment", rng.choice([None, "a", "c"]))
        try:
            out = {"ok": validate_arguments(spec, args)}
        except ToolError as e:
            out = {"error": str(e), "kind": e.kind}
        rows.append({"spec": spec.name, "args": args, **out})
    return {"specs": specs, "rows": rows}


# --------------------------------------------------------------------------- main


def build() -> dict[str, str]:
    rng = random.Random(SEED)
    guards = [guard(rng, i) for i in range(12)]
    summaries = macro_summaries(rng)
    sections = {
        "classes": classes(),
        "guards": {"secret_hex": SECRET.hex(), "guards": [g[0] for g in guards]},
        "texts": texts_section(rng, guards),
        "names": names_section(rng, guards),
        "masks": masks_section(rng, guards),
        "collect": collect_section(rng),
        "labels": labels_section(rng),
        "market": market_section(rng, summaries),
        "trees": {"summaries": summaries, **trees_section(rng, guards, summaries)},
        "expressions": expressions_section(rng),
        "registry": registry_section(rng),
    }
    return {k: _jsonl(v) for k, v in sections.items()}


def _jsonl(section: dict) -> str:
    """JSON Lines (as the domain vectors; formatters leave ``.jsonl`` alone): the section's fields
    without its rows on the first line, then one row per line."""
    dump = lambda v: json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))  # noqa: E731
    head = {k: v for k, v in section.items() if k != "rows"}
    rows = section.get("rows", [])
    return "".join(dump(x) + "\n" for x in [{**head, "count": len(rows)}, *rows])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)
    files = build()
    OUT.mkdir(exist_ok=True)
    changed = []
    for name_, body in files.items():
        path = OUT / f"{name_}.jsonl"
        if not path.exists() or path.read_text(encoding="utf-8") != body:
            changed.append(name_)
            if not args.check:
                path.write_text(body, encoding="utf-8")
        print(f"{name_:12} {len(body):>9} bytes sha256={hashlib.sha256(body.encode()).hexdigest()[:16]}")
    print(f"unicode {unicodedata.unidata_version}")
    if args.check and changed:
        print("would change:", ", ".join(changed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
