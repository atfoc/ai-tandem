// The board screen (package B4): the canvas of an open board, in the shell's `Canvas` slot, and the engine view for work on a board
// that is not on screen. Imported by screens/register.ts.
import { boardApp } from "../shell/boardside.ts";
import { setSlot } from "../shell/slots.tsx";
import { BoardCanvas } from "./BoardCanvas.tsx";
import { engine } from "./engine.ts";
import { EngineHost } from "./EngineHost.tsx";

boardApp.setEngine(() => engine.channel());
setSlot("Canvas", BoardCanvas);
setSlot("Overlays", EngineHost);

export { finishPick, insertRef, pickPoint, registerInserter, addSelection, startPick, SELECT_FIRST } from "./refs.ts";
