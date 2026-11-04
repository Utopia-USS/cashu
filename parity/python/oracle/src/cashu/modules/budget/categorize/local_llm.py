"""Local LLM merchant classifier via Ollama — fully offline, zero data egress.

Same contract as `llm.classify_merchants` (the cloud Claude backend), so the two
are interchangeable. Uses Ollama's structured-output `format` (a JSON schema) to
constrain the category to the allowed enum. Sends only merchant strings.
"""

from __future__ import annotations

import json
import sys

import httpx


def _schema(category_keys: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "category": {"type": "string", "enum": [*category_keys, "other"]},
                        "confidence": {"type": "number"},
                    },
                    "required": ["id", "category"],
                },
            }
        },
        "required": ["results"],
    }


def _system_prompt(category_keys: list[str]) -> str:
    return (
        "You categorize Polish bank-transaction merchant strings into exactly one "
        "category key from this list:\n" + ", ".join(category_keys) + "\n"
        "Rules: pick the single best key; if unsure use \"other\". "
        "Examples: ZABKA->groceries, ORLEN->fuel, NETFLIX.COM->subscriptions, "
        "UBER EATS->dining, UBER *TRIP->transport, TAURON->utilities, "
        "APTEKA->health, ALLEGRO->shopping, PAYU/PRZELEWY24->other. "
        "Return JSON {\"results\":[{\"id\",\"category\",\"confidence\"}]} for every input id."
    )


def _txn_system_prompt(labels: dict[str, str]) -> str:
    cats = "\n".join(f"{k} = {v}" for k, v in labels.items())
    return (
        "Kategoryzujesz polskie transakcje bankowe. Dla KAŻDEJ transakcji wybierz "
        "dokładnie jeden klucz kategorii z listy:\n" + cats + "\n\n"
        "Zasady:\n"
        "- Używaj WSZYSTKICH danych: odbiorcy/nadawcy, tytułu, opisu, kwoty i kierunku.\n"
        "- Kwota dodatnia = WPŁYW => kategoria income_* (income_salary dla pensji, "
        "income_refund dla zwrotów, inaczej income_other).\n"
        "- BRAMKI PŁATNICZE i BLIK (PayU, PayPro, Przelewy24/P24, DotPay, Blue Media, "
        "Autopay, PayPal, SumUp, eCard/ECARD, Tpay, Cinkciarz): nazwa operatora to NIE "
        "jest kategoria. Znajdź prawdziwego sprzedawcę w tytule/opisie "
        "(np. 'PayU*Allegro' => shopping, 'BLIK ... ALLEGRO' => shopping, "
        "'PayPal *STEAM' => entertainment, 'PRZELEWY24 GLOVO' => dining). Jeśli "
        "prawdziwego sprzedawcy NIE MA w danych: zakup e-commerce/kartą nieznany => "
        "shopping; przelew/BLIK do osoby prywatnej => other; naprawdę nieznane => other.\n"
        "- Ten sam sprzedawca MOŻE mieć różne kategorie — oceniaj każdą transakcję po "
        "jej treści, nie po samej nazwie.\n"
        "- Przykłady: ZABKA/LIDL/BIEDRONKA => groceries, ORLEN/BP/STACJA PALIW => fuel, "
        "NETFLIX/SPOTIFY => subscriptions, UBER EATS/GLOVO/PYSZNE => dining, "
        "UBER/BOLT/MPK => transport, APTEKA/PRZYCHODNIA => health, ALLEGRO/AMAZON => "
        "shopping, TAURON/ORANGE/PLAY => utilities, BOOKING/AIRBNB => travel, "
        "ZUS/URZAD SKARBOWY => taxes.\n"
        "- Jeśli niepewne => other (dla wpływów income_other).\n"
        "Zwróć JSON {\"results\":[{\"id\",\"category\",\"confidence\"}]} dla każdego id."
    )


def classify_transactions(
    items: list[tuple[str, str]],
    category_keys: list[str],
    labels: dict[str, str],
    *,
    model: str = "qwen2.5:3b",
    url: str = "http://localhost:11434",
    batch_size: int = 20,
    timeout: float = 300.0,
    progress=None,
) -> dict[str, dict]:
    """Classify full transaction contexts. `items` = [(id, context_text)].

    Returns {id: {"category", "confidence"}}; ids missing from the result were not
    classified (caller decides the fallback). Unlike classify_merchants this feeds
    the model the whole transaction (counterparty + title + description + amount),
    so payment-gateway rows are resolved by their embedded merchant, not the operator."""
    allowed = {*category_keys, "other"}
    out: dict[str, dict] = {}
    schema = _schema(category_keys)
    system = _txn_system_prompt(labels)
    total = len(items)

    with httpx.Client(timeout=timeout) as client:
        for start in range(0, total, batch_size):
            batch = items[start:start + batch_size]
            listing = "\n\n".join(f"[{tid}]\n{ctx}" for tid, ctx in batch)
            payload = {
                "model": model,
                "stream": False,
                "format": schema,
                "options": {"temperature": 0},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": "Sklasyfikuj transakcje:\n\n" + listing},
                ],
            }
            try:
                resp = client.post(f"{url.rstrip('/')}/api/chat", json=payload)
                resp.raise_for_status()
                content = resp.json()["message"]["content"]
                results = json.loads(content).get("results", [])
            except (httpx.HTTPError, KeyError, json.JSONDecodeError) as e:
                print(f"[local_llm] batch failed: {e}", file=sys.stderr)
                results = []
            for r in results:
                tid = str(r.get("id"))
                cat = r.get("category")
                if cat not in allowed:
                    cat = "other"
                conf = r.get("confidence", 0.5)
                try:
                    conf = max(0.0, min(1.0, float(conf)))
                except (TypeError, ValueError):
                    conf = 0.5
                out[tid] = {"category": cat, "confidence": conf}
            if progress is not None:
                progress(min(start + batch_size, total), total)
    return out


def classify_merchants(
    merchants: list[str],
    category_keys: list[str],
    *,
    model: str = "qwen2.5:3b",
    url: str = "http://localhost:11434",
    batch_size: int = 20,
    timeout: float = 180.0,
) -> dict[str, dict]:
    """{merchant: {"category": key, "confidence": float}} — failures omitted."""
    merchants = [m for m in dict.fromkeys(merchants) if m]  # de-dupe, keep order
    allowed = {*category_keys, "other"}
    out: dict[str, dict] = {}
    schema = _schema(category_keys)
    system = _system_prompt(category_keys)

    with httpx.Client(timeout=timeout) as client:
        for start in range(0, len(merchants), batch_size):
            batch = merchants[start:start + batch_size]
            ids = {f"m{i}": m for i, m in enumerate(batch)}
            listing = "\n".join(f"{k}: {v}" for k, v in ids.items())
            payload = {
                "model": model,
                "stream": False,
                "format": schema,
                "options": {"temperature": 0},
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": "Classify:\n" + listing},
                ],
            }
            try:
                resp = client.post(f"{url.rstrip('/')}/api/chat", json=payload)
                resp.raise_for_status()
                content = resp.json()["message"]["content"]
                results = json.loads(content).get("results", [])
            except (httpx.HTTPError, KeyError, json.JSONDecodeError) as e:
                print(f"[local_llm] batch failed: {e}", file=sys.stderr)
                continue
            for r in results:
                merchant = ids.get(str(r.get("id")))
                if not merchant:
                    continue
                cat = r.get("category")
                if cat not in allowed:
                    cat = "other"
                conf = r.get("confidence", 0.5)
                try:
                    conf = max(0.0, min(1.0, float(conf)))
                except (TypeError, ValueError):
                    conf = 0.5
                out[merchant] = {"category": cat, "confidence": conf}
    return out
