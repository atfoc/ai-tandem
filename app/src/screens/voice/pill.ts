// The board's voice (VC-28, V1): `BoardVoice` is the wide layouts' pill over the canvas, as ever, and the phone's voice card; the docked orb
// sits in the board screen's own slot (`BoardOrb`, the band's right end: B1's `board-orb-slot`).
import { setSlot } from "../shell/slots.tsx";
import { BoardVoice } from "./pill/BoardVoice.tsx";
import { DockedOrb } from "./pill/DockedOrb.tsx";

setSlot("BoardVoice", BoardVoice);
setSlot("BoardOrb", DockedOrb);
