import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorCatalog, resolveInterpreter } from "./catalog.js";
import { ConnectorFault, scanConnector } from "./manifest.js";
import { runConnector } from "./runner.js";

const roots: string[] = [];
function fixture(script = 'print("{\\"match\\":true}")'): {
  root: string;
  source: string;
  data: string;
  input: string;
  outside: string;
} {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cashu-connectors-test-"));
  roots.push(root);
  const source = join(root, "source");
  const data = join(root, "data");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(
    join(source, "connector.yaml"),
    "api_version: 1\nid: sample-file\nname: Sample\nversion: '1'\nmodule: budget\nkind: file\nrun: [python3, connector.py]\nfile:\n  extensions: [csv]\n",
  );
  writeFileSync(join(source, "connector.py"), script);
  const input = join(root, "input.csv");
  const outside = join(root, "outside.txt");
  writeFileSync(input, "synthetic\n");
  writeFileSync(outside, "outside marker");
  return { root, source, data, input, outside };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("connector approval authority", () => {
  it("binds exact installed digest and interpreter and invalidates on source change", () => {
    const f = fixture();
    const catalog = new ConnectorCatalog(f.data);
    const pending = catalog.installPending(f.source);
    const interpreter = resolveInterpreter(pending);
    expect(catalog.list()).toEqual([
      {
        id: "sample-file",
        name: "Sample",
        kind: "file",
        module: "budget",
        contentSha256: pending.contentSha256,
        interpreter,
        approval: "pending",
      },
    ]);
    expect(() =>
      catalog.approve("sample-file", "0".repeat(64), interpreter, {
        ownerAction: true,
        isCurrent: () => true,
      }),
    ).toThrow(ConnectorFault);
    expect(() => catalog.approved("sample-file", interpreter)).toThrow(ConnectorFault);
    expect(() =>
      catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
        ownerAction: true,
        isCurrent: () => false,
      }),
    ).toThrow();
    catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
      ownerAction: true,
      isCurrent: () => true,
    });
    expect(catalog.list()[0]?.approval).toBe("approved");
    expect(catalog.approved("sample-file", interpreter).contentSha256).toBe(pending.contentSha256);
    writeFileSync(join(pending.root, "connector.py"), "print('changed')");
    expect(catalog.list()[0]?.approval).toBe("changed");
    expect(() => catalog.approved("sample-file", interpreter)).toThrow(ConnectorFault);
  });

  it("requires owner authority to disable and refuses execution after disable", () => {
    const f = fixture();
    const catalog = new ConnectorCatalog(f.data);
    const loaded = catalog.installPending(f.source);
    const interpreter = resolveInterpreter(loaded);
    catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
      ownerAction: true,
      isCurrent: () => true,
    });
    expect(() =>
      catalog.disable("sample-file", { ownerAction: true, isCurrent: () => false }),
    ).toThrow();
    catalog.disable("sample-file", { ownerAction: true, isCurrent: () => true });
    expect(() => catalog.approved("sample-file", interpreter)).toThrow(ConnectorFault);
    expect(catalog.list()[0]?.approval).toBe("disabled");
    const reopened = new ConnectorCatalog(f.data);
    expect(reopened.list()[0]?.approval).toBe("disabled");
    reopened.approve("sample-file", loaded.contentSha256, interpreter, {
      ownerAction: true,
      isCurrent: () => true,
    });
    expect(reopened.list()[0]?.approval).toBe("approved");
  });

  it("refuses traversal, links, special files and directory limits", () => {
    const f = fixture();
    const manifest = join(f.source, "connector.yaml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace("connector.py", "../outside.py"),
    );
    expect(() => scanConnector(f.source)).toThrow(ConnectorFault);
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace("../outside.py", "connector.py"),
    );
    symlinkSync(f.outside, join(f.source, "link"));
    expect(() => scanConnector(f.source)).toThrow(ConnectorFault);
    rmSync(join(f.source, "link"));
    linkSync(f.outside, join(f.source, "linked"));
    expect(() => scanConnector(f.source)).toThrow(ConnectorFault);
    rmSync(join(f.source, "linked"));
    for (let i = 0; i < 199; i++) writeFileSync(join(f.source, `extra${i}`), "x");
    expect(() => scanConnector(f.source)).toThrow(ConnectorFault);
  });
});

describe("native connector sandbox", () => {
  it.skipIf(process.platform !== "darwin")(
    "runs one strict response with no inherited secret",
    async () => {
      const f = fixture(
        'import os, json\nprint(json.dumps({"match": "SHOULD_NOT_INHERIT" not in os.environ}))',
      );
      process.env.SHOULD_NOT_INHERIT = "sensitive";
      try {
        const catalog = new ConnectorCatalog(f.data);
        const loaded = catalog.installPending(f.source);
        const interpreter = resolveInterpreter(loaded);
        catalog.approve(
          "sample-file",
          catalog.installed("sample-file").contentSha256,
          interpreter,
          { ownerAction: true, isCurrent: () => true },
        );
        expect(
          await runConnector({
            catalog,
            id: "sample-file",
            interpreter,
            command: "detect",
            file: { path: f.input, name: "input.csv" },
          }),
        ).toEqual({ outcome: "ok", response: { match: true, confidence: 1 } });
      } finally {
        delete process.env.SHOULD_NOT_INHERIT;
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "blocks outside-root read/write and direct network",
    async () => {
      const f = fixture(
        `import json, pathlib, socket\nresult = {}\ntry:\n pathlib.Path(${JSON.stringify(fixtureMarker())}).read_text()\n result["read"] = True\nexcept Exception: result["read"] = False\ntry:\n pathlib.Path(${JSON.stringify(fixtureMarker())}).write_text("escape")\n result["write"] = True\nexcept Exception: result["write"] = False\ntry:\n socket.create_connection(("127.0.0.1", 9), 0.1)\n result["network"] = True\nexcept Exception: result["network"] = False\nprint(json.dumps({"match": not any(result.values())}))`,
      );
      const script = join(f.source, "connector.py");
      writeFileSync(script, readFileSync(script, "utf8").replaceAll(fixtureMarker(), f.outside));
      const catalog = new ConnectorCatalog(f.data);
      const loaded = catalog.installPending(f.source);
      const interpreter = resolveInterpreter(loaded);
      catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
        ownerAction: true,
        isCurrent: () => true,
      });
      expect(
        await runConnector({
          catalog,
          id: "sample-file",
          interpreter,
          command: "detect",
          file: { path: f.input, name: "input.csv" },
        }),
      ).toEqual({ outcome: "ok", response: { match: true, confidence: 1 } });
      expect(readFileSync(f.outside, "utf8")).toBe("outside marker");
    },
  );

  it.skipIf(process.platform !== "darwin")("rejects extra stdout fields", async () => {
    const f = fixture('print("{\\"match\\":true,\\"unexpected\\":1}")');
    const catalog = new ConnectorCatalog(f.data);
    const loaded = catalog.installPending(f.source);
    const interpreter = resolveInterpreter(loaded);
    catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
      ownerAction: true,
      isCurrent: () => true,
    });
    expect(
      await runConnector({
        catalog,
        id: "sample-file",
        interpreter,
        command: "detect",
        file: { path: f.input, name: "input.csv" },
      }),
    ).toEqual({ outcome: "failed", errorKind: "protocol" });
  });

  it.skipIf(process.platform !== "darwin")(
    "allows quoted NaN text and rejects numeric overflow",
    async () => {
      const f = fixture('print("{\\"document\\":{\\"title\\":\\"NaN Infinity\\"}}")');
      const catalog = new ConnectorCatalog(f.data);
      let loaded = catalog.installPending(f.source);
      let interpreter = resolveInterpreter(loaded);
      catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
        ownerAction: true,
        isCurrent: () => true,
      });
      const quoted = await runConnector({
        catalog,
        id: "sample-file",
        interpreter,
        command: "convert",
        file: { path: f.input, name: "input.csv" },
      });
      expect(quoted.outcome).toBe("ok");
      if (quoted.outcome === "ok")
        expect(Buffer.from(quoted.documentBytes ?? []).toString("utf8")).toBe(
          '{"title":"NaN Infinity"}',
        );
      writeFileSync(
        join(f.source, "connector.py"),
        'print("{\\"document\\":{\\"amount\\":1.234567890123456789}}")',
      );
      loaded = catalog.installPending(f.source);
      interpreter = resolveInterpreter(loaded);
      catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
        ownerAction: true,
        isCurrent: () => true,
      });
      const exact = await runConnector({
        catalog,
        id: "sample-file",
        interpreter,
        command: "convert",
        file: { path: f.input, name: "input.csv" },
      });
      expect(exact.outcome).toBe("ok");
      if (exact.outcome === "ok")
        expect(Buffer.from(exact.documentBytes ?? []).toString("utf8")).toBe(
          '{"amount":1.234567890123456789}',
        );
      writeFileSync(
        join(f.source, "connector.py"),
        'print("{\\"document\\":{\\"amount\\":1e999}}")',
      );
      loaded = catalog.installPending(f.source);
      interpreter = resolveInterpreter(loaded);
      catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
        ownerAction: true,
        isCurrent: () => true,
      });
      expect(
        await runConnector({
          catalog,
          id: "sample-file",
          interpreter,
          command: "convert",
          file: { path: f.input, name: "input.csv" },
        }),
      ).toEqual({ outcome: "failed", errorKind: "protocol" });
    },
  );

  it.skipIf(process.platform !== "darwin")("blocks child process execution", async () => {
    const f = fixture(
      'import json, subprocess\ntry:\n subprocess.run(["/bin/sh", "-c", "true"], check=True)\n escaped = True\nexcept Exception: escaped = False\nprint(json.dumps({"match": not escaped}))',
    );
    const catalog = new ConnectorCatalog(f.data);
    const loaded = catalog.installPending(f.source);
    const interpreter = resolveInterpreter(loaded);
    catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
      ownerAction: true,
      isCurrent: () => true,
    });
    expect(
      await runConnector({
        catalog,
        id: "sample-file",
        interpreter,
        command: "detect",
        file: { path: f.input, name: "input.csv" },
      }),
    ).toEqual({ outcome: "ok", response: { match: true, confidence: 1 } });
  });

  it.skipIf(process.platform !== "darwin")(
    "rejects Deno static import outside the approved snapshot",
    async () => {
      const f = fixture();
      writeFileSync(
        join(f.source, "connector.yaml"),
        "api_version: 1\nid: sample-file\nname: Sample\nversion: '1'\nmodule: budget\nkind: file\nrun: [deno, connector.ts]\nfile:\n  extensions: [csv]\n",
      );
      writeFileSync(
        join(f.source, "connector.ts"),
        'import "file:///etc/hosts"; console.log(JSON.stringify({match:true}));',
      );
      const catalog = new ConnectorCatalog(f.data);
      const loaded = catalog.installPending(f.source);
      const interpreter = resolveInterpreter(loaded);
      catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
        ownerAction: true,
        isCurrent: () => true,
      });
      expect(
        await runConnector({
          catalog,
          id: "sample-file",
          interpreter,
          command: "detect",
          file: { path: f.input, name: "input.csv" },
        }),
      ).toEqual({ outcome: "refused", errorKind: "forbidden_import" });
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "runs an approved local Deno script under both layers",
    async () => {
      const f = fixture();
      writeFileSync(
        join(f.source, "connector.yaml"),
        "api_version: 1\nid: sample-file\nname: Sample\nversion: '1'\nmodule: budget\nkind: file\nrun: [deno, connector.ts]\nfile:\n  extensions: [csv]\n",
      );
      writeFileSync(
        join(f.source, "connector.ts"),
        'const request = JSON.parse(await new Response(Deno.stdin.readable).text()); console.log(JSON.stringify({match: request.command === "detect"}));',
      );
      const catalog = new ConnectorCatalog(f.data);
      const loaded = catalog.installPending(f.source);
      const interpreter = resolveInterpreter(loaded);
      catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
        ownerAction: true,
        isCurrent: () => true,
      });
      expect(
        await runConnector({
          catalog,
          id: "sample-file",
          interpreter,
          command: "detect",
          file: { path: f.input, name: "input.csv" },
        }),
      ).toEqual({ outcome: "ok", response: { match: true, confidence: 1 } });
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "passes fetch secrets only on stdin and denies nonallowlisted CONNECT",
    async () => {
      const f = fixture();
      writeFileSync(
        join(f.source, "connector.yaml"),
        "api_version: 1\nid: sample-file\nname: Sample\nversion: '1'\nmodule: budget\nkind: fetch\nrun: [python3, connector.py]\nfetch:\n  hosts: [api.example.com]\n  secrets:\n    - id: token\n      label: Token\n",
      );
      writeFileSync(
        join(f.source, "connector.py"),
        `import json, os, socket, sys, urllib.parse\nrequest = json.load(sys.stdin)\nproxy = urllib.parse.urlparse(os.environ["HTTPS_PROXY"])\ns = socket.create_connection((proxy.hostname, proxy.port), 2)\ns.sendall(b"CONNECT evil.example.com:443 HTTP/1.1\\r\\n\\r\\n")\ndenied = b"403 Forbidden" in s.recv(100)\ns.close()\ntry:\n socket.create_connection(("127.0.0.1", 9), 0.1)\n direct = True\nexcept Exception: direct = False\nok = denied and not direct and request["secrets"]["token"] == "synthetic-secret" and "synthetic-secret" not in os.environ.values()\nprint(json.dumps({"ok": ok}))`,
      );
      const catalog = new ConnectorCatalog(f.data);
      const loaded = catalog.installPending(f.source);
      const interpreter = resolveInterpreter(loaded);
      catalog.approve("sample-file", catalog.installed("sample-file").contentSha256, interpreter, {
        ownerAction: true,
        isCurrent: () => true,
      });
      expect(
        await runConnector({
          catalog,
          id: "sample-file",
          interpreter,
          command: "check",
          secrets: { token: "synthetic-secret" },
        }),
      ).toEqual({ outcome: "ok", response: { ok: true } });
    },
  );
});

function fixtureMarker(): string {
  return "OUTSIDE_MARKER_PATH";
}
