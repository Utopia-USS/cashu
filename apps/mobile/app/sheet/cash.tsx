// The cash expense sheet (formSheet from Activity's "Cash" button); it closes itself once saved.
import { lang } from "@cashu/i18n";
import { PinnedProfile } from "@cashu/store-react";
import { useRouter } from "expo-router";
import { CashSheetView } from "../../src/screens/cash/CashSheetView";
import { useCashSheet } from "../../src/screens/cash/useCashSheet";
import { usePinnedVault } from "../../src/screens/profile/switchProfile";
import { useNow } from "../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function CashSheetRoute() {
  // Pinned to the profile it opened with: nothing renders once the current profile is another one, and
  // everything under it reads that profile (`PinnedProfile`), never a later one.
  const vault = usePinnedVault();
  return vault === null ? null : (
    <PinnedProfile vault={vault}>
      <CashSheet vault={vault} />
    </PinnedProfile>
  );
}

function CashSheet({ vault }: { vault: string }) {
  const router = useRouter();
  const { today } = useNow();
  const props = useCashSheet({ vault, today, lang: lang(), close: () => router.back() });
  return <CashSheetView {...props} />;
}
