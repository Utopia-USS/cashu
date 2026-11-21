// The app lock: the lock screen and the system prompts. PL + EN.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  unlock: { pl: "Odblokuj", en: "Unlock" },
  failed: {
    pl: "Nie udało się potwierdzić. Spróbuj ponownie.",
    en: "Could not verify. Try again.",
  },
  unavailable: {
    pl: "Ustaw Face ID lub kod w Ustawieniach iOS i spróbuj ponownie.",
    en: "Set up Face ID or a passcode in iOS Settings, then try again.",
  },
  promptUnlock: { pl: "Odblokuj cashU", en: "Unlock cashU" },
  promptLockOn: { pl: "Potwierdź, żeby włączyć blokadę", en: "Confirm to turn on the lock" },
  promptLockOff: { pl: "Potwierdź, żeby wyłączyć blokadę", en: "Confirm to turn off the lock" },
  usePasscode: { pl: "Wprowadź kod", en: "Use passcode" },
});
