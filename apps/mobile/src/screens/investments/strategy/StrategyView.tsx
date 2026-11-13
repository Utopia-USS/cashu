// Pure Strategy view of the Investments tab (prototype "Strategy subtab", read only): the strategy
// document as written on the Mac with its "active" and "updated" tags, what watches it (each rule with
// "ok" or "fired", and the live alerts), and the note that changes are approved on the Mac.

import { formatCalendarDate } from "@cashu/i18n/values";
import { Markdown, NoteLine, Tag, Tile, useUiEnv } from "@cashu/ui/native";
import { Text, View } from "react-native";
import type { StrategyViewProps } from "../investments-contracts";
import { S } from "./Strategy.strings";

export function StrategyView(props: StrategyViewProps) {
  const { locale } = useUiEnv();
  return (
    <View className="gap-3">
      <Tile>
        {props.document === null ? (
          <View className="gap-2">
            <Text className="text-title font-heavy text-fg">{S.noStrategyYet}</Text>
            <NoteLine icon="laptop">{S.writeOnMac}</NoteLine>
          </View>
        ) : (
          <View className="gap-3">
            <View className="flex-row flex-wrap items-center gap-2">
              <Tag tone="info">{S.active}</Tag>
              <Text className="text-caption text-fg-muted">
                {S.updated(formatCalendarDate(props.document.updated, locale))}
              </Text>
            </View>
            <Markdown blocks={props.document.blocks} />
          </View>
        )}
      </Tile>
      {props.document !== null && (
        <Tile title={S.watches} meta={S.rulesAndAlerts(props.rules.length, props.alertsCount)}>
          {props.rules.length === 0 ? (
            <Text className="text-body text-fg-muted">{S.noRules}</Text>
          ) : (
            props.rules.map((rule, i) => (
              <View
                key={rule.id}
                className={`flex-row items-center gap-3 py-2.5 ${i === 0 ? "" : "border-t border-border"}`}
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-body font-demi text-fg">{rule.name}</Text>
                  <Text className="text-caption text-fg-muted">{rule.kind}</Text>
                </View>
                <Tag tone={rule.tag.tone}>{rule.tag.label}</Tag>
              </View>
            ))
          )}
        </Tile>
      )}
      <NoteLine icon="laptop">{S.readOnlyHere}</NoteLine>
    </View>
  );
}
