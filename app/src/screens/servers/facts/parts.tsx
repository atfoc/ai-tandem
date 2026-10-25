// The parts a server's body is made of (ServerFacts.tsx; goals 3.8.2, 3.8.4; mockups dl-03b to dl-03d, dl-05b, sh2-13a): grouped cells with a
// hairline between them, the cells that the kit's `Cell` does not draw (a caption over a mono value, agent chips, the test cell with its
// answer under it, a centred red one), the notice, and the full-width buttons. Everything another server said is drawn as `Text`.
import { Children, createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { agentMeta } from "@aiwb/core/agents.ts";

import { CellGroup } from "../../../ui/Cells.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { MONO } from "../../../ui/fonts.ts";

/** Whether the cell being drawn is followed by another in its group: the group tells each cell, so the last has no hairline. */
const Followed = createContext(false);

/** The kit's `CellGroup`, which also tells the cells made here whether they are last. */
export function Group({ children, ...rest }: ComponentProps<typeof CellGroup>) {
  const cells = Children.toArray(children);
  return (
    <CellGroup {...rest}>
      {cells.map((cell, i) => <Followed.Provider key={i} value={i < cells.length - 1}>{cell}</Followed.Provider>)}
    </CellGroup>
  );
}

/** A cell's frame: the 48 pt minimum, the margins, and the hairline under it when another follows. Pressable when it has an `onPress`. */
function Frame({ children, onPress, label, testID, data, disabled, pressedFill = true }: {
  children: ReactNode; onPress?(): void; label?: string; testID?: string; data?: Record<string, string>; disabled?: boolean; pressedFill?: boolean;
}) {
  const t = useTokens(), followed = useContext(Followed);
  return (
    <Pressable {...(testID ? tid(testID, data) : null)} disabled={disabled || !onPress} onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }: { pressed: boolean }) => [styles.frame, pressed && pressedFill && !!onPress && { backgroundColor: t.hover2 }, disabled && styles.off]}>
      {children}
      {followed ? <View pointerEvents="none" style={[styles.rule, { backgroundColor: t.line }]} /> : null}
    </Pressable>
  );
}

/** A caption over a value in the mono type (an address, a fingerprint), with something at the right. */
export function FactCell({ caption, text, trailing, onPress, testID, data, chevron }: {
  caption: string; text?: string; trailing?: ReactNode; onPress?(): void; testID?: string; data?: Record<string, string>; chevron?: ReactNode;
}) {
  return (
    <Frame onPress={onPress} testID={testID} data={data} label={[caption, text].filter(Boolean).join(", ")}>
      <View style={styles.words}>
        <Text size={TYPE.secondary} tone="muted">{caption}</Text>
        {text ? <Text selectable={!onPress} size={TYPE.secondary + 1} mono style={styles.mono}>{text}</Text> : null}
      </View>
      {trailing}
      {chevron}
    </Frame>
  );
}

/** A plain line of words in a group (the owner's line, a reason, an explanation), wrapping, never cut. */
export function TextCell({ children, mono, size = TYPE.secondary, tone = "muted", testID }: { children: ReactNode; mono?: boolean; size?: number; tone?: "text" | "muted" | "danger"; testID?: string }) {
  return (
    <Frame testID={testID}>
      <Text selectable size={size} tone={tone} mono={mono} style={[styles.words, mono && styles.mono, styles.pad]}>{children}</Text>
    </Frame>
  );
}

/** "Agents": the names as chips, each with a dot in its agent's colour. */
export function AgentsCell({ agents, testID }: { agents: string[]; testID?: string }) {
  const t = useTokens();
  return (
    <Frame testID={testID} label={`Agents, ${agents.map((a) => agentMeta(a).short).join(", ")}`}>
      <Text size={TYPE.control}>Agents</Text>
      <View style={styles.chips}>
        {agents.map((a) => {
          const m = agentMeta(a);
          const ink = m.glyph === "claude" ? t.claude : m.glyph === "cursor" ? t.cursor : m.glyph === "pi" ? t.pi : t.muted;
          const fill = m.glyph === "claude" ? t.claudeSoft : m.glyph === "cursor" ? t.cursorSoft : m.glyph === "pi" ? t.piSoft : t.panel;
          const name = m.short.charAt(0).toUpperCase() + m.short.slice(1);
          return (
            <View key={a} style={[styles.chip, { backgroundColor: fill }]}>
              <View style={[styles.chipDot, { backgroundColor: ink }]} />
              <Text size={TYPE.secondary} style={{ color: ink }}>{name}</Text>
            </View>
          );
        })}
      </View>
    </Frame>
  );
}

/** The test's answer under its words: green when it passed, red when it did not. */
export function Answer({ answer, testID }: { answer: { ok: boolean; text: string } | null; testID: string }) {
  if (!answer) return null;
  return (
    <Text {...tid(testID, { ok: answer.ok })} selectable accessibilityRole="alert" size={TYPE.secondary} tone={answer.ok ? "ok" : "danger"} style={styles.answer}>
      {answer.text}
    </Text>
  );
}

/** "↻ Test connection", accent, with the answer under it. While it runs the cell says so and is off. */
export function TestCell({ label, busy, answer, onPress, testID, resultID }: {
  label: string; busy: boolean; answer: { ok: boolean; text: string } | null; onPress(): void; testID: string; resultID: string;
}) {
  return (
    <Frame onPress={onPress} disabled={busy} testID={testID} label={busy ? "Testing" : label}>
      <View style={styles.words}>
        <Text size={TYPE.control} tone={busy ? "muted" : "accent"}>{busy ? "Testing…" : `↻ ${label}`}</Text>
        <Answer answer={busy ? null : answer} testID={resultID} />
      </View>
    </Frame>
  );
}

/** A centred cell whose words are red ("Remove server…"). */
export function DangerCell({ label, onPress, testID }: { label: string; onPress(): void; testID: string }) {
  return (
    <Frame onPress={onPress} testID={testID} label={label}>
      <Text size={TYPE.control} tone="danger" style={styles.centre}>{label}</Text>
    </Frame>
  );
}

/** The full-width soft-accent button ("↻ Test again"), with the answer under it. */
export function SoftButton({ label, busyLabel, busy, onPress, testID, answer, resultID }: {
  label: string; busyLabel: string; busy: boolean; onPress(): void; testID: string; answer?: { ok: boolean; text: string } | null; resultID?: string;
}) {
  const t = useTokens();
  return (
    <View style={styles.block}>
      <Pressable {...tid(testID)} disabled={busy} onPress={onPress} accessibilityRole="button" accessibilityLabel={busy ? busyLabel : label}
        accessibilityState={{ disabled: busy }}
        style={({ pressed }: { pressed: boolean }) => [styles.soft, { backgroundColor: t.accentSoft }, pressed && { opacity: 0.8 }, busy && styles.off]}>
        <Text size={TYPE.control} tone={busy ? "muted" : "accent"}>{busy ? busyLabel : `↻ ${label}`}</Text>
      </Pressable>
      {resultID ? <Answer answer={busy ? null : answer ?? null} testID={resultID} /> : null}
    </View>
  );
}

/** The one main action in the accent's fill ("Open Settings"). */
export function PrimaryButton({ label, onPress, testID }: { label: string; onPress(): void; testID: string }) {
  const t = useTokens();
  return (
    <View style={styles.block}>
      <Pressable {...tid(testID)} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
        style={({ pressed }: { pressed: boolean }) => [styles.soft, { backgroundColor: t.accentFill }, pressed && { opacity: 0.85 }]}>
        <Text size={TYPE.control} tone="onAccent">{label}</Text>
      </Pressable>
    </View>
  );
}

/** A note under a group, in the page's margins. */
export function Note({ children, testID }: { children: ReactNode; testID?: string }) {
  return <Text {...(testID ? tid(testID) : null)} selectable size={TYPE.secondary} tone="muted" style={styles.note}>{children}</Text>;
}

/** The numbered tries of the unreachable detail: the number in its own column, the words beside it. */
export function Numbered({ n, children }: { n: number; children: string }) {
  return (
    <View style={styles.numbered}>
      <Text size={TYPE.control} style={styles.n}>{n}.</Text>
      <Text selectable size={TYPE.control} style={styles.words}>{children}</Text>
    </View>
  );
}

/** Two sheets: copy. */
export const CopyMark = ({ size = 20, color }: { size?: number; color: string }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round">
    <Rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <Path d="M10.5 3.5v-.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
  </Svg>
);

/** A colour with a faint alpha, for the soft card of a test's answer (the tokens have no soft green). A colour that is not `#rrggbb` is kept. */
export const faint = (colour: string): string => (/^#[0-9a-f]{6}$/i.test(colour) ? `${colour}26` : colour);

const styles = StyleSheet.create({
  frame: { minHeight: PHONE.cell, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: PHONE.margin, paddingVertical: 8 },
  rule: { position: "absolute", left: PHONE.margin, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  off: { opacity: 0.5 },
  words: { flex: 1, minWidth: 0 },
  mono: { fontFamily: MONO },
  pad: { paddingVertical: 4 },
  chips: { flex: 1, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, minHeight: 30, borderRadius: 8 },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  answer: { marginTop: 2 },
  centre: { flex: 1, textAlign: "center" },
  block: { marginHorizontal: PHONE.margin, marginBottom: 12, gap: 6 },
  soft: { minHeight: PHONE.sheetRow, alignItems: "center", justifyContent: "center", borderRadius: 10, paddingHorizontal: 16 },
  note: { marginHorizontal: PHONE.margin, marginBottom: 20 },
  numbered: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingHorizontal: PHONE.margin, paddingVertical: 4 },
  n: { width: 22 },
});
