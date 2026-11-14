// The payment sheet (formSheet from any Activity row, `/sheet/payment/<gid>`).
import { lang } from "@cashu/i18n";
import { PinnedProfile } from "@cashu/store-react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PaymentSheetView } from "../../../src/screens/payment/PaymentSheetView";
import { usePaymentSheet } from "../../../src/screens/payment/usePaymentSheet";
import { usePinnedVault } from "../../../src/screens/profile/switchProfile";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function PaymentSheetRoute() {
  // Pinned to the profile it opened with: nothing renders once the current profile is another one, and
  // everything under it reads that profile (`PinnedProfile`), never a later one.
  const vault = usePinnedVault();
  return vault === null ? null : (
    <PinnedProfile vault={vault}>
      <PaymentSheet vault={vault} />
    </PinnedProfile>
  );
}

function PaymentSheet({ vault }: { vault: string }) {
  const router = useRouter();
  const { gid } = useLocalSearchParams<{ gid: string }>();
  const { today } = useNow();
  const props = usePaymentSheet({
    vault,
    gid,
    lang: lang(),
    today,
    close: () => router.back(),
  });
  return <PaymentSheetView {...props} />;
}
