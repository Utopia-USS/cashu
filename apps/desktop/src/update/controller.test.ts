import { describe, expect, it, vi } from "vitest";
import {
  type PreferenceStore,
  UpdateController,
  type UpdateInfo,
  type UpdaterPort,
} from "./controller.js";

class FakeUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  handlers = new Map<string, (value?: unknown) => void>();
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
  on(event: string, callback: (value?: unknown) => void) {
    this.handlers.set(event, callback);
  }
  off(event: string) {
    this.handlers.delete(event);
  }
  emit(event: string, value?: unknown) {
    this.handlers.get(event)?.(value);
  }
}

const info: UpdateInfo = {
  version: "1.2.3",
  files: [{ url: "cashU-1.2.3-mac.zip", sha512: `${"A".repeat(86)}==` }],
};
function fixture() {
  const updater = new FakeUpdater();
  let prefs = {
    auto: false,
    skippedVersion: null as string | null,
    dismissedVersion: null as string | null,
  };
  const store: PreferenceStore = {
    read: () => prefs,
    write: (value) => {
      prefs = { ...value };
    },
  };
  const cancel = vi.fn(async () => true);
  const commitDispatch = vi.fn(async () => "committed" as const);
  const handover = vi.fn(async (_targetVersion: string) => ({
    kind: "ready" as const,
    cancel,
    commitDispatch,
  }));
  const check = vi.fn(async () => ({ ok: true as const }));
  const controller = new UpdateController(
    updater as unknown as UpdaterPort,
    { check, handover },
    store,
    "1.0.0",
  );
  return {
    updater,
    controller,
    handover,
    cancel,
    commitDispatch,
    check,
    store,
    prefs: () => prefs,
  };
}
async function publish(f: ReturnType<typeof fixture>, value: UpdateInfo = info) {
  f.updater.checkForUpdates.mockImplementationOnce(async () => {
    f.updater.emit("update-available", value);
  });
  return f.controller.act("check");
}

describe("native updater controller", () => {
  it("does not auto install on quit and hides feed paths", async () => {
    const f = fixture();
    expect(f.controller.status()).toEqual({ availability: "unavailable" });
    await f.controller.initialize();
    expect(f.updater.autoDownload).toBe(false);
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
    await publish(f);
    expect(f.controller.status()).toMatchObject({
      latest: "1.2.3",
      url: null,
      app: { stage: "available" },
    });
  });

  it("never installs without confirmed download and ready handover", async () => {
    const f = fixture();
    await f.controller.initialize();
    await publish(f);
    expect(await f.controller.act("install")).toEqual({
      kind: "outcome_unknown",
      reason: "download_unconfirmed",
    });
    expect(f.controller.canRetryInstallAfterAttempt()).toBe(true);
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      f.updater.emit("update-downloaded", info);
    });
    f.handover.mockResolvedValueOnce({ kind: "unknown" } as never);
    expect(await f.controller.act("install")).toEqual({
      kind: "outcome_unknown",
      reason: "handover_not_ready",
    });
    expect(f.controller.canRetryInstallAfterAttempt()).toBe(false);
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("rejects metadata missing a zip checksum even if an updater emits downloaded", async () => {
    const f = fixture();
    await f.controller.initialize();
    await publish(f, { version: "1.2.3", files: [{ url: "evil.zip" }] });
    f.updater.emit("update-downloaded", info);
    expect(await f.controller.act("install")).toMatchObject({ kind: "refused" });
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("installs only after ready handover and persists a skip", async () => {
    const f = fixture();
    await f.controller.initialize();
    await publish(f);
    expect(await f.controller.act("skip")).toEqual({ kind: "completed" });
    expect(f.prefs().skippedVersion).toBe("1.2.3");
    expect(f.controller.status()).toMatchObject({ app: null });
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      f.updater.emit("update-downloaded", info);
    });
    expect(await f.controller.act("install")).toEqual({
      kind: "outcome_unknown",
      reason: "install_dispatched",
    });
    expect(f.handover).toHaveBeenCalledOnce();
    expect(f.handover).toHaveBeenCalledWith("1.2.3");
    expect(f.commitDispatch).toHaveBeenCalledOnce();
    expect(f.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(f.controller.canRetryInstallAfterAttempt()).toBe(false);
  });

  it("serializes auto download and manual install and discards late events after dispose", async () => {
    const f = fixture();
    await f.controller.initialize();
    expect(await f.controller.act("auto", true)).toEqual({ kind: "completed" });
    let resolveDownload: (() => void) | undefined;
    f.updater.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveDownload = () => resolve(undefined);
        }),
    );
    await publish(f);
    expect(await f.controller.act("install")).toEqual({ kind: "refused", reason: "busy" });
    f.updater.emit("download-progress", { percent: Number.NaN });
    expect(f.controller.status()).toMatchObject({ app: { progress: null } });
    resolveDownload?.();
    await Promise.resolve();
    f.controller.dispose();
    f.updater.emit("update-downloaded", info);
    expect(f.controller.status()).toEqual({ availability: "unavailable" });
  });

  it("refuses malformed update metadata from the feed", async () => {
    const sha512 = `${"A".repeat(86)}==`;
    const zip = { url: "cashU-1.2.3-mac.zip", sha512 };
    for (const value of [
      null,
      "1.2.3",
      { version: "1.2.3" },
      { version: "1.2", files: [zip] },
      { version: "1.2.3", files: [] },
      { version: "1.2.3", files: [{ ...zip, url: "cashU-1.2.3.dmg" }] },
      { version: "1.2.3", files: [zip, { ...zip, url: "second.zip" }] },
      { version: "1.2.3", files: [{ ...zip, url: "a..b.zip" }] },
      { version: "1.2.3", files: [{ ...zip, sha512: "short" }] },
      { version: "1.2.3", files: Array.from({ length: 9 }, () => zip) },
    ]) {
      const f = fixture();
      await f.controller.initialize();
      f.updater.checkForUpdates.mockImplementationOnce(async () => {
        f.updater.emit("update-available", value);
      });
      await f.controller.act("check");
      expect(f.controller.status()).toMatchObject({
        app: { stage: "error", error: "invalid_update_metadata" },
      });
    }
  });

  it("rejects a bad first download candidate even when a later zip looks valid", async () => {
    const f = fixture();
    await f.controller.initialize();
    const result = await publish(f, {
      version: "1.2.3",
      files: [
        { url: "https://evil.example.test/payload.zip", sha512: `${"A".repeat(86)}==` },
        { url: "good.zip", sha512: `${"A".repeat(86)}==` },
      ],
    });
    expect(result).toMatchObject({ kind: "refused" });
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("does not start a download after disposal during a delayed identity check", async () => {
    const f = fixture();
    await f.controller.initialize();
    await publish(f);
    let resolveCheck: ((value: { ok: true }) => void) | undefined;
    f.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const pending = f.controller.act("install");
    f.controller.dispose();
    resolveCheck?.({ ok: true });
    expect(await pending).toEqual({ kind: "outcome_unknown", reason: "interrupted" });
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not install after disposal during delayed host handover", async () => {
    const f = fixture();
    await f.controller.initialize();
    await publish(f);
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      f.updater.emit("update-downloaded", info);
    });
    let resolveHandover:
      | ((value: {
          kind: "ready";
          cancel: typeof f.cancel;
          commitDispatch: typeof f.commitDispatch;
        }) => void)
      | undefined;
    f.handover.mockImplementationOnce(
      () =>
        new Promise<{
          kind: "ready";
          cancel: typeof f.cancel;
          commitDispatch: typeof f.commitDispatch;
        }>((resolve) => {
          resolveHandover = resolve;
        }),
    );
    const pending = f.controller.act("install");
    await vi.waitFor(() => expect(f.handover).toHaveBeenCalledOnce());
    f.controller.dispose();
    resolveHandover?.({ kind: "ready", cancel: f.cancel, commitDispatch: f.commitDispatch });
    expect(await pending).toEqual({ kind: "outcome_unknown", reason: "interrupted" });
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(f.controller.canRetryInstallAfterAttempt()).toBe(false);
  });

  it("cancels the retained handover barrier when final identity verification fails", async () => {
    const f = fixture();
    await f.controller.initialize();
    await publish(f);
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      f.updater.emit("update-downloaded", info);
    });
    f.check.mockResolvedValueOnce({ ok: true });
    f.check.mockResolvedValueOnce({ ok: true });
    f.check.mockResolvedValueOnce({ ok: true });
    f.check.mockResolvedValueOnce({ ok: false, reason: "bundle_changed" } as never);
    expect(await f.controller.act("install")).toEqual({
      kind: "refused",
      reason: "bundle_changed",
    });
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(f.controller.canRetryInstallAfterAttempt()).toBe(true);
  });

  it("does not dispatch an installer when durable dispatch commitment is uncertain", async () => {
    const f = fixture();
    await f.controller.initialize();
    await publish(f);
    f.updater.downloadUpdate.mockImplementationOnce(async () => {
      f.updater.emit("update-downloaded", info);
    });
    f.commitDispatch.mockResolvedValueOnce("unknown" as never);
    expect(await f.controller.act("install")).toEqual({
      kind: "outcome_unknown",
      reason: "dispatch_commit_unknown",
    });
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(f.controller.canRetryInstallAfterAttempt()).toBe(false);
  });

  it("refuses an unknown runtime action", async () => {
    const f = fixture();
    await f.controller.initialize();
    expect(await f.controller.act("replace-feed" as never)).toEqual({
      kind: "refused",
      reason: "invalid_input",
    });
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
