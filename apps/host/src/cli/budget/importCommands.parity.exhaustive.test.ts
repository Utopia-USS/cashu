// Real Python CLI/service/Rich bytes versus independent native commands, over invented bank files.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "@cashu/i18n";
import { budgetBook } from "@cashu/store/budget/queries";
import { accountByGid } from "@cashu/store/core";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { categorizeCommands } from "./categorizeCommands.js";
import { importCommands } from "./importCommands.js";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const PYTHON = join(REPO, ".venv/bin/python");
afterEach(cleanup);
it.skipIf(!existsSync(PYTHON))(
  "matches actual Python import/category bytes and stored facts",
  async () => {
    const cwd = tempDir();
    for (const dir of ["incoming/a", "incoming/mbank", "incoming/erste", "incoming/pekao", "empty"])
      mkdirSync(join(cwd, dir), { recursive: true });
    const fixtures = [
      ["mbank-csv", "mbank-zestawienie.csv", "mbank.csv"],
      ["mbank-csv", "mbank-ekonto-walutowe-eur.csv", "euro.csv"],
      ["erste-csv", "erste-historia.csv", "erste.csv"],
      ["pekao-csv", "pekao-historia.csv", "incoming/pekao/ok.csv"],
    ];
    for (const [connector, file, target] of fixtures)
      copyFileSync(
        join(REPO, "connectors", connector as string, "fixtures", file as string),
        join(cwd, target as string),
      );
    writeFileSync(join(cwd, "incoming/mbank/invalid.csv"), "no header\n");
    writeFileSync(join(cwd, "incoming/not-bank.csv"), "unknown data\n");
    writeFileSync(join(cwd, "incoming/a.csv"), "unknown data\n");
    writeFileSync(join(cwd, "incoming/a/x.csv"), "unknown data\n");
    const mbank = readFileSync(join(cwd, "mbank.csv")).toString("latin1");
    writeFileSync(join(cwd, "older.csv"), mbank.replaceAll("2026-09", "2026-08"), "latin1");
    writeFileSync(
      join(cwd, "incoming/mbank/bad-amount.csv"),
      mbank.replace(/-[0-9]+,[0-9]{2}/, "BAD_AMOUNT"),
      "latin1",
    );
    const safeEnv = {
      PATH: process.env.PATH ?? "",
      HOME: tempDir(),
      CASHU_TESTING: "1",
      CASHU_DATA_DIR: tempDir(),
      CASHU_WORKSPACES_DIR: tempDir(),
      CASHU_LEGACY_DATA_DIR: tempDir(),
      CASHU_LAUNCH_AGENTS_DIR: tempDir(),
      CASHU_APP_BUNDLE: "none",
      CASHU_AUTO_DAILY: "0",
      PYTHONPATH: join(REPO, "src"),
      CASHU_LANG: "en",
      LANG: "en_US.UTF-8",
    };
    const cases: {
      name: string;
      args: string[];
      env: Record<string, string>;
      alias?: boolean;
      categories?: boolean;
    }[] = [
      { name: "categorize", args: ["--llm"], env: {} },
      { name: "reclassify", args: [], env: {} },
      { name: "match-transfers", args: [], env: {} },
      {
        name: "match-transfers",
        args: ["--reset", "--max-days=7"],
        env: { FORCE_COLOR: "1" },
        alias: true,
      },
      {
        name: "import-csv",
        args: [
          "mbank.csv",
          "--bank",
          "mbank",
          "--name",
          "Konto testowe",
          "--account-type",
          "savings",
        ],
        env: {},
      },
      {
        name: "import-csv",
        args: ["mbank.csv", "--name=Ignored", "--account-type=checking"],
        env: { FORCE_COLOR: "1", COLUMNS: "67" },
        alias: true,
      },
      {
        name: "import-csv",
        args: ["euro.csv", "--bank=mbank", "--name", "Rachunek EUR"],
        env: { CASHU_LANG: "pl", FORCE_COLOR: "1", COLUMNS: "41" },
      },
      {
        name: "categorize",
        args: [],
        env: { FORCE_COLOR: "1", NO_COLOR: "1" },
        categories: true,
        alias: true,
      },
      { name: "import-csv", args: ["older.csv", "--bank=mbank"], env: {} },
      { name: "import-csv", args: ["erste.csv", "--bank=erste"], env: {} },
      { name: "categorize", args: [], env: {}, categories: true },
      {
        name: "set-category",
        args: ["sklep test", "groceries"],
        env: { FORCE_COLOR: "1", COLUMNS: "43" },
        categories: true,
      },
      {
        name: "import-dir",
        args: ["incoming"],
        env: { FORCE_COLOR: "1", COLUMNS: "120" },
        alias: true,
      },
      { name: "import-dir", args: ["incoming", "--no-recursive"], env: {} },
      {
        name: "import-dir",
        args: ["empty", "--no-recursive"],
        env: { CASHU_LANG: "pl", FORCE_COLOR: "1", COLUMNS: "32" },
      },
      { name: "categorize", args: [], env: {}, categories: true },
    ];
    const oracle = spawnSync(
      PYTHON,
      [join(REPO, "apps/host/test-fixtures/budget-import-oracle.py")],
      {
        cwd: REPO,
        env: safeEnv,
        encoding: "utf8",
        input: JSON.stringify(
          cases.map((c) => ({
            args: ["--profile", "demo", ...(c.alias ? ["budget"] : []), c.name, ...c.args],
            env: { ...safeEnv, ...c.env },
            cwd,
            categories: c.categories ?? false,
          })),
        ),
      },
    );
    expect(oracle.status, oracle.stderr).toBe(0);
    const expected = JSON.parse(oracle.stdout) as {
      code: number;
      stdout: string;
      stderr: string;
      rows: object[];
      batches: number[][];
    }[];
    const host = await startLocalHost({
      ...testHostOptions(tempDir()),
      launcher: false,
      python: null,
    });
    try {
      const deps = { stores: host.stores, now: Date.now };
      const commands: PortedCommand[] = [...importCommands(deps), ...categorizeCommands(deps)];
      for (const [i, c] of cases.entries()) {
        let stdout = "",
          stderr = "";
        const io: CommandIo = {
          cwd,
          env: { ...safeEnv, ...c.env },
          t: createTranslator(c.env.CASHU_LANG === "pl" ? "pl" : "en"),
          tty: { stdin: false, stdout: false, stderr: false },
          signal: new AbortController().signal,
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
          prompt: async () => {
            throw new Error("unexpected prompt");
          },
          stdin: () => {
            throw new Error("unexpected stdin");
          },
        };
        const command = commands.find((x) => x.name === c.name);
        if (!command) throw new Error("missing native command");
        const code = await command.run(c.args, io, { profile: "demo" });
        expect({ code, stdout, stderr }, `case ${i}`).toEqual({
          code: expected[i]?.code,
          stdout: expected[i]?.stdout,
          stderr: expected[i]?.stderr,
        });
        const vault = [...host.stores.vaults.values()][0];
        if (!vault) throw new Error("missing synthetic vault");
        const read = vault.store.read.bind(vault.store);
        const rows = budgetBook(read).transactions.map((txn) => {
          const account = accountByGid(read, txn.account);
          const row = {
            bank: account?.bank,
            account: account?.name,
            type: account?.type,
            date: txn.bookingDate,
            amount: txn.amount.format(".2f"),
            currency: txn.currency,
            counterparty: txn.counterpartyName,
            description: txn.description,
            reference: txn.reference,
            ...(c.categories ? { category: txn.category, source: txn.categorySource } : {}),
          };
          return row;
        });
        const stable = (values: readonly object[]) =>
          values.map((x) => JSON.stringify(Object.fromEntries(Object.entries(x).sort()))).sort();
        expect(stable(rows), `stored facts ${i}`).toEqual(stable(expected[i]?.rows ?? []));
        expect(
          vault.store
            .read<{ num_seen: number; num_inserted: number; num_duplicates: number }>(
              "SELECT num_seen, num_inserted, num_duplicates FROM import_batches ORDER BY id",
            )
            .map((b) => [b.num_seen, b.num_inserted, b.num_duplicates]),
          `batch counts ${i}`,
        ).toEqual(expected[i]?.batches);
      }
    } finally {
      await host.stop();
    }
  },
);
