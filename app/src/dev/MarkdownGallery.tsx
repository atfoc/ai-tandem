// The Markdown of a message on the gallery (package S5): the messages web/dev/checks/A6.3-markdown.mjs reads in each theme
// (the page's A6.3 chat with four code blocks), a message of every kind of block and inline, a user's message with chips and
// a mention, and a message that streams in chunks with the counts of what was parsed and drawn. It is part of no screen:
// the chat view (S4) draws a message with the same <Markdown>.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { Board } from "@aiwb/core/types.ts";
import { pointRef, selectionRef, serializeRef } from "@aiwb/core/logic/refs.ts";
import { Button } from "../ui/Button.tsx";
import { Text } from "../ui/Text.tsx";
import { useTheme } from "../ui/theme.tsx";
import type { ThemePref } from "@aiwb/core/logic/theme.ts";
import { forget, stats } from "../screens/markdown/parse.ts";
import { messageText } from "../screens/markdown/displayed.ts";
import { Markdown, MarkdownEnvProvider, type MarkdownEnv } from "../screens/markdown/index.ts";

/** The chat `c_A6_cards` of the mock (web/dev/mock-ui.js A6), whose answer A6.3 reads: four code blocks, a table, a quote. */
export const READABLE = "The copy step is in `build.mjs`:\n\n```js\n// copies the fonts once\nconst fonts = \"node_modules/@excalidraw/excalidraw/dist/prod/fonts\";\nif (!fs.existsSync(\"dist/fonts\")) fs.cpSync(fonts, \"dist/fonts\", { recursive: true });\nexport const COUNT = 42;\n```\n\n```diff\n-fs.cpSync(fonts, \"dist/fonts\", { recursive: true });\n+if (!fs.existsSync(\"dist/fonts\")) fs.cpSync(fonts, \"dist/fonts\", { recursive: true });\n```\n\n```ts\nclass FontCopy extends Step {\n  run(count: number): string { return `copied ${count}`; }\n}\nfunction copyFonts() { console.log(new FontCopy().run(3)); }\n```\n\n```json\n{ \"name\": \"ai-whiteboard-web\", \"private\": true, \"version\": 1 }\n```\n\n| Step | Before | After |\n|---|---|---|\n| fonts | 2.1 s | 0.0 s |\n\n> A quoted line, **bold**, _italic_ and a [link](https://example.com).";

const SELECTION = serializeRef(selectionRef([{ id: "r1", type: "rectangle", label: "API", x: 10, y: 10, width: 70, height: 40 }])!);
const POINT = serializeRef(pointRef(5, 7));

/** One message of every kind of block and inline. */
export const FEATURES = [
  "# Heading one", "## Heading two", "### Heading three",
  "A paragraph with *emphasis*, **strong**, ~~struck~~, `inline code`, a [link](https://example.com/a?b=1), <https://auto.example> and an image ![alt text](https://example.com/p.png).",
  "- tight item one\n- tight item two\n  - nested a\n  - nested b\n\n3. third\n4. fourth\n\n- [x] done task\n- [ ] open task",
  "> quoted **text**\n> on two lines",
  "| Name | Count | Notes |\n|---|:-:|---|\n| alpha | 1 | `code` and a longer note that goes on so that this cell wraps in a narrow window |\n| beta | 22 | short |",
  "---",
  "Raw <b>html</b> is text. [bad](javascript:alert(1)) is dropped, [nothing]() is plain. Footnote[^1].",
  "```bash\necho \"hi\"   # a comment\nls -la | grep 'x'\n```",
  "```nosuch\nplain code, not coloured\n```",
  "```\nno language\n```",
  "[^1]: The note.",
].join("\n\n");

/** A user's message: chips where the tags stood, with the punctuation after them, and an @name of a board. */
export const USER = `see ${SELECTION}, and ${POINT}.\nopen @Plan or @Nothing please`;

const BOARDS: Record<string, Board> = { b_plan: { id: "b_plan", name: "Plan", group: "", created: "" } };

/** The answer that streams: three paragraphs, a list, a fence. */
const ANSWER = "The build is slow because the fonts are copied on every run.\n\nThe fix has three steps:\n\n- check whether `dist/fonts` exists\n- copy only when it does not\n- keep the copy out of the watch loop\n\nIn code:\n\n```js\nif (!fs.existsSync(\"dist/fonts\")) fs.cpSync(fonts, \"dist/fonts\", { recursive: true });\n```\n\nThat is all of it.";
const CHUNK = 7;
const CHUNKS = Math.ceil(ANSWER.length / CHUNK);

/** An answer that arrives in chunks, with the counts of what was parsed and drawn while it did (B-MD-11). */
const StreamDemo = memo(function StreamDemo() {
  const { tokens: t } = useTheme();
  const [shown, setShown] = useState(0); // chunks of the answer drawn
  const [running, setRunning] = useState(false);
  const [counts, setCounts] = useState(() => ({ ...stats }));
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    if (!running) return;
    timer.current = setInterval(() => setShown((n) => Math.min(CHUNKS, n + 1)), 25);
    return () => clearInterval(timer.current);
  }, [running]);
  useEffect(() => { if (shown >= CHUNKS) setRunning(false); }, [shown]);
  useEffect(() => { setCounts({ ...stats }); }, [shown]);

  const streamed = ANSWER.slice(0, shown * CHUNK);
  const reset = () => { setRunning(false); setShown(0); forget(); stats.parses = 0; stats.renders = 0; setCounts({ ...stats }); };

  return (
    <>
      <Text weight="600" tone="muted" size={11}>An answer that streams</Text>
      <View style={styles.row}>
        <Button size="sm" label="Stream" testID="md-stream-run" onPress={() => { if (shown >= CHUNKS) reset(); setRunning(true); }} />
        <Button size="sm" label="Next chunk" testID="md-stream-next" onPress={() => setShown((n) => Math.min(CHUNKS, n + 1))} />
        <Button size="sm" label="Reset" testID="md-stream-reset" onPress={reset} />
      </View>
      <Text testID="md-stats" tone="muted" dataSet={{ chunks: shown, of: CHUNKS, done: shown >= CHUNKS, parses: counts.parses, renders: counts.renders }}>
        {`${shown}/${CHUNKS} chunks, ${counts.parses} blocks parsed, ${counts.renders} block renders`}
      </Text>
      <View testID="md-sample-stream" style={[styles.sample, { backgroundColor: t.bg, borderColor: t.line }]}>
        <Markdown text={streamed} streaming={shown < CHUNKS && shown > 0} />
      </View>
    </>
  );
});

const CHOICES: ThemePref[] = ["light", "dark", "latte", "frappe", "macchiato", "mocha"];

export function MarkdownGallery() {
  const { tokens: t, pref, setPref } = useTheme();
  const [said, setSaid] = useState("");
  const env = useMemo<MarkdownEnv>(() => ({
    showRef: (board, ref, agent) => setSaid(`show ${ref.kind} ${ref.label} on ${board} (${agent})`),
    useBoards: () => BOARDS,
    openBoard: (id) => setSaid(`open board ${id}`),
  }), []);

  return (
    <MarkdownEnvProvider env={env}>
      <View style={styles.col}>
        <View style={styles.row}>
          {CHOICES.map((c) => <Button key={c} size="sm" label={c} testID={`md-theme-${c}`} onPress={() => setPref(c)} />)}
          <Text testID="md-theme" tone="muted">{pref}</Text>
        </View>
        <Text weight="600" tone="muted" size={11}>An answer with code, a table and a quote (A6.3)</Text>
        <View testID="md-sample-readable" style={[styles.sample, { backgroundColor: t.bg, borderColor: t.line }]}>
          <Markdown text={READABLE} board="b_demo" agent="claude" />
        </View>

        <Text weight="600" tone="muted" size={11}>Every kind of block and inline</Text>
        <View testID="md-sample-features" style={[styles.sample, { backgroundColor: t.bg, borderColor: t.line }]}>
          <Markdown text={FEATURES} board="b_demo" agent="claude" />
        </View>
        <Text testID="md-displayed" dataSet={{ separators: "kept" }} style={styles.hidden}>{messageText(FEATURES)}</Text>
        <Text testID="md-displayed-drawn" style={styles.hidden}>{messageText(FEATURES, false, false, false)}</Text>

        <Text weight="600" tone="muted" size={11}>A user's message</Text>
        <View testID="md-sample-user" style={[styles.sample, styles.user, { backgroundColor: t.accentSoft, borderColor: t.line }]}>
          <Markdown text={USER} user board="b_demo" agent="claude" of="b_demo" color={t.userText} />
        </View>
        <Text testID="md-said" tone="muted">{said}</Text>

        <StreamDemo />
      </View>
    </MarkdownEnvProvider>
  );
}

const styles = StyleSheet.create({
  col: { gap: 8, maxWidth: 560 },
  row: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  sample: { borderWidth: 1, borderRadius: 8, padding: 12 },
  user: { alignSelf: "flex-end", maxWidth: "88%" },
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" },
});
