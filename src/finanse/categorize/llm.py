"""LLM-backed merchant categorizer (opt-in, privacy-scoped).

This module classifies otherwise-UNKNOWN merchant strings into a fixed
taxonomy using a small/fast Claude model (Haiku 4.5) via the Anthropic
Messages API over raw HTTP (``httpx``).

Privacy
-------
This is a **local personal-finance tracker**, so the network call is an
explicit, opt-in step. The public function accepts *only* merchant strings
and the taxonomy keys — nothing else. No amounts, dates, account numbers,
balances, counterparties, or any other transaction data is added to the
request or requested from the caller. Callers who never invoke this module
never send anything off-device.

Design
------
- Structured output is forced via the Messages API ``output_config.format``
  ``json_schema`` mechanism (the skill's recommended approach; no beta header
  is required for it). The schema pins each result's ``category`` to an
  ``enum`` of exactly the caller's ``category_keys`` (plus ``"other"`` /
  ``"UNKNOWN"``), so the model cannot invent categories.
- The model returns a JSON object with a ``results`` array of
  ``{id, category, confidence}`` items. Results are keyed back to the input
  merchant by the explicit ``id`` we send (``m0``, ``m1``, ...), never by
  array position.
- The taxonomy + instructions + few-shot examples live in a byte-stable
  ``system`` block marked ``cache_control: {"type": "ephemeral"}`` for prompt
  caching (no timestamps or per-request data in the prefix).
- Confidence is clamped to ``[0, 1]`` client-side (structured-output schemas
  cannot express numeric bounds).
- On any per-batch failure (HTTP error, rate limit, malformed JSON) the batch
  is skipped with a message to stderr and the loop continues. The function
  never raises for a single-batch failure; it returns whatever succeeded.
"""

from __future__ import annotations

import json
import sys

import httpx

_API_URL = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_VERSION = "2023-06-01"
_TIMEOUT_SECONDS = 60.0

# Sentinel categories the model may return in addition to the caller's keys.
_OTHER = "other"
_UNKNOWN = "UNKNOWN"


def _build_system_blocks(category_keys: list[str]) -> list[dict]:
    """Build the cacheable system prompt.

    Kept byte-stable for a given ``category_keys`` (no timestamps / per-request
    data) so the ephemeral prompt cache actually hits across batches.
    """
    categories_line = ", ".join(category_keys)
    text = (
        "You are a precise merchant-name classifier for a personal-finance "
        "tracker. Given short, noisy merchant strings (often uppercased, "
        "abbreviated, or containing payment-processor noise, mostly Polish), "
        "assign each to exactly ONE category.\n"
        "\n"
        f"Allowed categories: {categories_line}.\n"
        f'If none clearly fits, use "{_OTHER}". If the string carries no usable '
        f'signal at all, use "{_UNKNOWN}".\n'
        "\n"
        "Payment aggregators / processors are NOT a merchant category — a raw "
        'aggregator string with no underlying merchant must be "other". '
        "Examples:\n"
        '- "ZABKA" -> groceries\n'
        '- "BIEDRONKA" -> groceries\n'
        '- "ORLEN" -> fuel\n'
        '- "NETFLIX.COM" -> subscriptions\n'
        '- "UBER EATS" -> dining\n'
        '- "PAYU" -> other\n'
        '- "PRZELEWY24" -> other\n'
        "\n"
        "For every input item, output an object with its id, the chosen "
        "category (exactly one of the allowed values), and a confidence in "
        "[0,1]. Base the decision only on the merchant string itself."
    )
    return [
        {
            "type": "text",
            "text": text,
            "cache_control": {"type": "ephemeral"},
        }
    ]


def _build_schema(category_keys: list[str]) -> dict:
    """JSON schema forcing a valid category enum per result."""
    enum = list(category_keys) + [_OTHER, _UNKNOWN]
    return {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "category": {"type": "string", "enum": enum},
                        "confidence": {"type": "number"},
                    },
                    "required": ["id", "category", "confidence"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["results"],
        "additionalProperties": False,
    }


def _build_payload(
    batch: list[tuple[str, str]],
    category_keys: list[str],
    *,
    model: str,
) -> dict:
    """Build the Messages API request body for one batch.

    ``batch`` is a list of ``(id, merchant)`` pairs. Only the merchant strings
    (and the ids we generated) are placed in the request — no other data.
    """
    items = [{"id": item_id, "merchant": merchant} for item_id, merchant in batch]
    user_text = (
        "Classify each of the following merchant strings. Return one result "
        "per item, keyed by the given id:\n"
        + json.dumps(items, ensure_ascii=False)
    )
    # Small, bounded output: a handful of tokens per item plus JSON overhead.
    max_tokens = min(16000, 80 * len(batch) + 256)
    return {
        "model": model,
        "max_tokens": max_tokens,
        "system": _build_system_blocks(category_keys),
        "messages": [{"role": "user", "content": user_text}],
        "output_config": {
            "format": {
                "type": "json_schema",
                "schema": _build_schema(category_keys),
            }
        },
    }


def _parse_batch_response(
    data: dict,
    id_to_merchant: dict[str, str],
    allowed: set[str],
) -> dict[str, dict]:
    """Extract {merchant: {category, confidence}} from one API response."""
    # output_config.format guarantees the first text block is valid JSON.
    text = next(
        (
            block.get("text", "")
            for block in data.get("content", [])
            if block.get("type") == "text"
        ),
        "",
    )
    parsed = json.loads(text)

    out: dict[str, dict] = {}
    for item in parsed.get("results", []):
        item_id = item.get("id")
        merchant = id_to_merchant.get(item_id)
        if merchant is None:
            continue  # unknown/hallucinated id — ignore

        category = item.get("category")
        if category == _UNKNOWN or category not in allowed:
            category = _OTHER

        try:
            confidence = float(item.get("confidence"))
        except (TypeError, ValueError):
            confidence = 0.0
        # Clamp to [0, 1] client-side (schema can't express numeric bounds).
        confidence = max(0.0, min(1.0, confidence))

        out[merchant] = {"category": category, "confidence": confidence}
    return out


def classify_merchants(
    merchants: list[str],
    category_keys: list[str],
    *,
    api_key: str,
    model: str = "claude-haiku-4-5",
    batch_size: int = 40,
) -> dict[str, dict]:
    """Classify each merchant string into one of category_keys.

    Returns {merchant: {"category": <key or "other">, "confidence": <float 0..1>}}.
    Missing/failed merchants are simply omitted from the result (caller handles).
    """
    # De-duplicate while preserving order; only merchant strings leave the box.
    unique_merchants = list(dict.fromkeys(m for m in merchants if m))
    if not unique_merchants or not category_keys:
        return {}

    allowed = set(category_keys) | {_OTHER}
    headers = {
        "x-api-key": api_key,
        "anthropic-version": _ANTHROPIC_VERSION,
        "content-type": "application/json",
    }

    results: dict[str, dict] = {}
    with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
        for start in range(0, len(unique_merchants), batch_size):
            chunk = unique_merchants[start : start + batch_size]
            # Explicit per-batch ids; results are keyed back by these, not by
            # array position.
            batch = [(f"m{i}", merchant) for i, merchant in enumerate(chunk)]
            id_to_merchant = {item_id: merchant for item_id, merchant in batch}
            payload = _build_payload(batch, category_keys, model=model)

            try:
                response = client.post(_API_URL, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                results.update(
                    _parse_batch_response(data, id_to_merchant, allowed)
                )
            except Exception as exc:  # noqa: BLE001 — skip batch, keep going
                print(
                    f"[finanse.categorize.llm] batch {start // batch_size} "
                    f"({len(chunk)} merchants) failed, skipping: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                continue

    return results
