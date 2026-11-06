import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  migrateDoneSchema,
  migrateFailedSchema,
  migrateProgressSchema,
  migrateWordsSchema,
  parseMigrateLine,
  parseStartupFailureRecord,
  parseStartupFailureReport,
} from "@cashu/host-protocol/startup-failure";
import type { createProductionKeyStore } from "@cashu/node-host/keyring";
import { afterEach, describe, expect, it } from "vitest";
import { migrateCommand } from "./cli.js";
import {
  PYTHON_NAMES,
  type PythonFixture,
  pythonFixture,
  treeHashes,
} from "./testing/inPlaceFixture.js";

const AT = Date.parse("2027-01-01T00:00:00Z");
const BACKUP = "python-backup-20270101T000000000Z";
const STAGING = ".migration-20270101T000000000Z";
const KEK = "cashu.keystore.kek";
const SLOW = 120_000;

const fixtures: PythonFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});
function fixture(): PythonFixture {
  const f = pythonFixture();
  fixtures.push(f);
  return f;
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function cli(
  f: PythonFixture,
  argv: readonly string[],
  options: {
    answer?: string | null;
    onStdout?: (line: string) => void;
    makeKeyStore?: typeof createProductionKeyStore;
    afterCutoverMove?: (moves: number) => void;
  } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await migrateCommand(argv, {
    env: { CASHU_LANG: "en", HOME: f.base },
    stdout(line) {
      out.push(line);
      options.onStdout?.(line);
    },
    stderr: (line) => err.push(line),
    readLine: async () => (options.answer === undefined ? null : options.answer),
    build: "test-build",
    now: () => AT,
    keychain: { ...f.keychain, makeKeyStore: options.makeKeyStore ?? f.makeKeyStore },
    ...(options.afterCutoverMove === undefined
      ? {}
      : { afterCutoverMove: options.afterCutoverMove }),
  });
  return { code, out, err };
}

const lines = (run: Run) => run.out.map((line) => parseMigrateLine(line));

function diagnostics(f: PythonFixture): string[] {
  try {
    return readdirSync(join(f.dataDir, "diagnostics")).sort();
  } catch {
    return [];
  }
}

/** Nothing of the failed run is left: no staging, no backup, no KEK, no marker. */
function expectUntouched(f: PythonFixture, before: Record<string, string>, except: string[] = []) {
  const after = treeHashes(f.dataDir, PYTHON_NAMES);
  for (const path of except) {
    delete before[path];
    delete after[path];
  }
  expect(after).toEqual(before);
  const names = readdirSync(f.dataDir);
  expect(
    names.filter((name) => name.startsWith(".migration-") || name.startsWith("python-backup-")),
  ).toEqual([]);
  expect(names.includes("migration.json")).toBe(false);
  expect(f.items.size).toBe(0);
}

describe("cashu migrate --json (the app's child protocol)", () => {
  it(
    "speaks the protocol, waits for confirm, then is a no-op; verify passes and fails read-only",
    async () => {
      const f = fixture();
      const migrated = await cli(f, ["--data-dir", f.dataDir, "--json"], { answer: "confirm" });
      expect(migrated.code).toBe(0);
      const parsed = lines(migrated);
      expect(parsed.every((line) => line !== null)).toBe(true);
      expect(parsed.map((line) => (line?.event === "progress" ? line.stage : line?.event))).toEqual(
        ["preflight", "copy", "import", "recovery-words", "verify", "cutover", "done"],
      );
      expect(migrateProgressSchema.safeParse(JSON.parse(migrated.out[0] ?? "")).success).toBe(true);
      expect(
        migrateWordsSchema.parse(JSON.parse(migrated.out[3] ?? "")).words.split(" "),
      ).toHaveLength(24);
      const done = migrateDoneSchema.parse(JSON.parse(migrated.out.at(-1) ?? ""));
      expect(done).toMatchObject({ status: "migrated", profiles: 1, vaults: 1, backupDir: BACKUP });
      expect(migrated.err).toEqual([]);
      expect(diagnostics(f)).toEqual([]);

      const again = await cli(f, ["--data-dir", f.dataDir, "--json"]);
      expect(again.code).toBe(0);
      expect(done.unpriced).toEqual([]);
      const { unpriced: _checked, ...counted } = done;
      expect(lines(again).at(-1)).toEqual({ ...counted, status: "already_migrated" });

      const verified = await cli(f, ["verify", "--data-dir", f.dataDir, "--json"]);
      expect(verified.code).toBe(0);
      expect(verified.out.map((line) => parseMigrateLine(line))).toEqual([
        { ...done, status: "verified" },
      ]);
      const human = await cli(f, ["verify", "--data-dir", f.dataDir]);
      expect(human.code).toBe(0);
      expect(human.out).toEqual([
        `Verification passed: profiles 1, tables ${done.financialTables}, rows ${done.financialRows}, vaults 1 (source: ~/data/${BACKUP}).`,
      ]);

      const device = new DatabaseSync(join(f.dataDir, "stores", "device.db"));
      try {
        device.prepare("UPDATE local_market_macro_bars SET close=? WHERE id=1").run("999");
      } finally {
        device.close();
      }
      const listing = readdirSync(f.dataDir).sort();
      const mismatch = await cli(f, ["verify", "--data-dir", f.dataDir]);
      expect(mismatch.code).toBe(1);
      expect(mismatch.err[0]).toBe(
        "Verification failed (migrate_verify_mismatch, replay_mismatch). Nothing was changed.",
      );
      expect(mismatch.err[1]).toMatch(
        /^Report for your assistant: ~\/data\/diagnostics\/startup-failure-\d{8}T\d{9}Z\.txt$/,
      );
      expect(readdirSync(f.dataDir).sort()).toEqual(listing);
      const record = parseStartupFailureRecord(
        JSON.parse(readFileSync(join(f.dataDir, "diagnostics", "startup-failure.json"), "utf8")),
      );
      expect(record?.failure).toMatchObject({
        code: "migrate_verify_mismatch",
        detail: "replay_mismatch",
      });
      const jsonMismatch = await cli(f, ["verify", "--data-dir", f.dataDir, "--json"]);
      expect(jsonMismatch.code).toBe(1);
      expect(migrateFailedSchema.parse(JSON.parse(jsonMismatch.out[0] ?? ""))).toEqual({
        event: "failed",
        code: "migrate_verify_mismatch",
        detail: "replay_mismatch",
      });
    },
    SLOW,
  );

  it(
    "names the instruments the app cannot value on the done line of the import and of verify",
    async () => {
      const f = fixture();
      const db = new DatabaseSync(join(f.dataDir, "cashu.db"));
      try {
        const at = "2026-01-02 03:04:05.000000";
        db.prepare(
          `INSERT INTO inv_instruments(id,name,currency,asset_class,symbol,isin,tags,
             needs_classification,valuation_mode,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          1,
          "Synthetic Euro ETF",
          "EUR",
          "etf",
          "SEUR",
          null,
          "[]",
          0,
          "market",
          "active",
          at,
          at,
        );
        db.prepare(
          "INSERT INTO inv_profile_instruments(id,profile_id,instrument_id,created_at,updated_at) VALUES (?,?,?,?,?)",
        ).run(1, 1, 1, at, at);
      } finally {
        db.close();
      }
      const unpriced = [{ label: "SEUR", currency: "EUR", reason: "no_prices" }];
      const migrated = await cli(f, ["--data-dir", f.dataDir, "--json"], { answer: "confirm" });
      expect(migrated.code).toBe(0);
      expect(migrateDoneSchema.parse(JSON.parse(migrated.out.at(-1) ?? ""))).toMatchObject({
        status: "migrated",
        unpriced,
      });
      const verified = await cli(f, ["verify", "--data-dir", f.dataDir, "--json"]);
      expect(verified.code).toBe(0);
      expect(lines(verified)).toEqual([expect.objectContaining({ status: "verified", unpriced })]);
      const human = await cli(f, ["verify", "--data-dir", f.dataDir]);
      expect(human.out.at(-1)).toBe(
        "Warning: the app cannot value 1 instruments (0 until it has prices):\n  SEUR (EUR): no prices",
      );
    },
    SLOW,
  );

  it.each([["cancel"], [null], ["yes"]])(
    "aborts with nothing created when the words answer is %j",
    async (answer) => {
      const f = fixture();
      const before = treeHashes(f.dataDir, PYTHON_NAMES);
      const run = await cli(f, ["--data-dir", f.dataDir, "--json"], { answer });
      expect(run.code).toBe(1);
      expect(lines(run).at(-1)).toEqual({
        event: "failed",
        code: "migrate_import_failed",
        detail: "cancelled",
      });
      expect(lines(run).filter((line) => line?.event === "recovery-words")).toHaveLength(1);
      expectUntouched(f, before);
      // A cancel needs no recovery: no record, no report.
      expect(diagnostics(f)).toEqual([]);
    },
    SLOW,
  );
});

describe("cashu migrate (human mode) failures", () => {
  type Fault = (f: PythonFixture) => {
    onStdout?: (line: string) => void;
    makeKeyStore?: typeof createProductionKeyStore;
    restore?: () => void;
    changed?: string[];
  };
  const faults: [string, string, string, Fault][] = [
    [
      "copy",
      "migrate_import_failed",
      "staging_failed",
      (f) => {
        const file = join(f.dataDir, "backups", "cashu-20260101.db");
        chmodSync(file, 0o000);
        return { restore: () => chmodSync(file, 0o600) };
      },
    ],
    [
      "import",
      "migrate_import_failed",
      "keystore_unavailable",
      (f) => ({
        // The import fails after its KEK was created in D's namespace.
        makeKeyStore(input) {
          if (f.items.has(`${f.service}/${KEK}`) && input.purpose === "open")
            throw new Error("keystore_unavailable");
          return f.makeKeyStore(input);
        },
      }),
    ],
    [
      "verify",
      "migrate_import_failed",
      "replay_mismatch",
      (f) => ({
        onStdout(line) {
          if (line !== "Verifying the import...") return;
          const device = new DatabaseSync(
            join(f.dataDir, STAGING, "native", "stores", "device.db"),
          );
          try {
            device.prepare("UPDATE local_market_macro_bars SET close=? WHERE id=1").run("999");
          } finally {
            device.close();
          }
        },
      }),
    ],
    [
      "a source change",
      "migrate_import_failed",
      "source_changed",
      (f) => ({
        onStdout(line) {
          if (line === "Verifying the import...")
            appendFileSync(join(f.dataDir, "logs", "cashu.log"), "written meanwhile\n");
        },
        changed: ["logs/cashu.log"],
      }),
    ],
  ];

  it.each(faults)(
    "a failure at %s leaves the originals intact, removes staging and KEK and writes the report",
    async (_stage, code, detail, fault) => {
      const f = fixture();
      const before = treeHashes(f.dataDir, PYTHON_NAMES);
      const words = join(f.base, "words.txt");
      const injected = fault(f);
      const run = await cli(f, ["--recovery-file", words, "--data-dir", f.dataDir], {
        ...(injected.onStdout === undefined ? {} : { onStdout: injected.onStdout }),
        ...(injected.makeKeyStore === undefined ? {} : { makeKeyStore: injected.makeKeyStore }),
      });
      injected.restore?.();
      expect(run.code).toBe(1);
      expect(run.out[0]).toBe("Checking the data folder...");
      expect(run.err[0]).toBe(`The import failed (${code}, ${detail}).`);
      expect(run.err[1]).toBe("The original Python files are untouched.");
      const reportLine = run.err[2] ?? "";
      expect(reportLine).toMatch(
        /^Report for your assistant: ~\/data\/diagnostics\/startup-failure-/,
      );
      expectUntouched(f, before, injected.changed);
      // The words of a discarded identity are not left behind.
      expect(existsSync(words)).toBe(false);
      const files = diagnostics(f);
      expect(files).toHaveLength(3);
      const record = parseStartupFailureRecord(
        JSON.parse(readFileSync(join(f.dataDir, "diagnostics", "startup-failure.json"), "utf8")),
      );
      expect(record?.failure).toMatchObject({ code, detail, originalsUntouched: true });
      const json = files.find((file) => file.endsWith(".json") && file !== "startup-failure.json");
      const report = parseStartupFailureReport(
        JSON.parse(readFileSync(join(f.dataDir, "diagnostics", json ?? ""), "utf8")),
      );
      expect(report?.failure).toMatchObject({ code, detail });
      expect(report?.dataDir).toBe("~/data");
      const prompt = readFileSync(
        join(f.dataDir, "diagnostics", json?.replace(/\.json$/, ".txt") ?? ""),
        "utf8",
      );
      expect(prompt).toContain(`cashu migrate verify`);
    },
    SLOW,
  );

  it(
    "imports with the words in a new private file and says where the originals went",
    async () => {
      const f = fixture();
      const words = join(f.base, "words.txt");
      const run = await cli(f, ["--data-dir", f.dataDir, "--recovery-file", words], {});
      expect(run.code).toBe(0);
      expect(run.err).toEqual([]);
      expect(readFileSync(words, "utf8").trim().split(" ")).toHaveLength(24);
      expect(run.out).toContain(
        "The recovery words were saved to ~/words.txt. Keep them safe, and delete this file once backed up.",
      );
      expect(run.out.at(-2)).toMatch(
        new RegExp(
          `^Import finished: profiles 1, tables \\d+, rows \\d+, vaults 1\\. Original files: ~/data/${BACKUP}\\.$`,
        ),
      );
      expect(run.out.at(-1)).toBe("Check the import with: cashu migrate verify");
      // The words never reach the terminal.
      const phrase = readFileSync(words, "utf8").trim();
      expect([...run.out, ...run.err].some((line) => line.includes(phrase))).toBe(false);
      const again = await cli(f, [
        "--data-dir",
        f.dataDir,
        "--recovery-file",
        join(f.base, "w2.txt"),
      ]);
      expect(again.out.at(-2)).toBe(
        `This data folder was already imported (2027-01-01T00:00:00.000Z); nothing was changed. Original files: ~/data/${BACKUP}.`,
      );
      expect(existsSync(join(f.base, "w2.txt"))).toBe(false);
      // Without --recovery-file an already migrated folder is reported, not a usage error.
      const listing = readdirSync(f.dataDir).sort();
      const plain = await cli(f, ["--data-dir", f.dataDir]);
      expect(plain).toEqual({
        code: 0,
        out: [
          `This data folder was already imported (2027-01-01T00:00:00.000Z); nothing was changed. Original files: ~/data/${BACKUP}.`,
          "Check the import with: cashu migrate verify",
        ],
        err: [],
      });
      expect(readdirSync(f.dataDir).sort()).toEqual(listing);
    },
    SLOW,
  );
});

describe("cashu migrate usage", () => {
  it("refuses a malformed command line with exit 64 and touches nothing", async () => {
    const f = fixture();
    const d = f.dataDir;
    mkdirSync(join(f.base, "exists"), { mode: 0o700 });
    const cases: string[][] = [
      [],
      ["--data-dir", d],
      ["--data-dir", "relative/dir"],
      ["--data-dir", d, "--json", "--json"],
      ["--data-dir", d, "--json", "--recovery-file", join(f.base, "w.txt")],
      ["--data-dir", d, "--recovery-file", join(d, "w.txt")],
      ["--data-dir", d, "--recovery-file", join(f.base, "exists")],
      ["--data-dir", d, "--recovery-file", join(f.base, "missing", "w.txt")],
      ["--data-dir", d, "--recovery-file", "w.txt"],
      ["verify", "--data-dir", d, "--recovery-file", join(f.base, "w.txt")],
      ["verify", "--data-dir", d, "--bogus"],
      ["--data-dir", d, "--data-dir", d, "--json"],
      ["import", "--data-dir", d, "--json"],
    ];
    const listing = readdirSync(d).sort();
    for (const argv of cases) {
      const run = await cli(f, argv);
      expect([argv, run.code]).toEqual([argv, 64]);
      expect(run.out).toEqual([]);
      expect(run.err[0]).toMatch(/^usage: cashu migrate \[--recovery-file <path>\] \[--json\]\n/);
    }
    expect(readdirSync(d).sort()).toEqual(listing);
  });

  it("prints the usage in Polish under CASHU_LANG=pl", async () => {
    const err: string[] = [];
    const code = await migrateCommand([], {
      env: { CASHU_LANG: "pl" },
      stdout: () => {},
      stderr: (line) => err.push(line),
      readLine: async () => null,
      build: "test-build",
    });
    expect(code).toBe(64);
    expect(err[0]).toMatch(/^użycie: cashu migrate/);
  });
});

describe("cashu migrate after an interrupted cutover", () => {
  it(
    "finishes it in human mode without --recovery-file and asks for no words",
    async () => {
      const f = fixture();
      const crashed = await cli(f, ["--data-dir", f.dataDir, "--json"], {
        answer: "confirm",
        afterCutoverMove: (moves) => {
          if (moves === 3) throw new Error("synthetic crash");
        },
      });
      expect(crashed.code).not.toBe(0);
      expect(readdirSync(f.dataDir).some((name) => name.startsWith(".migration-"))).toBe(true);
      expect(existsSync(join(f.dataDir, "migration.json"))).toBe(false);
      const finished = await cli(f, ["--data-dir", f.dataDir]);
      expect(finished.code).toBe(0);
      expect(finished.out.join("\n")).not.toMatch(/recovery/i);
      expect(existsSync(join(f.dataDir, "migration.json"))).toBe(true);
      expect(readdirSync(f.dataDir).filter((name) => name.startsWith(".migration-"))).toEqual([]);
      const again = await cli(f, ["--data-dir", f.dataDir]);
      expect(again.code).toBe(0);
    },
    SLOW,
  );
});
