import { installLanguageSource, lang } from "@cashu/i18n";
import { S as Connection } from "@cashu/i18n/core/hostConnection.strings";
import { installIncognitoStore } from "@cashu/ui-logic/core/incognito";
import { createRoot } from "react-dom/client";
import "@cashu/ui/theme.css";
import { desktopClient } from "./port.js";
import { BootstrapView } from "./shell/BootstrapView.js";

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
let bootstrapping = true;
try {
  const [{ App }, client] = await Promise.all([
    import("./App.js"),
    desktopClient((status) => {
      if (bootstrapping)
        renderer.render(
          <BootstrapView phase="waiting" status={Connection[status]} onRetried={retry} />,
        );
    }),
  ]);
  bootstrapping = false;
  renderer.render(<App client={client} />);
  window.addEventListener("pagehide", () => client.dispose(), { once: true });
} catch {
  bootstrapping = false;
  renderer.render(<BootstrapView phase="failed" onRetried={retry} />);
}
