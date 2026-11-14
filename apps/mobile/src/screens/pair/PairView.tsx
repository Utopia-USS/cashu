// The pairing modal (prototype `pair` steps, dev-feedback #23.8): scan the Mac's code or paste it, the
// six digits to type on the Mac with their countdown, receiving, whose phone this is, the first sync with
// "Open cashU", and every way it can stop: "Scan again" when a new scan can help, else Close. Cancel on
// every step before storing.
import { Button, GroupSection, Icon, ListRow, Meter, NoteLine, TextField } from "@cashu/ui/native";
import { CameraView } from "expo-camera";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { QR_ONLY } from "../../platform/camera";
import { S } from "./Pair.strings";
import type { PairScreenState } from "./usePairScreen";

export type PairViewProps = PairScreenState;

/** The modal's frame: a close / cancel button on the steps that allow it, the step's body, its actions. */
function Frame(props: { onCancel?: () => void; children: ReactNode; actions?: ReactNode }) {
  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentContainerClassName="grow gap-5 px-4 pt-16 pb-10"
    >
      {props.onCancel !== undefined && (
        <View className="absolute top-4 right-4">
          <Button variant="glyph" label={S.cancel} onPress={props.onCancel}>
            <Icon name="x" size={20} />
          </Button>
        </View>
      )}
      <View className="grow gap-4">{props.children}</View>
      {props.actions !== undefined && <View className="gap-3">{props.actions}</View>}
    </ScrollView>
  );
}

function Title({ children }: { children: string }) {
  return (
    <Text role="heading" className="text-headline font-strong text-fg">
      {children}
    </Text>
  );
}

function Body({
  children,
  tone = "secondary",
}: {
  children: string;
  tone?: "secondary" | "negative";
}) {
  return (
    <Text className={`text-body ${tone === "negative" ? "text-negative" : "text-fg-secondary"}`}>
      {children}
    </Text>
  );
}

/** A centred waiting line (connecting, receiving, storing). */
function Waiting({ line, sub }: { line: string; sub?: string }) {
  return (
    <View className="grow items-center justify-center gap-2">
      <Icon name="sync" size={24} className="text-accent" />
      <Text accessibilityLiveRegion="polite" className="text-center text-title text-fg">
        {line}
      </Text>
      {sub !== undefined && <Text className="text-center text-caption text-fg-muted">{sub}</Text>}
    </View>
  );
}

/**
 * The pasted code: a long machine string, so no capitals, autocorrect or spellcheck, and a field that
 * grows with the text (no inner scrolling) so a paste shows from its first character.
 */
function CodeField(props: { value: string; onChange: (text: string) => void; invalid: boolean }) {
  return (
    <View className="gap-1">
      <Text className="text-body text-fg">{S.pasteLabel}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        accessibilityLabel={S.pasteLabel}
        aria-invalid={props.invalid}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        multiline
        scrollEnabled={false}
        textAlignVertical="top"
        testID="pair-paste"
        className={`min-h-24 rounded-sm border bg-surface px-3 py-2 text-caption text-fg ${props.invalid ? "border-negative" : "border-border"}`}
      />
    </View>
  );
}

export function PairView(props: PairViewProps) {
  switch (props.kind) {
    case "scan":
      return (
        <Frame
          onCancel={props.onCancel}
          actions={
            props.input === "camera" ? (
              <Button variant="link" label={S.pasteInstead} onPress={props.onUsePaste}>
                {S.pasteInstead}
              </Button>
            ) : props.camera !== "denied" ? (
              <Button variant="link" label={S.scanInstead} onPress={props.onUseCamera}>
                {S.scanInstead}
              </Button>
            ) : undefined
          }
        >
          <View className="gap-4" onLayout={props.onShown}>
            <Title>{S.scanTitle}</Title>
            <Body>{S.scanWhere}</Body>
          </View>
          {props.input === "camera" ? (
            <View
              accessibilityLabel={S.scannerLabel}
              className="h-80 overflow-hidden rounded-xl bg-chip"
            >
              {props.camera === "granted" && (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={QR_ONLY}
                  onBarcodeScanned={({ data }) => props.onScanned(data)}
                />
              )}
            </View>
          ) : (
            <View className="gap-3">
              {props.camera === "denied" && <Body>{S.cameraDenied}</Body>}
              <CodeField
                value={props.pasted}
                onChange={props.onPastedChanged}
                invalid={props.notACode}
              />
              <Text className="text-caption text-fg-muted">{S.pasteHint}</Text>
              <Button
                variant="primary"
                block
                label={S.pasteGo}
                disabled={props.pasted.trim() === ""}
                onPress={props.onPasteSubmitted}
              >
                {S.pasteGo}
              </Button>
            </View>
          )}
          {props.notACode && (
            <Text accessibilityRole="alert" className="text-caption text-negative">
              {S.notACode}
            </Text>
          )}
          <TextField
            label={S.nameLabel}
            value={props.name}
            onChange={props.onNameChanged}
            maxLength={64}
          />
          <NoteLine icon="shield">{S.scanNote}</NoteLine>
        </Frame>
      );
    case "discard":
      return (
        <Frame
          onCancel={props.onCancel}
          actions={
            <>
              <Button variant="danger" block label={S.discardYes} onPress={props.onDiscard}>
                {S.discardYes}
              </Button>
              <Button variant="secondary" block label={S.cancel} onPress={props.onCancel}>
                {S.cancel}
              </Button>
            </>
          }
        >
          <Title>{S.discardTitle(props.profile)}</Title>
          <Body>{S.discardBody}</Body>
        </Frame>
      );
    case "connecting":
      return (
        <Frame onCancel={props.onCancel}>
          <Waiting line={S.connecting} />
        </Frame>
      );
    case "code":
      return (
        <Frame onCancel={props.onCancel}>
          <View className="grow justify-center gap-4">
            <Title>{S.codeTitle}</Title>
            <Body>{S.codeBody}</Body>
            <View
              accessible
              accessibilityLabel={S.codeDigits(props.sas)}
              className="flex-row justify-center gap-2 py-4"
            >
              {props.sas.split("").map((digit, i) => (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: the six positions are the identity.
                  key={i}
                  className={`h-14 w-11 items-center justify-center rounded-lg bg-chip ${i === 3 ? "ml-2" : ""}`}
                >
                  <Text className="text-headline font-strong text-fg">{digit}</Text>
                </View>
              ))}
            </View>
            <Text
              accessibilityLiveRegion="polite"
              className="text-center text-caption text-fg-muted"
            >
              {S.codeExpires(props.secondsLeft)}
            </Text>
            <Text className="text-center text-caption text-fg-muted">{S.codeName(props.name)}</Text>
          </View>
        </Frame>
      );
    case "receiving":
      return (
        <Frame onCancel={props.onCancel}>
          <Waiting line={S.receiving} sub={S.receivingParts(props.parts)} />
        </Frame>
      );
    case "storing":
      return (
        <Frame>
          <Waiting line={S.storing} />
        </Frame>
      );
    case "role":
      return (
        <Frame
          actions={
            <Button variant="primary" block label={S.roleContinue} onPress={props.onContinue}>
              {S.roleContinue}
            </Button>
          }
        >
          <Title>{S.roleTitle}</Title>
          <GroupSection>
            {(["owner", "partner"] as const).map((role, i) => (
              <ListRow
                key={role}
                first={i === 0}
                name={role === "owner" ? S.roleMine : S.rolePartner}
                value={
                  props.role === role ? (
                    <Icon name="check" size={20} className="text-accent" />
                  ) : undefined
                }
                onPress={() => props.onRolePicked(role)}
              />
            ))}
          </GroupSection>
          <Body>{S.roleSub}</Body>
        </Frame>
      );
    case "firstSync":
      return (
        <Frame
          actions={
            <Button
              variant="primary"
              block
              label={S.open}
              disabled={!props.canOpen}
              onPress={props.onOpen}
            >
              {S.open}
            </Button>
          }
        >
          <Title>{props.profile === null ? S.firstSyncTitle : S.doneTitle(props.profile)}</Title>
          {props.progress !== null && !props.done ? (
            <View className="gap-2">
              <Text accessibilityLiveRegion="polite" className="text-body text-fg-secondary">
                {S.firstSyncProgress(props.progress.applied, props.progress.expected)}
              </Text>
              <Meter
                share={
                  props.progress.expected > 0
                    ? Math.min(1, props.progress.applied / props.progress.expected)
                    : 0
                }
                tone="accent"
              />
            </View>
          ) : (
            !props.canOpen && <Body>{S.firstSyncWaiting}</Body>
          )}
          {props.canOpen && !props.done && <Body>{S.stillReceiving}</Body>}
          <NoteLine icon="shield">{S.storedNote}</NoteLine>
        </Frame>
      );
    case "failed":
      return (
        <Frame
          onCancel={props.onCancel}
          actions={
            props.canScanAgain ? (
              <Button variant="primary" block label={S.scanAgain} onPress={props.onScanAgain}>
                {S.scanAgain}
              </Button>
            ) : (
              <Button variant="secondary" block label={S.close} onPress={props.onCancel}>
                {S.close}
              </Button>
            )
          }
        >
          <Title>{S.failedTitle}</Title>
          <Body>{S.failed(props.reason)}</Body>
        </Frame>
      );
    case "closed":
      return null;
  }
}
