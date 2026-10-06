"""Runtime configuration, loaded from environment / .env (prefix CASHU_).

Personal files live in the per-user data dir (see ``core.paths``); secrets live in
the OS keychain (see ``core.secrets``), with environment variables as a fallback
for CI and development.
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import (
    BaseSettings,
    DotEnvSettingsSource,
    EnvSettingsSource,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

from .core import paths
from .core.env import LEGACY_PREFIX
from .core.paths import PROJECT_ROOT  # noqa: F401  (re-exported for older imports)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CASHU_",
        env_file=str(paths.PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Database. Unset = <data dir>/cashu.db (see core.paths / db.resolve_database_url).
    database_url: str | None = None

    # Default profile (slug) for the CLI and the legacy /api/* aliases.
    # Unset = the oldest profile (see core.profiles).
    profile: str | None = None  # CASHU_PROFILE

    # Dashboard server (`cashu serve`). Loopback only by default.
    host: str = "127.0.0.1"  # CASHU_HOST
    port: int = 8500  # CASHU_PORT

    # Categorization — LLM fallback (opt-in). Deterministic rules always run.
    categorize_use_llm: bool = False
    categorize_llm_backend: str = "ollama"  # ollama (local, offline) | anthropic (cloud)
    # anthropic backend; the key normally lives in the OS keychain
    # (`cashu secrets set anthropic`), this env var is the CI/dev fallback.
    categorize_model: str = "claude-haiku-4-5"
    anthropic_api_key: SecretStr | None = None  # CASHU_ANTHROPIC_API_KEY
    # ollama backend (local)
    categorize_ollama_model: str = "qwen2.5:3b"
    categorize_ollama_url: str = "http://localhost:11434"

    # Enable Banking (Open Banking aggregator)
    eb_app_id: str | None = None
    eb_key_path: str | None = None  # unset = <data dir>/enablebanking_private.pem
    eb_base_url: str = "https://api.enablebanking.com"
    eb_redirect_url: str = "https://localhost:8000/eb/callback"
    eb_country: str = "PL"

    # App update check (core/updates.py): the dashboard compares the running version with
    # project.version of pyproject.toml on this GitHub branch and shows a notice when it is higher.
    update_check: bool = True  # CASHU_UPDATE_CHECK
    update_repo: str = "Utopia-USS/cashu"  # CASHU_UPDATE_REPO (owner/name)
    update_branch: str = "main"  # CASHU_UPDATE_BRANCH

    # Background worker (`cashu worker install`): the cashU executable the scheduled
    # job runs. Unset = the packaged app binary, else the venv's `cashu` script.
    worker_program: str | None = None  # CASHU_WORKER_PROGRAM

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """``CASHU_*`` first (environment, then .env); the pre-rename names (legacy name
        ``FINANSE_*``) only fill what is still unset, so an old .env or launchd plist keeps working."""
        env_file = settings_cls.model_config.get("env_file")
        legacy_env = EnvSettingsSource(settings_cls, env_prefix=LEGACY_PREFIX)
        legacy_dotenv = DotEnvSettingsSource(
            settings_cls, env_file=env_file, env_prefix=LEGACY_PREFIX
        )
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            legacy_env,
            legacy_dotenv,
            file_secret_settings,
        )

    @property
    def eb_key_file(self) -> Path:
        """Absolute path to the Enable Banking private key PEM.

        ``CASHU_EB_KEY_PATH`` wins (relative = against the repo root, as before);
        the old default ``data/enablebanking_private.pem`` counts as unset."""
        if self.eb_key_path:
            p = Path(self.eb_key_path).expanduser()
            p = p if p.is_absolute() else paths.PROJECT_ROOT / p
            if p.resolve() != (paths.LEGACY_DIR / paths.EB_KEY_FILENAME).resolve():
                return p
        return paths.eb_key_path()

    @property
    def eb_configured(self) -> bool:
        return bool(self.eb_app_id) and self.eb_key_file.exists()

    @property
    def resolved_api_key(self) -> str | None:
        """Anthropic API key: OS keychain first, then CASHU_ANTHROPIC_API_KEY,
        then ANTHROPIC_API_KEY. Never log the returned value."""
        from .core import secrets

        stored = secrets.get_secret(secrets.ANTHROPIC)
        if stored:
            return stored
        if self.anthropic_api_key is not None and self.anthropic_api_key.get_secret_value():
            return self.anthropic_api_key.get_secret_value()
        return os.environ.get("ANTHROPIC_API_KEY") or None


settings = Settings()
