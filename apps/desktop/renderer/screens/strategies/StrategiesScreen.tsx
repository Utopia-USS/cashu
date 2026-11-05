// The Strategie tab (ab24ab6 v2/Strategies.tsx): the old `.wrap.wide` page box, a toast stack for the copies and
// writes, the first-load skeleton as the Suspense fallback, the status card of the main strategy on the side.
import { useProfile } from "@cashu/store-react";
import { ToastProvider, useUiEnv } from "@cashu/ui";
import { Suspense } from "react";
import { StrategiesLoadingView, StrategiesView } from "./StrategiesView.js";
import { StrategySettings } from "./StrategySettings.js";
import { type StrategiesScreenOptions, useStrategiesScreen } from "./useStrategiesScreen.js";

export function StrategiesScreen(props: StrategiesScreenOptions) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <ToastProvider>
      <main className="mx-auto max-w-360 px-5 pb-17.5 text-base leading-normal text-fg">
        <Suspense fallback={<StrategiesLoadingView />}>
          <BoundStrategies key={`${vault}:${privacy}`} {...props} />
        </Suspense>
      </main>
    </ToastProvider>
  );
}

function BoundStrategies(props: StrategiesScreenOptions) {
  return (
    <StrategiesView
      state={useStrategiesScreen(props)}
      side={<StrategySettings side onProposalOpened={props.onProposalOpened} />}
    />
  );
}
