"""Settings read the data dir's .env too: the packaged app has no source checkout, so the Enable
Banking app id (and any other CASHU_ setting) must be configurable next to the key and the DB."""

from __future__ import annotations

from cashu.config import Settings
from cashu.core import paths


def test_the_data_dir_env_file_is_read_and_wins_over_the_checkout(monkeypatch):
    env_files = Settings.model_config["env_file"]
    data_env = paths.data_dir() / ".env"
    assert env_files[-1] == str(data_env)  # the later file wins

    monkeypatch.delenv("CASHU_EB_APP_ID", raising=False)
    paths.ensure_private_dir(data_env.parent)
    data_env.write_text("CASHU_EB_APP_ID=test-app-id-from-data-dir\n", encoding="utf-8")
    try:
        assert Settings().eb_app_id == "test-app-id-from-data-dir"
    finally:
        data_env.unlink()
    assert Settings().eb_app_id != "test-app-id-from-data-dir"
