// The research page mountable (ab24ab6 research/index.tsx `page`, route `research`): the Home renders it in place of
// its grid, inside its page box and toasts, and keeps its drawers.
import { ResearchPageView } from "./ResearchPageView.js";
import { type ResearchPageOptions, useResearchPage } from "./useResearchPage.js";

export function ResearchPageScreen(props: ResearchPageOptions) {
  const { model, ui } = useResearchPage(props);
  return <ResearchPageView model={model} ui={ui} />;
}
