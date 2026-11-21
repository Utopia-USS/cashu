// How this install gets new versions (main's `cashu:update-install-method`): a Windows install has no
// in-app updater and is updated by hand from the releases page whose URL main pins; elsewhere the
// updater status (`updateStatus`) decides what Settings shows.
import { z } from "zod";

interface UpdateInstallBridge {
  installMethod(): Promise<unknown>;
}

declare global {
  interface Window {
    readonly cashuUpdates?: UpdateInstallBridge;
  }
}

/** A Windows install: its version and the releases page new versions are installed from. */
export interface ManualUpdates {
  readonly version: string;
  readonly releasesUrl: string;
}

const manualSchema = z.strictObject({
  kind: z.literal("manual"),
  version: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  releasesUrl: z.string().max(256),
});

/** Main's answer, or null for anything but a well-formed manual install with an https releases page. */
export function parseManualUpdates(value: unknown): ManualUpdates | null {
  const parsed = manualSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    const url = new URL(parsed.data.releasesUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return { version: parsed.data.version, releasesUrl: url.href };
  } catch {
    return null;
  }
}

/** Null outside the desktop shell, for an in-app updater, and when main cannot be asked. */
export async function readManualUpdates(): Promise<ManualUpdates | null> {
  try {
    return parseManualUpdates(await window.cashuUpdates?.installMethod());
  } catch {
    return null;
  }
}
