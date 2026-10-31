import "./core/platform"; // first: wires the language and incognito before any module reads them
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./core/App";
import { applyTheme, readTheme } from "./core/theme";
import { lang } from "@cashu/i18n";

applyTheme(readTheme()); // before the first paint, so a forced theme never flashes
document.documentElement.lang = lang();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
