// The owner-only data dir DACL with an injected command runner and directory listing (runs on every
// OS): the exact system commands, the idempotent skip, the removal of every other account's entry, the
// reset of the entries below, the fail-closed outcomes and the SDDL / whoami parsing. A small icacls
// model below applies the commands to the SDDL, so each test also sees the DACL they leave. The real
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
  type AclDirEntry,
  ADMINISTRATORS_SID,
  daclProblems,
  isOwnerOnlyDacl,
  makeOwnerOnly,
  parseIntegrityLevel,
  parseSavedDacl,
  parseSddlOwner,
  parseWhoamiSid,
  powerShellQuoted,
  SYSTEM_SID,
  sddlTrusteeSid,
} from "./windowsAcl.js";

afterEach(cleanup);

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const DIR = "C:\\cashu";
const ENV = { SystemRoot: "C:\\Windows" };
const WHOAMI = "C:\\Windows\\System32\\whoami.exe";
const ICACLS = "C:\\Windows\\System32\\icacls.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const OWNER_ONLY = `D:PAI(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)`;
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

/** The SDDL aliases these tests write, as icacls resolves them. */
const ALIASES: Readonly<Record<string, string>> = {
  SY: SYSTEM_SID,
  BA: ADMINISTRATORS_SID,
  BU: "S-1-5-32-545",
  AU: "S-1-5-11",
  CO: "S-1-3-0",
  OW: "S-1-3-4",
  WD: "S-1-1-0",
};
const sidOf = (trustee: string) => ALIASES[trustee] ?? trustee;
const acesOf = (sddl: string) => [...sddl.matchAll(/\(([^()]*)\)/g)].map(([, ace = ""]) => ace);
const field = (ace: string, index: number) => ace.split(";")[index] ?? "";
const sddlOf = (control: string, aces: readonly string[]) =>
  `D:${control}${aces.map((ace) => `(${ace})`).join("")}`;

/**
 * What the icacls commands of `makeOwnerOnly` do to the dir's DACL: `/inheritance:r /grant:r` drops
 * the inherited entries and the named SIDs' grants, then grants them (OI)(CI)F; `/remove` drops every
 * entry of the given SIDs, `/remove:d` their deny entries. Explicit entries of others survive the first.
 */
function icaclsOn(sddl: string, args: readonly string[]): string {
  const control = /^D:([A-Z]*)/.exec(sddl)?.[1] ?? "";
  const aces = acesOf(sddl);
  const named = args.filter((arg) => arg.startsWith("*")).map((arg) => arg.slice(1).split(":")[0]);
  if (args[1] === "/inheritance:r") {
    const kept = aces.filter(
      (ace) =>
        !field(ace, 1).includes("ID") &&
        !(field(ace, 0) === "A" && named.includes(sidOf(field(ace, 5)))),
    );
    const granted = named.map((sid) => `A;OICI;FA;;;${sid === SYSTEM_SID ? "SY" : sid}`);
    return sddlOf("PAI", [...kept, ...granted]);
  }
  const denyOnly = args[1] === "/remove:d";
  return sddlOf(
    control,
    aces.filter(
      (ace) => !named.includes(sidOf(field(ace, 5))) || (denyOnly && field(ace, 0) !== "D"),
    ),
  );
}

/**
 * A fake Windows: whoami answers `SID` (and `groups` for /groups), PowerShell the dir's SDDL with
 * `owner` (default `SID`), `/save` writes the current DACL, the other icacls commands change it as
 * `icaclsOn` says (`stubborn`: `/remove` changes nothing), `below` is the tree under the dir. Every
 * call and every listed folder is recorded.
 */
function fakeWindows(options: {
  dacl: string;
  grantStatus?: number;
  resetStatus?: number;
  removeStatus?: number;
  stubborn?: boolean;
  below?: Readonly<Record<string, readonly AclDirEntry[]>>;
  whoami?: AclCommandResult;
  owner?: string;
  powershell?: AclCommandResult;
  groups?: AclCommandResult;
}) {
  const calls: Call[] = [];
  const listed: string[] = [];
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
    if (file !== ICACLS) return { status: 1, stdout: "" };
    const status = (code: number | undefined) => ({ status: code ?? 0, stdout: "" });
    switch (args[1]) {
      case "/save":
        writeFileSync(args[2] as string, listing(dacl));
        return status(0);
      case "/reset":
        return status(options.resetStatus);
      case "/inheritance:r":
        if ((options.grantStatus ?? 0) === 0) dacl = icaclsOn(dacl, args);
        return status(options.grantStatus);
      case "/remove":
      case "/remove:d":
        if ((options.removeStatus ?? 0) === 0 && options.stubborn !== true)
          dacl = icaclsOn(dacl, args);
        return status(options.removeStatus);
      default:
        return status(1);
    }
  };
  const list = (folder: string): readonly AclDirEntry[] => {
    listed.push(folder);
    return options.below?.[folder] ?? [];
  };
  return { calls, listed, run, list, dacl: () => dacl };
}

const tempDir = () => trackDir(mkdtempSync(join(tmpdir(), "cashu-acl-test-")));

/** The options of a run against `win`. */
const on = (win: ReturnType<typeof fakeWindows>, temp = tempDir()) => ({
  env: ENV,
  run: win.run,
  list: win.list,
  tempDir: temp,
});

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
const RESET_ALL_CALL = { file: ICACLS, args: ["C:\\cashu\\*", "/reset", "/t", "/q"] };
const removeCall = (verb: "/remove" | "/remove:d", ...sids: string[]) => ({
  file: ICACLS,
  args: [DIR, verb, ...sids.map((sid) => `*${sid}`), "/q"],
});

/** The `/save` call into a fresh folder of `temp`. */
const saveCall = (temp: string) => ({
  file: ICACLS,
  args: [DIR, "/save", expect.stringContaining(join(temp, "cashu-acl-")), "/q"],
});

/** A data dir with a run folder and a token inside it. */
const TREE: Readonly<Record<string, readonly AclDirEntry[]>> = {
  "C:\\cashu": [{ name: "run", kind: "dir" }],
  "C:\\cashu\\run": [{ name: "host.token", kind: "file" }],
};

describe("owner-only data dir DACL", () => {
  it("leaves a DACL that is already owner-only alone (no rewrite, no walk on later starts)", () => {
    const temp = tempDir();
    const win = fakeWindows({ dacl: `D:PAI(A;CIOI;FA;;;${SID})(A;OICI;FA;;;SY)`, below: TREE });
    makeOwnerOnly(DIR, on(win, temp));
    expect(win.calls).toEqual([WHOAMI_CALL, OWNER_CALL, saveCall(temp)]);
    expect(win.listed).toEqual([]);
  });

  it("protects a fresh, inheriting dir for the user and SYSTEM, by absolute tool paths", () => {
    const temp = tempDir();
    const win = fakeWindows({ dacl: INHERITED });
    makeOwnerOnly(DIR, on(win, temp));
    expect(win.calls).toEqual([
      WHOAMI_CALL,
      OWNER_CALL,
      saveCall(temp),
      GRANT_CALL,
      saveCall(temp),
    ]);
    expect(win.dacl()).toBe(OWNER_ONLY);
    expect(win.listed).toEqual([DIR]);
    expect(readdirSync(temp)).toEqual([]);
  });

  it("resets the entries below to inherit before it narrows the dir (one recursive reset)", () => {
    const temp = tempDir();
    const win = fakeWindows({ dacl: INHERITED, below: TREE });
    makeOwnerOnly(DIR, on(win, temp));
    expect(win.calls).toEqual([
      WHOAMI_CALL,
      OWNER_CALL,
      saveCall(temp),
      RESET_ALL_CALL,
      GRANT_CALL,
      saveCall(temp),
    ]);
    expect(win.listed).toEqual([DIR, "C:\\cashu\\run"]);
  });

  it("never resets through a link: with one below, each other entry is reset on its own", () => {
    const temp = tempDir();
    const win = fakeWindows({
      dacl: INHERITED,
      below: {
        "C:\\cashu": [
          { name: "run", kind: "dir" },
          { name: "elsewhere", kind: "link" },
        ],
        "C:\\cashu\\run": [{ name: "host.token", kind: "file" }],
        "C:\\cashu\\elsewhere": [{ name: "not-ours", kind: "file" }],
      },
    });
    makeOwnerOnly(DIR, on(win, temp));
    expect(win.calls).toEqual([
      WHOAMI_CALL,
      OWNER_CALL,
      saveCall(temp),
      { file: ICACLS, args: ["C:\\cashu\\run", "/reset", "/q"] },
      { file: ICACLS, args: ["C:\\cashu\\run\\host.token", "/reset", "/q"] },
      GRANT_CALL,
      saveCall(temp),
    ]);
    expect(win.listed).toEqual([DIR, "C:\\cashu\\run"]);
  });

  it("removes an explicit Administrators entry that /grant:r leaves (the CI runner's %TEMP%)", () => {
    const temp = tempDir();
    const win = fakeWindows({
      dacl: `D:AI(A;OICI;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${SID})`,
    });
    makeOwnerOnly(DIR, on(win, temp));
    expect(win.calls).toEqual([
      WHOAMI_CALL,
      OWNER_CALL,
      saveCall(temp),
      GRANT_CALL,
      removeCall("/remove", ADMINISTRATORS_SID),
      saveCall(temp),
    ]);
    expect(win.dacl()).toBe(OWNER_ONLY);
  });

  it("removes deny entries: another account's with all its entries, the user's own as denies", () => {
    const temp = tempDir();
    const win = fakeWindows({ dacl: `${OWNER_ONLY}(D;OICI;FA;;;WD)(D;;WD;;;${SID})` });
    makeOwnerOnly(DIR, on(win, temp));
    expect(win.calls).toEqual([
      WHOAMI_CALL,
      OWNER_CALL,
      saveCall(temp),
      GRANT_CALL,
      removeCall("/remove", "S-1-1-0"),
      removeCall("/remove:d", SID),
      saveCall(temp),
    ]);
    expect(win.dacl()).toBe(OWNER_ONLY);
  });

  it("names explicit entries given by SDDL aliases by their SIDs; inherited ones go with /inheritance:r", () => {
    const temp = tempDir();
    const logon = "S-1-5-5-0-4242";
    const win = fakeWindows({
      dacl: `D:AI(A;OICIIO;FA;;;CO)(A;;0x1301bf;;;OW)(A;OICI;0x1200a9;;;BU)(A;;FA;;;${logon})(A;OICIID;FA;;;AU)(A;OICIID;FA;;;SY)`,
    });
    makeOwnerOnly(DIR, on(win, temp));
    expect(win.calls).toEqual([
      WHOAMI_CALL,
      OWNER_CALL,
      saveCall(temp),
      GRANT_CALL,
      removeCall("/remove", "S-1-3-0", "S-1-3-4", "S-1-5-32-545", logon),
      saveCall(temp),
    ]);
    expect(win.dacl()).toBe(OWNER_ONLY);
  });

  it("refuses before any change when another account's entry has no SID to name it by", () => {
    const temp = tempDir();
    const win = fakeWindows({
      dacl: `D:AI(A;OICI;FA;;;DA)(A;OICI;FA;;;LA)(A;OICIID;FA;;;SY)`,
      below: TREE,
    });
    expect(failure(() => makeOwnerOnly(DIR, on(win, temp)))).toBe(
      "C:\\cashu could not be made private to this user: other accounts hold entries icacls cannot be given by SID (DA, LA); remove them, then start again",
    );
    expect(win.calls).toEqual([WHOAMI_CALL, OWNER_CALL, saveCall(temp)]);
  });

  it("fails closed naming every SID left over after the change", () => {
    const win = fakeWindows({
      dacl: `D:AI(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;S-1-5-21-9-9-9-1002)(D;;FA;;;S-1-5-18)`,
      stubborn: true,
    });
    expect(failure(() => makeOwnerOnly(DIR, on(win)))).toBe(
      "C:\\cashu could not be made private to this user: its access list is still not private after the change: other accounts keep access (S-1-5-32-544, S-1-5-21-9-9-9-1002); deny entries remain (S-1-5-18)",
    );
  });

  it("fails closed, naming the dir, when icacls cannot reset, set or remove", () => {
    const reset = fakeWindows({ dacl: INHERITED, below: TREE, resetStatus: 5 });
    expect(failure(() => makeOwnerOnly(DIR, on(reset)))).toBe(
      "C:\\cashu could not be made private to this user: icacls could not reset the access lists of the entries inside it",
    );
    // The dir stays as it was, so the next start runs the whole step again.
    expect(reset.calls.at(-1)).toEqual(RESET_ALL_CALL);
    expect(reset.dacl()).toBe(INHERITED);
    const grant = fakeWindows({ dacl: INHERITED, grantStatus: 5 });
    expect(failure(() => makeOwnerOnly(DIR, on(grant)))).toBe(
      "C:\\cashu could not be made private to this user: icacls could not set its access list",
    );
    const remove = fakeWindows({ dacl: `D:AI(A;OICI;FA;;;BA)`, removeStatus: 5 });
    expect(failure(() => makeOwnerOnly(DIR, on(remove)))).toBe(
      "C:\\cashu could not be made private to this user: icacls could not remove the entries of S-1-5-32-544",
    );
  });

  it("fails closed before any change when the entries below cannot be listed", () => {
    const win = fakeWindows({ dacl: INHERITED });
    const list = () => {
      throw new Error("EACCES");
    };
    expect(failure(() => makeOwnerOnly(DIR, { ...on(win), list }))).toBe(
      "C:\\cashu could not be made private to this user: the entries inside it could not be listed",
    );
    expect(win.calls.some((call) => call.args[1] !== "/save" && call.file === ICACLS)).toBe(false);
  });

  it("falls back to windir when SystemRoot is unset", () => {
    const win = fakeWindows({ dacl: OWNER_ONLY });
    makeOwnerOnly(DIR, { ...on(win), env: { windir: "C:\\Windows" } });
    expect(win.calls[0]).toEqual(WHOAMI_CALL);
  });

  it("fails closed without a SID, a SystemRoot, or for a drive or share root", () => {
    const noSid = fakeWindows({ dacl: INHERITED, whoami: { status: 1, stdout: "" } });
    expect(failure(() => makeOwnerOnly(DIR, on(noSid)))).toBe(
      "C:\\cashu could not be made private to this user: the user's SID is unreadable (whoami)",
    );
    const noRoot = fakeWindows({ dacl: INHERITED });
    expect(failure(() => makeOwnerOnly(DIR, { ...on(noRoot), env: {} }))).toBe(
      "C:\\cashu could not be made private to this user: SystemRoot is not set",
    );
    expect(noRoot.calls).toEqual([]);
    for (const root of ["C:\\", "\\\\server\\share\\", "relative\\dir"]) {
      const win = fakeWindows({ dacl: INHERITED });
      expect(failure(() => makeOwnerOnly(root, on(win)))).toBe(
        `${root} could not be made private to this user: a drive or share root is never a data dir`,
      );
      expect(win.calls).toEqual([]);
    }
  });

  it("refuses a dir another account owns before touching its DACL, even an owner-only one", () => {
    const other = "S-1-5-21-1111111111-2222222222-3333333333-1002";
    for (const dacl of [INHERITED, OWNER_ONLY]) {
      const win = fakeWindows({ dacl, owner: other });
      expect(failure(() => makeOwnerOnly(DIR, on(win)))).toBe(
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
      expect(failure(() => makeOwnerOnly(DIR, on(win)))).toContain(
        `it is owned by another account (${shown})`,
      );
    }
  });

  it("accepts the Administrators group as owner only while elevated", () => {
    const temp = tempDir();
    const elevated = fakeWindows({
      dacl: OWNER_ONLY,
      owner: "BA",
      groups: { status: 0, stdout: groups(12288) },
    });
    makeOwnerOnly(DIR, on(elevated, temp));
    expect(elevated.calls).toEqual([WHOAMI_CALL, OWNER_CALL, GROUPS_CALL, saveCall(temp)]);
    for (const answer of [
      { status: 0, stdout: groups(8192) },
      { status: 0, stdout: "" },
      { status: 1, stdout: groups(12288) },
    ]) {
      const win = fakeWindows({ dacl: OWNER_ONLY, owner: "BA", groups: answer });
      expect(failure(() => makeOwnerOnly(DIR, on(win)))).toBe(
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
    makeOwnerOnly(DIR, on(win));
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
      expect(failure(() => makeOwnerOnly(DIR, on(win)))).toBe(
        "C:\\cashu could not be made private to this user: its owner is unreadable (Get-Acl)",
      );
    }
  });

  it("quotes the dir for PowerShell, typographic single quotes included", () => {
    const dir = "C:\\Users\\O'Brien\\it\u2019s $(calc) `x` [1]\\cashu";
    const win = fakeWindows({ dacl: OWNER_ONLY });
    makeOwnerOnly(dir, on(win));
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
    expect(
      failure(() => makeOwnerOnly(DIR, { env: ENV, run, list: () => [], tempDir: tempDir() })),
    ).toBe("C:\\cashu could not be made private to this user: its access list is unreadable");
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
        { type: "A", flags: "OICI", rights: "FA", trustee: SYSTEM_SID },
        { type: "A", flags: "OICI", rights: "FA", trustee: SID },
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
    expect(owner(OWNER_ONLY.replace(/FA/g, "0x1f01ff"))).toBe(true);
    // Exact: no deny entry either (one for Everyone would lock the user out too).
    expect(owner(`${OWNER_ONLY}(D;OICI;FA;;;WD)`)).toBe(false);
    expect(owner(`${OWNER_ONLY}(D;OICI;FA;;;S-1-5-21-9-9-9-1002)`)).toBe(false);
    // Full control, not a narrower grant.
    expect(owner(`D:PAI(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;${SID})`)).toBe(false);
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

  it("maps the machine-independent SDDL aliases to SIDs and keeps the relative ones", () => {
    expect(sddlTrusteeSid("BA")).toBe(ADMINISTRATORS_SID);
    expect(sddlTrusteeSid("CO")).toBe("S-1-3-0");
    expect(sddlTrusteeSid("OW")).toBe("S-1-3-4");
    expect(sddlTrusteeSid("WD")).toBe("S-1-1-0");
    expect(sddlTrusteeSid("au")).toBe("S-1-5-11");
    expect(sddlTrusteeSid("LA")).toBe("LA");
    expect(sddlTrusteeSid("DA")).toBe("DA");
    expect(sddlTrusteeSid(SID.toLowerCase())).toBe(SID);
    const dacl = parseSavedDacl(listing("D:AI(A;OICIIO;GA;;;CO)(A;OICIID;0x1301bf;;;AU)"));
    expect(dacl?.aces.map((ace) => [ace.trustee, ace.rights])).toEqual([
      ["S-1-3-0", "GA"],
      ["S-1-5-11", "0X1301BF"],
    ]);
  });

  it("describes what keeps a DACL from owner-only, by SIDs", () => {
    const problems = (sddl: string) => {
      const dacl = parseSavedDacl(listing(sddl));
      return dacl === undefined ? ["unparsed"] : daclProblems(dacl, SID);
    };
    expect(problems(OWNER_ONLY)).toEqual([]);
    expect(problems(INHERITED)).toEqual([
      "it still inherits its parent's access list",
      "other accounts keep access (S-1-5-32-544, S-1-5-11)",
      `no full control inherited below for ${SID}`,
    ]);
    expect(problems(`D:PAI(A;OICI;FA;;;SY)(A;OICIIO;FA;;;${SID})(D;;FA;;;WD)(A;;FA;;;OW)`)).toEqual(
      [
        "other accounts keep access (S-1-3-4)",
        "deny entries remain (S-1-1-0)",
        `no full control inherited below for ${SID}`,
      ],
    );
    expect(problems(`D:PAI(A;OICI;FA;;;${SID})`)).toEqual([
      "no full control inherited below for S-1-5-18",
    ]);
  });
});
