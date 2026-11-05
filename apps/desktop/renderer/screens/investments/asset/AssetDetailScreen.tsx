// The asset detail mountables (ab24ab6 v2/Home.tsx:402-427): the drawer over the Home (`assets/{id}`, AssetDrawer +
// AssetDetail "drawer") and the page (`assets/{id}?page=1`, `nav.crumb` + AssetDetail "page"). Both read their
// own data through useAssetDetail (the Home's query arguments, so the cache entries are shared) and keep the
// first load inside a Suspense fallback.
import { S as D } from "@cashu/i18n/investments/v2/AssetDrawer.strings";
import { S as H } from "@cashu/i18n/investments/v2/Home.strings";
import { Crumb, DetailDrawer, HealthPill, Skeleton } from "@cashu/ui";
import type { Position, Thesis } from "@cashu/ui-logic/investments/types";
import { type ReactNode, Suspense } from "react";
import { AlertRow } from "../../signals/AlertRowView.js";
import { alertRowProps } from "../../signals/alertsModel.js";
import { PositionDecisionScreen } from "../../signals/SignalsDialogScreen.js";
import { useRemoveAlert } from "../../signals/useRemoveAlert.js";
import { gidOf } from "../home/legacyWire.js";
import { AssetDetailView } from "./AssetDetailView.js";
import { AssetResearchView } from "./AssetResearchView.js";
import type { AssetMode } from "./assetModel.js";
import { useAssetDetail, useAssetName } from "./useAssetDetail.js";

/** The old AssetDetail callbacks (Home.tsx:403-411; A3's drawer contract shapes). */
interface AssetActions {
  /** `+ Alert` / `+ Nowy`: the alerts manager with a new alert for the instrument. */
  onNewAlert(instrument: string): void;
  /** `+ Transakcja`: the transaction drawer preset to the instrument. */
  onAddTxn(instrumentId: number): void;
  /** `n transakcji` in the meta line. */
  onTxns(position: Position): void;
  /** Teza `Edytuj` / `Dodaj`. */
  onThesis(inst: { id: number; label: string }, thesis: Thesis | null): void;
  /** `dziennik` of Sygnały i decyzje: the journal filtered to the instrument. */
  onJournal(instrument: string): void;
  /** `wszystkie` of Alerty: the alerts manager filtered to the instrument. */
  onAlerts(instrument: string): void;
  /** `notatka` of a research signal, a reason line of the recommendation (old ctx.onOpenNote). */
  onOpenNote?(instrument: string, note: string | null, segment: string | null): void;
}

interface CommonProps extends AssetActions {
  /** The instrument gid. */
  instrument: string;
  /** The Home's account filter (a legacy account id); null = all. */
  filter: number | null;
  /** `?note=` of the deep link (a research note gid). */
  noteGid?: string | null;
}

export interface AssetDrawerScreenProps extends CommonProps {
  onClose(): void;
  /** `otwórz jako stronę`. */
  onPage(): void;
  /** The crumb: `home` = Inwestycje, `assets` = Aktywa (close and scroll to the asset list). */
  onCrumb(where: "home" | "assets"): void;
}

export interface AssetPageScreenProps extends CommonProps {
  /** The crumb steps Inwestycje / Aktywa. */
  onBack(): void;
  /** `otwórz w panelu`: the same detail as the drawer over the Home. */
  onPanel(): void;
}

function Loading({ mode }: { mode: AssetMode }) {
  return (
    <div className="grid gap-4">
      <Skeleton height={92} radius="widget" />
      <Skeleton height={mode === "drawer" ? 260 : 300} radius="widget" />
    </div>
  );
}

function Detail(props: CommonProps & { mode: AssetMode }) {
  const st = useAssetDetail({
    instrument: props.instrument,
    filter: props.filter,
    mode: props.mode,
    noteGid: props.noteGid,
  });
  const m = st.model;
  const pill = st.thesisPill;
  const removeAlert = useRemoveAlert();
  const research: ReactNode =
    st.researchShown && !st.privacy ? (
      <AssetResearchView model={st.researchModel} ui={st.research} />
    ) : null;
  const openNote = props.onOpenNote
    ? (noteId: number | null, segment: string | null) =>
        props.onOpenNote?.(props.instrument, gidOf(noteId), segment)
    : undefined;
  return (
    <AssetDetailView
      model={m}
      mode={props.mode}
      ui={{
        ...st.ui,
        onNewAlert: () => props.onNewAlert(props.instrument),
        onAddTxn: () => props.onAddTxn(m.id),
        onTxns: () => {
          if (m.position) props.onTxns(m.position);
        },
        onThesis: () => props.onThesis({ id: m.id, label: m.instrumentLabel }, m.thesis),
        onAlerts: () => props.onAlerts(props.instrument),
        onJournal: () => props.onJournal(props.instrument),
        onOpenNote: openNote,
      }}
      slots={{
        thesisTags: pill ? <HealthPill {...pill} /> : null,
        research,
        // Old Alerts.tsx AlertRow (compact) per live alert; agent alerts removable with undo.
        alertRows: m.live.map((a) => (
          <AlertRow
            key={a.id}
            {...alertRowProps(a, {
              compact: true,
              onRemove: a.source === "agent" ? () => removeAlert(a) : undefined,
            })}
          />
        )),
        // Old Decide.tsx PositionDecisionDialog over the detail (`Zanotuj decyzję`).
        decision: st.decideOpen ? (
          <PositionDecisionScreen
            data={st.data}
            instrumentId={m.id}
            signals={m.undecided}
            thesis={m.thesis}
            onClose={st.closeDecide}
          />
        ) : null,
      }}
    />
  );
}

/** The asset drawer over the Home (old AssetDrawer + AssetDetail "drawer"). Mount it inside the Home's
 * ToastProvider. */
export function AssetDrawerScreen(props: AssetDrawerScreenProps) {
  return (
    <Suspense fallback={null}>
      <DrawerBound {...props} />
    </Suspense>
  );
}

function DrawerBound({ onClose, onPage, onCrumb, ...props }: AssetDrawerScreenProps) {
  const name = useAssetName(props.instrument, props.filter);
  return (
    <DetailDrawer
      name={name}
      crumbLabel={D.breadcrumb}
      root={D.investments}
      section={D.assets}
      onCrumb={(where) => onCrumb(where === "home" ? "home" : "assets")}
      onClose={onClose}
      pageLink={{ label: D.openAsPage, onPress: onPage }}
    >
      <Suspense fallback={<Loading mode="drawer" />}>
        <Detail key={props.instrument} {...props} mode="drawer" />
      </Suspense>
    </DetailDrawer>
  );
}

/** The asset page (old Home.tsx:412-421: `nav.crumb` + AssetDetail "page"): the Home renders it in place of
 * its grid, inside its page box and toasts, and shares its drawers. */
export function AssetPage(props: AssetPageScreenProps) {
  return (
    <Suspense fallback={<Loading mode="page" />}>
      <PageBound {...props} />
    </Suspense>
  );
}

function PageBound({ onBack, onPanel, ...props }: AssetPageScreenProps) {
  const name = useAssetName(props.instrument, props.filter);
  return (
    <>
      <Crumb
        label={H.breadcrumb}
        items={[
          { label: H.investments, onPress: onBack },
          { label: H.assets, onPress: onBack },
          { label: name },
        ]}
        endLink={{ label: H.openInPanel, onPress: onPanel }}
      />
      <Suspense fallback={<Loading mode="page" />}>
        <Detail key={props.instrument} {...props} mode="page" />
      </Suspense>
    </>
  );
}
