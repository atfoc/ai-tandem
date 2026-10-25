// The phone's sheets of a server, mounted once in the shell's `Overlays` slot (index.ts): the server's sheet, its edit form and the add
// flow. Drawn on the phone only; each shows itself when open.ts says it is open. Package S2.
import { usePhone } from "../../ui/useLayout.ts";
import { AddFlowHost } from "./AddFlow/AddFlow.tsx";
import { ServerEditHost } from "./ServerEdit.tsx";
import { ServerSheetHost } from "./ServerSheet.tsx";

export function PhoneServerHosts() {
  if (!usePhone()) return null;
  return (
    <>
      <ServerSheetHost />
      <ServerEditHost />
      <AddFlowHost />
    </>
  );
}
