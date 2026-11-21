// Mountable strategy status card (ab24ab6 v2/StrategySettings.tsx): the Strategie tab's side column and
// Ustawienia > Agent AI. First load = the old title row and a 60px skeleton.
import { S } from "@cashu/i18n/investments/v2/StrategySettings.strings";
import { Skeleton } from "@cashu/ui";
import { Suspense } from "react";
import { StrategySettingsView } from "./StrategySettingsView.js";
import { type StrategySettingsOptions, useStrategySettings } from "./useStrategySettings.js";

function Bound(props: StrategySettingsOptions) {
  return <StrategySettingsView state={useStrategySettings(props)} />;
}

export function StrategySettings(props: StrategySettingsOptions) {
  return (
    <Suspense
      fallback={
        <div className={props.side ? "" : "mt-4.5"}>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <strong className="text-md">{S.title}</strong>
          </div>
          <Skeleton height={60} />
        </div>
      }
    >
      <Bound {...props} />
    </Suspense>
  );
}
