// "Add to message" (ux-improvements goal 3.6, mockup "04 The + sheet" co-04a): the sheet "+" opens. Named 52-point rows with a sub-line: Take photo,
// Photo library, Files, Insert a prompt and, in a board chat only, under the board's name, Add selection and Point at (B2: both take the person to the board, which
// the chat waits on: the shapes are selected there, the spot is tapped there; the references come back as chips in the context row).
// No photo strip and no unlabelled icons. A row that cannot act now stays, faded, and says why.
//
// Close, then act. ActionSheet runs a row's `onPress` and closes the sheet in the same commit; a system picker (the camera, the library, Files) or
// another sheet (the prompt library's) opened at that moment would be presented over a Modal that is still going away: iOS cannot present over a
// dismissing modal and drops the picker, and "no sheet over a sheet" (goal 3.1.4) holds for the one that is closing too. So a row's action is not run
// inside `onPress` but after the sheet has closed: iOS waits DISMISS_MS (the system's modal dismissal is about 0.3 s: the same wait FormSheet gives
// before it closes a form over a closing confirm); Android's Modal is gone within a frame, so a short beat; the web has no dismissal to wait for, and
// runs the action on the next tick (a browser's file chooser still counts the press as its gesture then). The sheet has no `onDismiss` to wait on
// (`Sheet` draws a Modal with no exit animation), so a timer is what there is. Add selection and Point at go to the board (a navigation), so they wait too.
import type { ReactNode } from "react";
import { Platform } from "react-native";

import { IMAGES_PER_MESSAGE } from "@aiwb/core/logic/chatimage.ts";

import { ActionSheet, type ActionItem } from "../../../ui/ActionSheet.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { CameraIcon, FileIcon, PhotoIcon, PointIcon, PromptIcon, SelectionIcon } from "./icons.tsx";
import { PHONE_IDS } from "./ids.ts";

export type PlusSheetProps = {
  open: boolean;
  onClose(): void;
  /** The chat's board (a board chat), with its name: the board rows. undefined: no board rows. */
  board?: { id: string; name: string; archived?: boolean };
  /** How many elements are selected on the board right now (0: none): the note of Add selection. */
  selected: number;
  /** Why no image can be added now ("" while one can): the chat's server is not connected, the model takes none, the chat is gone. */
  imagesOff: string;
  /** The message holds as many images as one takes: Photo library, Take photo and Files wait until one is removed (goal 3.6). */
  imagesFull: string;
  /** Why no prompt can be inserted now ("" while one can). */
  insertOff: string;
  onCamera?: () => void;
  onLibrary?: () => void;
  onFiles?: () => void;
  onInsert(): void;
  onAddSelection(): void;
  onPoint(): void;
};

/** How long after the sheet closes a picker or another sheet may open (see the head of the file). */
const AFTER_CLOSE_MS = Platform.OS === "ios" ? 400 : Platform.OS === "web" ? 0 : 60;
const later = (run: () => void) => () => { setTimeout(run, AFTER_CLOSE_MS); };

export function PlusSheet({ open, onClose, board, selected, imagesOff, imagesFull, insertOff, onCamera, onLibrary, onFiles, onInsert, onAddSelection, onPoint }: PlusSheetProps): ReactNode {
  const t = useTokens();
  const icon = (I: typeof CameraIcon) => <I color={t.text} />;
  const images = imagesOff || imagesFull;
  const web = Platform.OS === "web";
  const items: ActionItem[] = [];
  if (onCamera) items.push({ id: "camera", label: "Take photo", note: "Use the camera", icon: icon(CameraIcon), waitReason: images || undefined, onPress: later(onCamera) });
  // The web build has one picker, the browser's file input (`onLibrary`): one row, named Files, and no Photo library row.
  if (onLibrary && !web) items.push({ id: "library", label: "Photo library", note: `Pick up to ${IMAGES_PER_MESSAGE} images`, icon: icon(PhotoIcon), waitReason: images || undefined, onPress: later(onLibrary) });
  const files = web ? onLibrary : onFiles;
  if (files) {
    const note = web ? "Images from this computer" : Platform.OS === "ios" ? "Images from Files or iCloud Drive" : "Images from your files";
    items.push({ id: "files", label: "Files", note, icon: icon(FileIcon), waitReason: images || undefined, onPress: later(files) });
  }
  items.push({ id: "prompt", label: "Insert a prompt", note: "From your prompt library", icon: icon(PromptIcon), waitReason: insertOff || undefined, onPress: later(onInsert) });
  if (board) {
    const section = `Board · ${board.name}`;
    const off = board.archived ? "The board is archived" : insertOff;
    const note = selected > 0 ? `${selected} ${selected === 1 ? "shape" : "shapes"} selected on the board` : "Select shapes on the board";
    items.push(
      { id: "selection", section, label: "Add selection", note, icon: icon(SelectionIcon), waitReason: off || undefined, onPress: later(onAddSelection) },
      { id: "point", section, label: "Point at", note: "Tap a spot on the board", icon: icon(PointIcon), waitReason: off || undefined, onPress: later(onPoint) },
    );
  }
  return <ActionSheet open={open} onClose={onClose} head={{ title: "Add to message" }} items={items} testID={PHONE_IDS.plusSheet} />;
}
