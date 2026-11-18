// The owner-only ACL of a data dir on Windows. POSIX modes do not exist there (`privateFs.ts`), and a
// data dir outside %LOCALAPPDATA% (CASHU_DATA_DIR=C:\cashu, a second drive) inherits its parent's
// ACL, which commonly grants "Authenticated Users: Modify": another local user could read
// run\host.token, point host.json at their own pipe, or replace vault files. So the host makes the
// data dir private when it takes it over (`startHost`, once per start, before the run dir, the token
// or anything else is written): a protected DACL (inheritance from the parent removed) holding exactly
// two entries, full control for this user's SID and SYSTEM (S-1-5-18), both inherited by every file
// and folder below ((OI)(CI)). A default data dir under %LOCALAPPDATA% gets the same DACL (it only
// narrows what that folder already grants).
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
// Making the DACL exact. `icacls /inheritance:r` drops only inherited entries and `/grant:r` replaces
// only the two named SIDs' grants, so an explicit entry of any other account survives both: a folder
// created where its parent passes nothing down gets the creating token's default DACL as explicit
// entries (an elevated token's names BUILTIN\Administrators), and anyone may have added one. So the
// current DACL is read first (`icacls /save`, SDDL), and every explicit entry of another account is
// removed by SID (`/remove *<SID>`, its grants and denies alike), as is every deny entry of this user
// or SYSTEM (`/remove:d`, a deny would lock them out). SDDL names well-known accounts by aliases (BA,
// AU, CO, OW, WD, ...); the machine-independent ones are mapped to their SIDs here. An entry known only
// by a domain- or machine-relative alias (LA of another account, DA, ...) cannot be named to icacls:
// the host refuses before changing anything and names the alias. A single exact write (`icacls
// /restore` of a crafted SDDL listing, or Set-Acl) was weighed and not taken: /restore resolves entries
// by name relative to the parent and its propagation is undocumented, and Set-Acl needs .NET calls that
// PowerShell's ConstrainedLanguage mode may refuse; /remove and /grant:r are documented icacls verbs
// working by SID.
//
// Entries already below the dir (a data dir that had content before it became private) keep any
// explicit entries of their own, which the dir's new DACL does not replace, and Windows lets every
// account reach a file by its full path without traverse rights on the folders above it. So when the
// dir's DACL needs a change, everything below it is reset to inherit only (`icacls /reset`) first,
// before the dir's DACL is narrowed; the narrowing then propagates to all of it. That order keeps a
// failure retryable: the dir stays non-private, so the next start runs the whole step again. The reset
// never goes through a link: the tree is walked here first (lstat, which reports symlinks and junctions
// as links), and when it holds no link one `icacls <dir>\* /reset /t` covers it; when it holds one,
// each entry outside a link is reset on its own (slower, and rare), and the links themselves are left
// as they are (a link's own ACL guards only the link).
//
// Everything runs through the system's own tools by absolute path (never a PATH lookup) and reads only
// locale-independent output: the SID from `whoami /user /fo csv /nh`, the integrity level from
// `whoami /groups /fo csv /nh` (only for an Administrators-owned dir), the DACL as SDDL from
// `icacls <dir> /save`, and the owner as SDDL from PowerShell's `(Get-Acl -LiteralPath '<dir>').Sddl`
// (`icacls /save` lists the DACL only; the Sddl property needs no .NET type literal, so it also works
// in PowerShell's ConstrainedLanguage mode). A DACL that is already exactly owner-only is left alone
// (no rewrite, no walk, no propagation), so the step is idempotent and cheap on every later start.
// The three reads (SID, owner, DACL) are independent and run at once, so a start waits for the slowest
// of them (PowerShell, about a quarter of a second) rather than for all three in turn; nothing is
// decided or changed before every one has answered, and the checks keep their order.
//
// Why the owner is read at every start and never cached, nor skipped when the DACL is already exact:
// an exact DACL says nothing about the owner. Another account can create the dir, give it this exact
// DACL and keep its owner's implicit right to rewrite it; and an owner can change between two starts
// (anyone this user's DACL once let in with take-ownership rights can make themselves owner, then put
// the exact DACL back). A cached "verified" record keyed by the dir's file id and DACL would trust
// both, so only reading the owner catches them, and of the system tools used here only PowerShell
// reports it by SID (`icacls /save` lists the DACL alone).
//
// Fail closed: when the owner is unreadable or another account, when an entry cannot be named, reset
// or removed, or the DACL read back afterwards is not exactly owner-only, the host does not run on the
// data dir (`HostPathError` naming it and every SID or alias left over, never file contents).
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
export type AclCommandRunner = (file: string, args: readonly string[]) => Promise<AclCommandResult>;

/** One entry of a directory listing: a link (symlink or junction) is never followed. */
export interface AclDirEntry {
  readonly name: string;
  readonly kind: "dir" | "file" | "link";
}

/** Lists the entries of the directory `dir`; throws when it cannot. Injected in tests. */
type AclDirLister = (dir: string) => readonly AclDirEntry[];

export interface OwnerOnlyOptions {
  /** The environment `SystemRoot` is read from (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: AclCommandRunner;
  /** Where `icacls /save` writes its listing (default `os.tmpdir()`, the per-user temp dir). */
  readonly tempDir?: string;
  /** Lists a directory below the data dir (default: the file system, by lstat). */
  readonly list?: AclDirLister;
}

const COMMAND_TIMEOUT_MS = 30_000;

/** A command that cannot be started, or is killed at the timeout, has status null. */
const runSystemCommand: AclCommandRunner = (file, args) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => resolve({ status: null, stdout: "" }));
    child.once("close", (status) =>
      resolve({ status, stdout: Buffer.concat(chunks).toString("latin1") }),
    );
  });

/** lstat per entry: Node reports a Windows symlink and a junction alike as a symbolic link. */
const listDirectory: AclDirLister = (dir) =>
  readdirSync(dir).map((name) => {
    const stat = lstatSync(join(dir, name));
    const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file";
    return { name, kind };
  });

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

/**
 * The SDDL aliases of well-known SIDs that are the same on every machine (Microsoft's "SID strings"
 * table). The domain- and machine-relative ones (LA, LG, DA, DU, ...) have no fixed SID and are left
 * as aliases.
 */
const SDDL_ALIASES: Readonly<Record<string, string>> = {
  AA: "S-1-5-32-579",
  AC: "S-1-15-2-1",
  AN: "S-1-5-7",
  AO: "S-1-5-32-548",
  AS: "S-1-18-1",
  AU: "S-1-5-11",
  BA: ADMINISTRATORS_SID,
  BG: "S-1-5-32-546",
  BO: "S-1-5-32-551",
  BU: "S-1-5-32-545",
  CD: "S-1-5-32-574",
  CG: "S-1-3-1",
  CO: "S-1-3-0",
  CY: "S-1-5-32-569",
  ED: "S-1-5-9",
  ER: "S-1-5-32-573",
  ES: "S-1-5-32-576",
  HA: "S-1-5-32-578",
  IS: "S-1-5-32-568",
  IU: "S-1-5-4",
  LS: "S-1-5-19",
  LU: "S-1-5-32-559",
  MS: "S-1-5-32-577",
  MU: "S-1-5-32-558",
  NO: "S-1-5-32-556",
  NS: "S-1-5-20",
  NU: "S-1-5-2",
  OW: "S-1-3-4",
  PO: "S-1-5-32-550",
  PS: "S-1-5-10",
  PU: "S-1-5-32-547",
  RA: "S-1-5-32-575",
  RC: "S-1-5-12",
  RD: "S-1-5-32-555",
  RE: "S-1-5-32-552",
  RM: "S-1-5-32-580",
  RU: "S-1-5-32-554",
  SO: "S-1-5-32-549",
  SS: "S-1-18-2",
  SU: "S-1-5-6",
  SY: SYSTEM_SID,
  UD: "S-1-5-84-0-0-0-0-0",
  WD: "S-1-1-0",
  WR: "S-1-5-33",
};

/** An SDDL trustee as a SID (upper case), or as its alias when it has no machine-independent SID. */
export function sddlTrusteeSid(trustee: string): string {
  const upper = trustee.toUpperCase();
  return SDDL_ALIASES[upper] ?? upper;
}

/**
 * The owner in a security descriptor's SDDL (`O:<sid>G:...D:...`), as a SID, or as the SDDL alias
 * when it has no machine-independent SID (`LA`, the built-in Administrator, is matched by
 * `isTrustee`). Undefined when the text does not start with an owner.
 */
export function parseSddlOwner(sddl: string): string | undefined {
  const match = /^O:(S-1-\d+(?:-\d+)+|[A-Z]{2})(?=[GDS]:|$)/.exec(sddl.trim());
  const owner = match?.[1];
  return owner === undefined ? undefined : sddlTrusteeSid(owner);
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
  /** The access mask as SDDL writes it (`FA`, `0x1200a9`, ...), upper case. */
  readonly rights: string;
  /** A SID, or an alias without a machine-independent SID (`sddlTrusteeSid`). */
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
    const [type = "", flags = "", rights = "", , , trustee = ""] = fields;
    aces.push({ type, flags, rights: rights.toUpperCase(), trustee: sddlTrusteeSid(trustee) });
  }
  return { control, aces };
}

const DENY_TYPES = new Set(["D", "OD", "XD"]);
/** Full control as icacls grants `F`: FILE_ALL_ACCESS, in SDDL `FA` (or its mask). */
const FULL_CONTROL = new Set(["FA", "0X1F01FF"]);

/** The two-letter SDDL tokens of an ACE's flags (`OICI` -> OI, CI; never a token across a pair). */
const flagTokens = (flags: string) => new Set(flags.match(/[A-Z]{2}/g) ?? []);

/** Whether `ace` was inherited from the parent (not one of the object's own entries). */
const isInherited = (ace: Ace) => flagTokens(ace.flags).has("ID");

/**
 * Whether `trustee` (from SDDL) is `sid`. SDDL abbreviates one user account: `LA`, the machine's
 * built-in Administrator (`S-1-5-21-<machine>-500`).
 */
const isTrustee = (trustee: string, sid: string) =>
  trustee === sid || (trustee === "LA" && /^S-1-5-21-(?:\d+-){3}500$/.test(sid));

/** Whether `trustee` is this user (`userSid`, upper case) or SYSTEM. */
const isOwnTrustee = (trustee: string, userSid: string) =>
  isTrustee(trustee, userSid) || trustee === SYSTEM_SID;

const unique = (values: readonly string[]) => [...new Set(values)];

/**
 * What keeps `dacl` from the owner-only DACL of the header, as short phrases naming SIDs (empty when
 * it is exactly that): it must be protected, hold no entry of another account and no deny entry, and
 * give `userSid` and SYSTEM full control on the folder and everything below it.
 */
export function daclProblems(dacl: Dacl, userSid: string): string[] {
  const sid = userSid.toUpperCase();
  const problems: string[] = [];
  if (!dacl.control.includes("P")) problems.push("it still inherits its parent's access list");
  const others = unique(
    dacl.aces
      .filter((ace) => !DENY_TYPES.has(ace.type) && !isOwnTrustee(ace.trustee, sid))
      .map((ace) => ace.trustee),
  );
  if (others.length > 0) problems.push(`other accounts keep access (${others.join(", ")})`);
  const denied = unique(
    dacl.aces.filter((ace) => DENY_TYPES.has(ace.type)).map((ace) => ace.trustee),
  );
  if (denied.length > 0) problems.push(`deny entries remain (${denied.join(", ")})`);
  const fullBelow = (owner: string) =>
    dacl.aces.some((ace) => {
      const flags = flagTokens(ace.flags);
      return (
        ace.type === "A" &&
        isTrustee(ace.trustee, owner) &&
        FULL_CONTROL.has(ace.rights) &&
        flags.has("OI") &&
        flags.has("CI") &&
        !flags.has("IO")
      );
    });
  const lacking = [sid, SYSTEM_SID].filter((owner) => !fullBelow(owner));
  if (lacking.length > 0)
    problems.push(`no full control inherited below for ${lacking.join(", ")}`);
  return problems;
}

/** Whether `dacl` is exactly the owner-only DACL of the header (`daclProblems` finds nothing). */
export function isOwnerOnlyDacl(dacl: Dacl, userSid: string): boolean {
  return daclProblems(dacl, userSid).length === 0;
}

/** The explicit entries `/inheritance:r` and `/grant:r` leave behind, by what removes them. */
interface Leftovers {
  /** SIDs of other accounts with an explicit entry: `/remove` (grants and denies). */
  readonly others: readonly string[];
  /** This user's and SYSTEM's SIDs with an explicit deny entry: `/remove:d`. */
  readonly ownDenies: readonly string[];
  /** Aliases of other accounts with no machine-independent SID: nothing can name them to icacls. */
  readonly unnamed: readonly string[];
}

function leftoversOf(dacl: Dacl | undefined, userSid: string): Leftovers {
  const sid = userSid.toUpperCase();
  const explicit = (dacl?.aces ?? []).filter((ace) => !isInherited(ace));
  const foreign = unique(
    explicit.filter((ace) => !isOwnTrustee(ace.trustee, sid)).map((ace) => ace.trustee),
  );
  const ownDenies = unique(
    explicit
      .filter((ace) => DENY_TYPES.has(ace.type) && isOwnTrustee(ace.trustee, sid))
      .map((ace) => (ace.trustee === SYSTEM_SID ? SYSTEM_SID : userSid)),
  );
  return {
    others: foreign.filter((trustee) => SID.test(trustee)),
    ownDenies,
    unnamed: foreign.filter((trustee) => !SID.test(trustee)),
  };
}

/** `%SystemRoot%\System32`, from an absolute SystemRoot (windir as the fallback). */
function system32(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const root = (env.SystemRoot ?? env.windir ?? "").trim();
  return winIsAbsolute(root) ? win32.join(root, "System32") : undefined;
}

/** This process's user SID (`whoami`), locale-independent; undefined when it cannot be read. */
async function currentUserSid(run: AclCommandRunner, sys32: string): Promise<string | undefined> {
  const result = await run(win32.join(sys32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  return result.status === 0 ? parseWhoamiSid(result.stdout) : undefined;
}

/** The owner SID of `dir` (PowerShell `Get-Acl`, see the header), undefined when it is unreadable. */
async function ownerOf(
  dir: string,
  run: AclCommandRunner,
  sys32: string,
): Promise<string | undefined> {
  const result = await run(win32.join(sys32, "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Acl -LiteralPath ${powerShellQuoted(dir)}).Sddl`,
  ]);
  return result.status === 0 ? parseSddlOwner(result.stdout) : undefined;
}

/** Whether this process runs elevated (high integrity or above, `whoami /groups`). */
async function isElevated(run: AclCommandRunner, sys32: string): Promise<boolean> {
  const result = await run(win32.join(sys32, "whoami.exe"), ["/groups", "/fo", "csv", "/nh"]);
  const level = result.status === 0 ? parseIntegrityLevel(result.stdout) : undefined;
  return level !== undefined && level >= HIGH_INTEGRITY_RID;
}

/** The DACL of `dir` (`icacls /save` into a fresh temp folder), undefined when it is unreadable. */
async function readDacl(
  dir: string,
  icacls: string,
  run: AclCommandRunner,
  tempDir: string,
): Promise<Dacl | undefined> {
  let work: string | undefined;
  try {
    work = mkdtempSync(join(tempDir, "cashu-acl-"));
    const listing = join(work, "acl");
    if ((await run(icacls, [dir, "/save", listing, "/q"])).status !== 0) return undefined;
    return parseSavedDacl(readFileSync(listing));
  } catch {
    return undefined;
  } finally {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Every entry below `dir` reached without a link, and whether a link was met on the way; undefined
 * when a folder cannot be listed.
 */
function entriesBelow(
  dir: string,
  list: AclDirLister,
): { paths: string[]; linked: boolean } | undefined {
  const paths: string[] = [];
  let linked = false;
  const walk = (folder: string) => {
    for (const entry of list(folder)) {
      const path = win32.join(folder, entry.name);
      if (entry.kind === "link") {
        linked = true;
        continue;
      }
      paths.push(path);
      if (entry.kind === "dir") walk(path);
    }
  };
  try {
    walk(dir);
  } catch {
    return undefined;
  }
  return { paths, linked };
}

/**
 * Makes the existing directory `dir` (an absolute, resolved Windows path) private to this user (see
 * the header). Throws `HostPathError` naming `dir` when it is a drive or share root, owned by another
 * account, or cannot be made private.
 */
export async function makeOwnerOnly(dir: string, options: OwnerOnlyOptions = {}): Promise<void> {
  const run = options.run ?? runSystemCommand;
  const tempDir = options.tempDir ?? tmpdir();
  const list = options.list ?? listDirectory;
  const refuse = (why: string): never => {
    throw new HostPathError(`${dir} could not be made private to this user: ${why}`);
  };
  if (!winIsAbsolute(dir) || win32.parse(dir).root === win32.normalize(dir)) {
    refuse("a drive or share root is never a data dir");
  }
  const sys32 = system32(options.env ?? process.env) ?? refuse("SystemRoot is not set");
  const icacls = win32.join(sys32, "icacls.exe");
  // Read-only and independent: all three at once (see the header), then checked in order.
  const [userSid, dirOwner, before] = await Promise.all([
    currentUserSid(run, sys32),
    ownerOf(dir, run, sys32),
    readDacl(dir, icacls, run, tempDir),
  ]);
  const sid = userSid ?? refuse("the user's SID is unreadable (whoami)");
  const owner = dirOwner ?? refuse("its owner is unreadable (Get-Acl)");
  const ownOwner =
    isTrustee(owner, sid) || (owner === ADMINISTRATORS_SID && (await isElevated(run, sys32)));
  if (!ownOwner)
    refuse(
      `it is owned by another account (${owner}); take ownership as this user, then start again`,
    );
  if (before !== undefined && isOwnerOnlyDacl(before, sid)) return;

  const leftovers = leftoversOf(before, sid);
  if (leftovers.unnamed.length > 0)
    refuse(
      `other accounts hold entries icacls cannot be given by SID (${leftovers.unnamed.join(", ")}); remove them, then start again`,
    );
  const below = entriesBelow(dir, list) ?? refuse("the entries inside it could not be listed");
  const resets = below.linked
    ? below.paths.map((path) => [path, "/reset", "/q"])
    : below.paths.length > 0
      ? [[win32.join(dir, "*"), "/reset", "/t", "/q"]]
      : [];
  for (const args of resets) {
    if ((await run(icacls, args)).status !== 0)
      refuse("icacls could not reset the access lists of the entries inside it");
  }
  const applied = await run(icacls, [
    dir,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    `*${SYSTEM_SID}:(OI)(CI)F`,
    "/q",
  ]);
  if (applied.status !== 0) refuse("icacls could not set its access list");
  const removals = [
    ...(leftovers.others.length > 0 ? [["/remove", leftovers.others] as const] : []),
    ...(leftovers.ownDenies.length > 0 ? [["/remove:d", leftovers.ownDenies] as const] : []),
  ];
  for (const [verb, sids] of removals) {
    if ((await run(icacls, [dir, verb, ...sids.map((s) => `*${s}`), "/q"])).status !== 0)
      refuse(`icacls could not remove the entries of ${sids.join(", ")}`);
  }
  const after =
    (await readDacl(dir, icacls, run, tempDir)) ?? refuse("its access list is unreadable");
  const problems = daclProblems(after, sid);
  if (problems.length > 0)
    refuse(`its access list is still not private after the change: ${problems.join("; ")}`);
}
