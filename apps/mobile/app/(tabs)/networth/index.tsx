import { useRouter } from "expo-router";
import { NetWorthView } from "../../../src/screens/networth/NetWorthView";
import { useNetWorthScreen } from "../../../src/screens/networth/useNetWorthScreen";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function NetWorthRoute() {
  const router = useRouter();
  const { today } = useNow();
  const props = useNetWorthScreen({
    today,
    openLoan: (gid) => router.push({ pathname: "/(tabs)/networth/loan/[gid]", params: { gid } }),
    openProfile: () => router.push("/sheet/profile"),
  });
  return <NetWorthView {...props} />;
}
