// Crash tests against real host processes (spawned with Node type stripping, temp data dirs).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connectHost } from "@cashu/node-host";
import { mintUlid } from "@cashu/store";
import { afterEach, describe, expect, it } from "vitest";
import { storeFiles } from "./stores.js";
import { cleanup, spawnHost, storeClient, tempDir } from "./testing/harness.js";

afterEach(cleanup);

async function stopHost(dataDir: string): Promise<void> {
  const admin = await connectHost({ dataDir, role: "admin", build: "t" });
  const closed = new Promise<void>((resolve) => admin.onClose(resolve));
  await admin.call("admin.stop");
  await closed;
}

/** `count` unclean starts within the last seconds, as earlier crashed hosts left them. */
function seedStarts(dir: string, count: number): string {
  const run = join(dir, "run");
  mkdirSync(run, { recursive: true });
  const starts = join(run, "starts.json");
  const now = Date.now();
  const unclean = Array.from({ length: count }, (_, i) => now - (count - i) * 1000);
  writeFileSync(starts, JSON.stringify({ format: 1, unclean }));
  return starts;
}

describe("host crashes", () => {
  it("loses nothing and duplicates nothing when killed after a commit and the command is resent", async () => {
    const dir = tempDir();
    const first = spawnHost(dir, { killAfterCommits: 1 });
    await first.ready;
    const client = await storeClient(dir);
    const vault = client.vaults[0] as string;
    const key = mintUlid(Date.now());
    // The host commits, then dies before the reply: the client never learns the outcome.
    await expect(
      client.run("core.renameProfile", { name: "Committed" }, { vault, key }),
    ).rejects.toThrow("closed");
    expect(await first.exit).toBeNull();

    const second = spawnHost(dir);
    await second.ready;
    const again = await storeClient(dir);
    expect(await again.run("core.renameProfile", { name: "Committed" }, { vault, key })).toEqual({
      ok: true,
      value: null,
    });
    const profile = await again.subscribe("core.profile", vault);
    expect(profile.first).toMatchObject({ name: "Committed" });
    again.close();
    await stopHost(dir);
    expect(await second.exit).toBe(0);

    const db = new DatabaseSync(join(storeFiles(dir).vaultDir, `${vault}.db`), { readOnly: true });
    const renamed = db
      .prepare("SELECT count(*) AS n FROM event_log WHERE type = 'profile.renamed'")
      .get() as { n: number };
    db.close();
    expect(renamed.n).toBe(1);
    expect(readFileSync(join(dir, "logs", "host.log"), "utf8")).toContain("store.command.replayed");
  });

  // Two halves of one crash loop, each on its own host (a host start is the slow part): a SIGKILLed
  // host leaves its start on record, and three records put the next start in safe mode.
  it("counts a killed host as an unclean start", async () => {
    const dir = tempDir();
    const starts = seedStarts(dir, 2);
    const crashing = spawnHost(dir);
    await crashing.ready;
    crashing.child.kill("SIGKILL");
    expect(await crashing.exit).toBeNull();
    expect(JSON.parse(readFileSync(starts, "utf8")).unclean).toHaveLength(3);
  });

  it("starts the next host in safe mode after three unclean starts", async () => {
    const dir = tempDir();
    const starts = seedStarts(dir, 3);
    const safe = spawnHost(dir);
    let out = "";
    safe.child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    await safe.ready;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(out).toMatch(/ready \d+ safe/);
    await stopHost(dir);
    expect(await safe.exit).toBe(0);
    expect(JSON.parse(readFileSync(starts, "utf8")).unclean).toEqual([]);
  });
});
