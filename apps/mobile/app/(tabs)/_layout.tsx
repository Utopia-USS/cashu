// The tab bar (NativeTabs): Today, Activity, Investments (only with the investments module) and Net
// worth, each a stack of its own. Switching profile re-renders the triggers with the new modules.
import { NativeTabs } from "expo-router/native-tabs";
import { S } from "../../src/shell/Shell.strings";
import { useTabs } from "../../src/shell/useTabs";

export { ErrorBoundary } from "expo-router";

export default function TabsLayout() {
  const { tabs, tint } = useTabs();
  return (
    <NativeTabs {...(tint === undefined ? {} : { tintColor: tint })}>
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
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="networth">
        <NativeTabs.Trigger.Icon sf="building.columns" md="account_balance" />
        <NativeTabs.Trigger.Label>{S.tabNetWorth}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
