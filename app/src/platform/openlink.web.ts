// The link port on web: an anchor that opens a new tab, with no opener (as the page's links do). openLater: a placeholder tab opened
// during the press (a browser blocks one opened after a network call), pointed at the address when it comes. In the desktop app the
// placeholder (about:blank) is refused by the window-open handler (desktop/lib.js linkAction 'drop'), window.open answers null, and the
// address goes through openLink to the default browser.
import type { LinkProps, OpenLater, OpenLink } from "./openlink.types.ts";

export type { LinkProps } from "./openlink.types.ts";

export const linkProps: LinkProps = (href) => ({ role: "link", href, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } });

export const openLink: OpenLink = (url) => { window.open(url, "_blank", "noopener,noreferrer"); };

const PLACEHOLDER = "Opening the Claude login…";

export const openLater: OpenLater = () => {
  let w: Window | null = null;
  try { w = window.open("", "_blank"); } catch { w = null; }
  if (w) {
    try { w.opener = null; } catch { /* (some browsers do not let it be set) */ }
    try { w.document.title = PLACEHOLDER; if (w.document.body) w.document.body.textContent = PLACEHOLDER; } catch { /* (an empty tab is fine too) */ }
  }
  const open = (url: string) => {
    const win = w;
    w = null; // (once)
    if (win && !win.closed) {
      try { win.location.href = url; return; } catch { /* (it went meanwhile: a tab of its own) */ }
    }
    openLink(url);
  };
  return Object.assign(open, {
    close() {
      const win = w;
      w = null;
      if (win && !win.closed) try { win.close(); } catch { /* (gone already) */ }
    },
  });
};
