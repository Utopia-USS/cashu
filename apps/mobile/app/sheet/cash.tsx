// The cash expense sheet (formSheet from Activity's "Cash" button); it closes itself once saved.
import { lang } from "@cashu/i18n";
import { useRouter } from "expo-router";
import { CashSheetView } from "../../src/screens/cash/CashSheetView";
import { useCashSheet } from "../../src/screens/cash/useCashSheet";
import { useNow } from "../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function CashSheetRoute() {
  const router = useRouter();
  const { today } = useNow();
  const props = useCashSheet({ today, lang: lang(), close: () => router.back() });
  return <CashSheetView {...props} />;
}
