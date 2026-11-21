// Internal-transfer matching (counterparty IBAN only, day window, reset) through the native host's
// genuine encrypted vault and CLI socket, with a keyed retry answered from the original receipt.
import { D } from "@cashu/domain";
import type { CliExecParams, HostFrame } from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { importStatement } from "@cashu/store";
import { matchTransfersCommand } from "@cashu/store/budget/commands";
import { afterEach, expect, it } from "vitest";
import { runHostVaultCommand } from "./commands.js";
import { startLocalHost } from "./host.js";
import { cleanup } from "./testing/harness.js";
import { nativeVaultFixture } from "./testing/nativeVaultFixture.js";

afterEach(cleanup);

function nrb(bban: string): string {
  const check = 98n - (BigInt(`${bban}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban}`;
}
const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");
const cases = [
  { reset: false, maxDays: -1 },
  { reset: true, maxDays: 0 },
  { reset: false, maxDays: 3 },
  { reset: true, maxDays: -1 },
] as const;

// Expected pairs per case: only rows whose counterparty IBAN is the other own account pair up.
const expected = [
  {
    cleared: 0,
    matched: 0,
    pairs: [
      ["same-in", "same-out"],
      ["two-in", "two-out"],
    ],
    ungrouped: [],
  },
  { cleared: 4, matched: 1, pairs: [["same-in", "same-out"]], ungrouped: ["two-in", "two-out"] },
  {
    cleared: 0,
    matched: 1,
    pairs: [
      ["same-in", "same-out"],
      ["two-in", "two-out"],
    ],
    ungrouped: [],
  },
  { cleared: 4, matched: 0, pairs: [], ungrouped: ["same-in", "same-out", "two-in", "two-out"] },
] as const;

function snapshot(read: <T>(sql: string) => T[]) {
  const rows = read<{
    reference: string;
    is_internal_transfer: number;
    transfer_group_id: string | null;
  }>("SELECT reference, is_internal_transfer, transfer_group_id FROM transactions");
  const groups = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const row of rows) {
    if (!row.reference) throw new Error("synthetic row missing reference");
    if (row.transfer_group_id === null) {
      expect(row.is_internal_transfer).toBe(0);
      ungrouped.push(row.reference);
    } else {
      expect(row.is_internal_transfer).toBe(1);
      groups.set(row.transfer_group_id, [
        ...(groups.get(row.transfer_group_id) ?? []),
        row.reference,
      ]);
    }
  }
  return {
    pairs: [...groups.values()]
      .map((group) => group.sort())
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ungrouped: ungrouped.sort(),
  };
}

async function cliMatch(dataDir: string, profile: string, maxDays: number) {
  const connection = await connectHost({ dataDir, role: "cli", build: "test" });
  try {
    const output: string[] = [];
    const reply = new Promise<unknown>((resolve, reject) => {
      connection.onFrame((frame: HostFrame) => {
        if (frame.t === "note" && frame.id === 1 && frame.method === "cli.out")
          output.push(JSON.stringify(frame.params));
        if (frame.t === "res" && frame.id === 1) {
          if (frame.outcome.ok) resolve(frame.outcome.result);
          else reject(new Error(frame.outcome.error.code));
        }
      });
    });
    connection.send({
      t: "req",
      id: 1,
      method: "cli.exec",
      params: {
        argv: ["-p", profile, "match-transfers", `--max-days=${maxDays}`],
        cwd: dataDir,
        paths: { home: dataDir },
        env: { CASHU_LANG: "en" },
        tty: { stdin: false, stdout: false, stderr: false },
      } satisfies CliExecParams,
    });
    return { result: await reply, output: output.join(" ") };
  } finally {
    connection.close();
  }
}

it("pairs transfers by counterparty IBAN within the day window; retries keep the original native receipt", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    const options = {
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    } as const;
    host = await startLocalHost(options);
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault?.native) throw new Error("native vault missing");
    const importRows = async (
      bank: string,
      accountNumber: string,
      rows: readonly [string, string, string, string | null][],
    ) => {
      const result = await runHostVaultCommand(
        vault,
        importStatement,
        {
          statement: {
            bank,
            accountNumber,
            accountName: `Synthetic ${bank}`,
            currency: "PLN",
            balances: [],
            closingBalances: [],
            transactions: rows.map(([reference, bookingDate, amount, counterpartyIban]) => ({
              bookingDate,
              valueDate: null,
              amount: D(amount),
              currency: "PLN",
              counterpartyName: "Synthetic transfer",
              counterpartyIban,
              description: "Synthetic transfer",
              reference,
              bankTransactionId: reference,
              source: "csv",
              raw: {},
            })),
          },
          newestDayRule: false,
        },
        `seed-${bank}`,
      );
      expect(result.kind).toBe("completed");
    };
    await importRows("mbank", N1, [
      ["two-out", "2026-10-01", "-10.00", N2],
      ["same-out", "2026-10-04", "-20.00", N2],
    ]);
    await importRows("erste", N2, [
      ["two-in", "2026-10-03", "10.00", null],
      ["same-in", "2026-10-04", "20.00", null],
    ]);
    expect(snapshot(vault.store.read.bind(vault.store)).pairs).toHaveLength(2);
    const cli = await cliMatch(fixture.dataDir, fixture.profileSlug, -1);
    expect(cli.result).toEqual({ kind: "exit", code: 0 });
    expect(cli.output).toContain(`Matched ${expected[0]?.matched} internal-transfer pair(s).`);
    expect(snapshot(vault.store.read.bind(vault.store))).toEqual({
      pairs: expected[0]?.pairs,
      ungrouped: expected[0]?.ungrouped,
    });
    let lastResult: Awaited<ReturnType<typeof runHostVaultCommand>> | undefined;
    for (const [i, input] of cases.entries()) {
      if (i === 0) continue;
      const result = await runHostVaultCommand(
        vault,
        matchTransfersCommand,
        input,
        `transfer-case-${i}`,
      );
      expect(result).toEqual({
        kind: "completed",
        value: { cleared: expected[i]?.cleared, matched: expected[i]?.matched },
        eids: expect.any(Array),
      });
      expect(snapshot(vault.store.read.bind(vault.store))).toEqual({
        pairs: expected[i]?.pairs,
        ungrouped: expected[i]?.ungrouped,
      });
      if (i === cases.length - 1) lastResult = result;
    }
    expect(lastResult?.kind).toBe("completed");
    const before = vault.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n;
    const wrongProfile = await cliMatch(fixture.dataDir, "other", 3);
    expect(wrongProfile.result).toEqual({ kind: "exit", code: 2 });
    expect(vault.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n).toBe(
      before,
    );
    await host.stop();
    host = await startLocalHost(options);
    const reopened = host.stores.vaults.get(fixture.vaultId);
    if (!reopened?.native) throw new Error("reopened native vault missing");
    const retry = await runHostVaultCommand(
      reopened,
      matchTransfersCommand,
      cases[3],
      "transfer-case-3",
    );
    expect(retry).toEqual(lastResult);
    expect(reopened.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n).toBe(
      before,
    );
    expect(snapshot(reopened.store.read.bind(reopened.store))).toEqual({
      pairs: expected[3]?.pairs,
      ungrouped: expected[3]?.ungrouped,
    });
    expect(
      await runHostVaultCommand(
        reopened,
        matchTransfersCommand,
        { reset: true, maxDays: 3 },
        "wrong-vault-context",
        () => reopened.id === "0".repeat(32),
      ),
    ).toEqual({ kind: "not_started", reason: "session_unavailable" });
    expect(reopened.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n).toBe(
      before,
    );
  } finally {
    await host?.stop();
    fixture.cleanup();
  }
});
