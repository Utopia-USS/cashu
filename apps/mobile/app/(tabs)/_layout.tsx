// The tab bar (NativeTabs): Today, Activity, Investments (only with the investments module; a dot while
// an action signal waits for a decision) and Net worth, each a stack of its own. Switching profile
// re-renders the triggers with the new modules. The dot is the accent colour, selected or not: it means
// "waiting for your decision", not an error (its size is the system's).
import { useProfile } from "@cashu/store-react";
import { useNavigation } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useEffect, useRef } from "react";
import {
  decisionsWaiting,
  useInvestmentSignals,
} from "../../src/screens/investments/useInvestmentSignals";
import { freshNavigationState, takePreparedSwitch } from "../../src/screens/profile/switchProfile";
import { S } from "../../src/shell/Shell.strings";
import { useTabs } from "../../src/shell/useTabs";

export { ErrorBoundary } from "expo-router";

export default function TabsLayout() {
  const { tabs, tint } = useTabs();
  const waiting = decisionsWaiting(useInvestmentSignals());
  // A profile switch starts the other profile fresh: the tab tree is keyed by the current vault (every
  // screen remounts, so no local state such as an account filter carries over), and the navigation is
  // reset as a switch leaves it (`freshNavigationState`): every sheet and modal above the tabs goes and
  // each tab opens on its root (a remounted navigator would otherwise restore the previous profile's
  // pushed pages). The selected tab stays. The app's one switch (`useSwitchProfile`) already did this
  // before it switched, so this runs only for a switch from anywhere else (the services' fallback).
  const vault = useProfile();
  const navigation = useNavigation();
  const shown = useRef(vault);
  useEffect(() => {
    if (shown.current === vault) return;
    shown.current = vault;
    if (takePreparedSwitch(vault)) return;
    const root = navigation.getState();
    if (root === undefined) return;
    navigation.dispatch({ type: "RESET", payload: freshNavigationState(root) });
  }, [vault, navigation]);
  return (
    <NativeTabs
      key={vault}
      {...(tint === undefined ? {} : { tintColor: tint, badgeBackgroundColor: tint })}
    >
      <NativeTabs.Trigger name="today">
        <NativeTabs.Trigger.Icon sf="calendar" md="calendar_today" />
        <NativeTabs.Trigger.Label>{S.tabToday}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon sf="list.bullet" md="list" />
        <NativeTabs.Trigger.Label>{S.tabActivity}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="investments" hidden={!tabs.includes("investments")}>
        <NativeTabs.Trigger.Icon sf="chart.line.uptrend.xyaxis" md="trending_up" />
        <NativeTabs.Trigger.Label>{S.tabInvestments}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge
          hidden={waiting === 0}
          {...(tint === undefined ? {} : { selectedBackgroundColor: tint })}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="networth">
        <NativeTabs.Trigger.Icon sf="building.columns" md="account_balance" />
        <NativeTabs.Trigger.Label>{S.tabNetWorth}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
