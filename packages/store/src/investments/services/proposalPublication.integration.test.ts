import { strategyDigest } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { runCommand, storeWriter } from "../../command.js";
import { createProposal, failApprovedProposal } from "../../core/proposal-commands.js";
import type { PreparedEffect } from "../../core/proposal-execution.js";
import { proposalExecution } from "../../core/proposal-execution.js";
import { executePreparedApproval, ProposalApplyingLock } from "../../core/proposal-service.js";
import { testEnv } from "../../testing/commands.js";
import { openTestStore } from "../../testing/store.js";
import { type SavedStrategyVersion, saveStrategyVersion } from "../commands/strategy.js";
import { latestStrategyVersion } from "../queries/strategy.js";
import { DailyPriceLock } from "./prices.js";
import {
  type PrivateStrategyJournal,
  prepareStrategyPublication,
  type StrategyFileImage,
  type StrategyPublicationFiles,
  type StrategyPublicationJournal,
} from "./proposalPublication.js";
import { prepareStrategyApproval } from "./proposalStrategy.js";
import { STRATEGY_MD, STRATEGY_YAML, type StrategyFileName } from "./strategy.js";

const YAML_A = "version: 1\nbase_currency: PLN\n";
const YAML_B = "version: 1\nbase_currency: EUR\n";
const YAML_C = "version: 1\nbase_currency: USD\n";
const VALID_YAML_A = `version: 1
base_currency: PLN
data:
  max_price_age_days: 5
  max_stale_weight: 1.0
  max_unclassified_weight: 1.0
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
allocation:
  targets: { stocks: 0.9, cash: 0.1 }
rules:
  - id: concentration
    kind: position_concentration
    severity: action
    params: { max_weight: 0.30 }
`;
const VALID_YAML_B = VALID_YAML_A.replace("max_weight: 0.30", "max_weight: 0.25");

class MemoryFiles implements StrategyPublicationFiles {
  readonly vault: string;
  image: StrategyFileImage;
  current = true;
  failInstallName: StrategyFileName | null = null;
  loseCurrentAfterInstallName: StrategyFileName | null = null;
  staged = 0;
  discarded = 0;
  readCalls = 0;

  constructor(vault: string, initial: StrategyFileImage) {
    this.vault = vault;
    this.image = { ...initial };
  }
  isCurrent(): boolean {
    return this.current;
  }
  async read(): Promise<StrategyFileImage> {
    this.readCalls += 1;
    return this.readSync();
  }
  readSync(): StrategyFileImage {
    return { ...this.image };
  }
  async stage(name: StrategyFileName, text: string): Promise<object> {
    this.staged += 1;
    return { name, text };
  }
  async install(name: StrategyFileName, temporary: object): Promise<void> {
    if (this.failInstallName === name) {
      this.failInstallName = null;
      throw new Error("synthetic rename failure");
    }
    const token = temporary as { name: StrategyFileName; text: string };
    if (token.name !== name) throw new Error("wrong synthetic temporary");
    this.image = { ...this.image, [name === STRATEGY_YAML ? "yaml" : "md"]: token.text };
    if (this.loseCurrentAfterInstallName === name) this.current = false;
  }
  async remove(name: StrategyFileName): Promise<void> {
    this.image = { ...this.image, [name === STRATEGY_YAML ? "yaml" : "md"]: null };
  }
  async discard(): Promise<void> {
    this.discarded += 1;
  }
}

class MemoryJournal implements PrivateStrategyJournal {
  readonly vault: string;
  saved: StrategyPublicationJournal | null = null;
  writes = 0;
  onRead: (() => void) | null = null;
  constructor(vault: string) {
    this.vault = vault;
  }
  async read(): Promise<StrategyPublicationJournal | null> {
    this.onRead?.();
    return this.saved === null ? null : structuredClone(this.saved);
  }
  async write(journal: StrategyPublicationJournal): Promise<void> {
    this.writes += 1;
    this.saved = structuredClone(journal);
  }
}

function fixture(initial: StrategyFileImage) {
  const store = openTestStore();
  const writer = storeWriter(store);
  const env = testEnv({ holder: false });
  const files = new MemoryFiles(store.vault, initial);
  const journal = new MemoryJournal(store.vault);
  const dailyLock = new DailyPriceLock();
  const applyingLock = new ProposalApplyingLock();
  const deps = {
    store,
    writer,
    env,
    dailyLock,
    applyingLock,
    runWrite: async <T>(work: () => T): Promise<T> => work(),
    isVaultCurrent: () => files.current,
    isHolder: () => false,
  };
  const create = (
    base: StrategyFileImage,
    target: StrategyFileImage,
    payload: Record<string, unknown> = {},
  ) => {
    const created = runCommand(
      store,
      writer,
      createProposal,
      {
        kind: "strategy",
        summary: "Invented strategy proposal",
        reason: null,
        payload,
        source: "synthetic",
      },
      env,
    );
    if (!created.ok) throw new Error("synthetic proposal refused");
    const proposalGid = created.value.proposalGid;
    const effect: PreparedEffect<SavedStrategyVersion> = {
      kind: "strategy",
      proposalGid,
      recheck: () => null,
      apply(ctx) {
        return saveStrategyVersion.run(ctx, { yamlText: target.yaml ?? "", mdText: target.md });
      },
      approvalResult: (value) => ({ version: value.version, state: value.state }),
    };
    const publicationDeps = {
      store,
      proposalGid,
      files,
      journal,
      isVaultCurrent: () => files.current,
    };
    return { proposalGid, effect, publicationDeps, base, target };
  };
  return { store, writer, env, files, journal, deps, create };
}

describe("strategy proposal file publication and folded lifecycle", () => {
  it("publishes a caused version without an import lease and keeps unchanged MD", async () => {
    const base = { yaml: YAML_A, md: "Invented note" };
    const f = fixture(base);
    const prepared = f.create(base, { yaml: YAML_B, md: base.md });
    const publication = await prepareStrategyPublication(
      prepared.publicationDeps,
      prepared.base,
      prepared.target,
    );
    const result = await executePreparedApproval(f.deps, prepared.effect, publication);
    expect(result.status).toBe("approved");
    expect(f.files.image).toEqual({ yaml: YAML_B, md: base.md });
    expect(f.journal.saved?.pending).toBeNull();
    expect(f.journal.saved?.baseline).toEqual(base);
    expect(latestStrategyVersion(f.store.read.bind(f.store))?.yamlText).toBe(YAML_B);
  });

  it("uses the actual strategy planner to preserve MD when the proposal omits it", async () => {
    const base = { yaml: VALID_YAML_A, md: "Synthetic note retained" };
    const f = fixture(base);
    const created = f.create(
      base,
      { yaml: VALID_YAML_B, md: base.md },
      {
        base_sha256: strategyDigest(base.yaml, base.md),
        yaml: VALID_YAML_B,
        md: null,
      },
    );
    const proposal = proposalExecution(f.store.read.bind(f.store), created.proposalGid);
    if (proposal === undefined) throw new Error("synthetic proposal missing");
    const planned = await prepareStrategyApproval({
      store: f.store,
      proposal,
      files: f.files,
      journal: f.journal,
      isVaultCurrent: () => f.files.current,
    });
    expect(planned.mdText).toBe(base.md);
    expect(
      (await executePreparedApproval(f.deps, planned.effect, planned.publication)).status,
    ).toBe("approved");
    await planned.publication.reconcile?.();
    expect(f.files.image).toEqual({ yaml: VALID_YAML_B, md: base.md });
    expect(latestStrategyVersion(f.store.read.bind(f.store))?.mdText).toBe(base.md);
  });

  it("uses Python-normalized base digest while publishing and reconciling raw CRLF text", async () => {
    const rawMd = "Synthetic\r\nnote\r";
    const semanticMd = "Synthetic\nnote\n";
    const base = { yaml: VALID_YAML_A.replace(/\n/gu, "\r\n"), md: rawMd };
    const f = fixture(base);
    const proposed = VALID_YAML_B.replace(/\n/gu, "\r\n");
    const created = f.create(
      base,
      { yaml: proposed, md: rawMd },
      {
        base_sha256: strategyDigest(VALID_YAML_A, semanticMd),
        yaml: proposed,
        md: null,
      },
    );
    const proposal = proposalExecution(f.store.read.bind(f.store), created.proposalGid);
    if (proposal === undefined) throw new Error("synthetic proposal missing");
    const planned = await prepareStrategyApproval({
      store: f.store,
      proposal,
      files: f.files,
      journal: f.journal,
      isVaultCurrent: () => f.files.current,
    });
    const result = await executePreparedApproval(f.deps, planned.effect, planned.publication);
    expect(result.status).toBe("approved");
    expect(f.files.image.yaml).toBe(proposed);
    expect(f.files.image.md).toBe(rawMd);
    expect(f.files.readSync().yaml).toBe(proposed);
    expect(f.journal.saved?.managed.image.yaml).toBe(proposed);
    expect(f.journal.saved?.managed.image.md).toBe(rawMd);
    expect(latestStrategyVersion(f.store.read.bind(f.store))?.yamlText).toBe(proposed);
    expect(latestStrategyVersion(f.store.read.bind(f.store))?.mdText).toBe(semanticMd);
    await planned.publication.reconcile?.();
    expect(f.files.image.yaml).toBe(proposed);
  });

  it("uses the stored proposal when a retained display payload changes during preparation", async () => {
    const base = { yaml: VALID_YAML_A, md: null };
    const f = fixture(base);
    const created = f.create(
      base,
      { yaml: VALID_YAML_B, md: null },
      {
        base_sha256: strategyDigest(base.yaml, base.md),
        yaml: VALID_YAML_B,
        md: null,
      },
    );
    const proposal = proposalExecution(f.store.read.bind(f.store), created.proposalGid);
    if (proposal === undefined) throw new Error("synthetic proposal missing");
    f.journal.onRead = () => {
      (proposal.payload as Record<string, unknown>).yaml = VALID_YAML_A;
    };
    const planned = await prepareStrategyApproval({
      store: f.store,
      proposal,
      files: f.files,
      journal: f.journal,
      isVaultCurrent: () => f.files.current,
    });
    expect(planned.yamlText).toBe(VALID_YAML_B);
    expect(
      (await executePreparedApproval(f.deps, planned.effect, planned.publication)).status,
    ).toBe("approved");
    expect(latestStrategyVersion(f.store.read.bind(f.store))?.yamlText).toBe(VALID_YAML_B);
  });

  it("rejects a forged display payload before reading strategy files", async () => {
    const base = { yaml: VALID_YAML_A, md: null };
    const f = fixture(base);
    const created = f.create(
      base,
      { yaml: VALID_YAML_B, md: null },
      {
        base_sha256: strategyDigest(base.yaml, base.md),
        yaml: VALID_YAML_B,
        md: null,
      },
    );
    const proposal = proposalExecution(f.store.read.bind(f.store), created.proposalGid);
    if (proposal === undefined) throw new Error("synthetic proposal missing");
    await expect(
      prepareStrategyApproval({
        store: f.store,
        proposal: { ...proposal, payload: { ...proposal.payload, yaml: VALID_YAML_A } },
        files: f.files,
        journal: f.journal,
        isVaultCurrent: () => f.files.current,
      }),
    ).rejects.toMatchObject({ code: "proposal_changed" });
    expect(f.files.readCalls).toBe(0);
    expect(f.journal.writes).toBe(0);
  });

  it("restores a mixed rename and revokes the caused version after a publication failure", async () => {
    const base = { yaml: YAML_A, md: "Before" };
    const f = fixture(base);
    const prepared = f.create(base, { yaml: YAML_B, md: "After" });
    const publication = await prepareStrategyPublication(
      prepared.publicationDeps,
      prepared.base,
      prepared.target,
    );
    f.files.failInstallName = STRATEGY_MD;
    const result = await executePreparedApproval(f.deps, prepared.effect, publication);
    expect(result.status).toBe("failed");
    expect(f.files.image).toEqual(base);
    expect(f.journal.saved?.pending).toBeNull();
    expect(latestStrategyVersion(f.store.read.bind(f.store))).toBeUndefined();
    expect(proposalExecution(f.store.read.bind(f.store), prepared.proposalGid)?.status).toBe(
      "failed",
    );
  });

  it("returns to the unmanaged baseline after successive caused versions are revoked", async () => {
    const base = { yaml: YAML_A, md: null };
    const f = fixture(base);
    const approvals: { gid: string; eid: string }[] = [];
    for (const target of [
      { yaml: YAML_B, md: null },
      { yaml: YAML_C, md: null },
    ]) {
      const prepared = f.create({ ...f.files.image }, target);
      const publication = await prepareStrategyPublication(
        prepared.publicationDeps,
        prepared.base,
        prepared.target,
      );
      const result = await executePreparedApproval(f.deps, prepared.effect, publication);
      expect(result.status).toBe("approved");
      if (result.status === "approved")
        approvals.push({ gid: prepared.proposalGid, eid: result.approvalEid });
    }
    for (const approval of approvals.toReversed()) {
      const failed = runCommand(
        f.store,
        f.writer,
        failApprovedProposal,
        {
          proposalGid: approval.gid,
          approvalEid: approval.eid,
          result: { error_code: "synthetic_late_failure" },
        },
        f.env,
      );
      expect(failed.ok).toBe(true);
    }
    const last = f.create({ ...f.files.image }, { ...f.files.image });
    const publication = await prepareStrategyPublication(
      last.publicationDeps,
      last.base,
      last.target,
    );
    await publication.reconcile?.();
    expect(f.files.image).toEqual(base);
    expect(f.journal.saved?.baseline).toEqual(base);
    expect(latestStrategyVersion(f.store.read.bind(f.store))).toBeUndefined();
  });

  it("restores an unrecorded live base instead of an older stored version", async () => {
    const f = fixture({ yaml: YAML_B, md: "Live note" });
    const older = runCommand(
      f.store,
      f.writer,
      saveStrategyVersion,
      { yamlText: YAML_A, mdText: "Stored note" },
      f.env,
    );
    expect(older.ok).toBe(true);
    const base = { ...f.files.image };
    const prepared = f.create(base, { yaml: YAML_C, md: "New note" });
    const publication = await prepareStrategyPublication(
      prepared.publicationDeps,
      prepared.base,
      prepared.target,
    );
    f.files.failInstallName = STRATEGY_MD;
    expect((await executePreparedApproval(f.deps, prepared.effect, publication)).status).toBe(
      "failed",
    );
    expect(f.files.image).toEqual(base);
    expect(latestStrategyVersion(f.store.read.bind(f.store))?.yamlText).toBe(YAML_A);
    expect(f.journal.saved?.baseline).toEqual(base);
  });

  it("keeps a no-op stored-version approval until its exact receipt is revoked", async () => {
    const liveBase = { yaml: VALID_YAML_B, md: null };
    const f = fixture(liveBase);
    const stored = runCommand(
      f.store,
      f.writer,
      saveStrategyVersion,
      { yamlText: VALID_YAML_A, mdText: null },
      f.env,
    );
    expect(stored.ok).toBe(true);
    const created = f.create(
      liveBase,
      { yaml: VALID_YAML_A, md: null },
      {
        base_sha256: strategyDigest(liveBase.yaml, liveBase.md),
        yaml: VALID_YAML_A,
        md: null,
      },
    );
    const proposal = proposalExecution(f.store.read.bind(f.store), created.proposalGid);
    if (proposal === undefined) throw new Error("synthetic proposal missing");
    const planned = await prepareStrategyApproval({
      store: f.store,
      proposal,
      files: f.files,
      journal: f.journal,
      isVaultCurrent: () => f.files.current,
    });
    const result = await executePreparedApproval(f.deps, planned.effect, planned.publication);
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    expect(result.effect.recorded).toBe(false);
    expect(f.files.image.yaml).toBe(VALID_YAML_A);
    await planned.publication.reconcile?.();
    expect(f.files.image.yaml).toBe(VALID_YAML_A);
    const failed = runCommand(
      f.store,
      f.writer,
      failApprovedProposal,
      {
        proposalGid: created.proposalGid,
        approvalEid: result.approvalEid,
        result: { error_code: "synthetic_late_failure" },
      },
      f.env,
    );
    expect(failed.ok).toBe(true);
    await planned.publication.reconcile?.();
    expect(f.files.image).toEqual(liveBase);
    expect(latestStrategyVersion(f.store.read.bind(f.store))?.yamlText).toBe(VALID_YAML_A);
  });

  it("restores an earlier effective version without changing its kept raw MD line endings", async () => {
    const rawMd = "Synthetic\r\nnote\r";
    const semanticMd = "Synthetic\nnote\n";
    const f = fixture({ yaml: VALID_YAML_A, md: rawMd });
    let last: {
      gid: string;
      eid: string;
      reconcile: () => Promise<void>;
    } | null = null;
    for (const yaml of [VALID_YAML_B, VALID_YAML_A]) {
      const base = { ...f.files.image };
      const created = f.create(
        base,
        { yaml, md: rawMd },
        {
          base_sha256: strategyDigest(base.yaml ?? "", semanticMd),
          yaml,
          md: null,
        },
      );
      const proposal = proposalExecution(f.store.read.bind(f.store), created.proposalGid);
      if (proposal === undefined) throw new Error("synthetic proposal missing");
      const planned = await prepareStrategyApproval({
        store: f.store,
        proposal,
        files: f.files,
        journal: f.journal,
        isVaultCurrent: () => f.files.current,
      });
      const result = await executePreparedApproval(f.deps, planned.effect, planned.publication);
      expect(result.status).toBe("approved");
      if (result.status === "approved")
        last = {
          gid: created.proposalGid,
          eid: result.approvalEid,
          reconcile: async () => {
            await planned.publication.reconcile?.();
          },
        };
    }
    if (last === null) throw new Error("synthetic approvals missing");
    expect(
      runCommand(
        f.store,
        f.writer,
        failApprovedProposal,
        {
          proposalGid: last.gid,
          approvalEid: last.eid,
          result: { error_code: "synthetic_late_failure" },
        },
        f.env,
      ).ok,
    ).toBe(true);
    await last.reconcile();
    expect(f.files.image).toEqual({ yaml: VALID_YAML_B, md: rawMd });
    expect(latestStrategyVersion(f.store.read.bind(f.store))?.mdText).toBe(semanticMd);
  });

  it("keeps an earlier no-op receipt after a later version loses, then restores the unmanaged base", async () => {
    const unmanaged = { yaml: VALID_YAML_B, md: "Invented retained note" };
    const f = fixture(unmanaged);
    const stored = runCommand(
      f.store,
      f.writer,
      saveStrategyVersion,
      { yamlText: VALID_YAML_A, mdText: unmanaged.md },
      f.env,
    );
    expect(stored.ok).toBe(true);
    const first = f.create(
      unmanaged,
      { yaml: VALID_YAML_A, md: unmanaged.md },
      {
        base_sha256: strategyDigest(unmanaged.yaml, unmanaged.md),
        yaml: VALID_YAML_A,
        md: null,
      },
    );
    const firstSnapshot = proposalExecution(f.store.read.bind(f.store), first.proposalGid);
    if (firstSnapshot === undefined) throw new Error("synthetic first proposal missing");
    const firstPlan = await prepareStrategyApproval({
      store: f.store,
      proposal: firstSnapshot,
      files: f.files,
      journal: f.journal,
      isVaultCurrent: () => f.files.current,
    });
    const firstResult = await executePreparedApproval(
      f.deps,
      firstPlan.effect,
      firstPlan.publication,
    );
    expect(firstResult.status).toBe("approved");
    if (firstResult.status !== "approved") return;
    expect(firstResult.effect.recorded).toBe(false);

    const second = f.create(
      { ...f.files.image },
      { yaml: VALID_YAML_B, md: unmanaged.md },
      {
        base_sha256: strategyDigest(VALID_YAML_A, unmanaged.md),
        yaml: VALID_YAML_B,
        md: null,
      },
    );
    const secondSnapshot = proposalExecution(f.store.read.bind(f.store), second.proposalGid);
    if (secondSnapshot === undefined) throw new Error("synthetic second proposal missing");
    const secondPlan = await prepareStrategyApproval({
      store: f.store,
      proposal: secondSnapshot,
      files: f.files,
      journal: f.journal,
      isVaultCurrent: () => f.files.current,
    });
    const secondResult = await executePreparedApproval(
      f.deps,
      secondPlan.effect,
      secondPlan.publication,
    );
    expect(secondResult.status).toBe("approved");
    if (secondResult.status !== "approved") return;
    expect(
      runCommand(
        f.store,
        f.writer,
        failApprovedProposal,
        {
          proposalGid: second.proposalGid,
          approvalEid: secondResult.approvalEid,
          result: { error_code: "synthetic_late_failure" },
        },
        f.env,
      ).ok,
    ).toBe(true);
    await secondPlan.publication.reconcile?.();
    expect(f.files.image).toEqual({ yaml: VALID_YAML_A, md: unmanaged.md });
    expect(
      runCommand(
        f.store,
        f.writer,
        failApprovedProposal,
        {
          proposalGid: first.proposalGid,
          approvalEid: firstResult.approvalEid,
          result: { error_code: "synthetic_late_failure" },
        },
        f.env,
      ).ok,
    ).toBe(true);
    await secondPlan.publication.reconcile?.();
    expect(f.files.image).toEqual(unmanaged);
  });

  it("refuses to overwrite an unknown user edit while reconciling", async () => {
    const base = { yaml: YAML_A, md: null };
    const f = fixture(base);
    const prepared = f.create(base, { yaml: YAML_B, md: null });
    const publication = await prepareStrategyPublication(
      prepared.publicationDeps,
      prepared.base,
      prepared.target,
    );
    expect((await executePreparedApproval(f.deps, prepared.effect, publication)).status).toBe(
      "approved",
    );
    f.files.image = { yaml: "user edit", md: null };
    await expect(publication.reconcile?.()).rejects.toThrow("user_changed");
    expect(f.files.image.yaml).toBe("user edit");
  });

  it("leaves an interrupted private intent for the restored authority to reconcile", async () => {
    const base = { yaml: YAML_A, md: "Before" };
    const target = { yaml: YAML_B, md: "After" };
    const f = fixture(base);
    const prepared = f.create(base, target);
    const publication = await prepareStrategyPublication(
      prepared.publicationDeps,
      prepared.base,
      prepared.target,
    );
    f.files.loseCurrentAfterInstallName = STRATEGY_YAML;
    const result = await executePreparedApproval(f.deps, prepared.effect, publication);
    expect(result).toMatchObject({ status: "recovery_needed", reason: "authority_lost" });
    expect(f.files.image).toEqual({ yaml: YAML_B, md: "Before" });
    expect(f.journal.saved?.pending).not.toBeNull();
    f.files.current = true;
    f.files.loseCurrentAfterInstallName = null;
    const resumed = await prepareStrategyPublication(
      prepared.publicationDeps,
      prepared.base,
      prepared.target,
    );
    await resumed.reconcile?.();
    expect(f.files.image).toEqual(target);
    expect(f.journal.saved?.pending).toBeNull();
  });
});
