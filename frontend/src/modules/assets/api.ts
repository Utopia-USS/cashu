// Assets module endpoints (profile-scoped, F7 OB5): the manually valued positions with their note.
import type { Account } from "../../core/api";
import { jdel, jpatch, jpost, j, pp } from "../../core/api";
import type { Depreciation } from "./logic";

/** GET /assets/manual row: the core account row + kind + note (the net-worth rows carry no note); a vehicle
 * carries its depreciation terms (F7 merge contract; null / absent otherwise or on an older server). */
export interface ManualAsset extends Account {
  kind: "manual" | "vehicle" | string;
  note: string | null;
  depreciation?: Depreciation | null;
}

export const getManualAssets = (slug: string) => j<ManualAsset[]>(pp(slug, "/assets/manual"));
export const postManualAsset = (slug: string, body: Record<string, unknown>) => jpost<ManualAsset>(pp(slug, "/assets/manual"), body);
export const patchManualAsset = (slug: string, id: number, body: Record<string, unknown>) =>
  jpatch<ManualAsset>(pp(slug, `/assets/manual/${id}`), body);
/** Remove a position from the profile's view (net worth, history, lists); kept for `restore` (F7 merge). */
export const deleteManualAsset = (slug: string, id: number) => jdel<{ id: number; removed: boolean }>(pp(slug, `/assets/manual/${id}`));
/** Bring a removed position back (no time window). */
export const restoreManualAsset = (slug: string, id: number) => jpost<ManualAsset>(pp(slug, `/assets/manual/${id}/restore`));
