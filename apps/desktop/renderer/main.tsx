import { installLanguageSource, lang } from "@cashu/i18n";
import { S as Connection } from "@cashu/i18n/core/hostConnection.strings";
import { devicePreferences, setDevicePreferences } from "@cashu/store/device";
import { DEVICE_TARGET } from "@cashu/store-react/client";
import { installIncognitoStore } from "@cashu/ui-logic/core/incognito";
import { createRoot } from "react-dom/client";
import "@cashu/ui/theme.css";
import { desktopClient } from "./port.js";
import { readRecoveryReport, recoveryBridge } from "./recoveryBridge.js";
import { BootstrapView } from "./shell/BootstrapView.js";
import { RecoveryScreen } from "./shell/RecoveryScreen.js";

installLanguageSource({
  pinned: () => localStorage.getItem("cashu.lang"),
  systemTags: () => navigator.languages,
  pin: (choice) => {
    if (choice === null) localStorage.removeItem("cashu.lang");
    else localStorage.setItem("cashu.lang", choice);
    location.reload();
  },
});
document.documentElement.lang = lang();
installIncognitoStore({
  load: () => localStorage.getItem("cashu.incognito") === "1",
  save: (value) => localStorage.setItem("cashu.incognito", value ? "1" : "0"),
});
const root = document.getElementById("root");
if (root === null) throw new Error("renderer root is missing");
const renderer = createRoot(root);
const retry = () => location.reload();
renderer.render(<BootstrapView phase="waiting" onRetried={retry} />);
// Electron main loads `?recovery=1` when it found the old app's data before the first profile, or the
// host recorded a typed failure; that screen needs no host and opens no store channel.
if (new URL(location.href).searchParams.get("recovery") === "1") {
  renderer.render(<RecoveryScreen report={await readRecoveryReport()} bridge={recoveryBridge()} />);
} else {
  let bootstrapping = true;
  try {
    const client = await desktopClient((status) => {
      if (bootstrapping)
        renderer.render(
          <BootstrapView phase="waiting" status={Connection[status]} onRetried={retry} />,
        );
    });
    try {
      const entry = client.entry(DEVICE_TARGET, devicePreferences, undefined);
      await entry.ready;
      const snapshot = entry.getSnapshot();
      if (snapshot.status === "value") {
        const preferences = snapshot.value;
        const olderPin = localStorage.getItem("cashu.lang");
        let pinned =
          preferences.languagePin === "system"
            ? null
            : (preferences.languagePin ??
              (olderPin === "pl" || olderPin === "en" ? olderPin : null));
        if (preferences.languagePin === null && pinned !== null) {
          const migrated = await client.run(DEVICE_TARGET, setDevicePreferences, {
            languagePin: pinned,
          });
          if (migrated.kind === "completed") localStorage.removeItem("cashu.lang");
        }
        installLanguageSource({
          pinned: () => pinned,
          systemTags: () => navigator.languages,
          pin: (choice) => {
            pinned = choice;
            location.reload();
          },
        });
        // A pin changed outside this window (`cashu language`, the agent during setup) reloads it
        // into that language, so the window never shows another language than the host and agent.
        entry.subscribe(() => {
          const next = entry.getSnapshot();
          if (next.status !== "value") return;
          const pin = next.value.languagePin;
          const wanted = pin === "pl" || pin === "en" ? pin : null;
          if (wanted === pinned) return;
          pinned = wanted;
          location.reload();
        });
        document.documentElement.lang = lang();
        document.documentElement.classList.toggle("dark", preferences.theme === "dark");
        document.documentElement.classList.toggle("light", preferences.theme === "light");
      }
    } catch {
      // A preference read failure leaves the system language/theme and the store connection usable.
    }
    const { App } = await import("./App.js");
    bootstrapping = false;
    renderer.render(<App client={client} />);
    window.addEventListener("pagehide", () => client.dispose(), { once: true });
  } catch {
    bootstrapping = false;
    renderer.render(<BootstrapView phase="failed" onRetried={retry} />);
  }
}
