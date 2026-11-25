import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStartupFailureReport, startupFailure } from "@cashu/host-protocol/startup-failure";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admissionFailure, StartupRecovery, type StartupRecoveryDeps } from "./recovery.js";

const IBAN = "PL61109010140000071219812874";
const PERSON = "Zofia Synthetic-Kowalska";
const AT = new Date("2026-11-04T09:30:00.000Z");

let home: string;
let dataDir: string;
let lines: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cashu-recovery-test-"));
  dataDir = join(home, "Library", "Application Support", "cashU");
  mkdirSync(join(dataDir, "logs"), { recursive: true, mode: 0o700 });
  lines = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function deps(overrides: Partial<StartupRecoveryDeps> = {}): StartupRecoveryDeps {
  return {
    dataDir,
    home,
    appVersion: "0.6.0",
    build: "desktop-dev",
    lang: "en",
    hostLogPath: join(dataDir, "logs", "host.log"),
    command: () => ({ kind: "launcher", path: "~/Library/Application Support/cashU/bin/cashu" }),
    mcpServerPrefix: "cashu",
    log: (line) => lines.push(line),
    ...overrides,
  };
}

function diagnostics(): string[] {
  try {
    return readdirSync(join(dataDir, "diagnostics")).sort();
  } catch {
    return [];
  }
}

const OLD_DATA = { roots: 1, nativeInventory: false, continued: false } as const;

describe("admissionFailure", () => {
  it("shows old app data only before the first native profile and until the user continues", () => {
    expect(admissionFailure(OLD_DATA)).toEqual(
      startupFailure("python_data_present", "python_data_found", { pythonSources: 1 }),
    );
    expect(admissionFailure({ ...OLD_DATA, roots: 0 })).toBeNull();
    expect(admissionFailure({ ...OLD_DATA, nativeInventory: true })).toBeNull();
    expect(admissionFailure({ ...OLD_DATA, continued: true })).toBeNull();
  });
});

describe("StartupRecovery", () => {
  it("enters on old app data, writes one private report pair and keeps it on a retry", () => {
    const recovery = new StartupRecovery(deps());
    expect(recovery.admit(OLD_DATA, AT)).toBe(true);
    expect(recovery.active).toBe(true);
    const files = diagnostics();
    expect(files).toEqual([
      "startup-failure-20261104T093000000Z.json",
      "startup-failure-20261104T093000000Z.txt",
    ]);
    expect(statSync(join(dataDir, "diagnostics")).mode & 0o777).toBe(0o700);
    for (const file of files)
      expect(statSync(join(dataDir, "diagnostics", file)).mode & 0o777).toBe(0o600);
    const report = parseStartupFailureReport(
      JSON.parse(readFileSync(join(dataDir, "diagnostics", files[0] ?? ""), "utf8")),
    );
    expect(report).toEqual(recovery.report);
    expect(report?.dataDir).toBe("~/Library/Application Support/cashU");
    expect(report?.reportFile).toBe(
      "~/Library/Application Support/cashU/diagnostics/startup-failure-20261104T093000000Z.txt",
    );
    const text = readFileSync(join(dataDir, "diagnostics", files[1] ?? ""), "utf8");
    expect(text).toBe(recovery.prompt("en"));
    expect(text).toContain('~/"Library/Application Support/cashU/bin/cashu" mcp --profile <slug>');
    expect(recovery.prompt("pl")).toContain("Kod błędu: python_data_present");

    expect(recovery.admit(OLD_DATA, new Date(AT.valueOf() + 1000))).toBe(true);
    expect(diagnostics()).toEqual(files);
    expect(recovery.admit({ ...OLD_DATA, continued: true }, AT)).toBe(false);
    expect(recovery.active).toBe(false);
    expect(recovery.prompt("en")).toBeNull();
    // Diagnostics files are never deleted.
    expect(diagnostics()).toEqual(files);
  });

  it("enters a host failure record once, with the sanitized log tail only", () => {
    writeFileSync(
      join(dataDir, "logs", "host.log"),
      [
        JSON.stringify({
          at: "2026-11-04T09:29:59.000Z",
          level: "error",
          event: "host.start-failure",
          code: "vault_key_unavailable",
          detail: "keystore_unavailable",
          error: "StartupFailureError",
          iban: IBAN,
        }),
        `transfer from ${PERSON} ${IBAN}`,
      ].join("\n"),
    );
    const recovery = new StartupRecovery(deps());
    const found = {
      failure: startupFailure("vault_key_unavailable", "keystore_unavailable", { vaults: 1 }),
      at: AT.valueOf(),
      build: "desktop-dev",
    };
    expect(recovery.hostFailure(found)).toBe(true);
    expect(recovery.hostFailure(found)).toBe(false);
    expect(diagnostics()).toHaveLength(2);
    const report = recovery.report;
    expect(report?.failure).toEqual(found.failure);
    expect(report?.logTail).toHaveLength(1);
    expect(report?.omittedLogLines).toBe(1);
    for (const text of [JSON.stringify(report), recovery.prompt("en"), recovery.prompt("pl")]) {
      expect(text).not.toContain(IBAN);
      expect(text).not.toContain(PERSON);
      expect(text).not.toContain(home);
    }
    expect(lines).toEqual(["recovery: vault_key_unavailable at vault_open"]);
  });

  it("still shows a report when the diagnostics folder cannot be written", () => {
    const file = join(home, "not-a-dir");
    writeFileSync(file, "synthetic");
    const recovery = new StartupRecovery(deps({ dataDir: file }));
    const report = recovery.enter(startupFailure("view_rebuild_failed"), AT);
    expect(report.reportFile).toBeNull();
    expect(report.failure.stage).toBe("view_rebuild");
    expect(recovery.active).toBe(true);
    expect(lines[0]).toBe("recovery: the diagnostics report could not be written");
  });
});
