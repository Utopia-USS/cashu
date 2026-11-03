import { lang } from "@cashu/i18n";
import {
  researchScreenCommands,
  researchScreenQueries,
} from "@cashu/store/investments/research-screen";
import { useCommand, useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useEffect, useRef, useState } from "react";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { useDurableCommands } from "../useDurableCommand.js";
import { AssetResearchSection } from "./AssetResearchSection.js";
import { researchAssetModel } from "./presentation.js";

const queries = researchScreenQueries();
const commands = researchScreenCommands();
export function AssetResearchBlock({
  instrument,
  held,
  noteGid,
  onOpenNote,
}: {
  instrument: string;
  held: boolean;
  noteGid?: string | null;
  onOpenNote(gid: string): void;
}) {
  const vault = useProfile();
  const { privacy } = useUiEnv();
  return (
    <BoundAssetResearch
      key={`${vault}:${privacy}:${instrument}`}
      instrument={instrument}
      held={held}
      noteGid={noteGid}
      onOpenNote={onOpenNote}
    />
  );
}
function BoundAssetResearch(props: Parameters<typeof AssetResearchBlock>[0]) {
  const today = useCalendarDay();
  const { privacy } = useUiEnv();
  const data = useQuery(queries.screen, { today, lang: lang() });
  const mark = useCommand(commands.markRead);
  const durable = useDurableCommands();
  const started = useRef(false);
  const [older, setOlder] = useState(false);
  const model = researchAssetModel(data, props.instrument, props.held, today, props.noteGid, older);
  useEffect(() => {
    if (started.current || privacy || (data.status !== "current" && data.status !== "partial"))
      return;
    if (!data.notes.some((row) => row.instrument_id === props.instrument && row.unread)) return;
    started.current = true;
    void durable.run(`mark:${props.instrument}`, mark, { instrument: props.instrument });
  }, [data, privacy, props.instrument, mark, durable]);
  return model === null ? null : (
    <AssetResearchSection
      model={model}
      privacy={privacy}
      onOpenNote={props.onOpenNote}
      onShowOlder={() => setOlder(true)}
    />
  );
}
