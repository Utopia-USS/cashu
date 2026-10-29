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
// Computed specifiers: literal ones never get this far (the module graph check refuses them).
const spec = (s: string) => [s][0];
await attempt("import_https", () => import(spec("https://deno.land/std@0.224.0/path/mod.ts")));
await attempt("import_jsr", () => import(spec("jsr:@std/path")));
await attempt("import_npm", () => import(spec("npm:left-pad")));
await attempt("import_mapped", () => import(spec("mapped")));
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
    # Linux / Windows without a native layer: nothing runs, Deno included (Deno alone lets raw sockets
    # to a manifest host past the egress proxy, and its module graph loads unchecked).
    for run0 in ("deno", "python3", "node"):
        assert isinstance(sandbox_for(run0, UnsupportedSandbox()), UnsupportedSandbox), run0
    native = NoSandbox()  # any other native layer (the Linux hook) wraps Deno the same way
    assert sandbox_for("python3", native) is native
    other = sandbox_for("deno", native)
    assert isinstance(other, DenoSandbox) and other.outer is native and other.name == "deno+none"


def test_default_sandbox_off_macos_is_unsupported_until_a_linux_layer_exists(monkeypatch):
    from cashu.core.connectors import sandbox as sb

    for platform in ("linux", "win32", "freebsd14"):
        monkeypatch.setattr(sb.sys, "platform", platform)
        assert isinstance(sb.default_sandbox(), UnsupportedSandbox), platform
        assert isinstance(sb.sandbox_for("deno"), UnsupportedSandbox), platform
    # The Linux hook: a sandbox_linux module that offers a native sandbox is used on Linux only.
    native = NoSandbox()
    monkeypatch.setattr(sb, "_linux_sandbox", lambda: native)
    monkeypatch.setattr(sb.sys, "platform", "linux")
    assert sb.default_sandbox() is native
    monkeypatch.setattr(sb.sys, "platform", "win32")
    assert isinstance(sb.default_sandbox(), UnsupportedSandbox)


def test_the_linux_hook_is_missing_for_now():
    from cashu.core.connectors import sandbox as sb

    assert sb._linux_sandbox() is None


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
    assert len(seen) == 1
    if HAS_MAC_SANDBOX:
        assert result.ok, (result.error_kind, result.message, result.stderr_tail)
        assert isinstance(seen[0], DenoSandbox) and seen[0].name == "deno+macos"
    else:  # no native layer: refused, never Deno alone
        assert isinstance(seen[0], UnsupportedSandbox)
        assert (result.outcome, result.error_kind) == ("refused", "sandbox_unavailable")


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


# --------------------------------------------------------------------------- #
# The module graph check (security review: static imports bypass --allow-read)
# --------------------------------------------------------------------------- #


def _info(root: Path, *deps: str, errors: dict[str, str] | None = None, **extra) -> dict:
    main = (root / "main.ts").as_uri()
    modules = [{
        "kind": "esm", "specifier": main,
        "dependencies": [{"specifier": d, "code": {"specifier": d}} for d in deps],
    }]
    for spec, err in (errors or {}).items():
        modules.append({"specifier": spec, "error": err})
    return {"version": 1, "roots": [main], "modules": modules, "redirects": {}, "npmPackages": {},
            **extra}


def test_graph_rule_accepts_connector_files_and_node_builtins(tmp_path):
    root = tmp_path / "conn"
    (root / "lib").mkdir(parents=True)
    info = _info(root, (root / "lib" / "parse.ts").as_uri(), "node:path", (root / "a b.json").as_uri())
    assert mf_graph(info, root) is None


@pytest.mark.parametrize(
    ("dep", "fragment"),
    [
        ("file:///etc/hosts", "outside the connector"),
        ("file://otherhost/conn/x.ts", "outside the connector"),
        ("data:text/javascript,export default 1", "not data: modules"),
        ("blob:null/1234", "not blob: modules"),
        ("https://deno.land/std/path/mod.ts", "not https: modules"),
        ("npm:left-pad", "not npm: modules"),
        ("jsr:@std/path", "not jsr: modules"),
    ],
)
def test_graph_rule_refuses_outside_and_non_file_modules(tmp_path, dep, fragment):
    root = tmp_path / "conn"
    root.mkdir()
    problem = mf_graph(_info(root, dep), root)
    assert problem is not None and fragment in problem
    assert "/etc" not in problem and "deno.land" not in problem  # value-free


def test_graph_rule_resolves_dotdot_and_symlinks(tmp_path):
    root = tmp_path / "conn"
    root.mkdir()
    (tmp_path / "secret.json").write_text("{}", encoding="utf-8")
    dotdot = "file://" + str(root) + "/../secret.json"
    assert "outside" in mf_graph(_info(root, dotdot), root)
    (root / "link.json").symlink_to(tmp_path / "secret.json")
    assert "outside" in mf_graph(_info(root, (root / "link.json").as_uri()), root)
    sibling = tmp_path / "conn-evil" / "x.ts"  # a prefix of the connector path is not inside it
    assert "outside" in mf_graph(_info(root, sibling.as_uri()), root)


def test_graph_rule_refuses_unresolved_broken_and_npm(tmp_path):
    root = tmp_path / "conn"
    root.mkdir()
    bare = _info(root)
    bare["modules"][0]["dependencies"] = [{"specifier": "foo", "code": {"error": "not a dependency"}}]
    assert "cannot be resolved" in mf_graph(bare, root)
    broken = _info(root, errors={(root / "main.ts").as_uri(): "SyntaxError: secret text"})
    problem = mf_graph(broken, root)
    assert problem.startswith("main.ts cannot be loaded") and "secret" not in problem
    from cashu.core.connectors.sandbox import module_graph_check

    assert module_graph_check(broken, root) == ("module_parse_error", problem)
    assert module_graph_check(bare, root)[0] == "forbidden_import"
    outside = module_graph_check(_info(root, "file:///etc/hosts"), root)
    assert outside == ("forbidden_import", "a module outside the connector directory is imported")
    assert module_graph_check(_info(root), root) is None
    assert "npm" in mf_graph(_info(root, npmPackages={"left-pad@1": {}}), root)
    redirected = _info(root, redirects={"file:///a": "file:///etc/hosts"})
    assert "outside" in mf_graph(redirected, root)
    typed = _info(root)
    typed["modules"][0]["dependencies"] = [{"specifier": "x", "type": {"specifier": "file:///etc/x.d.ts"}}]
    assert "outside" in mf_graph(typed, root)
    for junk in (None, [], {"modules": "x"}, {"modules": [1]}):
        assert mf_graph(junk, root) == "the module graph could not be checked"


def mf_graph(info, root):
    from cashu.core.connectors.sandbox import module_graph_problem

    return module_graph_problem(info, root)


SECRET = "FAKE-OUTSIDE-SECRET-7731"

STATIC_IMPORT = """\
import s from {path!r} with {{ type: "text" }};
await new Response(Deno.stdin.readable).text();
console.log(JSON.stringify({{ document: {{ records: [], leak: s }} }}));
"""

LITERAL_DYNAMIC = """\
await new Response(Deno.stdin.readable).text();
const s = (await import({path!r}, {{ with: {{ type: "text" }} }})).default;
console.log(JSON.stringify({{ document: {{ records: [], leak: s }} }}));
"""


def _outside_secret(tmp_path: Path) -> Path:
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    path = outside / "secret.txt"
    path.write_text(SECRET, encoding="utf-8")
    return path


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
@pytest.mark.parametrize("template", [STATIC_IMPORT, LITERAL_DYNAMIC], ids=["static", "dynamic"])
@pytest.mark.parametrize("relative", [False, True], ids=["absolute", "dotdot"])
def test_an_import_outside_the_connector_is_refused_before_the_run(
    tmp_path, export, make_box, template, relative
):
    secret = _outside_secret(tmp_path)
    path = "../outside/secret.txt" if relative else str(secret)
    target = _deno_connector(tmp_path / "deno-test", template.format(path=path))
    for command in ("detect", "convert"):
        result = execute(target, command, file=export, sandbox=make_box())
        assert (result.outcome, result.error_kind) == ("refused", "forbidden_import")
        assert result.message == "a module outside the connector directory is imported"
        assert SECRET not in (result.stderr_tail or "")


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_a_nested_static_import_and_a_data_module_are_refused(tmp_path, export, make_box):
    secret = _outside_secret(tmp_path)
    nested = 'import s from "./lib/inner.ts";\nconsole.log(s);\n'
    inner = f'import s from {str(secret)!r} with {{ type: "text" }};\nexport default s;\n'
    target = _deno_connector(tmp_path / "deno-test", nested, extra={"lib/inner.ts": inner})
    result = execute(target, "convert", file=export, sandbox=make_box())
    assert result.error_kind == "forbidden_import"
    data = 'import x from "data:text/javascript,export default 1";\nconsole.log(x);\n'
    target = _deno_connector(tmp_path / "deno-data", data, cid="deno-data")
    result = execute(target, "convert", file=export, sandbox=make_box())
    assert result.error_kind == "forbidden_import" and "data:" in result.message


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_relative_imports_and_node_builtins_inside_the_connector_run(tmp_path, export, make_box):
    main = (
        'import { basename } from "node:path";\n'
        'import { parse } from "./lib/parse.ts";\n'
        'import meta from "./lib/meta.json" with { type: "json" };\n'
        "const req = JSON.parse(await new Response(Deno.stdin.readable).text());\n"
        "const records = parse(Deno.readTextFileSync(req.file.path));\n"
        'console.log(JSON.stringify({ document: { format: "cashu-import", format_version: 1,\n'
        "  source: meta.source + basename(\"/x/y\"), records } }));\n"
    )
    parse = (
        "export function parse(text: string) {\n"
        '  return text.trim().split("\\n").slice(1).map((line) => {\n'
        '    const [date, type, amount] = line.split(",");\n'
        '    return { record: "txn", date, type, currency: "PLN", gross_amount: amount };\n'
        "  });\n}\n"
    )
    target = _deno_connector(tmp_path / "deno-test", main,
                             extra={"lib/parse.ts": parse, "lib/meta.json": '{"source": "deno_"}'})
    result = execute(target, "convert", file=export, sandbox=make_box())
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    assert result.records == 3 and result.response.document["source"] == "deno_y"


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_a_syntax_error_is_refused_with_the_file_name_only(tmp_path, export, make_box):
    target = _deno_connector(tmp_path / "deno-test", 'import "./lib/bad.ts";\n',
                             extra={"lib/bad.ts": "const x = ;\n"})
    result = execute(target, "convert", file=export, sandbox=make_box())
    assert (result.outcome, result.error_kind) == ("refused", "module_parse_error")
    assert result.message == "lib/bad.ts cannot be loaded or parsed (check it with deno check)"


# The reviewer's runtime probes: reads that are not in the static graph stay permission-checked.
RUNTIME_PROBE = """\
await new Response(Deno.stdin.readable).text();
// Specifiers built at run time: deno's graph folds string literals and "a" + "b", not these.
const join = (...parts: string[]) => parts.join("");
const P = join({outside!r});
const out: Record<string, string> = {{}};
async function attempt(name: string, fn: () => unknown) {{
  try {{
    const v = String(JSON.stringify(await fn()));
    out[name] = v.includes({secret!r}) ? "LEAK" : "ok";
  }} catch (e) {{ out[name] = (e as Error).name; }}
}}
const src = (f: string) => 'import j from "file://' + P + f + '" with {{type:"text"}}; export default j;';
await attempt("computed", async () => (await import(P + "secret.txt", {{ with: {{ type: "text" }} }})).default);
await attempt("blob", async () => (await import(URL.createObjectURL(new Blob([src("secret.txt")], {{ type: "text/javascript" }})))).default);
await attempt("data", async () => (await import("data:text/javascript;base64," + btoa(src("secret.txt")))).default);
await attempt("eval", async () => (await (0, eval)('import("file://' + P + 'secret.txt", {{with:{{type:"text"}}}})')).default);
await attempt("inner_computed", async () => (await import(join("./lib/", "inner.ts"))).default);
await attempt("worker_static", () => new Promise((res, rej) => {{
  const w = new Worker(new URL(join("./lib/", "worker.ts"), import.meta.url), {{ type: "module" }});
  w.onmessage = (e) => {{ res(e.data); w.terminate(); }};
  w.onerror = (e) => {{ e.preventDefault(); rej(new Error("worker")); w.terminate(); }};
}}));
await attempt("node_require", async () => {{
  const {{ createRequire }} = await import("node:module");
  return createRequire(import.meta.url)(P + "secret.json");
}});
await attempt("node_fs", async () => (await import("node:fs")).readFileSync(P + "secret.txt", "utf8"));
console.log(JSON.stringify({{ document: {{ records: [], probe: out }} }}));
"""


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_imports_outside_the_static_graph_stay_permission_checked(tmp_path, export, make_box):
    secret = _outside_secret(tmp_path)
    (secret.parent / "secret.json").write_text(f'{{"s": "{SECRET}"}}', encoding="utf-8")
    outside = str(secret.parent) + "/"
    inner = f'import s from {str(secret)!r} with {{ type: "text" }};\nexport default s;\n'
    worker = f'import s from {str(secret)!r} with {{ type: "text" }};\npostMessage(s);\n'
    target = _deno_connector(
        tmp_path / "deno-test", RUNTIME_PROBE.format(outside=outside, secret=SECRET),
        extra={"lib/inner.ts": inner, "lib/worker.ts": worker},
    )
    result = execute(target, "convert", file=export, sandbox=make_box())
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    probe = result.response.document["probe"]
    assert set(probe) == {"computed", "blob", "data", "eval", "inner_computed", "worker_static",
                          "node_require", "node_fs"}
    for name, verdict in probe.items():
        assert verdict not in ("ok", "LEAK"), (name, verdict)


RAW_CONNECT = """\
await new Response(Deno.stdin.readable).text();
let verdict = "ok";
try { (await Deno.connect({ hostname: "127.0.0.1", port: 443 })).close(); }
catch (e) { verdict = (e as Error).name; }
console.log(JSON.stringify({ document: { records: [], verdict }, cursor: null }));
"""


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_a_raw_socket_to_an_allowed_host_needs_the_native_layer(tmp_path, make_box):
    """Deno's --allow-net names hosts, not the proxy: alone, Deno.connect to an allowed host reaches the
    network stack past the egress proxy (no listener here, so ConnectionRefused). The macOS layer allows
    only the proxy port, so the connect itself is denied. This is why sandbox_for never runs Deno alone."""
    root = tmp_path / "deno-test"
    root.mkdir()
    (root / "main.ts").write_text(RAW_CONNECT, encoding="utf-8")
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    proxy = _Listener()  # stands in for the egress proxy port
    try:
        spec = runner.RunSpec(
            argv=(DENO, str(root / "main.ts")), connector_dir=root, interpreter=Path(DENO),
            run_dir=run_dir, env=runner.base_env(run_dir, Path(DENO), proxy.port),
            stdin=b'{"command": "fetch"}', timeout_s=30, max_stdout=1 << 20,
            proxy_port=proxy.port, hosts=("127.0.0.1",),
        )
        box = make_box()
        outcome = box.run(spec)
    finally:
        proxy.close()
    assert outcome.error_kind is None, outcome.message
    import json as _json

    verdict = _json.loads(outcome.process.stdout)["document"]["verdict"]
    if box.outer is None:
        assert verdict == "ConnectionRefused"  # the bypass the native layer exists for
    else:
        assert verdict not in ("ok", "ConnectionRefused", "NotCapable"), verdict  # the kernel said no


@needs_deno
@pytest.mark.parametrize("make_box", SANDBOXES)
def test_a_missing_module_and_a_broken_entry_script_are_parse_errors(tmp_path, export, make_box):
    target = _deno_connector(tmp_path / "deno-test", 'import "./lib/missing.ts";\n')
    result = execute(target, "convert", file=export, sandbox=make_box())
    assert (result.outcome, result.error_kind) == ("refused", "module_parse_error")
    assert result.message.startswith("lib/missing.ts cannot be loaded or parsed")
    broken = _deno_connector(tmp_path / "deno-bad", "const = 1;\n", cid="deno-bad")
    result = execute(broken, "detect", file=export, sandbox=make_box())
    assert (result.outcome, result.error_kind) == ("refused", "module_parse_error")
    assert result.message == "main.ts cannot be loaded or parsed (check it with deno check)"
    # an outside import next to a broken module is still a forbidden import (the rule comes first)
    mixed = _deno_connector(tmp_path / "deno-mixed", 'import "/etc/hosts";\nimport "./lib/bad.ts";\n',
                            cid="deno-mixed", extra={"lib/bad.ts": "const x = ;\n"})
    assert execute(mixed, "convert", file=export, sandbox=make_box()).error_kind == "forbidden_import"


def test_the_narrow_profile_drops_system_config_and_homebrew_state(tmp_path):
    from cashu.core.connectors.sandbox import RunSpec, render_profile

    (tmp_path / "conn").mkdir()
    (tmp_path / "run").mkdir()
    spec = RunSpec(argv=("/usr/bin/true",), connector_dir=tmp_path / "conn",
                   interpreter=Path("/usr/bin/true"), run_dir=tmp_path / "run", env={}, stdin=b"",
                   timeout_s=1, max_stdout=1)
    wide = render_profile(spec)
    narrow = render_profile(runner_replace(spec, narrow=True))
    for rule in ('(subpath "/private/etc")', '(subpath "/opt/homebrew")', '(subpath "/usr")'):
        assert rule in wide and rule not in narrow, rule
    assert '(literal "/private/etc/localtime")' in narrow
    assert '(subpath "/opt/homebrew/Cellar")' in narrow and '(subpath "/usr/lib")' in narrow


def runner_replace(spec, **changes):
    from dataclasses import replace

    return replace(spec, **changes)
