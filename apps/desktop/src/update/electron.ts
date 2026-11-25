import { autoUpdater } from "electron-updater";
import {
  type PreferenceStore,
  type UpdateAuthority,
  UpdateController,
  type UpdaterPort,
} from "./controller.js";

/** Called only from Electron main after packaged identity and lifecycle wiring are available. */
export function createElectronUpdateController(
  authority: UpdateAuthority,
  preferences: PreferenceStore,
  currentVersion: string,
): UpdateController {
  // electron-builder resolves the fixed, sealed Resources/app-update.yml itself. No setFeedURL call.
  return new UpdateController(autoUpdater as UpdaterPort, authority, preferences, currentVersion);
}
