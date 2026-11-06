/** Actual native preview/proposal/T28 commands over a bounded synthetic publication port. */
import { sha256Hex } from "@cashu/domain";
import { investmentsCommands as C, setModules, setProfileSettings } from "@cashu/store";
import { approvePrepared, proposalExecution } from "@cashu/store/core";
import { transactions } from "@cashu/store/investments/queries";
import { type ImportPublication, prepareInvestmentImport } from "@cashu/store/investments/services";
import { afterEach, describe, expect, it } from "vitest";
import { decodeEntityRef, encodeEntityRef } from "../runtime/refs.js";
import { NativeMcpServer } from "../runtime/server.js";
import { asyncFixture, deferred } from "../testing/async.js";
import { investmentImportAdapter } from "./investmentImportProposal.js";
import { investmentWriteTools } from "./investmentWrites.js";

const HEADER =
  "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source";
const FILE = new TextEncoder().encode(
  `${HEADER}\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n`,
);
const opened: ReturnType<typeof asyncFixture>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.f.close();
});
function setup(pause = false) {
  const s = asyncFixture();
  opened.push(s);
  const account = s.f.run(C.addBrokerageAccount, { name: "Synthetic broker", broker: "dif" });
  if (!account.ok) throw new Error(account.reason);
  const entered = deferred<void>(),
    release = deferred<void>();
  let fileReads = 0,
    puts = 0,
    blobReads = 0,
    cleanups = 0,
    badReadback = false,
    cleanupFailure = false;
  const blobs = new Map<string, Uint8Array>(),
    stages = new Set<object>();
  const publication: ImportPublication = {
    vault: s.f.vault,
    binding: Object.freeze({}),
    isCurrent: () => true,
    async publish(content, expected) {
      puts++;
      entered.resolve();
      if (pause) await release.promise;
      const stage = Object.freeze({});
      stages.add(stage);
      const blob = { sha256: sha256Hex(content), ext: expected.ext };
      blobs.set(blob.sha256, Uint8Array.from(content));
      return { blob, privateStage: stage };
    },
    async read(vault, blob, max) {
      blobReads++;
      expect(vault).toBe(s.f.vault);
      expect(max).toBeGreaterThan(FILE.length);
      const bytes = blobs.get(blob.sha256);
      if (!bytes) return null;
      return badReadback ? Uint8Array.from(bytes, (b) => b ^ 1) : Uint8Array.from(bytes);
    },
    async discardPrivateStage(receipt) {
      if (!stages.has(receipt)) throw new Error("foreign synthetic receipt");
      cleanups++;
      if (cleanupFailure) throw new Error("synthetic private stage cleanup failure");
      stages.delete(receipt);
    },
  };
  const readFile = (path: string) => {
    fileReads++;
    return {
      name: path === "/blocked.csv" ? "blocked.csv" : "synthetic.csv",
      bytes: path === "/blocked.csv" ? new TextEncoder().encode("not an export\n") : FILE,
    };
  };
  const bind = (pub: ImportPublication | undefined = publication) =>
    s.services({
      ...(pub ? { investmentAsync: { vault: s.f.vault, imports: pub } } : {}),
      readInvestmentImportFile: readFile,
    });
  bind();
  const server = new NativeMcpServer(s.runtime, investmentWriteTools(), [investmentImportAdapter]);
  const args = {
    path: "/synthetic.csv",
    account: encodeEntityRef("account", account.value.account),
    importer: "cashu",
  };
  return {
    ...s,
    publication,
    account: account.value.account,
    server,
    args,
    entered,
    release,
    blobs,
    stages,
    bind,
    counts: () => ({ fileReads, puts, blobReads, cleanups }),
    badReadback: () => {
      badReadback = true;
    },
    cleanupFailure: () => {
      cleanupFailure = true;
    },
  };
}
describe("native import proposal pipeline", () => {
  it.each(["strict", "amounts"] as const)(
    "stores actual preview/native blob ref and roundtrips T28 approval in %s",
    async (privacy) => {
      const s = setup();
      s.f.run(setProfileSettings, { mcpPrivacy: privacy });
      const result = await s.server.call("propose_import", {
        ...s.args,
        reason: "Synthetic pending import",
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ stored: true, preview: { new: 1n, can_commit: true } });
      const id = decodeEntityRef("proposal", (result.data as { proposal_id: string }).proposal_id);
      const snapshot = proposalExecution(s.f.store.read.bind(s.f.store), id);
      if (!snapshot) throw new Error("missing native proposal");
      expect(snapshot.payload).toMatchObject({
        account: s.account,
        blob: { sha256: sha256Hex(FILE), ext: "csv" },
        file_sha256: sha256Hex(FILE),
      });
      // Python propose_import: summary_params {account, importer, new, duplicates} (oracle: demo import proposal).
      expect(Object.keys(snapshot.payload.summary_params as object)).toEqual([
        "account",
        "importer",
        "new",
        "duplicates",
      ]);
      expect(snapshot.payload.summary_params).toMatchObject({ new: 1, duplicates: 0 });
      expect(snapshot.payload).not.toHaveProperty("account_id");
      expect(snapshot.payload).not.toHaveProperty("staged");
      expect(transactions(s.f.store.read.bind(s.f.store))).toHaveLength(0);
      const prepared = await prepareInvestmentImport(
        {
          store: s.f.store,
          blobs: s.publication,
          isHolder: (vault) => vault === s.f.vault && s.f.env.lease.isHolder(),
          now: s.f.env.clock.now,
        },
        snapshot,
      );
      if (!prepared.ok) throw new Error(prepared.reason);
      const approved = s.f.run(approvePrepared(prepared.value), {});
      expect(approved.ok).toBe(true);
      expect(transactions(s.f.store.read.bind(s.f.store))).toHaveLength(1);
      expect(s.commits()).toBe(1);
      expect(s.stages.size).toBe(0);
      expect(s.blobs.size).toBe(1);
      expect(s.counts()).toEqual({ fileReads: 1, puts: 1, blobReads: 2, cleanups: 1 });
    },
  );
  it("returns real blocking preview without publication or proposal", async () => {
    const s = setup();
    const result = await s.server.call("propose_import", { ...s.args, path: "/blocked.csv" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ stored: false, preview: { can_commit: false } });
    expect(s.counts().puts).toBe(0);
    expect(s.f.store.read("SELECT COUNT(*) AS n FROM proposals")).toEqual([{ n: 0 }]);
  });
  it("requires publication before reading a file and rejects foreign capability before access", async () => {
    const s = setup();
    s.services({
      readInvestmentImportFile: () => {
        throw new Error("must not access a file");
      },
    });
    expect((await s.server.call("propose_import", s.args)).errorKind).toBe("unsupported");
    s.bind({ ...s.publication, vault: "22222222222222222222222222222222" });
    expect((await s.server.call("propose_import", s.args)).errorKind).toBe("internal");
    expect(s.counts().fileReads).toBe(0);
    expect(s.counts().puts).toBe(0);
  });
  it("preserves script and wrong-kind/forged account refusals with zero file/blob effects", async () => {
    const s = setup();
    for (const args of [
      { ...s.args, path: "/converter.py" },
      { ...s.args, mapping: "converter.sh" },
      { ...s.args, account: encodeEntityRef("instrument", s.account) },
      { ...s.args, account: "account:forged" },
    ]) {
      expect((await s.server.call("propose_import", args)).ok).toBe(false);
    }
    expect(s.counts()).toEqual({ fileReads: 0, puts: 0, blobReads: 0, cleanups: 0 });
    expect(s.commits()).toBe(0);
  });
  it("retains published content but appends nothing on fresh module refusal", async () => {
    const s = setup(true);
    const pending = s.server.call("propose_import", s.args);
    await s.entered.promise;
    s.f.run(setModules, { moduleIds: ["budget"] });
    s.release.resolve();
    expect((await pending).errorKind).toBe("module_disabled");
    expect(s.blobs.size).toBe(1);
    expect(s.stages.size).toBe(0);
    expect(s.commits()).toBe(0);
    expect(s.f.store.read("SELECT COUNT(*) AS n FROM proposals")).toEqual([{ n: 0 }]);
  });
  it("refuses dishonest readback before proposal while preserving the durable blob", async () => {
    const s = setup();
    s.badReadback();
    expect((await s.server.call("propose_import", s.args)).errorKind).toBe("unavailable");
    expect(s.blobs.size).toBe(1);
    expect(s.stages.size).toBe(0);
    expect(s.commits()).toBe(0);
  });
  it("logs only fixed cleanup metadata and still creates a verified pending proposal", async () => {
    const s = setup();
    s.cleanupFailure();
    expect((await s.server.call("propose_import", s.args)).ok).toBe(true);
    expect(s.stages.size).toBe(1);
    expect(s.blobs.size).toBe(1);
    expect(s.warnings).toEqual(["mcp.import-stage-cleanup-failed"]);
    expect(s.commits()).toBe(1);
  });
});
