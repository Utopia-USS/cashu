// Pure Signals view of the Investments tab (prototype "Signals subtab"): since the last review, the fired
// alerts (open ones lead to the alert sheet), the price levels close by, the strategy's rules, research
// with its relation to the thesis (each note opens) and the recent decisions; a note that alerts and
// rules run on the Mac. Prices and percentages are public figures and stay visible in incognito.
import { Icon, ListRow, NoteLine, Tag, Tile } from "@cashu/ui/native";
import { Text, View } from "react-native";
import type { ReadySignalsProps, SignalsViewProps } from "../investments-contracts";
import { S } from "./Signals.strings";

const tones = { negative: "text-negative", positive: "text-positive", neutral: "text-fg-muted" };

function Glyph({ icon, tone }: { icon: "bell" | "check" | "sparkle"; tone: keyof typeof tones }) {
  return (
    <View className="size-8 items-center justify-center rounded-full bg-subtle">
      <Icon name={icon} size={16} className={tones[tone]} />
    </View>
  );
}

function Fired({ props }: { props: ReadySignalsProps }) {
  if (props.fired.length === 0) return null;
  return (
    <Tile title={S.fired} meta={S.yourAlerts}>
      {props.fired.map((row, i) =>
        row.decided ? (
          <ListRow
            key={row.gid}
            first={i === 0}
            lead={<Glyph icon="check" tone="positive" />}
            name={row.title}
            sub={row.sub}
          />
        ) : (
          <ListRow
            key={row.gid}
            first={i === 0}
            lead={<Glyph icon="bell" tone="negative" />}
            name={row.title}
            sub={row.sub}
            value={
              row.marked ? (
                <View className="flex-row items-center gap-1">
                  <Icon name="bell" size={16} className="text-accent" />
                  <Icon name="chevron-right" className="text-fg-muted" />
                </View>
              ) : (
                <Icon name="chevron-right" className="text-fg-muted" />
              )
            }
            accessibilityLabel={S.openAlert(row.title, row.marked)}
            onPress={() => props.onAlertPressed(row.gid)}
          />
        ),
      )}
    </Tile>
  );
}

function Near({ props }: { props: ReadySignalsProps }) {
  if (props.near.length === 0) return null;
  return (
    <Tile title={S.near} meta={S.prices}>
      {props.near.map((row, i) => (
        <ListRow
          key={row.gid}
          first={i === 0}
          name={row.name}
          value={row.price}
          sub={row.level}
          sub2={row.distance}
        />
      ))}
    </Tile>
  );
}

function Rules({ props }: { props: ReadySignalsProps }) {
  if (props.rules.length === 0) return null;
  return (
    <Tile title={S.fromRules}>
      {props.rules.map((row, i) => (
        <ListRow
          key={row.gid}
          first={i === 0}
          lead={<Glyph icon="sparkle" tone={row.tone} />}
          name={row.message}
          nameLines={2}
          sub={row.sub}
        />
      ))}
    </Tile>
  );
}

function Research({ props }: { props: ReadySignalsProps }) {
  if (props.research.length === 0) return null;
  return (
    <Tile
      title={S.fromResearch}
      {...(props.researchDay === null ? {} : { meta: props.researchDay })}
    >
      {props.research.map((row, i) => (
        <ListRow
          key={row.gid}
          first={i === 0}
          name={row.title}
          value={<Icon name="chevron-right" className="text-fg-muted" />}
          sub={
            <View className="shrink flex-row items-center gap-1.5">
              <Tag tone={row.tone}>{row.tag}</Tag>
              <Text numberOfLines={1} className="shrink text-caption text-fg-muted">
                {row.sub}
              </Text>
            </View>
          }
          accessibilityLabel={S.openNote(row.title)}
          onPress={() => props.onNotePressed(row.gid)}
        />
      ))}
    </Tile>
  );
}

function Decisions({ props }: { props: ReadySignalsProps }) {
  if (props.decisions.length === 0) return null;
  return (
    <Tile title={S.decisions}>
      {props.decisions.map((row, i) => (
        <ListRow
          key={row.gid}
          first={i === 0}
          name={row.title}
          value={<Text className="text-caption text-fg-muted">{row.dateLabel}</Text>}
          {...(row.reason === null ? {} : { sub: S.quoted(row.reason) })}
        />
      ))}
    </Tile>
  );
}

export function SignalsView(props: SignalsViewProps) {
  if (props.status === "unavailable")
    return (
      <Tile>
        <NoteLine icon="laptop">{props.message}</NoteLine>
      </Tile>
    );
  const empty =
    props.fired.length + props.near.length + props.rules.length + props.research.length === 0;
  return (
    <View className="gap-3">
      <Text role="heading" className="mt-1 text-caption font-medium text-fg-secondary">
        {props.since}
      </Text>
      {empty && (
        <Tile>
          <Text className="text-body text-fg-muted">{S.nothingNew}</Text>
        </Tile>
      )}
      <Fired props={props} />
      <Near props={props} />
      <Rules props={props} />
      <Research props={props} />
      <Decisions props={props} />
      <NoteLine icon="laptop">{S.alertsRunOnMac}</NoteLine>
    </View>
  );
}
