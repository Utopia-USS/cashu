// The owner-only data dir DACL against the real icacls and PowerShell (Windows only): a fresh dir in
// the user's profile Temp (os.tmpdir(), where the first Windows CI run refused every data dir) and in
// the runner's RUNNER_TEMP when set, carrying an explicit entry of another account, ends up with
// exactly this user and SYSTEM, and the entries already inside it with no other account; a dir
// another account owns is refused. Only SIDs are read (the SDDL of `icacls /save`, the CSV of
// `whoami`), never localized account names.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import { HostPathError } from "./paths.js";
import {
  type Dacl,
  daclProblems,
  isOwnerOnlyDacl,
  makeOwnerOnly,
  parseSavedDacl,
  parseWhoamiSid,
  SYSTEM_SID,
} from "./windowsAcl.js";

afterEach(cleanup);

const system32 = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32");

function userSid(): string {
  const out = spawnSync(join(system32(), "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "latin1",
  });
  const sid = parseWhoamiSid(out.stdout);
  if (sid === undefined) throw new Error("no SID from whoami");
  return sid;
}

/** The DACL of `path` as SIDs, through `icacls /save`. */
function daclOf(path: string): Dacl {
  const work = mkdtempSync(join(tmpdir(), "cashu-acl-read-"));
  try {
    const listing = join(work, "acl");
    const out = spawnSync(join(system32(), "icacls.exe"), [path, "/save", listing, "/q"]);
    expect(out.status).toBe(0);
    const dacl = parseSavedDacl(readFileSync(listing));
    if (dacl === undefined) throw new Error("unreadable icacls listing");
    return dacl;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** BUILTIN\Users: the other account the tests give an explicit entry. */
const USERS_SID = "S-1-5-32-545";

/** The trustees of every entry of `dacl` (grant or deny) other than `sid` and SYSTEM. */
const othersIn = (dacl: Dacl, sid: string) =>
  dacl.aces
    .map((ace) => ace.trustee)
    .filter(
      (trustee) =>
        trustee !== sid &&
        trustee !== SYSTEM_SID &&
        !(trustee === "LA" && /^S-1-5-21-(?:\d+-){3}500$/.test(sid)),
    );

function icacls(args: readonly string[]): void {
  const out = spawnSync(join(system32(), "icacls.exe"), [...args, "/q"]);
  expect(out.status).toBe(0);
}

/** The parents a data dir is made private in: the user's profile Temp, and RUNNER_TEMP on CI. */
const PARENTS: readonly (readonly [string, string])[] = [
  ["the user's temp folder (os.tmpdir())", tmpdir()],
  ...(process.env.RUNNER_TEMP ? [["RUNNER_TEMP", process.env.RUNNER_TEMP] as const] : []),
];

describe.skipIf(process.platform !== "win32")("owner-only data dir DACL (Windows)", () => {
  it.each(PARENTS)("leaves only this user and SYSTEM on a dir in %s and below it", (_, parent) => {
    const sid = userSid();
    const dir = trackDir(realpathSync.native(mkdtempSync(join(parent, "cashu-acl-it-"))));
    const token = join(dir, "run", "host.token");
    mkdirSync(join(dir, "run"));
    writeFileSync(token, "synthetic");
    // Another account's explicit entries, which /inheritance:r and /grant:r alone leave in place.
    icacls([dir, "/grant", `*${USERS_SID}:(OI)(CI)R`]);
    icacls([token, "/grant", `*${USERS_SID}:R`]);
    expect(othersIn(daclOf(dir), sid)).toContain(USERS_SID);
    makeOwnerOnly(dir);
    const own = daclOf(dir);
    expect(daclProblems(own, sid)).toEqual([]);
    expect(own.control).toContain("P");
    expect(othersIn(own, sid)).toEqual([]);
    for (const child of [join(dir, "run"), token]) expect(othersIn(daclOf(child), sid)).toEqual([]);
    // Idempotent: a second start finds it private and leaves it as it is.
    makeOwnerOnly(dir);
    expect(daclOf(dir)).toEqual(own);
  });

  it("reads the owner of a dir whose name holds PowerShell quotes and specials", () => {
    const dir = join(trackDir(tempDir()), "O'Brien\u2019s [1] $(x) `y`");
    mkdirSync(dir);
    makeOwnerOnly(dir);
    expect(isOwnerOnlyDacl(daclOf(dir), userSid())).toBe(true);
  });

  // Giving the dir to another owner (SYSTEM) needs the restore privilege of an elevated shell; without
  // it the test skips itself.
  it("refuses a data dir another account owns and leaves its DACL alone", ({ skip }) => {
    const dir = join(trackDir(tempDir()), "data");
    mkdirSync(dir);
    const icacls = join(system32(), "icacls.exe");
    const given = spawnSync(icacls, [dir, "/setowner", `*${SYSTEM_SID}`, "/q"]);
    if (given.status !== 0) skip("setting another owner needs an elevated shell");
    const before = daclOf(dir);
    expect(() => makeOwnerOnly(dir)).toThrow(
      new HostPathError(
        `${dir} could not be made private to this user: it is owned by another account (${SYSTEM_SID}); take ownership as this user, then start again`,
      ),
    );
    expect(daclOf(dir)).toEqual(before);
    // Let cleanup remove it whatever the DACL: ownership back to this user.
    spawnSync(icacls, [dir, "/setowner", `*${userSid()}`, "/q"]);
  });
});
