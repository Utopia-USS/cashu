// The vehicle command: native state, currency and valuation refusals, aliases.
import { createTranslator } from "@cashu/i18n";
import { connectHost } from "@cashu/node-host";
import { vehicleAccount } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo } from "../tree.js";
import { runVehicleCommand, vehicleCommands } from "./vehicle.js";
import { vehicleInput } from "./vehicleInput.js";

afterEach(cleanup);
function output(env: Record<string, string> = {}) {
  const lines: string[] = [];
  const io: CommandIo = {
    cwd: tempDir(),
    env,
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: (text) => lines.push(text),
    stderr: (text) => lines.push(text),
    prompt: async () => {
      throw new Error("unexpected prompt");
    },
    stdin: () => {
      throw new Error("unexpected stdin");
    },
  };
  return { io, lines };
}
const args = ["Synthetic car", "80000", "2026-10-31"];
const at = () => new Date(2026, 9, 31, 12).getTime();

it("writes the explicitly selected native vault and preserves float and currency semantics", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const { io, lines } = output({ CASHU_PROFILE: "missing" });
  const deps = {
    stores: host.stores,
    now: at,
    render: (text: string, target: CommandIo) => target.stdout(`${text}\n`),
  };
  try {
    expect(
      await runVehicleCommand([...args, "--currency", "USD"], io, { profile: "demo" }, deps),
    ).toBe(0);
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    expect(vehicleAccount(vault.store.read.bind(vault.store), args[0] as string)?.currency).toBe(
      "USD",
    );
    expect(vault.store.read("SELECT purchase_price, annual_rate FROM depreciations")).toEqual([
      { purchase_price: "80000.0", annual_rate: "15.0" },
    ]);
    expect(lines).toEqual([
      "Vehicle 'Synthetic car': bought 2026-10-31 for 80 000,00 USD, depreciation 15.0%/yr → value today ≈ 80 000,00 USD\n",
    ]);
    // An existing account ignores even a noncanonical requested currency, as Python does.
    expect(
      await runVehicleCommand(
        [...args, "--currency=pln", "--floor=0"],
        io,
        { profile: "demo" },
        deps,
      ),
    ).toBe(0);
    expect(lines[1]).not.toContain("floor");
    expect(lines[1]).toContain("USD");
    expect(vault.store.read("SELECT floor FROM depreciations")).toEqual([{ floor: "0.0" }]);
  } finally {
    await host.stop();
  }
});

it("rejects invalid valuations and accepts Unicode text on older terminals", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const { io, lines } = output();
  const deps = {
    stores: host.stores,
    now: at,
    render: (text: string, target: CommandIo) => target.stdout(text),
  };
  try {
    expect(await runVehicleCommand(args, io, {}, deps)).toBe(2);
    expect(await runVehicleCommand(args, io, { profile: "missing" }, deps)).toBe(2);
    for (const input of [
      [...args, "--currency", "pln"],
      ["Synthetic", "nan", "2026-10-31"],
      ["Synthetic", "10", "0001-01-01"],
      ["Synthetic\tcar", "10", "2026-10-31"],
      ["Synthetic", "10", "2026-10-01", "--rate", "101"],
      ["--help"],
    ])
      expect(await runVehicleCommand(input, io, { profile: "demo" }, deps)).toBe(2);
    expect(
      await runVehicleCommand(
        ["Synthetic \u{1FAE9}", "10", "2026-10-31"],
        io,
        { profile: "demo" },
        deps,
      ),
    ).toBe(0);
    expect(
      await runVehicleCommand(
        ["[red]Synthetic[/]", "10", "2026-10-31"],
        io,
        { profile: "demo" },
        deps,
      ),
    ).toBe(0);
    expect(
      await runVehicleCommand(
        ["Synthetic :car:", "10", "2026-10-31"],
        io,
        { profile: "demo" },
        deps,
      ),
    ).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    const vault = [...host.stores.vaults.values()][0];
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 3 }]);
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM depreciations")).toEqual([{ n: 3 }]);
  } finally {
    await host.stop();
  }
});

it("supports the assets alias and explicit environment selection while rejecting unknown leaves", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const { io } = output({ CASHU_PROFILE: "demo" });
  try {
    const commands = vehicleCommands({ stores: host.stores, now: at, render: () => {} });
    const assets = commands.find((command) => command.name === "assets");
    expect(await assets?.run(["add-position", "Synthetic"], io, {})).toBe(2);
    expect(await assets?.run(["set-vehicle", ...args], io, {})).toBe(0);
  } finally {
    await host.stop();
  }
});

it("parses prices and dates strictly and refuses hex prices and impossible dates", () => {
  expect(vehicleInput(["Synthetic", "1000.5", "2026-10-26", "--rate=15"])).toMatchObject({
    price: 1000.5,
    date: "2026-10-26",
    rate: 15,
  });
  expect(vehicleInput(["Synthetic", "0x10", "2026-10-31"])).toBeUndefined();
  expect(vehicleInput(["Synthetic", "1", "2026-02-30"])).toBeUndefined();
});

it("executes both aliases through the native host", async () => {
  const dir = tempDir();
  const host = await startLocalHost({
    ...testHostOptions(dir),
    launcher: false,
    now: at,
  });
  const conn = await connectHost({ dataDir: dir, role: "cli", build: "test" });
  const notes: unknown[] = [];
  conn.onFrame((frame) => {
    if (frame.t === "note") notes.push(frame);
  });
  try {
    for (const command of [["set-vehicle"], ["assets", "set-vehicle"]]) {
      const result = await conn.call("cli.exec", {
        argv: ["--profile", "demo", ...command, ...args],
        cwd: dir,
        paths: { home: dir },
        env: { CASHU_LANG: "en" },
        tty: { stdin: false, stdout: false, stderr: false },
      });
      expect(result).toEqual({ kind: "exit", code: 0 });
    }
    const vault = [...host.stores.vaults.values()][0];
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 1 }]);
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM depreciations")).toEqual([{ n: 1 }]);
    expect(notes).toHaveLength(2);
  } finally {
    conn.close();
    await host.stop();
  }
});
