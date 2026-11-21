import { z } from "zod";
import { type ChangeSource, defineQuery } from "../query.js";
import type { UiAction } from "../ui-actions.js";

export type ClassifierSettingsInput =
  | { readonly op: "chooseLocal" | "revokeCloud" | "clearKey" }
  | {
      readonly op: "grantCloud";
      readonly riskCopy: "merchant-name-residual-v1";
      readonly model: string;
    }
  | { readonly op: "setKey"; readonly key: string };

export const classifierSettingsSnapshotSchema = z.discriminatedUnion("backend", [
  z.strictObject({
    backend: z.literal("ollama"),
    model: z.string().min(1).max(128),
    consented: z.literal(false),
    keyPresent: z.boolean(),
  }),
  z.strictObject({
    backend: z.literal("anthropic"),
    model: z.string().min(1).max(128),
    consented: z.literal(true),
    keyPresent: z.boolean(),
  }),
]);
export type ClassifierSettingsSnapshot = z.infer<typeof classifierSettingsSnapshotSchema>;

/** Host-owned per-vault owner action. A renderer cannot mint transport consent directly. */
export const classifierSettings: UiAction<ClassifierSettingsInput, ClassifierSettingsSnapshot> = {
  id: "core.settings.classifier",
};

/** What the host knows of a vault's classifier settings: being read, unavailable, or the checked snapshot. */
export type ClassifierSettingsState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly snapshot: ClassifierSettingsSnapshot };

/** The host's classifier settings (a host-local file plus the OS keychain), checked asynchronously per vault. */
export interface ClassifierSettingsSource {
  /** Fires when a vault's state changed (a check finished, an owner change landed, the binding was installed). */
  readonly changes: ChangeSource;
  state(vault: string): ClassifierSettingsState;
}

/** The live classifier settings of the current vault; unbound (no host binding) it answers unavailable. */
export function classifierSettingsQuery(source?: ClassifierSettingsSource) {
  return defineQuery({
    id: "core.settings.classifierSettings",
    ...(source === undefined ? {} : { changes: source.changes }),
    run(read, _args: undefined): ClassifierSettingsState {
      const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
      return vault === undefined || source === undefined
        ? { status: "unavailable" }
        : source.state(vault);
    },
  });
}

/** The query the renderer names (`useQuery(classifierSettingsState)`); the host serves its bound twin. */
export const classifierSettingsState = classifierSettingsQuery();
