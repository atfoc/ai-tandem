// The placeholder for a server's sheet (plans/ux-improvements/h1-design.md §2; testID `server-sheet-stopgap`) until package S2 gives its own through
// `setServerSheet`: a P1 sheet with the server's name and state word and one row, Server details. Home mounts it once.
import type { ServerView } from "@aiwb/core/logic/servers.ts";

import { ActionSheet } from "../../ui/ActionSheet.tsx";
import { useServerWord } from "../../ui/StateWord.tsx";
import { useStore } from "../../state/useStore.ts";
import { H1_TID } from "./ids.ts";
import { closeStopgapServerSheet, openServerDetail, useStopgapServerSheet } from "./serverseam.ts";

export function StopgapServerSheet() {
  const id = useStopgapServerSheet();
  const view = useStore((s) => s.servers.find((v) => v.id === id));
  if (id === null || !view) return null;
  return <Sheet id={id} view={view} />;
}

function Sheet({ id, view }: { id: string; view: ServerView }) {
  const word = useServerWord(view);
  return (
    <ActionSheet open onClose={closeStopgapServerSheet} testID={H1_TID.serverSheetStopgap} head={{ title: view.name, sub: word.text }}
      items={[{ id: "details", label: "Server details", onPress: () => openServerDetail(id) }]} />
  );
}
