// The owner-only ACL of a data dir on Windows. POSIX modes do not exist there (`privateFs.ts`), and a
// data dir outside %LOCALAPPDATA% (CASHU_DATA_DIR=C:\cashu, a second drive) inherits its parent's
// ACL, which commonly grants "Authenticated Users: Modify": another local user could read
// run\host.token, point host.json at their own pipe, or replace vault files. So the host makes the
// data dir private when it takes it over (`startHost`, once per start, before the run dir, the token
// or anything else is written): a protected DACL (inheritance from the parent removed) with full
// control for this user's SID and SYSTEM (S-1-5-18) only, both inherited by every file and folder
// below ((OI)(CI)); the change propagates to the entries already there. A default data dir under
// %LOCALAPPDATA% gets the same DACL (it only narrows what that folder already grants).
//
// The DACL alone is not enough: the owner of an object can always read and rewrite its DACL. A data
// dir another local account created first (CASHU_DATA_DIR on a shared drive, pre-created before this
// user's first start) would stay theirs, so they could grant themselves access again at any time.
// So before the DACL step the host checks the data dir's owner, also once per start: it must be this
// user's SID. The one other owner accepted is the Administrators group (S-1-5-32-544), and only while
// this process runs elevated: an elevated administrator's token makes that group the owner of what it
// creates, so the first elevated start would otherwise refuse the data dir it just made; and its
// members can take ownership of any object anyway, so it grants nothing an elevated administrator does
// not already hold. Any other owner refuses (the user takes ownership, then starts again). The owner
// is never changed here. Residual: entries another account created inside the dir before its DACL was
// private keep their owner; only the dir itself is checked.
//
// Everything runs through the system's own tools by absolute path (never a PATH lookup) and reads only
// locale-independent output: the SID from `whoami /user /fo csv /nh`, the integrity level from
// `whoami /groups /fo csv /nh` (only for an Administrators-owned dir), the DACL as SDDL from
// `icacls <dir> /save`, and the owner as SDDL from PowerShell's `(Get-Acl -LiteralPath '<dir>').Sddl`
// (`icacls /save` lists the DACL only; the Sddl property needs no .NET type literal, so it also works
// in PowerShell's ConstrainedLanguage mode). A DACL that is already owner-only is left alone (no
// rewrite, no propagation walk), so the step is idempotent and cheap on every later start. Fail
// closed: when the owner is unreadable or another account, when the DACL cannot be set, or other
// accounts keep access afterwards (an explicit entry `/grant:r` does not replace), the host does not
// run on the data dir (`HostPathError` naming it).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { winIsAbsolute } from "../windowsPath.js";
import { HostPathError } from "./paths.js";

/** The local SYSTEM account. */
export const SYSTEM_SID = "S-1-5-18";
/** The local Administrators group (BUILTIN\Administrators, SDDL `BA`). */
export const ADMINISTRATORS_SID = "S-1-5-32-544";
/** The high mandatory integrity level: an elevated token (system level is above it). */
const HIGH_INTEGRITY_RID = 12288;

/** A finished system command: its exit status (null when it was killed) and stdout. */
export interface AclCommandResult {
  readonly status: number | null;
  /** stdout as bytes read one to one (latin1): only ASCII (a SID) is ever read from it. */
  readonly stdout: string;
}

/** Runs `file` (an absolute path) with `args`, without a shell. Injected in tests. */
export type AclCommandRunner = (file: string, args: readonly string[]) => AclCommandResult;

export interface OwnerOnlyOptions {
  /** The environment `SystemRoot` is read from (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: AclCommandRunner;
  /** Where `icacls /save` writes its listing (default `os.tmpdir()`, the per-user temp dir). */
  readonly tempDir?: string;
}

const COMMAND_TIMEOUT_MS = 30_000;

const runSystemCommand: AclCommandRunner = (file, args) => {
  const result = spawnSync(file, [...args], {
    shell: false,
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: result.status, stdout: result.stdout?.toString("latin1") ?? "" };
};

const SID = /^S-1-\d+(?:-\d+)+$/;

/** The SID in `whoami /user /fo csv /nh` output: the last field of `"<domain>\<user>","<SID>"`. */
export function parseWhoamiSid(stdout: string): string | undefined {
  const match = /"(S-1-[0-9-]+)"\s*$/.exec(stdout.trim());
  const sid = match?.[1];
  return sid !== undefined && SID.test(sid) ? sid : undefined;
}

/**
 * The highest mandatory integrity level (`S-1-16-<rid>`) in `whoami /groups /fo csv /nh` output, or
 * undefined when none is listed. Only SIDs are read; group names and attributes are localized.
 */
export function parseIntegrityLevel(stdout: string): number | undefined {
  const levels = [...stdout.matchAll(/"S-1-16-(\d+)"/g)].map(([, rid = ""]) => Number(rid));
  return levels.length === 0 ? undefined : Math.max(...levels);
}

/** SDDL abbreviations a data dir owner can carry that this file compares by SID. */
const OWNER_ABBREVIATIONS: Readonly<Record<string, string>> = {
  BA: ADMINISTRATORS_SID,
  SY: SYSTEM_SID,
};

/**
 * The owner in a security descriptor's SDDL (`O:<sid>G:...D:...`), as a SID, or as the SDDL
 * abbreviation when it is not one of `OWNER_ABBREVIATIONS` (`LA`, the built-in Administrator, is
 * matched by `isTrustee`). Undefined when the text does not start with an owner.
 */
export function parseSddlOwner(sddl: string): string | undefined {
  const match = /^O:(S-1-\d+(?:-\d+)+|[A-Z]{2})(?=[GDS]:|$)/.exec(sddl.trim());
  const owner = match?.[1];
  if (owner === undefined) return undefined;
  return OWNER_ABBREVIATIONS[owner] ?? owner;
}

/**
 * `text` as a PowerShell single-quoted string literal. Inside one only a single quote is special, and
 * PowerShell takes the typographic ones (U+2018 to U+201B) for it too: each is doubled.
 */
export function powerShellQuoted(text: string): string {
  return `'${text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/** One access entry of an SDDL DACL. */
interface Ace {
  readonly type: string;
  readonly flags: string;
  /** A SID, with the well-known SDDL abbreviations used here expanded (`SY`). */
  readonly trustee: string;
}

/** A DACL as `icacls /save` lists it. */
export interface Dacl {
  /** The DACL control flags (`P` protected, `AI` auto-inherited, ...). */
  readonly control: string;
  readonly aces: readonly Ace[];
}

const DACL_LINE = /^D:([A-Z]*)((?:\([^()]*\))*)(?:S:.*)?$/;

/**
 * The DACL in an `icacls /save` listing (the object's name on one line, its SDDL on the next; UTF-16LE
 * as icacls writes it, UTF-8 accepted). Undefined unless exactly one well-formed DACL is listed.
 */
export function parseSavedDacl(bytes: Buffer): Dacl | undefined {
  const utf16 =
    (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes.length >= 2 && bytes[1] === 0x00);
  const text = bytes.toString(utf16 ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
  const dacls = text
    .split(/\r?\n/)
    .map((line) => DACL_LINE.exec(line.trim()))
    .filter((match) => match !== null);
  if (dacls.length !== 1) return undefined;
  const [, control = "", body = ""] = dacls[0] as RegExpExecArray;
  const aces: Ace[] = [];
  for (const [, ace = ""] of body.matchAll(/\(([^()]*)\)/g)) {
    const fields = ace.split(";");
    if (fields.length < 6) return undefined;
    const [type = "", flags = "", , , , trustee = ""] = fields;
    aces.push({ type, flags, trustee: trustee === "SY" ? SYSTEM_SID : trustee.toUpperCase() });
  }
  return { control, aces };
}

const DENY_TYPES = new Set(["D", "OD", "XD"]);

/** The two-letter SDDL tokens of an ACE's flags (`OICI` -> OI, CI; never a token across a pair). */
const flagTokens = (flags: string) => new Set(flags.match(/[A-Z]{2}/g) ?? []);

/**
 * Whether `trustee` (from SDDL) is `sid`. SDDL abbreviates one user account: `LA`, the machine's
 * built-in Administrator (`S-1-5-21-<machine>-500`).
 */
const isTrustee = (trustee: string, sid: string) =>
  trustee === sid || (trustee === "LA" && /^S-1-5-21-(?:\d+-){3}500$/.test(sid));

/**
 * Whether `dacl` is the owner-only DACL of the header: protected, every entry that grants anything is
 * `userSid`'s or SYSTEM's, and both hold one that this folder and everything below it inherits.
 */
export function isOwnerOnlyDacl(dacl: Dacl, userSid: string): boolean {
  const owners = [userSid.toUpperCase(), SYSTEM_SID];
  const grants = dacl.aces.filter((ace) => !DENY_TYPES.has(ace.type));
  const inheritedGrant = (sid: string) =>
    grants.some((ace) => {
      const flags = flagTokens(ace.flags);
      return (
        isTrustee(ace.trustee, sid) &&
        ace.type === "A" &&
        flags.has("OI") &&
        flags.has("CI") &&
        !flags.has("IO")
      );
    });
  return (
    dacl.control.includes("P") &&
    grants.every((ace) => owners.some((sid) => isTrustee(ace.trustee, sid))) &&
    owners.every(inheritedGrant)
  );
}

/** `%SystemRoot%\System32`, from an absolute SystemRoot (windir as the fallback). */
function system32(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const root = (env.SystemRoot ?? env.windir ?? "").trim();
  return winIsAbsolute(root) ? win32.join(root, "System32") : undefined;
}

/** This process's user SID (`whoami`), locale-independent; undefined when it cannot be read. */
function currentUserSid(run: AclCommandRunner, sys32: string): string | undefined {
  const result = run(win32.join(sys32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  return result.status === 0 ? parseWhoamiSid(result.stdout) : undefined;
}

/** The owner SID of `dir` (PowerShell `Get-Acl`, see the header), undefined when it is unreadable. */
function ownerOf(dir: string, run: AclCommandRunner, sys32: string): string | undefined {
  const result = run(win32.join(sys32, "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Acl -LiteralPath ${powerShellQuoted(dir)}).Sddl`,
  ]);
  return result.status === 0 ? parseSddlOwner(result.stdout) : undefined;
}

/** Whether this process runs elevated (high integrity or above, `whoami /groups`). */
function isElevated(run: AclCommandRunner, sys32: string): boolean {
  const result = run(win32.join(sys32, "whoami.exe"), ["/groups", "/fo", "csv", "/nh"]);
  const level = result.status === 0 ? parseIntegrityLevel(result.stdout) : undefined;
  return level !== undefined && level >= HIGH_INTEGRITY_RID;
}

/** The DACL of `dir` (`icacls /save` into a fresh temp folder), undefined when it is unreadable. */
function readDacl(
  dir: string,
  icacls: string,
  run: AclCommandRunner,
  tempDir: string,
): Dacl | undefined {
  let work: string | undefined;
  try {
    work = mkdtempSync(join(tempDir, "cashu-acl-"));
    const listing = join(work, "acl");
    if (run(icacls, [dir, "/save", listing, "/q"]).status !== 0) return undefined;
    return parseSavedDacl(readFileSync(listing));
  } catch {
    return undefined;
  } finally {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Makes the existing directory `dir` (an absolute, resolved Windows path) private to this user (see
 * the header). Throws `HostPathError` naming `dir` when it is a drive or share root, owned by another
 * account, or cannot be made private.
 */
export function makeOwnerOnly(dir: string, options: OwnerOnlyOptions = {}): void {
  const run = options.run ?? runSystemCommand;
  const tempDir = options.tempDir ?? tmpdir();
  const refuse = (why: string): never => {
    throw new HostPathError(`${dir} could not be made private to this user: ${why}`);
  };
  if (!winIsAbsolute(dir) || win32.parse(dir).root === win32.normalize(dir)) {
    refuse("a drive or share root is never a data dir");
  }
  const sys32 = system32(options.env ?? process.env) ?? refuse("SystemRoot is not set");
  const sid = currentUserSid(run, sys32) ?? refuse("the user's SID is unreadable (whoami)");
  const owner = ownerOf(dir, run, sys32) ?? refuse("its owner is unreadable (Get-Acl)");
  const ownOwner =
    isTrustee(owner, sid) || (owner === ADMINISTRATORS_SID && isElevated(run, sys32));
  if (!ownOwner)
    refuse(
      `it is owned by another account (${owner}); take ownership as this user, then start again`,
    );
  const icacls = win32.join(sys32, "icacls.exe");
  const before = readDacl(dir, icacls, run, tempDir);
  if (before !== undefined && isOwnerOnlyDacl(before, sid)) return;
  const applied = run(icacls, [
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    `*${SYSTEM_SID}:(OI)(CI)F`,
    "/q",
  ]);
  if (applied.status !== 0) refuse("icacls could not set its access list");
  const after = readDacl(dir, icacls, run, tempDir) ?? refuse("its access list is unreadable");
  if (!isOwnerOnlyDacl(after, sid))
    refuse("other accounts keep access (remove them, then start again)");
}
