// The sheets of the prompt library's phone screens, each drawn while sheets.ts says it is open (package S4). Mounted once, on the
// phone only, by LibraryPopups (the Overlays slot), so a sheet stays over whichever library screen opened it.
import { GroupForm } from "./GroupForm.tsx";
import { MovePicker } from "./MovePicker.tsx";
import { PromptEditor } from "./PromptEditor.tsx";
import { closeSheet, useLibSheets } from "./sheets.ts";

export function LibrarySheets() {
  const s = useLibSheets();
  return (
    <>
      {s.editor ? <PromptEditor open={s.editor} onClose={() => closeSheet("editor")} /> : null}
      {s.move ? <MovePicker open={s.move} onClose={() => closeSheet("move")} /> : null}
      {s.groupForm ? <GroupForm open={s.groupForm} onClose={() => closeSheet("groupForm")} /> : null}
    </>
  );
}
