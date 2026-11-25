/** Synthetic bounded blob/receipt port. This proves publication semantics, not production encryption. */
import { sha256Hex } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { type ImportPublication, publishCheckedImportBlob } from "./importPublication.js";

const vault = "11111111111111111111111111111111";
const file = () => ({
  name: "synthetic.csv",
  content: new TextEncoder().encode("synthetic bytes"),
});
function publisher() {
  const blobs = new Map<string, Uint8Array>(),
    stages = new Set<object>();
  let cleanups = 0,
    reads = 0,
    puts = 0,
    active = true,
    failCleanup = false,
    badReadback = false;
  const port: ImportPublication = {
    vault,
    binding: Object.freeze({}),
    isCurrent: () => active,
    async publish(content, expected) {
      puts++;
      const stage = Object.freeze({});
      stages.add(stage);
      const blob = { sha256: sha256Hex(content), ext: expected.ext };
      if (!blobs.has(blob.sha256)) blobs.set(blob.sha256, Uint8Array.from(content));
      return { blob, privateStage: stage };
    },
    async read(actualVault, blob, bound) {
      reads++;
      expect(actualVault).toBe(vault);
      expect(bound).toBeGreaterThan(file().content.length);
      const bytes = blobs.get(blob.sha256);
      return bytes ? (badReadback ? Uint8Array.of(1) : Uint8Array.from(bytes)) : null;
    },
    async discardPrivateStage(receipt) {
      if (!stages.has(receipt)) return;
      cleanups++;
      if (failCleanup) throw new Error("synthetic private stage cleanup failure");
      stages.delete(receipt);
    },
  };
  return {
    port,
    blobs,
    stages,
    counts: () => ({ cleanups, reads, puts }),
    inactive: () => {
      active = false;
    },
    failCleanup: () => {
      failCleanup = true;
    },
    badReadback: () => {
      badReadback = true;
    },
  };
}
describe("checked import publication", () => {
  it("publishes owned bytes, bounds/verifies readback and cleans only its receipt", async () => {
    const p = publisher(),
      original = file();
    const published = await publishCheckedImportBlob(p.port, vault, original);
    expect(published.blob.sha256).toBe(sha256Hex(original.content));
    expect(published.cleanupFailed).toBe(false);
    expect(p.counts()).toEqual({ cleanups: 1, reads: 1, puts: 1 });
    expect(p.stages.size).toBe(0);
    expect(p.blobs.size).toBe(1);
  });
  it("retains deduplicated durable content when either publisher later refuses", async () => {
    const p = publisher();
    const [first, second] = await Promise.all([
      publishCheckedImportBlob(p.port, vault, file()),
      publishCheckedImportBlob(p.port, vault, file()),
    ]);
    expect(first.blob).toEqual(second.blob);
    expect(p.blobs.size).toBe(1);
    expect(p.stages.size).toBe(0);
    expect(p.counts().cleanups).toBe(2);
  });
  it("reports private-stage cleanup failure without changing verified publication success", async () => {
    const p = publisher();
    p.failCleanup();
    const result = await publishCheckedImportBlob(p.port, vault, file());
    expect(result.cleanupFailed).toBe(true);
    expect(p.blobs.size).toBe(1);
    expect(p.stages.size).toBe(1);
  });
  it("refuses malformed readback before proposal and retains published bytes", async () => {
    const p = publisher();
    p.badReadback();
    await expect(publishCheckedImportBlob(p.port, vault, file())).rejects.toThrow("readback");
    expect(p.stages.size).toBe(0);
    expect(p.blobs.size).toBe(1);
  });
  it("rejects foreign/inactive capability before any blob access", async () => {
    const p = publisher();
    await expect(
      publishCheckedImportBlob(p.port, "22222222222222222222222222222222", file()),
    ).rejects.toThrow("authority");
    p.inactive();
    await expect(publishCheckedImportBlob(p.port, vault, file())).rejects.toThrow("authority");
    expect(p.counts()).toEqual({ cleanups: 0, reads: 0, puts: 0 });
  });
});
