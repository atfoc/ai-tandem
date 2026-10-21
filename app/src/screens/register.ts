// The screens of the app that register themselves in the shell's slots (screens/shell/slots.tsx): one import per area, added by
// the package that builds it (S1: `./sidebar`, S4: `./chat`, B4: `./board`, …). Imported once by App.tsx, before the first render.
import "./chat";
import "./images";
import "./board";
import "./servers";
import "./sidebar";
import "./fork";
import "./tools";
import "./composer";
import "./quotes";
import "./composerimages";
import "./subagents";
import "./library";
import "./voice";
