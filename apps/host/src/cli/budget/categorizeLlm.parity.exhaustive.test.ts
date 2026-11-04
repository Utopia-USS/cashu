// Actual Python dispatcher/local_llm/reclassify CLI versus injected native local transport.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type budget, D } from "@cashu/domain";
import { createTranslator } from "@cashu/i18n";
import { addLoan, importStatement, runCommand, setTransactionCategory } from "@cashu/store";
import { budgetBook } from "@cashu/store/budget/queries";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo } from "../tree.js";
import { categorizeCommands } from "./categorizeCommands.js";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const PYTHON = join(ROOT, ".venv/bin/python");
afterEach(cleanup);
it.skipIf(!existsSync(PYTHON))(
  "matches actual local model requests, CLI bytes and atomic state",
  async () => {
    const rows = [
      {
        date: "2026-09-01",
        amount: "-10",
        merchant: "UNKNOWN VENDOR",
        reference: "Purchase alpha",
        description: "Detail alpha",
      },
      {
        date: "2026-09-22",
        amount: "-20",
        merchant: "UNKNOWN OPERATOR",
        reference: "Purchase beta",
        description: "Detail beta",
      },
      {
        date: "2026-09-23",
        amount: "100",
        merchant: "OTHER INCOME",
        reference: "Grant",
        description: "Detail gamma",
      },
      {
        date: "2026-09-12",
        amount: "-30",
        merchant: "PATTERN VENDOR",
        reference: "OWNER PAYMENT MARKER",
        description: "Owner pattern",
      },
    ];
    const cases: {
      args: string[];
      env: Record<string, string>;
      mode?: string;
      unsupported?: boolean;
    }[] = [
      { args: ["reclassify"], env: {}, mode: "empty" },
      { args: ["reclassify"], env: {}, mode: "malformed" },
      { args: ["reclassify"], env: {}, mode: "http503" },
      { args: ["categorize", "--llm"], env: {}, mode: "empty" },
      { args: ["categorize", "--llm"], env: {}, mode: "malformed" },
      { args: ["categorize", "--llm"], env: {}, mode: "http503" },
      { args: ["categorize", "--llm"], env: {} },
      {
        args: ["reclassify", "--model", "synthetic-one", "--batch-size", "2"],
        env: { FORCE_COLOR: "1", COLUMNS: "100" },
      },
      { args: ["set-category", "unknown vendor", "groceries"], env: { FORCE_COLOR: "1" } },
      { args: ["set-category", "pattern vendor", "gifts"], env: { FORCE_COLOR: "1" } },
      {
        args: [
          "reclassify",
          "--recent-days",
          "15",
          "--batch-size=1",
          "--recent-model=synthetic-recent",
          "--old-model=synthetic-old",
        ],
        env: { FORCE_COLOR: "1", COLUMNS: "95" },
      },
      { args: ["reclassify", "--limit=0"], env: { CASHU_LANG: "pl" } },
      { args: ["reclassify"], env: {}, mode: "empty", unsupported: true },
    ];
    const safeEnv = {
      PATH: process.env.PATH ?? "",
      HOME: tempDir(),
      CASHU_TESTING: "1",
      CASHU_DATA_DIR: tempDir(),
      CASHU_LEGACY_DATA_DIR: tempDir(),
      CASHU_WORKSPACES_DIR: tempDir(),
      CASHU_LAUNCH_AGENTS_DIR: tempDir(),
      CASHU_APP_BUNDLE: "none",
      CASHU_AUTO_DAILY: "0",
      CASHU_LANG: "en",
      PYTHONPATH: join(ROOT, "src"),
      LANG: "en_US.UTF-8",
    };
    const oracle = spawnSync(
      PYTHON,
      [join(ROOT, "apps/host/test-fixtures/budget-classifier-oracle.py")],
      {
        cwd: ROOT,
        env: safeEnv,
        encoding: "utf8",
        input: JSON.stringify({ rows, cases }),
      },
    );
    expect(oracle.status, oracle.stderr).toBe(0);
    const expected = JSON.parse(oracle.stdout) as {
      code: number;
      stdout: string;
      stderr: string;
      state: (string | null)[][];
      requests: unknown[];
      endpoint: string;
    }[];
    let mode = "answers";
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as { messages: { content: string }[] };
      requests.push(body);
      const listing = body.messages[1]?.content ?? "";
      const ids = [...listing.matchAll(/^(m\d+):|^\[(t\d+)\]/gm)].map(
        (match) => match[1] || match[2],
      );
      const results =
        mode === "empty" ? [] : ids.map((id) => ({ id, category: "shopping", confidence: 0.8 }));
      res.setHeader("content-type", "application/json");
      if (mode === "http503") res.statusCode = 503;
      res.end(
        JSON.stringify({
          message: { content: mode === "malformed" ? "{" : JSON.stringify({ results }) },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing synthetic listener");
    const url = `http://127.0.0.1:${address.port}`;
    const host = await startLocalHost({
      ...testHostOptions(tempDir()),
      launcher: false,
    });
    try {
      const vault = [...host.stores.vaults.values()][0];
      if (!vault) throw new Error("missing synthetic vault");
      const seed: budget.RawTransaction[] = rows.map((r, i) => ({
        bookingDate: r.date,
        valueDate: null,
        amount: D(r.amount),
        currency: "PLN",
        counterpartyName: r.merchant,
        counterpartyIban: null,
        description: r.description,
        reference: r.reference,
        bankTransactionId: String(i),
        source: "csv",
        raw: {},
      }));
      const inserted = runCommand(
        vault.store,
        vault.writer,
        importStatement,
        {
          statement: {
            bank: "mbank",
            accountNumber: null,
            accountName: "Synthetic",
            currency: "PLN",
            transactions: seed,
            balances: [],
            closingBalances: [],
          },
        },
        vault.env,
      );
      expect(inserted.ok).toBe(true);
      expect(
        runCommand(
          vault.store,
          vault.writer,
          addLoan,
          {
            name: "Synthetic loan",
            principal: "100",
            annualRate: "0",
            termMonths: 12,
            startDate: "2026-09-01",
            paymentText: "OWNER PAYMENT MARKER",
          },
          vault.env,
        ).ok,
      ).toBe(true);
      const commands = categorizeCommands({
        stores: host.stores,
        now: () => new Date(2026, 9, 1, 12).getTime(),
        classifier: { isHolder: () => true, fetch },
      });
      let lastIo: CommandIo | undefined;
      for (const [index, c] of cases.entries()) {
        const expectedCase = expected[index];
        if (!expectedCase) throw new Error("missing synthetic oracle case");
        requests.length = 0;
        mode = c.mode ?? "answers";
        let stdout = "",
          stderr = "";
        const io: CommandIo = {
          cwd: tempDir(),
          env: {
            ...safeEnv,
            ...c.env,
            CASHU_CATEGORIZE_OLLAMA_URL: url,
            CASHU_CATEGORIZE_OLLAMA_MODEL: "synthetic-default",
          },
          tty: { stdin: false, stdout: false, stderr: false },
          signal: new AbortController().signal,
          t: createTranslator(c.env.CASHU_LANG === "pl" ? "pl" : "en"),
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
        lastIo = io;
        const command = commands.find((x) => x.name === c.args[0]);
        if (!command) throw new Error("missing native classifier command");
        const before = [...vault.store.cursors()];
        const code = await command.run(c.args.slice(1), io, { profile: "demo" });
        expect(requests, `local request bodies ${index}`).toEqual(expected[index]?.requests);
        const state = budgetBook(vault.store.read.bind(vault.store)).transactions.map((t) => [
          t.bankTransactionId,
          t.category,
          t.categorySource,
        ]);
        if (c.unsupported) {
          expect(code).toBe(1);
          expect(stderr).toContain("fallback is not supported");
          expect([...vault.store.cursors()]).toEqual(before);
          expect(state.every((r) => ["llm_full", "manual"].includes(r[2] ?? ""))).toBe(true);
          expect(expected[index]?.state.some((r) => r[2] !== "llm_full")).toBe(true);
        } else {
          expect({ code, stdout, stderr }, `source bytes ${index}`).toEqual({
            code: expected[index]?.code,
            stdout: expected[index]?.stdout,
            // Only the public synthetic mock's independently allocated port differs by runtime.
            stderr: expectedCase.stderr.replaceAll(expectedCase.endpoint, url),
          });
          expect(state, `native state ${index}`).toEqual(expected[index]?.state);
        }
      }
      if (!lastIo) throw new Error("missing synthetic command IO");
      mode = "answers";
      const beforeLostAuthority = [...vault.store.cursors()];
      let holder = true;
      const authorityCommands = categorizeCommands({
        stores: host.stores,
        now: Date.now,
        classifier: {
          isHolder: () => holder,
          fetch: async (...args) => {
            const response = await fetch(...args);
            holder = false;
            return response;
          },
        },
      });
      let error = "";
      const io = {
        ...lastIo,
        stdout() {},
        stderr: (text: string) => {
          error += text;
        },
      };
      expect(
        await authorityCommands
          .find((c) => c.name === "reclassify")
          ?.run([], io, { profile: "demo" }),
      ).toBe(1);
      expect(error).toContain("authority changed");
      expect([...vault.store.cursors()]).toEqual(beforeLostAuthority);
      const ownerRow = budgetBook(vault.store.read.bind(vault.store)).transactions[0]?.key;
      let ownerWritten = false,
        ownerCursor = [...vault.store.cursors()];
      const ownerCommands = categorizeCommands({
        stores: host.stores,
        now: Date.now,
        classifier: {
          isHolder: () => true,
          fetch: async (...args) => {
            const response = await fetch(...args);
            if (!ownerWritten) {
              await vault.queue.run(() => {
                const result = runCommand(
                  vault.store,
                  vault.writer,
                  setTransactionCategory,
                  { txn: ownerRow, category: "gifts" },
                  vault.env,
                );
                expect(result.ok).toBe(true);
                ownerWritten = true;
                ownerCursor = [...vault.store.cursors()];
              });
            }
            return response;
          },
        },
      });
      error = "";
      expect(
        await ownerCommands.find((c) => c.name === "reclassify")?.run([], io, { profile: "demo" }),
      ).toBe(1);
      expect(error).toContain("context changed");
      expect([...vault.store.cursors()]).toEqual(ownerCursor);
      expect(budgetBook(vault.store.read.bind(vault.store)).transactions[0]).toMatchObject({
        category: "gifts",
        categorySource: "manual_txn",
      });
    } finally {
      await host.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
