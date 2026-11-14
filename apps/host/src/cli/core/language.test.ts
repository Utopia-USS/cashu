import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { appLanguage, pinnedLanguage } from "../../language.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo } from "../tree.js";
import { languageCommand } from "./language.js";

afterEach(cleanup);

function output(lang: "pl" | "en" = "en") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CommandIo = {
    cwd: tempDir(),
    env: {},
    tty: { stdin: false, stdout: false, stderr: false, columns: 120 },
    signal: new AbortController().signal,
    t: createTranslator(lang),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    prompt: async () => null,
    stdin: async function* () {},
  };
  return { io, stdout, stderr };
}

it("shows and pins the device's app language, the one the host and the agent read", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const command = languageCommand({ stores: host.stores, system: () => "en" });
    const shown = output();
    expect(await command.run([], shown.io, {})).toBe(0);
    expect(shown.stdout.join("")).toBe("App language: English (follows the system).\n");

    const pinned = output("pl");
    expect(await command.run(["PL"], pinned.io, {})).toBe(0);
    expect(pinned.stdout.join("")).toContain("Język aplikacji: polski.");
    expect(pinnedLanguage(host.stores)).toBe("pl");
    expect(appLanguage(host.stores, "en")).toBe("pl");
    const again = output();
    expect(await command.run([], again.io, {})).toBe(0);
    expect(again.stdout.join("")).toBe("App language: Polish (pinned).\n");

    expect(await command.run(["system"], output().io, {})).toBe(0);
    expect(pinnedLanguage(host.stores)).toBeNull();
    expect(appLanguage(host.stores, "en")).toBe("en");

    const wrong = output();
    expect(await command.run(["de"], wrong.io, {})).toBe(2);
    expect(await command.run(["pl", "en"], wrong.io, {})).toBe(2);
    expect(wrong.stderr.join("")).toContain("Usage: cashu language [pl|en|system]");
    expect(pinnedLanguage(host.stores)).toBeNull();
  } finally {
    await host.stop();
  }
});
