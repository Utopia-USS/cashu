// `cashu-next genesis` end to end on a synthetic data dir (S26 spec 9.4, 10, 13 G5): refusals before
// anything is read, the out dir layout, idempotency, `--fold` invariants, the source left untouched
// and stdout free of slugs and names.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { main } from "../index.ts";
import { manifest } from "./copy.ts";
import { SECRETS, tempDir, testEnv, writePythonDataDir } from "./testing/pythonDataDir.ts";

function setup() {
  const base = tempDir("cmd");
  const data = join(base, "data");
  writePythonDataDir(data);
  const env = testEnv(join(base, "home"));
  mkdirSync(env.home);
  const runDir = join(env.tmpDir, `genesis-run-${env.pid}`);
  return { base, data, env, runDir, keys: join(base, "keys.json") };
}

type Setup = ReturnType<typeof setup>;

const genesisArgs = (s: Setup, out: string, ...extra: string[]) => [
  "genesis",
  "--data-dir",
  s.data,
  "--out",
  out,
  "--keys",
  s.keys,
  ...extra,
];

const read = (path: string) => readFileSync(path, "utf8");
const jsonl = (path: string) =>
  read(path)
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

describe("genesis command refusals (exit 64, nothing read or written)", () => {
  it("refuses the owner's data dir in a fake home", () => {
    const s = setup();
    const real = join(s.env.home, "Library", "Application Support", "cashU");
    writePythonDataDir(real);
    const before = manifest(real);
    const out = join(s.base, "out");
    const code = main(
      ["genesis", "--data-dir", real, "--out", out, "--keys", s.keys, "--init-keys"],
      s.env,
    );
    expect(code).toBe(64);
    expect(s.env.err).toEqual(["genesis: --data-dir points into the cashU application data"]);
    expect(s.env.out).toEqual(["genesis: exit 64"]);
    expect([existsSync(out), existsSync(s.keys), existsSync(s.runDir)]).toEqual([
      false,
      false,
      false,
    ]);
    expect(manifest(real)).toEqual(before);
  });

  it("refuses an out dir inside the data dir, a non-empty out dir and bad arguments", () => {
    const s = setup();
    const full = join(s.base, "full");
    mkdirSync(full);
    writeFileSync(join(full, "x"), "");
    writeFileSync(join(s.base, "existing.json"), "{}");
    const cases: [string[], string][] = [
      [genesisArgs(s, join(s.data, "out"), "--init-keys"), "--out is inside the data dir"],
      [genesisArgs(s, full, "--init-keys"), "--out exists and is not an empty directory"],
      [genesisArgs(s, join(s.base, "o")), "--keys does not exist"],
      [
        [
          "genesis",
          "--data-dir",
          s.data,
          "--out",
          join(s.base, "o"),
          "--keys",
          join(s.base, "existing.json"),
          "--init-keys",
        ],
        "--init-keys would overwrite an existing keys file",
      ],
      [["genesis", "--data-dir", "data", "--out", join(s.base, "o"), "--keys", s.keys], "usage:"],
      [[...genesisArgs(s, join(s.base, "o")), "--bogus"], "usage:"],
      [["genesis", "--out", join(s.base, "o"), "--keys", s.keys], "usage:"],
      [
        [
          "genesis",
          "--data-dir",
          s.env.home,
          "--out",
          join(s.base, "o"),
          "--keys",
          s.keys,
          "--init-keys",
        ],
        "--data-dir has no cashu.db",
      ],
    ];
    for (const [argv, message] of cases) {
      s.env.err.length = 0;
      expect(main(argv, s.env)).toBe(64);
      expect(s.env.err.join("\n")).toContain(message);
    }
    expect(main(["nope"], s.env)).toBe(64);
    expect(existsSync(s.runDir)).toBe(false);
    expect(existsSync(join(s.base, "o"))).toBe(false);
  });
});

describe("genesis command runs", () => {
  it("writes the out dir layout, leaves the source untouched and deletes the run copy", () => {
    const s = setup();
    const before = manifest(s.data);
    const out = join(s.base, "out");
    expect(main(genesisArgs(s, out, "--init-keys"), s.env)).toBe(0);
    expect(manifest(s.data)).toEqual(before);
    expect(existsSync(s.runDir)).toBe(false);
    expect(statSync(s.keys).mode & 0o777).toBe(0o600);
    expect(readdirSync(out).sort()).toEqual(["manifest.json", "vault-0", "vault-1"]);
    for (const v of ["vault-0", "vault-1"]) {
      expect(readdirSync(join(out, v)).sort()).toEqual([
        "device-local.json",
        "events.jsonl",
        "ids.jsonl",
      ]);
      expect(statSync(join(out, v, "events.jsonl")).mode & 0o777).toBe(0o600);
    }
    const m = JSON.parse(read(join(out, "manifest.json")));
    expect(Object.keys(m)).toEqual(["format", "source", "schema", "vaults", "report"]);
    expect([m.format, m.source, m.schema]).toEqual([1, before, "0025_topic_view_sources"]);
    const keys = JSON.parse(read(s.keys)).vaults;
    m.vaults.forEach((v: Record<string, unknown>, ordinal: number) => {
      expect(Object.keys(v)).toEqual(["ordinal", "events", "ids", "log_sha256", "W", "device"]);
      expect(v.ordinal).toBe(ordinal);
      const log = readFileSync(join(out, `vault-${ordinal}`, "events.jsonl"));
      expect(v.log_sha256).toBe(createHash("sha256").update(log).digest("hex"));
      const events = jsonl(join(out, `vault-${ordinal}`, "events.jsonl"));
      expect(events.length).toBe(v.events);
      const ids = jsonl(join(out, `vault-${ordinal}`, "ids.jsonl"));
      expect(ids.length).toBe(v.ids);
      for (const e of ids) expect(Object.keys(e)).toEqual(["table", "localId", "gid"]);
      // The profiles entry carries the vault id (the input `cashu sync seed --ids` links).
      const profile = ids.filter((e) => e.table === "profiles");
      expect(profile).toEqual([
        {
          table: "profiles",
          localId: String(ordinal + 1),
          gid: keys[["ala", "olek"][ordinal] ?? ""].vault,
        },
      ]);
    });
    const stdout = s.env.out.join("\n");
    for (const secret of [
      ...SECRETS,
      ...Object.values<{ vault: string; salt: string }>(keys).flatMap((k) => [k.vault, k.salt]),
    ]) {
      expect(stdout).not.toContain(secret);
    }
    expect(s.env.out.at(-1)).toBe("genesis: exit 0");
  });

  it("is idempotent with the same keys: byte-identical logs and ids", () => {
    const s = setup();
    const [a, b] = [join(s.base, "a"), join(s.base, "b")];
    expect(main(genesisArgs(s, a, "--init-keys"), s.env)).toBe(0);
    expect(main(genesisArgs(s, b), s.env)).toBe(0);
    const ma = JSON.parse(read(join(a, "manifest.json")));
    const mb = JSON.parse(read(join(b, "manifest.json")));
    expect(mb).toEqual(ma);
    for (const v of ["vault-0", "vault-1"]) {
      for (const f of ["events.jsonl", "ids.jsonl", "device-local.json"]) {
        expect(read(join(b, v, f))).toBe(read(join(a, v, f)));
      }
    }
  });

  it("folds every vault with the 8.4 invariants and records the view hash", () => {
    const s = setup();
    const [a, b] = [join(s.base, "a"), join(s.base, "b")];
    expect(main(genesisArgs(s, a, "--init-keys", "--fold"), s.env)).toBe(0);
    expect(main(genesisArgs(s, b, "--fold", "--no-strict"), s.env)).toBe(0);
    const ma = JSON.parse(read(join(a, "manifest.json")));
    const mb = JSON.parse(read(join(b, "manifest.json")));
    for (const [i, v] of ma.vaults.entries()) {
      expect(v.view_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(mb.vaults[i].view_hash).toBe(v.view_hash);
      expect(statSync(join(a, `vault-${i}`, "view.sqlite")).mode & 0o777).toBe(0o600);
      const view = new Database(join(a, `vault-${i}`, "view.sqlite"), { readonly: true });
      const accounts = view.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
      view.close();
      expect(accounts.n).toBe(1);
    }
    const folded = s.env.out.filter((l) => l.includes("folded, invariants ok"));
    expect(folded).toHaveLength(4);
    for (const line of folded) expect(line).toMatch(/view rows \d+ in \d+ tables = exported/);
  });

  it("keeps the run copy with --keep-run", () => {
    const s = setup();
    expect(main(genesisArgs(s, join(s.base, "o"), "--init-keys", "--keep-run"), s.env)).toBe(0);
    expect(readdirSync(s.runDir).sort()).toEqual(["cashu.db", "imports", "profiles"]);
  });
});

describe("genesis command failures (exit 65)", () => {
  it("fails on a profile without keys and discards the out dir", () => {
    const s = setup();
    writeFileSync(
      s.keys,
      JSON.stringify({
        format: 1,
        vaults: { ala: { vault: "1".repeat(32), salt: "2".repeat(64) } },
      }),
      { mode: 0o600 },
    );
    const out = join(s.base, "o");
    expect(main(genesisArgs(s, out), s.env)).toBe(65);
    expect(s.env.err.join("\n")).toContain("(missing_keys)");
    expect([existsSync(out), existsSync(s.runDir)]).toEqual([false, false]);
  });

  it("fails on an unsupported schema and removes the keys it just created", () => {
    const s = setup();
    const db = new Database(join(s.data, "cashu.db"));
    db.prepare("UPDATE alembic_version SET version_num = ?").run("0024_older");
    db.close();
    expect(main(genesisArgs(s, join(s.base, "o"), "--init-keys"), s.env)).toBe(65);
    expect(s.env.err.join("\n")).toContain("(unsupported_schema)");
    expect(existsSync(s.keys)).toBe(false);
  });

  it("fails on a database that is not SQLite without quoting it", () => {
    const s = setup();
    writeFileSync(join(s.data, "cashu.db"), "Ala Syntetyczna, not a database");
    expect(main(genesisArgs(s, join(s.base, "o"), "--init-keys"), s.env)).toBe(65);
    expect(s.env.err.join("\n")).not.toContain("Ala");
    expect(existsSync(s.runDir)).toBe(false);
  });
});
