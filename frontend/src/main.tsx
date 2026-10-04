import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./core/App";
import { applyTheme, readTheme } from "./core/theme";

applyTheme(readTheme()); // before the first paint, so a forced theme never flashes

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
