import { createTranslator } from "@cashu/i18n";
import { renameProfile } from "@cashu/store";
import { expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { cliCommandKey, reportCliCommandFailure, runCliVaultCommand } from "./commandOutcome.js";
import type { CommandIo } from "./tree.js";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(["cancel", "profile-switch"])(
  "preserves the original key when CLI context changes after encrypted append: %s",
  async (change) => {
    const fixture = await nativeVaultFixture();
    const host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      python: null,
      vaultSource: fixture.vaultSource,
    });
    const gate = deferred();
    const wrote = deferred();
    try {
      const vault = host.stores.vaults.get(fixture.vaultId);
      if (!vault?.native) throw new Error("native vault missing");
      const original = vault.native.engine.write.bind(vault.native.engine);
      vault.native.engine.write = async (...args) => {
        const result = await original(...args);
        wrote.release();
        await gate.promise;
        return result;
      };
      let selected = true;
      const controller = new AbortController();
      const key = cliCommandKey();
      const work = runCliVaultCommand(
        vault,
        renameProfile,
        { name: "Synthetic updated" },
        key,
        () => selected && !controller.signal.aborted,
      );
      await wrote.promise;
      if (change === "cancel") controller.abort();
      else selected = false;
      gate.release();
      expect(await work).toMatchObject({ kind: "outcome_unknown", key });
    } finally {
      gate.release();
      await host.stop();
      fixture.cleanup();
    }
  },
);

it("reports an uncertain durable key in Polish", () => {
  const lines: string[] = [];
  const io: CommandIo = {
    cwd: "/private/tmp",
    env: {},
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("pl"),
    stdout: () => {},
    stderr: (line) => {
      lines.push(line);
    },
    prompt: async () => null,
    stdin: async function* () {},
  };
  expect(
    reportCliCommandFailure(
      io,
      { kind: "outcome_unknown", key: "synthetic" },
      "synthetic",
      "loans.addLoan",
    ),
  ).toBe(1);
  expect(lines.join("")).toContain("Wynik polecenia jest nieznany");
  expect(lines.join("")).toContain("cashu command-status loans.addLoan synthetic");
});
