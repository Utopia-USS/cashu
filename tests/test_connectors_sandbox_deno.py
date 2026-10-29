"""The Deno connector tier (prototype, docs/agents/connector-runtime.md): a connector whose run[0] is
``deno`` runs with Deno's permission flags (alone, and on macOS also inside sandbox-exec). A file
connector converts a synthetic export; reads outside the connector and run dirs, the network,
subprocesses, environment variables, remote imports and a connector's deno.json are denied; a fetch
connector reaches only its manifest hosts, through the egress proxy. Skipped when deno is missing.
Synthetic data only."""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
import sys
import threading
from pathlib import Path

import pytest
from connector_support import NoSandbox, write_connector

from cashu.core.connectors import manifest as mf
from cashu.core.connectors import proxy as px
from cashu.core.connectors import runner
from cashu.core.connectors.runner import InputFile, RunTarget, execute
from cashu.core.connectors.sandbox import (
    DenoSandbox,
    MacSandbox,
    UnsupportedSandbox,
    sandbox_for,
)

DENO = shutil.which("deno", path=os.pathsep.join(mf.SYSTEM_SEARCH_PATH))
needs_deno = pytest.mark.skipif(DENO is None, reason="no deno on the fixed search path")
HAS_MAC_SANDBOX = sys.platform == "darwin" and os.path.exists("/usr/bin/sandbox-exec")


def _sandboxes():
    boxes = [pytest.param(lambda: DenoSandbox(), id="deno")]
    if HAS_MAC_SANDBOX:
        boxes.append(pytest.param(lambda: DenoSandbox(outer=MacSandbox()), id="deno+macos"))
    return boxes


SANDBOXES = _sandboxes()


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))


@pytest.fixture
def export(tmp_path) -> InputFile:
    path = tmp_path / "exports" / "history.csv"
    path.parent.mkdir()
    path.write_text(
        "date,type,amount\n2026-01-05,deposit,1000.00\n2026-02-05,deposit,250.00\n"
        "2026-03-05,withdrawal,100.00\n",
        encoding="utf-8",
    )
    return InputFile(path, "history.csv")


DENO_FILE_MANIFEST = """\
api_version: 1
id: {id}
name: Deno test connector
version: 0.1.0
module: investments
kind: file
run: [deno, main.ts]
timeout_s: 30
file:
  extensions: [csv]
"""

DENO_FETCH_MANIFEST = """\
api_version: 1
id: {id}
name: Deno fetch test
version: 0.1.0
module: investments
kind: fetch
run: [deno, main.ts]
timeout_s: 30
fetch:
  hosts: [api.example.com]
  secrets:
    - {{id: api_key, label: Klucz API}}
"""

CONVERTER = """\
interface Request { command: string; file?: { path: string; name: string } }
const req: Request = JSON.parse(await new Response(Deno.stdin.readable).text());
if (req.command === "detect") {
  const head = Deno.readTextFileSync(req.file!.path).split("\\n")[0];
  console.log(JSON.stringify({ match: head === "date,type,amount", confidence: 0.9 }));
} else {
  const rows = Deno.readTextFileSync(req.file!.path).trim().split("\\n").slice(1);
  const records = rows.map((line) => {
    const [date, type, amount] = line.split(",");
    return { record: "txn", date, type, currency: "PLN", gross_amount: amount };
  });
  console.log(JSON.stringify({
    document: { format: "cashu-import", format_version: 1, source: "deno_test", records },
  }));
}
"""

# Every attempt is recorded as "ok" or the error class name; the probe never prints a value it read.
PROBE = """\
const req = JSON.parse(await new Response(Deno.stdin.readable).text());
const out: Record<string, string> = {{}};
async function attempt(name: string, fn: () => unknown) {{
  try {{ await fn(); out[name] = "ok"; }} catch (e) {{ out[name] = (e as Error).name; }}
}}
await attempt("read_input", () => Deno.readTextFileSync(req.file.path));
await attempt("read_own_dir", () => Deno.readTextFileSync(new URL("./connector.yaml", import.meta.url)));
await attempt("read_outside", () => Deno.readTextFileSync({outside!r}));
await attempt("read_data_dir", () => Deno.readTextFileSync({data_file!r}));
await attempt("read_system", () => Deno.readTextFileSync("/etc/hosts"));
await attempt("list_home", () => [...Deno.readDirSync({home!r})]);
await attempt("write_run_dir", () => Deno.writeTextFileSync("scratch.txt", "x"));
await attempt("write_outside", () => Deno.writeTextFileSync({write_outside!r}, "x"));
await attempt("symlink_out", () => Deno.symlinkSync({outside!r}, "link"));
await attempt("connect", async () => (await Deno.connect({{ hostname: "127.0.0.1", port: {port} }})).close());
await attempt("fetch", () => fetch("http://127.0.0.1:{port}/"));
await attempt("dns", () => Deno.resolveDns("example.com", "A"));
await attempt("run", () => new Deno.Command("/bin/echo", {{ args: ["hi"] }}).outputSync());
await attempt("node_child_process", async () => (await import("node:child_process")).execSync("/bin/echo hi"));
await attempt("ffi", () => Deno.dlopen({lib!r}, {{}}));
await attempt("env_get", () => Deno.env.get("HOME"));
await attempt("env_all", () => Deno.env.toObject());
await attempt("node_env", async () => {{
  const v = (await import("node:process")).default.env.HOME;
  if (v === undefined) throw new Error("hidden");
}});
await attempt("sys", () => Deno.hostname());
await attempt("import_https", () => import("https://deno.land/std@0.224.0/path/mod.ts"));
await attempt("import_jsr", () => import("jsr:@std/path"));
await attempt("import_npm", () => import("npm:left-pad"));
await attempt("import_mapped", () => import("mapped"));
await attempt("prompt", async () => {{
  const s = await Deno.permissions.request({{ name: "env" }});
  if (s.state !== "granted") throw new Error(s.state);
}});
console.log(JSON.stringify({{ document: {{ records: [], probe: out }} }}));
"""


class _Listener:
    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.accepted = 0
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.accepted += 1
            conn.close()

    def close(self):
        self.sock.close()


def _deno_connector(root: Path, code: str, *, manifest: str = DENO_FILE_MANIFEST,
                    cid: str = "deno-test", extra: dict[str, str] | None = None) -> RunTarget:
    write_connector(root, cid=cid, manifest=manifest.format(id=cid), code="",
                    extra={"main.ts": code, **(extra or {})})
    (root / "main.py").unlink()
    return RunTarget.of(mf.load_dir(root))


# --------------------------------------------------------------------------- #
# Manifest and selection (no deno needed)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "run",
    [["deno"], ["deno", "run", "-A", "main.ts"], ["deno", "-A", "main.ts"], ["deno", "--allow-all"]],
)
def test_manifest_refuses_deno_flags(run):
    problems = mf.run_problems(run)
    assert any(p.startswith("run[1]: deno runs a script file") for p in problems)


def test_manifest_accepts_a_deno_script():
    assert mf.run_problems(["deno", "main.ts", "--verbose"]) == []


def test_deno_script_must_be_a_file_of_the_connector(tmp_path):
    root = tmp_path / "deno-test"
    write_connector(root, cid="deno-test", manifest=DENO_FILE_MANIFEST.format(id="deno-test"),
                    code="")
    with pytest.raises(mf.ManifestError, match="run\\[1\\]: main.ts is not a file"):
        mf.load_dir(root)


def test_sandbox_for_picks_deno_for_deno_connectors():
    mac = MacSandbox()
    layered = sandbox_for("deno", mac)
    assert isinstance(layered, DenoSandbox) and layered.outer is mac and layered.name == "deno+macos"
    alone = sandbox_for("deno", UnsupportedSandbox())  # Linux / Windows: Deno is the only layer
    assert isinstance(alone, DenoSandbox) and alone.outer is None and alone.name == "deno"
    native = NoSandbox()
    assert sandbox_for("python3", native) is native
    assert isinstance(sandbox_for("python3", UnsupportedSandbox()), UnsupportedSandbox)


# --------------------------------------------------------------------------- #
# Real deno runs
# --------------------------------------------------------------------------- #


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_file_connector_converts_a_synthetic_export(tmp_path, export, make_box):
    target = _deno_connector(tmp_path / "deno-test", CONVERTER)
    box = make_box()
    detect = execute(target, "detect", file=export, sandbox=box)
    assert detect.ok, (detect.error_kind, detect.message, detect.stderr_tail)
    assert detect.response.match is True
    result = execute(target, "convert", file=export, sandbox=box)
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    assert result.records == 3
    assert [r["type"] for r in result.response.document["records"]] == [
        "deposit", "deposit", "withdrawal"
    ]


@needs_deno
def test_runner_selects_deno_for_a_deno_connector(tmp_path, export, monkeypatch):
    seen = []
    original = runner.sandbox_for

    def spy(run0, native=None):
        box = original(run0, native)
        seen.append(box)
        return box

    monkeypatch.setattr(runner, "sandbox_for", spy)
    target = _deno_connector(tmp_path / "deno-test", CONVERTER)
    result = execute(target, "convert", file=export)
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    assert len(seen) == 1 and isinstance(seen[0], DenoSandbox)
    assert seen[0].name == ("deno+macos" if HAS_MAC_SANDBOX else "deno")


def _probe(tmp_path: Path, export: InputFile, box) -> tuple[dict, _Listener]:
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id_rsa").write_text("FAKE KEY", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("FAKE OUTSIDE", encoding="utf-8")
    data_file = tmp_path / "data" / "cashu.db"
    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text("FAKE DB", encoding="utf-8")
    listener = _Listener()
    lib = "/usr/lib/libSystem.B.dylib" if sys.platform == "darwin" else "/lib/x86_64-linux-gnu/libc.so.6"
    code = PROBE.format(
        outside=str(outside), data_file=str(data_file), home=str(home),
        write_outside=str(tmp_path / "written.txt"), port=listener.port, lib=lib,
    )
    # A deno.json the connector ships is ignored (--no-config): its import map and unstable flags too.
    config = '{"imports": {"mapped": "https://deno.land/std@0.224.0/path/mod.ts"}, "unstable": ["ffi"]}'
    try:
        target = _deno_connector(tmp_path / "deno-test", code, extra={"deno.json": config})
        result = execute(target, "convert", file=export, sandbox=box)
    finally:
        listener.close()
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    return result.response.document["probe"], listener


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_reads_outside_the_allowed_paths_fail(tmp_path, export, make_box):
    probe, _ = _probe(tmp_path, export, make_box())
    assert probe["read_input"] == "ok" and probe["read_own_dir"] == "ok"
    assert probe["write_run_dir"] == "ok"
    for name in ("read_outside", "read_data_dir", "read_system", "list_home", "write_outside",
                 "symlink_out"):
        assert probe[name] == "NotCapable", name
    assert not (tmp_path / "written.txt").exists()


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_network_is_denied_for_a_file_connector(tmp_path, export, make_box):
    probe, listener = _probe(tmp_path, export, make_box())
    assert probe["connect"] == "NotCapable"
    assert probe["fetch"] == "NotCapable"
    assert probe["dns"] != "ok"  # NotCapable; under sandbox-exec the resolver config is unreadable first
    assert listener.accepted == 0


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_subprocesses_and_ffi_fail(tmp_path, export, make_box):
    probe, _ = _probe(tmp_path, export, make_box())
    assert probe["run"] == "NotCapable"
    assert probe["node_child_process"] == "NotCapable"
    assert probe["ffi"] == "NotCapable"


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_environment_and_system_info_are_not_readable(tmp_path, export, make_box):
    probe, _ = _probe(tmp_path, export, make_box())
    assert probe["env_get"] == "NotCapable"
    assert probe["env_all"] == "NotCapable"
    assert probe["node_env"] == "NotCapable"
    assert probe["sys"] == "NotCapable"
    assert probe["prompt"] == "Error"  # --no-prompt: a request is denied, never asked


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_remote_imports_and_the_connector_config_are_ignored(tmp_path, export, make_box):
    probe, _ = _probe(tmp_path, export, make_box())
    for name in ("import_https", "import_jsr", "import_npm", "import_mapped"):
        assert probe[name] == "TypeError", name


FETCH_CODE = """\
const req = JSON.parse(await new Response(Deno.stdin.readable).text());
const out: Record<string, string> = {};
async function attempt(name: string, fn: () => unknown) {
  try { await fn(); out[name] = "ok"; } catch (e) { out[name] = (e as Error).name; }
}
const signal = () => AbortSignal.timeout(5000);
await attempt("allowed", () => fetch("https://api.example.com/v1/history", { signal: signal() }));
await attempt("other", () => fetch("https://other.example.org/", { signal: signal() }));
await attempt("secret_in_request", () => { if (req.secrets.api_key !== "k") throw new Error(); });
console.log(JSON.stringify({ document: { records: [], probe: out }, cursor: null }));
"""


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_fetch_reaches_only_manifest_hosts_through_the_proxy(tmp_path, monkeypatch, make_box):
    upstream = _Listener()  # the "allowed host": accepts and closes (no TLS), so fetch fails after

    tunnelled = []

    async def connect(host, port):
        tunnelled.append((host, port))
        return await asyncio.open_connection("127.0.0.1", upstream.port)

    monkeypatch.setattr(runner, "EgressProxy", lambda hosts: px.EgressProxy(hosts, connect=connect))
    try:
        target = _deno_connector(tmp_path / "deno-fetch", FETCH_CODE, manifest=DENO_FETCH_MANIFEST,
                                 cid="deno-fetch")
        result = execute(target, "fetch", sandbox=make_box(), secrets={"api_key": "k"},
                         since="2026-01-01")
    finally:
        upstream.close()
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    probe = result.response.document["probe"]
    assert probe["secret_in_request"] == "ok"
    # Tunnelled by the proxy, then the fake upstream hung up (the TLS handshake fails; the HTTP client
    # may retry the connection once, so only "at least one tunnel, all to the manifest host" is fixed).
    assert probe["allowed"] not in ("ok", "NotCapable")
    assert tunnelled and set(tunnelled) == {("api.example.com", 443)}
    assert upstream.accepted >= 1
    assert probe["other"] == "NotCapable"  # Deno refuses before anything leaves the process
    assert result.denied_hosts == []
