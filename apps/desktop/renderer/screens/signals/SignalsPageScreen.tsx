// The investments sub-pages of the routes `investments.alerts` and `investments.journal` (ab24ab6 v2/Home.tsx
// sub-routes `alerts`, `journal`): the old `.wrap.wide` page box with a toast stack, then the ported alerts manager
// or decision journal. `investments.watchlist` (old `watch`) is the Home itself, Obserwowane tab with the search open.
import { useProfile } from "@cashu/store-react";
import { ToastProvider, useUiEnv } from "@cashu/ui";
import { AlertsManagerScreen } from "./AlertsManagerScreen.js";
import { JournalScreen } from "./JournalScreen.js";

/** The investments sub-pages the Home navigates to (`watchlist` = the Home on its Obserwowane tab). */
export type SignalsSubPage = "alerts" | "watchlist" | "journal";

interface Props {
  page: "alerts" | "journal";
  /** `?instrument=<gid>`: the journal's instrument filter. */
  initialInstrument?: string | null;
  /** `?edit=<gid>`: the alert in the edit form. */
  initialEdit?: string | null;
  /** Back to the investments Home (the crumb). */
  onClose?(): void;
  onOpenAsset?(gid: string): void;
  /** The route also hands these over; the old alerts / journal pages had no review or note link. */
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

function Page(props: Props) {
  const back = () => props.onClose?.();
  const open = (gid: string) => props.onOpenAsset?.(gid);
  if (props.page === "alerts")
    return (
      <AlertsManagerScreen
        initialEdit={props.initialEdit}
        onBack={back}
        onExportCsv={downloadCsv}
      />
    );
  return (
    <JournalScreen initialInstrument={props.initialInstrument} onBack={back} onOpenAsset={open} />
  );
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
