// Mobile validation retains Zod's exact default English messages. The Metro resolver routes only
// Zod's all-locale aggregator here; schemas, error codes, custom maps and direct locale imports
// are unchanged. UI copy has its own @cashu/i18n catalogs, independent of Zod diagnostics.
export { default as en } from "zod/v4/locales/en.js";
