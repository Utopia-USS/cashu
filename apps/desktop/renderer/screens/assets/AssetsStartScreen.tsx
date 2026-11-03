import { profileIdentity } from "@cashu/store/overview";
import { useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useEffect, useRef } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { useAssetDrawer } from "../overview/useAssetDrawer.js";
import { AssetsStartView } from "./AssetsStartView.js";

export function AssetsStartScreen({ onSaved }: { onSaved: () => void }) {
  const vault = useProfile();
  return <AssetsStartBound key={vault} onSaved={onSaved} />;
}
function AssetsStartBound({ onSaved }: { onSaved: () => void }) {
  const today = useCalendarDay();
  const profile = useQuery(profileIdentity);
  const { privacy } = useUiEnv();
  const state = useAssetDrawer(today, profile?.baseCurrency ?? "PLN");
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
      baseCurrency={profile?.baseCurrency ?? "PLN"}
      privacy={privacy}
      onOverviewOpened={onSaved}
    />
  );
}
