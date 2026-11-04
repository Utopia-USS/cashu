import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { NativeVaultSession } from "../nativeVault.js";
import { startLanPairingService } from "./service.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "reserves the single invite and wipes a failed registration (throws: %s)",
  async (registrationThrows) => {
    const dir = await mkdtemp(join(tmpdir(), "cashu-pair-reserve-"));
    const start = deferred<unknown>();
    const reject = vi.fn();
    const inviter = {
      session: "a".repeat(32),
      invite: { expiresAt: Date.now() + 60_000 },
      reject,
    };
    const pairingStart = vi.fn(() => start.promise);
    const pairingRegisterInvite = vi.fn(async () => {
      if (registrationThrows) throw new Error("synthetic_journal_failure");
      return false;
    });
    const vault = { pairingStart, pairingRegisterInvite } as unknown as NativeVaultSession;
    const service = await startLanPairingService({
      dataDir: dir,
      ip: "127.0.0.1",
      port: 0,
      vault: () => vault,
    });
    try {
      const first = service.invite("b".repeat(32));
      expect(service.pending()).toBe(1);
      expect(await service.invite("b".repeat(32))).toEqual({ kind: "refused", code: "busy" });
      expect(pairingStart).toHaveBeenCalledTimes(1);
      start.resolve({ ok: true, value: { inviter, qr: "synthetic-qr", authority: "synthetic" } });
      expect(await first).toEqual({ kind: "refused", code: "unavailable" });
      expect(pairingRegisterInvite).toHaveBeenCalledTimes(1);
      expect(reject).toHaveBeenCalledTimes(1);
      expect(service.pending()).toBe(0);
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("does not publish an invite if the service closes while vault creation is pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cashu-pair-close-"));
  const start = deferred<unknown>();
  const reject = vi.fn();
  const pairingRegisterInvite = vi.fn();
  const vault = {
    pairingStart: () => start.promise,
    pairingRegisterInvite,
  } as unknown as NativeVaultSession;
  const service = await startLanPairingService({
    dataDir: dir,
    ip: "127.0.0.1",
    port: 0,
    vault: () => vault,
  });
  try {
    const first = service.invite("b".repeat(32));
    await service.close();
    start.resolve({
      ok: true,
      value: {
        inviter: { session: "a".repeat(32), invite: { expiresAt: Date.now() + 60_000 }, reject },
        qr: "synthetic-qr",
        authority: "synthetic",
      },
    });
    expect(await first).toEqual({ kind: "refused", code: "unavailable" });
    expect(reject).toHaveBeenCalledTimes(1);
    expect(pairingRegisterInvite).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
