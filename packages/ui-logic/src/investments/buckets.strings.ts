// Texts of the shared bucket helpers (packages/ui-logic/src/investments/buckets.ts). See
// docs/agents/localization.md.
import { catalog } from "@cashu/i18n";

/** Expression bucket functions over a non-generic bucket, shown as a phrase instead of the call. */
export const BUCKET_FN = catalog({
  bucket_weight: { pl: "waga koszyka", en: "bucket weight" },
  bucket_target: { pl: "cel koszyka", en: "bucket target" },
  bucket_drift_pp: { pl: "dryf koszyka", en: "bucket drift" },
  bucket_value: { pl: "wartość koszyka", en: "bucket value" },
});
