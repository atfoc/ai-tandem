// The board's voice pill (VC-28): `BoardVoice`, registered here with `setSlot`. `BoardCanvas` draws the slot over a canvas board that is not archived.
import { setSlot } from "../shell/slots.tsx";
import { Pill } from "./pill/Pill.tsx";

setSlot("BoardVoice", Pill);
