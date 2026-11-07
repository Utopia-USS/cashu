import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { testConnectorFileOffline } from "./offlineTest.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(script: string) {
  const root = mkdtempSync("/private/tmp/cashu-offline-test-");
  roots.push(root);
  const workspace = join(root, "workspace");
  const source = join(workspace, "connectors", "sample-file");
  const sample = join(workspace, "samples", "sample.csv");
  const scratch = join(root, "scratch");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  mkdirSync(join(workspace, "samples"), { recursive: true, mode: 0o700 });
  mkdirSync(scratch, { mode: 0o700 });
  writeFileSync(
    join(source, "connector.yaml"),
    "api_version: 1\nid: sample-file\nname: Sample\nversion: '1'\nmodule: budget\nkind: file\nrun: [python3, connector.py]\nfile:\n  extensions: [csv]\n",
  );
  writeFileSync(join(source, "connector.py"), script);
  writeFileSync(sample, "synthetic\n");
  return { root, workspace, source, sample, scratch };
}

it("rejects hard-linked and symlinked samples before launching unapproved code", async () => {
  const f = fixture("raise SystemExit('must not run')\n");
  const hard = join(f.workspace, "samples", "hard.csv");
  linkSync(f.sample, hard);
  const input = {
    workspaceRoot: f.workspace,
    connectorPath: f.source,
    scratchRoot: f.scratch,
    isCurrent: () => true,
  };
  expect((await testConnectorFileOffline({ ...input, samplePath: hard })).errorKind).toBe(
    "bad_request",
  );
  const outside = join(f.root, "outside.csv");
  writeFileSync(outside, "synthetic outside\n");
  const link = join(f.workspace, "samples", "link.csv");
  symlinkSync(outside, link);
  expect((await testConnectorFileOffline({ ...input, samplePath: link })).errorKind).toBe(
    "bad_request",
  );
  const declared = join(f.workspace, "connectors");
  const moved = join(f.root, "moved-connectors");
  renameSync(declared, moved);
  symlinkSync(moved, declared);
  expect((await testConnectorFileOffline({ ...input, samplePath: f.sample })).errorKind).toBe(
    "bad_request",
  );
});

it("runs a file connector without approval and never returns its raw output", async () => {
  const f = fixture(
    "import json, sys\nr=json.load(sys.stdin)\nif r['command']=='detect': print(json.dumps({'match': True}))\nelse: print(json.dumps({'error': {'kind': 'secret_1234567890', 'message': 'private marker'}})); sys.exit(1)\n",
  );
  const report = await testConnectorFileOffline({
    workspaceRoot: f.workspace,
    connectorPath: f.source,
    samplePath: f.sample,
    scratchRoot: f.scratch,
    isCurrent: () => true,
  });
  if (process.platform === "darwin") {
    expect(report.detect).toBe(true);
    expect(report.errorKind).toBe("internal");
  } else expect(report.errorKind).toBe("sandbox_unavailable");
  expect(JSON.stringify(report)).not.toContain("private marker");
  expect(JSON.stringify(report)).not.toContain("secret_1234567890");
});

it("keeps a synthetic outside file unreadable to unapproved code", async () => {
  const f = fixture("print('placeholder')\n");
  const outside = join(f.root, "outside.txt");
  writeFileSync(
    join(f.source, "connector.py"),
    `import json, sys\nr=json.load(sys.stdin)\nif r['command']=='detect': print(json.dumps({'match': True}))\nelse:\n try: open(${JSON.stringify(outside)}, 'r').read(); print(json.dumps({'error': {'kind': 'protocol', 'message': 'escaped'}}))\n except OSError: print(json.dumps({'error': {'kind': 'bad_file', 'message': 'denied'}}))\n sys.exit(1)\n`,
  );
  writeFileSync(outside, "synthetic outside marker", { mode: 0o600 });
  try {
    const report = await testConnectorFileOffline({
      workspaceRoot: f.workspace,
      connectorPath: f.source,
      samplePath: f.sample,
      scratchRoot: f.scratch,
      isCurrent: () => true,
    });
    expect(report.errorKind).toBe(
      process.platform === "darwin" ? "bad_file" : "sandbox_unavailable",
    );
    expect(JSON.stringify(report)).not.toContain("synthetic outside marker");
  } finally {
    rmSync(outside, { force: true });
  }
});

it("tests a fetch fixture offline with placeholder secrets and no network", async () => {
  const f = fixture(
    "import json, sys\nr=json.load(sys.stdin)\nassert r['command']=='fetch'\nassert json.loads(r['params']['fixture'])=={'synthetic': True}\nassert r['secrets']=={'token':'test-not-a-real-secret'}\nprint(json.dumps({'error': {'kind': 'bad_file', 'message': 'synthetic'}})); sys.exit(1)\n",
  );
  writeFileSync(
    join(f.source, "connector.yaml"),
    "api_version: 1\nid: sample-file\nname: Sample\nversion: '1'\nmodule: budget\nkind: fetch\nrun: [python3, connector.py]\nfetch:\n  hosts: [example.invalid]\n  secrets: [{id: token, label: Token}]\n",
  );
  const fixturePath = join(f.workspace, "samples", "response.json");
  writeFileSync(fixturePath, '{"synthetic":true}\n');
  const report = await testConnectorFileOffline({
    workspaceRoot: f.workspace,
    connectorPath: f.source,
    fixturePath,
    scratchRoot: f.scratch,
    isCurrent: () => true,
  });
  expect(report.errorKind).toBe(process.platform === "darwin" ? "bad_file" : "sandbox_unavailable");
  expect(report.detect).toBeNull();
  expect(JSON.stringify(report)).not.toContain("test-not-a-real-secret");
});

it("reports real detect and convert phases with domain document counts", async () => {
  const document = {
    format: "cashu-budget-import",
    format_version: 1,
    source: "synthetic",
    account: { iban: "PL99114000000000000000000001", name: "Synthetic", currency: "PLN" },
    balances: [{ date: "2026-10-05", amount: "100.00" }],
    transactions: [
      { booking_date: "2026-10-04", amount: "-1.00", currency: "PLN", reference: "SYNTHETIC" },
    ],
  };
  const script = `import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({'match':True} if r['command']=='detect' else {'document':${JSON.stringify(document)}}))\n`;
  const f = fixture(script);
  const report = await testConnectorFileOffline({
    workspaceRoot: f.workspace,
    connectorPath: f.source,
    samplePath: f.sample,
    scratchRoot: f.scratch,
    isCurrent: () => true,
  });
  if (process.platform !== "darwin") {
    expect(report.errorKind).toBe("sandbox_unavailable");
    return;
  }
  expect(report.ok).toBe(true);
  expect(report.runs).toEqual([
    { command: "detect", outcome: "ok", errorKind: null, records: 0 },
    { command: "convert", outcome: "ok", errorKind: null, records: 1 },
  ]);
  expect(report.document).toEqual({
    format: "json",
    counts: { transactions: 1, balances: 1 },
    issueKinds: [],
  });
});
