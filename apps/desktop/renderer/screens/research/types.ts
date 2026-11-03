import type { ResearchInputs } from "@cashu/store/investments/research-screen";

export type ResearchNote = ResearchInputs["notes"][number];
export type ResearchRun = ResearchInputs["runs"][number];
export interface TopicFormValues {
  thesis: string;
  invalidation: string;
  assessment: string;
  outlook: string;
  clearSources: boolean;
  confirmDraft: boolean;
}
