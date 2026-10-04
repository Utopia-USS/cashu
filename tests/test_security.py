"""Local API protection: Host allowlist, per-launch token, token meta tag,
loopback-only `finanse serve` (FINANSE_HOST / FINANSE_PORT, not HOST / PORT)."""

from __future__ import annotations

import stat
import sys

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from finanse import db
from finanse.core import paths, security

TOKEN = "test-token-0123456789abcdefghijklmnop"
PORT = 8500


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("FINANSE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv(security.TOKEN_ENV, raising=False)
    monkeypatch.setattr(security, "_config", None)
    engine = db.make_engine(f"sqlite:///{tmp_path / 'api.db'}")
    monkeypatch.setattr(db, "engine", engine)
    yield
    engine.dispose()


@pytest.fixture
def client():
    from finanse.api.app import app

    security.configure(token=TOKEN, port=PORT)
    with TestClient(app, base_url=f"http://127.0.0.1:{PORT}") as c:  # no default token
        yield c


AUTH = {security.TOKEN_HEADER: TOKEN}


# --------------------------------------------------------------------------- #
# Token
# --------------------------------------------------------------------------- #

def test_api_without_token_is_rejected(client):
    r = client.get("/api/summary")
    assert r.status_code == 401
    assert "token" in r.json()["detail"].lower()


def test_api_with_wrong_token_is_rejected(client):
    assert client.get("/api/summary", headers={security.TOKEN_HEADER: "nope"}).status_code == 401


def test_valid_request_is_accepted(client):
    r = client.get("/api/summary", headers=AUTH)
    assert r.status_code == 200
    assert "networth" in r.json()
    assert client.get("/api/accounts", headers=AUTH).status_code == 200


def test_cross_origin_form_post_without_token_is_rejected(client):
    """The CSRF from F0: a hostile page auto-submitting a form to /api/resync
    (rejected by the middleware before any endpoint code runs)."""
    r = client.post(
        "/api/resync",
        headers={"Origin": "https://evil.example", "Content-Type": "application/x-www-form-urlencoded"},
        content="x=1",
    )
    assert r.status_code == 401
    r = client.post(
        "/api/merchant-category",
        headers={"Origin": "https://evil.example"},
        json={"merchant_key": "TEST", "category": "groceries"},
    )
    assert r.status_code == 401


def test_no_cors_is_granted(client):
    r = client.options(
        "/api/summary",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET",
                 "Access-Control-Request-Headers": security.TOKEN_HEADER},
    )
    assert r.status_code == 401
    assert "access-control-allow-origin" not in r.headers
    ok = client.get("/api/summary", headers={**AUTH, "Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in ok.headers


def test_docs_and_unknown_paths_need_the_token_too(client):
    assert client.get("/api/docs").status_code == 401
    assert client.get("/openapi.json").status_code == 401
    assert client.get("/whatever").status_code == 401


# --------------------------------------------------------------------------- #
# Host check (DNS rebinding)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "host",
    ["attacker.example", f"attacker.example:{PORT}", "127.0.0.1:9999", "localhost",
     f"192.168.1.10:{PORT}", f"[::1]:{PORT}", f"127.0.0.1.nip.io:{PORT}"],
)
def test_wrong_host_is_rejected_even_with_token(client, host):
    r = client.get("/api/summary", headers={**AUTH, "Host": host})
    assert r.status_code == 400
    page = client.get("/", headers={"Host": host})
    assert page.status_code == 400
    assert TOKEN not in page.text


@pytest.mark.parametrize("host", [f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"LOCALHOST:{PORT}"])
def test_loopback_hosts_on_the_serving_port_are_accepted(client, host):
    assert client.get("/api/summary", headers={**AUTH, "Host": host}).status_code == 200


def test_host_allowed_rules():
    cfg = security.SecurityConfig(token=TOKEN, port=80)
    assert cfg.host_allowed("localhost")  # no port = 80
    assert cfg.host_allowed("127.0.0.1:80")
    assert not cfg.host_allowed(None)
    assert not cfg.host_allowed("")
    assert not cfg.host_allowed("localhost:8080")


# --------------------------------------------------------------------------- #
# SPA token meta tag
# --------------------------------------------------------------------------- #

def test_index_carries_token_meta_for_valid_host(client):
    r = client.get("/")
    assert r.status_code == 200
    assert f'<meta name="finanse-token" content="{TOKEN}" />' in r.text
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["content-type"].startswith("text/html")


def test_static_files_are_public_but_host_checked(client):
    assert client.get("/static/index.html").status_code == 200
    assert client.get("/static/index.html", headers={"Host": "evil.example"}).status_code == 400


def test_inject_token_meta():
    html = '<!doctype html><html><HEAD lang="pl"><title>x</title></head></html>'
    out = security.inject_token_meta(html, "abc")
    assert out.index('<meta name="finanse-token" content="abc" />') > out.index("<HEAD")
    assert security.inject_token_meta("<p>no head</p>", "abc").startswith("<meta")


# --------------------------------------------------------------------------- #
# Token lifecycle
# --------------------------------------------------------------------------- #

def test_token_file_is_owner_only_and_removed_only_if_ours(tmp_path):
    path = security.write_token_file("first")
    assert path == paths.token_path()
    assert security.read_token_file() == "first"
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    security.write_token_file("second")  # another server started meanwhile
    security.remove_token_file("first")
    assert security.read_token_file() == "second"
    security.remove_token_file("second")
    assert not path.exists()


def test_tokens_are_random_and_reload_worker_inherits(monkeypatch):
    assert security.generate_token() != security.generate_token()
    assert len(security.generate_token()) >= 40
    monkeypatch.setenv(security.TOKEN_ENV, "from-parent")
    assert security.get_config().token == "from-parent"


# --------------------------------------------------------------------------- #
# finanse serve
# --------------------------------------------------------------------------- #

@pytest.fixture
def fake_uvicorn(monkeypatch):
    import uvicorn

    calls: list[dict] = []

    def fake_run(app_path, **kwargs):
        cfg = security.get_config()
        calls.append({
            "app": app_path, **kwargs, "token": cfg.token, "cfg_port": cfg.port,
            "token_file": security.read_token_file(),
        })

    monkeypatch.setattr(uvicorn, "run", fake_run)
    return calls


def test_serve_binds_loopback_and_ignores_generic_host_port(fake_uvicorn, monkeypatch):
    from finanse.cli import app

    monkeypatch.setenv("HOST", "0.0.0.0")
    monkeypatch.setenv("PORT", "1234")
    monkeypatch.delenv("FINANSE_HOST", raising=False)
    monkeypatch.delenv("FINANSE_PORT", raising=False)
    result = CliRunner().invoke(app, ["serve"])
    assert result.exit_code == 0, result.output
    (call,) = fake_uvicorn
    assert call["host"] == "127.0.0.1" and call["port"] == 8500 and call["cfg_port"] == 8500
    assert call["token_file"] == call["token"]  # written before the server starts
    assert len(call["token"]) >= 40
    assert not paths.token_path().exists()  # removed on shutdown


def test_serve_reads_finanse_host_and_port(fake_uvicorn, monkeypatch):
    from finanse.cli import app

    monkeypatch.setenv("FINANSE_HOST", "localhost")
    monkeypatch.setenv("FINANSE_PORT", "8611")
    result = CliRunner().invoke(app, ["serve"])
    assert result.exit_code == 0, result.output
    (call,) = fake_uvicorn
    assert (call["host"], call["port"], call["cfg_port"]) == ("localhost", 8611, 8611)


def test_serve_warns_on_non_loopback_bind(fake_uvicorn):
    from finanse.cli import app

    result = CliRunner().invoke(app, ["serve", "--host", "0.0.0.0", "--port", "8622"])
    assert result.exit_code == 0, result.output
    assert "only answers requests addressed to" in " ".join(result.stdout.split())


def test_serve_reload_hands_token_to_worker(fake_uvicorn, monkeypatch):
    from finanse.cli import app

    monkeypatch.setenv(security.TOKEN_ENV, "")  # registered for cleanup by monkeypatch
    monkeypatch.setenv("FINANSE_PORT", "8633")
    result = CliRunner().invoke(app, ["serve", "--reload"])
    assert result.exit_code == 0, result.output
    (call,) = fake_uvicorn
    import os

    assert call["reload"] is True
    assert os.environ[security.TOKEN_ENV] == call["token"]
    assert os.environ["FINANSE_PORT"] == "8633"
