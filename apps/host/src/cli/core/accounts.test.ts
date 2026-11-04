import { D, parseDateTime } from "@cashu/domain";
import { asInstrumentId, priceBar } from "@cashu/domain/investments";
import { createTranslator } from "@cashu/i18n";
import { connectHost } from "@cashu/node-host";
import { investmentsCommands, openAccount, setModules } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { cliCommandKey, runCliVaultCommand } from "../commandOutcome.js";
import type { CommandIo } from "../tree.js";
import { accountCommands } from "./accounts.js";
import { profileCommands } from "./profiles.js";
import { statsCommand } from "./stats.js";

afterEach(cleanup);

function output(env: Record<string, string> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CommandIo = {
    cwd: tempDir(),
    env,
    tty: { stdin: false, stdout: false, stderr: false, columns: 120 },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    prompt: async () => null,
    stdin: async function* () {},
  };
  return { io, stdout, stderr };
}

it("scopes account reads and durable writes to the explicitly selected vault", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    const created = await runCliVaultCommand(
      vault,
      openAccount,
      { bank: "synthetic", name: "Example", type: "checking", currency: "PLN" },
      cliCommandKey(),
    );
    expect(created.kind).toBe("completed");
    const gid = vault.store.read<{ gid: string }>("SELECT gid FROM accounts")[0]?.gid;
    if (!gid) throw new Error("account gid missing");
    const deps = { stores: host.stores, now: () => new Date(2026, 9, 31).getTime() };
    const commands = new Map(accountCommands(deps).map((command) => [command.name, command]));
    const selected = output({ CASHU_PROFILE: "demo" });
    expect(await commands.get("accounts")?.run([], selected.io, {})).toBe(0);
    expect(selected.stdout.join("")).toContain("Example");
    const narrow = output({ CASHU_PROFILE: "demo" });
    expect(
      await commands
        .get("accounts")
        ?.run([], { ...narrow.io, tty: { ...narrow.io.tty, columns: 80 } }, {}),
    ).toBe(0);
    expect(narrow.stdout.join("")).toContain(`GID ${gid}`);
    expect(await commands.get("set-account-name")?.run([gid, "Renamed"], selected.io, {})).toBe(0);
    expect(await commands.get("set-account-type")?.run([gid, "savings"], selected.io, {})).toBe(0);
    expect(
      await commands
        .get("set-balance")
        ?.run([gid, "125.5", "--date", "2026-10-30"], selected.io, {}),
    ).toBe(0);
    expect(vault.store.read("SELECT name, type FROM accounts")).toEqual([
      { name: "Renamed", type: "savings" },
    ]);
    expect(vault.store.read("SELECT date, amount FROM balances")).toEqual([
      { date: "2026-10-30", amount: "125.5" },
    ]);
    const wrong = output({ CASHU_PROFILE: "absent" });
    expect(await commands.get("set-balance")?.run([gid, "1"], wrong.io, {})).toBe(2);
    expect(vault.store.read("SELECT COUNT(*) AS n FROM balances")).toEqual([{ n: 1 }]);
    expect(await profileCommands({ stores: host.stores })[0]?.run(["list"], selected.io, {})).toBe(
      0,
    );
    expect(selected.stdout.join("")).toContain("demo");
    expect(await statsCommand({ ...deps, prices: null }).run([], selected.io, {})).toBe(0);
    expect(selected.stdout.join("")).toContain("Net worth");
    const ambiguous = output({ CASHU_PROFILE: "demo" });
    expect(
      await statsCommand({
        ...deps,
        prices: null,
        stores: {
          vaults: new Map([
            ["first", vault],
            ["duplicate", vault],
          ]),
        },
      }).run([], ambiguous.io, {}),
    ).toBe(2);
    expect(ambiguous.stdout).toEqual([]);
    const polish = output({ CASHU_PROFILE: "demo" });
    expect(
      await statsCommand({ ...deps, prices: null }).run(
        [],
        { ...polish.io, t: createTranslator("pl") },
        {},
      ),
    ).toBe(0);
    expect(polish.stdout.join("")).toContain("Wartość netto");
  } finally {
    await host.stop();
  }
});

it("rejects malformed account arguments before any mutation", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const deps = { stores: host.stores, now: () => 0 };
    const commands = new Map(accountCommands(deps).map((command) => [command.name, command]));
    const { io } = output({ CASHU_PROFILE: "demo" });
    for (const args of [["x", "1"], ["1", "nan"], ["1", "1", "--date", "bad"], ["--help"]])
      expect(await commands.get("set-balance")?.run(args, io, {})).toBe(2);
    expect(
      [...host.stores.vaults.values()][0]?.store.read("SELECT COUNT(*) AS n FROM balances"),
    ).toEqual([{ n: 0 }]);
  } finally {
    await host.stop();
  }
});

it("values an alias-less investment from the selected vault's imported market image", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    expect(
      (await runCliVaultCommand(vault, setModules, { moduleIds: ["investments"] }, cliCommandKey()))
        .kind,
    ).toBe("completed");
    const broker = await runCliVaultCommand(
      vault,
      investmentsCommands.addBrokerageAccount,
      {
        name: "Synthetic broker",
        broker: "xtb",
        currency: "PLN",
      },
      cliCommandKey(),
    );
    expect(broker.kind).toBe("completed");
    if (broker.kind !== "completed") throw new Error("brokerage account missing");
    const transaction = await runCliVaultCommand(
      vault,
      investmentsCommands.addManualTransaction,
      {
        account: broker.value.account,
        type: "buy",
        tradeDate: "2026-10-01",
        described: { name: "Synthetic unaliased equity", assetClass: "equity", currency: "PLN" },
        quantity: "2",
        price: "10",
        grossAmount: "20",
        cashAmount: "-20",
      },
      cliCommandKey(),
    );
    if (transaction.kind !== "completed")
      throw new Error(
        `manual transaction: ${transaction.kind} ${"reason" in transaction ? transaction.reason : ""}`,
      );
    const instrument = transaction.value.instrument;
    if (!instrument) throw new Error("instrument missing");
    const bar = priceBar({
      instrumentId: asInstrumentId(instrument),
      date: "2026-10-31",
      close: D("17"),
      source: "synthetic-import",
      fetchedAt: parseDateTime("2026-10-31T12:00:00Z"),
    });
    let boundVault = "";
    const report = output({ CASHU_PROFILE: "demo" });
    expect(
      await statsCommand({
        stores: host.stores,
        now: () => new Date(2026, 9, 31).getTime(),
        prices: null,
        marketData: (_read, id) => {
          boundVault = id;
          return {
            series: (asked) => (asked === asInstrumentId(instrument) ? [bar] : []),
            fxRates: () => [],
            firstBarDate: () => "2026-10-31",
            lastBarDate: () => "2026-10-31",
            hasBarsFetchedBefore: () => false,
            firstRateDate: () => null,
            lastRateDate: () => null,
            hasRateOnOrBefore: () => false,
          };
        },
      }).run([], report.io, {}),
    ).toBe(0);
    expect(boundVault).toBe(vault.id);
    expect(report.stdout.join("")).toContain("34,00 PLN");
  } finally {
    await host.stop();
  }
});

it("requires a terminal and exact recovery phrase before native Create commit, then supports inspect", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const words = Array.from({ length: 24 }, () => "alpha").join(" ");
  const operationId = "a".repeat(32);
  let commits = 0;
  let handovers = 0;
  const creation = {
    prepare: async () => ({
      kind: "prepared" as const,
      operationId,
      phraseSession: "b".repeat(32),
      words,
      expiresAt: "2026-10-31T12:10:00Z",
    }),
    commit: async () => {
      commits++;
      return {
        kind: "ready" as const,
        operationId,
        vaultId: "c".repeat(32),
        profileSlug: "new",
        reconnectRequired: true as const,
      };
    },
    inspect: async () => ({
      kind: "outcome_unknown" as const,
      operationId,
      stage: "publishing" as const,
    }),
  };
  const commands = profileCommands({
    stores: host.stores,
    creation,
    onCreationReady: () => handovers++,
  });
  const command = commands[0];
  if (!command) throw new Error("profile command missing");
  try {
    const noTty = output();
    expect(await command.run(["add", "New"], noTty.io, {})).toBe(2);
    expect(commits).toBe(0);
    const wrong = output();
    expect(
      await command.run(
        ["add", "New"],
        {
          ...wrong.io,
          tty: { stdin: true, stdout: true, stderr: true },
          prompt: async () => "wrong",
        },
        {},
      ),
    ).toBe(1);
    expect(commits).toBe(0);
    const good = output();
    expect(
      await command.run(
        ["add", "New"],
        {
          ...good.io,
          tty: { stdin: true, stdout: true, stderr: true },
          prompt: async (_text, options) => {
            expect(options?.hidden).toBe(true);
            return words;
          },
        },
        {},
      ),
    ).toBe(0);
    expect(commits).toBe(1);
    expect(handovers).toBe(1);
    expect(good.stdout.join("")).toContain(words);
    const status = output();
    expect(await command.run(["inspect", operationId], status.io, {})).toBe(1);
    expect(status.stdout.join("")).toContain("unknown outcome");
    expect(commits).toBe(1);
  } finally {
    await host.stop();
  }
});

it("reports an uncertain Create result by its original operation ID without retrying", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const words = Array.from({ length: 24 }, () => "alpha").join(" ");
  const operationId = "d".repeat(32);
  let prepares = 0;
  let commits = 0;
  const command = profileCommands({
    stores: host.stores,
    creation: {
      prepare: async () => {
        prepares++;
        return {
          kind: "prepared",
          operationId,
          phraseSession: "e".repeat(32),
          words,
          expiresAt: "2026-10-31T12:10:00Z",
        };
      },
      commit: async () => {
        commits++;
        return { kind: "outcome_unknown", operationId, stage: "publishing" };
      },
      inspect: async () => ({ kind: "outcome_unknown", operationId, stage: "publishing" }),
    },
  })[0];
  if (!command) throw new Error("profile command missing");
  try {
    const out = output();
    expect(
      await command.run(
        ["add", "New"],
        { ...out.io, tty: { stdin: true, stdout: true, stderr: true }, prompt: async () => words },
        {},
      ),
    ).toBe(1);
    expect(out.stderr.join("")).toContain(`profiles inspect ${operationId}`);
    expect(await command.run(["inspect", operationId], out.io, {})).toBe(1);
    expect(prepares).toBe(1);
    expect(commits).toBe(1);
  } finally {
    await host.stop();
  }
});

it("keeps the Create operation ID visible when the commit reply throws", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const words = Array.from({ length: 24 }, () => "alpha").join(" ");
  const operationId = "f".repeat(32);
  let prepares = 0;
  let commits = 0;
  const command = profileCommands({
    stores: host.stores,
    creation: {
      prepare: async () => {
        prepares++;
        return {
          kind: "prepared",
          operationId,
          phraseSession: "e".repeat(32),
          words,
          expiresAt: "2026-10-31T12:10:00Z",
        };
      },
      commit: async () => {
        commits++;
        throw new Error("reply lost");
      },
      inspect: async () => ({ kind: "outcome_unknown", operationId, stage: "publishing" }),
    },
  })[0];
  if (!command) throw new Error("profile command missing");
  try {
    const out = output();
    expect(
      await command.run(
        ["add", "New"],
        { ...out.io, tty: { stdin: true, stdout: true, stderr: true }, prompt: async () => words },
        {},
      ),
    ).toBe(1);
    expect(out.stdout.join("")).toContain(`Creation operation: ${operationId}`);
    expect(out.stderr.join("")).toContain(`profiles inspect ${operationId}`);
    expect(prepares).toBe(1);
    expect(commits).toBe(1);
  } finally {
    await host.stop();
  }
});

it("routes core commands through the native CLI socket and refuses unsupported arguments", async () => {
  const dir = tempDir();
  const host = await startLocalHost({ ...testHostOptions(dir), launcher: false, python: null });
  const conn = await connectHost({ dataDir: dir, role: "cli", build: "test" });
  try {
    const params = (argv: string[]) => ({
      argv,
      cwd: dir,
      env: { CASHU_LANG: "en" },
      tty: { stdin: false, stdout: false, stderr: false },
    });
    expect(await conn.call("cli.exec", params(["profiles", "list"]))).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(await conn.call("cli.exec", params(["--profile", "demo", "accounts"]))).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(
      await conn.call("cli.exec", params(["--profile", "demo", "set-balance", "bad", "1"])),
    ).toEqual({ kind: "exit", code: 2 });
    expect(await conn.call("cli.exec", params(["unknown"]))).toEqual({ kind: "exit", code: 2 });
  } finally {
    conn.close();
    await host.stop();
  }
});
