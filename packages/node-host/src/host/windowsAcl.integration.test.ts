// The owner-only data dir DACL against the real icacls and PowerShell (Windows only): a fresh temp
// dir and the entries already inside it end up with no principal but this user and SYSTEM, and a dir
// another account owns is refused. Only SIDs are read (the SDDL of `icacls /save`, the CSV of
// `whoami`), never localized account names.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import { HostPathError } from "./paths.js";
import {
  type Dacl,
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

const principals = (dacl: Dacl) =>
  [...new Set(dacl.aces.filter((ace) => !ace.type.endsWith("D")).map((ace) => ace.trustee))].sort();

describe.skipIf(process.platform !== "win32")("owner-only data dir DACL (Windows)", () => {
  it("leaves only this user and SYSTEM on the dir and everything already below it", () => {
    const sid = userSid();
    const dir = join(trackDir(tempDir()), "data");
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(join(dir, "run", "host.token"), "synthetic");
    makeOwnerOnly(dir);
    const own = daclOf(dir);
    expect(own.control).toContain("P");
    expect(isOwnerOnlyDacl(own, sid)).toBe(true);
    const owners = [sid, SYSTEM_SID].sort();
    expect(principals(own)).toEqual(owners);
    for (const child of [join(dir, "run"), join(dir, "run", "host.token")]) {
      expect(principals(daclOf(child)).every((p) => owners.includes(p))).toBe(true);
    }
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
