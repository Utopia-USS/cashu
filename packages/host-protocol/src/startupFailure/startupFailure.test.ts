import { describe, expect, it } from "vitest";
import {
  buildRecoveryPrompt,
  classifyStartupError,
  commandPrefix,
  parseStartupFailureRecord,
  parseStartupFailureReport,
  type RecoveryCommand,
  recoveryCommand,
  STARTUP_FAILURE_CODES,
  STARTUP_FAILURE_DETAIL_NAMES,
  STARTUP_FAILURE_DETAILS,
  STARTUP_FAILURE_SPECS,
  STARTUP_STAGES,
  type StartupFailure,
  StartupFailureError,
  startupFailure,
  startupFailureReport,
} from "./index.js";

// Synthetic sensitive values: none of them may ever reach a report or a prompt.
const SECRETS = {
  iban: "PL61109010140000071219812874",
  amount: "12345.67",
  person: "Zofia Synthetic-Kowalska",
  merchant: "Biedronka Synthetic 0042",
  token: "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  key: "AAAAC3NzaC1lZDI1NTE5AAAAIsyntheticKey",
  user: "zofia.synthetic",
};
const HOME = `/Users/${SECRETS.user}`;
const ALL = Object.values(SECRETS);

function leaks(text: string): string[] {
  return ALL.filter((value) => text.includes(value));
}

class FakeCodedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "RefusalError";
  }
}

const HOSTILE_LOG = [
  JSON.stringify({ at: "2026-11-04T09:00:00.000Z", level: "info", event: "host.started" }),
  JSON.stringify({
    at: "2026-11-04T09:00:01.000Z",
    level: "error",
    event: "host.start-failure",
    code: "vault_key_unavailable",
    detail: "keystore_unavailable",
    error: "StartupFailureError",
    iban: SECRETS.iban,
    message: `${SECRETS.person} paid ${SECRETS.amount} at ${SECRETS.merchant}`,
  }),
  JSON.stringify({ level: "error", event: `transfer to ${SECRETS.iban}` }),
  JSON.stringify({ level: "error", event: "host.start-failed", code: SECRETS.token }),
  JSON.stringify({ level: "warn", event: "host.start-failed", detail: SECRETS.key }),
  `native_sync_failed Error ${SECRETS.token}`,
  `native_sync_failed ${SECRETS.person}`,
  `Error: ENOENT ${HOME}/Library/Application Support/cashU/${SECRETS.merchant}.csv`,
  "x".repeat(5000) + SECRETS.iban,
  "native_sync_failed RefusalError keystore_corrupt",
].join("\n");

/** Every way a failure reaches a report: each code, each detail, and hostile raw errors. */
function failurePaths(): StartupFailure[] {
  const paths: StartupFailure[] = [];
  for (const code of STARTUP_FAILURE_CODES) paths.push(startupFailure(code));
  for (const detail of STARTUP_FAILURE_DETAIL_NAMES) {
    paths.push(startupFailure(STARTUP_FAILURE_DETAILS[detail][0], detail, { vaults: 2 }));
    paths.push(classifyStartupError(new FakeCodedError(detail)));
  }
  for (const value of ALL) {
    paths.push(classifyStartupError(new Error(value)));
    paths.push(classifyStartupError(new FakeCodedError(value)));
    paths.push(classifyStartupError(new Error(`native_inventory_invalid ${value}`)));
    paths.push(classifyStartupError({ code: value, message: value }));
    paths.push(classifyStartupError(value));
  }
  // A caller-built failure with extra fields and free facts.
  paths.push({
    ...startupFailure("unknown"),
    facts: { vaults: 1, iban: SECRETS.iban, recentCrashes: 1.5 } as never,
    note: SECRETS.person,
  } as StartupFailure);
  return paths;
}

const COMMANDS: (RecoveryCommand | null)[] = [
  recoveryCommand({
    home: HOME,
    launcher: `${HOME}/Library/Application Support/cashU/bin/cashu`,
    isPackaged: true,
    binary: "/Applications/cashU.app/Contents/MacOS/cashU",
    shim: "/Applications/cashU.app/Contents/Resources/shim.mjs",
  }),
  recoveryCommand({
    home: HOME,
    launcher: null,
    isPackaged: true,
    binary: `${HOME}/Applications/cashU.app/Contents/MacOS/cashU`,
    shim: `${HOME}/Applications/cashU.app/Contents/Resources/shim.mjs`,
  }),
  recoveryCommand({
    home: HOME,
    launcher: `/Volumes/${SECRETS.person}/bin/cashu`,
    isPackaged: true,
    binary: `/Volumes/${SECRETS.person}/cashU.app/Contents/MacOS/cashU`,
    shim: `/Volumes/${SECRETS.person}/cashU.app/Contents/Resources/shim.mjs`,
  }),
  recoveryCommand({ home: HOME, launcher: null, isPackaged: false, binary: "", shim: "" }),
];

describe("failure catalog", () => {
  it("gives every code a stage and every detail a known code and stage", () => {
    for (const code of STARTUP_FAILURE_CODES)
      expect(STARTUP_STAGES).toContain(STARTUP_FAILURE_SPECS[code].stage);
    for (const detail of STARTUP_FAILURE_DETAIL_NAMES) {
      const [code, stage] = STARTUP_FAILURE_DETAILS[detail];
      expect(STARTUP_FAILURE_CODES).toContain(code);
      expect(STARTUP_STAGES).toContain(stage);
    }
  });

  it("has the old-data code at admission with untouched originals", () => {
    expect(startupFailure("python_data_present", "python_data_found")).toEqual({
      code: "python_data_present",
      stage: "admission",
      detail: "python_data_found",
      originalsUntouched: true,
      facts: {},
    });
    expect(startupFailure("unknown").originalsUntouched).toBe(false);
  });
});

describe("classifyStartupError", () => {
  it("keeps a typed failure and merges caller facts", () => {
    const error = new StartupFailureError(
      "native_inventory_unavailable",
      "native_inventory_invalid",
      {
        vaults: 2,
      },
    );
    expect(error.message).toBe("native_inventory_invalid");
    expect(classifyStartupError(error, { recentCrashes: 3 })).toEqual({
      code: "native_inventory_unavailable",
      stage: "inventory",
      detail: "native_inventory_invalid",
      originalsUntouched: true,
      facts: { vaults: 2, recentCrashes: 3 },
    });
  });

  it("maps a typed code field through the detail allow-list only", () => {
    expect(classifyStartupError(new FakeCodedError("keystore_unavailable"))).toMatchObject({
      code: "vault_key_unavailable",
      detail: "keystore_unavailable",
    });
    expect(classifyStartupError(new FakeCodedError(SECRETS.iban))).toEqual(
      startupFailure("unknown"),
    );
  });

  it("maps known message codes and drops everything else", () => {
    expect(classifyStartupError(new Error("keystore_corrupt"))).toMatchObject({
      code: "vault_key_unavailable",
      detail: "keystore_corrupt",
    });
    expect(classifyStartupError(new Error("view_rebuild_failed")).code).toBe("view_rebuild_failed");
    expect(classifyStartupError(new Error(`bad ${SECRETS.iban}`))).toEqual(
      startupFailure("unknown"),
    );
    expect(classifyStartupError(new Error("some_other_code"))).toEqual(startupFailure("unknown"));
  });
});

describe("report and prompt redaction", () => {
  it("lets no synthetic sensitive value through any failure path, command form or language", () => {
    let checked = 0;
    for (const failure of failurePaths()) {
      for (const command of COMMANDS) {
        const report = startupFailureReport({
          failure,
          at: new Date("2026-11-04T09:30:00.000Z"),
          appVersion: `0.6.0 ${SECRETS.token}`,
          build: `desktop-${SECRETS.key}`,
          dataDir: `${HOME}/Library/Application Support/cashU`,
          home: HOME,
          reportFile: `/tmp/${SECRETS.person}/report.txt`,
          logText: HOSTILE_LOG,
          command,
        });
        expect(parseStartupFailureReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
        for (const lang of ["pl", "en"] as const) {
          const prompt = buildRecoveryPrompt(report, lang);
          expect(leaks(prompt)).toEqual([]);
          expect(prompt).not.toContain(HOME);
          expect(prompt).not.toContain("—");
          checked++;
        }
        expect(leaks(JSON.stringify(report))).toEqual([]);
        expect(report.appVersion).toBe("<unknown>");
        expect(report.build).toBe("<unknown>");
        expect(report.reportFile).toBe("<outside home>");
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("keeps only allow-listed log fields", () => {
    const report = startupFailureReport({
      failure: startupFailure("vault_key_unavailable", "keystore_unavailable"),
      at: new Date("2026-11-04T09:30:00.000Z"),
      appVersion: "0.6.0",
      build: "desktop-dev",
      dataDir: `${HOME}/Library/Application Support/cashU`,
      home: HOME,
      reportFile: null,
      logText: HOSTILE_LOG,
    });
    expect(report.dataDir).toBe("~/Library/Application Support/cashU");
    expect(report.logTail).toEqual([
      { at: "2026-11-04T09:00:00.000Z", level: "info", event: "host.started" },
      {
        at: "2026-11-04T09:00:01.000Z",
        level: "error",
        event: "host.start-failure",
        code: "vault_key_unavailable",
        detail: "keystore_unavailable",
        error: "StartupFailureError",
      },
      { at: null, level: "error", event: "host.start-failed" },
      { at: null, level: "warn", event: "host.start-failed" },
      {
        at: null,
        level: "warn",
        event: "native_sync_failed",
        error: "RefusalError",
        detail: "keystore_corrupt",
      },
    ]);
    expect(report.omittedLogLines).toBe(5);
    expect(report.command).toBeNull();
  });

  it("rejects reports and records with extra or free-text fields", () => {
    const report = startupFailureReport({
      failure: startupFailure("python_data_present"),
      at: new Date("2026-11-04T09:30:00.000Z"),
      appVersion: "0.6.0",
      build: "desktop-dev",
      dataDir: `${HOME}/cashU`,
      home: HOME,
      reportFile: null,
      logText: "",
    });
    expect(parseStartupFailureReport({ ...report, note: SECRETS.person })).toBeNull();
    expect(parseStartupFailureReport({ ...report, dataDir: `${HOME}/cashU` })).toBeNull();
    expect(
      parseStartupFailureReport({
        ...report,
        command: { kind: "launcher", path: `${HOME}/bin/cashu` },
      }),
    ).toBeNull();
    expect(
      parseStartupFailureReport({
        ...report,
        command: { kind: "packaged", binary: "/Volumes/x/cashU", shim: "/Applications/a/../b" },
      }),
    ).toBeNull();
    const record = {
      format: 1,
      failure: startupFailure("view_rebuild_failed"),
      at: 1,
      build: "desktop-dev",
    };
    expect(parseStartupFailureRecord(record)).toEqual(record);
    expect(
      parseStartupFailureRecord({
        ...record,
        failure: { ...record.failure, detail: SECRETS.iban },
      }),
    ).toBeNull();
  });
});

describe("shipped command", () => {
  it("prefers the data dir launcher, then the packaged binary, then the checkout", () => {
    expect(COMMANDS[0]).toEqual({
      kind: "launcher",
      path: "~/Library/Application Support/cashU/bin/cashu",
    });
    expect(COMMANDS[1]).toEqual({
      kind: "packaged",
      binary: "~/Applications/cashU.app/Contents/MacOS/cashU",
      shim: "~/Applications/cashU.app/Contents/Resources/shim.mjs",
    });
    expect(COMMANDS[2]).toBeNull();
    expect(COMMANDS[3]).toEqual({ kind: "checkout" });
    expect(
      recoveryCommand({
        home: HOME,
        launcher: null,
        isPackaged: true,
        binary: "/Applications/cashU.app/Contents/MacOS/cashU",
        shim: "/Applications/cashU.app/Contents/Resources/shim.mjs",
      }),
    ).toEqual({
      kind: "packaged",
      binary: "/Applications/cashU.app/Contents/MacOS/cashU",
      shim: "/Applications/cashU.app/Contents/Resources/shim.mjs",
    });
  });

  it("renders shell words that keep the tilde expanding", () => {
    expect(commandPrefix(COMMANDS[0] ?? null)).toBe(
      '~/"Library/Application Support/cashU/bin/cashu"',
    );
    expect(
      commandPrefix({
        kind: "packaged",
        binary: "/Applications/cashU.app/Contents/MacOS/cashU",
        shim: "/Applications/cashU.app/Contents/Resources/shim.mjs",
      }),
    ).toBe(
      'ELECTRON_RUN_AS_NODE=1 "/Applications/cashU.app/Contents/MacOS/cashU" "/Applications/cashU.app/Contents/Resources/shim.mjs"',
    );
    expect(commandPrefix({ kind: "checkout" })).toBe("pnpm cashu-next");
    expect(commandPrefix(null)).toBe("cashu");
  });

  it("gives the agent the old-data steps only for the old-data code", () => {
    const report = (code: (typeof STARTUP_FAILURE_CODES)[number]) =>
      startupFailureReport({
        failure: startupFailure(code),
        at: new Date("2026-11-04T09:30:00.000Z"),
        appVersion: "0.6.0",
        build: "desktop-dev",
        dataDir: `${HOME}/cashU`,
        home: HOME,
        reportFile: null,
        logText: "",
        command: COMMANDS[0] ?? null,
      });
    const cashu = '~/"Library/Application Support/cashU/bin/cashu"';
    const prompt = buildRecoveryPrompt(report("python_data_present"), "en");
    expect(prompt).toContain("Failure code: python_data_present");
    expect(prompt).toContain(`claude mcp add cashu-<slug> -- ${cashu} mcp --profile <slug>`);
    expect(prompt).toContain("import-builder skill");
    expect(prompt).toContain("`propose_import`");
    expect(prompt).not.toContain("migrate");
    const pl = buildRecoveryPrompt(report("python_data_present"), "pl");
    expect(pl).toContain("Kod błędu: python_data_present");
    expect(pl).toContain("import-builder");
    const other = buildRecoveryPrompt(report("vault_key_unavailable"), "en");
    expect(other).not.toContain("import-builder");
    expect(other).not.toContain("migrate");
  });

  it("names the MCP server with the flavor's prefix, as the setup screen does", () => {
    const staging = startupFailureReport({
      failure: startupFailure("python_data_present"),
      at: new Date("2026-11-04T09:30:00.000Z"),
      appVersion: "0.6.0",
      build: "desktop-dev",
      dataDir: `${HOME}/cashU Staging`,
      home: HOME,
      reportFile: null,
      logText: "",
      command: { kind: "checkout" },
      mcpServerPrefix: "cashu-staging",
    });
    expect(buildRecoveryPrompt(staging, "en")).toContain(
      "claude mcp add cashu-staging-<slug> -- pnpm cashu-next mcp --profile <slug>",
    );
    expect(() =>
      startupFailureReport({
        failure: startupFailure("python_data_present"),
        at: new Date("2026-11-04T09:30:00.000Z"),
        appVersion: "0.6.0",
        build: "desktop-dev",
        dataDir: `${HOME}/cashU`,
        home: HOME,
        reportFile: null,
        logText: "",
        mcpServerPrefix: "cashu staging; rm",
      }),
    ).toThrow("startup_failure_report_invalid");
  });
});
