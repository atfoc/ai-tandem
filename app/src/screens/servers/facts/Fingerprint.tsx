// A certificate's fingerprint as the phone shows it to be compared (goals 3.8.3, 3.8.4; mockups dl-04d, dl-04e, dl-05c): 16 blocks of 4 hex
// digits in the mono type, four to a line, in one tone: green when it matches the code, red when it does not or when it changed, muted for
// the one accepted before. The add flow (04d, 04e) and the certificate screen (05c) draw it. Package S2.
import { StyleSheet, View } from "react-native";

import { TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { tid } from "../../../ui/tid.ts";
import { fpBlocks } from "../facts.ts";
import { S2_TID } from "../ids.ts";

export type FingerprintTone = "ok" | "bad" | "plain" | "muted";

/** testID names the whole (`srv-fp-now`, `srv-fp-old`); its dataSet has `tone`. Each block is `srv-fp-block`. A value that is not 32 pairs is
 *  drawn as it came, in one line. */
export function Fingerprint({ value, tone, testID, label }: { value: string | undefined; tone: FingerprintTone; testID: string; label?: string }) {
  const blocks = fpBlocks(value);
  const textTone = tone === "ok" ? "ok" : tone === "bad" ? "danger" : tone === "muted" ? "muted" : undefined;
  const spoken = `${label ? `${label}, ` : ""}${blocks.length ? blocks.join(" ") : value ?? ""}`;
  return (
    <View {...tid(testID, { tone })} accessible accessibilityLabel={spoken} style={styles.grid}>
      {blocks.length
        ? Array.from({ length: 4 }, (_, row) => (
          <View key={row} style={styles.line}>
            {blocks.slice(row * 4, row * 4 + 4).map((b, i) => (
              <Text key={i} {...tid(S2_TID.fpBlock)} selectable size={TYPE.control - 1} mono tone={textTone} style={styles.block}>{b}</Text>
            ))}
          </View>
        ))
        : <Text selectable size={TYPE.secondary} mono tone={textTone}>{value ?? ""}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { gap: 4 },
  line: { flexDirection: "row", gap: 14 },
  block: { minWidth: 44, letterSpacing: 0.5 },
});
