// Settings (package S1): the Settings screen, Appearance, Composer (editing), About, and the placeholders of the screens other packages build.
// `openSettings()` is what Home's gear calls. The bar of each place screen is drawn by the stack (screens/shell/phone/PushedRoute.tsx).
import { pushScreen, registerScreen } from "../shell/screens.ts";
import { About } from "./About.tsx";
import { APPEARANCE_SPEC } from "./Appearance.tsx";
import { EDITING_SPEC } from "./Editing.tsx";
import { registerPlaceholders } from "./placeholders.tsx";
import { Settings } from "./Settings.tsx";

registerScreen("settings", { kind: "place", title: () => "Settings", component: Settings });
registerScreen("appearance", APPEARANCE_SPEC);
registerScreen("editing", EDITING_SPEC);
registerScreen("about", { kind: "place", title: () => "About", component: About });
registerPlaceholders();

export { S1_TID } from "./ids.ts";
export { APPEARANCE_TID } from "./appearanceids.ts";
export { EDITING_TID } from "./editingids.ts";
export const openSettings = (): string => pushScreen("settings", {});
