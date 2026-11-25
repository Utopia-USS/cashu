// The scaffold's debug screen: store and fixture status, live table counts, sync status, crypto
// self-test. Pure: everything arrives through props from useDebugScreen.
import { type ChartTip, Donut, type DonutSegment, LineChart, Sparkline } from "@cashu/ui/native";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { S } from "./Debug.strings";
import { Button, Line, Section } from "./parts";

export interface DebugLoad {
  readonly firstLaunch: boolean;
  readonly events: number;
  /** The fixture build time; null after a rebuild (nothing was applied). */
  readonly applyMs: string | null;
  /** The rebuild from the log; null on the first launch (the build ran no rebuild). */
  readonly rebuild: {
    readonly ms: string;
    readonly matches: boolean;
    /** The view hash (hex) after the rebuild; compared with Node's by the S41 run. */
    readonly viewHash: string;
  } | null;
}

export interface DebugViewProps {
  readonly vault: string;
  readonly openMs: string;
  /** SQLCipher's version of this launch's database files; null when they are not encrypted. */
  readonly cipherVersion: string | null;
  readonly load: DebugLoad | null;
  readonly tables: readonly { readonly table: string; readonly rows: number }[];
  readonly cursors: number;
  readonly needsUpgrade: boolean;
  readonly unfoldedTypes: number;
  /** Month-end balances of the main demo account (oldest first), for the sparkline. */
  readonly balanceTrend: readonly number[];
  /** Month labels under the balance line (by data index). */
  readonly balanceMonths: readonly { readonly i: number; readonly text: string }[];
  /** Axis label and tooltip of the balance line, formatted by the screen hook. */
  readonly balanceAxis: (v: number) => string;
  readonly balanceTip: (i: number) => ChartTip;
  /** Outflows per PLN account (shares of one currency only), for the donut. */
  readonly spendingByAccount: readonly DonutSegment[];
  /** The crypto self-test panel (it suspends on its own until the test has run). */
  readonly cryptoPanel: ReactNode;
  readonly rebuilding: boolean;
  readonly onRebuild: () => void;
  readonly onOpenBench: () => void;
}

export function DebugView(props: DebugViewProps) {
  const { vault, openMs, load, tables, cursors, needsUpgrade, unfoldedTypes, cryptoPanel } = props;
  const { balanceTrend, balanceMonths, balanceAxis, balanceTip, spendingByAccount } = props;
  return (
    <ScrollView className="flex-1 bg-surface">
      <View className="gap-3 p-4">
        <Text className="text-caption text-fg-muted">{S.synthetic}</Text>
        <Section title={S.store}>
          <Line label={S.vault} value={vault.slice(0, 8)} />
          <Line label={S.openMs} value={S.ms(openMs)} />
          <Line
            label={S.storage}
            value={props.cipherVersion === null ? S.notEncrypted : S.sqlcipher(props.cipherVersion)}
          />
        </Section>
        <Section title={S.fixture}>
          {load === null ? (
            <Text className="text-body text-fg-secondary">{S.reopened}</Text>
          ) : (
            <>
              <Text className="text-body text-fg-secondary">
                {load.firstLaunch ? S.firstLaunch : S.rebuild}
              </Text>
              <Line label={S.events} value={String(load.events)} />
              {load.applyMs === null ? null : <Line label={S.applyMs} value={S.ms(load.applyMs)} />}
              {load.rebuild === null ? null : (
                <>
                  <Line label={S.rebuildMs} value={S.ms(load.rebuild.ms)} />
                  <Line label={S.viewHash} value={load.rebuild.viewHash.slice(0, 16)} />
                  <Line
                    label={load.rebuild.matches ? S.rebuildMatch : S.rebuildMismatch}
                    value={load.rebuild.matches ? S.pass : S.fail}
                    tone={load.rebuild.matches ? "positive" : "negative"}
                  />
                </>
              )}
            </>
          )}
          <Button label={S.rebuild} onPress={props.onRebuild} disabled={props.rebuilding} />
        </Section>
        <Section title={S.charts}>
          <Text className="text-body text-fg-secondary">{S.balanceTrend}</Text>
          <Sparkline values={[...balanceTrend]} label={S.balanceTrend} />
          <LineChart
            label={S.balanceTrend}
            series={[{ values: [...balanceTrend], area: true, name: S.balance }]}
            xLabels={[...balanceMonths]}
            yFormat={balanceAxis}
            valueKind="amount"
            height={160}
            tooltip={balanceTip}
          />
          <Text className="mt-2 text-body text-fg-secondary">{S.spendingByAccount}</Text>
          <Donut
            label={S.spendingByAccount}
            segments={[...spendingByAccount]}
            size={160}
            layout="self-center"
          />
        </Section>
        <Section title={S.tables}>
          {tables.map((t) => (
            <Line key={t.table} label={t.table} value={String(t.rows)} />
          ))}
        </Section>
        <Section title={S.sync}>
          <Text className="text-body text-fg-secondary">{S.carrierNone}</Text>
          <Line label={S.cursors} value={String(cursors)} />
          <Line
            label={needsUpgrade ? S.needsUpgrade : S.upToDate}
            value={needsUpgrade ? S.fail : S.pass}
            tone={needsUpgrade ? "negative" : "positive"}
          />
          <Line label={S.unfolded} value={String(unfoldedTypes)} />
        </Section>
        {cryptoPanel}
        <Button label={S.bench} onPress={props.onOpenBench} />
      </View>
    </ScrollView>
  );
}
