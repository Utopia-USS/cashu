import { useUiEnv } from "@cashu/ui";
import { Button, Column, Picker, Row } from "@expo/ui";
import { Text, View } from "react-native";
import { ControlHost } from "./ControlHost";
import { S } from "./Controls.strings";
import {
  choosePeriodKind,
  isPeriodKind,
  type PeriodPickerProps,
  stepPeriod,
} from "./periodSelection";

export function PeriodPicker({
  period,
  periodBounds,
  onPeriodChange,
  testID = "money-period",
}: PeriodPickerProps) {
  const { locale } = useUiEnv();
  const previous = stepPeriod(period, periodBounds, -1);
  const next = stepPeriod(period, periodBounds, 1);
  const label =
    period.kind === "all"
      ? S.all
      : period.kind === "year"
        ? String(period.year)
        : period.kind === "quarter"
          ? S.quarterValue(period.quarter, period.year)
          : new Intl.DateTimeFormat(locale, {
              year: "numeric",
              month: "long",
              timeZone: "UTC",
            }).format(
              new Date(
                `${String(period.year).padStart(4, "0")}-${String(period.month).padStart(2, "0")}-01T12:00:00Z`,
              ),
            );
  return (
    <View className="gap-2">
      <Text className="text-body text-fg-secondary">{S.period}</Text>
      <Text className="text-body text-fg" accessibilityLiveRegion="polite">
        {label}
      </Text>
      <ControlHost>
        <Column>
          <Picker
            selectedValue={period.kind}
            enabled={periodBounds !== null}
            testID={`${testID}-kind`}
            onValueChange={(kind) => {
              if (!isPeriodKind(kind) || kind === period.kind) return;
              const selected = choosePeriodKind(kind, period, periodBounds);
              if (selected !== null) onPeriodChange(selected);
            }}
          >
            {(["all", "year", "quarter", "month"] as const).map((kind) => (
              <Picker.Item key={kind} value={kind} label={S[kind]} />
            ))}
          </Picker>
          <Row>
            <Button
              label={S.previous}
              variant="text"
              disabled={previous === null}
              testID={`${testID}-previous`}
              onPress={() => {
                if (previous !== null) onPeriodChange(previous);
              }}
            />
            <Button
              label={S.next}
              variant="text"
              disabled={next === null}
              testID={`${testID}-next`}
              onPress={() => {
                if (next !== null) onPeriodChange(next);
              }}
            />
          </Row>
        </Column>
      </ControlHost>
    </View>
  );
}
