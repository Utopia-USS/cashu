import { Suspense } from "react";
import { CryptoView } from "../src/screens/debug/CryptoView";
import { DebugView } from "../src/screens/debug/DebugView";
import { useCryptoPanel } from "../src/screens/debug/useCryptoPanel";
import { useDebugScreen } from "../src/screens/debug/useDebugScreen";

export { ErrorBoundary } from "expo-router";

function CryptoPanel() {
  return <CryptoView {...useCryptoPanel()} />;
}

export default function DebugRoute() {
  const props = useDebugScreen(
    <Suspense>
      <CryptoPanel />
    </Suspense>,
  );
  return <DebugView {...props} />;
}
