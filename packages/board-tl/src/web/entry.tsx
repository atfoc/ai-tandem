// The new board's web target, `tl.js` (like board-view's `board.js`): `window.aiwbTlView.mount(element, options) → { unmount }`,
// an own React root in a box of the app's page (no iframe; decision U2). The options are in types.ts (design 6):
// - with `link`: the store is synced through it (view/sync.ts), with the person's presence, the agents' markers and the
//   connection line; without: a local store (the dev page, `build.mjs --dev-page`, an empty board driven through `window.__tlEditor`);
// - `onHandle(handle)` once the editor is ready (view/handle.ts), `onHandle(null)` at unmount;
// - the root element (`data-testid` = `testID`) takes the focus at mount (the spike's rule: the app decides when to mount).
import "tldraw/tldraw.css";
import "../view/board.css";
import "../view/sync.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "tldraw";
import { Board } from "../view/Board.tsx";
import { createViewHandle } from "../view/handle.ts";
import { Status } from "../view/Status.tsx";
import { TlSync, type TlUser } from "../view/sync.ts";
import type { LinkLike } from "../view/socket.ts";
import type { MountOptions, TlView } from "./types.ts";

export type { MountOptions, TlView, TlViewUser } from "./types.ts";

declare global {
  interface Window {
    aiwbTlView: TlView;
  }
}

function SyncedBoard({ link, user, onEditor }: { link: LinkLike; user: TlUser; onEditor(editor: Editor): void }) {
  const [sync] = useState(() => new TlSync({ link, user }));
  useEffect(() => () => sync.dispose(), [sync]);
  const s = useSyncExternalStore(sync.subscribe, sync.getSnapshot);
  return (
    <>
      {s.store.status !== "error" && <Board store={s.store} user={user} markers={sync.markers} onMount={onEditor} />}
      <Status sync={sync} />
    </>
  );
}

/** A generated person for a mount without one (D12 says the app passes it; the dev page does not). */
const anonymous = (): TlUser => ({ id: `u_${Math.random().toString(36).slice(2, 10)}`, name: "Guest", color: "#3b82f6" });

window.aiwbTlView = {
  mount(element, options = {}) {
    const root = createRoot(element);
    let live = true;
    const onEditor = (editor: Editor) => {
      if (!live) return;
      options.onHandle?.(createViewHandle(editor));
      options.onMount?.(editor);
    };
    const Root = () => {
      const [el, setEl] = useState<HTMLDivElement | null>(null);
      useEffect(() => void el?.focus({ preventScroll: true }), [el]);
      return (
        <div className="aiwb-tl-root" ref={setEl} tabIndex={-1} data-testid={options.testID} data-board={options.board}>
          {options.link ? (
            <SyncedBoard link={options.link} user={options.user ?? anonymous()} onEditor={onEditor} />
          ) : (
            <Board user={options.user} onMount={onEditor} />
          )}
        </div>
      );
    };
    root.render(<Root />);
    return {
      unmount() {
        if (!live) return;
        live = false;
        root.unmount();
        options.onHandle?.(null);
      },
    };
  },
};
