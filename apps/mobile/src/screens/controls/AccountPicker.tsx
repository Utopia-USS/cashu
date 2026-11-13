// The account picker of Activity's filter row: "Account" (any) or one of the vault's budget accounts.
// The selected option's label is the control's visible (and accessible) name.
import { Picker } from "@expo/ui";
import { View } from "react-native";
import { ControlHost } from "./ControlHost";
import { S } from "./Controls.strings";

/** The "no account" value of the picker. */
const ANY_ACCOUNT = "";

export interface AccountPickerProps {
  readonly options: readonly { readonly gid: string; readonly name: string }[];
  readonly selected: string | null;
  readonly onPicked: (gid: string | null) => void;
  /** The "any account" option's label (default "Account"). */
  readonly anyLabel?: string;
  readonly testID?: string;
}

export function AccountPicker({
  options,
  selected,
  onPicked,
  anyLabel = S.account,
  testID = "activity-account",
}: AccountPickerProps) {
  return (
    <View className="justify-center">
      <ControlHost inline>
        <Picker
          selectedValue={selected ?? ANY_ACCOUNT}
          testID={testID}
          onValueChange={(next) => {
            const gid = next === ANY_ACCOUNT ? null : String(next);
            if (gid !== selected) onPicked(gid);
          }}
        >
          <Picker.Item value={ANY_ACCOUNT} label={anyLabel} />
          {options.map((option) => (
            <Picker.Item key={option.gid} value={option.gid} label={option.name} />
          ))}
        </Picker>
      </ControlHost>
    </View>
  );
}
