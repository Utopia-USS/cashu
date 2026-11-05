// The `setup/assets` route body (ab24ab6 modules/assets/Start.tsx): the page box, the first steps on the native
// asset rows (live queries replace the old 5 s setup poll) and the shared add drawer; after the first save the
// page hands over to Przegląd (old: Przegląd with the Majątek widget ringed).
import { S as A } from "@cashu/i18n/assets/index.strings";
import { profileIdentity } from "@cashu/store/overview";
import { useProfile, useQuery } from "@cashu/store-react";
import { Page, useUiEnv } from "@cashu/ui";
import { type ReactNode, Suspense, useEffect, useRef } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { useAssetDrawer } from "../overview/useAssetDrawer.js";
import { AssetsStartView } from "./AssetsStartView.js";

export interface AssetsStartScreenProps {
  /** After a save: Przegląd. */
  onSaved(): void;
  /** `Instrukcja Claude Code i CLI`: the module's setup guide (`setup/assets/cli`). */
  onGuide(): void;
  /** The Agent AI widget beside the steps. */
  agent?: ReactNode;
}

export function AssetsStartScreen(props: AssetsStartScreenProps) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <Page width="narrow" label={A.name} testID="native-assets-start">
      <Suspense
        fallback={
          <AssetsStartView
            state={null}
            today=""
            baseCurrency=""
            privacy={privacy}
            aside={props.agent}
            onGuide={props.onGuide}
          />
        }
      >
        <AssetsStartBound key={vault} {...props} />
      </Suspense>
    </Page>
  );
}

function AssetsStartBound({ onSaved, onGuide, agent }: AssetsStartScreenProps) {
  const today = useCalendarDay();
  const profile = useQuery(profileIdentity);
  const { privacy } = useUiEnv();
  const base = profile?.baseCurrency ?? "PLN";
  const state = useAssetDrawer(today, base);
  const prior = useRef(state.rows.length);
  const saving = useRef(false);
  const drawer = {
    ...state,
    submit: async () => {
      saving.current = true;
      await state.submit();
    },
  };
  useEffect(() => {
    if (saving.current && state.rows.length > prior.current) {
      prior.current = state.rows.length;
      saving.current = false;
      onSaved();
    } else prior.current = state.rows.length;
  }, [state.rows.length, onSaved]);
  return (
    <AssetsStartView
      state={drawer}
      today={today}
      baseCurrency={base}
      privacy={privacy}
      aside={agent}
      onGuide={onGuide}
    />
  );
}
