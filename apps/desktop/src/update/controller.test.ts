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

  it("never downloads a found version on its own, also with the daily check on", async () => {
    const f = fixture();
    await f.controller.initialize();
    expect(await f.controller.act("auto", true)).toEqual({ kind: "completed" });
    expect(f.prefs().auto).toBe(true);
    await publish(f);
    expect(f.controller.status()).toMatchObject({ autoCheck: true, app: { stage: "available" } });
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(await f.controller.act("auto", false)).toEqual({ kind: "completed" });
    expect(f.controller.status()).toMatchObject({ autoCheck: false });
  });

  it("discards late events after dispose", async () => {
    const f = fixture();
    await f.controller.initialize();
    let resolveDownload: (() => void) | undefined;
    f.updater.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveDownload = () => resolve(undefined);
        }),
    );
    await publish(f);
    const install = f.controller.act("install");
    await vi.waitFor(() => expect(f.updater.downloadUpdate).toHaveBeenCalled());
    expect(await f.controller.act("install")).toEqual({ kind: "refused", reason: "busy" });
    f.updater.emit("download-progress", { percent: Number.NaN });
    expect(f.controller.status()).toMatchObject({ app: { progress: null } });
    resolveDownload?.();
    await install;
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
      {
        version: "1.2.3",
        files: [
          { ...zip, url: "cashU-1.2.3-mac-arm64.zip" },
          { ...zip, url: "cashU-1.2.3-mac-arm64-b.zip" },
        ],
      },
      {
        version: "1.2.3",
        files: [
          { ...zip, url: "cashU-1.2.3-mac-arm64.zip" },
          { ...zip, url: "cashU-1.2.3-mac-x64.zip" },
          { ...zip, url: "cashU-1.2.3-mac-universal.zip" },
        ],
      },
      {
        version: "1.2.3",
        files: [{ ...zip, url: "cashU-1.2.3-mac-arm64.zip" }, { url: "cashU-1.2.3-mac-x64.zip" }],
      },
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

  it("accepts the release metadata with one arm64 and one x64 zip, or a single zip", async () => {
    const sha512 = `${"A".repeat(86)}==`;
    const arm64 = { url: "cashU-1.2.3-mac-arm64.zip", sha512, size: 10 };
    const x64 = { url: "cashU-1.2.3-mac-x64.zip", sha512, size: 10 };
    for (const files of [
      [arm64, x64],
      [x64, arm64],
      [arm64],
      [x64],
      [arm64, x64, { ...arm64, url: "cashU-1.2.3.dmg" }],
    ]) {
      const f = fixture();
      await f.controller.initialize();
      const value = { version: "1.2.3", files, path: arm64.url, sha512 };
      expect(await publish(f, value)).toEqual({ kind: "completed" });
      expect(f.controller.status()).toMatchObject({ latest: "1.2.3", app: { stage: "available" } });
      f.updater.downloadUpdate.mockImplementationOnce(async () => {
        f.updater.emit("update-downloaded", value);
      });
      expect(await f.controller.act("install")).toEqual({
        kind: "outcome_unknown",
        reason: "install_dispatched",
      });
      expect(f.handover).toHaveBeenCalledWith("1.2.3");
      expect(f.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
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

  it("never checks automatically without the release gate, with the daily check off or while busy", async () => {
    const f = fixture();
    // Before initialize (and so in every dev, test, e2e, unsigned or staging build) it is unavailable.
    expect(await f.controller.checkAutomatically()).toBe(false);
    f.check.mockResolvedValueOnce({ ok: false, reason: "not_packaged_macos" } as never);
    await f.controller.initialize();
    expect(await f.controller.checkAutomatically()).toBe(false);
    expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
    const g = fixture();
    await g.controller.initialize();
    expect(await g.controller.checkAutomatically()).toBe(false);
    g.store.write({ ...g.prefs(), auto: true });
    let release: (() => void) | undefined;
    g.updater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => {
            g.updater.emit("update-not-available");
            resolve(undefined);
          };
        }),
    );
    const manual = g.controller.act("check");
    await vi.waitFor(() => expect(g.updater.checkForUpdates).toHaveBeenCalledOnce());
    expect(await g.controller.checkAutomatically()).toBe(false);
    release?.();
    await manual;
    expect(g.updater.checkForUpdates).toHaveBeenCalledOnce();
    // The gate is rechecked: a failing one makes the updater unavailable without a feed request.
    g.check.mockResolvedValueOnce({ ok: false, reason: "install_location" } as never);
    expect(await g.controller.checkAutomatically()).toBe(false);
    expect(g.controller.status()).toEqual({ availability: "unavailable" });
    expect(g.updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("an automatic check shows only a found version, honours skip and dismiss, never downloads", async () => {
    const f = fixture();
    f.store.write({ ...f.prefs(), auto: true });
    await f.controller.initialize();
    const stages: unknown[] = [];
    f.controller.onChange(() => stages.push(f.controller.status()));
    f.updater.checkForUpdates.mockImplementationOnce(async () => {
      f.updater.emit("update-not-available");
    });
    expect(await f.controller.checkAutomatically()).toBe(true);
    expect(stages[0]).toMatchObject({ manualCheck: false, app: { stage: "checking" } });
    expect(f.controller.status()).toMatchObject({
      manualCheck: false,
      app: { stage: "up_to_date" },
    });
    f.updater.checkForUpdates.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    expect(await f.controller.checkAutomatically()).toBe(true);
    expect(f.controller.status()).toMatchObject({ manualCheck: false, app: { stage: "error" } });
    f.updater.checkForUpdates.mockImplementationOnce(async () => {
      f.updater.emit("update-available", info);
    });
    expect(await f.controller.checkAutomatically()).toBe(true);
    expect(f.controller.status()).toMatchObject({
      latest: "1.2.3",
      manualCheck: false,
      app: { stage: "available", version: "1.2.3" },
    });
    // A visible found version waits for the owner: no further automatic check over it.
    expect(await f.controller.checkAutomatically()).toBe(false);
    expect(await f.controller.act("dismiss")).toEqual({ kind: "completed" });
    expect(f.controller.status()).toMatchObject({ app: null });
    // Dismissed (or skipped): the next check runs, and the same version stays hidden.
    f.updater.checkForUpdates.mockImplementationOnce(async () => {
      f.updater.emit("update-available", info);
    });
    expect(await f.controller.checkAutomatically()).toBe(true);
    expect(f.controller.status()).toMatchObject({ latest: "1.2.3", app: null });
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(4);
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("the owner's install of an automatically found version reports in the card", async () => {
    const f = fixture();
    f.store.write({ ...f.prefs(), auto: true });
    await f.controller.initialize();
    f.updater.checkForUpdates.mockImplementationOnce(async () => {
      f.updater.emit("update-available", info);
    });
    await f.controller.checkAutomatically();
    f.updater.downloadUpdate.mockRejectedValueOnce(new Error("offline"));
    expect(await f.controller.act("install")).toEqual({
      kind: "outcome_unknown",
      reason: "download_failed",
    });
    expect(f.controller.status()).toMatchObject({ manualCheck: true, app: { stage: "error" } });
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
