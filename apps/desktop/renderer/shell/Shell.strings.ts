// Texts of the desktop shell's header and tab bar that the Python app had (ab24ab6 core/chrome.strings.ts:
// ProfileMenu, IncognitoToggle, Shell). See docs/agents/localization.md.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  brand: { pl: "cashU", en: "cashU" },
  profiles: { pl: "Profile", en: "Profiles" },
  newProfile: { pl: "Nowy profil…", en: "New profile…" },
  showAmounts: { pl: "Pokaż kwoty", en: "Show amounts" },
  notConfiguredTitle: { pl: "Nieskonfigurowany", en: "Not set up" },
});
