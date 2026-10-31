// Browser wiring of the platform-free packages (@cashu/i18n, @cashu/ui-logic): the UI language pin and the
// incognito flag live in browser storage (a convenience: every access is guarded), the OS language list comes
// from `navigator.languages` (WKWebView takes it from macOS), and a language change reloads the page.
// main.tsx imports this module first, so it runs before any module reads the language at import.
import { installLanguageSource } from "@cashu/i18n";
import { installIncognitoStore } from "@cashu/ui-logic/core/incognito";
import { readStored } from "./storage.ts";

const LANG_KEY = "cashu.lang";
const INCOGNITO_KEY = "cashu.incognito";

installLanguageSource({
  pinned: () => readStored(globalThis.localStorage, LANG_KEY),
  systemTags: () => {
    const nav = globalThis.navigator as Navigator | undefined;
    if (!nav) return [];
    return nav.languages?.length ? [...nav.languages] : nav.language ? [nav.language] : [];
  },
  pin: (choice) => {
    try {
      if (choice === null) globalThis.localStorage?.removeItem(LANG_KEY);
      else globalThis.localStorage?.setItem(LANG_KEY, choice);
    } catch { /* storage unavailable: the choice holds until the reload */ }
    globalThis.location?.reload();
  },
});

installIncognitoStore({
  load: () => readStored(globalThis.localStorage, INCOGNITO_KEY) === "1",
  save: (on) => globalThis.localStorage?.setItem(INCOGNITO_KEY, on ? "1" : "0"),
});
