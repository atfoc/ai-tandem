// What the Markdown of a chat's thread registers in the shell on the phone (package T1 of ux-improvements): the table viewer (a pushed
// screen, `table`) and the link sheet (an always-mounted overlay). The chat view imports this file (screens/chat/index.ts), so the
// gallery and the other places that draw Markdown alone register nothing.
import "./TableScreen.tsx";
import { setSlot } from "../shell/slots.tsx";
import { LinkSheet } from "./LinkSheet.tsx";

setSlot("Overlays", LinkSheet);
