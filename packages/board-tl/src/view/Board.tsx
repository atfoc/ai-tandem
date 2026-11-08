// The new board: tldraw with our UI only (goal 3.3, 7.3; lifted from the UI spike). Every tldraw UI component is null and
// `hideUi` drops tldraw's UI layout; tldraw's keyboard shortcuts, clipboard and actions stay (they live in the UI context, not
// in the layout). Our pieces are separate components (toolbars, context bar) and `installInteractions`.
//
// At mount: locale `en`, the next shapes' styles, focus, and editing only once the sans faces are loaded (the sticky's fit
// and tldraw's label measure must not measure a fallback font, spike-host 6.7); `onMount` is called then.
import { useState } from "react";
import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultFontFaces,
  DefaultFontStyle,
  Tldraw,
  atom,
  createTLCurrentUser,
  createTLStore,
  type Editor,
  type TLComponents,
  type TLStore,
  type TLStoreWithStatus,
  type TLUserPreferences,
  type TLUiComponents,
} from "tldraw";
import { tlSchema } from "../model/schema.ts";
import { CUSTOM_SHAPE_UTILS, StickyTool } from "../model/shapes/index.ts";
import { FillColorStyle } from "../model/styles.ts";
import { ASSET_URLS } from "./assets.ts";
import { AgentMarker } from "./AgentMarker.tsx";
import { ContextBar } from "./ContextBar.tsx";
import { installInteractions } from "./interactions.ts";
import { MainToolbar } from "./MainToolbar.tsx";
import { QuickAdd } from "./QuickAdd.tsx";
import { CAMERA, MiroSelectTool, OPTIONS } from "./navigation.ts";
import type { AgentMarkers, TlUser } from "./sync.ts";
import { Zoom } from "./Zoom.tsx";

const UI_NULL: Required<{ [K in keyof TLUiComponents]: null }> = {
  ContextMenu: null, ActionsMenu: null, HelpMenu: null, ZoomMenu: null, MainMenu: null, Minimap: null, StylePanel: null,
  PageMenu: null, NavigationPanel: null, Toolbar: null, RichTextToolbar: null, ImageToolbar: null, VideoToolbar: null,
  KeyboardShortcutsDialog: null, QuickActions: null, HelperButtons: null, DebugPanel: null, DebugMenu: null, MenuPanel: null,
  TopPanel: null, SharePanel: null, CursorChatBubble: null, Dialogs: null, Toasts: null, A11y: null, FollowingIndicator: null,
  PeopleMenu: null, PeopleMenuAvatar: null, PeopleMenuItem: null, PeopleMenuFacePile: null, UserPresenceEditor: null,
};

const COMPONENTS: TLComponents = { ...UI_NULL, InFrontOfTheCanvas: ContextBar };
const TOOLS = [MiroSelectTool, StickyTool];

/** Loads the faces of the sans font (our elements' font) before anything is measured. */
export async function fontsReady(editor: Editor) {
  const sans = DefaultFontFaces.tldraw_sans;
  await Promise.all([sans.normal.normal, sans.normal.bold, sans.italic.normal, sans.italic.bold].map((f) => editor.fonts.ensureFontIsLoaded(f)));
}

/** The styles of new elements: the sans font, solid lines, shapes filled white with a black border and black text. */
function setNextStyles(editor: Editor) {
  editor.setStyleForNextShapes(DefaultFontStyle, "sans");
  editor.setStyleForNextShapes(DefaultDashStyle, "solid");
  editor.setStyleForNextShapes(DefaultFillStyle, "fill");
  editor.setStyleForNextShapes(FillColorStyle, "white");
  editor.setStyleForNextShapes(DefaultColorStyle, "black");
}

export type BoardProps = {
  /** The board's store (a sync client's). Absent: a local store of the shared schema (the dev page). */
  store?: TLStore | TLStoreWithStatus;
  /** Called once the editor is mounted and the fonts are loaded (editing is allowed from then). */
  onMount?(editor: Editor): void;
  /** The person (D12): tldraw's user preferences, so the editor's user is them. Absent: tldraw's own (the dev page). */
  user?: TlUser;
  /** The agents' markers of the synced board (D11). */
  markers?: AgentMarkers;
};

export function Board({ store, onMount, user, markers }: BoardProps) {
  const [local] = useState(() => (store ? null : createTLStore({ schema: tlSchema })));
  const [currentUser] = useState(() => {
    if (!user) return undefined;
    const prefs = atom<TLUserPreferences>("aiwb user preferences", { id: user.id, name: user.name, color: user.color, locale: "en" });
    return createTLCurrentUser({ userPreferences: prefs, setUserPreferences: (p) => prefs.set(p) });
  });
  return (
    <Tldraw
      hideUi
      store={store ?? local!}
      user={currentUser}
      components={COMPONENTS}
      shapeUtils={CUSTOM_SHAPE_UTILS}
      tools={TOOLS}
      cameraOptions={CAMERA}
      options={OPTIONS}
      assetUrls={ASSET_URLS}
      onMount={(editor) => {
        // tldraw's UI only knows English messages built in (no fetch: connect-src 'none'); other locales would fetch JSON
        editor.user.updateUserPreferences({ locale: "en" });
        // Space-to-pan listens on tldraw's container (its hotkeys like Shift+1 on the document): editor.focus() sets tldraw's
        // flag only, so the container gets DOM focus too, or Space does nothing until a click. (In the app: focus when the
        // person opens the board, never while they type elsewhere.)
        editor.focus();
        editor.getContainer().focus();
        setNextStyles(editor);
        const uninstall = installInteractions(editor);
        // no editing until the sans faces are loaded
        const wasReadonly = editor.getIsReadonly();
        editor.updateInstanceState({ isReadonly: true });
        let live = true;
        void fontsReady(editor)
          .catch(() => {}) // a face that fails to load must not leave the board read-only
          .then(() => {
            if (!live) return;
            editor.updateInstanceState({ isReadonly: wasReadonly });
            onMount?.(editor);
          });
        return () => {
          live = false;
          uninstall();
        };
      }}
    >
      <MainToolbar />
      <QuickAdd />
      <Zoom />
      {markers && <AgentMarker markers={markers} />}
    </Tldraw>
  );
}
