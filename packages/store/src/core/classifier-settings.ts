import { z } from "zod";
import type { UiAction } from "../ui-actions.js";

export type ClassifierSettingsInput =
  | { readonly op: "status" | "chooseLocal" | "revokeCloud" | "clearKey" }
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
