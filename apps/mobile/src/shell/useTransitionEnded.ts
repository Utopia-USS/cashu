// Whether the current screen's presentation finished: the native stack's `transitionEnd` (not closing)
// for this route, which react-native-screens emits once the screen appeared (on iOS after the modal's
// presentation animation, `viewDidAppear`). A screen that was not animated in (the first route, a
// remount that restores it) may never hear the event, so a fallback ends the wait after
// `TRANSITION_FALLBACK_MS`. Used before asking for a system permission: its prompt is drawn over
// whatever is on screen, and a modal still sliding in shows nothing yet.
import { useNavigation } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import type { ParamListBase } from "expo-router/react-navigation";
import { useEffect, useState } from "react";

/** The longest wait for `transitionEnd` (a modal's presentation takes ~350-500 ms on iOS). */
const TRANSITION_FALLBACK_MS = 1000;

export function useTransitionEnded(): boolean {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (ended) return;
    const off = navigation.addListener("transitionEnd", (event) => {
      if (!event.data.closing) setEnded(true);
    });
    const timer = setTimeout(() => setEnded(true), TRANSITION_FALLBACK_MS);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [navigation, ended]);
  return ended;
}
