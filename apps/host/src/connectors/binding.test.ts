import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type BindingAccount, type ConnectorBinding, runBoundFetch } from "./binding.js";
import { ConnectorCatalog, resolveInterpreter } from "./catalog.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cashu-binding-test-"));
  roots.push(root);
  const data = join(root, "data");
  const source = join(root, "source");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(
    join(source, "connector.yaml"),
    "api_version: 1\nid: sample-fetch\nname: Sample\nversion: '1'\nmodule: budget\nkind: fetch\nrun: [python3, connector.py]\nfetch:\n  hosts: [api.example.com]\n  secrets:\n    - id: token\n      label: Token\n",
  );
  writeFileSync(
    join(source, "connector.py"),
    'import json,sys\nrequest=json.load(sys.stdin)\nprint(json.dumps({"document":{"format":"synthetic","token_present":request["secrets"]["token"] == "synthetic-secret"},"cursor":"next"}))',
  );
  const catalog = new ConnectorCatalog(data);
  const loaded = catalog.installPending(source);
  const interpreter = resolveInterpreter(loaded);
  catalog.approve("sample-fetch", catalog.installed("sample-fetch").contentSha256, interpreter, {
    ownerAction: true,
    isCurrent: () => true,
  });
  const binding: ConnectorBinding = {
    id: "binding-1",
    profileId: "profile-a",
    accountId: "account-a",
    connectorId: "sample-fetch",
    module: "budget",
    enabled: true,
    params: {},
    cursor: "base",
  };
  const account: BindingAccount = {
    id: "account-a",
    profileId: "profile-a",
    module: "budget",
    currency: "PLN",
    label: "Synthetic",
  };
  const authority = { profileId: "profile-a", holder: true as const, isCurrent: () => true };
  return { catalog, interpreter, binding, account, authority };
}

it("refuses cross-profile/account binding before reading secrets or running code", async () => {
  const s = setup();
  let gets = 0;
  const secrets = {
    get: async () => {
      gets++;
      return "synthetic-secret";
    },
  };
  expect(
    await runBoundFetch({ ...s, binding: { ...s.binding, profileId: "profile-b" }, secrets }),
  ).toEqual({ outcome: "refused", errorKind: "bad_request" });
  expect(
    await runBoundFetch({ ...s, account: { ...s.account, id: "account-b" }, secrets }),
  ).toEqual({ outcome: "refused", errorKind: "bad_request" });
  expect(gets).toBe(0);
});

it.skipIf(process.platform !== "darwin")(
  "returns exact document and cursor without advancing binding state",
  async () => {
    const s = setup();
    const result = await runBoundFetch({ ...s, secrets: { get: async () => "synthetic-secret" } });
    expect(result.outcome).toBe("transported");
    if (result.outcome === "transported") {
      expect(Buffer.from(result.documentBytes).toString("utf8")).toBe(
        '{"format":"synthetic","token_present":true}',
      );
      expect(result.binding).toMatchObject({
        id: "binding-1",
        profileId: "profile-a",
        accountId: "account-a",
        connectorId: "sample-fetch",
        module: "budget",
        baseCursor: "base",
        approvedCodeDigest: s.catalog.installed("sample-fetch").contentSha256,
        interpreter: s.interpreter,
      });
      expect(result.binding.paramsDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.newCursor).toBe("next");
    }
    expect(s.binding.cursor).toBe("base");
  },
);
