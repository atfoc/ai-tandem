// The kit gallery's section "P2 PickerSheet and SearchField" (`/?gallery=kit`, dev/KitGallery.tsx; package F1 of plans/ux-improvements/PLAN.md).
// Its cases are what web/dev/checks/UX.F1-kit.mjs opens and measures: every control a check presses has a testID `kit-<what>`.
// `kit-open-<case>` opens a case; `kit-picker-last` says what was picked last (`<case>:<value>`), "closed" when the sheet was
// dismissed after that, "effort:<x>" for the extra row.
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "../../ui/Button.tsx";
import { PickerSheet, type PickerOption } from "../../ui/PickerSheet.tsx";
import { PHONE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";

type Case = "picker-short" | "picker-long" | "picker-extra";
const CASES: Case[] = ["picker-short", "picker-long", "picker-extra"];

const SHORT: PickerOption<string>[] = [
  { value: "auto", label: "Auto-detect", note: "Recognises the language as you talk" },
  { value: "english", label: "English" },
  { value: "german", label: "Deutsch" },
  { value: "swahili", label: "Kiswahili", disabledReason: "Not available offline" },
];

const MODELS: [string, string[]][] = [
  ["Anthropic", ["Claude Opus", "Claude Sonnet", "Claude Haiku", "Claude Fable", "Claude Instant"]],
  ["OpenAI", ["GPT Large", "GPT Small", "GPT Mini", "GPT Nano", "GPT Turbo"]],
  ["Google", ["Gemini Pro", "Gemini Flash", "Gemini Lite", "Gemini Nano", "Gemini Ultra"]],
];
const LONG: PickerOption<string>[] = MODELS.flatMap(([section, names]) =>
  names.map((n) => ({ value: n.toLowerCase().replace(/ /g, "-"), label: n, section, note: n.endsWith("Opus") ? "The most capable" : undefined })));

const EFFORTS = ["low", "medium", "high"] as const;

export function Section() {
  const [shown, setShown] = useState<Case | null>(null);
  const [last, setLast] = useState("closed");
  const [short, setShort] = useState<string | null>("english");
  const [long, setLong] = useState<string | null>("claude-sonnet");
  const [model, setModel] = useState<string | null>("claude-opus");
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>("medium");
  const close = () => { setShown(null); setLast((l) => (l.startsWith("picker") || l.startsWith("effort") ? l : "closed")); };
  const show = (c: Case) => { setLast("closed"); setShown(c); };
  return (
    <View style={styles.col}>
      <View style={styles.row}>
        {CASES.map((c) => <Button key={c} size="touch" label={c} testID={`kit-open-${c}`} onPress={() => show(c)} />)}
      </View>
      <Text testID="kit-picker-last" tone="muted">{last}</Text>
      <Text testID="kit-picker-model" tone="muted">{`${short} · ${long} · ${model} · ${effort}`}</Text>

      <PickerSheet open={shown === "picker-short"} onClose={close} title="Language" sub="What you speak in speech mode" options={SHORT}
        value={short} onPick={(v) => { setShort(v); setLast(`picker-short:${v}`); }} />

      <PickerSheet open={shown === "picker-long"} onClose={close} title="Model" sub="Claude Sonnet · for this chat" options={LONG}
        value={long} searchPlaceholder="Search models" onPick={(v) => { setLong(v); setLast(`picker-long:${v}`); }} />

      <PickerSheet open={shown === "picker-extra"} onClose={close} title="Model" sub={`Claude Opus · ${effort} effort`}
        options={LONG.slice(0, 4)} value={model} search={false}
        onPick={(v) => { setModel(v); setLast(`picker-extra:${v}`); }}
        extra={(
          <View style={styles.row}>
            {EFFORTS.map((e) => (
              <Button key={e} size="touch" label={e} testID={`kit-effort-${e}`} on={effort === e} tone="ghost" style={styles.effort}
                onPress={() => { setEffort(e); setLast(`effort:${e}`); }} />
            ))}
          </View>
        )} />
    </View>
  );
}

const styles = StyleSheet.create({
  col: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  effort: { flex: 1, minWidth: PHONE.target },
});
