// Texts of the desktop renderer's link to the local host (the background service that runs the store),
// one per connection status of @cashu/store-react (`useConnection`), plus the stale-data note shown
// while the link is down. See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  connecting: {
    pl: "Łączenie z usługą w tle…",
    en: "Connecting to the background service…",
  },
  starting: {
    pl: "Uruchamianie usługi w tle…",
    en: "Starting the background service…",
  },
  unavailable: {
    pl: "cashU nie może uruchomić usługi w tle. Próbuję ponownie…",
    en: "cashU could not start its background service. Retrying…",
  },
  recovered: { pl: "Połączenie przywrócone.", en: "Connection restored." },
  online: { pl: "Połączono.", en: "Connected." },
  stale: {
    pl: "Pokazane dane mogą być nieaktualne.",
    en: "The data shown may be out of date.",
  },
});
