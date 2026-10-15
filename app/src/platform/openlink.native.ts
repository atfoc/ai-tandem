// The link port on a device: a press opens the address in the system's browser.
import { Linking } from "react-native";

import type { LinkProps } from "./openlink.types.ts";

export type { LinkProps } from "./openlink.types.ts";

export const linkProps: LinkProps = (href) => ({ role: "link", onPress: () => { Linking.openURL(href).catch(() => { /* no app takes the address: nothing opens */ }); } });
