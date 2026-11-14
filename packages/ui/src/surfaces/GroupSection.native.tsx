// A grouped settings-style section on the phone (the sheets and the settings screens): a quiet caption,
// optionally with an accent note on its right, above the content on the raised surface with 12 pt
// corners, as iOS groups rows. `grouped={false}` lays the content out under the caption as it is (a
// quote, a picker, a field), for a section whose rows are not a list; a nested caption-less GroupSection
// then groups the part that is.
import type { ReactNode } from "react";
import { Text, View } from "react-native";

export interface GroupSectionProps {
  /** The caption (a heading for assistive technology); none for a group of its own. */
  title?: string;
  /** Right of the caption, in the accent colour: "Suggested: Groceries". Needs a title. */
  meta?: string | null;
  /** Default true: the content sits on the rounded raised surface. */
  grouped?: boolean;
  children: ReactNode;
}

export function GroupSection({ title, meta, grouped = true, children }: GroupSectionProps) {
  return (
    <View className="gap-2">
      {title !== undefined && (
        <View className="flex-row items-center justify-between gap-2 px-1">
          <Text role="heading" className="shrink text-caption font-demi text-fg-muted">
            {title}
          </Text>
          {meta != null && <Text className="shrink text-caption text-accent">{meta}</Text>}
        </View>
      )}
      {grouped ? <View className="rounded-xl bg-surface-raised px-4">{children}</View> : children}
    </View>
  );
}
