"""Backend dispatcher for the optional LLM categorization fallback."""

from __future__ import annotations


def classify_unknown(merchants: list[str], category_keys: list[str]) -> tuple[dict[str, dict], str | None]:
    """Classify unknown merchants via the configured backend.

    Returns (results, error). `error` is a human-readable string when the backend
    couldn't run (e.g. missing API key / Ollama unreachable), else None.
    """
    from ..config import settings

    backend = (settings.categorize_llm_backend or "ollama").lower()

    if backend == "ollama":
        from . import local_llm

        try:
            results = local_llm.classify_merchants(
                merchants,
                category_keys,
                model=settings.categorize_ollama_model,
                url=settings.categorize_ollama_url,
            )
        except Exception as e:  # connection refused etc.
            return {}, f"Ollama unreachable at {settings.categorize_ollama_url} ({e})"
        if not results:
            return {}, (
                f"Ollama returned nothing (is it running? model '{settings.categorize_ollama_model}' pulled?)"
            )
        return results, None

    # anthropic (cloud)
    key = settings.resolved_api_key
    if not key:
        return {}, "no API key (set ANTHROPIC_API_KEY, or FINANSE_CATEGORIZE_LLM_BACKEND=ollama)"
    from . import llm

    return llm.classify_merchants(merchants, category_keys, api_key=key, model=settings.categorize_model), None
