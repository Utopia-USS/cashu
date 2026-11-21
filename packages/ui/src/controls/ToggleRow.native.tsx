import { Host, Switch } from "@expo/ui";
import { Pressable, Text, View } from "react-native";
import { useCSSVariable } from "uniwind";

export interface ToggleRowProps {
  /** Translated name of the setting, also the accessible name of the row. */
  label: string;
  /** Translated caption under the label. */
  sub?: string;
  value: boolean;
  onChange(value: boolean): void;
  /** Always on and dimmed: shown for honesty, never changed. */
  fixed?: boolean;
  /** Dimmed and not changeable for now; unlike `fixed` it shows `value` (e.g. until a choice is made). */
  disabled?: boolean;
}

/**
 * A setting row with a native switch (prototype `.toggle`, `.toggle.fixed`). The row is one accessible
 * switch named by its label, so VoiceOver reads the name with the state and toggles it on activate.
 */
export function ToggleRow({ label, sub, value, onChange, fixed, disabled }: ToggleRowProps) {
  const accent = useCSSVariable("--color-accent");
  const on = fixed ? true : value;
  const locked = fixed === true || disabled === true;
  return (
    <Pressable
      accessible
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={sub}
      accessibilityState={{ checked: on, disabled: locked }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "activate" && !locked) onChange(!value);
      }}
      // The whole row toggles (the iOS settings pattern), not only the switch.
      onPress={() => {
        if (!locked) onChange(!value);
      }}
      disabled={locked}
      className={`min-h-11 flex-row items-center gap-3 py-2 ${locked ? "opacity-50" : ""}`}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-body text-fg">{label}</Text>
        {sub !== undefined && <Text className="text-caption text-fg-muted">{sub}</Text>}
      </View>
      <Host matchContents {...(typeof accent === "string" ? { seedColor: accent } : {})}>
        <Switch
          value={on}
          disabled={locked}
          onValueChange={(next) => {
            if (!locked) onChange(next);
          }}
        />
      </Host>
    </Pressable>
  );
}
