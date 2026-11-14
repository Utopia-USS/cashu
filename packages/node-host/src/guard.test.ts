// Refusals on resolved paths with a fake home (a data dir plus two labelled outputs), plus the
// labels of a host with several outputs.
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GuardedPaths, RefusalError, refusePaths, resolveReal } from "./guard.js";

interface Layout {
  readonly dataDir: string;
  readonly out: string;
  readonly keys: string;
}

/** A data dir and two outputs, labelled like command flags. */
const flagPaths = (p: Layout): GuardedPaths => ({
  dataDir: { label: "--data-dir", path: p.dataDir },
  outputs: [
    { label: "--out", path: p.out },
    { label: "--keys", path: p.keys },
  ],
});

function layout() {
  const base = resolveReal(mkdtempSync(join(tmpdir(), "cashu-node-host-guard-")));
  const home = join(base, "home");
  mkdirSync(home);
  return {
    base,
    home,
    ok: { dataDir: join(base, "data"), out: join(base, "out"), keys: join(base, "keys.json") },
  };
}

const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RefusalError ? e.message : `other: ${String(e)}`;
  }
  return undefined;
};

const refuse = (p: Layout, home: string) => refusal(() => refusePaths(flagPaths(p), home));

describe("path guard", () => {
  it("resolves a path whose tail does not exist yet through the real prefix", () => {
    const { base } = layout();
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    expect(resolveReal(join(base, "link", "new", "file"))).toBe(join(base, "real", "new", "file"));
  });

  it("accepts paths outside the owner's locations", () => {
    const { home, ok } = layout();
    expect(refuse(ok, home)).toBeUndefined();
  });

  it("refuses the application data dir in any case, allowing cashU-demo only as the data dir", () => {
    const { home, ok } = layout();
    const appSupport = join(home, "Library", "Application Support");
    for (const name of ["cashU", "CASHU", "cashu", "cashU-old"]) {
      expect(refuse({ ...ok, dataDir: join(appSupport, name) }, home)).toBe(
        "--data-dir points into the cashU application data",
      );
    }
    expect(refuse({ ...ok, dataDir: join(appSupport, "cashU-demo") }, home)).toBeUndefined();
    expect(refuse({ ...ok, out: join(appSupport, "cashU-demo", "o") }, home)).toBe(
      "--out points into the cashU application data",
    );
    expect(refuse({ ...ok, keys: join(appSupport, "cashU", "k.json") }, home)).toBe(
      "--keys points into the cashU application data",
    );
  });

  it("refuses the workspaces and the installed app", () => {
    const { home, ok } = layout();
    expect(refuse({ ...ok, out: join(home, "CASHU", "x") }, home)).toBe(
      "--out points into the cashU workspaces",
    );
    expect(refuse({ ...ok, out: join(home, "cashU Staging") }, home)).toBe(
      "--out points into the cashU workspaces",
    );
    expect(refuse({ ...ok, out: join(home, "Documents", "CASHU", "x") }, home)).toBe(
      "--out points into the cashU workspaces",
    );
    expect(refuse({ ...ok, dataDir: "/Applications/cashU.app/Contents" }, home)).toBe(
      "--data-dir points into the installed cashU app",
    );
    expect(refuse({ ...ok, out: join(home, "Documents", "cashU-demo") }, home)).toBeUndefined();
  });

  it("refuses outputs inside the data dir, also through a symlink", () => {
    const { base, home, ok } = layout();
    mkdirSync(ok.dataDir);
    expect(refuse({ ...ok, out: join(ok.dataDir, "out") }, home)).toBe(
      "--out is inside the data dir",
    );
    expect(refuse({ ...ok, keys: join(ok.dataDir, "k.json") }, home)).toBe(
      "--keys is inside the data dir",
    );
    symlinkSync(ok.dataDir, join(base, "alias"));
    const out = resolveReal(join(base, "alias", "out"));
    expect(refuse({ ...ok, out }, home)).toBe("--out is inside the data dir");
  });

  it("refuses outputs and the data dir inside a git work tree", () => {
    const { base, home, ok } = layout();
    mkdirSync(join(base, "repo", ".git"), { recursive: true });
    expect(refuse({ ...ok, out: join(base, "repo", "o") }, home)).toBe(
      "--out is inside a git work tree",
    );
    expect(refuse({ ...ok, keys: join(base, "repo", "a", "k.json") }, home)).toBe(
      "--keys is inside a git work tree",
    );
    expect(refuse({ ...ok, dataDir: join(base, "repo", "data") }, home)).toBe(
      "--data-dir is inside a git work tree (a checkout's legacy data/)",
    );
  });

  it("names any output by its label: a data dir inside an output, the n-th remote", () => {
    const { base, home } = layout();
    const paths = (stateRoot: string, remote: string): GuardedPaths => ({
      dataDir: { label: "dataDir", path: join(base, "py") },
      outputs: [
        { label: "stateRoot", path: stateRoot },
        { label: "remotes[0].root", path: join(base, "remote0") },
        { label: "remotes[1].root", path: remote },
      ],
    });
    expect(refusal(() => refusePaths(paths(base, join(base, "r1")), home))).toBe(
      "the data dir is inside stateRoot",
    );
    const appSupport = join(home, "Library", "Application Support");
    expect(
      refusal(() => refusePaths(paths(join(base, "s"), join(appSupport, "cashU-demo")), home)),
    ).toBe("remotes[1].root points into the cashU application data");
    expect(
      refusal(() => refusePaths(paths(join(base, "s"), join(base, "r1")), home)),
    ).toBeUndefined();
  });
});
