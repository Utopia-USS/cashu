import type { TranslationVariants } from "@cashu/i18n";
import { HELP } from "./help.strings.js";

type Text = TranslationVariants<string>;

export function commandHelp(parts: readonly string[]): Text | undefined {
  const [group, child, action] = parts;
  if (!group) return undefined;
  const deep = child && action ? HELP[`${group} ${child} ${action}`] : undefined;
  if (deep) return deep;
  const nested = child ? HELP[`${group} ${child}`] : undefined;
  if (nested) return nested;
  if (group === "budget" && child && HELP[child]) {
    const alias = HELP[child];
    return {
      pl: alias.pl.replace("cashu ", "cashu budget "),
      en: alias.en.replace("cashu ", "cashu budget "),
    };
  }
  return HELP[group];
}
