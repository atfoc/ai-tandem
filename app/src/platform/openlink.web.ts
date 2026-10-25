// The link port on web: an anchor that opens a new tab, with no opener (as the page's links do).
import type { LinkProps, OpenLink } from "./openlink.types.ts";

export type { LinkProps } from "./openlink.types.ts";

export const linkProps: LinkProps = (href) => ({ role: "link", href, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } });

export const openLink: OpenLink = (url) => { window.open(url, "_blank", "noopener,noreferrer"); };
