// The link port on a device: a press opens the address in the system's browser (and openLater opens it when it comes: nothing blocks
// it, so nothing is readied).
import { Linking } from "react-native";

import type { LinkProps, OpenLater, OpenLink } from "./openlink.types.ts";

export type { LinkProps } from "./openlink.types.ts";

export const linkProps: LinkProps = (href) => ({ role: "link", onPress: () => { Linking.openURL(href).catch(() => { /* no app takes the address: nothing opens */ }); } });

export const openLink: OpenLink = (url) => { Linking.openURL(url).catch(() => { /* no app takes the address: nothing opens */ }); };

export const openLater: OpenLater = () => Object.assign((url: string) => openLink(url), { close() {} });
