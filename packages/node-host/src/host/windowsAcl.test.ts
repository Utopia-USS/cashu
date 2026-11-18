// The owner-only data dir DACL with an injected command runner (runs on every OS): the exact system
// commands, the idempotent skip, the fail-closed outcomes and the SDDL / whoami parsing. The real
// icacls is exercised by windowsAcl.integration.test.ts on Windows.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, trackDir } from "../testing/hostHarness.js";
import { HostPathError } from "./paths.js";
import {
  type AclCommandResult,
  type AclCommandRunner,
  ADMINISTRATORS_SID,
  isOwnerOnlyDacl,
  makeOwnerOnly,
  parseIntegrityLevel,
  parseSavedDacl,
  parseSddlOwner,
  parseWhoamiSid,
  powerShellQuoted,
  SYSTEM_SID,
} from "./windowsAcl.js";

afterEach(cleanup);

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const DIR = "C:\\cashu";
const ENV = { SystemRoot: "C:\\Windows" };
const WHOAMI = "C:\\Windows\\System32\\whoami.exe";
const ICACLS = "C:\\Windows\\System32\\icacls.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const OWNER_ONLY = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${SID})`;
const INHERITED = "D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIIDIO;0x1301bf;;;AU)";

/** An `icacls /save` listing as icacls writes it: UTF-16LE, the name line, then the SDDL. */
const listing = (sddl: string) => Buffer.from(`cashu\r\n${sddl}\r\n`, "utf16le");

interface Call {
  readonly file: string;
  readonly args: readonly string[];
}

/** `whoami /groups /fo csv /nh` with the mandatory label `S-1-16-<level>` (names are localized). */
const groups = (level: number) =>
  [
    `"Jeder","Bekannte Gruppe","S-1-1-0","Verbindlich"`,
    `"VORDEFINIERT\\Administratoren","Alias","S-1-5-32-544","Nur verweigern"`,
    `"Verbindliche Beschriftung\\Hohe Verbindlichkeitsstufe","Bezeichnung","S-1-16-${level}",""`,
  ].join("\r\n");

/**
 * A fake Windows: whoami answers `SID` (and `groups` for /groups), PowerShell the dir's SDDL with
 * `owner` (default `SID`), `/save` writes the current DACL, the grant moves it to `afterGrant`. Every
 * call is recorded.
 */
function fakeWindows(options: {
  dacl: string;
  afterGrant?: string;
  grantStatus?: number;
  whoami?: AclCommandResult;
  owner?: string;
  powershell?: AclCommandResult;
  groups?: AclCommandResult;
}) {
  const calls: Call[] = [];
  let dacl = options.dacl;
  const run: AclCommandRunner = (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === WHOAMI && args[0] === "/groups")
      return options.groups ?? { status: 0, stdout: groups(8192) };
    if (file === WHOAMI)
      return options.whoami ?? { status: 0, stdout: `"desktop-1\\anna","${SID}"\r\n` };
    if (file === POWERSHELL) {
      const owner = options.owner ?? SID;
      return options.powershell ?? { status: 0, stdout: `O:${owner}G:${owner}${dacl}\r\n` };
    }
    if (args[1] === "/save") {
      writeFileSync(args[2] as string, listing(dacl));
      return { status: 0, stdout: "" };
    }
    if (args[1] === "/inheritance:r") {
      if ((options.grantStatus ?? 0) !== 0) return { status: options.grantStatus ?? 1, stdout: "" };
      dacl = options.afterGrant ?? OWNER_ONLY;
      return { status: 0, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  return { calls, run };
}

const tempDir = () => trackDir(mkdtempSync(join(tmpdir(), "cashu-acl-test-")));

const failure = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error instanceof HostPathError ? error.message : `other: ${String(error)}`;
  }
  return undefined;
};

const WHOAMI_CALL = { file: WHOAMI, args: ["/user", "/fo", "csv", "/nh"] };
const GROUPS_CALL = { file: WHOAMI, args: ["/groups", "/fo", "csv", "/nh"] };
const OWNER_CALL = {
  file: POWERSHELL,
  args: ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath 'C:\\cashu').Sddl"],
};
const GRANT_CALL = {
  file: ICACLS,
  args: [DIR, "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/q"],
};

/** The `/save` call into a fresh folder of `temp`. */
const saveCall = (temp: string) => ({
  file: ICACLS,
  args: [DIR, "/save", expect.stringContaining(join(temp, "cashu-acl-")), "/q"],
});

describe("owner-only data dir DACL", () => {
  it("sets a protected DACL for the user and SYSTEM, then checks it, by absolute tool paths", () => {
    const temp = tempDir();
    const win = fakeWindows({ dacl: INHERITED });
    makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: temp });
    expect(win.calls).toEqual([
      WHOAMI_CALL,
      OWNER_CALL,
      saveCall(temp),
      GRANT_CALL,
      saveCall(temp),
    ]);
    expect(readdirSync(temp)).toEqual([]);
  });

  it("leaves a DACL that is already owner-only alone (no rewrite on later starts)", () => {
    const temp = tempDir();
    const win = fakeWindows({ dacl: `D:PAI(A;CIOI;FA;;;${SID})(A;OICI;FA;;;SY)` });
    makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: temp });
    expect(win.calls).toEqual([WHOAMI_CALL, OWNER_CALL, saveCall(temp)]);
  });

  it("falls back to windir when SystemRoot is unset", () => {
    const win = fakeWindows({ dacl: OWNER_ONLY });
    makeOwnerOnly(DIR, { env: { windir: "C:\\Windows" }, run: win.run, tempDir: tempDir() });
    expect(win.calls[0]).toEqual(WHOAMI_CALL);
  });

  it("fails closed, naming the dir, when icacls cannot set the DACL", () => {
    const win = fakeWindows({ dacl: INHERITED, grantStatus: 5 });
    expect(failure(() => makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: tempDir() }))).toBe(
      "C:\\cashu could not be made private to this user: icacls could not set its access list",
    );
  });

  it("fails closed when another account keeps an explicit entry", () => {
    const win = fakeWindows({
      dacl: INHERITED,
      afterGrant: `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${SID})(A;OICI;0x1200a9;;;S-1-5-21-9-9-9-1002)`,
    });
    expect(failure(() => makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: tempDir() }))).toBe(
      "C:\\cashu could not be made private to this user: other accounts keep access (remove them, then start again)",
    );
  });

  it("fails closed without a SID, a SystemRoot, or for a drive or share root", () => {
    const opts = (run: AclCommandRunner) => ({ env: ENV, run, tempDir: tempDir() });
    const noSid = fakeWindows({ dacl: INHERITED, whoami: { status: 1, stdout: "" } });
    expect(failure(() => makeOwnerOnly(DIR, opts(noSid.run)))).toBe(
      "C:\\cashu could not be made private to this user: the user's SID is unreadable (whoami)",
    );
    const noRoot = fakeWindows({ dacl: INHERITED });
    expect(
      failure(() => makeOwnerOnly(DIR, { env: {}, run: noRoot.run, tempDir: tempDir() })),
    ).toBe("C:\\cashu could not be made private to this user: SystemRoot is not set");
    expect(noRoot.calls).toEqual([]);
    for (const root of ["C:\\", "\\\\server\\share\\", "relative\\dir"]) {
      const win = fakeWindows({ dacl: INHERITED });
      expect(failure(() => makeOwnerOnly(root, opts(win.run)))).toBe(
        `${root} could not be made private to this user: a drive or share root is never a data dir`,
      );
      expect(win.calls).toEqual([]);
    }
  });

  it("refuses a dir another account owns before touching its DACL, even an owner-only one", () => {
    const other = "S-1-5-21-1111111111-2222222222-3333333333-1002";
    for (const dacl of [INHERITED, OWNER_ONLY]) {
      const win = fakeWindows({ dacl, owner: other });
      expect(
        failure(() => makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: tempDir() })),
      ).toBe(
        `C:\\cashu could not be made private to this user: it is owned by another account (${other}); take ownership as this user, then start again`,
      );
      expect(win.calls).toEqual([WHOAMI_CALL, OWNER_CALL]);
    }
    // SYSTEM, and the built-in Administrator (LA) for any other user, are other accounts too.
    for (const [owner, shown] of [
      ["SY", SYSTEM_SID],
      ["LA", "LA"],
    ] as const) {
      const win = fakeWindows({ dacl: OWNER_ONLY, owner });
      expect(
        failure(() => makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: tempDir() })),
      ).toContain(`it is owned by another account (${shown})`);
    }
  });

  it("accepts the Administrators group as owner only while elevated", () => {
    const temp = tempDir();
    const elevated = fakeWindows({
      dacl: OWNER_ONLY,
      owner: "BA",
      groups: { status: 0, stdout: groups(12288) },
    });
    makeOwnerOnly(DIR, { env: ENV, run: elevated.run, tempDir: temp });
    expect(elevated.calls).toEqual([WHOAMI_CALL, OWNER_CALL, GROUPS_CALL, saveCall(temp)]);
    for (const answer of [
      { status: 0, stdout: groups(8192) },
      { status: 0, stdout: "" },
      { status: 1, stdout: groups(12288) },
    ]) {
      const win = fakeWindows({ dacl: OWNER_ONLY, owner: "BA", groups: answer });
      expect(
        failure(() => makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: tempDir() })),
      ).toBe(
        "C:\\cashu could not be made private to this user: it is owned by another account (S-1-5-32-544); take ownership as this user, then start again",
      );
    }
  });

  it("accepts the built-in Administrator's own dir (owner LA in SDDL)", () => {
    const admin = "S-1-5-21-1-2-3-500";
    const win = fakeWindows({
      dacl: "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)",
      owner: "LA",
      whoami: { status: 0, stdout: `"desktop-1\\administrator","${admin}"` },
    });
    makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: tempDir() });
    expect(win.calls).toHaveLength(3);
  });

  it("fails closed when the owner cannot be read", () => {
    for (const powershell of [
      { status: 1, stdout: "" },
      { status: 0, stdout: "" },
      { status: 0, stdout: "D:PAI(A;OICI;FA;;;SY)" },
      { status: 0, stdout: "Get-Acl : Zugriff verweigert" },
    ]) {
      const win = fakeWindows({ dacl: OWNER_ONLY, powershell });
      expect(
        failure(() => makeOwnerOnly(DIR, { env: ENV, run: win.run, tempDir: tempDir() })),
      ).toBe("C:\\cashu could not be made private to this user: its owner is unreadable (Get-Acl)");
    }
  });

  it("quotes the dir for PowerShell, typographic single quotes included", () => {
    const dir = "C:\\Users\\O'Brien\\it\u2019s $(calc) `x` [1]\\cashu";
    const win = fakeWindows({ dacl: OWNER_ONLY });
    makeOwnerOnly(dir, { env: ENV, run: win.run, tempDir: tempDir() });
    expect(win.calls[1]).toEqual({
      file: POWERSHELL,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Acl -LiteralPath 'C:\\Users\\O''Brien\\it\u2019\u2019s $(calc) `x` [1]\\cashu').Sddl",
      ],
    });
    expect(powerShellQuoted("\u2018\u201A\u201B'")).toBe(
      "'\u2018\u2018\u201A\u201A\u201B\u201B'''",
    );
  });

  it("fails closed when the DACL cannot be read back", () => {
    let saves = 0;
    const run: AclCommandRunner = (file, args) => {
      if (file === WHOAMI) return { status: 0, stdout: `"d\\a","${SID}"` };
      if (file === POWERSHELL) return { status: 0, stdout: `O:${SID}G:${SID}${INHERITED}` };
      if (args[1] === "/save") {
        saves += 1;
        if (saves === 1) writeFileSync(args[2] as string, listing(INHERITED));
        return { status: saves === 1 ? 0 : 2, stdout: "" };
      }
      return { status: 0, stdout: "" };
    };
    expect(failure(() => makeOwnerOnly(DIR, { env: ENV, run, tempDir: tempDir() }))).toBe(
      "C:\\cashu could not be made private to this user: its access list is unreadable",
    );
  });
});

describe("whoami and SDDL parsing", () => {
  it("reads the SID from whoami's CSV, whatever the account name holds", () => {
    expect(parseWhoamiSid(`"desktop-1\\anna","${SID}"\r\n`)).toBe(SID);
    expect(parseWhoamiSid(`"AzureAD\\Zoë, \\"x\\"","S-1-12-1-1-2-3-4"`)).toBe("S-1-12-1-1-2-3-4");
    expect(parseWhoamiSid("NT AUTHORITY\\SYSTEM S-1-5-18")).toBeUndefined();
    expect(parseWhoamiSid(`"a\\b","S-1-"`)).toBeUndefined();
    expect(parseWhoamiSid("")).toBeUndefined();
  });

  it("reads the owner of an SDDL and the integrity level of whoami /groups", () => {
    expect(parseSddlOwner(`O:${SID}G:${SID}D:PAI(A;OICI;FA;;;SY)`)).toBe(SID);
    expect(parseSddlOwner("\r\nO:BAG:SYD:PAI(A;OICI;FA;;;SY)\r\n")).toBe(ADMINISTRATORS_SID);
    expect(parseSddlOwner("O:SYG:SY")).toBe(SYSTEM_SID);
    expect(parseSddlOwner("O:LAG:LA")).toBe("LA");
    expect(parseSddlOwner(`O:${SID}`)).toBe(SID);
    expect(parseSddlOwner("G:SYD:PAI")).toBeUndefined();
    expect(parseSddlOwner("O:S-1-G:SY")).toBeUndefined();
    expect(parseSddlOwner("O:BAXG:SY")).toBeUndefined();
    expect(parseSddlOwner("")).toBeUndefined();
    expect(parseIntegrityLevel(groups(12288))).toBe(12288);
    expect(parseIntegrityLevel(`${groups(8192)}\r\n"x","y","S-1-16-16384",""`)).toBe(16384);
    expect(parseIntegrityLevel(`"Jeder","Bekannte Gruppe","S-1-1-0",""`)).toBeUndefined();
  });

  it("parses the one DACL of a listing in UTF-16LE (with or without a BOM) or UTF-8", () => {
    const sddl = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${SID.toLowerCase()})S:AI(ML;;NW;;;LW)`;
    const expected = {
      control: "PAI",
      aces: [
        { type: "A", flags: "OICI", trustee: SYSTEM_SID },
        { type: "A", flags: "OICI", trustee: SID },
      ],
    };
    expect(parseSavedDacl(listing(sddl))).toEqual(expected);
    expect(parseSavedDacl(Buffer.concat([Buffer.from([0xff, 0xfe]), listing(sddl)]))).toEqual(
      expected,
    );
    expect(parseSavedDacl(Buffer.from(`cashu\n${sddl}\n`, "utf8"))).toEqual(expected);
    // A drive-letter name line is no DACL.
    expect(parseSavedDacl(Buffer.from(`D:\\cashu\n${sddl}\n`, "utf8"))).toEqual(expected);
  });

  it("refuses listings without exactly one well-formed DACL", () => {
    expect(parseSavedDacl(Buffer.from("cashu\r\n", "utf16le"))).toBeUndefined();
    expect(parseSavedDacl(listing(`${OWNER_ONLY}\r\n${OWNER_ONLY}`))).toBeUndefined();
    expect(parseSavedDacl(listing("D:PAI(A;OICI;FA)"))).toBeUndefined();
  });

  it("accepts only a protected DACL granting the user and SYSTEM alone, inherited below", () => {
    const owner = (sddl: string) => {
      const dacl = parseSavedDacl(listing(sddl));
      return dacl !== undefined && isOwnerOnlyDacl(dacl, SID);
    };
    expect(owner(OWNER_ONLY)).toBe(true);
    // A deny entry for others narrows access further.
    expect(owner(`${OWNER_ONLY}(D;OICI;FA;;;WD)`)).toBe(true);
    expect(owner(INHERITED)).toBe(false);
    expect(owner(OWNER_ONLY.replace("D:PAI", "D:AI"))).toBe(false);
    expect(owner(`${OWNER_ONLY}(A;OICI;FA;;;AU)`)).toBe(false);
    expect(owner(`${OWNER_ONLY}(A;;FA;;;CO)`)).toBe(false);
    expect(owner(`D:PAI(A;OICI;FA;;;SY)(A;CI;FA;;;${SID})`)).toBe(false);
    // CIIO: inherit-only, the folder itself would not be the user's (no "IO" read across pairs).
    expect(owner(`D:PAI(A;OICI;FA;;;SY)(A;OICIIO;FA;;;${SID})`)).toBe(false);
    expect(owner(`D:PAI(A;CIOI;FA;;;SY)(A;CIOI;FA;;;${SID})`)).toBe(true);
    expect(owner(`D:PAI(A;OICI;FA;;;SY)`)).toBe(false);
    // The built-in Administrator account appears as LA.
    const admin = "S-1-5-21-1-2-3-500";
    const dacl = parseSavedDacl(listing("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)"));
    expect(dacl !== undefined && isOwnerOnlyDacl(dacl, admin)).toBe(true);
    expect(dacl !== undefined && isOwnerOnlyDacl(dacl, SID)).toBe(false);
  });
});
