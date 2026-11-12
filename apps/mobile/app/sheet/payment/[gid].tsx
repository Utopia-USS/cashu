// The payment sheet (formSheet from any Activity row, `/sheet/payment/<gid>`).
import { lang } from "@cashu/i18n";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PaymentSheetView } from "../../../src/screens/payment/PaymentSheetView";
import { usePaymentSheet } from "../../../src/screens/payment/usePaymentSheet";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function PaymentSheetRoute() {
  const router = useRouter();
  const { gid } = useLocalSearchParams<{ gid: string }>();
  const { today } = useNow();
  const props = usePaymentSheet({
    gid,
    lang: lang(),
    today,
    close: () => router.back(),
  });
  return <PaymentSheetView {...props} />;
}
