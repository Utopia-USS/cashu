import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STRATEGY_MD,
  STRATEGY_YAML,
  type StrategyFileName,
  type StrategyPublicationJournal,
  strategyFileDigests,
} from "@cashu/store/investments/services";
import { afterEach, describe, expect, it } from "vitest";
import { strategyPublicationPorts } from "./strategyFiles.js";

const roots: string[] = [];
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-proposal-private-")));
  roots.push(root);
  const directory = join(root, "one-vault");
  mkdirSync(directory, { mode: 0o700 });
  let current = true;
  const ports = strategyPublicationPorts({
    vault: "synthetic-vault",
    privateRoot: root,
    directory,
    isCurrent: () => current,
  });
  return {
    root,
    directory,
    ...ports,
    revoke: () => {
      current = false;
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateFile(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
}

function journal(vault: string): StrategyPublicationJournal {
  const baseline = { yaml: "synthetic yaml", md: null };
  const managed = {
    image: baseline,
    digests: strategyFileDigests(baseline),
    approvalEid: null,
    version: null,
  };
  return {
    vault,
    baseline,
    baselineDigests: strategyFileDigests(baseline),
    baselineVersion: null,
    managed,
    pending: null,
  };
}

describe("injected private strategy publication files", () => {
  it("stages both fixed targets privately and installs or removes only those files", async () => {
    const f = fixture();
    expect(await f.files.read()).toEqual({ yaml: null, md: null });
    const yamlToken = await f.files.stage(STRATEGY_YAML, "synthetic yaml");
    const mdToken = await f.files.stage(STRATEGY_MD, "synthetic note");
    expect(lstatSync(join(f.directory, ".strategy.yaml.approving")).mode & 0o077).toBe(0);
    await f.files.install(STRATEGY_YAML, yamlToken);
    await f.files.install(STRATEGY_MD, mdToken);
    expect(await f.files.read()).toEqual({ yaml: "synthetic yaml", md: "synthetic note" });
    await f.files.remove(STRATEGY_MD);
    expect(f.files.readSync()).toEqual({ yaml: "synthetic yaml", md: null });
    expect(readFileSync(join(f.directory, STRATEGY_YAML), "utf8")).toBe("synthetic yaml");
    const leftover = await f.files.stage(STRATEGY_MD, "discarded");
    await f.files.discard(leftover);
    expect(existsSync(join(f.directory, ".strategy.md.approving"))).toBe(false);
    expect(await f.files.read()).toEqual({ yaml: "synthetic yaml", md: null });
  });

  it("writes a bounded private journal atomically and reads it after a new adapter instance", async () => {
    const f = fixture();
    const value = journal(f.files.vault);
    await f.journal.write(value);
    const path = join(f.directory, ".proposal-publication.json");
    expect(lstatSync(path).mode & 0o077).toBe(0);
    expect(await f.journal.read()).toEqual(value);
    const restarted = strategyPublicationPorts({
      vault: f.files.vault,
      privateRoot: f.root,
      directory: f.directory,
      isCurrent: () => true,
    });
    expect(await restarted.journal.read()).toEqual(value);
    expect(existsSync(join(f.directory, ".proposal-publication.json.approving"))).toBe(false);
  });

  it("refuses symlinks, hardlinks, unprivate files and a revoked capability", async () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    privateFile(outside, "outside");
    symlinkSync(outside, join(f.directory, STRATEGY_YAML));
    await expect(f.files.read()).rejects.toThrow();
    rmSync(join(f.directory, STRATEGY_YAML));
    linkSync(outside, join(f.directory, STRATEGY_YAML));
    await expect(f.files.read()).rejects.toThrow();
    rmSync(join(f.directory, STRATEGY_YAML));
    privateFile(join(f.directory, STRATEGY_YAML), "private");
    chmodSync(join(f.directory, STRATEGY_YAML), 0o644);
    await expect(f.files.read()).rejects.toThrow();
    chmodSync(join(f.directory, STRATEGY_YAML), 0o600);
    f.revoke();
    await expect(f.files.read()).rejects.toThrow();
    await expect(f.files.stage(STRATEGY_MD, "blocked")).rejects.toThrow();
    await expect(f.journal.write(journal(f.files.vault))).rejects.toThrow();
  });

  it("refuses a directory outside the injected private root and a malformed journal", async () => {
    const f = fixture();
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-proposal-other-")));
    roots.push(other);
    expect(() =>
      strategyPublicationPorts({
        vault: f.files.vault,
        privateRoot: f.root,
        directory: other,
        isCurrent: () => true,
      }),
    ).toThrow();
    privateFile(join(f.directory, ".proposal-publication.json"), "{bad");
    await expect(f.journal.read()).rejects.toThrow();
    await expect(f.journal.write(journal("another-vault"))).rejects.toThrow();
  });

  it("refuses a forged target name before deleting an outside private file", async () => {
    const f = fixture();
    const outside = join(f.root, "outside-private-file");
    privateFile(outside, "must remain");
    await expect(f.files.remove("../outside-private-file" as StrategyFileName)).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("must remain");
  });

  it("does not let a stale token install or discard a newer staged file", async () => {
    const f = fixture();
    const old = await f.files.stage(STRATEGY_YAML, "old staged text");
    const fresh = await f.files.stage(STRATEGY_YAML, "fresh staged text");
    await expect(f.files.install(STRATEGY_YAML, old)).rejects.toThrow();
    await f.files.discard(old);
    expect(readFileSync(join(f.directory, ".strategy.yaml.approving"), "utf8")).toBe(
      "fresh staged text",
    );
    await f.files.install(STRATEGY_YAML, fresh);
    expect(f.files.readSync().yaml).toBe("fresh staged text");
  });

  it("pins the injected vault identity and callback when their carrier object changes", async () => {
    const f = fixture();
    const authority = {
      vault: f.files.vault,
      privateRoot: f.root,
      directory: f.directory,
      isCurrent: () => true,
    };
    const ports = strategyPublicationPorts(authority);
    authority.vault = "another-vault";
    authority.isCurrent = () => false;
    await ports.journal.write(journal(f.files.vault));
    expect((await ports.journal.read())?.vault).toBe(f.files.vault);
  });
});
