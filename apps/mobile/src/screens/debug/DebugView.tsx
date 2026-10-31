// The scaffold's debug screen: store and fixture status, live table counts, sync status, crypto
// self-test. Pure: everything arrives through props from useDebugScreen.
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { S } from "./Debug.strings";

export interface DebugLoad {
  readonly firstLaunch: boolean;
  readonly events: number;
  readonly applyMs: string;
  readonly rebuildMs: string;
  readonly rebuildMatches: boolean;
  /** The view hash (hex) after the rebuild; compared with Node's by the S41 run. */
  readonly viewHash: string;
}

interface DebugCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly code?: string;
}

export interface DebugViewProps {
  readonly vault: string;
  readonly openMs: string;
  readonly load: DebugLoad | null;
  readonly tables: readonly { readonly table: string; readonly rows: number }[];
  readonly cursors: number;
  readonly needsUpgrade: boolean;
  readonly unfoldedTypes: number;
  readonly crypto: {
    readonly ok: boolean;
    readonly checks: readonly DebugCheck[];
    readonly nativeAead: string;
  };
  readonly rebuilding: boolean;
  readonly onRebuild: () => void;
  readonly onOpenBench: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-1 rounded-lg bg-surface-raised p-4">
      <Text role="heading" className="text-title font-strong text-fg">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  const valueClass =
    tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-fg";
  return (
    <View className="flex-row justify-between gap-3">
      <Text className="shrink text-body text-fg-secondary">{label}</Text>
      <Text className={`text-body font-strong tabular-nums ${valueClass}`}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled === true}
      disabled={disabled}
      onPress={onPress}
      className="mt-2 items-center rounded-md bg-accent px-4 py-3"
    >
      <Text className="text-body font-strong text-fg-inverse">{label}</Text>
    </Pressable>
  );
}

export function DebugView(props: DebugViewProps) {
  const { vault, openMs, load, tables, cursors, needsUpgrade, unfoldedTypes, crypto } = props;
  return (
    <ScrollView className="flex-1 bg-surface">
      <View className="gap-3 p-4">
        <Text className="text-caption text-fg-muted">{S.synthetic}</Text>
        <Section title={S.store}>
          <Line label={S.vault} value={vault.slice(0, 8)} />
          <Line label={S.openMs} value={S.ms(openMs)} />
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
              <Line label={S.applyMs} value={S.ms(load.applyMs)} />
              <Line label={S.rebuildMs} value={S.ms(load.rebuildMs)} />
              <Line
                label={load.rebuildMatches ? S.rebuildMatch : S.rebuildMismatch}
                value={load.rebuildMatches ? S.pass : S.fail}
                tone={load.rebuildMatches ? "positive" : "negative"}
              />
            </>
          )}
          <Button label={S.rebuild} onPress={props.onRebuild} disabled={props.rebuilding} />
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
        <Section title={S.crypto}>
          <Line
            label={crypto.ok ? S.cryptoOk : S.cryptoFailed}
            value={crypto.ok ? S.pass : S.fail}
            tone={crypto.ok ? "positive" : "negative"}
          />
          {crypto.checks.map((c) => (
            <Line
              key={c.name}
              label={c.name}
              value={c.ok ? S.pass : `${S.fail} ${c.code ?? ""}`}
              tone={c.ok ? "positive" : "negative"}
            />
          ))}
          <Line label={S.nativeAead} value={crypto.nativeAead} />
        </Section>
        <Button label={S.bench} onPress={props.onOpenBench} />
      </View>
    </ScrollView>
  );
}
