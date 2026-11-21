/// <reference types="node" />
import { createRequire } from "node:module";
import { join } from "node:path";
import type { MainProcessAgentBridge } from "./mac.js";

const require = createRequire(import.meta.url);

/** Fixed in-bundle binding, loaded only by trusted Electron main. */
export function nativeMacAgentBridge(resourcesPath: string): MainProcessAgentBridge | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return require(
      join(resourcesPath, "native", "CashUHostService.node"),
    ) as MainProcessAgentBridge;
  } catch {
    return undefined;
  }
}
