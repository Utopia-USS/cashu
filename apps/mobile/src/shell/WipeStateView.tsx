// The root's full-screen state while "Remove this phone" runs (the app's tree is unmounted meanwhile),
// and the fatal state when the copy could not be removed and rebuilt safely, or no paired profile opens
// (then the re-pair copy): only a restart helps then.
// Rendered above the services, so plain views and tokens only (no store, no privacy environment).
import { Text, View } from "react-native";
import { S as Sync } from "../sync/Sync.strings";
import { S } from "./Shell.strings";
import { S as W } from "./Wipe.strings";

export interface WipeStateViewProps {
  phase: "wiping" | "failed";
  /**
   * Why the root failed (`lastServicesFailure`): no paired profile opens (`no_vault`,
   * `paired_vaults_unlisted`) says so with the re-pair copy instead of the wipe's failure text.
   */
  failure?: string | undefined;
}

/** Root failures a re-pairing repairs (no paired profile could be opened). */
const NO_PROFILE = new Set(["no_vault", "paired_vaults_unlisted", "needs_repair"]);

export function WipeStateView({ phase, failure }: WipeStateViewProps) {
  const failedText =
    failure !== undefined && NO_PROFILE.has(failure) ? Sync.noProfileOpens : W.failed;
  return (
    <View testID="wipe-state" className="flex-1 items-center justify-center gap-3 bg-surface px-4">
      <Text role="heading" className="text-title text-fg">
        {S.appName}
      </Text>
      <Text
        accessibilityLiveRegion="polite"
        className={`text-center text-body ${phase === "failed" ? "text-negative" : "text-fg-muted"}`}
      >
        {phase === "failed" ? failedText : W.wiping}
      </Text>
    </View>
  );
}
