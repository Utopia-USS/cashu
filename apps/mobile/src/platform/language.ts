// The phone's LanguageSource (@cashu/i18n): the OS preference list from expo-localization, the pin in a
// small file of the app's documents directory (the device-local settings table replaces it once the
// store has one), and a pin change reloads the JS bundle so module-level formatters follow it.
import { installLanguageSource, type Lang } from "@cashu/i18n";
import { reloadAppAsync } from "expo";
import { File, Paths } from "expo-file-system";
import { getLocales } from "expo-localization";

const pinFile = () => new File(Paths.document, "language-pin.txt");

export function installMobileLanguage(): void {
  installLanguageSource({
    pinned() {
      const f = pinFile();
      return f.exists ? f.textSync().trim() : null;
    },
    systemTags() {
      return getLocales().map((l) => l.languageTag);
    },
    pin(choice: Lang | null) {
      const f = pinFile();
      if (choice === null) {
        if (f.exists) f.delete();
        void reloadAppAsync();
        return;
      }
      if (!f.exists) f.create();
      f.writeSync(choice);
      void reloadAppAsync();
    },
  });
}

/** Delete the language pin (the phone wipe); the language follows the system from the next launch. */
export function deleteLanguagePin(): void {
  const f = pinFile();
  if (f.exists) f.delete();
}
