import { createTranslator, type Lang } from "@cashu/i18n";

/** Worker copy uses the vault's explicit language, independent of the renderer locale. */
export function connectorProposalSummary(language: Lang, name: string): string {
  return createTranslator(language).tr({
    pl: `Import z konektora ${name}`,
    en: `Import from connector ${name}`,
  });
}
