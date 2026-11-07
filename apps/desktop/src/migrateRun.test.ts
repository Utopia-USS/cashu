import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startupFailure } from "@cashu/host-protocol/startup-failure";
import { describe, expect, it } from "vitest";
import { importDoneEvent, type MigrateHandlers, runMigration } from "./migrateRun.js";

const WORDS = Array.from("abcdefghijklmnopqrstuvwx", (letter) => `syn${letter}`).join(" ");

/** A child speaking the migrate protocol from a script; stdin answers are collected. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  stdinText = "";
  stdinEnded = false;
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinText += chunk.toString();
    });
    this.stdin.on("end", () => {
      this.stdinEnded = true;
    });
  }
  line(value: unknown): void {
    this.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  }
  exit(code: number | null): void {
    this.stdout.once("end", () => this.emit("close", code));
    this.stdout.end();
  }
  /** Resolves with the next stdin line. */
  async answer(): Promise<string> {
    const start = this.stdinText.length;
    while (!this.stdinText.slice(start).includes("\n") && !this.stdinEnded)
      await new Promise((resolve) => setTimeout(resolve, 1));
    return this.stdinText.slice(start);
  }
}

function handlers(confirm: boolean | "reject" = true) {
  const stages: string[] = [];
  const shown: string[] = [];
  const h: MigrateHandlers = {
    progress: (stage) => stages.push(stage),
    words: async (words) => {
      shown.push(words);
      if (confirm === "reject") throw new Error("window gone");
      return confirm;
    },
  };
  return { h, stages, shown };
}

describe("runMigration", () => {
  it("reports progress, confirms the words and finishes on done with exit 0", async () => {
    const child = new FakeChild();
    const { h, stages, shown } = handlers(true);
    const outcome = runMigration(child, h);
    child.line({ event: "progress", stage: "preflight" });
    child.line({ event: "progress", stage: "copy" });
    child.line({ event: "progress", stage: "import" });
    child.line({ event: "recovery-words", words: WORDS });
    expect(await child.answer()).toBe("confirm\n");
    child.line({ event: "progress", stage: "verify" });
    child.line({ event: "progress", stage: "cutover" });
    child.line({
      event: "done",
      status: "migrated",
      profiles: 2,
      financialTables: 9,
      financialRows: 120,
      vaults: 2,
      backupDir: "python-backup-20261104T093000Z",
      unpriced: [{ label: "SEUR", currency: "EUR", reason: "no_fx" }],
    });
    child.exit(0);
    const result = await outcome;
    expect(result).toEqual({
      kind: "done",
      done: {
        event: "done",
        status: "migrated",
        profiles: 2,
        financialTables: 9,
        financialRows: 120,
        vaults: 2,
        backupDir: "python-backup-20261104T093000Z",
        unpriced: [{ label: "SEUR", currency: "EUR", reason: "no_fx" }],
      },
    });
    expect(stages).toEqual(["preflight", "copy", "import", "verify", "cutover"]);
    expect(shown).toEqual([WORDS]);
    expect(JSON.stringify(result)).not.toContain("syna");
  });

  it("accepts already_migrated without counts", async () => {
    const child = new FakeChild();
    const outcome = runMigration(child, handlers().h);
    child.line({ event: "done", status: "already_migrated" });
    child.exit(0);
    expect(await outcome).toEqual({
      kind: "done",
      done: { event: "done", status: "already_migrated" },
    });
  });

  it("cancels on the user's word: cancel is written, stdin closed, the outcome is cancelled", async () => {
    for (const answer of [false, "reject"] as const) {
      const child = new FakeChild();
      const outcome = runMigration(child, handlers(answer).h);
      child.line({ event: "recovery-words", words: WORDS });
      expect(await child.answer()).toBe("cancel\n");
      expect(child.stdinEnded).toBe(true);
      child.line({ event: "failed", code: "migrate_import_failed", detail: "cancelled" });
      child.exit(1);
      expect(await outcome).toEqual({ kind: "cancelled" });
    }
  });

  it("maps a failed line with exit 1 to that failure", async () => {
    const child = new FakeChild();
    const outcome = runMigration(child, handlers().h);
    child.line({ event: "progress", stage: "cutover" });
    child.line({ event: "failed", code: "migration_incomplete", detail: "cutover_failed" });
    child.exit(1);
    expect(await outcome).toEqual({
      kind: "failed",
      failure: startupFailure("migration_incomplete", "cutover_failed"),
    });
  });

  it("treats every protocol break as an unknown failure", async () => {
    const unknown = { kind: "failed", failure: startupFailure("unknown") };
    const scripts: ((child: FakeChild) => void)[] = [
      (c) => {
        c.line("not json");
        c.line({ event: "done", status: "migrated" });
        c.exit(0);
      },
      (c) => {
        c.line({ event: "progress", stage: "copy", note: "extra" });
        c.exit(0);
      },
      (c) => {
        c.line({ event: "done", status: "migrated" });
        c.exit(1);
      },
      (c) => {
        c.line({ event: "failed", code: "migrate_import_failed" });
        c.exit(0);
      },
      (c) => {
        c.line({ event: "progress", stage: "import" });
        c.exit(134);
      },
      (c) => {
        c.line({ event: "progress", stage: "import" });
        c.exit(null);
      },
      (c) => {
        c.line({ event: "done", status: "migrated" });
        c.line({ event: "progress", stage: "verify" });
        c.exit(0);
      },
      (c) => {
        c.line({ event: "failed", code: "unknown", detail: "PL61109010140000071219812874" });
        c.exit(1);
      },
      (c) => c.emit("error", new Error("spawn ENOENT")),
    ];
    for (const script of scripts) {
      const child = new FakeChild();
      const outcome = runMigration(child, handlers().h);
      script(child);
      expect(await outcome).toEqual(unknown);
    }
  });

  it("closes stdin on a broken line so a child waiting for an answer aborts", async () => {
    const child = new FakeChild();
    const { h, shown } = handlers(true);
    const outcome = runMigration(child, h);
    child.line("{bad");
    child.line({ event: "recovery-words", words: WORDS });
    await child.answer();
    expect(child.stdinEnded).toBe(true);
    expect(child.stdinText).toBe("");
    expect(shown).toEqual([]);
    child.exit(1);
    expect((await outcome).kind).toBe("failed");
  });

  it("refuses a second words line", async () => {
    const child = new FakeChild();
    const { h, shown } = handlers(true);
    const outcome = runMigration(child, h);
    child.line({ event: "recovery-words", words: WORDS });
    expect(await child.answer()).toBe("confirm\n");
    child.line({ event: "recovery-words", words: WORDS });
    child.line({ event: "done", status: "migrated" });
    child.exit(0);
    expect(await outcome).toEqual({ kind: "failed", failure: startupFailure("unknown") });
    expect(shown).toHaveLength(1);
  });
});

describe("importDoneEvent", () => {
  const launcher = "/Users/synthetic/Library/Application Support/cashU/bin/cashu";
  const agents = {
    bootout: "ran" as const,
    agents: [
      { label: "io.utopiasoft.cashu.worker" as const, state: "retired" as const },
      { label: "io.github.synszakala.finanse.worker" as const, state: "absent" as const },
    ],
  };

  it("builds the setup screen's MCP lines per imported profile, remove before add", () => {
    expect(
      importDoneEvent(
        { event: "done", status: "migrated", mcpProfiles: ["anna", "dom"], agents },
        launcher,
        "cashu",
      ),
    ).toEqual({
      kind: "done",
      unpriced: [],
      mcpCommands: [
        "claude mcp remove cashu-anna",
        `claude mcp add cashu-anna -- '${launcher}' mcp --profile anna`,
        "claude mcp remove cashu-dom",
        `claude mcp add cashu-dom -- '${launcher}' mcp --profile dom`,
      ],
      agents,
    });
  });

  it("keeps the unpriced list, and is null when there is nothing to show", () => {
    const unpriced = [{ label: "SEUR", currency: "EUR", reason: "no_prices" as const }];
    expect(
      importDoneEvent({ event: "done", status: "migrated", unpriced }, launcher, "cashu"),
    ).toEqual({
      kind: "done",
      unpriced,
      mcpCommands: [],
      agents: null,
    });
    expect(
      importDoneEvent({ event: "done", status: "already_migrated" }, launcher, "cashu"),
    ).toBeNull();
    expect(
      importDoneEvent(
        { event: "done", status: "migrated", unpriced: [], mcpProfiles: [] },
        launcher,
        "cashu",
      ),
    ).toBeNull();
  });
});
