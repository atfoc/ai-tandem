// The new board: tldraw with our UI only (goal 3.3, 7.3). Every tldraw UI component is null and `hideUi` drops tldraw's
// UI layout; tldraw's keyboard shortcuts, clipboard and actions stay (they live in the UI context, not in the layout).
import { DefaultFontStyle, Tldraw, type Editor, type TLComponents, type TLUiComponents } from "tldraw";
import { ASSET_URLS } from "./assets.ts";
import { CAMERA, OPTIONS } from "./nav/options.ts";
import { MiroSelectTool } from "./nav/select.ts";
import { StickyShapeUtil } from "./sticky/StickyShapeUtil.tsx";
import { StickyTool } from "./sticky/StickyTool.ts";
import { ContextToolbar } from "./ui/ContextToolbar.tsx";
import { MainToolbar } from "./ui/MainToolbar.tsx";

const UI_NULL: Required<{ [K in keyof TLUiComponents]: null }> = {
  ContextMenu: null, ActionsMenu: null, HelpMenu: null, ZoomMenu: null, MainMenu: null, Minimap: null, StylePanel: null,
  PageMenu: null, NavigationPanel: null, Toolbar: null, RichTextToolbar: null, ImageToolbar: null, VideoToolbar: null,
  KeyboardShortcutsDialog: null, QuickActions: null, HelperButtons: null, DebugPanel: null, DebugMenu: null, MenuPanel: null,
  TopPanel: null, SharePanel: null, CursorChatBubble: null, Dialogs: null, Toasts: null, A11y: null, FollowingIndicator: null,
  PeopleMenu: null, PeopleMenuAvatar: null, PeopleMenuItem: null, PeopleMenuFacePile: null, UserPresenceEditor: null,
};

const COMPONENTS: TLComponents = { ...UI_NULL, InFrontOfTheCanvas: ContextToolbar };
const SHAPES = [StickyShapeUtil];
const TOOLS = [MiroSelectTool, StickyTool];

export function Board({ onMount }: { onMount?: (editor: Editor) => void }) {
  return (
    <Tldraw
      hideUi
      components={COMPONENTS}
      shapeUtils={SHAPES}
      tools={TOOLS}
      cameraOptions={CAMERA}
      options={OPTIONS}
      assetUrls={ASSET_URLS}
      onMount={(editor) => {
        // tldraw's UI only knows English messages built in (no fetch: connect-src 'none'); other locales would fetch JSON
        editor.user.updateUserPreferences({ locale: "en" });
        // every new element is in the sans font (tldraw's default is its hand-drawn "draw")
        editor.setStyleForNextShapes(DefaultFontStyle, "sans");
        onMount?.(editor);
      }}
    >
      <MainToolbar />
    </Tldraw>
  );
}
