// A block's inline content (AD-75): nested Text for emphasis, code, links and mentions; a chip where a reference tag stood.
// What is drawn is doc.ts's; the text of every leaf is what displayed.ts counts quotes in.
import { useContext, type ReactNode } from "react";
import { Pressable, Text as RNText, View } from "react-native";

import { chipTitle } from "../../platform/chipinput/chipvalue.ts";
import { linkProps } from "../../platform/openlink";
import { MONO } from "../../ui/fonts.ts";
import { useTokens } from "../../ui/theme.tsx";
import { webStyle } from "../../ui/webstyle.ts";
import { cleanName, resolveName } from "@aiwb/core/logic/mentions.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";

import type { Inline } from "./doc.ts";
import { useMarkdownEnv, WhereContext } from "./env.tsx";
import { alpha } from "./look.ts";
import { useLook } from "./look.tsx";

const noBoards = () => ({});

/** The inline nodes as React nodes, for the inside of a Text. */
export function Inlines({ kids }: { kids: Inline[] }) {
  // (a line break in the source is a space, as in the page; white space runs collapse)
  return <>{kids.map((n, i) => (n.k === "text" ? n.v.replace(/[ \t\r\n]+/g, " ") : n.k === "br" ? "\n" : <InlineNode key={i} n={n} />))}</>;
}

function InlineNode({ n }: { n: Inline }): ReactNode {
  const t = useTokens();
  const look = useLook();
  switch (n.k) {
    case "text": case "br": return null; // (Inlines draws them)
    case "em": return <RNText style={{ fontStyle: "italic" }}><Inlines kids={n.kids} /></RNText>;
    case "strong": return <RNText style={{ fontWeight: "600" }}><Inlines kids={n.kids} /></RNText>;
    case "del": return <RNText style={{ color: t.muted, textDecorationLine: "line-through" }}><Inlines kids={n.kids} /></RNText>;
    case "sup": return <RNText style={{ fontSize: look.size * 0.75 }}><Inlines kids={n.kids} /></RNText>;
    case "code":
      return (
        <RNText testID="md-code-inline" style={{ fontFamily: MONO, fontSize: (look.size * 12) / 13, backgroundColor: look.user ? alpha(t.bg, 0.6) : t.panel }}>{n.v}</RNText>
      );
    case "link":
      // (a footnote's "#…" opens nothing)
      return (
        <RNText testID="md-link" dataSet={{ href: n.href }} style={{ color: t.accent }} {...(n.href.startsWith("#") ? {} : linkProps(n.href))}>
          <Inlines kids={n.kids} />
        </RNText>
      );
    case "chip": return <Chip n={n} />;
    case "mention": return <Mention raw={n.raw} />;
    case "check": return <Check checked={n.checked} />;
  }
}

/** A reference tag where it stands: its label in a chip, with the punctuation right after it going with it. On a board's chat a
 *  press shows that reference on the board. */
function Chip({ n }: { n: Extract<Inline, { k: "chip" }> }) {
  const t = useTokens();
  const look = useLook();
  const where = useContext(WhereContext);
  const env = useMarkdownEnv();
  const press = where.board && env.showRef ? () => env.showRef!(where.board!, n.ref, where.agent || "unknown") : undefined;
  const mark = n.ref.kind === "selection"
    ? { width: 8, height: 8, borderWidth: 1.5, borderStyle: "dashed" as const, borderColor: t.accent, borderRadius: 2 }
    : { width: 7, height: 7, borderRadius: 4, backgroundColor: t.accent };
  const chip = (
    <Pressable testID="ref-chip" dataSet={{ ref: n.tag, kind: n.ref.kind }} role="button" aria-label={chipTitle(n.ref)} onPress={press} disabled={!press}
      style={[{ flexDirection: "row", alignItems: "center", marginHorizontal: 1, paddingLeft: 5, paddingRight: 6, borderWidth: 1, borderColor: alpha(t.accent, 0.3), borderRadius: 5, backgroundColor: t.bg },
        webStyle({ display: "inline-flex", verticalAlign: "baseline", maxWidth: "100%", cursor: press ? "pointer" : "default" })]}>
      <View style={[mark, { marginRight: 4 }]} />
      <RNText style={{ color: t.accent, fontSize: (look.size * 12) / 13, lineHeight: (look.size * 12 * 1.5) / 13, fontWeight: "600" }} numberOfLines={1}>{n.ref.label}</RNText>
    </Pressable>
  );
  if (!n.after) return chip;
  return (
    <View style={[{ flexDirection: "row", alignItems: "baseline" }, webStyle({ display: "inline-flex", whiteSpace: "nowrap" })]}>
      {chip}
      <RNText>{n.after}</RNText>
    </View>
  );
}

/** An @name in a user's message: a link that opens the board of that name among the boards of the message's own server; a name
 *  that is no board's stays text. */
function Mention({ raw }: { raw: string }) {
  const t = useTokens();
  const where = useContext(WhereContext);
  const env = useMarkdownEnv();
  const boards = (env.useBoards ?? noBoards)(where.server ?? LOCAL_SERVER);
  const name = cleanName(raw.slice(1));
  const b = resolveName(name, boards)[0];
  if (!b) return raw;
  const rest = raw.slice(1).startsWith(name) ? raw.slice(1 + name.length) : "";
  return (
    <RNText>
      <RNText testID="md-mention" dataSet={{ board: b.id }} role="link" onPress={env.openBoard ? () => env.openBoard!(b.id) : undefined}
        style={{ color: t.accent, backgroundColor: alpha(t.accent, 0.16), fontWeight: "600" }}>@{b.name}</RNText>
      {rest}
    </RNText>
  );
}

/** A task list's box (a disabled checkbox on the page). */
function Check({ checked }: { checked: boolean }) {
  const t = useTokens();
  return (
    <View testID="md-check" role="checkbox" aria-checked={checked} aria-disabled
      style={[{ width: 12, height: 12, marginRight: 6, borderRadius: 3, borderWidth: 1.5, borderColor: checked ? t.accentFill : t.line2, backgroundColor: checked ? t.accentFill : t.bg, alignItems: "center", justifyContent: "center" },
        webStyle({ display: "inline-flex", verticalAlign: "-1px" })]}>
      {checked ? <View style={{ width: 3, height: 6, marginTop: -1, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderColor: t.onAccent, transform: [{ rotate: "45deg" }] }} /> : null}
    </View>
  );
}
