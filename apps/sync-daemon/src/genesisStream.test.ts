// The lab genesis stream (S29c-B3): the genesis device announces itself in the stream's first frame,
// writes genesis's events at the fixed clock W with genesis's own HLCs, and retires itself in the
// last frame; the store skips the two statements (no upgrade asked), and a frame written later with
// a kept copy of the key is verified but its data is rejected, by the writing vault and after a
// restart (the lab gate replays the retirement). Real vaults in temp dirs, synthetic data only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintUlid, v1 } from "@cashu/store";
import { crypto } from "@cashu/sync";
import { afterEach, describe, expect, it } from "vitest";
import { writeGenesisStream } from "./init.js";
import { labFileKeyStore } from "./keys/labFile.js";
import { labGate } from "./keys/labGate.js";
import { createVault } from "./keys/vaultKeys.js";
import { genesisEngine, type OpenVault, openVault, type VaultKeys } from "./vault.js";

const sodium = await crypto.loadNodeSodium();
const W = Date.UTC(2026, 2, 1, 12);
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function open(root: string, keys: VaultKeys, store: crypto.KeyStore): Promise<OpenVault> {
  return openVault({
    ordinal: 0,
    profileId: 1,
    stateRoot: join(root, "state"),
    remotes: [],
    keys,
    sodium,
    gate: await labGate(store, sodium, keys.ring, keys.identity),
  });
}

function rule(v: OpenVault, n: number, hlc: string) {
  const merchantKey = `SKLEP SYN ${n}`;
  return {
    t: "categoryRule.set",
    v: 1,
    h: hlc,
    i: mintUlid(W + n, (k) => sodium.randomBytes(k)),
    g: v.store.deps.det("category_rules", [merchantKey]),
    a: new Date(W).toISOString(),
    d: { merchantKey, category: "groceries", source: "manual", locked: false },
  };
}

describe("lab genesis stream", () => {
  it("announces and retires the genesis device; a post-retirement genesis frame is rejected", async () => {
    const root = mkdtempSync(join(tmpdir(), "cashu-genesis-stream-"));
    roots.push(root);
    const store = labFileKeyStore(join(root, "keys.json"));
    const created = await createVault(store, sodium);
    const keys = { ring: created.ring, identity: created.identity };
    const v = await open(root, keys, store);
    const g = created.genesis;
    const events = [0, 1, 2].map((n) =>
      rule(v, n, v1.formatHlc({ wall: W, counter: n, device: v.genesisDevice })),
    );
    // A copy of the key kept past the retirement (never stored: what an attacker would need).
    const leaked = new crypto.DeviceIdentity(
      g.identity.deviceId,
      new crypto.Secret(g.identity.box.secretKey.expose().slice()),
      new crypto.Secret(g.identity.signSecretKey.expose().slice()),
    );
    const chunks = await writeGenesisStream(v, sodium, g, W, events);
    g.identity.wipe();
    expect(chunks).toBe(1);
    const synced = await v.engine.sync();
    expect(synced.needsUpgrade).toBe(false);
    expect(v.store.needsUpgrade()).toBe(false);
    expect(v.store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual([{ n: 3 }]);
    expect(v.store.read("SELECT COUNT(*) AS n FROM event_rejects")).toEqual([{ n: 0 }]);
    // Three frames: announcement, the chunk, the retirement.
    const seg = (await v.local.list(v.vaultId)).find((s) => s.device === v.genesisDevice);
    expect(seg?.seg).toBe(1);

    // The kept key writes one more genesis frame after the retirement.
    const rogue = await genesisEngine(v, sodium, W + 10, [], leaked);
    await rogue.write([rule(v, 9, "unused")].map(({ h: _h, ...e }) => e));
    await rogue.close();
    const after = await v.engine.sync();
    expect(after.rejected).toContainEqual(
      expect.objectContaining({ device: v.genesisDevice, code: "revoked_writer" }),
    );
    expect(v.store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual([{ n: 3 }]);
    await v.close();

    // A restart (fresh gate: it learns the retirement again from the log or its snapshot).
    for (const reset of [false, true]) {
      const again = await open(root, keys, store);
      if (reset) {
        again.store.reset();
        again.store.driver.prepare("DELETE FROM store_meta WHERE key LIKE 'gate:%'").run();
      }
      const r = await again.engine.sync();
      expect(r.rejected, `reset ${reset}`).toContainEqual(
        expect.objectContaining({ device: again.genesisDevice, code: "revoked_writer" }),
      );
      expect(again.store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual([{ n: 3 }]);
      await again.close();
    }
  });
});
