import type { UpdateStatus } from "@cashu/store/device";
import { z } from "zod";

export type UpdateAction = "check" | "install" | "skip" | "dismiss" | "auto";
export type UpdateOutcome = {
  readonly kind: "completed" | "refused" | "outcome_unknown";
  readonly reason?: string;
};
export interface UpdateInfo {
  readonly version: string;
  readonly files?: readonly { readonly url: string; readonly sha512?: string }[];
}
type EventCallback = (...args: unknown[]) => void;
export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, callback: EventCallback): void;
  off(event: string, callback: EventCallback): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export interface UpdatePreferences {
  /**
   * "Sprawdzaj codziennie" (Settings > Updates): the automatic check shortly after launch and once a
   * day (schedule.ts). It only reports a found version; nothing is downloaded or installed before the
   * owner presses "Aktualizuj" (the retired Python app's Sparkle: automatic checks on, automatic
   * updates off). On by default.
   */
  readonly auto: boolean;
  readonly skippedVersion: string | null;
  readonly dismissedVersion: string | null;
}
export interface PreferenceStore {
  read(): UpdatePreferences;
  write(value: UpdatePreferences): void;
}
export interface UpdateAuthority {
  /** Recheck signed, installed bundle and fixed release config at every privileged action. */
  check(): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /** Ready owns the durable barrier and HostLock until install dispatch or explicit cancellation. */
  handover(targetVersion: string): Promise<
    | {
        readonly kind: "ready";
        cancel(): Promise<boolean>;
        commitDispatch(): Promise<"committed" | "prepared" | "unknown">;
      }
    | { readonly kind: "refused" | "unknown" }
  >;
}

const updateFileSchema = z.looseObject({
  sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  url: z
    .string()
    .max(180)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(zip|dmg)$/)
    .refine((url) => !url.includes("..")),
});
/**
 * The zips of one release: one per architecture at most. A release lists the arm64 zip (its name
 * contains "arm64") and the x64 zip (its name does not); electron-updater's MacUpdater keeps the
 * "arm64" file on Apple silicon and the others elsewhere. A single zip of either kind is accepted.
 */
function releaseZipsValid(files: readonly { readonly url: string }[]): boolean {
  const zips = files.filter((file) => file.url.endsWith(".zip"));
  const arm64 = zips.filter((file) => file.url.includes("arm64")).length;
  return zips.length >= 1 && zips.length <= 2 && arm64 <= 1 && zips.length - arm64 <= 1;
}

/** electron-updater's info for the feed's release: one or two zips plus optional dmgs, all hashed. */
const updateInfoSchema = z.looseObject({
  version: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  files: z.array(updateFileSchema).min(1).max(8).refine(releaseZipsValid),
});
const progressSchema = z.looseObject({ percent: z.number() });

/** The renderer only receives UpdateStatus and actions; no feed URL or downloaded path crosses it. */
export class UpdateController {
  private stage: NonNullable<Extract<UpdateStatus, { availability: "ready" }>["app"]> | null = null;
  private latest: string | null = null;
  private downloaded: string | null = null;
  private availableFiles: string | null = null;
  private downloadingVersion: string | null = null;
  private busy = false;
  private installing = false;
  /** True only when the last install attempt cannot have published a handover barrier. */
  private installRetrySafe = false;
  private available = false;
  private disposed = false;
  /** Who started the current stage's check: an automatic check shows no checking / result card. */
  private checkOrigin: "manual" | "automatic" = "manual";
  private generation = 0;
  private lifetime = 0;
  private readonly subscriptions: { event: string; callback: EventCallback }[] = [];
  private readonly listeners = new Set<() => void>();

  private readonly updater: UpdaterPort;
  private readonly authority: UpdateAuthority;
  private readonly preferences: PreferenceStore;
  private readonly current: string;

  constructor(
    updater: UpdaterPort,
    authority: UpdateAuthority,
    preferences: PreferenceStore,
    current: string,
  ) {
    this.updater = updater;
    this.authority = authority;
    this.preferences = preferences;
    this.current = current;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    const listen = (event: string, callback: EventCallback) => {
      const guarded: EventCallback = (...args) => {
        if (!this.disposed) callback(...args);
      };
      updater.on(event, guarded);
      this.subscriptions.push({ event, callback: guarded });
    };
    listen("checking-for-update", () => {
      if (this.busy && this.stage?.stage === "checking") this.setStage("checking");
    });
    listen("update-not-available", () => {
      if (this.stage?.stage !== "checking") return;
      this.latest = null;
      this.downloaded = null;
      this.availableFiles = null;
      this.downloadingVersion = null;
      this.setStage("up_to_date");
    });
    listen("update-available", (value) => {
      if (this.stage?.stage !== "checking") return;
      const parsed = updateInfoSchema.safeParse(value);
      if (!parsed.success) {
        this.downloaded = null;
        this.availableFiles = null;
        this.downloadingVersion = null;
        this.setStage("error", "invalid_update_metadata");
        return;
      }
      const info = parsed.data;
      this.latest = info.version;
      this.availableFiles = JSON.stringify(info.files);
      this.downloaded = null;
      this.downloadingVersion = null;
      this.setStage("available", undefined, info.version);
    });
    listen("download-progress", (value) => {
      if (this.stage?.stage !== "downloading") return;
      const progress = progressSchema.safeParse(value);
      if (!progress.success) return;
      this.stage = { ...this.stage, progress: Math.max(0, Math.min(100, progress.data.percent)) };
      this.emit();
    });
    listen("update-downloaded", (value) => {
      const parsed = updateInfoSchema.safeParse(value);
      if (!parsed.success) return;
      const info = parsed.data;
      if (
        info.version !== this.latest ||
        info.version !== this.downloadingVersion ||
        JSON.stringify(info.files) !== this.availableFiles ||
        this.stage?.stage === "error"
      )
        return;
      this.downloaded = info.version;
      this.downloadingVersion = null;
      this.setStage("available", undefined, info.version);
    });
    listen("error", () => {
      if (!this.busy) return;
      this.downloaded = null;
      this.downloadingVersion = null;
      this.setStage("error", "update_failed");
    });
  }

  onChange(callback: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  status(): UpdateStatus {
    if (!this.available || this.disposed) return { availability: "unavailable" };
    let hidden = false;
    let autoCheck: boolean;
    try {
      const prefs = this.preferences.read();
      hidden = this.isHidden(prefs);
      autoCheck = prefs.auto;
    } catch {
      return { availability: "unavailable" };
    }
    return {
      availability: "ready",
      current: this.current,
      latest: this.latest,
      url: null,
      branchAvailable: false,
      manualCheck: this.checkOrigin === "manual",
      autoCheck,
      app: hidden && this.stage?.stage === "available" ? null : this.stage,
    };
  }

  private isHidden(prefs: UpdatePreferences): boolean {
    return (
      this.latest !== null &&
      (prefs.skippedVersion === this.latest || prefs.dismissedVersion === this.latest)
    );
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.lifetime++;
    for (const { event, callback } of this.subscriptions) this.updater.off(event, callback);
    this.subscriptions.length = 0;
    this.listeners.clear();
  }

  private emit(): void {
    if (!this.disposed) for (const callback of this.listeners) callback();
  }
  private setStage(
    stage: NonNullable<typeof this.stage>["stage"],
    error: string | undefined = undefined,
    version = this.latest,
  ): void {
    this.stage = { stage, version, progress: null, error: error ?? null };
    this.emit();
  }

  private async download(): Promise<UpdateOutcome> {
    if (!this.latest || this.stage?.stage === "error")
      return { kind: "refused", reason: "no_verified_update" };
    const lifetime = this.lifetime;
    const gate = await this.authority.check();
    if (!this.alive(lifetime)) return { kind: "outcome_unknown", reason: "interrupted" };
    if (!gate.ok) return { kind: "refused", reason: gate.reason };
    this.downloadingVersion = this.latest;
    const generation = ++this.generation;
    this.setStage("downloading");
    try {
      await this.updater.downloadUpdate();
      if (!this.alive(lifetime) || generation !== this.generation)
        return { kind: "outcome_unknown", reason: "interrupted" };
      return this.downloaded === this.latest
        ? { kind: "completed" }
        : { kind: "outcome_unknown", reason: "download_unconfirmed" };
    } catch {
      if (!this.alive(lifetime)) return { kind: "outcome_unknown", reason: "interrupted" };
      this.downloadingVersion = null;
      this.setStage("error", "download_failed");
      return { kind: "outcome_unknown", reason: "download_failed" };
    }
  }

  /** One feed check (the gate already passed); `origin` decides whether its stages show a card. */
  private async runCheck(origin: "manual" | "automatic", lifetime: number): Promise<UpdateOutcome> {
    const generation = ++this.generation;
    this.checkOrigin = origin;
    this.setStage("checking");
    try {
      await this.updater.checkForUpdates();
      if (!this.alive(lifetime) || generation !== this.generation)
        return { kind: "outcome_unknown", reason: "interrupted" };
      return this.stage?.stage === "error"
        ? { kind: "refused", reason: this.stage.error ?? "invalid_update_metadata" }
        : { kind: "completed" };
    } catch {
      if (this.alive(lifetime)) this.setStage("error", "check_failed");
      return { kind: "outcome_unknown", reason: "check_failed" };
    }
  }

  /**
   * The scheduled check (schedule.ts): only with "Sprawdzaj codziennie" on, never while another
   * action runs, never over a visible found version, a download or an install. A found version
   * appears like a manual find (the update card) and waits for the owner; its own checking,
   * up-to-date and error stages show no card. Resolves true when the feed was asked; never throws.
   */
  async checkAutomatically(): Promise<boolean> {
    if (this.disposed || !this.available || this.busy || this.installing) return false;
    let prefs: UpdatePreferences;
    try {
      prefs = this.preferences.read();
    } catch {
      return false;
    }
    const stage = this.stage?.stage;
    if (
      !prefs.auto ||
      stage === "checking" ||
      stage === "downloading" ||
      stage === "installing" ||
      this.downloaded !== null ||
      (stage === "available" && !this.isHidden(prefs))
    )
      return false;
    this.busy = true;
    const lifetime = this.lifetime;
    try {
      const gate = await this.authority.check();
      if (!this.alive(lifetime)) return false;
      if (!gate.ok) {
        this.available = false;
        this.emit();
        return false;
      }
      await this.runCheck("automatic", lifetime);
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Must complete before this status is exposed through the host provider. */
  async initialize(): Promise<void> {
    const lifetime = this.lifetime;
    try {
      const gate = await this.authority.check();
      if (!this.alive(lifetime)) return;
      this.available = gate.ok;
    } catch {
      if (!this.alive(lifetime)) return;
      this.available = false;
    }
    this.emit();
  }

  private alive(lifetime: number): boolean {
    return !this.disposed && this.lifetime === lifetime;
  }

  canRetryInstallAfterAttempt(): boolean {
    return !this.disposed && !this.installing && this.installRetrySafe;
  }

  async act(action: UpdateAction, enabled?: boolean): Promise<UpdateOutcome> {
    if (!["check", "install", "skip", "dismiss", "auto"].includes(action))
      return { kind: "refused", reason: "invalid_input" };
    if (this.disposed || !this.available)
      return { kind: "refused", reason: "capability_unavailable" };
    if (this.busy || this.installing) return { kind: "refused", reason: "busy" };
    this.busy = true;
    if (action === "install") {
      this.installRetrySafe = true;
      // The owner follows this update now: its download and install stages report in the card.
      this.checkOrigin = "manual";
    }
    const lifetime = this.lifetime;
    try {
      if (action === "auto") {
        if (typeof enabled !== "boolean") return { kind: "refused", reason: "invalid_input" };
        const prefs = this.preferences.read();
        this.preferences.write({ ...prefs, auto: enabled });
        this.emit();
        return { kind: "completed" };
      }
      if (action === "skip" || action === "dismiss") {
        if (!this.latest) return { kind: "refused", reason: "no_update" };
        const prefs = this.preferences.read();
        this.preferences.write({
          ...prefs,
          [action === "skip" ? "skippedVersion" : "dismissedVersion"]: this.latest,
        });
        this.emit();
        return { kind: "completed" };
      }
      const gate = await this.authority.check();
      if (!this.alive(lifetime)) return { kind: "outcome_unknown", reason: "interrupted" };
      if (!gate.ok) {
        this.available = false;
        this.emit();
        return { kind: "refused", reason: gate.reason };
      }
      if (action === "check") return await this.runCheck("manual", lifetime);
      if (this.downloaded !== this.latest || !this.downloaded) {
        const download = await this.download();
        if (!this.alive(lifetime)) return { kind: "outcome_unknown", reason: "interrupted" };
        if (download.kind !== "completed") return download;
      }
      if (!this.downloaded) return { kind: "outcome_unknown", reason: "download_unconfirmed" };
      const lastGate = await this.authority.check();
      if (!this.alive(lifetime)) return { kind: "outcome_unknown", reason: "interrupted" };
      if (!lastGate.ok) return { kind: "refused", reason: lastGate.reason };
      this.installRetrySafe = false;
      const handover = await this.authority.handover(this.downloaded);
      if (handover.kind !== "ready") {
        if (handover.kind === "refused") this.installRetrySafe = true;
        return {
          kind: handover.kind === "unknown" ? "outcome_unknown" : "refused",
          reason: "handover_not_ready",
        };
      }
      const cancel = async () => {
        try {
          const cancelled = await handover.cancel();
          if (cancelled) this.installRetrySafe = true;
          return cancelled;
        } catch {
          return false;
        }
      };
      if (!this.alive(lifetime)) {
        await cancel();
        return { kind: "outcome_unknown", reason: "interrupted" };
      }
      let finalGate: Awaited<ReturnType<UpdateAuthority["check"]>>;
      try {
        finalGate = await this.authority.check();
      } catch {
        await cancel();
        return { kind: "outcome_unknown", reason: "final_gate_unknown" };
      }
      if (!this.alive(lifetime)) {
        await cancel();
        return { kind: "outcome_unknown", reason: "interrupted" };
      }
      if (!finalGate.ok) {
        const cancelled = await cancel();
        return cancelled
          ? { kind: "refused", reason: finalGate.reason }
          : { kind: "outcome_unknown", reason: "cancellation_unknown" };
      }
      let dispatch: "committed" | "prepared" | "unknown";
      try {
        dispatch = await handover.commitDispatch();
      } catch {
        return { kind: "outcome_unknown", reason: "dispatch_commit_unknown" };
      }
      if (dispatch === "prepared") {
        const cancelled = await cancel();
        return cancelled
          ? { kind: "refused", reason: "dispatch_not_committed" }
          : { kind: "outcome_unknown", reason: "cancellation_unknown" };
      }
      if (dispatch !== "committed" || !this.alive(lifetime))
        return { kind: "outcome_unknown", reason: "dispatch_commit_unknown" };
      this.installing = true;
      this.setStage("installing");
      if (!this.alive(lifetime)) return { kind: "outcome_unknown", reason: "interrupted" };
      this.updater.quitAndInstall(false, true);
      return { kind: "outcome_unknown", reason: "install_dispatched" };
    } catch {
      return { kind: "outcome_unknown", reason: "unexpected_failure" };
    } finally {
      this.busy = false;
    }
  }
}
