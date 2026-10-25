// Home of the phone (package H1): its model, rows and lists are imported by the screens that draw them; this file is what the app's register
// (screens/register.ts) imports, and it holds the seam of the browser checks.
import "./seam.ts";

// ux-h2: the sheets any phone screen opens ("New" from Home and from a group on top of it, rename from Chat info and a board's title too), mounted once (h2-design.md H2-9); Settings ›
// Archived, which replaces S1's placeholder (it registers the `archived` screen at import, and wins whichever is imported first). Nothing
// here reads the store: it is read only after bootstrap has given it its storage (Home starts the search's "Recently opened", recent.ts).
import { setSlot } from "../shell/slots.tsx";
import "./Archived.tsx";
import { NewSheetHost } from "./NewSheet.tsx";
import { RenameHost } from "./RenameSheet.tsx";
import { RowSheetHost } from "./RowSheet.tsx";

setSlot("Overlays", NewSheetHost);
setSlot("Overlays", RenameHost);
setSlot("Overlays", RowSheetHost);
