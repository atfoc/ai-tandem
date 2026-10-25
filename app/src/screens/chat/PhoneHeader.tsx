// A chat's header on the phone (ux-improvements goal 3.5, 3.1.2): the kit's content bar, the one bar of the screen. The chevron alone, the
// agent's tile, the name in up to two lines and a sub-line of words (headline.ts) that a tap opens Chat info from, then the Tree and the ⋯ at
// the right, 44 pt each. Until Chat info is there (T3) the title and the ⋯ rename the chat in place, as the header did.
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { otherBranches, statusText } from "@aiwb/core/logic/labels.ts";
import { sendOff } from "@aiwb/core/logic/chatserver.ts";
import { serverName } from "@aiwb/core/logic/serverlists.ts";
import { headStatus } from "@aiwb/core/logic/status.ts";
import { openTree } from "@aiwb/core/state/actions.ts";
import { boardNames, branchCount, chatTitle, isLegacy, shownView, statesOfChat, threadOf, viewedBranch } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { ContentBar } from "../../ui/Bars.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { AgentGlyph, BranchIcon, MoreIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { BackButton } from "../shell/BackButton.tsx";
import { useWhere } from "./hooks.ts";
import { agentColours } from "./colour.ts";
import { NameInput } from "./Header.tsx";
import { useNow } from "../subagents/hooks.ts";
import { headline, treeLabel } from "./headline.ts";
import { openChatInfo, takeRename, useRenameRequest } from "./chatinfo.ts";
import { T1_TID } from "./ids.ts";

export function PhoneHeader({ chatId }: { chatId: string }) {
  const t = useTokens();
  const c = useStore((s) => shownView(s, chatId));
  const items = useStore((s) => threadOf(s, chatId)?.items);
  const boardName = useStore((s) => (c?.board ? s.boards[c.board]?.name : undefined));
  const server = serverOfKey(chatId);
  const serverLabel = useStore((s) => serverName(s, server));
  const where = useWhere(c);
  const gone = useStore((s) => !!s.gone[chatId]); // it is no longer on its server
  const [editing, setEditing] = useState(false);
  // Chat info's Rename asks for the name to be typed here (until the rename sheet takes its place)
  const asked = useRenameRequest();
  useEffect(() => { if (asked === chatId) { takeRename(); setEditing(true); } }, [asked, chatId]);
  const now = useNow(c?.status === "retrying"); // the time to the next attempt counts down
  if (!c) return null;
  // (a chat whose server is not connected, or no longer has it, is shown as it was: it has no status now, and is not renamed)
  const off = sendOff(where);
  const frozen = off || gone;
  const status = headStatus(c, isLegacy(c), statusText(c, boardNames(chatId), now), frozen);
  const named = !c.archived && !isLegacy(c) && !frozen;
  const a = agentColours(t, c.agent);
  const sub = headline({ chat: c, off, gone, server: serverLabel, boardName, legacy: isLegacy(c), now });
  // Chat info when it is there; else the title renames the chat, where it can be renamed
  const info = () => { if (!openChatInfo(chatId) && named) setEditing(true); };
  const wrap = tid("chat-head", { chat: chatId, status: status || undefined, frozen });
  if (editing && named) {
    return (
      <View {...wrap} style={[styles.edit, { borderBottomColor: t.line, backgroundColor: t.bg }]}>
        <BackButton />
        <View style={styles.field}><NameInput chat={c} phone onDone={() => setEditing(false)} /></View>
      </View>
    );
  }
  return (
    <View {...wrap}>
      <ContentBar back={<BackButton />} title={chatTitle(c, items)} titleMuted={!c.name} sub={sub.text} subTone={sub.tone} onTitlePress={info}
        titleTestID="chat-head-name" subTestID="chat-head-sub"
        leading={<View style={[styles.glyph, { backgroundColor: a.soft }]}><AgentGlyph agent={c.agent} size={14} /></View>}
        actions={(
          <>
            {(items?.length ?? 0) > 0 || branchCount(c) > 1 ? <TreeButton chatId={chatId} /> : null}
            <IconButton {...tid(T1_TID.chatMore)} size="touch" title="Chat info" onPress={info}>{(color) => <MoreIcon size={20} color={color} />}</IconButton>
          </>
        )} />
    </View>
  );
}

/** Tree, with the number of branches once the chat has split; the number is amber while another branch waits for approval or failed. */
function TreeButton({ chatId }: { chatId: string }) {
  const t = useTokens();
  const n = useStore((s) => branchCount(s.chats[chatId]));
  const viewed = useStore((s) => viewedBranch(s, chatId));
  const states = useStore((s) => statesOfChat(s, chatId));
  const o = useMemo(() => otherBranches(states, viewed), [states, viewed]);
  const alert = o.asks !== null || o.failed !== null;
  return (
    <IconButton {...tid(T1_TID.chatTree, { count: n > 1 ? n : undefined })} size="touch" title={treeLabel(n, o)} onPress={() => openTree(chatId)}>
      {(color) => (
        <>
          <BranchIcon size={20} color={color} />
          {n > 1 && (
            <View pointerEvents="none" style={[styles.badge, alert ? { backgroundColor: t.warnSoft, borderColor: t.warn } : { backgroundColor: t.accentSoft, borderColor: t.accentSoft }]}>
              <Text size={TYPE.secondary} weight="600" tone="accent" style={[styles.badgeText, alert && { color: t.warnText }]}>{n}</Text>
            </View>
          )}
        </>
      )}
    </IconButton>
  );
}

const styles = StyleSheet.create({
  glyph: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  // the bar of the kit while the name is typed: the back at its left, the field in the title's place
  edit: { minHeight: PHONE.target + 8, flexDirection: "row", alignItems: "center", paddingHorizontal: PHONE.margin / 2, borderBottomWidth: StyleSheet.hairlineWidth },
  field: { flex: 1, minWidth: 0, paddingLeft: 4, paddingRight: PHONE.margin / 2 },
  badge: { position: "absolute", top: 3, right: 0, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  badgeText: { lineHeight: 16 },
});
