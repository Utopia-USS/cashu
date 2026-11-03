import type { ResearchInputs } from "@cashu/store/investments/research-screen";
import { researchScreenCommands } from "@cashu/store/investments/research-screen";
import { useCommand, useProfile } from "@cashu/store-react";
import { useForm, useStore } from "@tanstack/react-form";
// biome-ignore lint/style/noRestrictedImports: TanStack Form resets untouched fields when defaultValues identity changes; Electron101 covers the required stable form defaults.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { saveTopicSequence } from "./topic-save.js";
import type { TopicFormValues } from "./types.js";

type TopicRecord = ResearchInputs["topics"][number]["thesis"];
const commands = researchScreenCommands();

/** Owner topic writes are sequential. A changed UI scope cannot initiate the second command. */
export function useResearchTopicForm(
  topic: string | null,
  record: TopicRecord,
  privacy: boolean,
  notice: (message: string | null) => void,
) {
  const vault = useProfile();
  const saveThesis = useCommand(commands.saveTopicThesis);
  const deleteThesis = useCommand(commands.deleteTopicThesis);
  const setView = useCommand(commands.setTopicMarketView);
  const [dirty, setDirty] = useState(false);
  const thesis = record?.thesis ?? "";
  const invalidation = record?.invalidation ?? "";
  const assessment = record?.assessment ?? "";
  const outlook = record?.outlook ?? "";
  const defaultValues = useMemo(
    (): TopicFormValues => ({
      thesis,
      invalidation,
      assessment,
      outlook,
      clearSources: false,
      confirmDraft: false,
    }),
    [thesis, invalidation, assessment, outlook],
  );
  const loadedTopic = useRef(topic);
  const mounted = useRef(true);
  const scope = useRef({ vault, privacy, topic, topicEpoch: 0 });
  useLayoutEffect(() => {
    const prior = scope.current;
    scope.current = {
      vault,
      privacy,
      topic,
      topicEpoch: prior.topicEpoch + (prior.topic === topic ? 0 : 1),
    };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = async (value: TopicFormValues) => {
    if (!topic || privacy) return;
    notice(null);
    const target = { vault, topic, topicEpoch: scope.current.topicEpoch };
    const current = () =>
      mounted.current &&
      scope.current.vault === target.vault &&
      scope.current.topic === target.topic &&
      scope.current.topicEpoch === target.topicEpoch &&
      !scope.current.privacy;
    await saveTopicSequence({
      topic: target.topic,
      record,
      value,
      current,
      saveThesis: (input) => saveThesis.run(input),
      deleteThesis: (input) => deleteThesis.run(input),
      setView: (input) => setView.run(input),
      notice,
      saved: () => setDirty(false),
    });
  };
  const form = useForm({ defaultValues, onSubmit: ({ value }) => save(value) });
  const values = useStore(form.store, (state) => state.values);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  useLayoutEffect(() => {
    if (loadedTopic.current !== topic) {
      loadedTopic.current = topic;
      setDirty(false);
      form.reset(defaultValues);
      return;
    }
    if (dirty) return;
    form.reset(defaultValues);
  }, [topic, defaultValues, dirty, form]);
  return {
    values,
    setValues(next: TopicFormValues) {
      form.setFieldValue("thesis", next.thesis);
      form.setFieldValue("invalidation", next.invalidation);
      form.setFieldValue("assessment", next.assessment);
      form.setFieldValue("outlook", next.outlook);
      form.setFieldValue("clearSources", next.clearSources);
      form.setFieldValue("confirmDraft", next.confirmDraft);
      setDirty(true);
    },
    submit: () => form.handleSubmit(),
    busy: isSubmitting || saveThesis.isPending || deleteThesis.isPending || setView.isPending,
  };
}
