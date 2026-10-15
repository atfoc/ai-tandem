// The link port on web: an anchor that opens a new tab, with no opener (as the page's links do).
import type { LinkProps } from "./openlink.types.ts";

export type { LinkProps } from "./openlink.types.ts";

export const linkProps: LinkProps = (href) => ({ role: "link", href, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } });
