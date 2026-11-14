// "Remove this copy" asks first, as removing the whole phone does: the native confirm names the one
// profile whose copy goes; only "Remove" runs it.
import { C } from "@cashu/i18n/core/common.strings";
import { Alert } from "react-native";
import { S } from "./Sync.strings";

export function confirmRemoveCopy(profile: string, remove: () => void): void {
  Alert.alert(S.removeCopyTitle(profile), S.removeCopyBody(profile), [
    { text: C.cancel, style: "cancel" },
    { text: S.removeCopyConfirm, style: "destructive", onPress: remove },
  ]);
}
