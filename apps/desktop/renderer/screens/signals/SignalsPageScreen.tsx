// The investments sub-pages of the routes `investments.alerts`, `investments.journal` and `investments.watchlist`
// (ab24ab6 v2/Home.tsx sub-routes `alerts`, `journal`, `watch`): the old `.wrap.wide` page box with a toast stack,
// then the ported alerts manager, decision journal or the watchlist widget with its search open.
import { useProfile } from "@cashu/store-react";
import { ToastProvider, useUiEnv } from "@cashu/ui";
import { useInvestmentsHomeData } from "../investments/home/useInvestmentsHomeData.js";
import { AlertsManagerScreen } from "./AlertsManagerScreen.js";
import { JournalScreen } from "./JournalScreen.js";
import { WatchlistWidgetScreen } from "./WatchlistScreens.js";

export type SignalsSubPage = "alerts" | "watchlist" | "journal";

interface Props {
  page: SignalsSubPage;
  /** `?instrument=<gid>`: the journal's instrument filter, the new alert's instrument. */
  initialInstrument?: string | null;
  /** `?newAlert=1`: the alerts form as a new alert (the default without `edit`). */
  initialNewAlert?: boolean;
  /** `?edit=<gid>`: the alert in the form. */
  initialEdit?: string | null;
  /** Back to the investments Home (the crumb). */
  onClose?(): void;
  onOpenAsset?(gid: string): void;
  /** The route also hands these over; the old alerts / journal / watch pages had no review or note link. */
  onOpenReview?(): void;
  onOpenNote?(note: string | null): void;
}

function downloadCsv(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function Watchlist({ onOpen }: { onOpen(gid: string): void }) {
  const data = useInvestmentsHomeData({ filter: null });
  return <WatchlistWidgetScreen data={data} autoAdd onOpen={onOpen} />;
}

function Page(props: Props) {
  const back = () => props.onClose?.();
  const open = (gid: string) => props.onOpenAsset?.(gid);
  if (props.page === "alerts")
    return (
      <AlertsManagerScreen
        initialInstrument={props.initialInstrument}
        initialEdit={props.initialEdit}
        onBack={back}
        onExportCsv={downloadCsv}
      />
    );
  if (props.page === "journal")
    return (
      <JournalScreen initialInstrument={props.initialInstrument} onBack={back} onOpenAsset={open} />
    );
  return <Watchlist onOpen={open} />;
}

export function SignalsPageScreen(props: Props) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <ToastProvider>
      <main
        data-testid={`native-signals-${props.page}`}
        className="mx-auto max-w-360 px-5 pb-17.5 text-base leading-normal text-fg"
      >
        <Page
          key={`${vault}:${privacy}:${props.page}:${props.initialInstrument ?? ""}:${props.initialEdit ?? ""}`}
          {...props}
        />
      </main>
    </ToastProvider>
  );
}
