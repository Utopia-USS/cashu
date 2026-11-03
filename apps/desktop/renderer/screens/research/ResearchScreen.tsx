import { useProfile } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { ResearchView } from "./ResearchView.js";
import { type ResearchScreenOptions, useResearchScreen } from "./useResearchScreen.js";

export function ResearchScreen(props: Omit<ResearchScreenOptions, "today" | "copyCommand">) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return <BoundResearch key={`${vault}:${privacy}`} {...props} />;
}
function BoundResearch(props: Parameters<typeof ResearchScreen>[0]) {
  return (
    <ResearchView
      state={useResearchScreen({
        ...props,
        today: useCalendarDay(),
        copyCommand: (text) => navigator.clipboard.writeText(text),
      })}
    />
  );
}
