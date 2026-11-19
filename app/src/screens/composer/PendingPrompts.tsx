import { ScrollView, StyleSheet, View } from "react-native";

import type { PendingPrompt } from "@aiwb/core/types.ts";

import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useMeasuring } from "./measure.tsx";

export function DeliveryActions({ phone, steering, disabled, queueKey, onQueue, onSteer }: {
  phone: boolean;
  steering: boolean;
  disabled: boolean;
  queueKey: string;
  onQueue(): void;
  onSteer(): void;
}) {
  const measuring = useMeasuring();
  const buttonStyle = phone ? styles.touch : undefined;
  return (
    <View style={styles.actions}>
      <Button {...(measuring ? {} : tid("send", { delivery: "queue" }))} label="Queue" tone="primary" size={phone ? "touch" : "sm"}
        style={buttonStyle} title={queueKey ? `Queue (${queueKey})` : undefined} disabled={disabled} onPress={onQueue} />
      {steering ? <Button {...(measuring ? {} : tid("steer"))} label="Steer" size={phone ? "touch" : "sm"}
        style={buttonStyle} title={phone ? undefined : "Steer at the next safe point"} disabled={disabled} onPress={onSteer} /> : null}
    </View>
  );
}

export function PendingPrompts({ entries, paused, phone, frozen, onRemove, onResume }: {
  entries: readonly PendingPrompt[];
  paused: boolean;
  phone: boolean;
  frozen: boolean;
  onRemove(id: string): void;
  onResume(): void;
}) {
  const { tokens: t } = useTheme();
  const waiting = entries.some((entry) => entry.state === "waiting");
  const count = `${entries.length} pending ${entries.length === 1 ? "prompt" : "prompts"}`;
  return (
    <View {...tid("pending-prompts")} style={[styles.queue, { backgroundColor: t.panel, borderColor: t.line }]}>
      <View style={styles.line}>
        <Text style={styles.preview} size={12} tone="muted" role="status" accessibilityLiveRegion="polite">
          {paused ? `Queue paused · ${waiting ? "Steer delivery unconfirmed" : count}` : waiting ? `Waiting for the agent · ${count}` : count}
        </Text>
        {paused && !frozen ? <Button {...tid("resume-prompts")} label="Resume" title="Resume queue" size={phone ? "touch" : "sm"} onPress={onResume} /> : null}
      </View>
      <ScrollView style={styles.entries} keyboardShouldPersistTaps="handled">
        {entries.map((entry) => {
          const preview = entry.text.trim() || (entry.images?.length ? "Image attachment" : "Quoted message");
          const mode = entry.delivery === "queue" ? "Queued" : entry.state === "next" ? "Next turn" : "Steer";
          return (
            <View key={entry.id} {...tid("pending-prompt", { delivery: entry.delivery })} style={[styles.line, { borderTopColor: t.line, borderTopWidth: 1 }]}>
              <Text size={12} tone="muted">{mode}</Text>
              <Text size={12} numberOfLines={2} style={styles.preview}>{preview}</Text>
              {!frozen && (paused || entry.state !== "waiting")
                ? <Button {...tid("remove-prompt")} label="Remove" accessibilityLabel={`Remove prompt: ${preview.slice(0, 70)}`}
                    size={phone ? "touch" : "sm"} tone="ghost" onPress={() => onRemove(entry.id)} /> : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  touch: { paddingHorizontal: 9 },
  queue: { borderWidth: 1, borderRadius: 9, marginBottom: 6, paddingHorizontal: 8 },
  entries: { maxHeight: 136 },
  line: { flexDirection: "row", alignItems: "center", minHeight: 27, gap: 8, paddingVertical: 2 },
  preview: { flex: 1, minWidth: 0 },
});
