// "Remove this phone" at the root: the state while the copy is removed and the fatal state when it could
// not be. PL + EN.
import { catalog } from "@cashu/i18n";

export const S = catalog({
  wiping: { pl: "Usuwanie kopii z tego telefonu...", en: "Removing this phone's copy..." },
  failed: {
    pl: "Coś poszło nie tak przy usuwaniu kopii z tego telefonu. Zamknij cashU i otwórz ponownie.",
    en: "Something went wrong removing this phone's copy. Close cashU and open it again.",
  },
});
