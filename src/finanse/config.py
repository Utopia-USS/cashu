"""Runtime configuration, loaded from environment / .env (prefix FINANSE_)."""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# repo root = two levels up from this file (src/finanse/config.py -> repo/)
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="FINANSE_",
        env_file=str(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Database
    database_url: str = "sqlite:///data/finanse.db"

    # Categorization — LLM fallback (opt-in). Deterministic rules always run.
    categorize_use_llm: bool = False
    categorize_llm_backend: str = "ollama"  # ollama (local, offline) | anthropic (cloud)
    # anthropic backend
    categorize_model: str = "claude-haiku-4-5"
    anthropic_api_key: str | None = None  # FINANSE_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY)
    # ollama backend (local)
    categorize_ollama_model: str = "qwen2.5:3b"
    categorize_ollama_url: str = "http://localhost:11434"

    # Enable Banking (Open Banking aggregator)
    eb_app_id: str | None = None
    eb_key_path: str = "data/enablebanking_private.pem"
    eb_base_url: str = "https://api.enablebanking.com"
    eb_redirect_url: str = "https://localhost:8000/eb/callback"
    eb_country: str = "PL"

    @property
    def eb_key_file(self) -> Path:
        """Absolute path to the Enable Banking private key PEM."""
        p = Path(self.eb_key_path)
        return p if p.is_absolute() else PROJECT_ROOT / p

    @property
    def eb_configured(self) -> bool:
        return bool(self.eb_app_id) and self.eb_key_file.exists()

    @property
    def resolved_api_key(self) -> str | None:
        import os

        return self.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")


settings = Settings()
