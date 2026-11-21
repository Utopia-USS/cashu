// The research note reader (prototype `note`): the verdict tag and the meta line, the title, the note's
// paragraphs with the one quoting the thesis set apart, the sources (each opens its link) and where the
// note comes from. Reader typography: title, relaxed body text.
import { EmptyState, ListRow, NoteLine, Tag, Tile } from "@cashu/ui/native";
import { ScrollView, Text, View } from "react-native";
import { S } from "./Note.strings";
import type { NoteState } from "./useNoteScreen";

export type NoteViewProps = NoteState;

export function NoteView(props: NoteViewProps) {
  if (props.kind === "missing")
    return (
      <View className="flex-1 justify-center bg-surface">
        <EmptyState icon="doc" title={S.missing} />
      </View>
    );
  return (
    <ScrollView className="flex-1 bg-surface" contentInsetAdjustmentBehavior="automatic">
      <View className="gap-4 p-4 pb-10">
        <View className="flex-row flex-wrap items-center gap-2">
          <Tag tone={props.tag.tone}>{props.tag.text}</Tag>
          <Text className="shrink text-caption text-fg-muted">{props.meta}</Text>
        </View>
        <Text role="heading" className="text-title font-strong text-fg">
          {props.title}
        </Text>
        {props.blocks.map((block) =>
          block.kind === "quote" ? (
            <View key={block.key} className="rounded-xl border-l-2 border-accent bg-subtle p-4">
              <Text className="text-body leading-relaxed text-fg-secondary">{block.text}</Text>
            </View>
          ) : (
            <Text key={block.key} className="text-body leading-relaxed text-fg">
              {block.text}
            </Text>
          ),
        )}
        {props.sources.length > 0 && (
          <Tile title={S.sources}>
            {props.sources.map((source, i) => (
              <ListRow
                key={source.key}
                first={i === 0}
                name={source.title}
                {...(source.onPress === null ? {} : { onPress: source.onPress })}
              />
            ))}
          </Tile>
        )}
        <NoteLine icon="laptop">{props.byAgent ? S.writtenByAgent : S.writtenByYou}</NoteLine>
      </View>
    </ScrollView>
  );
}
