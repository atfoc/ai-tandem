// The server's sheet of a chip's long press on Home (goal 3.2, mockup sh2-13a): the server's one body (ServerFacts, `place="sheet"`) in a
// sheet of the kit. H1's chip calls `openServerSheet(id)` (open.ts); `ServerSheetHost` is mounted once in the shell's Overlays (Hosts.tsx).
// `ServerSheet` is the sheet itself, for a screen that holds its own open state. Package S2.
import { useRef } from "react";

import { useStore } from "../../state/useStore.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { ServerFacts } from "./ServerFacts.tsx";
import { S2_TID } from "./ids.ts";
import { closeServerSheet, useServerSheet } from "./open.ts";

export function ServerSheet({ id, open, onClose }: { id: string; open: boolean; onClose(): void }) {
  const name = useStore((s) => s.servers.find((v) => v.id === id)?.name);
  return (
    <Sheet open={open} onClose={onClose} label={`${name ?? "Server"}, server`} testID={S2_TID.sheet} detent="fit">
      <ServerFacts id={id} place="sheet" onLeave={onClose} />
    </Sheet>
  );
}

export function ServerSheetHost() {
  const id = useServerSheet();
  const last = useRef<string | null>(null);
  if (id) last.current = id; // the sheet keeps its server while it closes, so that it does not empty mid-animation
  if (!last.current) return null;
  return <ServerSheet id={last.current} open={!!id} onClose={closeServerSheet} />;
}
