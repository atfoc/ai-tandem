// What the app draws over the board's view, not inside it (AD-52): the boxes that show where an agent just worked, the pill
// that says who is working on the board, the layer that waits for a point clicked on the board (⌘⇧L), and the note after a
// dropped edit (the old page's Canvas.tsx). The save banner is BoardOff.tsx's.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from "react-native";

import { agentClass, agentShortName } from "@aiwb/core/agents.ts";
import { boardWorker } from "@aiwb/core/logic/status.ts";
import { droppedText, serverNameOf } from "@aiwb/core/logic/boardsave.ts";
import { pointLabel } from "@aiwb/core/logic/refs.ts";
import { reachable } from "@aiwb/core/logic/sections.ts";
import { flash, getState, setDropped, type Flash } from "@aiwb/core/state/store.ts";

import { onKey } from "../../platform/keys";
import { useStore } from "../../state/useStore.ts";
import { AgentGlyph } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import type { Tokens } from "../../ui/tokens.ts";
import { usePointer } from "../../ui/usePointer";
import { IconButton } from "../../ui/IconButton.tsx";
import { boardApp } from "../shell/boardside.ts";
import { pickEscape } from "./boardkeys.ts";
import { PICK_UI } from "./PickSurface.types.ts";
import { PickSurface } from "./PickSurface";
import { finishPick, pickPoint } from "./refs.ts";
import type { Spot } from "./taps.ts";
import { FILL } from "./fill.ts";

/** An agent's colour on the canvas, and the colour of text on it (.agent-claude, .agent-cursor, .agent-pi, .agent-unknown). */
export function agentPaint(t: Tokens, agent: string): { main: string; on: string } {
  switch (agentClass(agent)) {
    case "claude": return { main: t.claude, on: "#ffffff" };
    case "cursor": return { main: t.cursor, on: t.bg };
    case "pi": return { main: t.pi, on: t.bg };
    default: return { main: t.muted, on: t.bg };
  }
}

/** `colour` (#rrggbb) at `alpha`: the tint behind a box (color-mix(in srgb, colour 6%, transparent) on the old page). */
export function tint(colour: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(colour);
  if (!m) return "transparent";
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const native = Platform.OS !== "web";

/** Fades in over a quarter of a second; `pulse` then breathes (a box that says "Removed"). */
function useFlashAnimation(pulse: boolean): Animated.Value {
  const o = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const fade = Animated.timing(o, { toValue: 1, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: native });
    if (!pulse) { fade.start(); return () => fade.stop(); }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 0.55, duration: 600, useNativeDriver: native }),
      Animated.timing(o, { toValue: 1, duration: 600, useNativeDriver: native }),
    ]));
    Animated.sequence([fade, loop]).start();
    return () => o.stopAnimation();
  }, [o, pulse]);
  return o;
}

function FlashBox({ f, v }: { f: Flash; v: { scrollX: number; scrollY: number; zoom: number } }) {
  const { tokens: t } = useTheme();
  const danger = f.tone === "danger";
  const { main, on } = danger ? { main: t.danger, on: t.onDanger } : agentPaint(t, f.agent);
  const opacity = useFlashAnimation(danger);
  const pad = 10;
  const left = (f.box.x + v.scrollX) * v.zoom - pad, top = (f.box.y + v.scrollY) * v.zoom - pad;
  const w = f.box.width * v.zoom + pad * 2, h = f.box.height * v.zoom + pad * 2;
  return (
    <Animated.View {...tid("flash", { tone: f.tone, agent: agentClass(f.agent) })}
      style={[styles.flash, { left, top, width: w, height: h, borderColor: main, borderStyle: danger ? "dashed" : "solid", backgroundColor: tint(main, danger ? 0.08 : 0.06), opacity }]}>
      <View style={[styles.flashTag, { backgroundColor: main }]}>
        <AgentGlyph agent={f.agent} size={11} color={on} />
        <Text {...tid("flash-label")} size={11} weight="600" style={{ color: on }} numberOfLines={1}>{f.label}</Text>
      </View>
    </Animated.View>
  );
}

export function FlashLayer({ board }: { board: string }) {
  const flashes = useStore((s) => s.flashes);
  const v = useStore((s) => s.view);
  return (
    <View {...tid("flash-layer")} pointerEvents="none" style={styles.layer}>
      {flashes.filter((f) => f.board === board).map((f) => <FlashBox key={f.id} f={f} v={v} />)}
    </View>
  );
}

function Dots({ color }: { color: string }) {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.4))).current;
  useEffect(() => {
    const loops = dots.map((d, i) => Animated.loop(Animated.sequence([
      Animated.delay(i * 150),
      Animated.timing(d, { toValue: 1, duration: 330, useNativeDriver: native }),
      Animated.timing(d, { toValue: 0.4, duration: 330, useNativeDriver: native }),
      Animated.delay(440 - i * 150),
    ])));
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);
  return (
    <View style={styles.dots}>
      {dots.map((d, i) => <Animated.View key={i} style={[styles.dot, { backgroundColor: color, opacity: d }]} />)}
    </View>
  );
}

/** "<Agent> is working on <board>" while one of the board's chats is busy, or another chat just edited it (logic/status.ts boardWorker). */
export function Presence({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const name = useStore((s) => s.boards[board]?.name ?? "");
  // (of a section's board whose server is not connected nothing is known: the pill is not left standing from before)
  const agent = useStore((s) => boardWorker(s.chats, board, s.busyOn[board]?.agent, reachable(s, board)));
  if (!agent) return null;
  const { main } = agentPaint(t, agent);
  return (
    <View pointerEvents="none" style={styles.presenceRow}>
      <View {...tid("presence", { agent: agentClass(agent) })} role="status" style={[styles.presence, { backgroundColor: t.bg, borderColor: t.line }]}>
        <AgentGlyph agent={agent} size={12} color={main} />
        <Text size={12} tone="muted" numberOfLines={1}>{agentShortName(agent)} is working on {name}</Text>
        <Dots color={t.muted} />
      </View>
    </View>
  );
}

/**
 * While a chat of this board waits for a point (⌘⇧L, "Point at"): a crosshair over the canvas; a click (a tap) puts the point, in board
 * coordinates, into the chat's message. Esc cancels (a finger has the Cancel button). The layer takes no pointer: the wheel, a drag and
 * a pinch still reach the board underneath, which is in view mode meanwhile (so that a press does nothing to a shape or a tool), and
 * the surface it stands in (PickSurface) watches for the tap. A press that moved puts no point. It wraps what the canvas shows, so
 * that one surface hears the board and the layer over it.
 */
export function PickLayer({ board, children }: { board: string; children: ReactNode }) {
  const { tokens: t } = useTheme();
  const chat = useStore((s) => (s.picking && s.chats[s.picking]?.board === board ? s.chats[s.picking] : undefined));
  const v = useStore((s) => s.view);
  const touch = usePointer() === "touch";
  const [at, setAt] = useState<Spot | null>(null);
  useEffect(() => (chat ? onKey(pickEscape) : undefined), [chat?.id]);

  const pick = (spot: Spot) => {
    if (!chat) return;
    const view = getState().view;
    const r = boardApp.pointRefOn(board, spot.x / view.zoom - view.scrollX, spot.y / view.zoom - view.scrollY);
    finishPick(chat.id, r);
    if (r.kind === "point") flash({ board, box: { x: r.x - 6, y: r.y - 6, width: 12, height: 12 }, agent: chat.agent, label: r.label, tone: "edit" }, 1600);
  };
  return (
    <PickSurface on={!!chat} onTap={pick} onHover={setAt}>
      {children}
      {chat && (
        <View {...tid("pick-layer")} pointerEvents="box-none" style={[styles.pick, { backgroundColor: tint(t.accent, 0.04), borderColor: t.accent }]}>
          <View pointerEvents="box-none" style={styles.hintRow}>
            <View {...tid("pick-hint")} dataSet={{ [PICK_UI]: true }} style={[styles.hint, { backgroundColor: t.accentFill }]}>
              <Text size={12} weight="600" tone="onAccent">{touch ? "Tap a point to add it to the chat" : "Click a point to add it to the chat"}</Text>
              {touch
                ? <Pressable {...tid("pick-cancel")} accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={8} onPress={() => pickPoint(null)}><Text size={12} weight="600" tone="onAccent">Cancel</Text></Pressable>
                : <View style={[styles.kbd, { backgroundColor: t.bg }]}><Text size={11} mono>Esc</Text></View>}
            </View>
          </View>
          {at && (() => {
            const bx = at.x / v.zoom - v.scrollX, by = at.y / v.zoom - v.scrollY;
            return (
              <View {...tid("pick-coord")} pointerEvents="none" style={[styles.coord, { left: at.x + 14, top: at.y + 14, backgroundColor: t.text }]}>
                <Text size={11} mono style={{ color: t.bg }}>{pointLabel(bx, by)}</Text>
              </View>
            );
          })()}
        </View>
      )}
    </PickSurface>
  );
}

/** After an edit made here was dropped (the board was changed elsewhere meanwhile): said over the canvas until it is hidden. */
export function DroppedNote({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const on = useStore((s) => !!s.dropped[board] && s.roles[board] === "held" && !s.boards[board]?.archived);
  const name = useStore((s) => serverNameOf(board, s.servers));
  if (!on) return null;
  return (
    <View pointerEvents="box-none" style={styles.noteRow}>
      <View {...tid("canvas-note")} role="status" style={[styles.note, { backgroundColor: t.bg, borderColor: t.line }]}>
        <Text size={12} tone="danger" style={styles.noteText}>{droppedText(boardApp.droppedInOutage(board), name)}</Text>
        <IconButton {...tid("canvas-note-hide")} title="Hide" size="sm" onPress={() => setDropped(board, false)}>
          {(color) => <Text size={14} style={{ color }}>×</Text>}
        </IconButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { ...FILL, overflow: "hidden", zIndex: 3 },
  flash: { position: "absolute", borderWidth: 2, borderRadius: 10 },
  flashTag: { position: "absolute", top: -22, left: -2, flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2, paddingLeft: 6, paddingRight: 7, borderTopLeftRadius: 6, borderTopRightRadius: 6, borderBottomRightRadius: 6, borderBottomLeftRadius: 0 },
  dots: { flexDirection: "row", gap: 3 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  presenceRow: { position: "absolute", left: 0, right: 0, bottom: 18, alignItems: "center", zIndex: 4 },
  presence: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "92%", paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1 },
  pick: { ...FILL, zIndex: 5, borderWidth: 2 },
  hintRow: { position: "absolute", left: 0, right: 0, top: 12, alignItems: "center" },
  hint: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 20 },
  kbd: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  coord: { position: "absolute", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  noteRow: { position: "absolute", left: 0, right: 0, bottom: 58, alignItems: "center", zIndex: 4 },
  note: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "92%", paddingVertical: 6, paddingLeft: 12, paddingRight: 8, borderRadius: 8, borderWidth: 1 },
  noteText: { flexShrink: 1 },
});
