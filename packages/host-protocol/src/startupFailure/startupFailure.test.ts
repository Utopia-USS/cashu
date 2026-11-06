import { describe, expect, it } from "vitest";
import {
  buildRecoveryPrompt,
  classifyStartupError,
  commandPrefix,
  failureDetail,
  MIGRATE_UNPRICED_LABEL_MAX,
  MIGRATE_UNPRICED_MAX,
  MIGRATION_RUNBOOK,
  parseMigrateLine,
  parseStartupFailureRecord,
  parseStartupFailureReport,
  type RecoveryCommand,
  recoveryCommand,
  recoveryCommands,
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

class FakeMigrationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "MigrationError";
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
    paths.push(classifyStartupError(new FakeMigrationError(detail)));
    paths.push(classifyStartupError(new Error(detail), {}, "migrate_verify_mismatch"));
  }
  for (const value of ALL) {
    paths.push(classifyStartupError(new Error(value)));
    paths.push(classifyStartupError(new FakeMigrationError(value)));
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

  it("has the migration codes with their stages and untouched originals", () => {
    expect(startupFailure("migrate_import_failed")).toEqual({
      code: "migrate_import_failed",
      stage: "migrate_import",
      originalsUntouched: true,
      facts: {},
    });
    expect(startupFailure("migration_incomplete", "cutover_failed")).toMatchObject({
      stage: "migrate_cutover",
      originalsUntouched: true,
    });
    expect(startupFailure("unknown").originalsUntouched).toBe(false);
    for (const detail of [
      "already_migrated",
      "python_data_absent",
      "source_changed",
      "staging_failed",
      "cutover_failed",
      "cancelled",
      "source_unsafe",
      "snapshot_unverified",
      "unsupported_schema",
      "semantic_difference",
      "mapping_invalid",
      "identity_invalid",
      "replay_mismatch",
    ])
      expect(STARTUP_FAILURE_DETAIL_NAMES).toContain(detail);
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

  it("maps migration refusals to the import by default and to the code a caller ran under", () => {
    expect(classifyStartupError(new FakeMigrationError("replay_mismatch"))).toMatchObject({
      code: "migrate_import_failed",
      stage: "migrate_import",
      detail: "replay_mismatch",
    });
    expect(
      classifyStartupError(
        new FakeMigrationError("replay_mismatch"),
        {},
        "migrate_verify_mismatch",
      ),
    ).toMatchObject({
      code: "migrate_verify_mismatch",
      stage: "migrate_verify",
      detail: "replay_mismatch",
    });
    expect(classifyStartupError(new Error("boom"), {}, "migration_incomplete")).toEqual(
      startupFailure("migration_incomplete"),
    );
    expect(failureDetail(new FakeMigrationError("source_changed"))).toBe("source_changed");
    expect(failureDetail(new Error(SECRETS.iban))).toBeUndefined();
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

  it("puts the import first for the codes the import fixes, and the runbook in the prompt", () => {
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
    for (const code of [
      "python_data_present",
      "migrate_import_failed",
      "migration_incomplete",
    ] as const)
      expect(recoveryCommands(report(code))).toEqual([
        `${cashu} migrate`,
        `${cashu} migrate verify`,
      ]);
    expect(recoveryCommands(report("vault_key_unavailable"))).toEqual([`${cashu} migrate verify`]);
    const prompt = buildRecoveryPrompt(report("python_data_present"), "en");
    expect(prompt).toContain(`  ${cashu} migrate\n`);
    expect(prompt).toContain(`${MIGRATION_RUNBOOK} (in the cashU repository)`);
    expect(prompt).toContain("Failure code: python_data_present");
    expect(buildRecoveryPrompt(report("python_data_present"), "pl")).toContain(
      "Kod błędu: python_data_present",
    );
  });
});

describe("migrate child protocol", () => {
  const words = Array.from("abcdefghijklmnopqrstuvwx", (letter) => `word${letter}`).join(" ");

  it("accepts exactly the protocol lines", () => {
    expect(parseMigrateLine('{"event":"progress","stage":"copy"}')).toEqual({
      event: "progress",
      stage: "copy",
    });
    expect(parseMigrateLine(JSON.stringify({ event: "recovery-words", words }))).toEqual({
      event: "recovery-words",
      words,
    });
    expect(
      parseMigrateLine(
        '{"event":"done","status":"migrated","profiles":2,"financialTables":9,"financialRows":120,"vaults":2,"backupDir":"python-backup-20261104T093000Z"}',
      ),
    ).toMatchObject({ event: "done", status: "migrated", vaults: 2 });
    expect(parseMigrateLine('{"event":"done","status":"already_migrated"}')).toMatchObject({
      status: "already_migrated",
    });
    const unpriced = Array.from({ length: MIGRATE_UNPRICED_MAX }, (_, index) => ({
      label: `${"X".repeat(MIGRATE_UNPRICED_LABEL_MAX - 4)}${String(index).padStart(4, "0")}`,
      currency: "EUR",
      reason: index % 2 === 0 ? "no_prices" : "no_fx",
    }));
    expect(
      parseMigrateLine(JSON.stringify({ event: "done", status: "verified", unpriced })),
    ).toEqual({ event: "done", status: "verified", unpriced });
    expect(
      parseMigrateLine(
        '{"event":"failed","code":"migrate_import_failed","detail":"source_changed"}',
      ),
    ).toEqual({ event: "failed", code: "migrate_import_failed", detail: "source_changed" });
  });

  it("rejects anything else", () => {
    for (const line of [
      "",
      "progress copy",
      '{"event":"progress","stage":"copy","note":"x"}',
      '{"event":"progress","stage":"upload"}',
      '{"event":"recovery-words","words":"too few words here"}',
      JSON.stringify({ event: "recovery-words", words: words.toUpperCase() }),
      JSON.stringify({ event: "recovery-words", words: `${words}  extra` }),
      '{"event":"done","status":"migrated","backupDir":"../elsewhere"}',
      '{"event":"done","status":"migrated","profiles":-1}',
      '{"event":"done","status":"migrated","unpriced":[{"label":"","currency":"EUR","reason":"no_fx"}]}',
      '{"event":"done","status":"migrated","unpriced":[{"label":"SEUR","currency":"eur","reason":"no_fx"}]}',
      '{"event":"done","status":"migrated","unpriced":[{"label":"SEUR","currency":"EUR","reason":"late"}]}',
      `{"event":"done","status":"migrated","unpriced":[{"label":"${"X".repeat(MIGRATE_UNPRICED_LABEL_MAX + 1)}","currency":"EUR","reason":"no_fx"}]}`,
      JSON.stringify({
        event: "done",
        status: "migrated",
        unpriced: Array.from({ length: MIGRATE_UNPRICED_MAX + 1 }, () => ({
          label: "SEUR",
          currency: "EUR",
          reason: "no_fx",
        })),
      }),
      `{"event":"failed","code":"unknown","detail":"${SECRETS.iban}"}`,
      '{"event":"failed","code":"not_a_code"}',
      JSON.stringify({ event: "progress", stage: "copy", pad: "x".repeat(40_000) }),
    ])
      expect(parseMigrateLine(line)).toBeNull();
  });
});
